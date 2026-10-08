import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { readJson, writeJson, within } from './phase0_run.mjs'
import { modelRuntimeEnvironment, readModelConnection } from './phase1_official.mjs'
import { runChildProcess } from './phase1_process.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
export function healthyTrainingProcess(value) {
  return value?.exitCode === 0 && value.childExited === true && value.childClosed === true
    && !value.signal && !value.spawnError && !value.loggingError && !value.heartbeatError
    && !value.timedOut && !value.interrupted && !value.manualInspectionRequired
    && Array.isArray(value.terminationErrors) && value.terminationErrors.length === 0
}

/** The callback lives in the trusted process, never in the Hook's VM realm. */
export function createTrainingBroker({ root, workspaceDir, models, settings, connection = null }) {
  root = resolve(root); workspaceDir = resolve(workspaceDir)
  if (!within(root, workspaceDir) || workspaceDir === root || !lstatSync(workspaceDir).isDirectory()) throw new Error('invalid training workspace')
  const protocol = readJson(join(root, 'config/phase0-protocol.json'))
  const active = connection ?? readModelConnection(root, models)
  // ARE's `local` label denotes the configured OpenAI-compatible endpoint;
  // it is not a LiteLLM provider identifier. Keep the manifest unchanged and
  // select the explicit transport rather than rely on a stale model-name map.
  const provider = models.actor.provider == null || models.actor.provider === 'local' ? 'openai' : models.actor.provider
  const brokerRoot = join(workspaceDir, 'provider'); mkdirSync(brokerRoot)
  const operationalReceipts = []
  const broker = async (request, context) => {
    if (!request || Object.keys(request).some(key => !['input', 'max_output_tokens'].includes(key)) || typeof request.input !== 'string'
      || Buffer.byteLength(request.input) > 30000 || !Number.isInteger(request.max_output_tokens) || request.max_output_tokens < 1 || request.max_output_tokens > 2000) throw new Error('TRAINING_PROVIDER_REQUEST_INVALID')
    const callRoot = join(brokerRoot, randomUUID()); mkdirSync(callRoot)
    const inputPath = join(callRoot, 'input.json'), outputPath = join(callRoot, 'response.json'), eventPath = join(callRoot, 'model-events.jsonl')
    writeJson(inputPath, request, { immutable: true })
    const filtered = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API_KEY|ACCESS_TOKEN|AUTHORIZATION|HF_TOKEN|HUGGINGFACE_TOKEN|GAIA2_HOOK_TOKEN)/i.test(key)))
    const result = await runChildProcess({ command: resolve(root, protocol.runtime.python),
      args: [join(root, 'scripts/phase4_training_broker.py'), inputPath, outputPath], cwd: workspaceDir,
      env: { ...filtered, ...modelRuntimeEnvironment(settings), PYTHONPATH: resolve(root, protocol.runtime.officialPythonPath), PYTHONUTF8: '1',
        LITELLM_LOCAL_MODEL_COST_MAP: 'True', LITELLM_TELEMETRY: 'False', HF_HUB_OFFLINE: '1', HF_DATASETS_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
        OPENAI_API_KEY: active.apiKey, GAIA2_TRAINING_MODEL: models.actor.model, GAIA2_TRAINING_ENDPOINT: active.baseUrl,
        GAIA2_TRAINING_PROVIDER: provider,
        GAIA2_TRAINING_MODEL_EVENTS: eventPath, TMP: workspaceDir, TEMP: workspaceDir, TMPDIR: workspaceDir },
      outputDir: join(callRoot, 'process'), processTimeoutMs: settings.processTimeoutMs,
      heartbeatIntervalMs: settings.heartbeatIntervalMs, signal: context.signal, secrets: [active.apiKey] })
    // Preserve ownership/cleanup evidence before parsing optional model logs.
    // A corrupt log must never erase a potentially still-running child.
    const receipt = { requestId: context.requestId, requestHash: hash(JSON.stringify(request)),
      directory: callRoot, processHealthy: healthyTrainingProcess(result), events: [], eventsReadable: false, process: result }
    operationalReceipts.push(receipt)
    try {
      if (!existsSync(eventPath)) throw new Error('missing model events')
      receipt.events = readFileSync(eventPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
      receipt.eventsReadable = true
    } catch {
      receipt.evidenceError = 'model_event_evidence_unreadable'
      throw new Error('TRAINING_PROVIDER_EVIDENCE_UNREADABLE')
    }
    if (!healthyTrainingProcess(result) || !existsSync(outputPath)) throw new Error('TRAINING_PROVIDER_FAILED')
    const response = readJson(outputPath)
    if (Object.keys(response).some(key => !['output_text', 'usage'].includes(key)) || typeof response.output_text !== 'string' || !response.output_text.trim()
      || Buffer.byteLength(response.output_text) > 32768) throw new Error('TRAINING_PROVIDER_RESPONSE_INVALID')
    // The Host only receives this bounded facade. No endpoint/config/raw/error
    // body is returned even if the provider or SDK exposes one.
    return response
  }
  return { broker, operationalReceipts }
}
