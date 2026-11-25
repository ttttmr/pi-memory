import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildMemoryMergePrompt, claimMemoryMerge, finishMemoryMerge,
  type MemoryMergeClaim, type MemoryMergeWorkerConfig,
} from "./memory-merge.ts";
import { resolveMemoryProject } from "./memory-store.ts";

/** Detached worker extension for the mechanism-triggered project store-merge task (not regular dreaming). */
export default function memoryMergeWorkerExtension(pi: ExtensionAPI): void {
  const serialized = process.env.PI_MEMORY_MERGE_CONFIG;
  if (process.env.PI_MEMORY_MERGE_WORKER !== "1" || !serialized) {
    throw new Error("Memory store merge worker requires detached launch configuration");
  }
  const config = JSON.parse(serialized) as MemoryMergeWorkerConfig;
  let claim: MemoryMergeClaim | null = null;
  let initialized = false;
  let finalized = false;
  let outcome: "completed" | "error" | "aborted" | undefined;
  let initializationError: unknown;

  const status = async (state: string, extra: Record<string, unknown> = {}) => {
    const temporary = join(config.runDirectory, `status.${process.pid}.tmp`);
    await writeFile(temporary, JSON.stringify({
      state,
      kind: "merge",
      deadline: config.deadline,
      workerPid: process.pid,
      updatedAt: new Date().toISOString(),
      ...extra,
    }) + "\n", { mode: 0o600 });
    await rename(temporary, join(config.runDirectory, "status.json"));
  };

  const finish = async (success: boolean, error?: string) => {
    if (finalized || !claim) return;
    finalized = true;
    try {
      const result = await finishMemoryMerge(config.handle, claim, { success });
      await status(success ? "completed" : "failed", {
        sources: claim.sources.map((source) => source.directoryName),
        archivedCount: result.archived.length,
        deferredCount: result.deferred.length,
        archived: result.archived,
        deferred: result.deferred,
        ...(error ? { error } : {}),
      });
    } catch (failure) {
      await status("failed", {
        error: `Memory store merge finalization failed: ${String(failure)}. Legacy stores remain intact; completed writes are retained.`,
      });
      throw failure;
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      if (!Number.isSafeInteger(config.deadline) || Date.now() >= config.deadline) {
        throw new Error("Memory store merge deadline passed before startup");
      }
      if (!ctx.isProjectTrusted() || await resolveMemoryProject(ctx.cwd) !== config.handle.identity) {
        throw new Error("Memory store merge worker project identity or trust does not match its launch");
      }
      if (ctx.model?.provider !== config.model.provider || ctx.model.id !== config.model.id) {
        throw new Error("Memory store merge worker did not load the selected foreground model; fallback is not allowed");
      }
      claim = await claimMemoryMerge(config.handle, { ownerId: randomUUID(), sources: config.sources });
      initialized = true;
      await status(
        claim ? "running" : "not_claimed",
        claim ? { sources: claim.sources.map((source) => source.directoryName) } : {},
      );
    } catch (error) {
      initializationError = error;
      await status("failed", { error: String(error) });
    }
  });

  pi.on("input", () => {
    // Pi reports input-hook exceptions and continues the original prompt. Handle failures
    // explicitly so a failed claim/trust/model check cannot start an unassigned model run.
    if (initializationError || !initialized || !claim) return { action: "handled" };
    return { action: "transform", text: buildMemoryMergePrompt(config, claim) };
  });

  pi.on("context", (event) => ({
    messages: [...event.messages, {
      role: "custom" as const,
      customType: "pi-memory-merge-clock",
      display: false,
      timestamp: Date.now(),
      content: `Merge clock: current time ${new Date().toISOString()}; hard deadline ${new Date(config.deadline).toISOString()}; approximately ${Math.max(0, Math.floor((config.deadline - Date.now()) / 1000))} seconds remain.`,
    }],
  }));

  pi.on("agent_before_settle", (event) => { outcome = event.outcome; });

  pi.on("agent_settled", async (event, ctx) => {
    const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
    const success = !event.aborted && outcome === "completed" && Date.now() < config.deadline &&
      last?.type === "message" && last.message.role === "assistant" && last.message.stopReason === "stop";
    await finish(
      success,
      success ? undefined : "Memory store merge did not finish normally before its deadline; legacy stores remain intact and completed writes are retained.",
    );
  });

  pi.on("session_shutdown", async () => {
    await finish(false, "Memory store merge worker shut down before completing; legacy stores remain intact and completed writes are retained.");
  });
}
