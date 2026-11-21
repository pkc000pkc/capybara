const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createApplicationProcessSupervisor } = require("../electron/application-process-supervisor.cjs");

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-application-host-"));
  write(path.join(root, "package.json"), JSON.stringify({
    scripts: { start: "node server.js" },
  }));
  write(path.join(root, "server.js"), `
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.env.PORT);
const data = process.env.CAPYBARA_DATA_DIR;
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(require('node:path').join(data, 'started.txt'), 'yes');
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify({status:'ok'})); return; }
  res.writeHead(200, {'content-type':'text/html'}); res.end('<!doctype html><title>fixture</title>ok');
});
server.listen(port, '127.0.0.1', () => console.log('[fixture] listening ' + port));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
`);
  return root;
}

test("ApplicationProcessSupervisor starts a standard web app with a dynamic port and records evidence", async () => {
  const projectPath = createFixture();
  const events = [];
  const receipts = [];
  const supervisor = createApplicationProcessSupervisor({ onEvent: (event) => events.push(event), onReceipt: (receipt) => receipts.push(receipt) });
  const staged = supervisor.stageVersion(supervisor.resolveApplication(projectPath));
  assert.equal(path.relative(projectPath, staged.artifactRoot).startsWith(".."), true);
  const instance = await supervisor.start({ projectPath, projectId: "project:test", turnId: "turn:1", stepId: "step:1", callId: "call:1" });

  assert.equal(instance.status, "running");
  assert.equal(instance.health.status, "healthy");
  assert.match(instance.instanceId, /^instance:/);
  assert.ok(instance.pid > 0);
  assert.ok(instance.port > 0);
  assert.match(instance.browserUrl, new RegExp(`127\\.0\\.0\\.1:${instance.port}`));
  assert.equal(instance.manifest.start.command, "npm");
  assert.equal(fs.existsSync(path.join(instance.dataDirectory, "started.txt")), true);
  assert.equal(events.some((event) => event.type === "application.health.passed"), true);
  assert.equal(events.some((event) => event.turnId === "turn:1" && event.callId === "call:1"), true);
  assert.equal(receipts.at(-1).operation, "start");
  assert.equal(instance.traceAvailable, true);
  assert.equal(instance.evidenceAvailable, true);
  assert.equal(instance.receiptAvailable, true);
  const manifestState = JSON.parse(fs.readFileSync(path.join(projectPath, ".capybara", "applications", path.basename(projectPath), "manifest.json"), "utf8"));
  assert.equal(manifestState.runtime.status, "running");
  assert.equal(manifestState.runtime.instanceId, instance.instanceId);

  const response = await fetch(instance.browserUrl);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /fixture/);

  const restarted = await supervisor.restart({ instanceId: instance.instanceId, projectPath });
  assert.equal(restarted.status, "running");
  assert.equal(fs.existsSync(path.join(restarted.dataDirectory, "started.txt")), true);
  const stopped = await supervisor.stop({ instanceId: restarted.instanceId });
  assert.equal(stopped.status, "stopped");
  const stoppedManifest = JSON.parse(fs.readFileSync(path.join(projectPath, ".capybara", "applications", path.basename(projectPath), "manifest.json"), "utf8"));
  assert.equal(stoppedManifest.runtime.status, "stopped");
  assert.equal(receipts.at(-1).operation, "stop");
  const replayed = supervisor.listReceipts({ projectPath });
  assert.equal(replayed.every((item) => typeof item.id === "string" && item.id === item.receiptId), true);
  assert.equal(replayed.some((item) => item.operation === "start" && item.turnId === "turn:1" && item.stepId === "step:1" && item.callId === "call:1"), true);
  assert.equal(replayed.some((item) => item.operation === "stop" && item.status === "succeeded"), true);
  await supervisor.closeAll();
});

