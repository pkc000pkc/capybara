const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRuntimeManager } = require('../apps/workbench/electron/runtime-v2.cjs');
const { ensureSystemStorage } = require('../apps/workbench/electron/system-storage.cjs');

async function main() {
  const root = path.resolve(__dirname, '../tmp/coding-acceptance/capybara');
  const original = JSON.parse(fs.readFileSync(path.join(root, '.capybara/generation-result.json')));
  const prompt = '继续完成上一轮开发。独立验收器已经启动并关闭了自己的服务，实际验证你的应用 17 项全部通过：构建页面和资源、CRUD、中文搜索、非法输入400、未知ID404、SQLite重启持久化。上一轮超出工具轮次，未能收尾。请首先检查你自己创建的遗留服务，仅按确认的项目路径和PID处理，不要按名称或仅凭端口杀进程。修正 smoke-default-port.mjs 的进程回收验证：使用隔离的空闲端口和数据库，直接启动 server/index.ts，不通过 npm/cmd 多层包装，关闭自己启动的直接子进程并等退出。随后实际执行 npm run typecheck、npm run build、npm test 及该冒烟检查。不要修改功能以绕过验证。最终用简短中文汇报真实通过项、遇到的错误和启动方式。';
  const events = [];
  let done;
  const terminal = new Promise((resolve) => { done = resolve; });
  const manager = createRuntimeManager({ env: ensureSystemStorage().runtimeEnv, emit: ({ event }) => {
    events.push(event);
    if (event.type === 'tool.call.started' || event.type === 'tool.call.failed') console.log(JSON.stringify({type:event.type,name:event.payload.toolName,error:event.payload.message}));
    if (['chat.assistant.completed','chat.assistant.failed'].includes(event.type)) done(event);
  }});
  const webContents = {};
  const connection = manager.connect({ workspaceId:'coding:capybara', workspaceName:'清笺编程验收', projectPath:root, sessionId:original.sessionId, webContents });
  const id = crypto.randomUUID();
  const startedAt = Date.now();
  const timer = setTimeout(()=>void manager.send({...connection,webContents,frame:{type:'run.cancel',sessionId:connection.sessionId}}),600000);
  try {
    await manager.send({...connection,webContents,frame:{id,type:'chat.message.send',sessionId:connection.sessionId,payload:{clientMessageId:`message:${id}`,content:[{type:'text',text:prompt}]}}});
    const result = await terminal;
    const summary = {engine:'capybara',sessionId:connection.sessionId,durationMs:Date.now()-startedAt,terminal:result.type,tools:events.filter(e=>e.type==='tool.call.completed').length,failures:events.filter(e=>e.type==='tool.call.failed').map(e=>({toolName:e.payload.toolName,message:e.payload.message})),reply:events.filter(e=>e.type==='chat.assistant.delta'&&e.payload.channel==='final').map(e=>e.payload.delta).join('')};
    fs.writeFileSync(path.join(root,'.capybara/continuation-result.json'),JSON.stringify(summary,null,2));
    console.log(JSON.stringify(summary,null,2));
    if(result.type!=='chat.assistant.completed')process.exitCode=1;
  } finally { clearTimeout(timer);await manager.closeAll(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
