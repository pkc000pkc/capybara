import { expect, test, type Locator } from "@playwright/test";
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

async function editorText(editor: Locator) {
  return editor.evaluate((element) =>
    [...element.querySelectorAll(":scope > .cm-line")]
      .map((line) => line.textContent ?? "")
      .join("\n"),
  );
}

test("resource workspace uses real tool and skill HTTP APIs", async ({ page }) => {
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

  await page.locator("#resource-skills-tab").click();
  const skillTabs = page.getByRole("tablist", { name: "资源详情视图" });
  const skillEvaluationTabs = page.getByRole("tablist", { name: "资源验证视图" });
  await expect(skillTabs.getByRole("tab", { name: "SKILL.md" })).toHaveAttribute("aria-selected", "true");
  const skillEditor = page.getByLabel("SKILL.md 编辑器");
  const original = await editorText(skillEditor);
  await skillEditor.fill(`${original}\nResource workspace E2E marker.\n`);
  const saveMarker = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/api/resources/skills/") &&
      response.status() === 200,
  );
  await skillEditor.press("Control+s");
  await saveMarker;
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await skillEditor.fill(original);
  const restoreOriginal = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/api/resources/skills/") &&
      response.status() === 200,
  );
  await skillEditor.press("Control+s");
  await restoreOriginal;
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();

  await skillEvaluationTabs.getByRole("tab", { name: "预览" }).click();
  await page.getByRole("button", { name: "预览 Skill" }).click();
  await expect(page.getByLabel("渐进式加载结构")).toContainText(/"valid": true/);
  await expect(page.getByLabel("渐进式加载结构")).toContainText(/scripts\/inventory\.mjs/);
  await expect(page.getByLabel("渐进式加载结构")).toContainText(/references\/safety\.md/);

  await page.locator("#resource-harnesses-tab").click();
  await page.getByRole("button", { name: /document-analysis.*1 个 Harness/ }).click();
  const harnessTabs = page.getByRole("tablist", { name: "资源详情视图" });
  const harnessEvaluationTabs = page.getByRole("tablist", { name: "资源验证视图" });
  await harnessTabs.getByRole("tab", { name: "Harness", exact: true }).click();
  const harnessEditor = page.getByLabel("Harness Jinja2 定义");
  const originalHarness = await editorText(harnessEditor);
  await harnessEditor.fill(`${originalHarness}\nResource Harness E2E marker.\n`);
  const saveHarness = page.waitForResponse(
    (response) => response.request().method() === "PUT"
      && response.url().includes("/api/resources/harnesses/")
      && response.status() === 200,
  );
  await harnessEditor.press("Control+s");
  await saveHarness;
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await harnessEditor.fill(originalHarness);
  const restoreHarness = page.waitForResponse(
    (response) => response.request().method() === "PUT"
      && response.url().includes("/api/resources/harnesses/")
      && response.status() === 200,
  );
  await harnessEditor.press("Control+s");
  await restoreHarness;
  await harnessEvaluationTabs.getByRole("tab", { name: "测试" }).click();
  await page.getByRole("button", { name: "运行测试" }).click();
  await expect(page.getByLabel("测试输出")).toContainText(/"matched": true/);
  await expect(page.getByLabel("测试输出")).toContainText(/"type": "experience"/);

  await page.locator("#resource-system-variables-tab").click();
  const systemVariablesPanel = page.locator("#resource-system-variables-panel");
  await page.getByRole("button", { name: /template_level_1/ }).click();
  await expect(systemVariablesPanel.getByLabel("变量类型")).toHaveValue("prompt_template");
  await expect(systemVariablesPanel.locator('[data-language="jinja2"]')).toContainText(
    "builtin.prompts.template_level_2",
  );
  await page.getByRole("button", { name: /resource_loading.*只读/ }).click();
  await expect(page.getByLabel("变量名")).toBeDisabled();
  await expect(systemVariablesPanel.getByLabel("变量类型")).toBeDisabled();
  await expect(page.getByLabel("预设提示词")).toHaveAttribute("contenteditable", "false");
  await expect(page.getByRole("button", { name: "删除系统变量" })).toHaveCount(0);

  await page.getByRole("button", { name: "添加系统变量" }).click();
  await expect(systemVariablesPanel.getByLabel("变量类型")).toHaveValue("text");
  await expect(systemVariablesPanel.getByLabel("作用域")).toHaveValue("session");
  await systemVariablesPanel.getByLabel("变量名").fill("e2e_shared_prompt");
  await systemVariablesPanel.getByLabel("作用域").selectOption("project");
  await systemVariablesPanel.getByLabel("预设提示词").fill("shared value");
  const saveSharedVariable = page.waitForResponse((response) =>
    response.request().method() === "PUT"
      && response.url().includes("/api/resources/system-variables")
      && response.status() === 200,
  );
  await systemVariablesPanel.getByRole("button", { name: "保存", exact: true }).click();
  await saveSharedVariable;
  await expect(page.getByRole("button", { name: /e2e_shared_prompt.*项目共享/ })).toBeVisible();
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

