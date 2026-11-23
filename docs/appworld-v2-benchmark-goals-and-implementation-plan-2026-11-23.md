# AppWorld V2 基准测试目标与实施方案

## 1. 文档目的

本方案定义本次 AppWorld V2 基准测试要验证的运行能力、上下文能力、训练闭环和评估边界。

本次测试使用 AppWorld 官方训练集、Normal 测试集和 Challenge 测试集，并保留每个 Case 的 Runtime Trace、工具回执、上下文修订、Evidence、DAG 状态、A2A 状态和官方评估结果。

V1 已经完成过基于项目变量和 Harness 的冻结闭卷评估。V2 的目标是把相同的可复现边界扩展到 `project_context`、`session_context`、Cache、DAG 和 A2A。

## 2. 基准测试总目标

```text
训练任务和执行证据
        ↓
反思、候选和 Evidence
        ↓
Project Context 冻结快照
        ↓
Session Context 和 Cache 的受控整理
        ↓
DAG、临时代码和 A2A 协同执行
        ↓
AppWorld 官方状态评估
        ↓
可审计的闭卷基准结果
```

测试结果需要同时回答两个问题：

1. Agent 能否完成 AppWorld 任务。
2. V2 的上下文、训练、DAG 和 A2A 机制是否稳定地支持任务完成。

## 3. V1 对照基线

V1 的有效闭卷流程是：

```text
90 个训练任务
    ↓
训练 Hook 提取经验
    ↓
project experience 和 Harness
    ↓
冻结项目变量
    ↓
Normal 168 题和 Challenge 417 题
    ↓
AppWorld 官方评估
```

V1 已经具备以下基线能力：

- 训练集和测试集分离。
- 测试前冻结项目经验。
- 测试阶段不接受新的训练经验。
- 每个 Case 使用独立 AppWorld 环境。
- 使用官方状态评估器计算 TGC 和 SGC。
- 训练、测试和官方导出使用固定模型、协议、项目提交和数据集哈希。

V2 需要保留这条闭卷边界，并将冻结对象扩展为：

```text
系统变量
+ Harness / Skill / Tool 版本
+ project_context 文档
+ Project Context Evidence
+ Project Context Revision
+ Project Projection Hash
```

## 4. 七项测试目标

### 4.1 A2A 子智能体闭环

#### 目标

验证父 Agent 能够基于 A2A 协议启动子 Agent，子 Agent 能完成受授权工作，父 Agent 能读取、消费并验证结果。

#### 必须覆盖

- `delegate_task` 创建子任务。
- 子任务绑定父 Session、父 Task、父 Run 和 Plan Node。
- 子 Agent 获得只读项目上下文和受限能力投影。
- 子 Agent 执行 AppWorld 工具或信息提取任务。
- 父 Agent 使用 `read_child_result` 或 `consume_child_result` 获取结果。
- 子结果进入父 Session Candidate，并绑定 Evidence。
- 父 Agent 只能在结果被接受后完成对应 DAG 节点。
- 子任务失败、等待输入、重试和 takeover 都有明确状态。

#### 验收指标

| 指标 | 通过条件 |
| --- | --- |
| 子任务创建 | 有真实 child task receipt 和 parent binding |
| 子任务执行 | 至少完成一个真实 AppWorld 子任务 |
| 结果回传 | 父 Agent 获得完整结果和 result hash |
| 上下文合并 | 生成带 Evidence 的 Session Candidate |
| 权限边界 | 子 Agent 没有写入 Project Context |
| 完成判断 | 父节点引用真实 child receipt 后完成 |

## 4.2 Project Context 训练和反思闭环

#### 目标

训练过程主要更新 `project_context`。任务错误经过反思后，应形成可审核的项目级候选，并将方法论和必要经验写入项目上下文。

#### 信息流

```text
训练 Case
    ↓
官方评估和错误证据
    ↓
Reflection
    ↓
Candidate + Evidence
    ↓
项目分类和项目锚点校验
    ↓
Project Diff
    ↓
project_context revision
    ↓
训练快照
```

