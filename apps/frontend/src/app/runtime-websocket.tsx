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
  RuntimeSnapshot,
  ServerEvent,
} from "./runtime-protocol";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export type ProjectInfo = { path: string; name: string };
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

type RuntimeStore = {
  connection: ConnectionState;
  error: string | null;
  lastSequence: number;
  sessionId: string | null;
  snapshot: RuntimeSnapshot | null;
  artifactContents: Record<string, JsonValue>;
};

type RuntimeContextValue = RuntimeStore & {
  project: ProjectInfo | null;
  sessions: SessionSummary[];
  activeSession: SessionSummary | null;
  sessionStorage: SessionStorageStats | null;
  clearSessions: () => Promise<void>;
  createSession: () => Promise<void>;
  refreshSessionStorage: () => Promise<void>;
  selectProject: (path: string) => Promise<void>;
  selectSession: (sessionId: string) => void;
  attachHarness: (harnessId: string) => void;
  attachSkill: (skillId: string) => void;
  applyVariables: (patch: JsonPatchOperation[]) => void;
  applyContext: (contextRevisionId: string) => void;
  applyCompression: (candidateId: string) => void;
  runCompression: () => void;
  attachTool: (toolId: string) => void;
  cancelResponse: (assistantMessageId?: string) => void;
  cancelRun: () => void;
  clearError: () => void;
  detachTool: (toolId: string) => void;
  interruptRun: () => void;
  getArtifact: (artifactId: string) => void;
  pauseRun: () => void;
  rejectCompression: (candidateId: string) => void;
  undoCompression: (recordId: string) => void;
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
  lastSequence: 0,
  sessionId: null,
  snapshot: null,
  artifactContents: {},
};

const RuntimeContext = createContext<RuntimeContextValue | null>(null);

function httpBase() {
  const configured = process.env.NEXT_PUBLIC_RUNTIME_HTTP_URL?.replace(/\/$/, "");
  return configured ?? `${window.location.protocol}//${window.location.hostname}:3005`;
}

