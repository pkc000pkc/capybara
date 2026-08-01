# Capybara Runtime WebSocket Protocol v1

状态：Draft 1<br>
适用范围：Capybara 前端与单个运行时会话之间的双向通信<br>
推荐端点：`GET /ws/runtime?sessionId={sessionId}&lastSequence={sequence}`

本文中的“必须”“禁止”“应当”是规范性要求。运行时中的“方法”统一使用当前产品术语“经验”，协议字段使用 `experience`，不再新增 `method` 字段。

## 1. 设计目标

- 一个 WebSocket 连接承载运行时页面的命令、状态和流式输出。
- 服务端是运行时状态的唯一权威来源，前端不自行推导最终状态。
- 命令可确认、可拒绝、可关联，断线后可以恢复且不会重复执行。
- 变量、模板、工具清单和经验清单支持并发修订检查。
- 全量快照与增量事件使用同一套领域模型。
- 工具定义在线路中使用结构化 JSON，不传输仅用于展示的 YAML 文本。

资源区的文件读取、工具目录管理和 Skill 管理可以使用独立 HTTP API 或资源 WebSocket；当资源变更影响当前运行时，仍通过本文定义的运行时下行事件通知前端。

## 2. 传输约定

- WebSocket 文本帧，编码固定为 UTF-8。
- 每个帧只包含一个 JSON 对象，不允许顶层数组。
- 字段名使用 `camelCase`，事件类型使用小写点分格式，例如 `variables.updated`。
- 时间使用 UTC RFC 3339 格式，例如 `2026-07-22T08:30:12.345Z`。
- 时长使用整数毫秒并以 `Ms` 结尾，例如 `durationMs`。
- ID 是不透明字符串，推荐 UUID v4 或 ULID；客户端不得解析 ID 内容。
- 可选字段无值时应省略。只有业务明确区分“空值”和“未提供”时才使用 `null`。
- 单帧上限建议为 1 MiB；超过上限时服务端使用关闭码 `1009`。
- 服务端应每 20 秒发送 WebSocket Ping 控制帧，10 秒未收到 Pong 时断开连接。浏览器会自动处理 Pong，不定义 JSON 心跳消息。

## 3. 消息信封

### 3.1 上行命令

```ts
interface ClientCommand<TPayload = unknown> {
  version: 1;
  kind: "command";
  id: string;              // 客户端生成的幂等键
  type: CommandType;
  sessionId: string;
  runId?: string;
  timestamp: string;       // 仅用于诊断，服务端时间为准
  payload: TPayload;
}
```

示例：

```json
{
  "version": 1,
  "kind": "command",
  "id": "cmd_01K0VZTF7TW1Z6M4N5W0R0F8D7",
  "type": "run.pause",
  "sessionId": "ses_01K0VZRQGJ7KQ1YJ3P3Y8S2G5A",
  "runId": "run_01K0VZS52EJXH2W1B6P4NJH3MD",
  "timestamp": "2026-07-22T08:30:12.345Z",
  "payload": {}
}
```

### 3.2 下行事件

```ts
interface ServerEvent<TPayload = unknown> {
  version: 1;
  kind: "event";
  id: string;
  type: EventType;
  sessionId: string;
  runId?: string;
  sequence: number;        // 会话内严格递增，从 1 开始
  timestamp: string;       // 服务端生成
  correlationId?: string; // 触发该事件的命令 id
  payload: TPayload;
}
```

`sequence` 按会话而不是按连接递增。重连后不得重置。

## 4. 上行命令清单

