"use client";

import { AlertTriangle, Braces, FlaskConical, Save, Variable } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import {
  resourceApi,
  type CompressionResource,
  type CompressionTestResult,
} from "../resource-api";
import CodeSurface from "./code-surface";
import ResizeHandle from "./resize-handle";
import { WorkspaceTabs, type WorkspaceTab } from "./workspace-ui";

type DefinitionTab = "policy" | "prompt" | "variables";
type EvaluationTab = "test" | "diagnostics";

const DEFAULT_TEST_MESSAGES = JSON.stringify([
  { role: "system", content: "You are a concise project assistant." },
  { role: "user", content: "The project uses WebSocket for runtime communication." },
  { role: "assistant", content: "I will preserve that architecture decision." },
  { role: "user", content: "Remember that the release target is Friday." },
  { role: "assistant", content: "The release target is Friday." },
  { role: "user", content: "Keep the most recent turn unchanged." },
  { role: "assistant", content: "I will keep it unchanged." },
], null, 2);

const DEFAULT_TOP_HEIGHT = 430;
const MIN_PANE_HEIGHT = 150;

function ActionButton({ disabled, label, onClick }: {
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className="flex h-7 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white hover:bg-[#095f59] disabled:cursor-not-allowed disabled:bg-[#a9b9b9]"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Save aria-hidden="true" size={12} />
      {label}
    </button>
  );
}

