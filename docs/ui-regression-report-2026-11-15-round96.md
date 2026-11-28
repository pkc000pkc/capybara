# UI 页面回归测试报告（Round 96）

## 构建与版本

- 本轮使用已重新构建并启动的 Electron V2 工作台。
- 构建命令：`npm run build`
- 构建结果：通过。
- 测试项目：`qingjian-generated`

## 结果摘要

| 用例 | 结果 | 页面证据 |
| --- | --- | --- |
| R96-01 子任务失败后停止 | 通过 | 1 次父级 `delegate_task`、1 次子级 `read_file`；`RUNNER_FAILED/ENOENT`；页面保留 childId、callId、stepId、artifact、candidate 和 evidence |
| R96-01 扩展：父层明确要求相同请求重试 | 探索性结果 | 当时在第 5 轮 continuation 尚未结束就手动停止；Round97 已补测并确认相同委派可以完成两次重试且最终自动收束 |
| R96-02 失败后会话恢复 | 通过 | 停止异常循环后发送“只回复 OK，不调用工具”，页面显示 `OK`，`0 次工具调用 · 1 步` |
| R96-03 打开已发布项目应用 | 通过 | 内嵌 `000682 行情看板` 打开，显示 20 条日线、3 份研报、区间收益和波动率 |
| R96-03 关闭并重新打开 | 通过 | 关闭应用视图后再次打开，仪表板数据和 3 个研报链接仍完整显示 |

## R96-01 关键证据

### 正常失败并停止

目标文件：`__capybara_child_missing_round96__.txt`

- 父级 `delegate_task`：`call_00_3AkHkZd2SI6b5QIrD0F68859`，status=succeeded，durationMs=11252，artifact=`artifact-tool-result-43e45939-2304-4a23-a6d9-b7cc92f689ce`。
- 子任务 childId：`child:183f6cec-cfcf-4423-9feb-3adb11ee0c1f`。
- 子任务唯一工具调用：`read_file`，`call_00_nbLiKdf94XxUjCJ7ZSQc8703`，stepId=`step-tool-1-0-call_00_nbLiKdf94XxUjCJ7ZSQc8703`，status=failed，durationMs=104。
- 失败码：`RUNNER_FAILED`。
- 失败原因：`ENOENT: no such file or directory`。
- 结果 artifact：`artifact-tool-result-accb202b-1a2e-497b-b9b3-625873829dbb`。
- 页面同时显示候选 `candidate-2c0cc759-0601-4721-8058-437bafb1683a` 和证据 `evidence-d039f4bc-b053-41f0-89bf-850b7846d7cd`。
- 子代理按一次读取失败后停止，未修改文件。

### 父层重复请求压测

目标文件：`__capybara_child_missing_round96_retry__.txt`

- 父层第一次委派：`call_00_fxVEByWOifyShUuSbHpY8275`，status=succeeded，durationMs=8501。
- 子任务读取失败：`call_00_TvQGDANM0ApS3YDTJDt86615`，status=failed，`RUNNER_FAILED/ENOENT`，artifact=`artifact-tool-result-ddee1b6c-cd9c-410e-86f0-3a9bae16711d`。
- 随后父层调用 `read_runtime_artifact`：`call_00_eUDNAJ7N9kueuxmxSYVX8028`，之后连续进入“继续模型循环（第 1 至第 5 轮）”。
- 页面显示最多 10 步、3 次工具调用，但没有第二次相同 `delegate_task`，也没有 `REPEATED_TOOL_FAILURE`。
- 父任务最终只能通过“停止本轮”结束；停止后页面没有给出该任务的确定性失败终态。

## 结论

本轮证明了：

1. 子代理单次工具失败的证据链已经能在页面上显示并保留。
2. 失败后新的用户请求可以恢复，且不继承上一轮的工具调用状态。
3. 已发布项目应用可以独立于 Agent 失败打开、关闭和重新打开。

本轮发现但尚未完全补齐的治理点：

1. 父级 `delegate_task` 在子任务目标失败时仍可能返回 `succeeded`，委派动作状态与子任务目标状态没有统一拆分。
2. 重复失败保护统计直接工具执行失败，尚未覆盖“父级委派成功、子级结果失败”的嵌套失败。
3. 同一 child goal 的重试预算仍主要由模型行为驱动，RuntimeLoop 尚未建立统一的 child retry gate。
4. Round96 手动停止属于提前结束测试，不代表当前运行时没有自动终止路径；Round97 已验证自动收束和恢复。

## 下一修复目标

- 为 `delegate_task` 建立父级委派状态与子级目标状态的双层收据模型。
- 将 child goal、重试次数、重试预算和最终合并结果纳入 RuntimeLoop 状态，而不是只依赖模型是否再次生成相同委派。
- 页面明确区分“委派成功”“子任务失败”“允许重试”和“父任务最终完成”。
