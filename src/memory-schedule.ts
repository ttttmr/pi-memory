import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  mutateMemoryScheduleData, readMemoryScheduleData, type MemoryStoreHandle,
} from "./memory-store.ts";

const DREAM_TURN_THRESHOLD = 8;
const DREAM_LEASE_MILLISECONDS = 120_000;
const MAX_SCHEDULE_SESSIONS = 1000;

/** Persistent turn counts are project-wide; due means at least eight unprocessed completed turns. */
export interface MemoryScheduleSnapshot {
  observedTurns: number;
  processedTurns: number;
  pendingTurns: number;
  due: boolean;
}

/** A dream claim leases only its captured generation, with an expiry in Unix epoch milliseconds. */
export interface MemoryDreamClaim {
  ownerId: string;
  token: string;
  generation: number;
  expiresAt: number;
}

interface MemoryScheduleState {
  observedTurns: number;
  processedTurns: number;
  sessions: { sessionId: string; entryId: string }[];
  claim: MemoryDreamClaim | null;
}

/** Record a completed turn once per latest session leaf, even across process and session restarts. */
export async function recordMemoryTurn(
  handle: MemoryStoreHandle,
  turn: { sessionId: string; entryId: string },
  signal?: AbortSignal,
): Promise<MemoryScheduleSnapshot> {
  requireProjectSchedule(handle);
  if (!turn || !isScheduleIdentifier(turn.sessionId) || !isScheduleIdentifier(turn.entryId)) {
    throw new Error("Memory schedule turn requires valid sessionId and entryId strings (at most 4096 characters)");
  }
  return mutateMemorySchedule(handle, (state) => {
    const previous = state.sessions.find((session) => session.sessionId === turn.sessionId);
    if (previous?.entryId !== turn.entryId) {
      if (!previous && state.sessions.length >= MAX_SCHEDULE_SESSIONS) {
        throw new Error("Memory schedule session capacity reached (1000 sessions); no turn records were discarded");
      }
      if (!Number.isSafeInteger(state.observedTurns + 1)) throw new Error("Memory schedule turn counter capacity reached");
      if (previous) previous.entryId = turn.entryId;
      else state.sessions.push({ sessionId: turn.sessionId, entryId: turn.entryId });
      state.observedTurns++;
    }
    return scheduleSnapshot(state);
  }, signal);
}

/** Read pending dream work without creating a memory library or modifying an expired lease. */
export async function readMemorySchedule(handle: MemoryStoreHandle): Promise<MemoryScheduleSnapshot> {
  requireProjectSchedule(handle);
  return scheduleSnapshot(parseMemorySchedule(await readMemoryScheduleData(handle)));
}

/** Atomically lease dream work after eight pending turns, never stealing a live lease. */
export async function claimMemoryDream(
  handle: MemoryStoreHandle,
  options: { ownerId: string },
  signal?: AbortSignal,
): Promise<MemoryDreamClaim | null> {
  requireProjectSchedule(handle);
  if (!options || !isScheduleIdentifier(options.ownerId)) {
    throw new Error("Memory schedule claim requires a valid ownerId");
  }
  return mutateMemorySchedule(handle, (state) => {
    const now = Date.now();
    if (state.claim && state.claim.expiresAt > now) return null;
    if (!scheduleSnapshot(state).due) return null;
    const claim = {
      ownerId: options.ownerId,
      token: randomUUID(),
      generation: state.observedTurns,
      expiresAt: now + DREAM_LEASE_MILLISECONDS,
    };
    state.claim = claim;
    return { ...claim };
  }, signal);
}

/** Release only the matching claim; success acknowledges its captured generation, never subsequently observed turns. */
export async function finishMemoryDream(
  handle: MemoryStoreHandle,
  claim: MemoryDreamClaim,
  outcome: { success: boolean },
  signal?: AbortSignal,
): Promise<void> {
  requireProjectSchedule(handle);
  if (!isMemoryDreamClaim(claim) || !outcome || typeof outcome.success !== "boolean") {
    throw new Error("Memory schedule finish requires a valid claim and boolean success");
  }
  await mutateMemorySchedule(handle, (state) => {
    if (!state.claim || state.claim.ownerId !== claim.ownerId || state.claim.token !== claim.token ||
        state.claim.generation !== claim.generation || state.claim.expiresAt !== claim.expiresAt) {
      throw new Error("Memory schedule claim ownership mismatch; another runner's work was not changed");
    }
    if (outcome.success) state.processedTurns = Math.max(state.processedTurns, claim.generation);
    state.claim = null;
  }, signal);
}

function requireProjectSchedule(handle: MemoryStoreHandle): void {
  if (handle.scope !== "project") throw new Error("Memory schedule is available only for project memory");
}

function scheduleSnapshot(state: MemoryScheduleState): MemoryScheduleSnapshot {
  const pendingTurns = state.observedTurns - state.processedTurns;
  return {
    observedTurns: state.observedTurns,
    processedTurns: state.processedTurns,
    pendingTurns,
    due: pendingTurns >= DREAM_TURN_THRESHOLD,
  };
}

function mutateMemorySchedule<T>(
  handle: MemoryStoreHandle, mutation: (state: MemoryScheduleState) => T, signal?: AbortSignal,
): Promise<T> {
  return withFileMutationQueue(handle.path, () => mutateMemoryScheduleData(handle, (data) => {
    const state = parseMemorySchedule(data);
    return { data: state, result: mutation(state) };
  }, signal));
}

function parseMemorySchedule(data: unknown): MemoryScheduleState {
  if (data === null) return { observedTurns: 0, processedTurns: 0, sessions: [], claim: null };
  if (!hasScheduleKeys(data, ["observedTurns", "processedTurns", "sessions", "claim"]) ||
      !isScheduleCounter(data.observedTurns) || !isScheduleCounter(data.processedTurns) ||
      data.processedTurns > data.observedTurns || !Array.isArray(data.sessions) ||
      data.sessions.length > MAX_SCHEDULE_SESSIONS || data.sessions.length > data.observedTurns ||
      (data.observedTurns > 0 && data.sessions.length === 0) ||
      (data.claim !== null && (!isMemoryDreamClaim(data.claim) || data.claim.generation > data.observedTurns ||
        data.claim.generation < data.processedTurns))) {
    throw new Error("Memory schedule state is corrupt or has unknown fields; repair explicitly without discarding pending work");
  }
  const sessions: MemoryScheduleState["sessions"] = [];
  const seen = new Set<string>();
  for (const session of data.sessions) {
    if (!hasScheduleKeys(session, ["sessionId", "entryId"]) || !isScheduleIdentifier(session.sessionId) ||
        !isScheduleIdentifier(session.entryId) || seen.has(session.sessionId)) {
      throw new Error("Memory schedule session state is corrupt; repair explicitly without discarding pending work");
    }
    seen.add(session.sessionId);
    sessions.push({ sessionId: session.sessionId, entryId: session.entryId });
  }
  return {
    observedTurns: data.observedTurns,
    processedTurns: data.processedTurns,
    sessions,
    claim: data.claim === null ? null : { ...data.claim as MemoryDreamClaim },
  };
}

function hasScheduleKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isScheduleIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !value.includes("\0") && Buffer.from(value).toString("utf8") === value;
}

function isScheduleCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMemoryDreamClaim(value: unknown): value is MemoryDreamClaim {
  return hasScheduleKeys(value, ["ownerId", "token", "generation", "expiresAt"]) &&
    isScheduleIdentifier(value.ownerId) && typeof value.token === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.token) &&
    isScheduleCounter(value.generation) && isScheduleCounter(value.expiresAt);
}
