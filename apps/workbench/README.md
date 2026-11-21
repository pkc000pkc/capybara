# Capybara Workbench

This is the V2 local desktop workbench for the Capybara product design.
The Electron main process owns the V2 Runtime boundary and directly hosts the
Backend `RuntimeLoop`, including ContextDocument, candidate/evidence governance,
RuntimeEnvelope validation, and durable project Trace. The renderer talks to it
through typed IPC; the desktop chat loop does not use a WebSocket connection.
`apps/frontend` remains the legacy developer/runtime interface.

Run the browser development UI explicitly from the repository root when
reviewing the new UI:

```bash
npm --prefix apps/workbench run dev
```

The root workspace includes this package for dependency and build resolution,
but the root `dev` command and existing frontend commands do not start it.

Build and run the standalone desktop shell without a browser server:

```bash
npm --prefix apps/workbench run desktop:build
npm --prefix apps/workbench run desktop:start
```

`desktop:build` builds the Backend runtime before exporting the Workbench, and
`desktop:start` loads `out/index.html` directly. For desktop development with
hot reload, start Next separately and explicitly provide its URL before
running `desktop:dev`:

```powershell
$env:CAPYBARA_WORKBENCH_URL = "http://localhost:3010"
npm --prefix apps/workbench run desktop:dev
```

Run a real, no-side-effect IPC smoke check with the current system model
configuration (the API key is never printed):

```powershell
npm --prefix apps/workbench run verify:desktop-runtime
```

The `start` script is an alias for `desktop:start`; the static export does not
need `next start` or a localhost browser server. Electron checks `http://localhost:3005/hello`
and starts the local backend automatically when it is not already running. Set
`CAPYBARA_MANAGED_BACKEND=false` when the host process is managed separately.

## Local Runtime configuration

The desktop shell reads the model configuration in the Electron main process.
System-level configuration lives under `%USERPROFILE%\.capybara`. The
directory contains `config.json` for model defaults, `credentials.json` for
the API key, `projects.json` for opened projects, and `logs\` for system logs.
The process environment takes precedence when a value is present. To
configure a key at user scope:

```powershell
[Environment]::SetEnvironmentVariable("OPENAI_API_KEY", "<your-key>", "User")
$env:LLM_PROVIDER = "openai"
$env:LLM_MODEL = "gpt-6-luna"
$env:LLM_BASE_URL = "https://api.openai.com/v1"
npm --prefix apps/workbench run desktop:start
```

`LLM_API_KEY`, `API_KEY`, and `OPENAI_API_KEY` are accepted in that order.
The V2 Runtime also loads the system user's `.capybara/credentials.json` when
none of those environment variables is present. It does not read repository
key files and never returns key contents to the renderer.

When a project is opened, its `.capybara` directory is created automatically.
Project applications live under `.capybara/applications`, session records are
stored in `.capybara/sessions.sqlite`, and context data is kept under
`.capybara/context`.

The public preferences/status surfaces expose only whether a key is configured;
they never return key contents. Runtime sessions and messages are persisted in
the opened project's `.capybara/sessions.sqlite`.

The local backend remains available for the application, browser, market
research, and resource compatibility surfaces. It is not part of the V2 chat
session transport.

The backend exposes `POST /api/work/market-research` with the local project
path kept on the host boundary. Its default factory wires Eastmoney daily data,
explicit HTTPS report quarantine, the managed local Python analysis example, and
the local HTML dashboard host; a host may still provide a stricter factory.

The Electron shell exposes only a project identity, display name, empty-state
flag, and opaque directory reference to the renderer. The real local path stays
in the main process; the renderer never receives directory paths or file
contents.

## Native project directory boundary

The desktop version uses the `selectProjectDirectory` native directory picker
through the typed bridge in `src/app/workbench-bridge.ts`. Selecting a directory is valid even when it is
empty. The renderer receives only a project ID, display name, empty-state flag,
and opaque directory reference. The native path, directory handle, file names,
and file contents remain in the host process.

Picking a directory registers the project; it does not upload, scan, or read
the directory. Later reads and writes must go through an explicitly authorized
host capability. The mock bridge test covers the empty-directory and no-leak
contract.

The project application panel reads a host-owned capability status snapshot
through Electron IPC. It reports backend reachability and the connection state
of application runtime, browser gateway, and market research. A backend may
publish a sanitized `GET /api/capabilities?projectId=...` response; until that
route and its provider/executor adapters are registered, the panel keeps those
entries in an explicit unknown state and does not claim that an application or
browser action ran.

Validation from the repository root:

```powershell
npm run typecheck --workspace=apps/workbench
npm run build --workspace=apps/workbench
npx tsx --conditions=development --test apps/workbench/test/workbench-data.test.ts
npx tsx --conditions=development --test apps/workbench/test/workbench-bridge.test.ts
node --test apps/workbench/test/electron-runtime-v2.test.cjs apps/workbench/test/electron-directory.test.cjs apps/workbench/test/electron-project-registry.test.cjs
node --test apps/workbench/test/backend-runtime-host.test.cjs
```
