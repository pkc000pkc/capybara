# V2 项目应用容器运行规范

日期：2026-11-11

## 1. 设计目标

项目应用是 Agent 在项目中生成的独立应用产物。它有自己的源码、构建结果、版本和运行实例；系统负责把经过验证的应用版本放入本地应用容器，以子进程方式启动、探活、停止、更新、回滚和回放。

应用的业务代码属于应用自身。应用的生命周期、进程、权限、地址、健康状态和运行证据属于系统。Agent 通过能力和结构化协议提出应用动作，系统容器决定如何执行并记录结果。

运行链路采用以下关系：

```text
项目源码 / Agent 生成内容
        ↓
Application Manifest
        ↓
构建与验证
        ↓
不可变 Application Version
        ↓
System Application Container
        ↓
受控子进程 Application Instance
        ↓
Loopback HTTP / Electron 应用窗口
```

## 2. 术语和身份

| 对象 | 说明 | 稳定身份 |
| --- | --- | --- |
| Project | 用户打开的本地工作目录 | `projectId` |
| Application | 项目中的一个独立应用 | `applicationId` |
| Application Version | 某次源码快照和构建结果 | `versionId` |
| Application Instance | 某个版本的一次运行 | `instanceId` |
| Application Process | Instance 对应的 OS 子进程及其进程树 | `processId` / `pid` |
| Application Container | 系统维护的应用生命周期边界 | `containerId` |
| Application Artifact | 可启动版本的不可变文件集合 | `artifactHash` |

`applicationId`、`versionId` 和 `instanceId` 不由页面生成。它们由系统在登记、构建和启动时分配，并写入 Application Manifest、Trace、Receipt 和 Evidence。

## 2.1 产品形态：Capybara Browser App

项目应用默认是普通 Web 应用。Agent 可以按自己的技术栈生成页面、组件、状态、交互、API 和数据库；Capybara 通过本地子进程和 Electron `WebContentsView` 提供运行、托管、观察和显示能力。

```text
标准 Web 页面与应用服务
        ↓ localhost / REST / WebSocket
ApplicationProcessSupervisor
        ↓ Action / Receipt / Evidence
Runtime、浏览器、文件、数据、代码和应用服务
```

这带来两个同时成立的目标：

- 页面表达和交互由 Agent 充分发挥，应用可以生成不同的业务界面、工作流和数据视图；
- 文件、网络、凭据、代码、进程和外部副作用由系统边界统一控制，应用只能在自己的进程、数据目录和允许地址内运行。

“可控”约束的是能力边界和证据链，不是页面创意。应用可以组合内置组件、定义自有状态和动作，也可以申请新的系统能力；能力是否执行由系统权限和运行协议决定。

## 3. 分层边界

### 3.1 应用源码层

应用源码仍然是项目中的独立标准 Web 应用，可以由 Agent 创建和维护。应用可以包含前端、后端、脚本、资源和依赖，源码可以位于项目根目录，也可以由 manifest 指定一个相对目录。`.capybara` 不属于应用源码输入，不能被打包进运行版本。

源码层保存：

- 前端、后端和资源文件；
- `package.json`、锁文件和构建配置；
- 应用生成历史对应的 SourceRef；
- 用户可读的 README、测试和启动说明。

应用按照普通 Web 约定读取 `PORT`、访问自己的 API、使用自己的数据库，并通过系统分配的数据目录保存运行数据。需要接入系统能力时，可以选择使用受限桥接层；桥接层不是普通页面运行的前置条件。

源码层不保存运行实例的 PID、动态端口或当前进程状态。

### 3.2 版本层

构建过程从源码层生成不可变版本。版本目录只允许系统写入，运行时只读。每个版本必须保存源码树哈希、manifest 哈希、构建产物哈希、构建日志引用和验证结果引用。

只有通过构建、类型检查、测试、可加载检查和最小健康检查的版本，才能进入可启动状态。版本内容在启动后不被原地修改；应用更新通过新版本和新实例完成。

### 3.3 系统容器层

系统容器由 Electron 主进程中的 Application Container Supervisor 管理。它拥有：

- 子进程创建和回收；
- 项目路径到应用版本目录的映射；
- 动态端口分配；
- 环境变量过滤；
- 健康检查和状态迁移；
- stdout、stderr、退出码和信号收集；
- 应用窗口与实例地址的绑定；
- 重启后的实例恢复和未知状态处理。

