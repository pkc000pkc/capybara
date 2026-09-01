import type {
  RuntimePluginDefinition,
  RuntimePluginsState,
  RuntimeVariables,
} from "./runtime-protocol";

export type RuntimeVariableOwner = "capybara-system" | "project" | string;

export type RuntimePluginView = RuntimePluginDefinition;

export function buildRuntimePluginViews(
  plugins: RuntimePluginsState,
): RuntimePluginView[] {
  return [...plugins.items].sort((left, right) => {
    if (left.id === "capybara-system") return -1;
    if (right.id === "capybara-system") return 1;
    if (left.id === "project") return -1;
    if (right.id === "project") return 1;
    return left.id.localeCompare(right.id);
  });
}

function pluginOwningVariable(
  plugins: RuntimePluginsState,
  key: string,
): RuntimePluginDefinition | undefined {
  return plugins.items.find((plugin) => plugin.variableKeys.includes(key));
}

function collectionId(
  values: Array<{ id: string }> | undefined,
  path: Array<string | number>,
): string | undefined {
  const index = typeof path[1] === "number" ? path[1] : Number(path[1]);
  return Number.isInteger(index) ? values?.[index]?.id : undefined;
}

export function resolveRuntimeVariableOwner(
  path: Array<string | number>,
  variables: RuntimeVariables,
  plugins: RuntimePluginsState,
): RuntimeVariableOwner {
  const root = path[0];
  if (root === "builtin") {
    const promptName = path[1] === "prompts" && typeof path[2] === "string"
      ? path[2]
      : null;
    if (promptName) {
      const plugin = pluginOwningVariable(plugins, promptName);
      if (plugin) return plugin.id;
      if ((variables.builtin.shared_prompts ?? []).includes(promptName)) return "project";
    }
    return "capybara-system";
  }
  if (root === "harnesses") {
    const id = collectionId(variables.harnesses, path);
    return plugins.items.find((plugin) => id && plugin.harnessIds.includes(id))?.id ?? "project";
  }
  if (root === "tools") return "project";
  if (["task", "agent", "context", "user_message", "skills"].includes(String(root))) {
    return "capybara-system";
  }
  if (typeof root === "string") {
    return pluginOwningVariable(plugins, root)?.id ?? "project";
  }
  return "project";
}
