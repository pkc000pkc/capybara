export type ResourceKind = "tool" | "skill" | "harness" | "hook";
export type SystemVariableType = "text" | "prompt_template" | "boolean" | "integer" | "number" | "date" | "datetime" | "array" | "object" | "secret_ref";
export type SystemVariableValue = string | boolean | number | SystemVariableValue[] | { [key: string]: SystemVariableValue };

export type ResourceDiagnostic = {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
};

export type ResourceFile = {
  path: string;
  role: "manifest" | "runner" | "entry" | "script" | "template" | "reference" | "asset";
  language: string;
  editable: boolean;
};

type ResourceModule<TKind extends ResourceKind> = {
  id: string;
  kind: TKind;
  package: string;
  name: string;
  version: number;
  source: string;
  enabled: boolean;
  revision: string;
  diagnostics: ResourceDiagnostic[];
  files: ResourceFile[];
};

export type PluginToolDependencyResource = {
  package: string;
  version: string;
  bundled?: string;
  installedVersion?: string;
  manifestPath?: string;
  status: "installed" | "missing" | "conflict";
};

export type PluginResource = {
  id: string;
  name: string;
  description: string;
  version: string;
  ownerKind: "system" | "project" | "installed";
  enabled: boolean;
  manifestPath?: string;
  source: string;
  uninstallable: boolean;
  resourceModuleIds: string[];
  resources: {
    variables?: string;
    harnesses: string[];
    hooks: string[];
    trainingHooks: string[];
  };
  variables: Array<{
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
  }>;
  variableDependencies: Array<{
    variable: {
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
    references: Array<{ path: string; count: number }>;
  }>;
  toolDependencies: PluginToolDependencyResource[];
  diagnostics: ResourceDiagnostic[];
};

export type ToolDependentPlugin = {
  pluginId: string;
  pluginName: string;
  requestedVersion: string;
  enabled: boolean;
};

export type ToolPackageResource = {
  package: string;
  version: string;
  manifestPath: string;
  moduleId: string;
  requiredBy: ToolDependentPlugin[];
  orphaned: boolean;
  uninstallable: boolean;
};

export type ToolResourceDefinition = {
  id: string;
  kind: "tool";
  name: string;
  description: string;
  permissions: string[];
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  examples: Record<string, unknown>[];
  diagnostics: ResourceDiagnostic[];
};

export type SkillResourceDefinition = {
  id: string;
  kind: "skill";
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  allowedTools?: string;
  entry: string;
  scripts: string[];
  references: string[];
  assets: string[];
  content: string;
  entryRevision: string;
  diagnostics: ResourceDiagnostic[];
};

export type HarnessResourceDefinition = {
  id: string;
  kind: "harness";
  name: string;
  description: string;
  type: "model" | "tool" | "experience" | "persistent";
  entry: string;
  priority: number;
  activation: Record<string, unknown>;
  inputs: string[];
  requiredTools: string[];
  examples: Record<string, unknown>[];
  content: string;
  entryRevision: string;
  diagnostics: ResourceDiagnostic[];
};

export type HookResourceDefinition = {
  id: string;
  kind: "hook";
  name: string;
  description: string;
  entry: string;
  enabled: boolean;
  ownerId: string;
  mode: "runtime" | "training";
  checkpoint: "after_loop" | "after_evaluation" | "after_replay";
  schedule: {
    priority: number;
    timeoutMs: number;
    onError: "continue" | "retry";
  };
  permissions: {
    llm?: "project";
    variables?: "patch";
    messages?: "replace";
    artifacts?: "write";
  };
  parameters: Array<{
    key: string;
    label: string;
    description?: string;
    defaultValue: string;
    input: "text" | "number";
    min?: number;
    max?: number;
  }>;
  triggerSummary: string;
  triggerInputs: string[];
  content: string;
  entryRevision: string;
  diagnostics: ResourceDiagnostic[];
};

export type ResourceDefinition = ToolResourceDefinition | SkillResourceDefinition | HarnessResourceDefinition | HookResourceDefinition;

export type ToolResourceModule = ResourceModule<"tool"> & {
  packageVersion: string;
  runner: { type: "stdio"; entry: string };
  tools: ToolResourceDefinition[];
};

export type SkillResourceModule = ResourceModule<"skill"> & {
  skills: SkillResourceDefinition[];
};

export type HarnessResourceModule = ResourceModule<"harness"> & {
  harnesses: HarnessResourceDefinition[];
};

export type HookResourceModule = ResourceModule<"hook"> & {
  hooks: HookResourceDefinition[];
};

export type ProjectResourceModule = ToolResourceModule | SkillResourceModule | HarnessResourceModule | HookResourceModule;
export type ResourceCatalog = {
  revision: string;
  items: ProjectResourceModule[];
  plugins?: PluginResource[];
  toolPackages?: ToolPackageResource[];
};
export type ResourceFileContent = ResourceFile & { content: string; revision: string };

export type PluginInstallPreview = {
  plugin: {
    id: string;
    name: string;
    description: string;
    version: string;
    source: string;
  };
  tools: Array<{
    package: string;
    requestedVersion: string;
    resolvedVersion?: string;
    action: "reuse" | "install" | "missing" | "conflict";
    permissions: string[];
  }>;
  valid: boolean;
};

export type PluginUninstallResult = {
  removedPlugin: { id: string; trashPath: string };
  orphanedTools: ToolPackageResource[];
  catalog: ResourceCatalog;
};

export type SkillMarketplaceResult = {
  description: string;
  namespace: string;
  path: string;
  repo: string;
  skillName: string;
  stars: number;
  installed: boolean;
};

export type SkillMarketplacePreview = {
  repo: string;
  requestedPath: string;
  commit: string;
  ref: string;
  skillName: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  metadata: Record<string, string>;
  content: string;
  files: Array<{
    path: string;
    size: number;
    kind: "entry" | "script" | "reference" | "asset" | "other";
  }>;
  warnings: string[];
};

export type InstalledSkillSummary = {
  id: string;
  path: string;
  managed: boolean;
  repo?: string;
  requestedPath?: string;
  commit?: string;
  installedAt?: string;
  hasLocalChanges: boolean;
};

export type RemovedSkill = {
  id: string;
  skillId: string;
  originalPath: string;
  trashPath: string;
  removedAt: string;
  expiresAt: string;
  configIndex: number;
  hadLocalChanges: boolean;
  catalog: ResourceCatalog;
};

export type ProjectFileEntry = {
  name: string;
  path: string;
  type: "directory" | "file" | "symlink";
  language: string;
  size: number;
  modifiedAt: string;
  editable: boolean;
};

export type ProjectDirectoryListing = {
  path: string;
  entries: ProjectFileEntry[];
};

export type ProjectTextFile = {
  name: string;
  path: string;
  language: string;
  size: number;
  modifiedAt: string;
  content: string;
  revision: string;
};

export type ProjectGitChange = {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  kind: "added" | "modified" | "deleted" | "renamed" | "copied" | "untracked" | "conflicted";
  staged: boolean;
  protected: boolean;
  category: "project" | "dataset" | "local";
  defaultSelected: boolean;
};

export type ProjectGitCommit = {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  committedAt: string;
};

export type ProjectGitStatus = {
  gitAvailable: boolean;
  initialized: boolean;
  projectPath: string;
  repositoryRoot: string | null;
  projectSubpath: string;
  branch: string | null;
  head: (ProjectGitCommit & { projectTreeSha: string | null }) | null;
  clean: boolean;
  changes: ProjectGitChange[];
};

export type ProjectGitDiff = {
  path: string;
  content: string;
  truncated: boolean;
};

export type HookTestFixture = {
  runId?: string;
  loopIteration?: number;
  status?: {
    run?: { status?: "completed" | "failed" | "cancelled"; failure?: unknown };
    context?: { usedTokens?: number; maxTokens?: number; utilization?: number };
    queueDepth?: number;
    messageCount?: number;
    variableTokens?: Record<string, number>;
  };
  changedVariables?: string[];
  variables?: Record<string, unknown>;
  messages?: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
};

export type HookTestResult = {
  matched: boolean;
  result?: {
    patches?: Array<Record<string, unknown>>;
    messages?: HookTestFixture["messages"];
    artifacts?: Array<{ title: string; value: unknown }>;
    metadata?: unknown;
  };
  durationMs: number;
  attempts: number;
  usage: Record<string, number>;
  logs: Array<{ level: "debug" | "info" | "warn" | "error"; message: string; data?: unknown }>;
};

function apiUrl(path: string, projectPath: string): string {
  const configured = process.env.NEXT_PUBLIC_RUNTIME_HTTP_URL?.replace(/\/$/, "");
  const base = configured ?? `${window.location.protocol}//${window.location.hostname}:3005`;
  const separator = path.includes("?") ? "&" : "?";
  return `${base}/api/resources/${path}${separator}projectPath=${encodeURIComponent(projectPath)}`;
}

async function request<T>(projectPath: string, path: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path, projectPath), {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

export const resourceApi = {
  projectDirectory: (projectPath: string, path = "") =>
    request<ProjectDirectoryListing>(projectPath, `files?path=${encodeURIComponent(path)}`),
  projectFile: (projectPath: string, path: string) =>
    request<ProjectTextFile>(projectPath, `files/content?path=${encodeURIComponent(path)}`),
  saveProjectFile: (projectPath: string, path: string, content: string, revision: string) =>
    request<ProjectTextFile>(projectPath, "files/content", "PUT", { path, content, revision }),
  createProjectEntry: (projectPath: string, parent: string, name: string, type: "file" | "directory") =>
    request<ProjectFileEntry>(projectPath, "files", "POST", { parent, name, type }),
  renameProjectEntry: (projectPath: string, path: string, name: string) =>
    request<ProjectFileEntry>(projectPath, "files", "PATCH", { path, name }),
  deleteProjectEntry: (projectPath: string, path: string, recursive: boolean) =>
    request<{ deleted: true; path: string }>(projectPath, "files", "DELETE", { path, recursive }),
  catalog: (projectPath: string) => request<ResourceCatalog>(projectPath, "catalog"),
  createPlugin: (projectPath: string, name: string) =>
    request<{ plugin: PluginResource; catalog: ResourceCatalog }>(projectPath, "plugins", "POST", { name }),
  previewPluginInstall: (projectPath: string, source: string) =>
    request<PluginInstallPreview>(projectPath, "plugins/install/preview", "POST", { source }),
  installPlugin: (projectPath: string, source: string) =>
    request<{
      plugin: PluginResource;
      installedTools: ToolPackageResource[];
      reusedTools: ToolPackageResource[];
      catalog: ResourceCatalog;
    }>(projectPath, "plugins/install", "POST", { source }),
  setPluginEnabled: (projectPath: string, id: string, enabled: boolean) =>
    request<{ plugin: PluginResource; catalog: ResourceCatalog }>(
      projectPath,
      `plugins/${encodeURIComponent(id)}`,
      "PATCH",
      { enabled },
    ),
  savePluginVariables: (
    projectPath: string,
    id: string,
    variables: PluginResource["variables"],
    catalogRevision: string,
  ) => request<{ plugin: PluginResource; catalog: ResourceCatalog }>(
    projectPath,
    `plugins/${encodeURIComponent(id)}/variables`,
    "PUT",
    { variables, catalogRevision },
  ),
  removePluginVariableDependency: (
    projectPath: string,
    id: string,
    key: string,
    catalogRevision: string,
  ) => request<{ plugin: PluginResource; catalog: ResourceCatalog }>(
    projectPath,
    `plugins/${encodeURIComponent(id)}/variable-dependencies/${encodeURIComponent(key)}`,
    "DELETE",
    { catalogRevision },
  ),
  createPluginHarness: (
    projectPath: string,
    id: string,
    input: {
      name: string;
      description: string;
      type: HarnessResourceDefinition["type"];
      activation: Record<string, unknown>;
      inputs: string[];
      requiredTools: string[];
      content: string;
      catalogRevision: string;
    },
  ) => request<{ plugin: PluginResource; catalog: ResourceCatalog }>(
    projectPath,
    `plugins/${encodeURIComponent(id)}/harnesses`,
    "POST",
    input,
  ),
  savePluginHarness: (
    projectPath: string,
    pluginId: string,
    harnessId: string,
    content: string,
    entryRevision: string,
    catalogRevision: string,
  ) => request<{ plugin: PluginResource; catalog: ResourceCatalog }>(
    projectPath,
    `plugins/${encodeURIComponent(pluginId)}/harnesses/${encodeURIComponent(harnessId)}`,
    "PUT",
    { content, entryRevision, catalogRevision },
  ),
  deletePluginHarness: (
    projectPath: string,
    pluginId: string,
    harnessId: string,
    entryRevision: string,
    catalogRevision: string,
  ) => request<{ plugin: PluginResource; catalog: ResourceCatalog }>(
    projectPath,
    `plugins/${encodeURIComponent(pluginId)}/harnesses/${encodeURIComponent(harnessId)}`,
    "DELETE",
    { entryRevision, catalogRevision },
  ),
  createPluginHook: (
    projectPath: string,
    id: string,
    input: { name: string; mode: "runtime" | "training"; content: string; catalogRevision: string },
  ) => request<{ plugin: PluginResource; catalog: ResourceCatalog }>(
    projectPath,
    `plugins/${encodeURIComponent(id)}/hooks`,
    "POST",
    input,
  ),
  savePluginHook: (
    projectPath: string,
    pluginId: string,
    hookId: string,
    content: string,
    entryRevision: string,
    catalogRevision: string,
  ) => request<{ plugin: PluginResource; catalog: ResourceCatalog }>(
    projectPath,
    `plugins/${encodeURIComponent(pluginId)}/hooks/${encodeURIComponent(hookId)}`,
    "PUT",
    { content, entryRevision, catalogRevision },
  ),
  deletePluginHook: (
    projectPath: string,
    pluginId: string,
    hookId: string,
    entryRevision: string,
    catalogRevision: string,
  ) => request<{ plugin: PluginResource; catalog: ResourceCatalog }>(
    projectPath,
    `plugins/${encodeURIComponent(pluginId)}/hooks/${encodeURIComponent(hookId)}`,
    "DELETE",
    { entryRevision, catalogRevision },
  ),
  uninstallPlugin: (projectPath: string, id: string) =>
    request<PluginUninstallResult>(projectPath, `plugins/${encodeURIComponent(id)}`, "DELETE"),
  uninstallToolPackage: (projectPath: string, packageName: string) =>
    request<{ removedTool: { package: string; trashPath: string }; catalog: ResourceCatalog }>(
      projectPath,
      `tools/packages/${encodeURIComponent(packageName)}`,
      "DELETE",
    ),
  file: (projectPath: string, path: string) =>
    request<ResourceFileContent>(projectPath, `file?path=${encodeURIComponent(path)}`),
  testTool: (projectPath: string, id: string, args: unknown) =>
    request<unknown>(projectPath, `tools/${encodeURIComponent(id)}/test`, "POST", { arguments: args }),
  testSkill: (projectPath: string, id: string, context: unknown) =>
    request<unknown>(projectPath, `skills/${encodeURIComponent(id)}/test`, "POST", { context }),
  testHarness: (projectPath: string, id: string, context: unknown) =>
    request<unknown>(projectPath, `harnesses/${encodeURIComponent(id)}/test`, "POST", { context }),
  saveSkill: (projectPath: string, id: string, content: string, revision: string) =>
    request<SkillResourceModule>(projectPath, `skills/${encodeURIComponent(id)}`, "PUT", { content, revision }),
  searchSkills: (projectPath: string, query: string, owner: string, page: number, limit = 15) => {
    const parameters = new URLSearchParams({ query, page: String(page), limit: String(limit) });
    if (owner.trim()) parameters.set("owner", owner.trim());
    return request<{ items: SkillMarketplaceResult[]; page: number }>(
      projectPath,
      `skills/marketplace/search?${parameters.toString()}`,
    );
  },
  previewMarketplaceSkill: (projectPath: string, repo: string, path: string) =>
    request<SkillMarketplacePreview>(projectPath, "skills/marketplace/preview", "POST", { repo, path }),
  installedSkills: (projectPath: string) =>
    request<{ items: InstalledSkillSummary[] }>(projectPath, "skills/marketplace/installed"),
  installMarketplaceSkill: (projectPath: string, repo: string, path: string, commit: string) =>
    request<{ skill?: InstalledSkillSummary; catalog: ResourceCatalog }>(
      projectPath,
      "skills/marketplace/install",
      "POST",
      { repo, path, commit },
    ),
  uninstallSkill: (projectPath: string, id: string) =>
    request<RemovedSkill>(projectPath, `skills/${encodeURIComponent(id)}`, "DELETE"),
  restoreSkill: (projectPath: string, trashId: string) =>
    request<{ restored: true; skillId: string; catalog: ResourceCatalog }>(
      projectPath,
      "skills/marketplace/restore",
      "POST",
      { trashId },
    ),
  saveHarness: (projectPath: string, id: string, content: string, revision: string) =>
    request<HarnessResourceModule>(projectPath, `harnesses/${encodeURIComponent(id)}`, "PUT", { content, revision }),
  createHook: (projectPath: string, name: string, content: string) =>
    request<HookResourceModule>(projectPath, "hooks", "POST", { name, content }),
  saveHook: (projectPath: string, id: string, content: string, revision: string) =>
    request<HookResourceModule>(projectPath, `hooks/${encodeURIComponent(id)}`, "PUT", { content, revision }),
  deleteHook: (projectPath: string, id: string, revision: string) =>
    request<{ deleted: true; id: string }>(projectPath, `hooks/${encodeURIComponent(id)}`, "DELETE", { revision }),
  testHook: (projectPath: string, id: string, fixture: HookTestFixture) =>
    request<HookTestResult>(projectPath, `hooks/${encodeURIComponent(id)}/test`, "POST", { fixture }),
  gitStatus: (projectPath: string) =>
    request<ProjectGitStatus>(projectPath, "git/status"),
  gitHistory: (projectPath: string, limit = 50) =>
    request<{ items: ProjectGitCommit[] }>(projectPath, `git/history?limit=${limit}`),
  gitDiff: (projectPath: string, path: string) =>
    request<ProjectGitDiff>(projectPath, `git/diff?path=${encodeURIComponent(path)}`),
  initializeGit: (projectPath: string) =>
    request<ProjectGitStatus>(projectPath, "git/initialize", "POST", {}),
  commitGit: (projectPath: string, message: string, paths: string[]) =>
    request<{
      commit: ProjectGitCommit & { projectTreeSha: string | null };
      committedPaths: string[];
      status: ProjectGitStatus;
    }>(projectPath, "git/commit", "POST", { message, paths }),
};
