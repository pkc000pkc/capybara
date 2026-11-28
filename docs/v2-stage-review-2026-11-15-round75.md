# V2 阶段性工作 Review（Round75）

日期：2026-11-15

本轮在 Round74 review 的基础上，完成 Browser Gateway 主链路和浏览器下载能力的第一阶段接入，并通过自动化和页面回归复核。

## 当前结论

> **浏览器动作已经进入 Browser Gateway admission、PageState、Evidence、Artifact 和 Receipt 链路；V2 Runtime 的最小产品闭环进一步成立，但异常恢复和长期持久化仍需继续施工。**

## 已完成的改动

### RuntimeLoop 接入 Browser Gateway

`browser_action` 不再直接调用 Electron `browserHost`。RuntimeLoop 现在会：

1. 创建受控 Browser Profile、Session 和 Tab；
2. 生成结构化 BrowserAction；
3. 经过 `BrowserGatewayService` 的 admission 和 Product Work Ledger；
4. 调用 Electron BrowserHost Executor；
5. 捕获 PageState；
6. 生成 page snapshot/screenshot Evidence；
7. 生成工具结果 Artifact；
8. 返回 Browser Receipt、Ledger Receipt、Evidence 和 Artifact 引用。

关联实现：

- `apps/backend/src/core/runtime-loop.ts`
- `apps/backend/src/core/browser-gateway-service.ts`
- `apps/backend/src/core/browser-capability.ts`
- `apps/backend/src/core/runtime-resource-tools.ts`

### 浏览器下载

Electron BrowserSessionHost 现在支持：

- 受控 origin 下载；
- 项目边界内的 `.capybara/runtime/browser-downloads` 目录；
- 文件名清理和路径边界校验；
- 超时和失败结果；
- 下载完成状态、文件大小、路径和时间收据；
- Runtime Artifact 和 `download` Evidence 关联。

### 页面回归

Round76 在最新 Electron 构建上完成 7/7 页面用例，覆盖：

- 项目应用页签和关闭/恢复；
- 时间线、进程、子智能体、证据治理；
- 浏览器打开、控制栏和 Example Domain；
- 浏览器与行情看板互切；
- 菜单、帮助弹窗和输入区；
- 跨项目会话、应用和浏览器隔离。

## 验证结果

| 检查项 | 结果 |
|---|---|
| Backend 类型检查 | 通过 |
| Backend 构建 | 通过 |
| Backend 全量测试 | 345/345 |
| RuntimeLoop 定向 app 测试 | 42/42 |
| BrowserSessionHost 测试 | 3/3 |
| Workbench 生产构建 | 通过 |
| Workbench 类型检查 | 通过（Next 构建完成后复跑） |
| Electron 页面回归 | Round76：7/7 |

## 仍然存在的真实缺口

### P1：Browser Gateway 状态尚未独立持久化

Browser Receipt、PageState、Evidence 和 Artifact 已进入 Runtime 工具结果和运行时 Artifact，但 BrowserCapability/BrowserGateway 的内存状态还没有单独写入项目 SQLite 的浏览器索引。重新打开项目后可以回放工具结果，不能完整重建当时的 Browser Session、Tab 和 PageState 对象。

### P1：下载文件虽然已落盘，但还需完整项目产物索引

下载文件已写入项目 `.capybara/runtime/browser-downloads`，并生成隔离态 artifact/receipt。后续需要把下载文件纳入项目级 Artifact 索引、来源页面、内容哈希和人工接受/拒绝流程，避免只依赖运行时内存结果。

### P1：浏览器异常场景仍缺页面回归

尚未完成页面层的完整证据：

- 下载超时；
- 页面加载失败后的替代来源；
- BrowserHost 崩溃后恢复；
- 桌面重启后的浏览器动作回放；
- 运行中断线和未知外部状态；
- 项目切换时正在下载的清理策略。

### P1：脚本断言策略仍需收敛

`assert` 仍允许受限宿主执行模型生成的表达式字符串，后续应补齐表达式长度、执行时间、DOM 访问范围和页面状态版本约束。

### P2：开放式站点策略仍是固定列表

当前 Electron 默认 origin 仍是 Example、Investor.gov 和 CNInfo。需要把它提升为可配置、可审计的 Browser Profile 策略，或者在产品层明确它就是受控站点集合。

### P2：旧 WebSocket 兼容层仍保留

Electron 主链路继续使用 IPC，但 Backend 旧 WebSocket transport 仍在代码树中。需要在协议收口阶段明确兼容策略。

## 下一施工顺序

1. 将 Browser Session、Tab、PageState、Receipt、Evidence、Artifact 写入项目级浏览器索引和 SQLite Trace。
2. 完成下载文件的项目 Artifact 管理和页面资料来源展示。
3. 补齐超时、失败、崩溃、重启、未知状态和项目切换清理回归。
4. 收敛 `assert` 脚本策略与 Browser Profile origin 配置。
5. 再决定旧 WebSocket 兼容层的保留和退出边界。

