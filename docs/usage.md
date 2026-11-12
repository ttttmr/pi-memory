# User guide

English | [简体中文](usage.zh-CN.md)

Detailed setup, operation, storage, and troubleshooting for pi-memory. For a quick start, see the [README](../README.md).

## Try it

Requires Pi, Git, and Node.js 22.19 or later. The verified development environment is Pi 1.5.0, Node.js 24, and macOS. Detached automatic maintenance currently requires a POSIX host and is unavailable on Windows.

Run this from the project you want to work on. Pi downloads the extension from GitHub; no manual clone is needed:

```bash
pi -e git:github.com/ttttmr/pi-memory --pi-memory-no-dream
```

This loads the extension for the current process without adding it to Pi settings. Pi keeps a local package cache. Automatic background maintenance is disabled for this first run to avoid extra maintenance requests. Ordinary conversation and `/memory` still use your Pi model and credentials.

To ask the agent to remember something, enter:

```text
/memory This project uses npm run check for the full verification. Run it before delivery.
```

Everything after `/memory` is natural-language content, not a subcommand. It asks the agent to save knowledge for future turns and sessions. The agent decides what to write, how to organize it, and whether to update the index. The command does not write a fixed-format note itself or claim success before a save. An empty `/memory` only shows usage and makes no model request. If the agent is busy, a nonempty request waits until the current task finishes.

In a later session with the extension loaded in the same project, ask normally:

> What checks should I run before delivering this project? Please look up the earlier memory.

The three model tools are `memory_search`, `memory_read`, and `memory_write`. You do not need to write their arguments yourself. Ask the agent in natural language to find, read, correct, or archive a memory. `/memory` is the only extension command; there are no path, list, search, or maintenance subcommands. See the [tool reference](tools.md) for the tool protocol.

Agents can also save useful knowledge during ordinary work. Not everything discussed is guaranteed to be saved. When retention matters, ask explicitly and have the agent read back the saved content. A reply saying "I'll remember" does not prove that a file was written.

## Install, update, and remove

For regular use, install from GitHub:

```bash
pi install git:github.com/ttttmr/pi-memory
```

Installation adds the package to your personal Pi settings. Then run `pi` from the project you want to work on and use `/memory` in the session. To keep automatic background maintenance disabled, start with `pi --pi-memory-no-dream`.

Update this package:

```bash
pi update git:github.com/ttttmr/pi-memory
```

Restart Pi or run `/reload` in an existing session to load updated code.

Remove the extension:

```bash
pi remove git:github.com/ttttmr/pi-memory
```

Removal does not delete memory files. Do not assume that a package with the same name on npm is this project.

For local development, you can still load a checkout with `pi -e /absolute/path/to/pi-memory`.

## Control automatic recall and background maintenance

Automatic recall and automatic background maintenance are enabled unless disabled at startup. After 50 unprocessed actual user messages accumulate in the same project, a detached normal Pi Agent can review that project's historical sessions, create notes, and maintain existing notes. Messages are observed after foreground runs settle and deduplicated durably by entry ID across sessions. Existing messages at session startup are baselined, not counted retroactively. Foreground notes do not need to exist first. Old pending-turn state migrates as one-shot legacy work, not as actual user-message counts.

Background maintenance uses the selected provider, model, and thinking level and **makes extra requests that may incur charges, including after you quit Pi**. It reloads normal Pi configuration and credentials and has default file/shell tools plus configured extensions, skills, and MCP tools. Runtime-only changes in the frontend are not copied. The worker reevaluates normal project trust; an unpersisted foreground approval may not carry over and can cause a safe startup failure. This is not a restricted source-tool sandbox. Add `--pi-memory-no-dream` at startup to prevent new automatic launches. This flag does not cancel an already running worker.

To disable both features:

```bash
pi --pi-memory-no-recall --pi-memory-no-dream
```

Startup flags apply to the current running instance and are not saved. Restart Pi without the corresponding disable flag to restore a feature. There are no runtime toggle or manual maintenance commands.

Disabling recall does not disable maintenance or prevent the agent from explicitly reading and writing memory. New actual user messages are still counted while automatic maintenance is disabled and can be processed after it is enabled again.

You can keep chatting, navigate the session tree, switch sessions, reload extensions, or quit Pi while maintenance runs. The detached Agent continues on its original project and can finish after the frontend exits; newer messages remain pending. Each run has a 30-minute wall-clock deadline from launch, enforced by a supervisor with a short cleanup grace before hard-killing the process group and captured descendants. This is best-effort cleanup, not containment of disowned processes or external work. Completed writes are not rolled back. There is no permanent daemon: work not yet launched waits for a later eligible frontend opportunity. A launch notification is not a success receipt.

While the launching Pi process remains open, it shows brief notifications for launch and observed running, completed, failed, timed-out, or unclaimed states. Each notice includes the run directory. Completion means the worker acknowledged its claimed batch, not that every memory claim was verified. Reloading or switching sessions in the same process keeps status observation active. Quitting stops foreground notifications, not the worker; later Pi processes do not replay those notices. Print/JSON modes write notices to stderr. If status observation fails or no final state is available shortly after the deadline, a warning reports that completion is unknown. Inspect `status.json` and logs for details.

