import { isAbsolute, join } from "node:path";
import { isGlobalMemoryDreamDue, markGlobalMemoryDreamLaunch } from "./memory-global-schedule.ts";
import { hasActiveMemoryMerge } from "./memory-merge.ts";
import { hasActiveMemoryDream, readMemorySchedule } from "./memory-schedule.ts";
import type { MemoryStoreHandle } from "./memory-store.ts";
import {
  launchDetachedMemoryWorker, MEMORY_WORKER_TIMEOUT_MS, type MemoryWorkerLaunchDependencies,
} from "./memory-worker-launch.ts";

/** A dream has no request or tool-call quota; its independent process has a 30-minute deadline. */
export const MEMORY_DREAM_TIMEOUT_MS = MEMORY_WORKER_TIMEOUT_MS;

/** Only serializable launch capabilities cross the foreground/background process boundary. */
export interface MemoryDreamOptions {
  handle: MemoryStoreHandle;
  agentDir: string;
  model: { provider: string; id: string };
  thinkingLevel?: string;
  sessionRoots: string[];
  /** Trusted local checkout directory for project dreams (required when handle.identity is a remote ID). */
  workerCwd?: string;
}

/** Worker launch metadata contains no copied conversation, API keys, or mutable foreground context. */
export interface MemoryDreamWorkerConfig extends MemoryDreamOptions {
  runDirectory: string;
  deadline: number;
  /** Project passes run in the project; global passes run in their own run directory, loading no project resources. */
  workerCwd: string;
}

/** Start a detached project or global dream; the receipt confirms launch only, never memory completion. */
export async function runMemoryDream(
  options: MemoryDreamOptions,
  dependencies: MemoryWorkerLaunchDependencies = {},
): Promise<string> {
  if (process.platform === "win32") throw new Error("Memory dream detached supervision currently requires a POSIX host");
  if (!options.model.provider || !options.model.id) throw new Error("Memory dream requires an explicit provider and model");
  const global = options.handle.scope === "global";
  // Validate identity/storage before creating private run artifacts; a lease is acquired by the worker.
  if (global) {
    // The launch mark makes every frontend back off, so failed launches are not retried on each turn.
    if (!await isGlobalMemoryDreamDue(options.handle) || !await markGlobalMemoryDreamLaunch(options.handle)) return "";
  } else if (!(await readMemorySchedule(options.handle)).due ||
      await hasActiveMemoryDream(options.handle) ||
      await hasActiveMemoryMerge(options.handle)) {
    return "";
  }
  const workerCwd = global ? undefined : (options.workerCwd ?? (isAbsolute(options.handle.identity) ? options.handle.identity : undefined));
  if (!global && (!workerCwd || !isAbsolute(workerCwd))) {
    throw new Error("Memory dream requires an absolute project working directory");
  }
  const serializedHandle: MemoryStoreHandle = {
    directory: options.handle.directory,
    path: options.handle.path,
    identity: options.handle.identity,
    scope: options.handle.scope,
  };
  return launchDetachedMemoryWorker({
    kind: "dream",
    label: "Memory dream",
    runsDirectory: join(options.handle.directory, ".dream-runs"),
    runPrefix: "run-",
    workerCwd: global ? undefined : workerCwd!,
    agentDir: options.agentDir,
    memoryRoot: join(options.handle.directory, ".."),
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    workerExtensionUrl: new URL("./memory-dream-worker.ts", import.meta.url),
    initialPrompt: "Perform the assigned memory dreaming pass. If the dream worker did not initialize a task, report the configuration failure and take no other action.",
    buildEnv: ({ runDirectory, deadline }) => {
      const effectiveCwd = global ? runDirectory : workerCwd!;
      const config: MemoryDreamWorkerConfig = {
        ...options,
        handle: serializedHandle,
        runDirectory,
        deadline,
        workerCwd: effectiveCwd,
      };
      return {
        PI_MEMORY_DREAM_WORKER: "1",
        PI_MEMORY_DREAM_SCOPE: options.handle.scope,
        PI_MEMORY_DREAM_CONFIG: JSON.stringify(config),
      };
    },
    formatReceipt: ({ pid, runDirectory }) =>
      `Memory dreaming launched independently (supervisor PID ${pid}); this is not a completion receipt. Run status and logs: ${runDirectory}`,
  }, dependencies);
}
