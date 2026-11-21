const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectRegistry } = require("../electron/project-registry.cjs");

test("project registry persists opaque directory references without exposing paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capybara-project-registry-"));
  const storageFile = path.join(root, "projects.json");
  const first = createProjectRegistry({ storageFile, refFactory: () => "native-ref:persisted", projectFactory: () => "project:persisted" });
  const selection = first.createSelection({ selectedPath: path.join(root, "project"), displayName: "持久项目", isEmpty: true });
  const second = createProjectRegistry({ storageFile });
  assert.deepEqual(second.registerSelection(selection), { projectId: "project:persisted", displayName: "持久项目", isEmpty: true, source: "native-directory-picker" });
  const persisted = await fs.readFile(storageFile, "utf8");
  assert.match(persisted, /selectedPath/);
  assert.doesNotMatch(persisted, /fileContents|contents|files/);
});
