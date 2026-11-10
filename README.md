# pi-memory

English | [简体中文](README.zh-CN.md)

Cross-session Markdown memory for Pi. Ask the agent to remember useful knowledge and look it up in later sessions.

## Features

- Reuse knowledge across sessions: retain project conventions and lessons from past work, then look them up in a new conversation.
- Separate project and global memory: keep project details isolated and share nonprivate preferences or knowledge across projects when appropriate.
- Let the agent manage notes: search, read, update, and archive local Markdown without writing tool arguments yourself.
- Maintain memory in the background: review the same project's history to find missed lessons, correct or merge notes, and keep the index useful.

## Install

Requires Pi, Git, and Node.js 22.19 or later.

```bash
pi install git:github.com/ttttmr/pi-memory
```

Then run `pi` from the project you want to work on. Automatic background maintenance makes extra model requests; start with `pi --pi-memory-no-dream` to disable it.

## Use

Inside the Pi session:

```text
/memory This project uses npm run check for the full verification. Run it before delivery.
```

In a later session in the same project, ask normally:

> What checks should I run before delivering this project? Please look up the earlier memory.

The agent decides what to save and how to organize it. Not every conversation is saved; ask it to read back a note when retention matters.

## Documentation

- [User guide](docs/usage.md): temporary use, updates, removal, settings, storage, backups, and troubleshooting
- [Design](docs/design.md): memory organization and runtime behavior
- [Tool reference](docs/tools.md): model-tool parameters and results
- [Development](docs/development.md): tests and maintenance
