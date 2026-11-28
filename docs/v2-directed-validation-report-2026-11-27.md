# V2 定向验证报告：Workflow 触发与上下文预算

日期：2026-11-27
范围：单题 AppWorld `76f2c72_1`，不启动全量基准

## 1. 本轮结论

`execute_workflow` 的缺口不是工具投影缺失。此前定向运行中，工具已经出现在模型投影，但 RuntimeLoop 只提供了“优先使用”的软提示，模型可以连续调用 `appworld_execute`，因此没有形成 Workflow。

本轮把触发链路改为两层：

1. Runtime Prompt 明确 Workflow 的适用场景、AppWorld 的批处理规则、数字 `version: 1` 和 Workflow 结果不可重复包装。
2. RuntimeLoop 在已投影 `execute_workflow` 和 `appworld_execute`，且已有两次未完成的直接 `appworld_execute` 观察时，将 `workflow_guidance.required` 置为 `true`，并在模型协议校验层拒绝继续的直接业务调用，要求先尝试 Workflow。

这次重跑确认触发机制已经生效。模型投影包含 `execute_workflow`，实际调用 2 次，并产生 2 个 `workflow-definition` 和 2 个 `workflow-result` Artifact。参数非法计数为 0。

随后发现上下文整理成功后，`executeModelStep` 在没有 `excerptSources` 时仍可能回退到 append-only 的 `llmMessages`。这会把已被覆盖边界承接的原始工具记录重新带入后续请求。修复后，组织开启时统一从 `ContextHistory.project()` 投影，持久化的 `coveredThrough` 和 `retainedMessageIds` 成为唯一历史边界。新增回归测试覆盖了“已提交覆盖、工作视图过期、下一轮仍保持压缩”的恢复场景。

## 2. 触发原因分析

| 检查项 | 结果 | 结论 |
| --- | --- | --- |
| `execute_workflow` 是否进入工具投影 | 是 | 不是能力投影缺口 |
| 原提示词是否提到 Workflow | 是 | 只有偏好性指导，不能保证触发 |
| 原运行是否可连续直接调用 AppWorld | 是 | 缺少运行时硬门禁 |
| 两次未完成直接调用后是否强制切换 | 修复后是 | 由 `workflowRequiresAppworldBatch` 和协议拒绝共同保证 |
| Workflow 版本字符串是否可能导致校验失败 | 已兼容 | Runtime 归一化 provider 传入的字符串 `"1"` |

## 3. 上下文与输出预算调整

项目配置中的 `reserved_output_tokens: 65536` 仍作为提供方上限，普通主轮不再为每个阶段预留完整 64K。RuntimeLoop 当前采用阶段上限：

| 阶段 | 单轮输出预留上限 |
| --- | ---: |
| direct / investigation / execution | 12K |
| planning / delegation | 8K |
| verification | 6K |
| delegation_wait / delegation_review / evidence | 4K |
| 控制补救轮 | 4K |

上下文整理默认批次从 6000 字符降到 4000 字符，整理器输出预留从 4096 降到 2048。整理器仍受独立 schema、原始来源和 diff 门禁约束，不能因为压缩而删除未决事实。

## 4. 定向重跑结果

命令：

```text
Remove-Item Env:GIT_CONFIG_COUNT,Env:GIT_CONFIG_KEY_0,Env:GIT_CONFIG_VALUE_0 -ErrorAction SilentlyContinue
npx tsx --conditions=development tmp/rerun-76f2c72-1-fixed2.ts *> tmp/appworld-rerun-76f2c72_1-20261127j.log
```

运行摘要：

| 指标 | 结果 |
| --- | ---: |
| AppWorld case | `76f2c72_1` |
| 模型请求数 | 16 |
| 实际工具调用 | 18 |
| `execute_workflow` 实际观察 | 2 |
| `workflow-definition` | 2 |
| `workflow-result` | 2 |
| 非法工具参数 | 0 |
| 输入 Token | 556,874 |
| 输出 Token | 17,578 |
| 总 Token | 574,452 |
| 最后一轮估算输入 | 35,287 |
| `RUNTIME_MODEL_BUDGET_EXHAUSTED` | 未出现 |
| 官方状态 | 2/2 requirement，任务通过 |

