import path from 'node:path'

type WriteTask<T> = () => T | Promise<T>

// Sessions in one server process share project files. Serialize only the
// short read-modify-write transaction; model and tool work never enters here.
const tails = new Map<string, Promise<void>>()

export function enqueueProjectWrite<T>(projectDir: string, task: WriteTask<T>): Promise<T> {
  const key = path.resolve(projectDir)
  const previous = tails.get(key) ?? Promise.resolve()
  const result = previous.catch(() => undefined).then(task)
  const tail = result.then(() => undefined, () => undefined)
  tails.set(key, tail)
  void tail.finally(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return result
}
