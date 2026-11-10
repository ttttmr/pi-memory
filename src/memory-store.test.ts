import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { createMemoryTestDirectory, memoryTestContent } from "../test/memory-fixtures.ts";
import {
  archiveMemoryNote, createMemoryStoreHandle, listMemoryNotes, readMemoryIndex, readMemoryNote,
  resolveMemoryProject, writeMemoryNote, type MemoryStoreHandle,
} from "./memory-store.ts";

async function createFixtureNote(handle: MemoryStoreHandle, path = "topics/api.md", content = memoryTestContent) {
  return writeMemoryNote(handle, { path, content, expectedHash: null });
}

test("missing Markdown reads do not create directories; Unicode and exact hashes survive handles", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const root = join(directory, "memory");
  const handle = createMemoryStoreHandle(root, "/project/甲", "project");
  assert.equal(handle.path, handle.directory);
  assert.equal(await readMemoryIndex(handle), null);
  assert.equal(await readMemoryNote(handle, "missing.md"), null);
  assert.deepEqual(await listMemoryNotes(handle), []);
  assert.deepEqual(await readdir(directory), []);
  const content = "\uFEFF# 中文记忆 😀\r\n\n";
  const note = await createFixtureNote(handle, "topics/甲.md", content);
  assert.equal(note.hash, createHash("sha256").update(content).digest("hex"));
  const restored = await readMemoryNote(createMemoryStoreHandle(root, "/project/甲", "project"), note.path);
  assert.deepEqual(restored, note);
  assert.equal((await stat(join(handle.directory, note.path))).mode & 0o777, 0o600);
  assert.equal((await stat(handle.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
});

test("project location follows nearest Git marker without reading it or invoking Git", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const nested = join(directory, "repo", "src", "nested");
  await mkdir(nested, { recursive: true });
  assert.equal(await resolveMemoryProject(nested), nested);
  await writeFile(join(directory, "repo", ".git"), "gitdir: /unread/dependency\n");
  assert.equal(await resolveMemoryProject(nested), join(directory, "repo"));
  await mkdir(join(directory, "repo", "src", ".git"));
  assert.equal(await resolveMemoryProject(nested), join(directory, "repo", "src"));
  await symlink(nested, join(directory, "alias"));
  assert.equal(await resolveMemoryProject(join(directory, "alias")), join(directory, "repo", "src"));
});

test("project and global directories live directly under the root and remain separate", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const first = createMemoryStoreHandle(root, "/first", "project");
  const second = createMemoryStoreHandle(root, "/second", "project");
  const global = createMemoryStoreHandle(root, "/first", "global");
  assert.equal(global.directory, createMemoryStoreHandle(root, "/second", "global").directory);
  assert.equal(first.directory, join(root, `project-${createHash("sha256").update("/first").digest("hex")}`));
  assert.equal(global.directory, join(root, "global"));
  await createFixtureNote(first);
  assert.deepEqual(await listMemoryNotes(second), []);
  assert.deepEqual(await listMemoryNotes(global), []);
  await createFixtureNote(global, "global.md", "Shared fixture");
  assert.equal((await listMemoryNotes(first)).length, 1);
  assert.deepEqual((await readdir(root)).sort(), [first.directory.split("/").at(-1)!, "global"].sort());
  assert.deepEqual(JSON.parse(await readFile(join(first.directory, ".identity.json"), "utf8")), { identity: "/first", scope: "project" });
});

test("identity corruption, mismatches and unexpected fields fail closed without resetting notes", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/first", "project");
  await createFixtureNote(handle);
  const identityPath = join(handle.directory, ".identity.json");
  for (const identity of ["{invalid", JSON.stringify({ identity: "/other", scope: "project" }),
    JSON.stringify({ identity: handle.identity, scope: "global" }),
    JSON.stringify({ identity: handle.identity, scope: "project", unexpected: true })]) {
    await writeFile(identityPath, identity);
    await assert.rejects(readMemoryIndex(handle), /identity/);
    await assert.rejects(createFixtureNote(handle, "new.md"), /identity/);
    assert.equal(await readFile(identityPath, "utf8"), identity);
    assert.equal(await readFile(join(handle.directory, "topics/api.md"), "utf8"), memoryTestContent);
  }
  const missingIdentity = createMemoryStoreHandle(root, "/missing-identity", "project");
  await mkdir(missingIdentity.directory);
  await writeFile(join(missingIdentity.directory, "manual.md"), "Do not reset");
  await assert.rejects(createFixtureNote(missingIdentity), /identity/);
});

