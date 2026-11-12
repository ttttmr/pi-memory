import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { recordMemoryTurn, type MemoryScheduleSnapshot } from "./memory-schedule.ts";
import { isMemoryStoreLockedError, type MemoryStoreHandle } from "./memory-store.ts";

/** Identifies an original user message; never substitute the current session after replacement. */
export interface MemoryObservationTurn {
  sessionId: string;
  entryId: string;
  sessionFile?: string;
}

/** Callbacks may run after runtime replacement and must not dereference a stale ExtensionContext. */
export interface MemoryObservationQueueOptions {
  onRecorded(handle: MemoryStoreHandle, turn: MemoryObservationTurn, snapshot: MemoryScheduleSnapshot): void;
  onError(handle: MemoryStoreHandle, error: unknown): void;
}

/** Exposes pending work for retired queues; close is idempotent and closed flush never writes. */
export interface MemoryObservationQueue {
  readonly pendingCount: number;
  enqueue(handle: MemoryStoreHandle, turn: MemoryObservationTurn): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<number>;
}

interface PendingMemoryObservation {
  handle: MemoryStoreHandle;
  turn: MemoryObservationTurn;
  key: string;
}

interface MemoryObservationProject {
  handle: MemoryStoreHandle;
  pending: PendingMemoryObservation[];
  pendingKeys: Set<string>;
  watcher?: FSWatcher;
  flushPromise?: Promise<void>;
  wakeRequested: boolean;
}

/** Queues new user message observations and retries them on lock-release events without polling. */
export function createMemoryObservationQueue(
  options: MemoryObservationQueueOptions,
  dependencies: { watch?: typeof watch } = {},
): MemoryObservationQueue {
  const watchImplementation = dependencies.watch ?? watch;
  const projects = new Map<string, MemoryObservationProject>();
  let closed = false;
  let closePromise: Promise<number> | undefined;

  function reportError(handle: MemoryStoreHandle, error: unknown): void {
    options.onError(handle, error);
  }

  function closeProjectWatcher(project: MemoryObservationProject): void {
    const watcher = project.watcher;
    project.watcher = undefined;
    if (!watcher) return;
    try { watcher.close(); }
    catch (error) { reportError(project.handle, error); }
  }

  function requestProjectFlush(project: MemoryObservationProject): void {
    void flushProject(project).catch((error) => reportError(project.handle, error));
  }

  function ensureProjectWatcher(project: MemoryObservationProject): void {
    if (project.watcher || closed || !project.pending.length) return;
    const lockName = `${basename(project.handle.directory)}.lock`;
    let watcher: FSWatcher;
    try {
      watcher = watchImplementation(dirname(project.handle.directory), { persistent: false }, (_eventType, filename) => {
        if (project.watcher !== watcher || closed) return;
        if (filename === null || filename.toString() === lockName) {
          project.wakeRequested = true;
          requestProjectFlush(project);
        }
      });
    } catch (error) {
      reportError(project.handle, error);
      return;
    }
    project.watcher = watcher;
    watcher.on("error", (error) => {
      if (project.watcher !== watcher) return;
      project.wakeRequested = false;
      closeProjectWatcher(project);
      reportError(project.handle, error);
      // Pending observations remain queued. A later explicit enqueue/flush installs a fresh watcher.
    });
    // The lock may have disappeared between the failed attempt and watch subscription.
    // The active flight performs exactly one immediate retry after it clears flushPromise.
    project.wakeRequested = true;
  }

  async function flushProject(project: MemoryObservationProject): Promise<void> {
    if (project.flushPromise) return project.flushPromise;
    const run = (async () => {
      while (project.pending.length) {
        const observation = project.pending[0]!;
        let snapshot: MemoryScheduleSnapshot;
        try {
          snapshot = await recordMemoryTurn(observation.handle, observation.turn);
        } catch (error) {
          if (isMemoryStoreLockedError(error)) ensureProjectWatcher(project);
          else {
            project.wakeRequested = false;
            closeProjectWatcher(project);
            reportError(observation.handle, error);
          }
          return;
        }
        project.pending.shift();
        project.pendingKeys.delete(observation.key);
        try { options.onRecorded(observation.handle, observation.turn, snapshot); }
        catch (error) { reportError(observation.handle, error); }
      }
      closeProjectWatcher(project);
      if (projects.get(project.handle.directory) === project) projects.delete(project.handle.directory);
    })();
    project.flushPromise = run;
    const clearFlush = () => {
      if (project.flushPromise === run) project.flushPromise = undefined;
      if (project.wakeRequested) {
        project.wakeRequested = false;
        if (!closed && project.pending.length) requestProjectFlush(project);
      }
    };
    void run.then(clearFlush, clearFlush);
    return run;
  }

  return {
    get pendingCount() {
      return [...projects.values()].reduce((count, project) => count + project.pending.length, 0);
    },

    async enqueue(handle, turn) {
      if (closed) throw new Error("Memory observation queue is closed; cannot enqueue new turns");
      const directory = handle.directory;
      let project = projects.get(directory);
      if (!project) {
        project = { handle, pending: [], pendingKeys: new Set<string>(), wakeRequested: false };
        projects.set(directory, project);
      }
      const key = JSON.stringify([directory, turn.sessionId, turn.entryId]);
      if (!project.pendingKeys.has(key)) {
        project.pendingKeys.add(key);
        project.pending.push({ handle, turn: { ...turn }, key });
      }
      await flushProject(project);
    },

    async flush() {
      if (closed) return;
      await Promise.all([...projects.values()].map((project) => flushProject(project)));
    },

    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        await Promise.all([...projects.values()].map((project) => flushProject(project)));
        for (const project of projects.values()) closeProjectWatcher(project);
        return [...projects.values()].reduce((count, project) => count + project.pending.length, 0);
      })();
      return closePromise;
    },
  };
}
