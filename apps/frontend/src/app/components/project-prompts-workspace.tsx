"use client";

import {
  ChevronRight,
  FileCode2,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Save,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { resourceApi, type ProjectDirectoryListing, type ProjectFileEntry, type ProjectTextFile } from "../resource-api";
import CodeSurface from "./code-surface";
import { PanelHeader, SearchField } from "./workspace-ui";

type PromptFile = ProjectFileEntry;

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", ".next", "dist"]);

function normalizePath(value: string): string {
  const segments: string[] = [];
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function directoryOf(value: string): string {
  const separator = value.lastIndexOf("/");
  return separator < 0 ? "" : value.slice(0, separator);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

async function collectPromptFiles(projectPath: string): Promise<PromptFile[]> {
  const pending = [""];
  const visited = new Set<string>();
  const files: PromptFile[] = [];
  while (pending.length > 0) {
    const directory = pending.shift() ?? "";
    if (visited.has(directory)) continue;
    visited.add(directory);
    const listing: ProjectDirectoryListing = await resourceApi.projectDirectory(projectPath, directory);
    for (const entry of listing.entries) {
      if (entry.type === "directory") {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(entry.path);
      } else if (
        entry.type === "file"
        && entry.editable
        && entry.path.toLowerCase().endsWith(".j2")
      ) {
        files.push(entry);
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: "base" }));
}

function referencedTemplates(content: string, currentPath: string, knownPaths: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  const includePattern = /{%-?\s*(?:include|extends)\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(includePattern)) {
    const requested = match[1]?.trim();
    if (!requested || !requested.toLowerCase().endsWith(".j2")) continue;
    const candidates = requested.startsWith(".")
      ? [normalizePath(`${directoryOf(currentPath)}/${requested}`), normalizePath(requested)]
      : [normalizePath(requested), normalizePath(`${directoryOf(currentPath)}/${requested}`)];
    const resolved = candidates.find((candidate) => knownPaths.has(candidate)) ?? candidates[0];
    if (resolved) found.add(resolved);
  }
  return [...found];
}

function PromptFileListItem({ entry, selected, onSelect }: {
  entry: PromptFile;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`grid min-h-12 w-full grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#e0e8e8] px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${selected ? "bg-[#dcecea] text-[#173f43]" : "bg-white text-[#35555a] hover:bg-[#eef4f3]"}`}
      onClick={onSelect}
      type="button"
    >
      <FileCode2 aria-hidden="true" className={selected ? "text-[#0c766e]" : "text-[#718488]"} size={15} strokeWidth={1.7} />
      <span className="min-w-0">
        <span className="block truncate font-mono text-[10px] font-semibold">{entry.path}</span>
        <span className="mt-0.5 block truncate text-[9px] text-[#7a8d91]">Jinja2 · {formatBytes(entry.size)}</span>
      </span>
      <ChevronRight aria-hidden="true" className={selected ? "text-[#0c766e]" : "text-[#a2b2b3]"} size={13} />
    </button>
  );
}

function IncludeLinks({ currentPath, links, onSelect, t }: {
  currentPath: string;
  links: readonly string[];
  onSelect: (path: string) => void;
  t: (key: "promptFiles.includes" | "promptFiles.noIncludes" | "promptFiles.openInclude", values?: Record<string, string | number>) => string;
}) {
  return (
    <div className="border-t border-[#d6e1e0] bg-[#f7faf9] px-3 py-2">
      <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-[#718488]">{t("promptFiles.includes")}</div>
      {links.length === 0 ? (
        <p className="text-[10px] text-[#8a9a9c]">{t("promptFiles.noIncludes")}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {links.map((path) => (
            <button
              className="flex max-w-full items-center gap-1 border border-[#c4d8d4] bg-white px-2 py-1 font-mono text-[9px] text-[#0c766e] outline-none hover:bg-[#e5f1ee] focus-visible:ring-2 focus-visible:ring-[#0c766e]"
              key={`${currentPath}:${path}`}
              onClick={() => onSelect(path)}
              title={t("promptFiles.openInclude", { path })}
              type="button"
            >
              <FileCode2 aria-hidden="true" size={11} />
              <span className="truncate">{path}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ProjectPromptsWorkspace({
  divider,
  projectPath,
}: {
  divider: ReactNode;
  projectPath: string;
}) {
  const { t } = useI18n();
  const [files, setFiles] = useState<PromptFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [file, setFile] = useState<ProjectTextFile>();
  const [draft, setDraft] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileLoadVersion, setFileLoadVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = Boolean(file && draft !== file.content);
  const knownPaths = useMemo(() => new Set(files.map((entry) => entry.path)), [files]);
  const includes = useMemo(
    () => file ? referencedTemplates(draft, file.path, knownPaths) : [],
    [draft, file, knownPaths],
  );

  const loadFiles = useCallback(async (preferredPath?: string | null) => {
    setLoadingList(true);
    try {
      const [nextFiles, settings] = await Promise.all([
        collectPromptFiles(projectPath),
        resourceApi.projectSettings(projectPath),
      ]);
      const configured = normalizePath(settings.main_template || "main.j2");
      const nextPath = preferredPath && nextFiles.some((entry) => entry.path === preferredPath)
        ? preferredPath
        : nextFiles.some((entry) => entry.path === configured)
          ? configured
          : nextFiles[0]?.path ?? null;
      setFiles(nextFiles);
      setSelectedPath(nextPath);
      setFile(undefined);
      setDraft("");
      setLoadingFile(Boolean(nextPath));
      setFileLoadVersion((current) => current + 1);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoadingList(false);
    }
  }, [projectPath]);

  useEffect(() => {
    // Loading the project catalog is an external resource synchronization.
    // The async callback updates the view once the files and settings arrive.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFiles();
  }, [loadFiles]);

  const loadFile = useCallback(async (path: string) => {
    setLoadingFile(true);
    try {
      const loaded = await resourceApi.projectFile(projectPath, path);
      setSelectedPath(loaded.path);
      setFile(loaded);
      setDraft(loaded.content);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoadingFile(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (!selectedPath) return;
    // Fetch the selected prompt after navigation and synchronize the editor
    // when the external project file responds.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFile(selectedPath);
  }, [fileLoadVersion, loadFile, selectedPath]);

  const selectFile = (path: string) => {
    if (path === selectedPath || (dirty && !window.confirm(t("promptFiles.discardConfirm")))) return;
    setSelectedPath(path);
  };

  const saveFile = async () => {
    if (!file || !dirty || busy) return;
    setBusy(true);
    try {
      const saved = await resourceApi.saveProjectFile(projectPath, file.path, draft, file.revision);
      setFile(saved);
      setDraft(saved.content);
      setFiles((current) => current.map((entry) => entry.path === saved.path
        ? { ...entry, size: saved.size, modifiedAt: saved.modifiedAt }
        : entry));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const filteredFiles = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? files.filter((entry) => entry.path.toLowerCase().includes(normalized)) : files;
  }, [files, query]);

  return (
    <>
      <aside className="grid min-h-0 grid-rows-[34px_34px_1fr] bg-[#f8faf9]" id="resource-prompts-list">
        <PanelHeader
          actions={<span className="font-mono text-[9px] text-[#718488]">{t("resources.itemCount", { count: filteredFiles.length })}</span>}
          title={t("resources.prompts")}
        />
        <div className="border-b border-[#d9e3e3] p-1.5">
          <SearchField compact label={t("promptFiles.search")} onChange={setQuery} value={query} />
        </div>
        <div className="minimal-scrollbar min-h-0 overflow-y-auto">
          {loadingList ? (
            <div className="flex h-full items-center justify-center gap-2 text-[11px] text-[#718488]"><LoaderCircle aria-hidden="true" className="animate-spin" size={14} />{t("promptFiles.loading")}</div>
          ) : filteredFiles.length === 0 ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[#718488]">{t("promptFiles.empty")}</div>
          ) : filteredFiles.map((entry) => (
            <PromptFileListItem entry={entry} key={entry.path} onSelect={() => selectFile(entry.path)} selected={entry.path === selectedPath} />
          ))}
        </div>
      </aside>

      {divider}

      <section aria-labelledby="resource-prompts-tab" className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)] bg-white" id="resource-prompts-panel" role="tabpanel">
        {!selectedPath ? (
          <div className="flex h-full items-center justify-center text-xs text-[#718488]">{t("promptFiles.empty")}</div>
        ) : (
          <>
            <PanelHeader
              actions={(
                <>
                  <span className={`font-mono text-[9px] ${dirty ? "text-[#a16a22]" : "text-[#718488]"}`}>{dirty ? t("resources.unsaved") : t("resources.saved")}</span>
                  <button aria-label={t("promptFiles.refresh")} className="flex h-6 w-6 items-center justify-center text-[#536d72] outline-none hover:bg-[#e1ecea] disabled:opacity-35" disabled={busy || loadingList} onClick={() => { if (!dirty || window.confirm(t("promptFiles.discardConfirm"))) void loadFiles(selectedPath); }} title={t("promptFiles.refresh")} type="button"><RefreshCw aria-hidden="true" size={13} /></button>
                  <button aria-label={t("promptFiles.revert")} className="flex h-6 w-6 items-center justify-center text-[#536d72] outline-none hover:bg-[#e1ecea] disabled:opacity-35" disabled={!dirty || busy} onClick={() => setDraft(file?.content ?? "")} title={t("promptFiles.revert")} type="button"><RotateCcw aria-hidden="true" size={13} /></button>
                  <button aria-label={t("resources.save")} className="flex h-6 w-6 items-center justify-center bg-[#0c766e] text-white outline-none hover:bg-[#095f59] disabled:cursor-default disabled:bg-[#aebdba]" disabled={!dirty || busy} onClick={() => void saveFile()} title={t("resources.save")} type="button"><Save aria-hidden="true" size={12} /></button>
                </>
              )}
              icon={FileCode2}
              metadata={file ? formatBytes(file.size) : undefined}
              monospace
              title={selectedPath}
            />
            <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]">
              {loadingFile ? (
                <div className="flex items-center justify-center gap-2 text-xs text-[#718488]"><LoaderCircle aria-hidden="true" className="animate-spin" size={15} />{t("promptFiles.loadingFile")}</div>
              ) : (
                <CodeSurface ariaLabel={t("resources.fileContent")} language="Jinja2" onChange={setDraft} onSave={() => void saveFile()} value={draft} />
              )}
              {file && <IncludeLinks currentPath={file.path} links={includes} onSelect={selectFile} t={t} />}
            </div>
          </>
        )}
      </section>

      {error && <div className="absolute bottom-3 left-1/2 z-40 flex max-w-[560px] -translate-x-1/2 border border-[#d8aaa6] bg-[#fff7f6] px-3 py-2 text-[10px] text-[#8b3f3a] shadow-lg" role="alert">{error}</div>}
    </>
  );
}
