# Electron 页面回归计划（Round85）

日期：2026-11-15

本轮目标：验证 Round84 修复后的项目产物治理闭环，以及页面对同一产物 ID 的去重表现。

## 用例

| ID | 场景 | 操作 | 预期 |
|---|---|---|---|
| J01 | 产物列表去重 | 打开 qingjian-generated 项目应用的“资料来源”页，查看产物区 | 同一 artifactId 只呈现一张卡片；项目索引状态可见 |
| J02 | 长 ID 接受 | 对一个 `quarantined` research-report 产物点击“接受” | 页面状态栏显示审核成功，卡片状态变为 accepted，不出现 400/414 |
| J03 | 长 ID 复核反馈 | 对一个没有 relativePath 的项目产物点击“复核” | 页面显示 `artifact has no project file path` 等具体原因 |
| J04 | 审核状态持久化 | 切换到 ui-regression-clean-2026-11-14，再切回 qingjian-generated 并重新打开资料来源 | accepted 状态仍保留，其他项目无 qingjian 审核反馈 |

## 通过标准

- J01 产物列表不再因研究结果与项目索引合并而重复膨胀。
- J02 必须证明长结构化 ID 可以通过页面完成审核并写入索引。
- J03 必须显示可解释的验证原因。
- J04 必须证明项目级持久化和切换隔离。
- 页面操作期间不修改代码；完成后写入 `docs/ui-regression-report-2026-11-15-round85.md`。
