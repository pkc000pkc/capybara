import { createHash, randomUUID } from 'node:crypto'
import type { RuntimeContextDiffPayload, RuntimeContextListNode, RuntimeContextTree, RuntimeContextTreeBinding } from '#protocol/runtime-protocol'

export const INFORMATION_ROOT = 'information'
type Entry = { id: string; headingPath: string[]; body: string; status: string; revision: number }
type Document = { id: string; information: Entry[]; tree?: RuntimeContextTree }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function maps(tree: RuntimeContextTree) {
  const headings = new Map(tree.headings.map((heading) => [heading.id, heading]))
  const parents = new Map<string, string>()
  for (const [parent, children] of [[INFORMATION_ROOT, tree.rootChildren], ...tree.headings.map((heading) => [heading.id, heading.children])] as Array<[string, string[]]>) {
    for (const id of children) { if (parents.has(id)) throw new Error('CONTEXT_TREE_MULTIPLE_PARENTS'); parents.set(id, parent) }
  }
  return { headings, parents }
}

function childrenOf(tree: RuntimeContextTree, id: string): string[] {
  if (id === INFORMATION_ROOT) return tree.rootChildren
  const heading = tree.headings.find((item) => item.id === id)
  if (!heading) throw new Error('CONTEXT_TREE_PARENT_NOT_FOUND')
  return heading.children
}

export function contextTreePaths(tree: RuntimeContextTree): Map<string, string[]> {
  const { headings } = maps(tree)
  const paths = new Map<string, string[]>()
  const active = new Set<string>()
  const visit = (id: string, path: string[]) => {
    if (active.has(id) || path.length > 128) throw new Error('CONTEXT_TREE_CYCLE_OR_DEPTH')
    if (paths.has(id)) throw new Error('CONTEXT_TREE_MULTIPLE_PARENTS')
    active.add(id)
    const heading = headings.get(id)
    const ownPath = heading ? [...path, heading.title] : path
    paths.set(id, ownPath)
    for (const child of heading?.children ?? []) visit(child, ownPath)
    active.delete(id)
  }
  for (const id of tree.rootChildren) visit(id, [])
  return paths
}

export function validateContextTree(tree: RuntimeContextTree, entries: readonly Entry[]): void {
  if (!tree || tree.version !== 1 || !Array.isArray(tree.rootChildren) || !Array.isArray(tree.headings)) throw new Error('CONTEXT_TREE_VERSION_OR_SHAPE_INVALID')
  const ids = new Set(entries.map((entry) => entry.id))
  if (ids.has(INFORMATION_ROOT)) throw new Error('CONTEXT_TREE_ID_COLLISION')
  for (const heading of tree.headings) {
    if (!heading || typeof heading.id !== 'string' || !heading.id.trim() || heading.id === INFORMATION_ROOT || ids.has(heading.id)
      || typeof heading.title !== 'string' || !heading.title.trim() || !Array.isArray(heading.children)) throw new Error('CONTEXT_TREE_HEADING_INVALID')
    ids.add(heading.id)
  }
  for (const children of [tree.rootChildren, ...tree.headings.map((heading) => heading.children)]) {
    if (children.some((id) => typeof id !== 'string' || !ids.has(id)) || new Set(children).size !== children.length) throw new Error('CONTEXT_TREE_CHILD_INVALID')
  }
  const paths = contextTreePaths(tree)
  if (paths.size !== ids.size) throw new Error('CONTEXT_TREE_ORPHAN')
  for (const entry of entries) if (JSON.stringify(paths.get(entry.id)) !== JSON.stringify(entry.headingPath)) throw new Error('CONTEXT_TREE_HEADING_PATH_CONFLICT')
}

/** Import preserves the original entry order. Generated legacy heading IDs are deterministic. */
export function legacyContextTree(documentId: string, entries: readonly Entry[]): RuntimeContextTree {
  const tree: RuntimeContextTree = { version: 1, rootChildren: [], headings: [] }
  for (const entry of entries) insertContextEntry(tree, documentId, entry.id, entry.headingPath)
  return tree
}

export function insertContextEntry(tree: RuntimeContextTree, documentId: string, entryId: string, path: readonly string[], parentNodeId?: string, beforeNodeId?: string | null): void {
  let parent = parentNodeId ?? INFORMATION_ROOT
  if (parentNodeId === undefined) {
    for (const title of path) {
      const children = childrenOf(tree, parent)
      const matching = tree.headings.filter((heading) => children.includes(heading.id) && heading.title === title)
      if (matching.length > 1) throw new Error('CONTEXT_TREE_HEADING_PATH_AMBIGUOUS')
      let heading = matching[0]
      if (!heading) {
        let suffix = 0
        let id = `heading-${hash([documentId, parent, title, suffix]).slice(0, 32)}`
        while (tree.headings.some((item) => item.id === id)) id = `heading-${hash([documentId, parent, title, ++suffix]).slice(0, 32)}`
        heading = { id, title, children: [] }; tree.headings.push(heading); children.push(id)
      }
      parent = heading.id
    }
  }
  const children = childrenOf(tree, parent)
  const at = beforeNodeId == null ? children.length : children.indexOf(beforeNodeId)
  if (at < 0) throw new Error('CONTEXT_TREE_ANCHOR_NOT_SIBLING')
  children.splice(at, 0, entryId)
}

