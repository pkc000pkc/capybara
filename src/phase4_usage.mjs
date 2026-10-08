import { createHash } from 'node:crypto'
import { existsSync, lstatSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { digest, within } from './phase0_run.mjs'
import { aggregateOperationalUsage } from './phase4_cost.mjs'
import { aggregatePhase4Metrics } from './phase4_metrics.mjs'
import { trainingEvidenceReader, verifyTrainingProbe } from './phase4_training.mjs'
import { verifyCorrectionReplay } from './phase4_replay.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const portable = value => value.replaceAll('\\', '/')
function check(value, code) { if (!value) throw new Error(`Phase 4 usage: ${code}`) }
function strictRef(ref) {
  check(ref && typeof ref === 'object' && !Array.isArray(ref) && digest(Object.keys(ref).sort()) === digest(['path', 'sha256'])
    && /^[a-f0-9]{64}$/.test(ref.sha256 ?? '') && typeof ref.path === 'string' && ref.path && !/[\\\0:]/.test(ref.path)
    && !ref.path.startsWith('/') && !ref.path.split('/').some(part => !part || part === '.' || part === '..'), 'unsafe_evidence_reference')
  return ref
}

/** Lexical containment alone is insufficient on Windows junctions/symlinks. */
export function assertSafeMetricsOutput({ root, path }) {
  check(typeof root === 'string' && typeof path === 'string' && path, 'invalid_output_path')
  const project = resolve(root), output = resolve(project, path)
  check(within(project, output) && output !== project, 'output_outside_project')
  for (let at = output; ; at = dirname(at)) {
    const entry = lstatSync(at, { throwIfNoEntry: false })
    if (entry) check(!entry.isSymbolicLink(), 'symbolic_output_ancestor')
    if (at === dirname(at)) break
  }
  check(!existsSync(output), 'immutable_output_already_exists')
  return output
}

/** Meter only independently bound reports. Missing/technical/unjudged work has
 * unknown cost, not zero; knownUsage is explicitly a partial observed subtotal.
 * This function verifies initial eligibility and ledger identities itself. */
export function aggregateCorrectionUsage({ root, manifest, initialResults = [], correctionLedger = null, readEvidence = trainingEvidenceReader(root) }) {
  const cache = new Map()
  const reader = path => { if (!cache.has(path)) { const bytes = readEvidence(path); check(Buffer.isBuffer(bytes), 'non_byte_evidence'); cache.set(path, Buffer.from(bytes)) } return Buffer.from(cache.get(path)) }
  const json = ref => { strictRef(ref); const bytes = reader(ref.path); check(sha(bytes) === ref.sha256, 'evidence_SHA_changed'); return JSON.parse(bytes) }
  const metrics = aggregatePhase4Metrics({ root, manifest, initialResults, correctionLedger, readEvidence: reader })
  const executions = [], verifiedExecutions = [], unknownExecutions = [], trainingReports = new Set()
  const unknown = (entry, kind, reason) => unknownExecutions.push({ parentExecutionId: entry?.parentExecutionId ?? null, kind, status: entry?.status ?? null, reason })
  const bind = (refs, path) => {
    const normalized = portable(path), matches = refs.filter(ref => normalized === ref.path || normalized.endsWith(`/${ref.path}`))
    check(matches.length === 1, 'usage_source_not_independently_bound')
    return strictRef(matches[0])
  }
  function meterTraining(entry, reportRef) {
    strictRef(reportRef)
    check(!trainingReports.has(reportRef.path), 'duplicate_training_report')
    const verified = verifyTrainingProbe({ root, trainingReportRef: reportRef, readEvidence: reader }), parent = verified.verifiedParent
    check(parent.manifest.manifestHash === manifest.manifestHash && parent.task.executionId === entry.parentExecutionId
      && parent.session.sessionId === entry.parentSessionId && parent.resultHash === entry.parentResultHash
      && verified.strategy.strategyHash === entry.strategyHash, 'training_usage_lineage_changed')
    const receipt = bind(verified.evidenceRefs, verified.hostResult.result.evidencePath)
    check(digest(receipt) === digest(entry.trainingReceipt), 'training_usage_receipt_changed')
    const operational = verified.hostResult.operationalReceipts[0]
    const eventsRef = bind(verified.evidenceRefs, `${portable(operational.directory)}/model-events.jsonl`)
    const providerProcessRef = bind(verified.evidenceRefs, `${portable(operational.directory)}/process/process-result.json`)
    const eventsBytes = reader(eventsRef.path); check(sha(eventsBytes) === eventsRef.sha256, 'events_SHA_changed')
    const events = eventsBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    check(digest(events) === digest(operational.events), 'training_usage_events_changed')
    const providerProcess = json(providerProcessRef), process = json(verified.report.hostProcess)
    check(digest(providerProcess) === digest(operational.process), 'training_usage_process_changed')
    const executionId = verified.spec.options.executionId
    executions.push({ executionId, kind: 'training', events, elapsedMs: process.elapsedMs })
    verifiedExecutions.push({ executionId, parentExecutionId: entry.parentExecutionId, kind: 'training', report: { ...reportRef },
      events: { ...eventsRef }, process: { ...verified.report.hostProcess }, providerProcess: { ...providerProcessRef }, trainingReceipt: { ...receipt } })
    trainingReports.add(reportRef.path)
  }
  if (correctionLedger === null) unknown(null, 'correction', 'missing_correction_ledger')
  for (const entry of correctionLedger?.entries ?? []) {
    if (entry.trainingReportRef != null) strictRef(entry.trainingReportRef)
    if (entry.status === 'skipped') continue // Independently re-derived/checked by metrics above.
    if (entry.status === 'replay_evaluated') {
      const replay = verifyCorrectionReplay({ root, replayReportRef: entry.replayReportRef, readEvidence: reader })
      const report = json(entry.replayReportRef), trainingRef = strictRef(report.correctionContext.trainingReportRef)
      if (entry.trainingReportRef != null) check(digest(entry.trainingReportRef) === digest(trainingRef), 'replay_training_report_changed')
      meterTraining(entry, trainingRef)
      const eventBytes = reader(strictRef(report.events).path); check(sha(eventBytes) === report.events.sha256, 'events_SHA_changed')
      const events = eventBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse), process = json(report.process)
      check(events.filter(event => event.type.startsWith('model_request_') || event.type === 'model_retry_scheduled').every(event => ['actor', 'judge'].includes(event.modelRole)), 'replay_has_training_model_events')
      executions.push({ executionId: replay.executionId, kind: 'replay', events, elapsedMs: process.elapsedMs })
      verifiedExecutions.push({ executionId: replay.executionId, parentExecutionId: entry.parentExecutionId, kind: 'replay',
        report: { ...entry.replayReportRef }, events: { ...report.events }, process: { ...report.process }, sourceHash: replay.sourceHash })
    } else {
      if (entry.trainingReportRef != null && ['strategy_ready', 'replay_technical'].includes(entry.status)) meterTraining(entry, entry.trainingReportRef)
      else unknown(entry, 'training', entry.status === 'training_failed' ? 'failed_training_not_independently_verified' : 'missing_independently_verified_training_report')
      unknown(entry, 'replay', entry.status === 'replay_technical' ? 'technical_replay_not_independently_verified' : 'replay_not_evaluated')
    }
  }
  for (const entry of metrics.correctionResults.filter(entry => entry.status === 'unresolved')) unknown(entry, 'correction', entry.reason)
  const knownUsage = aggregateOperationalUsage({ executions }), correctionUsageComplete = unknownExecutions.length === 0
  return { schemaVersion: 'gaia2-phase4-correction-usage-v1', manifestHash: manifest.manifestHash,
    correctionUsageComplete, usage: correctionUsageComplete ? knownUsage : null, knownUsage, verifiedExecutions, unknownExecutions,
    initialExecutionsIncluded: false, correctionExecutionsCountedAsInitial: 0, noModelExecution: true,
    realCorrectionEndToEndReady: false, officialSubmissionReady: false }
}
