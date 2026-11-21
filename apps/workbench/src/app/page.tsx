"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { workbenchMenus, type WorkbenchApplication, type WorkbenchApplicationBlock, type WorkbenchProject, type WorkbenchThreadEntry } from "@/app/workbench-data";
import type { ApplicationInstanceView, ApplicationReceiptView, ApplicationRuntimeStatus, BrowserSessionEvent, BrowserSessionState, MarketResearchHostResult, ProductCapabilityStatus, RegisteredProject, SessionDirectorySnapshot } from "@/app/workbench-bridge";
import { chatTextFromEvent, createChatFrame, createRuntimeCommandFrame, parseRuntimeEvent, pendingBranchQuestions, shouldHandleRuntimeClosed, transcriptFromSnapshot, transcriptMessageFromEvent, type WorkbenchTranscriptMessage } from "@/app/workbench-runtime";

import { activityRows, activityStatus, activityTime, type ActivityRow } from "./runtime-activity";
import { RuntimeActivityRows } from "./runtime-activity-view";
import { ContextDocumentCard } from "./context-document-view";
import { MessageBody } from "./message-body";
import { McpInputForm } from "./mcp-input-form";
import { chooseRestoredSessionId, knownSessionId } from "./session-selection";
import type { CommandPayloadMap, EventPayloadMap, RuntimeContextDocumentView, RuntimeContextOrganizationView, RuntimeMcpState } from "@capybara-agent/protocol";

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    menu: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    down: <path d="m6 9 6 6 6-6" />,
    send: <><path d="M12 19V5" /><path d="m7 10 5-5 5 5" /></>,
    file: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Z" /><path d="M14 3v5h5M8 12h8m-8 4h6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l1.3-1.3a5 5 0 0 0-7.1-7.1L10 5.9" /><path d="M14 11a5 5 0 0 0-7.1-.1L5.6 12.2a5 5 0 0 0 7.1 7.1l1.3-1.3" /></>,
    back: <path d="m15 18-6-6 6-6" />,
    forward: <path d="m9 18 6-6-6-6" />,
    minimize: <path d="M5 12h14" />,
    maximize: <><rect x="5" y="5" width="14" height="14" rx="1" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  };
  return <svg className="wb-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.file}</svg>;
}

function statusLabel(status: string) { return ({ working: "工作中", waiting: "等待指示", paused: "已暂停", complete: "已完成" } as Record<string, string>)[status] ?? status; }

function resourceOriginLabel(source?: string): string {
  if (!source) return "来源未知";
  return source.startsWith("@system/") ? "系统回退" : "项目资源";
}

function resourceOperationError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
  return normalized ? `${fallback}：${normalized}` : fallback;
}

