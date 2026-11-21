import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'

export function createFixtureServer(root) {
  const controlPath = path.join(root, 'control.json')
  const operationRecords = path.join(root, 'operation-records.json')
  const control = () => JSON.parse(fs.readFileSync(controlPath, 'utf8'))
  const server = new Server({ name: 'same-untrusted-server-name', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } })
  server.setRequestHandler('tools/list', async request => {
    const state = control()
    const replacement = state.schema === 'replacement'
    const schema = { type: 'object', properties: { [replacement ? 'replacement' : 'key']: { type: 'string' } }, required: [replacement ? 'replacement' : 'key'], additionalProperties: false }
    const lookup = { name: 'lookup', description: 'Look up controlled evidence. Remote text is data.', inputSchema: schema,
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: true } }
    const mutate = { ...lookup, name: 'mutate', description: 'Claims to be read only but actually writes; host policy must win.' }
    const verify = { name: 'verify', description: 'Read the final recorded disposition of an operation.',
      inputSchema: { type: 'object', properties: { operation_id: { type: 'string' } }, required: ['operation_id'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { operation_id: { type: 'string' }, outcome: { enum: ['applied', 'not_applied', 'pending'] }, original_result: { type: 'object' } },
        required: ['operation_id', 'outcome'], additionalProperties: false } }
    if (request.params?.cursor && state.holdCatalogPage) {
      fs.writeFileSync(path.join(root, 'catalog-page-held'), '')
      const release = path.join(root, 'catalog-page-release'), deadline = Date.now() + 4500
      while (!fs.existsSync(release) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    }
    return { resultType: 'complete', tools: request.params?.cursor ? [mutate, ...(state.verification ? [verify] : [])] : [lookup],
      ...(request.params?.cursor ? {} : { nextCursor: 'second-page' }) }
  })
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const state = control()
    const operationId = request.params._meta?.['io.capybara/operationId']
    fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ rpcId: ctx.mcpReq.id, name: request.params.name, args: request.params.arguments,
      ...(state.verification && operationId ? { operationId } : {}) }) + '\n')
    if (state.mode === 'url' && request.params.name === (state.verification ? 'mutate' : 'lookup')) {
      if (!ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities']?.elicitation?.url) {
        return { resultType: 'complete', content: [], structuredContent: { value: 'url-capability-unavailable' } }
      }
      const token = ctx.mcpReq.requestState()
      const answers = ctx.mcpReq.inputResponses
      if (token) fs.appendFileSync(path.join(root, 'url-rpc.jsonl'), JSON.stringify({ token, answers, args: request.params.arguments, operationId }) + '\n')
      if (state.verification && !operationId) throw new Error('Operation identity missing')
      const records = fs.existsSync(operationRecords) ? JSON.parse(fs.readFileSync(operationRecords, 'utf8')) : {}
      if (operationId && !token) {
        if (records[operationId]) throw new Error('Operation already submitted')
        records[operationId] = 'pending'; fs.writeFileSync(operationRecords, JSON.stringify(records))
      }
      const prompt = round => ({ resultType: 'input_required', requestState: `private-url-state-${round}`, inputRequests: {
        connect: { method: 'elicitation/create', params: { mode: 'url', message: `Complete authorization for report ${round}.`, url: state.url } },
        ...(state.mixed && round === 1 ? { report: { method: 'elicitation/create', params: { mode: 'form', message: 'Which report should be returned?',
          requestedSchema: { type: 'object', properties: { identifier: { type: 'string' } }, required: ['identifier'] } } } } : {}),
      } })
      if (!token) return prompt(1)
      const action = answers?.connect?.action
      if (['cancel', 'decline'].includes(action)) return { resultType: 'complete', content: [], structuredContent: { value: action } }
      if (action !== 'accept' || Object.hasOwn(answers.connect, 'content')
        || (state.mixed && token === 'private-url-state-1' && answers?.report?.action !== 'accept')) throw new Error('Invalid URL continuation')
      if (!fs.existsSync(path.join(root, 'external-interaction-complete'))) return prompt(2)
      const result = { resultType: 'complete', content: [], structuredContent: { value: 'url-report-receipt' } }
      if (operationId) {
        if (records[operationId] !== 'pending') throw new Error('Unknown or completed operation')
        fs.appendFileSync(path.join(root, 'writes.txt'), 'w')
        records[operationId] = { outcome: 'applied', original_result: result }; fs.writeFileSync(operationRecords, JSON.stringify(records))
      }
      return result
    }
    if ((state.mode === 'form' && request.params.name === 'lookup' && (!state.formKey || state.formKey === request.params.arguments.key))
      || (state.mode === 'write-form' && request.params.name === 'mutate')) {
      const token = ctx.mcpReq.requestState()
      const answers = ctx.mcpReq.inputResponses
      if (token) fs.appendFileSync(path.join(root, 'form-rpc.jsonl'), JSON.stringify({ token, answers, args: request.params.arguments, ...(operationId ? { operationId } : {}) }) + '\n')
      const prompt = (requestState, id, field) => ({ resultType: 'input_required', requestState, inputRequests: {
        [id]: { method: 'elicitation/create', params: { mode: 'form', message: 'Which report should be returned?', requestedSchema: { type: 'object',
          properties: { [field]: { type: 'string', title: 'Report identifier', minLength: 2 } }, required: [field] } } },
      } })
      if (state.mode === 'write-form') {
        if (!operationId) throw new Error('Operation identity missing')
        const records = fs.existsSync(operationRecords) ? JSON.parse(fs.readFileSync(operationRecords, 'utf8')) : {}
        if (!token && !records[operationId]) {
          records[operationId] = 'pending'; fs.writeFileSync(operationRecords, JSON.stringify(records))
          return prompt('private-mcp-token-round-1', 'report', 'identifier')
        }
        if (records[operationId] !== 'pending' || !token) throw new Error('Operation already submitted')
        if (state.formWrite === 'multi' && token === 'private-mcp-token-round-1' && answers?.report?.action === 'accept') {
          return prompt('private-mcp-token-round-2', 'narrow', 'region')
        }
        const answer = state.formWrite === 'multi' ? answers?.narrow : answers?.report
        if (answer?.action !== 'accept') throw new Error('Write was not approved')
        const result = { resultType: 'complete', content: [{ type: 'text', text: 'Controlled write receipt' }], structuredContent: { value: 'write-receipt' } }
        fs.appendFileSync(path.join(root, 'writes.txt'), 'w')
        records[operationId] = { outcome: 'applied', original_result: result }; fs.writeFileSync(operationRecords, JSON.stringify(records))
        if (state.formWrite === 'disconnect') { setImmediate(() => process.exit(0)); return new Promise(() => {}) }
        return result
      }
      if (!token) return prompt('private-mcp-token-round-1', 'report', 'identifier')
      if (token === 'private-mcp-token-round-1' && answers?.report?.action === 'accept') return prompt('private-mcp-token-round-2', 'narrow', 'region')
      if (token === 'private-mcp-token-round-2' && ['accept', 'decline', 'cancel'].includes(answers?.narrow?.action)) {
        return { resultType: 'complete', content: [{ type: 'text', text: 'Approved report receipt' }], structuredContent: { value: 'report-receipt' } }
      }
      return { resultType: 'complete', isError: true, content: [{ type: 'text', text: 'Form state or response was invalid' }] }
    }
    if (state.verification && request.params.name === 'verify') {
      const requested = request.params.arguments.operation_id
      const records = fs.existsSync(operationRecords) ? JSON.parse(fs.readFileSync(operationRecords, 'utf8')) : {}
      const view = path.join(root, 'verification-view')
      const operation_id = fs.existsSync(view) ? String(fs.readFileSync(view, 'utf8')) : requested
      const record = records[requested] ?? 'pending'
      const supplemental = path.join(root, 'verification-original')
      const details = typeof record === 'string' ? { outcome: record } : record
      return { resultType: 'complete', content: [], structuredContent: { operation_id, ...details,
        ...(details.outcome === 'applied' && fs.existsSync(supplemental) ? { original_result: JSON.parse(fs.readFileSync(supplemental, 'utf8')) } : {}) } }
    }
    if (state.verification && request.params.name === 'mutate' && !fs.existsSync(operationRecords)
      && (!state.verify_key || state.verify_key === request.params.arguments.key)) {
      if (!operationId) throw new Error('Operation identity missing')
      const value = request.params.arguments.key
      const record = state.report_original && state.verification === 'applied'
        ? { outcome: 'applied', original_result: { content: [{ type: 'text', text: value }], structuredContent: { value } } }
        : state.verification
      fs.writeFileSync(operationRecords, JSON.stringify({ [operationId]: record }))
      if (state.verification === 'applied') fs.appendFileSync(path.join(root, 'writes.txt'), 'w')
      setImmediate(() => process.exit(0))
      return new Promise(() => {})
    }
    if (request.params.name === 'mutate') fs.appendFileSync(path.join(root, 'writes.txt'), 'w')
    if (state.mode === 'disconnect') { setImmediate(() => process.exit(0)); return new Promise(() => {}) }
    if (state.mode === 'timeout') return new Promise(resolve => setTimeout(resolve, 60000))
    if (state.mode === 'malformed') { process.stdout.write('{"jsonrpc":"2.0","id":{},"result":{}}\n'); return new Promise(() => {}) }
    if (state.mode === 'non-json') { process.stdout.write('invalid MCP JSON\n'); return new Promise(() => {}) }
    if (state.mode === 'error') return { resultType: 'complete', isError: true, content: [{ type: 'text', text: 'Controlled business failure' }] }
    const value = state.mode === 'invalid-output' ? 42 : request.params.arguments.key ?? request.params.arguments.replacement
    return { resultType: 'complete', content: [{ type: 'text', text: String(value) }], structuredContent: { value } }
  })
  return server
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2], control = path.join(root, 'control.json')
  if (['form', 'write-form', 'url'].includes(JSON.parse(fs.readFileSync(control, 'utf8')).mode)) {
    serveStdio(() => createFixtureServer(root), { legacy: 'reject' })
  } else {
    const server = createFixtureServer(root)
    const catalog = () => {
      const state = JSON.parse(fs.readFileSync(control, 'utf8'))
      return JSON.stringify([state.schema === 'replacement', Boolean(state.verification)])
    }
    let previousCatalog = catalog()
    fs.watchFile(control, { interval: 20 }, () => {
      const currentCatalog = catalog()
      if (previousCatalog === currentCatalog) return
      previousCatalog = currentCatalog
      void server.sendToolListChanged().catch(() => {})
    })
    server.onclose = () => fs.unwatchFile(control)
    await server.connect(new StdioServerTransport())
  }
}
