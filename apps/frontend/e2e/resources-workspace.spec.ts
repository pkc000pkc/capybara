import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const resourceProject = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-resources-e2e-"));
const backendPort = Number(process.env.CAPYBARA_E2E_BACKEND_PORT ?? 3005);
const backendUrl = `http://localhost:${backendPort}`;
let originalUserPreferences: unknown;
fs.cpSync(path.resolve(process.cwd(), "../../examples/test-project"), resourceProject, {
  filter: (source) => !path.basename(source).startsWith("sessions.sqlite"),
  recursive: true,
});
const resourceProjectConfigFile = path.join(resourceProject, ".capybara", "config.json");
const resourceProjectConfig = JSON.parse(fs.readFileSync(resourceProjectConfigFile, "utf8"));
fs.writeFileSync(resourceProjectConfigFile, `${JSON.stringify({
  ...resourceProjectConfig,
  resource_format: 2,
  plugins: [],
}, null, 2)}\n`);
fs.writeFileSync(path.join(resourceProject, "capybara.plugin.json"), `${JSON.stringify({
  schemaVersion: 1,
  id: "project",
  name: "Project",
  description: "Resources owned directly by this E2E project.",
  version: "1.0.0",
  resources: {
    variables: ".capybara/system-variables.json",
    hooks: ["hooks"],
    trainingHooks: ["training-hooks"],
  },
  toolDependencies: [{ package: "project-files", version: "^1.0.0" }],
}, null, 2)}\n`);

