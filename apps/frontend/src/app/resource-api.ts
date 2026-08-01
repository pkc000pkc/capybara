export type ResourceKind = "tool" | "skill" | "harness";

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
  type: "model" | "tool" | "experience";
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

export type ResourceDefinition = ToolResourceDefinition | SkillResourceDefinition | HarnessResourceDefinition;

export type ToolResourceModule = ResourceModule<"tool"> & {
  runner: { type: "stdio"; entry: string };
  tools: ToolResourceDefinition[];
};

export type SkillResourceModule = ResourceModule<"skill"> & {
  skills: SkillResourceDefinition[];
};

export type HarnessResourceModule = ResourceModule<"harness"> & {
  harnesses: HarnessResourceDefinition[];
};

export type ProjectResourceModule = ToolResourceModule | SkillResourceModule | HarnessResourceModule;
export type ResourceCatalog = { revision: string; items: ProjectResourceModule[] };
export type ResourceFileContent = ResourceFile & { content: string; revision: string };

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

export type CompressionPolicy = {
  trigger_ratio: number;
  target_ratio: number;
  preserve_recent_turns: number;
  max_source_tokens: number;
  max_output_tokens: number;
  retry_limit: number;
  apply_mode: "automatic" | "debug";
};

export type CompressionResource = {
  manifest: {
    version: 1;
    id: string;
    name: string;
    description: string;
    entry: string;
    policy: CompressionPolicy;
  };
  prompt: string;
  revision: string;
  source: string;
  variables: string[];
  diagnostics: ResourceDiagnostic[];
};

export type CompressionTestResult = {
  resourceRevision: string;
  beforeTokens: number;
  targetTokens: number;
  afterTokens: number;
  sourceUnits: unknown[];
  renderedPrompt: string;
  responseText: string;
  patch: unknown;
  afterMessages: unknown[];
  usage: unknown;
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
  catalog: (projectPath: string) => request<ResourceCatalog>(projectPath, "catalog"),
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
  saveHarness: (projectPath: string, id: string, content: string, revision: string) =>
    request<HarnessResourceModule>(projectPath, `harnesses/${encodeURIComponent(id)}`, "PUT", { content, revision }),
  compression: (projectPath: string) =>
    request<CompressionResource>(projectPath, "compression"),
  saveCompression: (projectPath: string, resource: CompressionResource) =>
    request<CompressionResource>(projectPath, "compression", "PUT", {
      baseRevision: resource.revision,
      manifest: resource.manifest,
      prompt: resource.prompt,
    }),
  testCompression: (projectPath: string, messages: unknown[]) =>
    request<CompressionTestResult>(projectPath, "compression/test", "POST", { messages }),
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
