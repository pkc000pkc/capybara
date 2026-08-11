import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const e2eProject = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-e2e-"));
let originalUserPreferences: unknown;
fs.cpSync(path.resolve(process.cwd(), "../../examples/test-project"), e2eProject, {
  filter: (source) => !path.basename(source).startsWith("sessions.sqlite"),
  recursive: true,
});
const projectConfigPath = path.join(e2eProject, ".capybara", "config.json");
const projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, "utf8"));
projectConfig.llm = {
  model: "gpt-5",
  base_url: "http://127.0.0.1:3016/v1",
  protocol: "responses",
};
fs.writeFileSync(projectConfigPath, `${JSON.stringify(projectConfig, null, 2)}\n`);
fs.writeFileSync(
  path.join(e2eProject, ".capybara", "secrets.json"),
  '{"version":1,"llm":{"api_key":"local-e2e-only"}}\n',
);

test.beforeAll(async () => {
  const projectInspection = await fetch("http://localhost:3005/api/projects/inspect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: e2eProject }),
  });
  if (!projectInspection.ok) {
    throw new Error(`E2E project inspection failed: ${await projectInspection.text()}`);
  }
  originalUserPreferences = await fetch("http://localhost:3005/api/preferences").then((response) => response.json());
  await fetch("http://localhost:3005/api/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ language: "zh-CN", color_theme: "light" }),
  });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript((projectPath) => {
    localStorage.setItem("capybara-project-path", projectPath);
    localStorage.removeItem("capybara-session-id");
  }, e2eProject);
});

test.afterAll(async () => {
  await fetch("http://127.0.0.1:3005/api/projects/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: e2eProject }),
  });
  fs.rmSync(e2eProject, { recursive: true, force: true });
  await fetch("http://localhost:3005/api/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(originalUserPreferences),
  });
});

