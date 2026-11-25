import { spawn, type SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { watchMemoryDreamStatus, type MemoryDreamNotification } from "./memory-dream-notifications.ts";

/** Background workers have no request or tool-call quota; their independent process has a 30-minute deadline. */
export const MEMORY_WORKER_TIMEOUT_MS = 30 * 60 * 1000;

/** Test and observer hooks shared by detached memory workers (dreaming and store merge). */
export interface MemoryWorkerLaunchDependencies {
  onStatus?: (notification: MemoryDreamNotification) => void;
  statusSignal?: AbortSignal;
  cliPath?: string;
  cliArgs?: string[];
  timeoutMs?: number;
  killGraceMs?: number;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;
}

/** Shared launch specification for one detached memory worker supervisor. */
export interface DetachedMemoryWorkerSpec {
  kind: "dream" | "merge";
  label: string;
  runsDirectory: string;
  runPrefix: string;
  /** Omit to run the worker inside its own private `runDirectory` (e.g. global dreaming). */
  workerCwd?: string;
  agentDir: string;
  memoryRoot: string;
  model: { provider: string; id: string };
  thinkingLevel?: string;
  workerExtensionUrl: URL;
  initialPrompt: string;
  buildEnv: (context: { runDirectory: string; deadline: number }) => Record<string, string>;
  formatReceipt: (context: { pid: number | undefined; runDirectory: string }) => string;
}

// The supervisor is deliberately plain JavaScript: the installed host CLI loads our TS extension
// with its own peer aliases, even when this git-installed package has no local node_modules.
const MEMORY_WORKER_SUPERVISOR = `
const { spawn, spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, renameSync, openSync, closeSync } = require("node:fs");
const { join } = require("node:path");
const launch = JSON.parse(process.env.PI_MEMORY_DREAM_LAUNCH);
const label = launch.label || "Memory dream";
const statusPath = join(launch.runDirectory, "status.json");
function status(state, extra = {}) {
  let previous = {};
  try { previous = JSON.parse(readFileSync(statusPath, "utf8")); } catch {}
  const temporary = statusPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify({ ...previous, state, updatedAt: new Date().toISOString(), ...extra }) + "\\n", { mode: 0o600 });
  renameSync(temporary, statusPath);
}
function readWorkerProcesses() {
  // Two deadline-triggered snapshots, not a watcher or polling loop. lstart helps
  // reject PID reuse; POSIX has no portable atomic process-identity signal API.
  const result = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], {
    encoding: "utf8", timeout: 1000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) {
    console.error(label + " descendant discovery failed; only the supervisor group can be guaranteed cleanup.");
    return [];
  }
  return result.stdout.split("\\n").flatMap(line => {
    const fields = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/);
    return fields ? [{ pid: Number(fields[1]), parentPid: Number(fields[2]), startedAt: fields[3] }] : [];
  });
}
function collectWorkerDescendants(processes, rootPids) {
  const found = [];
  const parents = new Set(rootPids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of processes) {
      if (!parents.has(entry.pid) && parents.has(entry.parentPid)) {
        parents.add(entry.pid);
        found.push(entry);
        changed = true;
      }
    }
  }
  return found;
}
function killWorkerDescendants(captured) {
  const processes = readWorkerProcesses();
  const live = new Map(processes.map(entry => [entry.pid, entry]));
  // Keep captured identities even after TERM reparents tools. Include new children
  // still attached to a matching survivor, but never target an unrelated group.
  const survivors = captured.filter(entry => live.get(entry.pid)?.startedAt === entry.startedAt);
  const targets = new Map(survivors.map(entry => [entry.pid, entry]));
  for (const entry of collectWorkerDescendants(processes, [process.pid, ...targets.keys()])) targets.set(entry.pid, entry);
  for (const entry of targets.values()) {
    try { process.kill(entry.pid, "SIGKILL"); } catch {}
  }
}
const events = openSync(join(launch.runDirectory, "events.jsonl"), "wx", 0o600);
let child;
let timedOut = false;
let hardTimer;
const deadlineTimer = setTimeout(() => {
  timedOut = true;
  status("timed_out", { error: label + " reached its 30-minute wall-clock deadline; completed writes remain." });
  // Pi bash tools use separate detached groups. Capture before TERM can orphan
  // them, since an unresponsive worker cannot run Pi's own tool cleanup handler.
  const descendants = collectWorkerDescendants(readWorkerProcesses(), [process.pid]);
  child?.kill("SIGTERM");
  hardTimer = setTimeout(() => {
    status("timed_out", { error: label + " wall-clock deadline enforced; completed writes remain." });
    killWorkerDescendants(descendants);
    process.kill(-process.pid, "SIGKILL");
  }, launch.killGraceMs);
}, Math.max(0, launch.deadline - Date.now()));
try {
  child = spawn(process.execPath, launch.args, { cwd: launch.workerCwd, env: process.env, stdio: ["ignore", events, "inherit"] });
  status("starting", { supervisorPid: process.pid, workerPid: child.pid });
  child.on("error", error => { status("failed", { error: error.message }); clearTimeout(deadlineTimer); process.exitCode = 1; });
  child.on("close", (code, signal) => {
    clearTimeout(deadlineTimer);
    if (timedOut) {
      // The hard timer stays armed even when Pi exits: a tool may have survived it.
      return;
    }
    let previous = {};
    try { previous = JSON.parse(readFileSync(statusPath, "utf8")); } catch {}
    if (!["completed", "failed", "not_claimed"].includes(previous.state)) {
      status("failed", { error: label + " worker exited before confirming its batch", exitCode: code, signal });
    }
    process.exitCode = code || (signal ? 1 : 0);
  });
} catch (error) {
  status("failed", { error: error.message });
  clearTimeout(deadlineTimer);
  process.exitCode = 1;
} finally { closeSync(events); }
`;

/** Spawn one detached POSIX supervisor + Pi CLI worker with private run logs, hard deadline, and status watching. */
export async function launchDetachedMemoryWorker(
  spec: DetachedMemoryWorkerSpec,
  dependencies: MemoryWorkerLaunchDependencies = {},
): Promise<string> {
  if (process.platform === "win32") throw new Error(`${spec.label} detached supervision currently requires a POSIX host`);
  if (!spec.model.provider || !spec.model.id) throw new Error(`${spec.label} requires an explicit provider and model`);

  try { await mkdir(spec.runsDirectory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await lstat(spec.runsDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(spec.runsDirectory) !== spec.runsDirectory) {
    throw new Error(`${spec.label} run directory is unsafe; no worker was started`);
  }

  const runDirectory = await mkdtemp(join(spec.runsDirectory, spec.runPrefix));
  const workerCwd = spec.workerCwd ?? runDirectory;
  const deadline = Date.now() + (dependencies.timeoutMs ?? MEMORY_WORKER_TIMEOUT_MS);
  const cliPath = dependencies.cliPath ?? await resolveMemoryWorkerCli();
  const args = [
    cliPath, "--mode", "json", "--provider", spec.model.provider, "--model", spec.model.id,
    "--session-dir", join(runDirectory, "sessions"),
    "-e", fileURLToPath(new URL("./memory-extension.ts", import.meta.url)),
    "-e", fileURLToPath(spec.workerExtensionUrl),
  ];
  if (spec.thinkingLevel) args.push("--thinking", spec.thinkingLevel);
  if (dependencies.cliArgs) args.push(...dependencies.cliArgs);
  args.push("--", spec.initialPrompt);

  await writeFile(join(runDirectory, "status.json"), JSON.stringify({ state: "launching", deadline }) + "\n", { flag: "wx", mode: 0o600 });
  const log = await open(join(runDirectory, "supervisor.log"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const workerEnv = spec.buildEnv({ runDirectory, deadline });
    const child = (dependencies.spawn ?? spawn)(process.execPath, ["-e", MEMORY_WORKER_SUPERVISOR], {
      cwd: workerCwd,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: spec.agentDir,
        PI_MEMORY_DIR: spec.memoryRoot,
        ...workerEnv,
        PI_MEMORY_DREAM_LAUNCH: JSON.stringify({
          args,
          killGraceMs: dependencies.killGraceMs ?? 5000,
          runDirectory,
          deadline,
          workerCwd,
          label: spec.label,
        }),
      },
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    if (dependencies.onStatus && dependencies.statusSignal) {
      const notifyLabel = spec.kind === "merge" ? "Memory store merge" : "Memory dreaming";
      try { watchMemoryDreamStatus(runDirectory, deadline, dependencies.onStatus, dependencies.statusSignal, spec.kind); }
      catch {
        dependencies.onStatus({
          state: "unavailable",
          type: "warning",
          message: `${notifyLabel} status monitoring unavailable; completion is unknown. Run status and logs: ${runDirectory}`,
        });
      }
    }
    return spec.formatReceipt({ pid: child.pid, runDirectory });
  } catch (error) {
    await writeFile(join(runDirectory, "status.json"), JSON.stringify({ state: "failed", error: String(error) }) + "\n", { mode: 0o600 });
    throw error;
  } finally { await log.close(); }
}

async function resolveMemoryWorkerCli(): Promise<string> {
  const packageDirectory = getPackageDir();
  const metadata = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
  const entry = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pi ?? Object.values(metadata.bin ?? {})[0];
  if (!entry) throw new Error("Memory dream could not locate the installed Node.js Pi CLI entrypoint");
  return join(packageDirectory, entry);
}
