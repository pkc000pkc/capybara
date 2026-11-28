const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRuntimeManager } = require('../apps/workbench/electron/runtime-v2.cjs');
const { ensureSystemStorage } = require('../apps/workbench/electron/system-storage.cjs');

const prompt = `请从空目录独立开发一个可运行的本地“清笺”笔记管理应用，并真实测试。
技术栈：前端 React + TypeScript + Vite；后端 Node.js TypeScript + node:sqlite，HTTP REST，不使用 WebSocket。Node 版本 22.20，Windows cmd；不要使用 bash 语法。可安装 npm 依赖。不要替换成只有前端的演示。
功能与验收：
1. GET /api/notes 支持 q 搜索，POST /api/notes 创建，PATCH /api/notes/:id 更新，DELETE /api/notes/:id 删除。记录有 id、title、body、updatedAt。title 不能为空；未知 id 返回 404，非法输入 400；数据必须在 SQLite 持久化，重启仍保留。
2. 前端在浏览器中提供中文笔记列表、搜索、空状态、创建、编辑、删除（先确认）、取消编辑、保存中/失败反馈。每个输入有明确 label，按钮有可理解的名称，键盘可操作。视觉用克制的青绿色、米白背景、清晰层次和留白，适应 900px 和 1440px 宽度。
3. npm run build 成功，npm test 使用实际临时数据库验证 CRUD、非法输入、404、搜索和持久化；有 typecheck 命令。不要只有 mock 测试。
4. npm start 从 127.0.0.1 的 PORT（默认4317）启动后端，并服务构建后的前端；数据库路径支持 DATA_DIR 或 DB_PATH 环境变量，以便隔离验收。写 README 启动说明。
5. 完成后不要留下长期运行的服务；由验收器启动它。长命令（尤其 npm install 和测试）给 run_command 的 timeout_ms 设为120000。工具失败时定位并修复，禁止凭预期输出声称通过。
请先简短说明工作计划，再创建必要文件、安装依赖、执行构建和测试，根据真实输出修复，最后报告文件入口和验收结果。工作只限当前项目。`;

async function runCapybara() {
  const root = path.resolve(__dirname, '../tmp/coding-acceptance/capybara');
  fs.mkdirSync(path.join(root, '.capybara'), { recursive: true });
  fs.writeFileSync(path.join(root, '.capybara/config.json'), JSON.stringify({ max_tool_rounds: 48, tool_timeout_ms: 150000, llm: { max_output_tokens: 8192 }, tool_permissions: ['filesystem:read','filesystem:write','process:execute'] }, null, 2));
  fs.writeFileSync(path.join(root, '.capybara/acceptance-prompt.txt'), prompt);
  const events = [];
  let finish;
  const terminal = new Promise((resolve) => { finish = resolve; });
  const manager = createRuntimeManager({ env: ensureSystemStorage().runtimeEnv, emit: ({ event }) => {
    events.push(event);
    if (event.type.startsWith('tool.call.')) console.log(JSON.stringify({ type: event.type, name: event.payload.toolName, callId: event.payload.callId, durationMs: event.payload.durationMs, error: event.payload.message }));
    if (event.type === 'chat.assistant.completed' || event.type === 'chat.assistant.failed') finish(event);
  } });
  const webContents = {};
  const connection = manager.connect({ workspaceId: 'coding:capybara', workspaceName: '清笺编程验收', projectPath: root, webContents });
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  const timer = setTimeout(() => { void manager.send({ ...connection, webContents, frame: { type: 'run.cancel', sessionId: connection.sessionId } }); }, 900000);
  try {
    await manager.send({ ...connection, webContents, frame: { id, type: 'chat.message.send', sessionId: connection.sessionId, payload: { clientMessageId: `message:${id}`, content: [{ type: 'text', text: prompt }] } } });
    const result = await terminal;
    const summary = { engine: 'capybara', projectPath: root, sessionId: connection.sessionId, durationMs: Date.now() - startedAt, terminal: result.type, tools: events.filter((event) => event.type === 'tool.call.completed').length, failures: events.filter((event) => event.type === 'tool.call.failed').map((event) => event.payload), reply: events.filter((event) => event.type === 'chat.assistant.delta' && event.payload.channel === 'final').map((event) => event.payload.delta).join('') };
    fs.writeFileSync(path.join(root, '.capybara/generation-result.json'), JSON.stringify(summary,null,2));
    console.log(JSON.stringify(summary,null,2));
    if (result.type !== 'chat.assistant.completed') process.exitCode = 1;
  } finally { clearTimeout(timer); await manager.closeAll(); }
}
if (require.main === module) runCapybara().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { prompt };
