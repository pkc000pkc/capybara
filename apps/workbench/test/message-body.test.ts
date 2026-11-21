import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MessageBody } from '../src/app/message-body'

test('agent replies render headings, code, lists and tables without executing embedded HTML or unsafe URLs', () => {
  const html = renderToStaticMarkup(createElement(MessageBody, { text: '# 结果\n\n- **通过**\n\n```js\nconsole.log(3)\n```\n\n|项目|结果|\n|---|---|\n|构建|通过|\n\n<script>alert(1)</script>\n\n[危险链接](javascript:alert(1))' }))
  assert.match(html, /<h1>结果<\/h1>/)
  assert.match(html, /<strong>通过<\/strong>/)
  assert.match(html, /<pre><code/)
  assert.match(html, /<table>/)
  assert.doesNotMatch(html, /<script|href="javascript:/)
});
