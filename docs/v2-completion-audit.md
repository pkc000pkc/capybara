# Capybara V2 Completion Audit

本矩阵按 V2 设计要求核对当前系统项目和 Gaia2 工作项目。系统项目位于本仓库；Gaia2 适配与官方运行器位于 `D:/gitlocals/capybara-test-workspaces/gaia2-v2-work`。

## 2026-11-17：按完整场景重新核对

下表保留机制建设阶段的证据。“已实现”表示存在相应机制，不能据此判断完整任务闭环已经通过。最新核查发现历史消息重复投影、压缩摘要未写入 session 正式信息区、人工问题不可见，以及旧 completed 路径未统一经过严格完成门禁等问题。

当前统一评审入口为[上下文、能力、状态闭环与提示词设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md)，其中整理了 20 个缺口、代码与测试证据、目标协议和场景验收条件。[提示词组初稿](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/README.md)与运行时目标共同评审；文档初稿完成不代表已加载或已通过真实模型验证。

## 机制建设记录

| 要求 | 当前证据 | 状态 |
|---|---|---|
| 五区 ContextDocument 与 Markdown 解析 | `apps/backend/src/core/context-document-engine.ts`；五区标记、信息条目、候选块、证据元数据 round-trip 测试 | 已实现 |
| 候选生命周期与证据治理 | `observe`、`addEvidence`、候选审核、Evidence Review、冲突/过期/替代状态、未知引用拒绝 | 已实现 |
| RuntimeLoop 候选/证据摄取 | `runtime.context.v2.observe` typed command；RuntimeLoop 校验 document/source/evidence，写入 Candidate/Evidence 并发出受信观察事件 | 已实现 |
| 语义 diff | `DiffProposal`、baseRevision、projection binding、entry hash、幂等 receipt、superseding lineage | 已实现 |
| 结构化控制协议 | `RuntimeEnvelope`、wait/ask_user/propose_diff/reflect/finish、完成门禁、证据请求、控制状态持久化 | 已实现 |
| 确定性投影 | 有界章节/实体选择、稳定排序、anchor-latest 最新窗口策略、选择理由、截断元数据、content hash、稳定 projection identity | 已实现 |
| 系统与项目提示词边界 | 固定 Constitution、lower-priority project prompt、system/tools runtime governance | 已实现 |
| V2 提示词分层 | `v2-prompts.ts` 提供 Constitution、Runtime、Candidate Normalize、Evidence Review、Reflection、Dream、Memory Recall、A2A Child、Parent Merge、Final Response 提示词 | 已实现 |
| Memory、Dream、A2A | memory recall、dream plan、child merge、父代理事件和普通 diff/evidence 门禁 | 已实现 |
| V1 迁移与回滚 | legacy observation migration；checkpoint 保存/恢复 V2 engine state 和 control state | 已实现 |
| Gaia2 工作项目边界 | `src/capybara_v2_adapter.mjs`；typed command/receipt/projection 适配 | 已实现 |
| Gaia2 机制验证 | `reports/capybara-v2-mechanism-smoke.json`：10/10；adapter/bridge test：4/4；Python bridge contract：5/5 | 已验证 |
| Windows 本地桌面 Workbench | Electron 原生目录选择、opaque reference、空目录初始化、主进程直托管 Backend RuntimeLoop、IPC 事件回放、静态导出和托管本地后端 | 已验证 |
| 本地行情研究闭环 | 默认 market-research route、Eastmoney 日线、显式 HTTPS 研报 quarantine、本地 Python、真实 HTML dashboard host/open | 已验证 |
| Browser Gateway 读取 | `http-browser-executor.ts` 读取公开 HTML 并生成 page evidence；交互式 Chromium 能力无宿主时保持 unknown | 读取已验证，交互待宿主 |
| 子代理/进程状态 | `RuntimeActivityState`、RuntimeSnapshot/State children/processes、unknown 状态和 replay 测试 | 已验证 |
| 运行日志训练样本 | RuntimeLoop completed turn → export/restore `contextTrainingSamples`，含 context/cache/messages/system prompt/scope/revision | 已验证 |
| OpenAI 模型路径 | `reports/capybara-v2-openai-model-probe.json`：`gpt-6-luna`、官方 endpoint、普通响应和 function tool call 均校验通过，`reasoning_effort=none` | 已验证 |
| 官方 Gaia2 Actor/Judge | 多份 Standard、Noise、A2A 单场景报告均由 `gpt-6-luna` 运行；最新 ac trace 在 `scenario_universe_27_t914u5` 上 score=1，并把官方 Actor 接入系统 `ContextDocumentEngine` | 已执行，路径闭环通过；单场景行为结果存在任务差异 |
| Gaia2 全量数据集覆盖 | source/submission/mini 冻结后 phase0 preflight 深检通过 1760 条索引记录、事件 DAG、版本和哈希；最新 provenance 计划 `runs/v2-a2a-noise-audit-20261106ac/run-manifest.json` 已生成 3360 个 execution slot | 数据与计划已验证，真实全量执行未跑 |

