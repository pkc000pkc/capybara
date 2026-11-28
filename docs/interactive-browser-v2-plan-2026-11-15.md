# V2 交互式浏览器能力设计与施工边界

- 日期：2026-11-15
- 关联回归：[Round68 页面回归报告](ui-regression-report-2026-11-15-round68.md)
- 目标：把当前已经存在的 Browser Gateway Action、证据和 Trace 模型，接入 Electron 主进程的受控 WebContentsView，形成可导航、可交互、可回放的浏览器工作区。

## 当前事实

现有 Backend 已定义以下能力模型：

- `navigate`、`read`、`click`、`input`、`select`、`upload`、`download`、`screenshot`、`wait`、`assert`。
- Browser Profile、Session、Tab、PageState、Checkpoint、Receipt、Evidence、Artifact。
- 外部副作用、权限等级、下载策略和页面状态校验。
- `BrowserGatewayService` 可以完成 admission、receipt、evidence、artifact、checkpoint 和 reconcile。

当前 RuntimeLoop 只向模型暴露 `browser_read`，通过 HTTP executor 读取页面文本。Electron 的 `WebContentsView` 目前只允许本地项目应用地址，由 `application-browser-host.cjs` 管理。

因此，当前缺口不是重新设计 Browser Action，而是把以下链路接通：

```text
RuntimeLoop browser action
  ↓
Browser Gateway admission / permission
  ↓
Electron BrowserSessionHost
  ↓
WebContentsView + page observation
  ↓
receipt / evidence / artifact / page state
  ↓
Runtime Trace + Workbench browser workspace
```

## 目标架构

### 1. BrowserSessionHost

Electron 主进程新增独立的 BrowserSessionHost，职责包括：

- 按项目、会话和浏览器实例管理 WebContentsView。
- 保存当前 URL、标题、页面状态、窗口布局和最近导航历史。
- 统一处理 `did-navigate`、`did-fail-load`、`render-process-gone`、下载和页面标题事件。
- 对每个会话应用 allowed origins、下载目录、上传根目录和权限策略。
- 不把浏览器页面直接暴露给 renderer DOM；页面仍由 Electron WebContentsView 承载。
- 为 RuntimeLoop 提供主进程内的 typed executor。

### 2. RuntimeLoop Browser Action

在 `browser_read` 之外增加结构化浏览器动作入口，动作输入直接使用 `BrowserAction` 的受限子集：

```yaml
browser_action:
  session_id: string
  tab_id: string
  action:
    kind: navigate | read | click | input | select | download | screenshot | wait | assert
    target: ...
    arguments: ...
    risk: read | local-reversible | external-reversible
```

RuntimeLoop 负责：

- 校验动作结构和当前 Session/Tab 归属。
- 先执行 Browser Gateway admission。
- 将 `turnId / stepId / callId` 注入 action、receipt、evidence 和 artifact。
- 将页面状态变化写入 observation 和 checkpoint。
- 对下载、上传、外部提交和跨域动作执行权限门禁。
- 将完整结果存入 SQLite Trace，模型只收到受预算限制的摘要和 artifact 引用。

### 3. Electron 主进程 IPC

Preload 只暴露结构化接口，不暴露原始 `webContents`：

```text
browser-session-open
browser-session-close
browser-session-state
browser-session-navigate
browser-session-action
browser-session-download
browser-session-screenshot
browser-session-reconcile
```

所有接口都使用 `projectRef / sessionId / browserInstanceId / turnId / stepId / callId` 关联，返回 typed receipt，不返回任意主进程对象。

### 4. Workbench 浏览器工作区

项目应用侧栏之外，增加浏览器工作区状态：

- 当前浏览器实例、Tab、URL、标题和连接状态。
- 地址栏、后退、前进、刷新、关闭页面。
- 页面截图或页面状态缩略图。
- 当前动作、等待状态、失败原因和权限状态。
- 下载产物、来源、hash、保存位置和关联 Trace。
- “查看执行过程”跳转到对应 `callId` 和页面状态。

页面工作区只显示状态和允许的交互入口，真正的权限判断由 Browser Gateway 和 Electron 主进程完成。

## 证据与回放要求

每个浏览器动作至少生成：

- 一个 `tool.call.started` / `tool.call.completed` 或 `tool.call.failed` 事件。
- 一个包含 `turnId / stepId / callId` 的 Browser Receipt。
- 一个动作前 PageState 引用和动作后 PageState 引用。
- 需要时生成 DOM 摘要、截图、下载清单或外部收据。
- 对未知结果记录 `status: unknown`，禁止模型直接宣称成功。

重新打开项目或会话后，应能恢复：

- 最近的 Browser Session 和 Tab 元数据。
- 最后确认的 URL、标题和页面状态 hash。
- 已完成动作、失败动作、下载产物和权限判断。
- 需要人工确认的未完成动作。

页面状态恢复采用“重新打开并校验 hash”的方式；重新打开失败时保留原始状态并标记 `needs-reconciliation`，不自动重放有副作用动作。

## 权限边界

| 动作 | 默认风险 | 页面门禁 |
|---|---|---|
| navigate/read/wait/assert | read | 可自动执行，保留页面证据 |
| click/select/input | local-reversible 或 external-reversible | 根据目标域、表单和副作用判断 |
| download | read / local-reversible | 下载目录、文件名和来源可见 |
| upload | external-reversible | 必须有上传根目录和明确授权 |
| screenshot | read | 记录页面状态和来源 |
| 外部提交/购买/发布 | external-irreversible | 人工确认和最终收据 |

## 施工顺序

1. 抽取 `BrowserSessionHost`，让本地应用宿主和通用浏览器宿主共享生命周期协议。
2. 先接通 `navigate/read/screenshot/wait`，形成可回放的只读浏览器会话。
3. 再接通 `click/input/select`，加入目标定位、页面状态校验和权限门禁。
4. 接通 `download` 与 artifact 保存，建立下载证据和失败回收。
5. 将 `browser_action` 纳入 RuntimeLoop 工具目录和模型提示词。
6. 增加 Workbench 浏览器工作区和 Trace 跳转。
7. 对断线、页面崩溃、未知结果、跨项目切换和恢复校验做页面回归。

## 验收场景

1. Agent 打开公共网页并读取标题：页面出现 Browser Session，Trace 显示 navigate/read，最终回复引用 URL 和页面状态。
2. Agent 在公共网页中点击一个只读链接：页面 URL 变化，动作前后 PageState 可回放，`callId` 一致。
3. Agent 输入一个非敏感查询：输入动作、页面结果和失败原因可见，输入值按策略脱敏。
4. Agent 下载公开 PDF：下载清单、文件 hash、来源 URL、保存位置和 artifact 可见。
5. 浏览器页面崩溃：页面标记 unknown/crashed，保留最后确认状态，禁止自动重放。
6. 关闭并重新打开项目：Browser Session 元数据、Trace、下载产物和待确认动作可恢复。
7. 外部提交动作：没有人工确认时只能停在 awaiting authorization，不能直接提交。

## 阶段门槛

交互式浏览器能力达到产品化验收，需要同时满足：

- Backend Browser Action 与 Electron BrowserSessionHost 使用同一套结构化协议。
- 所有动作均可按 `turnId / stepId / callId` 查询和回放。
- 页面状态、证据、artifact 和下载结果均能关联到动作。
- 权限、外部副作用和未知结果由 Runtime/主进程强制执行。
- Workbench 页面能展示浏览器状态、动作进度、失败原因和恢复结果。
- 断线、崩溃、恢复和跨项目切换均有页面证据。
