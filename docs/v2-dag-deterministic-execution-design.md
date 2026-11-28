# V2 DAG 确定性执行设计

版本：v0.1 · 日期：2026-11-24

实现状态：第一阶段已接入 RuntimeLoop。当前 Workflow 已支持前置引用校验、确定性转换/断言算子、有限 foreach 展开、节点 artifact 与编译摘要。语义节点、写入验证绑定和 AppWorld 真实轨迹仍需单独验收。

## 1. 设计目标

DAG 的核心目标是减少大模型请求频次，把可以由代码、规则和已授权工具确定完成的工作交给 Runtime 执行。

理想运行方式如下：

```text
大模型理解任务
  ↓
生成高层执行图
  ↓
运行时校验并编译
  ↓
代码和规则执行确定性节点
  ↓
只在语义判断、异常恢复或最终交付时请求大模型
  ↓
验证并完成任务
```

DAG 不是任务过程的展示图，而是模型计划到确定性执行之间的编译结果。

## 2. 职责划分

| 层次 | 主要职责 |
| --- | --- |
| 大模型 | 理解目标、识别约束、生成计划、处理语义歧义、处理无法规则化的异常、生成最终答复 |
| 运行时 | 校验图结构、绑定能力、编译依赖、调度节点、记录状态、保存回执和 artifact |
| 代码算子 | 遍历、过滤、映射、排序、聚合、分页、去重、字段转换和批量处理 |
| 规则算子 | 条件判断、状态比较、断言、边界检查和完成条件验证 |
| 工具节点 | 读取外部状态、执行授权动作、返回结构化结果 |
| 语义节点 | 对代码和规则无法可靠判断的内容进行一次受控模型请求 |

运行时应优先使用代码和规则。只有确定性能力无法完成时，才进入语义节点。

## 3. 当前系统的两层图结构

### 3.1 计划图

`RuntimeTaskControl` 负责高层任务控制：

- 任务拆解
- 节点依赖
- 阶段切换
- 能力投影
- 完成条件
- Plan Revision
- 等待和阻塞

计划图回答“需要完成哪些工作，以及每个节点需要什么能力”。

### 3.2 Workflow 执行图

`execute_workflow` 负责将一个模型请求转换为运行时可执行的临时流程。

当前支持：

- `tool`
- `filter`
- `foreach`
- `$ref`
- `$expr`
- `when`
- 最大 50 个步骤
- `foreach` 最大 100 个元素
- 工具能力和权限校验
- Workflow artifact 和结果回执
- 节点状态和失败恢复

现有测试已经验证了以下流程可以在一次 Workflow 中完成：

```text
列出文件
  ↓
过滤目标文件
  ↓
批量读取文件
```

过滤和循环过程不需要在每个步骤之间重新请求大模型。

## 4. 目标执行模型

计划图中的确定性节点应当编译成执行图。

```text
高层计划节点
  ↓
Workflow 编译器
  ↓
类型化执行 DAG
  ↓
拓扑调度
  ↓
工具、代码和规则节点
  ↓
结果 artifact、receipt 和 evidence lineage
```

执行图中的每个节点至少包含：

- 唯一 ID
- 节点类型
- 输入引用
- 输出 schema
- 依赖节点
- 能力引用
- 副作用等级
- 重放策略
- 超时和资源预算
- 完成条件
- 失败处理策略
- 来源和结果 artifact

## 5. 算子设计

### 5.1 工具算子

调用当前能力投影中已经授权的工具。

```json
{
  "id": "read_orders",
  "type": "tool",
  "tool": "appworld_execute",
  "arguments": {},
  "outputSchema": {
    "type": "object"
  }
}
```

工具节点必须绑定工具版本、参数 schema、能力投影和真实回执。

### 5.2 转换算子

转换算子执行无外部副作用的确定性处理。

```json
{
  "id": "select_pending",
  "type": "transform",
  "operator": "filter",
  "input": {"$ref": "steps.read_orders.output"},
  "expression": "status = 'pending'",
  "outputSchema": {
    "type": "array"
  }
}
```

