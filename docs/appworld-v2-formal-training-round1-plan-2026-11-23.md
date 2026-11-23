# AppWorld V2 第一轮正式训练目标与实施方案

## 1. 文档目的

本文档定义第一轮 AppWorld V2 正式训练的目标、运行边界、执行步骤、监控方式和验收标准。

本轮工作验证现有 V2 Runtime 是否能在真实 AppWorld 训练任务中形成可审计的训练闭环。训练过程中只验证和记录通用运行机制，不为单个题目增加特定规则、答案或专用工具。

## 2. 本轮目标

### 2.1 主目标

```text
AppWorld 任务
  ↓
RuntimeLoop / DAG / Tool Round
  ↓
工具结果与 Evidence
  ↓
Session Context 与 Cache 整理
  ↓
失败反思与训练候选
  ↓
Project Context 候选与受控更新
  ↓
训练快照、审计日志和官方评估结果
```

### 2.2 七项能力目标

| 编号 | 目标 | 需要观察的结果 |
| --- | --- | --- |
| G1 | A2A 子智能体闭环 | 父任务创建子任务，子任务完成受授权工作，结果带回父 Session 并可被父任务消费 |
| G2 | Project Context 训练闭环 | 失败任务经过反思形成候选，候选通过项目锚点和 Revision 门禁后进入项目级训练快照 |
| G3 | Cache 整理 | 当前任务、约束、Evidence 和未完成事项得到保留，重复、过期和无关内容可归档并可召回 |
| G4 | DAG 长链路 | 任务可形成多节点依赖链，支持工具、等待、重试、代码节点、子任务和最终验收 |
| G5 | DAG 信息提取 | 临时代码或信息提取结果有 Artifact、Tool Receipt、Evidence 和上下文引用链 |
| G6 | 上下文准确流转 | 信息从工具或代码结果进入 Candidate，再通过 Semantic Diff 进入 Session Context 或 Project Context |
| G7 | 训练答案隔离 | Project Context 只保留跨任务方法论和必要经验，不包含题目答案、私有状态或 Ground Truth |

结果需要区分运行机制、模型能力和数据覆盖。训练集没有触发的路径标记为“未覆盖”，不能推断为“已通过”。

## 3. 固定运行边界

| 项目 | 第一轮固定值 |
| --- | --- |
| Git 工作树 | `tmp/appworld-formal-round1` |
| 运行代码 | Commit `9b42fec4` |
| 训练数据 | `appworld-train-all-scenarios` |
| 训练样本数 | 90 |
| 并发数 | 1 |
| AppWorld 环境 | 每个 Case 独立工作树和独立运行状态 |
| Project Context | 训练运行可更新，测试运行只读冻结 |
| 任务特化改动 | 禁止 |

| 角色 | 配置 |
| --- | --- |
| 主模型 | GLM-5.3-Flash |
| 主模型协议 | OpenAI Chat Completions 兼容协议 |
| 上下文整理模型 | 独立 `organizer-glm` 配置 |
| 上下文输入上限 | 128,000 tokens |
| 当前运行时输出预留 | 8,192 tokens |

此前使用 64,000 输出预留值时，服务端按预留值占用预算，单个 Case 的预算被放大，正式运行因此停止。当前 8,192 值是运行预算配置，不改变任务逻辑，也不为题目增加处理规则。

训练阶段可以产生 Session Context 修订、Cache 整理、Reflection、Project Candidate、Project Diff、Tool Receipt、Artifact、Evidence 和 Runtime Trace。所有项目级写入必须经过：

```text
候选生成 → 项目锚点真实性校验 → Project Diff → Revision 门禁 → Project Context 更新
```

测试阶段使用训练结束后的冻结 Project Context，不允许 Candidate 晋升或项目级写入。

## 4. 实施步骤

### 阶段 0：环境预检

检查工作树 Commit、Python 环境、AppWorld 数据集、模型列表、主模型和整理模型最小请求、项目配置、凭据注入、Experiment Run 创建和 Project Context 泄露检查。

预检结果写入 `benchmark-manifest.json` 和本轮运行日志。日志不得出现 API Key 明文。

### 阶段 1：单 Case 冒烟

运行一个训练 Case，确认主模型请求、工具调用、AppWorld 服务、官方状态查询、Runtime Trace、Tool Receipt、Session Context、Cache、Organizer 独立预算、Project Context 训练样本和官方评估均能落盘。

冒烟运行只用于发现配置、协议、额度和基础设施错误，不用于修改任务逻辑。

### 阶段 2：正式训练

```text
dataset: appworld-train-all-scenarios
concurrency: 1
timeout: 900000 ms per case
poll interval: 10000 ms
main profile: main-glm
organizer profile: organizer-glm
project context: writable during training
```

每个 Case 结束时保存 Case 状态、官方评估、主模型和 Organizer Token、Tool Receipt、Artifact、DAG 状态、Plan Revision、节点 Evidence、A2A 回执、Cache 整理、Archive、Recall、Session Context 前后版本、Project Candidate、Project Diff、Project Context Revision、训练样本和 Projection Hash。

### 阶段 3：运行监控

