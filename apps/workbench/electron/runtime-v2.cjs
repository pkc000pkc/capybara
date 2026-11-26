const crypto = require("node:crypto");
const os = require("node:os");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const Ajv = require("ajv");
const inputValidator = new Ajv({ strict: false, allErrors: true });

let DatabaseSync;
try { ({ DatabaseSync } = require("node:sqlite")); } catch { DatabaseSync = undefined; }

const { requestModel: requestJson } = require('./model-transport.cjs');

function now() {
  return new Date().toISOString();
}

const SYSTEM_CAPYBARA_ROOT = path.join(os.homedir(), ".capybara");
const DEFAULT_TOOL_MANIFEST = "tools/files/manifest.json";
const DEFAULT_SKILL_DIRECTORY = "skills/project-files";
const MAX_TOOL_OUTPUT_BYTES = 5 * 1024 * 1024;
const CHILD_AGENT_TOOL = {
  name: "delegate_task",
  description: "Delegate an independent research or analysis task to a child agent. The parent agent keeps final authority and must verify the returned result.",
  inputSchema: {
    type: "object",
    properties: {
      goal: { type: "string", minLength: 1, maxLength: 200 },
      prompt: { type: "string", minLength: 1, maxLength: 10000 },
    },
    required: ["goal", "prompt"],
    additionalProperties: false,
  },
};
const APPLICATION_TOOL = {
  name: "manage_application",
  description: "Start (including build), stop, restart or health-check the standard Web application belonging to the current project. The system owns the process and returns a verifiable instance receipt.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", minLength: 1, maxLength: 32 },
      app_id: { type: "string", minLength: 1, maxLength: 120 },
      instance_id: { type: "string", minLength: 1, maxLength: 160 },
    },
    required: ["action"],
    additionalProperties: false,
  },
};

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function fileReceipt(projectPath, fileName) {
  if (typeof fileName !== "string" || path.isAbsolute(fileName)) return undefined;
  const root = path.resolve(projectPath);
  const file = path.resolve(root, fileName);
  if (!inside(root, file)) return undefined;
  try {
    if (!inside(fs.realpathSync(root), fs.realpathSync(file))) return undefined;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return undefined;
    return { path: fileName, exists: true, bytes: stat.size, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
  } catch (error) { return error.code === "ENOENT" ? { path: fileName, exists: false } : undefined; }
}

function resolveResourceFile(projectPath, relativeFile) {
  if (typeof relativeFile !== "string" || !relativeFile.trim() || path.isAbsolute(relativeFile)) return undefined;
  const projectCandidate = path.resolve(projectPath, relativeFile);
  const systemCandidate = path.resolve(SYSTEM_CAPYBARA_ROOT, relativeFile);
  const hasProject = inside(path.resolve(projectPath), projectCandidate) && fs.existsSync(projectCandidate);
  const hasSystem = inside(SYSTEM_CAPYBARA_ROOT, systemCandidate) && fs.existsSync(systemCandidate);
  if (hasProject && hasSystem) {
    try {
      if (fs.readFileSync(projectCandidate).equals(fs.readFileSync(systemCandidate))) return systemCandidate;
    } catch {}
  }
  if (hasProject) return projectCandidate;
  if (hasSystem) return systemCandidate;
  return undefined;
}

function resolveResourceDirectory(projectPath, relativeDirectory) {
  if (typeof relativeDirectory !== "string" || !relativeDirectory.trim() || path.isAbsolute(relativeDirectory)) return undefined;
  const projectCandidate = path.resolve(projectPath, relativeDirectory);
  if (inside(path.resolve(projectPath), projectCandidate) && fs.existsSync(projectCandidate)) return projectCandidate;
  const systemCandidate = path.resolve(SYSTEM_CAPYBARA_ROOT, relativeDirectory);
  if (inside(SYSTEM_CAPYBARA_ROOT, systemCandidate) && fs.existsSync(systemCandidate)) return systemCandidate;
  return undefined;
}

function parseSkillDocument(file) {
  const content = fs.readFileSync(file, "utf8");
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return undefined;
  const frontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }
  if (!frontmatter.name || !frontmatter.description) return undefined;
  return { name: frontmatter.name, description: frontmatter.description, content: match[2].trim() };
}

function loadWorkspaceResources(projectPath) {
  const settings = readJsonFile(path.join(projectPath, ".capybara", "config.json"), readJsonFile(path.join(projectPath, "config.json"), {}));
  const configuredTools = Array.isArray(settings.tools) ? settings.tools.filter((item) => typeof item === "string") : [];
  const configuredSkills = Array.isArray(settings.skills) ? settings.skills.filter((item) => typeof item === "string") : [];
  const toolReferences = [...new Set([...configuredTools, DEFAULT_TOOL_MANIFEST])];
  const skillReferences = [...new Set([...configuredSkills, DEFAULT_SKILL_DIRECTORY])];
  const tools = [];
  for (const reference of toolReferences) {
    const manifestFiles = [resolveResourceFile(projectPath, reference)];
    const fallback = path.resolve(SYSTEM_CAPYBARA_ROOT, reference);
    if (inside(SYSTEM_CAPYBARA_ROOT, fallback) && fs.existsSync(fallback) && !manifestFiles.includes(fallback)) manifestFiles.push(fallback);
    for (const manifestFile of manifestFiles) {
      if (!manifestFile) continue;
    const manifest = readJsonFile(manifestFile, undefined);
    if (!manifest || !Array.isArray(manifest.tools) || !manifest.runner || typeof manifest.runner.entry !== "string") continue;
    const runnerEntry = path.resolve(path.dirname(manifestFile), manifest.runner.entry);
    if (!inside(path.dirname(manifestFile), runnerEntry) || !fs.existsSync(runnerEntry)) continue;
    for (const definition of manifest.tools) {
      if (!definition || typeof definition.name !== "string" || tools.some((tool) => tool.name === definition.name)) continue;
      tools.push({
        ...definition,
        id: `${manifest.package || "project-tools"}:${definition.name}`,
        packageName: manifest.package || "project-tools",
        runnerEntry,
      });
    }
    }
  }
  const skills = [];
  for (const reference of skillReferences) {
    const directory = resolveResourceDirectory(projectPath, reference);
    const entry = directory ? path.join(directory, "SKILL.md") : undefined;
    if (!entry || !fs.existsSync(entry)) continue;
    const skill = parseSkillDocument(entry);
    if (!skill || skills.some((item) => item.name === skill.name)) continue;
    skills.push({ ...skill, directory, entry });
  }
  const permissions = Array.isArray(settings.tool_permissions)
    ? settings.tool_permissions.filter((item) => typeof item === "string")
    : ["filesystem:read", "filesystem:write", "filesystem:delete", "process:execute"];
  return {
    tools, skills, permissions,
    timeoutMs: Math.max(100, Math.min(600000, Number(settings.tool_timeout_ms) || 150000)),
    maxToolRounds: Math.max(1, Math.min(100, Number(settings.max_tool_rounds) || 32)),
    maxOutputTokens: Math.max(256, Math.min(131072, Number(settings.llm?.max_output_tokens) || 16384)),
  };
}

function terminateRunner(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGTERM");
}

function runnerExecutable() {
  return process.versions.electron ? (process.env.CAPYBARA_NODE_EXECUTABLE || "node.exe") : process.execPath;
}