| 类型 | 来源 | 用途 | 关键载荷 |
| --- | --- | --- | --- |
| `runtime.snapshot.get` | 系统 | 请求权威全量快照 | `afterSequence?` |
| `chat.message.send` | 对话区 | 发送用户消息并选择是否自动启动 | `clientMessageId`, `content`, `autoStart` |
| `chat.response.cancel` | 对话区 | 停止当前回复生成，但保留已生成内容 | `assistantMessageId?` |
| `run.mode.set` | 调试区 | 切换单步/持续模式 | `mode` |
| `run.start` | 调试区 | 创建并启动一次运行 | `inputMessageId?` |
| `run.step` | 调试区 | 执行下一步，完成后保持暂停 | 空对象 |
| `run.resume` | 调试区 | 从暂停状态继续执行 | 空对象 |
| `run.pause` | 调试区 | 请求在安全点暂停 | 空对象 |
| `run.interrupt` | 调试区 | 中断当前步骤并保留可恢复状态 | `reason?` |
| `run.restorePrevious` | 调试区 | 恢复到上一个已提交步骤 | `targetStepId?` |
| `run.cancel` | 系统/对话区 | 终止整个运行，不再允许恢复 | `reason?` |
| `variables.apply` | 变量区 | 原子应用变量补丁 | `baseRevision`, `patch` |
| `template.update` | 模板区 | 更新模板源文本 | `templateId`, `baseRevision`, `source` |
| `template.render` | 模板区 | 使用服务端权威状态执行渲染 | `templateId` |
| `runtime.tools.attach` | 工具清单 | 将目录工具追加到当前运行时 | `toolId`, `baseRevision` |
| `runtime.tools.detach` | 工具清单 | 从当前运行时移除工具 | `toolId`, `baseRevision` |
| `runtime.experiences.add` | 经验清单 | 新增运行时经验 | `baseRevision`, `experience` |
| `runtime.experiences.update` | 经验清单 | 修改一条运行时经验 | `baseRevision`, `experienceId`, `changes` |
| `runtime.experiences.remove` | 经验清单 | 删除一条运行时经验 | `baseRevision`, `experienceId` |

### 4.1 对话消息

```ts
interface ChatMessageSendPayload {
  clientMessageId: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "fileRef"; fileId: string; name: string }
  >;
  autoStart: boolean; // 默认 true；运行中发送时进入输入队列
}
```

文本不得只包含空白。附件只传资源 ID，不在运行时 WebSocket 中内嵌文件二进制内容。

### 4.2 调试动作

```ts
type ExecutionMode = "step" | "continuous";

interface RunModeSetPayload {
  mode: ExecutionMode;
}
```

`run.pause` 表示在可中断安全点暂停；`run.interrupt` 表示立即中断当前步骤并保留最后一个已提交检查点；`run.cancel` 表示结束整个运行。三者不得混用。

### 4.3 变量修改

变量路径采用 RFC 6901 JSON Pointer，补丁采用 RFC 6902 的 `add`、`remove`、`replace` 子集。

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonPatchOperation =
  | { op: "add" | "replace"; path: string; value: JsonValue }
  | { op: "remove"; path: string };

interface VariablesApplyPayload {
  baseRevision: number;
  patch: JsonPatchOperation[];
}
```

示例：

```json
{
  "baseRevision": 12,
  "patch": [
    {
      "op": "replace",
      "path": "/task/title",
      "value": "分析新的页面布局"
    }
  ]
}
```

服务端必须再次执行变量写权限检查，不能只依赖前端禁用输入框：

```text
variablesEditable = run.status == "paused" OR run.mode == "step"
```

不满足时拒绝命令，错误码为 `VARIABLES_LOCKED`。

### 4.4 模板修改与渲染

```ts
interface TemplateUpdatePayload {
  templateId: string;
  baseRevision: number;
  source: string;
}

interface TemplateRenderPayload {
  templateId: string;
}
```

客户端可对 `template.update` 做 300-500 ms 防抖，但不得跳过最终版本。运行中收到的模板更新从下一个尚未开始的渲染步骤生效，不改变正在执行步骤已经冻结的输入。

### 4.5 工具清单

运行时只管理工具的引用关系，不直接修改工具定义。工具定义必须在资源区修改。

```ts
interface RuntimeToolMutationPayload {
  toolId: string;
  baseRevision: number;
}
```

服务端应拒绝重复添加，错误码为 `ALREADY_EXISTS`；删除不存在的工具返回 `NOT_FOUND`。

### 4.6 经验清单

```ts
interface ExperienceDraft {
  name: string;
  content: string;
  metadata?: Record<string, JsonValue>;
}

