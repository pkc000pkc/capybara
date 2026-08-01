"use client";

import { BarChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import {
  Activity,
  ArrowLeftRight,
  BarChart3,
  CheckCircle2,
  CircleAlert,
  Clock3,
  GitCommitHorizontal,
  LoaderCircle,
  Play,
  Square,
  Trash2,
  TrendingUp,
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
import { datasetApi, type DatasetSummary } from "../dataset-api";
import {
  experimentApi,
  type ExperimentCase,
  type ExperimentCaseDetail,
  type ExperimentCaseStatus,
  type ExperimentComparison,
  type ExperimentMetrics,
  type ExperimentRun,
  type ExperimentRunDetail,
  type ExperimentStatus,
  type ExperimentToolAggregate,
  type ExperimentTrend,
} from "../experiment-api";
import { useI18n } from "../i18n";
import CodeSurface from "./code-surface";
import ResizeHandle from "./resize-handle";
import { PanelHeader, SearchField, WorkspaceTabs, type WorkspaceTab } from "./workspace-ui";

echarts.use([BarChart, CanvasRenderer, GridComponent, LegendComponent, LineChart, TooltipComponent]);

type AnalysisMode = "overall" | "comparison" | "single";
type AnalysisView = "overview" | "cases" | "tools" | "execution";

function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatTokens(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k` : String(value);
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function percent(value: number | null | undefined) {
  return value === null || value === undefined ? "-" : `${value.toFixed(1)}%`;
}

function chartBase(dark: boolean) {
  const text = dark ? "#a8b8ba" : "#63777b";
  const line = dark ? "#3c4c50" : "#d8e2e2";
  return {
    animation: false,
    textStyle: { color: text, fontFamily: "ui-monospace, monospace", fontSize: 9 },
    grid: { left: 42, right: 18, top: 30, bottom: 28 },
    tooltip: { trigger: "axis", borderWidth: 1 },
    xAxis: { axisLine: { lineStyle: { color: line } }, axisLabel: { color: text, fontSize: 8 } },
    yAxis: { splitLine: { lineStyle: { color: line } }, axisLabel: { color: text, fontSize: 8 } },
  };
}

function EChart({ ariaLabel, option }: { ariaLabel: string; option: (dark: boolean) => EChartsCoreOption }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    const render = () => chart.setOption(option(document.documentElement.dataset.theme === "dark"), { notMerge: true });
    const observer = new ResizeObserver(() => chart.resize());
    const themeObserver = new MutationObserver(render);
    observer.observe(element.current);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    render();
    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      chart.dispose();
    };
  }, [option]);
  return <div aria-label={ariaLabel} className="h-full min-h-40 w-full" ref={element} role="img" />;
}

function Dialog({ children, onClose, title }: { children: ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-[#13282d]/35 p-4" role="presentation">
      <section aria-label={title} aria-modal="true" className="w-full max-w-lg border border-[#9fb3b5] bg-white shadow-xl" role="dialog">
        <PanelHeader actions={<button aria-label={title} className="grid h-7 w-7 place-items-center text-[#60777a] hover:bg-[#e4efed]" onClick={onClose} type="button"><X size={14} /></button>} title={title} />
        {children}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: ExperimentStatus | ExperimentCaseStatus }) {
  const { t } = useI18n();
  const label = status === "completed" ? t("experiments.statusCompleted")
    : status === "running" ? t("experiments.statusRunning")
      : status === "queued" ? t("experiments.statusQueued")
        : status === "passed" ? t("experiments.passed")
          : status === "error" ? t("experiments.statusError")
            : status === "cancelled" ? t("experiments.statusCancelled")
              : t("experiments.statusFailed");
  const Icon = status === "completed" || status === "passed" ? CheckCircle2
    : status === "running" || status === "queued" ? Clock3
      : CircleAlert;
  return <span className="experiment-status inline-flex h-5 items-center gap-1 px-1.5 text-[9px] font-semibold" data-status={status}><Icon aria-hidden="true" size={11} />{label}</span>;
}

function DatasetSelect({ datasets, onChange, value }: { datasets: DatasetSummary[]; onChange: (value: string) => void; value: string }) {
  const { t } = useI18n();
  return (
    <label className="flex min-w-0 items-center gap-2 text-[9px] font-semibold text-[#526b70]">
      <span className="shrink-0">{t("experiments.experimentDataset")}</span>
      <select aria-label={t("experiments.experimentDataset")} className="h-7 min-w-52 max-w-80 border border-[#9fb5b6] bg-white px-2 font-mono text-[9px] font-normal text-[#294247] outline-none focus:border-[#0c766e]" onChange={(event) => onChange(event.target.value)} value={value}>
        <option value="">{t("experiments.selectExperimentDataset")}</option>
        {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · v{dataset.version} · {dataset.samples}</option>)}
      </select>
    </label>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="flex h-full min-h-44 items-center justify-center px-6 text-center text-[11px] text-[#718488]">{children}</div>;
}

function MetricStrip({ metrics, previous }: { metrics: ExperimentMetrics; previous?: ExperimentMetrics }) {
  const { t } = useI18n();
  const items = [
    { label: t("experiments.averageScore"), value: metrics.averageScore.toFixed(2), delta: previous ? metrics.averageScore - previous.averageScore : undefined },
    { label: t("experiments.passRate"), value: percent(metrics.passRate), delta: previous ? metrics.passRate - previous.passRate : undefined },
    { label: t("experiments.toolRecall"), value: percent(metrics.toolRecall), delta: previous && metrics.toolRecall !== null && previous.toolRecall !== null ? metrics.toolRecall - previous.toolRecall : undefined },
    { label: t("experiments.errorRate"), value: percent(metrics.errorRate), delta: previous ? previous.errorRate - metrics.errorRate : undefined },
    { label: t("experiments.agentTokens"), value: formatTokens(metrics.agentUsage.totalTokens), delta: undefined },
    { label: t("experiments.scorerTokens"), value: formatTokens(metrics.scoringUsage.totalTokens), delta: undefined },
    { label: t("experiments.p95Latency"), value: `${(metrics.p95LatencyMs / 1000).toFixed(2)}s`, delta: undefined },
  ];
  return (
    <div className="grid border-b border-[#cbd8d9] bg-white" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(92px, 1fr))` }}>
      {items.map((item) => <div className="min-w-0 border-r border-[#e0e8e8] px-3 py-2 last:border-r-0" key={item.label}><div className="truncate text-[8px] font-semibold uppercase text-[#718488]">{item.label}</div><div className="mt-0.5 flex items-baseline gap-1.5"><strong className="font-mono text-sm text-[#29484c]">{item.value}</strong>{item.delta !== undefined && <span className={`font-mono text-[8px] ${item.delta >= 0 ? "text-[#25806f]" : "text-[#9b4141]"}`}>{item.delta >= 0 ? "+" : ""}{item.delta.toFixed(2)}</span>}</div></div>)}
    </div>
  );
}