#### 项目级允许保留

- API 发现方法。
- 认证和凭据选择方法。
- 分页和集合处理方法。
- 写操作前的读取和验证方法。
- 常见失败模式和恢复顺序。
- 跨应用任务的依赖和操作顺序。
- 可复用的工具调用约束。

#### 项目级禁止晋升

- 某个测试任务的最终答案。
- 某个账号的具体金额、联系人或订单号。
- 测试数据库中的具体状态。
- 只对单个 Case 成立的事实。
- Ground Truth、Evaluator 或测试私有数据。

#### 验收指标

| 指标 | 通过条件 |
| --- | --- |
| 反思触发 | 失败 Case 生成诊断和纠正计划 |
| 项目候选 | 候选包含分类、Evidence 和项目锚点 |
| 项目写入 | 只通过 Project Diff 和 Revision 门禁 |
| 训练快照 | 同时冻结变量和 Project Context 文档 |
| 答案隔离 | 测试 Case 的答案和私有状态不进入 Project Context |
| 失败保留 | 被拒绝和冲突候选保留为负样本 |

## 4.3 Cache 整理和无效信息移除

#### 目标

Cache 负责 Runtime 过程状态和兼容消息视图。ContextHistory 保存原始轨迹，Context Organizer 负责将重复、过期和无关内容转成归档或结构化信息，避免模型上下文持续增长。

#### 必须验证

- Cache 能够准确读取当前任务、计划、证据、失败历史和预算。
- 重复工具结果能够归并。
- 失败工具结果不会被当成事实。
- 无关来源能够进入候选或归档区。
- 关键用户目标、约束、未完成事项和 Evidence 不会被移除。
- 归档后可以通过 Recall 恢复为待审核 Candidate。
- Organizer 请求和主模型请求的预算分开统计。

#### 验收指标

| 指标 | 通过条件 |
| --- | --- |
| 压缩率 | 记录整理前后输入 Token 和字符数 |
| 关键保留率 | 受保护事实、约束和 Evidence 全部保留 |
| 无效移除率 | 标注的噪声和重复内容不进入当前 Projection |
| 归档可召回 | 归档来源可通过 source hash 和 locator 找回 |
| 任务保持 | 压缩后的任务成功率不低于未压缩对照 |
| 预算隔离 | Organizer Token 不吞占主模型任务预算 |

## 4.4 DAG 长链路执行

#### 目标

验证 Agent 能生成并完成较长的 DAG 执行链路，支持依赖、等待、分支、子任务、失败恢复和最终验收。

#### DAG 节点类型

- API 发现。
- 认证。
- 只读数据收集。
- 信息提取。
- 集合计算。
- 临时代码处理。
- 写操作。
- 写后验证。
- Context Diff。
- 子任务委派。
- 最终完成。

#### 验收指标

| 指标 | 通过条件 |
| --- | --- |
| DAG 长度 | 至少验证 10 个以上节点的任务 |
| 依赖关系 | 节点按依赖顺序执行，不能跳过前置条件 |
| 计划修订 | 失败后能基于真实状态修订 Plan Revision |
| 节点完成 | 每个节点使用自己的 actionRefs 和 evidenceRefs |
| 分支控制 | 支持等待、人工输入和子任务分支 |
| 最终验收 | 只有全部 required nodes 和官方状态满足后完成 |

## 4.5 DAG 临时代码和信息提取

#### 目标

允许 DAG 使用受控临时代码完成批量读取、筛选、聚合、转换和信息传递，减少模型重复读取和重复推理。

#### 当前可利用的执行能力

- AppWorld `appworld_execute` 可以在 AppWorld 环境中执行 Python。
- Skill Script 可以运行已注册的 Skill 脚本。
- Artifact 可以保存代码结果和 stdout。
- Evidence 可以绑定代码结果和来源。

#### 需要补齐的闭环

