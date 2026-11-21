import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { RuntimeLoop, type RuntimeLlm } from '#core/runtime-loop'
import { initializeProjectDirectory } from '#core/project-initializer'
import { createLlmService, type LlmChatRequest, type LlmChatResponse } from '#util/llm'
import { v2PromptManifest } from '#core/v2-prompts'
import type { ClientCommand } from '#protocol/runtime-protocol'

interface Scenario {
  id: string
  sourceA: string[]
  sourceB: string[]
  question: string
  followUp: string
  first: Record<string, string>
  second: Record<string, string>
}

const cases: Scenario[] = [
  {
    id: 'refund-dispute',
    sourceA: ['退款台账 A', '对象 RQ-8047', '建议先执行补款 347.80 SGD', '依据记录 A-93JQ', '有效截止 2027-01-17T09:25Z'],
    sourceB: ['清算邮件 B', '对象 RQ-8047', '建议暂缓补款，差额 312.45 SGD', '依据票据 B-48VR', '有效截止 2027-01-19T15:40Z'],
    question: '请核对工单两份材料。保留两方建议，给出对象、A 的操作（执行或暂缓）、A 的金额（两位小数，带货币）、B 的操作、B 的金额。',
    first: { item: 'RQ-8047', actionA: '执行', amountA: '347.80 SGD', actionB: '暂缓', amountB: '312.45 SGD' },
    followUp: '现在补充同一工单的来源索引。分别给出 A 的依据号和有效截止时间、B 的依据号和有效截止时间。时间保持原始格式。无需重新读取文件。',
    second: { proofA: 'A-93JQ', cutoffA: '2027-01-17T09:25Z', proofB: 'B-48VR', cutoffB: '2027-01-19T15:40Z' },
  },
  {
    id: 'shipment-exception',
    sourceA: ['运输规范 A', '批次 MC-7302', '常规方案送 RIVER-17', '冷藏阈值 7.4 °C', '若出现红签必须暂缓，依据 A-6RP'],
    sourceB: ['装车说明 B', '批次 MC-7302', '常规方案送 PORT-83', '冷藏阈值 6.1 °C', '若出现红签仍继续，依据 B-4MX'],
    question: '整理交接单上的批次、两份材料各自的常规目的地和冷藏阈值。阈值使用原文的“数值 °C”格式，两种主张并列。',
    first: { item: 'MC-7302', depotA: 'RIVER-17', limitA: '7.4 °C', depotB: 'PORT-83', limitB: '6.1 °C' },
    followUp: '现收到红签，请给出两份材料各自的操作（暂缓或继续）和各自依据号。保留各自要求。无需重新读取文件。',
    second: { actionA: '暂缓', proofA: 'A-6RP', actionB: '继续', proofB: 'B-4MX' },
  },
]

interface CallMetric {
  userTurn: number
  promptBytes: number
  rawReadGroups: number
  input: number | null
  output: number | null
  cacheRead: number | null
}
const contextBudget = { context_window_tokens: 64000, max_input_tokens: 48000, reserved_output_tokens: 4096 }

function metric(request: LlmChatRequest, response: LlmChatResponse, userTurn: number): CallMetric {
  return {
    userTurn,
    promptBytes: Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools ?? [] })),
    rawReadGroups: request.messages.filter(message => message.role === 'tool' && message.name === 'read_file').length,
    input: response.usage?.inputTokens ?? null,
    output: response.usage?.outputTokens ?? null,
    cacheRead: response.usage?.cacheReadTokens ?? null,
  }
}

function total(calls: CallMetric[], key: 'input' | 'output'): number | null {
  return calls.some(call => call[key] === null) ? null : calls.reduce((sum, call) => sum + (call[key] ?? 0), 0)
}

