"use client";

import { BarChart, GraphChart, LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import type { EChartsCoreOption } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import {
  Activity,
  AlertTriangle,
  ArrowLeftRight,
  BookOpenCheck,
  BrainCircuit,
  CheckCircle2,
  ExternalLink,
  GitCommitHorizontal,
  History,
  LockKeyhole,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { datasetApi, type DatasetSummary } from "../dataset-api";
import {
  experimentApi,
  type ExperienceCandidate,
  type TrainingCase,
  type TrainingComparisonReport,
  type TrainingRun,
  type TrainingRunAnalysis,
  type TrainingRunAnalysisSummary,
  type TrainingLineageReport,
  type TrainingTrendReport,
  type TrainingVariableView,
} from "../experiment-api";
import { useI18n } from "../i18n";
import { PanelHeader, WorkspaceTabs, type WorkspaceTab } from "./workspace-ui";

echarts.use([BarChart, CanvasRenderer, GraphChart, GridComponent, LegendComponent, LineChart, TooltipComponent]);

type AnalysisMode = "trend" | "compare" | "single";
type RunView = "overview" | "training" | "learning" | "snapshot" | "testing" | "trace";
type Tone = "positive" | "negative" | "neutral" | "warning";

const ACTIVE_STATUSES = new Set(["queued", "running", "paused", "paused_failure", "waiting_review", "ready_to_freeze", "ready_for_test", "testing"]);

const COPY = {
  "zh-CN": {
    title: "训练分析", live: "真实数据", refresh: "刷新分析", trend: "整体趋势", compare: "训练对比", single: "单次训练",
    testDataset: "闭卷测试集", trainDataset: "训练集", allTrainingSets: "全部训练集", scopedHint: "趋势仅统计所选测试集，避免混合不同问题集合。",
    passRate: "闭卷通过率", averageScore: "平均评分", regressions: "退步样本", accepted: "写入经验", tokenPerCase: "每题 Tokens", replayRate: "重跑通过率",
    qualityTrend: "闭卷质量趋势", costTrend: "案例 Token 成本", learningYield: "经验产出与写入", runHistory: "训练历史", snapshot: "知识快照", result: "测试结果", knowledge: "知识增量", tokens: "总 Tokens", lineageTitle: "训练历史追溯", lineageHint: "沿箭头查看每次训练继承的实验，点击节点打开单次分析。", lineageRoot: "根实验", lineageContinue: "继续训练", lineageMissing: "来源实验已不在历史记录中",
    runA: "基线运行", runB: "候选运行", swap: "交换对比运行", comparable: "可直接比较", notComparable: "不可直接比较", caseChanges: "测试样本变化", variableChanges: "变量 Diff", learningChanges: "学习过程差异",
    sample: "样本", status: "状态", improved: "提升", regressed: "退步", unchanged: "不变", added: "新增", removed: "缺失", overview: "概览", training: "训练案例", learning: "经验学习", frozenSnapshot: "冻结快照", testing: "闭卷测试", trace: "执行证据",
    lifecycle: "训练生命周期", provenance: "可复现信息", usage: "Token 构成", recentEvents: "关键事件", scoreEvolution: "训练得分与重跑", phaseTokenCost: "阶段 Token 成本", experienceFunnel: "经验转化漏斗", toolCallProfile: "工具调用与错误",
    firstPass: "首次评分", replayScore: "重跑评分", generated: "生成候选", replayPassed: "重跑通过", reviewAccepted: "写入变量", calls: "调用数", errors: "错误数", projectRevision: "项目版本", model: "模型", evaluator: "Evaluator", datasets: "数据集",
    run: "训练运行", openRun: "返回训练运行", firstAttempt: "首次答案", reference: "参照答案", rationale: "评分说明", actualTools: "实际工具", expectedTools: "预期工具", experienceCandidates: "经验候选", replay: "闭卷重跑", variable: "变量", before: "训练前", after: "训练后", executionSteps: "事件与工具证据",
    noRuns: "当前项目还没有训练记录。", noScopedRuns: "所选数据集没有训练记录。", noData: "没有可展示的数据。", loading: "正在加载训练分析…", failed: "训练分析加载失败", pending: "尚未执行", completed: "已完成", trainingStage: "训练", learningStage: "学习", freezeStage: "冻结", testingStage: "测试",
  },
  en: {
    title: "Training analysis", live: "Live data", refresh: "Refresh analysis", trend: "Overall trends", compare: "Training comparison", single: "Single training",
    testDataset: "Held-out test set", trainDataset: "Training set", allTrainingSets: "All training sets", scopedHint: "Trends only include the selected held-out set so different cohorts are never mixed.",
    passRate: "Held-out pass rate", averageScore: "Average score", regressions: "Regressions", accepted: "Applied experience", tokenPerCase: "Tokens / case", replayRate: "Replay pass rate",
    qualityTrend: "Held-out quality trend", costTrend: "Case token cost", learningYield: "Experience generated and applied", runHistory: "Training history", snapshot: "Knowledge snapshot", result: "Test result", knowledge: "Knowledge delta", tokens: "Total tokens", lineageTitle: "Training lineage", lineageHint: "Follow the arrows to see which run each experiment continued from. Click a node for single-run analysis.", lineageRoot: "Root run", lineageContinue: "Continued run", lineageMissing: "A source run is missing from history",
    runA: "Baseline run", runB: "Candidate run", swap: "Swap compared runs", comparable: "Directly comparable", notComparable: "Not directly comparable", caseChanges: "Test case changes", variableChanges: "Variable diff", learningChanges: "Learning process changes",
    sample: "Sample", status: "Status", improved: "Improved", regressed: "Regressed", unchanged: "Unchanged", added: "Added", removed: "Missing", overview: "Overview", training: "Training cases", learning: "Experience learning", frozenSnapshot: "Frozen snapshot", testing: "Held-out testing", trace: "Execution evidence",
    lifecycle: "Training lifecycle", provenance: "Reproducibility", usage: "Token composition", recentEvents: "Key events", scoreEvolution: "Training score and replay", phaseTokenCost: "Token cost by phase", experienceFunnel: "Experience conversion funnel", toolCallProfile: "Tool calls and errors",
    firstPass: "First score", replayScore: "Replay score", generated: "Generated", replayPassed: "Replay passed", reviewAccepted: "Applied", calls: "Calls", errors: "Errors", projectRevision: "Project revision", model: "Model", evaluator: "Evaluator", datasets: "Datasets",
    run: "Training run", openRun: "Open training run", firstAttempt: "First answer", reference: "Reference answer", rationale: "Evaluation rationale", actualTools: "Actual tools", expectedTools: "Expected tools", experienceCandidates: "Experience candidates", replay: "Closed-book replay", variable: "Variable", before: "Before training", after: "After training", executionSteps: "Events and tool evidence",
    noRuns: "This project has no training runs yet.", noScopedRuns: "No runs match the selected datasets.", noData: "No data to display.", loading: "Loading training analysis…", failed: "Training analysis failed to load", pending: "Not run", completed: "Completed", trainingStage: "Training", learningStage: "Learning", freezeStage: "Freeze", testingStage: "Testing",
  },
} as const;

type Copy = typeof COPY["zh-CN"] | typeof COPY.en;

function chartBase(dark: boolean) {
  const text = dark ? "#a8b8ba" : "#63777b";
  const line = dark ? "#3c4c50" : "#d8e2e2";
  return {
    animation: false,
    textStyle: { color: text, fontFamily: "ui-monospace, monospace", fontSize: 9 },
    grid: { left: 42, right: 18, top: 34, bottom: 28 },
    tooltip: { trigger: "axis", borderWidth: 1 },
    xAxis: { axisLine: { lineStyle: { color: line } }, axisLabel: { color: text, fontSize: 8 } },
    yAxis: { splitLine: { lineStyle: { color: line } }, axisLabel: { color: text, fontSize: 8 } },
  };
}

function StaticChart({ label, onClick, option }: { label: string; onClick?: (id: string) => void; option: (dark: boolean) => EChartsCoreOption }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!element.current) return;
    const chart = echarts.init(element.current);
    const render = () => chart.setOption(option(document.documentElement.dataset.theme === "dark"), { notMerge: true });
    const resize = new ResizeObserver(() => chart.resize());
    const theme = new MutationObserver(render);
    resize.observe(element.current);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    if (onClick) chart.on("click", (params) => {
      if (typeof params === "object" && params !== null && "data" in params) {
        const data = (params as { data?: { id?: unknown } }).data;
        if (typeof data?.id === "string") onClick(data.id);
      }
    });
    render();
    return () => { resize.disconnect(); theme.disconnect(); if (onClick) chart.off("click"); chart.dispose(); };
  }, [onClick, option]);
  return <div aria-label={label} className="h-full min-h-44 w-full" ref={element} role="img" />;
}

