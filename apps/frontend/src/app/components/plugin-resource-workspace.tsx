"use client";

import {
  Blocks,
  Box,
  CheckCircle2,
  CircleAlert,
  FileCode2,
  LoaderCircle,
  PackageCheck,
  Pencil,
  Power,
  Plus,
  ShieldAlert,
  Trash2,
  Unlink,
  Variable,
  Webhook,
  Wrench,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import {
  resourceApi,
  type HarnessResourceDefinition,
  type HookResourceDefinition,
  type ResourceCatalog,
  type ToolPackageResource,
  type SystemVariableType,
  type SystemVariableValue,
} from "../resource-api";
import {
  buildResourcePluginViews,
  type BasePluginVariableDefinition,
  type PluginToolDependency,
  type PluginVariableDefinition,
  type ResourcePluginView,
} from "../resource-plugin-view";
import CodeSurface from "./code-surface";
import {
  PanelHeader,
  WorkspaceListPane,
  WorkspaceTabs,
  type WorkspaceTab,
} from "./workspace-ui";

const VARIABLE_TYPES: SystemVariableType[] = ["text", "prompt_template", "boolean", "integer", "number", "date", "datetime", "array", "object", "secret_ref"];
const variableTypeLabelKey: Record<SystemVariableType, string> = {
  text: "resources.variableTypeText", prompt_template: "resources.variableTypePromptTemplate", boolean: "resources.variableTypeBoolean", integer: "resources.variableTypeInteger", number: "resources.variableTypeNumber", date: "resources.variableTypeDate", datetime: "resources.variableTypeDatetime", array: "resources.variableTypeArray", object: "resources.variableTypeObject", secret_ref: "resources.variableTypeSecretRef",
};
const valueForType = (type: SystemVariableType): SystemVariableValue => type === "boolean" ? false : type === "integer" || type === "number" ? 0 : type === "array" ? [] : type === "object" ? {} : "";
const valueText = (value: SystemVariableValue) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
const parseValueText = (type: SystemVariableType, text: string): SystemVariableValue => {
  if (["array", "object"].includes(type)) { try { return JSON.parse(text) as SystemVariableValue; } catch { return text; } }
  if (type === "boolean") return text === "true";
  if (type === "integer") return Number.parseInt(text, 10);
  if (type === "number") return Number(text);
  return text;
};

function previewValue(value: SystemVariableValue): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function renderPreviewFragment(fragment: string, variables: readonly PluginVariableDefinition[], testKey: string, testValue: SystemVariableValue): string {
  const values: Record<string, SystemVariableValue> = Object.fromEntries(variables.map((item) => [item.key, item.value]));
  values[testKey] = testValue;
  const interpolation = /{{\s*(?:builtin\.)?(?:variables|prompts)\.([a-z][a-z0-9_]*)\s*}}/g;
  const render = (input: string, depth: number, seen: ReadonlySet<string>): string => input.replace(interpolation, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) return `{{ builtin.variables.${key} }}`;
    const rendered = previewValue(value);
    if (typeof value === "string" && depth < 6 && interpolation.test(rendered) && !seen.has(key)) {
      interpolation.lastIndex = 0;
      return render(rendered, depth + 1, new Set([...seen, key]));
    }
    interpolation.lastIndex = 0;
    return rendered;
  });
  return render(fragment, 0, new Set());
}

function PromptRenderPreview({ onFragmentChange, variable, variables }: {
  onFragmentChange?: (value: string) => void;
  variable: PluginVariableDefinition;
  variables: readonly PluginVariableDefinition[];
}) {
  const { t } = useI18n();
  const fragment = variable.type === "prompt_template" ? String(variable.value) : `{{ builtin.variables.${variable.key} }}`;
  const [manualFragment, setManualFragment] = useState<string>();
  const [testText, setTestText] = useState<string>();
  const effectiveTestText = testText ?? previewValue(variable.value);
  const fragmentText = variable.type === "prompt_template" ? fragment : manualFragment ?? fragment;
  const rendered = renderPreviewFragment(fragmentText, variables, variable.key, parseValueText(variable.type, effectiveTestText));
  return (
    <section className="grid gap-2 border border-[#c6d4d4] bg-[#f7faf9] p-3" aria-label={t("resources.variableRenderPreview")}>
      <div className="flex items-center justify-between gap-3"><span className="text-[10px] font-semibold text-[#536d72]">{t("resources.variableRenderPreview")}</span><span className="font-mono text-[9px] text-[#718488]">Jinja2</span></div>
      <div className="grid gap-2">
        <label className="grid gap-1"><span className="text-[9px] font-semibold text-[#718488]">{t("resources.variablePromptFragment")}</span><textarea aria-label={t("resources.variablePromptFragment")} className="min-h-14 w-full resize-y border border-[#d6e1e0] bg-white p-2 font-mono text-[10px] leading-4 text-[#294247] outline-none focus:border-[#0c766e]" onChange={(event) => { setManualFragment(event.target.value); onFragmentChange?.(event.target.value); }} value={fragmentText} /></label>
        <label className="grid gap-1"><span className="text-[9px] font-semibold text-[#718488]">{t("resources.variableTestValue")}</span><textarea aria-label={t("resources.variableTestValue")} className="min-h-14 resize-y border border-[#d6e1e0] bg-white p-2 font-mono text-[10px] leading-4 text-[#294247] outline-none focus:border-[#0c766e]" onChange={(event) => setTestText(event.target.value || undefined)} value={effectiveTestText} /></label>
      </div>
      <div className="grid gap-1"><span className="text-[9px] font-semibold text-[#718488]">{t("resources.variableRenderedOutput")}</span><pre className="min-h-14 whitespace-pre-wrap border border-[#b9d5d0] bg-[#eef7f4] p-2 font-mono text-[10px] leading-4 text-[#174f4c]">{rendered}</pre></div>
    </section>
  );
}

type PluginTab = "overview" | "variables" | "harnesses" | "hooks" | "tools";

function pluginToolCount(plugin: ResourcePluginView): number {
  return new Set([
    ...plugin.providedTools.map((tool) => tool.id),
    ...plugin.requiredTools.map((dependency) => dependency.requestedId),
  ]).size;
}

function StatusBadge({ status }: { status: "ready" | "attention" }) {
  const { t } = useI18n();
  return (
    <span className={status === "ready"
      ? "inline-flex h-5 items-center gap-1 bg-[#e5f2ed] px-1.5 text-[9px] font-semibold text-[#17634f]"
      : "inline-flex h-5 items-center gap-1 bg-[#fff0dd] px-1.5 text-[9px] font-semibold text-[#8b5516]"}
    >
      {status === "ready"
        ? <CheckCircle2 aria-hidden="true" size={10} />
        : <CircleAlert aria-hidden="true" size={10} />}
      {t(status === "ready" ? "plugins.ready" : "plugins.attention")}
    </span>
  );
}

function EmptyPane({ label }: { label: string }) {
  return <div className="flex h-full min-h-24 items-center justify-center px-4 text-center text-[11px] text-[#718488]">{label}</div>;
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 border-r border-[#dce5e5] px-3 py-2.5 last:border-r-0">
      <div className="font-mono text-lg font-semibold leading-none text-[#173f43]">{value}</div>
      <div className="mt-1 truncate text-[9px] font-semibold uppercase text-[#718488]">{label}</div>
    </div>
  );
}

function Row({ icon: Icon, metadata, name, status }: {
  icon: typeof Box;
  metadata: ReactNode;
  name: string;
  status?: ReactNode;
}) {
  return (
    <div className="grid min-h-12 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#e0e8e8] px-3 py-2 last:border-b-0">
      <Icon aria-hidden="true" className="text-[#537277]" size={14} strokeWidth={1.8} />
      <div className="min-w-0">
        <div className="truncate font-mono text-[10px] font-semibold text-[#29484c]">{name}</div>
        <div className="mt-0.5 min-w-0 truncate text-[9px] text-[#718488]">{metadata}</div>
      </div>
      {status && <div className="shrink-0">{status}</div>}
    </div>
  );
}