后端 `ApplicationRuntimeService` 负责版本生命周期、Work Ledger、Receipt 和 Evidence 的业务协议；主进程 Supervisor 负责真实 OS 进程。两者通过带有 `projectId / applicationId / versionId / instanceId / processId` 的结构化动作和结果连接，不能各自维护一套相互矛盾的运行状态。

### 3.4 应用实例层

实例是某个版本在某个时间点的一次运行。实例拥有自己的数据目录、端口、环境变量和进程记录。多个版本可以依次运行，多个实例是否允许并行由 manifest 的实例策略决定。

实例进程使用 `shell: false` 启动，工作目录指向版本 artifact，不直接以项目根目录作为当前目录。系统保存进程树标识，停止时按树回收，不依赖按名称批量结束进程。

默认应用实例由系统启动普通 Web 服务，再由 `WebContentsView` 加载 localhost 页面。需要计算、数据处理或长期任务时，可以声明受控 Worker；Worker 仍由 System Application Container 以子进程管理，并只能使用 manifest 声明的环境、目录和端口。

## 4. 项目内存储布局

项目 `.capybara` 负责项目应用的系统数据，建议采用以下布局：

```text
<project>/.capybara/
  applications/
    <applicationId>/
      manifest.json
      source.json
      versions/
        <versionId>/
          manifest.json
          checks.json
          build-receipt.json
          logs/
      instances/
        <instanceId>/
          instance.json
          stdout.log
          stderr.log
          health.jsonl
          runtime-receipt.json
      current.json
  context/
  logs/
  sessions.sqlite
```

系统用户 `.capybara` 继续保存全局模型配置、凭据、项目登记和系统日志。不可变 artifact 存放在系统用户的独立 artifact store 中，项目版本目录只保存 artifact hash 和版本元数据；应用进程的工作目录不在项目源码树内。

```text
<user>/.capybara/
  application-artifacts/
    <projectKey>/<applicationId>/versions/<versionId>/artifact/
```

## 5. Application Manifest

现有 Application Manifest 保留页面、数据绑定、动作、权限、版本和运行指针；新增或规范化 `runtime` 部分：

```json
{
  "schemaVersion": 1,
  "appId": "notes-app",
  "projectId": "project:...",
  "source": {
    "root": ".",
    "conversationId": "session:...",
    "instructionId": "message:...",
    "runId": "turn:..."
  },
  "ui": {
    "kind": "browser-app",
    "entry": "index.html",
    "routes": ["/", "/notes/:id"],
    "componentSet": "capybara-workbench-v1"
  },
  "capabilities": [
    { "id": "project-data", "scope": "project", "permission": "data:read-write" },
    { "id": "browser-gateway", "scope": "session", "permission": "browser:read" }
  ],
  "runtime": {
      "kind": "browser-app",
    "adapter": "capybara-host",
    "start": {
      "command": "node",
      "args": ["server/index.js"],
      "shell": false
    },
    "workingDirectory": ".",
    "bind": "127.0.0.1",
    "port": { "mode": "dynamic", "environment": "PORT" },
    "health": {
      "path": "/health",
      "method": "GET",
      "readyStatus": [200],
      "timeoutMs": 3000,
      "intervalMs": 500,
      "startupTimeoutMs": 30000
    },
    "stop": { "graceMs": 5000, "tree": true },
    "dataDirectory": ".capybara/applications/notes-app/data",
    "network": { "mode": "capability-only" },
    "workers": []
  }
}
```

### Manifest 约束

- `command` 是可执行文件名，`args` 是参数数组，不接受 shell 拼接字符串；
- `workingDirectory` 必须是 artifact 内的相对路径；
- `bind` 默认只能是 loopback 地址；
- `port` 由系统分配，应用从 `PORT` 读取，不自行占用固定端口；
- `health.path` 是启动完成的必要证据；
- `dataDirectory` 与版本 artifact 分离，更新版本不覆盖用户数据；
- 应用只能使用 manifest 声明的权限和环境变量；
- manifest 中不能出现 API Key、系统凭据或绝对路径。
- Node/Python 运行时注入路径边界，只允许访问 artifact、应用数据目录、实例临时目录和语言运行时目录；
- 应用进程的当前目录和版本 artifact 不在项目源码树内，项目源码不作为运行时工作目录。

