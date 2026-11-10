# pi-memory

English | [简体中文](README.zh-CN.md)

A cross-session memory extension for Pi. Agents can save and retrieve reusable knowledge, then review the same project's work history in the background to create and maintain notes. Memory is stored locally, with project and global scopes.

## Try it

Requires Node.js 22.19 or later. The verified development environment is Pi 1.5.0, Node.js 24, and macOS.

Run this from the project you want to work on, replacing the extension path with this project's absolute path:

```bash
pi -e /absolute/path/to/pi-memory --pi-memory-no-dream
```

This loads the extension for the current process without changing Pi settings. Automatic background maintenance is disabled for this first run to avoid extra maintenance requests. Ordinary conversation and `/memory` still use your Pi model and credentials.

To ask the agent to remember something, enter:

```text
/memory This project uses npm run check for the full verification. Run it before delivery.
```

Everything after `/memory` is natural-language content, not a subcommand. It asks the agent to save knowledge for future turns and sessions. The agent decides what to write, how to organize it, and whether to update the index. The command does not write a fixed-format note itself or claim success before a save. An empty `/memory` only shows usage and makes no model request. If the agent is busy, a nonempty request waits until the current task finishes.

In a later session with the extension loaded in the same project, ask normally:

> What checks should I run before delivering this project? Please look up the earlier memory.

The three model tools are `memory_search`, `memory_read`, and `memory_write`. You do not need to write their arguments yourself. Ask the agent in natural language to find, read, correct, or archive a memory. `/memory` is the only extension command; there are no path, list, search, or maintenance subcommands. See the [tool reference](docs/tools.md) for the tool protocol.

Agents can also save useful knowledge during ordinary work. Not everything discussed is guaranteed to be saved. When retention matters, ask explicitly and have the agent read back the saved content. A reply saying "I'll remember" does not prove that a file was written.

## Install and remove

For regular use, install from the local project path:

```bash
pi install /absolute/path/to/pi-memory
```

Installation changes your personal Pi settings. Do not assume that a package with the same name on npm is this project.

To remove the extension:

```bash
pi remove /absolute/path/to/pi-memory
```

Removal does not delete memory files.

## Control automatic recall and background maintenance

Automatic recall and automatic background maintenance are enabled unless disabled at startup. After eight unprocessed foreground interactions accumulate in the same project, the background model can review that project's historical sessions, create notes, and maintain existing notes. Foreground notes do not need to exist first. Counts persist across sessions. Nothing keeps running after Pi exits; processing waits for a later foreground interaction to finish with the extension loaded.

Background maintenance uses the current model and **makes extra requests that may incur charges**. Add `--pi-memory-no-dream` at startup if you do not want automatic maintenance.

To disable both features:

```bash
pi -e /absolute/path/to/pi-memory \
  --pi-memory-no-recall --pi-memory-no-dream
```

Startup flags apply to the current running instance and are not saved. Restart Pi without the corresponding disable flag to restore a feature. There are no runtime toggle or manual maintenance commands.

Disabling recall does not disable maintenance or prevent the agent from explicitly reading and writing memory. Pending interactions are still counted while automatic maintenance is disabled and can be processed after it is enabled again.

New input, the start of a foreground run, session or tree changes, and exiting Pi cancel active maintenance. File updates that have already completed are not rolled back.

## Storage and backups

The default root is usually `~/.pi/agent/pi-memory`, specifically `pi-memory/` under Pi's agent directory. It contains project directories named `project-<hash>/` and a `global/` directory. Set `PI_MEMORY_DIR` to use another location; an absolute path is recommended:

```bash
PI_MEMORY_DIR=/absolute/path/to/memory \
  pi -e /absolute/path/to/pi-memory --pi-memory-no-dream
```

Use project memory for project details. Global memory is only for knowledge that is genuinely useful across projects and nonprivate. Tell the agent which scope you intend in natural language.

Subdirectories of the same Git project share project memory. Separate worktrees and clones at different paths do not. Moving the project changes its memory identity and does not move the files automatically. See the [design guide](docs/design.md#locating-the-two-scopes) for the exact rules.

Before backing up, stop every Pi session that could write to the memory store. Copy the entire storage root, including hidden files and history. Archiving a note is not permanent deletion and does not remove existing sessions, backups, or provider copies.

## Troubleshooting

| Symptom | Check or action |
| --- | --- |
| `/memory` or the three tools are missing | Check that this project's absolute path is loaded and that another extension is not registering the same command or tools. |
| No note was saved | Ask explicitly with `/memory`, then have the agent read back the saved content. Background maintenance can also create notes from past work, but not every conversation is guaranteed to be retained. |
| A nonempty `/memory` exits immediately in print mode | Use `/memory` inside an interactive Pi session. Pi 1.5.0 can dispose the command-generated request too early with `pi -p '/memory …'`; this one-shot form is not a supported save path. |
| Project memory requires trust | Review the project first, then authorize it through Pi. Do not blindly trust an unfamiliar project. |
| A note can be found but the agent did not use it | Ask the agent to search for and read that note. Automatic recall does not load every note body. |
| A global note cannot be read | Ask the agent to read the global scope explicitly rather than the current project's scope. |
| Hash conflict | Have the agent reread and compare the new content, then merge or abandon the change. Do not force an overwrite. |
| Memory lock conflict | Retry note writes after the writer finishes. Interaction counts stay queued in the current process and are retried after lock release without stealing the lock. If exit reports unsaved counts, do not treat them as persisted. Handle a crash-leftover lock manually only after confirming there is no writer. |
| Identity, path, or file validation failed | Stop writing and preserve the files. Check ownership and structure rather than clearing the directory to bypass the error. |
| Capacity or history limit reached | Stop writing and back up first, then follow the [storage limits](docs/design.md#archiving-and-capacity). Archiving also requires history space. |
| Automatic maintenance did not start | Check startup flags, project trust, and the selected model. Eight unprocessed interactions must accumulate in the same project. Nothing runs while Pi is closed. |
| Maintenance failed or was cancelled | Check the selected model and the error. Completed writes remain; cancellation does not roll back the batch. |

## Privacy and usage notes

Files are stored locally in plaintext. Notes loaded into context and sources read during background maintenance are sent to the selected model provider. Background maintenance can search the same project's Pi history read-only, including other sessions and retained pre-compaction text, not just the current conversation. It does not rewrite original sessions or offer arbitrary-path reads. It respects context deletions and replacements on the selected branch and does not read thinking, images, or system prompts. Do not save credentials, private prompts, personal information, or whole logs. Local storage does not mean content stays on the device. Disable automatic maintenance at startup if you do not want it to review historical sessions.

Memory can be outdated or wrong. Check the current environment and evidence before important actions. Memory does not replace project instructions or expand the agent's task authorization.

## Further reading

- [Memory components and runtime behavior](docs/design.md): components, request flow, a worked example, background maintenance, and storage boundaries
- [Tool reference](docs/tools.md): arguments, results, pagination, and conflict handling
- [Development and verification](docs/development.md): source map, tests, and maintenance workflow
