# 模型可用性与 OpenAI Harness 接入边界

日期：2026-11-16

## 1. 当前模型检查结论

本次检查不涉及前端施工，只验证本地训练环境、已有模型和 OpenAI API 使用边界。

结论是：当前还没有可以直接承担 V2 上下文整理任务的本地模型。

| 资源 | 检查结果 | 判断 |
| --- | --- | --- |
| `llm-train/models/baseline_v1/best.pt` | 可以加载并在 CPU 上完成测试集推理 | V1 工具事件/数据跨度抽取模型，任务不匹配 |
| `capybara-llm/artifacts/smoke-lora` | 可以加载，但基于 `sshleifer/tiny-gpt2`，生成重复的 `stairs` | 仅证明 LoRA 烟测链路可运行 |
| `Qwen/Qwen2.5-0.5B-Instruct` | 本机没有缓存模型权重 | 不能开始正式 V2 训练或推理 |
| `capybara-llm/.venv` | Python 3.12，`torch 2.15.0+cpu` | 当前环境不能使用 RTX 3060 CUDA |
| 系统 GPU | RTX 3060 Laptop GPU，6 GiB | 硬件存在，但 Python 环境没有 CUDA Torch |

V1 检查结果：

```text
checkpoint loaded: true
device: cpu
parameter count: 529,452
test records: 100
event selection F1: 0.9327
relation macro-F1: 0.7344
conflict F1: 1.0000
```

这些指标只说明 V1 的合成工具事件抽取模型仍可复现，不代表它能完成 V2 的上下文整理、Session diff、归档、召回或冲突保留。

V2 原型检查结果：

- 数据结构验证：100/100 通过；
- 数据切分：train 80、validation 10、test 10；
- LoRA 训练脚本 dry-run：通过；
- smoke adapter 推理：可以加载，但输出不可作为结构化上下文结果；
- 当前目标模型尚未下载到本地；
- 当前 Python 环境的 Torch 是 CPU 版本。

`gpt-6-luna` 的历史探针曾得到 10/10 的约束结构化输出，但本次重新探测时 10 条请求均返回 HTTP 429。该结果表示当前 API 请求受到限流或配额限制，不能据此判断模型结构化能力失效。

### 1.1 2026-11-16 API 实时验证

使用本机 `key.txt` 中的 API key 进行只读检查，未记录或输出密钥内容：

```text
GET /v1/models
model count: 96
gpt-6-luna: listed
gpt-5.6-luna: listed

POST /v1/responses with gpt-6-luna
plain text probe: OK
JSON Schema probe: passed
structured decision: no_op
```

这证明当前 API key、API organization、模型访问和结构化输出链路均可用。它不代表本地 V2 小模型已经准备好；本地训练环境和 V2 基座模型状态仍按本文第 1 节记录。

## 2. V2 模型边界

V1 基线模型的任务是：

```text
Agent 事件序列
  → 相关工具事件
  → 数据跨度
  → 关系和冲突分类
```

V2 需要的模型任务是：

```text
project_context + session context + cache + messages
  → 信息单元
  → 候选状态
  → Session 语义 diff
  → 归档 / 召回 / 拒绝 / 冲突保留
```

因此，V1 `best.pt` 可以保留为信息抽取基线或辅助数据处理器，但不能直接作为 V2 上下文整理模型。

## 3. Pro 会员、API 和其他 Harness

需要区分三种不同的凭据和额度：

1. ChatGPT Pro 账户内的产品使用额度；
2. OpenAI API 组织中的 API credits 和 API key；
3. ChatGPT 登录或 Codex 登录产生的会话凭据。

它们不能互相替代。

### 3.1 是否可以把 Pro 使用额度接入自己的 Harness

OpenAI 当前提供两条不同路径：

**API 路径：可以用于自己的服务。**

