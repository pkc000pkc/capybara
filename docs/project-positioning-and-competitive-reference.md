# 项目定位与竞品参考

> 状态：战略参考，不代表功能已经全部实现。<br>
> 最近评审：2026-07-29

## 定位

Capybara 不定位为通用 Agent 框架，也不承接具体 Agent 的业务实现和调优工作。它是面向 Agent 开发者的本地 Agent IDE、上下文调试器和运行时实验台：

> Chrome DevTools for Agents

平台重点解释和控制 Agent 如何运行，包括 Prompt 和 Context 的形成、工具结果的回写、Harness 的装载、Loop 生命周期以及运行中的暂停和调试。

## 相近项目与差异

| 类别 | 代表项目 | 主要能力 | Capybara 的差异 |
| --- | --- | --- | --- |
| Agent Runtime 与编排 | LangGraph、Google ADK | 状态图、持久执行、工作流、HITL、部署 | 不竞争生产编排能力，重点展示并调试每次真实模型上下文 |
| TypeScript Agent 全栈框架 | Mastra | Agent、Workflow、Memory、RAG、MCP、Eval、Studio | 最直接的参照；Capybara 需要在上下文来源、运行中控制和资源热更新上做得更深 |
| 多 Agent 编排 | AutoGen Studio | Team、Agent 协作和可视化配置 | 不以多 Agent 拓扑为核心；AutoGen 当前主要作为历史参照 |
| 可视化应用构建 | Dify、Flowise | 工作流、RAG、模型和工具集成、应用发布 | 服务开发者诊断运行机制，不以快速交付最终 Agent 应用为目标 |
| LLM 可观测与评测 | Langfuse、Phoenix | Trace、Prompt 管理、Dataset、Eval、Metrics | 不只回看已经发生的调用，还应拥有暂停、单步、修改和恢复运行的控制权 |

## 核心竞争力

### 1. 上下文透明化

开发者应能看到每次真实提交给模型的消息、工具 Schema、Tool Result、Harness、动态变量、缺失变量和内容来源，而不只是聊天记录或模型调用摘要。

### 2. 运行中调试

调试能力包括暂停、单步、连续执行、中断、断点、检查点恢复和上下文回放。重点是修改状态后继续运行，而不只是运行结束后的 Trace 查看。

### 3. Prompt 和 Harness 项目化

Prompt 不硬编码在平台中。模板、系统变量、工具和 Harness 都是项目资源，支持编辑、保存、监听、重新渲染和版本追踪。

Harness 按模型、工具和任务经验分类，并记录自动装载的匹配原因、来源和最终渲染 Artifact。

### 4. 服务端权威生命周期

WebSocket 协议承载 Loop 状态、上下文快照、工具调用、模型调用和调试命令。服务端是状态的唯一权威来源，前端不自行推导运行结果。

### 5. 本地优先和项目隔离

项目配置、模板、Harness、工具和 SQLite 会话存放在项目的 `.capybara` 目录。用户偏好和项目配置分离，适配私有代码库、敏感 Prompt 和企业内部 Agent 开发。

## 当前差距

- Mastra 的框架完整度、生态、文档和 Studio 体验更成熟。
- LangGraph 的生产运行、状态编排、检查点和社区基础更强。
- Langfuse 和 Phoenix 的 Trace、Eval 和团队观测能力更成熟。
- Dify 和 Flowise 对非专业用户更友好，应用交付链路更完整。
- 当前运行时仍主要绑定内置 `RuntimeLoop`，尚缺少外部 Agent Runtime Adapter。
- `RuntimeLoop` 职责已经偏多，需要继续拆分平台控制面与 Agent 执行实现。
- 前后端协议类型存在手工同步风险，公开协议和 SDK 尚未稳定。
- Experiments、Memory 和 Context Compression 尚未形成完整闭环。
- 版本发布和开源贡献流程仍需建设。

## 后续取舍原则

1. 优先建设 Runtime Adapter，使 LangGraph、Mastra、ADK 和自研 Loop 可以接入统一调试协议。
2. 深化 Context Inspector，解释每段上下文的来源、加入时间、版本和 Token 占用。
3. 完成断点、单步、状态修改、检查点恢复和可重复回放。
4. 稳定 Runtime Protocol、Tool Manifest、Harness Manifest 和配套 SDK。
5. 让 Experiments 使用真实会话、数据集和 Prompt 版本进行回归比较。
6. 不以堆叠浏览器、任务调度、多 Agent 编排和通用 Memory 等能力与 Agent 框架正面竞争。

## 判断标准

每项新功能进入主框架前，应回答以下问题：

- 是否提高 Agent 运行过程的透明度？
- 是否提高运行时的可控制性或可复现性？
- 是否属于可替换的项目资源或外部扩展，而不是平台内置业务 Prompt？
- 是否能服务多个 Agent Runtime，而不是进一步绑定内置 Loop？
- 是否让开发者更快定位 Prompt、Context、Tool 或生命周期问题？

如果答案均为否，该功能通常不属于 Capybara 的核心边界。
