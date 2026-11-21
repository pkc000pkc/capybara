const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;
const MAX_LOG_CHARS = 100_000;
const SAFE_ENV_KEYS = new Set([
  "Path", "PATH", "PATHEXT", "ComSpec", "COMSPEC", "SystemRoot", "WINDIR",
  "TEMP", "TMP", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "APPDATA",
  "LOCALAPPDATA", "ProgramData", "PROGRAMDATA", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS", "LANG", "LANGUAGE",
  "NODE_PATH",
]);

function now() { return new Date().toISOString(); }

function safeId(value, fallback) {
  const normalized = String(value || "").trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function hashDirectory(root) {
  const hash = crypto.createHash("sha256");
  const walk = (directory, relative = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name;
      if (name === ".capybara" || name === ".git" || name === "coverage" || name === "node_modules") continue;
      const absolute = path.join(directory, name);
      const childRelative = path.join(relative, name).replaceAll(path.sep, "/");
      if (entry.isDirectory()) {
        hash.update(`dir:${childRelative}\n`);
        walk(absolute, childRelative);
      } else if (entry.isFile()) {
        hash.update(`file:${childRelative}:${hashFile(absolute)}\n`);
      }
    }
  };
  walk(root);
  return hash.digest("hex");
}

function parseCommand(value, args = []) {
  if (typeof value !== "string" || !value.trim()) throw new Error("application command is required");
  const tokens = [];
  const expression = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
  let match;
  while ((match = expression.exec(value.trim()))) tokens.push(match[1] ?? match[2] ?? match[3]);
  if (Array.isArray(args)) tokens.push(...args.map(String));
  if (!tokens.length) throw new Error("application command is empty");
  let command = tokens.shift();
  if (process.platform === "win32" && ["npm", "npx", "pnpm", "yarn"].includes(command.toLowerCase())) command = `${command}.cmd`;
  return { command, args: tokens };
}

function resolvePackageScript(command, args, cwd, depth = 0) {
  if (depth > 4 || process.platform !== "win32" || !["npm", "npm.cmd"].includes(String(command).toLowerCase())) return { command, args };
  const packageJson = readJson(path.join(cwd, "package.json"), null);
  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const name = args[0] === "run" || args[0] === "run-script" ? args[1] : args[0];
  if (!name || typeof scripts[name] !== "string") return { command, args };
  const separator = args.indexOf("--");
  const forwarded = separator >= 0 ? args.slice(separator + 1) : [];
  const nested = parseCommand(scripts[name], forwarded);
  if (process.platform === "win32" && !path.extname(nested.command)) {
    const localCommand = path.join(cwd, "node_modules", ".bin", `${nested.command}.cmd`);
    if (fs.existsSync(localCommand)) nested.command = localCommand;
  }
  return resolvePackageScript(nested.command, nested.args, cwd, depth + 1);
}

function spawnSpec(command, args) {
  if (process.platform !== "win32") return { command, args };
  const lower = command.toLowerCase();
  // .cmd files cannot be launched with shell:false on Windows. npm is a
  // trusted Node CLI, so invoke its JS entry point directly and keep the app
  // process itself shell-free.
  if (lower === "npm.cmd" || lower === "npm") {
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const nodeCommand = process.versions.electron ? (process.env.CAPYBARA_NODE_EXECUTABLE || (process.platform === "win32" ? "node.exe" : "node")) : process.execPath;
    const nodeDirectory = process.versions.electron
      ? (path.isAbsolute(nodeCommand) ? path.dirname(nodeCommand) : (process.platform === "win32" ? "C:/Program Files/nodejs" : "/usr/bin"))
      : path.dirname(process.execPath);
    const nodeNpmCli = path.join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(nodeNpmCli)) return { command: nodeCommand, args: [nodeNpmCli, ...args] };
  }
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const quote = (value) => {
      const text = String(value);
      return /[\s"&()^]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
    };
    return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", [command, ...args].map(quote).join(" ")] };
  }
  return { command, args };
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function boundedPush(target, chunk) {
  target.push(String(chunk));
  let total = target.join("");
  if (total.length > MAX_LOG_CHARS) total = total.slice(total.length - MAX_LOG_CHARS);
  target.length = 0;
  target.push(total);
}

function lockArtifact(root) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      try {
        if (entry.isDirectory()) { walk(absolute); fs.chmodSync(absolute, 0o555); }
        else if (entry.isFile()) fs.chmodSync(absolute, 0o444);
      } catch { /* Windows ACLs may not expose POSIX mode bits */ }
    }
  };
  try { walk(root); fs.chmodSync(root, 0o555); } catch { /* best effort */ }
}

function reservePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function normalizeManifest(projectPath, input, applicationId) {
  const projectRoot = path.resolve(projectPath);
  const explicit = input && typeof input === "object" ? input : {};
  const sourceRoot = path.resolve(projectRoot, typeof explicit.sourceRoot === "string" ? explicit.sourceRoot : ".");
  if (!isInside(projectRoot, sourceRoot)) throw new Error("application sourceRoot must stay inside the project");
  const packageFile = path.join(sourceRoot, "package.json");
  const packageJson = fs.existsSync(packageFile) ? readJson(packageFile, {}) : {};
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const appId = safeId(explicit.appId || applicationId || path.basename(projectRoot), "application");
  const start = explicit.start && typeof explicit.start === "object" ? explicit.start : {};
  const build = explicit.build && typeof explicit.build === "object" ? explicit.build : {};
  const startCommand = start.command || (scripts.start ? "npm" : undefined);
  const startArgs = start.args || (scripts.start ? ["start"] : []);
  const buildCommand = build.command || (scripts.build ? "npm" : undefined);
  const buildArgs = Array.isArray(build.args) && build.args.length > 0
    ? build.args
    : (scripts.build && (!build.command || build.command === "npm") ? ["run", "build"] : []);
  if (!startCommand) throw new Error(`application ${appId} has no start command`);
  const health = explicit.health && typeof explicit.health === "object" ? explicit.health : {};
  const port = explicit.port && typeof explicit.port === "object" ? explicit.port : {};
  const browser = explicit.browser && typeof explicit.browser === "object" ? explicit.browser : {};
  const versionId = safeId(explicit.versionId || `version-${Date.now()}`, `version-${Date.now()}`);
  return {
    ...explicit,
    version: 1,
    appId,
    projectId: typeof explicit.projectId === "string" ? explicit.projectId : undefined,
    sourceRoot: path.relative(projectRoot, sourceRoot) || ".",
    workingDirectory: typeof explicit.workingDirectory === "string" ? explicit.workingDirectory : ".",
    build: {
      command: buildCommand,
      args: Array.isArray(buildArgs) ? buildArgs.map(String) : [],
      timeoutMs: Number.isFinite(build.timeoutMs) ? Number(build.timeoutMs) : 120_000,
    },
    start: { command: startCommand, args: Array.isArray(startArgs) ? startArgs.map(String) : [], shell: false },
    port: { mode: "dynamic", environment: typeof port.environment === "string" ? port.environment : "PORT" },
    health: {
      path: typeof health.path === "string" && health.path.trim() ? health.path : "/api/health",
      timeoutMs: Number.isFinite(health.timeoutMs) ? Number(health.timeoutMs) : DEFAULT_HEALTH_TIMEOUT_MS,
      startupTimeoutMs: Number.isFinite(health.startupTimeoutMs) ? Number(health.startupTimeoutMs) : DEFAULT_STARTUP_TIMEOUT_MS,
    },
    dataDirectory: typeof explicit.dataDirectory === "string" ? explicit.dataDirectory : `.capybara/applications/${appId}/data`,
    browser: {
      entryPath: typeof browser.entryPath === "string" && browser.entryPath.startsWith("/") ? browser.entryPath : "/",
      allowedOrigins: Array.isArray(browser.allowedOrigins) && browser.allowedOrigins.length ? browser.allowedOrigins.map(String) : ["http://127.0.0.1"],
    },
    versionId,
    versions: {
      currentDraft: explicit.versions?.currentDraft ?? versionId,
      latestGenerated: explicit.versions?.latestGenerated ?? null,
      latestVerified: explicit.versions?.latestVerified ?? null,
      latestPublished: explicit.versions?.latestPublished ?? null,
      previewVersionId: explicit.versions?.previewVersionId ?? null,
      deployedVersionId: explicit.versions?.deployedVersionId ?? null,
      runningVersionId: explicit.versions?.runningVersionId ?? null,
    },
    runtime: {
      status: explicit.runtime?.status ?? "stopped",
      previewVersionId: explicit.runtime?.previewVersionId ?? null,
      deployedVersionId: explicit.runtime?.deployedVersionId ?? null,
      runningVersionId: explicit.runtime?.runningVersionId ?? null,
      instanceId: explicit.runtime?.instanceId ?? null,
      processId: explicit.runtime?.processId ?? null,
      healthCheckRef: explicit.runtime?.healthCheckRef ?? null,
      lastError: explicit.runtime?.lastError ?? null,
    },
  };
}

