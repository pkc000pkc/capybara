const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { inspectDirectory } = require("../electron/directory.cjs");

test("directory inspection accepts an empty local project without reading files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capybara-workbench-"));
  const result = await inspectDirectory(root);
  assert.equal(result.displayName, path.basename(root));
  assert.equal(result.isEmpty, true);
  assert.equal("path" in result, false);
});

test("directory inspection reports immediate entries without recursion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capybara-workbench-"));
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "README.md"), "local project");
  const result = await inspectDirectory(root);
  assert.equal(result.isEmpty, false);
});

test("directory inspection treats the project .capybara directory as system metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "capybara-workbench-"));
  await fs.mkdir(path.join(root, ".capybara"));
  const result = await inspectDirectory(root);
  assert.equal(result.isEmpty, true);
});
