# UI 页面回归测试报告（Round 97）

## 结果摘要

| 用例 | 结果 | 页面证据 |
| --- | --- | --- |
| R97-01 两次相同父级委派及子级失败 | 通过 | 页面保留两次 `delegate_task`、两个 childId、两次子级 `read_file` 失败收据和 artifact |
| R97-01 自动收束 | 通过 | 经过 continuation 过程后页面显示“回复已完成，执行过程和依据已保存”，无需点击停止 |
| R97-02 自动收束后的恢复 | 通过 | `只回复 OK，不调用工具。` → `OK`，`0 次工具调用 · 1 步` |

## 关键页面证据

### 两次父级委派

目标文件：`__capybara_child_missing_round97_retry__.txt`

第一次委派：

- callId：`call_00_OVkx8dzNawP9GAj6EIzL6205`
- stepId：`step-tool-1-0-call_00_OVkx8dzNawP9GAj6EIzL6205`
- status：succeeded，durationMs：12852
- childId：`child:cb4ba3b4-b834-484c-ab50-f0be901a9d7b`
- artifact：`artifact-tool-result-c5a1725d-3e38-45bd-83e9-638a0ad10620`

第一次子级 `read_file`：

- callId：`call_00_rclDEZA2JCBLUosvhnGX7275`
- stepId：`step-tool-1-0-call_00_rclDEZA2JCBLUosvhnGX7275`
- status：failed，durationMs：80
- error：`RUNNER_FAILED / ENOENT`
- artifact：`artifact-tool-result-8ac3c941-517c-42d1-8433-a8f60e087f5c`

第二次相同委派：

- callId：`call_00_WdFSjZZwyHEGzPrmSvKv8038`
- stepId：`step-tool-3-0-call_00_WdFSjZZwyHEGzPrmSvKv8038`
- status：succeeded，durationMs：13479
- childId：`child:90c038ed-e140-40c2-8baf-9dc7bb88dfd7`
- artifact：`artifact-tool-result-13bf0941-4027-4c48-b42f-7a24db3cf586`

第二次子级 `read_file`：

- callId：`call_00_kQTlAGcY8yfNJVltLRVH8988`
- stepId：`step-tool-1-0-call_00_kQTlAGcY8yfNJVltLRVH8988`
- status：failed，durationMs：100
- error：`RUNNER_FAILED / ENOENT`
- artifact：`artifact-tool-result-7b5f5676-6c11-40be-b8b9-a245c445ce05`

页面还显示了两次相同 goal/prompt、未进行第三次尝试、未写入文件。

### 自动收束与恢复

- 过程中页面显示 `5 次工具调用 · 14 步`，包含工具结果回传和 continuation 阶段。
- 最终状态：`回复已完成，执行过程和依据已保存`。
- 没有人工点击“停止本轮”。
- 后续请求显示 `OK`，且 `0 次工具调用 · 1 步`。

## 结论

本轮确认 RuntimeLoop 已有的 continuation 上限和正常完成路径能够自动收束；Round96 中“需要人工停止”的现象是因为测试在达到最终模型输出前提前停止，不能作为无上限结论。

当前仍需补齐的治理点是：

1. `delegate_task` 的父级收据在子任务读取失败时仍标为 `succeeded`，因为“委派动作完成”和“子任务目标成功”没有在统一状态中分离呈现。
2. `repeatedToolFailures` 目前只统计直接工具执行失败，不能识别“父级委派成功但子级结果失败”的嵌套失败。
3. 子任务重试次数和预算仍由模型行为驱动，RuntimeLoop 没有对同一 child goal 的重试预算做统一门禁。
4. 页面能显示完整事实，但“委派成功 / 子任务失败 / 父级是否允许重试”的状态标签还可以进一步拆开，减少误解。