function OverallWorkspace({ dataset, trend }: { dataset?: DatasetSummary; trend: ExperimentTrend | null }) {
  const { t } = useI18n();
  const completed = useMemo(() => [...(trend?.runs ?? [])].sort((left, right) => left.completedAt!.localeCompare(right.completedAt!)), [trend]);
  const history = useMemo(() => [
    ...completed.map((run) => ({ run, issues: [] as string[] })),
    ...(trend?.excluded ?? []).map((item) => ({ run: item.run, issues: item.issues })),
  ].sort((left, right) => (right.run.completedAt ?? "").localeCompare(left.run.completedAt ?? "")), [completed, trend]);
  const latest = completed.at(-1);
  const previous = completed.at(-2);
  const qualityOption = useMemo(() => (dark: boolean): EChartsCoreOption => ({
    ...chartBase(dark),
    legend: { top: 4, textStyle: { fontSize: 8 } },
    xAxis: { ...chartBase(dark).xAxis, type: "category", data: completed.map((run) => run.project.shortSha) },
    yAxis: { ...chartBase(dark).yAxis, type: "value", min: 0, max: 100 },
    series: [
      { name: t("experiments.averageScore"), type: "line", data: completed.map((run) => run.metrics.averageScore * 100), smooth: false, symbolSize: 6, itemStyle: { color: "#0c766e" } },
      { name: t("experiments.passRate"), type: "line", data: completed.map((run) => run.metrics.passRate), smooth: false, symbolSize: 6, itemStyle: { color: "#b1782f" } },
    ],
  }), [completed, t]);
  const tokenOption = useMemo(() => (dark: boolean): EChartsCoreOption => ({
    ...chartBase(dark),
    legend: { top: 4, textStyle: { fontSize: 8 } },
    xAxis: { ...chartBase(dark).xAxis, type: "category", data: completed.map((run) => run.project.shortSha) },
    yAxis: { ...chartBase(dark).yAxis, type: "value" },
    series: [
      { name: t("experiments.agentTokensPerCase"), type: "bar", stack: "tokens", data: completed.map((run) => run.metrics.agentTokensPerCase), itemStyle: { color: "#527f84" } },
      { name: t("experiments.scorerTokensPerCase"), type: "bar", stack: "tokens", data: completed.map((run) => run.metrics.scoringTokensPerCase), itemStyle: { color: "#c78e48" } },
    ],
  }), [completed, t]);
  const scoreOption = useMemo(() => (dark: boolean): EChartsCoreOption => ({
    ...chartBase(dark),
    xAxis: { ...chartBase(dark).xAxis, type: "category", data: ["0-.2", ".2-.4", ".4-.6", ".6-.8", ".8-1"] },
    yAxis: { ...chartBase(dark).yAxis, type: "value", minInterval: 1 },
    series: [{ type: "bar", data: latest ? latest.metrics.scoreBins.map((value) => { const scored = latest.metrics.scoreBins.reduce((sum, item) => sum + item, 0); return scored ? value / scored * 100 : 0; }) : [], itemStyle: { color: "#0c766e" } }],
  }), [latest]);

  if (!dataset) return <EmptyState>{t("experiments.selectDatasetForAnalysis")}</EmptyState>;
  if (!latest) return <EmptyState>{t("experiments.noCompletedRunsForDataset")}</EmptyState>;
  return (
    <div className="minimal-scrollbar h-full overflow-auto bg-[#eef3f3]" role="tabpanel">
      <MetricStrip metrics={latest.metrics} previous={previous?.metrics} />
      {trend?.excluded.length ? <div className="border-b border-[#d7bd8d] bg-[#fff7e8] px-3 py-2 text-[9px] text-[#76551f]">{t("experiments.incompatibleRunsExcluded", { count: trend.excluded.length })}</div> : null}
      <div className="grid min-h-[480px] grid-cols-2 gap-px bg-[#cbd8d9]">
        <section className="grid min-h-60 grid-rows-[34px_1fr] bg-white"><PanelHeader metadata={`${completed.length}`} title={t("experiments.overallQualityTrend")} /><EChart ariaLabel={t("experiments.overallQualityTrend")} option={qualityOption} /></section>
        <section className="grid min-h-60 grid-rows-[34px_1fr] bg-white"><PanelHeader metadata={formatTokens(latest.metrics.totalTokens)} title={t("experiments.tokenTrend")} /><EChart ariaLabel={t("experiments.tokenTrend")} option={tokenOption} /></section>
        <section className="grid min-h-60 grid-rows-[34px_1fr] bg-white"><PanelHeader metadata={`n=${latest.progress.completed}`} title={t("experiments.scoreDistribution")} /><EChart ariaLabel={t("experiments.scoreDistribution")} option={scoreOption} /></section>
        <section className="min-h-60 bg-white"><PanelHeader metadata={`${dataset.name} · v${dataset.version}`} title={t("experiments.experimentHistory")} /><div className="minimal-scrollbar max-h-64 overflow-auto"><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="sticky top-0 bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="px-3">Git</th><th className="px-3">{t("experiments.cohort")}</th><th className="px-3">{t("experiments.averageScore")}</th><th className="px-3">{t("experiments.passRate")}</th><th className="px-3">{t("experiments.startedAt")}</th></tr></thead><tbody>{history.map(({ run, issues }) => <tr className={`h-9 border-t border-[#e0e8e8] ${issues.length ? "bg-[#fff9ee]" : ""}`} key={run.id}><td className="px-3 font-mono font-semibold text-[#29484c]">{run.project.shortSha}</td><td className="px-3 font-mono text-[#60777a]">v{run.dataset.version} · n={run.dataset.samples} · ×{run.config.repetitions}{issues.length ? ` · ${t("experiments.incompatible")}` : ""}</td><td className="px-3 font-mono">{run.metrics.averageScore.toFixed(2)}</td><td className="px-3 font-mono">{percent(run.metrics.passRate)}</td><td className="truncate px-3 font-mono text-[#718488]">{formatDate(run.completedAt)}</td></tr>)}</tbody></table></div></section>
      </div>
    </div>
  );
}

function ComparisonWorkspace({ dataset, projectPath, runs }: { dataset?: DatasetSummary; projectPath: string; runs: ExperimentRun[] }) {
  const { t } = useI18n();
  const completed = useMemo(() => runs.filter((run) => run.status === "completed"), [runs]);
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [comparison, setComparison] = useState<ExperimentComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resolvedLeftId = completed.some((run) => run.id === leftId) ? leftId : completed[1]?.id ?? completed[0]?.id ?? "";
  const resolvedRightId = completed.some((run) => run.id === rightId) ? rightId : completed[0]?.id ?? "";
  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setComparison(null);
      setError(null);
      if (!dataset || !resolvedLeftId || !resolvedRightId || resolvedLeftId === resolvedRightId) return;
      try {
        const value = await experimentApi.compare(projectPath, dataset.id, resolvedLeftId, resolvedRightId);
        if (active) setComparison(value);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { active = false; };
  }, [dataset, projectPath, resolvedLeftId, resolvedRightId]);
  if (!dataset) return <EmptyState>{t("experiments.selectDatasetForAnalysis")}</EmptyState>;
  if (completed.length < 2) return <EmptyState>{t("experiments.needTwoCompletedRuns")}</EmptyState>;
  return (
    <div className="minimal-scrollbar h-full overflow-auto bg-[#eef3f3]" role="tabpanel">
      <div className="grid grid-cols-[minmax(260px,1fr)_36px_minmax(260px,1fr)] items-center gap-2 border-b border-[#cbd8d9] bg-white p-3">
        <label className="grid gap-1 text-[9px] font-semibold text-[#718488]">{t("experiments.runA")}<select className="h-8 border border-[#c6d4d4] bg-white px-2 font-mono text-[10px] font-normal text-[#294247]" onChange={(event) => setLeftId(event.target.value)} value={resolvedLeftId}>{completed.map((run) => <option key={run.id} value={run.id}>{run.project.shortSha} · {run.name}</option>)}</select></label>
        <button aria-label={t("experiments.swapRuns")} className="grid h-8 w-8 place-items-center border border-[#c6d4d4] bg-white text-[#526b70] hover:bg-[#e4efed]" onClick={() => { setLeftId(resolvedRightId); setRightId(resolvedLeftId); }} type="button"><ArrowLeftRight size={14} /></button>
        <label className="grid gap-1 text-[9px] font-semibold text-[#718488]">{t("experiments.runB")}<select className="h-8 border border-[#c6d4d4] bg-white px-2 font-mono text-[10px] font-normal text-[#294247]" onChange={(event) => setRightId(event.target.value)} value={resolvedRightId}>{completed.map((run) => <option key={run.id} value={run.id}>{run.project.shortSha} · {run.name}</option>)}</select></label>
      </div>
      {error && <div className="border-b border-[#d5a2a2] bg-[#f8eded] px-3 py-2 text-[10px] text-[#843d3d]">{error}</div>}
      {!comparison ? <EmptyState>{resolvedLeftId === resolvedRightId ? t("experiments.selectDifferentRuns") : t("experiments.loadingComparison")}</EmptyState> : <>
        <MetricStrip metrics={comparison.right.metrics} previous={comparison.left.metrics} />
        <section className="bg-white"><PanelHeader metadata={`${comparison.samples.length}`} title={t("experiments.sampleComparison")} /><div className="minimal-scrollbar max-h-72 overflow-auto"><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="sticky top-0 bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="w-[38%] px-3">{t("experiments.sample")}</th><th className="px-3 text-right">A</th><th className="px-3 text-right">B</th><th className="px-3 text-right">Delta</th><th className="px-3">{t("experiments.status")}</th></tr></thead><tbody>{comparison.samples.map((item) => <tr className="h-9 border-t border-[#e0e8e8]" key={item.sampleId}><td className="truncate px-3 font-mono font-semibold text-[#29484c]">{item.sampleId}</td><td className="px-3 text-right font-mono">{item.left?.score?.toFixed(2) ?? "-"}</td><td className="px-3 text-right font-mono">{item.right?.score?.toFixed(2) ?? "-"}</td><td className={`px-3 text-right font-mono ${item.delta === undefined ? "text-[#718488]" : item.delta >= 0 ? "text-[#25806f]" : "text-[#9b4141]"}`}>{item.delta === undefined ? "-" : `${item.delta >= 0 ? "+" : ""}${item.delta.toFixed(2)}`}</td><td className="px-3">{item.right && <StatusBadge status={item.right.status} />}</td></tr>)}</tbody></table></div></section>
        <section className="mt-px bg-white"><PanelHeader metadata={`${comparison.tools.length}`} title={t("experiments.toolComparison")} /><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="px-3">{t("experiments.toolName")}</th><th className="px-3 text-right">A Recall</th><th className="px-3 text-right">B Recall</th><th className="px-3 text-right">A Errors</th><th className="px-3 text-right">B Errors</th></tr></thead><tbody>{comparison.tools.map((item) => <tr className="h-9 border-t border-[#e0e8e8]" key={item.name}><td className="px-3 font-mono font-semibold text-[#29484c]">{item.name}</td><td className="px-3 text-right font-mono">{item.left ? percent(item.left.recall) : "-"}</td><td className="px-3 text-right font-mono">{item.right ? percent(item.right.recall) : "-"}</td><td className="px-3 text-right font-mono">{item.left?.errors ?? "-"}</td><td className="px-3 text-right font-mono">{item.right?.errors ?? "-"}</td></tr>)}</tbody></table></section>
      </>}
    </div>
  );
}

function RunOverview({ run }: { run: ExperimentRunDetail }) {
  const { t } = useI18n();
  const evaluatorValue = run.evaluator.type === "project"
    ? JSON.stringify({ evaluator: run.evaluator, metrics: run.metrics.custom }, null, 2)
    : run.scoringPrompt;
  return <div className="minimal-scrollbar h-full overflow-auto"><MetricStrip metrics={run.metrics} /><div className="grid grid-cols-2 gap-px bg-[#cbd8d9]"><section className="bg-white"><PanelHeader title={t("experiments.runSummary")} /><dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 p-4 text-[10px]"><dt className="text-[#718488]">{t("experiments.experimentDataset")}</dt><dd className="font-mono text-[#29484c]">{run.dataset.name} · v{run.dataset.version} · {run.dataset.samples}</dd><dt className="text-[#718488]">{t("experiments.projectVersion")}</dt><dd className="font-mono text-[#29484c]">{run.project.commitSha} · tree {run.project.treeSha}</dd><dt className="text-[#718488]">{t("experiments.model")}</dt><dd className="font-mono text-[#29484c]">{run.model.model} · {run.model.protocol}</dd><dt className="text-[#718488]">{t("experiments.evaluator")}</dt><dd className="font-mono text-[#29484c]">{run.evaluator.type === "project" ? run.evaluator.entry : t("experiments.llmEvaluator")}</dd><dt className="text-[#718488]">{t("experiments.progress")}</dt><dd className="font-mono text-[#29484c]">{run.progress.completed} / {run.progress.total}</dd><dt className="text-[#718488]">{t("experiments.repetitions")}</dt><dd className="font-mono text-[#29484c]">{run.config.repetitions}</dd><dt className="text-[#718488]">{t("experiments.startedAt")}</dt><dd className="font-mono text-[#29484c]">{formatDate(run.startedAt)}</dd></dl></section><section className="bg-white"><PanelHeader metadata={run.failure?.phase} title={run.failure ? t("experiments.failureDetails") : run.evaluator.type === "project" ? t("experiments.projectEvaluator") : t("experiments.scoringPrompt")} />{run.failure ? <div className="p-4 text-[10px]"><div className="font-mono font-semibold text-[#9b4141]">{run.failure.code}</div><p className="mt-2 whitespace-pre-wrap leading-5 text-[#526b70]">{run.failure.message}</p></div> : <CodeSurface ariaLabel={run.evaluator.type === "project" ? t("experiments.projectEvaluator") : t("experiments.scoringPrompt")} language={run.evaluator.type === "project" ? "JSON" : "Nunjucks"} lineWrapping readOnly statusBar={false} value={evaluatorValue} />}</section></div></div>;
}

function CasesWorkspace({ cases, detail, loading, onSelect, query, selectedId, setQuery }: { cases: ExperimentCase[]; detail: ExperimentCaseDetail | null; loading: boolean; onSelect: (id: string) => void; query: string; selectedId: string; setQuery: (value: string) => void }) {
  const { t } = useI18n();
  const [topHeight, setTopHeight] = useState(270);
  const visible = cases.filter((item) => `${item.sampleId} ${item.rationale ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="grid h-full min-h-0" style={{ gridTemplateRows: `${topHeight}px 1px minmax(180px,1fr)` }}><section className="grid min-h-0 grid-rows-[38px_1fr]" id="experiment-case-list"><div className="flex items-center justify-between gap-3 border-b border-[#d8e2e2] bg-[#f8faf9] px-2"><SearchField compact label={t("experiments.searchCases")} onChange={setQuery} value={query} width="w-64" /><span className="font-mono text-[9px] text-[#718488]">{visible.length}</span></div><div className="minimal-scrollbar min-h-0 overflow-auto"><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="sticky top-0 bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="w-[34%] px-3">{t("experiments.sample")}</th><th className="px-3">{t("experiments.status")}</th><th className="px-3 text-right">{t("experiments.score")}</th><th className="px-3">{t("experiments.actualTools")}</th><th className="px-3 text-right">{t("experiments.totalTokens")}</th><th className="px-3 text-right">{t("experiments.latency")}</th></tr></thead><tbody>{visible.map((item) => <tr aria-selected={selectedId === item.id} className={`h-9 cursor-pointer border-t border-[#e0e8e8] ${selectedId === item.id ? "bg-[#d9e9e6]" : "hover:bg-[#f3f7f6]"}`} key={item.id} onClick={() => onSelect(item.id)}><td className="truncate px-3 font-mono font-semibold text-[#29484c]">{item.sampleId}{item.repetition > 1 ? ` · #${item.repetition}` : ""}</td><td className="px-3"><StatusBadge status={item.status} /></td><td className="px-3 text-right font-mono">{item.score?.toFixed(2) ?? "-"}</td><td className="truncate px-3 font-mono text-[#60777a]">{item.actualTools.join(", ") || "-"}</td><td className="px-3 text-right font-mono">{formatTokens(item.usage.totalTokens)}</td><td className="px-3 text-right font-mono">{(item.latencyMs / 1000).toFixed(2)}s</td></tr>)}</tbody></table>{loading && <div className="p-4 text-center text-[10px] text-[#718488]">{t("experiments.loadingCases")}</div>}</div></section><ResizeHandle controls="experiment-case-list experiment-case-detail" defaultValue={270} label={t("experiments.resizeCaseDetail")} maximum={() => Math.max(300, window.innerHeight - 250)} minimum={150} onChange={setTopHeight} orientation="horizontal" value={topHeight} valueText={`${topHeight}px`} /><section className="grid min-h-0 grid-rows-[34px_1fr] bg-white" id="experiment-case-detail"><PanelHeader metadata={detail?.rationale} title={detail ? `${t("experiments.sampleDetails")} · ${detail.sampleId}` : t("experiments.sampleDetails")} />{!detail ? <EmptyState>{t("experiments.selectCase")}</EmptyState> : <div className="grid min-h-0 grid-cols-3 divide-x divide-[#d8e2e2]"><section className="grid min-h-0 grid-rows-[24px_1fr]"><h3 className="bg-[#edf3f2] px-2.5 py-1 text-[9px] font-semibold text-[#657b7f]">{t("experiments.question")}</h3><CodeSurface ariaLabel={t("experiments.question")} language="Markdown" lineWrapping readOnly statusBar={false} value={detail.question} /></section><section className="grid min-h-0 grid-rows-[24px_1fr]"><h3 className="bg-[#edf3f2] px-2.5 py-1 text-[9px] font-semibold text-[#657b7f]">{t("experiments.expected")}</h3><CodeSurface ariaLabel={t("experiments.expected")} language="Markdown" lineWrapping readOnly statusBar={false} value={detail.expectedAnswer} /></section><section className="grid min-h-0 grid-rows-[24px_1fr]"><h3 className="bg-[#edf3f2] px-2.5 py-1 text-[9px] font-semibold text-[#657b7f]">{t("experiments.actual")}</h3><CodeSurface ariaLabel={t("experiments.actual")} language="Markdown" lineWrapping readOnly statusBar={false} value={detail.actualAnswer} /></section></div>}</section></div>;
}

function ToolsWorkspace({ tools }: { tools: ExperimentToolAggregate[] }) {
  const { t } = useI18n();
  if (tools.length === 0) return <EmptyState>{t("experiments.noToolCalls")}</EmptyState>;
  return <div className="minimal-scrollbar h-full overflow-auto"><PanelHeader metadata={`${tools.length}`} title={t("experiments.toolCoverage")} /><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="sticky top-0 bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="px-3">{t("experiments.toolName")}</th><th className="px-3 text-right">{t("experiments.toolExpected")}</th><th className="px-3 text-right">{t("experiments.toolHit")}</th><th className="px-3 text-right">{t("experiments.toolMissed")}</th><th className="px-3 text-right">{t("experiments.toolUnexpected")}</th><th className="px-3 text-right">Precision</th><th className="px-3 text-right">Recall</th><th className="px-3 text-right">{t("experiments.toolErrors")}</th><th className="px-3 text-right">{t("experiments.averageLatency")}</th></tr></thead><tbody>{tools.map((tool) => <tr className="h-10 border-t border-[#e0e8e8]" key={tool.name}><td className="px-3 font-mono font-semibold text-[#29484c]">{tool.name}</td><td className="px-3 text-right font-mono">{tool.expected}</td><td className="px-3 text-right font-mono text-[#25806f]">{tool.hit}</td><td className="px-3 text-right font-mono text-[#b1782f]">{tool.missed}</td><td className="px-3 text-right font-mono text-[#9b4141]">{tool.unexpected}</td><td className="px-3 text-right font-mono">{percent(tool.precision)}</td><td className="px-3 text-right font-mono">{percent(tool.recall)}</td><td className="px-3 text-right font-mono">{tool.errors}</td><td className="px-3 text-right font-mono">{tool.averageLatencyMs}ms</td></tr>)}</tbody></table></div>;
}

function ExecutionWorkspace({ cases, detail, onSelect }: { cases: ExperimentCase[]; detail: ExperimentCaseDetail | null; onSelect: (id: string) => void }) {
  const { t } = useI18n();
  const trace = detail?.trace;
  const timeline = (trace?.timeline ?? []) as Array<Record<string, unknown>>;
  return <div className="grid h-full min-h-0 grid-rows-[38px_minmax(180px,0.45fr)_1fr]"><div className="flex items-center gap-2 border-b border-[#d8e2e2] bg-[#f8faf9] px-2"><span className="text-[9px] font-semibold text-[#657b7f]">{t("experiments.sample")}</span><select className="h-7 min-w-64 border border-[#c6d4d4] bg-white px-2 font-mono text-[9px] text-[#294247]" onChange={(event) => onSelect(event.target.value)} value={detail?.id ?? ""}><option value="">{t("experiments.selectCase")}</option>{cases.map((item) => <option key={item.id} value={item.id}>{item.sampleId} · {item.status}</option>)}</select></div>{!detail ? <EmptyState>{t("experiments.selectCase")}</EmptyState> : <><section className="minimal-scrollbar min-h-0 overflow-auto"><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="sticky top-0 bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="px-3">Step</th><th className="px-3">Type</th><th className="px-3">Status</th><th className="px-3 text-right">Duration</th></tr></thead><tbody>{timeline.map((step, index) => <tr className="h-9 border-t border-[#e0e8e8]" key={String(step.id ?? index)}><td className="truncate px-3 font-mono text-[#29484c]">{String(step.label ?? step.id ?? index + 1)}</td><td className="px-3 font-mono text-[#60777a]">{String(step.type ?? "-")}</td><td className="px-3 font-mono text-[#60777a]">{String(step.status ?? "-")}</td><td className="px-3 text-right font-mono">{String(step.durationMs ?? "-")}</td></tr>)}</tbody></table></section><section className="grid min-h-0 grid-cols-2 divide-x divide-[#cbd8d9] border-t border-[#cbd8d9]"><div className="grid min-h-0 grid-rows-[34px_1fr]"><PanelHeader metadata={`${trace?.effectiveContexts.length ?? 0}`} title={t("experiments.traceView.context")} /><CodeSurface ariaLabel={t("experiments.traceView.context")} language="JSON" lineWrapping readOnly statusBar={false} value={JSON.stringify(trace?.effectiveContexts ?? [], null, 2)} /></div><div className="grid min-h-0 grid-rows-[34px_1fr]"><PanelHeader metadata={`${trace?.observations.length ?? 0}`} title={t("experiments.traceView.raw")} /><CodeSurface ariaLabel={t("experiments.traceView.raw")} language="JSON" lineWrapping readOnly statusBar={false} value={JSON.stringify(trace ?? {}, null, 2)} /></div></section></>}</div>;
}

function SingleWorkspace({ onChanged, projectPath, runs, selectedRunId, setSelectedRunId }: { onChanged: () => void; projectPath: string; runs: ExperimentRun[]; selectedRunId: string; setSelectedRunId: (id: string) => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<AnalysisView>("overview");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | ExperimentStatus>("all");
  const [caseQuery, setCaseQuery] = useState("");
  const [runListWidth, setRunListWidth] = useState(240);
  const [detail, setDetail] = useState<ExperimentRunDetail | null>(null);
  const [cases, setCases] = useState<ExperimentCase[]>([]);
  const [tools, setTools] = useState<ExperimentToolAggregate[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [caseDetail, setCaseDetail] = useState<ExperimentCaseDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = runs.find((run) => run.id === selectedRunId);
  const visible = runs.filter((run) => (status === "all" || run.status === status) && `${run.name} ${run.project.shortSha}`.toLowerCase().includes(query.trim().toLowerCase()));
  const tabs: WorkspaceTab<AnalysisView>[] = [
    { id: "overview", label: t("experiments.analysisOverview"), icon: Activity },
    { id: "cases", label: t("experiments.analysisCases"), icon: BarChart3, badge: cases.length ? <span className="font-mono text-[8px]">{cases.length}</span> : undefined },
    { id: "tools", label: t("experiments.analysisTools"), icon: Wrench, badge: tools.length ? <span className="font-mono text-[8px]">{tools.length}</span> : undefined },
    { id: "execution", label: t("experiments.analysisExecution"), icon: TrendingUp },
  ];

  useEffect(() => {
    if (!selectedRunId && runs[0]) setSelectedRunId(runs[0].id);
    else if (selectedRunId && !runs.some((run) => run.id === selectedRunId)) setSelectedRunId(runs[0]?.id ?? "");
  }, [runs, selectedRunId, setSelectedRunId]);

  const loadDetail = useCallback(async () => {
    await Promise.resolve();
    if (!selectedRunId) {
      setDetail(null); setCases([]); setTools([]); setCaseDetail(null); return;
    }
    setLoading(true); setError(null);
    try {
      const [run, casePage, toolPage] = await Promise.all([
        experimentApi.get(projectPath, selectedRunId),
        experimentApi.cases(projectPath, selectedRunId, { limit: 500 }),
        experimentApi.tools(projectPath, selectedRunId),
      ]);
      setDetail(run); setCases(casePage.items); setTools(toolPage.items);
      setSelectedCaseId((current) => casePage.items.some((item) => item.id === current) ? current : casePage.items[0]?.id ?? "");
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoading(false); }
  }, [projectPath, selectedRunId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadDetail(), 0);
    return () => window.clearTimeout(timer);
  }, [loadDetail, selected?.updatedAt]);
  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setCaseDetail(null);
      if (!selectedRunId || !selectedCaseId) return;
      try {
        const value = await experimentApi.case(projectPath, selectedRunId, selectedCaseId);
        if (active) setCaseDetail(value);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      }
    })();
    return () => { active = false; };
  }, [projectPath, selectedCaseId, selectedRunId, selected?.updatedAt]);

  const cancel = async () => { if (!selected) return; setError(null); try { await experimentApi.cancel(projectPath, selected.id); onChanged(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  const remove = async () => { if (!selected || !window.confirm(t("experiments.deleteRunConfirm"))) return; setError(null); try { await experimentApi.remove(projectPath, selected.id); setSelectedRunId(""); onChanged(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } };
  return <div className="grid h-full min-h-0" role="tabpanel" style={{ gridTemplateColumns: `${runListWidth}px 1px minmax(560px,1fr)` }}><aside className="grid min-h-0 grid-rows-[34px_68px_1fr] bg-[#f8faf9]" id="experiment-run-list"><PanelHeader actions={<span className="font-mono text-[9px] text-[#718488]">{visible.length}</span>} title={t("experiments.runs")} /><div className="grid gap-1.5 border-b border-[#d8e2e2] p-1.5"><SearchField compact label={t("experiments.searchRuns")} onChange={setQuery} value={query} /><select aria-label={t("experiments.filterStatus")} className="h-6 border border-[#c6d4d4] bg-white px-2 text-[9px] text-[#526b70]" onChange={(event) => setStatus(event.target.value as "all" | ExperimentStatus)} value={status}><option value="all">{t("experiments.allStatuses")}</option><option value="running">{t("experiments.statusRunning")}</option><option value="queued">{t("experiments.statusQueued")}</option><option value="completed">{t("experiments.statusCompleted")}</option><option value="failed">{t("experiments.statusFailed")}</option><option value="cancelled">{t("experiments.statusCancelled")}</option></select></div><div className="minimal-scrollbar min-h-0 overflow-y-auto">{visible.map((run) => <button className={`grid w-full gap-1 border-b border-[#dfe7e7] px-2.5 py-2 text-left ${run.id === selectedRunId ? "bg-[#d9e9e6]" : "bg-white hover:bg-[#eef4f3]"}`} key={run.id} onClick={() => setSelectedRunId(run.id)} type="button"><span className="flex items-center justify-between gap-2"><span className="truncate text-[10px] font-semibold text-[#29484c]">{run.name}</span><StatusBadge status={run.status} /></span><span className="flex justify-between gap-2 font-mono text-[8px] text-[#718488]"><span>{run.project.shortSha}</span><span>{run.progress.completed}/{run.progress.total}</span></span>{["running", "queued"].includes(run.status) && <span className="h-1 overflow-hidden bg-[#dce5e5]"><span className="block h-full bg-[#25806f]" style={{ width: `${run.progress.total ? run.progress.completed / run.progress.total * 100 : 0}%` }} /></span>}</button>)}{visible.length === 0 && <EmptyState>{t("experiments.noRuns")}</EmptyState>}</div></aside><ResizeHandle controls="experiment-run-list experiment-run-detail" defaultValue={240} label={t("experiments.resizeRunList")} maximum={360} minimum={190} onChange={setRunListWidth} value={runListWidth} valueText={`${runListWidth}px`} /><section className="grid min-h-0 grid-rows-[45px_34px_minmax(0,1fr)] bg-white" id="experiment-run-detail"><div className="flex min-w-0 items-center justify-between gap-3 border-b border-[#cbd8d9] bg-[#f3f7f6] px-3"><div className="flex min-w-0 items-center gap-3">{selected && <StatusBadge status={selected.status} />}<span className="truncate text-[10px] font-semibold text-[#29484c]">{selected?.name ?? t("experiments.selectRun")}</span>{selected && <span className="truncate font-mono text-[8px] text-[#718488]">{selected.id}</span>}</div><div className="flex shrink-0 items-center gap-2">{selected && ["queued", "running"].includes(selected.status) && <button aria-label={t("experiments.cancelRun")} className="grid h-7 w-7 place-items-center border border-[#c6d4d4] bg-white text-[#9b5555]" onClick={() => void cancel()} title={t("experiments.cancelRun")} type="button"><Square size={12} /></button>}{selected && !["queued", "running"].includes(selected.status) && <button aria-label={t("experiments.deleteRun")} className="grid h-7 w-7 place-items-center border border-[#c6d4d4] bg-white text-[#9b5555]" onClick={() => void remove()} title={t("experiments.deleteRun")} type="button"><Trash2 size={13} /></button>}{selected && <span className="flex items-center gap-1 font-mono text-[8px] text-[#60777a]"><GitCommitHorizontal size={11} />{selected.project.shortSha}</span>}</div></div><WorkspaceTabs activeTab={view} ariaLabel={t("experiments.analysisViews")} idPrefix="experiment-analysis" onChange={setView} tabs={tabs} />{error ? <div className="p-4 text-[10px] text-[#9b4141]">{error}</div> : !detail ? <EmptyState>{loading ? t("experiments.loadingRuns") : t("experiments.selectRun")}</EmptyState> : view === "overview" ? <RunOverview run={detail} /> : view === "cases" ? <CasesWorkspace cases={cases} detail={caseDetail} loading={loading} onSelect={setSelectedCaseId} query={caseQuery} selectedId={selectedCaseId} setQuery={setCaseQuery} /> : view === "tools" ? <ToolsWorkspace tools={tools} /> : <ExecutionWorkspace cases={cases} detail={caseDetail} onSelect={setSelectedCaseId} />}</section></div>;
}

function CreateRunForm({ dataset, onClose, onCreated, projectPath, scoringPromptRequired }: { dataset: DatasetSummary; onClose: () => void; onCreated: (run: ExperimentRunDetail) => void; projectPath: string; scoringPromptRequired: boolean }) {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setSubmitting(true); setError(null);
    const data = new FormData(event.currentTarget);
    try {
      const run = await experimentApi.create(projectPath, { datasetId: dataset.id, name: String(data.get("name") ?? ""), concurrency: Number(data.get("concurrency")), repetitions: Number(data.get("repetitions")), timeoutMs: Number(data.get("timeout")) * 1000, keepWorkspaces: data.get("keepWorkspaces") === "on" });
      onCreated(run);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setSubmitting(false); }
  };
  const missingScoringPrompt = scoringPromptRequired && !dataset.scoringPrompt.trim();
  return <form className="grid gap-3 p-4" onSubmit={submit}><div className="border border-[#c6d4d4] bg-[#f3f7f6] px-3 py-2 text-[10px] text-[#526b70]"><strong className="text-[#29484c]">{dataset.name}</strong><span className="ml-2 font-mono">v{dataset.version} · {dataset.samples} {t("experiments.samples")}</span>{missingScoringPrompt && <p className="mt-1 text-[#9b4141]">{t("experiments.scoringPromptRequired")}</p>}{!scoringPromptRequired && <p className="mt-1 text-[#25806f]">{t("experiments.projectEvaluatorActive")}</p>}</div><label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">{t("experiments.name")}<input autoFocus className="h-8 border border-[#c6d4d4] bg-white px-2 text-xs font-normal text-[#294247]" defaultValue={`${dataset.name} / candidate`} name="name" required /></label><div className="grid grid-cols-3 gap-2"><label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">{t("experiments.concurrency")}<input className="h-8 border border-[#c6d4d4] bg-white px-2 text-xs font-normal" defaultValue="1" max="4" min="1" name="concurrency" type="number" /></label><label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">{t("experiments.repetitions")}<input className="h-8 border border-[#c6d4d4] bg-white px-2 text-xs font-normal" defaultValue="1" max="20" min="1" name="repetitions" type="number" /></label><label className="grid gap-1 text-[10px] font-semibold text-[#526b70]">{t("experiments.timeoutSeconds")}<input className="h-8 border border-[#c6d4d4] bg-white px-2 text-xs font-normal" defaultValue="600" max="3600" min="1" name="timeout" type="number" /></label></div><label className="flex items-center gap-2 text-[10px] text-[#526b70]"><input name="keepWorkspaces" type="checkbox" />{t("experiments.keepWorkspaces")}</label>{error && <div className="border border-[#d5a2a2] bg-[#f8eded] px-3 py-2 text-[10px] text-[#843d3d]">{error}</div>}<div className="mt-1 flex justify-end gap-2 border-t border-[#d8e2e2] pt-3"><button className="h-7 border border-[#c6d4d4] bg-white px-2.5 text-[10px] font-semibold text-[#49666b]" onClick={onClose} type="button">{t("experiments.cancel")}</button><button className="flex h-7 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white disabled:bg-[#8aa5a2]" disabled={submitting || missingScoringPrompt || dataset.samples === 0} type="submit">{submitting ? <LoaderCircle className="animate-spin" size={12} /> : <Play fill="currentColor" size={12} />}{t("experiments.queueRun")}</button></div></form>;
}

export default function ExperimentRunAnalysis({ projectPath }: { projectPath: string }) {
  const { t } = useI18n();
  const [mode, setMode] = useState<AnalysisMode>("overall");
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [runs, setRuns] = useState<ExperimentRun[]>([]);
  const [trend, setTrend] = useState<ExperimentTrend | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storage, setStorage] = useState<Awaited<ReturnType<typeof experimentApi.storage>> | null>(null);
  const selectedDataset = datasets.find((dataset) => dataset.id === datasetId);
  const modeTabs: WorkspaceTab<AnalysisMode>[] = [
    { id: "overall", label: t("experiments.overallTrends"), icon: TrendingUp },
    { id: "comparison", label: t("experiments.experimentComparison"), icon: ArrowLeftRight },
    { id: "single", label: t("experiments.singleExperiment"), icon: Activity },
  ];

  useEffect(() => {
    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setLoading(true);
      setError(null);
      if (!projectPath) { setDatasets([]); setLoading(false); return; }
      try {
        const [data, stats] = await Promise.all([datasetApi.list(projectPath), experimentApi.storage(projectPath)]);
        if (active) { setDatasets(data.items); setStorage(stats); }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [projectPath]);

  const loadRuns = useCallback(async () => {
    if (!datasetId || !projectPath) { setRuns([]); setTrend(null); return; }
    try { const [result, trendResult] = await Promise.all([experimentApi.list(projectPath, { datasetId, limit: 500 }), experimentApi.trends(projectPath, datasetId)]); setRuns(result.items); setTrend(trendResult); setError(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }, [datasetId, projectPath]);
  useEffect(() => {
    let active = true; let timer: number | undefined;
    const poll = async () => { await loadRuns(); if (active) timer = window.setTimeout(poll, 1000); };
    void poll();
    return () => { active = false; if (timer) window.clearTimeout(timer); };
  }, [loadRuns]);

  const create = () => { if (!selectedDataset) { setError(t("experiments.selectDatasetForAnalysis")); return; } setCreateOpen(true); };
  const changeDataset = (value: string) => { setDatasetId(value); setSelectedRunId(""); setRuns([]); setTrend(null); };
  return <section className="relative grid h-full min-h-0 grid-rows-[56px_34px_42px_minmax(0,1fr)] bg-[#f8faf9]" id="experiment-runs-panel"><PanelHeader actions={<button className="flex h-7 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white disabled:bg-[#8aa5a2]" disabled={!selectedDataset} onClick={create} type="button"><Play fill="currentColor" size={12} />{t("experiments.newRun")}</button>} metadata={storage ? `${storage.runCount} · ${formatBytes(storage.bytes)}` : loading ? t("experiments.loadingRuns") : undefined} title={t("experiments.runAnalysis")} variant="workspace" /><WorkspaceTabs activeTab={mode} ariaLabel={t("experiments.analysisMode")} idPrefix="experiment-analysis-mode" onChange={setMode} tabs={modeTabs} /><div className="flex min-w-0 items-center justify-between gap-3 border-b border-[#cbd8d9] bg-[#f3f7f6] px-3"><DatasetSelect datasets={datasets} onChange={changeDataset} value={datasetId} /><div className="flex items-center gap-3 font-mono text-[8px] text-[#60777a]">{selectedDataset && <><span>{t("experiments.datasetSamples", { count: selectedDataset.samples })}</span><span>v{selectedDataset.version}</span><span>{t("experiments.totalRuns", { count: runs.length })}</span></>}{loading && <LoaderCircle className="animate-spin" size={12} />}</div></div>{error && mode !== "single" ? <div className="m-3 border border-[#d5a2a2] bg-[#f8eded] px-3 py-2 text-[10px] text-[#843d3d]">{error}</div> : mode === "overall" ? <OverallWorkspace dataset={selectedDataset} trend={trend} /> : mode === "comparison" ? <ComparisonWorkspace dataset={selectedDataset} projectPath={projectPath} runs={runs} /> : !selectedDataset ? <EmptyState>{t("experiments.selectDatasetForAnalysis")}</EmptyState> : <SingleWorkspace onChanged={() => void loadRuns()} projectPath={projectPath} runs={runs} selectedRunId={selectedRunId} setSelectedRunId={setSelectedRunId} />}{createOpen && selectedDataset && <Dialog onClose={() => setCreateOpen(false)} title={t("experiments.newRun")}><CreateRunForm dataset={selectedDataset} onClose={() => setCreateOpen(false)} onCreated={(run) => { setCreateOpen(false); setMode("single"); setSelectedRunId(run.id); void loadRuns(); }} projectPath={projectPath} scoringPromptRequired={storage?.scoringPromptRequired ?? true} /></Dialog>}</section>;
}
