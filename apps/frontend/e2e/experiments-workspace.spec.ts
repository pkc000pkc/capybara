import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sourceProject = path.resolve(process.cwd(), "../../examples/test-project");
const e2eProject = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-experiment-e2e-"));
let originalUserPreferences: unknown;

fs.cpSync(sourceProject, e2eProject, {
  recursive: true,
  filter: (source) => {
    const relative = path.relative(sourceProject, source).replaceAll("\\", "/");
    return relative !== ".capybara/secrets.json"
      && !relative.startsWith(".capybara/sessions.sqlite")
      && !relative.startsWith(".capybara/experiments.sqlite")
      && !relative.startsWith(".capybara/worktrees/");
  },
});

test.beforeAll(async () => {
  fs.mkdirSync(path.join(e2eProject, "experiments"), { recursive: true });
  fs.mkdirSync(path.join(e2eProject, ".capybara"), { recursive: true });
  fs.writeFileSync(path.join(e2eProject, ".capybara", "experiment-adapter.json"), `${JSON.stringify({
    version: 1,
    runner: { type: "stdio", entry: "experiments/e2e-adapter.mjs" },
    phases: ["evaluate"],
  }, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(e2eProject, "experiments", "e2e-adapter.mjs"), [
    "let input = '';",
    "for await (const chunk of process.stdin) input += chunk;",
    "const request = JSON.parse(input);",
    "process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { score: 1, passed: true, rationale: 'e2e', metrics: {} } }));",
    "",
  ].join("\n"), "utf8");
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
  fs.rmSync(e2eProject, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await fetch("http://localhost:3005/api/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(originalUserPreferences),
  });
});

test("dataset-scoped experiment analysis uses real project data and backend validation", async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await page.locator("#app-experiments-tab").click();
  await expect(page.locator("#experiment-datasets-tab")).toHaveAttribute("aria-selected", "true");

  await page.getByRole("button", { name: "新建数据集" }).click();
  const createDialog = page.getByRole("dialog", { name: "新建数据集" });
  await createDialog.getByLabel("名称").fill("qta-e2e");
  await createDialog.getByLabel("存储类型").selectOption("jsonl");
  await createDialog.getByLabel("评分提示词").fill([
    "Return a JSON object with score, passed, and rationale.",
    "Expected: {{ answer_json }}",
    "Actual: {{ actual_json }}",
  ].join("\n"));
  await createDialog.getByRole("button", { name: "创建" }).click();

  await page.getByText("qta-e2e", { exact: true }).click();
  await page.getByRole("button", { name: "新建样本" }).click();
  await page.getByLabel("Question").fill("What does the agent inspect?");
  await page.getByLabel("Thinking").fill("Read the observable trace and compare tool results.");
  await page.getByLabel("Answer").fill("It inspects the local project files.");
  await page.getByRole("combobox", { name: "工具名称" }).fill("read_file");
  await page.getByRole("button", { name: "添加预期工具" }).click();
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "返回数据集列表" }).click();
  await expect(page.getByRole("button", { name: "qta-e2e QTA · v2" })).toBeVisible();

  await page.locator("#experiment-runs-tab").click();
  await expect(page.locator("#experiment-analysis-mode-overall-tab")).toHaveAttribute("aria-selected", "true");
  const datasetSelect = page.getByLabel("实验数据集");
  await expect(datasetSelect).toHaveValue("");
  await expect(page.getByText("先选择一个实验数据集。趋势、对比和单次运行都以该数据集为边界。")).toBeVisible();
  await datasetSelect.selectOption({ label: "qta-e2e · v2 · 1" });
  await expect(page.getByText("这个数据集还没有已完成的实验。")).toBeVisible();

  await page.locator("#experiment-analysis-mode-comparison-tab").click();
  await expect(page.getByText("至少需要同一数据集的两次已完成实验才能对比。")).toBeVisible();
  await page.locator("#experiment-analysis-mode-single-tab").click();
  await expect(page.locator("#experiment-run-list")).toContainText("没有匹配的测试运行");

  await page.getByRole("button", { name: "新建测试运行" }).click();
  const runDialog = page.getByRole("dialog", { name: "新建测试运行" });
  await expect(runDialog.getByRole("button", { name: "加入运行队列" })).toBeEnabled();
  await runDialog.getByRole("button", { name: "加入运行队列" }).click();
  await expect(runDialog).toContainText("project must have a readable Git commit before starting an experiment");

  expect(pageErrors).toEqual([]);
});

test("project evaluator allows a dataset without an LLM scoring prompt", async ({ page }) => {
  await page.goto("/");
  await page.locator("#app-experiments-tab").click();
  await page.getByRole("button", { name: "新建数据集" }).click();
  const createDialog = page.getByRole("dialog", { name: "新建数据集" });
  await createDialog.getByLabel("名称").fill("adapter-e2e");
  await createDialog.getByLabel("存储类型").selectOption("jsonl");
  await createDialog.getByRole("button", { name: "创建" }).click();

  await page.getByText("adapter-e2e", { exact: true }).click();
  await page.getByRole("button", { name: "新建样本" }).click();
  await page.getByLabel("Question").fill("Complete the deterministic environment task.");
  await page.getByLabel("Thinking").fill("Use the project environment tool and preserve observable state.");
  await page.getByLabel("Answer").fill("The project evaluator inspects the environment state.");
  await page.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("已保存", { exact: true })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "返回数据集列表" }).click();

  await page.locator("#experiment-runs-tab").click();
  await page.getByLabel("实验数据集").selectOption({ label: "adapter-e2e · v2 · 1" });
  await page.getByRole("button", { name: "新建测试运行" }).click();
  const runDialog = page.getByRole("dialog", { name: "新建测试运行" });
  await expect(runDialog).toContainText("当前项目使用确定性项目评估器，不需要评分提示词。");
  await expect(runDialog.getByRole("button", { name: "加入运行队列" })).toBeEnabled();
});
