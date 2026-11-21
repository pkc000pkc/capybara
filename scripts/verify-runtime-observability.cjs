// Manual live acceptance: uses the configured system provider; never prints credentials.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntimeManager } = require('../apps/workbench/electron/runtime-v2.cjs');
const { ensureSystemStorage } = require('../apps/workbench/electron/system-storage.cjs');

(async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-live-observe-'));
  fs.mkdirSync(path.join(projectPath, '.capybara'));
  fs.writeFileSync(path.join(projectPath, '.capybara/config.json'), JSON.stringify({ tool_permissions: ['filesystem:read', 'filesystem:write', 'process:execute'], tool_timeout_ms: 15000 }));
  const env = ensureSystemStorage().runtimeEnv;
  const events = [];
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const manager = createRuntimeManager({ env, emit: ({ event }) => {
    events.push(structuredClone(event));
    if (event.type === 'tool.call.started' || event.type === 'tool.call.failed' || event.type === 'tool.call.completed') console.log(JSON.stringify({ type: event.type, tool: event.payload.toolName, durationMs: event.payload.durationMs, error: event.payload.code }));
    if (event.type === 'chat.assistant.completed' || event.type === 'chat.assistant.failed') resolveDone(event);
  } });
  const webContents = {};
  const workspace = { workspaceId: 'live-observability', workspaceName: '可观测性验收', projectPath, webContents };
  const connection = manager.connect(workspace);
  const id = crypto.randomUUID();
  const timer = setTimeout(() => manager.send({ ...connection, webContents, frame: { type: 'run.cancel', sessionId: connection.sessionId } }), 120000);
  try {
    await manager.send({ ...connection, webContents, frame: { id, type: 'chat.message.send', sessionId: connection.sessionId, payload: { clientMessageId: `message:${id}`, content: [{ type: 'text', text: '这是隔离验收。请创建 sort-check.mjs，编写插入排序，对 [9,1,3] 排序并打印 JSON；使用 run_code(runtime=node) 实际运行；再使用 delegate_task 委派只读子代理读取这个脚本、核对算法，并由父代理合并总结。不要修改其他项目文件，不要联网。最终简短报告实际输出和子任务结果。' }] } } });
    const terminal = await done;
    assert.equal(terminal.type, 'chat.assistant.completed', terminal.payload.message);
    const code = events.find((event) => event.type === 'tool.call.completed' && event.payload.toolName === 'run_code');
    assert.ok(code, '没有真实的代码执行结果');
    assert.match(code.payload.result.stdout, /\[1,\s*3,\s*9\]/);
    assert.ok(events.some((event) => event.type === 'runtime.children.updated' && event.payload.items.some((item) => item.status === 'succeeded')));
    const summary = { provider: env.LLM_PROVIDER, model: env.LLM_MODEL, projectPath, sessionId: connection.sessionId, toolCalls: events.filter((event) => event.type === 'tool.call.completed').map((event) => ({ tool: event.payload.toolName, durationMs: event.payload.durationMs })), codeOutput: code.payload.result.stdout.trim(), traceEvents: events.length, result: 'passed' };
    fs.mkdirSync(path.resolve(__dirname, '../tmp'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../tmp/runtime-observability-live.json'), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
  } finally { clearTimeout(timer); await manager.closeAll(); }
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