test("ApplicationProcessSupervisor does not pass API keys to application processes", async () => {
  const projectPath = createFixture();
  write(path.join(projectPath, "server.js"), `
const http = require('node:http');
const port = Number(process.env.PORT);
const leaked = Boolean(process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || process.env.CAPYBARA_SECRET);
http.createServer((req, res) => { res.writeHead(req.url === '/health' && !leaked ? 200 : 500); res.end(leaked ? 'leaked' : 'ok'); }).listen(port, '127.0.0.1');
`);
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";
  const supervisor = createApplicationProcessSupervisor();
  try {
    const instance = await supervisor.start({ projectPath });
    assert.equal(instance.status, "running");
    await supervisor.stop({ instanceId: instance.instanceId });
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await supervisor.closeAll();
  }
});

test("ApplicationProcessSupervisor blocks a Node application from reading the project source tree", async () => {
  const projectPath = createFixture();
  const secret = path.join(projectPath, "secret.txt");
  write(secret, "must stay outside the artifact boundary\n");
  write(path.join(projectPath, "server.js"), `
const http = require('node:http');
const fs = require('node:fs');
let blocked = false;
try { fs.readFileSync(process.env.PROBE_PATH, 'utf8'); } catch (error) { blocked = error && error.code === 'CAPYBARA_PATH_DENIED'; }
const port = Number(process.env.PORT);
http.createServer((req, res) => { res.writeHead(req.url === '/health' && blocked ? 200 : 500); res.end(blocked ? 'blocked' : 'leaked'); }).listen(port, '127.0.0.1');
`);
  const supervisor = createApplicationProcessSupervisor();
  const instance = await supervisor.start({ projectPath, manifest: { environment: { PROBE_PATH: secret }, health: { path: "/health" } } });
  assert.equal((await fetch(new URL("/health", instance.browserUrl))).status, 200);
  await supervisor.stop({ instanceId: instance.instanceId });
  await supervisor.closeAll();
});

test("ApplicationProcessSupervisor can host a Python Web application with the same path boundary", async () => {
  const projectPath = createFixture();
  const secret = path.join(projectPath, "secret.txt");
  write(secret, "must stay outside the artifact boundary\n");
  write(path.join(projectPath, "server.py"), `
import http.server, os, socketserver
blocked = False
try:
    open(os.environ['PROBE_PATH'], 'r', encoding='utf-8').read()
except PermissionError:
    blocked = True
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200 if self.path == '/health' and blocked else 500)
        self.end_headers()
        self.wfile.write(b'blocked' if blocked else b'leaked')
    def log_message(self, *_args):
        pass
with socketserver.TCPServer(('127.0.0.1', int(os.environ['PORT'])), Handler) as server:
    server.serve_forever()
`);
  const supervisor = createApplicationProcessSupervisor();
  const instance = await supervisor.start({ projectPath, manifest: { start: { command: "py", args: ["-3", "server.py"] }, environment: { PROBE_PATH: secret }, health: { path: "/health" } } });
  assert.equal((await fetch(new URL("/health", instance.browserUrl))).status, 200);
  await supervisor.stop({ instanceId: instance.instanceId });
  await supervisor.closeAll();
});

test("ApplicationProcessSupervisor reports a failed health check", async () => {
  const projectPath = createFixture();
  write(path.join(projectPath, "server.js"), `require('node:http').createServer((_req, res) => { res.writeHead(503); res.end('not ready'); }).listen(Number(process.env.PORT), '127.0.0.1');`);
  const supervisor = createApplicationProcessSupervisor();
  await assert.rejects(() => supervisor.start({ projectPath, manifest: { health: { path: "/health", startupTimeoutMs: 1200 } } }), /HTTP 503|health check|fetch failed/);
  assert.equal(supervisor.list({ projectPath }).every((item) => ["failed", "stopped"].includes(item.status)), true);
  await supervisor.closeAll();
});

