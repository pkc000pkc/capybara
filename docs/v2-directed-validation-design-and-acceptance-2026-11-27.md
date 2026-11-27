# V2 定向验证设计与验收方案

版本：2026-11-27 · 范围：P0 首轮定向验证、P1/P2 后续施工边界

## 1. 目标与约束

本轮先验证 RuntimeLoop、DAG、A2A、完成门禁和真实 Artifact 是否形成闭环。测试采用单题或本地合成场景，保存完整 Trace 和验收摘要，不启动全量 AppWorld。

每个验证场景都必须同时记录：

- 输入任务和固定项目版本
- 投影能力与提示词版本
- 模型请求、工具调用和工具回执
- Workflow 或 A2A 的状态变化
- Artifact、Evidence、Receipt 和上下文修订
- 官方状态评估或本地协议断言
- 输入、输出和整理器 Token

基准测试遵守独立尝试、禁止按评估结果重试和禁止状态回滚的约束。失败恢复只能使用 Runtime 已经记录的真实回执。

## 2. P0 设计

### 2.1 DAG 定向验证

验证链路为：

```text
模型生成 execute_workflow
  → RuntimeLoop 校验投影和版本
  → 编译 workflow-definition
  → 执行工具节点和确定性节点
  → 保存 workflow-result、节点 receipt 和 artifact
  → 将结果返回模型
  → 断言最终状态
```

选择两个层次的样本：

1. 本地合成 Workflow 测试，覆盖工具节点、transform、assert、schema glue 和失败恢复。
2. AppWorld 定向样本 `76f2c72_1`，只运行一题，确认真实 `appworld_execute` 能进入 Workflow，且产生真实 `workflow-definition` 与 `workflow-result`。

DAG 验收不以“工具被调用”作为充分条件，必须检查：

- `execute_workflow` 在投影中可见并被实际调用
- Workflow plan 状态进入 `completed` 或有明确的失败状态
- `workflow-definition` 与 `workflow-result` Artifact 存在
- 节点数量、节点类型、依赖和状态与定义一致
- 结果 Artifact 能通过节点 receipt 回溯到工具输出
- 失败 Workflow 不执行被依赖阻塞的后续节点

### 2.2 A2A 定向验证

先使用本地 RuntimeLoop 合成场景验证协议，避免把 AppWorld 配额消耗在协议错误上。场景覆盖：

```text
父代理创建子任务
  → 子任务获得受限只读能力
  → 子代理完成局部读取或分析
  → 父代理等待 child.status
  → 父代理读取并消费 child result
  → Session Candidate 绑定 Evidence
  → 父节点引用 child receipt 后完成
```

选择 `runtime-child.test.ts` 中的本地同步子任务、异步等待、结果消费和权限拒绝用例作为第一批验收样本。已有 AppWorld A2A 样本 `22cc237_1` 的历史 Trace 只作为对照证据。只有本地协议验收通过且剩余额度满足单题预算时，才追加一题 AppWorld A2A 验证。

A2A 验收必须确认：

- child session、parent session、task、run 和 plan node 绑定一致
- 子代理不能继续派生子代理
- 子代理不能写入 Project Context
- 子代理结果具有 result hash 和来源 Artifact
- 父代理在消费结果前不能完成对应节点
- 失败、超时、取消和 takeover 均有明确终态

### 2.3 `complete_task` 完成门禁

完成门禁分为三层：

1. AppWorld Tool 只有在 `/task_completed` 返回真实 `true` 时输出 `completed: true`。
2. RuntimeLoop 只能把真实工具回执作为完成证据，不能把模型文本或工具调用成功当成完成。
3. Experiment Adapter 以官方状态评估为最终结果，运行失败和状态未完成不能被标记为通过。

验收使用一个未完成调用和一个完成调用：

- 未完成调用返回 `completed: false`，模型仍需继续调用工具。
- 完成调用返回 `completed: true`，并生成最终完成证据。
- 伪造 `completed: true`、缺少真实 receipt 或仅返回文本时必须拒绝完成。

### 2.4 真实 Workflow Artifact

验收从 Runtime Trace 和 Artifact Store 双重检查，不依赖模型最终回复：

| 对象 | 必须存在 | 必须满足 |
| --- | --- | --- |
| workflow-definition | 是 | 包含 goal、steps、version 和 graph hash |
| workflow-result | 是 | 包含每个节点状态与输出或失败原因 |
| Tool Receipt | 是 | 绑定真实工具调用和 resultArtifactId |
| Evidence | 有上下文承接时必须存在 | 能回溯到节点和原始结果 |
| Runtime Workflow Plan | 是 | 状态与 Artifact 结果一致 |

## 3. P1 施工设计

P1 只在 P0 验收通过后推进，顺序固定为：

1. 紧凑 Workflow 意图和 RuntimeLoop 编译，减少模型重复生成完整 DAG schema。
2. AppWorld 只读子代理能力，限定为目录、文档和状态读取。
3. 按 planning、execution、verification、completion 阶段分配模型输出预算。
4. 完成状态补救轮，优先消费 `completed: true` 回执，避免无意义的最终模型轮次。
5. 工具结果逐实体快照，保存实体 ID、字段、时间和来源回执。
6. Benchmark 隔离模式，冻结 Project Context、禁止测试期晋升和跨 Case 训练回流。