test("experiments tab opens the experiment workspace", async ({ page }) => {
  await page.goto("/");

  const experimentsTab = page.getByRole("tab", { name: /实验|Experiments/ });
  await expect(experimentsTab).toBeVisible();
  await experimentsTab.click();

  await expect(experimentsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#experiments-view")).toBeVisible();
  await expect(page.locator("#experiment-navigation")).toBeVisible();
  await expect(page.locator("#experiment-datasets-tab")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#runtime-view")).toBeHidden();
});

test("recall tab opens an empty workspace", async ({ page }) => {
  await page.goto("/");

  const recallTab = page.locator("#app-recall-tab");
  await expect(recallTab).toBeVisible();
  await recallTab.click();

  await expect(recallTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#recall-view")).toBeVisible();
  await expect(page.locator("#recall-view")).toBeEmpty();
  await expect(page.locator("#runtime-view")).toBeHidden();
});

test("runtime UI is driven by the RuntimeLoop WebSocket", async ({ page }) => {
  test.setTimeout(150_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await expect(page.locator('[title="已连接"], [title="Connected"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#context-rendered-panel")).toContainText(
    "You are Capybara",
  );
  const contextReplay = page.locator(
    "#context-rendered-panel [data-context-replay-mode]",
  );
  await expect(contextReplay).toHaveAttribute(
    "data-context-replay-mode",
    "live",
  );
  await expect(page.getByLabel("第 1 / 1 页")).toBeVisible();
  await expect(page.locator("#context-request-tab")).toHaveCount(0);
  await expect(page.locator("[data-render-warnings]")).toContainText(
    "未赋值变量：optionalNote",
  );
  await page.locator("#context-template-tab").click();
  await expect(page.locator("#context-template-panel [data-render-warnings]")).toHaveCount(0);
  await page.locator("#context-rendered-tab").click();
  await expect
    .poll(() =>
      page
        .locator("#context-rendered-panel p")
        .first()
        .evaluate((element) => getComputedStyle(element).whiteSpace),
    )
    .toBe("pre-line");
  await expect(page.locator("#variables-panel")).toContainText("tools");
  await expect(page.locator("#variables-panel")).toContainText("harnesses");
  await expect(page.locator("#variables-panel")).not.toContainText("harness_template");
  await expect(page.getByRole("button", { name: "隐藏系统变量" })).toBeVisible();
  await page.getByRole("button", { name: "隐藏系统变量" }).click();
  await expect(page.locator("#variables-panel").getByText("builtin", { exact: true })).toHaveCount(0);
  await page.locator("#status-tab").click();
  await expect(page.getByRole("button", { name: "显示系统变量" })).toHaveCount(0);
  await page.locator("#variables-tab").click();
  await expect(page.getByRole("button", { name: "显示系统变量" })).toBeVisible();
  await expect(page.locator("#controls-timeline-panel tbody tr")).toHaveCount(4);
  await expect(page.locator("#context-tools-tab")).toHaveText("工具");
  const contextDivider = page.getByRole("separator", {
    name: "调整上下文渲染区宽度",
  });
  const dividerBox = await contextDivider.boundingBox();
  expect(dividerBox).not.toBeNull();
  await page.mouse.move(dividerBox!.x, dividerBox!.y + 20);
  await page.mouse.down();
  await page.mouse.move(dividerBox!.x - 120, dividerBox!.y + 20);
  await page.mouse.up();
  await expect(contextDivider).toHaveAttribute("aria-valuenow", "220");

  const programDivider = page.getByRole("separator", { name: "调整程序区宽度" });
  await programDivider.focus();
  await programDivider.press("Home");
  await expect(programDivider).toHaveAttribute("aria-valuenow", "260");
  await programDivider.press("ArrowLeft");
  await expect(programDivider).toHaveAttribute("aria-valuenow", "276");
  await programDivider.dblclick();
  await expect(programDivider).toHaveAttribute("aria-valuenow", "380");

  const variablesDivider = page.getByRole("separator", {
    name: "调整变量及状态区高度",
  });
  await variablesDivider.focus();
  await variablesDivider.press("Home");
  await expect(variablesDivider).toHaveAttribute("aria-valuenow", "180");
  await variablesDivider.press("ArrowDown");
  await expect(variablesDivider).toHaveAttribute("aria-valuenow", "196");
  await variablesDivider.dblclick();
  await expect(variablesDivider).toHaveAttribute("aria-valuenow", "340");

  await expect(
    page.getByRole("button", { name: "向左滑动页签" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "向右滑动页签" }),
  ).toBeVisible();
  const tabList = page.getByRole("tablist", { name: "上下文内容" });
  await expect.poll(() => tabList.evaluate((element) => element.scrollLeft)).toBe(0);
  await page.getByRole("button", { name: "向右滑动页签" }).click();
  await expect
    .poll(() => tabList.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "向左滑动页签" }),
  ).toBeVisible();
  for (let index = 0; index < 5; index += 1) {
    const next = page.getByRole("button", { name: "向右滑动页签" });
    if ((await next.count()) === 0) break;
    await next.click();
    await page.waitForTimeout(250);
  }
  await expect(
    page.getByRole("button", { name: "向右滑动页签" }),
  ).toHaveCount(0);
  for (let index = 0; index < 5; index += 1) {
    const previous = page.getByRole("button", { name: "向左滑动页签" });
    if ((await previous.count()) === 0) break;
    await previous.click();
    await page.waitForTimeout(250);
  }
  await expect.poll(() => tabList.evaluate((element) => element.scrollLeft)).toBe(0);
  await expect(
    page.getByRole("button", { name: "向左滑动页签" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "向右滑动页签" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "向右滑动页签" }).click();
  await page.locator("#context-memory-tab").click();
  await expect(page.locator("#context-memory-panel")).toContainText("暂无 memory");
  await page.locator("#context-rendered-tab").click();

  await page.getByLabel("输入消息").fill("Playwright 联调消息");
  await page.getByRole("button", { name: "发送" }).click();
  const conversation = page.locator("#conversation-panel");
  await expect(
    conversation.getByRole("log").getByText("Playwright 联调消息", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("输入消息")).not.toContainText("Playwright 联调消息");
  await expect(conversation.locator("article")).toHaveCount(3, { timeout: 25_000 });
  await expect(conversation.locator("article").last()).not.toContainText("正在生成", {
    timeout: 75_000,
  });
  await expect(page.locator('[data-run-status="completed"]')).toBeVisible();
  await expect(
    conversation.locator("article").last().locator("[data-markdown-content]"),
  ).toBeVisible();
  await expect(
    conversation.getByText("Playwright 联调消息", { exact: true }).locator("[data-markdown-content]"),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: "上一页上下文" })).toBeEnabled();
  await page.getByRole("button", { name: "上一页上下文" }).click();
  await expect(contextReplay).toHaveAttribute(
    "data-context-replay-mode",
    "history",
  );
  await expect(page.locator("#context-rendered-panel")).toContainText("历史上下文");
  await expect(page.locator("#context-rendered-panel [data-context-role='system']")).toBeVisible();
  await page.getByRole("button", { name: "回到实时上下文" }).click();
  await expect(contextReplay).toHaveAttribute(
    "data-context-replay-mode",
    "live",
  );

  const completedModelStep = page
    .locator("#controls-timeline-panel tbody tr")
    .filter({ hasText: "模型调用" })
    .last();
  await completedModelStep.getByRole("button", { name: /查看.*详情/ }).click();
  await page.getByRole("tab", { name: "输入", exact: true }).click();
  await expect(
    page.locator("#controls-panel").getByRole("textbox", { name: "步骤详情" }),
  ).toContainText('"messages"');
  await expect(
    page.locator("#controls-panel").getByRole("textbox", { name: "步骤详情" }),
  ).toContainText('"responseFormat": "json"');
  await page.getByRole("button", { name: "关闭步骤详情" }).click();

  await page.locator("#debug-mode-step").click();
  await expect(page.locator("#variables-panel")).toHaveAttribute(
    "data-variable-editable",
    "true",
  );
  await page.locator('button[title="查看 title 的完整内容"]').click();
  await page.getByLabel("变量值编辑器").fill("Playwright 服务端渲染");
  await page.getByRole("button", { name: "应用", exact: true }).click();
  await expect(page.locator("#context-rendered-panel")).toContainText(
    "Playwright 服务端渲染",
  );

  await page.locator("#context-template-tab").click();
  const templateEditor = page.getByLabel("Jinja2 + Markdown 编辑器");
  const originalTemplate = fs.readFileSync(path.join(e2eProject, "main.j2"), "utf8");
  await templateEditor.fill("# {{ task.title }}\n\n来自服务端：{{ agent.name }}");
  await templateEditor.press("Control+s");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
  await page.locator("#context-rendered-tab").click();
  await expect(page.locator("#context-rendered-panel")).toContainText(
    "来自服务端：capybara",
  );
  await page.locator("#context-template-tab").click();
  await page.getByLabel("Jinja2 + Markdown 编辑器").fill(originalTemplate);
  await page.getByLabel("Jinja2 + Markdown 编辑器").press("Control+s");
  await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();

  await page.locator("#context-harnesses-tab").click();
  await page.getByRole("option", { name: "gpt-runtime", exact: true }).click();
  await expect(page.getByLabel("Harness 渲染内容")).toContainText(/structured completion status/);
  await page.getByRole("button", { name: "挂载 Harness" }).first().click();
  const harnessPicker = page.getByRole("dialog", { name: "添加 Harness 到上下文" });
  await harnessPicker.getByLabel("搜索 Harness").fill("version summary");
  await harnessPicker.getByRole("option", { name: /version-summary/ }).click();
  await expect(page.getByLabel("Harness 渲染内容")).toContainText(/planned work/);
  await expect(page.getByLabel("Harness 绑定与诊断")).toContainText(/"source": "user"/);
  await page.getByRole("button", { name: "删除 version-summary" }).click();
  await expect(page.getByRole("option", { name: "version-summary" })).toHaveCount(0);

  await page.locator("#context-tools-tab").click();
  await page.getByRole("button", { name: "添加工具" }).first().click();
  const toolPicker = page.getByRole("dialog", { name: "添加工具到上下文" });
  await expect(toolPicker).toBeVisible();
  await expect(page.locator("#context-tools-panel").getByRole("option", { name: "read_file", exact: true })).toHaveCount(0);
  await toolPicker.getByLabel("搜索工具").fill("read file");
  await toolPicker.getByRole("option", { name: "添加 read_file 到上下文" }).click();
  await expect(toolPicker).toHaveCount(0);
  await expect(page.locator("#context-tools-panel").getByRole("option", { name: "read_file", exact: true })).toBeVisible();
  await page.locator("#context-rendered-tab").click();
  await expect(page.locator("#context-rendered-panel")).toContainText("read_file");
  await page.locator("#context-tools-tab").click();
  await page.getByRole("button", { name: "删除 read_file" }).click();
  await expect(page.getByRole("option", { name: "read_file" })).toHaveCount(0);

  await page.locator("#context-skills-tab").click();
  await page.getByRole("button", { name: "激活 Skill" }).first().click();
  const skillPicker = page.getByRole("dialog", { name: "添加 Skill 到上下文" });
  await skillPicker.getByLabel("搜索 Skills").fill("project files");
  await skillPicker.getByRole("option", { name: /project-files/ }).click();
  await expect(page.getByLabel("Skill 指令")).toContainText("# Project Files");
  await expect(page.locator("#context-skills-panel")).toContainText("project-files:read_file");
  await page.locator("#context-skills-panel").getByRole("button", { name: /references\/safety\.md/ }).click();
  await page.locator("#context-skills-panel").getByRole("button", { name: "加载" }).click();
  await expect(page.getByLabel("references/safety.md")).toContainText(/workspace/i);
  await page.locator("#context-skills-panel").getByRole("button", { name: /scripts\/inventory\.mjs/ }).click();
  await page.getByLabel("脚本 argv JSON 数组").fill('["--max-depth","0","--max-entries","3"]');
  await page.getByRole("button", { name: "运行已注册脚本" }).click();
  await expect(page.getByLabel("scripts/inventory.mjs")).toContainText("entries");
  await page.locator("#context-rendered-tab").click();
  await expect(page.locator("#context-rendered-panel")).toContainText("Project Files");

  await page.locator('[data-debug-action="next-step"]').click();
  const firstStep = page.locator("#controls-timeline-panel tbody tr").first();
  await expect(firstStep.locator("td").nth(1)).not.toHaveText("--");
  await firstStep.getByRole("button", { name: /查看.*详情/ }).click();
  await expect(
    page.locator("#controls-panel").getByRole("textbox", { name: "步骤详情" }),
  ).toContainText('"status": "success"');
  await page.getByRole("button", { name: "关闭步骤详情" }).click();

  await page.locator("#debug-mode-continuous").click();
  await expect(page.locator("#debug-mode-continuous")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.locator('[data-debug-action="run-continuous"]').click();
  const pause = page.locator('[data-debug-action="pause"]');
  await expect(pause).toBeEnabled();
  await pause.click();
  await expect(pause).toHaveAttribute("aria-pressed", "true");

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("projects, sessions, request replay, storage, and clearing stay coordinated", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/");
  await expect(page.locator('[title="已连接"], [title="Connected"]')).toBeVisible({ timeout: 20_000 });

  const projectButton = page.getByRole("button", {
    name: path.basename(e2eProject),
    exact: true,
  });
  await expect(projectButton).toBeVisible();
  if (await projectButton.isDisabled()) {
    await page.locator('[data-debug-action="interrupt"]').click();
    await expect(projectButton).toBeEnabled();
  }
  await projectButton.click();
  await expect(page.getByLabel("项目路径")).toHaveValue(e2eProject);
  await page.getByRole("button", { name: "取消", exact: true }).click();

  await page.getByRole("button", { name: "新增会话" }).click();
  const conversation = page.locator("#conversation-panel");
  await expect(conversation.locator("article")).toHaveCount(1);
  const sessionSelector = page.getByLabel("切换会话");
  const persistedSessionName = await sessionSelector.locator("option:checked").textContent();
  expect(persistedSessionName).toBeTruthy();

  for (const [index, message] of ["第一条持久化请求", "第二条持久化请求"].entries()) {
    await page.getByLabel("输入消息").fill(message);
    await page.getByRole("button", { name: "发送" }).click();
    await expect(
      conversation.getByRole("log").getByText(message, { exact: true }),
    ).toBeVisible();
    await expect(conversation.locator("article")).toHaveCount(3 + index * 2, {
      timeout: 60_000,
    });
    await expect(conversation.locator("article").last()).not.toContainText("正在生成", {
      timeout: 60_000,
    });
    const completedRequests = conversation.getByRole("button", {
      name: /查看请求 request-/,
    });
    await expect(completedRequests).toHaveCount(index + 1, { timeout: 60_000 });
    await expect(completedRequests.last()).toBeEnabled({ timeout: 60_000 });
  }

  const requests = conversation.getByRole("button", { name: /查看请求 request-/ });
  await expect(requests).toHaveCount(2);
  await requests.first().click();
  await expect(requests.first()).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator("#context-rendered-panel [data-context-replay-mode]"),
  ).toHaveAttribute("data-context-replay-mode", "history");
  await requests.last().click();
  await expect(requests.last()).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.locator("#context-rendered-panel [data-context-replay-mode]"),
  ).toHaveAttribute("data-context-replay-mode", "live");

  await page.getByRole("button", { name: "新增会话" }).click();
  await expect(conversation.locator("article")).toHaveCount(1);
  await sessionSelector.selectOption({ label: persistedSessionName! });
  await expect(conversation.locator("article")).toHaveCount(5);

  await page.getByRole("tab", { name: "资源", exact: true }).click();
  await page.getByRole("tab", { name: "项目配置", exact: true }).click();
  await expect(page.getByText("会话存储", { exact: true })).toBeVisible();
  await expect(page.getByText(/个会话$/)).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "清除会话记录" }).click();
  await page.getByRole("tab", { name: "运行时", exact: true }).click();
  await expect(conversation.locator("article")).toHaveCount(1);
  await expect(sessionSelector.locator("option")).toHaveCount(1);
});

test("sending after an interrupted run starts a new request", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.locator('[title="已连接"], [title="Connected"]')).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "新增会话" }).click();

  const conversation = page.locator("#conversation-panel");
  await page.getByLabel("输入消息").fill("开始一个可以被中断的请求");
  await page.getByRole("button", { name: "发送" }).click();
  const interrupt = page.locator('[data-debug-action="interrupt"]');
  await expect(interrupt).toBeEnabled({ timeout: 20_000 });
  await interrupt.click();
  await expect(page.locator('[data-run-status="interrupted"]')).toBeVisible();

  await page.getByLabel("输入消息").fill("中断后重新开始");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(
    conversation.getByRole("log").getByText("中断后重新开始", { exact: true }),
  ).toBeVisible();
  await expect(
    conversation.getByRole("button", { name: /查看请求 request-/ }).last(),
  ).toBeEnabled({ timeout: 60_000 });
  await expect(conversation.locator("article").last()).not.toContainText("正在生成", {
    timeout: 60_000,
  });
});

