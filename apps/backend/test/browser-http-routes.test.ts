import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'

import { registerBrowserHttpRoutes } from '#core/browser-http-routes'

test('browser HTTP read route validates URL input before external access', async () => {
  const app = Fastify()
  await registerBrowserHttpRoutes(app)
  const response = await app.inject({ method: 'POST', url: '/api/work/browser/read', payload: { url: 'not-a-url' } })
  assert.equal(response.statusCode, 400)
  await app.close()
})
