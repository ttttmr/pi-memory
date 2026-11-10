# Development and validation

English | [简体中文](development.zh-CN.md)

This page is for maintainers. Maintenance Agents should first read [AGENTS.md](../AGENTS.md). See the [README](../README.md) for usage, the [tool reference](tools.md) for parameters, and the [design](design.md) for storage and request lifecycles.

## Environment and commands

Pi loads TypeScript ESM source directly. There is no separate service, compiled output, or build step. The package declares Node.js 22.19 or later; the development baseline is Node.js 24, Pi 1.5.0, and macOS. This does not mean every environment allowed by the declaration has been tested.

```bash
npm ci --ignore-scripts
npm run check
```

`npm ci` installs development dependencies from the lockfile while skipping dependency installation scripts. coding-agent and TypeBox are host-provided peerDependencies, with specific development versions in devDependencies. Do not bundle them into another runtime host.

```bash
# Type-check without emitting JavaScript
npm run typecheck

# Run all tests with Node's built-in test runner
npm test

# Run a single module's tests
node --experimental-strip-types --test src/memory-store.test.ts

# Inspect distribution files without creating or uploading a tarball
npm pack --dry-run
```

`npm run check` runs type checking followed by all tests. There are no separate lint, formatter, or build commands. Before filtering tests by name, look up the actual test names in the current test file.

## Source navigation

| Module | Responsibility |
| --- | --- |
| `src/memory-extension.ts` | Three foreground tools, command, switches, context injection, and background scheduling |
| `src/memory-schema.ts` | Markdown writing-tool parameters and scope types |
| `src/memory-store.ts` | Project resolution, active-file reads and writes, hash conflicts, history, locks, and atomic replacement |
| `src/memory-search.ts` | Lexical search, file listing, and compact index context |
| `src/memory-dream.ts` | Independent model loop, source-tool integration, tool allowlist, budgets, and cancellation |
| `src/memory-sources.ts` | Read-only discovery of same-project native history, branches and context edits, source search, and exact paginated reads |
| `src/memory-schedule.ts` | Persistent project-level interaction counts, latest-leaf deduplication, work leases, and generation acknowledgment |
| `src/memory-observations.ts` | Ordered commits of completed interactions, wake-up on lock-release events, and retention on failure |

Tests live beside their modules as `src/*.test.ts`. Synthetic fixtures live in `test/` and are excluded from the distribution package. When working with Pi APIs, check the documentation and types in the current development dependency, especially `context`, `agent_settled`, projection, and model-registry interfaces. Use the current API rather than assumptions from memory.

## Automated check coverage

| Area | Main assertions |
| --- | --- |
| Storage | Project/global isolation, path and identity validation, plaintext Markdown, hash conflicts, history retention and capacity, locks, cancellation, and atomic replacement |
| Search and index | English words and Han/kana bigram search, listing without a query, injection of only MEMORY.md rather than matching note content, budgets, and temporary context |
| Foreground interfaces | Three tool schemas, defaults, lightweight purpose and autonomous-selection guidance, no fixed content template, retained tool-operation instructions; Unicode code-point pagination within line ranges, 8 KiB page caps, long single-line reads, complete JSON output, autonomous global writes, project trust, and metadata-only write receipts; usage for empty `/memory`, verbatim forwarding, and busy follow-up behavior for the sole command, without old command aliases or management subcommands |
| Background scheduling | Newly completed foreground interactions count without note writes, automatic claims after 8 unprocessed interactions accumulated across sessions; latest-leaf deduplication, no store creation on read-only startup, continued recording when automatic calls are disabled, two independent startup switches, and no manual maintenance or runtime toggle entry point |
| Scheduling concurrency and recovery | Multiple runners do not duplicate valid lease claims; success acknowledges only the claimed generation and preserves newer work; lock contention preserves interaction order and original identities, commits after release without duplication, and same-session module reloads share one FIFO; old and new observations cannot move the latest leaf backward or trigger maintenance early; switches do not start runs from old context; shutdown warns about in-memory observations; failures and cancellation preserve committed pending state, expired leases can be claimed again, and corrupt state is not reset as empty |
| Background sources | Same-project header `cwd` validation, cross-session and pre-compaction text, current active branch and historical final parent chain, context deletions and replacements, stable IDs, complete-visible-text hashes, and 8 KiB Unicode code-point pagination; no thinking, signatures, images, system content, or this extension's own memory results |
| Source-scan boundaries | Host roots and custom session directories, unpersisted current sessions, exact IDs independent of search pages, continuation after empty pages, budgets and warnings, duplicate markers for inherited entries, safe paths, rejection of corruption and over-limit files, and no rewriting of original history |
| Background model loop | Same selected model and registry, only project memory and the two source tools, budgets, conflicts, cancellation, and retained partial commits |
| Synthetic integration loop | Scripted model creates the first memory from historical feedback without prior notes; cross-session source reads correct old hypotheses, merge and archive duplicate notes, and repair the index; new sessions read persisted Markdown, without proving model judgment quality |
| Real CLI | Load the extension from the package manifest, check startup flags and empty `/memory` usage offline without model requests; use long-lived RPC with a synthetic provider to check idle requests, busy follow-up, tool writes, and fresh-session index recall without requesting a real model provider |

