const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ensureSystemStorage } = require('../apps/workbench/electron/system-storage.cjs');
const { prompt } = require('./benchmark-coding-capability.cjs');

const root = path.resolve(__dirname, '../tmp/coding-acceptance/pi');
const profile = path.resolve(__dirname, '../tmp/coding-acceptance/pi-profile');
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
const env = ensureSystemStorage().runtimeEnv;
fs.writeFileSync(path.join(profile, 'models.json'), JSON.stringify({ providers: { 'capybara-benchmark': { baseUrl: env.LLM_BASE_URL, api: 'openai-completions', apiKey: '${CAPYBARA_BENCHMARK_KEY}', models: [{ id: env.LLM_MODEL, name: env.LLM_MODEL, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192 }] } } }, null, 2));
const cli = path.resolve(__dirname, '../tmp/pi-benchmark/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
const startedAt = Date.now();
const child = spawn(process.execPath, [cli, '--mode','json','--print','--provider','capybara-benchmark','--model',env.LLM_MODEL,'--thinking','off','--no-extensions','--no-skills','--no-mcp','--no-context-files','--tools','read,powershell,edit,write,grep,find,ls','--session-dir',path.join(profile,'sessions'),prompt.replace('给 run_command 的 timeout_ms 设为120000', '使用可用工具的超时参数设为120秒')], {
  cwd: root,
  env: { ...process.env, PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', PI_TELEMETRY: '0', CAPYBARA_BENCHMARK_KEY: env.LLM_API_KEY },
  stdio: ['ignore','pipe','pipe'], windowsHide: true,
});
const output = fs.createWriteStream(path.join(profile,'generation-events.jsonl'));
let buffer = '';
let tools = 0;
let errors = 0;
child.stdout.setEncoding('utf8').on('data',(chunk)=> {
  output.write(chunk);
  buffer += chunk;
  const lines = buffer.split('\n'); buffer = lines.pop() || '';
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === 'tool_execution_start') { tools += 1; console.log(JSON.stringify({ type: event.type, name: event.toolName })); }
      if (event.type === 'tool_execution_end' && event.isError) { errors += 1; console.log(JSON.stringify({ type: event.type, name: event.toolName, isError: true })); }
      if (event.type === 'agent_end') console.log(JSON.stringify({ type: event.type }));
    } catch { /* JSONL diagnostics remain in the private benchmark profile. */ }
  }
});
child.stderr.setEncoding('utf8').on('data',(chunk)=>process.stderr.write(chunk));
const timer = setTimeout(()=> { child.kill(); },900000);
child.once('close',(code)=> {
  clearTimeout(timer); output.end();
  const summary = { engine:'pi', version:'1.5.2', model:env.LLM_MODEL, projectPath:root, durationMs:Date.now()-startedAt, exitCode:code, tools, toolErrors:errors };
  fs.writeFileSync(path.join(profile,'generation-result.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary,null,2)); process.exitCode = code || 0;
});
