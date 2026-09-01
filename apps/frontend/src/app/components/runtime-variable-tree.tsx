"use client";

import { useI18n } from "../i18n";
import type { RuntimeVariablePath } from "../runtime-context";
import type {
  RuntimePluginView,
  RuntimeVariableOwner,
} from "../runtime-plugin-view";
import type { JsonValue } from "../runtime-protocol";

type VariableValueProps = {
  name: string;
  owner: RuntimeVariableOwner;
  type: string;
  value: string;
  path: RuntimeVariablePath;
  kind?: "string" | "json";
  depth?: number;
  onInspect: (
    path: RuntimeVariablePath,
    name: string,
    value: string,
    kind: "string" | "json",
    owner: RuntimeVariableOwner,
  ) => void;
};

export type RuntimeVariableOwnerFilter = "all" | RuntimeVariableOwner;

function jsonPointer(path: RuntimeVariablePath): string {
  return `/${path.map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function valueType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "Array";
  if (typeof value === "object") return "Object";
  return typeof value;
}

export function matchesVariableFilter(
  name: string,
  value: JsonValue,
  path: RuntimeVariablePath,
  query: string,
  ownerFilter: RuntimeVariableOwnerFilter,
  resolveOwner: (path: RuntimeVariablePath) => RuntimeVariableOwner,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  const searchableValue = value === null || typeof value !== "object"
    ? String(value)
    : "";
  const matchesQuery = !normalizedQuery || `${name} ${searchableValue}`
    .toLowerCase()
    .includes(normalizedQuery);
  const matchesOwner = ownerFilter === "all" || resolveOwner(path) === ownerFilter;
  if (matchesQuery && matchesOwner) return true;
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => matchesVariableFilter(
    Array.isArray(value) ? `[${key}]` : key,
    child,
    [...path, key],
    query,
    ownerFilter,
    resolveOwner,
  ));
}

export function VariableNode({
  name,
  value,
  path,
  depth,
  onInspect,
  ownerFilter,
  query,
  resolveOwner,
}: {
  name: string;
  value: JsonValue;
  path: RuntimeVariablePath;
  depth: number;
  onInspect: VariableValueProps["onInspect"];
  ownerFilter: RuntimeVariableOwnerFilter;
  query: string;
  resolveOwner: (path: RuntimeVariablePath) => RuntimeVariableOwner;
}) {
  const owner = resolveOwner(path);
  if (value !== null && typeof value === "object") {
    const allEntries = Object.entries(value);
    const filtering = Boolean(query.trim()) || ownerFilter !== "all";
    const entries = filtering
      ? allEntries.filter(([key, child]) => matchesVariableFilter(
          Array.isArray(value) ? `[${key}]` : key,
          child,
          [...path, key],
          query,
          ownerFilter,
          resolveOwner,
        ))
      : allEntries;
    return (
      <details open={filtering || depth < 2}>
        <summary
          className="flex min-h-7 cursor-pointer select-none items-center gap-2 border-b border-[#dfe7e7] pr-2 text-xs text-[#28454a] outline-none hover:bg-[#e3efed] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
          data-variable-path={jsonPointer(path)}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <span>{name}</span>
          <span className="truncate font-mono text-[11px] text-[#72868a]">
            {valueType(value)} {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
          </span>
          <VariableOwnerBadge owner={owner} />
        </summary>
        {entries.map(([key, child]) => (
          <VariableNode
            depth={depth + 1}
            key={key}
            name={Array.isArray(value) ? `[${key}]` : key}
            onInspect={onInspect}
            ownerFilter={ownerFilter}
            path={[...path, key]}
            query={query}
            resolveOwner={resolveOwner}
            value={child}
          />
        ))}
      </details>
    );
  }

  return (
    <VariableValue
      depth={depth}
      kind={typeof value === "string" ? "string" : "json"}
      name={name}
      onInspect={onInspect}
      owner={owner}
      path={path}
      type={valueType(value)}
      value={typeof value === "string" ? value : JSON.stringify(value)}
    />
  );
}

export function VariableOwnerBadge({ owner }: { owner: RuntimeVariableOwner }) {
  const { t } = useI18n();
  const label = owner === "system" || owner === "capybara-system"
    ? t("inspector.ownerSystem")
    : owner === "project"
      ? t("inspector.ownerProject")
      : owner;
  return (
    <span
      className="ml-auto flex w-[84px] shrink-0 items-center gap-1 border-l border-[#c7d7d5] pl-1.5 font-mono text-[8px] text-[#587176]"
      title={t("inspector.registeredBy", { owner: label })}
    >
      <span aria-hidden="true" className="h-1 w-1 shrink-0 bg-[#4a8b82]" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function RuntimePluginsSection({ plugins }: { plugins: RuntimePluginView[] }) {
  const { t } = useI18n();
  return (
    <section aria-labelledby="runtime-plugins-heading" className="border-b border-[#bdcecd] bg-[#e7f0ee]">
      <div className="flex min-h-7 items-center justify-between gap-2 px-2.5">
        <h3 className="text-[10px] font-semibold uppercase text-[#526c70]" id="runtime-plugins-heading">
          {t("inspector.enabledPlugins")}
        </h3>
        <span className="font-mono text-[9px] text-[#718488]">{plugins.length}</span>
      </div>
      {plugins.length > 0 ? (
        <div className="border-t border-[#cfdddc] bg-[#f4f8f7]" data-runtime-plugins>
          {plugins.map((plugin) => (
            <details
              className="group border-b border-[#d8e3e2] bg-white last:border-b-0"
              data-plugin-id={plugin.id}
              key={plugin.id}
            >
              <summary className="grid min-h-11 cursor-pointer grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2 px-3 outline-none hover:bg-[#edf4f2] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]">
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 ${plugin.status === "active" ? "bg-[#25806f]" : plugin.status === "disabled" ? "bg-[#9aa9aa]" : "bg-[#9b4141]"}`}
                />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-[10px] font-semibold text-[#29484c]">
                    {plugin.id}
                  </span>
                  <span className="mt-0.5 block truncate text-[8px] text-[#667b7f]">
                    {t("plugins.summary", {
                      variables: plugin.variableKeys.length,
                      tools: plugin.toolDependencies.length,
                      harnesses: plugin.harnessIds.length,
                      hooks: plugin.hookIds.length + plugin.trainingHookIds.length,
                    })}
                  </span>
                </span>
                <span className={plugin.status === "active"
                  ? "text-[8px] font-semibold text-[#17634f]"
                  : plugin.status === "disabled"
                    ? "text-[8px] font-semibold text-[#718488]"
                    : "text-[8px] font-semibold text-[#9b4141]"}
                >
                  {t(plugin.status === "active"
                    ? "plugins.enabled"
                    : plugin.status === "disabled"
                      ? "plugins.disabled"
                      : "plugins.attention")}
                </span>
              </summary>
              <div className="border-t border-[#e0e8e8] bg-[#f8faf9]">
                <div className="min-h-7 px-3 text-[8px] font-semibold uppercase leading-7 text-[#6b7e82]">
                  {t("plugins.requiredTools")}
                </div>
                {plugin.toolDependencies.length > 0 ? plugin.toolDependencies.map((dependency) => (
                  <div
                    className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t border-[#e0e8e8] px-3 py-1.5"
                    data-tool-dependency={dependency.package}
                    key={dependency.package}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono text-[9px] font-semibold text-[#29484c]">
                        {dependency.package}
                      </span>
                      <span className="block truncate text-[8px] text-[#718488]">
                        {t("plugins.toolVersionRequirement", {
                          requested: dependency.requestedVersion,
                          installed: dependency.installedVersion ?? "-",
                        })}
                      </span>
                    </span>
                    <span className={dependency.status === "installed"
                      ? "text-[8px] font-semibold text-[#17634f]"
                      : "text-[8px] font-semibold text-[#9b4141]"}
                    >
                      {t(`plugins.toolStatus.${dependency.status}`)}
                    </span>
                  </div>
                )) : (
                  <div className="border-t border-[#e0e8e8] px-3 py-2 text-[9px] text-[#718488]">
                    {t("plugins.noToolDependencies")}
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className="border-t border-[#cfdddc] px-3 py-2 text-[9px] text-[#718488]" data-runtime-plugins-empty>
          {t("inspector.noEnabledPlugins")}
        </div>
      )}
    </section>
  );
}

function VariableValue({
  name,
  owner,
  type,
  value,
  path,
  kind = "string",
  depth = 0,
  onInspect,
}: VariableValueProps) {
  const { t } = useI18n();
  return (
    <div
      className="grid min-h-7 grid-cols-[minmax(60px,auto)_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#dfe7e7] pr-2 text-xs hover:bg-[#e3efed]"
      data-variable-path={jsonPointer(path)}
      style={{ paddingLeft: `${12 + depth * 16}px` }}
    >
      <span className="truncate text-[#28454a]">{name}</span>
      <button
        className="min-w-0 truncate text-left font-mono text-[11px] text-[#76531b] outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#0c766e]"
        onClick={() => onInspect(path, name, value, kind, owner)}
        title={t("inspector.viewValue", { name })}
        type="button"
      >
        <span className="mr-1 text-[#72868a]">{type}</span>
        {value}
      </button>
      <VariableOwnerBadge owner={owner} />
    </div>
  );
}