### Browser App 约束

- 页面通过系统 `WebContentsView` 加载，不直接创建 Electron 窗口；
- 应用可以使用 React、Vue、HTML、TypeScript、JavaScript、Node.js、Python、SQLite、REST 和 WebSocket；
- 应用进程使用系统分配的 `PORT`、工作目录和数据目录；
- 应用不能读取系统 API Key、Electron 内部环境或其他项目目录；
- 浏览器只能导航到 manifest 允许的 loopback 地址；
- 应用的启动、停止、健康、构建、更新和回滚由系统记录 Receipt、Evidence 和 Trace；
- 需要长期任务或独立计算时，可以声明受控 Worker，由系统容器托管；
- 可选桥接层用于访问系统能力，但不改变普通 Web 应用的运行方式。

## 5.1 内置能力模型

系统能力是 Browser App 的扩展面。能力由系统提供适配器，应用可以通过系统面板或可选桥接层调用；能力内部可以由 Electron 主进程、后端 RuntimeLoop、浏览器网关或受控 Worker 完成。

首批能力按以下类别组织：

| 能力类别 | 示例 | 应用可见结果 |
| --- | --- | --- |
| 项目数据 | `data.query`、`data.mutate`、`data.import` | 结构化数据、Receipt、变更摘要 |
| 文件资料 | `files.list`、`files.read`、`files.write` | 文件结果、前后哈希、权限状态 |
| 浏览器 | `browser.read`、`browser.open` | 页面快照、来源、内容哈希 |
| 市场研究 | `market.quote`、`market.reports` | 数据来源、时间、证据集合 |
| 代码分析 | `code.run`、`code.test` | stdout、退出码、进程记录 |
| 应用服务 | `app.worker.invoke`、`app.job.status` | 任务状态、结果 Artifact |
| 用户交互 | `permission.request`、`user.confirm` | 明确授权和等待状态 |

能力定义包含输入 schema、输出 schema、权限级别、风险、可逆性、证据类型、超时和取消语义。应用只看到 SDK 的稳定接口，不依赖具体宿主实现。

### 能力扩展和自由发挥

当内置能力不能覆盖需求时，Agent 可以生成新的能力适配器或 App Worker，但仍遵循同一个注册协议：

```text
能力声明
  ↓
输入 / 输出 schema
  ↓
权限和数据范围
  ↓
实现或 Worker
  ↓
测试、健康检查和证据
  ↓
安装到应用版本
```

扩展能力可以增加业务表达能力，但不能获得隐式的系统权限。新的能力必须声明自己的数据范围、外部副作用、失败状态和可回滚方式，才能被 Browser App 使用。

## 6. 构建和版本流程

```text
source snapshot
  ↓
normalize manifest
  ↓
install / resolve dependencies
  ↓
typecheck
  ↓
build
  ↓
test
  ↓
loadability check
  ↓
artifact hash
  ↓
health-capable version
  ↓
stage version
```

构建输出形成 `versionId`。`versionId` 至少关联：

- `sourceTreeHash`；
- `manifestHash`；
- `artifactHash`；
- build/typecheck/test 的 Receipt；
- 生成该版本的 `turnId`、`stepId` 和 instruction SourceRef；
- parentVersionId 和语义 diff。

源码目录可以继续被 Agent 编辑，但运行实例只能读取版本 artifact。这样可以避免 Agent 正在修改文件时，正在运行的应用被半写入状态影响。

## 7. 容器生命周期

应用版本和应用实例分开管理。

### 7.1 版本状态

```text
draft
  → generated
  → verified
  → published
  → deployed
```

版本构建失败进入 `error`；已运行版本被新版本替换时进入更新流程，失败时保留旧版本作为回滚目标。

### 7.2 实例状态

```text
stopped
  → starting
  → health_checking
  → running
  → degraded
  → stopping
  → stopped
```

异常路径进入 `error` 或 `unknown`。`unknown` 表示系统尚未确认 OS 进程是否已经退出或健康状态是否成立，不能直接显示为已停止或已完成。

### 7.3 系统动作

