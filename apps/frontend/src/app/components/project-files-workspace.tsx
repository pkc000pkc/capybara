"use client";

import {
  ArrowUp,
  Binary,
  ChevronRight,
  FileCode2,
  FilePlus2,
  Folder,
  FolderOpen,
  FolderPlus,
  Link2,
  LoaderCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  Save,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import {
  resourceApi,
  type ProjectDirectoryListing,
  type ProjectFileEntry,
  type ProjectTextFile,
} from "../resource-api";
import CodeSurface from "./code-surface";
import { PanelHeader, SearchField } from "./workspace-ui";

type FileDialog = {
  kind: "create-file" | "create-directory" | "rename" | "delete";
  value: string;
};

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function IconButton({
  disabled = false,
  icon: Icon,
  label,
  onClick,
  tone = "default",
}: {
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  tone?: "default" | "danger" | "primary";
}) {
  const toneClass = tone === "primary"
    ? "bg-[#0c766e] text-white hover:bg-[#095f59]"
    : tone === "danger"
      ? "text-[#9a4b45] hover:bg-[#f5e7e5]"
      : "text-[#536d72] hover:bg-[#e1ecea]";
  return (
    <button
      aria-label={label}
      className={`flex h-7 w-7 shrink-0 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-default disabled:opacity-35 ${toneClass}`}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden="true" size={13} strokeWidth={1.8} />
    </button>
  );
}

function EntryIcon({ entry, selected }: { entry: ProjectFileEntry; selected: boolean }) {
  const className = selected ? "text-[#0c766e]" : "text-[#718488]";
  if (entry.type === "directory") {
    const Icon = selected ? FolderOpen : Folder;
    return <Icon aria-hidden="true" className={className} size={15} strokeWidth={1.7} />;
  }
  if (entry.type === "symlink") {
    return <Link2 aria-hidden="true" className={className} size={15} strokeWidth={1.7} />;
  }
  return <FileCode2 aria-hidden="true" className={className} size={15} strokeWidth={1.7} />;
}

export default function ProjectFilesWorkspace({
  divider,
  projectPath,
}: {
  divider: ReactNode;
  projectPath: string;
}) {
  const { t } = useI18n();
  const [listing, setListing] = useState<ProjectDirectoryListing>({ path: "", entries: [] });
  const [directory, setDirectory] = useState("");
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<ProjectTextFile>();
  const [draft, setDraft] = useState("");
  const [dialog, setDialog] = useState<FileDialog | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileLoadVersion, setFileLoadVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedEntry = useMemo(
    () => listing.entries.find((entry) => entry.path === selectedPath),
    [listing.entries, selectedPath],
  );
  const dirty = Boolean(file && draft !== file.content);

  const loadDirectory = useCallback(async (nextDirectory: string, preferredPath: string | null) => {
    setLoadingList(true);
    try {
      const next = await resourceApi.projectDirectory(projectPath, nextDirectory);
      const preferredEntry = preferredPath
        ? next.entries.find((entry) => entry.path === preferredPath)
        : undefined;
      setListing(next);
      setDirectory(next.path);
      setSelectedPath(preferredEntry?.path ?? null);
      setFile(undefined);
      setDraft("");
      setLoadingFile(Boolean(preferredEntry?.type === "file" && preferredEntry.editable));
      setFileLoadVersion((current) => current + 1);
      setQuery("");
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setLoadingList(false);
    }
  }, [projectPath]);

  useEffect(() => {
    let cancelled = false;
    void resourceApi.projectDirectory(projectPath, "").then((next) => {
      if (cancelled) return;
      setListing(next);
      setDirectory(next.path);
      setSelectedPath(null);
      setFile(undefined);
      setDraft("");
      setError(null);
    }).catch((nextError: unknown) => {
      if (!cancelled) setError(nextError instanceof Error ? nextError.message : String(nextError));
    }).finally(() => {
      if (!cancelled) setLoadingList(false);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const selectedEditableFilePath = selectedEntry?.type === "file" && selectedEntry.editable
    ? selectedEntry.path
    : null;
  useEffect(() => {
    if (!selectedEditableFilePath) return;
    let cancelled = false;
    void resourceApi.projectFile(projectPath, selectedEditableFilePath).then((loaded) => {
      if (cancelled) return;
      setFile(loaded);
      setDraft(loaded.content);
      setError(null);
    }).catch((nextError: unknown) => {
      if (!cancelled) {
        setListing((current) => ({
          ...current,
          entries: current.entries.map((entry) => entry.path === selectedEditableFilePath
            ? { ...entry, editable: false }
            : entry),
        }));
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    }).finally(() => {
      if (!cancelled) setLoadingFile(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fileLoadVersion, projectPath, selectedEditableFilePath]);

  const confirmDiscard = () => !dirty || window.confirm(t("projectFiles.discardConfirm"));

  const selectEntry = (entry: ProjectFileEntry) => {
    if (entry.path === selectedPath || !confirmDiscard()) return;
    setSelectedPath(entry.path);
    setFile(undefined);
    setDraft("");
    setLoadingFile(entry.type === "file" && entry.editable);
    setFileLoadVersion((current) => current + 1);
    setError(null);
  };

  const openDirectory = (path: string) => {
    if (!confirmDiscard()) return;
    void loadDirectory(path, null);
  };

  const saveFile = async () => {
    if (!file || !dirty || busy) return;
    setBusy(true);
    try {
      const saved = await resourceApi.saveProjectFile(projectPath, file.path, draft, file.revision);
      setFile(saved);
      setDraft(saved.content);
      setListing((current) => ({
        ...current,
        entries: current.entries.map((entry) => entry.path === saved.path
          ? { ...entry, size: saved.size, modifiedAt: saved.modifiedAt }
          : entry),
      }));
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const submitDialog = async (event: FormEvent) => {
    event.preventDefault();
    if (!dialog || busy) return;
    setBusy(true);
    try {
      if (dialog.kind === "create-file" || dialog.kind === "create-directory") {
        const created = await resourceApi.createProjectEntry(
          projectPath,
          directory,
          dialog.value,
          dialog.kind === "create-file" ? "file" : "directory",
        );
        await loadDirectory(directory, created.path);
      } else if (dialog.kind === "rename" && selectedEntry) {
        if (dialog.value !== selectedEntry.name) {
          const renamed = await resourceApi.renameProjectEntry(projectPath, selectedEntry.path, dialog.value);
          await loadDirectory(directory, renamed.path);
        }
      } else if (dialog.kind === "delete" && selectedEntry) {
        await resourceApi.deleteProjectEntry(
          projectPath,
          selectedEntry.path,
          selectedEntry.type === "directory",
        );
        await loadDirectory(directory, null);
      }
      setDialog(null);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setBusy(false);
    }
  };

  const filteredEntries = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return listing.entries;
    return listing.entries.filter((entry) => entry.name.toLowerCase().includes(normalized));
  }, [listing.entries, query]);

  const entryActions = selectedEntry ? (
    <>
      <IconButton
        disabled={busy}
        icon={Pencil}
        label={t("projectFiles.rename")}
        onClick={() => setDialog({ kind: "rename", value: selectedEntry.name })}
      />
      <IconButton
        disabled={busy}
        icon={Trash2}
        label={t("projectFiles.delete")}
        onClick={() => setDialog({ kind: "delete", value: "" })}
        tone="danger"
      />
    </>
  ) : null;

  return (
    <>
      <aside className="grid min-h-0 grid-rows-[34px_34px_38px_1fr] bg-[#f8faf9]" id="resource-files-list">
        <PanelHeader
          actions={<span className="font-mono text-[9px] text-[#718488]">{t("resources.itemCount", { count: filteredEntries.length })}</span>}
          title={t("resources.files")}
        />
        <div className="flex min-w-0 items-center gap-0.5 border-b border-[#d9e3e3] bg-[#edf3f2] px-1.5">
          <IconButton
            disabled={!directory || loadingList}
            icon={ArrowUp}
            label={t("projectFiles.parentDirectory")}
            onClick={() => openDirectory(parentDirectory(directory))}
          />
          <code className="min-w-0 flex-1 truncate px-1 font-mono text-[9px] text-[#5e7478]" title={directory || "/"}>
            /{directory}
          </code>
          <IconButton
            disabled={loadingList || busy}
            icon={FilePlus2}
            label={t("projectFiles.newFile")}
            onClick={() => setDialog({ kind: "create-file", value: "" })}
          />
          <IconButton
            disabled={loadingList || busy}
            icon={FolderPlus}
            label={t("projectFiles.newDirectory")}
            onClick={() => setDialog({ kind: "create-directory", value: "" })}
          />
          <IconButton
            disabled={loadingList || busy}
            icon={RefreshCw}
            label={t("projectFiles.refresh")}
            onClick={() => {
              if (confirmDiscard()) void loadDirectory(directory, selectedPath);
            }}
          />
        </div>
        <div className="border-b border-[#d9e3e3] p-1.5">
          <SearchField compact label={t("projectFiles.searchDirectory")} onChange={setQuery} value={query} />
        </div>
        <div className="minimal-scrollbar min-h-0 overflow-y-auto">
          {loadingList ? (
            <div className="flex h-full items-center justify-center gap-2 text-[11px] text-[#718488]">
              <LoaderCircle aria-hidden="true" className="animate-spin" size={14} />
              {t("projectFiles.loading")}
            </div>
          ) : filteredEntries.length === 0 ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-xs text-[#718488]">
              {query ? t("resources.noResults") : t("projectFiles.emptyDirectory")}
            </div>
          ) : filteredEntries.map((entry) => {
            const selected = entry.path === selectedPath;
            return (
              <div className="grid h-12 grid-cols-[minmax(0,1fr)_28px] border-b border-[#e0e8e8]" key={entry.path}>
                <button
                  aria-pressed={selected}
                  className={`grid min-w-0 grid-cols-[20px_1fr] items-center px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${selected ? "bg-[#dcecea] text-[#173f43]" : "bg-white text-[#35555a] hover:bg-[#eef4f3]"}`}
                  onClick={() => selectEntry(entry)}
                  onDoubleClick={() => {
                    if (entry.type === "directory") openDirectory(entry.path);
                  }}
                  type="button"
                >
                  <EntryIcon entry={entry} selected={selected} />
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-[11px] font-semibold">{entry.name}</span>
                    <span className="mt-0.5 block truncate text-[9px] text-[#7a8d91]">
                      {entry.type === "file"
                        ? `${entry.editable ? entry.language : t("projectFiles.binary")} · ${formatBytes(entry.size)}`
                        : t(`projectFiles.type.${entry.type}`)}
                    </span>
                  </span>
                </button>
                {entry.type === "directory" ? (
                  <button
                    aria-label={t("projectFiles.openDirectory", { name: entry.name })}
                    className="flex items-center justify-center bg-white text-[#718488] outline-none hover:bg-[#e3eeec] hover:text-[#0c766e] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
                    onClick={() => openDirectory(entry.path)}
                    title={t("projectFiles.openDirectory", { name: entry.name })}
                    type="button"
                  >
                    <ChevronRight aria-hidden="true" size={14} />
                  </button>
                ) : <span aria-hidden="true" className={selected ? "bg-[#dcecea]" : "bg-white"} />}
              </div>
            );
          })}
        </div>
      </aside>

      {divider}

      <section
        aria-labelledby="resource-files-tab"
        className="grid min-h-0 bg-white"
        id="resource-files-panel"
        role="tabpanel"
      >
        {!selectedEntry ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[#718488]">
            <FileCode2 aria-hidden="true" size={25} strokeWidth={1.4} />
            <p className="text-xs">{t("projectFiles.selectEntry")}</p>
          </div>
        ) : selectedEntry.type === "directory" ? (
          <div className="grid h-full min-h-0 grid-rows-[34px_1fr]">
            <PanelHeader actions={entryActions} icon={FolderOpen} monospace title={selectedEntry.path} />
            <div className="flex min-h-0 flex-col items-start justify-center gap-3 px-6 text-[#536d72]">
              <FolderOpen aria-hidden="true" size={28} strokeWidth={1.4} />
              <div>
                <h3 className="font-mono text-sm font-semibold text-[#29484c]">{selectedEntry.name}</h3>
                <p className="mt-1 font-mono text-[10px] text-[#718488]">{selectedEntry.path}</p>
              </div>
              <button
                className="flex h-8 items-center gap-2 bg-[#0c766e] px-3 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e]"
                onClick={() => openDirectory(selectedEntry.path)}
                type="button"
              >
                <FolderOpen aria-hidden="true" size={13} />
                {t("projectFiles.open")}
              </button>
            </div>
          </div>
        ) : selectedEntry.type === "symlink" || !selectedEntry.editable ? (
          <div className="grid h-full min-h-0 grid-rows-[34px_1fr]">
            <PanelHeader actions={entryActions} icon={selectedEntry.type === "symlink" ? Link2 : Binary} monospace title={selectedEntry.path} />
            <div className="flex min-h-0 flex-col items-center justify-center gap-3 px-6 text-center text-[#718488]">
              {selectedEntry.type === "symlink"
                ? <Link2 aria-hidden="true" size={27} strokeWidth={1.4} />
                : <Binary aria-hidden="true" size={27} strokeWidth={1.4} />}
              <p className="max-w-md text-xs leading-5">
                {selectedEntry.type === "symlink" ? t("projectFiles.symlinkUnsupported") : t("projectFiles.binaryUnsupported")}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid h-full min-h-0 grid-rows-[34px_1fr]">
            <PanelHeader
              actions={(
                <>
                  <span className={`font-mono text-[9px] ${dirty ? "text-[#a16a22]" : "text-[#718488]"}`}>
                    {dirty ? t("resources.unsaved") : t("resources.saved")}
                  </span>
                  <IconButton
                    disabled={!dirty || busy}
                    icon={RotateCcw}
                    label={t("projectFiles.revert")}
                    onClick={() => setDraft(file?.content ?? "")}
                  />
                  {entryActions}
                  <IconButton
                    disabled={!dirty || busy}
                    icon={Save}
                    label={t("resources.save")}
                    onClick={() => void saveFile()}
                    tone="primary"
                  />
                </>
              )}
              icon={FileCode2}
              metadata={file ? formatBytes(file.size) : undefined}
              monospace
              title={selectedEntry.path}
            />
            {loadingFile ? (
              <div className="flex h-full items-center justify-center gap-2 text-xs text-[#718488]">
                <LoaderCircle aria-hidden="true" className="animate-spin" size={15} />
                {t("projectFiles.loadingFile")}
              </div>
            ) : (
              <CodeSurface
                ariaLabel={t("resources.fileContent")}
                language={selectedEntry.language}
                onChange={setDraft}
                onSave={() => void saveFile()}
                value={draft}
              />
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="absolute bottom-3 left-1/2 z-40 flex max-w-[560px] -translate-x-1/2 items-center gap-3 border border-[#d8aaa6] bg-[#fff7f6] px-3 py-2 text-[10px] text-[#8b3f3a] shadow-lg" role="alert">
          <span className="min-w-0 flex-1">{error}</span>
          <button className="font-semibold hover:text-[#632b27]" onClick={() => setError(null)} type="button">{t("projectFiles.dismiss")}</button>
        </div>
      )}

      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4">
          <form
            aria-labelledby="project-file-dialog-title"
            aria-modal="true"
            className="w-full max-w-md border border-[#aebfc1] bg-white shadow-xl"
            onSubmit={(event) => void submitDialog(event)}
            role="dialog"
          >
            <div className="border-b border-[#d4dfdf] px-4 py-3">
              <h2 className="text-sm font-semibold text-[#29484c]" id="project-file-dialog-title">
                {t(`projectFiles.dialog.${dialog.kind}`)}
              </h2>
              <p className="mt-1 truncate font-mono text-[10px] text-[#718488]" title={(selectedEntry?.path ?? directory) || "/"}>
                {dialog.kind === "delete" ? selectedEntry?.path : `/${directory}`}
              </p>
            </div>
            <div className="px-4 py-4">
              {dialog.kind === "delete" ? (
                <p className="text-xs leading-5 text-[#536d72]">
                  {selectedEntry?.type === "directory"
                    ? t("projectFiles.deleteDirectoryConfirm", { name: selectedEntry.name })
                    : t("projectFiles.deleteFileConfirm", { name: selectedEntry?.name ?? "" })}
                </p>
              ) : (
                <label className="grid gap-1.5 text-[10px] font-semibold text-[#60777a]">
                  {t("projectFiles.name")}
                  <input
                    autoFocus
                    className="h-8 border border-[#c6d4d4] bg-white px-2 font-mono text-xs text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]"
                    onChange={(event) => setDialog({ ...dialog, value: event.target.value })}
                    required
                    value={dialog.value}
                  />
                </label>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-[#d4dfdf] bg-[#f6f9f8] px-4 py-3">
              <button
                className="h-8 px-3 text-[10px] font-semibold text-[#536d72] hover:bg-[#e5edec] disabled:opacity-40"
                disabled={busy}
                onClick={() => setDialog(null)}
                type="button"
              >
                {t("project.cancel")}
              </button>
              <button
                className={`flex h-8 items-center gap-1.5 px-3 text-[10px] font-semibold text-white disabled:opacity-40 ${dialog.kind === "delete" ? "bg-[#9a4b45] hover:bg-[#823c37]" : "bg-[#0c766e] hover:bg-[#095f59]"}`}
                disabled={busy || (dialog.kind !== "delete" && !dialog.value)}
                type="submit"
              >
                {busy
                  ? <LoaderCircle aria-hidden="true" className="animate-spin" size={12} />
                  : dialog.kind === "delete"
                    ? <Trash2 aria-hidden="true" size={12} />
                    : dialog.kind === "rename"
                      ? <Pencil aria-hidden="true" size={12} />
                      : dialog.kind === "create-directory"
                        ? <FolderPlus aria-hidden="true" size={12} />
                        : <FilePlus2 aria-hidden="true" size={12} />}
                {t(`projectFiles.action.${dialog.kind}`)}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
