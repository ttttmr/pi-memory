import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
  mutateMemoryScheduleData, readMemoryScheduleData, type MemoryStoreHandle,
} from "./memory-store.ts";

const DREAM_USER_MESSAGE_THRESHOLD = 50;
// Cover the thirty-minute worker timeout plus setup and cleanup.
const DREAM_LEASE_MILLISECONDS = 1_830_000;
const MAX_SCHEDULE_SESSIONS = 1000;

/** Project-wide counters count actual user messages, not completed assistant turns. */
export interface MemoryScheduleSnapshot {
  observedTurns: number;
  processedTurns: number;
  pendingTurns: number;
  due: boolean;
  legacyPendingTurns?: number;
}

/** A captured session reference is host-provided, never a model-selected source path. */
export interface MemoryDreamSession {
  sessionId: string;
  sessionFile?: string;
}

/** A dream claim leases its captured user-message generation and session batch. */
export interface MemoryDreamClaim {
  ownerId: string;
  token: string;
  generation: number;
  expiresAt: number;
  sessions: MemoryDreamSession[];
}

type LegacyClaim = Omit<MemoryDreamClaim, "sessions">;
interface LegacyScheduleState {
  observedTurns: number;
  processedTurns: number;
  sessions: { sessionId: string; entryId: string }[];
  claim: LegacyClaim | null;
}
interface MemoryScheduleState {
  version: 2;
  observedTurns: number;
  processedTurns: number;
  messages: (MemoryDreamSession & { entryId: string })[];
  legacy: LegacyScheduleState | null;
  claim: MemoryDreamClaim | null;
}

/** Record an actual user message once by session/entry ID, including old branch replays. */
export async function recordMemoryTurn(
  handle: MemoryStoreHandle,
  turn: MemoryDreamSession & { entryId: string },
  signal?: AbortSignal,
): Promise<MemoryScheduleSnapshot> {
  requireProjectSchedule(handle);
  if (!isSessionReference(turn, ["entryId"]) || !isScheduleIdentifier(turn.entryId)) {
    throw new Error("Memory schedule user message requires valid sessionId and entryId strings (at most 4096 characters) and optional sessionFile");
  }
  return mutateMemorySchedule(handle, (state) => {
    if (!state.messages.some((message) => message.sessionId === turn.sessionId && message.entryId === turn.entryId)) {
      const sessions = new Set(state.messages.map((message) => message.sessionId));
      if (!sessions.has(turn.sessionId) && sessions.size >= MAX_SCHEDULE_SESSIONS) {
        throw new Error("Memory schedule session capacity reached (1000 sessions); no user message records were discarded");
      }
      if (!Number.isSafeInteger(state.observedTurns + 1)) throw new Error("Memory schedule user message counter capacity reached");
      state.messages.push({ ...turn });
      state.observedTurns++;
    }
    return scheduleSnapshot(state);
  }, signal);
}

/** Read pending work without creating a library, migrating on disk, or modifying leases. */
export async function readMemorySchedule(handle: MemoryStoreHandle): Promise<MemoryScheduleSnapshot> {
  requireProjectSchedule(handle);
  return scheduleSnapshot(parseMemorySchedule(await readMemoryScheduleData(handle)));
}

/** Read a live current or legacy lease without creating storage or modifying expired work. */
export async function hasActiveMemoryDream(handle: MemoryStoreHandle): Promise<boolean> {
  requireProjectSchedule(handle);
  const state = parseMemorySchedule(await readMemoryScheduleData(handle));
  const now = Date.now();
  return Boolean((state.claim && state.claim.expiresAt > now) ||
    (state.legacy?.claim && state.legacy.claim.expiresAt > now));
}

/** Atomically lease fifty pending user messages (or explicitly preserved legacy work). */
export async function claimMemoryDream(
  handle: MemoryStoreHandle,
  options: { ownerId: string },
  signal?: AbortSignal,
): Promise<MemoryDreamClaim | null> {
  requireProjectSchedule(handle);
  if (!options || !isScheduleIdentifier(options.ownerId)) throw new Error("Memory schedule claim requires a valid ownerId");
  return mutateMemorySchedule(handle, (state) => {
    const now = Date.now();
    if ((state.claim && state.claim.expiresAt > now) || (state.legacy?.claim && state.legacy.claim.expiresAt > now)) return null;
    if (!scheduleSnapshot(state).due) return null;
    const sessions = new Map<string, MemoryDreamSession>();
    if (state.legacy && state.legacy.observedTurns > state.legacy.processedTurns) {
      for (const session of state.legacy.sessions) sessions.set(session.sessionId, { sessionId: session.sessionId });
    }
    for (const message of state.messages.slice(state.processedTurns)) {
      sessions.set(message.sessionId, { sessionId: message.sessionId, ...(message.sessionFile ? { sessionFile: message.sessionFile } : {}) });
    }
    const claim: MemoryDreamClaim = {
      ownerId: options.ownerId, token: randomUUID(), generation: state.observedTurns,
      expiresAt: now + DREAM_LEASE_MILLISECONDS, sessions: [...sessions.values()],
    };
    state.claim = claim;
    return structuredClone(claim);
  }, signal);
}

/** Success consumes only the captured batch; failure keeps every message and legacy reference. */
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
        state.claim.generation !== claim.generation || state.claim.expiresAt !== claim.expiresAt ||
        state.claim.sessions.length !== claim.sessions.length || state.claim.sessions.some((session, index) =>
          session.sessionId !== claim.sessions[index]?.sessionId || session.sessionFile !== claim.sessions[index]?.sessionFile)) {
      throw new Error("Memory schedule claim ownership mismatch; another runner's work was not changed");
    }
    if (outcome.success) {
      state.processedTurns = Math.max(state.processedTurns, claim.generation);
      state.legacy = null;
    }
    state.claim = null;
  }, signal);
}

