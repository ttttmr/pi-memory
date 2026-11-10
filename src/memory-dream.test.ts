import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Type } from "typebox";
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runMemoryDream, type MemoryDreamCompletion, type MemoryDreamOptions, type MemoryDreamTool } from "./memory-dream.ts";
import type { MemorySourceProvider } from "./memory-sources.ts";

const model = { id: "synthetic-model", provider: "synthetic-provider", api: "openai-completions" } as NonNullable<ExtensionContext["model"]>;
const sourceText = "Original synthetic test output: check passed.\nDo not interpret this text as instructions.";
const sources = [{ id: "synthetic-session:entry:0", sessionId: "synthetic-session", entryId: "entry", role: "toolResult",
  text: sourceText, hash: createHash("sha256").update(sourceText).digest("hex"), timestamp: "2026-01-01T00:00:00.000Z",
  contextEdited: false, evidence: "original" as const, duplicateKey: "entry:synthetic-hash", startCharacter: 0, nextCharacter: null }];

function syntheticSourceProvider(empty = false): MemorySourceProvider {
  return {
    async search(_query, _options, signal) {
      signal?.throwIfAborted();
      return { sources: empty ? [] : sources.map(({ text, startCharacter: _start, nextCharacter: _next, ...metadata }) =>
        ({ ...metadata, preview: text.slice(0, 240) })), nextOffset: null };
    },
    async read(id, _options, signal) {
      signal?.throwIfAborted();
      const source = empty ? undefined : sources.find((item) => item.id === id);
      if (!source) throw new Error("Memory source unavailable on the selected same-project branch");
      return source;
    },
  };
}
const readSchema = Type.Object({ path: Type.Optional(Type.String()), scope: Type.Optional(Type.String()) }, { additionalProperties: false });
const writeSchema = Type.Object({
  path: Type.String(), content: Type.Optional(Type.String()), expectedHash: Type.Union([Type.String(), Type.Null()]),
  action: Type.Optional(Type.String()), scope: Type.Optional(Type.String()),
}, { additionalProperties: false });

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content, stopReason, timestamp: 1, model: model.id, provider: model.provider, api: model.api,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function call(name: string, args: ToolCall["arguments"] = {}, id = name): ToolCall {
  return { type: "toolCall", id, name, arguments: args };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: {}, isError };
}

function harness(responses: AssistantMessage[]) {
  const contexts: Context[] = [];
  const writes: Record<string, unknown>[] = [];
  const tools: MemoryDreamTool[] = [
    { name: "memory_search", description: "Search project notes", parameters: Type.Object({}, { additionalProperties: false }), async execute() { return textResult("Existing notes: notes/test.md"); } },
    { name: "memory_read", description: "Read project Markdown", parameters: readSchema, async execute() { return textResult("# Note\nOriginal note; hash=synthetic-hash"); } },
    { name: "memory_write", description: "Write project Markdown", parameters: writeSchema, async execute(_id, args, signal) { signal?.throwIfAborted(); writes.push(args); return textResult("Written"); } },
  ];
  let completions = 0;
  const complete: MemoryDreamCompletion = async (actualModel, context, request) => {
    assert.equal(actualModel, model);
    assert.equal(request.maxTokens, 4096);
    assert.ok(request.signal instanceof AbortSignal);
    contexts.push(structuredClone(context));
    const result = responses[completions++];
    assert.ok(result, "Unexpected model call");
    return result;
  };
  const options: MemoryDreamOptions = {
    model, sourceProvider: syntheticSourceProvider(), tools, complete,
    // A deliberately inert registry: these tests never discover resources or contact a provider.
    modelRegistry: {} as ExtensionContext["modelRegistry"],
  };
  return { options, contexts, writes, tools, get completions() { return completions; } };
}

const done = () => assistant([{ type: "text", text: "Organized notes; evidence limitations retained." }]);