本次任务通过 AppWorld 的 2/2 状态断言。与此前 727,392 总 Token 的运行相比，本轮总 Token 降至 574,452，模型请求数从 24 降至 16。下降主要来自持久化覆盖边界对旧工具历史的投影收敛，以及阶段输出上限和工具描述压缩共同生效。

## 4.1 后续定向重跑

在额度恢复后，对同一训练集样本 `76f2c72_1` 再执行一轮单题、单次运行。运行日志为 `tmp/appworld-rerun-76f2c72_1-20261127k.log`，运行 ID 为 `21232688-f8fe-4f0c-b5aa-a7e7989154c3`。

| 指标 | 结果 |
| --- | ---: |
| 运行状态 | completed |
| AppWorld 状态 | 2/2 requirement，passed |
| 模型请求数 | 19 |
| 实际工具调用数 | 18 |
| `execute_workflow` 实际观察 | 6 |
| `workflow-definition` | 6 |
| `workflow-result` | 6 |
| 非法工具参数 | 0 |
| 运行错误 | 0 |
| 输入 Token | 480,613 |
| 输出 Token | 18,629 |
| 总 Token | 499,242 |
| `RUNTIME_MODEL_BUDGET_EXHAUSTED` | 未出现 |

本轮的工具序列包含资源发现、直接 `appworld_execute`、多次 `execute_workflow` 和 Workflow 内部的 AppWorld 调用。Workflow 已进入工具投影并实际执行，真实 definition、result Artifact 均已生成。与上一轮 574,452 总 Token 相比，本轮减少 75,210 Token。该结果支持上下文投影边界和阶段预算调整有效，但单题仍不能代表全量题目的平均成本。

## 5. 仍需处理的运行时问题

历史记录中曾出现一个上下文整理失败 Artifact：`CONTEXT_ORGANIZATION_SCHEMA: /observations/2/sourceRefs must NOT have duplicate items`。该错误当时被 schema 门禁拒绝，原始历史、Workflow Artifact 和 AppWorld 最终状态均未受影响。现已增加确定性去重、`normalizationWarnings` 和监督样本排除逻辑，重复引用由首次出现顺序归一化，其他 schema 错误仍保持拒绝。

后续重新执行 `apps/backend/test/runtime-child.test.ts`，23/23 通过，未再出现 A2A 协议测试失败。该结果覆盖本地同步、异步等待、结果消费、权限拒绝、取消、接管、子代理只读能力和模型轮次预算等路径。此前的 `CONTEXT_UNCOVERED_HISTORY_BUDGET` 已由上下文投影收敛修复覆盖，仍需在更长的真实 A2A 轨迹中观察输入预算边界。

本轮继续补齐了两项 P1 设计。紧凑 Workflow 意图由 `intent.calls` 与 `intent.operations` 表达，RuntimeLoop 在生成 `workflow-definition` 前展开为既有 canonical steps，因此确定性算子、引用校验和 Artifact 链路仍复用原协议。为避免把工具 schema 重新扩大到 A2A 子代理的上下文预算，意图字段采用轻量 schema，严格字段、数量、操作符和混合结构校验留在代码层完成。专用 `appworld_readonly_execute` 已接入 AppWorld manifest、runner 和只读静态门禁，读操作按方法前缀允许，写操作、完成操作、宿主逃逸和未知方法拒绝。

整理器还增加了重复 `sourceRefs` 的确定性去重。去重只保留首次出现的来源 ID，并在请求记录中写入 `normalizationWarnings`，同时将该请求标记为不可用于监督训练，避免把模型格式错误静默当成高质量样本。

本轮已在额度恢复后完成一次单题重跑，结果仍为 2/2 通过。专用只读包装仍需要后续用一条定向 AppWorld 子代理样本做集成验收。

## 6. 验证命令

以下本地检查通过：

