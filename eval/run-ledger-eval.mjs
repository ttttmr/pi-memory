import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LedgerEvalRpcClient } from "./ledger-rpc-client.mjs";
import { ledgerCases, parseLedgerAnswer } from "./ledger-cases.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const cliPath = join(repo, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const provider = "magpie";
const model = "openrouter/anthropic/claude-sonnet-5.5";
const api = "anthropic-messages";
const thinking = "low";
const pricePerMillion = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
const maxOutputTokens = 2048;
const reportedBudgetUsd = 4;
const settleTimeoutMs = 75_000;
const runOrder = ["memory-1", "baseline-1", "baseline-2", "memory-2"];
const memoryTools = ["memory_search", "memory_read", "memory_write"];
const usageFields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "requests", "usd"];

function sumLedgerUsage(records) {
  return Object.fromEntries(usageFields.map((key) => [key, records.reduce((sum, record) => sum + (record[key] ?? 0), 0)]));
}

function reportMessageUsage(usage) {
  return { ...Object.fromEntries(usageFields.slice(0, 5).map((key) => [key, usage?.[key] ?? 0])),
    requests: 1, usd: usage?.cost?.total ?? 0 };
}

async function readProviderConnection() {
  const authFile = process.env.PI_MEMORY_EVAL_AUTH_FILE;
  let baseUrl = process.env.PI_MEMORY_EVAL_BASE_URL;
  let key = process.env.PI_MEMORY_EVAL_API_KEY;
  if (authFile) {
    if (baseUrl || key) throw new Error("Use PI_MEMORY_EVAL_AUTH_FILE or the endpoint/key variables, not both.");
    const auth = JSON.parse(await readFile(authFile, "utf8"))[provider];
    if (auth?.type !== "api_key" || typeof auth.key !== "string" || auth.key.startsWith("!")) {
      throw new Error("The specified auth file does not contain an inline Magpie API key.");
    }
    baseUrl = auth.env?.MAGPIE_BASE_URL;
    key = auth.key;
  }
  if (!baseUrl || !key) throw new Error("Set PI_MEMORY_EVAL_BASE_URL and PI_MEMORY_EVAL_API_KEY or PI_MEMORY_EVAL_AUTH_FILE.");
  const url = new URL(baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash) throw new Error("The Magpie base URL must be clean HTTPS or loopback HTTP.");
  return { key, baseUrl: url.href.replace(/\/+$/, "").replace(/\/v1$/, "") };
}

