# Capybara

Capybara is a local-first development runtime for building, observing, debugging, and evaluating tool-using AI agents.

The repository keeps the runtime service, developer interface, example project, and shared protocol boundary in one workspace so implementation changes can be reviewed and tested atomically. Long-form engineering and research documentation is maintained in the companion `capybara-doc` repository.

![Capybara workflow: runtime debugging, resource authoring, and experiment analysis](.github/assets/capybara-workflow.gif)

Capybara keeps the full agent engineering loop visible: inspect live context and execution state, author project-scoped Tools, Harnesses, and Skills, then evaluate changes against datasets.

## Interface tour

### Observe and debug the runtime

Inspect conversations, loaded context resources, runtime health, execution mode, and the step-by-step trace in one adjustable workspace.

![Capybara runtime workspace with context tools, conversation, status, and execution trace](.github/assets/runtime-overview.png)

### Author project resources

Browse project files and edit versioned agent resources with language-aware code views. Tools, Harnesses, and Skills have dedicated definitions, diagnostics, and test surfaces.

![Capybara resource workspace showing the project file browser and code editor](.github/assets/resources-workspace.png)

### Track experiments

Scope analysis to a dataset, then review overall trends, compare experiments, or inspect a single run from the same workspace.

![Capybara experiment analysis workspace with dataset-scoped views](.github/assets/experiments-dashboard.png)

## Repository layout

```text
apps/
  backend/            Fastify runtime and resource service
  frontend/           Next.js developer interface
examples/
  test-project/       Sanitized Tool, Skill, Harness, Dataset, and Context example
  appworld/           AppWorld training Hooks, adapter, runtime resources, and reproduction guide
packages/
  protocol/           Reserved shared runtime protocol package
```

The AppWorld example contains code and sanitized aggregate context only. Benchmark downloads,
dataset projections, case evidence, local experiment workspaces, databases, and leaderboard bundles
remain excluded from Git.

## AppWorld reproduction

The [`examples/appworld`](examples/appworld) project contains the training Hooks, official evaluator
adapter, runtime resources, dataset generator, state-diff helper, experiment launcher, and leaderboard
bundle tooling used by the `kecaipan capybara` submission.

Use the `appworld-official-2026-08-08` tag and follow the
[reproduction guide](examples/appworld/REPRODUCIBILITY.md) to recreate the environment and method.
The official workflow independently reported Normal TGC/SGC `85.1 / 73.2` and Challenge TGC/SGC
`73.4 / 52.5` in [AppWorld leaderboard PR #15](https://github.com/StonyBrookNLP/appworld-leaderboard/pull/15).

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Development

Install all workspace dependencies from the repository root:

```bash
npm install
```

Start Backend on port `3005` and Frontend on port `3000`:

```bash
npm run dev
```

The default project is `examples/test-project`. Add the LLM API Key from the Project configuration screen. The Key is written to `.capybara/secrets.json`, which is ignored by Git.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Browser end-to-end tests are available separately:

```bash
npm run test:e2e
```

## Security

Do not commit `.env`, `.capybara/secrets.json`, session databases, experiment databases, logs, generated worktrees, benchmark downloads, or model-provider credentials. Example configuration uses non-routable placeholder service values.

## License

Capybara is licensed under the [Apache License 2.0](LICENSE).
