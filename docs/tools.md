# Tool reference

English | [简体中文](tools.zh-CN.md)

This page describes pi-memory's Markdown memory interfaces. Return to the [README](../README.md), or see the [design](design.md) for organization and lifecycle. `memory_search`, `memory_read`, and `memory_write` are tools called by the model, not user commands. Users only need `/memory <one thing to remember, in natural language>` to request a save. The foreground model decides how to call these tools; the command handler does not generate notes directly.

## Paths and scopes

Paths are relative to the selected memory directory, such as `MEMORY.md` or `topics/migrations.md`. The Agent organizes directory and file names; fixed topic names are not required. Only valid relative Markdown paths are allowed. Absolute paths, escaping through `..`, and access to hidden internal metadata or `.history/` are prohibited. The root index must be named exactly `MEMORY.md`. Case aliases such as `memory.md` are not allowed, and the reserved name cannot be used as a directory.

`project` is memory for the current project; `global` is cross-project memory. Project access requires Pi project trust. Global writes can be autonomous, without per-write UI confirmation. Global content should contain only genuinely cross-project, nonprivate knowledge.

Content is complete Markdown, with no required `title`, `summary`, `evidence`, or `status` fields. Not every note needs a source, version, or date. The Agent decides what to retain and how to organize it. A successful write does not verify content, and inferences must not be presented as tested facts.

## memory_search

Search active notes, or list paths when there is no query. History snapshots are not searched.

| Parameter | Required | Default and constraints |
| --- | --- | --- |
| `query` | No | At most 1000 characters; omitted queries or queries without effective search terms list paths |
| `scope` | No | `all`; one of `project`, `global`, `all` |
| `limit` | No | Default 10; integer from 1 to 30 |

```json
{
  "query": "migration tool 1.2.3",
  "scope": "project",
  "limit": 3
}
```

List paths in the current project:

```json
{
  "scope": "project",
  "limit": 30
}
```

Normally returns an array whose items contain `scope`, `path`, `hash`, `score`, and `excerpt`. If search output exceeds 50 KiB, trailing results are removed and the return shape becomes an object such as `{ "results": [], "outputTruncated": true, "hint": "..." }`, with `results` holding the retained results. Both shapes are complete JSON. Excerpts contain at most 6 lines and 600 JavaScript characters, not the full content. No matches returns an empty array. Use each result's `scope` and `path` with `memory_read` rather than guessing its scope. Queries use lexical matching of English words and adjacent bigrams of Han characters and Japanese kana, not semantic retrieval. Scores are neither confidence values nor measures of factual correctness.

Automatic recall does not use these search results. It loads only project and global `MEMORY.md`. A detailed note being searchable does not mean it automatically enters a request.

## memory_read

Read active Markdown by path. First select a line range, then paginate characters within that range, with at most 8 KiB UTF-8 of `content` per page. Reading history snapshots is outside this tool's interface.

| Parameter | Required | Default and constraints |
| --- | --- | --- |
| `path` | No | `MEMORY.md` |
| `scope` | No | `project`; one of `project`, `global` |
| `offset` | No | Start at line 1; integer of at least 1 |
| `limit` | No | Default 500; integer from 1 to 1000, selecting the line range for this read |
| `startCharacter` | No | Default 0; Unicode code-point offset within the selected line range, integer of at least 0 |

```json
{
  "path": "topics/migrations.md",
  "scope": "project",
  "offset": 1,
  "limit": 100
}
```

For an existing file, returns `path`, the text `content`, the complete file's SHA-256 `hash`, starting line `offset`, `totalLines`, character offset `startCharacter`, next character position `nextCharacter`, and `hasMore`. A missing file returns `{ "path": "requested-path", "exists": false, "hash": null }` without creating directories or empty files. Even for partial reads, `hash` covers the complete file, not the excerpt. `hasMore` is true when character pages or later lines remain. Read the complete file before a full rewrite rather than mistaking one page for all its contents.

When `nextCharacter` is not null, retain the same `offset` and `limit` and continue the selected line range with `startCharacter: nextCharacter`. Positions count Unicode code points, not UTF-8 bytes or JavaScript UTF-16 indexes. Only after `nextCharacter` becomes null should you add the current `limit` to `offset`, reset `startCharacter` to 0, and continue with the next line range. This lets you read a very long single line without skipping unreturned content.

For example, if the call above uses `offset` 1 and `limit` 100 and returns `nextCharacter` 8000, the next call should be:

```json
{
  "path": "topics/migrations.md",
  "scope": "project",
  "offset": 1,
  "limit": 100,
  "startCharacter": 8000
}
```

8000 is only an example. Use the returned `nextCharacter` rather than calculating it from the page size.

Read the global index:

