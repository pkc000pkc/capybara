# Electron 页面回归报告（Round91）

日期：2026-11-15

本轮按 `docs/ui-regression-plan-2026-11-15-round91.md` 从 Electron 页面发起真实请求，验证不存在文件的失败闭环。

## 结果

| 用例 | 结果 | 页面证据 |
|---|---|---|
| P01 不存在文件 | 通过 | 仅产生 1 次 `read_file` 调用，页面显示 `RUNNER_FAILED`、`ENOENT`、`status=failed`、开始/结束时间和 `durationMs=169`。 |
| P02 失败轨迹 | 通过（本轮页面卡片级） | 会话卡片显示“1 次工具调用 · 3 步”，并保留 `callId`、工具名、参数、错误结果与最终回复；本轮未再次打开独立运行上下文面板。 |
| P03 失败后恢复 | 延续通过 | Round89 已从页面验证超时失败后发送“只回复 OK，不调用工具”可以正常完成；本轮未重复发送恢复请求。 |

## 实际页面结果

用户指令：只调用一次 `read_file` 读取项目根目录下确定不存在的 `__capybara_missing__.txt`，失败后立即停止，不要重试，不要修改任何文件。

页面最终显示：

- `1 次工具调用 · 3 步`。
- 工具：`read_file`，`file_name=__capybara_missing__.txt`。
- `callId=call_00_Yb60rdmJLvpJfcsQ7dv21534`。
- `error.code = RUNNER_FAILED`。
- `error.message = ENOENT: no such file or directory, realpath '[local project]\\__capybara_missing__.txt'`。
- 收据：`status=failed`、`ok=false`、`durationMs=169`。
- 未返回文件内容，错误在路径定位阶段发生。
- 最终回复明确说明未重试、未修改工作区，任务已结束。

## 结论

无效文件参数场景已经达到可验收水平：工具失败被显式保留，错误原因可定位，任务没有继续无效重试，失败状态进入会话记录。与 Round89 暴露的超时场景相比，当前单次确定性工具失败的收束行为已经稳定。

仍需补齐的证据是：在独立“运行上下文”视图中逐项核对该失败调用的 `turnId / stepId / callId` 关联，以及权限拒绝、子智能体非空、应用启动失败等其他失败分支。
