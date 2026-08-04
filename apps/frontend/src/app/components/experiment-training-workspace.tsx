"use client";

import {
  ArrowRight,
  BrainCircuit,
  CheckCircle2,
  Database,
  GitCommitHorizontal,
  LockKeyhole,
  Play,
  ShieldCheck,
  Variable,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { PanelHeader } from "./workspace-ui";

type PhaseId = "training" | "freeze" | "testing";
type VariableId = "operation-patterns" | "failure-guardrails" | "tool-routing";

const FIELD_CLASS = "h-7 w-full border border-[#c6d4d4] bg-white px-2 font-mono text-[9px] text-[#294247] outline-none focus:border-[#0c766e] focus:ring-1 focus:ring-[#0c766e]";

function AccessBadge({ tone, children }: { tone: "write" | "frozen" | "read"; children: ReactNode }) {
  const styles = tone === "write"
    ? "border-[#8fc8bd] bg-[#e8f5f1] text-[#17665d]"
    : tone === "frozen"
      ? "border-[#d7bd8d] bg-[#fff7e8] text-[#76551f]"
      : "border-[#aebfc4] bg-[#edf3f4] text-[#48636a]";
  return <span className={`inline-flex h-5 items-center border px-1.5 font-mono text-[8px] font-semibold uppercase ${styles}`}>{children}</span>;
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 border-r border-[#dce5e5] px-3 py-2 last:border-r-0">
      <div className="truncate text-[8px] font-semibold uppercase text-[#718488]">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-semibold text-[#29484c]">{value}</div>
      <div className="mt-0.5 truncate text-[8px] text-[#718488]">{detail}</div>
    </div>
  );
}

export default function ExperimentTrainingWorkspace({ projectPath }: { projectPath: string }) {
  const { t } = useI18n();
  const [activePhase, setActivePhase] = useState<PhaseId>("training");
  const [selectedVariable, setSelectedVariable] = useState<VariableId>("operation-patterns");
  const projectName = projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? t("experiments.currentProject");

  const phases: Array<{
    id: PhaseId;
    icon: typeof BrainCircuit;
    title: string;
    count: string;
    access: string;
    tone: "write" | "frozen" | "read";
    description: string;
  }> = [
    {
      id: "training",
      icon: BrainCircuit,
      title: t("experiments.trainingPhase"),
      count: t("experiments.caseCount", { count: 20 }),
      access: t("experiments.writeEnabled"),
      tone: "write",
      description: t("experiments.trainingPhaseDescription"),
    },
    {
      id: "freeze",
      icon: LockKeyhole,
      title: t("experiments.freezePhase"),
      count: "knowledge@r7",
      access: t("experiments.versionedSnapshot"),
      tone: "frozen",
      description: t("experiments.freezePhaseDescription"),
    },
    {
      id: "testing",
      icon: ShieldCheck,
      title: t("experiments.testingPhase"),
      count: t("experiments.caseCount", { count: 10 }),
      access: t("experiments.readOnly"),
      tone: "read",
      description: t("experiments.testingPhaseDescription"),
    },
  ];

  const variables: Array<{
    id: VariableId;
    name: string;
    sources: number;
    revision: string;
    tokens: string;
    before: string;
    after: string;
  }> = [
    {
      id: "operation-patterns",
      name: "appworld.operation_patterns",
      sources: 14,
      revision: "r7",
      tokens: "3.8k",
      before: t("experiments.operationPatternsBefore"),
      after: t("experiments.operationPatternsAfter"),
    },
    {
      id: "failure-guardrails",
      name: "appworld.failure_guardrails",
      sources: 6,
      revision: "r7",
      tokens: "1.4k",
      before: t("experiments.failureGuardrailsBefore"),
      after: t("experiments.failureGuardrailsAfter"),
    },
    {
      id: "tool-routing",
      name: "appworld.tool_routing",
      sources: 11,
      revision: "r7",
      tokens: "2.1k",
      before: t("experiments.toolRoutingBefore"),
      after: t("experiments.toolRoutingAfter"),
    },
  ];
  const currentPhase = phases.find((phase) => phase.id === activePhase) ?? phases[0];
  const currentVariable = variables.find((variable) => variable.id === selectedVariable) ?? variables[0];

  return (
    <section
      className="grid h-full min-h-0 grid-rows-[56px_82px_minmax(0,1fr)] bg-[#edf3f2]"
      data-static-preview="true"
      id="experiment-training-workspace"
    >
      <PanelHeader
        actions={(
          <div className="flex items-center gap-2">
            <span className="border border-[#c6d4d4] bg-[#f3f7f6] px-2 py-1 font-mono text-[8px] font-semibold uppercase text-[#60777a]">
              {t("experiments.staticPreview")}
            </span>
            <button
              className="flex h-7 cursor-not-allowed items-center gap-1.5 bg-[#8aa5a2] px-2.5 text-[10px] font-semibold text-white"
              disabled
              title={t("experiments.backendPending")}
              type="button"
            >
              <Play aria-hidden="true" fill="currentColor" size={12} />
              {t("experiments.startTraining")}
            </button>
          </div>
        )}
        metadata={`${projectName} · AppWorld · ${t("experiments.controlledLearningCycle")}`}
        title={t("experiments.trainingValidation")}
        variant="workspace"
      />

      <div aria-label={t("experiments.learningPipeline")} className="grid grid-cols-[1fr_24px_1fr_24px_1fr] border-b border-[#b9c7ca] bg-white" role="tablist">
        {phases.map((phase, index) => {
          const Icon = phase.icon;
          const selected = phase.id === activePhase;
          return (
            <div className="contents" key={phase.id}>
              <button
                aria-controls="training-phase-detail"
                aria-selected={selected}
                className={`relative grid min-w-0 grid-cols-[28px_minmax(0,1fr)] items-center gap-2 px-3 text-left outline-none after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] ${selected ? "bg-[#f3f8f7] after:bg-[#0c766e]" : "after:bg-transparent hover:bg-[#f6f9f8]"}`}
                id={`experiment-training-phase-${phase.id}`}
                onClick={() => setActivePhase(phase.id)}
                role="tab"
                type="button"
              >
                <span className={`grid h-7 w-7 place-items-center border ${selected ? "border-[#8fc8bd] bg-[#dff1ed] text-[#0c766e]" : "border-[#cbd8d9] bg-[#edf3f2] text-[#60777a]"}`}>
                  <Icon aria-hidden="true" size={14} />
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <strong className="truncate text-[10px] text-[#29484c]">{phase.title}</strong>
                    <AccessBadge tone={phase.tone}>{phase.access}</AccessBadge>
                  </span>
                  <span className="mt-1 block truncate font-mono text-[8px] text-[#718488]">{phase.count}</span>
                </span>
              </button>
              {index < phases.length - 1 && (
                <span aria-hidden="true" className="grid place-items-center border-x border-[#e0e8e8] bg-[#edf3f2] text-[#7c9194]">
                  <ArrowRight size={12} />
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="minimal-scrollbar min-h-0 overflow-auto p-3">
        <div className="mx-auto grid min-h-[560px] max-w-[1180px] grid-cols-[minmax(270px,0.72fr)_minmax(500px,1.28fr)] gap-3">
          <div className="grid min-h-0 grid-rows-[minmax(286px,1fr)_minmax(212px,0.72fr)] gap-3">
            <section className="grid min-h-0 grid-rows-[34px_50px_1fr] border border-[#cbd8d9] bg-white" id="training-phase-detail">
              <PanelHeader icon={Database} title={t("experiments.runDefinition")} />
              <div className="border-b border-[#dce5e5] bg-[#f8faf9] px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[9px] font-semibold text-[#29484c]">{currentPhase.title}</span>
                  <AccessBadge tone={currentPhase.tone}>{currentPhase.access}</AccessBadge>
                </div>
                <p className="mt-1 text-[8px] leading-4 text-[#718488]">{currentPhase.description}</p>
              </div>
              <div className="grid content-start gap-3 p-3">
                <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">
                  {t("experiments.datasetName")}
                  <select className={FIELD_CLASS} defaultValue="appworld-1">
                    <option value="appworld-1">AppWorld 1.0 · QTA</option>
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">
                    {t("experiments.trainingSplit")}
                    <select className={FIELD_CLASS} defaultValue="train"><option value="train">train</option></select>
                  </label>
                  <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">
                    {t("experiments.testingSplit")}
                    <select className={FIELD_CLASS} defaultValue="test"><option value="test">test</option></select>
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">
                    {t("experiments.trainingLimit")}
                    <input className={FIELD_CLASS} readOnly type="number" value={20} />
                  </label>
                  <label className="grid gap-1 text-[9px] font-semibold text-[#60777a]">
                    {t("experiments.testingLimit")}
                    <input className={FIELD_CLASS} readOnly type="number" value={10} />
                  </label>
                </div>
                <div className="flex items-center gap-2 border-t border-[#e0e8e8] pt-3 font-mono text-[8px] text-[#60777a]">
                  <GitCommitHorizontal aria-hidden="true" size={12} />
                  <span>main@8f7c2a1</span>
                  <span className="text-[#9aabad]">/</span>
                  <span>gpt-5.2 · responses</span>
                </div>
              </div>
            </section>

            <section className="grid min-h-0 grid-rows-[34px_1fr] border border-[#cbd8d9] bg-white">
              <PanelHeader icon={ShieldCheck} title={t("experiments.learningBoundaries")} />
              <div className="divide-y divide-[#e0e8e8] text-[9px]">
                <div className="grid grid-cols-[112px_1fr] gap-3 px-3 py-2.5"><span className="text-[#718488]">{t("experiments.updateTarget")}</span><strong className="font-mono font-semibold text-[#29484c]">builtin.prompts.appworld.*</strong></div>
                <div className="grid grid-cols-[112px_1fr] gap-3 px-3 py-2.5"><span className="text-[#718488]">{t("experiments.writeCoordination")}</span><strong className="text-[#29484c]">{t("experiments.serializedQueue")}</strong></div>
                <div className="grid grid-cols-[112px_1fr] gap-3 px-3 py-2.5"><span className="text-[#718488]">{t("experiments.testingAccess")}</span><strong className="text-[#29484c]">knowledge@r7 · {t("experiments.readOnly")}</strong></div>
                <div className="grid grid-cols-[112px_1fr] gap-3 px-3 py-2.5"><span className="text-[#718488]">{t("experiments.leakageGuard")}</span><strong className="flex items-center gap-1 text-[#25806f]"><CheckCircle2 aria-hidden="true" size={11} />{t("experiments.trainTestIsolated")}</strong></div>
              </div>
            </section>
          </div>

          <section className="grid min-h-0 grid-rows-[34px_124px_minmax(0,1fr)] border border-[#cbd8d9] bg-white">
            <PanelHeader icon={Variable} metadata={t("experiments.variableCount", { count: variables.length })} title={t("experiments.learnedVariables")} />
            <div className="minimal-scrollbar overflow-auto border-b border-[#cbd8d9]">
              <table className="w-full table-fixed border-collapse text-left text-[9px]">
                <thead className="sticky top-0 bg-[#edf3f2] text-[#657b7f]">
                  <tr className="h-7"><th className="w-[42%] px-3">{t("experiments.variableName")}</th><th className="px-3 text-right">{t("experiments.sourceCases")}</th><th className="px-3">{t("experiments.revision")}</th><th className="px-3 text-right">Tokens</th><th className="px-3">{t("experiments.state")}</th></tr>
                </thead>
                <tbody>
                  {variables.map((variable) => (
                    <tr
                      aria-selected={selectedVariable === variable.id}
                      className={`h-8 cursor-pointer border-t border-[#e0e8e8] ${selectedVariable === variable.id ? "bg-[#d9e9e6]" : "hover:bg-[#f3f7f6]"}`}
                      key={variable.id}
                      onClick={() => setSelectedVariable(variable.id)}
                    >
                      <td className="truncate px-3 font-mono font-semibold text-[#29484c]">{variable.name}</td>
                      <td className="px-3 text-right font-mono text-[#60777a]">{variable.sources}</td>
                      <td className="px-3 font-mono text-[#60777a]">{variable.revision}</td>
                      <td className="px-3 text-right font-mono text-[#60777a]">{variable.tokens}</td>
                      <td className="px-3"><span className="text-[#25806f]">{t("experiments.ready")}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid min-h-0 grid-rows-[34px_minmax(172px,1fr)_106px]">
              <PanelHeader metadata={`${currentVariable.name} · ${currentVariable.revision}`} title={t("experiments.snapshotInspection")} />
              <div className="grid min-h-0 grid-cols-2 divide-x divide-[#cbd8d9]">
                <section className="grid min-h-0 grid-rows-[28px_1fr]">
                  <h3 className="flex items-center justify-between bg-[#f3f7f6] px-3 text-[9px] font-semibold text-[#657b7f]"><span>{t("experiments.beforeTraining")}</span><span className="font-mono font-normal">r6</span></h3>
                  <pre className="minimal-scrollbar min-h-0 overflow-auto whitespace-pre-wrap p-3 font-mono text-[9px] leading-4 text-[#526b70]">{currentVariable.before}</pre>
                </section>
                <section className="grid min-h-0 grid-rows-[28px_1fr]">
                  <h3 className="flex items-center justify-between bg-[#edf7f4] px-3 text-[9px] font-semibold text-[#257368]"><span>{t("experiments.frozenRevision")}</span><span className="font-mono font-normal">r7</span></h3>
                  <pre className="minimal-scrollbar min-h-0 overflow-auto whitespace-pre-wrap border-l-2 border-[#63a89d] p-3 font-mono text-[9px] leading-4 text-[#29484c]">{currentVariable.after}</pre>
                </section>
              </div>
              <div className="grid grid-cols-4 border-t border-[#cbd8d9] bg-[#f8faf9]">
                <Metric label={t("experiments.trainingResult")} value="20 / 20" detail={t("experiments.casesCompleted")} />
                <Metric label={t("experiments.knowledgeChanges")} value="+17" detail={t("experiments.learnedRules")} />
                <Metric label={t("experiments.testingResult")} value="7 / 10" detail={t("experiments.answerAccuracy")} />
                <Metric label={t("experiments.testWrites")} value="0" detail={t("experiments.snapshotUnchanged")} />
              </div>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
