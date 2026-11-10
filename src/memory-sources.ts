import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveMemoryProject } from "./memory-store.ts";

const MAX_SOURCE_PAGE_BYTES = 8 * 1024;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_SESSION_ENTRIES = 100_000;
const SOURCE_CURSOR_STRIDE = MAX_SESSION_ENTRIES + 1;
const MAX_SCAN_SESSIONS = 16;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 20_000;
const MAX_DISCOVERY_DIRECTORIES = 512;
const MAX_DISCOVERY_FILES = 20_000;
const SOURCE_SCAN_DEFERRED = Symbol("Memory source scan budget deferred");

type ReadonlySessionManager = ExtensionContext["sessionManager"];
type JsonRecord = Record<string, unknown>;
interface SourceEntry { id: string; parentId: string | null; timestamp: string; type: string; value: JsonRecord; sourceLine?: number }
interface SourceSession { id: string; entries: SourceEntry[]; branch?: SourceEntry[]; sourceFile?: string }
interface SourceCandidate { path?: string; current?: true }
interface SourceScanBudget { remaining: number }
type SourceLoadResult = SourceSession | null | typeof SOURCE_SCAN_DEFERRED;

/** Provenance distinguishes context-edited text from unchanged original evidence; duplicateKey is not independent confirmation. */
export interface MemorySourceMetadata {
  id: string;
  sessionId: string;
  entryId: string;
  role: string;
  timestamp: string;
  hash: string;
  contextEdited: boolean;
  contextEditEntryId?: string;
  contextEditSourceLine?: number;
  evidence: "original" | "context-edited";
  duplicateKey: string;
  sourceFile?: string;
  sourceLine?: number;
}

/** Search offsets are opaque scan cursors; empty partial pages can still have a nextOffset. */
export interface MemorySourceSearchPage {
  sources: (MemorySourceMetadata & { preview: string })[];
  nextOffset: number | null;
  partial?: boolean;
  truncated?: boolean;
  warnings?: string[];
}

/** Source text uses Unicode code point offsets and a hash of the complete visible text, not this page. */
export interface MemorySourcePage extends MemorySourceMetadata {
  text: string;
  startCharacter: number;
  nextCharacter: number | null;
}

/** Sources are read on demand from trusted roots without migrating, rewriting, or caching native transcripts. */
export interface MemorySourceProvider {
  search(query: string, options?: { sessionId?: string; offset?: number; limit?: number }, signal?: AbortSignal): Promise<MemorySourceSearchPage>;
  read(id: string, options?: { startCharacter?: number }, signal?: AbortSignal): Promise<MemorySourcePage>;
}

