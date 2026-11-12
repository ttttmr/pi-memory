import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { rmdirSync, type FSWatcher } from "node:fs";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import { createMemoryObservationQueue, type MemoryObservationTurn } from "./memory-observations.ts";
import { readMemorySchedule, recordMemoryTurn } from "./memory-schedule.ts";
import { createMemoryStoreHandle, type MemoryStoreHandle } from "./memory-store.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function holdStoreLock(handle: MemoryStoreHandle): Promise<string> {
  await mkdir(dirname(handle.directory), { recursive: true });
  const lockPath = `${handle.directory}.lock`;
  await mkdir(lockPath);
  return lockPath;
}

test("lock release records queued A, duplicate A, B in order and latest-leaf replay stays deduplicated", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/observed-project", "project");
  const lockPath = await holdStoreLock(handle);
  const recorded: MemoryObservationTurn[] = [];
  const finished = deferred();
  const queue = createMemoryObservationQueue({
    onRecorded(_handle, turn, _snapshot) {
      recorded.push(turn);
      if (turn.entryId === "leaf-b") finished.resolve();
    },
    onError(_handle, error) { finished.reject(error instanceof Error ? error : new Error(String(error))); },
  });
  ctx.after(() => queue.close());

  await queue.enqueue(handle, { sessionId: "session-a", entryId: "leaf-a" });
  await queue.enqueue(handle, { sessionId: "session-a", entryId: "leaf-a" });
  await queue.enqueue(handle, { sessionId: "session-a", entryId: "leaf-b" });
  assert.equal(recorded.length, 0);
  await rmdir(lockPath);
  await finished.promise;

  assert.deepEqual(recorded.map((turn) => turn.entryId), ["leaf-a", "leaf-b"]);
  assert.deepEqual(await readMemorySchedule(handle), { observedTurns: 2, processedTurns: 0, pendingTurns: 2, due: false });
  await queue.enqueue(handle, { sessionId: "session-a", entryId: "leaf-b" });
  assert.equal((await readMemorySchedule(handle)).observedTurns, 2);
  assert.equal(await queue.close(), 0);
});

test("queued observations preserve the original session file through deferred lock recovery", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/session-file-project", "project");
  const lockPath = await holdStoreLock(handle);
  const recorded: MemoryObservationTurn[] = [];
  const queue = createMemoryObservationQueue({
    onRecorded(_handle, turn) { recorded.push(turn); },
    onError(_handle, error) { throw error; },
  });
  ctx.after(() => queue.close());
  const original = { sessionId: "original-session", entryId: "user-message", sessionFile: "/synthetic/original.jsonl" };
  await queue.enqueue(handle, original);
  original.sessionFile = "/synthetic/replaced.jsonl";
  await rmdir(lockPath);
  await queue.flush();
  assert.deepEqual(recorded, [{ sessionId: "original-session", entryId: "user-message", sessionFile: "/synthetic/original.jsonl" }]);
  const state = JSON.parse(await readFile(join(handle.directory, ".dream-state.json"), "utf8"));
  assert.equal(state.messages[0].sessionFile, "/synthetic/original.jsonl");
});

test("different projects flush independently and close returns pending without waiting for a stale lock", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const locked = createMemoryStoreHandle(root, "/locked-project", "project");
  const available = createMemoryStoreHandle(root, "/available-project", "project");
  const lockPath = await holdStoreLock(locked);
  const recorded = deferred();
  const queue = createMemoryObservationQueue({
    onRecorded(handle) { if (handle.directory === available.directory) recorded.resolve(); },
    onError(_handle, error) { recorded.reject(error instanceof Error ? error : new Error(String(error))); },
  });

  await queue.enqueue(locked, { sessionId: "locked-session", entryId: "leaf-a" });
  await queue.enqueue(available, { sessionId: "available-session", entryId: "leaf-a" });
  await recorded.promise;
  assert.equal((await readMemorySchedule(available)).observedTurns, 1);
  assert.equal((await readMemorySchedule(locked)).observedTurns, 0);
  assert.equal(await queue.close(), 1);
  await queue.flush();
  assert.equal(await queue.close(), 1, "close is idempotent and closed flush does not retry pending writes");
  await assert.rejects(queue.enqueue(available, { sessionId: "later", entryId: "leaf" }), /queue is closed/);
  await rmdir(lockPath);
});

