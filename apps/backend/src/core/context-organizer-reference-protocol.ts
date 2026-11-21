import { createHash } from 'node:crypto'
import { Ajv } from 'ajv'
import { CONTEXT_CLASSIFICATION_SCHEMA, type ContextClassification } from '#core/context-classification'
import type { ContextDocumentEngineState, Projection } from '#core/context-document-engine'
import type { OrganizationOutput } from '#core/context-organizer'
import type { HookContextProposal } from '#core/hooks/types'
import { CONTEXT_DIFF_OPERATIONS, CONTEXT_TREE_OPERATIONS } from '#protocol/runtime-protocol'

type Scope = 'project' | 'session'
type DocBinding = Pick<HookContextProposal, 'documentId' | 'baseRevision' | 'projectionId' | 'projectionHash'>

export type OrganizationDocumentView =
  | { format: 'none' }
  | { format: 'markdown' | 'references'; maxCharacters: number; bindings: Record<Scope, DocBinding> }
type Edit = Pick<HookContextProposal, 'scope' | 'operation' | 'title' | 'headingPath' | 'body' | 'status' | 'classification'> & {
  observation?: number; candidate?: number; target?: number; parent?: number; before?: number | null; children?: number[]
}

export interface ReferencedOrganizationProposal {
  batch: string
  observations: Array<{ sources: number[]; text?: string; classification?: ContextClassification }>
  edits: Edit[]
  archives: Array<{ sources: number[]; reason: string }>
  fold: boolean
  uncertainties: Array<{ sources: number[]; statement: string }>
}

export interface FileDispositionProposal {
  batch: string
  choices: Array<'K' | 'A' | 'R'>
  heading: string
}

export type OrganizationModelProposal = ReferencedOrganizationProposal | FileDispositionProposal

export interface OrganizationReferenceBinding {
  snapshotId: string
  batch: string
  version?: 3 | 4
  sources: string[]
  documents: Record<Scope, { nodes: string[]; candidates: string[]; binding: DocBinding }>
}

const ref = { type: 'integer', minimum: 1 }
const refs = { type: 'array', uniqueItems: true, items: ref }
const text = { type: 'string', minLength: 1 }
const array = (items: object) => ({ type: 'array', items })
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required })

const referenceOperations = {
  scope: { enum: ['project', 'session'] }, operation: { enum: [...CONTEXT_DIFF_OPERATIONS] },
  observation: ref, candidate: ref, target: ref, parent: ref, before: { anyOf: [ref, { type: 'null' }] },
  children: { ...refs, minItems: 2 }, title: { ...text, maxLength: 200 }, headingPath: array(text),
  status: { enum: ['active', 'superseded', 'archived'] }, classification: CONTEXT_CLASSIFICATION_SCHEMA,
}
const referenceFields = {
  batch: { type: 'string', pattern: '^[a-f0-9]{12}$' },
  archives: array(object({ sources: { ...refs, minItems: 1 }, reason: text })),
  fold: { type: 'boolean' },
  uncertainties: array(object({ sources: refs, statement: text })),
}
export const REFERENCED_ORGANIZATION_SCHEMA = object({
  batch: referenceFields.batch,
  observations: array(object({ sources: { ...refs, minItems: 1 }, text, classification: CONTEXT_CLASSIFICATION_SCHEMA }, ['sources', 'text'])),
  edits: array(object({ ...referenceOperations, body: { type: 'string' } }, ['scope', 'operation'])),
  archives: referenceFields.archives, fold: referenceFields.fold, uncertainties: referenceFields.uncertainties,
})
export const EXTRACTIVE_ORGANIZATION_SCHEMA = object({
  batch: referenceFields.batch,
  observations: array(object({ sources: { ...refs, minItems: 1 }, classification: CONTEXT_CLASSIFICATION_SCHEMA }, ['sources'])),
  edits: array(object(referenceOperations, ['scope', 'operation'])),
  archives: referenceFields.archives, fold: referenceFields.fold, uncertainties: referenceFields.uncertainties,
})
const registry = new Ajv({ allErrors: true })
const validateReferenced = registry.compile<ReferencedOrganizationProposal>(REFERENCED_ORGANIZATION_SCHEMA)
const validateExtractive = registry.compile<ReferencedOrganizationProposal>(EXTRACTIVE_ORGANIZATION_SCHEMA)
export const FILE_DISPOSITION_SCHEMA = object({
  batch: referenceFields.batch,
  choices: { type: 'array', minItems: 1, items: { enum: ['K', 'A', 'R'] } },
  heading: { ...text, maxLength: 100, pattern: '\\S' },
})
const validateDispositions = registry.compile<FileDispositionProposal>(FILE_DISPOSITION_SCHEMA)

