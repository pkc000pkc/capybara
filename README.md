# Capybara GAIA2 工作项目

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

`npm run real-smoke` 是历史模型传输诊断，不是当前 ARE Actor/Judge 运行入口；它有自己的旧重试参数，并覆盖共享诊断报告。新的最小模型检查使用 `npm run phase1-model-probe`，分别通过当前 bridge Actor 和 ARE Judge 发出一个真实请求，使用阶段 1 的模型重试策略，结果保存在全新 `runs/phase1-model-probe-*/` 中。凭据读取自外部配置，不进入清单或报告。该检查不执行工具、GAIA2 场景或正式评分。

`npm run pass5-smoke` 会对 Execution/Search/Adaptability/Time/Ambiguity 各执行 5 个独立 attempt，验证纠错不增加 attempt 数、oracle 事件隔离、写入幂等和 pass@5 聚合。设置 `$env:GAIA2_SMOKE_NOISE='1'` 可启用固定信息噪音 profile，并记录每个 attempt 的独立 `noiseSeed` 和噪音统计。

下载的数据文件存放在 `data/`，默认不会提交到 Git。smoke 报告写入 `reports/gaia2-smoke.json`。

数据源：

- https://huggingface.co/datasets/meta-agents-research-environments/gaia2-cli
- https://github.com/facebookresearch/meta-agents-research-environments

`npm run gate1` 和 `npm run preflight` 不启动模型、不执行应用写操作、不调用官方 judge，也不产生 GAIA2 分数；`npm run real-smoke` 只验证真实模型传输；`npm run official-e2e` 才会进入官方 ARE 的环境、工具和 judge 边界。

## 阶段 0 运行基线

`config/phase0-protocol.json` 显式固定数据集 revision、ARE 版本、Actor/Judge 模型、两种评测模式和工作目录。source 数据继续用于内部试运行；submission 数据使用独立缓存，CLI 的 test 标签与官方 validation 标签通过完整 ID/hash 比较记录关系。

```powershell
npm run phase0-freeze-data
npm run phase0-freeze-inventory
npm run phase0-preflight
npm run prepare-run -- --mode internal_pass5 --per-capability 1
npm run prepare-run -- --mode official_submission
npm run phase0-preflight -- --manifest runs/<run-id>/run-manifest.json
```

数据冻结校验固定远端 LFS SHA-256，完整读取 source 800、submission 800 和 mini 160 行。缓存/索引保留在 `data/`，版本和内容摘要提交到 `locks/`。已有缓存可用 `npm run phase0-freeze-data -- --offline` 离线重建锁。

环境冻结记录 Node/Python、依赖版本、ARE 代码树、bridge、主后端和本项目代码内容，并将两个 GAIA2 插件复制为内容寻址快照。资源可读性与实际接线分别记录：当前 TS 插件没有加载，实际执行是 Python bridge 与事后 sidecar。

`prepare-run` 只生成不可覆盖的清单，不调用模型。内部默认生成 25 个初始 attempt；完整官方计划生成 3360 个执行，覆盖 Standard 五类和 A2A/Noise mini，每场景 3 次。每项固定 scenario ID、原始行号、内容 hash、seed 和独立输出/fixture/workspace 路径。

`phase0-preflight` 重验锁定代码、插件快照、数据文件和全部 Parquet 行与索引的关联；检查清单 hash、任务重复、编号、配置和路径隔离。`phase0Passed=true` 仅表示基线验收通过，不表示完整系统或官方提交就绪。四个实验入口现已消费冻结清单。历史阶段 0 锁保留在 `locks/archive/phase0-20261008/`；代码变化后重新冻结环境并创建新 run_id，不能拿旧清单配新锁。

## 阶段 1：冻结清单、长运行与恢复

官方运行器依赖固定版本 `meta-agents-research-environments==1.2.0`。安装到隔离目录（Windows 若系统没有 `python`，先设置 `GAIA2_PYTHON`）：

```powershell
$env:GAIA2_PYTHON = 'C:\path\to\python.exe'
npm run install-official
npm run prepare-run -- --mode internal_pass5 --per-capability 1 --run-id <新的run_id>
npm run official-e2e -- --manifest runs/<新的run_id>/run-manifest.json
```

上述最后一条命令只验证清单和当前冻结输入，不调用模型。`official-e2e`、`official-batch-smoke`、`official-e2e-all`、`official-integrated-pilot` 均必须提供 `--manifest`（或 `GAIA2_RUN_MANIFEST`），默认只读验证。只有显式 `--execute` 才启动任务；`--max-tasks 1` 限制本次最多启动一个任务，不改变冻结选题或编号。

