import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { FSWatcher, watch } from "node:fs";
import { mkdir, readFile, readdir, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  ContextEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext, ExtensionEvent, ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createMemoryTestDirectory, memoryTestContent } from "../test/memory-fixtures.ts";
import piMemoryExtension from "./memory-extension.ts";
import type { runMemoryDream } from "./memory-dream.ts";
import { createMemoryObservationQueue, type MemoryObservationQueue } from "./memory-observations.ts";
import { readMemorySchedule } from "./memory-schedule.ts";
import { createMemoryStoreHandle, listMemoryNotes, readMemoryNote } from "./memory-store.ts";

type MockHandler = (event: unknown, ctx: ExtensionContext) => unknown;

async function createExtensionHarness(
  testCtx: TestContext, dream?: typeof runMemoryDream, flags: string[] = [],
  existing?: { cwd: string; root: string }, observationQueueFactory = createMemoryObservationQueue,
  registerExtension = piMemoryExtension,
) {
  const directory = await createMemoryTestDirectory(testCtx);
  const cwd = existing?.cwd ?? join(directory, "project");
  if (!existing) await mkdir(cwd);
  const root = existing?.root ?? join(directory, "memory");
  const previousRoot = process.env.PI_MEMORY_DIR;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(directory, "isolated-agent");
  process.env.PI_MEMORY_DIR = root;
  testCtx.after(() => {
    if (previousRoot === undefined) delete process.env.PI_MEMORY_DIR;
    else process.env.PI_MEMORY_DIR = previousRoot;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const handlers = new Map<string, MockHandler>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const notices: string[] = [];
  const requests: { content: string; options: { deliverAs?: string; expandPromptTemplates?: boolean } }[] = [];
  let trusted = true;
  let sessionId = "synthetic-session";
  let leafNumber = 0;
  let dreamFinished: (() => void) | undefined;
  const ctx = {
    cwd, hasUI: true, mode: "print", isProjectTrusted: () => trusted,
    model: { id: "synthetic-model", maxTokens: 65536 }, modelRegistry: {},
    sessionManager: {
      getSessionId: () => sessionId, getLeafId: () => `synthetic-entry-${leafNumber}`,
      getCwd: () => cwd, getSessionDir: () => join(directory, "isolated-sessions"),
      getEntries: () => [], getBranch: () => [],
    },
    ui: { notify: (message: string) => notices.push(message), setStatus: (_key: string, value: string | undefined) => { if (!value) dreamFinished?.(); },
      confirm: () => { throw new Error("No mandatory human approval is allowed"); } },
  } as unknown as ExtensionContext;
  const pi = {
    registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command.handler),
    registerFlag: () => {}, getFlag: (name: string) => flags.includes(name),
    sendUserMessage: (content: string, options: { deliverAs?: string; expandPromptTemplates?: boolean }) => requests.push({ content, options }),
    on: (event: ExtensionEvent["type"], handler: MockHandler) => { handlers.set(event, handler); return () => {}; },
  } as unknown as ExtensionAPI;
  registerExtension(pi, dream, observationQueueFactory);
  await handlers.get("session_start")?.({}, ctx);
  testCtx.after(async () => { await handlers.get("session_shutdown")?.({}, ctx); });
  const handle = createMemoryStoreHandle(root, cwd, "project");
  return {
    directory, root, cwd, ctx, tools, handlers, notices, handle, commands, requests,
    setTrust: (value: boolean) => { trusted = value; },
    setSession: (value: string) => { sessionId = value; leafNumber = 0; },
    setLeaf: (value: number) => { leafNumber = value; },
    waitForDream: () => new Promise<void>((resolve) => { dreamFinished = resolve; }),
    async call(name: string, params: Record<string, unknown>) {
      const tool = tools.get(name)!;
      assert.ok(Value.Check(tool.parameters, params), `Tool arguments valid: ${name}`);
      return tool.execute("synthetic-call", params, undefined, undefined, ctx as Parameters<typeof tool.execute>[4]);
    },
    async command(args: string) { await commands.get("memory")!(args, ctx as ExtensionCommandContext); },
    async context(messages: ContextEvent["messages"]) {
      return await handlers.get("context")!({ type: "context", messages }, ctx) as { messages: ContextEvent["messages"] };
    },
    async event(name: string, newTurn = true, payload: Record<string, unknown> = {}) {
      if (name === "agent_settled" && newTurn) leafNumber++;
      await handlers.get(name)?.(payload, ctx);
    },
  };
}

function dreamBarrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function resultValue(result: Awaited<ReturnType<ToolDefinition["execute"]>>) {
  return JSON.parse(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"));
}

test("memory is the only command; empty input shows usage without a request or library creation", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  assert.deepEqual([...h.commands.keys()], ["memory"]);
  await h.command("");
  await h.command(" \n\t ");
  assert.deepEqual(h.requests, []);
  assert.equal(h.notices.length, 2);
  assert.ok(h.notices.every((notice) => notice === "Usage: /memory <what to remember>"));
  assert.deepEqual(await readdir(h.directory), ["project"]);
});

test("memory submits verbatim content as an explicit cross-session request, never command actions or writes", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  for (const content of ["Prefer concise replies.", "paths", "dream", "off", "recall off", "global list", "/memory nested", "  记住这句话\n保持原话。  "]) {
    await h.command(content);
    const request = h.requests.at(-1)!;
    assert.equal(request.content, `Remember this for future turns and sessions using the memory tools:\n\n${content}`);
    assert.deepEqual(request.options, { deliverAs: "followUp", expandPromptTemplates: false });
  }
  assert.equal(h.notices.length, 0, "The handler must not claim the model already saved the request");
  assert.deepEqual(await readdir(h.directory), ["project"], "Only the foreground model chooses files and index organization");
});

