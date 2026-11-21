# V2 辅助模型调用、预算与结果消费

版本：v0.2 · 对应：CAP-01，关联 CTX-02/06、CTL-01、VAL-02

辅助模型读取受控快照，返回建议；主模型判断下一步，RuntimeLoop 决定是否允许执行和提交。共同调用层将角色、输入、schema、预算、调用结果和消费记录绑定，避免把提示词正文存在误认为调用链已经完成。

关联：[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md)、[提示词目录](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/README.md)、[调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)。

## 1. 共同边界

每次调用由宿主选择一种 mode，装配对应正文和 schema。辅助角色没有工具通道，返回工具意图会被拒绝。模型只复制宿主提供的 snapshotId、来源、文档和投影引用，不能签发权限、时间、执行状态或提交回执。

| 模式 | 输入重点 | 输出和消费 |
| --- | --- | --- |
| Normalize / Organize | 原件片段、任务信号、两级文档 | 观察和局部提案；仍走来源、diff、持久化及覆盖门禁 |
| Reflection | 真实失败、相关轨迹、只读状态和文档投影 | 有来源的诊断、纠正计划、候选 diff、补证据和重试前提；主轮重新决策 |
| Recall | 具体信息缺口和实际检索候选 | 候选选择与理由；召回材料重新进入候选 |
| Parent Merge | 父层已核实的子身份、结果原件及证据 | 父文档候选，不替代子生命周期或父层消费 |
| Dream | 受控空闲窗口、文档、原件和记忆候选 | 普通整理建议，前台变化后复核版本 |

运行状态与阶段证据见第 7 节；不同模式各自的输入和输出适配分别验收。同一模型可以承担多种任务，每次调用的权限与协议仍独立。

## 2. 调用记录与生命周期

宿主保存真实 session/task/run/request、操作 ID、snapshotId、上下文 hash、提示词版本/hash、schema hash、实际模型/协议、最终请求、预算预留、所有者和期限。最终请求绑定所选模型及原 task/run 的 client metadata，重新计算完整输入估算后进入 SQLite；登记失败时不调用模型。相同操作 ID 与相同语义幂等，不同语义拒绝。

```text
实际输入通过预算检查
  → SQL 预登记
  → 分发事件与实际模型调用
  → 严格 JSON / schema / 引用校验
  → 成功建议或真实失败来源
  → 当前快照复核
  → accepted / stale / failed 消费回执
  → 主模型重新判断
```

运行中为 running，schema 与语义校验后的建议为 succeeded，无效输出或实际模型错误为 failed；超时、关闭和失去执行所有者保留 unknown。这里的 succeeded 只表示该辅助调用返回合格建议，不证明业务成功、知识为真或纠正动作已执行。

独立所有者和实际进程身份阻止连接之间抢占活动调用。关闭时先停止分发并保留 unknown，再释放存储；晚到回调只追加审计。重新连接不重复未知请求，也不退还其保守预算预留。请求刚登记、尚未实际分发时关闭同样不制造已调用或成功。

结果写入失败不发出成功消费回执。能够保存时，另记未提交响应审计；会话清理与墓碑优先，旧连接和迟到回调不能复活已清理状态。

## 3. 预算

一次请求的指令、schema、来源、两级文档投影、只读状态和消息均计入完整序列化估算，另预留输出。宿主复核估算与请求一致，拒绝少报输入；按 run 累计调用次数和预留 token。恢复、checkpoint 回退与更换连接不能清除 SQL 中的预留。

当前共同默认上限为：8 次辅助调用、累计 60,000 个估算/预留 token、单次输入 10,000、输出预留 2,048、30 秒宿主期限。Reflection 还受同一任务最多三次反思约束。`RuntimeLoopOptions.contextAssistant` 可以提供辅助 LLM 与受限预算；子代理继承的辅助 LLM 经子任务预算包装，不能绕过子轮次和 token 上限。