function contextValue(value: unknown, maxLength = 280): string {
  if (typeof value === "string") return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized) return String(value ?? "—");
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…` : serialized;
  } catch {
    return String(value ?? "—");
  }
}

function applicationOperationError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/has no start command/i.test(raw)) {
    return `${fallback}：当前项目还没有配置应用启动命令，请先生成或配置可运行应用。`;
  }
  if (/application definition|manifest/i.test(raw) && /not found|missing|未找到/i.test(raw)) {
    return `${fallback}：当前项目还没有应用定义，请先生成或配置项目应用。`;
  }
  return resourceOperationError(error, fallback);
}

type ProjectSettingsView = {
  llm: { provider: string; model: string; base_url: string; protocol: string; max_retries?: number; api_key_configured?: boolean };
  context?: { context_window_tokens?: number; max_input_tokens?: number; reserved_output_tokens?: number };
  max_messages?: number;
  max_tool_rounds?: number;
};
type SystemVariableView = { key: string; type: string; label: string; description?: string; value: unknown; readonly?: boolean; source?: string };
type ResourceCatalogView = { revision?: string; items?: Array<{ id: string; kind: string; name?: string; package?: string; source?: string; version?: string; enabled?: boolean; diagnostics?: Array<{ severity?: string; message?: string }> }>; plugins?: Array<{ id: string; name: string; version?: string; enabled?: boolean }> };
type ProjectArtifactView = { artifactId: string; kind: string; contentRef: string; contentHash?: string; status: string; summary: string; relativePath?: string; runId?: string; updatedAt?: string };
type RuntimeTraceEvent = { id: string; sequence?: number; timestamp?: string; type: string; turnId?: string; stepId?: string; parentTurnId?: string; payload: Record<string, unknown> };
type RuntimeContextCandidateView = { id: string; actor?: string; status?: string; evidenceRefs?: string[]; proposedDiffIds?: string[]; capturedAt?: string; [key: string]: unknown };
type RuntimeContextEvidenceView = { id: string; kind?: string; referenceId?: string; confidence?: string; observedAt?: string; [key: string]: unknown };
type RuntimeContextReceiptView = { id: string; result?: string; subjectId?: string; errorCode?: string; createdAt?: string; [key: string]: unknown };
type RuntimeContextProjectionView = { scope?: string; id: string; documentRevision?: number; profileId?: string; sourceEntryIds?: string[]; sourceCandidateIds?: string[]; sourceMessageCursor?: number; truncatedSections?: string[]; contentArtifactId?: string; contentHash?: string; createdAt?: string };
type RuntimeRenderedMessageView = { role: string; content: string; name?: string; toolCallId?: string };
type RuntimeRenderResultView = { messages?: RuntimeRenderedMessageView[]; templateRevision?: number; variablesRevision?: number; renderedAt?: string; diagnostics?: Array<{ severity?: string; code?: string; message?: string; line?: number; column?: number }> };
type RuntimeVariablesView = { revision?: number; value?: Record<string, unknown> };
type RuntimeEffectiveContextView = { revision?: number; activeId?: string; items?: Array<{ id?: string; runId?: string; stepId?: string; requestArtifactId?: string; messagesArtifactId?: string; toolsArtifactId?: string; createdAt?: string }> };
type RuntimeActivityView = {
  branchQuestions?: ReturnType<typeof pendingBranchQuestions>;
  mcpInputs?: RuntimeMcpState["inputRequests"];
  children: Array<{ id: string; goal: string; status: string; startedAt?: string }>;
  processes: Array<{ id: string; kind: string; name: string; status: string; pid?: string; startedAt?: string; stoppedAt?: string; callId?: string; detail?: unknown; error?: unknown }>;
  trace: RuntimeTraceEvent[];
  steps?: import("@capybara-agent/protocol").TimelineStep[];
  contextScopes?: { activeScope?: string; project?: { revision?: number }; session?: { revision?: number } };
  contextCandidates?: RuntimeContextCandidateView[];
  contextEvidence?: RuntimeContextEvidenceView[];
  contextReceipts?: RuntimeContextReceiptView[];
  applicationReceipts?: ApplicationReceiptView[];
  contextReviewReceipts?: RuntimeContextReceiptView[];
  contextEvidenceReviews?: RuntimeContextReceiptView[];
  contextDocumentView?: RuntimeContextDocumentView;
  projectContextDocumentView?: RuntimeContextDocumentView;
  contextOrganization?: RuntimeContextOrganizationView;
  contextDocumentMarkdown?: string;
  projectContextDocumentMarkdown?: string;
  renderResult?: RuntimeRenderResultView;
  variables?: RuntimeVariablesView;
  effectiveContexts?: RuntimeEffectiveContextView;
  status?: { runtime?: string; model?: string; modelName?: string; loopStatus?: string; activity?: { phase?: string; label?: string; startedAt?: string } };
};

function traceLabel(event: RuntimeTraceEvent): string {
  const payload = event.payload ?? {};
  if (event.type === "chat.user.created") return "收到用户指令";
  if (event.type === "chat.assistant.started") return "开始生成回复";
  if (event.type === "chat.assistant.completed") return "回复已完成";
  if (event.type === "chat.assistant.failed") return `回复失败：${String(payload.message ?? "未知错误")}`;
  if (event.type === "chat.assistant.delta" && payload.channel === "thinkingSummary") return String(payload.delta ?? "正在处理");
  if (event.type === "tool.call.started") return `调用工具：${String(payload.toolName ?? "未知工具")}`;
  if (event.type === "tool.call.completed") return `工具完成：${String(payload.toolName ?? "未知工具")}（${String(payload.durationMs ?? "—")} ms）`;
  if (event.type === "tool.call.failed") return `工具失败：${String(payload.toolName ?? "未知工具")} · ${String(payload.message ?? "未知错误")}`;
  if (event.type === "runtime.processes.updated") return "运行进程状态已更新";
  if (event.type === "runtime.children.updated") return "子智能体状态已更新";
  if (event.type === "runtime.observation.upserted") return "工具观察已更新";
  if (event.type === "runtime.artifact.created") return "结果证据已归档";
  if (event.type === "runtime.status.updated") return String((payload.activity as { label?: string } | undefined)?.label ?? "运行状态更新");
  return event.type;
}

function marketResearchFromTraceEvent(event: RuntimeTraceEvent): MarketResearchHostResult | undefined {
  if (event.type !== "tool.call.completed" || event.payload?.toolName !== "market_research") return undefined;
  const result = event.payload?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const candidate = result as Partial<MarketResearchHostResult>;
  if (typeof candidate.status !== "string" || typeof candidate.ticker !== "string" || !candidate.period || !Array.isArray(candidate.steps)) return undefined;
  return candidate as MarketResearchHostResult;
}

const INTERACTIVE_BROWSER_ORIGINS = [
  "https://www.investor.gov",
  "https://www.cninfo.com.cn",
  "https://example.com",
];


function renderApplicationBlock(block: WorkbenchApplicationBlock, onArtifactReview?: (artifactId: string, decision: 'accept' | 'reject') => void, onArtifactVerify?: (artifactId: string) => void, artifactReviewBusyId?: string | null) {
  if (block.kind === "summary") return <section className="wb-app-section" key={block.id}><div className="wb-app-section-title"><span>{block.label}</span><strong>{block.value}</strong></div></section>;
  if (block.kind === "list") return <section className="wb-app-section" key={block.id}><div className="wb-app-section-title"><span>{block.title}</span></div><ul className="wb-app-list">{block.items.map((item) => <li key={item}><span>{item}</span><span>待核对</span></li>)}</ul></section>;
  if (block.kind === "references") return <section className="wb-app-section" key={block.id}><div className="wb-app-section-title"><span>{block.title}</span></div><ul className="wb-app-list">{block.items.map((item) => <li key={item.artifactId ?? item.label}><span>{item.label}</span><span>{item.meta}{item.artifactId && onArtifactVerify && ["quarantined", "available"].includes(item.status ?? "") && <button className="wb-object-link" type="button" data-artifact-action="verify" data-artifact-id={item.artifactId} aria-label={`复核产物 ${item.artifactId}`} disabled={artifactReviewBusyId === item.artifactId} onClick={() => onArtifactVerify(item.artifactId!)}>复核</button>}{item.artifactId && onArtifactReview && ["quarantined", "available"].includes(item.status ?? "") && <><button className="wb-object-link" type="button" data-artifact-action="accept" data-artifact-id={item.artifactId} aria-label={`接受产物 ${item.artifactId}`} disabled={artifactReviewBusyId === item.artifactId} onClick={() => onArtifactReview(item.artifactId!, "accept")}>接受</button><button className="wb-object-link" type="button" data-artifact-action="reject" data-artifact-id={item.artifactId} aria-label={`拒绝产物 ${item.artifactId}`} disabled={artifactReviewBusyId === item.artifactId} onClick={() => onArtifactReview(item.artifactId!, "reject")}>拒绝</button></>}</span></li>)}</ul></section>;
  return <section className="wb-app-section" key={block.id}><div className="wb-app-section-title"><span>{block.title}</span><span className="wb-app-state">{block.status === "running" ? "运行中" : block.status === "stopped" ? "已停止" : "等待启动"}</span></div><p className="wb-app-note">{block.detail}</p></section>;
}

function localProjectFromRegistration(input: { projectId: string; displayName: string; isEmpty: boolean }): WorkbenchProject {
  return {
    id: `local:${input.projectId}`,
    name: input.displayName,
    description: input.isEmpty ? "空目录已登记，可以从第一条指示开始工作。" : "本地项目已登记，Agent 会围绕该目录持续工作。",
    agent: "本地项目协作",
    responsibility: "在本地项目中持续整理资料、指示和工作成果",
    selectedSessionId: `local-session:${input.projectId}`,
    tokenSummary: "用量尚未统计",
    sessions: [{ id: `local-session:${input.projectId}`, title: "新会话", subtitle: "手动会话 · 等待第一条指示", status: "waiting", lastRun: "尚未运行", next: "等待你的指示" }],
  };
}

const unopenedProject: WorkbenchProject = {
  id: "unopened-project",
  name: "未打开项目",
  description: "请先打开一个本地项目。",
  agent: "本地项目协作",
  responsibility: "等待本地项目目录",
  selectedSessionId: "unopened-session",
  tokenSummary: "用量尚未统计",
  sessions: [{ id: "unopened-session", title: "等待打开项目", subtitle: "尚未选择本地项目", status: "waiting", lastRun: "尚未运行", next: "打开本地项目后开始工作" }],
};

type PersistedSessionView = {
  id: string
  name: string
  createdAt?: string
  updatedAt?: string
  requestCount?: number
}

function sessionLastRun(value?: string): string {
  if (!value) return "尚未运行"
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "已记录"
  return parsed.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
}

function persistedSessions(items: PersistedSessionView[]): WorkbenchProject["sessions"] {
  return items.filter((item) => typeof item.id === "string" && item.id.trim()).map((item) => ({
    id: item.id,
    title: item.name?.trim() || "新会话",
    subtitle: `手动会话 · ${item.requestCount ?? 0} 次请求`,
    status: "waiting" as const,
    lastRun: sessionLastRun(item.updatedAt ?? item.createdAt),
    next: "等待你的指示",
  }))
}


function localApplicationFor(project: WorkbenchProject, isEmpty: boolean, research?: MarketResearchHostResult | null, runtime?: ApplicationRuntimeStatus | null, projectArtifacts: ProjectArtifactView[] = []): WorkbenchApplication {
  const runtimeInstance = runtime?.instances.find((item) => ["running", "health_checking", "starting", "degraded"].includes(item.status)) ?? runtime?.instances.at(-1);
  const runtimeRunning = runtimeInstance?.status === "running";
  // A published artifact can remain readable after its hosted instance stops.
  // The project application runtime card must therefore describe the live
  // instance only; publication is rendered separately in the application
  // panel and must not make a stopped instance look active.
  const appStatus = runtimeRunning ? "running" : "stopped";
  const hasResearch = Boolean(research);
  const hasRuntimeApplication = Boolean(runtime?.manifest);
  const runtimeApplicationName = runtime?.manifest.appId === "market-dashboard" ? "行情看板" : runtime?.manifest.appId || project.name;
  const runtimeVersion = runtime?.manifest.versionId ? `${runtime.manifest.versionId} · 已登记` : "v1 · 空白应用";
  const runtimeAddress = runtimeInstance?.browserUrl || "本地地址待分配";
  const stepLabels: Record<string, string> = {
    market_data: "最近一个月交易数据",
    report_download: "最近三年研报",
    python_analysis: "Python 特征分析",
    dashboard_publish: "行情看板发布",
    dashboard_open: "行情看板打开",
  };
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const evidenceItems = (research?.evidence ?? []).map((value, index) => {
    const item = record(value);
    const source = String(item.source ?? item.kind ?? `证据 ${index + 1}`);
    const summary = String(item.summary ?? item.locator ?? item.status ?? "已记录");
    return { label: source, meta: summary };
  });
  type ApplicationArtifactItem = { label: string; meta: string; artifactId?: string; status?: string };
  const artifactItemsById = new Map<string, ApplicationArtifactItem>();
  const anonymousArtifactItems: ApplicationArtifactItem[] = [];
  for (const [index, value] of (research?.artifacts ?? []).entries()) {
    const item = record(value);
    const artifactId = typeof item.artifactId === "string" ? item.artifactId : undefined;
    const applicationItem: ApplicationArtifactItem = {
      label: String(item.kind ?? artifactId ?? `产物 ${index + 1}`),
      meta: String(item.summary ?? item.contentRef ?? item.status ?? "已记录"),
      ...(artifactId ? { artifactId } : {}),
      ...(typeof item.status === "string" ? { status: item.status } : {}),
    };
    if (artifactId) artifactItemsById.set(artifactId, applicationItem);
    else anonymousArtifactItems.push(applicationItem);
  }
  // The project artifact index is authoritative for review state and may
  // reconcile artifacts from older persisted research results. Replacing the
  // same ID here removes duplicate cards while keeping the latest status.
  for (const item of projectArtifacts) {
    artifactItemsById.set(item.artifactId, {
      label: item.kind || item.artifactId,
      meta: `${item.status} · ${item.summary}${item.relativePath ? ` · ${item.relativePath}` : ""}`,
      artifactId: item.artifactId,
      status: item.status,
    });
  }
  const artifactItems = [...artifactItemsById.values(), ...anonymousArtifactItems];
  const researchSteps = (research?.steps ?? []).map((step) => `${stepLabels[step.step] ?? step.step}：${step.status}`);
  const recommendationItems = research?.recommendation
    ? [`建议立场：${research.recommendation.stance}`, ...research.recommendation.rationale.map((item) => `依据：${item}`), ...research.recommendation.uncertainties.map((item) => `不确定性：${item}`)]
    : [];
  return {
    id: `${project.id}:application`,
    projectId: project.id,
    name: hasResearch ? `${research?.ticker ?? "个股"} 行情看板` : hasRuntimeApplication ? runtimeApplicationName : "项目应用",
    version: research?.application?.versionId ? `${research.application.versionId} · ${research.status === "succeeded" ? "已发布" : research.status}` : runtimeVersion,
    status: appStatus,
    address: research?.application?.address ?? runtimeAddress,
    blocks: [
      { id: `${project.id}:summary`, kind: "summary", label: "项目状态", value: research ? `000682 · ${research.status === "succeeded" ? "研究已完成" : "研究未完成"}` : isEmpty ? "空目录 · 等待第一条指示" : "项目已登记 · 等待第一轮工作", tone: "accent" },
      ...(hasResearch ? [
        { id: `${project.id}:steps`, kind: "list" as const, title: "研究步骤", items: researchSteps.length ? researchSteps : ["暂无步骤记录"] },
        ...(recommendationItems.length ? [{ id: `${project.id}:recommendation`, kind: "list" as const, title: "分析结论（待人工审查）", items: recommendationItems }] : []),
        ...(evidenceItems.length ? [{ id: `${project.id}:evidence`, kind: "references" as const, title: "来源与证据", items: evidenceItems }] : []),
        ...(artifactItems.length ? [{ id: `${project.id}:artifacts`, kind: "references" as const, title: "产物与版本", items: artifactItems }] : []),
      ] : [{ id: `${project.id}:next`, kind: "list" as const, title: "可以开始", items: ["说明要完成的工作", "提供需要使用的资料", "让 Agent 保留可追溯结果"] }]),
      { id: `${project.id}:runtime`, kind: "runtime", title: "本地应用运行", status: appStatus, detail: research?.application?.address
        ? `${research.application.versionId} · ${runtimeRunning ? "托管实例运行中" : "托管实例已停止；已发布内容仍可打开"}`
        : hasRuntimeApplication
          ? `${runtime?.manifest.versionId ?? "当前版本"} · ${runtimeRunning ? "托管实例运行中" : "已登记，尚未启动"}`
          : "空白应用已准备 · 尚未启动" },
    ],
  };
}

function runtimeSessionStorageKey(projectId: string) { return `capybara:runtime-session:${projectId.replace(/^local:/, "")}`; }

function storedRuntimeSessionId(projectId: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  const base = projectId.replace(/^local:/, "");
  const value = window.localStorage.getItem(`capybara:runtime-session:local:${base}`) ?? window.localStorage.getItem(runtimeSessionStorageKey(base));
  return value?.trim() || undefined;
}

function rememberRuntimeSessionId(projectId: string, sessionId: string) {
  if (typeof window !== "undefined" && sessionId.trim()) {
    window.localStorage.setItem(runtimeSessionStorageKey(projectId), sessionId);
    window.localStorage.removeItem(`capybara:runtime-session:local:${projectId.replace(/^local:/, "")}`);
  }
}

function activeSessionIdStateForProject(projectId: string, sessionId: string | undefined): string | undefined {
  if (sessionId && !sessionId.startsWith(`local-session:${projectId}`)) return sessionId;
  return storedRuntimeSessionId(projectId);
}

function mergeTranscriptMessage(current: WorkbenchTranscriptMessage[], next: WorkbenchTranscriptMessage): WorkbenchTranscriptMessage[] {
  const byId = current.findIndex((item) => item.id === next.id);
  if (byId >= 0) {
    const updated = [...current];
    updated[byId] = { ...updated[byId], ...next, body: next.body || updated[byId].body };
    return updated;
  }
  // The renderer adds a user message optimistically while the runtime emits
  // the canonical message a moment later. Collapse only that adjacent copy;
  // a retry after an assistant result remains a separate recorded attempt.
  const last = current.at(-1);
  if (next.role === "user" && last?.role === "user" && last.body === next.body) {
    const updated = [...current];
    updated[updated.length - 1] = { ...last, ...next };
    return updated;
  }
  return [...current, next];
}

function TurnProgress({ rows, running }: { rows: ActivityRow[]; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return null;
  const toolCount = rows.filter((row) => row.kind === "tool").length;
  const visibleRows = expanded ? rows : rows.slice(-4);
  const hiddenCount = rows.length - visibleRows.length;
  return <details className={`wb-turn-progress${running ? " wb-turn-progress-running" : ""}`} open={running || undefined}>
    <summary><span>{running ? "正在处理" : "查看执行过程"}</span><small>{toolCount} 次工具调用 · {rows.length} 步</small></summary>
    <RuntimeActivityRows rows={visibleRows} compact />
    {hiddenCount > 0 && <button type="button" className="wb-turn-progress-more" onClick={() => setExpanded(true)}>还有 {hiddenCount} 步，展开完整步骤</button>}
  </details>;
}

export default function WorkbenchPage() {
  const observedSession = useRef<string | null>(null);
  const observedRuntime = useRef<string | null>(null);
  const threadElement = useRef<HTMLDivElement>(null);
  const settingsDialog = useRef<HTMLElement>(null);
  const followOutput = useRef(true);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [activeSessionId, setActiveSessionId] = useState("");
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [draft, setDraft] = useState("");
  const [extraMessages, setExtraMessages] = useState<WorkbenchTranscriptMessage[]>([]);
  const [runtimeHydrated, setRuntimeHydrated] = useState(false);
  const [appOpen, setAppOpen] = useState(true);
  const [appTab, setAppTab] = useState("overview");
  const [localProject, setLocalProject] = useState<WorkbenchProject | null>(null);
  const [registeredProjects, setRegisteredProjects] = useState<RegisteredProject[]>([]);
  const [openProjectMenuId, setOpenProjectMenuId] = useState<string | null>(null);
  const [localProjectIsEmpty, setLocalProjectIsEmpty] = useState(false);
  const [opaqueDirectoryRef, setOpaqueDirectoryRef] = useState<string | null>(null);
  const currentOpaqueDirectoryRef = useRef<string | null>(null);
  const currentRuntime = useRef<string | null>(null);
  const [runtimeId, setRuntimeIdState] = useState<string | null>(null);
  const setRuntimeId = (value: string | null) => { currentRuntime.current = value; if (value === null) observedRuntime.current = null; setRuntimeIdState(value); };
  const [runtimeSessionId, setRuntimeSessionId] = useState<string | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [capabilityStatus, setCapabilityStatus] = useState<ProductCapabilityStatus | null>(null);
  const [marketResearch, setMarketResearch] = useState<MarketResearchHostResult | null>(null);
  const [projectArtifacts, setProjectArtifacts] = useState<ProjectArtifactView[]>([]);
  const [artifactReviewBusyId, setArtifactReviewBusyId] = useState<string | null>(null);
  const [applicationRuntime, setApplicationRuntime] = useState<ApplicationRuntimeStatus | null>(null);
  const [applicationRestoring, setApplicationRestoring] = useState(false);
  const [browserViewInstanceId, setBrowserViewInstanceId] = useState<string | null>(null);
  const [browserSessionId, setBrowserSessionId] = useState<string | null>(null);
  const browserSessionIdCurrent = useRef<string | null>(null);
  const [browserSessionState, setBrowserSessionState] = useState<BrowserSessionState | null>(null);
  const [browserSessionUrl, setBrowserSessionUrl] = useState("https://example.com/");
  const [browserSessionError, setBrowserSessionError] = useState<string | null>(null);
  const [applicationLayout, setApplicationLayoutState] = useState<'side' | 'full'>('side');
  const [marketResearchBusy, setMarketResearchBusy] = useState(false);
  const applicationRestoreGeneration = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [darkTheme, setDarkTheme] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const creatingSession = useRef(false);
  const lastNewSessionAt = useRef(0);
  const [newSessionBusy, setNewSessionBusy] = useState(false);
  const [navigationHistory, setNavigationHistory] = useState<Array<{ projectId: string; sessionId: string }>>([]);
  const [navigationIndex, setNavigationIndex] = useState(0);
  const [settings, setSettings] = useState<ProjectSettingsView | null>(null);
  const [settingsDraft, setSettingsDraft] = useState({ provider: "", model: "", base_url: "", protocol: "chat-completions", apiKey: "" });
  const [systemVariables, setSystemVariables] = useState<SystemVariableView[]>([]);
  const [catalog, setCatalog] = useState<ResourceCatalogView | null>(null);
  const [activity, setActivity] = useState<RuntimeActivityView>({ children: [], processes: [], trace: [] });
  const [replyTargetId, setReplyTargetId] = useState("");
  const replyTarget = activity.branchQuestions?.find(question => question.id === replyTargetId);
  const [resourceBusy, setResourceBusy] = useState(false);
  const [resourceStatus, setResourceStatus] = useState<string | null>(null);
  const resourceLoadGeneration = useRef(0);
  const [skillRepo, setSkillRepo] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [skillCommit, setSkillCommit] = useState("");
  const [pluginSource, setPluginSource] = useState("");
  const [sessionDirectory, setSessionDirectory] = useState<SessionDirectorySnapshot | null>(null);
  const [sessionMessageTarget, setSessionMessageTarget] = useState("");
  const [sessionMessageText, setSessionMessageText] = useState("请介绍自己");
  const [sessionMessageBusy, setSessionMessageBusy] = useState(false);
  const [sessionMessageResult, setSessionMessageResult] = useState<string | null>(null);
  useEffect(() => { currentOpaqueDirectoryRef.current = opaqueDirectoryRef; }, [opaqueDirectoryRef]);
  useEffect(() => { browserSessionIdCurrent.current = browserSessionId; }, [browserSessionId]);
  useEffect(() => {
    let cancelled = false;
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) { setSessionDirectory(null); return () => { cancelled = true; }; }
    void bridge.listSessionDirectory({ opaqueDirectoryRef }).then((value) => {
      if (cancelled) return;
      setSessionDirectory(value);
      const fallback = value.items.find((item) => item.id !== (runtimeSessionId ?? activeSessionId));
      setSessionMessageTarget((current) => current || fallback?.id || "");
    }).catch(() => { if (!cancelled) setSessionDirectory(null); });
    return () => { cancelled = true; };
  }, [opaqueDirectoryRef, runtimeSessionId, activeSessionId]);
  const visibleCatalogItems = useMemo(() => {
    const seen = new Set<string>();
    return (catalog?.items ?? []).filter((item) => {
      const key = `${item.kind}:${item.source ?? item.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [catalog]);

  async function restoreProjectApplication(ref: string | null) {
    const bridge = window.capybaraDesktop;
    if (!bridge || !ref) {
      applicationRestoreGeneration.current += 1;
      setApplicationRuntime(null);
      setMarketResearch(null);
      setProjectArtifacts([]);
      setApplicationRestoring(false);
      setBrowserSessionId(null);
      setBrowserSessionState(null);
      setBrowserSessionError(null);
      return;
    }
    const generation = ++applicationRestoreGeneration.current;
    setApplicationRestoring(true);
    const [statusResult, researchResult, artifactResult] = await Promise.allSettled([
      bridge.getApplicationStatus({ opaqueDirectoryRef: ref }),
      bridge.loadMarketResearch({ opaqueDirectoryRef: ref }),
      bridge.projectApi<{ revision?: number; items?: ProjectArtifactView[] }>({ opaqueDirectoryRef: ref, path: "/api/resources/artifacts" }),
    ]);
    if (generation !== applicationRestoreGeneration.current) return;
    if (statusResult.status === "fulfilled") {
      setApplicationRuntime(statusResult.value);
      setActivity((current) => ({ ...current, applicationReceipts: statusResult.value?.receipts ?? [] }));
    } else {
      setApplicationRuntime(null);
    }
    setMarketResearch(researchResult.status === "fulfilled" ? researchResult.value ?? null : null);
    setProjectArtifacts(artifactResult.status === "fulfilled" && Array.isArray(artifactResult.value.items) ? artifactResult.value.items : []);
    setApplicationRestoring(false);
  }
  const [projectOpenStatus, setProjectOpenStatus] = useState<
    | { kind: "idle" }
    | { kind: "opening" }
    | { kind: "unavailable"; message: string }
    | { kind: "cancelled"; message: string }
    | { kind: "selected"; projectId: string; name: string; empty: boolean }
  >({ kind: "idle" });
  const project = useMemo(() => localProject?.id === activeProjectId ? localProject : unopenedProject, [activeProjectId, localProject]);
  const session = project.sessions.find((item) => item.id === activeSessionId) ?? project.sessions[0];
  const filteredRegisteredProjects = useMemo(() => {
    const query = projectFilter.trim().toLowerCase();
    if (!query) return registeredProjects;
    return registeredProjects.filter((item) => item.displayName.toLowerCase().includes(query)
      || (localProject?.id === `local:${item.projectId}` && localProject.sessions.some((candidate) => candidate.title.toLowerCase().includes(query))));
  }, [localProject, projectFilter, registeredProjects]);
  useEffect(() => {
    if (!settingsOpen) return;
    const previous = document.activeElement;
    const dialog = settingsDialog.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || []);
    focusable()[0]?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setSettingsOpen(false); }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const next = event.shiftKey ? elements.at(-1) : elements[0];
      if (document.activeElement === (event.shiftKey ? elements[0] : elements.at(-1))) { event.preventDefault(); next?.focus(); }
    };
    dialog?.addEventListener('keydown', trap);
    return () => { dialog?.removeEventListener('keydown', trap); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [settingsOpen]);
  useEffect(() => {
    setDarkTheme(window.localStorage.getItem("capybara:dark-theme") === "true");
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (settingsOpen) return;
      if (event.key === 'Escape') { setActivityOpen(false); setOpenMenu(null); }
      if (event.ctrlKey && event.key.toLowerCase() === 'n') { event.preventDefault(); void startNewSession(); }
      if ((event.ctrlKey || event.metaKey) && (event.key === ',' || event.code === 'Comma')) {
        event.preventDefault();
        setOpenMenu(null);
        setSettingsOpen(true);
        void loadProjectResources(opaqueDirectoryRef ?? undefined);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
    });
  const hasEmptyRuntimeSession = localProject?.id === project.id && runtimeHydrated && extraMessages.length === 0 && activity.trace.length === 0;
  const entries: WorkbenchThreadEntry[] = localProject?.id === project.id && (!runtimeHydrated || hasEmptyRuntimeSession) ? [{ id: `${project.id}:welcome`, kind: "work", author: "agent", time: "尚未运行", title: "等待第一条指示", body: localProjectIsEmpty ? "这是一个空目录项目。你可以先告诉我希望完成的工作，我会在本地项目边界内继续。" : "本地项目已登记。你可以告诉我希望完成的工作，我会保留每轮来源和结果。", status: "waiting" }] : localProject?.id === project.id ? [] : [{ id: "unopened-project:welcome", kind: "work", author: "agent", time: "等待打开项目", title: "没有已打开的项目", body: "从左侧打开本地项目后，项目和会话会出现在这里。", status: "waiting" }];
  const rows = useMemo(() => activityRows(activity.trace, activity.steps), [activity.trace, activity.steps]);
  const visibleRows = rows.filter((row) => row.kind === "tool" || row.text || row.summary || row.reasoningSummary);
  const latestContextProjection = useMemo<RuntimeContextProjectionView | undefined>(() => {
    for (const event of [...activity.trace].reverse()) {
      if (event.type !== "runtime.context.v2.projection.created") continue;
      const projection = event.payload?.projection;
      if (projection && typeof projection === "object" && !Array.isArray(projection) && typeof (projection as { id?: unknown }).id === "string") {
        return projection as RuntimeContextProjectionView;
      }
    }
    return undefined;
  }, [activity.trace]);
  const latestThinking = [...activity.trace].reverse().find((event) => event.type === "chat.assistant.delta" && event.payload?.channel === "thinkingSummary");
  const latestTool = [...activity.trace].reverse().find((event) => event.type === "tool.call.started" || event.type === "tool.call.completed" || event.type === "tool.call.failed");
  const lastTerminal = [...activity.trace].reverse().find((event) => ["chat.assistant.completed", "chat.assistant.failed"].includes(event.type));
  const progressLabel = activity.status?.loopStatus === "running"
    ? (latestThinking ? String(latestThinking.payload?.delta ?? "正在处理") : latestTool ? traceLabel(latestTool) : activity.status?.activity?.label)
    : lastTerminal ? (lastTerminal.type === "chat.assistant.failed" ? (lastTerminal.payload?.code === "ABORTED" ? "本轮已停止，执行记录已保存" : traceLabel(lastTerminal)) : "回复已完成，执行过程和依据已保存") : undefined;
  const showProgressStrip = activity.status?.loopStatus === "running" || lastTerminal?.type === "chat.assistant.failed";
  useEffect(() => {
    if (followOutput.current && threadElement.current) threadElement.current.scrollTop = threadElement.current.scrollHeight;
  }, [extraMessages, activity.trace.length]);
  const application = localProject?.id === project.id ? localApplicationFor(project, localProjectIsEmpty, marketResearch, applicationRuntime, projectArtifacts) : undefined;
  const applicationInstance = applicationRuntime?.instances.find((item) => ["running", "health_checking", "starting", "degraded"].includes(item.status)) ?? applicationRuntime?.instances.at(-1);
  const applicationInstanceLive = Boolean(applicationInstance && ["running", "health_checking", "starting", "degraded"].includes(applicationInstance.status));
  const applicationPublished = Boolean(marketResearch?.application?.address || applicationRuntime?.manifest);
  const applicationPublishLabel = marketResearch?.application?.address ? "已发布" : applicationRuntime?.manifest ? "已登记" : "未发布";
  const applicationViewLabel = browserViewInstanceId ? (applicationLayout === "full" ? "已展开" : "侧栏") : "未打开";
  const applicationLayoutAvailable = applicationPublished;
  const applicationStatusLabel = capabilityStatus
    ? capabilityStatus.applicationRuntime.state === "available"
      ? applicationInstance?.status === "running" || applicationInstance?.status === "degraded" ? "运行中" : applicationInstance?.status === "starting" || applicationInstance?.status === "health_checking" ? "启动中" : applicationInstance?.status === "failed" ? "失败" : applicationInstance?.status === "unknown" ? "需恢复" : "已停止"
      : applicationInstance?.status === "running" ? "运行中" : "未连接"
    : "未打开项目";
  const applicationRestoringForProject = applicationRestoring && localProject?.id === project.id;

  function navigateTo(projectId: string, sessionId: string) {
    const current = navigationHistory[navigationIndex];
    if (!current || current.projectId !== projectId || current.sessionId !== sessionId) {
      const nextHistory = [...navigationHistory.slice(0, navigationIndex + 1), { projectId, sessionId }];
      setNavigationHistory(nextHistory);
      setNavigationIndex(nextHistory.length - 1);
    }
    setActiveProjectId(projectId);
    setActiveSessionId(sessionId);
  }

  async function navigateHistory(direction: -1 | 1) {
    const nextIndex = navigationIndex + direction;
    if (nextIndex < 0 || nextIndex >= navigationHistory.length) return;
    const next = navigationHistory[nextIndex];
    setNavigationIndex(nextIndex);
    try {
      if (next.projectId === localProject?.id) await connectLocalSession(next.sessionId);
      else {
        const record = registeredProjects.find((item) => 'local:' + item.projectId === next.projectId);
        if (record) await openRegisteredProject(record, next.sessionId, true);
      }
    } catch (error) { setRuntimeError(error instanceof Error ? error.message : "无法恢复导航会话"); }
    setAppTab("overview");
  }

  async function connectLocalSession(sessionId?: string, createNew = false) {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !localProject) throw new Error("请先打开本地项目");
    setRuntimeError(null);
    if (runtimeId) await bridge.closeRuntime({ runtimeId });
    setRuntimeId(null);
    setRuntimeSessionId(null);
    setRuntimeHydrated(false);
    setExtraMessages([]);
    setActivity({ children: [], processes: [], trace: [] });
    // An explicit new-session request must leave sessionId unset so the
    // desktop runtime creates a fresh persisted session. Normal reconnects
    // continue to restore the remembered session as before.
    const requestedSessionId = createNew ? undefined : knownSessionId(localProject.sessions, sessionId);
    const connection = await bridge.connectRuntime({ opaqueDirectoryRef, ...(requestedSessionId ? { sessionId: requestedSessionId } : {}) });
    setRuntimeId(connection.runtimeId);
    setRuntimeSessionId(connection.sessionId);
    setActiveSessionId(connection.sessionId);
    rememberRuntimeSessionId(localProject.id, connection.sessionId);
    setLocalProject((current) => {
      if (!current) return current;
      const existing = current.sessions.some((item) => item.id === connection.sessionId);
      const sessions = existing
        ? current.sessions
        : [...current.sessions, { id: connection.sessionId, title: "新会话", subtitle: "手动会话 · 0 次请求", status: "waiting" as const, lastRun: "尚未运行", next: "等待你的指示" }];
      return { ...current, selectedSessionId: connection.sessionId, sessions };
    });
    void restoreProjectApplication(opaqueDirectoryRef);
    return connection;
  }

  async function selectLocalSession(sessionId: string) {
    if (!localProject || sessionId === activeSessionId) return;
    navigateTo(localProject.id, sessionId);
    setRuntimeError(null);
    try {
      await connectLocalSession(sessionId);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "会话切换失败");
    }
  }

  async function prepareRegisteredProject(registered: RegisteredProject, bridge: NonNullable<typeof window.capybaraDesktop>): Promise<RegisteredProject> {
    if (!registered.isEmpty) return registered;
    await bridge.prepareProjectDirectory({ opaqueDirectoryRef: registered.opaqueDirectoryRef });
    const prepared = { ...registered, isEmpty: false };
    setRegisteredProjects((current) => current.map((item) => item.projectId === prepared.projectId ? prepared : item));
    return prepared;
  }

  async function openRegisteredProject(registered: RegisteredProject, requestedSessionId?: string, suppressNavigation = false) {
    const bridge = window.capybaraDesktop;
    if (!bridge) return;
    // Do not let the previous project's trace remain visible while the new
    // Runtime Snapshot is hydrating. The application panel has an explicit
    // restoring state; the activity panel needs the same boundary.
    setActivity({ children: [], processes: [], trace: [] });
    setResourceStatus(null);
    setRuntimeError(null);
    if (browserSessionId && opaqueDirectoryRef) {
      await bridge.closeBrowserSession({ opaqueDirectoryRef, browserInstanceId: browserSessionId }).catch(() => undefined);
      setBrowserSessionId(null);
      setBrowserSessionState(null);
    }
    if (runtimeId) await bridge.closeRuntime({ runtimeId });
    let preparedProject: RegisteredProject;
    try {
      preparedProject = await prepareRegisteredProject(registered, bridge);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "项目目录初始化失败");
      return;
    }
    const baseProject = localProjectFromRegistration(preparedProject);
    let nextProject = baseProject;
    try {
      const stored = await bridge.listRuntimeSessions({ opaqueDirectoryRef: preparedProject.opaqueDirectoryRef });
      const restored = persistedSessions(Array.isArray(stored.items) ? stored.items : []);
      if (restored.length > 0) {
        const remembered = storedRuntimeSessionId(preparedProject.projectId);
        const selectedSessionId = chooseRestoredSessionId(restored, requestedSessionId, remembered) ?? restored[0].id;
        nextProject = { ...baseProject, sessions: restored, selectedSessionId };
      }
    } catch (error) {
      setResourceStatus(error instanceof Error ? error.message : "项目会话记录读取失败");
    }
    setRegisteredProjects((current) => current.some((item) => item.projectId === preparedProject.projectId) ? current : [...current, preparedProject]);
    setLocalProject(nextProject);
    setLocalProjectIsEmpty(preparedProject.isEmpty);
    setOpaqueDirectoryRef(preparedProject.opaqueDirectoryRef);
    setRuntimeId(null);
    setRuntimeSessionId(null);
    setExtraMessages([]);
    setRuntimeHydrated(false);
    setCapabilityStatus(null);
    setApplicationRuntime(null);
    setMarketResearch(null);
    setActiveProjectId(nextProject.id);
    setActiveSessionId(nextProject.selectedSessionId);
    setAppTab("overview");
    setProjectOpenStatus({ kind: "selected", projectId: preparedProject.projectId, name: preparedProject.displayName, empty: preparedProject.isEmpty });
    void restoreProjectApplication(preparedProject.opaqueDirectoryRef);
    void loadProjectResources(preparedProject.opaqueDirectoryRef);
    try {
      setCapabilityStatus(await bridge.getProductCapabilityStatus({ opaqueDirectoryRef: preparedProject.opaqueDirectoryRef }));
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "本地能力状态未能读取");
    }
    if (preparedProject.opaqueDirectoryRef) {
      try {
        const storedSessionId = storedRuntimeSessionId(preparedProject.projectId);
        const restoredSessionId = chooseRestoredSessionId(nextProject.sessions, requestedSessionId, storedSessionId);
        const connection = await bridge.connectRuntime({ opaqueDirectoryRef: preparedProject.opaqueDirectoryRef, ...(restoredSessionId ? { sessionId: restoredSessionId } : {}) });
        setRuntimeId(connection.runtimeId);
        setRuntimeSessionId(connection.sessionId);
        setActiveSessionId(connection.sessionId);
        rememberRuntimeSessionId(preparedProject.projectId, connection.sessionId);
        if (!suppressNavigation) navigateTo(nextProject.id, connection.sessionId);
        setLocalProject((current) => {
          if (!current) return current;
          const existing = current.sessions.some((item) => item.id === connection.sessionId);
          return {
            ...current,
            selectedSessionId: connection.sessionId,
            sessions: existing ? current.sessions : [...current.sessions, { id: connection.sessionId, title: "新会话", subtitle: "手动会话 · 0 次请求", status: "waiting" as const, lastRun: "尚未运行", next: "等待你的指示" }],
          };
        });
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : "本地运行服务未连接");
      }
    }
  }

  async function closeRegisteredProject(registered: RegisteredProject) {
    const bridge = window.capybaraDesktop;
    if (!bridge) return;
    setRuntimeError(null);
    try {
      if (browserSessionId && opaqueDirectoryRef && registered.projectId === activeProjectId.replace(/^local:/, "")) {
        await bridge.closeBrowserSession({ opaqueDirectoryRef, browserInstanceId: browserSessionId }).catch(() => undefined);
        setBrowserSessionId(null);
        setBrowserSessionState(null);
      }
      await bridge.closeProject({ opaqueDirectoryRef: registered.opaqueDirectoryRef });
      const remaining = registeredProjects.filter((item) => item.projectId !== registered.projectId);
      setRegisteredProjects(remaining);
      setOpenProjectMenuId(null);
      if (localProject?.id !== `local:${registered.projectId}`) return;
      setLocalProject(null);
      setOpaqueDirectoryRef(null);
      setRuntimeId(null);
      setRuntimeSessionId(null);
      setExtraMessages([]);
      setRuntimeHydrated(false);
      setCapabilityStatus(null);
      setApplicationRuntime(null);
      setMarketResearch(null);
      setActivity({ children: [], processes: [], trace: [] });
      setResourceStatus(null);
      void restoreProjectApplication(null);
      setApplicationRestoring(false);
      setActiveProjectId("");
      setActiveSessionId("");
      setProjectOpenStatus({ kind: "idle" });
      if (remaining.length > 0) await openRegisteredProject(remaining[0]);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "项目关闭失败");
    }
  }

  useEffect(() => {
    const bridge = window.capybaraDesktop;
    if (!bridge) return;
    void bridge.listProjects().then(({ items }) => {
      setRegisteredProjects(items);
      if (items.length > 0) void openRegisteredProject(items[0]);
    }).catch((error) => {
      setRuntimeError(error instanceof Error ? error.message : "已打开项目读取失败");
    });
  }, []);

  useEffect(() => {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) { setApplicationRuntime(null); return; }
    let disposed = false;
    const refresh = () => bridge.getApplicationStatus({ opaqueDirectoryRef }).then((status) => {
      if (!disposed) {
        setApplicationRuntime(status);
        setActivity((current) => ({ ...current, applicationReceipts: status?.receipts ?? [] }));
      }
    }).catch(() => {
      if (!disposed) setApplicationRuntime(null);
    });
    void refresh();
    const stop = bridge.onApplicationEvent((event) => {
      if (event.projectId && localProject && event.projectId !== localProject.id.replace(/^local:/, "")) return;
      void refresh();
      if (event.type === "application.browser.opened") {
        setBrowserViewInstanceId(String(event.instanceId ?? "application"));
        setApplicationLayoutState(event.layout === "full" ? "full" : "side");
      }
      if (event.type === "application.browser.closed") {
        setBrowserViewInstanceId(null);
        setApplicationLayoutState("side");
      }
      if (event.type === "application.start.failed" || event.type === "application.process.failed") {
        setRuntimeError(String(event.message ?? "项目应用启动失败"));
      }
    });
    return () => { disposed = true; stop(); };
  }, [opaqueDirectoryRef, localProject?.id]);

  useEffect(() => {
    const bridge = window.capybaraDesktop;
    if (!bridge) return;
    const stop = bridge.onBrowserEvent((event: BrowserSessionEvent) => {
      if (event.projectId && localProject && event.projectId !== localProject.id.replace(/^local:/, "")) return;
      if (browserSessionId && event.browserInstanceId !== browserSessionId) return;
      if (event.state) {
        setBrowserSessionState(event.state);
        if (event.state.url) setBrowserSessionUrl(event.state.url);
      }
      if (event.type === "browser.session.closed") {
        setBrowserSessionId(null);
        setBrowserSessionState(null);
      }
      if (event.type === "browser.session.load_failed") {
        setBrowserSessionError(event.errorDescription || "浏览器页面加载失败");
      }
      if (event.type === "browser.session.crashed") {
        setBrowserSessionError("浏览器页面进程异常退出，已保留最后状态");
      }
    });
    return () => stop();
  }, [browserSessionId, localProject?.id]);

  useEffect(() => {
    // Research state is restored from the project's Runtime Trace snapshot.
    // Clearing it on project switch prevents a previous project's result from
    // appearing while the new session is still hydrating.
    setMarketResearch(null);
    setProjectArtifacts([]);
  }, [localProject?.id]);

  useEffect(() => {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) return;
    let disposed = false;
    void bridge.loadMarketResearch({ opaqueDirectoryRef }).then((result) => {
      if (!disposed && result) rememberMarketResearch(result);
    }).catch(() => {
      // A missing result is a normal state for projects that have not run research.
    });
    return () => { disposed = true; };
  }, [opaqueDirectoryRef]);

  function rememberMarketResearch(result: MarketResearchHostResult) {
    setMarketResearch(result);
  }

  async function restoreRuntimeBrowserContext(bridge: NonNullable<typeof window.capybaraDesktop>, contexts: Array<{ browserInstanceId?: string; url?: string; allowedOrigins?: string[] }> | undefined) {
    const ref = currentOpaqueDirectoryRef.current;
    if (!ref || browserSessionIdCurrent.current || !Array.isArray(contexts) || contexts.length === 0) return;
    const saved = [...contexts].reverse().find((item) => typeof item.browserInstanceId === 'string' && typeof item.url === 'string' && item.url.trim());
    if (!saved?.browserInstanceId || !saved.url) return;
    try {
      const result = await bridge.openBrowserSession({
        opaqueDirectoryRef: ref,
        browserInstanceId: saved.browserInstanceId,
        url: saved.url,
        allowExternal: true,
        allowedOrigins: Array.isArray(saved.allowedOrigins) && saved.allowedOrigins.length > 0 ? saved.allowedOrigins : INTERACTIVE_BROWSER_ORIGINS,
        layout: 'side',
        resume: true,
      });
      if (browserSessionIdCurrent.current) return;
      setBrowserSessionId(saved.browserInstanceId);
      setBrowserSessionState(result.state);
      setBrowserSessionUrl(result.state.url || saved.url);
      setBrowserSessionError(null);
    } catch (error) {
      setBrowserSessionError(error instanceof Error ? `浏览器会话恢复需要验证：${error.message}` : '浏览器会话恢复需要验证');
    }
  }

  useEffect(() => {
    const bridge = window.capybaraDesktop;
    if (!bridge) return;
    const stopEvents = bridge.onRuntimeEvent(({ runtimeId: senderRuntimeId, data }) => {
      try {
        const event = parseRuntimeEvent(data);
        if (event.type === "session.attached") {
          const session = (event.payload as { session?: { id?: string } }).session;
          if (session?.id) { observedSession.current = session.id; observedRuntime.current = senderRuntimeId; setRuntimeSessionId(session.id); setRuntimeError(null); }
          return;
        }
        if (observedSession.current && event.sessionId && observedSession.current !== event.sessionId) return;
        if (event.type === "runtime.context.documents.updated") {
          if (observedRuntime.current !== senderRuntimeId) return;
          const { contextDocumentView, projectContextDocumentView } = event.payload as EventPayloadMap["runtime.context.documents.updated"];
          setActivity(current => ({ ...current, contextDocumentView, projectContextDocumentView,
            contextDocumentMarkdown: contextDocumentView?.markdown, projectContextDocumentMarkdown: projectContextDocumentView?.markdown }));
          return;
        }
        if (event.type === "runtime.snapshot") {
          if (observedRuntime.current && observedRuntime.current !== senderRuntimeId) return;
          const snapshot = event.payload as { timeline?: { steps?: import("@capybara-agent/protocol").TimelineStep[] }; trace?: RuntimeTraceEvent[]; children?: { items?: RuntimeActivityView["children"] }; processes?: { items?: RuntimeActivityView["processes"] }; contextScopes?: RuntimeActivityView["contextScopes"]; contextCandidates?: RuntimeContextCandidateView[]; contextEvidence?: RuntimeContextEvidenceView[]; contextReceipts?: RuntimeContextReceiptView[]; contextReviewReceipts?: RuntimeContextReceiptView[]; contextEvidenceReviews?: RuntimeContextReceiptView[]; contextDocumentView?: RuntimeContextDocumentView; projectContextDocumentView?: RuntimeContextDocumentView; contextOrganization?: RuntimeContextOrganizationView; contextDocumentMarkdown?: string; projectContextDocumentMarkdown?: string; renderResult?: RuntimeRenderResultView; variables?: RuntimeVariablesView; effectiveContexts?: RuntimeEffectiveContextView; browserContexts?: Array<{ browserInstanceId?: string; url?: string; allowedOrigins?: string[] }>; status?: RuntimeActivityView["status"] };
          void restoreRuntimeBrowserContext(bridge, snapshot.browserContexts);
          const restoredTrace = Array.isArray(snapshot.trace) ? snapshot.trace : [];
          const controlSnapshot = event.payload as import("@capybara-agent/protocol").RuntimeSnapshot;
          const answerable = ["running", "pause_requested", "paused", "interrupted"].includes(controlSnapshot.run?.status);
          const branchQuestions = answerable ? pendingBranchQuestions(controlSnapshot.taskControl) : [];
          const restoredResearch = [...restoredTrace].reverse().map(marketResearchFromTraceEvent).find((item): item is MarketResearchHostResult => Boolean(item));
          if (restoredResearch) rememberMarketResearch(restoredResearch);
          setActivity((current) => ({ steps: snapshot.timeline?.steps, trace: restoredTrace, children: Array.isArray(snapshot.children?.items) ? snapshot.children.items : [], processes: Array.isArray(snapshot.processes?.items) ? snapshot.processes.items : [], contextScopes: snapshot.contextScopes, contextCandidates: snapshot.contextCandidates, contextEvidence: snapshot.contextEvidence, contextReceipts: snapshot.contextReceipts, applicationReceipts: current.applicationReceipts, contextReviewReceipts: snapshot.contextReviewReceipts, contextEvidenceReviews: snapshot.contextEvidenceReviews, contextDocumentView: snapshot.contextDocumentView, projectContextDocumentView: snapshot.projectContextDocumentView, contextOrganization: snapshot.contextOrganization, contextDocumentMarkdown: snapshot.contextDocumentMarkdown, projectContextDocumentMarkdown: snapshot.projectContextDocumentMarkdown, renderResult: snapshot.renderResult, variables: snapshot.variables, effectiveContexts: snapshot.effectiveContexts, status: snapshot.status }));
          setActivity(current => ({ ...current, branchQuestions, mcpInputs: controlSnapshot.mcp?.inputRequests }));
          setExtraMessages(transcriptFromSnapshot(event));
          const messages = transcriptFromSnapshot(event);
          const count = messages.filter((message) => message.role === "user").length;
          const title = messages.find((message) => message.role === "user")?.body.split(/\r?\n/)[0].slice(0, 32);
          const savedMessages = (event.payload as { conversation?: { messages?: Array<{ createdAt?: string; completedAt?: string }> } }).conversation?.messages || [];
          const lastMessage = savedMessages.at(-1);
          setLocalProject((current) => current ? { ...current, sessions: current.sessions.map((item) => item.id === event.sessionId ? { ...item, ...(title ? { title } : {}), ...(count ? { lastRun: sessionLastRun(lastMessage?.completedAt || lastMessage?.createdAt) } : {}), subtitle: `手动会话 · ${count} 次请求`, status: snapshot.status?.loopStatus === "running" ? "working" : "waiting" } : item) } : current);
          setRuntimeHydrated(true);
          return;
        }
        if (event.type !== "session.attached") {
          const traceEvent = event as RuntimeTraceEvent;
          setActivity((current) => ({
            ...current,
            trace: current.trace.some((item) => item.id === traceEvent.id)
              ? current.trace
              : [...current.trace, traceEvent],
          }));
        }
        if (event.type === "timeline.step.upserted") {
          const { step } = event.payload as { step: import("@capybara-agent/protocol").TimelineStep };
          setActivity((current) => ({ ...current, steps: [...(current.steps || []).filter((item) => item.id !== step.id), step] }));
        }
        if (event.type === "render.result.updated") {
          setActivity(current => ({ ...current, renderResult: event.payload as RuntimeRenderResultView }));
        }
        if (event.type === "runtime.mcp.updated") {
          const state = event.payload as RuntimeMcpState;
          setActivity(current => ({ ...current, mcpInputs: state.inputRequests }));
        }
        if (event.type === "run.state.changed" && ["cancelled", "completed", "failed"].includes((event.payload as { status: string }).status)) {
          setActivity(current => ({ ...current, branchQuestions: [] }));
        }
        if (event.type === "tool.call.completed") {
          const result = marketResearchFromTraceEvent(event as RuntimeTraceEvent);
          if (result) { rememberMarketResearch(result); setActivityOpen(false); setAppOpen(true); setAppTab("plan"); }
          const activeDirectoryRef = currentOpaqueDirectoryRef.current;
          if (activeDirectoryRef) {
            void bridge.projectApi<{ revision?: number; items?: ProjectArtifactView[] }>({ opaqueDirectoryRef: activeDirectoryRef, path: "/api/resources/artifacts" })
              .then((artifacts) => setProjectArtifacts(Array.isArray(artifacts.items) ? artifacts.items : []))
              .catch(() => undefined);
          }
        }
        if (event.type === "runtime.children.updated" || event.type === "runtime.processes.updated" || event.type === "runtime.status.updated") {
          const payload = event.payload as Record<string, unknown>;
          setActivity((current) => ({
            ...current,
            ...(event.type === "runtime.children.updated" ? { children: Array.isArray(payload.items) ? payload.items as RuntimeActivityView["children"] : current.children } : {}),
            ...(event.type === "runtime.processes.updated" ? { processes: Array.isArray(payload.items) ? payload.items as RuntimeActivityView["processes"] : current.processes } : {}),
            ...(event.type === "runtime.status.updated" ? { status: payload as RuntimeActivityView["status"] } : {}),
          }));
          return;
        }
        const eventMessage = transcriptMessageFromEvent(event);
        if (eventMessage) {
          setExtraMessages((current) => mergeTranscriptMessage(current, eventMessage));
          return;
        }
        if (event.type === "chat.assistant.delta") {
          const delta = chatTextFromEvent(event);
          if (!delta) return;
          const payload = event.payload as { messageId?: string };
          setExtraMessages((current) => {
            const messageId = typeof payload.messageId === "string" ? payload.messageId : `assistant:${crypto.randomUUID()}`;
            const index = current.findIndex((item) => item.id === messageId);
            if (index >= 0) {
              const next = [...current];
              next[index] = { ...next[index], body: `${next[index].body === "（无文本内容）" ? "" : next[index].body}${delta}`, time: "运行中", status: "streaming" };
              return next;
            }
            return [...current, { id: messageId, role: "agent", body: delta, time: "运行中", status: "streaming" }];
          });
          return;
        }
      } catch {
        setRuntimeError("本地运行服务返回了无法解析的消息");
      }
    });
    const stopClosed = bridge.onRuntimeClosed((closed) => {
      if (!shouldHandleRuntimeClosed(currentRuntime.current, closed)) return;
      setRuntimeId(null);
      setRuntimeSessionId(null);
      setRuntimeError("本地运行服务已断开");
    });
    return () => { stopEvents(); stopClosed(); };
  }, []);

  async function replyToMcpInput(payload: CommandPayloadMap["runtime.mcp.input.reply"]) {
    const bridge = window.capybaraDesktop;
    if (!bridge || !runtimeId || !runtimeSessionId) throw new Error("本地会话尚未连接。");
    const result = await bridge.sendRuntimeFrame({ runtimeId, frame: { version: 1, kind: "command", id: crypto.randomUUID(),
      type: "runtime.mcp.input.reply", sessionId: runtimeSessionId, timestamp: new Date().toISOString(), payload } });
    if (!result.accepted) throw new Error("提交未通过，请核对必填项、格式或请求是否已处理。");
  }

  const readMcpInputUrl = useCallback(async (requestId: string, urlId: string) => {
    const bridge = window.capybaraDesktop;
    if (!bridge || !runtimeId) throw new Error("本地会话尚未连接。");
    return bridge.readMcpInputUrl({ runtimeId, requestId, urlId });
  }, [runtimeId]);

  async function openMcpInputUrl(requestId: string, urlId: string) {
    const bridge = window.capybaraDesktop;
    if (!bridge || !runtimeId) throw new Error("本地会话尚未连接。");
    return bridge.openMcpInputUrl({ runtimeId, requestId, urlId });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || (!replyTarget && activity.status?.loopStatus === "running")) return;
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !localProject || localProject.id !== project.id) {
      setRuntimeError(bridge ? "请先打开本地项目后发送指示" : "请在 Electron Workbench 中打开本地项目后发送指示");
      return;
    }
    try {
      let activeRuntimeId = runtimeId;
      let activeRuntimeSessionId = knownSessionId(localProject.sessions, runtimeSessionId ?? activeSessionIdStateForProject(localProject.id, activeSessionId));
      if (!activeRuntimeId) {
        const connection = await bridge.connectRuntime({ opaqueDirectoryRef, ...(activeRuntimeSessionId ? { sessionId: activeRuntimeSessionId } : {}) });
        activeRuntimeId = connection.runtimeId;
        activeRuntimeSessionId = connection.sessionId;
        setRuntimeId(activeRuntimeId);
        setRuntimeSessionId(activeRuntimeSessionId);
        setActiveSessionId(activeRuntimeSessionId);
        rememberRuntimeSessionId(localProject.id, activeRuntimeSessionId);
      }
      if (!activeRuntimeSessionId) {
        setRuntimeError("本地会话仍在连接，暂时不能发送指示");
        return;
      }
      const id = crypto.randomUUID();
      followOutput.current = true;
      await bridge.sendRuntimeFrame({ runtimeId: activeRuntimeId, frame: createChatFrame(activeRuntimeSessionId, body, {
        commandId: id, clientMessageId: `message:${id}`, humanRequestId: replyTarget?.id,
      }) });
      setExtraMessages((current) => mergeTranscriptMessage(current, { id: `message:${id}`, role: "user", body, time: "刚刚", status: "queued" }));
      setRuntimeHydrated(true);
      setRuntimeError(null);
      setDraft("");
      setReplyTargetId("");
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "发送指示失败");
    }
  }
  async function openLocalProject() {
    const bridge = window.capybaraDesktop;
    if (!bridge) {
      setProjectOpenStatus({ kind: "unavailable", message: "桌面未连接：请在 Electron Workbench 中打开本地项目" });
      return;
    }
    // Directory selection is cancellable. Keep the complete current selection
    // snapshot so a native dialog cancel cannot leave the workbench on the
    // unopened-project projection while the existing project is still active.
    const previousSelection = {
      localProject,
      activeProjectId,
      activeSessionId,
      opaqueDirectoryRef,
      localProjectIsEmpty,
      runtimeId,
      runtimeSessionId,
      runtimeHydrated,
    };
    setProjectOpenStatus({ kind: "opening" });
    setRuntimeError(null);
    try {
      const result = await bridge.pickProjectDirectory();
      if (result.kind === "cancelled") {
        setLocalProject(previousSelection.localProject);
        setActiveProjectId(previousSelection.activeProjectId);
        setActiveSessionId(previousSelection.activeSessionId);
        setOpaqueDirectoryRef(previousSelection.opaqueDirectoryRef);
        setLocalProjectIsEmpty(previousSelection.localProjectIsEmpty);
        setRuntimeId(previousSelection.runtimeId);
        setRuntimeSessionId(previousSelection.runtimeSessionId);
        setRuntimeHydrated(previousSelection.runtimeHydrated);
        setProjectOpenStatus({ kind: "cancelled", message: "已取消选择，没有登记项目目录" });
        return;
      }
      const registered = await bridge.registerProjectDirectory(result.selection);
      const registeredWithRef: RegisteredProject = { ...registered, opaqueDirectoryRef: result.selection.opaqueDirectoryRef };
      const preparedProject = await prepareRegisteredProject(registeredWithRef, bridge);
      setRegisteredProjects((current) => [preparedProject, ...current.filter((item) => item.projectId !== preparedProject.projectId)]);
      const baseProject = localProjectFromRegistration(preparedProject);
      let nextProject = baseProject;
      try {
        const stored = await bridge.listRuntimeSessions({ opaqueDirectoryRef: preparedProject.opaqueDirectoryRef });
        const restored = persistedSessions(Array.isArray(stored.items) ? stored.items : []);
        if (restored.length > 0) {
          const remembered = storedRuntimeSessionId(preparedProject.projectId);
          const selectedSessionId = chooseRestoredSessionId(restored, undefined, remembered) ?? restored[0].id;
          nextProject = { ...baseProject, sessions: restored, selectedSessionId };
        }
      } catch (error) {
        setResourceStatus(error instanceof Error ? error.message : "项目会话记录读取失败");
      }
      setLocalProject(nextProject);
      setLocalProjectIsEmpty(preparedProject.isEmpty);
      setOpaqueDirectoryRef(preparedProject.opaqueDirectoryRef);
      setRuntimeId(null);
      setRuntimeSessionId(null);
      setExtraMessages([]);
      setRuntimeHydrated(false);
      setCapabilityStatus(null);
      setMarketResearch(null);
      setActiveProjectId(nextProject.id);
      setActiveSessionId(nextProject.selectedSessionId);
      setAppTab("overview");
      setProjectOpenStatus({ kind: "selected", projectId: preparedProject.projectId, name: preparedProject.displayName, empty: preparedProject.isEmpty });
      void restoreProjectApplication(preparedProject.opaqueDirectoryRef);
      void loadProjectResources(preparedProject.opaqueDirectoryRef);
      try {
        setCapabilityStatus(await bridge.getProductCapabilityStatus({ opaqueDirectoryRef: preparedProject.opaqueDirectoryRef }));
      } catch (error) {
        setRuntimeError(error instanceof Error ? error.message : "本地能力状态未能读取");
      }
      if (!preparedProject.isEmpty) {
        try {
          const storedSessionId = storedRuntimeSessionId(preparedProject.projectId);
          const restoredSessionId = chooseRestoredSessionId(nextProject.sessions, undefined, storedSessionId);
          const connection = await bridge.connectRuntime({ opaqueDirectoryRef: preparedProject.opaqueDirectoryRef, ...(restoredSessionId ? { sessionId: restoredSessionId } : {}) });
          setRuntimeId(connection.runtimeId);
          setRuntimeSessionId(connection.sessionId);
          setActiveSessionId(connection.sessionId);
          rememberRuntimeSessionId(preparedProject.projectId, connection.sessionId);
          setLocalProject((current) => {
            if (!current) return current;
            const existing = current.sessions.some((item) => item.id === connection.sessionId);
            return {
              ...current,
              selectedSessionId: connection.sessionId,
              sessions: existing ? current.sessions : [...current.sessions, { id: connection.sessionId, title: "新会话", subtitle: "手动会话 · 0 次请求", status: "waiting" as const, lastRun: "尚未运行", next: "等待你的指示" }],
            };
          });
        } catch (error) {
          setRuntimeError(error instanceof Error ? error.message : "本地运行服务未连接");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "桌面目录选择失败：未建立本地项目";
      setProjectOpenStatus({ kind: "unavailable", message });
      setRuntimeError(message);
    }
  }

  async function loadProjectResources(ref?: string) {
    const bridge = window.capybaraDesktop;
    if (!bridge) return;
    const requestGeneration = ++resourceLoadGeneration.current;
    try {
      const [modelResult, variableResult, catalogResult, artifactResult] = await Promise.allSettled([
        bridge.getModelSettings(),
        ref ? bridge.projectApi<{ version: number; variables: SystemVariableView[] }>({ opaqueDirectoryRef: ref, path: "/api/resources/system-variables" }) : Promise.resolve({ variables:[] as SystemVariableView[] }),
        ref ? bridge.projectApi<ResourceCatalogView>({ opaqueDirectoryRef: ref, path: "/api/resources/catalog" }) : Promise.resolve({ items:[] } as ResourceCatalogView),
        ref ? bridge.projectApi<{ revision?: number; items?: ProjectArtifactView[] }>({ opaqueDirectoryRef: ref, path: "/api/resources/artifacts" }) : Promise.resolve({ items:[] } as { items: ProjectArtifactView[] }),
      ]);
      // A project switch can finish the old request after the new one. Never
      // let an old project's settings/catalog overwrite the active project.
      if (requestGeneration !== resourceLoadGeneration.current) return;
      if (modelResult.status === 'fulfilled') {
        const nextSettings = modelResult.value;
        setSettings(nextSettings);
        setSettingsDraft({ provider: nextSettings.llm.provider, model: nextSettings.llm.model, base_url: nextSettings.llm.base_url, protocol: nextSettings.llm.protocol, apiKey: "" });
      }
      if (variableResult.status === 'fulfilled') setSystemVariables(variableResult.value.variables ?? []);
      if (catalogResult.status === 'fulfilled') setCatalog(catalogResult.value);
      if (artifactResult.status === 'fulfilled') setProjectArtifacts(Array.isArray(artifactResult.value.items) ? artifactResult.value.items : []);
      const failed = [modelResult, variableResult, catalogResult, artifactResult].map((result, index) => result.status === 'rejected' ? ['全局模型设置', '项目提示词变量', '项目资源目录', '项目产物索引'][index] : '').filter(Boolean);
      setResourceStatus(failed.length ? `${failed.join('、')}读取失败。${modelResult.status === 'fulfilled' ? '全局模型配置已正常读取，聊天与过程记录可继续使用。' : '请检查本地配置后重试。'}` : null);
    } catch (error) {
      setResourceStatus(error instanceof Error ? error.message : "项目资源读取失败");
    }
  }

  async function reviewProjectArtifact(artifactId: string, decision: 'accept' | 'reject') {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) return;
    setArtifactReviewBusyId(artifactId);
    try {
      const result = await bridge.projectApi<{ artifact?: ProjectArtifactView }>({ opaqueDirectoryRef, path: `/api/resources/artifacts/${encodeURIComponent(artifactId)}/review`, method: 'POST', body: { decision } });
      if (result.artifact) {
        setProjectArtifacts((current) => current.map((item) => item.artifactId === artifactId ? result.artifact! : item));
        setResourceStatus(`产物审核：${result.artifact.kind || artifactId} 已${decision === 'accept' ? '接受' : '拒绝'}。`);
      }
    } catch (error) {
      setResourceStatus(resourceOperationError(error, "产物审核失败"));
    } finally {
      setArtifactReviewBusyId(null);
    }
  }

  async function verifyProjectArtifact(artifactId: string) {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) return;
    setArtifactReviewBusyId(artifactId);
    try {
      const result = await bridge.projectApi<{ verification?: { record?: ProjectArtifactView; reason?: string } }>({ opaqueDirectoryRef, path: `/api/resources/artifacts/${encodeURIComponent(artifactId)}/verify`, method: 'POST' });
      const record = result.verification?.record;
      if (record) setProjectArtifacts((current) => current.map((item) => item.artifactId === artifactId ? record : item));
      if (result.verification?.reason) setResourceStatus(`产物复核：${result.verification.reason}`);
      else if (record) setResourceStatus(`产物复核：${record.kind || artifactId} 已验证，当前状态为 ${record.status}。`);
    } catch (error) {
      setResourceStatus(resourceOperationError(error, "产物复核失败"));
    } finally {
      setArtifactReviewBusyId(null);
    }
  }

  async function saveProjectSettings() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !settings) return;
    setResourceBusy(true);
    setResourceStatus(null);
    try {
      const body = { llm: { ...settings.llm, provider: settingsDraft.provider, model: settingsDraft.model, base_url: settingsDraft.base_url, protocol: settingsDraft.protocol, ...(settingsDraft.apiKey.trim() ? { api_key: settingsDraft.apiKey.trim() } : {}) } };
      const next = await bridge.saveModelSettings(body);
      setSettings(next);
      setSettingsDraft((current) => ({ ...current, apiKey: "" }));
      setResourceStatus(`已保存 ${next.llm.provider}/${next.llm.model}，密钥${next.llm.api_key_configured ? "已配置" : "未配置"}`);
    } catch (error) {
      setResourceStatus(error instanceof Error ? error.message : "项目设置保存失败");
    } finally {
      setResourceBusy(false);
    }
  }

  async function saveSystemVariable(variable: SystemVariableView, value: string) {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || variable.readonly) return;
    setResourceBusy(true);
    try {
      const nextVariables = systemVariables.map((item) => item.key === variable.key ? { ...item, value } : item);
      const result = await bridge.projectApi<{ variables: SystemVariableView[] }>({ opaqueDirectoryRef, path: "/api/resources/system-variables", method: "PUT", body: { version: 1, variables: nextVariables } });
      setSystemVariables(result.variables ?? nextVariables);
      setResourceStatus(`已更新变量 ${variable.key}`);
    } catch (error) {
      setResourceStatus(error instanceof Error ? error.message : "系统变量保存失败");
    } finally {
      setResourceBusy(false);
    }
  }

  async function previewSkill() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !skillRepo.trim() || !skillPath.trim()) { setResourceStatus("请输入 Skill 仓库（owner/repo）和目录路径"); return; }
    setResourceBusy(true);
    try {
      const preview = await bridge.projectApi<{ commit?: string; skillName?: string; description?: string }>({ opaqueDirectoryRef, path: "/api/resources/skills/marketplace/preview", method: "POST", body: { repo: skillRepo.trim(), path: skillPath.trim() } });
      setSkillCommit(preview.commit ?? "");
      setResourceStatus(`Skill 预览通过：${preview.skillName ?? skillPath}。${preview.commit ? "已取得完整 commit，可安装。" : "等待预览结果。"}`);
    } catch (error) {
      setResourceStatus(resourceOperationError(error, "Skill 预览失败"));
    } finally { setResourceBusy(false); }
  }

  async function installSkill() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !skillRepo.trim() || !skillPath.trim() || !skillCommit.trim()) { setResourceStatus("请先预览 Skill，并确认完整 commit"); return; }
    setResourceBusy(true);
    try {
      await bridge.projectApi({ opaqueDirectoryRef, path: "/api/resources/skills/marketplace/install", method: "POST", body: { repo: skillRepo.trim(), path: skillPath.trim(), commit: skillCommit.trim() } });
      await loadProjectResources(opaqueDirectoryRef);
      setResourceStatus("Skill 已安装并加入当前项目资源目录");
    } catch (error) {
      setResourceStatus(resourceOperationError(error, "Skill 安装失败"));
    } finally { setResourceBusy(false); }
  }

  async function installPlugin() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !pluginSource.trim()) { setResourceStatus("请输入当前项目内的插件目录，例如 plugins/stock-tools"); return; }
    setResourceBusy(true);
    try {
      const preview = await bridge.projectApi<{ valid?: boolean }>({ opaqueDirectoryRef, path: "/api/resources/plugins/install/preview", method: "POST", body: { source: pluginSource.trim() } });
      if (preview.valid === false) throw new Error("插件预览未通过校验");
      await bridge.projectApi({ opaqueDirectoryRef, path: "/api/resources/plugins/install", method: "POST", body: { source: pluginSource.trim() } });
      await loadProjectResources(opaqueDirectoryRef);
      setResourceStatus("工具插件已安装并加入当前项目资源目录");
    } catch (error) {
      setResourceStatus(resourceOperationError(error, "工具插件安装失败"));
    } finally { setResourceBusy(false); }
  }

  async function refreshApplicationStatus() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) return null;
    const status = await bridge.getApplicationStatus({ opaqueDirectoryRef, appId: applicationRuntime?.manifest.appId });
    setApplicationRuntime(status);
    return status;
  }

  async function startProjectApplication() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) {
      setRuntimeError("请先打开本地项目");
      return null;
    }
    try {
      setRuntimeError(null);
      const instance = await bridge.startApplication({ opaqueDirectoryRef, appId: applicationRuntime?.manifest.appId });
      await refreshApplicationStatus();
      return instance;
    } catch (error) {
      setRuntimeError(applicationOperationError(error, "项目应用启动失败"));
      return null;
    }
  }

  async function stopProjectApplication() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) return;
    try {
      await bridge.stopApplication({ opaqueDirectoryRef, appId: applicationRuntime?.manifest.appId, instanceId: applicationInstance?.instanceId, reason: "user" });
      // A stopped process cannot back the current WebContentsView. Close the
      // view in the renderer as part of the same lifecycle transition so the
      // UI cannot keep showing a dead local page.
      if (browserViewInstanceId) await closeEmbeddedBrowser();
      await refreshApplicationStatus();
    } catch (error) { setRuntimeError(error instanceof Error ? error.message : "项目应用停止失败"); }
  }

  async function restartProjectApplication() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) return null;
    try {
      setRuntimeError(null);
      if (browserViewInstanceId) await closeEmbeddedBrowser();
      const instance = await bridge.restartApplication({ opaqueDirectoryRef, appId: applicationRuntime?.manifest.appId, instanceId: applicationInstance?.instanceId });
      await refreshApplicationStatus();
      return instance;
    } catch (error) { setRuntimeError(applicationOperationError(error, "项目应用重启失败")); return null; }
  }

  async function updateProjectApplication() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) return;
    try {
      setRuntimeError(null);
      const result = await bridge.updateApplication({ opaqueDirectoryRef, appId: applicationRuntime?.manifest.appId, instanceId: applicationInstance?.instanceId });
      await refreshApplicationStatus();
      if (result.operation === "update_rolled_back") {
        setRuntimeError(`应用更新失败，已回滚到 ${result.restoredVersionId ?? result.previousVersionId ?? "上一版本"}：${result.updateError ?? "未知原因"}`);
      } else {
        setRuntimeError("应用已更新到新版本");
      }
    } catch (error) { setRuntimeError(error instanceof Error ? error.message : "应用更新失败"); }
  }

  async function rollbackProjectApplication() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !applicationRuntime) return;
    const target = applicationRuntime.versions?.find((version) => version.versionId !== applicationRuntime.manifest.versionId);
    if (!target) { setRuntimeError("当前没有可回滚的应用版本"); return; }
    try {
      setRuntimeError(null);
      await bridge.rollbackApplication({ opaqueDirectoryRef, appId: applicationRuntime.manifest.appId, instanceId: applicationInstance?.instanceId, targetVersionId: target.versionId, reason: "用户从项目应用面板发起回滚" });
      await refreshApplicationStatus();
      setRuntimeError(`应用已回滚到 ${target.versionId}`);
    } catch (error) { setRuntimeError(error instanceof Error ? error.message : "应用回滚失败"); }
  }

  async function openDashboard() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) {
      setRuntimeError("当前还没有可打开的本地应用，请先打开项目");
      return;
    }
    try {
      if (browserSessionId) await closeInteractiveBrowser();
      const dashboardAddress = marketResearch?.application?.persistentAddress || marketResearch?.application?.address;
      if (dashboardAddress) {
        await bridge.openApplication({ opaqueDirectoryRef, url: dashboardAddress, title: "000682 行情看板" });
        setRuntimeError("已在 Capybara 内嵌浏览器中打开 000682 行情看板");
        return;
      }
      let instance: ApplicationInstanceView | undefined = applicationInstance;
      if (!instance || instance.status !== "running") instance = (await startProjectApplication()) ?? undefined;
      if (!instance) {
        const legacyAddress = marketResearch?.application?.address;
        if (legacyAddress) {
          await bridge.openApplication({ url: legacyAddress, title: "项目应用" });
          setRuntimeError("已在 Capybara 内嵌浏览器中打开应用");
        }
        return;
      }
      await bridge.openApplication({ opaqueDirectoryRef, instanceId: instance.instanceId, title: applicationRuntime?.manifest.appId || "Capybara 应用" });
      setRuntimeError("已在 Capybara 内嵌浏览器中打开应用");
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "应用打开失败");
    }
  }

  async function closeEmbeddedBrowser() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !browserViewInstanceId) return;
    try {
      await bridge.closeApplicationView({ instanceId: browserViewInstanceId });
      setBrowserViewInstanceId(null);
      setApplicationLayoutState("side");
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "关闭应用视图失败");
    }
  }

  async function startNewSession() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !localProject) {
      setRuntimeError("请先打开本地项目后创建会话");
      return;
    }
    // Keep the create path single-flight across both button and keyboard
    // events. The desktop bridge can resolve just after the first event has
    // returned to the page, so a short 750ms window still allowed a second
    // physical/keyboard trigger to create another persisted session.
    if (creatingSession.current || Date.now() - lastNewSessionAt.current < 2000) return;
    creatingSession.current = true;
    lastNewSessionAt.current = Date.now();
    setNewSessionBusy(true);
    try {
      const connection = await connectLocalSession(undefined, true);
      navigateTo(localProject.id, connection.sessionId);
      setRuntimeError("新会话已创建");
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "新会话创建失败");
    } finally {
      creatingSession.current = false;
      setNewSessionBusy(false);
    }
  }

  function capabilityLabel(state: ProductCapabilityStatus["applicationRuntime"]["state"]): string {
    return state === "available" ? "已连接" : state === "unavailable" ? "不可用" : "待发现";
  }

  async function sendSessionMessage(targetSessionId: string, text: string, sourceSessionId = runtimeSessionId ?? activeSessionId, fromApplication = false) {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !targetSessionId || !sourceSessionId) return;
    setSessionMessageBusy(true);
    setSessionMessageResult(null);
    try {
      const result = await bridge.sendSessionMessage({
        opaqueDirectoryRef,
        sourceSessionId: fromApplication ? `application:${project.id}` : sourceSessionId,
        targetSessionId,
        type: fromApplication ? "chat.message" : "task.request",
        payload: { text },
        idempotencyKey: `ui:${fromApplication ? "application" : sourceSessionId}:${targetSessionId}:${text}`,
      });
      setSessionMessageResult(result.callbackText);
      const directory = await bridge.listSessionDirectory({ opaqueDirectoryRef });
      setSessionDirectory(directory);
    } catch (error) {
      setSessionMessageResult(error instanceof Error ? error.message : String(error));
    } finally {
      setSessionMessageBusy(false);
    }
  }

  function requestApplicationControl() {
    if (marketResearch?.application?.address) {
      void openDashboard();
      return;
    }
    const status = capabilityStatus?.applicationRuntime;
    if (!status || status.state !== "available") {
      setRuntimeError(status ? `应用运行入口${capabilityLabel(status.state)}：${status.detail}` : "当前项目尚未连接应用运行时能力");
      return;
    }
    if (applicationInstance?.status === "running") void openDashboard();
    else void startProjectApplication();
  }

  async function changeApplicationLayout(layout: 'side' | 'full') {
    const bridge = window.capybaraDesktop;
    if (!bridge) {
      setRuntimeError("桌面未连接，无法切换应用布局");
      return;
    }
    try {
      const result = await bridge.setApplicationLayout({ layout });
      setApplicationLayoutState(result.layout);
      setRuntimeError(result.layout === "full" ? "应用视图已展开" : "应用视图已收起到侧栏");
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "应用布局切换失败");
    }
  }

  async function requestBrowserEntry() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) {
      setRuntimeError("请先打开本地项目后使用浏览器");
      return;
    }
    try {
      if (browserViewInstanceId) await closeEmbeddedBrowser();
      const hadBrowserSession = Boolean(browserSessionId);
      const opened = await openInteractiveBrowser(browserSessionUrl);
      const result = await bridge.readBrowserPage({ url: browserSessionUrl });
      const excerpt = result.result?.textExcerpt?.slice(0, 420) ?? result.error?.message ?? result.status;
      if (!hadBrowserSession) {
        setExtraMessages((current) => mergeTranscriptMessage(current, { id: `browser:${crypto.randomUUID()}`, role: "agent", body: `已打开受控浏览器会话（${opened.state.title || browserSessionUrl}）。\n页面读取结果：${excerpt}`, time: "刚刚", status: "completed" }));
      }
    } catch (error) {
      if (browserSessionState?.url) setBrowserSessionUrl(browserSessionState.url);
      setBrowserSessionError(error instanceof Error ? error.message : "浏览器打开失败");
      setRuntimeError(error instanceof Error ? error.message : "浏览器打开失败");
    }
  }

  async function openInteractiveBrowser(url: string) {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) throw new Error("请先打开本地项目后使用浏览器");
    const normalized = url.trim();
    if (!/^https?:\/\//i.test(normalized)) throw new Error("浏览器地址必须是 HTTP 或 HTTPS URL");
    setBrowserSessionError(null);
    const browserInstanceId = browserSessionId ?? `browser:${activeProjectId || "project"}`;
    const result = await bridge.openBrowserSession({
      opaqueDirectoryRef,
      browserInstanceId,
      url: normalized,
      allowExternal: true,
      allowedOrigins: INTERACTIVE_BROWSER_ORIGINS,
      layout: "side",
    });
    setBrowserSessionId(browserInstanceId);
    setBrowserSessionState(result.state);
    setBrowserSessionUrl(normalized);
    return result;
  }

  async function navigateInteractiveBrowser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !browserSessionId) return;
    try {
      setBrowserSessionError(null);
      const state = await bridge.navigateBrowserSession({ opaqueDirectoryRef, browserInstanceId: browserSessionId, url: browserSessionUrl.trim() });
      setBrowserSessionState(state);
    } catch (error) {
      if (browserSessionState?.url) setBrowserSessionUrl(browserSessionState.url);
      setBrowserSessionError(error instanceof Error ? error.message : "浏览器导航失败");
    }
  }

  async function controlInteractiveBrowser(action: 'back' | 'forward' | 'reload') {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !browserSessionId) return;
    try {
      setBrowserSessionError(null);
      const state = await bridge.controlBrowserSession({ opaqueDirectoryRef, browserInstanceId: browserSessionId, action });
      setBrowserSessionState(state);
      if (state.url) setBrowserSessionUrl(state.url);
    } catch (error) {
      setBrowserSessionError(error instanceof Error ? error.message : "浏览器控制失败");
    }
  }

  async function closeInteractiveBrowser() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef || !browserSessionId) return;
    try {
      await bridge.closeBrowserSession({ opaqueDirectoryRef, browserInstanceId: browserSessionId });
    } catch (error) {
      setBrowserSessionError(error instanceof Error ? error.message : "浏览器关闭失败");
    } finally {
      if (browserSessionState?.url) setBrowserSessionUrl(browserSessionState.url);
      setBrowserSessionId(null);
      setBrowserSessionState(null);
    }
  }

  async function requestMarketResearch() {
    const bridge = window.capybaraDesktop;
    if (!bridge || !opaqueDirectoryRef) {
      setRuntimeError("请先打开本地项目后运行市场研究");
      return;
    }
    setMarketResearchBusy(true);
    setRuntimeError(null);
    try {
      const researchRequest = {
        opaqueDirectoryRef,
        ticker: "000682",
        today: new Date().toISOString().slice(0, 10),
        reportUrls: [
          "https://static.cninfo.com.cn/finalpage/2026-04-24/1225161855.PDF",
          "https://static.cninfo.com.cn/finalpage/2025-04-23/1223215550.PDF",
          "https://static.cninfo.com.cn/finalpage/2024-04-19/1219670688.PDF",
        ],
      };
      let result = await bridge.runMarketResearch(researchRequest);
      const marketDataUnknown = result.status === "unknown" && result.steps.some((step) => step.step === "market_data" && step.status === "unknown");
      if (marketDataUnknown) {
        const fallbackToday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        result = await bridge.runMarketResearch({ ...researchRequest, today: fallbackToday });
      }
      rememberMarketResearch(result);
      const states = result.steps.map((step) => `${step.step}:${step.status}`).join(" · ");
      const summaryText = `000682 市场研究已完成：${states}${result.application?.address ? `。看板：${result.application.address}` : ""}`;
      const messageId = `market-research:${crypto.randomUUID()}`;
      const sessionId = runtimeSessionId ?? activeSessionIdStateForProject(localProject?.id ?? project.id, activeSessionId);
      if (sessionId) {
        try {
          await bridge.appendRuntimeMessage({ opaqueDirectoryRef, sessionId, role: "assistant", text: summaryText, id: messageId, requestId: messageId });
        } catch (error) {
          setRuntimeError(`研究已完成，但会话记录保存失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      setExtraMessages((current) => mergeTranscriptMessage(current, { id: messageId, role: "agent", body: summaryText, time: "刚刚", status: "completed" }));
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "市场研究失败");
    } finally {
      setMarketResearchBusy(false);
    }
  }

  async function pauseTask() {
    const bridge = window.capybaraDesktop;
    const sessionId = runtimeSessionId ?? activeSessionIdStateForProject(localProject?.id ?? "", activeSessionId);
    if (!bridge || !runtimeId || !sessionId) {
      setRuntimeError("当前没有可暂停的运行任务");
      return;
    }
    try {
      await bridge.sendRuntimeFrame({ runtimeId, frame: createRuntimeCommandFrame(sessionId, "run.cancel", {}, crypto.randomUUID()) });
      setRuntimeError(null);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "暂停请求发送失败");
    }
  }

  function handleMenuAction(label: string) {
    setOpenMenu(null);
    if (label === "打开项目") { void openLocalProject(); return; }
    if (label === "新会话") { void startNewSession(); return; }
    if (label === "项目应用") { setAppOpen((current) => { const next = !current; if (next) setActivityOpen(false); return next; }); return; }
    if (label === "项目侧栏") { setSidebarCollapsed((current) => !current); return; }
    if (label === "深色外观") {
      setDarkTheme((current) => {
        const next = !current;
        window.localStorage.setItem("capybara:dark-theme", String(next));
        return next;
      });
      return;
    }
    if (label === "关于概念稿") { setAboutOpen(true); return; }
    if (label === "进程管理" || label === "协作任务" || label === "本地运行与恢复") { setAppOpen(false); setActivityOpen(true); return; }
    if (label === "项目资源" || label === "设置") { setSettingsOpen(true); void loadProjectResources(opaqueDirectoryRef ?? undefined); return; }
    setRuntimeError(`${label}入口已保留，当前项目暂无可执行内容`);
  }

  function renderRegisteredProject(item: RegisteredProject) {
    const itemProject = localProject?.id === `local:${item.projectId}` ? localProject : localProjectFromRegistration(item);
    const active = itemProject.id === project.id;
    return <section className="wb-project-group" key={item.projectId}>
      <div className="wb-project-row-shell">
        <button className="wb-project-row" data-active={active} onClick={() => { setProjectOpenStatus({ kind: "selected", projectId: item.projectId, name: item.displayName, empty: item.isEmpty }); void openRegisteredProject(item); }}>
          <span className="wb-project-icon">●</span><span>{item.displayName}</span>
        </button>
        <button className="wb-project-menu-button" type="button" aria-label={`管理项目 ${item.displayName}`} aria-expanded={openProjectMenuId === item.projectId} onClick={() => setOpenProjectMenuId((current) => current === item.projectId ? null : item.projectId)}>
          <Icon name="down" size={13} />
        </button>
      </div>
      {openProjectMenuId === item.projectId && <div className="wb-project-menu"><button type="button" onClick={() => void closeRegisteredProject(item)}>关闭项目</button></div>}
      {active && <div className="wb-session-list">{itemProject.sessions.map((candidate) => <button className="wb-session-row" data-active={candidate.id === session.id} key={candidate.id} onClick={() => active && localProject?.id === itemProject.id ? void selectLocalSession(candidate.id) : void openRegisteredProject(item)}><span className="wb-session-title">{candidate.title}</span><span className="wb-session-meta">{statusLabel(candidate.status)} · {candidate.lastRun}</span></button>)}</div>}
    </section>;
  }

  return <main className={`wb-page${darkTheme ? " is-dark" : ""}`}><div className="wb-shell">
    <nav className="wb-menu-bar" aria-label="应用菜单"><div className="wb-window-nav" aria-label="导航历史"><button className="wb-window-nav-button" type="button" aria-label="后退" disabled={navigationIndex === 0} onClick={() => void navigateHistory(-1)}><Icon name="back" size={15} /></button><button className="wb-window-nav-button" type="button" aria-label="前进" disabled={navigationIndex >= navigationHistory.length - 1} onClick={() => void navigateHistory(1)}><Icon name="forward" size={15} /></button></div><div className="wb-menu-brand">C<span>·</span></div>{workbenchMenus.map((menu) => <div className="wb-menu" key={menu.label}><button className="wb-menu-trigger" onClick={() => setOpenMenu(openMenu === menu.label ? null : menu.label)} aria-expanded={openMenu === menu.label}>{menu.label}</button>{openMenu === menu.label && <div className="wb-menu-popup" role="menu">{menu.items.map((item) => <button key={item.label} role="menuitem" onClick={() => handleMenuAction(item.label)} disabled={item.disabled}><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}</button>)}</div>}</div>)}<span className={`wb-menu-title${browserSessionId || browserViewInstanceId ? " wb-menu-title-view-open" : ""}`}>{project.name}</span>{browserSessionId && <form className="wb-browser-session-toolbar" onSubmit={navigateInteractiveBrowser}><button type="button" aria-label="浏览器后退" onClick={() => void controlInteractiveBrowser("back")}><Icon name="back" size={13} /></button><button type="button" aria-label="浏览器前进" onClick={() => void controlInteractiveBrowser("forward")}> <Icon name="forward" size={13} /></button><button type="button" aria-label="浏览器刷新" onClick={() => void controlInteractiveBrowser("reload")}>↻</button><input aria-label="浏览器地址" value={browserSessionUrl} onChange={(event) => setBrowserSessionUrl(event.target.value)} /><button type="submit">打开</button><span className="wb-browser-session-state" title={browserSessionState?.title || browserSessionState?.url}>{browserSessionError || browserSessionState?.title || "浏览器"}</span><button className="wb-browser-close" type="button" onClick={() => void closeInteractiveBrowser()}>关闭浏览器</button><button className="wb-browser-close" type="button" onClick={() => void openDashboard()}>项目应用</button></form>}{browserViewInstanceId && !browserSessionId && <button className="wb-browser-close" type="button" onClick={() => void requestBrowserEntry()}>打开浏览器</button>}{browserViewInstanceId && <button className="wb-browser-close" type="button" onClick={() => void closeEmbeddedBrowser()}>关闭应用视图</button>}{browserViewInstanceId && applicationInstanceLive && <button className="wb-browser-stop" type="button" onClick={() => void stopProjectApplication()}>停止应用</button>}<span className="wb-menu-spacer" /><button className="wb-menu-quick-action" type="button" onClick={() => setAppOpen((current) => { const next = !current; if (next) setActivityOpen(false); return next; })}>项目应用</button><button className="wb-menu-quick-action" type="button" onClick={() => { setAppOpen(false); setActivityOpen(true); }}>上下文</button><span className="wb-menu-status">本地工作服务</span><div className="wb-window-controls" aria-label="窗口控制"><button type="button" aria-label="最小化" onClick={() => void window.capybaraDesktop?.minimizeWindow()}><Icon name="minimize" size={14} /></button><button type="button" aria-label="最大化" onClick={() => void window.capybaraDesktop?.toggleMaximizeWindow()}><Icon name="maximize" size={13} /></button><button type="button" aria-label="关闭" onClick={() => void window.capybaraDesktop?.closeWindow()}><Icon name="close" size={14} /></button></div></nav>
    <div className={`wb-workspace${sidebarCollapsed ? " sidebar-collapsed" : ""}`} data-app-open={appOpen}>
      <aside className={`wb-sidebar${sidebarCollapsed ? " is-collapsed" : ""}`} aria-label="项目与会话"><div className="wb-sidebar-header"><span className="wb-brand">Capybara<span className="wb-brand-dot">·</span></span><button className="wb-icon-button" aria-label={sidebarCollapsed ? "展开项目侧栏" : "收起项目侧栏"} onClick={() => setSidebarCollapsed((current) => !current)}><Icon name="menu" /></button></div><div className="wb-sidebar-tools"><button className="wb-new-session" onClick={() => void startNewSession()} disabled={newSessionBusy}><Icon name="plus" /><span>{newSessionBusy ? "创建中…" : "新会话"}</span><kbd>Ctrl N</kbd></button><button className="wb-new-session wb-open-project" type="button" onClick={() => void openLocalProject()}><Icon name="file" /><span>打开本地项目</span></button><label className="wb-search"><Icon name="search" /><input placeholder="搜索项目或会话" aria-label="搜索项目或会话" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)} /></label>{projectOpenStatus.kind === "opening" && <p className="wb-app-note">正在请求桌面目录选择…</p>}{projectOpenStatus.kind === "unavailable" && <p className="wb-app-note">{projectOpenStatus.message}</p>}{projectOpenStatus.kind === "cancelled" && <p className="wb-app-note">{projectOpenStatus.message}</p>}{projectOpenStatus.kind === "selected" && <p className="wb-app-note">已选择本地项目：{projectOpenStatus.name}{projectOpenStatus.empty ? " · 空目录，可开始工作" : " · 目录已登记"}</p>}</div><div className="wb-colleague"><span className="wb-eyebrow">AI 同事 · 本地工作服务</span><strong>{project.agent}</strong><p>{project.responsibility}</p></div><div className="wb-section-heading"><span>项目</span><small className="wb-count">{registeredProjects.length} 个项目</small></div><div className="wb-project-list">{filteredRegisteredProjects.map((item) => renderRegisteredProject(item))}{projectFilter.trim() && filteredRegisteredProjects.length === 0 && <p className="wb-app-note" role="status">未找到匹配的项目或会话</p>}</div><footer className="wb-sidebar-footer"><span className="wb-token-total">{project.tokenSummary}</span><span className="wb-token-note">当前项目 · 本地工作区</span></footer></aside>
      <section className="wb-main" aria-label="项目工作区"><header className="wb-thread-header"><button className="wb-icon-button" aria-label={sidebarCollapsed ? "展开项目侧栏" : "收起项目侧栏"} onClick={() => setSidebarCollapsed((current) => !current)}><Icon name="menu" /></button><div className="wb-thread-heading"><div className="wb-breadcrumb">{project.name} <span>/</span> 工作</div><h1 className="wb-thread-title">{session.title}</h1><div className="wb-object-strip"><span className="wb-object-label">职责</span><strong className="wb-object-value">{project.agent}</strong><span className="wb-object-label">目标</span><span className="wb-object-value">{project.description}</span><button className="wb-object-link" onClick={() => { setAppOpen(false); setActivityOpen(true); }}>查看运行上下文</button></div></div><button className="wb-header-action" onClick={() => setAppOpen((current) => { const next = !current; if (next) setActivityOpen(false); return next; })} aria-expanded={appOpen}><Icon name="file" />项目应用</button></header><div className="wb-control-bar"><span className="wb-status" data-state={activity.status?.loopStatus === "running" ? "running" : "waiting"}>{activity.status?.loopStatus === "running" ? "工作中" : statusLabel(session.status)}</span><span className="wb-meta">{session.subtitle}</span><span className="wb-control-spacer" /><button className="wb-text-action" onClick={() => { setAppOpen(false); setActivityOpen(true); }}>查看上下文</button><button className="wb-text-action" onClick={() => void pauseTask()} disabled={activity.status?.loopStatus !== "running"}>停止本轮</button></div>{showProgressStrip && progressLabel && <div className="wb-progress-strip" role="status" aria-live="polite" data-running={activity.status?.loopStatus === "running"}><span className="wb-progress-dot" /> <span>{progressLabel}</span></div>}<div className="wb-thread" ref={threadElement} onScroll={(event) => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}><div className="wb-thread-column"><p className="wb-thread-purpose">{project.description}</p><div className="wb-thread-date"><span>今天</span></div><div className="wb-message-list">{entries.map((entry) => <article className="wb-message" data-role={entry.author === "human" ? "user" : "agent"} key={entry.id}><div className="wb-message-label">{entry.author === "human" ? "你" : entry.title} · {entry.time}</div>{entry.author === "human" ? <p>{entry.body}</p> : <MessageBody text={entry.body} />}{entry.kind === "work" && entry.details && <div className="wb-work-card"><div className="wb-work-card-header"><span className="wb-work-card-title">运行依据</span><span className="wb-work-card-status">{entry.status === "done" ? "已完成" : "等待"}</span></div><ul>{entry.details.map((detail) => <li key={detail}>{detail}</li>)}</ul></div>}{entry.kind === "evidence" && <div className="wb-message-meta"><Icon name="link" size={12} />来源：{entry.source}</div>}</article>)}{extraMessages.map((message) => <article className="wb-message" data-role={message.role === "user" ? "user" : "agent"} key={message.id}><div className="wb-message-label">{message.role === "user" ? "你" : project.agent} · {message.time}</div>{message.role === "agent" && <TurnProgress rows={visibleRows.filter((row) => message.turnId && (row.turnId === message.turnId || row.parentTurnId === message.turnId))} running={["running", "streaming", "queued"].includes(message.status)} />}{message.role === "user" ? <p>{message.body}</p> : <MessageBody text={message.body === "（无文本内容）" ? (message.status === "completed" ? "" : "正在处理…") : message.body} />}</article>)}</div></div></div><div className="wb-composer-area"><div className="wb-composer-column">{activity.mcpInputs?.map(request => <McpInputForm key={request.id} request={request} onReply={replyToMcpInput} readUrl={readMcpInputUrl} openUrl={openMcpInputUrl} />)}<div className="wb-run-summary">{runtimeError ?? (activity.status?.loopStatus === "running" ? activity.status?.activity?.label : session.next)}</div><form className="wb-composer" onSubmit={submit}>{Boolean(activity.branchQuestions?.length) && <div className="wb-branch-reply"><label htmlFor="wb-reply-target">回复对象</label><select id="wb-reply-target" value={replyTarget?.id ?? ""} onChange={event => setReplyTargetId(event.target.value)}><option value="">选择待回复分支</option>{activity.branchQuestions?.map(question => <option key={question.id} value={question.id}>{question.taskLabels}</option>)}</select>{replyTarget && <p>{replyTarget.question}</p>}</div>}<textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && event.ctrlKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="告诉 AI 同事下一步要做什么，也可以生成应用和处理资料…" rows={2} /><div className="wb-composer-toolbar"><span className="wb-composer-hint">Ctrl + Enter 发送</span><button className="wb-send" type="submit" aria-label="发送" disabled={(!replyTarget && activity.status?.loopStatus === "running") || !draft.trim()}><Icon name="send" /></button></div></form><div className="wb-composer-caption">应用、文件与办事记录都可追溯到会话 <span>·</span> 用户工作区</div></div></div></section>
      {appOpen && application && <aside className="wb-app-panel" data-open="true" aria-label="项目应用">
        <header className="wb-panel-header"><div><span className="wb-eyebrow">项目应用</span><h2>{applicationRestoringForProject ? "正在恢复项目应用" : application.name}</h2></div><span className="wb-panel-count">{applicationRestoringForProject ? "恢复中" : application.version}</span><button className="wb-icon-button" onClick={() => setAppOpen(false)} aria-label="关闭项目应用">×</button></header>
        <nav className="wb-page-tabs" aria-label="应用页面">{[["overview", "总览"], ["plan", "内容与数据"], ["references", "资料来源"]].map(([id, label]) => <button className="wb-page-tab" data-active={appTab === id} key={id} onClick={() => setAppTab(id)}>{label}</button>)}</nav>
        <div className="wb-app-toolbar"><div className="wb-app-identity"><span className="wb-app-state">运行实例：{applicationRestoringForProject ? "恢复中" : applicationStatusLabel}</span><code className="wb-app-address">{applicationRestoringForProject ? "正在读取项目应用状态" : applicationInstanceLive ? applicationInstance?.browserUrl ?? "本地地址待分配" : (marketResearch?.application?.address ?? "本地地址待分配")}</code>{applicationInstanceLive && applicationInstance && !applicationRestoringForProject && <small className="wb-app-note">PID {applicationInstance.pid ?? "—"} · 端口 {applicationInstance.port} · {applicationInstance.health.status}</small>}<small className="wb-app-note">发布内容：{applicationRestoringForProject ? "恢复中" : applicationPublishLabel} · 嵌入视图：{applicationViewLabel}</small></div><div className="wb-app-controls"><span className="wb-app-layout-status" data-layout={applicationLayout}>布局：{applicationLayout === "full" ? "展开" : "侧栏"}</span><button onClick={() => void requestMarketResearch()} disabled={marketResearchBusy || applicationRestoringForProject || !opaqueDirectoryRef}>{marketResearchBusy ? "研究中…" : marketResearch ? "重新运行 000682 研究" : "运行 000682 市场研究"}</button><button onClick={requestApplicationControl} disabled={applicationRestoringForProject}>{applicationRestoringForProject ? "恢复中…" : marketResearch?.application?.address || applicationInstance?.status === "running" ? "打开应用" : "启动应用"}</button>{!applicationRestoringForProject && applicationInstance?.status === "running" && <button onClick={() => void stopProjectApplication()}>停止</button>}{!applicationRestoringForProject && applicationInstance && <button onClick={() => void restartProjectApplication()}>重启</button>}{!applicationRestoringForProject && applicationInstance?.status === "running" && <button onClick={() => void updateProjectApplication()}>更新</button>}{!applicationRestoringForProject && applicationRuntime?.versions && applicationRuntime.versions.length > 1 && <button onClick={() => void rollbackProjectApplication()}>回滚</button>}{!applicationRestoringForProject && applicationLayoutAvailable && <button aria-pressed={applicationLayout === "full"} onClick={() => void changeApplicationLayout("full")}>展开</button>}{!applicationRestoringForProject && applicationLayoutAvailable && <button aria-pressed={applicationLayout === "side"} onClick={() => void changeApplicationLayout("side")}>收起</button>}</div></div>
        <div className="wb-app-scroll"><section className="wb-app-card wb-session-communication-card"><div className="wb-app-card-header"><h3>会话通信</h3><p>应用和会话通过统一消息协议通信，消息会保存到当前项目。</p></div><div className="wb-session-communication-body"><div className="wb-session-directory-list">{(sessionDirectory?.items ?? []).map((item) => <div className="wb-session-directory-item" key={item.id}><div><strong>{item.name}</strong><small>{item.id.slice(-8)} · {item.status}</small></div><p>{item.role}：{item.description}</p></div>)}</div><label>目标会话<select value={sessionMessageTarget} onChange={(event) => setSessionMessageTarget(event.target.value)}><option value="">请选择会话</option>{(sessionDirectory?.items ?? []).filter((item) => item.id !== (runtimeSessionId ?? activeSessionId)).map((item) => <option value={item.id} key={item.id}>{item.name} · {item.role} · {item.id.slice(-8)}</option>)}</select></label><label>发送内容<input value={sessionMessageText} onChange={(event) => setSessionMessageText(event.target.value)} /></label><div className="wb-settings-actions"><button type="button" onClick={() => void sendSessionMessage(sessionMessageTarget, sessionMessageText)} disabled={sessionMessageBusy || !sessionMessageTarget}>{sessionMessageBusy ? "发送中…" : "发送到会话"}</button><button type="button" onClick={() => void sendSessionMessage(runtimeSessionId ?? activeSessionId, "hello", "application:" + project.id, true)} disabled={sessionMessageBusy || !(runtimeSessionId ?? activeSessionId)}>应用发送 hello</button></div>{sessionMessageResult && <p className="wb-settings-status" role="status">{sessionMessageResult}</p>}<p className="wb-app-note">当前目录：{sessionDirectory?.items.length ?? 0} 个会话 · 当前会话 {runtimeSessionId ?? activeSessionId}</p></div></section><p className="wb-app-note">应用内容由当前会话持续维护，所有资料都保留来源和版本。</p>{resourceStatus && <p className="wb-settings-status wb-app-feedback" role="status" aria-live="polite">{resourceStatus}</p>}{marketResearch && <section className="wb-research-card"><div className="wb-app-section-title"><span>{marketResearch.ticker} 研究闭环</span><strong>{marketResearch.status === "succeeded" ? "已完成" : marketResearch.status}</strong></div><p>{marketResearch.recommendation ? `建议立场：${marketResearch.recommendation.stance}（待人工审查）` : "尚未形成建议"}</p><p className="wb-app-note">{marketResearch.steps.map((step) => `${step.step}:${step.status}`).join(" · ")}</p>{marketResearch.recommendation?.rationale.map((item) => <p className="wb-app-note" key={item}>· {item}</p>)}</section>}{marketResearch?.application?.address && <p className="wb-app-note"><button className="wb-object-link" onClick={() => void openDashboard()}>打开 {marketResearch.ticker} 行情看板窗口</button></p>}<div className="wb-app-card"><div className="wb-app-card-header"><h3>{project.name}</h3><p>{project.description}</p></div><div className="wb-app-card-body">{applicationRestoringForProject ? <p className="wb-app-note">正在恢复项目应用状态，发布内容和研究结果将在读取完成后显示。</p> : application.blocks.filter((block) => appTab === "overview" || (appTab === "plan" ? block.kind === "list" : block.kind === "references")).map((block) => renderApplicationBlock(block, reviewProjectArtifact, verifyProjectArtifact, artifactReviewBusyId))}</div></div></div><footer className="wb-app-footer">{applicationRestoringForProject ? "恢复中" : application.version}<span> · </span><button className="wb-object-link" onClick={() => { setAppOpen(false); setActivityOpen(true); }}>查看运行差异</button></footer>
      </aside>}
                  {activityOpen && <aside className="wb-utility-panel" aria-label="当前渲染上下文">
        <header className="wb-panel-header"><div><span className="wb-eyebrow">上下文</span><h2>上下文文档</h2></div><button className="wb-icon-button" onClick={() => setActivityOpen(false)} aria-label="关闭渲染上下文">×</button></header>
        <div className="wb-utility-scroll">
          <section className="wb-utility-section" data-structured-context>
            <div className="wb-context-document-stack">
              <ContextDocumentCard workspaceId={project.id} defaultOpen label="项目上下文" view={activity.projectContextDocumentView} />
              <ContextDocumentCard workspaceId={project.id} label="会话上下文" view={activity.contextDocumentView} />
            </div>
            {activity.contextOrganization && <>
              <details className="wb-context-secondary"><summary><span>运行信号</span><small>cache · messages · system_prompt · runtime_state</small></summary>
                <div className="wb-context-variable-grid">{activity.contextOrganization.variables.filter(variable => variable.role !== "document").map(variable => (
                  <details className={`wb-context-variable wb-context-variable-${variable.name}`} key={variable.name}>
                    <summary><span className="wb-context-variable-name">{variable.name}</span><span className="wb-context-variable-meta">{variable.scope} · {variable.role}</span></summary>
                    <pre>{contextValue(variable.value, 12000)}</pre>
                  </details>
                ))}</div>
              </details>
              <details className="wb-context-secondary"><summary><span>整理记录</span><small>{activity.contextOrganization.informationUnits.length} units · {activity.contextOrganization.archiveRecords.length} archive</small></summary><details className="wb-context-data-card"><summary><span>informationUnits</span><small>{activity.contextOrganization.informationUnits.length} 条</small></summary><pre>{contextValue(activity.contextOrganization.informationUnits, 12000)}</pre></details><details className="wb-context-data-card"><summary><span>archiveRecords</span><small>{activity.contextOrganization.archiveRecords.length} 条</small></summary><pre>{contextValue(activity.contextOrganization.archiveRecords, 12000)}</pre></details></details>
            </>}
          </section>
          <details className="wb-context-secondary wb-context-render"><summary><span>渲染诊断</span><small>{activity.renderResult?.messages?.length ?? 0} 条消息</small></summary>
          <section className="wb-capability-card"><div className="wb-capability-header"><span>当前渲染</span><span>{activity.renderResult?.messages?.length ? `${activity.renderResult.messages.length} 条消息` : "尚未生成"}</span></div><div className="wb-capability-row"><span>模型</span><strong>{activity.status?.modelName || activity.status?.model || "—"}</strong></div><div className="wb-capability-row"><span>上下文范围</span><strong>{latestContextProjection?.scope || activity.contextScopes?.activeScope || "session"}</strong></div><div className="wb-capability-row"><span>文档修订</span><strong>{latestContextProjection?.documentRevision ?? activity.contextScopes?.session?.revision ?? "—"}</strong></div><div className="wb-capability-row"><span>模板 / 变量修订</span><strong>{activity.renderResult?.templateRevision ?? "—"} / {activity.renderResult?.variablesRevision ?? activity.variables?.revision ?? "—"}</strong></div><div className="wb-capability-row"><span>渲染时间</span><strong>{activity.renderResult?.renderedAt || "—"}</strong></div></section>
          </details>
          <details className="wb-context-secondary"><summary><span>文档序列化（回放）</span><small>project_context.md · session_context.md</small></summary><div className="wb-rendered-message-list"><details className="wb-rendered-message"><summary><span>project_context.md</span><small>{activity.projectContextDocumentMarkdown?.length ?? 0} 字符</small></summary><pre>{activity.projectContextDocumentMarkdown || "当前项目级文档为空。"}</pre></details><details className="wb-rendered-message"><summary><span>session_context.md</span><small>{activity.contextDocumentMarkdown?.length ?? 0} 字符</small></summary><pre>{activity.contextDocumentMarkdown || "当前会话文档为空。"}</pre></details></div></details>
          <details className="wb-context-secondary"><summary><span>渲染消息</span><small>{activity.renderResult?.messages?.length ?? 0} 条</small></summary>{activity.renderResult?.messages?.length ? <div className="wb-rendered-message-list">{activity.renderResult.messages.map((message, index) => <details className="wb-rendered-message" key={`${message.role}-${index}`}><summary><span>{message.role}{message.name ? ` · ${message.name}` : ""}</span><small>{message.content.length} 字符</small></summary><pre>{message.content}</pre>{message.toolCallId && <code>toolCallId: {message.toolCallId}</code>}</details>)}</div> : <p className="wb-app-note">当前会话还没有可显示的渲染消息。</p>}</details>
          <details className="wb-context-secondary"><summary><span>变量信息</span><small>{activity.variables?.value ? Object.keys(activity.variables.value).length : 0} 项</small></summary>{activity.variables?.value ? <div className="wb-variable-record-list">{Object.entries(activity.variables.value).map(([key, value]) => <details className="wb-variable-record" key={key}><summary><span>{key}</span><small>{contextValue(value, 120).length} 字符预览</small></summary><pre>{contextValue(value, 8000)}</pre></details>)}</div> : <p className="wb-app-note">当前会话没有返回变量快照。</p>}</details>
          <details className="wb-context-secondary"><summary><span>上下文来源与诊断</span><small>{activity.renderResult?.diagnostics?.length ?? 0} 条诊断</small></summary><div className="wb-capability-row"><span>来源消息游标</span><strong>{latestContextProjection?.sourceMessageCursor ?? "—"}</strong></div><div className="wb-capability-row"><span>来源信息条目</span><strong>{latestContextProjection?.sourceEntryIds?.length ?? 0} 条</strong></div><div className="wb-capability-row"><span>来源候选信息</span><strong>{latestContextProjection?.sourceCandidateIds?.length ?? 0} 条</strong></div><div className="wb-capability-row"><span>当前证据</span><strong>{activity.contextEvidence?.length ?? 0} 条</strong></div><div className="wb-capability-row"><span>有效上下文</span><strong>{activity.effectiveContexts?.items?.length ?? 0} 条</strong></div>{activity.renderResult?.diagnostics?.length ? <div className="wb-context-diagnostics">{activity.renderResult.diagnostics.map((item, index) => <div data-severity={item.severity || "info"} key={`${item.code || "diagnostic"}-${index}`}>{item.severity || "info"} · {item.code || "render"}：{item.message || "—"}</div>)}</div> : <p className="wb-app-note">没有渲染诊断。</p>}</details>
        </div>
      </aside>}
      {settingsOpen && <div className="wb-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}><section ref={settingsDialog} className="wb-settings-modal" role="dialog" aria-modal="true" aria-label="项目设置与资源"><header className="wb-panel-header"><div><span className="wb-eyebrow">项目控制面</span><h2>设置、提示词变量与资源</h2></div><button className="wb-icon-button" onClick={() => setSettingsOpen(false)} aria-label="关闭项目设置">×</button></header><div className="wb-settings-scroll">{resourceStatus && <p className="wb-settings-status" role="status">{resourceStatus}</p>}<section className="wb-settings-section"><h3>全局模型与密钥</h3><p className="wb-app-note">保存在系统用户 .capybara 中，应用于后续桌面会话；密钥不会回传到页面。</p><div className="wb-settings-grid"><label>提供方<input value={settingsDraft.provider} onChange={(event) => setSettingsDraft((current) => ({ ...current, provider: event.target.value }))} placeholder="openai / deepseek" /></label><label>模型<input value={settingsDraft.model} onChange={(event) => setSettingsDraft((current) => ({ ...current, model: event.target.value }))} placeholder="gpt-6-luna" /></label><label>协议<select value={settingsDraft.protocol} onChange={(event) => setSettingsDraft((current) => ({ ...current, protocol: event.target.value }))}><option value="responses">Responses</option><option value="chat-completions">Chat Completions</option></select></label><label>Base URL<input value={settingsDraft.base_url} onChange={(event) => setSettingsDraft((current) => ({ ...current, base_url: event.target.value }))} placeholder="https://api.openai.com/v1" /></label><label className="wb-settings-wide">API Key（仅写入本地密钥文件）<input type="password" value={settingsDraft.apiKey} onChange={(event) => setSettingsDraft((current) => ({ ...current, apiKey: event.target.value }))} placeholder={settings?.llm.api_key_configured ? "已配置，输入新密钥可替换" : "输入 API Key"} /></label></div><div className="wb-settings-actions"><button onClick={() => void saveProjectSettings()} disabled={resourceBusy || !settings || activity.status?.loopStatus === "running"}>{resourceBusy ? "保存中…" : "保存模型设置"}</button><span className="wb-app-note">{settings ? (settings.llm.api_key_configured ? "全局密钥已配置" : "全局密钥未配置") : "尚未读取模型配置"}</span></div></section><section className="wb-settings-section"><h3>系统提示词变量</h3>{systemVariables.filter((variable) => variable.source !== "builtin" && !variable.readonly).map((variable) => <label className="wb-variable-row" key={variable.key}><span>{variable.label || variable.key}<small>{variable.key}</small></span><textarea defaultValue={typeof variable.value === "string" ? variable.value : JSON.stringify(variable.value, null, 2)} rows={2} onBlur={(event) => void saveSystemVariable(variable, event.target.value)} /></label>)}{systemVariables.filter((variable) => variable.source !== "builtin" && !variable.readonly).length === 0 && <p className="wb-app-note">当前没有可编辑变量。</p>}</section><section className="wb-settings-section"><h3>安装 Skill</h3><div className="wb-settings-grid"><label>GitHub 仓库<input value={skillRepo} onChange={(event) => setSkillRepo(event.target.value)} placeholder="owner/repo" /></label><label>Skill 路径<input value={skillPath} onChange={(event) => setSkillPath(event.target.value)} placeholder="skills/example" /></label><label className="wb-settings-wide">预览返回的完整 commit<input value={skillCommit} onChange={(event) => setSkillCommit((event.target.value))} placeholder="先点击预览获取 commit" /></label></div><div className="wb-settings-actions"><button onClick={() => void previewSkill()} disabled={resourceBusy || !opaqueDirectoryRef}>预览 Skill</button><button onClick={() => void installSkill()} disabled={resourceBusy || !skillCommit}>安装 Skill</button></div></section><section className="wb-settings-section"><h3>安装工具插件</h3><div className="wb-settings-actions"><input value={pluginSource} onChange={(event) => setPluginSource(event.target.value)} placeholder="项目内插件目录，例如 plugins/stock-tools" /><button onClick={() => void installPlugin()} disabled={resourceBusy || !opaqueDirectoryRef}>预览并安装插件</button></div></section><section className="wb-settings-section"><h3>已安装工具与 Skills</h3>{visibleCatalogItems.map((item) => <div className="wb-utility-row" key={item.id}><span>{item.name ?? item.id} · {item.kind}{item.source ? ` · ${item.source}` : ""} · 来源：{resourceOriginLabel(item.source)}</span><strong>{item.enabled === false ? "已停用" : "已安装"}</strong></div>)}{visibleCatalogItems.length === 0 && <p className="wb-app-note">项目资源目录为空，可通过 Agent 安装工具或 Skill。</p>}<p className="wb-app-note">目录修订：{catalog?.revision ?? "尚未读取"}</p></section></div></section></div>}
      {aboutOpen && <div className="wb-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAboutOpen(false); }}><section className="wb-settings-modal wb-about-modal" role="dialog" aria-modal="true" aria-label="关于概念稿"><header className="wb-panel-header"><div><span className="wb-eyebrow">Capybara Workbench</span><h2>关于概念稿</h2></div><button className="wb-icon-button" onClick={() => setAboutOpen(false)} aria-label="关闭关于窗口">×</button></header><div className="wb-settings-scroll"><p>这是本地工作型 Agent 的产品概念稿。项目、会话、运行轨迹和项目应用都由桌面运行时统一托管。</p><p className="wb-app-note">当前版本优先验证项目协作、工具调用可追溯性和内嵌应用运行能力。</p></div></section></div>}
    </div>
  </div></main>;
}