test("foreground memory guidance states purpose and leaves note selection and organization to the model", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  const writer = h.tools.get("memory_write")!;
  assert.deepEqual(writer.promptGuidelines, [
    "Memory retains knowledge for future turns and sessions. Write notes when the user asks or something is clearly worth remembering; decide what to retain and how to organize it.",
  ]);
  assert.equal(writer.promptSnippet, "Retain useful knowledge across turns and sessions");
  assert.match(writer.description, /expectedHash:null creates only/);
  assert.match(writer.description, /MEMORY.md is a small linked entry point/);
  assert.match(h.tools.get("memory_read")!.description, /nextCharacter/);
  assert.match(h.tools.get("memory_search")!.description, /keywords/);
  const note = "Prefer shorter answers.";
  await h.call("memory_write", { path: "preferences.md", content: note, expectedHash: null });
  assert.equal((await readMemoryNote(h.handle, "preferences.md"))!.content, note,
    "Notes need no prescribed sections, source fields, dates, or verification labels");
});

test("autonomous Markdown writes, edits, links and archive work without human review", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  assert.deepEqual([...h.tools.keys()], ["memory_search", "memory_read", "memory_write"]);
  const missing = resultValue(await h.call("memory_read", {}));
  assert.equal(missing.exists, false);
  assert.deepEqual(await readdir(h.directory), ["project"]);
  const saved = resultValue(await h.call("memory_write", { path: "topics/testing.md", content: memoryTestContent, expectedHash: null }));
  assert.equal(saved.action, "upsert");
  const index = "# Memory\n- [Testing](topics/testing.md): observed synthetic fixture, not universal advice\n";
  await h.call("memory_write", { path: "MEMORY.md", content: index, expectedHash: null });
  const messages: ContextEvent["messages"] = [{ role: "user", content: "Completely unrelated latest question", timestamp: 1 }];
  const recalled = await h.context(messages);
  assert.equal(recalled.messages.length, 2, "Small map is available regardless of keyword query");
  assert.equal(messages.length, 1);
  assert.equal((await h.context(recalled.messages)).messages.length, 2, "Recall never accumulates");
  const recall = JSON.stringify(recalled.messages[0]);
  assert.match(recall, /topics\/testing.md/);
  assert.ok(!recall.includes(memoryTestContent), "Full note stays outside injected context");
  const read = resultValue(await h.call("memory_read", { path: "topics/testing.md", offset: 1, limit: 1 }));
  assert.equal(read.hash, saved.hash);
  assert.equal(read.hasMore, true);
  await h.call("memory_write", { path: "topics/testing.md", content: "# Corrected hypothesis\nSource fixture does not prove a universal rule.", expectedHash: saved.hash });
  await assert.rejects(h.call("memory_write", { path: "topics/testing.md", content: "stale", expectedHash: saved.hash }), /hash conflict/);
  const current = (await readMemoryNote(h.handle, "topics/testing.md"))!;
  await h.call("memory_write", { action: "archive", path: current.path, expectedHash: current.hash });
  assert.equal(await readMemoryNote(h.handle, current.path), null);
  assert.equal((await listMemoryNotes(h.handle)).length, 1);
  assert.ok((await readdir(join(h.handle.directory, ".history", current.path))).length >= 2);
  await assert.rejects(h.call("memory_write", { action: "archive", path: "MEMORY.md", expectedHash: (await readMemoryNote(h.handle, "MEMORY.md"))!.hash }), /cannot be archived/);
});

