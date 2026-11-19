# Ledger memory evaluation

Does pi-memory help a real Pi model apply a reporting rule it learned in another session? This small synthetic comparison borrows the feedback loop from Anthropic's [CL-Bench database example](https://www.anthropic.com/research/components-of-agent-memory). It does not reproduce that benchmark or validate its reported gains.

## Task and controls

[The fixture](ledger-cases.mjs) defines ten CSV exports, questions, numeric answers, and authoritative feedback. Questions 1 through 4 each introduce one dashboard convention: charge units, posted flags, partner codes, or date order. Questions 5 through 8 use new rows to exercise those conventions, and questions 9 and 10 combine them. The CSVs contain raw values, not the reporting rules, so some first encounters cannot be resolved from the data alone.

Both conditions receive the same prompts and the same feedback, even after a correct answer. Each scored question starts in a fresh `--no-session` RPC session; in that session the runner waits for `agent_settled` after the answer, gives feedback, then waits for settlement again. The prompt does not tell the model to save, search or recall memory. The extension supplies its normal tool descriptions and guidance.

- **Baseline:** no pi-memory extension. The only model-facing tool is `read`, restricted to the synthetic CSVs by [a guard](ledger-read-guard.ts) shared by both conditions.
- **Memory:** the same `read` tool plus the three pi-memory tools. Index recall is on and dreaming is off. Each repetition starts with a separate empty memory store that persists across its ten sessions.

Run order is memory 1, baseline 1, baseline 2, memory 2. Both conditions use the same files and fixed question order. Pi uses a temporary config, home, project, and memory directory. The runner snapshots the requested Git commit before launch, disables other resources, and allows no shell, editor or write tool. The paid endpoint receives only the synthetic task and ordinary Pi context for the temporary project, not real project or session materials. Scratch files are removed on normal exit or handled interruption. This is a test configuration, not an OS sandbox.

## Scoring and evidence

Grade only the answer before feedback. Report both all ten questions and the six transfer questions separately. The initial exact-format scorer requires the whole reply to be a single `ANSWER: <number>` line (one Markdown wrapper is allowed). The model sometimes supplied an explanation plus an unambiguous answer line; the result summary therefore also gives numeric correctness from a single valid `ANSWER:` line anywhere in the first reply. This second measure was added after observing the formatting issue and is applied uniformly to the raw replies. Neither scorer picks among multiple marked answers or guesses the intended result from prose.

The JSON trace stores first replies, tool calls and their statuses, final active notes, and usage summarized from completed assistant `message_end` events. A successful write is a tool receipt; persisted Markdown is reported separately. An explicit `memory_search` or `memory_read` appears in the trace. Automatic index recall need not trigger either tool, so tool counts alone do not measure recall.

## Re-run

Requires the repository's locked Pi 1.5.0 development dependency and Node.js 22.19 or later. These commands use a Magpie account that can serve `openrouter/anthropic/claude-sonnet-5.5` through the Anthropic Messages API:

```bash
npm ci --ignore-scripts
node --test eval/ledger-cases.test.mjs
export PI_MEMORY_EVAL_AUTH_FILE=/path/to/test-auth.json
node eval/run-ledger-eval.mjs --preflight
node eval/run-ledger-eval.mjs --live --revision 816b8870440bd2cc7b58b4592b16af0e1883b764
```

The auth-file option extracts the `magpie` entry (`type: "api_key"`, inline `key` and `env.MAGPIE_BASE_URL`); it does not copy the file. Alternatively supply `PI_MEMORY_EVAL_BASE_URL` and `PI_MEMORY_EVAL_API_KEY` from a secret manager. The key is passed to the isolated Pi process via an environment variable, not in argv or a temporary credential file. Use a trusted endpoint and an account authorized to send this synthetic material. `--preflight` verifies both CLI configurations without prompting the model. `--live` sends paid requests and writes `eval/results/<UTC timestamp>.json`.

The model uses `low` thinking, with a 2,048-token output cap per request. Automatic retries, compaction and cache warming are disabled. Pi estimates USD from the endpoint's rates at the time of the run ($2 input, $10 output, $0.10 cache read, $2.50 cache write per million tokens). The runner stops at $4 of reported spending, with room under the approximately $5 trial budget for in-flight work. This is a guard based on emitted usage, not a gateway billing limit or invoice. Inspect the approved account's actual billing separately.

## Recorded run: 2026-11-19 UTC

[Raw result](results/2026-11-19T06-40-52.490Z.json), from pi-memory commit `816b8870440bd2cc7b58b4592b16af0e1883b764` and Node.js 24.21.0 on macOS. Later source changes are not covered. Recompute the table with:

```bash
node eval/report-ledger-eval.mjs eval/results/2026-11-19T06-40-52.490Z.json
```

| Run | Correct marked answers | Transfer only | Pi tokens (incl. cache) | Model responses | Pi estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| Memory 1 | 6/10 | 5/6 | 136,602 | 41 | $0.1052 |
| Baseline 1 | 2/10 | 1/6 | 49,941 | 30 | $0.0633 |
| Baseline 2 | 2/10 | 1/6 | 49,477 | 30 | $0.0607 |
| Memory 2 | 7/10 | 6/6 | 117,992 | 37 | $0.0878 |
| **Total usage** | | | **354,012** | **138** | **$0.3170** |

All four runs scored 1/4 on first encounters. On transfer questions, memory scored 11/12 and baseline 2/12. Strict-format scores were 0/10 for every run: all 40 first replies included explanatory text despite the one-line request. All had a single marked answer.

Memory 1 made six successful writes and 15 searches. It used separate notes, retrieved rules from search excerpts without calling `memory_read`, and missed the dollar conversion transfer in Q8 after not saving the Q1 correction. After Q8 it saved that rule and applied it in Q10. Memory 2 made four writes to one cumulative note, 10 searches, and three explicit reads. In both repetitions, the persisted notes accurately recorded all four rules. Neither created `MEMORY.md`, so this result demonstrates tool-based retrieval, not automatic index recall. The traces also contain redundant writes and searches; the memory condition used more tokens and model responses than baseline.

## Limits

Two repetitions on one synthetic task and one model are too few to estimate a general improvement. The task is intentionally feedback-dependent and favors method reuse; it does not measure work where correct rules already exist in a repository or help desk. Scoring checks numeric outputs, not independent calibration or how models recover from misleading feedback. The marked-line score was added after observing answers, not specified in advance. Tool access and index recall were both enabled in memory runs, but no index was created. This evaluation does not test index-only recall, dreaming, source-history search, long-horizon maintenance, other models, or an interactive TUI.
