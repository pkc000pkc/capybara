/**
 * One official search execution with the opt-in Contacts retrieval plugin.
 *
 * This pilot deliberately creates a separate manifest/capability snapshot so
 * the ordinary two-plugin internal_pass5 plan and all non-search capabilities
 * remain unchanged. It is a real ARE/model run, but is not an official
 * submission campaign and never mutates the source manifests.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freezePluginSnapshot, inspectPluginResources } from '../src/phase0_inventory.mjs'
import { digest, fileDigest, readJson } from '../src/phase0_run.mjs'
import { executeOfficialTask, resolveModelRetrySettings } from '../src/phase1_official.mjs'
import { resolveRuntimeSettings } from '../src/phase1_config.mjs'
import { runFrozenBatch } from '../src/phase1_runner.mjs'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const portable = value => value.replaceAll('\\', '/')
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

function parseArgs(argv) {
  const values = { base: 'runs/small-batch-20261028-4/run-manifest.json' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!['--base-manifest', '--run-id'].includes(arg) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Usage: node scripts/search_retrieval_pilot.mjs [--base-manifest path] [--run-id id]')
    values[arg] = argv[++index]
  }
  return values
}

export async function runSearchRetrievalPilot({ root = ROOT, baseManifestPath = 'runs/small-batch-20261028-4/run-manifest.json', runId = `search-retrieval-pilot-${new Date().toISOString().replace(/[-:.]/g, '')}-${randomUUID().slice(0, 8)}`, signal } = {}) {
  root = resolve(root)
  const base = readJson(resolve(root, baseManifestPath))
  const sourceTask = base.tasks.find(task => task.phase === 'standard' && task.config === 'search' && task.runNumber === 1)
  if (!sourceTask) throw new Error('base manifest has no standard search run 1')
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(runId)) throw new Error('invalid pilot run id')
  const runRoot = `runs/${runId}`
  const runDirectory = resolve(root, runRoot)
  if (existsSync(runDirectory)) throw new Error(`pilot run already exists: ${runId}`)
  mkdirSync(runDirectory, { recursive: true })

  // Re-freeze all plugins for this isolated pilot so the run-local capability
  // lock binds the exact Hook sources under test.  The ordinary global lock
  // remains untouched; stale global snapshots must never silently run here.
  const refreshed = ['gaia2-runtime', 'gaia2-evaluation'].map(id => inspectPluginResources(freezePluginSnapshot({ root, id, sourceRoot: join(root, 'plugins', id) })))
  const retrieval = inspectPluginResources(freezePluginSnapshot({ root, id: 'gaia2-retrieval', sourceRoot: join(root, 'plugins', 'gaia2-retrieval') }))
  const currentCapabilities = readJson(resolve(root, 'locks/capability-inventory.json'))
  const capabilities = { ...currentCapabilities, plugins: [...refreshed, retrieval] }
  const capabilitiesPath = join(runDirectory, 'capability-inventory.json')
  writeJson(capabilitiesPath, capabilities)
  const capabilitiesRef = { path: portable(relative(root, capabilitiesPath)), sha256: fileDigest(capabilitiesPath) }

  const executionId = `standard-search-retrieval-${digest([sourceTask.scenarioId, runId]).slice(0, 16)}`
  const task = { ...sourceTask, executionId,
    outputDir: join(runRoot, 'executions', executionId), fixtureDir: join(runRoot, 'fixtures', executionId), workspaceDir: join(runRoot, 'workspaces', executionId) }
  const manifestContents = { ...base, runId, generatedAt: new Date().toISOString(), runRoot,
    stateFile: join(runRoot, 'run-state.json'), tasks: [task], retrieval: { enabled: true },
    selection: { ...base.selection, expectedInitialExecutions: 1, fullOfficialCoverage: false },
    lockRefs: { ...base.lockRefs, capabilities: capabilitiesRef },
    planFingerprint: digest({ basePlanFingerprint: base.planFingerprint, retrieval: retrieval.treeSha256, scenarioId: task.scenarioId }) }
  delete manifestContents.manifestHash
  const manifest = { ...manifestContents, manifestHash: digest(manifestContents) }
  writeJson(join(runDirectory, 'run-manifest.json'), manifest)

  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const settings = { ...resolveRuntimeSettings({ protocol: { requestedRuntime: manifest.requestedRuntime }, entrypoint: 'e2e', env: process.env }), modelRetry: resolveModelRetrySettings(process.env) }
  const report = await runFrozenBatch({ root, manifest, settings, executeTask: executeOfficialTask, signal, maxTasks: 1 })
  return { runId, manifestPath: portable(join(runRoot, 'run-manifest.json')), report }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const controller = new AbortController()
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort())
  try {
    const args = parseArgs(process.argv.slice(2))
    const result = await runSearchRetrievalPilot({ baseManifestPath: args['--base-manifest'], runId: args['--run-id'], signal: controller.signal })
    console.log(JSON.stringify({ status: result.report.status, runId: result.runId, counts: result.report.counts, businessSuccesses: result.report.businessSuccesses, businessFailures: result.report.businessFailures, technicalFailures: result.report.technicalFailures, manifestPath: result.manifestPath }, null, 2))
    if (result.report.status !== 'evaluation_complete') process.exitCode = 2
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: 'search_retrieval_pilot_failed', errorType: error?.name ?? 'Error' }))
    process.exitCode = 2
  }
}