test("global writes are autonomous and isolated; project access still requires trust", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  await h.call("memory_write", { scope: "global", path: "MEMORY.md", content: "# Shared nonprivate preference", expectedHash: null });
  assert.equal((await listMemoryNotes(h.handle)).length, 0);
  assert.match(JSON.stringify((await h.context([{ role: "user", content: "hello", timestamp: 1 }])).messages), /global-memory-index/);
  h.setTrust(false);
  assert.equal((await h.context([{ role: "user", content: "hello", timestamp: 1 }])).messages.length, 1);
  await assert.rejects(h.call("memory_write", { path: "notes.md", content: "not trusted", expectedHash: null }), /project trust/);
  assert.match(JSON.stringify(await h.call("memory_search", { scope: "global" })), /Shared nonprivate/);
});

test("recall startup flag resets per session and corrupt index does not abort foreground context", async (testCtx) => {
  const flags = ["pi-memory-no-recall"];
  const h = await createExtensionHarness(testCtx, undefined, flags);
  await h.call("memory_write", { path: "MEMORY.md", content: "# Index", expectedHash: null });
  const messages: ContextEvent["messages"] = [{ role: "user", content: "hello", timestamp: 1 }];
  assert.equal((await h.context(messages)).messages.length, 1);
  flags.pop();
  await h.event("session_start");
  assert.equal((await h.context(messages)).messages.length, 2);
  await writeFile(join(h.handle.directory, "MEMORY.md"), "x".repeat(9000));
  assert.equal((await h.context(messages)).messages.length, 1);
  assert.match(h.notices.at(-1)!, /Memory index unavailable/);
  assert.equal(h.handlers.has("session_before_compact"), false);
});

test("same-process parallel tool writes use Pi queue without losing files", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  await Promise.all(Array.from({ length: 8 }, (_, index) => h.call("memory_write", { path: `notes/${index}.md`, content: `# Finding ${index}`, expectedHash: null })));
  assert.equal((await listMemoryNotes(h.handle)).length, 8);
});

test("dreaming uses independent project-only tools after 8 settled runs, and quit cancels it", async (testCtx) => {
  let runs = 0;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const h = await createExtensionHarness(testCtx, async (options) => {
    runs++;
    await assert.rejects(options.tools[0].execute("synthetic-global", { scope: "global" }, undefined, undefined), /project-scoped/);
    started();
    await new Promise<void>((_resolve, reject) => { options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }); });
    return "unreachable";
  });
  assert.equal((await listMemoryNotes(h.handle)).length, 0, "No foreground note is needed for the first dream");
  for (let index = 0; index < 8; index++) await h.event("agent_settled");
  await didStart;
  assert.equal(runs, 1);
  await h.event("session_shutdown", false, { reason: "quit" });
  assert.match(h.notices.at(-1)!, /cancelled by shutdown or extension reload/);
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 8, "Cancellation does not acknowledge pending experiences");
});

