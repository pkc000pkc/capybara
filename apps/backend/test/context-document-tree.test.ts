import assert from 'node:assert/strict'
import test from 'node:test'
import { ContextDocumentEngine, type DiffProposal } from '#core/context-document-engine'
import { contextDocumentList, contextTreeOrder } from '#core/context-document-tree'

function fixture() {
  const engine = ContextDocumentEngine.create({ sessionId: 'tree-session', projectId: 'tree-project', constitutionRevision: 'test' })
  const evidence = engine.addEvidence({ id: 'source-evidence', kind: 'message', referenceId: 'user-source' })
  const candidate = engine.addCandidate({ id: 'source-candidate', source: { actor: 'user', sourceId: 'user-source', capturedAt: '2026-11-17T00:00:00Z' }, rawArtifactId: 'user-source',
    normalizedContent: 'A 记录 125 USD，B 记录 120 USD。按来源组织，保留双方。', evidenceRefs: [evidence.id] })
  let sequence = 0
  const projection = (maxCharacters = 120000) => engine.project({ id: 'tree-projection', maxCharacters, includeStructure: true, includeStatuses: ['pending', 'accepted'], includeSections: ['information', 'candidates'] })
  const add = (body: string, headingPath: string[]) => {
    const receipt = engine.apply(engine.propose({ projection: projection(), candidateId: candidate.id, target: { section: 'information', headingPath }, operation: 'add_entry', payload: { body }, actor: 'model', idempotencyKey: `add-${sequence++}` }))
    assert.equal(receipt.result, 'applied', receipt.errorCode ?? '')
    return receipt.changedEntryIds[0]!
  }
  const propose = (operation: DiffProposal['operation'], nodeId: string, payload: DiffProposal['payload']) => {
    const view = projection()
    return engine.propose({ projection: view, diffVersion: 2, targetNodeHash: view.treeNodes!.find((node) => node.id === nodeId)?.hash, candidateId: candidate.id,
      target: { section: 'information', nodeId }, operation, payload, actor: 'model', idempotencyKey: `tree-${sequence++}` })
  }
  const edit = (operation: DiffProposal['operation'], nodeId: string, payload: DiffProposal['payload']) => {
    const receipt = engine.apply(propose(operation, nodeId, payload))
    assert.equal(receipt.result, 'applied', receipt.errorCode ?? '')
    return receipt
  }
  return { engine, projection, candidate, add, propose, edit }
}

test('legacy migration is deterministic and serialization preserves stable nested paths and order', () => {
  const f = fixture()
  f.add('来源 A：125 USD', ['材料 / 原文', '订单系统'])
  f.add('来源 B：120 USD', ['材料 / 原文', '客户邮件'])
  const old = f.engine.snapshot(); delete old.tree
  const left = new ContextDocumentEngine(old), right = new ContextDocumentEngine(old)
  assert.deepEqual(left.snapshot().tree, right.snapshot().tree)
  assert.equal(left.snapshot().revision, old.revision)
  const restored = ContextDocumentEngine.parse(left.serialize(), { sessionId: old.sessionId, projectId: old.projectId, constitutionRevision: 'test' })
  assert.equal(restored.serialize(), left.serialize())
  assert.deepEqual(restored.snapshot().information, left.snapshot().information)
  assert.deepEqual(contextDocumentList(restored.snapshot(), 'session_context'), contextDocumentList(left.snapshot(), 'session_context'))
})

test('heading creation, rename, subtree move and reorder preserve facts, IDs and evidence', () => {
  const f = fixture()
  const a = f.add('来源 A：125 USD', ['材料', '订单系统'])
  const b = f.add('来源 B：120 USD', ['材料', '客户邮件'])
  const before = f.engine.snapshot()
  const created = f.edit('add_heading', 'information', { title: '待核实' })
  const destination = created.changedNodeIds!.find((id) => !before.tree!.headings.some((heading) => heading.id === id) && id !== 'information')!
  assert.ok(destination)
  const heading = f.engine.snapshot().tree!.headings.find((item) => item.title === '材料')!.id
  f.edit('rename_heading', heading, { title: '两方证据' })
  f.edit('move_node', heading, { parentNodeId: destination })
  const children = f.engine.snapshot().tree!.headings.find((item) => item.id === heading)!.children
  f.edit('reorder_children', heading, { childIds: [...children].reverse() })
  const after = f.engine.snapshot()
  for (const id of [a, b]) {
    const original = before.information.find((entry) => entry.id === id)!, current = after.information.find((entry) => entry.id === id)!
    assert.equal(current.body, original.body)
    assert.deepEqual(current.evidenceRefs, original.evidenceRefs)
    assert.deepEqual(current.sourceCandidateIds, original.sourceCandidateIds)
    assert.deepEqual(current.headingPath.slice(0, 2), ['待核实', '两方证据'])
  }
  assert.deepEqual(after.tree!.headings.find((item) => item.id === heading)!.children, [...children].reverse())
  assert.deepEqual(after.sections.find((section) => section.kind === 'information')!.entries, contextTreeOrder(after.tree!).filter((id) => [a, b].includes(id)))
  const restored = ContextDocumentEngine.parse(f.engine.serialize(), { sessionId: after.sessionId, projectId: after.projectId, constitutionRevision: 'test' })
  assert.equal(restored.serialize(), f.engine.serialize())
  assert.deepEqual(restored.snapshot().tree, after.tree)
  assert.deepEqual(restored.snapshot().information, after.information)
})

