import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createMemoryTestDirectory, memoryTestContent } from "../test/memory-fixtures.ts";
import { describeMemoryAccess, readMemoryAccess, recordMemoryNoteRead } from "./memory-access.ts";
import { createMemoryStoreHandle, listMemoryNotes, mutateMemoryAccessData, writeMemoryNote } from "./memory-store.ts";

async function store(ctx: Parameters<typeof createMemoryTestDirectory>[0]) {
  const directory = await createMemoryTestDirectory(ctx);
  const handle = createMemoryStoreHandle(join(directory, "memory"), join(directory, "project"), "project");
  return { directory, handle };
}

test("reads accumulate per path with first and last timestamps, outside Markdown listing", async (ctx) => {
  const { handle } = await store(ctx);
  await writeMemoryNote(handle, { path: "notes/a.md", content: memoryTestContent, expectedHash: null });
  assert.equal(await recordMemoryNoteRead(handle, "notes/a.md", new Date("2026-11-01T00:00:00Z")), true);
  assert.equal(await recordMemoryNoteRead(handle, "notes/a.md", new Date("2026-11-03T00:00:00Z")), true);
  const access = await readMemoryAccess(handle);
  assert.equal(access?.since, "2026-11-01T00:00:00.000Z");
  assert.deepEqual(access?.notes, [{ path: "notes/a.md", reads: 2,
    firstReadAt: "2026-11-01T00:00:00.000Z", lastReadAt: "2026-11-03T00:00:00.000Z" }]);
  assert.deepEqual((await listMemoryNotes(handle)).map((note) => note.path), ["notes/a.md"]);
});

test("statistics never create a missing store", async (ctx) => {
  const { directory, handle } = await store(ctx);
  assert.equal(await recordMemoryNoteRead(handle, "notes/a.md"), false);
  assert.deepEqual(await readdir(directory), []);
  assert.equal(await readMemoryAccess(handle), null);
});

test("a held statistics lock skips the update without stealing it or blocking note writes", async (ctx) => {
  const { handle } = await store(ctx);
  await writeMemoryNote(handle, { path: "notes/a.md", content: memoryTestContent, expectedHash: null });
  await mkdir(`${handle.directory}.access.lock`);
  assert.equal(await recordMemoryNoteRead(handle, "notes/a.md"), false);
  assert.equal(await readMemoryAccess(handle), null);
  await writeMemoryNote(handle, { path: "notes/b.md", content: memoryTestContent, expectedHash: null });
  assert.deepEqual(await readdir(handle.directory + ".access.lock"), []);
});

test("corrupt statistics are reported, not reset", async (ctx) => {
  const { handle } = await store(ctx);
  await writeMemoryNote(handle, { path: "notes/a.md", content: memoryTestContent, expectedHash: null });
  await writeFile(join(handle.directory, ".access.json"), JSON.stringify({ version: 1, since: "x", notes: [] }));
  await assert.rejects(recordMemoryNoteRead(handle, "notes/a.md"), /corrupt/);
  assert.match(await describeMemoryAccess(handle, "Project memory"), /access statistics unavailable/);
});

test("prompt summary lists every active note, including notes never read", async (ctx) => {
  const { handle } = await store(ctx);
  await writeMemoryNote(handle, { path: "MEMORY.md", content: "# Index\n", expectedHash: null });
  await writeMemoryNote(handle, { path: "notes/a.md", content: memoryTestContent, expectedHash: null });
  await recordMemoryNoteRead(handle, "notes/a.md", new Date("2026-11-02T00:00:00Z"));
  const summary = await describeMemoryAccess(handle, "Project memory");
  assert.match(summary, /^Project memory \(foreground memory_read calls since 2026-11-02;/);
  assert.match(summary, /- MEMORY\.md: no recorded reads/);
  assert.match(summary, /- notes\/a\.md: 1 read\(s\), last 2026-11-02/);
});

test("access statistics cap at 2000 entries by oldest lastReadAt and reject non-ISO or inverted timestamps", async (ctx) => {
  const { handle } = await store(ctx);
  await writeMemoryNote(handle, { path: "notes/a.md", content: memoryTestContent, expectedHash: null });
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  const initialNotes = Array.from({ length: 2000 }, (_, index) => {
    const stamp = new Date(baseMs + (index + 1) * 1000).toISOString();
    return { path: `notes/n${String(index).padStart(4, "0")}.md`, reads: 1, firstReadAt: stamp, lastReadAt: stamp };
  });
  await mutateMemoryAccessData(handle, () => ({
    data: { version: 1, since: "2026-01-01T00:00:00.000Z", notes: initialNotes },
    result: undefined,
  }));
  await recordMemoryNoteRead(handle, "notes/new.md", new Date(baseMs + 3000 * 1000));
  const after = await readMemoryAccess(handle);
  assert.equal(after?.notes.length, 2000);
  assert.equal(after?.notes.some((note) => note.path === "notes/n0000.md"), false, "Oldest entry evicted");
  assert.equal(after?.notes.some((note) => note.path === "notes/new.md"), true);

  await mutateMemoryAccessData(handle, () => ({
    data: {
      version: 1,
      since: "2026-01-01T00:00:00.000Z",
      notes: [{ path: "notes/a.md", reads: 1, firstReadAt: "2026-01-02T00:00:00.000Z", lastReadAt: "2026-01-01T00:00:00.000Z" }],
    },
    result: undefined,
  }));
  await assert.rejects(readMemoryAccess(handle), /corrupt/);
});
