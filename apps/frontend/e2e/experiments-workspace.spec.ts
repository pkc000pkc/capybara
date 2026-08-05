import { expect, test } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error Node 22 exposes node:sqlite; the frontend workspace still targets Node 20 types.
import { DatabaseSync } from "node:sqlite";

const sourceProject = path.resolve(process.cwd(), "../../examples/test-project");
const e2eProject = fs.mkdtempSync(path.join(os.tmpdir(), "capybara-experiment-e2e-"));
let originalUserPreferences: unknown;
const analysisBaselineId = "training-analysis-baseline";
const analysisCandidateId = "training-analysis-candidate";

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
  fs.mkdirSync(path.join(e2eProject, ".capybara", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(e2eProject, ".capybara", "hooks", "experience-extractor.ts"), [
    'import { defineHook } from "@capybara/sdk";',
    "export default defineHook({",
    '  name: "experience-extractor",',
    '  description: "E2E training Hook.",',
    "  enabled: true,",
    '  checkpoint: "after_evaluation",',
    "  trigger() { return true; },",
    '  schedule: { priority: 1, timeoutMs: 1000, onError: "continue" },',
    '  permissions: { variables: "patch" },',
    "  run() { return {}; },",
    "});",
    "",
  ].join("\n"), "utf8");
  const projectQuery = `?projectPath=${encodeURIComponent(e2eProject)}`;
  for (const definition of [
    { name: "training-e2e", path: "datasets/training-e2e.jsonl", tags: ["train"] },
    { name: "testing-e2e", path: "datasets/testing-e2e.jsonl", tags: ["test_normal"] },
  ]) {
    const created = await fetch(`http://localhost:3005/api/datasets${projectQuery}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...definition, storage: "jsonl", scoringPrompt: "" }),
    }).then((response) => response.json()) as { id: string; error?: string };
    if (!created.id) throw new Error(created.error ?? `failed to create ${definition.name}`);
    await fetch(`http://localhost:3005/api/datasets/${created.id}/records${projectQuery}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: `${definition.name} question`, thinking: "reference", answer: "answer", expectedTools: [], metadata: { tags: [] } }),
    });
  }
  const datasets = await fetch(`http://localhost:3005/api/datasets${projectQuery}`).then((response) => response.json()) as { items: Array<{ id: string; name: string }> };
  const trainDatasetId = datasets.items.find((item) => item.name === "training-e2e")?.id;
  const testDatasetId = datasets.items.find((item) => item.name === "testing-e2e")?.id;
  if (!trainDatasetId || !testDatasetId) throw new Error("failed to resolve E2E datasets");
  await fetch(`http://localhost:3005/api/experiments/training${projectQuery}`);
  const database = new DatabaseSync(path.join(e2eProject, ".capybara", "experiments.sqlite"));
  const insertRun = database.prepare(`
    INSERT INTO training_runs (
      id, name, status, config_json, current_case_id, pause_reason, snapshot_id,
      failure_json, created_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, 'completed', ?, NULL, NULL, ?, NULL, ?, ?, ?, ?)
  `);
  const insertCase = database.prepare(`
    INSERT INTO training_cases (
      id, run_id, phase, dataset_id, sample_id, ordinal, status, question, thinking,
      expected_answer, actual_answer, expected_tools_json, actual_tools_json,
      tool_calls_json, usage_json, score, passed, rationale, experiment_run_id,
      experiment_case_id, failure_pause_handled, attempt, failure_json, created_at,
      started_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, 'reference', 'answer', 'answer', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 1, NULL, ?, ?, ?, ?)
  `);
  const config = JSON.stringify({
    trainDatasetId,
    testDatasetId,
    trainLimit: 1,
    testLimit: 1,
    learningMode: "auto",
    reviewScope: "failed",
    pauseOnFailure: false,
    experienceExtractorHook: { hookId: "experience-extractor", parameters: {} },
    timeoutMs: 10_000,
    concurrency: 1,
  });
  const seedRun = (id: string, name: string, timestamp: string, testScore: number, learned: boolean) => {
    const snapshotId = `${id}-snapshot`;
    insertRun.run(id, name, config, snapshotId, timestamp, timestamp, timestamp, timestamp);
    const toolCalls = JSON.stringify([{ callId: `${id}-tool`, name: "appworld_execute", status: "completed", arguments: {}, startedAt: timestamp, completedAt: timestamp, durationMs: 18 }]);
    const usage = JSON.stringify({ inputTokens: 120, outputTokens: 30, totalTokens: 150, cacheReadTokens: 20 });
    insertCase.run(`${id}-train`, id, "training", trainDatasetId, "training-e2e-case", 0, "training-e2e question", "[]", "[]", toolCalls, usage, 1, 1, "passed", timestamp, timestamp, timestamp, timestamp);
    insertCase.run(`${id}-test`, id, "testing", testDatasetId, "testing-e2e-case", 0, "testing-e2e question", JSON.stringify(["appworld_execute"]), JSON.stringify(["appworld_execute"]), toolCalls, usage, testScore, Number(testScore > 0), testScore > 0 ? "passed" : "failed", timestamp, timestamp, timestamp, timestamp);
    database.prepare("INSERT INTO training_variable_baselines (run_id, variable_name, value) VALUES (?, 'agent_identity', 'baseline')").run(id);
    database.prepare("INSERT INTO training_snapshots (id, run_id, variables_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(snapshotId, id, JSON.stringify({ agent_identity: learned ? "baseline\nlearned verification" : "baseline" }), `${id}-hash`, timestamp);
    database.prepare("INSERT INTO training_events (run_id, type, payload_json, created_at) VALUES (?, 'run.status', ?, ?)").run(id, JSON.stringify({ to: "completed" }), timestamp);
    if (learned) {
      const experienceId = `${id}-experience`;
      database.prepare(`
        INSERT INTO experience_candidates (
          id, run_id, source_case_id, source_outcome, hook_id, summary, rationale,
          status, replay_case_id, replay_passed, replay_score, replay_rationale,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'success', 'experience-extractor', 'learned verification', 'e2e', 'applied', ?, 1, 1, 'passed', ?, ?)
      `).run(experienceId, id, `${id}-train`, `${id}-replay`, timestamp, timestamp);
      database.prepare(`
        INSERT INTO experience_patches (
          candidate_id, ordinal, variable_name, base_hash, unified_diff, before_value, after_value
        ) VALUES (?, 0, 'agent_identity', 'base', ?, 'baseline', 'baseline\nlearned verification')
      `).run(experienceId, "diff --git a/variables/agent_identity.txt b/variables/agent_identity.txt\n--- a/variables/agent_identity.txt\n+++ b/variables/agent_identity.txt\n@@ -1,1 +1,2 @@\n baseline\n+learned verification");
    }
  };
  try {
    seedRun(analysisBaselineId, "AppWorld E2E baseline", "2026-08-04T08:00:00.000Z", 0, false);
    seedRun(analysisCandidateId, "AppWorld E2E candidate", "2026-08-05T08:00:00.000Z", 1, true);
  } finally {
    database.close();
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
  fs.rmSync(e2eProject, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await fetch("http://localhost:3005/api/preferences", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(originalUserPreferences),
  });
});