官方说明显示，符合条件的付费 ChatGPT Pro 计划可以领取与一个 API organization 绑定的 API credits，用于通过 OpenAI API 构建应用和 Agent。当前说明列出的资格包括 Pro 100、Pro 200 和 Pro 500，付费订阅通常需要激活满 7 天，且需要完成激活和组织绑定。ChatGPT 和 API 仍然是独立的计费系统。

这条路径适合 Capybara 自己的 Backend 或本地 Harness：

```text
ChatGPT Pro
  → 领取或购买 API credits
  → 绑定 API organization
  → 创建 Project API key 或 service account key
  → Capybara Backend 调用 OpenAI API
```

这里接入的是 API key 或 service account credential，不是 ChatGPT 登录 token。

**Partner App 路径：只有参与官方机制的应用可以使用。**

OpenAI 也支持部分参与的第三方应用通过 “Sign in with ChatGPT” 请求用户授权使用 ChatGPT 计划额度。这个机制要求应用参与官方授权流程，用户在登录后单独同意计划额度共享，并受应用级限制控制。它不是把一个通用 token 导出给任意 Harness，也不是自建服务拿到 ChatGPT API key。

因此，Capybara 如果只是自己的本地服务，应优先使用 API 路径；不能把它当成任意 Partner App 直接复用 ChatGPT Pro 会话额度。

### 3.2 不能采用的方式

以下方式不应接入 Capybara：

- 读取或复用 ChatGPT 网页 Cookie、session token、Codex 内部 token；
- 把个人 ChatGPT 登录凭据写入 Harness；
- 将个人用户 API key 固定写入桌面前端、浏览器代码、源码、日志或发布包；
- 把 API key 转交给其他用户或作为服务共享凭据；
- 通过重试、代理或多账号方式规避 API rate limit。

OpenAI Services Agreement 允许使用 API 集成 Customer Application，但同时禁止共享账户登录凭据、买卖或转移 API keys，以及绕过 rate limits 和使用限制。

### 3.3 Capybara 推荐的接入方式

对于本地 V2 桌面应用：

```text
Workbench 前端
  → 本地 Backend
  → Windows 用户环境变量 / 系统密钥存储
  → OpenAI API
```

开发测试可以使用个人 Project API key。若以后变成常驻服务、CI 或多人使用的服务，应改为独立 Project 的 service account，并设置最小权限、密钥过期时间、轮换和撤销机制。

API key 不应进入前端。前端只调用 Capybara Backend，由 Backend 负责模型请求、限额和错误处理。

### 3.4 额度申请流程

申请前确认：

- 使用符合条件的付费 Pro 计划；
- 订阅已经激活至少 7 天；
- ChatGPT 账户和 API Platform 使用同一个邮箱；
- 当前账户是 ChatGPT Pro 订阅所有者，也是目标 API organization 的 owner；
- 一个 Pro 订阅只能绑定一个 API organization，绑定前需要确认组织选择。

在 ChatGPT 中申请：

1. 登录拥有 Pro 订阅的 ChatGPT 账户。
2. 打开 `Settings → Billing`。
3. 找到 `API credits benefit`，启动领取流程。
4. 选择接收额度的 API organization。
5. 确认激活。
6. 打开 API Platform 的 Billing 页面，确认额度和 Credit grants。

也可以从 API Platform 申请：

1. 使用同一邮箱登录 `platform.openai.com`。
2. 选择自己拥有的 API organization。
3. 打开 `Billing`，找到 API credits benefit。
4. 选择自己拥有的 Pro 订阅。
5. 审核并确认激活。
6. 回到 API Billing 页面确认到账。

额度只属于绑定的 API organization，可用于 API 请求和 Playground；月度额度在订阅计费周期结束时过期，不自动结转。额度余额不等于没有速率限制或模型限制。

如果 Billing 页面没有 API credits benefit，常见原因是计划不符合条件、订阅还未满 7 天、账户不是订阅或 API organization owner、邮箱不一致、组织已经绑定，或者该账户尚未开放该权益。不要通过重复领取或绕过限制处理，应检查账户和组织状态后联系 OpenAI Support。

