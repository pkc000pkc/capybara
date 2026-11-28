# UI 回归报告（Round77）

- 日期：2026-11-15
- 构建：`npm run desktop:start --workspace=apps/workbench`
- 关联计划：[Round77 回归计划](ui-regression-plan-2026-11-15-round77.md)

## 结果

| 用例 | 结果 | 页面证据 |
|---|---|---|
| R77-01 桌面重启恢复 | 通过 | 重启最新 Electron 后，`qingjian-generated`、历史会话、Example Domain 读取结果、000682 项目应用和运行上下文入口均恢复。 |
| R77-02 项目隔离恢复 | 通过 | 切换到 `ui-regression-clean-2026-11-14` 后显示其独立会话和空白应用；切回后研究项目状态恢复。 |
| R77-03 运行上下文恢复 | 通过 | 重启后时间线、进程、子智能体、证据治理四个视图可打开；证据治理仍显示 32 条记录和 evidence/artifact 关联。 |
| R77-04 浏览器宿主恢复 | 通过 | 重启后打开 Example Domain，切到 000682 行情看板，再切回浏览器，地址和页面内容保持正确。 |
| R77-05 主界面冒烟 | 通过 | 帮助菜单和“关于概念稿”弹窗可打开、关闭，主工作区和浏览器视图保持可操作。 |

## 结论

Round77 页面回归 5/5 通过。Browser Gateway 状态进入 RuntimeLoopState 后，没有破坏桌面重启、项目切换、运行上下文、浏览器宿主和项目应用闭环。
