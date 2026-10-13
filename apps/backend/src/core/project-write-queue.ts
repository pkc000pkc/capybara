import path from 'node:path'
import { assetWriteAudit, AssetWriteBlockedError } from '#core/asset-write-policy'

type WriteTask<T> = () => T | Promise<T>

// Sessions in one server process share project files. Serialize only the
// short read-modify-write transaction; model and tool work never enters here.
const tails = new Map<string, Promise<void>>()

export function enqueueProjectWrite<T>(projectDir: string, task: WriteTask<T>, operation = 'project.write'): Promise<T> {
  const key = path.resolve(projectDir)
  const audit = assetWriteAudit(key, operation)
  if (audit.readonly) {
    audit.record('blocked')
    return Promise.reject(new AssetWriteBlockedError(operation))
  }
  const previous = tails.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(async () => {
    audit.record('started')
    try {
      const value = await task()
      audit.record('completed')
      return value
    } catch (error) {
      audit.record('failed')
      throw error
    }
  })
  const tail = result.then(() => undefined, () => undefined)
  tails.set(key, tail)
  void tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return result
}