```json
{
  "scope": "global"
}
```

## memory_write

Create, fully rewrite, or archive Markdown, maintained autonomously by the Agent.

| Parameter | Required | Default and constraints |
| --- | --- | --- |
| `action` | No | `upsert`; one of `upsert`, `archive` |
| `path` | Yes | Valid relative Markdown path, at most 240 characters |
| `scope` | No | `project`; one of `project`, `global` |
| `content` | For `upsert` | Complete new content, not a diff patch |
| `expectedHash` | Yes | `null` for creation; the complete current file's SHA-256 for modification or archiving |

Ordinary notes are limited to 64 KiB each; `MEMORY.md` to 8 KiB and 200 lines. Active Markdown in each scope is limited to 500 files and 8 MiB total. Old content is saved before rewriting or archiving, with at most 1000 history snapshots. When full, writes requiring a new snapshot are rejected; old evidence is not deleted automatically.

### Create

The tools, versions, and results below are synthetic examples, not claims about actual tool behavior:

```json
{
  "path": "topics/migrations.md",
  "expectedHash": null,
  "content": "# Example migration tool\n\nApplies to: example-cli 1.2.3.\nObservation: synthetic result rejects --example with exit code 1.\nSource: fixture-session:fixture-entry:0.\n\nUnverified hypothesis: a newer version may use a configuration file. Retry after upgrading.\n"
}
```

The target must not exist. If a file already exists, read and compare it first; `null` is not permission to overwrite it. Creating a note does not automatically update the index. Maintain `MEMORY.md` separately.

### Rewrite

First use `memory_read` to obtain the complete current content and `hash`, compare, and then submit complete new content:

```json
{
  "action": "upsert",
  "path": "topics/migrations.md",
  "expectedHash": "<complete SHA-256 just read>",
  "content": "# Example migration tool\n\nComplete new note, including sources, conditions, and uncertainty that should be retained.\n"
}
```

The angle-bracketed value is a placeholder. Actual calls must replace it with the tool's returned 64-character hexadecimal hash. On success, old content enters hidden history and the active path holds the new content. If the new content is identical to the existing content, no snapshot is added. Use the same process for `MEMORY.md`; its hash cannot be omitted.

### Archive

```json
{
  "action": "archive",
  "path": "topics/migrations.md",
  "expectedHash": "<complete SHA-256 just read>"
}
```

Archiving saves the current content to history and removes the active file. Do not pass `content`. `MEMORY.md` cannot be archived. Index links do not change automatically; the Agent needs to maintain them accordingly.

Archiving is not permanent deletion. It does not remove old sessions, backups, or provider copies, and is not secure erasure. This tool has no action to clear history.

### Handle conflicts

An `expectedHash` mismatch rejects the write. Reread, compare changes, then merge or abandon the change. Do not replay old content with only the hash replaced by the latest value; this can still overwrite someone else's valid updates.

Hashes protect concurrent modification of individual files, not transactions across files. If a note is updated before its index, failure of the index update does not roll back the note update.

Successful writes return only `scope`, `action`, `path`, `hash`, and a `sourceHint`, not note content. The hash in an archive receipt belongs to the file just archived and does not mean it remains active. `sourceHint` only suggests a location in the current session; it is not evidence for the actual conclusion.

## One example of turning experience into reuse

This is one possible usage pattern, not a fixed sequence that the foreground model must follow.

1. Obtain feedback from real work and decide what is worth retaining across sessions.
2. Search or read relevant notes first to avoid duplicates.
3. Write complete Markdown with conclusions, conditions, sources, and explicitly labeled hypotheses.
4. Update short navigation in `MEMORY.md` as needed instead of copying the entire note.
5. In a later request, find content through the index and decide whether to use it based on current conditions and sources.
6. Rewrite or archive when new feedback arrives. Dreaming can continue maintenance but does not replace testing.

This does not require manual approval at each step. The Agent may call writing tools autonomously, including for global memory. Authorization in historical notes cannot expand the actions allowed for the current task.

## Internal dreaming source tools

The foreground model still has only the three memory tools above. Independent background dreaming also has `memory_source_search` and `memory_source` for read-only access to same-project Pi native history and the current runtime session. They are not general file, shell, or network tools. They do not accept model-specified file paths, rewrite sessions, or create a separate session-copy index.

### memory_source_search

| Parameter | Required | Default and constraints |
| --- | --- | --- |
| `query` | No | At most 4096 characters; omitted queries list available source previews |
| `sessionId` | No | Restricts results to a session in the same project; at most 240 characters, using only letters, digits, underscores, hyphens, and dots; directories and paths are not accepted |
| `offset` | No | Default 0; nonnegative safe integer; use the previous page's scan cursor rather than incrementing it yourself |
| `limit` | No | Default 10; integer from 1 to 20 |