function PluginOverview({ plugin }: { plugin: ResourcePluginView }) {
  const { t } = useI18n();
  return (
    <div className="minimal-scrollbar min-h-0 overflow-y-auto bg-white">
      <div className="grid grid-cols-4 border-b border-[#cbd8d9] bg-[#f8faf9]">
        <Metric label={t("plugins.variables")} value={plugin.variables.length} />
        <Metric label={t("plugins.harnesses")} value={plugin.harnesses.length} />
        <Metric label={t("plugins.hooks")} value={plugin.hooks.length} />
        <Metric label={t("plugins.tools")} value={pluginToolCount(plugin)} />
      </div>
      <section className="border-b border-[#dce5e5]">
        <h3 className="h-8 border-b border-[#e0e8e8] px-3 text-[9px] font-semibold uppercase leading-8 text-[#6b7e82]">{t("plugins.sources")}</h3>
        {plugin.sources.length > 0
          ? plugin.sources.map((source) => <Row icon={FileCode2} key={source} metadata={`${plugin.ownerKind} · v${plugin.version}`} name={source} />)
          : <EmptyPane label={t("plugins.noSources")} />}
      </section>
      {plugin.diagnostics.length > 0 && (
        <section>
          <h3 className="h-8 border-b border-[#e0e8e8] px-3 text-[9px] font-semibold uppercase leading-8 text-[#6b7e82]">{t("plugins.diagnostics")}</h3>
          {plugin.diagnostics.map((diagnostic, index) => (
            <Row icon={diagnostic.severity === "error" ? CircleAlert : CheckCircle2} key={`${diagnostic.code}-${index}`} metadata={diagnostic.message} name={diagnostic.code} />
          ))}
        </section>
      )}
    </div>
  );
}

