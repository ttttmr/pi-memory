import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { MemoryScope } from "./memory-schema.ts";
import {
  defaultLocalMemoryMapPath, discoverMatchingMemoryStores, legacyProjectDirectoryName, memoryStoreDirectoryName,
  resolveMemoryLegacyCandidates, resolveMemoryProject, resolveMemoryProjectDetails,
  writeLocalMemoryIdentity,
  type DiscoveredMergeSource, type MemoryLegacyCandidate, type MemoryProjectResolution, type ResolveMemoryProjectOptions,
} from "./memory-project.ts";

export type { MemoryScope } from "./memory-schema.ts";
export {
  defaultLocalMemoryMapPath, discoverMatchingMemoryStores, legacyProjectDirectoryName, memoryStoreDirectoryName,
  resolveMemoryProject, resolveMemoryProjectDetails,
  type DiscoveredMergeSource, type MemoryLegacyCandidate, type MemoryProjectResolution, type ResolveMemoryProjectOptions,
};

/** Identifies an existing cross-process store lock without changing the original error message. */
export class MemoryStoreLockedError extends Error {
  readonly lockPath: string;
  constructor(lockPath: string) {
    super(`Memory store locked: ${lockPath}. Retry after the writer finishes; never remove a lock while a writer may be running.`);
    this.name = "MemoryStoreLockedError";
    this.lockPath = lockPath;
  }
}

/** Returns true only for a live store-lock conflict, not corruption or identity failures. */
export function isMemoryStoreLockedError(error: unknown): error is MemoryStoreLockedError {
  return error instanceof MemoryStoreLockedError;
}

const MAX_NOTE_BYTES = 64 * 1024;
const MAX_INDEX_BYTES = 8 * 1024;
const MAX_ACTIVE_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE_FILES = 500;
const MAX_HISTORY_FILES = 1000;
const IDENTITY_FILE = ".identity.json";
const SCHEDULE_FILE = ".dream-state.json";
const MAX_SCHEDULE_BYTES = 1024 * 1024;
const MERGE_STATE_FILE = ".merge-state.json";
const MAX_MERGE_STATE_BYTES = 1024 * 1024;
const MERGED_LEGACY_DIR = ".merged-legacy";
const MERGE_MANIFEST_FILE = ".merge-manifest.json";
const ACCESS_FILE = ".access.json";
const MAX_ACCESS_BYTES = 1024 * 1024;

/** A memory document hash is SHA-256 of its exact UTF-8 content, not its path. */
export interface MemoryDocument { path: string; content: string; hash: string }
/** The memory directory is also the Pi file mutation queue key. */
export interface MemoryStoreHandle {
  directory: string;
  path: string;
  identity: string;
  scope: MemoryScope;
  /** Ordered prior directories/identities checked for read fallback and write-time migration. */
  legacyCandidates?: readonly MemoryLegacyCandidate[];
  /** Optional device-local identity map path (outside synced memory root) updated after writes. */
  localMapPath?: string;
  /** Canonical local repository paths bound to this identity in the device-local map. */
  localKeys?: readonly string[];
}

/** Optional migration and local-map metadata attached to a project store handle. */
export interface MemoryStoreHandleOptions {
  legacyCandidates?: readonly MemoryLegacyCandidate[];
  localMapPath?: string;
  localKeys?: readonly string[];
}

/** Resolve a project directory into a store handle with migration candidates and optional local map binding. */
export async function resolveMemoryProjectHandle(
  root: string,
  cwd: string,
  options: ResolveMemoryProjectOptions & { localMapPath?: string; bindLocalMap?: boolean } = {},
): Promise<{ handle: MemoryStoreHandle; project: MemoryProjectResolution }> {
  const project = await resolveMemoryProjectDetails(cwd, options);
  const legacyCandidates = await resolveMemoryLegacyCandidates(root, project, options.localMapPath);
  const handle = createMemoryStoreHandle(root, project.identity, "project", {
    legacyCandidates,
    ...(options.bindLocalMap && options.localMapPath ? {
      localMapPath: options.localMapPath,
      localKeys: [project.localIdentity],
    } : {}),
  });
  return { handle, project };
}

/** Creating a memory handle performs no I/O; files appear on the first successful write. */
export function createMemoryStoreHandle(
  root: string,
  project: string,
  scope: MemoryScope,
  options?: MemoryStoreHandleOptions,
): MemoryStoreHandle {
  if (typeof root !== "string" || !root || root.includes("\0") ||
      typeof project !== "string" || !project || project.length > 4096 ||
      Buffer.from(project).toString("utf8") !== project ||
      (scope !== "project" && scope !== "global")) throw new Error("Memory handle requires a root, project and valid scope");
  const identity = scope === "global" ? "global" : project;
  const name = memoryStoreDirectoryName(identity, scope);
  const directory = join(resolve(root), name);
  if (scope === "global" || !options) return { directory, path: directory, identity, scope };
  return {
    directory,
    path: directory,
    identity,
    scope,
    ...(options.legacyCandidates?.length ? { legacyCandidates: options.legacyCandidates.map((candidate) => ({ ...candidate })) } : {}),
    ...(options.localMapPath ? { localMapPath: options.localMapPath } : {}),
    ...(options.localKeys?.length ? { localKeys: [...options.localKeys] } : {}),
  };
}