interface ExperienceChanges {
  name?: string;
  content?: string;
  metadata?: Record<string, JsonValue>;
}
```

新增、修改和删除经验都必须携带经验清单的 `baseRevision`。

## 5. 下行事件清单

| 类型 | 消费区域 | 用途 |
| --- | --- | --- |
| `session.attached` | 系统 | 连接已绑定到会话，返回协商版本和恢复模式 |
| `command.accepted` | 系统 | 命令已通过格式、权限和前置状态检查 |
| `command.rejected` | 发起区域 | 命令未执行，返回标准错误 |
| `runtime.snapshot` | 全页面 | 初次连接或重同步时的权威全量状态 |
| `runtime.status.updated` | 状态区 | 模型连接、上下文用量、队列等系统状态 |
| `chat.user.created` | 对话区 | 服务端确认并广播用户消息 |
| `chat.assistant.started` | 对话区 | 创建助手消息并开始流式输出 |
| `chat.assistant.delta` | 对话区 | 思考摘要或最终回答的文本增量 |
| `chat.assistant.completed` | 对话区 | 助手消息完成、用量与结束原因 |
| `chat.assistant.failed` | 对话区 | 助手生成失败或被取消 |
| `run.state.changed` | 调试区、变量区 | 执行模式、状态、当前步骤和变量权限变化 |
| `timeline.step.upserted` | 时间线 | 新增或更新一个时间线步骤 |
| `variables.updated` | 变量区、渲染区 | 权威变量快照或增量补丁 |
| `template.updated` | 模板区 | 权威模板版本更新 |
| `template.validation.failed` | 模板区 | 模板解析或校验失败 |
| `render.result.updated` | 渲染结果 | Markdown 渲染结果更新 |
| `render.result.failed` | 渲染结果 | 渲染错误及诊断信息 |
| `runtime.tools.updated` | 工具区、变量区 | 当前运行时工具清单或工具定义版本更新 |
| `runtime.experiences.updated` | 经验区 | 当前运行时经验清单更新 |
| `session.resync.required` | 系统 | 检测到事件缺口且无法重放，需要请求快照 |
| `protocol.error` | 系统 | JSON 或信封格式错误，命令尚未进入业务层 |

## 6. 核心领域模型

### 6.1 运行状态

```ts
type RunStatus =
  | "idle"
  | "ready"
  | "running"
  | "paused"
  | "waiting"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";

interface RunState {
  runId: string | null;
  mode: "step" | "continuous";
  status: RunStatus;
  currentStep: number;
  currentStepId?: string;
  variablesEditable: boolean;
  updatedAt: string;
}
```

`run.state.changed` 必须携带完整 `RunState`，不要只发送单个状态字段，避免前端组合出不存在的状态。

### 6.2 对话消息

```ts
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  status: "queued" | "streaming" | "completed" | "failed" | "cancelled";
  content: Array<{ type: "text"; text: string }>;
  thinkingSummary?: string;
  createdAt: string;
  completedAt?: string;
}

interface ChatAssistantDeltaPayload {
  messageId: string;
  channel: "thinkingSummary" | "final";
  chunkIndex: number;
  delta: string;
}
```

`thinkingSummary` 只允许发送可展示的思考摘要、进度或决策说明，禁止传输模型隐藏推理或原始 chain-of-thought。

### 6.3 模板和渲染结果

```ts
interface TemplateState {
  id: string;
  language: "jinja2+markdown";
  source: string;
  revision: number;
  updatedAt: string;
}

interface RenderResultState {
  content: string;
  format: "markdown";
  templateRevision: number;
  variablesRevision: number;
  renderedAt: string;
  diagnostics: Diagnostic[];
}