test("watch errors retain observations and a later explicit flush can recover", async (ctx) => {
  class SyntheticWatcher extends EventEmitter {
    closed = false;
    close() { this.closed = true; }
  }
  const watchers: SyntheticWatcher[] = [];
  const watchImplementation = ((_directory: string, _options: { persistent: boolean }, listener: (...args: unknown[]) => void) => {
    const watcher = new SyntheticWatcher();
    watcher.on("rename", listener);
    watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  }) as unknown as typeof import("node:fs").watch;
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/watch-project", "project");
  const lockPath = await holdStoreLock(handle);
  const errors: unknown[] = [];
  const recorded: MemoryObservationTurn[] = [];
  const queue = createMemoryObservationQueue({
    onRecorded(_handle, turn) { recorded.push(turn); },
    onError(_handle, error) { errors.push(error); },
  }, { watch: watchImplementation });

  await queue.enqueue(handle, { sessionId: "session-a", entryId: "leaf-a" });
  assert.equal(watchers.length, 1);
  watchers[0]!.emit("error", new Error("synthetic watcher failure"));
  assert.equal(watchers[0]!.closed, true);
  assert.equal(errors.length, 1);
  assert.equal(recorded.length, 0);

  await rmdir(lockPath);
  await queue.flush();
  assert.deepEqual(recorded.map((turn) => turn.entryId), ["leaf-a"]);
  assert.equal(await queue.close(), 0);
});

test("subscription retry closes the lost-wake window and uses a non-persistent watcher", async (ctx) => {
  class SyntheticWatcher extends EventEmitter {
    close() {}
  }
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/lost-wake-project", "project");
  const lockPath = await holdStoreLock(handle);
  let persistent: boolean | undefined;
  const recorded = deferred();
  const watchImplementation = ((_directory: string, options: { persistent: boolean }, listener: (...args: unknown[]) => void) => {
    persistent = options.persistent;
    const watcher = new SyntheticWatcher();
    watcher.on("rename", listener);
    rmdirSync(lockPath);
    return watcher as unknown as FSWatcher;
  }) as unknown as typeof import("node:fs").watch;
  const queue = createMemoryObservationQueue({
    onRecorded() { recorded.resolve(); },
    onError(_handle, error) { recorded.reject(error instanceof Error ? error : new Error(String(error))); },
  }, { watch: watchImplementation });

  await queue.enqueue(handle, { sessionId: "session-a", entryId: "leaf-a" });
  await recorded.promise;
  assert.equal(persistent, false);
  assert.equal(queue.pendingCount, 0);
  assert.equal((await readMemorySchedule(handle)).observedTurns, 1);
  assert.equal(await queue.close(), 0);
});

test("identity failures close an existing watcher and retain pending without event-driven retries", async (ctx) => {
  class SyntheticWatcher extends EventEmitter {
    close() {}
  }
  const watchers: SyntheticWatcher[] = [];
  const watchImplementation = ((_directory: string, _options: { persistent: boolean }, listener: (...args: unknown[]) => void) => {
    const watcher = new SyntheticWatcher();
    watcher.on("rename", listener);
    watchers.push(watcher);
    return watcher as unknown as FSWatcher;
  }) as unknown as typeof import("node:fs").watch;
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/corrupt-project", "project");
  await recordMemoryTurn(handle, { sessionId: "seed", entryId: "leaf-seed" });
  await writeFile(join(handle.directory, ".identity.json"), "{broken");
  const lockPath = await holdStoreLock(handle);
  const errors: unknown[] = [];
  const failed = deferred();
  const queue = createMemoryObservationQueue({
    onRecorded() { assert.fail("corrupt identity must not record"); },
    onError(_handle, error) { errors.push(error); failed.resolve(); },
  }, { watch: watchImplementation });

  await queue.enqueue(handle, { sessionId: "session-a", entryId: "leaf-a" });
  assert.equal(watchers.length, 1);
  await rmdir(lockPath);
  watchers[0]!.emit("rename", "rename", `${handle.directory.split("/").at(-1)}.lock`);
  await failed.promise;
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /identity/);
  watchers[0]!.emit("rename", "rename", null);
  watchers[0]!.emit("rename", "rename", null);
  await Promise.resolve();
  assert.equal(errors.length, 1, "non-lock failure stops watcher-driven retries");
  assert.equal(queue.pendingCount, 1);
  assert.equal(await queue.close(), 1);
  const schedule = JSON.parse(await readFile(join(handle.directory, ".dream-state.json"), "utf8"));
  assert.equal(schedule.observedTurns, 1);
});