- DAG 原生代码节点。
- 代码节点输入和输出 Schema。
- 代码结果 Artifact 和 Plan Node 绑定。
- 代码结果自动生成 Evidence。
- 代码结果进入 Session Candidate 的明确入口。
- 代码超时、异常和部分结果的恢复规则。
- 临时代码不能访问测试 Ground Truth、宿主私有数据或评估器。

## 4.6 DAG 信息准确进入上下文

#### 目标

任何进入 Context 的 DAG 信息，都能回溯到：

```text
Plan Node
    ↓
Tool / Code / Child Receipt
    ↓
Artifact
    ↓
Evidence
    ↓
Candidate
    ↓
Semantic Diff
    ↓
Session Context 或 Project Context
```

#### 验收指标

- 每条 Information 都有 Evidence。
- 每条 Candidate 都能找到原始 Artifact。
- 每个 Project Candidate 都有有效项目锚点。
- 节点重试不会产生重复事实。
- 节点失败不会产生成功 Evidence。
- Context Diff 绑定正确的 `planTaskId`。
- Context Revision 和 Projection Hash 与提交时一致。
- 冲突内容保留双方 Evidence，不进行静默选择。

## 4.7 Project Context 方法论和答案隔离

#### 目标

Project Context 只承载跨任务可复用的方法论和必要经验，不承载测试答案。

#### 数据分层

```text
原始 Case 事实       → session_context
Case 失败和反思      → training candidate
跨 Case 方法论       → project_context
测试答案和私有状态  → evaluator reference，仅用于评估
```

#### 必须增加的检查

- Project Context 内容扫描任务 ID、订单号、账号金额和 Ground Truth 字段。
- Project Context 与测试答案集合做泄露比对。
- Project Context 与测试私有数据库值做泄露比对。
- 对每个晋升候选记录 `sourceTaskGroup`。
- 训练、验证和测试按任务组隔离。
- 测试阶段禁止 Project Context Candidate 晋升。
- 测试结束后才能读取训练和评估诊断。

## 5. 实施阶段

### 阶段 0：基准边界和环境确认

目标是建立可重复的测试根目录和版本边界。

检查内容：

- AppWorld Python 环境和官方数据。
- Tool、Skill、Harness 和 Plugin 版本。
- Model Provider、Protocol、Model ID。
- 项目 Git Commit 和 Tree Hash。
- 数据集 Content Hash 和 Cohort Hash。
- 训练、验证、测试 Case 分组。

产物：

- `benchmark-manifest.json`
- `project-context-snapshot.json`
- `dataset-manifest.json`
- `model-config.json`

### 阶段 1：A2A 和 DAG 专项验证

使用少量合成任务和 AppWorld 复合任务验证：

- 子任务创建和回传。
- 父子权限。
- 长 DAG。
- Plan Revision。
- 节点 Evidence。
- `complete_plan_nodes`。
- 等待、重试和 takeover。

通过后才进入上下文训练评估。

### 阶段 2：Project Context 训练闭环

使用 AppWorld 训练集生成项目候选。

```text
训练执行
    ↓
官方评估
    ↓
错误反思
    ↓
候选审核
    ↓
方法论抽取
    ↓
Project Context Diff
    ↓
审计和冻结
```

此阶段需要扩展训练快照，使其同时包含：

- Project Context Document
- Project Context Revision
- Project Evidence
- Project Candidate
- Apply Receipt
- Projection Hash
- Archive 和 Recall 状态

### 阶段 3：Cache 和信息流验证

使用固定任务验证：

- 重复结果。
- 无关结果。
- 失败结果。
- 冲突结果。
- 大型工具结果。
- 分页文件结果。
- 召回归档结果。

记录：

- 每轮输入 Token。
- Cache 大小。
- Coverage 进度。
- Organizer Token。
- 主模型 Token。
- 归档数量。
- 召回数量。
- 任务完成率。

### 阶段 4：模型协议和预算稳定性

需要验证：