test('reissued structural intent preserves revision, timestamps and evidence, with a durable-shaped receipt', () => {
  const f = fixture()
  const a = f.add('A', ['材料']), b = f.add('B', ['材料']), c = f.add('C', ['材料'])
  const parent = f.engine.snapshot().tree!.headings[0]!.id
  const reorder = f.edit('reorder_children', parent, { childIds: [b, a, c] })
  assert.deepEqual(reorder.changedEntryIds, [a, b])
  const before = f.engine.snapshot()
  const repeated = [
    f.propose('rename_heading', parent, { title: '材料' }),
    f.propose('move_node', a, { parentNodeId: parent, beforeNodeId: c }),
    f.propose('move_node', c, { parentNodeId: parent }),
    f.propose('reorder_children', parent, { childIds: [b, a] }),
  ]
  for (const proposal of repeated) {
    const receipt = f.engine.apply(proposal)
    assert.equal(receipt.result, 'applied')
    assert.equal(receipt.unchanged, true)
    assert.equal(receipt.nextRevision, before.revision)
    assert.equal(receipt.previousRevision, before.revision)
    assert.deepEqual(receipt.changedNodeIds, [])
    assert.deepEqual(receipt.changedEntryIds, [])
    assert.deepEqual(f.engine.snapshot(), before)
    assert.deepEqual(f.engine.apply({ ...proposal, id: `${proposal.id}-replayed` }), receipt)
  }
})

test('replacement keeps lineage at the same tree position and active document hides old versions', () => {
  const f = fixture(), a = f.add('旧记录', ['材料']), b = f.add('后续记录', ['材料'])
  const receipt = f.engine.apply(f.engine.propose({ projection: f.projection(), candidateId: f.candidate.id, target: { section: 'information', entryId: a }, operation: 'replace_body', payload: { body: '新记录' }, actor: 'model', idempotencyKey: 'replace' }))
  const successor = receipt.changedEntryIds.find((id) => id !== a)!
  assert.deepEqual(f.engine.snapshot().tree!.headings[0]!.children, [a, successor, b])
  assert.deepEqual(f.engine.snapshot().information.find((entry) => entry.id === successor)!.supersedesEntryIds, [a])
  const view = contextDocumentList(f.engine.snapshot(), 'session_context')
  assert.deepEqual(view.list, ['session_context', ['## 材料', '新记录', '后续记录']])
  assert.equal(view.nodeIdsByPath['/1/1'], successor)
  assert.ok(!Object.values(view.nodeIdsByPath).includes(a))
})

test('structural edits reject missing versions, guessed nodes, stale hashes, cycles and content payloads', () => {
  const f = fixture(), a = f.add('原文', ['父章节', '子章节'])
  const parent = f.engine.snapshot().tree!.headings[0]!.id, child = f.engine.snapshot().tree!.headings[1]!.id
  const checks = [
    { ...f.propose('rename_heading', parent, { title: '新标题' }), diffVersion: undefined },
    { ...f.propose('rename_heading', parent, { title: '新标题' }), targetNodeHash: '0'.repeat(64) },
    { ...f.propose('rename_heading', parent, { title: '新标题' }), target: { section: 'information' as const, nodeId: 'guessed-node' } },
    f.propose('move_node', parent, { parentNodeId: child }),
    f.propose('rename_heading', parent, { title: '新标题', body: '不应覆盖正文' }),
    f.propose('reorder_children', parent, { childIds: [child, a] }),
  ]
  for (const proposal of checks) {
    const before = f.engine.snapshot()
    const receipt = f.engine.apply(proposal)
    assert.notEqual(receipt.result, 'applied')
    assert.deepEqual(f.engine.snapshot(), before)
  }
  const first = f.propose('add_heading', 'information', { title: '必须回滚' })
  const invalid = f.propose('move_node', parent, { parentNodeId: child })
  const before = f.engine.snapshot()
  assert.throws(() => f.engine.applyBatch([first, invalid]), /CONTEXT_TREE_CYCLE_OR_SELF_ANCHOR/)
  assert.deepEqual(f.engine.snapshot(), before)
})