function runWorkspaceTool(tool, projectPath, permissions, argumentsValue, requestId, signal, timeoutMs = 15000, onSpawn) {
  const start = Date.now();
  const earlyFailure = (code, message) => Promise.resolve({ id: requestId, name: tool.name, ok: false, error: { code, message }, startedAt: new Date(start).toISOString(), completedAt: now(), durationMs: Date.now() - start });
  if (signal?.aborted) return earlyFailure("ABORTED", "工具执行已取消");
  const denied = (tool.permissions || []).filter((permission) => !permissions.includes(permission));
  if (denied.length > 0) return earlyFailure("PERMISSION_DENIED", `tool permissions not granted: ${denied.join(", ")}`);
  try {
    const validate = inputValidator.compile(tool.inputSchema);
    if (!validate(argumentsValue)) return earlyFailure("INVALID_ARGUMENTS", inputValidator.errorsText(validate.errors));
  } catch (error) { return earlyFailure("INVALID_SCHEMA", error.message); }
  return new Promise((resolve) => {
    const child = spawn(runnerExecutable(), [tool.runnerEntry], {
      cwd: path.dirname(tool.runnerEntry),
      env: { ...process.env, CAPYBARA_PROJECT_DIR: path.resolve(projectPath) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = now();
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ ...result, durationMs: Date.now() - start });
    };
    const fail = (code, message) => finish({ id: requestId, name: tool.name, ok: false, error: { code, message }, startedAt, completedAt: now() });
    const abort = () => { terminateRunner(child); fail("ABORTED", "tool call was aborted"); };
    const timer = setTimeout(() => { terminateRunner(child); fail("TIMEOUT", `tool call exceeded ${timeoutMs} ms`); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("spawn", () => onSpawn?.(String(child.pid)));
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_TOOL_OUTPUT_BYTES) { terminateRunner(child); fail("OUTPUT_LIMIT", `tool output exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes`); }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > MAX_TOOL_OUTPUT_BYTES) stderr = stderr.slice(-MAX_TOOL_OUTPUT_BYTES);
    });
    child.once("error", (error) => fail("RUNNER_FAILED", error.message));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) return fail("RUNNER_FAILED", stderr.trim() || `tool runner exited with code ${code}`);
      let response;
      try { response = JSON.parse(stdout); } catch { return fail("INVALID_RESPONSE", "tool runner did not return valid JSON"); }
      if (response.ok !== true) return fail(response.error?.code || "RUNNER_FAILED", typeof response.error === "string" ? response.error : response.error?.message || "tool runner reported an error");
      if (response.result?.timed_out || (typeof response.result?.exit_code === "number" && response.result.exit_code !== 0)) {
        return finish({ id: requestId, name: tool.name, ok: false, output: response.result, error: { code: response.result.timed_out ? "TIMEOUT" : "COMMAND_EXIT", message: response.result.timed_out ? "代码执行超时" : `进程退出码 ${response.result.exit_code}`, details: response.result }, startedAt, completedAt: now() });
      }
      finish({ id: requestId, name: tool.name, ok: true, output: response.result, startedAt, completedAt: now() });
    });
    child.stdin.end(JSON.stringify({ id: requestId, tool: tool.name, arguments: argumentsValue }));
  });
}

