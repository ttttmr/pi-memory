import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import {
  claimMemoryDream, finishMemoryDream, hasActiveMemoryDream, readMemorySchedule, recordMemoryTurn,
} from "./memory-schedule.ts";
import {
  createMemoryStoreHandle, listMemoryNotes, readMemoryNote, resolveMemoryProject, writeMemoryNote,
  type MemoryStoreHandle,
} from "./memory-store.ts";

async function recordFixtureTurns(handle: MemoryStoreHandle, count = 50, sessionId = "fixture-session") {
  for (let index = 0; index < count; index++) {
    await recordMemoryTurn(handle, { sessionId, entryId: `leaf-${index}` });
  }
}

function schedulePath(handle: MemoryStoreHandle): string { return join(handle.directory, ".dream-state.json"); }

async function runScheduleProcess(program: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { errors += data; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(errors || output)));
  });
}

test("read-only missing schedule never creates storage; fifty user messages persist across handles and sessions without notes", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const handle = createMemoryStoreHandle(root, "/fixture-project", "project");
  assert.deepEqual(await readMemorySchedule(handle), { observedTurns: 0, processedTurns: 0, pendingTurns: 0, due: false });
  assert.deepEqual(await readdir(directory), []);
  await recordFixtureTurns(handle, 25, "session-a");
  const restored = createMemoryStoreHandle(root, "/fixture-project", "project");
  await recordFixtureTurns(restored, 25, "session-b");
  assert.deepEqual(await readMemorySchedule(handle), { observedTurns: 50, processedTurns: 0, pendingTurns: 50, due: true });
  assert.deepEqual(await listMemoryNotes(handle), []);
  assert.deepEqual((await readdir(handle.directory)).sort(), [".dream-state.json", ".identity.json"]);
  assert.equal((await stat(schedulePath(handle))).mode & 0o777, 0o600);
  await assert.rejects(readMemoryNote(handle, ".dream-state.json"), /Memory path/);
  const moduleUrl = new URL("./memory-schedule.ts", import.meta.url).href;
  const output = await runScheduleProcess(`import {readMemorySchedule} from ${JSON.stringify(moduleUrl)};
    console.log(JSON.stringify(await readMemorySchedule(${JSON.stringify(restored)})));`);
  assert.equal(JSON.parse(output).pendingTurns, 50);
});

test("replayed user messages are durably deduplicated across sessions, branches and processed batches", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/fixture-project", "project");
  await recordFixtureTurns(handle, 1, "a");
  await recordFixtureTurns(handle, 1, "b");
  const restored = createMemoryStoreHandle(root, "/fixture-project", "project");
  assert.equal((await recordMemoryTurn(restored, { sessionId: "a", entryId: "leaf-0" })).observedTurns, 2);
  assert.equal((await recordMemoryTurn(restored, { sessionId: "a", entryId: "leaf-1" })).observedTurns, 3);
  assert.equal((await recordMemoryTurn(restored, { sessionId: "b", entryId: "leaf-0" })).observedTurns, 3);
  assert.equal((await recordMemoryTurn(restored, { sessionId: "a", entryId: "leaf-0" })).observedTurns, 3);
  await recordFixtureTurns(handle, 50, "fill");
  const claim = await claimMemoryDream(handle, { ownerId: "runner" });
  assert.ok(claim);
  await finishMemoryDream(handle, claim, { success: true });
  assert.equal((await recordMemoryTurn(restored, { sessionId: "a", entryId: "leaf-0" })).pendingTurns, 0);
});

test("active dream lookup is read-only for missing, live, expired and released current leases", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const directory = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(join(directory, "memory"), "/fixture-project", "project");
  assert.equal(await hasActiveMemoryDream(handle), false);
  assert.deepEqual(await readdir(directory), []);
  await recordFixtureTurns(handle);
  assert.equal(await hasActiveMemoryDream(handle), false);
  const claim = await claimMemoryDream(handle, { ownerId: "runner" });
  assert.ok(claim);
  const before = await readFile(schedulePath(handle), "utf8");
  assert.equal(await hasActiveMemoryDream(handle), true);
  assert.equal((await readMemorySchedule(handle)).due, true, "Due work and a live lease are independent facts");
  ctx.mock.timers.tick(1_829_999);
  assert.equal(await hasActiveMemoryDream(handle), true);
  ctx.mock.timers.tick(1);
  assert.equal(await hasActiveMemoryDream(handle), false);
  assert.equal(await readFile(schedulePath(handle), "utf8"), before, "Expired lease lookup never rewrites work");
  const replacement = await claimMemoryDream(handle, { ownerId: "next" });
  assert.ok(replacement);
  assert.equal(await hasActiveMemoryDream(handle), true);
  await finishMemoryDream(handle, replacement, { success: false });
  assert.equal(await hasActiveMemoryDream(handle), false);
  await assert.rejects(hasActiveMemoryDream({ ...handle, scope: "global" }), /only for project/);
});

