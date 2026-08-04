"use client";

import {
  Circle,
  Eye,
  Pause,
  Play,
  RotateCcw,
  Square,
  StepForward,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import type {
  ExecutionMode,
  JsonValue,
  RunState,
  RuntimeArtifactMeta,
  RuntimeBreakpoint,
  RuntimeCheckpointMeta,
  RuntimeContextRevision,
  RuntimeEffectiveContextRevision,
  RuntimeWorkflowsState,
  TimelineStep,
} from "../runtime-protocol";
import CodeSurface from "./code-surface";
import RuntimeWorkflowPanel from "./runtime-workflow-panel";
import { WorkspaceTabs, type WorkspaceTab } from "./workspace-ui";

type DetailTab = "overview" | "input" | "output" | "context" | "diff" | "raw";
type DebugView = "trace" | "plan";

type Props = {
  artifactContents: Record<string, JsonValue>;
  artifacts: RuntimeArtifactMeta[];
  breakpoints: RuntimeBreakpoint[];
  checkpoints: RuntimeCheckpointMeta[];
  contexts: RuntimeContextRevision[];
  effectiveContexts: RuntimeEffectiveContextRevision[];
  run: RunState;
  timeline: TimelineStep[];
  workflows: RuntimeWorkflowsState;
  onExecutionModeChange: (mode: ExecutionMode) => void;
  onGetArtifact: (artifactId: string) => void;
  onInterrupt: () => void;
  onPause: () => void;
  onPrimaryAction: () => void;
  onRemoveBreakpoint: (breakpointId: string) => void;
  onRestartStep: (stepId?: string, confirmSideEffects?: boolean) => void;
  onRestoreCheckpoint: (checkpointId: string) => void;
  onRestorePrevious: () => void;
  onUpsertBreakpoint: (breakpoint: RuntimeBreakpoint) => void;
};

function ActionButton({
  action,
  disabled = false,
  icon: Icon,
  label,
  onClick,
  pressed,
  tone = "default",
}: {
  action: string;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  tone?: "default" | "danger";
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={`flex h-8 w-8 shrink-0 items-center justify-center outline-none transition-colors hover:bg-[#dfecea] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-not-allowed disabled:text-[#a3b0b2] disabled:hover:bg-transparent ${
        pressed
          ? "bg-[#d8e9e6] text-[#164f4a] shadow-[inset_0_-2px_0_#0c766e]"
          : tone === "danger" ? "text-[#9b4141]" : "text-[#31575c]"
      }`}
      data-active={pressed ? "true" : "false"}
      data-debug-action={action}
      disabled={disabled}
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon aria-hidden="true" size={15} strokeWidth={1.8} />
    </button>
  );
}

function stepColor(step: TimelineStep) {
  if (step.status === "error" || step.status === "interrupted") return "bg-[#9b4141]";
  if (step.status === "running") return "bg-[#c58a27]";
  if (step.status === "pending") return "bg-[#93a4a7]";
  return step.type === "model"
    ? "bg-[#25806f]"
    : step.type === "tool"
      ? "bg-[#c58a27]"
      : step.type === "workflow"
        ? "bg-[#416f9a]"
        : "bg-[#347f91]";
}

function formatTime(timestamp?: string) {
  if (!timestamp) return "--:--:--.---";
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function detailString(step: TimelineStep, key: string) {
  const value = step.detail?.[key];
  return typeof value === "string" ? value : undefined;
}

export default function DebugControlPanel(props: Props) {
  const {
    artifactContents,
    artifacts,
    breakpoints,
    checkpoints,
    contexts,
    effectiveContexts,
    run,
    timeline,
    workflows,
    onExecutionModeChange,
    onGetArtifact,
    onInterrupt,
    onPause,
    onPrimaryAction,
    onRemoveBreakpoint,
    onRestartStep,
    onRestoreCheckpoint,
    onRestorePrevious,
    onUpsertBreakpoint,
  } = props;
  const { t } = useI18n();
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>("overview");
  const [debugView, setDebugView] = useState<DebugView>("trace");
  const selectedStep = timeline.find((step) => step.id === selectedStepId) ?? null;
  const active = ["running", "waiting", "pause_requested", "interrupting"].includes(run.status);
  const canPause = run.status === "running" || run.status === "waiting";
  const canInterrupt = ["running", "waiting", "pause_requested", "paused"].includes(run.status);
  const canRestore = !active && checkpoints.length > 1;
  const debugTabs: WorkspaceTab<DebugView>[] = [
    { id: "trace", label: t("workflow.trace"), controls: "controls-timeline-panel" },
    { id: "plan", label: t("workflow.plan"), controls: "controls-workflow-panel" },
  ];

  const context = selectedStep
    ? contexts.find((item) => item.id === detailString(selectedStep, "contextRevisionId"))
    : undefined;
  const effectiveContext = selectedStep
    ? effectiveContexts.find(
        (item) => item.id === detailString(selectedStep, "effectiveContextRevisionId"),
      )
    : undefined;
  const artifactId = selectedStep
    ? detailTab === "input" && (selectedStep.type === "model" || selectedStep.type === "workflow")
      ? detailString(selectedStep, selectedStep.type === "workflow" ? "definitionArtifactId" : "requestArtifactId")
      : detailTab === "output"
        ? detailString(selectedStep, selectedStep.type === "tool" || selectedStep.type === "workflow" ? "resultArtifactId" : "responseArtifactId")
        : detailTab === "context"
          ? effectiveContext?.messagesArtifactId ?? context?.messagesArtifactId
        : detailTab === "diff"
            ? effectiveContext?.diffArtifactId ?? context?.diffArtifactId
            : detailTab === "raw" && selectedStep.type === "workflow"
              ? detailString(selectedStep, "definitionArtifactId")
              : undefined
    : undefined;

  useEffect(() => {
    if (artifactId && !(artifactId in artifactContents)) onGetArtifact(artifactId);
  }, [artifactContents, artifactId, onGetArtifact]);

  const detailValue = useMemo((): JsonValue => {
    if (!selectedStep) return null;
    if (artifactId) return artifactContents[artifactId] ?? t("debug.loadingArtifact");
    if (detailTab === "input" && selectedStep.type === "tool") {
      return {
        arguments: selectedStep.detail?.arguments ?? null,
        inputSchema: selectedStep.detail?.inputSchema ?? null,
        permissions: selectedStep.detail?.permissions ?? [],
      };
    }
    if (detailTab === "overview") {
      return {
        id: selectedStep.id,
        status: selectedStep.status,
        summary: selectedStep.summary,
        durationMs: selectedStep.durationMs ?? null,
        contextRevisionId: detailString(selectedStep, "contextRevisionId") ?? null,
        beforeCheckpointId: detailString(selectedStep, "beforeCheckpointId") ?? null,
        afterCheckpointId: detailString(selectedStep, "afterCheckpointId") ?? null,
        error: selectedStep.detail?.error ?? null,
        failure: run.failure?.stepId === selectedStep.id ? { ...run.failure } : null,
      };
    }
    return selectedStep as unknown as JsonValue;
  }, [artifactContents, artifactId, detailTab, run.failure, selectedStep, t]);

  const stepKindLabel = (kind: TimelineStep["type"]) =>
    t(`timeline.type.${kind}` as Parameters<typeof t>[0]);

  const handleExecutionModeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, mode: ExecutionMode) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextMode = mode === "step" ? "continuous" : "step";
    onExecutionModeChange(nextMode);
    document.getElementById(`debug-mode-${nextMode}`)?.focus();
  };

  const toggleBreakpoint = (step: TimelineStep, position: "before" | "after") => {
    const existing = breakpoints.find((item) => item.stepId === step.id && item.position === position);
    if (existing) onRemoveBreakpoint(existing.id);
    else onUpsertBreakpoint({
      id: `breakpoint-${position}-${step.id}`,
      enabled: true,
      position,
      stepId: step.id,
    });
  };

  const restart = (step: TimelineStep) => {
    const replay = detailString(step, "replay");
    const needsConfirmation = step.type === "tool" && replay !== "safe";
    if (needsConfirmation && !window.confirm(t("debug.confirmReplay"))) return;
    onRestartStep(step.id, needsConfirmation);
  };

  const nextModel = selectedStep?.type === "tool"
    ? timeline.find((step) => step.index > selectedStep.index && step.type === "model")
    : undefined;

  return (
    <section
      aria-label={t("panel.controls")}
    className="relative grid min-h-0 grid-rows-[44px_34px_1fr] overflow-hidden bg-[#fafbf8]"
      id="controls-panel"
    >
      <div aria-label={t("debug.toolbar")} className="flex min-h-11 items-center border-b border-[#cbd8d9] bg-white px-2" role="toolbar">
        <div aria-label={t("debug.mode")} className="mr-2 flex h-7 border border-[#c5d4d3] bg-[#f2f6f5] p-0.5" role="radiogroup">
          {(["step", "continuous"] as const).map((mode) => {
            const selected = run.mode === mode;
            return (
              <button
                aria-checked={selected}
                className={`h-[22px] px-2 text-[10px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:opacity-50 ${selected ? "bg-[#d8e9e6] text-[#164f4a]" : "text-[#64787c] hover:bg-[#e3edeb]"}`}
                disabled={active}
                id={`debug-mode-${mode}`}
                key={mode}
                onClick={() => onExecutionModeChange(mode)}
                onKeyDown={(event) => handleExecutionModeKeyDown(event, mode)}
                role="radio"
                tabIndex={selected ? 0 : -1}
                type="button"
              >
                {mode === "step" ? t("debug.modeStep") : t("debug.modeContinuous")}
              </button>
            );
          })}
        </div>
        <ActionButton action={run.mode === "step" ? "next-step" : "run-continuous"} disabled={active} icon={run.mode === "step" ? StepForward : Play} label={run.mode === "step" ? t("debug.nextStep") : t("debug.startContinuous")} onClick={onPrimaryAction} />
        <ActionButton action="pause" disabled={!canPause} icon={Pause} label={t("debug.pause")} onClick={onPause} pressed={run.status === "pause_requested" || run.status === "paused"} />
        <ActionButton action="interrupt" disabled={!canInterrupt} icon={Square} label={t("debug.interrupt")} onClick={onInterrupt} tone="danger" />
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-[#d5dfdf]" />
        <ActionButton action="restore-previous" disabled={!canRestore} icon={Undo2} label={t("debug.restorePrevious")} onClick={onRestorePrevious} />
        {run.status === "failed" && run.failure ? (
          <button
            className="ml-auto min-w-0 truncate px-1 text-[9px] font-semibold uppercase text-[#9b4141] outline-none hover:bg-[#f7e7e7] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#9b4141]"
            data-run-status={run.status}
            onClick={() => {
              setSelectedStepId(run.failure?.stepId ?? null);
              setDetailTab("overview");
            }}
            title={`${run.failure.code}: ${run.failure.message}`}
            type="button"
          >
            {t("debug.status.failed")} · {t(`debug.failure.phase.${run.failure.phase}` as Parameters<typeof t>[0])}
          </button>
        ) : (
          <span className="ml-auto truncate px-1 text-[9px] font-medium uppercase text-[#667d81]" data-run-status={run.status}>{t(`debug.status.${run.status}` as Parameters<typeof t>[0])}</span>
        )}
      </div>

      <WorkspaceTabs
        activeTab={debugView}
        ariaLabel={t("workflow.debugViews")}
        idPrefix="debug-workflow"
        onChange={setDebugView}
        tabs={debugTabs}
      />

      {debugView === "trace" ? <div aria-label={t("controls.timeline")} className="minimal-scrollbar min-h-0 overflow-auto" id="controls-timeline-panel">
        <table className="w-full table-fixed border-collapse text-left text-[11px]">
          <caption className="sr-only">{t("controls.timeline")}</caption>
          <thead className="sticky top-0 z-[1] bg-[#eef3f2] text-[10px] text-[#657a7e]">
            <tr>
              <th className="w-[82px] border-b border-[#cbd8d9] px-2 py-2 font-semibold">{t("timeline.startTime")}</th>
              <th className="w-[52px] border-b border-[#cbd8d9] px-1 py-2 font-semibold">{t("timeline.duration")}</th>
              <th className="border-b border-[#cbd8d9] px-1.5 py-2 font-semibold">{t("timeline.stepType")}</th>
              <th className="w-[72px] border-b border-[#cbd8d9] px-1 py-2 text-center font-semibold">{t("timeline.debug")}</th>
            </tr>
          </thead>
          <tbody className="text-[#2e494e]">
            {timeline.map((step) => {
              const toolName = step.type === "tool" || step.type === "workflow" ? detailString(step, "toolName") : undefined;
              const label = `${stepKindLabel(step.type)}${toolName ? ` · ${toolName}` : ""}`;
              const isCurrent = step.id === run.currentStepId;
              const before = breakpoints.some((item) => item.stepId === step.id && item.position === "before");
              const after = breakpoints.some((item) => item.stepId === step.id && item.position === "after");
              return (
                <tr aria-current={isCurrent ? "step" : undefined} className={isCurrent ? "bg-[#e7f0ee]" : "hover:bg-[#e7f0ee]"} key={step.id} title={step.status === "error" && step.detail?.error ? JSON.stringify(step.detail.error) : undefined}>
                  <td className="truncate border-b border-[#dfe7e7] px-2 py-2 font-mono text-[9px] text-[#506a6f]">{formatTime(step.startedAt)}</td>
                  <td className="truncate border-b border-[#dfe7e7] px-1 py-2 font-mono text-[9px] text-[#70858a]">{step.durationMs === undefined ? "--" : `${step.durationMs} ms`}</td>
                  <td className="border-b border-[#dfe7e7] px-1.5 py-2"><span className="flex min-w-0 items-center gap-1.5"><span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${stepColor(step)}`} /><span className="truncate">{label}</span></span></td>
                  <td className="border-b border-[#dfe7e7] px-1 py-1"><span className="flex justify-center">
                    {(["before", "after"] as const).map((position) => {
                      const set = position === "before" ? before : after;
                      return <button aria-label={t(`debug.breakpoint.${position}` as Parameters<typeof t>[0])} className={`flex h-7 w-5 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${set ? "text-[#b43e3e]" : "text-[#9aa9ab] hover:text-[#b43e3e]"}`} key={position} onClick={() => toggleBreakpoint(step, position)} title={t(`debug.breakpoint.${position}` as Parameters<typeof t>[0])} type="button"><Circle aria-hidden="true" fill={set ? "currentColor" : "none"} size={10} /></button>;
                    })}
                    <button aria-label={t("timeline.viewDetail", { step: label })} className="flex h-7 w-7 items-center justify-center text-[#557176] outline-none hover:bg-[#d9e8e5] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]" onClick={() => { setSelectedStepId(step.id); setDetailTab("overview"); }} title={t("timeline.viewDetail", { step: label })} type="button"><Eye aria-hidden="true" size={14} /></button>
                  </span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div> : <div className="min-h-0" id="controls-workflow-panel"><RuntimeWorkflowPanel
        onSelectStep={(stepId) => {
          setSelectedStepId(stepId);
          setDetailTab("overview");
        }}
        timeline={timeline}
        workflows={workflows}
      /></div>}

      {selectedStep && (
        <div className="absolute inset-x-0 bottom-0 z-10 grid h-[76%] grid-rows-[34px_30px_1fr_36px] border-t border-[#8eaaa9] bg-[#f8fbfa] shadow-[0_-8px_20px_rgba(23,45,51,0.08)]">
          <div className="flex min-w-0 items-center justify-between border-b border-[#d8e2e2] px-2.5">
            <span className="truncate text-[11px] font-semibold text-[#28484d]">{stepKindLabel(selectedStep.type)} · {selectedStep.summary}</span>
            <button aria-label={t("timeline.closeDetail")} className="flex h-7 w-7 items-center justify-center text-[#60777b] hover:bg-[#e1ecea]" onClick={() => setSelectedStepId(null)} type="button"><X aria-hidden="true" size={15} /></button>
          </div>
          <div className="minimal-scrollbar flex overflow-x-auto border-b border-[#d8e2e2] bg-white px-1" role="tablist">
            {(["overview", "input", "output", "context", "diff", "raw"] as const).map((tab) => <button aria-selected={detailTab === tab} className={`h-[29px] shrink-0 px-2 text-[9px] font-medium ${detailTab === tab ? "border-b-2 border-[#0c766e] text-[#165b55]" : "text-[#6b8084] hover:bg-[#eef4f3]"}`} key={tab} onClick={() => setDetailTab(tab)} role="tab" type="button">{t(`debug.detail.${tab}` as Parameters<typeof t>[0])}</button>)}
          </div>
          <CodeSurface ariaLabel={t("timeline.stepDetail")} language="JSON" lineWrapping readOnly value={JSON.stringify(detailValue, null, 2)} />
          <div className="flex items-center gap-1 border-t border-[#d8e2e2] px-2">
            <button className="flex h-7 items-center gap-1 px-2 text-[10px] text-[#31575c] hover:bg-[#e1ecea] disabled:text-[#a3b0b2]" disabled={active || !detailString(selectedStep, "beforeCheckpointId")} onClick={() => restart(selectedStep)} type="button"><RotateCcw size={13} />{t("debug.restartStep")}</button>
            {nextModel && <button className="h-7 px-2 text-[10px] text-[#31575c] hover:bg-[#e1ecea]" onClick={() => { setSelectedStepId(nextModel.id); setDetailTab("input"); }} type="button">{t("debug.nextModelRequest")}</button>}
            <select aria-label={t("debug.restoreCheckpoint")} className="ml-auto h-7 max-w-[130px] border border-[#c5d4d3] bg-white px-1 text-[9px] text-[#506a6f]" disabled={active} onChange={(event) => event.target.value && onRestoreCheckpoint(event.target.value)} value="">
              <option value="">{t("debug.restoreCheckpoint")}</option>
              {checkpoints.map((checkpoint, index) => <option key={checkpoint.id} value={checkpoint.id}>#{index} · step {checkpoint.currentStep}</option>)}
            </select>
          </div>
          {artifactId && <span className="sr-only">{artifacts.find((item) => item.id === artifactId)?.label}</span>}
        </div>
      )}
    </section>
  );
}
