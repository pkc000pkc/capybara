# UI 黑盒回归报告（Round 43）

日期：2026-11-14  
范围：项目级/系统级工具、Skill、插件资源治理与项目隔离

## 结果

本轮 5 个用例中，3 个通过，2 个部分通过。测试通过 Electron 页面操作完成。

| 编号 | 场景 | 结果 | 页面证据 |
| --- | --- | --- | --- |
| R43-01 | `qingjian-generated` 设置中的资源目录 | 部分通过 | 能看到资源类型、路径和 revision；但没有明确显示项目级/系统级来源标签，`@system` 与项目相对路径需要用户自行推断 |
| R43-02 | 预览并安装有效 Skill | 通过 | `openai/skills` 的 `openai-docs` 预览显示完整 commit `49f948faa9258a0c61caceaf225e179651397431`，安装后目录出现 `openai-docs · skill`，revision 更新，000682 研究状态保持 |
| R43-03 | 提交不存在的插件目录 | 部分通过 | 页面显示具体错误 `plugin source directory was not found: plugins/does-not-exist`，没有误报安装成功；错误仍带有 `Error invoking remote method 'capybara:project-api'` 的底层 IPC 包装 |
| R43-04 | 空项目资源目录 | 通过 | 空项目显示 `project-files · tool · tools/files/manifest.json` 和系统 harness，不显示 `qingjian-generated` 安装的 `openai-docs` |
| R43-05 | 切回 `qingjian-generated` | 通过 | `openai-docs` 仍在原项目资源目录，000682 研究应用、会话、来源和产物继续可见，未出现空项目资源串入 |

## 发现的缺口

1. 资源治理页面没有把 `project`、`system fallback`、`override`、`effective` 明确展示出来。当前用户需要通过路径形式推断来源，无法直接确认生效项和被隐藏项。
2. 项目资源错误已经比 Round39 的纯 `fetch failed` 更具体，但错误仍把 Electron remote method 名称暴露给用户，缺少稳定的 `resourceType / source / path / reason / recovery` 结构化表达。
3. 有效 Skill 安装已验证，插件有效安装、依赖复用/冲突和同名覆盖仍没有正向页面证据。

## 结论

项目与系统资源的隔离边界实际有效，Skill 安装链路可用，但资源治理还不能作为产品验收通过条件。下一轮应优先补来源/生效关系展示和资源级错误映射，再验证插件依赖与同名覆盖。

