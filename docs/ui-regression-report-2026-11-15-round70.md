# UI 回归报告（Round70）

- 日期：2026-11-15
- 构建：`npm run desktop:start --workspace=apps/workbench`
- 关联计划：[Round70 计划](ui-regression-plan-2026-11-15-round70.md)

## 结果

| 用例 | 结果 | 观察 |
| --- | --- | --- |
| R70-01 | 通过 | 最新 `out/index.html` 启动，项目、会话和行情研究结果恢复正常。 |
| R70-02 | 通过 | 点击“浏览器网关”后出现 Electron WebContentsView，Example Domain 可见；顶栏出现浏览器后退、前进、刷新、地址和关闭控件。 |
| R70-03 | 通过 | 地址栏提交 `https://example.com/?v=1`，仍保持同一浏览器实例并完成页面加载。 |
| R70-04 | 通过 | 刷新、后退、前进均可调用，项目应用状态未被替换。 |
| R70-05 | 通过 | `https://evil.example/` 被主进程策略拒绝，原页面保持不变，错误原因在顶栏显示。 |
| R70-06 | 部分通过 | 关闭浏览器成功；但拒绝地址后再次点击“浏览器网关”会复用地址栏中的未授权 URL，导致再次打开失败。 |
| R70-07 | 通过 | 项目应用面板和浏览器会话使用不同视图状态，未出现项目应用视图被浏览器会话冒充。 |
| R70-08 | 通过 | 原有聊天记录、工具 Trace 和项目研究结果仍可见。 |

## 缺陷

`navigateInteractiveBrowser()` 失败后保留了用户输入的未授权 URL；`requestBrowserEntry()` 再次打开时直接复用该值，因此会重复触发策略拒绝。修复方式是：导航失败时恢复到最后确认的 `browserSessionState.url`，并在打开入口对当前地址重新校验，拒绝地址不能成为下一次打开的默认地址。

本轮未发现 Electron IPC、项目隔离或原有项目应用链路回归问题。
