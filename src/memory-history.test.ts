import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { SessionManager, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { createMemoryTestDirectory } from "../test/memory-fixtures.ts";
import { registerMemoryHistoryTools } from "./memory-history.ts";
import type { MemorySourcePage, MemorySourceSearchPage } from "./memory-sources.ts";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(packageRoot, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const historyTools = ["memory_history_search", "memory_history_read"] as const;

test("real Pi CLI offers foreground history tools by default but omits them with the startup flag or in a dream worker", { timeout: 30000 }, async (t) => {
  const directory = await createMemoryTestDirectory(t);
  const project = join(directory, "project");
  await mkdir(project);
  const toolProbe = join(directory, "history-probe.ts");
  await writeFile(toolProbe, `export default function historyProbe(pi) {
    pi.registerCommand("history-probe", {
      description: "Report registered and active memory tools without a model request",
      async handler() {
        const registered = pi.getAllTools().map((tool) => tool.name).filter((name) => name.startsWith("memory_"));
        const active = pi.getActiveTools().filter((name) => name.startsWith("memory_"));
        console.log("HISTORY_TOOL_PROBE " + JSON.stringify({ registered, active }));
      },
    });
  }`);
  const args = [cliPath, "--offline", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates",
    "--no-context-files", "--no-session", "--approve", "-e", packageRoot, "-e", toolProbe, "--pi-memory-no-dream"];
  for (const mode of ["default", "disabled", "worker"] as const) {
    const env = { ...process.env, PI_CODING_AGENT_DIR: join(directory, `agent-${mode}`), PI_MEMORY_DIR: join(directory, "memory"),
      PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", JITI_FS_CACHE: "false",
      PI_MEMORY_DREAM_WORKER: mode === "worker" ? "1" : "0" };
    const run = spawnSync(process.execPath,
      [...args, ...(mode === "disabled" ? ["--pi-memory-no-history"] : []), "-p", "/history-probe"],
      { cwd: project, env, encoding: "utf8", timeout: 10000 });
    assert.equal(run.status, 0, `${mode}: ${run.stderr || run.error?.message}`);
    const probe = /^HISTORY_TOOL_PROBE (.*)$/m.exec(run.stdout + run.stderr);
    assert.ok(probe, `${mode}: stdout=${run.stdout}, stderr=${run.stderr}`);
    const { registered, active } = JSON.parse(probe[1]!);
    const expected = ["memory_search", "memory_read", "memory_write", ...(mode === "default" ? historyTools : [])].sort();
    assert.deepEqual(registered.sort(), expected, `${mode}: complete registered set`);
    assert.deepEqual(active.sort(), expected, `${mode}: tools offered to the model`);
  }
});

async function historyFixture(t: TestContext) {
  const directory = await createMemoryTestDirectory(t);
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  const sessionsRoot = join(agentDir, "sessions");
  const customRoot = join(directory, "custom-sessions");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(sessionsRoot, { recursive: true });
  await mkdir(customRoot);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const sessionManager = SessionManager.create(cwd, customRoot);
  let trusted = true;
  const ctx = { cwd, sessionManager, isProjectTrusted: () => trusted } as unknown as Parameters<ToolDefinition["execute"]>[4];
  const tools = new Map<string, ToolDefinition>();
  registerMemoryHistoryTools({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  assert.deepEqual([...tools.keys()], historyTools);
  async function call<T>(name: typeof historyTools[number], args: Record<string, unknown>): Promise<T> {
    const tool = tools.get(name)!;
    assert.ok(Value.Check(tool.parameters, args));
    const result = await tool.execute("history-test-call", args, undefined, undefined, ctx);
    const text = result.content[0];
    assert.ok(text?.type === "text");
    assert.ok(Buffer.byteLength(text.text) <= 50 * 1024);
    return JSON.parse(text.text);
  }
  function writeSyntheticSession(project: string, sessionDir: string, content: string) {
    const session = SessionManager.create(project, sessionDir);
    const entryId = session.appendMessage({ role: "user", content, timestamp: Date.now() });
    return { sessionId: session.getSessionId(), id: `${session.getSessionId()}:${entryId}:0` };
  }
  return { directory, cwd, sessionsRoot, customRoot, sessionManager, call, writeSyntheticSession,
    revokeTrust: () => { trusted = false; } };
}

test("history searches and reads synthetic sessions from both roots while refusing other projects", async (t) => {
  const f = await historyFixture(t);
  const subdirectory = join(f.cwd, "subdirectory");
  const foreignProject = join(f.directory, "foreign-project");
  await mkdir(subdirectory);
  await mkdir(foreignProject);
  const longText = "orbit observation " + "🪐".repeat(2500);
  const sameProject = f.writeSyntheticSession(subdirectory, f.sessionsRoot, longText);
  const custom = f.writeSyntheticSession(f.cwd, f.customRoot, "orbit calibration");
  const foreign = f.writeSyntheticSession(foreignProject, f.sessionsRoot, "orbit FOREIGN_CANARY");
  const hits = await f.call<MemorySourceSearchPage>("memory_history_search", { query: "orbit" });
  assert.deepEqual(hits.sources.map((source) => source.id).sort(), [sameProject.id, custom.id].sort());
  assert.ok(!JSON.stringify(hits).includes("FOREIGN_CANARY"));
  const filtered = await f.call<MemorySourceSearchPage>("memory_history_search", { query: "orbit", sessionId: sameProject.sessionId });
  assert.deepEqual(filtered.sources.map((source) => source.id), [sameProject.id]);
  const page = await f.call<MemorySourcePage>("memory_history_read", { id: filtered.sources[0]!.id });
  assert.equal(page.hash, filtered.sources[0]!.hash);
  assert.equal(page.startCharacter, 0);
  assert.ok(page.nextCharacter !== null);
  assert.ok(Buffer.byteLength(page.text) <= 8192);
  const rest = await f.call<MemorySourcePage>("memory_history_read", { id: page.id, startCharacter: page.nextCharacter });
  assert.equal(rest.nextCharacter, null);
  assert.equal(page.text + rest.text, longText);
  await assert.rejects(f.call("memory_history_read", { id: foreign.id }), /unavailable on the selected same-project branch/);
});

test("each history call checks current project trust before accessing the session manager", async (t) => {
  const f = await historyFixture(t);
  f.revokeTrust();
  t.mock.method(f.sessionManager, "getSessionDir", () => assert.fail("Must not access untrusted session roots"));
  t.mock.method(f.sessionManager, "getBranch", () => assert.fail("Must not read untrusted current session"));
  await assert.rejects(f.call("memory_history_search", { query: "orbit" }), /requires Pi project trust/);
  await assert.rejects(f.call("memory_history_read", { id: "session:entry:0" }), /requires Pi project trust/);
});

test("history tools observe the live current-session branch on each call", async (t) => {
  const f = await historyFixture(t);
  const session = f.sessionManager;
  const append = (content: string) => session.appendMessage({ role: "user", content, timestamp: Date.now() });
  const ancestor = append("shared root");
  append("orbit abandoned branch");
  const search = () => f.call<MemorySourceSearchPage>("memory_history_search", { query: "orbit" });
  const first = await search();
  assert.deepEqual(first.sources.map((source) => source.preview), ["orbit abandoned branch"]);
  session.branch(ancestor);
  append("orbit replacement branch");
  const next = await search();
  assert.deepEqual(next.sources.map((source) => source.preview), ["orbit replacement branch"]);
  await assert.rejects(f.call("memory_history_read", { id: first.sources[0]!.id }), /unavailable on the selected same-project branch/);
});