function createApplicationProcessSupervisor({ onEvent = () => undefined, onReceipt = () => undefined, artifactStoreRoot = path.join(os.homedir(), ".capybara", "application-artifacts") } = {}) {
  const active = new Map();
  const restored = new Map();

  function emit(instance, type, payload = {}) {
    const event = {
      type,
      timestamp: now(),
      projectId: instance.projectId,
      appId: instance.appId,
      versionId: instance.versionId,
      instanceId: instance.instanceId,
      processId: instance.processId,
      turnId: instance.turnId,
      stepId: instance.stepId,
      callId: instance.callId,
      ...payload,
    };
    if (instance.traceFile) {
      fs.mkdirSync(path.dirname(instance.traceFile), { recursive: true });
      fs.appendFileSync(instance.traceFile, `${JSON.stringify(event)}\n`, "utf8");
    }
    if (instance.evidenceFile && ["application.health.passed", "application.start.failed", "application.process.exited", "application.process.stopped", "application.update.failed", "application.update.rolled_back"].includes(type)) {
      fs.appendFileSync(instance.evidenceFile, `${JSON.stringify({ evidenceId: `evidence:${crypto.randomUUID()}`, kind: type, timestamp: event.timestamp, payload: event })}\n`, "utf8");
    }
    try { onEvent(event); } catch { /* observers cannot break lifecycle */ }
    return event;
  }

  function persist(instance) {
    if (instance.stateFile) atomicWriteJson(instance.stateFile, instance.public());
  }

  function writeReceipt(instance, operation, status, details = {}) {
    const receipt = {
      receiptId: `application-receipt:${crypto.randomUUID()}`,
      operation,
      status,
      timestamp: now(),
      projectId: instance.projectId,
      appId: instance.appId,
      versionId: instance.versionId,
      instanceId: instance.instanceId,
      processId: instance.processId,
      turnId: instance.turnId,
      stepId: instance.stepId,
      callId: instance.callId,
      ...details,
    };
    if (instance.receiptFile) atomicWriteJson(instance.receiptFile, receipt);
    try { onReceipt(receipt); } catch { /* observers cannot break lifecycle */ }
    emit(instance, `application.${operation}.${status}`, { receiptId: receipt.receiptId, receipt });
    return receipt;
  }

  function resolveApplication(projectPath, appId, manifestInput) {
    const projectRoot = path.resolve(projectPath);
    const applicationsRoot = path.join(projectRoot, ".capybara", "applications");
    let applicationDirectoryName = safeId(appId || "", "");
    if (applicationDirectoryName && fs.existsSync(applicationsRoot) && !fs.existsSync(path.join(applicationsRoot, applicationDirectoryName, "manifest.json"))) {
      const matching = fs.readdirSync(applicationsRoot, { withFileTypes: true })
        .find((entry) => entry.isDirectory() && readJson(path.join(applicationsRoot, entry.name, "manifest.json"), {}).appId === appId);
      if (matching) applicationDirectoryName = matching.name;
    }
    if (!applicationDirectoryName && !manifestInput && fs.existsSync(applicationsRoot)) {
      const candidates = fs.readdirSync(applicationsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(applicationsRoot, entry.name, "manifest.json")));
      if (candidates.length === 1) applicationDirectoryName = candidates[0].name;
    }
    if (!applicationDirectoryName) applicationDirectoryName = safeId(path.basename(projectRoot), "application");
    const applicationRoot = path.join(applicationsRoot, applicationDirectoryName);
    const manifestFile = path.join(applicationRoot, "manifest.json");
    const projectManifestFile = path.join(projectRoot, ".capybara", "application.json");
    const raw = manifestInput || (fs.existsSync(manifestFile) ? readJson(manifestFile, {}) : fs.existsSync(projectManifestFile) ? readJson(projectManifestFile, {}) : {});
    const manifest = normalizeManifest(projectRoot, raw, appId);
    fs.mkdirSync(applicationRoot, { recursive: true });
    atomicWriteJson(manifestFile, manifest);
    const sourceRoot = path.resolve(projectRoot, manifest.sourceRoot);
    const versionsRoot = path.join(applicationRoot, "versions");
    const projectKey = crypto.createHash("sha1").update(projectRoot).digest("hex").slice(0, 16);
    const artifactVersionsRoot = path.join(path.resolve(artifactStoreRoot), projectKey, manifest.appId, "versions");
    const instancesRoot = path.join(applicationRoot, "instances");
    fs.mkdirSync(versionsRoot, { recursive: true });
    fs.mkdirSync(artifactVersionsRoot, { recursive: true });
    fs.mkdirSync(instancesRoot, { recursive: true });
    const dataRoot = path.resolve(projectRoot, manifest.dataDirectory);
    if (!isInside(projectRoot, dataRoot)) throw new Error("application dataDirectory must stay inside the project");
    fs.mkdirSync(dataRoot, { recursive: true });
    return { projectRoot, applicationRoot, manifestFile, manifest, sourceRoot, versionsRoot, artifactVersionsRoot, instancesRoot, dataRoot };
  }

  function updateManifestState(app, { runtime, versions } = {}) {
    app.manifest = {
      ...app.manifest,
      ...(versions ? { versions: { ...(app.manifest.versions || {}), ...versions } } : {}),
      ...(runtime ? { runtime: { ...(app.manifest.runtime || {}), ...runtime } } : {}),
      updatedAt: now(),
    };
    atomicWriteJson(app.manifestFile, app.manifest);
    return app.manifest;
  }

  function stageVersion(app) {
    const sourceHash = hashDirectory(app.sourceRoot);
    let versionId = app.manifest.versionId;
    const versionRoot = path.join(app.versionsRoot, versionId);
    const versionFile = path.join(versionRoot, "manifest.json");
    const existing = fs.existsSync(versionFile) ? readJson(versionFile, null) : null;
    if (existing && (!existing.sourceHash || existing.sourceHash !== sourceHash)) {
      versionId = `version-${Date.now()}-${sourceHash.slice(0, 8)}`;
      app.manifest.versionId = versionId;
      atomicWriteJson(app.manifestFile, app.manifest);
    }
    const nextVersionRoot = path.join(app.versionsRoot, versionId);
    const nextArtifactRoot = path.join(app.artifactVersionsRoot, versionId, "artifact");
    const nextVersionFile = path.join(nextVersionRoot, "manifest.json");
    const nextExisting = fs.existsSync(nextVersionFile) ? readJson(nextVersionFile, null) : null;
    if (!nextExisting || !fs.existsSync(nextArtifactRoot)) {
      fs.rmSync(nextArtifactRoot, { recursive: true, force: true });
      fs.mkdirSync(nextVersionRoot, { recursive: true });
      fs.mkdirSync(path.dirname(nextArtifactRoot), { recursive: true });
      // Node refuses to copy a directory into a descendant of itself before
      // the filter is evaluated. Stage outside the project first, then move
      // the completed immutable snapshot into the project store.
      const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-artifact-"));
      const stagingArtifact = path.join(stagingRoot, "artifact");
      try {
        fs.cpSync(app.sourceRoot, stagingArtifact, { recursive: true, force: true, dereference: false, filter: (source) => !source.includes(`${path.sep}.capybara${path.sep}`) && !source.endsWith(`${path.sep}.capybara`) && !source.includes(`${path.sep}.git${path.sep}`) });
        try {
          fs.renameSync(stagingArtifact, nextArtifactRoot);
        } catch (error) {
          if (error?.code !== "EXDEV") throw error;
          fs.cpSync(stagingArtifact, nextArtifactRoot, { recursive: true, force: true, dereference: false });
        }
      } finally {
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      }
      const staged = { ...app.manifest, sourceRoot: ".", sourceHash, artifactHash: hashDirectory(nextArtifactRoot), createdAt: now(), status: "staged" };
      atomicWriteJson(nextVersionFile, staged);
      updateManifestState(app, { versions: { latestGenerated: versionId, currentDraft: versionId } });
      return { versionId, versionRoot: nextVersionRoot, artifactRoot: nextArtifactRoot, manifest: staged, created: true };
    }
    return { versionId, versionRoot: nextVersionRoot, artifactRoot: nextArtifactRoot, manifest: nextExisting, created: false };
  }

  function loadVersion(app, versionId) {
    const safeVersionId = safeId(versionId, "");
    if (!safeVersionId) throw new Error("versionId is required");
    const versionRoot = path.join(app.versionsRoot, safeVersionId);
    const artifactRoot = path.join(app.artifactVersionsRoot, safeVersionId, "artifact");
    const legacyArtifactRoot = path.join(versionRoot, "artifact");
    const versionFile = path.join(versionRoot, "manifest.json");
    const manifest = readJson(versionFile, null);
    if (!fs.existsSync(artifactRoot) && fs.existsSync(legacyArtifactRoot)) {
      fs.mkdirSync(path.dirname(artifactRoot), { recursive: true });
      fs.cpSync(legacyArtifactRoot, artifactRoot, { recursive: true, force: true, dereference: false });
    }
    if (!manifest || !fs.existsSync(artifactRoot)) throw new Error(`application version ${versionId} is unavailable`);
    return { versionId: safeVersionId, versionRoot, artifactRoot, manifest, created: false };
  }

  function baseEnv(app, instance, port) {
    const env = {};
    for (const key of SAFE_ENV_KEYS) if (typeof process.env[key] === "string") env[key] = process.env[key];
    const declared = app.manifest.environment && typeof app.manifest.environment === "object" ? app.manifest.environment : {};
    for (const [key, value] of Object.entries(declared)) {
      if (/key|token|secret|password|credential/i.test(key)) continue;
      if (/^[A-Z_][A-Z0-9_]*$/i.test(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) env[key] = String(value);
    }
    env[app.manifest.port.environment] = String(port);
    env.PORT = String(port);
    env.CAPYBARA_APP_ID = instance.appId;
    env.CAPYBARA_APP_VERSION = instance.versionId;
    env.CAPYBARA_INSTANCE_ID = instance.instanceId;
    env.CAPYBARA_PROJECT_ID = instance.projectId || "";
    env.CAPYBARA_DATA_DIR = instance.dataDirectory;
    env.DATA_DIR = instance.dataDirectory;
    env.CAPYBARA_RUN_ID = instance.instanceId;
    env.CAPYBARA_PATH_GUARD = "on";
    const nodeRuntimeRoot = process.versions.electron
      ? path.dirname(process.env.CAPYBARA_NODE_EXECUTABLE || "C:/Program Files/nodejs/node.exe")
      : path.dirname(process.execPath);
    env.CAPYBARA_ALLOWED_ROOTS = JSON.stringify([instance.artifactRoot, instance.dataDirectory, instance.tempDirectory, nodeRuntimeRoot]);
    env.TEMP = instance.tempDirectory;
    env.TMP = instance.tempDirectory;
    const binDirectory = path.join(instance.artifactRoot, "node_modules", ".bin");
    const pathValue = [binDirectory, env.Path || env.PATH].filter(Boolean).join(path.delimiter);
    env.Path = pathValue;
    env.PATH = pathValue;
    const guardPath = path.join(__dirname, "application-path-guard.cjs").replaceAll("\\", "/");
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ""} --require "${guardPath}"`.trim();
    const pythonGuardDirectory = path.join(__dirname).replaceAll("\\", "/");
    env.PYTHONPATH = [pythonGuardDirectory, env.PYTHONPATH].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
    return env;
  }

  async function runCommand(commandValue, args, cwd, env, timeoutMs, outputFiles) {
    const parsed = parseCommand(commandValue, args);
    const resolved = resolvePackageScript(parsed.command, parsed.args, cwd);
    const { command, args: normalizedArgs } = spawnSpec(resolved.command, resolved.args);
    return await new Promise((resolve, reject) => {
      const child = spawn(command, normalizedArgs, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const append = (stream, chunk) => {
        const text = String(chunk);
        if (stream === "stdout") stdout = `${stdout}${text}`.slice(-MAX_LOG_CHARS);
        else stderr = `${stderr}${text}`.slice(-MAX_LOG_CHARS);
        if (outputFiles?.[stream]) fs.appendFileSync(outputFiles[stream], text, "utf8");
      };
      child.stdout.on("data", (chunk) => append("stdout", chunk));
      child.stderr.on("data", (chunk) => append("stderr", chunk));
      const timer = setTimeout(() => {
        if (process.platform === "win32") spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
        else child.kill("SIGTERM");
        reject(new Error(`command timed out after ${timeoutMs}ms: ${commandValue}`));
      }, timeoutMs);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, pid: child.pid }); });
    });
  }

  async function healthCheck(instance, manifest) {
    const candidates = [manifest.health.path, "/api/health", "/health", "/"].filter((value, index, values) => typeof value === "string" && values.indexOf(value) === index);
    const deadline = Date.now() + manifest.health.startupTimeoutMs;
    let lastError = "health check has not returned 2xx";
    while (Date.now() < deadline) {
      if (instance.child && instance.child.exitCode !== null) throw new Error(`application process exited with code ${instance.child.exitCode}`);
      for (const candidate of candidates) {
        const result = await new Promise((resolve) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), manifest.health.timeoutMs);
          fetch(`http://127.0.0.1:${instance.port}${candidate}`, { signal: controller.signal, headers: { "x-capybara-health-check": "1" } }).then(async (response) => {
            const body = await response.text().catch(() => "");
            resolve({ ok: response.ok, status: response.status, body: body.slice(0, 500), path: candidate });
          }).catch((error) => resolve({ ok: false, error: error instanceof Error ? error.message : String(error), path: candidate })).finally(() => clearTimeout(timer));
        });
        if (result.ok) return result;
        lastError = result.error || `HTTP ${result.status} at ${candidate}`;
      }
      await wait(150);
    }
    throw new Error(lastError);
  }

  async function start(input) {
    if (!input || typeof input.projectPath !== "string") throw new Error("projectPath is required");
    const app = resolveApplication(input.projectPath, input.appId, input.manifest);
    // A recovered snapshot represents an instance owned by a previous
    // Electron process. Starting the application creates the new authoritative
    // instance; do not leave the stale unknown snapshot competing with it in
    // the status list.
    for (const [recoveredId, recovered] of restored.entries()) {
      if (recovered._projectPath === app.projectRoot && recovered.appId === app.manifest.appId) {
        restored.delete(recoveredId);
      }
    }
    const version = input.versionId ? loadVersion(app, input.versionId) : stageVersion(app);
    const existing = [...active.values()].find((item) => item.projectPath === app.projectRoot && item.appId === app.manifest.appId && ["starting", "health_checking", "running", "degraded"].includes(item.status));
    if (existing) return existing.public();
    const instanceId = `instance:${crypto.randomUUID()}`;
    const instanceRoot = path.join(app.instancesRoot, safeId(instanceId, "instance"));
    const logsRoot = path.join(instanceRoot, "logs");
    const tempDirectory = path.join(os.tmpdir(), "capybara-application-temp", safeId(instanceId, "instance"));
    fs.mkdirSync(logsRoot, { recursive: true });
    fs.mkdirSync(tempDirectory, { recursive: true });
    const port = app.manifest.port.mode === "fixed" && Number.isInteger(app.manifest.port.value) ? app.manifest.port.value : await reservePort();
    const instance = {
      projectPath: app.projectRoot,
      projectId: input.projectId || app.manifest.projectId || `project:${crypto.createHash("sha1").update(app.projectRoot).digest("hex").slice(0, 12)}`,
      appId: app.manifest.appId,
      versionId: version.versionId,
      instanceId,
      processId: `process:${crypto.randomUUID()}`,
      pid: null,
      port,
      status: "starting",
      health: { status: "pending" },
      startedAt: now(),
      readyAt: null,
      stoppedAt: null,
      exitCode: null,
      signal: null,
      error: null,
      stdout: [],
      stderr: [],
      dataDirectory: path.resolve(app.projectRoot, app.manifest.dataDirectory),
      artifactRoot: version.artifactRoot,
      tempDirectory,
      browserUrl: `http://127.0.0.1:${port}${app.manifest.browser.entryPath}`,
      turnId: input.turnId,
      stepId: input.stepId,
      callId: input.callId,
      stateFile: path.join(instanceRoot, "instance.json"),
      stdoutFile: path.join(logsRoot, "stdout.log"),
      stderrFile: path.join(logsRoot, "stderr.log"),
      traceFile: path.join(instanceRoot, "trace.jsonl"),
      evidenceFile: path.join(instanceRoot, "evidence.jsonl"),
      receiptFile: path.join(instanceRoot, "receipt.json"),
      public() {
        return {
          projectId: this.projectId,
          appId: this.appId,
          versionId: this.versionId,
          instanceId: this.instanceId,
          processId: this.processId,
          pid: this.pid,
          port: this.port,
          status: this.status,
          health: this.health,
          startedAt: this.startedAt,
          readyAt: this.readyAt,
          stoppedAt: this.stoppedAt,
          exitCode: this.exitCode,
          signal: this.signal,
          error: this.error,
          stdout: this.stdout.join(""),
          stderr: this.stderr.join(""),
          dataDirectory: this.dataDirectory,
          browserUrl: this.browserUrl,
          manifest: version.manifest,
          traceAvailable: fs.existsSync(this.traceFile),
          evidenceAvailable: fs.existsSync(this.evidenceFile),
          receiptAvailable: fs.existsSync(this.receiptFile),
        };
      },
    };
    updateManifestState(app, {
      runtime: { status: "starting", runningVersionId: version.versionId, instanceId: instance.instanceId, processId: instance.processId, lastError: null },
      versions: { currentDraft: version.versionId },
    });
    active.set(instance.instanceId, instance);
    persist(instance);
    emit(instance, "application.process.started", { status: instance.status, port });
    try {
      const workingDirectory = path.resolve(version.artifactRoot, app.manifest.workingDirectory || ".");
      if (!isInside(version.artifactRoot, workingDirectory)) throw new Error("application workingDirectory must stay inside the version artifact");
      if (app.manifest.build.command && version.manifest.status !== "built") {
        emit(instance, "application.build.started", { command: app.manifest.build.command });
        const buildResult = await runCommand(app.manifest.build.command, app.manifest.build.args, version.artifactRoot, baseEnv(app, instance, port), app.manifest.build.timeoutMs, { stdout: path.join(logsRoot, "build.stdout.log"), stderr: path.join(logsRoot, "build.stderr.log") });
        if (buildResult.code !== 0) throw new Error(`application build exited with code ${buildResult.code}`);
        version.manifest.status = "built";
        atomicWriteJson(path.join(version.versionRoot, "manifest.json"), version.manifest);
        emit(instance, "application.build.completed", { pid: buildResult.pid });
      }
      lockArtifact(version.artifactRoot);
      const parsedStartCommand = parseCommand(app.manifest.start.command, app.manifest.start.args);
      const resolvedStartCommand = resolvePackageScript(parsedStartCommand.command, parsedStartCommand.args, workingDirectory);
      const startCommand = spawnSpec(resolvedStartCommand.command, resolvedStartCommand.args);
      instance.child = spawn(startCommand.command, startCommand.args, { cwd: workingDirectory, env: baseEnv(app, instance, port), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      instance.pid = instance.child.pid;
      instance.child.stdout.on("data", (chunk) => { boundedPush(instance.stdout, chunk); fs.appendFileSync(instance.stdoutFile, String(chunk), "utf8"); emit(instance, "application.process.stdout", { chunk: String(chunk).slice(-4_000) }); persist(instance); });
      instance.child.stderr.on("data", (chunk) => { boundedPush(instance.stderr, chunk); fs.appendFileSync(instance.stderrFile, String(chunk), "utf8"); emit(instance, "application.process.stderr", { chunk: String(chunk).slice(-4_000) }); persist(instance); });
      instance.child.once("error", (error) => { instance.error = error.message; instance.status = "failed"; emit(instance, "application.process.failed", { message: error.message }); persist(instance); });
      instance.child.once("exit", (code, signal) => { instance.exitCode = code; instance.signal = signal; instance.stoppedAt = now(); if (!["stopping", "stopped"].includes(instance.status)) instance.status = code === 0 ? "stopped" : "failed"; updateManifestState(app, { runtime: { status: instance.status === "failed" ? "error" : "stopped", runningVersionId: instance.versionId, instanceId: null, processId: null, lastError: instance.status === "failed" ? `process exited with code ${code}` : null } }); emit(instance, "application.process.exited", { code, signal, status: instance.status }); persist(instance); });
      emit(instance, "application.health.started", { pid: instance.pid, url: instance.browserUrl });
      instance.status = "health_checking";
      persist(instance);
      const health = await healthCheck(instance, app.manifest);
      instance.health = { ...health, status: "healthy", httpStatus: health.status };
      instance.status = "running";
      instance.readyAt = now();
      updateManifestState(app, {
        runtime: { status: "running", runningVersionId: instance.versionId, instanceId: instance.instanceId, processId: instance.processId, healthCheckRef: `${instance.instanceId}:health`, lastError: null },
        versions: { runningVersionId: instance.versionId, deployedVersionId: instance.versionId, latestVerified: instance.versionId },
      });
      emit(instance, "application.health.passed", { health, url: instance.browserUrl });
      writeReceipt(instance, "start", "succeeded", { pid: instance.pid, port: instance.port, health });
      persist(instance);
      return instance.public();
    } catch (error) {
      instance.error = error instanceof Error ? error.message : String(error);
      instance.status = "failed";
      updateManifestState(app, { runtime: { status: "error", runningVersionId: instance.versionId, instanceId: instance.instanceId, processId: instance.processId, lastError: instance.error } });
      emit(instance, "application.start.failed", { message: instance.error });
      writeReceipt(instance, "start", "failed", { error: instance.error });
      persist(instance);
      await stop({ projectPath: app.projectRoot, instanceId: instance.instanceId, reason: "start-failed" }).catch(() => undefined);
      throw error;
    }
  }

  async function stop(input) {
    const instance = input?.instanceId ? active.get(input.instanceId) : [...active.values()].find((item) => item.projectPath === path.resolve(input?.projectPath || "") && (!input.appId || item.appId === input.appId));
    if (!instance) return { stopped: false, status: "unknown" };
    let app;
    try { app = resolveApplication(instance.projectPath, instance.appId); } catch { app = undefined; }
    if (!instance.child || instance.child.exitCode !== null || instance.child.killed) {
      instance.status = instance.status === "failed" ? "failed" : "stopped";
      instance.stoppedAt = instance.stoppedAt || now();
      if (app) updateManifestState(app, { runtime: { status: instance.status === "failed" ? "error" : "stopped", runningVersionId: instance.versionId, instanceId: null, processId: null, lastError: instance.error || null } });
      persist(instance);
      return instance.public();
    }
    instance.status = "stopping";
    emit(instance, "application.process.stopping", { reason: input?.reason || "user" });
    persist(instance);
    if (process.platform === "win32") spawn("taskkill.exe", ["/pid", String(instance.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    else instance.child.kill("SIGTERM");
    const deadline = Date.now() + 10_000;
    while (instance.child.exitCode === null && Date.now() < deadline) await wait(50);
    if (instance.child.exitCode === null) {
      if (process.platform === "win32") spawn("taskkill.exe", ["/pid", String(instance.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      else instance.child.kill("SIGKILL");
    }
    instance.status = "stopped";
    instance.stoppedAt = instance.stoppedAt || now();
    if (app) updateManifestState(app, { runtime: { status: "stopped", runningVersionId: instance.versionId, instanceId: null, processId: null, lastError: null } });
    emit(instance, "application.process.stopped", { exitCode: instance.exitCode, signal: instance.signal });
    writeReceipt(instance, "stop", "succeeded", { exitCode: instance.exitCode, signal: instance.signal });
    persist(instance);
    return instance.public();
  }

  async function restart(input) {
    await stop(input);
    return start(input);
  }

  async function update(input) {
    const current = input?.instanceId ? active.get(input.instanceId) : [...active.values()].find((item) => item.projectPath === path.resolve(input?.projectPath || "") && (!input.appId || item.appId === input.appId));
    const previousVersionId = current?.versionId;
    if (current) await stop({ instanceId: current.instanceId, reason: "update" });
    try {
      const next = await start(input);
      const app = resolveApplication(input.projectPath, input.appId, input.manifest);
      writeReceipt(active.get(next.instanceId), "update", "succeeded", { previousVersionId: previousVersionId || null, nextVersionId: next.versionId });
      return { ...next, previousVersionId: previousVersionId || null, operation: "update" };
    } catch (error) {
      const updateError = error instanceof Error ? error.message : String(error);
      if (previousVersionId) {
        try {
          const restored = await start({ ...input, versionId: previousVersionId });
          const restoredInstance = active.get(restored.instanceId);
          if (restoredInstance) {
            writeReceipt(restoredInstance, "update", "rolled_back", {
              previousVersionId,
              restoredVersionId: previousVersionId,
              error: updateError,
            });
          }
          return {
            ...restored,
            previousVersionId,
            restoredVersionId: previousVersionId,
            updateError,
            operation: "update_rolled_back",
          };
        } catch (rollbackError) {
          const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          const combined = new Error(`application update failed (${updateError}); rollback failed (${rollbackMessage})`);
          combined.cause = error;
          throw combined;
        }
      }
      throw error;
    }
  }

  async function rollback(input) {
    if (!input?.targetVersionId) throw new Error("targetVersionId is required");
    const current = input?.instanceId ? active.get(input.instanceId) : [...active.values()].find((item) => item.projectPath === path.resolve(input?.projectPath || "") && (!input.appId || item.appId === input.appId));
    const failedVersionId = current?.versionId || input.failedVersionId || null;
    if (current) await stop({ instanceId: current.instanceId, reason: "rollback" });
    const next = await start({ ...input, versionId: input.targetVersionId });
    const instance = active.get(next.instanceId);
    writeReceipt(instance, "rollback", "succeeded", { failedVersionId, targetVersionId: input.targetVersionId, reason: input.reason || "user" });
    return { ...next, failedVersionId, targetVersionId: input.targetVersionId, operation: "rollback" };
  }

  function list(input = {}) {
    const projectPath = input.projectPath ? path.resolve(input.projectPath) : undefined;
    const live = [...active.values()].filter((item) => !projectPath || item.projectPath === projectPath).map((item) => item.public());
    const recovered = [...restored.values()].filter((item) => !projectPath || item._projectPath === projectPath).map((item) => {
      const { _projectPath, _stateFile, ...publicValue } = item;
      return publicValue;
    });
    return [...live, ...recovered];
  }

  function listReceipts(input = {}) {
    if (typeof input.projectPath !== "string" || !input.projectPath.trim()) return [];
    const projectPath = path.resolve(input.projectPath);
    const applicationsRoot = path.join(projectPath, ".capybara", "applications");
    if (!fs.existsSync(applicationsRoot)) return [];
    const receipts = new Map();
    const addReceipt = (value, fallback = {}) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const receiptId = typeof value.receiptId === "string" && value.receiptId.trim() ? value.receiptId : undefined;
      if (!receiptId) return;
      receipts.set(receiptId, { ...fallback, ...value, id: receiptId });
    };
    for (const applicationEntry of fs.readdirSync(applicationsRoot, { withFileTypes: true })) {
      if (!applicationEntry.isDirectory()) continue;
      const instancesRoot = path.join(applicationsRoot, applicationEntry.name, "instances");
      if (!fs.existsSync(instancesRoot)) continue;
      for (const instanceEntry of fs.readdirSync(instancesRoot, { withFileTypes: true })) {
        if (!instanceEntry.isDirectory()) continue;
        const instanceRoot = path.join(instancesRoot, instanceEntry.name);
        const traceFile = path.join(instanceRoot, "trace.jsonl");
        try {
          if (fs.existsSync(traceFile)) {
            for (const line of fs.readFileSync(traceFile, "utf8").split(/\r?\n/)) {
              if (!line.trim()) continue;
              const event = JSON.parse(line);
              const receipt = event?.receipt ?? event?.payload?.receipt;
              if (receipt) addReceipt(receipt, { eventType: event.type });
            }
          }
        } catch {
          // A partially written trace must not make the status view fail.
        }
        addReceipt(readJson(path.join(instanceRoot, "receipt.json"), null), { eventType: "application.receipt.recovered" });
      }
    }
    return [...receipts.values()].sort((a, b) => String(a.timestamp || a.createdAt || "").localeCompare(String(b.timestamp || b.createdAt || "")));
  }

  function recover(input) {
    const projectRoot = path.resolve(input.projectPath);
    const applicationsRoot = path.join(projectRoot, ".capybara", "applications");
    if (!fs.existsSync(applicationsRoot)) return [];
    const recovered = [];
    for (const applicationEntry of fs.readdirSync(applicationsRoot, { withFileTypes: true })) {
      if (!applicationEntry.isDirectory()) continue;
      const instancesRoot = path.join(applicationsRoot, applicationEntry.name, "instances");
      if (!fs.existsSync(instancesRoot)) continue;
      for (const instanceEntry of fs.readdirSync(instancesRoot, { withFileTypes: true })) {
        if (!instanceEntry.isDirectory()) continue;
        const stateFile = path.join(instancesRoot, instanceEntry.name, "instance.json");
        const value = readJson(stateFile, null);
        if (!value || !value.instanceId || !["running", "starting", "health_checking", "stopping"].includes(value.status)) continue;
        const snapshot = { ...value, status: "unknown", error: "Electron 重启后原进程不再由当前宿主持有，需要重新启动", _projectPath: projectRoot, _stateFile: stateFile };
        restored.set(snapshot.instanceId, snapshot);
        const { _projectPath, _stateFile, ...publicValue } = snapshot;
        atomicWriteJson(stateFile, publicValue);
        recovered.push({ ...snapshot });
        try { onEvent({ type: "application.process.recovered", timestamp: now(), projectId: snapshot.projectId, appId: snapshot.appId, versionId: snapshot.versionId, instanceId: snapshot.instanceId, processId: snapshot.processId, status: "unknown", message: snapshot.error }); } catch { /* observers cannot break recovery */ }
      }
    }
    return recovered.map(({ _projectPath, _stateFile, ...value }) => value);
  }

  function listVersions(input) {
    const app = resolveApplication(input.projectPath, input.appId, input.manifest);
    return fs.readdirSync(app.versionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJson(path.join(app.versionsRoot, entry.name, "manifest.json"), null))
      .filter(Boolean)
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  }

  async function closeAll() {
    for (const instance of [...active.values()]) await stop({ instanceId: instance.instanceId, reason: "workbench-shutdown" }).catch(() => undefined);
    active.clear();
  }

  return { start, stop, restart, update, rollback, healthCheck: async (input) => { const instance = active.get(input?.instanceId); if (!instance) throw new Error("application instance not found"); const app = resolveApplication(instance.projectPath, instance.appId); const health = await healthCheck(instance, app.manifest); instance.health = { ...health, status: "healthy", httpStatus: health.status }; persist(instance); return instance.public(); }, list, listReceipts, recover, listVersions, closeAll, resolveApplication, stageVersion, loadVersion };
}

module.exports = { createApplicationProcessSupervisor, normalizeManifest, parseCommand, reservePort };
