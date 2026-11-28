# V2 编程能力与界面验收记录

日期：2026-11-10。Windows，Node.js 22.20.0，Electron 37。

## 验收范围

在可回放的 Runtime 中让真实模型从空目录开发一个有前端、后端、SQLite 持久化和增删查改的应用；与 Pi 在相同任务、相同模型下比较实际产物。另检查工作台的会话、公开阶段摘要、工具调用、脚本进程、子代理、错误、恢复与键盘操作。

使用系统用户 `.capybara` 中当前配置的 DeepSeek / deepseek-chat。没有读取 key.txt，密钥不写入报告、命令行或模型事件日志。

## 与 Pi 的对照方式

Pi 使用官方 npm 包 `@earendil-works/pi-coding-agent@1.5.2`，隔离安装在 `tmp/pi-benchmark`，没有全局安装。依据 [官方仓库](https://github.com/earendil-works/pi)、[CLI 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md)、[模型配置文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md) 配置独立 profile。

两边使用同一模型与服务地址、8192 输出 token 额度，以及同一份“清笺”应用需求。Pi 使用其原生 read / write / edit / powershell / grep / find / ls；Capybara 使用自身文件、精确编辑及命令执行工具。Pi 关闭外部扩展、MCP 和上下文文件；Capybara 使用现有系统 project-files skill。因此这是功能验收对照，不是严格的速度排行榜。

模型自己创建、修改项目源代码；验收者没有手工补写应用功能。编排和独立验收脚本单独维护。

| 项目 | Capybara | Pi |
| --- | --- | --- |
| 产物目录 | `tmp/coding-acceptance/capybara` | `tmp/coding-acceptance/pi` |
| 前端 | React + TypeScript + Vite | React + TypeScript + Vite |
| 后端 | Node.js TypeScript + node:sqlite + REST | Node.js TypeScript + node:sqlite + REST |
| 类型检查 / 生产构建 | 通过 | 通过 |
| 模型编写的真实 HTTP / SQLite 测试 | 21 项通过 | 10 项通过 |
| 独立接口与持久化检查 | 17 / 17 | 17 / 17 |
| 最终收尾 | 续轮修复后正常完成 | 首轮正常完成 |

Capybara 首轮约 760 秒，57 次成功工具调用、10 次失败，在 Windows 冒烟服务的进程回收上反复重试后达到 48 轮工具预算，最终回复失败。应用本身当时已通过独立 17 项检查。给出独立检查结论与进程回收问题后，Capybara 在原会话继续约 191 秒，32 次成功工具调用、1 次失败，自行改为直接启动子进程、隔离端口和数据库，完成修复、构建、测试及收尾。Pi 首轮约 504 秒，64 次工具启动、8 次工具错误，正常结束。两边工具计数口径不同，不直接比较数量。

本次结果支持“基本全栈 CRUD 开发的功能范围已达到本次 Pi 对照基线”。不能据此推断复杂仓库修改、超长上下文、大规模重构或所有 Pi 扩展能力已经全面等价；首轮效率与收尾稳定性仍有差距。

## 独立检查内容

17 项覆盖：首页和构建资源、空数据库、创建、编辑、中文搜索、有/无搜索结果、非法字段、非法 JSON、未知更新/删除 ID、SQLite 重启后保留数据、删除后列表不再出现。

验收器为每次运行分配临时端口和独立数据库，并只关闭自己创建的服务进程树。过程中发现固定验收端口与视觉预览相撞，已改为动态空闲端口后重新通过；没有把那次碰撞当成应用功能失败。

浏览器实际操作覆盖：创建笔记、编辑并保存、打开删除确认并取消、搜索空状态与清空恢复、刷新后数据仍存在。检查了 1440px 桌面布局与 900px 窄屏布局；窄屏 DOM 宽度 900、内容宽度 885，无横向溢出。

![Capybara 生成的 CRUD 应用](acceptance-assets/2026-11-10/generated-crud-1440.png)

## 工作台视觉与交互改进

- 最终回复与模型公开工作说明渲染 Markdown：代码块、列表、表格、段落和行内代码具有独立排版；原始 HTML 不执行，危险链接协议被过滤。
- 聊天中的过程按轮折叠，运行时展开，限制其滚动高度；完整记录保留在运行上下文中。子代理步骤计入父轮并标出归属。
- 运行上下文提供“时间线 / 进程 / 子智能体”视图，默认直接展示时间线。参数、结果、错误、哈希与关联 ID 按需展开。
- 失败使用红色状态和具体原因；未知用量显示“用量尚未统计”，不再显示没有依据的 0 tokens。
- “停止本轮”对应真实取消动作；空输入及运行中禁用发送；Ctrl+Enter 发送，Ctrl+N 新建会话，Escape 关闭面板；设置对话框限制 Tab 焦点范围。
- 用户阅读历史时不强制跳到底部；关闭应用面板后聊天区扩展；修正后退/前进的会话连接和侧栏搜索。
- 重启后恢复原会话、完整模型/工具记录和子任务状态，恢复过程不重复执行工具。
- 重新检查目录内容，已有文件的项目不再长期显示“空目录”。

真实桌面操作中，父代理执行排序脚本，子代理只读检查三种排序函数，父代理搜索代码交叉核对，并纠正子代理对快速排序最坏复杂度的表述。过程记录包含一次真实命令失败、后续成功执行、子代理及最终合并；这也验证了失败不会被成功结果覆盖。

另实际启动一个等待 90 秒的 Node 进程，在运行约 12,137ms 时点击“停止本轮”。SQLite 中工具与回复都记录为 ABORTED，未产生成功输出；进程清单确认该命令已退出。重启后仍显示取消原因与耗时，不重放命令。修正了正常会话分离被误报为断开、旧关闭事件清空新会话 ID，以及取消后提示残留“等待收尾”的问题。

导航修复后，桌面实测后退恢复取消会话、前进恢复 11 次工具调用的子代理会话，均无断开提示。在原会话再次发送“只回复连接成功”后正常收到回复，请求数从 1 增至 2，原工具轨迹保留；没有意外新建会话。Ctrl+N、新输入的单次发送和侧栏搜索也已实际操作验证。

![执行时间线与工具依据](acceptance-assets/2026-11-10/workbench-trace.png)

![全局模型设置与独立资源错误反馈](acceptance-assets/2026-11-10/global-model-settings.png)

## 本轮补齐的编程支撑

1. `edit_file` 支持唯一精确文本替换，可附带预期 SHA-256，歧义时拒绝写入，保留 CRLF；临时文件替换保证提交完整。
2. 资源加载按工具名称优先项目、缺失回退系统；系统更新的工具可补齐旧项目 manifest 中缺失的名称。
3. 模型输出额度与工具轮数可配置；工具预算耗尽后保留一轮禁用工具的真实收尾，不伪造任务完成。
4. 默认 Runtime 工具上限由 15 秒调整为 150 秒，可配置；模型明确知道平台、命令 shell 及超时约束。
5. Windows Python 使用 py 启动器，并在缺少启动器时尝试 python；真实排序输出通过测试。
6. 全局模型设置与密钥经 Electron IPC 读取和保存到用户 `.capybara`，页面只收到“已配置”状态。项目资源读取失败不再使全局密钥被误显示为“未配置”；运行中拒绝修改全局模型配置。

## 复现入口与证据

```powershell
node scripts/benchmark-coding-capability.cjs
node scripts/benchmark-pi-capability.cjs
node scripts/continue-coding-acceptance.cjs
node scripts/verify-crud-project.cjs capybara
node scripts/verify-crud-project.cjs pi
```

前三个命令会使用真实模型额度。首轮生成脚本会创建新的会话；不要把它当成已有会话的恢复命令。

Capybara 完整事件与会话位于生成项目 `.capybara/sessions.sqlite`；汇总是 `.capybara/generation-result.json` 和 `continuation-result.json`。独立检查汇总为各生成项目 `.capybara/independent-api-result.json`。Pi 汇总与 JSONL 过程在 `tmp/coding-acceptance/pi-profile`。

可长期保留的应用源码样例位于 [examples/qingjian-generated](../examples/qingjian-generated/README.md)。复制了实际通过验收的 25 个源码和配置文件，并逐一核对内容哈希；未复制数据库、凭据、构建产物或会话记录。复制后重新安装锁定依赖、类型检查、构建和 21 项测试通过。

启动生成应用：在 `tmp/coding-acceptance/capybara` 执行 `npm run build`、`npm start`，默认 `http://127.0.0.1:4317`。本次视觉预览使用 `http://127.0.0.1:4391` 和独立测试数据库。

## 验收边界

本次实测为当前 Windows 环境中的开发启动；没有据此宣称已验证全新机器安装包。真实提供方测试为 DeepSeek Chat Completions；Responses 流式和工具闭环由本地受控 HTTP 服务验证。

视觉审查还发现普通目录的旧项目资源接口依赖原模板，提示词变量与资源目录读取可能返回 HTTP 500。全局模型设置已拆到主进程正常读写；其余旧资源接口的迁移属于独立功能缺口，没有列为本轮通过项。