应用运行能力统一使用以下操作：

```text
preview(versionId)
build(sourceRef)
deploy(versionId)
start(versionId)
health_check(instanceId)
stop(instanceId)
restart(instanceId | versionId)
update(currentVersionId, newVersionId)
rollback(failedVersionId, targetVersionId)
open(instanceId)
```

每个操作形成一个 Action、一个 Receipt 和至少一条 Evidence。运行类操作还要形成 Application Process Record 和 Runtime Trace。

## 8. 子进程运行契约

### 8.1 App Worker 契约

App Worker 是 Browser App 的可选后端或计算子进程。它解决复杂数据处理、长任务、兼容既有 Node 服务以及需要独立生命周期的场景，同时保持系统对进程和能力的控制。

Worker manifest 增加：

```json
{
  "workerId": "notes-worker",
  "entry": "server/index.js",
  "protocol": "http-json",
  "port": { "mode": "dynamic", "environment": "PORT" },
  "health": { "path": "/health" },
  "capabilities": ["project-data"],
  "dataDirectory": ".capybara/applications/notes-app/data"
}
```

Worker 的 HTTP API 默认只绑定 loopback，并由 Browser App 和系统能力代理访问。Worker 不能读取父进程的完整环境，也不能直接持有系统模型凭据。

Worker 结果必须经过 Host 归一化为结构化结果；Worker 自己输出的“成功”文本不构成系统完成证据。Worker 的请求、响应、退出、超时和健康检查都写入同一个 Application Trace。

### 8.2 启动环境

系统只注入应用运行需要的非秘密变量：

```text
CAPYBARA_APP_ID
CAPYBARA_APP_VERSION
CAPYBARA_INSTANCE_ID
CAPYBARA_PROJECT_ID
CAPYBARA_RUN_ID
PORT
CAPYBARA_DATA_DIR
```

系统用户环境中的模型 Key、代理凭据和桌面内部令牌不得继承到应用进程。应用所需的外部服务凭据应由明确能力提供，不能从父进程环境隐式继承。

### 8.3 输出和事件

stdout、stderr 是应用诊断输出，不直接当作事实。系统记录原始输出、截断状态和内容哈希。应用可以输出受限 JSON Lines 事件，例如：

```json
{
  "type": "application.ready",
  "instanceId": "instance:...",
  "port": 4317,
  "healthPath": "/health"
}
```

系统仍以自己的端口分配和 HTTP health check 为最终 Ready 证据。应用输出不能自行宣布“已部署”或“任务完成”。

### 8.4 停止和回收

停止流程：

```text
停止请求
  ↓
标记 stopping
  ↓
发送温和终止信号
  ↓ graceMs
检查进程树
  ↓
回收本实例进程树
  ↓
确认端口释放和进程退出
  ↓
写入 stopped / unknown Receipt
```

回收必须绑定 `processId / instanceId`。不按进程名、固定端口或模糊命令行批量结束进程。

## 9. 能力、权限和数据边界

应用运行是 `application-runtime` 能力的一部分，但应用实例本身不是 Agent。Agent 只能提议应用动作；Runtime 和 Supervisor 共同完成权限校验。

权限至少分为：

| 权限 | 含义 |
| --- | --- |
| `app:read` | 读取应用版本和实例状态 |
| `app:preview` | 生成或查看预览版本 |
| `app:build` | 执行构建检查并创建 artifact |
| `app:start` | 启动本地实例 |
| `app:stop` | 停止本实例 |
| `app:network` | 使用声明的外部网络能力 |
| `app:filesystem` | 使用应用数据目录或声明的项目读范围 |
| `app:update` | 切换正在运行的版本 |
| `app:rollback` | 回退到已验证版本 |

应用窗口只能打开系统已经确认 Ready 的 loopback 地址。系统不会把应用地址、端口或进程状态伪装成应用已经完成；页面展示的状态来自 Supervisor 快照和健康证据。

## 10. 统一事件和证据协议

应用相关事件沿用 V2 Runtime 的关联字段：

```text
sessionId
turnId
stepId
callId
sequence
timestamp
projectId
applicationId
versionId
instanceId
processId
```

核心事件：

