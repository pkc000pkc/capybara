import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import {
  createFailoverLlmService,
  createLlmService,
  LlmRequestError,
  type LlmRetryNotification,
} from '#util/llm'
import { retryDelayMs, retryableLlmStatus } from '#util/llm/openai-compatible'

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

test('LLM failover rotates candidates and keeps the successful candidate sticky', async () => {
  let unavailableRequests = 0
  let healthyRequests = 0
  const retries: LlmRetryNotification[] = []
  await withApi((_body, _path, response) => {
    unavailableRequests += 1
    response.statusCode = 503
    return { error: { message: 'first provider unavailable' } }
  }, async (unavailableBaseUrl) => {
    await withApi(() => {
      healthyRequests += 1
      return {
        model: 'healthy-model',
        choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }],
      }
    }, async (healthyBaseUrl) => {
      const service = createFailoverLlmService([
        {
          id: 'unavailable',
          config: { provider: 'custom', protocol: 'chat-completions', baseUrl: unavailableBaseUrl, model: 'unavailable-model' },
        },
        {
          id: 'healthy',
          config: { provider: 'custom', protocol: 'chat-completions', baseUrl: healthyBaseUrl, model: 'healthy-model' },
        },
      ], { retriesPerCandidate: 0, initialDelayMs: 1, maxDelayMs: 2 })

      const first = await service.chat({
        messages: [{ role: 'user', content: 'recover' }],
        onRetry: retry => retries.push(retry),
      })
      const second = await service.chat({ messages: [{ role: 'user', content: 'stay healthy' }] })

      assert.equal(first.text, 'recovered')
      assert.equal(second.text, 'recovered')
      assert.equal(unavailableRequests, 1)
      assert.equal(healthyRequests, 2)
      assert.equal(service.getConfig().model, 'healthy-model')
      const switchNotification = retries.find(retry => retry.kind === 'profile_switch' && retry.phase === 'waiting')
      assert.equal(switchNotification?.profileId, 'unavailable')
      assert.equal(switchNotification?.nextProfileId, 'healthy')
      assert.equal(switchNotification?.maxAttempts, -1)
    })
  })
})

test('LLM failover does not rotate deterministic context-limit failures', async () => {
  let fallbackRequests = 0
  await withApi((_body, _path, response) => {
    response.statusCode = 400
    return { error: { message: 'maximum context length exceeded' } }
  }, async (limitedBaseUrl) => {
    await withApi(() => {
      fallbackRequests += 1
      return {
        model: 'fallback-model',
        choices: [{ finish_reason: 'stop', message: { content: 'unexpected' } }],
      }
    }, async (fallbackBaseUrl) => {
      const service = createFailoverLlmService([
        {
          id: 'limited',
          config: { provider: 'custom', protocol: 'chat-completions', baseUrl: limitedBaseUrl, model: 'limited-model' },
        },
        {
          id: 'fallback',
          config: { provider: 'custom', protocol: 'chat-completions', baseUrl: fallbackBaseUrl, model: 'fallback-model' },
        },
      ], { retriesPerCandidate: 0, initialDelayMs: 1, maxDelayMs: 2 })

      await assert.rejects(
        () => service.chat({ messages: [{ role: 'user', content: 'too large' }] }),
        /maximum context length/i,
      )
      assert.equal(fallbackRequests, 0)
    })
  })
})

async function withApi(
  handler: (
    body: any,
    path: string,
    response: http.ServerResponse,
    request: http.IncomingMessage,
    rawBody: string,
  ) => unknown,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(handler(JSON.parse(raw), request.url ?? '', response, request, raw)))
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

test('LLM retry policy covers transient client failures and caps equal-jitter backoff', () => {
  for (const status of [403, 408, 409, 423, 424, 425, 429, 499, 500, 503]) {
    assert.equal(retryableLlmStatus(status), true, `expected HTTP ${status} to be retryable`)
  }
  for (const status of [400, 401, 402, 404, 405, 413, 415, 418, 422, 451]) {
    assert.equal(retryableLlmStatus(status), false, `expected HTTP ${status} to fail immediately`)
  }
  assert.equal(retryDelayMs(1, 0), 500)
  assert.equal(retryDelayMs(1, 1), 1_000)
  assert.equal(retryDelayMs(4, 0), 4_000)
  assert.equal(retryDelayMs(4, 1), 8_000)
  assert.equal(retryDelayMs(9, 0), 90_000)
  assert.equal(retryDelayMs(9, 1), 180_000)
  assert.equal(retryDelayMs(10_000, 1), 180_000)
})

