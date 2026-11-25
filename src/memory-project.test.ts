import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import { readMemoryAccess, recordMemoryNoteRead } from "./memory-access.ts";
import { buildMemoryDreamPrompt } from "./memory-dream-worker.ts";
import {
  defaultLocalMemoryMapPath, discoverMatchingMemoryStores, legacyProjectDirectoryName, memoryProjectSlug,
  memoryStoreDirectoryName, normalizeGitRemoteUrl, readLocalMemoryIdentity, resolveMemoryProject,
  resolveMemoryProjectDetails, resolveSshConfigHostName, writeLocalMemoryIdentity,
} from "./memory-project.ts";
import { claimMemoryDream, readMemorySchedule, recordMemoryTurn } from "./memory-schedule.ts";
import { createMemorySourceProvider } from "./memory-sources.ts";
import {
  createMemoryStoreHandle, isMemoryStoreLockedError, listMemoryNotes, readMemoryNote,
  resolveMemoryProjectHandle, writeMemoryNote,
} from "./memory-store.ts";

async function createGitRepo(root: string, name: string, originUrl?: string): Promise<string> {
  const repo = join(root, name);
  await mkdir(join(repo, ".git"), { recursive: true });
  const config = originUrl ? `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${originUrl}\n` : "[core]\n\trepositoryformatversion = 0\n";
  await writeFile(join(repo, ".git", "config"), config);
  return repo;
}

async function createLinkedWorktree(
  mainRepo: string,
  worktreePath: string,
  worktreeName: string,
  options: { relative?: boolean; bare?: boolean } = {},
): Promise<string> {
  const gitCommon = options.bare ? mainRepo : join(mainRepo, ".git");
  const adminDir = join(gitCommon, "worktrees", worktreeName);
  await mkdir(adminDir, { recursive: true });
  await mkdir(worktreePath, { recursive: true });
  const dotGit = join(worktreePath, ".git");
  if (options.relative) {
    // Both repo and worktree sit under the same test root.
    const toAdmin = options.bare
      ? `../${basename(mainRepo)}/worktrees/${worktreeName}`
      : `../${basename(mainRepo)}/.git/worktrees/${worktreeName}`;
    await writeFile(dotGit, `gitdir: ${toAdmin}\n`);
    await writeFile(join(adminDir, "commondir"), "../..\n");
    await writeFile(join(adminDir, "gitdir"), options.bare ? `../../../${basename(worktreePath)}/.git\n` : `../../../../${basename(worktreePath)}/.git\n`);
  } else {
    await writeFile(dotGit, `gitdir: ${adminDir}\n`);
    await writeFile(join(adminDir, "commondir"), "../..\n");
    await writeFile(join(adminDir, "gitdir"), `${dotGit}\n`);
  }
  return worktreePath;
}

test("linked worktrees and bare-repo worktrees share one repository identity", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const main = await createGitRepo(directory, "main-repo");
  const absWt = await createLinkedWorktree(main, join(directory, "wt-feature"), "wt-feature");
  const relWt = await createLinkedWorktree(main, join(directory, "wt-relative"), "wt-relative", { relative: true });
  const nested = join(absWt, "packages", "core");
  await mkdir(nested, { recursive: true });

  const mainDetails = await resolveMemoryProjectDetails(main, { sshConfigPath: "" });
  const absDetails = await resolveMemoryProjectDetails(nested, { sshConfigPath: "" });
  const relDetails = await resolveMemoryProjectDetails(relWt, { sshConfigPath: "" });

  assert.equal(mainDetails.isRemote, false);
  assert.equal(mainDetails.identity, main);
  assert.equal(absDetails.identity, main);
  assert.equal(absDetails.localIdentity, main);
  assert.equal(absDetails.worktreeRoot, absWt);
  assert.equal(relDetails.identity, main);
  assert.equal(relDetails.worktreeRoot, relWt);

  // Bare repo + two worktrees share the bare repo directory as localIdentity.
  const bare = join(directory, "bare.git");
  await mkdir(bare, { recursive: true });
  await writeFile(join(bare, "config"), "[core]\n\tbare = true\n");
  const bareWtA = await createLinkedWorktree(bare, join(directory, "bare-a"), "bare-a", { bare: true });
  const bareWtB = await createLinkedWorktree(bare, join(directory, "bare-b"), "bare-b", { bare: true, relative: true });
  assert.equal(await resolveMemoryProject(bareWtA, { sshConfigPath: "" }), bare);
  assert.equal(await resolveMemoryProject(bareWtB, { sshConfigPath: "" }), bare);
});

