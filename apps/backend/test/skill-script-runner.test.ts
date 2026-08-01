import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { SkillScriptRunner } from '#core/skills/skill-script-runner'

test('skill script runner enforces timeout and abort', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-skill-script-'))
  const script = path.join(workspace, 'slow.mjs')
  fs.writeFileSync(script, 'setTimeout(() => process.stdout.write("done"), 500)\n', 'utf8')
  try {
    const timedOut = await new SkillScriptRunner(workspace, 50).run(
      { id: 'timeout', name: 'run_skill_script' },
      script,
      [],
    )
    assert.equal(timedOut.error?.code, 'TIMEOUT')

    const controller = new AbortController()
    const runner = new SkillScriptRunner(workspace, 2_000)
    const pending = runner.run(
      { id: 'abort', name: 'run_skill_script' },
      script,
      [],
      controller.signal,
    )
    setTimeout(() => controller.abort(), 20)
    const aborted = await pending
    assert.equal(aborted.error?.code, 'ABORTED')
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
