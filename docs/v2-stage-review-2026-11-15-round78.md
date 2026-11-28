# V2 阶段性工作 Review（Round78）

日期：2026-11-15

本轮审查范围：V2 Runtime、Electron 本地边界、Browser Gateway、项目应用、工具/Skill 加载、上下文与运行轨迹，以及此前约定的产品化验收场景。

## 当前结论

> **当前已经达到“主链路可施工、核心能力可回归”的阶段，但还没有达到“产品验收闭环完成”。**

现有代码已经把运行时边界收回 Electron 主进程，RuntimeLoop、工具调用、Browser Gateway、证据、产物、项目应用和 SQLite Trace 可以连起来。当前最大的缺口不是再增加能力，而是把“运行中状态”和“项目级可管理结果”接上：桌面重启后的真实浏览器会话主动恢复、下载文件的完整治理动作、异常路径的页面级验收证据。

## 已经达到的阶段目标

### 1. 本地 Runtime 主链路

- Electron 主进程托管 Runtime 和项目运行时；Renderer 通过 IPC 连接。
- 会话、消息、Trace、Runtime 快照和 Browser Gateway 快照使用项目 `.capybara/sessions.sqlite` 保存。
- 项目关闭时会停止应用实例、关闭浏览器会话、保存并关闭 Runtime，再释放项目注册。
- Electron V2 主链路已使用本地 IPC；Backend 仍保留 `/ws/runtime`、`/ws` 和旧 Runner WebSocket 兼容端点，它们不再是桌面主链路，但退出边界尚未收口。

### 2. Browser Gateway

- `browser_action` 已经过 Browser Capability admission 和 Product Work Ledger。
- 已有 Profile、Session、Tab、PageState、Action、Receipt、Evidence、Artifact、Checkpoint 的结构化对象。
- `navigate/read/click/input/select/screenshot/wait/assert/download` 已有统一动作入口。
- 运行结果可以回到 Timeline、证据治理和项目应用状态。
- Browser Gateway 状态已经进入 RuntimeLoopState，重开会话后可以恢复元数据和历史 Trace。

### 3. 产品化工作流能力

- 000682 市场研究链路已包含最近一个月日线、显式研报下载、本地 Python 分析、本地行情看板和 review-only 建议。
- 工具和 Skill 按“项目路径优先、系统目录兜底”加载，系统目录默认为用户目录下 `.capybara`。
- 工具参数、输出、权限、重放策略和资源来源都已有结构化定义。
- 上下文文档、候选信息、证据审查、投影和运行快照已进入 Runtime 状态模型。

## 目标场景审查

| 场景 | 当前状态 | 证据与判断 |
|---|---|---|
| 打开项目、配置全局 Key、正常聊天 | **基本通过** | Electron IPC、系统 `.capybara` 配置和会话 SQLite 已接通；需要继续补一轮真实用户配置后的冷启动回归。 |
| 浏览器调研投资方法 | **主链路通过，异常未验收** | Browser Gateway 支持导航、阅读、证据哈希和受控 Origin；超时、失败、崩溃、断线尚缺页面回归。 |
| 下载 000682 最近三年研报 | **能力可用，治理基本闭环** | 研报可下载到项目隔离目录并生成 quarantine Artifact，已进入项目级索引和资料来源展示；接受/拒绝已接通，文件复核入口仍需补到页面。 |
| 获取 000682 最近一个月日线 | **能力可用** | Eastmoney provider、日期窗口、证据和错误分类已有自动化覆盖；尚缺真实网络环境下的稳定性/限流回归。 |
| 编写 Python 分析交易特征 | **能力可用** | Python 子进程、工作区边界、超时、退出码、JSON 输出和证据已接通；需要页面层展示脚本进程及失败原因。 |
| 生成并打开个股行情看板 | **主链路通过** | 本地 Dashboard 发布、版本、运行地址和应用页已有回归；需继续验证重启后应用地址失效/恢复时的状态表达。 |
| 给出交易建议 | **能力可用，语义边界基本正确** | 输出是 `for_review`，含立场、依据、风险和不确定性；仍需验收前端是否始终明确“待人工审查”。 |

