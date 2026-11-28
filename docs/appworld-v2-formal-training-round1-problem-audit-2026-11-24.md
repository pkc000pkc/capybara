# AppWorld V2 第一轮正式训练问题审计

## 1. 文档目的

本记录整理第一轮 AppWorld V2 正式训练暴露的问题，重点分析 A2A、训练样本、经验晋升、Project Context、Session Context、Cache、DAG 和运行时额度边界。

本文只记录当前证据和问题边界，供后续逐项讨论。没有根据单个题目增加答案、规则或特化分支。

## 2. 当前运行快照

正式轮使用 90 个唯一训练题目，主模型为 GLM-5.3-Flash，运行器使用并发 1、单题 900 秒活动时限和共享 400,000 token Case budget。

当前唯一题目状态如下。

| 状态 | 数量 |
| --- | ---: |
| passed | 26 |
| failed | 44 |
| error | 2 |
| cancelled | 18 |
| 合计 | 90 |

已落盘 73 个 Trace，18 个题目仍是额度守门产生的取消状态。累计实际用量约为 17.33M tokens，其中输入约 16.72M，输出约 0.61M。

权威运行数据位于：

- `tmp/appworld-formal-round1/examples/appworld/.capybara/experiments.sqlite`
- `tmp/appworld-formal-round1/examples/appworld/experiments/outputs/`
- `tmp/appworld-formal-round1-monitor.md`

## 3. 错题原因

### 3.1 官方任务失败

44 个 `failed` Case 没有 Runtime failure，主要由 AppWorld 官方状态评估判定为任务未完成。常见表现包括：

- 最终答案没有提交。
- 目标数据对象没有创建、更新或删除。
- 目标对象状态没有改变。
- 记录数量或字段内容不符合要求。
- 工具调用完成了局部工作，但没有完成最终状态闭环。

这些失败属于模型执行能力、任务完成稳定性或预算影响，需要与上下文协议错误分开统计。

### 3.2 运行时错误

2 个 `error` Case 都来自初始正式轮的 900 秒活动运行时超时。续跑阶段没有新增运行时错误。

### 3.3 额度和预算问题

初始正式轮末尾出现提供商 HTTP 429，原因是 5 小时使用窗口耗尽。原有运行器只观察已完成 Case，活动 Case 可能在终态落盘前继续消耗大量 token。

后续增加了两层通用预算控制：

- Run 级窗口安全余量。
- Actor、Organizer、Scorer 共享的 Case token budget。

共享预算修复后，单题用量降到约 0.14M 至 0.40M 范围，续跑阶段没有新增 429。

### 3.4 Organizer 和结构化协议问题

训练样本中出现了以下拒绝和失败类型：

- `CONTEXT_ORGANIZATION_OUTPUT_TRUNCATED` 55 次。
- `CONTEXT_ORGANIZATION_CANDIDATE_REQUIRED` 23 次。
- `EVIDENCE_NOT_FOUND` 13 次。
- `CONTEXT_ORGANIZATION_UNKNOWN_SOURCE` 9 次。
- `CONTEXT_ORGANIZATION_ARCHIVE_INVALID` 7 次。
- Schema 额外字段、版本常量、重复引用和 diff 字段错误。
- `TREE_NODE_HASH_CONFLICT`。
- JSON 截断和解析错误。
- Organizer 请求连接重置。

输出截断主要集中在旧的 Organizer 输出预算和隐藏推理配置阶段。后续已经通过 Organizer 隐藏推理关闭、JSON 围栏归一化和共享预算控制改善，但拒绝样本仍然显示出协议生成稳定性和候选治理方面的缺口。

## 4. 训练样本和经验晋升

### 4.1 已生成的训练资源

当前审计到 215 个 Context Training Sample，覆盖 73 个 Trace。

其中：

- 13 个组织结果为 `committed`。
- 113 个 operation 被接受。
- 113 个 operation 全部为 `scope=session` 和 `action=add`。
- 没有 archive operation。
- 没有 recall link。
- 没有 conflict operation。
- 没有 project-scope operation。

### 4.2 Project Context 没有晋升

73 个带 Project Context 的 Trace 中，文档 revision 全部为 0，文档信息数量没有形成项目级增长。

当前实际发生的是：

```text
工具或消息观察
  ↓
Session Candidate
  ↓
Session Context add
```

没有形成目标闭环：

