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
  const userEntries = () => Array.from({ length: leafNumber }, (_, index) => ({
    type: "message", id: `synthetic-entry-${index + 1}`, message: { role: "user", content: "Synthetic task" },
  }));
  const ctx = {
    cwd, hasUI: true, mode: "print", isProjectTrusted: () => trusted,
    model: { id: "synthetic-model", provider: "synthetic-provider", maxTokens: 65536 }, modelRegistry: {},
    sessionManager: {
      getSessionId: () => sessionId, getLeafId: () => `synthetic-entry-${leafNumber}`,
      getCwd: () => cwd, getSessionDir: () => join(directory, "isolated-sessions"),
      getSessionFile: () => join(directory, "isolated-sessions", `${sessionId}.jsonl`),
      getEntries: () => userEntries(), getBranch: () => userEntries(),
    },
    ui: { notify: (message: string) => notices.push(message), setStatus: (_key: string, value: string | undefined) => { if (!value) dreamFinished?.(); },
      confirm: () => { throw new Error("No mandatory human approval is allowed"); } },
  } as unknown as ExtensionContext;
  const pi = {
    registerTool: (definition: ToolDefinition) => tools.set(definition.name, definition),
    registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, command.handler),
    registerFlag: () => {}, getFlag: (name: string) => flags.includes(name), getThinkingLevel: () => "medium",
    sendUserMessage: (content: string, options: { deliverAs?: string; expandPromptTemplates?: boolean }) => requests.push({ content, options }),
    on: (event: ExtensionEvent["type"], handler: MockHandler) => { handlers.set(event, handler); return () => {}; },
  } as unknown as ExtensionAPI;
  registerExtension(pi, dream ? async (options) => { const result = await dream(options); dreamFinished?.(); return result; } : undefined, observationQueueFactory);
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

test("archive accepts an empty content placeholder from model calls without weakening hash or history checks", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  const original = "# Duplicate note\nRetain these original bytes in archive history.\n";
  const saved = resultValue(await h.call("memory_write", { path: "duplicate.md", content: original, expectedHash: null }));
  const archive = { action: "archive", path: "duplicate.md", content: "", expectedHash: saved.hash };
  await assert.rejects(h.call("memory_write", { ...archive, content: "not an empty placeholder" }), /archive requires/);
  await assert.rejects(h.call("memory_write", { ...archive, expectedHash: null }), /archive requires/);
  await assert.rejects(h.call("memory_write", { ...archive, expectedHash: "0".repeat(64) }), /hash conflict/);
  assert.equal((await readMemoryNote(h.handle, "duplicate.md"))!.content, original);
  const result = resultValue(await h.call("memory_write", archive));
  assert.equal(result.action, "archive");
  assert.equal(result.hash, saved.hash);
  assert.equal(await readMemoryNote(h.handle, "duplicate.md"), null);
  const historyDirectory = join(h.handle.directory, ".history", "duplicate.md");
  const snapshots = await readdir(historyDirectory);
  assert.equal(snapshots.length, 1);
  assert.equal(await readFile(join(historyDirectory, snapshots[0]), "utf8"), original);
  const index = resultValue(await h.call("memory_write", { path: "MEMORY.md", content: "# Index", expectedHash: null }));
  await assert.rejects(h.call("memory_write", { ...archive, path: "MEMORY.md", expectedHash: index.hash }), /cannot be archived/);
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

test("project user-message totals persist across sessions and launch without frontend acknowledgment of completion", async (testCtx) => {
  let runs = 0;
  const h = await createExtensionHarness(testCtx, async (options) => {
    runs++;
    assert.deepEqual(options.model, { provider: "synthetic-provider", id: "synthetic-model" });
    assert.equal(options.thinkingLevel, "medium");
    assert.equal(options.handle.directory, h.handle.directory);
    assert.ok(options.sessionRoots.some((root) => root.endsWith("isolated-sessions")));
    assert.equal("signal" in options, false);
    assert.equal("tools" in options, false);
    return "Detached worker started";
  });
  for (let index = 0; index < 25; index++) await h.event("agent_settled");
  await h.event("agent_settled", false);
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 25);
  h.setSession("another-synthetic-session");
  await h.event("session_start");
  for (let index = 0; index < 24; index++) await h.event("agent_settled");
  assert.equal(runs, 0);
  const launched = h.waitForDream();
  await h.event("agent_settled");
  await launched;
  assert.equal(runs, 1);
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 50, "Only the worker may mark work complete");
  assert.equal((await listMemoryNotes(h.handle)).length, 0);
  const state = JSON.parse(await readFile(join(h.handle.directory, ".dream-state.json"), "utf8"));
  assert.equal(new Set(state.messages.map((message: { sessionId: string }) => message.sessionId)).size, 2);
  assert.ok(state.messages.every((message: { sessionFile: string }) => message.sessionFile.endsWith(".jsonl")));
});