interface Diagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  line?: number;
  column?: number;
}
```

### 6.4 变量

```ts
interface VariablesState {
  revision: number;
  value: Record<string, JsonValue>;
}

interface VariablesUpdatedPayload {
  baseRevision: number;
  revision: number;
  patch: JsonPatchOperation[];
  source: "user" | "runtime" | "tool" | "restore";
}
```

初次连接使用快照中的完整 `VariablesState`；正常运行只发送 `variables.updated` 增量。前端应用补丁失败或发现 revision 不连续时必须请求快照。

### 6.5 工具

```ts
interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;  // JSON Schema
  outputSchema?: Record<string, JsonValue>;
  definitionRevision: number;
  enabled: boolean;
}

interface RuntimeToolsState {
  revision: number;
  items: ToolDefinition[];
}
```

YAML 只是一种资源区编辑格式。资源服务验证 YAML 后必须发布结构化 `ToolDefinition`，运行时和前端不得把 YAML 字符串当作权威业务对象。

### 6.6 经验

```ts
interface ExperienceDefinition {
  id: string;
  name: string;
  content: string;
  metadata: Record<string, JsonValue>;
  revision: number;
}

interface RuntimeExperiencesState {
  revision: number;
  items: ExperienceDefinition[];
}
```

### 6.7 时间线

```ts
interface TimelineStep {
  id: string;
  index: number;
  type: "context" | "render" | "model" | "tool" | "experience" | "output";
  status: "pending" | "running" | "success" | "error" | "interrupted";
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  summary: string;
  detail?: Record<string, JsonValue>;
}
```

`timeline.step.upserted` 以 `id` 幂等更新；同一步骤可以先发送 `running`，完成后再发送 `success` 或 `error`。

### 6.8 运行环境状态

```ts
interface RuntimeStatusState {
  revision: number;
  runtime: "healthy" | "degraded" | "unavailable";
  model: "ready" | "busy" | "unavailable";
  context: {
    usedTokens: number;
    maxTokens: number;
    utilization: number; // 0-1
  };
  queueDepth: number;
  updatedAt: string;
}
```

### 6.9 运行时快照

```ts
interface RuntimeSnapshotPayload {
  snapshotRevision: number;
  lastSequence: number;
  run: RunState;
  conversation: {
    revision: number;
    messages: ChatMessage[];
  };
  template: TemplateState;
  renderResult: RenderResultState | null;
  variables: VariablesState;
  tools: RuntimeToolsState;
  experiences: RuntimeExperiencesState;
  timeline: {
    revision: number;
    steps: TimelineStep[];
  };
  status: RuntimeStatusState;
}
```

快照必须可以独立恢复整个运行时页面，前端不得依赖快照之前的事件。

### 6.10 下行事件载荷

```ts
interface SessionAttachedPayload {
  protocolVersion: 1;
  resumeMode: "new" | "replay" | "snapshot";
  serverTime: string;
}

interface ChatAssistantStartedPayload {
  message: ChatMessage; // status 为 streaming，content 初始可为空
}

interface ChatAssistantCompletedPayload {
  messageId: string;
  finishReason: "stop" | "length" | "cancelled" | "error";
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  completedAt: string;
}

interface ChatAssistantFailedPayload {
  messageId: string;
  code: string;
  message: string;
  retryable: boolean;
}

interface TimelineStepUpsertedPayload {
  revision: number;
  step: TimelineStep;
}

interface TemplateValidationFailedPayload {
  templateId: string;
  attemptedRevision: number;
  diagnostics: Diagnostic[];
}

interface RenderResultFailedPayload {
  templateRevision: number;
  variablesRevision: number;
  diagnostics: Diagnostic[];
}

