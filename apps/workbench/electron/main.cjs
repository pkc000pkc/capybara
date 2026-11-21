const { app, BrowserWindow, WebContentsView, Menu, dialog, clipboard, ipcMain, Tray, nativeImage, shell } = require("electron");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { inspectDirectory } = require("./directory.cjs");
const { createProjectRegistry } = require("./project-registry.cjs");
const { loadLlmConfig, migrateLegacyJsonSessions } = require("./runtime-v2.cjs");
const { createBackendRuntimeManager } = require("./backend-runtime-host.cjs");
const { ensureProjectStorage } = require("./project-storage.cjs");
const { createApplicationProcessSupervisor } = require("./application-process-supervisor.cjs");
const { createApplicationBrowserHost } = require("./application-browser-host.cjs");
const { createBrowserSessionHost } = require("./browser-session-host.cjs");
const { createApplicationHostAdapter, createApplicationRuntimeHostAdapter } = require("./application-host-adapter.cjs");
const { appendSystemLog, ensureSystemStorage, migrateLegacyProjectIndex, writeSystemModelSettings } = require("./system-storage.cjs");

let mainWindow;
let projectRegistry;
let runtimeManager;
let systemStorage;
let systemRuntimeEnv;
let backendProcess;
let applicationSupervisor;
let applicationHostAdapter;
let applicationRuntimeHostAdapter;
let applicationBrowserHost;
let browserSessionHost;
let tray;
let isQuitting = false;
let secondInstancePending = false;
let workbenchReady = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!app.isReady() || !workbenchReady) {
      secondInstancePending = true;
      return;
    }
    restoreMainWindow();
  });
}

const EMBEDDED_TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAAB7klEQVR4nO1X3SsEURTfd5r7guJPkP+DB160m/9A++Be+ZjL1rb5iniwRFgPlJQkYkup3VrPysebF5LIbsjODKuWXUdnaQ1j2Ts7O+vBqVO3O6fz+52v6VyH469JWZe7ishsSOL0UOL0gXAGhSj6kGR2QDgbRN8/ghO53SVxqhUK+gMZjXDqzAlOOHspFrhOXwwkyrrcVcWM3JgJppZ7aKUuejZkF3hWZTqQJSDJ7MhuAtiYegL3thPgVPsogd3pf9e8CFR6OmBiNwxRTYWoqoA/EsrcmbUTJuCPhOCr4J1ZO2ECUU01OI5pqmk7cQKqYnB8pSim7SwpwXieJfjOzlQT+iOhTIS/NWE+dsIESKnHkPwT4CUugW97C1oW54Wd189MgLy5VjiBupE+iD8m4OTmGkbDO9AwOwk1Xtlgh3f4bSy8A6e3N3CXSEDtsM+aJmxZnIdUOp2dbzzjn+84Fs0onr9+dy3MWTsF7tVleNaB5JKnVApaV5aKM4ZNgWm4jMdzgl/E76AxMCXehJLAPoi17g1uwN75GSSSyYziuSe4DtXebqG9UE/gULTLLV3JCGeDdhMgnPWXbi2XmVLe2VmRJfCWBeq072HS1vwJXE8Cm6OYkecEd7wLvljw0SBxum/Fuo4+0BfW3JD2vyCv4K9bqaHcCFIAAAAASUVORK5CYII=";

function createTray() {
  if (tray) return tray;
  // Windows notification area icons need a raster image. Loading SVG data
  // directly can create a tray item with no visible glyph on some Windows
  // builds, so prefer the bundled PNG and keep an embedded PNG fallback for
  // packaged layouts that relocate the application files.
  const iconPath = path.join(__dirname, "assets", "tray-icon.png");
  let icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createFromDataURL(EMBEDDED_TRAY_ICON_DATA_URL);
  if (icon.isEmpty()) icon = nativeImage.createFromDataURL(EMBEDDED_TRAY_ICON_DATA_URL);
  if (process.platform === "win32") icon = icon.resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip("Capybara Workbench");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "显示主窗口", click: () => restoreMainWindow() },
    { type: "separator" },
    { label: "退出应用", click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on("click", () => restoreMainWindow());
  return tray;
}

function restoreMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  }
  mainWindow.show();
  mainWindow.restore();
  mainWindow.focus();
}

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function publicModelSettings() {
  const model = loadLlmConfig(systemRuntimeEnv);
  return { llm:{provider:model.provider, model:model.model, base_url:model.baseUrl, protocol:model.protocol, api_key_configured:!!model.apiKey}, scope:'system' };
}

ipcMain.handle('capybara:model-settings-get', () => publicModelSettings());
ipcMain.handle('capybara:clipboard-write', (_event, input) => {
  const text = typeof input?.text === 'string' ? input.text : '';
  clipboard.writeText(text);
  return { copied: true };
});
ipcMain.handle('capybara:model-settings-save', (_event, input) => {
  if (runtimeManager?.hasActiveRuns()) throw new Error('请在运行结束后保存全局模型设置');
  writeSystemModelSettings(systemStorage, input?.llm);
  const refreshed = ensureSystemStorage();
  Object.assign(systemRuntimeEnv, refreshed.runtimeEnv);
  appendSystemLog(systemStorage, 'model.settings.updated', {provider:systemRuntimeEnv.LLM_PROVIDER, model:systemRuntimeEnv.LLM_MODEL});
  return publicModelSettings();
});

