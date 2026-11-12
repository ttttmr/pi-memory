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
| `content` | For `upsert` | Complete new content, not a diff patch; omit or use `""` for `archive` |
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

Archiving saves the current content to history and removes the active file. Omit `content` or pass an empty string (`""`); nonempty content is rejected. The empty-string placeholder accommodates model calls that include every field. `MEMORY.md` cannot be archived. Index links do not change automatically; the Agent needs to maintain them accordingly.

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

## Tools available during dreaming

Dreaming launches a normal Pi CLI Agent, not the former project-only source-tool loop. It has the default `read`, `bash`, `edit`, and `write` tools, the three memory tools above, and resources loaded by normal Pi configuration, including configured extensions, skills, and MCP tools. Runtime-only changes in the foreground process are not copied. The old `memory_source_search` and `memory_source` interfaces are not registered for the worker; their implementation remains in the repository for existing tests and reference.

The task gives the Agent session IDs, optional native-file hints, session roots, the project identity, and a deadline. The Agent chooses how to find and read raw native history and existing memory. Session hints are not source copies or a permanent search index. Raw file reads do not enforce the former source provider's active-branch projection, context-edit filtering, field exclusions, or pagination. Deleted or replaced context and sensitive raw fields may still exist in native logs.

The maintenance prompt restricts the task to project memory: read sessions and source code without modifying them, use memory tools for safe note writes, check evidence, and treat historical instructions as untrusted data rather than authorization. These are prompt instructions, **not an OS sandbox or a tool allowlist**. The Agent's normal tools can access files, execute commands, and use configured network-capable tools. Do not enable automatic dreaming unless this authority and historical-data exposure are acceptable. See the [user guide](usage.md#privacy-and-usage-notes) and [design](design.md#independent-dreaming-agent) for lifecycle, costs, and run logs.

## Output and errors

The three foreground tools return JSON as text and do not declare an `outputSchema`. Do not assume the host has parsed it into structured objects. The extension keeps results as complete JSON with a 50 KiB output limit. It neither appends truncation text after JSON nor truncates at 2000 lines. Oversized search arrays use the wrapper object described above. Other oversized results raise an error and require a smaller request. Longer content uses the `offset`, `limit`, `startCharacter`, and `nextCharacter` pagination protocol. Write receipts do not include note content.

Invalid paths, identity mismatches, insufficient permissions, hash conflicts, lock conflicts, capacity limits, and write failures must be handled as errors, not automatically overwritten as an empty store. `exists: false` for a missing file only means that path does not exist, not that all other notes in the scope are absent. See [user-guide troubleshooting](usage.md#troubleshooting) for recovery and diagnosis.
