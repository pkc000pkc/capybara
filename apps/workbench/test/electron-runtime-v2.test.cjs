const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createRuntimeManager, migrateLegacyJsonSessions } = require("../electron/runtime-v2.cjs");

function response(value, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return JSON.stringify(value); } };
}

function chatFrame(sessionId, text) {
  return {
    version: 1,
    kind: "command",
    id: "command:1",
    type: "chat.message.send",
    sessionId,
    timestamp: new Date().toISOString(),
    payload: { clientMessageId: "message:client-1", content: [{ type: "text", text }], autoStart: true },
  };
}

async function waitFor(events, type) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const event = events.find((item) => item.type === type);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${type}`);
}

test("V2 runtime keeps sessions in system storage and runs chat through the main-process boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-runtime-v2-"));
  const storageFile = path.join(root, "runtime-v2.json");
  const events = [];
  const manager = createRuntimeManager({
    storageFile,
    env: { LLM_PROVIDER: "openai", LLM_MODEL: "gpt-6-luna", LLM_API_KEY: "test-key" },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.messages.at(-1).content, "你好");
      return response({ choices: [{ message: { content: "你好，我已经连接到本地 V2 Runtime。" } }] });
    },
    emit: ({ event }) => events.push(event),
  });

  const webContents = {};
  const connection = manager.connect({ workspaceId: "workspace:1", workspaceName: "任意本地目录", webContents });
  assert.match(connection.sessionId, /^session:/);
  assert.equal(events.find((item) => item.type === "runtime.snapshot").payload.contextScopes.activeScope, "session");
  await manager.send({ runtimeId: connection.runtimeId, webContents, frame: chatFrame(connection.sessionId, "你好") }).catch((error) => assert.fail(error));
  await waitFor(events, "chat.assistant.completed");

  const sessions = manager.listSessions({ workspaceId: "workspace:1" });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].requestCount, 1);
  assert.equal(fs.existsSync(storageFile), true);
  const persisted = JSON.parse(fs.readFileSync(storageFile, "utf8"));
  assert.equal(persisted.sessions[0].messages.length, 2);

  const restoredEvents = [];
  const restored = createRuntimeManager({ storageFile, env: { LLM_API_KEY: "test-key" }, emit: ({ event }) => restoredEvents.push(event) });
  restored.connect({ workspaceId: "workspace:1", workspaceName: "任意本地目录", sessionId: connection.sessionId, webContents: {} });
  const snapshot = restoredEvents.find((item) => item.type === "runtime.snapshot");
  assert.equal(snapshot.payload.conversation.messages.length, 2);
});

test("project runtime stores sessions in the opened project's .capybara SQLite database", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-project-runtime-v2-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const events = [];
  const manager = createRuntimeManager({
    env: { LLM_API_KEY: "test-key" },
    fetchImpl: async () => response({ choices: [{ message: { content: "已写入项目会话" } }] }),
    emit: ({ event }) => events.push(event),
  });
  const webContents = {};
  const connection = manager.connect({ workspaceId: "project:1", workspaceName: "项目", projectPath, webContents });
  await manager.send({ runtimeId: connection.runtimeId, webContents, frame: chatFrame(connection.sessionId, "保存会话") }).catch((error) => assert.fail(error));
  await waitFor(events, "chat.assistant.completed");
  const databaseFile = path.join(projectPath, ".capybara", "sessions.sqlite");
  assert.equal(fs.existsSync(databaseFile), true);
  manager.closeAll();
});

test("legacy system runtime sessions migrate into the matching project SQLite database", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-runtime-migration-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const legacyFile = path.join(root, "runtime-v2.json");
  fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, sessions: [{ id: "session:legacy", workspaceId: "project:1", workspaceName: "项目", name: "旧会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", requestCount: 1, revision: 1, messages: [] }] }), "utf8");
  const imported = migrateLegacyJsonSessions({ storageFile: legacyFile, projectRecords: [{ projectId: "project:1", selectedPath: projectPath }] });
  assert.equal(imported, 1);
  assert.equal(fs.existsSync(path.join(projectPath, ".capybara", "sessions.sqlite")), true);
  assert.equal(fs.existsSync(`${legacyFile}.migrated`), true);
});

test("V2 runtime loads the system project-files tool when the project has no tool manifest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-runtime-tools-v2-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(path.join(projectPath, "notes"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, "notes", "hello.txt"), "hello from the project\n", "utf8");
  const events = [];
  let requestCount = 0;
  const manager = createRuntimeManager({
    env: { LLM_API_KEY: "test-key", LLM_MODEL: "test-model" },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.ok(body.tools.some((tool) => tool.function.name === "list_files"));
      requestCount += 1;
      if (requestCount === 1) {
        return response({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call:list", type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "notes", recursive: false }) } }] } }] });
      }
      const toolMessage = body.messages.find((message) => message.role === "tool");
      assert.match(toolMessage.content, /hello\.txt/);
      return response({ choices: [{ message: { content: "已列出项目中的 notes 文件。" } }] });
    },
    emit: ({ event }) => events.push(event),
  });
  const webContents = {};
  const connection = manager.connect({ workspaceId: "project:tools", workspaceName: "工具项目", projectPath, webContents });
  await manager.send({ runtimeId: connection.runtimeId, webContents, frame: chatFrame(connection.sessionId, "列出 notes 目录") }).catch((error) => assert.fail(error));
  await waitFor(events, "chat.assistant.completed");
  assert.equal(events.some((event) => event.type === "tool.call.completed" && event.payload?.toolName === "list_files"), true);
  manager.closeAll();
});

test("V2 runtime exposes manage_application and keeps turn, step and call identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-runtime-application-v2-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const events = [];
  let requestCount = 0;
  const manager = createRuntimeManager({
    env: { LLM_API_KEY: "test-key", LLM_MODEL: "test-model" },
    applicationHost: async (input) => ({ id: input.callId, name: "manage_application", ok: true, output: { status: "running", instanceId: "instance:test", pid: 1234, port: 4317 }, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), durationMs: 2 }),
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.ok(body.tools.some((tool) => tool.function.name === "manage_application"));
      requestCount += 1;
      if (requestCount === 1) {
        return response({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call:app", type: "function", function: { name: "manage_application", arguments: JSON.stringify({ action: "start" }) } }] } }] });
      }
      assert.ok(body.messages.some((message) => message.role === "tool" && /running/.test(message.content)));
      return response({ choices: [{ message: { content: "应用已经启动并通过系统健康检查。" } }] });
    },
    emit: ({ event }) => events.push(event),
  });
  const webContents = {};
  const connection = manager.connect({ workspaceId: "project:application", workspaceName: "应用项目", projectPath, webContents });
  await manager.send({ runtimeId: connection.runtimeId, webContents, frame: chatFrame(connection.sessionId, "启动项目应用") });
  await waitFor(events, "chat.assistant.completed");
  const started = events.find((event) => event.type === "tool.call.started" && event.payload?.toolName === "manage_application");
  const completed = events.find((event) => event.type === "tool.call.completed" && event.payload?.toolName === "manage_application");
  assert.ok(started && completed);
  assert.equal(started.payload.callId, "call:app");
  assert.equal(started.turnId, completed.turnId);
  assert.equal(started.stepId, completed.stepId);
  assert.equal(completed.payload.result.instanceId, "instance:test");
  manager.closeAll();
});

test("V2 runtime exposes thinking, correlated tool lifecycle, process state, and replayable trace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-runtime-trace-v2-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(path.join(projectPath, "notes"), { recursive: true });
  fs.writeFileSync(path.join(projectPath, "notes", "trace.txt"), "trace\n", "utf8");
  const events = [];
  let requestCount = 0;
  const manager = createRuntimeManager({
    env: { LLM_API_KEY: "test-key", LLM_MODEL: "test-model" },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      requestCount += 1;
      if (requestCount === 1) {
        return response({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call:trace", type: "function", function: { name: "list_files", arguments: JSON.stringify({ path: "notes", recursive: false }) } }] } }] });
      }
      assert.ok(body.messages.some((message) => message.role === "tool"));
      return response({ choices: [{ message: { content: "已完成并验证工具结果。" } }] });
    },
    emit: ({ event }) => events.push(event),
  });
  const webContents = {};
  const connection = manager.connect({ workspaceId: "project:trace", workspaceName: "轨迹项目", projectPath, webContents });
  await manager.send({ runtimeId: connection.runtimeId, webContents, frame: chatFrame(connection.sessionId, "读取 notes") });
  await waitFor(events, "chat.assistant.completed");
  const started = events.find((event) => event.type === "tool.call.started");
  const completed = events.find((event) => event.type === "tool.call.completed");
  assert.ok(started);
  assert.ok(completed);
  assert.equal(started.payload.callId, "call:trace");
  assert.equal(started.turnId, completed.turnId);
  assert.equal(started.stepId, completed.stepId);
  assert.equal(events.some((event) => event.type === "chat.assistant.delta" && event.payload.channel === "thinkingSummary"), true);
  assert.equal(events.some((event) => event.type === "runtime.processes.updated" && event.payload.items.some((item) => item.status === "running")), true);
  assert.equal(events.some((event) => event.type === "runtime.processes.updated" && event.payload.items.some((item) => item.status === "succeeded")), true);
  assert.equal(events.some((event) => event.type === "runtime.artifact.created" && event.payload.artifact.kind === "tool-result"), true);
  assert.equal(events.some((event) => event.type === "runtime.observation.upserted" && event.payload.observation.status === "completed"), true);
  manager.closeAll();

  const restoredEvents = [];
  const restored = createRuntimeManager({ storageFile: path.join(projectPath, ".capybara", "sessions.sqlite"), env: { LLM_API_KEY: "test-key" }, emit: ({ event }) => restoredEvents.push(event) });
  restored.connect({ workspaceId: "project:trace", workspaceName: "轨迹项目", projectPath, sessionId: connection.sessionId, webContents: {} });
  const snapshot = restoredEvents.find((event) => event.type === "runtime.snapshot");
  assert.ok(snapshot.payload.trace.some((event) => event.type === "tool.call.completed"));
  restored.closeAll();
});

test("V2 Responses protocol carries tools through the same lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-runtime-responses-v2-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const events = [];
  let requestCount = 0;
  const manager = createRuntimeManager({
    env: { LLM_API_KEY: "test-key", LLM_MODEL: "test-model", LLM_PROTOCOL: "responses" },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      requestCount += 1;
      assert.ok(Array.isArray(body.tools));
      if (requestCount === 1) {
        return response({ output: [{ type: "function_call", id: "fc_1", call_id: "call:responses", name: "list_files", arguments: JSON.stringify({ path: ".", recursive: false }) }] });
      }
      assert.ok(body.input.some((item) => item.type === "function_call_output"));
      return response({ output_text: "Responses 工具调用已完成。" });
    },
    emit: ({ event }) => events.push(event),
  });
  const webContents = {};
  const connection = manager.connect({ workspaceId: "project:responses", workspaceName: "Responses 项目", projectPath, webContents });
  await manager.send({ runtimeId: connection.runtimeId, webContents, frame: chatFrame(connection.sessionId, "列出项目文件") });
  await waitFor(events, "chat.assistant.completed");
  assert.equal(events.some((event) => event.type === "tool.call.completed" && event.payload.callId === "call:responses"), true);
  manager.closeAll();
});

test("V2 runtime records delegated child-agent lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-runtime-child-v2-"));
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath, { recursive: true });
  const events = [];
  let requestCount = 0;
  const manager = createRuntimeManager({
    env: { LLM_API_KEY: "test-key", LLM_MODEL: "test-model" },
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      requestCount += 1;
      if (requestCount === 1) {
        assert.ok(body.tools.some((tool) => tool.function.name === "delegate_task"));
        return response({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call:child", type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ goal: "核对文件", prompt: "请确认项目目录可访问" }) } }] } }] });
      }
      if (requestCount === 2) return response({ choices: [{ message: { content: "子智能体已核对项目目录。" } }] });
      assert.ok(body.messages.some((message) => message.role === "tool"));
      return response({ choices: [{ message: { content: "已合并子智能体结果。" } }] });
    },
    emit: ({ event }) => events.push(event),
  });
  const webContents = {};
  const connection = manager.connect({ workspaceId: "project:child", workspaceName: "子任务项目", projectPath, webContents });
  await manager.send({ runtimeId: connection.runtimeId, webContents, frame: chatFrame(connection.sessionId, "请委派核对") });
  await waitFor(events, "chat.assistant.completed");
  assert.equal(events.some((event) => event.type === "runtime.children.updated" && event.payload.items.some((item) => item.status === "running")), true);
  assert.equal(events.some((event) => event.type === "runtime.children.updated" && event.payload.items.some((item) => item.status === "succeeded")), true);
  manager.closeAll();
});
