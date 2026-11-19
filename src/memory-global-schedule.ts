import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  listMemoryNotes, memoryNotesFingerprint, mutateMemoryScheduleData, readMemoryScheduleData, type MemoryStoreHandle,
} from "./memory-store.ts";

/** The first global pass waits until global memory has some content to consolidate. */
export const GLOBAL_DREAM_MIN_NOTES = 3;
/** A changed global store is maintained at most weekly. */
export const GLOBAL_DREAM_MIN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** An unchanged store is still rechecked monthly, because time-sensitive claims drift. */
export const GLOBAL_DREAM_MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
/** A failed or unconfirmed launch is not retried by any frontend for six hours. */
export const GLOBAL_DREAM_RETRY_MS = 6 * 60 * 60 * 1000;
const GLOBAL_DREAM_LEASE_MILLISECONDS = 1_830_000;

/** A global pass leases the whole global store; there is no session batch. */
export interface GlobalMemoryDreamClaim {
  ownerId: string;
  token: string;
  expiresAt: number;
}

interface GlobalMemoryDreamState {
  version: 1;
  kind: "global";
  lastCompletedAt: number | null;
  lastFingerprint: string | null;
  lastLaunchAt: number | null;
  claim: GlobalMemoryDreamClaim | null;
}

/**
 * Decide whether a global consolidation pass is due. Cheap time checks run before notes are listed.
 * Due: never maintained with enough notes; or changed since the last pass and a week has passed; or a month passed.
 */
export async function isGlobalMemoryDreamDue(handle: MemoryStoreHandle, now = Date.now()): Promise<boolean> {
  requireGlobalSchedule(handle);
  const state = parseGlobalMemoryDream(await readMemoryScheduleData(handle));
  if (!globalLaunchAllowed(state, now)) return false;
  const notes = await listMemoryNotes(handle);
  if (state.lastCompletedAt === null) return notes.length >= GLOBAL_DREAM_MIN_NOTES;
  if (!notes.length) return false;
  if (now - state.lastCompletedAt >= GLOBAL_DREAM_MAX_INTERVAL_MS) return true;
  return memoryNotesFingerprint(notes) !== state.lastFingerprint;
}

/** Record a launch attempt so other frontends back off; false means another launch or lease won the race. */
export async function markGlobalMemoryDreamLaunch(handle: MemoryStoreHandle, now = Date.now(), signal?: AbortSignal): Promise<boolean> {
  requireGlobalSchedule(handle);
  return mutateGlobalMemoryDream(handle, (state) => {
    if (!globalLaunchAllowed(state, now)) return false;
    state.lastLaunchAt = now;
    return true;
  }, signal);
}

/** Lease the global store for one pass; null means a valid lease exists or a pass completed recently. */
export async function claimGlobalMemoryDream(
  handle: MemoryStoreHandle, options: { ownerId: string }, signal?: AbortSignal,
): Promise<GlobalMemoryDreamClaim | null> {
  requireGlobalSchedule(handle);
  if (!options || typeof options.ownerId !== "string" || !options.ownerId || options.ownerId.length > 4096) {
    throw new Error("Global memory dream claim requires a valid ownerId");
  }
  return mutateGlobalMemoryDream(handle, (state) => {
    const now = Date.now();
    if (state.claim && state.claim.expiresAt > now) return null;
    if (state.lastCompletedAt !== null && now - state.lastCompletedAt < GLOBAL_DREAM_MIN_INTERVAL_MS) return null;
    const claim = { ownerId: options.ownerId, token: randomUUID(), expiresAt: now + GLOBAL_DREAM_LEASE_MILLISECONDS };
    state.claim = claim;
    return { ...claim };
  }, signal);
}

/** Success records the completion time and the resulting notes fingerprint; failure only releases the lease. */
export async function finishGlobalMemoryDream(
  handle: MemoryStoreHandle, claim: GlobalMemoryDreamClaim, outcome: { success: boolean }, signal?: AbortSignal,
): Promise<void> {
  requireGlobalSchedule(handle);
  // Fingerprint outside the store lock: a concurrent project write simply makes the next pass due sooner.
  const fingerprint = outcome?.success ? memoryNotesFingerprint(await listMemoryNotes(handle)) : null;
  await mutateGlobalMemoryDream(handle, (state) => {
    if (!state.claim || state.claim.ownerId !== claim.ownerId || state.claim.token !== claim.token ||
        state.claim.expiresAt !== claim.expiresAt) {
      throw new Error("Global memory dream claim ownership mismatch; another runner's work was not changed");
    }
    if (outcome.success) {
      state.lastCompletedAt = Date.now();
      state.lastFingerprint = fingerprint;
    }
    state.claim = null;
  }, signal);
}

/** Read whether a valid global lease exists, without creating storage. */
export async function hasActiveGlobalMemoryDream(handle: MemoryStoreHandle): Promise<boolean> {
  requireGlobalSchedule(handle);
  const state = parseGlobalMemoryDream(await readMemoryScheduleData(handle));
  return Boolean(state.claim && state.claim.expiresAt > Date.now());
}

function globalLaunchAllowed(state: GlobalMemoryDreamState, now: number): boolean {
  if (state.claim && state.claim.expiresAt > now) return false;
  if (state.lastLaunchAt !== null && now - state.lastLaunchAt < GLOBAL_DREAM_RETRY_MS) return false;
  return state.lastCompletedAt === null || now - state.lastCompletedAt >= GLOBAL_DREAM_MIN_INTERVAL_MS;
}

function requireGlobalSchedule(handle: MemoryStoreHandle): void {
  if (handle.scope !== "global") throw new Error("Global memory dream schedule is available only for global memory");
}

function mutateGlobalMemoryDream<T>(
  handle: MemoryStoreHandle, mutation: (state: GlobalMemoryDreamState) => T, signal?: AbortSignal,
): Promise<T> {
  return withFileMutationQueue(handle.path, () => mutateMemoryScheduleData(handle, (data) => {
    const state = parseGlobalMemoryDream(data);
    return { data: state, result: mutation(state) };
  }, signal));
}

function parseGlobalMemoryDream(data: unknown): GlobalMemoryDreamState {
  if (data === null) return { version: 1, kind: "global", lastCompletedAt: null, lastFingerprint: null, lastLaunchAt: null, claim: null };
  const keys = ["version", "kind", "lastCompletedAt", "lastFingerprint", "lastLaunchAt", "claim"];
  if (typeof data !== "object" || Array.isArray(data) || Object.keys(data).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(data, key))) {
    throw new Error("Global memory dream state is corrupt or has unknown fields; repair explicitly");
  }
  const state = data as Record<string, unknown>;
  const claim = state.claim as Record<string, unknown> | null;
  if (state.version !== 1 || state.kind !== "global" || !isTimeOrNull(state.lastCompletedAt) ||
      !isTimeOrNull(state.lastLaunchAt) ||
      (state.lastFingerprint !== null && (typeof state.lastFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(state.lastFingerprint))) ||
      (claim !== null && (typeof claim !== "object" || Array.isArray(claim) || Object.keys(claim).length !== 3 ||
        typeof claim.ownerId !== "string" || !claim.ownerId || typeof claim.token !== "string" ||
        !/^[a-f0-9-]{36}$/.test(claim.token) || !isTimeOrNull(claim.expiresAt) || claim.expiresAt === null))) {
    throw new Error("Global memory dream state is corrupt; repair explicitly");
  }
  return structuredClone(state) as unknown as GlobalMemoryDreamState;
}

function isTimeOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}
