import { createHash } from 'node:crypto'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const DERIVED_ACTION_FIELDS = new Set(['argumentHash', 'argumentFieldHashes', 'argumentFieldNumbers', 'argumentMetadataComplete'])

function stripDerivedActionMetadata(value) {
  if (!plain(value)) return value
  if (!plain(value.action)) return value
  const action = Object.fromEntries(Object.entries(value.action).filter(([key]) => !DERIVED_ACTION_FIELDS.has(key)))
  return { ...value, action }
}

/** Hash the caller-visible invocation, ignoring only trusted Host-derived
 * argument metadata added after admission. */
export function hostInvocationDigest(value) {
  return createHash('sha256').update(JSON.stringify(stripDerivedActionMetadata(value))).digest('hex')
}
