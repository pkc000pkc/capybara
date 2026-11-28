# Capybara Workbench 阶段性 Review 与回归报告（2026-11-14 第八轮）

本轮针对第七轮报告中的 P0 工具激活问题完成修复，并重新用桌面页面进行黑盒验证。测试过程中先完成修复和构建，再启动 Electron，通过页面发送真实用户请求；没有用代码级测试替代页面验收。

## 本轮修复

### 系统资源默认回退

对于缺少 tools/skills 配置的旧项目，运行时现在默认使用：

- tools/files/manifest.json
- skills/project-files

资源仍按项目优先、系统用户目录回退解析。系统资源目录位于用户的 .capybara 下，项目可以覆盖同名资源。

### 系统资源路径映射

资源 catalog 原来把系统 Skill 的绝对路径拼接到项目目录，导致 runtime-connect 报 ENOENT。本轮为系统资源使用 @system/... 逻辑路径，并在读取资源文件、计算修订和展示 catalog 时正确映射回系统目录。

### Electron 内运行工具进程

Electron 中的 process.execPath 是 Electron 可执行文件，不能直接作为 Node 工具 runner。本轮工具 runner 和 Skill script runner 在 Electron 环境中改用 Node 可执行文件，保留普通 Node 运行时的原有行为。

### 首次工作请求的基础能力

真实桌面会话的首次工作请求会自动激活 project-files 基础工具集，包含：

- read_file
- list_files
- search_file
- search_in_file
- write_file
- edit_file
- delete_file
- run_code
- run_command

其他工具、Skill 和应用能力仍通过 catalog、搜索和加载机制按需进入上下文。权限仍由 ToolDispatcher 校验。

## 页面验证结果

### 1. 文件读取

在新会话中发送：

“请读取项目根目录，列出文件并告诉我结果，不要修改任何文件。”

页面实际显示：

- 模型阶段完成。
- 工具 list_files 被调用。
- 工具耗时 385 ms，状态为已完成。
- 工具结果回传模型。
- 最终回复列出根目录 21 个条目，并说明未修改文件。
- 页面显示“执行过程和依据已保存”。

该场景通过。

### 2. 写文件、执行 Python、回读验证

在同一桌面会话中发送：

“请在项目的 tmp 目录创建 capybara-ui-smoke.py，写入一个打印 42 的最小 Python 程序；运行它，读取文件确认内容，并告诉我输出。只操作这个测试文件。”

页面实际显示 5 次工具调用、11 步运行轨迹，其中包括：

- run_command：确认并创建测试目录。
- write_file：写入 print(42)。
- Python 执行：exit_code=0，stdout=42，stderr 为空，未超时。
- read_file：重新读取文件，内容与写入一致。
- 最终回复：输出 42，并列出操作与证据。

测试文件已在验证完成后清理。

该场景通过，H04 从失败提升为通过。

### 3. runtime-connect 和页面稳定性

修复后重新使用标准命令启动：

npm run desktop:start --workspace=apps/workbench

验证结果：

- Electron 窗口正常打开。
- runtime-connect 不再报系统 Skill 路径 ENOENT。
- 新会话可创建、发送和完成。
- 项目应用页签仍稳定为“总览 / 内容与数据 / 资料来源”。
- 工具调用、结果回传、最终回复在页面可见。

### 4. 构建

以下构建通过：

npm run desktop:build --workspace=apps/workbench

结果：

- backend TypeScript build 通过。
- Next.js webpack 编译通过。
- TypeScript 检查通过。
- 静态页面生成通过。
- git diff --check 无新增空白错误。

## 当前状态更新

### 已通过或明显改善

- H04：文件写入、Python 执行和回读验证已通过。
- D05：读取文件类请求能显示模型、工具、结果和最终回复。
- E03：工具名、调用 ID、状态、耗时和结果摘要可见。
- E05：运行阶段和工具进程状态可见。
- G05/G08：系统资源回退链路可以建立，普通会话能实际使用系统文件工具。
- runtime-connect：系统 Skill 资源路径问题已修复。

### 仍未闭合的缺口

#### P0：浏览器调研和上下文预算

H01 仍未重新完成长流程验证。此前浏览器调研存在 404、重复读取和上下文超限，需要继续处理候选结果压缩、重复读取去重和证据摘要。

#### P1：应用实例状态

H05 仍有两个问题：

- 市场研究发布实例与右侧项目应用面板可能不是同一个 instanceId。
- 停止后重启可能进入“需恢复”，健康 PID 与界面状态不一致。

#### P1：研报产物治理

H02 的研报文件已经有来源、时间、哈希和 evidence，但仍处于 quarantined，缺少完整性和语义可用性的最终确认。

#### P2：控制面完整度

部分原生菜单仍是占位入口，项目关闭恢复、完整的候选/证据面板、Skill 安装后的重新运行效果还需要继续覆盖。

## 阶段结论

本轮解决了“系统工具存在但 Electron 普通会话无法实际使用”的核心阻塞。当前工作台已经能够通过页面完成：

用户指令 → 模型请求 → 文件工具调用 → 工具结果 → Python 执行 → 回读验证 → 最终回复 → 可回放运行轨迹

因此，文件和代码工作链路已经进入可验收状态。整体项目仍不能标记为全部验收通过，下一阶段应优先继续 H01 浏览器调研和 H05 应用实例状态闭环。

