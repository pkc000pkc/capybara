const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let modulesPromise;

async function loadBackendModules() {
  if (!modulesPromise) {
    const backendRoot = path.resolve(__dirname, "../../backend");
    modulesPromise = Promise.all([
      import(pathToFileURL(path.join(backendRoot, "dist/core/runtime-loop.js")).href),
      import(pathToFileURL(path.join(backendRoot, "dist/core/session-store.js")).href),
      import(pathToFileURL(path.join(backendRoot, "dist/core/project-initializer.js")).href),
    ]).then(([runtimeModule, sessionModule, initializerModule]) => ({
      RuntimeLoop: runtimeModule.RuntimeLoop,
      SessionStore: sessionModule.SessionStore,
      initializeProjectDirectory: initializerModule.initializeProjectDirectory,
    }));
  }
  return modulesPromise;
}

async function ensureRuntimeProjectFiles(projectPath) {
  const modulesValue = await loadBackendModules();
  const root = path.resolve(projectPath);
  const capybaraRoot = path.join(root, ".capybara");
  const configFile = path.join(capybaraRoot, "config.json");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  } catch {
    config = undefined;
  }
  const configuredMain = config && typeof config.main_template === "string" && config.main_template.trim()
    ? config.main_template.trim()
    : undefined;
  const mainFile = configuredMain ? path.resolve(root, configuredMain) : path.join(root, "main.j2");
  const mainInsideRoot = mainFile === root || (path.relative(root, mainFile) && !path.relative(root, mainFile).startsWith("..") && !path.isAbsolute(path.relative(root, mainFile)));
  if (config && mainInsideRoot && fs.existsSync(mainFile) && fs.statSync(mainFile).isFile()) return;

  const bootstrapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-runtime-bootstrap-"));
  try {
    modulesValue.initializeProjectDirectory(bootstrapRoot);
    fs.mkdirSync(capybaraRoot, { recursive: true });
    if (!config) {
      const bootstrapConfig = JSON.parse(fs.readFileSync(path.join(bootstrapRoot, ".capybara", "config.json"), "utf8"));
      bootstrapConfig.main_template = ".capybara/main.j2";
      fs.writeFileSync(configFile, `${JSON.stringify(bootstrapConfig, null, 2)}\n`, "utf8");
    }
    if (!fs.existsSync(path.join(capybaraRoot, "system-variables.json"))) {
      fs.copyFileSync(path.join(bootstrapRoot, ".capybara", "system-variables.json"), path.join(capybaraRoot, "system-variables.json"));
    }
    const targetMain = config ? mainFile : path.join(capybaraRoot, "main.j2");
    if (mainInsideRoot || !config) {
      fs.mkdirSync(path.dirname(targetMain), { recursive: true });
      fs.copyFileSync(path.join(bootstrapRoot, "main.j2"), targetMain);
    }
  } finally {
    fs.rmSync(bootstrapRoot, { recursive: true, force: true });
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function replaceAbsolutePaths(value, projectPath) {
  if (typeof value !== "string") return value;
  let result = value;
  const normalized = path.resolve(projectPath);
  for (const candidate of [normalized, normalized.replaceAll("\\", "/")]) {
    if (candidate) result = result.split(candidate).join("[local project]");
  }
  // Runtime snapshots contain rendered prompt text as well as structured
  // values. Keep the renderer useful without handing it a native path.
  result = result.replace(/\b[A-Za-z]:\\[^\n"']+/g, "[local path]");
  result = result.replace(/\\\\[^\n"']+/g, "[local path]");
  return result;
}

function sanitizeForRenderer(value, projectPath) {
  if (typeof value === "string") return replaceAbsolutePaths(value, projectPath);
  if (Array.isArray(value)) return value.map((item) => sanitizeForRenderer(item, projectPath));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeForRenderer(item, projectPath)]));
}

function maxSequence(events) {
  return events.reduce((max, event) => Math.max(max, Number(event?.sequence || 0)), 0);
}

const CONTEXT_DOCUMENT_EVENTS = new Set([
  "runtime.context.v2.observed",
  "runtime.context.v2.receipt.created",
  "runtime.context.v2.candidate.reviewed",
  "runtime.context.v2.evidence.reviewed",
  "runtime.context.v2.memory.recalled",
  "runtime.context.v2.child.merged",
  "runtime.context.applied",
  "render.result.updated",
  "run.state.changed",
]);

function contextDocumentVersion({ contextDocumentView, projectContextDocumentView }) {
  return JSON.stringify([projectContextDocumentView, contextDocumentView].map(view => view && [view.meta.id, view.meta.revision]));
}

function publicSession(summary) {
  return {
    id: summary.id,
    name: summary.name,
    kind: "user",
    role: "本地工作 Agent",
    description: "处理当前项目中的用户任务、工具调用和结果验证",
    status: "ready",
    capabilities: ["receive_message", "send_message", "invoke_tools"],
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    requestCount: summary.requestCount,
    restorable: summary.restorable,
  };
}

function legacyMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item && item.type === "text").map((item) => String(item.text || "")).join("");
}

