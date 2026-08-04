"use client";

import {
  CheckCircle2,
  CircleAlert,
  Database,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  History,
  LoaderCircle,
  RefreshCw,
  Shield,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  resourceApi,
  type ProjectGitChange,
  type ProjectGitCommit,
  type ProjectGitStatus,
} from "../resource-api";
import { useI18n } from "../i18n";
import CodeSurface from "./code-surface";
import { PanelHeader, SearchField, WorkspaceTabs, type WorkspaceTab } from "./workspace-ui";

type GitView = "changes" | "history";

async function fetchGitSnapshot(projectPath: string) {
  const status = await resourceApi.gitStatus(projectPath);
  const history = status.initialized
    ? (await resourceApi.gitHistory(projectPath)).items
    : [];
  return { history, status };
}

function statusCode(change: ProjectGitChange): string {
  if (change.kind === "untracked") return "U";
  if (change.kind === "conflicted") return "!";
  return change.indexStatus.trim() || change.worktreeStatus.trim() || "M";
}

function GitStatusMark({ clean }: { clean: boolean }) {
  const Icon = clean ? CheckCircle2 : CircleAlert;
  return <Icon aria-hidden="true" className={clean ? "text-[#0c766e]" : "text-[#a4682e]"} size={13} />;
}

export default function GitResourceWorkspace({ divider, projectPath }: {
  divider: ReactNode;
  projectPath: string;
}) {
  const { locale, t } = useI18n();
  const [view, setView] = useState<GitView>("changes");
  const [status, setStatus] = useState<ProjectGitStatus | null>(null);
  const [history, setHistory] = useState<ProjectGitCommit[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<{ content: string; path: string } | null>(null);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { history: commits, status: next } = await fetchGitSnapshot(projectPath);
      setStatus(next);
      setHistory(commits);
      setSelectedPaths(new Set(next.changes.filter((change) => change.defaultSelected).map((change) => change.path)));
      setSelectedPath((current) => next.changes.some((change) => change.path === current)
        ? current
        : next.changes.find((change) => !change.protected)?.path ?? null);
      setSelectedCommit((current) => commits.some((commit) => commit.sha === current)
        ? current
        : commits[0]?.sha ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    let active = true;
    void fetchGitSnapshot(projectPath)
      .then(({ history: commits, status: next }) => {
        if (!active) return;
        setStatus(next);
        setHistory(commits);
        setSelectedPaths(new Set(next.changes.filter((change) => change.defaultSelected).map((change) => change.path)));
        setSelectedPath(next.changes.find((change) => !change.protected)?.path ?? null);
        setSelectedCommit(commits[0]?.sha ?? null);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [projectPath]);

  useEffect(() => {
    let active = true;
    if (view !== "changes" || !selectedPath || !status?.initialized) {
      return () => { active = false; };
    }
    void resourceApi.gitDiff(projectPath, selectedPath)
      .then((result) => {
        if (active) setDiff({ content: result.content, path: result.path });
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => { active = false; };
  }, [projectPath, selectedPath, status?.initialized, view]);

  const normalizedQuery = query.trim().toLowerCase();
  const visibleChanges = useMemo(() => status?.changes.filter((change) =>
    `${change.path} ${change.kind} ${change.category}`.toLowerCase().includes(normalizedQuery)) ?? [],
  [normalizedQuery, status?.changes]);
  const visibleHistory = useMemo(() => history.filter((commit) =>
    `${commit.shortSha} ${commit.subject} ${commit.authorName}`.toLowerCase().includes(normalizedQuery)),
  [history, normalizedQuery]);
  const currentCommit = history.find((commit) => commit.sha === selectedCommit) ?? null;
  const tabs: WorkspaceTab<GitView>[] = [
    { id: "changes", icon: FileDiff, label: t("git.changes"), controls: "resource-git-changes" },
    { id: "history", icon: History, label: t("git.history"), controls: "resource-git-history" },
  ];

  const togglePath = (change: ProjectGitChange) => {
    if (change.protected) return;
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (next.has(change.path)) next.delete(change.path);
      else next.add(change.path);
      return next;
    });
  };

  const initialize = async () => {
    setBusy(true);
    setError(null);
    try {
      await resourceApi.initializeGit(projectPath);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const commit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!message.trim() || selectedPaths.size === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await resourceApi.commitGit(projectPath, message.trim(), [...selectedPaths]);
      setMessage("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <aside className="grid min-h-0 grid-rows-[34px_38px_1fr] bg-[#f8faf9]" id="resource-version-control-list">
        <WorkspaceTabs
          activeTab={view}
          ariaLabel={t("git.views")}
          idPrefix="resource-git"
          onChange={(next) => { setView(next); setQuery(""); }}
          tabs={tabs}
        />
        <div className="border-b border-[#d9e3e3] p-1.5">
          <SearchField
            compact
            label={view === "changes" ? t("git.searchChanges") : t("git.searchHistory")}
            onChange={setQuery}
            value={query}
          />
        </div>
        <div className="minimal-scrollbar min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-[10px] text-[#718488]"><LoaderCircle aria-hidden="true" className="animate-spin" size={13} />{t("git.loading")}</div>
          ) : view === "changes" ? (
            <div id="resource-git-changes" role="tabpanel">
              {visibleChanges.map((change) => (
                <div className={`grid grid-cols-[28px_minmax(0,1fr)] border-b border-[#dfe7e7] ${selectedPath === change.path ? "bg-[#d9e9e6]" : "bg-white hover:bg-[#eef4f3]"}`} key={change.path}>
                  <label className="grid place-items-center" title={change.protected ? t("git.protected") : t("git.selectChange", { path: change.path })}>
                    <input
                      aria-label={t("git.selectChange", { path: change.path })}
                      checked={selectedPaths.has(change.path)}
                      className="h-3 w-3 accent-[#0c766e]"
                      disabled={change.protected}
                      onChange={() => togglePath(change)}
                      type="checkbox"
                    />
                  </label>
                  <button className="grid min-w-0 grid-cols-[18px_minmax(0,1fr)] items-center gap-1.5 py-2 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" onClick={() => setSelectedPath(change.path)} type="button">
                    {change.protected ? <Shield aria-hidden="true" className="text-[#8a5555]" size={12} /> : change.category === "dataset" ? <Database aria-hidden="true" className="text-[#7b6a3e]" size={12} /> : <span className="font-mono text-[9px] font-bold text-[#0c766e]">{statusCode(change)}</span>}
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[10px] text-[#29484c]" title={change.path}>{change.path}</span>
                      <span className="mt-0.5 block text-[9px] text-[#718488]">{t(`git.kind.${change.kind}`)}{change.category === "dataset" ? ` · ${t("git.dataset")}` : ""}</span>
                    </span>
                  </button>
                </div>
              ))}
              {visibleChanges.length === 0 && <div className="flex h-32 items-center justify-center px-4 text-center text-[10px] text-[#718488]">{t("git.noChanges")}</div>}
            </div>
          ) : (
            <div id="resource-git-history" role="tabpanel">
              {visibleHistory.map((commitItem) => (
                <button className={`grid w-full gap-1 border-b border-[#dfe7e7] px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${selectedCommit === commitItem.sha ? "bg-[#d9e9e6]" : "bg-white hover:bg-[#eef4f3]"}`} key={commitItem.sha} onClick={() => setSelectedCommit(commitItem.sha)} type="button">
                  <span className="truncate text-[10px] font-semibold text-[#29484c]">{commitItem.subject}</span>
                  <span className="flex items-center justify-between gap-2 font-mono text-[9px] text-[#718488]"><span>{commitItem.shortSha}</span><span className="truncate">{commitItem.authorName}</span></span>
                </button>
              ))}
              {visibleHistory.length === 0 && <div className="flex h-32 items-center justify-center px-4 text-center text-[10px] text-[#718488]">{t("git.noHistory")}</div>}
            </div>
          )}
        </div>
      </aside>

      {divider}

      <section className="grid min-h-0 grid-rows-[34px_auto_minmax(0,1fr)_auto] bg-white" id="resource-version-control-panel" role="tabpanel">
        <PanelHeader
          actions={<button aria-label={t("git.refresh")} className="grid h-7 w-7 place-items-center text-[#60777a] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" disabled={loading || busy} onClick={() => void load()} title={t("git.refresh")} type="button"><RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={13} /></button>}
          icon={GitBranch}
          metadata={status?.initialized ? `${status.branch ?? "HEAD"} · ${status.head?.shortSha ?? t("git.noCommits")}` : undefined}
          title={t("resources.versionControl")}
        />

        {status?.initialized && (
          <div className="grid grid-cols-[minmax(100px,0.45fr)_minmax(140px,0.65fr)_minmax(0,1.4fr)] items-center gap-3 border-b border-[#d9e3e3] bg-[#f3f7f6] px-3 py-2 text-[9px] text-[#718488]">
            <span className="flex min-w-0 items-center gap-1.5"><GitStatusMark clean={status.clean} /><strong className="text-[#49666b]">{status.clean ? t("git.clean") : t("git.dirty")}</strong></span>
            <span className="truncate font-mono" title={status.head?.projectTreeSha ?? ""}>{t("git.tree")} {status.head?.projectTreeSha?.slice(0, 10) ?? "-"}</span>
            <span className="truncate font-mono" title={status.repositoryRoot ?? ""}>{status.repositoryRoot}{status.projectSubpath ? ` / ${status.projectSubpath}` : ""}</span>
          </div>
        )}

        <div className="relative min-h-0 overflow-hidden">
          {!status?.gitAvailable && !loading ? (
            <div className="flex h-full items-center justify-center text-xs text-[#843d3d]">{t("git.unavailable")}</div>
          ) : !status?.initialized && !loading ? (
            <div className="flex h-full items-center justify-center">
              <button className="flex h-8 items-center gap-2 bg-[#0c766e] px-3 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#6cc9c0] disabled:bg-[#9aacab]" disabled={busy} onClick={() => void initialize()} type="button">
                {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={13} /> : <GitBranch aria-hidden="true" size={13} />}
                {t("git.initialize")}
              </button>
            </div>
          ) : view === "changes" ? (
            selectedPath ? (
              <CodeSurface ariaLabel={t("git.diff", { path: selectedPath })} language="Diff" lineNumbers readOnly statusBar={false} value={diff?.path === selectedPath ? diff.content : ""} />
            ) : (
              <div className="flex h-full items-center justify-center text-[10px] text-[#718488]">{t("git.selectFile")}</div>
            )
          ) : currentCommit ? (
            <div className="minimal-scrollbar h-full overflow-y-auto px-4 py-5">
              <div className="max-w-3xl">
                <h3 className="text-sm font-semibold text-[#29484c]">{currentCommit.subject}</h3>
                <dl className="mt-4 grid grid-cols-[90px_minmax(0,1fr)] gap-x-4 gap-y-3 text-[10px]">
                  <dt className="text-[#718488]">{t("git.commit")}</dt><dd className="break-all font-mono text-[#35565b]">{currentCommit.sha}</dd>
                  <dt className="text-[#718488]">{t("git.author")}</dt><dd className="text-[#35565b]">{currentCommit.authorName}</dd>
                  <dt className="text-[#718488]">{t("git.committedAt")}</dt><dd className="text-[#35565b]">{new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(currentCommit.committedAt))}</dd>
                </dl>
              </div>
            </div>
          ) : null}
          {error && <div className="absolute bottom-3 right-3 z-10 max-w-lg border border-[#d5a2a2] bg-[#f8eded] px-3 py-2 text-[10px] text-[#843d3d] shadow-sm" role="alert">{error}</div>}
        </div>

        {status?.initialized && view === "changes" && (
          <form className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-t border-[#cbd8d9] bg-[#f3f7f6] p-2" onSubmit={commit}>
            <label className="grid min-w-0 gap-1 text-[9px] font-semibold text-[#657b7f]">
              <span className="flex items-center justify-between"><span>{t("git.commitMessage")}</span><span className="font-mono font-normal">{t("git.selectedCount", { count: selectedPaths.size })}</span></span>
              <input className="h-7 min-w-0 border border-[#c6d4d4] bg-white px-2 text-[10px] font-normal text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]" onChange={(event) => setMessage(event.target.value)} placeholder={t("git.commitMessagePlaceholder")} value={message} />
            </label>
            <button className="mt-[17px] flex h-7 items-center gap-1.5 bg-[#0c766e] px-3 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#6cc9c0] disabled:cursor-not-allowed disabled:bg-[#a9b9b9]" disabled={busy || !message.trim() || selectedPaths.size === 0} type="submit">
              {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={12} /> : <GitCommitHorizontal aria-hidden="true" size={12} />}
              {t("git.commitSelected")}
            </button>
          </form>
        )}
      </section>
    </>
  );
}