/** Missing notes return null without creating directories; unsafe paths and identity mismatches fail closed. */
export async function readMemoryNote(handle: MemoryStoreHandle, path: string): Promise<MemoryDocument | null> {
  validateMemoryPath(path);
  const directory = await resolveReadableMemoryDirectory(handle);
  if (!directory) return null;
  return readMemoryDocument(directory, path);
}

/** The model maintains this bounded index itself; there is no automatic index generator. */
export async function readMemoryIndex(handle: MemoryStoreHandle): Promise<MemoryDocument | null> {
  return readMemoryNote(handle, "MEMORY.md");
}

/** List active Markdown recursively in path order, excluding all hidden files and directories. */
export async function listMemoryNotes(handle: MemoryStoreHandle): Promise<MemoryDocument[]> {
  const directory = await resolveReadableMemoryDirectory(handle);
  if (!directory) return [];
  return listMemoryDocuments(directory);
}

/** Read hidden dream scheduling metadata without creating storage; null means the file is absent. */
export async function readMemoryScheduleData(handle: MemoryStoreHandle): Promise<unknown | null> {
  const directory = await resolveReadableMemoryDirectory(handle);
  if (!directory) return null;
  const content = await readMemoryFile(join(directory, SCHEDULE_FILE), MAX_SCHEDULE_BYTES);
  if (content === null) return null;
  const data: unknown = JSON.parse(content);
  if (data === null) throw new Error("Memory schedule data cannot be JSON null");
  return data;
}

/** Mutate hidden dream scheduling metadata under the store lock, without Markdown history snapshots. */
export async function mutateMemoryScheduleData<T>(
  handle: MemoryStoreHandle,
  mutation: (
    data: unknown | null,
    context: { hasActiveMerge: () => Promise<boolean> },
  ) => Promise<{ data: unknown; result: T }> | { data: unknown; result: T },
  signal?: AbortSignal,
): Promise<T> {
  return withMemoryLock(handle, async () => {
    const current = await readMemoryScheduleData(handle);
    const { data, result } = await mutation(current, {
      hasActiveMerge: () => handle.scope === "project"
        ? hasActiveMergeLeaseAtDirectory(handle.directory)
        : Promise.resolve(false),
    });
    const content = JSON.stringify(data);
    if (content === undefined || data === null) throw new Error("Memory schedule data must serialize to non-null JSON");
    if (Buffer.byteLength(content + "\n") > MAX_SCHEDULE_BYTES) throw new Error("Memory schedule data exceeds 1 MiB");
    if (content !== JSON.stringify(current)) {
      await atomicMemoryWrite(join(handle.directory, SCHEDULE_FILE), content + "\n", signal);
    }
    return result;
  }, signal);
}

/** Read hidden store-merge scheduling metadata without creating storage; null means the file is absent. */
export async function readMemoryMergeData(handle: MemoryStoreHandle): Promise<unknown | null> {
  const directory = await resolveReadableMemoryDirectory(handle);
  if (!directory) return null;
  const content = await readMemoryFile(join(directory, MERGE_STATE_FILE), MAX_MERGE_STATE_BYTES);
  if (content === null) return null;
  const data: unknown = JSON.parse(content);
  if (data === null) throw new Error("Memory merge data cannot be JSON null");
  return data;
}

/** Mutate hidden store-merge metadata under the store lock, without Markdown history snapshots. */
export async function mutateMemoryMergeData<T>(
  handle: MemoryStoreHandle,
  mutation: (
    data: unknown | null,
    context: { hasActiveDream: () => Promise<boolean> },
  ) => Promise<{ data: unknown; result: T }> | { data: unknown; result: T },
  signal?: AbortSignal,
): Promise<T> {
  return withMemoryLock(handle, async () => {
    const current = await readMemoryMergeData(handle);
    const { data, result } = await mutation(current, {
      hasActiveDream: () => hasActiveDreamLeaseAtDirectory(handle.directory),
    });
    const content = JSON.stringify(data);
    if (content === undefined || data === null) throw new Error("Memory merge data must serialize to non-null JSON");
    if (Buffer.byteLength(content + "\n") > MAX_MERGE_STATE_BYTES) throw new Error("Memory merge data exceeds 1 MiB");
    if (content !== JSON.stringify(current)) {
      await atomicMemoryWrite(join(handle.directory, MERGE_STATE_FILE), content + "\n", signal);
    }
    return result;
  }, signal);
}