P1 每项施工都要增加一个本地协议测试和一个单题定向验证，不直接进入全量基准。

本轮施工先落地输出预算门控。项目配置的 `reserved_output_tokens` 仍是提供方上限，RuntimeLoop 根据当前阶段为每次请求选择更小的预留值，并把实际值写入 model-request Artifact。普通 direct、investigation、execution 阶段上限为 12K，planning 和 delegation 阶段上限为 8K，verification 阶段上限为 6K，等待、证据和复核阶段上限为 4K，控制补救轮上限为 4K。上下文整理默认按 4K 字符分批，输出预留为 2K。项目配置低于这些值时沿用项目配置。验收要求同一运行的最终请求不能因为全量 64K 预留而在模型预算门禁处提前失败，同时上下文整理不能把主模型的输出上限整段复制为自身预留。

上下文投影还必须以持久化 `ContextHistory.coverage` 为边界。组织器失败、运行恢复或工作视图滞后时，主模型请求仍只能携带 `ContextHistory.project()` 返回的未覆盖组和明确保留组，不能回退到完整 `llmMessages`。验收使用已提交覆盖后人为恢复过期工作视图的场景，确认已承接的工具原文不会重新进入下一轮请求，并记录输入 Token 变化。

紧凑 Workflow 意图采用 `execute_workflow` 的受限输入变体。模型只提交 `version`、`goal` 和 `intent`，其中 `intent.calls` 使用 `args` 表示工具参数，`intent.operations` 使用 `op` 表示确定性算子。RuntimeLoop 在进入现有编译器前把它展开为标准 `steps`，再执行相同的投影、引用、依赖、权限和节点上限校验。标准 `steps` 仍然兼容，紧凑意图不会增加新的执行权限，也不会允许模型绕过现有节点校验。成功运行的 `workflow-definition` 保存展开后的规范定义，失败运行保存原始意图和校验错误，便于回放和修复。

紧凑意图验收要求：

- `calls` 能展开为标准 tool 节点，`args` 能完整保留并支持上游 `$ref`。
- `operations` 至少覆盖 parse、filter、transform、assert、align、validate_schema、join 和 foreach，并复用标准节点的表达式、引用和上限校验。
- 同时提供 `steps` 与 `intent`、未知 `op`、重复 ID、非法引用和未投影工具时必须拒绝，不能部分执行。
- 规范 `workflow-definition` 的 hash、节点数量和执行结果与等价标准 Workflow 一致，不增加模型请求。

AppWorld 只读子代理通过专用 `appworld_readonly_execute` 能力提供。该能力与 `appworld_execute` 使用相同的任务状态和结果协议，但工具契约标记为无外部副作用，并在 runner 边界执行确定性的只读代码门禁。门禁拒绝导入、文件或进程访问、动态执行、Supervisor 完成或写操作，以及不在只读方法白名单中的应用 API 调用。普通 `appworld_execute` 保持原有 action 能力，父代理仍可按 A2A 授权显式授予它。

AppWorld 只读子代理验收要求：

- 只读子代理投影中能看到 `appworld_readonly_execute`，不能看到 `delegate_task`，也不能因该能力获得 `appworld_execute`。
- API 文档、列表、搜索、读取和状态查询代码可以执行并产生普通工具回执。
- import、文件/进程访问、动态执行、Supervisor 完成、明显写操作和未知 API 方法在 runner 侧拒绝，且不产生 AppWorld 状态变化。
- 父代理仍需消费 child result，原始结果、权限绑定和错误 receipt 可回溯，普通 AppWorld 完成门禁不因只读能力而放宽。

整理器对可机械修复的引用格式错误采用有限确定性归一化。`observations`、`archiveProposals` 和 `uncertainties` 中的重复 `sourceRefs` 按首次出现顺序去重，未知来源、空数组、非字符串和其他 schema 错误继续拒绝。归一化位置保留在请求记录的 `normalizationWarnings` 中，并把该请求标记为不可用于监督训练，避免把修复后的模型输出直接当作高质量样本。验收要求重复引用可以继续完成正常的证据绑定和文档 diff，原始来源 ID 不被替换，监督资格被撤销。

A2A 长交付的补充设计是按请求预算做有界工具描述压缩。工具名称、参数 schema、能力绑定和授权哈希保持不变，只压缩超长说明文本；只有完整 system、历史和工具 schema 超过当前输入预算时才启用。验收要求子代理长结果仍能完成读取、证据绑定、父层消费和最终完成，工具调用权限与参数校验保持原有结果。

逐实体快照的实现边界如下。运行时只从已经写入 Result Artifact 的结构化成功结果中提取实体，不让模型参与抽取，也不把自然语言行猜测成实体。顶层数组以及 `items`、`data`、`results`、`records`、`entities` 数组中的对象作为候选记录。记录必须有 `id`、`uuid`、`entity_id` 或以 `_id` 结尾的标识字段，优先使用 `id`，没有可识别标识的记录继续保留在原始 Artifact 中。每个快照保存实体类型、实体标识、完整字段、采集时间、来源 Artifact ID 和内容哈希。快照是结果的派生索引，不能替代原始 Artifact，也不能改变上下文候选的证据来源。

