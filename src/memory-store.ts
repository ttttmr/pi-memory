import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MemoryScope } from "./memory-schema.ts";

export type { MemoryScope } from "./memory-schema.ts";

/** Identifies an existing cross-process store lock without changing the original error message. */
export class MemoryStoreLockedError extends Error {
  constructor(lockPath: string) {
    super(`Memory store locked: ${lockPath}. Retry after the writer finishes; never remove a lock while a writer may be running.`);
    this.name = "MemoryStoreLockedError";
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

/** A memory document hash is SHA-256 of its exact UTF-8 content, not its path. */
export interface MemoryDocument { path: string; content: string; hash: string }
/** The memory directory is also the Pi file mutation queue key. */
export interface MemoryStoreHandle { directory: string; path: string; identity: string; scope: MemoryScope }

/** Memory location uses the nearest Git marker, otherwise the canonical current directory. */
export async function resolveMemoryProject(cwd: string): Promise<string> {
  const canonical = await realpath(cwd);
  let directory = canonical;
  while (true) {
    try {
      await lstat(join(directory, ".git"));
      return directory;
    } catch (error) {
      if (!hasMemoryErrorCode(error, "ENOENT")) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return canonical;
    directory = parent;
  }
}

/** Creating a memory handle performs no I/O; files appear on the first successful write. */
export function createMemoryStoreHandle(root: string, project: string, scope: MemoryScope): MemoryStoreHandle {
  if (typeof root !== "string" || !root || root.includes("\0") ||
      typeof project !== "string" || !project || project.length > 4096 ||
      Buffer.from(project).toString("utf8") !== project ||
      (scope !== "project" && scope !== "global")) throw new Error("Memory handle requires a root, project and valid scope");
  const identity = scope === "global" ? "global" : project;
  const name = scope === "global" ? "global" : `project-${memoryContentHash(project)}`;
  const directory = join(resolve(root), name);
  return { directory, path: directory, identity, scope };
}

/** Missing notes return null without creating directories; unsafe paths and identity mismatches fail closed. */
export async function readMemoryNote(handle: MemoryStoreHandle, path: string): Promise<MemoryDocument | null> {
  validateMemoryPath(path);
  if (!await validateMemoryIdentity(handle)) return null;
  return readMemoryDocument(handle.directory, path);
}

/** The model maintains this bounded index itself; there is no automatic index generator. */
export async function readMemoryIndex(handle: MemoryStoreHandle): Promise<MemoryDocument | null> {
  return readMemoryNote(handle, "MEMORY.md");
}

/** List active Markdown recursively in path order, excluding all hidden files and directories. */
export async function listMemoryNotes(handle: MemoryStoreHandle): Promise<MemoryDocument[]> {
  if (!await validateMemoryIdentity(handle)) return [];
  return listMemoryDocuments(handle.directory);
}

/** Read hidden dream scheduling metadata without creating storage; null means the file is absent. */
export async function readMemoryScheduleData(handle: MemoryStoreHandle): Promise<unknown | null> {
  if (!await validateMemoryIdentity(handle)) return null;
  const content = await readMemoryFile(join(handle.directory, SCHEDULE_FILE), MAX_SCHEDULE_BYTES);
  if (content === null) return null;
  const data: unknown = JSON.parse(content);
  if (data === null) throw new Error("Memory schedule data cannot be JSON null");
  return data;
}

/** Mutate hidden dream scheduling metadata under the store lock, without Markdown history snapshots. */
export async function mutateMemoryScheduleData<T>(
  handle: MemoryStoreHandle,
  mutation: (data: unknown | null) => { data: unknown; result: T },
  signal?: AbortSignal,
): Promise<T> {
  return withMemoryLock(handle, async () => {
    const current = await readMemoryScheduleData(handle);
    const { data, result } = mutation(current);
    const content = JSON.stringify(data);
    if (content === undefined || data === null) throw new Error("Memory schedule data must serialize to non-null JSON");
    if (Buffer.byteLength(content + "\n") > MAX_SCHEDULE_BYTES) throw new Error("Memory schedule data exceeds 1 MiB");
    if (content !== JSON.stringify(current)) {
      await atomicMemoryWrite(join(handle.directory, SCHEDULE_FILE), content + "\n", signal);
    }
    return result;
  }, signal);
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
      Buffer.from(handle.identity).toString("utf8") !== handle.identity || basenameMemoryDirectory(handle.directory) !==
      (handle.scope === "global" ? "global" : `project-${memoryContentHash(handle.identity)}`) ||
      (handle.scope === "global" && handle.identity !== "global")) {
    throw new Error("Memory store handle is invalid");
  }
  const directory = dirname(handle.directory);
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

function basenameMemoryDirectory(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }

async function validateMemoryIdentity(handle: MemoryStoreHandle): Promise<boolean> {
  if (!await validateMemoryNamespace(handle)) return false;
  try {
    const stat = await lstat(handle.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Memory store directory is unsafe");
  } catch (error) {
    if (hasMemoryErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  let identity: unknown;
  try {
    const text = await readMemoryFile(join(handle.directory, IDENTITY_FILE), 8192);
    if (text === null) throw new Error("missing identity file");
    identity = JSON.parse(text);
  } catch (error) {
    throw new Error("Memory identity mismatch or invalid identity file; repair explicitly before writing", { cause: error });
  }
  if (!identity || typeof identity !== "object" ||
      !("identity" in identity) || identity.identity !== handle.identity ||
      !("scope" in identity) || identity.scope !== handle.scope || Object.keys(identity).length !== 2) {
    throw new Error("Memory identity mismatch or invalid identity fields; repair explicitly before writing");
  }
  return true;
}

async function withMemoryLock<T>(handle: MemoryStoreHandle, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  await validateMemoryNamespace(handle, true);
  const lockPath = `${handle.directory}.lock`;
  try {
    await mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (hasMemoryErrorCode(error, "EEXIST")) {
      throw new MemoryStoreLockedError(lockPath);
    }
    throw error;
  }
  try {
    signal?.throwIfAborted();
    let created = false;
    try { await mkdir(handle.directory, { mode: 0o700 }); created = true; }
    catch (error) { if (!hasMemoryErrorCode(error, "EEXIST")) throw error; }
    if (created) {
      await atomicMemoryWrite(join(handle.directory, IDENTITY_FILE), JSON.stringify({ identity: handle.identity, scope: handle.scope }) + "\n");
    }
    await validateMemoryIdentity(handle);
    signal?.throwIfAborted();
    return await operation();
  } finally {
    await rmdir(lockPath);
  }
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
