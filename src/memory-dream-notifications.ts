import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Foreground status notifications contain metadata only, never the worker's report or raw errors. */
export interface MemoryDreamNotification {
  state: "running" | "completed" | "failed" | "timed_out" | "not_claimed" | "unavailable";
  message: string;
  type: "info" | "warning" | "error";
}

/** Watch one launched run without polling or keeping the foreground alive; abort only stops observation. */
export function watchMemoryDreamStatus(
  directory: string,
  deadline: number,
  notify: (notification: MemoryDreamNotification) => void,
  signal: AbortSignal,
): void {
  if (signal.aborted) return;
  let closed = false;
  let inspecting = false;
  let dirty = false;
  const seen = new Set<string>();
  const close = () => {
    if (closed) return;
    closed = true;
    watcher.close();
    clearTimeout(timer);
    signal.removeEventListener("abort", close);
  };
  const unavailable = () => {
    if (closed) return;
    close();
    notify({ state: "unavailable", type: "warning", message: `Memory dreaming status monitoring unavailable; completion is unknown. Run status and logs: ${directory}` });
  };
  const watcher = watch(directory, { persistent: false }, (_event, filename) => {
    if (!filename || filename === "status.json") void inspect();
  });
  // A crashed supervisor may never write a terminal status. Bound the observer's lifetime,
  // but do not infer success, failure, or timeout from absence of filesystem events.
  const timer = setTimeout(unavailable, Math.max(0, deadline - Date.now() + 10000));
  timer.unref();
  watcher.on("error", unavailable);
  signal.addEventListener("abort", close, { once: true });
  async function inspect() {
    if (closed) return;
    dirty = true;
    if (inspecting) return;
    inspecting = true;
    try {
      do {
        dirty = false;
        const status = JSON.parse(await readFile(join(directory, "status.json"), "utf8")) as { state?: unknown };
        if (closed || typeof status.state !== "string" || seen.has(status.state)) continue;
        const notifications: Record<string, MemoryDreamNotification> = {
          running: { state: "running", type: "info", message: "Memory dreaming is running." },
          completed: { state: "completed", type: "info", message: "Memory dreaming completed; its claimed batch was acknowledged." },
          failed: { state: "failed", type: "error", message: "Memory dreaming failed; pending work and completed writes are retained." },
          timed_out: { state: "timed_out", type: "warning", message: "Memory dreaming timed out; cleanup is being enforced. Completed writes are retained." },
          not_claimed: { state: "not_claimed", type: "info", message: "Memory dreaming skipped: no batch was claimed (work may already be claimed or no longer due)." },
        };
        const notification = notifications[status.state];
        if (!notification) continue; // launching/starting are covered by the launch receipt.
        seen.add(status.state);
        if (status.state !== "running") close();
        notify({ ...notification, message: `${notification.message} Run status and logs: ${directory}` });
      } while (dirty && !closed);
    } catch {
      // Existing workers may still replace JSON in place. A subsequent event retries;
      // the bounded observer reports an unknown result if no readable terminal state arrives.
    } finally { inspecting = false; }
  }
  void inspect(); // Also catches a worker that finished before watch registration.
}
