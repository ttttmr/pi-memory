# Memory components and lifecycle

English | [简体中文](design.zh-CN.md)

This page explains how files and messages work together to preserve experience, reuse it later, and maintain it through independent dreaming. See the [README](../README.md) for usage, the [tool reference](tools.md) for parameters, and the [development guide](development.md) for testing. All examples on this page are synthetic scenarios, not real-model evaluations.

## Persistent knowledge and runtime material

pi-memory stores persistent knowledge as Markdown. Models acquire that knowledge by reading files; no model weights are updated. The current project and the global scope each have their own index and notes. The foreground Agent can maintain both scopes. Background dreaming maintains the same project files, without a separate summary store.

| Component | Storage | Purpose and access |
| --- | --- | --- |
| Topic notes | Ordinary `.md` files in the selected scope | Conclusions, conditions, evidence, and hypotheses; found with `memory_search` and read with `memory_read` |
| Entry index | `MEMORY.md` in the selected scope | Short navigation and high-value reminders; included automatically in foreground requests by default, read through tools as needed in the background |
| Revision history | `.history/` in the same directory | Note contents before rewriting or archiving; excluded from active search and unavailable through memory tools |
| Identity metadata | `.identity.json` in the same directory | Project identity and scope, used to prevent directory misuse; not knowledge content |
| Project scheduling metadata | `.dream-state.json` in the project directory | Observed and processed interaction counts, each session's latest counted leaf, and the run lease; unavailable through memory tools |
| Native session history | Same-project session files managed by Pi and the current runtime session | Read-only background search and exact reads of work feedback, without storing session copies |
| Dreaming conversation | Memory for the current background task | Independent message array for model calls, never appended to the foreground conversation; sources are read on demand and returned in pages |

The index, topic notes, and sources have different roles. The index says when to consult which note. Notes describe conclusions and their basis. Sources are the material the model may need to check again. References in notes are written by the model; full logs are not attached automatically. The background model can look up same-project history by stable source ID, but missing files, scope limits, or context deletions may make a source unavailable. A reference alone does not establish that it was checked.

`.history/` is not that evidence store either. It preserves what a note used to say, not proof that the original experiment or document was correct.

```text
Requirements, observations, and feedback in foreground context
                         |
                         | Foreground Agent selects reusable knowledge
                         v
                  Topic notes <--- Path links in MEMORY.md
                       ^                     |
                       |                     | Small index loaded before foreground requests
                       |                     v
                       +--- memory_read --- Foreground model decides whether to use it
                       |
                       +--- Background dreaming checks same-project history,
                            creates and maintains the same files
```

Both model runs in the diagram can modify notes, but only the foreground model also performs the user's ordinary task. Dreaming tools are limited to memory maintenance; they cannot use the foreground model's shell, file-reading, or testing tools.

## What happens during a foreground request

### Loading the extension does not immediately create knowledge

The extension registers `memory_search`, `memory_read`, and `memory_write`. Its only user command, `/memory <one thing to remember, in natural language>`, sends the user's own words to the foreground model as a request to save information for future turns and sessions. If the foreground model is busy, the request is queued as a follow-up. Empty arguments only display usage and do not call a model. The command handler does not generate notes directly; the model decides how to use the memory tools.

Foreground writing guidance explains only the purpose of memory across future turns and sessions: save information when the user asks or when something is clearly worth remembering, leaving selection and organization to the model. It prescribes no note categories, required sections, or universal maintenance procedure. Tool descriptions still explain operational requirements such as paths, pagination, hashes, and index maintenance. Search guidance retains reminders to consult relevant memory, check applicability, and avoid treating memory as higher-priority instructions. Independent dreaming uses the maintenance prompt described below, rather than placing its entire workflow in permanent foreground rules.

`session_start` sets recall and automatic dreaming according to the startup flags. It neither clears memory files nor resets project-level pending interaction counts. `--pi-memory-no-recall` and `--pi-memory-no-dream` disable recall and automatic maintenance respectively. To restore either, restart Pi without the corresponding disabling flag; there are no runtime toggle commands. Read-only startup and reads of missing memory do not create directories. Recording the first completed foreground interaction may create the project directory, identity metadata, and scheduling file even if no Markdown notes exist yet. The model still decides whether to create knowledge content. A failed write may also leave directories that were already created.