## 回归证据

- V2 聚焦回归：ContextDocument/RuntimeEnvelope 16/16 通过；Electron IPC、应用托管、子智能体和可回放 Trace 24/24 通过。
- workspace typecheck：通过。
- fixture-backed backend：250 tests，245 passed，5 个既有 `training-manager.test.ts` 失败；V2 聚焦测试不在失败项中。
- `git diff --check`：通过。
- Gaia2 `npm run gate1`：五类 capability 各加载一个真实场景完成 dry-run；无模型、无副作用、无官方 score。
- Gaia2 workspace `npm test`（最新 transport 调整前）：923 tests，773 passed，149 failed，1 skipped；失败集中在既有动态 hook/fixture/环境路径测试，V2 adapter/bridge 的 4/4 回归和 Python bridge contract 1/1 仍通过。

## Gaia2 成绩解释

有效官方报告保留在 Gaia2 工作项目：

- `reports/capybara-v2-gaia2-official-single.json`：工具调用计数与 oracle 不一致。
- `reports/capybara-v2-gaia2-official-second.json`：六次保存动作正确，但最终用户回复文本未匹配 oracle。
- `reports/capybara-v2-gaia2-official-third.json`：同一场景在完整重试窗口下完成六次保存；官方 judge 只拒绝最终回复措辞。
- `runs/v2-official/output-v2-noise-mini/`：Noise mini 官方 ARE 单任务 trace 有效，`gpt-6-luna`、tool augmentation 和 env-events 配置均由 trace 元数据确认；score 0 仅因最终回复未匹配 oracle。
- `runs/v2-a2a-noise-audit-20261104f/`：首次 A2A 槽位记录了缺少 `truststore` 时的 guard pre-dispatch failure；该问题已由官方环境依赖和 guard fallback 修复。
- `runs/v2-a2a-noise-audit-20261104g/`：修复后 A2A mini 官方 trace 完成父/子 Agent、12 次子 Agent 模型请求、工具调用和 judge；score 0 的原因是 RentAFlat/Messaging 工具计数与 oracle 不一致。
- `runs/v2-a2a-noise-audit-20261105a/`：最新 Standard 单任务官方 trace 使用 `gpt-6-luna`，完成 10 次模型请求、30 次 V2 observation、10 次 deterministic projection，并记录 1 次 bridge start/close；所有 projection 均绑定系统 `ContextDocumentEngine`（engine hash `3120d0c2e30912bffb9a2a431910868294a8fb229b5e0667c3afbf6da006c150`）。官方 score 为 0，原因是任务动作计数与 oracle 不一致；该结果证明了官方 Actor 到 V2 上下文引擎的端到端接线，不代表任务行为达标。
- `runs/v2-a2a-noise-audit-20261105b/`：在 actor-scoped observation dedupe 和 section priority 更新后重新冻结的 Standard 单任务 trace，使用 `gpt-6-luna` 完成 14 次模型请求、62 次 V2 observation、14 次 deterministic projection，并记录成对 bridge start/close；所有 projection 绑定当前系统引擎 hash `030ce9e3f2eda27677e3e4d15d02944dc07c51138a35065f0195f661072aa774`。官方 score 为 0，原因是模型过度执行保存动作（24 次，oracle 5 次）和删除动作（4 次，oracle 2 次），属于任务策略行为偏差；该 trace 证明了新机制已经进入官方 Actor 请求。
- `runs/v2-a2a-noise-audit-20261105c/`：在 Noise 证据 quarantine 生命周期修复后重新冻结的当前 manifest。Noise trace 的 `technicalFailures=0`，记录 20 次 observation、14 次 projection、14 次模型请求；A2A trace 的 `technicalFailures=0`，记录 4 次 observation、4 次 projection、1 个 child snapshot、2 次 task-reconciliation，并使用同一当前引擎 hash。两者 score 仍为 0，原因是任务动作计数偏差；Noise 的旧 `noise_candidate_quarantine_invalid` 技术失败已不再出现。
- 三条当前 live trace 的机器汇总保存在 Gaia2 `reports/capybara-v2-live-traces-20261105c.json`，其中明确记录模型、引擎 hash、事件计数、score 和 full-campaign 状态。
- 有限数量与分类型计数提示词优化后的 Standard trace 位于 `runs/v2-a2a-noise-audit-20261105d/`：保存动作已与目标数量对齐，剩余偏差收窄为少 1 次删除和少 1 次发送。该 trace 无 technical failure；随后一次重试因 OpenAI HTTP 500 被正确记录为 `retry_pending`，详见 `reports/capybara-v2-live-traces-20261105e.json`。
- 同一 manifest 的 Noise mini trace 记录 62 次 V2 observation、56 次 projection、1 对 bridge start/close，A2A mini trace 记录 10 次 observation、10 次 projection、3 个 child snapshot 与 1 对 bridge start/close；两条路径均绑定同一系统引擎哈希。Noise 的 score 0 原因为保存/删除/消息动作计数偏差，A2A 的 score 0 原因为父代理未完成应有的保存、删除和消息动作。
- Standard trace 的官方输入在 10 个模型轮次中从约 13K 增长到 47K input tokens；运行时已有 240KB/80-message provider compaction，但该证据显示长任务仍需继续优化投影优先级和历史压缩策略，以降低上下文注意力稀释。
- Observation 去重现在按 `actor + sourceId` 绑定，避免用户消息和工具回执复用 provider-local ID 时错误合并；新增回归覆盖用户/工具同 ID 的隔离。
- RuntimeLoop 与 Gaia2 官方桥接均使用 `system → messages → information → candidates → tools` 的投影优先级，预算不足时优先保留当前任务和消息上下文。
- 确定性投影支持 `pinnedCandidateIds`：运行时可以把已确认的写入/完成回执作为候选优先级输入，但仍受候选状态、投影顺序和字符预算约束；桥接层只固定已产生成功回执的候选，不固定模型意图或 oracle 信息。
- Noise candidate ledger 允许保留带有 `failed/incomplete/stale/conflicting` 历史原因的 quarantine 记录，即使后续权威 fresh read 已将 observation 解析为终态；未知 quarantine 原因仍会被拒绝。该生命周期现由 35 项 targeted evidence tests 覆盖。
- A2A evidence collector 还发现并修复了合法 `AppAgent__expert_agent` 别名被 canonicalName 去重误拒的问题；当前 validator 按 `(canonicalName, publicName)` 校验工具身份。
- A2A task-reconciliation receipt 还修复了 native bridge 直接承载 `outcome.taskReconciliation`、而旧 fixture 使用 `outcome.result.taskReconciliation` 的双 wire shape 校验。
- 修复后的现有 A2A mini 运行重新通过 evidence collector：15 次 Hook invocation、5 次模型请求、17 次 guarded SDK attempts、17 次 HTTP dispatch，重复 dispatch 为 0；旧 task-result 未改写，新计划已刷新运行时哈希。
- 全量数据预检报告：phase0 preflight 深检 1760 条 source/submission/mini 记录全部通过；该检查不产生模型分数。
- `gpt-6-luna` 的 Chat Completions 工具兼容参数已在 Gaia2 actor transport 中固定为 `reasoning_effort=none`；独立 OpenAI tool probe 已确认 function tool call 返回正确。完整重试窗口下的官方 ARE trace 已稳定产生六次工具动作，最新失败只剩最终回复文本匹配。
- `runs/v2-a2a-noise-audit-20261105h/` 记录了一次候选结构化摘要实验。该摘要造成模型重复读取并在超过 100 个模型轮次后仍未收敛，执行被中止，未计入验收成绩。摘要代码已回滚，原始工具观察仍作为证据保留。
- `reports/capybara-v2-live-traces-20261105j.json` 记录了回滚摘要后的当前 Standard trace。它完成 15 次模型请求、51 次 V2 observation、15 次 projection、50 次工具调用和成对 bridge 生命周期事件，technical failure 为 0。官方 score 仍为 0，剩余差异集中在选中的属性集合和邮件内容。
- `reports/capybara-v2-live-traces-20261106r.json` 是引擎 `9b1cdc587b4c831562dda0b580743adf01e4d7371e352ba10e9b02e723f9d339` 的正式 Standard bridge trace。它运行 `gpt-6-luna`，记录 75 次 observation、55 次 projection、55 次模型请求、65 次工具回执、成对 bridge 生命周期事件，technical failure 为 0。官方 score 为 0，差异是邮件 3/2、保存 2/5、删除 20/2。该 trace 证明最新引擎、anchor-latest 投影和官方 Actor/Judge 边界已实际执行，业务动作策略仍需继续优化。
- `reports/capybara-v2-live-traces-20261106s.json` 在 mutation receipt 元数据进入 V2 候选后重新执行同类 Standard 场景。它记录 43 次 observation、15 次 projection、15 次模型请求、43 次工具回执，technical failure 为 0。删除重复从 r 的 20 次降到 1 次，说明写操作身份穿过上下文压缩后能阻止重复副作用。当前 score 仍为 0，差异收窄为保存 1/5、删除 1/2、邮件 1/2。
- `reports/capybara-v2-live-traces-20261106u.json` 使用当前引擎 `e9a0061d7396db55ccafa3bde1a32d41adfb22c77b512db53caa89af8b4e52ba` 和 u manifest 重新执行 Standard 场景。它记录 48 次 observation、10 次 projection、10 次模型请求、47 次工具回执、6 次上下文压缩和成对 bridge 生命周期事件，technical failure 为 0。写操作身份已保留到压缩后的候选投影，重复删除从 r 的 20 次降到 5 次，但本次模型仍多执行 2 次保存和 3 次删除，官方 score 为 0。
- `reports/capybara-v2-live-traces-20261106w.json` 使用当前引擎 `af27de558679a02b600c4d85f1fe47105301872049cb28a5061ed049e608d298` 和 w manifest 重新执行 Standard 场景。它记录 64 次 observation、40 次 projection、40 次模型请求、60 次工具回执、成对 bridge 生命周期事件，technical failure 为 0。删除和发送动作已与 oracle 对齐，保存动作多 1 次，官方 score 为 0。
- `reports/capybara-v2-live-traces-20261106x.json` 在同一引擎和冻结输入上执行 4 条独立 Standard execution，technical failure 均为 0，业务 score 均为 0。行为从目标写入为 0 次到保存 11 次不等，另有一条切换到其他任务类型的场景，说明当前长上下文策略存在显著行为方差。
- `reports/capybara-v2-live-traces-20261106y.json` 是针对并行工具调用的单变量对照：在同一引擎和新冻结计划下将 `parallel_tool_calls` 关闭，单场景产生 28 次单工具回合、28 次 projection 和 28 次工具回执，technical failure 为 0，但 save/remove/email 分别只有 1/0/1，仍因未完成 oracle 动作而 score 为 0。与 w 的 40 回合、60 次工具调用相比，并行调用会放大动作量，但不是行为偏差的根因；剩余问题仍是长上下文压缩后的任务规划和停止判定稳定性。
- `reports/capybara-v2-live-traces-20261106z.json` 使用 pinned mutation-candidate 投影优先级和引擎 `8bd496a2bdc1e6ede2a5b055e616119f9bd025b7523f61242066e7e112baedb6`。技术失败为 0，记录 71 次 observation、38 次 projection、38 次模型请求、66 次工具回执和 25 次压缩；本次 save/remove/email 为 0/0/1，score 仍为 0。该结果验证了 pinned 候选机制进入官方 Actor 路径，但单次模型行为没有改善，因此不能把它解释为业务成绩提升。
- `ab` 计划的最新单场景尝试在 ARE 初始化时卡在外部 `weatherHistory.csv` 下载，未进入模型请求；进程和 stdout/stderr 证据已保留，未生成业务分数，也不计入 V2 行为结果。
- `reports/capybara-v2-live-traces-20261106ac.json` 使用当前 engine hash `8bd496a2bdc1e6ede2a5b055e616119f9bd025b7523f61242066e7e112baedb6` 在同一冻结计划上执行了 Standard、A2A 和 Noise 槽位。Standard 的 `scenario_universe_27_t914u5` 完成官方成功，技术失败为 0，记录 21 次 observation、13 次 projection、13 次模型请求、20 次工具回执，score 为 1；A2A 完成父子 runtime 生命周期和 child snapshot，Noise 完成增强路径，二者技术失败均为 0，但任务动作计数仍 score 为 0。该报告验证了当前 RuntimeLoop observe/provenance 版本进入三种真实路径。
- 继续恢复 `ac` 计划中的 `standard-execution-0374a1719e19c4b3` 后，官方 Python 3.12 的 HfFileSystem 直接读取 `demo_filesystem/Documents/weatherHistory.csv` 成功（16,294,377 字节，SHA-256 `22c028ceb97c6ad405831dfda61f0235532d9ab873229ff57ce4240853ef0a1f`），因此原先的文件下载阻塞被区分为外部初始化耗时，而不是数据缺失。恢复 session `0002-3b93deb0-dfc` 使用同一引擎运行到手动中止前，记录 66 次模型请求、149 次 V2 observation、66 次 projection、61 次上下文压缩和 147 次工具回执；技术门禁没有报错，但模型在 `CityApp__get_crime_rate`、`RentAFlat__search_apartments`、`RentAFlat__save_apartment` 等动作间长时间重复，未形成官方终态。该证据保存在 Gaia2 `reports/capybara-v2-live-traces-20261107-resume.json`，不计业务分数。
- 同一冻结计划随后完成 `standard-execution-c6c8d7acab4f8a9a`（`scenario_universe_27_t914u5`, run 2）：进程退出码为 0、官方 runtime hooks 完整、技术失败为 0，记录 23 次模型请求、27 次 V2 observation、23 次 projection 和 21 次工具回执；官方业务 score 为 0，属于模型任务行为差异，不是 V2 协议或桥接失败。机器报告为 Gaia2 `reports/capybara-v2-live-traces-20261107-standard-run2.json`。
- 上述新增证据与 `20261106ac` 历史汇总合并为 Gaia2 `reports/capybara-v2-live-traces-20261107.json`；汇总包含 6 条真实执行记录，其中 5 条已完成官方评估，1 条因长任务不收敛而中断并明确不计分。
- `20261105m` 的后续提示词实验在模型请求阶段遇到 transport error，没有业务判断，不计入成绩。该提示调整随后在 `20261105n` 的行为回归后撤销。
- 后续 `20261105n` 成功完成了官方执行，但删除动作过量，说明该提示调整会扰动模型策略。相关提示已回滚，n 结果不作为当前行为验收依据。

后续使用同一 fixture 的重跑显示模型输出存在随机性：部分尝试会连续返回无工具调用的自然语言，部分尝试可以再次完成全部六次保存并形成有效 trace；这些重跑仍只在最终用户消息措辞上被 oracle 拒绝，因此没有生成新的通过成绩。