```text
application.version.created
application.build.started
application.build.completed
application.build.failed
application.instance.starting
application.process.started
application.health.checking
application.health.passed
application.health.failed
application.process.exited
application.instance.stopped
application.instance.unknown
application.version.updated
application.rollback.completed
application.window.opened
```

### Start Receipt 最小字段

```json
{
  "operation": "start",
  "projectId": "project:...",
  "applicationId": "notes-app",
  "versionId": "version:...",
  "instanceId": "instance:...",
  "processId": "process:...",
  "pid": 12345,
  "address": "http://127.0.0.1:4317",
  "artifactHash": "sha256:...",
  "healthCheckRef": "health:...",
  "status": "succeeded",
  "sideEffect": "local-reversible"
}
```

这条 Receipt 不能替代 health Evidence；只有 health 通过后，实例才进入 `running`，应用窗口才允许打开。

## 11. 应用面板和窗口行为

项目应用面板展示的是实例状态，不是静态演示状态：

- 版本：当前 preview、deployed、running version；
- 实例：stopped、starting、running、degraded、error、unknown；
- 进程：PID、启动时间、退出码、当前进程阶段；
- 地址：系统分配的 loopback 地址；
- 健康：最近一次检查时间、耗时、状态和 Evidence；
- 版本差异：当前版本与待更新版本的 source/artifact hash 和语义 diff；
- 操作：预览、启动、停止、重启、更新、回滚、打开应用。

“打开应用”只执行窗口打开动作，不隐式启动未验证版本。窗口关闭不等于实例停止；实例生命周期由 Supervisor 继续管理，用户可以在面板中明确停止。

## 12. 恢复和崩溃处理

Electron 或系统服务重新启动后，Supervisor 从 instance.json 和进程记录恢复：

1. 检查记录中的 PID/进程树是否仍存在；
2. 检查记录中的地址是否由当前实例占用；
3. 执行 health check；
4. 根据证据进入 `running`、`stopped`、`degraded` 或 `unknown`；
5. 写入恢复事件，不自动重放 Agent 的应用动作；
6. 是否自动重启由 manifest 的 restart policy 和当前权限决定，并产生独立 Receipt。

应用进程崩溃时保留 stdout、stderr、退出码、信号、最后健康检查和 artifact hash。下一次启动使用已验证版本，不从正在修改的源码目录直接启动。

## 13. 与现有实现的衔接

现有实现中的对象可以按以下方式归位：

| 现有对象 | 容器规范中的位置 |
| --- | --- |
| `ApplicationManifest` | 应用声明和版本入口 |
| `ApplicationVersionLifecycle` | 版本状态与版本指针 |
| `ApplicationRuntimeService` | Action、Receipt、Evidence 和业务生命周期 |
| `ApplicationRuntimeService.startHosted/stopHosted/...` | 将真实 Host 结果回写到同一套生命周期、Work Ledger 和 Evidence |
| `LocalDashboardHost` | 兼容旧应用的逻辑 Host；标准 Browser App 由真实实例地址替代 |
| `ApplicationProcessSupervisor` | Electron 主进程中的构建、启动、探活、停止、更新、回滚和恢复 |
| `ApplicationHostAdapter` | RuntimeLoop 的 `manage_application` 工具到 Supervisor 的结构化桥接 |
| `ApplicationBrowserHost` | Electron `WebContentsView` 的地址校验、加载、导航、崩溃和布局管理 |
| Electron `openApplication` | 只打开已经健康通过的实例，并嵌入主窗口的 WebContentsView |
| `runtime.processes.updated` | Agent 工具进程的统一快照；应用实例另有 PID、端口和实例 Trace |
| 项目 `.capybara/applications` | 应用 manifest、版本、实例和日志存储边界 |
| Workbench 运行上下文 | 展示应用版本、实例、进程、健康、Receipt 和 Evidence |

当前施工代码位置：

- `apps/workbench/electron/application-process-supervisor.cjs`
- `apps/workbench/electron/application-browser-host.cjs`
- `apps/workbench/electron/application-host-adapter.cjs`
- `apps/workbench/electron/application-path-guard.cjs` / `application-path-guard.py`
- `apps/workbench/electron/runtime-v2.cjs` 中的 `manage_application`
- `apps/workbench/test/application-process-supervisor.test.cjs`
- `apps/workbench/test/application-browser-host.test.cjs`