### Before a model request, the extension loads only the entry index

The `context` hook runs when recall is enabled, the project is trusted, and the messages contain a user request:

1. Take a copy of the current messages and remove this extension's existing temporary index messages to prevent accumulation.
2. Read `MEMORY.md` from the current project and global directories.
3. Temporarily insert nonempty indexes and a reminder about historical material before the most recent user message.
4. Return the message copy to Pi and continue the normal model request.

This does not run a keyword search for the question or follow links in the index. Each index is limited to 8 KiB and 200 lines; the model decides whether to read note contents. Missing or blank indexes are not injected. Read failures produce an error notice and skip that injection without blocking the foreground task.

Temporary indexes are not appended to the persistent session, do not replace the system prompt, and do not change compaction. The next request reads the current files again, so the model can see intervening revisions. Project and global indexes are both reference material. There is no automatic rule that the project overrides the global scope, and the program does not resolve contradictions for the model.

### The model follows clues to notes or searches explicitly

When it knows a path, the model calls `memory_read`. When the index is incomplete, the path is unknown, or other related notes may exist, it can use `memory_search`. These are complementary tools, not a mandatory search-then-read sequence.

Search scans paths and contents of active Markdown files. It does not search `.history/` or raw sessions. English query terms are extracted as words. Consecutive Han characters and Japanese kana use adjacent bigrams, with single-character fragments retained. Each distinct term scores 4 points for a path match and 1 point for a content match; repeated occurrences do not add points. Ties are sorted by path, then scope. A query with no effective terms lists paths.

