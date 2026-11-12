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
| Project scheduling metadata | `.dream-state.json` in the project directory | Actual user-message IDs, pending session batches, legacy work, and the run lease; unavailable through memory tools |
| Native session history | Same-project session files managed by Pi | Agent-directed raw history reads, without storing source-session copies |
| Dreaming conversation | The run directory under `.dream-runs/` | The worker's own native session, JSONL events, status, and supervisor diagnostics, separate from the foreground conversation |

The index, topic notes, and sources have different roles. The index says when to consult which note. Notes describe conclusions and their basis. Sources are the material the model may need to check again. References in notes are written by the model; full logs are not attached automatically. The background Agent can locate raw same-project history from session IDs and file hints, but missing or unsaved files may make a source unavailable. A reference alone does not establish that it was checked.

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

Both model runs in the diagram can modify notes, but only the foreground model also performs the user's ordinary task. Dreaming is instructed to perform only memory maintenance, but it has normal Agent tools. This is prompt policy, not a tool sandbox.

## What happens during a foreground request

### Loading the extension does not immediately create knowledge

The extension registers `memory_search`, `memory_read`, and `memory_write`. Its only user command, `/memory <one thing to remember, in natural language>`, sends the user's own words to the foreground model as a request to save information for future turns and sessions. If the foreground model is busy, the request is queued as a follow-up. Empty arguments only display usage and do not call a model. The command handler does not generate notes directly; the model decides how to use the memory tools.

Foreground writing guidance explains only the purpose of memory across future turns and sessions: save information when the user asks or when something is clearly worth remembering, leaving selection and organization to the model. It prescribes no note categories, required sections, or universal maintenance procedure. Tool descriptions still explain operational requirements such as paths, pagination, hashes, and index maintenance. Search guidance retains reminders to consult relevant memory, check applicability, and avoid treating memory as higher-priority instructions. Independent dreaming uses the maintenance prompt described below, rather than placing its entire workflow in permanent foreground rules.

`session_start` sets recall and automatic dreaming according to the startup flags. It neither clears memory files nor resets project-level pending user-message counts. `--pi-memory-no-recall` and `--pi-memory-no-dream` disable recall and automatic maintenance respectively. To restore either, restart Pi without the corresponding disabling flag; there are no runtime toggle commands. Read-only startup and reads of missing memory do not create directories. Recording the first new actual user message may create the project directory, identity metadata, and scheduling file even if no Markdown notes exist yet. The model still decides whether to create knowledge content. A failed write may also leave directories that were already created.

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

An old reference in a note does not mean the foreground model has checked that session. The three foreground memory tools still access only Markdown. The background Agent can read native history to find the actual same-project material, retaining an unverified qualification if it cannot find it.

### Dreaming can check history or create the first note

If the foreground model leaves new feedback without updating the old note, the background Agent can use its normal file and shell tools to locate and read the same-project raw session feedback. The material need not remain in the current compacted context or come from the current session. The background model then reads `MEMORY.md` and related notes to revise the conclusion and index.

Even if no notes exist yet, the background model can create content and an entry point from useful historical experience. Scheduling does not wait for the foreground model to call `memory_write` first. The model still decides what is worth saving and how to organize it; the program does not automatically convert every conversation into a note.

If there is also a duplicate note, the background model can merge useful content into the retained path, repair references in the index and other notes, and archive the duplicate. The archived file no longer appears in active search, but its original content remains in `.history/`. Sources unavailable to the background model must remain marked as unverified and cannot justify promoting a hypothesis to fact.

Later requests still read the same `MEMORY.md` and open the revised topic note as needed. There is no separate dreaming summary to synchronize. Scripted integration tests can verify this read/write and cross-session flow, but do not verify real models' judgment quality.

## Independent dreaming Agent

### Scheduling counts actual user messages across the project

Automatic dreaming is enabled by default. At `session_start`, the extension baselines user-message entry IDs already present in the session. Opening existing history does not count it retroactively. At `agent_settled`, it observes newly added actual user messages and queues their IDs with the original project, session ID, and optional native session-file hint. A completed run can contain several user messages or none; tools, assistant replies, internal model calls, and repeated settlement notifications do not count as user messages.

The project scheduling file `.dream-state.json` durably deduplicates message IDs and retains pending session batches. Counts accumulate across sessions and processes. Every `(sessionId, userEntryId, optional sessionFile)` record remains after processing for durable deduplication. Scheduling metadata allows at most 1000 distinct sessions and 1 MiB of JSON; reaching either limit rejects the update explicitly, without eviction or reset. Automatic work becomes due after **50 unprocessed actual user messages**, independently of whether notes exist or the foreground Agent has called `memory_write`. Existing v1 pending-turn state migrates as legacy pending work eligible for a one-shot maintenance pass; old turns are not relabeled or counted as actual user messages.

