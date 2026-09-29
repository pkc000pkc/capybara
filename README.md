# Capybara GAIA2 最小工作项目

这是 GAIA2 接入工作区，包含数据边界、运行时原语、信息噪音账本、answer-blind 纠偏和 pass@5 编排；官方 ARE 端到端入口保持为独立适配层：

1. 下载官方 `meta-agents-research-environments/gaia2-cli` 五个标准能力分片；
2. 先解析 Hugging Face 的不可变 commit，再保存数据集来源、版本、大小和 SHA-256 manifest；
3. 使用支持 ZSTD 的 Parquet 读取器抽样解析场景；
4. 检查场景 JSON 的基本结构和事件统计；
5. 输出不含题目正文的 smoke 报告。

`src/scenario_importer.mjs` 是只读 Scenario Adapter：保留官方场景 JSON，抽取 scenario ID、时间信息和事件摘要，不改写原始数据。

`gaia2-runner-manifest.json` 明确记录本阶段实际入口和未配置项；它不是官方 runner 配置，不会被误认为已经具备 GAIA2 评分能力。

P0/P1/P2 的最小运行原语位于 `src/`：`VirtualClock`、`EventBus`、可选文件持久化的 `CheckpointStore`、`tool_contract`、`WriteActionLedger`、`ClarificationGate`、`ReplanController`、`A2AChannel`、`NoiseAdapter`、`trace_normalizer` 和 `VerifierBridge`。它们负责确定性时间推进、事件依赖/去重、恢复形状、effect/idempotency 约束、mutation trace、澄清暂停、父子 replan、子 Agent 协议、可复现故障注入和显式 verifier 边界，不连接模型或真实外部副作用。

## 运行

```powershell
npm install
npm run download
npm run smoke
```

`npm run gate1` 会从五类真实场景各回放一个无模型 dry-run；`npm run preflight` 会校验全部 800 个场景；`npm run verify` 会运行单元测试、Gate 1、抽样 smoke 和完整 preflight。

`npm run real-smoke` 会读取 `gaia2-model-config.json` 指向的外部 `llm-config.txt`，使用其中的 `base_url` 和 `key`，以 `gpt-6-luna` 对五类真实题目各发出 Chat Completions 请求；对 408/429/5xx 和 overloaded 错误默认最多尝试 3 次并指数退避，可用 `GAIA2_MODEL_MAX_ATTEMPTS`、`GAIA2_MODEL_RETRY_BASE_MS`、`GAIA2_MODEL_TIMEOUT_MS` 调整。由于 GAIA1 配置标记为 Responses，而 ARE 官方运行器使用 Chat Completions，本命令明确记录了 `sourceProtocol: responses` 与 `protocol: chat-completions-adapter`。报告写入 `reports/gaia2-real-model-smoke.json`，只记录状态、HTTP 码、尝试次数、响应长度和哈希，不记录模型正文。

`npm run pass5-smoke` 会对 Execution/Search/Adaptability/Time/Ambiguity 各执行 5 个独立 attempt，验证纠错不增加 attempt 数、oracle 事件隔离、写入幂等和 pass@5 聚合。设置 `$env:GAIA2_SMOKE_NOISE='1'` 可启用固定信息噪音 profile，并记录每个 attempt 的独立 `noiseSeed` 和噪音统计。

下载的数据文件存放在 `data/`，默认不会提交到 Git。smoke 报告写入 `reports/gaia2-smoke.json`。

数据源：

- https://huggingface.co/datasets/meta-agents-research-environments/gaia2-cli
- https://github.com/facebookresearch/meta-agents-research-environments

`npm run gate1` 和 `npm run preflight` 不启动模型、不执行应用写操作、不调用官方 judge，也不产生 GAIA2 分数；`npm run real-smoke` 只验证真实模型传输；`npm run official-e2e` 才会进入官方 ARE 的环境、工具和 judge 边界。

## 官方 ARE 端到端冒烟

官方运行器依赖固定版本 `meta-agents-research-environments==1.2.0`。安装到隔离目录（Windows 若系统没有 `python`，先设置 `GAIA2_PYTHON`）：

```powershell
$env:GAIA2_PYTHON = 'C:\path\to\python.exe'
npm run install-official
npm run official-e2e
```

`official-e2e` 默认从官方 execution 分片的第一条题目派生一个最小、确定性的单动作场景，只保留 AgentUserInterface、Contacts 和 Messages，仍由官方 ARE loader、Environment、AppTool 和 event judge 执行；报告要求官方 `macro_success_rate > 0` 才会标记通过。结果写入 `reports/gaia2-official-e2e-smoke.json`，追踪文件写入 `official-results/`，两者均不提交。设置 `GAIA2_E2E_MINIMAL=0` 可运行未裁剪的原始首题。Windows 下的 SIGALRM 兼容处理在 runner 启动代码中完成，不修改官方包源码。

`npm run official-e2e-all` 会按五类 capability 逐个调用官方入口；设置 `GAIA2_E2E_NUM_RUNS=5` 可将每类场景交给官方 runner 执行 5 次，汇总报告写入 `reports/gaia2-official-all-smoke.json`。该命令成本和耗时显著高于本地 pass5 smoke。
