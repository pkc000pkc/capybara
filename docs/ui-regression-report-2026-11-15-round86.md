# Electron 页面回归报告（Round86）

日期：2026-11-15

本轮验证产物治理按钮的可访问定位、审核反馈和跨项目恢复。

## 结果

| ID | 结果 | 证据 |
|---|---|---|
| K01 | 通过 | 无障碍树中的每个操作都带有唯一名称，例如 `复核产物 <artifactId>`、`接受产物 <artifactId>`、`拒绝产物 <artifactId>`；同名按钮已可区分。 |
| K02 | 未完成 | 页面无障碍树已能定位目标按钮，但 Electron 原生控制层仍报告 `element has no cached bounds`，无法用元素索引直接触发“复核”；本轮未把具体无文件原因作为页面证据。 |
| K03 | 通过 | 页面操作后显示 `产物审核：research-report 已接受。`，对应卡片状态变为 `accepted`。 |
| K04 | 通过 | 切换到空项目后无 qingjian 反馈；切回 qingjian-generated 后，accepted 状态和项目应用内容恢复。 |

## 修复确认

- 产物操作按钮已增加 `aria-label`，包含完整 artifactId。
- 产物操作按钮已增加 `data-artifact-action` 和 `data-artifact-id`，为后续自动化和诊断提供稳定定位。
- Workbench build 和按顺序执行的 typecheck 均通过。

## 仍需关注

K02 暴露的是 Electron/CUA 原生 bounds 缓存问题，而不是按钮语义缺失。产品功能已具备，页面自动回归仍需要稳定的原生命中方式，或在 Workbench 增加专门的可视化审核抽屉/详情入口，降低窄侧栏中对坐标的依赖。
