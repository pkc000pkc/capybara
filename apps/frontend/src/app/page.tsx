"use client";

import {
  Check,
  ChevronDown,
  Database,
  Eye,
  EyeOff,
  FolderPlus,
  FolderOpen,
  FolderX,
  PencilLine,
  Plus,
  Square,
  Trash2,
  X,
} from "lucide-react";
import CodeSurface from "./components/code-surface";
import ContextWorkspace from "./components/context-workspace";
import CapybaraLogo from "./components/capybara-logo";
import DebugControlPanel from "./components/debug-control-panel";
import ResizeHandle from "./components/resize-handle";
import ExperimentsWorkspace from "./components/experiments-workspace";
import MarkdownContent from "./components/markdown-content";
import {
  PanelHeader,
  WorkspaceTabs,
  type WorkspaceTab,
} from "./components/workspace-ui";
import ResourcesWorkspace, {
  type ResourceSection,
} from "./components/resources-workspace";
import { I18nProvider, useI18n, type Locale } from "./i18n";
import {
  type RuntimeVariables,
  type RuntimeVariablePath,
} from "./runtime-context";
import { RuntimeProvider, useRuntime } from "./runtime-websocket";
import {
  UserPreferencesProvider,
  useUserPreferences,
  type ColorTheme as ThemeMode,
} from "./user-preferences";
import type {
  JsonValue,
  RuntimeObservationsState,
  RuntimeStatusState,
} from "./runtime-protocol";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

const DIVIDER_SIZE = 1;
const CONTEXT_MIN_WIDTH = 220;
const CONVERSATION_MIN_WIDTH = 280;
const PROGRAM_MIN_WIDTH = 260;
const VARIABLES_MIN_HEIGHT = 180;
const CONTROLS_MIN_HEIGHT = 160;
const CONTEXT_DEFAULT_WIDTH = 320;
const PROGRAM_DEFAULT_WIDTH = 380;
const VARIABLES_DEFAULT_HEIGHT = 340;
const APP_VIEWS = ["runtime", "resources", "experiments", "recall"] as const;

type AppView = (typeof APP_VIEWS)[number];

function useThemeMode() {
  const { color_theme: mode, setColorTheme: selectMode } = useUserPreferences();

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = mode === "system" ? (media.matches ? "dark" : "light") : mode;
      document.documentElement.dataset.themeMode = mode;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.style.colorScheme = resolved;
    };

    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [mode]);

  return { mode, selectMode };
}

function ThemeSwitcher({
  mode,
  onChange,
}: {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}) {
  const { t } = useI18n();

  return (
    <div aria-label={t("theme.label")} className="theme-switcher" role="group">
      {(["light", "dark", "system"] as const).map((item) => (
        <button
          aria-pressed={mode === item}
          className="theme-option"
          data-active={mode === item ? "true" : "false"}
          key={item}
          onClick={() => onChange(item)}
          type="button"
        >
          {item === "light"
            ? t("theme.light")
            : item === "dark"
              ? t("theme.dark")
              : t("theme.system")}
        </button>
      ))}
    </div>
  );
}

function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();

  return (
    <label className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-4 border-b border-[#dce5e5] py-2.5">
      <span className="text-[10px] font-semibold text-[#536d72]">{t("language.label")}</span>
      <span className="language-switcher justify-self-start">
        <select
          aria-label={t("language.label")}
          onChange={(event) => setLocale(event.target.value as Locale)}
          value={locale}
        >
          <option value="zh-CN">{t("language.zh")}</option>
          <option value="en">{t("language.en")}</option>
        </select>
      </span>
    </label>
  );
}