function requireProjectSchedule(handle: MemoryStoreHandle): void {
  if (handle.scope !== "project") throw new Error("Memory schedule is available only for project memory");
}

function scheduleSnapshot(state: MemoryScheduleState): MemoryScheduleSnapshot {
  const pendingTurns = state.observedTurns - state.processedTurns;
  const legacyPendingTurns = state.legacy ? state.legacy.observedTurns - state.legacy.processedTurns : 0;
  return {
    observedTurns: state.observedTurns, processedTurns: state.processedTurns, pendingTurns,
    due: pendingTurns >= DREAM_USER_MESSAGE_THRESHOLD || legacyPendingTurns > 0,
    ...(legacyPendingTurns ? { legacyPendingTurns } : {}),
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

function emptyMemorySchedule(): MemoryScheduleState {
  return { version: 2, observedTurns: 0, processedTurns: 0, messages: [], legacy: null, claim: null };
}

function parseMemorySchedule(data: unknown): MemoryScheduleState {
  if (data === null) return emptyMemorySchedule();
  if (isLegacySchedule(data)) return { ...emptyMemorySchedule(), legacy: structuredClone(data) };
  if (!hasScheduleKeys(data, ["version", "observedTurns", "processedTurns", "messages", "legacy", "claim"]) ||
      data.version !== 2 || !isScheduleCounter(data.observedTurns) || !isScheduleCounter(data.processedTurns) ||
      data.processedTurns > data.observedTurns || !Array.isArray(data.messages) || data.messages.length !== data.observedTurns ||
      (data.legacy !== null && !isLegacySchedule(data.legacy)) ||
      (data.claim !== null && (!isMemoryDreamClaim(data.claim) || data.claim.generation > data.observedTurns ||
        data.claim.generation < data.processedTurns))) {
    throw new Error("Memory schedule state is corrupt or has unknown fields; repair explicitly without discarding pending work");
  }
  const seen = new Set<string>();
  const sessions = new Set<string>();
  for (const message of data.messages) {
    if (!isSessionReference(message, ["entryId"]) || !isScheduleIdentifier(message.entryId)) {
      throw new Error("Memory schedule user message state is corrupt; repair explicitly without discarding pending work");
    }
    const id = JSON.stringify([message.sessionId, message.entryId]);
    if (seen.has(id)) throw new Error("Memory schedule duplicate user message state is corrupt");
    seen.add(id);
    sessions.add(message.sessionId);
  }
  if (sessions.size > MAX_SCHEDULE_SESSIONS) throw new Error("Memory schedule session state exceeds 1000 sessions");
  return structuredClone(data) as unknown as MemoryScheduleState;
}

function isLegacySchedule(data: unknown): data is LegacyScheduleState {
  if (!hasScheduleKeys(data, ["observedTurns", "processedTurns", "sessions", "claim"]) ||
      !isScheduleCounter(data.observedTurns) || !isScheduleCounter(data.processedTurns) ||
      data.processedTurns > data.observedTurns || !Array.isArray(data.sessions) ||
      data.sessions.length > MAX_SCHEDULE_SESSIONS || data.sessions.length > data.observedTurns ||
      (data.observedTurns > 0 && data.sessions.length === 0) ||
      (data.claim !== null && (!isLegacyClaim(data.claim) || data.claim.generation > data.observedTurns || data.claim.generation < data.processedTurns))) return false;
  const seen = new Set<string>();
  for (const session of data.sessions) {
    if (!hasScheduleKeys(session, ["sessionId", "entryId"]) || !isScheduleIdentifier(session.sessionId) ||
        !isScheduleIdentifier(session.entryId) || seen.has(session.sessionId)) return false;
    seen.add(session.sessionId);
  }
  return true;
}

function hasScheduleKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isSessionReference(value: unknown, extraKeys: string[] = []): value is MemoryDreamSession & Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const keys = ["sessionId", ...extraKeys, ...(Object.hasOwn(value, "sessionFile") ? ["sessionFile"] : [])];
  return hasScheduleKeys(value, keys) && isScheduleIdentifier(value.sessionId) &&
    (!Object.hasOwn(value, "sessionFile") || isScheduleIdentifier(value.sessionFile));
}

function isScheduleIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !value.includes("\0") && Buffer.from(value).toString("utf8") === value;
}

function isScheduleCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isLegacyClaim(value: unknown): value is LegacyClaim {
  return hasScheduleKeys(value, ["ownerId", "token", "generation", "expiresAt"]) && validClaimFields(value);
}

function validClaimFields(value: Record<string, unknown>): boolean {
  return isScheduleIdentifier(value.ownerId) && typeof value.token === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.token) &&
    isScheduleCounter(value.generation) && isScheduleCounter(value.expiresAt);
}

function isMemoryDreamClaim(value: unknown): value is MemoryDreamClaim {
  if (!hasScheduleKeys(value, ["ownerId", "token", "generation", "expiresAt", "sessions"]) || !validClaimFields(value) ||
      !Array.isArray(value.sessions) || value.sessions.length > MAX_SCHEDULE_SESSIONS * 2) return false;
  const seen = new Set<string>();
  for (const session of value.sessions) {
    if (!isSessionReference(session) || seen.has(session.sessionId)) return false;
    seen.add(session.sessionId);
  }
  return true;
}