```text
npx tsc --noEmit -p apps/backend/tsconfig.json
npx tsx --conditions=development --test apps/backend/test/generated-workflow.test.ts apps/backend/test/runtime-control.test.ts
node --test examples/appworld/tools/appworld/readonly-policy.test.mjs
npx tsx --conditions=development --test --test-name-pattern "model-generated workflow|generated workflow executes|generated workflow aligns|failed generated workflow" apps/backend/test/app.test.ts
npx tsx --conditions=development --test --test-name-pattern "finish gate rejects uncompleted required actions|runtime continues on running status and exits only on completed status" apps/backend/test/context-document-runtime.test.ts apps/backend/test/app.test.ts
npm exec -- tsx --conditions=development --test --test-name-pattern "follow-up without new tool evidence|real tool rounds use committed session context" apps/backend/test/context-organization-runtime.test.ts
npx tsx --conditions=development --test apps/backend/test/runtime-child.test.ts
npx tsx --conditions=development --test apps/backend/test/runtime-entity-snapshot.test.ts
```

结果为 Workflow 与 RuntimeLoop 控制测试 27/27、AppWorld 只读门禁与 manifest 契约 3/3、应用集成 4/4、完成门禁 2/2、上下文整理 11/11、A2A 23/23、实体快照 3/3 通过，整理器全套测试 26/26，TypeScript 编译通过。

## 7. 验收状态

- DAG 触发和真实 Workflow Artifact：通过。
- 非法 Workflow 参数拦截：通过，本轮计数为 0。
- 完成门禁：通过本地测试。
- 阶段输出预算和上下文整理预算门控：已施工，单题重跑未再出现模型预算耗尽。
- AppWorld 业务答案正确性：通过，本题 2/2 requirement。
- 上下文整理历史投影收敛：通过，新增 stale working view 回归测试并在定向重跑中未再出现模型预算耗尽。
- A2A 本地协议回归：通过，`runtime-child.test.ts` 23/23。
- 工具结果逐实体快照：通过本地抽取验收，结构化结果生成实体标识、字段、时间、来源 Artifact 和哈希，并挂载到 Observation。
- 上下文整理输出重复引用：已做确定性去重并记录监督资格，整理器全套测试 26/26。

## 8. P1 现状核对

| P1 项目 | 当前证据 | 状态 |
| --- | --- | --- |
| 紧凑 Workflow 意图与 RuntimeLoop 编译 | `generated-workflow.test.ts` 与 `runtime-control.test.ts` 合计 27/27，Runtime 编译包含确定性算子和 schema glue，AppWorld 定向题产生真实 Workflow Artifact | 已具备，仍需观察真实模型输出紧凑意图的单题集成表现 |
| AppWorld 只读子代理 | `appworld_readonly_execute` 已加入 manifest、runner 和静态门禁，门禁与 manifest 契约测试 3/3，通用 A2A 回归 23/23 | 本地协议与门禁已具备，尚未追加 AppWorld 配额测试 |
| 分阶段模型输出预算 | `outputBudgetForPhase` 已写入 model-request Artifact，定向题未再触发模型预算耗尽 | 已具备 |
| 完成状态补救轮 | `runtime-control-integration.test.ts` 完成修复场景通过，工具不重复执行 | 已具备 |
| 工具结果逐实体状态快照 | `runtime-entity-snapshot.test.ts` 3/3，通过 TypeScript 编译和与 A2A 联跑 | 已具备最小版本 |
| Benchmark 隔离模式 | `experiment-manager.test.ts` 在 `CAPYBARA_TEST_PROJECT_DIR=examples/test-project` 下 10/10，通过只读资源、样本选择、取消、预算和项目上下文只读路径 | 已具备 |

P2 的本地三组策略对照已建立并通过。它验证相同只读任务在直接工具、DAG 和 A2A 路径上都能完成，并能区分模型轮次、工具轮次、确定性节点和子代理消费状态。该对照使用确定性模型模拟器，只证明 RuntimeLoop 链路和指标采集，不替代 AppWorld 官方 pass@1。已有真实整理器留出报告的独立审计也已通过 2/2，归档与召回的本地可逆性和投影缩减指标已补齐。Streamable HTTP MCP、独立进程子代理宿主和远端 MCP 发现均已通过定向验收，长任务收益统计仍需在更多任务上积累。