## Storage and backups

The default root is usually `~/.pi/agent/pi-memory`, specifically `pi-memory/` under Pi's agent directory. It contains project directories named `project-<hash>/` and a `global/` directory. Set `PI_MEMORY_DIR` to use another location; an absolute path is recommended:

```bash
PI_MEMORY_DIR=/absolute/path/to/memory \
  pi --pi-memory-no-dream
```

Use project memory for project details. Global memory is only for knowledge that is genuinely useful across projects and nonprivate. Tell the agent which scope you intend in natural language.

Subdirectories of the same Git project share project memory. Separate worktrees and clones at different paths do not. Moving the project changes its memory identity and does not move the files automatically. See the [design guide](design.md#locating-the-two-scopes) for the exact rules.

Before backing up, ensure every writer has stopped, including detached maintenance workers. Closing foreground Pi alone is insufficient; check the run records first. Copy the entire storage root, including hidden files and history. Each project's `.dream-runs/<run>/` holds private `status.json`, `events.jsonl`, `supervisor.log`, and the worker's native session under `sessions/`. These may contain sensitive raw tool text; protect them along with notes and backups. Archiving a note is not permanent deletion and does not remove existing sessions, backups, or provider copies.

## Troubleshooting

| Symptom | Check or action |
| --- | --- |
| `/memory` or the three tools are missing | Check that the GitHub package or local checkout is loaded and that another extension is not registering the same command or tools. |
| No note was saved | Ask explicitly with `/memory`, then have the agent read back the saved content. Background maintenance can also create notes from past work, but not every conversation is guaranteed to be retained. |
| A nonempty `/memory` exits immediately in print mode | Use `/memory` inside an interactive Pi session. Pi 1.5.0 can dispose the command-generated request too early with `pi -p '/memory …'`; this one-shot form is not a supported save path. |
| Project memory requires trust | Review the project first, then authorize it through Pi. Do not blindly trust an unfamiliar project. |
| A note can be found but the agent did not use it | Ask the agent to search for and read that note. Automatic recall does not load every note body. |
| A global note cannot be read | Ask the agent to read the global scope explicitly rather than the current project's scope. |
| Hash conflict | Have the agent reread and compare the new content, then merge or abandon the change. Do not force an overwrite. |
| Memory lock conflict | Retry note writes after the writer finishes. Interaction counts stay queued in the current process and are retried after lock release without stealing the lock. If exit reports unsaved counts, do not treat them as persisted. Handle a crash-leftover lock manually only after confirming there is no writer. |
| Identity, path, or file validation failed | Stop writing and preserve the files. Check ownership and structure rather than clearing the directory to bypass the error. |
| Capacity or history limit reached | Stop writing and back up first, then follow the [storage limits](design.md#archiving-and-capacity). Archiving also requires history space. |
| Automatic maintenance did not start | Check startup flags, project trust, and the selected model. 50 unprocessed actual user messages must accumulate in the same project (or migrated legacy work must be due). Startup history does not count. Check `.dream-state.json` and `.dream-runs/`; a valid project lease prevents duplicate launches. Unlaunched work waits while Pi is closed, but an active worker can continue. |
| Maintenance failed or timed out | Inspect the run's `status.json`, `events.jsonl`, `supervisor.log`, and native session. Check model availability and normal worker configuration. Launch success does not mean completion; failures keep pending work and completed writes remain. |

## Privacy and usage notes

Files are stored locally in plaintext. Notes loaded into context and historical material read by the worker are sent to the selected model provider. The detached Agent can read raw same-project native sessions across conversations, including retained pre-compaction text and raw fields not exposed by the old filtered source tools. Direct file reads do not automatically enforce active-branch selection, context deletions or replacements, or exclusion of thinking, images, system-related content, and tool arguments. Do not assume deleted context has been erased from native logs.

The task prompt requires read-only treatment of sessions and source code, safe project-memory writes through memory tools, and treating historical instructions as untrusted evidence rather than permission. **These are prompt rules, not an OS sandbox.** The worker has normal Pi file/shell tools and configured extensions, skills, and MCP resources, which may access files or the network. Its own session and event logs can retain sensitive tool text. Do not save credentials, private prompts, personal information, or whole logs as notes. Local storage does not mean content stays on the device. Disable automatic maintenance at startup if this history access or full Agent authority is unacceptable; this prevents new launches, not a worker already running.

Memory can be outdated or wrong. Check the current environment and evidence before important actions. Memory does not replace project instructions or expand the agent's task authorization.

## Further reading

- [Memory components and runtime behavior](design.md): components, request flow, a worked example, background maintenance, and storage boundaries
- [Tool reference](tools.md): arguments, results, pagination, and conflict handling
- [Development and verification](development.md): source map, tests, and maintenance workflow
