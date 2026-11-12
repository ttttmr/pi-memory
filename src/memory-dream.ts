import { spawn, type SpawnOptions } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { watchMemoryDreamStatus, type MemoryDreamNotification } from "./memory-dream-notifications.ts";
import { hasActiveMemoryDream, readMemorySchedule } from "./memory-schedule.ts";
import type { MemoryStoreHandle } from "./memory-store.ts";

/** A dream has no request or tool-call quota; its independent process has a 30-minute deadline. */
export const MEMORY_DREAM_TIMEOUT_MS = 30 * 60 * 1000;

/** Only serializable launch capabilities cross the foreground/background process boundary. */
export interface MemoryDreamOptions {
  handle: MemoryStoreHandle;
  agentDir: string;
  model: { provider: string; id: string };
  thinkingLevel?: string;
  sessionRoots: string[];
}

/** Worker launch metadata contains no copied conversation, API keys, or mutable foreground context. */
export interface MemoryDreamWorkerConfig extends MemoryDreamOptions {
  runDirectory: string;
  deadline: number;
}

interface MemoryDreamLaunchDependencies {
  onStatus?: (notification: MemoryDreamNotification) => void;
  statusSignal?: AbortSignal;
  cliPath?: string;
  cliArgs?: string[];
  timeoutMs?: number;
  killGraceMs?: number;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ReturnType<typeof spawn>;
}

// The supervisor is deliberately plain JavaScript: the installed host CLI loads our TS extension
// with its own peer aliases, even when this git-installed package has no local node_modules.
const MEMORY_DREAM_SUPERVISOR = `
const { spawn, spawnSync } = require("node:child_process");
const { readFileSync, writeFileSync, renameSync, openSync, closeSync } = require("node:fs");
const { join } = require("node:path");
const config = JSON.parse(process.env.PI_MEMORY_DREAM_CONFIG);
const launch = JSON.parse(process.env.PI_MEMORY_DREAM_LAUNCH);
const statusPath = join(config.runDirectory, "status.json");
function status(state, extra = {}) {
  let previous = {};
  try { previous = JSON.parse(readFileSync(statusPath, "utf8")); } catch {}
  const temporary = statusPath + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify({ ...previous, state, updatedAt: new Date().toISOString(), ...extra }) + "\\n", { mode: 0o600 });
  renameSync(temporary, statusPath);
}
function readDreamProcesses() {
  // Two deadline-triggered snapshots, not a watcher or polling loop. lstart helps
  // reject PID reuse; POSIX has no portable atomic process-identity signal API.
  const result = spawnSync("/bin/ps", ["-A", "-o", "pid=,ppid=,lstart="], {
    encoding: "utf8", timeout: 1000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error || result.status !== 0) {
    console.error("Memory dream descendant discovery failed; only the supervisor group can be guaranteed cleanup.");
    return [];
  }
  return result.stdout.split("\\n").flatMap(line => {
    const fields = line.trim().match(/^(\\d+)\\s+(\\d+)\\s+(.+)$/);
    return fields ? [{ pid: Number(fields[1]), parentPid: Number(fields[2]), startedAt: fields[3] }] : [];
  });
}
function collectDreamDescendants(processes, rootPids) {
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
function killDreamDescendants(captured) {
  const processes = readDreamProcesses();
  const live = new Map(processes.map(entry => [entry.pid, entry]));
  // Keep captured identities even after TERM reparents tools. Include new children
  // still attached to a matching survivor, but never target an unrelated group.
  const survivors = captured.filter(entry => live.get(entry.pid)?.startedAt === entry.startedAt);
  const targets = new Map(survivors.map(entry => [entry.pid, entry]));
  for (const entry of collectDreamDescendants(processes, [process.pid, ...targets.keys()])) targets.set(entry.pid, entry);
  for (const entry of targets.values()) {
    try { process.kill(entry.pid, "SIGKILL"); } catch {}
  }
}
const events = openSync(join(config.runDirectory, "events.jsonl"), "wx", 0o600);
let child;
let timedOut = false;
let hardTimer;
const deadlineTimer = setTimeout(() => {
  timedOut = true;
  status("timed_out", { error: "Memory dream reached its 30-minute wall-clock deadline; completed writes remain." });
  // Pi bash tools use separate detached groups. Capture before TERM can orphan
  // them, since an unresponsive worker cannot run Pi's own tool cleanup handler.
  const descendants = collectDreamDescendants(readDreamProcesses(), [process.pid]);
  child?.kill("SIGTERM");
  hardTimer = setTimeout(() => {
    status("timed_out", { error: "Memory dream wall-clock deadline enforced; completed writes remain." });
    killDreamDescendants(descendants);
    process.kill(-process.pid, "SIGKILL");
  }, launch.killGraceMs);
}, Math.max(0, config.deadline - Date.now()));
try {
  child = spawn(process.execPath, launch.args, { cwd: config.handle.identity, env: process.env, stdio: ["ignore", events, "inherit"] });
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
      status("failed", { error: "Memory dream worker exited before confirming its batch", exitCode: code, signal });
    }
    process.exitCode = code || (signal ? 1 : 0);
  });
} catch (error) {
  status("failed", { error: error.message });
  clearTimeout(deadlineTimer);
  process.exitCode = 1;
} finally { closeSync(events); }
`;

