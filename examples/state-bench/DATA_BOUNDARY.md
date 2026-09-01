# Data boundary

This directory is an integration overlay for the official STATE-Bench checkout. The benchmark
checkout must remain separate because its task definitions, simulator, judge, tools, and protocol
are controlled evaluation inputs.

The public Capybara example intentionally excludes:

- STATE-Bench `state_bench/` source and task files;
- train or test trajectory JSONL files and generated dataset projections;
- task databases, expected states, evaluator output, and full run traces;
- `.capybara` databases, provider credentials, API keys, and local proxy configuration;
- token ledgers and per-task correction artifacts.

The example contains only the agent/client integration, Capybara Hooks, memory Harness, run helpers,
and aggregate result summaries. Obtain the official benchmark code from
https://github.com/microsoft/STATE-Bench and follow its license and submission rules.