function spawnObservationProcess(handle: MemoryStoreHandle, sessionId: string, holdLock: boolean) {
  const moduleUrl = new URL("./memory-observations.ts", import.meta.url).href;
  const turns = [{ sessionId, entryId: "leaf-a" }, { sessionId, entryId: "leaf-b" }];
  const program = `
    import {mkdir, rmdir} from "node:fs/promises";
    import {dirname} from "node:path";
    import {createMemoryObservationQueue} from ${JSON.stringify(moduleUrl)};
    const handle = ${JSON.stringify(handle)};
    const lockPath = handle.directory + ".lock";
    if (${holdLock}) {
      await mkdir(dirname(handle.directory), {recursive:true});
      await mkdir(lockPath);
    }
    const queue = createMemoryObservationQueue({
      onRecorded(_handle, turn) { process.send({type:"recorded", sessionId:turn.sessionId, entryId:turn.entryId}); },
      onError(_handle, error) { process.send({type:"observationError", message:String(error)}); },
    });
    for (const turn of ${JSON.stringify(turns)}) await queue.enqueue(handle, turn);
    process.send({type:"ready"});
    process.on("message", (message) => {
      void (async () => {
        if (message === "release") {
          if (${holdLock}) await rmdir(lockPath);
          await queue.flush();
          process.send({type:"released"});
        } else if (message === "close") {
          const pending = await queue.close();
          process.send({type:"closed", pending}, () => process.exit(0));
        }
      })().catch((error) => { process.send({type:"observationError", message:String(error)}); });
    });
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout!.on("data", (data) => { output += data; });
  child.stderr!.on("data", (data) => { output += data; });
  return { child, output: () => output };
}

function waitForProcessMessage(child: ChildProcess, type: string, output: () => string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onMessage = (value: unknown) => {
      if (typeof value !== "object" || value === null || !("type" in value) || value.type !== type) return;
      cleanup();
      resolve(value as Record<string, unknown>);
    };
    const onExit = (code: number | null) => { cleanup(); reject(new Error(`Observation process exited ${code}: ${output()}`)); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

test("real competing processes eventually record every queued turn without duplicate leaves", { timeout: 10_000 }, async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/process-project", "project");
  const first = spawnObservationProcess(handle, "process-a", true);
  ctx.after(() => { first.child.kill(); });
  const allRecorded = deferred();
  const seen = new Set<string>();
  const onMessage = (value: unknown) => {
    if (typeof value !== "object" || value === null || !("type" in value)) return;
    if (value.type === "observationError") {
      allRecorded.reject(new Error(String("message" in value ? value.message : value)));
      return;
    }
    if (value.type !== "recorded" || !("sessionId" in value) || !("entryId" in value)) return;
    seen.add(`${String(value.sessionId)}:${String(value.entryId)}`);
    if (seen.size === 4) allRecorded.resolve();
  };
  first.child.on("message", onMessage);
  await waitForProcessMessage(first.child, "ready", first.output);
  const second = spawnObservationProcess(handle, "process-b", false);
  ctx.after(() => { second.child.kill(); });
  second.child.on("message", onMessage);
  await waitForProcessMessage(second.child, "ready", second.output);
  first.child.send("release");
  await allRecorded.promise;

  const firstClosed = waitForProcessMessage(first.child, "closed", first.output);
  const secondClosed = waitForProcessMessage(second.child, "closed", second.output);
  const exits = Promise.all([once(first.child, "exit"), once(second.child, "exit")]);
  first.child.send("close");
  second.child.send("close");
  assert.deepEqual((await Promise.all([firstClosed, secondClosed])).map((message) => message.pending), [0, 0]);
  await exits;
  const snapshot = await readMemorySchedule(handle);
  assert.equal(snapshot.observedTurns, 4);
  assert.equal(snapshot.pendingTurns, 4);
  assert.equal(seen.size, 4);
});
