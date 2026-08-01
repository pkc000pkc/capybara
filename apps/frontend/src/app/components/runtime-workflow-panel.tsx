"use client";

import { Filter, GitBranch, Repeat2, Wrench } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../i18n";
import type {
  RuntimeWorkflowNode,
  RuntimeWorkflowPlan,
  RuntimeWorkflowsState,
  TimelineStep,
} from "../runtime-protocol";

function statusColor(status: RuntimeWorkflowNode["status"] | RuntimeWorkflowPlan["status"]) {
  if (status === "failed" || status === "cancelled") return "bg-[#a84343]";
  if (status === "running" || status === "validating") return "bg-[#c58a27]";
  if (status === "completed") return "bg-[#25806f]";
  if (status === "skipped") return "bg-[#75878a]";
  return "bg-[#a2afb1]";
}

function NodeIcon({ node }: { node: RuntimeWorkflowNode }) {
  if (node.type === "filter") return <Filter aria-hidden="true" size={12} />;
  if (node.type === "foreach") return <Repeat2 aria-hidden="true" size={12} />;
  return <Wrench aria-hidden="true" size={12} />;
}

export default function RuntimeWorkflowPanel({
  onSelectStep,
  timeline,
  workflows,
}: {
  onSelectStep: (stepId: string) => void;
  timeline: TimelineStep[];
  workflows: RuntimeWorkflowsState;
}) {
  const { t } = useI18n();
  const [selectedPlanId, setSelectedPlanId] = useState<string | undefined>(workflows.activePlanId);
  const selected = workflows.items.find((item) => item.id === selectedPlanId)
    ?? workflows.items.at(-1);

  if (!selected) {
    return (
      <div className="grid h-full place-items-center px-5 text-center text-[10px] leading-5 text-[#718488]">
        {t("workflow.empty")}
      </div>
    );
  }

  const planStep = timeline.find((step) =>
    step.detail?.workflowPlanId === selected.id && step.detail?.workflowNodeType === "plan");

  return (
    <div className="grid h-full min-h-0 grid-rows-[34px_auto_1fr] bg-[#fafbf9]">
      <div className="flex items-center gap-2 border-b border-[#d8e2e2] bg-white px-2">
        <GitBranch aria-hidden="true" className="text-[#486b70]" size={13} />
        <select
          aria-label={t("workflow.planRevision")}
          className="h-6 min-w-0 flex-1 border border-[#c8d5d5] bg-white px-1.5 font-mono text-[9px] text-[#405f64]"
          onChange={(event) => setSelectedPlanId(event.target.value)}
          value={selected.id}
        >
          {workflows.items.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {t("workflow.revision", { value: plan.revision })} · {plan.status}
            </option>
          ))}
        </select>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[8px] uppercase text-[#677c80]">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${statusColor(selected.status)}`} />
          {selected.status}
        </span>
      </div>
      <button
        className="grid min-w-0 gap-1 border-b border-[#d8e2e2] bg-[#f4f8f7] px-2.5 py-2 text-left outline-none hover:bg-[#e8f0ef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-default"
        disabled={!planStep}
        onClick={() => planStep && onSelectStep(planStep.id)}
        type="button"
      >
        <span className="truncate text-[10px] font-semibold text-[#29484c]">{selected.goal}</span>
        <span className="flex items-center justify-between gap-2 font-mono text-[8px] text-[#718488]">
          <span>{t("workflow.runtimeOnly")}</span>
          <span>{selected.nodes.length} {t("workflow.nodes")}</span>
        </span>
      </button>
      <div className="minimal-scrollbar min-h-0 overflow-y-auto">
        {selected.nodes.map((node) => (
          <button
            className="grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-1.5 border-b border-[#e0e8e8] py-2 pr-2 text-left outline-none hover:bg-[#e9f1ef] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e] disabled:cursor-default"
            disabled={!node.timelineStepId}
            key={node.id}
            onClick={() => node.timelineStepId && onSelectStep(node.timelineStepId)}
            style={{ paddingLeft: node.parentId ? 22 : 10 }}
            type="button"
          >
            <span className="text-[#587176]"><NodeIcon node={node} /></span>
            <span className="min-w-0">
              <span className="block truncate font-mono text-[9px] font-semibold text-[#31545a]">{node.id}</span>
              <span className="block truncate text-[8px] text-[#718488]">{node.toolName ?? node.type}</span>
            </span>
            <span className="flex items-center gap-1 font-mono text-[8px] text-[#657b7f]">
              <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${statusColor(node.status)}`} />
              {node.status}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