test("forged or symlinked gitdir pointers fail closed to their own directory", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const victim = await createGitRepo(directory, "victim", "https://github.com/org/secret.git");
  await createLinkedWorktree(victim, join(directory, "victim-wt"), "victim-wt");

  // Forged .git file pointing directly to victim/.git (no core.worktree back-pointer).
  const forgedMain = join(directory, "forged-main");
  await mkdir(forgedMain);
  await writeFile(join(forgedMain, ".git"), `gitdir: ${join(victim, ".git")}\n`);
  assert.equal(await resolveMemoryProject(forgedMain, { sshConfigPath: "" }), forgedMain);

  // Forged .git file pointing to victim's worktree admin dir (gitdir back-pointer points to victim-wt).
  const forgedWt = join(directory, "forged-wt");
  await mkdir(forgedWt);
  await writeFile(join(forgedWt, ".git"), `gitdir: ${join(victim, ".git", "worktrees", "victim-wt")}\n`);
  assert.equal(await resolveMemoryProject(forgedWt, { sshConfigPath: "" }), forgedWt);

  // Symlinked .git is not followed.
  const symRepo = join(directory, "sym-repo");
  await mkdir(symRepo);
  await symlink(join(victim, ".git"), join(symRepo, ".git"));
  assert.equal(await resolveMemoryProject(symRepo, { sshConfigPath: "" }), symRepo);
});

test("submodules with matching core.worktree resolve to their own remote, not the superproject", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const superRepo = await createGitRepo(directory, "super", "https://github.com/org/super.git");
  const subDir = join(superRepo, "vendor", "sub");
  const subGitDir = join(superRepo, ".git", "modules", "vendor", "sub");
  await mkdir(subDir, { recursive: true });
  await mkdir(subGitDir, { recursive: true });
  await writeFile(join(subDir, ".git"), "gitdir: ../../.git/modules/vendor/sub\n");
  await writeFile(join(subGitDir, "config"), [
    "[core]",
    "\tworktree = ../../../../vendor/sub",
    '[remote "origin"]',
    "\turl = git@github.com:Other/SubMod.git",
  ].join("\n") + "\n");

  const subDetails = await resolveMemoryProjectDetails(subDir, { sshConfigPath: "" });
  assert.equal(subDetails.identity, "git:github.com/other/submod");
  assert.equal(subDetails.localIdentity, subDir);
  assert.equal(subDetails.worktreeRoot, subDir);
});