function material(lines: string[], label: string): string {
  const noise = Array.from({ length: 39 }, (_, index) => `回查流水 ${label}-${String(index).padStart(3, '0')}，附件已由双人扫描，纸本按值班例行要求装订，不含本工单的决定。`)
  return [lines[0], ...noise.slice(0, 14), ...lines.slice(1, 3), ...noise.slice(14), ...lines.slice(3)].join('\n')
}

function score(text: string, expected: Record<string, string>) {
  let answer: Record<string, unknown> = {}
  let validObject = false
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      answer = value as Record<string, unknown>
      validObject = true
    }
  } catch { /* Surrounding text and malformed JSON score no fields. */ }
  const fields = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, answer[key] === value]))
  const validShape = validObject && Object.keys(answer).length === Object.keys(expected).length
    && Object.keys(expected).every(key => Object.hasOwn(answer, key) && typeof answer[key] === 'string')
  return { fields, validShape, correct: Object.values(fields).filter(Boolean).length, expected: Object.keys(expected).length, answer, reply: text }
}

function runTurn(loop: RuntimeLoop, text: string, sequence: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error('EVAL_TURN_TIMEOUT')) }, 300_000)
    const unsubscribe = loop.onEvent(event => {
      if (event.type !== 'run.state.changed' || !['completed', 'failed', 'cancelled', 'paused'].includes(event.payload.status)) return
      clearTimeout(timer)
      unsubscribe()
      if (event.payload.status === 'completed') resolve()
      else {
        const failure = event.payload.failure
        const detail = failure?.code.startsWith('RUNTIME_') ? ` · ${failure.message.slice(0, 300)}` : ''
        reject(new Error(`${failure?.code ?? (event.payload.status === 'paused' ? 'EVAL_UNEXPECTED_WAIT' : 'EVAL_TURN_FAILED')}${detail}`))
      }
    })
    const command: ClientCommand = { version: 1, kind: 'command', id: `quality-${sequence}`, sessionId: 'quality-session',
      timestamp: new Date().toISOString(), type: 'chat.message.send',
      payload: { clientMessageId: `quality-user-${sequence}`, content: [{ type: 'text', text }], autoStart: true } }
    try {
      loop.validate(command)
      loop.execute(command, sequence)
    } catch (error) {
      clearTimeout(timer)
      unsubscribe()
      reject(error)
    }
  })
}

