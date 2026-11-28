# V2 阶段性工作 Review（Round74）

日期：2026-11-15

> 最新进展见 [Round75 Review](v2-stage-review-2026-11-15-round75.md)。Round75 已将 Browser Action 接入 Browser Gateway，并补齐浏览器下载的第一阶段闭环。

本轮目标是复核当前 V2 Runtime、Electron 工作台、项目应用和浏览器能力是否已经形成可继续施工的真实闭环，并区分“已接通”“有实现但未接主链路”和“仍缺失”的部分。

## 结论

当前状态为：

> **V2 Runtime 的桌面最小闭环已成立，浏览器宿主和页面工作区已成立；产品化验收尚未通过。**

阻塞产品化的首要问题不是 Electron 页面，而是浏览器动作没有经过已经设计好的 Browser Gateway 治理链路。RuntimeLoop 目前直接调用注入的 `browserHost`，而 `BrowserGatewayService`、`BrowserCapabilityAdapter` 和 `ProductCapabilityRegistry` 仍是独立能力模块，尚未成为 Agent 浏览器动作的实际准入、收据和证据边界。

## 本轮验证结果

| 检查项 | 结果 | 证据 |
|---|---|---|
| Backend 类型检查 | 通过 | `npm run typecheck --workspace=apps/backend` |
| Backend 构建 | 通过 | `npm run build --workspace=apps/backend` |
| Workbench 类型检查 | 通过 | `npm run typecheck --workspace=apps/workbench` |
| Workbench 生产构建 | 通过 | `npm run build --workspace=apps/workbench` |
| Backend 全量自动化测试 | 通过 | 344/344 |
| RuntimeLoop 浏览器动作定向测试 | 通过 | `app.test.ts` 41/41，其中新增 `browser_action` 注入宿主测试通过 |
| Electron 页面回归 | 通过 | Round73：浏览器与项目应用互斥切换 5/5 |

## 已经成立的部分

### 1. 桌面 Runtime 边界

- Electron 主进程负责 Backend Runtime 的生命周期、项目隔离和 SQLite 会话持久化。
- Renderer 通过 Preload/Bridge 调用运行时，不依赖当前桌面主链路的 WebSocket。
- 项目切换、关闭项目和运行时关闭已经具备项目级清理路径。
- `turnId / stepId / callId` 已存在于 Runtime 事件和工具调用收据中，历史会话可恢复 Trace。

### 2. 上下文和治理视图

- 会话级与项目级 Context Document 已进入 Runtime snapshot/state。
- 候选信息、证据、上下文收据、审核收据和应用生命周期收据能够回传到 Workbench。
- 运行上下文当前有时间线、进程、子智能体、治理四个视图。
- 页面可以看到模型阶段摘要、工具调用、进程状态、候选/冲突数量和证据治理摘要。

### 3. Electron 浏览器宿主

- `BrowserSessionHost` 已接入 Electron 主进程、IPC、Preload、Bridge 和 Workbench。
- 使用 `WebContentsView`，没有使用 iframe。
- 浏览器会话带 `projectId` 隔离，重复打开同一实例会复用宿主视图。
- 地址校验、关闭、导航、后退、前进、刷新、截图和浏览器事件已经有宿主层实现。
- 浏览器视图和项目应用视图已经可以从顶栏互斥切换。

### 4. 运行时浏览器动作的第一段链路

- `browser_action` 已出现在 Runtime resource tool 定义中。
- RuntimeLoop 已能把模型工具调用转换为结构化 `RuntimeBrowserHostRequest`。
- Electron 主进程已提供 `browserHostAdapter`，支持 `navigate/read/click/input/select/screenshot/wait/assert` 的基础动作。
- 工具调用结果会进入普通 `tool.call.completed`，因此模型轮次和工具轮次可回放。

### 5. 产品场景的已有能力

- 打开本地项目、全局模型配置、普通聊天：已有页面和 Runtime 回归证据。
- 000682 最近一个月交易数据、最近三年研报、Python 特征分析、看板发布/打开和待人工审查的建议：已有市场研究服务和页面闭环。
- 项目应用实例的启动、停止、重启、更新、回滚和嵌入式打开：基础路径已经存在，异常路径仍需补充黑盒验收。

## 真正的阶段性缺口