test("Skill marketplace supports search, preview, install, removal, and undo", async ({ page }) => {
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

test("hook resources support editing, testing, creating, and deleting", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[title="已连接"]')).toBeVisible({ timeout: 20_000 });
  await page.locator("#app-resources-tab").click();
  await page.locator("#resource-hooks-tab").click();
  const panel = page.locator("#resource-hooks-panel");
  await expect(page.getByRole("button", { name: /context-compression/ })).toHaveCount(0);

  await page.getByRole("button", { name: "新建 Hook" }).click();
  await page.getByLabel("Hook 名称").fill("e2e-hook");
  await page.getByRole("button", { name: "创建 Hook" }).click();
  await expect.poll(() => fs.existsSync(path.join(resourceProject, "hooks", "e2e-hook.ts"))).toBe(true);
  await panel.getByRole("tab", { name: "函数" }).click();
  const editor = panel.getByLabel("Hook 函数编辑器");
  await expect(editor).toContainText('name: "e2e-hook"');
  await editor.fill((await editorText(editor)).replace(
    'description: "Run project logic after each completed Loop.",',
    'description: "E2E user Hook.",',
  ));
  await panel.getByRole("button", { name: "保存草稿" }).click();
  await expect(panel.getByRole("button", { name: "保存草稿" })).toBeDisabled();

  await panel.getByRole("tab", { name: "测试" }).click();
  await panel.getByRole("button", { name: "运行 Hook" }).click();
  await expect(panel.getByLabel("执行结果")).toContainText('"matched": true');
  page.once("dialog", (dialog) => dialog.accept());
  await panel.getByRole("button", { name: "删除 Hook" }).click();
  await expect(page.getByRole("button", { name: /e2e-hook/ })).toHaveCount(0);
  await expect.poll(() => fs.existsSync(path.join(resourceProject, "hooks", "e2e-hook.ts"))).toBe(false);
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
  const memoryTab = page.locator("#resource-memory-tab");
  const projectSettingsTab = page.locator("#resource-project-settings-tab");
  const settingsTab = page.locator("#resource-system-settings-tab");
  const navigationBox = await navigation.boundingBox();
  const memoryBox = await memoryTab.boundingBox();
  const settingsBox = await settingsTab.boundingBox();
  expect(navigationBox).not.toBeNull();
  expect(memoryBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(settingsBox!.y + settingsBox!.height).toBeCloseTo(
    navigationBox!.y + navigationBox!.height,
    0,
  );
  expect(settingsBox!.y - memoryBox!.y - memoryBox!.height).toBeGreaterThan(100);

  await projectSettingsTab.click();
  const projectSettingsPanel = page.locator("#resource-project-settings-panel");
  await expect(projectSettingsPanel.getByText("运行时设置", { exact: true })).toBeVisible();
  await expect(projectSettingsPanel.getByText("LLM 设置", { exact: true })).toBeVisible();
  await expect(projectSettingsPanel.getByLabel("模型")).toHaveValue("gpt-5");
  await expect(projectSettingsPanel.getByLabel("Base URL")).toHaveValue("https://api.example.com/v1");
  await expect(projectSettingsPanel.getByLabel("协议")).toHaveValue("responses");
  const apiKey = projectSettingsPanel.getByLabel("API Key", { exact: true });
  await expect(apiKey).toHaveValue("");
  await expect(apiKey).toHaveAttribute("type", "password");
  await page.route("**/api/resources/project-settings?**", async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const submitted = route.request().postDataJSON() as {
      max_messages: number;
      llm: { model: string; base_url: string; protocol: string; api_key?: string };
      harness_policy: Record<string, unknown>;
      context: Record<string, unknown>;
    };
    expect(submitted.llm.api_key).toBe("test-ui-key");
    await route.fulfill({
      json: {
        main_template: "main.j2",
        max_messages: submitted.max_messages,
        llm: {
          model: submitted.llm.model,
          base_url: submitted.llm.base_url,
          protocol: submitted.llm.protocol,
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

  await memoryTab.focus();
  await memoryTab.press("End");
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
  await expect(panel.getByLabel(/main\.j2.*Git|Git diff for main\.j2/)).toContainText("builtin.prompts.agent_identity", { timeout: 20_000 });

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