test("successful dreaming may update MEMORY.md itself, without scheduling itself forever", async (testCtx) => {
  let runs = 0;
  const h = await createExtensionHarness(testCtx, async (options) => {
    runs++;
    const writer = options.tools.find((tool) => tool.name === "memory_write")!;
    await writer.execute("synthetic-index", { path: "MEMORY.md", content: "# Map\n- [Finding](note.md)", expectedHash: null }, options.signal, undefined);
    return "Checked available source, preserved uncertainty, linked note.md";
  });
  await h.call("memory_write", { path: "note.md", content: "# Untested finding", expectedHash: null });
  const finished = h.waitForDream();
  for (let index = 0; index < 8; index++) await h.event("agent_settled");
  await finished;
  assert.equal(runs, 1);
  assert.match((await readMemoryNote(h.handle, "MEMORY.md"))!.content, /note.md/);
  for (let index = 0; index < 6; index++) await h.event("agent_settled");
  await h.event("agent_settled", false);
  assert.equal(runs, 1, "Dream writes and replayed leaf events do not create foreground work");
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 6);
});

test("no-change dreaming stays silent and acknowledges pending work", async (testCtx) => {
  const h = await createExtensionHarness(testCtx, async () => "");
  const finished = h.waitForDream();
  for (let index = 0; index < 8; index++) await h.event("agent_settled");
  await finished;
  assert.deepEqual(h.notices, []);
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 0);
});

test("long single-line Unicode notes remain fully readable through bounded valid JSON pages", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  const original = "😀".repeat(8000) + '"'.repeat(12000);
  const saved = resultValue(await h.call("memory_write", { path: "long.md", content: original, expectedHash: null }));
  let startCharacter = 0;
  let recovered = "";
  let pages = 0;
  while (true) {
    const raw = await h.call("memory_read", { path: "long.md", offset: 1, limit: 1, startCharacter });
    const page = resultValue(raw);
    assert.equal(page.hash, saved.hash);
    assert.ok(Buffer.byteLength(page.content) <= 8192);
    assert.ok(!page.content.includes("�"), "Unicode code points are never split");
    recovered += page.content;
    pages++;
    if (page.nextCharacter === null) { assert.equal(page.hasMore, false); break; }
    assert.ok(page.nextCharacter > startCharacter);
    startCharacter = page.nextCharacter;
  }
  assert.ok(pages > 1);
  assert.equal(recovered, original);
});

test("large escaped search results preserve valid JSON and explicitly mark dropped tail results", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  for (let index = 0; index < 30; index++) {
    await h.call("memory_write", { path: `${index}.md`, content: "\u0000".repeat(600), expectedHash: null });
  }
  const raw = await h.call("memory_search", { limit: 30 });
  const page = resultValue(raw);
  assert.equal(page.outputTruncated, true);
  assert.ok(page.results.length > 0 && page.results.length < 30);
  assert.ok(Buffer.byteLength(JSON.stringify(raw.content)) < 100000);
});

test("foreground input, runs and tree navigation leave active dreaming independent", { timeout: 5000 }, async (testCtx) => {
  const started = dreamBarrier();
  const release = dreamBarrier();
  let signal!: AbortSignal;
  const h = await createExtensionHarness(testCtx, async (options) => {
    signal = options.signal!;
    signal.addEventListener("abort", release.resolve, { once: true });
    started.resolve();
    await release.promise;
    return "Completed independently";
  });
  testCtx.after(() => release.resolve());
  for (let index = 0; index < 8; index++) await h.event("agent_settled");
  await started.promise;
  for (const event of ["input", "agent_start", "session_before_tree", "session_before_fork", "session_before_switch"]) {
    await h.event(event);
    assert.equal(signal.aborted, false, event);
  }
  const finished = h.waitForDream();
  release.resolve();
  await finished;
  assert.match(h.notices.at(-1)!, /Completed independently/);
  assert.equal(h.notices.some((notice) => notice.includes("cancelled")), false);
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 0);
});

