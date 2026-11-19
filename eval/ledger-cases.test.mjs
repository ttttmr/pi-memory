import assert from "node:assert/strict";
import { test } from "node:test";
import { ledgerCases, parseLedgerAnswer, parseLedgerMarkedAnswer } from "./ledger-cases.mjs";

test("ledger fixture matches independently hand-checked totals", () => {
  assert.deepEqual(ledgerCases.map(({ answer }) => answer), [98, 5, 4, 3, 1, 5, 3, 61.85, 3, 39.35]);
  assert.deepEqual(ledgerCases.map(({ phase }) => phase), [...Array(4).fill("first"), ...Array(6).fill("transfer")]);
  for (const { filename, csv, prompt, answer, feedback } of ledgerCases) {
    assert.match(filename, /^ledger-\d{2}\.csv$/);
    assert.ok(prompt.includes(filename));
    assert.ok(feedback.startsWith(`Dashboard reconciliation: the authoritative answer is ${answer}.`));
    const lines = csv.trimEnd().split("\n");
    assert.ok(lines.every((line) => line.split(",").length === lines[0].split(",").length));
  }
});

test("ledger grading is numeric but rejects an ambiguous or nonconforming answer", () => {
  assert.equal(parseLedgerAnswer("ANSWER: 61.850\n"), 61.85);
  assert.equal(parseLedgerAnswer("**ANSWER: 3**"), 3);
  assert.equal(parseLedgerAnswer("`answer: 3`"), 3);
  assert.equal(parseLedgerAnswer("ANSWER: $3"), null);
  assert.equal(parseLedgerAnswer("ANSWER: 3\nANSWER: 5"), null);
  assert.equal(parseLedgerAnswer("Probably 3 or 5"), null);
});

test("marked grading accepts an explanation but not two answer lines", () => {
  assert.equal(parseLedgerMarkedAnswer("Three match.\n\nANSWER: 3\n"), 3);
  assert.equal(parseLedgerMarkedAnswer("**ANSWER: 5**\nAn explanation."), 5);
  assert.equal(parseLedgerMarkedAnswer("ANSWER: 3\nANSWER: unknown"), null);
  assert.equal(parseLedgerMarkedAnswer("Probably 3 or 5"), null);
});
