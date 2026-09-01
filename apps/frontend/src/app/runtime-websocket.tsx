"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CommandPayloadMap,
  CommandType,
  ExecutionMode,
  JsonPatchOperation,
  JsonValue,
  RuntimeBreakpoint,
  RuntimeArtifactPage,
  RuntimeVariablePage,
  RuntimeSnapshot,
  ServerEvent,
} from "./runtime-protocol";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type ProjectInfo = { path: string; name: string };
export type ProjectSelectionResult = {
  status: "selected" | "initialization-required";
  project: ProjectInfo;
};
export type SessionSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  requestCount: number;
  restorable: boolean;
  stateBytes: number;
};
export type SessionStorageStats = {
  bytes: number;
  sessionCount: number;
  databaseFile: string;
};

export type RuntimeVariableUpdate = {
  sequence: number;
  timestamp: string;
  revision: number;
  source: "user" | "runtime" | "tool" | "hook" | "restore";
  patch: JsonPatchOperation[];
};

export type RunnerMonitor = {
  active: boolean;
  session: SessionSummary;
  persistence: { lastSavedAt?: string; lastError?: string };
  ledger: {
    valid: boolean;
    head: string;
    totalEvents: number;
    path: string;
    error?: string;
  };
};

type RuntimeStore = {
  connection: ConnectionState;
  error: string | null;
  lastEventAt: string | null;
  lastSequence: number;
  sessionId: string | null;
  snapshot: RuntimeSnapshot | null;
  supportsPagination: boolean;
  artifactContents: Record<string, JsonValue>;
  artifactPages: Record<string, RuntimeArtifactPage>;
  variablePages: Record<string, RuntimeVariablePage>;
  recentVariableUpdates: RuntimeVariableUpdate[];
};

type RuntimeContextValue = RuntimeStore & {
  project: ProjectInfo | null;
  sessions: SessionSummary[];
  activeSession: SessionSummary | null;
  sessionStorage: SessionStorageStats | null;
  runnerMode: boolean;
  runnerMonitor: RunnerMonitor | null;
  closeProject: () => Promise<void>;
  clearSessions: () => Promise<void>;
  createSession: () => Promise<void>;
  renameSession: (name: string) => Promise<void>;
  refreshSessionStorage: () => Promise<void>;
  selectProject: (path: string, initialize?: boolean) => Promise<ProjectSelectionResult>;
  selectSession: (sessionId: string) => void;
  attachHarness: (harnessId: string) => void;
  attachSkill: (skillId: string) => void;
  confirmSkillOperation: (confirmationId: string) => void;
  cancelSkillOperation: (confirmationId: string) => void;
  applyVariables: (patch: JsonPatchOperation[]) => void;
  applyContext: (contextRevisionId: string) => void;
  attachTool: (toolId: string) => void;
  cancelResponse: (assistantMessageId?: string) => void;
  cancelRun: () => void;
  clearError: () => void;
  detachTool: (toolId: string) => void;
  interruptRun: () => void;
  getArtifact: (artifactId: string) => void;
  getArtifactPage: (artifactId: string, page: number, pageSize: number) => void;
  getVariablePage: (path: string, page: number, pageSize: number) => void;
  pauseRun: () => void;
  detachHarness: (harnessId: string) => void;
  detachSkill: (skillId: string) => void;
  loadSkillReference: (skillId: string, path: string) => void;
  runSkillScript: (skillId: string, path: string, argv: string[]) => void;
  renderTemplate: () => void;
  restorePrevious: () => void;
  restoreCheckpoint: (checkpointId: string) => void;
  restartStep: (stepId?: string, confirmSideEffects?: boolean) => void;
  resumeRun: () => void;
  sendChatMessage: (content: string) => void;
  setRunMode: (mode: ExecutionMode) => void;
  startRun: () => void;
  stepRun: () => void;
  removeBreakpoint: (breakpointId: string) => void;
  upsertBreakpoint: (breakpoint: RuntimeBreakpoint) => void;
  updateTemplate: (source: string) => void;
};

const INITIAL_STORE: RuntimeStore = {
  connection: "connecting",
  error: null,
  lastEventAt: null,
  lastSequence: 0,
  sessionId: null,
  snapshot: null,
  supportsPagination: true,
  artifactContents: {},
  artifactPages: {},
  variablePages: {},
  recentVariableUpdates: [],
};

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

const RUNNER_URL = process.env.NEXT_PUBLIC_RUNNER_URL?.replace(/\/$/, "");
const RUNNER_SESSION_ID = process.env.NEXT_PUBLIC_RUNNER_SESSION_ID;
const RUNNER_MODE = Boolean(RUNNER_URL && RUNNER_SESSION_ID);
const RUNNER_READ_COMMANDS = new Set<CommandType>([
  "runtime.snapshot.get",
  "runtime.artifact.get",
  "runtime.artifact.page",
  "runtime.variable.page",
]);
const SNAPSHOT_RESYNC_TIMEOUT_MS = 8_000;
const SNAPSHOT_RESYNC_CLOSE_CODE = 4_000;