function PluginVariables({ busy, onAdd, onEdit, onRemoveDependency, plugin }: {
  busy: boolean;
  onAdd: () => void;
  onEdit: (variable: PluginVariableDefinition) => void;
  onRemoveDependency: (variable: PluginVariableDefinition) => void;
  plugin: ResourcePluginView;
}) {
  const { t } = useI18n();
  const canManage = plugin.ownerKind === "project" || plugin.ownerKind === "installed";
  return (
    <div className="minimal-scrollbar min-h-0 overflow-y-auto bg-white">
      {canManage && (
        <button
          className="flex h-9 w-full items-center gap-2 border-b border-[#d9e3e3] px-3 text-[10px] font-semibold text-[#0c766e] outline-none hover:bg-[#e8f1ef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
          disabled={busy}
          onClick={onAdd}
          type="button"
        >
          <Plus aria-hidden="true" size={13} />
          {t("plugins.addVariable")}
        </button>
      )}
      {plugin.variables.length === 0 && <EmptyPane label={t("plugins.noVariables")} />}
      {plugin.variables.map((variable) => (
        <div className="grid min-h-12 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#e0e8e8] px-3 py-2 last:border-b-0" data-plugin-variable={variable.key} key={`${variable.relation}:${variable.key}`}>
          <Variable aria-hidden="true" className="text-[#537277]" size={14} strokeWidth={1.8} />
          <button
            className="min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-default"
            disabled={busy || variable.relation === "dependency"}
            onClick={() => onEdit(variable)}
            type="button"
          >
            <span className="block truncate font-mono text-[10px] font-semibold text-[#29484c]">{variable.key}</span>
            <span className="mt-0.5 block truncate text-[9px] text-[#718488]">
              {variable.type} · {variable.relation === "dependency"
                ? t("plugins.dependencyReferences", { count: variable.references.reduce((count, reference) => count + reference.count, 0) })
                : variable.scope === "project" ? t("plugins.projectScope") : t("plugins.sessionScope")}
              {variable.template ? ` · ${variable.template}` : ""}
            </span>
          </button>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[9px] text-[#63777b]">{t(variable.relation === "dependency" ? "plugins.systemDependency" : "plugins.pluginOwned")}</span>
            {variable.relation === "registered" && canManage && (
              <button aria-label={t("plugins.editVariable", { key: variable.key })} className="grid h-6 w-6 place-items-center text-[#537277] outline-none hover:bg-[#e8f1ef] focus-visible:ring-2 focus-visible:ring-[#0c766e]" disabled={busy} onClick={() => onEdit(variable)} title={t("plugins.editVariable", { key: variable.key })} type="button"><Pencil aria-hidden="true" size={11} /></button>
            )}
            {variable.relation === "dependency" && (
              <button aria-label={t("plugins.removeVariableDependency", { key: variable.key })} className="grid h-6 w-6 place-items-center text-[#91483f] outline-none hover:bg-[#f8e9e8] focus-visible:ring-2 focus-visible:ring-[#9b4141]" disabled={busy} onClick={() => onRemoveDependency(variable)} title={t("plugins.removeVariableDependency", { key: variable.key })} type="button"><Unlink aria-hidden="true" size={11} /></button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PluginHarnesses({ busy, onAdd, onEdit, plugin }: {
  busy: boolean;
  onAdd: () => void;
  onEdit: (harness: HarnessResourceDefinition) => void;
  plugin: ResourcePluginView;
}) {
  const { t } = useI18n();
  const canManage = plugin.ownerKind === "project" || plugin.ownerKind === "installed";
  return (
    <div className="minimal-scrollbar min-h-0 overflow-y-auto bg-white">
      {canManage && <button className="flex h-9 w-full items-center gap-2 border-b border-[#d9e3e3] px-3 text-[10px] font-semibold text-[#0c766e] outline-none hover:bg-[#e8f1ef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" disabled={busy} onClick={onAdd} type="button"><Plus aria-hidden="true" size={13} />{t("plugins.addHarness")}</button>}
      {plugin.harnesses.length === 0 && <EmptyPane label={canManage ? t("plugins.noHarnessesEditable") : t("plugins.noHarnesses")} />}
      {plugin.harnesses.map((harness) => (
        <div className="grid min-h-12 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#e0e8e8] px-3 py-2 last:border-b-0" key={harness.id}>
          <FileCode2 aria-hidden="true" className="text-[#537277]" size={14} strokeWidth={1.8} />
          <button className="min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-default" disabled={busy || !canManage} onClick={() => onEdit(harness)} type="button"><span className="block truncate font-mono text-[10px] font-semibold text-[#29484c]">{harness.id}</span><span className="mt-0.5 block truncate text-[9px] text-[#718488]">{harness.type} · {t("plugins.priority", { value: harness.priority })} · {harness.description}</span></button>
          {canManage && <button aria-label={t("plugins.editHarness", { id: harness.id })} className="grid h-6 w-6 place-items-center text-[#537277] outline-none hover:bg-[#e8f1ef] focus-visible:ring-2 focus-visible:ring-[#0c766e]" disabled={busy} onClick={() => onEdit(harness)} title={t("plugins.editHarness", { id: harness.id })} type="button"><Pencil aria-hidden="true" size={11} /></button>}
        </div>
      ))}
    </div>
  );
}

function PluginHooks({ busy, onAdd, onEdit, plugin }: {
  busy: boolean;
  onAdd: () => void;
  onEdit: (hook: HookResourceDefinition) => void;
  plugin: ResourcePluginView;
}) {
  const { t } = useI18n();
  const canManage = plugin.ownerKind === "project" || plugin.ownerKind === "installed";
  return (
    <div className="minimal-scrollbar min-h-0 overflow-y-auto bg-white">
      {canManage && <button className="flex h-9 w-full items-center gap-2 border-b border-[#d9e3e3] px-3 text-[10px] font-semibold text-[#0c766e] outline-none hover:bg-[#e8f1ef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" disabled={busy} onClick={onAdd} type="button"><Plus aria-hidden="true" size={13} />{t("plugins.addHook")}</button>}
      {plugin.hooks.length === 0 && <EmptyPane label={canManage ? t("plugins.noHooksEditable") : t("plugins.noHooks")} />}
      {plugin.hooks.map((hook) => (
        <div className="grid min-h-12 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#e0e8e8] px-3 py-2 last:border-b-0" key={`${hook.mode}:${hook.id}`}>
          <Webhook aria-hidden="true" className="text-[#537277]" size={14} strokeWidth={1.8} />
          <button className="min-w-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-default" disabled={busy || !canManage} onClick={() => onEdit(hook)} type="button"><span className="block truncate font-mono text-[10px] font-semibold text-[#29484c]">{hook.id}</span><span className="mt-0.5 block truncate text-[9px] text-[#718488]">{t(hook.mode === "training" ? "plugins.trainingHook" : "plugins.runtimeHook")} · {hook.checkpoint} · {hook.description}</span></button>
          <div className="flex shrink-0 items-center gap-1"><span className={hook.enabled ? "text-[9px] text-[#17634f]" : "text-[9px] text-[#8a5555]"}>{t(hook.enabled ? "plugins.enabled" : "plugins.disabled")}</span>{canManage && <button aria-label={t("plugins.editHook", { id: hook.id })} className="grid h-6 w-6 place-items-center text-[#537277] outline-none hover:bg-[#e8f1ef] focus-visible:ring-2 focus-visible:ring-[#0c766e]" disabled={busy} onClick={() => onEdit(hook)} title={t("plugins.editHook", { id: hook.id })} type="button"><Pencil aria-hidden="true" size={11} /></button>}</div>
        </div>
      ))}
    </div>
  );
}

function ToolStatus({ dependency }: { dependency: PluginToolDependency }) {
  const { t } = useI18n();
  const classes = dependency.status === "installed"
    ? "bg-[#e5f2ed] text-[#17634f]"
    : dependency.status === "conflict" ? "bg-[#fbe8e5] text-[#94453d]" : "bg-[#fff0dd] text-[#8b5516]";
  return (
    <span className={`inline-flex h-5 items-center gap-1 px-1.5 text-[9px] font-semibold ${classes}`}>
      {dependency.status === "installed" ? <PackageCheck aria-hidden="true" size={10} /> : <CircleAlert aria-hidden="true" size={10} />}
      {t(`plugins.toolStatus.${dependency.status}`)}
    </span>
  );
}

function PluginTools({ plugin }: { plugin: ResourcePluginView }) {
  const { t } = useI18n();
  if (plugin.providedTools.length === 0 && plugin.requiredTools.length === 0) return <EmptyPane label={t("plugins.noTools")} />;
  return (
    <div className="minimal-scrollbar min-h-0 overflow-y-auto bg-white">
      {plugin.providedTools.length > 0 && (
        <section className="border-b border-[#cbd8d9]">
          <h3 className="h-8 border-b border-[#e0e8e8] px-3 text-[9px] font-semibold uppercase leading-8 text-[#6b7e82]">{t("plugins.providedTools")}</h3>
          {plugin.providedTools.map((tool) => <Row icon={Wrench} key={tool.id} metadata={tool.description} name={tool.id} status={<span className="inline-flex h-5 items-center gap-1 bg-[#e5f2ed] px-1.5 text-[9px] font-semibold text-[#17634f]"><PackageCheck aria-hidden="true" size={10} />{t("plugins.toolStatus.installed")}</span>} />)}
        </section>
      )}
      {plugin.requiredTools.length > 0 && (
        <section>
          <h3 className="h-8 border-b border-[#e0e8e8] px-3 text-[9px] font-semibold uppercase leading-8 text-[#6b7e82]">{t("plugins.requiredTools")}</h3>
          {plugin.requiredTools.map((dependency) => (
            <Row icon={Wrench} key={dependency.requestedId} metadata={t("plugins.toolVersionRequirement", { installed: dependency.installedVersion ?? "-", requested: dependency.requestedVersion })} name={dependency.requestedId} status={<ToolStatus dependency={dependency} />} />
          ))}
        </section>
      )}
    </div>
  );
}

function Dialog({ busy, children, onClose, title, wide = false }: {
  busy: boolean;
  children: ReactNode;
  onClose: () => void;
  title: string;
  wide?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#17363a]/30 p-4" role="presentation">
      <section aria-label={title} aria-modal="true" className={`grid max-h-[80vh] w-full ${wide ? "max-w-4xl" : "max-w-lg"} min-w-0 grid-rows-[38px_minmax(0,1fr)] border border-[#9fb4b5] bg-white shadow-xl`} role="dialog">
        <header className="flex items-center justify-between border-b border-[#cbd8d9] bg-[#edf3f2] px-3">
          <h2 className="text-[11px] font-semibold text-[#29484c]">{title}</h2>
          <button aria-label={t("plugins.closeDialog")} className="grid h-7 w-7 place-items-center text-[#60777a] hover:bg-[#dce8e6]" disabled={busy} onClick={onClose} type="button"><X aria-hidden="true" size={14} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

function VariableDialog({ busy, initial, installed, onClose, onDelete, onSave, variables }: {
  busy: boolean;
  initial?: PluginVariableDefinition;
  installed: boolean;
  onClose: () => void;
  onDelete?: () => void;
  onSave: (variable: PluginVariableDefinition) => void;
  variables: readonly PluginVariableDefinition[];
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<PluginVariableDefinition>(() => initial ?? {
    key: "",
    type: "text",
    label: "",
    description: "",
    value: "",
    template: installed ? "templates/variables/prompt-template.j2" : undefined,
    required: false,
    readonly: false,
    show_in_status: false,
    scope: "session",
    source: installed ? "plugin" : "project",
    relation: "registered",
    references: [],
  });
  const fieldClass = "h-8 w-full border border-[#c6d4d4] bg-white px-2 text-[11px] text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e] disabled:bg-[#f1f5f4]";
  const key = draft.key.trim();
  const keyValid = /^[a-z][a-z0-9_]*$/.test(key);
  const keyInvalid = key.length > 0 && !keyValid;
  const templatePath = draft.template?.trim() ?? "";
  const templateInvalid = draft.type === "prompt_template" && installed && templatePath.length > 0 && (!/^[^\\/].*\.j2$/i.test(templatePath) || /^[A-Za-z]:[\\/]/.test(templatePath) || templatePath.split(/[\\/]/).includes(".."));
  const valid = keyValid && draft.label.trim().length > 0 && !templateInvalid;
  return (
    <Dialog busy={busy} onClose={onClose} title={t(initial ? "plugins.editVariableTitle" : "plugins.addVariableTitle")}>
      <form className="minimal-scrollbar overflow-y-auto" onSubmit={(event) => { event.preventDefault(); if (valid) onSave(draft); }}>
        <div className="grid gap-3 p-4">
          <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
            {t("resources.variableKey")}
            <input aria-describedby="plugin-variable-key-help" aria-invalid={keyInvalid} aria-label={t("resources.variableKey")} className={`${fieldClass} font-mono ${keyInvalid ? "border-[#b4534d] bg-[#fff7f6] focus:border-[#b4534d] focus:ring-[#b4534d]" : ""}`} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, key: event.target.value }))} value={draft.key} />
            <span className={keyInvalid ? "text-[9px] font-medium leading-4 text-[#a23f38]" : "text-[9px] font-medium leading-4 text-[#718488]"} id="plugin-variable-key-help" role={keyInvalid ? "alert" : undefined}>{t(keyInvalid ? "resources.variableKeyInvalid" : "resources.variableKeyHelp")}</span>
          </label>
          <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">{t("resources.variableLabel")}<input aria-label={t("resources.variableLabel")} className={fieldClass} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} value={draft.label} /></label>
          <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">{t("resources.variableDescription")}<input aria-label={t("resources.variableDescription")} className={fieldClass} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))} value={draft.description} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">{t("resources.variableType")}<select aria-label={t("resources.variableType")} className={fieldClass} disabled={busy} onChange={(event) => { const type = event.target.value as SystemVariableType; setDraft((current) => ({ ...current, type, value: valueForType(type), template: type === "prompt_template" ? current.template : undefined })); }} value={draft.type}>{VARIABLE_TYPES.map((type) => <option key={type} value={type}>{t(variableTypeLabelKey[type] as Parameters<typeof t>[0])}</option>)}</select></label>
            <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">{t("resources.variableScope")}<select aria-label={t("resources.variableScope")} className={fieldClass} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, scope: event.target.value as PluginVariableDefinition["scope"] }))} value={draft.scope ?? "session"}><option value="session">{t("resources.variableScopeSession")}</option><option value="project">{t("resources.variableScopeProject")}</option></select></label>
          </div>
          {draft.type === "prompt_template" && installed && <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">{t("resources.variableTemplatePath")}<input aria-describedby="plugin-variable-template-help" aria-invalid={templateInvalid} aria-label={t("resources.variableTemplatePath")} className={`${fieldClass} font-mono ${templateInvalid ? "border-[#b4534d] bg-[#fff7f6]" : ""}`} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, template: event.target.value }))} placeholder="templates/variables/context.j2" value={draft.template ?? ""} /><span className={templateInvalid ? "text-[9px] font-medium text-[#a23f38]" : "text-[9px] font-medium text-[#718488]"} id="plugin-variable-template-help">{t(templateInvalid ? "resources.variableTemplateInvalid" : "resources.variableTemplateHelp")}</span></label>}
          {draft.type !== "prompt_template" && <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">{t("resources.variableDefaultValue")}{draft.type === "boolean" ? <select aria-label={t("resources.variableDefaultValue")} className={fieldClass} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value === "true" }))} value={String(draft.value)}><option value="true">true</option><option value="false">false</option></select> : ["integer", "number"].includes(draft.type) ? <input aria-label={t("resources.variableDefaultValue")} className={fieldClass} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, value: parseValueText(draft.type, event.target.value) }))} type="number" step={draft.type === "integer" ? 1 : "any"} value={String(draft.value)} /> : draft.type === "date" ? <input aria-label={t("resources.variableDefaultValue")} className={fieldClass} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))} type="date" value={String(draft.value)} /> : draft.type === "datetime" ? <input aria-label={t("resources.variableDefaultValue")} className={fieldClass} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))} placeholder="2026-08-19T12:30:00Z" type="text" value={String(draft.value)} /> : <textarea aria-label={t("resources.variableDefaultValue")} className="min-h-20 w-full resize-y border border-[#c6d4d4] bg-white p-2 font-mono text-[10px] leading-4 text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]" disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, value: parseValueText(draft.type, event.target.value) }))} value={valueText(draft.value)} />}</label>}
          <PromptRenderPreview
            onFragmentChange={(value) => { if (draft.type === "prompt_template") setDraft((current) => ({ ...current, value })); }}
            variable={draft}
            variables={[...variables.filter((item) => item.key !== draft.key), draft]}
          />
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-[10px] text-[#35555a]"><input checked={draft.required} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, required: event.target.checked }))} type="checkbox" />{t("resources.variableRequired")}</label>
            <label className="flex items-center gap-2 text-[10px] text-[#35555a]"><input checked={draft.show_in_status} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, show_in_status: event.target.checked }))} type="checkbox" />{t("resources.variableShowInStatus")}</label>
          </div>
        </div>
        <footer className="flex items-center justify-between border-t border-[#cbd8d9] bg-[#f8faf9] px-4 py-3">
          <div>{onDelete && <button className="flex h-7 items-center gap-1.5 px-2 text-[9px] font-semibold text-[#91483f] hover:bg-[#f8e9e8]" disabled={busy} onClick={onDelete} type="button"><Trash2 aria-hidden="true" size={11} />{t("plugins.deleteVariable")}</button>}</div>
          <div className="flex gap-2"><button className="h-7 border border-[#b9caca] bg-white px-3 text-[9px] font-semibold text-[#526b70]" disabled={busy} onClick={onClose} type="button">{t("plugins.cancel")}</button><button className="h-7 bg-[#0c766e] px-3 text-[9px] font-semibold text-white disabled:bg-[#9cb2af]" disabled={busy || !valid} type="submit">{t("plugins.saveVariable")}</button></div>
        </footer>
      </form>
    </Dialog>
  );
}

function RemoveVariableDependencyDialog({ busy, onClose, onConfirm, plugin, variable }: {
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
  plugin: ResourcePluginView;
  variable: PluginVariableDefinition;
}) {
  const { t } = useI18n();
  return (
    <Dialog busy={busy} onClose={onClose} title={t("plugins.removeVariableDependencyTitle")}>
      <div>
        <div className="border-b border-[#dce5e5] p-4"><div className="font-mono text-[11px] font-semibold text-[#29484c]">{plugin.id} -&gt; {variable.key}</div><p className="mt-1 text-[10px] leading-4 text-[#60777a]">{t("plugins.removeVariableDependencyDescription")}</p></div>
        <section className="border-b border-[#dce5e5]"><h3 className="h-7 bg-[#f5f8f7] px-4 text-[9px] font-semibold uppercase leading-7 text-[#6b7e82]">{t("plugins.dependencySources")}</h3>{variable.references.map((reference) => <div className="grid min-h-9 grid-cols-[1fr_auto] items-center gap-3 border-t border-[#e2e9e9] px-4 py-2" key={reference.path}><span className="truncate font-mono text-[9px] text-[#29484c]">{reference.path}</span><span className="text-[9px] text-[#718488]">x{reference.count}</span></div>)}</section>
        <footer className="flex justify-end gap-2 bg-[#f8faf9] px-4 py-3"><button className="h-7 border border-[#b9caca] bg-white px-3 text-[9px] font-semibold text-[#526b70]" disabled={busy} onClick={onClose} type="button">{t("plugins.cancel")}</button><button className="flex h-7 items-center gap-1.5 bg-[#9b4141] px-3 text-[9px] font-semibold text-white disabled:bg-[#c9a3a3]" disabled={busy} onClick={onConfirm} type="button">{busy ? <LoaderCircle className="animate-spin" size={11} /> : <Unlink size={11} />}{t("plugins.confirmRemoveDependency")}</button></footer>
      </div>
    </Dialog>
  );
}

function commaList(value: string): string[] {
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function defaultHookSource(name: string, mode: "runtime" | "training"): string {
  const checkpoint = mode === "runtime" ? "after_loop" : "after_evaluation";
  return `import { defineHook } from "@capybara-agent/sdk";

export default defineHook({
  name: "${name}",
  description: "Describe the lifecycle adjustment.",
  enabled: true,
  checkpoint: "${checkpoint}",
  trigger() { return true; },
  run() { return {}; },
});
`;
}

function HarnessEditorDialog({ busy, initial, onClose, onCreate, onDelete, onSave }: {
  busy: boolean;
  initial?: HarnessResourceDefinition;
  onClose: () => void;
  onCreate: (value: { name: string; description: string; type: HarnessResourceDefinition["type"]; activation: Record<string, unknown>; inputs: string[]; requiredTools: string[]; content: string }) => void;
  onDelete?: () => void;
  onSave: (content: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<HarnessResourceDefinition["type"]>("experience");
  const [activation, setActivation] = useState("context");
  const [inputs, setInputs] = useState("user_message");
  const [requiredTools, setRequiredTools] = useState("");
  const [content, setContent] = useState(initial?.content ?? "{{ user_message }}\n");
  const activationLabel = type === "persistent" ? t("plugins.harnessActivationPersistent") : type === "model" ? t("plugins.harnessActivationModels") : type === "tool" ? t("plugins.harnessActivationTools") : t("plugins.harnessActivationKeywords");
  const save = () => {
    if (initial) onSave(content);
    else {
      const key = type === "model" ? "models" : type === "tool" ? "tools" : "keywords";
      onCreate({ name, description, type, activation: type === "persistent" ? {} : { [key]: commaList(activation) }, inputs: commaList(inputs), requiredTools: commaList(requiredTools), content });
    }
  };
  return (
    <Dialog busy={busy} onClose={onClose} title={t(initial ? "plugins.editHarnessTitle" : "plugins.addHarnessTitle")} wide>
      <div className="grid min-w-0 max-h-[78vh] w-full grid-rows-[auto_minmax(280px,1fr)_auto] overflow-hidden">
        {initial ? <div className="border-b border-[#dce5e5] px-4 py-2 font-mono text-[10px] text-[#526b70]">{initial.id} · {initial.type}</div> : <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-b border-[#dce5e5] px-4 py-3"><label className="grid gap-1 text-[9px] font-semibold text-[#526b70]">{t("plugins.resourceName")}<input autoFocus className="h-7 border border-[#b9caca] bg-white px-2 font-mono text-[10px] outline-none focus:border-[#0c766e]" onChange={(event) => setName(event.target.value)} value={name} /></label><label className="grid gap-1 text-[9px] font-semibold text-[#526b70]">{t("plugins.harnessType")}<select className="h-7 border border-[#b9caca] bg-white px-2 text-[10px] outline-none focus:border-[#0c766e]" onChange={(event) => setType(event.target.value as HarnessResourceDefinition["type"])} value={type}><option value="persistent">persistent</option><option value="experience">experience</option><option value="tool">tool</option><option value="model">model</option></select></label><label className="col-span-2 grid gap-1 text-[9px] font-semibold text-[#526b70]">{t("plugins.resourceDescription")}<input className="h-7 border border-[#b9caca] bg-white px-2 text-[10px] outline-none focus:border-[#0c766e]" onChange={(event) => setDescription(event.target.value)} value={description} /></label><label className="grid gap-1 text-[9px] font-semibold text-[#526b70]">{activationLabel}<input className="h-7 border border-[#b9caca] bg-white px-2 text-[10px] outline-none focus:border-[#0c766e] disabled:bg-[#eef3f2] disabled:text-[#91a3a4]" disabled={type === "persistent"} onChange={(event) => setActivation(event.target.value)} value={type === "persistent" ? "-" : activation} /></label><label className="grid gap-1 text-[9px] font-semibold text-[#526b70]">{t("plugins.harnessInputs")}<input className="h-7 border border-[#b9caca] bg-white px-2 text-[10px] outline-none focus:border-[#0c766e]" onChange={(event) => setInputs(event.target.value)} value={inputs} /></label><label className="col-span-2 grid gap-1 text-[9px] font-semibold text-[#526b70]">{t("plugins.harnessRequiredTools")}<input className="h-7 border border-[#b9caca] bg-white px-2 text-[10px] outline-none focus:border-[#0c766e]" onChange={(event) => setRequiredTools(event.target.value)} placeholder={t("plugins.optionalCommaList")} value={requiredTools} /></label></div>}
        <CodeSurface ariaLabel={t("plugins.harnessEditor")} className="min-h-[280px]" language="Jinja2" minHeight="280px" onChange={setContent} onSave={save} statusBar value={content} />
        <footer className="flex items-center justify-between border-t border-[#dce5e5] bg-[#f8faf9] px-4 py-3"><div>{onDelete && <button className="flex h-7 items-center gap-1.5 border border-[#cfaaaa] bg-white px-3 text-[9px] font-semibold text-[#91483f] disabled:opacity-60" disabled={busy} onClick={onDelete} type="button"><Trash2 size={11} />{t("plugins.deleteHarness")}</button>}</div><div className="flex gap-2"><button className="h-7 border border-[#b9caca] bg-white px-3 text-[9px] font-semibold text-[#526b70]" disabled={busy} onClick={onClose} type="button">{t("plugins.cancel")}</button><button className="flex h-7 items-center gap-1.5 bg-[#315f64] px-3 text-[9px] font-semibold text-white disabled:bg-[#9eb7b8]" disabled={busy || (!initial && (!name.trim() || !description.trim() || (type !== "persistent" && commaList(activation).length === 0) || commaList(inputs).length === 0))} onClick={save} type="button">{busy && <LoaderCircle className="animate-spin" size={11} />}{t(initial ? "plugins.saveHarness" : "plugins.createHarness")}</button></div></footer>
      </div>
    </Dialog>
  );
}

function HookEditorDialog({ busy, initial, onClose, onCreate, onDelete, onSave }: {
  busy: boolean;
  initial?: HookResourceDefinition;
  onClose: () => void;
  onCreate: (value: { name: string; mode: "runtime" | "training"; content: string }) => void;
  onDelete?: () => void;
  onSave: (content: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"runtime" | "training">("runtime");
  const [content, setContent] = useState(initial?.content ?? defaultHookSource("new-hook", "runtime"));
  const create = () => onCreate({ name, mode, content: content.replaceAll('name: "new-hook"', `name: "${name.trim()}"`).replaceAll('checkpoint: "after_loop"', `checkpoint: "${mode === "runtime" ? "after_loop" : "after_evaluation"}"`) });
  return (
    <Dialog busy={busy} onClose={onClose} title={t(initial ? "plugins.editHookTitle" : "plugins.addHookTitle")}>
      <div className="grid max-h-[78vh] w-[min(860px,92vw)] grid-rows-[auto_minmax(280px,1fr)_auto] overflow-hidden">
        {initial ? <div className="border-b border-[#dce5e5] px-4 py-2 font-mono text-[10px] text-[#526b70]">{initial.id} · {initial.mode} · {initial.checkpoint}</div> : <div className="grid grid-cols-2 gap-3 border-b border-[#dce5e5] px-4 py-3"><label className="grid gap-1 text-[9px] font-semibold text-[#526b70]">{t("plugins.resourceName")}<input autoFocus className="h-7 border border-[#b9caca] bg-white px-2 font-mono text-[10px] outline-none focus:border-[#0c766e]" onChange={(event) => setName(event.target.value)} value={name} /></label><label className="grid gap-1 text-[9px] font-semibold text-[#526b70]">{t("plugins.hookMode")}<select className="h-7 border border-[#b9caca] bg-white px-2 text-[10px] outline-none focus:border-[#0c766e]" onChange={(event) => { const next = event.target.value as "runtime" | "training"; setMode(next); setContent(defaultHookSource(name.trim() || "new-hook", next)); }} value={mode}><option value="runtime">{t("plugins.runtimeHook")}</option><option value="training">{t("plugins.trainingHook")}</option></select></label></div>}
        <CodeSurface ariaLabel={t("plugins.hookEditor")} className="min-h-[280px]" language="TypeScript" minHeight="280px" onChange={setContent} onSave={initial ? () => onSave(content) : create} statusBar value={content} />
        <footer className="flex items-center justify-between border-t border-[#dce5e5] bg-[#f8faf9] px-4 py-3"><div>{onDelete && <button className="flex h-7 items-center gap-1.5 border border-[#cfaaaa] bg-white px-3 text-[9px] font-semibold text-[#91483f] disabled:opacity-60" disabled={busy} onClick={onDelete} type="button"><Trash2 size={11} />{t("plugins.deleteHook")}</button>}</div><div className="flex gap-2"><button className="h-7 border border-[#b9caca] bg-white px-3 text-[9px] font-semibold text-[#526b70]" disabled={busy} onClick={onClose} type="button">{t("plugins.cancel")}</button><button className="flex h-7 items-center gap-1.5 bg-[#315f64] px-3 text-[9px] font-semibold text-white disabled:bg-[#9eb7b8]" disabled={busy || (!initial && !name.trim())} onClick={initial ? () => onSave(content) : create} type="button">{busy && <LoaderCircle className="animate-spin" size={11} />}{t(initial ? "plugins.saveHook" : "plugins.createHook")}</button></div></footer>
      </div>
    </Dialog>
  );
}

function CreatePluginDialog({ busy, onClose, onConfirm }: {
  busy: boolean;
  onClose: () => void;
  onConfirm: (name: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  return (
    <Dialog busy={busy} onClose={onClose} title={t("plugins.createPluginTitle")}>
      <div>
        <div className="border-b border-[#dce5e5] p-4">
          <label className="grid gap-1.5 text-[10px] font-semibold text-[#536d72]">
            {t("plugins.pluginName")}
            <input autoFocus className="h-8 border border-[#b9caca] bg-white px-2 font-mono text-[10px] text-[#29484c] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]" disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="document-analysis" value={name} />
          </label>
          <p className="mt-2 text-[9px] leading-4 text-[#718488]">{t("plugins.pluginNameHelp")}</p>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-[#cbd8d9] bg-[#f8faf9] px-4 py-3">
          <button className="h-7 border border-[#b9caca] bg-white px-3 text-[9px] font-semibold text-[#526b70]" disabled={busy} onClick={onClose} type="button">{t("plugins.cancel")}</button>
          <button className="flex h-7 items-center gap-1.5 bg-[#0c766e] px-3 text-[9px] font-semibold text-white disabled:bg-[#9cb2af]" disabled={busy || !name.trim()} onClick={() => onConfirm(name)} type="button">{busy && <LoaderCircle className="animate-spin" size={11} />}{t("plugins.createPlugin")}</button>
        </footer>
      </div>
    </Dialog>
  );
}

function UninstallDialog({ busy, onClose, onConfirm, plugin }: { busy: boolean; onClose: () => void; onConfirm: () => void; plugin: ResourcePluginView }) {
  const { t } = useI18n();
  return (
    <Dialog busy={busy} onClose={onClose} title={t("plugins.uninstallTitle")}>
      <div className="minimal-scrollbar overflow-y-auto">
        <div className="flex items-start gap-3 border-b border-[#dce5e5] p-4"><ShieldAlert aria-hidden="true" className="mt-0.5 shrink-0 text-[#a85a36]" size={18} /><div className="min-w-0"><div className="font-mono text-[11px] font-semibold text-[#29484c]">{plugin.id} · v{plugin.version}</div><p className="mt-1 text-[10px] leading-4 text-[#60777a]">{t("plugins.uninstallDescription")}</p></div></div>
        <section className="border-b border-[#dce5e5]">
          <h3 className="h-7 bg-[#f5f8f7] px-4 text-[9px] font-semibold uppercase leading-7 text-[#6b7e82]">{t("plugins.requiredTools")}</h3>
          {plugin.requiredTools.length > 0 ? plugin.requiredTools.map((dependency) => (
            <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-t border-[#e2e9e9] px-4 py-2" data-tool-dependency={dependency.requestedId} key={dependency.requestedId}>
              <div className="min-w-0"><div className="truncate font-mono text-[10px] font-semibold text-[#29484c]">{dependency.requestedId}</div><div className="mt-0.5 truncate text-[9px] text-[#718488]">{t("plugins.toolVersionRequirement", { installed: dependency.installedVersion ?? "-", requested: dependency.requestedVersion })}</div></div>
              <ToolStatus dependency={dependency} />
            </div>
          )) : <div className="border-t border-[#e2e9e9] px-4 py-3 text-[9px] text-[#718488]">{t("plugins.noToolDependencies")}</div>}
        </section>
        <footer className="flex justify-end gap-2 bg-[#f8faf9] px-4 py-3"><button className="h-7 border border-[#b9caca] bg-white px-3 text-[9px] font-semibold text-[#526b70]" disabled={busy} onClick={onClose} type="button">{t("plugins.cancel")}</button><button className="flex h-7 items-center gap-1.5 bg-[#9b4141] px-3 text-[9px] font-semibold text-white disabled:bg-[#c9a3a3]" disabled={busy} onClick={onConfirm} type="button">{busy ? <LoaderCircle className="animate-spin" size={11} /> : <Trash2 size={11} />}{t("plugins.confirmUninstall")}</button></footer>
      </div>
    </Dialog>
  );
}

function OrphanToolsDialog({ busy, onClose, onUninstall, tools }: { busy: boolean; onClose: () => void; onUninstall: (packages: string[]) => void; tools: ToolPackageResource[] }) {
  const { t } = useI18n();
  const [inspect, setInspect] = useState(false);
  const [selected, setSelected] = useState(() => new Set(tools.map((tool) => tool.package)));
  return (
    <Dialog busy={busy} onClose={onClose} title={t("plugins.orphanedToolsTitle")}>
      <div>
        <div className="border-b border-[#dce5e5] px-4 py-3 text-[10px] leading-4 text-[#526b70]">{t("plugins.orphanedToolsDescription")}</div>
        <div>{tools.map((tool) => <label className="grid min-h-11 grid-cols-[18px_1fr_auto] items-center gap-2 border-b border-[#e0e8e8] px-4 py-2" key={tool.package}>{inspect ? <input checked={selected.has(tool.package)} disabled={busy} onChange={(event) => setSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(tool.package); else next.delete(tool.package); return next; })} type="checkbox" /> : <Wrench aria-hidden="true" className="text-[#537277]" size={13} />}<span className="min-w-0"><span className="block truncate font-mono text-[10px] font-semibold text-[#29484c]">{tool.package}</span><span className="mt-0.5 block text-[9px] text-[#718488]">v{tool.version} · {t("plugins.noDependents")}</span></span><span className="font-mono text-[8px] text-[#718488]">{tool.manifestPath}</span></label>)}</div>
        <footer className="flex justify-end gap-2 bg-[#f8faf9] px-4 py-3"><button className="h-7 border border-[#b9caca] bg-white px-3 text-[9px] font-semibold text-[#526b70]" disabled={busy} onClick={onClose} type="button">{t("plugins.keepTools")}</button>{!inspect ? <button className="h-7 bg-[#315f64] px-3 text-[9px] font-semibold text-white" disabled={busy} onClick={() => setInspect(true)} type="button">{t("plugins.inspectAndUninstall")}</button> : <button className="flex h-7 items-center gap-1.5 bg-[#9b4141] px-3 text-[9px] font-semibold text-white disabled:bg-[#c9a3a3]" disabled={busy || selected.size === 0} onClick={() => onUninstall([...selected])} type="button">{busy ? <LoaderCircle className="animate-spin" size={11} /> : <Trash2 size={11} />}{t("plugins.uninstallSelectedTools", { count: selected.size })}</button>}</footer>
      </div>
    </Dialog>
  );
}

export default function PluginResourceWorkspace({ divider, onManageTools, projectPath, variables }: { divider: ReactNode; onManageTools: () => void; projectPath: string; variables: BasePluginVariableDefinition[] }) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<ResourceCatalog>({ revision: "", items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedPluginId, setSelectedPluginId] = useState("");
  const [tab, setTab] = useState<PluginTab>("overview");
  const [dialog, setDialog] = useState<"install" | "uninstall" | "orphans" | null>(null);
  const [busy, setBusy] = useState(false);
  const [orphanedTools, setOrphanedTools] = useState<ToolPackageResource[]>([]);
  const [editingVariable, setEditingVariable] = useState<PluginVariableDefinition | "new">();
  const [dependencyToRemove, setDependencyToRemove] = useState<PluginVariableDefinition>();
  const [editingHarness, setEditingHarness] = useState<HarnessResourceDefinition | "new">();
  const [editingHook, setEditingHook] = useState<HookResourceDefinition | "new">();

  useEffect(() => {
    let active = true;
    void resourceApi.catalog(projectPath).then((nextCatalog) => {
      if (!active) return;
      setCatalog(nextCatalog);
      setError(null);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [projectPath]);

  const plugins = useMemo(() => buildResourcePluginViews(catalog, variables), [catalog, variables]);
  const filtered = useMemo(() => { const normalized = query.trim().toLowerCase(); return plugins.filter((plugin) => `${plugin.id} ${plugin.name} ${plugin.sources.join(" ")}`.toLowerCase().includes(normalized)); }, [plugins, query]);
  const selectedPlugin = plugins.find((plugin) => plugin.id === selectedPluginId) ?? plugins[0];
  const closeDialog = () => { if (!busy) { setDialog(null); setOrphanedTools([]); } };
  const createPlugin = async (name: string) => { setBusy(true); try { const result = await resourceApi.createPlugin(projectPath, name); setCatalog(result.catalog); setSelectedPluginId(result.plugin.id); setTab("overview"); setDialog(null); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const uninstall = async () => { if (!selectedPlugin) return; setBusy(true); try { const result = await resourceApi.uninstallPlugin(projectPath, selectedPlugin.id); setCatalog(result.catalog); setSelectedPluginId(""); setError(null); if (result.orphanedTools.length > 0) { setOrphanedTools(result.orphanedTools); setDialog("orphans"); } else setDialog(null); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const setEnabled = async () => { if (!selectedPlugin?.uninstallable) return; setBusy(true); try { const result = await resourceApi.setPluginEnabled(projectPath, selectedPlugin.id, !selectedPlugin.enabled); setCatalog(result.catalog); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const uninstallOrphans = async (packages: string[]) => { setBusy(true); try { let nextCatalog = catalog; for (const packageName of packages) nextCatalog = (await resourceApi.uninstallToolPackage(projectPath, packageName)).catalog; setCatalog(nextCatalog); setDialog(null); setOrphanedTools([]); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  const variablePayload = (variable: PluginVariableDefinition) => ({
    key: variable.key.trim(),
    type: variable.type,
    label: variable.label.trim(),
    description: variable.description,
    value: variable.value,
    ...(variable.type === "prompt_template" && variable.template?.trim() ? { template: variable.template.trim() } : {}),
    required: variable.required,
    readonly: false,
    show_in_status: variable.show_in_status,
    scope: variable.scope ?? "session" as const,
    source: selectedPlugin?.ownerKind === "installed" ? "plugin" as const : "project" as const,
    ...(selectedPlugin ? { owner: selectedPlugin.id } : {}),
  });
  const saveVariable = async (variable: PluginVariableDefinition) => {
    if (!selectedPlugin) return;
    const registered = selectedPlugin.variables.filter((item) => item.relation === "registered");
    const next = editingVariable === "new"
      ? [...registered, variable]
      : registered.map((item) => item.key === editingVariable?.key ? variable : item);
    setBusy(true);
    try {
      const result = await resourceApi.savePluginVariables(projectPath, selectedPlugin.id, next.map(variablePayload), catalog.revision);
      setCatalog(result.catalog);
      setEditingVariable(undefined);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const deleteVariable = async () => {
    if (!selectedPlugin || !editingVariable || editingVariable === "new") return;
    const next = selectedPlugin.variables.filter((item) => item.relation === "registered" && item.key !== editingVariable.key);
    setBusy(true);
    try {
      const result = await resourceApi.savePluginVariables(projectPath, selectedPlugin.id, next.map(variablePayload), catalog.revision);
      setCatalog(result.catalog);
      setEditingVariable(undefined);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const removeVariableDependency = async () => {
    if (!selectedPlugin || !dependencyToRemove) return;
    setBusy(true);
    try {
      const result = await resourceApi.removePluginVariableDependency(projectPath, selectedPlugin.id, dependencyToRemove.key, catalog.revision);
      setCatalog(result.catalog);
      setDependencyToRemove(undefined);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const createHarness = async (input: { name: string; description: string; type: HarnessResourceDefinition["type"]; activation: Record<string, unknown>; inputs: string[]; requiredTools: string[]; content: string }) => {
    if (!selectedPlugin) return;
    setBusy(true);
    try {
      const result = await resourceApi.createPluginHarness(projectPath, selectedPlugin.id, { ...input, catalogRevision: catalog.revision });
      setCatalog(result.catalog);
      setEditingHarness(undefined);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const saveHarness = async (content: string) => {
    if (!selectedPlugin || !editingHarness || editingHarness === "new") return;
    setBusy(true);
    try {
      const result = await resourceApi.savePluginHarness(projectPath, selectedPlugin.id, editingHarness.id, content, editingHarness.entryRevision, catalog.revision);
      setCatalog(result.catalog);
      setEditingHarness(undefined);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const deleteHarness = async () => {
    if (!selectedPlugin || !editingHarness || editingHarness === "new") return;
    setBusy(true);
    try {
      const result = await resourceApi.deletePluginHarness(projectPath, selectedPlugin.id, editingHarness.id, editingHarness.entryRevision, catalog.revision);
      setCatalog(result.catalog);
      setEditingHarness(undefined);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const createHook = async (input: { name: string; mode: "runtime" | "training"; content: string }) => {
    if (!selectedPlugin) return;
    setBusy(true);
    try {
      const result = await resourceApi.createPluginHook(projectPath, selectedPlugin.id, { ...input, catalogRevision: catalog.revision });
      setCatalog(result.catalog);
      setEditingHook(undefined);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const saveHook = async (content: string) => {
    if (!selectedPlugin || !editingHook || editingHook === "new") return;
    setBusy(true);
    try {
      const result = await resourceApi.savePluginHook(projectPath, selectedPlugin.id, editingHook.id, content, editingHook.entryRevision, catalog.revision);
      setCatalog(result.catalog);
      setEditingHook(undefined);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const deleteHook = async () => {
    if (!selectedPlugin || !editingHook || editingHook === "new") return;
    setBusy(true);
    try {
      const result = await resourceApi.deletePluginHook(projectPath, selectedPlugin.id, editingHook.id, editingHook.entryRevision, catalog.revision);
      setCatalog(result.catalog);
      setEditingHook(undefined);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const tabs: WorkspaceTab<PluginTab>[] = [
    { id: "overview", icon: Blocks, label: t("plugins.overview") },
    { id: "variables", icon: Variable, label: t("plugins.variables"), badge: selectedPlugin?.variables.length || undefined },
    { id: "harnesses", icon: FileCode2, label: t("plugins.harnesses"), badge: selectedPlugin?.harnesses.length || undefined },
    { id: "hooks", icon: Webhook, label: t("plugins.hooks"), badge: selectedPlugin?.hooks.length || undefined },
    { id: "tools", icon: Wrench, label: t("plugins.tools"), badge: selectedPlugin ? pluginToolCount(selectedPlugin) || undefined : undefined },
  ];

  return (
    <>
      <WorkspaceListPane countLabel={t("plugins.count", { count: filtered.length })} empty={!loading && filtered.length === 0} emptyLabel={t("plugins.noPlugins")} headerActions={<button aria-label={t("plugins.install")} className="grid h-6 w-6 place-items-center text-[#537277] outline-none hover:bg-[#dfeae8] focus-visible:ring-2 focus-visible:ring-[#0c766e]" onClick={() => setDialog("install")} title={t("plugins.install")} type="button"><Plus aria-hidden="true" size={13} /></button>} id="resource-plugins-list" loading={loading} loadingLabel={t("resources.loading")} onQueryChange={setQuery} query={query} searchLabel={t("plugins.search")} title={t("resources.plugins")}>
        {filtered.map((plugin) => <button aria-pressed={selectedPlugin?.id === plugin.id} className={selectedPlugin?.id === plugin.id ? "grid h-14 w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#d4dfdf] bg-[#dcecea] px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" : "grid h-14 w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#e0e8e8] bg-white px-3 text-left outline-none hover:bg-[#eef4f3] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"} data-plugin-id={plugin.id} key={plugin.id} onClick={() => { setSelectedPluginId(plugin.id); setTab("overview"); setEditingVariable(undefined); setDependencyToRemove(undefined); setEditingHarness(undefined); setEditingHook(undefined); }} type="button"><span aria-hidden="true" className={plugin.status === "ready" ? "h-1.5 w-1.5 bg-[#2d8a69]" : "h-1.5 w-1.5 bg-[#c47b25]"} /><span className="min-w-0"><span className="block truncate font-mono text-[11px] font-semibold text-[#29484c]">{plugin.id}</span><span className="mt-0.5 block truncate text-[9px] text-[#718488]">{t("plugins.summary", { variables: plugin.variables.length, harnesses: plugin.harnesses.length, hooks: plugin.hooks.length, tools: pluginToolCount(plugin) })}</span></span>{plugin.status === "attention" && <CircleAlert aria-label={t("plugins.attention")} className="text-[#a9681c]" size={12} />}</button>)}
      </WorkspaceListPane>
      {divider}
      <section aria-labelledby="resource-plugins-tab" className="grid min-h-0 grid-rows-[34px_34px_minmax(0,1fr)] bg-white" id="resource-plugins-panel" role="tabpanel">
        {selectedPlugin ? (
          <>
            <PanelHeader
              actions={(
                <div className="flex items-center gap-1">
                  {selectedPlugin.uninstallable && (
                    <button
                      aria-checked={selectedPlugin.enabled}
                      aria-label={t(selectedPlugin.enabled ? "plugins.disable" : "plugins.enable")}
                      className={selectedPlugin.enabled
                        ? "grid h-6 w-6 place-items-center border border-[#8fb9ae] bg-[#e5f2ed] text-[#17634f] outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e]"
                        : "grid h-6 w-6 place-items-center border border-[#c8b58f] bg-[#fff5e5] text-[#8b5516] outline-none focus-visible:ring-2 focus-visible:ring-[#8b5516]"}
                      disabled={busy}
                      onClick={() => void setEnabled()}
                      role="switch"
                      title={t(selectedPlugin.enabled ? "plugins.disable" : "plugins.enable")}
                      type="button"
                    >
                      <Power aria-hidden="true" size={11} />
                    </button>
                  )}
                  <button aria-label={t("plugins.manageTools")} className="grid h-6 w-6 place-items-center border border-[#a8bcbc] bg-white text-[#31575b] outline-none hover:bg-[#e8f1ef] focus-visible:ring-2 focus-visible:ring-[#0c766e]" onClick={onManageTools} title={t("plugins.manageTools")} type="button"><Wrench aria-hidden="true" size={11} /></button>
                  {selectedPlugin.uninstallable && <button aria-label={t("plugins.uninstall")} className="grid h-6 w-6 place-items-center border border-[#cfaaaa] bg-white text-[#91483f] outline-none hover:bg-[#f8e9e8] focus-visible:ring-2 focus-visible:ring-[#9b4141]" onClick={() => setDialog("uninstall")} title={t("plugins.uninstall")} type="button"><Trash2 aria-hidden="true" size={11} /></button>}
                </div>
              )}
              icon={Box}
              metadata={<StatusBadge status={selectedPlugin.status} />}
              monospace
              title={selectedPlugin.id}
            />
            <WorkspaceTabs activeTab={tab} ariaLabel={t("plugins.views")} idPrefix="resource-plugin" onChange={setTab} tabs={tabs} />
            <div className="min-h-0">
              {tab === "overview" && <PluginOverview plugin={selectedPlugin} />}
              {tab === "variables" && <PluginVariables busy={busy} onAdd={() => setEditingVariable("new")} onEdit={setEditingVariable} onRemoveDependency={setDependencyToRemove} plugin={selectedPlugin} />}
              {tab === "harnesses" && <PluginHarnesses busy={busy} onAdd={() => setEditingHarness("new")} onEdit={setEditingHarness} plugin={selectedPlugin} />}
              {tab === "hooks" && <PluginHooks busy={busy} onAdd={() => setEditingHook("new")} onEdit={setEditingHook} plugin={selectedPlugin} />}
              {tab === "tools" && <PluginTools plugin={selectedPlugin} />}
            </div>
          </>
        ) : <div className="col-span-full row-span-full"><EmptyPane label={error ?? t("plugins.noPlugins")} /></div>}
      </section>
      {dialog === "install" && <CreatePluginDialog busy={busy} onClose={closeDialog} onConfirm={(name) => void createPlugin(name)} />}
      {dialog === "uninstall" && selectedPlugin && <UninstallDialog busy={busy} onClose={closeDialog} onConfirm={() => void uninstall()} plugin={selectedPlugin} />}
      {dialog === "orphans" && <OrphanToolsDialog busy={busy} onClose={closeDialog} onUninstall={(packages) => void uninstallOrphans(packages)} tools={orphanedTools} />}
      {editingVariable && selectedPlugin && <VariableDialog busy={busy} initial={editingVariable === "new" ? undefined : editingVariable} installed={selectedPlugin.ownerKind === "installed"} key={`${selectedPlugin.id}:${editingVariable === "new" ? "new" : editingVariable.key}`} onClose={() => setEditingVariable(undefined)} onDelete={editingVariable === "new" ? undefined : () => void deleteVariable()} onSave={(variable) => void saveVariable(variable)} variables={selectedPlugin.variables} />}
      {dependencyToRemove && selectedPlugin && <RemoveVariableDependencyDialog busy={busy} onClose={() => setDependencyToRemove(undefined)} onConfirm={() => void removeVariableDependency()} plugin={selectedPlugin} variable={dependencyToRemove} />}
      {editingHarness && selectedPlugin && <HarnessEditorDialog busy={busy} initial={editingHarness === "new" ? undefined : editingHarness} key={`${selectedPlugin.id}:${editingHarness === "new" ? "new-harness" : editingHarness.id}`} onClose={() => setEditingHarness(undefined)} onCreate={(input) => void createHarness(input)} onDelete={editingHarness === "new" ? undefined : () => void deleteHarness()} onSave={(content) => void saveHarness(content)} />}
      {editingHook && selectedPlugin && <HookEditorDialog busy={busy} initial={editingHook === "new" ? undefined : editingHook} key={`${selectedPlugin.id}:${editingHook === "new" ? "new-hook" : `${editingHook.mode}:${editingHook.id}`}`} onClose={() => setEditingHook(undefined)} onCreate={(input) => void createHook(input)} onDelete={editingHook === "new" ? undefined : () => void deleteHook()} onSave={(content) => void saveHook(content)} />}
      {error && <div className="absolute bottom-3 right-3 max-w-md border border-[#c68d8d] bg-[#fff1f0] px-3 py-2 text-[10px] text-[#8f3535]" role="alert">{error}</div>}
    </>
  );
}
