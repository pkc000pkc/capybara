"use client";

import {
  AlertCircle,
  BookOpen,
  Boxes,
  CheckCircle2,
  FlaskConical,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Play,
  Save,
  Stethoscope,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import {
  resourceApi,
  type ProjectResourceModule,
  type ResourceDefinition,
  type ResourceFileContent,
  type ResourceKind,
} from "../resource-api";
import type { RuntimeToolsState } from "../runtime-protocol";
import CodeSurface from "./code-surface";
import ResizeHandle from "./resize-handle";
import {
  PanelHeader,
  WorkspaceListPane,
  WorkspaceTabs,
  type WorkspaceTab,
} from "./workspace-ui";

type EditorTab = "files" | "definitions";
type EvaluationTab = "test" | "diagnostics";
type TestStatus = "idle" | "running" | "success" | "error";
type DefinitionResourceKind = Exclude<ResourceKind, "hook">;
type DefinitionResourceModule = Exclude<ProjectResourceModule, { kind: "hook" }>;
type DefinitionResource = Exclude<ResourceDefinition, { kind: "hook" }>;

const DETAIL_DIVIDER_SIZE = 1;
const EDITOR_MIN_HEIGHT = 180;
const EDITOR_FRAME_HEIGHT = 60;
const EVALUATION_DEFAULT_HEIGHT = 240;
const EVALUATION_MIN_HEIGHT = 140;
const EVALUATION_MAX_HEIGHT = 420;
const TEST_PANE_DIVIDER_SIZE = 1;
const TEST_PANE_MIN_WIDTH = 220;
const TEST_INPUT_FALLBACK_WIDTH = 360;

function definitions(resourceModule?: DefinitionResourceModule): DefinitionResource[] {
  if (!resourceModule) return [];
  if (resourceModule.kind === "tool") return resourceModule.tools;
  return resourceModule.kind === "skill" ? resourceModule.skills : resourceModule.harnesses;
}

function initialTestInput(definition?: DefinitionResource): string {
  if (definition?.kind === "skill") return "{}";
  return JSON.stringify(definition?.examples[0] ?? {}, null, 2);
}

function definitionText(definition: DefinitionResource, draft: string): string {
  return definition.kind === "tool" ? JSON.stringify(definition, null, 2) : draft;
}

export default function ResourceDefinitionWorkspace({
  catalogWidth,
  divider,
  kind,
  projectPath,
  runtimeTools,
}: {
  catalogWidth: number;
  divider: ReactNode;
  kind: DefinitionResourceKind;
  projectPath: string;
  runtimeTools?: RuntimeToolsState;
}) {
  const { t } = useI18n();
  const [modules, setModules] = useState<DefinitionResourceModule[]>([]);
  const [selectedModuleId, setSelectedModuleId] = useState("");
  const [selectedDefinitionId, setSelectedDefinitionId] = useState("");
  const [query, setQuery] = useState("");
  const [editorTab, setEditorTab] = useState<EditorTab>(
    kind === "skill" ? "definitions" : "files",
  );
  const [evaluationTab, setEvaluationTab] = useState<EvaluationTab>("test");
  const [evaluationHeight, setEvaluationHeight] = useState(EVALUATION_DEFAULT_HEIGHT);
  const [detailAreaHeight, setDetailAreaHeight] = useState(
    EDITOR_MIN_HEIGHT + DETAIL_DIVIDER_SIZE + EVALUATION_DEFAULT_HEIGHT,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [file, setFile] = useState<ResourceFileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [input, setInput] = useState("{}");
  const [output, setOutput] = useState("");
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testAreaWidth, setTestAreaWidth] = useState(0);
  const [testInputWidth, setTestInputWidth] = useState(TEST_INPUT_FALLBACK_WIDTH);
  const fileRequest = useRef(0);
  const saveRequest = useRef(false);
  const testRequest = useRef(0);
  const detailArea = useRef<HTMLDivElement>(null);
  const testArea = useRef<HTMLDivElement>(null);
  const testInputResized = useRef(false);
  const kindPath = kind === "harness" ? "harnesses" : `${kind}s`;

  useEffect(() => {
    let active = true;
    void resourceApi.catalog(projectPath).then((catalog) => {
      if (!active) return;
      const next = catalog.items.filter(
        (item): item is DefinitionResourceModule => item.kind !== "hook" && item.kind === kind,
      );
      const firstModule = next[0];
      const firstDefinition = definitions(firstModule)[0];
      const firstFile = firstModule?.files[0]?.path ?? "";
      setModules(next);
      setSelectedModuleId(firstModule?.id ?? "");
      setSelectedDefinitionId(firstDefinition?.id ?? "");
      setDraft(firstDefinition?.kind === "tool" ? "" : firstDefinition?.content ?? "");
      setInput(initialTestInput(firstDefinition));
      setSelectedFilePath(firstFile);
      setError(null);
      if (firstFile) {
        const requestId = ++fileRequest.current;
        setFileLoading(true);
        void resourceApi.file(projectPath, firstFile).then((nextFile) => {
          if (active && fileRequest.current === requestId) setFile(nextFile);
        }).catch((reason: unknown) => {
          if (active && fileRequest.current === requestId) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }).finally(() => {
          if (active && fileRequest.current === requestId) setFileLoading(false);
        });
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [kind, projectPath]);

  useEffect(() => {
    const element = detailArea.current;
    if (!element) return;
    const resize = () => {
      const height = element.clientHeight;
      const maximum = Math.min(
        EVALUATION_MAX_HEIGHT,
        Math.max(
          EVALUATION_MIN_HEIGHT,
          height - EDITOR_FRAME_HEIGHT - EDITOR_MIN_HEIGHT - DETAIL_DIVIDER_SIZE,
        ),
      );
      setDetailAreaHeight(height);
      setEvaluationHeight((current) => Math.min(current, maximum));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading]);

  useEffect(() => {
    if (evaluationTab !== "test") return;
    const element = testArea.current;
    if (!element) return;
    const resize = () => {
      const width = element.clientWidth;
      const maximum = Math.max(
        TEST_PANE_MIN_WIDTH,
        width - TEST_PANE_DIVIDER_SIZE - TEST_PANE_MIN_WIDTH,
      );
      const centered = Math.min(
        maximum,
        Math.max(TEST_PANE_MIN_WIDTH, Math.round((width - TEST_PANE_DIVIDER_SIZE) / 2)),
      );
      setTestAreaWidth(width);
      setTestInputWidth((current) => {
        if (!testInputResized.current) return centered;
        return Math.min(Math.max(current, TEST_PANE_MIN_WIDTH), maximum);
      });
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [evaluationTab, loading]);

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = useMemo(() => modules.filter((resourceModule) => {
    const childNames = definitions(resourceModule).map((item) => item.name).join(" ");
    return `${resourceModule.name} ${resourceModule.source} ${childNames}`.toLowerCase().includes(normalizedQuery);
  }), [modules, normalizedQuery]);
  const selectedModule = modules.find((resourceModule) => resourceModule.id === selectedModuleId) ?? modules[0];
  const selectedDefinitions = definitions(selectedModule);
  const selectedDefinition = selectedDefinitions.find(
    (definition) => definition.id === selectedDefinitionId,
  ) ?? selectedDefinitions[0];
  const dirty = selectedDefinition !== undefined
    && selectedDefinition.kind !== "tool"
    && draft !== selectedDefinition.content;
  const attachedCount = selectedModule?.kind === "tool"
    ? selectedModule.tools.filter((tool) => runtimeTools?.items.some((item) => item.id === tool.id)).length
    : 0;
  const mutatesProject = selectedDefinition?.kind === "tool" && selectedDefinition.permissions.some(
    (permission) => permission === "filesystem:write"
      || permission === "filesystem:delete"
      || permission === "process:execute",
  );

  const countLabel = (resourceModule: DefinitionResourceModule) => resourceModule.kind === "tool"
    ? t("resources.toolCount", { count: resourceModule.tools.length })
    : resourceModule.kind === "skill"
      ? t("resources.skillCount", { count: resourceModule.skills.length })
      : t("resources.harnessCount", { count: resourceModule.harnesses.length });

  const openFile = async (path: string) => {
    const requestId = ++fileRequest.current;
    setSelectedFilePath(path);
    setFileLoading(true);
    try {
      const next = await resourceApi.file(projectPath, path);
      if (fileRequest.current === requestId) {
        setFile(next);
        setError(null);
      }
    } catch (reason) {
      if (fileRequest.current === requestId) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (fileRequest.current === requestId) setFileLoading(false);
    }
  };

  const selectModule = (resourceModule: DefinitionResourceModule) => {
    const firstDefinition = definitions(resourceModule)[0];
    const firstFile = resourceModule.files[0]?.path ?? "";
    fileRequest.current += 1;
    testRequest.current += 1;
    setSelectedModuleId(resourceModule.id);
    setSelectedDefinitionId(firstDefinition?.id ?? "");
    setDraft(firstDefinition?.kind === "tool" ? "" : firstDefinition?.content ?? "");
    setInput(initialTestInput(firstDefinition));
    setOutput("");
    setTestStatus("idle");
    setSelectedFilePath(firstFile);
    setFile(null);
    setFileLoading(false);
    if (editorTab === "files" && firstFile) void openFile(firstFile);
  };

  const selectDefinition = (definition: DefinitionResource) => {
    testRequest.current += 1;
    setSelectedDefinitionId(definition.id);
    setDraft(definition.kind === "tool" ? "" : definition.content);
    setInput(initialTestInput(definition));
    setOutput("");
    setTestStatus("idle");
  };

  const selectEditorTab = (next: EditorTab) => {
    setEditorTab(next);
    if (next === "files" && selectedFilePath && !file) void openFile(selectedFilePath);
  };

  const save = async () => {
    if (!selectedModule || !selectedDefinition || selectedDefinition.kind === "tool" || !dirty || saveRequest.current) return;
    saveRequest.current = true;
    setSaving(true);
    try {
      const saved = selectedDefinition.kind === "skill"
        ? await resourceApi.saveSkill(
            projectPath,
            selectedDefinition.id,
            draft,
            selectedDefinition.entryRevision,
          )
        : await resourceApi.saveHarness(
            projectPath,
            selectedDefinition.id,
            draft,
            selectedDefinition.entryRevision,
          );
      const savedDefinition = saved.kind === "skill"
        ? saved.skills.find((skill) => skill.id === selectedDefinition.id)
        : saved.harnesses.find((harness) => harness.id === selectedDefinition.id);
      setModules((current) => current.map((resourceModule) => resourceModule.id === saved.id ? saved : resourceModule));
      if (savedDefinition) setDraft(savedDefinition.content);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      saveRequest.current = false;
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!selectedDefinition || testStatus === "running") return;
    const requestId = ++testRequest.current;
    setTestStatus("running");
    try {
      const parsed: unknown = JSON.parse(input);
      const result = selectedDefinition.kind === "tool"
        ? await resourceApi.testTool(projectPath, selectedDefinition.id, parsed)
        : selectedDefinition.kind === "skill"
          ? await resourceApi.testSkill(projectPath, selectedDefinition.id, parsed)
          : await resourceApi.testHarness(projectPath, selectedDefinition.id, parsed);
      if (testRequest.current === requestId) {
        setOutput(JSON.stringify(result, null, 2));
        setTestStatus("success");
        setError(null);
      }
    } catch (reason) {
      if (testRequest.current === requestId) {
        setOutput(JSON.stringify({ error: reason instanceof Error ? reason.message : String(reason) }, null, 2));
        setTestStatus("error");
      }
    }
  };

  const handleModuleClick = (event: MouseEvent<HTMLButtonElement>) => {
    const resourceModule = modules.find((item) => item.id === event.currentTarget.value);
    if (resourceModule) selectModule(resourceModule);
  };

  const handleDefinitionClick = (event: MouseEvent<HTMLButtonElement>) => {
    const definition = selectedDefinitions.find((item) => item.id === event.currentTarget.value);
    if (definition) selectDefinition(definition);
  };

  const handleFileClick = (event: MouseEvent<HTMLButtonElement>) => {
    void openFile(event.currentTarget.value);
  };

  const handleSave = () => { void save(); };
  const handleRunTest = () => { void runTest(); };
  const handleInputChange = (value: string) => {
    setInput(value);
    setTestStatus("idle");
  };
  const handleTestInputResize = (value: number) => {
    testInputResized.current = true;
    setTestInputWidth(value);
  };

  const editorTabs: WorkspaceTab<EditorTab>[] = [
    { controls: "resource-editor-content", id: "files", icon: FolderOpen, label: t("resources.filesTab") },
    {
      controls: "resource-editor-content",
      id: "definitions",
      icon: kind === "tool" ? Wrench : kind === "skill" ? BookOpen : Layers3,
      label: kind === "skill"
        ? t("resources.skillFileTab")
        : kind === "tool" ? t("resources.tools") : t("resources.harnesses"),
    },
  ];
  const evaluationTabs: WorkspaceTab<EvaluationTab>[] = [
    {
      controls: "resource-evaluation-content",
      id: "test",
      icon: FlaskConical,
      label: kind === "skill" ? t("resources.previewTab") : t("resources.testTab"),
    },
    {
      badge: selectedModule && selectedModule.diagnostics.length > 0
        ? <span className="font-mono text-[8px] text-[#a34b40]">{selectedModule.diagnostics.length}</span>
        : undefined,
      controls: "resource-evaluation-content",
      id: "diagnostics",
      icon: Stethoscope,
      label: t("resources.diagnosticsTab"),
    },
  ];
  const evaluationMaximum = Math.min(
    EVALUATION_MAX_HEIGHT,
    Math.max(
      EVALUATION_MIN_HEIGHT,
      detailAreaHeight - EDITOR_FRAME_HEIGHT - EDITOR_MIN_HEIGHT - DETAIL_DIVIDER_SIZE,
    ),
  );
  const testInputMaximum = Math.max(
    TEST_PANE_MIN_WIDTH,
    testAreaWidth - TEST_PANE_DIVIDER_SIZE - TEST_PANE_MIN_WIDTH,
  );
  const testInputDefaultWidth = Math.min(
    testInputMaximum,
    Math.max(
      TEST_PANE_MIN_WIDTH,
      Math.round((testAreaWidth - TEST_PANE_DIVIDER_SIZE) / 2),
    ),
  );
  const visibleTestInputWidth = Math.min(testInputWidth, testInputMaximum);

  return (
    <div
      aria-labelledby={`resource-${kindPath}-tab`}
      className="relative col-span-3 grid min-h-0 overflow-hidden bg-white"
      id={`resource-${kindPath}-panel`}
      ref={detailArea}
      role="tabpanel"
      style={{
        gridTemplateColumns: `${catalogWidth}px ${DETAIL_DIVIDER_SIZE}px minmax(0, 1fr)`,
        gridTemplateRows: selectedModule
          ? `minmax(${EDITOR_FRAME_HEIGHT + EDITOR_MIN_HEIGHT}px, 1fr) ${DETAIL_DIVIDER_SIZE}px ${evaluationHeight}px`
          : "minmax(0, 1fr)",
      }}
    >
      <WorkspaceListPane
        countLabel={t("resources.moduleCount", { count: filtered.length })}
        empty={filtered.length === 0}
        emptyLabel={t("resources.noResults")}
        id={`resource-${kindPath}-list`}
        loading={loading}
        loadingLabel={t("resources.loading")}
        onQueryChange={setQuery}
        query={query}
        searchLabel={t("resources.search")}
        title={kind === "tool"
          ? t("resources.toolModules")
          : kind === "skill" ? t("resources.skillModules") : t("resources.harnessModules")}
      >
        {filtered.map((resourceModule) => {
            const selected = selectedModule?.id === resourceModule.id;
            const hasErrors = resourceModule.diagnostics.some((diagnostic) => diagnostic.severity === "error");
            return (
              <button
                aria-pressed={selected}
                className={"grid h-14 w-full grid-cols-[16px_1fr] items-center gap-2 border-b border-[#e0e8e8] px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] " + (selected ? "bg-[#dcecea]" : "bg-white hover:bg-[#eef4f3]")}
                key={resourceModule.id}
                onClick={handleModuleClick}
                type="button"
                value={resourceModule.id}
              >
                <Boxes aria-hidden="true" className={hasErrors ? "text-[#b44747]" : "text-[#2f8a65]"} size={14} />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[11px] font-semibold text-[#29484c]">{resourceModule.name}</span>
                  <span className="mt-0.5 block truncate text-[9px] text-[#718488]">{countLabel(resourceModule)} · {resourceModule.source}</span>
                </span>
              </button>
            );
          })}
      </WorkspaceListPane>

      {divider}

      <section
        className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)_26px] bg-white"
      >
        {selectedModule ? (
          <>
            <PanelHeader
              actions={selectedDefinition?.kind !== "tool" && editorTab === "definitions" ? (
                <button
                  aria-label={t("resources.save")}
                  className="flex h-6 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-default disabled:bg-[#aebdba]"
                  disabled={!dirty || saving}
                  onClick={handleSave}
                  type="button"
                >
                  {saving ? <LoaderCircle aria-hidden="true" className="animate-spin" size={12} /> : <Save aria-hidden="true" size={12} />}
                  {t("resources.save")}
                </button>
              ) : undefined}
              icon={Boxes}
              metadata={selectedModule.kind === "skill"
                ? countLabel(selectedModule)
                : `v${selectedModule.version} · ${countLabel(selectedModule)}`}
              monospace
              title={selectedModule.name}
            />
            <div className="grid min-h-0 grid-rows-[31px_minmax(0,1fr)]" id="resource-editor-panel">
              <WorkspaceTabs
                activeTab={editorTab}
                ariaLabel={t("resources.detailViews")}
                idPrefix="resource-editor"
                onChange={selectEditorTab}
                tabs={editorTabs}
              />
              <div className="min-h-0" id="resource-editor-content">
                {editorTab === "files" && (
                  <div className="grid h-full min-h-0 grid-cols-[190px_1fr] divide-x divide-[#cbd8d9]">
                    <div className="minimal-scrollbar min-h-0 overflow-y-auto bg-[#f8faf9]">
                      {selectedModule.files.map((resourceFile) => (
                        <button
                          className={"block h-11 w-full border-b border-[#e0e8e8] px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] " + (selectedFilePath === resourceFile.path ? "bg-[#dcecea]" : "bg-white hover:bg-[#eef4f3]")}
                          key={`${resourceFile.role}:${resourceFile.path}`}
                          onClick={handleFileClick}
                          type="button"
                          value={resourceFile.path}
                        >
                          <span className="block truncate font-mono text-[9px] font-semibold text-[#29484c]">{resourceFile.path}</span>
                          <span className="mt-0.5 block text-[8px] uppercase text-[#718488]">{resourceFile.role}</span>
                        </button>
                      ))}
                    </div>
                    {fileLoading ? (
                      <div className="flex items-center justify-center"><LoaderCircle className="animate-spin text-[#718488]" size={16} /></div>
                    ) : file ? (
                      <CodeSurface ariaLabel={t("resources.fileContent")} language={file.language} readOnly value={file.content} />
                    ) : (
                      <div className="flex items-center justify-center text-xs text-[#718488]">{t("resources.chooseFile")}</div>
                    )}
                  </div>
                )}
                {editorTab === "definitions" && (
                  <div className="grid h-full min-h-0 grid-cols-[190px_1fr] divide-x divide-[#cbd8d9]">
                    <div className="minimal-scrollbar min-h-0 overflow-y-auto bg-[#f8faf9]">
                      {selectedDefinitions.map((definition) => (
                        <button
                          aria-pressed={selectedDefinition?.id === definition.id}
                          className={"grid h-12 w-full grid-cols-[9px_1fr] items-center gap-2 border-b border-[#e0e8e8] px-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] " + (selectedDefinition?.id === definition.id ? "bg-[#dcecea]" : "bg-white hover:bg-[#eef4f3]")}
                          key={definition.id}
                          onClick={handleDefinitionClick}
                          type="button"
                          value={definition.id}
                        >
                          <span className={"h-1.5 w-1.5 " + (definition.diagnostics.some((item) => item.severity === "error") ? "bg-[#b44747]" : "bg-[#2f8a65]")} />
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-[10px] font-semibold text-[#29484c]">{definition.name}</span>
                            <span className="mt-0.5 block truncate text-[8px] text-[#718488]">{definition.description}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                    {selectedDefinition ? (
                      <CodeSurface
                        ariaLabel={selectedDefinition.kind === "tool"
                          ? t("resources.toolDefinition")
                          : selectedDefinition.kind === "skill"
                            ? t("resources.skillDefinition")
                            : t("resources.harnessDefinition")}
                        language={selectedDefinition.kind === "tool"
                          ? "JSON"
                          : selectedDefinition.kind === "skill" ? "Markdown" : "Jinja2"}
                        onChange={selectedDefinition.kind === "tool" ? undefined : setDraft}
                        onSave={selectedDefinition.kind === "tool" ? undefined : handleSave}
                        readOnly={selectedDefinition.kind === "tool"}
                        value={definitionText(selectedDefinition, draft)}
                      />
                    ) : (
                      <div className="flex items-center justify-center text-xs text-[#718488]">{t("resources.chooseDefinition")}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <footer className="flex min-w-0 items-center justify-between gap-3 border-t border-[#cbd8d9] bg-[#edf3f2] px-3 font-mono text-[8px] text-[#718488]">
              <span className="truncate">{selectedModule.source}</span>
              <span className="flex shrink-0 items-center gap-3">
                <span>rev {selectedModule.revision.slice(0, 8)}</span>
                <span>{dirty ? t("resources.unsaved") : t("resources.saved")}</span>
                <span>
                  {selectedModule.kind === "tool"
                    ? t("resources.attachedCount", { count: attachedCount, total: selectedModule.tools.length })
                    : selectedModule.kind === "skill"
                      ? t("resources.skillDefinitionEditable")
                      : t("resources.harnessManagedByRuntime")}
                </span>
              </span>
            </footer>
          </>
        ) : (
          <div className="col-span-full flex h-full items-center justify-center text-xs text-[#718488]">
            {loading ? t("resources.loading") : t("resources.empty")}
          </div>
        )}
      </section>

      {selectedModule && (
        <>
          <div className="col-span-3 grid min-h-0">
            <ResizeHandle
              controls="resource-editor-panel resource-evaluation-panel"
              defaultValue={EVALUATION_DEFAULT_HEIGHT}
              direction={-1}
              id={`resource-${kindPath}-evaluation-resize-handle`}
              label={t("resize.resourceEvaluation")}
              maximum={evaluationMaximum}
              minimum={EVALUATION_MIN_HEIGHT}
              onChange={setEvaluationHeight}
              orientation="horizontal"
              value={evaluationHeight}
              valueText={t("resize.pixels", { value: evaluationHeight })}
            />
          </div>

          <div className="col-span-3 grid min-h-0 grid-rows-[31px_minmax(0,1fr)] bg-white" id="resource-evaluation-panel">
            <WorkspaceTabs
              activeTab={evaluationTab}
              ariaLabel={t("resources.evaluationViews")}
              idPrefix="resource-evaluation"
              onChange={setEvaluationTab}
              tabs={evaluationTabs}
            />
            <div className="min-h-0" id="resource-evaluation-content">
              {evaluationTab === "test" && (selectedDefinition ? (
                <div className="grid h-full min-h-0 grid-rows-[34px_1fr]">
                  <div className="flex items-center justify-between border-b border-[#d4dfdf] bg-[#edf3f2] px-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="truncate font-mono text-[9px] font-semibold text-[#536d72]">{selectedDefinition.name}</span>
                      <span aria-live="polite" className={"flex shrink-0 items-center gap-1 text-[9px] " + (testStatus === "success" ? "text-[#17675f]" : testStatus === "error" ? "text-[#9b4141]" : "text-[#718488]")}>
                        {testStatus === "running" && <LoaderCircle aria-hidden="true" className="animate-spin" size={11} />}
                        {testStatus === "success" && <CheckCircle2 aria-hidden="true" size={11} />}
                        {testStatus === "error" && <AlertCircle aria-hidden="true" size={11} />}
                        {testStatus === "running"
                          ? t(selectedDefinition.kind === "skill" ? "resources.previewRunning" : "resources.testRunning")
                          : testStatus === "success"
                            ? t(selectedDefinition.kind === "skill" ? "resources.previewSuccess" : "resources.testSuccess")
                            : testStatus === "error"
                              ? t(selectedDefinition.kind === "skill" ? "resources.previewError" : "resources.testError")
                              : t(selectedDefinition.kind === "skill" ? "resources.previewIdle" : "resources.testIdle")}
                      </span>
                      {mutatesProject && (
                        <span className="flex min-w-0 items-center gap-1 truncate text-[9px] text-[#9a5d1d]">
                          <AlertCircle aria-hidden="true" className="shrink-0" size={11} />
                          {t("resources.testMutatesProject")}
                        </span>
                      )}
                    </div>
                    <button
                      className="flex h-6 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:opacity-50"
                      disabled={(selectedDefinition.kind !== "skill" && !input.trim()) || testStatus === "running"}
                      onClick={handleRunTest}
                      type="button"
                    >
                      <Play aria-hidden="true" fill="currentColor" size={11} />
                      {selectedDefinition.kind === "skill"
                        ? t("resources.previewSkill")
                        : t("resources.runTest")}
                    </button>
                  </div>
                  {selectedDefinition.kind === "skill" ? (
                    <div className="grid min-h-0 grid-rows-[24px_1fr]" id="resource-test-output-panel">
                      <div className="flex items-center border-b border-[#dce5e5] px-2.5 text-[9px] font-semibold uppercase text-[#6b7e82]">{t("resources.previewOutput")}</div>
                      <CodeSurface ariaLabel={t("resources.previewOutput")} language="JSON" readOnly value={output} />
                    </div>
                  ) : (
                    <div
                      className="grid min-h-0"
                      ref={testArea}
                      style={{
                        gridTemplateColumns: `${visibleTestInputWidth}px ${TEST_PANE_DIVIDER_SIZE}px minmax(${TEST_PANE_MIN_WIDTH}px, 1fr)`,
                      }}
                    >
                      <div className="grid min-h-0 grid-rows-[24px_1fr]" id="resource-test-input-panel">
                        <div className="flex items-center border-b border-[#dce5e5] px-2.5 text-[9px] font-semibold uppercase text-[#6b7e82]">{t("resources.testInput")}</div>
                        <CodeSurface ariaLabel={t("resources.testInput")} language="JSON" onChange={handleInputChange} value={input} />
                      </div>
                      <ResizeHandle
                        controls="resource-test-input-panel resource-test-output-panel"
                        defaultValue={testInputDefaultWidth}
                        id={`resource-${kind}s-test-input-resize-handle`}
                        label={t("resize.resourceTestInput")}
                        maximum={testInputMaximum}
                        minimum={TEST_PANE_MIN_WIDTH}
                        onChange={handleTestInputResize}
                        value={visibleTestInputWidth}
                        valueText={t("resize.pixels", { value: visibleTestInputWidth })}
                      />
                      <div className="grid min-h-0 grid-rows-[24px_1fr]" id="resource-test-output-panel">
                        <div className="flex items-center border-b border-[#dce5e5] px-2.5 text-[9px] font-semibold uppercase text-[#6b7e82]">{t("resources.testOutput")}</div>
                        <CodeSurface ariaLabel={t("resources.testOutput")} language="JSON" readOnly value={output} />
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-[#718488]">{t("resources.chooseDefinition")}</div>
              ))}
              {evaluationTab === "diagnostics" && (
                <div className="minimal-scrollbar h-full overflow-y-auto">
                  {selectedModule.diagnostics.length === 0 ? (
                    <div className="flex h-full items-center justify-center gap-2 text-xs text-[#52706c]">
                      <CheckCircle2 aria-hidden="true" size={15} />
                      {t("resources.noDiagnostics")}
                    </div>
                  ) : selectedModule.diagnostics.map((diagnostic, index) => (
                    <div className="grid grid-cols-[18px_1fr_auto] gap-2 border-b border-[#e0e8e8] px-3 py-2.5" key={`${diagnostic.code}:${index}`}>
                      <AlertCircle aria-hidden="true" className={diagnostic.severity === "error" ? "text-[#a74343]" : "text-[#a06b20]"} size={14} />
                      <span className="text-[11px] leading-4 text-[#35555a]">{diagnostic.message}</span>
                      <span className="font-mono text-[8px] text-[#718488]">{diagnostic.code}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {error && (
        <div className="absolute bottom-3 right-3 max-w-md border border-[#c68d8d] bg-[#fff1f0] px-3 py-2 text-[10px] text-[#8f3535]" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
