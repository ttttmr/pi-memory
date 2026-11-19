const bySum = (rows) => rows.reduce((sum, [units]) => sum + units, 0);
const usd = (units) => units / 20;
const posted = (flag) => flag !== "R";
const partner = (route) => route === "K3" || route === "N8";

const dollarsRule = "In this dashboard, each exported charge unit is USD 0.05. Sum the charge units and divide by 20 for dollars; do not use the usual cents conversion.";
const postedRule = "For Posted counts, exclude flag R (retracted). Flags N and H both count, even though H means the transaction has an internal hold.";
const partnerRule = "Partner means either route K3 or route N8. Both codes are active partner channels; K1 is direct, not partner.";
const dateRule = "The dashboard reads export dates as DD/MM/YYYY, so the first component is the day and the second is the month.";

const cases = [
  {
    id: "01", phase: "first", headers: ["charge_units"],
    question: "What is the Gross Charge total for these rows, in USD?",
    rows: [[1270], [465], [225]],
    expected: (rows) => usd(bySum(rows)), rule: dollarsRule,
  },
  {
    id: "02", phase: "first", headers: ["txn", "flag"],
    question: "How many transactions appear in the Posted count?",
    rows: [["T10", "R"], ["T11", "H"], ["T12", "N"], ["T13", "H"], ["T14", "N"], ["T15", "N"]],
    expected: (rows) => rows.filter(([, flag]) => posted(flag)).length, rule: postedRule,
  },
  {
    id: "03", phase: "first", headers: ["txn", "route"],
    question: "How many transactions are in the Partner count?",
    rows: [["T20", "K3"], ["T21", "N8"], ["T22", "K1"], ["T23", "K3"], ["T24", "K1"], ["T25", "N8"]],
    expected: (rows) => rows.filter(([, route]) => partner(route)).length, rule: partnerRule,
  },
  {
    id: "04", phase: "first", headers: ["txn", "filed_on"],
    question: "How many transactions were filed on March 6, 2024?",
    rows: [["T30", "06/03/2024"], ["T31", "03/06/2024"], ["T32", "06/03/2024"], ["T33", "06/02/2024"], ["T34", "06/03/2024"]],
    expected: (rows) => rows.filter(([, date]) => date === "06/03/2024").length, rule: dateRule,
  },
  {
    id: "05", phase: "transfer", headers: ["txn", "filed_on"],
    question: "How many transactions were filed on April 9, 2025?",
    rows: [["T40", "04/09/2025"], ["T41", "09/04/2025"], ["T42", "04/09/2025"], ["T43", "04/09/2025"], ["T44", "09/05/2025"]],
    expected: (rows) => rows.filter(([, date]) => date === "09/04/2025").length, rule: dateRule,
  },
  {
    id: "06", phase: "transfer", headers: ["txn", "route"],
    question: "How many transactions are in the Partner count?",
    rows: [["T50", "N8"], ["T51", "K1"], ["T52", "N8"], ["T53", "N8"], ["T54", "K3"], ["T55", "N8"], ["T56", "K1"]],
    expected: (rows) => rows.filter(([, route]) => partner(route)).length, rule: partnerRule,
  },
  {
    id: "07", phase: "transfer", headers: ["txn", "flag"],
    question: "How many transactions appear in the Posted count?",
    rows: [["T60", "H"], ["T61", "R"], ["T62", "H"], ["T63", "R"], ["T64", "N"], ["T65", "R"]],
    expected: (rows) => rows.filter(([, flag]) => posted(flag)).length, rule: postedRule,
  },
  {
    id: "08", phase: "transfer", headers: ["charge_units"],
    question: "What is the Gross Charge total for these rows, in USD?",
    rows: [[87], [160], [4], [986]],
    expected: (rows) => usd(bySum(rows)), rule: dollarsRule,
  },
  {
    id: "09", phase: "transfer", headers: ["txn", "flag", "route"],
    question: "How many of the Partner transactions are included in the Posted count?",
    rows: [["T80", "R", "N8"], ["T81", "N", "N8"], ["T82", "H", "K3"], ["T83", "R", "K3"], ["T84", "N", "K1"], ["T85", "H", "N8"], ["T86", "H", "K1"]],
    expected: (rows) => rows.filter(([, flag, route]) => posted(flag) && partner(route)).length,
    rule: `${partnerRule} ${postedRule}`,
  },
  {
    id: "10", phase: "transfer", headers: ["charge_units", "filed_on"],
    question: "What is the Gross Charge total in USD for transactions filed in February 2026?",
    rows: [[457, "03/02/2026"], [918, "02/03/2026"], [246, "02/02/2026"], [84, "06/02/2026"], [170, "02/06/2026"], [245, "02/02/2025"]],
    expected: (rows) => usd(bySum(rows.filter(([, date]) => date.endsWith("/02/2026")))),
    rule: `${dateRule} ${dollarsRule}`,
  },
];

/** Synthetic ledger prompts and authoritative feedback; only the CSVs are copied into the model's project. */
export const ledgerCases = cases.map(({ id, phase, headers, question, rows, expected, rule }) => {
  const filename = `ledger-${id}.csv`;
  const answer = expected(rows);
  return {
    id, phase, filename, answer,
    csv: [headers, ...rows].map((row) => row.join(",")).join("\n") + "\n",
    prompt: `Use the raw ledger export ${filename} to answer this question about the internal Northstar dashboard. Tools are available if needed. If the export is ambiguous, give your best estimate.\n\n${question}\n\nReply on one line as ANSWER: <number> (digits and optionally a decimal point, no currency symbol).`,
    feedback: `Dashboard reconciliation: the authoritative answer is ${answer}. ${rule}`,
  };
});

/** Parse the predeclared answer format, allowing whitespace and one plain Markdown wrapper. */
export function parseLedgerAnswer(text) {
  const match = text.trim().replace(/^(\*\*|`)([^\n]+)\1$/, "$2")
    .match(/^ANSWER:\s*(\d+(?:\.\d+)?)$/i);
  return match ? Number(match[1]) : null;
}

/** Grade an unambiguous marked answer without penalizing surrounding explanation. */
export function parseLedgerMarkedAnswer(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => /^(?:\*\*|`)?\s*ANSWER\s*:/i.test(line));
  return lines.length === 1 ? parseLedgerAnswer(lines[0]) : null;
}