function legacyChatMessages(items) {
  if (!Array.isArray(items)) return [];
  return items.filter((item) => item && typeof item === "object" && (item.role === "user" || item.role === "assistant"))
    .map((item) => ({
      id: String(item.id || `legacy:${crypto.randomUUID()}`),
      ...(typeof item.requestId === "string" ? { requestId: item.requestId } : {}),
      role: item.role === "user" ? "user" : "assistant",
      status: ["queued", "streaming", "completed", "failed", "cancelled"].includes(item.status) ? item.status : "completed",
      content: [{ type: "text", text: legacyMessageText(item) }],
      ...(typeof item.thinkingSummary === "string" ? { thinkingSummary: item.thinkingSummary } : {}),
      ...(Array.isArray(item.evidenceRefs) ? { evidenceRefs: item.evidenceRefs.filter((value) => typeof value === "string") } : {}),
      ...(item.failure && typeof item.failure === "object" ? { failure: item.failure } : {}),
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
      ...(typeof item.completedAt === "string" ? { completedAt: item.completedAt } : {}),
    }));
}

function legacyLlmMessages(items, initial) {
  const converted = legacyChatMessages(items).map((message) => ({
    role: message.role,
    content: message.content.map((item) => item.text).join(""),
  }));
  const system = Array.isArray(initial) ? initial.filter((message) => message?.role === "system") : [];
  return [...system, ...converted];
}