async function evaluate(scenario: Scenario, variant: 'raw' | 'organized', mainService: RuntimeLlm, organizeService: RuntimeLlm) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-context-quality-'))
  let loop: RuntimeLoop | undefined
  const mainCalls: CallMetric[] = [], organizerCalls: CallMetric[] = []
  const errors: string[] = []
  try {
    initializeProjectDirectory(sandbox)
    fs.writeFileSync(path.join(sandbox, 'source-a.txt'), material(scenario.sourceA, 'A'))
    fs.writeFileSync(path.join(sandbox, 'source-b.txt'), material(scenario.sourceB, 'B'))
    const configPath = path.join(sandbox, '.capybara', 'config.json')
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    config.context = { ...config.context, ...contextBudget }
    config.tool_permissions = ['filesystem:read']
    fs.writeFileSync(configPath, JSON.stringify(config))
    let calls = 0
    let userTurn = 0
    const main: RuntimeLlm = { getConfig: () => mainService.getConfig(),
      get admitsTransportAttempts() { return mainService.admitsTransportAttempts === true },
      async chat(request) {
        const round = ++calls
        if (round <= 2) return { provider: 'custom', model: 'fixture-read', raw: {}, text: '', toolCalls: round === 1
          ? [{ id: 'fixture-load', name: 'load_resources', arguments: { ids: ['project-files:read_file'] } }]
          : ['a', 'b'].map(source => ({ id: `fixture-read-${source}`, name: 'read_file', arguments: { file_name: `source-${source}.txt`, include_line_numbers: false } })) }
        const response = await mainService.chat(request)
        mainCalls.push(metric(request, response, userTurn))
        return response
      },
    }
    const organizer: RuntimeLlm = { getConfig: () => organizeService.getConfig(),
      get admitsTransportAttempts() { return organizeService.admitsTransportAttempts === true },
      async chat(request) {
        const response = await organizeService.chat(request)
        organizerCalls.push(metric(request, response, userTurn))
        return response
      },
    }
    // Both arms use the same V2 renderer and history store. The generous context
    // window keeps this fixture beneath automatic pressure in the raw arm.
    loop = new RuntimeLoop({ projectDir: sandbox, sessionId: 'quality-session', llm: main, stepDelayMs: 0, streamDelayMs: 0,
      contextAssistant: { modes: [] }, contextOrganization: { minGroups: variant === 'raw' ? 1000 : 3, chunkCharacters: 24000, llm: organizer } })
    const answers = []
    const firstMainCalls: CallMetric[] = []
    for (const [index, question, expected] of [[1, scenario.question, scenario.first], [2, scenario.followUp, scenario.second]] as const) {
      userTurn = index
      const previousCallCount = mainCalls.length
      try {
        await runTurn(loop, `${question} 用户可见答复只包含一个 JSON 对象，字段为 ${Object.keys(expected).join('、')}，所有值使用字符串。省略代码围栏和对象外的说明。有给定选项的字段只写所选词。资料没有提供的值写“未知”，本题无需向用户确认。`, index)
        const latest = [...loop.exportState().snapshot.conversation.messages].reverse()
          .find(message => message.role === 'assistant' && message.status === 'completed')
        answers.push(score(latest?.content.map(part => part.type === 'text' ? part.text : '').join('') ?? '', expected))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'EVAL_TURN_FAILED')
        break
      } finally {
        const firstCall = mainCalls[previousCallCount]
        if (firstCall) firstMainCalls.push(firstCall)
      }
    }
    const state = loop.exportState()
    const history = state.contextHistory?.messages ?? []
    const reads = history.filter(entry => entry.origin === 'tool' && entry.message.name === 'read_file')
    const rawSources = reads.flatMap(entry => {
      try {
        const result = JSON.parse(entry.message.content).result
        return typeof result?.content === 'string'
          ? [{ path: result.path, hash: createHash('sha256').update(result.content).digest('hex') }] : []
      } catch { return [] }
    }).sort((a, b) => String(a.path).localeCompare(String(b.path)))
    const information = state.contextDocument?.information.filter(entry => entry.status === 'active') ?? []
    const expectedByField = { ...scenario.first, ...scenario.second }
    const documentFacts = Object.fromEntries(Object.entries(expectedByField).map(([field, value]) => {
      const side = field.match(/[AB]$/)?.[0]?.toLowerCase()
      const sources = reads.filter(entry => !side || entry.message.toolCallId === `fixture-read-${side}`)
      const sourceRefs = new Set(sources.map(entry => entry.sourceArtifactId ?? entry.id))
      const evidence = new Set(state.contextDocument?.evidence.filter(entry => sourceRefs.has(entry.referenceId)).map(entry => entry.id))
      const retained = information.some(entry => entry.body.includes(value) && entry.evidenceRefs.some(id => evidence.has(id)))
      return [field, retained]
    }))
    const organizationOutcomes = state.contextTrainingSamples?.flatMap(sample => sample.organization
      ? [{ committed: sample.organization.committed, error: sample.organization.errorCode, attempts: sample.organization.attempts.length }] : []) ?? []
    return { variant, errors, answers, mainCalls, organizerCalls, originalReadCount: reads.length, rawSources,
      recallCalls: history.filter(entry => entry.origin === 'tool' && entry.message.name === 'recall_context').length,
      documentFacts, organizationOutcomes,
      coveredThrough: state.contextHistory?.coverage.coveredThrough ?? 0,
      firstMainCallCount: firstMainCalls.length,
      additionalMainCallCount: mainCalls.length - firstMainCalls.length,
      firstMainInput: total(firstMainCalls, 'input'),
      firstCombinedInput: total([...firstMainCalls, ...organizerCalls], 'input'),
      mainInput: total(mainCalls, 'input'), mainOutput: total(mainCalls, 'output'),
      combinedInput: total([...mainCalls, ...organizerCalls], 'input'), combinedOutput: total([...mainCalls, ...organizerCalls], 'output'),
    }
  } finally {
    await loop?.shutdown()
    await fs.promises.rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 80 })
  }
}