function ProjectSessionSettings() {
  const { t } = useI18n();
  const runtime = useRuntime();
  const { refreshSessionStorage } = runtime;

  useEffect(() => {
    void refreshSessionStorage();
  }, [refreshSessionStorage]);

  const clearSessions = () => {
    if (!window.confirm(t("sessions.clearConfirm"))) return;
    void runtime.clearSessions();
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  };

  return (
    <section aria-labelledby="session-storage-heading">
      <h3 className="text-[10px] font-semibold uppercase text-[#6a7e82]" id="session-storage-heading">
        {t("sessions.storage")}
      </h3>
      <div className="mt-2 flex max-w-sm items-center justify-between border-y border-[#dce5e5] py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <Database aria-hidden="true" className="shrink-0 text-[#537277]" size={14} />
          <div className="min-w-0">
            <p className="font-mono text-xs text-[#29484c]">
              {runtime.sessionStorage ? formatBytes(runtime.sessionStorage.bytes) : "--"}
            </p>
            <p className="text-[9px] text-[#718488]">
              {t("sessions.count", { count: runtime.sessionStorage?.sessionCount ?? runtime.sessions.length })}
            </p>
          </div>
        </div>
        <button
          className="flex h-7 items-center gap-1.5 px-2 text-[10px] font-semibold text-[#843d3d] outline-none hover:bg-[#f4e5e5] focus-visible:ring-2 focus-visible:ring-[#9b4141] disabled:cursor-not-allowed disabled:text-[#a9b9b9]"
          disabled={!runtime.sessionStorage?.sessionCount}
          onClick={clearSessions}
          type="button"
        >
          <Trash2 aria-hidden="true" size={12} />
          {t("sessions.clear")}
        </button>
      </div>
    </section>
  );
}

function ApplicationPreferences({
  themeMode,
  onThemeModeChange,
}: {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
}) {
  const { t } = useI18n();

  return (
    <section aria-labelledby="interface-settings-heading">
        <h3 className="text-[10px] font-semibold uppercase text-[#6a7e82]" id="interface-settings-heading">
          {t("resources.interfaceSettings")}
        </h3>
        <div className="mt-2 max-w-sm">
          <LanguageSwitcher />
          <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center gap-4 py-2.5">
            <span className="text-[10px] font-semibold text-[#536d72]">{t("theme.label")}</span>
            <ThemeSwitcher mode={themeMode} onChange={onThemeModeChange} />
          </div>
        </div>
    </section>
  );
}

function ProjectSelector() {
  const { t } = useI18n();
  const runtime = useRuntime();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(runtime.project?.path ?? "");
  const [pendingProject, setPendingProject] = useState<{ path: string; name: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = Boolean(runtime.snapshot && ![
    "idle", "ready", "completed", "failed", "cancelled", "interrupted",
  ].includes(runtime.snapshot.run.status));

  const select = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      const result = await runtime.selectProject(path);
      if (result.status === "initialization-required") {
        setPendingProject(result.project);
        setError(null);
        return;
      }
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const close = () => {
    setOpen(false);
    setPendingProject(null);
    setError(null);
  };

  const initialize = async () => {
    if (!pendingProject) return;
    setSubmitting(true);
    try {
      await runtime.selectProject(pendingProject.path, true);
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const editPath = () => {
    setPendingProject(null);
    setError(null);
  };

  const closeProject = async () => {
    setClosing(true);
    setError(null);
    try {
      await runtime.closeProject();
      setPath("");
      close();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setClosing(false);
    }
  };

  const openSelector = () => {
    if (!open) {
      setPath(runtime.project?.path ?? "");
      setPendingProject(null);
      setError(null);
    }
    setOpen((current) => !current);
  };

  return (
    <div className="relative min-w-0">
      <button
        aria-expanded={open}
        className="flex h-7 max-w-[240px] items-center gap-1.5 px-1.5 text-left text-[11px] font-semibold text-[#29484c] outline-none hover:bg-[#e8f0ef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-not-allowed disabled:text-[#9aa9ab]"
        disabled={busy}
        onClick={openSelector}
        title={runtime.project?.path ?? t("project.select")}
        type="button"
      >
        <FolderOpen aria-hidden="true" className="shrink-0" size={13} />
        <span className="truncate">{runtime.project?.name ?? t("project.select")}</span>
        <ChevronDown aria-hidden="true" className="shrink-0" size={11} />
      </button>
      {open && (
        <form
          className="absolute left-0 top-8 z-50 grid w-[min(480px,calc(100vw-24px))] gap-2 border border-[#91aaa9] bg-white p-3 shadow-[0_10px_24px_rgba(24,39,44,0.18)]"
          onSubmit={select}
        >
          {pendingProject ? (
            <>
              <div className="flex items-start gap-2 border-b border-[#dce5e5] pb-2">
                <FolderPlus aria-hidden="true" className="mt-0.5 shrink-0 text-[#0c766e]" size={16} />
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold text-[#29484c]">{t("project.emptyTitle")}</p>
                  <p className="mt-1 text-[10px] leading-4 text-[#60777a]">{t("project.emptyDescription", { name: pendingProject.name })}</p>
                </div>
              </div>
              <code className="block truncate border border-[#d7e1e0] bg-[#f6f9f8] px-2 py-1.5 font-mono text-[9px] text-[#49656a]" title={pendingProject.path}>{pendingProject.path}</code>
              {error && <p className="text-[10px] text-[#843d3d]">{error}</p>}
              <div className="flex justify-end gap-2">
                <button className="h-7 px-2 text-[10px] text-[#536d72] hover:bg-[#edf3f2]" disabled={submitting} onClick={editPath} type="button">{t("project.back")}</button>
                <button className="h-7 bg-[#0c766e] px-3 text-[10px] font-semibold text-white hover:bg-[#095f59] disabled:bg-[#a9b9b9]" disabled={submitting} onClick={() => void initialize()} type="button">{submitting ? t("project.initializing") : t("project.initialize")}</button>
              </div>
            </>
          ) : (
            <>
              <label className="grid gap-1 text-[10px] font-semibold text-[#536d72]">
                {t("project.path")}
                <input
                  autoFocus
                  className="h-8 border border-[#c6d4d4] bg-white px-2 font-mono text-[11px] font-normal text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]"
                  disabled={submitting}
                  onChange={(event) => { setPath(event.target.value); setError(null); }}
                  value={path}
                />
              </label>
              {error && <p className="text-[10px] text-[#843d3d]">{error}</p>}
              <div className="flex items-center justify-between gap-2">
                <button
                  className="flex h-7 items-center gap-1 px-2 text-[10px] font-semibold text-[#843d3d] hover:bg-[#f8ecec] disabled:cursor-not-allowed disabled:text-[#b9a3a3]"
                  disabled={!runtime.project || submitting || closing}
                  onClick={() => void closeProject()}
                  title={t("project.closeDescription")}
                  type="button"
                >
                  <FolderX aria-hidden="true" size={13} />
                  {closing ? t("project.closing") : t("project.close")}
                </button>
                <div className="flex gap-2">
                  <button className="h-7 px-2 text-[10px] text-[#536d72] hover:bg-[#edf3f2]" disabled={submitting || closing} onClick={close} type="button">{t("project.cancel")}</button>
                  <button className="h-7 bg-[#0c766e] px-3 text-[10px] font-semibold text-white hover:bg-[#095f59] disabled:bg-[#a9b9b9]" disabled={!path.trim() || submitting || closing} type="submit">{t("project.open")}</button>
                </div>
              </div>
            </>
          )}
        </form>
      )}
    </div>
  );
}

function ConversationPanel({
  onSelectRequest,
  selectedRequestId,
}: {
  onSelectRequest: (requestId: string) => void;
  selectedRequestId: string | null;
}) {
  const { t } = useI18n();
  const runtime = useRuntime();
  const { cancelResponse, connection, sendChatMessage, snapshot } = runtime;
  const [draft, setDraft] = useState("");
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState("");
  const [savingSessionName, setSavingSessionName] = useState(false);
  const messageEndRef = useRef<HTMLDivElement>(null);
  const messages = snapshot?.conversation.messages;
  const requestSelectionLocked = Boolean(snapshot && ![
    "idle", "ready", "completed", "failed", "cancelled", "interrupted",
  ].includes(snapshot.run.status));

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const submitDraft = () => {
    const content = draft.trim();

    if (!content || connection !== "connected") return;

    sendChatMessage(content);
    setDraft("");
  };

  const sendMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitDraft();
  };

  const startRenamingSession = () => {
    if (!runtime.activeSession) return;
    setSessionName(runtime.activeSession.name);
    setRenamingSessionId(runtime.activeSession.id);
  };

  const cancelRenamingSession = () => {
    setRenamingSessionId(null);
    setSessionName("");
  };

  const saveSessionName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sessionName.trim() || savingSessionName) return;
    setSavingSessionName(true);
    try {
      await runtime.renameSession(sessionName);
      cancelRenamingSession();
    } catch {
      // The runtime error indicator exposes the backend validation message.
    } finally {
      setSavingSessionName(false);
    }
  };

  const isRenamingSession = renamingSessionId === runtime.activeSession?.id;

  return (
    <section
      aria-labelledby="conversation-heading"
      className="grid min-h-0 min-w-0 grid-rows-[34px_1fr_auto] bg-white"
      id="conversation-panel"
    >
      <PanelHeader
        actions={(
          <div className="flex items-center gap-1">
            {isRenamingSession ? (
              <form className="flex h-6 items-center" onSubmit={(event) => void saveSessionName(event)}>
                <input
                  aria-label={t("sessions.name")}
                  autoFocus
                  className="h-6 w-32 border border-[#0c766e] bg-white px-1.5 text-[10px] text-[#29484c] outline-none focus:ring-1 focus:ring-inset focus:ring-[#0c766e]"
                  disabled={savingSessionName}
                  maxLength={80}
                  onChange={(event) => setSessionName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") cancelRenamingSession();
                  }}
                  placeholder={t("sessions.namePlaceholder")}
                  value={sessionName}
                />
                <button
                  aria-label={t("sessions.saveName")}
                  className="flex h-6 w-6 items-center justify-center text-[#0c766e] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:text-[#a9b9b9]"
                  disabled={!sessionName.trim() || savingSessionName}
                  title={t("sessions.saveName")}
                  type="submit"
                >
                  <Check aria-hidden="true" size={13} />
                </button>
                <button
                  aria-label={t("sessions.cancelRename")}
                  className="flex h-6 w-6 items-center justify-center text-[#60777a] outline-none hover:bg-[#e9efef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:text-[#a9b9b9]"
                  disabled={savingSessionName}
                  onClick={cancelRenamingSession}
                  title={t("sessions.cancelRename")}
                  type="button"
                >
                  <X aria-hidden="true" size={13} />
                </button>
              </form>
            ) : (
              <>
                <select
                  aria-label={t("sessions.select")}
                  className="h-6 max-w-44 border border-[#c5d4d3] bg-white px-1.5 text-[10px] text-[#35555a] outline-none focus:border-[#0c766e] disabled:text-[#9aa9ab]"
                  disabled={requestSelectionLocked || !runtime.activeSession}
                  onChange={(event) => runtime.selectSession(event.target.value)}
                  value={runtime.activeSession?.id ?? ""}
                >
                  {runtime.sessions.map((session) => (
                    <option key={session.id} value={session.id}>{session.name}</option>
                  ))}
                </select>
                <button
                  aria-label={t("sessions.rename")}
                  className="flex h-6 w-6 items-center justify-center text-[#45666a] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-not-allowed disabled:text-[#a9b9b9]"
                  disabled={requestSelectionLocked || !runtime.activeSession}
                  onClick={startRenamingSession}
                  title={t("sessions.rename")}
                  type="button"
                >
                  <PencilLine aria-hidden="true" size={12} />
                </button>
              </>
            )}
            <button
              aria-label={t("sessions.new")}
              className="flex h-6 w-6 items-center justify-center text-[#45666a] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-not-allowed disabled:text-[#a9b9b9]"
              disabled={requestSelectionLocked || !runtime.project}
              onClick={() => void runtime.createSession()}
              title={t("sessions.new")}
              type="button"
            >
              <Plus aria-hidden="true" size={13} />
            </button>
          </div>
        )}
        title={t("chat.title")}
        titleId="conversation-heading"
      />

      <div
        aria-live="polite"
        className="minimal-scrollbar min-h-0 overflow-y-auto px-5 py-6"
        role="log"
      >
        <div className="mx-auto flex w-full max-w-[760px] flex-col gap-7">
          <article className="min-w-0">
            <div className="mb-3 flex items-center gap-2">
              <span className="text-sm font-semibold text-[#173b40]">
                capybara
              </span>
              <span className="border border-[#b8d5d1] bg-[#edf7f5] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#17675f]">
                {t("chat.aiGenerated")}
              </span>
            </div>
            <details className="group mb-4 border-l-2 border-[#9bbdb9] pl-3">
              <summary className="cursor-pointer select-none text-xs font-medium text-[#587176] outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e] focus-visible:ring-offset-2">
                {t("chat.thinking")}
              </summary>
              <p className="mt-2 text-xs leading-5 text-[#65797d]">
                {t("chat.initialThinking")}
              </p>
            </details>
            <div className="text-sm leading-7 text-[#22373b]">
              {t("chat.welcome")}
            </div>
          </article>
          {messages?.map((message) =>
            message.role === "user" ? (
              <article className="flex justify-end" key={message.id}>
                <div className="max-w-[82%] rounded-lg bg-[#e8f2f0] px-4 py-3 text-sm leading-6 text-[#19383d]">
                  {message.content.map((part) => part.text).join("\n")}
                </div>
              </article>
            ) : (
              <article className="min-w-0" key={message.id}>
                <button
                  aria-label={message.requestId
                    ? t("sessions.selectRequest", { request: message.requestId })
                    : undefined}
                  aria-pressed={message.requestId ? selectedRequestId === message.requestId : undefined}
                  className={`mb-3 flex max-w-full items-center gap-2 border-l-2 px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-default ${
                    selectedRequestId === message.requestId
                      ? "border-l-[#0c766e] bg-[#edf6f4]"
                      : "border-l-transparent hover:bg-[#f0f5f4]"
                  }`}
                  disabled={!message.requestId || requestSelectionLocked}
                  onClick={() => message.requestId && onSelectRequest(message.requestId)}
                  title={message.requestId}
                  type="button"
                >
                  <span className="text-sm font-semibold text-[#173b40]">
                    capybara
                  </span>
                  <span className="border border-[#b8d5d1] bg-[#edf7f5] px-1.5 py-0.5 text-[10px] font-semibold uppercase text-[#17675f]">
                    {t("chat.aiGenerated")}
                  </span>
                  {message.requestId && (
                    <span className="truncate font-mono text-[8px] text-[#718488]">
                      {message.requestId.slice(-8)}
                    </span>
                  )}
                </button>

                <details className="group mb-4 border-l-2 border-[#9bbdb9] pl-3">
                  <summary className="cursor-pointer select-none text-xs font-medium text-[#587176] outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e] focus-visible:ring-offset-2">
                    {t("chat.thinking")}
                    {message.status === "streaming" && (
                      <span className="motion-safe:animate-pulse"> ...</span>
                    )}
                  </summary>
                  <p className="mt-2 text-xs leading-5 text-[#65797d]">
                    {message.thinkingSummary || t("chat.pendingThinking")}
                  </p>
                </details>

                {message.status === "streaming" &&
                !message.content.map((part) => part.text).join("") ? (
                  <p className="text-sm text-[#65797d]">
                    {t("chat.generating")}
                  </p>
                ) : (
                  <MarkdownContent
                    source={message.content.map((part) => part.text).join("\n")}
                    variant="conversation"
                  />
                )}
                {message.status === "streaming" && (
                  <button
                    aria-label={t("chat.stop")}
                    className="mt-3 inline-flex h-7 w-7 items-center justify-center text-[#9b4141] outline-none hover:bg-[#f4e5e5] focus-visible:ring-2 focus-visible:ring-[#0c766e]"
                    onClick={() => cancelResponse(message.id)}
                    title={t("chat.stop")}
                    type="button"
                  >
                    <Square aria-hidden="true" size={13} strokeWidth={1.8} />
                  </button>
                )}
              </article>
            ),
          )}
          <div ref={messageEndRef} />
        </div>
      </div>

      <div className="border-t border-[#e2e8e9] bg-[#fbfcfc] p-4">
        <form
          className="mx-auto flex w-full max-w-[760px] items-end gap-2 rounded-lg border border-[#b9c9cc] bg-white p-2 shadow-[0_4px_16px_rgba(23,45,51,0.07)] focus-within:border-[#408d86] focus-within:ring-2 focus-within:ring-[#b8e4de]"
          onSubmit={sendMessage}
        >
          <CodeSurface
            ariaLabel={t("chat.input")}
            className="code-surface-composer max-h-40 min-h-11 flex-1"
            height="content"
            language="Markdown"
            lineNumbers={false}
            lineWrapping
            maxHeight="160px"
            minHeight="44px"
            onChange={setDraft}
            onSubmit={submitDraft}
            placeholder={t("chat.placeholder")}
            statusBar={false}
            value={draft}
          />
          <button
            className="h-10 shrink-0 rounded-md bg-[#0c766e] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#095f59] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-[#a9b9b9]"
            disabled={!draft.trim() || connection !== "connected"}
            type="submit"
          >
            {t("chat.send")}
          </button>
        </form>
      </div>
    </section>
  );
}

type VariableValueProps = {
  name: string;
  type: string;
  value: string;
  path: RuntimeVariablePath;
  kind?: "string" | "json";
  depth?: number;
  onInspect: (
    path: RuntimeVariablePath,
    name: string,
    value: string,
    kind: "string" | "json",
  ) => void;
};

function valueType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "Array";
  if (typeof value === "object") return "Object";
  return typeof value;
}

