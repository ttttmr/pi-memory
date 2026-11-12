import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import { runMemoryDream, MEMORY_DREAM_TIMEOUT_MS, type MemoryDreamOptions } from "./memory-dream.ts";
import { buildMemoryDreamPrompt } from "./memory-dream-worker.ts";
import { claimMemoryDream, readMemorySchedule, recordMemoryTurn } from "./memory-schedule.ts";
import { createMemoryStoreHandle, readMemoryNote } from "./memory-store.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

async function harness(ctx: TestContext, count = 50) {
  const directory = await createMemoryTestDirectory(ctx);
  const project = join(directory, "project");
  await mkdir(project);
  const source = join(directory, "source.jsonl");
  await writeFile(source, JSON.stringify({ type: "session", version: 3, id: "synthetic-source-session", cwd: project }) + "\n" +
    JSON.stringify({ id: "user-0", type: "message", message: { role: "user", content: "SYNTHETIC_VERIFIED_FEEDBACK" } }) + "\n");
  const options: MemoryDreamOptions = {
    handle: createMemoryStoreHandle(join(directory, "memory"), project, "project"),
    model: { provider: "memory-dream-test", id: "scripted" }, agentDir: join(directory, "agent"),
    sessionRoots: [directory], thinkingLevel: "off",
  };
  for (let index = 0; index < count; index++) {
    await recordMemoryTurn(options.handle, { sessionId: "synthetic-source-session", entryId: `user-${index}`, sessionFile: source });
  }
  return { directory, options, source };
}

async function runDirectory(options: MemoryDreamOptions) {
  const root = join(options.handle.directory, ".dream-runs");
  const names = await readdir(root);
  assert.equal(names.length, 1);
  return join(root, names[0]);
}

function waitForStatus(directory: string, predicate: (state: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { watcher.close(); reject(new Error(`Dream status wait expired: ${directory}`)); }, 20000);
    const watcher = watch(directory, () => { void inspect(); });
    watcher.on("error", reject);
    async function inspect() {
      try {
        const status = JSON.parse(await readFile(join(directory, "status.json"), "utf8"));
        if (predicate(status)) { clearTimeout(timer); watcher.close(); resolve(status); }
      } catch { /* A write event may arrive while JSON is being replaced. The next event retries. */ }
    }
    void inspect();
  });
}

function cleanupSupervisor(ctx: TestContext, receipt: string) {
  const pid = Number(receipt.match(/supervisor PID (\d+)/)?.[1]);
  assert.ok(pid > 0);
  ctx.after(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* The independent run may already have exited. */ } });
}

function testEnvironment(ctx: TestContext, values: Record<string, string>) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  ctx.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test("dream prompt supplies session IDs, normal tools and an explicit 30-minute deadline without request/tool quotas", async (ctx) => {
  const h = await harness(ctx, 0);
  assert.equal(MEMORY_DREAM_TIMEOUT_MS, 1800000);
  const prompt = buildMemoryDreamPrompt({ ...h.options, runDirectory: "/synthetic-run", deadline: 1800000 },
    [{ sessionId: "synthetic-source-session", sessionFile: h.source }]);
  assert.match(prompt, /1970-01-01T00:30:00.000Z/);
  assert.match(prompt, /complete relevant sessions/);
  assert.match(prompt, /no dreaming-specific model-request or tool-call quota/);
  assert.match(prompt, /untrusted evidence/);
  assert.match(prompt, /memory_search\/read\/write/);
  assert.ok(!prompt.includes("SYNTHETIC_VERIFIED_FEEDBACK"), "The program supplies source locations, not evidence excerpts");
  assert.equal(await runMemoryDream(h.options), "");
});

test("dream refuses a symlinked run directory and never starts a child", async (ctx) => {
  const h = await harness(ctx);
  const other = join(h.directory, "other");
  await mkdir(other);
  await symlink(other, join(h.options.handle.directory, ".dream-runs"));
  await assert.rejects(runMemoryDream(h.options), /run directory is unsafe/);
  assert.deepEqual(await readdir(other), []);
});