for (const reason of ["new", "resume", "fork"]) {
  test(`active dreaming survives ${reason} runtime replacement without using retired context`, { timeout: 5000 }, async (testCtx) => {
    const started = dreamBarrier();
    const release = dreamBarrier();
    let signal!: AbortSignal;
    const h = await createExtensionHarness(testCtx, async (options) => {
      signal = options.signal!;
      signal.addEventListener("abort", release.resolve, { once: true });
      started.resolve();
      await release.promise;
      const sources = await options.sourceProvider.search("original evidence");
      assert.equal(sources.sources[0]?.id, "synthetic-session:evidence:0");
      const writer = options.tools.find((tool) => tool.name === "memory_write")!;
      const saved = resultValue(await writer.execute("save", { path: "retained.md", content: "Original project finding", expectedHash: null }, signal, undefined));
      assert.match(saved.sourceHint, /synthetic-session/);
      const reader = options.tools.find((tool) => tool.name === "memory_read")!;
      assert.equal(resultValue(await reader.execute("read", { path: "retained.md" }, signal, undefined)).content, "Original project finding");
      const search = options.tools.find((tool) => tool.name === "memory_search")!;
      assert.equal(resultValue(await search.execute("search", {}, signal, undefined))[0].path, "retained.md");
      return "Retained original project";
    });
    testCtx.after(() => release.resolve());
    testCtx.mock.method(h.ctx.sessionManager, "getBranch", () => [{
      type: "message", id: "evidence", parentId: null, timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "original evidence", timestamp: 1 },
    }]);
    for (let index = 0; index < 8; index++) await h.event("agent_settled");
    await started.promise;
    await h.event("session_shutdown", false, { reason });
    assert.equal(signal.aborted, false);
    for (const key of ["cwd", "hasUI", "ui", "sessionManager", "model", "modelRegistry", "isProjectTrusted"]) {
      Object.defineProperty(h.ctx, key, { configurable: true, get() { throw new Error("Retired Pi context accessed"); } });
    }
    const reloaded = await import(new URL(`./memory-extension.ts?dream-replacement-${reason}`, import.meta.url).href);
    const replacement = await createExtensionHarness(testCtx, async () => { throw new Error("Replacement must not duplicate the active task"); }, [], undefined, undefined, reloaded.default);
    const finished = replacement.waitForDream();
    release.resolve();
    await finished;
    assert.match(replacement.notices.at(-1)!, /Retained original project/);
    assert.equal((await readMemoryNote(h.handle, "retained.md"))?.content, "Original project finding");
    assert.equal(await readMemoryNote(replacement.handle, "retained.md"), null);
    assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 0);
  });
}

for (const succeeds of [true, false]) {
  test(`new settled work is retained during dreaming; successful completion alone schedules follow-on (${succeeds})`, { timeout: 5000 }, async (testCtx) => {
    const started = dreamBarrier();
    const release = dreamBarrier();
    const secondStarted = dreamBarrier();
    const secondRelease = dreamBarrier();
    let runs = 0;
    const h = await createExtensionHarness(testCtx, async (options) => {
      options.signal!.addEventListener("abort", () => { release.resolve(); secondRelease.resolve(); }, { once: true });
      runs++;
      if (runs === 1) {
        started.resolve();
        await release.promise;
        if (!succeeds) throw new Error("Synthetic model failure");
      } else {
        secondStarted.resolve();
        await secondRelease.promise;
      }
      return "Done";
    });
    testCtx.after(() => { release.resolve(); secondRelease.resolve(); });
    for (let index = 0; index < 8; index++) await h.event("agent_settled");
    await started.promise;
    for (let index = 0; index < 8; index++) {
      await h.event("input");
      await h.event("agent_start");
      await h.event("agent_settled");
    }
    assert.equal(runs, 1);
    const finished = h.waitForDream();
    release.resolve();
    await finished;
    if (succeeds) {
      await secondStarted.promise;
      assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 8);
      const secondFinished = h.waitForDream();
      secondRelease.resolve();
      await secondFinished;
      assert.equal(runs, 2);
      assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 0);
    } else {
      assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 16);
      assert.equal(runs, 1, "Failure does not immediately start another paid run");
      assert.match(h.notices.at(-1)!, /Synthetic model failure/);
    }
  });
}