test("active dream lookup respects both raw and migrated legacy leases without writing state", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle, 1);
  const legacy = { observedTurns: 8, processedTurns: 0, sessions: [{ sessionId: "old", entryId: "leaf" }],
    claim: { ownerId: "old-runner", token: "00000000-0000-4000-8000-000000000000", generation: 8, expiresAt: 1_330_000 } };
  const raw = JSON.stringify(legacy);
  await writeFile(schedulePath(handle), raw);
  assert.equal(await hasActiveMemoryDream(handle), true);
  assert.equal(await readFile(schedulePath(handle), "utf8"), raw);
  await recordMemoryTurn(handle, { sessionId: "new", entryId: "user" });
  const migrated = await readFile(schedulePath(handle), "utf8");
  assert.equal(JSON.parse(migrated).version, 2);
  assert.equal(await hasActiveMemoryDream(handle), true);
  ctx.mock.timers.tick(330_000);
  assert.equal(await hasActiveMemoryDream(handle), false);
  assert.equal(await readFile(schedulePath(handle), "utf8"), migrated);
  await writeFile(schedulePath(handle), raw);
  assert.equal(await hasActiveMemoryDream(handle), false);
  assert.equal(await readFile(schedulePath(handle), "utf8"), raw);
  await writeFile(schedulePath(handle), "{invalid");
  await assert.rejects(hasActiveMemoryDream(handle));
  assert.equal(await readFile(schedulePath(handle), "utf8"), "{invalid");
});

test("automatic claims need fifty user messages; success acknowledges only its captured generation and sessions", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle, 49);
  assert.equal(await claimMemoryDream(handle, { ownerId: "runner" }), null);
  await recordMemoryTurn(handle, { sessionId: "fixture-session", entryId: "leaf-49", sessionFile: "/synthetic/session.jsonl" });
  const claim = await claimMemoryDream(handle, { ownerId: "runner" });
  assert.ok(claim);
  assert.equal(claim.generation, 50);
  assert.deepEqual(claim.sessions, [{ sessionId: "fixture-session", sessionFile: "/synthetic/session.jsonl" }]);
  await recordMemoryTurn(handle, { sessionId: "new-session", entryId: "new-leaf" });
  await finishMemoryDream(handle, claim, { success: true });
  assert.deepEqual(await readMemorySchedule(handle), { observedTurns: 51, processedTurns: 50, pendingTurns: 1, due: false });
  await recordFixtureTurns(handle, 49, "later-session");
  const next = await claimMemoryDream(handle, { ownerId: "runner" });
  assert.ok(next);
  assert.deepEqual(next.sessions, [{ sessionId: "new-session" }, { sessionId: "later-session" }]);
  await finishMemoryDream(handle, next, { success: true });
  assert.deepEqual(await readMemorySchedule(handle), { observedTurns: 100, processedTurns: 100, pendingTurns: 0, due: false });
  assert.equal((await readdir(handle.directory)).includes(".history"), false);
});

test("failure and cancellation retain all pending work; another runner never steals a current lease", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle);
  const claim = await claimMemoryDream(handle, { ownerId: "first" });
  assert.ok(claim);
  assert.equal(await claimMemoryDream(handle, { ownerId: "second" }), null);
  await finishMemoryDream(handle, claim, { success: false });
  assert.equal((await readMemorySchedule(handle)).pendingTurns, 50);
  const next = await claimMemoryDream(handle, { ownerId: "second" });
  assert.ok(next);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(finishMemoryDream(handle, next, { success: true }, controller.signal), { name: "AbortError" });
  assert.equal((await readMemorySchedule(handle)).pendingTurns, 50);
  await finishMemoryDream(handle, next, { success: false });
  const empty = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/empty-project", "project");
  assert.equal(await claimMemoryDream(empty, { ownerId: "runner" }), null);
  assert.equal((await readMemorySchedule(empty)).pendingTurns, 0);
});

test("queued turn records and concurrent same-process claims serialize on the note mutation queue", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await Promise.all(Array.from({ length: 50 }, (_, index) => recordMemoryTurn(handle, { sessionId: `session-${index}`, entryId: "leaf" })));
  const note = await withFileMutationQueue(handle.path, () => writeMemoryNote(handle, { path: "note.md", content: "fixture", expectedHash: null }));
  const claims = await Promise.all(["first", "second"].map((ownerId) => claimMemoryDream({ ...handle }, { ownerId })));
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await readMemoryNote(handle, "note.md"))?.hash, note.hash);
  assert.equal((await readMemorySchedule(handle)).observedTurns, 50);
});