function backendHttpBase() {
  const value = new URL(process.env.CAPYBARA_BACKEND_URL || "http://localhost:3005");
  value.pathname = "";
  value.search = "";
  return value.toString().replace(/\/$/, "");
}

function backendNodeExecutable() {
  // In Electron, process.execPath points to electron.exe.  Using it to run
  // the compiled backend makes the child exit immediately instead of
  // starting the Node HTTP server.  Keep an explicit override for packaged
  // distributions, and otherwise resolve Node from the normal desktop PATH.
  return process.env.CAPYBARA_NODE_BINARY || (process.versions?.electron ? (process.platform === "win32" ? "node.exe" : "node") : process.execPath);
}

function latestPersistentDashboardFile(projectPath) {
  const root = path.join(projectPath, ".capybara", "runtime", "research");
  if (!fs.existsSync(root)) return undefined;
  const candidates = [];
  for (const runEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!runEntry.isDirectory()) continue;
    const filePath = path.join(root, runEntry.name, "dashboard", "market-dashboard", "v1", "index.html");
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) candidates.push({ filePath, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.filePath;
}

function safeResearchRunId(runId) {
  return String(runId || "market-research").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function persistMarketResearchResult(projectPath, runId, result) {
  const directory = path.join(projectPath, ".capybara", "runtime", "research", safeResearchRunId(runId));
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, "result.json");
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, runId, savedAt: new Date().toISOString(), result }, null, 2), "utf8");
  fs.renameSync(temporary, target);
  return target;
}

function latestPersistentMarketResearchResult(projectPath) {
  const root = path.join(projectPath, ".capybara", "runtime", "research");
  if (!fs.existsSync(root)) return null;
  const candidates = [];
  for (const runEntry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!runEntry.isDirectory()) continue;
    const filePath = path.join(root, runEntry.name, "result.json");
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) continue;
      const envelope = readJsonFile(filePath, null);
      const result = envelope?.result;
      if (!result || typeof result !== "object" || Array.isArray(result)) continue;
      candidates.push({ result, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0]?.result ?? null;
}

function capabilityFallback(projectId, backendState, backendDetail) {
  return {
    projectId,
    backend: { state: backendState, detail: backendDetail },
    applicationRuntime: applicationSupervisor ? { state: "available", detail: "Electron 主进程应用运行时已连接" } : { state: "unknown", detail: "应用运行时尚未通过桌面入口连接" },
    browserGateway: browserSessionHost ? { state: "available", detail: "受控 Electron 浏览器宿主已连接" } : { state: "unknown", detail: "受控浏览器宿主尚未连接" },
    marketResearch: { state: "unknown", detail: "市场研究需要后端 provider 注入，当前桌面入口尚未发现能力描述" },
  };
}

async function productCapabilityStatus(record) {
  let backendState = "unknown";
  let backendDetail = "本地运行服务状态未知";
  try {
    const response = await fetch(`${backendHttpBase()}/hello`);
    backendState = response.ok ? "available" : "unavailable";
    backendDetail = response.ok ? "本地运行服务已连接" : `本地运行服务返回 HTTP ${response.status}`;
  } catch (error) {
    backendState = "unavailable";
    backendDetail = error instanceof Error ? error.message : "本地运行服务不可达";
  }
  const fallback = capabilityFallback(record.projectId, backendState, backendDetail);
  if (backendState !== "available") return fallback;
  try {
    const response = await fetch(`${backendHttpBase()}/api/capabilities?projectId=${encodeURIComponent(record.projectId)}`);
    if (!response.ok) return fallback;
    const value = await response.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
    const payload = value;
    const normalize = (key, fallbackValue) => {
      const item = payload[key];
      if (!item || typeof item !== "object" || Array.isArray(item)) return fallbackValue;
      const state = ["available", "unavailable", "unknown"].includes(item.state) ? item.state : fallbackValue.state;
      const detail = typeof item.detail === "string" && item.detail.trim() ? item.detail : fallbackValue.detail;
      return { state, detail };
    };
    return {
      ...fallback,
      applicationRuntime: applicationSupervisor ? fallback.applicationRuntime : normalize("applicationRuntime", fallback.applicationRuntime),
      browserGateway: browserSessionHost ? fallback.browserGateway : normalize("browserGateway", fallback.browserGateway),
      marketResearch: normalize("marketResearch", fallback.marketResearch),
    };
  } catch {
    return fallback;
  }
}

async function backendIsReady() {
  try {
    const response = await fetch(`${backendHttpBase()}/hello`);
    return response.ok;
  } catch {
    return false;
  }
}

async function startManagedBackend() {
  if (process.env.CAPYBARA_MANAGED_BACKEND === "false") return;
  if (await backendIsReady()) return;
  // main.cjs lives at apps/workbench/electron. The workspace scripts and
  // package.json are three levels above this file, at the repository root.
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const backendRoot = path.join(repoRoot, "apps", "backend");
  const compiledServer = path.join(backendRoot, "dist", "server.js");
  const useCompiledServer = fs.existsSync(compiledServer);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  backendProcess = useCompiledServer
    ? spawn(backendNodeExecutable(), [compiledServer], {
      cwd: backendRoot,
      env: { ...process.env, ...(systemRuntimeEnv || {}), PORT: process.env.PORT || "3005" },
      stdio: "ignore",
      windowsHide: true,
    })
    : spawn(npmCommand, ["run", "dev:backend"], {
      cwd: repoRoot,
      env: { ...process.env, ...(systemRuntimeEnv || {}), PORT: process.env.PORT || "3005" },
      // Windows cannot spawn npm.cmd directly without the command shell.
      // Keep the child hidden while allowing the workspace script to start.
      shell: process.platform === "win32",
      stdio: "ignore",
      windowsHide: true,
    });
  backendProcess.once("error", () => { backendProcess = undefined; });
  backendProcess.once("exit", () => { backendProcess = undefined; });

  // Do not create the renderer while the compatibility HTTP surface is still
  // starting. The V2 chat path is local IPC, but project inspection and the
  // capability panel still use this service during initial hydration.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await backendIsReady()) return;
    if (!backendProcess) break;
  }
  appendSystemLog(systemStorage, "backend.start.timeout", { url: backendHttpBase() });
}

