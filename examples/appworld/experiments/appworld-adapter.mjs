import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REFERENCE_RESOLVER_REVISION = 'appworld-reference-v2'
const MAX_STATE_RECORDS = 25
const MAX_HISTORICAL_STATE_RECORDS = 10
const MAX_STATE_FIELDS = 20
const MAX_STATE_VALUE_CHARS = 1_000

function referenceResolverRevision() {
  return process.env.CAPYBARA_EXPERIMENT_ADAPTER_REVISION || REFERENCE_RESOLVER_REVISION
}

function readRequest() {
  return new Promise((resolve, reject) => {
    let source = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => { source += chunk })
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(source)) } catch (error) { reject(error) }
    })
    process.stdin.on('error', reject)
  })
}

function hostProject(workspaceDir) {
  const normalized = path.resolve(workspaceDir)
  const marker = `${path.sep}.capybara${path.sep}worktrees${path.sep}`.toLowerCase()
  const index = normalized.toLowerCase().indexOf(marker)
  return index < 0 ? normalized : normalized.slice(0, index)
}

function pythonExecutable(projectDir) {
  return process.platform === 'win32'
    ? path.join(projectDir, '.venv', 'Scripts', 'python.exe')
    : path.join(projectDir, '.venv', 'bin', 'python')
}

function stateFile(workspaceDir) {
  return path.join(workspaceDir, '.capybara', 'appworld-case-state.json')
}