test("detached supervisor enforces its own deadline even when a worker ignores graceful shutdown", { timeout: 10000 }, async (ctx) => {
  const h = await harness(ctx);
  const fakeCli = join(h.directory, "hung-worker.cjs");
  await writeFile(fakeCli, 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  let exited!: Promise<NodeJS.Signals | null>;
  let notifyTimeout!: (state: string) => void;
  const timeoutNotification = new Promise<string>((resolve) => { notifyTimeout = resolve; });
  const controller = new AbortController();
  ctx.after(() => controller.abort());
  const receipt = await runMemoryDream(h.options, { cliPath: fakeCli, timeoutMs: 500, killGraceMs: 50,
    statusSignal: controller.signal, onStatus: (notification) => notifyTimeout(notification.state),
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      exited = new Promise((resolve) => { child.once("exit", (_code, signal) => resolve(signal)); });
      return child;
    },
  });
  cleanupSupervisor(ctx, receipt);
  const directory = await runDirectory(h.options);
  const status = await waitForStatus(directory, (state) => state.state === "timed_out");
  assert.match(String(status.error), /wall-clock deadline/);
  assert.equal(await timeoutNotification, "timed_out");
  assert.equal(await exited, "SIGKILL", "The independent supervisor actually enforces its hard-kill grace");
  assert.equal(JSON.parse(await readFile(join(directory, "status.json"), "utf8")).state, "timed_out");
  assert.equal((await readMemorySchedule(h.options.handle)).pendingTurns, 50);
});

for (const workerShutdown of ["exits", "ignores"] as const) {
  test(`detached supervisor kills captured tool descendants when the worker ${workerShutdown} on SIGTERM`, { timeout: 10000 }, async (ctx) => {
    const h = await harness(ctx);
    const fakeCli = join(h.directory, "detached-tool-worker.cjs");
    const toolPidPath = join(h.directory, "tool.pid");
    await writeFile(fakeCli, `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const tool = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
writeFileSync(${JSON.stringify(toolPidPath)}, String(tool.pid));
process.on("SIGTERM", () => { ${workerShutdown === "exits" ? "process.exit(0);" : ""} });
setInterval(() => {}, 1000);`);
    // A separate process outside the supervisor tree must never be targeted.
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { unrelated.once("spawn", resolve); unrelated.once("error", reject); });
    ctx.after(() => { try { process.kill(-unrelated.pid!, "SIGKILL"); } catch { /* Synthetic unrelated process already exited. */ } });
    let supervisor!: ReturnType<typeof spawn>;
    let exited!: Promise<void>;
    ctx.after(async () => {
      try { process.kill(-Number(await readFile(toolPidPath, "utf8")), "SIGKILL"); } catch { /* Synthetic tool already stopped. */ }
    });
    const receipt = await runMemoryDream(h.options, { cliPath: fakeCli, timeoutMs: 1000, killGraceMs: 100,
      spawn(command, args, options) {
        supervisor = spawn(command, args, options);
        exited = new Promise((resolve) => { supervisor.once("exit", () => resolve()); });
        return supervisor;
      },
    });
    supervisor.ref();
    cleanupSupervisor(ctx, receipt);
    await exited;
    const toolPid = Number(await readFile(toolPidPath, "utf8"));
    const state = spawnSync("/bin/ps", ["-p", String(toolPid), "-o", "stat="], { encoding: "utf8" });
    assert.ok(!state.error && (state.status === 0 || state.status === 1), "The process-state probe must run");
    // A reparented zombie is dead but may await its new parent's reap, especially in containers.
    assert.match(state.stdout.trim(), /^(Z.*)?$/, "Detached tools must not survive the hard deadline, even after reparenting");
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0), "Unrelated process identities must remain untouched");
    assert.equal(JSON.parse(await readFile(join(await runDirectory(h.options), "status.json"), "utf8")).state, "timed_out");
  });
}

test("detached dream continues after its launching foreground process exits", { timeout: 10000 }, async (ctx) => {
  const h = await harness(ctx);
  const fakeCli = join(h.directory, "independent-worker.cjs");
  await writeFile(fakeCli, `const fs = require("node:fs"); const path = require("node:path");
const config = JSON.parse(process.env.PI_MEMORY_DREAM_CONFIG);
setTimeout(() => { let foregroundGone = false; try { process.kill(Number(process.env.PI_MEMORY_TEST_PARENT_PID), 0); } catch { foregroundGone = true; }
fs.writeFileSync(path.join(config.runDirectory,"status.json"), JSON.stringify({state:"completed",foregroundGone})); }, 300);`);
  const launcher = fileURLToPath(new URL("./memory-dream.ts", import.meta.url));
  const parent = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `import { runMemoryDream } from ${JSON.stringify(launcher)}; process.env.PI_MEMORY_TEST_PARENT_PID = String(process.pid); console.log(await runMemoryDream(${JSON.stringify(h.options)}, { cliPath: ${JSON.stringify(fakeCli)} }));`],
  { cwd: h.options.handle.identity, encoding: "utf8", timeout: 5000 });
  assert.equal(parent.status, 0, parent.stderr);
  assert.match(parent.stdout, /not a completion receipt/);
  cleanupSupervisor(ctx, parent.stdout);
  const status = await waitForStatus(await runDirectory(h.options), (state) => state.state === "completed");
  assert.equal(status.foregroundGone, true);
});

