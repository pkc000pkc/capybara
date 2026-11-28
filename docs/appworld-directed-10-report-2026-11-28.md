# AppWorld 十题定向评测报告

## 运行信息

- 运行 ID：`332461ed-64ee-4bb5-9a83-fa6c478c95d1`
- 数据集：`appworld-train-all-scenarios`
- 代码提交：`03e53186`
- 模型：`glm-5.3-flash`
- 并发：1
- 重复次数：1
- 单题 Token 上限：800,000
- 项目上下文：只读
- 结果反馈驱动的重试：无

## 总体结果

| 指标 | 结果 |
| --- | ---: |
| 总题数 | 10 |
| 通过 | 6 |
| 失败 | 4 |
| 通过率 | 60% |
| Workflow 触发题数 | 9 |
| Workflow definition | 19 |
| Workflow result | 18 |
| A2A `delegate_task` 题数 | 0 |
| 非法工具参数 | 0 |
| Runtime error artifact | 13 |
| 总 Token | 3,861,752 |

## 分题结果

| 样本 | 分组 | 结果 | 需求通过 | Workflow | Token | 主要观察 |
| --- | --- | --- | --- | ---: | ---: | --- |
| `27e1026_1` | 直接工具基线 | 通过 | 2/2 | 1 | 244,100 | 跨集合读取和答案验证通过 |
| `d0b1f43_1` | 直接工具基线 | 通过 | 2/2 | 1 | 285,903 | Venmo 时间和关系过滤通过 |
| `76f2c72_2` | 文件长链 | 失败 | 1/2 | 0 | 73,813 | Workflow 参数非法，答案未通过 |
| `7d7fbf6_1` | 文件长链 | 通过 | 8/8 | 4 | 535,408 | 压缩、删除和验证链路通过 |
| `34d9492_1` | 文件长链 | 通过 | 5/5 | 2 | 667,721 | 日期分类和批量移动通过 |
| `6104387_1` | 高风险长链 | 通过 | 10/10 | 2 | 784,882 | 导出和终止状态通过，接近单题预算 |
| `22cc237_1` | 多应用候选 A2A | 失败 | 3/4 | 2 | 327,962 | 支付请求状态大部分正确，答案断言失败 |
| `3c13f5a_1` | 多应用候选 A2A | 失败 | 1/6 | 1 | 140,779 | Workflow 参数非法，支付请求未形成 |
| `b0a8eae_1` | 多应用候选 A2A | 失败 | 0/5 | 4 | 378,739 | 播放器最终状态未满足断言 |
| `afc0fce_1` | 多动作 | 通过 | 9/9 | 2 | 422,445 | 只读筛选、评论、点赞和验证通过 |

## 错误分类

### 运行时与协议

- `MODEL_PROTOCOL_ERROR`：2 次，`76f2c72_2` 和 `3c13f5a_1` 返回非法 `execute_workflow` 参数。
- `WORKFLOW_CALL_MUST_BE_EXCLUSIVE`：1 次，`b0a8eae_1` 在同一响应中混合了 Workflow 和其他动作。
- `TOOL_DISPATCH_ERROR`：1 次，`22cc237_1` 的 Workflow 表达式执行失败。
- `TOKEN_BUDGET_EXHAUSTED`：1 次，`6104387_1` 在业务状态已经通过后继续请求时达到 800,000 Token 上限。

### 上下文整理

出现了 `CONTEXT_ORGANIZATION_UNKNOWN_SOURCE`、`CONTEXT_ORGANIZATION_SCHEMA`、`CONTEXT_ORGANIZATION_PREMATURE_COVERAGE` 和 `CONTEXT_ORGANIZATION_CANDIDATE_REQUIRED`。这些错误没有阻止大多数题目完成，但说明真实 AppWorld 轨迹中的整理器输入仍存在来源绑定和输出 schema 兼容性问题。

## 结论

1. DAG 触发已经具备实测稳定性，9/10 题产生了 Workflow，文件长链题表现最好。
2. 非法参数没有扩散为未捕获错误，但仍有两题直接因为 Workflow 参数协议失败。
3. 复杂跨应用任务的业务正确率较低，支付请求和播放器状态是主要失败点。
4. `delegate_task` 在所有题目中都已进入工具投影，但 10 题没有实际调用，说明 A2A 缺口在模型触发策略或提示词引导，工具投影本身没有缺失。
5. 本轮 60% 只能作为训练集定向验证结果，不能作为 AppWorld 官方测试集 pass@1 成绩。

原始 JSON 报告位于被忽略的实验输出目录 `examples/appworld/experiments/outputs/appworld-directed-10-hard-v1.json`，本文件保存可审查摘要。