逐实体快照验收要求：

- 结构化数组和包在 `items` 下的结果都能生成快照，标识、字段、时间和来源 Artifact 一致。
- 无标识的对象、纯文本结果和失败结果不生成快照，原始 Artifact 仍可回读。
- 同一 Observation 恢复或重复 upsert 不重复追加快照。
- Observation、Runtime Snapshot 和实验 Trace 能携带快照，且快照来源可回溯到同一 Result Artifact。
- 抽取过程不增加模型请求，不放宽工具权限，不改变完成门禁和上下文证据绑定。

## 4. P2 设计边界

P2 作为正式评估和发布工作处理：

- A2A、DAG、直接工具三组对照
- 训练数据独立下游质量评测
- 归档、召回和冲突保留的长任务收益
- 远端 MCP 和外部子代理宿主
- Git 工作树和实验产物分层整理

P2 的对照实验必须使用相同模型、数据集、项目 Commit、任务集合和配额策略。

### 本地三组策略对照

在不消耗 AppWorld 配额的前提下，使用同一个 `examples/test-project` 任务和确定性模型模拟器，分别执行直接工具、DAG Workflow、A2A 子代理三条路径。三组任务目标、项目文件、完成门禁和输入预算保持一致，只改变执行策略。

每组记录模型请求数、工具调用数、Workflow definition/result Artifact 数、子代理启动与消费状态、最终 `run.state.changed=completed` 以及完成门禁结果。对照只用于验证 RuntimeLoop 的路径完整性和成本采集，不替代 AppWorld 官方 pass@1 结果。

验收条件如下：

1. 三组均能完成同一个只读任务，直接工具组不产生 Workflow Artifact，DAG 组产生已完成的 Workflow definition 和 result，A2A 组产生已消费的成功子代理记录。
2. 三组均通过完成门禁，任何未消费子代理、未验证证据或失败 Workflow 都不能被标记为完成。
3. 输出对照表能够区分模型轮次、工具轮次和确定性节点数量，避免把“调用过工具”当成任务完成。
4. 失败时保留 receipt、evidence 和状态迁移，测试不依赖回滚或评测结果重试。

### 训练数据独立下游审计

独立审计器只读取已保存的整理评测报告，不调用主模型、整理模型或 RuntimeLoop。审计对象是留出场景的答案字段、来源文件哈希、整理前后输入用量、覆盖游标、原始读取次数和最终结构校验结果。审计器不能根据模型输出重新生成期望答案，也不能修改训练样本。

验收条件如下：

1. 每个留出场景同时标记 `comparable` 和 `deliveryPassed`，否则整份报告失败。
2. 整理前后的来源文件哈希必须一致，答案字段数量和正确值必须独立核对，`correctFieldsDelta` 必须为零。
3. 整理分支必须有正覆盖游标，后续主模型请求不重复携带原始读取组，且主轮输入量低于原始分支。
4. 审计过程不需要模型密钥，不产生新的训练样本，也不把评测结果写回项目或会话上下文。

### 归档与召回收益

使用本地 ContextDocumentEngine 构造同一份包含相关信息和无关信息的文档。先将无关条目标记为归档，再测量活跃投影字符数和召回结果。验收要求活跃投影不含归档正文，召回按关键词返回同一条原始条目和证据，归档前后的文档 revision、receipt 和来源身份可回溯。

### MCP 与子代理宿主验收分层

MCP 验收分为 Streamable HTTP 传输层和真实远端服务层。传输层使用本地 HTTP 服务验证认证头、工具发现、结果边界和密钥隔离，真实远端层再验证连接生命周期、服务端版本变化和外部网络失败。

子代理宿主验收分为 RuntimeLoop 宿主回调契约、独立进程宿主和外部宿主三个层级。前一层确认父绑定、runner 身份、只读投影和结果消费，后两层需要独立进程或可访问的宿主端点，不能用内存回调结果冒充完成。

## 5. P0 通过标准

本轮 P0 只有在以下条件全部满足时才算通过：

- DAG 本地合成测试通过，且 AppWorld 定向题产生真实 Workflow Artifact。
- A2A 本地同步和异步闭环通过，权限和父子边界断言通过。
- `complete_task` 未完成和完成两条路径均通过门禁测试。
- Trace 中能按 Artifact、Receipt、Evidence 还原 DAG 和 A2A 链路。
- 定向运行未使用全量数据，Token、失败和剩余额度均被记录。

任何一项只有提示词证据、没有 Runtime 或 Artifact 证据，都不能标记为通过。

## 6. 输出产物

本轮输出：

- `docs/v2-directed-validation-design-and-acceptance-2026-11-27.md`
- 本地协议测试结果
- DAG 定向运行报告
- A2A 定向运行报告
- `complete_task` 门禁报告
- Workflow 和 A2A Artifact 摘要