interface SessionResyncRequiredPayload {
  reason: "sequenceGap" | "historyExpired" | "backpressure";
  lastAvailableSequence?: number;
}
```

各事件的 payload 必须遵守以下映射：

| 事件 | Payload |
| --- | --- |
| `session.attached` | `SessionAttachedPayload` |
| `command.accepted` | `CommandAcceptedPayload` |
| `command.rejected` | `CommandRejectedPayload` |
| `runtime.snapshot` | `RuntimeSnapshotPayload` |
| `runtime.status.updated` | `RuntimeStatusState` |
| `chat.user.created` | `ChatMessage` |
| `chat.assistant.started` | `ChatAssistantStartedPayload` |
| `chat.assistant.delta` | `ChatAssistantDeltaPayload` |
| `chat.assistant.completed` | `ChatAssistantCompletedPayload` |
| `chat.assistant.failed` | `ChatAssistantFailedPayload` |
| `run.state.changed` | `RunState` |
| `timeline.step.upserted` | `TimelineStepUpsertedPayload` |
| `variables.updated` | `VariablesUpdatedPayload` |
| `template.updated` | `TemplateState` |
| `template.validation.failed` | `TemplateValidationFailedPayload` |
| `render.result.updated` | `RenderResultState` |
| `render.result.failed` | `RenderResultFailedPayload` |
| `runtime.tools.updated` | `RuntimeToolsState` |
| `runtime.experiences.updated` | `RuntimeExperiencesState` |
| `session.resync.required` | `SessionResyncRequiredPayload` |
| `protocol.error` | `{ code: string; message: string }` |

## 7. 命令确认和错误

服务端处理命令的固定顺序：

1. 解析 JSON 和信封。
2. 校验版本、身份、会话、payload 和领域前置条件。
3. 对同一个命令只发送一个 `command.accepted` 或 `command.rejected`。
4. `command.accepted` 只表示进入执行阶段，不表示领域操作已经完成。
5. 最终结果通过带相同 `correlationId` 的领域事件发布。

现有实现中“先 accepted，随后又 rejected”的行为必须移除。

```ts
interface CommandAcceptedPayload {
  commandId: string;
  acceptedAt: string;
}

interface CommandRejectedPayload {
  commandId?: string;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, JsonValue>;
  currentRevision?: number;
}

type ErrorCode =
  | "INVALID_MESSAGE"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_COMMAND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "INVALID_PAYLOAD"
  | "INVALID_STATE"
  | "REVISION_CONFLICT"
  | "VARIABLES_LOCKED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "RUN_BUSY"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";