test("competing process claims produce one owner, never duplicate work", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle);
  const moduleUrl = new URL("./memory-schedule.ts", import.meta.url).href;
  const results = await Promise.all(["first", "second"].map((ownerId) => runScheduleProcess(`
    import {claimMemoryDream} from ${JSON.stringify(moduleUrl)};
    try { console.log(JSON.stringify(await claimMemoryDream(${JSON.stringify(handle)}, {ownerId:${JSON.stringify(ownerId)}}))); }
    catch(error) { if (!error.message.includes("Memory store locked")) throw error; console.log("null"); }
  `)));
  const claims = results.map((output) => JSON.parse(output));
  assert.equal(claims.filter(Boolean).length, 1);
  await finishMemoryDream(handle, claims.find(Boolean), { success: true });
  assert.equal((await readMemorySchedule(handle)).pendingTurns, 0);
});

test("expired logical lease recovers using fake time, but never steals a filesystem lock", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle);
  const original = await claimMemoryDream(handle, { ownerId: "old" });
  assert.ok(original);
  assert.equal(original.expiresAt, 2_830_000);
  ctx.mock.timers.tick(1_800_000);
  assert.equal(await claimMemoryDream(handle, { ownerId: "new" }), null, "Lease covers the entire thirty-minute worker timeout");
  ctx.mock.timers.tick(29_999);
  assert.equal(await claimMemoryDream(handle, { ownerId: "new" }), null);
  ctx.mock.timers.tick(1);
  await mkdir(`${handle.directory}.lock`);
  await assert.rejects(claimMemoryDream(handle, { ownerId: "new" }), /Memory store locked/);
  assert.deepEqual(await readdir(`${handle.directory}.lock`), []);
  await rmdir(`${handle.directory}.lock`);
  const replacement = await claimMemoryDream(handle, { ownerId: "new" });
  assert.ok(replacement);
  assert.notEqual(replacement.token, original.token);
  const before = await readFile(schedulePath(handle), "utf8");
  await assert.rejects(finishMemoryDream(handle, original, { success: true }), /ownership mismatch/);
  assert.equal(await readFile(schedulePath(handle), "utf8"), before);
  await finishMemoryDream(handle, replacement, { success: true });
  await assert.rejects(finishMemoryDream(handle, original, { success: true }), /ownership mismatch/);
  assert.equal((await readMemorySchedule(handle)).processedTurns, 50);
});

test("claim owner, token, generation and expiry must all match before acknowledging work", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle);
  const claim = await claimMemoryDream(handle, { ownerId: "runner" });
  assert.ok(claim);
  const before = await readFile(schedulePath(handle), "utf8");
  for (const forged of [{ ...claim, ownerId: "other" }, { ...claim, token: "00000000-0000-4000-8000-000000000000" },
    { ...claim, generation: 49 }, { ...claim, expiresAt: claim.expiresAt + 1 }]) {
    await assert.rejects(finishMemoryDream(handle, forged, { success: true }), /ownership mismatch/);
    assert.equal(await readFile(schedulePath(handle), "utf8"), before);
  }
  await finishMemoryDream(handle, claim, { success: false });
});

test("corrupt JSON, unknown state fields and invalid counters fail closed without resetting evidence", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle, 1);
  const valid = JSON.parse(await readFile(schedulePath(handle), "utf8"));
  const corrupt = ["{invalid", "null", "[]", "{}", JSON.stringify({ ...valid, unexpected: true }),
    JSON.stringify({ ...valid, processedTurns: 2 }), JSON.stringify({ ...valid, observedTurns: -1 }),
    JSON.stringify({ ...valid, observedTurns: 1.5 }), JSON.stringify({ ...valid, claim: {} }),
    JSON.stringify({ ...valid, messages: [] }),
    JSON.stringify({ ...valid, messages: [...valid.messages, ...valid.messages] }),
    JSON.stringify({ ...valid, messages: [{ sessionId: "a", entryId: "b", unexpected: true }] })];
  for (const content of corrupt) {
    await writeFile(schedulePath(handle), content);
    await assert.rejects(readMemorySchedule(handle));
    await assert.rejects(recordMemoryTurn(handle, { sessionId: "next", entryId: "leaf" }));
    await assert.rejects(claimMemoryDream(handle, { ownerId: "runner" }));
    assert.equal(await readFile(schedulePath(handle), "utf8"), content);
  }
  await writeFile(schedulePath(handle), JSON.stringify(valid));
  const identity = join(handle.directory, ".identity.json");
  await writeFile(identity, JSON.stringify({ identity: "/other", scope: "project" }));
  await assert.rejects(readMemorySchedule(handle), /identity/);
  await assert.rejects(recordMemoryTurn(handle, { sessionId: "next", entryId: "leaf" }), /identity/);
  assert.equal(await readFile(schedulePath(handle), "utf8"), JSON.stringify(valid));
});