function loadLlmConfig(env = process.env) {
  const provider = String(env.LLM_PROVIDER || "openai").trim().toLowerCase();
  const baseUrl = String(env.LLM_BASE_URL || (provider === "deepseek" ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1")).replace(/\/$/, "");
  const model = String(env.LLM_MODEL || (provider === "deepseek" ? "deepseek-chat" : "gpt-6-luna")).trim();
  const protocol = String(env.LLM_PROTOCOL || "chat-completions").trim().toLowerCase();
  const apiKey = String(env.LLM_API_KEY || env.API_KEY || env.OPENAI_API_KEY || "").trim();
  return {
    provider,
    baseUrl,
    model,
    protocol,
    apiKey,
    timeoutMs: Number.parseInt(env.LLM_TIMEOUT_MS || "60000", 10),
  };
}

function loadState(storageFile) {
  if (!storageFile || !fs.existsSync(storageFile)) return { version: 1, sessions: [] };
  try {
    const value = JSON.parse(fs.readFileSync(storageFile, "utf8"));
    if (value && value.version === 1 && Array.isArray(value.sessions)) {
      if (!Array.isArray(value.traces)) value.traces = [];
      return value;
    }
  } catch {
    // A damaged local runtime index starts cleanly. User workspaces are not touched.
  }
  return { version: 1, sessions: [] };
}

function createJsonSessionStore(storageFile) {
  const state = loadState(storageFile);
  if (!Array.isArray(state.traces)) state.traces = [];
  function persist() {
    if (!storageFile) return;
    fs.mkdirSync(path.dirname(storageFile), { recursive: true });
    const temporary = `${storageFile}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, storageFile);
  }
  return {
    create(workspace) {
      const createdAt = now();
      const session = {
        id: `session:${crypto.randomUUID()}`,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName || "本地工作区",
        name: "新会话",
        createdAt,
        updatedAt: createdAt,
        requestCount: 0,
        revision: 0,
        messages: [],
      };
      state.sessions.push(session);
      persist();
      return session;
    },
    get(workspaceId, sessionId) {
      return state.sessions.find((item) => item.workspaceId === workspaceId && item.id === sessionId);
    },
    list(workspaceId) {
      return state.sessions.filter((session) => session.workspaceId === workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    update(session) {
      persist();
      return session;
    },
    appendTrace(sessionId, event) {
      state.traces.push({ sessionId, ...event });
      persist();
      return event;
    },
    listTrace(sessionId) {
      return state.traces.filter((item) => item.sessionId === sessionId).map((item) => ({ ...item }));
    },
    close() {},
  };
}

function createSqliteSessionStore(databaseFile) {
  if (!DatabaseSync) throw new Error("当前 Electron 运行时不支持 node:sqlite");
  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workspace_name TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      request_count INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 0,
      messages_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at DESC);
    CREATE TABLE IF NOT EXISTS runtime_trace (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      event_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS runtime_trace_session_sequence ON runtime_trace(session_id, sequence);
  `);
  const sessionColumns = new Set(database.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name));
  const additions = [
    ["workspace_id", "TEXT NOT NULL DEFAULT ''"],
    ["workspace_name", "TEXT NOT NULL DEFAULT ''"],
    ["revision", "INTEGER NOT NULL DEFAULT 0"],
    ["messages_json", "TEXT NOT NULL DEFAULT '[]'"],
  ];
  for (const [name, definition] of additions) {
    if (!sessionColumns.has(name)) database.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
  }
  function fromRow(row) {
    if (!row) return undefined;
    let messages = [];
    try { messages = JSON.parse(row.messages_json || "[]"); } catch { messages = []; }
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceName: row.workspace_name,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      requestCount: Number(row.request_count || 0),
      revision: Number(row.revision || 0),
      messages: Array.isArray(messages) ? messages : [],
    };
  }
  function selectById(sessionId) {
    return fromRow(database.prepare(`
      SELECT id, workspace_id, workspace_name, name, created_at, updated_at,
             request_count, revision, messages_json
      FROM sessions WHERE id = ?
    `).get(sessionId));
  }
  return {
    create(workspace) {
      const createdAt = now();
      const session = {
        id: `session:${crypto.randomUUID()}`,
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName || "本地工作区",
        name: "新会话",
        createdAt,
        updatedAt: createdAt,
        requestCount: 0,
        revision: 0,
        messages: [],
      };
      database.prepare(`
        INSERT INTO sessions (id, workspace_id, workspace_name, name, created_at, updated_at, request_count, revision, messages_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(session.id, session.workspaceId, session.workspaceName, session.name, session.createdAt, session.updatedAt, 0, 0, "[]");
      return session;
    },
    get(workspaceId, sessionId) {
      const session = selectById(sessionId);
      return session?.workspaceId === workspaceId ? session : undefined;
    },
    list(workspaceId) {
      return database.prepare(`
        SELECT id, workspace_id, workspace_name, name, created_at, updated_at,
               request_count, revision, messages_json
        FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC
      `).all(workspaceId).map(fromRow);
    },
    update(session) {
      database.prepare(`
        UPDATE sessions
        SET workspace_name = ?, name = ?, updated_at = ?, request_count = ?, revision = ?, messages_json = ?
        WHERE id = ?
      `).run(session.workspaceName, session.name, session.updatedAt, session.requestCount, session.revision, JSON.stringify(session.messages), session.id);
      return session;
    },
    appendTrace(sessionId, event) {
      database.prepare(`
        INSERT OR REPLACE INTO runtime_trace (id, session_id, sequence, type, event_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        sessionId,
        Number(event.sequence || 0),
        String(event.type || 'unknown'),
        JSON.stringify(event),
        event.timestamp || now(),
      );
      return event;
    },
    listTrace(sessionId) {
      return database.prepare(`
        SELECT event_json FROM runtime_trace WHERE session_id = ? ORDER BY sequence ASC
      `).all(sessionId).flatMap((row) => {
        try { return [JSON.parse(row.event_json)]; } catch { return []; }
      });
    },
    import(sessions) {
      let imported = 0;
      for (const session of sessions) {
        if (!session || typeof session.id !== "string" || selectById(session.id)) continue;
        database.prepare(`
          INSERT INTO sessions (id, workspace_id, workspace_name, name, created_at, updated_at, request_count, revision, messages_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          session.id,
          session.workspaceId,
          session.workspaceName || "本地工作区",
          session.name || "新会话",
          session.createdAt || now(),
          session.updatedAt || session.createdAt || now(),
          Number(session.requestCount || 0),
          Number(session.revision || 0),
          JSON.stringify(Array.isArray(session.messages) ? session.messages : []),
        );
        imported += 1;
      }
      return imported;
    },
    close() { database.close(); },
  };
}

function migrateLegacyJsonSessions({ storageFile, projectRecords = [] } = {}) {
  if (!storageFile || !fs.existsSync(storageFile)) return 0;
  let value;
  try { value = JSON.parse(fs.readFileSync(storageFile, "utf8")); } catch { return 0; }
  if (!value || !Array.isArray(value.sessions) || value.sessions.length === 0) return 0;
  const recordByProject = new Map(projectRecords.filter((record) => record?.projectId && record?.selectedPath).map((record) => [record.projectId, record]));
  const stores = new Map();
  let imported = 0;
  try {
    for (const session of value.sessions) {
      const record = recordByProject.get(session?.workspaceId);
      if (!record) continue;
      const projectPath = path.normalize(path.resolve(record.selectedPath));
      let store = stores.get(projectPath);
      if (!store) {
        store = createSqliteSessionStore(path.join(projectPath, ".capybara", "sessions.sqlite"));
        stores.set(projectPath, store);
      }
      imported += store.import([session]);
    }
  } finally {
    for (const store of stores.values()) store.close();
  }
  if (imported > 0) {
    const migratedFile = `${storageFile}.migrated`;
    if (!fs.existsSync(migratedFile)) fs.renameSync(storageFile, migratedFile);
  }
  return imported;
}

function createRuntimeManager({ storageFile, emit, fetchImpl = requestJson, env = process.env, applicationHost } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("local runtime requires fetch");
  const runtimes = new Map();
  const legacyStore = createJsonSessionStore(storageFile);
  const stores = new Map();
  const pendingTasks = new Set();

  function storeFor(workspace) {
    if (!workspace?.projectPath) return legacyStore;
    const key = path.normalize(path.resolve(workspace.projectPath));
    const existing = stores.get(key);
    if (existing) return existing;
    const store = createSqliteSessionStore(path.join(key, ".capybara", "sessions.sqlite"));
    stores.set(key, store);
    return store;
  }

  function send(runtime, type, payload, metadata = {}) {
    const event = {
      version: 1,
      kind: "event",
      id: crypto.randomUUID(),
      sessionId: runtime.sessionId,
      sequence: runtime.sequence += 1,
      timestamp: now(),
      type,
      ...(metadata.turnId || runtime.turnId ? { turnId: metadata.turnId || runtime.turnId, runId: metadata.turnId || runtime.turnId } : {}),
      ...(metadata.stepId || runtime.stepId ? { stepId: metadata.stepId || runtime.stepId } : {}),
      ...(metadata.turnId && runtime.turnId && metadata.turnId !== runtime.turnId ? { parentTurnId: runtime.turnId } : {}),
      payload: structuredClone(payload),
    };
    if (type !== "runtime.snapshot" && type !== "session.attached" && runtime.store?.appendTrace) {
      runtime.store.appendTrace(runtime.sessionId, event);
    }
    emit?.({ runtimeId: runtime.runtimeId, webContents: runtime.webContents, event });
  }

  function sessionFor(workspace, sessionId) {
    return storeFor(workspace).get(workspace.workspaceId, sessionId);
  }

  function createSession(workspace) {
    return storeFor(workspace).create(workspace);
  }

  function publicSession(session) {
    return {
      id: session.id,
      name: session.name,
      kind: "user",
      role: "本地工作 Agent",
      description: "处理当前项目中的用户任务、工具调用和结果验证",
      status: "ready",
      capabilities: ["receive_message", "send_message", "invoke_tools"],
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      requestCount: session.requestCount,
      restorable: true,
    };
  }

  function runtimeStatus(runtime, session) {
    const config = loadLlmConfig(env);
    const activity = runtime.activity || { phase: "idle", label: "等待指示", startedAt: now() };
    return {
      revision: runtime.sequence,
      runtime: "healthy",
      model: runtime.busy ? "busy" : "ready",
      modelName: config.model,
      loopStatus: runtime.busy ? "running" : "idle",
      context: { usedTokens: 0, maxTokens: 0, utilization: 0 },
      activity,
      queueDepth: runtime.processes.size,
      messageCount: session.requestCount,
      variableTokens: [],
      updatedAt: now(),
    };
  }

  function processItems(runtime) {
    return [...runtime.processes.values()].map((item) => ({ ...item }));
  }

  function contextSnapshot(runtime, session) {
    session = runtime.session || session;
    return {
      lastSequence: runtime.sequence,
      conversation: { messages: session.messages },
      trace: runtime.store?.listTrace ? runtime.store.listTrace(session.id) : [],
      contextScopes: {
        activeScope: "session",
        project: { revision: 0 },
        session: { revision: session.revision },
      },
      status: runtimeStatus(runtime, session),
      children: { revision: runtime.childrenRevision, items: runtime.children },
      processes: { revision: runtime.processRevision, items: processItems(runtime) },
      artifacts: { revision: runtime.artifactRevision, items: [...runtime.artifacts.values()] },
      observations: { revision: runtime.observationRevision, items: [...runtime.observations.values()] },
      timeline: { revision: runtime.timelineRevision, steps: [...runtime.timeline.values()] },
    };
  }

  function emitRuntimeStatus(runtime, phase, label, metadata = {}) {
    runtime.activity = { phase, label, startedAt: now() };
    const session = runtime.session || runtime.store.get(runtime.workspaceId, runtime.sessionId);
    if (!session) return;
    send(runtime, "runtime.status.updated", runtimeStatus(runtime, session), metadata);
  }

  function emitProcesses(runtime, metadata = {}) {
    send(runtime, "runtime.processes.updated", { revision: runtime.processRevision, items: processItems(runtime) }, metadata);
  }

  function emitChildren(runtime, metadata = {}) {
    send(runtime, "runtime.children.updated", { revision: runtime.childrenRevision, items: runtime.children.map((item) => ({ ...item })) }, metadata);
  }

  function emitThinking(runtime, text, metadata = {}) {
    if (!text || !runtime.assistantId) return;
    runtime.thinkingChunkIndex += 1;
    if (runtime.assistant && metadata.source !== "model") runtime.assistant.thinkingSummary = text;
    send(runtime, "chat.assistant.delta", {
      messageId: runtime.assistantId,
      channel: "thinkingSummary",
      chunkIndex: runtime.thinkingChunkIndex,
      delta: text,
      source: metadata.source || "runtime",
    }, metadata);
  }

  function previewValue(value, limit = 600) {
    let text;
    try { text = JSON.stringify(value); } catch { text = String(value); }
    text = text === undefined ? "null" : text;
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function archive(runtime, kind, label, value, metadata = {}) {
    const serialized = JSON.stringify(value ?? null);
    const artifact = { id: `artifact:${crypto.randomUUID()}`, kind, label, contentType: "application/json", byteLength: Buffer.byteLength(serialized), hash: crypto.createHash("sha256").update(serialized).digest("hex"), preview: previewValue(value), redacted: false, runId: metadata.turnId || runtime.turnId, stepId: metadata.stepId || runtime.stepId, createdAt: now() };
    runtime.artifacts.set(artifact.id, artifact);
    runtime.artifactRevision += 1;
    send(runtime, "runtime.artifact.created", { artifact }, metadata);
    send(runtime, "runtime.artifact.content", { artifact, value: value ?? null }, metadata);
    return artifact;
  }

  async function responseBody(response) {
    if (Array.isArray(response?.streamEvents) && response.streamEvents.length > 0) return { __streamEvents: response.streamEvents };
    const text = await response.text();
    try { return text ? JSON.parse(text) : undefined; } catch { return text; }
  }

  function streamedResponse(events, responses) {
    if (!Array.isArray(events) || events.length === 0) return undefined;
    if (responses) {
      let text = "";
      const output = new Map();
      let completed;
      for (const event of events) {
        if (event?.type === "response.failed" || event?.type === "response.incomplete") return event.response || { status: "failed", error: { message: "模型响应未完成" } };
        if (event?.type === "error") return { status: "failed", error: event.error || event };
        if (event?.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
        if ((event?.type === "response.output_item.added" || event?.type === "response.output_item.done") && event.item) output.set(event.output_index ?? output.size, { ...event.item });
        if (event?.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
          const index = event.output_index ?? 0;
          const item = output.get(index) || { type: "function_call", arguments: "" };
          item.arguments = `${item.arguments || ""}${event.delta}`;
          output.set(index, item);
        }
        if (event?.type === "response.completed" && event.response) completed = event.response;
      }
      if (completed) return completed;
      return { status: "incomplete", error: { message: "模型响应流缺少完成事件" }, output_text: text, output: [...output.values()] };
    }
    let text = "";
    let finishReason;
    const calls = new Map();
    for (const event of events) {
      if (event?.error) return { error: event.error };
      const choice = event?.choices?.[0];
      if (typeof choice?.delta?.content === "string") text += choice.delta.content;
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      for (const part of choice?.delta?.tool_calls || []) {
        const index = part.index ?? 0;
        const call = calls.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } };
        call.id = part.id || call.id;
        call.function.name += part.function?.name || "";
        call.function.arguments += part.function?.arguments || "";
        calls.set(index, call);
      }
    }
    return finishReason ? { choices: [{ message: { content: text || null, tool_calls: [...calls.values()] }, finish_reason: finishReason }] } : { error: { message: "模型响应流缺少完成标记" } };
  }

  function extractText(value) {
    if (typeof value?.output_text === "string") return value.output_text.trim();
    const choice = value?.choices?.[0]?.message?.content;
    if (typeof choice === "string") return choice.trim();
    if (Array.isArray(choice)) return choice.map((item) => typeof item?.text === "string" ? item.text : "").join("").trim();
    if (Array.isArray(value?.output)) {
      return value.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
        .map((item) => typeof item?.text === "string" ? item.text : "")
        .join("")
        .trim();
    }
    return "";
  }

  function extractReasoningSummary(value) {
    const output = Array.isArray(value?.output) ? value.output : [];
    const summaries = output
      .filter((item) => item?.type === "reasoning" && Array.isArray(item.summary))
      .flatMap((item) => item.summary)
      .map((item) => typeof item === "string" ? item : item?.text)
      .filter((item) => typeof item === "string" && item.trim());
    return summaries.join("\n").trim();
  }

  async function askModel(session, projectPath, runtime, signal, options = {}) {
    const config = loadLlmConfig(env);
    if (!config.apiKey && config.provider !== "ollama") throw new Error("尚未配置模型 API Key。请在系统用户 .capybara/credentials.json 或 Windows 用户环境变量中配置。");
    const workspaceRoot = projectPath || process.cwd();
    const resources = loadWorkspaceResources(workspaceRoot);
    if (options.allowDelegation === false) resources.tools = resources.tools.filter((tool) => tool.sideEffects === "none" && (tool.permissions || []).every((permission) => resources.permissions.includes(permission)));
    const skillInstructions = resources.skills.map((skill) => `\n## Skill: ${skill.name}\n${skill.description}\n${skill.content}`).join("\n");
    const systemMessage = `你是 Capybara V2 的本地工作 Agent。当前工作区是“${session.workspaceName}”。区分事实和推断，先说明不确定性，使用简洁的中文完成用户指令。\n调用工具前提供简短、可公开的工作说明：当前目标、已知依据、下一步行动及如何验证。不要输出内部思维链，不要把计划或工具成功当作已验证的事实。最终回复只按真实工具结果报告。${options.allowDelegation === false ? "\n你是受父代理委派的只读子代理，只能观察和分析；返回证据与不确定性，不能宣布父任务完成。" : "\n可用 delegate_task 委派独立只读分析；父代理负责核对并合并结果，保留最终权限。"}\n\n你可以通过工具读取、编辑和验证项目文件，也可以执行项目内代码。工具路径必须使用项目相对路径。${skillInstructions}`;
    const environmentInstructions = `\n运行环境：${process.platform}；命令由${process.platform === "win32" ? " Windows cmd.exe" : "系统 shell"}执行。安装、构建和测试应明确设置足够的 timeout_ms（通常 120000），运行时上限为 ${resources.timeoutMs} ms。验证服务时使用隔离数据库及空闲端口，只结束自己创建的进程树，验证后释放端口；不要按名称批量结束进程。`;
    const messages = [
      { role: "system", content: systemMessage + environmentInstructions },
      ...session.messages
        .filter((item) => (item.role === "user" || item.role === "assistant") && Array.isArray(item.content) && item.content.some((part) => typeof part?.text === "string" && part.text.trim()))
        .map((item) => ({ role: item.role, content: item.content.map((part) => part.text || "").join("") })).slice(-20),
    ];
    const responses = config.protocol === "responses";
    const availableTools = options.allowDelegation === false
      ? resources.tools
      : [...resources.tools, CHILD_AGENT_TOOL, ...(applicationHost ? [APPLICATION_TOOL] : [])];
    const exposedSchema = (tool) => {
      if (!/^(?:gpt-[56]|o\d)/i.test(config.model)) return tool.inputSchema;
      const { oneOf, anyOf, allOf, not, const: constant, enum: enumeration, ...schema } = tool.inputSchema;
      return schema;
    };
    const chatTools = availableTools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: exposedSchema(tool),
        strict: false,
      },
    }));
    const responseTools = availableTools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: exposedSchema(tool),
      strict: false,
    }));
    const turnId = options.turnIdOverride || runtime.turnId || `turn:${crypto.randomUUID()}`;
    if (!runtime.turnId) runtime.turnId = turnId;
    const runChildAgent = async (call, stepId) => {
      const goal = String(call.arguments?.goal || "子任务");
      const prompt = String(call.arguments?.prompt || goal);
      const childId = `child:${crypto.randomUUID()}`;
      const childTurnId = `turn:${childId}`;
      const startedAt = now();
      runtime.children.push({ id: childId, goal, status: "running", startedAt, parentSessionId: runtime.sessionId, parentRunId: turnId, sourceInstructionId: stepId });
      runtime.childrenRevision += 1;
      emitChildren(runtime, { turnId, stepId });
      emitThinking(runtime, `已委派子智能体：${goal}`, { turnId, stepId });
      const childSession = {
        id: `${runtime.sessionId}:${childId}`,
        workspaceName: `${session.workspaceName} · ${goal}`,
        requestCount: 1,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      };
      try {
        const result = await askModel(childSession, projectPath, runtime, signal, { allowDelegation: false, turnIdOverride: childTurnId });
        const completedAt = now();
        runtime.children = runtime.children.map((item) => item.id === childId ? { ...item, status: "succeeded", completedAt, resultArtifactId: `artifact:${turnId}:${call.id}` } : item);
        runtime.childrenRevision += 1;
        emitChildren(runtime, { turnId, stepId });
        return { id: call.id, name: call.name, ok: true, output: { childId, goal, result }, startedAt, completedAt, durationMs: Date.parse(completedAt) - Date.parse(startedAt) };
      } catch (error) {
        const completedAt = now();
        const failure = { code: "CHILD_AGENT_FAILED", message: error instanceof Error ? error.message : String(error) };
        runtime.children = runtime.children.map((item) => item.id === childId ? { ...item, status: signal.aborted ? "cancelled" : "failed", completedAt, error: failure } : item);
        runtime.childrenRevision += 1;
        emitChildren(runtime, { turnId, stepId });
        return { id: call.id, name: call.name, ok: false, error: failure, startedAt, completedAt, durationMs: Date.parse(completedAt) - Date.parse(startedAt) };
      }
    };
    const executeToolCall = async (call, parentStepId) => {
      const stepId = `step:${turnId}:tool:${call.id}`;
      const startedAt = now();
      const toolStep = { id: stepId, index: runtime.timeline.size, type: "tool", status: "running", summary: call.name, startedAt, detail: { callId: call.id, toolName: call.name, arguments: call.arguments, parentStepId } };
      runtime.timeline.set(stepId, toolStep);
      send(runtime, "timeline.step.upserted", { revision: ++runtime.timelineRevision, step: toolStep }, { turnId, stepId });
      const process = {
        id: `process:${turnId}:${call.id}`,
        kind: call.name === "run_code" ? "script" : call.name === "run_command" ? "program" : "tool",
        name: call.name === "run_code" ? `run_code · ${String(call.arguments.file_name || "")}` : call.name,
        status: "running",
        projectId: runtime.workspaceId,
        sessionId: runtime.sessionId,
        turnId,
        stepId,
        callId: call.id,
        startedAt,
      };
      runtime.processes.set(process.id, process);
      runtime.processRevision += 1;
      emitProcesses(runtime, { turnId, stepId });
      emitRuntimeStatus(runtime, "tool_running", `正在调用 ${call.name}`, { turnId, stepId });
      const target = call.arguments?.file_name || call.arguments?.path || call.arguments?.command || call.arguments?.goal;
      const targetSummary = typeof target === 'string' ? ` · ${target.replace(/\s+/g, ' ').slice(0, 120)}` : '';
      emitThinking(runtime, `正在调用工具：${call.name}${targetSummary}`, { turnId, stepId });
      send(runtime, "tool.call.started", { callId: call.id, toolName: call.name, arguments: call.arguments, startedAt, turnId, stepId }, { turnId, stepId });
      const observationId = `observation:${turnId}:${call.id}`;
      const observation = { id: observationId, runId: turnId, stepId, callId: call.id, toolName: call.name, status: "running", arguments: call.arguments, startedAt };
      runtime.observations.set(observationId, observation);
      runtime.observationRevision += 1;
      send(runtime, "runtime.observation.upserted", { revision: runtime.observationRevision, observation }, { turnId, stepId });
      const tool = resources.tools.find((candidate) => candidate.name === call.name);
      const beforeFile = resources.permissions.includes("filesystem:read") ? fileReceipt(workspaceRoot, call.arguments.file_name) : undefined;
      let toolResult;
      try {
        signal.throwIfAborted();
        toolResult = call.name === CHILD_AGENT_TOOL.name && options.allowDelegation !== false
          ? await runChildAgent(call, stepId)
          : call.name === APPLICATION_TOOL.name && options.allowDelegation !== false && applicationHost
          ? await applicationHost({
              action: String(call.arguments?.action || "start"),
              appId: typeof call.arguments?.app_id === "string" ? call.arguments.app_id : undefined,
              instanceId: typeof call.arguments?.instance_id === "string" ? call.arguments.instance_id : undefined,
              projectPath: workspaceRoot,
              projectId: runtime.workspaceId,
              turnId,
              stepId,
              callId: call.id,
            })
          : tool
          ? await runWorkspaceTool(tool, workspaceRoot, resources.permissions, call.arguments, call.id, signal, resources.timeoutMs, (pid) => {
              process.pid = pid;
              process.detail = { pidRole: "tool-runner" };
              runtime.processes.set(process.id, { ...process });
              runtime.processRevision += 1;
              emitProcesses(runtime, { turnId, stepId });
            })
          : { id: call.id, name: call.name, ok: false, error: { code: "TOOL_NOT_FOUND", message: `unknown tool: ${call.name}` }, startedAt, completedAt: now(), durationMs: Date.now() - Date.parse(startedAt) };
      } catch (error) {
        toolResult = { id: call.id, name: call.name, ok: false, error: { code: "TOOL_EXECUTION_FAILED", message: error instanceof Error ? error.message : String(error) }, startedAt, completedAt: now(), durationMs: Date.now() - Date.parse(startedAt) };
      }
      const completedAt = toolResult.completedAt || now();
      const durationMs = Number.isFinite(toolResult.durationMs) ? toolResult.durationMs : Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
      const succeeded = toolResult.ok === true;
      const finalToolStep = { ...toolStep, status: succeeded ? "success" : signal.aborted ? "interrupted" : "error", completedAt, durationMs, detail: { ...toolStep.detail, resultArtifactId: `artifact:${turnId}:${call.id}`, ...(succeeded ? {} : { error: toolResult.error }) } };
      runtime.timeline.set(stepId, finalToolStep);
      send(runtime, "timeline.step.upserted", { revision: ++runtime.timelineRevision, step: finalToolStep }, { turnId, stepId });
      runtime.processes.set(process.id, {
        ...process,
        status: signal.aborted ? "stopped" : succeeded ? "succeeded" : "failed",
        stoppedAt: completedAt,
        detail: succeeded ? { resultPreview: previewValue(toolResult.output) } : undefined,
        ...(succeeded ? {} : { error: toolResult.error }),
      });
      runtime.processRevision += 1;
      emitProcesses(runtime, { turnId, stepId });
      const resultValue = succeeded ? toolResult.output : { error: toolResult.error, output: toolResult.output ?? null };
      const afterFile = resources.permissions.includes("filesystem:read") ? fileReceipt(workspaceRoot, call.arguments.file_name) : undefined;
      const fileChanges = beforeFile || afterFile ? { before: beforeFile || null, after: afterFile || null, changed: JSON.stringify(beforeFile) !== JSON.stringify(afterFile) } : undefined;
      const artifactValue = fileChanges ? { result: resultValue, fileChanges } : resultValue;
      const serializedResult = JSON.stringify(artifactValue ?? null);
      const artifact = {
        id: `artifact:${turnId}:${call.id}`,
        kind: "tool-result",
        label: `Tool result · ${call.name}`,
        contentType: "application/json",
        byteLength: Buffer.byteLength(serializedResult, "utf8"),
        hash: crypto.createHash("sha256").update(serializedResult).digest("hex"),
        preview: previewValue(resultValue),
        redacted: false,
        runId: turnId,
        stepId,
        createdAt: completedAt,
      };
      runtime.artifacts.set(artifact.id, artifact);
      runtime.artifactRevision += 1;
      send(runtime, "runtime.artifact.created", { artifact }, { turnId, stepId });
      send(runtime, "runtime.artifact.content", { artifact, value: artifactValue }, { turnId, stepId });
      const finalObservation = {
        ...observation,
        status: succeeded ? "completed" : "failed",
        resultArtifactId: artifact.id,
        resultPreview: artifact.preview,
        ...(succeeded ? {} : { error: toolResult.error }),
        completedAt,
        durationMs,
      };
      runtime.observations.set(observationId, finalObservation);
      runtime.observationRevision += 1;
      send(runtime, "runtime.observation.upserted", { revision: runtime.observationRevision, observation: finalObservation }, { turnId, stepId });
      if (succeeded) {
        send(runtime, "tool.call.completed", { callId: call.id, toolName: call.name, result: toolResult.output, startedAt, completedAt, durationMs, turnId, stepId }, { turnId, stepId });
        emitThinking(runtime, `工具 ${call.name} 返回成功（${durationMs} ms），结果已归档`, { turnId, stepId });
      } else {
        send(runtime, "tool.call.failed", { callId: call.id, toolName: call.name, code: toolResult.error?.code || "TOOL_FAILED", message: toolResult.error?.message || "工具调用失败", details: toolResult.error, startedAt, completedAt, durationMs, turnId, stepId }, { turnId, stepId });
        emitThinking(runtime, `工具 ${call.name} 失败：${toolResult.error?.message || "未知错误"}`, { turnId, stepId });
      }
      return { ...toolResult, startedAt, completedAt, durationMs };
    };
    const roundLimit = options.allowDelegation === false ? Math.min(8, resources.maxToolRounds) : resources.maxToolRounds;
    for (let round = 0; round <= roundLimit; round += 1) {
      signal.throwIfAborted();
      const finalRound = round === roundLimit;
      if (finalRound) messages.push({ role: "system", content: "本轮工具预算已用完，不能继续执行动作。请按已有证据收尾：报告已验证结果、失败与未完成部分，以及下一步所需验证。不得声称尚未验证的任务已经完成。" });
      const stepId = `step:${turnId}:${round + 1}`;
      if (!options.turnIdOverride) runtime.stepId = stepId;
      emitRuntimeStatus(runtime, round === 0 ? "model_preparing" : "model_processing", round === 0 ? "正在理解任务并检查可用能力" : "正在根据工具结果继续判断", { turnId, stepId });
      emitThinking(runtime, round === 0 ? "正在理解任务、识别约束并检查可用工具" : "正在分析工具返回结果并决定下一步", { turnId, stepId });
      const body = responses
        ? {
            model: config.model,
            input: messages,
            ...(responseTools.length > 0 ? { tools: responseTools, tool_choice: finalRound ? "none" : "auto" } : {}),
            store: false,
            stream: true,
            max_output_tokens: resources.maxOutputTokens,
            ...(/^(?:gpt-[56]|o\d)/i.test(config.model) ? { reasoning: { effort: "low", summary: "auto" } } : {}),
          }
        : {
            model: config.model,
            messages,
            stream: true,
            ...(chatTools.length > 0 ? { tools: chatTools, tool_choice: finalRound ? "none" : "auto" } : {}),
            ...( /^(?:gpt-[56]|o\d)/i.test(config.model) ? { max_completion_tokens: resources.maxOutputTokens, reasoning_effort: "none" } : { max_tokens: resources.maxOutputTokens }),
          };
      const startedAt = now();
      const modelStep = { id: stepId, index: runtime.timeline.size, type: "model", status: "running", summary: `模型第 ${round + 1} 轮`, startedAt, detail: { model: config.model, protocol: config.protocol, turnId } };
      runtime.timeline.set(stepId, modelStep);
      send(runtime, "timeline.step.upserted", { revision: ++runtime.timelineRevision, step: modelStep }, { turnId, stepId });
      for (const [id, observation] of runtime.observations) {
        if (observation.runId !== turnId || observation.status === "running" || observation.consumedByStepId) continue;
        const consumed = { ...observation, consumedByStepId: stepId };
        runtime.observations.set(id, consumed);
        send(runtime, "runtime.observation.upserted", { revision: ++runtime.observationRevision, observation: consumed }, { turnId, stepId });
      }
      let streamText = "";
      let summarySeen = false;
      const onModelEvent = (event) => {
        signal.throwIfAborted();
        const textDelta = responses ? (event.type === "response.output_text.delta" ? event.delta : undefined) : event.choices?.[0]?.delta?.content;
        if (typeof textDelta === "string" && textDelta) {
          streamText += textDelta;
          send(runtime, "chat.assistant.delta", { messageId: runtime.assistantId, channel: "commentary", chunkIndex: ++runtime.textChunkIndex, delta: textDelta, source: "model" }, { turnId, stepId });
        }
        if (event.type === "response.reasoning_summary_text.delta" && typeof event.delta === "string") {
          summarySeen = true;
          emitThinking(runtime, event.delta, { turnId, stepId, source: "model" });
        }
      };
      emitRuntimeStatus(runtime, "model_waiting", `模型第 ${round + 1} 轮 · 等待输出`, { turnId, stepId });
      const headers = { "content-type": "application/json", accept: "text/event-stream" };
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
      const response = await fetchImpl(`${config.baseUrl}/${responses ? "responses" : "chat/completions"}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal,
        timeoutMs: config.timeoutMs,
        onEvent: onModelEvent,
      });
      const result = await responseBody(response);
      if (!response.ok) {
        const message = result?.error?.message || result?.message || `模型请求失败（HTTP ${response.status}）`;
        throw new Error(message);
      }
      const effectiveResult = result?.__streamEvents ? streamedResponse(result.__streamEvents, responses) : result;
      if (effectiveResult?.error || ["failed", "incomplete"].includes(effectiveResult?.status)) {
        throw Object.assign(new Error(effectiveResult.error?.message || `模型响应未完成：${effectiveResult.status}`), { code: effectiveResult.error?.code || "MODEL_INCOMPLETE" });
      }
      const providerSummary = extractReasoningSummary(effectiveResult);
      if (providerSummary && !summarySeen) emitThinking(runtime, providerSummary, { turnId, stepId, source: "model" });
      if (!streamText && extractText(effectiveResult)) onModelEvent(responses ? { type: "response.output_text.delta", delta: extractText(effectiveResult) } : { choices: [{ delta: { content: extractText(effectiveResult) } }] });
      const choice = effectiveResult?.choices?.[0]?.message;
      if (effectiveResult?.choices?.[0]?.finish_reason === "length") throw Object.assign(new Error("模型输出达到长度上限，本轮结果不完整"), { code: "MODEL_OUTPUT_TRUNCATED" });
      const responseCalls = Array.isArray(effectiveResult?.output)
        ? effectiveResult.output.filter((item) => item?.type === "function_call").map((call) => {
            let argumentsValue = {};
            try { argumentsValue = JSON.parse(call?.arguments || "{}"); } catch { argumentsValue = { __invalid_json: call?.arguments || "" }; }
            return { id: String(call?.call_id || call?.id || `tool-call:${crypto.randomUUID()}`), name: String(call?.name || ""), arguments: argumentsValue, responseItem: call };
          }).filter((call) => call.name)
        : [];
      const calls = responses ? responseCalls : (Array.isArray(choice?.tool_calls)
        ? choice.tool_calls.map((call) => {
            let argumentsValue = {};
            try { argumentsValue = JSON.parse(call?.function?.arguments || "{}"); } catch { argumentsValue = { __invalid_json: call?.function?.arguments || "" }; }
            return { id: String(call?.id || `tool-call:${crypto.randomUUID()}`), name: String(call?.function?.name || ""), arguments: argumentsValue };
          }).filter((call) => call.name)
        : []);
      const completedStep = { ...modelStep, status: "success", completedAt: now(), durationMs: Date.now() - Date.parse(startedAt), detail: { ...modelStep.detail, toolCalls: calls.length, text: streamText } };
      runtime.timeline.set(stepId, completedStep);
      send(runtime, "timeline.step.upserted", { revision: ++runtime.timelineRevision, step: completedStep }, { turnId, stepId });
      if (calls.length > 0) {
        if (finalRound) throw Object.assign(new Error("工具预算已用完，模型仍请求执行动作"), { code: "TOOL_ROUND_LIMIT", phase: "runtime" });
        emitThinking(runtime, `已生成 ${calls.length} 个工具动作，按顺序执行并保留结果`, { turnId, stepId });
        if (responses) {
          messages.push(...(effectiveResult.output || []));
        } else {
          messages.push({
            role: "assistant",
            content: typeof choice?.content === "string" ? choice.content : null,
            tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
          });
        }
        for (const call of calls) {
          const toolResult = await executeToolCall(call, stepId);
          if (responses) messages.push({ type: "function_call_output", call_id: call.id, output: JSON.stringify(toolResult.ok ? toolResult.output : toolResult.error) });
          else messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(toolResult.ok ? toolResult.output : toolResult.error) });
        }
        continue;
      }
      const text = extractText(effectiveResult);
      if (text) {
        emitRuntimeStatus(runtime, "model_processing", "正在整理最终回复", { turnId, stepId });
        emitThinking(runtime, "模型已返回回复；执行依据可在本轮工具结果中核对", { turnId, stepId });
        return text;
      }
      throw new Error("模型返回了空文本结果");
    }
    throw Object.assign(new Error("工具调用超过本轮最大轮数"), { code: "TOOL_ROUND_LIMIT", phase: "runtime" });
  }

  async function runChat(runtime, frame) {
    const session = sessionFor(runtime.workspace, runtime.sessionId);
    if (!session) throw new Error("runtime session was not found");
    const content = frame?.payload?.content?.map((item) => item?.type === "text" ? item.text || "" : "").join("").trim();
    if (!content) throw new Error("chat message cannot be empty");
    runtime.session = session;
    const userMessage = {
      id: frame.payload.clientMessageId || `message:${crypto.randomUUID()}`,
      role: "user",
      status: "completed",
      createdAt: now(),
      content: [{ type: "text", text: content }],
    };
    session.messages.push(userMessage);
    session.requestCount += 1;
    if (session.requestCount === 1 && session.name === "新会话") session.name = content.split(/\r?\n/)[0].slice(0, 32);
    session.revision += 1;
    session.updatedAt = now();
    runtime.store.update(session);
    runtime.turnId = `turn:${frame.id || crypto.randomUUID()}`;
    send(runtime, "chat.user.created", userMessage, { turnId: runtime.turnId });

    const assistant = {
      id: `message:${crypto.randomUUID()}`,
      requestId: frame.id,
      role: "assistant",
      status: "streaming",
      createdAt: now(),
      content: [{ type: "text", text: "" }],
    };
    session.messages.push(assistant);
    runtime.busy = true;
    runtime.stepId = undefined;
    runtime.assistantId = assistant.id;
    runtime.assistant = assistant;
    runtime.thinkingChunkIndex = 0;
    runtime.activity = { phase: "model_preparing", label: "正在理解任务", startedAt: now() };
    runtime.abortController = new AbortController();
    runtime.store.update(session);
    send(runtime, "chat.assistant.started", { message: assistant });
    send(runtime, "runtime.status.updated", runtimeStatus(runtime, session), { turnId: runtime.turnId });
    try {
      const text = await askModel(session, runtime.workspace.projectPath, runtime, runtime.abortController.signal);
      assistant.content = [{ type: "text", text }];
      assistant.status = "completed";
      assistant.evidenceRefs = [...runtime.artifacts.values()].filter((item) => item.runId === runtime.turnId).map((item) => item.id);
      assistant.completedAt = now();
      session.revision += 1;
      session.updatedAt = now();
      runtime.store.update(session);
      send(runtime, "chat.assistant.delta", { messageId: assistant.id, channel: "final", chunkIndex: 0, delta: text }, { turnId: runtime.turnId, stepId: runtime.stepId });
      send(runtime, "chat.assistant.completed", { messageId: assistant.id, finishReason: "stop", completedAt: assistant.completedAt, evidenceRefs: assistant.evidenceRefs }, { turnId: runtime.turnId, stepId: runtime.stepId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = runtime.abortController?.signal.aborted === true;
      assistant.status = cancelled ? "cancelled" : "failed";
      assistant.completedAt = now();
      const errorArtifact = archive(runtime, "runtime-error", "运行失败", { message, code: error?.code || "MODEL_FAILED" });
      assistant.failure = { phase: error?.phase || "model_transport", code: cancelled ? "ABORTED" : error?.code || "MODEL_FAILED", message, retryable: false, stepId: runtime.stepId || "preparing", errorArtifactId: errorArtifact.id, timestamp: now() };
      for (const [id, step] of runtime.timeline) {
        if (step.status !== "running") continue;
        const completed = { ...step, status: cancelled ? "interrupted" : "error", completedAt: now(), durationMs: Math.max(0, Date.now() - Date.parse(step.startedAt)), detail: { ...step.detail, error: assistant.failure } };
        runtime.timeline.set(id, completed);
        send(runtime, "timeline.step.upserted", { revision: ++runtime.timelineRevision, step: completed }, { turnId: step.detail?.turnId || runtime.turnId, stepId: id });
      }
      assistant.content = [{ type: "text", text: message }];
      session.revision += 1;
      session.updatedAt = now();
      runtime.store.update(session);
      send(runtime, "chat.assistant.failed", { messageId: assistant.id, code: assistant.failure.code, message, retryable: false, failure: assistant.failure }, { turnId: runtime.turnId, stepId: runtime.stepId });
    } finally {
      runtime.busy = false;
      runtime.abortController = undefined;
      runtime.activity = { phase: "idle", label: "等待指示", startedAt: now() };
      send(runtime, "runtime.status.updated", runtimeStatus(runtime, session), { turnId: runtime.turnId });
      send(runtime, "runtime.snapshot", contextSnapshot(runtime, session));
      runtime.turnId = undefined;
      runtime.stepId = undefined;
      runtime.assistantId = undefined;
      runtime.assistant = undefined;
    }
  }

  return {
    hasActiveRuns() { return [...runtimes.values()].some(runtime => runtime.busy); },
    listSessions(workspace) {
      return storeFor(workspace)
        .list(workspace.workspaceId)
        .map(publicSession);
    },

    listSessionDirectory(workspace) {
      return {
        projectId: workspace.workspaceId,
        revision: Date.now(),
        generatedAt: now(),
        items: storeFor(workspace).list(workspace.workspaceId).map(publicSession),
      };
    },

    sendSessionMessage({ workspace, sourceSessionId, targetSessionId, type = "chat.message", payload = {}, idempotencyKey }) {
      const store = storeFor(workspace);
      const source = String(sourceSessionId || "").startsWith("application:")
        ? { id: String(sourceSessionId), name: "项目应用", workspaceId: workspace.workspaceId, requestCount: 0, revision: 0, messages: [], createdAt: now(), updatedAt: now() }
        : store.get(workspace.workspaceId, sourceSessionId);
      const target = store.get(workspace.workspaceId, targetSessionId);
      if (!source || !target) throw new Error("目标会话不存在");
      if (source.id === target.id) throw new Error("不能向当前会话自身发送会话消息");
      const messageId = `message:${crypto.randomUUID()}`;
      const receiptId = `receipt:${crypto.randomUUID()}`;
      const createdAt = now();
      const targetProfile = publicSession(target);
      const sourceProfile = publicSession(source);
      const requestedText = typeof payload?.text === "string" ? payload.text : "";
      const incoming = {
        id: messageId,
        requestId: receiptId,
        role: "user",
        status: "completed",
        content: [{ type: "text", text: requestedText || "收到一条会话消息" }],
        createdAt,
        completedAt: createdAt,
      };
      target.messages.push(incoming);
      target.requestCount += 1;
      target.revision += 1;
      target.updatedAt = createdAt;
      store.update(target);
      const replyId = `message:${crypto.randomUUID()}`;
      const replyText = `我是${targetProfile.name}，职责是${targetProfile.description}。已收到来自${sourceProfile.name}的消息：“${requestedText || "（无文本）"}”。`;
      const reply = { id: replyId, requestId: receiptId, role: "assistant", status: "completed", content: [{ type: "text", text: replyText }], createdAt, completedAt: createdAt };
      target.messages.push(reply);
      target.revision += 1;
      target.updatedAt = now();
      store.update(target);
      const callbackId = `message:${crypto.randomUUID()}`;
      const callbackText = `${targetProfile.name} 回复：${replyText}`;
      if (!source.id.startsWith("application:")) {
        source.messages.push({ id: callbackId, requestId: receiptId, role: "assistant", status: "completed", content: [{ type: "text", text: callbackText }], createdAt, completedAt: now() });
        source.requestCount += 1;
        source.revision += 1;
        source.updatedAt = now();
        store.update(source);
      }
      const traceRefs = { messageId, parentMessageId: callbackId, sourceSessionId, targetSessionId };
      const event = { id: `trace:${crypto.randomUUID()}`, sequence: Date.now(), type: "session.message.completed", timestamp: now(), payload: { protocol: "capybara.session-message.v1", messageId, receiptId, type, source: sourceProfile, target: targetProfile, payload, callbackId, callbackText, idempotencyKey: idempotencyKey || messageId } };
      if (!source.id.startsWith("application:")) store.appendTrace(source.id, event);
      store.appendTrace(target.id, { ...event, id: `trace:${crypto.randomUUID()}`, payload: { ...event.payload, direction: "inbound" } });
      for (const runtime of runtimes.values()) {
        if (runtime.workspaceId !== workspace.workspaceId) continue;
        if (runtime.sessionId === source.id) {
          send(runtime, "session.message.completed", event.payload);
          send(runtime, "runtime.snapshot", contextSnapshot(runtime, store.get(workspace.workspaceId, runtime.sessionId)));
        }
        if (runtime.sessionId === target.id) {
          send(runtime, "session.message.delivered", event.payload);
          send(runtime, "runtime.snapshot", contextSnapshot(runtime, store.get(workspace.workspaceId, runtime.sessionId)));
        }
      }
      return { receiptId, messageId, callbackId, status: "completed", source: sourceProfile, target: targetProfile, callbackText, traceRefs };
    },

    connect({ workspaceId, workspaceName, projectPath, sessionId, webContents }) {
      if (!workspaceId) throw new Error("workspace id is required");
      const workspace = { workspaceId, workspaceName, projectPath };
      const store = storeFor(workspace);
      let session = sessionId ? sessionFor(workspace, sessionId) : undefined;
      if (!session) session = createSession(workspace);
      const existing = [...runtimes.values()].find((item) => item.workspaceId === workspaceId && item.sessionId === session.id);
      if (existing) {
        existing.webContents = webContents;
        send(existing, "session.attached", { session: { id: session.id, name: session.name } });
        send(existing, "runtime.snapshot", contextSnapshot(existing, session));
        return { runtimeId: existing.runtimeId, sessionId: session.id };
      }
      const runtimeId = `runtime:${crypto.randomUUID()}`;
      const trace = store.listTrace ? store.listTrace(session.id) : [];
      const sequence = trace.reduce((max, event) => Math.max(max, Number(event.sequence || 0)), 0);
      const runtime = {
        runtimeId,
        workspaceId,
        workspace,
        store,
        sessionId: session.id,
        webContents,
        busy: false,
        sequence,
        processes: new Map(),
        processRevision: 0,
        children: [],
        childrenRevision: 0,
        artifacts: new Map(),
        artifactRevision: 0,
        observations: new Map(),
        observationRevision: 0,
        timeline: new Map(),
        timelineRevision: 0,
        textChunkIndex: 0,
        thinkingChunkIndex: 0,
        activity: { phase: "idle", label: "等待指示", startedAt: now() },
      };
      for (const event of trace) {
        const payload = event.payload || {};
        if (event.type === "runtime.processes.updated") {
          runtime.processes = new Map((payload.items || []).map((item) => [item.id, item]));
          runtime.processRevision = payload.revision || 0;
        }
        if (event.type === "runtime.children.updated") { runtime.children = payload.items || []; runtime.childrenRevision = payload.revision || 0; }
        if (event.type === "runtime.artifact.created") runtime.artifacts.set(payload.artifact.id, payload.artifact);
        if (event.type === "runtime.observation.upserted") runtime.observations.set(payload.observation.id, payload.observation);
        if (event.type === "timeline.step.upserted") runtime.timeline.set(payload.step.id, payload.step);
      }
      const needsRecovery = session.messages.some((item) => ["running", "queued", "streaming"].includes(item.status)) || [...runtime.processes.values()].some((item) => ["running", "starting", "waiting"].includes(item.status)) || [...runtime.timeline.values()].some((item) => item.status === "running");
      const recoveryArtifact = needsRecovery ? archive(runtime, "runtime-error", "运行中断后的恢复记录", { code: "RUNTIME_INTERRUPTED", reason: "未记录完成状态，没有重放工具" }, { stepId: "restore" }) : undefined;
      const interrupted = { code: "RUNTIME_INTERRUPTED", message: "上次运行在退出前未完成，结果未知；没有自动重放任何工具。", retryable: false, phase: "runtime", stepId: "restore", errorArtifactId: recoveryArtifact?.id, timestamp: now() };
      let recovered = false;
      for (const message of session.messages) {
        if (!["running", "queued", "streaming"].includes(message.status)) continue;
        message.status = "cancelled";
        message.completedAt = now();
        message.failure = interrupted;
        send(runtime, "chat.assistant.failed", { messageId: message.id, ...interrupted, failure: interrupted });
        recovered = true;
      }
      if (recovered) runtime.store.update(session);
      for (const [id, item] of runtime.processes) if (["running", "starting", "waiting"].includes(item.status)) {
        runtime.processes.set(id, { ...item, status: "unknown", stoppedAt: now(), error: interrupted });
        recovered = true;
      }
      runtime.children = runtime.children.map((item) => ["running", "delegated", "queued", "waiting"].includes(item.status) ? { ...item, status: "unknown", completedAt: now(), error: interrupted } : item);
      for (const [id, step] of runtime.timeline) if (step.status === "running") {
        const recoveredStep = { ...step, status: "interrupted", completedAt: now(), detail: { ...step.detail, error: interrupted } };
        runtime.timeline.set(id, recoveredStep);
        send(runtime, "timeline.step.upserted", { revision: ++runtime.timelineRevision, step: recoveredStep }, { turnId: step.detail?.turnId, stepId: id });
      }
      if (recovered) {
        runtime.processRevision += 1;
        emitProcesses(runtime);
        runtime.childrenRevision += 1;
        emitChildren(runtime);
      }
      runtimes.set(runtimeId, runtime);
      send(runtime, "session.attached", { session: { id: session.id, name: session.name } });
      send(runtime, "runtime.snapshot", contextSnapshot(runtime, session));
      return { runtimeId, sessionId: session.id };
    },

    async send({ runtimeId, webContents, frame }) {
      const runtime = runtimes.get(runtimeId);
      if (!runtime || runtime.webContents !== webContents) throw new Error("runtime connection was not found");
      if (!frame || typeof frame !== "object") throw new Error("runtime frame is required");
      if (frame.sessionId !== runtime.sessionId) throw new Error("runtime frame session does not match");
      if (frame.type === "runtime.snapshot.get") { send(runtime, "runtime.snapshot", contextSnapshot(runtime, sessionFor(runtime.workspace, runtime.sessionId))); return { accepted: true }; }
      if (frame.type === "runtime.artifact.get") {
        const event = runtime.store.listTrace(runtime.sessionId).find((item) => item.type === "runtime.artifact.content" && item.payload.artifact?.id === frame.payload?.artifactId);
        if (!event) throw new Error("本会话中没有该结果证据");
        send(runtime, "runtime.artifact.content", event.payload, { turnId: event.turnId, stepId: event.stepId });
        return { accepted: true };
      }
      if (frame.type === "chat.message.send") {
        const persisted = sessionFor(runtime.workspace, runtime.sessionId);
        if (persisted?.messages.some((message) => message.id === frame.payload?.clientMessageId)) return { accepted: true, duplicate: true };
        if (runtime.busy) throw new Error("当前会话仍在运行，请等待本轮完成");
        const task = runChat(runtime, frame).catch((error) => {
          send(runtime, "chat.assistant.failed", { messageId: `message:${crypto.randomUUID()}`, message: error instanceof Error ? error.message : String(error) });
        });
        runtime.task = task;
        pendingTasks.add(task);
        void task.finally(() => pendingTasks.delete(task));
        return { accepted: true };
      }
      if (["run.pause", "run.interrupt", "run.cancel"].includes(frame.type)) {
        runtime.abortController?.abort(new Error("本轮已停止"));
        return { accepted: true };
      }
      if (frame.type === "run.resume") throw new Error("本轮中断后请发送新指令；工具不会自动重放");
      throw new Error(`unsupported runtime command: ${String(frame.type)}`);
    },

    close({ runtimeId, webContents }) {
      const runtime = runtimes.get(runtimeId);
      if (!runtime || runtime.webContents !== webContents) return { closed: false };
      runtime.webContents = undefined;
      if (!runtime.busy) runtimes.delete(runtimeId);
      return { closed: true };
    },

    closeWorkspace({ workspaceId, projectPath }) {
      let closed = 0;
      for (const [runtimeId, runtime] of runtimes.entries()) {
        if (runtime.workspaceId !== workspaceId) continue;
        runtime.abortController?.abort(new Error("项目已关闭"));
        runtimes.delete(runtimeId);
        closed += 1;
      }
      if (projectPath) {
        const key = path.normalize(path.resolve(projectPath));
        const store = stores.get(key);
        if (store) {
          void Promise.allSettled([...pendingTasks]).then(() => store.close());
          stores.delete(key);
        }
      }
      return { closed };
    },

    async closeAll() {
      for (const runtime of runtimes.values()) runtime.abortController?.abort(new Error("应用已关闭"));
      await Promise.allSettled([...pendingTasks]);
      runtimes.clear();
      for (const store of stores.values()) store.close();
      stores.clear();
      legacyStore.close();
    },
  };
}

module.exports = { createRuntimeManager, loadLlmConfig, migrateLegacyJsonSessions };
