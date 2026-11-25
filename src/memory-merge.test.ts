import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import type { MemoryDreamNotification } from "./memory-dream-notifications.ts";
import { runMemoryDream } from "./memory-dream.ts";
import piMemoryExtension from "./memory-extension.ts";
import {
  claimMemoryMerge, finishMemoryMerge, hasActiveMemoryMerge, isMemoryMergeDue, markMemoryMergeLaunch,
  MEMORY_MERGE_RETRY_MS, prepareMemoryMerge, runMemoryMerge, type MemoryMergeOptions,
} from "./memory-merge.ts";
import {
  defaultLocalMemoryMapPath, legacyProjectDirectoryName, resolveMemoryProjectDetails,
} from "./memory-project.ts";
import { claimMemoryDream, readMemorySchedule, recordMemoryTurn } from "./memory-schedule.ts";
import {
  createMemoryStoreHandle, listMemoryNotes, readMemoryNote, resolveMemoryProjectHandle, writeMemoryNote,
} from "./memory-store.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

function testEnvironment(ctx: TestContext, values: Record<string, string>): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  ctx.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function cleanupSupervisor(ctx: TestContext, receipt: string): void {
  const pid = Number(receipt.match(/supervisor PID (\d+)/)?.[1]);
  if (pid) ctx.after(() => { try { process.kill(-pid, "SIGKILL"); } catch {} });
}

async function createGitRepo(root: string, name: string, originUrl?: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(join(repo, ".git"), { recursive: true });
  const config = originUrl
    ? `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n`
    : "[core]\n\trepositoryformatversion = 0\n";
  await writeFile(join(repo, ".git", "config"), config);
  return repo;
}