第一批转换算子建议包含：

- `map`
- `flat_map`
- `filter`
- `sort`
- `group_by`
- `join`
- `dedupe`
- `partition`
- `reduce`
- `paginate`
- `normalize`
- `select_fields`

### 5.3 循环算子

循环算子对集合执行受边界约束的重复操作。

```json
{
  "id": "read_details",
  "type": "foreach",
  "input": {"$ref": "steps.select_pending.output"},
  "item": "order",
  "maxItems": 100,
  "tool": "read_order",
  "arguments": {
    "order_id": {"$ref": "order.id"}
  }
}
```

循环必须具备最大元素数、超时、输出大小和失败策略。

### 5.4 合并算子

合并算子处理多个来源之间的结构化关联。

```json
{
  "id": "merge_sources",
  "type": "join",
  "inputs": [
    {"$ref": "steps.orders.output"},
    {"$ref": "steps.emails.output"}
  ],
  "key": "order_id"
}
```

合并算子必须明确键、连接类型、缺失值处理和重复键处理。

### 5.5 断言算子

断言算子使用规则检查业务条件。

```json
{
  "id": "verify_amount",
  "type": "assert",
  "input": {"$ref": "steps.merge_sources.output"},
  "expression": "requested_amount = verified_amount"
}
```

断言结果应包含：

- 是否通过
- 失败条件
- 对应输入来源
- 需要补充的证据

### 5.6 语义算子

语义算子是确定性执行图中的显式模型边界。

```json
{
  "id": "classify_request",
  "type": "semantic",
  "input": {"$ref": "steps.normalized_messages.output"},
  "task": "判断客户请求属于退款、换货还是咨询",
  "outputSchema": {
    "type": "object",
    "properties": {
      "intent": {"type": "string"},
      "confidence": {"type": "number"}
    }
  }
}
```

语义节点需要单独统计模型调用次数、输入 token、输出 token 和结果质量。

### 5.7 写入和验证算子

外部写入必须和验证节点成对出现。

```json
{
  "id": "create_refund",
  "type": "write",
  "tool": "appworld_execute",
  "input": {"$ref": "steps.refund_plan.output"},
  "verifyWith": "verify_refund"
}
```

写入节点需要声明：

- 权限
- 副作用等级
- 幂等键
- 重放策略
- 未知结果处理方式
- 验证节点

## 6. 编译和执行流程

### 6.1 图编译

运行时在执行前完成：

1. 校验节点 ID 唯一。
2. 校验所有引用目标存在。
3. 解析显式依赖和 `$ref` 依赖。
4. 检查环路。
5. 检查节点输入输出类型。
6. 校验工具已经加载并属于当前能力投影。
7. 检查写入节点的权限和验证节点。
8. 估算节点数量、循环规模、工具次数和语义请求次数。
9. 生成拓扑执行顺序和可并行节点组。
10. 生成图 hash，绑定本次运行和能力版本。

### 6.2 拓扑调度

运行时只调度所有依赖已经完成的节点。

```text
ready nodes
  ↓
纯计算节点并行
  ↓
只读工具节点按资源限制并行
  ↓
外部写入节点按副作用规则串行
  ↓
汇聚节点等待前置结果
  ↓
继续下一层
```

每个节点完成后保存：

- 节点状态
- 输入 hash
- 输出 artifact
- 工具 receipt
- evidence 引用
- 执行时间
- token 使用量
- 错误或跳过原因

### 6.3 失败处理

失败策略由节点声明：

- `stop`
- `skip`
- `retry_safe`
- `branch`
- `needs_semantic_review`
- `needs_human_input`

规则能够恢复时由运行时直接恢复。规则无法恢复时，才将图暂停并请求大模型生成新的局部决策。

## 7. 大模型请求边界

DAG 应将大模型请求限制在以下位置：

```text
任务理解和图生成
  ↓
确定性执行图
  ↓
无法规则化的语义节点
  ↓
异常恢复或局部重规划
  ↓
最终答复
```

