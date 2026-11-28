# V2 本地桌面产品闭环与验收标准

## 产品边界

Capybara V2 是本地 Windows 工作型 Agent。用户从桌面应用选择一个本机目录，目录成为项目的工作边界；项目应用、会话、运行记录和生成内容都围绕这个本地项目持续工作。

目录选择是项目登记动作。登记可以发生在空目录上，不要求先上传目录，也不把目录内容复制到远端。真实路径、目录句柄和文件内容由 Electron 主进程保管，渲染器只持有项目身份、显示信息、空目录状态和一次性的 opaque reference。后续文件观察、读取、写入和进程执行都必须通过受控的本地能力进入运行时。

## 用户闭环

```text
打开本地目录
  ↓
主进程登记项目（空目录也有效）
  ↓
显示项目与工作项
  ↓
用户发送第一条指示
  ↓
空目录按明确动作初始化项目骨架
  ↓
创建或恢复项目会话
  ↓
RuntimeLoop 接收结构化指令
  ↓
模型观察、提议、调用能力并返回证据
  ↓
上下文文档、候选、证据、应用版本和运行记录持续更新
  ↓
用户查看工作结果与项目应用
```

## 桌面边界验收

| 验收项 | 通过条件 |
| --- | --- |
| 空目录登记 | 原生目录选择器可以选择空目录，登记返回项目 ID、名称、空状态和 opaque reference |
| 目录不上传 | 登记阶段不递归扫描、不读取文件内容、不生成上传任务 |
| 路径隔离 | 渲染器消息、页面状态和桥接类型中不出现绝对路径、文件列表或文件内容 |
| 引用校验 | 主进程只接受自己签发的 opaque reference，伪造或过期引用被拒绝 |
| 本地服务 | Electron 启动时复用健康的 3005 服务，否则托管本地后端；退出时回收托管进程 |
| 空目录启动工作 | 第一条明确指示触发本地项目初始化，初始化结果可由文件清单和后续会话观察验证 |
| 非空目录启动工作 | 已有 Capybara 项目的目录可直接创建或恢复会话；普通目录先进入项目检查与初始化流程 |
| 会话连接 | 运行时连接返回 runtime ID 和 session ID，并收到 `session.attached`、`runtime.snapshot` |
| 聊天协议 | 页面只发送结构化 `chat.message.send`，不把项目路径放进模型消息或渲染器协议 |
| 运行结果 | 页面订阅 assistant delta、完成、失败和断开事件，不以“工具已调用”代替结果验证 |
| 退出恢复 | Electron 关闭前关闭运行连接；项目和会话状态由后端持久化后可恢复 |

## 运行时与产品能力验收

1. `ContextDocumentEngine` 负责五区文档、候选与证据治理、语义 diff、revision 和确定性投影。
2. `RuntimeEnvelope` 承载工具、等待、询问、反思、提议 diff 和完成判断；代码层负责状态迁移、权限、证据、Hook 和完成门禁。
3. 项目级上下文与会话级上下文保持不同身份；会话可以引用项目文档，但不能覆盖项目文档的身份或历史。
4. 上下文整理训练样本记录输入上下文、候选提议、审核决定、整理后上下文、范围和运行证据，原始消息与事实不被重写。
5. 浏览器、市场数据、研报下载、本地 Python、应用生成和应用运行都以 capability、Action、Receipt、Evidence 和 Artifact 串联。
   当前本地宿主已提供受限 HTTP 页面读取适配器；交互式 Chromium 点击、输入和截图在没有 Browser Gateway 实例时保持 `unknown`。
6. 股票调研的推荐只产生 `for_review` 结论；缺少来源、证据、分析结果或应用地址时，结果保持 `unknown`，不伪造完成状态。
   默认 market-research 路由可以用本地 project path 运行完整数据、研报、Python、HTML 看板和 open 链路。
7. OpenAI key 只在后端配置中读取；页面和公开设置只显示是否已配置。`gpt-6-luna` 的 Chat Completions 请求使用 `max_completion_tokens` 与 `reasoning_effort=none` 兼容参数。

## 当前回归证据

- Workbench typecheck、静态桌面构建、运行时/桥接/数据测试和 Electron 目录测试通过。
- 上下文、应用运行、市场研究 provider、研究编排和路由聚焦测试通过。
- 空目录真实回归已验证：`empty → initialize → create session → session.attached → runtime.snapshot`。
- 使用本地 key 文件、官方 OpenAI endpoint 和 `gpt-6-luna` 的真实聊天回归返回 `OK`；请求经过本机配置的 HTTPS proxy，key 未进入页面或仓库。
