# Capybara GAIA2 最小工作项目

这是 GAIA2 接入的第一阶段工作区，不实现完整 Agent、评分、Agent2Agent 或 Noise，只完成：

1. 下载官方 `meta-agents-research-environments/gaia2-cli` 五个标准能力分片；
2. 先解析 Hugging Face 的不可变 commit，再保存数据集来源、版本、大小和 SHA-256 manifest；
3. 使用支持 ZSTD 的 Parquet 读取器抽样解析场景；
4. 检查场景 JSON 的基本结构和事件统计；
5. 输出不含题目正文的 smoke 报告。

`src/scenario_importer.mjs` 是第一阶段的只读 Scenario Adapter：保留官方场景 JSON，抽取 scenario ID、时间信息和事件摘要，不改写原始数据。

`gaia2-runner-manifest.json` 明确记录本阶段实际入口和未配置项；它不是官方 runner 配置，不会被误认为已经具备 GAIA2 评分能力。

P0/P1/P2 的最小运行原语位于 `src/`：`VirtualClock`、`EventBus`、可选文件持久化的 `CheckpointStore`、`tool_contract`、`WriteActionLedger`、`ClarificationGate`、`ReplanController`、`A2AChannel`、`NoiseAdapter`、`trace_normalizer` 和 `VerifierBridge`。它们负责确定性时间推进、事件依赖/去重、恢复形状、effect/idempotency 约束、mutation trace、澄清暂停、父子 replan、子 Agent 协议、可复现故障注入和显式 verifier 边界，不连接模型或真实外部副作用。

## 运行

```powershell
npm install
npm run download
npm run smoke
```

`npm run gate1` 会从五类真实场景各回放一个无模型 dry-run；`npm run preflight` 会校验全部 800 个场景；`npm run verify` 会运行单元测试、Gate 1、抽样 smoke 和完整 preflight。

`npm run real-smoke` 会读取 `gaia2-model-config.json` 指向的外部 `llm-config.txt`，使用其中的 `base_url` 和 `key`，以 `gpt-6-luna` 对五类真实题目各发出一次 Chat Completions 请求（不重试、不落盘密钥）。由于 GAIA1 配置标记为 Responses，而 ARE 官方运行器使用 Chat Completions，本命令明确记录了 `sourceProtocol: responses` 与 `protocol: chat-completions-adapter`。报告写入 `reports/gaia2-real-model-smoke.json`，只记录状态、HTTP 码、响应长度和哈希，不记录模型正文。

下载的数据文件存放在 `data/`，默认不会提交到 Git。smoke 报告写入 `reports/gaia2-smoke.json`。

数据源：

- https://huggingface.co/datasets/meta-agents-research-environments/gaia2-cli
- https://github.com/facebookresearch/meta-agents-research-environments

`npm run gate1` 和 `npm run preflight` 仍然不启动模型、不执行应用写操作、不调用官方 judge，也不产生 GAIA2 分数；`npm run real-smoke` 只验证真实模型传输，不代表 ARE 环境执行成功或产生分数。
