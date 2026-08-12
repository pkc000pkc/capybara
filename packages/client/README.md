# @capybara-agent/client

Framework-neutral TypeScript WebSocket client for a local Capybara Runner. It uses only `fetch`, `WebSocket`, and standard Web APIs, so the same client works in modern browsers and Node.js 22 or newer.

## Install

Install the published Client SDK:

```bash
npm install @capybara-agent/client
```

## Use

```ts
import { CapybaraClient } from '@capybara-agent/client'

const client = new CapybaraClient({
  endpoint: 'http://127.0.0.1:3210',
  token: 'your-local-token',
})

const session = await client.createSession({ name: 'My application' })

const stopStreaming = session.on('chat.assistant.delta', (event) => {
  if (event.payload.channel === 'final') {
    document.body.append(event.payload.delta)
  }
})

const completed = session.waitFor('chat.assistant.completed')
await session.sendMessage('Inspect the current workspace')
await completed

stopStreaming()
client.close()
```

`createSession()` connects automatically and resolves after the Runner sends both `session.attached` and the initial `runtime.snapshot`. Use `connectSession(id)` to restore an existing Session.

Low-level commands remain fully typed:

```ts
await session.send('run.pause', {})
await session.send('runtime.snapshot.get', {})
```

Subscribe with `session.on(type, handler)`, subscribe to every protocol event with `session.onEvent(handler)`, or await a future event with `session.waitFor(type)`. Command admission failures reject with `CapybaraCommandError`; HTTP and transport failures use `CapybaraHttpError` and `CapybaraConnectionError`.