test.beforeAll(async () => {
  originalUserPreferences = await fetch(`${backendUrl}/api/preferences`).then((response) => response.json());
  await fetch(`${backendUrl}/api/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language: "zh-CN", color_theme: "light" }),
  });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((projectPath) => {
    localStorage.setItem("capybara-project-path", projectPath);
    localStorage.removeItem("capybara-session-id");
  }, resourceProject);
});

test.afterEach(async ({ page }) => {
  await page.close();
});

test.afterAll(async () => {
  await fetch(`${backendUrl}/api/projects/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: resourceProject }),
  });
  try {
    fs.rmSync(resourceProject, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
  }
  await fetch(`${backendUrl}/api/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(originalUserPreferences),
  });
});

test("resource workspace combines plugins and keeps tools independently manageable", async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.locator('[title="已连接"]')).toBeVisible({ timeout: 20_000 });
  await page.locator("#app-resources-tab").click();
  await page.locator("#resource-tools-tab").click();

  await expect(page.getByRole("button", { name: /project-files.*8 个工具/ })).toBeVisible();
  const detailTabs = page.getByRole("tablist", { name: "资源详情视图" });
  const evaluationTabs = page.getByRole("tablist", { name: "资源验证视图" });
  await expect(detailTabs.getByRole("tab", { name: "文件" })).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("button", {
      name: /^tools\/files\/manifest\.json manifest$/,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^tools\/files\/runner\.mjs runner$/ }),
  ).toBeVisible();

  await detailTabs.getByRole("tab", { name: "工具" }).click();
  await expect(page.getByRole("button", { name: /read_file/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /delete_file/ })).toBeVisible();
  await evaluationTabs.getByRole("tab", { name: "测试" }).click();
  await expect(detailTabs.getByRole("tab", { name: "工具" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: /read_file/ })).toBeVisible();
  await expect(page.getByLabel("测试输入")).toContainText(/config\.json/);
  await expect(page.getByLabel("测试输入")).toHaveAttribute("contenteditable", "true");
  await expect(page.locator('[data-language="json"] .tok-propertyName').first()).toBeVisible();
  await page.getByRole("button", { name: "运行测试" }).click();
  await expect(page.getByLabel("测试输出")).toContainText(/"ok": true/);
  await expect(page.getByLabel("测试输出")).toContainText(/max_tool_rounds/);

  await detailTabs.getByRole("tab", { name: "文件" }).click();
  const runnerFile = page.getByRole("button", {
    name: /^tools\/files\/runner\.mjs runner$/,
  });
  await expect(runnerFile).toBeVisible();
  await runnerFile.click();
  await expect(page.getByLabel("文件内容")).toContainText(/node:fs\/promises/);

  await expect(page.locator("#resource-skills-tab")).toHaveCount(0);
  await expect(page.locator("#resource-harnesses-tab")).toHaveCount(0);
  await expect(page.locator("#resource-hooks-tab")).toHaveCount(0);
  await expect(page.locator("#resource-memory-tab")).toHaveCount(0);

  await page.locator("#resource-plugins-tab").click();
  const pluginPanel = page.locator("#resource-plugins-panel");
  await expect(page.locator('[data-plugin-id="capybara-system"]')).toBeVisible();
  await expect(page.locator('[data-plugin-id="project"]')).toBeVisible();
  await expect(page.locator('[data-plugin-id="project-files"]')).toHaveCount(0);
  await expect(page.locator('[data-plugin-id="document-analysis"]')).toHaveCount(0);

  await page.locator('[data-plugin-id="capybara-system"]').click();
  await pluginPanel.getByRole("tab", { name: "变量" }).click();
  await expect(pluginPanel.getByText("dynamic_context", { exact: true })).toBeVisible();
  await expect(pluginPanel.getByText("resource_loading", { exact: true })).toHaveCount(0);
  await expect(pluginPanel.getByText("系统依赖", { exact: true })).toBeVisible();

  await page.locator('[data-plugin-id="project"]').click();
  await pluginPanel.getByRole("tab", { name: "变量" }).click();
  await expect(pluginPanel.getByText("resource_loading", { exact: true })).toBeVisible();
  await expect(pluginPanel.getByRole("button", { name: "移除 resource_loading 依赖" })).toBeVisible();

  await pluginPanel.getByRole("tab", { name: "Harness" }).click();
  await expect(pluginPanel.getByText("document-analysis:version-summary", { exact: true })).toBeVisible();

  await pluginPanel.getByRole("tab", { name: "工具" }).click();
  await expect(pluginPanel.getByText("project-files", { exact: true })).toBeVisible();
  await expect(pluginPanel.getByText("已安装", { exact: true }).first()).toBeVisible();

  await pluginPanel.getByRole("button", { name: "管理工具" }).click();
  await expect(page.locator("#resource-tools-panel")).toBeVisible();

  await page.locator("#resource-system-variables-tab").click();
  const systemVariablesPanel = page.locator("#resource-system-variables-panel");
  await page.getByRole("button", { name: /template_level_1/ }).click();
  await expect(systemVariablesPanel.getByLabel("变量类型")).toHaveValue("prompt_template");
  await expect(systemVariablesPanel.locator('[data-language="jinja2"]')).toContainText(
    "builtin.prompts.template_level_2",
  );
  const promptFragment = systemVariablesPanel.getByLabel("Jinja2 注入片段");
  await promptFragment.fill("前缀：{{ builtin.variables.template_level_1 }}；后缀");
  await systemVariablesPanel.getByLabel("默认值").fill("更新后的模板 {{ builtin.prompts.template_level_2 }}");
  await expect(promptFragment).toHaveValue("前缀：{{ builtin.variables.template_level_1 }}；后缀");
  const testValue = systemVariablesPanel.getByLabel("值测试");
  await expect(testValue).toHaveValue("更新后的模板 {{ builtin.prompts.template_level_2 }}");
  await testValue.fill("");
  await expect(testValue).toHaveValue("更新后的模板 {{ builtin.prompts.template_level_2 }}");
  const renderedPreview = systemVariablesPanel.locator('section[aria-label="提示词渲染预览"] pre');
  await expect(renderedPreview).toContainText("前缀：");
  await expect(renderedPreview).toContainText("后缀");
  await page.getByRole("button", { name: /resource_loading.*只读/ }).click();
  await expect(page.getByLabel("变量名")).toBeDisabled();
  await expect(systemVariablesPanel.getByLabel("变量类型")).toBeDisabled();
  await expect(page.getByLabel("默认值")).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "删除系统变量" })).toHaveCount(0);

  await page.getByRole("button", { name: "添加系统变量" }).click();
  await expect(systemVariablesPanel.getByLabel("变量类型")).toHaveValue("text");
  await expect(systemVariablesPanel.getByLabel("作用域")).toHaveValue("session");
  await systemVariablesPanel.getByLabel("变量名").fill("e2e_shared_prompt");
  await systemVariablesPanel.getByLabel("作用域").selectOption("project");
  await systemVariablesPanel.getByLabel("默认值").fill("shared value");
  const saveSharedVariable = page.waitForResponse((response) =>
    response.request().method() === "PUT"
      && response.url().includes("/api/resources/system-variables")
      && response.status() === 200,
  );
  await systemVariablesPanel.getByRole("button", { name: "保存", exact: true }).click();
  await saveSharedVariable;
  await expect(page.getByRole("button", { name: /e2e_shared_prompt.*项目共享/ })).toBeVisible();
  await systemVariablesPanel.getByRole("button", { name: "设为只读" }).click();
  await expect(systemVariablesPanel.getByLabel("默认值")).toHaveAttribute("contenteditable", "false");
  await systemVariablesPanel.getByRole("button", { name: "编辑只读变量" }).click();
  await expect(systemVariablesPanel.getByLabel("默认值")).toHaveAttribute("contenteditable", "true");
  await systemVariablesPanel.getByLabel("默认值").fill("edited while unlocked");
  const saveUnlockedVariable = page.waitForResponse((response) =>
    response.request().method() === "PUT"
      && response.url().includes("/api/resources/system-variables")
      && response.status() === 200,
  );
  await systemVariablesPanel.getByRole("button", { name: "保存", exact: true }).click();
  await saveUnlockedVariable;
  await expect(systemVariablesPanel.getByLabel("默认值")).toContainText("edited while unlocked");
  await systemVariablesPanel.getByRole("button", { name: "删除系统变量" }).click();
  const deleteSharedVariable = page.waitForResponse((response) =>
    response.request().method() === "PUT"
      && response.url().includes("/api/resources/system-variables")
      && response.status() === 200,
  );
  await systemVariablesPanel.getByRole("button", { name: "保存", exact: true }).click();
  await deleteSharedVariable;

  const systemVariablesUrl = `${backendUrl}/api/resources/system-variables?projectPath=${encodeURIComponent(resourceProject)}`;
  const externalVariables = await fetch(systemVariablesUrl).then((response) => response.json()) as {
    version: 1;
    variables: Array<Record<string, unknown>>;
  };
  const externalSave = await fetch(systemVariablesUrl, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      variables: [...externalVariables.variables, {
        key: "external_refresh_probe",
        type: "text",
        label: "External refresh probe",
        description: "Verifies model-side variable changes refresh Resources.",
        value: "external value",
        required: false,
        readonly: false,
        show_in_status: false,
        scope: "project",
        source: "project",
      }],
    }),
  });
  expect(externalSave.ok).toBe(true);
  await expect(page.getByRole("button", { name: /external_refresh_probe.*项目共享/ })).toBeVisible();

  const cleanupVariables = await fetch(systemVariablesUrl).then((response) => response.json()) as {
    version: 1;
    variables: Array<Record<string, unknown>>;
  };
  const externalCleanup = await fetch(systemVariablesUrl, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      variables: cleanupVariables.variables.filter(
        (variable) => variable.key !== "external_refresh_probe",
      ),
    }),
  });
  expect(externalCleanup.ok).toBe(true);
  await expect(page.getByRole("button", { name: /external_refresh_probe/ })).toHaveCount(0);

  expect(pageErrors).toEqual([]);
});

test("prompt workspace opens the configured main template and follows Jinja2 includes", async ({ page }) => {
  test.setTimeout(60_000);
  const mainFile = path.join(resourceProject, "main.j2");
  const originalMain = fs.readFileSync(mainFile, "utf8");
  const partialFile = path.join(resourceProject, "partials", "e2e.j2");
  fs.mkdirSync(path.dirname(partialFile), { recursive: true });
  fs.writeFileSync(partialFile, "Included prompt content\n", "utf8");
  fs.writeFileSync(mainFile, `{% include "partials/e2e.j2" %}\n${originalMain}`, "utf8");
  try {
    await page.goto("/");
    await expect(page.locator('[title="已连接"]')).toBeVisible({ timeout: 20_000 });
    await page.locator("#app-resources-tab").click();
    await page.locator("#resource-prompts-tab").click();

    const promptsPanel = page.locator("#resource-prompts-panel");
    await expect(promptsPanel).toBeVisible();
    await expect(page.getByRole("button", { name: /main\.j2/ })).toBeVisible();
    await expect(promptsPanel.getByLabel("文件内容")).toContainText('include "partials/e2e.j2"');
    await promptsPanel.getByRole("button", { name: /partials\/e2e\.j2/ }).click();
    await expect(promptsPanel.getByLabel("文件内容")).toContainText("Included prompt content");
  } finally {
    fs.writeFileSync(mainFile, originalMain, "utf8");
    fs.rmSync(partialFile, { force: true });
    try {
      fs.rmSync(path.dirname(partialFile), { recursive: true, force: true });
    } catch {
      // The test fixture cleanup is best effort on Windows file watchers.
    }
  }
});

test("recall workspace exposes rules, test flow, benchmarks, evaluation, and versions", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto("/");
  await expect(page.locator('[title="已连接"]')).toBeVisible({ timeout: 20_000 });
  await page.locator("#app-recall-tab").click();

  const recallView = page.locator("#recall-view");
  await expect(recallView).toBeVisible();
  await expect(recallView.getByLabel("召回规则代码")).toContainText("export async function recall");

  await page.locator("#recall-testing-tab").click();
  await expect(page.locator("#recall-testing-panel").getByText("原始候选")).toBeVisible();
  await expect(page.locator("#recall-testing-panel").getByText("最终注入")).toBeVisible();

  await page.locator("#recall-benchmarks-tab").click();
  await expect(page.locator("#recall-benchmarks-panel").getByText("core-recall", { exact: true }).first()).toBeVisible();

  await page.locator("#recall-evaluation-tab").click();
  await expect(page.locator("#recall-evaluation-panel").getByText("Recall@5").first()).toBeVisible();
  await expect(page.locator("#recall-evaluation-panel").getByText("历史版本演进")).toBeVisible();
  await expect(page.locator("#recall-evaluation-panel").getByText("历史对比数据")).toBeVisible();
  await expect(page.locator("#recall-evaluation-panel").getByText("v8", { exact: true }).first()).toBeVisible();
  await expect(page.locator("#recall-evaluation-panel").getByText("v12", { exact: true }).first()).toBeVisible();

  await page.locator("#recall-versions-tab").click();
  await expect(page.locator("#recall-versions-panel").getByText("发布检查")).toBeVisible();
});

test("plugin tool dependencies are explicit and orphan cleanup requires confirmation", async ({ page }) => {
  test.setTimeout(90_000);
  const pluginProject = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-plugin-e2e-"));
  fs.cpSync(path.resolve(process.cwd(), "../../examples/test-project"), pluginProject, {
    filter: (source) => !path.basename(source).startsWith("sessions.sqlite"),
    recursive: true,
  });
  const writeJson = (relative: string, value: unknown) => {
    const target = path.join(pluginProject, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  const configFile = path.join(pluginProject, ".capybara", "config.json");
  const config = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown>;
  writeJson("capybara.plugin.json", {
    schemaVersion: 1,
    id: "project",
    name: "Project",
    description: "E2E project plugin",
    version: "1.0.0",
    toolDependencies: [{ package: "project-files", version: "^1.0.0" }],
  });
  writeJson("plugins/e2e-addon/capybara.plugin.json", {
    schemaVersion: 1,
    id: "e2e-addon",
    name: "E2E Addon",
    description: "Verifies explicit tool dependency lifecycle",
    version: "1.0.0",
    resources: {
      variables: "variables.json",
      harnesses: ["harnesses/manifest.json"],
      hooks: ["hooks"],
      trainingHooks: ["training-hooks"],
    },
    toolDependencies: [{ package: "e2e-shared", version: "^1.0.0" }],
  });
  writeJson("plugins/e2e-addon/variables.json", {
    version: 1,
    variables: [{
      key: "e2e_plugin_context",
      type: "text",
      label: "E2E plugin context",
      description: "Tracks plugin variable activation.",
      value: "active plugin context",
      required: true,
      readonly: false,
      show_in_status: true,
    }],
  });
  writeJson("plugins/e2e-addon/harnesses/manifest.json", {
    version: 1,
    package: "e2e-addon",
    harnesses: [{
      name: "guidance",
      description: "E2E plugin guidance",
      type: "experience",
      entry: "guidance.j2",
      activation: { keywords: ["e2e"] },
      inputs: ["user_message"],
      requiredTools: [],
    }],
  });
  fs.writeFileSync(path.join(pluginProject, "plugins", "e2e-addon", "harnesses", "guidance.j2"), "E2E guidance\n", "utf8");
  const hookSource = (name: string, checkpoint: "after_loop" | "after_evaluation") => `import { defineHook } from "@capybara-agent/sdk";
export default defineHook({
  name: "${name}",
  description: "E2E plugin Hook.",
  enabled: true,
  checkpoint: "${checkpoint}",
  trigger() { return false; },
  run() { return {}; },
});
`;
  fs.mkdirSync(path.join(pluginProject, "plugins", "e2e-addon", "hooks"), { recursive: true });
  fs.mkdirSync(path.join(pluginProject, "plugins", "e2e-addon", "training-hooks"), { recursive: true });
  fs.writeFileSync(path.join(pluginProject, "plugins", "e2e-addon", "hooks", "runtime-check.ts"), hookSource("runtime-check", "after_loop"), "utf8");
  fs.writeFileSync(path.join(pluginProject, "plugins", "e2e-addon", "training-hooks", "training-check.ts"), hookSource("training-check", "after_evaluation"), "utf8");
  writeJson("tools/e2e-shared/manifest.json", {
    version: 1,
    package: "e2e-shared",
    packageVersion: "1.2.0",
    runner: { type: "stdio", entry: "runner.mjs" },
    tools: [{
      name: "e2e_probe",
      description: "E2E dependency probe",
      permissions: [],
      sideEffects: "none",
      replay: "safe",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object" },
    }],
  });
  fs.writeFileSync(path.join(pluginProject, "tools", "e2e-shared", "runner.mjs"), "process.stdin.resume()\n", "utf8");
  writeJson(".capybara/config.json", {
    ...config,
    resource_format: 2,
    tools: [...(config.tools as string[]), "tools/e2e-shared/manifest.json"],
    plugins: [{ id: "e2e-addon", path: "plugins/e2e-addon", enabled: true }],
  });

  await page.addInitScript((projectPath) => {
    localStorage.setItem("capybara-project-path", projectPath);
    localStorage.removeItem("capybara-session-id");
  }, pluginProject);
  try {
    await page.goto("/");
    await expect(page.locator('[title="已连接"]')).toBeVisible({ timeout: 20_000 });
    await page.locator("#app-resources-tab").click();
    await page.locator("#resource-plugins-tab").click();
    await page.getByRole("button", { name: "新增插件" }).click();
    const createPluginDialog = page.getByRole("dialog", { name: "新增插件" });
    await expect(createPluginDialog.getByLabel("插件源目录")).toHaveCount(0);
    await createPluginDialog.getByLabel("插件名称").fill("e2e-created");
    const createPlugin = page.waitForResponse((response) => (
      response.request().method() === "POST"
        && response.url().includes("/api/resources/plugins?")
        && response.status() === 201
    ));
    await createPluginDialog.getByRole("button", { name: "创建插件" }).click();
    await createPlugin;
    await expect(page.locator('[data-plugin-id="e2e-created"]')).toBeVisible();
    await page.locator('[data-plugin-id="e2e-addon"]').click();
    const pluginPanel = page.locator("#resource-plugins-panel");
    await pluginPanel.getByRole("tab", { name: "变量" }).click();
    await expect(pluginPanel.getByText("e2e_plugin_context", { exact: true })).toBeVisible();
    await pluginPanel.getByRole("button", { name: "添加插件变量" }).click();
    const variableDialog = page.getByRole("dialog", { name: "添加插件变量" });
    await variableDialog.getByLabel("变量名").fill("e2e-plugin-extra");
    await expect(variableDialog.getByText("变量名需以小写字母开头，仅可包含小写字母、数字和下划线。", { exact: true })).toBeVisible();
    await expect(variableDialog.getByLabel("变量名")).toHaveAttribute("aria-invalid", "true");
    await expect(variableDialog.getByRole("button", { name: "保存变量" })).toBeDisabled();
    await variableDialog.getByLabel("变量名").fill("e2e_plugin_extra");
    await variableDialog.getByLabel("显示名称").fill("E2E plugin extra");
    await variableDialog.getByLabel("默认值").fill("extra value");
    const addPluginVariable = page.waitForResponse((response) => (
      response.request().method() === "PUT"
        && response.url().includes("/api/resources/plugins/e2e-addon/variables")
        && response.status() === 200
    ));
    await variableDialog.getByRole("button", { name: "保存变量" }).click();
    await addPluginVariable;
    await expect(pluginPanel.getByText("e2e_plugin_extra", { exact: true })).toBeVisible();
    await pluginPanel.getByRole("button", { name: "编辑变量 e2e_plugin_extra" }).click();
    const editVariableDialog = page.getByRole("dialog", { name: "编辑插件变量" });
    await editVariableDialog.getByLabel("默认值").fill("edited value");
    const editPluginVariable = page.waitForResponse((response) => (
      response.request().method() === "PUT"
        && response.url().includes("/api/resources/plugins/e2e-addon/variables")
        && response.status() === 200
    ));
    await editVariableDialog.getByRole("button", { name: "保存变量" }).click();
    await editPluginVariable;
    await pluginPanel.getByRole("button", { name: "编辑变量 e2e_plugin_extra" }).click();
    const deleteVariableDialog = page.getByRole("dialog", { name: "编辑插件变量" });
    const deletePluginVariable = page.waitForResponse((response) => (
      response.request().method() === "PUT"
        && response.url().includes("/api/resources/plugins/e2e-addon/variables")
        && response.status() === 200
    ));
    await deleteVariableDialog.getByRole("button", { name: "删除变量" }).click();
    await deletePluginVariable;
    await expect(pluginPanel.getByText("e2e_plugin_extra", { exact: true })).toHaveCount(0);
    await pluginPanel.getByRole("tab", { name: "Harness" }).click();
    await pluginPanel.getByRole("button", { name: "创建 Harness" }).click();
    const harnessDialog = page.getByRole("dialog", { name: "创建 Harness 模板" });
    await harnessDialog.getByLabel("名称").fill("editor-guide");
    await harnessDialog.getByLabel("描述").fill("E2E editable Harness");
    await harnessDialog.getByLabel("Harness 模板编辑器").fill("Use concise project language.\n");
    const createHarness = page.waitForResponse((response) => (
      response.request().method() === "POST"
        && response.url().includes("/api/resources/plugins/e2e-addon/harnesses")
        && response.status() === 201
    ));
    await harnessDialog.getByRole("button", { name: "创建 Harness" }).click();
    await createHarness;
    await expect(pluginPanel.getByText("e2e-addon:editor-guide", { exact: true })).toBeVisible();
    await pluginPanel.getByRole("button", { name: "编辑 Harness e2e-addon:editor-guide" }).click();
    const editHarnessDialog = page.getByRole("dialog", { name: "编辑 Harness 模板" });
    await editHarnessDialog.getByLabel("Harness 模板编辑器").fill("Use precise language.\n");
    const saveHarness = page.waitForResponse((response) => (
      response.request().method() === "PUT"
        && response.url().includes("/api/resources/plugins/e2e-addon/harnesses/e2e-addon%3Aeditor-guide")
        && response.status() === 200
    ));
    await editHarnessDialog.getByRole("button", { name: "保存模板" }).click();
    await saveHarness;
    await pluginPanel.getByRole("button", { name: "编辑 Harness e2e-addon:editor-guide" }).click();
    const deleteHarnessDialog = page.getByRole("dialog", { name: "编辑 Harness 模板" });
    const deleteHarness = page.waitForResponse((response) => (
      response.request().method() === "DELETE"
        && response.url().includes("/api/resources/plugins/e2e-addon/harnesses/e2e-addon%3Aeditor-guide")
        && response.status() === 200
    ));
    await deleteHarnessDialog.getByRole("button", { name: "删除 Harness" }).click();
    await deleteHarness;
    await expect(pluginPanel.getByText("e2e-addon:editor-guide", { exact: true })).toHaveCount(0);

    await pluginPanel.getByRole("tab", { name: "Hooks" }).click();
    await pluginPanel.getByRole("button", { name: "创建 Hook" }).click();
    const hookDialog = page.getByRole("dialog", { name: "创建 Hook 脚本" });
    await hookDialog.getByLabel("名称").fill("editor-hook");
    const createHook = page.waitForResponse((response) => (
      response.request().method() === "POST"
        && response.url().includes("/api/resources/plugins/e2e-addon/hooks")
        && response.status() === 201
    ));
    await hookDialog.getByRole("button", { name: "创建 Hook" }).click();
    await createHook;
    await expect(pluginPanel.getByText("e2e-addon:editor-hook", { exact: true })).toBeVisible();
    await pluginPanel.getByRole("button", { name: "编辑 Hook e2e-addon:editor-hook" }).click();
    const editHookDialog = page.getByRole("dialog", { name: "编辑 Hook 脚本" });
    await editHookDialog.getByLabel("Hook 脚本编辑器").fill(hookSource("editor-hook", "after_loop"));
    const saveHook = page.waitForResponse((response) => (
      response.request().method() === "PUT"
        && response.url().includes("/api/resources/plugins/e2e-addon/hooks/e2e-addon%3Aeditor-hook")
        && response.status() === 200
    ));
    await editHookDialog.getByRole("button", { name: "保存脚本" }).click();
    await saveHook;
    await pluginPanel.getByRole("button", { name: "编辑 Hook e2e-addon:editor-hook" }).click();
    const deleteHookDialog = page.getByRole("dialog", { name: "编辑 Hook 脚本" });
    const deleteHook = page.waitForResponse((response) => (
      response.request().method() === "DELETE"
        && response.url().includes("/api/resources/plugins/e2e-addon/hooks/e2e-addon%3Aeditor-hook")
        && response.status() === 200
    ));
    await deleteHookDialog.getByRole("button", { name: "删除 Hook" }).click();
    await deleteHook;
    await expect(pluginPanel.getByText("e2e-addon:editor-hook", { exact: true })).toHaveCount(0);

    await pluginPanel.getByRole("tab", { name: "工具" }).click();
    await expect(pluginPanel.getByText("e2e-shared", { exact: true })).toBeVisible();
    await expect(pluginPanel.getByText("要求 ^1.0.0 · 已安装 1.2.0", { exact: true })).toBeVisible();
    await pluginPanel.getByRole("switch", { name: "禁用插件" }).click();
    await expect(pluginPanel.getByRole("switch", { name: "启用插件" })).toBeVisible();
    await pluginPanel.getByRole("tab", { name: "Harness" }).click();
    await expect(pluginPanel.getByText("e2e-addon:guidance", { exact: true })).toBeVisible();
    await pluginPanel.getByRole("tab", { name: "Hooks" }).click();
    await expect(pluginPanel.getByText("e2e-addon:runtime-check", { exact: true })).toBeVisible();
    await expect(pluginPanel.getByText("e2e-addon:training-check", { exact: true })).toBeVisible();

    await page.locator("#app-runtime-tab").click();
    await page.locator("#plugins-tab").click();
    const runtimePlugin = page.locator('#plugins-tabpanel [data-plugin-id="e2e-addon"]');
    await expect(runtimePlugin).toContainText("已停用");
    await page.locator("#variables-tab").click();
    await page.getByLabel("搜索变量").fill("e2e_plugin_context");
    await expect(page.locator("#variables-tabpanel").getByText("e2e_plugin_context", { exact: true })).toHaveCount(0);

    await page.locator("#app-resources-tab").click();
    await page.locator("#resource-tools-tab").click();
    await page.getByRole("button", { name: /e2e-shared.*1 个工具/ }).click();
    await expect(page.getByTitle("E2E Addon · ^1.0.0")).toHaveText("e2e-addon · 已停用");
    await expect(page.getByRole("button", { name: "卸载工具" })).toBeDisabled();

    await page.locator("#resource-plugins-tab").click();
    await page.locator('[data-plugin-id="e2e-addon"]').click();
    await pluginPanel.getByRole("button", { name: "卸载插件" }).click();
    const uninstallDialog = page.getByRole("dialog", { name: "确认卸载插件" });
    await expect(uninstallDialog).toContainText("e2e-shared");
    await uninstallDialog.getByRole("button", { name: "确认卸载" }).click();

    const orphanDialog = page.getByRole("dialog", { name: "发现无插件依赖的工具" });
    await expect(orphanDialog).toContainText("e2e-shared");
    await expect(fs.existsSync(path.join(pluginProject, "tools", "e2e-shared"))).toBe(true);
    await orphanDialog.getByRole("button", { name: "检查并卸载" }).click();
    await expect(orphanDialog.getByRole("checkbox")).toBeChecked();
    await orphanDialog.getByRole("button", { name: "卸载选中工具 (1)" }).click();
    await expect(orphanDialog).toHaveCount(0);
    await expect.poll(() => fs.existsSync(path.join(pluginProject, "tools", "e2e-shared"))).toBe(false);
  } finally {
    await fetch(`${backendUrl}/api/projects/release`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: pluginProject }),
    });
    fs.rmSync(pluginProject, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test.skip("legacy Skill marketplace remains available to backend compatibility tests", async ({ page }) => {
  test.setTimeout(60_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const catalogUrl = `${backendUrl}/api/resources/catalog?projectPath=${encodeURIComponent(resourceProject)}`;
  const baseCatalog = await fetch(catalogUrl).then((response) => response.json()) as {
    revision: string;
    items: Array<Record<string, unknown>>;
  };
  let installed = false;
  const content = [
    "---",
    "name: marketplace-test",
    "description: Verify the complete Skill marketplace flow",
    "allowed-tools: read_file",
    "---",
    "# Marketplace test",
    "",
    "Inspect project files safely.",
    "",
  ].join("\n");
  const skillModule = {
    id: "skill-module:marketplace-test",
    kind: "skill",
    package: "marketplace-test",
    name: "marketplace-test",
    version: 1,
    source: "skills/marketplace-test/SKILL.md",
    enabled: true,
    revision: "marketplace-rev",
    diagnostics: [],
    files: [{
      path: "skills/marketplace-test/SKILL.md",
      role: "entry",
      language: "Markdown",
      editable: true,
    }],
    skills: [{
      id: "marketplace-test",
      kind: "skill",
      name: "marketplace-test",
      description: "Verify the complete Skill marketplace flow",
      metadata: {
        "github-repo": "example/skills",
        "github-tree-sha": "1234567890abcdef1234567890abcdef12345678",
      },
      allowedTools: "read_file",
      entry: "skills/marketplace-test/SKILL.md",
      scripts: ["skills/marketplace-test/scripts/check.mjs"],
      references: [],
      assets: [],
      content,
      entryRevision: "entry-rev",
      diagnostics: [],
    }],
  };

  await page.route("**/api/resources/catalog?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        revision: installed ? "catalog-installed" : baseCatalog.revision,
        items: installed ? [...baseCatalog.items, skillModule] : baseCatalog.items,
      }),
    });
  });
  await page.route("**/api/resources/file?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("path") !== "skills/marketplace-test/SKILL.md") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ...skillModule.files[0],
        content,
        revision: "entry-rev",
      }),
    });
  });
  await page.route("**/api/resources/skills/marketplace/installed?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        items: installed ? [{
          id: "marketplace-test",
          path: "skills/marketplace-test",
          managed: true,
          repo: "example/skills",
          requestedPath: "skills/marketplace-test/SKILL.md",
          commit: "1234567890abcdef1234567890abcdef12345678",
          installedAt: "2026-08-12T00:00:00.000Z",
          hasLocalChanges: false,
        }] : [],
      }),
    });
  });
  await page.route("**/api/resources/skills/marketplace/search?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        page: 1,
        items: [{
          description: "Verify the complete Skill marketplace flow",
          namespace: "",
          path: "skills/marketplace-test/SKILL.md",
          repo: "example/skills",
          skillName: "marketplace-test",
          stars: 42,
          installed,
        }],
      }),
    });
  });
  await page.route("**/api/resources/skills/marketplace/preview?*", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        repo: "example/skills",
        requestedPath: "skills/marketplace-test/SKILL.md",
        commit: "1234567890abcdef1234567890abcdef12345678",
        ref: "refs/heads/main",
        skillName: "marketplace-test",
        description: "Verify the complete Skill marketplace flow",
        allowedTools: "read_file",
        metadata: {},
        content,
        files: [
          { path: "SKILL.md", size: content.length, kind: "entry" },
          { path: "scripts/check.mjs", size: 28, kind: "script" },
        ],
        warnings: ["This Skill contains executable scripts."],
      }),
    });
  });
  await page.route("**/api/resources/skills/marketplace/install?*", async (route) => {
    installed = true;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        skill: { id: "marketplace-test", managed: true },
        catalog: { revision: "catalog-installed", items: [...baseCatalog.items, skillModule] },
      }),
    });
  });
  await page.route("**/api/resources/skills/marketplace/restore?*", async (route) => {
    installed = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ restored: true, skillId: "marketplace-test", catalog: { revision: "catalog-restored", items: [...baseCatalog.items, skillModule] } }),
    });
  });
  await page.route("**/api/resources/skills/marketplace-test?*", async (route) => {
    if (route.request().method() !== "DELETE") {
      await route.continue();
      return;
    }
    installed = false;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        id: "trash-marketplace-test",
        skillId: "marketplace-test",
        originalPath: "skills/marketplace-test",
        trashPath: ".capybara/trash/skills/trash-marketplace-test",
        removedAt: "2026-08-12T00:00:00.000Z",
        expiresAt: "2026-08-19T00:00:00.000Z",
        configIndex: 1,
        hadLocalChanges: false,
        catalog: baseCatalog,
      }),
    });
  });

  await page.goto("/");
  await expect(page.locator('[title="已连接"]')).toBeVisible({ timeout: 20_000 });
  await page.locator("#app-resources-tab").click();
  await page.locator("#resource-skills-tab").click();
  await page.getByRole("tab", { name: "GitHub 搜索" }).click();
  await page.getByLabel("搜索 Skill").fill("marketplace");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("button", { name: /marketplace-test.*42.*example\/skills/ })).toBeVisible();
  await page.getByRole("button", { name: /marketplace-test.*42.*example\/skills/ }).click();
  await expect(page.getByText("1 个脚本", { exact: true })).toBeVisible();
  await expect(page.getByLabel("远程 SKILL.md 预览")).toContainText("Marketplace test");

  await page.getByRole("button", { name: "安装到项目" }).click();
  const installDialog = page.getByRole("dialog", { name: "确认安装 Skill" });
  await expect(installDialog).toContainText("example/skills");
  await expect(installDialog).toContainText("skills/marketplace-test");
  await expect(installDialog).toContainText("该 Skill 包含可执行脚本");
  await installDialog.getByRole("button", { name: "确认安装" }).click();
  await expect(page.getByRole("heading", { name: "marketplace-test" })).toBeVisible();
  await expect(page.getByText(/example\/skills.*12345678/)).toBeVisible();

  await page.getByRole("button", { name: "移除 Skill marketplace-test" }).click();
  const uninstallDialog = page.getByRole("dialog", { name: "确认移除 Skill" });
  await expect(uninstallDialog).toContainText("回收区");
  await uninstallDialog.getByRole("button", { name: "卸载" }).click();
  await expect(page.getByRole("status")).toContainText("已从项目移除 marketplace-test");
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByRole("heading", { name: "marketplace-test" })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("resource workspace panes support pointer and keyboard resizing", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[title="已连接"]')).toBeVisible({ timeout: 20_000 });
  await page.locator("#app-resources-tab").click();

  const navigation = page.locator("#resource-navigation");
  const fileList = page.locator("#resource-files-list");
  const navigationHandle = page.getByRole("separator", { name: "调整资源导航宽度" });
  const catalogHandle = page.getByRole("separator", { name: "调整资源列表宽度" });
  const initialNavigationWidth = (await navigation.boundingBox())?.width ?? 0;
  const navigationHandleBox = await navigationHandle.boundingBox();
  expect(navigationHandleBox).not.toBeNull();

  await page.mouse.move(navigationHandleBox!.x, navigationHandleBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(navigationHandleBox!.x + 48, navigationHandleBox!.y + 20);
  await page.mouse.up();
  await expect.poll(async () => (await navigation.boundingBox())?.width ?? 0).toBeGreaterThan(initialNavigationWidth + 40);

  const initialCatalogWidth = (await fileList.boundingBox())?.width ?? 0;
  const catalogHandleBox = await catalogHandle.boundingBox();
  expect(catalogHandleBox).not.toBeNull();
  await page.mouse.move(catalogHandleBox!.x, catalogHandleBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(catalogHandleBox!.x + 56, catalogHandleBox!.y + 20);
  await page.mouse.up();
  await expect.poll(async () => (await fileList.boundingBox())?.width ?? 0).toBeGreaterThan(initialCatalogWidth + 48);

  await navigationHandle.focus();
  await navigationHandle.press("Home");
  await expect(navigationHandle).toHaveAttribute("aria-valuenow", "112");
  await navigationHandle.press("ArrowRight");
  await expect(navigationHandle).toHaveAttribute("aria-valuenow", "128");

  await page.locator("#resource-tools-tab").click();
  await expect(page.locator("#resource-tools-list")).toHaveCSS("width", `${await catalogHandle.getAttribute("aria-valuenow")}px`);

  const moduleList = page.locator("#resource-tools-list");
  const editorPanel = page.locator("#resource-editor-panel");
  const evaluationPanel = page.locator("#resource-evaluation-panel");
  const evaluationHandle = page.getByRole("separator", { name: "调整资源编辑与验证区高度" });
  const moduleListBox = await moduleList.boundingBox();
  const editorPanelBox = await editorPanel.boundingBox();
  const evaluationPanelBox = await evaluationPanel.boundingBox();
  const fullWidthHandleBox = await evaluationHandle.boundingBox();
  expect(moduleListBox).not.toBeNull();
  expect(editorPanelBox).not.toBeNull();
  expect(evaluationPanelBox).not.toBeNull();
  expect(fullWidthHandleBox).not.toBeNull();
  expect(evaluationPanelBox!.x).toBeCloseTo(moduleListBox!.x, 0);
  expect(evaluationPanelBox!.width).toBeGreaterThan(editorPanelBox!.width + moduleListBox!.width);
  expect(fullWidthHandleBox!.x).toBeCloseTo(moduleListBox!.x, 0);
  expect(fullWidthHandleBox!.width).toBeCloseTo(evaluationPanelBox!.width, 0);

  const testInputPanel = page.locator("#resource-test-input-panel");
  const testInputHandle = page.getByRole("separator", { name: "调整测试区左右宽度" });
  const initialTestInputWidth = (await testInputPanel.boundingBox())?.width ?? 0;
  const testInputHandleBox = await testInputHandle.boundingBox();
  expect(testInputHandleBox).not.toBeNull();
  await page.mouse.move(testInputHandleBox!.x, testInputHandleBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(testInputHandleBox!.x + 48, testInputHandleBox!.y + 20);
  await page.mouse.up();
  await expect.poll(async () => (await testInputPanel.boundingBox())?.width ?? 0).toBeGreaterThan(initialTestInputWidth + 40);

  await testInputHandle.focus();
  await testInputHandle.press("Home");
  await expect(testInputHandle).toHaveAttribute("aria-valuenow", "220");
  await testInputHandle.press("ArrowRight");
  await expect(testInputHandle).toHaveAttribute("aria-valuenow", "236");

  const initialEditorHeight = (await editorPanel.boundingBox())?.height ?? 0;
  const evaluationHandleBox = await evaluationHandle.boundingBox();
  expect(evaluationHandleBox).not.toBeNull();
  await page.mouse.move(
    evaluationHandleBox!.x + 20,
    evaluationHandleBox!.y + evaluationHandleBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(evaluationHandleBox!.x + 20, evaluationHandleBox!.y - 48);
  await page.mouse.up();
  await expect.poll(async () => (await editorPanel.boundingBox())?.height ?? 0).toBeLessThan(initialEditorHeight - 40);

  await evaluationHandle.focus();
  await evaluationHandle.press("Home");
  await expect(evaluationHandle).toHaveAttribute("aria-valuenow", "140");
});

test("project configuration is a resource and system settings stays at the bottom", async ({ page }) => {
  const originalPreferences = await fetch(`${backendUrl}/api/preferences`).then((response) => response.json());
  await page.goto("/");
  await expect(page.locator('[title="已连接"]')).toBeVisible({ timeout: 20_000 });

  const appHeader = page.locator("header.app-header");
  await expect(appHeader.getByLabel("语言")).toHaveCount(0);
  await expect(appHeader.getByRole("group", { name: "颜色模式" })).toHaveCount(0);

  await page.locator("#app-resources-tab").click();
  const navigation = page.locator("#resource-navigation");
  const projectSettingsTab = page.locator("#resource-project-settings-tab");
  const settingsTab = page.locator("#resource-system-settings-tab");
  const navigationBox = await navigation.boundingBox();
  const projectSettingsBox = await projectSettingsTab.boundingBox();
  const settingsBox = await settingsTab.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(projectSettingsBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(settingsBox!.y + settingsBox!.height).toBeCloseTo(
    navigationBox!.y + navigationBox!.height,
    0,
  );
  expect(settingsBox!.y - projectSettingsBox!.y - projectSettingsBox!.height).toBeGreaterThan(100);

  await projectSettingsTab.click();
  const projectSettingsPanel = page.locator("#resource-project-settings-panel");
  await expect(projectSettingsPanel.getByText("运行时设置", { exact: true })).toBeVisible();
  await expect(projectSettingsPanel.getByText("LLM 设置", { exact: true })).toBeVisible();
  await expect(projectSettingsPanel.getByLabel("模型")).toHaveValue("gpt-5");
  await expect(projectSettingsPanel.getByLabel("Base URL")).toHaveValue("https://api.example.com/v1");
  await expect(projectSettingsPanel.getByLabel("协议")).toHaveValue("responses");
  await expect(projectSettingsPanel.getByLabel("协议").locator('option[value="codex-like"]'))
    .toHaveText("Codex-like");
  const maxRetries = projectSettingsPanel.getByLabel(/自动重试次数/);
  await expect(maxRetries).toHaveValue("3");
  await expect(projectSettingsPanel.getByText("-1 表示无限重试，重试间隔最长 30 秒", { exact: true })).toBeVisible();
  const apiKey = projectSettingsPanel.getByLabel("API Key", { exact: true });
  await expect(apiKey).toHaveValue("");
  await expect(apiKey).toHaveAttribute("type", "password");
  await page.route("**/api/resources/project-settings?**", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const submitted = route.request().postDataJSON() as {
      max_messages: number;
      max_tool_rounds: number;
      llm: { model: string; base_url: string; protocol: string; max_retries: number; api_key?: string };
      harness_policy: Record<string, unknown>;
      context: Record<string, unknown>;
    };
    expect(submitted.llm.api_key).toBe("test-ui-key");
    expect(submitted.llm.max_retries).toBe(3);
    await route.fulfill({
      json: {
        main_template: "main.j2",
        max_messages: submitted.max_messages,
        max_tool_rounds: submitted.max_tool_rounds,
        llm: {
          model: submitted.llm.model,
          base_url: submitted.llm.base_url,
          protocol: submitted.llm.protocol,
          max_retries: submitted.llm.max_retries,
          api_key: "",
          api_key_configured: true,
        },
        harness_policy: submitted.harness_policy,
        context: submitted.context,
      },
    });
  });
  await apiKey.fill("test-ui-key");
  await projectSettingsPanel.getByRole("button", { name: "显示 API Key" }).click();
  await expect(apiKey).toHaveAttribute("type", "text");
  await projectSettingsPanel.getByRole("button", { name: "保存", exact: true }).click();
  await expect(apiKey).toHaveValue("");
  await expect(apiKey).toHaveAttribute("placeholder", "已配置，输入新值可替换");
  await expect(projectSettingsPanel.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await expect(projectSettingsPanel.getByText("Harness 设置", { exact: true })).toBeVisible();
  await expect(projectSettingsPanel.getByLabel("经验加载上限")).toHaveValue("3");
  await expect(projectSettingsPanel.getByLabel("经验匹配阈值")).toHaveValue("0.35");
  await expect(projectSettingsPanel.getByText("会话存储", { exact: true })).toBeVisible();

  await projectSettingsTab.focus();
  await projectSettingsTab.press("End");
  await expect(settingsTab).toBeFocused();
  await settingsTab.click();

  const settingsPanel = page.locator("#resource-system-settings-panel");
  await expect(settingsPanel.getByText("界面设置", { exact: true })).toBeVisible();
  await expect(settingsPanel.getByText("运行时设置", { exact: true })).toHaveCount(0);
  await expect(settingsPanel.getByLabel("语言")).toBeVisible();
  await expect(settingsPanel.getByRole("group", { name: "颜色模式" })).toBeVisible();

  await settingsPanel.getByRole("button", { name: "深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await settingsPanel.getByRole("button", { name: "浅色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await settingsPanel.getByLabel("语言").selectOption("en");
  await expect(settingsPanel.getByText("Interface settings", { exact: true })).toBeVisible();
  await settingsPanel.getByLabel("Language").selectOption("zh-CN");
  await expect(settingsPanel.getByText("界面设置", { exact: true })).toBeVisible();

  await expect.poll(async () => fetch(`${backendUrl}/api/preferences`)
    .then((response) => response.json()))
    .toMatchObject({ language: "zh-CN", color_theme: "light" });
  await fetch(`${backendUrl}/api/preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(originalPreferences),
  });
});

