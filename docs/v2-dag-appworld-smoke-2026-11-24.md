# V2 DAG 与 A2A AppWorld 冒烟验证记录

日期：2026-11-24

## 1. 运行范围

- 数据集：`appworld-dev-d1-tasks-1`
- 样本：`23cf851_1`
- 模型：`glm-5.3-flash`
- 重复次数：1
- 并发：1
- 运行 ID：`f44bd945-5718-4095-bf2c-bcde79cdc9a4`
- Runtime run ID：`request-006e8965-0cd0-4630-99a6-3f741557c189`
- 单题主动运行超时：120 秒

## 2. 结果

实验外层状态为 `error`，原因是单题主动运行超过 120 秒。该错误发生在最终模型回合仍处于运行状态时。

AppWorld 环境本身已经报告任务完成。最后一次 `appworld_execute` 返回 `completed: true`，Supervisor 的完成操作成功，答案值为 11。外层实验未能在超时前把最终 JSON 回复和评分阶段结算完，因此本次不能作为正式 pass@1 成绩。

本次消耗：

- 输入 token：288,838
- 输出 token：8,574
- 总 token：297,412
- 工具调用：9 次
- 其中一次受限 Python 模块错误后，通过再次查阅文档恢复

## 3. 可信运行信号

运行轨迹确认了以下现有能力：

- `search_resources` 和 `load_resources` 真实返回并加载 `appworld_execute` 与 AppWorld Skill。
- `appworld_execute` 失败后，模型没有伪造成功，使用文档重新执行并继续任务。
- 任务使用真实分页、集合完整性检查、分区校验和详情交叉核验。
- 最终通过 `apis.supervisor.complete_task(answer=11)` 完成环境任务。
- 时间线保存了 22 个步骤、9 个工具观察和 106 个 artifact。
- Project Context revision 保持 0，未把本题答案写入项目级上下文。
- 训练记录中出现会话级整理决策和拒绝记录，未出现项目级晋升。

## 4. V2 改动是否在本题生效

本题没有自然生成 `execute_workflow`，也没有开启子代理。因此本次 AppWorld 轨迹没有提供 DAG 节点、编译摘要、`delegation_wait`、`delegation_review` 或动作租约信号。这个结果说明当前提示和 AppWorld Skill 仍倾向于直接调用 `appworld_execute`，不能证明 DAG 或 A2A 在基准任务中已被自然触发。

能够确认的是，DAG 和 A2A 的运行时单元测试与 Workflow 入口测试已经通过。AppWorld 还需要专门的图生成提示或选择包含集合处理、批量读取和子任务拆解的样本，才能观测目标信号。

## 5. 后续验证边界

本次不重试同一 AppWorld 样本，避免把已发生的环境副作用和超时结果混入正式 pass@1。后续应使用新的、独立的 smoke 样本，设置足够的单题结算时间，并单独统计：

- Workflow 计划、编译摘要和确定性节点数量。
- 模型请求数相对普通工具循环的变化。
- 子代理状态、等待屏障、结果读取和审核回执。
- Project Context 是否保持无答案泄露。
