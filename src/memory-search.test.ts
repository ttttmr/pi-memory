import assert from "node:assert/strict";
import test from "node:test";
import { buildMemoryRecall, searchMemoryNotes } from "./memory-search.ts";
import type { MemoryDocument } from "./memory-store.ts";

const document = (path: string, content: string): MemoryDocument => ({ path, content, hash: "a".repeat(64) });

test("Markdown search ranks paths and bodies, supports CJK and never invents verification", () => {
  const notes = [
    { scope: "project" as const, document: document("topics/Pi-extension.md", "# Extension APIs\nTested against fixture 1.5.0") },
    { scope: "global" as const, document: document("notes/build.md", "# Hypothesis\nPi extension might need rebuilding, untested") },
    { scope: "project" as const, document: document("中文.md", "# 上下文管理\n观察：压缩后重新读取索引。") },
  ];
  const hits = searchMemoryNotes(notes, "Pi extension");
  assert.equal(hits.length, 2);
  assert.equal(hits[0].document.path, "topics/Pi-extension.md");
  assert.equal(hits[1].scope, "global");
  assert.match(hits[1].excerpt, /untested/);
  assert.equal(searchMemoryNotes(notes, "上下文")[0].document.path, "中文.md");
  assert.equal(searchMemoryNotes(notes, "completely unrelated").length, 0);
  assert.equal(searchMemoryNotes(notes, "", 1).length, 1);
  assert.equal(searchMemoryNotes(notes, "").length, 3);
});

test("index injection contains only explicit MEMORY.md maps, not all note contents", () => {
  assert.equal(buildMemoryRecall([{ scope: "project", document: null }]), "");
  assert.equal(buildMemoryRecall([{ scope: "global", document: document("MEMORY.md", "  ") }]), "");
  const recall = buildMemoryRecall([
    { scope: "project", document: document("MEMORY.md", "# Project map\n- [Tests](topics/tests.md): observed fixture behavior") },
    { scope: "global", document: document("MEMORY.md", "# Global map\n- [Writing](writing.md)") },
  ]);
  assert.match(recall, /project-memory-index/);
  assert.match(recall, /global-memory-index/);
  assert.match(recall, /historical reference/);
  assert.match(recall, /memory_search/);
  assert.match(recall, /Check sources, dates, and applicability/);
});
