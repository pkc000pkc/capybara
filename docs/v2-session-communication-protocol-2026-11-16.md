# V2 会话通信协议

日期：2026-11-16

状态：设计基线，供 Runtime、Electron、项目应用和 A2A 共同使用

## 1. 目标

本协议解决四件事：

1. 项目应用可以向指定会话发送信息。
2. 一个会话可以向另一个会话发送信息。
3. 用户可以列出会话、会话职责、当前状态和可接收地址。
4. 所有通信都能进入 SQLite 会话记录和 Runtime Trace，支持实时观察、重连和回放。

协议不把“发送消息”直接等同于“执行任务”。消息先进入收件会话的队列，由会话根据自身职责、权限和当前状态决定接受、排队、转发、拒绝或要求用户确认。

## 2. 统一实体模型

### 2.1 会话类型

```ts
type SessionKind =
  | 'user'          // 用户直接操作的工作会话
  | 'agent'         // 可独立执行任务的 Agent 会话
  | 'child'         // 父会话委派产生的子会话
  | 'application'   // 项目应用代表的通信会话
  | 'system';       // 系统级服务会话
```

应用不是隐式地“写入当前聊天”。应用必须拥有一个稳定的 `application` 会话身份；用户可见的工作 Agent 使用 `user` 或 `agent` 会话身份；A2A 子代理使用 `child` 会话身份。

### 2.2 会话身份

```ts
interface SessionRef {
  projectId: string;
  sessionId: string;
  kind: SessionKind;
  displayName: string;
  role: string;                 // 面向用户的职责短语
  description?: string;         // 可读的完整职责说明
  parentSessionId?: string;     // child/application 委派关系
  ownerSessionId?: string;      // 应用由哪个会话创建或管理
  status: SessionStatus;
  capabilities: SessionCapability[];
  address: SessionAddress;
  createdAt: string;
  updatedAt: string;
  lastActiveAt?: string;
}

type SessionStatus =
  | 'ready' | 'running' | 'waiting' | 'paused'
  | 'awaiting_user' | 'reconnecting' | 'succeeded'
  | 'failed' | 'cancelled' | 'closed' | 'unknown';

type SessionCapability =
  | 'receive_message'
  | 'send_message'
  | 'delegate'
  | 'invoke_tools'
  | 'application_input'
  | 'application_output';

interface SessionAddress {
  canonical: string; // session://projectId/sessionId
  aliases: string[]; // displayName、applicationId 等非唯一别名，仅用于搜索
}
```

`sessionId` 是唯一关联键；`displayName` 和别名只用于展示和检索，不能作为最终投递依据。跨项目发送必须显式声明 `projectId`，默认禁止跨项目投递。

### 2.3 会话目录

Runtime 必须提供项目范围的会话目录快照：

```ts
interface SessionDirectorySnapshot {
  projectId: string;
  revision: number;
  generatedAt: string;
  currentSessionId?: string;
  items: SessionRef[];
}
```

目录至少能列出：

- 会话 ID、名称、类型和职责说明；
- 父子关系和所属应用；
- 当前状态、最近活动时间；
- 是否可收信、是否可发信；
- 可接收的消息类型；
- 最近一次运行的 `runId`、`turnId`（如有）。

目录是发送前的发现接口，不是权限本身。实际发送仍需由 Runtime 做能力门禁和目标状态校验。

## 3. 消息信封

所有应用消息、会话间消息和 A2A 消息都使用同一套信封。消息正文可以是文本、结构化 JSON、文件/产物引用或用户确认请求。

