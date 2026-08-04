"use client";

import {
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Database,
  FlaskConical,
} from "lucide-react";
import { useState } from "react";
import { useI18n } from "../i18n";
import DatasetWorkspace from "./dataset-workspace";
import ExperimentRunAnalysis from "./experiment-run-analysis";
import ExperimentTrainingWorkspace from "./experiment-training-workspace";
import { WorkspaceNavigation } from "./workspace-ui";

const EXPERIMENT_SECTIONS = [
  { id: "datasets", icon: Database },
  { id: "training", icon: BrainCircuit },
  { id: "runs", icon: FlaskConical },
] as const;

type ExperimentSection = (typeof EXPERIMENT_SECTIONS)[number]["id"];

function ExperimentNavigation({
  activeSection,
  collapsed,
  onCollapsedChange,
  onSelect,
}: {
  activeSection: ExperimentSection;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  onSelect: (section: ExperimentSection) => void;
}) {
  const { t } = useI18n();
  const label = (section: ExperimentSection) => {
    if (section === "datasets") return t("experiments.datasets");
    if (section === "training") return t("experiments.trainingValidation");
    return t("experiments.runAnalysis");
  };

  return (
    <WorkspaceNavigation
      activeItem={activeSection}
      ariaLabel={t("experiments.navigation")}
      bordered
      collapsed={collapsed}
      headerAction={(
        <button
          aria-expanded={!collapsed}
          aria-label={collapsed ? t("experiments.expandNavigation") : t("experiments.collapseNavigation")}
          className="flex h-7 w-7 shrink-0 items-center justify-center text-[#60777a] outline-none hover:bg-[#dce8e6] hover:text-[#29484c] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
          onClick={() => onCollapsedChange(!collapsed)}
          title={collapsed ? t("experiments.expandNavigation") : t("experiments.collapseNavigation")}
          type="button"
        >
          {collapsed ? <ChevronRight aria-hidden="true" size={15} /> : <ChevronLeft aria-hidden="true" size={15} />}
        </button>
      )}
      id="experiment-navigation"
      items={EXPERIMENT_SECTIONS.map(({ id, icon }) => ({
        controls: `experiment-${id}-panel`,
        icon,
        id,
        label: label(id),
        tabId: `experiment-${id}-tab`,
      }))}
      onChange={onSelect}
      title={t("navigation.experiments")}
    />
  );
}

export default function ExperimentsWorkspace({ projectPath }: { projectPath: string }) {
  const [activeSection, setActiveSection] = useState<ExperimentSection>("datasets");
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className="experiment-shell grid h-full min-h-[520px] min-w-[760px] overflow-hidden bg-[#dce5e7] transition-[grid-template-columns] duration-150 motion-reduce:transition-none"
      data-experiment-section={activeSection}
      data-navigation-collapsed={collapsed ? "true" : "false"}
      style={{ gridTemplateColumns: collapsed ? "48px minmax(0, 1fr)" : "168px minmax(0, 1fr)" }}
    >
      <ExperimentNavigation
        activeSection={activeSection}
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        onSelect={setActiveSection}
      />
      <div
        aria-labelledby={`experiment-${activeSection}-tab`}
        className="min-h-0 min-w-0"
        id={`experiment-${activeSection}-panel`}
        role="tabpanel"
      >
        {activeSection === "datasets" && <DatasetWorkspace projectPath={projectPath} />}
        {activeSection === "training" && <ExperimentTrainingWorkspace projectPath={projectPath} />}
        {activeSection === "runs" && <ExperimentRunAnalysis projectPath={projectPath} />}
      </div>
    </div>
  );
}