async function snapshotMemorySource(scratch, ref) {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const revision = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`).trim();
  const directory = join(scratch, "extension");
  const modules = git("ls-tree", "-r", "--name-only", revision, "src").trim().split("\n")
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts"));
  const digest = createHash("sha256");
  for (const file of ["package.json", ...modules]) {
    const content = git("show", `${revision}:${file}`);
    digest.update(`${file}\0${content}\0`);
    const target = join(directory, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await symlink(join(repo, "node_modules"), join(directory, "node_modules"), "dir");
  return { revision, sourceSha256: digest.digest("hex"), entrypoint: join(directory, "src/memory-extension.ts") };
}

async function readActiveNotes(root, sanitize) {
  const notes = [];
  async function visit(current, prefix) {
    const files = await readdir(current, { withFileTypes: true }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return [];
    });
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, [...prefix, entry.name]);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        const [scope, ...directories] = prefix;
        notes.push({ scope: scope === "global" ? "global" : "project", path: sanitize(join(...directories, entry.name)),
          content: sanitize(await readFile(path, "utf8")) });
      }
    }
  }
  await visit(root, []);
  return notes;
}

function summarizeToolTrace(events, sanitize) {
  const completions = new Map(events.filter((event) => event.type === "tool_execution_end")
    .map((event) => [event.toolCallId, event]));
  return events.filter((event) => event.type === "tool_execution_start").map((event) => {
    const { toolName: name, args } = event;
    const completion = completions.get(event.toolCallId);
    const isRead = name === "read";
    const path = typeof args?.path === "string" ? sanitize(isRead ? basename(args.path) : args.path) : undefined;
    const query = name === "memory_search" && typeof args?.query === "string" ? sanitize(args.query) : undefined;
    return { name, path, query, scope: args?.scope, action: name === "memory_write" ? args?.action ?? "upsert" : undefined,
      status: !completion ? "unfinished" : completion.isError ? "error" : "ok" };
  });
}

async function evaluateLedgerTurn(client, prompt, budget, sanitize) {
  let abort;
  const usage = [];
  const unsubscribe = client.onEvent((event) => {
    if (event.type !== "message_end" || event.message.role !== "assistant") return;
    const sample = reportMessageUsage(event.message.usage);
    usage.push(sample);
    budget.total += sample.usd;
    if (budget.total >= reportedBudgetUsd && !abort) abort = client.request("abort").catch(() => {});
  });
  try {
    const events = await client.promptAndWait(prompt, settleTimeoutMs);
    const settled = events.at(-1);
    if (settled?.type !== "agent_settled") throw new Error("RPC turn did not reach agent_settled.");
    const assistants = events.filter((event) => event.type === "message_end" && event.message.role === "assistant")
      .map((event) => event.message);
    const last = assistants.at(-1);
    const result = {
      usage: sumLedgerUsage(usage), tools: summarizeToolTrace(events, sanitize),
      stopReason: last?.stopReason,
      error: abort ? "Pi-reported cost budget reached" : settled.aborted ? "RPC turn aborted"
        : !last ? "RPC turn had no assistant response"
        : last.stopReason === "error" || last.stopReason === "aborted" ? sanitize(last.errorMessage ?? "Model request failed") : undefined,
      text: sanitize(last?.content.filter((block) => block.type === "text").map((block) => block.text).join("\n") ?? ""),
    };
    return result;
  } catch (error) {
    return { usage: sumLedgerUsage(usage), tools: [], error: sanitize(error.message) };
  } finally {
    unsubscribe();
    await abort;
  }
}

async function evaluateLedgerRun(run, client, memoryRoot, preflight, budget, sanitize, checkpoint) {
  activeClient = client;
  try {
    client.start();
    const state = await client.request("get_state");
    if (state.model?.provider !== provider || state.model?.id !== model || state.thinkingLevel !== thinking || state.sessionFile) {
      throw new Error("RPC model, thinking, or session setting differs from the evaluation configuration.");
    }
    const { commands } = await client.request("get_commands");
    if (commands.some(({ name }) => name === "memory") !== (run.condition === "memory")) {
      throw new Error("RPC memory availability differs from the evaluation condition.");
    }
    if (preflight) return;
    await client.request("set_auto_compaction", { enabled: false });
    await client.request("set_auto_retry", { enabled: false });
    let priorSessionId;
    for (const question of ledgerCases) {
      if (interrupted) throw new Error("Ledger evaluation interrupted.");
      if (priorSessionId) {
        if ((await client.request("new_session")).cancelled) throw new Error("RPC refused to start a fresh session.");
      }
      const { sessionId } = await client.request("get_state");
      const { messages } = await client.request("get_messages");
      if (!sessionId || sessionId === priorSessionId || messages.length !== 0) {
        throw new Error("The question did not start in a fresh session.");
      }
      priorSessionId = sessionId;
      const first = await evaluateLedgerTurn(client, question.prompt, budget, sanitize);
      const parsed = first.error ? null : parseLedgerAnswer(first.text);
      const row = { id: question.id, phase: question.phase, expected: question.answer, parsed,
        correct: parsed === question.answer, first };
      run.questions.push(row);
      if (!first.error && !interrupted) {
        row.feedback = await evaluateLedgerTurn(client, question.feedback, budget, sanitize);
        delete row.feedback.text; // Retain outcomes and tool traces, not routine acknowledgements.
      }
      await checkpoint();
      const error = first.error ?? row.feedback?.error;
      console.log(`${run.id} Q${question.id}: ${error ? "error" : row.correct ? "correct" : "incorrect"}; cumulative $${budget.total.toFixed(4)} (Pi estimate)`);
      if (error) throw new Error(`${run.id} Q${question.id}: ${error}`);
      if (interrupted) throw new Error("Ledger evaluation interrupted.");
    }
  } finally {
    await client.stop();
    activeClient = undefined;
    if (!preflight) run.finalNotes = await readActiveNotes(memoryRoot, sanitize);
  }
}

const { values } = parseArgs({ options: {
  revision: { type: "string", default: "HEAD" },
  preflight: { type: "boolean" },
  live: { type: "boolean" },
} });
if (Boolean(values.live) === Boolean(values.preflight)) throw new Error("Choose --preflight (no model calls) or --live (paid).");
const { key, baseUrl } = await readProviderConnection();
const scratch = await realpath(await mkdtemp(join(tmpdir(), "pi-memory-eval-")));
const sanitize = (value) => String(value).replaceAll(key, "[credential]").replaceAll(baseUrl, "[endpoint]")
  .replaceAll(scratch, "[eval-temp]").replaceAll(realpathHome, "[home]").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
const realpathHome = await realpath(homedir());
const budget = { total: 0 };
const startedAt = new Date().toISOString();
const resultsDirectory = join(repo, "eval/results");
const resultName = `${startedAt.replaceAll(":", "-")}.json`;
const results = { startedAt, provider, model, api, thinking, pricePerMillion, maxOutputTokens, reportedBudgetUsd,
  protocol: "pi-rpc", piVersion: "1.5.0", nodeVersion: process.version, platform: process.platform,
  completed: false, runs: [] };
const checkpoint = async () => {
  if (values.preflight) return;
  for (const run of results.runs) {
    run.correct = run.questions.filter((row) => row.correct).length;
    run.correctTransfer = run.questions.filter((row) => row.correct && row.phase === "transfer").length;
    run.usage = sumLedgerUsage(run.questions.flatMap((row) => [row.first.usage, row.feedback?.usage].filter(Boolean)));
  }
  results.usage = sumLedgerUsage(results.runs.map((run) => run.usage));
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(join(resultsDirectory, resultName), JSON.stringify(results, null, 2) + "\n", { mode: 0o600 });
};
let activeClient;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  interrupted = true;
  void activeClient?.request("abort").catch(() => {});
});
try {
  const { revision, sourceSha256, entrypoint } = await snapshotMemorySource(scratch, values.revision);
  Object.assign(results, { revision, sourceSha256 });
  const agentDir = join(scratch, "agent");
  const homeDir = join(scratch, "home");
  await mkdir(agentDir, { mode: 0o700 });
  await mkdir(homeDir, { mode: 0o700 });
  const installed = JSON.parse(await readFile(join(dirname(dirname(cliPath)), "package.json"), "utf8")).version;
  if (installed !== results.piVersion) throw new Error(`This evaluation expects Pi ${results.piVersion}; found ${installed}.`);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "off", enableInstallTelemetry: false }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: {
    baseUrl, api, apiKey: "$PI_MEMORY_EVAL_API_KEY", authHeader: true,
    models: [{ id: model, reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: maxOutputTokens,
      cost: pricePerMillion, compat: { forceAdaptiveThinking: true } }],
  } } }), { mode: 0o600 });
  for (const id of values.preflight ? runOrder.slice(0, 2) : runOrder) {
    const condition = id.startsWith("memory-") ? "memory" : "baseline";
    const run = { id, condition, questions: [] };
    results.runs.push(run);
    const project = join(scratch, id);
    const memoryRoot = join(scratch, `store-${id}`);
    await mkdir(project);
    await Promise.all(ledgerCases.map(({ filename, csv }) => writeFile(join(project, filename), csv)));
    const tools = condition === "memory" ? ["read", ...memoryTools] : ["read"];
    const args = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
      "--no-context-files", "--no-mcp", "--no-session", "--approve", "--thinking", thinking,
      "--tools", tools.join(","), "-e", join(repo, "eval/ledger-read-guard.ts")];
    if (condition === "memory") args.push("-e", entrypoint, "--pi-memory-no-dream");
    if (interrupted) throw new Error("Ledger evaluation interrupted.");
    const client = new LedgerEvalRpcClient({ cliPath, cwd: project, provider, model, args, env: {
      HOME: homeDir, XDG_CONFIG_HOME: join(homeDir, ".config"), XDG_CACHE_HOME: join(homeDir, ".cache"),
      PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", JITI_FS_CACHE: "false",
      PI_CODING_AGENT_DIR: agentDir, PI_MEMORY_DIR: memoryRoot, PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
      PI_MEMORY_EVAL_API_KEY: key,
    } });
    await evaluateLedgerRun(run, client, memoryRoot, values.preflight, budget, sanitize, checkpoint);
    await checkpoint();
    if (values.preflight) console.log(`${condition}: isolated RPC loaded without calling the model.`);
  }
  results.completed = true;
} catch (error) {
  results.error = sanitize(error.message);
  console.error(results.error);
  process.exitCode = 1;
} finally {
  try {
    await checkpoint();
    if (!values.preflight) console.log(`Result: eval/results/${resultName}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