test("symlinked schedule, identity and directories are refused without touching their targets", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/fixture-project", "project");
  await recordFixtureTurns(handle, 1);
  const outside = join(root, "outside.json");
  await writeFile(outside, "fixture outside evidence");
  await unlink(schedulePath(handle));
  await symlink(outside, schedulePath(handle));
  await assert.rejects(readMemorySchedule(handle));
  await assert.rejects(recordMemoryTurn(handle, { sessionId: "next", entryId: "leaf" }));
  assert.equal(await readFile(outside, "utf8"), "fixture outside evidence");
  await unlink(schedulePath(handle));
  await unlink(join(handle.directory, ".identity.json"));
  await symlink(outside, join(handle.directory, ".identity.json"));
  await assert.rejects(readMemorySchedule(handle), /identity/);
  const linked = createMemoryStoreHandle(root, "/linked-project", "project");
  await symlink(handle.directory, linked.directory);
  await assert.rejects(readMemorySchedule(linked), /unsafe/);
  await assert.rejects(recordMemoryTurn(linked, { sessionId: "next", entryId: "leaf" }), /unsafe/);
  const rootAlias = join(root, "alias");
  await symlink(root, rootAlias);
  await assert.rejects(readMemorySchedule(createMemoryStoreHandle(rootAlias, "/project", "project")), /unsafe/);
});

test("session and metadata byte capacities reject explicitly without eviction or partial state updates", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle, 1);
  const full = { version: 2, observedTurns: 1000, processedTurns: 0,
    messages: Array.from({ length: 1000 }, (_, index) => ({ sessionId: `session-${index}`, entryId: "leaf" })), legacy: null, claim: null };
  await writeFile(schedulePath(handle), JSON.stringify(full));
  const before = await readFile(schedulePath(handle), "utf8");
  await assert.rejects(recordMemoryTurn(handle, { sessionId: "overflow", entryId: "leaf" }), /1000 sessions/);
  assert.equal(await readFile(schedulePath(handle), "utf8"), before);
  assert.equal((await recordMemoryTurn(handle, { sessionId: "session-0", entryId: "updated" })).observedTurns, 1001);
  const large = { version: 2, observedTurns: 150, processedTurns: 0, messages: Array.from({ length: 150 }, (_, index) =>
    ({ sessionId: `session-${index}-${"s".repeat(3400)}`, entryId: "e".repeat(3400) })), legacy: null, claim: null };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < 1024 * 1024);
  await writeFile(schedulePath(handle), JSON.stringify(large));
  const largeBefore = await readFile(schedulePath(handle), "utf8");
  // Add enough valid identifiers to cross the aggregate byte bound, not the per-identifier bound.
  let rejected = false;
  for (let index = 0; index < 5; index++) {
    const prior = await readFile(schedulePath(handle), "utf8");
    try { await recordMemoryTurn(handle, { sessionId: `${index}-${"s".repeat(4090)}`, entryId: "e".repeat(4096) }); }
    catch (error) {
      assert.match(String(error), /1 MiB/);
      assert.equal(await readFile(schedulePath(handle), "utf8"), prior);
      rejected = true;
      break;
    }
  }
  assert.ok(rejected);
  assert.ok(largeBefore.length > 1_000_000);
  await writeFile(schedulePath(handle), "x".repeat(1024 * 1024 + 1));
  await assert.rejects(readMemorySchedule(handle), /limit/);
});

test("invalid inputs and global handles never create storage; pre-aborted turns remain unobserved", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const handle = createMemoryStoreHandle(root, "/fixture-project", "project");
  for (const turn of [{ sessionId: "", entryId: "leaf" }, { sessionId: "session", entryId: "\uD800" },
    { sessionId: "s".repeat(4097), entryId: "leaf" }]) {
    await assert.rejects(recordMemoryTurn(handle, turn), /sessionId and entryId/);
  }
  await assert.rejects(claimMemoryDream(handle, { ownerId: "" }), /ownerId/);
  const global = createMemoryStoreHandle(root, "/fixture-project", "global");
  await assert.rejects(readMemorySchedule(global), /only for project/);
  await assert.rejects(recordMemoryTurn(global, { sessionId: "session", entryId: "leaf" }), /only for project/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(recordMemoryTurn(handle, { sessionId: "session", entryId: "leaf" }, controller.signal), { name: "AbortError" });
  assert.deepEqual(await readdir(directory), []);
});

