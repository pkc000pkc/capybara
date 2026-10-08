import { createHash } from 'node:crypto'
import * as training from './phase4_training.mjs'
import { digest } from './phase0_run.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const portable = value => value.replaceAll('\\', '/')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function check(value, code) { if (!value) throw new Error(`Phase 4 replay authority: ${code}`) }
function exact(value, keys, code) { check(object(value) && digest(Object.keys(value).sort()) === digest([...keys].sort()), code) }

export function assertInitialHasNoCorrection(task) {
  check((task.correctionOrdinal ?? 0) === 0 && !Object.hasOwn(task, 'correctionContext'), 'initial_attempt_has_correction')
}

/** This is a verifier, not an initializer API: no caller supplied strategy text is accepted. */
export function verifyCorrectionReplayAuthority({ root, manifest, task, trainingReportRef = task?.correctionContext?.trainingReportRef, readEvidence }) {
  check(typeof training.verifyTrainingProbe === 'function', 'training_verifier_unavailable')
  exact(trainingReportRef, ['path', 'sha256'], 'training_report_reference')
  const originalReader = readEvidence ?? training.trainingEvidenceReader(root), consumed = new Map()
  const reader = path => {
    if (!consumed.has(path)) {
      const bytes = originalReader(path); check(Buffer.isBuffer(bytes), 'non_byte_evidence')
      consumed.set(path, Buffer.from(bytes))
    }
    return consumed.get(path)
  }
  const verified = training.verifyTrainingProbe({ root, trainingReportRef, readEvidence: reader })
  const { report, verifiedParent: parent, strategy } = verified
  check(report.status === 'strategy_ready' && strategy?.freshReplayRequired === true && strategy.attemptCountDelta === 0, 'strategy_not_ready')
  check(task.correctionOrdinal === 1 && task.executionId !== parent.task.executionId && manifest.mode === 'correction_replay'
    && manifest.schemaVersion === 'gaia2-correction-replay-manifest-v1' && manifest.initialManifestHash === parent.manifest.manifestHash, 'not_fresh_correction_execution')
  check(typeof manifest.runRoot === 'string' && /^runs\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(manifest.runRoot), 'unsafe_replay_root')
  for (const [key, suffix] of [['workspaceDir', 'workspace'], ['outputDir', 'output'], ['fixtureDir', 'fixture']]) check(task[key] === `${manifest.runRoot}/${suffix}` && task[key] !== parent.session[key], 'replay_paths_not_fresh')
  for (const key of ['scenarioId', 'scenarioHash', 'scenarioVersion', 'sourcePath', 'rowIndex', 'runNumber', 'attemptIndex', 'phase', 'config']) check(task[key] === parent.task[key], `original_task_${key}_changed`)
  check(task.attemptIndex === task.runNumber && manifest.tasks?.length === 1 && digest(manifest.tasks[0]) === digest(task), 'replay_task_binding')
  check(manifest.initialAttemptCountDelta === 0 && manifest.officialSubmissionReady === false, 'initial_or_export_contamination')
  const frozenTrainingManifest = JSON.parse(reader(report.trainingManifest.path).toString('utf8'))
  check(manifest.trainingManifestHash === frozenTrainingManifest.manifestHash && digest(manifest.lockRefs) === digest(frozenTrainingManifest.lockRefs)
    && digest(manifest.models) === digest(frozenTrainingManifest.models) && digest(manifest.dataset) === digest(frozenTrainingManifest.dataset), 'replay_baseline_differs_from_training')
  const receiptPath = portable(verified.hostResult?.result?.evidencePath ?? '')
  const receiptRef = verified.evidenceRefs?.find(ref => receiptPath === ref.path || receiptPath.endsWith(`/${ref.path}`))
  check(receiptRef, 'missing_actual_training_receipt')
  const receiptBytes = reader(receiptRef.path), receipt = JSON.parse(receiptBytes.toString('utf8'))
  check(sha(receiptBytes) === receiptRef.sha256 && receipt.schemaVersion === 'capybara-training-plugin-invocation-v1'
    && receipt.status === 'passed' && receipt.hookReceipts?.some(item => item.hookId === 'gaia2-correction' && item.status === 'passed'), 'actual_training_receipt_invalid')
  const context = {
    schemaVersion: 'gaia2-phase4-replay-context-v1', trainingReportRef: { ...trainingReportRef },
    parentExecutionId: parent.task.executionId, parentSessionId: parent.session.sessionId,
    parentResultHash: report.parentResultHash, parentManifestHash: parent.manifest.manifestHash,
    sanitizedInputHash: report.trainingInputHash, trainingReceiptHash: sha(receiptBytes),
    planHash: strategy.planHash, strategyHash: strategy.strategyHash, correctionOrdinal: 1,
  }
  if (Object.hasOwn(task, 'correctionContext')) {
    exact(task.correctionContext, Object.keys(context), 'correction_context_shape')
    check(digest(task.correctionContext) === digest(context), 'correction_lineage_changed')
  }
  check(typeof strategy.strategyText === 'string' && strategy.strategyText.trim() && sha(strategy.strategyText) === context.strategyHash, 'fixed_strategy_hash')
  // Binding includes only provenance and fixed-template hashes; no parent data enters the variable.
  const initializer = { key: 'gaia2_experiment_context', value: strategy.strategyText, bindingHash: digest(context) }
  return { verified, context, initializer, consumed, trainingReceipt: { ...receiptRef } }
}