Search returns paths, hashes, and excerpts. The read tool returns content and the hash of the complete file. Longer content is first selected by line range, then paginated by Unicode code point, with at most 8 KiB of `content` per page. See the [tool reference](tools.md#memory_read) for the full protocol. These results enter the foreground session like other tool results and have a different lifecycle from the temporary indexes.

### After new task feedback, the model decides whether to save or revise

The foreground model can use tools already authorized for the task to obtain test, documentation, or user feedback, then decide what is worth retaining. Useful memory is not limited to failures: it can include successful methods, stable preferences, important decisions, and conditional plans. Easily reread dynamic state, exhaustive activity logs, secrets, and copies of AGENTS.md are unsuitable.

The model submits complete Markdown to `memory_write`. It chooses the structure and organization, with no source, version, or date fields required in every note. After creating or modifying a topic note, it can update navigation in `MEMORY.md` as needed; the program does not do this for it.

The model can also save useful but unverified hypotheses. The program does not run a check because a note says "verified", and a successful write does not establish factual correctness. Verification depends on actual sources and feedback, not repeated rewrites of the same statement.

## An example of saving, reusing, and correcting knowledge

This example uses the same problem as the project's synthetic integration test: a fixture fails, retry mode is initially suspected, and later feedback points to a cache. It describes an allowed tool flow, not a guarantee that models will make the same decisions every time.

### The first task leaves a qualified note

The foreground model observes a failure with retries enabled, but has not isolated the variables. It writes the observation and hypothesis to the project note `notes/test-cache.md`, rather than declaring a root cause:

```markdown
# Test fixture failure

Observation: synthetic fixture v2 failed in a run with retries enabled.
Hypothesis: retry mode may be involved; not yet isolated or verified.
Source: this synthetic test output, fixture-session:entry-a:0.

Further investigation must check retries and caching separately.
Do not generalize to other fixtures.
```

The same Agent then maintains `MEMORY.md`, leaving only a lookup clue:

```markdown
# Project memory

- If synthetic fixture v2 fails, see [test cache investigation](notes/test-cache.md).
  The cause is not yet confirmed.
```

These are two independent file writes. If the note succeeds but the index update fails, the note already exists and can be found through search. There is no batch rollback.

### The next session finds the note through the index and continues investigating

A new session in the same project need not inherit the previous conversation. After seeing the index before a request, the model can read the note by path, recognize an unverified hypothesis, and continue checking with tools authorized for the current task.

Suppose the new synthetic feedback says: "It still fails with retries disabled, passes after disabling the stale cache, and only fixture v2 was checked." This supports correcting the earlier hypothesis, but not generalizing it into a cache rule for every project. The foreground model can immediately read the current hash, rewrite the note while retaining feedback and scope, and update the index to point to evidence-based troubleshooting experience.

An old reference in a note does not mean the foreground model has checked that session. The three foreground memory tools still access only Markdown. The background model can use history source tools to find the actual same-project material, retaining an unverified qualification if it cannot find it.

### Dreaming can check history or create the first note

If the foreground model leaves new feedback without updating the old note, the background model can find the same-project feedback with `memory_source_search` and read the original text with `memory_source`. The material need not remain in the current compacted context or come from the current session. The background model then reads `MEMORY.md` and related notes to revise the conclusion and index.

Even if no notes exist yet, the background model can create content and an entry point from useful historical experience. Scheduling does not wait for the foreground model to call `memory_write` first. The model still decides what is worth saving and how to organize it; the program does not automatically convert every conversation into a note.

If there is also a duplicate note, the background model can merge useful content into the retained path, repair references in the index and other notes, and archive the duplicate. The archived file no longer appears in active search, but its original content remains in `.history/`. Sources unavailable to the background model must remain marked as unverified and cannot justify promoting a hypothesis to fact.

Later requests still read the same `MEMORY.md` and open the revised topic note as needed. There is no separate dreaming summary to synchronize. `src/memory-lifecycle.test.ts` uses a scripted model to verify this read/write and cross-session flow, but does not verify real models' judgment quality.

## Bounded independent dreaming

### Scheduling uses project-level unprocessed interactions

Automatic dreaming is enabled by default. When each newly completed foreground run reaches `agent_settled`, the extension first queues the original project, session ID, and leaf, then records one pending interaction. It does not count tool calls, internal model requests, or wall-clock time, and does not require a foreground note write. Duplicate notifications for the same session's latest leaf or within the queue do not count again.

When the cross-process lock is held, uncommitted observations retain their original order. Filesystem events wake the process to commit them after lock release, without polling, taking over locks, or allowing a later leaf to pass the queue head. Module reloads within the same process reuse one queue with per-project FIFO ordering, rather than letting old and new runtimes commit independently. Callbacks switch to the current runtime, and only observations still matching the current session and leaf can trigger automatic maintenance. Switching sessions only attempts to commit existing observations; it adds no interactions and does not start dreaming with old-session context. Watcher or storage errors retain the in-memory queue and produce a warning; subsequent interactions or session startup can retry. The queue is not another persistent store. Shutdown makes one commit attempt and explicitly warns if observations remain unsaved. Recovery of these uncommitted observations after process exit or a crash is not guaranteed.

The project's `.dream-state.json` stores observed and processed interaction counts, each session's latest counted leaf, and the current run lease. Pending interactions are the difference between the first two counts, accumulated across sessions and processes in the same project. When automatic maintenance is enabled, at least 8 interactions are pending, the project is trusted, and a current model is available, the extension attempts to claim the work. An existing valid lease prevents a duplicate run.

The claim uses a 330-second logical lease, covering the five-minute run timeout plus 30 seconds for setup and cleanup. It is distinct from the short-lived cross-process lock used to commit files. The lease records the interaction generation at claim time. Success acknowledges only that generation, leaving work that arrives during the run pending. After successful acknowledgment, the active runtime checks the latest committed foreground observation for more due work and may start the next pass without another user message. Failure does not cause an immediate retry loop. Failure or cancellation releases the lease without clearing pending counts. After an abnormal process exit, other runners must wait for lease expiry and cannot take over a valid lease. Scheduling markers do not mean the model checked every historical entry or note individually.

There is no manual maintenance entry point. `--pi-memory-no-dream` disables only automatic model calls; pending interactions are still recorded. To restore automatic maintenance, restart Pi without that flag. Recall and automatic maintenance are independent. `session_start` only sets runtime switches according to startup flags, without resetting project counts. Background writes do not add interactions, and foreground global or project writes do not add an extra interaction either.

This is not a standalone daemon. After Pi exits, committed pending state stays on disk until a foreground run finishes in a later active session with automatic maintenance enabled. A project retains latest-count records for at most 1000 sessions. Reaching the limit raises an error rather than silently discarding old records.

### Background model inputs

The background run uses the same model selected when that run starts, calling it through Pi's model registry with the credentials in the current registry. It has its own task prompt, tool definitions, and message array; it does not copy the entire foreground conversation.

At the start, the background model receives an independent maintenance prompt, without a preloaded source catalog or foreground conversation. It calls `memory_read` to read project `MEMORY.md` and notes, `memory_source_search` to discover same-project historical material, and `memory_source` to read pages of complete visible text by ID. The background run has no foreground automatic index-injection hook and does not load the entire note directory by default.

Tool calls in each model reply pass allowlist, parameter, and scope checks before sequential execution. Results return to this independent conversation before the next model call. The model eventually returns a short report or stops because of errors, budgets, or cancellation. On success, the host shows only a short confirmed-write count in a UI notification or terminal output; passes with no successful writes stay silent. The model report is not displayed or appended as a foreground message. Failures still produce a warning.

### Sources span sessions within project, branch, and edit boundaries

The source provider uses only host-supplied `getAgentDir()/sessions` and the current `sessionManager.getSessionDir()`, which supports custom session directories. At task creation, the provider captures the initiating session’s visible active-branch text and provenance in memory, including an unpersisted session. It does not retain the live session manager. Later appends, context edits, and branch changes do not alter that pass’s captured sources; a later pass sees the updated branch. Other same-project native sessions remain read on demand, not frozen as a project-wide snapshot. The model cannot supply arbitrary file paths. Directory names do not determine ownership. Each file's session header is read first, and its actual `cwd` is resolved to a project identity using the same rules as memory. The body is read only after a match. Other projects' content does not enter search.

Reads use bounded standard-library file operations, without calling `SessionManager.open` or `getDefaultSessionDir`, which may migrate, create, or rewrite files. No session copy or permanent search index is saved. Native history requires Pi v3 session format. Unsafe paths, nonregular files, corrupt content, and unsupported content are rejected and reported rather than repaired or overwritten.

The initiating session follows the active branch captured for this pass. Historical files select a branch along the final record's parent chain, without traversing other branches by default. Earlier messages retained through compaction remain accessible. However, `context_edit` deletions on the selected branch hide their targets, and replacements return only the replacement text, marked with `contextEdited` and `evidence`. These cannot count as unmodified original observations. `sourceFile` and `sourceLine` identify a message's position in a native file; replacements also have `contextEditEntryId` and `contextEditSourceLine` pointing to the edit record. Current runtime sources may lack a file position. Sources contain only user, assistant, and ordinary tool-result text, excluding this extension's own memory-tool results. Thinking, signatures, images, custom messages, system prompts, and tool-call arguments are not returned as sources.

Source IDs have the fixed form:

```text
sessionId:entryId:0
```

Exact ID reads do not depend on the previous search page or the per-page session-scan limit. Text is paginated by Unicode code point, with at most 8 KiB UTF-8 per page, and the hash covers the complete visible text. Identical entries copied into forks carry a `duplicateKey` and are deduplicated within a search page. The model must still recognize repeated references across pages; they are not independent observations.

A search cursor is a scan position, not a result number. A single search checks at most 16 candidate sessions, with a 64 MiB native-file body-read budget that also includes rejected corrupt bodies. Reaching the scan budget returns `nextOffset`; pagination should continue even if the current page has no matches. Each session is limited to 16 MiB and 100000 records, and each session header to 16 KiB. Discovery is limited to 512 directories, 20000 entries per directory, and 20000 native session files in total, checking only host roots and one subdirectory level. Limits, corruption, and incomplete discovery are explicitly reported through `partial`, `truncated`, and `warnings`. A bounded scan cannot be treated as the project's entire history. When search output requires a smaller page, it retries from the original cursor without discarding unreturned sources. See the [tool reference](tools.md#internal-dreaming-source-tools) for parameters and pagination.

User statements, assistant judgments, and tool results carry different evidentiary weight. The background prompt asks the model to check sources before stating facts. The program checks source visibility and tool-call validity, not whether a natural-language conclusion has been proved. Historical lookup expands available evidence, not task authorization.

### Maintenance capabilities and budgets

The background run allows only project-scoped `memory_search`, `memory_read`, and `memory_write`, plus `memory_source_search` and `memory_source`. It cannot read or write global memory and has no arbitrary file-reading, shell, network, or testing tools. It can create knowledge from work experience not yet recorded in notes, or use existing feedback to correct, merge, repair links, and archive. It cannot rerun experiments or consult external documentation itself.

Each run allows at most 32 model calls and 64 tool calls, with a 64k (65536-token) output limit per request and a five-minute total timeout. The output limit is capped at the selected model's declared maximum when lower. Calls incur additional costs. The absence of network tools does not mean model requests stay offline. Cancellation propagates an abort signal and stops local waiting, but does not guarantee that a request already received by the provider stops immediately or stops incurring charges.

New input, foreground runs, tree navigation, and session replacement do not cancel an active pass. Its project store, selected model, registry, source roots, and initiating-session sources are captured independently of the foreground context. A process-local task handle survives Pi’s replacement extension runtime; notifications use the current runtime, never a retired `ctx`. Only quitting or explicit extension reload cancels it through lifecycle hooks. It does not run independently after Pi exits. Completed file writes are not undone by cancellation or timeout, and an in-flight write may still finish at the cancellation boundary. Aborting is therefore not a batch rollback.

## Project isolation, paths, and concurrency protection

### Locating the two scopes

The storage root is `PI_MEMORY_DIR`, or `getAgentDir()/pi-memory` when unset. It directly contains `project-<hash>/` and `global/`. Both can contain `MEMORY.md`, topic notes, `.identity.json`, and `.history/`. The project directory also contains the internal `.dream-state.json` scheduling file, excluded from note search and automatic recall. `topics/` and `notes/` are organizational names chosen by the model, not program-defined categories.

Project identity is resolved by applying `realpath` to the current directory, searching upward for the nearest `.git` marker, and using its containing directory as the project root. If no marker exists, the current real directory is used. Only marker existence is checked; Git is not executed and marker contents are not read.

The code uses SHA-256 for two different purposes:

| Name | Input | Purpose |
| --- | --- | --- |
| `<hash>` in the project directory name | Absolute project identity path, encoded as UTF-8 | Stable directory name using the full 64 hexadecimal characters; not a Git commit or content identity |
| Note `hash` and write `expectedHash` | Complete UTF-8 contents of the current Markdown file | Detect changes since reading, regardless of which content page was returned |

Subdirectories of the same Git project share memory. Clones in different locations and separate worktrees do not. Entering a subdirectory of a non-Git project may produce a different identity, and moving a project also changes its ownership mapping. Hashing does not anonymize paths; identity metadata still stores the actual identity.

Project access requires Pi project trust. Foreground reads and writes default to the project scope; search defaults to project and global scopes. Global memory is for cross-project, nonprivate knowledge. Historical authorization in memory does not expand current task permissions, and these interfaces are not a filesystem sandbox for the host shell or other extensions.

### Committing a write

Creation uses `expectedHash: null` and requires an absent target. Rewrites and archives must match the hash of the complete current contents. Each write passes through Pi's in-process file queue, a cross-process lock, path and identity checks, and a current-hash check before saving required history and committing the active-file update.

New content is written to a temporary file, synchronized, and atomically replaces the target. New files use `0600` and new directories `0700`; existing parent permissions are not changed. Lock conflicts fail immediately, without polling to acquire the lock or automatically taking over a lock left by a crash. Corruption, identity mismatches, and invalid paths cannot be reset as an empty store.

On a hash mismatch, the existing tool-error result tells the model to reread, compare, and then merge or abandon the change. The background tool loop returns this error to the model rather than aborting the pass; there is no separate automatic merge or conflict-retry protocol. Replaying old content with only the request hash replaced by the latest value can still overwrite someone else's valid update. Neither multi-file operations nor an entire dreaming run is a transaction. Content, indexes, and other references need separate commits and may temporarily disagree.

### Archiving and capacity

Archiving preserves the current content before removing the active file. It does not automatically update links in other files. The root `MEMORY.md` cannot be archived, and memory tools provide no action to clear history. Snapshots live at `.history/<original-relative-path>/<UUID>.md`, preserve the original content, and are excluded from active listing and search.

| Object | Limit |
| --- | --- |
| Each `MEMORY.md` | 8 KiB, 200 lines |
| Each ordinary Markdown file | 64 KiB |
| Active Markdown in each scope | 500 files, 8 MiB total |
| History snapshots in each scope | 1000 |

When history is full, operations that need an additional snapshot are rejected; the oldest records are not cleaned up automatically. Archiving also needs history capacity. The root index must be named exactly `MEMORY.md`. Case aliases and using the reserved name as a directory are prohibited to prevent bypasses on case-insensitive filesystems.

Revision history is not a backup system. Stop all writers before independent backup, restoration, or cleanup. Archiving does not remove existing sessions, backups, or provider copies, and does not guarantee secure erasure.

## Relationship to the reference article

The design draws on Anthropic's [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory), published on November 6, 2026. The comparisons below use both the text and Figures 1 through 15, while distinguishing architectural diagrams, task experiments, and this extension's implementation choices. The maintenance workspace keeps a snapshot at `references/components-of-agent-memory/`, including original HTML, original images, offline text, and source hashes. That local third-party snapshot is excluded from Git and the npm package and is not included in a fresh clone; when present, its README explains how to recheck it.

Figures 1, 2, 6, 9, and 13 describe composable memory layers, not a pipeline that must run in order every time. Significant observations can be recorded directly during a session. Dreaming can use raw records to correct notes, build interlinked representations, promote content into the injected layer, or reorganize higher layers. This project uses free-form Markdown and links for notes and representations, with a small `MEMORY.md` for the injected layer. It does not require a separate Wiki engine. The background model can create the first note from native history without a prior foreground note write.

Light foreground guidance and detailed background maintenance are different tasks. The article's usual guidance for frontier models explains memory's purpose and asks models to save information when requested or when it is clearly worth remembering, leaving significance judgments to the model. It does not establish that less guidance suits every model: the detailed guidance on the left of Figure 5 improved Sonnet 4.6's performance, while the right tests the "record only failures" restriction with fewer samples. The two sets of error bars are standard deviation and standard error respectively. This project uses a lightweight foreground purpose prompt without claiming it is optimal for every model. Background source checks, correction, merging, link repair, and small-index maintenance still need an explicit task prompt.

Figure 10 shows Wiki and raw-source search complementing each other, rather than a Wiki replacing sources. The horizontal axis is a logarithmic Wiki-generation budget with 1M tokens per session, explicitly labeled as a budget rather than measured spend. Figure 11 shows different gains for cross-document judgment tasks and tasks retrievable from a single document. The model labeled those categories, so individual connecting lines should not be overinterpreted. Figure 12 also shows a counterexample in which a Wiki expanded to 1.77 times the source material. This project's foreground tools search Markdown, and native-history search is available only in the background. That is not equivalent to the experimental setup that also searches raw company documents while answering questions.

Figure 14's one-page-per-contract, single-author, and verbatim-clause requirements are experimental improvements addressing both coverage and facts lost through summarization in a contract task, not a mandatory ownership workflow for every memory system. Figure 15's second maintenance pass fixed 9 missing-page links and added 3 pages, supporting background link maintenance and entry-point repair. It does not require automatic graph generation or rebuilding the entire store on each run. The article's instruction-reflection and Wiki-rebuilding loops are also task examples; this project does not reproduce that experimental framework.

Project/global scopes, hashes and locks, the 8-interaction trigger, the 32-model-call budget, and capacity limits are this extension's own implementation choices. The article leaves creation timing, update reliability, and dreaming cadence as open questions rather than prescribing these numbers. Having these data flows does not establish the article's learning gains. A verified rule still needs real tests or source feedback; a note's "verified" label cannot substitute for them.

## Implementation guarantees and unproven effects

Code can constrain access scope, conflicts, source-scan bounds, and call budgets. Prompts guide content selection, evidence checking, and link maintenance. The latter are not program guarantees: no source checker proves every paragraph correct, no link checker guarantees all links remain valid after maintenance, and not every model is guaranteed to write or use notes correctly.

Notes are plaintext. Injected indexes, read content, and dreaming sources are sent to the selected model provider. Local storage does not mean data never leaves the device. Prompts and free-form Markdown do not guarantee protection against prompt injection either.

Automated tests cover program boundaries, synthetic tool flows, offline CLI loading, and scripted-model loops, not memory benefits on real tasks. Effectiveness evaluations must separately record the model, tasks, a no-memory baseline, budgets, and results. Anthropic's experimental results cannot substitute for those evaluations. See the [development guide](development.md) for source navigation and validation methods.
