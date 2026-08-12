# capybara-agent

Local Runtime and CLI for running Capybara Agent projects independently from the developer interface. The package also contains the Fastify development service used by this repository.

## Install and run

Install the published Runner globally and start an unpacked Capybara Agent project:

```bash
npm install --global capybara-agent
capybara serve ./my-agent --port 3210 --token local-development-token
```

Or run the latest published version without a global installation:

```bash
npx capybara-agent@latest serve ./my-agent --port 3210
```

If `--token` and `CAPYBARA_RUNNER_TOKEN` are omitted, the Runner generates and prints an access token. Verify startup with `GET http://127.0.0.1:3210/v1/health`.

The Runner binds to `127.0.0.1` by default. Use `--workspace` to separate the Tool workspace from the Agent project, `--data-dir` to move Session persistence outside the project, and `--allow-origin` to authorize browser clients.

## Repository development

Run commands from the repository root. Without local configuration, Backend uses the sanitized project in `examples/test-project`:

```bash
npm run dev:backend
npm run test:backend
```

The service listens on port `3005` by default.

To use another project, copy `.env.example` to `.env` and set `CAPYBARA_PROJECT_DIR`. The local `.env` file and project runtime data are ignored by Git.

## Standalone Runner from source

The local Runner exposes only the deployed Agent runtime and Session API:

```bash
npm run serve -- examples/test-project --port 3210 --token local-development-token
```

Run this command from the repository root with `npm run serve:agent -- ...`, or from `apps/backend` with `npm run serve -- ...`.
