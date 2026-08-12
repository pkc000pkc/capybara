"use client";

import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCode2,
  Globe2,
  LoaderCircle,
  PackageCheck,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import {
  resourceApi,
  type InstalledSkillSummary,
  type ProjectResourceModule,
  type RemovedSkill,
  type SkillMarketplacePreview,
  type SkillMarketplaceResult,
} from "../resource-api";
import type { RuntimeToolsState } from "../runtime-protocol";
import CodeSurface from "./code-surface";
import ResourceDefinitionWorkspace from "./resource-definition-workspace";
import { PanelHeader } from "./workspace-ui";

type Mode = "installed" | "github";
type Confirmation =
  | { kind: "install"; preview: SkillMarketplacePreview }
  | { kind: "uninstall"; module: ProjectResourceModule; installed?: InstalledSkillSummary };

function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const { t } = useI18n();
  return (
    <div aria-label={t("skills.views")} className="flex h-6 border border-[#b8c9c8] bg-white" role="tablist">
      {(["installed", "github"] as const).map((item) => (
        <button
          aria-selected={mode === item}
          className={"flex h-full items-center gap-1 px-2 text-[9px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] " + (mode === item ? "bg-[#dcecea] text-[#0b625b]" : "text-[#60777a] hover:bg-[#edf4f3]")}
          key={item}
          onClick={() => onChange(item)}
          role="tab"
          type="button"
        >
          {item === "installed" ? <PackageCheck aria-hidden="true" size={11} /> : <Globe2 aria-hidden="true" size={11} />}
          {t(item === "installed" ? "skills.installed" : "skills.github")}
        </button>
      ))}
    </div>
  );
}

