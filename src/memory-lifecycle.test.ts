import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage, Context, ToolCall } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ContextEvent, type ExtensionAPI, type ExtensionContext,
  type ExtensionEvent, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import piMemoryExtension from "./memory-extension.ts";
import { runMemoryDream, type MemoryDreamCompletion } from "./memory-dream.ts";
import { readMemorySchedule } from "./memory-schedule.ts";
import type { MemorySourcePage, MemorySourceSearchPage } from "./memory-sources.ts";
import { createMemoryStoreHandle, listMemoryNotes, readMemoryNote } from "./memory-store.ts";

interface SyntheticReadPage {
  hash: string;
  content: string;
  offset: number;
  startCharacter: number;
  nextCharacter: number | null;
  hasMore: boolean;
}

interface SyntheticWriteReceipt {
  action: string;
  path: string;
  scope: string;
  hash: string;
  content?: never;
}

// This scripted provider tests integration/control flow, not a model's memory quality.
test("synthetic memory lifecycle corrects evidence, merges notes, repairs the index, and recalls Markdown in a fresh session", async (testCtx) => {
  const directory = await createMemoryTestDirectory(testCtx);
  const cwd = join(directory, "project");
  const config = join(directory, "isolated-agent-config");
  const root = join(directory, "isolated-memory");
  await mkdir(cwd);
  await mkdir(config);
  const previousMemory = process.env.PI_MEMORY_DIR;
  const previousConfig = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_MEMORY_DIR = root;
  process.env.PI_CODING_AGENT_DIR = config;
  testCtx.after(() => {
    if (previousMemory === undefined) delete process.env.PI_MEMORY_DIR;
    else process.env.PI_MEMORY_DIR = previousMemory;
    if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfig;
  });

  const model = { id: "synthetic-model", provider: "synthetic-provider", api: "openai-completions", maxTokens: 65536 } as NonNullable<ExtensionContext["model"]>;
  const originalNote = "# Synthetic cache failure\n\nHypothesis, not tested: retry mode caused the fixture failure.\n";
  const duplicateNote = "# Duplicate synthetic cache note\n\nTentative retry-mode hypothesis; merge with cache-failure.md when checked.\n";
  const oldIndex = "# Memory\n- [Cache investigation](notes/cache-failure.md)\n- [Duplicate investigation](notes/cache-duplicate.md)\n";
  const feedback = "Synthetic fixture feedback: retry mode OFF still fails; stale cache OFF passes. Only fixture v2 was checked.";
  const session = SessionManager.inMemory(cwd);
  assert.equal(session.getSessionFile(), undefined, "Synthetic evidence uses an in-memory session only");
  session.appendMessage({ role: "user", content: "Investigate the synthetic cache fixture failure and retain only reusable findings.", timestamp: 1 });
  session.appendMessage(assistant([
    { type: "text", text: "My tentative hypothesis is retry mode; the fixture feedback must decide." },
    { type: "thinking", thinking: "SYNTHETIC_PRIVATE_BLOCK_MUST_NOT_BE_EXTRACTED" },
  ]));
  const feedbackEntry = session.appendMessage({
    role: "toolResult", toolName: "synthetic_fixture_check", toolCallId: "synthetic-fixture-call",
    content: [{ type: "text", text: feedback }], isError: false, timestamp: 3,
  });
  const sourceId = `${session.getSessionId()}:${feedbackEntry}:0`;
  let completions = 0;
  let correctedContent = "";
  let correctedIndex = "";
  let checkedSource = false;

  const scriptedCompletion: MemoryDreamCompletion = async (actualModel, context, request) => {
    assert.equal(actualModel, model);
    assert.equal(request.maxTokens, 65536);
    request.signal.throwIfAborted();
    assert.ok(!JSON.stringify(context.messages[0]).includes("SYNTHETIC_PRIVATE_BLOCK"));
    switch (completions++) {
      case 0:
        assert.ok(!JSON.stringify(context.messages[0]).includes(sourceId), "Source IDs are discovered on demand, not preloaded");
        return assistant([
          toolCall("find-feedback", "memory_source_search", { query: "retry mode OFF" }),
          toolCall("read-retained", "memory_read", { path: "notes/cache-failure.md" }),
          toolCall("read-duplicate", "memory_read", { path: "notes/cache-duplicate.md" }),
          toolCall("read-index", "memory_read", { path: "MEMORY.md" }),
        ], "toolUse");
      case 1: {
        const found = toolResult<MemorySourceSearchPage>(context, "find-feedback");
        assert.equal(found.sources.length, 1);
        assert.equal(found.sources[0].id, sourceId);
        return assistant([toolCall("source-feedback", "memory_source", { id: found.sources[0].id })], "toolUse");
      }
      case 2: {
        const source = toolResult<MemorySourcePage>(context, "source-feedback");
        assert.equal(source.id, sourceId);
        assert.equal(source.role, "toolResult");
        assert.equal(source.text, feedback);
        assert.equal(source.evidence, "original");
        assert.equal(source.nextCharacter, null);
        checkedSource = true;
        const retained = toolResult<SyntheticReadPage>(context, "read-retained");
        const duplicate = toolResult<SyntheticReadPage>(context, "read-duplicate");
        const index = toolResult<SyntheticReadPage>(context, "read-index");
        for (const page of [retained, duplicate, index]) {
          assert.match(page.hash, /^[a-f0-9]{64}$/);
          assert.equal(page.offset, 1);
          assert.equal(page.startCharacter, 0);
          assert.equal(page.nextCharacter, null);
          assert.equal(page.hasMore, false, "Only complete read pages are rewritten");
        }
        assert.equal(retained.content, originalNote);
        assert.equal(duplicate.content, duplicateNote);
        assert.equal(index.content, oldIndex);
        correctedContent = `# Synthetic cache fixture lesson\n\nThe previous retry-mode hypothesis was contradicted by original fixture feedback.\n\nObserved: ${source.text}\n\nApplies only to synthetic fixture v2; this does not establish a universal cache rule.\nSource: ${source.id}\n\nMerged the duplicate investigation from notes/cache-duplicate.md; its untested claim is not independent evidence.\n`;
        correctedIndex = "# Memory\n- [Cache fixture lesson](notes/cache-failure.md): synthetic fixture v2 cache failures; includes evidence and limitations.\n";
        return assistant([
          toolCall("correct-retained", "memory_write", { path: "notes/cache-failure.md", content: correctedContent, expectedHash: retained.hash }),
          toolCall("repair-index", "memory_write", { path: "MEMORY.md", content: correctedIndex, expectedHash: index.hash }),
          toolCall("archive-duplicate", "memory_write", { action: "archive", path: "notes/cache-duplicate.md", expectedHash: duplicate.hash }),
        ], "toolUse");
      }
      case 3:
        for (const [id, action, path] of [
          ["correct-retained", "upsert", "notes/cache-failure.md"],
          ["repair-index", "upsert", "MEMORY.md"],
          ["archive-duplicate", "archive", "notes/cache-duplicate.md"],
        ]) {
          const receipt = toolResult<SyntheticWriteReceipt>(context, id);
          assert.equal(receipt.action, action);
          assert.equal(receipt.path, path);
          assert.equal(receipt.scope, "project");
          assert.match(receipt.hash, /^[a-f0-9]{64}$/);
          assert.equal(receipt.content, undefined, "Write receipts are metadata, not evidence bodies");
        }
        return assistant([{ type: "text", text: "Corrected the synthetic hypothesis against original feedback, merged the duplicate, repaired MEMORY.md links, and retained the fixture-only limitation." }]);
      default:
        throw new Error("Unexpected scripted completion; no network provider is available");
    }
  };

  function createRuntime(manager: SessionManager) {
    type Handler = (event: unknown, context: ExtensionContext) => unknown;
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, ToolDefinition>();
    let finishDream!: () => void;
    const finished = new Promise<void>((resolve) => { finishDream = resolve; });
    const notices: string[] = [];
    // Host registration/UI are synthetic; extension, session projection, tools, runner, and disk store are real.
    const ctx = {
      cwd, hasUI: true, mode: "print", model,
      modelRegistry: { complete() { throw new Error("Live provider invocation is forbidden in this synthetic test"); } },
      sessionManager: manager, isProjectTrusted: () => true,
      ui: { notify: (text: string) => notices.push(text), setStatus: (_key: string, status: string | undefined) => { if (!status) finishDream(); },
        confirm: () => { throw new Error("Synthetic autonomous maintenance must not need human approval"); } },
    } as unknown as ExtensionContext;
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand: () => {},
      registerFlag: () => {}, getFlag: () => false,
      on: (event: ExtensionEvent["type"], handler: Handler) => { handlers.set(event, handler); return () => {}; },
    } as unknown as ExtensionAPI;
    piMemoryExtension(pi, (options) => runMemoryDream({ ...options, complete: scriptedCompletion }));
    testCtx.after(async () => { await handlers.get("session_shutdown")?.({}, ctx); });
    return {
      notices, finished,
      async settled() {
        manager.appendMessage({ role: "user", content: "Unrelated synthetic completed interaction", timestamp: 4 });
        await handlers.get("agent_settled")!({}, ctx);
      },
      async start() { await handlers.get("session_start")!({}, ctx); },
      async write(path: string, content: string) {
        const tool = tools.get("memory_write")!;
        const args = { path, content, expectedHash: null };
        assert.ok(Value.Check(tool.parameters, args));
        return tool.execute("synthetic-seed", args, undefined, undefined, ctx as Parameters<typeof tool.execute>[4]);
      },
      async context(messages: ContextEvent["messages"]) {
        return await handlers.get("context")!({ type: "context", messages }, ctx) as { messages: ContextEvent["messages"] };
      },
    };
  }

  const runtime = createRuntime(session);
  await runtime.start();
  await runtime.write("notes/cache-failure.md", originalNote);
  await runtime.write("notes/cache-duplicate.md", duplicateNote);
  await runtime.write("MEMORY.md", oldIndex);
  for (let turn = 0; turn < 8; turn++) await runtime.settled();
  const entriesBeforeDream = session.getEntries();
  await runtime.finished;
  assert.equal(completions, 4);
  assert.equal(checkedSource, true);
  assert.match(runtime.notices.at(-1)!, /3 write call\(s\) completed/);
  assert.deepEqual(session.getEntries(), entriesBeforeDream, "Dream transcript never appends persistent foreground messages");

  const handle = createMemoryStoreHandle(root, cwd, "project");
  const retained = (await readMemoryNote(handle, "notes/cache-failure.md"))!;
  assert.equal(retained.content, correctedContent);
  assert.ok(retained.content.includes(sourceId));
  assert.match(retained.content, /hypothesis was contradicted/);
  assert.match(retained.content, /only to synthetic fixture v2/);
  assert.equal(await readMemoryNote(handle, "notes/cache-duplicate.md"), null);
  assert.deepEqual((await listMemoryNotes(handle)).map(({ path }) => path), ["MEMORY.md", "notes/cache-failure.md"]);
  const archivedDirectory = join(handle.directory, ".history", "notes/cache-duplicate.md");
  const snapshots = await readdir(archivedDirectory);
  assert.equal(snapshots.length, 1);
  assert.equal(await readFile(join(archivedDirectory, snapshots[0]), "utf8"), duplicateNote, "Archiving preserves original Markdown evidence bytes");
  const index = (await readMemoryNote(handle, "MEMORY.md"))!;
  assert.equal(index.content, correctedIndex);
  assert.match(index.content, /\]\(notes\/cache-failure.md\)/);
  assert.doesNotMatch(index.content, /cache-duplicate/);

  const foreground: ContextEvent["messages"] = [{ role: "user", content: "An unrelated foreground question", timestamp: 4 }];
  const recalled = await runtime.context(foreground);
  assert.equal(foreground.length, 1, "Recall does not mutate the input message array");
  assert.equal(recalled.messages.length, 2);
  assert.equal(recalled.messages[0].role, "custom");
  assert.ok(JSON.stringify(recalled.messages[0]).includes("notes/cache-failure.md"));
  assert.ok(!JSON.stringify(recalled.messages[0]).includes(feedback), "Only the small index is injected, not the note body");
  assert.equal((await runtime.context(recalled.messages)).messages.length, 2, "Ephemeral index never accumulates");
  assert.deepEqual(session.getEntries(), entriesBeforeDream);

  const nextSession = SessionManager.inMemory(cwd);
  assert.notEqual(nextSession.getSessionId(), session.getSessionId());
  nextSession.appendMessage({ role: "user", content: "Start fresh with an unrelated task", timestamp: 5 });
  const nextRuntime = createRuntime(nextSession);
  await nextRuntime.start();
  const freshMessages = nextSession.buildSessionProjection().messages;
  const freshRecall = await nextRuntime.context(freshMessages);
  assert.equal(freshMessages.length, 1);
  assert.equal(freshRecall.messages.length, 2);
  assert.ok(JSON.stringify(freshRecall.messages[0]).includes("notes/cache-failure.md"), "A new session reads the same persisted Markdown index");
  assert.ok(!JSON.stringify(freshRecall.messages).includes("cache-duplicate"));
  assert.equal(completions, 4, "Fresh-session recall makes no extra model call");
  assert.deepEqual(await readdir(config), [], "No credentials, settings, or session files were created");

  function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
    return { role: "assistant", content, stopReason, timestamp: 2, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
  function toolCall(id: string, name: string, args: ToolCall["arguments"]): ToolCall {
    return { type: "toolCall", id, name, arguments: args };
  }
  function toolResult<T extends object>(context: Context, id: string): T {
    const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
    assert.ok(result && result.role === "toolResult", `Missing synthetic tool result: ${id}`);
    assert.equal(result.isError, false, `Synthetic tool failed: ${id}`);
    return JSON.parse(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")) as T;
  }
});

