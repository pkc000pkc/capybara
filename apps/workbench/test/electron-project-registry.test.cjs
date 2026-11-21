const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createProjectRegistry } = require("../electron/project-registry.cjs");

test("project registry registers an empty native directory using only an opaque reference", () => {
  const registry = createProjectRegistry({ refFactory: () => "native-ref:empty", projectFactory: () => "project:empty" });
  const selection = registry.createSelection({ selectedPath: "C:\\private\\empty", displayName: "空目录项目", isEmpty: true });
  assert.deepEqual(selection, {
    projectId: "project:empty",
    displayName: "空目录项目",
    isEmpty: true,
    opaqueDirectoryRef: "native-ref:empty",
  });
  const registration = registry.registerSelection(selection);
  assert.deepEqual(registration, {
    projectId: "project:empty",
    displayName: "空目录项目",
    isEmpty: true,
    source: "native-directory-picker",
  });
  assert.equal("path" in registration, false);
  assert.equal("selectedPath" in registration, false);
});

test("project registry rejects renderer-supplied or expired opaque references", () => {
  const registry = createProjectRegistry({ refFactory: () => "native-ref:known" });
  const selection = registry.createSelection({ selectedPath: "C:\\private\\project", displayName: "项目", isEmpty: false });
  assert.throws(() => registry.registerSelection({ ...selection, opaqueDirectoryRef: "native-ref:unknown" }), /unknown or expired/);
  assert.equal(registry.has(selection.opaqueDirectoryRef), true);
});

test("project registry reuses the same project record when a directory is opened again", () => {
  let ref = 0;
  let project = 0;
  const registry = createProjectRegistry({
    refFactory: () => `native-ref:${++ref}`,
    projectFactory: () => `project:${++project}`,
  });
  const first = registry.createSelection({ selectedPath: "C:\\work\\same", displayName: "第一次名称", isEmpty: false });
  const second = registry.createSelection({ selectedPath: "C:\\work\\same", displayName: "再次打开", isEmpty: false });
  assert.equal(second.projectId, first.projectId);
  assert.equal(second.opaqueDirectoryRef, first.opaqueDirectoryRef);
  assert.equal(registry.snapshot().length, 1);
  assert.equal(registry.getRecord(first.opaqueDirectoryRef).displayName, "再次打开");
});

test("project registry prunes records whose directories no longer exist", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-project-registry-existing-"));
  const storageFile = path.join(root, "projects.json");
  let sequence = 0;
  const registry = createProjectRegistry({ storageFile, refFactory: () => `native-ref:${++sequence}`, projectFactory: () => `project:${sequence}` });
  const existingPath = path.join(root, "existing");
  const missingPath = path.join(root, "missing");
  fs.mkdirSync(existingPath);
  registry.createSelection({ selectedPath: existingPath, displayName: "存在", isEmpty: true });
  registry.createSelection({ selectedPath: missingPath, displayName: "不存在", isEmpty: true });
  assert.equal(registry.listExisting().length, 1);
  assert.equal(registry.listExisting()[0].displayName, "存在");
  fs.mkdirSync(path.join(existingPath, '.capybara'));
  assert.equal(registry.listExisting()[0].isEmpty, true);
  fs.writeFileSync(path.join(existingPath, 'work.txt'), 'created by agent');
  assert.equal(registry.listExisting()[0].isEmpty, false);
});

test("project registry removes a closed project without touching its directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-project-registry-close-"));
  const storageFile = path.join(root, "projects.json");
  const projectPath = path.join(root, "project");
  fs.mkdirSync(projectPath);
  const registry = createProjectRegistry({ storageFile, refFactory: () => "native-ref:close", projectFactory: () => "project:close" });
  const selection = registry.createSelection({ selectedPath: projectPath, displayName: "关闭项目", isEmpty: true });
  assert.equal(registry.remove(selection.opaqueDirectoryRef).projectId, "project:close");
  assert.equal(fs.existsSync(projectPath), true);
  assert.equal(registry.listExisting().length, 0);
});
