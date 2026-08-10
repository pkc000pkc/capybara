import type { ExperimentCaseDetail, ExperimentReference, ExperimentToolCall } from '#core/experiments/types'

const SENSITIVE_KEY = /(?:^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|credential|cookie|session[_-]?id|(?:payment[_-]?)?card[_-]?(?:number|digits)|cvv)(?:$|[_-])/i
const INLINE_SECRET = /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|credential|cookie|(?:payment[_-]?)?card[_-]?(?:number|digits)|cvv)\b\s*[=:]\s*)([^\s,;}\]]+)/gi
const BEARER_TOKEN = /(\bBearer\s+)[A-Za-z0-9._~+\/-]+=*/gi

function redactString(value: string): string {
  const redacted = value
    .replace(BEARER_TOKEN, '$1[REDACTED]')
    .replace(INLINE_SECRET, '$1[REDACTED]')
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return redacted
  try {
    return JSON.stringify(redactForPresentation(JSON.parse(value)), null, 2)
  } catch {
    return redacted
  }
}

export function redactForPresentation(
  value: unknown,
  key = '',
  seen = new WeakSet<object>(),
): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactString(value)
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactForPresentation(item, '', seen))
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    redactForPresentation(entryValue, entryKey, seen),
  ]))
}

export function redactToolCallsForPresentation(toolCalls: ExperimentToolCall[]): ExperimentToolCall[] {
  return toolCalls.map((call) => ({
    ...call,
    arguments: redactForPresentation(call.arguments),
    ...(call.resultPreview === undefined ? {} : { resultPreview: redactString(call.resultPreview) }),
    ...(call.error === undefined ? {} : { error: redactForPresentation(call.error) }),
  }))
}

export function redactReferenceForPresentation(reference: ExperimentReference): ExperimentReference {
  const redacted = redactForPresentation(reference) as ExperimentReference
  return {
    ...redacted,
    actualStateChanges: redacted.actualStateChanges.map((change) => ({
      ...change,
      ...(change.recordChanges === undefined
        ? {}
        : {
            recordChanges: change.recordChanges.map((record) => ({
              ...record,
              fields: record.fields.map((field) => SENSITIVE_KEY.test(field.field)
                ? { field: field.field, ...(field.before === undefined ? {} : { before: '[REDACTED]' }), ...(field.after === undefined ? {} : { after: '[REDACTED]' }) }
                : field),
            })),
          }),
    })),
  }
}

export function experimentCaseForPresentation(detail: ExperimentCaseDetail): ExperimentCaseDetail {
  return {
    ...detail,
    toolCalls: redactToolCallsForPresentation(detail.toolCalls),
    ...(detail.evaluation?.reference
      ? {
          evaluation: {
            ...detail.evaluation,
            reference: redactReferenceForPresentation(detail.evaluation.reference),
          },
        }
      : {}),
  }
}