test("settled counts every new user entry, not assistant leaves or notifications, and baselines history", async (testCtx) => {
  const h = await createExtensionHarness(testCtx);
  h.setLeaf(12);
  await h.event("session_start");
  await h.event("agent_settled", false);
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 0);
  h.setLeaf(15);
  await h.event("agent_settled", false);
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 3);
  await h.event("agent_settled", false);
  await h.event("session_before_tree");
  h.setLeaf(13);
  await h.event("agent_settled", false);
  h.setLeaf(15);
  await h.event("agent_settled", false);
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 3);
  testCtx.mock.method(h.ctx.sessionManager, "getBranch", () => [{
    type: "message", id: "assistant-leaf", parentId: null, timestamp: "synthetic", message: {
      role: "assistant", content: [],
    },
  }] as unknown as ReturnType<ExtensionContext["sessionManager"]["getBranch"]>);
  await h.event("agent_settled", false);
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 3);
});

for (const reason of ["quit", "reload", "new", "resume", "fork"]) {
  test(`frontend ${reason} never waits for or cancels an independent worker`, async (testCtx) => {
    let release!: (value: string) => void;
    let launched = false;
    let workerFinished = false;
    const pendingWorker = new Promise<void>((resolve) => { release = () => { workerFinished = true; resolve(); }; });
    const h = await createExtensionHarness(testCtx, async () => { launched = true; return "Detached worker launch acknowledged"; });
    h.setLeaf(50);
    await h.event("agent_settled", false);
    assert.equal(launched, true);
    await h.event("session_shutdown", false, { reason });
    assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 50);
    assert.equal(workerFinished, false);
    release("Finished independently");
    await pendingWorker;
  });
}

test("shutdown waits only for launch acknowledgment and concurrent due observations share startup", async (testCtx) => {
  let release!: (value: string) => void;
  let launches = 0;
  const acknowledgment = new Promise<string>((resolve) => { release = resolve; });
  const h = await createExtensionHarness(testCtx, async () => { launches++; return acknowledgment; });
  h.setLeaf(50);
  await h.event("agent_settled", false);
  await h.event("agent_settled");
  assert.equal(launches, 1);
  let shutDown = false;
  const shutdown = h.event("session_shutdown", false, { reason: "quit" }).then(() => { shutDown = true; });
  await Promise.resolve();
  assert.equal(shutDown, false, "The process must not exit before the detached worker is spawned");
  release("Worker PID and log path acknowledged");
  await shutdown;
  assert.equal(shutDown, true);
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 51, "Startup acknowledgment is not worker completion");
});

test("dream worker retains memory tools and recall but never records or launches recursive work", async (testCtx) => {
  const old = process.env.PI_MEMORY_DREAM_WORKER;
  process.env.PI_MEMORY_DREAM_WORKER = "1";
  testCtx.after(() => { if (old === undefined) delete process.env.PI_MEMORY_DREAM_WORKER; else process.env.PI_MEMORY_DREAM_WORKER = old; });
  let calls = 0;
  const h = await createExtensionHarness(testCtx, async () => { calls++; return "must not launch"; });
  await h.call("memory_write", { path: "MEMORY.md", content: "# Worker index", expectedHash: null });
  h.setLeaf(60);
  await h.event("agent_settled", false);
  assert.equal(calls, 0);
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 0);
  assert.equal((await h.context([{ role: "user", content: "Synthetic maintenance", timestamp: 1 }])).messages.length, 2);
});

test("agent_settled lock contention queues both turns and automatically dreams when the lock is released", async (testCtx) => {
  let runs = 0;
  const h = await createExtensionHarness(testCtx, async () => { runs++; return "No changes needed"; });
  for (let index = 0; index < 48; index++) await h.event("agent_settled");
  const lock = `${h.handle.directory}.lock`;
  await mkdir(lock);
  await h.event("agent_settled");
  await h.event("agent_settled", false);
  await h.event("agent_settled");
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 48);
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
  assert.deepEqual(await readMemorySchedule(h.handle), { observedTurns: 50, processedTurns: 0, pendingTurns: 50, due: true });
  await h.event("agent_settled", false);
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 50, "The restored latest leaf remains deduplicated");
});