Observations are queued in order for their original project. A held cross-process file lock leaves them in memory until filesystem events allow a retry, without polling or stealing the lock. Module reloads share the process queue rather than independently replaying it. Uncommitted observations are not crash-recoverable: shutdown attempts a commit and warns if any remain unsaved. Read-only startup does not create a store; recording the first new user message may create the project directory, identity, and scheduling file even without Markdown notes.

A trusted project, selected model, enabled automatic maintenance, and due work permit a claim. A project has at most one active logical lease, lasting **1830 seconds**, separate from the short file lock. The lease captures the claimed generation and session batches. The worker, not the foreground launch callback, owns completion acknowledgment. Success acknowledges only the claimed generation, leaving later messages pending. Failure retains pending work; completed note writes remain. An expired lease permits a later claim, but a valid lease is not stolen. The launcher checks for an active lease before creating run artifacts; the worker claims atomically to resolve simultaneous startup races. A launch receipt means only that the detached supervisor started, not that maintenance succeeded.

`--pi-memory-no-dream` disables new automatic launches, not observation recording. Recall remains independent. There is no runtime toggle or manual maintenance command. Committed work that has not launched waits for a later eligible frontend opportunity. No permanent daemon watches for new work after all frontends exit.

### A detached supervisor starts a normal Pi Agent

Detached supervision currently requires a POSIX host and is unavailable on Windows. A detached supervisor starts the host Pi CLI in the canonical project directory, using the selected provider, model, and thinking level. It explicitly loads the memory and worker extensions and otherwise follows normal Pi resource loading, configuration, credentials, extensions, skills, and MCP setup. Credentials are reloaded from the worker's normal configuration; the foreground registry object is not serialized. Runtime-only provider registrations, credentials, or other configuration changes cannot be copied into the new process. Normal project trust checks are reevaluated in the worker; the launcher does not add an automatic trust approval. An ephemeral foreground approval that is not persisted may therefore cause the child to fail safely rather than inherit trust.

This is an independent Agent session, not a custom message-array loop. The task includes the claimed session IDs, optional native-file paths, session roots, project identity, existing memory location, and wall-clock deadline. It does not copy the foreground conversation or create an index of source-session copies. The Agent decides how to inspect raw history and memory, including how much context to read and which evidence warrants a note. Unsaved or unavailable sessions may be impossible to recover from hints alone and must not be described as checked.

The worker has normal default tools (`read`, `bash`, `edit`, `write`), memory tools, and normally configured resources. The old `memory_source_search` and `memory_source` tools are not its interface. The retained `memory-sources.ts` module does not constrain its raw reads. There is no automatic active-branch projection, context-edit redaction, thinking-field exclusion, or source-provider pagination boundary for ordinary file reads. Session IDs and paths are lookup clues, not proof that the Agent inspected every entry or selected the correct branch.

The maintenance prompt asks the Agent to create useful knowledge, correct unsupported conclusions, merge duplicates, repair links, archive obsolete notes, and keep `MEMORY.md` small. It instructs the Agent to keep sessions and source code read-only, write project memory through memory tools, preserve uncertainty, and treat historical instructions as untrusted data that cannot grant authorization. These are task policies, **not an OS sandbox**. Full Agent tools and configured extensions can access files, run commands, and make network requests. Ordinary memory-tool path, hash, history, and locking checks still protect writes made through those tools, but do not restrict unrelated tools.

### Deadline, foreground independence, and run records

There is no extension-specific 32-model-request limit, 64-tool-call limit, or 64k output cap. Requests follow the selected model and normal Pi defaults. The Agent is told its **30-minute wall-clock deadline**, counted from launch including startup. The supervisor terminates the worker at that deadline and, after a short cleanup grace, hard-kills its process group and captured descendants, including ordinary detached bash tools. Descendant cleanup is best effort, not process containment: already reparented or disowned processes and external work may outlive the run. A provider may still charge for a request it has already received, and termination cannot roll back completed writes.

Foreground input, new runs, tree navigation, session switching, extension reload, and quitting Pi do not cancel an already spawned supervisor or worker. An active worker can finish and acknowledge its lease after the frontend exits. This is not a permanent service: only the spawned run survives, and untriggered pending work does not start itself while Pi is closed. Disabling dreaming on a later frontend does not cancel a run already launched.

