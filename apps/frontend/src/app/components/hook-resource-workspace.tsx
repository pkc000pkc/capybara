"use client";

import {
  Braces,
  CheckCircle2,
  CircleAlert,
  FileCode2,
  LoaderCircle,
  Play,
  Plus,
  Save,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import {
  resourceApi,
  type HookResourceDefinition,
  type HookResourceModule,
  type HookTestFixture,
} from "../resource-api";
import CodeSurface from "./code-surface";
import { PanelHeader, WorkspaceListPane, WorkspaceTabs, type WorkspaceTab } from "./workspace-ui";

type HookView = "function" | "contract" | "test";

const HOOK_TABS: readonly WorkspaceTab<HookView>[] = [
  { id: "function", label: null, icon: FileCode2 },
  { id: "contract", label: null, icon: Braces },
  { id: "test", label: null, icon: Play },
];

const DEFAULT_FIXTURE: HookTestFixture = {
  loopIteration: 1,
  status: {
    run: { status: "completed" },
    context: { usedTokens: 13000, maxTokens: 16000, utilization: 0.8125 },
    queueDepth: 0,
    messageCount: 12,
    variableTokens: { "builtin.sys_message": 13000 },
  },
  changedVariables: ["builtin.sys_message"],
  variables: {
    context: { history_summary: "" },
  },
  messages: [
    { role: "system", content: "Project system prompt" },
    { role: "user", content: "Inspect the project." },
    { role: "assistant", content: "Inspection completed." },
  ],
};

function hookTemplate(name: string): string {
  return `import { defineHook } from "@capybara/sdk";

export default defineHook({
  name: "${name}",
  description: "Run project logic after each completed Loop.",
  enabled: true,

  trigger({ status, changed }) {
    return status.run.status === "completed"
      && changed.has("builtin.sys_message");
  },

  schedule: {
    priority: 0,
    timeoutMs: 10000,
    onError: "continue",
  },

  permissions: { artifacts: "write" },

  async run({ status, logger }) {
    logger.info("Hook executed", { messageCount: status.messageCount });
    return {
      artifacts: [{
        title: "Hook result",
        value: { messageCount: status.messageCount },
      }],
    };
  },
});
`;
}

function hookFromModule(module: HookResourceModule): HookResourceDefinition | undefined {
  return module.hooks[0];
}

function HookListItem({ hook, onSelect, selected }: {
  hook: HookResourceDefinition;
  onSelect: () => void;
  selected: boolean;
}) {
  const { t } = useI18n();
  return (
    <button
      aria-pressed={selected}
      className={`grid min-h-16 w-full grid-cols-[8px_minmax(0,1fr)] items-start gap-2 border-b border-[#dce5e5] px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${selected ? "bg-[#dcecea]" : "bg-white hover:bg-[#eef4f3]"}`}
      onClick={onSelect}
      type="button"
    >
      <span aria-hidden="true" className={`mt-1.5 h-1.5 w-1.5 ${hook.enabled ? "bg-[#25806f]" : "bg-[#93a3a6]"}`} />
      <span className="min-w-0">
        <span className="block truncate font-mono text-[11px] font-semibold text-[#29484c]">{hook.name}</span>
        <span className="mt-1 flex min-w-0 items-center justify-between gap-2 text-[9px] text-[#72868a]">
          <span className="truncate font-mono" title={hook.triggerSummary}>{hook.triggerSummary}</span>
          <span className="shrink-0">{hook.enabled ? t("hooks.enabled") : t("hooks.disabled")}</span>
        </span>
      </span>
    </button>
  );
}

function ContractView({ hook }: { hook: HookResourceDefinition }) {
  const { t } = useI18n();
  const permissions = Object.entries(hook.permissions);
  return (
    <div className="minimal-scrollbar h-full overflow-y-auto bg-white p-4">
      <div className="mx-auto max-w-3xl space-y-4">
        <section className="border border-[#cbd8d9] bg-[#f8faf9]">
          <PanelHeader icon={Braces} metadata={hook.entry} title={t("hooks.executionContract")} />
          <dl className="grid grid-cols-2 gap-px bg-[#dce5e5] text-[10px]">
            {[
              [t("hooks.checkpoint"), hook.checkpoint],
              [t("hooks.triggerCondition"), hook.triggerSummary],
              [t("hooks.priority"), String(hook.schedule.priority)],
              [t("hooks.timeout"), `${hook.schedule.timeoutMs} ms`],
              [t("hooks.failurePolicy"), t(`hooks.failure.${hook.schedule.onError}`)],
              [t("hooks.validation"), hook.diagnostics.length === 0 ? t("hooks.validDeclaration") : `${hook.diagnostics.length}`],
            ].map(([label, value]) => (
              <div className="bg-white p-3" key={label}>
                <dt className="text-[9px] uppercase text-[#718488]">{label}</dt>
                <dd className="mt-1 break-words font-mono font-semibold text-[#29484c]">{value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="border border-[#cbd8d9] bg-white">
          <PanelHeader title={t("hooks.triggerReads")} />
          <div className="flex min-h-12 flex-wrap items-center gap-1.5 p-3">
            {hook.triggerInputs.length > 0 ? hook.triggerInputs.map((input) => (
              <span className="border border-[#c7d6d5] bg-[#edf4f3] px-2 py-1 font-mono text-[9px] text-[#31545a]" key={input}>{input}</span>
            )) : <span className="text-[10px] text-[#718488]">after_loop</span>}
          </div>
        </section>

        <section className="border border-[#cbd8d9] bg-white">
          <PanelHeader title={t("hooks.sdkResources")} />
          <div className="divide-y divide-[#dce5e5]">
            {permissions.length > 0 ? permissions.map(([resource, access]) => (
              <div className="grid grid-cols-[140px_1fr] px-3 py-2 text-[10px]" key={resource}>
                <span className="font-mono font-semibold text-[#29484c]">{resource}</span>
                <span className="font-mono text-[#61777b]">{access}</span>
              </div>
            )) : <div className="p-3 text-[10px] text-[#718488]">read-only</div>}
          </div>
        </section>

        {hook.diagnostics.length > 0 && (
          <section className="border border-[#d9aaa7] bg-[#fff5f4]">
            <PanelHeader icon={CircleAlert} title={t("hooks.validation")} />
            <div className="divide-y divide-[#efd5d3]">
              {hook.diagnostics.map((diagnostic, index) => (
                <div className="px-3 py-2 font-mono text-[10px] text-[#8f3535]" key={`${diagnostic.code}-${index}`}>
                  {diagnostic.code}: {diagnostic.message}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function TestView({ fixture, onFixtureChange, onRun, output, running }: {
  fixture: string;
  onFixtureChange: (value: string) => void;
  onRun: () => void;
  output: string;
  running: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="grid h-full min-h-0 grid-rows-[36px_minmax(0,1fr)] bg-white">
      <div className="flex items-center justify-between border-b border-[#cbd8d9] bg-[#f8faf9] px-2">
        <span className="text-[10px] text-[#657a7e]">{t("hooks.testHint")}</span>
        <button
          className="flex h-7 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e] focus-visible:ring-offset-1 disabled:cursor-wait disabled:bg-[#88aaa7]"
          disabled={running}
          onClick={onRun}
          type="button"
        >
          {running ? <LoaderCircle aria-hidden="true" className="animate-spin" size={12} /> : <Play aria-hidden="true" size={12} />}
          {t("hooks.runTest")}
        </button>
      </div>
      <div className="grid min-h-0 grid-cols-2 divide-x divide-[#cbd8d9]">
        <section className="grid min-h-0 grid-rows-[28px_minmax(0,1fr)]">
          <PanelHeader title={t("hooks.fixture")} />
          <CodeSurface ariaLabel={t("hooks.fixture")} language="JSON" lineNumbers lineWrapping onChange={onFixtureChange} value={fixture} />
        </section>
        <section className="grid min-h-0 grid-rows-[28px_minmax(0,1fr)]">
          <PanelHeader title={t("hooks.testResult")} />
          <CodeSurface ariaLabel={t("hooks.testResult")} language="JSON" lineNumbers lineWrapping readOnly value={output || t("hooks.runToSeeResult")} />
        </section>
      </div>
    </div>
  );
}

export default function HookResourceWorkspace({ divider, projectPath }: {
  divider: ReactNode;
  projectPath: string;
}) {
  const { t } = useI18n();
  const [modules, setModules] = useState<HookResourceModule[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [activeView, setActiveView] = useState<HookView>("function");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [fixture, setFixture] = useState(() => JSON.stringify(DEFAULT_FIXTURE, null, 2));
  const [testOutput, setTestOutput] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const hooks = useMemo(
    () => modules.flatMap((module) => module.hooks),
    [modules],
  );
  const selected = hooks.find((hook) => hook.id === selectedId) ?? hooks[0];
  const selectedModule = modules.find((module) => module.hooks.some((hook) => hook.id === selected?.id));
  const filteredHooks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return hooks.filter((hook) => `${hook.name} ${hook.description} ${hook.triggerSummary}`.toLowerCase().includes(normalized));
  }, [hooks, query]);

  const selectHook = useCallback((hook: HookResourceDefinition) => {
    setSelectedId(hook.id);
    setSource(hook.content);
    setDirty(false);
    setTestOutput("");
    setError(null);
  }, []);

  useEffect(() => {
    let active = true;
    void resourceApi.catalog(projectPath).then((catalog) => {
      if (!active) return;
      const next = catalog.items.filter((item): item is HookResourceModule => item.kind === "hook");
      setModules(next);
      const current = next[0]?.hooks[0];
      if (current) selectHook(current);
      else {
        setSelectedId("");
        setSource("");
      }
    }).catch((cause: unknown) => {
      if (!active) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [projectPath, selectHook]);

  const replaceModule = (module: HookResourceModule) => {
    setModules((current) => [...current.filter((item) => item.id !== module.id), module]
      .sort((left, right) => left.name.localeCompare(right.name)));
    const hook = hookFromModule(module);
    if (hook) selectHook(hook);
  };

  const createHook = async () => {
    const name = newName.trim();
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name) || busy) {
      setError(t("hooks.invalidName"));
      return;
    }
    setBusy(true);
    try {
      replaceModule(await resourceApi.createHook(projectPath, name, hookTemplate(name)));
      setNewName("");
      setCreating(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveHook = async () => {
    if (!selected || !selectedModule || !dirty || busy) return;
    setBusy(true);
    try {
      replaceModule(await resourceApi.saveHook(projectPath, selected.id, source, selected.entryRevision));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const deleteHook = async () => {
    if (!selected || !selectedModule || busy || !window.confirm(t("hooks.deleteConfirm", { name: selected.name }))) return;
    setBusy(true);
    try {
      await resourceApi.deleteHook(projectPath, selected.id, selected.entryRevision);
      const next = modules.filter((module) => module.id !== selectedModule.id);
      setModules(next);
      const nextHook = next[0]?.hooks[0];
      if (nextHook) selectHook(nextHook);
      else {
        setSelectedId("");
        setSource("");
      }
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const testHook = async () => {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const parsed = JSON.parse(fixture) as HookTestFixture;
      const result = await resourceApi.testHook(projectPath, selected.id, parsed);
      setTestOutput(JSON.stringify(result, null, 2));
      setError(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setTestOutput(JSON.stringify({ error: message }, null, 2));
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  const tabs = HOOK_TABS.map((tab) => ({
    ...tab,
    controls: `hook-${tab.id}-panel`,
    label: t(`hooks.view.${tab.id}`),
    tabId: `hook-${tab.id}-tab`,
  }));

  const handleShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    void saveHook();
  };

  return (
    <>
      <WorkspaceListPane
        countLabel={t("resources.itemCount", { count: filteredHooks.length })}
        empty={filteredHooks.length === 0}
        emptyLabel={t("hooks.noHooks")}
        id="resource-hooks-list"
        loading={loading}
        loadingLabel={t("resources.loading")}
        onQueryChange={setQuery}
        query={query}
        searchLabel={t("hooks.search")}
        title={t("resources.hooks")}
      >
        <button
          className="flex h-9 w-full items-center gap-2 border-b border-[#d9e3e3] px-3 text-[10px] font-semibold text-[#0c766e] outline-none hover:bg-[#e8f1ef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
          onClick={() => setCreating(true)}
          type="button"
        >
          <Plus aria-hidden="true" size={13} />
          {t("hooks.add")}
        </button>
        {creating && (
          <div className="flex h-10 items-center gap-1 border-b border-[#d9e3e3] bg-[#edf4f3] px-2">
            <input
              aria-label={t("hooks.name")}
              autoFocus
              className="h-7 min-w-0 flex-1 border border-[#b9ccca] bg-white px-2 font-mono text-[10px] outline-none focus:border-[#0c766e]"
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void createHook();
                if (event.key === "Escape") setCreating(false);
              }}
              placeholder="my-project-hook"
              value={newName}
            />
            <button aria-label={t("hooks.create")} className="flex h-7 w-7 items-center justify-center text-[#0c766e] hover:bg-[#d8e8e5]" disabled={busy} onClick={() => void createHook()} title={t("hooks.create")} type="button"><CheckCircle2 size={13} /></button>
            <button aria-label={t("hooks.cancel")} className="flex h-7 w-7 items-center justify-center text-[#718488] hover:bg-[#e0e8e7]" onClick={() => setCreating(false)} title={t("hooks.cancel")} type="button"><X size={13} /></button>
          </div>
        )}
        {filteredHooks.map((hook) => <HookListItem hook={hook} key={hook.id} onSelect={() => selectHook(hook)} selected={hook.id === selected?.id} />)}
      </WorkspaceListPane>
      {divider}
      <div aria-labelledby="resource-hooks-tab" className="grid min-h-0 grid-rows-[34px_34px_minmax(0,1fr)] bg-white" id="resource-hooks-panel" onKeyDown={handleShortcut} role="tabpanel">
        <PanelHeader
          actions={selected && (
            <>
              <button aria-label={t("hooks.delete")} className="flex h-7 w-7 items-center justify-center text-[#8d3d3d] outline-none hover:bg-[#f7e7e5] focus-visible:ring-2 focus-visible:ring-[#a84b45] disabled:text-[#aab7b8]" disabled={busy} onClick={() => void deleteHook()} title={t("hooks.delete")} type="button"><Trash2 size={13} /></button>
              <button aria-label={t("hooks.saveDraft")} className="flex h-7 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#0c766e] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-[#9bb4b2]" disabled={!dirty || busy} onClick={() => void saveHook()} type="button">
                {busy && dirty ? <LoaderCircle className="animate-spin" size={12} /> : <Save size={12} />}
                {t("hooks.saveDraft")}
              </button>
            </>
          )}
          icon={Webhook}
          metadata={selected ? `${selected.enabled ? t("hooks.enabled") : t("hooks.disabled")} · ${selected.entry}` : undefined}
          monospace
          title={selected?.name ?? t("resources.hooks")}
        />
        <WorkspaceTabs activeTab={activeView} ariaLabel={t("hooks.views")} idPrefix="hook" onChange={setActiveView} tabs={tabs} />
        <div className="relative min-h-0" id={`hook-${activeView}-panel`} role="tabpanel">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-xs text-[#718488]">{loading ? t("resources.loading") : t("hooks.noHooks")}</div>
          ) : activeView === "function" ? (
            <CodeSurface ariaLabel={t("hooks.functionEditor")} language="TypeScript" lineNumbers onChange={(value) => { setSource(value); setDirty(value !== selected.content); }} onSave={() => void saveHook()} value={source} />
          ) : activeView === "contract" ? (
            <ContractView hook={selected} />
          ) : (
            <TestView fixture={fixture} onFixtureChange={setFixture} onRun={() => void testHook()} output={testOutput} running={busy} />
          )}
          {error && (
            <div className="absolute bottom-3 right-3 flex max-w-md items-start gap-2 border border-[#c68d8d] bg-[#fff1f0] px-3 py-2 text-[10px] text-[#8f3535] shadow-sm" role="alert">
              <CircleAlert className="mt-0.5 shrink-0" size={12} />
              <span>{error}</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