当前项目生成的独立 CRUD 应用可以直接作为 Browser App：React 页面和 SQLite/REST 服务都保留普通项目结构，系统为服务分配 `PORT`，调用健康接口，再由 `WebContentsView` 加载页面。对于暂时只有一个 Node 服务的旧应用，可以通过 Manifest 兼容运行；需要系统能力时再增加可选桥接层。

## 13.1 三个应用复杂度层级

为了兼顾可控性和发挥空间，应用按能力层级扩展，而不是直接暴露任意 OS 权限：

| 层级 | 组成 | 适合场景 |
| --- | --- | --- |
| L0 | Browser App 页面 + 本地状态 | 展示页、看板、表单、轻量工作流 |
| L1 | Browser App + 内置系统能力 | 文件资料、浏览器调研、数据查询、会话工作台 |
| L2 | Browser App + App Worker + 自定义能力适配器 | CRUD 应用、长任务、复杂分析、领域服务 |

L0 和 L1 可以只运行页面，也可以按需要声明服务；L2 再增加 Worker 或自定义能力适配器。三层都使用同一套 manifest、权限、Trace、Receipt 和 Evidence，因此复杂度增加时，系统边界不改变。

## 13.2 前端自由度

Browser App 可以自由定义：

- 页面结构、导航、布局和交互流程；
- 领域组件和可视化组件；
- 表单校验、状态机和本地草稿；
- 多步骤任务、结果卡片、时间线和数据视图；
- 应用自己的视觉主题和信息层级。

系统统一约束：

- 系统能力调用必须经过系统提供的桥接或宿主入口；
- 真实数据必须来自能力结果，不能由 UI 自行伪造；
- 外部副作用必须有权限和 Receipt；
- 应用页面不能读写系统凭据、绝对路径或任意进程；
- 运行中的实例不能修改自身 artifact。

这样，应用的“长什么样、怎么交互、如何组织任务”可以充分发挥；“能访问什么、写入什么、启动什么、是否完成”由系统统一决定。

## 14. 开工验收标准

设计进入施工前，至少应能够定义并验收以下场景：

1. 从项目源码生成一个版本，保存 manifest hash、artifact hash 和构建 Receipt；
2. 通过系统 Supervisor 启动版本，获得真实 PID、动态端口和健康 Evidence；
3. 在应用面板看到 starting → health checking → running 的完整过程；
4. 应用窗口只能打开健康通过的 loopback 地址；
5. 应用进程退出时看到退出码、stderr、失败阶段和 `process.exited` 事件；
6. 停止实例只回收自己创建的进程树，端口释放后才能进入 stopped；
7. 更新生成新版本和新实例，旧版本仍可作为 rollback target；
8. 更新健康失败时，保留失败 Evidence 并回滚到原 running version；
9. Electron 重启后恢复实例状态，不重复执行原 Agent 工具动作；
10. 应用 Trace 与 Agent 当前 turn 的 `turnId / stepId / callId` 可关联回放；
11. 项目应用、工具 runner 和系统后端进程在 UI 中分开显示；
12. 应用进程不能读取系统模型 Key，应用数据只写入声明的数据目录。
13. Browser App 页面可以在系统 Host 中加载，系统能力调用经过宿主边界，不能绕过进程和权限边界访问 OS；
14. L2 应用可以声明 Worker，Worker 作为系统容器内子进程启动、探活和回收；
15. 同一应用的 UI bundle、Worker 和 manifest 版本一致，更新与回滚不会混用不同版本的 Worker。

## 15. 需要评审的几个决策

1. 应用构建是否统一使用 Node/React/Vite 约定，还是由 manifest 允许多个 runtime adapter；
2. Supervisor 是否长期放在 Electron 主进程，还是抽成独立的本地 System Runtime 服务；
3. 应用数据目录是否默认位于项目 `.capybara/applications/<appId>/data`，以及是否允许用户选择外部目录；
4. `health` 是否强制要求应用提供 HTTP endpoint，或允许纯桌面/脚本应用提供进程级 readiness；
5. 应用是否允许访问外部网络，网络权限采用全局开关、域名 allowlist 还是按能力逐次授权；
6. 应用更新是否保持单实例切换，还是支持蓝绿实例并行后再切换地址。