```powershell
# 此命令会调用真实模型并执行原始 ARE 任务，先确认预算。
npm run official-e2e -- --manifest runs/<run_id>/run-manifest.json --execute --max-tasks 1
# 中断任务在全新 session 中重启，已经获得有效 judge 结果的任务不重复。
npm run official-e2e -- --manifest runs/<run_id>/run-manifest.json --execute --resume --max-tasks 1
# 仅当确认服务恢复后，显式允许重启耗尽请求重试的基础设施失败任务。
npm run official-e2e -- --manifest runs/<run_id>/run-manifest.json --execute --resume --retry-infrastructure --max-tasks 1
```

| 参数 | 所有入口的默认值 | 说明 |
|---|---:|---|
| `GAIA2_PROCESS_TIMEOUT_MINUTES` / `GAIA2_PROCESS_TIMEOUT_MS` | 8000 分钟 | MS 优先；0 仅取消外层进程上限 |
| `GAIA2_SCENARIO_TIMEOUT_SECONDS` | 480000 秒 | ARE 场景墙钟上限，独立于原题模拟时间 |
| `GAIA2_MODEL_REQUEST_TIMEOUT_SECONDS` | 60 秒 | Actor/Judge 每个请求的超时 |
| `GAIA2_CONCURRENCY` | 1 | 阶段 1 仅支持串行 |
| `GAIA2_HEARTBEAT_INTERVAL_MS` | 1000 毫秒 | 存活信息，不是进度百分比 |
| `GAIA2_MODEL_MAX_ATTEMPTS` | 6 | 包含首次请求；不是场景或 pass@5 重试次数 |
| `GAIA2_MODEL_BACKOFF_BASE_SECONDS` / `GAIA2_MODEL_BACKOFF_MAX_SECONDS` | 2 / 120 秒 | 指数退避，并遵守 Retry-After/冷却时间 |
| `GAIA2_MODEL_MAX_RETRY_WAIT_SECONDS` | 3600 秒 | 单个模型请求的累计重试等待预算 |

实际配置首次执行时写入 `runtime-settings.json` 并绑定 state/result hash；恢复时配置不可漂移，包括 maxActions 和重试预算。请使用原入口及原参数恢复。默认 maxActions 暂为 e2e/all 24、batch 20、pilot 32；这些历史动作上限及 Actor 动态上下文仍待阶段 3 专门验证。原始任务禁止 minimal 裁剪和 smoke 工具 allowlist。

408、429、临时 5xx、请求超时和连接故障只重试模型请求；401/403、参数及 provider 配置错误立即终止。Actor 和 Judge 均禁用 LiteLLM 隐藏重试。工具执行不包在重试循环中，不自动重放未知写入；真正的执行前 write guard/read-back 属于阶段 3，尚未接线。

每个任务/session 有独立 stdout/stderr、heartbeat、process-result、runtime-events、ARE output/Trace 和 task-result。批次保存 `pending/running/completed/retry_pending`、owner lease、batch heartbeat 和报告。有效业务失败也属于 completed，不会为了拿通过成绩而重跑。技术失败不计为 score=0；缺少有效判断时批次为 incomplete。运行中 heartbeat 标记进度 unknown，正常停止后有 terminal 状态。

没有 durable ARE checkpoint：恢复是新建干净环境，不是从旧工具动作断点继续。恢复前验证进程出生身份；发现活跃 owner/子进程、未知身份、损坏产物或路径漂移会拒绝续跑，避免重复副作用。残留 `.owner-takeover` 或缺失进程所有权证据需要人工确认，不自动删除。

当前仅接通 Standard 原始场景；含 A2A/Noise 的完整官方计划会在任何任务启动前整体拒绝。TS 插件仍未加载、真实 Hook/纠错仍未生效，官方提交格式和覆盖率留到阶段 2；不能将内部 task-result 或合成测试结果作为官方提交包。

```powershell
npm test
npm run phase1-controlled  # 实际子进程中断/续跑；合成 fixture，无模型、无 ARE 场景
npm run phase1-model-probe # 最少量真实 Actor/Judge 请求；不执行基准题
```

Windows SIGALRM 兼容由启动适配处理，不修改官方包源码。完整阶段验收和实施文档保存在 `D:\gitlocals\kanli8-human\capybara-doc\docs\research\`。