```

`protocol.error` 仅用于无法识别为合法命令的帧；如果可以读取命令 `id`，应优先返回 `command.rejected`。

## 8. 顺序、幂等和并发

### 8.1 命令顺序

- 同一连接的上行命令必须按接收顺序串行进入状态机；现有 `WebSocketChannel.incoming` 行为保留。
- 长任务不能阻塞后续的 `run.pause`、`run.interrupt` 和 `chat.response.cancel`。通道串行化只覆盖命令验收和状态变更，不等待模型或工具任务完成。

### 8.2 幂等

- `ClientCommand.id` 是幂等键。
- 服务端至少在会话存活期和断线恢复窗口内保存命令结果。
- 重复命令不得再次改变状态；服务端重发原始 accepted/rejected，并可重放已产生的领域事件。
- `clientMessageId` 防止网络重试创建重复用户消息。

### 8.3 Revision

变量、模板、工具清单和经验清单各自维护独立、严格递增的 revision。

- 写命令的 `baseRevision` 等于服务端当前 revision：执行并发布新 revision。
- 不相等：拒绝为 `REVISION_CONFLICT`，返回 `currentRevision`。
- 前端收到冲突后先同步该领域最新状态，再由用户决定是否重试；不得静默覆盖。

## 9. 断线恢复

### 9.1 建连

- 新会话连接 `/ws/runtime`，服务端创建会话并发送 `session.attached`，随后发送 `runtime.snapshot`。
- 恢复会话连接 `/ws/runtime?sessionId=...&lastSequence=...`。
- `sessionId` 不是认证凭据。认证使用安全 Cookie 或 `Sec-WebSocket-Protocol`，禁止把访问令牌放入 URL。

`session.attached` 示例载荷：

```json
{
  "protocolVersion": 1,
  "resumeMode": "replay",
  "serverTime": "2026-07-22T08:30:12.345Z"
}
```

`resumeMode` 为 `new`、`replay` 或 `snapshot`。

### 9.2 事件重放

- 服务端能重放时，发送所有 `sequence > lastSequence` 的事件。
- 事件历史不可用时，先发送 `session.resync.required`，再发送最新 `runtime.snapshot`。
- 前端丢弃 `sequence <= lastAppliedSequence` 的重复事件。
- 前端发现 sequence 缺口时停止应用后续领域事件并发送 `runtime.snapshot.get`。
- 收到快照后以 `lastSequence` 为新基线，原子替换本地运行时状态。

前端在收到 `session.attached` 和恢复完成前不得发送状态修改命令。

## 10. 流控和安全

- 服务端为每个连接维护有界发送队列；队列溢出时优先触发 `session.resync.required`，不能无限占用内存。
- 对话 delta 建议每帧不超过 16 KiB，并保持 `chunkIndex` 连续。
- 服务端必须限制命令频率、模板长度、变量总大小、经验长度和单次补丁操作数量。
- 每条命令都必须校验用户对 `sessionId` 的访问权限。
- 日志默认记录 `id/type/sessionId/runId/code/duration`，不得直接记录完整对话、模板、变量或工具参数。
- 关闭码建议：`1000` 正常关闭，`1008` 鉴权或策略错误，`1009` 消息过大，`1011` 服务端内部错误。

## 11. 事件示例

### 11.1 发送消息与流式回复

```json
{
  "version": 1,
  "kind": "command",
  "id": "cmd_chat_01",
  "type": "chat.message.send",
  "sessionId": "ses_01",
  "timestamp": "2026-07-22T08:30:12.345Z",
  "payload": {
    "clientMessageId": "msg_client_01",
    "content": [{ "type": "text", "text": "分析当前页面布局" }],
    "autoStart": true
  }
}
```

```json
{
  "version": 1,
  "kind": "event",
  "id": "evt_105",
  "type": "chat.assistant.delta",
  "sessionId": "ses_01",
  "runId": "run_01",
  "sequence": 105,
  "timestamp": "2026-07-22T08:30:13.120Z",
  "correlationId": "cmd_chat_01",
  "payload": {
    "messageId": "msg_assistant_01",
    "channel": "thinkingSummary",
    "chunkIndex": 0,
    "delta": "正在检查布局层级和可用空间。"
  }
}
```

```json
{
  "version": 1,
  "kind": "event",
  "id": "evt_106",
  "type": "chat.assistant.delta",
  "sessionId": "ses_01",
  "runId": "run_01",
  "sequence": 106,
  "timestamp": "2026-07-22T08:30:13.220Z",
  "payload": {
    "messageId": "msg_assistant_01",
    "channel": "final",
    "chunkIndex": 0,
    "delta": "当前页面由三个可调整区域组成。"
  }
}
```

### 11.2 暂停与状态更新

```json
{
  "version": 1,
  "kind": "event",
  "id": "evt_120",
  "type": "run.state.changed",
  "sessionId": "ses_01",
  "runId": "run_01",
  "sequence": 120,
  "timestamp": "2026-07-22T08:30:15.000Z",
  "correlationId": "cmd_pause_01",
  "payload": {
    "runId": "run_01",
    "mode": "continuous",
    "status": "paused",
    "currentStep": 4,
    "currentStepId": "step_tool_04",
    "variablesEditable": true,
    "updatedAt": "2026-07-22T08:30:15.000Z"
  }
}
```

### 11.3 变量更新

```json
{
  "version": 1,
  "kind": "event",
  "id": "evt_124",
  "type": "variables.updated",
  "sessionId": "ses_01",
  "runId": "run_01",
  "sequence": 124,
  "timestamp": "2026-07-22T08:30:16.000Z",
  "correlationId": "cmd_variables_01",
  "payload": {
    "baseRevision": 12,
    "revision": 13,
    "patch": [
      {
        "op": "replace",
        "path": "/task/title",
        "value": "分析新的页面布局"
      }
    ],
    "source": "user"
  }
}
```

### 11.4 渲染结果

```json
{
  "version": 1,
  "kind": "event",
  "id": "evt_130",
  "type": "render.result.updated",
  "sessionId": "ses_01",
  "runId": "run_01",
  "sequence": 130,
  "timestamp": "2026-07-22T08:30:17.000Z",
  "payload": {
    "content": "# 分析新的页面布局\n\n你是 **capybara**。",
    "format": "markdown",
    "templateRevision": 8,
    "variablesRevision": 13,
    "renderedAt": "2026-07-22T08:30:17.000Z",
    "diagnostics": []
  }
}
```

## 12. 运行状态转换

| 当前状态 | 命令 | 下一状态 | 说明 |
| --- | --- | --- | --- |
| `idle` / `ready` | `run.start` | `running` | 创建新 `runId` |
| `paused` | `run.resume` | `running` | 继续当前运行 |
| `ready` / `paused` / `interrupted` | `run.step` | `paused` | 完成一个步骤后暂停 |
| `running` / `waiting` | `run.pause` | `paused` | 到达安全点后发布 |
| `running` / `waiting` | `run.interrupt` | `interrupted` | 保留最后检查点 |
| `interrupted` | `run.restorePrevious` | `paused` | 恢复到上一提交步骤 |
| 任意未终态 | `run.cancel` | `cancelled` | 不可恢复 |
| `running` | `run.mode.set` | 拒绝 | 返回 `INVALID_STATE` |

非法转换必须返回 `command.rejected`，不得静默忽略。

## 13. 现有协议迁移

当前后端的 `id/type/payload`、`sequence/timestamp/correlationId` 可以保留并扩展，无需更换基础传输实现。

| 当前类型 | v1 类型 | 迁移动作 |
| --- | --- | --- |
| `input.append` | `chat.message.send` | 一个发布周期内保留别名 |
| `run.start` | `run.start` | 补齐标准信封和 payload |
| `run.step` | `run.step` | 保持 |
| `run.resume` | `run.resume` | 保持 |
| `run.pause` | `run.pause` | 保持 |
| `run.interrupt` | `run.interrupt` | 保持 |
| `run.cancel` | `run.cancel` | 保持 |
| `state.get` | `runtime.snapshot.get` | 返回完整快照，不只返回 loop state |
| `loop.state.changed` | `run.state.changed` | 使用完整 `RunState` |
| `input.queued` | `chat.user.created` | 使用消息领域模型 |

迁移顺序建议：

1. 扩展信封并修正 accepted/rejected 互斥语义。
2. 实现 `runtime.snapshot`、会话级 sequence 持久化和重连重放。
3. 接入运行状态、变量和模板 revision。
4. 接入对话流式事件、时间线、工具和经验更新。
5. 删除旧类型别名并将协议版本提升到下一主版本。

## 14. 完整性检查

相对于页面现有交互，本文补充了以下容易遗漏的通信：

- 对话回复的 started/delta/completed/failed 生命周期与取消命令。
- 调试模式切换、启动、单步、恢复上一步、取消运行。
- 时间线步骤和运行环境状态更新。
- 命令 accepted/rejected、标准错误码和 `correlationId`。
- 初始全量快照、断线重连、事件重放和重同步。
- 命令幂等、服务端事件顺序、revision 冲突处理。
- 运行时工具清单与资源区工具定义之间的职责边界。
- 心跳、消息大小、流控、鉴权和敏感内容日志约束。
