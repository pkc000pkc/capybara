"use client";

import {
  Activity,
  BookOpen,
  Brain,
  CircleAlert,
  CircleCheck,
  Eye,
  EyeOff,
  FileText,
  GitBranch,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Save,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Variable,
  Webhook,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { RuntimeToolsState } from "../runtime-protocol";
import CodeSurface from "./code-surface";
import GitResourceWorkspace from "./git-resource-workspace";
import HookResourceWorkspace from "./hook-resource-workspace";
import ProjectFilesWorkspace from "./project-files-workspace";
import ResourceDefinitionWorkspace from "./resource-definition-workspace";
import ResizeHandle from "./resize-handle";
import {
  PanelHeader,
  WorkspaceListPane,
  WorkspaceNavigation,
} from "./workspace-ui";

export type ResourceSection =
  | "files"
  | "version-control"
  | "tools"
  | "skills"
  | "harnesses"
  | "hooks"
  | "system-variables"
  | "project-settings"
  | "system-settings"
  | "memory";
type SystemVariableDefinition = {
  key: string;
  label: string;
  description: string;
  value: string;
  required: boolean;
  readonly: boolean;
  show_in_status: boolean;
  scope?: "session" | "project";
  source: "builtin" | "project";
};

type SystemVariablesResource = {
  version: 1;
  variables: SystemVariableDefinition[];
};

type ProjectSettings = {
  main_template: string;
  max_messages: number;
  llm: {
    model: string;
    base_url: string;
    protocol: "responses" | "chat-completions";
    api_key: string;
    api_key_configured: boolean;
  };
  harness_policy: {
    experience_top_k: number;
    experience_threshold: number;
    experience_auto_attach: boolean;
  };
  context: {
    max_input_tokens: number;
    reserved_output_tokens: number;
  };
};

type LlmTestState =
  | { status: "success"; model: string; durationMs: number }
  | { status: "error"; message: string };

const DIVIDER_SIZE = 1;
const NAVIGATION_DEFAULT_WIDTH = 156;
const NAVIGATION_MIN_WIDTH = 112;
const NAVIGATION_MAX_WIDTH = 260;
const CATALOG_DEFAULT_WIDTH = 260;
const CATALOG_MIN_WIDTH = 180;
const CATALOG_MAX_WIDTH = 420;
const DETAIL_MIN_WIDTH = 420;

const RESOURCE_SECTIONS: {
  id: ResourceSection;
  icon: LucideIcon;
}[] = [
  { id: "files", icon: FileText },
  { id: "version-control", icon: GitBranch },
  { id: "tools", icon: Wrench },
  { id: "harnesses", icon: Layers3 },
  { id: "skills", icon: BookOpen },
  { id: "hooks", icon: Webhook },
  { id: "system-variables", icon: Variable },
  { id: "project-settings", icon: SlidersHorizontal },
  { id: "memory", icon: Brain },
];
const SYSTEM_SETTINGS_SECTION = { id: "system-settings", icon: Settings2 } as const;

function resourceApiUrl(path: string, projectPath: string): string {
  const configured = process.env.NEXT_PUBLIC_RUNTIME_HTTP_URL?.replace(/\/$/, "");
  const base = configured ?? `${window.location.protocol}//${window.location.hostname}:3005`;
  const separator = path.includes("?") ? "&" : "?";
  return `${base}/api/resources/${path}${separator}projectPath=${encodeURIComponent(projectPath)}`;
}

async function resourceRequest<T>(
  projectPath: string,
  path: string,
  body?: unknown,
  method?: "POST" | "PUT",
): Promise<T> {
  const response = await fetch(resourceApiUrl(path, projectPath), {
    method: body === undefined ? "GET" : method ?? "PUT",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function sectionLabel(
  section: ResourceSection,
  t: ReturnType<typeof useI18n>["t"],
) {
  switch (section) {
    case "files":
      return t("resources.files");
    case "version-control":
      return t("resources.versionControl");
    case "tools":
      return t("resources.tools");
    case "skills":
      return t("resources.skills");
    case "harnesses":
      return t("resources.harnesses");
    case "hooks":
      return t("resources.hooks");
    case "system-variables":
      return t("resources.systemVariables");
    case "project-settings":
      return t("resources.projectSettings");
    case "system-settings":
      return t("resources.systemSettings");
    case "memory":
      return t("resources.memory");
  }
}

function ResourceNavigation({
  activeSection,
  onSelect,
}: {
  activeSection: ResourceSection;
  onSelect: (section: ResourceSection) => void;
}) {
  const { t } = useI18n();
  return (
    <WorkspaceNavigation
      activeItem={activeSection}
      ariaLabel={t("resources.navigation")}
      footerItems={[SYSTEM_SETTINGS_SECTION].map(({ id, icon }) => ({
        controls: `resource-${id}-panel`,
        icon,
        id,
        label: sectionLabel(id, t),
        tabId: `resource-${id}-tab`,
      }))}
      id="resource-navigation"
      items={RESOURCE_SECTIONS.map(({ id, icon }) => ({
        controls: `resource-${id}-panel`,
        icon,
        id,
        label: sectionLabel(id, t),
        tabId: `resource-${id}-tab`,
      }))}
      onChange={onSelect}
      title={t("navigation.resources")}
    />
  );
}

function DefinitionListItem({
  metadata,
  name,
  onSelect,
  selected,
}: {
  metadata: string;
  name: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-pressed={selected}
      className={
        "grid h-14 w-full grid-cols-[8px_1fr] items-center gap-2 border-b border-[#e0e8e8] px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] " +
        (selected
          ? "bg-[#dcecea] text-[#173f43]"
          : "bg-white text-[#35555a] hover:bg-[#eef4f3]")
      }
      onClick={onSelect}
      type="button"
    >
      <span
        aria-hidden="true"
        className={
          "h-1.5 w-1.5 " + (selected ? "bg-[#0c766e]" : "bg-[#91a4a7]")
        }
      />
      <span className="min-w-0">
        <span className="block truncate font-mono text-[11px] font-semibold">
          {name}
        </span>
        <span className="mt-0.5 block truncate text-[9px] text-[#7a8d91]">
          {metadata}
        </span>
      </span>
    </button>
  );
}

function ResourceSaveButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      className="flex h-6 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-default disabled:bg-[#aebdba]"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <Save aria-hidden="true" size={12} />
      {t("resources.save")}
    </button>
  );
}

function SystemVariableDetails({
  dirty,
  onChange,
  onDelete,
  onSave,
  variable,
}: {
  dirty: boolean;
  onChange: (changes: Partial<SystemVariableDefinition>) => void;
  onDelete: () => void;
  onSave: () => void;
  variable?: SystemVariableDefinition;
}) {
  const { t } = useI18n();
  if (!variable) {
    return (
      <section className="grid h-full min-h-0 grid-rows-[34px_1fr] bg-white">
        <PanelHeader
          actions={<ResourceSaveButton disabled={!dirty} onClick={onSave} />}
          icon={Variable}
          title={t("resources.systemVariables")}
        />
        <EmptyResourcePanel icon={Variable} title={t("resources.systemVariables")} />
      </section>
    );
  }
  const fieldClass = "h-8 w-full border border-[#c6d4d4] bg-white px-2 text-xs text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e] disabled:bg-[#f1f5f4] disabled:text-[#718488]";
  return (
    <section className="grid h-full min-h-0 grid-rows-[34px_1fr] bg-white">
      <PanelHeader
        actions={(
          <>
          {variable.readonly ? (
            <span className="flex items-center gap-1 font-mono text-[9px] text-[#718488]">
              <LockKeyhole aria-hidden="true" size={11} />
              {t("resources.readOnly")}
            </span>
          ) : (
            <button
              aria-label={t("resources.deleteVariable")}
              className="flex h-6 w-6 items-center justify-center text-[#8d4b4b] outline-none hover:bg-[#eadbda] focus-visible:ring-2 focus-visible:ring-[#9b4141]"
              onClick={onDelete}
              title={t("resources.deleteVariable")}
              type="button"
            >
              <Trash2 aria-hidden="true" size={13} />
            </button>
          )}
          <ResourceSaveButton disabled={!dirty} onClick={onSave} />
          </>
        )}
        monospace
        title={`builtin.prompts.${variable.key}`}
      />
      <div className="minimal-scrollbar min-h-0 overflow-auto p-4">
        <div className="grid max-w-3xl gap-4">
          <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
            {t("resources.variableKey")}
            <input className={fieldClass + " font-mono"} disabled={variable.readonly} onChange={(event) => onChange({ key: event.target.value })} value={variable.key} />
          </label>
          <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
            {t("resources.variableLabel")}
            <input className={fieldClass} disabled={variable.readonly} onChange={(event) => onChange({ label: event.target.value })} value={variable.label} />
          </label>
          <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
            {t("resources.variableDescription")}
            <input className={fieldClass} disabled={variable.readonly} onChange={(event) => onChange({ description: event.target.value })} value={variable.description} />
          </label>
          <div className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
            <span>{t("resources.variableValue")}</span>
            <CodeSurface
              ariaLabel={t("resources.variableValue")}
              className="h-56 border border-[#c6d4d4]"
              language="Markdown"
              lineNumbers={false}
              lineWrapping
              onChange={(value) => onChange({ value })}
              onSave={onSave}
              readOnly={variable.readonly}
              statusBar={false}
              value={variable.value}
            />
          </div>
          <label className="flex items-center gap-2 text-[11px] text-[#35555a]">
            <input checked={variable.required} disabled={variable.readonly} onChange={(event) => onChange({ required: event.target.checked })} type="checkbox" />
            {t("resources.variableRequired")}
          </label>
          <label className="flex items-center gap-2 text-[11px] text-[#35555a]">
            <input checked={variable.show_in_status} disabled={variable.readonly} onChange={(event) => onChange({ show_in_status: event.target.checked })} type="checkbox" />
            {t("resources.variableShowInStatus")}
          </label>
          <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
            {t("resources.variableScope")}
            <select
              className={fieldClass}
              disabled={variable.readonly}
              onChange={(event) => onChange({ scope: event.target.value as SystemVariableDefinition["scope"] })}
              value={variable.scope ?? "session"}
            >
              <option value="session">{t("resources.variableScopeSession")}</option>
              <option value="project">{t("resources.variableScopeProject")}</option>
            </select>
          </label>
        </div>
      </div>
    </section>
  );
}

function ProjectSettingsPanel({
  dirty,
  onChange,
  onSave,
  onTestLlm,
  projectControls,
  settings,
  testingLlm,
  testState,
}: {
  dirty: boolean;
  onChange: (settings: ProjectSettings) => void;
  onSave: () => void;
  onTestLlm: () => void;
  projectControls?: ReactNode;
  settings: ProjectSettings;
  testingLlm: boolean;
  testState: LlmTestState | null;
}) {
  const { t } = useI18n();
  const [showApiKey, setShowApiKey] = useState(false);
  const fieldClass = "h-8 border border-[#c6d4d4] bg-white px-2 font-mono text-xs text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]";
  return (
    <section className="grid h-full min-h-0 grid-rows-[34px_1fr] bg-white">
      <PanelHeader
        actions={<ResourceSaveButton disabled={!dirty} onClick={onSave} />}
        icon={SlidersHorizontal}
        title={t("resources.projectSettings")}
      />
      <div className="minimal-scrollbar min-h-0 overflow-y-auto p-4">
        <div className="max-w-2xl">
          <section aria-labelledby="runtime-settings-heading" className="pb-5">
            <h3 className="text-[10px] font-semibold uppercase text-[#6a7e82]" id="runtime-settings-heading">
              {t("resources.runtimeSettings")}
            </h3>
            <label className="mt-3 grid max-w-sm gap-1.5 text-[10px] font-semibold text-[#536d72]">
              {t("resources.maxMessages")}
              <input
                className={fieldClass}
                max={10000}
                min={1}
                onChange={(event) => onChange({
                  ...settings,
                  max_messages: Number(event.target.value),
                })}
                type="number"
                value={settings.max_messages}
              />
            </label>
            <div className="mt-3 grid max-w-xl grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
                {t("resources.maxInputTokens")}
                <input
                  className={fieldClass}
                  min={1024}
                  onChange={(event) => onChange({
                    ...settings,
                    context: { ...settings.context, max_input_tokens: Number(event.target.value) },
                  })}
                  type="number"
                  value={settings.context.max_input_tokens}
                />
              </label>
              <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
                {t("resources.reservedOutputTokens")}
                <input
                  className={fieldClass}
                  min={128}
                  onChange={(event) => onChange({
                    ...settings,
                    context: { ...settings.context, reserved_output_tokens: Number(event.target.value) },
                  })}
                  type="number"
                  value={settings.context.reserved_output_tokens}
                />
              </label>
            </div>
          </section>
          <section aria-labelledby="llm-settings-heading" className="border-t border-[#cbd8d9] py-5">
            <div className="flex max-w-xl items-center justify-between gap-3">
              <h3 className="text-[10px] font-semibold uppercase text-[#6a7e82]" id="llm-settings-heading">
                {t("resources.llmSettings")}
              </h3>
              <button
                className="flex h-7 shrink-0 items-center gap-1.5 border border-[#8aafab] bg-white px-2.5 text-[10px] font-semibold text-[#0c655f] outline-none hover:bg-[#edf6f4] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-wait disabled:border-[#c6d4d4] disabled:text-[#839497]"
                disabled={testingLlm}
                onClick={onTestLlm}
                type="button"
              >
                {testingLlm
                  ? <LoaderCircle aria-hidden="true" className="animate-spin" size={13} />
                  : <Activity aria-hidden="true" size={13} />}
                {testingLlm ? t("resources.testingLlm") : t("resources.testLlm")}
              </button>
            </div>
            <div className="mt-3 grid max-w-xl grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
                {t("resources.llmModel")}
                <input
                  className={fieldClass}
                  onChange={(event) => onChange({
                    ...settings,
                    llm: { ...settings.llm, model: event.target.value },
                  })}
                  value={settings.llm.model}
                />
              </label>
              <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
                {t("resources.llmProtocol")}
                <select
                  className={fieldClass}
                  onChange={(event) => onChange({
                    ...settings,
                    llm: {
                      ...settings.llm,
                      protocol: event.target.value as ProjectSettings["llm"]["protocol"],
                    },
                  })}
                  value={settings.llm.protocol}
                >
                  <option value="responses">Responses API</option>
                  <option value="chat-completions">Chat Completions</option>
                </select>
              </label>
              <label className="col-span-2 grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
                {t("resources.llmBaseUrl")}
                <input
                  className={fieldClass}
                  onChange={(event) => onChange({
                    ...settings,
                    llm: { ...settings.llm, base_url: event.target.value },
                  })}
                  type="url"
                  value={settings.llm.base_url}
                />
              </label>
              <div className="col-span-2 grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
                <label htmlFor="project-llm-api-key">{t("resources.llmApiKey")}</label>
                <span className="relative block">
                  <input
                    autoComplete="new-password"
                    className={`${fieldClass} w-full pr-9`}
                    id="project-llm-api-key"
                    onChange={(event) => onChange({
                      ...settings,
                      llm: { ...settings.llm, api_key: event.target.value },
                    })}
                    placeholder={settings.llm.api_key_configured
                      ? t("resources.llmApiKeyConfigured")
                      : t("resources.llmApiKeyPlaceholder")}
                    type={showApiKey ? "text" : "password"}
                    value={settings.llm.api_key}
                  />
                  <button
                    aria-label={showApiKey ? t("resources.hideApiKey") : t("resources.showApiKey")}
                    className="absolute inset-y-0 right-0 grid w-8 place-items-center text-[#60787c] hover:text-[#0c766e]"
                    onClick={() => setShowApiKey((visible) => !visible)}
                    title={showApiKey ? t("resources.hideApiKey") : t("resources.showApiKey")}
                    type="button"
                  >
                    {showApiKey ? <EyeOff aria-hidden="true" size={14} /> : <Eye aria-hidden="true" size={14} />}
                  </button>
                </span>
              </div>
              {testState && (
                <div
                  className={
                    "col-span-2 flex min-h-8 items-start gap-2 border px-2.5 py-2 text-[11px] " +
                    (testState.status === "success"
                      ? "border-[#a9cbc2] bg-[#eef8f4] text-[#17675d]"
                      : "border-[#dfb9b5] bg-[#fff3f1] text-[#9b3d35]")
                  }
                  role="status"
                >
                  {testState.status === "success"
                    ? <CircleCheck aria-hidden="true" className="mt-px shrink-0" size={14} />
                    : <CircleAlert aria-hidden="true" className="mt-px shrink-0" size={14} />}
                  <span className="min-w-0 break-words">
                    {testState.status === "success"
                      ? t("resources.llmTestSucceeded", {
                          duration: testState.durationMs,
                          model: testState.model,
                        })
                      : t("resources.llmTestFailed", { message: testState.message })}
                  </span>
                </div>
              )}
            </div>
          </section>
          <section aria-labelledby="harness-settings-heading" className="border-t border-[#cbd8d9] py-5">
            <h3 className="text-[10px] font-semibold uppercase text-[#6a7e82]" id="harness-settings-heading">
              {t("resources.harnessSettings")}
            </h3>
            <div className="mt-3 grid max-w-xl grid-cols-2 gap-3">
              <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
                {t("resources.experienceTopK")}
                <input
                  className={fieldClass}
                  max={20}
                  min={1}
                  onChange={(event) => onChange({
                    ...settings,
                    harness_policy: {
                      ...settings.harness_policy,
                      experience_top_k: Number(event.target.value),
                    },
                  })}
                  type="number"
                  value={settings.harness_policy.experience_top_k}
                />
              </label>
              <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
                {t("resources.experienceThreshold")}
                <input
                  className={fieldClass}
                  max={1}
                  min={0}
                  onChange={(event) => onChange({
                    ...settings,
                    harness_policy: {
                      ...settings.harness_policy,
                      experience_threshold: Number(event.target.value),
                    },
                  })}
                  step={0.05}
                  type="number"
                  value={settings.harness_policy.experience_threshold}
                />
              </label>
              <label className="col-span-2 flex items-center gap-2 text-[11px] text-[#35555a]">
                <input
                  checked={settings.harness_policy.experience_auto_attach}
                  onChange={(event) => onChange({
                    ...settings,
                    harness_policy: {
                      ...settings.harness_policy,
                      experience_auto_attach: event.target.checked,
                    },
                  })}
                  type="checkbox"
                />
                {t("resources.experienceAutoAttach")}
              </label>
            </div>
          </section>
          {projectControls && (
            <div className="border-t border-[#cbd8d9] pt-5">
              {projectControls}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SystemSettingsPanel({ preferences }: { preferences?: ReactNode }) {
  const { t } = useI18n();
  return (
    <section className="grid h-full min-h-0 grid-rows-[34px_1fr] bg-white">
      <PanelHeader icon={Settings2} title={t("resources.systemSettings")} />
      <div className="minimal-scrollbar min-h-0 overflow-y-auto p-4">
        <div className="max-w-2xl">{preferences}</div>
      </div>
    </section>
  );
}

function EmptyResourcePanel({
  icon: Icon,
  title,
}: {
  icon: LucideIcon;
  title: string;
}) {
  const { t } = useI18n();
  return (
    <section className="flex h-full min-h-0 items-center justify-center bg-white">
      <div className="flex flex-col items-center gap-3 text-center text-[#718488]">
        <Icon aria-hidden="true" size={26} strokeWidth={1.4} />
        <div>
          <h2 className="text-xs font-semibold text-[#48646a]">{title}</h2>
          <p className="mt-1 text-[11px]">{t("resources.empty")}</p>
        </div>
      </div>
    </section>
  );
}

export default function ResourcesWorkspace({
  activeSection: controlledActiveSection,
  onSectionChange,
  preferences,
  projectControls,
  projectPath,
  runtimeTools,
}: {
  activeSection?: ResourceSection;
  onSectionChange?: (section: ResourceSection) => void;
  preferences?: ReactNode;
  projectControls?: ReactNode;
  projectPath: string;
  runtimeTools?: RuntimeToolsState;
}) {
  const { t } = useI18n();
  const [internalActiveSection, setInternalActiveSection] =
    useState<ResourceSection>("files");
  const activeSection = controlledActiveSection ?? internalActiveSection;
  const [query, setQuery] = useState("");
  const [systemVariables, setSystemVariables] = useState<SystemVariableDefinition[]>([]);
  const [selectedSystemVariableIndex, setSelectedSystemVariableIndex] = useState(0);
  const [systemVariablesDirty, setSystemVariablesDirty] = useState(false);
  const [settings, setSettings] = useState<ProjectSettings>({
    main_template: "main.j2",
    max_messages: 20,
    llm: {
      model: "",
      base_url: "",
      protocol: "responses",
      api_key: "",
      api_key_configured: false,
    },
    harness_policy: {
      experience_top_k: 3,
      experience_threshold: 0.35,
      experience_auto_attach: true,
    },
    context: {
      max_input_tokens: 16000,
      reserved_output_tokens: 2000,
    },
  });
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [llmTestState, setLlmTestState] = useState<LlmTestState | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [navigationWidth, setNavigationWidth] = useState(NAVIGATION_DEFAULT_WIDTH);
  const [catalogWidth, setCatalogWidth] = useState(CATALOG_DEFAULT_WIDTH);

  useEffect(() => {
    if (!projectPath) return;
    void Promise.all([
      resourceRequest<SystemVariablesResource>(projectPath, "system-variables"),
      resourceRequest<ProjectSettings>(projectPath, "project-settings"),
    ]).then(([variablesResource, loadedSettings]) => {
      setSystemVariables(variablesResource.variables);
      setSettings(loadedSettings);
      setLlmTestState(null);
      setResourceError(null);
    }).catch((error: unknown) => {
      setResourceError(error instanceof Error ? error.message : String(error));
    });
  }, [projectPath]);

  const selectSection = (section: ResourceSection) => {
    setInternalActiveSection(section);
    onSectionChange?.(section);
    setQuery("");
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredSystemVariables = useMemo(
    () => systemVariables
      .map((variable, index) => ({ variable, index }))
      .filter(({ variable }) =>
        `${variable.key} ${variable.label}`.toLowerCase().includes(normalizedQuery),
      ),
    [normalizedQuery, systemVariables],
  );

  const selectedSystemVariable = systemVariables[selectedSystemVariableIndex];

  const updateSystemVariable = (changes: Partial<SystemVariableDefinition>) => {
    if (selectedSystemVariable?.readonly) return;
    setSystemVariables((current) => current.map((variable, index) =>
      index === selectedSystemVariableIndex ? { ...variable, ...changes } : variable,
    ));
    setSystemVariablesDirty(true);
  };

  const addSystemVariable = () => {
    let suffix = systemVariables.length + 1;
    while (systemVariables.some((variable) => variable.key === `prompt_${suffix}`)) suffix += 1;
    setSystemVariables((current) => [...current, {
      key: `prompt_${suffix}`,
      label: `Prompt ${suffix}`,
      description: "",
      value: "",
      required: false,
      readonly: false,
      show_in_status: false,
      scope: "session",
      source: "project",
    }]);
    setSelectedSystemVariableIndex(systemVariables.length);
    setSystemVariablesDirty(true);
  };

  const deleteSystemVariable = () => {
    if (selectedSystemVariable?.readonly) return;
    setSystemVariables((current) => current.filter((_, index) => index !== selectedSystemVariableIndex));
    setSelectedSystemVariableIndex((current) => Math.max(0, current - 1));
    setSystemVariablesDirty(true);
  };

  const saveSystemVariables = async () => {
    if (!systemVariablesDirty || saving) return;
    setSaving(true);
    try {
      const saved = await resourceRequest<SystemVariablesResource>(projectPath, "system-variables", {
        version: 1,
        variables: systemVariables,
      });
      setSystemVariables(saved.variables);
      setSystemVariablesDirty(false);
      setResourceError(null);
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const saveSettings = async () => {
    if (!settingsDirty || saving) return;
    setSaving(true);
    try {
      const saved = await resourceRequest<ProjectSettings>(projectPath, "project-settings", {
        max_messages: settings.max_messages,
        llm: {
          model: settings.llm.model,
          base_url: settings.llm.base_url,
          protocol: settings.llm.protocol,
          ...(settings.llm.api_key ? { api_key: settings.llm.api_key } : {}),
        },
        harness_policy: settings.harness_policy,
        context: settings.context,
      });
      setSettings(saved);
      setSettingsDirty(false);
      setResourceError(null);
    } catch (error) {
      setResourceError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const testLlm = async () => {
    if (testingLlm) return;
    setTestingLlm(true);
    setLlmTestState(null);
    try {
      const result = await resourceRequest<{
        ok: true;
        model: string;
        duration_ms: number;
      }>(projectPath, "project-settings/llm/test", {
        model: settings.llm.model,
        base_url: settings.llm.base_url,
        protocol: settings.llm.protocol,
        ...(settings.llm.api_key ? { api_key: settings.llm.api_key } : {}),
      }, "POST");
      setLlmTestState({
        status: "success",
        model: result.model,
        durationMs: result.duration_ms,
      });
    } catch (error) {
      setLlmTestState({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingLlm(false);
    }
  };

  const handleSaveShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
    if (activeSection === "system-variables" && systemVariablesDirty) {
      event.preventDefault();
      void saveSystemVariables();
    } else if (activeSection === "project-settings" && settingsDirty) {
      event.preventDefault();
      void saveSettings();
    }
  };

  const activePanelId = `resource-${activeSection}-panel`;
  const activeListId = `resource-${activeSection}-list`;
  const catalogDivider = (
    <ResizeHandle
      controls={`${activeListId} ${activePanelId}`}
      defaultValue={CATALOG_DEFAULT_WIDTH}
      id="resource-catalog-resize-handle"
      label={t("resize.resourceCatalog")}
      maximum={CATALOG_MAX_WIDTH}
      minimum={CATALOG_MIN_WIDTH}
      onChange={setCatalogWidth}
      value={catalogWidth}
      valueText={t("resize.pixels", { value: catalogWidth })}
    />
  );

  return (
    <div
      className="relative grid h-full min-h-[520px] overflow-hidden bg-[#dce5e7]"
      data-resource-section={activeSection}
      onKeyDown={handleSaveShortcut}
      style={{
        gridTemplateColumns: `${navigationWidth}px ${DIVIDER_SIZE}px ${catalogWidth}px ${DIVIDER_SIZE}px minmax(${DETAIL_MIN_WIDTH}px, 1fr)`,
        minWidth: navigationWidth + catalogWidth + DETAIL_MIN_WIDTH + DIVIDER_SIZE * 2,
      }}
    >
      <ResourceNavigation
        activeSection={activeSection}
        onSelect={selectSection}
      />

      <ResizeHandle
        controls={`resource-navigation ${activePanelId}`}
        defaultValue={NAVIGATION_DEFAULT_WIDTH}
        id="resource-navigation-resize-handle"
        label={t("resize.resourceNavigation")}
        maximum={NAVIGATION_MAX_WIDTH}
        minimum={NAVIGATION_MIN_WIDTH}
        onChange={setNavigationWidth}
        value={navigationWidth}
        valueText={t("resize.pixels", { value: navigationWidth })}
      />

      {activeSection === "files" && (
        <ProjectFilesWorkspace divider={catalogDivider} key={projectPath} projectPath={projectPath} />
      )}

      {activeSection === "version-control" && (
        <GitResourceWorkspace divider={catalogDivider} projectPath={projectPath} />
      )}

      {activeSection === "tools" && (
        <ResourceDefinitionWorkspace catalogWidth={catalogWidth} divider={catalogDivider} key={`tools:${projectPath}`} kind="tool" projectPath={projectPath} runtimeTools={runtimeTools} />
      )}

      {activeSection === "skills" && (
        <ResourceDefinitionWorkspace catalogWidth={catalogWidth} divider={catalogDivider} key={`skills:${projectPath}`} kind="skill" projectPath={projectPath} runtimeTools={runtimeTools} />
      )}

      {activeSection === "harnesses" && (
        <ResourceDefinitionWorkspace catalogWidth={catalogWidth} divider={catalogDivider} key={`harnesses:${projectPath}`} kind="harness" projectPath={projectPath} runtimeTools={runtimeTools} />
      )}

      {activeSection === "hooks" && (
        <HookResourceWorkspace divider={catalogDivider} key={`hooks:${projectPath}`} projectPath={projectPath} />
      )}

      {activeSection === "system-variables" && (
        <>
          <WorkspaceListPane
            countLabel={t("resources.itemCount", { count: filteredSystemVariables.length })}
            empty={false}
            emptyLabel={t("resources.noResults")}
            id="resource-system-variables-list"
            onQueryChange={setQuery}
            query={query}
            searchLabel={t("resources.search")}
            title={t("resources.systemVariables")}
          >
            <button
              className="flex h-9 w-full items-center gap-2 border-b border-[#d9e3e3] px-3 text-[10px] font-semibold text-[#0c766e] outline-none hover:bg-[#e8f1ef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
              onClick={addSystemVariable}
              type="button"
            >
              <Plus aria-hidden="true" size={13} />
              {t("resources.addVariable")}
            </button>
            {filteredSystemVariables.map(({ variable, index }) => (
              <DefinitionListItem
                key={`${variable.key}-${index}`}
                metadata={variable.readonly
                  ? t("resources.readOnly")
                  : variable.scope === "project"
                    ? t("resources.variableScopeProject")
                  : variable.required ? t("resources.required") : t("resources.optional")}
                name={variable.key}
                onSelect={() => setSelectedSystemVariableIndex(index)}
                selected={selectedSystemVariableIndex === index}
              />
            ))}
          </WorkspaceListPane>
          {catalogDivider}
          <div
            aria-labelledby="resource-system-variables-tab"
            className="min-h-0"
            id="resource-system-variables-panel"
            role="tabpanel"
          >
            <SystemVariableDetails
              dirty={systemVariablesDirty && !saving}
              onChange={updateSystemVariable}
              onDelete={deleteSystemVariable}
              onSave={() => void saveSystemVariables()}
              variable={selectedSystemVariable}
            />
          </div>
        </>
      )}

      {activeSection === "project-settings" && (
        <div
          aria-labelledby="resource-project-settings-tab"
          className="col-span-3 min-h-0"
          id="resource-project-settings-panel"
          role="tabpanel"
        >
          <ProjectSettingsPanel
            dirty={settingsDirty && !saving}
            onChange={(next) => {
              setSettings(next);
              setSettingsDirty(true);
              setLlmTestState(null);
            }}
            onSave={() => void saveSettings()}
            onTestLlm={() => void testLlm()}
            projectControls={projectControls}
            settings={settings}
            testingLlm={testingLlm}
            testState={llmTestState}
          />
        </div>
      )}

      {activeSection === "system-settings" && (
        <div
          aria-labelledby="resource-system-settings-tab"
          className="col-span-3 min-h-0"
          id="resource-system-settings-panel"
          role="tabpanel"
        >
          <SystemSettingsPanel preferences={preferences} />
        </div>
      )}

      {activeSection === "memory" && (
        <div
          aria-labelledby="resource-memory-tab"
          className="col-span-3 min-h-0"
          id="resource-memory-panel"
          role="tabpanel"
        >
          <EmptyResourcePanel icon={Brain} title={t("resources.memory")} />
        </div>
      )}

      {resourceError && (
        <div className="absolute bottom-3 right-3 border border-[#c68d8d] bg-[#fff1f0] px-3 py-2 text-[10px] text-[#8f3535]" role="alert">
          {resourceError}
        </div>
      )}
    </div>
  );
}
