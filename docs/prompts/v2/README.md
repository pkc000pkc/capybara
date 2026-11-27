# Capybara V2 提示词组：评审稿 v0.78

关联设计：[上下文、能力、状态闭环与提示词设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md)。

这里保存模型可读的提示词初稿。提示词的目标行为与当前运行能力分别判断；加载这些文字本身不会补齐权限、等待、事务或完成门禁。

参考依据与取舍统一见[Claude 参考及自身设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#3-claude-的哪些做法值得参考)。采用公开提示词的明确分区写法，以及宪法、记忆、按需加载和独立子上下文的组织思路；各角色正文按 Capybara 的双文档、候选/证据、diff 与 RuntimeLoop 协议编写。

从[剩余缺口及关闭条件](../../v2-context-capability-control-design.md#46-当前仍需闭合的设计条件)进入统一评审。[提示词设计稿](../../v2-context-capability-control-design.md#85-提示词设计稿)给出各角色的关键措辞，[状态驱动的提示词片段](../../v2-context-capability-control-design.md#86-状态驱动的提示词片段)把它们具体化到规划、人工输入、真实等待、子任务审核和完成。按[角色选择](../../v2-context-capability-control-design.md#81-按角色和状态选择提示词)核对宿主注入条件，源任务的提示词与消息作为整理器的只读输入。

先评审 Constitution 的价值排序和 Runtime 的阶段意图，再用[退款组合场景](control-scenarios.md#8-同一运行中的授权委派与交付)与[信息整理样例](review-scenario.md)核对实际输入、输出与门禁。宿主按角色装配提示词、动态数据和实际 schema。

[角色调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)集中说明每次调用的前提、输入、输出、状态决策、父层消费和预算。它是配套设计说明，六份模型正文仍以各自的提示词版本为准；目录版本更新不表示正文版本或运行能力同步改变。

Organizer 包含面向小模型的短编号表示。`context_organization_version: 2` 接受带来源编号的提取文本。`context_organization_version: 3` 装配原文摘录提示词，模型选择片段和文档编辑内容，宿主从所选原文构造正文并验证实际绑定。[调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)

`context_organization_version: 4` 为标准文件批次装配逐项处置提示词。模型按源顺序选择保留、归档或留在历史。宿主优先完整提供一次读取的原句，整份拟归档的原件单独复核。同一工具组可在多个批次分别审核各原件。[调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)

为 `context_file_disposition_profile` 指定独立档案后，宿主分别装配文件和通用来源批次。V4 文件初筛与归档复核可通过同一个常驻分类服务接收原有 `batch`、`choices`、`heading` 协议。[本地分类服务配置](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)

专用文件批次带同一次整理的 `task.prefixCacheScope`。本地服务按该范围与完整前缀 Token 复用任务背景的 KV 状态，初筛及不同复核阶段各自匹配。该字段由宿主传入，输出仍使用原有协议。[缓存和用量契约](call-contracts.md#本地文件分类服务)

同一任务收到新的工具批次时，宿主按任务与档案指纹复查先前已提交的文件局部处置。复核通过的旧组保留原件、待核对行与处置回执，整理器接收后到的完整工具组。主轮继续依据实际投影和原证据 ID 工作。[已提交处置的复用契约](call-contracts.md#本地文件分类服务)

该档案可声明 `file_disposition_batch`。宿主在相应上限内优先发送完整原件，按实际片段数绑定 `choices`。Organizer draft-0.12 使用 `task.archiveReviewScope=window` 复核跨包原件，宿主先核对同一次读取的活跃正文，再提交两次均选 A 的内部片段。切分边界和待核对片段继续按原行或活跃正文承接。[归档调用契约](call-contracts.md#8-稳定结构化输出与总预算)

版本 4 的主轮可见已核验的文件正文引用。Runtime 仅在实际请求含引用时装配说明，告诉模型如何从 `result.lines` 读取正文并用回执定位候选原件。

Runtime draft-0.35 在 V4 最终轮提供 `fileQuotes`。结构化答复可引用核验后的文件摘录，由宿主把原文填入值为 `null` 的引文字段。时点、动作、必要条件及授权各自按来源核对。

Runtime draft-0.36 在 `runtime_state.recentContextEdits` 提供本次运行的真实编辑回执。结构编辑用当前树绑定和指令的候选证据，收到提交回执后核对新投影。主轮 `candidateDiffs[].payload.evidenceRefs` 必须非空。

Runtime draft-0.37 区分已修改与目标状态原本已满足的回执。`unchanged:true` 保留原文档修订，模型核对新投影后推进剩余编辑或完成。

Runtime draft-0.39 压缩规划说明。未来工作由完成条件与能力表达，取得实际回执后补入引用。运行时保留被拒提案原件，修复轮提供拒绝原因与当前绑定。

Runtime draft-0.40 在计划执行阶段提供 `candidateDiffs[].planTaskId`。用实际提交的编辑回执验收原节点，再按更新后的 `activeTaskIds` 推进依赖。

Runtime draft-0.41 识别文件正文和成功资源加载的精简候选引用。待核对原行与已提交摘录可一起作为本次读取的证据。缺少必要信息、需要核验时效或用户要求读取原件时，再按原件 ID 补读。质量与用量的配对结果见[阶段五十记录](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-gap-closure-progress.md#阶段五十验证--文件投影去重与任务前缀复用)。

Runtime draft-0.42 把纯推理续轮绑定到具体 `reasoningNextStep`。可以交付时直接请求 `finish`，非阻塞分歧随结果呈现。重复续轮先校验，再使用现有输出修复预算。

Runtime draft-0.43 精简重复说明和可空字段的 schema，沿用原训练回放额度。

在 draft-0.43 阶段，宿主增加按完成拒绝码装配修复提示词。修复轮核对 `completionCheck` 的字段、当前任务绑定或真实阻塞，并复用已有证据和收据。

Runtime draft-0.44 解读 V4 主轮的表式文档树。节点父子关系以本区行号引用，diff 继续绑定实际 ID 与 hash。文件证据的 `source` 指向同区来源表，保留原证据 ID 和原件行号。文档回执的 `sourceRequestId` 表示历史来源，普通结构 diff 也能进入已知旧请求的有界修复。[投影契约](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.45 明确将 `finish` 填入控制 JSON 的 `decision`，同时提交交付内容与完成检查。宿主可对误提交到原生工具通道的单个完成意图提供有界修复，重新核对当前请求与原账本。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.46 要求从同一证据复制结构化引文的文件路径和行号，并按原句核对材料编号。宿主在填入 `quote` 前核对同层位置字段，位置错误按现有输出修复预算处理。[引文契约](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.47 明确用户要求 JSON 时，`finish.userMessage` 整体遵循用户字段要求。结构化逐字引用在本轮有匹配证据时使用 `fileQuotes`，仅有工具原行时完整复制原句。[引文契约](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.48 将上述 JSON 交付规则合并到 `userMessage` 的说明中，减少固定提示词对训练纠正轮的预算占用。[阶段六十一验证](../../v2-gap-closure-progress.md#阶段六十一验证--整份原件打包与-json-交付)

Runtime draft-0.50 根据 `execution.activeTaskIds` 与 `branchBlocks` 区分该提问、该等待和仍可执行的分支。计划列出委派入口与子代理需要的只读能力。已接受的计划从 `runtime_state` 查阅，当前工具由宿主投影。[控制契约](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.51 从 `branchHumanReplies` 取得局部人工答复的原节点及完成引用，确认答复语义后更新该节点。回复内容仍以原始会话消息为准。[控制契约](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.52 使用独立 `human_input` 节点承接授权或确认。该轮只提交绑定问题或计划修订。问题登记后，独立调查继续，原节点收到真实回复后凭回执验收。[控制契约](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.53 明确由宿主登记局部等待。独立节点取得真实回执后先修订计划，剩余工作都受阻时由宿主暂停。[状态验收](../../v2-gap-closure-progress.md#阶段六十四验证--独立人工输入阶段)

Runtime draft-0.54 用授予能力约束委派的局部交付，并按事件类型消费等待关联值。Child draft-0.2 明确在 `finish.userMessage` 提交实际结果，并用工具回执核对完成条件。子控制修复轮可以使用空工具投影和 JSON 输出。[调用契约](call-contracts.md#7-异步子任务的父层行为)

Runtime draft-0.55 使用共同的分类 schema。会话召回可凭候选和证据直接用 `add_entry` 及章节路径回填；提供分类时补齐 `projectAnchors`。项目写入继续核查真实项目锚点与证据。[稳定输出与预算](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.56 说明人工答复仅验收原确认节点。补充用户要求通过追加条件或新节点承接，既有交付条件及其依据随计划修订保留。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.57 明确召回 `body` 与原件范围的关系。归档片段包含所需原句及证据时，主轮可直接提出会话 diff。Child draft-0.3 要求复用已成功的目录查询回执，继续查询前明确缺项。[调用契约](call-contracts.md#7-异步子任务的父层行为)

Runtime draft-0.58 让正文回填通过一个 `add_entry` 同时建立缺失章节和正文。仅创建空章节时用 `add_heading`，显式绑定当前可见节点、结构版本和 hash。控制 schema 中声明这组结构编辑字段。[结构化输出](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.59 明确人工回执仅归原节点，后续依赖使用节点 ID。专用文件档案可以单独处理含助手进度文字的完整读取组，进度文字仍随原工具组投影。[文件逐项处置](../../v2-context-capability-control-design.md#文件片段逐项处置)

Runtime draft-0.60 区分外层任务身份和计划节点 ID。计划节点 ID 互异，依赖使用节点 ID。宿主拒绝复用根任务或重复节点 ID，保留已有计划后引导重提。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.61 为活动节点提供 `complete_plan_nodes`。提案只提交节点 ID 和实际回执，校验成功后按原计划切换阶段。变更计划内容用 `propose_plan`。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.62 明确已经验收的节点不进入后续 `planProgress`。无原生工具的 JSON 回合返回空白时，宿主可在原预算内用文本传输重提同一结构化控制意图。重提仍没有工具权限，并通过同一个 schema 和任务绑定检查。[结构化输出](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.63 通过执行节点承接人工回复追加的文档编辑。进入交付时优先使用已经可见的原文及回执，只为缺失的交付字段补查。draft-0.64 将计划详情、MCP 未知写入、Workflow 恢复和委派说明按请求状态装配。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.65 将提示词版本及哈希存入模型请求审计，模型输入只保留一份结构化请求绑定。draft-0.66 规定父代理可用本地子结果附带的真实工具回执核对局部目标，缺少具体结论或证据时再分页。父层仍以结果哈希与读取回执提交审核。[子代理](call-contracts.md#7-异步子任务的父层行为)

Child draft-0.4 分别说明成功动作、已登记的文档证据和原件 ID 的用法。宿主修复误引时保留候选交付正文，并用新请求绑定重提控制结果。[子代理](call-contracts.md#7-异步子任务的父层行为)

Runtime draft-0.67 说明正文定位和文档树定位各自适用的操作。控制 schema 在提交前拒绝混用。父层读取本地子结果时，若工具原件整段可用并通过哈希核对，可同时看到正文。[调用契约](call-contracts.md)

Runtime draft-0.68 在节点验收中明确成功动作引用、已登记证据 ID 和原件 ID 的用途。修复提示指出误用字段，保留当前计划修订及既有动作。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.69 在计划轮的问询 schema 中投影本轮可绑定的任务 ID。已登记问题继续用原请求接收回复。拒绝重复问询时，修复轮给出原请求和当前可推进的独立节点。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.70 至 draft-0.71 用提交回执的章节路径和条目 ID 核对已经完成的正文修改。人工回复追加工作时，先验收原人工节点，再安排尚未执行的编辑。误把 `propose_diff` 当成工具时，用当前绑定重提 JSON 控制信封。[编辑回执与总预算](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.72 至 draft-0.73 用 `contextLines` 定位文件在文档中已核验的原文摘录。补读由具体缺失的证据驱动。直接生成的答复正文保留为草稿，由当前绑定的控制轮校验并提交 `finish`。[编辑回执与总预算](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.74 区分计划节点所需工具与控制决策。只执行文档 diff 或交付的节点用空能力数组，以完成条件表达预期结果。猜测的能力 ID 触发有界计划修复。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.75 要求每项 diff 只引用该候选自身的证据。独立来源分别提出编辑。混用证据时宿主回滚整批，按最新投影修复。[证据与提交](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.76 在 `planProgress` 的请求 schema 中绑定当前计划修订和活动节点 ID。人工回复恢复后，节点验收只提交本轮可接受的节点。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.77 按当前阶段和 `decision` 绑定控制载荷。规划轮把 `waitSpec` 固定为 `null`。同一信封混入另一决策的载荷时，宿主在原运行内按字段修复。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.78 配套低压力整理调度。已核验的控制回执和已承接原件的精确分页保留在历史中，单独出现时沿用现有上下文。原件、证据或完成义务变化后仍按当前投影复核。[整理与总预算](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.79 配套原生通道的受限修复。单个未投影的控制决策即使附带无效的 JSON 参数，也可用本轮绑定重提控制信封。宿主保存原参数审计，按原预算校验新响应。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.80 将本轮决策、互斥载荷和空值集中表达在宿主 schema。固定正文保留判断依据、通道选择、凭据和恢复要求。三个训练纠正场景均在现有 10,000 Token 输入上限内通过。[阶段七十四验收](../../v2-gap-closure-progress.md#阶段七十四验证--决策载荷与整理触发)

Runtime draft-0.81 在计划待验收时收起 `finish`。活动节点先完成工作并凭真实回执验收。draft-0.82 将节点验收的 `evidenceRequests` 与 `uncertainties` 约束为空数组，宿主保留已登记的事项。两类拒绝均按当前节点和预算有界修复。[状态决策](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.83 在活动节点重复提交同一条目时，凭当前可见正文、证据和原提交回执给出验收路径。draft-0.84 约束人工问题或等待只能引用单个根任务或局部节点，并以 `verified_repeat` 引用同一运行已承接的完全相同文件读取。[状态决策](call-contracts.md#6-主轮的状态决策) · [结构化输出与预算](call-contracts.md#8-稳定结构化输出与总预算)

Runtime draft-0.85 使已核验的历史读取引用在后续用户请求中继续有效，新运行中的首次读取仍按其实际结果处理。draft-0.86 使项目模板的工具说明、绑定工具的 Harness 和变量写入说明服从本轮原生工具投影。

Runtime draft-0.88 增加原件精确行读取、已发布分页重叠引用与归档专用召回。draft-0.89 明确按原文件缺失的行补读，节点只引用自身成功回执，后继节点沿 `dependsOn` 继承前置结果，仅对用户输出的报告在 `finish` 交付。[剩余缺口与验收条件](../../v2-context-capability-control-design.md#46-当前仍需闭合的设计条件)

Runtime draft-0.90 将待确认授权限定到受影响的动作。已获准的独立查证按原节点继续，工具缺失时走当前发现与加载入口。正文回填按章节路径定位，结构编辑使用节点 ID 和哈希。[调用契约](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.91 在初次规划且没有成功动作时，将本轮 `requiredActions` 表达为空数组。未来工作使用计划条件和实际能力 ID。修订保留已接受的义务。[调用契约](call-contracts.md#6-主轮的状态决策)

Runtime draft-0.92 绑定本轮可提交的计划修订及活动编辑节点。发出同一执行图时沿用已接受的计划。已就绪且有原句候选的节点直接提交 diff。专用文件档案下，已核验的原件页保留在工具历史，也可在有独立证据时单独整理其余材料。[调用契约](call-contracts.md)

Runtime draft-0.93 明确已有足够材料时直接交付，待验收条目保留待处理状态。阶段切换后，精确重复已验收的文件读取可凭原回执回到当前工作。[调用契约](call-contracts.md)

Runtime draft-0.94 按节点选择验证回执。人工回复新增的文档编辑进入独立执行节点，交付承接它的验收。已读材料足够时直接引用发布的完整原句，缺失事实在答复里标为未知。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-0.95 区分核验材料与发布答复。节点用自身回执或实际证明条件的已登记证据验收。工具轮数用尽后从已取得的材料继续控制决策，逐字引文的文件与行号各在对应字段。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-0.96 要求委派节点获得真实子结果及父层审核，并保留权限不足后的重新规划路径。此前运行里的原件页在文档与归档能够证明承接时，继续携带回执和未解决的行。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-0.97 明确子结果审核和文档提案分开提交，面向用户的 JSON 放进 `finish.userMessage`，由宿主完成验收后交付。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-0.98 使用本轮绑定常量。逐字引文可引用已发布证据或当前请求直接提供的原文件行，由宿主核对回执和位置后填入。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-0.99 明确分页所用原件 ID 与子结果验收条件。无工具修复遇到服务商调用文本时改为 JSON 控制请求，原工具轨迹保留。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.00 按用户要求选择普通文字或结构化引文。修订计划沿用已接受义务，节点验收核对成功回执及其归属。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.01 支持以当前请求内的真实文件行页证明原件引文。Child draft-0.5 说明窄授权目录查询的无工具核对轮，子代理仍用实际回执提交结果或说明具体缺项。[Runtime 正文](runtime.md) · [Child Agent 正文](child-agent.md) · [调用契约](call-contracts.md)

Runtime draft-1.02 提醒模型按当前阶段结算节点、只提交信封 schema 属性，并按实际有效页范围修正分页。拒绝的控制输出与工具操作继续保留审计。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.03 说明已承接原件区间的核对轮。服务商修复支持限定的控制载体，接收按当前绑定提交的结构化信封，验证仍由宿主完成。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.04 在同次文件整理发布后的直接交付轮先核对可用证据。父层可按 `output_next_offset` 获取子交付正文，读取工作包仍使用原件入口。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.05 为已有计划的独立复核提供 `resume_plan`，保留原计划身份、义务和回执。局部文件视图提供原行的发布、归档、混合和可见数量。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.06 在子结果回执中使用实际委派和审核节点归属。文件多页范围可显式请求有界首段，沿真实返回的下一行继续。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.07 支持按原调查回执核对已承接文件区间。活动节点已提交的文档修改可用原动作回执结算。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.08 将节点能力声明、运行时加载和当前投影对应起来。规划时登记目录中尚未加载的必需能力，节点授权缺失时修订原图，已经验收的委派沿依赖承接审核回执。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

计划执行阶段的 diff schema 要求每项包含活动 `planTaskId`，提交前还按当前投影核验。提交成功后，用同一节点的 `context:` 回执验收。[调用契约](call-contracts.md)

Runtime draft-1.09 明确召回正文回填的根级路径。用户只给出新章节名时，`headingPath` 只填该章一层。使用已有章节时沿用文档树的实际路径。[Runtime 正文](runtime.md)

Runtime draft-1.10 说明目录如何表达已注册但尚未投影的能力，以及须等子任务状态的读取和审核能力。原计划复核后可凭回执验收活动节点，也可直接提交必要的计划修订。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.11 在后续直接轮复核仍有效的已发布文件证据，并在计划编辑提交后优先核对绑定的节点回执。两条路径都可指出具体缺项后恢复原工具投影。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

后续文件轮也可从仍完整可见的原始读取批次交付。子代理目录核对在兼容通道中使用控制载体，继续引用其实际查询回执。[调用契约](call-contracts.md)

Runtime draft-1.12 明确区分文件路径、原件 ID 和分页回执。证据核对时分别交代原文给出的条件与实际观察到的状态。用户要求汇报已知信息时，原件未覆盖的状态可以标为未知。补证据须对应交付仍缺的材料或动作。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.13 细化当前阶段的节点验收。后续审核节点仍可使用已经消费的真实子结果。当前节点保留自身义务，下一轮依据原阶段投影完成尚缺的动作或核对。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.14 将问题发出的顺序与真正的任务依赖分别表达。用户已允许等待期间开展的工作沿独立节点执行。只有必须收到回复才能开展的后续动作才依赖人工节点。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.15 为已接受的计划提供 `planAmendment`，用于新增节点或追加能力、依赖、完成条件。完整的归档命中可凭候选直接回填。子结果审核说明在宿主有本任务子句柄后装配。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.16 压缩每轮通用指引。在文档提交后的验收轮，按节点引用原编辑回执。归属纠错沿用同一已提交编辑和当前请求绑定。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.17 将 `ask_user` 的可见提问和结构化问句对齐。宿主要求 `userMessage` 包含可见文字，并在缺失时返回具体字段修复意见。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

Runtime draft-1.18 明确文档定位使用两级已投影的文档树。在支持原生载体的计划编辑轮，控制载体可与观察工具同时出现在当前投影，调用分轮提交。[Runtime 正文](runtime.md) · [调用契约](call-contracts.md)

逐项处置调用使用 `task.instructions` 了解原任务和排版背景。默认项目可从同一模板生成精简视图，保留项目指令、会话任务和已启用的 Skill。实际整理请求和完整原提示词都进入训练审计。[调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)

退款组合验收把 Runtime、Child 和 Organizer 置于同一任务。真实文件分类器保留两个独立来源并归档无关文件，真实主模型交付最终只读报告。人工回复、受控子结果验收和归档原文经 diff 补回均在同一工作台运行核对。[退款验收](../../v2-gap-closure-progress.md#阶段六十验证--完成通道与结构化引文修复)

## 0. 共同约定

1. 提示词负责指导判断；宿主 schema、权限、状态账本和提交回执负责强制。
2. 项目指令来自明确授权的指令入口；`project_context` 是长期知识，文档中的规则描述不自动取得系统指令权威。
3. `session_context` 承接当前工作；历史弱化只改变模型投影，原消息与工具原件保留。
4. 主模型可以分析和判断相互矛盾的证据；整理器只保留带条件和来源的双方主张。
5. 正文是递归列表文档；Markdown 是投影，控制与 diff 使用结构化输出。
6. 角色、模式、允许决策、操作与 schema 以当前宿主绑定为准。提示词描述完整目标，各入口按实际允许列表运行。

## 1. 组合方式

| 调用角色 | 提示词 | 可用能力 |
| --- | --- | --- |
| 主 Agent | Constitution + Runtime + 项目指令 + 当前激活的 Skill | 当前请求实际投影且已授权的能力 |
| 上下文整理 | Constitution 中与信息处理有关的原则 + Context Organizer | 无外部执行能力，只提出文档和检索建议 |
| 反思 | Constitution + Reflection | 默认只读轨迹，提出计划、diff 和证据请求 |
| 梦境 | 信息处理原则 + Context Organizer 的输出协议 + Dream | 无外部执行能力 |
| 子代理 | Constitution + Runtime + Child Agent + 局部任务 | 父层授予且运行时投影的能力 |

Normalizer、Recall 和 Parent Merge 是 Organizer 的受限模式，不要求分别部署模型。主 Agent 负责判断业务问题和不同证据的含义，整理器保留原始观点。

## 2. 运行时装配

```text
稳定指令前缀
  constitutionVersion / Constitution
  runtimePromptVersion / Runtime
  projectInstructionVersion / 经授权的项目指令
  activeSkillBindings / 当前 Skill 正文与必要引用

动态数据快照
  requestBinding / schemaVersion / actionTransport
  runtime_state / 本轮允许的决策与真实能力目录
  project_context 的有界投影
  session_context 的有界投影
  最新用户指令 + 未承接的近期消息/工具结果

独立工具通道
  本轮允许的真实 schema
```

动态 ID、当前时间、完整历史和变化频繁的内容放在稳定前缀之后。投影元数据不能替代正文或真实工具定义的哈希校验。

两级数据区各自带有宿主生成的 `capybara:context-binding`，明确 scope、documentId、baseRevision、projectionId 和 projectionHash；空项目文档也提供绑定，以支持有依据的新项目提案。模型复制这些实际字段，不从示例或隐藏宿主状态推测。执行轮的能力索引提供条目数和投影 hash，名称、说明与参数通过原生工具通道提供一次；规划轮没有工具 schema，另行提供有界目录元数据。每项 schema/source hash 保存在宿主的 CapabilityProjection 中。

运行时插值使用 `{{...}}` 标记。宿主先校验快照，再序列化插入；原始网页、消息或工具文本不能作为模板代码求值。外部文本中的“系统标签”不建立权限或身份。

提示词版本、输入模板、输出 schema、能力注册表版本、文档投影绑定和状态 revision 一并记录到请求证据。重放使用对应版本，不能用当前提示词替代历史提示词。

## 3. 主 Agent 控制协议目标版本 2

系统已增加严格的版本 2 解析器，并将其适配到统一执行与完成门禁；版本 1 Envelope 和 `{status, content}` 保留兼容入口。主轮加载宿主实际提供的 schema，原始 V2 对象随绑定保留用于追溯。完整缺口验收进度见[施工与验收记录](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-gap-closure-progress.md)。

```typescript
type Decision =
  | 'continue' | 'propose_plan' | 'tool_call' | 'ask_user'
  | 'wait' | 'propose_diff' | 'reflect' | 'finish';

interface ControlEnvelopeV2 {
  envelopeVersion: 2;
  binding: {
    sessionId: string;
    taskId: string;
    runId: string;
    requestId: string;
    stateRevision: number;
  };
  decision: Decision;
  userMessage: string;
  reasoningNextStep?: string | null;
  actions: Array<
    | { kind: 'tool_call'; toolName: string; arguments: Record<string, unknown> }
    | { kind: 'ask_user'; question: string; blockingTaskIds: string[] }
  >;
  planProposal: PlanProposal | null;
  candidateDiffs: DocumentDiff[];
  evidenceRequests: EvidenceRequest[];
  uncertainties: Uncertainty[];
  waitSpec: WaitProposal | null;
  completionCheck: CompletionProposal | null;
}
```

必填字段始终出现。无对应意图的对象使用 `null`，集合使用 `[]`。所有结构由版本化 schema 校验，工具参数沿用各自的 schema。

| 字段 | 语义 |
| --- | --- |
| `binding` | 完整复制宿主给出的绑定；旧 stateRevision 的动作需要重新校验 |
| `userMessage` | 用户可见进展、问题或结果；人工提问在非终态也必须可见 |
| `reasoningNextStep` | 纯推理 `continue` 的简短具体待办，最多 240 字符。其他决策省略或填 `null`，宿主仅在纯推理读取该值 |
| `planProposal` | `{basePlanRevision, goal, tasks}`。节点含 `id/title/dependsOn/completionConditions/owner/capabilityIds/requiredActions/evidenceRefs/status`。`phase` 可选 human_input、investigation、execution 或 verification，默认 execution。完成提案须有实际动作或证据依据 |
| `fileQuotes` | 可选，V4 的 `finish` 可提交 `{scope, evidenceId, target}` 数组。`target` 是 `userMessage` JSON 中现有 `null` 字段的 JSON Pointer；由宿主按本轮已发布证据填入原文 |
| `candidateDiffs` | 绑定 scope、documentId、baseRevision、projectionId/hash、candidateId、目标节点/hash、operation、payload、evidenceRefs 和 idempotencyKey |
| `evidenceRequests` | `{id, question, sourceKinds, relatedTaskIds}`；ID 是本请求内的提议标识，不等于已经注册的外部请求 |
| `uncertainties` | `{id, statement, blocking, relatedTaskIds, evidenceRefs}`；保留尚未解决的不确定性 |
| `waitSpec` | `{reason, signalType, correlationIds, condition, deadlineRef}`；当前协议 condition 包含 eventType 和可选 status，deadlineRef 引用宿主期限或为 null；等待生命周期按统一设计验收 |
| `completionCheck` | `{taskId, requiredEvidenceRefs, requiredActions, unresolvedUncertaintyIds, summary}`；动作优先复制成功回执的 `call:<callId>`，证据引用真实登记 ID。运行时独立验收 |

计划提议 ID、diff ID、幂等键可以由模型按协议生成；权限、收据、进程、子代理、已注册等待及用户批准 ID 必须来自运行时。

### 3.1 决策约束

- `continue` 提议具体待办或补证据。纯推理填写 `reasoningNextStep` 且 `userMessage` 留空。有 `evidenceRequests` 时沿用对应任务的补证据入口。两种情形都使用当前绑定和剩余预算。
- `propose_plan`：必须有 planProposal；本轮不同时执行计划中的业务动作。
- `tool_call`：在 `envelope-json` 模式下至少一个工具 action；在 `provider-native` 模式下使用原生工具调用，由宿主补充绑定并归一化，不能再附一份可执行 JSON 动作。
- `ask_user`：必须有一个明确问题和 blockingTaskIds；运行时登记 humanRequestId，并将问题显示给用户。
- `wait`：必须有受支持的 waitSpec；“等一等”或自由文本条件不足以注册等待。
- `propose_diff`：至少一个 candidateDiff；不能同时发起外部副作用或完成任务。
- `reflect`：只诊断与请求证据，不暗示已执行纠正动作。
- `finish`：必须有 completionCheck；不能携带其他执行意图；运行时检查整个任务账本，不仅检查本轮列出的动作。

如果宿主没有发布某个扩展决策或 diff 算子，模型只能使用本轮 `allowedDecisions` / `supportedOperations` 中的内容。不得用自由文本模拟不存在的控制工具。

### 3.2 人工请求示例

示例 ID 仅用于说明，真实运行复制当前绑定。

```json
{
  "envelopeVersion": 2,
  "binding": {
    "sessionId": "session-7",
    "taskId": "task-3",
    "runId": "run-5",
    "requestId": "request-9",
    "stateRevision": 18
  },
  "decision": "ask_user",
  "userMessage": "还缺少源数据目录，请提供目录位置；已完成的文件检查结果已保留。",
  "actions": [{
    "kind": "ask_user",
    "question": "本次任务使用哪个源数据目录？",
    "blockingTaskIds": ["task-3"]
  }],
  "planProposal": null,
  "candidateDiffs": [],
  "evidenceRequests": [],
  "uncertainties": [],
  "waitSpec": null,
  "completionCheck": null
}
```

兼容适配器可派生 `status=running`，但问题必须发布到专用人工请求事件或可见消息通道，不能再被“只显示 completed 文本”的逻辑吞掉。

## 4. 整理器输出协议

整理器返回 `organizationVersion`、`snapshotId`、`mode`、`observations`、`diffProposals`、`archiveProposals`、`recallProposals`、`coverageProposal` 和 `uncertainties`。字段总是出现，空集合使用 `[]`，无覆盖建议使用 `null`。

内容 diff 使用已有四个算子；`add_heading`、`rename_heading`、`move_node`、`reorder_children` 使用 `diffVersion=2`。主 Envelope 的目标为 `target.nodeId`，Organization 的扁平提案为 `targetNodeId`；两者都复制本次树投影的 `targetNodeHash`。结构参数按各自 schema 放入 payload 或扁平字段，不能混用两种表达。节点元数据由 `capybara:tree` 提供并计入预算，新增节点的 ID 由回执后的新投影提供。

重排仅排列列出的可见同级节点，未列出的槽位不变。移动整个章节保留未显示的后代。结构回执保留 `changedNodeIds`，训练 operation 保留 diffVersion、原算子和结构参数；单纯布局变更不证明来源事实已被文档承接，不推进相应覆盖边界。

- `observations` 仅归一化运行时已提供的原件，通过 `sourceRefs` 绑定原件、时间和证据；具体字段以本轮 schema 为准，不能发明新来源。
- `diffProposals` 使用目标文档的真实版本和投影；原文改写只能生成候选正文，不能伪造 accepted 状态。
- `archiveProposals` 按本轮 schema 引用稳定原件或归档对象，说明依据和召回线索；真实 archive record 由应用回执产生，文档条目状态另经 diff 更新。
- `recallProposals` 从已检索候选中选择真实 ID；需要更多材料时提出查询建议，不能声称已经取回。
- `coverageProposal` 引用输入快照允许承接的完整消息/观察组、对应 proposal ID 和保留引用；只有运行时可以据持久化回执确认覆盖。
- 对未获支持的树移动/重排请求返回结构性不确定项；不通过整篇文档覆盖绕过算子边界。

支持 `normalize`、`organize`、`recall`、`parent_merge` 和 `dream`。宿主逐次绑定模式与 schema。同一个模型可以处理这些模式。各模式的正常入口和项目配置见第 10 节。

### 4.1 当前整理调用的精确约定

以 [ORGANIZATION_SCHEMA](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-organizer.ts)为实际协议来源：

- `observations[]` 包含 `id/sourceRefs/normalizedContent` 及可选 classification。`sourceRefs` 引用本次 `sources[].id`，代表带原件哈希与字符范围的真实片段。模型只生成本次观察的局部 ID，真实 evidence/candidate ID 由宿主登记。
- `diffProposals[]` 复制该 scope 的 `documentId/baseRevision/projectionId/projectionHash`；使用 `sourceObservationId` 引用本次观察，或使用投影中已有的 `candidateId`。内容操作为 `add_entry/replace_body/append_evidence/mark_status`；结构操作为 `add_heading/rename_heading/move_node/reorder_children`，必须携带 diffVersion=2 和可见节点/hash。具体结构参数遵循第 4 节约定及当前 schema。
- `idempotencyKey` 和原件归档提案 `id` 以 `snapshotId + ':'` 开头。它们标识建议，不是宿主签发的回执。
- `archiveProposals[]` 为 `{id, sourceRefs, reason}`，归档的是来源片段；宿主生成 archive ID 和 receipt。文档条目的归档由 `mark_status=archived` 的 diff 表达，二者不能混淆。
- `coverageProposal` 为 `{groupIds, proposalKeys, retainedMessageIds}` 或 `null`。只有最后一个分片包可以建议覆盖连续完整消息组；被移出投影的每个片段均须有已应用 diff、显式归档或保留引用。最新真实用户指令、受保护原件和工具调用/结果的完整组由宿主继续检查。
- 可以只提交局部 diff 而保留原历史；没有必要整理时返回空提案和 `coverageProposal=null`。零操作是合法结果，不能为追求压缩率制造信息。
- `mode=organize` 的历史整理调用没有提供 recall candidates，使用 `recallProposals=[]`。召回候选由独立 Recall 调用处理。

主模型后续请求必须包含承接关键来源的活动条目。预算无法容纳时，运行时保留原件并给出真实失败；不能在关键条目未进入投影时继续声称压缩无损。长期预算收敛仍需通过归档、召回和下游任务评测验收。

### 4.2 主模型的召回入口

使用 `recall_context({query, scope?, source_kind?, limit?})` 检索两级知识和当前会话的归档原件。默认范围为 both，默认返回 5 项、最多 20 项，query 最多 256 个 UTF-16 代码单元。指定 `source_kind: 'source_archive'` 时只查归档来源，其他可选类型为 `information` 和 `candidate`。工具创建或复用 pending 会话候选，候选与 journal 保存后返回。

主模型结果包含 `recallId/query/scope/hits/uncertainties`，指定来源类型时返回有效的 `sourceKind`。每个 hit 带原状态、来源类型与范围、时间、摘录、candidateId、evidenceRefs 和 rawArtifactIds。完整元数据与 hit 身份保存在持久化记录和事件中。

需要精确原文时使用 `read_runtime_artifact` 和原件 ID。已核验文件可同时给出 `start_line`、`end_line` 获取首尾包含的完整行，最多 32 行。字符分页使用 `offset`、`limit`，两种模式互斥。每页正文最多 2,000 个 UTF-16 代码单元，字符模式的实际页长由 `page_limit` 表达。项目来源用 `source_scope: 'project'` 并须由项目证据实际引用。来源会话、哈希或身份有歧义时拒绝。

召回保留项目/归档原状态。主模型依据返回候选和实际投影提出普通 diff，再由运行时审核提交。空命中、片段不完整、来源证据不足和旧候选已被拒绝均保留真实结果。启用独立 `mode=recall` 后，召回命令和工具共用选择及提交路径。

## 5. 提示词角色与门禁对应

| 模型建议 | 运行时必须做的事 |
| --- | --- |
| “这条信息适合项目级” | 核对项目相关性、锚点、来源、冻结状态和目标文档版本 |
| “可以压缩历史” | 确认关键内容已提交，并保留完整工具组、未决问题和原始轨迹 |
| “应当等待/询问” | 创建真实请求与订阅，使用户可见，保存关联并处理恢复 |
| “需要子代理” | 授予明确能力与局部上下文，记录真实身份、预算和生命周期 |
| “已经完成” | 验证任务账本、收据、证据和所有未收敛项 |

## 6. 文件目录

- [角色调用契约与评审顺序](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)
- [Constitution](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/constitution.md)
- [Runtime](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)
- [Context Organizer](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/context-organizer.md)
- [Reflection](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/reflection.md)
- [Dream](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/dream.md)
- [Child Agent](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/child-agent.md)
- [信息整理评审场景](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/review-scenario.md)
- [状态与能力评审场景](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/control-scenarios.md)

## 7. 提示词版本与验收

当前 Runtime 为 `runtime-draft-1.21`。补证据、人工回复、文档编辑与接管均按节点绑定。Skill 按节点激活，超长原件可分页。MCP 按原操作 ID 核查写入并等待终态。人工表单与 URL 协助通过专用回复和单次续传继续原 MCP 请求。Workflow 凭原节点的结算或人工输入结果回执继续，并禁止重复包装已有成功回执覆盖的链路。

其余正文版本为 `constitution-draft-0.2`、`organizer-draft-0.13`、`reflection-draft-0.2`、`dream-draft-0.2` 和 `child-draft-0.5`。

Reflection 为 `reflection-draft-0.2`，使用独立只读调用与严格 schema，复制真实快照、来源和证据索引，纠正步骤依赖无环。

提示词正文以本目录为评审源，分发资源由同步脚本生成并校验内容 hash。运行请求记录实际角色、版本/hash、schema 和投影绑定。更新提示词不能使未接通的等待、子任务或辅助模式自动可用；运行能力只以对应调用链和验收证据为准。

评审至少区分：模型能否遵循语义、输出能否通过 schema、宿主能否拒绝越界，以及实际任务效果是否保持。结构修正重试有预算，不执行未经校验的部分输出，不让修复模型补造来源、权限或回执。

## 8. 规划与阶段投影的调用约定

RuntimeLoop 的 planningRequired 选项或 chat.message.send 的同名布尔字段可以要求先规划；普通任务由主模型按复杂性选择，必要时单独调用 request_planning。该调用只提出内部阶段切换，不执行计划业务动作。planning 状态持久化在任务账本中；计划被接受后退出规划状态。

宿主投影 execution.phase、readyTaskIds、activeTaskIds、blockedTaskIds 和 allowedDecisions。依赖已完成的节点可执行，按照计划顺序选取当前阶段，同阶段的可执行节点共同确定能力集合。调查/验证阶段排除写入与进程执行；发现、加载和来源读取入口保留受限用途。目录中的 not_loaded/permission_denied 不等于系统不存在该能力。

CapabilityProjection 是宿主记录，绑定完整请求、plan revision、阶段、能力来源版本、schema hash、权限与副作用。模型不生成或修改它；原生调用由宿主附上授权绑定，JSON Envelope 继续使用原请求绑定。提交时和分发前分别复核，Workflow 的内部步骤与展开后的 foreach 调用继承相同绑定。实际主轮请求及其投影保存在 model-request artifact，文档 diff 不能修改这些控制记录。

宿主观察到状态、权限或资源变化时，可撤销尚未分发的旧队列，并发送 capability_projection_changed 通知。模型依据下一轮的实际绑定和 schema 重新决策；旧调用不自动重试。拒绝结果明确 dispatched=false，已完成批次成员和 Workflow 步骤的真实结果继续保留。taskControl.capabilityRecovery 保存宿主恢复次数和拒绝记录，不能由模型填写；计数跨重连保留，当前上限为三次并受继续轮预算约束。损坏/伪造投影、投影外动作及未知副作用不采用该自动恢复路径。

MCP 使用真实客户端发现并按需加载，主模型只使用宿主投影的名字。远端声明、返回内容和连接恢复不能授予权限或证明业务写入成功；来源与副作用预登记由宿主提供。[完整设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md)。

Skill 引用若与本轮已激活正文的原件哈希一致，并实际完整存在于 system 渲染结果中，工具历史视图可返回 contentRef=active_skill_context 及原路径/hash。模型仍能读取本轮正文；原始工具结果和 artifact 保留全文。版本变化或正文缺失时不作此去重。

## 9. Reflection 的实际调用

主轮提出 reflect，下一轮先装配 Constitution + Reflection，不提供工具通道。输入为实际失败、相关只读原件、上轮真实发布的文档投影、证据索引、任务状态与预算。工具返回 ok=false 也可以构成失败依据；没有真实依据时不调用模型，给主轮保留明确原因。

输出形状与语义门禁见 [REFLECTION_SCHEMA](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-reflection.ts)。建议仅作为 guidance 和原件返回，合法 candidateDiffs 也不自动应用；主轮在新的投影下重新决策。旧快照、未知来源和伪造 evidence 被拒绝或标为 stale；原轨迹与事实保持原样。

`contextAssistant` 可配置辅助 LLM 与预算。调用在模型分发前进入真实 SQL 账本，关闭/超时不重放未知请求，恢复保留预算；实际用量和保守预留分别记录。完整边界、默认预算、消费与训练标签见[辅助调用协议](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-auxiliary-runtime-design.md)。

## 10. 项目中的辅助模式

项目 `.capybara/config.json` 或项目设置 API 的 `context_assistant_modes` 选择启用的模式。可选 `context_assistant_profile` 引用现有 LLM profile，负责项目的上下文处理调用。省略 profile 时由当前项目模型或宿主提供的上下文模型处理。新模式按项目启用，空列表使用既有确定性入口。

```json
{
  "context_assistant_modes": ["normalize", "recall", "parent_merge", "dream"],
  "context_assistant_profile": "small-context"
}
```

| 模式 | 触发与消费 |
| --- | --- |
| Normalize | 自动 Organize 在有界分片上取得来源绑定建议，连同原片段一起交给整理器按既有门禁处理 |
| Recall | 召回命令或工具先检索有界来源，模型选择其中的 ID，宿主按实际选中项原子保存待审候选和召回日志 |
| Parent Merge | 父层读取真实子结果后取得候选建议原件。父层继续按读取回执执行结果审核，采纳建议时从当前投影重新绑定 diff |
| Dream | 空闲命令或任务完成后取得整理建议。前台启动会终止旧空闲调用，建议通过普通提案入口进入后续审核 |

各模式使用实际快照、版本和来源索引。超预算和非法选择留存原因。Recall 的普通辅助失败会回到确定性检索，快照过期后重新请求才能写入候选。[模式 schema 与校验](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-assistant-modes.ts)
