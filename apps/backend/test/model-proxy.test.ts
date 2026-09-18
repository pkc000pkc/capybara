import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { modelProxyAgent, configureProxyPreferences } from '#util/llm/proxy'

test('model agent routes remote HTTP through configured proxy and bypasses loopback', async () => {
  let observed = ''
  const server = http.createServer((req, res) => { observed = req.url ?? ''; res.end('ok') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as import('node:net').AddressInfo).port
  configureProxyPreferences(() => ({ language: 'en', color_theme: 'system', proxy: { enabled: true, url: `http://127.0.0.1:${port}` } }))
  const get = (url: string) => new Promise<void>((resolve, reject) => {
    http.get(url, { agent: modelProxyAgent }, res => { res.resume(); res.on('end', resolve) }).on('error', reject)
  })
  try {
    await get('http://remote.invalid/probe')
    assert.equal(observed, 'http://remote.invalid/probe')
    await get(`http://127.0.0.1:${port}/direct`)
    assert.equal(observed, '/direct')
  } finally { modelProxyAgent.destroy(); server.close(); configureProxyPreferences(() => ({ language: 'en', color_theme: 'system' })) }
})