test("real isolated Pi dream reads raw synthetic sessions with normal tools and exceeds former request/tool budgets offline", { timeout: 25000 }, async (ctx) => {
  const h = await harness(ctx);
  const trace = join(h.directory, "trace.jsonl");
  const original = await readFile(h.source, "utf8");
  testEnvironment(ctx, { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", JITI_FS_CACHE: "false",
    PI_MEMORY_TEST_TRACE: trace, PI_MEMORY_TEST_SOURCE: h.source });
  const observedStates: string[] = [];
  let terminal!: (state: string) => void;
  const terminalNotice = new Promise<string>((resolve) => { terminal = resolve; });
  const controller = new AbortController();
  ctx.after(() => controller.abort());
  const receipt = await runMemoryDream(h.options, { cliPath,
    statusSignal: controller.signal, onStatus(notification) {
      observedStates.push(notification.state);
      if (notification.state !== "running") terminal(notification.state);
    }, cliArgs: ["--offline", "--approve", "--no-extensions", "--no-mcp", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--no-session", "-e", join(packageRoot, "test/memory-dream-provider.ts")] });
  cleanupSupervisor(ctx, receipt);
  const directory = await runDirectory(h.options);
  const status = await waitForStatus(directory, (state) => ["completed", "failed"].includes(String(state.state)));
  assert.equal(status.state, "completed", JSON.stringify(status) + "\n" + await readFile(join(directory, "supervisor.log"), "utf8") + "\n" + (await readFile(join(directory, "events.jsonl"), "utf8")).slice(-16000));
  assert.equal(await terminalNotice, "completed");
  assert.equal(observedStates.at(-1), "completed");
  assert.equal(new Set(observedStates).size, observedStates.length);
  const calls = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(calls.length > 32, `Observed ${calls.length} model calls`);
  assert.ok(calls.at(-1).results > 64);
  assert.match((await readMemoryNote(h.options.handle, "lessons.md"))?.content ?? "", /SYNTHETIC_VERIFIED_FEEDBACK/);
  assert.match((await readMemoryNote(h.options.handle, "MEMORY.md"))?.content ?? "", /lessons.md/);
  assert.equal((await readMemorySchedule(h.options.handle)).pendingTurns, 0);
  assert.equal(await readFile(h.source, "utf8"), original);
});

test("isolated CLI claim-lock failure starts no unassigned model request", { timeout: 15000 }, async (ctx) => {
  const h = await harness(ctx);
  const trace = join(h.directory, "trace.jsonl");
  testEnvironment(ctx, { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", JITI_FS_CACHE: "false",
    PI_MEMORY_TEST_TRACE: trace, PI_MEMORY_TEST_SOURCE: h.source });
  await mkdir(`${h.options.handle.directory}.lock`);
  let exited!: Promise<void>;
  const receipt = await runMemoryDream(h.options, { cliPath,
    cliArgs: ["--offline", "--approve", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates",
      "--no-context-files", "--no-session", "-e", join(packageRoot, "test/memory-dream-provider.ts")],
    spawn(command, args, options) {
      const child = spawn(command, args, options);
      exited = new Promise((resolve) => { child.once("exit", () => resolve()); });
      return child;
    },
  });
  cleanupSupervisor(ctx, receipt);
  const directory = await runDirectory(h.options);
  const status = await waitForStatus(directory, (state) => state.state === "failed");
  await exited;
  assert.equal(status.state, "failed");
  await assert.rejects(readFile(trace), { code: "ENOENT" }, "No provider request may run without a successful claim");
  assert.equal((await readMemorySchedule(h.options.handle)).pendingTurns, 50);
});

test("an active project dream lease suppresses extra supervisors before creating run artifacts", async (ctx) => {
  const h = await harness(ctx);
  assert.ok(await claimMemoryDream(h.options.handle, { ownerId: "existing-project-worker" }));
  assert.equal(await runMemoryDream(h.options), "");
  assert.ok(!(await readdir(h.options.handle.directory)).includes(".dream-runs"));
});