test("git remote URLs normalize consistently across protocols, credentials, ports and SSH aliases", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const sshDir = join(directory, "ssh");
  const confD = join(sshDir, "conf.d");
  await mkdir(confD, { recursive: true });
  const sshConfig = join(sshDir, "config");
  await writeFile(sshConfig, [
    "# Top-level include",
    "Include conf.d/*.conf",
    "Host github-work !github-work-blocked",
    "  HostName github.com",
    "Host match-ignored",
    "  Match exec \"false\"",
    "  HostName wrong.example.com",
    "Host token-host",
    "  HostName %h.internal.example",
    "Host unsupported-token",
    "  HostName %r.example.com",
  ].join("\n") + "\n");
  await writeFile(join(confD, "01-extra.conf"), [
    "Include ../config", // cycle must be ignored safely
    "Host corp-*",
    "  HostName git.corp.example",
  ].join("\n") + "\n");

  const canonicalGithub = "git:github.com/org/repo";
  for (const raw of [
    "https://github.com/Org/Repo.git",
    "https://user:secret-token@github.com:443/Org/Repo.git/",
    "http://github.com:80/Org/Repo",
    "ssh://git@github.com:22/Org/Repo.git",
    "git@github.com:Org/Repo.git",
    "git@github.com:/Org/Repo.git",
    "git://github.com:9418/Org/Repo.git",
    "git@github-work:Org/Repo.git",
  ]) {
    assert.equal(await normalizeGitRemoteUrl(raw, sshConfig), canonicalGithub, raw);
  }

  // Non-default port and case-sensitive custom host path are preserved.
  assert.equal(
    await normalizeGitRemoteUrl("ssh://git@git.example.com:2222/Team/MyApp.git", sshConfig),
    "git:git.example.com:2222/Team/MyApp",
  );
  // SSH Include wildcard alias resolves host while preserving custom host path case.
  assert.equal(
    await normalizeGitRemoteUrl("git@corp-prod:Platform/Service.git", sshConfig),
    "git:git.corp.example/Platform/Service",
  );
  // %h token expands; unsupported %r keeps original alias safely.
  assert.equal(await resolveSshConfigHostName("token-host", sshConfig), "token-host.internal.example");
  assert.equal(await resolveSshConfigHostName("unsupported-token", sshConfig), null);
  assert.equal(await resolveSshConfigHostName("github-work-blocked", sshConfig), null);
  assert.equal(await resolveSshConfigHostName("match-ignored", sshConfig), null);

  // Local remotes are rejected so local path identity is used instead.
  for (const local of ["/srv/repos/app.git", "../app.git", "./app.git", "~/repos/app.git", "file:///srv/app.git"]) {
    assert.equal(await normalizeGitRemoteUrl(local, sshConfig), null, local);
  }

  // Two distinct clones (HTTPS vs SSH alias) share one identity.
  const cloneA = await createGitRepo(directory, "clone-https", "https://github.com/Org/Repo.git");
  const cloneB = await createGitRepo(directory, "clone-ssh", "git@github-work:Org/Repo.git");
  assert.equal(await resolveMemoryProject(cloneA, { sshConfigPath: sshConfig }), canonicalGithub);
  assert.equal(await resolveMemoryProject(cloneB, { sshConfigPath: sshConfig }), canonicalGithub);
});

test("readable directory naming sanitizes slugs, avoids global collision and stays distinct from legacy names", () => {
  assert.equal(memoryProjectSlug("git:github.com/ttttmr/pi-memory"), "ttttmr-pi-memory");
  assert.equal(memoryProjectSlug("git:gitlab.com/group/subgroup/service"), "subgroup-service");
  assert.equal(memoryProjectSlug("/Users/dev/global"), "project");
  assert.equal(memoryProjectSlug("/Users/dev/中文项目"), "project");
  assert.equal(memoryProjectSlug("/Users/dev/.hidden-repo"), "hidden-repo");

  const id = "/Users/dev/global";
  const dirName = memoryStoreDirectoryName(id, "project");
  const legacyName = legacyProjectDirectoryName(id);
  assert.notEqual(dirName, "global");
  assert.notEqual(dirName, legacyName);
  assert.equal(dirName, `project-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`);
  assert.equal(legacyName, `project-${createHash("sha256").update(id).digest("hex")}`);
});

