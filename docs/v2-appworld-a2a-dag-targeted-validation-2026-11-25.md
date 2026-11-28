# V2 AppWorld A2A 与 DAG 定向验证记录

日期：2026-11-25

## 1. 验证目的

本轮使用 AppWorld 训练题扫描结果，选择多来源任务验证 A2A，选择集合聚合任务验证 DAG。实验运行器已默认开启 `childAgentEnabled`，父代理和子代理使用同一套运行时账本。

代码入口位于 `apps/backend/src/app.ts`。实验管理器创建 RuntimeLoop 时默认传入 `childAgentEnabled: true`，调用方显式传入 `false` 时保留调用方设置。

## 2. 题目选择

训练集扫描得到以下适配关系：

| 样本 | 任务特征 | 目标能力 |
| --- | --- | --- |
| `22cc237_1` | Simple Note 与 Venmo 两个独立来源，读取后创建收款请求 | A2A、父子结果审核、动作租约 |
| `76f2c72_1` | 文件集合读取、金额聚合和数值答复 | DAG、工具节点、确定性断言 |
| `229360a_1` | Spotify 多集合读取、集合筛选和批量删除 | DAG、批量处理和写入验证 |

本轮实际运行 `22cc237_1` 和 `76f2c72_1`。训练题允许使用官方评估结果核对行为，运行没有使用测试集信息。

## 3. A2A 定向结果

### 3.1 运行

- 运行 ID：`5347c561-92f0-4d84-bc54-b1b440b1c785`
- 样本：`22cc237_1`
- 模型：`glm-5.3-flash`
- 总 token：`1,341,870`
- 实际 A2A 工具：`delegate_task`、`get_child_task`、`read_child_result`、`consume_child_result`、`take_over_child_task`

### 3.2 轨迹信号

轨迹确认了以下状态流转：

```text
父代理规划
  ↓
两个子任务委派
  ↓
delegation_wait
  ↓
子任务状态读取
  ↓
read_child_result
  ↓
consume_child_result
  ↓
子任务取消与拒绝
  ↓
take_over_child_task
  ↓
父代理继续执行 AppWorld 工具
```

第一个子代理获得动作能力并启动。第二个委派在同一批次中经历了一次状态版本冲突，随后由模型重新提交并成功启动。父代理读取并拒绝了取消子任务的结果，随后接管该计划节点。另一个子任务返回的 Venmo 读取结果被父代理读取并消费。

最终父代理通过 AppWorld 创建了 3 个收款请求，金额和接收人均通过官方状态检查。官方评估通过了 3/4 项，剩余失败来自模型没有提交最终 `complete_task` 完成标记。

### 3.3 发现

1. `childAgentEnabled` 已经从配置进入真实实验运行。
2. 父代理等待屏障、结果读取、消费回执和接管流程均已进入真实轨迹。
3. `appworld_execute` 被标记为 `external`。父代理处于 `investigation` 阶段时，运行时不会把它作为只读子代理能力授予，因此只读子任务收到 `CHILD_CAPABILITY_NOT_GRANTED` 是当前设计结果。
4. 将子节点设置为 `execution`，使用显式 `execution_mode: action` 和动作租约后，子任务可以获得 AppWorld 执行能力。该模式适合隔离的训练定向验证，生产使用仍需要独立的 AppWorld 只读能力包装。

## 4. DAG 定向结果

### 4.1 运行

- 运行 ID：`5456b8b3-0894-482a-8508-38fb9ea834c3`
- 样本：`76f2c72_1`
- 参考答案：`368`
- 总 token：`106,516`
- `execute_workflow` 已出现在模型工具投影中

### 4.2 轨迹信号

本次没有生成可执行 Workflow。模型在加载资源后多次进入模型续轮，随后出现：

- 输出长度达到 `8192`
- Runtime 进行 3 次输出修复
- 最终返回 `MODEL_PROTOCOL_ERROR`
- 错误内容为 `LLM returned invalid JSON arguments for tool execute_workflow`

时间线没有 `workflow-definition`、Workflow 节点、编译摘要或确定性断言 artifact。AppWorld 环境没有发生状态修改，官方评估只剩答案字段未提交。

### 4.3 发现

1. DAG 工具已经进入模型工具投影，投影门禁允许调用。
2. 当前 GLM 在 `execute_workflow` 复杂参数 schema 下出现输出截断和 JSON 参数错误。
3. AppWorld 工具返回字符串结果，后续 `filter`、`reduce` 和 `assert` 还需要结构化输出适配。
4. DAG 当前的主要缺口落在模型输出稳定性和 AppWorld 结构化工具结果，运行时编译器已经有可观察的失败回执。

## 5. 下一步施工顺序

### A2A

1. 为 `appworld_execute` 增加只读能力包装，区分 API 读取和外部写入。
2. 为多子任务批量委派增加 `sync` 混用校验，批量委派默认要求 `async`。
3. 将动作租约、子结果 hash、消费回执和接管回执纳入实验摘要。
4. 使用新的独立样本验证两个子代理均完成、父代理消费两份结果后再执行写入。

### DAG

1. 增加 AppWorld 结构化输出格式，保留原始文本并提供可引用的 JSON 结果。
2. 为 `execute_workflow` 提供更小的定向 schema 示例和短参数模板。
3. 增加 GLM 输出截断后的 Workflow 专用修复路径，保留原始候选并要求重新提交完整参数。
4. 使用 `76f2c72_1` 的新独立副本验证 Workflow 编译摘要、tool 节点、assert 节点和最终答案。

## 6. 结论

本轮确认实验运行器已经开启 A2A，父子代理生命周期和动作能力可以进入真实 AppWorld 轨迹。DAG 的工具投影已经生效，模型输出协议和 AppWorld 结构化结果仍需要补齐，才能得到稳定的 Workflow 执行样本。