function VariableNode({
  name,
  value,
  path,
  depth,
  onInspect,
}: {
  name: string;
  value: JsonValue;
  path: RuntimeVariablePath;
  depth: number;
  onInspect: VariableValueProps["onInspect"];
}) {
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    return (
      <details open={depth < 2}>
        <summary
          className="flex min-h-7 cursor-pointer select-none items-center gap-2 border-b border-[#dfe7e7] pr-2 text-xs text-[#28454a] outline-none hover:bg-[#e3efed] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <span>{name}</span>
          <span className="truncate font-mono text-[11px] text-[#72868a]">
            {valueType(value)} {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
          </span>
        </summary>
        {entries.map(([key, child]) => (
          <VariableNode
            depth={depth + 1}
            key={key}
            name={Array.isArray(value) ? `[${key}]` : key}
            onInspect={onInspect}
            path={[...path, key]}
            value={child}
          />
        ))}
      </details>
    );
  }

  return (
    <VariableValue
      depth={depth}
      kind={typeof value === "string" ? "string" : "json"}
      name={name}
      onInspect={onInspect}
      path={path}
      type={valueType(value)}
      value={typeof value === "string" ? value : JSON.stringify(value)}
    />
  );
}

function VariableValue({
  name,
  type,
  value,
  path,
  kind = "string",
  depth = 0,
  onInspect,
}: VariableValueProps) {
  const { t } = useI18n();
  return (
    <div
      className="grid min-h-7 grid-cols-[minmax(72px,auto)_1fr] items-center gap-2 border-b border-[#dfe7e7] pr-2 text-xs hover:bg-[#e3efed]"
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      <span className="truncate text-[#28454a]">{name}</span>
      <button
        className="min-w-0 truncate text-left font-mono text-[11px] text-[#76531b] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
        onClick={() => onInspect(path, name, value, kind)}
        title={t("inspector.viewValue", { name })}
        type="button"
      >
        <span className="mr-1 text-[#72868a]">{type}</span>
        {value}
      </button>
    </div>
  );
}

