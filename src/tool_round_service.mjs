/** Authenticated-transport adapter for the backend's shared ordered scheduler. */
import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('TOOL_ROUND_RPC_SCHEMA')
}

export function createToolRoundService({ Scheduler, workspaceDir, executionId, sessionId }) {
  const root = resolve(workspaceDir), directory = join(root, 'tool-round-runtime')
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('TOOL_ROUND_WORKSPACE')
  mkdirSync(directory, { recursive: false })
  const scheduler = new Scheduler()
  let sequence = 0
  return {
    invoke(input) {
      const base = ['executionId', 'sessionId', 'op', 'requestId', 'roundId']
      if (!plain(input) || input.executionId !== executionId || input.sessionId !== sessionId
        || typeof input.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(input.requestId)) throw new Error('TOOL_ROUND_RPC_IDENTITY')
      let node = null, state
      if (input.op === 'begin') {
        exact(input, [...base, 'calls', 'exclusiveToolNames'])
        state = scheduler.begin(input.roundId, input.calls, { exclusiveToolNames: input.exclusiveToolNames })
      } else if (input.op === 'next') {
        exact(input, base)
        node = scheduler.next(input.roundId)
        state = scheduler.snapshot(input.roundId)
      } else if (input.op === 'settle') {
        exact(input, [...base, 'settlement'])
        state = scheduler.settle(input.roundId, input.settlement)
      } else if (input.op === 'cancel') {
        exact(input, [...base, 'reason'])
        state = scheduler.cancel(input.roundId, input.reason)
      } else throw new Error('TOOL_ROUND_RPC_OPERATION')
      const result = { schemaVersion: 'gaia2-tool-round-receipt-v1', executionId, sessionId,
        op: input.op, requestId: input.requestId, roundId: input.roundId, state, node }
      const bytes = Buffer.from(JSON.stringify({ schemaVersion: 'gaia2-tool-round-evidence-v1', request: input, response: result }) + '\n')
      const name = `${String(++sequence).padStart(6, '0')}-${randomUUID().replaceAll('-', '')}.json`
      writeFileSync(join(directory, name), bytes, { flag: 'wx' })
      return { ...result, sourceRef: { path: `tool-round-runtime/${name}`, sha256: createHash('sha256').update(bytes).digest('hex') } }
    },
  }
}