export function insertContextSuccessor(tree: RuntimeContextTree, oldId: string, nextId: string): void {
  const parent = maps(tree).parents.get(oldId)
  if (!parent) throw new Error('CONTEXT_TREE_ENTRY_NOT_FOUND')
  const children = childrenOf(tree, parent)
  children.splice(children.indexOf(oldId) + 1, 0, nextId)
}

export function contextTreeOrder(tree: RuntimeContextTree): string[] {
  return [...contextTreePaths(tree).keys()]
}

export function contextTreeHashes(tree: RuntimeContextTree, entries: readonly Entry[]): Map<string, string> {
  const { headings, parents } = maps(tree), entryMap = new Map(entries.map((entry) => [entry.id, entry]))
  const positions = new Map<string, number>()
  for (const children of [tree.rootChildren, ...tree.headings.map((heading) => heading.children)]) children.forEach((id, position) => positions.set(id, position))
  const hashes = new Map<string, string>()
  const visit = (id: string): string => {
    const heading = headings.get(id), entry = entryMap.get(id)
    const children = id === INFORMATION_ROOT ? tree.rootChildren : heading?.children ?? []
    const parentId = parents.get(id)
    const value = hash({ id, parentId, position: positions.get(id) ?? 0,
      ...(heading ? { title: heading.title } : {}), children: children.map((child) => [child, visit(child)]),
      ...(entry ? { revision: entry.revision, status: entry.status } : {}) })
    hashes.set(id, value); return value
  }
  visit(INFORMATION_ROOT)
  return hashes
}

export function contextTreeBindings(tree: RuntimeContextTree, entries: readonly Entry[], entryIds: readonly string[], headingIds: readonly string[] = []): RuntimeContextTreeBinding[] {
  const { headings, parents } = maps(tree), hashes = contextTreeHashes(tree, entries)
  const visible = new Set([INFORMATION_ROOT, ...entryIds, ...headingIds])
  for (const id of [...visible]) { let parent = parents.get(id); while (parent) { visible.add(parent); parent = parents.get(parent) } }
  return [INFORMATION_ROOT, ...contextTreeOrder(tree)].filter((id) => visible.has(id)).map((id) => {
    const heading = headings.get(id), parentId = parents.get(id)
    const children = id === INFORMATION_ROOT ? tree.rootChildren : heading?.children
    return { id, kind: id === INFORMATION_ROOT ? 'root' : heading ? 'heading' : 'entry', hash: hashes.get(id)!,
      ...(parentId ? { parentId } : {}), ...(heading ? { title: heading.title } : {}),
      ...(children ? { childIds: children.filter((child) => visible.has(child)), totalChildren: children.length } : {}) }
  })
}

/** Validate only references actually exposed to this model, before host-side re-projection. */
export function contextTreeProposalError(proposal: { diffVersion?: number; operation: string; target: { nodeId?: string; entryId?: string; headingPath?: string[] }; targetNodeHash?: string; payload: RuntimeContextDiffPayload }, nodes?: readonly RuntimeContextTreeBinding[]): string | undefined {
  if (proposal.diffVersion !== 2) return 'TREE_DIFF_VERSION_REQUIRED'
  if (!proposal.target.nodeId || proposal.target.entryId !== undefined || proposal.target.headingPath !== undefined) return 'TREE_TARGET_INVALID'
  const target = nodes?.find((node) => node.id === proposal.target.nodeId)
  if (!target) return 'TREE_NODE_NOT_IN_PROJECTION'
  if (!proposal.targetNodeHash || proposal.targetNodeHash !== target.hash) return 'TREE_NODE_HASH_CONFLICT'
  if ((proposal.payload.parentNodeId !== undefined && (typeof proposal.payload.parentNodeId !== 'string' || !proposal.payload.parentNodeId.trim()))
    || (proposal.payload.beforeNodeId != null && (typeof proposal.payload.beforeNodeId !== 'string' || !proposal.payload.beforeNodeId.trim()))
    || (proposal.payload.childIds !== undefined && (!Array.isArray(proposal.payload.childIds) || proposal.payload.childIds.some((id) => typeof id !== 'string' || !id.trim())))) return 'TREE_PAYLOAD_INVALID'
  const allowed: Record<string, string[]> = {
    add_heading: ['title', 'beforeNodeId'], rename_heading: ['title'],
    move_node: ['parentNodeId', 'beforeNodeId'], reorder_children: ['childIds'],
  }
  if (!allowed[proposal.operation] || Object.keys(proposal.payload).some((key) => proposal.payload[key as keyof RuntimeContextDiffPayload] !== undefined
    && ![...allowed[proposal.operation]!, 'evidenceRefs', 'classification'].includes(key))) return 'TREE_PAYLOAD_INVALID'
  if (proposal.operation !== 'move_node' && target.kind === 'entry') return 'TREE_TARGET_KIND_INVALID'
  if (proposal.operation === 'rename_heading' && target.kind !== 'heading') return 'TREE_TARGET_KIND_INVALID'
  const refs = [proposal.payload.parentNodeId, proposal.payload.beforeNodeId, ...proposal.payload.childIds ?? []].filter((id): id is string => id != null)
  if (refs.some((id) => !nodes?.some((node) => node.id === id))) return 'TREE_REFERENCE_NOT_IN_PROJECTION'
  return undefined
}