/** Read whether the primary store directory itself already exists and passes identity validation. */
export async function hasPrimaryMemoryStore(handle: MemoryStoreHandle): Promise<boolean> {
  if (!await validateMemoryNamespace(handle)) return false;
  try {
    const stat = await lstat(handle.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Memory store directory is unsafe");
  } catch (error) {
    if (hasMemoryErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  await validateMemoryIdentityAt(handle.directory, handle.identity, handle.scope);
  return true;
}

/** Read active Markdown notes at a verified project store directory (for read-only merge inspection). */
export async function listMemoryNotesAtDirectory(directory: string, expectedIdentity: string): Promise<MemoryDocument[]> {
  await validateMemoryIdentityAt(directory, expectedIdentity, "project");
  return listMemoryDocuments(directory);
}

/** Read hidden `.dream-state.json` directly from a verified store or archived directory without creating files. */
export async function readMemoryScheduleDataAtDirectory(directory: string): Promise<unknown | null> {
  const content = await readMemoryFile(join(directory, SCHEDULE_FILE), MAX_SCHEDULE_BYTES);
  if (content === null) return null;
  const data: unknown = JSON.parse(content);
  if (data === null) throw new Error("Memory schedule data cannot be JSON null");
  return data;
}

/** Check whether a store directory currently holds a live background dream lease. */
export async function hasActiveDreamLeaseAtDirectory(directory: string): Promise<boolean> {
  const content = await readMemoryFile(join(directory, SCHEDULE_FILE), MAX_SCHEDULE_BYTES);
  if (content === null) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch (error) {
    throw new Error("Memory migration refused: previous schedule state is corrupt; repair explicitly before migrating", { cause: error });
  }
  return schedulePayloadHasLiveClaim(parsed, Date.now());
}

/** Atomically promote one sibling/legacy directory to the primary store if the primary store does not exist yet. */
export async function promoteLegacyMemoryStore(
  primaryHandle: MemoryStoreHandle,
  source: { directory: string; identity: string },
  signal?: AbortSignal,
): Promise<"promoted" | "primary_exists" | "source_missing" | "busy" | "active_dream"> {
  signal?.throwIfAborted();
  if (primaryHandle.scope !== "project" || dirname(source.directory) !== dirname(primaryHandle.directory) ||
      source.directory === primaryHandle.directory) {
    throw new Error("Memory legacy promotion requires a sibling project directory under the same root");
  }
  await validateMemoryNamespace(primaryHandle, true);
  const sourceLock = `${source.directory}.lock`;
  const primaryLock = `${primaryHandle.directory}.lock`;
  const [firstLock, secondLock] = sourceLock < primaryLock ? [sourceLock, primaryLock] : [primaryLock, sourceLock];
  try { await acquireMemoryLock(firstLock); }
  catch (error) {
    if (isMemoryStoreLockedError(error)) return "busy";
    throw error;
  }
  try { await acquireMemoryLock(secondLock); }
  catch (error) {
    await rmdir(firstLock);
    if (isMemoryStoreLockedError(error)) return "busy";
    throw error;
  }
  try {
    signal?.throwIfAborted();
    try {
      const primaryStat = await lstat(primaryHandle.directory);
      if (!primaryStat.isDirectory() || primaryStat.isSymbolicLink()) throw new Error("Memory store directory is unsafe");
      await validateMemoryIdentityAt(primaryHandle.directory, primaryHandle.identity, "project");
      return "primary_exists";
    } catch (error) {
      if (!hasMemoryErrorCode(error, "ENOENT")) throw error;
    }
    try {
      const sourceStat = await lstat(source.directory);
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Memory store directory is unsafe");
    } catch (error) {
      if (hasMemoryErrorCode(error, "ENOENT")) return "source_missing";
      throw error;
    }
    await validateMemoryIdentityAt(source.directory, source.identity, "project");
    if (await hasActiveDreamLeaseAtDirectory(source.directory)) return "active_dream";
    signal?.throwIfAborted();
    await rename(source.directory, primaryHandle.directory);
    await syncMemoryDirectory(dirname(primaryHandle.directory));
    await atomicMemoryWrite(join(primaryHandle.directory, IDENTITY_FILE),
      JSON.stringify({ identity: primaryHandle.identity, scope: "project" }) + "\n", signal);
    await updateLocalMemoryMapBestEffort(primaryHandle);
    return "promoted";
  } finally {
    await rmdir(secondLock);
    await rmdir(firstLock);
  }
}

/** Result of atomically archiving a consolidated legacy/sibling store into `<primary>/.merged-legacy/`. */
export type ArchiveLegacyStoreResult =
  | { status: "archived"; archivePath: string }
  | { status: "missing" }
  | { status: "busy" }
  | { status: "active_dream" }
  | { status: "modified" };

/**
 * Atomically move a consolidated legacy/sibling store into `<primary>/.merged-legacy/` only after
 * verifying its identity, absence of an active dream lease, and unchanged active-note fingerprint.
 */
export async function archiveLegacyMemoryStore(
  primaryHandle: MemoryStoreHandle,
  source: { directory: string; identity: string },
  options: { expectedFingerprint: string; mode: "llm" | "empty-auto"; notePaths: readonly string[] },
  signal?: AbortSignal,
): Promise<ArchiveLegacyStoreResult> {
  signal?.throwIfAborted();
  if (primaryHandle.scope !== "project" || dirname(source.directory) !== dirname(primaryHandle.directory) ||
      source.directory === primaryHandle.directory) {
    throw new Error("Memory legacy archival requires a sibling project directory under the same root");
  }
  await validateMemoryNamespace(primaryHandle, false);
  const sourceLock = `${source.directory}.lock`;
  try { await acquireMemoryLock(sourceLock); }
  catch (error) {
    if (isMemoryStoreLockedError(error)) return { status: "busy" };
    throw error;
  }
  try {
    signal?.throwIfAborted();
    try {
      const sourceStat = await lstat(source.directory);
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error("Memory store directory is unsafe");
    } catch (error) {
      if (hasMemoryErrorCode(error, "ENOENT")) return { status: "missing" };
      throw error;
    }
    await validateMemoryIdentityAt(source.directory, source.identity, "project");
    if (await hasActiveDreamLeaseAtDirectory(source.directory)) return { status: "active_dream" };
    const currentNotes = await listMemoryDocuments(source.directory);
    if (memoryNotesFingerprint(currentNotes) !== options.expectedFingerprint) {
      return { status: "modified" };
    }
    await validateMemoryIdentityAt(primaryHandle.directory, primaryHandle.identity, "project");
    await ensureMemoryDirectories(primaryHandle.directory, MERGED_LEGACY_DIR);
    const archivedAt = new Date().toISOString();
    const compactTimestamp = archivedAt.replace(/[:.]/g, "-");
    const sourceDirectoryName = basename(source.directory);
    const archivePath = join(primaryHandle.directory, MERGED_LEGACY_DIR, `${sourceDirectoryName}-${compactTimestamp}-${randomUUID().slice(0, 8)}`);
    signal?.throwIfAborted();
    await rename(source.directory, archivePath);
    await syncMemoryDirectory(dirname(source.directory));
    await syncMemoryDirectory(join(primaryHandle.directory, MERGED_LEGACY_DIR));
    const manifest = {
      version: 1,
      archivedAt,
      mode: options.mode,
      sourceDirectoryName,
      sourceIdentity: source.identity,
      targetIdentity: primaryHandle.identity,
      noteCount: currentNotes.length,
      notePaths: [...options.notePaths],
      fingerprint: options.expectedFingerprint,
    };
    await atomicMemoryWrite(join(archivePath, MERGE_MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n").catch(() => {});
    return { status: "archived", archivePath };
  } finally {
    await rmdir(sourceLock);
  }
}

/** Read advisory note-access statistics without creating storage; null means none were recorded. */
export async function readMemoryAccessData(handle: MemoryStoreHandle): Promise<unknown | null> {
  const directory = await resolveReadableMemoryDirectory(handle);
  if (!directory) return null;
  const content = await readMemoryFile(join(directory, ACCESS_FILE), MAX_ACCESS_BYTES);
  return content === null ? null : JSON.parse(content) as unknown;
}

/**
 * Mutate advisory access statistics in an existing store. A separate lock keeps statistics from
 * blocking note or schedule writes; a missing store returns undefined and is never created or migrated.
 */
export async function mutateMemoryAccessData<T>(
  handle: MemoryStoreHandle,
  mutation: (data: unknown | null) => { data: unknown; result: T },
  signal?: AbortSignal,
): Promise<T | undefined> {
  signal?.throwIfAborted();
  const directory = await resolveReadableMemoryDirectory(handle);
  if (!directory) return undefined;
  const lockPath = `${directory}.access.lock`;
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (hasMemoryErrorCode(error, "EEXIST")) throw new MemoryStoreLockedError(lockPath);
    throw error;
  }
  try {
    const existingText = await readMemoryFile(join(directory, ACCESS_FILE), MAX_ACCESS_BYTES);
    const { data, result } = mutation(existingText === null ? null : JSON.parse(existingText) as unknown);
    const content = JSON.stringify(data);
    if (content === undefined || data === null) throw new Error("Memory access data must serialize to non-null JSON");
    if (Buffer.byteLength(content + "\n") > MAX_ACCESS_BYTES) throw new Error("Memory access statistics exceed 1 MiB");
    await atomicMemoryWrite(join(directory, ACCESS_FILE), content + "\n", signal);
    return result;
  } finally {
    await rmdir(lockPath);
  }
}

/** Fingerprint active Markdown paths and content hashes, e.g. to detect changes between maintenance passes. */
export function memoryNotesFingerprint(documents: MemoryDocument[]): string {
  return memoryContentHash(documents.map((document) => `${document.path}\0${document.hash}`).join("\n"));
}

/** Atomic Markdown writes use create-only null or an exact hash; every replaced version is retained. */
export async function writeMemoryNote(
  handle: MemoryStoreHandle,
  input: { path: string; content: string; expectedHash: string | null },
  signal?: AbortSignal,
): Promise<MemoryDocument> {
  if (!input || typeof input !== "object") throw new Error("Memory write input must be an object");
  validateMemoryPath(input.path);
  validateMemoryContent(input.path, input.content);
  validateMemoryExpectedHash(input.expectedHash);
  return withMemoryLock(handle, async () => {
    const current = await readMemoryDocument(handle.directory, input.path);
    requireMemoryHash(current, input.expectedHash);
    const document = { path: input.path, content: input.content, hash: memoryContentHash(input.content) };
    if (current?.content === input.content) return current;
    const documents = await listMemoryDocuments(handle.directory);
    const nextCount = documents.length + (current ? 0 : 1);
    const nextBytes = documents.reduce((total, note) => total + Buffer.byteLength(note.content), 0) -
      (current ? Buffer.byteLength(current.content) : 0) + Buffer.byteLength(input.content);
    if (nextCount > MAX_ACTIVE_FILES || nextBytes > MAX_ACTIVE_BYTES) {
      throw new Error("Memory active capacity exceeded (500 Markdown files / 8 MiB); archive obsolete notes first");
    }
    await ensureMemoryDirectories(handle.directory, dirname(input.path));
    signal?.throwIfAborted();
    if (current) await snapshotMemoryDocument(handle.directory, current, signal);
    await atomicMemoryWrite(join(handle.directory, input.path), input.content, signal);
    return document;
  }, signal);
}

/** Archive preserves a full history snapshot before unlinking active content; MEMORY.md cannot be archived. */
export async function archiveMemoryNote(
  handle: MemoryStoreHandle, path: string, expectedHash: string, signal?: AbortSignal,
): Promise<MemoryDocument> {
  validateMemoryPath(path);
  validateMemoryExpectedHash(expectedHash);
  if (expectedHash === null) throw new Error("Memory archive requires an existing content hash");
  if (path === "MEMORY.md") throw new Error("Memory index MEMORY.md cannot be archived");
  return withMemoryLock(handle, async () => {
    const current = await readMemoryDocument(handle.directory, path);
    requireMemoryHash(current, expectedHash);
    if (!current) throw new Error("Memory archive note not found");
    await snapshotMemoryDocument(handle.directory, current, signal);
    signal?.throwIfAborted();
    await unlink(join(handle.directory, path));
    await syncMemoryDirectory(dirname(join(handle.directory, path)));
    return current;
  }, signal);
}

function validateMemoryPath(path: string): void {
  if (typeof path === "string" && path.split("/")[0].toLowerCase() === "memory.md" && path !== "MEMORY.md") {
    throw new Error("Memory index path must be exactly MEMORY.md, not a case alias or directory");
  }
  if (typeof path !== "string" || !path || path.length > 240 ||
      Buffer.from(path).toString("utf8") !== path || isAbsolute(path) ||
      path.includes("\\") || path.includes("\0") || /^[a-z]:/i.test(path) ||
      path.split("/").some((part) => !part || part.startsWith(".")) || !path.endsWith(".md")) {
    throw new Error("Memory path must be relative Markdown with no hidden components, traversal, backslashes or absolute paths");
  }
}

function validateMemoryContent(path: string, content: string): void {
  if (typeof content !== "string" || Buffer.from(content).toString("utf8") !== content) {
    throw new Error("Memory content must be a valid Unicode string");
  }
  if (Buffer.byteLength(content) > MAX_NOTE_BYTES) throw new Error("Memory note exceeds 64 KiB");
  // A final newline terminates the last line rather than adding an empty extra line.
  const lines = content ? content.split(/\r\n|\n|\r/).length - (/[\r\n]$/.test(content) ? 1 : 0) : 0;
  if (path === "MEMORY.md" && (Buffer.byteLength(content) > MAX_INDEX_BYTES || lines > 200)) {
    throw new Error("Memory index MEMORY.md exceeds 8 KiB or 200 lines");
  }
}

function validateMemoryExpectedHash(hash: unknown): asserts hash is string | null {
  if (hash !== null && (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("Memory expectedHash must be a SHA-256 hash or null for create-only");
  }
}

function memoryContentHash(content: string): string { return createHash("sha256").update(content).digest("hex"); }

function requireMemoryHash(current: MemoryDocument | null, expectedHash: string | null): void {
  if ((expectedHash === null && current !== null) || (expectedHash !== null && current?.hash !== expectedHash)) {
    throw new Error("Memory hash conflict: read the current note and retry with its exact hash; null is create-only");
  }
}

async function validateMemoryNamespace(handle: MemoryStoreHandle, create = false): Promise<boolean> {
  if (handle.path !== handle.directory || !isAbsolute(handle.directory) ||
      (handle.scope !== "project" && handle.scope !== "global") || typeof handle.identity !== "string" ||
      !handle.identity || handle.identity.length > 4096 ||
      Buffer.from(handle.identity).toString("utf8") !== handle.identity ||
      basename(handle.directory) !== memoryStoreDirectoryName(handle.identity, handle.scope) ||
      (handle.scope === "global" && handle.identity !== "global")) {
    throw new Error("Memory store handle is invalid");
  }
  const directory = dirname(handle.directory);
  if (handle.legacyCandidates) {
    if (handle.scope !== "project") throw new Error("Memory store handle is invalid");
    const seen = new Set<string>([handle.directory]);
    for (const candidate of handle.legacyCandidates) {
      if (!candidate || typeof candidate.identity !== "string" || !candidate.identity || candidate.identity.length > 4096 ||
          Buffer.from(candidate.identity).toString("utf8") !== candidate.identity ||
          typeof candidate.directory !== "string" || !isAbsolute(candidate.directory) ||
          dirname(candidate.directory) !== directory || seen.has(candidate.directory)) {
        throw new Error("Memory store handle is invalid");
      }
      const candidateName = basename(candidate.directory);
      if (candidateName !== memoryStoreDirectoryName(candidate.identity, "project") &&
          candidateName !== legacyProjectDirectoryName(candidate.identity)) {
        throw new Error("Memory store handle is invalid");
      }
      seen.add(candidate.directory);
    }
  }
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Memory unsafe directory: ${directory}`);
  } catch (error) {
    if (!hasMemoryErrorCode(error, "ENOENT")) throw error;
    if (!create) return false;
    try { await mkdir(directory, { recursive: true, mode: 0o700 }); }
    catch (mkdirError) { if (!hasMemoryErrorCode(mkdirError, "EEXIST")) throw mkdirError; }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Memory unsafe directory: ${directory}`);
  }
  return true;
}

interface DiscoveredMemoryLocation {
  directory: string;
  identity: string;
  isPrimary: boolean;
}

async function inspectMemoryStoreLocations(handle: MemoryStoreHandle): Promise<DiscoveredMemoryLocation | null> {
  const candidates: DiscoveredMemoryLocation[] = [
    { directory: handle.directory, identity: handle.identity, isPrimary: true },
    ...(handle.legacyCandidates ?? []).map((candidate) => ({
      directory: candidate.directory, identity: candidate.identity, isPrimary: false,
    })),
  ];
  for (const candidate of candidates) {
    try {
      const stat = await lstat(candidate.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Memory store directory is unsafe");
      return candidate;
    } catch (error) {
      if (hasMemoryErrorCode(error, "ENOENT")) continue;
      throw error;
    }
  }
  return null;
}

async function validateMemoryIdentityAt(directory: string, expectedIdentity: string, expectedScope: MemoryScope): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Memory store directory is unsafe");
  let identity: unknown;
  try {
    const text = await readMemoryFile(join(directory, IDENTITY_FILE), 8192);
    if (text === null) throw new Error("missing identity file");
    identity = JSON.parse(text);
  } catch (error) {
    throw new Error("Memory identity mismatch or invalid identity file; repair explicitly before writing", { cause: error });
  }
  if (!identity || typeof identity !== "object" ||
      !("identity" in identity) || identity.identity !== expectedIdentity ||
      !("scope" in identity) || identity.scope !== expectedScope || Object.keys(identity).length !== 2) {
    throw new Error("Memory identity mismatch or invalid identity fields; repair explicitly before writing");
  }
}

async function resolveReadableMemoryDirectory(handle: MemoryStoreHandle): Promise<string | null> {
  if (!await validateMemoryNamespace(handle)) return null;
  const found = await inspectMemoryStoreLocations(handle);
  if (!found) return null;
  await validateMemoryIdentityAt(found.directory, found.identity, handle.scope);
  return found.directory;
}

function schedulePayloadHasLiveClaim(value: unknown, now: number): boolean {
  if (!value || typeof value !== "object") return false;
  const claim = "claim" in value ? (value as { claim?: unknown }).claim : undefined;
  if (claim && typeof claim === "object" && "expiresAt" in claim &&
      typeof (claim as { expiresAt?: unknown }).expiresAt === "number" &&
      (claim as { expiresAt: number }).expiresAt > now) {
    return true;
  }
  const legacy = "legacy" in value ? (value as { legacy?: unknown }).legacy : undefined;
  return legacy ? schedulePayloadHasLiveClaim(legacy, now) : false;
}

async function hasActiveMergeLeaseAtDirectory(directory: string): Promise<boolean> {
  const content = await readMemoryFile(join(directory, MERGE_STATE_FILE), MAX_MERGE_STATE_BYTES);
  if (content === null) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(content); }
  catch (error) {
    throw new Error("Memory merge state is corrupt; repair explicitly", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Memory merge state is corrupt; repair explicitly");
  }
  const claim = "claim" in parsed ? (parsed as { claim?: unknown }).claim : undefined;
  return Boolean(claim && typeof claim === "object" && "expiresAt" in claim &&
    typeof (claim as { expiresAt?: unknown }).expiresAt === "number" &&
    (claim as { expiresAt: number }).expiresAt > Date.now());
}

async function assertNoActiveDreamLeaseForMigration(directory: string): Promise<void> {
  if (await hasActiveDreamLeaseAtDirectory(directory)) {
    throw new Error("Memory migration deferred: an active background memory dream holds a lease on the previous directory; retry after it finishes");
  }
}

async function acquireMemoryLock(lockPath: string): Promise<void> {
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (hasMemoryErrorCode(error, "EEXIST")) throw new MemoryStoreLockedError(lockPath);
    throw error;
  }
}

async function updateLocalMemoryMapBestEffort(handle: MemoryStoreHandle): Promise<void> {
  if (handle.scope !== "project" || !handle.localMapPath || !handle.localKeys?.length) return;
  const root = dirname(handle.directory);
  const directoryName = basename(handle.directory);
  for (const localPath of handle.localKeys) {
    await writeLocalMemoryIdentity(handle.localMapPath, {
      root,
      localPath,
      identity: handle.identity,
      directoryName,
    }).catch(() => false);
  }
}

async function withMemoryLock<T>(handle: MemoryStoreHandle, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  await validateMemoryNamespace(handle, true);
  const primaryLock = `${handle.directory}.lock`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const initial = await inspectMemoryStoreLocations(handle);
    if (!initial || initial.isPrimary) {
      await acquireMemoryLock(primaryLock);
      let retryWithMigration = false;
      try {
        signal?.throwIfAborted();
        const current = await inspectMemoryStoreLocations(handle);
        if (current && !current.isPrimary) {
          retryWithMigration = true;
        } else {
          if (!current) {
            let created = false;
            try { await mkdir(handle.directory, { mode: 0o700 }); created = true; }
            catch (error) { if (!hasMemoryErrorCode(error, "EEXIST")) throw error; }
            if (created) {
              await atomicMemoryWrite(join(handle.directory, IDENTITY_FILE),
                JSON.stringify({ identity: handle.identity, scope: handle.scope }) + "\n");
            }
          }
          await validateMemoryIdentityAt(handle.directory, handle.identity, handle.scope);
          signal?.throwIfAborted();
          const result = await operation();
          await updateLocalMemoryMapBestEffort(handle);
          return result;
        }
      } finally {
        await rmdir(primaryLock);
      }
      if (retryWithMigration && attempt === 0) continue;
      throw new Error("Memory store migration state changed concurrently; retry the operation");
    }

    // Dual-lock in deterministic path order to migrate the highest-priority legacy directory atomically without deadlock.
    const sourceLock = `${initial.directory}.lock`;
    const [firstLock, secondLock] = sourceLock < primaryLock ? [sourceLock, primaryLock] : [primaryLock, sourceLock];
    await acquireMemoryLock(firstLock);
    try {
      await acquireMemoryLock(secondLock);
    } catch (error) {
      await rmdir(firstLock);
      throw error;
    }
    try {
      signal?.throwIfAborted();
      const current = await inspectMemoryStoreLocations(handle);
      if (!current) {
        let created = false;
        try { await mkdir(handle.directory, { mode: 0o700 }); created = true; }
        catch (error) { if (!hasMemoryErrorCode(error, "EEXIST")) throw error; }
        if (created) {
          await atomicMemoryWrite(join(handle.directory, IDENTITY_FILE),
            JSON.stringify({ identity: handle.identity, scope: handle.scope }) + "\n");
        }
      } else if (!current.isPrimary) {
        if (current.directory !== initial.directory) {
          throw new Error("Memory store migration source changed concurrently; retry the operation");
        }
        await validateMemoryIdentityAt(current.directory, current.identity, handle.scope);
        await assertNoActiveDreamLeaseForMigration(current.directory);
        signal?.throwIfAborted();
        await rename(current.directory, handle.directory);
        await syncMemoryDirectory(dirname(handle.directory));
        await atomicMemoryWrite(join(handle.directory, IDENTITY_FILE),
          JSON.stringify({ identity: handle.identity, scope: handle.scope }) + "\n");
        await updateLocalMemoryMapBestEffort(handle);
      }
      await validateMemoryIdentityAt(handle.directory, handle.identity, handle.scope);
      signal?.throwIfAborted();
      const result = await operation();
      await updateLocalMemoryMapBestEffort(handle);
      return result;
    } finally {
      await rmdir(secondLock);
      await rmdir(firstLock);
    }
  }
  throw new Error("Memory store migration could not be completed; retry the operation");
}

async function readMemoryDocument(directory: string, path: string): Promise<MemoryDocument | null> {
  if (!await checkMemoryDirectories(directory, dirname(path))) return null;
  const content = await readMemoryFile(join(directory, path), MAX_NOTE_BYTES);
  if (content === null) return null;
  validateMemoryContent(path, content);
  return { path, content, hash: memoryContentHash(content) };
}

async function readMemoryFile(path: string, limit: number): Promise<string | null> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (hasMemoryErrorCode(error, "ENOENT")) return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(`Memory file is not a regular file within its ${limit}-byte limit: ${path}`);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(`Memory file exceeds its ${limit}-byte limit: ${path}`);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } finally { await file.close(); }
}

