import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import nunjucks from 'nunjucks'

import type {
  CompressionManifest,
  CompressionPolicy,
  CompressionResource,
} from '#core/compression/types'

export const COMPRESSION_VARIABLES = [
  'compression.base_revision',
  'compression.source_hash',
  'compression.source_units',
  'compression.current_tokens',
  'compression.target_tokens',
  'compression.output_schema',
] as const

export const COMPRESSION_OUTPUT_SCHEMA = {
  version: 1,
  base_revision: 0,
  source_hash: 'sha256',
  patch_status: 'complete',
  operations: [{
    op: 'replace_with_summary',
    source_unit_ids: ['unit-id'],
    summary: {
      facts: ['string'],
      decisions: ['string'],
      user_requirements: ['string'],
      completed_work: ['string'],
      open_items: ['string'],
      important_evidence: ['string'],
    },
  }],
} as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function ratio(value: unknown, name: string): number {
  if (typeof value !== 'number' || value <= 0 || value >= 1) {
    throw new Error(`${name} must be a number between 0 and 1`)
  }
  return value
}

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return Number(value)
}

function validatePolicy(value: unknown): CompressionPolicy {
  if (!isObject(value)) throw new Error('compression policy must be an object')
  const triggerRatio = ratio(value.trigger_ratio, 'policy.trigger_ratio')
  const targetRatio = ratio(value.target_ratio, 'policy.target_ratio')
  if (targetRatio >= triggerRatio) {
    throw new Error('policy.target_ratio must be lower than policy.trigger_ratio')
  }
  if (value.apply_mode !== 'automatic' && value.apply_mode !== 'debug') {
    throw new Error('policy.apply_mode must be automatic or debug')
  }
  return {
    trigger_ratio: triggerRatio,
    target_ratio: targetRatio,
    preserve_recent_turns: integer(
      value.preserve_recent_turns,
      'policy.preserve_recent_turns',
      1,
      100,
    ),
    max_source_tokens: integer(
      value.max_source_tokens,
      'policy.max_source_tokens',
      256,
      1_000_000,
    ),
    max_output_tokens: integer(
      value.max_output_tokens,
      'policy.max_output_tokens',
      128,
      100_000,
    ),
    retry_limit: integer(value.retry_limit, 'policy.retry_limit', 0, 5),
    apply_mode: value.apply_mode,
  }
}

function validateManifest(value: unknown): CompressionManifest {
  if (!isObject(value) || value.version !== 1) {
    throw new Error('compression manifest must be a version 1 object')
  }
  for (const name of ['id', 'name', 'description', 'entry'] as const) {
    if (typeof value[name] !== 'string' || !value[name].trim()) {
      throw new Error(`compression manifest ${name} must be a non-empty string`)
    }
  }
  if (!/^[a-z][a-z0-9-]*$/.test(value.id as string)) {
    throw new Error('compression manifest id must use lowercase kebab-case')
  }
  const entry = (value.entry as string).replaceAll('\\', '/')
  if (!entry.endsWith('.j2') || path.posix.isAbsolute(entry) || entry.split('/').includes('..')) {
    throw new Error('compression manifest entry must be a project-relative .j2 file')
  }
  return {
    version: 1,
    id: (value.id as string).trim(),
    name: (value.name as string).trim(),
    description: (value.description as string).trim(),
    entry,
    policy: validatePolicy(value.policy),
  }
}

export class CompressionResourceStore {
  constructor(readonly projectDir: string, readonly manifestPath: string) {}

  read(): CompressionResource {
    const manifestFile = this.resolveProjectFile(this.manifestPath)
    if (!fs.existsSync(manifestFile)) {
      throw new Error(`compression manifest was not found: ${this.manifestPath}`)
    }
    const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')))
    const entryFile = this.resolveAdjacentFile(manifestFile, manifest.entry)
    if (!fs.existsSync(entryFile)) throw new Error(`compression prompt was not found: ${manifest.entry}`)
    const prompt = fs.readFileSync(entryFile, 'utf8')
    const revision = this.revision(manifest, prompt)
    const diagnostics = prompt.includes('compression.output_schema')
      ? []
      : [{
          severity: 'warning' as const,
          code: 'COMPRESSION_OUTPUT_SCHEMA_UNUSED',
          message: 'prompt does not reference compression.output_schema',
        }]
    return {
      manifest,
      prompt,
      revision,
      source: path.relative(this.projectDir, manifestFile).replaceAll('\\', '/'),
      variables: [...COMPRESSION_VARIABLES],
      diagnostics,
    }
  }

  save(value: unknown): CompressionResource {
    if (!isObject(value) || typeof value.prompt !== 'string' || typeof value.baseRevision !== 'string') {
      throw new Error('compression save requires manifest, prompt, and baseRevision')
    }
    const current = this.read()
    if (value.baseRevision !== current.revision) {
      throw new Error(`compression resource revision conflict: ${current.revision}`)
    }
    const manifest = validateManifest(value.manifest)
    const manifestFile = this.resolveProjectFile(this.manifestPath)
    const entryFile = this.resolveAdjacentFile(manifestFile, manifest.entry)
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true })
    fs.mkdirSync(path.dirname(entryFile), { recursive: true })
    fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    fs.writeFileSync(entryFile, value.prompt, 'utf8')
    return this.read()
  }

  render(resource: CompressionResource, context: Record<string, unknown>): string {
    const environment = new nunjucks.Environment(undefined, {
      autoescape: false,
      throwOnUndefined: true,
    })
    return environment.renderString(resource.prompt, context).trim()
  }

  private revision(manifest: CompressionManifest, prompt: string): string {
    return createHash('sha256')
      .update(JSON.stringify(manifest))
      .update('\0')
      .update(prompt)
      .digest('hex')
  }

  private resolveProjectFile(relative: string): string {
    const target = path.resolve(this.projectDir, relative)
    const boundary = path.relative(this.projectDir, target)
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) {
      throw new Error('compression resource must stay inside the project')
    }
    return target
  }

  private resolveAdjacentFile(manifestFile: string, relative: string): string {
    const target = path.resolve(path.dirname(manifestFile), relative)
    const boundary = path.relative(this.projectDir, target)
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) {
      throw new Error('compression prompt must stay inside the project')
    }
    return target
  }
}
