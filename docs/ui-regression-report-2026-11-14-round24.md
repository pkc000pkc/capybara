# UI 黑盒回归报告（Round 24）

日期：2026-11-14  
环境：Electron Workbench，标准启动命令 `npm run desktop:start --workspace=apps/workbench`  
项目：`examples/qingjian-generated`

## 结论

R24 通过。父任务委派子智能体后，页面同时保留了父子关联、子任务工具调用、运行收据、结果产物和候选证据；重新打开“运行上下文”后，可以切换到“子智能体”页签查看已完成子任务。

## 页面证据

### R24-01 父子任务与证据包

- 用户指令要求委派只读子智能体列出项目根目录前 10 个条目。
- 父时间线出现 `delegate_task`，状态 `已完成`，父侧 `callId=call_00_3zOGKnMoKYgyxjB14oTt9994`，`resultArtifactId=artifact-tool-result-7fd5bfe1-d3b0-441a-85e6-baf38c11e037`。
- 父回复显示 `childId=child:730a9328-6e46-472b-b415-8987a03b2d5f`。
- 子任务调用 `list_files`，状态 `succeeded`，`callId=call_00_gM3bu1Ujh81br15ApFaK2392`，`stepId=step-tool-1-0-call_00_gM3bu1Ujh81br15ApFaK2392`，`resultArtifactId=artifact-tool-result-20dde4ad-7d44-4ddc-8aea-f24abe513fcf`，`durationMs=195`。
- 父回复同时展示父侧复核调用 `call_00_XkPVuVExlu6Uv6fzdNMO9269`，并列出两个候选证据 ID：`candidate-12b2aa9c-0c20-466c-83c2-d5c9ea29cfb9`、`candidate-e060287a-d3f9-4ae6-be78-e4e800af0d89`。

### R24-02 子智能体页签

- 打开完整“运行上下文”后，页签显示“子智能体 1”。
- 切换后显示目标“只读列出项目根目录前 10 个文件名”、开始时间和“已完成”状态。
- 时间线保留“子代理 · 调用模型并解析原生工具请求”和“子代理 · 工具 · list_files”两个子任务步骤。

### R24-03 可回放与边界

- 关闭并重新打开运行上下文后，父回复仍保留 childId、callId、stepId、artifactId、候选证据和不确定性说明。
- 页面明确指出两个候选仍为 `pending`，没有把工具观察自动提升为正式事实。
- 页面明确区分“只读调用没有写操作工具记录”和“未修改文件”的推断边界。

## 发现的剩余缺口

本轮未发现父子证据链的 P0/P1 阻塞。仍需后续验收的项目级缺口：

1. 运行上下文中的候选、证据、收据仍以摘要为主，尚缺独立的筛选、复制和详情查看入口。
2. 子智能体页签目前主要展示任务状态；若要逐条查看子代理证据，应增加从 childId 跳转到子时间线和 artifact 详情的交互。
3. 项目应用更新失败/回滚、项目切换时旧进程清理、执行目录边界仍需要单独页面回归。