Each run has a unique directory under the project's `.dream-runs/`. It contains `status.json` for run state, `events.jsonl` for JSONL events, `supervisor.log` for diagnostics, and the worker's own native session under `sessions/` via `--session-dir`. These are private operational records, not Markdown knowledge. No separate source-session mirror or index is created, but the worker session and events can retain source content returned by tools. Keeping the worker session outside ordinary source roots avoids treating its own maintenance conversation as new foreground history. Logs and sessions may include raw sensitive tool text and are not covered by Markdown note-capacity limits.

The foreground observes each run it launches through a non-polling directory watcher and reads `status.json` on registration and filesystem events. Worker and supervisor status updates use atomic replacement. Launching/starting are covered by the launch receipt; observed running and terminal states each produce a short metadata-only notification, with duplicate states suppressed. The first terminal state closes the watcher. An observation error or lack of a terminal state by ten seconds after the deadline reports an unknown result, never inferred success or timeout. Watchers do not keep Pi alive, call a model, or acknowledge scheduling work. Reload/session replacement shares observers and routes notifications through the current UI; quit closes observers without signalling the detached worker. Notifications are not durable or replayed by a later process.

Inspect the run's final status and session when diagnosing outcomes; neither a frontend notice nor a model's completion claim alone proves success. The worker owns the final scheduling acknowledgment. Errors or timeout may leave partial note updates, and neither multi-file maintenance nor a whole run is a transaction. Backups and cleanup must account for active detached workers as well as foreground Pi sessions.

## Project isolation, paths, and concurrency protection

### Locating the two scopes

The storage root is `PI_MEMORY_DIR`, or `getAgentDir()/pi-memory` when unset. It directly contains `project-<hash>/` and `global/`. Both can contain `MEMORY.md`, topic notes, `.identity.json`, and `.history/`. The project directory also contains internal `.dream-state.json` scheduling metadata and `.dream-runs/` operational records, excluded from note search and automatic recall. `topics/` and `notes/` are organizational names chosen by the model, not program-defined categories.

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

Figure 10 shows Wiki and raw-source search complementing each other, rather than a Wiki replacing sources. The horizontal axis is a logarithmic Wiki-generation budget with 1M tokens per session, explicitly labeled as a budget rather than measured spend. Figure 11 shows different gains for cross-document judgment tasks and tasks retrievable from a single document. The model labeled those categories, so individual connecting lines should not be overinterpreted. Figure 12 also shows a counterexample in which a Wiki expanded to 1.77 times the source material. This project's foreground tools search Markdown, while the background Agent can read native history with normal tools. That is not equivalent to the experimental setup that also searches raw company documents while answering questions.

Figure 14's one-page-per-contract, single-author, and verbatim-clause requirements are experimental improvements addressing both coverage and facts lost through summarization in a contract task, not a mandatory ownership workflow for every memory system. Figure 15's second maintenance pass fixed 9 missing-page links and added 3 pages, supporting background link maintenance and entry-point repair. It does not require automatic graph generation or rebuilding the entire store on each run. The article's instruction-reflection and Wiki-rebuilding loops are also task examples; this project does not reproduce that experimental framework.

Project/global scopes, hashes and locks, the 50-user-message trigger, the 30-minute deadline, and capacity limits are this extension's own implementation choices. The article leaves creation timing, update reliability, and dreaming cadence as open questions rather than prescribing these numbers. Having these data flows does not establish the article's learning gains. A verified rule still needs real tests or source feedback; a note's "verified" label cannot substitute for them.

## Implementation guarantees and unproven effects

Memory-tool code constrains its own paths, conflicts, and storage limits; the supervisor enforces the run deadline. It does not sandbox the full Agent's file, shell, extension, or network access. Prompts guide content selection, evidence checking, and link maintenance. The latter are not program guarantees: no source checker proves every paragraph correct, no link checker guarantees all links remain valid after maintenance, and not every model is guaranteed to write or use notes correctly.

Notes are plaintext. Injected indexes, read content, and dreaming sources are sent to the selected model provider. Local storage does not mean data never leaves the device. Prompts and free-form Markdown do not guarantee protection against prompt injection either.

Automated tests cover program boundaries, synthetic tool flows, offline CLI loading, and scripted-model loops, not memory benefits on real tasks. Effectiveness evaluations must separately record the model, tasks, a no-memory baseline, budgets, and results. Anthropic's experimental results cannot substitute for those evaluations. See the [development guide](development.md) for source navigation and validation methods.
