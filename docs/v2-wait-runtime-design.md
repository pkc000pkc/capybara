# V2 真实等待与恢复协议

版本：v0.2 · 日期：2026-11-18。关联：[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md)、[Runtime Prompt](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)。

等待是一份可核验的控制订阅。模型描述要等什么；宿主签发期限、保存订阅、接收观察并结算；新的模型轮读取真实结果后判断下一步。信号满足、期限到达、取消等待与任务成功分别记录。

## 1. 期限和订阅

需要时间窗口时先调用 `create_wait_deadline({timeout_ms})`。宿主按实际时钟生成 `deadlineRef`、createdAt 和 expiresAt，并绑定 session/task/run 及原操作 ID。同一操作 ID、相同参数重复提交返回原期限，不延长窗口；换参数复用该 ID 被拒绝。有效时长为 10ms 至 30 天，长定时器分段重新核对绝对期限。

模型随后提交正常 V2 Envelope，其 waitSpec 例如：

```json
{
  "reason": "等待两个外部来源就绪",
  "signalType": "external",
  "correlationIds": ["source-A", "source-B"],
  "condition": {"eventType": "ready", "status": "ready"},
  "deadlineRef": null
}
```

多个 correlationIds 默认全部满足，最多 32 个且不能重复。匹配条件为同一 session/task/run、相同信号类型与 eventType、关联 ID，以及提供时的精确 status。它描述“真实事件已观察到”，不保证外部对象之后持续保持该状态；恢复后仍需重新核对当前事实。

纯时间窗口使用 signalType=runtime、condition.eventType=deadline、correlationIds=[实际 deadlineRef]，同时填写同一个 deadlineRef。引用只能来自本 task/run 的宿主记录，模型填写的任意时间字符串不能成为期限。未绑定的自由文本 resumeCondition 和直接 timeoutMs 不能代替正式订阅。