export function fileDispositionSchema(count: number) {
  return { ...FILE_DISPOSITION_SCHEMA, properties: {
    ...FILE_DISPOSITION_SCHEMA.properties,
    choices: { type: 'array', minItems: count, maxItems: count, items: { enum: ['K', 'A', 'R'] } },
  } }
}

export function parseFileDispositions(value: unknown, binding: OrganizationReferenceBinding, count: number): FileDispositionProposal {
  if (!validateDispositions(value) || value.choices.length !== count) throw new Error('CONTEXT_ORGANIZATION_DISPOSITION_SCHEMA')
  if (value.batch !== binding.batch) throw new Error('CONTEXT_ORGANIZATION_BINDING_MISMATCH')
  return value
}

interface VisibleSource {
  id: string
  origin: string
  text: string
  hostMetadata?: boolean
  protected?: boolean
  file?: string
  line?: number
}

export function organizeReferenceView(options: {
  snapshotId: string
  version?: 2 | 3 | 4
  sources: VisibleSource[]
  documents: Record<Scope, { document: ContextDocumentEngineState['document']; projection: Projection; binding: DocBinding }>
  canFold: boolean
  task: { instructions: string; latestUser: string; frozenScopes: readonly string[]; prefixCacheScope?: string; archiveReview?: true; archiveReviewScope?: 'window' }
  normalization?: unknown
}) {
  const batch = createHash('sha256').update(options.snapshotId).digest('hex').slice(0, 12)
  const catalogs = (scope: Scope) => {
    const { document, projection, binding } = options.documents[scope]
    const nodes = projection.treeNodes ?? []
    const nodeIndex = new Map(nodes.map((node, index) => [node.id, index + 1]))
    const entries = new Map(document.information.map(entry => [entry.id, entry]))
    const candidates = new Map(document.candidates.map(candidate => [candidate.id, candidate]))
    return {
      binding: { nodes: nodes.map(node => node.id), candidates: projection.sourceCandidateIds, binding },
      view: { omittedSections: projection.truncatedSections,
        nodes: nodes.map((node, index) => ({ ref: index + 1, kind: node.kind,
          ...(node.title ? { title: node.title } : {}), ...(node.parentId ? { parent: nodeIndex.get(node.parentId) } : {}),
          ...(node.childIds ? { children: node.childIds.map(id => nodeIndex.get(id)) } : {}),
          ...(node.kind === 'entry' ? { body: entries.get(node.id)!.body } : {}),
        })),
        candidates: projection.sourceCandidateIds.map((id, index) => {
          const candidate = candidates.get(id)!
          return { ref: index + 1, status: candidate.status, origin: candidate.source.actor,
            text: candidate.normalizedContent, ...(candidate.classification ? { classification: candidate.classification } : {}) }
        }),
      },
    }
  }
  const project = catalogs('project'), session = catalogs('session')
  const binding: OrganizationReferenceBinding = { snapshotId: options.snapshotId, batch, ...(options.version === 3 || options.version === 4 ? { version: options.version } : {}),
    sources: options.sources.map(source => source.id), documents: { project: project.binding, session: session.binding } }
  const sourceRefs = new Map(binding.sources.map((id, index) => [id, index + 1]))
  const normalization = Array.isArray(options.normalization) ? options.normalization.flatMap(value => {
    if (!Array.isArray(value?.sourceRefs) || typeof value.normalizedContent !== 'string') return []
    const refs: Array<number | undefined> = value.sourceRefs.map((id: string) => sourceRefs.get(id))
    return refs.length && refs.every(ref => ref !== undefined) ? [{ sources: refs, text: value.normalizedContent }] : []
  }) : []
  return { binding, input: { organizationVersion: options.version ?? 2, mode: 'organize', batch, canFold: options.canFold, task: options.task,
    sources: options.sources.map(({ id: _id, ...source }, index) => ({ ref: index + 1, ...source })),
    ...(options.version === 4 ? {} : {
      documents: { project: project.view, session: session.view }, ...(normalization.length ? { normalization } : {}),
    }),
  } }
}