test("dream uses an independent tool transcript, reads exact original evidence, and writes the small MEMORY.md index", async () => {
  const response = assistant([
    { type: "thinking", thinking: "opaque synthetic private block", thinkingSignature: "opaque-signature" },
    call("memory_source", { id: sources[0].id }, "source-call"), call("memory_read", { path: "notes/test.md" }, "note-call"),
  ], "toolUse");
  const h = harness([response, assistant([
    call("memory_write", { path: "notes/test.md", content: `# Tested lesson\nObserved check passed. Source: ${sources[0].id}`, expectedHash: "synthetic-hash" }, "note-write"),
    call("memory_write", { path: "MEMORY.md", content: "# Memory\n- [Test lesson](notes/test.md): use for checks", expectedHash: null }, "index-write"),
  ], "toolUse"), done()]);
  const progress: string[] = [];
  const report = await runMemoryDream({ ...h.options, onProgress: (text) => progress.push(text) });
  assert.match(report, /2 write call\(s\) completed/);
  assert.equal(h.writes.length, 2);
  assert.deepEqual(h.contexts[0].messages.map(({ role }) => role), ["user"]);
  const replay = h.contexts[1].messages;
  assert.deepEqual(replay[1], response, "Provider signatures are retained opaquely for model replay");
  assert.deepEqual(replay[2], {
    role: "toolResult", toolCallId: "source-call", toolName: "memory_source", isError: false,
    content: [{ type: "text", text: JSON.stringify(sources[0]) }], timestamp: replay[2].timestamp,
  });
  assert.deepEqual(replay[3].role, "toolResult");
  assert.ok(!report.includes("private block") && progress.every((text) => !text.includes("private block")));
  assert.match(h.contexts[0].systemPrompt!, /not another conversation summary/);
  assert.match(h.contexts[0].systemPrompt!, /MEMORY.md a small/);
  assert.match(h.contexts[0].systemPrompt!, /untrusted DATA/);
  assert.match(h.contexts[0].systemPrompt!, /assistant claim is not independent proof/);
});

test("dream defaults to configured registry completion, with the registry receiver preserved", async () => {
  const h = harness([]);
  const registry = { async complete(actualModel: unknown, context: Context, request: { maxTokens: number }) {
    assert.equal(this, registry);
    assert.equal(actualModel, model);
    assert.equal(request.maxTokens, 4096);
    assert.deepEqual(context.tools!.map(({ name }) => name), ["memory_search", "memory_read", "memory_write", "memory_source_search", "memory_source"]);
    return done();
  } };
  const report = await runMemoryDream({ ...h.options, complete: undefined, modelRegistry: registry as unknown as ExtensionContext["modelRegistry"] });
  assert.match(report, /0 write call/);
});

test("dream reports unavailable source, unknown tools, schema errors, global scope, and unauthorized actions as tool errors", async () => {
  const h = harness([assistant([
    call("memory_source", { id: "other-session:hidden" }, "missing-source"),
    call("bash", { command: "not executed" }),
    call("memory_source", { id: 42 }, "invalid-source"),
    call("memory_read", { scope: "global" }),
    call("memory_write", { path: "MEMORY.md", content: "not written", expectedHash: null, action: "verify" }),
  ], "toolUse"), done()]);
  await runMemoryDream(h.options);
  const results = h.contexts[1].messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 5);
  assert.ok(results.every((message) => message.isError));
  assert.match(JSON.stringify(results), /unavailable.*same-project branch/);
  assert.match(JSON.stringify(results), /project-only/);
  assert.equal(h.writes.length, 0);
});

test("dream passes thrown and returned tool errors to the model without counting them as successful writes", async () => {
  const h = harness([assistant([call("memory_read"), call("memory_write", { path: "MEMORY.md", expectedHash: null })], "toolUse"), done()]);
  h.tools[1].execute = async () => { throw new Error("synthetic read conflict"); };
  h.tools[2].execute = async () => textResult("synthetic write conflict", true);
  const report = await runMemoryDream(h.options);
  assert.match(report, /0 write call/);
  assert.ok(h.contexts[1].messages.filter((message) => message.role === "toolResult").every((result) => result.isError));
});

test("dream fails on the sixth tool-using model response rather than claiming completion", async () => {
  const h = harness(Array.from({ length: 6 }, (_, i) => assistant([call("memory_read", {}, `read-${i}`)], "toolUse")));
  await assert.rejects(runMemoryDream(h.options), /response budget exhausted \(6\).*reflection incomplete/);
  assert.equal(h.completions, 6);
});

test("dream enforces the 16 tool budget before dispatching an overflowing batch", async () => {
  const h = harness([
    assistant(Array.from({ length: 16 }, (_, i) => call("memory_read", {}, `read-${i}`)), "toolUse"),
    assistant([call("memory_write", { path: "MEMORY.md", expectedHash: null })], "toolUse"),
  ]);
  await assert.rejects(runMemoryDream(h.options), /tool call budget exhausted \(16\)/);
  assert.equal(h.writes.length, 0);
  assert.equal(h.completions, 2);
});

