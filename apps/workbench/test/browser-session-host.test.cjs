const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { browserUrlAllowed, createBrowserSessionHost } = require("../electron/browser-session-host.cjs");

function fakeView() {
  const listeners = new Map();
  return {
    destroyed: false,
    bounds: null,
    webContents: {
      url: "",
      title: "",
      loading: false,
      on(type, listener) { listeners.set(type, listener); },
      once(type, listener) { listeners.set(type, listener); },
      removeListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
      setWindowOpenHandler() {},
      async loadURL(url) { this.url = url; this.loading = false; listeners.get("did-navigate")?.({}, url); },
      goBack() { this.back = true; },
      goForward() { this.forward = true; },
      reload() { this.reloaded = true; },
      getURL() { return this.url; },
      getTitle() { return this.title; },
      isLoading() { return this.loading; },
      async executeJavaScript(script) { this.lastScript = script; return { title: "Example Domain" }; },
      async capturePage() { return { toDataURL: () => "data:image/png;base64,ZmFrZQ==" }; },
      downloadURL(url) {
        const item = {
          destination: null,
          getURL() { return url; },
          getFilename() { return "report.pdf"; },
          setSavePath(value) {
            this.destination = value;
            fs.mkdirSync(path.dirname(value), { recursive: true });
            fs.writeFileSync(value, "fake report");
          },
          once(type, listener) { if (type === "done") queueMicrotask(() => listener({}, "completed")); },
        };
        listeners.get("will-download")?.({}, item);
      },
      close() { this.closed = true; },
      destroy() { this.destroyed = true; },
    },
    setBounds(bounds) { this.bounds = bounds; },
  };
}

test("BrowserSessionHost enforces external origin policy", () => {
  assert.equal(browserUrlAllowed("https://example.com/", { allowExternal: true, allowedOrigins: ["https://example.com"] }), true);
  assert.equal(browserUrlAllowed("https://evil.example/", { allowExternal: true, allowedOrigins: ["https://example.com"] }), false);
  assert.equal(browserUrlAllowed("https://example.com/", { allowExternal: false, allowedOrigins: ["https://example.com"] }), false);
  assert.equal(browserUrlAllowed("https://example.com/", { allowExternal: false }), false);
});

test("BrowserSessionHost opens and controls a session", async () => {
  const children = [];
  const events = [];
  const mainWindow = {
    getContentBounds() { return { width: 1200, height: 800 }; },
    contentView: {
      addChildView(view) { children.push(view); },
      removeChildView(view) { children.splice(children.indexOf(view), 1); },
    },
  };
  const host = createBrowserSessionHost({ mainWindow, WebContentsView: fakeView, onEvent: (event) => events.push(event) });
  const opened = await host.open({ browserInstanceId: "browser:1", url: "https://example.com/", allowExternal: true, allowedOrigins: ["https://example.com"] });
  assert.equal(opened.opened, true);
  assert.equal(children.length, 1);
  assert.equal(opened.state.url, "https://example.com/");
  assert.equal(events.some((event) => event.type === "browser.session.opened"), true);
  const reopened = await host.open({ browserInstanceId: "browser:1", url: "https://example.com/reopened", allowExternal: true, allowedOrigins: ["https://example.com"] });
  assert.equal(reopened.state.url, "https://example.com/reopened");
  assert.equal(children.length, 1);
  await host.navigate("browser:1", "https://example.com/docs");
  await host.control("browser:1", "reload");
  await host.control("browser:1", "back");
  await host.control("browser:1", "forward");
  const script = await host.execute("browser:1", "document.title");
  assert.equal(script.value.title, "Example Domain");
  const shot = await host.screenshot("browser:1");
  assert.match(shot.dataUrl, /^data:image\/png/);
  await assert.rejects(() => host.navigate("browser:1", "https://evil.example/"), /outside the allowed/);
  assert.equal(host.close("browser:1").closed, true);
  assert.deepEqual(host.list(), []);
});

test("BrowserSessionHost reports a resumed session when rebuilding a missing view", async () => {
  const events = [];
  const mainWindow = {
    getContentBounds() { return { width: 1200, height: 800 }; },
    contentView: { addChildView() {}, removeChildView() {} },
  };
  const host = createBrowserSessionHost({ mainWindow, WebContentsView: fakeView, onEvent: (event) => events.push(event) });
  const resumed = await host.open({
    browserInstanceId: "browser:resumed",
    projectId: "project-resumed",
    url: "https://example.com/recovered",
    allowExternal: true,
    allowedOrigins: ["https://example.com"],
    resume: true,
  });
  assert.equal(resumed.state.url, "https://example.com/recovered");
  assert.equal(events.some((event) => event.type === "browser.session.reconnecting"), true);
  assert.equal(events.some((event) => event.type === "browser.session.resumed"), true);
  host.close("browser:resumed");
});

test("BrowserSessionHost accepts the registered project id and its runtime path alias", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-browser-alias-"));
  const mainWindow = {
    getContentBounds() { return { width: 1200, height: 800 }; },
    contentView: { addChildView() {}, removeChildView() {} },
  };
  const host = createBrowserSessionHost({ mainWindow, WebContentsView: fakeView });
  await host.open({ browserInstanceId: "browser:alias", projectId: "project-id", projectPath: projectDir, url: "https://example.com/", allowExternal: true, allowedOrigins: ["https://example.com"] });
  assert.equal(host.state("browser:alias", "project-id")?.url, "https://example.com/");
  assert.equal(host.state("browser:alias", projectDir)?.url, "https://example.com/");
  await host.navigate("browser:alias", "https://example.com/next", projectDir);
  assert.equal(host.state("browser:alias", "project-id")?.url, "https://example.com/next");
  host.close("browser:alias");
  fs.rmSync(projectDir, { recursive: true, force: true });
});

test("BrowserSessionHost downloads into the project boundary", async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-browser-download-"));
  const mainWindow = {
    getContentBounds() { return { width: 1200, height: 800 }; },
    contentView: { addChildView() {}, removeChildView() {} },
  };
  const host = createBrowserSessionHost({ mainWindow, WebContentsView: fakeView });
  await host.open({ browserInstanceId: "browser:download", projectId: projectDir, url: "https://example.com/", allowExternal: true, allowedOrigins: ["https://example.com"] });
  const result = await host.download("browser:download", "https://example.com/report.pdf", projectDir, 5_000);
  assert.equal(result.status, "completed");
  assert.ok(result.path.startsWith(path.join(projectDir, ".capybara")));
  assert.equal(fs.readFileSync(result.path, "utf8"), "fake report");
  host.close("browser:download");
  fs.rmSync(projectDir, { recursive: true, force: true });
});
