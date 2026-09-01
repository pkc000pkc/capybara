import type {
  HarnessResourceDefinition,
  HookResourceDefinition,
  ProjectResourceModule,
  PluginResource,
  ResourceCatalog,
  ResourceDiagnostic,
  SkillResourceDefinition,
  ToolResourceDefinition,
  SystemVariableType,
  SystemVariableValue,
} from "./resource-api";

export type BasePluginVariableDefinition = {
  key: string;
  type: SystemVariableType;
  label: string;
  description: string;
  value: SystemVariableValue;
  template?: string;
  required: boolean;
  readonly: boolean;
  show_in_status: boolean;
  scope?: "session" | "project";
  source: "builtin" | "project" | "plugin";
  owner?: string;
};

export type PluginVariableDefinition = BasePluginVariableDefinition & {
  relation: "registered" | "dependency";
  references: Array<{ path: string; count: number }>;
};

export type PluginToolDependency = {
  requestedId: string;
  requestedVersion: string;
  installedVersion?: string;
  status: "installed" | "missing" | "conflict";
  tool?: ToolResourceDefinition;
};

export type ResourcePluginView = {
  id: string;
  name: string;
  description: string;
  version: string;
  ownerKind: "system" | "project" | "installed" | "legacy";
  uninstallable: boolean;
  enabled: boolean;
  sources: string[];
  diagnostics: ResourceDiagnostic[];
  variables: PluginVariableDefinition[];
  harnesses: HarnessResourceDefinition[];
  hooks: HookResourceDefinition[];
  providedTools: ToolResourceDefinition[];
  requiredTools: PluginToolDependency[];
  legacyInstructions: SkillResourceDefinition[];
  status: "ready" | "attention";
};

function definitionsForModules(resourceModules: ProjectResourceModule[]) {
  const diagnostics: ResourceDiagnostic[] = [];
  const harnesses: HarnessResourceDefinition[] = [];
  const hooks: HookResourceDefinition[] = [];
  const providedTools: ToolResourceDefinition[] = [];
  const legacyInstructions: SkillResourceDefinition[] = [];
  for (const resourceModule of resourceModules) {
    const definitions = moduleDefinitions(resourceModule);
    diagnostics.push(...definitions.diagnostics);
    harnesses.push(...definitions.harnesses);
    hooks.push(...definitions.hooks);
    providedTools.push(...definitions.providedTools);
    legacyInstructions.push(...definitions.legacyInstructions);
  }
  return { diagnostics, harnesses, hooks, providedTools, legacyInstructions };
}

function uniqueDiagnostics(diagnostics: ResourceDiagnostic[]): ResourceDiagnostic[] {
  return [...new Map(diagnostics.map((diagnostic) => [
    `${diagnostic.severity}:${diagnostic.code}:${diagnostic.message}`,
    diagnostic,
  ])).values()];
}

function firstClassPluginViews(
  catalog: ResourceCatalog,
): ResourcePluginView[] {
  const catalogPlugins = catalog.plugins ?? [];
  const moduleById = new Map(catalog.items.map((resourceModule) => [resourceModule.id, resourceModule]));
  const toolByPackage = new Map(
    catalog.items
      .filter((resourceModule) => resourceModule.kind === "tool")
      .flatMap((resourceModule) => resourceModule.tools.map((tool) => [resourceModule.package, tool] as const)),
  );
  return catalogPlugins.map((plugin: PluginResource) => {
    const ownedModules = plugin.resourceModuleIds
      .map((id) => moduleById.get(id))
      .filter((item): item is ProjectResourceModule => Boolean(item));
    const owned = definitionsForModules(ownedModules);
    const pluginVariables: PluginVariableDefinition[] = [
      ...plugin.variables.map((variable) => ({
        ...variable,
        relation: "registered" as const,
        references: [],
      })),
      ...plugin.variableDependencies.map((dependency) => ({
        ...dependency.variable,
        relation: "dependency" as const,
        references: dependency.references,
      })),
    ];
    const requiredTools = plugin.toolDependencies.map((dependency) => ({
      requestedId: dependency.package,
      requestedVersion: dependency.version,
      ...(dependency.installedVersion ? { installedVersion: dependency.installedVersion } : {}),
      status: dependency.status,
      tool: toolByPackage.get(dependency.package),
    }));
    const diagnostics = uniqueDiagnostics([...plugin.diagnostics, ...owned.diagnostics]);
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      version: plugin.version,
      ownerKind: plugin.ownerKind,
      uninstallable: plugin.uninstallable,
      enabled: plugin.enabled,
      sources: [plugin.manifestPath ?? plugin.source],
      diagnostics,
      variables: pluginVariables.sort((left, right) => left.key.localeCompare(right.key)),
      harnesses: owned.harnesses.sort((left, right) => left.name.localeCompare(right.name)),
      hooks: owned.hooks.sort((left, right) => left.name.localeCompare(right.name)),
      providedTools: owned.providedTools.sort((left, right) => left.name.localeCompare(right.name)),
      requiredTools,
      legacyInstructions: owned.legacyInstructions,
      status: !plugin.enabled
        || requiredTools.some((dependency) => dependency.status !== "installed")
        || diagnostics.some((diagnostic) => diagnostic.severity === "error")
        ? "attention"
        : "ready",
    };
  });
}

function pluginIdForVariable(
  variable: BasePluginVariableDefinition,
  knownPluginIds: ReadonlySet<string>,
): string {
  if (variable.owner) return variable.owner;
  if (variable.readonly || variable.source === "builtin") return "capybara-system";
  const explicitOwner = [...knownPluginIds]
    .filter((pluginId) => variable.key.startsWith(`${pluginId}:`) || variable.key.startsWith(`${pluginId}.`))
    .sort((left, right) => right.length - left.length)[0];
  return explicitOwner ?? "project";
}