test('Chat Completions retries HTTP 403 without a retry limit until the request succeeds', async () => {
  let requestCount = 0
  const retries: LlmRetryNotification[] = []
  await withApi((_body, path, response) => {
    assert.equal(path, '/v1/chat/completions')
    requestCount += 1
    if (requestCount <= 2) {
      response.statusCode = 403
      response.statusMessage = 'Forbidden'
      return { error: { message: 'Provider access is temporarily blocked.' } }
    }
    return {
      model: 'test-model',
      choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }],
    }
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom',
      protocol: 'chat-completions',
      baseUrl,
      model: 'test-model',
      maxRetries: -1,
    })
    const result = await service.chat({
      messages: [{ role: 'user', content: 'retry' }],
      onRetry: (notification) => retries.push(notification),
    })
    assert.equal(result.text, 'recovered')
  })
  assert.equal(requestCount, 3)
  const waiting = retries.filter((retry) => retry.phase === 'waiting')
  assert.deepEqual(
    waiting.map((retry) => ({
      attempt: retry.attempt,
      maxAttempts: retry.maxAttempts,
      statusCode: retry.statusCode,
    })),
    [
      { attempt: 2, maxAttempts: -1, statusCode: 403 },
      { attempt: 3, maxAttempts: -1, statusCode: 403 },
    ],
  )
  assert.ok((waiting[0]?.delayMs ?? 0) >= 500 && (waiting[0]?.delayMs ?? 0) <= 1_000)
  assert.ok((waiting[1]?.delayMs ?? 0) >= 1_000 && (waiting[1]?.delayMs ?? 0) <= 2_000)
})

test('an abort signal stops unlimited retries during backoff', async () => {
  let requestCount = 0
  await withApi((_body, _path, response) => {
    requestCount += 1
    response.statusCode = 403
    return { error: { message: 'Temporary gateway rejection.' } }
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'chat-completions', baseUrl, model: 'test-model', maxRetries: -1,
    })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('experiment wall-clock budget exceeded')), 50)
    try {
      await assert.rejects(
        () => service.chat({
          messages: [{ role: 'user', content: 'retry until cancelled' }],
          signal: controller.signal,
        }),
        /experiment wall-clock budget exceeded/,
      )
    } finally {
      clearTimeout(timer)
    }
  })
  assert.equal(requestCount, 1)
})

test('Responses retries a successful HTTP response with an empty JSON body', async () => {
  let requestCount = 0
  const retries: LlmRetryNotification[] = []
  await withApi((_body, path) => {
    assert.equal(path, '/v1/responses')
    requestCount += 1
    if (requestCount === 1) return undefined
    return {
      model: 'test-model',
      status: 'completed',
      output_text: 'recovered',
    }
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'responses', baseUrl, model: 'test-model', maxRetries: 1,
    })
    const result = await service.chat({
      messages: [{ role: 'user', content: 'retry an empty body' }],
      onRetry: retry => retries.push(retry),
    })
    assert.equal(result.text, 'recovered')
  })
  assert.equal(requestCount, 2)
  const waiting = retries.find(retry => retry.phase === 'waiting')
  assert.ok(waiting)
  assert.ok((waiting.excludedMs ?? 0) >= waiting.delayMs)
})

test('non-stream requests retry HTTP 200 responses containing invalid JSON', async () => {
  for (const protocol of ['responses', 'chat-completions'] as const) {
    let requestCount = 0
    await withApi((_body, path, response) => {
      requestCount += 1
      if (requestCount === 1) {
        response.end('<html>temporary gateway response</html>')
        return undefined
      }
      return protocol === 'responses'
        ? { model: 'test-model', status: 'completed', output_text: 'recovered' }
        : { model: 'test-model', choices: [{ finish_reason: 'stop', message: { content: 'recovered' } }] }
    }, async (baseUrl) => {
      const service = createLlmService({
        provider: 'custom', protocol, baseUrl, model: 'test-model', maxRetries: 1,
      })
      const result = await service.chat({ messages: [{ role: 'user', content: 'retry invalid JSON' }] })
      assert.equal(result.text, 'recovered')
    })
    assert.equal(requestCount, 2, `${protocol} should retry the malformed response`)
  }
})