下列工作应由代码和规则处理：

- 每条记录的过滤
- 每页数据的拼接
- 集合去重
- 字段规范化
- 数值计算
- 状态比较
- 分页终止判断
- 重复目标判断
- 完成条件验证

无法依靠结构化字段或规则完成的工作，才进入 `semantic` 节点。

## 8. AppWorld 执行示例

一个退款任务可以展开为：

```text
读取应用文档
  ↓
获取用户身份和凭证
  ↓
登录目标应用
  ↓
读取订单列表
  ↓
读取邮件和备注
  ↓
规范化订单与邮件字段
  ↓
过滤目标订单
  ↓
对齐订单号和金额
  ↓
判断退款条件
  ↓
生成退款参数
  ↓
执行退款动作
  ↓
重新读取退款状态
  ↓
验证最终状态
  ↓
调用完成接口
```

其中：

- 应用文档、登录、读取和写入是工具节点。
- 规范化、过滤、对齐、计算和断言是确定性节点。
- 邮件无法按规则解析时，单独进入一次语义节点。
- 多订单处理使用 `foreach`。
- 写入动作必须有后续读取和断言节点。

理想情况下，大模型只负责生成图、处理必要语义节点和生成最终回复。循环中的每个元素不需要重新请求大模型。

## 9. 当前缺口

以下缺口只涉及 DAG 和 Workflow。

### 9.1 计划图和执行图没有稳定的编译绑定

计划节点、Workflow 定义和完成回执之间缺少统一的编译关系。当前系统可以分别生成计划和 Workflow，但没有稳定地把高层计划节点展开为可验收的确定性执行子图。

### 9.2 Workflow 仍然是有序步骤模型

当前 `steps` 数组可以通过引用表达依赖，但没有完整的显式边、拓扑检查、并行组和汇聚节点模型。

### 9.3 确定性算子不完整

当前有 `filter` 和 `foreach`，还缺少常用的数据处理、集合关系、聚合、分页和断言算子。

### 9.4 没有显式语义节点

当前模型调用发生在 Workflow 外层。系统无法稳定统计哪些判断必须使用大模型，也无法对语义节点单独控制预算、输入和输出 schema。

### 9.5 缺少统一的节点输入输出协议

节点需要统一声明输入 schema、输出 schema、artifact 类型和证据来源。当前不同工具和 Workflow 节点之间还没有完整的类型化传递协议。

本轮补齐了跨工具输出的确定性对齐链路。它把非结构化 stdout、JSON、JSON Lines 和已结构化工具结果统一纳入显式节点，而不是让后续工具隐式猜测输入：

- `parse` 将 JSON、JSON Lines 或逐行文本转换为结构化值，同时保留 `raw`、解析算子和行数。逐行文本只过滤空行，不改写非空行的原始空白。
- `align` 根据显式 `from -> to` 映射生成目标字段，也支持基于 `targetSchema.properties` 的确定性自动映射。自动模式只接受规范化字段名的唯一匹配，遇到缺少必填字段或歧义时停止，不使用模糊猜测。节点支持 `trim`、`string`、`number` 和 `boolean` 转换，并记录 source/target schema 标识、映射 hash、对齐模式与未映射字段。
- `validate_schema` 使用 JSON Schema 校验规范化结果。校验失败会让 Workflow 节点失败，不会把不合格数据继续传递。
- `join` 按字段关联两个集合，保留左右原始记录和字段冲突，不替任一来源裁决事实。左连接、基数和歧义策略都进入节点结果。

每个节点的完整结果会写入 `workflow-result` artifact，后续节点通过 `$ref` 读取 `value`、`records` 等明确字段。模型只负责提出节点和映射，运行时负责参数校验、路径安全、类型转换、Schema 校验和冲突保留。

### 9.6 缺少 DAG 成本准入

运行时还没有根据节点规模、循环规模、工具次数和语义节点数量判断是否值得生成 Workflow。

### 9.7 代码节点的资源和安全边界不完整

