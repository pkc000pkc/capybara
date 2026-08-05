"use client";

import {
  AlertTriangle,
  ArrowRight,
  BookOpenCheck,
  Bot,
  BrainCircuit,
  Check,
  CheckCircle2,
  Database,
  FileDiff,
  GitCommitHorizontal,
  History,
  LineChart,
  LoaderCircle,
  LocateFixed,
  LockKeyhole,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Variable,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { datasetApi, type DatasetSummary } from "../dataset-api";
import {
  experimentApi,
  type ExperienceCandidate,
  type TrainingCase,
  type TrainingLearningMode,
  type TrainingReviewScope,
  type TrainingRun,
  type TrainingVariableSource,
  type TrainingVariableView,
  type VariableDiff,
} from "../experiment-api";
import { useI18n } from "../i18n";
import { PanelHeader } from "./workspace-ui";

type PhaseId = "training" | "freeze" | "testing";
type LearningView = "attempt" | "evaluate" | "correct" | "extract" | "replay";
type HookOption = { id: string; name: string; checkpoint: "after_loop" | "after_evaluation" | "after_replay" };

const TRAIN_LIMIT = 10;
const TEST_LIMIT = 5;
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "paused", "paused_failure", "waiting_review", "ready_to_freeze", "ready_for_test", "testing"]);
const FIELD_CLASS = "h-7 w-full border border-[#c6d4d4] bg-white px-2 font-mono text-[9px] text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e] disabled:bg-[#edf3f2] disabled:text-[#718488]";