test("same-session reload shares FIFO observations and user-message deduplication", { timeout: 3000 }, async (testCtx) => {
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
  for (let index = 0; index < 47; index++) await h.event("agent_settled");
  const lock = `${h.handle.directory}.lock`;
  await mkdir(lock);
  await h.event("agent_settled"); // A: synthetic-entry-48, not yet committed.
  await h.event("session_shutdown", false, { reason: "reload" });
  const reloaded = await import(new URL("./memory-extension.ts?synthetic-reload", import.meta.url).href);
  const replacement = await createExtensionHarness(testCtx, dream, [], h, queueFactory, reloaded.default);
  replacement.setLeaf(48);
  await replacement.event("session_start"); // Reload keeps the same session and leaf, not a new session.
  await replacement.event("agent_settled"); // B: synthetic-entry-49.
  // Drain subscription rechecks under the held lock; then explicitly try the fresh queue first.
  for (const queue of queues) await queue.flush();
  await rmdir(lock);
  await queues.at(-1)!.flush();
  await queues[0]!.flush();
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 49);
  assert.deepEqual(recorded.slice(-2), ["synthetic-entry-48", "synthetic-entry-49"], "Module reload cannot create a competing FIFO");
  assert.equal(queues.length, 1);
  await replacement.event("agent_settled", false); // Replaying B must not count as a new user message.
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 49);
  assert.equal(runs, 0, "A duplicate notification must not trigger a paid dream early");
  const state = JSON.parse(await readFile(join(h.handle.directory, ".dream-state.json"), "utf8"));
  assert.equal(state.messages[0].sessionId, "synthetic-session");
  const finished = replacement.waitForDream();
  await replacement.event("agent_settled");
  await finished;
  assert.equal(runs, 1, "The new runtime, not stale callbacks, handles the legitimate fiftieth user message");
  assert.deepEqual(await readMemorySchedule(h.handle), { observedTurns: 50, processedTurns: 0, pendingTurns: 50, due: true });
});

test("session replacement retains queued old-session turns without starting a dream from stale context", async (testCtx) => {
  let runs = 0;
  let queue!: MemoryObservationQueue;
  let acknowledge!: () => void;
  const committed = new Promise<void>((resolve) => { acknowledge = resolve; });
  const queueFactory: typeof createMemoryObservationQueue = (callbacks) => {
    queue = createMemoryObservationQueue({ ...callbacks, onRecorded(handle, turn, snapshot) {
      callbacks.onRecorded(handle, turn, snapshot);
      if (snapshot.observedTurns === 50) acknowledge();
    } });
    return queue;
  };
  const h = await createExtensionHarness(testCtx, async () => { runs++; return "No changes needed"; }, [], undefined, queueFactory);
  for (let index = 0; index < 48; index++) await h.event("agent_settled");
  const lock = `${h.handle.directory}.lock`;
  await mkdir(lock);
  await h.event("agent_settled");
  await h.event("agent_settled");
  await h.event("session_shutdown", false, { reason: "resume" });
  const replacement = await createExtensionHarness(testCtx, async () => { runs++; return "No changes needed"; }, [], h);
  replacement.setSession("replacement-session");
  await replacement.event("session_start");
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 48);
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
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 50, "Old observations keep their original session and leaf identities");
  const finished = replacement.waitForDream();
  await replacement.event("agent_settled");
  await finished;
  assert.equal(runs, 1, "Only a completed interaction in the replacement session starts a dream from fresh context");
  assert.equal((await readMemorySchedule(h.handle)).observedTurns, 51);
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
  assert.match(replacement.notices.at(-1) ?? "", /1 user-message observation.*not yet saved.*lost on exit/);
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
      if (message.includes("User-message observations remain queued")) resolve();
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
  for (let index = 0; index < 50; index++) await h.event("agent_settled");
  assert.equal(runs, 0);
  assert.equal((await readMemorySchedule(h.handle)).due, true);
  await h.event("session_start");
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 50);
  flags.pop();
  await h.event("session_start");
  assert.equal(runs, 0, "Startup does not start a model run");
  const finished = h.waitForDream();
  await h.event("agent_settled");
  await finished;
  assert.equal(runs, 1);
  assert.equal((await readMemorySchedule(h.handle)).pendingTurns, 51);
});
