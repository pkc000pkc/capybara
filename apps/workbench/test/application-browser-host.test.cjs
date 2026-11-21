const assert = require("node:assert/strict");
const test = require("node:test");
const { createApplicationBrowserHost, localUrlAllowed } = require("../electron/application-browser-host.cjs");

function fakeView() {
  const listeners = new Map();
  return {
    destroyed: false,
    bounds: null,
    webContents: {
      on(type, listener) { listeners.set(type, listener); },
      setWindowOpenHandler() {},
      async loadURL(url) { this.url = url; },
      close() { this.closed = true; },
      destroy() { this.destroyed = true; },
    },
    setBounds(bounds) { this.bounds = bounds; },
  };
}

test("ApplicationBrowserHost embeds only an allowed loopback URL", async () => {
  assert.equal(localUrlAllowed("http://127.0.0.1:4317/", ["http://127.0.0.1"]), true);
  assert.equal(localUrlAllowed("https://example.com/", ["http://127.0.0.1"]), false);
  const children = [];
  const mainWindow = {
    getContentBounds() { return { width: 1200, height: 800 }; },
    contentView: {
      addChildView(view) { children.push(view); },
      removeChildView(view) { children.splice(children.indexOf(view), 1); },
    },
  };
  const events = [];
  const host = createApplicationBrowserHost({ mainWindow, WebContentsView: fakeView, onEvent: (event) => events.push(event) });
  const result = await host.open({ instanceId: "instance:1", url: "http://127.0.0.1:4317/", allowedOrigins: ["http://127.0.0.1"] });
  assert.equal(result.opened, true);
  assert.equal(children.length, 1);
  assert.equal(children[0].bounds.x, 816);
  assert.equal(events.at(-1).type, "application.browser.opened");
  host.setLayout("full");
  assert.equal(children[0].bounds.x, 0);
  assert.equal(children[0].bounds.width, 1200);
  await assert.rejects(() => host.open({ instanceId: "instance:2", url: "https://example.com/" }), /allowed local/);
  assert.equal(host.close("instance:1").closed, true);
  assert.deepEqual(host.list(), []);
});