test("ApplicationProcessSupervisor creates a new version for update and can roll back", async () => {
  const projectPath = createFixture();
  const supervisor = createApplicationProcessSupervisor();
  const first = await supervisor.start({ projectPath });
  const firstVersion = first.versionId;
  fs.appendFileSync(path.join(projectPath, "server.js"), "\n// version 2\n", "utf8");
  const updated = await supervisor.update({ projectPath, instanceId: first.instanceId });
  assert.notEqual(updated.versionId, firstVersion);
  assert.equal(updated.operation, "update");
  const rolledBack = await supervisor.rollback({ projectPath, instanceId: updated.instanceId, targetVersionId: firstVersion, reason: "验证回滚" });
  assert.equal(rolledBack.targetVersionId, firstVersion);
  assert.equal(rolledBack.status, "running");
  await supervisor.closeAll();
});

test("ApplicationProcessSupervisor reports an update failure after restoring the previous version", async () => {
  const projectPath = createFixture();
  const supervisor = createApplicationProcessSupervisor();
  const first = await supervisor.start({ projectPath });
  const firstVersion = first.versionId;
  write(path.join(projectPath, "server.js"), `require('node:http').createServer((_req, res) => { res.writeHead(503); res.end('broken update'); }).listen(Number(process.env.PORT), '127.0.0.1');`);

  const restored = await supervisor.update({ projectPath, instanceId: first.instanceId });
  assert.equal(restored.operation, "update_rolled_back");
  assert.equal(restored.restoredVersionId, firstVersion);
  assert.match(restored.updateError, /HTTP 503|health check|fetch failed/);
  assert.equal(restored.status, "running");

  const replayed = supervisor.listReceipts({ projectPath });
  assert.equal(replayed.some((item) => item.operation === "update" && item.status === "rolled_back" && item.restoredVersionId === firstVersion), true);

  const receipts = supervisor.list({ projectPath });
  assert.equal(receipts.some((item) => item.instanceId === restored.instanceId && item.versionId === firstVersion), true);
  await supervisor.closeAll();
});

test("ApplicationProcessSupervisor restores an unowned running instance as unknown after host restart", async () => {
  const projectPath = createFixture();
  const firstSupervisor = createApplicationProcessSupervisor();
  const first = await firstSupervisor.start({ projectPath });
  const secondSupervisor = createApplicationProcessSupervisor();
  const recovered = secondSupervisor.recover({ projectPath });
  assert.equal(recovered.some((item) => item.instanceId === first.instanceId && item.status === "unknown"), true);
  assert.equal(secondSupervisor.list({ projectPath }).find((item) => item.instanceId === first.instanceId)?.status, "unknown");
  await firstSupervisor.stop({ instanceId: first.instanceId });
  await firstSupervisor.closeAll();
  await secondSupervisor.closeAll();
});

test("ApplicationProcessSupervisor keeps two project applications isolated", async () => {
  const firstProject = createFixture();
  const secondProject = createFixture();
  const supervisor = createApplicationProcessSupervisor();
  const [first, second] = await Promise.all([
    supervisor.start({ projectPath: firstProject, projectId: "project:first" }),
    supervisor.start({ projectPath: secondProject, projectId: "project:second" }),
  ]);
  assert.notEqual(first.port, second.port);
  assert.notEqual(first.instanceId, second.instanceId);
  assert.equal((await fetch(first.browserUrl)).status, 200);
  assert.equal((await fetch(second.browserUrl)).status, 200);
  await supervisor.closeAll();
});

test("ApplicationProcessSupervisor records an application crash as a failed start", async () => {
  const projectPath = createFixture();
  write(path.join(projectPath, "server.js"), "console.error('intentional crash'); process.exit(7);\n");
  const events = [];
  const supervisor = createApplicationProcessSupervisor({ onEvent: (event) => events.push(event) });
  await assert.rejects(() => supervisor.start({ projectPath }), /fetch failed|health check|process exited/);
  assert.equal(events.some((event) => event.type === "application.process.exited" && event.code === 7), true);
  await supervisor.closeAll();
});