/** Start a detached project dream; the receipt confirms launch only, never memory completion. */
export async function runMemoryDream(
  options: MemoryDreamOptions,
  dependencies: MemoryDreamLaunchDependencies = {},
): Promise<string> {
  if (process.platform === "win32") throw new Error("Memory dream detached supervision currently requires a POSIX host");
  if (options.handle.scope !== "project") throw new Error("Memory dream requires a project memory handle");
  if (!options.model.provider || !options.model.id) throw new Error("Memory dream requires an explicit provider and model");
  // Validate identity/storage before creating private run artifacts; a lease is acquired by the worker.
  if (!(await readMemorySchedule(options.handle)).due || await hasActiveMemoryDream(options.handle)) return "";
  const runsDirectory = join(options.handle.directory, ".dream-runs");
  try { await mkdir(runsDirectory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await lstat(runsDirectory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(runsDirectory) !== runsDirectory) {
    throw new Error("Memory dream run directory is unsafe; no worker was started");
  }
  const runDirectory = await mkdtemp(join(runsDirectory, "run-"));
  const config: MemoryDreamWorkerConfig = {
    ...options, runDirectory, deadline: Date.now() + (dependencies.timeoutMs ?? MEMORY_DREAM_TIMEOUT_MS),
  };
  const cliPath = dependencies.cliPath ?? await resolveMemoryDreamCli();
  const args = [cliPath, "--mode", "json", "--provider", options.model.provider, "--model", options.model.id,
    "--session-dir", join(runDirectory, "sessions"),
    "-e", fileURLToPath(new URL("./memory-extension.ts", import.meta.url)),
    "-e", fileURLToPath(new URL("./memory-dream-worker.ts", import.meta.url))];
  if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
  if (dependencies.cliArgs) args.push(...dependencies.cliArgs);
  args.push("--", "Perform the assigned project memory dreaming pass. If the dream worker did not initialize a task, report the configuration failure and take no other action.");
  await writeFile(join(runDirectory, "status.json"), JSON.stringify({ state: "launching", deadline: config.deadline }) + "\n", { flag: "wx", mode: 0o600 });
  const log = await open(join(runDirectory, "supervisor.log"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try {
    const child = (dependencies.spawn ?? spawn)(process.execPath, ["-e", MEMORY_DREAM_SUPERVISOR], {
      cwd: options.handle.identity, detached: true, stdio: ["ignore", log.fd, log.fd],
      env: { ...process.env, PI_CODING_AGENT_DIR: options.agentDir, PI_MEMORY_DIR: join(options.handle.directory, ".."),
        PI_MEMORY_DREAM_WORKER: "1", PI_MEMORY_DREAM_CONFIG: JSON.stringify(config),
        PI_MEMORY_DREAM_LAUNCH: JSON.stringify({ args, killGraceMs: dependencies.killGraceMs ?? 5000 }) },
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    if (dependencies.onStatus && dependencies.statusSignal) {
      try { watchMemoryDreamStatus(runDirectory, config.deadline, dependencies.onStatus, dependencies.statusSignal); }
      catch {
        dependencies.onStatus({ state: "unavailable", type: "warning",
          message: `Memory dreaming status monitoring unavailable; completion is unknown. Run status and logs: ${runDirectory}` });
      }
    }
    return `Memory dreaming launched independently (supervisor PID ${child.pid}); this is not a completion receipt. Run status and logs: ${runDirectory}`;
  } catch (error) {
    await writeFile(join(runDirectory, "status.json"), JSON.stringify({ state: "failed", error: String(error) }) + "\n", { mode: 0o600 });
    throw error;
  } finally { await log.close(); }
}

async function resolveMemoryDreamCli(): Promise<string> {
  const packageDirectory = getPackageDir();
  const metadata = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
  const entry = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pi ?? Object.values(metadata.bin ?? {})[0];
  if (!entry) throw new Error("Memory dream could not locate the installed Node.js Pi CLI entrypoint");
  return join(packageDirectory, entry);
}
