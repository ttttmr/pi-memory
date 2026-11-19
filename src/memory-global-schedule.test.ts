import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createMemoryTestDirectory, memoryTestContent } from "../test/memory-fixtures.ts";
import {
  GLOBAL_DREAM_MAX_INTERVAL_MS, GLOBAL_DREAM_MIN_INTERVAL_MS, GLOBAL_DREAM_RETRY_MS,
  claimGlobalMemoryDream, finishGlobalMemoryDream, hasActiveGlobalMemoryDream, isGlobalMemoryDreamDue,
  markGlobalMemoryDreamLaunch,
} from "./memory-global-schedule.ts";
import { createMemoryStoreHandle, mutateMemoryScheduleData, writeMemoryNote } from "./memory-store.ts";

async function globalStore(ctx: Parameters<typeof createMemoryTestDirectory>[0], notes = 3) {
  const directory = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(join(directory, "memory"), "global", "global");
  for (let index = 0; index < notes; index++) {
    await writeMemoryNote(handle, { path: `tools/n${index}.md`, content: memoryTestContent, expectedHash: null });
  }
  return { directory, handle };
}

async function setLastCompleted(handle: ReturnType<typeof createMemoryStoreHandle>, at: number) {
  await mutateMemoryScheduleData(handle, (data) => ({ data: { ...(data as object), lastCompletedAt: at }, result: undefined }));
}

test("global schedule rejects project handles", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const project = createMemoryStoreHandle(join(directory, "memory"), join(directory, "project"), "project");
  await assert.rejects(isGlobalMemoryDreamDue(project), /only for global memory/);
});

test("the first global pass waits for enough notes", async (ctx) => {
  assert.equal(await isGlobalMemoryDreamDue((await globalStore(ctx, 2)).handle), false);
  assert.equal(await isGlobalMemoryDreamDue((await globalStore(ctx, 3)).handle), true);
});

test("a launch mark backs off other frontends until the retry window passes", async (ctx) => {
  const { handle } = await globalStore(ctx);
  const now = Date.now();
  assert.equal(await markGlobalMemoryDreamLaunch(handle, now), true);
  assert.equal(await markGlobalMemoryDreamLaunch(handle, now + 1000), false);
  assert.equal(await isGlobalMemoryDreamDue(handle, now + 1000), false);
  assert.equal(await isGlobalMemoryDreamDue(handle, now + GLOBAL_DREAM_RETRY_MS), true);
});

test("success records a fingerprint; later passes need a change and a week, or a month", async (ctx) => {
  const { handle } = await globalStore(ctx);
  const claim = await claimGlobalMemoryDream(handle, { ownerId: "global-worker" });
  assert.ok(claim);
  assert.equal(await hasActiveGlobalMemoryDream(handle), true);
  assert.equal(await claimGlobalMemoryDream(handle, { ownerId: "other" }), null, "A valid lease is not stolen");
  await finishGlobalMemoryDream(handle, claim, { success: true });
  assert.equal(await hasActiveGlobalMemoryDream(handle), false);
  const now = Date.now();
  assert.equal(await isGlobalMemoryDreamDue(handle, now), false, "Recently completed");
  assert.equal(await claimGlobalMemoryDream(handle, { ownerId: "again" }), null, "No second pass within a week");
  const weekAgo = now - GLOBAL_DREAM_MIN_INTERVAL_MS;
  await setLastCompleted(handle, weekAgo);
  assert.equal(await isGlobalMemoryDreamDue(handle, now), false, "Unchanged notes wait for the monthly recheck");
  await writeMemoryNote(handle, { path: "tools/new.md", content: memoryTestContent, expectedHash: null });
  assert.equal(await isGlobalMemoryDreamDue(handle, now), true, "Changed notes are due after a week");
  await setLastCompleted(handle, now - GLOBAL_DREAM_MAX_INTERVAL_MS);
  assert.equal(await isGlobalMemoryDreamDue(handle, now), true);
});

test("an expired global lease can be reclaimed while an active lease cannot", async (ctx) => {
  const { handle } = await globalStore(ctx);
  const first = await claimGlobalMemoryDream(handle, { ownerId: "worker-1" });
  assert.ok(first);
  assert.equal(await isGlobalMemoryDreamDue(handle), false);
  assert.equal(await claimGlobalMemoryDream(handle, { ownerId: "worker-2" }), null);
  await mutateMemoryScheduleData(handle, (data) => ({
    data: { ...(data as object), claim: { ...first, expiresAt: Date.now() - 1 } },
    result: undefined,
  }));
  assert.equal(await hasActiveGlobalMemoryDream(handle), false);
  assert.equal(await isGlobalMemoryDreamDue(handle), true);
  const second = await claimGlobalMemoryDream(handle, { ownerId: "worker-2" });
  assert.ok(second);
  assert.notEqual(second.token, first.token);
});

test("failure releases the lease without recording completion", async (ctx) => {
  const { handle } = await globalStore(ctx);
  const claim = await claimGlobalMemoryDream(handle, { ownerId: "global-worker" });
  assert.ok(claim);
  await finishGlobalMemoryDream(handle, claim, { success: false });
  assert.equal(await isGlobalMemoryDreamDue(handle), true);
  await assert.rejects(finishGlobalMemoryDream(handle, claim, { success: true }), /ownership mismatch/);
});

test("corrupt global state is not reset", async (ctx) => {
  const { handle } = await globalStore(ctx);
  await mutateMemoryScheduleData(handle, () => ({ data: { version: 1, kind: "global", extra: true }, result: undefined }));
  await assert.rejects(isGlobalMemoryDreamDue(handle), /corrupt/);
});
