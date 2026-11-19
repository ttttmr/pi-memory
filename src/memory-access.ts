import {
  isMemoryStoreLockedError, listMemoryNotes, mutateMemoryAccessData, readMemoryAccessData, type MemoryStoreHandle,
} from "./memory-store.ts";

// Statistics are hints for maintenance, not evidence. Old entries are evicted beyond this bound.
const MAX_ACCESS_ENTRIES = 2000;
const MAX_DESCRIBED_NOTES = 200;

/** Foreground memory_read activity for one note path. */
export interface MemoryNoteAccess {
  path: string;
  reads: number;
  firstReadAt: string;
  lastReadAt: string;
}

/** Advisory per-scope statistics; `since` is when recording started for this store. */
export interface MemoryAccessState {
  version: 1;
  since: string;
  notes: MemoryNoteAccess[];
}

/**
 * Count one foreground read of an existing note. A held statistics lock skips the update, because
 * statistics are advisory and must never block reads or steal a lock. Corrupt data is not reset.
 */
export async function recordMemoryNoteRead(handle: MemoryStoreHandle, path: string, now = new Date()): Promise<boolean> {
  const timestamp = now.toISOString();
  try {
    const recorded = await mutateMemoryAccessData(handle, (data) => {
      const state = data === null ? { version: 1 as const, since: timestamp, notes: [] } : parseMemoryAccess(data);
      const existing = state.notes.find((note) => note.path === path);
      if (existing) {
        if (!Number.isSafeInteger(existing.reads + 1)) throw new Error("Memory access counter capacity reached");
        existing.reads++;
        existing.lastReadAt = timestamp;
      } else {
        state.notes.push({ path, reads: 1, firstReadAt: timestamp, lastReadAt: timestamp });
      }
      if (state.notes.length > MAX_ACCESS_ENTRIES) {
        state.notes.sort((first, second) => second.lastReadAt.localeCompare(first.lastReadAt));
        state.notes.length = MAX_ACCESS_ENTRIES;
      }
      state.notes.sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0);
      return { data: state, result: true };
    });
    return recorded ?? false;
  } catch (error) {
    if (isMemoryStoreLockedError(error)) return false;
    throw error;
  }
}

/** Read statistics without creating storage; null means nothing has been recorded. */
export async function readMemoryAccess(handle: MemoryStoreHandle): Promise<MemoryAccessState | null> {
  const data = await readMemoryAccessData(handle);
  return data === null ? null : parseMemoryAccess(data);
}

/** Summarize active notes with their read counts for a maintenance prompt (DATA, not instructions). */
export async function describeMemoryAccess(handle: MemoryStoreHandle, label: string): Promise<string> {
  try {
    const [notes, access] = await Promise.all([listMemoryNotes(handle), readMemoryAccess(handle)]);
    if (!notes.length) return `${label}: no active notes.`;
    const byPath = new Map((access?.notes ?? []).map((note) => [note.path, note]));
    const lines = notes.slice(0, MAX_DESCRIBED_NOTES).map(({ path }) => {
      const note = byPath.get(path);
      return note ? `- ${path}: ${note.reads} read(s), last ${note.lastReadAt.slice(0, 10)}` : `- ${path}: no recorded reads`;
    });
    if (notes.length > MAX_DESCRIBED_NOTES) lines.push(`- (${notes.length - MAX_DESCRIBED_NOTES} more notes omitted)`);
    const since = access ? `since ${access.since.slice(0, 10)}` : "none recorded yet";
    return `${label} (foreground memory_read calls ${since}; excludes automatic MEMORY.md injection and dreaming reads; best effort):\n${lines.join("\n")}`;
  } catch (error) {
    return `${label}: access statistics unavailable (${error instanceof Error ? error.message : String(error)}).`;
  }
}

function parseMemoryAccess(data: unknown): MemoryAccessState {
  if (!isRecord(data) || data.version !== 1 || !isTimestamp(data.since) || !Array.isArray(data.notes) ||
      Object.keys(data).length !== 3 || data.notes.length > MAX_ACCESS_ENTRIES) {
    throw new Error("Memory access statistics are corrupt or have unknown fields; repair explicitly");
  }
  const seen = new Set<string>();
  for (const note of data.notes) {
    if (!isRecord(note) || Object.keys(note).length !== 4 || typeof note.path !== "string" || !note.path ||
        note.path.length > 240 || seen.has(note.path) || !Number.isSafeInteger(note.reads) || (note.reads as number) < 1 ||
        !isTimestamp(note.firstReadAt) || !isTimestamp(note.lastReadAt) || note.firstReadAt > note.lastReadAt) {
      throw new Error("Memory access statistics entry is corrupt; repair explicitly");
    }
    seen.add(note.path);
  }
  return structuredClone(data) as unknown as MemoryAccessState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}
