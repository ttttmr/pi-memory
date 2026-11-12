import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import { watchMemoryDreamStatus, type MemoryDreamNotification } from "./memory-dream-notifications.ts";

for (const state of ["completed", "failed", "timed_out", "not_claimed"] as const) {
  test(`dream status observer catches an already ${state} worker and closes after one notification`, async (ctx) => {
    const directory = await createMemoryTestDirectory(ctx);
    await writeFile(join(directory, "status.json"), JSON.stringify({ state, error: "PRIVATE_ERROR_TEXT" }));
    const controller = new AbortController();
    ctx.after(() => controller.abort());
    const notification = await new Promise<MemoryDreamNotification>((resolve) => {
      watchMemoryDreamStatus(directory, Date.now() + 1000, resolve, controller.signal);
    });
    assert.equal(notification.state, state);
    assert.equal(notification.type, state === "failed" ? "error" : state === "timed_out" ? "warning" : "info");
    assert.ok(notification.message.includes(directory));
    assert.ok(!notification.message.includes("PRIVATE_ERROR_TEXT"));
  });
}

test("dream status observer follows atomic replacements, deduplicates running and stops at terminal status", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const controller = new AbortController();
  ctx.after(() => controller.abort());
  const notices: MemoryDreamNotification[] = [];
  let next: (() => void) | undefined;
  await writeFile(join(directory, "status.json"), JSON.stringify({ state: "launching" }));
  watchMemoryDreamStatus(directory, Date.now() + 1000, (notice) => { notices.push(notice); next?.(); }, controller.signal);
  const replace = async (state: string) => {
    await writeFile(join(directory, "temporary"), JSON.stringify({ state }));
    await rename(join(directory, "temporary"), join(directory, "status.json"));
  };
  const waitForNotice = () => new Promise<void>((resolve) => { next = resolve; });
  const running = waitForNotice();
  await replace("running");
  await running;
  await replace("running");
  const completed = waitForNotice();
  await replace("completed");
  await completed;
  await replace("failed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notices.map((notice) => notice.state), ["running", "completed"]);
});

test("missing terminal status reports unknown rather than inventing completion or timeout", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  await writeFile(join(directory, "status.json"), JSON.stringify({ state: "starting" }));
  const controller = new AbortController();
  ctx.after(() => controller.abort());
  // A short referenced test timer allows the unreferenced observer deadline to fire.
  const keepAlive = setTimeout(() => {}, 1000);
  ctx.after(() => clearTimeout(keepAlive));
  const notice = await new Promise<MemoryDreamNotification>((resolve) => {
    watchMemoryDreamStatus(directory, Date.now() - 10000, resolve, controller.signal);
  });
  assert.equal(notice.state, "unavailable");
  assert.equal(notice.type, "warning");
  assert.match(notice.message, /completion is unknown/);
});

test("aborting dream status observation does not change the worker's status", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const controller = new AbortController();
  await writeFile(join(directory, "status.json"), JSON.stringify({ state: "completed" }));
  const notices: MemoryDreamNotification[] = [];
  watchMemoryDreamStatus(directory, Date.now() + 1000, (notice) => notices.push(notice), controller.signal);
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notices, []);
});