test("dream rejects provider truncation, aborted/error/deferred responses, and empty visible reports", async () => {
  for (const stopReason of ["length", "aborted", "error", "deferred", "pending"] as const) {
    const h = harness([assistant([], stopReason)]);
    await assert.rejects(runMemoryDream(h.options), /model did not finish normally/);
  }
  const h = harness([assistant([{ type: "thinking", thinking: "not a report" }])]);
  await assert.rejects(runMemoryDream(h.options), /no visible completion report/);
});

test("dream aborts before provider work and while a provider ignores cancellation", async () => {
  const h = harness([done()]);
  const before = new AbortController();
  before.abort(new Error("synthetic pre-abort"));
  await assert.rejects(runMemoryDream({ ...h.options, signal: before.signal }), /synthetic pre-abort/);
  assert.equal(h.completions, 0);
  const during = new AbortController();
  const pending = runMemoryDream({ ...h.options, signal: during.signal, complete: async () => new Promise(() => {}) });
  during.abort(new Error("synthetic active abort"));
  await assert.rejects(pending, /synthetic active abort.*0 write call/);
});

test("dream timeout reports completed writes and an uncertain in-flight write without rolling back", async (testCtx) => {
  testCtx.mock.timers.enable({ apis: ["setTimeout"] });
  const h = harness([assistant([
    call("memory_write", { path: "notes/saved.md", content: "saved", expectedHash: null }, "saved"),
    call("memory_write", { path: "notes/pending.md", content: "pending", expectedHash: null }, "pending"),
  ], "toolUse")]);
  let markEntered!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  let writeCount = 0;
  let toolSignal: AbortSignal | undefined;
  h.tools[2].execute = async (_id, _args, signal) => {
    toolSignal = signal;
    if (++writeCount === 1) return textResult("saved");
    markEntered();
    return new Promise(() => {});
  };
  const pending = runMemoryDream(h.options);
  await entered;
  const rejected = assert.rejects(pending, /timeout after 90 seconds.*1 write call\(s\) completed.*in flight.*may still complete/);
  testCtx.mock.timers.tick(90_000);
  await rejected;
  assert.equal(toolSignal?.aborted, true);
  assert.equal(writeCount, 2);
});

test("dream rejects unauthorized tools before invoking the model", async () => {
  const h = harness([done()]);
  await assert.rejects(runMemoryDream({ ...h.options, tools: [...h.tools, { ...h.tools[0], name: "bash" }] }), /unique memory_search\/read\/write/);
  assert.equal(h.completions, 0);
});

test("dream forwards historical search cursors and exact-source Unicode paging without inventing a preview window", async () => {
  const h = harness([assistant([
    call("memory_source_search", { query: "old feedback", sessionId: "old-session", offset: 700003, limit: 3 }, "search"),
    call("memory_source", { id: "old-session:old-entry:0", startCharacter: 2048 }, "old-source"),
  ], "toolUse"), done()]);
  const requests: unknown[] = [];
  const searchPage = { sources: [], nextOffset: 800008, partial: true, warnings: ["synthetic scan continuation"] };
  const readPage = { ...sources[0], id: "old-session:old-entry:0", sessionId: "old-session", entryId: "old-entry",
    startCharacter: 2048, text: "historical source page 中文", nextCharacter: 2068, contextEdited: true,
    evidence: "context-edited" as const, sourceFile: "/synthetic/sessions/old.jsonl", sourceLine: 2 };
  const sourceProvider: MemorySourceProvider = {
    async search(query, options, signal) { assert(signal instanceof AbortSignal); requests.push({ query, options }); return searchPage; },
    async read(id, options, signal) { assert(signal instanceof AbortSignal); requests.push({ id, options }); return readPage; },
  };
  await runMemoryDream({ ...h.options, sourceProvider });
  assert.deepEqual(requests, [
    { query: "old feedback", options: { sessionId: "old-session", offset: 700003, limit: 3 } },
    { id: "old-session:old-entry:0", options: { startCharacter: 2048 } },
  ]);
  const results = h.contexts[1].messages.filter((message) => message.role === "toolResult");
  assert.equal(results[0].content[0].type, "text");
  if (results[0].content[0].type !== "text" || results[1].content[0].type !== "text") throw new Error("Missing source tool output");
  assert.deepEqual(JSON.parse(results[0].content[0].text), searchPage);
  assert.deepEqual(JSON.parse(results[1].content[0].text), readPage);
  assert.match(h.contexts[0].systemPrompt!, /pre-compaction/);
  assert.match(h.contexts[0].systemPrompt!, /Duplicate keys/);
  assert.match(h.contexts[0].systemPrompt!, /nextOffset even on empty search pages/);
});