async function httpRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${httpBase()}${path}`, {
    ...init,
    headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

async function loadSessions(projectPath: string) {
  return httpRequest<{ project: ProjectInfo; items: SessionSummary[] }>(
    `/api/sessions?projectPath=${encodeURIComponent(projectPath)}`,
  );
}

async function createProjectSession(projectPath: string) {
  return httpRequest<SessionSummary>("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ projectPath }),
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
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
      error: null,
      lastSequence: event.sequence,
      sessionId: event.sessionId,
      snapshot: clone(event.payload),
      artifactContents: {},
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
      break;
    case "run.trace.started":
      return {
        ...store,
        error: null,
        lastSequence: event.sequence,
        artifactContents: {},
        snapshot: {
          ...snapshot,
          run: clone(event.payload.run),
          timeline: clone(event.payload.timeline),
          checkpoints: clone(event.payload.checkpoints),
          effectiveContexts: snapshot.effectiveContexts,
          observations: snapshot.observations,
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
    case "runtime.compression.updated":
      next = { ...snapshot, compression: clone(event.payload) };
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
              ? { ...message, status: "failed" as const }
              : message,
          ),
        },
      };
      break;
    case "variables.updated":
      next = {
        ...snapshot,
        variables: {
          revision: event.payload.revision,
          value: applyJsonPatch(snapshot.variables.value, event.payload.patch),
        },
      };
      break;
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
    case "runtime.skills.updated":
      next = { ...snapshot, skills: clone(event.payload) };
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
  const storeRef = useRef(store);
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const resyncingRef = useRef(false);

  const commit = useCallback((update: (current: RuntimeStore) => RuntimeStore) => {
    const next = update(storeRef.current);
    storeRef.current = next;
    setStore(next);
  }, []);

  const sendCommand = useCallback(
    <TType extends CommandType>(
      type: TType,
      payload: CommandPayloadMap[TType],
    ) => {
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
      `/api/sessions/storage?projectPath=${encodeURIComponent(project.path)}`,
    );
    setSessionStorage(stats);
  }, [project]);

  const selectProject = useCallback(async (input: string) => {
    const status = storeRef.current.snapshot?.run.status;
    if (status && ["running", "waiting", "pause_requested", "paused", "interrupting"].includes(status)) {
      throw new Error("Interrupt or finish the current run before switching projects");
    }
    const selectedProject = await httpRequest<ProjectInfo>("/api/projects/inspect", {
      method: "POST",
      body: JSON.stringify({ path: input }),
    });
    const loaded = await loadSessions(selectedProject.path);
    const session = loaded.items.find((item) => item.restorable)
      ?? await createProjectSession(selectedProject.path);
    setProject(selectedProject);
    setSessions(loaded.items.length > 0 ? loaded.items : [session]);
    setSessionStorage(null);
    localStorage.setItem("capybara-project-path", selectedProject.path);
    activateSession(session);
  }, [activateSession]);

  const createSession = useCallback(async () => {
    if (!project) return;
    const status = storeRef.current.snapshot?.run.status;
    if (status && ["running", "waiting", "pause_requested", "paused", "interrupting"].includes(status)) {
      throw new Error("Interrupt or finish the current run before creating a session");
    }
    const session = await createProjectSession(project.path);
    setSessions((current) => [session, ...current]);
    activateSession(session);
  }, [activateSession, project]);

  const selectSession = useCallback((sessionId: string) => {
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
        const savedPath = localStorage.getItem("capybara-project-path");
        const selectedProject = savedPath
          ? await httpRequest<ProjectInfo>("/api/projects/inspect", {
              method: "POST",
              body: JSON.stringify({ path: savedPath }),
            }).catch(() => httpRequest<ProjectInfo>("/api/projects/default"))
          : await httpRequest<ProjectInfo>("/api/projects/default");
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
    if (!project || !activeSession) return;
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const endpoint =
      process.env.NEXT_PUBLIC_RUNTIME_WS_URL ??
      `${socketProtocol}//${window.location.hostname}:3005/ws/runtime`;
    const endpointUrl = new URL(endpoint);
    endpointUrl.searchParams.set("projectPath", project.path);
    endpointUrl.searchParams.set("sessionId", activeSession.id);

    const connect = () => {
      if (disposed) return;
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
        try {
          const event = JSON.parse(String(message.data)) as ServerEvent;
          const current = storeRef.current;
          if (
            event.type !== "runtime.snapshot" &&
            current.lastSequence > 0 &&
            event.sequence !== current.lastSequence + 1
          ) {
            if (!resyncingRef.current) {
              resyncingRef.current = true;
              sendCommand("runtime.snapshot.get", {
                afterSequence: current.lastSequence,
              });
            }
            return;
          }
          if (
            event.type === "variables.updated" &&
            current.snapshot &&
            event.payload.baseRevision !== current.snapshot.variables.revision
          ) {
            if (!resyncingRef.current) {
              resyncingRef.current = true;
              sendCommand("runtime.snapshot.get", {
                afterSequence: current.lastSequence,
              });
            }
            return;
          }
          if (resyncingRef.current && event.type !== "runtime.snapshot") return;
          if (event.type === "runtime.snapshot") resyncingRef.current = false;
          commit((state) => applyEvent(state, event));
        } catch (error) {
          commit((state) => ({
            ...state,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      });
      socket.addEventListener("close", (event) => {
        if (disposed) return;
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
        reconnectTimer = setTimeout(connect, delay);
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
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [activeSession, commit, project, sendCommand]);

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
      applyContext: (contextRevisionId: string) =>
        sendCommand("runtime.context.apply", { contextRevisionId }),
      applyCompression: (candidateId: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.compression.apply", {
          candidateId,
          baseRevision: snapshot.compression.revision,
        });
      },
      runCompression: () => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.compression.run", {
          baseRevision: snapshot.compression.revision,
        });
      },
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
      pauseRun: () => sendCommand("run.pause", {}),
      rejectCompression: (candidateId: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.compression.reject", {
          candidateId,
          baseRevision: snapshot.compression.revision,
        });
      },
      undoCompression: (recordId: string) => {
        const snapshot = storeRef.current.snapshot;
        if (!snapshot) return;
        sendCommand("runtime.compression.undo", {
          recordId,
          baseRevision: snapshot.compression.revision,
        });
      },
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
      clearSessions,
      createSession,
      refreshSessionStorage,
      selectProject,
      selectSession,
    }),
    [
      actions,
      activeSession,
      clearSessions,
      createSession,
      project,
      refreshSessionStorage,
      selectProject,
      selectSession,
      sessionStorage,
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
