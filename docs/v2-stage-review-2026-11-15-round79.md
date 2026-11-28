# V2 阶段性工作 Review（Round79）

日期：2026-11-15

本轮审查重点是：运行时边界、Electron 本地链路、浏览器恢复、产物治理、上下文与运行轨迹、项目应用，以及此前约定的产品化场景是否已经形成可验收闭环。

## 当前结论

> **V2 已达到“主链路可继续施工、核心协议可回归”的水平，但还没有达到“真实桌面任务全部验收完成”的水平。**

当前最大的缺口不是再增加工具数量，而是把已有能力串成一条真实可操作、可观察、可恢复、可回放的用户任务，并补齐异常路径的页面证据。

## 已经形成的闭环

### Runtime 与 Electron

- Electron 主进程托管项目 Runtime、应用进程和浏览器宿主，Renderer 通过 IPC 连接。
- 项目会话、消息、Trace、Runtime 快照、浏览器元数据和治理收据进入项目 `.capybara` 存储。
- Runtime Snapshot 已包含 `browserContexts`，Renderer 收到快照后会按保存的 Browser Instance、URL、Origin Policy 尝试恢复受控浏览器 View。
- 浏览器恢复支持 `reconnecting → opened → resumed` 事件；无法恢复时保留错误并进入需要验证的路径，不能伪造已恢复状态。
- 项目身份同时支持登记项目 ID 和规范化项目路径别名，避免恢复时因标识变化误判为跨项目访问。

### Browser Gateway

- `navigate/read/click/input/select/screenshot/wait/assert/download` 经过统一的 Capability admission、执行、Receipt、Evidence 和 Artifact 链路。
- Profile、Session、Tab、PageState、Action、Receipt、Evidence、Artifact、Checkpoint 均有结构化状态。
- 下载文件受到项目目录边界约束，并进入项目级 Artifact Index。

### 项目产物与资料来源

- `.capybara/runtime/artifacts/index.json` 保存项目相对路径、来源、采集时间、哈希、Run/Action/Receipt 关联和当前状态。
- 资料来源页可以看到产物，并提供 `复核 / 接受 / 拒绝` 操作。
- 后端提供文件存在性和内容哈希复核接口，接受/拒绝会写入可回放的治理事件。
- 研报下载和浏览器下载都可以进入同一套索引。

### 项目应用与运行上下文

- 项目应用页已经展示研究摘要、步骤、依据、来源、产物和运行入口。
- 运行上下文可以查看时间线、模型轮次、工具调用、工具/脚本进程、子任务、候选信息、证据、收据和应用生命周期。
- 项目切换时资源请求带有 generation guard，避免旧项目的异步结果覆盖当前项目。

## 目标场景状态

| 场景 | 当前判断 | 说明 |
|---|---|---|
| 打开项目、配置全局 Key、正常聊天 | **能力已接通，真实冷启动待验收** | IPC、系统级模型配置和会话存储已接通；还需要用实际用户配置完成一次从启动到聊天的桌面回归。 |
| 浏览器调研投资方法 | **主链路具备，真实网站异常待验收** | 受控浏览器和证据链已具备；页面加载失败、超时、崩溃和断线页面表达未完成验收。 |
| 下载 000682 最近三年研报 | **下载与治理能力具备** | 产物隔离、索引、哈希和审核 API 已有；真实网络来源、下载失败和页面点击反馈仍需验收。 |
| 获取 000682 最近一个月日线 | **能力具备，真实网络稳定性待验收** | Provider、日期窗口、证据和错误分类已有自动化覆盖；限流、来源变更和空数据页面仍需实测。 |
| 编写 Python 分析交易特征 | **能力具备，产品 Trace 关联需验收** | 子进程、cwd、超时、退出码和输出已接通；需验证用户能从一个 callId 追到进程、输出、文件和最终结论。 |
| 生成并打开行情看板 | **主链路具备** | 本地 Dashboard 发布、应用进程托管和打开入口已有；需补重启、失效地址和应用崩溃的页面状态。 |
| 给出交易建议 | **输出边界已具备** | 结果带依据、风险和不确定性，并标记为待人工审查；需真实验收前端是否始终维持该边界。 |

## 当前真正缺口

### P1：缺少一条真实端到端产品验收链

当前自动化测试已经覆盖大量单模块和协议组合，但还没有把以下步骤在一个真实桌面项目中连续跑通并留存证据：

```text
打开项目
→ 配置全局模型 Key
→ 正常聊天
→ 浏览器调研
→ 下载研报
→ 获取日线
→ 编写并执行 Python
→ 生成并打开看板
→ 形成待人工审查的交易建议
→ 重新打开项目回放完整轨迹
```