test("read fallback and write-time migration preserve notes, history, access stats and schedule across repo evolution", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const mapPath = defaultLocalMemoryMapPath(join(directory, "agent"));
  const repo = join(directory, "my-app");
  await mkdir(repo);

  // Stage 1: Simulate pre-upgrade legacy `project-<sha256>` directory for a plain local directory.
  const legacyDir = join(root, legacyProjectDirectoryName(repo));
  await mkdir(join(legacyDir, ".history", "notes"), { recursive: true });
  await writeFile(join(legacyDir, ".identity.json"), JSON.stringify({ identity: repo, scope: "project" }) + "\n");
  await writeFile(join(legacyDir, "MEMORY.md"), "# Index\n- [Plan](notes/plan.md)\n");
  await mkdir(join(legacyDir, "notes"), { recursive: true });
  await writeFile(join(legacyDir, "notes", "plan.md"), "# Plan\nv1\n");
  await writeFile(join(legacyDir, ".history", "notes", "plan.md-snap"), "# Plan\nv0\n");

  // Read works without creating or migrating the directory or local map.
  const localResolved = await resolveMemoryProjectHandle(root, repo, { sshConfigPath: "", localMapPath: mapPath, bindLocalMap: true });
  assert.equal((await readMemoryNote(localResolved.handle, "notes/plan.md"))?.content, "# Plan\nv1\n");
  assert.deepEqual(await readdir(root), [legacyProjectDirectoryName(repo)]);
  assert.equal(await readLocalMemoryIdentity(mapPath, root, repo), null);

  // Advisory read stats work on the legacy store before migration.
  assert.equal(await recordMemoryNoteRead(localResolved.handle, "notes/plan.md"), true);

  // First write migrates legacy `project-<64hex>` -> readable `my-app-<16hex>` and updates local map.
  const current = (await readMemoryNote(localResolved.handle, "notes/plan.md"))!;
  await writeMemoryNote(localResolved.handle, { path: "notes/plan.md", content: "# Plan\nv2\n", expectedHash: current.hash });
  assert.deepEqual(await readdir(root), [basename(localResolved.handle.directory)]);
  assert.deepEqual(
    JSON.parse(await readFile(join(localResolved.handle.directory, ".identity.json"), "utf8")),
    { identity: repo, scope: "project" },
  );
  assert.equal((await readMemoryAccess(localResolved.handle))?.notes[0]?.reads, 1);
  assert.equal(await readFile(join(localResolved.handle.directory, ".history", "notes", "plan.md-snap"), "utf8"), "# Plan\nv0\n");

  // Stage 2: Initialize Git and add remote `origin` (repo A).
  await mkdir(join(repo, ".git"));
  await writeFile(join(repo, ".git", "config"), '[remote "origin"]\n\turl = https://github.com/org/repo-a.git\n');
  const remoteA = await resolveMemoryProjectHandle(root, repo, { sshConfigPath: "", localMapPath: mapPath, bindLocalMap: true });
  assert.equal(remoteA.project.identity, "git:github.com/org/repo-a");
  assert.equal((await readMemoryNote(remoteA.handle, "notes/plan.md"))?.content, "# Plan\nv2\n");
  // Still not migrated on read.
  assert.deepEqual(await readdir(root), [basename(localResolved.handle.directory)]);

  // Write migrates local dir -> remote A dir and updates local map.
  const v2 = (await readMemoryNote(remoteA.handle, "notes/plan.md"))!;
  await writeMemoryNote(remoteA.handle, { path: "notes/plan.md", content: "# Plan\nv3\n", expectedHash: v2.hash });
  assert.deepEqual(await readdir(root), [basename(remoteA.handle.directory)]);
  assert.equal((await readLocalMemoryIdentity(mapPath, root, repo))?.identity, "git:github.com/org/repo-a");

  // Stage 3: Change remote `origin` URL to repo B; local map bridges repo A -> repo B!
  await writeFile(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:org/repo-b.git\n');
  const remoteB = await resolveMemoryProjectHandle(root, repo, { sshConfigPath: "", localMapPath: mapPath, bindLocalMap: true });
  assert.equal(remoteB.project.identity, "git:github.com/org/repo-b");
  assert.equal((await readMemoryNote(remoteB.handle, "notes/plan.md"))?.content, "# Plan\nv3\n");
  const v3 = (await readMemoryNote(remoteB.handle, "notes/plan.md"))!;
  await writeMemoryNote(remoteB.handle, { path: "notes/plan.md", content: "# Plan\nv4\n", expectedHash: v3.hash });
  assert.deepEqual(await readdir(root), [basename(remoteB.handle.directory)]);
  assert.deepEqual(
    JSON.parse(await readFile(join(remoteB.handle.directory, ".identity.json"), "utf8")),
    { identity: "git:github.com/org/repo-b", scope: "project" },
  );
  assert.equal((await readLocalMemoryIdentity(mapPath, root, repo))?.identity, "git:github.com/org/repo-b");
  assert.deepEqual((await listMemoryNotes(remoteB.handle)).map((n) => n.path), ["MEMORY.md", "notes/plan.md"]);
});

