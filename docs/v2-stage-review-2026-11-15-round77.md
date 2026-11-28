# V2 阶段性工作 Review（Round77）

日期：2026-11-15

## 本轮完成

Browser Gateway 的运行期间状态已经纳入现有 `RuntimeLoopState`，沿用项目 `.capybara/sessions.sqlite` 的压缩快照保存，不新增平行存储。

持久化内容包括：

- Browser Profile
- Browser Session
- Browser Tab
- PageState
- Browser Action
- Browser Receipt
- Browser Evidence
- Browser Artifact
- Product Work Ledger Action/Receipt/Run Event/Checkpoint
- Runtime 到 Browser Session 的 context 映射和序号

恢复时会重新建立 Browser Gateway 内存索引以及 Runtime 的 browser context 映射。已有会话重开后，工具 Trace、治理记录、项目应用和浏览器入口仍然可用。

## 验证结果

| 检查项 | 结果 |
|---|---|
| Backend 类型检查 | 通过 |
| Backend 构建 | 通过 |
| Backend 全量回归 | 347/347 |
| Browser Gateway 定向测试 | 7/7 |
| Runtime state 定向测试 | 9/9 |
| Electron 页面回归 | Round77：5/5 |

新增测试覆盖：

- Browser Gateway 快照恢复 Session、PageState、Receipt、Evidence、Artifact 和 Ledger；
- Runtime state 输出 Browser Gateway persistence envelope；
- 重启后页面恢复历史工具结果、证据治理和项目应用状态。

## 当前阶段判断

> **V2 Runtime 的可运行、可观测、可回放闭环已经包含浏览器动作状态的持久化；产品化验收仍需补齐异常路径和下载产物索引。**

仍需继续施工的部分：

1. 下载文件需要进入项目级 Artifact 索引、资料来源页和人工接受/拒绝流程。
2. 需要页面回归浏览器超时、失败、崩溃、断线、下载失败和未知状态。
3. `assert` 脚本仍需表达式长度、执行时间和 DOM 访问范围门禁。
4. Browser Profile 的 origin 策略仍需从固定列表提升为可审计配置。
5. 旧 WebSocket 兼容层仍需明确退出边界。

