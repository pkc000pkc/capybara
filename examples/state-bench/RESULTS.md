# Local STATE-Bench results

All results in this file are local, non-official development measurements. They used an
OpenAI-compatible proxy for the agent, simulator, and judge traffic and were not submitted to the
STATE-Bench leaderboard.

## Execution record

| Field | Value |
| --- | --- |
| Benchmark | STATE-Bench `0.8.1`, commit `5644b1838d96bc4483da29642d058ecaa6f80f7f` |
| Capybara snapshot | `d6a8e15e963201ed660ee9e44abccffed2466a98` for the bounded-memory smoke |
| Agent | `gpt-5.6-luna` |
| Simulator / task judge / UX judge | `gpt-5.4` / `gpt-5.4` / `gpt-5.4` |
| Evaluation client | OpenAI-compatible Responses proxy, not the official Azure client |
| Training backend | `http://127.0.0.1:3005` |
| Runtime | Windows, Python 3.12, `uv`; Capybara backend on Node.js 22+ |
| Memory selector | top-k `2`, maximum `450` estimated tokens per loop and `1,200` per run |
| Training memory capacity | `24` general entries, `48` entries per domain |
| Correction policy | fresh clean retry; script accepts `0`, `3`, `4`, or `5` correction attempts |
| Technical retry policy | `2` transient client/scoring retries by default |
| Official submission flag | `official_submission_eligible=false` |

The target official plan is 50 evaluation tasks per domain with five runs per task, for 750
trajectories across travel, customer support, and shopping assistant. The records below are
preflight/smoke runs and do not report pass^5.

Token usage was recorded by an append-only `token_usage.jsonl` ledger. Each event includes the model
role, request kind, response status, elapsed seconds, input/cached-input/output/reasoning/total
tokens, and provider response identifiers when available. The aggregate report also records
prefetch injection tokens, correction-hook tokens, and per-task totals.

## First-round smoke: 2026-08-12

| Group | Tasks | pass@1 | UX | Average tokens | Average wall time | Retrieval events |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 15 | 46.7% | 3.36 | 28,047 | 73.50s | 0 |
| Frozen learning | 15 | 53.3% | 3.21 | 58,411 | 108.04s | 21 |

The learned group improved pass@1 by 6.7 percentage points. The run also showed a 108.3% token
increase and a 47.0% wall-time increase, so it was treated as a diagnostic rather than a submission
candidate. No test write violations were recorded. pass^5 was not measured in this smoke run.

## Bounded-memory smoke: 2026-08-13

| Group | Tasks | pass@1 | UX | Average tokens | Average wall time | Prefetch events |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Baseline | 3 | 33.3% | 2.18 | 29,673 | 81.88s | 0 |
| Frozen learning | 3 | 66.7% | 2.95 | 31,673 | 79.71s | 26 |

The learned group improved pass@1 by 33.3 percentage points on this small sample. Memory injection
totaled 4,612 estimated tokens, average token growth was 6.7%, and frozen-state write violations
were zero. This result is too small to represent a benchmark score.

## Run commands used

The local first-round workflow was:

```powershell
uv run python -m scripts.prepare_capybara_first_round
uv run python -m scripts.run_capybara_training --run-tag <run-tag> --train-cases-per-domain 1
uv run python -m scripts.run_local_first_round_eval `
  --group learned `
  --run-tag <run-tag> `
  --artifact snapshots/<run-tag>/learnings.json `
  --correction-attempts 3 `
  --retry-attempts 2 `
  --workers 2 `
  --tasks-per-domain 1 `
  --num-runs 1
uv run python -m scripts.report_capybara_first_round --run-tag <run-tag>
```

The 15-task diagnostic used five training trajectories and five held-out tasks per domain with one
run per task. The 3-task bounded-memory smoke used one training case and one held-out task per
domain. The synthetic correction smoke was separate from STATE-Bench scoring and used one failed
clean execution followed by one clean retry.

## Correction boundary smoke

An isolated synthetic state-machine smoke was excluded from STATE-Bench scores. It demonstrated one
failed clean execution, one correction proposal, and one passing clean retry. The correction audit
did not expose the expected answer or hidden evaluator details to the correction model, and the
temporary strategy was not persisted as long-term memory until replay admission.

## Provenance

- STATE-Bench: `0.8.1`, commit `5644b1838d96bc4483da29642d058ecaa6f80f7f`;
- agent model in the reports: `gpt-5.6-luna`;
- protocol model names: `gpt-5.4` simulator and judge;
- bounded-memory smoke training run: `4cf7e547-1824-4ffc-acc4-e991f2d9827b`;
- bounded-memory frozen snapshot: `32d9497eded57416e3bb11adc7be5cc535912a73337283ec9c2515b285f6cc51`;
- bounded-memory source fingerprints: training `fbe20c66bf35092f55b83bdcececfbe93f15b52bd22c232c965cc842377b2c9c`, evaluation `bac9fd4c4081828d6a6d8551f721ba707d51ac25a0beffc6ad2c70512f1e0b59`;
- detailed JSON reports remain local and are intentionally not included in this public example.