可以等待已配置轮询的 MCP 写入核查。使用 `runtime / mcp.operation.settled`，关联唯一的原 operationId，并提供绝对期限的引用。活动根任务和当前核查能力必须匹配。外部或用户提交同名事件会被拒绝。恢复读取回执以区分两种终态。[MCP 结算等待](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md#43-等待写入结算)

## 2. 来源和输入权限

| 来源 | eventType | 关联 ID 与真实依据 |
| --- | --- | --- |
| 工具 | `tool.completed` / `tool.failed` | 真实 callId 与执行收据；status 保留 succeeded、failed、unknown 等实际结果 |
| 子任务 | `child.status` | 已存在的子句柄及当前父 run 的宿主生命周期事件 |
| 进程 | `process.status` | 当前 run 的实际 process ID 与状态事件 |
| 期限 | `deadline` | 宿主签发并绑定本任务的 deadlineRef |
| 外部/用户观察 | 订阅明确指定的事件类型 | 认证会话入口或可信集成提交的关联 ID；正文仍是来源说法 |

客户端协议仅允许 external/user 信号，不能宣称 tool/runtime 来源。`runtime.wait.signal` 必须携带原 taskId/runId；session 来自真实连接，接收时间由宿主写入。错误任务、旧 run、未知字段和越界大小在入口拒绝。可信集成通过 `RuntimeLoop.publishWaitSignal` 绑定原身份，不从信号正文推导权限。

示例中的身份是说明结构的占位值，实际提交使用当前宿主绑定：

```json
{
  "id": "external-event-42",
  "taskId": "actual-task-id",
  "runId": "actual-run-id",
  "signalType": "external",
  "eventType": "ready",
  "correlationId": "source-A",
  "status": "ready",
  "data": {"text": "来源 A 的原始说明"}
}
```

相同事件 ID 与相同语义是幂等重传；复用 ID 改写正文、状态或关联身份会被拒绝。信号登记与订阅结算在同一事务中，SQL 失败不留下半个事件或虚假完成。

`tool:` 和 `runtime:` 是宿主信号 ID 的保留命名空间。external/user 入口不能占用这些 ID，避免外部事件先到后阻塞真实工具或生命周期记录。

## 3. 注册、暂停与恢复

模型意图先通过来源/期限校验。运行时完成当前模型步，插入后续模型轮、推进游标并构造 checkpoint，再把订阅和该恢复材料写入同一 SQLite 事务；成功后发布 pending 事件与暂停状态。注册失败不发布成功订阅，不重新执行原模型步骤冒充注册成功。

原始信号可以早于订阅到达。登记时对照同一任务已有事件和真实工具/活动收据，避免“先完成、后订阅”丢失通知。旧任务的同名关联 ID 不匹配本任务。

目录快照若只保存了尚未提交的等待意图，恢复为 `WAIT_REGISTRATION_NOT_COMMITTED` 中断，保留原轨迹并允许取得新投影重新判断。已保存的后续模型节点用于修复尚未推进的游标，不再多执行一轮；不存在的 SQL 订阅不能因快照中的 waiting 字样而被构造出来。

```text
模型 wait 意图
  → 校验真实引用
  → 提交下一模型游标 + durable checkpoint + pending 订阅
  → 暂停
  → 部分信号：保存命中，继续等待
  → 全部信号 / 实际到期 / 显式取消：保存真实结算
  → 更新控制状态与 stateRevision
  → 新模型轮重新观察、判断
```

根任务等待时，普通继续、单步、重启步骤和回退 checkpoint 均受原订阅门禁约束。局部等待时，可以继续其他就绪节点，作用域仍由当前能力投影决定。`runtime.wait.cancel({waitId,reason})` 结算指定等待并保留 cancelled 回执。run.cancel 结算运行中的订阅并保存取消标记，供关闭重连核对。

关闭只移除进程内定时器，保留订阅。重开从 SQLite 读取真实信号和期限；较旧的目录游标由等待事务保存的 checkpoint 补足，知识文档仍从原有权威文档存储加载。deadline 在关闭期间到期时，重开按实际当前时钟结算 timed_out。已完成快照不被旧等待游标覆盖。

恢复先调度新模型轮，保留未知副作用、未完成计划和子结果消费义务。局部订阅的 `blockingTaskIds` 只接受本轮 activeTaskIds。多个互不重叠的局部订阅可同时存在，SQLite 按真实关联分别结算，结果在安全模型边界更新 task stateRevision。局部人工问题沿用持久化订阅，只有绑定 humanRequestId 的会话消息可结算该问题。用户手动暂停时，信号只更新状态，继续由用户控制。

### 3.1 局部补证据

模型用 `continue` 提交结构化 `evidenceRequests`，每条指定问题、`relatedTaskIds` 和一种或多种可接受的来源。宿主为每条请求签发 ID，批量请求与同一恢复游标在一个事务中登记。每条请求接收一份材料。需要两份独立材料时分别提出，节点的全部待补请求结算后再检查其他依赖。

| 来源 | 提交路径 | 宿主检查 |
| --- | --- | --- |
| 用户 | 工作台选择对应问题，消息携带 `humanRequestId` | 当前会话、任务、运行、请求和消息唯一性 |
| 外部观察 | `runtime.wait.signal` 的 `external / evidence.available`，`correlationId` 为宿主请求 ID，`data` 包含 `sourceId` 与 `text` | 当前绑定、允许来源类别、原始信号 ID 和重复语义 |
| 工具 | `submit_branch_evidence` 引用实际 `candidate_id` | 本次运行已完成的观察、原件与内容 hash |
| 记忆 | 同一工具另附 `recall_id` | 该会话已登记的真实召回、原件与证据引用 |
| 子结果 | 同一工具引用读回的子候选 | 已登记的子句柄、关联结果包、原件和结果 hash |

材料到达后，宿主保留输入与原件，写入或引用候选并生成补证据回执。外部提供的来源名称作为原始声明保存。任务事实、计划完成及子结果消费分别按原流程审核。运行仍保有其他就绪节点的能力。只余可采集证据时，`evidence` 阶段提供只读查找、材料提交和相关控制工具。

## 4. 原文、投影和训练

`runtime_state.waits` / RuntimeSnapshot.waits 提供有界的 deadline 与订阅记录，包含 matchedSignalIds。模型用按需出现的 `read_wait_signal({signal_id})` 读取本 task/run 的原始观察。它走普通工具返回、原件与候选信息路径，不能把 external/user 说法提升为事实。

控制表位于 sessions.sqlite：runtime_wait_deadlines、runtime_waits、runtime_wait_signals。会话清理在原清理事务中移除这些表的相关数据并保留墓碑；旧连接不能重新登记。原始时间、信号正文、幂等结果、取消与超时分别保留。模型的 wait 提案和宿主结算标签在训练中分离，timed_out/cancelled 不能标成业务成功。

实现和验收入口见[WaitStore](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-wait-store.ts)、[RuntimeLoop](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-loop.ts)、[根任务等待](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-wait.test.ts)、[局部分支调度](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-planning-projection.test.ts)和[V2 桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)。外部服务覆盖和真实模型效果仍需场景验收。
