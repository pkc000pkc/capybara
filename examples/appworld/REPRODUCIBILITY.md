# AppWorld reproduction guide

## Release

- Repository: `https://github.com/pkc000pkc/capybara`
- Tag: `appworld-official-2026-08-08`
- Method: `kecaipan capybara`
- Model: `gpt-5.6-luna`
- Protocol: OpenAI-compatible Responses API
- AppWorld package: `0.1.3.post1`
- AppWorld data: `0.1.0`
- Python: `3.11`
- Recommended Node.js: `22`

The tag fixes both the Capybara training/evaluation implementation and this project-owned AppWorld
adapter, Hook, Tool, Skill, Harness, template, parameter, and aggregate-context snapshot.

## Official provenance

| Item | Value |
| --- | --- |
| Training Run | `95499983-44ab-4668-aa2e-85a6dcb832e3` |
| Frozen snapshot | `8b079f77-a53d-4c97-b604-cbcc4f8e908f` |
| Snapshot content hash | `e3cf569d95da883386afdecec73bfc1af9e326b561157f4db711fb519afb0d22` |
| Original project HEAD | `7eb5cc03204bb84954f4ba5d48bbee5d9da71a3f` |
| Original captured tree | `6185c08f7a60cb0122199d8ab9e85686934e3773` |
| Evaluator adapter revision | `ada6059a459c0495d245164990afac52daaa98e4daaf8137fb94f866b2a43d22` |
| Normal Run | `a5981169-0fb9-4afa-be59-a56c640ad9a2` |
| Challenge Run | `8d8bc3d8-a0d5-4dd3-9497-1d134ba0f9e7` |
| Official leaderboard PR | [StonyBrookNLP/appworld-leaderboard#15](https://github.com/StonyBrookNLP/appworld-leaderboard/pull/15) |
| Official validation | [Manage leaderboard #158](https://github.com/StonyBrookNLP/appworld-leaderboard/actions/runs/31241103997) |

Training completed `90 / 90` cases with `77` passes. It produced `90` experience candidates;
`78` passed the configured replay/application policy and `12` were rejected. Normal and Challenge
were then created from the same immutable snapshot with `evaluationOnly=true`.

## Expected official results

| Split | Tasks | Passed | TGC | SGC | Interactions |
| --- | ---: | ---: | ---: | ---: | ---: |
| `test_normal` | 168 | 143 | 85.1 | 73.2 | 9.34 |
| `test_challenge` | 417 | 306 | 73.4 | 52.5 | 11.17 |

Difficulty results:

| Split | Level 1 TGC / SGC | Level 2 TGC / SGC | Level 3 TGC / SGC |
| --- | --- | --- | --- |
| Normal | 94.7 / 84.2 | 93.8 / 81.2 | 69.8 / 57.1 |
| Challenge | 83.3 / 58.3 | 68.7 / 48.0 | 73.3 / 53.8 |

## Published context boundary

The runtime template reads `execution_policy`, `appworld_run_experience`, and
`appworld_project_experience`. Their UTF-8 content hashes in this release are:

| Variable | Bytes | SHA-256 |
| --- | ---: | --- |
| `execution_policy` | 391 | `92ce36d8b820db22f291ce750773a38b8fdac75e5002376af201928556cee1b5` |
| `appworld_run_experience` | 6,203 | `35bba3d878f371fc6d1f7c71b51c5d49c90d90f7a362da6abc697b8e52ab612b` |
| `appworld_project_experience` | 8,288 | `c75867f0d7e61416128325063daf6ba127f2e682f3c9bdd1e83d11baec43b802` |

`appworld_case_experience` is an intermediate training buffer containing case-level evidence. It is
not rendered by `main.j2`, and its value is intentionally empty in the public release. This avoids
redistributing protected questions, answers, records, and traces without changing the published
evaluation prompt.

The repository also excludes:

- `.capybara/secrets.json` and provider credentials;
- AppWorld downloads, generated dataset projections, ground truth, and task databases;
- experiment databases, Session databases, worktrees, logs, and case artifacts;
- plaintext assembled official experiments and encrypted leaderboard bundles.

## Environment setup

From the repository root:

```powershell
npm install
npm run typecheck
npm test
```

Prepare the AppWorld project:

```powershell
Set-Location .\examples\appworld
uv venv --python 3.11 .venv
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
.\.venv\Scripts\python.exe -m appworld.cli install
.\scripts\download_appworld_data.ps1 -TargetRoot .\.venv\appworld-root
.\scripts\prepare_benchmark.ps1
```

Open this directory as the Capybara project and configure an OpenAI-compatible Responses provider.
Store the API key through the project settings; never add it to Git.

## Training and evaluation

Run training first:

```powershell
node .\scripts\run_experiment.mjs `
  --dataset appworld-train-all-scenarios `
  --name "AppWorld training"
```

Inspect and accept/reject training candidates according to the project policy, then freeze the
resulting variable snapshot. Run both official splits from that same snapshot with evaluation-only
mode through the Capybara Training and Validation interface.

The helper scripts can launch dataset runs and summarize compatible completed runs:

```powershell
node .\scripts\run_experiment.mjs --dataset appworld-test-normal-all-scenarios --name "AppWorld normal"
node .\scripts\run_experiment.mjs --dataset appworld-test-challenge-all-scenarios --name "AppWorld challenge"
node .\scripts\summarize_benchmark.mjs --runs <normal-run-id>,<challenge-run-id>
```

## Code verification

```powershell
node --test .\experiments\appworld-adapter.test.mjs
node --check .\experiments\appworld-adapter.mjs
.\.venv\Scripts\python.exe -m py_compile `
  .\scripts\export_leaderboard.py `
  .\scripts\extract_state_diff.py `
  .\scripts\generate_dataset.py
```

## Official bundle verification

The submitted bundles were independently unpacked, evaluated, rebuilt, and checked by the official
workflow. Their hashes were:

| Split | Bytes | SHA-256 |
| --- | ---: | --- |
| Normal | 3,047,518 | `8e97de871ccf041c7614c59028c9cf1bb62d83af018546553d9617027f76c3e5` |
| Challenge | 9,549,268 | `4d3e7e7babbc935a29213e7beccc6a2550d201de60bc86911dab5334b586b2de` |

Do not add those bundles or their plaintext contents to this repository. Use
`scripts/export_leaderboard.py` to audit a new completed run and create a new official submission.

## Reproduction limits

The release makes the implementation, configuration, aggregate context, and provenance auditable.
It does not make external model inference deterministic. Provider revisions, sampling behavior,
network conditions, and infrastructure retries can change individual case outcomes. Therefore:

- the Git tag is the authoritative method-code snapshot;
- PR #15 and workflow #158 are the authoritative submitted-score records;
- a new run should be reported as an independent replication, not as the original official run.