- 原生工具参数 JSON 错误的有限修复。
- AppWorld 工具失败后的继续执行。
- Context Organizer 和主模型预算隔离。
- 长 DAG 下的模型轮数。
- 任务完成 Receipt 和官方评估解耦。
- 已完成 AppWorld 状态不因最终回复预算不足而丢失。

### 阶段 5：小规模 GLM 试跑

试跑顺序：

1. 1 个单应用查询任务。
2. 1 个单应用写入任务。
3. 1 个批量信息提取任务。
4. 1 个跨应用任务。
5. 1 个 A2A 任务。
6. 1 个长 DAG 任务。

每个任务至少保存：

- Runtime Trace。
- Context Before / After。
- Cache Before / After。
- DAG Before / After。
- A2A Receipt。
- Tool Receipt。
- Evidence。
- 官方评估结果。

### 阶段 6：正式闭卷基准

正式运行必须满足：

- Project Context 已冻结。
- 测试阶段不能晋升 Project Candidate。
- 测试结果不能进入训练上下文。
- 测试快照包含结构化 Project Context。
- 测试使用固定 Model、Protocol、Commit 和 Dataset Hash。
- Normal 和 Challenge 分开统计。
- 每个 Case 都有官方评估结果或明确基础设施失败。
- 失败 Case 不被静默重试成成功。

## 6. 运行结果指标

### AppWorld 任务指标

- Task Goal Completion。
- Scenario Goal Completion。
- 完整通过率。
- Requirement 通过率。
- 平均工具交互次数。
- 平均 DAG 节点数。
- A2A 使用率和子任务完成率。

### 上下文指标

- Project Context Revision 数量。
- Session Context Revision 数量。
- Candidate 接受率。
- Candidate 拒绝率。
- 冲突保留率。
- Evidence 引用完整率。
- Archive 命中率。
- Recall 命中率。
- 压缩前后 Token。
- 关键事实保留率。

### 训练指标

- 训练候选数量。
- 反思候选数量。
- Project Candidate 晋升数量。
- 被拒绝候选数量。
- Replay 通过率。
- Project Context 泄露检测结果。
- 测试阶段 Context 变化数量。

### Runtime 稳定性指标

- 模型协议错误率。
- 工具参数错误率。
- Tool Retry 成功率。
- DAG Revision 冲突数。
- A2A 超时和失败数。
- Runtime Budget Exhausted 数量。
- AppWorld completed receipt 和 Runtime terminal 状态不一致数量。

## 7. 正式测试前的完成条件

```text
[x] Project Context 可冻结、可恢复、可校验
[x] Project Context 不包含测试答案
[x] Session Context 每个 Case 独立初始化
[x] 测试阶段禁止 Project Candidate 晋升
[x] Cache 压缩指标可记录
[x] Organizer 和主模型预算已分离
[x] A2A 至少完成一个端到端任务
[x] DAG 至少完成一个长链路任务
[x] 临时代码结果能够进入 Evidence
[x] AppWorld completed receipt 能独立触发官方评估
[x] 工具参数错误能够有限恢复
[x] Normal 和 Challenge 数据集哈希固定
[x] 训练、验证、测试任务组隔离
[ ] 全量运行结果可以生成官方导出包
```

## 8. 当前判断

当前代码已经达到阶段 1 到阶段 5 的专项验证和正式基准开工水准。全量成绩还需要在安装官方数据、配置模型服务并冻结具体 Commit 和数据集哈希的环境中生成。

本方案把 AppWorld 从单纯的任务完成测试扩展为一组可审计的能力测试，最终成绩需要同时包含任务得分、A2A、DAG、Cache、上下文质量、训练隔离和 Runtime 稳定性指标。

## 9. 本轮实现结果

本轮把计划中属于运行时闭环的缺口补到了主项目，并把 AppWorld 特化的答案泄露检查留在 `examples/appworld`。

### 9.1 Project Context 训练快照和测试边界

