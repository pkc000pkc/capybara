# V2 缺口施工与验收记录

目标：[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md)中的全部 20 个缺口，以及[提示词组](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/README.md)的运行时接入与场景验收。

日期：2026-11-18。目标持续进行中；下表的“推进中”不代表该项完整验收通过。

## 当前改动

1. 六份提示词作为版本化资源进入 Backend 分发包。构建与测试前从评审源同步；运行时记录版本与内容哈希，主轮只装配 Constitution、Runtime 和当前角色指令。插值只做一次安全序列化，输入数据不会再次作为模板求值。
2. 新增严格 ControlEnvelopeV2 schema、解析和单次适配。保留原始 V2 绑定，校验 task、run、request 与 state revision。原生动作与 JSON 控制混用时拒绝执行。
3. 新增任务计划账本，支持独立规划轮、依赖检查、revision、完成依据和持久化恢复。已接受的任务、完成条件与动作义务不能通过后续计划省略。
4. 旧 completed 和新 finish 经过共同的运行时完成检查，核对账本、证据、未知副作用、等待、人工请求与未结束子任务。
5. 人工问题发布为可见且持久化的 assistant 消息，运行时创建 humanRequestId；拒绝过期回复，并将桌面 autoStart 回复关联回原 task/run。暂停状态在步骤位置和 checkpoint 更新后发布，避免重连后重复执行提问轮。
6. 知识投影可以显式排除 system/tools/messages 区；主轮单独装配指令，避免五区文档再次把完整消息与工具 schema 投入请求。能力目录保留名称和 schema hash，说明与实际参数定义使用 API 工具通道，避免重复发送。
7. `ContextHistory` 独立保存原始消息、完整原生工具组与工具结果原件。整理器在完整工具组边界持续处理有界来源片段，提出两级局部 diff；保留不同来源的金额/观点，不作业务裁决。失败与合法零操作都保留原历史。
8. `ContextCommitStore` 在同一 SQLite 事务中保存两级文档、原件引用、归档记录、真实回执及 `coveredThrough`。`ProjectContextStore` 首次导入旧文件，之后以 SQL 为权威存储；JSON/Markdown 是可重建镜像。镜像或训练记录失败不能把真实提交改标为失败。
9. 下一轮模型输入由两级文档投影、最新用户指令和未承接完整消息组构成。承接关键来源的活动条目被固定纳入投影，预算不足时拒绝继续丢失信息。checkpoint 恢复产生新的会话文档版本并重置覆盖边界，原件不回滚。
10. 变量统一为 `session_context`，保留 `context` 兼容别名；另行展示只读 `runtime_state`。V2 workbench 读取文档树，知识正文与原始容器元数据分离。
11. 整理训练采集保存实际模型输入、原始提案、提示词版本/哈希、只读运行状态、提交与覆盖结果。新版 chat 导出将原始模型提案作为 assistant target，运行时回执保留在标签/来源中；拒绝记录不进入正例，合法零操作可训练。
12. 普通 Envelope 的两级 diff 也经工作副本整体校验后一次提交，后一个作用域或 SQL 写入失败会撤销整个逻辑提交。幂等回执增加语义内容哈希，复用 key 更改正文/证据/目标时拒绝；旧回执缺少可验证哈希时不声称重放成功。
13. 显式候选观察、候选审核、证据审核、子结果候选和已结束工具观察接入会话文档持久化，发布成功事件前先保存；保存失败恢复原内存状态。自动整理样本在采样开始时标记 `task=context_organization`，后续训练记录故障也不能落回旧导出器、把运行时权威字段当作生成目标。
14. 新增统一 `recall_context` 工具和 `ContextRecall` 检索服务，覆盖两级知识/记忆以及当前会话的归档来源片段。结果先进入 pending 会话候选，候选与 recall journal 同事务保存；主模型随后通过普通 diff 提交。原项目和归档状态保持各自身份，冻结项目仍可读取。
15. 原件归档增加明确的 sourceSpans 和可重建的检索索引，字符范围遵循 UTF-16。证据记录所属 session；原件分页可以读取当前会话或项目文档真实引用的来源，拒绝同名歧义和无关会话。训练记录保留来源 scope、片段引用到候选的对应关系。
16. 每轮请求提供两级文档完整 `scope/documentId/baseRevision/projectionId/projectionHash`，即使项目活动正文为空也保留真实绑定。新召回候选优先进入模型投影。修复重复消费同一证据生成新 evidence/revision 的问题，避免模型请求发出后由记录动作使投影失效。
17. Runtime Prompt 更新到 draft-0.4，明确真实召回工具、原件读取和候选边界。主轮工具说明只通过原生工具通道发送；目录仅保留名称与 schema hash。新增绑定后的预算回归由去重解决，保留原预算与业务断言。
18. 两级文档增加持久化的 `tree.version=1`。旧文档确定性迁移；章节有稳定 ID，正文沿用原信息 ID。新增章节、重命名、移动和局部同级重排使用 `diffVersion=2`，绑定实际投影的 nodeId/hash；内容与结构参数分开，未知算子、猜测节点、环和非法锚点被拒绝。替换正文保留旧节点谱系与物理位置，活动视图隐藏旧版本。
19. 主轮和 Organizer 提供有界 `capybara:tree` 元数据，计入正文预算；固定事实优先选择但按文档原序呈现。当前真实用户消息作为来源候选保留，连续编辑可显式固定 accepted 来源；被拒绝的候选不自动复活。布局回执不能独自承接原事实。
20. V2 桌面数据同时提供递归 List、持久树和 `nodeIdsByPath`；折叠按节点 ID 保存，不再依赖数组下标。训练记录保留真实结构算子、diffVersion、结构参数、目标 hash 与 changedNodeIds。Runtime Prompt 为 draft-0.5，Organizer 为 draft-0.4，评审源与分发资源同步。
21. ContextCommitStore 按连接保存实际读取的状态指纹，写入同时检查身份、revision、完整内容与独立 write_version。版本展示查询不刷新写基线；相同正文的归档/覆盖提交也推进存储序号，过期连接不能使覆盖边界回退。事务失败恢复原基线，旧 SQLite 表自动迁移。
22. 恢复时优先选择 SQL 中的两级文档，快照较高 revision 或损坏的候选/树不覆盖已提交知识。缺少记录时才允许一次性旧快照导入，原件和文档同事务保存，覆盖边界从零建立；已有原始消息不能被快照改写。
23. V2 Backend 宿主在创建 RuntimeLoop 时绑定实际 sessionId，首次展示前完成权威加载。一个 RuntimeLoop 不能切换到其他 session；每轮主请求刷新项目知识，保留相同文档上实际发出过的投影。
24. 会话清理同时处理新上下文表，保留项目证据/候选真实引用的原件，移除无关私有材料。旧证据的同名歧义保留原件并拒绝选定任意来源；新会话仍可通过受授权原件分页读取保留的项目来源。
25. 清理为旧 session 留墓碑，旧运行、原件追加、checkpoint 和快照不能复活它。原件追加在一个写事务中检查墓碑并写入；与清理交错时不能在清理后落入新原件。清理失败整体回滚，后置维护失败不逆转已提交清理。
26. 会话拒绝回执进入会话持久化；Session → Project 晋升失败恢复项目候选和证据，避免拒绝后内存中仍残留待晋升材料。项目拒绝的审计追溯与其余发布/恢复入口继续检查。
27. 增加独立投影发布 journal，模型、检查和 Hook 分别保存真实 Markdown、hash、文档/revision 及可见节点。模型绑定完整 run/request；仅保存实际请求完整包含的投影。发布与必要元数据同事务，失败不发起模型调用。
28. 负向审计保存原始提案/回执与每次尝试；独立拒绝可重启恢复，整批回滚可安全重试并保留原失败标签。成功文档与回执审计同事务，审计失败恢复内存；伪造、篡改或盗用另一 key 的成功回执被拒绝。
29. 跨作用域批次按原提案配对回执，支持新 transport ID 的重放及“旧成功 + 新动作”混合提交。原提交不因后续批次回滚改标失败；训练标签关联当前尝试与原回执，拒绝归档不进入成功归档集合。
30. 只读发布的知识指纹覆盖信息/候选区正文与条目引用，禁止借元数据修改知识。清理移除发布、原始结果和尝试记录，墓碑阻止旧 session 重写。
31. 关闭先撤销执行代际并取消工作，再关闭存储；迟到模型返回不再写入。后台步骤收尾失败进入真实 failed 状态，保留先前真实工具结果和文档提交，避免未处理的任务拒绝。
32. RuntimeLoop 选项、单次消息或内置 request_planning 可要求独立规划。规划状态随任务持久化，planning 轮没有执行 schema，旧 completed 不能跳过；人工回复恢复原 task/run 后仍先规划。
33. 计划节点支持 investigation/execution/verification，默认 execution；依据已完成依赖选择同阶段可执行节点，投影仅包含其能力及受限支持入口。未知能力不能写入计划，调查/验证排除写入与进程执行。
34. 每轮保存真实 CapabilityProjection，绑定完整请求、计划/阶段、来源版本、schema hash、权限与副作用。原生/兼容动作接收时核对，队列分发前再次核对同投影剩余调用；源码、权限、阶段或请求状态变化不能沿用旧绑定。
35. Workflow 只能引用原投影中的工具；普通步骤与 foreach 继承授权，快照恢复仍校验当前权限。实际工具回执引用 capabilityBinding，模型不生成这些授权记录。
36. 执行轮能力索引与子代理不重复发送完整 schema。规划目录有界并标明 total/truncated；文档空间先扣除实际序列化 schema 和完整未承接历史的估算占用，修复百分比预留导致的超额分配，保留原预算限制。
37. Runtime Prompt 更新为 draft-0.7，明确规划入口、节点阶段与包装工具边界。runtime_state 展示只读 execution 视图；六份分发资源与评审源同步。
38. 真实状态、权限和能力版本变化后撤销尚未分发的旧队列，发布 dispatched=false 的拒绝并重新取得投影；既有成功动作、计划义务和 Workflow 部分结果保留，不自动重放。
39. 三次能力恢复预算随任务、checkpoint 与关闭重连保留；注册定义、校验器、runner 和权限在主请求前同步刷新，准备事件后在分发边界再校验。取消、未知副作用和伪造绑定不获得自动重放。
40. Runtime Prompt 更新为 draft-0.8，并增加恢复语义与训练标签边界；V2 桌面 IPC 覆盖拒绝、关闭重连和人工回复继续原任务。
41. 接通官方 MCP Client 2.4.0 的 stdio / Streamable HTTP，进行真实协议协商、分页发现、目录刷新、按需加载和统一调用。宿主命名区分不同服务的同名工具，来源回执保留实际 RPC ID。
42. MCP 每项工具具有宿主权限、副作用和重放策略；服务端 annotations 不授予权限。旧连接、schema 和未加载/未授权能力不能执行；业务 RPC 不自动重放。
43. MCP 写入在真实 SQLite 预登记，登记失败不分发，未知结果阻止同会话重复动作及完成。旧/空快照不能清除权威未知记录；远端成功而最终结算失败时保留成功，另记持久化故障。
44. 桌面关闭等待 MCP 连接与子进程退出；重连刷新真实能力并恢复激活意图。Runtime Prompt 为 draft-0.9，补充 MCP 身份、重连和未知写入边界。
45. Skill 参考原件与哈希一致且实际出现在本轮激活正文时，仅模型历史视图使用 contentRef 去重；原消息、artifact 和收据保留。缺少或改变正文时保留原文，不推进事实覆盖边界。
46. 内部能力带显式权限合同，与项目工具共用权限/只读判断。模型 schema、执行入口、Skill 参考读取和脚本直接命令分别核验；安装/移除确认也重新检查原操作权限。
47. Skill 脚本绑定激活入口、注册路径及实际内容 hash，标记 external/never。模型入队后换版进入新投影决策；加载回调后再换版或撤权，启动前拒绝。冻结资产和只读子代理拒绝普通脚本。
48. Hook 的 LLM RPC 在宿主端按注册权限验证，拒绝伪造 Worker 消息；已结算或取消的 Worker 不处理迟到 RPC。该门禁不构成操作系统沙箱。
49. 子候选导入只保存 pending 信息，不创建子生命周期或成功时间，也不覆盖真实失败。Runtime Prompt 为 draft-0.10，文档和训练契约区分候选保存、真实执行与父层消费。
50. 新增 SQLite 等待期限、订阅、信号及绑定的恢复 checkpoint；全部关联精确满足后才唤醒。宿主签发 deadline，不接受伪造时间；普通 resume/step/start 不能绕过有效订阅。
51. 原生工具收据、宿主进程/子状态与认证 external/user 观察分别产生信号；客户端不能伪造 runtime/tool 来源。相同事件 ID 幂等，冲突重用拒绝；原文按需通过 read_wait_signal 进入普通证据路径。
52. 关闭重开核对 SQL 中的信号与绝对期限，处理离线到期和部分命中。显式取消等待、取消 run、满足与超时分别记录；取消 run 的标记能阻止旧快照和恢复回调重新启动。
53. 未提交等待意图恢复为真实中断；已生成后续模型节点时修复游标，不制造订阅或重复模型轮。Runtime Prompt 为 draft-0.11；会话清理覆盖新增控制表并拒绝旧连接复活。
54. 子任务使用独立 SQL 账本和每次执行租约，默认异步返回句柄；父层能推进独立工作，子任务的身份、期限和预算不由模型签发。
55. 子能力由父请求实际投影收窄，只读局部会话独立。真实子 run 完成与 assistant 文本结束分离；必要输入绑定真实请求，回复后旋转 waitRef。
56. 子结果原件不可变独存，节选有全文引用；读取后签发回执，父层后续轮审核消费。消费不确认事实，不自动提交 diff；未结算/未消费/待补证据的子任务阻止正常完成。
57. 取消、超时、关闭挂起和迟到分别记录；本地只读 checkpoint 恢复原子 run 和原预算，旧 worker 回调只形成迟到审计。无恢复依据的外部宿主保持 unknown。
58. 会话清理移除子控制记录，项目证据确实引用的原件继续保留并核对哈希分页读取；墓碑拒绝旧写入。原件不伪造为历史消息。
59. 模型状态投影保留全部活动/unknown 进程、未消费子任务、pending 等待与有效期限，精简已结算记录和重复绑定；完整账本与桌面快照保留。Runtime Prompt 为 draft-0.12，参数与消费依实际 schema。
60. 新增共用辅助调用 SQL 账本，模型分发前绑定角色、快照、提示词/schema、实际模型与原 task/run，并登记完整输入与输出预留；未知调用、连接恢复和 checkpoint 回退不清除预算。
61. reflect 触发独立只读 Reflection，先核对异常、中断或真实工具 ok=false。严格 schema 校验快照、来源、候选、节点/hash、evidence 和无环计划，不提供工具通道。
62. 反思来源独立保存实际输入、输出、原始响应与被拒绝的工具参数。主模型得到完整合格输出及原件引用；合法候选 diff 不自动应用，未知、重试前提和依赖不静默缩减。
63. 消费前复核状态/计划与两级知识 hash；并发变更标为 stale，失败或 unknown 不变成纠正成功。活动调用阻止父任务完成，活动所有者不被其他连接抢占。
64. 关闭、期限、登记后尚未分发的关闭、迟到回调与结算故障分别留证；会话清理覆盖新表与墓碑。恢复原任务，不重放未知调用。
65. Reflection 使用 draft-0.2；受控链路与 V2 桌面 IPC 已接入。Normalize、Dream、Recall 选择和 Parent Merge 的独立适配继续按 CAP-01 接通。

## 逐项进度

| 编号 | 状态 | 当前证据与后续验收重点 |
| --- | --- | --- |
| CTX-01 | 受控链路通过，继续场景验收 | 自动 diff、真实提交和历史承接已接通；继续长任务与真实模型效果验收 |
| CTX-02 | 共享额度、文件整理任务投影与 V4 主轮引用已验证 | 默认项目的文件整理去除重复注入的执行资源目录。V4 主轮展示可读证据引用，复核节点及证据与持久记录一致。继续校准带工具请求和长任务收敛 |
| CTX-03 | 按原件归档、局部投影与回退已联调 | 正文和归档凭据支持只投影待核对原行，失效后整组回退。活动正文的已核验文件引用可重建原行号。继续验收完整引用和计入读回、整理的总成本 |
| CTX-04 | 桌面实时文档、折叠与恢复已验收 | Electron 工作台验证两级递归文档，改名、移动和重排后保留节点展开，换会话与重开后恢复各自状态 |
| CTX-05 | 真实重连召回与受控回填通过，继续质量验收 | 双作用域检索、归档原件、候选、普通 diff 与原件分页已联调。真实退款恢复后取得归档原句。继续核对真实回填和更长任务的语义相关性及收益 |
| CTX-06 | 存储、发布与审计受控通过，继续全入口验收 | 两级事务、CAS、恢复、清理、独立投影发布和原始/尝试审计已有故障与重启验证；V2 IPC 可在未提交 diff 前关闭并恢复投影；继续跨能力入口及完整场景验收 |
| CTX-07 | 大文档结构场景、重复提案与文档编辑计划已验证 | 四个结构算子、可见节点/hash 门禁、原子回滚、SQLite/IPC 恢复和训练记录已验证。点名的空章节优先发布。计划编辑的实际修改按原节点登记，真实模型已凭回执完成依赖节点 |
| CAP-01 | 模式接入已验证，继续真实模型与完整任务验收 | Reflection、Normalize、Recall、Parent Merge、Dream 各有实际调用和独立 schema。项目可选用独立辅助模型 profile |
| CAP-02 | 规划、阶段投影与有界恢复受控通过，继续跨来源验收 | 计划引用在登记前核对。拒绝后刷新定义并重新决策，保留批次/Workflow 部分结果、计划义务与恢复预算；继续 MCP 来源、全部间接入口和完整任务验收 |
| CAP-03 | 真实传输、结算等待、表单和 URL 已联调 | stdio/HTTP、发现、分页、同名隔离、schema 更新、失败/重连、RPC 来源和写入预登记已有回归。直接工具与 Workflow 沿用原操作处理多轮人工输入。继续实际部署服务及其余间接入口验收 |
| CAP-04 | 推进中 | 内部能力、Skill 和 Hook RPC 已补权限检查。Workflow 的 MCP 恢复保留原节点、输出和回执，剩余动作按新投影逐步复核。继续其余资源入口及外部副作用结算 |
| CAP-05 | 版本、阶段、预算与卸载已联调 | 实际请求按阶段和完整块投影，原件可分页。会话恢复保留阶段绑定，卸载按工具来源更新。继续真实模型的发现、重读和跨阶段任务验收 |
| CTL-01 | 推进中 | 完成门禁核对持久化义务、MCP 原写入和待恢复 Workflow。完成意图误入工具通道、同任务请求绑定错误与结构化引文位置不一致均有有界修复。继续其他结束与子结果消费入口验收 |
| CTL-02 | 真实会话授权重连通过；MCP 人工输入受控通过 | 真实主模型在原运行收到同一人工请求的回复回执。V2 工作台绑定会话问题、MCP 表单和 URL，能力撤销时拒绝续传。实际主模型配对本地 stdio 验证 URL 恢复。继续实际部署和其他授权变化验收 |
| CTL-03 | 根任务与局部订阅受控通过 | 独立订阅分别结算，真实 child.ready 只唤醒对应分支。MCP 核查终态按原操作收据唤醒根任务。继续实际部署的外部服务与完整任务验收 |
| CTL-04 | 局部补证据、委派归属、父层接管与依赖解锁受控通过 | 请求按节点登记。节点沿用原计划义务，子结果、父层接管动作和计划编辑回执各自通过来源校验。继续跨事件恢复验收 |
| CTL-05 | 真实 V2 规划与本地委派执行通过 | 从节点与父投影取只读交集。实际子模型在单工具投影中查找资源，父模型读取并消费真实结果。继续验证真实外部宿主与其余间接入口 |
| CTL-06 | 本地真实父层审核通过；接管恢复已有受控验证 | 父模型用读取回执和结果哈希完成审核。旧父快照可恢复子句柄及接管归属。继续外部宿主恢复和输入幂等 |
| VAL-01 | 退款双模型组合与真实自主控制分别有通过证据 | 真实规划、分支提问、读取、委派和审核已在 V2 IPC 同一运行观察到。复验还需把自主控制、人工回复恢复、真实分类及召回交付联在同一任务中 |
| VAL-02 | 导出、归档复核与配对任务训练已联调 | 新分类器原留出整批通过 12/12，新增配对留出 9/12。继续验证困难样本、较长会话的保真和含分类及补读的总用量 |

## 第一批验证（历史记录）

- 新增 13 项测试通过：严格 schema、diff 绑定、计划依赖和义务保留、提示词哈希、单次插值、知识投影隔离、人工回复、旧格式完成拒绝、过期绑定、混合动作拒绝、真实工具执行及状态恢复。
- 较早的上下文/状态回归 76 项通过；该组与新增测试有交集，不能相加为独立全量结果。
- 完整后端回归 369/369 通过。此前发现修复提示兼容性、重复工具 schema 带来的预算问题，以及全套并发下变量写入测试固定 5 秒等待不足，已修正；变量写入的全部业务断言保留，等待上限改为 15 秒并附运行状态诊断。
- 随后的暂停恢复与用户目标不可被计划覆盖修正，已通过 22 项控制/恢复回归。该组与完整后端套件有交集。
- V2 桌面 Backend IPC 5/5 通过，包含真实 SQLite 保存、关闭宿主、重新连接、问题展示和原 task/run 恢复。该验证覆盖 IPC 与数据恢复，界面视觉仍按后续场景验收。
- Protocol 与 Backend 构建、Backend 类型检查通过。以上均为受控模型/本地工具测试，真实模型效果仍需单独验证。

日志：[新增场景](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/control-new-tests.log)、[上下文回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/control-context-regression.log)、[后续控制/恢复回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/control-final-regression.log)、[失败用例复跑](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-goal-failure-recheck.log)、[完整后端](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-goal-backend-suite.log)、[桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-goal-desktop-host.log)、[类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/control-foundation-typecheck.log)。

## 阶段二验证：上下文管线与提交一致性

日期：2026-11-17。以下为该阶段代码的验收记录；最新结果见后续阶段。测试组有交集，数量不相加。

- 完整 Backend 回归 **389/389** 通过，包含提示词资源哈希、原生工具组承接、来源/投影拒绝、两级提交与恢复、冲突内容保留、合法零操作、训练导出和提交后记录故障。
- V2 Electron Backend IPC **5/5** 通过，包括真实 SQLite 保存、关闭重连、人工问题可见及原任务恢复。使用最新编译的 Backend；这是 IPC/恢复验收，尚非桌面视觉与真实模型效果验收。
- 新增的跨文档场景验证项目先写/会话后拒绝、反向顺序下项目投影拒绝、SQL 中途写入失败和成功重启恢复；失败时两级文档均无局部提交、历史覆盖不变、无虚假成功事件。
- 候选审核持久化故障与项目观察持久化故障均验证内存恢复；成功审核的新状态可由不带旧快照的新 RuntimeLoop 从权威存储加载。
- 训练记录故障注入验证：真实上下文提交及覆盖仍有效，未完成样本不能成为正例或旧格式权威目标。拒绝执行与合法零操作保留各自真实标签。
- Backend 类型检查、Protocol/Backend 构建通过；V2 workbench 类型检查通过。七份主要设计/提示词文档的本地链接、空白格式和 20 项缺口编号检查通过。

证据：[完整 Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-final-backend-suite.log)、[最新桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-final-desktop-host.log)、[跨文档与内容幂等](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-atomic-new-tests.log)、[候选持久化故障](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-mutation-test.log)、[整理/训练场景](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-durability-tests.log)、[Backend 类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-final-typecheck.log)、[构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-final-build.log)、[workbench 类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-atomic-workbench-typecheck.log)。

场景入口：[整理管线](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-organization-runtime.test.ts)、[两级 Envelope 事务](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-envelope-atomic.test.ts)、[候选持久化](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-mutation-durability.test.ts)、[文档引擎](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-document-engine.test.ts)。

## 阶段三验证：归档召回、模型绑定与 V2 桌面数据

日期：2026-11-17。增加统一召回入口、精确原件片段索引、召回 journal、来源所属会话和授权分页；Runtime Prompt 为 draft-0.4。完整目标仍为全部 20 项缺口，以下不作为整体完成声明。

本阶段验证了这些完整场景：

1. 同一退款议题的项目 A/会话 B 来源分别召回，125 与 120 两个值并列保留；命中首先成为 pending 会话候选，原项目条目不恢复、不改写。
2. 在项目资产冻结的运行中，受控主模型调用真实 `recall_context` 工具，读取实际返回与系统投影绑定，再提交两个证据分别绑定的会话 diff。主模型下一请求能使用两方正文；测试不从私有宿主状态拼装 diff 绑定。
3. 旧归档记录重建索引后，含非 BMP 字符的来源仍按 UTF-16 范围精确召回；归档范围外和无关会话的内容不成为命中。原件摘录的全局 offset、原件总长度与 truncated 标记一致。
4. 项目证据引用的原件可在新会话分页取回。存在跨会话同名 ID 时按证据所属 session 定位；无授权的会话来源和未限定来源的歧义读取被拒绝。
5. SQL 在召回 journal 写入处故障时，候选写入一起回滚，不发出成功事件。重复召回复用来源版本相同的候选；原件及原状态保留。
6. V2 Electron IPC 场景经真实 Backend 执行召回与 diff，关闭宿主、重连后项目和会话仍为独立文档，正式会话正文以递归 `List<List|string>` 返回，来源项目条目仍归档。

还修复了两个由上述场景发现的问题：消费工具观察时重复生成 evidence 导致投影失效；主模型请求未携带严格 diff 所需 documentId。新增绑定后完整回归曾出现 4 项预算相关失败，保留失败日志；去掉目录与原生工具通道重复的工具说明后，原预算和全部业务断言不变，4 项定向复跑及完整回归均通过。

- 最新完整 Backend 回归：**395/395** 通过。[日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-recall-verified-backend.log)
- Client SDK 集成：**1/1** 通过。[日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-recall-client-tests.log)
- 最新编译 Backend 的 V2 Electron IPC：**6/6** 通过，新增召回、严格 diff、两级递归文档数据与关闭重连场景。[日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-recall-verified-desktop.log)
- Protocol/Backend 构建、Backend/workbench/Client 类型检查通过。[构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-recall-verified-build.log)、[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-recall-verified-typecheck.log)、[workbench](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-recall-verified-workbench-typecheck.log)、[Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-recall-verified-client-typecheck.log)
- 预算回归复跑：**4/4** 通过，已计入完整套件，不累加。[复跑](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-recall-budget-recheck.log)、[保留的失败记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-recall-final-backend-suite.log)

代码与场景：[ContextRecall](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-recall.ts)、[索引与事务](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-commit-store.ts)、[归档召回场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-recall.test.ts)、[V2 IPC 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)。

以上使用受控 LLM 和真实本地工具/SQLite/IPC；关键词召回的真实语义质量、规模性能、下游答案与 token 收益、独立辅助模式和桌面视觉仍分别验收。

## 后续依赖顺序

原始观察、Organizer、两级提交/覆盖、归档召回、文档树、存储发布/审计、阶段能力、有界恢复和真实 MCP 已进入受控验证。后续继续统一 Skill 与子代理权限，补全真实等待、人工输入/未知结果核查的事件流、异步子任务和其余辅助角色调用。恢复机制继续全入口验收；训练采集、总预算与场景验收贯穿各项改动，真实模型效果和桌面视觉分别留证。

## 阶段四验证：文档树与版本化结构 diff

日期：2026-11-17。完整目标仍为 20 项缺口；本阶段接通 CTX-04/07 的文档结构、投影、提交、训练和 V2 IPC 链路。

- 旧文档按原条目顺序迁移，标题含斜线时也保留完整 headingPath；树、正文、来源与身份可序列化还原。结构编辑保留正文和证据，重排后原始信息数组仍保持谱系所需关系，阅读顺序由树维护。
- 验证新增章节、重命名、移动整棵子树和局部同级重排。缺少版本、错误 hash、猜测节点、跨父引用、环和混入正文改写均拒绝；批次中后续操作失败，前面的结构变更整体回滚。
- 归档节点继续留在原物理槽位；局部重排只改变指定可见节点。替换后的旧正文保留供追溯，活动递归文档只显示当前正文。
- 运行时六轮实际请求依次新增材料、创建章节、改名、移动、重排和完成；绑定全部来自实际请求。四类结构训练 operation 与真实 changedNodeIds 回执保留，SQLite 文档与展示数据一致。
- Organizer 使用真实快照的树绑定；错误 hash 拒绝。仅成功新增章节、尚未保存来源事实时，覆盖请求被拒绝，原始材料继续保留。
- 2,048 条同级信息在 3,000 字符投影中保留末尾固定事实，隐藏节点没有整体展开。结构元数据计入预算；固定优先级不改写文档顺序。散列与投影选择避免反复扫描全部同级节点。
- V2 IPC 的召回场景扩展为八轮主调用，另行处理真实自动 Organizer 调用；关闭宿主重连后两级文档仍独立，章节 ID、顺序、正文与递归路径映射一致。项目原条目仍归档。

最新完整 Backend：**404/404** 通过。[日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-tree-final-backend.log)。Protocol/Backend 构建与 Backend/workbench/Client 类型检查通过；Client SDK **1/1** 通过。[Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-tree-final-build.log)、[Backend 类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-tree-final-typecheck.log)、[workbench 类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-tree-workbench-typecheck.log)、[Client 类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-tree-client-typecheck.log)、[Client 测试](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-tree-client-tests.log)。测试组有交集，不相加。

最新编译 Backend 的 V2 桌面 IPC：**6/6** 通过，包含扩展后的八轮结构编辑与关闭重连场景。[日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-tree-final-desktop.log)。11 份设计/提示词/契约文档的本地链接与六份分发资源一致性检查通过。

随后将固定来源精确绑定到 `ContextHistory.latestUserId()`，避免迟到的旧用户来源抢占当前要求；相关 RuntimeLoop/Organizer **8/8** 定向回归通过，仍保留全部业务断言。[日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-tree-source-priority.log)。

本阶段保留了排查过程：首次完整运行漏设夹具环境变量，改用根目录 `npm run test:backend` 后回归通过；桌面扩展测试最初把自动整理调用计为主模型轮，现按角色返回匹配协议，保留真实辅助调用。新测试还修正了对序列化容器文本和错误码的过强假定，保留正文、结构、来源、身份和原子回滚断言。

代码与场景：[文档树](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-document-tree.ts)、[引擎场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-document-tree.test.ts)、[实际 RuntimeLoop 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-document-tree-runtime.test.ts)、[整理场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-organization.test.ts)、[V2 桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)。以上为受控模型、真实本地存储与 IPC 验证；实际模型语义效果、长任务总预算以及桌面折叠交互和视觉仍分别验收。

## 设计与提示词评审补充

统一设计更新为 v0.3，增加当前真实缺口汇总、Claude 参考边界、按角色和状态装配规则，以及独立的[退款排查语义样例](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/review-scenario.md)。样例保留原任务提示词与消息，展示 cache 提取、两级递归文档、A/B 金额差异保留、明显无关材料归档与下一轮主模型输入。

Organizer Prompt 更新为 draft-0.3，明确原任务无需整理指令、原任务执行要求不授予整理器权限，以及来源说法不能被压缩成确认结论。六份分发资源已同步。

本次定向验证：`runtime-control.test.ts` 与 `context-organization.test.ts` 共 **13/13** 通过；9 份设计/提示词文档的 52 个本地链接、6 个 JSON 示例、20 个独立缺口编号、4 份递归列表文档及 6 份提示词资源一致性检查通过。此组与既有完整回归有交集，不能累加；文档评审和受控测试不构成真实模型效果、全部辅助模式或桌面视觉验收。

## 阶段五验证：存储并发、恢复权威与来源生命周期

日期：2026-11-17。统一设计为 v0.4，增加存储权威、独立 write_version 与会话清理规则。本阶段不改变完整 20 项缺口目标。

新增故障与恢复场景验证：

1. 两个独立连接基于同 revision 更新投影或写入完全相同的状态，后提交者被拒绝；只查询版本不刷新写基线，显式重新加载后才能继续。
2. 双文档事务写完项目、在会话写入处故障，两级数据与内存中的写入基线一起回滚；移除故障后相同提交可重试。
3. 运行快照虚增两级 revision、改写正文或包含损坏候选/树时，恢复首次展示仍使用 SQL 知识；不能用该 RuntimeLoop 切换到别的 session。
4. 快照原始消息与已持久化原文不同，恢复被拒绝。缺少旧文档记录时，快照尾部原件与文档按事务导入；中途故障不留下部分原件，未证明的覆盖边界重置为零。
5. 会话清理中途故障整体回滚；成功后目录、会话文档、覆盖、归档、召回和提交记录清除。项目引用的原件继续可分页读取，无关私有原件消失；未限定 session 的同名旧来源全部保留并继续报歧义。
6. 旧会话墓碑拒绝保存、追加原件和 checkpoint 恢复。两个真实 SQLite 连接在墓碑检查处交错，清理不能插入原件追加事务中间；追加完成后清理能正确删除非项目来源。
7. Session → Project 的分类冲突拒绝后，项目候选、证据和 revision 恢复原状，原会话来源保留。
8. 只归档原件、文档正文和 revision 都完全相同的两个提交竞争时，独立写序号阻止过期提交把 coveredThrough 从 2 回退到 1。
9. 旧 SQLite 表自动增加 write_version；文档身份、正文、证据、回执与知识 revision 保持原值，后续写入只推进相应存储序号。
10. V2 IPC 关闭后修改目录快照、把两级正文替换为未提交内容并提高 revision，重连的第一份快照仍显示真实已提交文档、稳定章节和原证据。

最新完整 Backend：**414/414** 通过。[日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-storage-final-verified-backend.log)。构建和类型检查通过，Client SDK **1/1** 通过。[Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-storage-final-verified-build.log)、[Backend 类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-storage-final-verified-typecheck.log)、[workbench 类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-storage-workbench-typecheck.log)、[Client 类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-storage-client-typecheck.log)、[Client 测试](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-storage-final-client-tests.log)。测试组有交集，不相加。

最新编译 Backend 的 V2 桌面 IPC：**6/6** 通过，包括高 revision 未提交快照的首次展示核验。[日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-storage-final-verified-desktop.log)。这不代替桌面视觉和真实模型效果验收。

保留了“完全相同的写入没有被拒绝”的失败复现，随后增加 write_version，并通过实际覆盖边界竞争验证修正。[失败复现](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-storage-identical-write-repro.log)、[写序号与归档竞争](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-storage-write-version.log)。

代码与场景：[权威存储](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-commit-store.ts)、[清理生命周期](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-storage-lifecycle.ts)、[故障与恢复测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-storage-authority.test.ts)、[桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)。以上为受控模型和真实 SQLite/IPC 验证；独立投影发布与负向审计的持久化、其他能力与状态入口、实际模型效果及桌面视觉继续验收。

## 统一设计与提示词评审：v0.5

日期：2026-11-17。[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md)的 20 项清单改为“已有基础 / 仍需闭合条件”，避免把原始审计时的问题误读为当前全部缺失。补充独立规划轮、阶段能力投影与分发复核、主模型/整理器总预算、任务状态图、稳定输出分层和训练数据隔离。

Claude 参考范围重新核对为公开系统提示词、宪法及记忆/Skill/子代理机制说明；不使用无法复验的本机快照证明其隐藏实现。自身六类提示词继续按角色分层，Runtime 更新为 `runtime-draft-0.6`，增加互斥控制意图、阶段切换和子结果消费边界，分发资源已同步。

新增[状态与能力评审场景](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/control-scenarios.md)，覆盖规划、人工回复、等待/超时、子结果、未知写入及文档/任务状态分离。场景中的期望行为是验收条件，不是通过记录。

本轮定向测试 **26/26** 通过，覆盖控制协议/提示词资源、单次安全插值、运行时人工恢复与完成门禁、自动整理和模板变量。[测试日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-prompt-design-review-tests.log)。12 份相关文档的本地链接与锚点、20 个缺口编号、6 份提示词版本/资源 hash 检查通过。[文档检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-prompt-design-review-doccheck.json)。

该组与历史回归有交集，不能相加。阶段五的 414/414 和 IPC 6/6 是对应阶段证据；本轮定向通过不替代新增投影发布/负向审计代码的故障、重启、并发验收，也不证明全部能力、等待/子任务、真实模型效果或桌面交互已闭环。

## 阶段六验证：投影发布、原始结果与重试审计

日期：2026-11-17。新增 [16 个存储与运行场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-publication-audit.test.ts)，覆盖：

1. 项目/会话投影先发布、尚未应用 diff 就关闭，重新加载后仍可提交原绑定。
2. 发布两级投影中途 SQL 失败整体回滚，读取基线不丢；失败时模型调用没有发出。通道、session、完整 run/request 的身份分别核验。
3. 冻结项目允许保存只读发布记录，但信息/候选区正文、节点引用和证据不能随之变更；伪造的审核和执行回执不进入权威状态。
4. 项目拒绝审计落盘失败恢复内存；成功保存的原拒绝在重启、独立知识更新和冲突重试后保持原回执。新尝试与冲突各自留痕。
5. 文档与成功审计同事务；审计失败时无半写入知识和成功事件。伪造成功、篡改成功字段及盗用另一幂等 key 的成功回执被拒绝。
6. 交错的两级提案、重放的新 proposalId、混合旧成功/新动作逐一匹配；批次失败保留原成功回执，新动作标为回滚。
7. 整批回滚后，故障解除可在原运行或重启后安全重试；原失败尝试保留负向结果，不被后续成功改写。
8. 会话清理移除全部控制 journal；关闭中的迟到模型响应不再写入，步骤后的 Hook 发布失败以真实失败状态结算。

最新完整 Backend **430/430** 通过。[全量日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-verified-backend.log)。定向 **16/16** 通过。[定向日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-final-focused.log)。最初的 [3 个失败复现](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-audit-repro.log)保留；首次全量也保留了关闭时 SQLite 已关闭导致的[未处理异常](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-full-backend.log)，修正后没有该异常。

最新编译 Backend 的 V2 桌面 IPC **7/7** 通过，新增“发布后先关闭、重连再提交、再次重连核验项目拒绝”的完整场景。[桌面日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-verified-desktop.log)。Client SDK **1/1** 通过。[Client 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-client-test.log)。构建与 Backend/workbench/Client 类型检查结果分别见[构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-final-build.log)、[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-verified-typecheck.log)、[workbench](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-workbench-typecheck.log)、[Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-client-typecheck.log)。测试组有交集，不相加。

本阶段验证受控模型、真实 SQLite 和桌面 IPC；全部 20 项仍持续追踪。独立规划与阶段能力、MCP、全入口副作用门禁、真实等待、异步子任务、其余辅助模式、总预算、真实模型效果和 V2 桌面视觉继续按原设计验收。

文档链接、缺口编号及六份提示词资源一致性检查见[检查结果](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-publication-doccheck.json)。

## 阶段七验证：独立规划与阶段能力投影

日期：2026-11-17。统一设计为 v0.6，Runtime Prompt 为 draft-0.7。实现与门禁入口见 [CapabilityProjection](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-capability-projection.ts)、[阶段/恢复场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-planning-projection.test.ts)及[投影边界](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-capability-projection.test.ts)。

本阶段新增 18 个受控场景，全部包含在最新全量测试中。[场景匹配记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-focused-in-full.json)：

1. 空工具规划 → 接受计划 → 调查读取 → 执行写入 → 验证读回 → 有真实收据的完成请求。实际创建并核对文件，三类阶段分别持有相应能力。
2. 主模型单独请求规划，下一轮工具为空；原生写入、旧 completed 和未知能力的计划均被拒绝。
3. 推理期间任务版本变化、入队后 runner 修改或权限撤销，均在执行前拒绝；后一个批次成员失去权限时，不先执行前一个成员。
4. 规划中的人工问题与任务身份可关闭恢复，回复后仍使用空工具规划轮并继续原 task/run。
5. 已入队调用的授权随快照恢复；权限仍有效则执行，已撤销则拒绝。实际工具回执保留原阶段与投影关联。
6. Workflow 不能通过包装调用未投影工具；普通与 foreach 步骤继承原绑定。既有完整 Workflow 场景继续通过。

最新 Backend **448/448** 通过。[全量日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-final-backend.log)。最新编译 Backend 的 V2 桌面 IPC **8/8** 通过，新增独立规划、问题可见、关闭重连与原任务阶段完成链路。[桌面日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-final-desktop.log)。Client SDK **1/1** 通过。[Client 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-client-tests.log)。

最初全量有 4 项预算失败，保留[原日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-full-backend.log)及[Skill 诊断](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-skill-failure.log)、[训练诊断](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-training-failure.log)。去掉重复元数据并按完整历史/schema 分配文档后，[Skill](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-skill-recheck.log)与[三个纠错场景](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-training-recheck.log)均通过；原 10,000-token 纠错预算、调用次数和业务断言保留。输入计数仍是序列化请求估算，不等于模型 tokenizer 的精确计数。

Protocol/Backend 构建与 Backend/workbench/Client 类型检查通过：[Protocol](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-protocol-build.log)、[Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-final-build.log)、[Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-final-typecheck.log)、[workbench 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-workbench-typecheck.log)、[Client 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-client-typecheck.log)。测试组有交集，数量不相加。文档与六份提示词资源检查见[记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/runtime-stage-doccheck.json)。

本阶段当时仅验证过期调用的真实拒绝；下一阶段补上新投影恢复，不能将拒绝测试本身用作恢复证据。跨来源 MCP、全部间接入口、局部阻塞与状态版本、真实等待、异步子结果消费、辅助模式、总预算、真实模型效果及 V2 桌面视觉继续按全部 20 项目标验收。

## 阶段八验证：过期能力拒绝后的有界恢复

日期：2026-11-17。统一设计 v0.7、Runtime Prompt draft-0.8。宿主只为真实状态、来源版本和权限变化调度新投影；旧调用不自动换授权执行。源代码与场景见 [RuntimeLoop](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/runtime-loop.ts)、[阶段与恢复测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-planning-projection.test.ts)。

本阶段新增 8 个运行场景，并将已有过期拒绝场景推进到新投影后的重新决策：

1. manifest、schema 和 runner 同时变更后，下一轮按新 schema 构造新调用，实际写入并读回验证；旧调用没有分发。
2. 批次首项写入成功后撤销后续读取权限，成功收据和文件保持原结果；拒绝不是执行收据，写入计数始终为一次。
3. Workflow 部分执行后能力撤销，已完成步骤与输出保留，剩余步骤分别拒绝或跳过，外层返回真实失败和部分结果。
4. 恢复一次后关闭重连，原 task/run 与计数保留；持续变更最多恢复三次，第四次拒绝以 RECOVERY_LIMIT 结算。
5. 篡改队列投影仍直接失败，不进入自动重新授权；拒绝结果也不能清除已接受的计划动作或满足完成门禁。
6. 工具准备事件后才撤销权限，仍在 runner 边界拒绝，观察和准备进程如实标为失败；取消发生在恢复事件中时不再发出新模型请求。

最新完整 Backend **456/456** 通过。[全量日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-full-backend.log)。规划/投影/恢复相关 26 个场景均包含于全量结果，[匹配记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-cases-in-full.json)。早期 24 项定向验证保留[日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-focused.log)，与全量有交集，数量不相加。

最新编译 Backend 的 V2 桌面 IPC **9/9** 通过，新增权限撤销后拒绝、恢复信息持久化、关闭重连和人工回复继续原任务的场景。[桌面日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-desktop.log)。Client SDK **1/1** 通过。[Client 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-client.log)。Backend 构建与 Backend/workbench/Client 类型检查通过：[构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-build.log)、[Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-final-typecheck.log)、[workbench 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-workbench-typecheck.log)、[Client 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-client-typecheck.log)。

首次定向验证保留了旧测试仍期望直接终止的[失败记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-initial-focused.log)；随后改为验证拒绝后重新决策，并保留伪造、越权和未完成义务的负向断言。测试代码补齐类型标注后，最终类型检查通过。文档及六份提示词资源检查见[记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/capability-recovery-doccheck.json)。

这是受控模型、真实文件/SQLite 与桌面 IPC 的验证。MCP、全部间接副作用入口、局部阻塞、真实等待、异步子结果消费、其余辅助模式、总预算、真实模型效果和 V2 桌面视觉仍按全部 20 项追踪，不作整体完成声明。

## 阶段九验证：真实 MCP 与副作用预登记

日期：2026-11-17。统一设计 v0.8、Runtime Prompt draft-0.9，新增 [MCP 运行设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md)。当前采用实际安装并锁定的官方 Client 2.4.0；服务端测试使用独立真实进程和本地 HTTP 服务，不以自定义项目 stdio runner 替代 MCP。

新增 20 项 Backend 场景全部包含于最新全量测试，[匹配记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-cases-in-full.json)，覆盖：

1. 真实 stdio 分页发现、普通调用和 RPC ID 对照；真实现代 Streamable HTTP、环境引用凭据和接收字节限制。
2. 服务自报名称相同、工具名相同时仍保持独立身份；远端只读声明不覆盖宿主权限、副作用、加载状态或子代理边界。
3. schema 变化、真实 tools/list_changed、断连和重新发现；旧调用不重放，新连接使用新身份。
4. 业务错误、无效输出、无效 RPC、非 JSON stdout 无回复和超时，均不产生虚假成功；SDK 忽略非 JSON 行时保留真实超时结果。
5. 写入超时/取消后的未知记录、同参数重复拦截；真实 SQL 在业务 RPC 前登记，空快照或另一个连接不能清除未结算记录。
6. 登记故障阻止实际写入；远端成功而最终 SQL 结算故障时，保留真实成功与未结算状态；清理/墓碑拒绝旧运行恢复记录。
7. RuntimeLoop 的发现/加载/调用/候选与收据、缺少权限拒绝、调查阶段过滤写入、关闭重连后重新决策，以及未知写入阻止正常完成。

最新 Backend **476/476** 通过。[完整日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-final-backend.log)。最新编译 Backend 的 V2 桌面 IPC **10/10** 通过，新增真实 MCP 调用、来源保留、关闭重连、能力重新发现和原 task/run 人工回复完成链路；关闭会等待传输退出。[桌面日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-final-desktop.log)。Client SDK **1/1** 通过。[Client 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-client-sdk.log)。测试组有交集，数量不相加。

完整回归首次为 475/476，保留了原 Skill 场景的 CONTEXT_UNCOVERED_HISTORY_BUDGET，[原日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-full-backend.log)。在实际请求中省去未配置 MCP 的空状态，并对激活 Skill 的同版本参考正文去重后，原场景及新增“原件仍为全文”的断言通过；预算、消息组与业务完成条件保留。[场景回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-skill-budget-final.log)。

最初真实协议检查也保留[失败记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-client-initial-tests.log)；修正 SDK handler.fetch 和服务上下文实际 RPC ID 的使用。协议错误与被 SDK 忽略的非 JSON 行分别验证，不混写同一错误标签。

Protocol/Backend 构建及 Backend/workbench/Client 类型检查通过：[Protocol](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-protocol-build.log)、[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-final-build.log)、[Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-final-typecheck.log)、[workbench 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workbench-typecheck.log)、[Client 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-client-sdk-typecheck.log)。文档、20 项编号与六份提示词资源检查见[记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-doccheck.json)。

该阶段证明真实协议与受控运行路径；全部 20 项仍保持原目标。未知结果的业务核查及受信结算、通用人工输入/等待、全入口副作用、异步子任务、辅助模式、统一预算、训练质量、真实模型效果和 V2 桌面视觉继续验收。

## 阶段十验证：内部权限与候选导入边界

日期：2026-11-17。统一设计 v0.9、Runtime Prompt draft-0.10。权限、代码执行和子候选边界集中记录在[统一设计第 6.4 节](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#64-内部能力脚本和间接入口的权威)。参考来源仍为第 3 节核对的 Claude 公开文本，使用其分区组织方式，按本系统的文档与运行协议设计。

新增 12 项 Backend 场景包含于最新完整回归，见[内部能力场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-internal-authority.test.ts)和[Hook RPC 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/hook-framework.test.ts)。验证了：

1. 缺少真实权限时，内部写入、代码执行和 Skill 引用不能进入实际工具投影；allowed-tools 不产生授权，模型伪造调用在分发前拒绝。
2. 获准脚本真实执行且只写入一次；时间线和收据保留权限、副作用与重放合同。只读子代理和冻结资产拒绝普通脚本。
3. 命令校验后撤权、加载事件后撤权或换版，都在启动前拒绝；模型入队后脚本变化必须取得新投影重新决策，旧脚本没有执行。
4. 即使 Worker 直接构造宿主 LLM RPC，缺少注册权限也不调用模型；原有获准 LLM 桥接场景继续通过。
5. 导入声称成功的子内容仅形成 pending；既有真实失败、子生命周期和知识文档不被改写，关闭恢复仍保持分离。

最新完整 Backend **488/488** 通过。[完整日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-full-backend.log)。内部能力与 Hook 定向 **36/36** 通过，[定向日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-hooks-focused.log)。新增 12 场景逐一匹配完整结果，见[文档与场景检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-doccheck.json)。测试组有交集，数量不相加。

最新编译 Backend 的 V2 桌面 IPC **11/11** 通过，新增缺少权限拒绝直接脚本、允许读取参考文件、子候选导入和关闭重连不制造完成的场景。[桌面日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-desktop-verified.log)。Client SDK **1/1** 通过。[Client 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-client.log)。Backend [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-build.log)与 [Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-final-verified-typecheck.log)、[workbench](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-workbench-typecheck.log)、[Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-client-typecheck.log)类型检查通过。

最初定向测试的 Skill 配置误用了文件路径，保留[失败日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-focused.log)，改为注册表要求的目录后通过。新增测试的可选 children 类型标注在[首次类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/internal-authority-final-typecheck.log)中失败，修正标注后最终检查通过；业务断言保留。

CAP-04 与 CTL-05 继续保持推进中。权限合同不能证明任意代码被 OS 隔离；候选保存不能证明外部子身份、原件和证据已验证，也不替代父层消费记录。其余间接入口、副作用预登记/未知结算、真实等待、异步子任务、辅助模式、总预算、真实模型效果与 V2 桌面视觉继续按全部 20 项追踪。

## 阶段十一验证：真实等待、期限与恢复

日期：2026-11-17。统一设计 v0.10、Runtime Prompt draft-0.11。新增[等待运行协议](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-wait-runtime-design.md)，注册与下一模型游标的 checkpoint 同事务保存；真实控制记录仍与知识文档分离。

新增 23 个 Backend 场景见[运行测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-wait.test.ts)和[SQL 测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-wait-store.test.ts)，覆盖：

1. 全部关联满足、部分信号持续等待、重复幂等、冲突 ID 拒绝；普通恢复、新 run、步骤重启和 checkpoint 回退不能提前结束等待。外部入口不能占用宿主信号命名空间。
2. 宿主真实时钟、期限绑定、重复操作不延长窗口、关闭期间到期、迟到信号不改写超时。
3. 先完成后订阅的工具/进程事件、关闭期间外部信号、原 task/run 恢复，以及按需读取完整信号正文。
4. 客户端不能声明 tool/runtime 身份，其他 task/run 的事件不匹配；所有来源保留真实语义。
5. 取消订阅、取消 run、信号刚满足时用户立即取消；旧快照不复活已取消 run，已观察的信号结果也不被重标。显式取消后回退工作 checkpoint 不恢复旧订阅。
6. SQL 登记与结算故障整体回滚；相同事件故障解除后可安全重试。清理同时移除控制表并用墓碑拒绝旧连接。
7. 注册前真实关闭留下的意图不制造订阅，恢复显示中断并取得新决策；修复未推进的游标，保留原有两轮模型断言。

最终完整 Backend **511/511** 通过，[完整日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-boundaries-backend.log)。等待定向 **23/23** 通过，[定向日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-boundaries-verified-focused.log)。23 场景逐一匹配完整结果，见[文档与场景检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-doccheck.json)。原先 [509/509 回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-full-backend.log)没有包含后来发现的注册前崩溃与 checkpoint 场景，不能用它代替最终验证。

最新编译 Backend 的 V2 桌面 IPC **12/12** 通过，[桌面日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-boundaries-desktop.log)。新增完整链路验证两个来源的部分命中、拒绝普通恢复/伪造来源、关闭重连、匹配剩余来源、重复事件去重，以及再次重连后原任务仍为 completed。Client SDK **1/1** 通过，[Client 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-frozen-client.log)。各组有交集，数量不相加。

Protocol [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-frozen-protocol-build.log)、Backend [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-boundaries-build.log)与 [Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-boundaries-typecheck.log)、[workbench](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-workbench-typecheck.log)、[Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-client-typecheck.log)类型检查通过。六份分发提示词与评审源内容一致，Runtime 为 draft-0.11。

最初桌面用例因等待器仅匹配事件类型而提前读取绑定，保留[失败日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-desktop.log)；改为同时匹配目标状态后，[桌面定向场景](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-desktop-focused.log)通过。注册前崩溃的最初测试发现多一次模型调用，保留[复现](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-pre-registration-crash.log)；修复游标后，[原断言通过](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-pre-registration-crash-verified.log)。

回退场景明确使用 run.cancel → restoreCheckpoint → run.resume：取消订阅会调度新判断，不能当作同步暂停。对应的[首次失败](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/wait-control-boundaries-focused.log)保留；最终验证保留模型两轮及旧订阅不复活的断言。

本阶段仍是受控模型、真实时钟/SQLite 和 V2 Backend IPC 的机制验证。所有 20 项继续追踪；分支调度、异步子句柄、其余辅助角色、未知副作用结算、总预算、实际模型收益与桌面视觉需要各自的完整证据。

## 本轮继续核查的真实缺口

- 归档原件已接入统一检索与候选回填；关键词检索的召回覆盖率、排序、超大索引性能和实际任务收益仍需评测，独立辅助 Recall 模式也仍需接通。
- 审核、显式编辑、恢复和普通模型提交的每个入口都要遵循同一权威存储。主要写入、恢复和清理已有故障与并发验证，继续检查其余发布与审计入口。
- 并发 CAS、快照权威、清理、独立发布与负向审计的主要链路已有故障和重启验证；继续核查其余能力入口是否使用相同持久化门禁，以及持续运行中的规模和延迟。
- 关键活动条目的投影保护防止静默丢失，但长期任务仍需依靠归档/召回收敛预算；单纯预算不足时报错不证明长任务可持续。
- 来源分片已有字符上限，但整理器的总请求预算还需计入两级投影、schema 和原任务 system_prompt 等只读信号，按所选小模型上下文与输出预算验收；不能只测 cache 分片长度。
- strict JSON、来源绑定与提交成功证明的是结构和执行结果。语义保真、真实模型的压缩收益和解题质量仍需独立评测。
- 独立规划、阶段投影、有界恢复与真实 MCP 已有验证；继续统一其他间接入口、分支阻塞、负责人和各类状态事件，打通未知结果的业务核查与受信结算。
- 测试中的受控 LLM 验证运行路径，不能代替真实主模型/小模型训练效果，也不能代替 V2 Electron 界面验收。

本次提示词设计的来源、取舍和完整角色边界已补入[统一设计第 3 节](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#3-claude-的哪些做法值得参考)和[提示词目录](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/README.md)。上述 20 项仍按原目标全部追踪，当前没有作整体完成声明。

## 本次文档统一：缺口与提示词调用契约

日期：2026-11-17。统一设计更新为 v0.11，提示词目录为 v0.10，新增[角色调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)。保留原有 20 项编号，按信息承接、能力使用、任务控制、效果与训练提供统一评审入口；六份模型正文的版本与分发资源保持原绑定。

重新核对 Anthropic 的公开系统提示词、宪法、记忆、Skill 和子代理资料，公开产品说明与 Capybara 自身设计分别记录。调用契约补齐指令/证据/价值的区别、两级递归文档、主/辅助轮装配、角色调用条件、父层消费和总预算，不把设计说明全文重复注入模型。

文档统一时保留的[两项定向检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-human-recovery-diagnostic.log)为 1 通过、1 失败。后续已确认父等待与子请求开始是两个事件，关闭恢复测试改为等待真实请求在途；原断言在阶段十二完整回归中继续验证。阶段十一的 511/511 与桌面 12/12 属于此前冻结基线，不覆盖之后改动。

本次检查范围为文档、链接、JSON 示例、20 项编号与六份提示词源/资源一致性；结果见[检查记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/prompt-gap-review-doccheck.json)。该检查不替代代码回归、真实模型任务效果或 V2 Electron 视觉验收。

## 阶段十二验证：异步子任务、原件与父层消费

统一设计 v0.11，Runtime Prompt draft-0.12。新增[子任务运行协议](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-child-runtime-design.md)与[提示词调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)。主轮、Organizer、Reflection、Dream、Child 的权威边界按全部 20 项原目标维持，新增代码不代替其余受限模式的实际调用。

本阶段新增 22 项 Backend 场景，分别见[父子运行](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-child.test.ts)、[SQL 与原件](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-child-store.test.ts)及[有效期限投影](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-wait.test.ts)：

1. 默认异步委派返回真实句柄，父层完成独立检索后注册真实等待；读取原件、后续轮消费，再经过父完成门禁。
2. 运行中或成功但未消费的子任务阻止完成；未读时不投影消费工具，伪造读取回执不能审核结果。accept 不确认事实，候选继续为 pending。
3. 真实时钟超时、取消、迟到回调和旧租约不制造成功；原始结果保留，迟到另存。失败不能被 accept，needs_more_evidence 保持阻塞。
4. 本地子任务正常完成与 ask_user 分离；必要输入按真实请求回复并旋转 waitRef，最终保留同一 child run。
5. 关闭期间原请求仍在途，再打开按原子 run/checkpoint 与预算恢复；旧回调不能改写当前结果。轮次/累计 token 预登记不因换 worker 重置。
6. 委派幂等与参数冲突、跨父 task 拒绝、读取/消费不同模型轮、审核回执不可覆盖，以及 SQL 登记/结算故障回滚。
7. 不可变子结果原件与历史消息分离；清理移除控制表、拒绝旧写入，项目实际引用的原件继续通过新 session 的真实工具分页读取并验证哈希。
8. 模型状态视图保留全部 active/unknown 进程，完整桌面账本不裁剪；超过三个的有效期限仍完整可见。已结算重复元数据精简，不提高预算或删除任务义务。

早期[恢复失败](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-human-recovery-diagnostic.log)来自在父等待后立即断言子模型已经开始。测试改为等待真实请求开始后关闭，保留原次数、子 run 和预算断言。[首次原件/投影用例](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-source-projection-focused.log)缺少项目初始化；临时测试曾挂起并被终止，随后补齐初始化与快照/权威活动状态的一致性。正式回归继续验证原件与完整账本。

原[桌面委派用例](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-desktop-initial.log)假定子层可使用父层未投影的目录工具；改为父层先实际加载，再授予子层。新增异步场景又暴露了[输入超预算](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-desktop-budget-detail.log)：精简重复控制绑定和已结算视图，完整来源与控制账本保留。

提示词更新后的[首次组合回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-prompt-final-backend.log)包含约 435 万毫秒的异常耗时，同期工具执行环境发生重置；这些超时与文件占用不能作为通过证据。该轮同时发现了独立的桌面窗口和自动训练累计预算失败。去除 Runtime 的重复输出说明、缩短委派说明后，[原 4 项训练场景](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-prompt-training-verified.log)通过，原预算、重试上限与业务断言保持。

最终提示词组合完整 Backend **533/533** 通过，[完整日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-accepted-backend.log)。新增 22 场景逐一匹配全量结果，六份提示词源/分发 hash 一致，Runtime 为 draft-0.12，见[组合检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-acceptance-check.json)。早期 533/533 和 532/533 属于前面不同组合，不能代替本次最终结果。

最新编译 Backend 的 V2 桌面 IPC **13/13** 通过，[桌面日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-accepted-desktop.log)。其中异步场景验证父层独立工作、真实等待、读取、后续轮消费与双方主张保留；原委派场景保留真实子工具轨迹和完整来源引用。Client SDK **1/1** 通过，[Client 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-client.log)。测试组有交集，数量不相加。

Backend [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-accepted-build.log)与 [Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-accepted-typecheck.log)、[workbench](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-workbench-typecheck.log)、[Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-client-typecheck.log)类型检查通过。文档、JSON、递归正文与本地链接检查见[记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/prompt-gap-review-doccheck.json)。

最后的[532/533 回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-frozen-full-backend.log)保留了子任务提问后接近窗口边界的失败。整理读取回执的重复身份字段后，完整身份仍保存在不可变原件与真实账本中，[原用例](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-question-source-ref-verified.log)及最终全量通过；未提高窗口或减少断言。恢复时清除当前挂起错误、终态清除有效输入请求，避免成功包带有过期控制错误；原始事件与迟到记录继续保留。

CTL-05/06 继续验证外部宿主来源/恢复、全部间接权限与输入异常；其余角色调用、分支调度、未知副作用结算、统一总预算、训练语义与数据准入、真实主/小模型收益和 V2 Electron 视觉仍按全部 20 项追踪。本阶段没有将完整目标标记为完成。

## 阶段十三验证：独立反思与辅助调用账本

统一设计 v0.12、提示词目录 v0.11；Runtime 仍为 draft-0.12，Reflection 更新为 draft-0.2。新增[辅助调用协议](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-auxiliary-runtime-design.md)。实际反思由失败依据触发，在下一主轮前独立执行，原提示词与动态数据只读，建议通过消费检查后供主模型判断，不执行纠正或知识提交。

新增 21 项 Backend 场景，见[辅助账本/生命周期](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-auxiliary.test.ts)和[反思运行](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-reflection.test.ts)：

1. 真实主轮工具失败 → reflect → 独立只读辅助模型 → 诊断与建议 → 主轮继续；原事实、消息与工具历史不改写，实际 usage 单独记录。
2. 缺少失败依据时不调用；伪造来源/evidence、无效 JSON、工具意图和错误快照不能成为合格建议。有效 diff 也只作为候选输出。
3. 任务/文档并发更新使结果 stale，来源仍留存；旧失败不能在新尝试成功后继续冒充当前状态，旧审计仍保留。
4. 主轮获得完整输出，包括所有重试前提、依赖、证据请求和未知项，不能靠缩减摘要达成预算。
5. 调用幂等、同 ID 不同语义拒绝、跨 task 拒绝、完整输入自校验、累计预留和三次反思上限；关闭重连不退还预算。
6. SQL 登记故障阻止 provider 调用；结算故障不能制造成功，原响应保留为未提交审计。
7. 真实期限、关闭、登记事件中关闭、迟到输出、失去所有者和新连接均保留真实语义；活动所有者不被抢占，pending 辅助调用阻止完成。
8. 清理移除辅助调用/事件并拒绝旧连接；候选建议、宿主控制与不可变原件分别保存。

初始[辅助测试](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/auxiliary-foundation-tests.log)有 4 项通过、4 项取消：foreground 调用的期限定时器不能 unref 后让进程在等待中退出。修复后[原 8 项](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/auxiliary-foundation-verified.log)通过。初始[反思运行](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-initial-runtime.log)曾未能进入预期调用并中止；核对到工具正常返回 ok=false 也是真实失败，补充该识别后[首例](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-first-scenario-diagnostic.log)与后续场景通过。没有把被中止的检查当作完整验收。

此前[552/552](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-full-backend.log)与[553/553](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-accepted-backend.log)属于中间组合。补齐主轮完整接收重试前提/依赖/未知项后，[定向 21/21](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-preserved-output-focused.log)通过。最终组合以本节后续登记的完整日志为准。

最终完整 Backend **554/554** 通过，[完整日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-final-backend.log)。21 项新场景逐一匹配完整结果，保留六份提示词版本/hash 和当前核心源文件 hash，见[验收检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-acceptance-check.json)。检查未将其他辅助模式或真实模型质量标为完成。

最新编译 Backend 的 V2 桌面 IPC **14/14** 通过，[桌面日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-final-desktop.log)。新增失败读取 → 独立反思 → 主轮诊断完成 → 关闭重连 → 读取原始反思来源的场景；helper 恢复后不重放，项目/会话事实未被反思改写。Client SDK **1/1** 通过，[Client 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-client.log)。测试组有交集，不相加。

Backend [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-final-build.log)与 [Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-final-backend-typecheck.log)、[workbench](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-workbench-typecheck.log)、[Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/reflection-client-typecheck.log)类型检查通过。文档及全部 20 项编号、JSON、递归正文、链接与提示词分发资源检查见[记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/prompt-gap-review-doccheck.json)。

全部 20 项目标继续有效。CAP-01 仍需 Normalize、Dream、Recall 选择和 Parent Merge 的独立调用适配；分支调度、未知副作用结算、统一总预算、训练准入/导出、真实模型和 V2 Electron 视觉分别补齐证据，不由本阶段测试推定完成。

## 阶段十四验证：整理辅助模式与模型配置

日期 2026-11-18。统一设计 v0.13，Organizer draft-0.5，Dream draft-0.2。四种辅助模式进入实际运行路径，沿用独立辅助调用账本。项目设置支持 `context_assistant_modes` 和 `context_assistant_profile`，宿主也可提供模型和预算。[辅助调用与配置](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-auxiliary-runtime-design.md)

新增 10 项 Backend 用例覆盖下列行为。

- Normalize 提供原片段绑定建议，Organizer 同时获取原文及 A、B 两方信息，合法无操作保留原历史。
- Recall 在写入候选前从真实命中选择，覆盖正常命令、真实工具轮、伪造 ID 标注及词项回退、项目并发变化、重复命令和项目模型 HTTP 路由。
- Parent Merge 读取已保存的真实子来源，返回会话提案原件，父层继续用实际回执消费分歧。
- Dream 从空闲快照发布建议，训练冻结拒绝项目归档，前台启动取消原调用，迟到返回保留在审计中。

Backend 完整回归 **564/564**。V2 桌面 IPC **15/15**，新增模型选择召回候选、关闭重连以及候选状态恢复。Client SDK **1/1**，Backend 构建和类型检查通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-assistant-final-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-assistant-final-desktop.log) · [Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-assistant-modes-client.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-assistant-final-build.log) · [类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-assistant-final-typecheck.log)

本阶段验证了模式调用和来源提交机制。整体 20 项继续追踪。待验收条件包括真实小模型保真与主模型下游质量、统一总预算、分支调度、外部副作用处理、训练准入和 V2 界面交互。

## 阶段十五验证：共享模型额度与真实发送门禁

日期 2026-11-18。统一设计 v0.14。SQLite 按父级会话、任务和运行保存第一次获准时的额度。实际发起请求的会话和角色可从账本核对。项目可设 token 与次数上限。内置模型客户端在发送前按完整负载和输出额度预留，关闭或恢复不退回未知消费。[设计与配置](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#62-统一预算)

- 新增 5 项测试，覆盖 HTTP 重试拒绝、SSE 配置切换与回报、完整负载计数、两连接竞争同一额度与清理阻断、项目限额耗尽和恢复。所用 HTTP 服务在本机运行，验证了真实网络边界。[模型预算测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-model-budget.test.ts) · [运行时限额测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-planning-projection.test.ts)
- 现有规划、子运行和 Normalize 场景增加共享账本断言。规划与执行同用额度，子模型按父级运行记账，主轮、Normalize 与 Organizer 同用一次运行的账本。耗尽时保留已经完成的读取观察，运行以 `RUNTIME_MODEL_BUDGET_EXHAUSTED` 结束。[子任务测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-child.test.ts) · [辅助模式测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-assistant-modes.test.ts)
- 首次回归定位到非枚举回调被包装成普通字段，恢复字段行为后通过定向回归。高并发的全量回归出现超时，使用 `--test-concurrency=2` 后完整 Backend **569/569**。V2 桌面 IPC **15/15**，Client SDK **1/1**，Backend 构建和类型检查通过。[首次回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/model-budget-first-backend.log) · [全量日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/model-budget-concurrency2-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/model-budget-final-desktop.log) · [Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/model-budget-final-client.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/model-budget-final-build.log) · [类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/model-budget-verified-typecheck.log)

真实模型 tokenizer、分语言校准、长任务质量、训练准入与导出、分支调度、外部副作用确认和 V2 界面交互仍需各自验收。宿主替换模型只能计入可见调用，传输级计数依赖宿主模型支持发送前准入。

## 阶段十六验证：计划节点的局部阻塞与恢复

日期 2026-11-18。统一设计 v0.15，Runtime draft-0.13。与根任务控制兼容，局部 `ask_user` 和 `wait` 按本轮 `activeTaskIds` 绑定。SQLite 在订阅事务中保存下一模型轮游标。局部问题只接受绑定原请求的会话消息，其他分支按依赖和阶段继续。工作台输入框显示待回复分支，发送时携带选择的 `humanRequestId`。[状态设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#731-真实等待) · [等待协议](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-wait-runtime-design.md)

- Backend 场景覆盖人工问题等待时独立写入、关闭重连后同一 run 回复、拒绝伪造及重复回复、两个外部订阅逐个恢复，以及真实子任务就绪后读取和父层消费。计划完成继续受实际动作和证据约束。[计划分支](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-planning-projection.test.ts) · [异步子任务](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-child.test.ts)
- 首次全量通过 571 项，原有子代理人工回复场景触发窗口门禁。删减模板中重复的规划说明后，同一原有场景成功进入后续模型轮，估算输入从 13,752 降至 13,676，保留原工具组和消息。[首轮日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/branch-control-full-backend.log) · [定向重测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/branch-control-child-budget.log)
- V2 桌面 IPC **16/16**，其中新增真实 Backend 关闭重连后从工作台取得同一个问题 ID、绑定回复并进入原任务。输入框协议测试 **4/4**。Client SDK **1/1**，Backend 构建、Backend 与工作台类型检查通过。[IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/branch-control-final-desktop.log) · [输入框协议](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/branch-control-composer.log) · [Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/branch-control-client.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/branch-control-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/branch-control-final-typecheck.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/branch-control-workbench-typecheck.log)
- 最终 Backend 全量 **572/572**，包括 3 项新增分支场景和恢复通过的原有子代理人工回复。文档 20 项编号、JSON 示例、资源链接与六份提示词分发文件一致性检查通过。[全量回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/branch-control-final-backend.log) · [文档和提示词检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/prompt-gap-review-doccheck.json)

仍需验证局部补证据、计划负责人和真实子句柄绑定、外部服务生产者、桌面实际交互及训练效果闭环。

## 阶段十七验证：计划节点、真实子句柄与依赖解锁

日期 2026-11-18。统一设计 v0.16，Runtime draft-0.14。计划委派绑定当前活动节点，子能力取父实际投影与节点的只读交集。SQLite 同时保存子句柄、派发时的计划和权限合同。调度器从账本核对归属，在 `delegation` 阶段提供必要的控制与审核能力。[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#74-任务拆解与子代理) · [子任务协议](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-child-runtime-design.md)

- 新增 4 项 Backend 用例覆盖邻接节点能力泄漏、依赖未就绪、批量混派拒绝、较旧父快照恢复、同一节点跨连接唯一派发、拒绝后再派发，以及接受回执和原计划证明共同解锁依赖。真实 child.ready 场景补了节点归属、评审专用投影和接受后重连断言。[运行测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-child.test.ts) · [账本测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-child-store.test.ts) · [计划验收测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-control.test.ts)
- MCP 的实际连接版本继续按连接变更。新的委派合同版本覆盖配置、受管理实现文件与远端工具定义，等价重连保持合同版本，schema 变化使其更新。实际工具调用继续以子运行自己的连接投影核验。[MCP 版本测试](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/mcp-client-manager.test.ts)
- Backend 全量 **576/576**，V2 桌面 IPC **17/17**，Client SDK **1/1**。新增 IPC 场景通过真实本地子运行执行授权查询，父层读取及接受后关闭重连，子句柄、节点归属和消费状态一致。Backend 构建、Backend 与工作台类型检查通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-plan-full-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-plan-desktop.log) · [Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-plan-client.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-plan-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-plan-final-typecheck.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/child-plan-workbench-typecheck.log)

父层接管后的动作归属、局部证据请求、真实外部宿主恢复与完整训练和界面验收继续追踪。

## 阶段十八验证：按节点补证据与来源回执

日期 2026-11-18。统一设计 v0.17，Runtime draft-0.15。局部 `evidenceRequests` 按计划节点与来源类型登记。同批请求共享一个 SQLite 恢复游标，各自结算。未收到的请求继续阻塞对应节点，其他就绪节点仍可执行。只余采集工作时进入只读 `evidence` 阶段。[协议](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-wait-runtime-design.md#31-局部补证据)

- 新增 4 项 Backend 场景。覆盖同时等待用户和外部观察、仅收到部分材料仍等待、独立分支完成、关闭后按原绑定恢复、伪造工具观察与召回 ID 拒绝、实际原件与召回回执校验，以及整批事务回滚和单游标恢复。[分支场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-planning-projection.test.ts) · [召回](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-recall.test.ts) · [SQLite](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-wait-store.test.ts)
- 工作台命令保留用户已选问题的请求 ID。V2 IPC 新增补证据问题关闭重连和绑定回复测试，并在本地子运行场景中验证子原件提交后，父层仍经独立读取和消费验收。受控外部材料保持为带来源声明的候选。[桌面场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)
- Backend **580/580**、V2 桌面 IPC **18/18**、工作台输入框协议 **4/4**、Client SDK **1/1**，Backend 构建以及 Backend 与工作台类型检查通过。设计索引 20 项编号及六份提示词分发资源一致。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/scoped-evidence-full-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/scoped-evidence-desktop.log) · [输入框](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/scoped-evidence-composer.log) · [Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/scoped-evidence-client.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/scoped-evidence-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/scoped-evidence-final-typecheck.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/scoped-evidence-workbench-typecheck.log)

真实外部服务接入、父层接管、训练效果及实际桌面交互继续按统一目标验收。

## 阶段十九验证：父代理接管与依赖验收

日期 2026-11-18。统一设计 v0.18，Runtime draft-0.16。父层审核拒绝或冲突后，可单独请求接管当前节点。持久账本保留子任务终态、审核与接管各自的回执。接管轮隔离当前节点，保留原能力和完成义务。模型须提交带有本节点新成功动作的计划更新，宿主核对原件后才释放依赖。[子任务协议](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-child-runtime-design.md#41-父代理接管) · [提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- Backend 新增 3 项场景，覆盖伪造审核回执及重复派发拒绝、接管记录跨连接恢复、原义务保留，以及旧快照恢复时同一工具只执行一次。恢复后复用原件 ID 和哈希，再按新动作验收节点并释放依赖。[运行场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-child.test.ts) · [账本场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-child-store.test.ts) · [完成门禁](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-control.test.ts)
- V2 桌面 IPC 新增失败子结果、父层接管与重连快照场景。重连保留原 run、节点归属、失败和审核记录，同时保留与父层成功动作一致的接管 ID。[桌面场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)
- Backend **583/583**，V2 桌面 IPC **19/19**，工作台输入框协议 **4/4**，Client SDK **1/1**。Backend 构建以及 Backend 与工作台类型检查通过。定向重测使用区分业务轮和整理轮的模拟模型。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/parent-takeover-final-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/parent-takeover-final-desktop.log) · [输入框](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/parent-takeover-composer.log) · [Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/parent-takeover-client.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/parent-takeover-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/parent-takeover-verified-typecheck.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/parent-takeover-workbench-typecheck.log)

真实外部宿主、未知副作用结算、实际桌面交互及训练效果继续按统一目标验收。

## 阶段二十验证：Skill 版本绑定与引用恢复

日期 2026-11-18。统一设计 v0.19，Runtime draft-0.17。Skill 入口文件、正文和注册资源索引绑定 `sourceVersion`，模型工具的引用读取回执携带该版本与正文哈希。恢复和项目资源重载时核对两者，只有一致的引用才保留已加载状态。历史结果保留原件，发送给模型的引用去重还要求本轮正文实际可见。[设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#65-skill-正文引用与投影生命周期) · [提示词目录](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/README.md)

- WebSocket 场景覆盖实际模型请求、版本化读取回执、原始引用原件、Skill 入口换版后的关闭重连，以及同版入口下引用文件修改后的重载。V2 桌面 IPC 场景核验同版引用的正文与哈希恢复、引用改版后重新激活读取状态，以及进程权限拒绝仍有效。[Backend 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/app.test.ts) · [桌面场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)
- Backend **583/583**，V2 桌面 IPC **19/19**，Backend 与协议构建、Backend 与工作台类型检查、提示词分发一致性校验通过。IPC 首轮将省略的可选字段计作差异，重测核对已加载状态、正文与哈希。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-versions-full-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-versions-final-desktop.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-versions-build.log) · [协议构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-versions-protocol-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-versions-final-typecheck.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-versions-workbench-typecheck.log)

CAP-05 后续验收覆盖阶段内的 Skill 正文保留、完整模型请求预算、引用分页恢复和卸载边界。其他缺口继续使用第 4 节的 20 项设计索引。

## 阶段二十一验证：Skill 阶段投影、分页与卸载

日期 2026-11-18。统一设计 v0.20，Runtime draft-0.18。模型激活按当前任务、阶段和节点绑定，摘要目录、会话激活以及模型请求分别记录。主模型预算按完整渲染和未承接的消息、工具 schema 计算。超长正文从工具原件分页读取，版本和哈希随原件保存。卸载撤销从该 Skill 独占加载的工具，共用和独立加载的工具继续有效。[设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#65-skill-正文引用与投影生命周期) · [提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- 新增三个真实 RuntimeLoop 场景。验证规划轮只见目录、实际引用在同一节点重连后恢复、下一阶段拒绝读取另一节点的 Skill，历史观察仍保留。预算场景验证同一请求保留能放下的小正文和小引用，超长原件继续可读。卸载场景验证重连后的专属、共用和显式附件。[场景代码](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-planning-projection.test.ts)
- 首轮全量发现异步委派的序列化预算回归。修正后按实际 JSON 请求的超额重新分配可选文档空间，保留原窗口和必需条目校验。异步委派与三个 Skill 场景定向 **4/4**，最新全量也通过这些场景。[首轮 Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-final-backend.log) · [预算重测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-budget-recheck.log)
- 最新 Backend 全量 **584/586**。Workflow 用例等待超时，实验评分用例未进入预期的评分取消路径。相同代码单独重跑这两个用例各 **1/1**。V2 桌面 IPC **19/19**，包括专属 Skill 工具卸载。工作台输入框协议 **4/4**、Client SDK **1/1**，Backend 与协议构建、Backend 与工作台类型检查及六份提示词分发一致性校验通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-verified-backend.log) · [Workflow 重测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-workflow-isolated.log) · [评分重测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-scorer-isolated.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-verified-desktop.log) · [输入框](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-composer.log) · [Client](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-client.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-budget-build.log) · [协议构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-protocol-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-budget-typecheck.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/skill-stage-desktop-typecheck.log)

真实模型的资源选择与长任务质量、外部副作用结算、训练数据准入和 V2 桌面实际交互继续验收。

## 阶段二十二验证：MCP 未知写入核查与结算

日期 2026-11-18。统一设计 v0.21，Runtime draft-0.19。写入预登记绑定当时的同服务只读核查合同和原操作 ID。宿主核对本轮实际授权、原操作身份及真实只读 RPC，原件和回执原子保存。`applied` 验收原动作，`not_applied` 允许新调用进入当前授权门禁。原请求、迟到回执和核查证据可分别追溯。[协议](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md#41-核查未知写入) · [提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- Backend 新增两条真实本地 stdio 场景。覆盖写入生效后断连、从旧工具快照重呈现原操作、不同操作 ID 的核查不能结算、确认未生效后拒绝再用旧调用 ID、明确新调用后只写一次、跨会话不可读取及迟到结算拒绝。另增 V2 桌面 IPC 场景，核对待处理操作事件、真实核查和重连后的原运行状态。[Backend 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/mcp-runtime.test.ts) · [桌面场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)
- 兼容传输的有效 MCP 响应可以省略结果类型，宿主继续要求实际 `structuredContent`、匹配操作 ID 和终态值。新恢复场景最多等待 60 秒走完整个 stdio 和重连流程，生产运行配置沿用原超时策略。[初次定向结果](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-verification-focused.log) · [兼容重测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-verification-recheck.log)
- 最终 Backend 全量 **588/588**、V2 桌面 IPC **20/20**，Backend 与共享协议构建、Backend 与工作台类型检查及提示词分发校验通过。前次全量的 WebSocket Hook 测试等待超时在最终全量通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-verification-verified-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-verification-final-desktop.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-verification-final-build.log) · [共享协议](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-verification-protocol-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-verification-final-typecheck.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-verification-desktop-typecheck.log)

部署服务核查合同、人工协助和等待联调、Workflow 内部恢复及其他外部写入入口继续按统一目标验收。真实主/小模型结果和桌面实际交互另留证据。

## 阶段二十三验证：Workflow 的 MCP 恢复与原结果补读

日期 2026-11-18。统一设计 v0.22，Runtime draft-0.20。Workflow 未知写入返回部分结果。模型核查原 operationId 后以新投影续跑同一 Workflow。已成功的写入输出可从 SQLite 复用，已核查生效的写入用真实原结果，未生效的写入使用相同参数哈希与新调用身份。缺失原输出时继续独立步骤，依赖缺失值的节点等待实际补读。补读保留原回执 ID，单独绑定原件。[MCP 设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md#42-恢复-workflow) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- Backend 新增 5 条真实本地 stdio 测试。覆盖已生效写入和依赖读回、明确未生效的 `foreach` 迭代恢复、缺输出时阻止完成、补读迟到结果后继续，以及无需原输出的独立节点。在旧快照恢复中核对实际 RPC 序列、最终写入次数、Workflow 身份和旧部分原件。V2 IPC 新增原 Workflow 完成后关闭重连场景。[Backend 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/mcp-runtime.test.ts) · [桌面场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)
- 定向验证定位并修正恢复期间的投影可用性，以及已成功的持久结果在旧中断快照中残留的未知标记。Windows 临时目录清理改为有界重试；另保留一轮环境长时间停顿后的测试超时记录。[初次定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/workflow-mcp-first-focused.log) · [恢复重测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/workflow-mcp-recheck.log) · [清理重测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/workflow-mcp-final-focused.log)
- 最终 Backend 全量 **593/593**，V2 IPC **21/21**，Backend 与共享协议构建、Backend 与工作台类型检查以及提示词分发校验通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/workflow-mcp-final-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/workflow-mcp-final-desktop.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/workflow-mcp-build.log) · [共享协议](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/workflow-mcp-protocol-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/workflow-mcp-final-types.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/workflow-mcp-workbench-types.log)

继续验收部署服务合同、人工协助和等待、其他外部写入及 Workflow 续跑中权限变化的恢复。真实主/小模型效果、训练数据准入和桌面实际交互仍在统一目标中追踪。

## 阶段二十四验证：MCP 原操作结算等待

日期 2026-11-18。统一设计 v0.23，Runtime draft-0.21。项目显式配置 `verification_poll_ms` 后，主轮可用原 taskId、runId、operationId 与宿主期限登记根任务等待。运行时只探测当前授权的只读核查能力，并从持久终态及原件生成等待信号。重开沿用原订阅；权限撤销后停止发送探测请求，超时保留未知结算。[MCP 结算等待](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md#43-等待写入结算) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md#等待)

- 真实本地 stdio 测试覆盖拒绝伪造结算信号、关闭重开后核查同一操作、读回终态证据、拒绝超时后完成，以及撤销权限后没有新的远端核查。SQLite 恢复用例验证截止前持久化的 `not_applied` 在重开后保留原时间，截止后的证明不结算该等待。V2 桌面 IPC 覆盖订阅待处理、关闭重连、原 run 唤醒及再次读取完成快照。[Backend 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/mcp-runtime.test.ts) · [SQLite 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/runtime-wait-store.test.ts) · [IPC 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs)
- Backend 全量 **596/596**、定向 **55/55**、V2 桌面 IPC **22/22**，Backend 与共享协议构建、Backend 与工作台类型检查及提示词分发校验通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-wait-verified-backend.log) · [定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-wait-verified-focused.log) · [V2 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-wait-verified-desktop.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-wait-verified-build.log) · [协议构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-wait-verified-protocol.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-wait-verified-types.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-wait-verified-workbench-types.log)

MCP 人工表单的原请求往返、部署服务的只读核查合同和其他外部状态生产者继续单独验收。真实模型与训练质量仍按统一目标追踪。

## 阶段二十五验证：MCP 人工表单往返

日期 2026-11-18。统一设计 v0.24，Runtime draft-0.22。宿主用显式 `human_input: "form"` 接入现代 MCP 的直接只读调用。工作台提供可折叠表单，提交结构化的接受、拒绝或取消。请求、回复与原会话、任务和调用绑定。状态令牌与表单值留在私有控制记录，续传时按当前原能力的投影复核并一次性领取。后续表单使用新请求 ID，终态原件和原调用完成引用在同一个事务保存。[MCP 人工输入设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md#44-人工输入往返) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md#人类协助)

- 本地真实现代 stdio 验证两轮原参数续传、关闭重开、schema 拒绝、重复或伪造回复拒绝、权限撤销后无远端调用。V2 IPC 验证表单定义和状态的恢复与第二轮取消。Electron 加载实际 V2 生产渲染产物，通过受控桥接事件验证折叠、键盘操作、布尔值、区分取消和接受及提交状态。[后端场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/mcp-runtime.test.ts) · [桌面 IPC 场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs) · [Electron 渲染记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-renderer-final.log) · [渲染预览](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-v2-renderer.png)
- 初次全量暴露三个训练用例在通用提示词变长后超过原输入预算。现在只有当前主轮存在 MCP 表单请求才装配其说明。三个用例使用原预算定向复验通过。[初次 Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-final-backend.log) · [训练定向复验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-budget-recheck.log)
- 最终 Backend 全量 **598/598**、V2 桌面 IPC **23/23**、工作台会话组件回归 **4/4**。Backend、共享协议、工作台构建与提示词分发校验通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-reverified-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-reverified-desktop.log) · [会话组件](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-reverified-composer.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-reverified-build.log) · [共享协议](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-final-protocol.log) · [工作台构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-input-workbench-build.log)

写入工具的多轮输入、URL 模式及真实部署服务仍按统一目标验收。

## 阶段二十六验证：MCP 写入人工确认与原操作续传

日期 2026-11-18。统一设计 v0.25，Runtime draft-0.23。显式配有只读核查合同的 MCP 写入工具可登记人工表单。V2 桌面使用“确认并继续写入”明确提交意图。宿主沿用原参数和 operationId，逐次在真实分发前登记可追溯的 RPC 尝试。拒绝和取消结束本地表单，原操作仍须用终态证据结算。[写入确认设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md#45-写入确认与续传) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md#人类协助)

- 四条真实本地现代 stdio 定向场景通过。分别验证两轮确认与关闭重开、已经写入后断连并按同一 ID 核查、拒绝后无续传和无法完成、预登记失败后无远端写请求。核对原调用、实际发送参数、RPC 来源、终态原件及实际写入次数。初轮两条用例的嵌套 JSON 断言改为解析工具结果，业务门禁断言保持有效。另从故障注入测试确认预登记被拒绝时的错误分类与实测发送次数。[定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-recheck.log) · [登记故障复验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-journal-recheck.log)
- V2 桌面 IPC **24/24**。使用本地 MCP 核对两个写入表单经 IPC 独立确认，首次重开后沿用原 operationId，服务只写入一次。Electron 使用受控桥接验证写入确认显示、取消后不随回复传出字段和键盘操作。[桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-verified-desktop.log) · [Electron 渲染](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-renderer-verified.log) · [桌面截图](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-v2-renderer.png)
- Backend 全量 **602/602**。Backend 类型检查、共享协议与 V2 工作台构建、Backend 资源分发和设计文档校验通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-final-backend.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-final-types.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-verified-build.log) · [共享协议](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-final-protocol.log) · [工作台构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-write-input-workbench-build.log)

Workflow 节点内的人工作业、URL 模式与实际部署服务继续独立验收。

## 阶段二十七验证：Workflow 人工表单、原节点回执与续跑

日期 2026-11-18。统一设计 v0.26，Runtime draft-0.24。Workflow 节点的 MCP 表单关联原任务、原图、节点和调用，保存部分结果并暂停该图。每轮表单续传复核原能力。终态输出以回执补齐原节点，宿主按当前投影继续剩余步骤。确认后断线的写入仍可用原操作核查回执恢复。拒绝或取消时结束剩余节点，单独保留原写入结算义务。[MCP 设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md#46-workflow-节点的人工输入) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- 本地真实 stdio 定向覆盖只读循环、多轮写入确认、用户拒绝及确认后服务断连。旧快照从表单登记恢复，用原请求 ID，已完成的迭代保持单次执行。测试核对错误回执被拒绝、下游使用真实输出，以及拒绝和断连后的实际服务写入次数。[后端场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/mcp-runtime.test.ts) · [初轮定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-first.log) · [旧快照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-stale.log) · [断连核查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-disconnect.log)
- V2 桌面 IPC 全量 **25/25**，包含关闭重连、两次回复的原节点和操作 ID、服务写入一次及 Workflow 下游完成。实际 Electron 渲染产物使用受控桥接事件，核对可折叠表单、节点标识、键盘操作和取消时的回复内容。[桌面场景](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/test/backend-runtime-host.test.cjs) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-final-ipc.log) · [Electron 渲染](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-renderer.log) · [桌面截图](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-v2-renderer.png)
- Backend 类型检查、共享协议构建、Backend 与 V2 工作台构建及提示词分发校验通过。最终 Runtime 文本的训练运行与闭环定向回归 **8/8**。[Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-final-types.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-backend-build.log) · [工作台构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-workbench-build.log) · [训练回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-prompt-budget.log)
- Backend 全量 **606/606**，最终 Runtime 文本下四条 Workflow 人工输入场景定向复验 **4/4**。[Backend 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-final-backend.log) · [Workflow 定向复验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-workflow-form-final-focused.log)

URL 模式、实际部署 MCP 服务、真实主模型与整理模型的效果验收继续分别留证。

## 阶段二十八验证：MCP URL 人工协助与主轮工具通道

日期 2026-11-18。统一设计 v0.27，Runtime draft-0.26。V2 桌面按原请求展示服务、域名和完整地址。宿主根据已登记地址和当前权限打开系统浏览器。打开后仍待用户明确继续、拒绝或取消。URL 回复只转交动作，服务按原调用状态判断是否还需输入。终态工具回执随后用于任务和 Workflow 验收。[控制契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-mcp-runtime-design.md#47-url-人工协助的控制契约) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- 本地真实 stdio 与桌面 IPC 覆盖 URL 与表单组合、权限撤销、跨会话隔离、打开失败重试、并发和重复打开、关闭重开、第二轮 URL 请求、同一 operationId 只写入一次和原 Workflow 续跑。只读场景覆盖打开后取消、迟到回复、原服务接收取消及无导航能力时不声明 URL。Electron 实际渲染产物加载受控桥接，验证完整地址、域名、键盘操作、分开继续及页面零直接网络请求。[Backend 定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-runtime-rechecked.log) · [IPC 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-final-ipc.log) · [Electron 渲染](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-renderer.log) · [工作台截图](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-v2-renderer.png)
- 首轮全量发现旧表单提示的字符串断言、无 URL 能力时的服务夹具行为及重开用例误把旧暂停当成第二轮停点。更新断言与脚本，使其验证实际当前提示、声明能力和新请求 ID。定向复验通过。[首轮全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-final-backend.log) · [表单重开复验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-write-rechecked.log)
- 实际配置的 `deepseek-chat` 在隔离项目完成一条 URL 等待与续传场景。服务为真实本地 stdio，浏览器打开和外部授权结果由受控替身提供。验收核对同一 run、`mcp.input.responded`、一次续传 RPC 和最终回复中的原服务结果。该次主轮未显式列出额外的完成动作引用。前几轮分别暴露工具动作写入 JSON、使用业务描述构造动作 ID、生成未支持的等待事件、以及重复登记已知的等待状态。主轮现在收到按阶段收窄的控制 schema、每条人工请求的 `waitSpec` 和回执引用格式说明。另有一次供应商请求在入口超时，随后复测通过。[真实主模型验收](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-live-desktop-release.log) · [控制回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-control-recheck.log)
- URL 实现与原生控制 schema 全量回归 Backend **609/609**，V2 桌面 IPC **26/26**。最终等待投影与提示词的 MCP 和控制定向回归 **42/42**，URL 桌面场景单独复验通过。共享协议、Backend 与 V2 工作台构建通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-release-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-release-ipc.log) · [最终定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-release-focused.log) · [URL 桌面复验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-ipc-wait-rechecked.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-backend-build.log) · [工作台构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-workbench-build.log)
- Loopback Streamable HTTP 验证 URL 能力声明、多轮续传、实际终态回执和凭据引用继续有效。[HTTP 传输复验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/mcp-url-http-recheck.log)

部署环境中的 MCP 授权、主模型长任务及整理模型收益继续独立验收。

## 阶段二十九验证：上下文保真及总 Token 配对评测

日期 2026-11-18。统一设计 v0.28，Runtime draft-0.27，Organizer draft-0.6。加入可复跑的隔离评测，固定真实文件读取和两次用户问题，对照原工具组和真实整理后的文档。报告保存原文件内容哈希、来源字段、提供方返回的输入输出计量、覆盖边界和提示词版本哈希。[评测方法](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#111-未压缩与整理后的配对验证) · [评测脚本](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/demo/context-quality-eval.ts)

- 2,000 Token 预留的评测出现无效分类与输出截断。宿主现在提供明确分类 schema，证据绑定的新条目复用本轮观察正文和快照绑定，归档回执与模型训练目标分别保存。主轮获取当前运行的动作引用；本轮无可完成动作时的 schema 限制动作引用为空。新提出的无效引用进入有界纠正，已接受计划的义务照常核验。[首轮结果](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-quality-pilot.json) · [第二轮结果](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-quality-recheck.json)
- 4,096 Token 预留下，明确覆盖组的方式仍出现来源未承接和内容提案误带树字段。增加宿主自动前缀计算并校验结构字段。首轮可比较结果的原文件哈希一致，整理后两份文件原文退出主轮，两案的全部核查字段仍有来源绑定。退款严格字段保持 9/9，运输为 7/9，差异来自正确温度值增加同义括注。主输入分别下降约 23% 和 20%，计入每案两次整理后总输入仍增加。[首次有效对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-quality-auto.json)
- 调整调度后，低压力且没有新工具观察的追问复用已提交文档。最新两对运行均有效，整理器每案只调用一次，整理后两份文件原文未进入主轮，文档保留全部九个字段的对应来源。运输题在两组同时明确原文温度格式。[最新实测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-quality-acceptance.json)

| 场景 | 严格字段 原文→整理 | 主模型输入 Token 原文→整理 | 含整理的总 Token 原文→整理 |
| --- | --- | --- | --- |
| 退款证据分歧 | 9/9 → 9/9 | 64,069 → 53,295 | 64,790 → 75,562 |
| 运输例外条件 | 9/9 → 9/9 | 64,019 → 51,742 | 64,850 → 73,788 |

总 Token 是提供方返回的输入和输出用量之和。两案均由真实 `deepseek-chat` 承担主轮与整理角色，采用 4,096 输出 Token 预留和 24,000 字符分片，文件读取序列由夹具固定。本地训练环境核对仍为 CPU Torch，当前 LoRA 权重基于 tiny-gpt2 烟测。此处验证两轮信息承接。独立整理小模型的长任务质量、总成本与真实召回增益继续验收。

训练入口的格式探针将 V2 `schemaVersion: 3` chat 样例交给本地 `train_lora.py` 的 `make_text`，得到缺少 `evidence` 的错误。现有 Python 入口读取旧版 `evidence` 和 `expected`，需要与 V2 模型目标及助手输出损失掩码对齐。[Backend 导出](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-training-recorder.ts#L391) · [本地训练入口](D:/gitlocals/kanli8-human/capybara-llm/scripts/train_lora.py)

最终 Backend 全量 **614/614**，V2 桌面 IPC **26/26**，整理、训练记录和控制定向 **40/40**。Backend 构建、类型检查及提示词资源校验通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-quality-release-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-quality-release-ipc.log) · [定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-quality-acceptance-focused.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-quality-release-build.log)

## 阶段三十验证：持久化样例导出与本地训练

日期 2026-11-18。统一设计 v0.29。后端 CLI 从明确选择的持久化会话读取 V3 整理样例，核对项目与会话绑定，再以新文件发布完整 JSONL。导出保留项目、会话分组及提示词溯源。目录分组用于划分本地来源，跨副本或共用来源任务仍需要语义分组。[样本契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/context-training-sample-contract.md#local-export-and-trainer) · [导出实现](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/src/core/context-training-export.ts)

- 隔离运行生成三条会话，包含真实工具读取、无变更、结构校验通过的 diff 和一次来源引用拒绝。构建版 CLI 导出 4 条开发样例，保留无变更与已提交提案。拒绝提案仍在原始会话中。夹具使用受控提案，和阶段二十九的留出场景隔离。另做回归验证，覆盖重复选择、未选会话、既有目标、无样本与缺失会话。[运行日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-fixture.log) · [CLI 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-export-run.log) · [定向回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-cli-recheck.log)
- Qwen2.5 原生聊天分词器读取 4/4 条，最长 12,671 Token，累计监督 490 Token。2,048 上限检查列出所有超长样例并在模型分配前退出。4 项 Python 测试通过，覆盖助手专用监督、填充、虚假宿主回执、快照不匹配，以及完整和后缀输出 logits 的损失与梯度等价。旧格式 80 条仍可读取。[长度](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-tokens.log) · [超长拒绝](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-overlength.log) · [Python 测试](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-python-tests.log)
- 使用同一分词器和随机初始化的单层 Qwen2 在 CPU 执行一个 LoRA 优化步。保存后重载适配器，验证在 12,671 Token 样例上的前向损失有限，且 3,072 个 `lora_B` 元素已更新。[优化日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-tiny-release.log) · [重载日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-reload.log)
- SHA256 校验后的 Qwen2.5-0.5B-Instruct 官方权重也完成一次实际 CPU LoRA 更新，耗时约 200 秒，损失 0.3285、梯度范数 3.133，落盘适配器。此工作站的 AVX2 路径在矩阵乘法探针中用 Float32 约 0.063 秒，预训练默认的 BFloat16 约 14.46 秒，因此 CPU 回退改用 Float32。现有 Python 环境的 `multiprocess` 在解释器退出时产生清理警告，训练进程返回 0。首次 CUDA wheel 下载在读取时超时，显卡训练仍待验证。[权重校验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-qwen-ranges-resume.log) · [优化日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-lora-fp32.log) · [浮点对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-cpu-dtype.log) · [CUDA 日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-cuda-setup.log)
- 最长样例的整理器系统输入约 9,419 Token，独立请求数据约 3,000 Token。系统输入中，session 投影约 2,155 Token，原任务指令数据约 1,532 Token，输出 schema 约 1,200 Token。聊天模板的完整输入是 12,432 Token，同一请求的本地字符估算为 8,214，低估约 34%。选定小模型后需要按实际 tokenizer 复核输入门禁。[分词分项](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-token-breakdown.log) · [输入计数](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-exact-prompt.log) · [字符估算](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-meter-estimate.log)
- 数据集构建验证逐行审查绑定、项目/会话/来源任务跨切分拒绝、训练文件哈希及改动拒绝。四条开发样例中两条通过复核、一条剔重、一条未审，训练入口只读取清单绑定的两条样例。使用 321 个监督 Token 完成一次梯度累积与 CPU LoRA 更新。开发集的验证及测试分组为空，留出效果不纳入此次结果。[复核与切分契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/context-training-sample-contract.md#reviewed-data-and-splits) · [数据集和优化日志](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reviewed-release.log)
- 单独隔离的仓库盘点留出探针对照了官方基座与一个优化步后的适配器，实际输入 12,533 Token。自由生成两次均未通过运行时 JSON 合同。基座达到 384 Token 上限，适配器在 261 Token 停止，输出含代码围栏且缺 `coverageProposal` 与 `uncertainties`，快照和来源引用错误。适配器重载后检测到 786,432 个非零 `lora_B` 元素。留出样例用于发现问题，来源与训练开发集隔离。[留出采集](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-heldout.log) · [基座探针](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-base-probe.log) · [适配器探针](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-adapter-probe.log)
- 同一留出样例的解码约束绑定快照、模式和本轮来源 ID，结果继续用完整 `ORGANIZATION_SCHEMA` 校验。LM Format Enforcer 经临时兼容调整后仍生成含未转义控制字符的未完成 JSON。LLGuidance 排除其不支持的唯一性及条件关键字后生成了合法前缀，384 和 768 Token 两轮均到达上限。768 Token 的结果复述会话候选 Markdown，文档正文仍缺有效的来源整理。探针没有生成可提交提案，语义、来源资格与完整输出继续由运行时校验。[LM Format Enforcer 探针](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-constrained-retry.log) · [LLGuidance 384](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-llguidance.log) · [LLGuidance 768](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-llguidance-768.log)
- Backend 全量 **615/615**，V2 工作台 IPC **26/26**，Python **7/7**。Backend 构建、类型检查与提示词分发同步通过。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-release-backend.log) · [IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-final-ipc.log) · [Python](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-dataset-release-tests.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-training-release-build.log)

## 阶段三十一验证：实际发送的整理请求计数

日期 2026-11-18。统一设计 v0.30。自建 Chat Completions 服务的文本档案可绑定使用中的 Hugging Face 聊天模板和分词器。发送前读取实际序列化消息，计入生成前缀和预留，沿用共享账本。已接纳请求记录实际负载与 tokenizer 内容哈希。模型或 URL 变更时重新绑定，显式配置的错误资产和不匹配的请求形状会阻止发送。[统一预算](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#62-统一预算)

- 使用阶段三十的最长样例经过构建版 HTTP 客户端。实际发出的完整请求含运输层追加的 JSON 输出指令。JavaScript 与本地 Python Qwen tokenizer 都计为 **12,445 输入 Token**，字符估算为 **8,247**。保留 **4,096** 输出 Token 时，**16,384** 的模型窗口拒绝请求，网络发送及账本预留均为零。使用 **32,768** 的窗口配置后发送一次，账本记录的计数与实际负载一致。对端是本地 HTTP 夹具，分词对照独立运行。[实际请求计数](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-tokenizer-wire-compare.log)
- 项目档案和原生运行链路通过定向测试。运行时在真实 `read_file` 结果出现后尝试整理，按已保存的小模型档案拒绝超窗。整理服务收到零请求，原工具消息完整留给主任务，覆盖边界维持原值，超窗保留为可查询的拒绝样例。另验证等于窗口时成功、模板修改更新指纹、模型覆盖参数和工具消息形状错配拒绝。[档案与原件定向测试](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-tokenizer-integration.log)
- 定向回归 **64/64**，包括一次传输失败后切换到受限档案，按该档案计数并拒绝超窗。Backend 全量 **617/617**，V2 工作台 IPC **26/26**，构建与类型检查通过。[定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-tokenizer-release-focused.log) · [Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-tokenizer-release-backend.log) · [工作台 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-tokenizer-release-ipc.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-tokenizer-release-build.log) · [类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-tokenizer-release-types.log)
- CUDA 12.6 版 PyTorch 2.10.0 在独立 Python 环境识别 RTX 3060 Laptop 6 GB，BF16 可用。默认注意力试跑几乎占满独立显存，进程物理内存约 13 GB，在产生适配器前停止。当前 Windows 构建无 Flash Attention；小规模探针验证 cuDNN 可处理本模型的分组头，高效 SDPA 可处理等头数输入。[CUDA 环境](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-cuda-retry.log) · [默认试跑](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-lora-gpu-stage31.log) · [内核探针](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-cuda-attention-probe.log)
- 本地训练入口增加 `--fused-sdpa`，要求融合内核并禁用全矩阵回退。用官方 Qwen2.5-0.5B-Instruct 权重和两条已复核样例累积一次梯度，最长 **12,671 Token**，共 **321 个监督 Token**。生产入口复跑约 **9.1 秒**，损失 0.5743，梯度范数 2.538。PyTorch 峰值分配 **2,501 MiB**、峰值预留 **3,250 MiB**，适配器完成落盘。最终 Python 回归 **7/7**。[CUDA 训练复验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-lora-gpu-lowmem-release.log) · [Python 测试](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-gpu-stage31-python.log)
- 保存后的 CUDA 适配器重载成功，`lora_B` 中检测到 786,078 个非零元素。相同 RTX 3060 和 BF16 融合注意力用于留出的仓库盘点对照，两组输入均为 12,533 Token。基座与适配器均用满 384 个生成 Token，完整 JSON、实际 schema 和来源绑定均未通过，没有可验收的盘点字段。该结果确认硬件可完成本次训练与推理，整体输出质量仍待更完整语料和留出场景验证。[GPU 留出实测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-pretrained-gpu-heldout.log)

## 阶段三十二验证：整理短编号协议与小模型留出

日期 2026-11-18。统一设计 v0.31，Organizer draft-0.7。项目通过 `context_organization_version: 2` 选择短编号调用。模型提出来源、节点编号和编辑建议，宿主根据本轮批次还原文档版本、节点 hash、来源 ID 和幂等键，再使用已有的证据、作用域、归档和原子提交门禁。训练直接监督模型输出的短提案，宿主绑定留在溯源。[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#整理协议的短编号表示) · [训练契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/context-training-sample-contract.md)

- 定向回归 **35/35**。通过批次内的树编辑及真实证据记录，覆盖过期批次、越界来源和受保护资料归档的拒绝。拒绝后保留原工具消息。源 A 的 125 美元与源 B 的 120 美元由受控提案一并写入会话正文，保持来源分歧。[定向回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-focused.log)
- 同一仓库盘点留出场景，在 RuntimeLoop 传给整理器的两条消息上用 Qwen 原生分词器计量。原协议 **12,533** 输入 Token，短编号版 **3,310**，下降 **73.6%**。该比较使用本地聊天模板，按整理器发送边界计量。[同场景分词对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-token-comparison.log)
- 真实运行持久化并通过 CLI 导出 10 类受控开发场景，共 12 条复核样例，覆盖 `add_entry` 和无变更。隔离的仓库盘点留出样例未进入训练。Qwen2.5-0.5B-Instruct 在 RTX 3060 Laptop 6 GB 上完成 24 次 LoRA 更新，最长训练序列 **3,348 Token**，共 **982** 监督 Token，耗时 **53.2 秒**，PyTorch 峰值预留 **2,012 MiB**。[语料与 CUDA 训练](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-gpu-train.log)
- 仓库盘点留出场景中，LoRA 适配器分别用 **109** 个约束解码输出 Token 和 **107** 个自由生成输出 Token 完成提交。会话文档保留班表的周五 18:15 UTC、关闭入库前提，以及交接单的周六 06:30 UTC、周五继续收货理由。正文引用实际文件读取证据，原件保留。基座在同一短协议与约束解码下触及 384 Token 的探针上限，运行时拒绝提案，覆盖边界停在 0，保留原件。主任务工具动作由夹具控制，小模型生成及 RuntimeLoop 应用为实际调用。[适配器约束解码](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-real-trained.log) · [适配器自由生成](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-real-trained-free.log) · [基座约束解码](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-real-base.log)
- 传感器验收留出场景将两份记录放在同轮读取的独立文件中。适配器在 **104** 输出 Token 内提交了有效结构，但正文只保留采购单的 **0.7 ppm**，带入同源窗帘记录，并遗漏计量单的 **0.4 ppm** 和依据。重新打开持久化会话，确认两份读取都在整理请求内。未完整承接的工具组序号为 5–6，覆盖游标停在 3，两份原工具结果仍留在主投影。结构通过，跨原件覆盖和噪音剔除未通过。[场景评分](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-heldout-score.json) · [持久化来源核验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-mixed-source-proof.log)
- Backend 全量 **622/622**，V2 桌面 IPC **26/26**，Python **8/8**。Backend 构建和类型检查通过。六份提示词正文和分发资源一致，缺口索引为 20 项。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-release-backend.log) · [V2 桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-release-ipc.log) · [Python](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-python.log)

整理器整体质量验收继续覆盖跨原件合并、同源噪音剔除、增量更新、归档与真实召回。现有训练集集中在单原件新增和无变更，适配器需通过这些语义门槛及主模型下游配对评估。

## 阶段三十三验证：多来源训练与内容覆盖

日期 2026-11-18。统一设计 v0.32。整理器处理完当批提案后，宿主从最终文档检查活跃正文和精确原件证据。空正文、状态变更、布局操作及对不同正文直接追加证据不能承接原件。已有相同正文时，允许保留该原件作为补充证据。原件归档仍由独立回执承接。[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#51-观察整理和提交)

- 12 个补充开发场景通过真实 RuntimeLoop 和 CLI 生成样例。多文件场景保留正序与逆序，两种次序共享同一任务分组。合并既有样例后，训练集 **34** 条，独立测试集 **2** 条。宿主端逐份校验所需条件、同源噪音与整份无关资料归档。RTX 3060 Laptop 6 GB 上从官方 Qwen2.5-0.5B-Instruct 重新完成 **68** 次 LoRA 更新，最长 **3,878 Token**，共 **3,990** 个监督 Token，耗时约 **146 秒**，峰值预留 **2,112 MiB**。[样例定义](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/fixtures/context-organizer-quality-cases.json) · [独立切分及训练](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-training.log)
- 留出评分重新打开持久化会话，要求每份相关原件的条件和数值出现在引用本原件的活跃正文中。还核对同源噪音、实际归档回执和未承接历史所在的覆盖边界。主轮工具动作由夹具控制，整理器生成、证据写入和提交来自实际运行。[评分器](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/demo/context-organizer-quality-review.mjs)
- 默认批次中，两组留出都通过结构校验并剔除混入的无关文字。水泵试运转仍遗漏复核单 X92 的 51 kPa 及密封条件。中庭开放保留两方的时间和条件，遗漏无关书法展原件的归档。两组覆盖边界均停在原工具批次之前，原件仍进入主模型投影。[试运转](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-pump-commissioning-new.json) · [中庭开放](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-fountain-reservation-new.json)
- 同一水泵留出对照中，上一版适配器还会带入地毯记录。新适配器默认批次移除了该文字，但依然漏掉第二份来源。逐份整理探针改用 640 字符分包，水泵两份来源均有各自证据，仍遗漏「备用密封尚未换成新批次」的否定。两次真实整理器调用累计 **6,766** 输入 Token、**158** 输出 Token，默认批次为 **3,558** 输入、**81** 输出。中庭探针将无关布告写入正文，归档仍未通过。分包结果保留为探针，未改变默认配置。[上一版对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-pump-commissioning-old.json) · [逐份水泵](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-pump-commissioning-isolated.json) · [逐份中庭](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-fountain-reservation-isolated.json)
- 逐份整理的水泵场景已折叠原工具消息，实际主轮系统消息仍通过待审候选携带完整原件。此路径保留了遗漏的否定，也重复占用输入。覆盖游标和工具消息数仅用于核对历史承接，端到端节省与信息保真按完整实际请求计算。[主轮原文探测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-pump-commissioning-isolated.json)
- 人工核对并生成的两组对照提案通过同一评分器，适配器默认分包和逐份分包均为 **0/2**。Backend 定向 **33/33**、全量 **623/623**，V2 桌面 IPC **26/26**，Python **8/8**。Backend 构建和类型检查通过，六份模型提示词与分发资源一致。[水泵对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-pump-commissioning-control.json) · [中庭对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-fountain-reservation-control.json) · [Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-release-backend.log) · [IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-release-ipc.log) · [Python](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-quality-python.log)

数据支持继续验证按源选择原文片段、保留否定和条件的提案方式。实际主轮候选投影的重复内容需要同原件访问、召回和下游任务效果一起验收。目前通过的覆盖检查确认最终正文和来源证据存在，正文语义完整性仍须独立验证。

## 阶段三十四验证：原文摘录、去重投影与主轮追问

日期 2026-11-18。统一设计 v0.33。项目可选 `context_organization_version: 3`。Organizer draft-0.8 对应片段选择协议。宿主建立标准文件读取结果的原文范围，模型提案只引用片段编号。宿主用原文生成正文，覆盖副本的省略由可核验的正文见证决定。[摘录设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#可选原文摘录协议)

- 四项实际运行回归覆盖相反主张和带引号原文、同源噪音归档、漏提取时保留原工具组、互斥处置冲突和重写正文拒绝。在 SQLite 重开后可按原文范围召回归档，保持会话隔离。已承接原件的待审副本退出实际主轮请求；归档其中一条正文见证后，原两份工具结果按完整工具组重新进入后续请求，已登记覆盖游标和原件保持稳定。[运行时回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-fallback-focused.log)
- 从真实结算、持久化和 CLI 导出获得 **24** 条复核训练样例及 **4** 条独立留出。Qwen2.5-0.5B-Instruct 在 RTX 3060 Laptop 6 GB 上训练 **72** 步，最长 **3,060 Token**，**2,216** 个监督 Token，约 **121 秒**，峰值预留 **1,726 MiB**。[切分和训练记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-training.log)
- 约束解码的真实整理器通过 **2/4**。借阅规定与水泵试运转均保留两份来源的条件和否定，归档同源噪音，主轮无完整原件副本。包装标签保留双方主张，漏归档独立的无关原件。中庭场景仍漏掉相关主张和归档。两个未通过场景的原材料继续进入主轮。[借阅](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-library-loan.json) · [水泵](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-pump-commissioning.json) · [包装](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-packing-label.json) · [中庭](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-fountain-reservation.json)
- DeepSeek 实际追问的初次配对中，两组都生成了正确的借阅要点。模型将非阻塞分歧填入 `completionCheck.unresolvedUncertaintyIds`，运行时拒绝结束。Runtime draft-0.28 明确了完成字段与非阻塞分歧的用法，原生 schema 显式限制完成时的阻塞列表。用同一场景重新生成两组会话，主模型均一轮正常完成，命中 **7/7** 要点且无需重读。主轮输入 **16,875 → 15,131 Token**。计入 **2,964** 个整理输入 Token，这次短配对总输入增加 **1,220**。[初次拒绝](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-followup-pair.log) · [修正后配对](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-final-followup-pair.json)
- 新建两条会话重复采集相同借阅材料，连续发出两次真实主模型追问。两组每轮均一轮完成，答复均命中 **7/7** 个核对点。摘录组的两个请求都未携带原始文件工具消息。主模型输入合计 **34,458 → 30,875 Token**。计入一次整理的 **2,961** 输入和 **99** 输出 Token，两组输入和输出合计为 **35,678 → 35,188 Token**，共节省 **490**。采集阶段的工具动作由夹具控制，计量覆盖一次实际整理推理和两次实际主模型追问。[两轮配对](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-two-followup-pair.json) · [整理用量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-library-two-optimized.log)
- Backend 全量 **627/627**。最终控制提示词和摘录链路的定向回归 **81/81**，V2 桌面 IPC **26/26**，Python **9/9**。Backend 构建与类型检查通过。[全量回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-release-backend.log) · [最终定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-final-focused.log) · [V2 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-release-ipc.log) · [Python](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-extractive-python.log)

## 阶段三十五验证：逐项处置、跨批保留和召回去重

日期 2026-11-18。统一设计 v0.34。项目可选 `context_organization_version: 4`。文件批次的片段按顺序绑定到等长选择数组，宿主生成原文正文、证据和归档。无正文承接保留整组。单批整份拟归档的文件区间单独复核，两次判断不一致留在历史。跨批归档待整体复核。已有同一原件范围的正文可复用，重复归档记录在召回限额前按原件范围去重。[设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#文件片段逐项处置)

- 实际运行并持久化导出 **34** 条训练记录，**6** 个留出场景包含 **7** 条测试记录。LoRA 在 RTX 3060 Laptop 6 GB 训练 **100** 步，最长训练输入与输出合计 **3,094 Token**，监督 **1,326** Token，峰值预留 **1,586 MiB**。当前复核提示词沿用这份适配器，模型原始提案与宿主最终处置分别记录。[样本切分和训练](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-training.log)
- 初始逐项选择通过 **4/6**，其中包装标签和中庭场景较原文摘录通过了证据与归档检查。展厅长样例的 **39** 个片段跨两包，模型把相关的两份原件判为可归档，错误折叠了整个工具组。初版单文件复核恢复了 B 方主张，但仍漏掉 A 方，并加入部分无关原句。实际主模型在这个不完整投影上暂停，原始组对照两轮均得到完整要点。[初始长样例](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-shipment-hall.json) · [单文件复核探针](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-checked-shipment-hall.json) · [不完整投影主轮](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-long-followup.json)
- 加入跨批保留后，实测展厅长样例三份原件都进入主轮，覆盖游标仍为 0。新建对照会话，两次追问在原始组与保留组中都命中 **7/7** 要点。保留组发生额外模型轮和文件读取。该对照的主模型输入从 **63,867** 增至 **93,062 Token**，另有 **5,738** 整理输入 Token。跨批保真回退通过，长输入压缩收益未达到验收条件。[保留原件](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-guarded-shipment-hall.json) · [长场景真实主轮](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-guarded-followup.json)
- 最终 Organizer draft-0.11 的六组留出通过 **2/6**。借阅和水泵能完整承接，整理输入分别为 **1,979** 和 **1,977 Token**。标签场景保留双方主张，整份无关资料的复核仍有分歧。中庭、居住登记和展厅仍有提取遗漏。四个未通过场景保留各自的完整原件投影，最终展厅两批整理输入 **5,656 Token**。[最终六组评分](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-final-summary.json)
- 对真实展厅回退请求核对重复字节。三份读取的 `result.content` 都能从 `result.lines` 精确重建，重复正文为 **4,644 字节**。对应待审候选预览另占 **3,126 字节**。去掉可重建的副本仍需实际请求和下游保真验证。[回退投影审计](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-raw-projection-audit.json)
- 初版全量 Backend **631/631**，V2 桌面 IPC **26/26**。最终跨批、单文件复核、召回去重与样例导出定向 **43/43**，Python **10/10**，Backend 构建及类型检查通过，六份提示词与分发资源一致。[全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-release-backend.log) · [最终定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-release-focused.log) · [IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-release-ipc.log) · [Python](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-disposition-python.log)

## 阶段三十六验证：保留原件时的可逆去重

日期 2026-11-18。统一设计 v0.35，Runtime draft-0.29。逐项处置模式的主轮去掉经过精确校验的文件结果副本。同一请求继续提供完整行、原件 ID、格式和工具回执。待审候选保留 ID 和证据，通过引用复用已在同一请求的原件。审批、归档、覆盖和训练仍从持久原件读取。

- 两条新的展厅会话用完全相同的三个读取结果。对实际主轮请求逐条重建 `content`，与历史原文及回执完全一致。三条候选身份均保留，重复预览均变成引用，覆盖游标两组均为 0。对 DeepSeek 实际发送的请求负载 **74,264 → 66,841 字节**，单次输入 **20,180 → 18,423 Token**。配对复放用同一模型，数据为测试夹具。[重建核对](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-wire-audit.json) · [主模型用量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-main-pair.json)
- 使用同一文件场景连续两次真实主模型追问，两组均两次完成并命中 **7/7**。该配对只比较可逆投影，两组均关闭主动整理。主模型总 Token 为 **67,987 → 40,843**，原始组三次模型调用，去重组两次。调用次数有差异，只有单次发送的配对用于衡量去重本身。[两轮配对](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-followup.json)
- 同时开启实际小模型整理和保留回退时，两组追问也均为 **7/7**，均使用三次主模型调用。主模型总 Token **68,762 → 65,481**，加上整理两批的 **5,782** Token 后为 **71,263**。总成本在该次对照仍增加 **2,501**。保存后的整理样本仍包含三个原件正文，尝试输入可定位两份相关主张，覆盖游标维持 0。[整理加回退配对](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-guarded-followup.json) · [模型整理用量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-guarded.log) · [样本原件核对](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-training-proof.json)
- 六文件压力测试中，原工具历史高于触发阈值，去重后低于阈值。运行时保留全部文件结果，未启动语义整理。另测编号及无编号的精确重建、不匹配回执与证据的保守处理、失败读取不受影响，以及重开会话后分页读取完整原件。[压力测试](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-pressure.log)
- 压力调度改动前 Backend 全量 **636/636**。最终全量运行的 MCP 恢复用例在约 70 分钟的日志断档后超时，随后 MCP 测试进程停滞，终止该进程后其余测试继续完成，共 **631** 通过、**1** 超时。超时用例单独复跑通过；原进程中未执行的 **5** 个 Workflow 用例也独立通过。逐条比对名称后，最终代码的 **637** 个用例均有通过记录。最终定向 **54/54**、桌面 IPC **26/26**、Python **10/10**。Backend 构建与类型检查通过，六份提示词正文与分发资源一致。[初次全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-release-backend.log) · [最终全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-final-backend.log) · [MCP 复跑](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-mcp-retry.log) · [Workflow 复跑](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-workflow-retry.log) · [定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-final-focused.log) · [IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-release-ipc.log) · [Python](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-projection-python.log)

## 阶段三十七验证：默认项目的文件整理指令投影

日期 2026-11-19。统一设计 v0.36。展厅场景两批请求各自重复携带 6,893 字符的项目系统渲染。文件逐项处置现在可以从匹配的默认模板生成精简视图。保留当前任务、自定义项目内容和已启用的 Skill，省去执行资源目录及经过原文匹配的内置作者指南。自定义模板和带动态内容的作者指南走保守路径。完整原提示词与实际发送的模型消息各自留存。[文件整理指令契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)

- 同一 Qwen2.5-0.5B LoRA 适配器、同一六组留出，结构化输出后继续按每份来源核对条件、否定、噪音和归档。仍为 **2/6**，借阅和水泵通过。累计整理输入 **25,286 → 10,326 Token**。展厅输入 **5,656 → 3,156 Token**，输出仍为 126。该场景依然漏选两条相关意见，并将第三份材料的一条无关原句选入活跃正文。四个未通过场景的文件原件均继续进入主轮，三份展厅原件可追溯。[六组明细](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-compact-guide-heldout-summary.json) · [展厅评分](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-compact-guide-shipment-hall-review.json)
- 用新建的两条会话进行两次真实下游追问，两边均完成且每次命中 **7/7**，各调用四次主模型。主模型 Token **98,641 → 95,368**。加上精简方案两批整理 **3,282 Token**，总量为 **98,650**，比原始组多 9。两边后续均有额外的原件读取，长场景端到端节省保持待验收。[真实主轮对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-compact-guide-followup.json)
- CLI 从四条独立持久化会话导出实际消息及模型提案。逐条核对短引用、处置标签和原提示词归档后，准备 **2** 条训练样本及 **2** 条留出样本。Qwen 原生 tokenizer 核对最长 741 Token、62 个监督 Token，无超窗。训练集在 RTX 3060 Laptop 6 GB 上完成 2 步 LoRA 更新并保存独立适配器，验证导出到训练的兼容性。留出评测沿用既有适配器。[数据集清单](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-compact-guide-dataset.log) · [训练输入核对](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-compact-guide-train-dry-run.log) · [LoRA 试跑](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-compact-guide-training-smoke.log)
- Backend 定向 **68/68**，包含默认模板、自定义模板和动态指令。桌面 IPC **26/26**。Backend 构建与类型检查通过，六份提示词与分发资源一致。[Backend](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-compact-guide-final-focused.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-compact-guide-ipc.log)

## 阶段三十八验证：按原件核验归档与跨批覆盖

日期 2026-11-19。统一设计 v0.37。工具组可跨批，完整文件读取按原件核验。单份读取因预算被拆包时，其归档建议按 R 处理。完整读取的全部片段拟归档时单独复核，有一条分歧即保留整份读取。整份读取只由归档承接、整组又只有一份活跃正文来源时，所有原工具结果继续进入主轮。[设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#文件片段逐项处置)

- 原件边界回归覆盖了完整多批承接、单份拆包、复核异议和整份归档后只剩一份见证。用未参与训练的新长案例固定正确处置，验证了三份原件跨包时双方原句、归档、覆盖和主轮投影能完整结算。源文件保持可查。[最终 Backend 定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-final-gate-focused.log) · [新长案例宿主对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-digitization-preview-control-review.json)
- 从训练项目的实际读取和结算导出 **80** 条训练记录。六个留出场景的 **12** 条记录与训练组隔离。RTX 3060 Laptop 6 GB 上完成 **180** 步 LoRA 更新，训练最长 **2,235 Token**、共 **3,514** 个监督 Token，耗时约 **241 秒**。[数据准入](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-dataset.log) · [训练](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-training.log)
- 第一轮真实小模型在水泵、标签、中庭完整承接，原六组由 2/6 到 **3/6**。另三组和新长案例均存在正反材料漏选，复核错误同意整份归档。用四组真实输出重放，新增门禁分别恢复 **2、3、4、3** 份原件到主轮。另三组合格覆盖保持有效。覆盖门禁保证这四组的主轮仍可读到原件，原语义误判仍在评分与审计中保留。[真实输出重放](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-gate-replay-summary.json)
- 展厅用新会话复放后进行两组真实追问。两边均完成两轮且每轮 **7/7**，各两次主模型调用、每次均投影三份原件。仅可逆投影基线为 **40,483 Token**，保真回退的主模型为 **41,483 Token**，加上原整理的 **5,962 Token** 后为 **47,445**。本次用量用于验证回退的成本，未达到语义压缩验收条件。[真实追问](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-gate-followup.json)
- 初训的 **26** 条整份归档复核记录均为确认归档。使用训练夹具故意提出错误的整份归档，再用完整原件逐句给出正确复核，新增 **18** 条否决记录。错误的初次提案没有作为监督目标。用 **98** 条训练记录完成额外 **98** 步 LoRA 更新，耗时约 **192 秒**，原留出清单哈希一致，新长案例未入训练。[复核数据准入](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-review-dataset.log) · [复训](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-review-training.log)
- 复训后原六组仍为 **3/6**。借阅恢复，标签退步，水泵和中庭通过。居住登记的复核在实际输入中重新找到 H39 的 8 月 23 日与核验前提，否决了整份归档。展厅和新长案例依然漏选相关原句，三份原件均继续进入各自主轮。两条长案例的语义筛选与端到端节省保持待验收。[复训后逐例评分与复核](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-review-adapter-summary.json)
- 归档覆盖新增门禁前 Backend 全量 **642/642**。最终代码 Backend 定向 **60/60**、桌面 IPC **26/26**，构建和类型检查通过。[全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-backend.log) · [最终定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-final-gate-focused.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-batch-final-ipc.log)

## 阶段三十九验证：文件顺序与逐句相关性分类

日期 2026-11-19。统一设计 v0.38。评测器进一步按原件回执与实际投影核对必需字段。对明确要求待核对的片段，检查它仍可从原件读取，且未进入活跃正文或归档。重放展厅早期错误提案时有 **7** 个必需字段被错误归档，旧主轮缺少 7 个，新增覆盖门禁后的主轮缺少 0 个。归档错误与回退收益分别计数。[早期投影](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-scorer-unguarded.json) · [回退投影](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-scorer-guarded.json) · [待核对宿主对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-uncertainty-control-review.json)

- 对已经捕获的两个长批次保持模型、任务与原句，交换文件顺序后按原件、行号和原句重新对齐。逐项生成在两个批次各改变 **3/26** 与 **2/26** 条处置。单文件输入恢复了 B79 和 Y08，仍漏掉 E46 和 R41。逐句分类头把同一批次按文件独立评分，在同样的反序对照中两组均为 **0/26** 改判。[展厅换序](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-order-shipment-hall.jsonl) · [馆藏换序](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-order-digitization-preview.jsonl) · [分类头换序](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-classifier-order.json)
- 试验用 Qwen2.5-0.5B 编码当前任务说明、来源和文件原句。每句末位置的隐藏状态经三类线性头输出 K、A、R，适配器按原顺序构造同一版本 4 Envelope。初训仅有 **3** 条 R 监督，框架报告峰值预留 **7,886 MiB**。补入归属不明样本后共 **122** 条训练候选记录，原 **12** 条留出记录哈希不变。分出两个训练来源组单独校准，其余用于梯度更新，得到 **114 K / 832 A / 54 R** 监督片段。梯度检查点和每批两文件使峰值预留降到 **1,500 MiB**，训练约 **104 秒**。[初训](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-classifier-training.log) · [增补数据](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-uncertainty-data.log) · [分类训练](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-classifier-balanced.log)
- 上述分类器在两个长场景首次把双方所有必需字段写入带来源的正文，展厅整理输入从 **5,738** 到 **2,502 Token**，馆藏从 **5,475** 到 **2,353 Token**。独立校准未找到可以启用归档的阈值，三份原件仍进入两个长场景的主轮，且部分噪音进入正文。独立网印场景的待核对附件被误入正文。该轮通过现有 RuntimeLoop 和文件提案校验运行，长场景每组所需字段均可见，语义压缩验收仍待闭合。[八组运行汇总](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-classifier-balanced-runtime-summary.json)
- 加入标签平滑，按相同独立验证组选择训练轮次和阈值。选中第 3 轮，验证组将 **160/196** 条无关片段归档，**28** 条必需片段与 **10** 条待核对片段均没有误归档。八组 RuntimeLoop 测试的必需字段均进入正文，实际主轮漏投 **0**，必需字段误归档 **0**。原六组的严格验收 **2/6**，为借阅和水泵。展厅和馆藏的双方关键原句均承接，部分片段仍待核对，三份原件继续进入各自主轮。新的网印用例通过，对应附件在原件中继续可读，未进入正文或归档。[校准训练](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-classifier-calibrated.log) · [实际逐例评分](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-classifier-calibrated-runtime-summary.json)
- 借阅两条会话用相同的文件读取、V4 投影和主模型。两轮真实追问都命中 **7/7**。原件组四次主模型调用，整理组三次，整理组的请求均不携带原工具组。加上分类输入 **813 Token**，本次总量从 **74,009** 到 **49,934**。调用次数有差异，统计为整次任务用量。长场景仍缺可比较的完整压缩结果。[真实配对](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-library-followup.json)
- 仓库中的分类评测入口完成一轮 CUDA 训练并保存适配器。用完整训练的权重评估原测试集时，**12/12** 条必需片段被保留，63 条无关标签中 **46** 条归档、**13** 条待核对、**4** 条误入正文。独立待核对场景另以实际文件请求验证批次绑定与有序 K、K、R 返回。[评测代码](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/demo/context-span-classifier.py) · [训练入口试跑](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-classifier-demo-smoke.log) · [原测试集](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-classifier-demo-test.json) · [实际请求](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-span-classifier-demo-packet.json)

## 阶段四十验证 · 待核对文件行的局部投影

日期 2026-11-19。统一设计 v0.39，Runtime draft-0.30。版本 4 的标准文件工具组可在同一事务内保存局部投影凭据。主轮保留整组调用和原回执。至少两份不同原件的活跃正文提供见证时，宿主逐行校验正文或归档凭据后才可省略原行。同一行含未承接片段时保留整行。重开会话后可按 SQLite 中的凭据重建。正文撤回或归档回执无法核验时恢复整组原件。训练和原件分页仍读取完整历史。[设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#文件片段逐项处置) · [回归用例](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/test/context-file-projection.test.ts)

- 两个长案例沿用同一校准分类器和主模型，每组各有三份原件。展厅的主轮原件行数由 **39** 到 **6**，馆藏由 **39** 到 **23**。逐行对照实际请求、原件、文档及 SQLite 归档，展厅省略片段对应 **2** 条正文和 **31** 份片段归档凭据，馆藏对应 **3** 条正文和 **13** 份片段归档凭据。两组的必需字段漏投及误归档均为 **0**，仍各有待核对片段，完整语义筛选继续独立验收。[实际请求凭据](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-partial-lines-proof-audit.json) · [展厅评分](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-partial-lines-shipment-hall-review.json) · [馆藏评分](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-partial-lines-digitization-preview-review.json)
- 两组各做两次真实同会话追问，原件和整理两边均完成。展厅每轮 **7/7**，计入整理的总用量由 **61,089** 到 **70,451 Token**。整理组第二轮请求分页读取三份原件；原件组首轮经历一次结构修复。馆藏每轮 **8/8**，总用量由 **68,229** 到 **45,204 Token**，减少 **33.7%**。馆藏第二轮仅原件组发起三份原件读回。两组均按实际调用数统计，原件行数和会话总用量分别列入验收。[展厅追问](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-partial-lines-shipment-hall-followup.json) · [馆藏追问](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-partial-lines-digitization-preview-followup.json)
- 读取结算后的实际主轮请求按 UTF-8 字节拆分。展厅的文件消息减少 **4,571 字节**，文档投影增加 **2,535 字节**，消息和工具定义合计减少 **3,146 字节**。馆藏的文件消息减少 **1,727 字节**，文档投影增加 **3,689 字节**，消息和工具定义合计增加 **874 字节**。这两次请求的工具定义大小一致。单次输入大小与会话总成本需同时测量。[请求组成对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-partial-lines-payload-breakdown.json)
- Backend 构建、类型检查和六份提示词分发一致性核验通过。Backend 首次全量 **643/644**，原生工具续轮一条用例等待超时。该用例隔离复跑通过，完整应用集成文件再跑 **44/44**。局部投影重开与失效回退用例在全量中通过。桌面 IPC **26/26**。[Backend 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-partial-lines-backend.log) · [应用集成复跑](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-partial-lines-app-rerun.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-partial-lines-ipc.log)

## 阶段四十一验证 · V4 主轮的可读来源引用

日期 2026-11-19。统一设计 v0.40，Runtime draft-0.31。V4 主轮的两级文档用 `entry-ref` 和 `candidate-ref` 展示正文对应的来源、位置、时间和证据 ID。节点哈希、候选身份与文档绑定继续用于 diff。Runtime 说明在可见证据够用时直接作答，有具体缺项、用户要求或来源变化时读取对应原件。[Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md#两级上下文) · [调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)

- 对同一份持久文档分别生成新旧两种视图，控制可见节点、正文和候选集合一致。整理组的文档投影字节数，展厅由 **10,846** 到 **9,451**，馆藏由 **11,917** 到 **10,180**，分别减少约 **13%** 和 **15%**。核对实际请求中的入选正文、证据 ID、来源 ID 和定位与 SQLite 一致。验证投影前后回放序列化相同。[投影与请求审计](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-view-payload-audit.json)
- 新运行的展厅和馆藏工具结果分别由 **39** 行缩为 **7** 和 **23** 行。两组均无必需字段漏投或误归档，完整语义筛选仍各有待核对片段。两组各做两次真实追问，展厅每次 **7/7**，馆藏每次 **8/8**。本次展厅未整理与整理总用量为 **58,965** 和 **60,391 Token**，整理组读回两份原件。馆藏两组均未读回，总用量为 **39,384** 和 **40,734 Token**。馆藏的未整理组较阶段四十少一次主调用，跨轮总量受实际工具决策影响。[展厅](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-view-shipment-hall-followup.json) · [馆藏](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-view-digitization-preview-followup.json)
- 人工复核馆藏的整理组答案，两轮均写出了关键字段，但把文件留存行和已承接正文误写为互不关联的材料。第一轮还把 14:30 复查错误解释为复核完成后的时间。关键词命中与投影凭据通过，答案的原件归属和条件解释仍需验收。下一步以原文件名和行号校验答案中的归属，并逐项核对条件和否定。[馆藏答案](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-view-digitization-preview-followup.json)
- Backend 定向回归 **94/94**，覆盖使用当前投影执行四种结构 diff、真实回执、训练记录与 SQLite 重开。Backend 全量 **644/644**，桌面 IPC **26/26**。桌面用例实际读取项目正文引用，召回项目归档并对会话树增量编辑，关闭重连后保持两级文档及节点身份。Backend 构建、类型检查与六份提示词分发校验通过。[定向测试](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-view-focused.log) · [Backend 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-view-backend.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-reference-view-ipc.log)

## 阶段四十二验证 · 原文件定位与时点语义

日期 2026-11-19。统一设计 v0.41，Runtime draft-0.33。宿主只从原始读回执和原件 UTF-16 证据范围派生 `file`、`line`。会话证据受所属会话约束，项目证据依其明确来源会话查找。重开和跨会话使用同一份 SQLite 原件，异常或不匹配的证据省略定位。Runtime 区分原件归属、动作时点、前提、状态、否定与授权。逐字引用应保留原句前缀。[设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#文件片段逐项处置) · [提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md#两级上下文)

- 下游评分从实际读取原件确认文件名、行号和完整引用，另按独立标签检查时区、时点用途、动作、先决条件、已知状态和禁止事项。故意串换原文件和误加 14:30 的复查前提，两个错误分别被检出。评分标签不发送给模型。[评分入口](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/demo/context-organizer-quality-review.mjs) · [反例](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-citation-score-negative.json)
- 首次真实配对使用 draft-0.32。原件逐行验证通过，展厅投影 **39 → 6 行**，馆藏 **39 → 23 行**。展厅的两条结构化记录通过，馆藏正确保持 14:30 的复查用途和发布禁令，但 R41 的完整引用缺少来源前缀。首轮自然语言另有把 09:20 误写成唯一发布许可的问题。[实际请求审计](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-citation-evidence-audit.json) · [展厅答案](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-citation-shipment-hall-followup.json) · [馆藏首次答案](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-citation-digitization-preview-followup.json)
- draft-0.33 在新会话复测馆藏。自然语言正确把两条正文关联到各自的原文件和行号，保留 R41 两个必要条件、是否完成未知以及 Y08 复核前的禁令。结构化答复的两个文件、行号、动作、时点与条件均正确，编号字段带入来源名称，引用字段省去了该前缀，逐字引用验收未通过。两组均无原件读回，计入整理的总量为 **58,843 → 41,214 Token**，主模型调用次数 **3 → 2**。首次配对馆藏总量为 **58,243 → 61,354 Token**，稳定净收益仍待验证。[最终答案](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-citation-digitization-preview-final-followup.json) · [最终逐字段核对](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-citation-digitization-preview-final-review.json)
- Backend 全量 **645/645**。全量启动早于最后一处提示词修订，draft-0.33 的上下文定向回归另跑 **44/44**，桌面 IPC **26/26**。覆盖来源会话错误、错误哈希、错误范围、遮蔽、重开和项目跨会话定位。Backend 构建、类型检查及六份提示词分发一致性校验通过。[Backend 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-citation-backend.log) · [最终定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-citation-verified-focused.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/context-v2-file-citation-ipc.log)

## 阶段四十三验证 · 结构化回复的原文引用

日期 2026-11-19。统一设计 v0.42，Runtime draft-0.35。V4 完成提案可用 `fileQuotes` 指定现有 JSON `null` 字段和已发布的证据。宿主校验请求绑定、权威文档版本、原件哈希与原文范围，填入原文并记录回执。整份回复通过验证后才发布，现场文件后来变更时仍可引用原先保存的那次读取。[设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#文件片段逐项处置) · [提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md#两级上下文)

- draft-0.34 首次真实试验中，模型同时提交填引请求与已填写的文本，目标校验拒绝。模型之后提交了空数组，为旧 schema 所拒绝。试验的四次调用上限随后把失败记录为传输错误。draft-0.35 给出 `null` 例子，接受空数组作为无引用，并在拒绝后明确报告失败原因。复测使用新会话，两侧采用同一提问，调用上限为七次。[展厅首次](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-file-quotes-shipment-hall-followup.json) · [馆藏首次](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-file-quotes-digitization-preview-followup.json)
- 复验中两组都走真实 RuntimeLoop 完成两轮，展厅和馆藏最终各由宿主填入 **2** 条引文。逐条核对模型原始提案使用 `null`、回执对应实际发布投影、输出与 SQLite 原件完全一致。四条均通过。每份最终回复在持久化会话历史中各出现一次。[引用审计](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-file-quotes-acceptance.json)
- 馆藏整理版通过全部字段，展厅的文件名、行号和引文正确，编号取成文件编号，B79 的动作和前提字段仍有误。展厅 **39 → 6 行**，未整理与整理总用量 **60,578 → 40,433 Token**，未整理答复结构未过验收。馆藏 **39 → 22 行**，总量 **81,533 → 42,183 Token**，主模型调用 **4 → 2**，双方均无原件页读回。两组完整归档筛选仍待验收。单次总量记录保留实际调用差异。[展厅字段结果](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-file-quotes-shipment-hall-final-review.json) · [馆藏字段结果](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-file-quotes-digitization-preview-final-review.json)
- Backend 全量 **646/646**、定向 **29/29**、V2 桌面 IPC **26/26**。协议包与 Backend 构建、Backend 类型检查和六份提示词分发一致性通过。回归验证旧文件读取在路径内容变更后可跨会话引用，拒绝已有但未发布的证据，请求含无效引用时没有部分最终流输出。[全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-file-quotes-final-backend.log) · [定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-file-quotes-final-focused.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-file-quotes-ipc.log)

## 阶段四十四验证 · V2 桌面两级文档

日期 2026-11-19。统一设计 v0.43。桌面宿主在文档修订变化后发送两级文档视图，按当前连接隔离会话。在本地按工作区、文档和稳定节点 ID 保存顶层与章节的折叠状态。正文树在侧栏顶部，渲染诊断、运行信号与回放可按需展开。[实时事件](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/electron/backend-runtime-host.cjs) · [递归文档视图](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/workbench/src/app/context-document-view.tsx)

- V2 桌面 IPC 最终回归 **26/26**。打开的连接在完整快照之后收到结构变更，顺序与提交结果一致。关闭重连读取权威版本。新会话延续同一项目规则，保留独立的空会话文档。界面刷新事件不进入运行轨迹。[IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-fold-final-ipc.log)
- 实际 Electron 加载 V2 生产渲染资源，通过受控桥接连接真实 BackendRuntimeManager 和 SQLite。验证键盘切换、关闭再开侧栏、改名、跨父节点移动、重排、换会话、延迟旧会话事件过滤、后端重启及渲染器重载。回放与诊断默认折叠。[渲染验证](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-fold-final-renderer.log) · [截图](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-fold-renderer.png)
- 正式 V2 Electron 主进程和 preload 在隔离的项目与应用数据目录中通过验收。通过原生 IPC 提交结构 diff，当前侧栏实时更新。切换到第二个会话时沿用同一项目树，分别恢复两套会话折叠状态。应用完全退出再启动后，SQLite 文档与本地折叠偏好均恢复。本场景使用受控结构 diff，未调用外部推理。[原生 Electron 验证](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-fold-native-verified.log) · [实际工作台截图](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-fold-native.png)
- 共享协议类型、V2 工作台类型与生产构建通过。[协议类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-fold-protocol-types.log) · [工作台类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-fold-final-workbench-types.log) · [生产构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-context-fold-final-build.log)

## 阶段四十五验证 · 大文档结构提案与真实回执

日期 2026-11-19。统一设计 v0.44，Runtime draft-0.36。先从实际投影预算为本轮指令和指定候选预留空间；主轮 schema 要求每项 diff 带候选证据。提交与拒绝审计关联真实请求，当前运行的最近八条结果按需进入主提示词。绑定失败在原事务回滚后使用有界输出修复，旧拒绝和新提案分别留证。[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#23-文档树与版本化结构编辑) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- 真实 `deepseek-chat` 在合成订单材料上依次提交局部重排、改名、新建空章节与移动子树。四条独立用户指令明确要求直接使用编辑协议。会话文档有 **2,048 条**记录，首轮只投影 19 个直接子节点，保留项目规则、本轮候选、可见树和证据。共九次真实主模型调用，无原生工具调用。逐次核对四次提交、相反主张的正文与来源、归档占位、未投影同级顺序、项目文档隔离、运行时视图、训练样本和 SQLite 重开。移动第一份提案触发 `TREE_REFERENCE_NOT_IN_PROJECTION`，使用新投影重提后提交成功。[验收脚本](D:/gitlocals/kanli8-human/capybara-github/capybara/apps/backend/demo/context-tree-eval.ts) · [真实模型报告](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-live-bounded.json)
- 首轮大文档把候选挤出投影；修复后候选显示并通过门禁。早期样本仍出现不同幂等键的重复重排，以及空章节在宽文档下未进入前一轮投影。真实通过使用会话文档的受控编辑任务；自动规划时对虚构动作名的约束、重复结构提案和更大规模的目标节点选择继续单独验收。[候选缺失样本](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-live-initial.json) · [重复提案样本](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-live-retry.json)
- 绑定恢复定向 **35/35**。确认过期 hash 有拒绝回执、文档保持可核实、新一轮使用真实 hash 提交，训练记录分别保留接受及拒绝标签。重开后回执按会话、任务、运行隔离。提示词按需装配后，训练预算定向 **3/3**。[绑定恢复](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-binding-recovery.log) · [训练预算](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-training-budget-recheck.log)
- Backend 构建与类型检查通过。V2 桌面 IPC 定向复测验证两级树、召回、局部结构提交及重连恢复。Runtime 评审正文与分发资源 SHA-256 一致。[Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-binding-final-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-binding-types.log) · [桌面复验](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-binding-desktop.log)
- 预算收敛后的 Backend 全量 **646/647**。信号型训练用例在回放进行中达到测试时限，最终代码下独立复测 **1/1**。绑定修复按本阶段定向结果验收。[全量回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-full-regression.log) · [训练回放复测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-training-replay-recheck.log)

## 阶段四十六验证 · 目标章节投影与重复提案

日期 2026-11-19。统一设计 v0.45，Runtime draft-0.37。投影先安放必要正文和明确指定的章节，再补常规正文。项目候选晋升后的内部投影保留已授权的结构引用。目标状态已满足的改名、移动和重排保存 `unchanged` 回执与原修订，模型与训练记录都能区分核验和实际修改。[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#23-文档树与版本化结构编辑) · [提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- Backend 定向回归 **50/50**。在 **2,048 条**记录的受限会话文档中，新建章节的标题未出现在用户指令里，仍由创建回执进入下一次已发布投影，并可用于移动。受控 RuntimeLoop 拒绝过期提案，换幂等键重复重排获得 `unchanged`；训练记录保留核验回执，SQLite 重开后可以追溯。项目测试验证较窄的内部投影保留已发布的移动地址与晋升候选，重复项目移动只增加回执。整理和提交存储回归另有 **25/25**，训练预算 **3/3**。[定向回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-stability-release-tests.log) · [整理与存储](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-stability-organizer.log) · [训练预算](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-stability-training-budget.log)
- 真实主模型在合成文档上依次完成局部重排、改名、新增空章节和移动。主轮输入上限为 13,000 Token，移动首轮只投影发货材料下的 10 个直接子节点，目标空章节在创建后的下一轮和移动首轮均有真实绑定。八次模型调用完成四次提交，训练记录和 SQLite 重开一致。代理连接异常后使用临时直连复测。首次完整直连观察到模型误抄编辑回执里的请求 ID，后续提示词明确区分 `sourceRequestId` 和当前绑定，对匹配同一次运行已提交编辑的旧 ID 提供有界修复。定向回归确认修复先重取当前绑定，再进入完成检查。[真实模型完整场景](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-stability-live-release.json) · [首次绑定错误](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-stability-live-sequence.json)
- Backend 类型检查、共享协议与 Backend 构建通过。V2 桌面 IPC 定向 **1/1**，验证两级树、召回、结构变更与重连恢复。Runtime 提示词源与分发资源哈希一致。[Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-stability-release-types.log) · [协议构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-stability-protocol-build.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-stability-release-build.log) · [桌面定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-tree-stability-release-desktop.log)

## 阶段四十七验证 · 计划引用的登记与修复

日期 2026-11-19。统一设计 v0.46，Runtime draft-0.39。待执行节点和已完成节点的新增引用采用同一登记检查。未来任务由 `completionConditions` 和 `capabilityIds` 表达。新增动作必须能从当前运行的成功账本核验，已注册 `tool:<name>` 仍可表达待完成要求。新增证据必须已经登记。拒绝记录关联模型原始响应，保留已接受的计划及义务。语义修复最多三轮，仍受运行总预算约束。[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#74-任务拆解与子代理) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- 控制协议和结构编辑定向 **12/12**。同一已接受计划依次拒绝 `propose_diff`、尚未发生的 `call:` 和未登记证据，保留原修订及工具义务。真实工具结果产生后，旧请求绑定和提前完成分别触发修复，模型使用成功回执推进计划并完成。持续提交未发生的 `step:` 在修复预算耗尽后结束，账本与工具执行次数均未增加。[定向验收](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-final-control.log)
- 真实 `deepseek-chat` 在隔离的合成目录任务中验证恢复。评测器仅注入首份含 `propose_diff` 的无效计划，其后六次模型请求走真实配置。模型用当前绑定修正计划并执行一次 `search_resources`，随后误用工具来源的请求 ID 提出完成。宿主要求复制当前绑定并验收计划节点。模型以真实 `call:` 回执完成节点，再完成根任务，最终计划修订为 2。[最终真实模型验收](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-live-verified.json) · [旧请求引发失败的样本](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-live-release.json)
- 初次 Backend 全量 **650/653**。一项 MCP 等待重连在日志时钟跳变后超时，独立复测通过。两项训练用例的估算略超 **9,952 Token** 的剩余额度。压缩规划文字后，沿用同一额度的三项训练复测全部通过。[初次全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-final-backend.log) · [MCP 重连复测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-mcp-wait-recheck.log) · [训练额度复测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-training-compact.log)
- 压缩版 Backend 全量 **648/653**，原训练与等待失败项通过。第二轮留下四项等待超时和一项 MCP 工具投影拒绝，五项均在最终定向复测通过。全量结论以实际记录为准。[压缩版全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-compact-final-backend.log) · [下载复测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-browser-recheck.log) · [结构编辑复测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-final-control.log) · [工具与 MCP 复测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-followup-regressions.log)
- V2 桌面 IPC 全量 **26/26**，最终代码下定向 **5/5**，覆盖独立规划、人工恢复、子任务分配与接管、两级文档和召回。Backend 构建、类型检查和提示词分发校验通过。[桌面全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-final-ipc.log) · [桌面定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-release-ipc.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-verified-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-plan-reference-verified-types.log)

## 阶段四十八验证 · 文档编辑回执与计划节点

日期 2026-11-19。统一设计 v0.47，Runtime draft-0.40。现有 diff 门禁继续校验作用域、候选证据、版本、节点和真实投影。模型在执行阶段从活动节点清单选择 `planTaskId`。实际修改与可验收归属同事务保存，`context:<receiptId>` 可在计划修订和完成检查中引用。已登记但尚未就绪的依赖节点先拦截，提供有限修复。真实旧请求 ID 的误用同样允许有限纠正。[文档编辑与回执设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#23-文档树与版本化结构编辑) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- Backend 定向 **51/51**。验证旧绑定拒绝、依赖未解锁时的拒绝与修复、原子回滚、跨节点复用拒绝、幂等重放和未修改回执的隔离。正向路径保存两次修改且各归原节点。SQLite 重开后可查询两条动作，跨任务、运行和会话的查询为空。受控故障叠加场景配置 16 次控制续轮额度。[定向验收](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-planned-context-verified-regressions.log)
- 真实 `deepseek-chat` 使用六次主轮完成有依赖的「订单材料」和「邮件材料」新建流程。每次编辑只作用于当前活动节点，验收后再解锁依赖。无原生工具调用。项目文档与运行前一致，两份 `context:` 引用在 SQLite 重开后仍属于各自节点。早期样本曾跳过前置节点验收并拷贝旧绑定，均留下拒绝记录。[真实模型验收](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-planned-context-live-final.json) · [前置节点失败](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-planned-context-live.json) · [旧绑定失败](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-planned-context-live-verified.json)
- V2 桌面 IPC 全量 **27/27**。新增用例在编辑提交后等待用户确认，关闭并重连后从 SQLite 恢复章节、待验收的计划节点和原运行。用户确认后使用同一回执验收节点和完成任务，整个过程只提交一次编辑。[桌面全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-planned-context-full-ipc.log)
- Backend 全量 **656/656**。沿用原有训练额度及 MCP 等待约束，将 Node 测试文件并发设为 6。前一阶段全量中曾失败的用例均在本次通过。[Backend 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-planned-context-full.log)
- 共享协议与 Backend 构建、Backend 类型检查、提示词源与分发资源一致性校验通过。[Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-planned-context-verified-build.log) · [Backend 类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-planned-context-verified-types.log)

## 阶段四十九验证 · 常驻文件分类服务与模型档案

日期 2026-11-19。统一设计 v0.48。逐句分类器复用现有 Qwen2.5-0.5B、LoRA 与线性分类头。在本地 CUDA 环境一次加载权重，经 `context_file_disposition_profile` 接收 V4 文件初筛和整份归档复核。混合工具批次按来源类型分包，通用来源沿用通用整理档案。低压力下，没有新增工具结果的追问沿用已提交内容和原件。项目的本地模型档案未配置专用密钥时发送无鉴权请求。[服务与配置](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md#本地文件分类服务)

- Backend 定向 **50/50**，包括同一工具轮的 V3 通用批次、V4 文件批次和归档复核。模拟分类服务在复核阶段返回 503，整批保留原件和原投影，归档及文档更新均未提交。两种情形的无新工具追问都未重跑整理。服务实际编码用量进入宿主持久账本。[定向回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-classifier-profile-release-tests.log)
- RTX 3060 上通过真实 Backend 档案完成借阅、馆藏两组对照。原文组与服务组的读取原件 SHA-256 一致，项目文档不变。主模型前后两轮的字段核对分别均为 **7/7** 和 **8/8**。服务组会话文档均已写入对应字段。馆藏每轮的原文投影从 **39 → 24 行**，总用量 **36,209 → 38,566 Token**。借阅的总用量 **32,871 → 61,193 Token**，服务组追问额外读取原件并增加一次主轮。对照主动开启整理以测量链路消耗，使用原文分支保持相同的工具读取和提问。总用量包含实际主模型调用与整理调用。[真实模型及用量对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-classifier-profile-live-release.json)
- 真实 HTTP 入口通过就绪查询、错误协议、坏 JSON、单文件超窗及工具请求拒绝的检查。接着完成初筛、归档复核请求及相同输入重测，回执保持真实批次、处置顺序和编码用量。校准权重保留旧命令行离线评分路径，既有测试集 **12/12** 个必需片段保留，63 个无关片段中 46 个归档、13 个待核对、4 个误入正文。[HTTP 探针](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-classifier-http-probe.json) · [离线评分](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-classifier-stdin-regression.log)
- Backend 构建、类型检查和提示词分发一致性通过。真实验收使用临时本地监听以及隔离项目档案，测试完成后释放了该监听。[构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-classifier-profile-final-build.log) · [类型](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-classifier-profile-final-types.log)
- Backend 全量 **658/658**，V2 桌面 IPC 全量 **27/27**。[Backend 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-classifier-profile-full.log) · [工作台全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-classifier-profile-full-ipc.log)

## 阶段五十验证 · 文件投影去重与任务前缀复用

日期 2026-11-19。统一设计 v0.49，Runtime draft-0.41。V4 主轮对已绑定的文件候选和成功资源加载使用单一原件引用。候选 ID、证据、原件分页和文档编辑绑定仍可核对。常驻 Qwen2 分类服务在一个请求内部复用任务前缀，各文件独立编码自己的正文。两级文档与运行控制的职责映射汇总到统一设计的第 8.4 节。[统一设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#84-提示词与调用契约共同评审) · [Runtime 初稿](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- 受控请求分段测量中，整理组首轮的会话文档，借阅从 **3,324 → 2,332**、馆藏从 **3,772 → 2,788** 个本地分词 Token，追问也有相近的降幅。此处统计的是实际发出请求中的会话文档，供应商信封及后续模型轮另计。[分段用量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-projection-token-breakdown.json)
- 保持分类权重和输入批次不变，比较 12 个留出批次的 75 项处置。初筛和归档复核的处置全部一致。共享前缀后实际编码量 **10,389 → 6,884 Token**。这个数字衡量本地分类器编码工作量。[分类器对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-classifier-prefix-check.log)
- `deepseek-chat` 配对使用相同合成材料，读取次序固定。两个整理组的主模型首问字段分别为 **7/7、8/8**。借阅追问词面命中 **6/7**，人工复核确认「仅限可核验馆籍的馆际件」保留了评分器要求的适用条件。馆藏追问字段 **8/8**。借阅总用量 **65,804 → 32,602 Token**，主轮从 4 次降到 2 次。馆藏总用量 **33,815 → 77,530 Token**，主轮从 2 次增到 4 次，追问重复提出 `continue`。总量含主模型与整理调用。两组保留了对应原件，且项目文档不变。这次结果支持单轮投影缩减，长期端到端降耗继续验收。[真实模型报告](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-projection-live.json)
- 文件投影定向 **7/7**。覆盖成功与失败加载、真实文件正文引用、未覆盖行、重开后的原件分页和预算压力。初次回归仍按旧格式查找候选标题，改为核验同一候选的结构化引用后通过。[文件投影回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-projection-file-final.log)
- Backend 构建和类型检查通过。V2 桌面 IPC 全量 **27/27**。测试使用的本地分类服务已关闭。[构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-projection-final-build.log) · [类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-projection-final-types.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-projection-final-ipc.log)
- Backend 全量 **658/659**。仅反馈信号的训练用例在回放期间达到测试时限；同一代码和配置独立复测 **1/1**。[全量回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-projection-full-backend.log) · [训练回放复测](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-projection-training-recheck.log)

## 阶段五十一验证 · 纯推理续轮与完成请求

日期 2026-11-19。统一设计 v0.50，Runtime draft-0.43。纯推理 `continue` 携带具体 `reasoningNextStep`。宿主依据同一运行的阶段、实际能力、用户输入与知识节修订拒绝重复待办。纯推理以外，字段仅供审计。工具结果允许重新核对先前问题。拒绝保留模型原响应，并复用有界修复。`finish` 通过现有任务完成门禁后发布最终结果。[状态决策设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#75-状态变化与每轮决策) · [Runtime 提示词](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/runtime.md)

- 首次真实模型验收中，两个整理组都选择 `finish`，同时填了 `reasoningNextStep`，触发格式拒绝。改为依据 `decision` 启用字段后，同一配对任务完整通过。受控回归保留该输入组合，也覆盖完整答复误用续轮、同一待办的空白和句末标点变体、修复预算耗尽以及工具结果后重新核对。[初次真实模型报告](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-live.json)
- `deepseek-chat` 的 draft-0.42 复测中，两种资料在原文与整理组均用两次实际主模型调用完成首问和追问，未触发额外读取或控制续轮。两轮字段分别全命中 **7/7、8/8**。馆藏的整理组从上一阶段四次主轮降为两次。两组各臂的资料原件一致，项目文档保持原状态。包含整理调用的配对总用量，借阅 **30,911 → 32,246 Token**，馆藏 **34,986 → 36,445 Token**。两组总用量均高于原文。[配对复测报告](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-verified-live.json)
- 用本地分词器拆分两轮实际请求。借阅和馆藏的会话文档分别多 **2,101、3,015 Token**，其中树与条目引用合计多 **1,908、2,664 Token**。馆藏两轮文件工具结果少 **646 Token**。供应商的实际输入统计另计。端到端验证继续观察同一文档在普通解题、结构编辑和更长会话中的投影成本。[分段记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-live-token-breakdown.json)
- draft-0.42 全量 **660/663**。一个边界测试匹配了错误的校验文案，两个训练回放的下一次输入超出 **9,952 Token** 额度。draft-0.43 精简重复说明和可空字段的 schema，沿用同一额度。测试等待在最后一次轮询读取实际状态，包含多次干净重试与回放的用例单独延长测试观察窗口。[首次全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-full-backend.log)
- draft-0.43 真实复验中，两种整理组仍分别以 **7/7、8/8** 完成两轮，每组多一次主模型调用。馆藏整理组发生原件补读，原文组反复返回非规范 `completionCheck` 或阻塞不确定性，耗尽输出修复。对照显示真实模型的格式修复、来源补读与总成本仍需分开验收。[精简版真实模型报告](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-compact-live.json)
- draft-0.43 控制定向 **26/26**，V2 桌面 IPC 全量 **27/27**。共享协议与 Backend 构建、Backend 类型检查及提示词分发哈希校验通过。[控制定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-compact-control.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-compact-ipc.log) · [共享协议](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-final-protocol.log) · [Backend 构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-compact-build.log) · [类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-compact-types.log)
- 最终训练定向 **5/5**，覆盖隐藏参考、仅反馈信号、纠正上限、准入冲突和额度耗尽。仅反馈信号用例在原额度下完成校验回放并达到 `ready_to_freeze`。[训练回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-budget-acceptance.log)
- draft-0.43 Backend 全量 **663/663**，首次回归中失败的三个用例均通过。隔离评测用的本地分类服务已关闭。[Backend 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-continuation-release-backend.log)

## 阶段五十二验证 · 完成拒绝反馈与真实模型修复

日期 2026-11-19。统一设计 v0.51，固定 Runtime 正文保持 draft-0.43。RuntimeLoop 按完成检查形状、任务绑定和阻塞情况插入对应修复说明。多模型流式通道保留原回复供宿主审核并抑制待修复文本，修复沿用本次运行的预算和任务义务。[状态决策设计](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md#75-状态变化与每轮决策) · [调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md)

- 在同一馆藏资料的首问和追问重放三种已观察错误。夹具注入额外完成字段、缺少完成检查和误标为阻塞的负责人判断，其后请求走真实 `deepseek-chat`。两个分支均完成两轮，每轮 **8/8** 个字段，三份工具读取原件的哈希一致。三项拒绝保留原响应与拒绝码。原文与整理分支分别发出 **3、2** 次真实主模型请求，修复期间没有重读原件。两臂注入次数不同，报告用量仅用于修复追踪。[真实模型回放](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-completion-repair-live.json)
- RuntimeLoop 受控回归覆盖三种错误连续出现、收据与同一任务状态保留，以及已登记阻塞缺少证据时继续拒绝完成。多模型串流用例确认待修复回复只请求一次并交还宿主，流式内容不作为有效结果回传。原有未知格式重试与模型切换仍通过。[传输定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-completion-repair-transport.log)
- 在三份各 **83 行**的合成原件上自然运行原文和整理配对。两臂首问与追问均为 **8/8**，原件哈希一致。整理组每轮保留的工具原文从 **249 行降到 235 行**。八次分类共 **13,837 Token**，其中模型给出 **166 项 A、14 项 K、69 项 R**。三份文件都跨越 32 片段打包上限，现有规则把跨批 A 转为待核对，保留了拟归档原行。包含本地分类的总用量 **76,189 → 72,630 Token**，实际主轮由 3 次降为 2 次。首个主轮输入从 **23,269 增至 27,506 Token**。当前对照记录了轮次变化和长文件拆包的代价。[长文件配对报告](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-completion-repair-long-live.json)
- 用同一分类器和固定任务背景离线对照两种打包。完整读取按文件分别编码，用量 **11,501 → 10,942 Token**，最长单文件 **3,649 Token**。两种打包均把 8 项必需字段标为保留。按文件打包时归档候选净增 **64 项**，待核对等量下降。探针验证了分类输入和处置，主轮投影、持久归档和复核仍按各自回执验收。[打包探针](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-completion-repair-packing-probe.json)
- Backend 控制与传输定向 **60/60**，V2 桌面 IPC 全量 **27/27**。Backend 构建、类型检查和固定提示词分发哈希校验通过。隔离分类服务已关闭。[定向回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-completion-repair-final-focused.log) · [桌面 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-completion-repair-ipc.log) · [构建](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-completion-repair-build.log) · [类型检查](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-completion-repair-types.log)
- Backend 全量 **666/666**，三项新增回归均通过。[Backend 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-completion-repair-backend.log)

## 阶段五十三验证 · 完整文件打包、归档与连续任务成本

日期 2026-11-19。统一设计 v0.52。选中的专用 V4 文件档案可配置 `file_disposition_batch`。宿主使用该档案的片段和估算字符边界优先保存完整原件，分类服务执行实际 Token 窗口校验。换端点后须重新声明打包能力。通用批次沿用 32 片段，超出边界的读取仍按拆包及待核对规则处理。整份归档复核、双文件正文见证、原件存储及覆盖事务沿用原门禁。[调用契约](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/prompts/v2/call-contracts.md#本地文件分类服务)

- Backend 整理、文件投影与设置定向 **58/58**。新增回归经实际 HTTP 档案发送三份各 40 行的完整读取。两份正文承接各自证据，旧文件完成整份归档复核并可从 SQLite 找回原句。主轮保留唯一待核对的原行，完整读取仍可按原件 ID 获取。另检查档案保存、越界拒绝与端点修改后清除旧能力。[定向回归](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-focused.log)
- 三组发送同样三份各 83 行的原件，并固定主模型输出进行投影对照。原文、默认打包、完整文件三组每轮发送 **249、235、31 行**文件原文。完整文件组从 8 个分类批次减少为 3 个，在重新打开的 SQLite 中验证 **211 条**归档凭据，会话文档保留全部 8 项必需字段。原件哈希与项目文档分别保持一致。本地分词器估算首轮实际请求 **24,080、29,711、17,896 Token**，分类器用量 **0、13,837、11,818 Token**。本地分段统计与供应商用量分别留存。[受控投影](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-wire.json) · [分段记录](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-token-breakdown.json)
- 真实 `deepseek-chat` 三组在首问和追问均答全 **8/8**，每组两次实际主模型请求且未重读。完整文件组主轮总输入 **36,131 Token**，原文组 **47,643 Token**。完整文件组的同会话归档凭据共 **209 条**，每轮保留 **33 行**工具原文。含本地分类和回复的总用量依次为 **49,799、72,951、50,213 Token**。完整文件组比旧打包少 **22,738 Token**，两轮总量仍比原文组多 **414 Token**。[真实三组对照](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-live.json)
- 三轮连续任务复验中，原文组和完整文件组每轮均为 **8/8**，完整文件组验证 **208 条**归档凭据。重启 RuntimeLoop 后，通过实际桌面召回命令取回已归档原句并生成会话候选，完整读取原件的哈希仍相同。初次召回暴露客户端与运行时对返回条数上限的差异，统一为 20 条后复验通过。两组含本地分类的实际总量 **126,292 → 71,173 Token**，实际主模型调用 **5 → 3** 次。只比较各轮首次主请求的输入并计入本地分类，**72,918 → 67,739 Token**，节省 **5,179 Token**。[三轮对照与重启召回](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-followup-verified.json)
- 完整打包主变更的 Backend 全量 **667/667**。合入档案快照与召回协议边界后，Backend 定向 **65/65**，桌面 IPC 全量 **27/27**，最终构建的召回 IPC 定向 **2/2**。最终追加的训练样本验收 **2/2**，确认初筛与归档复核都保留 40 项来源和逐项对齐的监督标签，端点切换期间已启动的批次仍使用原档案快照。共享协议和 Backend 构建、Backend 类型及提示词分发哈希检查通过。本地评测服务已关闭。[Backend 全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-backend.log) · [最终定向](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-release-focused.log) · [桌面全量](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-final-ipc.log) · [召回 IPC](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-release-ipc.log) · [训练样本验收](D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/v2-whole-file-training-acceptance.log)

## 阶段五十四验证 · 跨窗文件复核与原件召回

日期 2026-11-19。统一设计 v0.54，Organizer draft-0.12。专用档案超出单批边界时，宿主先完成所有窗口的初筛，再按同一次读取的活跃正文见证决定是否复核。只有窗口内部且两次均为 A 的片段进入归档。切分边界、初筛 R、复核分歧及无见证的拆包原件按原行保留。分段复核使用同一档案快照与预算，复核绑定错误时拒绝整次整理提交。[调用契约](prompts/v2/call-contracts.md#8-稳定结构化输出与总预算)

- 整理单元回归 **16/16**。三份各 8 行的原件以 4 行分窗，第二批才取得活跃正文见证。仅复核两份有见证的原件，并验证复核选择无法归档初筛 R 或切分行。通过精确字符范围核验 8 段归档，错误批次不会推进覆盖或修改输入文档。[单元回归](../tmp/v2-split-archive-unit.log)
- 三份各 83 行的合成原件，固定主模型回复、使用本地分类器做投影对照。原文、默认 32 片段及配置同样 32 片段的分段复核，每轮分别发送 **249、235、90 行**原文。分段组保留全部 **8 项**必需信息，**145 段**归档可在重开的 SQLite 中核验。9 次额外复核使分类用量从 **13,845 增至 27,885 Token**。本地分词器估算首轮文件工具正文从默认组 **11,487 降至 5,327 Token**，分段组的会话文档仍占 **7,367 Token**。文档树和条目引用合计 **5,649 Token**。[受控投影](../tmp/v2-split-archive-wire.json) · [分段用量](../tmp/v2-split-archive-token-breakdown.json)
- 真实 `deepseek-chat` 首问和追问中，原文组与分段组各两次主轮，均 **8/8**，分段组每轮发送 91 行，SQLite 确认 **144 段**归档。原文和分段组主轮输入合计 **47,622、45,145 Token**，第二组含分类和回复的总量 **74,977 Token**，第一组 **50,237 Token**。同批默认档案组第一轮通过，追问额外续轮后以 `MODEL_TRANSPORT_ERROR` 结束，保留失败报告。[真实配对](../tmp/v2-split-archive-live.json)
- 三轮复验中，两个分支每轮均完成且 **8/8**，三份原件哈希与项目文档未受影响。分段组每轮发送 89 行，持久归档 **146 段**。重启 RuntimeLoop 后经桌面协议从会话归档取回精确原句，并生成会话候选。两组实际主轮次数为 **6、4**，实际总量 **167,787、125,295 Token**。只比较每轮首次主请求并计入分类，原文组 **78,990 Token**，分段组 **96,936 Token**。分段复核已经验证投影和召回，等轮次总成本仍待降低。[三轮对照与重启召回](../tmp/v2-split-archive-reopen.json)
- 用实际请求的两级树索引验证表式编码。保留全部 ID、hash、可见顺序和总子节点数，用行号表示已见的父子关系。每轮回解的树结构与当前请求一致，本地分词器估算每轮节省 **970 至 1,023 Token**。这里记录编码空间，模型的结构编辑能力及实际用量需要独立验证。[树索引编码探针](../tmp/v2-split-archive-tree-density-probe.json)
- Backend 构建、类型检查、六份提示词的分发一致性和 Python 分类器语法检查通过，V2 桌面 IPC **27/27**。隔离分类服务已关闭并确认监听端口释放。[构建](../tmp/v2-split-archive-build.log) · [类型检查](../tmp/v2-split-archive-types.log) · [桌面 IPC](../tmp/v2-split-archive-ipc.log)
- Backend 全量 **668/668**，含跨窗负向用例、局部投影见证失效后的原件恢复，以及两级召回与训练回放。[Backend 全量](../tmp/v2-split-archive-backend.log)

## 阶段五十五验证 · 同一整理事务的分类前缀缓存

日期 2026-11-19。统一设计 v0.55，提示词目录 v0.33。宿主给专用 V4 文件档案的初筛和复核附同一整理事务范围。Qwen2 服务在该范围内保存至多三个任务前缀，每段最多 2,048 Token，并按精确 Token 序列匹配。单个文件仍从独立副本计算。模型输出和文档提交协议沿用原有版本。[调用契约](prompts/v2/call-contracts.md#本地文件分类服务)

- 最初对照把旧单文件整段推理和新分段计算一起比较，出现 A/R 互换。独立数值探针在同一材料的 17 个批次比较整段与分段计算，共有 7 个 A/R 差异。两种路径的比对包含部分旧服务已按文件使用前缀的多文件批次。对照测试改为分别验证两项：相同分段计算的缓存冷暖等价，以及新旧推理路径对已审核标签和业务结果的影响。[初次失败](../tmp/v2-prefix-cache-replay.log) · [数值对照](../tmp/v2-prefix-cache-numerics.json)
- 在同一组 6 个测试来源的三个已审核语料变体上比较实际旧服务路径和新分段路径。逐项检查 **75、75、58** 个带标签的片段实例，两种路径的标签一致。变体共享来源组，分列结果以便追溯。TypeScript 回归同时验证同一事务的初筛、整份复核和分段复核共用范围，独立事务换范围。上阶段单元用例的回执联合类型已改为显式区分见证与归档；完整类型检查和构建通过。[测试语料对照](../tmp/v2-prefix-cache-heldout.json) · [回归](../tmp/v2-prefix-cache-focused.log) · [类型检查](../tmp/v2-prefix-cache-types.log)
- 从实际 HTTP 档案流转记录取 17 个批次，在同一个服务先后按每包独立范围和全程同范围重放两次。冷暖的批次、K/A/R 顺序和标题逐项相同，编码量 **27,885 → 21,928 Token**，两组本地 HTTP 用时 **7.56 → 4.21 秒、6.09 → 4.24 秒**。同一范围改变任务指令时重新编码，变更或清除范围后重新编码。三种前缀占满后第四种仍能推理，超长前缀按普通途径计算。旧服务实际路径在这批材料中产生 5 处 A/R 差异，原先 K 的位置保持。用相同路径隔离缓存开销，再依实测验收语义影响。[HTTP 对照](../tmp/v2-prefix-cache-replay-verified.json)
- 首次真实三轮对照中，原文与分段分支均完成 **8/8**，重启能召回已归档原句。分段分支在第二轮发起三项额外读取，原件集合出现三项新增回执，未满足等读取次数条件。审计确认初次三份原件相同，补读前实际请求中的正文和工具观察已包含全部必需字段。每次模型收费记录仍覆盖发送前输入估算与输出预留；分类器的实际编码量单独统计。[真实任务记录](../tmp/v2-prefix-cache-reopen.json) · [补读与预算审计](../tmp/v2-prefix-cache-reread-audit.json)
- 对两组加入相同的任务约束，要求复述已有资料并保留不确定项。两组只读取原来的三份文件，原件哈希一致，项目文档保持原状态，三轮均 **8/8**。分段组每轮发出 **96 行**，原文组每轮 **249 行**。SQLite 核验 **139 段**归档，重启后原句再次成为会话候选。实际主轮 **5 → 3 次**，总用量 **139,116 → 97,147 Token**。按每轮首次主请求加分类用量对齐，计量 **76,691 → 92,260 Token**。分段组分类编码 **22,030 Token**，发送前预留与结算门禁累计 **96,314 Token**，二者独立留证。[真实三轮复验](../tmp/v2-prefix-cache-reopen-noread.json) · [等轮次用量](../tmp/v2-prefix-cache-matched-cost.json)
- Backend 全量 **668/668**，V2 桌面 IPC **27/27**，整理、投影、召回和训练定向 **64/64**。构建、类型检查与 Python 分类器语法检查通过。隔离分类服务已关闭。[Backend 全量](../tmp/v2-prefix-cache-backend.log) · [桌面 IPC](../tmp/v2-prefix-cache-ipc.log) · [构建](../tmp/v2-prefix-cache-build.log)

## 阶段五十六验证 · 表式文档树与文件证据来源复用

日期 2026-11-19。统一设计 v0.56，Runtime draft-0.44。V4 主轮用表式节点表达可见关系和总子节点数。同一区域的同一文件证据来源记录一次，条目保留真实证据 ID 与文件行。投影层归并重复字段，文档身份、树节点 hash、证据、回执、Typed Envelope 与桌面递归列表维持原有绑定和完整语义。[投影契约](prompts/v2/call-contracts.md#8-稳定结构化输出与总预算)

- 受控文件任务分别核对原件、默认档案与分段档案。在同一次主轮的可见内容上回解旧树和逐条文件证据，分段组首轮的系统内容估算 **16,573 → 14,775 Token**，节省 **1,798 Token**。把实际旧版和新版请求的系统、原生工具与近期消息一起用同一分词器计算，分段组首轮 **23,597 → 21,789 Token**。控件文档树与已提交的完整视图沿用原模型。新版原文组在空树等固定开销上有小幅增加。[受控请求](../tmp/v2-compact-tree-wire.json) · [用量分解](../tmp/v2-compact-tree-token-breakdown.json)
- 首次真实大文档重排已提交，续轮误用回执中的旧请求 ID，现有 `propose_diff` 修复入口只覆盖有计划节点的提案。宿主扩展已知旧绑定修复，继续核对同一任务身份与当前状态。真实复验以 8 次主轮依次提交重排、改名、创建和移动，保留 2,048 条条目及隐藏位置、项目规则和证据身份，训练样本与 SQLite 重启一致。定向回归另外注入旧请求、旧节点 hash 与历史完成绑定，检查恢复后才接受正确提案。[首次失败](../tmp/v2-compact-tree-layout.json) · [结构编辑真实复验](../tmp/v2-compact-tree-layout-verified.json)
- 真实三轮文件任务两组均 **8/8**，三份原件哈希一致。分段组使用精简来源表绑定两条真实证据，宿主按 `material-1.txt:83` 和 `material-2.txt:8` 填入完整原句并生成引用回执。最终模板复验核对 **138 段**持久归档与重启召回。主模型首次请求的总输入 **73,974 → 67,798 Token**，加入 **22,030 Token** 分类用量后是 **89,828 Token**。实际总量 **76,213 → 115,162 Token**，分段组多一次输出修复。等轮次总成本仍高于原文。[引文与召回复验](../tmp/v2-compact-tree-final-quotes.json) · [实际与对齐用量](../tmp/v2-compact-tree-live-cost.json)
- 最终类型检查、构建与提示词同步校验通过，桌面 IPC 全量 **27/27**，加入旧绑定修复后的文档 IPC 定向 **1/1**。定向回归第一次暴露同一夹具注入多种旧绑定时超出默认续轮数，单独为此夹具配置 12 轮后 **73/73**。隔离分类服务已关闭。[定向回归](../tmp/v2-compact-tree-release-focused.log) · [类型检查](../tmp/v2-compact-tree-final-types.log) · [构建](../tmp/v2-compact-tree-final-build.log) · [桌面 IPC](../tmp/v2-compact-tree-ipc.log) · [最终文档 IPC](../tmp/v2-compact-tree-final-ipc.log)
- 紧凑投影全量 **669/669**。纳入旧绑定修复后的全量 **668/669**，唯一失败为同一多重故障夹具的默认续轮额度。该夹具调整后随 73 项定向用例通过，类型检查再次通过。[紧凑投影全量](../tmp/v2-compact-tree-backend.log) · [追加修复全量](../tmp/v2-compact-tree-final-backend.log) · [最终类型检查](../tmp/v2-compact-tree-release-types.log)

## 阶段五十七验证 · 已提交文件处置的同任务复用

日期 2026-11-19。统一设计 v0.57，提示词目录 v0.35。已经部分承接的工具组可以在同一任务内复用。宿主按用户消息身份及原文、排版指令、档案、窗口、冻结范围和提示词指纹匹配，再查 SQLite 中的同一工具组、原件、活跃正文与归档回执。旧组的原件、待核对行和覆盖边界继续有效。新完整工具组可以进入后续整理窗口。[调用契约](prompts/v2/call-contracts.md#本地文件分类服务)

- 整理单元新增用例把窗口缩到两个工具组。已验证的旧组让出批次，后续文件得到内容承接及归档，连续覆盖游标保持原值。改变用户消息身份、排版指令、档案或提供未通过核验的旧组时重新评估。文件投影定向从重开的 SQLite 检查局部组，通过真实回执时允许复用，回执缺失时返回原行。[定向证据](../tmp/v2-file-assessment-proof-regression.log)
- 受控任务连续两批读取六份各 83 行的合成文件，新旧两批全部 12 个要求字段可见。配对分支使用同一分类端点，第二轮保持档案的分支只发送新三份文件，保持旧组完整指纹及归档凭据。第二轮切换档案身份的分支再次发送旧组。分类调用 **48 → 34**，实际编码量 **61,372 → 43,808 Token**，减少 **17,564 Token**。两组的原件仍可按真实回执读取，局部处置与从 SQLite 重新读取的记录一致。初次夹具把资源加载的无调用审计计入分类批次，修正后通过同一对照。[受控配对](../tmp/v2-file-assessment-wire-verified.json)
- 首次真实对照完成任务但出现批次表达歧义。复用组列出全部必需内容，同时对条目计数给出不一致说明。更换档案的分支在最终回复合并时漏写时间，无法按四条记录验收。保留原报告，后续用真实模型逐项核对四条原件的编号、文件、行号和全文。[首次真实对照](../tmp/v2-file-assessment-live.json)
- 真实复验中两组均逐项交付四条原件的编号、文件、行号和全文。独立核验区分两个 V4 文件分类批次和更换档案分支另外发生的输出修复及两次 V3 辅助整理。两组的分类量 **61,860 → 44,288 Token**，主模型首次请求加该分类量 **90,399 → 72,418 Token**。复用组始终保留首批处置凭据和六份可追溯原件，后续只整理第二批。额外模型调用单独记录。[真实逐条交付](../tmp/v2-file-assessment-live-verified.json) · [分角色审计](../tmp/v2-file-assessment-live-audit.json)
- 整理、文件投影、召回、存储与训练定向 **76/76**。增加重开数据库缺少归档回执拒绝复用、同文本新用户消息触发复核的断言后，整理与文件投影复验 **25/25**。Backend 类型检查和构建、V2 桌面 IPC **27/27** 通过。最终构建的文档 IPC 定向 **1/1**。隔离分类服务已关闭。[定向回归](../tmp/v2-file-assessment-focused.log) · [最终凭据回归](../tmp/v2-file-assessment-proof-regression.log) · [类型检查](../tmp/v2-file-assessment-release-types.log) · [桌面 IPC](../tmp/v2-file-assessment-ipc.log)
- Backend 全量 **669/670** 暴露一次训练关闭竞态。实验取消被 RuntimeLoop 拒绝后，旧路径提前关闭运行资源，留下超时回调读取已关闭的 SQLite。宿主现先撤销超时与等待，保存用例终态后统一关闭，并在并发工作异常时等待已启动用例收尾。新增回归注入取消拒绝并等待原期限，确认用例取消、活动模型请求停止且无迟到回调。评分期限与训练纠正耗尽一同复验。实验与训练两套完整测试 **23/23**，最新类型检查与构建通过。[初次 Backend 全量](../tmp/v2-file-assessment-backend.log) · [竞态定向复验](../tmp/v2-file-assessment-cancellation.log) · [实验与训练两套测试](../tmp/v2-file-assessment-experiment-suites.log)

## 阶段五十八验证 · 退款任务组合闭环

日期 2026-11-19。统一设计 v0.58，提示词目录 v0.36。使用独立 V2 桌面 IPC 项目、真实 SQLite、真实文件与本地子 RuntimeLoop。夹具设定输入额度 32,000 Token，由受控模型给出规划、文件分拣和控制意图。

- 用户在首个会话明确声明跨会话规则。项目写入按该消息和会话候选发布。账本的 125 美元和邮件的 120 美元分别带独立原件引用进入会话文档。授权请求打开时，证据分支照常读取文件和委派只读核查。父层用读取回执和结果哈希验收子结果，运行停在待授权状态。重开后用原请求回复，召回 N-41，先得到本会话候选，再凭原文与证据提交 diff。依赖节点凭真实提交回执验收，已经完成的读取和委派不重复执行。第二会话加载同一项目文档，使用新会话文档，检索不到前一会话的私有归档。[组合用例](../apps/workbench/test/backend-runtime-host.test.cjs) · [退款 IPC](../tmp/v2-combined-refund-ipc-shared.log)
- 把组合场景最后一轮交给配置中的 `deepseek-flash`。模型分别引用 `ledger.txt` 与 `mail.txt` 的原句，列出金额分歧、N-41 的审计用途及实际退款待授权。`finish` 绑定原任务、子结果验收、召回和上下文提交回执，宿主完成原运行。该轮实测 **24,436 Token**，其余规划和控制轮仍使用受控响应。[真实主轮](../tmp/v2-combined-refund-live-main.log)
- 本地 Qwen 文件分类器复现 **K/R/K**，预期为 **K/K/A**。检查实际主轮请求，账本与维护记录进入会话文档，邮件原句仍由 `read_file` 结果提供。维护记录未进入归档复核，组合验收在文件处置断言处停止。该样例收入独立测试场景，账本和邮件分别核对原件、金额和主张，维护原句必须可归档及从原件召回。[留出样例](../apps/backend/test/fixtures/context-organizer-quality-cases.json) · [实际分类与投影](../tmp/v2-combined-refund-live-wire-verified.log)
- 训练取消竞态修复后的 Backend 全量 **671/671**，Backend、Workbench 类型检查和六份提示词分发一致性检查通过。首次桌面 IPC 回归中，两个 MCP Workflow 用例遇到所需能力不可见。其中一个缺远端工具定义，另一个触发续传工具投影门禁。隔离复验 **2/2**，随后桌面 IPC 全量 **28/28**。退款样例移入共用留出夹具后的定向复验 **1/1**。隔离 CUDA 服务已关闭并确认监听端口释放。[Backend 全量](../tmp/v2-combined-backend.log) · [初次桌面回归](../tmp/v2-combined-ipc.log) · [MCP 定向复验](../tmp/v2-combined-ipc-mcp-repro.log) · [桌面全量复验](../tmp/v2-combined-ipc-serial.log)

## 阶段五十九验证 · 文件分类的配对任务训练

日期 2026-11-19。统一设计 v0.59，提示词调用契约 v0.13。退款文件模型的旧训练集几乎全用 `material-N.txt` 作文件名。单独换文件名会改变邮件的处置。用户任务换成维护排班后，旧模型仍判退款账本应当保留。诊断使用实际桌面请求中的任务背景和原件。[实际请求采集](../tmp/v2-classifier-refund-capture.log) · [分类诊断](../tmp/v2-classifier-refund-diagnosis.log)

- 9 组各含两个用户任务。每对任务共享同项目内五份原件和文件名，四份随任务交换 K/A，另有一份归属未明的材料保持 R。通过真实文件读取、V4 整理和归档复核得到 **54** 条语料，准入后全量为训练 **152**、验证 **12**、留出 **24** 条。旧留出 12 条逐行一致，项目、会话和来源组未跨切分。退款工作台样例用于检验候选模型。[配对样例](../apps/backend/test/fixtures/context-span-contrast-cases.json) · [采集](../tmp/v2-span-contrast-capture-verified.log) · [准入](../tmp/v2-span-contrast-admission.log)
- 分类训练读取受审的独立验证集，并支持从既有训练集保留指定来源组。缺失的验证组在模型分配前被拒绝。使用 RTX 3060 Laptop 完成四轮训练，峰值预留 **1,490 MiB**。按独立验证选择第 3 轮，36 条 K、212 条 A、14 条 R 均通过该验证集处置检查。[训练记录](../tmp/v2-span-contrast-train.log) · [候选权重配置](../tmp/v2-span-contrast-weights/classifier.json) · [参数负向验收](../tmp/v2-span-contrast-invalid-group.log)
- 按实际服务的推理路径重放留出批次。旧留出整批正确数 **2/12 → 12/12**，新增配对留出 **0/12 → 9/12**，其中首次处置 **0/4 → 2/4**。新配对留出仍有一次 K 进入 R、一次 R 进入 K，以及无关片段漏归档。两组留出均未发现必要或待核对原句被新模型归档。退款首次处置为 K/K/A，独立复核为 A。[留出明细](../tmp/v2-span-contrast-eval.jsonl)
- 双模型首次桌面 IPC 验收发现重复回填。授权回复触发整理，小模型把已有归档原句写入临时主题，随后显式召回又把相同原件范围写入审计索引。宿主现核验原有归档回执，保留该范围的归档承接并继续评估待核对原句。真实分类服务通过项目 V4 档案接入，最终报告由 `deepseek-flash` 生成。复验中账本和邮件各带独立证据，N-41 经显式召回只在审计索引出现一次，两级文档范围与实际退款待授权状态通过检查。规划与子代理动作为受控响应。[重复诊断](../tmp/v2-span-contrast-refund-lineage.log) · [双模型工作台复验](../tmp/v2-span-contrast-refund-live-verified.log)
- 三份长原件的受控主轮验收保留 **8/8** 个必要字段并核验 **217** 段持久归档。真实主模型的原文组连续三轮均答全 **8/8**。整理组在文档中保留 **8/8**，重开后可召回原文。首轮主模型把 `finish` 作为未投影的原生工具调用，宿主拒绝，答复质量和等轮次用量仍缺验收证据。[受控长文档](../tmp/v2-span-contrast-long-projection.json) · [真实长任务](../tmp/v2-span-contrast-long-live.json)
- 整理、投影、召回和训练链路定向 **35/35**。退款 IPC 定向通过，覆盖新任务下尝试重新分类已归档原句。同步后的 Backend 构建与类型检查通过，语料准入测试 **3/3**。[Backend 定向](../tmp/v2-span-contrast-archive-verified.log) · [退款 IPC](../tmp/v2-span-contrast-ipc-focused.log) · [类型检查](../tmp/v2-span-contrast-backend-types.log)
- 本阶段 Backend 全量 **672/672**，V2 桌面 IPC 全量 **28/28**。隔离分类服务端口已释放。[Backend 全量](../tmp/v2-span-contrast-backend-full.log) · [桌面全量](../tmp/v2-span-contrast-ipc-full.log)

## 阶段六十验证 · 完成通道与结构化引文修复

日期 2026-11-19。统一设计 v0.60，Runtime draft-0.46。继续用三份长文件核对首问、追问和结构化原文引用。本地模型、三份原件与业务任务保持可比，复验沿用同一主模型已答全的原文组记录。

- 首次整理组因主模型用未投影的原生 `finish` 提前终止。宿主在当轮允许完成时，用已有额度请求重新提交 `ControlEnvelopeV2`。实际工具名单、义务、状态与证据继续由原账本核验。[最初拒绝](../tmp/v2-span-contrast-long-live.json) · [控制定向](../tmp/v2-native-finish-repair-focused.log)
- 后续真实模型复验完成首问和追问，最终 JSON 却把第 1 行证据的引文标成第 83 行。宿主增加 `file`、`line` 与同层 `quote` 的原件位置一致性检查。绑定错误的原响应保留在审计中。会话、运行和任务匹配且状态为当前版本时，错误请求 ID 可在现有额度内纠正。异会话、异任务和未经允许的工具仍走原验证入口。[引文错位](../tmp/v2-native-finish-long-live.json) · [请求绑定失败](../tmp/v2-file-quote-source-long-live.json)
- 最终真实复验原文组和整理组三轮均为 **8/8**。整理组每次主轮发送的文件原行 **249 → 23**，核验 **217** 段归档并在重启后召回。最终 JSON 引用 `material-1.txt:83` 和 `material-2.txt:8`，回执与原件字符范围一致。实际主模型调用 **5 → 3**，含本地分类的总量 **131,014 → 81,104 Token**。按每轮首次主请求对齐，主轮输入 **74,178 → 55,910 Token**，计入 **22,264 Token** 分类量后为 **78,174 Token**。第一次请求对齐的总输入仍高 **3,996 Token**。[最终真实复验](../tmp/v2-context-v060-long-live.json)
- 上述原文成功记录沿用了早一版 Runtime 提示词。用 draft-0.46 对同原件重新跑原文组，前两轮 **8/8**，第三轮发起额外规划并耗尽评测器的续轮上限。三轮的首次主模型输入合计 **74,366 Token**。该次原文组缺少完整交付，用量留作追溯，等版本三轮成功的效果和成本对照仍待验收。[等版本原文复测](../tmp/v2-context-v060-matched-live.json)
- 控制、结构化引文、整理及文档树定向 **58/58**。包括原生完成意图与错误 requestId 的连续修复、错行引文的重新选择、流式回复只发布核验后的引文，以及原计划义务保留。Backend 构建、类型检查和提示词分发一致性通过。[定向复验](../tmp/v2-context-v060-focused.log) · [构建](../tmp/v2-context-v060-build.log) · [类型检查](../tmp/v2-context-v060-types.log)
- 使用最终构建和提示词再次完成真实双模型退款 IPC。首次外部请求收到 HTTP 200 后，测试夹具的等待期限先到，主动取消了该请求。仅调整真实模型夹具的等待额度后复验 **1/1**，最终报告分别引用账本及邮件各自的原件位置，确认 N-41 的召回回执和退款待授权状态。[初次外部请求](../tmp/v2-context-v060-refund-live.log) · [最终退款复验](../tmp/v2-context-v060-refund-verified.log)
- V2 桌面 IPC 最终构建全量 **28/28**，隔离分类服务已关闭并确认监听端口释放。[桌面全量](../tmp/v2-context-v060-ipc-full.log)
- 最终构建的 Backend 首次全量 **666/673**，并行运行中出现 7 项等待超时，涉及 WebSocket、完整文件归档和旧 Cache Hook。逐项隔离复验 **7/7**。按 3 个并发测试进程复跑全量，最终 **673/673**。[首次 Backend 全量](../tmp/v2-context-v060-backend-full.log) · [超时用例定向复验](../tmp/v2-context-v060-timeout-retest.log) · [Backend 全量复验](../tmp/v2-context-v060-backend-isolated.log)

## 阶段六十一验证 · 整份原件打包与 JSON 交付

日期 2026-11-19。统一设计 v0.61，本阶段 Runtime 从 draft-0.47 更新到 draft-0.48。用同一主模型、同一提示词和三份各 83 行的原件比较原文与整理后的效果。记录每次用户请求的首次主轮、其余模型请求和分类服务实际用量。最终回复按完整 JSON 解析，与原件逐字段核对。[场景](../tmp/v2-completion-repair-long-facts.json) · [评测入口](../tmp/v2-v061-file-comparison.mjs)

- 使用 draft-0.47、同一任务、受控主模型答复和真实分类端点比较两种打包档案。32 片段档案发出 8 个初筛批次及 10 个复核批次，分别使用 **11,101** 和 **11,105 Token**。`128` 片段及 `16000` 字符的档案把三份原件放在 3 个完整初筛批次中，使用 **11,050 Token**。两次均由会话文档承接 **8/8** 项必要信息，并支持重开后召回。档案上限由所用端点和训练模型确定，整份拟归档或跨包时仍按各自条件复核。[拆包档案](../tmp/v2-v061-split-file-projection.json) · [整份档案](../tmp/v2-v061-full-file-projection-verified.json) · [档案配置](prompts/v2/call-contracts.md#本地文件分类服务)
- draft-0.46 的真实复验中，两组均完成三轮，关键词检查均为 **8/8**。JSON 外的说明导致原文组无法按整份 JSON 解析，整理组还省略了原句前缀。评测把报告型续问和第三轮结构化交付的要求分开。draft-0.47 要求 `userMessage` 整体符合用户指定的 JSON 字段。文件引文解析拒绝外层文本时，修复提示要求保留现有义务并提交纯 JSON。回归在流式输出中检查无效草稿不会发布，修复后的文件位置和全文通过核验。[初次真实复验](../tmp/v2-v061-full-file-live.json) · [提示词](prompts/v2/runtime.md#输出) · [定向回归](../tmp/v2-v061-quote-focused.log)
- draft-0.47 的同版真实复验用 DeepSeek 完成三轮，两组各轮的必要字段都是 **8/8**。最后一轮整份 JSON 的两个结构化引用分别与 `material-1.txt:83` 和 `material-2.txt:8` 一致。原文组与整理组的逐文件哈希相同，每轮主请求发送的工具原行 **249 → 4**。整理组核验 **240** 段 SQLite 归档，重开后召回原句。该次真实复验的最终答复采用原句复制；`fileQuotes` 的回执与错位修复另由定向回归及阶段六十的真实运行验证。[同版真实复验](../tmp/v2-v061-full-file-live-verified.json)
- 按每次用户请求的首次主请求对齐，主模型输入 **74,224 → 51,164 Token**，加上整理组实际分类输入 **11,051 Token** 后为 **62,215 Token**，减少 **12,009 Token（16.2%）**。实际主模型调用 **6 → 3**，含分类与所有修复的总用量 **158,363 → 64,695 Token**。原文组的三次额外请求用于修复外层控制协议和当前绑定。总用量仅代表本组运行。档案收益和控制修复成本需在更多真实任务上复验。[请求与用量原件](../tmp/v2-v061-full-file-live-verified.json)
- 通用配对评测从整份用户可见文本验证 JSON，并逐轮记录首次主请求与额外请求。退款样例的初次复验中，两组首问均未提交完整 JSON；明确业务输出的范围后，两组均交付 **9/9** 个字段。整理组额外重读了 `source-a.txt`，原件与投影条件不再对齐，评测拒绝计算用量差值。该样例用于后续核对重复读回与整理失败的原因。[配对评测入口](../apps/backend/demo/context-quality-eval.ts) · [第一次复验](../tmp/v2-v061-two-turn-eval.json) · [明确 JSON 交付后的记录](../tmp/v2-v061-two-turn-eval-verified.json)
- draft-0.47 控制及原件定向 **37/37**，V2 桌面 IPC **28/28**，Backend 构建及类型检查通过。Backend 全量首跑缺少仓库要求的夹具路径，补齐后的有效全量为 **671/673**。两项失败在训练纠正轮复现，请求预计用量超出原 **9,952 Token** 上限。draft-0.48 合并 `userMessage` 的格式规则，降低固定提示词长度，复验继续使用原训练额度。[定向回归](../tmp/v2-v061-quote-focused.log) · [桌面 IPC](../tmp/v2-v061-ipc.log) · [完整 Backend 结果](../tmp/v2-v061-backend-verified.log)
- draft-0.48 的训练、控制和原件定向 **51/51**，包括上述两个预算用例。最终 Backend 构建通过，六份提示词源文和分发内容一致。桌面 IPC 的退款与两级上下文定向 **2/2**。[原预算复验](../tmp/v2-v061-compact-regression.log) · [最终构建](../tmp/v2-v061-compact-build.log) · [最终 IPC 定向](../tmp/v2-v061-compact-ipc.log)
- draft-0.48 的两组真实模型再次完成三轮，各轮 **8/8**，末轮两条 JSON 引文逐字一致。主请求中的原文件行 **249 → 5**，整理组核验 **239** 段持久归档并在重开后召回。按首次主轮对齐并计入整理的 **11,052 Token**，输入 **74,036 → 62,078 Token**，下降 **16.2%**。两组均有 4 次主模型请求，实际总用量 **103,826 → 83,929 Token**。隔离分类端点结束后验证已释放。[最终同版真实复验](../tmp/v2-v061-compact-file-live.json)

## 阶段六十二验证 · 真实规划与原生控制

日期 2026-11-20。统一设计 v0.62，Runtime draft-0.50。新增可重复的 V2 桌面 IPC 退款验收。项目规则由夹具提交，人工同意使用固定场景回复。规划、提问、工具调用、子模型、父层审核、文档提案及最终答复使用真实模型。文件分拣走项目配置的本地 V4 模型档案。报告记录实际能力投影、模型提出的决策、工具回执与状态变化。[真实验收入口](../apps/workbench/test/live-refund-acceptance.cjs)

```powershell
npm run build --workspace=apps/backend
$env:CAPYBARA_REFUND_CLASSIFIER = 'http://127.0.0.1:<隔离文件分类器端口>/v1'
$env:CAPYBARA_REFUND_REPORT = 'tmp/refund-live-report.json'
node apps/workbench/test/live-refund-acceptance.cjs
```

- 首次真实模型在无工具的规划轮提交了计划。进入执行后反复用 `continue` 描述预期工具调用，试跑在第 17 次模型请求停止。最小探针确认 DeepSeek Flash 在文本和 JSON 请求中都能发原生调用。主执行轮按是否实际投影工具选择请求方式，同时保留宿主的 ControlEnvelope 校验。[首次模型请求](../tmp/v2-v062-live-refund.json) · [原生通道探针](../tmp/v2-v062-native-probe.log)
- 后续试跑发现默认项目还要求旧的 `status: running`，并观察到无变化的纯推理和过期控制提示进入后续整理。项目默认值改由当前 V2 协议统一，计划轮的旧 `running` 进入有界修复。无新观测的连续纯推理限三次，恢复后可实际调用工具。已接受的计划从权威账本投影，修复提示只进入紧接的修复轮，V4 整理留存此类源记录供审计。[旧格式循环](../tmp/v2-v062-live-refund-stage.json) · [格式修复回归](../tmp/v2-v062-legacy-repair.log)
- 真实模型发出了本地委派，并同批附上一个独立搜索。既有门禁在分发前拒绝全部动作。新修复要求以相同的活动节点和真正获授的只读能力单独提交委派。超出当前节点的分支问题也可有界修复，错误绑定不写入任务账本。[真实混合批次](../tmp/v2-v062-live-refund-clean.json) · [拒绝及修复定向](../tmp/v2-v062-new-gates.log)
- 代理连接试跑出现两次 `ECONNRESET` 后停止。使用隔离直连运行同一任务，DeepSeek Flash 首先提出绑定的人工问题，随后在授权仍待回复时读取三份文件、纠正混合工具批次并真实委派。本地子运行只投影 `search_resources`，模型用真实回执完成能力查找。父模型读取子结果和两个原件页，用实际读回执与结果哈希提交 `accept`，宿主产生成功的 `consume_child_result` 回执。首次完整试跑的 30 次模型请求额度用完，暂停、重连和最终召回交付待复验。[代理请求失败](../tmp/v2-v062-live-refund-exclusive.json) · [真实规划、执行与父层接收](../tmp/v2-v062-live-refund-direct.json)
- 后续验收档案用 900,000 Token 和 50 次请求上限，并从 SQLite 分角色读取实际用量。直连的一次请求在 DNS 和连接层失败。恢复常规代理后，真实父层再次完成三份原件读取、委派与结果验收。本地 Qwen 文件模型有一笔真实请求，报告用量 **678 Token**。父层随后把 `ask_user` 放入原生函数通道，宿主拒绝，人工回复与重连尚未开始。新增修复仅在本轮允许 `ask_user` 时请求重新提交带真实绑定的 Envelope。模型提供的旧参数不进入实际询问。[直连请求失败](../tmp/v2-v062-live-refund-budgeted.json) · [真实模型、子结果和文件模型用量](../tmp/v2-v062-live-refund-final.json)
- 最终定向回归 **112/112**，覆盖主轮控制、阶段投影、本地委派、V4 元数据保留、系统变量和训练额度。原生提问修复用例核对了丢弃无效参数、重新绑定及唯一人工请求的发布。V2 桌面 IPC 定向 **5/5**，Backend 构建和类型检查通过，六份提示词与分发内容一致。隔离文件分类服务已关闭。[Backend 定向](../tmp/v2-v062-release-focused.log) · [桌面 IPC](../tmp/v2-v062-release-ipc.log) · [构建](../tmp/v2-v062-release-build.log) · [类型检查](../tmp/v2-v062-release-types.log)

## 阶段六十三验证 · 人工回复回执与计划更新

日期 2026-11-20。统一设计 v0.63，Runtime draft-0.51。

- 真实退款复跑中，模型在一次计划修订中新增核查节点并关联不确定性。原校验只认识提交前的节点，该提案因此被拒。宿主现先校验同一计划提案中新增节点的引用，随计划通过一起登记不确定性。局部提问、等待与补证据继续使用已登记节点和当前活动状态。[同轮引用拒绝](../tmp/v2-v063-refund-baseline.json) · [规划和控制回归](../tmp/v2-v063-final-focused.log)
- 人工回复后，宿主从已满足的订阅和 SQLite 中实际匹配的用户信号恢复 `branchHumanReplies`。回执绑定原会话、运行、任务、计划节点和用户消息。用拒绝答复测试持久性，模型按原词判断授权结果。重开后的原节点可凭 `human:<requestId>` 验收。旁支复用同一回执、伪造用户信号和重复回答分别在原门禁拒绝。受控桌面退款测试将真实回复与召回回执共同写入原授权节点。[等待存储与计划测试](../tmp/v2-v063-late-files-focused.log) · [桌面 IPC](../tmp/v2-v063-final-ipc.log)
- 真实主模型在授权待回复时读取三份源文件并验收了子结果，随后把计划修订放进原生工具通道。宿主沿用有限输出修复，要求本轮允许的单个控制意图以原绑定和实际 schema 重新提交。无权调用的工具依旧拒绝。之后同一真实场景持续重新规划与搜索，下一次规划请求耗尽可用额度，最终退款报告仍待一次完整的双模型实测。[真实子结果及规划通道路由](../tmp/v2-v063-refund-human-receipt.json) · [下一次规划的预算拒绝](../tmp/v2-v063-refund-final.json)
- 捕获的通用整理请求多次重复处理较早的项目规则与模型执行说明，后到文件未进入专用窗口。专用档案现在可单独处理窗口之外的完整文件组，保留已有连续覆盖边界。向隔离场景预置 **12** 条待核对历史，使用真实 Qwen 对三份共 **249** 行的原件完成整理，保留 **8/8** 个必要字段；主请求发送工具原行 **6** 行，**237** 段有 SQLite 归档证明且重开后能召回，分类输入合计 **11,005 Token**。旧记录原样保留，覆盖位置仍为 **0**。主模型使用受控回复。[窗口饥饿请求](../tmp/v2-v063-refund-human-receipt.json) · [真实本地分类验证](../tmp/v2-v063-late-file-real.json)
- 控制、计划、等待和子运行定向 **94/94**；最终文件、计划与等待交叉回归 **67/67**；最新版 V2 桌面 IPC 定向 **5/5**。Backend 构建和类型检查通过。[控制回归](../tmp/v2-v063-final-focused.log) · [交叉回归](../tmp/v2-v063-late-files-focused.log) · [构建](../tmp/v2-v063-late-files-build.log) · [类型检查](../tmp/v2-v063-final-types.log)

## 阶段六十四验证 · 独立人工输入阶段

日期 2026-11-20。统一设计 v0.64，Runtime draft-0.53。

- 既有真实运行反复在授权节点使用加载、搜索和重新规划，却迟迟未登记所需的用户问题。计划现在可以声明只需人类答复的 `human_input` 节点。该轮使用 JSON 控制请求，允许提问和计划修订。完成时需原节点绑定的 `human:` 回执。原有节点在改版后仍可按其声明的阶段执行。[上轮状态轨迹](../tmp/v2-v063-refund-final.json) · [新阶段测试](../tmp/v2-v064-exclusivity-tests.log)
- 真实主模型首次采用 `human_input` 节点，在无原生工具的轮次提出授权问题，随后读取三份文件。模型后来尝试为已登记的原人工事件创建第二次等待，宿主拒绝并要求继续独立分支或提交完成回执。受控回归核对原等待持续存在、独立读取完成、拒绝根范围提问，以及原运行重连后通过确切回复回执完成授权节点。[真实授权与独立读取](../tmp/v2-v064-refund-human-phase.json) · [控制回归](../tmp/v2-v064-exclusivity-tests.log)
- 通用批次与完整文件读取混在同一个窗口时，专用文件事务可以独立运行。真实退款复跑核对到本地分类请求与发给主轮的两份金融来源；控制运行在混合 `request_planning` 批次处停止。该批次现走单动作重提修复。加入两条较早的未整理历史，另一真实本地分类对照保留 **8/8** 项必要信息、**237** 个有持久证明的归档片段，重开后召回成功。原件仍可沿来源取回，连续覆盖位置保持 **0**。局部文件主请求为 **6** 行。本次分类输入合计 **11,007 Token**，隔离场景的主模型使用受控响应。[真实退款文件申请](../tmp/v2-v064-refund-final.json) · [文件混合窗口对照](../tmp/v2-v064-mixed-files.json)
- 文件读取验收后，真实模型曾尝试给子任务授予当前计划节点漏列的搜索能力。原能力门禁拒绝该派发。模型随后误将失败的调用作为新义务，计划门禁拒绝引用。工具和修复提示现分别引导模型修订原节点的 `capabilityIds`、从 `runtime_state.tasks` 恢复已接受的义务。[实际授权拒绝和计划拒绝](../tmp/v2-v064-refund-exclusivity.json)
- 后续真实退款运行正确投影只读搜索能力。子代理用实际工具查找后在提交结果时超时，父层读取超时结果、提交 `reject`，并用实际审核回执接管原节点。验收等候暂停状态时超时，因此这次记录只覆盖授权问题发布、独立调查、委派和超时接管；授权回复、重连及最终交付仍需在正常路径一起验证。[真实退款试跑](../tmp/v2-v064-refund-authorization.json)
- Backend 最终定向回归 **128/128**，规划及混合调用拒绝回归 **43/43**，V2 桌面 IPC 定向 **5/5**。后续设计评审稿 v0.65 以这些记录为阶段六十四的局部证据。[Backend 定向](../tmp/v2-v064-authority-focused.log) · [规划和控制定向](../tmp/v2-v064-exclusivity-tests.log) · [桌面 IPC](../tmp/v2-v064-release-ipc.log)

## 阶段六十五验证 · 委派范围与控制修复

日期 2026-11-20。统一设计 v0.66，Runtime draft-0.56，Child draft-0.2。

- 真实模型曾在仅授予资源搜索时要求子任务查阅订单原句。子代理取得真实搜索回执后按权限边界求助。父层随后把自己的人工请求 ID 和子 `waitRef` 放入一个 `child.ready` 等待，原登记被拒，试跑结束。现在每种等待按当前运行和事件类型校验相关值；混用或错绑计划节点走有界修复并保留原订阅与义务。[真实失败轨迹](../tmp/v2-v065-refund-child-budget.json)
- 子任务普通正文交付或原生 `finish` 意图进入受限的 JSON 修复轮。该轮工具投影为空，原结果、原子任务和实际工具回执保持可核查。最终仍经子任务完成门禁和父层审核。受控回归验证只执行一次搜索，并在实际子完成后接受子结果。Backend 定向 **99/99**，构建与类型检查通过。[控制回归](../tmp/v2-v065-final-targeted.log) · [构建](../tmp/v2-v065-final-build.log) · [类型检查](../tmp/v2-v065-typecheck.log)
- 限定为目录查找后，真实子代理用原搜索回执完成，父代理在授权待回复时凭子结果哈希、读取回执实际提交 `accept`。运行进入暂停。验收脚本当时沿用前一次主动发布的快照，导致在重连前误判没有已验收子任务。脚本现在在暂停和完成时主动取得当前快照，用订阅登记与真实消费事件核对先后。[真实完成、消费及暂停记录](../tmp/v2-v065-refund-scoped-control.json)
- 后续真实复跑尝试在计划修订中把正在等待的人工节点由 `owner: user` 改为 `owner: parent`。运行时拒绝变更。提示词与有界修复现在要求原样保留待回复或委派节点的负责人、阶段、依赖与能力，修订仍可验收独立工作。[原计划与拒绝](../tmp/v2-v065-refund-reconnected.json)
- 下一次真实复跑中，子模型经空工具 JSON 修复和证据复核完成，父层在授权待回复时验收。同一任务实际关闭、重连，原人工节点凭真实回复回执验收；主模型召回 N-41 的归档原句。7 次本地分类请求报告合计 **3,464 Token**。回填提案缺少提示词未列出的 `projectAnchors`，三次修复后停止。现在主轮 schema 复用分类定义，拒绝时明确字段，提示词说明会话 `add_entry` 的局部回填方式。[真实重连与召回记录](../tmp/v2-v065-refund-release.json) · [调用契约](prompts/v2/call-contracts.md#8-稳定结构化输出与总预算)
- 修正分类 schema 后，桌面退款受控回归发送在缺 `projectAnchors` 的会话提案，收到精确提示，使用同一召回候选回填并完成。真实模型 v0.55 复跑再现原任务重连及人工回复，但在把新要求纳入计划时遗漏原报告授权条件。宿主拒绝该计划。Runtime draft-0.56 在提示词和修复消息中要求保留原条件并追加新工作。[桌面回填](../tmp/v2-v065-classification-ipc.log) · [真实计划义务拒绝](../tmp/v2-v065-refund-classification.json)
- v0.56 的真实复跑中，子模型多次搜索已找到的注册项，耗尽子预算，父层拒绝子结果并请求接管。父层随后想以接管前的调用验收该节点，原计划门禁拒绝。接管后的修复轮现在明确要求先凭当前 `takeoverId` 完成一项实际动作，再引用新回执验收原节点。[真实预算耗尽与接管](../tmp/v2-v065-refund-v056.json)
- 最终 Backend 定向 **99/99**，覆盖接管后提前验收拒绝与原动作重播。桌面 IPC 全量 **28/28**；修复后的退款、等待、规划和文档回执定向 **4/4**。上下文、投影与训练定向 **60/60**，六份提示词与分发资源一致。真实退款场景已观察到正常路径的重连、人工答复及召回；受控桌面路径已验证回填与交付，真实正常路径仍待一次合并验收。[最终控制回归](../tmp/v2-v065-final-release-targeted.log) · [最终桌面定向](../tmp/v2-v065-final-release-ipc.log) · [桌面全量](../tmp/v2-v065-desktop-ipc.log) · [上下文与训练](../tmp/v2-v065-context-training.log)

## 阶段六十六验证 · 查询复用与原件召回

日期 2026-11-20。统一设计 v0.67，Runtime draft-0.60，Child draft-0.3。

- 子代理曾三次拿到同一个 `read_file` 目录项，随后耗尽子预算。当前目录仍与真实可见回执一致时，宿主拒绝全部重复的搜索批次，用空工具投影请求带原依据的控制 JSON。另一查询仍正常进入工具轮。单个已知控制意图误走原生通道时，主层也使用空工具投影修复。[原重复搜索](../tmp/v2-v065-refund-v056.json) · [查询与控制回归](../tmp/v2-v066-progress-targeted.log)
- 第一次真实复验中，子代理经结构化回合成功完成，父层使用真实读取回执验收并进入暂停。重连取得绑定答复后，模型以 `basePlanRevision=1` 提案，宿主当前修订为 `2`，该轮原门禁拒绝。后续修复消息给出当前计划修订号，保留任务绑定和已有效的答复。[真实重连与计划拒绝](../tmp/v2-v066-refund-catalog.json)
- 旧召回结果将重新读取的 JSON 分页包装排在 N-41 的原始归档片段前。现在先比较匹配词数量，同等匹配时原始来源优先。原件较长但单条归档片段已完整返回时，不为这条完整片段生成补读警告。真正截断、缺少必要信息或用户明确要求读取的原件仍可访问。[统一召回设计](v2-context-capability-control-design.md#54-统一召回与原件读取)
- Runtime draft-0.57 与 Child draft-0.3 的真实复验完成暂停、重连、人工答复和子结果验收，N-41 原句为第一条召回结果。模型对这段原文提出回填后，控制修复轮的两次模型传输均遇到 `ECONNRESET`，正文回填和终态未获验收。本次本地分类的六次请求报告合计 **3,089 Token**。验收脚本给传输多一次有界尝试，仍检查同一任务及正常结果路径。[真实召回](../tmp/v2-v066-refund-recall.json) · [传输记录](../tmp/v2-v066-refund-recall.log)
- 涉及计划、子代理、召回和训练闭环的 Backend 定向 **114/114**。当前构建和类型检查通过。桌面 IPC 退款、等待、规划和文档回执定向 **4/4**，受控退款覆盖实际会话回填和结束门禁。[Backend 定向](../tmp/v2-v066-release-targeted.log) · [桌面 IPC](../tmp/v2-v066-release-ipc.log) · [构建](../tmp/v2-v066-recall-build.log) · [类型检查](../tmp/v2-v066-recall-types.log)
- 增加一次有界传输尝试后的真实复跑再次完成重连和召回。回填提案把正文需求写成 `diffVersion: 1` 的 `add_heading`，缺少可见节点绑定，三次重提后仍被拒绝。draft-0.58 通过同一 schema 明确结构绑定，在修复消息中引导正文使用一个带真实来源的 `add_entry`。分开核对章节树与正文证据。[真实结构错误](../tmp/v2-v066-refund-release.json) · [结构化输出](prompts/v2/call-contracts.md#8-稳定结构化输出与总预算)
- 下一次真实复验在同一轮成功读取三份文件，助手回复附带进度文字。旧选择器要求助手正文为空，这组真实读取因旧历史一直待处理而未进入文件分类，三次归档查询均未命中。专用分流现在检查实际工具及结果，保留原助手正文，单独处理文件部分。计划修复也明确人工回执归原节点，下游只记录依赖。[真实文件分流轨迹](../tmp/v2-v066-refund-tree.json)
- 修复文件分流后的试跑首轮将根任务 ID 同时作为计划节点 ID，原门禁拒绝。提示词和修复轮现明确节点使用独立 ID，依赖引用节点且保留已接受的身份与计划修订。[真实根任务 ID 拒绝](../tmp/v2-v066-refund-final.json)
- 使用实际 Qwen 分类三份长文件，读文件轮带助手文字，前面有两组待核对历史。三个主轮均保留原进度说明及 **5** 行工具原文，正文承接 **8/8** 项必要信息，**238** 个归档片段有持久证据，关闭重开后召回通过。连续覆盖游标保持 **0**；分类输入合计 **11,006 Token**，主轮采用受控回答。[真实本地文件分类](../tmp/v2-v066-commented-files.json)
- 结构绑定与分类错误连续重提的桌面退款通过。当前阶段 Backend 跨链路定向 **145/145**、最后提示词与根 ID 修复定向 **71/71**、文件原件与事务定向 **68/68**、能力与 MCP 定向 **52/52**、结构校验后桌面定向 **4/4**。[Backend 跨链路](../tmp/v2-v066-final-targeted.log) · [最后定向](../tmp/v2-v066-v060-targeted.log) · [原件与事务](../tmp/v2-v066-context-authority.log) · [能力与 MCP](../tmp/v2-v066-capabilities.log) · [桌面](../tmp/v2-v066-tree-ipc.log)
- 最后一次完整退款复跑使用 draft-0.60。三份附件进入真实本地分类，两次本地请求报告 **2,252 Token**。父层已取得读取回执，仍处在调查与计划修订之间，验收窗口结束时未进入第一次暂停。该次记录验证了文件分流与真实调用；原授权回复、实际子任务、回填与最终交付仍须在同一次运行验收。[最后真实退款轨迹](../tmp/v2-v066-refund-v060.json)

## 阶段六十七验证 · 活动节点验收

日期 2026-11-20。统一设计 v0.68，Runtime draft-0.62。

- draft-0.60 已取得调查回执，之后反复重交含无关节点的整份计划，调查工具一直占用当前投影。新增 `complete_plan_nodes` 后，宿主从 `planProgress` 验收活动节点并保留其余计划条件。验收只接受当前修订及真实回执，成功的工具回执按执行时的活动节点向主轮呈现。[前轮阶段停留](../tmp/v2-v066-refund-v060.json) · [调用契约](prompts/v2/call-contracts.md#6-主轮的状态决策)
- draft-0.61 的真实试跑依据读取与子结果回执一次验收两个活动节点，随后暂停、重连并取得人工回复。恢复提案把已完成节点再次纳入，原门禁拒绝；后续两次供应商 JSON 回应只有空白。draft-0.62 的修复轮列明当前活动 ID，空白后改用文本传输但仍以相同 schema 验收控制 JSON。该次本地文件分类 **8** 次，累计报告 **5,689 Token**。[真实节点验收与恢复轨迹](../tmp/v2-v067-refund-progress.json)
- draft-0.62 的 Backend 定向 **118/118**，覆盖同批节点拒绝时的原子性、按请求活动节点查找回执，以及空白回应后用同一任务和空工具投影重提。V2 桌面 IPC 定向 **4/4**，覆盖受控双文档退款、人工等待恢复、独立规划恢复和文档提交回执恢复。[Backend 回归](../tmp/v2-v067-plain-targeted.log) · [桌面 IPC 回归](../tmp/v2-v067-plain-ipc.log)
- draft-0.62 的真实试跑完成子结果验收和暂停重连。供应商在人工恢复首轮返回空白，随后文本传输重提通过，原人工节点凭真实回执验收。主模型只在会话内召回 N-41，并把原句写入审计索引，修订 **118 → 119**。主模型随后重复召回和读取已可见的证据，预算门禁终止了运行，未生成最终报告。[真实空白修复、回填与终止](../tmp/v2-v067-refund-plain.json)

## 阶段六十八验证 · 交付与状态提示词预算

日期 2026-11-20。统一设计 v0.69，Runtime draft-0.63 至 draft-0.64。

- draft-0.63 把追加编辑写入执行节点，计划已结算时使用当前已核对证据交付。真实复跑新增了编辑节点，完成授权恢复和归档召回，预算在回填提案提交前耗尽。在该次运行中，父模型分页读取了三次子结果，子模型的结果正文长于读取窗口，父层仍须保留来源及审核依据。桌面 IPC 定向 **4/4**。[真实试跑](../tmp/v2-v068-refund-finish.json) · [桌面 IPC](../tmp/v2-v068-finish-ipc.log)
- Backend 全量初测 **681/686**，桌面 IPC 全量 **28/28**。两项文件分类测试预期资源发现或加载触发通用整理，实际只需 V4 初筛和复核，现核对这两次调用、失败回退及真实原件。另三项训练纠正用例触发 **10,000 Token** 原预算门禁。draft-0.64 将恢复和委派详情放到对应状态，仍按原预算复验训练链路。[初次 Backend 全量](../tmp/v2-v067-plain-backend-full.log) · [桌面 IPC 全量](../tmp/v2-v067-plain-ipc-full.log)
- draft-0.64 的定向复验 **117/120**，首次训练请求获准，三项训练纠正仍在剩余额度门禁终止。其桌面 IPC 全量 **28/28**。真实场景已读取三份附件，子代理已完成目录查询。模型连接连续三次重置，运行在授权回复前结束。[Backend 定向](../tmp/v2-v068-scoped-targeted.log) · [桌面 IPC](../tmp/v2-v068-scoped-ipc-full.log) · [真实运行](../tmp/v2-v068-refund-scoped.json)

## 阶段六十九验证 · 提示词审计与子任务工具回执

日期 2026-11-20。统一设计 v0.70，调用契约 v0.23，Runtime draft-0.65 至 draft-0.66，Child draft-0.4。

- 主模型请求审计单独保存提示词角色、版本及哈希。模型输入保留结构化请求绑定，省去重复索引和完整提示词哈希列表。
- 父代理读取成功的本地子结果时，宿主从结果包对照子会话、子运行、成功步骤、工具观察及原件。附带的 `local_evidence` 最多提供八条工具回执引用。调用者仍持有完整结果包的原件 ID、结果哈希和读取回执。父层审核身份、作用域和消费约束沿用原协议。
- 真实子模型曾把工具原件 ID 填入完成所需的文档证据，随后重用了上一轮请求 ID。修复输入现只带候选答复正文和当前字段说明。子模型在空工具投影中重提并引用真实成功动作。[初次真实运行](../tmp/v2-v069-refund-receipts.json)
- draft-0.66 的复验取得成功的真实子结果，实际交付并核对父层审核。随后的正文编辑混入 `target.nodeId`，提交时被拒，并终止了组合任务。子代理、控制、训练和文件整理回归 **81/81**，续训维持原配置预算。[真实运行](../tmp/v2-v069-refund-final.json) · [Backend 定向](../tmp/v2-v069-recovery-final-targeted.log)

## 阶段七十验证 · 正文定位与短原件审核

日期 2026-11-20。Runtime draft-0.67 至 draft-0.68。

- 控制 schema 校验正文操作的定位和载荷。混入 `target.nodeId` 或结构操作字段时触发精确修复，原发布绑定及候选仍可用于下一轮。短工具原件在长度、去敏标记和完整哈希通过后随本地子结果展示。
- 当前 Electron 渲染复验覆盖改名、移动、重排、关闭和重开侧栏、切换会话、重启后端和重载渲染器。重排测试以 DOM 完成应用为检查时点。[桌面渲染验收](../tmp/v2-v070-context-renderer.log)
- draft-0.67 的 Backend 定向 **73/73**，V2 桌面 IPC 全量 **28/28**。两项 V1 兼容测试从新版结构化请求绑定取得 ID，曾超时的 Skill 用例串行复验通过，合计 **3/3**。Backend 构建与两端类型检查通过。[Backend 定向](../tmp/v2-v070-targeted.log) · [桌面全量](../tmp/v2-v070-ipc-full.log) · [兼容与 Skill](../tmp/v2-v069-compat-skill.log)
- 真实 draft-0.67 运行中，父代理自行将子模型预算设为 **32,000 Token**，子任务触及上限。父层后续把工具结果原件 ID 写入 `planProgress.evidenceRefs`，完成门禁拒绝。draft-0.68 的恢复提示指出可用动作引用及登记证据的范围。真实验收场景明确采用原有子任务默认预算，固定模型预算条件便于对照。[真实试跑](../tmp/v2-v070-refund.json)
- draft-0.68 的控制定向 **65/65**。用真实工具原件 ID 模拟错误的节点验收，宿主保留原计划修订，按原动作回执完成修复，调查、执行和验证各只执行一次。六份文档与已安装提示词的内容和 SHA-256 一致。[节点验收回归](../tmp/v2-v070-reference-targeted.log)
- draft-0.68 的真实试跑中，子代理完成只读目录查询。主代理在独立读取阶段重复提出现有待回复节点的授权问题，宿主拒绝重复登记，修复额度耗尽。该次运行止于人工回复之前，最终交付与第二会话隔离仍待同一真实运行验收。隔离分类监听已释放。[真实运行与拒绝](../tmp/v2-v070-refund-reference.json)
- 阶段七十 Backend 全量回归采用四个并行测试进程，**686/686** 通过。最后的节点验收修复另以 draft-0.68 的 **65/65** 定向回归验收。[Backend 全量](../tmp/v2-v070-backend-full.log) · [最后控制回归](../tmp/v2-v070-reference-targeted.log)

## 阶段七十一验证 · 局部人工请求与归档回填

日期 2026-11-20。统一设计 v0.71，Runtime draft-0.69。

- 计划中的 `ask_user` 按当前阶段投影可问的任务 ID。宿主校验已有人工请求的原作用域，拒绝重复登记，并提供原请求与可推进的独立节点。回归覆盖同一节点换措辞重问、独立分支照常执行、重启后原请求收到回复。[控制定向 65/65](../tmp/v2-v071-targeted.log) · [训练与计划 46/46](../tmp/v2-v071-training-plan.log) · [V2 桌面 IPC 28/28](../tmp/v2-v071-ipc-full.log)
- 真实组合运行依次保留项目规则，提交只读授权问题，读取来源，执行子代理目录查询及父层验收，暂停后重连并登记原授权回执。会话召回命中归档原文，随后用 `add_entry` 把 N-41 原句补入「审计索引」，文档修订从 108 到 109。之后模型又尝试提交同一编辑，最终因 `RUNTIME_MODEL_BUDGET_EXHAUSTED` 结束。最终答复和第二会话隔离仍待同一次运行验收。[真实退款运行](../tmp/v2-v071-refund.json)
- 长文档对照的原文组在第一轮触及对照脚本的主轮上限。整理组的记录程序解析到无效的通用整理响应时中止。保留该失败用于区分实际模型行为与结果收集问题，两组总用量对比还缺合格交付。[长文档对照记录](../tmp/v2-v071-long-pair.json)

## 阶段七十二验证 · 正文提交回执与长文对照

日期 2026-11-20。统一设计 v0.72，调用契约 v0.24，Runtime draft-0.70 至 draft-0.71。

- 正文提交回执提供实际章节路径和改变的条目 ID。主轮核对目标已经满足时沿用原回执。结构编辑的完整受影响条目仍在持久回执中。以 2,048 条目移动测试核对原预算、结构定位和持久回执。`propose_diff` 走错工具通道时，下一轮使用空工具投影与当前请求绑定验证 JSON 控制信封。Backend 定向 **50/50**，两端类型检查和 Backend 构建通过。[编辑和控制回归](../tmp/v2-v073-bounded-targeted.log)
- draft-0.70 长文配对两组均完成三轮，三轮各覆盖 **8/8** 项必需事实，最终 JSON 的两条完整原句及文件位置与原件一致。三份原件哈希相同，整理组的 241 段归档凭据全部可核对，重启后用归档材料原句生成候选。首次主轮实际输入 **23,090 → 15,626 Token**，随请求携带的原工具行 **249 → 5**。[原文、整理和召回对照](../tmp/v2-v072-long-pair.json)
- 同一配对的三轮总用量 **212,889 → 622,113 Token**，成本门槛未通过。主模型在整理组出现三批 `read_runtime_artifact` 分页，每批各三次，后续输入随分页结果增大。16 次整理调用计入 **128,297 Token**，其中 5 次本地文件分类消耗 **12,667 Token**，11 次通用整理消耗 **115,630 Token**。后续配对需单独核对分页范围、重复读取和整理触发，再比较两组总用量。[配对报告](../tmp/v2-v072-long-pair.json)
- draft-0.70 退款复验经过授权暂停重连、子结果消费和归档召回。正文提案走错通道，之后多轮修复用完剩余 Token，未取得最终答复。draft-0.71 退款复验拒绝重复授权提问，真实子模型提交了完成信封，父层读取并调用结果消费。父层继续修复计划节点后耗尽模型尝试次数，未完成同一运行的最终交付与第二会话验收。[draft-0.70 退款运行](../tmp/v2-v072-refund.json) · [draft-0.71 退款运行](../tmp/v2-v073-refund.json)
- draft-0.71 的 V2 桌面 IPC 全量 **28/28**。六份正文与 Backend 实际加载的提示词版本及 SHA-256 一致。隔离分类监听已释放。[V2 桌面 IPC](../tmp/v2-v073-ipc-full.log)
- draft-0.71 的 Backend 全量回归从仓库根目录运行，使用 `examples/test-project` 作为项目夹具。82 个测试文件分四组运行，合计 **686/686** 通过。[第一组](../tmp/v2-v073-backend-root-0.log) · [第二组](../tmp/v2-v073-backend-root-1.log) · [第三组](../tmp/v2-v073-backend-root-2.log) · [第四组](../tmp/v2-v073-backend-root-3.log)

## 阶段七十三验证 · 已核验文件摘录与答复通道

日期 2026-11-20。统一设计 v0.73 至 v0.76，调用契约 v0.25，Runtime draft-0.72 至 draft-0.76。

- draft-0.71 取证复跑保存了逐轮主模型请求。首轮已发布两条关键原句，模型仍按原件字符偏移逐页读取三份文件。通用整理先后重复收到带相同原件 ID 和偏移的分页包装，整理组总用量 **594,176 Token**。[窗口组报告](../tmp/v2-v074-long-probe.json) · [逐轮请求](../tmp/v2-v074-long-probe.json.requests.json)
- draft-0.72 为局部文件结果提供活跃摘录行号，并在低压力下避免同会话已评估原件的精确分页单独触发通用整理。此版的真实首轮先生成正文，格式修复仍允许工具，模型随后反复分页直到 `MODEL_TOOL_ROUND_LIMIT`。draft-0.73 将正文保留为草稿，在无工具的修复轮使用当前绑定和原证据提交 `finish`。已登记义务按原门禁校验。[首轮格式与分页轨迹](../tmp/v2-v075-long-pair.json.requests.json)
- draft-0.73 馆藏长文对照中，两组各三轮 **8/8** 项必需事实，最终 JSON 中两条引文和行号与原件逐字一致，三个原件哈希匹配。两组均未分页。整理组首轮原工具行 **249 → 6**，主轮输入 **23,032 → 15,608 Token**。三轮总用量 **100,731 → 100,596 Token**，包含三次本地文件整理共 **11,006 Token**。237 段归档凭据全部可核对，重开后从原件归档召回并登记候选。该样本的总用量只相差 **135 Token**，需独立样本及复测确认收益。[同版本配对](../tmp/v2-v076-long-pair.json)
- draft-0.73 退款组合复验完成了真实子任务，重连后收到原授权回复。模型在追加会话编辑的计划中将 `runtime:propose_diff` 写成工具能力，宿主拒绝 `RUNTIME_PLAN_CAPABILITY_UNKNOWN`，运行没有完成交付。draft-0.74 提供未知 ID 的有界修复，并要求控制节点用完成条件表达交付。[真实退款轨迹](../tmp/v2-v076-refund.json)
- 新增回归覆盖精确分页、错误范围和陈旧来源、真实分页对原工具回执的保留、草稿答复暂存、未知能力拒绝及正确计划重提。draft-0.74 构建、类型检查、控制回归 **46/46**、V2 桌面 IPC **28/28**。未知能力修复随后单独验收 **2/2**。早期组合回归五项等待超时，以原测试时限重新验证 **5/5**。[定向回归](../tmp/v2-v077-specific.log) · [控制回归](../tmp/v2-v077-control.log) · [桌面 IPC](../tmp/v2-v077-ipc-full.log) · [计划修复](../tmp/v2-v077-plan-recovery.log) · [超时复核](../tmp/v2-v077-timeout-recheck.log)
- 独立清运材料对照在原文组触及观测时限并取消在途请求。它未形成可比较的成本结果。[独立案例日志](../tmp/v2-v076-shipment-pair.log)
- draft-0.74 首次真实退款试跑因代理连续重置连接结束。复跑读到三份来源、消费子任务结果并召回会话归档，随后将独立候选证据合到一个候选的提案。宿主回滚整批。draft-0.75 按同候选绑定提供精确的有界控制修复，并保持子轮原有 JSON 格式提交通道。[连接结果](../tmp/v2-v077-refund.json) · [证据拒绝与草稿审计](../tmp/v2-v077-refund-retry.json)
- draft-0.74 Backend 全量 **688/689**。子代理草稿的 JSON 传输兼容问题在 draft-0.75 修复，同一测试复验通过。draft-0.75 定向 **4/4**，包括不同候选的混用证据导致两项编辑整体回滚，随后按原绑定保存双方条目。V2 桌面 IPC **28/28**。[原失败](../tmp/v2-v077-backend-root-3.log) · [编辑和子代理复验](../tmp/v2-v078-final-specific.log) · [桌面 IPC](../tmp/v2-v078-ipc-full.log)
- draft-0.75 真实退款试跑消费子结果并重连接收原授权回复。模型将两个已验收节点混入人工节点的复验请求，宿主拒绝，之后空白响应耗尽格式修复预算。draft-0.76 将当前计划修订和活动节点写入完成 schema，人工阶段的错误节点在空工具表中修复。[真实授权恢复](../tmp/v2-v078-refund.json)
- 独立清运对照复跑的两组都保留 **7/7** 项事实，整理组可召回归档。原文组超过历史压力阈值，发生 13 次通用整理，且两组的实际读取集合不同。该次运行仅提供事实保真和干预证据，无法用于成本比较。[对照报告](../tmp/v2-v078-shipment-pair.json) · [对照校验](../tmp/v2-v078-shipment-pair.log)
- draft-0.76 的控制回归 **47/47**，V2 桌面 IPC **28/28**。实际请求的 schema 固定计划修订，并按当前活动节点枚举可验收的 ID。宿主仍拒绝旧修订和不在活动范围内的节点。六份提示词的后端加载版本和哈希均已复核。[控制回归](../tmp/v2-v079-control.log) · [桌面 IPC](../tmp/v2-v079-ipc-full.log)
- draft-0.76 的真实退款组合在独立规划轮内将 `waitSpec` 混入 `propose_plan`，宿主拒绝互斥字段，最终用尽原格式修复预算。该运行还缺授权恢复、最终交付和第二会话隔离。本次分类服务监听已释放。[真实组合与终态](../tmp/v2-v079-refund.json)

## 阶段七十四验证 · 决策载荷与整理触发

日期 2026-11-20。统一设计 v0.77 至 v0.80，调用契约 v0.26，Runtime draft-0.77 至 draft-0.80。

- draft-0.77 的发布 schema 直接约束决策对应的载荷。独立规划轮只接受空等待字段，执行阶段同时允许规划和等待时仍要求两者载荷互斥。受控复现混合响应，宿主保留原运行和接受的计划，用新绑定给出 `waitSpec: null` 的精确修复。控制与文档回归 **52/52**，V2 桌面 IPC **28/28**。[回归](../tmp/v2-v080-final-control.log) · [桌面 IPC](../tmp/v2-v080-ipc-full.log)
- draft-0.77 真实退款组合已消费子结果、重连取得原授权回复、验收人工节点并召回 N-41。模型补读原件后触及共享模型尝试次数上限，当时仍余 91,337 Token。原句回填、最终交付与第二会话检查未通过同一运行验收。[真实退款](../tmp/v2-v080-refund.json)
- draft-0.77 的独立清运对照以同一更大输入预算重跑。原文组首轮保留 249 行且整理调用为零，初次三份原件哈希相符。两组三轮各保留 **7/7** 项事实并交付两条逐字引文。首轮主模型输入从 **24,483** 降至 **12,760 Token**，总用量从 **164,939** 升至 **476,208 Token**。整理组总量包括主模型 **391,514** 和整理模型 **84,694 Token**。该次夹具只从局部覆盖收集归档凭据，增加对整体承接文件的持久归档凭据检查后复跑。[清运对照](../tmp/v2-v080-shipment-pair.json) · [归档断言](../tmp/v2-v080-shipment-pair.log)
- draft-0.78 在低压力调度中识别成功控制回执。调用 ID、能力名称和成功结果必须匹配。相同原件的精确分页同时支持部分与整体承接，正文见证失效则恢复常规调度。回执、页和实际工具结果继续留在历史中，也保留原来的高压力整理路径。[实现](../apps/backend/src/core/runtime-loop.ts)
- draft-0.78 的整理、文件投影和控制回归 **86/86**。同一案例中的目录查询回执仍对主轮可见，没有额外开启整理，也没有生成虚假的训练样本。[Backend 回归](../tmp/v2-v081-focused.log)
- draft-0.78 独立清运对照的原文基线三轮 **7/7**，实际整理调用为零。整理组核对了 **822/822** 条持久归档凭据，也成功从重开的会话召回原件，但在首轮补读时触及工具轮上限。该次未形成合格的成本对照。[清运对照](../tmp/v2-v081-shipment-pair.json)
- draft-0.78 真实退款试跑在未投影的 `propose_diff` 调用参数解析处结束。draft-0.79 保留原始畸形参数和批次大小，只对当前允许的单个控制决策启动无工具修复。真正的工具或混合批次仍按模型协议拒绝。[模型输出错误](../tmp/v2-v081-refund.json)
- draft-0.79 控制和模型适配回归 **83/83**。通过实际 HTTP 响应核对畸形参数的调用与批次信息，再通过 RuntimeLoop 核对单个控制决策重新提交。混合批次和畸形真实工具均未分发。[控制和适配回归](../tmp/v2-v082-focused.log)
- draft-0.79 退款组合通过原运行重连、原授权节点验收和 N-41 召回。模型用原生通道发送 `propose_diff`，收到修复反馈后又在文档提交及交付节点验收之前请求 `finish`，被 `unfinished_tasks` 门禁拒绝。该轨迹仍需验证原句回填、最终交付及第二会话隔离。[真实退款轨迹](../tmp/v2-v082-refund.json)
- 清运窗口组首轮已经发布 E46 和 B79 的原句。随后七次 `read_file` 集中在同三份文件，其中四次再次读取已经检查的两个路径。包括预热读取在内，记录了十次文件原件，每条路径均只有一个已核验的原件哈希。同两个 artifact 各请求四页，部分偏移区间重叠。[原始请求与补读](../tmp/v2-v081-shipment-pair.json.requests.json) · [原件哈希](../tmp/v2-v081-shipment-pair.json)
- draft-0.79 后端全量回归 **690/693**。三个自动训练用例因纠正轮输入估算为 **10,208–10,209 Token** 超出 10,000 上限。draft-0.80 将重复描述的决策载荷交由本轮 schema 表达，精简约 1,650 字符，保留字段互斥规则、门禁和原输入上限。三个纠正用例重跑 **3/3**，已记录请求的输入估算最高 **9,786 Token**。六份部署提示词与编辑稿的版本和 SHA-256 均一致。[原回归](../tmp/v2-v082-backend-root-0.log) · [预算复验](../tmp/v2-v083-training-budget.log)
- draft-0.80 V2 桌面宿主 IPC 组合回归 **28/28**，包括退款、授权恢复、计划文档编辑、两级文档和跨会话隔离。桌面运行管理回归 **8/8**。后端构建与类型检查通过。[IPC 组合](../tmp/v2-v083-ipc-host.log) · [桌面运行管理](../tmp/v2-v083-ipc-full.log) · [构建](../tmp/v2-v083-final-build.log) · [类型检查](../tmp/v2-v083-final-types.log)
- draft-0.80 后端全量首跑 **691/693**，三个自动训练用例均通过。另两个取证用例在工具执行中等待超时。同版本隔离复验 **2/2**，随后完整规划与阶段投影测试 **36/36**，包含两个超时用例。全量首跑的超时单独保留。[分片 0](../tmp/v2-v083-backend-root-0.log) · [分片 1](../tmp/v2-v083-backend-root-1.log) · [分片 2](../tmp/v2-v083-backend-root-2.log) · [分片 3](../tmp/v2-v083-backend-root-3.log) · [隔离复验](../tmp/v2-v083-evidence-retry.log) · [完整模块复验](../tmp/v2-v083-planning-retry.log)

## 阶段七十五验证 · 节点验收与最终交付

日期 2026-11-20。统一设计 v0.82，调用契约 v0.27，Runtime draft-0.81 至 draft-0.82。

- draft-0.81 从计划未结的能力投影和输出 schema 中收起 `finish`。活动节点收到提前完成提案或纯文本草稿时按现有额度重提，原始正文留在审计中。受控用例核对原 run、task、state revision、继续可用的工具及最后一次真实写入，取得节点回执后才发布最终答复。定向 **59/59**，桌面宿主 IPC **28/28**。[定向](../tmp/v2-v084-finish-projection.log) · [桌面 IPC](../tmp/v2-v084-ipc-host.log)
- draft-0.81 真实退款请求在活动节点上均未提供 `finish`。模型已经完成真实子结果审核，随后在附件取证节点的 `complete_plan_nodes` 中重复携带已登记的非阻塞不确定性，两次输出因载荷混合被拒绝。该次运行未到授权重连。[真实请求](../tmp/v2-v084-refund.json)
- draft-0.82 为节点验收加入 `evidenceRequests: []`、`uncertainties: []` 的 schema 约束和有界字段修复。宿主维持原账本，重复节点 ID 也产生可定位的拒绝。定向 **59/59**，桌面宿主 IPC **28/28**。三个自动训练纠正用例在原 10,000 Token 上限内通过。构建、类型检查及六份部署提示词版本与哈希核对通过。[控制回归](../tmp/v2-v085-control-final.log) · [桌面 IPC](../tmp/v2-v085-ipc-host.log) · [训练预算](../tmp/v2-v085-training-budget.log)
- draft-0.82 真实退款在授权等待期间读取三份文件并消费真实子结果。重启后收到原授权回复，同一 task/run 继续。召回事件的 N-41 来自 `information`，原句以活动节点绑定的 `add_entry` 提交到「会话审计索引」，宿主在修订 **108** 产生已应用回执。后续请求提供了该回执，模型再次提交同一编辑，已消费候选触发 `CANDIDATE_NOT_IN_PROJECTION`。本次验证了会话内召回和文档提交。指定章节「审计索引」、归档来源、编辑节点验收、最终答复与第二会话隔离仍需在同一次真实运行复验。[真实退款轨迹](../tmp/v2-v085-refund.json)

## 阶段七十六验证 · 已提交条目、分支作用域与精确重读

日期 2026-11-20。统一设计 v0.86，调用契约 v0.29，Runtime draft-0.83 至 draft-0.86。

- draft-0.83 在相同节点、作用域、候选、目标、正文和证据均匹配时，指出仍可见的原提交和 `context:` 回执。模型另提节点验收。桌面 IPC 重连用例分别接收错误原生通道与正确控制通道的重复新增，再验证不同目标沿用普通拒绝。实际文档仅提交一次。全组 IPC **28/28**，后端控制定向 **59/59**。[桌面 IPC](../tmp/v2-v086-ipc.log) · [控制回归](../tmp/v2-v086-control.log)
- 退款夹具明确章节名、维护材料的适用范围和编辑回执的节点归属。draft-0.83 首跑时夹具把等待子任务的第一次暂停当成授权检查点。随后改为先等同一子任务的真实审核，再检查暂停和重开。复跑发现模型把已登记问题扩大为根任务和独立取证节点的混合提问，宿主拒绝整条提案。[子任务等待](../tmp/v2-v086-refund.json) · [混合提问](../tmp/v2-v087-refund.json)
- draft-0.84 的模型 schema 和宿主同时约束提问与等待的根/节点作用域。受控恢复重现混合提问。原人工请求未变化，独立工具执行并获得真实回执，随后用原 humanRequestId 恢复。draft-0.85 的专用文件档案测试验证实际整文件重读保留新回执，以已承接的旧原件作为引用。后续用户请求未重新整理此前重复的观察。整文件变化、跨运行读取、指定范围和活跃见证失效分别保留原始行。定向 **5/5**。[集成与负向复验](../tmp/v2-v089-targeted.log)
- draft-0.84 清运对照有效。原文组整理次数为零，三份初始原件哈希一致。两组均三轮完成、保留 **7/7** 项事实及两条最终逐字引文。核验 **247** 条持久归档凭据，重开后成功召回。主模型首轮输入 **23,753 → 12,087 Token**，端到端总用量 **185,785 → 287,189 Token**。整理组主模型用了 **266,699 Token**，整理用量 **20,490 Token**。该组没有重复整文件读取，两个原件的六个字符分页共返回 **12,000** 个字符位置，其中 **1,600** 为同一原件内的重叠位置。后续输出修复也计入用量。精确整文件重读的效果由独立集成用例验收。[真实清运对照](../tmp/v2-v088-shipment-pair.json) · [分页与模型请求](../tmp/v2-v088-shipment-pair.json.requests.json)
- draft-0.84 退款组合已读取三份附件并有已验收的委派节点，随后模型提出未投影的 `apply_system_variable_changes`。宿主拒绝，原授权仍待处理。模型请求的原生工具表没有此工具，项目模板残留变量写入说明。draft-0.86 将项目模板的说明及 Harness 按当前实际工具投影过滤，保留注册能力的发现入口。[真实请求与拒绝](../tmp/v2-v088-refund.json)
- draft-0.86 后端定向 **107/107**，包括计划轮没有工具写入说明、只读阶段排除变量写入说明，以及直接获得变量编辑能力时仍启用编写指南。V2 桌面宿主 IPC **28/28**。后端构建、类型检查以及六份部署提示词哈希一致性通过。[后端定向](../tmp/v2-v090-backend-focused.log) · [桌面 IPC](../tmp/v2-v090-ipc.log)
- 首次后端全量 **694/696**。两个控制集成用例要求保留旧完成格式的未结动作诊断，以及提前完成时的未结节点提示。宿主恢复原诊断语义，控制、规划与阶段投影模块同版本复跑 **57/57**。[原分片](../tmp/v2-v090-backend-root-0.log) · [兼容复验](../tmp/v2-v091-control-compatibility.log)
- draft-0.86 真实组合在原 task/run 中验收子结果、重接原授权并召回 N-41。实际将原句提交到指定的「审计索引」，修订 **116** 的原回执用于验收 `task-audit-index`。召回仍来自 `information`。下一条报告请求需预留 28,181 Token，当时只剩 26,518 Token 和六次调用，任务因预算结束，最终报告和第二会话断言未执行。轨迹中重复新增使用了 `candidate_diffs` 名称及不同分类理由，宿主现在按实际来源、位置和正文匹配原回执，分类的作用域、置信度与项目锚点仍一致。桌面重连复验覆盖这两种写法。[真实退款轨迹](../tmp/v2-v090-refund.json) · [回执变体复验](../tmp/v2-v092-duplicate-ipc.log)
- 相同 900,000 Token 与 50 次尝试上限下的后续真实复跑取得父层子结果审核回执，但未到授权重连检查点。主模型下一请求需 32,144 Token，余 12,168 Token 和五次尝试，宿主按预算拒绝。退款夹具为后续运行额外记录授权前机械可核验的归档命中与活跃条目，便于分别检查整理处置、检索来源与交付链。该次复跑支持成本约束和子结果审核证据，完整场景仍待验收。[真实复跑](../tmp/v2-v092-refund.json)

## 阶段七十七验证 · 原件按行补读与归档范围

日期 2026-11-20。统一设计 v0.89，调用契约 v0.30，Runtime draft-0.88 至 draft-0.89。

- 已核验文件可读原件的确切行号。受控主轮返回原件第 3 行，并验证后续请求阻止互斥参数、越界范围和外会话无权读取。字符页重叠部分引用仍在同一请求中的早先完整页；页离开投影或校验失败时保留当前原文。真实工具回执、持久候选和归档原件仍可核对。[文件投影与控制回归](../tmp/v2-v095-context-control-final.log)
- 召回工具支持限定 `source_kind=source_archive`，桌面命令使用 `sourceKind`。受控用例核对两种来源范围、仅项目范围空命中、无效来源类型和实际归档回执。draft-0.89 后端上下文及控制 **67/67**，训练预算及提示词 **8/8**，V2 桌面宿主 IPC **28/28**。构建、类型检查和六份提示词部署哈希通过。[桌面 IPC](../tmp/v2-v095-ipc.log) · [训练与提示词](../tmp/v2-v095-training-prompts.log) · [部署版本](../tmp/v2-v095-prompt-manifest.log)
- draft-0.88 清运原文组完成三轮，每轮 **7/7**，同三份原件与整理组初始哈希一致。整理组文档保留 **7/7** 项事实，留下 **463** 条持久归档凭据，重开后从 `source_archive` 召回。首轮主模型输入 **23,354 → 11,604 Token**。整理组先请求两段各 80 行的补读，随后执行字符分页和重读，耗尽原有 8 个工具轮，未产生首轮交付。本次总用量不用于同等交付的成本比较。[清运对照](../tmp/v2-v094-shipment-pair.json) · [调用轨迹](../tmp/v2-v094-shipment-pair.json.requests.json)
- draft-0.88 退款场景中，真实子任务通过父层审核，重启后同一运行通过原只读授权。授权前档案中没有 N-41 的逐字归档记录。归档专查真实返回空列表，随后另查会话信息命中。报告节点引用其他节点的人类与文档回执，宿主报 `RUNTIME_PLAN_ACTION_UNBOUND`，最终报告与第二会话检查未通过。draft-0.89 提示词把报告文本交给 `finish`，把计划节点完成依据限定在各自节点，前置结果通过 `dependsOn` 承接。[退款轨迹](../tmp/v2-v094-refund.json)
- draft-0.89 真实复跑通过子结果审核与原只读授权恢复。三份附件读取均返回成功，该轮也包含子结果读取。授权前没有 N-41 的逐字归档。该次记录的通用整理请求未收到 N-41 文件片段，恢复期间的预算账本抽查只见通用整理模型调用。归档专查仍返回空。原件补读后的 diff 证据未绑定到所选候选，宿主以 `EVIDENCE_NOT_BOUND` 拒绝，报告和第二会话仍待完整验收。该场景需逐步核对文件批次和模型配置命中、原件处置及持久化回执。[真实复跑](../tmp/v2-v095-refund.json) · [拒绝原因](../tmp/v2-v095-refund.log)

## 阶段七十八验证 · 混合工具轮与长任务分类

日期 2026-11-20。统一设计 v0.90，调用契约 v0.31，Runtime draft-0.90。

- 上阶段的真实混合工具轮将三份成功的 `read_file` 和一份子结果放在同一轮，实际预算账本没有专用模型请求。新增复现验证此前的通用记录待审时，专用文件分类仍能提交两个独立正文见证和原件归档。主轮保留子结果与完整工具调用身份。其余材料继续通用整理，只有整组全部得到承接后才推进覆盖。撤回证据或缺少同轮工具结果时，局部投影不会获得同一凭据。上下文及召回相关定向 **68/68**。[混合轮回归](../tmp/v2-v098-mixed-final.log)
- 新增过程记录保留 organizer 提交与拒绝，并可在授权暂停时核对专用批次和逐项输出。对照真实试跑中三份附件单独成轮，实际小模型返回三次，授权前仍没有 N-41 的逐字归档。后续 `add_entry` 混用正文路径和结构节点 ID，用尽格式修复额度。另一次真实试跑把已授权的读档与尚缺的报告授权混在提问中，停在人工等待。draft-0.90 明确当前节点的授权范围、工具发现及正文目标字段。[专用请求与格式拒绝](../tmp/v2-v096-refund-diagnostic.json) · [范围混淆](../tmp/v2-v097-refund.json)
- 将该真实退款任务的长指令供本地分类器重放，两份退款主张均保留。三种排版背景下，N-41 分别为保留、待核对、待核对。增加六组长指令配对，同一原件按当前任务在保留和归档之间切换，来源不明的样本保持待核对。真实 RuntimeLoop 导出新增 **36** 条受审配对资源，合并准入后为训练 **170**、验证 **18**、留出 **36** 条。退款原件留作外部独立验证。[本地重放](../tmp/v2-v097-classifier-check.log) · [配对语料](../apps/backend/test/fixtures/context-span-contrast-cases.json) · [准入](../tmp/v2-v099-admission.log)
- 本地训练完成四轮，独立验证选中第三轮，峰值预留 **1,512 MiB**。固定留出配对按整批判定，新增长任务 **1/12 → 12/12**，原短配对仍为 **9/12**，历史组 **12/12 → 11/12**，一条必要原句保留在待核对状态。两代模型在这批留出中均没有归档必要或待核对原句。退款长指令的三种背景从 **0/3 → 3/3**，均得到 K/K/A。候选保留独立权重供隔离验收。[训练](../tmp/v2-v099-train.log) · [留出逐批对照](../tmp/v2-v099-classifier-eval.jsonl)
- draft-0.90 后端上下文、控制、训练和提示词定向 **96/96**，V2 桌面宿主 IPC **28/28**，准入测试 **3/3**。构建、类型检查和六份部署提示词哈希一致。[后端定向](../tmp/v2-v099-backend.log) · [桌面 IPC](../tmp/v2-v099-ipc.log) · [准入回归](../tmp/v2-v099-admission-tests.log) · [部署清单](../tmp/v2-v099-prompt-manifest.log)
- 候选模型的首个 draft-0.90 退款实跑，在授权前取得 N-41 的逐字归档及其原件 ID、哈希和字符范围。真实子代理也通过父层审核。夹具读取被截短的调试内容时中断，未发送授权回复。诊断现在读取关闭后持久化的会话样本，召回验收同时核对授权前归档 ID 和原件 ID。[归档检查点](../tmp/v2-v100-refund.json) · [夹具中断](../tmp/v2-v100-refund.log)
- draft-0.90 与候选分类器的清运配对有效。三份初始原件的哈希一致，原文组没有整理调用。两组三轮均 **7/7**，最终 JSON 各交付两条逐字引文。整理组核验 **326** 条持久归档凭据，重开后从 `source_archive` 召回。首轮输入 **23,341 → 16,958 Token**，端到端用量 **335,886 → 385,725 Token**。两组各调用主模型 11 次，整理组主模型用量 **345,023**，整理用量 **40,702 Token**。主模型提出 13 次原件按行补读请求，含超范围请求。任务质量和归档通过，端到端降本条件仍待满足。[清运对照](../tmp/v2-v100-shipment-pair.json) · [原件补读与模型请求](../tmp/v2-v100-shipment-pair.json.requests.json)

## 阶段七十九验证 · 初次规划的空动作账本

日期 2026-11-20。统一设计 v0.91，调用契约 v0.32，Runtime draft-0.91。

- draft-0.90 退款复跑在初次规划把工具名填入 `requiredActions`，宿主拒绝四次并记录 `RUNTIME_PLAN_ACTION_UNBOUND`。draft-0.91 将首次规划且无成功动作时的发布 schema 限定为空动作数组。规划修订仍使用实际计划与旧义务，宿主继续核验新的动作绑定。控制、阶段投影和训练预算定向 **74/74**。构建、类型检查和部署哈希通过。[规划拒绝](../tmp/v2-v101-refund.json) · [控制回归](../tmp/v2-v102-control.log) · [部署清单](../tmp/v2-v102-prompt-manifest.log)
- draft-0.91 真实复跑的初始候选计划均使用空 `requiredActions`。持久会话样本核对到账本和邮件分别为 K，第三份文件的初筛与复核均为 A，并在授权回复前提交。真实子结果通过审核，同一 run 恢复原人工请求。随后使用 `source_archive` 召回逐字 N-41，归档 ID 与原件 ID 同授权前记录一致。[真实轨迹](../tmp/v2-v102-refund.json) · [检查点核对](../tmp/v2-v102-refund-checkpoints.log)
- 该次运行已接受新增的审计索引节点，随后再次进入规划与修复。原始上限下共计 **48** 次计费尝试及 **890,936 Token**，下一步需要预留 **25,738 Token**，只剩 **9,064 Token**。宿主以真实预算终止，审计索引、最终报告与第二会话仍待同一运行验证。后续需从已命中的归档候选直接完成绑定编辑，并减少重新规划与通用整理中带回的重复上下文。[原失败及预算](../tmp/v2-v102-refund.log)

## 阶段八十验证 · 相同计划与已核验的原件

日期 2026-11-20。Runtime draft-0.92 与 draft-0.93。

- 相同计划节点仅改写目标时保持修订；当前 schema 固定计划修订及可绑定编辑的活动节点。已持久核验的原件分页在高压时保留，独立到达的观察仍可整理。受控用例用实际回执复现阶段切换后的相同文件读取和提前验收。重复读取批次被拒，修复沿用原回执。更换路径的未投影调用继续拒绝。draft-0.92 后端定向 **151/151**，draft-0.93 **153/153**，V2 桌面宿主 IPC **28/28**。构建、类型检查和六份提示词哈希通过。[draft-0.92 后端](../tmp/v2-v103-backend-final.log) · [draft-0.93 后端](../tmp/v2-v104-backend.log) · [桌面宿主 IPC](../tmp/v2-v104-ipc.log) · [部署清单](../tmp/v2-v104-prompt-manifest.log)
- draft-0.92 退款实跑在同一调查轮读取三份附件。随后执行阶段请求再次读取三份附件，宿主在实际分发前拒绝越界批次。draft-0.93 实跑由本地分类器在授权前提交初筛 K/K/A 与复核 A。真实子结果获父层审核，重开后以原人工请求继续同一运行，`source_archive` 命中的归档 ID 和原件 ID 均与授权前一致。N-41 原句提交到会话文档「审计索引」，获得 applied 回执。该 diff 省略 `planTaskId`，所以回执不能证明独立编辑节点结算。报告节点误引用前置节点的人工回执，宿主以 `RUNTIME_PLAN_ACTION_UNBOUND` 拒绝。该次账本计费 **706,687 Token**、**40** 次尝试，最终报告与第二会话检查未达成。[draft-0.92 退款](../tmp/v2-v103-refund.json) · [draft-0.93 退款](../tmp/v2-v104-refund.json)
- draft-0.92 清运对照原文组完成三轮且每轮 7/7。整理组文档保留 7/7，首轮误结算一个新计划节点，宿主以 `RUNTIME_PLAN_COMPLETION_UNVERIFIED` 拒绝。draft-0.93 的原文组同样三轮均 7/7。整理组文档保留 7/7，核验 **326** 条持久归档，重开后从 `source_archive` 召回。首轮输入 **23,305 → 16,935 Token**，主模型发出 **11** 项原件读取和 **3** 项召回，耗尽工具轮数。该轮发送的文档已经含 E46 和 B79 的直接引文及行号，仍未交付首轮答案。两次都未形成同等交付成本对照。[draft-0.92 清运](../tmp/v2-v103-shipment-pair.json) · [draft-0.93 清运](../tmp/v2-v104-shipment-pair.json) · [实际请求](../tmp/v2-v104-shipment-pair.json.requests.json)

## 阶段八十一验证 · 编辑回执归属与最终交付

日期 2026-11-20。统一设计 v0.94，调用契约 v0.35，Runtime draft-0.94。

- 完成节点引用其他节点真实人工或编辑回执时，宿主提示该回执的原节点，原修订和义务保持不变。受控回归分别覆盖重连后引用原人工回执和不同节点重复使用编辑回执。后端定向 **167/167**、全量 **703/703**，V2 桌面宿主 IPC **28/28**，V2 Runtime **8/8**。构建、类型检查和六份提示词哈希通过。[后端全量](../tmp/v2-v105-backend-full.log) · [宿主 IPC](../tmp/v2-v105-host-ipc.log) · [Runtime](../tmp/v2-v105-ipc.log) · [提示词清单](../tmp/v2-v105-prompt-manifest.log)
- 真实退款在批准前提交文件初筛 K/K/A 和复核 A，父层审核子结果。桌面宿主重开后原人工请求恢复同一运行，N-41 召回命中的归档 ID 与原件 ID 均与批准前一致。主模型新增独立编辑节点，提交绑定该节点的会话文档 diff，并用 `context:<receiptId>` 验收编辑。报告节点未能结算，先提交空的证明，再重复引用其他节点的编辑与人工回执。宿主以 `RUNTIME_PLAN_ACTION_UNBOUND` 拒绝，计费 **769,074 Token**、**42** 次尝试。最终交付与第二会话隔离仍待同一运行验收。[退款原始轨迹](../tmp/v2-v105-refund.json)
- 同版清运整理组三轮均完成且每轮 **7/7**，核验 **326** 条持久归档，重开后从 `source_archive` 召回。两条结构化引文的文件和行号正确，`quote` 多出材料标签和定位前缀，未通过与实际原文件逐字对照。原文组首轮在执行阶段请求未投影的原生 `propose_diff`，宿主拒绝。两组仍使用同一初始文件；本次无法形成有效的端到端成本对照。[清运原始轨迹](../tmp/v2-v105-shipment-pair.json) · [逐字校验结果](../tmp/v2-v105-shipment-quote-check.log)

## 阶段八十二验证 · 节点回执与同版清运对照

日期 2026-11-20。统一设计 v0.95，调用契约 v0.36，Runtime draft-0.95。

- 一轮验收同时检查当前计划修订、活动节点以及动作回执归属。Schema 排除当前视图内确定属于别的节点的回执；宿主独立复核并报告该节点所有已识别的错绑引用。工具轮预算耗尽后清空工具投影，维持同一完成门禁。定向覆盖在同一上限内凭原回执交付、超额动作零分发、跨节点工具回执被拒和后续用本节点回执完成。后端全量 **707/707**，桌面宿主与 Runtime **36/36**。构建、类型检查与六份提示词哈希通过。[后端全量](../tmp/v2-v106-backend-full.log) · [补充回归](../tmp/v2-v106-control-focused.log) · [桌面](../tmp/v2-v106-ipc.log) · [提示词](../tmp/v2-v106-prompt-manifest.log)
- 同版清运对照两组各完成三轮，均 **7/7**，并按实际原件逐字校验两条最终 JSON 引文。初始原件哈希完全一致。整理组核验 **247** 条持久归档，关闭并重开同一会话后从 `source_archive` 召回。首轮输入 **23,369 → 17,023 Token**，总用量 **348,099 → 391,916 Token**。两组各 12 次主模型请求，整理组主模型 **359,217 Token**、整理 **32,699 Token**。整理组首问加载 11 个原件页，随后工具额度达到 8/8，实际发出的两次请求无工具且完成交付。后两问继续携带约 24,878 字符页正文，最后一问又读取两份原件。质量与召回通过，总成本仍高 **12.6%**。[同版对照](../tmp/v2-v106-shipment-pair.json) · [实际请求](../tmp/v2-v106-shipment-pair.json.requests.json)
- 真实退款保留原授权请求并完成三份附件同轮读取。委派节点只声明 `runtime:delegate_task`，却请求实际授予资源搜索，宿主以 `CHILD_CAPABILITY_NOT_GRANTED` 拒绝，未产生活跃子任务。随后模型试图用父层搜索回执结算原委派节点，运行停在授权等待。无法取得子结果审核回执，夹具超时。该次记录揭示原委派义务需要继续由宿主绑定到实际子结果，父级搜索仍只能证明父级动作。[退款真实轨迹](../tmp/v2-v106-refund.json) · [等待结果](../tmp/v2-v106-refund.log)

## 阶段八十三验证 · 委派结算与跨轮原件页

日期 2026-11-20。统一设计 v0.96，调用契约 v0.37，Runtime draft-0.96。

- 声明委派的计划节点在获得真实子分配及有效父层审核前保持待处理。父级同名工具回执无法结算该节点，规划修订保留现有委派义务。受控断言分别覆盖父层工具回执的拒绝、移除义务的拒绝和子结果接受后结算。此前运行的已核验行页可沿用确切的全行承接证明，当前读取和失效凭据下保留完整原页。受控复验核对原回执、原件全文与未处置行。后端全量 **708/708**，V2 桌面 **36/36**，构建、类型检查和六份提示词哈希通过。[后端全量](../tmp/v2-v107-backend-full.log) · [桌面](../tmp/v2-v107-ipc.log) · [提示词清单](../tmp/v2-v107-prompt-manifest.log)
- 真实退款本次计划明确声明 `runtime:delegate_task` 与 `runtime:search_resources`，只给子代理资源搜索能力，持久账本记录子执行成功。父层已读取子结果，随后将未投影为工具的 `propose_diff` 与已投影的 `consume_child_result` 混入同批，宿主拒绝整批。持久快照核对无子结果消费凭据，后续授权、回填和交付没有进入本次验收。[退款真实轨迹](../tmp/v2-v107-refund.json)
- 清运首次整理组三轮 **7/7**，两条 JSON 引文逐字通过，持久归档 **247** 条且重开后召回，合计 **195,963 Token**。同一运行内新读的两页保留全文；后续轮同两页由 **5,958 → 2,834 字符**，每页省去 26 行并保留原回执。原文组末轮达到夹具既定的主模型请求上限。相同档案复测的两组均在末轮达到该上限。两个结果均不用于同等交付成本比较。[首次对照](../tmp/v2-v107-shipment-pair.json) · [实际请求](../tmp/v2-v107-shipment-pair.json.requests.json) · [原条件复测](../tmp/v2-v107-shipment-pair-repeat.json)

## 阶段八十四验证 · 混合批次拒绝与结构化答复草稿

日期 2026-11-20。统一设计 v0.97，调用契约 v0.38，Runtime draft-0.97。

- 混合原生工具与控制意图的批次在分发前全部拒绝。受控回归核对原批次零动作、下一轮重新提交一次真实调用，以及混入未知工具时直接拒绝。业务 JSON 作为答复草稿进入无工具修复，直至收到新绑定的有效完成信封。桌面 **36/36**，后端全量 **711/711**。构建、类型检查及六份提示词哈希通过。[后端全量](../tmp/v2-v108-backend-full.log) · [桌面](../tmp/v2-v108-ipc.log) · [部署](../tmp/v2-v108-prompt-manifest.log)
- 同版清运原文与整理组均完成三轮，每轮 **7/7**，均实际发出一次业务 JSON 草稿修复。整理组逐字引文通过，持久归档 **324** 条，重开后召回通过。原文组末轮把定位前缀加入两条引文，逐字对照失败，两组总用量不构成等质成本对照。[实际任务](../tmp/v2-v108-shipment-pair.json) · [请求与失败原因](../tmp/v2-v108-shipment-pair.log)
- 真实退款在子代理使用窄授权查目录期间，父模型用正确会话、运行、任务和状态修订，却在继续推理决策中复用了上一请求 ID。宿主拒绝，未进入同次运行的父层审核及授权恢复检查点。[真实退款](../tmp/v2-v108-refund.json)

## 阶段八十五验证 · 请求绑定与原行引用

日期 2026-11-20。统一设计 v0.98，调用契约 v0.39，Runtime draft-0.98。

- 模型本轮 schema 固定完整 `binding`。受控复现同一任务落后的 `continue`，拒绝原决策并用新绑定完成。原件引文增加当前请求内 `read_file` 证明来源。受控回归从实际阅读回执逐字输出原行，验证不可见、内容改写、文件位置不符或回执改变时没有可引用结果。后端首轮全量 **711/713**，两个断言涉及绑定及引文失败提示的措辞。恢复这两条提示后相关 **149/149**。V2 桌面 **36/36**，共享协议和后端构建、类型检查、六份提示词哈希通过。[首轮全量](../tmp/v2-v109-backend-full.log) · [修复后回归](../tmp/v2-v109-verified-backend.log) · [桌面](../tmp/v2-v109-ipc.log) · [提示词部署](../tmp/v2-v109-prompt-manifest.log)
- 清运原文和整理两组使用相同原件哈希，原文组整理调用为零，两组各三轮 **7/7**，两条引文均逐字匹配，实际采用直接复制原句。整理组核验 **328** 条持久归档并在重开后召回。首轮输入 **23,592 → 17,238 Token**，端到端总用量 **285,873 → 348,389 Token**，主模型请求 **10 → 12**。整理组主模型用量 **319,155 Token**，整理用量 **29,234 Token**，有 7 次原件分页请求。总成本高 **21.9%**，未满足降本。[同版对照](../tmp/v2-v109-shipment-pair.json) · [实际请求](../tmp/v2-v109-shipment-pair.json.requests.json)
- 真实退款中父代理完成同轮三附件读取，子代理完成只读目录查询，持久账本记录父层子结果审核接受。随后模型将其他节点的父级查询回执用于委派节点，宿主拒绝验收。后续无工具修复的输出是服务商调用标记文本，未提交合法 JSON，达到原修复上限；本轮账本计费 **465,983 Token**、**26** 次尝试。原人工授权恢复、原件回填、报告和第二会话隔离仍待同次真实运行验证。[真实退款](../tmp/v2-v109-refund.json)

## 阶段八十六验证 · 原件分页与重复观察

日期 2026-11-20。统一设计 v0.99，调用契约 v0.40，Runtime draft-0.99。

- 无工具修复遇到服务商调用标记时切换为 JSON 控制请求，原输出保留审计。文件分页以权威原件 ID 为准。经核验的已发布正文召回副本、原件页和纯分页参数反馈保留工具历史及原始回执，不再作为新材料重复触发通用整理。定向回归 **3/3**，后端全量 **714/714**，V2 桌面 **36/36**。后端构建、类型检查和六份提示词部署哈希通过。[定向回归](../tmp/v2-v110-final-focused.log) · [后端全量](../tmp/v2-v110-backend-full.log) · [桌面](../tmp/v2-v110-ipc.log) · [部署](../tmp/v2-v110-prompt-manifest.log)
- 清运沿用相同原件与原预算，整理组通用整理调用从上次的 **3** 降到 **0**，文件处置请求从 **4** 增到 **10**，持久归档 **315** 条并通过重开召回。原文组第二轮普通文字答复使用了结构化引文，最终引文校验拒绝；整理组前两轮各 **7/7**，末轮达到主模型轮数上限。本次样本未形成等质成本对照。[实际任务](../tmp/v2-v110-shipment-pair.json) · [请求](../tmp/v2-v110-shipment-pair.json.requests.json)
- 真实退款登记只读授权问题，继续调查后主动进入重新规划。模型修订时移除已接受节点，并尝试把未获成功回执的动作填入节点。宿主拒绝，原计划仍在。计费 **274,990 Token**、**18** 次尝试；该次未到达子结果审核，后续验收仍待完成。[真实退款](../tmp/v2-v110-refund.json)

## 阶段八十七验证 · 按请求格式交付与计划修订纠正

日期 2026-11-20。统一设计 v1.00，调用契约 v0.41，Runtime draft-1.00。

- 普通文字答复误用 `fileQuotes` 时可保留请求的文字格式。结构化答复允许宿主填入原件原行，也允许逐字核对现有的 `quote`。改写引文、位置不符和不可见来源继续拒绝。计划修订按节点反馈无有效成功回执的动作与跨节点回执，保留原计划。后端定向 **129/129**，V2 桌面 **36/36**。构建、类型检查和六份部署提示词哈希通过。[后端回归](../tmp/v2-v111-backend-scoped.log) · [桌面](../tmp/v2-v111-ipc.log) · [部署](../tmp/v2-v111-prompt-manifest.log)
- 清运两组用了相同原件与原预算。整理组完成三轮且逐轮 **7/7**，最终 JSON 两条引文逐字一致，重开后从 **324** 条持久归档中召回对应原件，四次文件处置、零次通用整理。首轮输入 **23,643 → 17,343 Token**。原文组前两轮各 **7/7**，末轮达到主模型轮数上限。两组分别计量 **330,369** 和 **306,123 Token**，本次未构成等质降本验证。[清运对照](../tmp/v2-v111-shipment-pair.json) · [实际请求](../tmp/v2-v111-shipment-pair.json.requests.json)
- 真实退款验收附件节点。子代理的首次实际目录搜索已经给出 `project-files:read_file` 及名称 `read_file`，仍继续查询，末次无工具修复未提交合法完成信封，耗尽子任务输出预算。父层读取并拒收该失败结果。随后父级查询回执被错误引用到委派节点，宿主拒绝结算。账本计费 **622,303 Token**、**34** 次尝试，原只读授权恢复、归档回填、最终交付和第二会话隔离待同次实跑核查。[退款轨迹](../tmp/v2-v111-refund.json)

## 阶段八十八验证 · 子结果核对轮与分页引文

日期 2026-11-20。统一设计 v1.01，调用契约 v0.42，Runtime draft-1.01，Child draft-0.5。

- 只授予目录查询的子代理在首条精确匹配后进入一次无工具核对。定向回归验证可凭已有回执提交结果，也可描述具体缺项并恢复原能力进行不同查询。结构化引文可从实际发布的文件行页校验，同会话原件、页回执和原文任一缺失均拒绝。后端定向 **33/33**、全量 **715/715**，V2 桌面 **36/36**。[后端全量](../tmp/v2-v112-backend-full.log) · [定向](../tmp/v2-v112-backend-focused.log) · [桌面](../tmp/v2-v112-ipc.log)
- 清运原文组完成三轮并通过逐字引用。整理组已发布两份原件主张，仍尝试逐页读全文件，重复提交超限范围后运行停止。重开召回通过，未形成等质成本对照。[清运](../tmp/v2-v112-shipment-pair.json)
- 第一次真实退款反复在人工问题信封附加 API 的 `type`。第二次在调查阶段重复找下一阶段委派能力，重新进入规划并提出额外人工问题，在原子结果等待窗口内未完成委派。两次均未到达组合验收的授权恢复环节。[退款第一次](../tmp/v2-v112-refund.json) · [退款第二次](../tmp/v2-v112-refund-replicate.json)

## 阶段八十九验证 · 可定位的控制和分页反馈

日期 2026-11-20。统一设计 v1.02，调用契约 v0.43，Runtime draft-1.02，Child draft-0.5。

- 多余顶层字段由无工具修复指出具体名称，必须以本轮绑定重新提交合法信封。分页超限保留错误状态，同时给出源范围内可验证的首段。后端定向 **116/116**、V2 桌面 **36/36**，构建、类型检查及六份提示词部署内容和哈希通过。[定向](../tmp/v2-v113-backend-scoped.log) · [桌面](../tmp/v2-v113-ipc.log) · [部署](../tmp/v2-v113-prompt-manifest.log)
- 固定父层测试驱动下，真实子模型两次请求完成目录任务。第一次执行一次目录查询，第二次在空工具投影中提交有效 JSON，父层用实际回执审核。真实退款组合也观察到同一机制生效，子代理一次查询后交付结果，真实父代理审核接受。随后父模型把文档提案发到工具通道，有界修复未取得合法控制输出。计费 **274,254 Token**、**17** 次尝试；原授权恢复、归档回填、最终交付和第二会话隔离仍待同次运行验收。[独立目录验证](../tmp/v2-v113-live-catalog.json) · [退款组合](../tmp/v2-v113-refund.json)
- 清运使用同一原件和预算。原文组三轮各 **7/7** 且最终引文逐字相同。整理组首轮输入 **23,675 → 17,302 Token**，从尺寸超限范围纠正为工具给出的有效页，但共发出八次分页调用来重读两份原件，然后因重复提交计划停止。持久归档 **328** 条，重开召回通过，端到端成本比较待两组均完成。[清运](../tmp/v2-v113-shipment-pair.json) · [请求](../tmp/v2-v113-shipment-pair.json.requests.json)

## 阶段九十验证 · 结构化修复与重复补读核对

日期 2026-11-20。统一设计 v1.03，调用契约 v0.44，Runtime draft-1.03。

- 受控回归核对只有控制载体出现在修复请求，单一有效信封仍按原绑定验收，混入其他工具的整批请求零执行。真实服务独立验证用 `submit_capybara_control` 提交 `complete_plan_nodes`，用实际目录回执完成原活动节点，载体无工具观察记录。后端定向 **132/132**，V2 桌面 **36/36**，构建和类型检查通过。后端全量 **717/718**，新增核对轮使高压模拟用例在并行负载下触发原 12 秒的测试等待限制。[后端全量](../tmp/v2-v114-backend-full.log) · [后端定向](../tmp/v2-v114-backend-scoped.log) · [桌面](../tmp/v2-v114-ipc.log) · [真实控制通道](../tmp/v2-v114-live-control.json)
- 清运两组使用相同原件和预算，三轮均 **7/7**，末轮结构和两条完整原句逐字匹配。整理组持久归档 **326** 条，重开召回通过。首轮输入 **23,671 → 17,398 Token**，端到端总用量 **124,917 → 190,307 Token**，约增加 **52.4%**。其中整理模型用量 **16,408 Token**，主轮请求 **5 → 8**。资料充分时的一次反应式核对有真实交付，前面的补读仍占用增量预算。[同版配对](../tmp/v2-v114-shipment-pair.json) · [实际请求](../tmp/v2-v114-shipment-pair.json.requests.json)
- 真实退款的结构化修复成功登记等待；子任务进入成功状态。父代理可见目录注册项与实际回执，却多次翻阅整个子任务工作包，未消费结果，最后从委派阶段尝试未投影的文档动作被拒绝。总计 **793,460 Token**、**43** 次计量尝试。原授权恢复和后续交付未执行。[真实退款](../tmp/v2-v114-refund.json)

## 阶段九十一验证 · 文件发布核对与子交付分页

日期 2026-11-20。统一设计 v1.04，调用契约 v0.45，Runtime draft-1.04。

- 当前运行的多来源文件处置发布后，在直接阶段先核对再决定交付或补读，受控用例覆盖明确缺项后恢复原工具、继续精确读取和保留原归档。子交付按原 `child_id` 和 `output_next_offset` 读取下一页，结果 hash 与工作包引用保持同一身份，每页有独立读取回执。后端全量 **718/718**、定向 **132/132**，V2 桌面 **36/36**。构建、类型检查及六份提示词部署哈希通过。高压模拟的测试等待改为 20 秒，验收场景继续使用原模型预算与期限。[后端全量](../tmp/v2-v115-backend-full.log) · [后端定向](../tmp/v2-v115-backend-scoped.log) · [桌面](../tmp/v2-v115-ipc.log) · [部署](../tmp/v2-v115-prompt-manifest.log)
- 清运两组实际完成三轮，全文引文和 **7/7** 条件核对均通过。整理组第一轮在控制载体中确认两个原句，同时要求补读原句周围材料，后续四个分页请求由两个模型轮发出。共持久归档 **324** 条，重开后成功召回。首轮输入从 **23,676** 降到 **15,475 Token**，端到端记录用量 **183,625 → 212,699 Token**，增加 **15.8%**。整理模型用量 **16,408 Token**，主轮请求 **7 → 9**。[同版配对](../tmp/v2-v115-shipment-pair.json) · [请求](../tmp/v2-v115-shipment-pair.json.requests.json)
- 真实退款子结果有一次读取和一次有效父层接受，未重复翻阅工作包。父层随后发起两次重新规划，未以有效控制信封结算已接受计划中的活动节点。总计 **570,832 Token**、**29** 次计量尝试，其中规划 **14** 次。未到达本次授权恢复、归档回填与最终交付。[真实退款](../tmp/v2-v115-refund.json)
- 对退款轨迹中的独立规划请求做单步真模型复验。通过控制载体收到合法的 `propose_plan`，绑定、原节点和已接受义务保持一致，原计划通过纯账本校验。这个结果覆盖单次规划传输，组合场景仍需复验。[规划传输探针](../tmp/v2-v115-replanning-transport-probe.json)
- 清运验收额外保留双组全部模型尝试的提供方用量、预算预留和缺失字段。质量与成本独立判定。投影测试三轮通过，成本标为未评估。带完整账本的真实复跑原文组三轮通过，整理组第三轮达到调用限制，分别记录 **269,893** 和 **342,804 Token**，本次没有形成可用于成本判定的等质样本。[投影测试](../tmp/v2-v115-cost-projection.json) · [带完整账本的复跑](../tmp/v2-v115-cost-pair.json)

## 阶段九十二验证 · 原计划恢复与文件行处置计数

日期 2026-11-20。统一设计 v1.05，调用契约 v0.46，Runtime draft-1.05。

- 独立复核可以按实际绑定提交 `resume_plan`，沿用原计划版本、节点和成功回执，只推进当前状态。文件投影加入 `lineDisposition`，区分发布、归档、混合和可见行。初次全量 **718/719**，恢复协议的状态修订在通用信封记录处多推进一次；修正后针对性回归 **2/2**。V2 桌面 **36/36**。[初次全量](../tmp/v2-v116-backend-full.log) · [修正后定向](../tmp/v2-v116-final-focused.log) · [桌面](../tmp/v2-v116-ipc.log)
- 清运两组在相同原件与预算下完成三轮，最终引文逐字一致，整理组持久归档 **326** 条且重开召回成功。首轮输入 **23,662 → 15,448 Token**。完整预算账本的提供方用量为 **154,822 → 168,054 Token**，对应 **6 → 11** 次模型尝试，整理组增加约 **8.5%**。成本验收标记 `not_reduced`。[实际配对](../tmp/v2-v116-shipment-pair.json)
- 真实退款中的父层审核接受成功。结算时，宿主把子结果读取回执归到当时活动的附件节点，因此拒绝了委派节点提交的回执。本次记录 **770,914 Token**、**35** 次计量尝试。随后按已验证的子句柄补上回执验收归属。[实际退款](../tmp/v2-v116-refund.json)

## 阶段九十三验证 · 子任务动作归属与有界文件读取

日期 2026-11-20。统一设计 v1.06，调用契约 v0.47，Runtime draft-1.06。

- 子结果读取、审核凭真实子句柄记录 `completionPlanTaskIds`，并行附件节点保留其自己的动作。文件多页范围可显式选择有界首段，持久回执记录实际内容与续页范围。定向回归 **3/3**，V2 桌面 **36/36**。独立真实服务探针提交 `resume_plan`，保留原计划修订和先前查证回执，恢复后结算原活动节点并完成。[定向](../tmp/v2-v117-backend-focused.log) · [桌面](../tmp/v2-v117-ipc.log) · [真实计划恢复](../tmp/v2-v117-live-resume.json) · [部署](../tmp/v2-v117-prompt-manifest.log)
- 真模型退款在同一运行完成子结果审核、三个附件的原调查结算、桌面宿主重开及原授权请求恢复。召回命中的 N-41 归档 ID 与授权前一致，原件 ID 也一致。后续给「审计索引」的会话 diff 取得 applied 回执。交付节点仍待结算时，模型从当前阶段请求重复读取账本 1–32 行，宿主拒绝分发。本次 **528,191 Token**、**33** 次尝试；最终报告和跨会话隔离仍未达成。[真实退款](../tmp/v2-v117-refund.json)
- 清运整理组三轮各 **7/7**、最终引文逐字一致，**328** 条归档有持久证明，重开召回通过。原文组首轮触及原调用上限，完整账本保留两组实际用量，成本标记质量待验证。[清运对照](../tmp/v2-v117-shipment-pair.json)

## 阶段九十四验证 · 已验收文件区间与文档提交回执

日期 2026-11-20。统一设计 v1.07，调用契约 v0.48，Runtime draft-1.07。

- 跨阶段重复读按原调查回执及持久原件识别，覆盖精确重读和原件所证实的子区间。原文件以外或未证明的范围继续拒绝。当前活动节点已有 applied 文档回执时，有界控制修复可凭该回执结算节点，重复读没有分发。后端定向 **136/136**，文档提交恢复 **1/1**，V2 桌面 **36/36**。[后端定向](../tmp/v2-v118-backend-scoped.log) · [提交回执恢复](../tmp/v2-v118-edit-recovery.log) · [桌面](../tmp/v2-v118-ipc.log)
- 真实退款两次在独立规划中使用 `resume_plan`，原子结果获父层接受，原委派节点已验收。初次计划给附件节点留空能力，加载后 `read_file` 仍未投影。模型随后尝试重新派发已完成的子任务，宿主拒绝。预算账本登记 **42** 次尝试、**853,104** 已报告 Token、**889,001** 计费预留 Token。该次未进入宿主重开及交付。[真实退款](../tmp/v2-v118-refund.json)
- 清运整理组三轮各 **7/7** 且最终 JSON 两条引文逐字相同，**328** 条持久归档，重开召回通过，提供方用量 **108,771 Token**。原文组首轮的 diff 引用了非所属证据，被拒后未完成。提供方用量 **356,713 Token**，成本状态 `quality_unverified`。[清运对照](../tmp/v2-v118-shipment-pair.json)
- 上一轮后端全量 **718/720**。两条训练用例在末次纠正请求的估算输入达到原预算上限，未留下生成空间。精简原件读取工具说明后，预算定向复验三条全部通过，覆盖有参考答案、仅质量信号及耗尽纠正次数三种训练条件。[首轮全量](../tmp/v2-v117-backend-full.log) · [预算定向修复](../tmp/v2-v119-training-focused.log)

## 阶段九十五验证 · 节点能力声明与原授权恢复

日期 2026-11-20。统一设计 v1.08，调用契约 v0.49，Runtime draft-1.08。

- 提示词明确在计划节点先声明所需的未加载能力，进入相应阶段再加载，遗漏节点授权时提交计划修订。带原预算的后端全量 **723/723**，V2 桌面宿主、IPC 和流式观察回归 **48/48**。后端构建、类型检查及六份部署提示词内容和哈希一致。[后台](../tmp/v2-v119-backend-full.log) · [桌面](../tmp/v2-v119-ipc.log) · [部署](../tmp/v2-v119-prompt-manifest.log)
- 真实退款给附件节点声明 `project-files:read_file`，按同一请求读取三份附件并验收，父层接受并结算原子任务。重开同一运行后使用原人工请求的真实回执验收授权节点，取回同一归档及原件 ID 的 N-41，以 applied 回执写入「审计索引」。该 diff 漏填 `planTaskId`，生成的编辑回执未附计划节点。后续用其他节点回执和空引用验收报告均被拒绝。整次 **36** 次尝试、**638,263** 已报告 Token，最终报告和第二会话隔离待验证。[真实退款](../tmp/v2-v119-refund.json)
- 清运整理组三轮各 **7/7**，两条引文与原件逐字一致，**326** 条持久归档并通过重开召回。原文组首轮达到原有模型请求上限。原文、整理分别记录 **320,371** 和 **259,463** 提供方 Token，质量门槛仅整理组通过。[同版对照](../tmp/v2-v119-shipment-pair.json)

## 阶段九十六验证 · 编辑节点绑定与真实报告交付

日期 2026-11-20。统一设计 v1.09，调用契约 v0.50，Runtime draft-1.08。

- 计划执行阶段的模型 diff 必须逐项绑定活动节点。受控回归先提交漏填的真实候选，宿主在写入前拒绝，随后带正确节点提交，只生成一项实际编辑。按其原回执完成节点，越阶段重读未执行。静态解析仍接受直接模式的无节点 diff。首次扩大到静态 schema 后定向 **83/84**、桌面 **47/48**；限制在当前计划投影后，后端全量 **723/723**、定向 **84/84**、桌面 **48/48**，直接与计划投影的 schema 核对通过。后端构建与类型检查通过。[全量](../tmp/v2-v120-fixed-full.log) · [定向](../tmp/v2-v120-fixed-focused.log) · [节点绑定](../tmp/v2-v120-node-binding-focused.log) · [桌面](../tmp/v2-v120-fixed-ipc.log) · [投影 schema](../tmp/v2-v120-projected-schema.log)
- 真实退款在同一 V2 宿主运行中完成原子任务与原授权、同一持久归档及原件的召回、绑定 `context:` 回执并验收原节点，最终报告的金额、来源、只读范围及退款待授权检查通过。文档检查发现「审计索引」位于自动生成的任务标题下，预期为根级章节，整体验收在该处停止。用量 **39** 次尝试、**706,744** 已报告 Token。下一次验收先独立核对第二会话边界，再检查原会话文档路径，保留两个结果。[实际报告与轨迹](../tmp/v2-v120-refund.json)

## 阶段九十七验证 · 根级回填路径与隔离核对

日期 2026-11-20。统一设计 v1.10，调用契约 v0.51，Runtime draft-1.09。

- Runtime 指定从根开始的 `headingPath`，单个新章节名对应单层路径。以同一真实失败请求替换这段提示词，实际模型提交了 `headingPath: ["审计索引"]`，保持 N-41 原句与活动节点绑定。该探针只核对模型提案，未写入运行文档。编辑回执恢复与训练预算定向 **4/4**，六份部署提示词内容和哈希一致。[单轮真模型复验](../tmp/v2-v121-heading-probe.json) · [定向](../tmp/v2-v121-focused.log) · [提示词](../tmp/v2-v121-prompt-manifest.log)
- 组合脚本独立记录新会话的项目文档身份、会话文档身份、项目规则和会话私有归档检索结果。此次真实退款已按当前节点能力读取三份附件，随后反复进入规划、恢复原计划，未用现有回执验收调查节点。在原预算下总计 **35** 次已计量请求、**850,626** 已报告 Token，停止于下一份规划输入预留。重开、正确根级回填与第二会话隔离仍需在同次运行核对。[最新组合轨迹](../tmp/v2-v121-refund.json) · [最近一次实际报告](../tmp/v2-v120-refund.json)

## 阶段九十八验证 · 能力发现与双组文件证据核对

日期 2026-11-21。统一设计 v1.11，调用契约 v0.52，Runtime draft-1.10。

- 上轮退款的调查阶段按真实目录查询 `delegate_task` 返回空，模型把下一阶段的系统能力误判为缺失。本轮主层目录返回注册来源和当前投影，子生命周期工具明确受状态门禁。同一图的活动节点已经复核时，重复规划请求进入有界控制修复，现有读取回执仍可用于结算。受控回归核对调查期能找到委派能力、下游才可分发、读取动作在原节点验收，以及重复规划零分发。[上轮真实轨迹](../tmp/v2-v121-refund.json) · [定向](../tmp/v2-v122-focused.log)
- 大批原始文件工具结果也进入一次有界核对，触发前核对同一请求批的持久原件，保留真实缺项的后续读取。构建、类型检查、六份提示词部署和新增、训练预留合计 **6/6** 通过。清运两组均完成三轮 **7/7**，两个最终 JSON 均逐字匹配，整理组 **247** 条归档具备持久证明且重开召回成功。首轮输入 **21,844 → 15,526 Token**，完整提供方用量 **156,032 → 253,851 Token**（**6 → 16** 次），多 **62.7%**。整理组首次交付后，第二轮重新分页 **10** 次，成本门槛未满足。原文组首轮正文把应排除的记录计入开头总数，随后明确判定无关。[配对](../tmp/v2-v122-shipment-pair.json) · [部署](../tmp/v2-v122-prompt-manifest.log)
- 真实退款修订原委派节点的子能力声明后，完成三份附件和原子结果验收。V2 宿主重开并恢复原授权请求后，召回命中授权前同一份 N-41 归档及原件。模型加入独立审计索引节点，根级章节和原句分别取得 applied 回执。该节点结算前又发出系统变量读取，下一轮超过原预算预留，最终报告和第二会话隔离待验证。实际 **44** 次尝试、**840,807** 已报告 Token。[真实退款](../tmp/v2-v122-refund.json)
- 并行后端回归 **704/725**。21 条未通过用例中，**19** 条串行通过，评分请求的超时用例单独通过。剩余一条原生工具流复现宽泛 `read` 匹配将系统工具排在项目读取命中之前，目录摘要截去了实际所需 ID。系统工具改按准确名称或注册 ID 检索后，原生工具流和分阶段目录 **2/2** 通过。V2 桌面并行 **47/48**，退款组合超时后单独通过。最终构建和类型检查通过，最新单版全量尚待复跑。[后端并行](../tmp/v2-v122-backend-full.log) · [串行](../tmp/v2-v122-serial-retry.log) · [评分超时](../tmp/v2-v122-scoring-focused.log) · [目录修复](../tmp/v2-v122-catalog-recovery.log) · [桌面复验](../tmp/v2-v122-desktop-refund-focused.log)

## 阶段九十九验证 · 后续证据复用与编辑回执核对

日期 2026-11-21。统一设计 v1.12，调用契约 v0.53，Runtime draft-1.11。

- 已完成答复后的直接轮可先核对仍在实际投影中且有有效证明的文件正文。纯文档节点组提交成功后，宿主单次提供仍归活动节点的提交回执，主轮凭实际回执验收或说明缺项。定向 **6/6**，覆盖原件型后续请求、恢复补读、文档回滚/重放和训练预留。构建、类型检查及六个部署提示词哈希一致。[定向](../tmp/v2-v123-focused.log) · [部署](../tmp/v2-v123-prompt-manifest.log)
- 清运整理组三轮各 **7/7**，最后两条引文逐字匹配，**326** 条持久归档且重开召回通过。后两轮各一次主请求，零补读；首轮仍补读八页。整理组记录 **204,460 Token**。原文组首个答复引用未登记的证据，随后进入规划并耗尽原轮数，未构成等质成本对照。[清运对照](../tmp/v2-v123-shipment-pair.json)
- 真实退款的子代理完成一项实际目录查询，之后多次返回含未转义换行的 JSON 字符串，子任务失败。父层读取后拒绝该结果，按接管路径使用真实查询回执结算该分支。验收脚本等待原子结果被接受而超时。实际 **31** 次尝试、**570,030** 已报告 Token。本次未触发编辑回执核对。[退款轨迹](../tmp/v2-v123-refund.json)

## 阶段一百验证 · 交付引用修复与子目录控制通道

日期 2026-11-21。统一设计 v1.13，调用契约 v0.54，Runtime draft-1.11。

- 核对轮的交付引用修复保留用户答复草稿和已取得的证据，继续使用控制投影。子代理目录核对在兼容通道中只提供控制载体。受控用例验证真实目录查询、具体缺项后恢复查询、重复查询零分发，多行交付仍走同一严格信封校验。定向 **7/7**，构建与类型检查通过。[定向](../tmp/v2-v124-final-focused.log)
- 清运原文组通过前两轮，末轮从已读材料的交付重新进入规划，达到原请求上限。整理组三轮各 **7/7**，末轮引文逐字相同，**326** 条归档具备持久证明，重开召回成功，后两轮无分页。原文/整理组分别计量 **321,940 / 214,612 Token**。两组尚未同时达到质量门槛。[清运对照](../tmp/v2-v124-shipment-pair.json)
- 真实退款父节点实际读完三份附件，随后把文件名当原件 ID 向 `read_runtime_artifact` 提交。重复失败门禁停止运行，既有证据仍可追溯。实际 **15** 次尝试、**181,270** 已报告 Token，本次未完成原委派和原授权恢复。[退款轨迹](../tmp/v2-v124-refund.json)

## 阶段一百零一验证 · 同质量成本对照与历史证据复用

日期 2026-11-21。统一设计 v1.14，调用契约 v0.55，提示词组 v0.71，Runtime draft-1.11。

- 后续直接轮也可核对仍完整可见、与原请求和持久回执匹配的多文件原文批次。编译、类型检查与 **5/5** 定向回归通过，涵盖两类历史来源、提交后的编辑节点回执核对和两种子代理控制载体。[定向](../tmp/v2-v125-focused.log)
- 同版后端全量 **726/726**，V2 桌面 IPC、RuntimeLoop 宿主与运行可观测性 **48/48**，两组均无跳过、取消或失败。受控桌面退款场景通过项目记忆、委派、原人工流程和归档回填的组合校验。六份提示词源和运行时模板内容及 SHA-256 一致。[全量后端](../tmp/v2-v125-backend-full.log) · [V2 桌面](../tmp/v2-v125-desktop-full.log) · [部署清单](../tmp/v2-v123-prompt-manifest.log)
- 清运原文组与整理组三轮均为 **7/7**，末轮 JSON 的同两条引文均与原件逐字一致。整理组 **326** 条持久归档，重开后由 `source_archive` 召回。两组后两轮都各用一次主模型请求，均未分页。[清运配对与召回](../tmp/v2-v125-shipment-pair.json)
- 整理组首轮主模型输入由 **21,784** 降至 **15,524 Token**，降幅 **28.7%**。原文组使用 **3** 次主模型请求，总计 **71,399 Token**。整理组使用 **6** 次主模型请求和 **4** 次整理请求，总计 **129,864 Token**，增加 **81.9%**，所有请求均有提供方计量。整理组多出的三次首轮主模型请求合计 **58,209 Token**，涉及原行补读与交付修复。端到端成本门槛尚未通过。[计量与轨迹](../tmp/v2-v125-shipment-pair.json)
- 将退款失败时的真实目录回执交给兼容控制载体，主模型一次返回有效信封，准确绑定原回执并返回 `project-files:read_file`。本次探针只验证子代理的模型输出及证据绑定。实跑退款仍需在同一运行中完成父层消费、重开授权、回填验收、交付与第二会话隔离。[实际模型探针](../tmp/v2-v125-child-carrier-probe.json)
- 本地分类服务重放冻结历史留出包 `e51b0b48b633`。含 X92 与 51 kPa 的相反建议预期保留 `K`，实际为待核对 `R`。原句继续随原件可见，此包没有作为整理后的局部证据发布。保留标签召回仍有缺口，未调动判定阈值或训练留出样本。[留出复验](../tmp/v2-v124-historical-source-check.json)

## 阶段一百零二验证 · 原件参数反馈与整份复核的局部归档

日期 2026-11-21。统一设计 v1.15、调用契约 v0.56、Runtime draft-1.12、Organizer draft-0.13。

- 原件读取参数诊断只提示当次请求已经发布、来自本会话且可复核的唯一原件。路径误用、原件未发布和跨范围调用继续拒绝；下一次按实际 ID 读取并取得成功回执。整份复核有一条待核对时，只有同组另两份文件都有活跃原文见证，才按双重确认的 A 局部归档。构建、类型检查和 **49/49** 定向回归通过，覆盖原件参数、归档及原有反思反馈。[定向](../tmp/v2-v126-archive-focused.log)
- 清运原文组和整理组各三轮 **7/7**，最终两处逐字引文通过。整理组后续仍可见第三份附件第 37 行待核对材料，另外 **82** 行从这一文件的实际主轮投影移出。三份原件的其余已归档范围共有 **492** 条持久证明，重开从 `source_archive` 召回抽查原句。[配对与召回](../tmp/v2-v126-shipment-pair.json)
- 两组均只用 **3** 次主模型请求，无补读和额外修复。计入 **4** 次本地分类调用，实际总量 **71,825 → 58,606 Token**，减少 **13,219 Token（18.4%）**，每次请求都有计量。原文与整理组使用相同原件和提示词。[真实计量](../tmp/v2-v126-shipment-pair.json)
- 退款实跑使用 Runtime draft-1.12 和变更前的 Organizer draft-0.12，原人工请求已登记，目录查询子任务成功且父层读取和验收了实际回执。之后模型反复请求验收尚未进入活动阶段的审核节点，当前附件节点仍未验收。门禁拒绝后达到修复上限。实际 **15** 次尝试、**222,387** 已报告 Token。本次未完成重开授权、回填交付和第二会话隔离。[退款实跑](../tmp/v2-v126-refund.json)

## 阶段一百零三验证 · 当前阶段恢复与暂定主张的训练采集

日期 2026-11-21。统一设计 v1.16，调用契约 v0.57，Runtime draft-1.13。

- 验收尚未活动的节点时，信封和误发的原生调用均无执行效果。修复轮恢复办理当前阶段未结动作所需的授权投影，保留原计划与回执。定向 **7/7**、构建及类型检查通过，六份部署内容与源文件哈希一致。[阶段回归](../tmp/v2-v127-focused.log) · [部署清单](../tmp/v2-v127-prompt-manifest.log)
- 真模型退款完成窄范围子任务消费和三附件核查，桌面重开后使用原请求完成只读授权节点。召回结果的归档 ID 和原件 ID 均与授权前保存的 N-41 一致。随后两个 `propose_diff` 被误投为同批原生调用，整批零分发。实际 **28** 次已计量尝试、**445,666** 个 Token。根级回填、最终报告和第二会话隔离仍需验证。[真实 V2 桌面轨迹](../tmp/v2-v127-refund.json)
- 新增三组训练和一组独立验证的配对任务，用有明确来源的暂定异议、跨任务无关材料和确实无法判断归属的材料区分 K、A、R。通过现有运行时采集出口导出 **24** 条并完成准入。合并后训练 **188** 条、验证 **24** 条、旧留出 **36** 条。旧留出文件逐字节一致，SHA-256 不变。[配对训练资源](../apps/backend/test/fixtures/context-span-contrast-cases.json) · [准入](../tmp/v2-v127-provisional-admission.log)

## 阶段一百零四验证 · 多项编辑和连续单文件读取

日期 2026-11-21。统一设计 v1.17，调用契约 v0.58，Runtime draft-1.13。

- 同一决策的多项原生误调用统一拒绝为零分发，再使用一个当前绑定的控制信封。两个编辑的受控回归确认修复前无写入，之后按普通 diff 原子门禁处理。文档树和任务阶段合计 **44/44**，构建与类型检查通过。[回归](../tmp/v2-v128-focused.log)
- 新一轮真实退款完成委派、消费和重开授权，父模型把三份附件拆成三次读取。持久整理审计只出现六次同一账本原句分类，另外两份文件未进入整理窗口，授权前没有形成 N-41 归档。回复后归档查询真实返回空。模型转用授权文字的候选尝试回填，因证据 ID 与候选不匹配被拒绝。实际 **43** 次尝试、**722,557** 已报告 Token。[真实轨迹](../tmp/v2-v128-refund.json)
- 对完整单件处置复用仍有效的同任务原件与正文或归档证明。处置的复用不给单文件提前折叠的权限。受控回归实际逐次读取三份文件，前两份各整理一次，不相关文件独立初筛和复核，原行可从持久归档取回，原工具结果仍可见。构建、类型检查和 **9/9** 定向回归通过。[单文件调度回归](../tmp/v2-v129-focused.log)
- 新数据在 RTX 3060 上完成四轮本地训练，峰值 CUDA 预留 **1,504 MiB**。验证组选择第二轮。冻结留出逐包结果为长任务 **12/12 → 12/12**、短任务 **9/12 → 12/12**、历史 **11/12 → 8/12**、退款独立探针 **3/3 → 2/3**。两版均没有将 K 或 R 误归档，X92 仍为 R。保留原服务权重，新权重作为独立实验记录。[训练](../tmp/v2-v128-provisional-train.log) · [同一留出集对照](../tmp/v2-v128-provisional-eval.jsonl)

## 阶段一百零五验证 · 人工提问与独立工作顺序

日期 2026-11-21。统一设计 v1.18、调用契约 v0.59、Runtime draft-1.14。

- 上版真实场景的计划把已经授权的父代理读取及子代理目录查询都设为人工授权完成的下游。问题发出后，没有就绪的独立节点，宿主按原计划暂停，组合脚本等待子回执超时。本次仅有两次已计量模型请求、**22,728** Token。流程尚未触及单文件处置改动。[真实暂停轨迹](../tmp/v2-v129-refund.json)
- Runtime 明确以计划列表表达发问先后，以 `dependsOn` 表达完成依赖。用真实失败轮的相同消息、当次绑定和 schema，只替换该说明后复验。模型把人工节点排在首位，读取与委派节点依赖为空，交付依赖人工授权与前置工作。单轮控制信封通过解析，共 **11,780** Token。此探针没有提交计划或执行任何项目动作。[真实规划探针](../tmp/v2-v130-planning-probe.json)
- 同版真实 V2 桌面复验按预期发问，实际读取三份附件并验收子代理目录结果。重开后模型取得原 `human:` 回执，召回命中同一归档 ID 和原件 ID。已接受「审计索引」独立回填节点并进入执行，首个编辑请求因原预算只余 15,956 Token、下一轮需预留 30,851 Token 而被拒绝。完成前有四次原件分页。实际 **44** 次计量、**841,731** Token，尚未提交编辑、交付报告或启动隔离验收。[真实桌面轨迹](../tmp/v2-v130-refund.json)
- 同版构建、类型检查和 **5/5** 定向回归通过。六份分发资源与评审正文的哈希一致。[定向回归](../tmp/v2-v130-focused.log) · [部署清单](../tmp/v2-v130-prompt-manifest.log)
- 同版 V2 桌面回归 **48/48**。后端全量 **724/729**，三个原件分页用例经旧入口传参时拒绝了合法参数，两个自动训练用例在原 Token 限制下被提前停止。下一版沿同一授权门禁恢复原件入口参数，并按子任务状态装配审核说明。[后端全量](../tmp/v2-v130-backend-full.log) · [桌面回归](../tmp/v2-v130-desktop-full.log)

## 阶段一百零六验证 · 计划局部修订和归档命中范围

日期 2026-11-21。统一设计 v1.19，调用契约 v0.60，Runtime draft-1.15。

- 路径和授权核对继续使用实际工具请求绑定。保留原始参数入口后，同会话分页、跨会话拒绝、已批准项目来源和大原件分页各按原合同核验。计划增量形态经当前绑定和完整计划门禁展开，保留原有动作引用和授权。构建和类型检查通过，定向 **12/14**。两项自动训练的完整纠错序列仍提前达到原 Token 限额。[来源回归](../tmp/v2-v131-source-retry.log) · [定向回归](../tmp/v2-v131-focused.log)
- 前一版真实退款在委派能力缺失后多次重写原图，导致义务变更被拒绝。N-41 命中包含完整归档片段，但 `truncated` 度量整个原件，造成无效补读。Runtime 更新为局部计划修订，并分别表达命中完整性与原件范围。[前一版真实请求](../tmp/v2-v130-refund.json) · [调用契约](prompts/v2/call-contracts.md)
- 同版真实 V2 运行完成父代理对目录查询子结果的验收。关停重开后，模型取得原授权回复，召回同一个 N-41 归档 ID 与原件 ID。模型通过 `planAmendment` 新增执行节点，在根级「审计索引」逐字提交原句，宿主发布该节点的编辑回执。模型验收时混入报告节点的两条原件回执，宿主拒绝。重新检索后又尝试提交同一句，最终因候选已消耗而触发 `CANDIDATE_NOT_IN_PROJECTION`。模型轨迹 **33** 次请求、**721,882** 个已报告 Token。最终交付和第二会话未运行。[真实桌面轨迹](../tmp/v2-v131-refund.json)

## 阶段一百零七验证 · 编辑回执归属与控制轮修复

日期 2026-11-21。统一设计 v1.20，调用契约 v0.61，Runtime draft-1.16。

- 编辑核对轮按当前节点给出实际 diff 回执。拒绝混入的其他节点动作引用后，修复轮继续使用控制通道和原提交证明。需要补办动作时可由模型显式申请下一次执行。公共指引合并重复内容，自动训练沿原限额验证。
- 构建、类型检查与定向 **15/15** 通过。定向用例验证第二次提交同一原编辑回执可以验收节点，期间不重做编辑。自动训练两条成功路径与预算耗尽的负向用例均沿用原限额。[定向回归](../tmp/v2-v132-focused-final.log) · [部署清单](../tmp/v2-v132-prompt-manifest.log)
- 同版真实退款在首个授权问题的结构化输出失败。`actions[0].question` 已有内容，`userMessage` 连续留空。通用修复提示未定位字段，达到重试上限。模型轨迹 **8** 次请求、**96,054** 个已报告 Token。本次没有注册授权问题或到达编辑核对轮。[真实轨迹](../tmp/v2-v132-refund.json)

## 阶段一百零八验证 · 可见人工问题与小模型增量训练

日期 2026-11-21。统一设计 v1.21，调用契约 v0.62，Runtime draft-1.17。

- 原可见问句约束进入当轮输出 schema。空白时返回字段级修复，继续使用一个 `ask_user` 动作、当前请求绑定和原节点范围。宿主在校验成功后登记问题。
- Backend 构建、全仓类型检查及 **10/10** 定向回归通过。实际运行正文与六份分发资源哈希一致。[类型检查](../tmp/v2-v133-typecheck-final.log) · [定向回归](../tmp/v2-v133-focused.log) · [部署清单](../tmp/v2-v133-prompt-manifest.log)
- 同版真实退款登记了有效授权问题，父层验收真实目录查询子结果，重开后结算原授权节点并召回原 N-41 记录。模型随后在会话文档节点引入项目文件工具来查章节，把文档 diff 误发为原生调用，最终在控制修复前达到预算。轨迹中 **34** 次有用量记录的请求共 **816,049** Token。本次未提交文档回填、最终报告和第二会话验收。后续组合验证要核对文档编辑阶段能直接看到控制载体，并用已投影的文档树定位章节。[真实轨迹](../tmp/v2-v133-refund.json)
- 增加两组训练、一组独立验证配对，覆盖任务只写主题、来源用别名附带记录号、无关材料和相关材料恰好使用相同单位、匿名读数缺少归属这四种情形。通过 RuntimeLoop 的原件读取、整理采集和独立准入导出 **18** 条，合计训练 **200** 条、验证 **30** 条、冻结留出 **36** 条。留出文件 SHA-256 与此前一致。[场景数据](../apps/backend/test/fixtures/context-span-contrast-cases.json) · [准入结果](../tmp/v2-v133-indirect-admission.log)
- 反馈分类器从现用适配器和分类头启动，用固定种子与 `4e-5` 学习率训练两轮，峰值 CUDA 预留 **1,306 MiB**。验证选择的起始权重被重新校准，归档阈值从 `0.65` 降到 `0.50`。冻结对照中短任务 **9/12 → 12/12**，长任务 **12/12**、历史 **11/12**、退款 **3/3**。历史异议 X92 从待核对 `R` 变成误归档 `A`，因此该候选未启用。训练器将起始权重和它原来的阈值一起作为参考检查点，新的训练检查点分别校准。[训练](../tmp/v2-v133-indirect-train.log) · [冻结留出](../tmp/v2-v133-indirect-eval.jsonl)
- 同版 V2 桌面 IPC **48/48**。清运同题两组各三轮 **7/7**，最终 JSON 的两条引文逐字一致。整理组的 **492** 条归档证明可持久验证，重开召回原句通过。服务分别报告原文组 **71,307** 和整理组 **57,708** Token，原文组一项 HTTP 尝试缺少用量，本次成本门槛记为计量不全。[桌面回归](../tmp/v2-v133-desktop-full.log) · [同题质量与计量](../tmp/v2-v133-shipment-pair.json)
- 同版重测使用相同三份原件，两组各三轮 **7/7** 并通过精确引文。整理组 **488** 条归档证明均持久可核，关闭重开召回通过。原文组 **3** 次、整理组 **7** 次请求均有完整计量，后者含 **4** 次分类。总量 **71,679 → 59,239 Token**，少 **12,440 Token（17.4%）**。[完整计量复验](../tmp/v2-v133-shipment-pair-metered.json)
- 保留原阈值的续训复验在第 0 轮选回起始检查点。适配器与分类头的全部张量逐项相等，归档阈值、保留阈值和标签也与原服务一致。此次各训练轮仍未提供可替换的提升，X92 的保留能力继续待验收。[训练记录](../tmp/v2-v134-indirect-train.log) · [检查点核对](../tmp/v2-v134-indirect-checkpoint.log)
- 在真实退款第 23 个模型请求的同一文档投影、证据和绑定上，单独提供控制载体与可选观察工具，明确从会话文档定位章节。模型首次即通过 `submit_capybara_control` 生成 `propose_diff`，原句、单条证据引用、根级「审计索引」和活动节点均正确。探针只校验模型输出，未提交 diff 或迁移任务状态。[真实控制载体探针](../tmp/v2-v134-document-carrier-probe.json)
- 同版 Backend 全量 **731/731**。包含旧原件分页入口、计划增量、归档回执、可见提问和固定 Token 限额下的训练纠错。[后端全量](../tmp/v2-v133-backend-full.log)

## 阶段一百零九验证 · 计划编辑控制载体

日期 2026-11-21。统一设计 v1.22，调用契约 v0.63，Runtime draft-1.18。

- 当前计划执行节点可以用文档投影定位标题。支持控制载体的调用可在此阶段提交一个符合当前绑定的信封，观察工具继续按原投影授权。混合调用零分发，宿主按当前修复限额提示单独提交。文档提交后继续凭原节点回执验收。
- Backend 构建、类型检查、六份分发哈希与 **12/12** 定向通过。新增受控用例先提交混合批次，再单独提交合法信封，验证只发生一次文档更新。V2 桌面 IPC 两条相关场景 **2/2**。[定向回归](../tmp/v2-v134-focused-final.log) · [桌面定向](../tmp/v2-v134-desktop-focused.log) · [分发清单](../tmp/v2-v134-prompt-manifest.log)
- 同版真实 V2 桌面退款整场通过。独立子代理实际查询资源目录，父代理验收其结果，三份附件均有不同的证据来源。关闭重开原会话，原人工请求收到绑定回复。首个归档查询取得授权前的同一份 N-41 原句，直接写入根级「审计索引」，原编辑回执完成活动报告节点。模型在该报告节点内回填，最终报告分别保留 125 和 120 美元的主张与来源，实际退款仍待授权。第二会话读取同一项目文档及其规则，私有会话条目和 N-41 双域召回分别为 **0**。记录 **25** 条模型轨迹、**482,417** 个已报告 Token。预算账本包含 **31** 次尝试，已报告共 **487,752** Token，累计预算扣减 **520,485** Token。[真实 IPC 轨迹](../tmp/v2-v134-refund.json)
- 冻结水泵试运转场景使用现用分类器。整理组把同源无关句提议归档，X92 仍判为 `R`，并以完整原句保留在首个主模型请求。原文组与整理组各三轮 **7/7**，最终两条引文通过逐字校验，归档杂项重开后可召回。该结果验证待核对分支在真实任务中能保留异议。原文组一次尝试缺用量，本次成本门槛记为计量不全。[冻结场景回归](../tmp/v2-v134-pump-acceptance.json)
- 同版 Backend 全量 **732/732**、V2 桌面 IPC 全量 **48/48**，均无取消或跳过。[后端全量](../tmp/v2-v134-backend-full.log) · [桌面全量](../tmp/v2-v134-desktop-full.log)

本表将本次回执与统一设计第 10 节的 12 类场景对应。

| 场景 | 本次核验依据 |
| --- | --- |
| 长对话压缩 | Backend 177–183、207、211 核对实际投影、历史组与覆盖边界，清运三轮对照核对长期承接和计量 |
| 压缩失败或版本冲突 | Backend 98、112、151、181–183 核对拒绝、整批原子性和原材料保留 |
| 新 session 延续项目工作 | 桌面 IPC 28 及真实退款第二会话核对项目文档身份、当前会话文档和私有检索范围 |
| A、B 独立原件及混杂噪音 | 清运和冻结水泵的真实对照核对两份逐字引文、不同条件和可召回归档 |
| 归档后再次需要信息 | Backend 242、244，真实退款和冻结水泵核对召回来源、候选、逐字回填或重开召回 |
| 工具或 Skill 按需加载 | Backend 40、41、44、614，桌面 IPC 2、7 核对阶段装配、恢复与拒绝 |
| MCP 断连或返回异常 | Backend 382、393，桌面 IPC 8、21–27 通过真实测试服务验证原操作、表单、取消与未知状态 |
| 请求人类协助并恢复 | 桌面 IPC 16–18 和真实退款核对可见问题、原请求绑定及独立分支持续推进 |
| 等待信号、超时和重启 | Backend 679 与桌面 IPC 4 核对持久记录、匹配信号和原任务恢复 |
| 复杂任务拆解与委派 | Backend 513、514、580，桌面 IPC 13、19、20 和真实退款核对权限、子结果与原结算条件 |
| 模型提前宣布完成 | Backend 618、653 核对未完成前置和被拒动作无法替代真实回执 |
| 压缩后的持续任务 | 清运完整计量、冻结异议及同源训练准入共同核对语义、成本与可训练资源 |

真实模型组合使用本地 V2 桌面 IPC、实际主模型及本地分类器。桌面渲染行为沿用相应渲染验收记录。MCP 测试服务和外部子代理宿主的受控入口各有回归，实际部署环境以及其他提供方有各自的待验证范围。

## 阶段一百一十验证 · 能力目录刷新与桌面恢复

日期 2026-11-21。统一设计 v1.23，MCP 设计 v0.9，子任务设计 v0.4，Runtime draft-1.18。本轮沿用现有整理器和六份运行时提示词。

- MCP 刷新读取分页时收到目录变更，立即撤销旧投影，在原发现期限内丢弃并重读整份目录。真实 stdio 服务的分页用例验证了刷新期间及发布后旧调用均被拒绝，新投影可以调用更新后的 schema。业务错误与非法输出均保留失败收据。[MCP 回归](../tmp/v2-v138-mcp.log)
- 待派发子任务重启后使用原登记的宿主或本地执行器，保留原父任务和工具步骤身份。定向回归覆盖改变宿主配置后仍按原登记恢复，以及整理调用来源记录的持久化。[子任务与来源回归](../tmp/v2-v136-focused.log)
- V2 Electron 工作台生产构建通过。隔离项目下的项目级、会话级文档按树折叠，改名、移位及重排即时更新，切换会话和关闭侧栏保留各自的展开状态。重启后端并重载渲染器后，两级正文、会话文档身份和展开状态正确。[渲染验收](../tmp/v2-v138-context-fold-renderer.log) · [验收截图](../tmp/v2-v138-context-fold-renderer.png)
- Backend 构建和全仓类型检查通过。部署的六份提示词和设计源文件逐份通过 SHA-256 核对。[后端构建](../tmp/v2-v138-build.log) · [类型检查](../tmp/v2-v138-typecheck.log) · [部署清单](../tmp/v2-v138-prompt-manifest.log)
- Backend 全量按两组覆盖 **735** 项。MCP **43/43**，其余 **691/692**。已提交编辑的原件读取用例达到并行测试的 8 秒等待上限，保持同一代码和断言串行复验，相关 **5/5**，该用例正常完成。两组均无跳过或取消。[MCP 定向](../tmp/v2-v138-mcp.log) · [其余后端回归](../tmp/v2-v138-backend-complement.log) · [串行复验](../tmp/v2-v138-settled-file-rerun.log)
- V2 工作台 **94/94**，其中宿主、IPC 和运行可观测性 **48/48**，其余工作台测试 **46/46**。Client SDK **1/1**。[桌面 IPC](../tmp/v2-v138-desktop-full.log) · [工作台其余测试](../tmp/v2-v138-workbench-other.log) · [Client SDK](../tmp/v2-v138-client.log)

本轮本地验收使用实际 V2 Electron 渲染器、Backend、真实 stdio 和 HTTP 测试服务及受控子任务宿主。真实模型组合和长任务用量参考阶段一百零九的退款与冻结异议、阶段一百零八的清运配对。部署环境的远端 MCP 和外部子任务宿主由相应部署验收确认。