test("create-only and stale hash writes conflict; replaced and archived bytes remain in hidden history", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/project", "project");
  const original = await createFixtureNote(handle);
  await assert.rejects(createFixtureNote(handle), /hash conflict/);
  await assert.rejects(writeMemoryNote(handle, { ...original, content: "stale", expectedHash: "0".repeat(64) }), /hash conflict/);
  const updated = await writeMemoryNote(handle, { path: original.path, content: "New knowledge\n", expectedHash: original.hash });
  const historyDirectory = join(handle.directory, ".history", original.path);
  const history = await readdir(historyDirectory);
  assert.equal(history.length, 1);
  assert.equal(await readFile(join(historyDirectory, history[0]), "utf8"), original.content);
  assert.equal((await stat(join(historyDirectory, history[0]))).mode & 0o777, 0o600);
  // Identical writes are idempotent and do not waste history capacity.
  assert.deepEqual(await writeMemoryNote(handle, { ...updated, expectedHash: updated.hash }), updated);
  assert.equal((await readdir(historyDirectory)).length, 1);
  await assert.rejects(archiveMemoryNote(handle, updated.path, original.hash), /hash conflict/);
  assert.deepEqual(await archiveMemoryNote(handle, updated.path, updated.hash), updated);
  assert.equal(await readMemoryNote(handle, updated.path), null);
  assert.deepEqual(await listMemoryNotes(handle), []);
  const snapshots = await Promise.all((await readdir(historyDirectory)).map((name) => readFile(join(historyDirectory, name), "utf8")));
  assert.deepEqual(snapshots.sort(), [original.content, updated.content].sort());
  await assert.rejects(archiveMemoryNote(handle, "MEMORY.md", updated.hash), /cannot be archived/);
});

test("recursive active listing excludes dot directories and non-Markdown files and has stable order", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/project", "project");
  await createFixtureNote(handle, "z.md");
  await createFixtureNote(handle, "notes/a.md");
  await createFixtureNote(handle, "MEMORY.md", "# Index\n- [API](notes/a.md)\n");
  await mkdir(join(handle.directory, ".private"));
  await writeFile(join(handle.directory, ".private", "secret.md"), "Excluded fixture");
  await writeFile(join(handle.directory, "unrelated.json"), "{}");
  assert.deepEqual((await listMemoryNotes(handle)).map((note) => note.path), ["MEMORY.md", "notes/a.md", "z.md"]);
  assert.equal((await readMemoryIndex(handle))?.path, "MEMORY.md");
});

test("path traversal and malformed runtime inputs fail before creating storage", async (ctx) => {
  const root = join(await createMemoryTestDirectory(ctx), "memory");
  const handle = createMemoryStoreHandle(root, "/project", "project");
  for (const path of ["", "/tmp/a.md", "../a.md", "a/../b.md", "a/./b.md", ".private/a.md", "a//b.md", "a\\b.md", "C:/a.md", "a\0.md", "a.txt", "a.md/"]) {
    await assert.rejects(readMemoryNote(handle, path), /Memory path/);
    await assert.rejects(createFixtureNote(handle, path), /Memory path/);
  }
  await assert.rejects(writeMemoryNote(handle, { path: "a.md", content: 42, expectedHash: null } as never), /content/);
  await assert.rejects(writeMemoryNote(handle, { path: "a.md", content: "\uD800", expectedHash: null }), /Unicode/);
  await assert.rejects(writeMemoryNote(handle, { path: "a.md", content: "ok", expectedHash: undefined } as never), /expectedHash/);
  await assert.rejects(readMemoryIndex({ ...handle, path: join(root, "other") }), /handle/);
  await assert.rejects(stat(root), { code: "ENOENT" });
});

test("symlinked root, store, identity, topical ancestors and files are refused", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const outside = join(root, "outside");
  await mkdir(outside);
  const handle = createMemoryStoreHandle(root, "/project", "project");
  await createFixtureNote(handle);
  await symlink(outside, join(handle.directory, "linked"));
  await assert.rejects(readMemoryNote(handle, "linked/note.md"), /unsafe directory/);
  await assert.rejects(createFixtureNote(handle, "linked/note.md"), /symbolic link|unsafe directory/);
  await symlink(join(handle.directory, "topics/api.md"), join(handle.directory, "linked.md"));
  await assert.rejects(readMemoryNote(handle, "linked.md"));
  await assert.rejects(listMemoryNotes(handle), /symbolic link/);
  const other = createMemoryStoreHandle(root, "/other", "project");
  await symlink(outside, other.directory);
  await assert.rejects(readMemoryIndex(other), /unsafe/);
  await assert.rejects(createFixtureNote(other), /unsafe/);
  const identity = createMemoryStoreHandle(root, "/identity", "project");
  await mkdir(identity.directory);
  await symlink(join(handle.directory, ".identity.json"), join(identity.directory, ".identity.json"));
  await assert.rejects(readMemoryIndex(identity), /identity/);
  const linkedRoot = join(root, "linked-root");
  await symlink(root, linkedRoot);
  await assert.rejects(createFixtureNote(createMemoryStoreHandle(linkedRoot, "/first", "project")), /unsafe/);
  assert.deepEqual(await readdir(outside), []);
});