- `TestSnapshot` 同时保存变量和完整的 `ContextDocumentEngineState`。
- 快照内容哈希覆盖变量和 Project Context 文档，包含 Evidence、Candidate、Revision、Projection、Review Receipt 和 Evidence Review Receipt。
- 测试运行从快照恢复 Project Context，并通过 `projectContextReadOnly` 拒绝观察、候选晋升、语义 Diff 和持久化写入。
- Session Context 在测试期间仍然可以独立运行，测试状态不会反向写入训练项目。
- 训练子运行的 Project Context 状态进入 Experiment Trace。训练管理器在训练 Case 完成后按照项目 Revision 门禁提交回主项目，并记录成功或失败事件。

### 9.2 Cache 和模型预算

- Context Organizer 的模型预算使用独立的 `runId:organize` 作用域。
- 主模型预算统计不再被 Organizer 请求消耗，运行状态同时可以查看主模型和 Organizer 的预算汇总。
- 原始消息、归档、Recall、候选、冲突和 Evidence 仍由现有 Context Training Sample、Commit Receipt 和 Archive/Recall 记录承载。

### 9.3 官方评估和运行时失败

- Experiment Adapter 增加通用的 `evaluate_on_runtime_failure` 声明。
- 声明该能力的适配器可以在 Runtime 没有产生最终文本、但环境状态已经可评估时继续调用官方评估器。
- 运行状态、失败原因、工具回执和评估结果一起写入 Case Trace。主项目通过通用适配器能力控制该流程，AppWorld 仅在自身适配器清单中启用该能力。

### 9.4 DAG 代码节点和证据链

DAG 节点通过当前阶段能力投影绑定 `appworld_execute` 或 `run_skill_script`。代码执行结果沿用 Runtime Artifact、Tool Receipt 和 Evidence 入口，随后才能进入 Session Candidate 或 Project Candidate。AppWorld 的临时代码继续运行在隔离的 AppWorld 环境中，宿主项目只接收受控回执。

### 9.5 Project Context 答案隔离

`examples/appworld/scripts/validate_project_context_leak.mjs` 负责读取冻结 Project Context、数据集引用和 AppWorld Ground Truth 的受限字段，输出脱敏的泄露匹配哈希。`run_experiment.mjs` 可以通过 `--project-context` 在新测试运行前执行该检查。检查失败时不会启动闭卷测试。

### 9.6 已验证的测试入口

```powershell
npm run typecheck --workspace=apps/backend

$env:CAPYBARA_TEST_PROJECT_DIR = (Resolve-Path examples/test-project).Path
npx tsx --conditions=development --test apps/backend/test/training-manager.test.ts
npx tsx --conditions=development --test apps/backend/test/project-context-runtime.test.ts
npx tsx --conditions=development --test apps/backend/test/runtime-model-budget.test.ts
npx tsx --conditions=development --test apps/backend/test/experiment-manager.test.ts

node --test examples/appworld/scripts/validate_project_context_leak.test.mjs
node examples/appworld/scripts/smoke_adapter.mjs
```

上述定向测试覆盖快照持久化、Project Context 只读恢复、Session 写入、Organizer 预算隔离、运行时失败后的官方评估、泄露检测和 AppWorld 适配器协议。A2A、长 DAG、计划修订、节点 Evidence、等待、重试、Takeover、Archive 和 Recall 继续由主项目已有的运行时测试覆盖。

## 10. 正式运行前的操作顺序

```text
生成并冻结训练 Project Context
        ↓
使用 validate_project_context_leak.mjs 检查答案隔离
        ↓
以 --project-context 启动 Normal 测试
        ↓
以相同 Project Context 和 Commit 启动 Challenge 测试
        ↓
导出 Runtime Trace、Context、DAG、A2A、Evidence 和官方评估结果
```

正式全量成绩仍需要在已经安装 AppWorld 数据、配置模型服务的环境中执行。AppWorld 的任务字段、Ground Truth 和答案规则只由适配器与示例目录处理，主 Runtime 接收结构化回执和证据。