test("migration selects deterministic primary seed when sibling stores exist, while failing closed on active leases, locks and corrupt local map", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const mapPath = defaultLocalMemoryMapPath(join(directory, "agent"));
  const repo = await createGitRepo(directory, "repo", "https://github.com/org/conflict.git");
  const wt = await createLinkedWorktree(repo, join(directory, "repo-wt"), "repo-wt");

  // 1. Multiple matching directories (e.g. pre-upgrade main repo AND pre-upgrade worktree) select mainLegacy deterministically.
  const mainLegacy = join(root, legacyProjectDirectoryName(repo));
  const wtLegacy = join(root, legacyProjectDirectoryName(wt));
  await mkdir(mainLegacy, { recursive: true });
  await mkdir(wtLegacy, { recursive: true });
  await writeFile(join(mainLegacy, ".identity.json"), JSON.stringify({ identity: repo, scope: "project" }) + "\n");
  await writeFile(join(wtLegacy, ".identity.json"), JSON.stringify({ identity: wt, scope: "project" }) + "\n");
  await writeFile(join(mainLegacy, "main.md"), "main note\n");
  await writeFile(join(wtLegacy, "wt.md"), "wt note\n");

  const wtResolved = await resolveMemoryProjectHandle(root, wt, { sshConfigPath: "", localMapPath: mapPath, bindLocalMap: true });
  assert.equal((await readMemoryNote(wtResolved.handle, "main.md"))?.content, "main note\n");
  // Read-only fallback leaves both legacy directories untouched.
  assert.equal(await readFile(join(wtLegacy, "wt.md"), "utf8"), "wt note\n");

  // 2. Active dream lease on the selected legacy dir defers migration safely.
  const legacyHandle = createMemoryStoreHandle(root, repo, "project");
  const claimToken = randomUUID();
  const messages = Array.from({ length: 50 }, (_, index) => ({ sessionId: "s1", entryId: `e${index}` }));
  await writeFile(join(mainLegacy, ".dream-state.json"), JSON.stringify({
    version: 2, observedTurns: 50, processedTurns: 0, messages, legacy: null,
    claim: { ownerId: "active-worker", token: claimToken, generation: 50, expiresAt: Date.now() + 60_000, sessions: [{ sessionId: "s1" }] },
  }) + "\n");
  await assert.rejects(
    writeMemoryNote(wtResolved.handle, { path: "new.md", content: "x", expectedHash: null }),
    /Memory migration deferred/,
  );
  assert.equal(await readFile(join(mainLegacy, "main.md"), "utf8"), "main note\n");
  assert.notEqual(legacyHandle.directory, mainLegacy);

  // 3. Expired lease allows lock check; held legacy lock fails with MemoryStoreLockedError without stealing.
  await writeFile(join(mainLegacy, ".dream-state.json"), JSON.stringify({
    version: 2, observedTurns: 50, processedTurns: 0, messages, legacy: null,
    claim: { ownerId: "expired-worker", token: claimToken, generation: 50, expiresAt: Date.now() - 1000, sessions: [{ sessionId: "s1" }] },
  }) + "\n");
  const heldLock = `${mainLegacy}.lock`;
  await mkdir(heldLock);
  await assert.rejects(
    writeMemoryNote(wtResolved.handle, { path: "new.md", content: "x", expectedHash: null }),
    (error: unknown) => isMemoryStoreLockedError(error) && error.lockPath === heldLock,
  );
  await rm(heldLock, { recursive: true });

  // Now migration promotes mainLegacy -> primary, preserves schedule state, and leaves wtLegacy intact for background merge.
  await writeMemoryNote(wtResolved.handle, { path: "new.md", content: "x\n", expectedHash: null });
  assert.equal((await readMemorySchedule(wtResolved.handle)).pendingTurns, 50);
  assert.ok(await claimMemoryDream(wtResolved.handle, { ownerId: "post-migration-worker" }));
  assert.equal(await readFile(join(wtLegacy, "wt.md"), "utf8"), "wt note\n");

  // 4. Corrupt device-local map fails closed on project resolution.
  await writeFile(mapPath, "{corrupt-json");
  await assert.rejects(
    resolveMemoryProjectHandle(root, repo, { sshConfigPath: "", localMapPath: mapPath }),
    /Memory local identity map is corrupt/,
  );
});

