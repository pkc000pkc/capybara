"use client";

import {
  ArrowRight,
  BarChart3,
  Braces,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Database,
  Filter,
  GitCompareArrows,
  History,
  Import,
  ListFilter,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Plus,
  Save,
  ScanSearch,
  Search,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingUp,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import CodeSurface from "./code-surface";
import { PanelHeader, SearchField, WorkspaceNavigation } from "./workspace-ui";

const RECALL_SECTIONS = [
  { id: "rules", icon: Code2 },
  { id: "testing", icon: ScanSearch },
  { id: "benchmarks", icon: Database },
  { id: "evaluation", icon: BarChart3 },
  { id: "versions", icon: History },
] as const;

type RecallSection = (typeof RECALL_SECTIONS)[number]["id"];
type RuleStatus = "active" | "validated" | "draft";

type RecallRule = {
  id: string;
  name: string;
  description: string;
  version: string;
  status: RuleStatus;
  updatedAt: string;
  code: string;
};

type RecallCandidate = {
  id: string;
  name: string;
  source: string;
  score: number;
  decision: "included" | "excluded";
  reason: string;
};

const RULES: RecallRule[] = [
  {
    id: "semantic-hybrid",
    name: "semantic-hybrid",
    description: "语义相似度、关键词命中和最近使用信号的混合召回",
    version: "v12",
    status: "active",
    updatedAt: "12 分钟前",
    code: `import type { RecallContext, RecallResult } from "@capybara/recall";

export async function recall(context: RecallContext): Promise<RecallResult> {
  const candidates = await context.search({
    query: context.intent,
    sources: ["plugin", "harness", "tool"],
    limit: 40,
  });

  return candidates
    .filter((candidate) => candidate.enabled)
    .map((candidate) => ({
      ...candidate,
      score:
        candidate.semanticScore * 0.65 +
        candidate.keywordScore * 0.25 +
        candidate.recencyScore * 0.1,
      reason: candidate.matches.slice(0, 3),
    }))
    .filter((candidate) => candidate.score >= 0.62)
    .sort((left, right) => right.score - left.score)
    .slice(0, 6);
}`,
  },
  {
    id: "tool-intent",
    name: "tool-intent",
    description: "根据用户意图召回可执行工具及其绑定 Harness",
    version: "v7",
    status: "validated",
    updatedAt: "昨天 18:42",
    code: `import type { RecallContext, RecallResult } from "@capybara/recall";

export async function recall(context: RecallContext): Promise<RecallResult> {
  const tools = await context.search({
    query: context.intent,
    sources: ["tool"],
    limit: 24,
  });

  return tools
    .filter((tool) => tool.permissions.every(context.permissions.has))
    .filter((tool) => tool.semanticScore >= 0.68)
    .sort((left, right) => right.semanticScore - left.semanticScore)
    .slice(0, 4);
}`,
  },
  {
    id: "research-memory",
    name: "research-memory",
    description: "从研究记录中召回经过验证的结论和证据",
    version: "v3",
    status: "draft",
    updatedAt: "8 月 31 日",
    code: `import type { RecallContext, RecallResult } from "@capybara/recall";

export async function recall(context: RecallContext): Promise<RecallResult> {
  const records = await context.search({
    query: context.intent,
    sources: ["research-ledger"],
    limit: 30,
  });

  return records
    .filter((record) => record.verification === "accepted")
    .sort((left, right) => right.semanticScore - left.semanticScore)
    .slice(0, 5);
}`,
  },
];

const CANDIDATES: RecallCandidate[] = [
  {
    id: "project-files",
    name: "project-files",
    source: "capybara-system / tool",
    score: 0.94,
    decision: "included",
    reason: "意图同时命中“读取项目文件”和“Jinja2 模板”；工具权限满足当前 Session。",
  },
  {
    id: "prompt-authoring",
    name: "prompt-authoring",
    source: "project / harness",
    score: 0.87,
    decision: "included",
    reason: "与提示词文件编辑高度相关，并绑定 project-files 工具。",
  },
  {
    id: "plugin-development",
    name: "plugin-development",
    source: "project / plugin",
    score: 0.73,
    decision: "included",
    reason: "当前请求涉及项目内组件开发，超过规则阈值 0.62。",
  },
  {
    id: "git-workflow",
    name: "git-workflow",
    source: "capybara-system / harness",
    score: 0.58,
    decision: "excluded",
    reason: "存在项目文件信号，但本轮没有版本控制意图，低于规则阈值。",
  },
];

const BENCHMARK_CASES = [
  { id: "recall-001", query: "读取 main.j2 并检查变量注入", expected: "project-files, prompt-authoring", split: "test", status: "pass" },
  { id: "recall-002", query: "为插件新增一个持久 Harness", expected: "plugin-development, project-files", split: "validation", status: "pass" },
  { id: "recall-003", query: "比较两个实验的工具调用差异", expected: "experiment-analysis", split: "test", status: "failed" },
  { id: "recall-004", query: "只修改当前 Session 的动态变量", expected: "variable-authoring", split: "training", status: "pass" },
  { id: "recall-005", query: "回滚上一次提交", expected: "git-workflow", split: "validation", status: "pass" },
] as const;

function ActionButton({
  children,
  disabled = false,
  onClick,
  primary = false,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  primary?: boolean;
}) {
  return (
    <button
      className={primary
        ? "flex h-7 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#6cc9c0] focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-[#a9b9b9]"
        : "flex h-7 items-center gap-1.5 border border-[#c6d4d4] bg-white px-2.5 text-[10px] font-semibold text-[#49666b] outline-none hover:bg-[#edf3f2] focus-visible:ring-2 focus-visible:ring-[#0c766e] disabled:cursor-not-allowed disabled:text-[#9aa9ab]"}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function StatusPill({ status }: { status: RuleStatus }) {
  const { t } = useI18n();
  const label = status === "active"
    ? t("recall.statusActive")
    : status === "validated"
      ? t("recall.statusValidated")
      : t("recall.statusDraft");
  return (
    <span
      className="recall-status inline-flex h-5 items-center gap-1 px-1.5 text-[9px] font-semibold"
      data-status={status}
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}

function RuleWorkspace() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(RULES[0].id);
  const [savedCode, setSavedCode] = useState<Record<string, string>>(() => Object.fromEntries(RULES.map((rule) => [rule.id, rule.code])));
  const [draft, setDraft] = useState(RULES[0].code);
  const selected = RULES.find((rule) => rule.id === selectedId) ?? RULES[0];
  const dirty = draft !== savedCode[selected.id];
  const filtered = RULES.filter((rule) => `${rule.name} ${rule.description}`.toLowerCase().includes(query.trim().toLowerCase()));

  const selectRule = (rule: RecallRule) => {
    setSelectedId(rule.id);
    setDraft(savedCode[rule.id] ?? rule.code);
  };

  return (
    <div className="grid h-full min-h-0 min-w-[940px] grid-cols-[248px_minmax(420px,1fr)_280px] bg-[#dce5e7]">
      <aside className="grid min-h-0 grid-rows-[34px_34px_1fr] bg-[#f8faf9]">
        <PanelHeader
          actions={<button aria-label={t("recall.newRule")} className="flex h-6 w-6 items-center justify-center text-[#0c766e] outline-none hover:bg-[#dcecea] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" title={t("recall.newRule")} type="button"><Plus aria-hidden="true" size={14} /></button>}
          title={t("recall.rules")}
        />
        <div className="border-b border-[#d9e3e3] p-1.5">
          <SearchField compact label={t("recall.searchRules")} onChange={setQuery} value={query} />
        </div>
        <div className="minimal-scrollbar min-h-0 overflow-y-auto">
          {filtered.map((rule) => {
            const active = selected.id === rule.id;
            return (
              <button
                aria-pressed={active}
                className={`grid min-h-[72px] w-full gap-1 border-b border-[#dbe4e4] px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${active ? "bg-[#dcecea]" : "bg-white hover:bg-[#eef4f3]"}`}
                key={rule.id}
                onClick={() => selectRule(rule)}
                type="button"
              >
                <span className="flex min-w-0 items-center justify-between gap-2">
                  <span className="truncate font-mono text-[10px] font-semibold text-[#26484c]">{rule.name}</span>
                  <span className="shrink-0 font-mono text-[9px] text-[#718488]">{rule.version}</span>
                </span>
                <span className="line-clamp-2 text-[9px] leading-3.5 text-[#6b7f82]">{rule.description}</span>
                <span className="flex items-center justify-between gap-2">
                  <StatusPill status={rule.status} />
                  <span className="text-[9px] text-[#869698]">{rule.updatedAt}</span>
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)] border-l border-[#bdcbcc] bg-white">
        <PanelHeader
          actions={(
            <>
              <span className={`font-mono text-[9px] ${dirty ? "text-[#a16a22]" : "text-[#718488]"}`}>{dirty ? t("recall.unsaved") : t("recall.saved")}</span>
              <ActionButton disabled={!dirty} onClick={() => setDraft(savedCode[selected.id] ?? selected.code)}>{t("recall.revert")}</ActionButton>
              <ActionButton disabled={!dirty} onClick={() => setSavedCode((current) => ({ ...current, [selected.id]: draft }))} primary><Save aria-hidden="true" size={12} />{t("recall.save")}</ActionButton>
            </>
          )}
          icon={Braces}
          metadata={`TypeScript · ${selected.version}`}
          monospace
          title={`${selected.name}.ts`}
        />
        <CodeSurface ariaLabel={t("recall.ruleCode")} language="TypeScript" onChange={setDraft} onSave={() => setSavedCode((current) => ({ ...current, [selected.id]: draft }))} value={draft} />
      </section>

      <aside className="minimal-scrollbar min-h-0 overflow-y-auto border-l border-[#bdcbcc] bg-white">
        <PanelHeader icon={SlidersHorizontal} title={t("recall.ruleSettings")} />
        <div className="grid gap-0 px-3 py-2">
          <label className="grid gap-1 border-b border-[#dce5e5] py-2 text-[9px] font-semibold text-[#60777a]">
            {t("recall.candidateSources")}
            <span className="flex flex-wrap gap-1 pt-1">
              {["Plugin", "Harness", "Tool"].map((source) => <span className="border border-[#bfd1cf] bg-[#edf5f3] px-1.5 py-1 font-mono text-[9px] font-normal text-[#2f625e]" key={source}>{source}</span>)}
            </span>
          </label>
          <label className="grid grid-cols-[1fr_72px] items-center gap-3 border-b border-[#dce5e5] py-2 text-[9px] font-semibold text-[#60777a]">
            {t("recall.topK")}
            <input className="h-7 border border-[#c6d4d4] px-2 text-right font-mono text-[10px] text-[#294247] outline-none focus:border-[#0c766e]" defaultValue="6" type="number" />
          </label>
          <label className="grid grid-cols-[1fr_72px] items-center gap-3 border-b border-[#dce5e5] py-2 text-[9px] font-semibold text-[#60777a]">
            {t("recall.threshold")}
            <input className="h-7 border border-[#c6d4d4] px-2 text-right font-mono text-[10px] text-[#294247] outline-none focus:border-[#0c766e]" defaultValue="0.62" max="1" min="0" step="0.01" type="number" />
          </label>
          <label className="grid grid-cols-[1fr_72px] items-center gap-3 border-b border-[#dce5e5] py-2 text-[9px] font-semibold text-[#60777a]">
            {t("recall.timeout")}
            <input className="h-7 border border-[#c6d4d4] px-2 text-right font-mono text-[10px] text-[#294247] outline-none focus:border-[#0c766e]" defaultValue="1500" type="number" />
          </label>
        </div>
        <section className="border-t border-[#cbd8d9]">
          <PanelHeader title={t("recall.contracts")} />
          <div className="grid gap-3 p-3">
            <div className="grid gap-1">
              <span className="text-[9px] font-semibold text-[#60777a]">{t("recall.inputContract")}</span>
              <pre className="whitespace-pre-wrap border border-[#d7e1e0] bg-[#f7faf9] p-2 font-mono text-[9px] leading-4 text-[#49666b]">{"{ intent, context, candidates, permissions }"}</pre>
            </div>
            <div className="grid gap-1">
              <span className="text-[9px] font-semibold text-[#60777a]">{t("recall.outputContract")}</span>
              <pre className="whitespace-pre-wrap border border-[#d7e1e0] bg-[#f7faf9] p-2 font-mono text-[9px] leading-4 text-[#49666b]">{"Array<{ id, score, reason, payload }>"}</pre>
            </div>
          </div>
        </section>
      </aside>
    </div>
  );
}

function RecallFlow() {
  const { t } = useI18n();
  const stages = [
    { label: t("recall.rawCandidates"), value: "36", icon: Search },
    { label: t("recall.filteredCandidates"), value: "12", icon: Filter },
    { label: t("recall.rankedCandidates"), value: "6", icon: ListFilter },
    { label: t("recall.injectedCandidates"), value: "3", icon: Sparkles },
  ];
  return (
    <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] items-stretch border-y border-[#cbd8d9] bg-white">
      {stages.map(({ icon: Icon, label, value }, index) => (
        <div className="contents" key={label}>
          <div className="flex min-w-0 items-center gap-2 px-3 py-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center border border-[#bcd0ce] bg-[#edf5f3] text-[#0c766e]"><Icon aria-hidden="true" size={13} /></span>
            <span className="min-w-0">
              <span className="block truncate text-[9px] text-[#718488]">{label}</span>
              <span className="font-mono text-sm font-semibold text-[#25494c]">{value}</span>
            </span>
          </div>
          {index < stages.length - 1 && <span className="flex items-center text-[#92a5a7]"><ArrowRight aria-hidden="true" size={14} /></span>}
        </div>
      ))}
    </div>
  );
}

function TestingWorkspace() {
  const { t } = useI18n();
  const [intent, setIntent] = useState("读取项目中的 main.j2，检查提示词变量的嵌套渲染是否正确");
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(true);
  const [selectedCandidate, setSelectedCandidate] = useState(CANDIDATES[0].id);

  const run = () => {
    setRunning(true);
    window.setTimeout(() => {
      setRunning(false);
      setHasRun(true);
    }, 650);
  };

  const candidate = CANDIDATES.find((entry) => entry.id === selectedCandidate) ?? CANDIDATES[0];
  return (
    <div className="grid h-full min-h-0 min-w-[900px] grid-cols-[350px_minmax(0,1fr)] bg-[#dce5e7]">
      <section className="minimal-scrollbar min-h-0 overflow-y-auto bg-white">
        <PanelHeader
          actions={<ActionButton disabled={!intent.trim() || running} onClick={run} primary>{running ? <LoaderCircle aria-hidden="true" className="animate-spin" size={12} /> : <Play aria-hidden="true" size={12} />}{running ? t("recall.running") : t("recall.runTest")}</ActionButton>}
          icon={ScanSearch}
          title={t("recall.testInput")}
        />
        <div className="grid gap-4 p-4">
          <label className="grid gap-1.5 text-[10px] font-semibold text-[#526b70]">
            {t("recall.userIntent")}
            <textarea className="min-h-24 resize-y border border-[#c6d4d4] bg-white p-2 text-xs font-normal leading-5 text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]" onChange={(event) => { setIntent(event.target.value); setHasRun(false); }} value={intent} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1.5 text-[10px] font-semibold text-[#526b70]">
              {t("recall.activeRule")}
              <select className="h-8 border border-[#c6d4d4] bg-white px-2 text-[10px] font-normal text-[#294247] outline-none focus:border-[#0c766e]" defaultValue="semantic-hybrid">
                {RULES.map((rule) => <option key={rule.id} value={rule.id}>{rule.name} · {rule.version}</option>)}
              </select>
            </label>
            <label className="grid gap-1.5 text-[10px] font-semibold text-[#526b70]">
              {t("recall.benchmarkDataset")}
              <select className="h-8 border border-[#c6d4d4] bg-white px-2 text-[10px] font-normal text-[#294247] outline-none focus:border-[#0c766e]" defaultValue="manual">
                <option value="manual">{t("recall.manualInput")}</option>
                <option value="core">core-recall-v4</option>
              </select>
            </label>
          </div>
          <div className="grid gap-1.5">
            <span className="text-[10px] font-semibold text-[#526b70]">{t("recall.runtimeContext")}</span>
            <div className="h-52 overflow-hidden border border-[#c6d4d4]">
              <CodeSurface
                ariaLabel={t("recall.runtimeContext")}
                language="JSON"
                lineNumbers={false}
                lineWrapping
                statusBar={false}
                value={'{\n  "project": "test-project",\n  "plugins": ["project", "capybara-system"],\n  "variables": {\n    "active_file": "main.j2",\n    "mode": "authoring"\n  }\n}'}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="grid min-h-0 grid-rows-[34px_auto_minmax(0,1fr)_166px] border-l border-[#bdcbcc] bg-white">
        <PanelHeader
          actions={hasRun ? <span className="flex items-center gap-3 font-mono text-[9px] text-[#60777a]"><span>{t("recall.latency")} 84 ms</span><span>{t("recall.contextTokens")} 1,286</span></span> : undefined}
          icon={Target}
          title={t("recall.testResult")}
        />
        <RecallFlow />
        <div className="minimal-scrollbar min-h-0 overflow-auto">
          <table className="w-full table-fixed border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-[#edf3f2] text-[9px] font-semibold text-[#60777a]">
              <tr>
                <th className="w-10 border-b border-[#cbd8d9] px-3 py-2">#</th>
                <th className="w-[24%] border-b border-[#cbd8d9] px-2 py-2">{t("recall.result")}</th>
                <th className="w-[24%] border-b border-[#cbd8d9] px-2 py-2">{t("recall.source")}</th>
                <th className="w-20 border-b border-[#cbd8d9] px-2 py-2">{t("recall.score")}</th>
                <th className="w-24 border-b border-[#cbd8d9] px-2 py-2">{t("recall.decision")}</th>
              </tr>
            </thead>
            <tbody>
              {CANDIDATES.map((entry, index) => {
                const selected = entry.id === selectedCandidate;
                return (
                  <tr className={`${selected ? "bg-[#e7f2f0]" : "hover:bg-[#f6f9f8]"} cursor-pointer`} key={entry.id} onClick={() => setSelectedCandidate(entry.id)}>
                    <td className="border-b border-[#e0e7e7] px-3 py-2 font-mono text-[9px] text-[#809193]">{index + 1}</td>
                    <td className="truncate border-b border-[#e0e7e7] px-2 py-2 font-mono text-[10px] font-semibold text-[#29484c]">{entry.name}</td>
                    <td className="truncate border-b border-[#e0e7e7] px-2 py-2 text-[9px] text-[#60777a]">{entry.source}</td>
                    <td className="border-b border-[#e0e7e7] px-2 py-2 font-mono text-[10px] font-semibold text-[#29484c]">{entry.score.toFixed(2)}</td>
                    <td className="border-b border-[#e0e7e7] px-2 py-2">
                      <span className={`inline-flex items-center gap-1 text-[9px] font-semibold ${entry.decision === "included" ? "text-[#257267]" : "text-[#8a5d2d]"}`}>
                        {entry.decision === "included" ? <Check aria-hidden="true" size={11} /> : <X aria-hidden="true" size={11} />}
                        {entry.decision === "included" ? t("recall.included") : t("recall.excluded")}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="border-t border-[#cbd8d9] bg-[#f8faf9]">
          <PanelHeader icon={CircleDot} metadata={candidate.source} monospace title={candidate.name} />
          <div className="grid grid-cols-[84px_1fr] gap-x-3 gap-y-2 px-4 py-3 text-[10px]">
            <span className="font-semibold text-[#718488]">{t("recall.score")}</span>
            <span className="font-mono font-semibold text-[#29484c]">{candidate.score.toFixed(2)} / 1.00</span>
            <span className="font-semibold text-[#718488]">{t("recall.reason")}</span>
            <span className="leading-4 text-[#49666b]">{candidate.reason}</span>
          </div>
        </div>
      </section>
    </div>
  );
}

function BenchmarkWorkspace() {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => BENCHMARK_CASES.filter((entry) => `${entry.id} ${entry.query} ${entry.expected}`.toLowerCase().includes(query.toLowerCase())), [query]);
  return (
    <div className="grid h-full min-h-0 min-w-[880px] grid-cols-[250px_minmax(0,1fr)] bg-[#dce5e7]">
      <aside className="grid min-h-0 grid-rows-[34px_1fr] bg-[#f8faf9]">
        <PanelHeader actions={<button aria-label={t("recall.newDataset")} className="flex h-6 w-6 items-center justify-center text-[#0c766e] outline-none hover:bg-[#dcecea]" title={t("recall.newDataset")} type="button"><Plus aria-hidden="true" size={14} /></button>} title={t("recall.datasets")} />
        <div className="minimal-scrollbar min-h-0 overflow-y-auto">
          <button aria-pressed="true" className="grid min-h-20 w-full gap-1 border-b border-[#dbe4e4] bg-[#dcecea] px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" type="button">
            <span className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] font-semibold text-[#26484c]">core-recall</span><span className="font-mono text-[9px] text-[#718488]">v4</span></span>
            <span className="text-[9px] leading-3.5 text-[#6b7f82]">{t("recall.coreDatasetDescription")}</span>
            <span className="flex items-center gap-2 text-[9px] text-[#718488]"><Database aria-hidden="true" size={11} />128 {t("recall.cases")}</span>
          </button>
          <button className="grid min-h-20 w-full gap-1 border-b border-[#dbe4e4] bg-white px-3 py-2 text-left outline-none hover:bg-[#eef4f3] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" type="button">
            <span className="flex items-center justify-between gap-2"><span className="font-mono text-[10px] font-semibold text-[#26484c]">tool-routing-edge</span><span className="font-mono text-[9px] text-[#718488]">v2</span></span>
            <span className="text-[9px] leading-3.5 text-[#6b7f82]">{t("recall.edgeDatasetDescription")}</span>
            <span className="flex items-center gap-2 text-[9px] text-[#718488]"><Database aria-hidden="true" size={11} />42 {t("recall.cases")}</span>
          </button>
        </div>
      </aside>
      <section className="grid min-h-0 grid-rows-[34px_42px_minmax(0,1fr)] border-l border-[#bdcbcc] bg-white">
        <PanelHeader
          actions={<><ActionButton><Import aria-hidden="true" size={12} />{t("recall.import")}</ActionButton><ActionButton primary><Plus aria-hidden="true" size={12} />{t("recall.newCase")}</ActionButton></>}
          icon={Database}
          metadata={`128 ${t("recall.cases")} · v4`}
          monospace
          title="core-recall"
        />
        <div className="flex items-center gap-2 border-b border-[#d9e3e3] px-2">
          <SearchField label={t("recall.searchCases")} onChange={setQuery} value={query} width="max-w-md" />
          <select aria-label={t("recall.datasetSplit")} className="h-7 border border-[#c6d4d4] bg-white px-2 text-[10px] text-[#49666b] outline-none focus:border-[#0c766e]" defaultValue="all">
            <option value="all">{t("recall.allSplits")}</option>
            <option value="training">Training</option>
            <option value="validation">Validation</option>
            <option value="test">Test</option>
          </select>
        </div>
        <div className="minimal-scrollbar min-h-0 overflow-auto">
          <table className="w-full table-fixed border-collapse text-left">
            <thead className="sticky top-0 z-10 bg-[#edf3f2] text-[9px] font-semibold text-[#60777a]">
              <tr>
                <th className="w-24 border-b border-[#cbd8d9] px-3 py-2">ID</th>
                <th className="w-[34%] border-b border-[#cbd8d9] px-2 py-2">{t("recall.query")}</th>
                <th className="w-[34%] border-b border-[#cbd8d9] px-2 py-2">{t("recall.expectedRecall")}</th>
                <th className="w-24 border-b border-[#cbd8d9] px-2 py-2">{t("recall.datasetSplit")}</th>
                <th className="w-16 border-b border-[#cbd8d9] px-2 py-2">{t("recall.result")}</th>
                <th className="w-12 border-b border-[#cbd8d9] px-2 py-2"><span className="sr-only">{t("recall.actions")}</span></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr className="hover:bg-[#f6f9f8]" key={entry.id}>
                  <td className="border-b border-[#e0e7e7] px-3 py-2 font-mono text-[9px] text-[#60777a]">{entry.id}</td>
                  <td className="border-b border-[#e0e7e7] px-2 py-2 text-[10px] leading-4 text-[#29484c]">{entry.query}</td>
                  <td className="border-b border-[#e0e7e7] px-2 py-2 font-mono text-[9px] leading-4 text-[#49666b]">{entry.expected}</td>
                  <td className="border-b border-[#e0e7e7] px-2 py-2"><span className="border border-[#cbd8d9] bg-[#f4f7f6] px-1.5 py-0.5 font-mono text-[8px] text-[#60777a]">{entry.split}</span></td>
                  <td className="border-b border-[#e0e7e7] px-2 py-2">{entry.status === "pass" ? <CheckCircle2 aria-label={t("recall.passed")} className="text-[#278071]" size={14} /> : <X aria-label={t("recall.failed")} className="text-[#9b4141]" size={14} />}</td>
                  <td className="border-b border-[#e0e7e7] px-2 py-2"><button aria-label={t("recall.actions")} className="flex h-6 w-6 items-center justify-center text-[#718488] outline-none hover:bg-[#e7eeee] focus-visible:ring-2 focus-visible:ring-[#0c766e]" type="button"><MoreHorizontal aria-hidden="true" size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({ delta, label, target, value }: { delta: string; label: string; target: string; value: string }) {
  return (
    <div className="min-w-0 border-r border-[#d7e1e0] px-4 py-3 last:border-r-0">
      <span className="block truncate text-[9px] font-semibold text-[#718488]">{label}</span>
      <span className="mt-1 flex items-baseline gap-2"><strong className="font-mono text-lg font-semibold text-[#21484a]">{value}</strong><span className="text-[9px] font-semibold text-[#28776c]">{delta}</span></span>
      <span className="mt-1 block font-mono text-[8px] text-[#8a999b]">{target}</span>
    </div>
  );
}

const EVALUATION_HISTORY = [
  { version: "v8", date: "08-22", dataset: "v2", cases: 84, recall: 0.79, precision: 0.82, mrr: 0.74, falsePositive: 11.8, miss: 15.5, latency: 61, note: "语义召回基线" },
  { version: "v9", date: "08-25", dataset: "v3", cases: 96, recall: 0.84, precision: 0.83, mrr: 0.77, falsePositive: 10.2, miss: 12.4, latency: 66, note: "加入来源权限过滤" },
  { version: "v10", date: "08-28", dataset: "v3", cases: 96, recall: 0.87, precision: 0.85, mrr: 0.81, falsePositive: 8.7, miss: 9.8, latency: 72, note: "合并关键词信号" },
  { version: "v11", date: "09-01", dataset: "v4", cases: 128, recall: 0.91, precision: 0.87, mrr: 0.83, falsePositive: 6.6, miss: 7.5, latency: 95, note: "加入最近使用信号" },
  { version: "v12", date: "09-03", dataset: "v4", cases: 128, recall: 0.93, precision: 0.88, mrr: 0.86, falsePositive: 5.4, miss: 6.7, latency: 84, note: "联合召回 Tool 与 Harness" },
] as const;

const TREND_SERIES = [
  { key: "recall", label: "Recall@5", color: "#0c766e" },
  { key: "precision", label: "Precision@5", color: "#c27a24" },
  { key: "mrr", label: "MRR", color: "#54728e" },
] as const;

function HistoryTrend() {
  const { t } = useI18n();
  const width = 620;
  const height = 152;
  const padding = { left: 38, right: 18, top: 20, bottom: 28 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const minimum = 0.7;
  const maximum = 1;
  const x = (index: number) => padding.left + (plotWidth * index) / (EVALUATION_HISTORY.length - 1);
  const y = (value: number) => padding.top + ((maximum - value) / (maximum - minimum)) * plotHeight;
  const path = (key: (typeof TREND_SERIES)[number]["key"]) => EVALUATION_HISTORY
    .map((point, index) => `${index === 0 ? "M" : "L"} ${x(index)} ${y(point[key])}`)
    .join(" ");

  return (
    <section className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)] border-b border-[#cbd8d9] bg-white" aria-labelledby="recall-history-heading">
      <PanelHeader
        actions={<div className="flex items-center gap-3">{TREND_SERIES.map((series) => <span className="flex items-center gap-1 text-[8px] text-[#60777a]" key={series.key}><span aria-hidden="true" className="h-0.5 w-3" style={{ background: series.color }} />{series.label}</span>)}</div>}
        icon={TrendingUp}
        title={t("recall.historyEvolution")}
        titleId="recall-history-heading"
      />
      <div className="grid min-h-0 grid-cols-[minmax(400px,1fr)_220px]">
        <div className="min-h-0 px-3 py-2">
          <svg aria-label={t("recall.historyTrendChart")} className="h-full min-h-[150px] w-full" role="img" viewBox={`0 0 ${width} ${height}`}>
            {[0.7, 0.8, 0.9, 1].map((tick) => (
              <g key={tick}>
                <line stroke="#dce5e5" strokeWidth="1" x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} />
                <text fill="#7a8d91" fontFamily="monospace" fontSize="8" textAnchor="end" x={padding.left - 7} y={y(tick) + 3}>{tick.toFixed(1)}</text>
              </g>
            ))}
            {EVALUATION_HISTORY.map((point, index) => <text fill="#718488" fontFamily="monospace" fontSize="8" key={point.version} textAnchor="middle" x={x(index)} y={height - 8}>{point.version}</text>)}
            {TREND_SERIES.map((series) => (
              <g key={series.key}>
                <path d={path(series.key)} fill="none" stroke={series.color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
                {EVALUATION_HISTORY.map((point, index) => <circle cx={x(index)} cy={y(point[series.key])} fill="#ffffff" key={point.version} r="3" stroke={series.color} strokeWidth="2" />)}
              </g>
            ))}
          </svg>
        </div>
        <div className="border-l border-[#dce5e5] bg-[#f8faf9] px-3 py-2">
          <p className="text-[9px] font-semibold text-[#526b70]">v8 → v12</p>
          <dl className="mt-2 grid gap-2">
            <div className="flex items-center justify-between"><dt className="text-[9px] text-[#718488]">Recall@5</dt><dd className="font-mono text-[10px] font-semibold text-[#247267]">+0.14</dd></div>
            <div className="flex items-center justify-between"><dt className="text-[9px] text-[#718488]">Precision@5</dt><dd className="font-mono text-[10px] font-semibold text-[#247267]">+0.06</dd></div>
            <div className="flex items-center justify-between"><dt className="text-[9px] text-[#718488]">MRR</dt><dd className="font-mono text-[10px] font-semibold text-[#247267]">+0.12</dd></div>
            <div className="flex items-center justify-between border-t border-[#d7e1e0] pt-2"><dt className="text-[9px] text-[#718488]">{t("recall.falsePositiveRate")}</dt><dd className="font-mono text-[10px] font-semibold text-[#247267]">-6.4%</dd></div>
          </dl>
          <p className="mt-3 border-l-2 border-[#0c766e] pl-2 text-[8px] leading-3.5 text-[#60777a]">{t("recall.historySummary")}</p>
        </div>
      </div>
    </section>
  );
}

function HistoryTable() {
  const { t } = useI18n();
  return (
    <section className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)] bg-[#f8faf9]">
      <PanelHeader actions={<span className="font-mono text-[9px] text-[#718488]">v8–v12</span>} icon={GitCompareArrows} title={t("recall.historicalData")} />
      <div className="minimal-scrollbar min-h-0 overflow-auto">
        <table className="w-full table-fixed border-collapse text-left">
          <thead className="sticky top-0 z-10 bg-[#edf3f2] text-[8px] font-semibold text-[#60777a]">
            <tr>
              <th className="w-12 border-b border-[#cbd8d9] px-2 py-2">{t("recall.ruleVersion")}</th>
              <th className="w-14 border-b border-[#cbd8d9] px-1 py-2">{t("recall.datasetVersion")}</th>
              <th className="w-12 border-b border-[#cbd8d9] px-1 py-2">R@5</th>
              <th className="w-12 border-b border-[#cbd8d9] px-1 py-2">P@5</th>
              <th className="w-11 border-b border-[#cbd8d9] px-1 py-2">MRR</th>
              <th className="w-12 border-b border-[#cbd8d9] px-1 py-2">{t("recall.falsePositiveShort")}</th>
              <th className="w-12 border-b border-[#cbd8d9] px-1 py-2">{t("recall.missRateShort")}</th>
              <th className="w-14 border-b border-[#cbd8d9] px-1 py-2">ms</th>
              <th className="border-b border-[#cbd8d9] px-2 py-2">{t("recall.versionChange")}</th>
            </tr>
          </thead>
          <tbody>
            {[...EVALUATION_HISTORY].reverse().map((entry, index) => (
              <tr className={index === 0 ? "bg-[#e7f2f0]" : "hover:bg-white"} key={entry.version}>
                <td className="border-b border-[#dce5e5] px-2 py-2"><span className="font-mono text-[9px] font-semibold text-[#29484c]">{entry.version}</span><span className="mt-0.5 block font-mono text-[7px] text-[#8a999b]">{entry.date}</span></td>
                <td className="border-b border-[#dce5e5] px-1 py-2 font-mono text-[8px] text-[#60777a]">{entry.dataset}<span className="block text-[7px]">{entry.cases}</span></td>
                <td className="border-b border-[#dce5e5] px-1 py-2 font-mono text-[9px] font-semibold text-[#29484c]">{entry.recall.toFixed(2)}</td>
                <td className="border-b border-[#dce5e5] px-1 py-2 font-mono text-[9px] text-[#49666b]">{entry.precision.toFixed(2)}</td>
                <td className="border-b border-[#dce5e5] px-1 py-2 font-mono text-[9px] text-[#49666b]">{entry.mrr.toFixed(2)}</td>
                <td className="border-b border-[#dce5e5] px-1 py-2 font-mono text-[8px] text-[#49666b]">{entry.falsePositive}%</td>
                <td className="border-b border-[#dce5e5] px-1 py-2 font-mono text-[8px] text-[#49666b]">{entry.miss}%</td>
                <td className="border-b border-[#dce5e5] px-1 py-2 font-mono text-[8px] text-[#49666b]">{entry.latency}</td>
                <td className="border-b border-[#dce5e5] px-2 py-2 text-[8px] leading-3 text-[#60777a]">{entry.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EvaluationWorkspace() {
  const { t } = useI18n();
  const failureCases = [
    { id: "recall-003", query: "比较两个实验的工具调用差异", expected: "experiment-analysis", actual: "git-workflow", score: "0.41" },
    { id: "recall-019", query: "将当前结论写入研究记录", expected: "research-ledger", actual: "project-files", score: "0.54" },
    { id: "recall-064", query: "校验插件声明的工具依赖", expected: "plugin-development", actual: "tool-intent", score: "0.59" },
  ];
  return (
    <div className="minimal-scrollbar grid h-full min-h-0 min-w-[1040px] grid-rows-[50px_auto_250px_170px_minmax(250px,1fr)] overflow-y-auto bg-white">
      <header className="flex items-center justify-between gap-4 border-b border-[#cbd8d9] px-4">
        <div className="flex min-w-0 items-center gap-3">
          <div><h2 className="text-xs font-semibold text-[#214247]">{t("recall.evaluationOverview")}</h2><p className="mt-0.5 text-[9px] text-[#718488]">core-recall · v4 · semantic-hybrid v12</p></div>
          <span className="recall-status px-1.5 py-1 text-[8px] font-semibold" data-status="validated">{t("recall.statusValidated")}</span>
        </div>
        <div className="flex gap-2"><ActionButton><GitCompareArrows aria-hidden="true" size={12} />{t("recall.compareVersion")}</ActionButton><ActionButton primary><Play aria-hidden="true" size={12} />{t("recall.runEvaluation")}</ActionButton></div>
      </header>
      <section aria-label={t("recall.metrics")} className="grid grid-cols-6 border-b border-[#cbd8d9] bg-[#f8faf9]">
        <Metric delta="+2.1%" label="Recall@5" target="target >= 0.90" value="0.93" />
        <Metric delta="+1.4%" label="Precision@5" target="target >= 0.85" value="0.88" />
        <Metric delta="+0.03" label="MRR" target="target >= 0.80" value="0.86" />
        <Metric delta="-1.2%" label={t("recall.falsePositiveRate")} target="target <= 0.08" value="5.4%" />
        <Metric delta="-0.8%" label={t("recall.missRate")} target="target <= 0.10" value="6.7%" />
        <Metric delta="-11ms" label={t("recall.averageLatency")} target="p95 132 ms" value="84ms" />
      </section>
      <HistoryTrend />
      <section className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)] border-b border-[#cbd8d9]">
        <PanelHeader actions={<span className="text-[9px] text-[#718488]">3 / 128</span>} icon={Target} title={t("recall.failedCases")} />
        <div className="minimal-scrollbar min-h-0 overflow-auto">
          <table className="w-full table-fixed border-collapse text-left">
            <thead className="sticky top-0 bg-[#edf3f2] text-[9px] font-semibold text-[#60777a]"><tr><th className="w-24 border-b border-[#cbd8d9] px-3 py-2">ID</th><th className="border-b border-[#cbd8d9] px-2 py-2">{t("recall.query")}</th><th className="w-[27%] border-b border-[#cbd8d9] px-2 py-2">{t("recall.expectedRecall")}</th><th className="w-[24%] border-b border-[#cbd8d9] px-2 py-2">{t("recall.actualRecall")}</th><th className="w-16 border-b border-[#cbd8d9] px-2 py-2">{t("recall.score")}</th></tr></thead>
            <tbody>{failureCases.map((entry) => <tr className="hover:bg-[#f6f9f8]" key={entry.id}><td className="border-b border-[#e0e7e7] px-3 py-2 font-mono text-[9px] text-[#60777a]">{entry.id}</td><td className="border-b border-[#e0e7e7] px-2 py-2 text-[10px] leading-4 text-[#29484c]">{entry.query}</td><td className="border-b border-[#e0e7e7] px-2 py-2 font-mono text-[9px] text-[#257267]">{entry.expected}</td><td className="border-b border-[#e0e7e7] px-2 py-2 font-mono text-[9px] text-[#914545]">{entry.actual}</td><td className="border-b border-[#e0e7e7] px-2 py-2 font-mono text-[9px] text-[#29484c]">{entry.score}</td></tr>)}</tbody>
          </table>
        </div>
      </section>
      <HistoryTable />
    </div>
  );
}

function VersionsWorkspace() {
  const { t } = useI18n();
  const versions = [
    { version: "v12", state: "active", author: "pkc00", time: "今天 09:42", note: "提高 Tool 与绑定 Harness 的联合召回权重", metric: "Recall@5 0.93" },
    { version: "v11", state: "validated", author: "pkc00", time: "昨天 17:18", note: "加入最近使用信号并调整阈值", metric: "Recall@5 0.91" },
    { version: "v10", state: "draft", author: "system", time: "8 月 30 日", note: "保存的实验分支", metric: "未评估" },
    { version: "v9", state: "validated", author: "pkc00", time: "8 月 28 日", note: "稳定基线", metric: "Recall@5 0.89" },
  ] as const;
  return (
    <div className="grid h-full min-h-0 min-w-[820px] grid-cols-[minmax(0,1fr)_320px] bg-white">
      <section className="grid min-h-0 grid-rows-[50px_minmax(0,1fr)] border-r border-[#cbd8d9]">
        <header className="flex items-center justify-between gap-4 border-b border-[#cbd8d9] px-4"><div><h2 className="text-xs font-semibold text-[#214247]">semantic-hybrid</h2><p className="mt-0.5 text-[9px] text-[#718488]">{t("recall.versionHistory")}</p></div><ActionButton primary><Sparkles aria-hidden="true" size={12} />{t("recall.publishDraft")}</ActionButton></header>
        <div className="minimal-scrollbar min-h-0 overflow-y-auto">
          {versions.map((entry, index) => (
            <article className="grid grid-cols-[78px_1fr_140px] gap-4 border-b border-[#dce5e5] px-4 py-4 hover:bg-[#f8faf9]" key={entry.version}>
              <div className="relative"><span className="font-mono text-sm font-semibold text-[#29484c]">{entry.version}</span>{index < versions.length - 1 && <span aria-hidden="true" className="absolute left-2 top-7 h-[52px] w-px bg-[#c6d4d4]" />}</div>
              <div className="min-w-0"><div className="flex items-center gap-2"><StatusPill status={entry.state} /><span className="text-[9px] text-[#718488]">{entry.author} · {entry.time}</span></div><p className="mt-2 text-[10px] leading-4 text-[#49666b]">{entry.note}</p></div>
              <div className="flex items-start justify-between gap-2"><span className="font-mono text-[9px] text-[#60777a]">{entry.metric}</span><button aria-label={t("recall.actions")} className="flex h-6 w-6 items-center justify-center text-[#718488] outline-none hover:bg-[#e7eeee] focus-visible:ring-2 focus-visible:ring-[#0c766e]" type="button"><MoreHorizontal aria-hidden="true" size={14} /></button></div>
            </article>
          ))}
        </div>
      </section>
      <aside className="minimal-scrollbar min-h-0 overflow-y-auto bg-[#f8faf9]">
        <PanelHeader icon={GitCompareArrows} title={t("recall.publishChecklist")} />
        <div className="grid gap-0 px-4 py-2">
          {[
            [t("recall.syntaxValidation"), t("recall.passed")],
            [t("recall.contractValidation"), t("recall.passed")],
            [t("recall.benchmarkEvaluation"), "128 / 128"],
            [t("recall.releaseThreshold"), "6 / 6"],
          ].map(([label, value]) => <div className="flex items-center justify-between gap-3 border-b border-[#d7e1e0] py-3" key={label}><span className="flex items-center gap-2 text-[10px] text-[#49666b]"><CheckCircle2 aria-hidden="true" className="text-[#278071]" size={13} />{label}</span><span className="font-mono text-[9px] text-[#60777a]">{value}</span></div>)}
        </div>
        <section className="mt-3 border-t border-[#cbd8d9]">
          <PanelHeader icon={Clock3} title={t("recall.activation")} />
          <div className="grid gap-2 p-4 text-[10px]"><p className="text-[#49666b]">{t("recall.activationDetail")}</p><div className="flex items-center gap-2 border border-[#bfd1cf] bg-[#edf5f3] px-2 py-2 font-mono text-[9px] text-[#2f625e]"><CircleDot aria-hidden="true" size={12} />semantic-hybrid@v12</div></div>
        </section>
      </aside>
    </div>
  );
}

function RecallNavigation({
  activeSection,
  collapsed,
  onCollapsedChange,
  onSelect,
}: {
  activeSection: RecallSection;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelect: (section: RecallSection) => void;
}) {
  const { t } = useI18n();
  const label = (section: RecallSection) => {
    if (section === "rules") return t("recall.rules");
    if (section === "testing") return t("recall.testing");
    if (section === "benchmarks") return t("recall.benchmarks");
    if (section === "evaluation") return t("recall.evaluation");
    return t("recall.versions");
  };
  return (
    <WorkspaceNavigation
      activeItem={activeSection}
      ariaLabel={t("recall.navigation")}
      bordered
      collapsed={collapsed}
      headerAction={<button aria-expanded={!collapsed} aria-label={collapsed ? t("recall.expandNavigation") : t("recall.collapseNavigation")} className="flex h-7 w-7 shrink-0 items-center justify-center text-[#60777a] outline-none hover:bg-[#dce8e6] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" onClick={() => onCollapsedChange(!collapsed)} title={collapsed ? t("recall.expandNavigation") : t("recall.collapseNavigation")} type="button">{collapsed ? <ChevronRight aria-hidden="true" size={15} /> : <ChevronLeft aria-hidden="true" size={15} />}</button>}
      id="recall-navigation"
      items={RECALL_SECTIONS.map(({ id, icon }) => ({ controls: `recall-${id}-panel`, icon, id, label: label(id), tabId: `recall-${id}-tab` }))}
      onChange={onSelect}
      title={t("navigation.recall")}
    />
  );
}

export default function RecallWorkspace() {
  const [activeSection, setActiveSection] = useState<RecallSection>("rules");
  const [collapsed, setCollapsed] = useState(false);
  return (
    <div className="recall-shell grid h-full min-h-[520px] min-w-0 overflow-hidden bg-[#dce5e7] transition-[grid-template-columns] duration-150 motion-reduce:transition-none md:min-w-[760px]" data-recall-section={activeSection} style={{ gridTemplateColumns: collapsed ? "48px minmax(0,1fr)" : "168px minmax(0,1fr)" }}>
      <RecallNavigation activeSection={activeSection} collapsed={collapsed} onCollapsedChange={setCollapsed} onSelect={setActiveSection} />
      <div aria-labelledby={`recall-${activeSection}-tab`} className="min-h-0 min-w-0" id={`recall-${activeSection}-panel`} role="tabpanel">
        {activeSection === "rules" && <RuleWorkspace />}
        {activeSection === "testing" && <TestingWorkspace />}
        {activeSection === "benchmarks" && <BenchmarkWorkspace />}
        {activeSection === "evaluation" && <EvaluationWorkspace />}
        {activeSection === "versions" && <VersionsWorkspace />}
      </div>
    </div>
  );
}
