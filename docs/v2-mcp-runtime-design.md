# V2 MCP：能力发现、调用与结果记录

版本 v0.9 · 日期 2026-11-21

MCP 是能力来源。它与 system tools、项目工具共享阶段投影、权限复核、工具观察和完成门禁；服务端文本不能成为系统指令，服务端的只读声明也不能自行授予权限。整体缺口继续在[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md)追踪。

实现采用官方 `@modelcontextprotocol/client` 2.4.0，支持 stdio 与 Streamable HTTP，并由 SDK 协商现代或兼容协议。协议、SDK 行为和宿主自己的授权策略分别判断。[官方 SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[工具规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)。

## 1. 配置与权限

项目设置的 `mcp_servers` 声明服务。`enabled` 必须明确，服务 ID 在本项目唯一；凭据配置使用环境变量引用。以下是可合并到 `.capybara/config.json` 的配置片段：

```json
{
  "mcp_servers": [
    {
      "id": "knowledge",
      "enabled": true,
      "transport": {
        "type": "stdio",
        "command": "node",
        "args": ["tools/knowledge/server.mjs"],
        "cwd": ".",
        "env_refs": {"SERVICE_TOKEN": "KNOWLEDGE_SERVICE_TOKEN"}
      },
      "timeout_ms": 15000,
      "tool_policies": {
        "lookup": {"permissions": [], "sideEffects": "none", "replay": "safe"}
      }
    }
  ],
  "tool_permissions": ["mcp:knowledge:lookup"]
}
```

此片段中的 `tool_permissions` 展示 MCP 所需授权，合并时保留项目已经授权的其他权限。HTTP 传输写为：

```json
{
  "type": "streamable-http",
  "url": "https://example.com/mcp",
  "header_refs": {"Authorization": "KNOWLEDGE_MCP_AUTHORIZATION"}
}
```

对应环境变量保存完整请求头值。端点不夹带账号、密码、查询参数或片段；协议头由 SDK 管理。stdio 子进程使用系统环境白名单及显式引用，不继承整个宿主环境；stderr 不直接进入模型或宿主日志。

每项远端工具至少要求 `mcp:<serverId>:<remoteToolName>`，再加宿主 `tool_policies` 声明的权限。没有宿主策略时，副作用按 external、重放按 never 处理。远端 annotations 只作材料，不能把工具变成只读、移除权限或扩大子代理能力。

## 2. 身份、发现与投影

| 对象 | 含义 |
| --- | --- |
| serverId | 配置指定的本项目服务身份，不使用远端自报名称去重 |
| capabilityId | `mcp:<serverId>:<remoteToolName>`，用于发现、加载和计划 |
| 模型工具名 | 宿主生成的有界名称，包含服务/工具的确定性摘要，防止同名碰撞 |
| connectionId | 每次真实连接由宿主生成的新身份，不沿用旧连接的授权 |
| sourceVersion | 配置、连接身份、协商版本、远端定义和宿主策略的绑定 |
| rpcRequestId | 实际 tools/call 传输请求 ID，区别于模型提出的 callId |

sourceVersion 绑定本次使用的定义与连接，不证明远端服务器内部代码。serverInfo 的名称和版本仍是服务端自报信息。

主模型请求前刷新已配置服务及 `tools/list`。分页、工具数量和目录总大小均有上限。`tools/list_changed` 立即撤销旧目录。如果通知在读取期间到达，丢弃该轮全部分页结果，沿用原发现期限重新读取。只有同一连接上完整且未被撤销的一轮目录可以发布。发现超时或连接失败时，宿主记录对应的失败状态。

发现只产生目录。模型经 search_resources / load_resources 激活需要的工具，执行 schema 才进入本轮工具通道。调查与验证阶段继续过滤写入/进程能力；子代理继续受只读边界约束。刷新不会隐式授予缺失权限。

CapabilityProjection 保留 MCP 来源及具体绑定。入队、准备事件后和实际分发边界复核；定义、权限或连接变化使旧调用失效。重连重新发现并交给模型决策，不能把旧调用自动换授权执行。宿主还限制每个调用至多分发一次业务 RPC，避免底层自动重发改变副作用语义。

## 3. 返回值与失败

真实 MCP 返回进入普通 tool-result artifact、观察与候选路径，正文和 structuredContent 保留。执行收据增加 `source`，记录 server/tool、连接、sourceVersion、协议版本、实际 RPC ID 和结果状态。主模型判断业务含义；整理器只组织有来源的信息。

| 情况 | 宿主记录 |
| --- | --- |
| 参数或权限不合格 | 分发前拒绝，不制造执行成功 |
| 远端 isError | 只读调用记录业务失败。产生副作用的调用保留未知结算及返回材料 |
| 无效 RPC 或不符 schema 的结果 | 协议/验证失败，不生成成功观察 |
| 非 JSON stdout 后没有合法回复 | SDK 忽略该行，最终超时；该行不成为结果 |
| 读取断连/超时 | 失败记录；发现可以重连，业务调用由模型重新提出 |
| 写入已尝试但缺少可信结果 | unknown，先核查；不能因连接恢复就重复写入 |
| 返回需要额外输入 | 保留结构化请求；不自动获得 sampling、roots 或人工授权 |

stdio 接收缓冲与 HTTP 响应读取均有限额；HTTP 在 SDK 完整缓冲/解析前限制字节数，完整返回另作结果大小检查。目录、schema 和结果都按外部材料处理。

远端 Streamable HTTP 在桌面代理开启时沿用模型请求的代理偏好。回环地址保持直连，非回环地址使用 Node HTTP Agent 建立连接，避免把 Node Agent 错误地当成 Undici dispatcher。`apps/backend/demo/mcp-remote-smoke.ts` 可对公开或项目配置的只读端点执行发现验收。

## 4. 副作用登记与持久化

写调用在发出业务 RPC 前，向真实 SQLite `runtime_mcp_operations` 表登记 operationId、参数摘要与来源。登记失败不分发；同 session 的相同未结算动作不能再次登记。RPC ID 在传输边界关联，真实结果返回后再结算。

会话快照中的 unknownCalls 只是恢复材料。主模型请求、恢复和 checkpoint 回退以 SQL 中未结算记录为准，旧或空快照不能清除它们。新的 run 也不能靠重置时间线消除同会话未知写入。完成门禁同时检查时间线和未结算 MCP 登记。

远端已确认成功、本地结算持久化失败时，真实工具成功继续保留；未结算登记仍阻止重复写入与正常完成，错误单独记录为 MCP_OUTCOME_PERSIST_FAILED。不能把本地收尾失败描述为远端已经回滚。

会话清理在既有事务中清除登记并留下墓碑，旧运行不能再登记或结算。桌面关闭先撤销继续执行、取消活动请求，再等待 MCP 连接和子进程退出。未取得最终结果的预登记仍可从 SQL 恢复。

### 4.1 核查未知写入

副作用工具的宿主 `tool_policies` 可声明 `verification_tool`。验证工具由同一服务注册，具备显式只读策略、可安全重读及独立 `mcp:<serverId>:<toolName>` 权限。宿主在原写入预登记时保存核查合同版本、原任务/运行/步骤/调用与参数哈希，并把 operationId 通过 `io.capybara/operationId` 发送给服务。重连可更换 connectionId，当初的端点、凭据和核查合同须匹配。

服务按 operationId 保存业务结局。核查工具接收 `{ "operation_id": "..." }`，用 `structuredContent` 返回同一 ID 和 `outcome`。`applied` 表示已经生效。`not_applied` 要求服务保证该 ID 已终结且迟到请求也无法使它生效。处理中、查不到、异常、文字推测和无法关联的回执都保持 `unknown`。

模型从 `runtime_state.mcp.pendingOperations` 获取实际 ID，加载并投影配置的核查能力，然后调用 `verify_mcp_side_effect`，只提交 `operation_id`。运行时按本轮权限执行真实只读 RPC，核对精确结构与 ID。原始核查结果和结算回执在同一事务保存，原写入的断连、错误或超时观察继续保留。迟到的原尝试记录不能覆盖终态。

持久 `applied` 回执证明原任务与原运行的原动作。`not_applied` 释放原动作的重复签名锁，后续写入需重新决策，以新调用和新 operationId 受当前授权约束。正常完成还检查其余动作、证据与等待。较旧的普通工具步快照恢复时用 SQL 重新呈现原操作，已经登记过的写入不会由恢复入口再次分发。缺少可信核查合同的记录继续保持未知，可按实际需要转人工核对。[任务状态与完成](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#73-完成与非正常结束)

### 4.2 恢复 Workflow

未知写入的 Workflow 先提交部分结果，保留已完成节点、`foreach` 的已完成迭代和前次结果原件。待核查项绑定原 run、Workflow、节点、步骤和操作 ID。重连从 SQL 回传已登记的写入状态及其可用原始输出，旧步骤保持原调用身份。核查由后续模型轮按本轮投影独立发起。

- `applied` 后，核查服务可在 `structuredContent.original_result` 提供完整原 MCP 结果。宿主按写入时登记的输出 schema 校验其结构化内容。有结果时，下游沿用原输出。缺少结果时，静态可确认独立的后续步骤可以继续，并标记输出不可用。可能读取缺失结果的引用和表达式保持待处理。
- 原输出迟到时，可用同一 operationId 再次通过只读合同补读。原结算及回执 ID 保留，补读原件单独绑定。相反结局和不符合合同的输出无法取代已有证据。
- `not_applied` 后，恢复会为该写入签发新调用 ID，并复核参数哈希与原操作一致。后续步骤和迭代继续沿用已保存的部分结果。

以 `resume_workflow(workflow_id, verification_receipt_id)` 单独续跑原图。只排队尚未完成的步骤，逐次使用当前能力投影和执行前复核。旧部分结果和新结果分别保留。只有原图真正走完才记为完成，剩余恢复项进入任务完成门禁。

### 4.3 等待写入结算

宿主可在原写入的 `tool_policies` 同时配置 `verification_tool` 与 `verification_poll_ms`。轮询间隔范围为 1 至 60 秒，登记时绑定当初配置、凭据、实现摘要和核查合同。`runtime_state.mcp.pendingOperations` 提供原 taskId、runId，为已配置轮询的写入提供 `verificationPollIntervalMs`。

主轮先让只读核查能力进入当前投影，再引用宿主签发的期限，使用 `signalType=runtime`、`condition.eventType=mcp.operation.settled` 和一个同 session/task/run 的原 operationId。该订阅作用于根任务，任何终态均可让主轮恢复判断。普通事件输入不能签发这个信号。

暂停期间，每次只执行一个核查探测。重连只按原配置恢复已授权的核查服务。宿主在分发和接受终态前复核能力、绑定、期限和订阅状态。回执持久化后，等待控制器从 SQLite 读取原件引用，按回执时间结算并唤醒原运行。关闭重开复用原订阅和绝对期限，跨进程恢复也可消费期限前已保存的回执。权限失效、返回处理中或结论无法关联时保留未知，期限实际到达后按 `timed_out` 恢复判断。取消订阅或运行会停止轮询。

MCP 远端返回 `input_required` 可请求额外人工输入，其响应按多轮输入处理。结算等待仍使用同一 operationId 的终态核查合同。[MCP 多轮请求规范](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)

### 4.4 人工输入往返

现代 MCP 服务的直接只读工具可配置 `human_input: "form"`，需同时声明 `sideEffects: "none"`、`replay: "safe"`。宿主从实际 `input_required` 登记关联会话、任务、原调用、服务身份与请求项。桌面使用折叠表单显示请求来源和字段，用户明确选择接受、拒绝或取消，再通过 `runtime.mcp.input.reply` 提交对应 requestId。宿主按服务的平面 schema 校验提交值。[MCP Elicitation 规范](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)

`runtime_mcp_inputs` 持有原参数、服务能力绑定、`requestState` 与输入回复。快照和事件发布表单定义与状态，主轮仅获得请求摘要，原始答案和续传令牌独立保存。SQL 记录回复时间，`runtime / mcp.input.responded` 只由该记录触发，支持回复先于订阅和关闭重开。主轮凭已答的 ID 请求 `resume_mcp_input`，宿主校验原能力仍在当前投影，保持原请求参数，按原键组装 `inputResponses` 并回传原 `requestState`。

续传先在事务中领取一次性回复和令牌，再分发新 RPC，完成领取消费后的私有字段清理。失去传输结果时保留中断状态，由后续决策处理。服务可以提出新一轮请求，宿主签发新请求 ID，同一原调用最多登记十轮表单。终态返回按原工具 schema 校验，工具结果和原调用完成引用一起保存。任务取消或更换任务会清除待提交的数据。

表单验收分别核对重复回复、权限更改、关闭重开、取消后的迟到回复、连续多轮输入及原调用完成证据。

### 4.5 写入确认与续传

写入工具配置 `human_input: "form"` 时，宿主策略须声明副作用、`replay: "never"` 或 `"confirm"`，以及具有独立权限的只读 `verification_tool`。服务以同一 operationId 识别原调用及所有续传。初次 `input_required` 保留未知结算及重复签名门禁，工作台显示原工具和明确的写入确认操作。

表单全部接受后，主轮单独提交 `resume_mcp_write_input(request_id)`。宿主验证原参数摘要、任务与步骤、服务的核查合同和当前原能力投影。同一表单领取一次，分发前以该表单记录新的 RPC ID 和实际连接。预登记失败时没有远端续传。下一轮表单使用新请求 ID，原写入与其参数保持绑定。

合法终态输出与续传回执、当次真实来源和原操作结局在同一事务保存。断连或结果未确认时保留原操作的未知状态，之后通过原 operationId 核查。用户拒绝或取消会关闭本地表单并产生对应等待回执。若需要确认初次调用是否产生效果，仍按原操作核查。正式完成同时核对原调用及续传尝试的真实结算依据。

### 4.6 Workflow 节点的人工输入

已配置表单的 MCP 工具在 Workflow 节点内返回 `input_required` 时，宿主把真实 requestId 关联到原图、节点、步骤和调用。Workflow 保存部分结果并进入 `suspended`，当前节点标为 `awaiting_input`。工作台显示请求来源和节点。完成的前缀及 `foreach` 已完成的迭代留在原图中。

模型通过现有 MCP 续传工具处理表单。每轮都复核原节点绑定和真实原能力投影。终态输出与回执一并持久保存，`workflowRecoveries` 发布可用的 `inputReceiptId`。模型单独调用 `resume_workflow(workflow_id, input_receipt_id)`。宿主按原任务、原步骤和哈希审核输出，再补齐原节点并调度剩余步骤。对已核查的写入仍可使用 `verification_receipt_id`，两类回执各自校验原件。

重连从已登记表单恢复原关联。较旧步骤游标读到已登记的输入时重呈部分结果。写入表单被拒绝或取消时结束该图的剩余节点，发生过的写入尝试保留原 operationId 的结算义务。若只读续传没有可信终态输出，保留部分结果和失败原因。

### 4.7 URL 人工协助的控制契约

配置 `human_input: "url"` 启用 URL 模式，`"form_and_url"` 允许组合回复。只有提供系统浏览器打开入口的受信宿主声明 URL 能力。写入工具沿用只读核查合同和原 operationId。浏览器只打开已登记的 HTTPS 地址，本地开发可用回环 HTTP，拒绝 URL 内的账号和密码。

桌面向用户展示发起服务、完整规范化地址和突出显示的域名。确认后 Electron 主进程按请求 ID 读取已登记的目标并打开系统浏览器，外部页面和凭据交互留在浏览器中。展示阶段只读取本地私有记录。公开快照使用宿主签发的 URL 项 ID 与打开状态，地址和服务项键通过同会话的交互入口与私有记录分别使用。窗口重开恢复打开状态，继续步骤由用户选择。

打开浏览器记录用户同意导航。用户完成外部交互后可主动继续原请求，或拒绝、取消。只有显式回复触发 `mcp.input.responded`。URL 模式的接受响应只提交 `action`，沿用服务提供的原 `requestState` 和原调用关联。由服务返回终态输出或提出下一轮人工输入。宿主继续校验当前权限和实际响应，原节点或写入按对应回执验收。[MCP URL Elicitation](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation#url-mode-elicitation-requests) · [MCP 多轮请求](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)

验收分别验证未同意前无导航、无预取、跨会话不能读取或操作请求、重开后可继续、重复指令只能领取一次、打开后可取消，以及服务在交互未完成时返回下一轮。终态业务结果进入原工具和 Workflow 的回执链。

## 5. 上下文与训练

MCP 状态在 readonly runtime_state 和独立运行快照中展示，不写入 project_context 或 session_context 来代替控制记录。文档可以保留来源和结果摘要，实际权限、连接及未知动作以运行时和登记为准。

训练记录保留模型原始意图、真实 RPC、结果 artifact、拒绝原因及持久化结果。宿主签发的 operationId、连接、权限、状态与收据作为来源或标签，不成为整理模型的生成目标。超时、断连和记账故障不改标为答案错误或业务成功。

代码入口：[配置](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/mcp/config.ts)、[客户端](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/mcp/client-manager.ts)、[权威登记](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-commit-store.ts)、[运行测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/mcp-runtime.test.ts)、[真实传输与故障测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/mcp-client-manager.test.ts)。
