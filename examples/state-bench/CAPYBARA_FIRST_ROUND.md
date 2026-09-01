# Capybara first STATE-Bench learning round

This checkout doubles as an isolated Capybara project for the first local learning experiment. It keeps upstream STATE-Bench task definitions, environments, tools, simulators, judges, and protocol prompts unchanged.

## Scope

- Prepared training pool: the lowest-numbered five checked-in trajectories in each `datasets/train_task_trajectories/<domain>` directory.
- Default small training run: one prepared trajectory per selected domain; increase only with `--train-cases-per-domain`.
- Default local evaluation: all 50 official test tasks per domain, five runs per task (750 trajectories total). Use `--tasks-per-domain` and `--num-runs` only for a smaller preflight.
- Control: `CapybaraBaselineAgent`, with no retrieval tool.
- Learned group: `CapybaraLearnedAgent`, automatically prefetching at most one guard and one advisory memory before every model loop from a frozen snapshot.
- Agent model: `gpt-5.6-luna` from the authorized OpenAI-compatible configuration.
- Simulator and judge model: `gpt-5.4`, using the protocol-locked prompts.

The local proxy is not the Azure evaluation client required for an official submission. Reports therefore label every score as local and non-official.

The learning Hook produces bounded atomic entries with stable memory keys. Runtime prefetch injects at most two entries, about 450 tokens per loop and 1,200 tokens per run, with separate phase budgets and no repeated IDs. The default projection is 15 records; a generated manifest may explicitly select a larger train-only cohort.

## Data boundary

`scripts.prepare_capybara_first_round` reads only `datasets/train_task_trajectories`. The selected held-out task definitions are loaded later by the evaluation runner and are never passed to the training projection or learning Hook. Capybara training changes run-scoped variables in its SQLite store, replays every candidate, and freezes an immutable snapshot before evaluation.

Runtime outputs under `runs/` and `snapshots/`, the local secret, generated dataset registry, and SQLite files are ignored. The derived 15-record JSONL projection and its source-hash manifest remain reviewable under `datasets/capybara/`.

## Commands

```powershell
uv run python -m scripts.prepare_capybara_first_round
uv run python -m scripts.probe_first_round_client
uv run python -m scripts.run_capybara_training --run-tag <run-tag> --train-cases-per-domain 1
uv run python -m scripts.run_local_first_round_eval --group learned --run-tag <run-tag> --artifact snapshots/<run-tag>/learnings.json --dry-run
uv run python -m scripts.run_local_first_round_eval --group learned --run-tag <run-tag> --artifact snapshots/<run-tag>/learnings.json
uv run python -m scripts.report_capybara_first_round --run-tag <run-tag>
uv run python -m scripts.run_luna_correction_smoke --run-tag <correction-smoke-tag>
```

If the local runner process is interrupted after the backend has accepted a run, attach to it without creating a duplicate:

```powershell
uv run python -m scripts.run_capybara_training --run-tag <run-tag> --train-cases-per-domain 1 --resume-run-id <training-run-id>
uv run python -m scripts.run_local_first_round_eval --group learned --run-tag <run-tag> --artifact snapshots/<run-tag>/learnings.json --resume
```

The Capybara backend must already be listening at `http://127.0.0.1:3005` for training. Frozen local evaluation does not require the backend. Every evaluation run writes an append-only token ledger, a per-result checkpoint, and a source archive; resume is rejected if the source fingerprint changed. Credentials are resolved from the authorized sibling project and are never included in the archive.

The JSON report contains the correction chain, experience-candidate lifecycle, baseline/run/snapshot variable hashes and diffs, frozen-state write checks, and every automatic prefetch event with selected IDs, score reasons, and token counts. The offline projection validates extraction and the analysis-only rejection boundary; it must not be presented as evidence that a real STATE-Bench task needed correction.

Memory schema v2 intentionally rejects candidates whose closed-book replay only repeats the offline trajectory-analysis prompt. A new snapshot must come from an executable train-only task adapter. Until that adapter is attached, the existing frozen artifact can be used for selector and Harness A/B tests but must not be regenerated from the analysis-only projection.

Use the two reports for separate claims:

- `reports/luna-small-20260813.json` is the three-domain small-batch effectiveness report. It records the baseline/learned comparison, all five long-term variable values and hashes, candidate admission, 26 learned prefetch events, and frozen-state write checks.
- `reports/luna-correction-no-answer-leak-20260813.json` is an isolated `synthetic_state_machine_smoke`, excluded from STATE-Bench scores. It proves a Luna-run initial failure was corrected in a distinct clean child experiment, replay-admitted into memory, automatically prefetched after every model loop, frozen, and passed in the final test without writing session state to project variables. The executable audit rejects any expected recovery marker in the training question or generated correction proposal.

Clean-environment automatic correction and exhausted-limit behavior are also covered by the backend integration tests. Correction Hooks receive sanitized execution evidence, never the expected answer, expected tools, official reference, or hidden evaluator details. Production runs retry automatically within configured token, wall-time, and attempt safety limits; exhaustion produces `unresolved` without human review or long-term memory admission.
