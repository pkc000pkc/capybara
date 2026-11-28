const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const net = require('node:net');

async function verify(engine) {
  if (!['capybara','pi'].includes(engine)) throw new Error('engine must be capybara or pi');
  const root = path.resolve(__dirname,'../tmp/coding-acceptance',engine);
  const data = fs.mkdtempSync(path.join(os.tmpdir(),`qingjian-qa-${engine}-`));
  const port = await new Promise((resolve, reject) => {
    const reservation = net.createServer();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const selected = reservation.address().port;
      reservation.close(error => error ? reject(error) : resolve(selected));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let child;
  let log = '';
  const checks = [];
  const start = async () => {
    child = spawn(process.env.ComSpec || 'cmd.exe',['/d','/s','/c','npm start'],{cwd:root,windowsHide:true,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DB_PATH:path.join(data,'notes.sqlite')},stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',(value)=>{log+=value;}); child.stderr.on('data',(value)=>{log+=value;});
    const deadline = Date.now()+12000;
    while(Date.now()<deadline) {
      if (child.exitCode!==null) throw new Error(`server exited: ${log}`);
      try { const response=await fetch(base+'/api/notes',{signal:AbortSignal.timeout(500)}); if(response.ok)return; } catch {}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error(`server did not start: ${log}`);
  };
  const stop = async () => { if(child?.pid && child.exitCode===null) await new Promise(resolve=>spawn('taskkill.exe',['/pid',String(child.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'}).once('close',resolve)); };
  const call = async (method,route,value) => {
    const response=await fetch(base+route,{method,signal:AbortSignal.timeout(4000),...(value!==undefined?{headers:{'content-type':'application/json'},body:typeof value==='string'?value:JSON.stringify(value)}:{})});
    const text=await response.text(); let body;try{body=JSON.parse(text);}catch{body=text;} return {status:response.status,body};
  };
  const list = (body) => Array.isArray(body)?body:body.notes||body.items||body.data;
  const note = (body) => body.note||body.data||body;
  const check = (name,fn) => {fn(); checks.push({name,status:'passed'});};
  let failure;
  try {
    await start();
    const page=await call('GET','/');check('serves built UI',()=>{assert.equal(page.status,200);assert.match(page.body,/<div[^>]+id="root"/);});
    const asset=page.body.match(/src="([^"]+\.js)"/);check('built JavaScript asset',()=>assert.ok(asset));
    const js=await call('GET',asset[1]);check('asset is available',()=>assert.equal(js.status,200));
    const empty=await call('GET','/api/notes');check('empty database',()=>assert.deepEqual(list(empty.body),[]));
    const created=await call('POST','/api/notes',{title:'QA 茶笺',body:'正文 <script>not executable</script>'});
    const a=note(created.body);check('create note',()=>{assert.equal(created.status,201);assert.ok(a.id);assert.equal(a.title,'QA 茶笺');assert.equal(a.body,'正文 <script>not executable</script>');assert.ok(a.updatedAt);});
    const patched=await call('PATCH',`/api/notes/${a.id}`,{title:'QA 已编辑',body:'新的正文'});check('update note',()=>{assert.equal(patched.status,200);assert.equal(note(patched.body).body,'新的正文');});
    const searched=await call('GET','/api/notes?q='+encodeURIComponent('已编辑'));check('search Chinese title',()=>assert.equal(list(searched.body).length,1));
    const missing=await call('GET','/api/notes?q='+encodeURIComponent('根本没有的内容'));check('search no matches',()=>assert.equal(list(missing.body).length,0));
    for (const value of [{title:' '},{title:42},{title:'错误正文',body:42}]) { const invalid=await call('POST','/api/notes',value);check('invalid fields '+JSON.stringify(value),()=>assert.equal(invalid.status,400)); }
    const malformed=await call('POST','/api/notes','{');check('malformed JSON',()=>assert.equal(malformed.status,400));
    const missingPatch=await call('PATCH','/api/notes/9999999',{title:'missing'});check('404 unknown update',()=>assert.equal(missingPatch.status,404));
    const missingDelete=await call('DELETE','/api/notes/9999999');check('404 unknown delete',()=>assert.equal(missingDelete.status,404));
    await stop();await start();
    const persisted=await call('GET','/api/notes');check('SQLite survives restart',()=>{assert.equal(list(persisted.body).length,1);assert.equal(list(persisted.body)[0].title,'QA 已编辑');});
    const removed=await call('DELETE',`/api/notes/${a.id}`);check('delete note',()=>assert.ok([200,204].includes(removed.status)));
    const final=await call('GET','/api/notes');check('deleted record no longer listed',()=>assert.equal(list(final.body).length,0));
  } catch(error) { failure=error.message; checks.push({name:'independent acceptance',status:'failed',message:failure}); }
  finally { await stop(); }
  const result={engine,projectPath:root,checks,passed:checks.filter(item=>item.status==='passed').length,failed:failure?1:0};
  fs.mkdirSync(path.join(root,'.capybara'),{recursive:true});fs.writeFileSync(path.join(root,'.capybara/independent-api-result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));if(failure)process.exitCode=1;
}
verify(process.argv[2]||'capybara').catch(error=>{console.error(error.message);process.exitCode=1;});
