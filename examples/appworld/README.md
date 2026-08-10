# Capybara AppWorld experiment project

This project runs AppWorld through Capybara's project-owned Tool, Skill, Harness, and experiment-adapter interfaces. AppWorld-specific code and dependencies stay in this directory.

This directory is the sanitized public snapshot for the `kecaipan capybara` official evaluation.
See [REPRODUCIBILITY.md](REPRODUCIBILITY.md) for exact provenance, scores, release boundaries, and
verification commands. The case-level training evidence buffer is intentionally empty in Git;
the aggregate run and project experience rendered by `main.j2` is included.

## Local setup

Use Python 3.11 and `uv` on Windows:

```powershell
uv venv --python 3.11 .venv
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
.\.venv\Scripts\python.exe -m appworld.cli install
.\scripts\download_appworld_data.ps1 -TargetRoot .\.venv\appworld-root
```

The download script retrieves the official AppWorld 0.1.0 encrypted bundle in validated byte ranges and unpacks it with AppWorld's own package API.

Configure the LLM through Capybara's project settings. The API key is stored in `.capybara/secrets.json`, which is intentionally ignored by Git.

## Datasets

Generate a one-task development smoke dataset:

```powershell
.\.venv\Scripts\python.exe .\scripts\generate_dataset.py --project . --root .\.venv\appworld-root --split dev --selection tasks --limit 1 --difficulty 1
```

Generate one complete three-task scenario for meaningful scenario-goal completion:

```powershell
.\.venv\Scripts\python.exe .\scripts\generate_dataset.py --project . --root .\.venv\appworld-root --split dev --selection scenarios --limit 1 --difficulty 1
```

Prepare the complete training and closed-book benchmark projections:

```powershell
.\scripts\prepare_benchmark.ps1
```

This creates three local datasets:

- `appworld-train-all-scenarios` builds the reusable context corpus.
- `appworld-test-normal-all-scenarios` is the normal closed-book score.
- `appworld-test-challenge-all-scenarios` is the challenge closed-book score.

Projected records never contain AppWorld answers, evaluator code, tool arguments, credentials,
database values, or tool outputs. The train context builder only learns from Cases that passed the
official state evaluator.

AppWorld's downloaded data and generated dataset projections are local-only. The official data license requires public redistribution of the protected data or its derivatives to remain encrypted, so `.venv/` and `datasets/` are ignored.

## Execution

Select this directory as the Capybara project and choose an AppWorld dataset. Use concurrency `1` for smoke diagnosis and `2` for the full local benchmark. The adapter starts one isolated AppWorld environment server per Case, evaluates the resulting database state, records TGC and SGC metrics, and terminates the server during cleanup.

For the complete benchmark, first commit the project and run the train projection:

```powershell
node .\scripts\run_experiment.mjs --dataset appworld-train-all-scenarios --name "AppWorld train context corpus" --concurrency 2
```

Build a frozen Harness from the completed train Run, inspect it, and commit it:

```powershell
node .\scripts\build_training_context.mjs --run-id <train-run-id>
git add harnesses/tool/appworld
git commit -m "Add train-derived AppWorld context"
```

Run both closed-book test splits from that exact commit:

```powershell
node .\scripts\run_experiment.mjs --dataset appworld-test-normal-all-scenarios --name "AppWorld test normal closed book" --concurrency 2
node .\scripts\run_experiment.mjs --dataset appworld-test-challenge-all-scenarios --name "AppWorld test challenge closed book" --concurrency 2
node .\scripts\summarize_benchmark.mjs --runs <normal-run-id>,<challenge-run-id>
```

The summary combines TGC by task count and SGC by scenario count. It rejects Runs from different
models or project commits so that the score cannot silently mix different contexts.

## Official AppWorld leaderboard bundles

Capybara keeps every AppWorld Case isolated under its own experiment output directory. Before an
official submission, audit the completed training Run without changing any result:

```powershell
.\.venv\Scripts\python.exe .\scripts\export_leaderboard.py audit `
  --run-id <training-run-id> `
  --split test_normal
```

After both closed-book splits finish from the same frozen snapshot, assemble the official AppWorld
directories, rerun AppWorld's evaluator, create encrypted bundles, and verify their contents:

```powershell
.\.venv\Scripts\python.exe .\scripts\export_leaderboard.py build `
  --normal-run-id <normal-training-run-id> `
  --challenge-run-id <challenge-training-run-id> `
  --name-prefix kecaipan_capybara_gpt56luna_20260808 `
  --method-name "kecaipan capybara" `
  --method-tooltip "Self-organizing context with frozen closed-book evaluation" `
  --llm-name "<model-name>" `
  --llm-tooltip "<provider and exact model version>" `
  --url "https://github.com/pkc000pkc/capybara"
```

The build command refuses incomplete datasets, missing task artifacts, mixed models, mixed Git
versions, different snapshot IDs, and existing output directories. It produces only encrypted
`leaderboard.bundle` files for public submission; never publish the assembled plaintext experiment
directories because they contain protected AppWorld-derived data.

The official release tag is `appworld-official-2026-08-08`. Model responses and external services
are not deterministic, so a fresh run may not reproduce every case outcome exactly. The tag fixes
the method implementation and public runtime assets; the encrypted official bundles and AppWorld's
independent workflow are the authoritative record of the submitted score.
