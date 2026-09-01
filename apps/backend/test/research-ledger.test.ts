import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { appendResearchEvents, verifyResearchLedger } from '#core/research-ledger'

test('research ledger appends a verified SHA-256 chain and deduplicates idempotent events', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-research-ledger-'))
  try {
    const source = { hookId: 'research-governor', runId: 'run-1', loopIteration: 1 }
    const first = await appendResearchEvents(projectDir, [
      { eventType: 'hypothesis.proposed', idempotencyKey: 'hypothesis-H-1', payload: { id: 'H-1' } },
      { eventType: 'experiment.completed', idempotencyKey: 'experiment-E-1', payload: { id: 'E-1' } },
    ], source)
    assert.equal(first.appended.length, 2)
    assert.equal(first.duplicates.length, 0)
    assert.match(first.head, /^[a-f0-9]{64}$/)

    const duplicate = await appendResearchEvents(projectDir, [
      { eventType: 'experiment.completed', idempotencyKey: 'experiment-E-1', payload: { id: 'E-1' } },
    ], { ...source, loopIteration: 2 })
    assert.equal(duplicate.appended.length, 0)
    assert.equal(duplicate.duplicates.length, 1)
    assert.equal(duplicate.head, first.head)
    assert.equal(verifyResearchLedger(projectDir).totalEvents, 2)

    await assert.rejects(
      appendResearchEvents(projectDir, [
        { eventType: 'experiment.completed', idempotencyKey: 'experiment-E-1', payload: { id: 'changed' } },
      ], source),
      /idempotency collision/,
    )

    const ledgerFile = path.join(projectDir, 'research', 'events.jsonl')
    const lines = fs.readFileSync(ledgerFile, 'utf8').trimEnd().split('\n')
    const tampered = JSON.parse(lines[0] as string)
    tampered.payload = { id: 'tampered' }
    lines[0] = JSON.stringify(tampered)
    fs.writeFileSync(ledgerFile, `${lines.join('\n')}\n`)
    assert.throws(() => verifyResearchLedger(projectDir), /SHA-256 verification/)
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('accepted experience requires existing artifact-backed evidence with current hashes', async () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-research-evidence-'))
  try {
    const artifact = path.join(projectDir, 'research', 'result.json')
    fs.mkdirSync(path.dirname(artifact), { recursive: true })
    fs.writeFileSync(artifact, '{"valid":true}\n')
    const digest = createHash('sha256')
      .update(fs.readFileSync(artifact))
      .digest('hex')
    const source = { hookId: 'research-governor', runId: 'run-2', loopIteration: 1 }
    const evidence = await appendResearchEvents(projectDir, [{
      eventType: 'experiment.completed',
      idempotencyKey: 'experiment-E-2',
      payload: {
        execution: { valid: true },
        artifacts: [{ path: 'research/result.json', sha256: digest }],
      },
    }], source)
    const evidenceId = evidence.appended[0]?.event_id
    assert.ok(evidenceId)

    const accepted = await appendResearchEvents(projectDir, [{
      eventType: 'experience.accepted',
      idempotencyKey: 'experience-X-2',
      payload: {
        id: 'X-2',
        kind: 'empirical',
        outcome: 'supports',
        evidence_ids: [evidenceId],
      },
    }], source)
    assert.equal(accepted.appended.length, 1)

    await assert.rejects(
      appendResearchEvents(projectDir, [{
        eventType: 'experience.accepted',
        idempotencyKey: 'experience-missing',
        payload: {
          id: 'X-missing',
          kind: 'empirical',
          outcome: 'supports',
          evidence_ids: ['EV-999999999999'],
        },
      }], source),
      /missing evidence event/,
    )

    fs.writeFileSync(artifact, '{"valid":false}\n')
    await assert.rejects(
      appendResearchEvents(projectDir, [{
        eventType: 'experience.accepted',
        idempotencyKey: 'experience-stale-artifact',
        payload: {
          id: 'X-stale',
          kind: 'empirical',
          outcome: 'supports',
          evidence_ids: [evidenceId],
        },
      }], source),
      /failed SHA-256 verification/,
    )
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})
