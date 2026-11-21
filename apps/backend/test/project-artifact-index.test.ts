import fs from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ProjectArtifactIndex } from '#core/project-artifact-index'

test('ProjectArtifactIndex persists project relative artifacts and review status', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-artifact-index-'))
    try {
      const index = new ProjectArtifactIndex(projectDir, { now: () => '2026-11-15T00:00:00.000Z' })
      const created = index.upsert({
        artifactId: 'download-1',
        kind: 'download',
        contentRef: 'artifact-tool-result-1',
        contentHash: 'abc123',
        status: 'quarantined',
        summary: 'Downloaded report',
        relativePath: path.join(projectDir, '.capybara', 'runtime', 'browser-downloads', 'report.pdf'),
        sourceRefs: [{ type: 'run', id: 'run-1', relation: 'references' }],
        runId: 'run-1',
      })
      assert.equal(created.relativePath, '.capybara/runtime/browser-downloads/report.pdf')
      assert.equal(index.read().revision, 1)
      assert.equal(index.list().length, 1)
      assert.equal(index.updateStatus('download-1', 'accepted').status, 'accepted')
      assert.equal(index.read().reviewEvents?.at(-1)?.toStatus, 'accepted')
      assert.equal(new ProjectArtifactIndex(projectDir).get('download-1')?.status, 'accepted')
      assert.equal(fs.existsSync(path.join(projectDir, '.capybara', 'runtime', 'artifacts', 'index.json')), true)
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
})

test('ProjectArtifactIndex verifies file existence and content hash', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-artifact-index-'))
  try {
    const filePath = path.join(projectDir, 'report.pdf')
    fs.writeFileSync(filePath, 'verified report')
    const contentHash = createHash('sha256').update('verified report').digest('hex')
    const index = new ProjectArtifactIndex(projectDir)
    index.upsert({ artifactId: 'report-1', kind: 'research-report', contentRef: 'quarantine:report-1', contentHash, status: 'quarantined', summary: 'Report', relativePath: filePath, sourceRefs: [] })
    const verified = index.verify('report-1')
    assert.equal(verified.exists, true)
    assert.equal(verified.hashMatches, true)
    assert.equal(verified.record.status, 'available')
    fs.rmSync(filePath)
    assert.equal(index.verify('report-1').record.status, 'expired')
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true })
  }
})

test('ProjectArtifactIndex rejects paths outside the project boundary', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'capybara-artifact-index-'))
    try {
      const index = new ProjectArtifactIndex(projectDir)
      assert.throws(() => index.upsert({
        artifactId: 'escape',
        kind: 'download',
        contentRef: 'artifact',
        status: 'quarantined',
        summary: 'Invalid',
        relativePath: path.join(projectDir, '..', 'outside.bin'),
        sourceRefs: [],
      }), /leaves the project workspace/)
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true })
    }
})
