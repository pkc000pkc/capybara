export type DatasetStorageType = "jsonl" | "sqlite" | "huggingface";

export type DatasetFieldMapping = {
  id: string;
  question: string;
  thinking: string;
  answer: string;
  expectedTools: string;
  metadata: string;
};

export type DatasetImportField = {
  path: string;
  type: "string" | "number" | "boolean" | "object" | "array" | "null";
  examples: string[];
};

export type DatasetImportPreview = {
  path: string;
  sourceFile: string;
  storage: DatasetStorageType;
  sampleCount: number;
  fields: DatasetImportField[];
  samples: Array<{ index: number; values: Record<string, string> }>;
  suggestedMapping: DatasetFieldMapping;
};

export type DatasetSummary = {
  id: string;
  name: string;
  storage: DatasetStorageType;
  path: string;
  samples: number;
  version: number;
  tags: string[];
  scoringPrompt: string;
  mapping?: DatasetFieldMapping;
  createdAt: string;
  updatedAt: string;
};

export type DatasetRecordMetadata = {
  tags: string[];
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
};

export type DatasetRecord = {
  id: string;
  question: string;
  thinking: string;
  answer: string;
  expectedTools: string[];
  metadata: DatasetRecordMetadata;
};

export type DatasetPage = {
  items: DatasetRecord[];
  total: number;
  offset: number;
  limit: number;
};

function apiUrl(path: string, projectPath: string): string {
  const configured = process.env.NEXT_PUBLIC_RUNTIME_HTTP_URL?.replace(/\/$/, "");
  const base = configured ?? `${window.location.protocol}//${window.location.hostname}:3005`;
  const separator = path.includes("?") ? "&" : "?";
  return `${base}/api/datasets${path}${separator}projectPath=${encodeURIComponent(projectPath)}`;
}

async function request<T>(projectPath: string, path = "", method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(apiUrl(path, projectPath), {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

export const datasetApi = {
  list: (projectPath: string) => request<{ items: DatasetSummary[] }>(projectPath),
  get: (projectPath: string, id: string) =>
    request<DatasetSummary>(projectPath, `/${encodeURIComponent(id)}`),
  create: (
    projectPath: string,
    input: { name: string; storage: DatasetStorageType; path: string; tags: string[]; scoringPrompt: string },
  ) => request<DatasetSummary>(projectPath, "", "POST", input),
  previewImport: (projectPath: string, path: string) =>
    request<DatasetImportPreview>(projectPath, "/import/preview", "POST", { path }),
  import: (projectPath: string, path: string, mapping: DatasetFieldMapping) =>
    request<DatasetSummary>(projectPath, "/import", "POST", { path, mapping }),
  update: (projectPath: string, id: string, input: { name: string; tags: string[]; scoringPrompt: string }) =>
    request<DatasetSummary>(projectPath, `/${encodeURIComponent(id)}`, "PUT", input),
  remove: (projectPath: string, id: string) =>
    request<{ id: string; path: string; filesPreserved: true }>(
      projectPath,
      `/${encodeURIComponent(id)}`,
      "DELETE",
    ),
  records: (projectPath: string, id: string, query: string, offset: number, limit: number) =>
    request<DatasetPage>(
      projectPath,
      `/${encodeURIComponent(id)}/records?query=${encodeURIComponent(query)}&offset=${offset}&limit=${limit}`,
    ),
  createRecord: (
    projectPath: string,
    id: string,
    record: Pick<DatasetRecord, "question" | "thinking" | "answer" | "expectedTools"> & { metadata: { tags: string[] } },
  ) => request<DatasetRecord>(projectPath, `/${encodeURIComponent(id)}/records`, "POST", record),
  updateRecord: (projectPath: string, id: string, record: DatasetRecord) =>
    request<DatasetRecord>(
      projectPath,
      `/${encodeURIComponent(id)}/records/${encodeURIComponent(record.id)}`,
      "PUT",
      record,
    ),
  deleteRecord: (projectPath: string, id: string, recordId: string) =>
    request<{ deleted: true; id: string }>(
      projectPath,
      `/${encodeURIComponent(id)}/records/${encodeURIComponent(recordId)}`,
      "DELETE",
    ),
};
