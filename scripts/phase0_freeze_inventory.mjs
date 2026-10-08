import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freezeInventory } from '../src/phase0_inventory.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const protocolPath = resolve(root, process.argv[2] ?? 'config/phase0-protocol.json')
try {
  const protocol = JSON.parse(readFileSync(protocolPath, 'utf8'))
  const { environment, capabilities } = freezeInventory({ root, protocol })
  process.stdout.write(`${JSON.stringify({
    status: capabilities.stage0Status, generatedAt: environment.generatedAt,
    environmentLock: resolve(root, 'locks/environment-lock.json'),
    capabilityInventory: resolve(root, 'locks/capability-inventory.json'),
    areVersion: environment.are.version,
    plugins: capabilities.plugins.map(({ id, version, treeSha256, snapshotRoot, pluginLoadStatus, runtimeBinding, effectiveHookDecision }) => ({ id, version, treeSha256, snapshotRoot, pluginLoadStatus, runtimeBinding, effectiveHookDecision })),
    knownGapCount: capabilities.backendCompatibility.gaps.length,
    noModelExecution: true, secretConfigRead: false,
  }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', error: error.message, noModelExecution: true })}\n`)
  process.exitCode = 1
}
