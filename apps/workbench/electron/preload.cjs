const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("capybaraDesktop", {
  selectProjectDirectory: () => ipcRenderer.invoke("capybara:pick-project-directory"),
  pickProjectDirectory: () => ipcRenderer.invoke("capybara:pick-project-directory"),
  registerProjectDirectory: (selection) => ipcRenderer.invoke("capybara:register-project-directory", selection),
  listProjects: () => ipcRenderer.invoke("capybara:list-projects"),
  closeProject: (input) => ipcRenderer.invoke("capybara:close-project", input),
  minimizeWindow: () => ipcRenderer.invoke("capybara:window-minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("capybara:window-toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("capybara:window-close"),
  copyText: (input) => ipcRenderer.invoke("capybara:clipboard-write", input),
  prepareProjectDirectory: (input) => ipcRenderer.invoke("capybara:prepare-project-directory", input),
  getProductCapabilityStatus: (input) => ipcRenderer.invoke("capybara:product-capability-status", input),
  runMarketResearch: (input) => ipcRenderer.invoke("capybara:market-research", input),
  loadMarketResearch: (input) => ipcRenderer.invoke("capybara:market-research-load", input),
  readBrowserPage: (input) => ipcRenderer.invoke("capybara:browser-read", input),
  openBrowserSession: (input) => ipcRenderer.invoke("capybara:browser-session-open", input),
  navigateBrowserSession: (input) => ipcRenderer.invoke("capybara:browser-session-navigate", input),
  controlBrowserSession: (input) => ipcRenderer.invoke("capybara:browser-session-control", input),
  getBrowserSessionState: (input) => ipcRenderer.invoke("capybara:browser-session-state", input),
  screenshotBrowserSession: (input) => ipcRenderer.invoke("capybara:browser-session-screenshot", input),
  closeBrowserSession: (input) => ipcRenderer.invoke("capybara:browser-session-close", input),
  projectApi: (input) => ipcRenderer.invoke("capybara:project-api", input),
  getModelSettings: () => ipcRenderer.invoke('capybara:model-settings-get'),
  saveModelSettings: (input) => ipcRenderer.invoke('capybara:model-settings-save', input),
  getApplicationStatus: (input) => ipcRenderer.invoke("capybara:application-status", input),
  startApplication: (input) => ipcRenderer.invoke("capybara:application-start", input),
  stopApplication: (input) => ipcRenderer.invoke("capybara:application-stop", input),
  restartApplication: (input) => ipcRenderer.invoke("capybara:application-restart", input),
  updateApplication: (input) => ipcRenderer.invoke("capybara:application-update", input),
  rollbackApplication: (input) => ipcRenderer.invoke("capybara:application-rollback", input),
  healthCheckApplication: (input) => ipcRenderer.invoke("capybara:application-health", input),
  setApplicationLayout: (input) => ipcRenderer.invoke("capybara:application-layout", input),
  closeApplicationView: (input) => ipcRenderer.invoke("capybara:application-close", input),
  openApplication: (input) => ipcRenderer.invoke("capybara:open-application", input),
  connectRuntime: (input) => ipcRenderer.invoke("capybara:runtime-connect", input),
  listRuntimeSessions: (input) => ipcRenderer.invoke("capybara:runtime-sessions", input),
  listSessionDirectory: (input) => ipcRenderer.invoke("capybara:session-directory", input),
  appendRuntimeMessage: (input) => ipcRenderer.invoke("capybara:runtime-message-append", input),
  sendSessionMessage: (input) => ipcRenderer.invoke("capybara:session-message-send", input),
  sendRuntimeFrame: (input) => ipcRenderer.invoke("capybara:runtime-send", input),
  readMcpInputUrl: (input) => ipcRenderer.invoke("capybara:mcp-input-url-read", input),
  openMcpInputUrl: (input) => ipcRenderer.invoke("capybara:mcp-input-url-open", input),
  closeRuntime: (input) => ipcRenderer.invoke("capybara:runtime-close", input),
  onRuntimeEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("capybara:runtime-event", handler);
    return () => ipcRenderer.removeListener("capybara:runtime-event", handler);
  },
  onRuntimeClosed: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("capybara:runtime-closed", handler);
    return () => ipcRenderer.removeListener("capybara:runtime-closed", handler);
  },
  onApplicationEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("capybara:application-event", handler);
    return () => ipcRenderer.removeListener("capybara:application-event", handler);
  },
  onBrowserEvent: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on("capybara:browser-event", handler);
    return () => ipcRenderer.removeListener("capybara:browser-event", handler);
  },
});
