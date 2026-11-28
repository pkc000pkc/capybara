# Electron 页面回归报告（Round93）

日期：2026-11-15

本轮按 `docs/ui-regression-plan-2026-11-15-round93.md` 从 Electron 页面验证默认 timeout、工作区路径边界和失败后的恢复。

## 结果

| 用例 | 结果 | 页面证据 |
|---|---|---|
| T01 默认 timeout 正常命令 | 部分通过 | `run_command` 未显式传 `timeout_ms`，命令成功，`timedOut=false`、`exitCode=0`、stdout 正确；收据没有返回实际生效的默认 timeout 数值。 |
| T02 工作区边界 | 通过 | `read_file` 只调用 1 次，返回 `RUNNER_FAILED`，错误为 `path must stay inside the project workspace`，未访问工作区外文件。 |
| T03 失败后恢复 | 通过 | 边界失败后发送“只回复 OK，不调用工具”，页面显示 `0 次工具调用 · 1 步` 和 `OK`。 |

## T01 实际收据

- 工具：`run_command`。
- `callId=call_00_vbmWf4dpTNto47j5xwzJ2816`。
- `stepId=step-tool-1-0-call_00_vbmWf4dpTNto47j5xwzJ2816`。
- 命令：`node -e "console.log('default-timeout-ok')"`。
- `status=succeeded`、`ok=true`、`exitCode=0`。
- `durationMs=335`、`processDurationMs=101`。
- `timedOut=false` / `timed_out=false`。
- stdout 为 `default-timeout-ok`，stderr 为空。
- 页面明确说明：收据没有 `timeoutMs`、`timeout_ms` 或 `maxTimeout` 字段，无法从本次短命令判断默认 timeout 的数值。

## T02 实际收据

- 工具：`read_file`，参数 `..\\..\\__capybara_outside__.txt`。
- `callId=call_00_sLZTCMbJe79Km3XJfnNs4616`。
- `stepId=step-tool-1-0-call_00_sLZTCMbJe79Km3XJfnNs4616`。
- `error.code=RUNNER_FAILED`。
- `error.message=path must stay inside the project workspace`。
- 收据：`status=failed`、`ok=false`、`durationMs=243`。
- 未返回文件内容，未产生写操作，也没有因为错误继续重试。

## 结论

工作区路径边界已经形成明确、可验证的运行时门禁，失败后的 Runtime 可以继续接受新请求。默认 timeout 的执行行为可以确认“未显式传参时命令正常运行”，但默认值本身没有进入收据，仍不足以完成 timeout 配置可审计验收。
