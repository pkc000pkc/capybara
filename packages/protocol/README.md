# @capybara-agent/protocol

Framework-neutral Runtime command, event, snapshot, Tool, Hook, Skill, and Harness contracts shared by the Capybara Runner, developer interface, and Client SDK.

The package contains no browser, Node.js, transport, or framework dependencies.

## Install

The package is prepared but has not yet been published to npm. After the first release:

```bash
npm install @capybara-agent/protocol
```

## Use

```ts
import type {
  ClientCommand,
  RuntimeSnapshot,
  ServerEvent,
} from '@capybara-agent/protocol'
```

The wire protocol carries an explicit numeric version. Package minor releases may add backward-compatible fields or event types; incompatible wire changes require a new protocol version and a new package major release.

Most applications should depend on `@capybara-agent/client`, which re-exports these types and manages the WebSocket lifecycle. Use this lower-level package when implementing a transport, Runner integration, or protocol-aware development tool.
