import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RpcClient } from "@earendil-works/pi-coding-agent";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import { createMemoryStoreHandle, readMemoryNote } from "./memory-store.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = resolve(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");

test("real Pi CLI loads Markdown package and shows empty memory usage offline with isolated configuration", async (ctx) => {
  const directory = await createMemoryTestDirectory(ctx);
  const project = join(directory, "project");
  await mkdir(project);
  const agentDir = join(directory, "agent");
  const root = join(directory, "memory");
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_MEMORY_DIR: root,
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", JITI_FS_CACHE: "false" };
  const args = [cliPath, "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates",
    "--no-context-files", "--no-session", "--approve", "-e", packageRoot];
  const help = spawnSync(process.execPath, [...args, "--help"], { cwd: project, env, encoding: "utf8", timeout: 15000 });
  assert.equal(help.status, 0, help.stderr || help.error?.message);
  assert.match(help.stdout + help.stderr, /--pi-memory-no-recall/);
  assert.match(help.stdout + help.stderr, /--pi-memory-no-dream/);
  const usage = spawnSync(process.execPath, [...args, "-p", "/memory"], { cwd: project, env, encoding: "utf8", timeout: 15000 });
  assert.equal(usage.status, 0, usage.stderr || usage.error?.message);
  assert.match(usage.stdout + usage.stderr, /Usage: \/memory <what to remember>/);
  assert.ok(!(await readdir(directory)).includes("memory"), "Empty command creates no memory library and starts no model turn");
  assert.ok(!(await readdir(agentDir)).includes("sessions"), "--no-session never persists a session");
});


for (const busy of [false, true]) {
  test(`real Pi RPC memory ${busy ? "busy follow-up" : "idle request"} completes scripted writes and fresh-session recall without network`, { timeout: 15000 }, async (ctx) => {
    const directory = await createMemoryTestDirectory(ctx);
    const project = join(directory, "project");
    await mkdir(project);
    const agentDir = join(directory, "agent");
    const root = join(directory, "memory");
    const trace = join(directory, "provider-trace.jsonl");
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_MEMORY_DIR: root, PI_MEMORY_TEST_TRACE: trace,
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", JITI_FS_CACHE: "false" };
    const args = ["--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates",
      "--no-context-files", "--no-session", "--approve", "-e", packageRoot,
      "-e", join(packageRoot, "test/memory-cli-provider.ts"), "--pi-memory-no-dream"];
    const client = new RpcClient({ cliPath, cwd: project, env, args, provider: "memory-cli-test", model: "scripted" });
    ctx.after(() => client.stop());
    await client.start();
    const commands = await client.getCommands();
    assert.ok(commands.some((command) => command.name === "memory"));
    assert.ok(!commands.some((command) => command.name === "pi-memory"));
    const events = client.collectEvents(5000);
    if (busy) {
      const streaming = new Promise<void>((resolve) => {
        const unsubscribe = client.onEvent((event) => {
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            unsubscribe();
            resolve();
          }
        });
      });
      assert.equal(await client.prompt("SYNTHETIC_BUSY_TASK"), "started");
      await streaming;
    }
    assert.equal(await client.prompt("/memory Prefer concise fixture responses."), "handled",
      "Slash dispatch is handled, but its emitted user request starts a separate foreground run");
    await events;
    assert.equal(await client.getLastAssistantText(), "SYNTHETIC_MEMORY_SAVED");
    if (busy) {
      const messages = await client.getMessages();
      const busyResponse = messages.findIndex((message) => message.role === "assistant" &&
        JSON.stringify(message.content).includes("SYNTHETIC_BUSY_FINISHED"));
      const request = messages.findIndex((message) => message.role === "user" &&
        JSON.stringify(message.content).includes("Remember this for future turns and sessions"));
      assert.ok(busyResponse >= 0 && request > busyResponse, "The memory request follows the completed busy response, without steering or aborting it");
    }
    const handle = createMemoryStoreHandle(root, project, "project");
    assert.equal((await readMemoryNote(handle, "preferences.md"))?.content, "Prefer concise fixture responses.");
    assert.match((await readMemoryNote(handle, "MEMORY.md"))?.content ?? "", /preferences.md/);
    assert.equal((await client.newSession()).cancelled, false);
    await client.promptAndWait("An unrelated fresh session question", undefined, 5000);
    assert.equal(await client.getLastAssistantText(), "SYNTHETIC_INDEX_RECALLED");
    const calls = (await readFile(trace, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, busy ? 4 : 3);
    assert.equal(calls[busy ? 1 : 0].prompt, "Remember this for future turns and sessions using the memory tools:\n\nPrefer concise fixture responses.");
    assert.ok(!(await readdir(agentDir)).includes("sessions"), "Both invocations use ephemeral sessions");
  });
}
