import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { freezePluginSnapshot } from '../src/phase0_inventory.mjs'

const project = resolve(fileURLToPath(new URL('..', import.meta.url)))
const protocol = JSON.parse(readFileSync(join(project, 'config/phase0-protocol.json')))
const backend = protocol.runtime.backendRoot
const exec = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const cases = ['read_three', 'write_two', 'unknown_tail', 'hook_block_tail', 'user_update_tail', 'stop_tail',
  'aui_barrier', 'wait_barrier', 'control_barrier', 'invalid_tail']

if (!process.argv.includes('--probe')) {
  test('shared tool-round scheduler drives real Host/ARE batches, barriers and per-node cancellation without a model', { timeout: 240000 }, async () => {
    const { stdout } = await exec(process.execPath, ['--import', pathToFileURL(join(backend, 'node_modules/tsx/dist/loader.mjs')).href,
      fileURLToPath(import.meta.url), '--probe'], { cwd: backend, timeout: 230000, maxBuffer: 2 * 1024 * 1024 })
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
    assert.equal(report.status, 'passed')
    assert.deepEqual(report.cases.map(value => value.case), cases)
    assert.ok(report.cases.every(value => value.status === 'passed' && value.externalNetworkAttempts === 0 && value.providerPairsVerified))
    assert.equal(report.realModelRequests, 0)
    assert.equal(report.benchmarkExecuted, false)
    console.log(JSON.stringify(report))
  })
} else {
  const { RuntimePluginHost } = await import(pathToFileURL(join(backend, 'src/core/plugins/runtime-plugin-host.ts')).href)
  const { ToolRoundScheduler } = await import(pathToFileURL(join(backend, 'src/core/tools/tool-round-scheduler.ts')).href)
  const { createToolRoundService } = await import('../src/tool_round_service.mjs')
  const root = mkdtempSync(join(project, 'runs', 'tool-round-controlled-'))
  const sourceRoot = join(root, 'fixture-plugin')
  for (const name of ['hooks', 'harnesses']) mkdirSync(join(sourceRoot, name), { recursive: true })
  const hook = (name, checkpoint, body) => `import { defineHook } from '@capybara-agent/sdk';
export default defineHook({name:${JSON.stringify(name)}, description:'Synthetic tool-round boundary fixture', enabled:true,
checkpoint:${JSON.stringify(checkpoint)},trigger:()=>true,schedule:{priority:100,timeoutMs:3000,onError:'block'},
permissions:{variables:'patch',artifacts:'write'},run({variables,action,outcome}){${body}}});`
  const pluginFiles = {
    'capybara.plugin.json': JSON.stringify({ schemaVersion: 1, id: 'gaia2-runtime', name: 'Tool round controlled fixture', version: '1.0.0',
      resources: { variables: 'variables.json', harnesses: ['harnesses/manifest.json'], hooks: ['hooks'] } }),
    'variables.json': JSON.stringify({ version: 1, variables: [{ key: 'gaia2_round_fixture', type: 'object',
      value: { outcomes: [], unknown: [] }, required: false, readonly: false, scope: 'session' }] }),
    'harnesses/manifest.json': JSON.stringify({ version: 1, package: 'round-fixture', harnesses: [{ name: 'round-context', description: 'fixture',
      type: 'persistent', entry: 'round-context.j2', activation: {}, inputs: ['builtin.variables.gaia2_round_fixture'], requiredTools: [] }] }),
    'harnesses/round-context.j2': 'Tool-round fixture state: {{ builtin.variables.gaia2_round_fixture | dump }}',
    'hooks/gaia2-write-guard.ts': hook('gaia2-write-guard', 'before_tool', `const state=variables.builtin.variables.gaia2_round_fixture;
      const denied=action?.arguments?.value==='block'||action?.effect==='write'&&state.unknown.length>0;
      return {decision:{action:denied?'block':'allow',reason:denied?'controlled_write_boundary':'controlled_gate_allowed'}};`),
    'hooks/gaia2-conflict-gate.ts': hook('gaia2-conflict-gate', 'before_tool', "return {decision:{action:'allow',reason:'controlled_conflict_checked'}};"),
    'hooks/model-boundary.ts': hook('model-boundary', 'before_model', "return {artifacts:[{title:'Synthetic model boundary',value:{checked:true}}]};"),
    'hooks/end-boundary.ts': hook('end-boundary', 'attempt_end', "return {artifacts:[{title:'Synthetic attempt boundary',value:{checked:true}}]};"),
    'hooks/record-native.ts': hook('record-native', 'after_tool', `const old=variables.builtin.variables.gaia2_round_fixture;
      const next={outcomes:[...old.outcomes,{id:action.id,status:outcome.status,executed:outcome.executed===true}],
        unknown:outcome.status==='unknown'?[...old.unknown,action.id]:old.unknown};
      return {patches:[{op:'replace',path:'/builtin/variables/gaia2_round_fixture',value:next}]};`),
  }
  for (const [name, content] of Object.entries(pluginFiles)) writeFileSync(join(sourceRoot, name), content)
  const snapshot = freezePluginSnapshot({ root, id: 'gaia2-runtime', sourceRoot })
  const sourcePaths = [join(project, 'scripts/capybara_official_bridge.py'), join(project, 'scripts/gaia2_runtime_hooks.py'), join(project, 'scripts/gaia2_tool_round.py'),
    join(project, 'src/tool_round_service.mjs'), join(project, 'scripts/phase3_hook_server.ts'),
    join(project, 'test/tool_round_controlled.test.mjs'), join(project, 'test/tool_round_live_bridge_fixture.py'),
    join(backend, 'src/core/tools/tool-round-scheduler.ts'), join(backend, 'src/core/plugins/runtime-plugin-host.ts')]
  const frozenSources = sourcePaths.map(path => ({ path, sha256: hash(readFileSync(path)) }))
  const results = []
  for (const testCase of cases) {
    const workspaceDir = join(root, testCase); mkdirSync(workspaceDir)
    const executionId = 'tool-round-' + testCase, sessionId = 'session-' + testCase, token = randomUUID()
    const host = new RuntimePluginHost({ projectDir: root, workspaceDir, plugins: [snapshot], executionId, sessionId, scenarioId: 'synthetic-' + testCase })
    await host.initialize()
    const rounds = createToolRoundService({ Scheduler: ToolRoundScheduler, workspaceDir, executionId, sessionId })
    const roundReceipts = [], hookReceipts = [], failures = []
    const expectedToken = hash('Bearer ' + token)
    const server = createServer(async (request, response) => {
      try {
        assert.ok(timingSafeEqual(Buffer.from(hash(request.headers.authorization || '')), Buffer.from(expectedToken)))
        const fragments = []; let size = 0
        for await (const fragment of request) { size += fragment.length; assert.ok(size <= 4 * 1024 * 1024); fragments.push(fragment) }
        const body = JSON.parse(Buffer.concat(fragments).toString('utf8'))
        assert.equal(body.executionId, executionId); assert.equal(body.sessionId, sessionId)
        let result
        if (request.url === '/tool-round') {
          result = await rounds.invoke(body)
          roundReceipts.push(result)
          const artifact = readFileSync(join(workspaceDir, result.sourceRef.path))
          assert.equal(hash(artifact), result.sourceRef.sha256)
        } else {
          assert.equal(request.url, '/invoke')
          const { executionId: _execution, sessionId: _session, ...invocation } = body
          result = await host.invoke(invocation)
          hookReceipts.push({ checkpoint: invocation.checkpoint, actionId: invocation.action?.id, response: result })
        }
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result))
      } catch (error) {
        failures.push(String(error))
        response.statusCode = 422; response.end(JSON.stringify({ error: 'controlled_round_request_rejected' }))
      }
    })
    await new Promise(done => server.listen(0, '127.0.0.1', done))
    try {
      const inputPath = join(workspaceDir, 'fixture-input.json')
      writeFileSync(inputPath, JSON.stringify({ case: testCase, port: server.address().port, token, executionId, sessionId, workspace: workspaceDir }))
      const { stdout } = await exec(resolve(project, protocol.runtime.python), [join(project, 'test/tool_round_live_bridge_fixture.py'), inputPath],
        { cwd: project, timeout: 60000, maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', LITELLM_LOCAL_MODEL_COST_MAP: 'True' } })
      const result = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
      assert.equal(result.status, 'passed')
      assert.deepEqual(failures, [])
      assert.ok(roundReceipts.length > 0, 'the real shared scheduler must be traversed')
      const terminal = [...roundReceipts].reverse().find(row => ['completed', 'cancelled', 'rejected'].includes(row.state?.status))
      assert.ok(terminal, 'a terminal shared scheduler state is required')
      assert.ok(terminal.state.nodes.every(node => !['pending', 'in_flight'].includes(node.status)))
      if (['read_three', 'write_two'].includes(testCase)) {
        assert.equal(terminal.state.status, 'completed')
        assert.ok(terminal.state.nodes.every(node => node.status === 'succeeded'))
      } else if (testCase.endsWith('_barrier')) {
        assert.equal(terminal.state.status, 'rejected')
        assert.ok(terminal.state.nodes.every(node => node.status === 'cancelled'))
      } else {
        assert.equal(terminal.state.status, 'cancelled')
        assert.ok(terminal.state.nodes.slice(1).every(node => node.status === 'cancelled'))
      }
      const detail = { ...result, schedulerState: terminal.state, schedulerReceiptCount: roundReceipts.length,
        hookReceiptCount: hookReceipts.length, frozenSources }
      writeFileSync(join(workspaceDir, 'report.json'), JSON.stringify(detail, null, 2))
      results.push({ ...result, schedulerStatus: terminal.state.status, schedulerReceiptCount: roundReceipts.length, hookReceiptCount: hookReceipts.length })
    } finally {
      await new Promise(done => server.close(done)); await host.close()
    }
  }
  for (const source of frozenSources) assert.equal(hash(readFileSync(source.path)), source.sha256, 'frozen source changed: ' + source.path)
  const report = { status: 'passed', reportPath: join(root, 'report.json'), cases: results, frozenSources,
    frozenPlugin: snapshot, realModelRequests: 0, benchmarkExecuted: false, officialSubmissionReady: false }
  writeFileSync(report.reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ status: report.status, reportPath: report.reportPath, cases: results, realModelRequests: 0, benchmarkExecuted: false }))
}