### P0：Agent 浏览器动作绕过 Browser Gateway

当前调用关系是：

```text
模型
  → RuntimeLoop.browser_action
  → Electron browserHostAdapter
  → BrowserSessionHost
```

目标调用关系应是：

```text
模型
  → RuntimeLoop
  → ProductCapabilityRegistry / BrowserCapabilityAdapter
  → BrowserGatewayService admission
  → Browser Executor
  → PageState / Evidence / Artifact / Receipt
  → Runtime Trace
```

当前直接注入 `browserHost` 的结果：

- 没有经过 Browser Gateway 的 capability admission 和 permission level。
- 没有统一的 Browser Receipt、Product Work Ledger Receipt 和幂等键。
- 没有产生可引用的 `pageStateId`、`evidenceRefs` 和 `artifactRefs`。
- 页面内容虽然以工具结果返回，但不能按 Browser Gateway 的状态模型重建页面快照。
- 浏览器失败、未知状态和外部副作用无法统一走现有 recovery/reconciliation 语义。

这是当前最重要的结构缺口。`browser_action` 定向测试证明了宿主连接正确，但没有证明浏览器治理闭环已经成立。

### P0：下载动作仍是占位失败

`browser_action` 的 schema 已声明 `download`，但 Electron `browserHostAdapter` 当前直接返回：

```text
browser download requires the download artifact adapter
```

Electron 宿主只监听了 `will-download` 并发送 `browser.session.download_started` 事件，没有把下载项保存到项目 `.capybara`、生成 artifact、计算哈希、关联证据和返回完成收据。

这意味着：

- 通过市场研究服务的固定研报 provider 可以完成研报下载；
- 通过通用浏览器动作让 Agent 找到并下载研报，当前闭环仍未完成。

### P1：交互式浏览器的 URL 策略是硬编码的

Electron 当前默认只允许：

- `https://example.com`
- `https://www.investor.gov`
- `https://www.cninfo.com.cn`

`allowExternal` 不能真正放开外部站点，因为请求的 origin 仍必须落在 `DEFAULT_BROWSER_ORIGINS` 中。这个策略适合演示和受控验证，但还没有变成系统设置、项目能力配置或 Browser Profile 的可审计策略。

如果产品目标是“Agent 可以使用浏览器完成开放式调研”，这里会直接限制可用范围；如果产品目标是“只允许受控站点”，则需要把允许列表、拒绝原因和变更记录显示在能力治理中。

### P1：浏览器会话事件没有进入同一条可回放 Trace

Runtime 工具调用会产生 `tool.call.*`，但 BrowserSessionHost 的 `browser.session.*` 事件主要通过 Electron IPC 发给 Renderer，并写入系统日志。它们没有和 Runtime 的 `turnId / stepId / callId` 建立统一的 SQLite Trace 关联。

当前可以回放“调用了 browser_action 以及返回了什么”，但还不能完整回放：

- 页面何时真正导航完成；
- 页面何时加载失败或渲染进程崩溃；
- 点击/输入后页面状态发生了什么变化；
- 截图和页面正文对应哪一个 PageState；
- 浏览器事件和工具收据之间的精确关联。

### P1：`assert`/脚本边界还不够收敛

`browser_action.assert` 会把模型提供的脚本包进 `Boolean(...)` 后交给 `webContents.executeJavaScript`。虽然 WebContentsView 开启了 `contextIsolation`、`nodeIntegration: false` 和 `sandbox: true`，但当前仍缺少：

- 脚本长度和执行时间上限的统一门禁；
- 可调用对象、DOM 范围和读取字段的明确白名单；
- 脚本失败后的证据和恢复收据；
- 断言脚本与页面状态版本的关联。

这部分不应继续以任意字符串脚本作为长期协议形态。

### P1：浏览器视图是临时状态，重启恢复语义未闭环

项目应用和会话状态会恢复，但 `WebContentsView` 本身是 Electron 进程内临时对象。当前没有持久化并恢复：

- 浏览器实例的最后 URL、历史位置和 PageState；
- 正在进行的导航、下载或等待；
- 崩溃后的重建和恢复检查；
- 项目切换后浏览器实例是否需要重新打开。

因此“会话可回放”已成立，“浏览器页面可恢复”还没有成立。