test("legacy completed-turn work migrates explicitly without counting it as user messages or stealing its lease", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle, 1);
  const legacy = { observedTurns: 12, processedTurns: 8,
    sessions: [{ sessionId: "old-session", entryId: "assistant-leaf" }],
    claim: { ownerId: "old-runner", token: "00000000-0000-4000-8000-000000000000", generation: 12, expiresAt: 1_330_000 } };
  const original = JSON.stringify(legacy);
  await writeFile(schedulePath(handle), original);
  assert.deepEqual(await readMemorySchedule(handle), {
    observedTurns: 0, processedTurns: 0, pendingTurns: 0, due: true, legacyPendingTurns: 4,
  });
  assert.equal(await readFile(schedulePath(handle), "utf8"), original, "Read-only migration does not mutate storage");
  assert.equal(await claimMemoryDream(handle, { ownerId: "new-runner" }), null);
  await recordMemoryTurn(handle, { sessionId: "new-session", entryId: "user-1", sessionFile: "/synthetic/new.jsonl" });
  ctx.mock.timers.tick(330_000);
  const claim = await claimMemoryDream(handle, { ownerId: "new-runner" });
  assert.ok(claim);
  assert.equal(claim.generation, 1);
  assert.deepEqual(claim.sessions, [{ sessionId: "old-session" }, { sessionId: "new-session", sessionFile: "/synthetic/new.jsonl" }]);
  await finishMemoryDream(handle, claim, { success: false });
  assert.equal((await readMemorySchedule(handle)).legacyPendingTurns, 4);
  const retry = await claimMemoryDream(handle, { ownerId: "new-runner" });
  assert.ok(retry);
  await recordMemoryTurn(handle, { sessionId: "new-session", entryId: "user-2" });
  await finishMemoryDream(handle, retry, { success: true });
  assert.deepEqual(await readMemorySchedule(handle), { observedTurns: 2, processedTurns: 1, pendingTurns: 1, due: false });
  const persisted = JSON.parse(await readFile(schedulePath(handle), "utf8"));
  assert.equal(persisted.version, 2);
  assert.equal(persisted.legacy, null);
  assert.equal(persisted.messages.length, 2, "Processed user IDs remain available for durable deduplication");
});

test("fully processed legacy state is not due and corrupt legacy evidence is refused intact", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/fixture-project", "project");
  await recordFixtureTurns(handle, 1);
  const legacy = { observedTurns: 8, processedTurns: 8, sessions: [{ sessionId: "old", entryId: "leaf" }], claim: null };
  await writeFile(schedulePath(handle), JSON.stringify(legacy));
  assert.deepEqual(await readMemorySchedule(handle), { observedTurns: 0, processedTurns: 0, pendingTurns: 0, due: false });
  assert.equal(await claimMemoryDream(handle, { ownerId: "runner" }), null);
  for (const invalid of [{ ...legacy, processedTurns: 9 }, { ...legacy, sessions: [] },
    { ...legacy, claim: { ownerId: "old", token: "invalid", generation: 8, expiresAt: 0 } }]) {
    const content = JSON.stringify(invalid);
    await writeFile(schedulePath(handle), content);
    await assert.rejects(recordMemoryTurn(handle, { sessionId: "new", entryId: "user" }), /corrupt/);
    assert.equal(await readFile(schedulePath(handle), "utf8"), content);
  }
});

test("native worktree project resolution leaves the Git marker and project files untouched", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const worktree = join(directory, "fixture-worktree");
  await mkdir(join(worktree, "src"), { recursive: true });
  const marker = "gitdir: /synthetic/main/.git/worktrees/fixture\n";
  await writeFile(join(worktree, ".git"), marker);
  await writeFile(join(worktree, "src", "fixture.ts"), "// fixture\n");
  const project = await resolveMemoryProject(join(worktree, "src"));
  const handle = createMemoryStoreHandle(join(directory, "memory"), project, "project");
  await recordFixtureTurns(handle);
  assert.equal(project, worktree);
  assert.equal(await readFile(join(worktree, ".git"), "utf8"), marker);
  assert.equal(await readFile(join(worktree, "src", "fixture.ts"), "utf8"), "// fixture\n");
  assert.deepEqual((await readdir(worktree)).sort(), [".git", "src"]);
});