辅助账本记录该角色的逻辑调用、输入和输出预留。实际发送同时受父任务的共享模型额度约束，内置客户端每次重试或切换配置前都重新检查。实际返回的 usage 另行记录，语义拒绝和无效 JSON 仍计入已有消费。运行关闭后可结算迟到用量，保留原角色结果的拒绝或未知状态。真实 tokenizer 和多模型成本校准继续按 CTX-02 验收。[统一预算](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#62-统一预算)

## 4. Reflection 输入与输出

主轮提出 reflect 后，下一轮先执行独立 Reflection 调用，再组装新的主轮请求。前提是存在真实异常、被中断步骤或实际工具返回的 `ok=false`。工具正常返回业务失败与整轮运行异常分别识别；没有失败依据时，不调用辅助模型，并给主轮真实的拒绝原因。

输入使用只读来源片段，包含原文 hash、完整长度与 partial 标记；轨迹窗口明确为局部，记录省略数量。失败步骤、相关真实消息、原任务指令原件与上轮实际发布的文档投影分别标识。过大的投影保留缺失信息，不把省略的节点当作可编辑目标。原任务指令作为只读信号，不是辅助角色的新授权。

输出严格遵循 [REFLECTION_SCHEMA](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-reflection.ts)：

- `reflectionVersion=1`、真实 snapshotId。
- `diagnosis[]`：statement、sourceRefs；诊断必须有当前提供的来源依据。
- `correctionPlan[]`：id、description、dependsOn、verification、sourceRefs；ID 唯一，依赖已列出且无环。
- `candidateDiffs[]`：沿用主控制协议的文档 diff 形状，绑定提供的作用域、文档、revision、投影、候选、节点及 hash。
- `evidenceRequests[]`：question、sourceRefs。
- `retryPreconditions[]`、`uncertainties[]`：statement、sourceRefs。

未知字段、伪造快照/来源、未提供的候选或节点、伪造 evidence ID、非法依赖和工具意图被拒绝。诊断和建议不能代替源事实；候选 diff 即使有效也不自动应用。

## 5. 消费与原件

消费前对 task/plan revision 与两级文档 knowledge hash 重新核对。前台或其他连接改变了当前知识时，建议仍保存为来源，但消费标记为 stale，不把旧建议当成本轮纠正方案。失败或 unknown 调用消费为 failed，不能改写为已纠正。

主轮得到只读 guidance、完整的合格输出和 rawArtifactId。输出不静默截断重试前提、步骤依赖、证据请求或未知项；完整请求容纳不下时保留原件并报告真实预算不足。没有伪造 user/tool 历史消息，也不将反思文本自动写入两级知识。完整来源包保存实际输入、输出、原始响应（含被拒绝的工具意图）、版本/hash 与消费关联，供读取、恢复和审计。主模型需要采纳候选 diff 时，使用本轮投影重新提出普通提案，由原有门禁提交。

进行中的辅助调用阻止正常完成；合格建议、无效反思与业务任务的完成条件分别判断。主模型不能通过清空建议或改用旧 completed 格式跳过真实 pending。失败辅助调用也不能被描述成纠正动作成功。

会话清理移除辅助调用和事件表并写墓碑。已被项目知识实际引用的原件按共同来源保留机制处理；保留来源不自动接受它的诊断或将其升级为项目规则。

## 6. 训练记录

提示词版本、schema、真实输入与来源是训练输入的组成；模型提案与原始响应是候选监督资源；状态、消费、权限、时间和持久化结果是宿主标签。accepted 表示建议被当前调用消费，不能用作“诊断事实已确认”或“纠正已成功”的标签。

格式错误、来源拒绝、过期、取消和 unknown 均保留原语义。只有符合来源隔离、版本和语义准入条件的样本才进入训练；共用 SQL 日志不等于小模型训练数据已经完成准入或导出。

## 7. 当前证据与继续验收

Reflection 和四个整理辅助模式接入独立 schema、调用、预留、原件和消费。项目通过 `context_assistant_modes` 选择模式，通过 `context_assistant_profile` 使用已配置的小模型。主轮继续使用原项目模型配置。子代理的辅助模型调用使用子任务预算包装。真实主模型和小模型的任务效果仍按 CAP-01、VAL-01/02 验收。

Normalize 提供带原始片段引用的建议包。Organize 同时收到建议和原文，仍须绑定真实来源和持久化回执才能推进历史覆盖边界。

Recall 用词项检索提供有界来源池，再以模型选择定序。只有选中来源进入本轮候选和召回日志。项目知识 hash 在 Recall 提交事务内再校验。模型输出不合法或预算不足时保留失败原因并使用词项排序。过期结果需要新请求。

Parent Merge 以真实父任务、子终态、原件 hash 和待审候选为基础，输出会话内 `add_entry` 建议或补证据请求。主轮取得实际读取回执和原件引用，父层消费及知识提交继续使用各自协议。

Dream 从空闲窗口取得两级文档投影，输出整理、归档和召回建议。冻结项目和历史覆盖所依赖的条目受保护。前台启动优先，旧空闲请求取消后晚到输出保留在审计中。建议使用当时的投影，采纳前按新投影重新绑定。

实现：[辅助账本](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-auxiliary-store.ts)、[调用控制](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-auxiliary.ts)、[Reflection schema](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-reflection.ts)、[RuntimeLoop](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-loop.ts)。

验证：[账本与生命周期](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-auxiliary.test.ts)、[Reflection 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-reflection.test.ts)、[V2 桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)。完整组合与失败记录见[阶段十三](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-gap-closure-progress.md#阶段十三验证独立反思与辅助调用账本)。真实模型质量、其余受限模式和全部 20 项仍按原目标验收。