这条链需要真实 Electron、真实模型配置、真实浏览器页面和真实项目目录共同参与。当前测试结果证明“组件可用”，还不能等同于“产品场景已验收”。

### P1：浏览器主动恢复还缺冷启动页面证据

Runtime Snapshot 到 Renderer 的恢复入口已经接上，动作触发的惰性恢复也已覆盖。但仍需在实际 Electron 冷启动后证明：

- 项目打开或 Runtime 连接时，保存的页面会进入 `reconnecting`；
- 页面加载并通过 Origin Policy 后进入 `resumed`；
- 页面无法恢复时显示 `needs_verification/awaiting_user`；
- 历史 Trace、当前 View 和下一次 Agent 动作使用同一个 `browserInstanceId`。

### P1：异常路径缺少页面级回归

以下路径目前主要由代码和自动化覆盖，尚未形成完整桌面验收证据：

- 页面加载失败；
- BrowserHost 渲染进程崩溃；
- 工具或 Python 超时；
- 下载失败、文件不存在或哈希变化；
- Runtime 断线重连；
- 外部状态未知时的人工确认；
- 项目切换时仍有浏览器动作或脚本运行；
- 子代理部分成功后的父代理合并。

### P1：文件与证据入口还不够完整

Artifact Index、审核 API 和资料来源页已经存在，但仍需补齐用户可操作的完整路径：

- 从资料来源直接打开或定位项目内原始文件；
- 查看来源 URL、采集时间、哈希和关联 Receipt 的完整详情；
- 文件被删除或内容变化后的页面状态；
- 接受/拒绝/复核后的即时反馈和刷新后状态。

Round79 的桌面回归已确认按钮可见，但原生无障碍树没有提供稳定 bounds，尚未把点击后的状态变化作为可靠页面证据。

### P1：Trace 关联需要从“可见”推进到“可追踪”

用户应能从一个 `turnId / stepId / callId` 追到：

```text
模型阶段摘要
→ 工具调用参数摘要
→ 工具/脚本进程
→ Receipt 与 Evidence
→ 文件变更或 Artifact
→ 验证结果
→ 最终回复
```

现有运行上下文已展示这些类别，但跨面板的对象链接、统一终态和失败原因关联仍需收敛。

### P2：状态语义和终态映射需统一

Browser、Application、Market Research、Python 和 A2A 当前仍有各自状态字段。需要固定并在 Timeline、应用页、输入区统一映射：

`running / waiting / awaiting_user / reconnecting / succeeded / failed / unknown / needs_verification`。

### P2：WebSocket 兼容面尚未收口

Electron 桌面主链路已经使用 IPC，但 Backend 代码中仍保留 `/ws/runtime`、`/ws` 和旧 Runner WebSocket 兼容端点。它们当前不是桌面主链路故障，但如果 V2 的最终边界是“本地 Runtime 完全由 Electron 主进程托管”，仍需后续决定保留范围、迁移用途和移除条件。

### P2：Origin Policy 仍缺产品化配置面

Origin Policy 已有默认允许列表和拒绝校验，但用户还看不到本次 Browser Profile 实际使用的策略版本、来源和变更记录。后续应把它作为可审计运行配置展示。

## 当前验证证据

| 检查项 | 结果 |
|---|---|
| Backend 全量回归 | **351/351 通过** |
| Backend 类型检查 | 通过 |
| Backend 构建 | 通过 |
| Workbench 类型检查 | 通过 |
| Workbench 生产构建 | 通过 |
| BrowserSessionHost 回归 | **5/5 通过** |
| Browser Gateway 定向回归 | 通过；包含 Runtime Snapshot 的 `browserContexts` |
| ProjectArtifactIndex 定向回归 | **3/3 通过** |
| Project Artifact API | **1/1 通过** |
| Electron 页面回归 Round79 | 应用内容、资料来源、Artifact 审核入口、项目隔离、运行上下文和菜单可见；按钮点击后的状态反馈尚未形成可靠证据 |
| Git diff 检查 | 通过 |

## 下一阶段施工顺序

1. 先完成一条真实端到端产品验收链，并为每一步保存 Runtime Trace、页面截图和项目产物。
2. 补冷启动后的浏览器主动恢复和失败态页面证据。
3. 补 Artifact 原始文件/证据入口、文件复核反馈和刷新后状态。
4. 统一 `turnId / stepId / callId` 的跨面板追踪和终态映射。
5. 再处理异常路径页面回归、Origin Policy 配置面和 WebSocket 兼容面的收口决策。

## 开工判断

> **可以继续开工，当前不需要扩大能力面。下一阶段的验收重点应从“工具能不能调用”转为“完整任务能不能真实完成、重启后能不能继续、异常能不能解释、结果能不能回放”。**