test("discoverMatchingMemoryStores scans sibling worktrees and clones while ignoring submodules, foreign repos, missing paths and symlinks", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const mapPath = defaultLocalMemoryMapPath(join(directory, "agent"));
  await mkdir(root, { recursive: true });

  const mainRepo = await createGitRepo(directory, "main-checkout", "https://github.com/org/shared.git");
  const wt1 = await createLinkedWorktree(mainRepo, join(directory, "wt-feature"), "wt-feature");
  const separateClone = await createGitRepo(directory, "completely-different-name", "git@github.com:ORG/Shared.git");
  const unrelatedRepo = await createGitRepo(directory, "other-repo", "https://github.com/org/other.git");

  // Submodule inside mainRepo has its own remote and no commondir; must never be merged into parent.
  const submodule = join(mainRepo, "deps", "sub");
  const subGitDir = join(mainRepo, ".git", "modules", "sub");
  await mkdir(submodule, { recursive: true });
  await mkdir(subGitDir, { recursive: true });
  await writeFile(join(submodule, ".git"), `gitdir: ../../.git/modules/sub\n`);
  await writeFile(join(subGitDir, "config"), `[remote "origin"]\n\turl = https://github.com/org/submodule.git\n`);

  const createLegacyStore = async (identity: string, useNewName = false) => {
    const dirName = useNewName ? memoryStoreDirectoryName(identity, "project") : legacyProjectDirectoryName(identity);
    const dir = join(root, dirName);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".identity.json"), JSON.stringify({ identity, scope: "project" }) + "\n");
    return dir;
  };

  const mainLegacy = await createLegacyStore(mainRepo);
  const wtLegacy = await createLegacyStore(wt1);
  const cloneLegacy = await createLegacyStore(separateClone);
  const cloneNewLocal = await createLegacyStore(separateClone, true);
  const unrelatedLegacy = await createLegacyStore(unrelatedRepo);
  const submoduleLegacy = await createLegacyStore(submodule);
  const nonexistentPath = join(directory, "deleted-worktree");
  const deletedLegacy = await createLegacyStore(nonexistentPath);
  const renamedRemoteStore = await createLegacyStore("git:github.com/org/old-name", true);
  await writeLocalMemoryIdentity(mapPath, {
    root,
    localPath: separateClone,
    identity: "git:github.com/org/old-name",
    directoryName: basename(renamedRemoteStore),
  });

  // Also add a symlinked store and global dir that must be ignored.
  await mkdir(join(root, "global"), { recursive: true });
  await symlink(unrelatedLegacy, join(root, "symlink-store"));

  const details = await resolveMemoryProjectDetails(wt1, { sshConfigPath: "" });
  const discovered = await discoverMatchingMemoryStores(root, details, { sshConfigPath: "", localMapPath: mapPath });
  const dirs = discovered.map((item) => item.directory);

  // Direct candidates appear first (mainRepo before wt1), followed by expanded sibling matches.
  assert.equal(dirs[0], mainLegacy);
  assert.equal(dirs[1], wtLegacy);
  assert.ok(dirs.includes(cloneLegacy));
  assert.ok(dirs.includes(cloneNewLocal));
  assert.ok(dirs.includes(renamedRemoteStore));
  assert.ok(!dirs.includes(unrelatedLegacy));
  assert.ok(!dirs.includes(submoduleLegacy));
  assert.ok(!dirs.includes(deletedLegacy));
  assert.equal(dirs.length, 5);

  // Local-only bare repo + two worktrees also discover each other without any remote.
  const bare = join(directory, "bare.git");
  await mkdir(join(bare, "worktrees", "b1"), { recursive: true });
  await mkdir(join(bare, "worktrees", "b2"), { recursive: true });
  await writeFile(join(bare, "config"), "[core]\n\tbare = true\n");
  const b1 = join(directory, "bare-wt-1");
  const b2 = join(directory, "bare-wt-2");
  await mkdir(b1);
  await mkdir(b2);
  await writeFile(join(b1, ".git"), `gitdir: ${join(bare, "worktrees", "b1")}\n`);
  await writeFile(join(bare, "worktrees", "b1", "commondir"), "../..\n");
  await writeFile(join(bare, "worktrees", "b1", "gitdir"), `${join(b1, ".git")}\n`);
  await writeFile(join(b2, ".git"), `gitdir: ${join(bare, "worktrees", "b2")}\n`);
  await writeFile(join(bare, "worktrees", "b2", "commondir"), "../..\n");
  await writeFile(join(bare, "worktrees", "b2", "gitdir"), `${join(b2, ".git")}\n`);

  const b1Legacy = await createLegacyStore(b1);
  const b2Legacy = await createLegacyStore(b2);
  const bareDetails = await resolveMemoryProjectDetails(b2, { sshConfigPath: "" });
  const bareDiscovered = await discoverMatchingMemoryStores(root, bareDetails, { sshConfigPath: "" });
  assert.deepEqual(new Set(bareDiscovered.map((item) => item.directory)), new Set([b1Legacy, b2Legacy]));
});

