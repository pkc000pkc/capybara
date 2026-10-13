import { buildFailureDiagnostics } from './phase1_diagnostics.mjs'

/** Infrastructure failures are distinct from an actual judged business result.
 * This function deliberately ignores raw exception text and shared old reports.
 * Pass only the current execution's report and evaluator-blind runtime events.
 */
export function classifyExecutionFailure({ processResult = {}, report = null, events = [] } = {}) {
  const diagnostic = buildFailureDiagnostics({ processResult, report, events })
  const result = (category, retryable = false, metadata = {}) => ({ category, retryable, ...metadata,
    ...(diagnostic.causes.length ? { diagnostic } : {}) })
  if (processResult.timedOut || processResult.timeout || processResult.error?.code === 'ETIMEDOUT') return result('process_timeout', true)
  if (processResult.interrupted || processResult.cancelled || ['SIGINT', 'SIGTERM'].includes(processResult.signal)) return result('interrupted', true)
  if (processResult.spawnError || processResult.loggingError || processResult.heartbeatError || processResult.terminationErrors?.length) return result('runtime_error')
  const failures = events.filter((event) => event?.type === 'model_request_failed')
  // A later successful response for the same request means its transient
  // failures were recovered.  Do not blame a subsequent business failure on it.
  const successfulIds = new Set(events.filter((event) => event?.type === 'model_request_succeeded').map((event) => event.requestId).filter(Boolean))
  const failure = failures.findLast((event) => !successfulIds.has(event.requestId))
  if (failure && ['rate_limit', 'request_timeout', 'transport_error', 'configuration_error', 'runtime_error'].includes(failure.category)) {
    return result(failure.category, failure.retryable === true, {
      httpStatus: Number.isInteger(failure.httpStatus) ? failure.httpStatus : null,
      nextRetryAt: validDate(failure.nextRetryAt),
      retryExhausted: failure.retryExhausted === true,
      requestAttempts: Number.isInteger(failure.requestAttempt) ? failure.requestAttempt : null,
      cumulativeWaitSeconds: Number.isFinite(failure.cumulativeWaitSeconds) ? failure.cumulativeWaitSeconds : 0,
      modelRole: ['actor', 'judge', 'child_actor'].includes(failure.modelRole) ? failure.modelRole : null,
    })
  }
  const exitCode = Object.hasOwn(processResult, 'exitCode') ? processResult.exitCode : Object.hasOwn(processResult, 'status') ? processResult.status : 0
  if (processResult.error || exitCode !== 0 || processResult.signal || report?.hasException === true || report?.has_exception === true || report?.exception != null || report?.exceptionType) return result('runtime_error')
  // A numerical score/"failed" label alone is not proof of completed judging.
  const judged = report?.evaluationComplete === true || report?.judged === true || report?.judgeStatus === 'completed'
  if (judged && (report?.businessPassed === false || report?.passed === false || report?.validationPassed === false || report?.status === 'failed' || report?.score === 0)) return result('business_failure')
  return result('missing_result', true)
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
}