function httpBase() {
  if (RUNNER_URL) return RUNNER_URL;
  const configured = process.env.NEXT_PUBLIC_RUNTIME_HTTP_URL?.replace(/\/$/, "");
  return configured ?? `${window.location.protocol}//${window.location.hostname}:3005`;
}

async function httpRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(`${httpBase()}${path}`, {
    ...init,
    headers,
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

async function loadSessions(projectPath: string) {
  if (RUNNER_MODE) {
    const result = await httpRequest<{ items: SessionSummary[] }>("/v1/sessions");
    return { project: await httpRequest<ProjectInfo>("/v1/project"), items: result.items };
  }
  return httpRequest<{ project: ProjectInfo; items: SessionSummary[] }>(
    `/api/sessions?projectPath=${encodeURIComponent(projectPath)}`,
  );
}

async function createProjectSession(projectPath: string) {
  if (RUNNER_MODE) {
    throw new Error("Runner monitoring is read-only");
  }
  return httpRequest<SessionSummary>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ projectPath }),
  });
}

async function renameProjectSession(projectPath: string, sessionId: string, name: string) {
  if (RUNNER_MODE) {
    throw new Error("Runner monitoring is read-only");
  }
  return httpRequest<SessionSummary>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    body: JSON.stringify({ projectPath, name }),
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sameProjectPath(left: string, right: string): boolean {
  const normalize = (value: string) => value
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function decodePointer(path: string): string[] {
  return path
    .slice(1)
    .split("/")
    .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function applyJsonPatch<T extends JsonValue>(
  value: T,
  operations: JsonPatchOperation[],
): T {
  const root = clone(value) as JsonValue;
  for (const operation of operations) {
    const tokens = decodePointer(operation.path);
    let parent = root;
    for (const token of tokens.slice(0, -1)) {
      parent = Array.isArray(parent)
        ? (parent[Number(token)] as JsonValue)
        : ((parent as Record<string, JsonValue>)[token] as JsonValue);
    }
    const finalToken = tokens.at(-1) as string;
    if (Array.isArray(parent)) {
      const index = finalToken === "-" ? parent.length : Number(finalToken);
      if (operation.op === "add") parent.splice(index, 0, clone(operation.value));
      else if (operation.op === "replace") parent[index] = clone(operation.value);
      else parent.splice(index, 1);
    } else {
      const record = parent as Record<string, JsonValue>;
      if (operation.op === "remove") delete record[finalToken];
      else record[finalToken] = clone(operation.value);
    }
  }
  return root as T;
}

function upsertMessage(
  messages: RuntimeSnapshot["conversation"]["messages"],
  message: RuntimeSnapshot["conversation"]["messages"][number],
) {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message];
  return messages.map((item) => (item.id === message.id ? message : item));
}

function failureMessage(failure: { code: string; message: string }): string {
  return `${failure.code}: ${failure.message}`;
}

function applyEvent(store: RuntimeStore, event: ServerEvent): RuntimeStore {
  if (event.type === "session.attached") {
    return {
      ...store,
      connection: "connected",
      error: null,
      lastSequence: event.sequence,
      sessionId: event.sessionId,
    };
  }
  if (event.type === "runtime.snapshot") {
    return {
      ...store,
      connection: "connected",
      error: event.payload.run.failure
        ? failureMessage(event.payload.run.failure)
        : null,
      lastSequence: event.sequence,
      sessionId: event.sessionId,
      snapshot: clone(event.payload),
      artifactContents: {},
      artifactPages: {},
      variablePages: {},
    };
  }

  const snapshot = store.snapshot;
  if (!snapshot) return { ...store, lastSequence: event.sequence };
  let next = snapshot;

  switch (event.type) {
    case "command.rejected":
      return {
        ...store,
        error: `${event.payload.code}: ${event.payload.message}`,
        lastSequence: event.sequence,
      };
    case "protocol.error":
      return {
        ...store,
        error: `${event.payload.code}: ${event.payload.message}`,
        lastSequence: event.sequence,
      };
    case "run.state.changed":
      next = { ...snapshot, run: clone(event.payload) };
      if (event.payload.failure) {
        return {
          ...store,
          error: failureMessage(event.payload.failure),
          lastSequence: event.sequence,
          snapshot: next,
        };
      }
      break;
    case "run.trace.started":
      return {
        ...store,
        error: null,
        lastSequence: event.sequence,
        artifactContents: {},
        artifactPages: {},
        variablePages: {},
        snapshot: {
          ...snapshot,
          run: clone(event.payload.run),
          timeline: clone(event.payload.timeline),
          artifacts: clone(event.payload.artifacts),
          contexts: clone(event.payload.contexts),
          checkpoints: clone(event.payload.checkpoints),
          effectiveContexts: clone(event.payload.effectiveContexts),
          observations: clone(event.payload.observations),
          workflows: clone(event.payload.workflows),
        },
      };
    case "runtime.status.updated":
      next = { ...snapshot, status: clone(event.payload) };
      break;
    case "runtime.artifact.created":
      next = {
        ...snapshot,
        artifacts: {
          revision: snapshot.artifacts.revision + 1,
          items: [...snapshot.artifacts.items, clone(event.payload.artifact)],
        },
      };
      break;
    case "runtime.artifact.content":
      return {
        ...store,
        error: null,
        lastSequence: event.sequence,
        artifactContents: {
          ...store.artifactContents,
          [event.payload.artifact.id]: clone(event.payload.value),
        },
      };
    case "runtime.artifact.page":
      return {
        ...store,
        error: null,
        lastSequence: event.sequence,
        artifactPages: {
          ...store.artifactPages,
          [`${event.payload.artifact.id}:${event.payload.page}:${event.payload.pageSize}`]: clone(event.payload),
        },
      };
    case "runtime.variable.page":
      return {
        ...store,
        error: null,
        lastSequence: event.sequence,
        variablePages: {
          ...store.variablePages,
          [`${event.payload.path}:${event.payload.revision}:${event.payload.page}:${event.payload.pageSize}`]: clone(event.payload),
        },
      };
    case "runtime.context.revision.created":
      next = {
        ...snapshot,
        contexts: {
          ...snapshot.contexts,
          revision: event.payload.revision,
          pendingId: event.payload.context.id,
          items: [...snapshot.contexts.items, clone(event.payload.context)],
        },
      };
      break;
    case "runtime.context.applied":
      next = {
        ...snapshot,
        contexts: {
          ...snapshot.contexts,
          revision: event.payload.revision,
          activeId: event.payload.contextRevisionId,
          pendingId:
            snapshot.contexts.pendingId === event.payload.contextRevisionId
              ? undefined
              : snapshot.contexts.pendingId,
          items: snapshot.contexts.items.map((context) =>
            context.id === event.payload.contextRevisionId
              ? { ...context, appliedAt: new Date().toISOString() }
              : context,
          ),
        },
      };
      break;
    case "runtime.effectiveContext.created":
      next = {
        ...snapshot,
        effectiveContexts: {
          revision: event.payload.revision,
          activeId: event.payload.context.id,
          items: [
            ...snapshot.effectiveContexts.items,
            clone(event.payload.context),
          ],
        },
      };
      break;
    case "runtime.observation.upserted": {
      const existing = snapshot.observations.items.findIndex(
        (item) => item.id === event.payload.observation.id,
      );
      const items = [...snapshot.observations.items];
      if (existing >= 0) items[existing] = clone(event.payload.observation);
      else items.push(clone(event.payload.observation));
      next = {
        ...snapshot,
        observations: { revision: event.payload.revision, items },
      };
      break;
    }
    case "runtime.workflows.updated":
      next = { ...snapshot, workflows: clone(event.payload) };
      break;
    case "runtime.checkpoint.created":
      next = {
        ...snapshot,
        checkpoints: {
          revision: event.payload.revision,
          items: [...snapshot.checkpoints.items, clone(event.payload.checkpoint)],
        },
      };
      break;
    case "runtime.checkpoint.restored":
      // A full authoritative snapshot follows this event.
      break;
    case "runtime.breakpoints.updated":
      next = { ...snapshot, breakpoints: clone(event.payload) };
      break;
    case "run.breakpoint.hit":
      break;
    case "chat.user.created":
      next = {
        ...snapshot,
        conversation: {
          revision: snapshot.conversation.revision + 1,
          messages: upsertMessage(snapshot.conversation.messages, clone(event.payload)),
        },
      };
      break;
    case "chat.assistant.started":
      next = {
        ...snapshot,
        conversation: {
          revision: snapshot.conversation.revision + 1,
          messages: upsertMessage(
            snapshot.conversation.messages,
            clone(event.payload.message),
          ),
        },
      };
      break;
    case "chat.assistant.delta":
      next = {
        ...snapshot,
        conversation: {
          ...snapshot.conversation,
          messages: snapshot.conversation.messages.map((message) => {
            if (message.id !== event.payload.messageId) return message;
            if (event.payload.channel === "thinkingSummary") {
              return {
                ...message,
                thinkingSummary: `${message.thinkingSummary ?? ""}${event.payload.delta}`,
              };
            }
            const content = message.content[0] ?? { type: "text" as const, text: "" };
            return {
              ...message,
              content: [
                { type: "text" as const, text: `${content.text}${event.payload.delta}` },
              ],
            };
          }),
        },
      };
      break;
    case "chat.assistant.completed":
      next = {
        ...snapshot,
        conversation: {
          revision: snapshot.conversation.revision + 1,
          messages: snapshot.conversation.messages.map((message) =>
            message.id === event.payload.messageId
              ? {
                  ...message,
                  status:
                    event.payload.finishReason === "cancelled"
                      ? ("cancelled" as const)
                      : ("completed" as const),
                  completedAt: event.payload.completedAt,
                }
              : message,
          ),
        },
      };
      break;
    case "chat.assistant.failed":
      next = {
        ...snapshot,
        conversation: {
          revision: snapshot.conversation.revision + 1,
          messages: snapshot.conversation.messages.map((message) =>
            message.id === event.payload.messageId
              ? {
                  ...message,
                  status: "failed" as const,
                  failure: clone(event.payload.failure),
                }
              : message,
          ),
        },
      };
      return {
        ...store,
        error: failureMessage(event.payload.failure),
        lastSequence: event.sequence,
        snapshot: next,
      };
    case "variables.updated":
      next = {
        ...snapshot,
        variables: {
          revision: event.payload.revision,
          value: applyJsonPatch(snapshot.variables.value, event.payload.patch),
        },
      };
      return {
        ...store,
        error: null,
        lastSequence: event.sequence,
        snapshot: next,
        recentVariableUpdates: [
          {
            sequence: event.sequence,
            timestamp: event.timestamp,
            revision: event.payload.revision,
            source: event.payload.source,
            patch: clone(event.payload.patch),
          },
          ...store.recentVariableUpdates,
        ].slice(0, 24),
      };
    case "template.updated":
      next = { ...snapshot, template: clone(event.payload) };
      break;
    case "render.result.updated":
      next = { ...snapshot, renderResult: clone(event.payload) };
      break;
    case "render.result.failed":
    case "template.validation.failed":
      return {
        ...store,
        error: event.payload.diagnostics.map((item) => item.message).join("; "),
        lastSequence: event.sequence,
      };
    case "runtime.tools.updated":
      next = { ...snapshot, tools: clone(event.payload) };
      break;
    case "runtime.harnesses.updated":
      next = { ...snapshot, harnesses: clone(event.payload) };
      break;
    case "runtime.plugins.updated":
      next = { ...snapshot, plugins: clone(event.payload) };
      break;
    case "runtime.skills.updated":
      next = { ...snapshot, skills: clone(event.payload) };
      break;
    case "runtime.skills.confirmations.updated":
      next = { ...snapshot, skillConfirmations: clone(event.payload) };
      break;
    case "timeline.step.upserted": {
      const existing = snapshot.timeline.steps.findIndex(
        (step) => step.id === event.payload.step.id,
      );
      const steps = [...snapshot.timeline.steps];
      if (existing >= 0) steps[existing] = clone(event.payload.step);
      else steps.push(clone(event.payload.step));
      steps.sort((left, right) => left.index - right.index);
      next = {
        ...snapshot,
        timeline: { revision: event.payload.revision, steps },
      };
      break;
    }
    case "tool.call.started":
    case "tool.call.completed":
    case "tool.call.failed":
      // Tool state is rendered from its authoritative timeline step.
      break;
  }

  return {
    ...store,
    error: event.type === "command.accepted" ? null : store.error,
    lastSequence: event.sequence,
    snapshot: next,
  };
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<RuntimeStore>(INITIAL_STORE);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<SessionSummary | null>(null);
  const [sessionStorage, setSessionStorage] = useState<SessionStorageStats | null>(null);
  const [runnerMonitor, setRunnerMonitor] = useState<RunnerMonitor | null>(null);
  const activeSessionId = activeSession?.id;
  const storeRef = useRef(store);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const resyncingRef = useRef(false);

  const commit = useCallback((update: (current: RuntimeStore) => RuntimeStore) => {
    const next = update(storeRef.current);
    storeRef.current = next;
    setStore(next);
  }, []);

  const commitServerEvent = useCallback((event: ServerEvent) => {
    const current = storeRef.current;
    const next = {
      ...applyEvent(current, event),
      lastEventAt: event.timestamp,
    };
    storeRef.current = next;

    // Sequence-only events still advance storeRef for gap detection without
    // rerendering the full runtime workspace.
    if (
      next.connection !== current.connection ||
      next.error !== current.error ||
      next.sessionId !== current.sessionId ||
      next.snapshot !== current.snapshot ||
      next.artifactContents !== current.artifactContents ||
      next.artifactPages !== current.artifactPages ||
      next.variablePages !== current.variablePages ||
      next.recentVariableUpdates !== current.recentVariableUpdates ||
      current.lastEventAt === null
    ) {
      setStore(next);
    }
  }, []);

  const sendCommand = useCallback(
    <TType extends CommandType>(
      type: TType,
      payload: CommandPayloadMap[TType],
    ) => {
      if (RUNNER_MODE && !RUNNER_READ_COMMANDS.has(type)) {
        commit((state) => ({ ...state, error: "Runner monitoring is read-only" }));
        return;
      }
      const socket = socketRef.current;
      const current = storeRef.current;
      if (
        socket?.readyState !== WebSocket.OPEN ||
        !current.sessionId ||
        current.connection !== "connected"
      ) {
        commit((state) => ({ ...state, error: "Runtime WebSocket is not connected" }));
        return;
      }
      socket.send(
        JSON.stringify({
          version: 1,
          kind: "command",
          id: crypto.randomUUID(),
          type,
          sessionId: current.sessionId,
          runId: current.snapshot?.run.runId ?? undefined,
          timestamp: new Date().toISOString(),
          payload,
        }),
      );
    },
    [commit],
  );

  const activateSession = useCallback((session: SessionSummary) => {
    reconnectAttemptRef.current = 0;
    commit(() => ({ ...INITIAL_STORE }));
    setActiveSession(session);
    localStorage.setItem("capybara-session-id", session.id);
  }, [commit]);

  const refreshSessionStorage = useCallback(async () => {
    if (!project) return;
    const stats = await httpRequest<SessionStorageStats>(
      RUNNER_MODE
        ? "/v1/storage"
        : `/api/sessions/storage?projectPath=${encodeURIComponent(project.path)}`,
    );
    setSessionStorage(stats);
  }, [project]);

  const selectProject = useCallback(async (input: string, initialize = false): Promise<ProjectSelectionResult> => {
    if (RUNNER_MODE) throw new Error("Runner monitoring uses the project fixed at server startup");
    const status = storeRef.current.snapshot?.run.status;
    if (status && ["running", "waiting", "pause_requested", "paused", "interrupting"].includes(status)) {
      throw new Error("Interrupt or finish the current run before switching projects");
    }
    const inspection = await httpRequest<ProjectInfo & { status: "ready" | "empty" }>("/api/projects/inspect", {
      method: "POST",
      body: JSON.stringify({ path: input }),
    });
    if (inspection.status === "empty" && !initialize) {
      return { status: "initialization-required", project: inspection };
    }
    const selectedProject = inspection.status === "empty"
      ? await httpRequest<ProjectInfo>("/api/projects/initialize", {
          method: "POST",
          body: JSON.stringify({ path: inspection.path }),
        })
      : inspection;
    await httpRequest<ProjectInfo>("/api/projects/open", {
      method: "POST",
      body: JSON.stringify({ path: selectedProject.path }),
    });
    const loaded = await loadSessions(selectedProject.path);
    const session = loaded.items.find((item) => item.restorable)
      ?? await createProjectSession(selectedProject.path);
    if (project && !sameProjectPath(project.path, selectedProject.path)) {
      await httpRequest<{ released: true }>("/api/projects/release", {
        method: "POST",
        body: JSON.stringify({ path: project.path }),
      });
    }
    setProject(selectedProject);
    setSessions(loaded.items.length > 0 ? loaded.items : [session]);
    setSessionStorage(null);
    localStorage.setItem("capybara-project-path", selectedProject.path);
    activateSession(session);
    return { status: "selected", project: selectedProject };
  }, [activateSession, project]);

  const closeProject = useCallback(async () => {
    if (!project) return;
    if (RUNNER_MODE) throw new Error("Runner monitoring cannot close the server project");
    const status = storeRef.current.snapshot?.run.status;
    if (status && ["running", "waiting", "pause_requested", "paused", "interrupting"].includes(status)) {
      throw new Error("Interrupt or finish the current run before closing the project");
    }
    await httpRequest<{ released: true }>("/api/projects/release", {
      method: "POST",
      body: JSON.stringify({ path: project.path }),
    });
    reconnectAttemptRef.current = 0;
    setProject(null);
    setSessions([]);
    setActiveSession(null);
    setSessionStorage(null);
    setRunnerMonitor(null);
    localStorage.removeItem("capybara-project-path");
    localStorage.removeItem("capybara-session-id");
    commit(() => ({ ...INITIAL_STORE, connection: "disconnected" }));
  }, [commit, project]);

  const createSession = useCallback(async () => {
    if (!project) return;
    if (RUNNER_MODE) throw new Error("Runner monitoring is read-only");
    const status = storeRef.current.snapshot?.run.status;
    if (status && ["running", "waiting", "pause_requested", "paused", "interrupting"].includes(status)) {
      throw new Error("Interrupt or finish the current run before creating a session");
    }
    const session = await createProjectSession(project.path);
    setSessions((current) => [session, ...current]);
    activateSession(session);
  }, [activateSession, project]);

  const renameSession = useCallback(async (name: string) => {
    if (!project || !activeSession) return;
    if (RUNNER_MODE) throw new Error("Runner monitoring is read-only");
    const status = storeRef.current.snapshot?.run.status;
    if (status && ["running", "waiting", "pause_requested", "paused", "interrupting"].includes(status)) {
      throw new Error("Interrupt or finish the current run before renaming the session");
    }
    try {
      const renamed = await renameProjectSession(project.path, activeSession.id, name);
      setSessions((current) => [renamed, ...current.filter((session) => session.id !== renamed.id)]);
      setActiveSession((current) => current?.id === renamed.id ? renamed : current);
      commit((state) => ({ ...state, error: null }));
    } catch (error) {
      commit((state) => ({
        ...state,
        error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  }, [activeSession, commit, project]);

  const selectSession = useCallback((sessionId: string) => {
    if (RUNNER_MODE) return;
    const status = storeRef.current.snapshot?.run.status;
    if (status && ["running", "waiting", "pause_requested", "paused", "interrupting"].includes(status)) return;
    const selected = sessions.find((session) => session.id === sessionId && session.restorable);
    if (!selected) {
      commit((state) => ({
        ...state,
        error: "Session state is too large to restore safely",
      }));
      return;
    }
    if (selected && selected.id !== activeSession?.id) activateSession(selected);
  }, [activateSession, activeSession?.id, commit, sessions]);

  const clearSessions = useCallback(async () => {
    if (!project) return;
    if (RUNNER_MODE) throw new Error("Runner monitoring does not clear session storage while attached");
    const status = storeRef.current.snapshot?.run.status;
    if (status && ["running", "waiting", "pause_requested", "paused", "interrupting"].includes(status)) {
      throw new Error("Interrupt or finish the current run before clearing sessions");
    }
    await httpRequest<SessionStorageStats>(
      `/api/sessions?projectPath=${encodeURIComponent(project.path)}`,
      { method: "DELETE" },
    );
    const session = await createProjectSession(project.path);
    setSessions([session]);
    activateSession(session);
    await refreshSessionStorage();
  }, [activateSession, project, refreshSessionStorage]);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        if (RUNNER_MODE) {
          const runnerInfo = await httpRequest<{ capabilities: string[] }>("/v1/agent")
            .catch((): { capabilities: string[] } => ({ capabilities: [] }));
          const selectedProject = await httpRequest<ProjectInfo>("/v1/project");
          const loaded = await loadSessions(selectedProject.path);
          const session = loaded.items.find((item) => item.id === RUNNER_SESSION_ID);
          if (!session) throw new Error(`Runner session was not found: ${RUNNER_SESSION_ID}`);
          if (disposed) return;
          setProject(selectedProject);
          setSessions(loaded.items.length > 0 ? loaded.items : [session]);
          commit((state) => ({
            ...state,
            supportsPagination: runnerInfo.capabilities.includes("pagination"),
          }));
          setActiveSession(session);
          localStorage.setItem("capybara-session-id", session.id);
          return;
        }
        const savedPath = localStorage.getItem("capybara-project-path");
        const selectedProject = savedPath
          ? await httpRequest<ProjectInfo>("/api/projects/inspect", {
              method: "POST",
              body: JSON.stringify({ path: savedPath }),
            }).catch(() => httpRequest<ProjectInfo>("/api/projects/default"))
          : await httpRequest<ProjectInfo>("/api/projects/default");
        if (disposed) return;
        await httpRequest<ProjectInfo>("/api/projects/open", {
          method: "POST",
          body: JSON.stringify({ path: selectedProject.path }),
        });
        if (disposed) return;
        const loaded = await loadSessions(selectedProject.path);
        if (disposed) return;
        const savedSessionId = localStorage.getItem("capybara-session-id");
        const restorable = loaded.items.filter((item) => item.restorable);
        const session = restorable.find((item) => item.id === savedSessionId)
          ?? restorable[0]
          ?? await createProjectSession(selectedProject.path);
        if (disposed) return;
        setProject(selectedProject);
        setSessions(loaded.items.length > 0 ? loaded.items : [session]);
        setActiveSession(session);
      } catch (error) {
        commit((state) => ({
          ...state,
          connection: "disconnected",
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
    return () => { disposed = true; };
  }, [commit]);

  useEffect(() => {
    if (!project || !activeSessionId) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let resyncTimer: number | undefined;
    const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const endpointUrl = RUNNER_MODE
      ? new URL(
          `/v1/sessions/${encodeURIComponent(activeSessionId)}/observe`,
          RUNNER_URL,
        )
      : new URL(
          process.env.NEXT_PUBLIC_RUNTIME_WS_URL ??
            `${socketProtocol}//${window.location.hostname}:3005/ws/runtime`,
        );
    endpointUrl.protocol = endpointUrl.protocol === "https:" ? "wss:" : "ws:";
    if (!RUNNER_MODE) {
      endpointUrl.searchParams.set("projectPath", project.path);
      endpointUrl.searchParams.set("sessionId", activeSessionId);
    }

    const clearResyncTimer = () => {
      if (resyncTimer) window.clearTimeout(resyncTimer);
      resyncTimer = undefined;
    };

    const requestSnapshotResync = (socket: WebSocket, current: RuntimeStore) => {
      if (
        resyncingRef.current ||
        socket.readyState !== WebSocket.OPEN ||
        !current.sessionId
      ) {
        return;
      }
      resyncingRef.current = true;
      clearResyncTimer();
      try {
        socket.send(JSON.stringify({
          version: 1,
          kind: "command",
          id: crypto.randomUUID(),
          type: "runtime.snapshot.get",
          sessionId: current.sessionId,
          runId: current.snapshot?.run.runId ?? undefined,
          timestamp: new Date().toISOString(),
          payload: { afterSequence: current.lastSequence },
        }));
      } catch {
        resyncingRef.current = false;
        socket.close(SNAPSHOT_RESYNC_CLOSE_CODE, "snapshot resync send failed");
        return;
      }
      commit((state) => ({ ...state, connection: "reconnecting", error: null }));
      resyncTimer = window.setTimeout(() => {
        resyncTimer = undefined;
        if (
          disposed ||
          socketRef.current !== socket ||
          !resyncingRef.current
        ) {
          return;
        }
        commit((state) => ({
          ...state,
          connection: "reconnecting",
          error: "Runtime snapshot resync timed out; reconnecting",
        }));
        socket.close(SNAPSHOT_RESYNC_CLOSE_CODE, "snapshot resync timed out");
      }, SNAPSHOT_RESYNC_TIMEOUT_MS);
    };

    const connect = () => {
      if (disposed) return;
      clearResyncTimer();
      commit((state) => ({
        ...state,
        connection: reconnectAttemptRef.current > 0 ? "reconnecting" : "connecting",
        sessionId: null,
        lastSequence: 0,
      }));
      resyncingRef.current = false;
      const socket = new WebSocket(endpointUrl);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        reconnectAttemptRef.current = 0;
      });
      socket.addEventListener("message", (message) => {
        if (socketRef.current !== socket) return;
        try {
          const event = JSON.parse(String(message.data)) as ServerEvent;
          const current = storeRef.current;
          if (
            event.type !== "runtime.snapshot" &&
            current.lastSequence > 0 &&
            event.sequence !== current.lastSequence + 1
          ) {
            requestSnapshotResync(socket, current);
            return;
          }
          if (
            event.type === "variables.updated" &&
            current.snapshot &&
            event.payload.baseRevision !== current.snapshot.variables.revision
          ) {
            requestSnapshotResync(socket, current);
            return;
          }
          if (resyncingRef.current && event.type !== "runtime.snapshot") return;
          if (event.type === "runtime.snapshot") {
            clearResyncTimer();
            resyncingRef.current = false;
          }
          commitServerEvent(event);
        } catch (error) {
          commit((state) => ({
            ...state,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      });
      socket.addEventListener("close", (event) => {
        if (disposed || socketRef.current !== socket) return;
        clearResyncTimer();
        resyncingRef.current = false;
        socketRef.current = null;
        if (event.code === 1000 || event.code === 1008 || event.code === 4001) {
          commit((state) => ({
            ...state,
            connection: "disconnected",
            ...(event.reason ? { error: event.reason } : {}),
          }));
          return;
        }
        reconnectAttemptRef.current += 1;
        commit((state) => ({ ...state, connection: "reconnecting" }));
        const delay = Math.min(250 * 2 ** (reconnectAttemptRef.current - 1), 3_000);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, delay);
      });
      socket.addEventListener("error", () => {
        commit((state) => ({
          ...state,
          error: "Runtime WebSocket connection failed",
        }));
      });
    };

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearResyncTimer();
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [activeSessionId, commit, commitServerEvent, project]);

  useEffect(() => {
    if (!RUNNER_MODE || !project || !activeSessionId) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const [loaded, storage, monitor] = await Promise.all([
          loadSessions(project.path),
          httpRequest<SessionStorageStats>("/v1/storage"),
          httpRequest<RunnerMonitor>(`/v1/sessions/${encodeURIComponent(activeSessionId)}/monitor`),
        ]);
        if (disposed) return;
        setSessions(loaded.items);
        setSessionStorage(storage);
        setRunnerMonitor(monitor);
        setActiveSession((current) => current?.id === monitor.session.id ? monitor.session : current);
      } catch (error) {
        if (!disposed) {
          commit((state) => ({
            ...state,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2_500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [activeSessionId, commit, project]);

  const actions = useMemo(
    () => ({
      attachHarness: (harnessId: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.harnesses.attach", {
          baseRevision: snapshot.harnesses.revision,
          harnessId,
        });
      },
      attachSkill: (skillId: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.skills.attach", {
          baseRevision: snapshot.skills.revision,
          skillId,
        });
      },
      confirmSkillOperation: (confirmationId: string) =>
        sendCommand("runtime.skills.confirm", { confirmationId }),
      cancelSkillOperation: (confirmationId: string) =>
        sendCommand("runtime.skills.cancelConfirmation", { confirmationId }),
      applyContext: (contextRevisionId: string) =>
        sendCommand("runtime.context.apply", { contextRevisionId }),
      applyVariables: (patch: JsonPatchOperation[]) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("variables.apply", {
          baseRevision: snapshot.variables.revision,
          patch,
        });
      },
      attachTool: (toolId: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.tools.attach", {
          toolId,
          baseRevision: snapshot.tools.revision,
        });
      },
      cancelResponse: (assistantMessageId?: string) =>
        sendCommand("chat.response.cancel", { assistantMessageId }),
      cancelRun: () => sendCommand("run.cancel", { reason: "Cancelled from runtime UI" }),
      clearError: () => commit((state) => ({ ...state, error: null })),
      detachTool: (toolId: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.tools.detach", {
          toolId,
          baseRevision: snapshot.tools.revision,
        });
      },
      interruptRun: () =>
        sendCommand("run.interrupt", { reason: "Interrupted from runtime UI" }),
      getArtifact: (artifactId: string) => {
        if (storeRef.current.artifactContents[artifactId] !== undefined) return;
        sendCommand("runtime.artifact.get", { artifactId });
      },
      getArtifactPage: (artifactId: string, page: number, pageSize: number) => {
        if (!storeRef.current.supportsPagination) {
          if (storeRef.current.artifactContents[artifactId] === undefined) {
            sendCommand("runtime.artifact.get", { artifactId });
          }
          return;
        }
        const key = `${artifactId}:${page}:${pageSize}`;
        if (storeRef.current.artifactPages[key] !== undefined) return;
        sendCommand("runtime.artifact.page", { artifactId, page, pageSize });
      },
      getVariablePage: (path: string, page: number, pageSize: number) => {
        if (!storeRef.current.supportsPagination) return;
        const revision = storeRef.current.snapshot?.variables.revision;
        if (revision === undefined) return;
        const key = `${path}:${revision}:${page}:${pageSize}`;
        if (storeRef.current.variablePages[key] !== undefined) return;
        sendCommand("runtime.variable.page", { path, page, pageSize });
      },
      pauseRun: () => sendCommand("run.pause", {}),
      detachHarness: (harnessId: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.harnesses.detach", {
          baseRevision: snapshot.harnesses.revision,
          harnessId,
        });
      },
      detachSkill: (skillId: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.skills.detach", {
          baseRevision: snapshot.skills.revision,
          skillId,
        });
      },
      loadSkillReference: (skillId: string, path: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.skills.reference.load", {
          baseRevision: snapshot.skills.revision,
          skillId,
          path,
        });
      },
      runSkillScript: (skillId: string, path: string, argv: string[]) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.skills.script.run", {
          baseRevision: snapshot.skills.revision,
          skillId,
          path,
          argv,
        });
      },
      renderTemplate: () => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("template.render", { templateId: snapshot.template.id });
      },
      restorePrevious: () => sendCommand("run.restorePrevious", {}),
      restoreCheckpoint: (checkpointId: string) =>
        sendCommand("run.restoreCheckpoint", { checkpointId }),
      restartStep: (stepId?: string, confirmSideEffects = false) =>
        sendCommand("run.restartStep", { stepId, confirmSideEffects }),
      resumeRun: () => sendCommand("run.resume", {}),
      sendChatMessage: (content: string) => {
        const status = storeRef.current.snapshot?.run.status;
        const active = status !== undefined && [
          "running",
          "waiting",
          "pause_requested",
          "paused",
          "interrupting",
        ].includes(status);
        sendCommand("chat.message.send", {
          clientMessageId: crypto.randomUUID(),
          content: [{ type: "text", text: content }],
          autoStart: !active,
        });
      },
      setRunMode: (mode: ExecutionMode) => sendCommand("run.mode.set", { mode }),
      startRun: () => sendCommand("run.start", {}),
      stepRun: () => sendCommand("run.step", {}),
      removeBreakpoint: (breakpointId: string) =>
        sendCommand("runtime.breakpoints.remove", { breakpointId }),
      upsertBreakpoint: (breakpoint: RuntimeBreakpoint) =>
        sendCommand("runtime.breakpoints.upsert", { breakpoint }),
      updateTemplate: (source: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("template.update", {
          templateId: snapshot.template.id,
          baseRevision: snapshot.template.revision,
          source,
        });
      },
    }),
    [commit, sendCommand],
  );

  const value = useMemo<RuntimeContextValue>(
    () => ({
      ...store,
      ...actions,
      project,
      sessions,
      activeSession,
      sessionStorage,
      runnerMode: RUNNER_MODE,
      runnerMonitor,
      closeProject,
      clearSessions,
      createSession,
      renameSession,
      refreshSessionStorage,
      selectProject,
      selectSession,
    }),
    [
      actions,
      activeSession,
      closeProject,
      clearSessions,
      createSession,
      project,
      renameSession,
      refreshSessionStorage,
      selectProject,
      selectSession,
      sessionStorage,
      runnerMonitor,
      sessions,
      store,
    ],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntime() {
  const context = useContext(RuntimeContext);
  if (!context) throw new Error("useRuntime must be used within RuntimeProvider");
  return context;
}