function stopManagedBackend() {
  if (!backendProcess || backendProcess.killed) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/pid", String(backendProcess.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
  } else {
    backendProcess.kill("SIGTERM");
  }
  backendProcess = undefined;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function responseErrorMessage(value, fallback) {
  if (value && typeof value === "object" && typeof value.error === "string" && value.error.trim()) {
    return value.error.trim();
  }
  if (typeof value === "string" && value.trim()) return value.trim();
  return fallback;
}

async function ensureProjectReady(selectedPath, { initializeEmpty = false } = {}) {
  const inspected = await fetch(`${backendHttpBase()}/api/projects/inspect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: selectedPath }),
  });
  const inspection = await readJsonResponse(inspected);
  if (!inspected.ok) {
    throw new Error(responseErrorMessage(inspection, `project inspection failed with HTTP ${inspected.status}`));
  }
  if (!inspection || typeof inspection !== "object") {
    throw new Error("project inspection returned an invalid response");
  }
  if (inspection.status === "ready") return inspection;
  if (inspection.status !== "empty") throw new Error("project is not ready for local runtime");
  if (!initializeEmpty) return inspection;

  const initialized = await fetch(`${backendHttpBase()}/api/projects/initialize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: selectedPath }),
  });
  const result = await readJsonResponse(initialized);
  if (!initialized.ok) {
    throw new Error(responseErrorMessage(result, `project initialization failed with HTTP ${initialized.status}`));
  }
  return { ...inspection, ...result, status: "ready" };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    backgroundColor: "#e7edef",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const devUrl = process.env.CAPYBARA_WORKBENCH_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "out", "index.html"));
  }
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => { mainWindow = undefined; });
  mainWindow.on("resize", () => {
    applicationBrowserHost?.resize();
    browserSessionHost?.resize();
  });
}

ipcMain.handle("capybara:pick-project-directory", async () => {
  if (!mainWindow) return { kind: "cancelled" };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "打开工作项目",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return { kind: "cancelled" };
  const selectedPath = result.filePaths[0];
  const summary = await inspectDirectory(selectedPath);
  ensureProjectStorage(selectedPath);
  appendSystemLog(systemStorage, "project.opened", { displayName: summary.displayName });
  return {
    kind: "selected",
    selection: projectRegistry.createSelection({ selectedPath: path.resolve(selectedPath), ...summary }),
  };
});

ipcMain.handle("capybara:register-project-directory", async (_event, selection) => {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  return projectRegistry.registerSelection(selection);
});

ipcMain.handle("capybara:list-projects", async () => {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  const items = projectRegistry.listExisting().map((record) => {
    ensureProjectStorage(record.selectedPath);
    return {
      projectId: record.projectId,
      displayName: record.displayName,
      isEmpty: record.isEmpty,
      opaqueDirectoryRef: record.ref,
    };
  });
  return { items };
});

ipcMain.handle("capybara:close-project", async (_event, input) => {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  if (applicationSupervisor) {
    for (const instance of applicationSupervisor.list({ projectPath: record.selectedPath })) {
      await applicationSupervisor.stop({ instanceId: instance.instanceId, reason: "project-closed" }).catch(() => undefined);
      applicationBrowserHost?.close(instance.instanceId);
    }
  }
  browserSessionHost?.closeForProject(record.projectId);
  runtimeManager?.closeWorkspace({ workspaceId: record.projectId, projectPath: record.selectedPath });
  try {
    await fetch(`${backendHttpBase()}/api/projects/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: record.selectedPath }),
    });
  } catch {
    // The desktop boundary still closes its local project registration if the
    // optional compatibility backend is unavailable.
  }
  projectRegistry.remove(ref);
  appendSystemLog(systemStorage, "project.closed", { displayName: record.displayName });
  return { closed: true, projectId: record.projectId, displayName: record.displayName };
});

ipcMain.handle("capybara:window-minimize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { changed: false };
  mainWindow.minimize();
  return { changed: true };
});

ipcMain.handle("capybara:window-toggle-maximize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { maximized: mainWindow.isMaximized() };
});

ipcMain.handle("capybara:window-close", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { closed: false };
  mainWindow.close();
  return { closed: true };
});

ipcMain.handle("capybara:prepare-project-directory", async (_event, input) => {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const selectedPath = projectRegistry.resolvePath(ref);
  if (!selectedPath) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(selectedPath);
  const result = await ensureProjectReady(selectedPath, { initializeEmpty: true });
  return { status: result.status === "ready" && Array.isArray(result.files) ? "initialized" : "ready", files: Array.isArray(result.files) ? result.files : [] };
});

ipcMain.handle("capybara:product-capability-status", async (_event, input) => {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  return productCapabilityStatus(record);
});

ipcMain.handle("capybara:market-research", async (_event, input) => {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  if (typeof input?.ticker !== "string" || !/^\d{6}$/.test(input.ticker)) throw new Error("ticker must be a six-digit security code");
  if (!Array.isArray(input?.reportUrls) || !input.reportUrls.every((url) => typeof url === "string")) throw new Error("reportUrls must be a string array");
  const runId = `market-research:${crypto.randomUUID()}`;
  const response = await fetch(`${backendHttpBase()}/api/work/market-research`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: record.projectId, projectPath: record.selectedPath, runId, ticker: input.ticker, reportUrls: input.reportUrls, ...(typeof input.today === "string" ? { today: input.today } : {}) }),
  });
  const result = await response.json();
  if (!response.ok && result?.status === undefined) throw new Error(result?.error || `market research failed with HTTP ${response.status}`);
  if (result && typeof result === "object" && !Array.isArray(result)) persistMarketResearchResult(record.selectedPath, runId, result);
  return result;
});

ipcMain.handle("capybara:market-research-load", async (_event, input) => {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  return latestPersistentMarketResearchResult(record.selectedPath);
});

ipcMain.handle("capybara:browser-read", async (_event, input) => {
  if (!input || typeof input.url !== "string" || !input.url.trim()) throw new Error("browser URL is required");
  const response = await fetch(`${backendHttpBase()}/api/work/browser/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: input.url.trim() }),
  });
  const result = await response.json();
  if (!response.ok && result?.status === undefined) throw new Error(result?.error || `browser read failed with HTTP ${response.status}`);
  return result;
});