export function expandFileDispositions(value: unknown, binding: OrganizationReferenceBinding,
  sources: VisibleSource[], documents: Parameters<typeof organizeReferenceView>[0]['documents'], canFold: boolean,
  duplicateEntries: ReadonlyMap<string, string>): { proposal: FileDispositionProposal; output: OrganizationOutput } {
  const parsed = parseFileDispositions(value, binding, sources.length)
  const observations: ReferencedOrganizationProposal['observations'] = []
  const edits: ReferencedOrganizationProposal['edits'] = []
  const archived: number[] = [], retained: number[] = []
  for (const [i, choice] of parsed.choices.entries()) {
    const source = sources[i]!
    if (choice === 'A') archived.push(i + 1)
    else if (choice === 'R') retained.push(i + 1)
    else {
      const duplicate = duplicateEntries.get(source.id)
      const target = duplicate ? binding.documents.session.nodes.indexOf(duplicate) + 1 : undefined
      if (target === 0) { retained.push(i + 1); continue }
      observations.push({ sources: [i + 1] })
      edits.push({ scope: 'session', observation: observations.length, ...(target
        ? { operation: 'append_evidence', target }
        : { operation: 'add_entry', headingPath: [parsed.heading.trim()] }) })
    }
  }
  const expanded = expandOrganizationReferences({ batch: parsed.batch, observations, edits,
    archives: archived.length ? [{ sources: archived, reason: '整理器判定与当前任务明确无关' }] : [],
    fold: canFold, uncertainties: retained.length ? [{ sources: retained, statement: '留在历史中以便继续核对' }] : [],
  }, binding, sources, documents)
  return { proposal: parsed, output: expanded.output }
}