function appworldMetadata(payload) {
  const value = payload?.case?.metadata?.private?.appworld
  if (!value || typeof value.task_id !== 'string' || !value.task_id.trim()) {
    throw new Error('case metadata.private.appworld.task_id is required')
  }
  return value
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function normalizedRequirement(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function displayValue(value) {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : JSON.stringify(value, null, 2)
}

function requirementsFor(taskDir, evaluation) {
  const passes = Array.isArray(evaluation?.passes) ? evaluation.passes : []
  const failures = Array.isArray(evaluation?.failures) ? evaluation.failures : []
  const evaluated = [...passes.map((item) => ({ ...item, status: 'passed' })), ...failures.map((item) => ({ ...item, status: 'failed' }))]
  let declared = []
  const testDataFile = path.join(taskDir, 'ground_truth', 'test_data.json')
  try {
    const value = readJson(testDataFile)
    declared = Array.isArray(value) ? value : []
  } catch {}
  const consumed = new Set()
  const ordered = declared.map((item, ordinal) => {
    const description = normalizedRequirement(item?.requirement)
    const index = evaluated.findIndex((entry, candidateIndex) =>
      !consumed.has(candidateIndex) && normalizedRequirement(entry?.requirement) === description)
    const match = index < 0 ? undefined : evaluated[index]
    if (index >= 0) consumed.add(index)
    return {
      ordinal,
      status: match?.status ?? 'unknown',
      description,
      ...(typeof (match?.label ?? item?.label) === 'string' ? { label: match?.label ?? item?.label } : {}),
      ...(typeof match?.trace === 'string' && match.trace.trim() ? { trace: match.trace.trim() } : {}),
    }
  })
  for (const [index, item] of evaluated.entries()) {
    if (consumed.has(index)) continue
    ordered.push({
      ordinal: ordered.length,
      status: item.status,
      description: normalizedRequirement(item?.requirement),
      ...(typeof item?.label === 'string' ? { label: item.label } : {}),
      ...(typeof item?.trace === 'string' && item.trace.trim() ? { trace: item.trace.trim() } : {}),
    })
  }
  return ordered
}

function normalizedModelName(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function tableMatchesModel(table, model) {
  const normalizedTable = normalizedModelName(table)
  const normalizedModel = normalizedModelName(model)
  return normalizedTable === normalizedModel
    || normalizedTable === `${normalizedModel}s`
    || normalizedTable === `${normalizedModel}es`
    || (normalizedTable.endsWith('ies') && `${normalizedTable.slice(0, -3)}y` === normalizedModel)
}

function operationFromSql(sql) {
  const match = String(sql ?? '').match(/^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+[`"\[]?([a-zA-Z0-9_]+)/i)
  if (!match) return undefined
  const verb = match[1].toUpperCase()
  return {
    table: match[2],
    operation: verb.startsWith('INSERT') ? 'added' : verb.startsWith('UPDATE') ? 'updated' : 'removed',
  }
}

function operationsFor(file) {
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try {
      const value = JSON.parse(line)
      const operation = operationFromSql(Array.isArray(value) ? value[0] : undefined)
      return operation ? [operation] : []
    } catch {
      return []
    }
  })
}

function summaryStateChanges(root, experimentRunId, experimentCaseId, taskId) {
  const dbDir = path.join(root, 'experiments', 'outputs', 'capybara', experimentRunId, experimentCaseId, 'tasks', taskId, 'dbs')
  const hashesFile = path.join(dbDir, 'model_hashes.json')
  if (!fs.existsSync(hashesFile)) return []
  const hashes = readJson(hashesFile)
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) return []
  const changes = []
  for (const [application, models] of Object.entries(hashes)) {
    if (!models || typeof models !== 'object' || Array.isArray(models)) continue
    const operations = operationsFor(path.join(dbDir, `${application}.jsonl`))
    for (const [model, count] of Object.entries(models)) {
      const matching = operations.filter((item) => tableMatchesModel(item.table, model))
      const records = Number.isFinite(Number(count)) ? Number(count) : matching.length
      const updateOperations = matching.filter((item) => item.operation === 'updated').length
      const removeOperations = matching.filter((item) => item.operation === 'removed').length
      const updated = Math.min(records, updateOperations)
      const removed = Math.min(Math.max(0, records - updated), removeOperations)
      changes.push({
        application,
        model,
        records,
        added: matching.some((item) => item.operation === 'added') ? Math.max(0, records - updated - removed) : 0,
        updated,
        removed,
        recordChanges: [],
        truncatedRecords: records,
      })
    }
  }
  return changes
}

function detailedStateChanges(root, experimentRunId, experimentCaseId, taskId) {
  const projectDir = path.resolve(root, '..', '..')
  const python = pythonExecutable(projectDir)
  const script = path.join(projectDir, 'scripts', 'extract_state_diff.py')
  const dbDir = path.join(root, 'experiments', 'outputs', 'capybara', experimentRunId, experimentCaseId, 'tasks', taskId, 'dbs')
  if (!fs.existsSync(script)) throw new Error('AppWorld state diff helper was not found')
  const result = spawnSync(python, [
    script,
    '--root', root,
    '--task-id', taskId,
    '--output-dbs', dbDir,
    '--max-records', String(MAX_STATE_RECORDS),
    '--max-fields', String(MAX_STATE_FIELDS),
    '--max-value-chars', String(MAX_STATE_VALUE_CHARS),
  ], {
    cwd: projectDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      APPWORLD_ROOT: root,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    maxBuffer: 20 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `state diff helper exited with code ${result.status}`)
  const value = JSON.parse(result.stdout)
  if (!value || !Array.isArray(value.changes)) throw new Error('state diff helper returned an invalid result')
  return value.changes
}

function detailedStateChangesBatch(root, cases) {
  if (!cases.length) return new Map()
  const projectDir = path.resolve(root, '..', '..')
  const python = pythonExecutable(projectDir)
  const script = path.join(projectDir, 'scripts', 'extract_state_diff.py')
  if (!fs.existsSync(script)) throw new Error('AppWorld state diff helper was not found')
  const items = cases.map((item) => ({
    id: item.id,
    taskId: item.taskId,
    outputDbs: path.join(root, 'experiments', 'outputs', 'capybara', item.experimentRunId, item.experimentCaseId, 'tasks', item.taskId, 'dbs'),
  }))
  const result = spawnSync(python, [
    script,
    '--batch',
    '--max-records', String(MAX_HISTORICAL_STATE_RECORDS),
    '--max-fields', String(MAX_STATE_FIELDS),
    '--max-value-chars', String(MAX_STATE_VALUE_CHARS),
  ], {
    cwd: projectDir,
    encoding: 'utf8',
    input: JSON.stringify({ root, items }),
    env: {
      ...process.env,
      APPWORLD_ROOT: root,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    maxBuffer: 50 * 1024 * 1024,
    timeout: 10 * 60_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr.trim() || `state diff helper exited with code ${result.status}`)
  const value = JSON.parse(result.stdout)
  if (!value || !Array.isArray(value.items)) throw new Error('state diff helper returned an invalid batch result')
  return new Map(value.items.map((item) => [item.id, item]))
}

function stateChanges(root, experimentRunId, experimentCaseId, taskId) {
  const dbDir = path.join(root, 'experiments', 'outputs', 'capybara', experimentRunId, experimentCaseId, 'tasks', taskId, 'dbs')
  if (!fs.existsSync(path.join(dbDir, 'model_hashes.json'))) {
    return {
      changes: [],
      status: 'unavailable',
      error: 'AppWorld state output was not found.',
    }
  }
  try {
    return {
      changes: detailedStateChanges(root, experimentRunId, experimentCaseId, taskId),
      status: 'complete',
    }
  } catch {
    return {
      changes: summaryStateChanges(root, experimentRunId, experimentCaseId, taskId),
      status: 'summary_only',
      error: 'Record-level AppWorld state evidence could not be reconstructed; model-level counts are shown.',
    }
  }
}

function unavailableReference(taskId, error) {
  return {
    kind: 'unavailable',
    status: 'load_failed',
    source: {
      type: 'official_evaluator',
      benchmark: 'appworld',
      taskId,
      resolverRevision: referenceResolverRevision(),
    },
    requirements: [],
    actualStateChanges: [],
    stateChangesStatus: 'unavailable',
    failureTraces: [],
    error: error instanceof Error ? error.message : String(error),
    resolvedAt: new Date().toISOString(),
  }
}

export function buildReference({ root, taskId, experimentRunId, experimentCaseId, evaluation, stateEvidence: suppliedStateEvidence }) {
  const taskDir = path.join(root, 'data', 'tasks', taskId)
  const groundTruthDir = path.join(taskDir, 'ground_truth')
  const answerFile = path.join(groundTruthDir, 'answer.json')
  if (!fs.existsSync(answerFile)) throw new Error('official ground_truth/answer.json was not found')
  const answer = readJson(answerFile)
  const requirements = requirementsFor(taskDir, evaluation)
  const failureTraces = requirements.flatMap((item) => item.status === 'failed' && item.trace ? [item.trace] : [])
  const stateEvidence = suppliedStateEvidence ?? stateChanges(root, experimentRunId, experimentCaseId, taskId)
  const source = {
    type: 'official_evaluator',
    benchmark: 'appworld',
    taskId,
    resolverRevision: referenceResolverRevision(),
    artifacts: [
      'ground_truth/answer.json',
      'ground_truth/test_data.json',
      'ground_truth/public_data.json',
      'ground_truth/private_data.json',
      'output/dbs/model_hashes.json',
      'output/dbs/*.jsonl',
    ],
  }
  if (answer !== null) {
    return {
      kind: 'text',
      status: 'available',
      source,
      displayValue: displayValue(answer),
      value: answer,
      requirements,
      actualStateChanges: stateEvidence.changes,
      stateChangesStatus: stateEvidence.status,
      ...(stateEvidence.error ? { stateChangesError: stateEvidence.error } : {}),
      failureTraces,
      resolvedAt: new Date().toISOString(),
    }
  }
  const publicFile = path.join(groundTruthDir, 'public_data.json')
  const privateFile = path.join(groundTruthDir, 'private_data.json')
  return {
    kind: 'state',
    status: 'available',
    source,
    requirements,
    expectedState: {
      public: fs.existsSync(publicFile) ? readJson(publicFile) : {},
      private: fs.existsSync(privateFile) ? readJson(privateFile) : {},
    },
    actualStateChanges: stateEvidence.changes,
    stateChangesStatus: stateEvidence.status,
    ...(stateEvidence.error ? { stateChangesError: stateEvidence.error } : {}),
    failureTraces,
    resolvedAt: new Date().toISOString(),
  }
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function post(endpoint, route, body, timeoutMs = 120000) {
  const response = await fetch(`${endpoint}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const value = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = value?.detail ?? value?.error ?? `${response.status} ${response.statusText}`
    throw new Error(`AppWorld ${route} failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  }
  return value?.output
}

async function waitUntilReady(endpoint, pid) {
  const deadline = Date.now() + 90000
  let lastError
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
    } catch (error) {
      lastError = error
    }
    try { process.kill(pid, 0) } catch { throw new Error('AppWorld environment server exited before becoming ready') }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`AppWorld environment server did not become ready: ${lastError ?? 'timeout'}`)
}

function terminate(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch {}
}

async function prepare(payload) {
  const workspaceDir = path.resolve(payload.workspaceDir)
  const projectDir = hostProject(workspaceDir)
  const python = pythonExecutable(projectDir)
  const root = path.join(projectDir, '.venv', 'appworld-root')
  if (!fs.existsSync(python)) throw new Error(`AppWorld Python environment was not found: ${python}`)
  if (!fs.existsSync(path.join(root, 'data', 'tasks'))) throw new Error(`AppWorld data was not found: ${root}`)
  const metadata = appworldMetadata(payload)
  const port = await availablePort()
  const endpoint = `http://127.0.0.1:${port}`
  const experimentName = `capybara/${payload.run.id}/${payload.case.id}`
  const logFile = path.join(workspaceDir, '.capybara', 'appworld-server.log')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const log = fs.openSync(logFile, 'w')
  const child = spawn(python, [
    '-m', 'appworld.cli', 'serve', 'environment',
    '--port', String(port), '--no-show-usage', '--root', root,
  ], {
    cwd: root,
    detached: true,
    windowsHide: true,
    // AppWorld writes environment I/O logs with the process default encoding. Force UTF-8 on
    // Windows so task output containing emoji or other non-GBK characters cannot crash /execute.
    env: {
      ...process.env,
      APPWORLD_ROOT: root,
      NO_SHOW_URLS: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', log, log],
  })
  child.unref()
  fs.closeSync(log)
  try {
    await waitUntilReady(endpoint, child.pid)
    const task = await post(endpoint, '/initialize', {
      task_id: metadata.task_id,
      experiment_name: experimentName,
      load_ground_truth: true,
      timeout_seconds: null,
    })
    const state = {
      version: 1,
      endpoint,
      pid: child.pid,
      taskId: metadata.task_id,
      experimentName,
      projectDir,
      root,
      initializedAt: new Date().toISOString(),
    }
    fs.writeFileSync(stateFile(workspaceDir), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return { endpoint, taskId: metadata.task_id, experimentName, pid: child.pid, task }
  } catch (error) {
    terminate(child.pid)
    throw error
  }
}

function readState(payload) {
  return JSON.parse(fs.readFileSync(stateFile(path.resolve(payload.workspaceDir)), 'utf8'))
}

async function evaluate(payload) {
  const state = readState(payload)
  // AppWorld 0.1.3 persists state after each execute call.
  const evaluation = await post(state.endpoint, '/evaluate', {
    task_id: state.taskId,
    suppress_errors: true,
    report: false,
  }, 300000)
  const passes = Array.isArray(evaluation?.passes) ? evaluation.passes : []
  const failures = Array.isArray(evaluation?.failures) ? evaluation.failures : []
  const total = Number(evaluation?.num_tests ?? passes.length + failures.length)
  const passed = evaluation?.success === true
  const requirementCompletion = total > 0 ? passes.length / total * 100 : 0
  const failedRequirements = failures.map((item) => item?.requirement).filter((item) => typeof item === 'string')
  let reference
  try {
    reference = buildReference({
      root: state.root,
      taskId: state.taskId,
      experimentRunId: payload.run.id,
      experimentCaseId: payload.case.id,
      evaluation,
    })
  } catch (error) {
    reference = unavailableReference(state.taskId, error)
  }
  return {
    score: passed ? 1 : 0,
    passed,
    rationale: passed
      ? `AppWorld passed all ${total} state requirements.`
      : `AppWorld passed ${passes.length}/${total} state requirements${failedRequirements.length ? `; failed: ${failedRequirements.join(' | ')}` : ''}.`,
    metrics: {
      taskGoalCompletion: passed ? 100 : 0,
      requirementCompletion,
      difficulty: Number(evaluation?.difficulty ?? payload.case.metadata?.private?.appworld?.difficulty ?? 0),
      numTests: total,
      passedRequirements: passes.length,
      failedRequirements: failures.length,
    },
    details: evaluation,
    reference,
  }
}

function reference(payload) {
  const projectDir = hostProject(process.env.CAPYBARA_PROJECT_DIR ?? process.cwd())
  const root = path.join(projectDir, '.venv', 'appworld-root')
  const cases = Array.isArray(payload?.cases) ? payload.cases : []
  const prepared = cases.map((item) => ({
    item,
    taskId: item?.metadata?.private?.appworld?.task_id ?? item?.sampleId,
  }))
  let detailed = new Map()
  try {
    detailed = detailedStateChangesBatch(root, prepared.flatMap(({ item, taskId }) =>
      typeof taskId === 'string' && taskId.trim() && typeof item?.id === 'string'
        ? [{
            id: item.id,
            taskId,
            experimentRunId: item.experimentRunId,
            experimentCaseId: item.experimentCaseId,
          }]
        : []))
  } catch {}
  return {
    items: prepared.map(({ item, taskId }) => {
      try {
        if (typeof taskId !== 'string' || !taskId.trim()) throw new Error('AppWorld task id is missing')
        const batchEvidence = detailed.get(item.id)
        const stateEvidence = batchEvidence && Array.isArray(batchEvidence.changes)
          ? { changes: batchEvidence.changes, status: 'complete' }
          : {
              changes: summaryStateChanges(root, item.experimentRunId, item.experimentCaseId, taskId),
              status: 'summary_only',
              error: 'Record-level AppWorld state evidence could not be reconstructed; model-level counts are shown.',
            }
        return {
          id: item.id,
          reference: buildReference({
            root,
            taskId,
            experimentRunId: item.experimentRunId,
            experimentCaseId: item.experimentCaseId,
            evaluation: item?.evaluation?.details ?? {},
            stateEvidence,
          }),
        }
      } catch (error) {
        return { id: item?.id, reference: unavailableReference(String(taskId ?? ''), error) }
      }
    }),
  }
}

async function cleanup(payload) {
  let state
  try { state = readState(payload) } catch { return { closed: false, reason: 'state-not-found' } }
  try { await post(state.endpoint, '/close', { task_id: state.taskId }, 30000) } catch {}
  terminate(state.pid)
  state.closedAt = new Date().toISOString()
  fs.writeFileSync(stateFile(path.resolve(payload.workspaceDir)), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return { closed: true, taskId: state.taskId, pid: state.pid }
}

function aggregate(payload) {
  const cases = Array.isArray(payload.cases) ? payload.cases : []
  const success = cases.map((item) => item.passed === true ? 1 : 0)
  const scenario = new Map()
  const difficulties = new Map()
  for (const item of cases) {
    const metadata = item.metadata?.private?.appworld ?? {}
    const scenarioId = metadata.scenario_id ?? String(metadata.task_id ?? item.sampleId).replace(/_\d+$/, '')
    const values = scenario.get(scenarioId) ?? []
    values.push(item.passed === true ? 1 : 0)
    scenario.set(scenarioId, values)
    const difficulty = Number(metadata.difficulty ?? item.evaluation?.metrics?.difficulty ?? 0)
    const difficultyValues = difficulties.get(difficulty) ?? []
    difficultyValues.push(item.passed === true ? 1 : 0)
    difficulties.set(difficulty, difficultyValues)
  }
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length * 100 : 0
  const tgc = average(success)
  const sgc = average([...scenario.values()].map((values) => Math.min(...values)))
  return {
    benchmark: 'appworld',
    taskGoalCompletion: tgc,
    scenarioGoalCompletion: sgc,
    tgc,
    sgc,
    numCases: cases.length,
    numTasks: new Set(cases.map((item) => item.sampleId)).size,
    numScenarios: scenario.size,
    byDifficulty: Object.fromEntries([...difficulties].map(([key, values]) => [String(key), {
      taskGoalCompletion: average(values),
      cases: values.length,
    }])),
    warnings: cases.length <= 1 ? ['Scenario goal completion is not meaningful for a single-task smoke run.'] : [],
  }
}

const handlers = { prepare, evaluate, cleanup, aggregate, reference }

if (path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '')) {
  try {
    const request = await readRequest()
    const handler = handlers[request.phase]
    if (!handler) throw new Error(`unsupported adapter phase: ${request.phase}`)
    const result = await handler(request.payload)
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }))
  } catch (error) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }))
    process.exitCode = 1
  }
}
