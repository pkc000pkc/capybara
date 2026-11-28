# UI 回归报告（2026-11-14 · Round 19）

本轮验证 Round 18 修复后的超时证据链。测试通过重新构建并启动的 Electron 页面完成；实现层检查和页面黑盒检查分开记录。

## 结果

| 用例 | 结果 | 页面证据 |
|---|---|---|
| R19-01 超时收据与进程收束 | **通过** | 最终回复显示 `run_command`、callId、`timedOut=true`、`status=timed_out`、请求 `timeout_ms=3000`、实际进程时长 3500 ms、工具耗时 3582 ms、`processSettled=true`、`exitCode=1`、`signal=null`、stdout 只有 `start`，并保留余量和 signal 的不确定性。运行上下文显示时间线 7、进程 3、子智能体 0，状态为“回复已完成，执行过程和依据已保存”。 |

## 页面观察

- 模型先尝试 `python`，页面明确显示命令不存在；随后使用 `where` 探测，再用 `py -c ... time.sleep(30)` 执行真正的超时用例。
- 最终回复把超时本身作为失败原因，没有把超时脚本包装成成功。
- 运行收据中包含 `callId`，聊天内容和执行过程中的工具名称一致。
- 页面保留了运行时收尾余量和 `signal=null` 的不确定性，没有补造终止机制。

## Round 18 P0 修复验证

此前“已验证超时”与“没有可用工具收据”同时出现的问题，本轮未再出现。收据现在由运行时确定生成，并同时进入：

1. 模型可见的工具消息（`runtime_receipt`）；
2. `tool.call.completed/failed` 事件；
3. 时间线步骤和运行上下文的“参数、结果与依据”详情；
4. 过程状态中的进程收束信息。

超时进程在运行进程视图中按失败处理，收据仍保留 `timed_out` 这一可区分的终态，避免把“观察到超时”与“脚本成功完成”混为一谈。

## 实现层验证

- `npm run typecheck --workspace=apps/backend`：通过。
- `npm run typecheck --workspace=apps/workbench`：通过。
- `npm run desktop:build --workspace=apps/workbench`：通过。
- 工具框架定向回归（设置 `CAPYBARA_TEST_PROJECT_DIR=..\\..\\examples\\test-project`）：6/6 通过。
- `git diff --check`：通过；仅有既存 CRLF 转换提示。

## 仍未闭环的缺口

- **P1 子智能体证据包**：父代理仍需独立引用子工具收据，而不是只依赖子代理自述。
- **P1 项目应用生命周期**：启动、停止、重启、更新失败、回滚和项目切换清理仍未完成稳定的页面验收。
- **P1 执行目录边界**：临时目录、项目目录和系统目录的能力门禁需要在界面中明确表达。
- **P1/P2 产品入口治理**：菜单占位入口、资源项目/系统来源和候选/证据/receipt/diff 的独立浏览仍需补齐。

## 结论

Round 19 证明超时场景已经从“模型自述矛盾”变为“页面可验证的运行时事实”。Round 18 的 P0 缺口可以关闭；产品化验收仍被项目应用生命周期、A2A 独立证据包和治理视图缺口阻塞。