export function contextDocumentList(document: Document, title: string): { list: RuntimeContextListNode[]; nodeIdsByPath: Record<string, string> } {
  const tree = document.tree ?? legacyContextTree(document.id, document.information)
  const { headings } = maps(tree), entries = new Map(document.information.map((entry) => [entry.id, entry]))
  const nodeIdsByPath: Record<string, string> = { '': INFORMATION_ROOT }
  const render = (children: string[], list: RuntimeContextListNode[], prefix: string, depth: number) => {
    for (const id of children) {
      const heading = headings.get(id), entry = entries.get(id)
      if (entry && entry.status !== 'active') continue
      const key = `${prefix}/${list.length}`
      if (heading) {
        const branch: RuntimeContextListNode[] = [`${'#'.repeat(Math.min(depth + 2, 6))} ${heading.title}`]
        render(heading.children, branch, key, depth + 1)
        if (branch.length === 1 && heading.children.length > 0) continue
        list.push(branch); nodeIdsByPath[key] = id
      } else if (entry) { list.push(entry.body); nodeIdsByPath[key] = id }
    }
  }
  const list: RuntimeContextListNode[] = [title]
  render(tree.rootChildren, list, '', 0)
  if (list.length === 1) list.push('暂无正式信息条目')
  return { list, nodeIdsByPath }
}

export function applyContextTreeOperation(tree: RuntimeContextTree, entries: Entry[], operation: string, nodeId: string, payload: RuntimeContextDiffPayload): { changedNodeIds: string[]; changedEntryIds: string[] } {
  const { headings, parents } = maps(tree)
  const affected = new Set<string>(), changed = new Set<string>([nodeId])
  const unchanged = { changedNodeIds: [], changedEntryIds: [] }
  const collect = (id: string) => { affected.add(id); for (const child of headings.get(id)?.children ?? []) collect(child) }
  const insert = (parent: string, id: string) => {
    const children = childrenOf(tree, parent)
    const at = payload.beforeNodeId == null ? children.length : children.indexOf(payload.beforeNodeId)
    if (at < 0) throw new Error('CONTEXT_TREE_ANCHOR_NOT_SIBLING')
    children.splice(at, 0, id); changed.add(parent)
  }
  if (operation === 'add_heading' || operation === 'rename_heading') {
    if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 200 || /[\r\n]/.test(payload.title)) throw new Error('CONTEXT_TREE_TITLE_INVALID')
    if (operation === 'add_heading') {
      childrenOf(tree, nodeId)
      const heading = { id: `heading-${randomUUID()}`, title: payload.title, children: [] as string[] }
      tree.headings.push(heading); insert(nodeId, heading.id); changed.add(heading.id)
    } else {
      const heading = headings.get(nodeId)
      if (!heading) throw new Error('CONTEXT_TREE_HEADING_NOT_FOUND')
      if (heading.title === payload.title) return unchanged
      heading.title = payload.title; collect(nodeId)
    }
  } else if (operation === 'move_node') {
    const oldParent = parents.get(nodeId), destination = payload.parentNodeId
    if (!oldParent || !destination) throw new Error('CONTEXT_TREE_MOVE_INVALID')
    const siblings = childrenOf(tree, oldParent)
    const destinationChildren = childrenOf(tree, destination)
    const position = siblings.indexOf(nodeId)
    if (siblings === destinationChildren && (siblings[position + 1] ?? null) === (payload.beforeNodeId ?? null)) return unchanged
    collect(nodeId)
    if (affected.has(destination) || payload.beforeNodeId === nodeId) throw new Error('CONTEXT_TREE_CYCLE_OR_SELF_ANCHOR')
    siblings.splice(position, 1)
    insert(destination, nodeId); changed.add(oldParent)
  } else if (operation === 'reorder_children') {
    const children = childrenOf(tree, nodeId), requested = payload.childIds
    if (!Array.isArray(requested) || requested.length < 2 || new Set(requested).size !== requested.length || requested.some((id) => !children.includes(id))) throw new Error('CONTEXT_TREE_REORDER_INVALID')
    const selected = new Set(requested); let index = 0
    children.forEach((id, at) => {
      if (!selected.has(id)) return
      const next = requested[index++]!
      if (id !== next) { children[at] = next; collect(id) }
    })
    if (affected.size === 0) return unchanged
  } else throw new Error('CONTEXT_TREE_OPERATION_UNSUPPORTED')
  const paths = contextTreePaths(tree)
  for (const entry of entries) entry.headingPath = paths.get(entry.id) ?? entry.headingPath
  for (const id of affected) changed.add(id)
  return { changedNodeIds: [...changed], changedEntryIds: entries.filter((entry) => affected.has(entry.id)).map((entry) => entry.id) }
}