export default function CompressionResourceWorkspace({ projectPath }: { projectPath: string }) {
  const { t } = useI18n();
  const [resource, setResource] = useState<CompressionResource | null>(null);
  const [manifestText, setManifestText] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [definitionTab, setDefinitionTab] = useState<DefinitionTab>("policy");
  const [evaluationTab, setEvaluationTab] = useState<EvaluationTab>("test");
  const [testMessages, setTestMessages] = useState(DEFAULT_TEST_MESSAGES);
  const [testResult, setTestResult] = useState<CompressionTestResult | null>(null);
  const [topHeight, setTopHeight] = useState(DEFAULT_TOP_HEIGHT);

  useEffect(() => {
    if (!projectPath) return;
    void resourceApi.compression(projectPath)
      .then((next) => {
        setResource(next);
        setManifestText(JSON.stringify(next.manifest, null, 2));
        setDirty(false);
        setError(null);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [projectPath]);

  const definitionTabs: WorkspaceTab<DefinitionTab>[] = [
    { id: "policy", label: t("compression.policy") },
    { id: "prompt", label: t("compression.prompt") },
    { id: "variables", label: t("compression.variables") },
  ];
  const evaluationTabs: WorkspaceTab<EvaluationTab>[] = [
    { id: "test", label: t("resources.testTab") },
    { id: "diagnostics", label: t("resources.diagnosticsTab") },
  ];
  const updatePolicy = (value: string) => {
    setManifestText(value);
    if (!resource) return;
    try {
      const manifest = JSON.parse(value) as CompressionResource["manifest"];
      setResource({ ...resource, manifest });
      setDirty(true);
      setError(null);
    } catch {
      setError(t("compression.invalidManifest"));
    }
  };

  const save = async () => {
    if (!resource || !dirty || saving) return;
    setSaving(true);
    try {
      const saved = await resourceApi.saveCompression(projectPath, resource);
      setResource(saved);
      setManifestText(JSON.stringify(saved.manifest, null, 2));
      setDirty(false);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (running) return;
    setRunning(true);
    setTestResult(null);
    try {
      const messages = JSON.parse(testMessages) as unknown[];
      if (!Array.isArray(messages)) throw new Error(t("compression.messagesMustBeArray"));
      setTestResult(await resourceApi.testCompression(projectPath, messages));
      setEvaluationTab("test");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  };

  if (!resource) {
    return (
      <section className="flex h-full items-center justify-center bg-white text-xs text-[#60777a]">
        {error ?? t("resources.loading")}
      </section>
    );
  }

  return (
    <section
      className="relative grid h-full min-h-0 bg-white"
      style={{ gridTemplateRows: `${topHeight}px 1px minmax(${MIN_PANE_HEIGHT}px, 1fr)` }}
    >
      <div className="grid min-h-0 grid-rows-[34px_1fr]" id="compression-definition-pane">
        <WorkspaceTabs
          actions={<ActionButton disabled={!dirty || saving} label={t("resources.save")} onClick={() => void save()} />}
          activeTab={definitionTab}
          ariaLabel={t("compression.definitionViews")}
          idPrefix="compression-definition"
          onChange={setDefinitionTab}
          tabs={definitionTabs}
        />
        {definitionTab === "policy" && (
          <CodeSurface
            ariaLabel={t("compression.policy")}
            language="JSON"
            onChange={updatePolicy}
            onSave={() => void save()}
            value={manifestText}
          />
        )}
        {definitionTab === "prompt" && (
          <CodeSurface
            ariaLabel={t("compression.prompt")}
            language="Jinja2"
            onChange={(prompt) => {
              setResource({ ...resource, prompt });
              setDirty(true);
            }}
            onSave={() => void save()}
            value={resource.prompt}
          />
        )}
        {definitionTab === "variables" && (
          <div className="minimal-scrollbar min-h-0 overflow-auto bg-[#f8faf9] p-3">
            <div className="grid gap-px border border-[#d5e0e0] bg-[#d5e0e0]">
              {resource.variables.map((variable) => (
                <div className="flex items-center gap-2 bg-white px-3 py-2 font-mono text-[11px] text-[#31545a]" key={variable}>
                  <Variable aria-hidden="true" className="text-[#678085]" size={12} />
                  {variable}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <ResizeHandle
        controls="compression-definition-pane compression-evaluation-pane"
        defaultValue={DEFAULT_TOP_HEIGHT}
        label={t("compression.resize")}
        maximum={() => Math.max(DEFAULT_TOP_HEIGHT, window.innerHeight - 220)}
        minimum={MIN_PANE_HEIGHT}
        onChange={setTopHeight}
        orientation="horizontal"
        value={topHeight}
        valueText={`${topHeight}px`}
      />

      <div className="grid min-h-0 grid-rows-[34px_1fr]" id="compression-evaluation-pane">
        <WorkspaceTabs
          actions={evaluationTab === "test" ? (
            <button
              className="flex h-7 items-center gap-1.5 px-2.5 text-[10px] font-semibold text-[#0c665f] hover:bg-[#e1ecea] disabled:text-[#9babab]"
              disabled={running || dirty}
              onClick={() => void runTest()}
              title={dirty ? t("compression.saveBeforeTest") : undefined}
              type="button"
            >
              <FlaskConical aria-hidden="true" size={12} />
              {running ? t("resources.testRunning") : t("resources.runTest")}
            </button>
          ) : undefined}
          activeTab={evaluationTab}
          ariaLabel={t("compression.evaluationViews")}
          idPrefix="compression-evaluation"
          onChange={setEvaluationTab}
          tabs={evaluationTabs}
        />
        {evaluationTab === "test" && (
          <div className="grid min-h-0 grid-cols-2 divide-x divide-[#cbd8d9]">
            <CodeSurface
              ariaLabel={t("resources.testInput")}
              language="JSON"
              onChange={setTestMessages}
              value={testMessages}
            />
            <CodeSurface
              ariaLabel={t("resources.testOutput")}
              language="JSON"
              lineWrapping
              readOnly
              value={testResult
                ? JSON.stringify(testResult, null, 2)
                : error ? JSON.stringify({ error }, null, 2) : ""}
            />
          </div>
        )}
        {evaluationTab === "diagnostics" && (
          <div className="minimal-scrollbar min-h-0 overflow-auto p-3">
            {resource.diagnostics.length === 0 ? (
              <div className="text-[11px] text-[#587277]">{t("resources.noDiagnostics")}</div>
            ) : resource.diagnostics.map((diagnostic) => (
              <div className="mb-2 flex gap-2 border border-[#d9c9a6] bg-[#fff9ec] px-3 py-2 text-[11px] text-[#72561f]" key={`${diagnostic.code}:${diagnostic.message}`}>
                <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={13} />
                <div><strong className="font-mono text-[10px]">{diagnostic.code}</strong><p>{diagnostic.message}</p></div>
              </div>
            ))}
            {error && (
              <div className="flex gap-2 border border-[#d6a5a5] bg-[#fff1f0] px-3 py-2 text-[11px] text-[#8f3535]">
                <Braces aria-hidden="true" className="mt-0.5 shrink-0" size={13} />
                {error}
              </div>
            )}
          </div>
        )}
      </div>
      {error && evaluationTab !== "diagnostics" && (
        <button
          className="absolute bottom-3 right-3 border border-[#c68d8d] bg-[#fff1f0] px-3 py-2 text-[10px] text-[#8f3535]"
          onClick={() => setEvaluationTab("diagnostics")}
          type="button"
        >
          {error}
        </button>
      )}
    </section>
  );
}
