import { readFile } from "node:fs/promises";
import { ledgerCases, parseLedgerAnswer, parseLedgerMarkedAnswer } from "./ledger-cases.mjs";

const path = process.argv[2];
if (!path) throw new Error("Usage: node eval/report-ledger-eval.mjs <eval/results/file.json>");
const result = JSON.parse(await readFile(path, "utf8"));
const cases = new Map(ledgerCases.map((question) => [question.id, question]));
const scoredRuns = result.runs.map((run) => {
  const questions = run.questions.map((row) => {
    const fixture = cases.get(row.id);
    if (row.expected !== fixture?.answer || row.phase !== fixture?.phase) {
      throw new Error("Stored question differs from the checked-in ledger fixture.");
    }
    return { ...row,
      marked: !row.first.error && parseLedgerMarkedAnswer(row.first.text) === row.expected,
      strict: !row.first.error && parseLedgerAnswer(row.first.text) === row.expected,
    };
  });
  const transfer = questions.filter((row) => row.phase === "transfer");
  const count = (rows, key) => rows.filter((row) => row[key]).length;
  const calls = questions.flatMap((row) => [row.first, row.feedback].flatMap((turn) => turn?.tools ?? []));
  const successful = (name) => calls.filter((call) => call.name === name && call.status === "ok").length;
  return {
    run: run.id,
    marked: `${count(questions, "marked")}/${questions.length}`,
    markedTransfer: `${count(transfer, "marked")}/${transfer.length}`,
    strict: `${count(questions, "strict")}/${questions.length}`,
    strictTransfer: `${count(transfer, "strict")}/${transfer.length}`,
    input: run.usage.input, output: run.usage.output,
    cacheRead: run.usage.cacheRead, cacheWrite: run.usage.cacheWrite,
    tokens: run.usage.totalTokens, requests: run.usage.requests, usd: run.usage.usd,
    writes: successful("memory_write"), searches: successful("memory_search"), reads: successful("memory_read"),
  };
});
console.log(JSON.stringify({ completed: result.completed, totalUsage: result.usage, runs: scoredRuns }, null, 2));
