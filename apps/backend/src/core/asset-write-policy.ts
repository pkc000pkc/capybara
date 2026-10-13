import { AsyncLocalStorage } from 'node:async_hooks'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { diagnosticContext } from '#util/llm/diagnostic-log'

export interface AssetWriteAudit {
  id: string
  hookId?: string
  code?: 'ASSET_WRITE_BLOCKED'
  projectDir: string
  operation: string
  status: 'blocked' | 'started' | 'completed' | 'failed'
  timestamp: string
}

export interface AssetWritePolicy {
  projectDir: string
  readonly: boolean
  assetPaths?: readonly string[]
  onAudit: (event: AssetWriteAudit) => void
}

const policies = new AsyncLocalStorage<AssetWritePolicy>()

/** Scoped to one asynchronous execution; never locks unrelated sessions. */
export function withAssetWritePolicy<T>(policy: AssetWritePolicy, task: () => T): T {
  return policies.run({ ...policy, projectDir: path.resolve(policy.projectDir) }, task)
}

export function assetWriteAudit(projectDir: string, operation: string): {
  record: (status: AssetWriteAudit['status']) => void
  readonly: boolean
} {
  const policy = policies.getStore()
  const root = path.resolve(projectDir)
  const matches = policy?.projectDir === root
  const id = randomUUID()
  const hookId = diagnosticContext.getStore()?.hookId
  return {
    readonly: Boolean(matches && policy.readonly),
    record(status) {
      if (matches) policy.onAudit({
        id, projectDir: root, operation, status, timestamp: new Date().toISOString(),
        ...(typeof hookId === 'string' ? { hookId } : {}),
        ...(status === 'blocked' ? { code: 'ASSET_WRITE_BLOCKED' } : {}),
      })
    },
  }
}

export class AssetWriteBlockedError extends Error {
  readonly code = 'ASSET_WRITE_BLOCKED'
  constructor(operation: string) {
    super(`Read-only evaluation blocked asset mutation: ${operation}`)
    this.name = 'AssetWriteBlockedError'
  }
}

export function assertAssetWriteAllowed(projectDir: string, operation: string): void {
  const audit = assetWriteAudit(projectDir, operation)
  if (audit.readonly) {
    audit.record('blocked')
    throw new AssetWriteBlockedError(operation)
  }
}

export function auditedAssetWrite<T>(projectDir: string, operation: string, task: () => T): T {
  assertAssetWriteAllowed(projectDir, operation)
  const audit = assetWriteAudit(projectDir, operation)
  audit.record('started')
  try {
    const result = task()
    audit.record('completed')
    return result
  } catch (error) {
    audit.record('failed')
    throw error
  }
}

/** Agent resources are protected; ordinary task output files remain writable. */
export function isAssetPath(relative: string): boolean {
  const portable = path.posix.normalize(relative.replaceAll('\\', '/')).toLowerCase()
  const first = portable.split('/')[0]
  const configured = policies.getStore()?.assetPaths ?? []
  return ['plugins', 'harnesses', 'hooks', 'skills', 'tools', 'roles', 'variables'].includes(first ?? '')
    || ['main.j2', 'capybara.plugin.json'].includes(portable)
    || portable.endsWith('.j2')
    || configured.some(value => {
      const prefix = path.posix.normalize(value.replaceAll('\\', '/')).toLowerCase().replace(/\/$/u, '')
      return prefix !== '.' && (portable === prefix || portable.startsWith(`${prefix}/`))
    })
    || portable === '.capybara'
    || /^\.capybara\/(config|secrets|system-variables|variables)\.json$/u.test(portable)
}