按固定间隔读取 Experiment API、Case 状态和数据库回执，关注进度、HTTP 状态、延迟、重试、输入输出 Token、主模型和 Organizer 预算、工具错误、上下文 Revision、Candidate、Archive、Recall、Project Context、A2A 和 DAG。

每次重要状态变化写入本轮监控日志，包含时间、Run ID、Case ID、状态、错误类别和恢复动作，不记录密钥。

### 阶段 4：错误处理

可自动处理临时服务错误、受控重试、工作树清理失败、日志目录缺失、配置读取路径错误和通用 Profile 凭据加载问题。

遇到持续 401、403 或额度拒绝，主模型或 Organizer 连续超时，预算预留明显超过配置上限，跨项目写入，答案或 Ground Truth 进入 Project Context，或 Runtime、官方评估和数据库回执无法对应时，停止本轮并保留现场。

停止后只修复通用配置或运行时问题，再使用新的 Run ID 重试。不得针对失败题目添加特定答案或特殊分支。

### 阶段 5：训练后审计

汇总任务完成率、TGC、SGC、工具指标和 Runtime 失败，统计 A2A、DAG、Cache、Archive、Recall 和 Reflection 的实际覆盖，对 Project Context 执行答案泄露检查，校验每个 Revision 的 Candidate、Evidence 和 Apply Receipt，抽查失败、拒绝、冲突和归档样本，导出训练快照、Trace、数据库摘要和评估结果。

## 5. 验收标准

### 5.1 运行完整性

- 90 个训练 Case 都有终态。
- 每个终态都能定位到 Runtime Trace 和官方评估结果，或明确记录基础设施失败。
- 主模型、Organizer、工具和官方评估的 Run ID、Case ID 可以互相对应。
- 取消、失败和重试不会伪装为成功。

### 5.2 上下文闭环

- Session Context 和 Project Context 使用不同作用域和 Revision。
- Project Context 更新都带 Candidate、Evidence、锚点和 Apply Receipt。
- Cache 归档内容可通过 source hash 和 locator 找回。
- 关键目标、约束、未完成事项和 Evidence 没有被整理过程丢失。
- 被拒绝内容和冲突双方保留为可审计样本。

### 5.3 训练隔离

- 测试答案、Ground Truth 和私有状态未进入 Project Context。
- Project Context 主要包含方法论、工具约束和跨任务经验。
- 训练、验证和测试任务集合与快照边界清楚。
- Project Context 快照可恢复，Projection Hash 可复核。

### 5.4 能力覆盖

- 观察到真实 A2A 子任务创建和结果回传，或明确记录“训练集未覆盖”。
- 观察到多节点 DAG，或明确记录“训练集未覆盖”。
- 观察到 Cache 整理、归档和召回，或明确记录“训练集未覆盖”。
- 观察到反思候选和项目级晋升，或明确记录“训练集未覆盖”。

## 6. 运行产物和审计日志

```text
tmp/appworld-formal-round1/
  examples/appworld/
    experiments/outputs/
    experiments/runs/
    .capybara/worktrees/
    .capybara/experiments/
```

计划和审计文档：

```text
docs/appworld-v2-benchmark-goals-and-implementation-plan-2026-11-23.md
docs/appworld-v2-formal-training-round1-plan-2026-11-23.md
```

运行日志至少包含冒烟运行、每次正式运行的启动和终态、模型及配置检查、预算与 HTTP 错误摘要、Project Context 泄露检查、最终报告路径和校验摘要。

## 7. 当前状态

| 项目 | 状态 |
| --- | --- |
| V2 Project Context 快照和只读测试边界 | 已实现 |
| Session Context 与 Project Context 分离 | 已实现 |
| Organizer 独立预算统计 | 已实现 |
| 训练 Project Context 写回和 Revision 门禁 | 已实现 |
| AppWorld 泄露检查入口 | 已实现 |
| 单 Case 冒烟 | 已完成 |
| 64K 输出预留正式运行 | 因预算预留放大而停止 |
| Organizer Profile 凭据加载 | 已通过通用运行时修复，独立 Organizer 请求可成功记录 |
| 8K 输出预留正式运行 | 已启动，当前运行中 |
| 90 Case 正式训练 | 运行中，Run ID `a63e95d0-2088-42fa-b136-75c93bb825a4` |

当前正式运行没有检测到 401、403、429、额度拒绝或 Runtime 错误。已完成 7/90 个 Case，其中 6 个通过、1 个为模型任务质量失败，当前没有将该失败转化为题目特化逻辑。正式运行仍需持续到 90 个 Case 结束，再进行闭环、覆盖和答案隔离审计。

## 8. 下一步

1. 持续监控 90 Case 第一轮正式训练，记录进度、预算、HTTP 状态、工具结果和上下文审计事件。
2. 对模型质量失败、基础设施失败、取消和重试分别归类，不用题目特化逻辑修复模型质量失败。
3. 训练结束后执行答案隔离、Project Context Revision、Cache 归档/召回、A2A、DAG 和 Reflection 覆盖审计。
4. 核对训练快照、Runtime Trace、Context Training Sample、官方评估和最终报告的完整性。
5. 仅在终态和审计均满足验收条件后，决定是否进入验证集。