for (const reason of ["quit", "reload"]) {
  test(`${reason} in a replacement runtime cancels the surviving task and preserves pending work`, { timeout: 5000 }, async (testCtx) => {
    const started = dreamBarrier();
    const h = await createExtensionHarness(testCtx, async (options) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true }));
      return "unreachable";
    });
    for (let index = 0; index < 8; index++) await h.event("agent_settled");
    await started.promise;
    await h.event("session_shutdown", false, { reason: "resume" });
    const replacement = await createExtensionHarness(testCtx, undefined, [], h);
    await replacement.event("session_shutdown", false, { reason });
    assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 8);
    assert.match(replacement.notices.at(-1)!, /cancelled by shutdown or extension reload/);
    const state = JSON.parse(await readFile(join(h.handle.directory, ".dream-state.json"), "utf8"));
    assert.equal(state.claim, null, "Cancellation releases the original runtime's lease");
  });
}

test("pending experiences survive short sessions and a fresh extension without foreground memory writes", async (testCtx) => {
  let runs = 0;
  const runner: typeof runMemoryDream = async () => { runs++; return "No supported reusable finding; no write needed"; };
  const h = await createExtensionHarness(testCtx, runner);
  for (let index = 0; index < 4; index++) await h.event("agent_settled");
  await h.event("agent_settled", false);
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 4);
  h.setSession("another-synthetic-session");
  await h.event("session_start");
  for (let index = 0; index < 3; index++) await h.event("agent_settled");
  assert.equal(runs, 0);
  const finished = h.waitForDream();
  await h.event("agent_settled");
  await finished;
  assert.equal(runs, 1);
  assert.deepEqual(await readMemorySchedule(h.handle), { observedTurns: 8, processedTurns: 8, pendingTurns: 0, due: false });
  assert.equal((await listMemoryNotes(h.handle)).length, 0);

  const next = await createExtensionHarness(testCtx, runner);
  // Bind the fresh runtime to the original project/root rather than its newly allocated fixture project.
  (next.ctx as { cwd: string }).cwd = h.cwd;
  process.env.PI_MEMORY_DIR = h.root;
  next.setSession("third-synthetic-session");
  await next.event("session_start");
  for (let index = 0; index < 4; index++) await next.event("agent_settled");
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 4);
  assert.equal(runs, 1, "Startup and fewer than eight new experiences do not make extra model calls");
});

test("agent_settled lock contention queues both turns and automatically dreams when the lock is released", async (testCtx) => {
  let runs = 0;
  const h = await createExtensionHarness(testCtx, async () => { runs++; return "No changes needed"; });
  for (let index = 0; index < 6; index++) await h.event("agent_settled");
  const lock = `${h.handle.directory}.lock`;
  await mkdir(lock);
  await h.event("agent_settled");
  await h.event("agent_settled", false);
  await h.event("agent_settled");
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 6);
  assert.equal(runs, 0);
  assert.deepEqual(await readdir(lock), [], "The competing writer's lock is never removed or modified");
  let deadline!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("Queued observations did not recover after lock release")), 3000);
  });
  const finished = h.waitForDream();
  try {
    await rmdir(lock);
    await Promise.race([finished, timedOut]);
  } finally { clearTimeout(deadline); }
  assert.equal(runs, 1);
  assert.deepEqual(await readMemorySchedule(h.handle), { observedTurns: 8, processedTurns: 8, pendingTurns: 0, due: false });
  await h.event("agent_settled", false);
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 8, "The restored latest leaf remains deduplicated");
});

