import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { MemoryScope } from "./memory-schema.ts";

const MAX_GIT_POINTER_BYTES = 8 * 1024;
const MAX_GIT_CONFIG_BYTES = 256 * 1024;
const MAX_SSH_CONFIG_BYTES = 256 * 1024;
const MAX_SSH_INCLUDE_DEPTH = 4;
const MAX_SSH_CONFIG_FILES = 16;
const MAX_LOCAL_MAP_BYTES = 256 * 1024;
const MAX_LOCAL_MAP_ENTRIES = 500;
const LOCAL_MAP_REFRESH_MS = 24 * 60 * 60 * 1000;
const MAX_ROOT_SCAN_ENTRIES = 2000;
const MAX_IDENTITY_FILE_BYTES = 8 * 1024;
const MAX_SLUG_LENGTH = 48;
const LOCAL_MAP_FILENAME = "pi-memory-local-map.json";

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ssh:": "22",
  "git:": "9418",
};

// Hosts whose repository paths are case-insensitive; other hosts preserve path case.
const CASE_INSENSITIVE_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "gitee.com",
]);

/** Structured project identity resolution separating logical repo identity from checkout path. */
export interface MemoryProjectResolution {
  /** Logical identity: normalized `git:<host>/<path>` or canonical local repo/directory path. */
  identity: string;
  /** Canonical local repository root (main or bare repo for worktrees, or canonical cwd). */
  localIdentity: string;
  /** Canonical working directory for this checkout (nearest .git parent or canonical cwd). */
  worktreeRoot: string;
  /** True when identity comes from a normalized Git remote URL. */
  isRemote: boolean;
}

/** Optional overrides for deterministic testing of project resolution. */
export interface ResolveMemoryProjectOptions {
  /** Path to OpenSSH client config; defaults to ~/.ssh/config. Empty string disables lookup. */
  sshConfigPath?: string;
}

/** A candidate legacy or prior directory/identity pair under the same memory root. */
export interface MemoryLegacyCandidate {
  identity: string;
  directory: string;
}

/** An existing sibling or legacy project store directory verified to belong to the same logical repository. */
export interface DiscoveredMergeSource {
  directory: string;
  directoryName: string;
  identity: string;
}

/** One device-local mapping from a canonical local repository path to its last known identity. */
export interface LocalMemoryIdentityEntry {
  root: string;
  localPath: string;
  identity: string;
  directoryName: string;
  updatedAt: string;
}

interface LocalMemoryIdentityMap {
  version: 1;
  entries: LocalMemoryIdentityEntry[];
}

interface ParsedGitConfig {
  coreWorktree?: string;
  originUrl?: string;
}

/** Resolve logical project identity, local repository root, and checkout worktree root without invoking Git. */
export async function resolveMemoryProjectDetails(
  cwd: string,
  options: ResolveMemoryProjectOptions = {},
): Promise<MemoryProjectResolution> {
  const canonical = await realpath(cwd);
  const gitMarkerDir = await findNearestGitMarker(canonical);
  if (!gitMarkerDir) {
    return { identity: canonical, localIdentity: canonical, worktreeRoot: canonical, isRemote: false };
  }
  const { localIdentity, commonGitDir } = await resolveGitRepository(gitMarkerDir);
  if (commonGitDir) {
    const configText = await readBoundedFile(join(commonGitDir, "config"), MAX_GIT_CONFIG_BYTES, false);
    if (configText !== null) {
      const { originUrl } = parseGitConfig(configText);
      if (originUrl) {
        const sshConfigPath = options.sshConfigPath ?? join(homedir(), ".ssh", "config");
        const normalized = await normalizeGitRemoteUrl(originUrl, sshConfigPath);
        if (normalized) {
          return { identity: normalized, localIdentity, worktreeRoot: gitMarkerDir, isRemote: true };
        }
      }
    }
  }
  return { identity: localIdentity, localIdentity, worktreeRoot: gitMarkerDir, isRemote: false };
}

/** Resolve logical project identity string: normalized remote URL, main repo root, or canonical cwd. */
export async function resolveMemoryProject(cwd: string, options?: ResolveMemoryProjectOptions): Promise<string> {
  return (await resolveMemoryProjectDetails(cwd, options)).identity;
}

