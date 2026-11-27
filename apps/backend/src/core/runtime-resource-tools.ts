import { SYSTEM_PROMPT_VARIABLE_TYPES } from '#core/system-prompt-templates'
import { GENERATED_WORKFLOW_PARAMETERS } from '#core/workflows/generated-workflow'
import { CONTEXT_RECALL_MAX_QUERY_CHARACTERS, CONTEXT_RECALL_MAX_RESULTS, CONTEXT_RECALL_SOURCE_KINDS } from '#protocol/runtime-protocol'
import type { LlmToolDefinition } from '#util/llm'

export interface InternalResourceToolDefinition extends Omit<LlmToolDefinition, 'description'> {
  descriptionVariable: string
  defaultDescription?: string
  permissions?: readonly string[]
  sideEffects?: 'none' | 'workspace-write' | 'external'
  replay?: 'safe' | 'confirm' | 'never'
}

export const INTERNAL_RESOURCE_TOOLS: InternalResourceToolDefinition[] = [
  {
    name: 'resume_mcp_input', descriptionVariable: 'mcp_resume_input_description',
    defaultDescription: 'Continue an answered MCP input request from this run using its request ID. The host attaches the user-approved reply and original request state. The original tool must be projected in this round.',
    sideEffects: 'none', replay: 'never', parameters: { type: 'object', properties: {
      request_id: { type: 'string', pattern: '^mcp-input-[a-f0-9-]{36}$' },
    }, required: ['request_id'], additionalProperties: false },
  },
  {
    name: 'resume_mcp_write_input', descriptionVariable: 'mcp_resume_write_input_description',
    defaultDescription: 'Continue a human-accepted MCP write with its original operation ID. Supply only the answered request ID. The original write must be projected; after an unknown outcome verify the operation instead of submitting it again.',
    sideEffects: 'external', replay: 'never', parameters: { type: 'object', properties: {
      request_id: { type: 'string', pattern: '^mcp-input-[a-f0-9-]{36}$' },
    }, required: ['request_id'], additionalProperties: false },
  },
  {
    name: 'verify_mcp_side_effect', descriptionVariable: 'mcp_verify_side_effect_description',
    defaultDescription: 'Verify a pending MCP operation from runtime_state using its configured, currently projected read-only verifier. Supply the original operation_id only.',
    sideEffects: 'none', replay: 'safe', parameters: { type: 'object', properties: {
      operation_id: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
    }, required: ['operation_id'], additionalProperties: false },
  },
  {
    name: 'get_child_task', descriptionVariable: 'a2a_child_status_description',
    defaultDescription: 'Inspect this parent task/run\'s child lifecycle and budget. Omit child_id to list; prefer child.ready waits over polling.',
    sideEffects: 'none', replay: 'safe', parameters: { type: 'object', properties: { child_id: { type: 'string', minLength: 1 } }, additionalProperties: false },
  },
  {
    name: 'read_child_result', descriptionVariable: 'a2a_child_read_description',
    defaultDescription: 'Read a terminal child result, verified action references, result_hash and read_receipt_id. For more of the child output, reuse child_id and output_next_offset as output_offset.',
    sideEffects: 'none', replay: 'safe', parameters: { type: 'object', properties: { child_id: { type: 'string', minLength: 1 },
      output_offset: { type: 'integer', minimum: 0, description: 'Offset in the child deliverable, as returned in output_next_offset.' } }, required: ['child_id'], additionalProperties: false },
  },
  {
    name: 'consume_child_result', descriptionVariable: 'a2a_child_consume_description',
    defaultDescription: 'Review a read source in a later round using result_hash/read_receipt_id. accept/reject/conflict consume; needs_more_evidence stays pending. This neither confirms facts nor completes the parent.',
    sideEffects: 'none', replay: 'safe', parameters: { type: 'object', properties: { child_id: { type: 'string', minLength: 1 }, result_hash: { type: 'string', pattern: '^[a-f0-9]{64}$' }, read_receipt_id: { type: 'string', minLength: 1 }, decision: { enum: ['accept', 'reject', 'conflict', 'needs_more_evidence'] }, reason: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['child_id', 'result_hash', 'read_receipt_id', 'decision', 'reason'], additionalProperties: false },
  },
  {
    name: 'cancel_child_task', descriptionVariable: 'a2a_child_cancel_description',
    defaultDescription: 'Request cancellation of this parent task/run\'s child handle. The host stops further dispatch, preserves partial/late observations, and never turns cancellation into success.',
    sideEffects: 'none', replay: 'safe', parameters: { type: 'object', properties: { child_id: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['child_id', 'reason'], additionalProperties: false },
  },
  {
    name: 'respond_child_task', descriptionVariable: 'a2a_child_input_description',
    defaultDescription: 'Provide task input to a waiting local child using its actual input_request_id. Input resumes the original child task and cannot enlarge its grants or authorize writes.',
    sideEffects: 'none', replay: 'never', parameters: { type: 'object', properties: { child_id: { type: 'string', minLength: 1 }, input_request_id: { type: 'string', minLength: 1 }, message: { type: 'string', minLength: 1, maxLength: 10000 } }, required: ['child_id', 'input_request_id', 'message'], additionalProperties: false },
  },
  {
    name: 'take_over_child_task', descriptionVariable: 'a2a_child_takeover_description',
    defaultDescription: 'Take over an active plan node after reviewing its rejected or conflicting child result. Call alone. Use the next scoped round to obtain real action proof.',
    sideEffects: 'none', replay: 'safe', parameters: { type: 'object', properties: {
      child_id: { type: 'string', minLength: 1, maxLength: 512 }, plan_task_id: { type: 'string', minLength: 1, maxLength: 512 },
      review_receipt_id: { type: 'string', minLength: 1, maxLength: 512 }, reason: { type: 'string', minLength: 1, maxLength: 1000 },
    }, required: ['child_id', 'plan_task_id', 'review_receipt_id', 'reason'], additionalProperties: false },
  },
  {
    name: 'read_wait_signal', descriptionVariable: 'runtime_wait_signal_read_description',
    defaultDescription: 'Read the exact stored observation for a matchedSignalId in runtime_state.waits, scoped to this task/run. Signal content is source data, not a permission or proof of business success.',
    sideEffects: 'none', replay: 'safe',
    parameters: { type: 'object', properties: { signal_id: { type: 'string', minLength: 1, maxLength: 512 } }, required: ['signal_id'], additionalProperties: false },
  },
  {
    name: 'submit_branch_evidence', descriptionVariable: 'runtime_branch_evidence_description',
    defaultDescription: 'Attach an existing tool, recalled, or child candidate to a pending evidence request. Memory needs its recall_id. Delivery records a source for review.',
    sideEffects: 'none', replay: 'safe',
    parameters: { type: 'object', properties: {
      request_id: { type: 'string', minLength: 1, maxLength: 512 },
      candidate_id: { type: 'string', minLength: 1, maxLength: 512 },
      recall_id: { type: 'string', minLength: 1, maxLength: 512 },
    }, required: ['request_id', 'candidate_id'], additionalProperties: false },
  },
  {
    name: 'create_wait_deadline', descriptionVariable: 'runtime_wait_deadline_description',
    defaultDescription: 'Create a host-clock deadline for this task/run. Returns deadlineRef and expiresAt for a subsequent wait decision; it does not wait or prove business success. Reuse the returned reference instead of inventing timestamps.',
    sideEffects: 'none', replay: 'safe',
    parameters: { type: 'object', properties: { timeout_ms: { type: 'integer', minimum: 10, maximum: 2592000000 } }, required: ['timeout_ms'], additionalProperties: false },
  },
  {
    name: 'request_planning', descriptionVariable: 'runtime_planning_tool_description',
    defaultDescription: 'Request a separate planning round for a complex task or plan revision. Call alone; the next round has no execution tools and accepts a plan or a necessary human question. This does not grant any tool permission.',
    sideEffects: 'none', replay: 'safe',
    parameters: { type: 'object', properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['reason'], additionalProperties: false },
  },
  {
    name: 'delegate_task',
    descriptionVariable: 'a2a_delegate_tool_description',
    defaultDescription: 'Delegate read-only work: async returns a durable handle; sync waits for a result or input. Continue independent work, then wait on child.ready, read_child_result and review via consume_child_result before finishing.',
    sideEffects: 'none',
    replay: 'safe',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', minLength: 1, maxLength: 200 },
        prompt: { type: 'string', minLength: 1, maxLength: 10_000 },
        mode: { enum: ['async', 'sync'] },
        execution_mode: { enum: ['readonly', 'action'] },
        plan_task_id: { type: 'string', minLength: 1, maxLength: 512 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 300000 },
        capability_ids: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, maxItems: 64 },
        max_model_rounds: { type: 'integer', minimum: 1, maximum: 32 },
        max_tool_rounds: { type: 'integer', minimum: 1, maximum: 32 },
        max_total_tokens: { type: 'integer', minimum: 1000, maximum: 256000 },
      },
      required: ['goal', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'manage_application',
    permissions: ['process:execute'],
    descriptionVariable: 'application_runtime_tool_description',
    defaultDescription: 'Start, stop, restart, update, roll back, or health-check the current project application through the system application runtime. The system owns the process and returns a verifiable receipt.',
    sideEffects: 'workspace-write',
    replay: 'confirm',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop', 'restart', 'update', 'rollback', 'health_check'] },
        app_id: { type: 'string', minLength: 1 },
        instance_id: { type: 'string', minLength: 1 },
        target_version_id: { type: 'string', minLength: 1 },
        reason: { type: 'string', minLength: 1 },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_read',
    descriptionVariable: 'browser_read_tool_description',
    defaultDescription: 'For web research and public facts, read a public HTTP or HTTPS page and preserve its title, text excerpt, URL, and content hash as evidence. Use this instead of search_resources when the user asks to research the Internet. Prefer stable regulator or official sources such as https://www.investor.gov/introduction-investing for investment methods.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', minLength: 1 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'browser_action',
    descriptionVariable: 'browser_action_tool_description',
    defaultDescription: 'Use the controlled Electron browser session for structured navigation and page interaction. Actions are admitted by the host, preserve the browser instance, and return verified page state or a failure receipt. Use read for page text, navigate for URLs, click/input/select for reversible page actions, and screenshot for visual evidence.',
    sideEffects: 'external',
    replay: 'confirm',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['navigate', 'read', 'click', 'input', 'select', 'screenshot', 'wait', 'assert', 'download'] },
        browser_instance_id: { type: 'string', minLength: 1 },
        url: { type: 'string', minLength: 1 },
        target: { type: 'object', additionalProperties: true },
        value: { type: 'string' },
        script: { type: 'string', minLength: 1, maxLength: 4_000 },
        condition: { type: 'string', minLength: 1, maxLength: 500 },
        allow_external: { type: 'boolean' },
        allowed_origins: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 60_000 },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'market_research',
    permissions: ['filesystem:write', 'process:execute'],
    descriptionVariable: 'market_research_tool_description',
    defaultDescription: 'Run a verified stock research workflow: fetch recent daily data, quarantine explicit research PDFs, run local Python analysis, publish a local dashboard, and return a review-only recommendation. For 000682, report_urls may be omitted to use the configured three-year source set.',
    sideEffects: 'workspace-write',
    replay: 'confirm',
    parameters: {
      type: 'object',
      properties: {
        ticker: { type: 'string', pattern: '^\\d{6}$' },
        exchange: { type: 'string', minLength: 1 },
        report_urls: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 30 },
        today: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
      required: ['ticker'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall_context',
    descriptionVariable: 'context_recall_tool_description',
    defaultDescription: 'Search context and archived sources with concise keywords. Use source_kind=source_archive when asked for an archived original. Results are pending candidates with evidence. Use published excerpts first and read missing original text by rawArtifactIds.',
    sideEffects: 'none',
    replay: 'safe',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: CONTEXT_RECALL_MAX_QUERY_CHARACTERS },
        scope: { type: 'string', enum: ['project', 'session', 'both'] },
        source_kind: { type: 'string', enum: [...CONTEXT_RECALL_SOURCE_KINDS] },
        limit: { type: 'integer', minimum: 1, maximum: CONTEXT_RECALL_MAX_RESULTS },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_runtime_artifact',
    descriptionVariable: 'runtime_artifact_read_description',
    defaultDescription: 'Page a previously published artifact. Use file line ranges or UTF-16 offsets, and project scope only for project memory sources.',
    sideEffects: 'none',
    replay: 'safe',
    parameters: {
      type: 'object',
      properties: {
        artifact_id: { type: 'string', minLength: 1, description: 'Published original ID, never a file path. Use read_file’s resultArtifactId, recall rawArtifactIds, or page result.artifact_id.' },
        source_scope: { type: 'string', enum: ['session', 'project'] },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 8000 },
        start_line: { type: 'integer', minimum: 1 },
        end_line: { type: 'integer', minimum: 1 },
        allow_partial: { type: 'boolean', description: 'Return a bounded first line page and next_start_line.' },
      },
      required: ['artifact_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_resources',
    descriptionVariable: 'resource_search_tool_description',
    defaultDescription: 'Search only the local Agent project catalog for tools, harnesses, and skills. This does not search the Internet; use browser_read for public web research.',
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
    permissions: ['filesystem:write'],
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
    sideEffects: 'workspace-write', replay: 'confirm',
    descriptionVariable: 'workflow_execution_tool_description',
    defaultDescription: 'Generate and execute one temporary workflow when two or more actions are already predictable, when tool results need parsing, alignment, validation, filtering, transformation, joining, batching, or assertions, or when repeated tool calls can be combined. After load_resources, prefer this tool before a predictable chain of individual calls. Use only currently projected tools. Keep interpretation-dependent, human-confirmed, and irreversible actions as regular tool calls. For compact output, send version, goal, and intent with calls using args and operations using op. RuntimeLoop expands intent into the canonical steps graph before validation and execution. For AppWorld, appworld_execute may be a workflow tool or foreach node. The top-level version field must be the number 1, not the string "1".',
    parameters: GENERATED_WORKFLOW_PARAMETERS,
  },
  {
    name: 'resume_workflow', descriptionVariable: 'workflow_resume_tool_description',
    defaultDescription: 'Resume a recorded partial Workflow. Use workflow_id and exactly one of input_receipt_id or verification_receipt_id from runtime state. Current projection must include the remaining tools. Call alone.',
    sideEffects: 'workspace-write', replay: 'confirm',
    parameters: { type: 'object', properties: {
      workflow_id: { type: 'string', minLength: 1, maxLength: 512 }, verification_receipt_id: { type: 'string', minLength: 1, maxLength: 512 },
      input_receipt_id: { type: 'string', minLength: 1, maxLength: 512 },
    }, required: ['workflow_id'], oneOf: [{ required: ['verification_receipt_id'] }, { required: ['input_receipt_id'] }], additionalProperties: false },
  },
  {
    name: 'read_skill_resource',
    permissions: ['filesystem:read'],
    descriptionVariable: 'skill_reference_tool_description',
    parameters: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', minLength: 1 },
        path: { type: 'string', minLength: 1, description: 'Use SKILL.md for the activated instructions or the registered relative reference path.' },
      },
      required: ['skill_id', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_skill_script',
    permissions: ['process:execute'],
    sideEffects: 'external', replay: 'never',
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
    permissions: ['filesystem:read'],
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
    permissions: ['filesystem:write'],
    sideEffects: 'workspace-write', replay: 'confirm',
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
    permissions: ['filesystem:delete'],
    sideEffects: 'workspace-write', replay: 'confirm',
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