test("same-session reload shares FIFO observations so a late old leaf cannot defeat latest-leaf deduplication", { timeout: 3000 }, async (testCtx) => {
  const queues: MemoryObservationQueue[] = [];
  const recorded: string[] = [];
  const watchImplementation = (() => Object.assign(new EventEmitter(), { close() {} }) as FSWatcher) as typeof watch;
  const queueFactory: typeof createMemoryObservationQueue = (callbacks) => {
    const queue = createMemoryObservationQueue({ ...callbacks, onRecorded(handle, turn, snapshot) {
      recorded.push(turn.entryId);
      callbacks.onRecorded(handle, turn, snapshot);
    } }, { watch: watchImplementation });
    queues.push(queue);
    return queue;
  };
  let runs = 0;
  const dream = async () => { runs++; return "No changes needed"; };
  const h = await createExtensionHarness(testCtx, dream, [], undefined, queueFactory);
  for (let index = 0; index < 5; index++) await h.event("agent_settled");
  const lock = `${h.handle.directory}.lock`;
  await mkdir(lock);
  await h.event("agent_settled"); // A: synthetic-entry-6, not yet committed.
  await h.event("session_shutdown", false, { reason: "reload" });
  const reloaded = await import(new URL("./memory-extension.ts?synthetic-reload", import.meta.url).href);
  const replacement = await createExtensionHarness(testCtx, dream, [], h, queueFactory, reloaded.default);
  replacement.setLeaf(6); // Reload keeps the same session and leaf, not a new session.
  await replacement.event("agent_settled"); // B: synthetic-entry-7.
  // Drain subscription rechecks under the held lock; then explicitly try the fresh queue first.
  for (const queue of queues) await queue.flush();
  await rmdir(lock);
  await queues.at(-1)!.flush();
  await queues[0]!.flush();
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 7);
  assert.deepEqual(recorded.slice(-2), ["synthetic-entry-6", "synthetic-entry-7"], "Module reload cannot create a competing FIFO");
  assert.equal(queues.length, 1);
  await replacement.event("agent_settled", false); // Replaying B must not count as an eighth turn.
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 7);
  assert.equal(runs, 0, "A duplicate notification must not trigger a paid dream early");
  const state = JSON.parse(await readFile(join(h.handle.directory, ".dream-state.json"), "utf8"));
  assert.deepEqual(state.sessions, [{ sessionId: "synthetic-session", entryId: "synthetic-entry-7" }]);
  const finished = replacement.waitForDream();
  await replacement.event("agent_settled");
  await finished;
  assert.equal(runs, 1, "The new runtime, not stale callbacks, handles the legitimate eighth turn");
  assert.deepEqual(await readMemorySchedule(h.handle), { observedTurns: 8, processedTurns: 8, pendingTurns: 0, due: false });
});

