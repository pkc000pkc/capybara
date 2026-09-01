import { SYSTEM_PROMPT_VARIABLE_TYPES } from '#core/system-prompt-templates'
import { GENERATED_WORKFLOW_PARAMETERS } from '#core/workflows/generated-workflow'
import type { LlmToolDefinition } from '#util/llm'

export interface InternalResourceToolDefinition extends Omit<LlmToolDefinition, 'description'> {
  descriptionVariable: string
  defaultDescription?: string
  sideEffects?: 'none' | 'workspace-write' | 'external'
  replay?: 'safe' | 'confirm' | 'never'
}

export const INTERNAL_RESOURCE_TOOLS: InternalResourceToolDefinition[] = [
  {
    name: 'search_resources',
    descriptionVariable: 'resource_search_tool_description',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: ['tool', 'harness', 'skill'] },
          uniqueItems: true,
        },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'load_resources',
    descriptionVariable: 'resource_load_tool_description',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_system_variables',
    descriptionVariable: 'system_variable_read_tool_description',
    defaultDescription: 'Read selected system prompt variables and the current revision before changing them.',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          uniqueItems: true,
          items: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'apply_system_variable_changes',
    descriptionVariable: 'system_variable_apply_tool_description',
    defaultDescription: 'Atomically add, patch, replace, or remove system prompt variables using the latest revision and return a validated diff.',
    sideEffects: 'workspace-write',
    replay: 'never',
    parameters: {
      type: 'object',
      properties: {
        base_revision: { type: 'string', minLength: 1 },
        changes: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            oneOf: [
              {
                type: 'object',
                description: 'Create a variable or replace its complete definition and value.',
                properties: {
                  op: { type: 'string', enum: ['upsert'] },
                  key: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
                  type: { type: 'string', enum: [...SYSTEM_PROMPT_VARIABLE_TYPES] },
                  label: { type: 'string' },
                  description: { type: 'string' },
                  value: {},
                  expected_value_sha256: {
                    oneOf: [
                      { type: 'string', pattern: '^[a-f0-9]{64}$' },
                      { type: 'null' },
                    ],
                    description: 'Use null to assert creation, or the hash returned by read_system_variables to replace an existing value.',
                  },
                  required: { type: 'boolean' },
                  show_in_status: { type: 'boolean' },
                  scope: { type: 'string', enum: ['session', 'project'] },
                },
                required: ['op', 'key', 'value', 'expected_value_sha256'],
                additionalProperties: false,
              },
              {
                type: 'object',
                description: 'Patch only the value of an existing variable with exact text replacements.',
                properties: {
                  op: { type: 'string', enum: ['patch'] },
                  key: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
                  expected_value_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                  edits: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 50,
                    items: {
                      type: 'object',
                      properties: {
                        old_text: { type: 'string', minLength: 1 },
                        new_text: { type: 'string' },
                      },
                      required: ['old_text', 'new_text'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['op', 'key', 'expected_value_sha256', 'edits'],
                additionalProperties: false,
              },
              {
                type: 'object',
                description: 'Apply RFC 6902 add/remove/replace operations to an array or object variable.',
                properties: {
                  op: { type: 'string', enum: ['json_patch'] },
                  key: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
                  expected_value_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                  patch: {
                    type: 'array', minItems: 1, maxItems: 100,
                    items: {
                      type: 'object',
                      properties: {
                        op: { type: 'string', enum: ['add', 'remove', 'replace'] },
                        path: { type: 'string', pattern: '^(/[^/~]*(~[01][^/~]*)*)*$' },
                        value: {},
                      },
                      required: ['op', 'path'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['op', 'key', 'expected_value_sha256', 'patch'],
                additionalProperties: false,
              },
              {
                type: 'object',
                description: 'Remove an existing variable.',
                properties: {
                  op: { type: 'string', enum: ['remove'] },
                  key: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
                  expected_value_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                },
                required: ['op', 'key', 'expected_value_sha256'],
                additionalProperties: false,
              },
            ],
          },
        },
      },
      required: ['base_revision', 'changes'],
      additionalProperties: false,
    },
  },
  {
    name: 'execute_workflow',
    descriptionVariable: 'workflow_execution_tool_description',
    parameters: GENERATED_WORKFLOW_PARAMETERS,
  },
  {
    name: 'read_skill_resource',
    descriptionVariable: 'skill_reference_tool_description',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
      },
      required: ['skill_id', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_skill_script',
    descriptionVariable: 'skill_script_tool_description',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1 },
        argv: {
          type: 'array',
          maxItems: 100,
          items: { type: 'string', maxLength: 4096 },
        },
      },
      required: ['skill_id', 'path', 'argv'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_skill_marketplace',
    descriptionVariable: 'skill_marketplace_search_tool_description',
    defaultDescription: 'Search the GitHub Skill marketplace for project Skills. This is read-only. Preview a result before requesting installation.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 120 },
        owner: { type: 'string', minLength: 1, maxLength: 100 },
        page: { type: 'integer', minimum: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'preview_skill_marketplace',
    descriptionVariable: 'skill_marketplace_preview_tool_description',
    defaultDescription: 'Download and inspect a GitHub Skill in temporary staging. Returns its immutable commit, files, scripts, and warnings without changing the project.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
        path: { type: 'string', minLength: 1, maxLength: 512 },
      },
      required: ['repo', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_installed_skills',
    descriptionVariable: 'skill_marketplace_installed_tool_description',
    defaultDescription: 'List project-installed Skills and report their source, immutable commit, and whether local files changed. This is read-only.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'request_skill_install',
    descriptionVariable: 'skill_marketplace_install_tool_description',
    defaultDescription: 'Request installation of an already previewed GitHub Skill at its full 40-character commit SHA. This only creates a pending user confirmation; it never installs directly.',
    parameters: {
      type: 'object',
      properties: {
        repo: { type: 'string', pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' },
        path: { type: 'string', minLength: 1, maxLength: 512 },
        commit: { type: 'string', pattern: '^[a-f0-9]{40}$' },
      },
      required: ['repo', 'path', 'commit'],
      additionalProperties: false,
    },
  },
  {
    name: 'request_skill_uninstall',
    descriptionVariable: 'skill_marketplace_uninstall_tool_description',
    defaultDescription: 'Request removal of an installed project Skill. This only creates a pending user confirmation; it never removes files directly.',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', minLength: 1 },
      },
      required: ['skill_id'],
      additionalProperties: false,
    },
  },
]
