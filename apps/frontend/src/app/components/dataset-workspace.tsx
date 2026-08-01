"use client";

import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Database,
  FileJson2,
  FolderGit2,
  HardDrive,
  Import,
  LoaderCircle,
  Pencil,
  Plus,
  Save,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  datasetApi,
  type DatasetRecord,
  type DatasetStorageType,
  type DatasetSummary,
} from "../dataset-api";
import { useI18n } from "../i18n";
import { resourceApi } from "../resource-api";
import CodeSurface from "./code-surface";
import ResizeHandle from "./resize-handle";
import { PanelHeader, SearchField, WorkspaceListPane } from "./workspace-ui";

type Modal = "create" | "import" | "edit" | null;

function ActionButton({
  children,
  disabled = false,
  onClick,
  primary = false,
  type = "button",
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  primary?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      className={primary
        ? "flex h-7 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#6cc9c0] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-[#a9b9b9]"
        : "flex h-7 items-center gap-1.5 border border-[#c6d4d4] bg-white px-2.5 text-[10px] font-semibold text-[#49666b] outline-none hover:bg-[#edf3f2] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-not-allowed disabled:text-[#9aa9ab]"}
      disabled={disabled}
      onClick={onClick}
      type={type}
    >
      {children}
    </button>
  );
}

function DatasetDialog({ children, onClose, title }: {
  children: ReactNode;
  onClose: () => void;
  title: string;
}) {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 z-30 flex items-start justify-center bg-[#18272c]/25 px-4 pt-14" role="presentation">
      <section
        aria-labelledby="dataset-dialog-title"
        aria-modal="true"
        className="w-full max-w-lg border border-[#9fb3b5] bg-white shadow-[0_12px_32px_rgba(24,39,44,0.18)]"
        role="dialog"
      >
        <header className="flex h-10 items-center justify-between border-b border-[#cbd8d9] bg-[#edf3f2] px-3">
          <h3 className="text-xs font-semibold text-[#29484c]" id="dataset-dialog-title">{title}</h3>
          <button
            aria-label={t("experiments.close")}
            className="flex h-7 w-7 items-center justify-center text-[#60777a] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
            onClick={onClose}
            title={t("experiments.close")}
            type="button"
          >
            <X aria-hidden="true" size={15} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

function storageIcon(storage: DatasetStorageType) {
  if (storage === "jsonl") return FileJson2;
  if (storage === "sqlite") return HardDrive;
  return FolderGit2;
}

function datasetPath(projectPath: string, name: string, storage: DatasetStorageType): string {
  const separator = projectPath.includes("\\") ? "\\" : "/";
  const slug = name.trim().toLowerCase().replaceAll(/[^a-z0-9_-]+/g, "-").replaceAll(/^-|-$/g, "") || "new-dataset";
  const base = `${projectPath.replace(/[\\/]$/, "")}${separator}datasets${separator}${slug}`;
  return storage === "jsonl" ? `${base}.jsonl` : storage === "sqlite" ? `${base}.sqlite` : base;
}

function tagsFromInput(value: string): string[] {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))];
}

