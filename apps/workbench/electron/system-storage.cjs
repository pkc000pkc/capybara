const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SYSTEM_DIRECTORY_NAME = ".capybara";

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function copyDirectoryIfMissing(source, target) {
  if (!fs.existsSync(source) || fs.existsSync(target)) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, errorOnExist: false });
  return true;
}

function ensureSystemResources(root) {
  const candidates = [
    path.resolve(__dirname, "../../backend/templates/project"),
    path.resolve(__dirname, "../../examples/test-project"),
    path.resolve(process.resourcesPath || "", "backend/templates/project"),
  ];
  const source = candidates.find((candidate) => (
    fs.existsSync(path.join(candidate, "tools", "files", "manifest.json"))
    && fs.existsSync(path.join(candidate, "skills", "project-files", "SKILL.md"))
  ));
  if (!source) return;
  copyDirectoryIfMissing(path.join(source, "tools", "files"), path.join(root, "tools", "files"));
  copyDirectoryIfMissing(path.join(source, "skills", "project-files"), path.join(root, "skills", "project-files"));
}

function systemCapybaraDirectory(homeDirectory = os.homedir()) {
  return path.join(path.resolve(homeDirectory), SYSTEM_DIRECTORY_NAME);
}

function ensureSystemStorage({ homeDirectory = os.homedir(), env = process.env } = {}) {
  const root = systemCapybaraDirectory(homeDirectory);
  const logsDirectory = path.join(root, "logs");
  const configFile = path.join(root, "config.json");
  const credentialsFile = path.join(root, "credentials.json");
  const projectsFile = path.join(root, "projects.json");
  fs.mkdirSync(logsDirectory, { recursive: true });
  ensureSystemResources(root);
  if (!fs.existsSync(configFile)) {
    atomicWriteJson(configFile, {
      version: 1,
      llm: {
        provider: "openai",
        model: "gpt-6-luna",
        baseUrl: "https://api.openai.com/v1",
        protocol: "chat-completions",
      },
    });
  }
  if (!fs.existsSync(credentialsFile)) atomicWriteJson(credentialsFile, { version: 1, llm: {} });
  if (!fs.existsSync(projectsFile)) atomicWriteJson(projectsFile, []);
  const config = readJson(configFile, { version: 1, llm: {} });
  const credentials = readJson(credentialsFile, { version: 1, llm: {} });
  const configLlm = config.llm && typeof config.llm === "object" ? config.llm : {};
  const credentialLlm = credentials.llm && typeof credentials.llm === "object" ? credentials.llm : {};
  const runtimeEnv = { ...env };
  if (!runtimeEnv.LLM_PROVIDER && typeof configLlm.provider === "string") runtimeEnv.LLM_PROVIDER = configLlm.provider;
  if (!runtimeEnv.LLM_MODEL && typeof configLlm.model === "string") runtimeEnv.LLM_MODEL = configLlm.model;
  if (!runtimeEnv.LLM_BASE_URL && typeof configLlm.baseUrl === "string") runtimeEnv.LLM_BASE_URL = configLlm.baseUrl;
  if (!runtimeEnv.LLM_PROTOCOL && typeof configLlm.protocol === "string") runtimeEnv.LLM_PROTOCOL = configLlm.protocol;
  if (!runtimeEnv.LLM_API_KEY && !runtimeEnv.API_KEY && !runtimeEnv.OPENAI_API_KEY && typeof credentialLlm.apiKey === "string" && credentialLlm.apiKey.trim()) {
    runtimeEnv.LLM_API_KEY = credentialLlm.apiKey.trim();
  }
  return { root, logsDirectory, configFile, credentialsFile, projectsFile, runtimeEnv };
}

function writeSystemCredentials(credentialsFile, apiKey) {
  const value = String(apiKey || "").trim();
  if (!value) throw new Error("system API key is required");
  const credentials = readJson(credentialsFile, { version: 1, llm: {} });
  atomicWriteJson(credentialsFile, { ...credentials, llm: { ...credentials.llm, apiKey: value } });
}

function writeSystemModelSettings(storage, llm) {
  if (!llm || typeof llm !== 'object') throw new Error('model settings are required');
  for (const field of ['provider', 'model', 'base_url']) {
    if (typeof llm[field] !== 'string' || !llm[field].trim()) throw new Error(`${field} is required`);
  }
  if (!['responses', 'chat-completions'].includes(llm.protocol)) throw new Error('unsupported model protocol');
  const url = new URL(llm.base_url.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('model Base URL must be an HTTP endpoint without embedded credentials, query or fragment');
  if (llm.api_key !== undefined && (typeof llm.api_key !== 'string' || !llm.api_key.trim())) throw new Error('API key cannot be blank');
  const config = readJson(storage.configFile, {version:1});
  if (llm.api_key !== undefined) writeSystemCredentials(storage.credentialsFile, llm.api_key);
  atomicWriteJson(storage.configFile, {...config, llm:{...config.llm, provider:llm.provider.trim(), model:llm.model.trim(), baseUrl:url.toString().replace(/\/$/,''), protocol:llm.protocol}});
}

function migrateLegacyProjectIndex(projectsFile, legacyProjectsFile) {
  if (!legacyProjectsFile || !fs.existsSync(legacyProjectsFile)) return false;
  let current = [];
  try { current = JSON.parse(fs.readFileSync(projectsFile, "utf8")); } catch { current = []; }
  if (Array.isArray(current) && current.length > 0) return false;
  let legacy;
  try { legacy = JSON.parse(fs.readFileSync(legacyProjectsFile, "utf8")); } catch { return false; }
  if (!Array.isArray(legacy) || legacy.length === 0) return false;
  atomicWriteJson(projectsFile, legacy);
  return true;
}

function appendSystemLog(storage, event, details = {}) {
  if (!storage?.logsDirectory) return;
  const payload = { timestamp: new Date().toISOString(), event, ...details };
  fs.appendFileSync(path.join(storage.logsDirectory, "system.log"), `${JSON.stringify(payload)}\n`, "utf8");
}

module.exports = {
  appendSystemLog,
  ensureSystemStorage,
  migrateLegacyProjectIndex,
  readJson,
  systemCapybaraDirectory,
  writeSystemCredentials,
  writeSystemModelSettings,
};
