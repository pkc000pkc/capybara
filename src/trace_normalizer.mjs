import { createHash } from 'node:crypto'

function canonical(value) {
  return JSON.stringify(value)
}

/** Export only verifier-shaped metadata; raw action arguments remain excluded. */
export function normalizeTrace({ scenarioId, capability, events = [], actions = [], attempts = [], outcome = {} }) {
  if (!scenarioId || !capability) throw new Error('scenarioId and capability are required')
  const trace = {
    schemaVersion: 'gaia2-capybara-trace-v1',
    scenarioId,
    capability,
    events: events.map((event) => ({
      id: event.id ?? event.occurrence,
      type: event.type,
      scheduledAt: event.scheduledAt ?? null,
      source: event.source ?? null,
    })),
    actions: actions.map((action) => ({
      actionId: action.actionId,
      toolName: action.toolName,
      operation: action.operation,
      argsHash: action.argsHash,
      startedAt: action.startedAt,
      completedAt: action.completedAt ?? null,
      parentActionIds: [...(action.parentActionIds ?? [])],
      result: action.result,
      retryOf: action.retryOf ?? null,
    })),
    attempts: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      parentAttemptId: attempt.parentAttemptId ?? null,
      state: attempt.state,
      reason: attempt.reason,
    })),
    outcome: {
      execution: outcome.execution ?? 'not_evaluated',
      benchmark: outcome.benchmark ?? 'not_evaluated',
    },
  }
  return {
    ...trace,
    traceHash: createHash('sha256').update(canonical(trace)).digest('hex'),
  }
}