```ts
interface SessionMessageEnvelope<T = JsonValue> {
  protocol: 'capybara.session-message.v1';
  messageId: string;
  projectId: string;
  source: SessionRef;
  target: SessionTarget;
  relation: MessageRelation;
  type: SessionMessageType;
  payload: T;
  correlation: MessageCorrelation;
  delivery: DeliveryOptions;
  authorization: AuthorizationContext;
  createdAt: string;
  expiresAt?: string;
}

type MessageRelation = 'application' | 'direct' | 'a2a' | 'system';

type SessionMessageType =
  | 'chat.message'
  | 'task.request'
  | 'task.result'
  | 'task.status'
  | 'context.request'
  | 'context.update'
  | 'artifact.ready'
  | 'user.confirmation.request'
  | 'user.confirmation.result'
  | 'system.notice';

interface SessionTarget {
  sessionId: string;
  projectId: string;
  expectedRevision?: number;
}

interface MessageCorrelation {
  conversationId?: string;
  runId?: string;
  turnId?: string;
  stepId?: string;
  callId?: string;
  parentMessageId?: string;
  parentSessionId?: string;
  childId?: string;
}

interface DeliveryOptions {
  mode: 'enqueue' | 'interrupt' | 'notify';
  idempotencyKey: string;
  priority?: 'normal' | 'high';
  requireReceipt: boolean;
  allowOfflineQueue?: boolean;
}

interface AuthorizationContext {
  actorSessionId: string;
  capability: SessionCapability;
  requestId: string;
  permissionRevision: string;
}
```

### 3.1 投递模式

- `enqueue`：进入目标会话输入队列，等待其当前轮次结束后处理。
- `interrupt`：只有目标会话明确声明支持中断时可用；先生成中断收据，再进入新消息。
- `notify`：只产生通知，不自动触发 Agent 轮次，适合应用状态和资料更新。

默认使用 `enqueue`。应用不得默认使用 `interrupt`，不得通过消息绕过人工确认或能力门禁。

### 3.2 幂等与顺序

- `messageId` 标识一次消息实体。
- `idempotencyKey` 标识一次投递意图；重复请求返回原投递收据，不重复创建消息。
- 同一目标会话按 `sequence` 单调递增保存；重连时按 sequence 补发。
- 消息状态和投递状态分开保存，避免“已入队”被误显示为“已处理”。

## 4. 收据与事件

### 4.1 投递收据

```ts
interface MessageDeliveryReceipt {
  receiptId: string;
  messageId: string;
  target: SessionRef;
  status: 'accepted' | 'queued' | 'delivered' | 'processing' |
          'completed' | 'rejected' | 'expired' | 'failed';
  sequence?: number;
  reason?: string;
  receivedAt: string;
  deliveredAt?: string;
  completedAt?: string;
  traceRefs: {
    runId?: string;
    turnId?: string;
    stepId?: string;
    callId?: string;
  };
}
```

### 4.2 统一事件

Runtime 向 Electron 和项目应用发布以下事件：

```text
session.directory.updated
session.message.accepted
session.message.queued
session.message.delivered
session.message.processing
session.message.completed
session.message.rejected
session.message.failed
session.message.expired
session.status.changed
```

每个事件必须带 `projectId / sessionId / messageId / receiptId`，并在运行上下文中补充已有的 `runId / turnId / stepId / callId`。事件本身进入会话 Trace，不只通过前端内存转发。

## 5. 应用到会话

应用启动后注册一个 `application` 会话，并通过目录发现可接收的目标：

```text
应用 → session.directory.list(projectId)
应用 → session.message.send({
  source: application session,
  target: session://projectId/sessionId,
  type: task.request | chat.message | artifact.ready,
  delivery: enqueue,
  correlation: { conversationId, ... }
})
Runtime → MessageDeliveryReceipt
Runtime → session.message.* events
```

应用只能代表自身发送消息。应用不能伪造用户会话、父会话、`turnId` 或完成状态；应用产生的结果必须用 `artifact.ready` 或 `task.result` 携带 artifact/evidence 引用。

## 6. 会话到会话

发送前的最小流程：

```text
发送方获取 SessionDirectorySnapshot
  ↓
按 sessionId 选择目标并检查职责/能力/状态
  ↓
提交带 idempotencyKey 的 SessionMessageEnvelope
  ↓
Runtime 校验项目边界、发送权限、目标接收权限和消息类型
  ↓
写入消息表与投递收据
  ↓
目标会话消费并产生 processing/completed/rejected
  ↓
发送方通过 receipt 和 Trace 查询结果
```