function SkillDialog({
  busy,
  confirmation,
  onClose,
  onConfirm,
}: {
  busy: boolean;
  confirmation: Confirmation;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const install = confirmation.kind === "install";
  const name = install ? confirmation.preview.skillName : confirmation.module.name;
  const localChanges = !install && (confirmation.installed?.hasLocalChanges ?? true);
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#203337]/35 p-4">
      <section aria-labelledby="skill-confirm-title" aria-modal="true" className="w-full max-w-lg border border-[#91aaa9] bg-white shadow-[0_12px_30px_rgba(24,39,44,0.24)]" role="dialog">
        <PanelHeader
          actions={(
            <button aria-label={t("skills.close")} className="flex h-6 w-6 items-center justify-center text-[#60777a] outline-none hover:bg-[#dfe9e8] focus-visible:ring-2 focus-visible:ring-[#0c766e]" disabled={busy} onClick={onClose} type="button">
              <X aria-hidden="true" size={13} />
            </button>
          )}
          icon={install ? Download : Trash2}
          title={t(install ? "skills.confirmInstall" : "skills.confirmUninstall")}
          titleId="skill-confirm-title"
        />
        <div className="grid gap-3 p-4 text-[11px] text-[#35555a]">
          <div className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-2 border border-[#d7e1e1] bg-[#f8faf9] p-3">
            <span className="text-[#718488]">Skill</span><strong className="font-mono text-[#24434a]">{name}</strong>
            <span className="text-[#718488]">{t("skills.source")}</span>
            <span className="min-w-0 truncate font-mono">{install ? confirmation.preview.repo : confirmation.installed?.repo ?? t("skills.localSource")}</span>
            <span className="text-[#718488]">{t("skills.target")}</span>
            <span className="font-mono">{install ? `skills/${name}` : confirmation.module.source.replace(/\/SKILL\.md$/, "")}</span>
            {install && <><span className="text-[#718488]">Commit</span><span className="truncate font-mono">{confirmation.preview.commit}</span></>}
          </div>
          <div className="flex items-start gap-2 border border-[#dfc58e] bg-[#fff8e8] px-3 py-2 text-[#76521d]">
            <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
            <span>{install ? t("skills.unverifiedWarning") : localChanges ? t("skills.localChangesWarning") : t("skills.recoveryWarning")}</span>
          </div>
          {install && confirmation.preview.files.some((file) => file.kind === "script") && (
            <div className="flex items-start gap-2 border border-[#d8a1a1] bg-[#fff1f0] px-3 py-2 text-[#8f3535]">
              <FileCode2 aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
              <span>{t("skills.executableWarning")}</span>
            </div>
          )}
        </div>
        <footer className="flex h-11 items-center justify-end gap-2 border-t border-[#cbd8d9] bg-[#f3f7f6] px-3">
          <button className="h-7 border border-[#b8c9c8] bg-white px-3 text-[10px] font-semibold text-[#526b70] outline-none hover:bg-[#e8f0ef] focus-visible:ring-2 focus-visible:ring-[#0c766e]" disabled={busy} onClick={onClose} type="button">{t("skills.cancel")}</button>
          <button className={"flex h-7 items-center gap-1.5 px-3 text-[10px] font-semibold text-white outline-none focus-visible:ring-2 disabled:cursor-wait disabled:bg-[#aebdba] " + (install ? "bg-[#0c766e] hover:bg-[#095f59] focus-visible:ring-[#0c766e]" : "bg-[#9b4141] hover:bg-[#813535] focus-visible:ring-[#9b4141]")} disabled={busy} onClick={onConfirm} type="button">
            {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" size={12} /> : install ? <Download aria-hidden="true" size={12} /> : <Trash2 aria-hidden="true" size={12} />}
            {t(install ? "skills.install" : "skills.uninstall")}
          </button>
        </footer>
      </section>
    </div>
  );
}

function Marketplace({
  catalogWidth,
  divider,
  listHeaderActions,
  onInstalled,
  projectPath,
}: {
  catalogWidth: number;
  divider: ReactNode;
  listHeaderActions: ReactNode;
  onInstalled: (name: string) => void;
  projectPath: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<SkillMarketplaceResult[]>([]);
  const [selected, setSelected] = useState<SkillMarketplaceResult>();
  const [preview, setPreview] = useState<SkillMarketplacePreview>();
  const [searching, setSearching] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const search = useCallback(async (nextPage: number) => {
    if (!query.trim() || searching) return;
    setSearching(true);
    setError(undefined);
    try {
      const response = await resourceApi.searchSkills(projectPath, query, owner, nextPage);
      setResults(response.items);
      setPage(response.page);
      setSelected(undefined);
      setPreview(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSearching(false);
    }
  }, [owner, projectPath, query, searching]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void search(1);
  };

  const select = async (result: SkillMarketplaceResult) => {
    setSelected(result);
    setPreview(undefined);
    setPreviewing(true);
    setError(undefined);
    try {
      const next = await resourceApi.previewMarketplaceSkill(projectPath, result.repo, result.path);
      setPreview(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreviewing(false);
    }
  };

  const install = async () => {
    if (confirmation?.kind !== "install" || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await resourceApi.installMarketplaceSkill(
        projectPath,
        confirmation.preview.repo,
        confirmation.preview.requestedPath,
        confirmation.preview.commit,
      );
      setConfirmation(undefined);
      onInstalled(result.skill?.id ?? confirmation.preview.skillName);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setConfirmation(undefined);
    } finally {
      setBusy(false);
    }
  };

  const scripts = preview?.files.filter((file) => file.kind === "script").length ?? 0;
  const references = preview?.files.filter((file) => file.kind === "reference").length ?? 0;

  return (
    <div className="relative col-span-3 grid min-h-0 overflow-hidden bg-white" id="resource-skills-panel" role="tabpanel" style={{ gridTemplateColumns: `${catalogWidth}px 1px minmax(0,1fr)` }}>
      <aside className="grid min-h-0 grid-rows-[34px_72px_minmax(0,1fr)_32px] bg-[#f8faf9]">
        <PanelHeader actions={listHeaderActions} icon={Globe2} title={t("skills.githubSearch")} />
        <form className="grid grid-rows-2 gap-1 border-b border-[#d9e3e3] p-1.5" onSubmit={submit}>
          <label className="flex h-7 items-center gap-1.5 border border-[#c6d4d4] bg-white px-2 focus-within:border-[#0c766e] focus-within:ring-1 focus-within:ring-[#0c766e]">
            <Search aria-hidden="true" className="shrink-0 text-[#718488]" size={12} />
            <span className="sr-only">{t("skills.searchQuery")}</span>
            <input aria-label={t("skills.searchQuery")} className="min-w-0 flex-1 bg-transparent text-[10px] outline-none" onChange={(event) => setQuery(event.target.value)} placeholder={t("skills.searchQuery")} value={query} />
          </label>
          <div className="grid grid-cols-[1fr_62px] gap-1">
            <input aria-label={t("skills.ownerFilter")} className="h-7 min-w-0 border border-[#c6d4d4] bg-white px-2 text-[10px] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]" onChange={(event) => setOwner(event.target.value)} placeholder={t("skills.ownerFilter")} value={owner} />
            <button className="flex h-7 items-center justify-center gap-1 bg-[#0c766e] text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:bg-[#aebdba]" disabled={!query.trim() || searching} type="submit">
              {searching ? <LoaderCircle aria-hidden="true" className="animate-spin" size={12} /> : <Search aria-hidden="true" size={12} />}
              {t("skills.search")}
            </button>
          </div>
        </form>
        <div className="minimal-scrollbar min-h-0 overflow-y-auto">
          {searching ? (
            <div className="flex h-full items-center justify-center gap-2 text-[11px] text-[#718488]"><LoaderCircle className="animate-spin" size={14} />{t("skills.searching")}</div>
          ) : results.length === 0 ? (
            <div className="flex h-full items-center justify-center px-5 text-center text-[11px] leading-5 text-[#718488]">{t("skills.searchEmpty")}</div>
          ) : results.map((result) => (
            <button aria-pressed={selected?.repo === result.repo && selected.path === result.path} className={"grid min-h-16 w-full grid-cols-[16px_1fr] items-start gap-2 border-b border-[#e0e8e8] px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] " + (selected?.repo === result.repo && selected.path === result.path ? "bg-[#dcecea]" : "bg-white hover:bg-[#eef4f3]")} key={`${result.repo}:${result.path}`} onClick={() => void select(result)} type="button">
              {result.installed ? <CheckCircle2 aria-hidden="true" className="mt-0.5 text-[#2f8a65]" size={14} /> : <BookOpen aria-hidden="true" className="mt-0.5 text-[#537277]" size={14} />}
              <span className="min-w-0">
                <span className="flex min-w-0 items-center justify-between gap-2"><strong className="truncate font-mono text-[10px] text-[#29484c]">{result.skillName}</strong><span className="shrink-0 font-mono text-[8px] text-[#718488]">★ {result.stars}</span></span>
                <span className="mt-0.5 block truncate text-[8px] text-[#60777a]">{result.repo}</span>
                <span className="mt-1 line-clamp-2 text-[9px] leading-3 text-[#718488]">{result.description}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-[#d9e3e3] bg-[#edf3f2] px-2">
          <button aria-label={t("skills.previousPage")} className="flex h-6 w-6 items-center justify-center text-[#526b70] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:opacity-35" disabled={page <= 1 || searching} onClick={() => void search(page - 1)} type="button"><ChevronLeft size={13} /></button>
          <span className="font-mono text-[8px] text-[#718488]">{t("skills.page", { page })}</span>
          <button aria-label={t("skills.nextPage")} className="flex h-6 w-6 items-center justify-center text-[#526b70] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:opacity-35" disabled={results.length < 15 || searching} onClick={() => void search(page + 1)} type="button"><ChevronRight size={13} /></button>
        </div>
      </aside>
      {divider}
      <section className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)_26px] bg-white">
        <PanelHeader
          actions={preview ? <button className="flex h-6 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:bg-[#aebdba]" disabled={selected?.installed} onClick={() => setConfirmation({ kind: "install", preview })} type="button"><Download aria-hidden="true" size={12} />{selected?.installed ? t("skills.alreadyInstalled") : t("skills.installToProject")}</button> : undefined}
          icon={Globe2}
          metadata={preview ? `${preview.repo} · ${preview.commit.slice(0, 8)}` : undefined}
          monospace
          title={preview?.skillName ?? selected?.skillName ?? t("skills.preview")}
        />
        {previewing ? (
          <div className="flex items-center justify-center gap-2 text-xs text-[#718488]"><LoaderCircle className="animate-spin" size={15} />{t("skills.previewing")}</div>
        ) : preview ? (
          <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="grid gap-2 border-b border-[#d9e3e3] bg-[#f8faf9] px-3 py-2">
              <p className="text-[10px] leading-4 text-[#35555a]">{preview.description}</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[8px] text-[#60777a]">
                <span>{preview.files.length} {t("skills.files")}</span><span>{scripts} {t("skills.scripts")}</span><span>{references} {t("skills.references")}</span>
                {preview.allowedTools && <span className="text-[#8a5b19]">{t("skills.tools")}: {preview.allowedTools}</span>}
              </div>
              <div className="flex items-start gap-2 border-l-2 border-[#c9943e] bg-[#fff8e8] px-2 py-1.5 text-[9px] leading-4 text-[#76521d]"><AlertTriangle className="mt-0.5 shrink-0" size={12} />{t("skills.unverifiedWarning")}</div>
            </div>
            <div className="grid min-h-0 grid-cols-[190px_minmax(0,1fr)] divide-x divide-[#cbd8d9]">
              <div className="minimal-scrollbar min-h-0 overflow-y-auto bg-[#f8faf9]">
                {preview.files.map((file) => <div className="grid h-10 grid-cols-[14px_1fr] items-center gap-2 border-b border-[#e0e8e8] px-2.5" key={file.path}><FileCode2 className={file.kind === "script" ? "text-[#9a5d1d]" : "text-[#60777a]"} size={12} /><span className="min-w-0"><span className="block truncate font-mono text-[8px] text-[#29484c]">{file.path}</span><span className="text-[7px] uppercase text-[#829397]">{file.kind} · {file.size} B</span></span></div>)}
              </div>
              <CodeSurface ariaLabel={t("skills.previewContent")} language="Markdown" readOnly value={preview.content} />
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center px-6 text-center text-xs text-[#718488]">{t("skills.chooseResult")}</div>
        )}
        <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-[#cbd8d9] bg-[#edf3f2] px-3 font-mono text-[8px] text-[#718488]"><span className="truncate">{preview?.requestedPath ?? "SKILL.md"}</span><span>{preview ? t("skills.previewOnly") : t("skills.githubPowered")}</span></footer>
      </section>
      {confirmation && <SkillDialog busy={busy} confirmation={confirmation} onClose={() => !busy && setConfirmation(undefined)} onConfirm={() => void install()} />}
      {error && <div className="absolute bottom-3 right-3 z-50 max-w-md border border-[#c68d8d] bg-[#fff1f0] px-3 py-2 text-[10px] text-[#8f3535]" role="alert">{error}</div>}
    </div>
  );
}

export default function SkillResourceWorkspace({
  catalogWidth,
  divider,
  projectPath,
  runtimeTools,
}: {
  catalogWidth: number;
  divider: ReactNode;
  projectPath: string;
  runtimeTools?: RuntimeToolsState;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<Mode>("installed");
  const [installed, setInstalled] = useState<InstalledSkillSummary[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [preferredModuleName, setPreferredModuleName] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [removed, setRemoved] = useState<RemovedSkill>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const loadInstalled = useCallback(async () => {
    try {
      const response = await resourceApi.installedSkills(projectPath);
      setInstalled(response.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [projectPath]);

  const modeSwitch = <ModeSwitch mode={mode} onChange={setMode} />;
  const installedById = useMemo(() => new Map(installed.map((item) => [item.id, item])), [installed]);

  const uninstall = async () => {
    if (confirmation?.kind !== "uninstall" || busy) return;
    const skillId = confirmation.module.name;
    setBusy(true);
    setError(undefined);
    try {
      const result = await resourceApi.uninstallSkill(projectPath, skillId);
      setRemoved(result);
      setConfirmation(undefined);
      setPreferredModuleName(undefined);
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setConfirmation(undefined);
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!removed || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await resourceApi.restoreSkill(projectPath, removed.id);
      setPreferredModuleName(result.skillId);
      setRemoved(undefined);
      setRefreshKey((value) => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const installedView = (
    <ResourceDefinitionWorkspace
      catalogWidth={catalogWidth}
      divider={divider}
      headerActions={(module) => (
        <>
          {installedById.get(module.name)?.repo && (
            <span className="max-w-44 truncate font-mono text-[8px] text-[#60777a]" title={installedById.get(module.name)?.repo}>
              {installedById.get(module.name)?.repo} · {installedById.get(module.name)?.commit?.slice(0, 8)}
              {installedById.get(module.name)?.hasLocalChanges ? ` · ${t("skills.modified")}` : ""}
            </span>
          )}
          <button aria-label={t("skills.remove", { name: module.name })} className="flex h-6 items-center gap-1.5 border border-[#cfaaaa] bg-white px-2 text-[9px] font-semibold text-[#8d4141] outline-none hover:bg-[#f8e9e8] focus-visible:ring-2 focus-visible:ring-[#9b4141]" onClick={() => setConfirmation({ kind: "uninstall", module, installed: installedById.get(module.name) })} type="button"><Trash2 aria-hidden="true" size={11} />{installedById.get(module.name)?.managed ? t("skills.uninstall") : t("skills.delete")}</button>
        </>
      )}
      kind="skill"
      listHeaderActions={modeSwitch}
      onCatalogLoaded={loadInstalled}
      preferredModuleName={preferredModuleName}
      projectPath={projectPath}
      refreshKey={refreshKey}
      runtimeTools={runtimeTools}
    />
  );

  return (
    <>
      {mode === "installed" ? installedView : (
        <Marketplace catalogWidth={catalogWidth} divider={divider} listHeaderActions={modeSwitch} onInstalled={(name) => { setPreferredModuleName(name); setMode("installed"); setRefreshKey((value) => value + 1); }} projectPath={projectPath} />
      )}
      {confirmation && <SkillDialog busy={busy} confirmation={confirmation} onClose={() => !busy && setConfirmation(undefined)} onConfirm={() => void uninstall()} />}
      {removed && (
        <div className="absolute bottom-3 right-3 z-30 flex max-w-md items-center gap-3 border border-[#8fb3ad] bg-[#eff8f6] px-3 py-2 text-[10px] text-[#255b55] shadow-md" role="status">
          <CheckCircle2 aria-hidden="true" className="shrink-0" size={14} />
          <span>{t("skills.removed", { name: removed.skillId })}</span>
          <button className="flex h-6 shrink-0 items-center gap-1 border border-[#83aaa5] bg-white px-2 font-semibold text-[#0c655f] outline-none hover:bg-[#e4f0ee] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:opacity-50" disabled={busy} onClick={() => void restore()} type="button">{busy ? <LoaderCircle className="animate-spin" size={11} /> : <RotateCcw size={11} />}{t("skills.undo")}</button>
          <button aria-label={t("skills.close")} className="flex h-6 w-6 shrink-0 items-center justify-center outline-none hover:bg-[#dcebe8] focus-visible:ring-2 focus-visible:ring-[#0c766e]" onClick={() => setRemoved(undefined)} type="button"><X size={11} /></button>
        </div>
      )}
      {error && <div className="absolute bottom-3 right-3 z-50 max-w-md border border-[#c68d8d] bg-[#fff1f0] px-3 py-2 text-[10px] text-[#8f3535]" role="alert">{error}</div>}
    </>
  );
}