## 9. P2 本地三组策略对照

命令：

```shell
npx tsx --conditions=development --test apps/backend/test/runtime-strategy-comparison.test.ts
```

结果：1/1 通过。三组均完成同一只读任务并通过完成门禁。

| 策略 | 模型请求 | 估算输入 Token | 工具调用 | Workflow definition/result | Workflow 节点 | 子代理启动/消费 | 完成门禁 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| direct | 3 | 35,860 | 2 | 0 / 0 | 0 | 0 / 0 | passed |
| dag | 3 | 36,143 | 3 | 1 / 1 | 2 | 0 / 0 | passed |
| a2a | 4 | 51,436 | 3 | 0 / 0 | 0 | 1 / 1 | passed |

DAG 的第三个工具调用是 Workflow 内部的 `list_files`，不产生额外模型请求。A2A 的第三个工具调用是父代理消费子结果，子代理由本地确定性宿主启动一次。测试同时确认直接工具组没有 Workflow Artifact，DAG 组有完成的 definition 和 result，A2A 组的成功子代理已被父层读取并消费。

## 10. P2 训练质量和归档召回补充

独立报告审计命令：

```shell
node apps/backend/demo/context-quality-report-audit.mjs tmp/context-quality-acceptance.json
```

结果为 2/2 场景通过。两组原始文件哈希一致，整理前后答案字段均完整，`correctFieldsDelta` 为 0，整理分支覆盖游标有效且主轮输入下降。历史报告的主轮输入分别下降 10,774 和 12,277 Token，但加上整理器请求后总输入会上升，说明整理收益仍取决于整理器成本和后续复用次数，不能只看主轮输入。

归档召回验收新增到 `context-training-closure.test.ts`。7/7 通过，确认归档后活跃投影变短且不含归档正文，召回返回同一条原始条目和原证据 ID。该测试证明可逆性和证据保留，不代表长任务上的统计收益。

已有长任务配对记录显示收益具有条件性。两轮借阅追问中，主轮输入从 34,458 降到 30,875 Token，计入一次整理请求后总输入和输出从 35,678 降到 35,188，节省 490 Token，两个分支均命中 7/7 要点。展厅长样例的跨批保留回退则让主轮从 63,867 增到 93,062 Token，另有 5,738 Token 整理输入，说明在覆盖不足或需要保留原件时，归档整理可能增加成本。当前结论是归档和召回有可验证的可逆性，实际收益依赖任务长度、复用次数和回退比例。

## 11. P2 MCP 和子代理宿主协议验收

- `mcp-client-manager.test.ts` 的真实 Streamable HTTP 场景 1/1 通过。测试覆盖环境变量引用的认证头、工具发现、调用结果、超大响应拒绝和外部 URL 输入边界，持久化快照和结果中不包含密钥。
- `runtime-child.test.ts` 的宿主子代理定向场景 2/2 通过。测试覆盖宿主绑定、只读能力投影和宿主变更后的 runner 保持。
- `runtime-child-host.test.ts` 3/3 通过。测试启动独立 Node HTTP 进程，使用 `capybara.a2a.child.v1` 传输合同，父 RuntimeLoop 完成委派、读取、消费和完成门禁。身份不匹配、动作模式和超大响应均被拒绝。
- 远端 MCP 使用 `apps/backend/demo/mcp-remote-smoke.ts` 通过真实 Streamable HTTP 发现。命令设置 `CAPYBARA_MCP_PROXY=http://127.0.0.1:2080` 后连接 `https://mcp.deepwiki.com/mcp`，协商协议 `2026-07-28`，发现 3 个工具，状态为 `ready`。远端只做工具发现，没有执行业务调用。

当前 P1 的实际剩余项是用真实 AppWorld 单题验证紧凑 Workflow 意图和 `appworld_readonly_execute` 的集成表现。整理器重复 `sourceRefs` 已完成本地闭环，但仍应在真实长轨迹中观察是否有其他格式变体。