test('partial sibling permutations preserve omitted archived slots and bounded projection visibility', () => {
  const f = fixture(), a = f.add('A', ['资料']), b = f.add('B', ['资料']), c = f.add('C', ['资料'])
  f.engine.apply(f.engine.propose({ projection: f.projection(), candidateId: f.candidate.id, target: { section: 'information', entryId: b }, operation: 'mark_status', payload: { status: 'archived' }, actor: 'model', idempotencyKey: 'archive-middle' }))
  const parent = f.engine.snapshot().tree!.headings[0]!.id
  assert.ok(!f.projection().treeNodes!.some((node) => node.id === b))
  f.edit('reorder_children', parent, { childIds: [c, a] })
  assert.deepEqual(f.engine.snapshot().tree!.headings[0]!.children, [c, b, a])
  const before = f.engine.snapshot()
  assert.equal(f.engine.apply(f.propose('reorder_children', parent, { childIds: [a, b] })).errorCode, 'TREE_REFERENCE_NOT_IN_PROJECTION')
  assert.deepEqual(f.engine.snapshot(), before)
})

test('tree metadata is budgeted, deterministic and describes only actually projected nodes', () => {
  const f = fixture(), first = f.add('必要实体 1024；125 USD；不得执行退款。', ['任务', '证据'])
  f.add('B'.repeat(2000), ['其他材料'])
  for (const maxCharacters of [256, 512, 1000, 1800, 4000, 16000]) {
    const view = f.projection(maxCharacters), again = f.projection(maxCharacters)
    assert.ok(view.markdown.length <= maxCharacters)
    assert.equal(view.contentHash, again.contentHash)
    assert.deepEqual(view.treeNodes, again.treeNodes)
    assert.deepEqual(view.sourceEntryIds, (view.treeNodes ?? []).filter((node) => node.kind === 'entry').map((node) => node.id))
    for (const node of view.treeNodes ?? []) {
      assert.ok(view.markdown.includes(node.hash))
      for (const child of node.childIds ?? []) assert.ok(view.treeNodes!.some((item) => item.id === child))
    }
  }
  const pinned = f.engine.project({ id: 'pinned', maxCharacters: 8000, includeStructure: true, includeSections: ['information'], pinnedEntryIds: [first] })
  assert.equal(pinned.sourceEntryIds[0], first)
  const broken = f.engine.snapshot(); broken.tree!.rootChildren.push('orphan-ref')
  assert.throws(() => new ContextDocumentEngine(broken), /CONTEXT_TREE_CHILD_INVALID/)
  const conflicting = f.engine.snapshot(); conflicting.information[0]!.headingPath = ['不匹配']
  assert.throws(() => new ContextDocumentEngine(conflicting), /CONTEXT_TREE_HEADING_PATH_CONFLICT/)
})

test('wide documents keep a late pinned fact without exposing the hidden sibling set', () => {
  const f = fixture(), document = f.engine.snapshot()
  document.tree = undefined
  document.information = Array.from({ length: 2048 }, (_, index) => ({ id: `scale-${index}`, sectionId: 'information', headingPath: ['材料'], body: `来源记录 ${index}：保留否定、单位 USD 与适用条件。`,
    status: 'active', evidenceRefs: ['source-evidence'], sourceCandidateIds: [f.candidate.id], supersedesEntryIds: [], revision: document.revision }))
  const engine = new ContextDocumentEngine(document)
  const view = engine.project({ id: 'wide', maxCharacters: 3000, includeStructure: true, includeSections: ['information'], pinnedEntryIds: ['scale-2047'] })
  assert.ok(view.sourceEntryIds.includes('scale-2047'))
  assert.ok(view.sourceEntryIds.length < 10)
  assert.ok(view.markdown.length <= 3000)
  assert.equal(view.treeNodes!.find((node) => node.kind === 'heading')!.totalChildren, 2048)
  assert.equal(view.treeNodes!.filter((node) => node.kind === 'entry').length, view.sourceEntryIds.length)
  assert.deepEqual(view.sourceEntryIds, [...view.sourceEntryIds].sort((left, right) => Number(left.slice(6)) - Number(right.slice(6))), 'pinning affects selection, not document order')
  assert.equal(engine.snapshot().information.length, 2048)
})

