const blockedSyntax = [
  /(^|\n)\s*(?:from|import)\s+/m,
  /\b(?:exec|eval|compile|open|__import__)\s*\(/u,
  /\b(?:os|sys|subprocess|pathlib|shutil|socket|requests|httpx)\s*[.\[]/u,
  /\bapis\.supervisor\s*\./u,
]

const blockedMethodPrefixes = [
  'add', 'append', 'assign', 'book', 'cancel', 'complete', 'create', 'delete', 'disable',
  'enable', 'invite', 'login', 'logout', 'mark', 'modify', 'pay', 'purchase', 'remove',
  'send', 'set', 'transfer', 'update', 'write',
]

const readMethodPrefixes = [
  'check', 'count', 'current', 'describe', 'fetch', 'find', 'get', 'has', 'is_', 'list',
  'lookup', 'read', 'search', 'show', 'view',
]

function methodCalls(code) {
  return [...code.matchAll(/\bapis\.([A-Za-z_]\w*)\.([A-Za-z_]\w*)\s*\(/gu)]
    .map((match) => ({ app: match[1], method: match[2] }))
}

export function readonlyPolicyError(code) {
  if (typeof code !== 'string' || !code.trim()) return 'code is required'
  if (blockedSyntax.some((pattern) => pattern.test(code))) return 'read-only AppWorld execution rejected unsafe syntax or host access'
  for (const { app, method } of methodCalls(code)) {
    if (app === 'api_docs' && readMethodPrefixes.some((prefix) => method.startsWith(prefix))) continue
    if (blockedMethodPrefixes.some((prefix) => method.startsWith(prefix))) return `read-only AppWorld execution rejected mutating API: ${app}.${method}`
    if (!readMethodPrefixes.some((prefix) => method.startsWith(prefix))) return `read-only AppWorld execution requires an approved read API: ${app}.${method}`
  }
  return undefined
}

export function assertReadonlyCode(code) {
  const error = readonlyPolicyError(code)
  if (error) throw new Error(error)
}