async function checkMemoryDirectories(directory: string, relative: string, create = false): Promise<boolean> {
  if (relative === ".") return true;
  let current = directory;
  for (const component of relative.split("/")) {
    current = join(current, component);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Memory unsafe directory: ${current}`);
    } catch (error) {
      if (!hasMemoryErrorCode(error, "ENOENT")) throw error;
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); }
      catch (mkdirError) { if (!hasMemoryErrorCode(mkdirError, "EEXIST")) throw mkdirError; }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Memory unsafe directory: ${current}`);
    }
  }
  return true;
}

async function ensureMemoryDirectories(directory: string, relative: string): Promise<void> {
  await checkMemoryDirectories(directory, relative, true);
}

async function listMemoryDocuments(directory: string): Promise<MemoryDocument[]> {
  const documents: MemoryDocument[] = [];
  let bytes = 0;
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Memory symbolic link is not allowed: ${path}`);
      if (entry.isDirectory()) { await checkMemoryDirectories(directory, path); await visit(path); }
      else if (entry.name.endsWith(".md")) {
        validateMemoryPath(path);
        const document = await readMemoryDocument(directory, path);
        if (!document) continue;
        documents.push(document);
        bytes += Buffer.byteLength(document.content);
        if (documents.length > MAX_ACTIVE_FILES || bytes > MAX_ACTIVE_BYTES) throw new Error("Memory active capacity exceeded (500 Markdown files / 8 MiB)");
      }
    }
  }
  await visit("");
  return documents.sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0);
}

async function snapshotMemoryDocument(directory: string, document: MemoryDocument, signal?: AbortSignal): Promise<void> {
  await ensureMemoryDirectories(directory, ".history");
  let count = 0;
  async function countHistory(relative: string): Promise<void> {
    for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Memory history contains a symbolic link");
      if (entry.isDirectory()) { await checkMemoryDirectories(directory, `${relative}/${entry.name}`); await countHistory(`${relative}/${entry.name}`); }
      else {
        count++;
        if (count >= MAX_HISTORY_FILES) throw new Error("Memory history capacity reached (1000 snapshots); export history before explicitly removing snapshots");
      }
    }
  }
  await countHistory(".history");
  // Mirror the full original path as a directory, so long filenames remain valid
  // and every snapshot retains its source path without modifying its Markdown bytes.
  const relative = join(".history", document.path);
  await ensureMemoryDirectories(directory, relative);
  await atomicMemoryWrite(join(directory, relative, `${randomUUID()}.md`), document.content, signal);
}

async function atomicMemoryWrite(path: string, content: string, signal?: AbortSignal): Promise<void> {
  const temporaryPath = join(dirname(path), `.memory-${randomUUID()}.tmp`);
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    signal?.throwIfAborted();
    await rename(temporaryPath, path);
    await syncMemoryDirectory(dirname(path));
  } finally {
    try { await unlink(temporaryPath); }
    catch (error) { if (!hasMemoryErrorCode(error, "ENOENT")) throw error; }
  }
}

async function syncMemoryDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

function hasMemoryErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