// No foreground memory writes: completed interactions alone create durable pending work.
test("two short sessions automatically create first project notes from historical native evidence without rewriting sessions", { timeout: 15_000 }, async (testCtx) => {
  const directory = await createMemoryTestDirectory(testCtx);
  const cwd = join(directory, "project");
  const config = join(directory, "isolated-agent-config");
  const root = join(directory, "isolated-memory");
  const sessions = join(config, "sessions", "synthetic-project");
  await mkdir(cwd);
  await mkdir(sessions, { recursive: true });
  const previousMemory = process.env.PI_MEMORY_DIR;
  const previousConfig = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_MEMORY_DIR = root;
  process.env.PI_CODING_AGENT_DIR = config;
  testCtx.after(() => {
    if (previousMemory === undefined) delete process.env.PI_MEMORY_DIR;
    else process.env.PI_MEMORY_DIR = previousMemory;
    if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousConfig;
  });

  const model = { id: "synthetic-model", provider: "synthetic-provider", api: "openai-completions", maxTokens: 65536 } as NonNullable<ExtensionContext["model"]>;
  const feedback = "Historical synthetic fixture feedback: stale cache OFF passes; retry mode OFF still fails. Checked fixture v2 only.";
  const first = SessionManager.inMemory(cwd);
  const second = SessionManager.inMemory(cwd);
  const handle = createMemoryStoreHandle(root, cwd, "project");
  let sourceId = "";
  let completions = 0;
  let runs = 0;
  let checkedHistoricalSource = false;
  const note = "# Fixture cache lesson\n\nHistorical fixture v2 feedback, not a universal claim: stale cache OFF passes while retry mode OFF still fails.\n";
  const index = "# Memory\n- [Fixture cache lesson](notes/cache.md): when investigating the synthetic fixture v2 cache failure.\n";
  let finishDream!: () => void;
  let failDream!: (error: Error) => void;
  const finished = new Promise<void>((resolve, reject) => { finishDream = resolve; failDream = reject; });
  const notices: string[] = [];

  const scriptedCompletion: MemoryDreamCompletion = async (actualModel, context, request) => {
    assert.equal(actualModel, model);
    request.signal.throwIfAborted();
    assert.equal(request.maxTokens, 65536);
    switch (completions++) {
      case 0:
        assert.ok(!JSON.stringify(context.messages[0]).includes(sourceId));
        assert.ok(!JSON.stringify(context.messages[0]).includes(feedback));
        return assistant([toolCall("historical-search", "memory_source_search", { query: "stale cache OFF passes", limit: 20 }),
          toolCall("existing-notes", "memory_search", { query: "cache" })], "toolUse");
      case 1: {
        const search = toolResult<MemorySourceSearchPage>(context, "historical-search");
        assert.equal(search.sources.length, 1);
        assert.equal(search.sources[0].sessionId, first.getSessionId());
        assert.equal(search.sources[0].id, sourceId);
        assert.equal(search.sources[0].evidence, "original");
        return assistant([toolCall("historical-source", "memory_source", { id: search.sources[0].id })], "toolUse");
      }
      case 2: {
        const source = toolResult<MemorySourcePage>(context, "historical-source");
        assert.equal(source.id, sourceId);
        assert.equal(source.text, feedback);
        assert.equal(source.role, "toolResult");
        assert.equal(source.contextEdited, false);
        assert.equal(source.evidence, "original");
        assert.equal(source.nextCharacter, null);
        assert.match(source.hash, /^[a-f0-9]{64}$/);
        checkedHistoricalSource = true;
        return assistant([
          toolCall("first-note", "memory_write", { path: "notes/cache.md", content: `${note}\nSource: ${source.id}\n`, expectedHash: null }),
          toolCall("first-index", "memory_write", { path: "MEMORY.md", content: index, expectedHash: null }),
        ], "toolUse");
      }
      case 3:
        for (const id of ["first-note", "first-index"]) {
          const receipt = toolResult<SyntheticWriteReceipt>(context, id);
          assert.equal(receipt.action, "upsert");
          assert.equal(receipt.scope, "project");
          assert.match(receipt.hash, /^[a-f0-9]{64}$/);
          assert.equal(receipt.content, undefined);
        }
        return assistant([{ type: "text", text: "Created the first project note and small index from inspected original fixture feedback; fixture v2 applicability remains explicit." }]);
      default:
        throw new Error("Unexpected synthetic completion; live model access is forbidden");
    }
  };

  function createRuntime(manager: SessionManager) {
    type Handler = (event: unknown, context: ExtensionContext) => unknown;
    const handlers = new Map<string, Handler>();
    const ctx = {
      cwd, hasUI: true, mode: "print", model, sessionManager: manager, isProjectTrusted: () => true,
      modelRegistry: { complete() { throw new Error("Live provider invocation is forbidden"); } },
      ui: {
        setStatus(_key: string, text: string | undefined) {
          if (text === undefined && notices.some((notice) => notice.startsWith("Memory updated:"))) finishDream();
        },
        confirm: () => { throw new Error("Synthetic background work must not request approval"); },
        notify(text: string) {
          notices.push(text);
          if (text.startsWith("Memory dreaming stopped:")) failDream(new Error(text));
        },
      },
    } as unknown as ExtensionContext;
    const pi = {
      registerTool: () => {}, registerCommand: () => {}, registerFlag: () => {}, getFlag: () => false,
      on: (event: ExtensionEvent["type"], handler: Handler) => { handlers.set(event, handler); return () => {}; },
    } as unknown as ExtensionAPI;
    piMemoryExtension(pi, (options) => {
      runs++;
      return runMemoryDream({ ...options, complete: scriptedCompletion });
    });
    const dispatch = async (event: string) => { await handlers.get(event)!({}, ctx); };
    testCtx.after(() => dispatch("session_shutdown"));
    return { dispatch };
  }

  const firstRuntime = createRuntime(first);
  await firstRuntime.dispatch("session_start");
  for (let turn = 0; turn < 4; turn++) {
    first.appendMessage({ role: "user", content: `Synthetic first-session task ${turn}`, timestamp: turn + 1 });
    if (turn === 0) {
      const feedbackEntry = first.appendMessage({ role: "toolResult", toolName: "synthetic_fixture_check", toolCallId: "historical-fixture",
        content: [{ type: "text", text: feedback }], isError: false, timestamp: 2 });
      sourceId = `${first.getSessionId()}:${feedbackEntry}:0`;
    }
    first.appendMessage(assistant([{ type: "text", text: `Synthetic first-session task ${turn} completed` }]));
    await firstRuntime.dispatch("agent_settled");
  }
  assert.equal((await readMemorySchedule(handle)).pendingTurns, 4);
  assert.equal(runs, 0);
  assert.deepEqual(await listMemoryNotes(handle), []);
  await firstRuntime.dispatch("session_shutdown");

  // A native Pi JSONL fixture is historical evidence, not a copied memory index or synthetic model result.
  const historicalPath = join(sessions, "historical.jsonl");
  const historicalBytes = [first.getHeader(), ...first.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(historicalPath, historicalBytes);
  const firstEntries = first.getEntries();
  const secondRuntime = createRuntime(second);
  await secondRuntime.dispatch("session_start");
  assert.equal((await readMemorySchedule(handle)).pendingTurns, 4, "A fresh extension instance restores pending work");
  for (let turn = 0; turn < 4; turn++) {
    second.appendMessage({ role: "user", content: `Unrelated second-session task ${turn}`, timestamp: turn + 10 });
    second.appendMessage(assistant([{ type: "text", text: `Unrelated second-session task ${turn} completed` }]));
    await secondRuntime.dispatch("agent_settled");
    if (turn < 3) {
      assert.equal(runs, 0);
      assert.deepEqual(await listMemoryNotes(handle), []);
    }
  }
  const secondEntries = second.getEntries();
  await finished;
  assert.equal(runs, 1);
  assert.equal(completions, 4);
  assert.equal(checkedHistoricalSource, true);
  assert.match(notices.at(-1)!, /2 write call\(s\) completed/);
  assert.deepEqual(await readMemorySchedule(handle), { observedTurns: 8, processedTurns: 8, pendingTurns: 0, due: false });
  assert.equal((await readMemoryNote(handle, "notes/cache.md"))?.content, `${note}\nSource: ${sourceId}\n`);
  assert.equal((await readMemoryNote(handle, "MEMORY.md"))?.content, index);
  assert.deepEqual((await listMemoryNotes(handle)).map(({ path }) => path), ["MEMORY.md", "notes/cache.md"]);
  assert.equal(await readFile(historicalPath, "utf8"), historicalBytes, "Historical native JSONL bytes are never rewritten");
  assert.deepEqual(first.getEntries(), firstEntries);
  assert.deepEqual(second.getEntries(), secondEntries, "Dreaming does not append messages to the foreground session");
  assert.deepEqual(await readdir(config), ["sessions"], "No host credentials or settings are touched");
  assert.deepEqual(await readdir(sessions), ["historical.jsonl"]);

  function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
    return { role: "assistant", content, stopReason, timestamp: 2, api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
  function toolCall(id: string, name: string, args: ToolCall["arguments"]): ToolCall {
    return { type: "toolCall", id, name, arguments: args };
  }
  function toolResult<T extends object>(context: Context, id: string): T {
    const result = context.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
    assert.ok(result && result.role === "toolResult", `Missing synthetic tool result: ${id}`);
    assert.equal(result.isError, false, `Synthetic tool failed: ${id}`);
    return JSON.parse(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n")) as T;
  }
});