function requestedTools(skill: SkillResourceDefinition): string[] {
  return (skill.allowedTools ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function moduleDefinitions(resourceModule: ProjectResourceModule): {
  diagnostics: ResourceDiagnostic[];
  harnesses: HarnessResourceDefinition[];
  hooks: HookResourceDefinition[];
  providedTools: ToolResourceDefinition[];
  legacyInstructions: SkillResourceDefinition[];
  requiredToolIds: string[];
} {
  if (resourceModule.kind === "tool") {
    return {
      diagnostics: resourceModule.diagnostics,
      harnesses: [],
      hooks: [],
      providedTools: resourceModule.tools,
      legacyInstructions: [],
      requiredToolIds: [],
    };
  }
  if (resourceModule.kind === "harness") {
    return {
      diagnostics: resourceModule.diagnostics,
      harnesses: resourceModule.harnesses,
      hooks: [],
      providedTools: [],
      legacyInstructions: [],
      requiredToolIds: resourceModule.harnesses.flatMap((harness) => harness.requiredTools),
    };
  }
  if (resourceModule.kind === "hook") {
    return {
      diagnostics: resourceModule.diagnostics,
      harnesses: [],
      hooks: resourceModule.hooks,
      providedTools: [],
      legacyInstructions: [],
      requiredToolIds: [],
    };
  }
  return {
    diagnostics: resourceModule.diagnostics,
    harnesses: [],
    hooks: [],
    providedTools: [],
    legacyInstructions: resourceModule.skills,
    requiredToolIds: resourceModule.skills.flatMap(requestedTools),
  };
}

export function buildResourcePluginViews(
  catalog: ResourceCatalog,
  variables: BasePluginVariableDefinition[],
): ResourcePluginView[] {
  if ((catalog.plugins?.length ?? 0) > 0) return firstClassPluginViews(catalog);
  const plugins = new Map<string, Omit<ResourcePluginView, "requiredTools" | "status"> & {
    requiredToolIds: Set<string>;
  }>();
  const ensure = (id: string) => {
    const existing = plugins.get(id);
    if (existing) return existing;
    const created = {
      id,
      name: id,
      description: "",
      version: "1.0.0",
      ownerKind: "legacy" as const,
      uninstallable: false,
      enabled: true,
      sources: [] as string[],
      diagnostics: [] as ResourceDiagnostic[],
      variables: [] as PluginVariableDefinition[],
      harnesses: [] as HarnessResourceDefinition[],
      hooks: [] as HookResourceDefinition[],
      providedTools: [] as ToolResourceDefinition[],
      legacyInstructions: [] as SkillResourceDefinition[],
      requiredToolIds: new Set<string>(),
    };
    plugins.set(id, created);
    return created;
  };

  for (const resourceModule of catalog.items) {
    const plugin = ensure(resourceModule.package);
    const definitions = moduleDefinitions(resourceModule);
    plugin.enabled &&= resourceModule.enabled;
    plugin.sources.push(resourceModule.source);
    plugin.diagnostics.push(...definitions.diagnostics);
    plugin.harnesses.push(...definitions.harnesses);
    plugin.hooks.push(...definitions.hooks);
    plugin.providedTools.push(...definitions.providedTools);
    plugin.legacyInstructions.push(...definitions.legacyInstructions);
    definitions.requiredToolIds.forEach((toolId) => plugin.requiredToolIds.add(toolId));
  }

  const knownPluginIds = new Set(plugins.keys());
  for (const variable of variables) {
    ensure(pluginIdForVariable(variable, knownPluginIds)).variables.push({
      ...variable,
      relation: "registered",
      references: [],
    });
  }

  const installedTools = catalog.items
    .filter((resourceModule) => resourceModule.kind === "tool")
    .flatMap((resourceModule) => resourceModule.tools);
  const toolById = new Map(installedTools.map((tool) => [tool.id, tool]));
  const toolByName = new Map(installedTools.map((tool) => [tool.name, tool]));

  return [...plugins.values()]
    .map(({ requiredToolIds, ...plugin }) => {
      const requiredTools = [...requiredToolIds]
        .sort((left, right) => left.localeCompare(right))
        .map((requestedId) => ({
          requestedId,
          requestedVersion: "*",
          installedVersion: toolById.get(requestedId) || toolByName.get(requestedId) ? "1.0.0" : undefined,
          status: toolById.get(requestedId) || toolByName.get(requestedId) ? "installed" as const : "missing" as const,
          tool: toolById.get(requestedId) ?? toolByName.get(requestedId),
        }));
      const attention = !plugin.enabled
        || requiredTools.some((dependency) => !dependency.tool)
        || plugin.diagnostics.some((diagnostic) => diagnostic.severity === "error");
      return {
        ...plugin,
        sources: [...new Set(plugin.sources)].sort((left, right) => left.localeCompare(right)),
        diagnostics: plugin.diagnostics,
        variables: plugin.variables.sort((left, right) => left.key.localeCompare(right.key)),
        harnesses: plugin.harnesses.sort((left, right) => left.name.localeCompare(right.name)),
        hooks: plugin.hooks.sort((left, right) => left.name.localeCompare(right.name)),
        providedTools: plugin.providedTools.sort((left, right) => left.name.localeCompare(right.name)),
        requiredTools,
        status: attention ? "attention" as const : "ready" as const,
      };
    })
    .sort((left, right) => {
      if (left.id === "capybara-system") return -1;
      if (right.id === "capybara-system") return 1;
      if (left.id === "project") return -1;
      if (right.id === "project") return 1;
      return left.id.localeCompare(right.id);
    });
}