function browserProjectRecord(input) {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  return record;
}

function browserSessionInput(input, record) {
  const browserInstanceId = typeof input?.browserInstanceId === "string" && input.browserInstanceId.trim()
    ? input.browserInstanceId.trim()
    : `browser:${record.projectId}`;
  const allowedOrigins = Array.isArray(input?.allowedOrigins)
    ? input.allowedOrigins.filter((origin) => typeof origin === "string" && origin.trim()).map((origin) => origin.trim())
    : [];
  if (allowedOrigins.length === 0) throw new Error("allowedOrigins is required for a browser session");
  return {
    ...input,
    browserInstanceId,
    projectId: record.projectId,
    projectPath: record.selectedPath,
    allowExternal: input?.allowExternal === true,
    allowedOrigins,
  };
}

ipcMain.handle("capybara:browser-session-open", async (_event, input) => {
  const record = browserProjectRecord(input);
  if (!browserSessionHost) throw new Error("browser session host is not ready");
  const session = browserSessionInput(input, record);
  return browserSessionHost.open(session);
});

ipcMain.handle("capybara:browser-session-navigate", async (_event, input) => {
  const record = browserProjectRecord(input);
  if (!browserSessionHost) throw new Error("browser session host is not ready");
  return browserSessionHost.navigate(String(input?.browserInstanceId || ""), String(input?.url || ""), record.projectId);
});

ipcMain.handle("capybara:browser-session-control", async (_event, input) => {
  const record = browserProjectRecord(input);
  if (!browserSessionHost) throw new Error("browser session host is not ready");
  return browserSessionHost.control(String(input?.browserInstanceId || ""), String(input?.action || ""), record.projectId);
});

ipcMain.handle("capybara:browser-session-state", async (_event, input) => {
  const record = browserProjectRecord(input);
  if (!browserSessionHost) return null;
  return browserSessionHost.state(String(input?.browserInstanceId || ""), record.projectId) || null;
});

ipcMain.handle("capybara:browser-session-screenshot", async (_event, input) => {
  const record = browserProjectRecord(input);
  if (!browserSessionHost) throw new Error("browser session host is not ready");
  return browserSessionHost.screenshot(String(input?.browserInstanceId || ""), record.projectId);
});

ipcMain.handle("capybara:browser-session-close", async (_event, input) => {
  const record = browserProjectRecord(input);
  if (!browserSessionHost) return { closed: false };
  const browserInstanceId = String(input?.browserInstanceId || "");
  const state = browserSessionHost.state(browserInstanceId, record.projectId);
  if (state && state.projectId && state.projectId !== record.projectId) throw new Error("browser session belongs to another project");
  return browserSessionHost.close(browserInstanceId);
});

function publishBrowserEvent(event) {
  if (systemStorage) appendSystemLog(systemStorage, event.type || "browser.event", event);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("capybara:browser-event", event);
}

const DEFAULT_BROWSER_ORIGINS = ["https://example.com", "https://www.investor.gov", "https://www.cninfo.com.cn"];

function browserOrigins(input) {
  const requested = Array.isArray(input?.allowedOrigins) && input.allowedOrigins.length > 0
    ? input.allowedOrigins.filter((origin) => typeof origin === "string" && origin.trim()).map((origin) => origin.trim())
    : DEFAULT_BROWSER_ORIGINS;
  const invalid = requested.filter((origin) => !DEFAULT_BROWSER_ORIGINS.includes(origin));
  if (invalid.length > 0) throw new Error(`browser origin is not allowed by the desktop policy: ${invalid.join(", ")}`);
  return requested;
}

function browserTargetSelector(target) {
  if (!target || typeof target !== "object" || Array.isArray(target) || typeof target.selector !== "string" || !target.selector.trim()) {
    throw new Error("browser action target.selector is required for page interaction");
  }
  return target.selector.trim();
}