test("session replacement retains queued old-session turns without starting a dream from stale context", async (testCtx) => {
  let runs = 0;
  let queue!: MemoryObservationQueue;
  let acknowledge!: () => void;
  const committed = new Promise<void>((resolve) => { acknowledge = resolve; });
  const queueFactory: typeof createMemoryObservationQueue = (callbacks) => {
    queue = createMemoryObservationQueue({ ...callbacks, onRecorded(handle, turn, snapshot) {
      callbacks.onRecorded(handle, turn, snapshot);
      if (snapshot.observedTurns === 8) acknowledge();
    } });
    return queue;
  };
  const h = await createExtensionHarness(testCtx, async () => { runs++; return "No changes needed"; }, [], undefined, queueFactory);
  for (let index = 0; index < 6; index++) await h.event("agent_settled");
  const lock = `${h.handle.directory}.lock`;
  await mkdir(lock);
  await h.event("agent_settled");
  await h.event("agent_settled");
  await h.event("session_shutdown", false, { reason: "resume" });
  const replacement = await createExtensionHarness(testCtx, async () => { runs++; return "No changes needed"; }, [], h);
  replacement.setSession("replacement-session");
  await replacement.event("session_start");
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 6);
  assert.equal(queue.pendingCount, 2, "Uncommitted observations survive runtime replacement in the same FIFO");
  let deadline!: ReturnType<typeof setTimeout>;
  const timedOut = new Promise<never>((_resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("Old runtime observation completion was not signalled")), 3000);
  });
  try {
    await rmdir(lock);
    await Promise.race([committed, timedOut]);
  } finally { clearTimeout(deadline); }
  assert.equal(runs, 0, "Neither the retired runtime nor fresh-session startup makes a paid dream call");
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 8, "Old observations keep their original session and leaf identities");
  const finished = replacement.waitForDream();
  await replacement.event("agent_settled");
  await finished;
  assert.equal(runs, 1, "Only a completed interaction in the replacement session starts a dream from fresh context");
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 9);
});

test("quitting with a held lock reports unsaved observations instead of hanging or claiming persistence", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  await h.event("agent_settled");
  const lock = `${h.handle.directory}.lock`;
  await mkdir(lock);
  await h.event("agent_settled");
  await h.event("session_shutdown", false, { reason: "resume" });
  const replacement = await createExtensionHarness(testCtx, undefined, [], h);
  replacement.setSession("replacement-session");
  await replacement.event("session_start");
  await replacement.event("session_shutdown", false, { reason: "quit" });
  assert.match(replacement.notices.at(-1) ?? "", /1 completed-turn observation.*not yet saved.*lost on exit/);
  assert.deepEqual(await readdir(lock), []);
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 1);
  await rmdir(lock);
});

test("retired observation recovery never reads a stale Pi context when storage fails", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  await h.event("agent_settled");
  const statePath = join(h.handle.directory, ".dream-state.json");
  const originalState = await readFile(statePath, "utf8");
  const lock = `${h.handle.directory}.lock`;
  await mkdir(lock);
  await h.event("agent_settled");
  await h.event("session_shutdown", false, { reason: "reload" });
  Object.defineProperty(h.ctx, "hasUI", { get() { throw new Error("Retired Pi context was accessed"); } });
  const replacement = await createExtensionHarness(testCtx, async () => "No changes needed", [], h);
  await writeFile(statePath, "{invalid-state");
  let deadline!: ReturnType<typeof setTimeout>;
  const reported = new Promise<void>((resolve, reject) => {
    deadline = setTimeout(() => reject(new Error("Retired observation error was not reported safely")), 3000);
    testCtx.mock.method(replacement.ctx.ui, "notify", (message: string) => {
      replacement.notices.push(message);
      if (message.includes("Completed-turn observations remain queued")) resolve();
    });
  });
  try {
    await rmdir(lock);
    await reported;
  } finally { clearTimeout(deadline); }
  await writeFile(statePath, originalState);
  await replacement.event("session_start");
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 2, "The retired observation survives a non-lock error and can be retried");
});

test("automatic dreaming startup flag still persists pending experiences for later automatic work", async (testCtx) => {
  let runs = 0;
  const flags = ["pi-memory-no-dream"];
  const h = await createExtensionHarness(testCtx, async () => { runs++; return "No changes"; }, flags);
  for (let index = 0; index < 8; index++) await h.event("agent_settled");
  assert.equal(runs, 0);
  assert.equal((await readMemorySchedule(h.handle)).due, true);
  await h.event("session_start");
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 8);
  flags.pop();
  await h.event("session_start");
  assert.equal(runs, 0, "Startup does not start a model run");
  const finished = h.waitForDream();
  await h.event("agent_settled");
  await finished;
  assert.equal(runs, 1);
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 0);
});