test('final HTTP failure exposes safe request diagnostics without secrets or payload content', async () => {
  await withApi((_body, path, response) => {
    assert.equal(path, '/v1/chat/completions')
    response.statusCode = 403
    response.statusMessage = 'Forbidden'
    response.setHeader('x-request-id', 'request-safe-123')
    response.setHeader('x-correlation-id', 'correlation-safe-456')
    response.setHeader('set-cookie', 'session=must-not-leak')
    return { error: { message: 'Temporary gateway rejection.' } }
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom',
      protocol: 'chat-completions',
      baseUrl,
      model: 'test-model',
      apiKey: 'secret-key-must-not-leak',
      maxRetries: 0,
    })
    await assert.rejects(
      () => service.chat({
        messages: [{ role: 'user', content: 'private prompt must not appear in diagnostics' }],
        tools: [{ name: 'read_file', description: 'Private schema.', parameters: { type: 'object' } }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof LlmRequestError)
        assert.equal(error.diagnostics.attempt, 1)
        assert.equal(error.diagnostics.maxAttempts, 1)
        assert.equal(error.diagnostics.statusCode, 403)
        assert.equal(error.diagnostics.requestId, 'request-safe-123')
        assert.equal(error.diagnostics.messageCount, 1)
        assert.equal(error.diagnostics.toolCount, 1)
        assert.ok(error.diagnostics.payloadBytes > 0)
        assert.match(error.diagnostics.payloadHash, /^[a-f0-9]{64}$/)
        assert.equal(error.diagnostics.responseHeaders['x-request-id'], 'request-safe-123')
        assert.equal(error.diagnostics.responseHeaders['x-correlation-id'], 'correlation-safe-456')
        assert.equal(error.diagnostics.responseHeaders['set-cookie'], undefined)
        assert.doesNotMatch(JSON.stringify(error.diagnostics), /private prompt|Private schema|secret-key|must-not-leak/)
        return true
      },
    )
  })
})