test("version control initializes, previews, commits, and shows project history", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect(page.locator('[title="已连接"], [title="Connected"]')).toBeVisible({ timeout: 20_000 });
  await page.locator("#app-resources-tab").click();
  await page.locator("#resource-version-control-tab").click();

  const panel = page.locator("#resource-version-control-panel");
  const initializeButton = panel.getByRole("button", { name: /初始化 Git 仓库|Initialize Git repository/ });
  await expect(initializeButton).toBeVisible({ timeout: 20_000 });
  const initialized = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && response.url().includes("/api/resources/git/initialize")
      && response.status() === 200,
  );
  await initializeButton.click();
  await initialized;

  fs.appendFileSync(
    path.join(resourceProject, ".git", "config"),
    "\n[user]\n\tname = Capybara E2E\n\temail = capybara-e2e@example.invalid\n",
    "utf8",
  );

  const mainChange = page.getByLabel(/(?:选择更改|Select change) main\.j2/);
  const datasetChange = page.getByLabel(/(?:选择更改|Select change) \.capybara\/datasets\.json/);
  await expect(mainChange).toBeChecked({ timeout: 20_000 });
  await expect(datasetChange).not.toBeChecked({ timeout: 20_000 });
  await page.getByRole("button", { name: /main\.j2/ }).click();
  await expect(panel.getByLabel(/main\.j2.*Git|Git diff for main\.j2/)).toContainText("builtin.variables.agent_identity", { timeout: 20_000 });

  await panel.getByPlaceholder(/说明本次项目改动|Describe this project change/).fill("feat: initialize test agent");
  const committed = page.waitForResponse((response) =>
    response.request().method() === "POST"
      && response.url().includes("/api/resources/git/commit")
      && response.status() === 200,
  );
  await panel.getByRole("button", { name: /提交所选文件|Commit selected files/ }).click();
  await committed;
  await expect(page.getByLabel(/(?:选择更改|Select change) \.capybara\/datasets\.json/)).not.toBeChecked({ timeout: 20_000 });

  await page.getByRole("tab", { name: /历史|History/ }).click();
  await expect(page.getByRole("button", { name: /feat: initialize test agent/ })).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText("feat: initialize test agent", { exact: true })).toBeVisible({ timeout: 20_000 });
});
