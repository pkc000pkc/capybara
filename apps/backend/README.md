# Capybara Backend

Fastify service for Runtime sessions, project resources, Tool execution, Skills, Harnesses, Context management, Datasets, Experiments, and project Git metadata.

Run commands from the repository root. Without local configuration, Backend uses the sanitized project in `examples/test-project`:

```bash
npm run dev:backend
npm run test:backend
```

The service listens on port `3005` by default.

To use another project, copy `.env.example` to `.env` and set `CAPYBARA_PROJECT_DIR`. The local `.env` file and project runtime data are ignored by Git.