function browserActionScript(action, input) {
  const selector = browserTargetSelector(input?.target);
  const selectorJson = JSON.stringify(selector);
  if (action === "click") {
    return `(() => { const el = document.querySelector(${selectorJson}); if (!el) throw new Error("target not found"); el.click(); return { tag: el.tagName, text: (el.innerText || el.textContent || "").slice(0, 400) }; })()`;
  }
  const value = JSON.stringify(String(input?.value ?? ""));
  if (action === "input" || action === "select") {
    return `(() => { const el = document.querySelector(${selectorJson}); if (!el) throw new Error("target not found"); el.value = ${value}; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return { tag: el.tagName, value: el.value }; })()`;
  }
  throw new Error(`unsupported browser script action: ${action}`);
}

async function browserHostAdapter(input) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    if (!browserSessionHost) throw new Error("browser session host is not ready");
    const projectPath = path.resolve(String(input?.projectPath || ""));
    const registeredProject = projectRegistry?.snapshot?.().find((item) => path.normalize(path.resolve(item.selectedPath)) === path.normalize(projectPath));
    const projectId = registeredProject?.projectId || projectPath;
    const browserInstanceId = typeof input?.browserInstanceId === "string" && input.browserInstanceId.trim()
      ? input.browserInstanceId.trim()
      : `runtime:${String(input?.sessionId || input?.runId || "browser")}`;
    const allowedOrigins = browserOrigins(input);
    const action = String(input?.action || "");
    const current = browserSessionHost.state(browserInstanceId, projectPath);
    let state = current;
    let output = {};
    // RuntimeLoop persists Browser Profile/Session/Tab metadata in the
    // project session snapshot, while Electron WebContentsView instances are
    // process-local. After a desktop restart, lazily rebuild the real view
    // from the last verified tab URL before continuing an interaction. This
    // keeps the first post-restart action observable as reconnecting/resumed
    // instead of surfacing a misleading "session not found" failure.
    const resumeView = async () => {
      if (state) return state;
      const resumeUrl = String(input?.url || "").trim();
      if (!resumeUrl) throw new Error("browser session cannot be resumed without a saved URL");
      state = (await browserSessionHost.open({ browserInstanceId, projectId, projectPath, url: resumeUrl, allowExternal: true, allowedOrigins, layout: "side", resume: true })).state;
      return state;
    };
    if (action === "navigate") {
      const url = String(input?.url || "").trim();
      if (!url) throw new Error("browser navigate requires url");
      if (state) state = await browserSessionHost.navigate(browserInstanceId, url, projectPath);
      else state = (await browserSessionHost.open({ browserInstanceId, projectId, projectPath, url, allowExternal: true, allowedOrigins, layout: "side" })).state;
      output = { state, pageState: { url: state.url, title: state.title, loading: state.loading } };
    } else if (action === "read") {
      if (!state) {
        const url = String(input?.url || "").trim();
        if (!url) throw new Error("browser read requires an open session or url");
        state = (await browserSessionHost.open({ browserInstanceId, projectId, projectPath, url, allowExternal: true, allowedOrigins, layout: "side" })).state;
      } else if (input?.url && state.url !== String(input.url).trim()) {
        state = await browserSessionHost.navigate(browserInstanceId, String(input.url).trim(), projectPath);
      }
      const result = await browserSessionHost.execute(browserInstanceId, "({ url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0, 12000) })", projectPath);
      state = result.state;
      output = { state, page: result.value };
    } else if (["click", "input", "select"].includes(action)) {
      await resumeView();
      const result = await browserSessionHost.execute(browserInstanceId, browserActionScript(action, input), projectPath);
      state = result.state;
      output = { state, result: result.value };
    } else if (action === "screenshot") {
      await resumeView();
      const result = await browserSessionHost.screenshot(browserInstanceId, projectPath);
      state = result.state;
      output = { state, screenshotDataUrl: result.dataUrl };
    } else if (action === "wait") {
      await resumeView();
      const timeoutMs = Math.min(10_000, Math.max(100, Number(input?.timeoutMs || 500)));
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      state = browserSessionHost.state(browserInstanceId, projectPath) || state;
      output = { state, waitedMs: timeoutMs };
    } else if (action === "assert") {
      await resumeView();
      if (typeof input?.script !== "string" || !input.script.trim()) throw new Error("browser assert requires an open session and script");
      const result = await browserSessionHost.execute(browserInstanceId, `Boolean(${input.script})`, projectPath);
      state = result.state;
      if (result.value !== true) throw new Error("browser assertion failed");
      output = { state, asserted: true };
    } else if (action === "download") {
      const url = String(input?.url || "").trim();
      if (!url) throw new Error("browser download requires url");
      if (!state) {
        state = (await browserSessionHost.open({ browserInstanceId, projectId, projectPath, url, allowExternal: true, allowedOrigins, layout: "side" })).state;
      }
      const download = await browserSessionHost.download(browserInstanceId, url, projectPath, input?.timeoutMs);
      state = browserSessionHost.state(browserInstanceId, projectPath) || state;
      output = { state, download };
    } else {
      throw new Error(`unsupported browser action: ${action}`);
    }
    return { id: input.callId, name: "browser_action", ok: true, output, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started };
  } catch (error) {
    return { id: input?.callId, name: "browser_action", ok: false, error: { code: "BROWSER_HOST_FAILED", message: error instanceof Error ? error.message : String(error) }, startedAt, completedAt: new Date().toISOString(), durationMs: Date.now() - started };
  }
}

