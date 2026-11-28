# Electron 页面回归报告（Round83）

日期：2026-11-15  
测试方式：加载修复版 Workbench 构建后，通过页面操作验证；本轮页面操作期间不修改代码。  
对应计划：[ui-regression-plan-2026-11-15-round83.md](./ui-regression-plan-2026-11-15-round83.md)

## 结论

R82-ART-001 的前端反馈显示已生效：项目应用页现在能直接显示带 `role=status` 的治理反馈，不需要打开设置弹窗。

但回归继续暴露出一个更深的兼容缺口：当前 qingjian-generated 的历史研究结果包含研报 Artifact ID，项目 Artifact Index 却没有这些记录。点击复核后页面显示“产物审核失败：Bad Request”，切换项目后也无法恢复治理状态。

## 用例结果

| ID | 场景 | 页面观察 | 结果 |
|---|---|---|---|
| G01 | 复核反馈可见 | 点击第一个研报的“复核”后，项目应用页直接显示状态条“产物审核失败：Bad Request”。反馈已从设置弹窗提升到项目应用滚动区。 | 通过（反馈可见） |
| G02 | 治理结果即时更新 | 操作期间按钮进入忙状态；请求结束后按钮恢复，状态条保留错误提示。由于后端找不到历史 Artifact，卡片状态仍为待复核。 | 未通过 |
| G03 | 治理反馈持久化 | 切换到空项目再切回 qingjian-generated，项目隔离正确，错误状态不会串到空项目；但历史研报仍为待复核，之前的复核操作没有可恢复的治理状态。 | 未通过 |

## 关键证据

- 页面显示：`产物审核失败：Bad Request`。
- qingjian-generated 的 `result.json` 包含 3 个研报 Artifact，但 `.capybara/runtime/artifacts/index.json` 不存在。
- 这些历史 Artifact 的状态为 `quarantined`，但后端 `/api/resources/artifacts/:id/review` 只能更新 Artifact Index 中的记录。
- 切换到 `ui-regression-clean-2026-11-14` 后，应用页恢复为空白应用，错误状态没有串线；切回 qingjian-generated 后研究结果和产物列表恢复。

## 需要修复的问题

**R83-ART-002：历史研究结果没有回填项目 Artifact Index。**

需要在读取项目 Artifact 列表时，对项目 `.capybara/runtime/research/*/result.json` 中尚未进入索引的 Artifact 做一次幂等回填。回填后，复核、接受、拒绝和文件复核都应使用同一条项目级 Artifact 记录。

## 已确认的前端修复

- 复核、接受、拒绝和失败结果会在项目应用滚动区直接显示。
- 审核成功时会显示产物类型和新状态。
- 复核成功时会显示验证原因或当前状态。
- 切换项目时错误状态不会泄漏到其他项目。