This table defines maintenance coverage, not a receipt that every check passed in a particular run. Delivery reports should list actual commands, results, and behavior not yet covered.

History-source tests write synthetic v3 sessions only inside temporary host directories, including counterexamples for projects, branches, compaction, and context edits. Compare original file contents and directory listings before and after scans to confirm no migration, extra writes, or session-file generation. Missing roots must stay missing. Scheduling tests should let different sessions or independent scheduling calls share project storage, covering a new instance reading committed counts rather than only in-memory accumulation.

Scripted integration should include at least two starting points: existing notes needing correction, and a project with only historical feedback and no Markdown. The former checks revisions and archiving after reads by historical ID; the latter checks that notes and an index can be created without a foreground `memory_write`. Scripted responses establish capabilities and data flow, not that real models autonomously select the right experience.

### Isolation requirements

Unit tests use temporary directories and synthetic sources. They do not read real user sessions, everyday memory stores, credentials, or private paths. Model-loop tests use controlled mock responses; ordinary tests should not call paid models.

Real CLI tests use an independent Pi configuration, a temporary project and `PI_MEMORY_DIR`, offline mode, other extensions and resources disabled, and `--no-session`. Empty-command checks do not start a model. RPC tool loops additionally load only the synthetic test provider, without requests to real model providers. Setting only `PI_MEMORY_DIR` does not isolate host configuration, credentials, or network access. Tests must not scan real session files just to obtain a source.

Canonicalize temporary directory paths first to avoid identity mismatches between macOS `/var` and `/private/var` aliases. Concurrency tests need explicit waiting and cleanup mechanisms rather than relying on arbitrary delays.

### Documentation and package checks

After documentation changes, check local Markdown links and heading anchors, validate JSON examples against registered tool schemas, and confirm placeholder hashes are not described as executable values. Directory examples should match the actual layout.

The `npm pack --dry-run` manifest should include both language versions of the README, AGENTS.md, bilingual user documentation under docs, and their local link targets, but no tests or fixtures. AGENTS.md remains a single Chinese maintenance-instruction file. If the tool reference links to source code, confirm that source is packaged too. Package checks do not replace behavioral tests or real-model effectiveness evaluations.

### Reviewing alignment with the article

When available locally, the maintenance workspace's `references/components-of-agent-memory/` stores the article text and image snapshot. It is excluded from Git and the npm package, so a fresh clone does not include it. If absent, consult the original article and explicitly state any offline or image-review limitations; do not claim to have checked the missing snapshot. When present, first read that directory's README, run `python3 references/components-of-agent-memory/verify-archive.py` to verify preserved files, then read the full `article.md` and its 15 original content images. Text, alt text, and hash verification cannot substitute for actually viewing images. If an image cannot be read, explicitly report it as uncovered rather than claiming a complete text-and-image review. Original text and images are third-party content not covered by this project's MIT license.