## 内在功能审查

| 功能 | 当前判断 | 主要缺口 |
|---|---|---|
| 上下文变化与运行进程 | **可见** | 正常路径已可见；异常、超时、未知状态的统一展示仍需补齐。 |
| 子智能体运行情况 | **可见** | 父子任务和运行状态已有结构；需补子任务中断、超时、部分结果合并的页面证据。 |
| 会话直接通讯 | **可用** | IPC Runtime frame 已统一关联；需要冷启动后重复连接和重复发送回归。 |
| 会话级与项目级上下文 | **基本通过** | `session`/`project` 文档、快照和投影已区分；需要验证切换项目后候选、证据和资料来源不串项目。 |
| 编辑系统提示词和变量 | **可用** | 有 revision、diff 和门禁；仍需确认前端入口能显示冲突、只读变量和失败原因。 |
| 添加/安装工具和 Skill | **可用** | 项目优先、系统兜底和路径边界已有实现；需要补系统资源缺失、项目覆盖和重复名称的 UI 回归。 |

## 真实缺口（按验收优先级）

### P1：浏览器真实页面恢复仍需要主动化

当前 Runtime 快照可以恢复 Browser Profile、Session、Tab、PageState 和 Receipt。已补上第一步：当桌面重启后第一次继续执行浏览器交互时，Electron 会根据保存的 URL、Origin Policy 和 Browser Instance ID 惰性重建 `WebContentsView`，并发出 `reconnecting/resumed` 事件。

但宿主目前还不会在项目打开或 Runtime 连接时主动重建页面；用户只查看历史上下文时仍看不到真实页面，直到下一次 Agent 浏览器动作触发恢复。

这会导致：

- 重启后查看历史记录正常；
- Agent 继续执行 `click/input/screenshot/wait/assert` 时会先尝试恢复页面，不再直接因为宿主内存为空而报 `browser session not found`；
- 用户在仅查看上下文的情况下，仍可能看到“状态已恢复”但页面面板尚未显示真实页面。

验收标准：重启应用后，若任务状态允许恢复，系统应在项目打开或 Runtime 连接时重新创建受控 WebContentsView，先标记 `reconnecting`，页面加载并校验 Origin 后转为 `resumed`；如果无法恢复，必须显示 `awaiting_user` 或 `needs_verification`，禁止假装可继续。当前已完成动作触发的惰性恢复，主动恢复和失败态页面表达仍待补齐。

### P1：下载文件的 Artifact 治理动作仍未完成

浏览器下载目前有项目边界、文件路径、大小、时间和哈希相关信息，也会进入 Runtime Artifact。已补上项目级 `.capybara/runtime/artifacts/index.json`、`/api/resources/artifacts` 查询接口和应用“资料来源”页展示；研报下载和 Browser 下载都会写入索引，前端只展示项目相对路径。

人工接受/拒绝动作和可回放审核事件已经接通，文件存在性/哈希复核也有后端接口；页面还缺少“复核”按钮，以及从资料来源页回到原始文件/证据的操作入口。

验收标准：每个下载产物都能从项目应用资料来源页找到，并显示来源 URL、采集时间、内容哈希、隔离路径、状态（quarantined/accepted/rejected/expired）和关联 Run/Action/Receipt；接受或拒绝必须产生可回放的治理记录。当前已完成索引、来源、相对路径、审核按钮和审核事件，页面化文件复核与原始文件入口仍待补齐。

### P1：异常路径只有代码处理，缺页面级证据

当前自动化已经覆盖正常浏览器动作、下载边界和状态持久化，但尚未完成以下页面回归：

