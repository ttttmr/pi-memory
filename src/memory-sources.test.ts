import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMemorySourceProvider } from "./memory-sources.ts";

type Entry = Record<string, unknown> & { id: string; parentId: string | null; type: string; timestamp: string };
const timestamp = "2026-01-01T00:00:00.000Z";
const message = (id: string, parentId: string | null, content: unknown, role = "user", extra = {}): Entry => ({
  type: "message", id, parentId, timestamp, message: { role, content, ...extra },
});
const edit = (id: string, parentId: string, targetId: string, replacement: unknown): Entry => ({
  type: "context_edit", id, parentId, timestamp, targetId, replacement,
});

function currentSession(cwd: string, entries: Entry[] = [], id = "current", leafId = entries.at(-1)?.id) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getCwd: () => cwd,
    getSessionId: () => id,
    getEntries: () => entries,
    getBranch: () => {
      const branch: Entry[] = [];
      let entry = leafId ? byId.get(leafId) : undefined;
      while (entry) { branch.unshift(entry); entry = entry.parentId ? byId.get(entry.parentId) : undefined; }
      return branch;
    },
  } as unknown as ExtensionContext["sessionManager"];
}

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const temporary = await mkdtemp(join(tmpdir(), "pi-memory-sources-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const sessions = join(root, "sessions");
  await mkdir(project);
  await mkdir(join(project, ".git"));
  await mkdir(sessions);
  async function native(id: string, entries: Entry[], cwd = project, directory = sessions, headerExtra = {}) {
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${id}.jsonl`);
    const text = [JSON.stringify({ type: "session", version: 3, id, cwd, timestamp, ...headerExtra }),
      ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n";
    await writeFile(path, text);
    return path;
  }
  const provider = (entries: Entry[] = [], roots = [sessions], id = "current", leafId?: string) =>
    createMemorySourceProvider({ project, sessionRoots: roots, currentSession: currentSession(project, entries, id, leafId) });
  return { root, project, sessions, native, provider };
}

test("historical evidence survives more than 70 messages and compaction in current ephemeral session", async (t) => {
  const f = await fixture(t);
  const entries = [message("old", null, "original failure feedback 回归失败")];
  for (let index = 0; index < 72; index++) entries.push(message(`m${index}`, entries.at(-1)!.id, `filler ${index}`));
  entries.push({ type: "compaction", id: "compact", parentId: entries.at(-1)!.id, timestamp,
    summary: "summary is not original evidence", firstKeptEntryId: "m70", tokensBefore: 1000 });
  const provider = f.provider(entries);
  const result = await provider.search("回归失败");
  assert.equal(result.sources[0]?.id, "current:old:0");
  assert.equal((await provider.read("current:old:0")).text, "original failure feedback 回归失败");
  assert.equal((await provider.search("summary")).sources.length, 0);
  const first = await provider.search("", { limit: 64 });
  assert.equal(first.sources.length, 64);
  assert.notEqual(first.nextOffset, null);
  const second = await provider.search("", { limit: 64, offset: first.nextOffset! });
  assert(second.sources.some((source) => source.entryId === "old"));
  await f.native("historical", entries);
  const nativeProvider = f.provider();
  assert.equal((await nativeProvider.search("回归失败")).sources[0]?.id, "historical:old:0");
  assert.equal((await nativeProvider.read("historical:old:0")).text, "original failure feedback 回归失败");
});

test("discovers same-project sessions in subdirectory roots and explicitly supplied custom directory", async (t) => {
  const f = await fixture(t);
  const subdir = join(f.project, "src");
  const custom = join(f.root, "custom");
  await mkdir(subdir);
  await f.native("older", [message("a", null, "same project old evidence")], subdir, join(f.sessions, "encoded-project"));
  await f.native("custom", [message("b", null, "custom location evidence")], f.project, custom);
  const provider = f.provider([], [f.sessions, custom]);
  assert.equal((await provider.search("evidence")).sources.length, 2);
  assert.equal((await provider.read("older:a:0")).sessionId, "older");
  const customPage = await provider.read("custom:b:0");
  assert.equal(customPage.text, "custom location evidence");
  assert.equal(customPage.sourceFile, join(custom, "custom.jsonl"));
  assert.equal(customPage.sourceLine, 2);
});

test("native headers, not directory prefixes or parentSession, determine project membership", async (t) => {
  const f = await fixture(t);
  const foreign = join(f.root, "project-other");
  const nested = join(f.project, "nested");
  await mkdir(foreign);
  await mkdir(nested);
  await mkdir(join(nested, ".git"));
  await f.native("foreign", [message("a", null, "FOREIGN_CANARY")], foreign);
  await f.native("nested", [message("b", null, "NESTED_CANARY")], nested);
  const arbitrary = await f.native("outside", [message("c", null, "PARENT_CANARY")], f.project, join(f.root, "outside"));
  await f.native("good", [message("d", null, "safe")], f.project, f.sessions, { parentSession: arbitrary });
  const provider = f.provider();
  assert.deepEqual((await provider.search("")).sources.map((source) => source.sessionId), ["good"]);
  await assert.rejects(provider.read("foreign:a:0"), /unavailable/);
  await assert.rejects(provider.read("nested:b:0"), /unavailable/);
  await assert.rejects(provider.read("outside:c:0"), /unavailable/);
});

test("context edits omit private text and mark replacements rather than presenting original body", async (t) => {
  const f = await fixture(t);
  await f.native("edited", [message("omit", null, "PRIVATE_CANARY"), message("replace", "omit", "OLD_CANARY"),
    edit("edit1", "replace", "omit", null), edit("edit2", "edit1", "replace", { content: "safe replacement" })]);
  const provider = f.provider();
  const page = await provider.search("");
  assert.equal(page.sources.length, 1);
  assert.equal(page.sources[0]?.evidence, "context-edited");
  assert(!JSON.stringify(page).includes("CANARY"));
  const result = await provider.read("edited:replace:0");
  assert.equal(result.text, "safe replacement");
  assert.equal(result.contextEdited, true);
  assert.equal(result.contextEditEntryId, "edit2");
  assert.equal(result.sourceLine, 3);
  assert.equal(result.contextEditSourceLine, 5);
  await assert.rejects(provider.read("edited:omit:0"), /unavailable/);
});

test("latest branch-relative edit wins, while abandoned native branches remain inaccessible", async (t) => {
  const f = await fixture(t);
  await f.native("branch", [message("base", null, "original"), message("abandoned", "base", "OTHER_BRANCH_CANARY"),
    edit("oldedit", "base", "base", { content: "first" }), edit("newedit", "oldedit", "base", { content: "latest" })]);
  assert.equal((await f.provider().read("branch:base:0")).text, "latest");
  await assert.rejects(f.provider().read("branch:abandoned:0"), /unavailable/);
  const entries = [message("base", null, "original"), edit("hidden", "base", "base", null)];
  assert.equal((await f.provider(entries, [], "ephemeral", "base").read("ephemeral:base:0")).text, "original");
});

test("current native file cannot bypass omissions on the live current branch", async (t) => {
  const f = await fixture(t);
  await f.native("current", [message("a", null, "DISK_CANARY")]);
  const provider = f.provider([message("a", null, "DISK_CANARY"), edit("edit", "a", "a", null)]);
  assert.equal((await provider.search("")).sources.length, 0);
  await assert.rejects(provider.read("current:a:0"), /unavailable/);
});

test("visible text allowlist never touches thinking, signatures, images, custom/system, or memory-tool results", async (t) => {
  const f = await fixture(t);
  const forbidden = { type: "thinking", get thinking() { throw new Error("thinking inspected"); },
    get thinkingSignature() { throw new Error("signature inspected"); } };
  const visible = { type: "text", text: "visible answer", get textSignature() { throw new Error("text signature inspected"); } };
  const entries = [message("a", null, [forbidden, visible, { type: "image", data: "IMAGE_CANARY" },
    { type: "toolCall", arguments: { content: "ARGUMENT_CANARY" } }], "assistant"),
  message("s", "a", "SYSTEM_CANARY", "system"), message("c", "s", "CUSTOM_CANARY", "custom"),
  message("m", "c", [{ type: "text", text: "MEMORY_CANARY" }], "toolResult", { toolName: "memory_read" }),
  message("search", "m", [{ type: "text", text: "SOURCE_SEARCH_CANARY" }], "toolResult", { toolName: "memory_source_search" }),
  message("tool", "search", [{ type: "text", text: "actual observation" }], "toolResult", { toolName: "bash" })];
  const result = await f.provider(entries).search("");
  assert.equal(result.sources.length, 2);
  assert(!JSON.stringify(result).includes("CANARY"));
  assert.equal((await f.provider(entries).read("current:a:0")).text, "visible answer");
});

test("large Unicode sources page at 8 KiB using code points and retain full visible hash", async (t) => {
  const f = await fixture(t);
  const text = "😀中文e\u0301".repeat(4000);
  await f.native("unicode", [message("a", null, text)]);
  const provider = f.provider();
  let startCharacter = 0;
  let combined = "";
  const hash = createHash("sha256").update(text).digest("hex");
  while (true) {
    const page = await provider.read("unicode:a:0", { startCharacter });
    assert(Buffer.byteLength(page.text) <= 8192);
    assert.equal(page.hash, hash);
    assert.equal(page.startCharacter, startCharacter);
    assert(!page.text.includes("\ufffd"));
    combined += page.text;
    if (page.nextCharacter === null) break;
    assert(page.nextCharacter > startCharacter);
    startCharacter = page.nextCharacter;
  }
  assert.equal(combined, text);
  await assert.rejects(provider.read("unicode:a:0", { startCharacter: [...text].length + 1 }), /offset exceeds/);
});

test("fork copies share duplicate identity rather than becoming independent evidence", async (t) => {
  const f = await fixture(t);
  const copied = message("inherited", null, "one original observation");
  await f.native("original", [copied]);
  await f.native("fork", [copied, message("new", "inherited", "new observation")]);
  const result = await f.provider().search("observation");
  assert.equal(result.sources.length, 2);
  assert.equal(new Set(result.sources.map((source) => source.duplicateKey)).size, 2);
  assert.equal((await f.provider().read("original:inherited:0")).duplicateKey,
    (await f.provider().read("fork:inherited:0")).duplicateKey);
});

test("scan budget exposes continuation, and exact reads reach sessions beyond recent search pages", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 20; index++) await f.native(`s${index.toString().padStart(2, "0")}`,
    [message("a", null, index === 0 ? "ancient feedback" : "recent filler")]);
  const provider = f.provider();
  const first = await provider.search("ancient");
  assert.equal(first.sources.length, 0);
  assert.equal(first.partial, true);
  assert.notEqual(first.nextOffset, null);
  const second = await provider.search("ancient", { offset: first.nextOffset! });
  assert.equal(second.sources[0]?.sessionId, "s00");
  assert.equal((await provider.read("s00:a:0")).text, "ancient feedback");
});

test("read-only parsing leaves native bytes and mtime unchanged, even malformed and future versions", async (t) => {
  const f = await fixture(t);
  const good = await f.native("good", [message("a", null, "safe evidence")]);
  const future = await f.native("future", [message("a", null, "FUTURE_CANARY")], f.project, f.sessions, { version: 99 });
  const malformed = await f.native("malformed", [message("a", null, "PRIVATE_CANARY")]);
  await writeFile(malformed, (await readFile(malformed, "utf8")) + "{broken privacy edit\n");
  const paths = [good, future, malformed];
  const before = await Promise.all(paths.map(async (path) => ({ text: await readFile(path), mtime: (await stat(path)).mtimeMs })));
  const result = await f.provider().search("");
  assert.deepEqual(result.sources.map((source) => source.sessionId), ["good"]);
  assert.equal(result.truncated, true);
  assert(result.warnings?.some((warning) => warning.includes("unsupported")));
  assert(result.warnings?.some((warning) => warning.includes("malformed")));
  for (let index = 0; index < paths.length; index++) {
    assert.deepEqual(await readFile(paths[index]!), before[index]!.text);
    assert.equal((await stat(paths[index]!)).mtimeMs, before[index]!.mtime);
  }
});

test("symlink files, roots, cwd aliases, traversal IDs, and deeper directory scans are refused", async (t) => {
  const f = await fixture(t);
  const external = join(f.root, "outside");
  const path = await f.native("outside", [message("a", null, "SYMLINK_CANARY")], f.project, external);
  await symlink(path, join(f.sessions, "alias.jsonl"));
  const alias = join(f.root, "sessions-alias");
  await symlink(external, alias);
  const cwdAlias = join(f.root, "project-alias");
  await symlink(f.project, cwdAlias);
  await f.native("cwdalias", [message("a", null, "CWD_CANARY")], cwdAlias);
  await f.native("deep", [message("a", null, "DEEP_CANARY")], f.project, join(f.sessions, "one", "two"));
  assert.equal((await f.provider([], [f.sessions, alias]).search("")).sources.length, 0);
  await assert.rejects(f.provider().read("../outside:a:0"), /identifier/);
  await assert.rejects(f.provider().read(`${path}:a:0`), /identifier/);
  const absent = join(f.root, "not-created");
  createMemorySourceProvider({ project: f.project, sessionRoots: [absent], currentSession: currentSession(f.project) });
  await assert.rejects(stat(absent), { code: "ENOENT" });
  assert.equal((await f.provider([], [absent]).search("")).partial, true);
  await assert.rejects(stat(absent), { code: "ENOENT" });
});

test("discovery reports refused JSONL symlinks and nonregular files without following their targets", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.sessions, "ordinary.txt"), "not a native transcript");
  await symlink(join(f.root, "missing-target"), join(f.sessions, "ordinary-link"));
  assert.equal((await f.provider().search("")).partial, false, "non-JSONL files are not refused history");
  const outside = await f.native("outside", [message("a", null, "SYMLINK_CANARY")], f.project, join(f.root, "outside"));
  await symlink(outside, join(f.sessions, "refused.jsonl"));
  await mkdir(join(f.sessions, "directory.jsonl"));
  const result = await f.provider().search("");
  assert.equal(result.sources.length, 0);
  assert.equal(result.nextOffset, null);
  assert.equal(result.partial, true);
  assert.equal(result.truncated, true);
  assert(result.warnings?.some((warning) => /symlink or not regular/.test(warning)));
});

test("bounds fail explicitly rather than exposing sources before unparsed privacy edits", async (t) => {
  const f = await fixture(t);
  const path = await f.native("huge", [message("a", null, "x".repeat(16 * 1024 * 1024))]);
  const before = (await stat(path)).mtimeMs;
  const result = await f.provider().search("");
  assert.equal(result.sources.length, 0);
  assert.equal(result.truncated, true);
  assert(result.warnings?.some((warning) => warning.includes("16 MiB")));
  assert.equal((await stat(path)).mtimeMs, before);
  await assert.rejects(f.provider().search("", { limit: 65 }), /limit/);
  await assert.rejects(f.provider().search("", { offset: -1 }), /offset/);
});

test("64 MiB body budget defers the next file without skipping its source and session filters run before bodies", async (t) => {
  const f = await fixture(t);
  const padding = "x".repeat(14 * 1024 * 1024);
  for (let index = 0; index < 5; index++) await f.native(`budget${index}`, [
    { type: "custom", id: "padding", parentId: null, timestamp, customType: "synthetic-padding", data: padding },
    message("a", "padding", `observation ${index}`),
  ]);
  const provider = f.provider();
  const first = await provider.search("");
  assert.equal(first.sources.length, 4, "four 14 MiB bodies fit, a fifth would exceed the hard byte budget");
  assert.equal(first.partial, true);
  assert.notEqual(first.nextOffset, null);
  const second = await provider.search("", { offset: first.nextOffset! });
  assert.equal(second.sources.length, 1);
  const ids = [...first.sources, ...second.sources].map((source) => source.id);
  assert.equal(new Set(ids).size, 5, "deferred file resumes at itself, not the next file");
  const target = second.sources[0].sessionId;
  const filtered = await provider.search("", { sessionId: target });
  assert.deepEqual(filtered.sources.map((source) => source.id), [second.sources[0].id]);
  assert.equal(filtered.nextOffset, null, "unmatched same-project bodies do not consume or bypass the byte budget");
});

test("aborted source searches and reads stop before discovery", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const reason = new Error("fixture cancelled");
  controller.abort(reason);
  await assert.rejects(f.provider().search("", {}, controller.signal), reason);
  await assert.rejects(f.provider().read("current:a:0", {}, controller.signal), reason);
});