async function withSseApi(
  handler: (
    body: any,
    path: string,
    response: http.ServerResponse,
    request: http.IncomingMessage,
  ) => void,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8').on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      response.setHeader('content-type', 'text/event-stream')
      handler(JSON.parse(raw), request.url ?? '', response, request)
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

test('Responses stream retries HTTP 200 with zero response bytes', async () => {
  let requestCount = 0
  await withSseApi((_body, path, response) => {
    assert.equal(path, '/v1/responses')
    requestCount += 1
    if (requestCount === 1) {
      response.end()
      return
    }
    response.write('event: response.completed\n')
    response.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: { model: 'test-model', status: 'completed', output_text: 'recovered' },
    })}\n\n`)
    response.end()
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'responses', baseUrl, model: 'test-model', maxRetries: 1,
    })
    const deltas: string[] = []
    const result = await service.stream(
      { messages: [{ role: 'user', content: 'retry an empty stream' }] },
      (delta) => deltas.push(delta),
    )
    assert.equal(result.text, 'recovered')
    assert.deepEqual(deltas, ['recovered'])
  })
  assert.equal(requestCount, 2)
})

test('Responses stream retries when it ends after response.created without a terminal payload', async () => {
  let requestCount = 0
  await withSseApi((_body, path, response) => {
    assert.equal(path, '/v1/responses')
    requestCount += 1
    if (requestCount === 1) {
      response.end('event: response.created\ndata: {"type":"response.created","response":{"model":"test-model","status":"in_progress"}}\n\n')
      return
    }
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"model":"test-model","status":"completed","output_text":"recovered"}}\n\n')
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'responses', baseUrl, model: 'test-model', maxRetries: 1,
    })
    const deltas: string[] = []
    const result = await service.stream(
      { messages: [{ role: 'user', content: 'retry a truncated stream' }] },
      (delta) => deltas.push(delta),
    )
    assert.equal(result.text, 'recovered')
    assert.deepEqual(deltas, ['recovered'])
  })
  assert.equal(requestCount, 2)
})

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

test('Codex-like protocol sends Codex-shaped Responses requests across tool turns', async () => {
  const requests: any[] = []
  const requestHeaders: http.IncomingHttpHeaders[] = []
  await withApi((body, path, _response, request) => {
    assert.equal(path, '/v1/responses')
    requests.push(body)
    requestHeaders.push(request.headers)
    if (requests.length === 1) {
      return {
        model: 'test-model',
        status: 'completed',
        output: [{
          type: 'function_call',
          call_id: 'call_codex',
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
      provider: 'custom', protocol: 'codex-like', baseUrl, model: 'test-model', maxRetries: 0,
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
      temperature: 0.7,
      maxTokens: 42,
      clientMetadata: {
        sessionId: 'session-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
    })
    assert.equal(first.toolCalls?.[0]?.name, 'read_file')

    await service.chat({
      messages: [
        { role: 'system', content: 'Use project tools.' },
        { role: 'user', content: 'Read config.json' },
        { role: 'assistant', content: '', toolCalls: first.toolCalls },
        { role: 'tool', content: '{"ok":true}', toolCallId: 'call_codex', name: 'read_file' },
      ],
      tools,
      clientMetadata: {
        sessionId: 'session-1',
        threadId: 'thread-1',
        turnId: 'turn-2',
      },
    })
  })

  assert.equal(requests[0].instructions, 'Use project tools.')
  assert.deepEqual(requests[0].input[0], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Read config.json' }],
  })
  assert.equal(requests[0].tool_choice, 'auto')
  assert.equal(requests[0].parallel_tool_calls, false)
  assert.deepEqual(requests[0].reasoning, { effort: 'medium', context: 'all_turns', summary: 'auto' })
  assert.deepEqual(requests[0].text, { verbosity: 'low' })
  assert.deepEqual(requests[0].include, ['reasoning.encrypted_content'])
  assert.equal(requests[0].prompt_cache_key, 'session-1')
  assert.match(requests[0].client_metadata.installation_id, /^[a-f0-9-]{36}$/)
  assert.equal(requests[0].client_metadata.session_id, 'session-1')
  assert.equal(requests[0].client_metadata.thread_id, 'thread-1')
  assert.equal(requests[0].client_metadata.turn_id, 'turn-1')
  assert.equal(requests[0].client_metadata.window_id, 'session-1:0')
  assert.equal(requests[0].max_output_tokens, 42)
  assert.equal(requests[0].temperature, undefined)
  assert.equal(requests[0].store, false)
  assert.equal(requests[0].stream, false)
  assert.equal(requests[1].input[1].type, 'function_call')
  assert.equal(requests[1].input[2].type, 'function_call_output')
  assert.equal(requests[1].input[2].call_id, 'call_codex')
  assert.equal(requests[1].prompt_cache_key, 'session-1')
  assert.equal(requests[1].client_metadata.turn_id, 'turn-2')
  assert.equal(
    requests[1].client_metadata.installation_id,
    requests[0].client_metadata.installation_id,
  )

  const firstHeaders = requestHeaders[0] ?? {}
  assert.equal(firstHeaders.originator, 'codex_exec')
  assert.equal(firstHeaders['user-agent'], 'codex_exec/0.146.0 (Windows 10.0.26200; x86_64) dumb (codex_exec; 0.146.0)')
  assert.equal(firstHeaders['x-openai-internal-codex-responses-lite'], 'true')
  assert.equal(firstHeaders['x-client-request-id'], 'session-1')
  assert.equal(firstHeaders['session-id'], 'session-1')
  assert.equal(firstHeaders['thread-id'], 'thread-1')
  assert.equal(firstHeaders['x-codex-window-id'], 'session-1:0')
  assert.equal(firstHeaders['x-codex-beta-features'], 'remote_compaction_v2')
  assert.equal(firstHeaders['chatgpt-account-id'], undefined)
  assert.equal(firstHeaders['openai-beta'], undefined)
  const firstTurnMetadata = JSON.parse(String(firstHeaders['x-codex-turn-metadata']))
  assert.deepEqual(firstTurnMetadata, {
    installation_id: requests[0].client_metadata.installation_id,
    session_id: 'session-1',
    thread_id: 'thread-1',
    turn_id: 'turn-1',
    window_id: 'session-1:0',
    request_kind: 'turn',
    thread_source: 'user',
    sandbox: 'none',
    turn_started_at_unix_ms: 0,
  })
  const secondTurnMetadata = JSON.parse(String(requestHeaders[1]?.['x-codex-turn-metadata']))
  assert.equal(secondTurnMetadata.turn_id, 'turn-2')
  assert.equal(secondTurnMetadata.installation_id, firstTurnMetadata.installation_id)
})

test('Codex-like protocol keeps request identity stable across retries and rotates generated turn IDs', async () => {
  const bodies: any[] = []
  const rawBodies: string[] = []
  const headers: http.IncomingHttpHeaders[] = []
  let requestCount = 0
  await withApi((body, path, response, request, rawBody) => {
    assert.equal(path, '/v1/responses')
    requestCount += 1
    bodies.push(body)
    rawBodies.push(rawBody)
    headers.push(request.headers)
    if (requestCount === 1) {
      response.statusCode = 403
      return { error: { message: 'Retry this request.' } }
    }
    return {
      model: 'test-model',
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
    }
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom',
      protocol: 'codex-like',
      baseUrl,
      model: 'test-model',
      maxRetries: 1,
      headers: { originator: 'configured-originator' },
    })
    await service.chat({ messages: [{ role: 'user', content: 'first turn' }] })
    await service.chat({ messages: [{ role: 'user', content: 'second turn' }] })
  })

  assert.equal(requestCount, 3)
  assert.equal(rawBodies[0], rawBodies[1])
  assert.equal(headers[0]?.['x-codex-turn-metadata'], headers[1]?.['x-codex-turn-metadata'])
  assert.equal(headers[0]?.originator, 'configured-originator')
  assert.equal(headers[1]?.originator, 'configured-originator')
  assert.equal(headers[2]?.originator, 'configured-originator')
  assert.equal(bodies[0].client_metadata.installation_id, bodies[2].client_metadata.installation_id)
  assert.equal(bodies[0].client_metadata.session_id, bodies[2].client_metadata.session_id)
  assert.equal(bodies[0].client_metadata.thread_id, bodies[0].client_metadata.session_id)
  assert.equal(bodies[2].client_metadata.thread_id, bodies[2].client_metadata.session_id)
  assert.equal(bodies[0].client_metadata.window_id, `${bodies[0].client_metadata.session_id}:0`)
  assert.notEqual(bodies[0].client_metadata.turn_id, bodies[2].client_metadata.turn_id)
  assert.equal(headers[0]?.['x-client-request-id'], bodies[0].client_metadata.session_id)
  assert.equal(headers[2]?.['x-client-request-id'], bodies[2].client_metadata.session_id)
  assert.equal(headers[2]?.['thread-id'], bodies[2].client_metadata.thread_id)
})

test('Codex compatibility headers are scoped to the Codex-like protocol', async () => {
  const headersByModel = new Map<string, http.IncomingHttpHeaders>()
  await withApi((body, path, _response, request) => {
    headersByModel.set(body.model, request.headers)
    return path.endsWith('/chat/completions')
      ? { model: body.model, choices: [{ message: { content: 'done' } }] }
      : {
          model: body.model,
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
        }
  }, async (baseUrl) => {
    await createLlmService({
      provider: 'custom', protocol: 'responses', baseUrl, model: 'responses-model', maxRetries: 0,
    }).chat({ messages: [{ role: 'user', content: 'reply' }] })
    await createLlmService({
      provider: 'custom', protocol: 'chat-completions', baseUrl, model: 'chat-model', maxRetries: 0,
    }).chat({ messages: [{ role: 'user', content: 'reply' }] })
  })

  for (const model of ['responses-model', 'chat-model']) {
    const headers = headersByModel.get(model) ?? {}
    assert.equal(headers.originator, undefined)
    assert.equal(headers['x-openai-internal-codex-responses-lite'], undefined)
    assert.equal(headers['x-codex-turn-metadata'], undefined)
    assert.equal(headers['x-codex-beta-features'], undefined)
  }
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
    assert.deepEqual(deltas, ['{"status":"completed","content":"hello"}'])
    assert.equal(second.text, '{"status":"completed","content":"hello"}')
    assert.equal(second.usage?.cacheReadTokens, 1)
  })
})

test('Codex-like protocol reuses Responses streaming with Codex request fields', async () => {
  await withSseApi((body, path, response) => {
    assert.equal(path, '/v1/responses')
    assert.equal(body.stream, true)
    assert.equal(body.tool_choice, 'auto')
    assert.equal(body.parallel_tool_calls, false)
    assert.equal(body.prompt_cache_key, 'session-stream')
    assert.deepEqual(body.input, [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'reply' }],
    }])
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"model":"test-model","status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}\n\n')
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'codex-like', baseUrl, model: 'test-model', maxRetries: 0,
    })
    const result = await service.stream({
      messages: [{ role: 'user', content: 'reply' }],
      clientMetadata: { sessionId: 'session-stream', turnId: 'turn-stream' },
    }, () => {})
    assert.equal(result.text, 'done')
  })
})

test('Responses protocol retries an overloaded failed event before output starts', async () => {
  let requestCount = 0
  const retries: LlmRetryNotification[] = []
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
    const response = await service.stream({
      messages: [{ role: 'user', content: 'reply' }],
      onRetry: (notification) => retries.push(notification),
    }, () => {})
    assert.equal(response.text, 'done')
  })
  assert.equal(requestCount, 2)
  assert.equal(retries.length, 2)
  assert.deepEqual(retries.map(({ delayMs: _delayMs, excludedMs: _excludedMs, ...retry }) => retry), [
    { phase: 'waiting', attempt: 2, maxAttempts: 2, reason: 'LLM response failed (server_error): Try again later.' },
    { phase: 'attempting', attempt: 2, maxAttempts: 2, reason: 'LLM response failed (server_error): Try again later.' },
  ])
  assert.ok((retries[0]?.delayMs ?? 0) >= 500 && (retries[0]?.delayMs ?? 0) <= 1_000)
  assert.ok((retries[0]?.excludedMs ?? 0) >= (retries[0]?.delayMs ?? 0))
  assert.equal(retries[1]?.delayMs, 0)
})

test('Responses stream retries upstream errors after internal output and discards failed attempt state', async () => {
  let requestCount = 0
  await withSseApi((_body, path, response) => {
    assert.equal(path, '/v1/responses')
    requestCount += 1
    if (requestCount === 1) {
      response.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"stale-reasoning"}}\n\n')
      response.end('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"upstream_error","message":"Temporary upstream failure."}}}\n\n')
      return
    }
    response.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"fresh-call","name":"read_file","arguments":"{\\"file_name\\":\\"fresh.txt\\"}"}}\n\n')
    response.end('data: [DONE]\n\n')
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'responses', baseUrl, model: 'test-model', maxRetries: 1,
    })
    const result = await service.stream({
      messages: [{ role: 'user', content: 'read' }],
      tools: [{ name: 'read_file', description: 'Read.', parameters: { type: 'object' } }],
    }, () => assert.fail('internal output must not emit text'))
    assert.deepEqual(result.toolCalls, [{
      id: 'fresh-call', name: 'read_file', arguments: { file_name: 'fresh.txt' },
    }])
    assert.doesNotMatch(JSON.stringify(result.raw), /stale-reasoning/)
  })
  assert.equal(requestCount, 2)
})

test('Responses stream transparently retries partial text that is buffered before completion', async () => {
  let requestCount = 0
  const deltas: string[] = []
  await withSseApi((_body, path, response) => {
    assert.equal(path, '/v1/responses')
    requestCount += 1
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"visible"}\n\n')
    response.end('event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"code":"upstream_error","message":"Temporary upstream failure."}}}\n\n')
  }, async (baseUrl) => {
    const service = createLlmService({
      provider: 'custom', protocol: 'responses', baseUrl, model: 'test-model', maxRetries: 3,
    })
    await assert.rejects(
      () => service.stream({ messages: [{ role: 'user', content: 'reply' }] }, (delta) => deltas.push(delta)),
      (error: unknown) => error instanceof LlmRequestError && /upstream_error/.test(error.message),
    )
  })
  assert.equal(requestCount, 4)
  assert.deepEqual(deltas, [])
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
    assert.deepEqual(deltas, ['hello world'])
    assert.deepEqual(result.toolCalls, [{
      id: 'call_chat', name: 'read_file', arguments: { file_name: 'config.json' },
    }])
    assert.equal(result.usage?.totalTokens, 5)
  })
})