## 4. 当前决策

目前不把任何训练能力放进前端，也不把 ChatGPT Pro 登录 token 接入自己的 Harness。

后续模型验证需要先满足：

1. 准备 V2 目标基座模型的本地权重；
2. 在 Python 3.12 虚拟环境中安装 CUDA 版本 Torch；
3. 用真实上下文治理样本验证结构化输出，而不是只验证 tiny-gpt2 烟测；
4. 将 API 生成语料和本地小模型训练分开计量；
5. 使用 API key 或 service account 连接自己的 Backend，不使用 ChatGPT 会话 token。

## 5. 官方依据

- [API credits benefit for eligible ChatGPT subscriptions](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)
- [Managing billing for ChatGPT and the API platform](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)
- [API keys and service accounts](https://developers.openai.com/api/docs/guides/api-keys)
- [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)

## 6. 2026-11-16 实际验证记录

Gaia2 已改为从 `D:/gitlocals/kanli8-human/key.txt` 读取首个非空行作为 API key，公开配置只保留 endpoint 和模型名，密钥未写入报告、manifest 或日志。

- `GET /v1/models`：HTTP 200，列表包含 `gpt-6-luna`。
- `gpt-6-luna` Responses 纯文本探针：通过。
- `gpt-6-luna` JSON Schema 探针：通过。
- Gaia2 Actor 工具探针与 ARE Judge 探针：均通过。
- 五能力真实模型 transport smoke：五个请求均 HTTP 200。
- 模型健康检查对 GPT-6 使用 `max_completion_tokens`，并省略 reasoning 模型不支持的 `temperature=0`。

Gaia2 Actor 使用 Responses 适配，并把结果归一化为现有 `tool_calls` 结构。2026-11-17 已移除旧代码的静默 Chat / reasoning=none 回退：Responses 失败必须保留真实异常，不得降级后继续宣称高推理实验成功。Judge 仍使用现有 chat 兼容通道。

正式 Gaia2 运行还验证了长任务的 Hook Host 收尾：模型请求、工具执行、官方判定和 Host 关闭证据分别记录；收到认证关闭请求且子进程已退出、无终止错误时，生命周期记录 `controlledTeardownObserved`，业务评分与进程收尾不再混为技术失败。

在 `reasoning_effort=none` 的旧 transport 下，首个 100 题批次的前 10 个任务均完成可靠评分但 score 为 0；该批次随后停止以调整通用推理 transport，未将技术失败伪装成成功。切换 Responses 适配后，Actor/Judge 探针已重新通过；正式批次需要以新冻结 manifest 重新开始，不能复用旧批次结果。

## 7. 2026-11-16 最新 Gaia2 复核

更正（2026-11-17）：本节早期标记为 high / xhigh 的真实任务存在 SDK 参数错误与静默降级，因此标签不代表实际请求的推理档位。相关结果仅保留为历史诊断，不能据此认定模型的高推理模式规划能力不足。

最新只读模型列表检查仍返回 HTTP 200，共 96 个模型，其中包含 `gpt-6-luna` 和 `gpt-5.6-luna`。`gpt-6-luna` 的纯文本 Responses、JSON Schema、Actor 工具调用和 Judge 调用均通过，说明 key、模型访问、Responses 适配、结构化输出和 Hook 证据链可以工作。

在真实 Gaia2 任务上，使用全新冻结 manifest、官方 ARE 评分、单并发和无题目特例进行了对照：

- `high`：单题正常完成并得到官方评分，`technical=0`，但 `score=0`；模型常在读取联系人、犯罪率和房源后提前结束，或没有闭合所有写入义务。
- `xhigh`：部分任务能执行保存和邮件写入，但会在读取/写入之间长时间循环，达到 300 次模型请求后出现 `official_evaluation_incomplete`，因此不纳入业务分数。
- 追加的通用反重复账本提示可以让单题按正常生命周期结束，但没有把复杂任务的业务分数提升到非零。

这些历史结果尚未达到“在完整 100 题批次中稳定产生至少 10 个成功分数”的任务能力门槛。由于存在传输层缺陷，不能将失败全部归因于模型规划能力；需要修复传输、核验实际推理用量后重新测量。

## 8. 运行时控制层改造复核

在获得系统层改动授权后，Gaia2 桥接层加入了三项通用控制：

1. 多步骤任务在第一次写入或最终回复前，必须先提交绑定当前 USER 消息的 `capybara_task_reconcile` 计划；未提交或仍为 advisory 的计划会被运行时阻断。
2. 含有写入/最终回复的并行工具批次，在计划通过前会在调度器启动前整体拒绝，避免半批次执行和调度器状态损坏。
3. 同一资源代际内相同参数的成功读取达到重复阈值后，运行时返回 `repeated_read_no_progress`，要求模型推进分页、切换未解决义务或报告阻塞；成功写入后开启新的资源代际。

这些改造通过 40 个 Hook、证据、任务协调和时间收据测试，Phase 1 Actor/Judge 探针也通过。新的 10 题试跑中，前 9 题均正常官方评分、无技术错误，但仍全部为 0 分；第 10 题进入长读取循环后按安全策略停止。改造解决了“无计划直接写入”和“并行批次导致运行时失败”，但尚未解决模型对复杂任务义务的正确识别与收敛。

### 8.1 独立规划轮与阶段工具投影

随后又完成了独立规划轮和阶段工具投影：完整 Actor Registry 继续作为能力与证据权威，模型请求只接收当前阶段的 provider projection。首轮为规划阶段，只暴露 `capybara_task_reconcile` 和紧凑工具身份目录；enforce 计划通过后，投影切换到计划声明的工具及运行时控制工具，并记录 provider schema hash、projection revision 和工具身份列表。成功写入后资源代际和投影 revision 递增。

早期单题记录了工具集合从 1 个切换到 12 个，但不足以证明推理档位与投影执行边界正确。后续补充了分发前的投影检查、阶段效果过滤、计划提交收据检查、新 USER 请求重新规划，以及投影 schema 指纹与执行事件绑定。

## 9. Responses 传输修复与验证更正（2026-11-17）

旧桥接层将 HTTP 门禁注入的 `client` 再作为请求字段传给 SDK 的 `client.responses.create()`，SDK 抛出 TypeError 后被宽泛异常处理吞掉，回退到 reasoning=none。另一个配置问题是正式启动器清理继承的 GAIA2 环境变量，因此仅在 shell 中设置 xhigh 不能保证进入正式子进程。

修复后，client 仅作为调用接收者；Responses 不再静默降级，HTTP 门禁绑定 `/v1/responses`。`high` 与 16384 输出预算写入冻结 runtime 配置并显式传递。实际 SDK 与 MockTransport 回归先复现旧缺陷，再验证修复；真实运行返回 reasoning tokens 273、124、594、0、233，证明服务端实际执行了带推理用量的请求。单轮允许出现 0 个 reasoning tokens，不将其自动判为降级。

对应真实诊断运行 `full-library-once-20261117T011503343Z-cf52ce0b`：5 次 Actor 请求，投影从 1 个切换到 13 个工具；Hook 的编译阶段发生 200ms VM 超时，最终是技术错误、无有效业务评分。它不能被计为成功或业务零分。编译预算与 Hook 执行预算已分离：编译至少 1000ms、上限 5000ms；小 Hook 执行仍为 200ms，外部截止时间继续生效。

施工后单题验证 `full-library-once-20261117T013450378Z-54829a17`：11 次 Actor 请求，累计 4959 reasoning tokens，阶段实际经历 planning → evidence → finish；官方评分完成，technical=0、score=0、scoreReliability=official_oracle，冻结源校验通过。51 个桥接测试、29 个证据/配置/SDK 测试及 2 个 Hook Host 针对性测试通过，四阶段读写投影与分发阻断在受控场景中通过验证。

本轮未完成题目的业务操作。模型给出的 maxCalls 多次超过协议上限 64，缩小计划后遗漏了其余工具，最终转入完成阶段回复。当前仍需改善带字段位置的协议修复反馈，以及重新规划时完整能力目录的可发现性；不能把门禁与评分链路可运行等同于解题能力达标。

## 10. 真实 Hook 提交协议更正

后续追踪 `full-library-once-20261117T015026457Z-b963d758` 的原始 Host 收据发现，桥接层控制结果的封装层级与 Hook 不一致，且把未填写的可选字段写成 null。Hook 未接受计划，桥接层却仅凭 after_tool allow 报告提交成功。该批次在首题停止，保留 1 次技术失败，没有业务分数。因此此前的规划循环仍不能全部归因于模型能力。

当前已统一 `outcome.result.taskReconciliation`，未填可选字段保持缺省，新增 `declarationAccepted` 语义提交回执。Host 拒绝计划时不改变投影，advisory 不替换已有 enforce 计划；离线证据校验也要求真实语义提交回执。完成门禁可以由当前候选回复满足其自身单次回复义务，仍阻断其他未完成业务动作、未知写入结果及参数不匹配。

54 个桥接测试和 70 个 Hook/证据测试通过；新增真实 Bridge + 真实 Host 的 8 轮联调通过，验证四阶段流转、真实计划提交、读取/写入收据及最终回复门禁。联调使用受控 Actor，不计作模型成绩。新冻结批次为 `full-library-once-20261117T022540101Z-0ee97e53`，最多 100 次执行，10 个不同 scenarioId 的可靠非零分数后自动停止；实际结果待评分后追加。

该诊断批次首题的实际保存/移除操作已执行，但后续出现长期规划循环，已停止并保留技术终止记录。进一步补充了资源键/effect 与注册表的绑定校验，以及连续 8 次无原生执行进展的规划循环上限。命中上限时，推理以未完成状态结束，由官方判定真实部分状态；不伪造回复、写入或成功，也不改写官方分数。未知写入、待消费 A2A 结果和活动等待窗口保持原安全边界。

当前验证：55 个桥接测试、41 个批次/证据测试通过，真实 Host 两项联调分别证明正常四阶段计划可完成、纯规划循环可停止且判定失败。当前冻结运行 `full-library-once-20261117T025911203Z-c5eb3b30` 已启动，仍使用 gpt-6-luna/high、最多 100 次执行、10 个不同题目可靠成功后停止；尚未取得最终批次结果。


## 11. 连接故障复核与验证范围（2026-11-17）

批次 `full-library-once-20261117T025911203Z-c5eb3b30` 已记录 14 个 API 连接故障，均无有效官方评分；第 15 题运行及监督进程已不存在，已另存 interruption-observation.json，原 progress 保留。不能把这些执行计为业务零分或成功，也不能继续把该进程描述为运行中。

实际 Actor/ARE Judge 边界连接探针均已通过；按 Responses 协议、high 推理档位进行的连续两次生成健康检查也已通过。健康检查新增 completed 与实际文本校验；运行器新增连续三次原生 ModelRequestFailure 后停止派发的保护。相关 22 项离线测试通过。上述探针不执行 Gaia2 业务、不能计入十题成功目标。

范围核查明确：独立规划轮与四阶段工具投影目前在 Gaia2 Bridge + 独立 RuntimePluginHost 上施工，尚不能据此宣称主仓库 V2 RuntimeLoop 或桌面工作台完成接入。V2 本体仍需计划状态、模型请求与工具分发双侧投影校验及对应真实集成验证。
