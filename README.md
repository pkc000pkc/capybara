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

下载的数据文件存放在 `data/`，默认不会提交到 Git。smoke 报告写入 `reports/gaia2-smoke.json`。

数据源：

- https://huggingface.co/datasets/meta-agents-research-environments/gaia2-cli
- https://github.com/facebookresearch/meta-agents-research-environments

当前 smoke 只验证数据和场景结构，不启动模型、不执行应用写操作、不调用官方 judge，也不产生 GAIA2 分数。