function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: Tone }) {
  const style = tone === "positive" ? "border-[#a9d0c8] bg-[#e8f5f1] text-[#17665d]"
    : tone === "negative" ? "border-[#e2b6ad] bg-[#fff1ed] text-[#934737]"
      : tone === "warning" ? "border-[#dbc28f] bg-[#fff7e8] text-[#76551f]"
        : "border-[#cbd8d9] bg-[#f3f7f6] text-[#60777a]";
  return <span className={`inline-flex h-5 items-center border px-1.5 text-[8px] font-semibold ${style}`}>{children}</span>;
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="grid min-h-48 place-items-center bg-white p-8 text-center text-[9px] text-[#718488]">{children}</div>;
}

function MetricStrip({ items }: { items: Array<{ label: string; value: string; delta?: string; tone?: Tone }> }) {
  return <div className="grid border-b border-[#cbd8d9] bg-white" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(100px, 1fr))` }}>{items.map((item) => <div className="min-w-0 border-r border-[#e0e8e8] px-3 py-2 last:border-r-0" key={item.label}><div className="truncate text-[8px] font-semibold uppercase text-[#718488]">{item.label}</div><div className="mt-0.5 flex items-baseline gap-1.5"><strong className="font-mono text-sm text-[#29484c]">{item.value}</strong>{item.delta && <span className={`font-mono text-[8px] ${item.tone === "negative" ? "text-[#9b4141]" : "text-[#25806f]"}`}>{item.delta}</span>}</div></div>)}</div>;
}

function ChartPanel({ children, metadata, title }: { children: ReactNode; metadata?: string; title: string }) {
  return <section className="grid min-h-60 grid-rows-[34px_minmax(210px,1fr)] bg-white"><PanelHeader metadata={metadata} title={title} />{children}</section>;
}

function formatPercent(value: number) { return `${Math.round(value * 100)}%`; }
function formatScore(value: number) { return value.toFixed(2); }
function formatTokens(value: number) { return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(2)}m` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value); }
function shortDate(value: string) { return new Date(value).toLocaleString(undefined, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
function totalTokens(item: TrainingRunAnalysisSummary) { return item.training.usage.totalTokens + item.testing.usage.totalTokens; }
function runLabel(item: TrainingRun | TrainingRunAnalysisSummary) {
  const run = "run" in item ? item.run : item;
  return `${run.id.slice(0, 8)} · ${run.name}`;
}
function delta(value: number, previous: number, unit = "") { const result = value - previous; return `${result >= 0 ? "+" : ""}${result.toFixed(unit ? 0 : 2)}${unit}`; }

function DiffPreview({ value }: { value: string }) {
  if (!value) return <EmptyState>No changes</EmptyState>;
  return <pre className="minimal-scrollbar h-full min-h-52 overflow-auto bg-[#fbfcfc] py-2 font-mono text-[9px] leading-4 text-[#29484c]">{value.split("\n").map((line, index) => {
    const header = line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ");
    const hunk = line.startsWith("@@");
    const addition = line.startsWith("+") && !line.startsWith("+++");
    const removal = line.startsWith("-") && !line.startsWith("---");
    return <span className={`block whitespace-pre-wrap px-3 ${header ? "font-semibold text-[#526b70]" : hunk ? "bg-[#e8eef5] text-[#365a78]" : addition ? "bg-[#e7f5ec] text-[#17665d]" : removal ? "bg-[#fff0ed] text-[#934737]" : ""}`} key={`${index}-${line}`}>{line || " "}</span>;
  })}</pre>;
}

function ScopeBar({ copy, datasets, runs, testDatasetId, trainDatasetId, onTestChange, onTrainChange }: {
  copy: Copy; datasets: DatasetSummary[]; runs: TrainingRun[]; testDatasetId: string; trainDatasetId: string;
  onTestChange: (value: string) => void; onTrainChange: (value: string) => void;
}) {
  const testIds = new Set(runs.map((run) => run.config.testDatasetId));
  const trainIds = new Set(runs.filter((run) => run.config.testDatasetId === testDatasetId).map((run) => run.config.trainDatasetId));
  const label = (id: string) => datasets.find((item) => item.id === id)?.name ?? id;
  return <div className="flex min-w-0 items-center justify-between gap-4 border-b border-[#cbd8d9] bg-[#f3f7f6] px-3 py-1.5"><div className="flex min-w-0 items-center gap-3"><label className="flex items-center gap-2 text-[9px] font-semibold text-[#60777a]">{copy.testDataset}<select aria-label={copy.testDataset} className="h-7 min-w-60 border border-[#9fb5b6] bg-white px-2 font-mono text-[9px] font-normal text-[#294247]" onChange={(event) => onTestChange(event.target.value)} value={testDatasetId}>{[...testIds].map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></label><label className="flex items-center gap-2 text-[9px] font-semibold text-[#60777a]">{copy.trainDataset}<select aria-label={copy.trainDataset} className="h-7 min-w-56 border border-[#9fb5b6] bg-white px-2 font-mono text-[9px] font-normal text-[#294247]" onChange={(event) => onTrainChange(event.target.value)} value={trainDatasetId}><option value="">{copy.allTrainingSets}</option>{[...trainIds].map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></label></div><span className="flex shrink-0 items-center gap-1.5 text-[8px] text-[#60777a]"><ShieldCheck className="text-[#25806f]" size={12} />{copy.scopedHint}</span></div>;
}

function LineageWorkspace({ copy, lineage, onOpenSingle }: { copy: Copy; lineage?: TrainingLineageReport; onOpenSingle: (id: string) => void }) {
  const nodes = useMemo(() => lineage?.nodes ?? [], [lineage?.nodes]);
  const groups = useMemo(() => {
    const value = new Map<number, TrainingLineageReport["nodes"]>();
    for (const node of nodes) value.set(node.depth, [...(value.get(node.depth) ?? []), node]);
    return value;
  }, [nodes]);
  const maxDepth = Math.max(0, ...nodes.map((node) => node.depth));
  const maxGroupSize = Math.max(1, ...[...groups.values()].map((group) => group.length));
  const width = Math.max(620, (maxDepth + 1) * 250);
  const height = Math.max(250, maxGroupSize * 110 + 80);
  const option = useMemo(() => (dark: boolean): EChartsCoreOption => {
    const positions = new Map<string, { x: number; y: number }>();
    for (const [depth, group] of groups) {
      const offset = (maxGroupSize - group.length) * 55;
      group.forEach((node, index) => positions.set(node.run.run.id, { x: depth * 250 + 120, y: offset + index * 110 + 55 }));
    }
    return {
      ...chartBase(dark),
      grid: { left: 0, right: 0, top: 0, bottom: 0 },
      xAxis: { show: false, min: 0, max: width },
      yAxis: { show: false, min: 0, max: height },
      tooltip: { trigger: "item" },
      series: [{
        type: "graph",
        layout: "none",
        roam: true,
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: [4, 8],
        data: nodes.map((node) => {
          const position = positions.get(node.run.run.id) ?? { x: 0, y: 0 };
          const tone = node.run.run.status === "completed" ? "#2d8b7d" : node.run.run.status === "failed" ? "#a65d55" : "#c78e48";
          return {
            id: node.run.run.id,
            name: `${node.run.run.id.slice(0, 7)} · ${node.run.run.name}`,
            value: `${formatPercent(node.run.testing.passRate)} · +${node.run.experiences.applied}`,
            x: position.x,
            y: position.y,
            symbolSize: 22,
            itemStyle: { color: tone, borderColor: dark ? "#dbe7e7" : "#ffffff", borderWidth: 2 },
          };
        }),
        edges: (lineage?.edges ?? []).map((edge) => ({ source: edge.sourceRunId, target: edge.continuationRunId })),
        lineStyle: { color: dark ? "#789396" : "#9fb5b6", width: 2, curveness: 0.08 },
        label: { show: true, position: "bottom", color: dark ? "#dbe7e7" : "#29484c", fontSize: 8, width: 210, overflow: "truncate" },
        emphasis: { focus: "adjacency" },
      }],
    };
  }, [groups, height, lineage?.edges, maxGroupSize, nodes, width]);
  if (!lineage || nodes.length === 0) return <section className="bg-white"><PanelHeader icon={Route} title={copy.lineageTitle} /><EmptyState>{copy.noData}</EmptyState></section>;
  return <section className="grid min-h-[300px] grid-rows-[34px_38px_minmax(250px,1fr)_auto] bg-white"><PanelHeader icon={Route} metadata={`${nodes.length} runs · ${lineage.edges.length} links`} title={copy.lineageTitle} /><div className="flex items-center border-b border-[#e0e8e8] bg-[#f8faf9] px-3 text-[8px] text-[#60777a]">{copy.lineageHint}</div><div className="minimal-scrollbar min-h-0 overflow-auto p-2"><div style={{ height: `${height}px`, minWidth: `${width}px` }}><StaticChart label={copy.lineageTitle} onClick={onOpenSingle} option={option} /></div></div><div className="flex min-w-0 items-center justify-between gap-3 border-t border-[#e0e8e8] bg-[#f8faf9] px-3 py-1.5 text-[8px] text-[#718488]"><span>{copy.lineageRoot}: {lineage.rootRunIds.length}</span>{lineage.missingRunIds.length > 0 && <span className="text-[#934737]">{copy.lineageMissing}: {lineage.missingRunIds.map((id) => id.slice(0, 8)).join(", ")}</span>}</div></section>;
}

function TrendWorkspace({ copy, datasets, runs, report, loading, testDatasetId, trainDatasetId, onTestChange, onTrainChange, onOpenSingle }: {
  copy: Copy; datasets: DatasetSummary[]; runs: TrainingRun[]; report?: TrainingTrendReport; loading: boolean; testDatasetId: string; trainDatasetId: string;
  onTestChange: (value: string) => void; onTrainChange: (value: string) => void; onOpenSingle: (id: string) => void;
}) {
  const items = report?.items ?? [];
  const ordered = useMemo(() => [...items].reverse(), [items]);
  const quality = useMemo(() => (dark: boolean): EChartsCoreOption => ({ ...chartBase(dark), legend: { top: 5, textStyle: { fontSize: 8 } }, xAxis: { ...chartBase(dark).xAxis, type: "category", data: ordered.map((item) => item.run.id.slice(0, 7)) }, yAxis: { ...chartBase(dark).yAxis, type: "value", min: 0, max: 100 }, series: [{ name: copy.passRate, type: "line", data: ordered.map((item) => Math.round(item.testing.passRate * 100)), symbolSize: 7, itemStyle: { color: "#0c766e" } }, { name: copy.averageScore, type: "line", data: ordered.map((item) => Math.round(item.testing.averageScore * 100)), symbolSize: 7, itemStyle: { color: "#b1782f" } }] }), [copy, ordered]);
  const cost = useMemo(() => (dark: boolean): EChartsCoreOption => ({ ...chartBase(dark), legend: { top: 5, textStyle: { fontSize: 8 } }, xAxis: { ...chartBase(dark).xAxis, type: "category", data: ordered.map((item) => item.run.id.slice(0, 7)) }, yAxis: { ...chartBase(dark).yAxis, type: "value" }, series: [{ name: copy.training, type: "bar", stack: "tokens", data: ordered.map((item) => Math.round(item.training.usage.totalTokens / 1000)), itemStyle: { color: "#527f84" } }, { name: copy.testing, type: "bar", stack: "tokens", data: ordered.map((item) => Math.round(item.testing.usage.totalTokens / 1000)), itemStyle: { color: "#c78e48" } }] }), [copy, ordered]);
  const learning = useMemo(() => (dark: boolean): EChartsCoreOption => ({ ...chartBase(dark), legend: { top: 5, textStyle: { fontSize: 8 } }, xAxis: { ...chartBase(dark).xAxis, type: "category", data: ordered.map((item) => item.run.id.slice(0, 7)) }, yAxis: { ...chartBase(dark).yAxis, type: "value", min: 0 }, series: [{ name: copy.generated, type: "bar", data: ordered.map((item) => item.experiences.generated), itemStyle: { color: "#9badad" } }, { name: copy.reviewAccepted, type: "bar", data: ordered.map((item) => item.experiences.applied), itemStyle: { color: "#2d8b7d" } }] }), [copy, ordered]);
  const latest = items[0];
  const previous = items[1];
  return <div className="minimal-scrollbar h-full min-h-0 overflow-auto bg-[#eef3f3]"><ScopeBar copy={copy} datasets={datasets} onTestChange={onTestChange} onTrainChange={onTrainChange} runs={runs} testDatasetId={testDatasetId} trainDatasetId={trainDatasetId} />{loading ? <EmptyState>{copy.loading}</EmptyState> : !latest ? <EmptyState>{copy.noScopedRuns}</EmptyState> : <><MetricStrip items={[{ label: copy.passRate, value: formatPercent(latest.testing.passRate), delta: previous ? delta(latest.testing.passRate * 100, previous.testing.passRate * 100, "pp") : undefined }, { label: copy.averageScore, value: formatScore(latest.testing.averageScore), delta: previous ? delta(latest.testing.averageScore, previous.testing.averageScore) : undefined }, { label: copy.accepted, value: String(latest.experiences.applied), delta: previous ? delta(latest.experiences.applied, previous.experiences.applied, "") : undefined }, { label: copy.tokenPerCase, value: formatTokens(totalTokens(latest) / Math.max(1, latest.training.evaluated + latest.testing.evaluated)) }, { label: copy.replayRate, value: formatPercent(latest.experiences.replayed ? latest.experiences.replayPassed / latest.experiences.replayed : 0) }]} /><div className="grid gap-px bg-[#cbd8d9]"><LineageWorkspace copy={copy} lineage={report?.lineage} onOpenSingle={onOpenSingle} /><div className="grid min-h-[510px] grid-cols-1 gap-px xl:grid-cols-2"><ChartPanel metadata={`${items.length}`} title={copy.qualityTrend}><StaticChart label={copy.qualityTrend} option={quality} /></ChartPanel><ChartPanel metadata="k tokens" title={copy.costTrend}><StaticChart label={copy.costTrend} option={cost} /></ChartPanel><ChartPanel metadata={`${latest.experiences.generated} / ${latest.experiences.applied}`} title={copy.learningYield}><StaticChart label={copy.learningYield} option={learning} /></ChartPanel><section className="bg-white"><PanelHeader metadata={`${items.length}`} title={copy.runHistory} /><div className="minimal-scrollbar max-h-64 overflow-auto"><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="sticky top-0 bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="w-[38%] px-3">Run</th><th className="px-3">{copy.snapshot}</th><th className="px-3 text-right">{copy.result}</th><th className="px-3 text-right">{copy.knowledge}</th><th className="px-3 text-right">{copy.tokens}</th></tr></thead><tbody>{items.map((item) => <tr className="h-10 cursor-pointer border-t border-[#e0e8e8] hover:bg-[#f3f7f6]" key={item.run.id} onClick={() => onOpenSingle(item.run.id)}><td className="px-3"><strong className="block truncate font-mono text-[#29484c]">{item.run.name}</strong><span className="text-[8px] text-[#718488]">{shortDate(item.run.createdAt)} · {item.run.status}</span></td><td className="truncate px-3 font-mono text-[#60777a]">{item.run.snapshotId?.slice(0, 8) ?? "-"}</td><td className="px-3 text-right font-mono">{formatPercent(item.testing.passRate)}</td><td className="px-3 text-right font-mono text-[#25806f]">+{item.experiences.applied}</td><td className="px-3 text-right font-mono">{formatTokens(totalTokens(item))}</td></tr>)}</tbody></table></div></section></div></div></>}</div>;
}

function ComparisonWorkspace({ copy, runs, report, loading, leftId, rightId, onLeftChange, onRightChange }: {
  copy: Copy; runs: TrainingRun[]; report?: TrainingComparisonReport; loading: boolean; leftId: string; rightId: string; onLeftChange: (id: string) => void; onRightChange: (id: string) => void;
}) {
  const [variableName, setVariableName] = useState("");
  const variable = report?.variables.find((item) => item.name === variableName) ?? report?.variables.find((item) => item.changed) ?? report?.variables[0];
  const left = report?.left;
  const right = report?.right;
  return <div className="minimal-scrollbar h-full min-h-0 overflow-auto bg-[#eef3f3]"><div className="grid grid-cols-[minmax(260px,1fr)_38px_minmax(260px,1fr)] items-end gap-2 border-b border-[#cbd8d9] bg-white p-3"><label className="grid gap-1 text-[9px] font-semibold text-[#718488]">{copy.runA}<select aria-label={copy.runA} className="h-8 border border-[#c6d4d4] bg-white px-2 font-mono text-[10px] font-normal text-[#294247]" onChange={(event) => onLeftChange(event.target.value)} value={leftId}>{runs.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}</select></label><button aria-label={copy.swap} className="grid h-8 w-8 place-items-center border border-[#c6d4d4] bg-white text-[#526b70] hover:bg-[#e4efed]" onClick={() => { onLeftChange(rightId); onRightChange(leftId); }} title={copy.swap} type="button"><ArrowLeftRight size={14} /></button><label className="grid gap-1 text-[9px] font-semibold text-[#718488]">{copy.runB}<select aria-label={copy.runB} className="h-8 border border-[#c6d4d4] bg-white px-2 font-mono text-[10px] font-normal text-[#294247]" onChange={(event) => onRightChange(event.target.value)} value={rightId}>{runs.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}</select></label></div>{loading ? <EmptyState>{copy.loading}</EmptyState> : !report || !left || !right ? <EmptyState>{copy.noData}</EmptyState> : <><div className={`flex items-center gap-2 border-b px-3 py-2 text-[9px] ${report.comparable ? "border-[#a9d0c8] bg-[#edf7f4] text-[#486b68]" : "border-[#dbc28f] bg-[#fff7e8] text-[#76551f]"}`}>{report.comparable ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}<strong>{report.comparable ? copy.comparable : copy.notComparable}</strong>{report.reasons.length > 0 && <span>{report.reasons.join(" · ")}</span>}</div><MetricStrip items={[{ label: copy.passRate, value: formatPercent(right.testing.passRate), delta: delta(right.testing.passRate * 100, left.testing.passRate * 100, "pp"), tone: right.testing.passRate >= left.testing.passRate ? "positive" : "negative" }, { label: copy.averageScore, value: formatScore(right.testing.averageScore), delta: delta(right.testing.averageScore, left.testing.averageScore), tone: right.testing.averageScore >= left.testing.averageScore ? "positive" : "negative" }, { label: copy.accepted, value: String(right.experiences.applied), delta: delta(right.experiences.applied, left.experiences.applied) }, { label: copy.tokens, value: formatTokens(totalTokens(right)), delta: delta(Math.round(totalTokens(right) / 1000), Math.round(totalTokens(left) / 1000), "k"), tone: totalTokens(right) <= totalTokens(left) ? "positive" : "negative" }]} /><div className="grid gap-px bg-[#cbd8d9] xl:grid-cols-[1.18fr_0.82fr]"><section className="min-h-72 bg-white"><PanelHeader metadata={`${report.cases.length}`} title={copy.caseChanges} /><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="w-[48%] px-3">{copy.sample}</th><th className="px-3 text-right">A</th><th className="px-3 text-right">B</th><th className="px-3">{copy.status}</th></tr></thead><tbody>{report.cases.map((item) => <tr className="h-10 border-t border-[#e0e8e8]" key={item.sampleId}><td className="px-3"><strong className="block font-mono text-[#29484c]">{item.sampleId}</strong><span className="block truncate text-[8px] text-[#718488]">{item.question}</span></td><td className="px-3 text-right font-mono">{item.left?.score?.toFixed(2) ?? "-"}</td><td className="px-3 text-right font-mono">{item.right?.score?.toFixed(2) ?? "-"}</td><td className="px-3"><StatusPill tone={item.status === "improved" || item.status === "added" ? "positive" : item.status === "regressed" || item.status === "removed" ? "negative" : item.status === "pending" ? "warning" : "neutral"}>{copy[item.status]}</StatusPill></td></tr>)}</tbody></table></section><section className="grid min-h-72 grid-rows-[34px_32px_minmax(230px,1fr)] bg-white"><PanelHeader metadata={variable?.name ?? "-"} title={copy.variableChanges} /><div className="border-b border-[#e0e8e8] bg-[#f8faf9] px-3 py-1"><select aria-label={copy.variable} className="h-6 w-full border border-[#c6d4d4] bg-white px-2 font-mono text-[8px]" onChange={(event) => setVariableName(event.target.value)} value={variable?.name ?? ""}>{report.variables.map((item) => <option key={item.name} value={item.name}>{item.name}{item.changed ? " *" : ""}</option>)}</select></div><DiffPreview value={variable?.unifiedDiff ?? ""} /></section></div><section className="mt-px bg-white"><PanelHeader metadata={`${left.experiences.generated} → ${right.experiences.generated}`} title={copy.learningChanges} /><div className="grid grid-cols-4 divide-x divide-[#e0e8e8]"><ComparisonValue label={copy.generated} left={left.experiences.generated} right={right.experiences.generated} /><ComparisonValue label={copy.replayPassed} left={left.experiences.replayPassed} right={right.experiences.replayPassed} /><ComparisonValue label={copy.reviewAccepted} left={left.experiences.applied} right={right.experiences.applied} /><ComparisonValue label={copy.errors} left={left.experiences.conflicts} right={right.experiences.conflicts} /></div></section></>}</div>;
}

function ComparisonValue({ label, left, right }: { label: string; left: number; right: number }) {
  return <div className="p-3"><span className="text-[8px] font-semibold uppercase text-[#718488]">{label}</span><strong className="mt-1 block font-mono text-[11px] text-[#29484c]">{left} → {right}</strong></div>;
}

function Lifecycle({ copy, analysis }: { copy: Copy; analysis: TrainingRunAnalysis }) {
  const run = analysis.run;
  const stages = [
    [copy.trainingStage, `${run.progress.training.completed} / ${run.progress.training.total}`, BrainCircuit],
    [copy.learningStage, `${analysis.experiences.applied} applied`, Sparkles],
    [copy.freezeStage, run.snapshotId?.slice(0, 8) ?? copy.pending, LockKeyhole],
    [copy.testingStage, `${run.progress.testing.completed} / ${run.progress.testing.total}`, ShieldCheck],
  ] as const;
  return <section className="border-b border-[#cbd8d9] bg-white"><PanelHeader title={copy.lifecycle} /><div className="grid grid-cols-4 divide-x divide-[#e0e8e8]">{stages.map(([title, detail, Icon]) => <div className="grid grid-cols-[30px_1fr] items-center gap-2 px-3 py-2" key={title}><span className="grid h-7 w-7 place-items-center border border-[#a9d0c8] bg-[#e8f5f1] text-[#17665d]"><Icon size={13} /></span><span><strong className="block text-[9px] text-[#29484c]">{title}</strong><span className="font-mono text-[8px] text-[#718488]">{detail}</span></span></div>)}</div></section>;
}

function RunOverview({ copy, analysis }: { copy: Copy; analysis: TrainingRunAnalysis }) {
  const trainingCases = analysis.cases.filter((item) => item.phase === "training");
  const testingCases = analysis.cases.filter((item) => item.phase === "testing");
  const replayByCase = new Map(analysis.experienceCandidates.filter((item) => item.replayScore !== undefined).map((item) => [item.sourceCaseId, item.replayScore ?? 0]));
  const scoreOption = useMemo(() => (dark: boolean): EChartsCoreOption => ({ ...chartBase(dark), legend: { top: 5, textStyle: { fontSize: 8 } }, xAxis: { ...chartBase(dark).xAxis, type: "category", data: trainingCases.map((item) => item.sampleId) }, yAxis: { ...chartBase(dark).yAxis, type: "value", min: 0, max: 100 }, series: [{ name: copy.firstPass, type: "line", data: trainingCases.map((item) => Math.round((item.score ?? 0) * 100)), symbolSize: 7, itemStyle: { color: "#b1782f" } }, { name: copy.replayScore, type: "line", data: trainingCases.map((item) => replayByCase.has(item.id) ? Math.round((replayByCase.get(item.id) ?? 0) * 100) : null), symbolSize: 7, itemStyle: { color: "#0c766e" } }] }), [copy, replayByCase, trainingCases]);
  const tokenOption = useMemo(() => (dark: boolean): EChartsCoreOption => ({ ...chartBase(dark), xAxis: { ...chartBase(dark).xAxis, type: "category", data: [copy.training, copy.testing] }, yAxis: { ...chartBase(dark).yAxis, type: "value" }, series: [{ type: "bar", data: [analysis.training.usage.totalTokens, analysis.testing.usage.totalTokens], itemStyle: { color: "#527f84" } }] }), [analysis, copy]);
  const funnelOption = useMemo(() => (dark: boolean): EChartsCoreOption => ({ ...chartBase(dark), xAxis: { ...chartBase(dark).xAxis, type: "category", data: [copy.generated, copy.replayPassed, copy.reviewAccepted] }, yAxis: { ...chartBase(dark).yAxis, type: "value", min: 0 }, series: [{ type: "bar", data: [analysis.experiences.generated, analysis.experiences.replayPassed, analysis.experiences.applied], itemStyle: { color: "#2d8b7d" } }] }), [analysis, copy]);
  const toolOption = useMemo(() => (dark: boolean): EChartsCoreOption => ({ ...chartBase(dark), legend: { top: 5, textStyle: { fontSize: 8 } }, xAxis: { ...chartBase(dark).xAxis, type: "category", data: [copy.training, copy.testing] }, yAxis: { ...chartBase(dark).yAxis, type: "value", min: 0 }, series: [{ name: copy.calls, type: "bar", data: [analysis.training.toolCalls, analysis.testing.toolCalls], itemStyle: { color: "#527f84" } }, { name: copy.errors, type: "bar", data: [analysis.training.toolErrors, analysis.testing.toolErrors], itemStyle: { color: "#a65d55" } }] }), [analysis, copy]);
  const provenance = analysis.provenance;
  const evaluator = provenance?.evaluator.type === "project" ? provenance.evaluator.revision : provenance?.evaluator.type ?? "-";
  return <div className="grid gap-px bg-[#cbd8d9] xl:grid-cols-2"><ChartPanel metadata={`${trainingCases.length}`} title={copy.scoreEvolution}><StaticChart label={copy.scoreEvolution} option={scoreOption} /></ChartPanel><ChartPanel metadata={formatTokens(totalTokens(analysis))} title={copy.phaseTokenCost}><StaticChart label={copy.phaseTokenCost} option={tokenOption} /></ChartPanel><ChartPanel metadata={`${analysis.experiences.generated} → ${analysis.experiences.applied}`} title={copy.experienceFunnel}><StaticChart label={copy.experienceFunnel} option={funnelOption} /></ChartPanel><ChartPanel metadata={`${analysis.training.toolCalls + analysis.testing.toolCalls} calls`} title={copy.toolCallProfile}><StaticChart label={copy.toolCallProfile} option={toolOption} /></ChartPanel><section className="bg-white"><PanelHeader icon={GitCommitHorizontal} title={copy.provenance} /><dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 p-4 text-[9px]"><dt className="text-[#718488]">{copy.projectRevision}</dt><dd className="font-mono text-[#29484c]">{provenance ? `${provenance.project.shortSha} · ${provenance.project.branch ?? "detached"}` : "-"}</dd><dt className="text-[#718488]">{copy.model}</dt><dd className="font-mono text-[#29484c]">{provenance ? `${provenance.model.provider} · ${provenance.model.model}` : "-"}</dd><dt className="text-[#718488]">{copy.evaluator}</dt><dd className="font-mono text-[#29484c]">{evaluator}</dd><dt className="text-[#718488]">{copy.datasets}</dt><dd className="font-mono text-[#29484c]">{analysis.trainDataset.name} / {analysis.testDataset.name}</dd></dl></section><section className="bg-white"><PanelHeader icon={Activity} title={copy.usage} /><div className="grid grid-cols-2 gap-px bg-[#e0e8e8]"><TokenMetric label="Input" value={analysis.training.usage.inputTokens + analysis.testing.usage.inputTokens} /><TokenMetric label="Output" value={analysis.training.usage.outputTokens + analysis.testing.usage.outputTokens} /><TokenMetric label="Cache read" value={analysis.training.usage.cacheReadTokens + analysis.testing.usage.cacheReadTokens} /><TokenMetric label="Total" value={totalTokens(analysis)} /></div></section><section className="bg-white xl:col-span-2"><PanelHeader icon={History} metadata={`${analysis.events.length}`} title={copy.recentEvents} /><div className="grid grid-cols-1 divide-y divide-[#e0e8e8] text-[9px] md:grid-cols-4 md:divide-x md:divide-y-0">{analysis.events.slice(-4).reverse().map((event) => <div className="p-3" key={event.id}><span className="font-mono text-[#718488]">{shortDate(event.createdAt)}</span><p className="mt-1 text-[#29484c]">{event.type}</p></div>)}{analysis.events.length === 0 && <div className="col-span-4 p-4 text-center text-[#718488]">{copy.noData}</div>}</div></section></div>;
}

function TokenMetric({ label, value }: { label: string; value: number }) { return <div className="bg-white p-4"><span className="text-[8px] font-semibold uppercase text-[#718488]">{label}</span><strong className="mt-1 block font-mono text-lg text-[#29484c]">{formatTokens(value)}</strong></div>; }

function CaseWorkspace({ copy, items, phase }: { copy: Copy; items: TrainingCase[]; phase: "training" | "testing" }) {
  const [selected, setSelected] = useState("");
  const current = items.find((item) => item.id === selected) ?? items[0];
  if (!current) return <EmptyState>{copy.noData}</EmptyState>;
  return <div className="grid min-h-[430px] grid-cols-[minmax(260px,0.72fr)_minmax(460px,1.28fr)] gap-px bg-[#cbd8d9]"><section className="bg-white"><PanelHeader metadata={`${items.length}`} title={phase === "training" ? copy.training : copy.testing} /><div>{items.map((item) => <button aria-pressed={current.id === item.id} className={`grid h-14 w-full grid-cols-[1fr_56px] items-center border-b border-[#e0e8e8] px-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${current.id === item.id ? "bg-[#d9e9e6]" : "hover:bg-[#f3f7f6]"}`} key={item.id} onClick={() => setSelected(item.id)} type="button"><span className="min-w-0"><strong className="block font-mono text-[9px] text-[#29484c]">{item.sampleId}</strong><span className="mt-1 block truncate text-[8px] text-[#718488]">{item.question}</span></span><span className="text-right font-mono text-[11px] text-[#29484c]">{item.score === undefined ? "-" : Math.round(item.score * 100)}</span></button>)}</div></section><section className="grid bg-white grid-rows-[34px_minmax(0,1fr)]"><PanelHeader metadata={current.status} title={`${copy.sample} · ${current.sampleId}`} /><div className="grid grid-cols-2 divide-x divide-[#e0e8e8]"><div className="minimal-scrollbar overflow-auto p-4"><span className="text-[8px] font-semibold uppercase text-[#718488]">{copy.firstAttempt}</span><p className="mt-2 whitespace-pre-wrap text-[9px] leading-5 text-[#29484c]">{current.actualAnswer || copy.pending}</p><span className="mt-4 block text-[8px] font-semibold uppercase text-[#718488]">{copy.rationale}</span><p className="mt-2 whitespace-pre-wrap text-[9px] leading-5 text-[#526b70]">{current.rationale ?? current.failure?.message ?? "-"}</p></div><div className="minimal-scrollbar overflow-auto p-4"><span className="text-[8px] font-semibold uppercase text-[#718488]">{copy.reference}</span><p className="mt-2 whitespace-pre-wrap text-[9px] leading-5 text-[#29484c]">{current.referenceAvailable ? current.expectedAnswer || "-" : copy.pending}</p><ToolPills label={copy.expectedTools} tools={current.expectedTools} /><ToolPills label={copy.actualTools} tools={current.actualTools} /></div></div></section></div>;
}

function ToolPills({ label, tools }: { label: string; tools: string[] }) { return <div className="mt-4"><span className="text-[8px] font-semibold uppercase text-[#718488]">{label}</span><div className="mt-2 flex flex-wrap gap-1">{tools.length > 0 ? tools.map((tool, index) => <StatusPill key={`${tool}-${index}`}>{tool}</StatusPill>) : <span className="text-[8px] text-[#718488]">-</span>}</div></div>; }

function LearningWorkspace({ copy, items }: { copy: Copy; items: ExperienceCandidate[] }) {
  const [selected, setSelected] = useState("");
  const [patchIndex, setPatchIndex] = useState(0);
  const current = items.find((item) => item.id === selected) ?? items[0];
  if (!current) return <EmptyState>{copy.noData}</EmptyState>;
  const patch = current.patches[patchIndex] ?? current.patches[0];
  return <div className="grid min-h-[430px] grid-cols-[minmax(330px,0.8fr)_minmax(500px,1.2fr)] gap-px bg-[#cbd8d9]"><section className="bg-white"><PanelHeader metadata={`${items.length}`} title={copy.experienceCandidates} /><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="px-3">ID / Source</th><th className="px-3">{copy.variable}</th><th className="px-3 text-right">{copy.replay}</th><th className="px-3">{copy.status}</th></tr></thead><tbody>{items.map((item) => <tr aria-selected={current.id === item.id} className={`h-11 cursor-pointer border-t border-[#e0e8e8] ${current.id === item.id ? "bg-[#d9e9e6]" : "hover:bg-[#f3f7f6]"}`} key={item.id} onClick={() => { setSelected(item.id); setPatchIndex(0); }}><td className="px-3"><strong className="block font-mono text-[#29484c]">{item.id.slice(0, 8)}</strong><span className="text-[8px] text-[#718488]">{item.sourceOutcome} · {item.sourceCaseId.slice(0, 8)}</span></td><td className="truncate px-3 font-mono text-[#60777a]">{item.patches.map((value) => value.variableName).join(", ") || "-"}</td><td className="px-3 text-right font-mono">{item.replayScore === undefined ? "-" : Math.round(item.replayScore * 100)}</td><td className="px-3"><StatusPill tone={item.status === "applied" ? "positive" : item.status === "rejected" || item.status === "conflict" ? "negative" : "warning"}>{item.status}</StatusPill></td></tr>)}</tbody></table></section><section className="grid min-h-0 grid-rows-[34px_34px_minmax(0,1fr)] bg-white"><PanelHeader metadata={patch?.variableName ?? "-"} title={copy.variableChanges} /><div className="flex items-center justify-between border-b border-[#e0e8e8] px-3"><select aria-label={copy.variable} className="h-6 border border-[#c6d4d4] bg-white px-2 font-mono text-[8px]" onChange={(event) => setPatchIndex(Number(event.target.value))} value={Math.min(patchIndex, Math.max(0, current.patches.length - 1))}>{current.patches.map((item, index) => <option key={`${item.variableName}-${index}`} value={index}>{item.variableName}</option>)}</select><StatusPill tone={current.replayPassed ? "positive" : current.replayPassed === false ? "negative" : "warning"}>{current.status}</StatusPill></div><DiffPreview value={patch?.unifiedDiff ?? ""} /></section></div>;
}

function SnapshotWorkspace({ copy, items, snapshotId }: { copy: Copy; items: TrainingVariableView[]; snapshotId?: string }) {
  const [selected, setSelected] = useState("");
  const current = items.find((item) => item.name === selected) ?? items.find((item) => item.changed) ?? items[0];
  if (!current) return <EmptyState>{copy.noData}</EmptyState>;
  return <div className="grid min-h-[430px] grid-cols-[260px_minmax(0,1fr)] gap-px bg-[#cbd8d9]"><section className="bg-white"><PanelHeader metadata={`${items.length}`} title={copy.variable} />{items.map((item) => <button className={`flex h-12 w-full items-center justify-between border-b border-[#e0e8e8] px-3 text-left ${current.name === item.name ? "bg-[#d9e9e6]" : ""}`} key={item.name} onClick={() => setSelected(item.name)} type="button"><span className="truncate font-mono text-[9px] font-semibold text-[#29484c]">{item.name}</span><StatusPill tone={item.changed ? "positive" : "neutral"}>{item.changed ? "changed" : "unchanged"}</StatusPill></button>)}</section><section className="grid min-h-0 grid-rows-[34px_minmax(0,1fr)] bg-white"><PanelHeader metadata={snapshotId?.slice(0, 8) ?? "live"} title={current.name} /><div className="grid grid-cols-2 divide-x divide-[#e0e8e8]"><div className="p-4"><h3 className="text-[8px] font-semibold uppercase text-[#718488]">{copy.before}</h3><pre className="minimal-scrollbar mt-3 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[9px] leading-5 text-[#526b70]">{current.baselineValue || "-"}</pre></div><div className="border-l-2 border-[#63a89d] bg-[#f6fbf9] p-4"><h3 className="text-[8px] font-semibold uppercase text-[#257368]">{copy.after}</h3><pre className="minimal-scrollbar mt-3 max-h-96 overflow-auto whitespace-pre-wrap font-mono text-[9px] leading-5 text-[#29484c]">{current.snapshotValue ?? current.runValue ?? "-"}</pre></div></div></section></div>;
}

function TraceWorkspace({ copy, analysis }: { copy: Copy; analysis: TrainingRunAnalysis }) {
  const toolRows = analysis.cases.flatMap((item) => item.toolCalls.map((call) => ({ id: `${item.id}-${call.callId}`, time: call.startedAt, sample: item.sampleId, type: call.name, status: call.status, duration: call.durationMs })));
  const eventRows = analysis.events.map((event) => ({ id: `event-${event.id}`, time: event.createdAt, sample: "run", type: event.type, status: "recorded", duration: undefined as number | undefined }));
  const rows = [...toolRows, ...eventRows].sort((left, right) => left.time.localeCompare(right.time));
  return <section className="min-h-[430px] bg-white"><PanelHeader icon={Route} metadata={`${rows.length}`} title={copy.executionSteps} />{rows.length === 0 ? <EmptyState>{copy.noData}</EmptyState> : <table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="bg-[#edf3f2] text-[#657b7f]"><tr className="h-8"><th className="px-3">Time</th><th className="px-3">{copy.sample}</th><th className="px-3">Step</th><th className="px-3">{copy.status}</th><th className="px-3 text-right">Duration</th></tr></thead><tbody>{rows.map((row) => <tr className="h-10 border-t border-[#e0e8e8]" key={row.id}><td className="px-3 font-mono text-[#60777a]">{shortDate(row.time)}</td><td className="truncate px-3 font-mono text-[#60777a]">{row.sample}</td><td className="truncate px-3 font-mono font-semibold text-[#29484c]">{row.type}</td><td className="px-3"><StatusPill tone={row.status === "failed" ? "negative" : "positive"}>{row.status}</StatusPill></td><td className="px-3 text-right font-mono">{row.duration === undefined ? "-" : `${row.duration}ms`}</td></tr>)}</tbody></table>}</section>;
}

function SingleWorkspace({ copy, runs, analysis, loading, selectedRunId, onRunChange, onOpenTraining }: {
  copy: Copy; runs: TrainingRun[]; analysis?: TrainingRunAnalysis; loading: boolean; selectedRunId: string; onRunChange: (id: string) => void; onOpenTraining: (id: string) => void;
}) {
  const [view, setView] = useState<RunView>("overview");
  const tabs: WorkspaceTab<RunView>[] = [{ id: "overview", label: copy.overview, icon: Activity }, { id: "training", label: copy.training, icon: BrainCircuit }, { id: "learning", label: copy.learning, icon: Sparkles }, { id: "snapshot", label: copy.frozenSnapshot, icon: LockKeyhole }, { id: "testing", label: copy.testing, icon: ShieldCheck }, { id: "trace", label: copy.trace, icon: Route }];
  return <div className="minimal-scrollbar h-full min-h-0 overflow-auto bg-[#eef3f3]"><div className="flex items-center justify-between gap-3 border-b border-[#cbd8d9] bg-white px-3 py-2"><label className="flex items-center gap-2 text-[9px] font-semibold text-[#60777a]">{copy.run}<select aria-label={copy.run} className="h-8 min-w-80 border border-[#9fb5b6] bg-white px-2 font-mono text-[9px] font-normal text-[#294247]" onChange={(event) => onRunChange(event.target.value)} value={selectedRunId}>{runs.map((run) => <option key={run.id} value={run.id}>{runLabel(run)}</option>)}</select></label><div className="flex items-center gap-2">{analysis && <><StatusPill tone={analysis.run.status === "completed" ? "positive" : analysis.run.status === "failed" ? "negative" : "warning"}>{analysis.run.status}</StatusPill><span className="font-mono text-[8px] text-[#718488]">{shortDate(analysis.run.createdAt)}</span><button className="flex h-7 items-center gap-1 border border-[#9fb5b6] bg-white px-2 text-[8px] font-semibold text-[#526b70] hover:bg-[#edf3f2]" onClick={() => onOpenTraining(analysis.run.id)} type="button"><ExternalLink size={11} />{copy.openRun}</button></>}</div></div>{loading ? <EmptyState>{copy.loading}</EmptyState> : !analysis ? <EmptyState>{copy.noData}</EmptyState> : <><Lifecycle analysis={analysis} copy={copy} /><MetricStrip items={[{ label: copy.passRate, value: formatPercent(analysis.testing.passRate) }, { label: copy.averageScore, value: formatScore(analysis.testing.averageScore) }, { label: copy.accepted, value: String(analysis.experiences.applied) }, { label: copy.errors, value: String(analysis.training.errors + analysis.testing.errors) }, { label: copy.tokens, value: formatTokens(totalTokens(analysis)) }]} /><WorkspaceTabs activeTab={view} ariaLabel={copy.single} idPrefix="training-analysis-run-view" onChange={setView} scrollable tabs={tabs} /><div aria-labelledby={`training-analysis-run-view-${view}-tab`} role="tabpanel">{view === "overview" ? <RunOverview analysis={analysis} copy={copy} /> : view === "training" ? <CaseWorkspace copy={copy} items={analysis.cases.filter((item) => item.phase === "training")} phase="training" /> : view === "learning" ? <LearningWorkspace copy={copy} items={analysis.experienceCandidates} /> : view === "snapshot" ? <SnapshotWorkspace copy={copy} items={analysis.variableItems} snapshotId={analysis.snapshot?.id} /> : view === "testing" ? <CaseWorkspace copy={copy} items={analysis.cases.filter((item) => item.phase === "testing")} phase="testing" /> : <TraceWorkspace analysis={analysis} copy={copy} />}</div></>}</div>;
}

export default function ExperimentTrainingAnalysisPreview({ projectPath, onOpenTraining }: { projectPath: string; onOpenTraining: (id: string) => void }) {
  const { locale } = useI18n();
  const copy = COPY[locale];
  const [mode, setMode] = useState<AnalysisMode>("trend");
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [testDatasetId, setTestDatasetId] = useState("");
  const [trainDatasetId, setTrainDatasetId] = useState("");
  const [leftId, setLeftId] = useState("");
  const [rightId, setRightId] = useState("");
  const [singleId, setSingleId] = useState("");
  const [trend, setTrend] = useState<TrainingTrendReport>();
  const [comparison, setComparison] = useState<TrainingComparisonReport>();
  const [analysis, setAnalysis] = useState<TrainingRunAnalysis>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const initialRequestRead = useRef(false);

  const loadCatalog = useCallback(async () => {
    const requested = initialRequestRead.current
      ? null
      : new URL(window.location.href).searchParams.get("trainingAnalysisRun");
    initialRequestRead.current = true;
    setLoading(true);
    setError("");
    try {
      const [history, datasetList] = await Promise.all([experimentApi.training.list(projectPath, 100), datasetApi.list(projectPath)]);
      setRuns(history.items);
      setDatasets(datasetList.items);
      if (history.items.length === 0) return;
      const selected = history.items.find((item) => item.id === requested) ?? history.items[0];
      const sameTest = history.items.filter((item) => item.config.testDatasetId === selected.config.testDatasetId);
      setSingleId((current) => history.items.some((item) => item.id === current) ? current : selected.id);
      setTestDatasetId((current) => current && history.items.some((item) => item.config.testDatasetId === current) ? current : selected.config.testDatasetId);
      setRightId((current) => history.items.some((item) => item.id === current) ? current : selected.id);
      setLeftId((current) => history.items.some((item) => item.id === current) && current !== selected.id ? current : sameTest.find((item) => item.id !== selected.id)?.id ?? history.items.find((item) => item.id !== selected.id)?.id ?? "");
      if (requested) setMode("single");
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => { void Promise.resolve().then(loadCatalog); }, [loadCatalog, revision]);
  useEffect(() => {
    if (!testDatasetId) return;
    let active = true;
    void experimentApi.training.trend(projectPath, testDatasetId, trainDatasetId || undefined, 100)
      .then((value) => { if (active) setTrend(value); })
      .catch((value: unknown) => { if (active) setError(value instanceof Error ? value.message : String(value)); });
    return () => { active = false; };
  }, [projectPath, revision, testDatasetId, trainDatasetId]);
  useEffect(() => {
    if (!leftId || !rightId || leftId === rightId) return;
    let active = true;
    void experimentApi.training.compare(projectPath, leftId, rightId)
      .then((value) => { if (active) setComparison(value); })
      .catch((value: unknown) => { if (active) setError(value instanceof Error ? value.message : String(value)); });
    return () => { active = false; };
  }, [leftId, projectPath, revision, rightId]);
  useEffect(() => {
    if (!singleId) return;
    let active = true;
    void experimentApi.training.analysis(projectPath, singleId)
      .then((value) => { if (active) setAnalysis(value); })
      .catch((value: unknown) => { if (active) setError(value instanceof Error ? value.message : String(value)); });
    const url = new URL(window.location.href);
    url.searchParams.set("trainingAnalysisRun", singleId);
    window.history.replaceState(window.history.state, "", url);
    return () => { active = false; };
  }, [projectPath, revision, singleId]);

  const openSingle = (id: string) => { setSingleId(id); setMode("single"); };
  const changeTest = (id: string) => { setTestDatasetId(id); setTrainDatasetId(""); };
  const tabs: WorkspaceTab<AnalysisMode>[] = [{ id: "trend", label: copy.trend, icon: Activity }, { id: "compare", label: copy.compare, icon: ArrowLeftRight }, { id: "single", label: copy.single, icon: BookOpenCheck }];
  return <section className="grid h-full min-h-0 min-w-[860px] grid-rows-[56px_34px_minmax(0,1fr)] bg-[#f8faf9]" data-static-preview="false" id="experiment-training-analysis-preview"><PanelHeader actions={<div className="flex items-center gap-2"><StatusPill tone="positive"><CheckCircle2 className="mr-1" size={10} />{copy.live}</StatusPill><button aria-label={copy.refresh} className="grid h-7 w-7 place-items-center border border-[#c6d4d4] bg-white text-[#526b70] hover:bg-[#edf3f2]" onClick={() => setRevision((value) => value + 1)} title={copy.refresh} type="button"><RefreshCw size={12} /></button></div>} metadata={runs.length ? `${runs.length} runs` : copy.noRuns} title={copy.title} variant="workspace" /><WorkspaceTabs activeTab={mode} ariaLabel={copy.title} idPrefix="training-analysis-mode" onChange={setMode} tabs={tabs} />{error ? <div className="grid min-h-0 place-items-center bg-[#fff7e8] p-8 text-center text-[9px] text-[#76551f]"><div><AlertTriangle className="mx-auto mb-2" size={18} /><strong className="block">{copy.failed}</strong><span className="mt-1 block font-mono">{error}</span></div></div> : runs.length === 0 && !loading ? <EmptyState>{copy.noRuns}</EmptyState> : <div aria-labelledby={`training-analysis-mode-${mode}-tab`} className="min-h-0" role="tabpanel">{mode === "trend" ? <TrendWorkspace copy={copy} datasets={datasets} loading={loading} onOpenSingle={openSingle} onTestChange={changeTest} onTrainChange={setTrainDatasetId} report={trend} runs={runs} testDatasetId={testDatasetId} trainDatasetId={trainDatasetId} /> : mode === "compare" ? <ComparisonWorkspace copy={copy} leftId={leftId} loading={loading} onLeftChange={setLeftId} onRightChange={setRightId} report={comparison} rightId={rightId} runs={runs} /> : <SingleWorkspace analysis={analysis} copy={copy} loading={loading} onOpenTraining={onOpenTraining} onRunChange={setSingleId} runs={runs} selectedRunId={singleId} />}</div>}</section>;
}