```json
{
  "query": "fixture cache",
  "limit": 10
}
```

The returned object contains `sources` and `nextOffset`, and may also contain `partial`, `truncated`, and `warnings`. Each source includes `id`, `sessionId`, `entryId`, `role`, `timestamp`, `hash`, `contextEdited`, `evidence`, `duplicateKey`, and a short `preview`. Native history files also provide `sourceFile` and a 1-based `sourceLine`. Replacement text has `contextEditEntryId` and, when from a native file, `contextEditSourceLine` to distinguish the message location from the actual edit location. Current runtime sources may lack a file position, and these fields are not entry points for arbitrary path reads. Previews are only lookup clues. Read the text with `memory_source` before using it to state facts. Queries use case-insensitive word/term containment, not semantic retrieval.

`offset` is a scan position, not a count of returned results. Each call checks at most 16 candidate sessions and has a 64 MiB native-file body-read budget, including rejected corrupt bodies. It may return empty `sources` with a non-null `nextOffset`. Keep the query and session filter unchanged and continue with that returned value. Do not treat an empty page or `partial: true` as a complete history scan. When search results exceed 50 KiB, the background runner retries from the same cursor with fewer results, preserving complete JSON and the correct continuation cursor. The actual result count can therefore be below the requested `limit`; if a single result still exceeds the cap, it raises an error. Directory-discovery, file-size, and format limits are explicitly reported in warnings. Scans are not frozen snapshots; sessions added or updated during scanning can change positions.

### memory_source

| Parameter | Required | Default and constraints |
| --- | --- | --- |
| `id` | Yes | At most 500 characters, in the form `sessionId:entryId:0`; the first two parts are each limited to 240 characters, using only letters, digits, underscores, hyphens, and dots |
| `startCharacter` | No | Default 0; nonnegative safe integer, a Unicode code-point offset in the complete visible text |

```json
{
  "id": "fixture-session:entry-a:0"
}
```

Exact ID reads do not require the source to appear on the previous search page. Returns source metadata plus `text`, `startCharacter`, and `nextCharacter`. Each page's `text` is at most 8 KiB UTF-8. The `hash` covers the complete visible text, not the page. When `nextCharacter` is non-null, keep the ID unchanged and use that value for the next `startCharacter` until null is returned. Do not calculate positions from UTF-8 byte counts or JavaScript UTF-16 indexes.

### Read scope and evidentiary meaning

The session header's actual `cwd` must belong to the current canonical project identity. The current session uses its actual active branch; historical files use the final record's parent-chain branch. Other branches are not read by default. Messages still retained from before compaction are accessible. Messages deleted by `context_edit` are not returned. Replacements return only the replacement text, marked with `contextEdited: true` and `evidence: "context-edited"`. Hashes always cover the complete visible text containing the returned range. Edited content cannot be used to claim verification of the original feedback.

Sources contain only user, assistant, and ordinary tool-result text, excluding this extension's own memory-tool results. Thinking, signatures, images, custom messages, system prompts, and tool-call arguments are not returned. Identical entries copied into forks share a `duplicateKey` and are deduplicated within a search page, but their reappearance across pages still cannot count as independent evidence. User statements, assistant judgments, and tool observations must not be treated as the same kind of proof either.

Native files are read-only and must use Pi v3 session format. Headers are limited to 16 KiB, and each session to 16 MiB and 100000 records. Discovery is limited to 512 directories, 20000 entries per directory, and 20000 native session files in total, scanning only host session roots and one subdirectory level. Corrupt, oversized, or unsafe files are rejected and reported. If a source is unavailable, retain an unverified qualification rather than bypassing project, branch, or edit boundaries.

Background memory tools allow only `project`. They cannot read or write global memory or execute tests. See the [design](design.md#bounded-independent-dreaming) for calls, costs, budgets, and cancellation behavior.

## Output and errors

The three foreground tools return JSON as text and do not declare an `outputSchema`. Do not assume the host has parsed it into structured objects. The extension keeps results as complete JSON with a 50 KiB output limit. It neither appends truncation text after JSON nor truncates at 2000 lines. Oversized search arrays use the wrapper object described above. Other oversized results raise an error and require a smaller request. Longer content uses the `offset`, `limit`, `startCharacter`, and `nextCharacter` pagination protocol. Write receipts do not include note content.

Invalid paths, identity mismatches, insufficient permissions, hash conflicts, lock conflicts, capacity limits, and write failures must be handled as errors, not automatically overwritten as an empty store. `exists: false` for a missing file only means that path does not exist, not that all other notes in the scope are absent. See [README troubleshooting](../README.md#troubleshooting) for recovery and diagnosis.