test("device-local map skips redundant rewrites while fresh and bounds capacity to 500 entries", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const mapPath = defaultLocalMemoryMapPath(directory);
  const root = join(directory, "memory");
  const t0 = new Date("2026-11-01T00:00:00.000Z");
  const t1 = new Date("2026-11-01T01:00:00.000Z");
  const t2 = new Date("2026-11-03T00:00:00.000Z");

  assert.equal(await writeLocalMemoryIdentity(mapPath, {
    root, localPath: "/repo/a", identity: "git:github.com/org/a", directoryName: "org-a-0123456789abcdef",
  }, t0), true);
  // Fresh duplicate returns true without rewriting updatedAt.
  assert.equal(await writeLocalMemoryIdentity(mapPath, {
    root, localPath: "/repo/a", identity: "git:github.com/org/a", directoryName: "org-a-0123456789abcdef",
  }, t1), true);
  assert.equal((await readLocalMemoryIdentity(mapPath, root, "/repo/a"))?.updatedAt, t0.toISOString());

  // Stale (>24h) refreshes updatedAt.
  assert.equal(await writeLocalMemoryIdentity(mapPath, {
    root, localPath: "/repo/a", identity: "git:github.com/org/a", directoryName: "org-a-0123456789abcdef",
  }, t2), true);
  assert.equal((await readLocalMemoryIdentity(mapPath, root, "/repo/a"))?.updatedAt, t2.toISOString());
});

test("device-local map preserves existing predecessor remote stores across writes and prunes vanished ones", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const mapPath = defaultLocalMemoryMapPath(directory);
  const repo = await createGitRepo(directory, "renamed-sync", "https://github.com/org/old-remote.git");

  // 1. Initial store under old remote writes localMap entry.
  const oldResolved = await resolveMemoryProjectHandle(root, repo, {
    sshConfigPath: "", localMapPath: mapPath, bindLocalMap: true,
  });
  await writeMemoryNote(oldResolved.handle, { path: "old.md", content: "# From old remote\n", expectedHash: null });

  // 2. Remote is renamed AND a synced store for the new remote already exists on disk.
  await writeFile(join(repo, ".git", "config"),
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://github.com/org/new-remote.git\n');
  const newResolved = await resolveMemoryProjectHandle(root, repo, {
    sshConfigPath: "", localMapPath: mapPath, bindLocalMap: true,
  });
  await mkdir(newResolved.handle.directory, { recursive: true });
  await writeFile(
    join(newResolved.handle.directory, ".identity.json"),
    JSON.stringify({ identity: newResolved.project.identity, scope: "project" }) + "\n",
  );
  // A foreground write updates localMap for the new remote; old remote directory still exists on disk.
  await writeMemoryNote(newResolved.handle, { path: "new.md", content: "# From synced new remote\n", expectedHash: null });

  // Latest entry points to new remote, yet old remote store stays discoverable until archived!
  assert.equal((await readLocalMemoryIdentity(mapPath, root, repo))?.identity, "git:github.com/org/new-remote");
  const discovered = await discoverMatchingMemoryStores(root, newResolved.project, {
    sshConfigPath: "", localMapPath: mapPath,
  });
  assert.deepEqual(discovered.map((item) => item.directory), [oldResolved.handle.directory]);

  // Once the old directory is removed/archived, the next localMap refresh prunes the stale entry.
  await rm(oldResolved.handle.directory, { recursive: true, force: true });
  await writeLocalMemoryIdentity(mapPath, {
    root,
    localPath: repo,
    identity: newResolved.project.identity,
    directoryName: memoryStoreDirectoryName(newResolved.project.identity, "project"),
  }, new Date(Date.now() + 48 * 60 * 60 * 1000));
  const raw = JSON.parse(await readFile(mapPath, "utf8")) as { entries: { directoryName: string }[] };
  assert.equal(raw.entries.length, 1);
});

