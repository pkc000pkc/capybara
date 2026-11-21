const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const test = require('node:test');
const { createRuntimeManager } = require('../electron/runtime-v2.cjs');

const json = (value) => ({ ok: true, status: 200, async text() { return JSON.stringify(value); } });
const textResult = (text) => json({ choices: [{ message: { content: text } }] });
const toolResult = (name, args, id = 'call:1') => json({ choices: [{ message: { tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] });
function project(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-observe-'));
  fs.mkdirSync(path.join(root, '.capybara'));
  fs.mkdirSync(path.join(root, 'tools', 'files'), { recursive: true });
  for (const file of ['manifest.json', 'runner.mjs']) fs.copyFileSync(path.resolve(__dirname, '../../backend/templates/project/tools/files', file), path.join(root, 'tools', 'files', file));
  fs.writeFileSync(path.join(root, '.capybara', 'config.json'), JSON.stringify(config));
  return root;
}
function frame(sessionId, id = crypto.randomUUID()) {
  return { version: 1, kind: 'command', id, type: 'chat.message.send', sessionId, payload: { clientMessageId: `message:${id}`, content: [{ type: 'text', text: '验收测试' }] } };
}
async function until(events, predicate) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const result = events.find(predicate);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Missing event; received ${events.map((event) => event.type).join(', ')}`);
}
function setup(t, root, fetchImpl, env = {}) {
  const events = [];
  const manager = createRuntimeManager({ env: { LLM_MODEL: 'test-model', LLM_API_KEY: 'test-only', ...env }, fetchImpl, emit: ({ event }) => events.push(structuredClone(event)) });
  const webContents = {};
  const connection = manager.connect({ workspaceId: 'project:test', workspaceName: '验收项目', projectPath: root, webContents });
  t.after(() => manager.closeAll());
  return { manager, events, webContents, ...connection };
}

test('read, write and real code execution retain evidence hashes and successful process state', async (t) => {
  const root = project();
  fs.writeFileSync(path.join(root, 'input.txt'), 'verified read');
  let n = 0;
  const run = setup(t, root, async () => {
    n += 1;
    if (n === 1) return toolResult('read_file', { file_name: 'input.txt' }, 'read');
    if (n === 2) return toolResult('write_file', { file_name: 'sort.mjs', content: 'console.log(JSON.stringify([9,1,3].sort((a,b)=>a-b)))\n' }, 'write');
    if (n === 3) return toolResult('run_code', { file_name: 'sort.mjs', runtime: 'node' }, 'code');
    return textResult('输出 [1,3,9]');
  });
  await run.manager.send({ ...run, frame: frame(run.sessionId) });
  const completed = await until(run.events, (event) => event.type === 'chat.assistant.completed');
  assert.equal(completed.payload.evidenceRefs.length, 3);
  const call = run.events.find((event) => event.type === 'tool.call.completed' && event.payload.toolName === 'run_code');
  assert.match(call.payload.result.stdout, /\[1,3,9\]/);
  assert.equal(call.payload.result.exit_code, 0);
  const processes = run.events.filter((event) => event.type === 'runtime.processes.updated').at(-1).payload.items;
  assert.ok(processes.some((item) => item.kind === 'script' && item.pid && item.status === 'succeeded'));
  for (const event of run.events.filter((item) => item.type === 'runtime.artifact.content')) {
    assert.equal(event.payload.artifact.hash, crypto.createHash('sha256').update(JSON.stringify(event.payload.value)).digest('hex'));
  }
  const writeReceipt = run.events.find((event) => event.type === 'runtime.artifact.content' && event.payload.value?.fileChanges?.changed);
  assert.equal(writeReceipt.payload.value.fileChanges.before.exists, false);
  assert.equal(writeReceipt.payload.value.fileChanges.after.exists, true);
  assert.ok(run.events.some((event) => event.type === 'runtime.observation.upserted' && event.payload.observation.consumedByStepId));
});

test('permission denial is a failure and prevents filesystem changes', async (t) => {
  const root = project({ tool_permissions: ['filesystem:read'] });
  let n = 0;
  const run = setup(t, root, async () => ++n === 1 ? toolResult('write_file', { file_name: 'denied.txt', content: 'must not exist' }) : textResult('权限不足'));
  await run.manager.send({ ...run, frame: frame(run.sessionId) });
  const failed = await until(run.events, (event) => event.type === 'tool.call.failed');
  assert.equal(failed.payload.code, 'PERMISSION_DENIED');
  assert.equal(fs.existsSync(path.join(root, 'denied.txt')), false);
  assert.equal(run.events.some((event) => event.type === 'tool.call.completed'), false);
  assert.equal(typeof failed.payload.durationMs, 'number');
});

test('tool budget reserves a truthful final response without executing further actions', async (t) => {
  const root = project({ max_tool_rounds: 1 });
  fs.writeFileSync(path.join(root, 'input.txt'), 'verified');
  let n = 0;
  const run = setup(t, root, async (_url, options) => {
    const request = JSON.parse(options.body);
    if (++n === 1) return toolResult('read_file', { file_name: 'input.txt' });
    assert.equal(request.tool_choice, 'none');
    assert.match(request.messages.at(-1).content, /预算已用完/);
    return textResult('已读取文件；其余工作尚未验证，需要下一轮继续。');
  });
  await run.manager.send({ ...run, frame: frame(run.sessionId) });
  await until(run.events, event => event.type === 'chat.assistant.completed');
  assert.equal(run.events.filter(event => event.type === 'tool.call.started').length, 1);
  assert.equal(run.events.some(event => event.type === 'chat.assistant.failed'), false);
});

test('invalid tool arguments and unsuccessful code produce explicit errors with retained output', async (t) => {
  const root = project();
  fs.writeFileSync(path.join(root, 'fail.mjs'), 'console.error("expected failure"); process.exit(7)');
  let n = 0;
  const run = setup(t, root, async () => {
    n += 1;
    if (n === 1) return toolResult('read_file', {}, 'invalid');
    if (n === 2) return toolResult('run_code', { file_name: 'fail.mjs', runtime: 'node' }, 'exit');
    return textResult('运行失败，退出码 7');
  });
  await run.manager.send({ ...run, frame: frame(run.sessionId) });
  await until(run.events, (event) => event.type === 'chat.assistant.completed');
  const failures = run.events.filter((event) => event.type === 'tool.call.failed');
  assert.deepEqual(failures.map((event) => event.payload.code), ['INVALID_ARGUMENTS', 'COMMAND_EXIT']);
  assert.match(JSON.stringify(failures[1].payload.details), /expected failure/);
});

test('exact edits change one match and reject ambiguous edits without overwriting the file', async (t) => {
  const root = project();
  fs.writeFileSync(path.join(root, 'target.txt'), 'keep\r\nold\r\nkeep\r\n');
  let n = 0;
  const run = setup(t, root, async () => {
    n += 1;
    if (n === 1) return toolResult('edit_file', { file_name: 'target.txt', old_text: 'old', new_text: 'new' }, 'exact');
    if (n === 2) return toolResult('edit_file', { file_name: 'target.txt', old_text: 'keep', new_text: 'bad' }, 'ambiguous');
    return textResult('精准修改已完成，歧义修改未应用');
  });
  await run.manager.send({ ...run, frame: frame(run.sessionId) });
  await until(run.events, (event) => event.type === 'chat.assistant.completed');
  assert.equal(fs.readFileSync(path.join(root, 'target.txt'), 'utf8'), 'keep\r\nnew\r\nkeep\r\n');
  assert.ok(run.events.some((event) => event.type === 'tool.call.completed' && event.payload.toolName === 'edit_file'));
  assert.match(run.events.find((event) => event.type === 'tool.call.failed').payload.message, /found 2 matches/);
});

test('Python code runs through the native launcher and returns its actual output', async (t) => {
  const { spawnSync } = require('node:child_process');
  const available = process.platform === 'win32' ? spawnSync('py', ['-3', '--version']) : spawnSync('python3', ['--version']);
  if (available.error) return t.skip('Python is not installed');
  const root = project();
  fs.writeFileSync(path.join(root, 'sort.py'), 'print(sorted([9, 1, 3]))');
  let n = 0;
  const run = setup(t, root, async () => ++n === 1 ? toolResult('run_code', { file_name: 'sort.py', runtime: 'python' }) : textResult('已运行'));
  await run.manager.send({ ...run, frame: frame(run.sessionId) });
  await until(run.events, event => event.type === 'chat.assistant.completed');
  const result = run.events.find(event => event.type === 'tool.call.completed').payload.result;
  assert.equal(result.exit_code, 0);
  assert.match(result.stdout, /\[1, 3, 9\]/);
});

test('timeout leaves a failed tool, error observation and failed process in the durable trace', async (t) => {
  const root = project({ tool_timeout_ms: 200, tools: ['tools/slow/manifest.json'] });
  fs.mkdirSync(path.join(root, 'tools/slow'));
  fs.writeFileSync(path.join(root, 'tools/slow/manifest.json'), JSON.stringify({ package: 'slow', runner: { entry: 'runner.cjs' }, tools: [{ name: 'hang', permissions: [], inputSchema: { type: 'object' } }] }));
  fs.writeFileSync(path.join(root, 'tools/slow/runner.cjs'), 'setInterval(()=>{},1000)');
  let n = 0;
  const run = setup(t, root, async () => ++n === 1 ? toolResult('hang', {}) : textResult('工具超时，未完成任务'));
  await run.manager.send({ ...run, frame: frame(run.sessionId) });
  const failed = await until(run.events, (event) => event.type === 'tool.call.failed');
  assert.equal(failed.payload.code, 'TIMEOUT');
  assert.ok(failed.payload.durationMs >= 190);
  await until(run.events, (event) => event.type === 'chat.assistant.completed');
  const reconnected = run.manager.connect({ workspaceId: 'project:test', workspaceName: '验收项目', projectPath: root, sessionId: run.sessionId, webContents: run.webContents });
  assert.equal(reconnected.runtimeId, run.runtimeId);
  const snapshot = run.events.filter((event) => event.type === 'runtime.snapshot').at(-1).payload;
  assert.ok(snapshot.trace.some((event) => event.type === 'tool.call.failed'));
  assert.ok(snapshot.processes.items.some((item) => item.status === 'failed'));
});

test('disconnect and reconnect during model work preserve active state and restore SQLite replay after restart', async (t) => {
  const root = project();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const run = setup(t, root, async () => { await gate; return textResult('重连后完成'); });
  await run.manager.send({ ...run, frame: frame(run.sessionId) });
  run.manager.close(run);
  const webContents = {};
  const connection = run.manager.connect({ workspaceId: 'project:test', workspaceName: '验收项目', projectPath: root, sessionId: run.sessionId, webContents });
  assert.equal(connection.runtimeId, run.runtimeId);
  const active = run.events.filter((event) => event.type === 'runtime.snapshot').at(-1).payload;
  assert.equal(active.status.loopStatus, 'running');
  assert.equal(active.conversation.messages.length, 2);
  assert.ok(active.trace.some((event) => event.type === 'timeline.step.upserted'));
  release();
  await until(run.events, (event) => event.type === 'chat.assistant.completed');
  await run.manager.closeAll();
  const restored = setup(t, root, async () => { throw Error('replay must not execute tools or call model'); });
  restored.manager.connect({ workspaceId: 'project:test', workspaceName: '验收项目', projectPath: root, sessionId: run.sessionId, webContents: restored.webContents });
  const snapshot = restored.events.filter((event) => event.type === 'runtime.snapshot').at(-1).payload;
  assert.ok(snapshot.trace.some((event) => event.type === 'chat.assistant.completed'));
  assert.equal(snapshot.conversation.messages.at(-1).content[0].text, '重连后完成');
});

test('child agents inherit a read-only capability subset and cannot finish the parent task', async (t) => {
  const root = project();
  let n = 0;
  const run = setup(t, root, async (_url, request) => {
    const body = JSON.parse(request.body);
    n += 1;
    if (n === 1) return toolResult('delegate_task', { goal: '只读核对', prompt: '核对文件' }, 'delegate');
    if (n === 2) {
      assert.equal(body.tools.some((tool) => tool.function.name === 'delegate_task' || tool.function.name === 'write_file'), false);
      return toolResult('write_file', { file_name: 'forbidden.txt', content: 'blocked' }, 'unauthorized');
    }
    if (n === 3) return textResult('子任务未写入文件，返回只读核对说明');
    return textResult('父任务已检查子任务结果');
  });
  await run.manager.send({ ...run, frame: frame(run.sessionId) });
  await until(run.events, (event) => event.type === 'chat.assistant.completed');
  assert.equal(fs.existsSync(path.join(root, 'forbidden.txt')), false);
  assert.ok(run.events.some((event) => event.type === 'tool.call.failed' && event.payload.toolName === 'write_file'));
  assert.equal(run.events.filter((event) => event.type === 'chat.assistant.completed').length, 1);
  const childState = run.events.filter((event) => event.type === 'runtime.children.updated').at(-1).payload.items[0];
  assert.equal(childState.parentSessionId, run.sessionId);
  assert.equal(childState.status, 'succeeded');
  assert.ok(childState.resultArtifactId);
});

test('recovery labels unfinished durable processes and messages as unknown or interrupted without replaying tools', async (t) => {
  const root = project();
  const run = setup(t, root, async () => { throw Error('must never call model during recovery'); });
  await run.manager.closeAll();
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(root, '.capybara', 'sessions.sqlite'));
  db.prepare('UPDATE sessions SET messages_json = ? WHERE id = ?').run(JSON.stringify([{ id: 'unfinished', role: 'assistant', status: 'streaming', content: [] }]), run.sessionId);
  const stale = { id: 'stale', type: 'runtime.processes.updated', sequence: 1, timestamp: new Date().toISOString(), payload: { revision: 1, items: [{ id: 'process:old', kind: 'tool', name: 'write_file', status: 'running' }] } };
  db.prepare('INSERT INTO runtime_trace (id,session_id,sequence,type,event_json,created_at) VALUES (?,?,?,?,?,?)').run(stale.id, run.sessionId, stale.sequence, stale.type, JSON.stringify(stale), stale.timestamp);
  db.close();
  const restored = setup(t, root, async () => { throw Error('replay must not call model'); });
  restored.manager.connect({ workspaceId: 'project:test', workspaceName: '验收项目', projectPath: root, sessionId: run.sessionId, webContents: restored.webContents });
  const snapshot = restored.events.filter((event) => event.type === 'runtime.snapshot').at(-1).payload;
  assert.equal(snapshot.processes.items[0].status, 'unknown');
  assert.equal(snapshot.conversation.messages[0].status, 'cancelled');
  assert.match(snapshot.conversation.messages[0].failure.message, /没有自动重放/);
});

for (const protocol of ['chat-completions', 'responses']) {
  test(`${protocol}: actual HTTP stream publishes public deltas before the model finishes and completes the tool loop`, async (t) => {
    const root = project();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    let n = 0;
    const server = http.createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      assert.equal(request.stream, true);
      assert.ok(request.tools.length > 0);
      n += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (value) => res.write(`data: ${JSON.stringify(value)}\r\n\r\n`);
      if (n === 1) {
        if (protocol === 'responses') {
          send({ type: 'response.output_text.delta', delta: '准备读取文件' });
          await gate;
          send({ type: 'response.output_item.added', output_index: 0, item: { id: 'fc1', type: 'function_call', call_id: 'call_sse', name: 'list_files', arguments: '' } });
          send({ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"."}' });
          send({ type: 'response.completed', response: { status: 'completed', output: [{ id: 'fc1', type: 'function_call', call_id: 'call_sse', name: 'list_files', arguments: '{"path":"."}' }] } });
        } else {
          send({ choices: [{ delta: { content: '准备读取文件' } }] });
          await gate;
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sse', function: { name: 'list_files', arguments: '{"path":"."}' } }] }, finish_reason: 'tool_calls' }] });
        }
      } else if (protocol === 'responses') {
        assert.ok(request.input.some((item) => item.type === 'function_call_output'));
        send({ type: 'response.output_text.delta', delta: '流式回复完成' });
        send({ type: 'response.completed', response: { status: 'completed', output_text: '流式回复完成', output: [] } });
      } else {
        assert.ok(request.messages.some((item) => item.role === 'tool'));
        send({ choices: [{ delta: { content: '流式回复完成' }, finish_reason: 'stop' }] });
      }
      res.end('data: [DONE]\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const run = setup(t, root, undefined, { LLM_PROTOCOL: protocol, LLM_BASE_URL: `http://127.0.0.1:${server.address().port}/v1` });
    await run.manager.send({ ...run, frame: frame(run.sessionId) });
    const delta = await until(run.events, (event) => event.type === 'chat.assistant.delta' && event.payload.channel === 'commentary' && event.payload.delta === '准备读取文件');
    assert.ok(delta.stepId);
    assert.equal(run.events.some((event) => event.type === 'chat.assistant.completed'), false);
    release();
    await until(run.events, (event) => event.type === 'chat.assistant.completed');
    assert.ok(run.events.some((event) => event.type === 'tool.call.completed'));
    assert.ok(run.events.some((event) => event.type === 'chat.assistant.delta' && event.payload.channel === 'final' && event.payload.delta === '流式回复完成'));
  });
}