function DatasetForm({
  dataset,
  onCancel,
  onSubmit,
  projectPath,
}: {
  dataset?: DatasetSummary;
  onCancel: () => void;
  onSubmit: (input: { name: string; storage: DatasetStorageType; path: string; tags: string[]; scoringPrompt: string }) => Promise<void>;
  projectPath: string;
}) {
  const { t } = useI18n();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState(dataset?.name ?? "");
  const [storage, setStorage] = useState<DatasetStorageType>(dataset?.storage ?? "sqlite");
  const [path, setPath] = useState(dataset?.path ?? datasetPath(projectPath, "", "sqlite"));
  const [tags, setTags] = useState(dataset?.tags.join(", ") ?? "");
  const [scoringPrompt, setScoringPrompt] = useState(dataset?.scoringPrompt ?? "");
  const [pathEdited, setPathEdited] = useState(Boolean(dataset));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        storage,
        path: path.trim(),
        tags: tagsFromInput(tags),
        scoringPrompt,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="grid gap-3 p-4" onSubmit={submit} ref={formRef}>
      <label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">
        {t("experiments.name")}
        <input
          autoFocus
          className="h-8 border border-[#c6d4d4] bg-white px-2 text-xs font-normal text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]"
          onChange={(event) => {
            const next = event.target.value;
            setName(next);
            if (!pathEdited) setPath(datasetPath(projectPath, next, storage));
          }}
          required
          value={name}
        />
      </label>
      {!dataset && (
        <label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">
          {t("experiments.storageType")}
          <select
            className="h-8 border border-[#c6d4d4] bg-white px-2 text-xs font-normal text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]"
            onChange={(event) => {
              const next = event.target.value as DatasetStorageType;
              setStorage(next);
              if (!pathEdited) setPath(datasetPath(projectPath, name, next));
            }}
            value={storage}
          >
            <option value="jsonl">{t("experiments.storageJsonl")}</option>
            <option value="sqlite">{t("experiments.storageSqlite")}</option>
            <option value="huggingface">{t("experiments.storageHuggingFace")}</option>
          </select>
        </label>
      )}
      {!dataset && (
        <label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">
          {t("experiments.storagePath")}
          <input
            className="h-8 border border-[#c6d4d4] bg-white px-2 font-mono text-[11px] font-normal text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]"
            onChange={(event) => {
              setPathEdited(true);
              setPath(event.target.value);
            }}
            required
            value={path}
          />
          <span className="font-normal text-[9px] text-[#718488]">{t("experiments.storagePathHint")}</span>
        </label>
      )}
      <label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">
        {t("experiments.tags")}
        <input
          className="h-8 border border-[#c6d4d4] bg-white px-2 text-xs font-normal text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]"
          onChange={(event) => setTags(event.target.value)}
          placeholder={t("experiments.tagsHint")}
          value={tags}
        />
      </label>
      <label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">
        {t("experiments.scoringPrompt")}
        <span className="h-28 overflow-hidden border border-[#c6d4d4] bg-white font-normal focus-within:border-[#0c766e] focus-within:ring-1 focus-within:ring-[#0c766e]">
          <CodeSurface
            ariaLabel={t("experiments.scoringPrompt")}
            language="Markdown"
            lineNumbers={false}
            lineWrapping
            onChange={setScoringPrompt}
            onSave={() => formRef.current?.requestSubmit()}
            placeholder={t("experiments.scoringPromptPlaceholder")}
            statusBar={false}
            value={scoringPrompt}
          />
        </span>
        <span className="font-normal text-[9px] text-[#718488]">{t("experiments.scoringPromptHint")}</span>
      </label>
      {error && <p className="border-l-2 border-[#b14c4c] bg-[#f8eded] px-2 py-1.5 text-[10px] text-[#843d3d]">{error}</p>}
      <div className="mt-1 flex justify-end gap-2 border-t border-[#d8e2e2] pt-3">
        <ActionButton onClick={onCancel}>{t("experiments.cancel")}</ActionButton>
        <ActionButton disabled={saving || !name.trim() || !path.trim()} primary type="submit">
          {saving && <LoaderCircle aria-hidden="true" className="animate-spin" size={12} />}
          {dataset ? t("experiments.save") : t("experiments.create")}
        </ActionButton>
      </div>
    </form>
  );
}

function ImportForm({ onCancel, onSubmit, projectPath }: {
  onCancel: () => void;
  onSubmit: (path: string) => Promise<void>;
  projectPath: string;
}) {
  const { t } = useI18n();
  const [path, setPath] = useState(projectPath);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSubmit(path.trim());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="grid gap-3 p-4" onSubmit={submit}>
      <label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">
        {t("experiments.importPath")}
        <input
          autoFocus
          className="h-8 border border-[#c6d4d4] bg-white px-2 font-mono text-[11px] font-normal text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]"
          onChange={(event) => setPath(event.target.value)}
          required
          value={path}
        />
      </label>
      <p className="text-[10px] leading-4 text-[#718488]">{t("experiments.importPathHint")}</p>
      {error && <p className="border-l-2 border-[#b14c4c] bg-[#f8eded] px-2 py-1.5 text-[10px] text-[#843d3d]">{error}</p>}
      <div className="flex justify-end gap-2 border-t border-[#d8e2e2] pt-3">
        <ActionButton onClick={onCancel}>{t("experiments.cancel")}</ActionButton>
        <ActionButton disabled={saving || !path.trim()} primary type="submit">
          {saving && <LoaderCircle aria-hidden="true" className="animate-spin" size={12} />}
          {t("experiments.import")}
        </ActionButton>
      </div>
    </form>
  );
}

