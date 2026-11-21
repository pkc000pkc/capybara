import assert from 'node:assert/strict'
import test from 'node:test'

import { assertNativeDirectorySelection, createMockNativeBridge, type NativeProjectDirectorySelection } from '../src/app/workbench-bridge'

const emptyProject: NativeProjectDirectorySelection = {
  projectId: 'project-empty',
  displayName: '空目录项目',
  isEmpty: true,
  opaqueDirectoryRef: 'native-ref:project-empty',
}

test('native directory picker accepts an empty directory without uploading or exposing a path', async () => {
  const bridge = createMockNativeBridge(emptyProject)
  const picked = await bridge.selectProjectDirectory()
  assert.equal(picked.kind, 'selected')
  if (picked.kind === 'selected') {
    assert.equal(picked.selection.displayName, '空目录项目')
    assert.equal(picked.selection.isEmpty, true)
    assert.equal(picked.selection.opaqueDirectoryRef, 'native-ref:project-empty')
    assert.equal('path' in picked.selection, false)
    assert.equal('absolutePath' in picked.selection, false)
    assert.equal('files' in picked.selection, false)
    assert.equal('contents' in picked.selection, false)
  }
  const registered = await bridge.registerProjectDirectory(emptyProject)
  assert.deepEqual(registered, { projectId: 'project-empty', displayName: '空目录项目', isEmpty: true, source: 'native-directory-picker' })
})

test('renderer contract rejects native path, file, and content leakage', () => {
  assert.throws(() => assertNativeDirectorySelection({ ...emptyProject, absolutePath: 'C:\\secret' }), /cannot expose/)
  assert.throws(() => assertNativeDirectorySelection({ ...emptyProject, files: ['secret.txt'] }), /cannot expose/)
  assert.throws(() => assertNativeDirectorySelection({ ...emptyProject, contents: 'secret' }), /cannot expose/)
})

test('capability status stays explicit when the host runtime is not connected', async () => {
  const bridge = createMockNativeBridge(emptyProject)
  const status = await bridge.getProductCapabilityStatus({ opaqueDirectoryRef: emptyProject.opaqueDirectoryRef })
  assert.equal(status.projectId, emptyProject.projectId)
  assert.equal(status.backend.state, 'unknown')
  assert.equal(status.applicationRuntime.state, 'unknown')
  assert.equal(status.browserGateway.state, 'unknown')
  assert.equal(status.marketResearch.state, 'unknown')
})