function AccessBadge({ tone, children }: { tone: "write" | "frozen" | "read"; children: ReactNode }) {
  const styles = tone === "write"
    ? "border-[#8fc8bd] bg-[#e8f5f1] text-[#17665d]"
    : tone === "frozen"
      ? "border-[#d7bd8d] bg-[#fff7e8] text-[#76551f]"
      : "border-[#aebfc4] bg-[#edf3f4] text-[#48636a]";
  return <span className={`inline-flex h-5 items-center border px-1.5 font-mono text-[8px] font-semibold uppercase ${styles}`}>{children}</span>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-w-0 border-r border-[#dce5e5] px-3 py-2 last:border-r-0"><div className="truncate text-[8px] font-semibold uppercase text-[#718488]">{label}</div><div className="mt-0.5 font-mono text-sm font-semibold text-[#29484c]">{value}</div><div className="mt-0.5 truncate text-[8px] text-[#718488]">{detail}</div></div>;
}

function ProgressBar({ progress, total }: { progress: number; total: number }) {
  const percent = total ? Math.min(100, progress / total * 100) : 0;
  return <div aria-label={`${progress} / ${total}`} className="h-1.5 overflow-hidden bg-[#dce5e5]" role="progressbar" aria-valuemax={total} aria-valuemin={0} aria-valuenow={progress}><span className="block h-full bg-[#0c766e] transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${percent}%` }} /></div>;
}

function GitDiffPreview({ label, value }: { label: string; value: string }) {
  return <pre aria-label={label} className="minimal-scrollbar min-h-0 overflow-auto border border-[#cbd8d9] bg-[#f8faf9] py-2 font-mono text-[9px] leading-4 text-[#29484c]">{value.split("\n").map((line, index) => {
    const header = line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ");
    const hunk = line.startsWith("@@");
    const addition = line.startsWith("+") && !line.startsWith("+++");
    const removal = line.startsWith("-") && !line.startsWith("---");
    return <span className={`block whitespace-pre-wrap px-3 ${header ? "font-semibold text-[#526b70]" : hunk ? "bg-[#e8eef5] text-[#365a78]" : addition ? "bg-[#e7f5ec] text-[#17665d]" : removal ? "bg-[#fff0ed] text-[#934737]" : ""}`} key={`${index}-${line}`}>{line || " "}</span>;
  })}</pre>;
}

function ToolList({ label, tools }: { label: string; tools: string[] }) {
  return <div className="grid gap-1"><span className="text-[8px] font-semibold uppercase text-[#718488]">{label}</span><div className="flex flex-wrap gap-1">{tools.length ? tools.map((tool, index) => <span className="border border-[#cbd8d9] bg-[#f3f7f6] px-1.5 py-0.5 font-mono text-[8px] text-[#526b70]" key={`${tool}-${index}`}>{index + 1}. {tool}</span>) : <span className="text-[8px] text-[#8b9b9e]">-</span>}</div></div>;
}

function RunDefinition({
  datasets,
  disabled,
  name,
  onNameChange,
  onTestDatasetChange,
  onTrainDatasetChange,
  onVariableSourceChange,
  onVariableSourceRunChange,
  sourceRuns,
  testDatasetId,
  trainDatasetId,
  variableSource,
  variableSourceRunId,
}: {
  datasets: DatasetSummary[];
  disabled: boolean;
  name: string;
  onNameChange: (value: string) => void;
  onTestDatasetChange: (value: string) => void;
  onTrainDatasetChange: (value: string) => void;
  onVariableSourceChange: (value: TrainingVariableSource) => void;
  onVariableSourceRunChange: (value: string) => void;
  sourceRuns: TrainingRun[];
  testDatasetId: string;
  trainDatasetId: string;
  variableSource: TrainingVariableSource;
  variableSourceRunId: string;
}) {
  const { t } = useI18n();
  return <section className="grid min-h-0 grid-rows-[34px_50px_1fr] border border-[#cbd8d9] bg-white" id="training-phase-detail">
    <PanelHeader icon={Database} title={t("experiments.runDefinition")} />
    <div className="border-b border-[#dce5e5] bg-[#f8faf9] px-3 py-2"><div className="flex items-center justify-between gap-3"><span className="text-[9px] font-semibold text-[#29484c]">{t("experiments.trainingPhase")}</span><AccessBadge tone="write">{t("experiments.writeEnabled")}</AccessBadge></div><p className="mt-1 text-[8px] leading-4 text-[#718488]">{t("experiments.trainingPhaseDescription")}</p></div>
    <div className="grid content-start gap-3 p-3">
      <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">{t("experiments.trainingName")}<input aria-label={t("experiments.trainingName")} autoComplete="off" className={FIELD_CLASS} disabled={disabled} maxLength={120} onChange={(event) => onNameChange(event.target.value)} required value={name} /></label>
      <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">{t("experiments.trainingSplit")}<select aria-label={t("experiments.trainingSplit")} className={FIELD_CLASS} disabled={disabled} onChange={(event) => onTrainDatasetChange(event.target.value)} value={trainDatasetId}><option value="">-</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.samples}</option>)}</select></label>
      <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">{t("experiments.testingSplit")}<select aria-label={t("experiments.testingSplit")} className={FIELD_CLASS} disabled={disabled} onChange={(event) => onTestDatasetChange(event.target.value)} value={testDatasetId}><option value="">-</option>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name} · {dataset.samples}</option>)}</select></label>
      <div className="grid grid-cols-2 gap-2"><label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">{t("experiments.trainingLimit")}<input className={FIELD_CLASS} readOnly type="number" value={TRAIN_LIMIT} /></label><label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">{t("experiments.testingLimit")}<input className={FIELD_CLASS} readOnly type="number" value={TEST_LIMIT} /></label></div>
      <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">{t("experiments.trainingVariableSource")}<select aria-label={t("experiments.trainingVariableSource")} className={FIELD_CLASS} disabled={disabled} onChange={(event) => onVariableSourceChange(event.target.value as TrainingVariableSource)} value={variableSource}><option value="project">{t("experiments.trainingVariableSourceProject")}</option><option value="run">{t("experiments.trainingVariableSourceRun")}</option></select></label>
      {variableSource === "run" && <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">{t("experiments.trainingVariableSourceRunLabel")}<select aria-label={t("experiments.trainingVariableSourceRunLabel")} className={FIELD_CLASS} disabled={disabled} onChange={(event) => onVariableSourceRunChange(event.target.value)} value={variableSourceRunId}><option value="">-</option>{sourceRuns.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.id.slice(0, 8)}</option>)}</select></label>}
      <p className="border-l-2 border-[#63a89d] bg-[#edf7f4] px-2.5 py-1.5 text-[8px] leading-4 text-[#486b68]">{t("experiments.trainingVariableIsolation")}</p>
    </div>
  </section>;
}

function suggestedTrainingName(datasets: DatasetSummary[], trainDatasetId: string, testDatasetId: string): string {
  const train = datasets.find((item) => item.id === trainDatasetId)?.name;
  const test = datasets.find((item) => item.id === testDatasetId)?.name;
  return train && test ? `${train} -> ${test}` : train ?? test ?? "";
}

function LearningStrategy({
  correctionHook,
  disabled,
  extractorHook,
  hooks,
  learningMode,
  onCorrectionHookChange,
  onExtractorHookChange,
  onLearningModeChange,
  onReviewScopeChange,
  onStopOnFailureChange,
  reviewScope,
  stopOnFailure,
}: {
  correctionHook: string;
  disabled: boolean;
  extractorHook: string;
  hooks: HookOption[];
  learningMode: TrainingLearningMode;
  onCorrectionHookChange: (value: string) => void;
  onExtractorHookChange: (value: string) => void;
  onLearningModeChange: (value: TrainingLearningMode) => void;
  onReviewScopeChange: (value: TrainingReviewScope) => void;
  onStopOnFailureChange: (value: boolean) => void;
  reviewScope: TrainingReviewScope;
  stopOnFailure: boolean;
}) {
  const { t } = useI18n();
  const [showExtractorConfig, setShowExtractorConfig] = useState(false);
  const evaluationHooks = hooks.filter((hook) => hook.checkpoint === "after_evaluation");
  const modes: Array<{ id: TrainingLearningMode; label: string }> = [
    { id: "review", label: t("experiments.learningModeReview") },
    { id: "author", label: t("experiments.learningModeManual") },
    { id: "auto", label: t("experiments.learningModeAutomatic") },
  ];
  return <section className="grid min-h-0 grid-rows-[34px_1fr] border border-[#cbd8d9] bg-white" id="training-learning-strategy">
    <PanelHeader icon={Bot} metadata={t("experiments.builtinStrategy")} title={t("experiments.experienceLearningStrategy")} />
    <div className="grid content-start gap-2.5 p-3">
      <div className="grid gap-1"><span className="text-[9px] font-semibold text-[#60777a]">{t("experiments.learningMode")}</span><div aria-label={t("experiments.learningMode")} className="grid grid-cols-3 border border-[#c6d4d4]" role="radiogroup">{modes.map((mode) => <button aria-checked={learningMode === mode.id} className={`h-7 border-r border-[#c6d4d4] px-1 text-[8px] font-semibold outline-none last:border-r-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${learningMode === mode.id ? "bg-[#0c766e] text-white" : "bg-white text-[#526b70] hover:bg-[#edf3f2]"}`} disabled={disabled} key={mode.id} onClick={() => onLearningModeChange(mode.id)} role="radio" type="button">{mode.label}</button>)}</div></div>
      <label className="flex min-h-7 items-center gap-2 border border-[#cbd8d9] bg-[#f8faf9] px-2.5 text-[9px] font-semibold text-[#526b70]"><input checked={stopOnFailure} className="accent-[#0c766e]" disabled={disabled} onChange={(event) => onStopOnFailureChange(event.target.checked)} type="checkbox" /><span>{t("experiments.stopOnFailure")}</span></label>
      <div className="grid gap-1"><span className="text-[9px] font-semibold text-[#60777a]">{t("experiments.reviewScope")}</span><div aria-label={t("experiments.reviewScope")} className="grid grid-cols-2 border border-[#c6d4d4]" role="radiogroup">{(["all", "failed"] as const).map((scope) => <button aria-checked={reviewScope === scope} className={`h-7 border-r border-[#c6d4d4] px-2 text-[8px] font-semibold outline-none last:border-r-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:opacity-55 ${reviewScope === scope ? "bg-[#d9e9e6] text-[#17665d]" : "bg-white text-[#526b70]"}`} disabled={disabled || learningMode !== "review"} key={scope} onClick={() => onReviewScopeChange(scope)} role="radio" type="button">{scope === "all" ? t("experiments.reviewScopeAll") : t("experiments.reviewScopeFailures")}</button>)}</div></div>
      <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">{t("experiments.correctionHook")}<select aria-label={t("experiments.correctionHook")} className={FIELD_CLASS} disabled={disabled} onChange={(event) => onCorrectionHookChange(event.target.value)} value={correctionHook}><option value="">-</option>{evaluationHooks.map((hook) => <option key={hook.id} value={hook.id}>{hook.name}.ts</option>)}</select></label>
      <div className="grid gap-1"><span className="flex items-center justify-between text-[9px] font-semibold text-[#60777a]">{t("experiments.experienceExtractorHook")}<button aria-expanded={showExtractorConfig} aria-label={t("experiments.configureExtractor")} className={`grid h-5 w-5 place-items-center border ${showExtractorConfig ? "border-[#8fc8bd] bg-[#e8f5f1] text-[#17665d]" : "border-[#c6d4d4] bg-white text-[#60777a]"}`} onClick={() => setShowExtractorConfig((current) => !current)} title={t("experiments.configureExtractor")} type="button"><Settings2 size={11} /></button></span><select aria-label={t("experiments.experienceExtractorHook")} className={FIELD_CLASS} disabled={disabled} onChange={(event) => onExtractorHookChange(event.target.value)} value={extractorHook}><option value="">-</option>{evaluationHooks.map((hook) => <option key={hook.id} value={hook.id}>{hook.name}.ts</option>)}</select></div>
      {showExtractorConfig && <div className="grid gap-2 border border-[#b9d8ce] bg-[#edf7f4] p-2" id="experience-extractor-parameters"><div className="grid grid-cols-2 gap-2"><label className="grid gap-1 text-[8px] font-semibold text-[#60777a]">{t("experiments.noveltyThreshold")}<input className={FIELD_CLASS} defaultValue="0.25" disabled={disabled} /></label><label className="grid gap-1 text-[8px] font-semibold text-[#60777a]">{t("experiments.maxCandidateTokens")}<input className={FIELD_CLASS} defaultValue="600" disabled={disabled} /></label></div><span className="font-mono text-[8px] text-[#526b70]">after_evaluation · QTA · tools · evaluation</span></div>}
      <p className="border-l-2 border-[#63a89d] bg-[#edf7f4] px-2.5 py-1.5 text-[8px] leading-4 text-[#486b68]">{t(`experiments.learningModeHint.${learningMode === "author" ? "manual" : learningMode === "auto" ? "automatic" : "review"}`)}</p>
    </div>
  </section>;
}

function CaseQueue({ activeCaseId, cases, currentCaseId, onFollowCurrent, onSelect, title }: {
  activeCaseId?: string;
  cases: TrainingCase[];
  currentCaseId?: string;
  onFollowCurrent: () => void;
  onSelect: (id: string) => void;
  title: string;
}) {
  const { t } = useI18n();
  const complete = cases.filter((item) => ["completed", "error"].includes(item.status)).length;
  const actions = <div className="flex items-center gap-1.5">
    {activeCaseId && activeCaseId !== currentCaseId && <button aria-label={t("experiments.returnCurrentCase")} className="grid h-5 w-5 place-items-center border border-[#c6d4d4] bg-white text-[#0c766e]" onClick={onFollowCurrent} title={t("experiments.returnCurrentCase")} type="button"><LocateFixed size={11} /></button>}
    <span className="font-mono text-[9px] text-[#60777a]">{complete} / {cases.length}</span>
  </div>;
  return <section className="grid min-h-0 grid-rows-[34px_42px_minmax(0,1fr)] border border-[#cbd8d9] bg-white" id="training-phase-detail">
    <PanelHeader actions={actions} icon={complete === cases.length && cases.length ? CheckCircle2 : LoaderCircle} title={title} />
    <div className="grid gap-1.5 border-b border-[#dce5e5] bg-[#f8faf9] px-3 py-2"><ProgressBar progress={complete} total={cases.length} /></div>
    <div className="minimal-scrollbar min-h-0 overflow-auto"><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="sticky top-0 bg-[#edf3f2] text-[#657b7f]"><tr className="h-7"><th className="w-28 px-2.5">Case</th><th className="px-2.5">Task</th><th className="w-24 px-2.5">{t("experiments.state")}</th><th className="w-14 px-2.5 text-right">Score</th></tr></thead><tbody>{cases.map((item) => {
      const active = activeCaseId === item.id;
      const selected = currentCaseId === item.id;
      return <tr aria-current={active ? "step" : undefined} aria-selected={selected} className={`h-8 cursor-pointer border-t border-[#e0e8e8] ${selected ? "bg-[#d9e9e6]" : active ? "bg-[#eef6f4]" : "hover:bg-[#f3f7f6]"}`} key={item.id} onClick={() => onSelect(item.id)}>
        <td className="truncate px-2.5"><button className="flex w-full items-center gap-1 truncate text-left font-mono font-semibold text-[#526b70] outline-none focus-visible:ring-2 focus-visible:ring-[#0c766e]" onClick={(event) => { event.stopPropagation(); onSelect(item.id); }} type="button">{active && <LoaderCircle className="shrink-0 motion-safe:animate-spin" size={10} />}<span className="truncate">{item.sampleId}</span></button></td>
        <td className="truncate px-2.5 text-[#526b70]" title={item.question}>{item.question}</td>
        <td className={`truncate px-2.5 ${item.status === "error" || item.passed === false ? "text-[#934737]" : item.status === "completed" ? "text-[#25806f]" : "text-[#60777a]"}`}>{item.status}</td>
        <td className="px-2.5 text-right font-mono text-[#60777a]">{item.score === undefined ? "-" : Math.round(item.score * 100)}</td>
      </tr>;
    })}</tbody></table></div>
  </section>;
}

function TestingCaseInspector({ caseItem }: { caseItem?: TrainingCase }) {
  const { t } = useI18n();
  if (!caseItem) return <section className="grid min-h-0 place-items-center border border-[#cbd8d9] bg-white text-[9px] text-[#718488]">{t("experiments.awaitingCase")}</section>;
  const reference = caseItem.referenceAvailable
    ? caseItem.expectedAnswer || t("experiments.referenceUnavailable")
    : t("experiments.referenceHidden");
  return <section className="grid min-h-0 grid-rows-[34px_34px_minmax(180px,1fr)_auto] border border-[#cbd8d9] bg-white" id="testing-case-inspector">
    <PanelHeader icon={ShieldCheck} metadata={caseItem.sampleId} title={t("experiments.testCaseResult")} />
    <div className={`flex items-center justify-between border-b px-3 ${caseItem.passed === false ? "border-[#e7c2b8] bg-[#fff3ef]" : "border-[#b9d8ce] bg-[#edf7f4]"}`}><span className={`text-[9px] font-semibold ${caseItem.passed === false ? "text-[#934737]" : "text-[#257368]"}`}>{caseItem.status}</span><strong className="font-mono text-[11px] text-[#29484c]">{caseItem.score === undefined ? "-" : `${Math.round(caseItem.score * 100)} / 100`}</strong></div>
    <div className="grid min-h-0 grid-cols-2 divide-x divide-[#dce5e5]"><section className="minimal-scrollbar min-h-0 overflow-auto p-3"><span className="text-[8px] font-semibold uppercase text-[#718488]">{t("experiments.initialAnswer")}</span><p className="mt-1.5 whitespace-pre-wrap text-[9px] leading-4 text-[#29484c]">{caseItem.actualAnswer || t("experiments.awaitingCase")}</p></section><section className="minimal-scrollbar min-h-0 overflow-auto bg-[#f8faf9] p-3"><span className="text-[8px] font-semibold uppercase text-[#718488]">{t("experiments.correctAnswer")}</span><p className={`mt-1.5 whitespace-pre-wrap text-[9px] leading-4 ${caseItem.referenceAvailable && caseItem.expectedAnswer ? "text-[#29484c]" : "text-[#8b9b9e]"}`}>{reference}</p><span className="mt-4 block text-[8px] font-semibold uppercase text-[#718488]">{t("experiments.failureDiagnosis")}</span><p className="mt-1.5 whitespace-pre-wrap text-[9px] leading-4 text-[#526b70]">{caseItem.rationale ?? caseItem.failure?.message ?? "-"}</p></section></div>
    <div className="grid grid-cols-2 gap-3 border-t border-[#dce5e5] bg-[#f8faf9] p-3"><ToolList label={t("experiments.expectedTools")} tools={caseItem.expectedTools} /><ToolList label={t("experiments.actualTools")} tools={caseItem.actualTools} /></div>
  </section>;
}

function LearningCaseInspector({
  busy,
  candidate,
  caseItem,
  draft,
  editing,
  onAccept,
  onDraftChange,
  onEdit,
  onPatchChange,
  onReject,
  onReplay,
  onViewChange,
  patchIndex,
  readOnly = false,
  view,
}: {
  busy: boolean;
  candidate?: ExperienceCandidate;
  caseItem?: TrainingCase;
  draft: string;
  editing: boolean;
  onAccept: () => void;
  onDraftChange: (value: string) => void;
  onEdit: () => void;
  onPatchChange: (index: number) => void;
  onReject: () => void;
  onReplay: () => void;
  onViewChange: (view: LearningView) => void;
  patchIndex: number;
  readOnly?: boolean;
  view: LearningView;
}) {
  const { t } = useI18n();
  if (!caseItem) return <section className="grid min-h-0 place-items-center border border-[#cbd8d9] bg-white text-[9px] text-[#718488]" id="training-case-learning-inspector">{t("experiments.awaitingCase")}</section>;
  const evaluated = !["queued", "running"].includes(caseItem.status);
  const patch = candidate?.patches[patchIndex];
  const tabs: Array<{ id: LearningView; icon: typeof BrainCircuit; title: string; enabled: boolean }> = [
    { id: "attempt", icon: BrainCircuit, title: t("experiments.learningStepAttempt"), enabled: true },
    { id: "evaluate", icon: BookOpenCheck, title: t("experiments.learningStepEvaluate"), enabled: evaluated },
    { id: "correct", icon: Sparkles, title: t("experiments.learningStepCorrect"), enabled: evaluated && caseItem.passed === false },
    { id: "extract", icon: FileDiff, title: t("experiments.learningStepExtract"), enabled: Boolean(candidate) },
    { id: "replay", icon: RefreshCw, title: t("experiments.learningStepReplay"), enabled: candidate?.replayPassed !== undefined },
  ];
  const body = view === "attempt" ? <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]"><div className="grid min-h-0 grid-cols-2 divide-x divide-[#dce5e5]"><section className="minimal-scrollbar min-h-0 overflow-auto p-3"><span className="text-[8px] font-semibold uppercase text-[#718488]">{t("experiments.initialAnswer")}</span><p className="mt-1.5 whitespace-pre-wrap text-[9px] leading-4 text-[#29484c]">{caseItem.actualAnswer || t("experiments.awaitingCase")}</p></section><section className="minimal-scrollbar min-h-0 overflow-auto bg-[#f8faf9] p-3"><span className="text-[8px] font-semibold uppercase text-[#718488]">{t("experiments.correctAnswer")}</span><p className={`mt-1.5 whitespace-pre-wrap text-[9px] leading-4 ${caseItem.referenceAvailable && caseItem.expectedAnswer ? "text-[#29484c]" : "text-[#8b9b9e]"}`}>{caseItem.referenceAvailable ? caseItem.expectedAnswer || t("experiments.referenceUnavailable") : t("experiments.referenceHidden")}</p></section></div><div className="grid grid-cols-2 gap-3 border-t border-[#dce5e5] bg-[#f8faf9] p-3"><ToolList label={t("experiments.expectedTools")} tools={caseItem.expectedTools} /><ToolList label={t("experiments.actualTools")} tools={caseItem.actualTools} /></div></div>
    : view === "evaluate" ? <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]"><div className={`flex items-center justify-between border-b px-3 py-2 ${caseItem.passed === false ? "border-[#e7c2b8] bg-[#fff3ef]" : "border-[#b9d8ce] bg-[#edf7f4]"}`}><span className={`flex items-center gap-1.5 text-[9px] font-semibold ${caseItem.passed === false ? "text-[#934737]" : "text-[#257368]"}`}>{caseItem.passed === false ? <AlertTriangle size={12} /> : <CheckCircle2 size={12} />}{caseItem.passed === false ? t("experiments.correctionRequired") : t("experiments.successExperienceReady")}</span><strong className="font-mono text-[11px] text-[#29484c]">{Math.round((caseItem.score ?? 0) * 100)} / 100</strong></div><div className="minimal-scrollbar min-h-0 overflow-auto divide-y divide-[#e0e8e8]"><section className="p-3"><span className="text-[8px] font-semibold uppercase text-[#718488]">{t("experiments.correctAnswer")}</span><p className="mt-1.5 text-[9px] leading-4 text-[#29484c]">{caseItem.expectedAnswer || t("experiments.referenceUnavailable")}</p></section><section className="p-3"><span className="text-[8px] font-semibold uppercase text-[#718488]">{t("experiments.failureDiagnosis")}</span><p className="mt-1.5 text-[9px] leading-4 text-[#526b70]">{caseItem.rationale ?? caseItem.failure?.message ?? "-"}</p></section></div></div>
      : view === "correct" ? <div className="minimal-scrollbar h-full overflow-auto p-3"><span className="text-[8px] font-semibold uppercase text-[#718488]">{t("experiments.correctedProcedure")}</span><pre className="mt-2 whitespace-pre-wrap border-l-2 border-[#63a89d] bg-[#f3f8f7] p-3 font-mono text-[9px] leading-4 text-[#29484c]">{candidate?.rationale ?? caseItem.thinking}</pre></div>
        : view === "extract" ? <div className="grid h-full min-h-0 grid-rows-[32px_1fr] p-3"><div className="flex items-center justify-between gap-2"><span className="truncate text-[8px] font-semibold uppercase text-[#718488]">{candidate?.summary ?? t("experiments.experienceCandidate")}</span>{candidate && candidate.patches.length > 1 && <select aria-label={t("experiments.targetVariable")} className={`${FIELD_CLASS} max-w-56`} onChange={(event) => onPatchChange(Number(event.target.value))} value={patchIndex}>{candidate.patches.map((item, index) => <option key={`${item.variableName}-${index}`} value={index}>{item.variableName}</option>)}</select>}</div>{editing ? <textarea aria-label={t("experiments.experienceCandidate")} className="minimal-scrollbar min-h-0 resize-none border border-[#0c766e] bg-white p-3 font-mono text-[9px] leading-4 text-[#29484c] outline-none ring-1 ring-[#0c766e]" onChange={(event) => onDraftChange(event.target.value)} value={draft} /> : <GitDiffPreview label={t("experiments.experienceCandidate")} value={patch?.unifiedDiff ?? ""} />}</div>
          : <div className="grid h-full min-h-0 grid-rows-[auto_1fr]"><div className={`flex items-center justify-between border-b px-3 py-2 ${candidate?.replayPassed ? "border-[#b9d8ce] bg-[#edf7f4]" : "border-[#e7c2b8] bg-[#fff3ef]"}`}><span className={`flex items-center gap-1.5 text-[9px] font-semibold ${candidate?.replayPassed ? "text-[#257368]" : "text-[#934737]"}`}>{candidate?.replayPassed ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}{candidate?.replayPassed ? t("experiments.closedBookReplayPassed") : t("experiments.correctionRequired")}</span><strong className="font-mono text-[11px] text-[#29484c]">{Math.round((candidate?.replayScore ?? 0) * 100)} / 100</strong></div><div className="minimal-scrollbar overflow-auto p-3"><span className="text-[8px] font-semibold uppercase text-[#718488]">{t("experiments.replayAnswer")}</span><p className="mt-1.5 text-[9px] leading-4 text-[#29484c]">{candidate?.replayRationale ?? "-"}</p></div></div>;
  return <section className="grid min-h-0 grid-rows-[34px_58px_minmax(190px,1fr)_42px] border border-[#cbd8d9] bg-white" id="training-case-learning-inspector"><PanelHeader actions={<span className="border border-[#c6d4d4] bg-[#edf3f2] px-1.5 py-0.5 text-[8px] font-semibold text-[#60777a]">{candidate?.status ?? t("experiments.noExperienceCandidate")}</span>} icon={BrainCircuit} metadata={caseItem.sampleId} title={t("experiments.caseLearning")} /><div aria-label={t("experiments.correctionPipeline")} className="grid grid-cols-5 border-b border-[#cbd8d9] bg-[#f8faf9]" role="tablist">{tabs.map((tab) => { const Icon = tab.icon; return <button aria-selected={view === tab.id} className={`grid min-w-0 place-items-center gap-0.5 border-r border-[#dce5e5] px-1 outline-none last:border-r-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${view === tab.id ? "bg-[#e4f1ee] text-[#0c766e]" : tab.enabled ? "text-[#60777a] hover:bg-[#edf3f2]" : "cursor-not-allowed text-[#a1afb1]"}`} disabled={!tab.enabled} key={tab.id} onClick={() => onViewChange(tab.id)} role="tab" type="button"><Icon size={12} /><span className="truncate text-[8px] font-semibold">{tab.title}</span></button>; })}</div>{body}<div className="flex items-center justify-between gap-3 border-t border-[#cbd8d9] bg-[#f8faf9] px-3"><span className="truncate font-mono text-[8px] text-[#60777a]">{patch?.variableName ?? "-"}</span>{candidate && !readOnly && !["applied", "rejected"].includes(candidate.status) && <div className="flex items-center gap-1.5"><button className="flex h-6 items-center gap-1 border border-[#c6d4d4] bg-white px-2 text-[8px] font-semibold text-[#526b70] disabled:opacity-50" disabled={busy} onClick={onReplay} type="button"><RefreshCw size={10} />{t("experiments.rerun")}</button><button className="flex h-6 items-center gap-1 border border-[#c6d4d4] bg-white px-2 text-[8px] font-semibold text-[#526b70] disabled:opacity-50" disabled={busy} onClick={onEdit} type="button"><Pencil size={10} />{editing ? t("context.save") : t("experiments.editExperience")}</button><button className="grid h-6 w-6 place-items-center border border-[#d9b2aa] bg-white text-[#934737] disabled:opacity-50" disabled={busy} onClick={onReject} title={t("experiments.rejectExperience")} type="button"><X size={10} /></button><button className="flex h-6 items-center gap-1 bg-[#0c766e] px-2 text-[8px] font-semibold text-white disabled:bg-[#8aa5a2]" disabled={busy || candidate.replayPassed !== true} onClick={onAccept} type="button"><Check size={10} />{t("experiments.acceptAndApply")}</button></div>}</div></section>;
}

function VariableInspector({ variables, selected, onSelect }: { variables: TrainingVariableView[]; selected: string; onSelect: (value: string) => void }) {
  const { t } = useI18n();
  const current = variables.find((item) => item.name === selected) ?? variables[0];
  const drifted = current && current.projectValue !== current.runValue;
  return <section className="grid min-h-0 grid-rows-[34px_124px_minmax(0,1fr)] border border-[#cbd8d9] bg-white"><PanelHeader icon={Variable} metadata={t("experiments.variableCount", { count: variables.length })} title={t("experiments.learnedVariables")} /><div className="minimal-scrollbar overflow-auto border-b border-[#cbd8d9]"><table className="w-full table-fixed border-collapse text-left text-[9px]"><thead className="sticky top-0 bg-[#edf3f2] text-[#657b7f]"><tr className="h-7"><th className="w-[52%] px-3">{t("experiments.variableName")}</th><th className="px-3 text-right">{t("experiments.sourceCases")}</th><th className="px-3">{t("experiments.state")}</th></tr></thead><tbody>{variables.map((variable) => <tr aria-selected={current?.name === variable.name} className={`h-8 border-t border-[#e0e8e8] ${current?.name === variable.name ? "bg-[#d9e9e6]" : "hover:bg-[#f3f7f6]"}`} key={variable.name}><td className="truncate px-3"><button className="w-full truncate text-left font-mono font-semibold text-[#29484c]" onClick={() => onSelect(variable.name)} type="button">{variable.name}</button></td><td className="px-3 text-right font-mono text-[#60777a]">{variable.sourceCaseIds.length}</td><td className="truncate px-3 text-[#60777a]">{variable.state}</td></tr>)}{variables.length === 0 && <tr><td className="h-14 px-3 text-center text-[#8b9b9e]" colSpan={3}>{t("experiments.noProjectVariables")}</td></tr>}</tbody></table></div><div className="grid min-h-0 grid-rows-[34px_minmax(172px,1fr)_106px]"><PanelHeader metadata={current?.name ?? "-"} title={t("experiments.projectVariableInspection")} /><div className="grid min-h-0 grid-cols-2 divide-x divide-[#cbd8d9]"><section className="grid min-h-0 grid-rows-[28px_1fr]"><h3 className="bg-[#f3f7f6] px-3 py-2 text-[9px] font-semibold text-[#657b7f]">{t("experiments.beforeTraining")}</h3><pre className="minimal-scrollbar min-h-0 overflow-auto whitespace-pre-wrap p-3 font-mono text-[9px] leading-4 text-[#526b70]">{current?.baselineValue ?? "-"}</pre></section><section className="grid min-h-0 grid-rows-[28px_1fr]"><h3 className="bg-[#edf7f4] px-3 py-2 text-[9px] font-semibold text-[#257368]">{t("experiments.afterTraining")}</h3><pre className="minimal-scrollbar min-h-0 overflow-auto whitespace-pre-wrap border-l-2 border-[#63a89d] p-3 font-mono text-[9px] leading-4 text-[#29484c]">{current?.runValue ?? "-"}</pre></section></div><div className="grid place-items-center border-t border-[#cbd8d9] bg-[#f8faf9] px-3 text-center text-[8px] text-[#718488]">{drifted ? t("experiments.projectVariableDrifted") : current?.snapshotValue !== undefined ? t("experiments.snapshotVariableValue") : t("experiments.liveProjectVariableValue")}</div></div></section>;
}

export default function ExperimentTrainingWorkspace({ projectPath, onAnalyzeRun }: { projectPath: string; onAnalyzeRun: (id: string) => void }) {
  const { t } = useI18n();
  const historyStorageKey = `capybara-training-view:${projectPath}`;
  const [activePhase, setActivePhase] = useState<PhaseId>("training");
  const [busy, setBusy] = useState(false);
  const [cases, setCases] = useState<TrainingCase[]>([]);
  const [correctionHook, setCorrectionHook] = useState("");
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [experiences, setExperiences] = useState<ExperienceCandidate[]>([]);
  const [extractorHook, setExtractorHook] = useState("");
  const [historyRuns, setHistoryRuns] = useState<TrainingRun[]>([]);
  const [hooks, setHooks] = useState<HookOption[]>([]);
  const [learningMode, setLearningMode] = useState<TrainingLearningMode>("review");
  const [learningView, setLearningView] = useState<LearningView>("attempt");
  const [patchIndex, setPatchIndex] = useState(0);
  const [reviewScope, setReviewScope] = useState<TrainingReviewScope>("failed");
  const [run, setRun] = useState<TrainingRun>();
  const [runName, setRunName] = useState("");
  const [inspectedCaseId, setInspectedCaseId] = useState("");
  const [selectedVariable, setSelectedVariable] = useState("");
  const [stopOnFailure, setStopOnFailure] = useState(true);
  const [testDatasetId, setTestDatasetId] = useState("");
  const [trainDatasetId, setTrainDatasetId] = useState("");
  const [variableSource, setVariableSource] = useState<TrainingVariableSource>("project");
  const [variableSourceRunId, setVariableSourceRunId] = useState("");
  const [variables, setVariables] = useState<TrainingVariableView[]>([]);
  const followingCurrentRef = useRef(true);
  const followingPhaseRef = useRef(true);

  const loadRun = useCallback(async (runId: string, options: { caseId?: string; followCurrent?: boolean; phase?: PhaseId; resetInspection?: boolean } = {}) => {
    const [nextRun, nextCases, nextExperiences, nextVariables] = await Promise.all([
      experimentApi.training.get(projectPath, runId),
      experimentApi.training.cases(projectPath, runId),
      experimentApi.training.experiences(projectPath, runId),
      experimentApi.training.variables(projectPath, runId),
    ]);
    setRun(nextRun);
    setCases(nextCases.items);
    setExperiences(nextExperiences.items);
    setVariables(nextVariables.items);
    setHistoryRuns((current) => [nextRun, ...current.filter((item) => item.id !== nextRun.id)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)));
    const nextPhase: PhaseId = options.phase
      ?? (["ready_to_freeze", "ready_for_test"].includes(nextRun.status)
        ? "freeze"
        : ["testing", "completed"].includes(nextRun.status) && nextRun.snapshotId
          ? "testing"
          : "training");
    const firstPhaseCase = nextCases.items.find((item) => item.phase === (nextPhase === "testing" ? "testing" : "training"));
    const requestedCase = options.caseId && nextCases.items.some((item) => item.id === options.caseId) ? options.caseId : undefined;
    if (options.resetInspection) {
      followingPhaseRef.current = options.phase === undefined;
      const shouldFollow = options.followCurrent ?? !requestedCase;
      followingCurrentRef.current = shouldFollow;
      setInspectedCaseId(requestedCase ?? nextRun.currentCaseId ?? firstPhaseCase?.id ?? "");
    } else {
      setInspectedCaseId((current) => {
        if (followingCurrentRef.current && nextRun.currentCaseId) return nextRun.currentCaseId;
        return nextCases.items.some((item) => item.id === current)
          ? current
          : nextRun.currentCaseId ?? firstPhaseCase?.id ?? "";
      });
    }
    if (options.resetInspection || followingPhaseRef.current) setActivePhase(nextPhase);
    return nextRun;
  }, [projectPath]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [datasetResult, capability, runs] = await Promise.all([
          datasetApi.list(projectPath),
          experimentApi.training.capabilities(projectPath),
          experimentApi.training.list(projectPath, 50),
        ]);
        if (!active) return;
        setDatasets(datasetResult.items);
        setHooks(capability.hooks);
        setHistoryRuns(runs.items);
        const sourceRuns = runs.items.filter((item) => ["ready_to_freeze", "ready_for_test", "completed"].includes(item.status));
        setVariableSourceRunId(sourceRuns[0]?.id ?? "");
        const train = datasetResult.items.find((item) => item.tags.includes("train")) ?? datasetResult.items[0];
        const test = datasetResult.items.find((item) => item.tags.includes("test_normal")) ?? datasetResult.items.find((item) => item.id !== train?.id);
        setTrainDatasetId(train?.id ?? "");
        setTestDatasetId(test?.id ?? "");
        setRunName(suggestedTrainingName(datasetResult.items, train?.id ?? "", test?.id ?? ""));
        const evaluators = capability.hooks.filter((hook) => hook.checkpoint === "after_evaluation");
        setCorrectionHook(evaluators.find((hook) => hook.id.includes("correction"))?.id ?? "");
        setExtractorHook(evaluators.find((hook) => hook.id.includes("experience"))?.id ?? evaluators[0]?.id ?? "");
        const query = new URL(window.location.href).searchParams;
        let saved: { runId?: string; phase?: PhaseId; caseId?: string } = {};
        try { saved = JSON.parse(window.localStorage.getItem(historyStorageKey) ?? "{}"); } catch { saved = {}; }
        const requestedRunId = query.get("trainingRun") ?? saved.runId ?? "";
        let target = runs.items.find((item) => item.id === requestedRunId);
        if (requestedRunId && !target) {
          try { target = await experimentApi.training.get(projectPath, requestedRunId); } catch { target = undefined; }
        }
        target ??= runs.items.find((item) => ACTIVE_RUN_STATUSES.has(item.status)) ?? runs.items[0];
        if (!target || !active) return;
        const phase = query.get("trainingPhase") ?? saved.phase;
        await loadRun(target.id, {
          caseId: requestedRunId === target.id ? query.get("trainingCase") ?? saved.caseId : undefined,
          followCurrent: !(requestedRunId === target.id && (query.get("trainingCase") ?? saved.caseId)),
          phase: phase === "training" || phase === "freeze" || phase === "testing" ? phase : undefined,
          resetInspection: true,
        });
      } catch (value) {
        if (active) setError(value instanceof Error ? value.message : String(value));
      }
    })();
    return () => { active = false; };
  }, [historyStorageKey, loadRun, projectPath]);

  useEffect(() => {
    if (!run || ["completed", "failed", "cancelled", "ready_to_freeze", "ready_for_test", "waiting_review", "paused", "paused_failure"].includes(run.status)) return;
    const timer = window.setTimeout(() => void loadRun(run.id).catch((value: unknown) => setError(value instanceof Error ? value.message : String(value))), 1000);
    return () => window.clearTimeout(timer);
  }, [loadRun, run]);

  useEffect(() => {
    if (!run) return;
    const url = new URL(window.location.href);
    url.searchParams.set("trainingRun", run.id);
    url.searchParams.set("trainingPhase", activePhase);
    if (inspectedCaseId) url.searchParams.set("trainingCase", inspectedCaseId);
    else url.searchParams.delete("trainingCase");
    window.history.replaceState(window.history.state, "", url);
    window.localStorage.setItem(historyStorageKey, JSON.stringify({ runId: run.id, phase: activePhase, caseId: inspectedCaseId }));
  }, [activePhase, historyStorageKey, inspectedCaseId, run]);

  const trainingCases = cases.filter((item) => item.phase === "training");
  const testingCases = cases.filter((item) => item.phase === "testing");
  const currentCase = cases.find((item) => item.id === inspectedCaseId)
    ?? (activePhase === "testing" ? testingCases[0] : trainingCases[0]);
  const candidates = experiences.filter((item) => item.sourceCaseId === currentCase?.id);
  const candidate = candidates[0];
  const currentPatch = candidate?.patches[patchIndex];

  const action = async (task: () => Promise<unknown>) => {
    if (!run) return;
    setBusy(true);
    setError("");
    try { await task(); await loadRun(run.id); } catch (value) { setError(value instanceof Error ? value.message : String(value)); } finally { setBusy(false); }
  };

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await experimentApi.training.create(projectPath, {
        name: runName.trim(),
        trainDatasetId,
        testDatasetId,
        trainLimit: TRAIN_LIMIT,
        testLimit: TEST_LIMIT,
        learningMode,
        reviewScope,
        pauseOnFailure: stopOnFailure,
        variableSource,
        ...(variableSource === "run" ? { variableSourceRunId } : {}),
        ...(correctionHook ? { correctionHook: { hookId: correctionHook, parameters: {} } } : {}),
        experienceExtractorHook: { hookId: extractorHook, parameters: { noveltyThreshold: "0.25", maxCandidateTokens: "600" } },
      });
      setCases([]);
      setExperiences([]);
      setVariables([]);
      followingCurrentRef.current = true;
      setInspectedCaseId("");
      setActivePhase("training");
      await loadRun(next.id, { followCurrent: true, phase: "training", resetInspection: true });
    } catch (value) { setError(value instanceof Error ? value.message : String(value)); } finally { setBusy(false); }
  };

  const persistDraft = async () => {
    if (!run || !candidate || !currentPatch) return;
    const patches = candidate.patches.map((patch, index): VariableDiff => index === patchIndex ? { ...patch, unifiedDiff: draft } : patch);
    await experimentApi.training.updateExperience(projectPath, run.id, candidate.id, patches);
    setEditing(false);
  };
  const saveDraft = () => action(persistDraft);

  const inspectCase = (id: string) => {
    followingCurrentRef.current = false;
    setInspectedCaseId(id);
    setLearningView("attempt");
    setPatchIndex(0);
    setEditing(false);
  };
  const followCurrentCase = () => {
    if (!run?.currentCaseId) return;
    followingCurrentRef.current = true;
    followingPhaseRef.current = true;
    setInspectedCaseId(run.currentCaseId);
    setActivePhase(cases.find((item) => item.id === run.currentCaseId)?.phase === "testing" ? "testing" : "training");
    setLearningView("attempt");
  };
  const inspectPhase = (phase: PhaseId) => {
    followingPhaseRef.current = false;
    setActivePhase(phase);
    const phaseCase = cases.find((item) => item.phase === (phase === "testing" ? "testing" : "training"));
    if (phaseCase && !cases.some((item) => item.id === inspectedCaseId && item.phase === phaseCase.phase)) inspectCase(phaseCase.id);
  };
  const showNewTraining = () => {
    setRun(undefined);
    setCases([]);
    setExperiences([]);
    setVariables([]);
    setInspectedCaseId("");
    setActivePhase("training");
    setRunName(suggestedTrainingName(datasets, trainDatasetId, testDatasetId));
    setVariableSource("project");
    const url = new URL(window.location.href);
    url.searchParams.delete("trainingRun");
    url.searchParams.delete("trainingPhase");
    url.searchParams.delete("trainingCase");
    window.history.replaceState(window.history.state, "", url);
    window.localStorage.removeItem(historyStorageKey);
  };
  const changeTrainDataset = (value: string) => {
    const previousSuggestion = suggestedTrainingName(datasets, trainDatasetId, testDatasetId);
    setTrainDatasetId(value);
    setRunName((current) => !current.trim() || current === previousSuggestion
      ? suggestedTrainingName(datasets, value, testDatasetId)
      : current);
  };
  const changeTestDataset = (value: string) => {
    const previousSuggestion = suggestedTrainingName(datasets, trainDatasetId, testDatasetId);
    setTestDatasetId(value);
    setRunName((current) => !current.trim() || current === previousSuggestion
      ? suggestedTrainingName(datasets, trainDatasetId, value)
      : current);
  };
  const openHistoryRun = async (id: string) => {
    if (!id) { showNewTraining(); return; }
    setBusy(true);
    setError("");
    try {
      await loadRun(id, { followCurrent: true, resetInspection: true });
    } catch (value) {
      setError(value instanceof Error ? value.message : String(value));
    } finally {
      setBusy(false);
    }
  };

  const primary = !run
     ? { label: t("experiments.startTraining"), icon: Play, onClick: start, disabled: !runName.trim() || !trainDatasetId || !testDatasetId || !extractorHook || (variableSource === "run" && !variableSourceRunId) }
    : ["completed", "cancelled"].includes(run.status)
      ? { label: t("experiments.historyReadOnly"), icon: History, onClick: () => undefined, disabled: true }
    : run.status === "failed"
      ? { label: t("experiments.retryFailedCase"), icon: RotateCcw, onClick: () => action(() => experimentApi.training.retry(projectPath, run.id)), disabled: false }
    : ["queued", "running", "testing"].includes(run.status)
      ? { label: t("experiments.pauseRun"), icon: Pause, onClick: () => action(() => experimentApi.training.pause(projectPath, run.id)), disabled: false }
      : ["paused", "paused_failure"].includes(run.status)
        ? { label: t("experiments.resumeRun"), icon: Play, onClick: () => action(() => experimentApi.training.resume(projectPath, run.id)), disabled: false }
        : run.status === "ready_to_freeze"
          ? { label: t("experiments.freezeSnapshot"), icon: LockKeyhole, onClick: () => action(() => experimentApi.training.freeze(projectPath, run.id)), disabled: false }
          : run.status === "ready_for_test"
            ? { label: t("experiments.startTesting"), icon: Play, onClick: () => action(() => experimentApi.training.startTest(projectPath, run.id)), disabled: false }
            : { label: t("experiments.awaitingApproval"), icon: BookOpenCheck, onClick: () => undefined, disabled: true };
  const PrimaryIcon = primary.icon;
  const frozen = Boolean(run?.snapshotId);
  const phaseEnabled = (phase: PhaseId) => phase === "training" || (phase === "freeze" && Boolean(run && (run.progress.training.completed === run.progress.training.total || frozen))) || (phase === "testing" && frozen);
  const phases = [
    { id: "training" as const, icon: BrainCircuit, title: t("experiments.trainingPhase"), count: `${run?.progress.training.completed ?? 0} / ${run?.progress.training.total ?? TRAIN_LIMIT}`, access: t("experiments.writeEnabled"), tone: "write" as const },
    { id: "freeze" as const, icon: LockKeyhole, title: t("experiments.freezePhase"), count: frozen ? run?.snapshotId?.slice(0, 8) : run?.status === "ready_to_freeze" ? t("experiments.awaitingApproval") : t("experiments.locked"), access: t("experiments.versionedSnapshot"), tone: "frozen" as const },
    { id: "testing" as const, icon: ShieldCheck, title: t("experiments.testingPhase"), count: `${run?.progress.testing.completed ?? 0} / ${run?.progress.testing.total ?? TEST_LIMIT}`, access: t("experiments.readOnly"), tone: "read" as const },
  ];
  const trainScores = trainingCases.filter((item) => item.score !== undefined);
  const testScores = testingCases.filter((item) => item.score !== undefined);
  const average = (items: TrainingCase[]) => items.length ? Math.round(items.reduce((sum, item) => sum + (item.score ?? 0), 0) / items.length * 100) : 0;
  const tokens = cases.reduce((sum, item) => sum + item.usage.totalTokens, 0);
  const projectName = projectPath.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "project";
  const activeRun = historyRuns.find((item) => ACTIVE_RUN_STATUSES.has(item.status));
  const sourceRuns = historyRuns.filter((item) => ["ready_to_freeze", "ready_for_test", "completed"].includes(item.status));

  return <section className="grid h-full min-h-0 grid-rows-[56px_82px_minmax(0,1fr)] bg-[#edf3f2]" data-interactive-preview="false" id="experiment-training-workspace">
    <PanelHeader actions={<div className="flex min-w-0 items-center gap-2">
      {error && <span className="max-w-52 truncate border border-[#e2b6ad] bg-[#fff1ed] px-2 py-1 text-[8px] font-semibold text-[#934737]" title={error}>{error}</span>}
      <label className="flex h-7 min-w-0 items-center gap-1 border border-[#c6d4d4] bg-white px-1.5 text-[#60777a]" title={t("experiments.trainingHistory")}><History size={11} /><select aria-label={t("experiments.trainingHistory")} className="h-6 max-w-56 min-w-32 bg-transparent font-mono text-[8px] outline-none" disabled={busy} onChange={(event) => void openHistoryRun(event.target.value)} value={run?.id ?? ""}><option value="">{t("experiments.newTraining")}</option>{historyRuns.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.status} · {item.name}</option>)}</select></label>
      {activeRun && run?.id !== activeRun.id && <button aria-label={t("experiments.returnActiveRun")} className="grid h-7 w-7 shrink-0 place-items-center border border-[#8fc8bd] bg-[#e8f5f1] text-[#0c766e]" onClick={() => void openHistoryRun(activeRun.id)} title={t("experiments.returnActiveRun")} type="button"><LocateFixed size={12} /></button>}
      <span className="border border-[#c6d4d4] bg-[#f3f7f6] px-2 py-1 font-mono text-[8px] font-semibold uppercase text-[#60777a]">{run?.status ?? t("experiments.statusReady")}</span>
       {run && <button aria-label={t("experiments.viewTrainingAnalysis")} className="grid h-7 w-7 shrink-0 place-items-center border border-[#8fc8bd] bg-[#e8f5f1] text-[#0c766e]" disabled={busy} onClick={() => onAnalyzeRun(run.id)} title={t("experiments.viewTrainingAnalysis")} type="button"><LineChart size={13} /></button>}
       {run && ["ready_to_freeze", "ready_for_test", "completed"].includes(run.status) && <button aria-label={t("experiments.promoteVariables")} className="grid h-7 w-7 shrink-0 place-items-center border border-[#d7bd8d] bg-[#fff7e8] text-[#76551f]" disabled={busy} onClick={() => action(() => experimentApi.training.promote(projectPath, run.id))} title={t("experiments.promoteVariables")} type="button"><GitCommitHorizontal size={13} /></button>}
      {run && <button aria-label={t("experiments.newTraining")} className="grid h-7 w-7 shrink-0 place-items-center border border-[#c6d4d4] bg-white text-[#60777a]" disabled={busy} onClick={showNewTraining} title={t("experiments.newTraining")} type="button"><Plus size={13} /></button>}
      <button className="flex h-7 shrink-0 items-center gap-1.5 bg-[#0c766e] px-2.5 text-[10px] font-semibold text-white outline-none hover:bg-[#095f59] focus-visible:ring-2 focus-visible:ring-[#59b4aa] disabled:cursor-not-allowed disabled:bg-[#8aa5a2]" disabled={busy || primary.disabled} onClick={primary.onClick} type="button"><PrimaryIcon className={busy ? "motion-safe:animate-spin" : ""} size={12} />{primary.label}</button>
    </div>} metadata={`${projectName} · ${run?.name ?? t("experiments.newTraining")}`} title={t("experiments.trainingValidation")} variant="workspace" />
    <div aria-label={t("experiments.learningPipeline")} className="grid grid-cols-[1fr_24px_1fr_24px_1fr] border-b border-[#b9c7ca] bg-white" role="tablist">{phases.map((phase, index) => { const Icon = phase.icon; const enabled = phaseEnabled(phase.id); return <div className="contents" key={phase.id}><button aria-controls="training-phase-detail" aria-selected={activePhase === phase.id} className={`relative grid min-w-0 grid-cols-[28px_minmax(0,1fr)] items-center gap-2 px-3 text-left outline-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${activePhase === phase.id ? "bg-[#f3f8f7] after:bg-[#0c766e]" : enabled ? "hover:bg-[#f6f9f8]" : "cursor-not-allowed opacity-50"}`} disabled={!enabled} id={`experiment-training-phase-${phase.id}`} onClick={() => inspectPhase(phase.id)} role="tab" type="button"><span className={`grid h-7 w-7 place-items-center border ${activePhase === phase.id ? "border-[#8fc8bd] bg-[#e8f5f1] text-[#0c766e]" : "border-[#cbd8d9] bg-[#edf3f2] text-[#60777a]"}`}><Icon size={14} /></span><span className="min-w-0"><span className="flex items-center gap-2"><strong className="truncate text-[10px] text-[#29484c]">{phase.title}</strong><AccessBadge tone={phase.tone}>{phase.access}</AccessBadge></span><span className="mt-1 block truncate font-mono text-[8px] text-[#718488]">{phase.count}</span></span></button>{index < phases.length - 1 && <span className="grid place-items-center border-x border-[#e0e8e8] bg-[#edf3f2] text-[#7c9194]"><ArrowRight size={12} /></span>}</div>; })}</div>
    <div className="minimal-scrollbar min-h-0 overflow-auto p-3">
       <div className="mx-auto grid min-h-[560px] max-w-[1180px] grid-cols-[minmax(270px,0.72fr)_minmax(500px,1.28fr)] gap-3">
         <div className="grid min-h-0 grid-rows-[minmax(460px,auto)_minmax(420px,1fr)] gap-3">
          {activePhase === "training" && !run
             ? <RunDefinition datasets={datasets} disabled={busy} name={runName} onNameChange={setRunName} onTestDatasetChange={changeTestDataset} onTrainDatasetChange={changeTrainDataset} onVariableSourceChange={(value) => { setVariableSource(value); if (value === "run" && !variableSourceRunId) setVariableSourceRunId(sourceRuns[0]?.id ?? ""); }} onVariableSourceRunChange={setVariableSourceRunId} sourceRuns={sourceRuns} testDatasetId={testDatasetId} trainDatasetId={trainDatasetId} variableSource={variableSource} variableSourceRunId={variableSourceRunId} />
            : activePhase === "training"
              ? <CaseQueue activeCaseId={run?.currentCaseId} cases={trainingCases} currentCaseId={inspectedCaseId} onFollowCurrent={followCurrentCase} onSelect={inspectCase} title={t("experiments.trainingQueue")} />
              : activePhase === "testing"
                ? <CaseQueue activeCaseId={run?.currentCaseId} cases={testingCases} currentCaseId={inspectedCaseId} onFollowCurrent={followCurrentCase} onSelect={inspectCase} title={t("experiments.testingQueue")} />
                : <section className="grid min-h-0 grid-rows-[34px_1fr] border border-[#cbd8d9] bg-white"><PanelHeader icon={LockKeyhole} metadata={run?.snapshotId?.slice(0, 8) ?? "-"} title={t("experiments.snapshotCandidate")} /><div className="grid place-items-center p-6 text-center text-[9px] leading-4 text-[#60777a]">{frozen ? t("experiments.snapshotFrozen") : t("experiments.snapshotReviewHint")}</div></section>}
          <LearningStrategy correctionHook={correctionHook} disabled={Boolean(run)} extractorHook={extractorHook} hooks={hooks} learningMode={learningMode} onCorrectionHookChange={setCorrectionHook} onExtractorHookChange={setExtractorHook} onLearningModeChange={setLearningMode} onReviewScopeChange={setReviewScope} onStopOnFailureChange={setStopOnFailure} reviewScope={reviewScope} stopOnFailure={stopOnFailure} />
        </div>
        <div className={`grid min-h-0 gap-3 ${activePhase === "training" ? "grid-rows-[minmax(360px,1.12fr)_minmax(300px,0.88fr)]" : activePhase === "testing" ? "grid-rows-[minmax(320px,1fr)_minmax(300px,1fr)]" : "grid-rows-1"}`}>
          {activePhase === "training" && <LearningCaseInspector busy={busy} candidate={candidate} caseItem={currentCase} draft={draft} editing={editing} onAccept={() => candidate && run && action(() => experimentApi.training.acceptExperience(projectPath, run.id, candidate.id))} onDraftChange={setDraft} onEdit={() => { if (editing) void saveDraft(); else { setDraft(currentPatch?.unifiedDiff ?? ""); setEditing(true); } }} onPatchChange={(index) => { setPatchIndex(index); setDraft(candidate?.patches[index]?.unifiedDiff ?? ""); setEditing(false); }} onReject={() => candidate && run && action(() => experimentApi.training.rejectExperience(projectPath, run.id, candidate.id))} onReplay={() => candidate && run && action(async () => { if (editing) await persistDraft(); return experimentApi.training.replayExperience(projectPath, run.id, candidate.id); })} onViewChange={setLearningView} patchIndex={patchIndex} view={learningView} />}
          {activePhase === "testing" && <TestingCaseInspector caseItem={currentCase?.phase === "testing" ? currentCase : testingCases[0]} />}
          <VariableInspector onSelect={setSelectedVariable} selected={selectedVariable} variables={variables} />
          <div className="col-span-full grid grid-cols-4 border border-[#cbd8d9] bg-[#f8faf9]"><Metric detail={t("experiments.casesCompleted")} label={t("experiments.trainingResult")} value={`${run?.progress.training.completed ?? 0} / ${run?.progress.training.total ?? TRAIN_LIMIT}`} /><Metric detail={`${experiences.filter((item) => item.status === "applied").length} applied`} label={t("experiments.knowledgeChanges")} value={`${average(trainScores)}%`} /><Metric detail={t("experiments.answerAccuracy")} label={t("experiments.testingResult")} value={`${average(testScores)}%`} /><Metric detail="agent + scoring + replay" label="Tokens" value={tokens.toLocaleString()} /></div>
        </div>
      </div>
    </div>
  </section>;
}