ipcMain.handle("capybara:project-api", async (_event, input) => {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  const requestPath = input && typeof input.path === "string" ? input.path : "";
  if (!requestPath.startsWith("/api/") || requestPath.startsWith("//") || requestPath.includes("..")) throw new Error("project API path is not allowed");
  const method = input && typeof input.method === "string" ? input.method.toUpperCase() : "GET";
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("project API method is not allowed");
  const url = new URL(`${backendHttpBase()}${requestPath}`);
  url.searchParams.set("projectPath", record.selectedPath);
  const response = await fetch(url, {
    method,
    headers: input?.body === undefined ? undefined : { "content-type": "application/json" },
    body: input?.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!response.ok) throw new Error(body && typeof body === "object" && typeof body.error === "string" ? body.error : `project API failed with HTTP ${response.status}`);
  return body;
});

function applicationProjectRecord(input) {
  if (!projectRegistry) throw new Error("desktop project registry is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  return record;
}

function hasApplicationDefinition(projectPath, appId) {
  const projectRoot = path.resolve(projectPath);
  const projectManifestFile = path.join(projectRoot, ".capybara", "application.json");
  if (fs.existsSync(projectManifestFile)) {
    const projectManifest = readJsonFile(projectManifestFile, {});
    return !appId || projectManifest.appId === appId;
  }
  const applicationsRoot = path.join(projectRoot, ".capybara", "applications");
  if (!fs.existsSync(applicationsRoot)) return false;
  return fs.readdirSync(applicationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .some((entry) => {
      const manifest = readJsonFile(path.join(applicationsRoot, entry.name, "manifest.json"), null);
      return Boolean(manifest && (!appId || manifest.appId === appId));
    });
}

function publishApplicationEvent(event) {
  if (systemStorage) appendSystemLog(systemStorage, event.type || "application.event", event);
  if (event.instanceId && ["application.process.stopped", "application.process.exited", "application.stop.succeeded", "application.start.failed"].includes(event.type)) {
    applicationBrowserHost?.close(event.instanceId);
  }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("capybara:application-event", event);
}

function publicApplicationInstance(instance) {
  if (!instance || typeof instance !== "object") return instance;
  const { projectPath, ...safe } = instance;
  return safe;
}

ipcMain.handle("capybara:application-status", async (_event, input) => {
  const record = applicationProjectRecord(input);
  if (!applicationSupervisor) throw new Error("application process supervisor is not ready");
  // An empty project has no application definition yet. Treat that as a
  // normal empty state instead of asking the supervisor to normalize a
  // manifest with no start command and logging a host error on every poll.
  if (!input?.manifest && !hasApplicationDefinition(record.selectedPath, input?.appId)) return null;
  const app = applicationSupervisor.resolveApplication(record.selectedPath, input?.appId, input?.manifest);
  const instances = applicationSupervisor.list({ projectPath: record.selectedPath }).filter((item) => !input?.appId || item.appId === app.manifest.appId);
  const receipts = applicationSupervisor.listReceipts({ projectPath: record.selectedPath }).filter((item) => !input?.appId || item.appId === app.manifest.appId);
  return { manifest: app.manifest, versions: applicationSupervisor.listVersions({ projectPath: record.selectedPath, appId: input?.appId, manifest: input?.manifest }), instances: instances.map(publicApplicationInstance), receipts };
});

ipcMain.handle("capybara:application-start", async (_event, input) => {
  const record = applicationProjectRecord(input);
  if (!applicationSupervisor) throw new Error("application process supervisor is not ready");
  return publicApplicationInstance(await applicationSupervisor.start({ projectPath: record.selectedPath, projectId: record.projectId, appId: input?.appId, manifest: input?.manifest, turnId: input?.turnId, stepId: input?.stepId, callId: input?.callId }));
});

ipcMain.handle("capybara:application-stop", async (_event, input) => {
  const record = applicationProjectRecord(input);
  if (!applicationSupervisor) throw new Error("application process supervisor is not ready");
  const result = await applicationSupervisor.stop({ projectPath: record.selectedPath, appId: input?.appId, instanceId: input?.instanceId, reason: input?.reason || "user" });
  if (input?.instanceId) applicationBrowserHost?.close(input.instanceId);
  return publicApplicationInstance(result);
});

ipcMain.handle("capybara:application-restart", async (_event, input) => {
  const record = applicationProjectRecord(input);
  if (!applicationSupervisor) throw new Error("application process supervisor is not ready");
  if (input?.instanceId) applicationBrowserHost?.close(input.instanceId);
  return publicApplicationInstance(await applicationSupervisor.restart({ projectPath: record.selectedPath, projectId: record.projectId, appId: input?.appId, manifest: input?.manifest, instanceId: input?.instanceId, turnId: input?.turnId, stepId: input?.stepId, callId: input?.callId }));
});

ipcMain.handle("capybara:application-update", async (_event, input) => {
  const record = applicationProjectRecord(input);
  if (!applicationSupervisor) throw new Error("application process supervisor is not ready");
  return publicApplicationInstance(await applicationSupervisor.update({ projectPath: record.selectedPath, projectId: record.projectId, appId: input?.appId, manifest: input?.manifest, instanceId: input?.instanceId, turnId: input?.turnId, stepId: input?.stepId, callId: input?.callId }));
});

ipcMain.handle("capybara:application-rollback", async (_event, input) => {
  const record = applicationProjectRecord(input);
  if (!applicationSupervisor) throw new Error("application process supervisor is not ready");
  const result = await applicationSupervisor.rollback({ projectPath: record.selectedPath, projectId: record.projectId, appId: input?.appId, instanceId: input?.instanceId, targetVersionId: input?.targetVersionId, failedVersionId: input?.failedVersionId, reason: input?.reason, turnId: input?.turnId, stepId: input?.stepId, callId: input?.callId });
  return publicApplicationInstance(result);
});

ipcMain.handle("capybara:application-health", async (_event, input) => {
  applicationProjectRecord(input);
  if (!applicationSupervisor) throw new Error("application process supervisor is not ready");
  return publicApplicationInstance(await applicationSupervisor.healthCheck({ instanceId: input?.instanceId }));
});

ipcMain.handle("capybara:application-layout", (_event, input) => {
  if (!applicationBrowserHost) throw new Error("application browser host is not ready");
  return applicationBrowserHost.setLayout(input?.layout);
});

ipcMain.handle("capybara:application-close", (_event, input) => {
  if (!applicationBrowserHost) return { closed: false };
  return applicationBrowserHost.close(input?.instanceId);
});

ipcMain.handle("capybara:open-application", async (_event, input) => {
  if (!applicationBrowserHost) throw new Error("application browser host is not ready");
  let url = typeof input?.url === "string" ? input.url.trim() : "";
  let instance;
  if (input?.opaqueDirectoryRef && input?.instanceId && applicationSupervisor) {
    const record = applicationProjectRecord(input);
    instance = applicationSupervisor.list({ projectPath: record.selectedPath }).find((item) => item.instanceId === input.instanceId);
    if (!instance) throw new Error("application instance is not running");
    url = instance.browserUrl;
  }
  if (!url) throw new Error("application URL or instanceId is required");
  if (input?.opaqueDirectoryRef && /^http:\/\/127\.0\.0\.1:\d+\/applications\/market-dashboard\/v1\/index\.html(?:\?.*)?$/.test(url) && projectRegistry) {
    const record = projectRegistry.getRecord(input.opaqueDirectoryRef);
    const filePath = record ? latestPersistentDashboardFile(record.selectedPath) : undefined;
    if (filePath) url = `file://${filePath.replaceAll("\\", "/")}`;
  }
  const result = await applicationBrowserHost.open({ instanceId: input?.instanceId || instance?.instanceId || "application", url, title: input?.title || "Capybara 应用", allowedOrigins: instance?.manifest?.browser?.allowedOrigins });
  return { ...result, instanceId: instance?.instanceId || input?.instanceId };
});

ipcMain.handle("capybara:runtime-connect", async (event, input) => {
  if (!projectRegistry || !runtimeManager) throw new Error("desktop runtime is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  return runtimeManager.connect({
    workspaceId: record.projectId,
    workspaceName: record.displayName,
    projectPath: record.selectedPath,
    sessionId: typeof input?.sessionId === "string" && input.sessionId.trim() ? input.sessionId.trim() : undefined,
    webContents: event.sender,
  });
});

ipcMain.handle("capybara:runtime-sessions", async (_event, input) => {
  if (!projectRegistry || !runtimeManager) throw new Error("desktop runtime is not ready");
  const ref = input && typeof input.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  return { items: await runtimeManager.listSessions({ workspaceId: record.projectId, workspaceName: record.displayName, projectPath: record.selectedPath }) };
});

ipcMain.handle("capybara:session-directory", async (_event, input) => {
  if (!projectRegistry || !runtimeManager) throw new Error("desktop runtime is not ready");
  const ref = typeof input?.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  return runtimeManager.listSessionDirectory({ workspaceId: record.projectId, workspaceName: record.displayName, projectPath: record.selectedPath });
});

ipcMain.handle("capybara:runtime-message-append", async (_event, input) => {
  if (!projectRegistry || !runtimeManager) throw new Error("desktop runtime is not ready");
  const ref = typeof input?.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
  const text = typeof input?.text === "string" ? input.text.trim() : "";
  const role = input?.role === "user" ? "user" : "assistant";
  if (!sessionId || !text) throw new Error("sessionId and text are required");
  ensureProjectStorage(record.selectedPath);
  return runtimeManager.appendMessage({
    workspace: { workspaceId: record.projectId, workspaceName: record.displayName, projectPath: record.selectedPath },
    sessionId,
    message: {
      role,
      text,
      ...(typeof input?.id === "string" && input.id.trim() ? { id: input.id.trim() } : {}),
      ...(typeof input?.requestId === "string" && input.requestId.trim() ? { requestId: input.requestId.trim() } : {}),
    },
  });
});

ipcMain.handle("capybara:session-message-send", async (_event, input) => {
  if (!projectRegistry || !runtimeManager) throw new Error("desktop runtime is not ready");
  const ref = typeof input?.opaqueDirectoryRef === "string" ? input.opaqueDirectoryRef : "";
  const record = projectRegistry.getRecord(ref);
  if (!record) throw new Error("opaque directory reference is unknown or expired");
  ensureProjectStorage(record.selectedPath);
  return runtimeManager.sendSessionMessage({
    workspace: { workspaceId: record.projectId, workspaceName: record.displayName, projectPath: record.selectedPath },
    sourceSessionId: input?.sourceSessionId,
    targetSessionId: input?.targetSessionId,
    type: input?.type,
    payload: input?.payload,
    idempotencyKey: input?.idempotencyKey,
  });
});

ipcMain.handle("capybara:runtime-send", async (event, input) => {
  if (!runtimeManager) throw new Error("desktop runtime is not ready");
  return runtimeManager.send({ runtimeId: input?.runtimeId, webContents: event.sender, frame: input?.frame });
});

for (const [channel, open] of [["capybara:mcp-input-url-read", false], ["capybara:mcp-input-url-open", true]]) {
  ipcMain.handle(channel, (event, input) => {
    if (!runtimeManager || event.senderFrame !== event.sender.mainFrame) throw new Error("desktop runtime is not available");
    return runtimeManager.mcpInputUrl({ runtimeId: input?.runtimeId, webContents: event.sender, requestId: input?.requestId,
      urlId: input?.urlId, open });
  });
}

ipcMain.handle("capybara:runtime-close", async (event, input) => {
  if (!runtimeManager) return { closed: false };
  const result = await runtimeManager.close({ runtimeId: input?.runtimeId, webContents: event.sender });
  if (result.closed) event.sender.send("capybara:runtime-closed", { runtimeId: input?.runtimeId, code: 1000, reason: "closed" });
  return result;
});

if (hasSingleInstanceLock) {
app.whenReady().then(async () => {
  // The workbench renders its own product menu inside the window. Keep one
  // menu surface so the native Electron default menu does not duplicate it.
  Menu.setApplicationMenu(null);
  systemStorage = ensureSystemStorage();
  systemRuntimeEnv = systemStorage.runtimeEnv;
  if (migrateLegacyProjectIndex(systemStorage.projectsFile, path.join(app.getPath("userData"), "projects.json"))) {
    appendSystemLog(systemStorage, "system.storage.migrated", { source: "electron-user-data/projects.json" });
  }
  appendSystemLog(systemStorage, "workbench.started", { model: systemRuntimeEnv.LLM_MODEL || "gpt-6-luna" });
  projectRegistry = createProjectRegistry({ storageFile: systemStorage.projectsFile });
  const legacyRuntimeFile = path.join(app.getPath("userData"), "runtime-v2.json");
  // Reconcile the persisted index before touching project storage. A project
  // that no longer exists must be removed from the index, not recreated by
  // ensureProjectStorage during startup recovery.
  const projectRecords = projectRegistry.listExisting();
  for (const record of projectRecords) ensureProjectStorage(record.selectedPath);
  const migratedSessions = migrateLegacyJsonSessions({ storageFile: legacyRuntimeFile, projectRecords });
  if (migratedSessions > 0) appendSystemLog(systemStorage, "system.storage.migrated", { source: "electron-user-data/runtime-v2.json", sessions: migratedSessions });
  applicationSupervisor = createApplicationProcessSupervisor({ onEvent: publishApplicationEvent, onReceipt: (receipt) => publishApplicationEvent({ type: "application.receipt.created", ...receipt }) });
  runtimeManager = createBackendRuntimeManager({
    openExternalMcpUrl: url => shell.openExternal(url),
    applicationHost: async (input) => applicationHostAdapter({
      ...input,
      appId: input.appId,
      instanceId: input.instanceId,
      targetVersionId: input.targetVersionId,
    }),
    browserHost: browserHostAdapter,
    emit: ({ runtimeId, webContents, event }) => {
      if (!webContents || typeof webContents.isDestroyed !== "function" || !webContents.isDestroyed()) {
        webContents?.send("capybara:runtime-event", { runtimeId, data: JSON.stringify(event) });
      }
    },
  });
  await runtimeManager.ready;
  applicationRuntimeHostAdapter = createApplicationRuntimeHostAdapter({ supervisor: applicationSupervisor });
  applicationHostAdapter = createApplicationHostAdapter({ supervisor: applicationSupervisor, runtimeHost: applicationRuntimeHostAdapter });
  for (const record of projectRecords) applicationSupervisor.recover({ projectPath: record.selectedPath });
  await startManagedBackend();
  createWindow();
  createTray();
  applicationBrowserHost = createApplicationBrowserHost({ mainWindow, WebContentsView, onEvent: publishApplicationEvent });
  browserSessionHost = createBrowserSessionHost({ mainWindow, WebContentsView, onEvent: publishBrowserEvent });
  workbenchReady = true;
  if (secondInstancePending) {
    secondInstancePending = false;
    restoreMainWindow();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      applicationBrowserHost = createApplicationBrowserHost({ mainWindow, WebContentsView, onEvent: publishApplicationEvent });
      browserSessionHost = createBrowserSessionHost({ mainWindow, WebContentsView, onEvent: publishBrowserEvent });
    }
  });
}).catch((error) => {
  appendSystemLog(systemStorage, "workbench.start.failed", { message: error instanceof Error ? error.message : String(error) });
  app.quit();
});
}

app.on("window-all-closed", () => {
  // The workbench stays alive in the system tray until the user explicitly
  // chooses “退出应用” from the tray menu.
});

let shutdownStarted = false;
let shutdownFinished = false;
app.on("before-quit", (event) => {
  if (!hasSingleInstanceLock) return;
  isQuitting = true;
  if (shutdownFinished) return;
  event.preventDefault();
  if (shutdownStarted) return;
  shutdownStarted = true;
  void Promise.all([
    Promise.resolve(runtimeManager?.closeAll()),
    Promise.resolve(applicationSupervisor?.closeAll()),
  ]).catch((error) => {
    appendSystemLog(systemStorage, "runtime.shutdown.failed", { message: String(error) });
  }).finally(() => {
    appendSystemLog(systemStorage, "workbench.stopped");
    applicationBrowserHost?.closeAll();
    browserSessionHost?.closeAll();
    stopManagedBackend();
    shutdownFinished = true;
    app.quit();
  });
});
