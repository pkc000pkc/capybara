# Harness 设计草案

> 状态：临时记录，尚未进入实施阶段。前置能力和协议确认完成后再定稿。

## 定位

Harness 是运行时可挂载、可渲染的上下文模块，用于向模型提供模型适配、工具使用方法和任务经验。Harness 本身不执行操作，也不替代 Tool、Skill、Memory 或 Loop。

- Tool：定义可执行能力及参数协议。
- Skill：开发态资源包，可以包含 Harness、工具依赖、参考资料和模板。
- Harness：运行时进入 Prompt 的上下文模块。
- Memory：运行过程中积累和召回的信息。
- Loop：控制模型调用、工具分发、状态变化和退出条件。

后端只管理结构化 Harness 数据和生命周期，不在代码中拼接业务提示词。最终内容如何进入 Prompt，由项目模板决定。

## 分类与加载方式

### 模型型 `model`

绑定供应商、模型系列、具体型号或模型能力。模型确定或切换时自动匹配，用于描述模型特性、输出约束和工具调用习惯。

- 具体型号的匹配优先级高于模型系列和供应商。
- 模型切换后，在下一个安全边界重新计算。
- 加载原因必须可追踪。

### 工具型 `tool`

绑定一个或多个 `toolId`。只有工具真正挂载到当前运行时上下文后，相关 Harness 才自动加载。

- 工具仅存在于 Catalog 时不加载。
- 多个工具可以共享同一个 Harness，需要记录依赖所有权或引用计数。
- 工具卸载后，只移除已无其他依赖方的 Harness。
- Harness 只补充使用方法和工作流程，工具参数仍以 Tool Schema 为准。

### 经验型 `experience`

通过关键词、标签、描述和适用任务进行检索，根据当前任务和对话内容动态加载。

- 初期采用关键词匹配，检索器保持可替换。
- 使用评分阈值和 `topK` 限制加载数量。
- 支持手动固定、手动移除和禁止自动加载。
- 后续可外挂语义检索，不把检索实现写死在 Loop 中。

模型型和工具型属于确定性自动加载；经验型属于动态检索加载。内容分类和激活规则应分别建模，避免后续无法增加新的加载方式。

## 建议数据模型

```ts
interface HarnessDefinition {
  id: string
  name: string
  description?: string
  type: "model" | "tool" | "experience"
  source: string
  priority: number
  match?: {
    providers?: string[]
    models?: string[]
    modelFamilies?: string[]
    capabilities?: string[]
    tools?: string[]
    keywords?: string[]
    tags?: string[]
  }
  requiredTools?: string[]
}

interface HarnessAttachment {
  id: string
  harnessId: string
  status: "pending" | "active" | "pending_remove" | "error"
  attachedBy: "model" | "tool" | "retrieval" | "user" | "always"
  reason: string
  score?: number
  contextRevisionId?: string
  renderArtifactId?: string
  diagnostics: string[]
}
```

Catalog 中保存定义，Runtime 中只保存 Attachment。不能用一个 `items` 列表同时表达“可选资源”和“已经生效的上下文”。

## 加载链路

```text
模型匹配
  -> 当前工具依赖匹配
  -> 经验检索
  -> 合并、去重和稳定排序
  -> 校验工具依赖与资源权限
  -> 试渲染
  -> 生成渲染 Artifact
  -> 生成 ContextRevision
  -> 原子更新 Attachment 状态
```

默认排序为模型型、工具型、经验型；同类按 `priority` 和稳定的资源 ID 排序。Harness 变化只在模型调用之间的安全边界生效。

热更新失败时保留 last-known-good 内容，并把新版本标记为 `error`，不能污染当前有效上下文。

## 可观测与调试

每次加载、卸载或热更新至少记录：

- Harness ID、类型和来源文件；
- 自动或手动加载、触发原因和匹配分数；
- 依赖的工具和引用方；
- 渲染输入、输出 Artifact 和缺失变量诊断；
- 生效的 ContextRevision；
- pending、active、error 等状态变化。

前端应能区分 Catalog、期望挂载状态和当前有效上下文，并支持回放每次 ContextRevision。

## 实施前置工作

1. 明确 Harness 的资源清单格式，停止把项目内所有 `.j2` 自动视为 Harness。
2. 确认 Skill 与 Harness 的边界，以及 Skill references 在运行时的注入规则。
3. 完成 Tool Catalog、Runtime Tool Attachment 和工具依赖所有权模型。
4. 固定 ContextRevision、Artifact、变量快照和诊断信息之间的关系。
5. 明确模型标识规范，包括 provider、family、model 和 capability 的来源。
6. 定义经验检索接口、关键词提取来源、触发时机、阈值和 `topK`。
7. 定义同类 Harness、跨类型 Harness 以及 required tools 的冲突处理规则。
8. 确认运行中变更、单步执行和连续执行共用的安全边界。
9. 明确前端只选择 Catalog 资源，不在 Runtime 中创建无来源的占位 Harness。

## 待讨论

- 模型匹配是加载所有匹配层级，还是只加载最具体的一个。
- 经验检索在每次用户消息、每个 Loop 轮次还是显式步骤中触发。
- 自动检索到的经验是否需要人工确认后才生效。
- Harness 是否允许声明变量，以及变量命名空间和覆盖规则。
- 独立 Harness 与 Skill 内 Harness 是否使用完全相同的清单结构。
- Harness 卸载后，历史 ContextRevision 中的内容保留多久。