async function createLinkedWorktree(mainRepo: string, worktreePath: string, name: string): Promise<string> {
  const adminDir = join(mainRepo, ".git", "worktrees", name);
  await mkdir(adminDir, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  await writeFile(join(worktreePath, ".git"), `gitdir: ${adminDir}\n`);
  await writeFile(join(adminDir, "commondir"), "../..\n");
  await writeFile(join(adminDir, "gitdir"), `${join(worktreePath, ".git")}\n`);
  return worktreePath;
}

async function waitForStatus(runDirectory: string, ready: (status: Record<string, unknown>) => boolean, timeoutMs = 20000): Promise<Record<string, unknown>> {
  const end = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < end) {
    try {
      last = JSON.parse(await readFile(join(runDirectory, "status.json"), "utf8")) as Record<string, unknown>;
      if (ready(last)) return last;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for merge status in ${runDirectory}; last=${JSON.stringify(last)}`);
}

test("prepareMemoryMerge promotes a sole sibling clone and archives empty sibling stores without LLM calls", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  await mkdir(root, { recursive: true });

  const cloneA = await createGitRepo(directory, "clone-a", "https://github.com/org/zero-llm.git");
  const cloneB = await createGitRepo(directory, "clone-b", "git@github.com:org/zero-llm.git");

  // 1. Only cloneA has a legacy store; opening cloneB promotes cloneA directly to primary with zero LLM.
  const cloneALegacy = join(root, legacyProjectDirectoryName(cloneA));
  await mkdir(cloneALegacy, { recursive: true });
  await writeFile(join(cloneALegacy, ".identity.json"), JSON.stringify({ identity: cloneA, scope: "project" }) + "\n");
  await writeFile(join(cloneALegacy, "MEMORY.md"), "# Clone A memory\n");

  const resolvedB = await resolveMemoryProjectHandle(root, cloneB, { sshConfigPath: "" });
  const promoted = await prepareMemoryMerge(root, resolvedB.project, resolvedB.handle, { sshConfigPath: "" });
  assert.equal(promoted.kind, "promoted");
  assert.equal((await readMemoryNote(resolvedB.handle, "MEMORY.md"))?.content, "# Clone A memory\n");
  assert.deepEqual(await readdir(root), [basename(resolvedB.handle.directory)]);

  // 2. Add an empty legacy worktree store that only holds unprocessed v2 schedule messages.
  const wt = await createLinkedWorktree(cloneB, join(directory, "clone-b-wt"), "clone-b-wt");
  const wtLegacy = join(root, legacyProjectDirectoryName(wt));
  await mkdir(wtLegacy, { recursive: true });
  await writeFile(join(wtLegacy, ".identity.json"), JSON.stringify({ identity: wt, scope: "project" }) + "\n");
  await writeFile(join(wtLegacy, ".dream-state.json"), JSON.stringify({
    version: 2,
    observedTurns: 2,
    processedTurns: 1,
    messages: [
      { sessionId: "s-old", entryId: "already-processed" },
      { sessionId: "s-old", entryId: "unprocessed-1" },
    ],
    legacy: null,
    claim: null,
  }) + "\n");

  const archivedEmpty = await prepareMemoryMerge(root, resolvedB.project, resolvedB.handle, { sshConfigPath: "" });
  assert.equal(archivedEmpty.kind, "archived_empty");
  assert.equal(archivedEmpty.archivedCount, 1);
  // Legacy dir is moved out of root into `<primary>/.merged-legacy/` and its unprocessed turn was folded.
  assert.deepEqual(await readdir(root), [basename(resolvedB.handle.directory)]);
  const archivedEntries = await readdir(join(resolvedB.handle.directory, ".merged-legacy"));
  assert.equal(archivedEntries.length, 1);
  const manifest = JSON.parse(await readFile(
    join(resolvedB.handle.directory, ".merged-legacy", archivedEntries[0]!, ".merge-manifest.json"),
    "utf8",
  )) as Record<string, unknown>;
  assert.equal(manifest.mode, "empty-auto");
  assert.equal(manifest.noteCount, 0);
  assert.equal((await readMemorySchedule(resolvedB.handle)).pendingTurns, 1);
});

test("merge lease, failure backoff, dream mutual exclusion, and concurrent-edit fingerprint guard", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const repo = await createGitRepo(directory, "main", "https://github.com/org/guards.git");
  const wt1 = await createLinkedWorktree(repo, join(directory, "wt-1"), "wt-1");
  const wt2 = await createLinkedWorktree(repo, join(directory, "wt-2"), "wt-2");

  const { handle, project } = await resolveMemoryProjectHandle(root, repo, { sshConfigPath: "" });
  await writeMemoryNote(handle, { path: "MEMORY.md", content: "# Primary\n", expectedHash: null });

  const wt1Dir = join(root, legacyProjectDirectoryName(wt1));
  const wt2Dir = join(root, legacyProjectDirectoryName(wt2));
  await mkdir(wt1Dir, { recursive: true });
  await mkdir(wt2Dir, { recursive: true });
  await writeFile(join(wt1Dir, ".identity.json"), JSON.stringify({ identity: wt1, scope: "project" }) + "\n");
  await writeFile(join(wt2Dir, ".identity.json"), JSON.stringify({ identity: wt2, scope: "project" }) + "\n");
  await writeFile(join(wt1Dir, "a.md"), "# Note A\n");
  await writeFile(join(wt2Dir, "b.md"), "# Note B\n");

  const prepared = await prepareMemoryMerge(root, project, handle, { sshConfigPath: "" });
  assert.equal(prepared.kind, "needs_merge");
  assert.equal(prepared.sources.length, 2);

  // 1. Launch mark backs off unchanged sources until retry window expires or source content changes.
  const t0 = Date.now();
  assert.equal(await isMemoryMergeDue(handle, prepared.sources, t0), true);
  assert.equal(await markMemoryMergeLaunch(handle, prepared.sources, t0), true);
  assert.equal(await isMemoryMergeDue(handle, prepared.sources, t0 + 1000), false);
  assert.equal(await isMemoryMergeDue(handle, prepared.sources, t0 + MEMORY_MERGE_RETRY_MS + 1), true);

  // Changing a note invalidates the backoff immediately.
  await writeFile(join(wt1Dir, "a.md"), "# Note A updated\n");
  const preparedChanged = await prepareMemoryMerge(root, project, handle, { sshConfigPath: "" });
  assert.equal(preparedChanged.kind, "needs_merge");
  assert.equal(await isMemoryMergeDue(handle, preparedChanged.sources, t0 + 1000), true);

  // 2. Active merge lease blocks competing merge claims AND blocks project dreaming.
  for (let i = 0; i < 50; i++) {
    await recordMemoryTurn(handle, { sessionId: "s1", entryId: `u-${i}` });
  }
  const claim1 = await claimMemoryMerge(handle, { ownerId: "worker-1", sources: preparedChanged.sources });
  assert.ok(claim1);
  assert.equal(await hasActiveMemoryMerge(handle), true);
  assert.equal(await claimMemoryMerge(handle, { ownerId: "worker-2", sources: preparedChanged.sources }), null);
  assert.equal(await runMemoryDream({
    handle, agentDir: join(directory, "agent"), model: { provider: "mock", id: "m" },
    sessionRoots: [], workerCwd: repo,
  }), "", "Active merge lease suppresses project dreaming");

  // 3. Failed merge releases lease and leaves all legacy stores completely untouched.
  const failed = await finishMemoryMerge(handle, claim1, { success: false });
  assert.deepEqual(failed, { archived: [], deferred: [] });
  assert.equal(await hasActiveMemoryMerge(handle), false);
  assert.ok(await stat(wt1Dir));
  assert.ok(await stat(wt2Dir));

  // 4. Active project dream lease blocks merge claims.
  const dreamClaim = await claimMemoryDream(handle, { ownerId: "dream-worker" });
  assert.ok(dreamClaim);
  assert.equal(await isMemoryMergeDue(handle, preparedChanged.sources, t0 + MEMORY_MERGE_RETRY_MS + 10), false);
  assert.equal(await claimMemoryMerge(handle, { ownerId: "worker-3", sources: preparedChanged.sources }), null);
  // Expire the dream claim cleanly by overwriting with expired timestamp via direct file for test setup.
  const dreamState = JSON.parse(await readFile(join(handle.directory, ".dream-state.json"), "utf8")) as {
    claim: { expiresAt: number };
  };
  dreamState.claim.expiresAt = Date.now() - 1000;
  await writeFile(join(handle.directory, ".dream-state.json"), JSON.stringify(dreamState) + "\n");

  // 5. Concurrent edit to wt1 during merge defers archiving wt1 while still archiving unchanged wt2!
  const claim2 = await claimMemoryMerge(handle, { ownerId: "worker-4", sources: preparedChanged.sources });
  assert.ok(claim2);
  await writeFile(join(wt1Dir, "a.md"), "# Note A concurrently edited while worker ran\n");
  const finished = await finishMemoryMerge(handle, claim2, { success: true });
  assert.equal(finished.archived.length, 1);
  assert.equal(finished.deferred.length, 1);
  assert.equal(finished.deferred[0]?.directory, wt1Dir);
  assert.equal(finished.deferred[0]?.reason, "modified");
  // wt1 stays at root (not lost!), wt2 moved into .merged-legacy/.
  assert.ok(await stat(wt1Dir));
  await assert.rejects(stat(wt2Dir), { code: "ENOENT" });
  assert.equal(await readFile(join(finished.archived[0]!, "b.md"), "utf8"), "# Note B\n");

  // 6. Corrupt `.merge-state.json` fails closed.
  await writeFile(join(handle.directory, ".merge-state.json"), "{corrupt");
  await assert.rejects(hasActiveMemoryMerge(handle));
});

test("real isolated Pi CLI store-merge worker consolidates legacy worktree notes, refuses global scope, and archives legacy store", { timeout: 25000 }, async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const mainRepo = await createGitRepo(directory, "main-repo", "https://github.com/org/e2e-merge.git");
  const wt = await createLinkedWorktree(mainRepo, join(directory, "wt-branch"), "wt-branch");

  const { handle, project } = await resolveMemoryProjectHandle(root, wt, { sshConfigPath: "" });
  await writeMemoryNote(handle, { path: "MEMORY.md", content: "# Project memory\n\nExisting primary note.\n", expectedHash: null });

  // Create a legacy worktree store with active Markdown, hidden history, and an unprocessed schedule message.
  const wtLegacy = join(root, legacyProjectDirectoryName(wt));
  await mkdir(join(wtLegacy, ".history", "lesson.md"), { recursive: true });
  await writeFile(join(wtLegacy, ".identity.json"), JSON.stringify({ identity: wt, scope: "project" }) + "\n");
  const legacyNoteFile = join(wtLegacy, "lesson.md");
  await writeFile(legacyNoteFile, "# Worktree lesson\n\nWORKTREE_SYNTHETIC_LESSON\n");
  await writeFile(join(wtLegacy, ".history", "lesson.md", "snap.md"), "# Older snapshot\n");
  await writeFile(join(wtLegacy, ".dream-state.json"), JSON.stringify({
    version: 2,
    observedTurns: 1,
    processedTurns: 0,
    messages: [{ sessionId: "legacy-wt-session", entryId: "entry-42" }],
    legacy: null,
    claim: null,
  }) + "\n");

  const prepared = await prepareMemoryMerge(root, project, handle, { sshConfigPath: "" });
  assert.equal(prepared.kind, "needs_merge");
  assert.equal(prepared.sources.length, 1);

  const trace = join(directory, "trace.jsonl");
  testEnvironment(ctx, {
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    JITI_FS_CACHE: "false",
    PI_MEMORY_TEST_TRACE: trace,
    PI_MEMORY_TEST_LEGACY_FILE: legacyNoteFile,
  });

  const notifications: MemoryDreamNotification[] = [];
  const controller = new AbortController();
  ctx.after(() => controller.abort());

  const options: MemoryMergeOptions = {
    handle,
    agentDir: join(directory, "agent"),
    model: { provider: "memory-merge-test", id: "scripted" },
    thinkingLevel: "off",
    workerCwd: project.worktreeRoot,
    sources: prepared.sources,
  };
  const receipt = await runMemoryMerge(options, {
    cliPath,
    cliArgs: [
      "--offline", "--approve", "--no-extensions", "--no-mcp", "--no-skills",
      "--no-prompt-templates", "--no-context-files", "--no-session",
      "-e", join(packageRoot, "test/memory-merge-provider.ts"),
    ],
    statusSignal: controller.signal,
    onStatus: (notification) => notifications.push(notification),
  });
  cleanupSupervisor(ctx, receipt);
  assert.match(receipt, /Memory store merge launched independently/);
  // Launch mark suppresses a competing immediate launch.
  assert.equal(await runMemoryMerge(options), "");

  const runsDir = join(handle.directory, ".merge-runs");
  const runNames = (await readdir(runsDir)).filter((name) => name.startsWith("merge-"));
  assert.equal(runNames.length, 1);
  const runDir = join(runsDir, runNames[0]!);
  const status = await waitForStatus(runDir, (state) => ["completed", "failed"].includes(String(state.state)));
  assert.equal(status.state, "completed", JSON.stringify(status) + "\n" + await readFile(join(runDir, "supervisor.log"), "utf8"));
  assert.equal(status.archivedCount, 1);
  assert.equal(status.deferredCount, 0);

  // Merged note and updated index live in primary store; global store was never created.
  assert.match((await readMemoryNote(handle, "topics/merged.md"))?.content ?? "", /WORKTREE_SYNTHETIC_LESSON/);
  assert.match((await readMemoryNote(handle, "MEMORY.md"))?.content ?? "", /topics\/merged\.md/);
  assert.deepEqual((await readdir(root)).filter((name) => !name.endsWith(".lock")), [basename(handle.directory)]);

  // Legacy store was atomically archived into `<primary>/.merged-legacy/` with original history & manifest intact.
  const archivedDirs = await readdir(join(handle.directory, ".merged-legacy"));
  assert.equal(archivedDirs.length, 1);
  const archiveDir = join(handle.directory, ".merged-legacy", archivedDirs[0]!);
  assert.equal(await readFile(join(archiveDir, "lesson.md"), "utf8"), "# Worktree lesson\n\nWORKTREE_SYNTHETIC_LESSON\n");
  assert.equal(await readFile(join(archiveDir, ".history", "lesson.md", "snap.md"), "utf8"), "# Older snapshot\n");
  const manifest = JSON.parse(await readFile(join(archiveDir, ".merge-manifest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(manifest.mode, "llm");
  assert.equal(manifest.noteCount, 1);
  assert.deepEqual(manifest.notePaths, ["lesson.md"]);

  // Active note listing excludes hidden `.merged-legacy/` completely.
  assert.deepEqual((await listMemoryNotes(handle)).map((note) => note.path), ["MEMORY.md", "topics/merged.md"]);
  // Unprocessed schedule message from legacy store was folded into primary.
  assert.equal((await readMemorySchedule(handle)).pendingTurns, 1);
  // Merge lease is released.
  assert.equal(await hasActiveMemoryMerge(handle), false);

  // Status watcher emits dedicated merge completion notification.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(notifications.some((n) => n.state === "completed" && /Memory store merge completed/.test(n.message)));
});

test("extension triggers special store-merge task on first settled turn and respects --pi-memory-no-dream", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const agentDir = join(directory, "agent");
  const repo = await createGitRepo(directory, "repo", "https://github.com/org/ext-merge.git");
  const wt = await createLinkedWorktree(repo, join(directory, "repo-wt"), "repo-wt");

  const resolved = await resolveMemoryProjectHandle(root, wt, { sshConfigPath: "", localMapPath: defaultLocalMemoryMapPath(agentDir) });
  await writeMemoryNote(resolved.handle, { path: "MEMORY.md", content: "# Primary\n", expectedHash: null });

  const wtLegacy = join(root, legacyProjectDirectoryName(wt));
  await mkdir(wtLegacy, { recursive: true });
  await writeFile(join(wtLegacy, ".identity.json"), JSON.stringify({ identity: wt, scope: "project" }) + "\n");
  await writeFile(join(wtLegacy, "wt-note.md"), "# Worktree note\n");

  testEnvironment(ctx, { PI_MEMORY_DIR: root, PI_CODING_AGENT_DIR: agentDir });

  const setupHarness = (noDream: boolean) => {
    const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown)[]>();
    const notices: { message: string; type: string }[] = [];
    const mergeCalls: MemoryMergeOptions[] = [];
    const dreamCalls: unknown[] = [];
    const sessionManager = SessionManager.inMemory(wt);
    const pi = {
      registerTool() {},
      registerFlag() {},
      registerCommand() {},
      getFlag: (name: string) => name === "pi-memory-no-dream" ? noDream : false,
      getThinkingLevel: () => "off",
      sendUserMessage() {},
      on(name: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
        const list = handlers.get(name) ?? [];
        list.push(fn);
        handlers.set(name, list);
      },
    } as unknown as ExtensionAPI;
    const extCtx = {
      cwd: wt,
      hasUI: true,
      isProjectTrusted: () => true,
      model: { provider: "mock", id: "model" },
      sessionManager,
      ui: { notify: (message: string, type = "info") => { notices.push({ message, type }); } },
    } as unknown as ExtensionContext;
    piMemoryExtension(
      pi,
      async (opts) => { dreamCalls.push(opts); return ""; },
      undefined,
      async (opts) => { mergeCalls.push(opts); return "Memory store merge launched independently (supervisor PID 999)"; },
    );
    const emit = async (name: string, event: unknown) => {
      for (const fn of handlers.get(name) ?? []) await fn(event, extCtx);
    };
    return { sessionManager, notices, mergeCalls, dreamCalls, emit };
  };

  // 1. With --pi-memory-no-dream: read-only session_start does nothing; first settled turn warns once without launching merge.
  const disabled = setupHarness(true);
  await disabled.emit("session_start", {});
  assert.equal(disabled.mergeCalls.length, 0);
  disabled.sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  await disabled.emit("agent_settled", { aborted: false });
  assert.equal(disabled.mergeCalls.length, 0);
  assert.ok(disabled.notices.some((n) => /--pi-memory-no-dream/.test(n.message)));
  await disabled.emit("session_shutdown", { reason: "quit" });

  // 2. Normal mode: first settled turn immediately launches the special merge task (NOT waiting for 50 messages or dreaming!).
  const enabled = setupHarness(false);
  await enabled.emit("session_start", {});
  assert.equal(enabled.mergeCalls.length, 0, "Read-only session_start never launches merge");
  enabled.sessionManager.appendMessage({ role: "user", content: "first turn", timestamp: 2 });
  await enabled.emit("agent_settled", { aborted: false });
  assert.equal(enabled.dreamCalls.length, 0, "Regular dreaming does not launch on turn 1");
  assert.equal(enabled.mergeCalls.length, 1, "Special merge task launches on turn 1");
  assert.equal(enabled.mergeCalls[0]?.sources.length, 1);
  assert.equal(enabled.mergeCalls[0]?.sources[0]?.directory, wtLegacy);
  assert.equal((await resolveMemoryProjectDetails(wt, { sshConfigPath: "" })).identity, resolved.project.identity);
  await enabled.emit("session_shutdown", { reason: "quit" });
});

test("finishMemoryMerge defers a corrupt source without skipping healthy siblings or leaking the merge lease", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const repo = await createGitRepo(directory, "repo", "https://github.com/org/partial-error.git");
  const wtBad = await createLinkedWorktree(repo, join(directory, "wt-bad"), "wt-bad");
  const wtGood = await createLinkedWorktree(repo, join(directory, "wt-good"), "wt-good");

  const { handle, project } = await resolveMemoryProjectHandle(root, repo, { sshConfigPath: "" });
  await writeMemoryNote(handle, { path: "MEMORY.md", content: "# Primary\n", expectedHash: null });

  const badDir = join(root, legacyProjectDirectoryName(wtBad));
  const goodDir = join(root, legacyProjectDirectoryName(wtGood));
  for (const [dir, id, note] of [[badDir, wtBad, "# Bad\n"], [goodDir, wtGood, "# Good\n"]] as const) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".identity.json"), JSON.stringify({ identity: id, scope: "project" }) + "\n");
    await writeFile(join(dir, "note.md"), note);
  }
  // Seed multiple unprocessed v2 messages in the healthy legacy store to exercise batch schedule folding.
  const goodHandle = createMemoryStoreHandle(root, wtGood, "project");
  await writeFile(join(goodDir, ".dream-state.json"), JSON.stringify({
    version: 2,
    observedTurns: 3,
    processedTurns: 1,
    messages: [
      { sessionId: "s-old", entryId: "e-0" },
      { sessionId: "s-old", entryId: "e-1" },
      { sessionId: "s-old", entryId: "e-2" },
    ],
    legacy: null,
    claim: null,
  }) + "\n");
  assert.ok(goodHandle.directory);

  const prepared = await prepareMemoryMerge(root, project, handle, { sshConfigPath: "" });
  assert.equal(prepared.kind, "needs_merge");
  const claim = await claimMemoryMerge(handle, { ownerId: "worker-err", sources: prepared.sources });
  assert.ok(claim);

  // Corrupt the first source's .identity.json while the worker is running.
  await writeFile(join(badDir, ".identity.json"), "{corrupt json");

  const result = await finishMemoryMerge(handle, claim, { success: true });
  assert.equal(result.archived.length, 1, "Healthy sibling store is still archived");
  assert.equal(result.deferred.length, 1, "Corrupt source is deferred instead of aborting finalization");
  assert.equal(result.deferred[0]?.directory, badDir);
  assert.equal(result.deferred[0]?.reason, "error");
  assert.equal(await hasActiveMemoryMerge(handle), false, "Merge lease must be released despite per-source error");
  assert.equal((await readMemorySchedule(handle)).pendingTurns, 2, "Unprocessed v2 messages folded in one batch");
});

test("agent_settled promotes a sole sibling clone zero-LLM before enqueueing turn observations", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const agentDir = join(directory, "agent");
  const cloneA = await createGitRepo(directory, "clone-a", "https://github.com/org/zero-llm-settled.git");
  const cloneB = await createGitRepo(directory, "clone-b", "https://github.com/org/zero-llm-settled.git");

  // Only clone-a has an existing legacy store; primary store does not exist yet.
  const legacyA = join(root, legacyProjectDirectoryName(cloneA));
  await mkdir(legacyA, { recursive: true });
  await writeFile(join(legacyA, ".identity.json"), JSON.stringify({ identity: cloneA, scope: "project" }) + "\n");
  await writeFile(join(legacyA, "MEMORY.md"), "# Clone A memory\n");
  await writeFile(join(legacyA, "lesson.md"), "# Preserved without LLM\n");

  testEnvironment(ctx, { PI_MEMORY_DIR: root, PI_CODING_AGENT_DIR: agentDir });

  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown)[]>();
  const mergeCalls: MemoryMergeOptions[] = [];
  const sessionManager = SessionManager.inMemory(cloneB);
  const pi = {
    registerTool() {},
    registerFlag() {},
    registerCommand() {},
    getFlag: () => false,
    getThinkingLevel: () => "off",
    sendUserMessage() {},
    on(name: string, fn: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
  } as unknown as ExtensionAPI;
  const extCtx = {
    cwd: cloneB,
    hasUI: true,
    isProjectTrusted: () => true,
    model: { provider: "mock", id: "model" },
    sessionManager,
    ui: { notify() {} },
  } as unknown as ExtensionContext;
  piMemoryExtension(
    pi,
    async () => "",
    undefined,
    async (opts) => { mergeCalls.push(opts); return "unexpected"; },
  );
  const emit = async (name: string, event: unknown) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, extCtx);
  };

  await emit("session_start", {});
  sessionManager.appendMessage({ role: "user", content: "first turn in clone B", timestamp: 1 });
  await emit("agent_settled", { aborted: false });
  await emit("session_shutdown", { reason: "quit" });

  assert.equal(mergeCalls.length, 0, "Sole sibling clone must promote zero-LLM without launching a merge worker");
  const { handle } = await resolveMemoryProjectHandle(root, cloneB, { sshConfigPath: "" });
  assert.equal((await readMemoryNote(handle, "lesson.md"))?.content, "# Preserved without LLM\n");
  assert.equal((await readMemorySchedule(handle)).pendingTurns, 1, "Turn observation recorded into promoted primary store");
  await assert.rejects(stat(legacyA), /ENOENT/);
});

test("concurrent project dream and store-merge claims are mutually exclusive under the shared store lock", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const repo = await createGitRepo(directory, "repo", "https://github.com/org/mutex-race.git");
  const wt = await createLinkedWorktree(repo, join(directory, "repo-wt"), "repo-wt");

  const { handle, project } = await resolveMemoryProjectHandle(root, repo, { sshConfigPath: "" });
  await writeMemoryNote(handle, { path: "MEMORY.md", content: "# Primary\n", expectedHash: null });
  for (let i = 0; i < 50; i++) {
    await recordMemoryTurn(handle, { sessionId: "s-race", entryId: `u-${i}` });
  }
  const wtDir = join(root, legacyProjectDirectoryName(wt));
  await mkdir(wtDir, { recursive: true });
  await writeFile(join(wtDir, ".identity.json"), JSON.stringify({ identity: wt, scope: "project" }) + "\n");
  await writeFile(join(wtDir, "note.md"), "# Worktree\n");

  const prepared = await prepareMemoryMerge(root, project, handle, { sshConfigPath: "" });
  assert.equal(prepared.kind, "needs_merge");

  // Fire both claims concurrently; lock-protected checks guarantee at most one succeeds.
  const [dreamClaim, mergeClaim] = await Promise.all([
    claimMemoryDream(handle, { ownerId: "dream-racer" }),
    claimMemoryMerge(handle, { ownerId: "merge-racer", sources: prepared.sources }),
  ]);
  assert.equal(Number(Boolean(dreamClaim)) + Number(Boolean(mergeClaim)), 1);

  if (mergeClaim) {
    assert.equal(await claimMemoryDream(handle, { ownerId: "dream-after" }), null);
    await finishMemoryMerge(handle, mergeClaim, { success: false });
    assert.ok(await claimMemoryDream(handle, { ownerId: "dream-released" }));
  } else {
    assert.equal(await claimMemoryMerge(handle, { ownerId: "merge-after", sources: prepared.sources }), null);
    assert.equal(await markMemoryMergeLaunch(handle, prepared.sources), false);
  }
});