test("model failures remain visible in the conversation after reload", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.locator('[title="已连接"], [title="Connected"]')).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "新增会话" }).click();

  await page.getByLabel("输入消息").fill("E2E_FORCE_MODEL_ERROR");
  await page.getByRole("button", { name: "发送" }).click();

  const failure = page.locator("[data-chat-failure]");
  await expect(failure).toBeVisible({ timeout: 30_000 });
  await expect(failure).toContainText("运行失败");
  await expect(failure).toContainText("模型传输");
  await expect(failure).toContainText("MODEL_TRANSPORT_ERROR");
  await expect(failure).toContainText("E2E forced model transport failure");
  await expect(page.locator('[data-run-status="failed"]')).toBeVisible();

  await page.reload();
  await expect(page.locator('[title="已连接"], [title="Connected"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("[data-chat-failure]")).toContainText(
    "E2E forced model transport failure",
  );
});

test("model retry progress is visible until the request recovers", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(page.locator('[title="已连接"], [title="Connected"]')).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "新增会话" }).click();

  await page.getByLabel("输入消息").fill("E2E_RETRY_THEN_SUCCEED");
  await page.getByRole("button", { name: "发送" }).click();

  const retry = page.locator("[data-model-retry]");
  await expect(retry).toBeVisible({ timeout: 20_000 });
  await expect(retry).toContainText("2/4");
  await expect(retry).toContainText("HTTP 503");
  await expect(page.locator("[data-model-retry-summary]")).toContainText("2/4");

  const conversation = page.locator("#conversation-panel");
  await expect(conversation).toContainText(
    "Deterministic local response for the Capybara end-to-end test.",
    { timeout: 30_000 },
  );
  await expect(retry).toHaveCount(0);
  await expect(page.locator("[data-model-retry-summary]")).toHaveCount(0);
  await expect(page.locator('[data-run-status="completed"]')).toBeVisible();
});