function createBackendRuntimeManager({ emit, applicationHost, browserHost, openExternalMcpUrl, runtimeOptions = {} } = {}) {
  const effectiveRuntimeOptions = {
    ...runtimeOptions,
    ...(openExternalMcpUrl ? { openExternalMcpUrl } : {}),
    childAgentEnabled: runtimeOptions.childAgentEnabled ?? true,
  };
  const runtimes = new Map();
  const stores = new Map();
  const pendingSaves = new Map();
  let loadedModules;

  async function modules() {
    loadedModules ||= await loadBackendModules();
    return loadedModules;
  }

  async function storeFor(projectPath) {
    const modulesValue = await modules();
    const key = path.normalize(path.resolve(projectPath));
    const existing = stores.get(key);
    if (existing) return existing;
    const store = new modulesValue.SessionStore(key);
    stores.set(key, store);
    return store;
  }

  function scheduleSave(runtime) {
    if (pendingSaves.has(runtime.sessionId)) return;
    const timer = setTimeout(() => {
      pendingSaves.delete(runtime.sessionId);
      saveRuntime(runtime);
    }, 250);
    pendingSaves.set(runtime.sessionId, timer);
  }

  function saveRuntime(runtime) {
    try {
      runtime.store.save(runtime.sessionId, runtime.loop.exportState(), runtime.loop.getRequestCount());
    } catch (error) {
      runtime.lastPersistenceError = error instanceof Error ? error.message : String(error);
    }
  }

  function clearScheduledSave(sessionId) {
    const timer = pendingSaves.get(sessionId);
    if (timer) clearTimeout(timer);
    pendingSaves.delete(sessionId);
  }

  function publish(runtime, event, { persist = true } = {}) {
    const sequence = ++runtime.sequence;
    const raw = {
      version: 1,
      kind: "event",
      id: crypto.randomUUID(),
      sessionId: runtime.sessionId,
      sequence,
      timestamp: new Date().toISOString(),
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      ...(event.stepId ? { stepId: event.stepId } : {}),
      ...(event.parentTurnId ? { parentTurnId: event.parentTurnId } : {}),
      ...(event.correlationId ? { correlationId: event.correlationId } : {}),
      type: event.type,
      payload: clone(event.payload),
    };
    if (persist) runtime.store.appendTrace(runtime.sessionId, raw);
    const safe = sanitizeForRenderer(raw, runtime.projectPath);
    emit?.({ runtimeId: runtime.runtimeId, webContents: runtime.webContents, event: safe });
    return raw;
  }

  function snapshotPayload(runtime) {
    const snapshot = clone(runtime.loop.getSnapshot(runtime.sequence));
    snapshot.trace = runtime.store.listTrace(runtime.sessionId);
    return snapshot;
  }

  function publishSnapshot(runtime, resumeMode = "snapshot") {
    const payload = snapshotPayload(runtime);
    runtime.contextDocumentVersion = contextDocumentVersion(payload);
    publish(runtime, {
      type: "runtime.snapshot",
      payload,
    }, { persist: false });
    return resumeMode;
  }

  function scheduleContextDocuments(runtime, snapshot) {
    if (!runtime.webContents || runtime.contextDocumentsQueued || contextDocumentVersion(snapshot) === runtime.contextDocumentVersion) return;
    runtime.contextDocumentsQueued = true;
    // Collect multiple document receipts emitted by one commit before publishing the pair.
    queueMicrotask(() => {
      runtime.contextDocumentsQueued = false;
      if (!runtime.webContents || !runtimes.has(runtime.runtimeId)) return;
      const current = runtime.loop.getSnapshot(runtime.sequence);
      const version = contextDocumentVersion(current);
      if (version === runtime.contextDocumentVersion) return;
      runtime.contextDocumentVersion = version;
      const { contextDocumentView, projectContextDocumentView } = current;
      publish(runtime, { type: "runtime.context.documents.updated", payload: { contextDocumentView, projectContextDocumentView } }, { persist: false });
    });
  }

  async function connect({ workspaceId, workspaceName, projectPath, sessionId, webContents }) {
    const { RuntimeLoop } = await modules();
    const resolvedProjectPath = path.resolve(projectPath);
    await ensureRuntimeProjectFiles(resolvedProjectPath);
    const store = await storeFor(resolvedProjectPath);
    let stored;
    let session;
    let resumeMode = "new";
    if (sessionId) {
      stored = store.get(sessionId);
      if (!stored) throw new Error(`session was not found: ${sessionId}`);
      session = stored.session;
      resumeMode = stored.state ? "snapshot" : "replay";
    } else {
      session = store.create("新会话");
    }

    const key = `${workspaceId}:${session.id}`;
    const existing = [...runtimes.values()].find((runtime) => runtime.key === key);
    if (existing) {
      existing.webContents = webContents;
      publish(existing, {
        type: "session.attached",
        payload: {
          protocolVersion: 1,
          resumeMode: "snapshot",
          project: { path: ".", name: workspaceName },
          session: { id: existing.sessionId, name: session.name },
          serverTime: new Date().toISOString(),
        },
      });
      publishSnapshot(existing, "snapshot");
      return { runtimeId: existing.runtimeId, sessionId: existing.sessionId };
    }

    let loop = new RuntimeLoop({
      ...effectiveRuntimeOptions,
      sessionId: session.id,
      projectDir: resolvedProjectPath,
      workspaceDir: resolvedProjectPath,
      ...(stored?.state ? { initialState: stored.state } : {}),
      ...(applicationHost ? { applicationHost } : {}),
      ...(browserHost ? { browserHost } : {}),
    });
    if (!stored?.state && stored?.legacyMessages?.length) {
      const state = loop.exportState();
      const messages = legacyChatMessages(stored.legacyMessages);
      state.snapshot.conversation.messages = messages;
      state.snapshot.conversation.revision = Math.max(state.snapshot.conversation.revision, messages.length);
      state.snapshot.status.messageCount = Math.max(state.snapshot.status.messageCount, messages.filter((message) => message.role === "user").length);
      state.llmMessages = legacyLlmMessages(stored.legacyMessages, state.llmMessages);
      state.clientMessageIds = messages.filter((message) => message.role === "user").map((message) => message.id);
      await loop.shutdown();
      loop = new RuntimeLoop({
        ...effectiveRuntimeOptions,
        sessionId: session.id,
        projectDir: resolvedProjectPath,
        workspaceDir: resolvedProjectPath,
        initialState: state,
        ...(applicationHost ? { applicationHost } : {}),
        ...(browserHost ? { browserHost } : {}),
      });
      // Persist the translated state before publishing the first snapshot so
      // a close/reopen between migration and the next user message does not
      // repeat the legacy conversion.
      store.save(session.id, state, state.snapshot.status.messageCount);
    }
    const trace = store.listTrace(session.id);
    const runtime = {
      key,
      runtimeId: `runtime:${crypto.randomUUID()}`,
      workspaceId,
      workspaceName,
      projectPath: resolvedProjectPath,
      sessionId: session.id,
      session,
      store,
      loop,
      webContents,
      sequence: maxSequence(trace),
      busy: false,
      lastPersistenceError: undefined,
    };
    runtime.unsubscribe = loop.onEvent((event) => {
      const snapshot = runtime.loop.getSnapshot(0);
      runtime.busy = ["running", "waiting", "pause_requested", "interrupting"].includes(snapshot.run.status);
      publish(runtime, event);
      if (CONTEXT_DOCUMENT_EVENTS.has(event.type)) scheduleContextDocuments(runtime, snapshot);
      scheduleSave(runtime);
    });
    runtimes.set(runtime.runtimeId, runtime);
    publish(runtime, {
      type: "session.attached",
      payload: {
        protocolVersion: 1,
        resumeMode,
        project: { path: ".", name: workspaceName },
        session: { id: session.id, name: session.name },
        serverTime: new Date().toISOString(),
      },
    });
    publishSnapshot(runtime, resumeMode);
    return { runtimeId: runtime.runtimeId, sessionId: runtime.sessionId };
  }

  async function listSessions(workspace) {
    const store = await storeFor(workspace.projectPath);
    return store.list().map(publicSession);
  }

  async function listSessionDirectory(workspace) {
    const items = await listSessions(workspace);
    return { projectId: workspace.workspaceId, revision: Date.now(), generatedAt: new Date().toISOString(), items };
  }

  function sessionProfile(summary, projectId) {
    return { ...publicSession(summary), projectId, address: { canonical: `session://${projectId}/${summary.id}`, aliases: [summary.name] } };
  }

  async function appendExternalMessage(store, sessionSummary, message) {
    const runtime = [...runtimes.values()].find((item) => item.sessionId === sessionSummary.id);
    if (runtime) {
      const result = runtime.loop.appendExternalMessage(message);
      scheduleSave(runtime);
      return result;
    }
    const stored = store.get(sessionSummary.id);
    if (!stored?.state) return undefined;
    const state = stored.state;
    const conversation = state?.snapshot?.conversation;
    if (!conversation || !Array.isArray(conversation.messages)) return undefined;
    const timestamp = new Date().toISOString();
    const result = { id: message.id || `external-${crypto.randomUUID()}`, ...(message.requestId ? { requestId: message.requestId } : {}), role: message.role, status: "completed", content: [{ type: "text", text: message.text }], createdAt: timestamp, completedAt: timestamp };
    conversation.messages.push(result);
    conversation.revision = Number(conversation.revision || 0) + 1;
    state.snapshotRevision = Number(state.snapshotRevision || 0) + 1;
    store.save(sessionSummary.id, state, Number(stored.session.requestCount || 0) + (message.role === "user" ? 1 : 0));
    return result;
  }

  async function appendMessage({ workspace, sessionId, message }) {
    const store = await storeFor(workspace.projectPath);
    const sessionSummary = store.get(sessionId)?.session;
    if (!sessionSummary) throw new Error(`session was not found: ${sessionId}`);
    const result = await appendExternalMessage(store, sessionSummary, message);
    if (!result) throw new Error(`session state was not restorable: ${sessionId}`);
    return result;
  }

  async function sendSessionMessage({ workspace, sourceSessionId, targetSessionId, type = "chat.message", payload = {}, idempotencyKey }) {
    const store = await storeFor(workspace.projectPath);
    const sourceSummary = store.get(sourceSessionId)?.session;
    const targetSummary = store.get(targetSessionId)?.session;
    const source = String(sourceSessionId || "").startsWith("application:")
      ? { id: sourceSessionId, name: "项目应用", kind: "application", role: "项目应用", description: "向项目会话发送应用消息", status: "ready", capabilities: ["send_message"], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), projectId: workspace.workspaceId, address: { canonical: `session://${workspace.workspaceId}/${sourceSessionId}`, aliases: ["项目应用"] } }
      : sourceSummary && sessionProfile(sourceSummary, workspace.workspaceId);
    const target = targetSummary && sessionProfile(targetSummary, workspace.workspaceId);
    if (!source || !target) throw new Error("目标会话不存在");
    if (source.id === target.id) throw new Error("不能向当前会话自身发送会话消息");
    if (idempotencyKey) {
      const previous = store.listTrace(target.id).find((event) => event.type === "session.message.completed" && event.payload?.idempotencyKey === idempotencyKey);
      if (previous?.payload) {
        const previousPayload = previous.payload;
        return {
          receiptId: previousPayload.receiptId,
          messageId: previousPayload.messageId,
          callbackId: previousPayload.callbackId,
          status: "completed",
          source: previousPayload.source || source,
          target: previousPayload.target || target,
          callbackText: previousPayload.callbackText || "",
          traceRefs: { messageId: previousPayload.messageId, parentMessageId: previousPayload.callbackId },
          duplicate: true,
        };
      }
    }
    const messageId = `message:${crypto.randomUUID()}`;
    const receiptId = `receipt:${crypto.randomUUID()}`;
    const requestId = receiptId;
    const text = typeof payload?.text === "string" && payload.text.trim() ? payload.text.trim() : "收到一条会话消息";
    await appendExternalMessage(store, targetSummary, { id: messageId, requestId, role: "user", text });
    const replyText = `我是${target.name}，职责是${target.description}。已收到来自${source.name}的消息：“${text}”。`;
    const replyId = `message:${crypto.randomUUID()}`;
    await appendExternalMessage(store, targetSummary, { id: replyId, requestId, role: "assistant", text: replyText });
    const callbackId = `message:${crypto.randomUUID()}`;
    const callbackText = `${target.name} 回复：${replyText}`;
    if (sourceSummary) await appendExternalMessage(store, sourceSummary, { id: callbackId, requestId, role: "assistant", text: callbackText });
    const createdAt = new Date().toISOString();
    const envelope = {
      protocol: "capybara.session-message.v1",
      messageId,
      projectId: workspace.workspaceId,
      source,
      target: { sessionId: target.id, projectId: workspace.workspaceId },
      relation: source.kind === "application" ? "application" : target.kind === "child" ? "a2a" : "direct",
      type,
      payload,
      correlation: { parentSessionId: source.id, childId: target.kind === "child" ? target.id : undefined },
      delivery: { mode: "enqueue", idempotencyKey: idempotencyKey || messageId, requireReceipt: true },
      authorization: { actorSessionId: source.id, capability: "send_message", requestId: receiptId, permissionRevision: "session-directory:1" },
      createdAt,
    };
    const payloadEnvelope = {
      receiptId,
      messageId,
      status: "completed",
      receivedAt: createdAt,
      deliveredAt: createdAt,
      completedAt: new Date().toISOString(),
      traceRefs: { messageId, parentMessageId: callbackId },
      envelope,
      source,
      target,
      callbackId,
      callbackText,
      idempotencyKey: idempotencyKey || messageId,
    };
    for (const runtime of runtimes.values()) {
      if (runtime.workspaceId !== workspace.workspaceId) continue;
      if (runtime.sessionId === target.id || runtime.sessionId === source.id) {
        publish(runtime, { type: "session.message.completed", payload: payloadEnvelope });
        publishSnapshot(runtime);
      }
    }
    return { receiptId, messageId, callbackId, status: "completed", source, target, callbackText, traceRefs: { messageId, parentMessageId: callbackId } };
  }

  async function send({ runtimeId, webContents, frame }) {
    const runtime = runtimes.get(runtimeId);
    if (!runtime || runtime.webContents !== webContents) throw new Error("runtime connection was not found");
    if (!frame || typeof frame !== "object") throw new Error("runtime frame is required");
    if (frame.sessionId !== runtime.sessionId) throw new Error("runtime frame session does not match");
    try {
      runtime.loop.validate(frame);
    } catch (error) {
      publish(runtime, {
        type: "command.rejected",
        correlationId: frame.id,
        payload: {
          commandId: frame.id,
          code: error?.code || "INVALID_PAYLOAD",
          message: error instanceof Error ? error.message : String(error),
          retryable: Boolean(error?.options?.retryable),
          ...(error?.options?.details ? { details: error.options.details } : {}),
          ...(error?.options?.currentRevision === undefined ? {} : { currentRevision: error.options.currentRevision }),
        },
      });
      return { accepted: false };
    }
    publish(runtime, {
      type: "command.accepted",
      correlationId: frame.id,
      payload: { commandId: frame.id, acceptedAt: new Date().toISOString() },
    });
    try {
      runtime.loop.execute(frame, runtime.sequence + 1);
      runtime.busy = ["running", "waiting", "pause_requested", "interrupting"].includes(runtime.loop.getSnapshot(0).run.status);
      scheduleSave(runtime);
    } catch (error) {
      publish(runtime, {
        type: "protocol.error",
        correlationId: frame.id,
        payload: { code: "INTERNAL_EXECUTION_ERROR", message: error instanceof Error ? error.message : String(error) },
      });
      scheduleSave(runtime);
    }
    return { accepted: true };
  }

  function mcpInputUrl({ runtimeId, webContents, requestId, urlId, open }) {
    const runtime = runtimes.get(runtimeId);
    if (!runtime || runtime.webContents !== webContents) throw new Error("runtime connection was not found");
    if (typeof requestId !== "string" || !/^mcp-input-[a-f0-9-]{36}$/.test(requestId)
      || typeof urlId !== "string" || !/^mcp-url-[a-f0-9-]{36}$/.test(urlId)) throw new Error("invalid MCP URL input identity");
    return open ? runtime.loop.openMcpInputUrl(requestId, urlId) : runtime.loop.readMcpInputUrl(requestId, urlId);
  }

  async function close({ runtimeId, webContents }) {
    const runtime = runtimes.get(runtimeId);
    if (!runtime || runtime.webContents !== webContents) return { closed: false };
    runtime.webContents = undefined;
    saveRuntime(runtime);
    if (!runtime.busy) {
      clearScheduledSave(runtime.sessionId);
      runtime.unsubscribe?.();
      await runtime.loop.shutdown();
      runtimes.delete(runtimeId);
    }
    return { closed: true };
  }

  // A project can own several session runtimes and the project-close IPC
  // boundary does not have a renderer webContents/runtime id to pass in.
  // Close every runtime belonging to that project using the same persistence
  // and cleanup rules as an individual runtime disconnect.
  async function closeWorkspace({ workspaceId, projectPath } = {}) {
    const normalizedProjectPath = projectPath ? path.normalize(path.resolve(projectPath)) : undefined;
    let closed = 0;
    for (const [runtimeId, runtime] of [...runtimes.entries()]) {
      const sameWorkspace = workspaceId && runtime.workspaceId === workspaceId;
      const sameProject = normalizedProjectPath && path.normalize(path.resolve(runtime.projectPath)) === normalizedProjectPath;
      if (!sameWorkspace && !sameProject) continue;

      runtime.webContents = undefined;
      saveRuntime(runtime);
      clearScheduledSave(runtime.sessionId);
      runtime.unsubscribe?.();
      await runtime.loop.shutdown();
      runtimes.delete(runtimeId);
      closed += 1;
    }
    return { closed: true, runtimeCount: closed };
  }

  async function closeAll() {
    for (const runtime of runtimes.values()) {
      runtime.webContents = undefined;
      clearScheduledSave(runtime.sessionId);
      saveRuntime(runtime);
      runtime.unsubscribe?.();
      await runtime.loop.shutdown();
    }
    runtimes.clear();
    for (const store of stores.values()) store.close();
    stores.clear();
  }

  return {
    hasActiveRuns() {
      return [...runtimes.values()].some((runtime) => runtime.busy);
    },
    connect,
    listSessions,
    listSessionDirectory,
    appendMessage,
    sendSessionMessage,
    send,
    mcpInputUrl,
    close,
    closeWorkspace,
    closeAll,
    ready: modules(),
  };
}

module.exports = { createBackendRuntimeManager, loadBackendModules };