test("note and index limits count UTF-8 bytes and enforce 200 index lines", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/project", "project");
  await assert.rejects(createFixtureNote(handle, "large.md", "中".repeat(22000)), /64 KiB/);
  const note = await createFixtureNote(handle, "boundary.md", "a".repeat(65536));
  assert.equal(note.content.length, 65536);
  await assert.rejects(createFixtureNote(handle, "MEMORY.md", "a".repeat(8193)), /8 KiB/);
  await assert.rejects(createFixtureNote(handle, "MEMORY.md", "line\n".repeat(201)), /200 lines/);
  const index = await createFixtureNote(handle, "MEMORY.md", "line\n".repeat(200));
  assert.equal((await readMemoryIndex(handle))?.hash, index.hash);
  await writeFile(join(handle.directory, "oversized.md"), "a".repeat(65537));
  await assert.rejects(readMemoryNote(handle, "oversized.md"), /limit/);
});

test("canonical index name rejects case aliases and directory shadowing before they bypass index limits", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/project", "project");
  for (const path of ["memory.md", "Memory.md", "MEMORY.md/topic.md", "memory.md/topic.md"]) {
    await assert.rejects(createFixtureNote(handle, path, "x".repeat(9000)), /exactly MEMORY.md/);
  }
  const index = await createFixtureNote(handle, "MEMORY.md", "# Small index");
  await assert.rejects(writeMemoryNote(handle, { path: "memory.md", content: "x".repeat(9000), expectedHash: index.hash }), /exactly MEMORY.md/);
  assert.equal((await readMemoryIndex(handle))?.hash, index.hash);
});

test("500-file and 8 MiB library capacity refuse new writes without altering existing content", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const countHandle = createMemoryStoreHandle(root, "/count", "project");
  await createFixtureNote(countHandle, "first.md", "first");
  await Promise.all(Array.from({ length: 499 }, (_, index) => writeFile(join(countHandle.directory, `note-${index}.md`), "fixture", { mode: 0o600 })));
  await assert.rejects(createFixtureNote(countHandle, "overflow.md"), /500 Markdown/);
  assert.equal((await listMemoryNotes(countHandle)).length, 500);
  const sizeHandle = createMemoryStoreHandle(root, "/size", "project");
  const full = "x".repeat(65536);
  await createFixtureNote(sizeHandle, "first.md", full);
  await Promise.all(Array.from({ length: 127 }, (_, index) => writeFile(join(sizeHandle.directory, `note-${index}.md`), full)));
  await assert.rejects(createFixtureNote(sizeHandle, "overflow.md", "x"), /8 MiB/);
  assert.equal(await readFile(join(sizeHandle.directory, "first.md"), "utf8"), full);
});

test("history capacity never silently deletes snapshots or unlinks the active note", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/project", "project");
  const note = await createFixtureNote(handle);
  const history = join(handle.directory, ".history");
  await mkdir(history);
  await Promise.all(Array.from({ length: 1000 }, (_, index) => writeFile(join(history, `old-${index}.md`), "old fixture")));
  await assert.rejects(writeMemoryNote(handle, { ...note, content: "updated", expectedHash: note.hash }), /history capacity/);
  await assert.rejects(archiveMemoryNote(handle, note.path, note.hash), /history capacity/);
  assert.equal((await readdir(history)).length, 1000);
  assert.deepEqual(await readMemoryNote(handle, note.path), note);
});

test("pre-aborted writes preserve content and leave no lock or temporary file", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/project", "project");
  const note = await createFixtureNote(handle);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(writeMemoryNote(handle, { ...note, content: "changed", expectedHash: note.hash }, controller.signal), { name: "AbortError" });
  await assert.rejects(archiveMemoryNote(handle, note.path, note.hash, controller.signal), { name: "AbortError" });
  assert.deepEqual(await readMemoryNote(handle, note.path), note);
  assert.equal((await readdir(dirname(handle.directory))).some((name) => name.endsWith(".lock")), false);
  assert.equal((await readdir(join(handle.directory, "topics"))).some((name) => name.endsWith(".tmp")), false);
});

test("concurrent same-process writers cannot overwrite each other", async (ctx) => {
  const handle = createMemoryStoreHandle(await createMemoryTestDirectory(ctx), "/project", "project");
  const note = await createFixtureNote(handle);
  const results = await Promise.allSettled(["first", "second"].map((content) => writeMemoryNote(handle, { path: note.path, content, expectedHash: note.hash })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /locked|hash conflict/);
  assert.equal((await readdir(join(handle.directory, ".history", note.path))).length, 1);
});

test("another process fails fast on a held directory lock without stealing it", async (ctx) => {
  const root = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(root, "/project", "project");
  await mkdir(dirname(handle.directory), { recursive: true });
  await mkdir(`${handle.directory}.lock`);
  const moduleUrl = new URL("./memory-store.ts", import.meta.url).href;
  const program = `import {writeMemoryNote} from ${JSON.stringify(moduleUrl)};
    try { await writeMemoryNote(${JSON.stringify(handle)}, {path:'a.md', content:'fixture', expectedHash:null}); process.exitCode = 2; }
    catch (error) { console.log(error.message); process.exitCode = 1; }`;
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", program], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, output }));
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /Memory store locked/);
  assert.deepEqual(await readdir(`${handle.directory}.lock`), []);
  await assert.rejects(stat(handle.directory), { code: "ENOENT" });
});