/** Derive a deterministic, filesystem-safe readable slug from a project identity. */
export function memoryProjectSlug(identity: string): string {
  let raw = "";
  if (identity.startsWith("git:")) {
    const parts = identity.slice(4).split("/").filter(Boolean);
    const pathSegments = parts.slice(1);
    if (pathSegments.length >= 2) raw = `${pathSegments.at(-2)}-${pathSegments.at(-1)}`;
    else if (pathSegments.length === 1) raw = pathSegments[0]!;
    else raw = parts[0] ?? "";
  } else {
    const parts = identity.split(/[\\/]+/).filter(Boolean);
    raw = parts.at(-1) ?? "root";
  }
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/[._-]+$/g, "");
  if (!cleaned || cleaned === "global") return "project";
  return cleaned;
}

/** Compute the current readable directory name under the memory root for a scope and identity. */
export function memoryStoreDirectoryName(identity: string, scope: MemoryScope): string {
  if (scope === "global") return "global";
  const hash16 = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${memoryProjectSlug(identity)}-${hash16}`;
}

/** Compute the pre-migration directory name (`project-<sha256>`) for compatibility lookup. */
export function legacyProjectDirectoryName(identity: string): string {
  return `project-${createHash("sha256").update(identity).digest("hex")}`;
}

/** Validate a normalized `git:<host>/<path>` remote project identity string. */
export function isValidRemoteProjectIdentity(identity: string): boolean {
  if (typeof identity !== "string" || !identity.startsWith("git:") || identity.length <= 4 || identity.length > 4096) {
    return false;
  }
  if (Buffer.from(identity).toString("utf8") !== identity) return false;
  if (/[\0-\x1f\x7f\s]/.test(identity)) return false;
  const body = identity.slice(4);
  const slash = body.indexOf("/");
  if (slash <= 0 || slash === body.length - 1) return false;
  const host = body.slice(0, slash);
  const repoPath = body.slice(slash + 1);
  if (!host || host.includes("@")) return false;
  const segments = repoPath.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** Resolve the default device-local identity map path outside the memory storage directory. */
export function defaultLocalMemoryMapPath(agentDir: string): string {
  return join(agentDir, LOCAL_MAP_FILENAME);
}

/** Build ordered, deduplicated legacy/prior directory candidates for read fallback and write migration. */
export async function resolveMemoryLegacyCandidates(
  root: string,
  details: MemoryProjectResolution,
  localMapPath?: string,
): Promise<MemoryLegacyCandidate[]> {
  const resolvedRoot = resolve(root);
  const primaryDirectory = join(resolvedRoot, memoryStoreDirectoryName(details.identity, "project"));
  const candidates: MemoryLegacyCandidate[] = [];
  const seen = new Set<string>([primaryDirectory]);
  const add = (identity: string, directoryName: string) => {
    if (!identity || identity.length > 4096 || Buffer.from(identity).toString("utf8") !== identity ||
        !directoryName || directoryName.includes("/") || directoryName.includes("\\") || directoryName === "global") {
      return;
    }
    const directory = join(resolvedRoot, directoryName);
    if (seen.has(directory)) return;
    if (directoryName !== memoryStoreDirectoryName(identity, "project") &&
        directoryName !== legacyProjectDirectoryName(identity)) {
      return;
    }
    seen.add(directory);
    candidates.push({ identity, directory });
  };

  if (localMapPath) {
    for (const mapped of await readLocalMemoryIdentities(localMapPath, resolvedRoot, details.localIdentity)) {
      add(mapped.identity, mapped.directoryName);
    }
  }
  if (details.isRemote) {
    add(details.localIdentity, memoryStoreDirectoryName(details.localIdentity, "project"));
  }
  add(details.localIdentity, legacyProjectDirectoryName(details.localIdentity));
  if (details.worktreeRoot !== details.localIdentity) {
    add(details.worktreeRoot, memoryStoreDirectoryName(details.worktreeRoot, "project"));
    add(details.worktreeRoot, legacyProjectDirectoryName(details.worktreeRoot));
  }
  return candidates;
}

/**
 * Discover all existing sibling/legacy project stores under `root` that provably belong to the
 * same logical repository as `details`, excluding the primary store directory itself.
 * Covers direct legacy candidates, linked worktrees, bare-repo worktrees, separate local clones
 * sharing the same normalized remote, and device-local map predecessors. Nonexistent paths and
 * symlinks are never guessed or followed.
 */
export async function discoverMatchingMemoryStores(
  root: string,
  details: MemoryProjectResolution,
  options: ResolveMemoryProjectOptions & { localMapPath?: string } = {},
): Promise<DiscoveredMergeSource[]> {
  const resolvedRoot = resolve(root);
  try {
    const rootStat = await lstat(resolvedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`Memory unsafe directory: ${resolvedRoot}`);
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }

  const primaryName = memoryStoreDirectoryName(details.identity, "project");
  const primaryDirectory = join(resolvedRoot, primaryName);
  const results: DiscoveredMergeSource[] = [];
  const seen = new Set<string>([primaryDirectory]);

  // 1. Direct legacy/prior candidates preserve deterministic priority (localMap -> main repo -> worktree).
  const directCandidates = await resolveMemoryLegacyCandidates(resolvedRoot, details, options.localMapPath);
  for (const candidate of directCandidates) {
    if (seen.has(candidate.directory)) continue;
    let stat;
    try { stat = await lstat(candidate.directory); }
    catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const directoryName = basename(candidate.directory);
    const storedIdentity = await readProjectIdentityAtDirectory(candidate.directory, directoryName);
    if (storedIdentity !== candidate.identity) continue;
    seen.add(candidate.directory);
    results.push({ directory: candidate.directory, directoryName, identity: storedIdentity });
  }

  // 2. Index device-local map entries (if present) so renamed remotes on other local clones also match.
  const localMapByDir = new Map<string, LocalMemoryIdentityEntry[]>();
  if (options.localMapPath) {
    const map = await readLocalMemoryMap(resolve(options.localMapPath));
    if (map) {
      for (const entry of map.entries) {
        if (entry.root !== resolvedRoot) continue;
        const list = localMapByDir.get(entry.directoryName) ?? [];
        list.push(entry);
        localMapByDir.set(entry.directoryName, list);
      }
    }
  }

  // 3. Scan direct children of `root` to discover sibling worktrees and separate clones on this machine.
  const resolutionCache = new Map<string, MemoryProjectResolution | null>();
  const resolveLocalCached = async (localPath: string): Promise<MemoryProjectResolution | null> => {
    const realTarget = await safeRealDirectory(localPath);
    if (!realTarget) return null;
    if (resolutionCache.has(realTarget)) return resolutionCache.get(realTarget) ?? null;
    let resolved: MemoryProjectResolution | null = null;
    try { resolved = await resolveMemoryProjectDetails(realTarget, options); }
    catch { resolved = null; }
    resolutionCache.set(realTarget, resolved);
    return resolved;
  };

  const entries = (await readdir(resolvedRoot, { withFileTypes: true }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const scanLimit = Math.min(entries.length, MAX_ROOT_SCAN_ENTRIES);
  for (let i = 0; i < scanLimit; i++) {
    const entry = entries[i]!;
    if (entry.name.startsWith(".") || entry.name === "global" || entry.name === primaryName) continue;
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const directory = join(resolvedRoot, entry.name);
    if (seen.has(directory)) continue;

    const storedIdentity = await readProjectIdentityAtDirectory(directory, entry.name);
    if (!storedIdentity) continue;

    let matched = storedIdentity === details.identity ||
      storedIdentity === details.localIdentity ||
      storedIdentity === details.worktreeRoot;

    if (!matched && isAbsolute(storedIdentity)) {
      const resolved = await resolveLocalCached(storedIdentity);
      if (resolved?.identity === details.identity) matched = true;
    }

    if (!matched) {
      const mapEntries = localMapByDir.get(entry.name);
      if (mapEntries) {
        for (const mapEntry of mapEntries) {
          if (mapEntry.identity !== storedIdentity) continue;
          if (mapEntry.localPath === details.localIdentity || mapEntry.localPath === details.worktreeRoot) {
            matched = true;
            break;
          }
          const resolved = await resolveLocalCached(mapEntry.localPath);
          if (resolved?.identity === details.identity) {
            matched = true;
            break;
          }
        }
      }
    }

    if (matched) {
      seen.add(directory);
      results.push({ directory, directoryName: entry.name, identity: storedIdentity });
    }
  }

  return results;
}

async function readProjectIdentityAtDirectory(directory: string, directoryName: string): Promise<string | null> {
  const text = await readBoundedFile(join(directory, ".identity.json"), MAX_IDENTITY_FILE_BYTES, false);
  if (text === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return null; }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 2 || parsed.scope !== "project" ||
      typeof parsed.identity !== "string" || !parsed.identity || parsed.identity.length > 4096 ||
      Buffer.from(parsed.identity).toString("utf8") !== parsed.identity) {
    return null;
  }
  const identity = parsed.identity;
  if (directoryName !== memoryStoreDirectoryName(identity, "project") &&
      directoryName !== legacyProjectDirectoryName(identity)) {
    return null;
  }
  return identity;
}

/** Normalize a Git remote URL to `git:<host[:port]>/<path>`, stripping credentials and resolving SSH aliases. */
export async function normalizeGitRemoteUrl(rawUrl: string, sshConfigPath = ""): Promise<string | null> {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > 4096 || /[\0-\x1f\x7f]/.test(trimmed)) return null;
  if (isLocalGitRemote(trimmed)) return null;

  let protocol = "";
  let rawHost = "";
  let port = "";
  let rawPath = "";
  let isSsh = false;

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    let parsed: URL;
    try { parsed = new URL(trimmed); }
    catch { return null; }
    protocol = parsed.protocol.toLowerCase();
    if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:" && protocol !== "git:") return null;
    rawHost = parsed.hostname;
    port = parsed.port;
    rawPath = parsed.pathname;
    isSsh = protocol === "ssh:";
  } else {
    // SCP-like syntax: [user@]host:path
    const match = /^(?:([^@/:]+)@)?([^@/:]+):(.+)$/.exec(trimmed);
    if (!match) return null;
    protocol = "ssh:";
    rawHost = match[2]!;
    rawPath = match[3]!;
    isSsh = true;
  }

  if (!rawHost) return null;
  let host = rawHost;
  if (isSsh && sshConfigPath) {
    const resolvedHost = await resolveSshConfigHostName(rawHost, sshConfigPath);
    if (resolvedHost) host = resolvedHost;
  }
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || /[\0-\x1f\x7f\s/@]/.test(host)) return null;
  const effectivePort = port && DEFAULT_PORTS[protocol] !== port ? port : "";
  const hostPart = effectivePort ? (host.includes(":") ? `[${host}]:${effectivePort}` : `${host}:${effectivePort}`) :
    (host.includes(":") ? `[${host}]` : host);

  const normalizedPath = normalizeGitRemotePath(rawPath, host);
  if (!normalizedPath) return null;
  const identity = `git:${hostPart}/${normalizedPath}`;
  return isValidRemoteProjectIdentity(identity) ? identity : null;
}

/** Resolve an OpenSSH Host alias to its effective HostName using read-only bounded config parsing. */
export async function resolveSshConfigHostName(alias: string, sshConfigPath: string): Promise<string | null> {
  if (!alias || !sshConfigPath || /[\0-\x1f\x7f\s]/.test(alias)) return null;
  const visited = new Set<string>();
  const counter = { files: 0 };
  const resolved = await findSshHostNameInFile(alias, sshConfigPath, dirname(sshConfigPath), 0, visited, counter);
  if (!resolved) return null;
  return expandSshHostNameTokens(resolved, alias);
}

/** Read all device-local identity mappings for a local path (newest first) without creating files. */
export async function readLocalMemoryIdentities(
  mapPath: string,
  root: string,
  localPath: string,
): Promise<LocalMemoryIdentityEntry[]> {
  const map = await readLocalMemoryMap(mapPath);
  if (!map) return [];
  const resolvedRoot = resolve(root);
  return map.entries
    .filter((entry) => entry.root === resolvedRoot && entry.localPath === localPath)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.directoryName.localeCompare(b.directoryName));
}

/** Read the latest device-local identity mapping without creating files; corrupt maps fail closed. */
export async function readLocalMemoryIdentity(
  mapPath: string,
  root: string,
  localPath: string,
): Promise<LocalMemoryIdentityEntry | null> {
  return (await readLocalMemoryIdentities(mapPath, root, localPath))[0] ?? null;
}

/**
 * Update the device-local identity mapping after a successful write or migration.
 * Preserves prior mappings for the same localPath whose directories still exist under `root`
 * so renamed remotes stay discoverable until consolidated or archived, while pruning entries
 * whose directories are already gone. Uses a dedicated lock; contention skips without failing writes.
 */
export async function writeLocalMemoryIdentity(
  mapPath: string,
  entry: Omit<LocalMemoryIdentityEntry, "updatedAt">,
  now = new Date(),
): Promise<boolean> {
  const resolvedMapPath = resolve(mapPath);
  const resolvedRoot = resolve(entry.root);
  const current = await readLocalMemoryMap(resolvedMapPath);
  const latest = current?.entries
    .filter((item) => item.root === resolvedRoot && item.localPath === entry.localPath)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.directoryName.localeCompare(b.directoryName))[0];
  if (latest && latest.identity === entry.identity && latest.directoryName === entry.directoryName) {
    const age = now.getTime() - Date.parse(latest.updatedAt);
    if (age >= 0 && age < LOCAL_MAP_REFRESH_MS) return true;
  }

  const parent = dirname(resolvedMapPath);
  try { await mkdir(parent, { recursive: true, mode: 0o700 }); }
  catch (error) { if (!hasErrorCode(error, "EEXIST")) throw error; }
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) return false;

  const lockPath = `${resolvedMapPath}.lock`;
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if (hasErrorCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    const existing = await readLocalMemoryMap(resolvedMapPath) ?? { version: 1 as const, entries: [] };
    const updated: LocalMemoryIdentityEntry = {
      root: resolvedRoot,
      localPath: entry.localPath,
      identity: entry.identity,
      directoryName: entry.directoryName,
      updatedAt: now.toISOString(),
    };
    const nextEntries: LocalMemoryIdentityEntry[] = [];
    for (const item of existing.entries) {
      if (item.root !== resolvedRoot || item.localPath !== entry.localPath) {
        nextEntries.push(item);
        continue;
      }
      if (item.directoryName === entry.directoryName) continue;
      // Preserve prior directory mappings for this localPath while those directories still exist
      // on disk (e.g., before a renamed remote's old store is merged and archived).
      if (await localMapDirectoryExists(resolvedRoot, item.directoryName)) {
        nextEntries.push(item);
      }
    }
    nextEntries.push(updated);
    if (nextEntries.length > MAX_LOCAL_MAP_ENTRIES) {
      nextEntries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      nextEntries.length = MAX_LOCAL_MAP_ENTRIES;
    }
    nextEntries.sort((a, b) =>
      a.root.localeCompare(b.root) ||
      a.localPath.localeCompare(b.localPath) ||
      b.updatedAt.localeCompare(a.updatedAt) ||
      a.directoryName.localeCompare(b.directoryName));
    const serialized = JSON.stringify({ version: 1, entries: nextEntries }) + "\n";
    if (Buffer.byteLength(serialized) > MAX_LOCAL_MAP_BYTES) return false;
    await atomicLocalMapWrite(resolvedMapPath, serialized);
    return true;
  } finally {
    await rmdir(lockPath).catch(() => {});
  }
}

async function localMapDirectoryExists(root: string, directoryName: string): Promise<boolean> {
  if (!directoryName || directoryName.includes("/") || directoryName.includes("\\")) return false;
  try {
    const stat = await lstat(join(root, directoryName));
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    return true;
  }
}

async function findNearestGitMarker(canonical: string): Promise<string | null> {
  let directory = canonical;
  while (true) {
    try {
      await lstat(join(directory, ".git"));
      return directory;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

async function resolveGitRepository(gitMarkerDir: string): Promise<{ localIdentity: string; commonGitDir?: string }> {
  const dotGit = join(gitMarkerDir, ".git");
  let stat;
  try { stat = await lstat(dotGit); }
  catch { return { localIdentity: gitMarkerDir }; }

  if (stat.isSymbolicLink()) {
    return { localIdentity: gitMarkerDir };
  }
  if (stat.isDirectory()) {
    return { localIdentity: gitMarkerDir, commonGitDir: dotGit };
  }
  if (!stat.isFile()) {
    return { localIdentity: gitMarkerDir };
  }

  const pointerText = await readBoundedFile(dotGit, MAX_GIT_POINTER_BYTES, false);
  if (!pointerText) return { localIdentity: gitMarkerDir };
  const firstLine = pointerText.split(/\r?\n/, 1)[0] ?? "";
  const match = /^gitdir:\s*(.+?)\s*$/.exec(firstLine);
  if (!match) return { localIdentity: gitMarkerDir };
  const rawGitDir = match[1]!;
  if (!rawGitDir || rawGitDir.includes("\0")) return { localIdentity: gitMarkerDir };

  const gitDir = await safeRealDirectory(resolve(gitMarkerDir, rawGitDir));
  if (!gitDir) return { localIdentity: gitMarkerDir };

  // Linked worktrees contain a commondir file and a bidirectional gitdir back-pointer.
  const commonDirText = await readBoundedFile(join(gitDir, "commondir"), MAX_GIT_POINTER_BYTES, false);
  if (commonDirText !== null) {
    const backPointerText = await readBoundedFile(join(gitDir, "gitdir"), MAX_GIT_POINTER_BYTES, false);
    if (!backPointerText) return { localIdentity: gitMarkerDir };
    const backPointer = resolve(gitDir, backPointerText.trim());
    if (basename(backPointer) !== ".git") return { localIdentity: gitMarkerDir };
    const verifiedDir = await safeRealDirectory(dirname(backPointer));
    if (verifiedDir !== gitMarkerDir) return { localIdentity: gitMarkerDir };

    const commonTarget = commonDirText.trim();
    if (!commonTarget || commonTarget.includes("\0")) return { localIdentity: gitMarkerDir };
    const commonGitDir = await safeRealDirectory(resolve(gitDir, commonTarget));
    if (!commonGitDir) return { localIdentity: gitMarkerDir };
    const localIdentity = basename(commonGitDir) === ".git" ? dirname(commonGitDir) : commonGitDir;
    return { localIdentity, commonGitDir };
  }

  // Submodules and --separate-git-dir checkouts have no commondir; require a matching core.worktree
  // back-pointer so a forged .git file cannot read an unrelated main repository's config.
  const configText = await readBoundedFile(join(gitDir, "config"), MAX_GIT_CONFIG_BYTES, false);
  if (configText !== null) {
    const { coreWorktree } = parseGitConfig(configText);
    if (coreWorktree) {
      const verifiedWorktree = await safeRealDirectory(resolve(gitDir, coreWorktree));
      if (verifiedWorktree === gitMarkerDir) {
        return { localIdentity: gitMarkerDir, commonGitDir: gitDir };
      }
    }
  }
  return { localIdentity: gitMarkerDir };
}

function parseGitConfig(text: string): ParsedGitConfig {
  const result: ParsedGitConfig = {};
  let section = "";
  let subsection = "";
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    // Handle line continuation outside comments.
    while (line.endsWith("\\") && !hasUnescapedEvenTrailingBackslashes(line) && i + 1 < lines.length) {
      line = line.slice(0, -1) + lines[++i]!;
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;

    if (trimmed.startsWith("[")) {
      const header = parseGitConfigSectionHeader(trimmed);
      if (header) {
        section = header.section;
        subsection = header.subsection;
        if (header.remainder) {
          applyGitConfigEntry(section, subsection, header.remainder, result);
        }
      } else {
        section = "";
        subsection = "";
      }
      continue;
    }

    if (section) applyGitConfigEntry(section, subsection, trimmed, result);
  }
  return result;
}

function parseGitConfigSectionHeader(line: string): { section: string; subsection: string; remainder: string } | null {
  const close = findClosingBracket(line);
  if (close < 0) return null;
  const inside = line.slice(1, close).trim();
  const remainder = line.slice(close + 1).trim();
  const quoteIndex = inside.indexOf('"');
  if (quoteIndex < 0) {
    const section = inside.toLowerCase();
    return /^[a-z0-9.-]+$/.test(section) ? { section, subsection: "", remainder } : null;
  }
  const section = inside.slice(0, quoteIndex).trim().toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(section)) return null;
  if (!inside.endsWith('"') || quoteIndex === inside.length - 1) return null;
  const rawSub = inside.slice(quoteIndex + 1, -1);
  let subsection = "";
  for (let i = 0; i < rawSub.length; i++) {
    if (rawSub[i] === "\\" && i + 1 < rawSub.length) subsection += rawSub[++i];
    else subsection += rawSub[i];
  }
  return { section, subsection, remainder };
}

function findClosingBracket(line: string): number {
  let inQuotes = false;
  for (let i = 1; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === "\\") { i++; continue; }
      if (ch === '"') inQuotes = false;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === "]") return i;
    }
  }
  return -1;
}

function applyGitConfigEntry(section: string, subsection: string, line: string, target: ParsedGitConfig): void {
  const eq = line.indexOf("=");
  if (eq <= 0) return;
  const key = line.slice(0, eq).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(key)) return;
  const value = parseGitConfigValue(line.slice(eq + 1));
  if (value === null) return;
  if (section === "core" && subsection === "" && key === "worktree") {
    target.coreWorktree = value;
  } else if (section === "remote" && subsection === "origin" && key === "url") {
    if (!target.originUrl) target.originUrl = value;
  }
}

function parseGitConfigValue(raw: string): string | null {
  let inQuotes = false;
  let value = "";
  let trailingSpace = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inQuotes) {
      if (ch === "\\" && i + 1 < raw.length) {
        const next = raw[++i]!;
        if (next === "n") value += "\n";
        else if (next === "t") value += "\t";
        else if (next === "b") value += "\b";
        else value += next;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        value += ch;
      }
    } else {
      if (ch === "#" || ch === ";") break;
      if (ch === '"') {
        if (value) value += trailingSpace;
        trailingSpace = "";
        inQuotes = true;
      } else if (ch === "\\" && i + 1 < raw.length) {
        if (value) value += trailingSpace;
        trailingSpace = "";
        const next = raw[++i]!;
        if (next === "n") value += "\n";
        else if (next === "t") value += "\t";
        else if (next === "b") value += "\b";
        else value += next;
      } else if (ch === " " || ch === "\t") {
        if (value) trailingSpace += ch;
      } else {
        value += trailingSpace + ch;
        trailingSpace = "";
      }
    }
  }
  if (inQuotes) return null;
  return value;
}

function hasUnescapedEvenTrailingBackslashes(line: string): boolean {
  let count = 0;
  for (let i = line.length - 1; i >= 0 && line[i] === "\\"; i--) count++;
  return count % 2 === 0;
}

function isLocalGitRemote(url: string): boolean {
  return url.startsWith("/") || url.startsWith("./") || url.startsWith("../") ||
    url.startsWith("~/") || /^file:\/\//i.test(url) || /^[a-zA-Z]:[\\/]/.test(url);
}

function normalizeGitRemotePath(rawPath: string, host: string): string | null {
  let path = rawPath.trim().replace(/^\/+|\/+$/g, "");
  if (!path) return null;
  path = path.replace(/\/+/g, "/");
  path = path.replace(/\.git$/i, "").replace(/\/+$/g, "");
  if (!path) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  if (CASE_INSENSITIVE_HOSTS.has(host)) path = path.toLowerCase();
  return path;
}

async function findSshHostNameInFile(
  alias: string,
  filePath: string,
  sshDir: string,
  depth: number,
  visited: Set<string>,
  counter: { files: number },
): Promise<string | null> {
  if (depth > MAX_SSH_INCLUDE_DEPTH || counter.files >= MAX_SSH_CONFIG_FILES) return null;
  let canonicalPath: string;
  try { canonicalPath = await realpath(filePath); }
  catch { return null; }
  if (visited.has(canonicalPath)) return null;
  visited.add(canonicalPath);
  counter.files++;

  // Allow regular dotfiles symlinks for ~/.ssh/config while bounding size and avoiding FIFO blocking.
  const content = await readBoundedFile(canonicalPath, MAX_SSH_CONFIG_BYTES, true);
  if (content === null) return null;

  let active = true;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripSshComment(rawLine).trim();
    if (!line) continue;
    const parsed = parseSshDirective(line);
    if (!parsed) continue;
    const { keyword, value } = parsed;
    if (keyword === "host") {
      const patterns = splitSshTokens(value);
      active = matchesSshHostPatterns(alias, patterns);
      continue;
    }
    if (keyword === "match") {
      // Do not evaluate Match conditions (exec, canonical, etc.); disable until next Host block.
      active = false;
      continue;
    }
    if (!active) continue;
    if (keyword === "include") {
      const includePatterns = splitSshTokens(value);
      for (const pattern of includePatterns) {
        const targets = await expandSshIncludePattern(pattern, sshDir);
        for (const target of targets) {
          const found = await findSshHostNameInFile(alias, target, sshDir, depth + 1, visited, counter);
          if (found) return found;
        }
      }
      continue;
    }
    if (keyword === "hostname") {
      const tokens = splitSshTokens(value);
      if (tokens[0]) return tokens[0];
    }
  }
  return null;
}

function stripSshComment(line: string): string {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "#" && !inQuotes) return line.slice(0, i);
  }
  return line;
}

function parseSshDirective(line: string): { keyword: string; value: string } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.+)$/.exec(line);
  if (!match) return null;
  return { keyword: match[1]!.toLowerCase(), value: match[2]!.trim() };
}

function splitSshTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && (ch === " " || ch === "\t")) {
      if (current) { tokens.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function matchesSshHostPatterns(alias: string, patterns: string[]): boolean {
  const target = alias.toLowerCase();
  let matchedPositive = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const body = (negated ? pattern.slice(1) : pattern).toLowerCase();
    if (!body) continue;
    if (matchSshWildcard(target, body)) {
      if (negated) return false;
      matchedPositive = true;
    }
  }
  return matchedPositive;
}

function matchSshWildcard(text: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(text);
}

async function expandSshIncludePattern(pattern: string, sshDir: string): Promise<string[]> {
  let expanded = pattern;
  if (expanded.startsWith("~/")) expanded = join(homedir(), expanded.slice(2));
  else if (!isAbsolute(expanded)) expanded = join(sshDir, expanded);

  if (!expanded.includes("*") && !expanded.includes("?")) {
    return [expanded];
  }
  const parent = dirname(expanded);
  const filePattern = basename(expanded);
  if (parent.includes("*") || parent.includes("?")) return [];
  try {
    const entries = await readdir(parent);
    return entries
      .filter((name) => matchSshWildcard(name, filePattern))
      .sort()
      .map((name) => join(parent, name));
  } catch {
    return [];
  }
}

function expandSshHostNameTokens(hostName: string, alias: string): string | null {
  let out = "";
  for (let i = 0; i < hostName.length; i++) {
    const ch = hostName[i]!;
    if (ch === "%") {
      if (i + 1 >= hostName.length) return null;
      const next = hostName[++i]!;
      if (next === "h") out += alias;
      else if (next === "%") out += "%";
      else return null; // Unsupported OpenSSH token (%r, %n, etc.): keep original host safely.
    } else {
      out += ch;
    }
  }
  return out || null;
}

async function readLocalMemoryMap(mapPath: string): Promise<LocalMemoryIdentityMap | null> {
  let file;
  try { file = await open(mapPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_LOCAL_MAP_BYTES) {
      throw new Error(`Memory local identity map is unsafe or exceeds ${MAX_LOCAL_MAP_BYTES} bytes: ${mapPath}`);
    }
    const buffer = Buffer.alloc(MAX_LOCAL_MAP_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_LOCAL_MAP_BYTES) {
      throw new Error(`Memory local identity map exceeds ${MAX_LOCAL_MAP_BYTES} bytes: ${mapPath}`);
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    return parseLocalMemoryMap(JSON.parse(text));
  } catch (error) {
    throw new Error(`Memory local identity map is corrupt (${mapPath}); repair or remove it explicitly`, { cause: error });
  } finally {
    await file.close();
  }
}

function parseLocalMemoryMap(data: unknown): LocalMemoryIdentityMap {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.entries) || Object.keys(data).length !== 2 ||
      data.entries.length > MAX_LOCAL_MAP_ENTRIES) {
    throw new Error("Invalid local identity map header");
  }
  const entries: LocalMemoryIdentityEntry[] = [];
  for (const item of data.entries) {
    if (!isRecord(item) || Object.keys(item).length !== 5 ||
        typeof item.root !== "string" || !isAbsolute(item.root) ||
        typeof item.localPath !== "string" || !isAbsolute(item.localPath) ||
        typeof item.identity !== "string" || !item.identity || item.identity.length > 4096 ||
        typeof item.directoryName !== "string" || !item.directoryName ||
        item.directoryName.includes("/") || item.directoryName.includes("\\") ||
        typeof item.updatedAt !== "string" || Number.isNaN(Date.parse(item.updatedAt))) {
      throw new Error("Invalid local identity map entry");
    }
    entries.push({
      root: item.root,
      localPath: item.localPath,
      identity: item.identity,
      directoryName: item.directoryName,
      updatedAt: item.updatedAt,
    });
  }
  return { version: 1, entries };
}

async function atomicLocalMapWrite(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.memory-${randomUUID()}.tmp`);
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporaryPath, path);
    const dir = await open(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await dir.sync(); } finally { await dir.close(); }
  } finally {
    try { await unlink(temporaryPath); }
    catch (error) { if (!hasErrorCode(error, "ENOENT")) throw error; }
  }
}

async function safeRealDirectory(path: string): Promise<string | null> {
  try {
    const resolved = await realpath(path);
    const stat = await lstat(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

async function readBoundedFile(path: string, limit: number, followSymlinks: boolean): Promise<string | null> {
  const flags = constants.O_RDONLY | constants.O_NONBLOCK | (followSymlinks ? 0 : constants.O_NOFOLLOW);
  let file;
  try { file = await open(path, flags); }
  catch { return null; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) return null;
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) return null;
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
