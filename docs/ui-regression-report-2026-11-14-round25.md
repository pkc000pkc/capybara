# UI 黑盒回归报告（Round 25）

日期：2026-11-14  
环境：Electron Workbench，标准启动命令 `npm run desktop:start --workspace=apps/workbench`  
项目：`examples/qingjian-generated`

## 结论

R25 通过。页面已经能独立查看治理记录并筛选，候选详情展开后显示完整结构化 JSON；点击“复制 JSON”后，AX 状态稳定显示“已复制”。复制实现已接入 Electron 主进程 `clipboard.writeText`，网页环境保留渲染层回退，Workbench/Backend 类型检查、桌面构建和 `git diff --check` 均通过。

## 用例结果

### R25-01 证据治理页签：通过

- 运行上下文新增“证据治理 6”页签。
- 页面显示候选信息、证据引用、应用收据、候选审核收据和证据审核结果五类记录。
- 当前会话中可看到 2 条候选、4 条证据引用，应用收据和审核记录为空状态清晰可见。

### R25-02 治理记录筛选：通过

- 在筛选框输入 `candidate-e060287a` 后，匹配数量变为 1 条。
- 页面仅保留对应候选，证据区显示空状态。
- 清空筛选后恢复 6 条治理记录。

### R25-03 详情与复制：通过

- 展开候选后，页面显示完整 JSON，包含 `id`、`actor`、`sourceId`、`toolName`、`runId`、`stepId`、`rawArtifactId`、状态和证据引用。
- “复制 JSON”按钮可见。
- 点击后 AX 状态显示按钮文字“已复制”，反馈保持可见，说明桌面复制动作已完成。

## 当前影响

运行上下文已从“只看计数”提升为“可筛选、可展开、可核对、可复制”的治理视图。receipt/diff 的独立展示和项目级业务场景仍属于后续验收范围。