export function expandOrganizationReferences(value: unknown, binding: OrganizationReferenceBinding,
  sources: VisibleSource[], documents: Parameters<typeof organizeReferenceView>[0]['documents']): {
    proposal: ReferencedOrganizationProposal; output: OrganizationOutput
  } {
  const extractive = binding.version === 3 || binding.version === 4
  const validate = extractive ? validateExtractive : validateReferenced
  if (!validate(value)) throw new Error(`CONTEXT_ORGANIZATION_REFERENCE_SCHEMA: ${validate.errors?.map(item => item.instancePath + ' ' + item.message).join('; ')}`)
  if (value.batch !== binding.batch) throw new Error('CONTEXT_ORGANIZATION_BINDING_MISMATCH')
  const refAt = <T>(catalog: readonly T[], ref: number): T => {
    const match = catalog[ref - 1]
    if (match === undefined) throw new Error('CONTEXT_ORGANIZATION_REFERENCE_UNKNOWN')
    return match
  }
  const ids = (refs: number[]) => refs.map(ref => refAt(binding.sources, ref))
  if (extractive) {
    const archived = new Set(value.archives.flatMap(archive => archive.sources))
    const deferred = new Set(value.uncertainties.flatMap(item => item.sources))
    if (value.observations.some(note => note.sources.some(ref => archived.has(ref)))
      || [...archived].some(ref => deferred.has(ref))) throw new Error('CONTEXT_ORGANIZATION_EXTRACTIVE_DISPOSITION_CONFLICT')
  }
  const notes = value.observations.map(({ sources: refs, text, classification }, index) => {
    if (refs.some(ref => refAt(sources, ref).hostMetadata)) throw new Error('CONTEXT_ORGANIZATION_REFERENCE_SOURCE_NOT_VISIBLE')
    const normalizedContent = extractive ? refs.map(ref => refAt(sources, ref).text).join('\n') : text!
    return { id: `observation-${index + 1}`, sourceRefs: ids(refs), normalizedContent, ...(classification ? { classification } : {}) }
  })
  const edits: HookContextProposal[] = value.edits.map(({ observation, candidate, target, parent, before, children, ...edit }, index) => {
    const catalog = binding.documents[edit.scope]
    const { document, projection } = documents[edit.scope]
    const isTree = (CONTEXT_TREE_OPERATIONS as readonly string[]).includes(edit.operation)
    if (!isTree && (parent !== undefined || before !== undefined || children !== undefined || edit.title !== undefined)) {
      throw new Error('CONTEXT_ORGANIZATION_REFERENCE_OPERATION_MISMATCH')
    }
    const nodeId = (ref: number) => refAt(catalog.nodes, ref)
    const targetId = target === undefined ? undefined : nodeId(target)
    const entry = !isTree && targetId ? document.information.find(item => item.id === targetId) : undefined
    if (!isTree && targetId && !entry) throw new Error('CONTEXT_ORGANIZATION_REFERENCE_OPERATION_MISMATCH')
    const note = observation === undefined ? undefined : refAt(notes, observation)
    if (extractive && (edit.operation === 'add_entry' || edit.operation === 'replace_body' || edit.operation === 'append_evidence') && !note) {
      throw new Error('CONTEXT_ORGANIZATION_EXTRACTIVE_SOURCE_REQUIRED')
    }
    return { ...edit, ...catalog.binding, idempotencyKey: `${binding.snapshotId}:edit:${index + 1}`,
      ...(note ? { sourceObservationId: note.id } : {}),
      ...(candidate === undefined ? {} : { candidateId: refAt(catalog.candidates, candidate) }),
      ...(isTree ? { diffVersion: 2 as const, ...(targetId ? { targetNodeId: targetId,
        targetNodeHash: projection.treeNodes?.find(node => node.id === targetId)?.hash } : {}) } : {}),
      ...(entry ? { targetEntryId: entry.id, targetEntryHash: createHash('sha256').update(entry.body).digest('hex') } : {}),
      ...(parent === undefined ? {} : { parentNodeId: nodeId(parent) }),
      ...(before === undefined ? {} : { beforeNodeId: before === null ? null : nodeId(before) }),
      ...(children === undefined ? {} : { childIds: children.map(nodeId) }),
      ...(edit.operation === 'replace_body' && note && edit.body === undefined ? { body: note.normalizedContent } : {}),
    }
  })
  return { proposal: value, output: { organizationVersion: 1, snapshotId: binding.snapshotId, mode: 'organize',
    observations: notes, diffProposals: edits, recallProposals: [], coverageProposal: value.fold ? 'auto' : null,
    archiveProposals: value.archives.map(({ sources: refs, reason }, index) => {
      if (refs.some(ref => refAt(sources, ref).protected)) throw new Error('CONTEXT_ORGANIZATION_ARCHIVE_PROTECTED')
      return { id: `${binding.snapshotId}:archive:${index + 1}`, sourceRefs: ids(refs), reason }
    }),
    uncertainties: value.uncertainties.map(({ sources, statement }) => ({ sourceRefs: ids(sources), statement })),
  } }
}