async function main() {
  const selected = process.argv[2]
  const suite = selected ? cases.filter(scenario => scenario.id === selected) : cases
  if (!suite.length) throw new Error('Unknown context evaluation scenario')
  const model = createLlmService()
  const explicitOrganizer = process.env.CAPYBARA_EVAL_ORGANIZER_MODEL
  const baseUrl = process.env.CAPYBARA_EVAL_ORGANIZER_BASE_URL
  if (Boolean(explicitOrganizer) !== Boolean(baseUrl)) throw new Error('Set both organizer model and base URL')
  const organizer = explicitOrganizer && baseUrl ? createLlmService({ provider: 'custom', protocol: 'chat-completions',
    model: explicitOrganizer, baseUrl, apiKey: process.env.CAPYBARA_EVAL_ORGANIZER_API_KEY ?? '' }) : model
  const rows: Array<{ id: string; comparable: boolean; deliveryPassed: boolean; comparison: Record<string, number | null>;
    raw: Awaited<ReturnType<typeof evaluate>>; organized: Awaited<ReturnType<typeof evaluate>> }> = []
  const report = { schemaVersion: 2, mainModel: model.getConfig().model, organizerModel: organizer.getConfig().model,
    separateOrganizer: organizer !== model, fixtureReadRounds: 2, contextBudget,
    promptBindings: v2PromptManifest(['constitution', 'runtime', 'context-organizer']), results: rows }
  const reportFile = process.env.CAPYBARA_EVAL_REPORT_PATH
  for (const scenario of suite) {
    const raw = await evaluate(scenario, 'raw', model, organizer)
    const organized = await evaluate(scenario, 'organized', model, organizer)
    const comparable = raw.originalReadCount === 2 && organized.originalReadCount === 2 && raw.organizerCalls.length === 0
      && raw.rawSources.length === 2 && JSON.stringify(raw.rawSources) === JSON.stringify(organized.rawSources)
      && raw.coveredThrough === 0 && raw.mainCalls.every(call => call.rawReadGroups === 2)
      && organized.coveredThrough > 0 && organized.mainCalls.every(call => call.rawReadGroups === 0)
      && [raw, organized].every(arm => arm.errors.length === 0 && arm.answers.length === 2 && arm.firstMainCallCount === 2)
    const deliveryPassed = [raw, organized].every(arm => arm.errors.length === 0 && arm.answers.length === 2
      && arm.answers.every(answer => answer.validShape && answer.correct === answer.expected))
    const difference = (before: number | null, after: number | null) =>
      comparable && deliveryPassed && before !== null && after !== null ? after - before : null
    rows.push({ id: scenario.id, comparable, deliveryPassed, comparison: {
      correctFieldsDelta: comparable ? organized.answers.reduce((n, answer) => n + answer.correct, 0) - raw.answers.reduce((n, answer) => n + answer.correct, 0) : null,
      firstMainInputDelta: difference(raw.firstMainInput, organized.firstMainInput),
      firstCombinedInputDelta: difference(raw.firstCombinedInput, organized.firstCombinedInput),
      mainInputDelta: difference(raw.mainInput, organized.mainInput),
      combinedInputDelta: difference(raw.combinedInput, organized.combinedInput),
      combinedOutputDelta: difference(raw.combinedOutput, organized.combinedOutput),
    }, raw, organized })
    if (reportFile) fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (rows.some(row => !row.comparable || !row.deliveryPassed)) process.exitCode = 1
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'EVAL_FAILED'}\n`); process.exitCode = 1 })