代码节点需要明确执行时间、内存、输出大小、文件访问、网络访问和副作用等级。现有脚本能力不能直接等同于通用安全沙箱。

### 9.8 AppWorld 尚未产生真实 DAG 轨迹

第一轮 AppWorld 正式运行没有观察到可确认的 Workflow 或 DAG 节点，也没有证明分页、批量处理、信息提取和状态验证已经在图中执行。

## 9.9 已落地的确定性执行增量

本轮实现补齐了以下确定性执行能力：

- `transform` 节点覆盖 `map`、`flat_map`、`filter`、`sort`、`dedupe`、`select_fields`、`group_by`、`partition`、`paginate`、`reduce` 和 `normalize`。
- `assert` 节点将结构化规则验证作为独立运行时节点，并保存通过或失败的 artifact。
- Workflow 编译阶段生成 `graphHash`、节点规模、工具节点数、确定性节点数、foreach 规模和估算模型请求数。
- 前置引用、未知引用、超限图和不满足算子参数的定义在执行前拒绝。
- 运行时间线和 `RuntimeWorkflowPlan` 保存节点类型、状态、artifact 和编译摘要。

这些能力仍需通过 AppWorld 任务确认模型确实使用 Workflow，而不是只增加了可调用的接口。

## 10. 分阶段实施方案

### 第一阶段，完善执行图编译

- 增加显式依赖边。
- 解析 `$ref` 形成依赖图。
- 增加环路检查和拓扑排序。
- 增加节点输入输出 schema。
- 保存编译后的图 hash。
- 将执行图节点绑定到计划节点和完成条件。

### 第二阶段，补充确定性算子

- `map`
- `flat_map`
- `sort`
- `group_by`
- `parse`
- `align`
- `validate_schema`
- `join`
- `dedupe`
- `reduce`
- `paginate`
- `normalize`
- `assert`

### 第三阶段，完善调度和失败恢复

- 纯计算节点并行。
- 只读工具节点按资源限制并行。
- 外部写入节点按副作用规则串行。
- 节点级超时和预算。
- 节点级失败策略。
- 结果未知时停止重放并进入核查。
- Workflow 局部恢复保留原输入、输出和 artifact。

### 第四阶段，引入显式语义节点

- `semantic` 节点独立计量模型请求。
- 语义节点使用严格输出 schema。
- 多条相同类型记录可以批量进入一次语义请求。
- 语义结果进入普通 artifact、evidence 和后续规则节点。
- 只有语义节点失败时才请求局部重规划。

### 第五阶段，接入 AppWorld 场景

- API 文档发现进入工具节点。
- 分页和集合处理进入确定性算子。
- AppWorld 临时代码进入受控执行节点。
- 写入动作绑定验证节点。
- 最终完成接口作为终态节点。
- 保存每个节点的 artifact、receipt 和 evidence lineage。

## 11. 评估指标

DAG 的效果不能只看任务是否成功，还需要记录：

- 每个任务的大模型请求次数。
- DAG 节点数量。
- 每次模型请求覆盖的节点数量。
- 工具调用次数。
- 语义节点数量。
- 代码和规则节点占比。
- 平均节省的输入 token。
- 平均节省的输出 token。
- Workflow 执行失败率。
- 节点恢复成功率。
- 结果 artifact 和 evidence 完整率。
- DAG 结果与最终任务状态的一致率。

核心对照指标为：

```text
无 DAG 的模型逐步执行
vs
计划生成 DAG 后的确定性执行
```

## 12. 设计基线

```text
大模型负责任务理解和图编译
Runtime 负责图校验、调度和状态
代码负责确定性计算
规则负责条件判断和验证
工具负责外部观察和动作
语义节点负责无法规则化的判断
大模型只在语义边界、异常恢复和最终交付处重新进入
```

当前 `execute_workflow` 是这一方向的基础实现。后续重点是把 Workflow 从工具串联扩展为具有类型、依赖、调度、证据和成本控制的可验证执行 DAG。