### P1：市场研究、应用版本、证据和会话仍是两套索引

市场研究结果主要通过研究结果和会话 Trace 表达，项目应用主要通过 manifest/instance 表达。两者都能恢复，但还缺少统一可查询索引：

```text
session → turn → evidence → artifact → application version → running instance
```

这会影响从最终建议反查具体研报、交易数据、Python 输出和看板版本。

### P2：页面入口仍有保留态，尚未形成完整产品页面

以下入口仍然会落入“入口已保留，当前项目暂无可执行内容”的状态：

- 项目文件
- 导出项目快照
- 定时与触发
- 能力演化
- Token 用量

这不阻塞 Runtime 最小闭环，但与“每个菜单和按钮都形成可执行闭环”的产品验收标准不一致。

### P2：顶栏在窄窗口下仍有布局风险

Round73 已观察到项目名称、浏览器地址和状态文本在窄窗口下可能重叠。当前功能可用，但浏览器控制栏还需要响应式折叠或独立工具栏布局。

### P2：旧 WebSocket 兼容层仍在代码树中

Electron 主链路已经使用主进程 IPC，但 Backend 仍保留旧 WebSocket transport、Runner 接口和对应测试。它目前不阻塞桌面运行，但会让协议边界继续出现两套语义，也会增加后续回归噪音。

## 按主线场景的覆盖判断

| 场景 | 当前结论 | 说明 |
|---|---|---|
| 打开项目、配置 Key、聊天 | 已覆盖 | 桌面 IPC、全局 `.capybara`、会话 SQLite 和发送链路可用 |
| 浏览器调研投资方法 | 部分覆盖 | `browser_read` 的 HTTP 读取可留证；交互式导航/点击/输入尚未经过统一 Gateway |
| 下载 000682 最近三年研报 | 部分覆盖 | 市场研究 provider 可下载；通用 `browser_action.download` 仍失败 |
| 获取最近一个月日线 | 已覆盖 | 市场数据 provider 和研究结果页面可用 |
| 编写 Python 分析 | 已覆盖 | Python 本地执行、输出、超时和失败收据已有能力 |
| 生成并打开行情看板 | 基础闭环已覆盖 | 项目应用托管、发布、嵌入打开可用；研究/应用统一索引仍缺 |
| 给出交易建议 | 受限闭环已覆盖 | 建议标记为待人工审查并保留依据/不确定性 |
| 查看思考、工具、进程、子智能体 | 基础闭环已覆盖 | 页面已有阶段摘要、时间线、进程、子智能体和治理视图 |
| 完整回放浏览器行为 | 未覆盖 | 缺 PageState、Evidence、Browser Receipt 与浏览器事件统一持久化 |

## 建议的施工顺序

1. 把 `browser_action` 改为调用 Browser Gateway 的 typed action，而不是直接调用 `browserHost`。
2. 为 Electron BrowserHost 实现 Gateway Executor：导航、读取、点击、输入、截图和下载都返回 PageState、Evidence、Artifact 和明确状态。
3. 让 Browser Receipt 与 Runtime 的 `turnId / stepId / callId`、SQLite Trace 建立一对一关联。
4. 把允许 origin、下载目录、脚本策略和外部副作用权限放入可审计的 Browser Profile。
5. 补浏览器下载、超时、失败、崩溃、重启恢复和跨项目清理的页面回归。
6. 建立 `session → evidence → artifact → application version → instance` 的统一索引。
7. 再补齐菜单保留入口和顶栏窄窗口布局。
8. 最后决定旧 WebSocket 是兼容层还是清理对象，并更新阶段基线。

## 阶段验收门槛

下一阶段要把状态从“最小闭环成立”推进到“浏览器能力可验收”，至少需要满足：

- Agent 的每个浏览器动作都经过 Browser Gateway admission；
- 每个动作都有 `turnId / stepId / callId / actionId / receiptId`；
- 成功动作返回 PageState 和 Evidence 引用；
- 下载能生成项目级 Artifact、哈希和完成收据；
- 失败、超时、未知和崩溃都有可回放原因；
- 重开项目或重启桌面后能恢复浏览器动作轨迹；
- 页面、运行上下文和 SQLite Trace 显示同一套状态；
- 交互式浏览器场景与已有 000682 市场研究场景可以串成一条可验证链路。