function DatasetList({
  datasets,
  disabled,
  error,
  loading,
  onEdit,
  onImport,
  onNew,
  onOpen,
  onRemove,
  onRetry,
}: {
  datasets: DatasetSummary[];
  disabled: boolean;
  error: string | null;
  loading: boolean;
  onEdit: (dataset: DatasetSummary) => void;
  onImport: () => void;
  onNew: () => void;
  onOpen: (dataset: DatasetSummary) => void;
  onRemove: (dataset: DatasetSummary) => void;
  onRetry: () => void;
}) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(() => datasets.filter((dataset) =>
    `${dataset.name} ${dataset.path} ${dataset.storage} ${dataset.tags.join(" ")}`.toLowerCase().includes(normalizedQuery)),
  [datasets, normalizedQuery]);

  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_auto_1fr] bg-[#f8faf9]">
      <PanelHeader
        actions={(
          <>
            <ActionButton disabled={disabled} onClick={onImport}><Import aria-hidden="true" size={13} />{t("experiments.import")}</ActionButton>
            <ActionButton disabled={disabled} onClick={onNew} primary><Plus aria-hidden="true" size={13} />{t("experiments.newDataset")}</ActionButton>
          </>
        )}
        metadata={t("experiments.datasetCount", { count: datasets.length })}
        title={t("experiments.datasets")}
        variant="workspace"
      />
      <div className="flex h-11 items-center justify-between gap-3 border-b border-[#d8e2e2] bg-[#f3f7f6] px-3">
        <SearchField label={t("experiments.searchDatasets")} onChange={setQuery} value={query} width="w-64 max-w-full" />
        <span className="font-mono text-[10px] text-[#718488]">{t("experiments.resultCount", { count: visible.length })}</span>
      </div>
      <div className="minimal-scrollbar min-h-0 overflow-auto bg-white">
        {error ? (
          <div className="flex h-40 flex-col items-center justify-center gap-3 px-6 text-center text-xs text-[#843d3d]">
            <span>{error}</span>
            <ActionButton onClick={onRetry}>{t("experiments.retry")}</ActionButton>
          </div>
        ) : loading ? (
          <div className="flex h-40 items-center justify-center gap-2 text-xs text-[#718488]">
            <LoaderCircle aria-hidden="true" className="animate-spin" size={15} />
            {t("experiments.loadingDatasets")}
          </div>
        ) : (
          <>
            <table className="w-full min-w-[820px] table-fixed border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-[#edf3f2] text-[9px] font-semibold uppercase text-[#657b7f]">
                <tr className="h-8 border-b border-[#cbd8d9]">
                  <th className="w-[24%] px-3">{t("experiments.datasetName")}</th>
                  <th className="w-[12%] px-3">{t("experiments.storageType")}</th>
                  <th className="w-[9%] px-3 text-right">{t("experiments.samples")}</th>
                  <th className="w-[31%] px-3">{t("experiments.storagePath")}</th>
                  <th className="w-[14%] px-3">{t("experiments.updatedAt")}</th>
                  <th className="w-[10%] px-3 text-right">{t("experiments.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((dataset) => {
                  const StorageIcon = storageIcon(dataset.storage);
                  return (
                    <tr className="h-14 border-b border-[#e0e8e8] text-[11px] hover:bg-[#f3f7f6]" key={dataset.id}>
                      <td className="px-3">
                        <button className="flex min-w-0 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e]" onClick={() => onOpen(dataset)} type="button">
                          <Database aria-hidden="true" className="shrink-0 text-[#507a78]" size={15} />
                          <span className="min-w-0">
                            <span className="block truncate font-mono font-semibold text-[#29484c]">{dataset.name}</span>
                            <span className="mt-0.5 block truncate text-[9px] text-[#718488]">QTA · v{dataset.version}</span>
                          </span>
                        </button>
                      </td>
                      <td className="px-3">
                        <span className="inline-flex items-center gap-1 border border-[#cbd9d8] bg-[#eef4f3] px-1.5 py-0.5 font-mono text-[9px] text-[#526b70]">
                          <StorageIcon aria-hidden="true" size={11} />
                          {dataset.storage}
                        </span>
                      </td>
                      <td className="px-3 text-right font-mono text-[#526b70]">{dataset.samples}</td>
                      <td className="truncate px-3 font-mono text-[10px] text-[#526b70]" title={dataset.path}>{dataset.path}</td>
                      <td className="px-3 font-mono text-[9px] text-[#718488]">
                        {new Intl.DateTimeFormat(locale === "en" ? "en-US" : "zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(dataset.updatedAt))}
                      </td>
                      <td className="px-3">
                        <div className="flex justify-end gap-0.5">
                          <button aria-label={t("experiments.editDataset")} className="flex h-7 w-7 items-center justify-center text-[#60777a] outline-none hover:bg-[#dfecea] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" onClick={() => onEdit(dataset)} title={t("experiments.editDataset")} type="button"><Pencil aria-hidden="true" size={13} /></button>
                          <button aria-label={t("experiments.removeDataset")} className="flex h-7 w-7 items-center justify-center text-[#8a5555] outline-none hover:bg-[#f3e7e7] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#a74d4d]" onClick={() => onRemove(dataset)} title={t("experiments.removeDataset")} type="button"><Trash2 aria-hidden="true" size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length === 0 && <div className="flex h-32 items-center justify-center text-xs text-[#718488]">{t("experiments.noDatasets")}</div>}
          </>
        )}
      </div>
    </section>
  );
}

type RecordDraft = Pick<DatasetRecord, "question" | "thinking" | "answer" | "expectedTools"> & { tags: string };
type RecordTextField = "question" | "thinking" | "answer" | "tags";

function RecordEditor({ availableTools, dataset, onDelete, onSave, record }: {
  availableTools: string[];
  dataset: DatasetSummary;
  onDelete: (record: DatasetRecord) => Promise<void>;
  onSave: (record: DatasetRecord | null, draft: RecordDraft) => Promise<DatasetRecord>;
  record: DatasetRecord | null;
}) {
  const { t } = useI18n();
  const isNew = record === null;
  const [draft, setDraft] = useState<RecordDraft>({
    question: record?.question ?? "",
    thinking: record?.thinking ?? "",
    answer: record?.answer ?? "",
    expectedTools: record?.expectedTools ?? [],
    tags: record?.metadata.tags.join(", ") ?? "",
  });
  const [toolInput, setToolInput] = useState("");
  const [dirty, setDirty] = useState(isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = (field: RecordTextField, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setDirty(true);
  };
  const addExpectedTool = () => {
    const name = toolInput.trim();
    if (!name) return;
    setDraft((current) => current.expectedTools.includes(name)
      ? current
      : { ...current, expectedTools: [...current.expectedTools, name] });
    setToolInput("");
    setDirty(true);
  };
  const removeExpectedTool = (name: string) => {
    setDraft((current) => ({
      ...current,
      expectedTools: current.expectedTools.filter((tool) => tool !== name),
    }));
    setDirty(true);
  };
  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await onSave(record, draft);
      setDraft({
        question: saved.question,
        thinking: saved.thinking,
        answer: saved.answer,
        expectedTools: saved.expectedTools,
        tags: saved.metadata.tags.join(", "),
      });
      setDirty(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="grid h-full min-h-0 grid-rows-[34px_auto_minmax(0,1fr)] bg-[#f8faf9]" id="dataset-record-editor">
      <PanelHeader
        actions={(
          <>
            {record && <button aria-label={t("experiments.deleteSample")} className="flex h-7 w-7 items-center justify-center text-[#8a5555] outline-none hover:bg-[#f3e7e7] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#a74d4d]" onClick={() => void onDelete(record)} title={t("experiments.deleteSample")} type="button"><Trash2 aria-hidden="true" size={13} /></button>}
            <ActionButton disabled={!dirty || saving} onClick={() => void save()} primary>
              {saving ? <LoaderCircle aria-hidden="true" className="animate-spin" size={12} /> : <Save aria-hidden="true" size={12} />}
              {t("experiments.save")}
            </ActionButton>
          </>
        )}
        metadata={dirty ? t("experiments.unsaved") : t("experiments.saved")}
        title={isNew ? t("experiments.newSample") : `${t("experiments.sample")} · ${record.id}`}
      />
      <div className="grid gap-1.5 border-b border-[#d9e3e3] bg-white px-3 py-1.5">
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(160px,0.45fr)] items-center gap-3">
          <span className="truncate font-mono text-[9px] text-[#718488]" title={dataset.path}>{dataset.storage} · {dataset.path}</span>
          <label className="flex min-w-0 items-center gap-2 text-[9px] font-semibold text-[#657b7f]">
            <span className="shrink-0">{t("experiments.tags")}</span>
            <input className="h-6 min-w-0 flex-1 border border-[#c6d4d4] bg-white px-1.5 font-mono text-[10px] font-normal text-[#294247] outline-none focus:border-[#0c766e]" onChange={(event) => change("tags", event.target.value)} placeholder={t("experiments.tagsHint")} value={draft.tags} />
          </label>
        </div>
        <div className="flex min-w-0 items-center gap-1.5" role="group" aria-label={t("experiments.expectedTools")}>
          <span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold text-[#657b7f]"><Wrench aria-hidden="true" size={11} />{t("experiments.expectedTools")}</span>
          <div className="minimal-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5">
            {draft.expectedTools.map((name) => (
              <span className="flex h-6 shrink-0 items-center gap-1 border border-[#bdd0ce] bg-[#edf4f2] pl-1.5 font-mono text-[9px] text-[#355b5c]" key={name}>
                {name}
                <button aria-label={t("experiments.removeExpectedTool", { name })} className="flex h-5 w-5 items-center justify-center text-[#6b8083] outline-none hover:bg-[#dce9e7] hover:text-[#8a5555] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#0c766e]" onClick={() => removeExpectedTool(name)} title={t("experiments.removeExpectedTool", { name })} type="button"><X aria-hidden="true" size={10} /></button>
              </span>
            ))}
            {draft.expectedTools.length === 0 && <span className="shrink-0 text-[9px] text-[#91a0a2]">{t("experiments.noExpectedTools")}</span>}
          </div>
          <input
            aria-label={t("experiments.toolName")}
            className="h-6 w-36 shrink-0 border border-[#c6d4d4] bg-white px-1.5 font-mono text-[9px] text-[#294247] outline-none focus:border-[#0c766e]"
            list="dataset-tool-suggestions"
            onChange={(event) => setToolInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addExpectedTool();
            }}
            placeholder={t("experiments.toolName")}
            value={toolInput}
          />
          <datalist id="dataset-tool-suggestions">
            {availableTools.filter((name) => !draft.expectedTools.includes(name)).map((name) => <option key={name} value={name} />)}
          </datalist>
          <button aria-label={t("experiments.addExpectedTool")} className="flex h-6 w-6 shrink-0 items-center justify-center border border-[#c6d4d4] bg-white text-[#49666b] outline-none hover:bg-[#edf3f2] focus-visible:ring-1 focus-visible:ring-[#0c766e] disabled:text-[#a9b9b9]" disabled={!toolInput.trim()} onClick={addExpectedTool} title={t("experiments.addExpectedTool")} type="button"><Plus aria-hidden="true" size={12} /></button>
        </div>
      </div>
      <div className="grid min-h-0 grid-rows-3 divide-y divide-[#cbd8d9]">
        {([
          ["question", t("experiments.question")],
          ["thinking", t("experiments.thinking")],
          ["answer", t("experiments.answer")],
        ] as const).map(([field, label]) => (
          <section className="grid min-h-0 grid-rows-[24px_minmax(0,1fr)]" key={field}>
            <header className="flex items-center justify-between bg-[#edf3f2] px-2.5">
              <span className="text-[9px] font-semibold uppercase text-[#657b7f]">{label}</span>
              <span className="font-mono text-[9px] text-[#829397]">{draft[field].length}</span>
            </header>
            <CodeSurface
              ariaLabel={label}
              language="Markdown"
              lineNumbers={false}
              lineWrapping
              onChange={(value) => change(field, value)}
              onSave={() => void save()}
              placeholder={t(`experiments.${field}Placeholder`)}
              statusBar={false}
              value={draft[field]}
            />
          </section>
        ))}
      </div>
      {error && <div className="absolute bottom-3 right-3 z-20 max-w-md border border-[#d5a2a2] bg-[#f8eded] px-3 py-2 text-[10px] text-[#843d3d] shadow-sm">{error}</div>}
    </section>
  );
}

function DatasetDetail({ dataset, onBack, onDatasetChanged, projectPath }: {
  dataset: DatasetSummary;
  onBack: () => void;
  onDatasetChanged: (dataset: DatasetSummary) => void;
  projectPath: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [records, setRecords] = useState<DatasetRecord[]>([]);
  const [total, setTotal] = useState(dataset.samples);
  const [selected, setSelected] = useState<DatasetRecord | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [listWidth, setListWidth] = useState(300);
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const limit = 50;

  useEffect(() => {
    let active = true;
    void resourceApi.catalog(projectPath)
      .then((catalog) => {
        if (!active) return;
        const names = catalog.items.flatMap((module) => module.kind === "tool"
          ? module.tools.map((tool) => tool.name)
          : []);
        setAvailableTools([...new Set(names)].sort((left, right) => left.localeCompare(right)));
      })
      .catch(() => {
        if (active) setAvailableTools([]);
      });
    return () => { active = false; };
  }, [projectPath]);

  const load = useCallback(async (preferredId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await datasetApi.records(projectPath, dataset.id, query, offset, limit);
      setRecords(page.items);
      setTotal(page.total);
      setSelected((current) => {
        if (current === null) return current;
        const id = preferredId ?? current?.id;
        return page.items.find((item) => item.id === id) ?? page.items[0];
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [dataset.id, limit, offset, projectPath, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 120);
    return () => window.clearTimeout(timer);
  }, [load]);

  const save = async (record: DatasetRecord | null, draft: RecordDraft) => {
    const input = {
      question: draft.question,
      thinking: draft.thinking,
      answer: draft.answer,
      expectedTools: draft.expectedTools,
      metadata: { tags: tagsFromInput(draft.tags) },
    };
    const saved = record
      ? await datasetApi.updateRecord(projectPath, dataset.id, { ...record, ...input, metadata: { ...record.metadata, ...input.metadata } })
      : await datasetApi.createRecord(projectPath, dataset.id, input);
    setSelected(saved);
    await load(saved.id);
    onDatasetChanged(await datasetApi.get(projectPath, dataset.id));
    return saved;
  };

  const deleteRecord = async (record: DatasetRecord) => {
    if (!window.confirm(t("experiments.deleteSampleConfirm"))) return;
    await datasetApi.deleteRecord(projectPath, dataset.id, record.id);
    setSelected(undefined);
    await load();
    onDatasetChanged(await datasetApi.get(projectPath, dataset.id));
  };

  const page = Math.floor(offset / limit) + 1;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  return (
    <section className="grid h-full min-h-0 grid-rows-[auto_1fr] bg-[#f8faf9]">
      <PanelHeader
        actions={<ActionButton onClick={() => setSelected(null)} primary><Plus aria-hidden="true" size={13} />{t("experiments.newSample")}</ActionButton>}
        metadata={`${dataset.storage} · ${dataset.path}`}
        title={(
          <span className="flex min-w-0 items-center gap-2">
            <button aria-label={t("experiments.backToDatasets")} className="flex h-7 w-7 shrink-0 items-center justify-center text-[#60777a] outline-none hover:bg-[#edf3f2] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" onClick={onBack} title={t("experiments.backToDatasets")} type="button"><ArrowLeft aria-hidden="true" size={15} /></button>
            <span className="truncate">{dataset.name}</span>
          </span>
        )}
        variant="workspace"
      />
      <div className="grid min-h-0" style={{ gridTemplateColumns: `${listWidth}px 1px minmax(0, 1fr)` }}>
        <WorkspaceListPane
          countLabel={t("experiments.sampleCount", { count: total })}
          empty={records.length === 0}
          emptyLabel={error ?? t("experiments.noSamples")}
          id="dataset-sample-list"
          loading={loading}
          loadingLabel={t("experiments.loadingSamples")}
          onQueryChange={(value) => { setQuery(value); setOffset(0); }}
          query={query}
          searchLabel={t("experiments.searchSamples")}
          title={t("experiments.samples")}
        >
          <div className="divide-y divide-[#dfe7e7]">
            {records.map((record) => (
              <button
                aria-current={selected?.id === record.id ? "true" : undefined}
                className={`grid w-full gap-1 px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${selected?.id === record.id ? "bg-[#d9e9e6]" : "bg-white hover:bg-[#eef4f3]"}`}
                key={record.id}
                onClick={() => setSelected(record)}
                type="button"
              >
                <span className="line-clamp-2 text-[11px] leading-4 text-[#29484c]">{record.question || t("experiments.untitledSample")}</span>
                <span className="flex min-w-0 items-center justify-between gap-2 font-mono text-[9px] text-[#718488]">
                  <span className="truncate">{record.id}</span>
                  <span className="shrink-0">{record.metadata.tags.slice(0, 2).join(" · ")}</span>
                </span>
              </button>
            ))}
          </div>
          {total > limit && (
            <div className="sticky bottom-0 flex h-8 items-center justify-between border-t border-[#cbd8d9] bg-[#edf3f2] px-2">
              <button aria-label={t("experiments.previousPage")} className="flex h-6 w-6 items-center justify-center text-[#60777a] disabled:text-[#a9b9b9]" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))} type="button"><ChevronLeft aria-hidden="true" size={13} /></button>
              <span className="font-mono text-[9px] text-[#718488]">{page} / {pageCount}</span>
              <button aria-label={t("experiments.nextPage")} className="flex h-6 w-6 items-center justify-center text-[#60777a] disabled:text-[#a9b9b9]" disabled={offset + limit >= total} onClick={() => setOffset(offset + limit)} type="button"><ChevronRight aria-hidden="true" size={13} /></button>
            </div>
          )}
        </WorkspaceListPane>
        <ResizeHandle controls="dataset-sample-list dataset-record-editor" defaultValue={300} label={t("experiments.resizeSamples")} maximum={520} minimum={220} onChange={setListWidth} value={listWidth} valueText={`${listWidth}px`} />
        <div className="relative min-h-0 min-w-0">
          {selected !== undefined ? (
            <RecordEditor
              availableTools={availableTools}
              dataset={dataset}
              key={selected?.id ?? "new"}
              onDelete={deleteRecord}
              onSave={save}
              record={selected}
            />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-[#718488]">{t("experiments.selectSample")}</div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function DatasetWorkspace({ projectPath }: { projectPath: string }) {
  const { t } = useI18n();
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selected, setSelected] = useState<DatasetSummary | null>(null);
  const [editing, setEditing] = useState<DatasetSummary | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    if (!projectPath) {
      setDatasets([]);
      setLoading(false);
      setError(t("experiments.selectProjectFirst"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await datasetApi.list(projectPath);
      if (generation !== loadGeneration.current) return;
      setDatasets(result.items);
      setSelected((current) => current ? result.items.find((item) => item.id === current.id) ?? null : null);
    } catch (reason) {
      if (generation !== loadGeneration.current) return;
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [projectPath, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, projectPath]);

  const upsert = (dataset: DatasetSummary) => {
    loadGeneration.current += 1;
    setLoading(false);
    setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)]);
    setSelected((current) => current?.id === dataset.id ? dataset : current);
  };

  if (selected) {
    return <DatasetDetail dataset={selected} onBack={() => setSelected(null)} onDatasetChanged={upsert} projectPath={projectPath} />;
  }

  return (
    <div className="relative h-full min-h-0">
      <DatasetList
        datasets={datasets}
        disabled={!projectPath}
        error={error}
        loading={loading}
        onEdit={(dataset) => { setEditing(dataset); setModal("edit"); }}
        onImport={() => setModal("import")}
        onNew={() => setModal("create")}
        onOpen={setSelected}
        onRemove={(dataset) => {
          if (!window.confirm(t("experiments.removeDatasetConfirm", { name: dataset.name }))) return;
          void datasetApi.remove(projectPath, dataset.id)
            .then(() => {
              loadGeneration.current += 1;
              setDatasets((current) => current.filter((item) => item.id !== dataset.id));
            })
            .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
        }}
        onRetry={() => void load()}
      />
      {modal === "create" && (
        <DatasetDialog onClose={() => setModal(null)} title={t("experiments.newDataset")}>
          <DatasetForm
            onCancel={() => setModal(null)}
            onSubmit={async (input) => {
              upsert(await datasetApi.create(projectPath, input));
              setModal(null);
            }}
            projectPath={projectPath}
          />
        </DatasetDialog>
      )}
      {modal === "import" && (
        <DatasetDialog onClose={() => setModal(null)} title={t("experiments.importDataset")}>
          <ImportForm
            onCancel={() => setModal(null)}
            onSubmit={async (path) => {
              upsert(await datasetApi.import(projectPath, path));
              setModal(null);
            }}
            projectPath={projectPath}
          />
        </DatasetDialog>
      )}
      {modal === "edit" && editing && (
        <DatasetDialog onClose={() => setModal(null)} title={t("experiments.datasetSettings")}>
          <DatasetForm
            dataset={editing}
            onCancel={() => setModal(null)}
            onSubmit={async (input) => {
              upsert(await datasetApi.update(projectPath, editing.id, {
                name: input.name,
                tags: input.tags,
                scoringPrompt: input.scoringPrompt,
              }));
              setModal(null);
            }}
            projectPath={projectPath}
          />
        </DatasetDialog>
      )}
    </div>
  );
}