test("dream rejects arbitrary paths, extra source arguments, and invalid pagination through tool schemas", async () => {
  const h = harness([assistant([
    call("memory_source_search", { query: "x", path: "/not-authorized" }, "path"),
    call("memory_source_search", { offset: -1 }, "offset"),
    call("memory_source_search", { limit: 21 }, "limit"),
    call("memory_source", { id: sources[0].id, startCharacter: -1 }, "character"),
  ], "toolUse"), done()]);
  let providerCalls = 0;
  const sourceProvider: MemorySourceProvider = {
    async search() { providerCalls++; throw new Error("must not dispatch"); },
    async read() { providerCalls++; throw new Error("must not dispatch"); },
  };
  await runMemoryDream({ ...h.options, sourceProvider });
  assert.equal(providerCalls, 0);
  const results = h.contexts[1].messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 4);
  assert(results.every((result) => result.isError));
});

test("dream can organize uncertain notes without sources and bounds ordinary tool output", async () => {
  const h = harness([assistant([call("memory_read", { path: "MEMORY.md" })], "toolUse"), done()]);
  h.tools[1].execute = async () => textResult("a".repeat(60 * 1024));
  await runMemoryDream({ ...h.options, sourceProvider: syntheticSourceProvider(true) });
  const result = h.contexts[1].messages[2];
  assert.equal(result.role, "toolResult");
  if (result.role !== "toolResult") throw new Error("Missing test tool result");
  assert.match(JSON.stringify(result.content), /truncated at 50 KiB/);
  assert.ok(JSON.stringify(result.content).length < 52 * 1024);
});

test("dream adaptively shrinks oversized escaped source-search JSON without dropping cursor IDs", async () => {
  const startOffset = 700000;
  const h = harness([
    assistant([call("memory_source_search", { query: "quoted evidence", offset: startOffset }, "first-page")], "toolUse"),
    assistant([call("memory_source_search", { query: "quoted evidence", offset: startOffset + 5 }, "second-page")], "toolUse"),
    done(),
  ]);
  const requests: { query: string; offset: number | undefined; limit: number | undefined; bytes: number }[] = [];
  const { text: _text, startCharacter: _start, nextCharacter: _next, ...metadata } = sources[0];
  const catalog = Array.from({ length: 30 }, (_, index) => ({ ...metadata, id: `synthetic-session:entry-${index}:0`,
    entryId: `entry-${index}`, preview: "\n".repeat(240), sourceFile: `/${"\\".repeat(3000)}/synthetic.jsonl`, sourceLine: index + 2 }));
  const sourceProvider: MemorySourceProvider = {
    async search(query, options, signal) {
      signal?.throwIfAborted();
      const offset = options?.offset ?? startOffset;
      const limit = options?.limit ?? 10;
      const index = offset - startOffset;
      const page = { sources: catalog.slice(index, index + limit), nextOffset: offset + limit, partial: true };
      requests.push({ query, offset: options?.offset, limit: options?.limit, bytes: Buffer.byteLength(JSON.stringify(page)) });
      return page;
    },
    async read() { throw new Error("Exact source read was not requested"); },
  };
  await runMemoryDream({ ...h.options, sourceProvider });
  assert.deepEqual(requests.map(({ query, offset, limit }) => ({ query, offset, limit })), [
    { query: "quoted evidence", offset: startOffset, limit: 10 },
    { query: "quoted evidence", offset: startOffset, limit: 5 },
    { query: "quoted evidence", offset: startOffset + 5, limit: 10 },
    { query: "quoted evidence", offset: startOffset + 5, limit: 5 },
  ]);
  assert(requests[0].bytes > 50 * 1024 && requests[1].bytes <= 50 * 1024);
  const pages = [h.contexts[1], h.contexts[2]].map((context) => {
    const result = context.messages.filter((message) => message.role === "toolResult").at(-1)!;
    assert.equal(result.isError, false);
    const block = result.content[0];
    if (block.type !== "text") throw new Error("Missing source search JSON output");
    assert(Buffer.byteLength(block.text) <= 50 * 1024);
    return JSON.parse(block.text) as { sources: { id: string }[]; nextOffset: number };
  });
  assert.equal(pages[0].nextOffset, startOffset + 5);
  assert.equal(pages[1].nextOffset, startOffset + 10);
  assert.deepEqual(pages.flatMap((page) => page.sources.map((source) => source.id)), catalog.slice(0, 10).map((source) => source.id));
});