test('a bounded tree retains the user candidate needed to edit projected nodes', () => {
  const f = fixture(), document = f.engine.snapshot()
  delete document.tree
  document.information = Array.from({ length: 96 }, (_, index) => ({ id: `bounded-${index}`, sectionId: 'information',
    headingPath: ['发货材料'], body: `记录 ${index}。保留原始价格、条件及材料编号。`, status: 'active',
    evidenceRefs: ['source-evidence'], sourceCandidateIds: [f.candidate.id], supersedesEntryIds: [], revision: document.revision }))
  const engine = new ContextDocumentEngine(document)
  const request = engine.observe({ candidate: { source: { actor: 'user', sourceId: 'rename-request', capturedAt: '2026-11-19T00:00:00Z' },
    rawArtifactId: 'rename-request', normalizedContent: '请把发货材料改名为双方记录。' }, evidence: { kind: 'message', referenceId: 'rename-request' } })
  const profile = { id: 'bounded', maxCharacters: 3000, includeStructure: true, compactReferences: true,
    includeSections: ['information', 'candidates'] as const }
  const view = engine.project({ ...profile, includeSections: [...profile.includeSections], pinnedEntryIds: ['bounded-95'], pinnedCandidateIds: [request.candidate.id] })
  assert.ok(view.markdown.length <= profile.maxCharacters)
  assert.ok(view.sourceEntryIds.includes('bounded-95'))
  assert.ok(view.sourceEntryIds.length < document.information.length)
  assert.ok(view.sourceCandidateIds.includes(request.candidate.id))
  const heading = view.treeNodes!.find(node => node.title === '发货材料')!
  const receipt = engine.apply(engine.propose({ projection: view, candidateId: request.candidate.id, actor: 'model', idempotencyKey: 'rename-projected',
    diffVersion: 2, targetNodeHash: heading.hash, target: { section: 'information', nodeId: heading.id }, operation: 'rename_heading', payload: { title: '双方记录' } }))
  assert.equal(receipt.result, 'applied', receipt.errorCode ?? '')
  assert.equal(engine.snapshot().tree!.headings[0]!.id, heading.id)
  assert.equal(engine.snapshot().tree!.headings[0]!.title, '双方记录')
})

test('a requested empty destination has priority over optional entries and keeps its canonical position', () => {
  const f = fixture(), document = f.engine.snapshot()
  delete document.tree
  document.information = Array.from({ length: 96 }, (_, index) => ({ id: `wide-${index}`, sectionId: 'information', headingPath: ['发货材料'],
    body: `记录 ${index}。${'核对材料。'.repeat(15)}`, status: 'active', evidenceRefs: ['source-evidence'],
    sourceCandidateIds: [f.candidate.id], supersedesEntryIds: [], revision: document.revision }))
  const engine = new ContextDocumentEngine(document)
  const profile = { id: 'empty-destination', maxCharacters: 1800, includeStructure: true, compactReferences: true,
    includeSections: ['information', 'candidates'] as Array<'information' | 'candidates'>, pinnedEntryIds: ['wide-95'], pinnedCandidateIds: [f.candidate.id] }
  const root = engine.project(profile)
  const created = engine.apply(engine.propose({ projection: root, candidateId: f.candidate.id, actor: 'model', idempotencyKey: 'add-destination',
    diffVersion: 2, targetNodeHash: root.treeNodes![0]!.hash, target: { section: 'information', nodeId: 'information' }, operation: 'add_heading', payload: { title: '待核实批次' } }))
  assert.equal(created.result, 'applied')
  const destination = created.changedNodeIds!.find(id => id !== 'information')!
  const projection = engine.project({ ...profile, pinnedHeadingIds: [destination] })
  assert.deepEqual(engine.project({ ...profile, pinnedHeadingIds: [destination] }), projection)
  assert.ok(projection.markdown.length <= profile.maxCharacters)
  assert.deepEqual(projection.treeNodes!.filter(node => node.kind === 'heading').map(node => node.title), ['发货材料', '待核实批次'])
  assert.ok(projection.sourceEntryIds.includes('wide-95'))
  assert.ok(projection.sourceCandidateIds.includes(f.candidate.id))
  assert.ok(projection.selectionReasons[destination]!.includes('pinned-heading'))
  assert.ok(projection.truncatedSections.includes('information'))
})