test("session history shares transcripts across worktrees and retains deleted-worktree sessions via knownSessionIds", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const sessionsRoot = join(directory, "sessions");
  const memoryRoot = join(directory, "memory");
  await mkdir(sessionsRoot);

  const main = await createGitRepo(directory, "repo-main", "https://github.com/org/shared-history.git");
  const wt = await createLinkedWorktree(main, join(directory, "repo-wt"), "repo-wt");
  const unrelated = await createGitRepo(directory, "repo-other", "https://github.com/org/unrelated.git");

  const wtSession = SessionManager.create(wt, sessionsRoot);
  wtSession.appendMessage({ role: "user", content: "worktree-unique-token alpha", timestamp: 1 });
  const wtSessionId = wtSession.getSessionId();

  const otherSession = SessionManager.create(unrelated, sessionsRoot);
  otherSession.appendMessage({ role: "user", content: "worktree-unique-token foreign", timestamp: 2 });

  const mainSession = SessionManager.inMemory(main);
  const project = await resolveMemoryProject(main, { sshConfigPath: "" });
  assert.equal(project, "git:github.com/org/shared-history");

  // Active worktree session is discovered from main repo without knownSessionIds.
  const activeProvider = createMemorySourceProvider({
    project, sessionRoots: [sessionsRoot], currentSession: mainSession,
  });
  const activeResults = await activeProvider.search("worktree-unique-token");
  assert.equal(activeResults.sources.length, 1);
  assert.equal(activeResults.sources[0]?.sessionId, wtSessionId);

  // Record the worktree session in the shared project schedule, then delete the worktree directory!
  const { handle } = await resolveMemoryProjectHandle(memoryRoot, wt, { sshConfigPath: "" });
  await recordMemoryTurn(handle, { sessionId: wtSessionId, entryId: "entry-1" });
  await rm(wt, { recursive: true, force: true });
  await rm(unrelated, { recursive: true, force: true });

  // Without knownSessionIds, deleted worktree session is skipped safely.
  const withoutKnown = createMemorySourceProvider({
    project, sessionRoots: [sessionsRoot], currentSession: mainSession,
  });
  assert.equal((await withoutKnown.search("worktree-unique-token")).sources.length, 0);

  // With knownSessionIds (only wtSessionId), deleted worktree session is still found while deleted foreign repo stays excluded.
  const withKnown = createMemorySourceProvider({
    project, sessionRoots: [sessionsRoot], currentSession: mainSession,
    knownSessionIds: new Set([wtSessionId]),
  });
  const deletedResults = await withKnown.search("worktree-unique-token");
  assert.equal(deletedResults.sources.length, 1);
  assert.equal(deletedResults.sources[0]?.sessionId, wtSessionId);
});

test("dream prompt includes separate working directory when project identity is a remote URL", () => {
  const handle = createMemoryStoreHandle("/tmp/memory", "git:github.com/org/repo", "project");
  const prompt = buildMemoryDreamPrompt({
    handle,
    agentDir: "/tmp/agent",
    model: { provider: "mock", id: "m" },
    sessionRoots: ["/tmp/sessions"],
    runDirectory: "/tmp/run",
    deadline: Date.now() + 30 * 60 * 1000,
    workerCwd: "/Users/dev/worktrees/feature-a",
  }, [{ sessionId: "s1" }]);
  assert.match(prompt, /Project: "git:github\.com\/org\/repo"/);
  assert.match(prompt, /Project working directory: "\/Users\/dev\/worktrees\/feature-a"/);
});