“职责说明”只用于发现和路由判断，不能代替权限。目标会话不匹配时应返回 `rejected`，并说明目标职责或能力不满足，而不是静默转发到当前会话。

## 7. 与 A2A 的统一

现有 `delegate_task` 仍可作为 A2A 的高层工具入口，但底层必须映射到本协议：

| A2A 现有概念 | 统一协议字段 |
| --- | --- |
| `childId` | `SessionRef.sessionId`（`kind=child`） |
| 父会话 | `source` 与 `correlation.parentSessionId` |
| 子任务目标 | `type=task.request` 的 `payload.goal` |
| `parentTurnId` | `correlation.turnId` |
| 子代理 `childTurnId` | 目标会话处理时生成的 `correlation.turnId` |
| 父层 `callId` | `correlation.callId` |
| 结果 artifact | `type=task.result` 或 `artifact.ready` 的 payload 引用 |
| 父代理合并 | 父会话消费 `task.result`，生成自己的候选 diff/验证步骤 |

规范要求：

1. `childId`、子会话 `sessionId` 和展示标签必须有一一对应的 canonical 映射。
2. 子会话不能宣布父任务完成，不能扩大父会话权限。
3. 父会话必须通过 `task.result`、artifact 和 evidence 验证后再合并结果。
4. 子会话失败、超时、取消和权限拒绝都必须回传为明确的消息状态。
5. A2A 事件与普通会话消息使用相同的 Trace 关联字段。

## 8. 持久化模型

项目 `.capybara/sessions.sqlite` 增加或等价提供以下逻辑表：

```text
session_directory
  project_id, session_id, kind, display_name, role, description,
  parent_session_id, owner_session_id, status, capabilities_json,
  address_json, revision, created_at, updated_at, last_active_at

session_messages
  message_id, project_id, source_session_id, target_session_id,
  relation, type, payload_json, correlation_json, sequence,
  idempotency_key, created_at, expires_at

session_message_receipts
  receipt_id, message_id, status, reason, received_at, delivered_at,
  completed_at, trace_refs_json
```

消息正文和收据不能只保存在 Renderer 状态或内存队列中。项目关闭、Electron 重启和会话重连后，应能重新列出会话目录、未完成消息和完整投递轨迹。

## 9. Electron IPC 边界

推荐的主进程接口：

```text
capybara:session-directory-list
capybara:session-get
capybara:session-message-send
capybara:session-message-ack
capybara:session-message-list
capybara:session-trace-list
capybara:session-event
```

Renderer 只能提交结构化信封和读取收据；不能直接写 SQLite、修改目标会话状态或伪造 Runtime 事件。应用内嵌页面通过受控 Application Host 调用同一套主进程接口。

## 10. 最小验收场景

1. **应用通知会话**：应用向指定 `sessionId` 发送 `artifact.ready`，目标会话收到并显示收据，消息进入历史记录。
2. **会话直接通讯**：会话 A 按目录中的职责说明选择会话 B，发送 `task.request`；B 完成后 A 收到 `task.result`。
3. **错误目标**：向不存在、已关闭或无接收权限的会话发送，返回明确 `rejected`，不产生幽灵消息。
4. **重复发送**：使用相同 `idempotencyKey` 重试，只返回原收据，不重复执行。
5. **重连回放**：关闭并重启 Electron 后，目录、消息、收据、A2A 父子关系和 Trace 仍可恢复。
6. **A2A 映射**：`delegate_task` 产生一个 canonical child session；父层能按 `parentSessionId → child sessionId → messageId → turnId → artifactId` 查看完整链路。

## 11. 协议边界

协议负责身份、寻址、授权前置校验、投递、状态和回放关联；Runtime 负责是否真正执行任务；工具能力门禁负责文件、浏览器、代码和外部副作用权限；UI 负责展示状态和让用户选择目标，不负责绕过这些边界。
