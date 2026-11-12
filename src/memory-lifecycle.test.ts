import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  SessionManager, type ContextEvent, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import piMemoryExtension from "./memory-extension.ts";
import { claimMemoryDream, finishMemoryDream, readMemorySchedule } from "./memory-schedule.ts";
import { archiveMemoryNote, createMemoryStoreHandle, listMemoryNotes, readMemoryNote, writeMemoryNote } from "./memory-store.ts";

test("synthetic detached-worker seam preserves cross-session evidence, correction history, merging and ephemeral recall", async (testCtx) => {
  const directory = await createMemoryTestDirectory(testCtx);
  const cwd = join(directory, "project");
  const config = join(directory, "isolated-config");
  const root = join(directory, "isolated-memory");
  await mkdir(cwd);
  await mkdir(config);
  const previousRoot = process.env.PI_MEMORY_DIR;
  const previousConfig = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_MEMORY_DIR = root;
  process.env.PI_CODING_AGENT_DIR = config;
  testCtx.after(() => {
    if (previousRoot === undefined) delete process.env.PI_MEMORY_DIR; else process.env.PI_MEMORY_DIR = previousRoot;
    if (previousConfig === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousConfig;
  });
  const handle = createMemoryStoreHandle(root, cwd, "project");
  const first = SessionManager.inMemory(cwd);
  const feedback = "Synthetic fixture v2: cache OFF passes; retry OFF still fails. This contradicts the retry hypothesis.";
  first.appendMessage({ role: "user", content: feedback, timestamp: 1 });
  const sourceFile = join(directory, "synthetic-native-history.jsonl");
  const sourceBytes = [first.getHeader(), ...first.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  await writeFile(sourceFile, sourceBytes);
  const oldNote = "# Retry hypothesis\nUnverified synthetic fixture hypothesis: retry causes the failure.\n";
  const duplicate = "# Duplicate\nSynthetic fixture v2 needs investigation.\n";
  await writeMemoryNote(handle, { path: "notes/cache.md", content: oldNote, expectedHash: null });
  await writeMemoryNote(handle, { path: "notes/duplicate.md", content: duplicate, expectedHash: null });
  await writeMemoryNote(handle, { path: "MEMORY.md", content: "# Memory\n- [Duplicate](notes/duplicate.md)\n", expectedHash: null });
  let launches = 0;
  let finishMaintenance!: () => void;
  let failMaintenance!: (error: unknown) => void;
  const maintenance = new Promise<void>((resolve, reject) => { finishMaintenance = resolve; failMaintenance = reject; });
  const corrected = "# Cache finding\nSynthetic fixture v2 feedback contradicts the retry hypothesis: cache OFF passes; retry OFF still fails. Not a universal claim.\n";
  const index = "# Memory\n- [Cache finding](notes/cache.md): synthetic fixture v2 only.\n";

  function runtime(manager: SessionManager) {
    type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, ToolDefinition>();
    const ctx = {
      cwd, hasUI: false, sessionManager: manager, isProjectTrusted: () => true,
      model: { provider: "synthetic", id: "offline" },
    } as unknown as ExtensionContext;
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      registerCommand() {}, registerFlag() {}, getFlag: () => false, getThinkingLevel: () => "off",
      on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    } as unknown as ExtensionAPI;
    piMemoryExtension(pi, async (options) => {
      launches++;
      assert.equal(options.handle.directory, handle.directory);
      // This fixture stands in for the independently running worker, not a model effectiveness test.
      void (async () => {
        const claim = await claimMemoryDream(handle, { ownerId: "synthetic-worker" });
        assert.ok(claim);
        assert.equal(await readFile(sourceFile, "utf8"), sourceBytes);
        assert.ok(sourceBytes.includes(feedback));
        const retained = (await readMemoryNote(handle, "notes/cache.md"))!;
        const obsolete = (await readMemoryNote(handle, "notes/duplicate.md"))!;
        const oldIndex = (await readMemoryNote(handle, "MEMORY.md"))!;
        await writeMemoryNote(handle, { path: retained.path, content: corrected, expectedHash: retained.hash });
        await archiveMemoryNote(handle, obsolete.path, obsolete.hash);
        await writeMemoryNote(handle, { path: oldIndex.path, content: index, expectedHash: oldIndex.hash });
        await finishMemoryDream(handle, claim, { success: true });
        finishMaintenance();
      })().catch(failMaintenance);
      return "Synthetic worker launch acknowledged";
    });
    return {
      tools,
      async event(name: string, event = {}) { await handlers.get(name)?.(event, ctx); },
      async recall(messages: ContextEvent["messages"]) {
        return await handlers.get("context")!({ messages }, ctx) as { messages: ContextEvent["messages"] };
      },
    };
  }

  const firstRuntime = runtime(first);
  await firstRuntime.event("session_start");
  for (let i = 0; i < 25; i++) {
    first.appendMessage({ role: "user", content: `Synthetic task ${i}`, timestamp: i + 2 });
    await firstRuntime.event("agent_settled");
  }
  assert.equal((await readMemorySchedule(handle)).pendingTurns, 25, "Preexisting feedback is baseline, not retroactively counted");
  await firstRuntime.event("session_shutdown", { reason: "quit" });
  const firstEntries = first.getEntries();
  const second = SessionManager.inMemory(cwd);
  const secondRuntime = runtime(second);
  await secondRuntime.event("session_start");
  for (let i = 0; i < 25; i++) {
    second.appendMessage({ role: "user", content: `Synthetic second-session task ${i}`, timestamp: i + 50 });
    await secondRuntime.event("agent_settled");
  }
  const secondEntries = second.getEntries();
  await secondRuntime.event("session_shutdown", { reason: "reload" });
  await maintenance;
  assert.equal(launches, 1);
  assert.deepEqual(await readMemorySchedule(handle), { observedTurns: 50, processedTurns: 50, pendingTurns: 0, due: false });
  assert.equal((await readMemoryNote(handle, "notes/cache.md"))?.content, corrected);
  assert.equal(await readMemoryNote(handle, "notes/duplicate.md"), null);
  assert.deepEqual((await listMemoryNotes(handle)).map((note) => note.path), ["MEMORY.md", "notes/cache.md"]);
  for (const [path, original] of [["notes/cache.md", oldNote], ["notes/duplicate.md", duplicate]]) {
    const history = join(handle.directory, ".history", path);
    const snapshots = await readdir(history);
    assert.equal(snapshots.length, 1);
    assert.equal(await readFile(join(history, snapshots[0]), "utf8"), original);
  }
  const fresh = runtime(SessionManager.inMemory(cwd));
  await fresh.event("session_start");
  const messages: ContextEvent["messages"] = [{ role: "user", content: "Unrelated question", timestamp: 100 }];
  const recalled = await fresh.recall(messages);
  assert.equal(messages.length, 1);
  assert.equal(recalled.messages.length, 2);
  assert.ok(JSON.stringify(recalled.messages[0]).includes("notes/cache.md"));
  assert.ok(!JSON.stringify(recalled.messages).includes(corrected));
  assert.equal((await fresh.recall(recalled.messages)).messages.length, 2);
  assert.equal(await readFile(sourceFile, "utf8"), sourceBytes);
  assert.deepEqual(first.getEntries(), firstEntries);
  assert.deepEqual(second.getEntries(), secondEntries);
  assert.deepEqual(await readdir(config), []);
  await fresh.event("session_shutdown", { reason: "quit" });
});
