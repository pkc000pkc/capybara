import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { createLlmService } from '#util/llm'

test('LLM service accepts explicit OpenAI-compatible configuration', () => {
  const service = createLlmService({
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'test-model',
  })

  assert.deepEqual(service.getConfig(), {
    provider: 'custom',
    protocol: 'chat-completions',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'test-model',
    apiKey: undefined,
    timeoutMs: 60000,
    maxRetries: 3,
    headers: undefined,
  })
})

test('LLM service rejects an empty message list before making a request', async () => {
  const service = createLlmService()
  await assert.rejects(() => service.chat({ messages: [] }), /at least one message/)
})

async function withApi(
  handler: (body: any, path: string) => unknown,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(handler(JSON.parse(raw), request.url ?? '')))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await run(`http://127.0.0.1:${address.port}/v1`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

async function withSseApi(
  handler: (body: any, path: string, response: http.ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      response.setHeader('content-type', 'text/event-stream')
      handler(JSON.parse(raw), request.url ?? '', response)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await run(`http://127.0.0.1:${address.port}/v1`)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

test('Responses protocol maps native function calls and outputs across turns', async () => {
  const requests: any[] = []
  await withApi((body, path) => {
    assert.equal(path, '/v1/responses')
    requests.push(body)
    if (requests.length === 1) {
      return {
        model: 'test-model',
        status: 'completed',
        output: [{
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'read_file',
          arguments: '{"file_name":"config.json"}',
        }],
      }
    }
    return {
      model: 'test-model',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
    }
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'responses', baseUrl, model: 'test-model', maxRetries: 0,
    })
    const tools = [{
      name: 'read_file',
      description: 'Read a file.',
      parameters: { type: 'object', properties: { file_name: { type: 'string' } } },
    }]
    const first = await service.chat({
      messages: [
        { role: 'system', content: 'Use project tools.' },
        { role: 'user', content: 'Read config.json' },
      ],
      tools,
    })
    assert.deepEqual(first.toolCalls, [{
      id: 'call_1', name: 'read_file', arguments: { file_name: 'config.json' },
    }])

    const second = await service.chat({
      messages: [
        { role: 'system', content: 'Use project tools.' },
        { role: 'user', content: 'Read config.json' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_1', name: 'read_file' },
      ],
      tools,
    })
    assert.equal(second.text, 'done')
  })

  assert.equal(requests[0].instructions, 'Use project tools.')
  assert.deepEqual(requests[0].tools[0], {
    type: 'function',
    name: 'read_file',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { file_name: { type: 'string' } } },
  })
  assert.equal(requests[1].input[1].type, 'function_call')
  assert.equal(requests[1].input[2].type, 'function_call_output')
  assert.equal(requests[1].input[2].call_id, 'call_1')
})

test('Chat Completions protocol maps tool calls and tool messages', async () => {
  let requestBody: any
  await withApi((body, path) => {
    assert.equal(path, '/v1/chat/completions')
    requestBody = body
    return {
      model: 'test-model',
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          content: '',
          tool_calls: [{
            id: 'call_2',
            function: { name: 'list_files', arguments: '{"recursive":true}' },
          }],
        },
      }],
    }
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'chat-completions', baseUrl, model: 'test-model', maxRetries: 0,
    })
    const response = await service.chat({
      messages: [
        { role: 'user', content: 'List files' },
        { role: 'tool', content: '{}', toolCallId: 'previous-call' },
      ],
      tools: [{ name: 'list_files', description: 'List files.', parameters: { type: 'object' } }],
    })
    assert.equal(response.toolCalls?.[0]?.name, 'list_files')
  })
  assert.equal(requestBody.messages[1].tool_call_id, 'previous-call')
  assert.equal(requestBody.tools[0].function.name, 'list_files')
})

test('Responses protocol streams text and function arguments from SSE', async () => {
  let requestCount = 0
  await withSseApi((body, path, response) => {
    assert.equal(path, '/v1/responses')
    assert.equal(body.stream, true)
    requestCount += 1
    if (requestCount === 1) {
      response.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","call_id":"call_stream","name":"read_file","arguments":""}}\n\n')
      response.write('event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\\"file_name\\":\\"con')
      response.write('fig.json\\"}"}\n\n')
      response.end('event: response.completed\ndata: {"type":"response.completed","response":{"model":"test-model","status":"completed","output":[{"type":"function_call","call_id":"call_stream","name":"read_file","arguments":"{\\"file_name\\":\\"config.json\\"}"}]}}\n\n')
      return
    }
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"{\\"status\\":\\"completed\\",\\"content\\":\\"hel"}\n\n')
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo\\"}"}\n\n')
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"model":"test-model","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\\"status\\":\\"completed\\",\\"content\\":\\"hello\\"}"}]}],"usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6,"input_tokens_details":{"cached_tokens":1}}}}\n\n')
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'responses', baseUrl, model: 'test-model', maxRetries: 0,
    })
    const first = await service.stream({
      messages: [{ role: 'user', content: 'read' }],
      tools: [{ name: 'read_file', description: 'Read.', parameters: { type: 'object' } }],
    }, () => assert.fail('tool call should not emit text'))
    assert.deepEqual(first.toolCalls, [{
      id: 'call_stream', name: 'read_file', arguments: { file_name: 'config.json' },
    }])

    const deltas: string[] = []
    const second = await service.stream({
      messages: [{ role: 'user', content: 'reply' }],
    }, (delta) => deltas.push(delta))
    assert.deepEqual(deltas, [
      '{"status":"completed","content":"hel',
      'lo"}',
    ])
    assert.equal(second.text, '{"status":"completed","content":"hello"}')
    assert.equal(second.usage?.cacheReadTokens, 1)
  })
})

test('Responses protocol retries an overloaded failed event before output starts', async () => {
  let requestCount = 0
  await withSseApi((_body, path, response) => {
    assert.equal(path, '/v1/responses')
    requestCount += 1
    if (requestCount === 1) {
      response.end('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"Try again later."}}}\n\n')
      return
    }
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"model":"test-model","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}\n\n')
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'responses', baseUrl, model: 'test-model', maxRetries: 1,
    })
    const response = await service.stream({ messages: [{ role: 'user', content: 'reply' }] }, () => {})
    assert.equal(response.text, 'done')
  })
  assert.equal(requestCount, 2)
})

test('Chat Completions protocol streams content and tool calls from SSE', async () => {
  await withSseApi((body, path, response) => {
    assert.equal(path, '/v1/chat/completions')
    assert.equal(body.stream, true)
    assert.equal(body.stream_options.include_usage, true)
    response.write('data: {"model":"test-model","choices":[{"delta":{"content":"hello "},"finish_reason":null}]}\n\n')
    response.write('data: {"model":"test-model","choices":[{"delta":{"content":"world","tool_calls":[{"index":0,"id":"call_chat","function":{"name":"read_","arguments":"{\\"file_name\\":"}}]},"finish_reason":null}]}\n\n')
    response.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"\\"config.json\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n')
    response.write('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n')
    response.end('data: [DONE]\n\n')
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'chat-completions', baseUrl, model: 'test-model', maxRetries: 0,
    })
    const deltas: string[] = []
    const result = await service.stream({ messages: [{ role: 'user', content: 'test' }] }, (delta) => {
      deltas.push(delta)
    })
    assert.deepEqual(deltas, ['hello ', 'world'])
    assert.deepEqual(result.toolCalls, [{
      id: 'call_chat', name: 'read_file', arguments: { file_name: 'config.json' },
    }])
    assert.equal(result.usage?.totalTokens, 5)
  })
})
