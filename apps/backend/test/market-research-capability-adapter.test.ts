import assert from 'node:assert/strict'
import test from 'node:test'

import { MarketResearchCapabilityAdapter } from '#core/market-research-capability-adapter'
import { MarketResearchService } from '#core/market-research-service'
import { ProductCapabilityRegistry } from '#core/product-capability-registry'
import { ProductWorkLedger } from '#core/product-work-ledger'

test('market research adapter is discoverable and preserves unknown when providers are unavailable', async () => {
  const ledger = new ProductWorkLedger({ projectId: 'market-project' })
  const adapter = new MarketResearchCapabilityAdapter(new MarketResearchService({ ledger }))
  const registry = new ProductCapabilityRegistry({ ledger, projectId: 'market-project' })
  registry.register(adapter.descriptor, adapter)
  const result = await registry.execute({ capabilityId: 'market-research', runId: 'market-run', operation: 'research', input: { ticker: '000682', exchange: 'SZ', reportUrls: [] }, target: { projectId: 'market-project', objectId: '000682' }, idempotencyKey: 'market-research:000682', projectId: 'market-project' }, { preAuthorized: true, scopeAllowed: true, policyAllowed: true, authorized: true })
  assert.equal(result.admission.disposition, 'accepted')
  assert.equal(result.receipt?.status, 'unknown')
  assert.equal(result.action.status, 'unknown')
})

test('market research descriptor rejects malformed ticker and report URL shape', () => {
  const adapter = new MarketResearchCapabilityAdapter(new MarketResearchService())
  assert.throws(() => adapter.descriptor.validateInput?.({ ticker: '682', reportUrls: [] }), /six-digit/)
  assert.throws(() => adapter.descriptor.validateInput?.({ ticker: '000682', reportUrls: [42] } as never), /string array/)
})