Compare the current code against the [article interpretation in the design](design.md#relationship-to-the-reference-article), distinguishing foreground purpose guidance from background maintenance tasks, sources from notes, and capabilities from real-model effects. Arrows in architecture diagrams are not a mandatory pipeline. Task-specific instruction optimization, budgets, and graph sizes are not universal minimum requirements. Reports should state sampling, images actually viewed, and code and test coverage. The article's benchmarks cannot validate this extension's effectiveness.

## Manual acceptance

The following steps require a separate decision about model calls. They are not completed UI or effectiveness validation.

In an independent test project, explicitly set a test memory directory:

```bash
PI_MEMORY_DIR=/absolute/path/to/scratch-memory \
  pi -e /absolute/path/to/pi-memory --pi-memory-no-dream
```

This isolates only the memory directory. It still uses normal Pi configuration and provider credentials, and ordinary conversation may still access the network. Disable automatic dreaming first to avoid unexpected extra requests while checking other behavior. Do not point the scratch path at a real store.

Suggested acceptance sequence:

1. Enter `/memory <one thing to remember, in natural language>`. Use synthetic feedback to let the Agent create Markdown autonomously and then maintain the index, confirming that the command handler did not generate the note directly. Empty `/memory` should show usage without calling a model. A save request submitted while the foreground model is busy should run as a follow-up after the current run, without interruption or steering.
2. Ask the Agent in natural language to find and read notes through `memory_search` and `memory_read`. Check that the index stays small and detailed notes enter context only when explicitly read. These are model tools, not extension management subcommands.
3. Start a new session in the same project to check shared memory. Switch to an independent project to check isolation, then explicitly ask the Agent to inspect global memory.
4. Read a hash, modify the same file through another writer, then confirm the stale hash is rejected without losing the newer content.
5. Ask the Agent to archive an ordinary note. Confirm removal from active search, retention of old content, separate index maintenance, and rejection of archiving MEMORY.md.
6. Restart with `--pi-memory-no-recall` and confirm tools can still read and write. Restart without that flag to restore index recall. Recall and dreaming switches are independent; neither has a runtime toggle command.
7. After authorizing additional model calls, restart without `--pi-memory-no-dream`. After at least 8 unprocessed foreground interactions have accumulated, observe automatic maintenance, extra requests, project scope, and source boundaries. Check both existing notes needing correction and a project with only synthetic historical feedback and no notes. There is no manual dreaming command.
8. While the background run is active, submit new input, start a foreground run, switch the session tree, fork, switch sessions, or exit. Confirm cancellation and retention of completed writes, without expecting a batch rollback.
9. Accumulate foreground interactions across independent test sessions and check that counts persist across sessions. While automatic maintenance is disabled with `--pi-memory-no-dream`, no background model requests should occur, but pending counts should remain after restarting without the flag to restore it. Do not expect execution to continue after Pi exits.

### Interactive and long-lived RPC acceptance boundaries

Use nonempty `/memory` in interactive Pi. Automated acceptance uses an RPC client that keeps the process alive and continuously consumes events. Pi 1.5.0's one-shot `pi -p '/memory ...'` has a host preflight race with the extension's asynchronous `void sendUserMessage` request. It is not a supported acceptance path for nonempty commands, and the extension does not patch around it. Empty `pi -p '/memory'` only checks usage and involves no subsequent model run.

Synthetic CLI/RPC checks live in `src/memory-cli.test.ts` and can run separately:

```bash
node --experimental-strip-types --test src/memory-cli.test.ts
```

RPC acceptance involving a model needs an explicit sequence and assertions:

1. Start a long-lived client in an isolated environment. Subscribe to events and set a completion timeout before submitting nonempty `/memory`. For the busy case, first start an ordinary task and wait for an actual streaming event before submitting the save request, rather than guessing with a fixed delay.
2. An RPC `handled` response for `/memory` means only that the command handler returned, not that saving completed. The command itself did not start a normal prompt run, but triggers a separate foreground run through `sendUserMessage`. Continue consuming its events until that subsequent run's `agent_settled`. Empty `/memory` should not wait for this model-completion event.
3. Check that the save request retains the user's original words, the model actually calls `memory_write`, and the note and index are persisted. For the busy case, also confirm that the original task finishes first and the save request runs afterward, without steering or aborting the original task. A model's claim of saving, or a `handled` response alone, is insufficient.
4. After the save run completes, use `newSession` to create a fresh session in the same project. Send an ordinary question that omits the remembered content and check that the new request receives temporary injection of the persisted `MEMORY.md`. Do not reuse old messages as evidence of cross-session recall.

A synthetic provider verifies only this event and tool flow, not real-model effectiveness or manual TUI acceptance. Acceptance with a real provider needs the same completion boundaries, separate authorization for calls, an independent temporary Pi configuration, test-only credentials, synthetic material, a separate memory directory, and a record of actual results.

Prefer mock-model tests for automatic dreaming counts and boundaries. Real-model trials must separately record input material, model and version, request costs, completed writes, and failures. One successful maintenance run does not establish general benefits.

## Reporting validation results

Report type checking, unit tests, real CLI loading, manual TUI acceptance, and real-model memory effectiveness separately. Passing the first three establishes only asserted program behavior, not that models save correct knowledge, read the right notes, or improve task outcomes.

Without a controlled comparison on shared tasks, do not claim to reproduce the gains in Anthropic's article. Public effectiveness claims need a reproducible task set, a no-memory baseline, model and budget information, sources, and recorded results.

Installing into personal configuration, changing global configuration, model calls, commits, pushes, and publishing are not authorized by ordinary checks. `npm pack --dry-run` neither publishes nor establishes ownership of the matching npm package name.