function VariableStatusPanel({
  artifactContents,
  canEditVariables,
  connection,
  observations,
  onGetArtifact,
  runtimeVariables,
  runtimeStatus,
  onVariableChange,
}: {
  artifactContents: Record<string, JsonValue>;
  canEditVariables: boolean;
  connection: "connecting" | "connected" | "reconnecting" | "disconnected";
  observations: RuntimeObservationsState;
  onGetArtifact: (artifactId: string) => void;
  runtimeVariables: RuntimeVariables;
  runtimeStatus: RuntimeStatusState;
  onVariableChange: (path: RuntimeVariablePath, value: unknown) => void;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<"variables" | "observations" | "status">(
    "variables",
  );
  const [detail, setDetail] = useState<{
    path: RuntimeVariablePath;
    name: string;
    value: string;
    kind: "string" | "json";
  } | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showSystemVariables, setShowSystemVariables] = useState(true);
  const [selectedObservationId, setSelectedObservationId] = useState<string | null>(null);
  const selectedObservation = observations.items.find(
    (item) => item.id === selectedObservationId,
  );

  useEffect(() => {
    const artifactId = selectedObservation?.resultArtifactId;
    if (artifactId && !(artifactId in artifactContents)) onGetArtifact(artifactId);
  }, [artifactContents, onGetArtifact, selectedObservation?.resultArtifactId]);

  const selectTab = (tab: "variables" | "observations" | "status") => {
    setActiveTab(tab);
    setDetail(null);
    setSelectedObservationId(null);
  };

  const inspectValue = (
    path: RuntimeVariablePath,
    name: string,
    value: string,
    kind: "string" | "json",
  ) => {
    setDetail({ path, name, value, kind });
    setDetailError(null);
  };

  const applyDetail = () => {
    const sharedVariable = detail !== null && detail.path[0] === "builtin" &&
      detail.path[1] === "prompts" &&
      typeof detail.path[2] === "string" &&
      (runtimeVariables.builtin.shared_prompts ?? []).includes(detail.path[2]);
    if (
      !detail ||
      detail.path[0] === "tools" ||
      (detail.path[0] === "builtin" && !sharedVariable) ||
      (!canEditVariables && !sharedVariable)
    ) {
      return;
    }

    try {
      const nextValue =
        detail.kind === "json" ? JSON.parse(detail.value) : detail.value;
      onVariableChange(detail.path, nextValue);
      setDetail(null);
      setDetailError(null);
    } catch {
      setDetailError(t("inspector.invalidJson"));
    }
  };

  const canEditDetail =
    detail?.path[0] !== "tools" &&
    (canEditVariables || (
      detail?.path[0] === "builtin" &&
      detail.path[1] === "prompts" &&
      typeof detail.path[2] === "string" &&
      (runtimeVariables.builtin.shared_prompts ?? []).includes(detail.path[2])
    )) &&
    (detail?.path[0] !== "builtin" || (
      detail.path[1] === "prompts" &&
      typeof detail.path[2] === "string" &&
      (runtimeVariables.builtin.shared_prompts ?? []).includes(detail.path[2])
    ));
  const statusRows = [
    [
      t("status.runtime"),
      connection === "connected" && runtimeStatus.runtime === "healthy"
        ? t("status.normal")
        : t("status.disconnected"),
      t("status.now"),
      connection === "connected" && runtimeStatus.runtime === "healthy"
        ? "bg-[#25806f]"
        : "bg-[#9b4141]",
    ],
    [
      t("status.model"),
      runtimeStatus.model === "ready"
        ? t("status.ready")
        : runtimeStatus.model === "busy"
          ? t("status.busy")
          : t("status.disconnected"),
      t("status.now"),
      runtimeStatus.model === "ready" ? "bg-[#25806f]" : "bg-[#c58a27]",
    ],
    [
      t("status.context"),
      `${Math.round(runtimeStatus.context.utilization * 100)}%`,
      t("status.now"),
      "bg-[#c58a27]",
    ],
    [
      t("status.messages"),
      String(runtimeStatus.messageCount ?? 0),
      t("status.now"),
      "bg-[#25806f]",
    ],
    [
      t("status.queue"),
      runtimeStatus.queueDepth === 0
        ? t("status.idle")
        : String(runtimeStatus.queueDepth),
      t("status.now"),
      "bg-[#6b858b]",
    ],
    ...(runtimeStatus.variableTokens ?? []).map((variable) => [
      variable.label === variable.key
        ? variable.key
        : `${variable.label} · ${variable.key}`,
      t("status.tokens", { count: variable.tokens }),
      t("status.now"),
      "bg-[#0c766e]",
    ]),
  ];

  const inspectorTabs: WorkspaceTab<"variables" | "observations" | "status">[] = [
    {
      controls: "variables-tabpanel",
      id: "variables",
      label: t("inspector.variables"),
      tabId: "variables-tab",
    },
    {
      controls: "observations-tabpanel",
      id: "observations",
      label: t("inspector.observations"),
      tabId: "observations-tab",
    },
    {
      controls: "status-tabpanel",
      id: "status",
      label: t("inspector.status"),
      tabId: "status-tab",
    },
  ];

  return (
    <section
      aria-label={t("inspector.label")}
      className="relative grid min-h-0 grid-rows-[34px_1fr] overflow-hidden bg-[#eef5f3]"
      data-variable-editable={canEditVariables ? "true" : "false"}
      id="variables-panel"
    >
      <WorkspaceTabs
        actions={activeTab === "variables" ? (
          <button
            aria-label={showSystemVariables
              ? t("inspector.hideSystemVariables")
              : t("inspector.showSystemVariables")}
            aria-pressed={showSystemVariables}
            className="flex h-7 w-7 shrink-0 items-center justify-center text-[#63777b] outline-none hover:bg-[#dce8e6] hover:text-[#164f4a] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
            onClick={() => {
              setShowSystemVariables((current) => !current);
              setDetail(null);
            }}
            title={showSystemVariables
              ? t("inspector.hideSystemVariables")
              : t("inspector.showSystemVariables")}
            type="button"
          >
            {showSystemVariables
              ? <Eye aria-hidden="true" size={14} />
              : <EyeOff aria-hidden="true" size={14} />}
          </button>
        ) : undefined}
        activeTab={activeTab}
        ariaLabel={t("inspector.view")}
        idPrefix="inspector"
        onChange={selectTab}
        tabs={inspectorTabs}
      />

      {activeTab === "variables" ? (
        <div
          aria-labelledby="variables-tab"
          className="minimal-scrollbar min-h-0 overflow-auto py-1"
          id="variables-tabpanel"
          role="tabpanel"
        >
          <details open>
            <summary className="flex min-h-7 cursor-pointer select-none items-center gap-1 px-2 text-xs font-semibold text-[#2a454a] outline-none hover:bg-[#dfecea] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]">
              {t("inspector.locals")}
              <span className="font-mono text-[10px] font-normal text-[#73868a]">
                Scope
              </span>
            </summary>
            {Object.entries(runtimeVariables)
              .filter(([name]) => showSystemVariables || name !== "builtin")
              .map(([name, value]) => (
              <VariableNode
                depth={0}
                key={name}
                name={name}
                onInspect={inspectValue}
                path={[name]}
                value={value}
              />
              ))}
          </details>
        </div>
      ) : activeTab === "observations" ? (
        <div
          aria-labelledby="observations-tab"
          className="minimal-scrollbar min-h-0 overflow-auto py-1"
          id="observations-tabpanel"
          role="tabpanel"
        >
          {observations.items.length > 0 ? observations.items.map((observation) => (
            <button
              className="grid min-h-9 w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#dfe7e7] px-3 text-left outline-none hover:bg-[#e3efed] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
              data-observation={observation.toolName}
              key={observation.id}
              onClick={() => setSelectedObservationId(observation.id)}
              type="button"
            >
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${observation.status === "failed" ? "bg-[#9b4141]" : observation.status === "running" ? "bg-[#c58a27]" : "bg-[#25806f]"}`} />
              <span className="min-w-0 truncate font-mono text-[11px] text-[#29484c]">{observation.toolName}</span>
              <span className="text-[9px] text-[#718488]">{observation.durationMs === undefined ? observation.status : `${observation.durationMs} ms`}</span>
            </button>
          )) : (
            <div className="flex h-full min-h-20 items-center justify-center px-3 text-center text-[10px] text-[#718488]">
              {t("inspector.noObservations")}
            </div>
          )}
        </div>
      ) : (
        <div
          aria-labelledby="status-tab"
          className="minimal-scrollbar min-h-0 overflow-auto"
          id="status-tabpanel"
          role="tabpanel"
        >
          <table className="w-full table-fixed border-collapse text-left text-xs">
            <thead className="sticky top-0 bg-[#e7efee] text-[10px] uppercase text-[#657a7e]">
              <tr>
                <th className="w-[42%] border-b border-[#cbd8d9] px-3 py-2 font-semibold">
                  {t("status.item")}
                </th>
                <th className="w-[30%] border-b border-[#cbd8d9] px-2 py-2 font-semibold">
                  {t("status.value")}
                </th>
                <th className="border-b border-[#cbd8d9] px-2 py-2 font-semibold">
                  {t("status.updated")}
                </th>
              </tr>
            </thead>
            <tbody className="text-[#2e494e]">
              {statusRows.map(([name, status, updated, color], index) => (
                <tr className="hover:bg-[#e3efed]" key={`${name}-${index}`}>
                  <td
                    className="break-words border-b border-[#dfe7e7] px-3 py-2.5 leading-5"
                    title={name}
                  >
                    {name}
                  </td>
                  <td className="border-b border-[#dfe7e7] px-2 py-2.5">
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`}
                      />
                      {status}
                    </span>
                  </td>
                  <td className="truncate border-b border-[#dfe7e7] px-2 py-2.5 text-[#70858a]">
                    {updated}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedObservation && (
        <div className="absolute inset-x-0 bottom-0 z-10 grid h-[62%] grid-rows-[34px_1fr] border-t border-[#8eaaa9] bg-[#f8fbfa] shadow-[0_-8px_20px_rgba(23,45,51,0.08)]">
          <div className="flex min-w-0 items-center justify-between border-b border-[#d8e2e2] px-3">
            <span className="truncate font-mono text-xs font-semibold text-[#28484d]">
              {selectedObservation.toolName} · {t("inspector.observationResult")}
            </span>
            <button
              aria-label={t("inspector.close")}
              className="flex h-7 w-7 items-center justify-center text-lg leading-none text-[#60777b] outline-none hover:bg-[#e1ecea] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
              onClick={() => setSelectedObservationId(null)}
              type="button"
            >
              ×
            </button>
          </div>
          <CodeSurface
            ariaLabel={t("inspector.observationResult")}
            language="JSON"
            lineNumbers
            lineWrapping
            readOnly
            statusBar={false}
            value={JSON.stringify({
              arguments: selectedObservation.arguments,
              result: selectedObservation.resultArtifactId
                ? artifactContents[selectedObservation.resultArtifactId] ?? t("debug.loadingArtifact")
                : selectedObservation.error ?? null,
              consumedByRequestArtifactId: selectedObservation.consumedByRequestArtifactId ?? t("inspector.notConsumed"),
              consumedByStepId: selectedObservation.consumedByStepId ?? null,
            }, null, 2)}
          />
        </div>
      )}

      {detail && (
        <div className="absolute inset-x-0 bottom-0 grid h-[56%] grid-rows-[34px_1fr_36px] border-t border-[#8eaaa9] bg-[#f8fbfa] shadow-[0_-8px_20px_rgba(23,45,51,0.08)]">
          <div className="flex min-w-0 items-center justify-between border-b border-[#d8e2e2] px-3">
            <span className="truncate font-mono text-xs font-semibold text-[#28484d]">
              {detail.name}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] text-[#6d8185]">
                {canEditVariables
                  ? detail.path[0] === "tools"
                    ? t("inspector.readOnly")
                    : t("inspector.editable")
                  : t("inspector.readOnly")}
              </span>
              <button
                aria-label={t("inspector.close")}
                className="flex h-7 w-7 items-center justify-center text-lg leading-none text-[#60777b] outline-none hover:bg-[#e1ecea] hover:text-[#1b3d42] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
                onClick={() => setDetail(null)}
                title={t("inspector.closeShort")}
                type="button"
              >
                ×
              </button>
            </div>
          </div>
          <CodeSurface
            ariaLabel={t("inspector.valueEditor")}
            language={detail.kind === "json" ? "JSON" : "Text"}
            lineNumbers={detail.kind === "json"}
            lineWrapping
            onChange={(value) =>
              canEditDetail &&
              setDetail((current) =>
                current ? { ...current, value } : current,
              )
            }
            readOnly={!canEditDetail}
            statusBar={false}
            value={detail.value}
          />
          <div className="flex items-center justify-between border-t border-[#d8e2e2] px-2.5">
            <span
              className={`truncate text-[10px] ${
                detailError ? "text-[#843d3d]" : "text-[#6d8185]"
              }`}
            >
              {detailError ??
                (canEditDetail
                  ? t("inspector.editableHint")
                  : t("inspector.readOnlyHint"))}
            </span>
            <button
              className="h-7 bg-[#0c766e] px-3 text-[11px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-not-allowed disabled:bg-[#a9b9b9]"
              disabled={!canEditDetail}
              onClick={applyDetail}
              type="button"
            >
              {t("inspector.apply")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function HomeContent() {
  const { t } = useI18n();
  const runtime = useRuntime();
  const { mode: themeMode, selectMode: selectThemeMode } = useThemeMode();
  const [activeView, setActiveView] = useState<AppView>("runtime");
  const [resourceSection, setResourceSection] =
    useState<ResourceSection>("files");
  const [contextWidth, setContextWidth] = useState(CONTEXT_DEFAULT_WIDTH);
  const [programWidth, setProgramWidth] = useState(PROGRAM_DEFAULT_WIDTH);
  const [variablesHeight, setVariablesHeight] = useState(VARIABLES_DEFAULT_HEIGHT);
  const [requestSelection, setRequestSelection] = useState<{
    sessionId: string | null;
    requestId: string | null;
  }>({ sessionId: null, requestId: null });
  const snapshot = runtime.snapshot;
  const latestRequestId = snapshot?.conversation.messages
    .filter((message) => message.role === "assistant" && message.requestId)
    .at(-1)?.requestId ?? snapshot?.run.runId ?? null;
  const runActive = Boolean(snapshot && ![
    "idle", "ready", "completed", "failed", "cancelled", "interrupted",
  ].includes(snapshot.run.status));
  const visibleRequestId = runActive
    ? snapshot?.run.runId ?? latestRequestId
    : requestSelection.sessionId === runtime.sessionId
      ? requestSelection.requestId ?? latestRequestId
      : latestRequestId;
  const currentObservations = snapshot ? {
    ...snapshot.observations,
    items: snapshot.observations.items.filter((item) => item.runId === snapshot.run.runId),
  } : undefined;
  const currentEffectiveContexts = snapshot
    ? snapshot.effectiveContexts.items.filter((item) => item.runId === snapshot.run.runId)
    : [];

  const canEditVariables = snapshot?.run.variablesEditable ?? false;
  const connectionLabel =
    runtime.connection === "connected"
      ? t("connection.connected")
      : runtime.connection === "reconnecting"
        ? t("connection.reconnecting")
        : runtime.connection === "disconnected"
          ? t("connection.disconnected")
          : t("connection.connecting");
  const appTabs: WorkspaceTab<AppView>[] = APP_VIEWS.map((view) => ({
    controls: `${view}-view`,
    id: view,
    label: view === "runtime"
      ? t("navigation.runtime")
      : view === "resources"
        ? t("navigation.resources")
        : view === "experiments"
          ? t("navigation.experiments")
          : t("navigation.recall"),
    tabId: `app-${view}-tab`,
  }));

  const updateRuntimeVariable = (path: RuntimeVariablePath, value: unknown) => {
    if (!canEditVariables) {
      return;
    }
    const pointer = `/${path
      .map((token) => token.replaceAll("~", "~0").replaceAll("/", "~1"))
      .join("/")}`;
    runtime.applyVariables([
      {
        op: "replace",
        path: pointer,
        value: value as JsonValue,
      },
    ]);
  };

  const runPrimaryAction = () => {
    if (!snapshot) return;
    const { run } = snapshot;
    const terminal = ["idle", "ready", "completed", "failed", "cancelled"].includes(
      run.status,
    );
    if (run.mode === "step") {
      if (!run.runId || terminal) runtime.startRun();
      runtime.stepRun();
      return;
    }
    if (run.status === "paused" || run.status === "interrupted") {
      runtime.resumeRun();
    } else if (terminal || !run.runId) {
      runtime.startRun();
    }
  };

  const contextMaximum = () =>
    Math.max(
      CONTEXT_MIN_WIDTH,
      window.innerWidth -
        programWidth -
        CONVERSATION_MIN_WIDTH -
        DIVIDER_SIZE * 2,
    );

  const programMaximum = () =>
    Math.max(
      PROGRAM_MIN_WIDTH,
      window.innerWidth -
        contextWidth -
        CONVERSATION_MIN_WIDTH -
        DIVIDER_SIZE * 2,
    );

  const variablesMaximum = () =>
    Math.max(
      VARIABLES_MIN_HEIGHT,
      window.innerHeight - CONTROLS_MIN_HEIGHT - DIVIDER_SIZE,
    );

  const selectView = (view: AppView) => {
    setActiveView(view);
  };

  const openToolResources = () => {
    setResourceSection("tools");
    setActiveView("resources");
  };

  const openHarnessResources = () => {
    setResourceSection("harnesses");
    setActiveView("resources");
  };

  const openSkillResources = () => {
    setResourceSection("skills");
    setActiveView("resources");
  };

  return (
    <div className="flex h-dvh min-h-[568px] flex-col overflow-hidden bg-[#e7edef] text-[#18272c]">
      <header className="app-header relative h-10 shrink-0 border-b border-[#b9c7ca] bg-white px-3 after:absolute after:inset-x-0 after:bottom-[-1px] after:h-px after:bg-[#0c766e] after:content-['']">
        <div
          aria-label="capybara"
          className="app-brand flex min-w-0 items-center gap-2"
        >
          <span className="brand-logo flex h-7 w-9 shrink-0 items-center border-r border-[#d7e0e3] pr-2">
            <CapybaraLogo className="h-7 w-7" />
          </span>
          <h1 className="truncate text-sm font-semibold text-[#18383e]">
            capybara
          </h1>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-[#d7e0e3]" />
          <ProjectSelector />
        </div>

        <WorkspaceTabs
          activeTab={activeView}
          ariaLabel={t("navigation.label")}
          idPrefix="app"
          onChange={selectView}
          tabs={appTabs}
          variant="application"
        />

        <div className="header-status">
          <div className="mobile-project-selector min-w-0">
            <ProjectSelector />
          </div>
          <div
            aria-live="polite"
            className="flex h-6 items-center gap-1.5 px-1 text-[10px] text-[#60777a]"
            title={runtime.error ?? connectionLabel}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${
                runtime.connection === "connected"
                  ? "bg-[#25806f]"
                  : runtime.error
                    ? "bg-[#9b4141]"
                    : "bg-[#c58a27] motion-safe:animate-pulse"
              }`}
            />
            <span className="hidden xl:inline">
              {connectionLabel}
            </span>
          </div>
        </div>
      </header>

      <main
        aria-labelledby="app-runtime-tab"
        className="minimal-scrollbar min-h-0 flex-1 overflow-auto"
        hidden={activeView !== "runtime"}
        id="runtime-view"
        role="tabpanel"
      >
        {snapshot ? (
          <div
            className="grid h-full min-h-[520px] min-w-[780px] overflow-hidden bg-[#dce5e7]"
            style={{
              gridTemplateColumns: `${contextWidth}px ${DIVIDER_SIZE}px minmax(${CONVERSATION_MIN_WIDTH}px, 1fr) ${DIVIDER_SIZE}px ${programWidth}px`,
            }}
          >
          <ContextWorkspace
            artifactContents={runtime.artifactContents}
            contexts={snapshot.contexts}
            effectiveContexts={snapshot.effectiveContexts}
            error={runtime.error}
            harnesses={snapshot.harnesses}
            skills={snapshot.skills}
            onAttachHarness={runtime.attachHarness}
            onAttachSkill={runtime.attachSkill}
            onAttachTool={runtime.attachTool}
            onDetachHarness={runtime.detachHarness}
            onDetachSkill={runtime.detachSkill}
            onDetachTool={runtime.detachTool}
            onGetArtifact={runtime.getArtifact}
            onOpenHarnessResources={openHarnessResources}
            onOpenSkillResources={openSkillResources}
            onOpenToolResources={openToolResources}
            onLoadSkillReference={runtime.loadSkillReference}
            onRunSkillScript={runtime.runSkillScript}
            onUpdateTemplate={runtime.updateTemplate}
            renderResult={snapshot.renderResult}
            selectedRequestId={visibleRequestId}
            template={snapshot.template}
            tools={snapshot.tools}
          />

          <ResizeHandle
            controls="context-panel conversation-panel"
            defaultValue={CONTEXT_DEFAULT_WIDTH}
            label={t("resize.context")}
            maximum={contextMaximum}
            minimum={CONTEXT_MIN_WIDTH}
            onChange={setContextWidth}
            orientation="vertical"
            value={contextWidth}
            valueText={t("resize.pixels", { value: contextWidth })}
          />

          <ConversationPanel
            onSelectRequest={(requestId) => setRequestSelection({
              sessionId: runtime.sessionId,
              requestId,
            })}
            selectedRequestId={visibleRequestId}
          />

          <ResizeHandle
            controls="conversation-panel program-panel"
            defaultValue={PROGRAM_DEFAULT_WIDTH}
            direction={-1}
            label={t("resize.program")}
            maximum={programMaximum}
            minimum={PROGRAM_MIN_WIDTH}
            onChange={setProgramWidth}
            orientation="vertical"
            value={programWidth}
            valueText={t("resize.pixels", { value: programWidth })}
          />

          <aside
            aria-label={t("panel.program")}
            className="grid min-h-0 min-w-0"
            id="program-panel"
            style={{
              gridTemplateRows: `${variablesHeight}px ${DIVIDER_SIZE}px minmax(${CONTROLS_MIN_HEIGHT}px, 1fr)`,
            }}
          >
            <VariableStatusPanel
              artifactContents={runtime.artifactContents}
              canEditVariables={canEditVariables}
              connection={runtime.connection}
              observations={currentObservations ?? snapshot.observations}
              onGetArtifact={runtime.getArtifact}
              onVariableChange={updateRuntimeVariable}
              runtimeStatus={snapshot.status}
              runtimeVariables={snapshot.variables.value}
            />

            <ResizeHandle
              controls="variables-panel controls-panel"
              defaultValue={VARIABLES_DEFAULT_HEIGHT}
              label={t("resize.variables")}
              maximum={variablesMaximum}
              minimum={VARIABLES_MIN_HEIGHT}
              onChange={setVariablesHeight}
              orientation="horizontal"
              value={variablesHeight}
              valueText={t("resize.pixels", { value: variablesHeight })}
            />

            <DebugControlPanel
              artifactContents={runtime.artifactContents}
              artifacts={snapshot.artifacts.items}
              breakpoints={snapshot.breakpoints.items}
              checkpoints={snapshot.checkpoints.items}
              contexts={snapshot.contexts.items}
              effectiveContexts={currentEffectiveContexts}
              key={snapshot.run.runId ?? "idle"}
              onExecutionModeChange={runtime.setRunMode}
              onGetArtifact={runtime.getArtifact}
              onInterrupt={runtime.interruptRun}
              onPause={runtime.pauseRun}
              onPrimaryAction={runPrimaryAction}
              onRemoveBreakpoint={runtime.removeBreakpoint}
              onRestartStep={runtime.restartStep}
              onRestoreCheckpoint={runtime.restoreCheckpoint}
              onRestorePrevious={runtime.restorePrevious}
              onUpsertBreakpoint={runtime.upsertBreakpoint}
              run={snapshot.run}
              timeline={snapshot.timeline.steps}
              workflows={snapshot.workflows ?? { revision: 0, items: [] }}
            />
          </aside>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center bg-white text-xs text-[#60777a]">
            {runtime.error ?? connectionLabel}
          </div>
        )}
      </main>

      <main
        aria-labelledby="app-resources-tab"
        className="minimal-scrollbar min-h-0 flex-1 overflow-auto bg-white"
        hidden={activeView !== "resources"}
        id="resources-view"
        role="tabpanel"
        tabIndex={0}
      >
        {runtime.project ? (
          <ResourcesWorkspace
            activeSection={resourceSection}
            onSectionChange={setResourceSection}
            projectControls={<ProjectSessionSettings />}
            preferences={<ApplicationPreferences onThemeModeChange={selectThemeMode} themeMode={themeMode} />}
            projectPath={runtime.project.path}
            runtimeTools={snapshot?.tools}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-[#60777a]">
            <FolderOpen aria-hidden="true" className="mr-2" size={16} />
            {t("project.select")}
          </div>
        )}
      </main>

      <main
        aria-labelledby="app-experiments-tab"
        className="minimal-scrollbar min-h-0 flex-1 overflow-auto bg-white"
        hidden={activeView !== "experiments"}
        id="experiments-view"
        role="tabpanel"
        tabIndex={0}
      >
        {runtime.project ? (
          <ExperimentsWorkspace projectPath={runtime.project.path} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-[#60777a]">
            <FolderOpen aria-hidden="true" className="mr-2" size={16} />
            {t("project.select")}
          </div>
        )}
      </main>

      <main
        aria-labelledby="app-recall-tab"
        className="min-h-0 flex-1 bg-white"
        hidden={activeView !== "recall"}
        id="recall-view"
        role="tabpanel"
        tabIndex={0}
      />
    </div>
  );
}

export default function Home() {
  return (
    <UserPreferencesProvider>
      <I18nProvider>
        <RuntimeProvider>
          <HomeContent />
        </RuntimeProvider>
      </I18nProvider>
    </UserPreferencesProvider>
  );
}