- 页面加载失败；
- BrowserHost 渲染进程崩溃；
- 工具执行超时；
- 下载失败或超时；
- Runtime 断线重连；
- 外部状态未知时的恢复确认；
- 项目切换时正在运行的浏览器动作；
- 子代理部分成功后父代理合并。

这些路径如果没有页面证据，就无法证明“可观察、可回放、可定位”真正成立。

### P1：文件和代码工具的进程证据仍需统一到产品 Trace

Python 和应用进程已有独立的进程管理与输出，但需要确认它们与 `turnId / stepId / callId`、Tool Receipt、Artifact、Evidence 的关联在前端始终一致。当前审查重点应从“进程能否启动”转向“用户能否从运行上下文定位到进程输出、产物和最终回复”。

### P2：Browser Profile Origin Policy 还没有形成完整的产品配置面

目前策略可由工具输入和默认列表共同决定，已有 deny-by-default 和固定 Origin 校验，但用户仍看不到本次 Browser Profile 实际采用的策略版本、来源和变更记录。后续需要把策略作为可审计配置展示，而不是只在错误时显示“URL 不允许”。

### P2：运行时状态语义还需要统一终态映射

Browser、Application、Market Research、Python 和 A2A 各自都有状态字段。当前主链路已能展示，但需要固定以下映射：`running / waiting / awaiting_user / reconnecting / succeeded / failed / unknown / needs_verification`，避免同一任务在 Timeline、应用页和输入区出现不同结论。

## 已排除的旧判断

- “Browser Gateway 没有持久化”已不再成立：元数据、证据、产物、Ledger 和 Context 映射已经进入 Runtime 快照。
- “Electron V2 主链路仍依赖 WebSocket”已不再成立：桌面连接通过 IPC；但 Backend 的旧 WebSocket 兼容端点仍在代码树中，属于待收口的兼容面。
- “项目级工具无法回退系统工具”已不再成立：`ToolRegistry` 和 `SkillRegistry` 已实现项目优先、系统兜底，并做了真实路径边界校验。

## 当前验证证据

| 检查项 | 结果 |
|---|---|
| Backend 类型检查 | 通过 |
| Workbench 类型检查 | 通过 |
| Backend 构建 | 通过 |
| Workbench 生产构建 | 通过 |
| Backend 全量回归 | 351/351（Round78） |
| Browser Gateway 定向测试 | 7/7（Round77） |
| BrowserSessionHost 回归 | 4/4（含重启后惰性恢复事件） |
| ProjectArtifactIndex 定向测试（含文件复核） | 3/3 |
| Project Artifact API 回归 | 1/1 |
| Runtime 浏览器下载索引回归 | 1/1 |
| Runtime state 定向测试 | 9/9（Round77） |
| Electron 页面回归 | Round78：应用内容、资料来源、Artifact 入口、项目隔离、运行上下文和菜单通过；Round77：5/5；此前 Round76：7/7 |
| Git diff 检查 | 通过 |

## 建议的下一施工顺序

1. 完成 Browser SessionHost 重建协议：在已有惰性恢复基础上，项目打开或 Runtime 连接时主动重建 View，并回写 `reconnecting/resumed/needs_verification` 事件。
2. 为 Artifact Index 增加页面化文件存在性与哈希复核、原始文件/证据入口，并把治理动作继续映射到可回放 Trace。
3. 为失败、超时、崩溃、断线、未知结果和项目切换补页面回归计划，并逐项写入验收报告。
4. 统一进程、工具、证据、产物和最终回复的关联展示，确保从一个 `callId` 能追到结果和文件。
5. 再收敛 Origin Policy 配置和所有状态的终态映射。

## 开工判断

> **可以继续开工，但下一阶段的验收入口应从“能调用浏览器”切换为“重启后仍能继续、下载结果可治理、异常可回放”。**

当前不需要再扩大能力面；先补齐上述三个 P1 闭环，产品化风险会明显下降。