```text
失败或反思
  ↓
Project Candidate
  ↓
项目锚点真实性校验
  ↓
Project Diff
  ↓
Revision 门禁
  ↓
Project Context
```

这说明当前运行能采集会话级整理数据，但不能证明项目级经验晋升已经工作。

### 4.3 没有模型参数学习

本轮运行产生了 Trace、评估结果和训练样本，没有发生模型参数更新，也没有生成新的模型 checkpoint。

因此本轮的“学习”是语料采集和协议行为记录，不是权重训练。跨 Session 的能力变化也没有证据支持，因为 Project Context 没有产生有效 revision。

## 5. A2A 闭环问题

本轮实际工具调用只有：

- `search_resources`
- `load_resources`
- `appworld_execute`
- `read_runtime_artifact`

没有观察到：

- `delegate_task`
- `get_child_task`
- `read_child_result`
- `consume_child_result`
- 子代理结果包
- 父代理消费回执
- 子任务与 DAG 节点绑定
- 子代理 Evidence 回传

因此以下目标没有被覆盖：

```text
父代理创建子任务
  ↓
子代理获得受限能力
  ↓
子代理执行工作
  ↓
结果带 result hash 回传
  ↓
父代理验证并消费结果
  ↓
结果进入父 Session Candidate
```

A2A 当前最大的缺口是运行链路没有被基准任务触发，训练资源中没有真实的父子代理样本。

## 6. DAG 和临时代码问题

Trace 的主要事件只有 `context`、`render`、`model`、`tool` 和 `output`。没有足够证据确认：

- 生成了 10 个以上节点的 DAG。
- 节点拥有明确的依赖关系和 Plan Revision。
- 信息提取作为独立 DAG 节点执行。
- 临时代码节点拥有输入输出 Schema。
- 代码 Artifact 自动绑定 Evidence。
- 子任务节点和 A2A receipt 进入 DAG。
- 只有所有 required nodes 完成后才允许结束。

`appworld_execute` 被大量调用，但这只能证明 AppWorld 工具被使用，不能证明 DAG 原生代码节点和信息提取闭环存在。

## 7. Cache 和归档召回问题

Provider 报告的 `cacheReadTokens` 为 0。Trace 中虽有 context diff、context render 和 message artifacts，但没有观察到可核验的 Cache archive/recall 闭环。

当前没有证据证明：

- Cache 能准确恢复当前任务约束和未完成事项。
- 重复工具结果被归并。
- 过期和无关信息被归档。
- 归档内容通过 source hash 和 locator 被召回。
- 召回结果重新进入候选区并等待审核。
- 归档和召回结果被记录为训练样本。

## 8. 按七项目标的覆盖结论

| 目标 | 当前结果 | 结论 |
| --- | --- | --- |
| G1 A2A 子智能体闭环 | 没有真实子任务调用 | 未覆盖 |
| G2 Project Context 训练闭环 | revision 全部为 0 | 未达成 |
| G3 Cache 整理 | cache read 为 0，无归档召回 | 未覆盖 |
| G4 DAG 长链路 | 没有明确 Plan/DAG trace | 未覆盖 |
| G5 DAG 信息提取 | 没有代码节点和 Artifact 链 | 未覆盖 |
| G6 上下文准确流转 | Session add 和 Evidence 有样本 | 部分覆盖 |
| G7 训练答案隔离 | Project Context 没有晋升 | 隔离结果暂时成立，方法论晋升未验证 |

## 9. 后续讨论顺序

后续应按链路依赖讨论，而不是先优化官方得分。

1. A2A 子任务创建、授权投影、结果消费和父上下文合并。
2. 失败反思如何生成 Project Candidate，以及项目锚点和 Revision 门禁如何真正触发。
3. Session Candidate 到 Project Candidate 的晋升条件和负样本保留。
4. Cache 归档、召回和召回后的再次审核。
5. DAG 状态、Plan Revision、代码节点和信息提取 Artifact。
6. Project Context 答案隔离与跨 Session 方法论快照。
7. 在上述链路可观测后，再决定下一轮基准测试范围。

## 10. 重要运行决策

- 没有为官方失败题目增加题目特化逻辑。
- 独立冒烟验证题没有计入正式成绩。
- 共享 Case token budget 属于通用运行时控制，用于避免提供商窗口耗尽。
- 本文的覆盖结论以 SQLite Trace、Context Training Sample 和 Experiment report 为准，不根据“代码已实现”推断“基准已通过”。
