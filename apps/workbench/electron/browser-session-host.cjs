const { URL } = require("node:url");
const fs = require("node:fs");
const path = require("node:path");

function originMatches(url, allowedOrigin) {
  try {
    const expected = new URL(allowedOrigin);
    return expected.protocol === url.protocol
      && expected.hostname === url.hostname
      && (!expected.port || expected.port === url.port);
  } catch {
    return false;
  }
}

function browserUrlAllowed(value, { allowExternal = false, allowedOrigins = [] } = {}) {
  let url;
  try { url = new URL(String(value || "")); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (!allowExternal && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return false;
  const origins = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  if (origins.length === 0) return !allowExternal && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  return origins.some((origin) => originMatches(url, origin));
}

function createBrowserSessionHost({ mainWindow, WebContentsView, onEvent = () => undefined } = {}) {
  const views = new Map();
  let layout = "side";

  function bounds() {
    const content = typeof mainWindow?.getContentBounds === "function"
      ? mainWindow.getContentBounds()
      : { width: 1440, height: 920 };
    const menuHeight = 32;
    const panelWidth = layout === "full"
      ? content.width
      : Math.min(720, Math.max(480, Math.round(content.width * 0.52)));
    return {
      x: layout === "full" ? 0 : content.width - panelWidth,
      y: menuHeight,
      width: panelWidth,
      height: Math.max(0, content.height - menuHeight),
    };
  }

  function emit(browserInstanceId, type, payload = {}) {
    try {
      const projectId = views.get(browserInstanceId)?.projectId;
      onEvent({ type, browserInstanceId, ...(projectId ? { projectId } : {}), timestamp: new Date().toISOString(), ...payload });
    } catch {
      // Observers must not break the browser host.
    }
  }

  function viewState(browserInstanceId, view) {
    const webContents = view?.webContents;
    const projectId = views.get(browserInstanceId)?.projectId;
    return {
      browserInstanceId,
      ...(projectId ? { projectId } : {}),
      url: typeof webContents?.getURL === "function" ? webContents.getURL() : webContents?.url || "",
      title: typeof webContents?.getTitle === "function" ? webContents.getTitle() : "",
      loading: typeof webContents?.isLoading === "function" ? webContents.isLoading() : false,
      layout,
    };
  }

  function resize() {
    for (const view of views.values()) {
      if (!view.destroyed && typeof view.setBounds === "function") view.setBounds(bounds());
    }
  }

  function assertHost() {
    if (!mainWindow?.contentView || typeof mainWindow.contentView.addChildView !== "function") {
      throw new Error("Electron WebContentsView host is unavailable");
    }
    if (typeof WebContentsView !== "function") throw new Error("Electron WebContentsView is unavailable");
  }

  function policyFor(input) {
    return { allowExternal: input?.allowExternal === true, allowedOrigins: input?.allowedOrigins };
  }

  function attachListeners(browserInstanceId, view, policy) {
    view.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    view.webContents.on?.("will-navigate", (event, nextUrl) => {
      if (!browserUrlAllowed(nextUrl, policy)) event.preventDefault();
    });
    view.webContents.on?.("did-navigate", (_event, nextUrl) => emit(browserInstanceId, "browser.session.navigated", { state: viewState(browserInstanceId, view), url: nextUrl }));
    view.webContents.on?.("did-navigate-in-page", (_event, nextUrl) => emit(browserInstanceId, "browser.session.navigated", { state: viewState(browserInstanceId, view), url: nextUrl }));
    view.webContents.on?.("did-finish-load", () => emit(browserInstanceId, "browser.session.loaded", { state: viewState(browserInstanceId, view) }));
    view.webContents.on?.("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => emit(browserInstanceId, "browser.session.load_failed", { errorCode, errorDescription, url: validatedURL, state: viewState(browserInstanceId, view) }));
    view.webContents.on?.("render-process-gone", (_event, details) => emit(browserInstanceId, "browser.session.crashed", { details, state: viewState(browserInstanceId, view) }));
    view.webContents.on?.("page-title-updated", (_event, title) => emit(browserInstanceId, "browser.session.title", { title, state: viewState(browserInstanceId, view) }));
    view.webContents.on?.("will-download", (_event, item) => emit(browserInstanceId, "browser.session.download_started", { filename: item?.getFilename?.(), url: item?.getURL?.(), state: viewState(browserInstanceId, view) }));
  }

  async function open(input = {}) {
    assertHost();
    const browserInstanceId = String(input.browserInstanceId || "browser");
    const url = String(input.url || "").trim();
    const policy = policyFor(input);
    const resumed = input.resume === true;
    if (!browserUrlAllowed(url, policy)) throw new Error("browser URL is outside the allowed browser policy");
    const existing = views.get(browserInstanceId);
    const requestedProjectPath = input.projectPath ? path.resolve(String(input.projectPath)) : undefined;
    if (existing?.projectId && input.projectId && existing.projectId !== input.projectId && existing.projectPath !== requestedProjectPath) {
      throw new Error("browser session belongs to another project");
    }
    let view = existing?.view;
    if (!view || view.destroyed) {
      view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      view.destroyed = false;
      views.set(browserInstanceId, { view, policy, projectId: String(input.projectId || ""), ...(requestedProjectPath ? { projectPath: requestedProjectPath } : {}) });
      mainWindow.contentView.addChildView(view);
      attachListeners(browserInstanceId, view, policy);
    } else if (input.allowedOrigins !== undefined || input.allowExternal !== undefined) {
      // Reopening an existing instance may intentionally tighten or expand
      // the policy, but always keep the current session's policy explicit.
      const nextPolicy = policyFor(input);
      if (!browserUrlAllowed(url, nextPolicy)) throw new Error("browser URL is outside the allowed browser policy");
      views.set(browserInstanceId, { view, policy: nextPolicy, projectId: existing.projectId || String(input.projectId || ""), ...(requestedProjectPath || existing.projectPath ? { projectPath: requestedProjectPath || existing.projectPath } : {}) });
    }
    layout = input.layout === "full" ? "full" : layout;
    view.setBounds?.(bounds());
    if (resumed) emit(browserInstanceId, "browser.session.reconnecting", { url, resumed: true });
    await view.webContents.loadURL(url);
    const state = viewState(browserInstanceId, view);
    emit(browserInstanceId, "browser.session.opened", { state });
    if (resumed) emit(browserInstanceId, "browser.session.resumed", { state, resumed: true });
    return { opened: true, state };
  }

  function record(browserInstanceId, projectId) {
    const entry = views.get(browserInstanceId);
    if (!entry || entry.view.destroyed) return undefined;
    const normalizedProjectId = projectId ? path.resolve(String(projectId)) : "";
    const samePublicProject = !projectId || !entry.projectId || entry.projectId === projectId;
    const samePathProject = !projectId || !entry.projectPath || entry.projectPath === normalizedProjectId;
    if (!samePublicProject && !samePathProject) throw new Error("browser session belongs to another project");
    return entry;
  }

  async function navigate(browserInstanceId, url, projectId) {
    const entry = record(browserInstanceId, projectId);
    if (!entry) throw new Error("browser session not found");
    if (!browserUrlAllowed(url, entry.policy)) throw new Error("browser URL is outside the allowed browser policy");
    await entry.view.webContents.loadURL(String(url));
    return viewState(browserInstanceId, entry.view);
  }

  async function control(browserInstanceId, action, projectId) {
    const entry = record(browserInstanceId, projectId);
    if (!entry) throw new Error("browser session not found");
    const webContents = entry.view.webContents;
    if (action === "back") webContents.goBack?.();
    else if (action === "forward") webContents.goForward?.();
    else if (action === "reload") webContents.reload?.();
    else throw new Error(`unsupported browser control: ${action}`);
    return viewState(browserInstanceId, entry.view);
  }

  async function execute(browserInstanceId, script, projectId) {
    const entry = record(browserInstanceId, projectId);
    if (!entry) throw new Error("browser session not found");
    if (typeof script !== "string" || !script.trim()) throw new Error("browser script is required");
    const value = await entry.view.webContents.executeJavaScript(script, true);
    return { state: viewState(browserInstanceId, entry.view), value };
  }

  async function screenshot(browserInstanceId, projectId) {
    const entry = record(browserInstanceId, projectId);
    if (!entry) throw new Error("browser session not found");
    if (typeof entry.view.webContents.capturePage !== "function") throw new Error("browser screenshots are unavailable");
    const image = await entry.view.webContents.capturePage();
    return { state: viewState(browserInstanceId, entry.view), dataUrl: image.toDataURL() };
  }

  async function download(browserInstanceId, url, projectId, timeoutMs = 30_000) {
    const entry = record(browserInstanceId, projectId);
    if (!entry) throw new Error("browser session not found");
    if (!browserUrlAllowed(url, entry.policy)) throw new Error("browser URL is outside the allowed browser policy");
    const resolvedProject = path.resolve(String(projectId || ""));
    const downloadRoot = path.join(resolvedProject, ".capybara", "runtime", "browser-downloads", browserInstanceId.replace(/[^a-zA-Z0-9._-]+/g, "_"));
    fs.mkdirSync(downloadRoot, { recursive: true });
    const webContents = entry.view.webContents;
    if (typeof webContents.downloadURL !== "function") throw new Error("browser downloads are unavailable");
    const boundedTimeout = Math.min(120_000, Math.max(500, Number(timeoutMs) || 30_000));
    return await new Promise((resolve, reject) => {
      let settled = false;
      const startedAt = new Date().toISOString();
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        webContents.removeListener?.("will-download", onWillDownload);
        if (error) reject(error); else resolve(value);
      };
      const onWillDownload = (_event, item) => {
        const sourceUrl = typeof item?.getURL === "function" ? item.getURL() : url;
        const rawName = typeof item?.getFilename === "function" ? item.getFilename() : "download.bin";
        const filename = String(rawName || "download.bin").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 180) || "download.bin";
        const destination = path.join(downloadRoot, `${Date.now()}-${filename}`);
        if (destination !== resolvedProject && !destination.startsWith(`${resolvedProject}${path.sep}`)) {
          finish(new Error("browser download path escaped the project boundary"));
          return;
        }
        item.setSavePath?.(destination);
        item.once?.("done", (_doneEvent, state) => {
          const stat = fs.existsSync(destination) ? fs.statSync(destination) : undefined;
          const completedAt = new Date().toISOString();
          if (state !== "completed") {
            finish(new Error(`browser download ${state || "failed"}`));
            return;
          }
          finish(null, {
            url: sourceUrl,
            filename,
            path: destination,
            status: "completed",
            size: stat?.size ?? null,
            startedAt,
            completedAt,
          });
        });
      };
      const timer = setTimeout(() => finish(new Error(`browser download timed out after ${boundedTimeout} ms`)), boundedTimeout);
      webContents.once?.("will-download", onWillDownload);
      if (!webContents.once) webContents.on?.("will-download", onWillDownload);
      try { webContents.downloadURL(url); } catch (error) { finish(error); }
    });
  }

  function close(browserInstanceId) {
    const entry = views.get(browserInstanceId);
    if (!entry) return { closed: false };
    try { mainWindow?.contentView?.removeChildView?.(entry.view); } catch {}
    try { entry.view.webContents?.close?.(); } catch {}
    try { entry.view.webContents?.destroy?.(); } catch {}
    const projectId = entry.projectId;
    views.delete(browserInstanceId);
    emit(browserInstanceId, "browser.session.closed", projectId ? { projectId } : {});
    return { closed: true };
  }

  function closeForProject(projectId) {
    for (const [id, entry] of views.entries()) {
      if (!projectId || entry.projectId === projectId) close(id);
    }
  }
  function closeAll() { for (const id of [...views.keys()]) close(id); }
  function setLayout(next) { layout = next === "full" ? "full" : "side"; resize(); return { layout }; }
  function state(browserInstanceId, projectId) {
    const entry = record(browserInstanceId, projectId);
    return entry ? viewState(browserInstanceId, entry.view) : undefined;
  }

  return { open, navigate, control, execute, screenshot, download, close, closeAll, closeForProject, resize, setLayout, state, list: () => [...views.keys()], browserUrlAllowed };
}

module.exports = { createBrowserSessionHost, browserUrlAllowed };