/** Factory does no I/O; roots must come from the host, never model-supplied file paths. */
export function createMemorySourceProvider(options: {
  project: string;
  sessionRoots: string[];
  currentSession: ReadonlySessionManager;
}): MemorySourceProvider {
  const roots = [...options.sessionRoots];
  const project = options.project;
  const current = options.currentSession;

  async function checkProject(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (!isAbsolute(project) || resolve(project) !== project || await resolveMemoryProject(project) !== project) {
      throw new Error("Memory source project must be a canonical project identity");
    }
  }

  async function currentSources(signal?: AbortSignal): Promise<SourceSession | null> {
    if (!await matchesSourceProject(current.getCwd(), project, signal)) return null;
    const entries = parseSourceEntries(current.getEntries());
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch = current.getBranch().map((entry) => byId.get(entry.id)).filter((entry) => entry !== undefined);
    return { id: current.getSessionId(), entries, branch };
  }

  async function candidates(warnings: Set<string>, signal?: AbortSignal): Promise<SourceCandidate[]> {
    const paths = new Map<string, number>();
    let directories = 0;
    for (const root of new Set(roots)) {
      if (!isAbsolute(root) || resolve(root) !== root || !await safeSourceDirectory(root)) {
        warnings.add("Memory source root is missing or unsafe; no directory was created");
        continue;
      }
      const children: string[] = [];
      async function visit(directory: string, allowChildren: boolean): Promise<void> {
        signal?.throwIfAborted();
        if (++directories > MAX_DISCOVERY_DIRECTORIES) {
          warnings.add("Memory source discovery truncated at 512 directories");
          return;
        }
        const handle = await opendir(directory);
        let count = 0;
        try {
          for await (const entry of handle) {
            signal?.throwIfAborted();
            if (++count > MAX_DIRECTORY_ENTRIES) {
              warnings.add("Memory source discovery truncated at 20000 entries per directory");
              break;
            }
            const path = join(directory, entry.name);
            if (entry.name.endsWith(".jsonl")) {
              if (!entry.isFile()) {
                warnings.add("Memory source native file is unsafe (symlink or not regular)");
                continue;
              }
              if (paths.size >= MAX_DISCOVERY_FILES) {
                warnings.add("Memory source discovery truncated at 20000 native files");
                break;
              }
              const metadata = await lstat(path);
              if (metadata.isFile()) paths.set(path, metadata.mtimeMs);
              else warnings.add("Memory source native file is unsafe (symlink or not regular)");
            } else if (allowChildren && entry.isDirectory()) children.push(path);
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          warnings.add("Memory source directory could not be enumerated completely");
        }
      }
      await visit(root, true);
      for (const child of children.sort()) {
        if (directories >= MAX_DISCOVERY_DIRECTORIES || paths.size >= MAX_DISCOVERY_FILES) {
          warnings.add("Memory source discovery truncated at 512 directories or 20000 native files");
          break;
        }
        if (await safeSourceDirectory(child)) await visit(child, false);
      }
    }
    // File activity orders sessions without reading any other project's body.
    return [{ current: true }, ...[...paths].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
      .map(([path]) => ({ path }))];
  }

  async function load(candidate: SourceCandidate, warnings: Set<string>, signal?: AbortSignal,
    targetId?: string, budget?: SourceScanBudget): Promise<SourceLoadResult> {
    signal?.throwIfAborted();
    if (candidate.current) return currentSources(signal);
    try {
      return await readSourceSession(candidate.path!, project, signal, targetId, budget);
    } catch (error) {
      if (signal?.aborted) throw error;
      warnings.add(error instanceof Error ? error.message : "Memory source file could not be read safely");
      return null;
    }
  }

  return {
    async search(query, input = {}, signal) {
      await checkProject(signal);
      if (typeof query !== "string" || query.length > 4096) throw new Error("Memory source query must be at most 4096 characters");
      const offset = sourceInteger(input.offset ?? 0, "offset");
      const limit = sourceInteger(input.limit ?? 20, "limit");
      if (limit < 1 || limit > 64) throw new Error("Memory source search limit must be 1..64");
      if (input.sessionId !== undefined) validateSourceIdentifier(input.sessionId);
      const warnings = new Set<string>();
      const files = await candidates(warnings, signal);
      const sources: MemorySourceSearchPage["sources"] = [];
      const seen = new Set<string>();
      const terms = query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [];
      let fileIndex = Math.floor(offset / SOURCE_CURSOR_STRIDE);
      let entryIndex = offset % SOURCE_CURSOR_STRIDE;
      let scanned = 0;
      const budget: SourceScanBudget = { remaining: MAX_SCAN_BYTES };
      let nextOffset: number | null = null;
      for (; fileIndex < files.length; fileIndex++, entryIndex = 0) {
        signal?.throwIfAborted();
        if (scanned >= MAX_SCAN_SESSIONS || budget.remaining <= 0) {
          nextOffset = fileIndex * SOURCE_CURSOR_STRIDE + entryIndex;
          break;
        }
        const session = await load(files[fileIndex]!, warnings, signal, input.sessionId, budget);
        scanned++;
        if (session === SOURCE_SCAN_DEFERRED) {
          nextOffset = fileIndex * SOURCE_CURSOR_STRIDE + entryIndex;
          break;
        }
        if (!session || (input.sessionId && session.id !== input.sessionId)) continue;
        if (!files[fileIndex]!.current && session.id === current.getSessionId()) continue;
        let visible: ReturnType<typeof visibleSessionSources>;
        try { visible = visibleSessionSources(session); }
        catch (error) {
          warnings.add(error instanceof Error ? error.message : "Memory source native branch is malformed");
          continue;
        }
        for (; entryIndex < visible.length; entryIndex++) {
          signal?.throwIfAborted();
          const source = visible[entryIndex]!;
          if (seen.has(source.duplicateKey)) continue;
          seen.add(source.duplicateKey);
          const lower = source.text.toLocaleLowerCase();
          if (!terms.every((term) => lower.includes(term))) continue;
          const { text, ...metadata } = source;
          sources.push({ ...metadata, preview: [...text].slice(0, 240).join("") });
          if (sources.length === limit) {
            nextOffset = entryIndex + 1 < visible.length ? fileIndex * SOURCE_CURSOR_STRIDE + entryIndex + 1 :
              fileIndex + 1 < files.length ? (fileIndex + 1) * SOURCE_CURSOR_STRIDE : null;
            break;
          }
        }
        if (sources.length === limit) break;
      }
      const truncated = [...warnings].some((warning) => /truncated|exceeds|unsupported|malformed|unsafe|could not/.test(warning));
      return { sources, nextOffset, partial: nextOffset !== null || warnings.size > 0,
        ...(truncated ? { truncated: true } : {}), ...(warnings.size ? { warnings: [...warnings] } : {}) };
    },
    async read(id, input = {}, signal) {
      await checkProject(signal);
      if (typeof id !== "string" || id.length > 500) throw new Error("Memory source ID is invalid");
      const parts = id.split(":");
      if (parts.length !== 3 || parts[2] !== "0") throw new Error("Memory source ID must be sessionId:entryId:0");
      const sessionId = parts[0]!;
      const entryId = parts[1]!;
      validateSourceIdentifier(sessionId);
      validateSourceIdentifier(entryId);
      const startCharacter = sourceInteger(input.startCharacter ?? 0, "startCharacter");
      const warnings = new Set<string>();
      const files = await candidates(warnings, signal);
      // Exact ID reads are not limited to the last search page or the recent-session scan budget.
      for (const candidate of files) {
        signal?.throwIfAborted();
        const session = candidate.current ? await currentSources(signal) :
          await readSourceSession(candidate.path!, project, signal, sessionId).catch((error: unknown) => {
            if (signal?.aborted) throw error;
            warnings.add(error instanceof Error ? error.message : "Memory source file unavailable");
            return null;
          });
        if (!session || session === SOURCE_SCAN_DEFERRED || session.id !== sessionId || (!candidate.current && session.id === current.getSessionId())) continue;
        let visible: ReturnType<typeof visibleSessionSources>;
        try { visible = visibleSessionSources(session); }
        catch (error) {
          warnings.add(error instanceof Error ? error.message : "Memory source native branch is malformed");
          continue;
        }
        const source = visible.find((entry) => entry.entryId === entryId);
        if (!source) continue;
        const characters = [...source.text];
        if (startCharacter > characters.length) throw new Error("Memory source character offset exceeds visible text");
        let end = startCharacter;
        let bytes = 0;
        for (; end < characters.length; end++) {
          const size = Buffer.byteLength(characters[end]!);
          if (bytes + size > MAX_SOURCE_PAGE_BYTES) break;
          bytes += size;
        }
        return { ...source, text: characters.slice(startCharacter, end).join(""), startCharacter,
          nextCharacter: end < characters.length ? end : null };
      }
      throw new Error(`Memory source unavailable on the selected same-project branch${warnings.size ? "; some native files were unsafe, malformed, unsupported, or discovery was truncated" : ""}`);
    },
  };
}

function sourceInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Memory source ${name} must be a nonnegative safe integer`);
  return value;
}

function validateSourceIdentifier(id: string): void {
  if (!id || id.length > 240 || !/^[a-zA-Z0-9_.-]+$/.test(id) || id === "." || id === "..") {
    throw new Error("Memory source identifier is invalid; file paths are not accepted");
  }
}

function sourceRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

async function safeSourceDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory() && await realpath(path) === path;
  } catch { return false; }
}

async function matchesSourceProject(cwd: string, project: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (typeof cwd !== "string" || !isAbsolute(cwd) || resolve(cwd) !== cwd) return false;
  try {
    return await realpath(cwd) === cwd && await resolveMemoryProject(cwd) === project;
  } catch { return false; }
}

async function readSourceSession(path: string, project: string, signal?: AbortSignal, targetId?: string,
  budget?: SourceScanBudget): Promise<SourceLoadResult> {
  signal?.throwIfAborted();
  // Validate all path components, then refuse final-component symlinks at open time as well.
  if (await realpath(path) !== path) throw new Error("Memory source native file is unsafe (symlink)");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Memory source native file is unsafe (not regular)");
    const first = Buffer.alloc(MAX_HEADER_BYTES);
    let newline = -1;
    // Stop exactly at the header boundary: a different project's body is never read.
    for (let index = 0; index < Math.min(MAX_HEADER_BYTES, stat.size); index++) {
      signal?.throwIfAborted();
      const read = await file.read(first, index, 1, index);
      if (!read.bytesRead) break;
      if (first[index] === 10) { newline = index; break; }
    }
    if (newline < 0) throw new Error("Memory source native header is malformed or exceeds 16 KiB");
    let header: JsonRecord | undefined;
    try { header = sourceRecord(JSON.parse(first.subarray(0, newline).toString("utf8"))); }
    catch { throw new Error("Memory source native header is malformed"); }
    if (!header || header.type !== "session" || header.version !== 3 || typeof header.id !== "string") {
      throw new Error("Memory source native header is unsupported (requires version 3)");
    }
    validateSourceIdentifier(header.id);
    if (targetId && header.id !== targetId) return null;
    // Header identity is checked before reading transcript bodies, regardless of directory names.
    if (typeof header.cwd !== "string" || !await matchesSourceProject(header.cwd, project, signal)) return null;
    if (stat.size > MAX_SESSION_BYTES) throw new Error("Memory source native file exceeds 16 MiB; truncated scan refuses incomplete privacy edits");
    if (budget) {
      if (stat.size > budget.remaining) return SOURCE_SCAN_DEFERRED;
      // Reserve before allocation/read, including malformed bodies, so failures cannot bypass the byte cap.
      budget.remaining -= stat.size;
    }
    const buffer = Buffer.alloc(stat.size);
    let position = 0;
    while (position < buffer.length) {
      signal?.throwIfAborted();
      const read = await file.read(buffer, position, Math.min(64 * 1024, buffer.length - position), position);
      if (!read.bytesRead) throw new Error("Memory source native file changed during read");
      position += read.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Memory source native file changed during read");
    const text = buffer.toString("utf8");
    if (!Buffer.from(text).equals(buffer)) throw new Error("Memory source native file is malformed UTF-8");
    const values: unknown[] = [];
    const sourceLines: number[] = [];
    const lines = text.slice(text.indexOf("\n") + 1).split("\n");
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      signal?.throwIfAborted();
      if (!line.trim()) continue;
      if (values.length >= MAX_SESSION_ENTRIES) throw new Error("Memory source native file exceeds 100000 entries; truncated scan refuses incomplete privacy edits");
      try { values.push(JSON.parse(line)); sourceLines.push(index + 2); }
      catch { throw new Error("Memory source native entry is malformed; transcript refused to preserve context-edit privacy"); }
    }
    return { id: header.id, entries: parseSourceEntries(values, sourceLines), sourceFile: path };
  } finally { await file.close(); }
}

function parseSourceEntries(values: unknown[], sourceLines?: number[]): SourceEntry[] {
  if (values.length > MAX_SESSION_ENTRIES) throw new Error("Memory source native file exceeds 100000 entries; truncated scan refuses incomplete privacy edits");
  const entries: SourceEntry[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const entry = sourceRecord(value);
    if (!entry || typeof entry.id !== "string" || typeof entry.type !== "string" ||
        !(entry.parentId === null || typeof entry.parentId === "string") || typeof entry.timestamp !== "string") {
      throw new Error("Memory source native entry is malformed");
    }
    validateSourceIdentifier(entry.id);
    if (seen.has(entry.id)) throw new Error("Memory source native entry is malformed (duplicate ID)");
    seen.add(entry.id);
    entries.push({ id: entry.id, type: entry.type, parentId: entry.parentId, timestamp: entry.timestamp, value: entry,
      ...(sourceLines ? { sourceLine: sourceLines[entries.length] } : {}) });
  }
  return entries;
}

function visibleSourceText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((value: unknown) => {
    const block = sourceRecord(value);
    // Do not inspect thinking, signatures, encrypted payloads, images, tool arguments, or details.
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

function visibleSessionSources(session: SourceSession): (MemorySourceMetadata & { text: string })[] {
  let branch = session.branch;
  if (!branch) {
    const byId = new Map(session.entries.map((entry) => [entry.id, entry]));
    branch = [];
    let entry = session.entries.at(-1);
    const visited = new Set<string>();
    while (entry) {
      if (visited.has(entry.id)) throw new Error("Memory source native branch is malformed (cycle)");
      visited.add(entry.id);
      branch.push(entry);
      if (entry.parentId === null) break;
      const parent = byId.get(entry.parentId);
      if (!parent) throw new Error("Memory source native branch is malformed (missing parent)");
      entry = parent;
    }
    branch.reverse();
  }
  const edits = new Map<string, JsonRecord | null>();
  const editEntries = new Map<string, SourceEntry>();
  for (const entry of branch) {
    if (entry.type !== "context_edit") continue;
    if (typeof entry.value.targetId !== "string") throw new Error("Memory source context edit is malformed");
    const replacement = entry.value.replacement;
    if (replacement !== null && !sourceRecord(replacement)) throw new Error("Memory source context edit is malformed");
    edits.set(entry.value.targetId, replacement === null ? null : sourceRecord(replacement)!);
    editEntries.set(entry.value.targetId, entry);
  }
  const sources: (MemorySourceMetadata & { text: string })[] = [];
  for (const entry of branch) {
    if (entry.type !== "message" || edits.get(entry.id) === null) continue;
    const message = sourceRecord(entry.value.message);
    if (!message || !["user", "assistant", "toolResult"].includes(String(message.role))) continue;
    if (message.role === "toolResult" && typeof message.toolName === "string" && message.toolName.startsWith("memory_")) continue;
    const contextEdited = edits.has(entry.id);
    const text = visibleSourceText(contextEdited ? edits.get(entry.id)?.content : message.content);
    if (!text.trim()) continue;
    const hash = createHash("sha256").update(text).digest("hex");
    sources.push({ id: `${session.id}:${entry.id}:0`, sessionId: session.id, entryId: entry.id,
      role: String(message.role), timestamp: entry.timestamp, hash, contextEdited,
      evidence: contextEdited ? "context-edited" : "original", duplicateKey: `${entry.id}:${hash}`, text,
      ...(contextEdited ? { contextEditEntryId: editEntries.get(entry.id)!.id,
        ...(session.sourceFile ? { contextEditSourceLine: editEntries.get(entry.id)!.sourceLine } : {}) } : {}),
      ...(session.sourceFile ? { sourceFile: session.sourceFile, sourceLine: entry.sourceLine } : {}) });
  }
  return sources.reverse();
}
