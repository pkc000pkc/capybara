# UI 回归报告（2026-11-14 · Round 12）

## 测试目的

验证 Round 11 暴露的看板生命周期问题修复后，项目重启、会话恢复和内嵌应用打开是否形成闭环。

## 修复内容

- 市场研究发布时，将生成的 HTML 看板写入项目 `.capybara/runtime/research/<run>/dashboard/market-dashboard/v1/index.html`。
- 研究结果保留可持久化看板地址。
- Electron 打开历史 `127.0.0.1` 看板地址时，会按当前项目查找最新的持久化看板文件。
- 浏览器宿主允许受限的本地 `file://` 页面，同时继续限制远程页面。

## 页面回归

### 1. 标准启动：通过

使用 `npm run desktop:start --workspace=apps/workbench` 启动，项目 `capybara` 和历史会话正常恢复。

### 2. 研究结果恢复：通过

应用面板恢复显示 `000682 行情看板`、`v1 · 已发布`、五个已完成研究步骤、建议立场、指标、来源与证据、产物与版本。

### 3. 重启后打开历史看板：通过

点击“打开应用”后，内嵌浏览器加载项目运行目录中的本地 HTML 看板，AX 页面地址为：

`file:///D:/gitlocals/kanli8-human/capybara-github/capybara/tmp/coding-acceptance/capybara/.capybara/runtime/research/market-research_93a66152-366c-4e9e-8725-43dcd1bee290/dashboard/market-dashboard/v1/index.html`

页面可见并可验证：

- `000682 行情看板`；
- 最近 30 个交易日；
- `bar_count=21`、`report_count=3`；
- 区间收益 `-6.19%`；
- 年化波动率 `39.24%`；
- `negative` 交易建议及风险/不确定性；
- 21 条日线数据和 3 份研报链接。

### 4. 运行反馈：通过

工作区出现“已在 Capybara 内嵌浏览器中打开 000682 行情看板”，未再出现 `ERR_CONNECTION_REFUSED` 或空白页面。

## 本轮结论

Round 11 的 P1 已修复。研究结果、项目会话、持久化看板和 Electron 内嵌浏览器现在可以跨桌面进程重启恢复。

仍需在后续完整回归中继续覆盖：项目关闭/重新打开、无效项目清理、真实子智能体运行、工具超时/失败路径，以及全部菜单项的最终语义实现。
