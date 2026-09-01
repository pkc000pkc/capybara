# Capybara STATE-Bench example

This directory contains the Capybara integration used for local STATE-Bench Agent Learning Track
experiments. It is an overlay for a clean official STATE-Bench checkout, not a replacement for the
benchmark itself.

The integration was developed against STATE-Bench `0.8.1` at commit
`5644b1838d96bc4483da29642d058ecaa6f80f7f`. The official benchmark remains the source of the locked
user simulator, judge, domain tools, task environments, prompts, and scoring protocol.

## Included components

- `agents/`: baseline and learned `StateBenchAgent` implementations;
- `clients/`: OpenAI-compatible Responses client and append-only token audit ledger;
- `hooks/`: per-loop memory selection, training extraction, failure correction, and replay admission;
- `harnesses/memory/`: bounded memory context injected into the next model loop;
- `capybara_first_round/`: immutable learning-artifact and projection helpers;
- `scripts/`: local training, correction, evaluation, reporting, and client-probe helpers;
- `config/`: first-round selection and budget configuration;
- `RESULTS.md`: aggregate local results with their non-official status.

## Evaluation boundary

The official protocol uses the locked GPT-5.4 simulator and judge. The local OpenAI-compatible
proxy path used during development is not an official submission client. Do not describe its
scores as leaderboard results.

The learned agent keeps the baseline tool loop and adds bounded memory prefetch before every model
loop. At most two snippets and 450 estimated tokens are injected per loop, with a 1,200-token
per-run budget. Guard entries are separated from procedural advice and authoritative tool state
remains the source of task-specific facts.

When a training execution is marked incorrect, the correction Hook sees only the observable
conversation, tool calls, sanitized failure status, and previous correction summaries. It rejects
hidden expected answers, reference states, evaluator details, and expected tools. Each correction is
run in a fresh environment and may be limited to 3, 4, or 5 attempts by the evaluation script.
Failed or unresolved corrections are not admitted to long-term memory. Memory is promoted only
after a closed-book replay passes the configured threshold.

## Runtime information

The following values describe the local runs recorded in `RESULTS.md`:

| Item | Value |
| --- | --- |
| Host path | `examples/state-bench` in the Capybara repository |
| Runtime | Windows; Python 3.12; `uv`; Node.js 22+ for the Capybara backend |
| Backend | `http://127.0.0.1:3005` during training; frozen local evaluation can run without the backend |
| STATE-Bench | `0.8.1`, commit `5644b1838d96bc4483da29642d058ecaa6f80f7f` |
| Agent model | `gpt-5.6-luna` |
| Simulator and judge | `gpt-5.4` / `gpt-5.4`; judge reasoning level `high` |
| Client path | OpenAI-compatible Responses client with a local token audit ledger |
| Memory prefetch | Top 2 snippets; 450 estimated tokens per loop; 1,200 estimated tokens per run |
| Memory capacity | 24 cross-domain entries and 48 entries per domain |
| Correction limit | `--correction-attempts 3`, `4`, or `5`; `0` disables correction |
| Technical retry limit | `--retry-attempts` defaults to `2` for transient client/scoring failures |
| Official status | Local proxy runs are diagnostic and `official_submission_eligible=false` |

Each evaluation writes append-only JSONL token events with the role (`agent`, `simulator`,
`task_judge`, `ux_judge`, or `correction_hook`), requested/response model, request kind, elapsed
time, status, input tokens, cached input tokens, output tokens, reasoning tokens, and total tokens.
Per-task summaries also record memory-prefetch tokens, correction-attempt usage, and the source
fingerprint used for resume validation.

## Apply the overlay

Clone the official benchmark separately, check out the pinned version, install its dependencies,
and apply only the integration files below. Preserve the official checkout's `.gitignore`,
`state_bench/`, task data, and protocol files. On Windows, from the Capybara repository:

```powershell
git clone https://github.com/microsoft/STATE-Bench.git ..\STATE-Bench
Set-Location ..\STATE-Bench
git checkout 5644b1838d96bc4483da29642d058ecaa6f80f7f
uv sync
$overlay = ..\capybara\examples\state-bench
Copy-Item $overlay\agents, $overlay\clients, $overlay\hooks, $overlay\harnesses -Destination . -Recurse -Force
Copy-Item $overlay\capybara_first_round, $overlay\config, $overlay\scripts, $overlay\tests -Destination . -Recurse -Force
Copy-Item $overlay\main.j2, $overlay\.env.example -Destination . -Force
New-Item -ItemType Directory -Force .capybara | Out-Null
Copy-Item $overlay\.capybara\config.json .capybara -Force
```

Do not copy local `.env`, `.capybara` databases, `datasets`, `runs`, `snapshots`, `reports`, or
credentials into a public checkout. Configure the official locked evaluation client and the agent
client according to STATE-Bench's own documentation.

## Local Capybara run

The helper scripts expect the Capybara backend to be running at `http://127.0.0.1:3005` and an
OpenAI-compatible Responses provider configured through environment variables. A minimal local
sequence is:

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

Use the official STATE-Bench batch runner, `--num-runs 5`, and the official metrics command for an
official submission. The local first-round helpers are diagnostic and intentionally do not create
an official leaderboard submission. The full local plan is 50 evaluation tasks per domain and five
runs per task (750 trajectories across three domains); the reports currently checked in here are
smaller smoke runs and must not be described as that full score.

## Verification

From the official benchmark checkout with this overlay applied:

```powershell
uv run pytest tests/test_state_bench_learning_hook.py tests/test_memory_runtime_hooks.py tests/test_token_audit.py
uv run ruff check agents clients capybara_first_round scripts
```

The tests validate the public memory schema, clean correction boundary, bounded per-loop retrieval,
token accounting, and UTF-8 JSONL handling without publishing benchmark task data.
