# V2 执行过程闭环与验收记录

日期：2026-11-10。

目标：用户可以实时查看工作阶段、模型公开说明、工具执行和结果依据；会话重连、应用重启后，可以从同一项目的记录恢复执行过程。

## 实现约定

- 桌面端通过 Electron IPC 接收事件；模型 HTTPS 响应使用 SSE，不引入桌面 WebSocket。
- 事件包含 sessionId、turnId（对应 runId）、stepId、sequence、timestamp；工具事件另有 callId。后端 RuntimeLoop 与 Electron 使用同一协议中的事件名称和关联字段。
- `thinkingSummary` 表达运行阶段说明或提供方公开摘要，`source` 区分 runtime 和 model；`commentary` 表达模型公开工作说明，`final` 表达最终回复。原始内部推理不进入这些展示通道。
- 每次模型请求、工具调用均形成时间线步骤。工具产生 started、completed 或 failed 事件，并关联进程、Observation 和 Artifact。
- 工具权限和原始参数 schema 在执行前由 Runtime 校验；向模型暴露的兼容 schema 不替代本地校验。回放只读记录，不重放副作用。
- 子代理通过 delegate_task 完成独立只读分析，能力为父代理能力的子集；不能继续委派、扩大权限或宣布父任务完成。父模型接收子结果后继续核对与总结。

## 存储与恢复

项目 `.capybara/sessions.sqlite` 新增 `runtime_trace` 表，保存事件及其顺序；用户消息和最终回复保存在原有 sessions 表。工具结果保留完整 JSON、摘要、字节数和 SHA-256；文件读写另有执行前后存在状态与内容哈希。

连接运行中的会话会恢复同一 Runtime 和快照；离开会话只分离展示连接。应用关闭时取消任务并等待收尾写入，再关闭数据库。发现上次运行未完成时，标记 cancelled、unknown 或 interrupted，保留中断依据，不推定执行成功。

聊天区按回复折叠展示本轮过程，运行中自动展开；“查看运行上下文”展示模型轮次、子任务、工具/脚本进程、起止时间、耗时、参数、结果、错误与证据关联。界面中的 PID 明确为 tool runner PID。

## 五个场景的自动化验收

| 场景 | 证据与结果 |
| --- | --- |
| 读取文件 | 真正读取临时项目 input.txt；核对工具开始/完成事件、公开进度、模型继续轮次与结果 Artifact |
| 编写和执行代码 | 真正写入并运行 sort.mjs，标准输出 `[1,3,9]`，退出码 0；进程状态 succeeded，并有文件前后哈希 |
| 失败与超时 | 参数不合法、权限拒绝、进程退出码 7、200ms 外层超时均有独立 failed 事件、错误观察及结果记录 |
| 重连与回放 | 模型执行中分离并重连后仍为 running；关闭管理器再打开同一 SQLite，恢复完整会话和轨迹；恢复不再次请求模型或执行工具 |
| 子智能体 | running → succeeded 状态、父会话关联、结果 Artifact、父模型继续轮次；子代理试图写文件被拒绝，只有父会话发出完成事件 |

另以本地真实 HTTP SSE 服务验证 Chat Completions、Responses 两套流协议：服务器未结束响应前，客户端已经收到可见文本事件；工具输出能进入下一轮模型输入。

自动化结果：Electron Runtime / 场景验收 19 项通过；前端事件、投影与 Markdown 安全渲染 8 项通过；后端 app 回归 40 项通过；文件工具与能力门禁 8 项通过。项目登记 6 项、系统/项目存储 4 项通过，共 85 项。后端、Workbench、共享协议类型检查及 Workbench 生产构建通过。

测试入口：

```powershell
node --test apps/workbench/test/electron-runtime-v2.test.cjs apps/workbench/test/runtime-observability.test.cjs
node --import tsx --test apps/workbench/test/runtime-activity.test.ts apps/workbench/test/workbench-runtime.test.ts apps/workbench/test/message-body.test.ts
npm run build --workspace=apps/workbench
```

## 真实模型和桌面验收

使用用户系统目录中当前配置的 DeepSeek/deepseek-chat，不读取 key.txt，也不输出密钥。

- 通过桌面发送只读验收指令：list_files 列出根目录，read_file 读取 sort_demo.py 前五行。两次调用成功，聊天区显示两次工具调用；右侧可见两轮模型、两个工具进程、耗时、参数、工具结果及证据哈希。
- 通过同一 Runtime 的独立隔离验收，让真实模型创建插入排序脚本、调用 run_code，再委派子代理只读核对并由父代理合并。运行标准输出 `[1,3,9]`；9 次成功工具调用，run_code 191ms，子任务约 27.7s，结果 passed。
- 独立验收入口：`node scripts/verify-runtime-observability.cjs`，会消耗当前配置提供方的模型额度；本次摘要保存在 `tmp/runtime-observability-live.json`，完整会话保存在摘要指向的临时项目中。

Responses 的协议验收使用本地可控服务器；本次真实提供方验收使用 Chat Completions，没有修改用户的提供方配置。

## 编程与视觉验收

已让 Capybara 与 Pi 使用同一 DeepSeek 模型独立开发 React + TypeScript / Node.js + SQLite CRUD 应用，进行独立接口检查及真实浏览器操作。结果与桌面视觉检查见 [编程能力与界面验收记录](v2-coding-and-ux-acceptance-2026-11-10.md)。
