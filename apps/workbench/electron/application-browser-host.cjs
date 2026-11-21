const { URL } = require("node:url");

function localUrlAllowed(value, allowedOrigins = ["http://127.0.0.1"]) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol === "file:") return Boolean(url.pathname);
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return false;
  const origins = Array.isArray(allowedOrigins) && allowedOrigins.length ? allowedOrigins : ["http://127.0.0.1"];
  return origins.some((allowed) => {
    try {
      const expected = new URL(allowed);
      if (expected.protocol !== url.protocol || expected.hostname !== url.hostname) return false;
      return !expected.port || expected.port === url.port;
    } catch { return false; }
  });
}

function createApplicationBrowserHost({ mainWindow, WebContentsView, onEvent = () => undefined } = {}) {
  const views = new Map();
  let layout = "side";

  function bounds() {
    const content = typeof mainWindow?.getContentBounds === "function" ? mainWindow.getContentBounds() : { width: 1440, height: 920 };
    // Keep the Workbench menu bar reachable while the embedded application is
    // open. The browser still owns the complete workspace below it, but the
    // renderer needs a stable place to expose the close-view control.
    const menuHeight = 32;
    const panelWidth = layout === "full" ? content.width : Math.min(520, Math.max(360, Math.round(content.width * 0.32)));
    return { x: layout === "full" ? 0 : content.width - panelWidth, y: menuHeight, width: panelWidth, height: Math.max(0, content.height - menuHeight) };
  }

  function emit(instanceId, type, payload = {}) {
    try { onEvent({ type, instanceId, timestamp: new Date().toISOString(), ...payload }); } catch { /* observers cannot break browser host */ }
  }

  function resize() {
    for (const view of views.values()) {
      if (!view.destroyed && typeof view.setBounds === "function") view.setBounds(bounds());
    }
  }

  async function open(input) {
    const instanceId = String(input?.instanceId || "application");
    const url = String(input?.url || "").trim();
    if (!localUrlAllowed(url, input?.allowedOrigins)) throw new Error("only an allowed local application URL can be opened");
    if (!mainWindow?.contentView || typeof mainWindow.contentView.addChildView !== "function") throw new Error("Electron WebContentsView host is unavailable");
    let view = views.get(instanceId);
    if (!view || view.destroyed) {
      if (typeof WebContentsView !== "function") throw new Error("Electron WebContentsView is unavailable");
      view = new WebContentsView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      view.destroyed = false;
      views.set(instanceId, view);
      mainWindow.contentView.addChildView(view);
      view.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
      view.webContents.on?.("will-navigate", (event, nextUrl) => {
        if (!localUrlAllowed(nextUrl, input?.allowedOrigins)) event.preventDefault();
      });
      view.webContents.on?.("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => emit(instanceId, "application.browser.load_failed", { errorCode, errorDescription, url: validatedURL }));
      view.webContents.on?.("render-process-gone", (_event, details) => emit(instanceId, "application.browser.crashed", { details }));
      view.webContents.on?.("page-title-updated", (_event, title) => emit(instanceId, "application.browser.title", { title }));
      view.webContents.on?.("did-navigate", (_event, nextUrl) => emit(instanceId, "application.browser.navigated", { url: nextUrl }));
    }
    view.setBounds?.(bounds());
    await view.webContents.loadURL(url);
    emit(instanceId, "application.browser.opened", { url, layout });
    return { opened: true, instanceId, url, layout };
  }

  function close(instanceId) {
    const view = views.get(instanceId);
    if (!view) return { closed: false };
    try { mainWindow?.contentView?.removeChildView?.(view); } catch { /* already removed */ }
    try { view.webContents?.close?.(); } catch { /* already closed */ }
    try { view.webContents?.destroy?.(); } catch { /* already destroyed */ }
    views.delete(instanceId);
    emit(instanceId, "application.browser.closed");
    return { closed: true };
  }

  function closeAll() { for (const instanceId of [...views.keys()]) close(instanceId); }
  function setLayout(next) { layout = next === "full" ? "full" : "side"; resize(); return { layout }; }
  function list() { return [...views.keys()]; }

  return { open, close, closeAll, resize, setLayout, list, localUrlAllowed };
}

module.exports = { createApplicationBrowserHost, localUrlAllowed };