test("training workspace loads real datasets, Hooks, and enforced limits", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await page.locator("#app-experiments-tab").click();
  await page.locator("#experiment-training-tab").click();

  const workspace = page.locator("#experiment-training-workspace");
  await expect(page.locator("#experiment-training-tab")).toHaveAttribute("aria-selected", "true");
  await expect(workspace).toHaveAttribute("data-interactive-preview", "false");
  await workspace.getByRole("button", { name: "新建训练" }).click();
  await expect(workspace.getByLabel("训练历史")).toHaveValue("");
  await expect(workspace.getByRole("option", { name: "新建训练" })).toBeAttached();
  await expect(workspace.getByRole("button", { name: "开始训练" })).toBeEnabled();
  await expect(page.locator("#experiment-training-phase-training")).toContainText("0 / 10");
  await expect(page.locator("#experiment-training-phase-freeze")).toBeDisabled();
  await expect(page.locator("#experiment-training-phase-testing")).toBeDisabled();
  await expect(workspace.getByLabel("实验名称")).toHaveValue("training-e2e -> testing-e2e");
  await workspace.getByLabel("实验名称").fill("AppWorld 纠错学习基线");
  await expect(workspace.getByLabel("实验名称")).toHaveValue("AppWorld 纠错学习基线");
  await expect(workspace.getByLabel("训练分片")).toHaveValue(/.+/);
  await expect(workspace.getByLabel("测试分片")).toHaveValue(/.+/);
  await expect(workspace.getByLabel("训练上限")).toHaveValue("10");
  await expect(workspace.getByLabel("测试上限")).toHaveValue("5");
  const learningMode = workspace.getByRole("radiogroup", { name: "学习模式" });
  await expect(learningMode.getByRole("radio", { name: "人工审核" })).toBeChecked();
  await learningMode.getByRole("radio", { name: "人工编写" }).click();
  await expect(learningMode.getByRole("radio", { name: "人工编写" })).toBeChecked();
  await learningMode.getByRole("radio", { name: "全自动" }).click();
  await expect(learningMode.getByRole("radio", { name: "全自动" })).toBeChecked();
  await learningMode.getByRole("radio", { name: "人工审核" }).click();
  const reviewScope = workspace.getByRole("radiogroup", { name: "人工审核范围" });
  await expect(reviewScope.getByRole("radio", { name: "仅失败经验" })).toBeChecked();
  await reviewScope.getByRole("radio", { name: "全部经验" }).click();
  await expect(reviewScope.getByRole("radio", { name: "全部经验" })).toBeChecked();
  await reviewScope.getByRole("radio", { name: "仅失败经验" }).click();
  await expect(workspace.getByLabel("失败时暂停，等待处理后继续")).toBeChecked();
  await workspace.getByRole("button", { name: "配置经验提取参数" }).click();
  await expect(workspace.getByText("新颖度阈值", { exact: true })).toBeVisible();
  await expect(workspace.getByLabel("经验提取 Hook")).toHaveValue("experience-extractor");

  await page.evaluate(() => {
    window.history.replaceState(window.history.state, "", "/?trainingRun=historical-run&trainingPhase=training");
  });
  await page.reload();
  await expect(page.locator("#app-experiments-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#experiment-training-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#experiment-training-workspace")).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test("training analysis preview exposes trends, comparison, and lifecycle detail", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/");
  await page.locator("#app-experiments-tab").click();
  await page.locator("#experiment-training-analysis-tab").click();

  const preview = page.locator("#experiment-training-analysis-preview");
  await expect(preview).toHaveAttribute("data-static-preview", "false");
  await expect(preview.getByText("真实数据", { exact: true })).toBeVisible();
  await expect(preview.getByRole("tab", { name: "整体趋势" })).toHaveAttribute("aria-selected", "true");
  await expect(preview.getByText("训练历史追溯", { exact: true })).toBeVisible();
  await expect(preview.getByRole("img", { name: "训练历史追溯" })).toBeVisible();
  await expect(preview.getByRole("img", { name: "闭卷质量趋势" })).toBeVisible();

  await preview.getByRole("tab", { name: "训练对比" }).click();
  await expect(preview.getByText("测试样本变化", { exact: true })).toBeVisible();
  await expect(preview.getByText("变量 Diff", { exact: true })).toBeVisible();
  await expect(preview.getByText("提升", { exact: true })).toBeVisible();

  await preview.getByRole("tab", { name: "单次训练" }).click();
  await expect(preview.getByText("训练生命周期", { exact: true })).toBeVisible();
  await expect(preview.getByRole("img", { name: "训练得分与重跑" })).toBeVisible();
  await expect(preview.getByRole("img", { name: "阶段 Token 成本" })).toBeVisible();
  await expect(preview.getByRole("img", { name: "经验转化漏斗" })).toBeVisible();
  await expect(preview.getByRole("img", { name: "工具调用与错误" })).toBeVisible();
  await preview.getByRole("tab", { name: "经验学习" }).click();
  await expect(preview.getByText("经验候选", { exact: true })).toBeVisible();
  await preview.getByRole("tab", { name: "冻结快照" }).click();
  await expect(preview.getByText("训练前", { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "返回训练运行" }).click();
  await expect(page.locator("#experiment-training-tab")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(new RegExp(`trainingRun=${analysisCandidateId}`));
  await page.locator("#experiment-training-workspace").getByRole("button", { name: "查看训练分析" }).click();
  await expect(page.locator("#experiment-training-analysis-tab")).toHaveAttribute("aria-selected", "true");
  await expect(pageErrors).toEqual([]);
});

test("dataset import maps source fields and previews the reference answer", async ({ page }) => {
  const source = path.join(e2eProject, "datasets", "mapped-import.jsonl");
  fs.writeFileSync(source, `${JSON.stringify({
    source_id: "mapped-e2e-1",
    task: { instruction: "Mapped E2E question", reasoning: "Mapped E2E reasoning" },
    result: { answer: "Mapped E2E answer" },
    expected_tools: ["read_file"],
    metadata: { tags: ["mapped"] },
  })}\n`, "utf8");

  await page.goto("/");
  await page.locator("#app-experiments-tab").click();
  await page.getByRole("button", { name: "导入" }).click();
  const dialog = page.getByRole("dialog", { name: "按路径导入数据集" });
  await dialog.getByLabel("数据文件路径").fill(source);
  await dialog.getByRole("button", { name: "读取字段" }).click();

  await expect(dialog.getByLabel("映射 Question")).toHaveValue("/task/instruction");
  await expect(dialog.getByLabel("映射 Thinking")).toHaveValue("/task/reasoning");
  await expect(dialog.getByLabel("映射 Answer")).toHaveValue("/result/answer");
  await expect(dialog.getByText("Mapped E2E answer", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/Answer 均为空/)).toHaveCount(0);

  await dialog.getByRole("button", { name: "导入" }).click();
  await expect(page.getByText("mapped-import", { exact: true })).toBeVisible();
  await page.getByText("mapped-import", { exact: true }).click();
  await expect(page.getByText("Mapped E2E answer", { exact: true })).toBeVisible();
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
