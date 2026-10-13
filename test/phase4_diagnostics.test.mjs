import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { classifyExecutionFailure } from '../src/phase1_errors.mjs'
import { ERROR_CODES, ERROR_TYPES, safeModelDiagnostic, buildFailureDiagnostics, safeEvidenceGateCode } from '../src/phase1_diagnostics.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = process.env.GAIA2_PYTHON || 'C:/Users/pkc00/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'

function pythonFakes(source) {
  const result = spawnSync(python, ['-B', '-c', source], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
}

test('Python diagnostics expose only fixed error enums and SDK provenance, never dispatch proof', () => {
  pythonFakes(String.raw`
import sys, json
from types import SimpleNamespace
sys.path.insert(0, 'scripts')
from gaia2_model_diagnostics import ERROR_CODES, ERROR_TYPES, safe_request_summary, safe_model_diagnostics

assert ERROR_CODES == frozenset({
    'invalid_api_key', 'insufficient_quota', 'invalid_request_error', 'model_not_found',
    'unsupported_provider', 'configuration_error', 'context_length_exceeded',
    'invalid_service_tier', 'rate_limit_exceeded', 'server_is_overloaded',
    'credit_balance_exhausted', 'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', '429',
})
assert ERROR_TYPES == frozenset({
    'invalid_request_error', 'rate_limit_error', 'insufficient_quota',
    'authentication_error', 'permission_error', 'server_error',
    'service_unavailable_error', 'throttling_error',
})

class BadRequestError(Exception):
    pass
class PrivateSubclass(BadRequestError):
    pass
summary = safe_request_summary({})
for code in ERROR_CODES:
    for kind in ERROR_TYPES:
        for source in ('sdk_body', 'sdk_response_json', 'sdk_attribute'):
            error = PrivateSubclass('SECRET_MESSAGE https://SECRET_ENDPOINT SECRET_KEY')
            error.status_code = 400
            body = {'error': {'code': code, 'type': kind, 'message': 'SECRET_BODY', 'param': 'SECRET_PARAM'}}
            if source == 'sdk_body':
                error.body = body
            elif source == 'sdk_response_json':
                error.response = SimpleNamespace(status_code=400, json=lambda: body)
            else:
                error.code, error.type = code, kind
            diagnostic = safe_model_diagnostics(error, summary)
            assert diagnostic['schemaVersion'] == 'gaia2-model-diagnostic-v1'
            assert diagnostic['sdkReportedStatus'] == 400
            assert diagnostic['dispatchObserved'] is None
            assert diagnostic['errorCode'] == code and diagnostic['errorType'] == kind
            assert diagnostic['codeSource'] == source and diagnostic['typeSource'] == source
            assert diagnostic['exceptionClass'] == 'BadRequestError'
            assert set(diagnostic) == {'schemaVersion','sdkReportedStatus','dispatchObserved','errorCode','errorType','codeSource','typeSource','exceptionClass','requestSummary'}
            assert 'SECRET' not in json.dumps(diagnostic)

for value in ('SECRET_CODE', 'INVALID_API_KEY', ' invalid_api_key', 'invalid_api_key ', 'SECRET_' * 1000, None, True, 400, [], {}):
    error = Exception('SECRET_MESSAGE')
    error.body = {'error': {'code': value, 'type': value, 'message': 'SECRET_BODY'}}
    diagnostic = safe_model_diagnostics(error, summary)
    assert diagnostic['errorCode'] is None and diagnostic['errorType'] is None
    assert diagnostic['codeSource'] is None and diagnostic['typeSource'] is None
    assert diagnostic['exceptionClass'] is None and diagnostic['dispatchObserved'] is None
    assert 'SECRET' not in json.dumps(diagnostic)

for status in (True, '400', 99, 600, None):
    error = Exception('SECRET_MESSAGE')
    error.status_code = status
    assert safe_model_diagnostics(error, summary)['sdkReportedStatus'] is None

class UnreadableError(Exception):
    @property
    def body(self): raise RuntimeError('SECRET_GETTER')
    @property
    def code(self): raise RuntimeError('SECRET_GETTER')
    @property
    def response(self): raise RuntimeError('SECRET_GETTER')
assert 'SECRET' not in json.dumps(safe_model_diagnostics(UnreadableError(), summary))
`)
})

test('Python request diagnostics count supported structure without copying or consuming private inputs', () => {
  pythonFakes(String.raw`
import sys, json, copy
sys.path.insert(0, 'scripts')
from gaia2_model_diagnostics import safe_request_summary

messages = [
    {'role':'system', 'content':'汉字SECRET_CONTENT'},
    {'role':'developer', 'content':'developer'},
    {'role':'user', 'content':[
        {'type':'text','text':'user'}, {'type':'input_text','text':'输入'},
        {'type':'output_text','text':'output'},
        {'type':'image_url','image_url':{'url':'https://SECRET_IMAGE_ENDPOINT'}},
        {'type':'input_image','image_url':'SECRET_IMAGE_DATA'},
    ]},
    {'role':'assistant','content':None,'tool_calls':[{'function':{'name':'SECRET_TOOL','arguments':'SECRET_ARGUMENTS'}}]},
    {'role':'tool','content':'tool-result','name':'SECRET_TOOL','tool_call_id':'SECRET_ID'},
    {'role':'function','content':'function-result','name':'SECRET_FUNCTION'},
    {'role':'SECRET_UNKNOWN_ROLE','content':'unknown'},
]
tools = [
    {'type':'function','function':{'name':'SECRET_TOOL_A','parameters':{'type':'object','description':'SECRET_SCHEMA'}}},
    {'type':'function','function':{'name':'SECRET_TOOL_B','parameters':{'type':'object'}}},
]
request = {'messages':messages,'tools':tools,'api_key':'SECRET_KEY','api_base':'https://SECRET_ENDPOINT'}
original = copy.deepcopy(request)
summary = safe_request_summary(request)
assert set(summary) == {'messagesCount','roles','contentUtf8Bytes','imageParts','toolsCount','toolDefinitionsUtf8Bytes'}
assert summary['messagesCount'] == 7
assert summary['roles'] == {role:1 for role in ('system','developer','user','assistant','tool','function','unknown')}
assert summary['contentUtf8Bytes'] == sum(len(s.encode('utf-8')) for s in ('汉字SECRET_CONTENT','developer','user','输入','output','tool-result','function-result','unknown'))
assert summary['imageParts'] == 2 and summary['toolsCount'] == 2
assert summary['toolDefinitionsUtf8Bytes'] == len(json.dumps(tools,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8'))
assert request == original and 'SECRET' not in json.dumps(summary)

for request in ({}, {'messages':None,'tools':None}, {'messages':'SECRET_CONTENT','tools':'SECRET_TOOL'}, {'messages':[object()],'tools':[object()]}):
    summary = safe_request_summary(request)
    assert summary['messagesCount'] is None and summary['toolsCount'] is None
    assert summary['contentUtf8Bytes'] is None and summary['imageParts'] is None
    assert summary['toolDefinitionsUtf8Bytes'] is None
    assert all(value is None for value in summary['roles'].values())

seen = []
def private_generator():
    seen.append('consumed')
    yield {'role':'user','content':'SECRET_CONTENT'}
summary = safe_request_summary({'messages':private_generator()})
assert seen == [] and summary['messagesCount'] is None
summary = safe_request_summary({'messages':[{'role':'user','content':[{'type':'SECRET_UNKNOWN_PART','data':'SECRET_DATA'}]}]})
assert summary['messagesCount'] == 1 and summary['roles']['user'] == 1
assert summary['contentUtf8Bytes'] is None and summary['imageParts'] is None
assert 'SECRET' not in json.dumps(summary)
assert safe_request_summary({'messages':[],'tools':[]})['messagesCount'] == 0
`)
})

test('Python diagnostic integration preserves six attempts, timeout, capped backoff and request identity', () => {
  pythonFakes(String.raw`
import sys, json, copy
sys.path.insert(0, 'scripts')
from gaia2_model_retry import ModelRetryPolicy, ModelRequestFailure, wrap_completion, classify_model_error

class HttpFailure(Exception):
    def __init__(self, status, body=None):
        super().__init__('SECRET_ERROR SECRET_KEY https://SECRET_ENDPOINT')
        self.status_code, self.body = status, body or {}

def run(policy):
    clock, waits, events, calls = [0.0], [], [], []
    messages = [{'role':'user','content':'SECRET_PROMPT'}]
    tools = [{'type':'function','function':{'name':'SECRET_TOOL','parameters':{'type':'object'}}}]
    original = copy.deepcopy({'messages':messages,'tools':tools})
    def completion(*args, **kwargs):
        calls.append(kwargs)
        assert kwargs['messages'] is messages and kwargs['tools'] is tools
        assert kwargs['messages'] == original['messages'] and kwargs['tools'] == original['tools']
        raise HttpFailure(503, {'error':{'code':'SECRET_CODE','type':'SECRET_TYPE','message':'SECRET_BODY'}})
    def sleep(seconds):
        waits.append(seconds)
        clock[0] += seconds
    wrapped = wrap_completion(completion,'actor',lambda kind,**kw:events.append({'type':kind,**kw}),policy=policy,clock=lambda:clock[0],sleep=sleep)
    try:
        wrapped(messages=messages,tools=tools,timeout=99,num_retries=99,max_retries=99)
    except ModelRequestFailure as error:
        failure = error
    else:
        raise AssertionError('six model failures must remain terminal')
    assert {'messages':messages,'tools':tools} == original
    assert all(call['timeout']==60 and call['num_retries']==call['max_retries']==0 for call in calls)
    assert all(call['retry_policy'] is None and call['drop_params'] is False and call['fallbacks']==[] and call['context_window_fallback_dict']=={} for call in calls)
    assert failure.category == 'transport_error' and failure.retryable
    assert failure.__cause__ is None and failure.__suppress_context__
    assert failure.metadata['retryExhausted']
    assert 'SECRET' not in json.dumps(events) and 'SECRET' not in json.dumps(failure.metadata)
    for event in events:
        if event['type'] == 'model_request_attempt':
            assert event['requestSummary']['messagesCount'] == 1
            assert event['requestSummary']['toolsCount'] == 1
        if event['type'] in ('model_request_failed','model_retry_scheduled'):
            assert event['diagnostic']['dispatchObserved'] is None
            assert event['diagnostic']['errorCode'] is None and event['diagnostic']['errorType'] is None
    return calls, waits, events, failure

policy = ModelRetryPolicy()
assert (policy.max_attempts,policy.request_timeout_seconds,policy.backoff_base_seconds,policy.backoff_max_seconds) == (6,60,2,120)
calls, waits, events, failure = run(policy)
assert len(calls) == 6 and waits == [2,4,8,16,30,2]
assert [event['waitSeconds'] for event in events if event['type']=='model_retry_scheduled'] == [2,4,8,16,32]
assert failure.metadata['cumulativeWaitSeconds'] == 62
calls, waits, events, failure = run(ModelRetryPolicy(max_attempts=8))
assert len(calls) == 8
assert [event['waitSeconds'] for event in events if event['type']=='model_retry_scheduled'] == [2,4,8,16,32,64,120]

class BadRequestError(HttpFailure): pass
events, calls, waits = [], [], []
def completion(**kwargs):
    calls.append(kwargs)
    raise BadRequestError(400, {'error':{'code':'invalid_request_error','type':'invalid_request_error','message':'SECRET_BODY','param':'SECRET_PARAM'}})
wrapped = wrap_completion(completion,'judge',lambda kind,**kw:events.append({'type':kind,**kw}),policy=ModelRetryPolicy(),sleep=lambda seconds:waits.append(seconds))
try:
    wrapped(messages=[{'role':'user','content':'SECRET_PROMPT'}])
except ModelRequestFailure as error:
    assert error.category == 'configuration_error' and not error.retryable
    assert error.metadata['diagnostic']['sdkReportedStatus'] == 400
    assert error.metadata['diagnostic']['dispatchObserved'] is None
else:
    raise AssertionError('SDK 400 must remain fatal')
assert len(calls) == 1 and waits == []
assert 'SECRET' not in json.dumps(events)
assert classify_model_error(HttpFailure(429, {'error':{'code':'insufficient_quota'}}))['category'] == 'configuration_error'
class TimeoutError(HttpFailure): pass
class ConnectionError(HttpFailure): pass
class AuthenticationError(HttpFailure): pass
for error, expected in ((TimeoutError(400),'configuration_error'),(ConnectionError(429),'rate_limit'),(ConnectionError(408),'request_timeout'),(AuthenticationError(503),'configuration_error')):
    assert classify_model_error(error)['category'] == expected
`)
  })

const roles = ['system', 'developer', 'user', 'assistant', 'tool', 'function', 'unknown']
const requestSummary = () => ({
  messagesCount: 2, roles: Object.fromEntries(roles.map(role => [role, role === 'user' ? 2 : 0])),
  contentUtf8Bytes: 42, imageParts: 1, toolsCount: 1, toolDefinitionsUtf8Bytes: 80,
})
const modelDiagnostic = (overrides = {}) => ({
  schemaVersion: 'gaia2-model-diagnostic-v1', sdkReportedStatus: 400, dispatchObserved: true,
  errorCode: 'invalid_request_error', errorType: 'invalid_request_error',
  codeSource: 'sdk_body', typeSource: 'sdk_body', exceptionClass: 'BadRequestError',
  requestSummary: requestSummary(), ...overrides,
})
const modelFailure = (overrides = {}) => ({
  type: 'model_request_failed', requestId: 'SECRET_REQUEST_ID', category: 'configuration_error',
  retryable: false, httpStatus: 400, modelRole: 'judge', requestAttempt: 1,
  nextRetryAt: null, cumulativeWaitSeconds: 0, retryExhausted: false,
  diagnostic: modelDiagnostic(), message: 'SECRET_ERROR_MESSAGE', ...overrides,
})

test('Node revalidates fixed enums and strips forged transport claims and all private fields', () => {
  assert.deepEqual(ERROR_CODES, [
    'invalid_api_key', 'insufficient_quota', 'invalid_request_error', 'model_not_found',
    'unsupported_provider', 'configuration_error', 'context_length_exceeded',
    'invalid_service_tier', 'rate_limit_exceeded', 'server_is_overloaded',
    'credit_balance_exhausted', 'organization_spend_limit_exceeded',
    'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', '429',
  ])
  assert.deepEqual(ERROR_TYPES, [
    'invalid_request_error', 'rate_limit_error', 'insufficient_quota',
    'authentication_error', 'permission_error', 'server_error',
    'service_unavailable_error', 'throttling_error',
  ])
  assert.equal(Object.isFrozen(ERROR_CODES), true)
  assert.equal(Object.isFrozen(ERROR_TYPES), true)
  for (const errorCode of ERROR_CODES) {
    for (const errorType of ERROR_TYPES) {
      for (const source of ['sdk_body', 'sdk_response_json', 'sdk_attribute']) {
        const diagnostic = safeModelDiagnostic(modelDiagnostic({ errorCode, errorType, codeSource: source, typeSource: source }))
        assert.equal(diagnostic.errorCode, errorCode)
        assert.equal(diagnostic.errorType, errorType)
        assert.equal(diagnostic.codeSource, source)
        assert.equal(diagnostic.typeSource, source)
        assert.equal(diagnostic.dispatchObserved, null)
      }
    }
  }
  for (const value of ['SECRET_ENUM', 'INVALID_REQUEST_ERROR', ' invalid_request_error', 'invalid_request_error ', null, true, 400, [], {}]) {
    const diagnostic = safeModelDiagnostic(modelDiagnostic({ errorCode: value, errorType: value, exceptionClass: value }))
    assert.equal(diagnostic.errorCode, null)
    assert.equal(diagnostic.errorType, null)
    assert.equal(diagnostic.codeSource, null)
    assert.equal(diagnostic.typeSource, null)
    assert.equal(diagnostic.exceptionClass, null)
  }
  const input = modelDiagnostic({
    schemaVersion: 'SECRET_SCHEMA', message: 'SECRET_MESSAGE', body: { error: 'SECRET_BODY' },
    param: 'SECRET_PARAM', endpoint: 'https://SECRET_ENDPOINT', apiKey: 'SECRET_KEY',
    requestSummary: { ...requestSummary(), messages: [{ content: 'SECRET_PROMPT' }], tools: [{ name: 'SECRET_TOOL', arguments: 'SECRET_ARGUMENTS' }] },
  })
  const before = structuredClone(input)
  const diagnostic = safeModelDiagnostic(input)
  assert.deepEqual(input, before)
  assert.deepEqual(Object.keys(diagnostic).sort(), ['schemaVersion', 'sdkReportedStatus', 'dispatchObserved', 'errorCode', 'errorType', 'codeSource', 'typeSource', 'exceptionClass', 'requestSummary'].sort())
  assert.deepEqual(diagnostic.requestSummary, requestSummary())
  assert.equal(diagnostic.schemaVersion, 'gaia2-model-diagnostic-v1')
  assert.equal(diagnostic.sdkReportedStatus, 400)
  assert.equal(diagnostic.dispatchObserved, null)
  assert.equal(JSON.stringify(diagnostic).includes('SECRET'), false)
  assert.equal(safeModelDiagnostic(modelDiagnostic({ codeSource: 'SECRET_SOURCE', typeSource: 'SECRET_SOURCE' })).codeSource, null)
  assert.equal(safeModelDiagnostic(modelDiagnostic({ codeSource: 'SECRET_SOURCE', typeSource: 'SECRET_SOURCE' })).typeSource, null)
})

test('Node request counters reject booleans, invalid numbers and unsupported event shapes', () => {
  for (const value of [true, false, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, 'SECRET_COUNT', null]) {
    const diagnostic = safeModelDiagnostic(modelDiagnostic({
      requestSummary: { messagesCount: value, roles: Object.fromEntries(roles.map(role => [role, value])),
        contentUtf8Bytes: value, imageParts: value, toolsCount: value, toolDefinitionsUtf8Bytes: value },
    }))
    const summary = diagnostic.requestSummary
    assert.equal(summary.messagesCount, null)
    assert.equal(summary.contentUtf8Bytes, null)
    assert.equal(summary.imageParts, null)
    assert.equal(summary.toolsCount, null)
    assert.equal(summary.toolDefinitionsUtf8Bytes, null)
    assert.deepEqual(summary.roles, Object.fromEntries(roles.map(role => [role, null])))
  }
  for (const value of [true, '400', 99, 600, Infinity, null]) {
    assert.equal(safeModelDiagnostic(modelDiagnostic({ sdkReportedStatus: value })).sdkReportedStatus, null)
  }
  for (const value of [undefined, null, 'SECRET_VALUE', 42, []]) {
    const diagnostic = safeModelDiagnostic(value)
    assert.equal(diagnostic.dispatchObserved, null)
    assert.equal(diagnostic.requestSummary.messagesCount, null)
    assert.equal(JSON.stringify(diagnostic).includes('SECRET'), false)
  }
  const summary = safeModelDiagnostic(modelDiagnostic({ requestSummary: { ...requestSummary(), roles: { user: 2, SECRET_ROLE: 100 } } })).requestSummary
  assert.deepEqual(Object.keys(summary.roles), roles)
  assert.equal(summary.roles.user, 2)
  assert.equal(Object.hasOwn(summary.roles, 'SECRET_ROLE'), false)
})

test('failure causes retain both model SDK error and evidence gates without copying raw failure data', () => {
  const failed = modelFailure()
  const events = [{ type: 'model_request_attempt' }, { type: 'unrelated', message: 'SECRET_OTHER' }, failed]
  const input = {
    processResult: { loggingError: 'runtime_hook_evidence_invalid', evidenceGateCode: 'missing_tool_gate_evidence', message: 'SECRET_PROCESS' },
    report: { hasException: true, evaluationComplete: true, businessPassed: false, exception: 'SECRET_REPORT' }, events,
  }
  const diagnostic = buildFailureDiagnostics(input)
  assert.equal(diagnostic.schemaVersion, 'gaia2-execution-failure-diagnostic-v1')
  assert.deepEqual(diagnostic.causes.map(cause => cause.stage), ['model_request', 'evidence_gate', 'evidence_gate'])
  assert.deepEqual(diagnostic.causes.slice(1), [
    { stage: 'evidence_gate', code: 'runtime_hook_evidence_invalid' },
    { stage: 'evidence_gate', code: 'missing_tool_gate_evidence' },
  ])
  const model = diagnostic.causes[0]
  assert.equal(model.eventIndex, 2)
  assert.equal(model.category, 'configuration_error')
  assert.equal(model.modelRole, 'judge')
  assert.equal(model.requestAttempts, 1)
  assert.equal(model.diagnostic.sdkReportedStatus, 400)
  assert.equal(model.diagnostic.dispatchObserved, null)
  assert.equal(Object.hasOwn(model, 'requestId'), false)
  assert.equal(JSON.stringify(diagnostic).includes('SECRET'), false)
  const classified = classifyExecutionFailure(input)
  assert.equal(classified.category, 'runtime_error')
  assert.equal(classified.retryable, false)
  assert.deepEqual(classified.diagnostic, diagnostic)
  assert.equal(JSON.stringify(classified).includes('SECRET'), false)

  const unknown = buildFailureDiagnostics({
    processResult: { loggingError: { message: 'SECRET_LOGGING_ERROR' }, evidenceGateCode: 'SECRET_GATE' },
    events: [modelFailure({ diagnostic: modelDiagnostic({ errorCode: 'SECRET_CODE', errorType: 'SECRET_TYPE', exceptionClass: 'SECRET_CLASS' }) })],
  })
  assert.deepEqual(unknown.causes.slice(1), [
    { stage: 'evidence_gate', code: 'process_logging_failed' },
    { stage: 'evidence_gate', code: 'runtime_evidence_rejected' },
  ])
  assert.equal(JSON.stringify(unknown).includes('SECRET'), false)
  const legacy = buildFailureDiagnostics({ events: [modelFailure({ diagnostic: undefined })] }).causes[0].diagnostic
  assert.equal(legacy.sdkReportedStatus, 400)
  assert.equal(legacy.dispatchObserved, null)
  assert.equal(legacy.errorCode, null)
})

test('adapter and native-result boundaries remain explicit technical diagnostics', () => {
  const adapter = buildFailureDiagnostics({ processResult: { spawnError: { code: 'ADAPTER_FAILURE' }, adapterFailure: { code: 'adapter_exception', errorType: 'Error' } } })
  assert.deepEqual(adapter.causes, [
    { stage: 'adapter', code: 'adapter_failure' },
    { stage: 'process_supervision', code: 'process_spawn_failed' },
  ])
  const native = buildFailureDiagnostics({ processResult: { loggingError: 'native_result_missing' } })
  assert.deepEqual(native.causes, [{ stage: 'evidence_gate', code: 'native_result_missing' }])
})

test('additional diagnostics do not change execution failure classification priority', () => {
  const events = [modelFailure()]
  const report = { evaluationComplete: true, businessPassed: false, hasException: true, evidenceGateCode: 'missing_tool_gate_evidence' }
  for (const [processResult, category, retryable] of [
    [{ timedOut: true, interrupted: true, loggingError: 'runtime_hook_evidence_invalid' }, 'process_timeout', true],
    [{ error: { code: 'ETIMEDOUT' } }, 'process_timeout', true],
    [{ signal: 'SIGINT', loggingError: 'runtime_hook_evidence_invalid' }, 'interrupted', true],
    [{ cancelled: true }, 'interrupted', true],
    [{ loggingError: 'runtime_hook_evidence_invalid' }, 'runtime_error', false],
    [{ spawnError: { code: 'ENOENT', message: 'SECRET_SPAWN' } }, 'runtime_error', false],
    [{ heartbeatError: { code: 'EACCES', message: 'SECRET_HEARTBEAT' } }, 'runtime_error', false],
    [{ terminationErrors: [{ code: 'EPERM', message: 'SECRET_TERMINATION' }] }, 'runtime_error', false],
    [{ exitCode: 1 }, 'configuration_error', false],
    [{ error: { code: 'SECRET_GENERIC_ERROR' } }, 'configuration_error', false],
    [{}, 'configuration_error', false],
  ]) {
    const result = classifyExecutionFailure({ processResult, report, events })
    assert.equal(result.category, category)
    assert.equal(result.retryable, retryable)
    assert.equal(result.diagnostic.causes[0].stage, 'model_request')
    assert.equal(result.diagnostic.causes.some(cause => cause.stage === 'evidence_gate'), true)
    assert.equal(JSON.stringify(result).includes('SECRET'), false)
  }
  const correction = classifyExecutionFailure({ events: [modelFailure({ modelRole: 'correction' })] })
  assert.equal(correction.modelRole, null)
  assert.equal(correction.diagnostic.causes[0].modelRole, 'correction')
})

test('child model diagnostics preserve the fixed role without exposing private request data', () => {
  const failure = modelFailure({ modelRole: 'child_actor', category: 'transport_error', retryable: true, httpStatus: 503 })
  const diagnostic = buildFailureDiagnostics({ events: [failure] })
  assert.equal(diagnostic.causes[0].modelRole, 'child_actor')
  assert.equal(JSON.stringify(diagnostic).includes('SECRET'), false)
  const classified = classifyExecutionFailure({ events: [failure] })
  assert.equal(classified.modelRole, 'child_actor')
  assert.equal(classified.retryable, true)
  assert.equal(buildFailureDiagnostics({ events: [{ ...failure, modelRole: 'SECRET_CHILD_ROLE' }] }).causes[0].modelRole, null)
  const recovered = [failure, { type: 'model_request_succeeded', requestId: failure.requestId, modelRole: 'child_actor' }]
  assert.deepEqual(buildFailureDiagnostics({ events: recovered }).causes, [])
  assert.equal(classifyExecutionFailure({ events: recovered, report: { evaluationComplete: true, businessPassed: false } }).category, 'business_failure')
})

test('recovered model failures do not displace later business failure or the remaining evidence gate', () => {
  const failed = modelFailure({ category: 'rate_limit', retryable: true, httpStatus: 429, requestAttempt: 6, retryExhausted: true })
  const events = [failed, { type: 'model_request_succeeded', requestId: failed.requestId }]
  const report = { evaluationComplete: true, businessPassed: false }
  const business = classifyExecutionFailure({ events, report })
  assert.equal(business.category, 'business_failure')
  assert.equal(Object.hasOwn(business, 'diagnostic'), false)
  assert.deepEqual(buildFailureDiagnostics({ events }).causes, [])
  assert.equal(classifyExecutionFailure({ events, report: { ...report, hasException: true } }).category, 'runtime_error')
  const gate = classifyExecutionFailure({ events, report, processResult: { loggingError: 'runtime_hook_evidence_invalid', evidenceGateCode: 'missing_tool_gate_evidence' } })
  assert.equal(gate.category, 'runtime_error')
  assert.deepEqual(gate.diagnostic.causes, [
    { stage: 'evidence_gate', code: 'runtime_hook_evidence_invalid' },
    { stage: 'evidence_gate', code: 'missing_tool_gate_evidence' },
  ])
  const later = modelFailure({ requestId: 'later-safe-request', modelRole: 'actor', requestAttempt: 2 })
  const unrecovered = buildFailureDiagnostics({ events: [...events, later] })
  assert.equal(unrecovered.causes[0].eventIndex, 2)
  assert.equal(unrecovered.causes[0].requestAttempts, 2)
  assert.equal(unrecovered.causes[0].modelRole, 'actor')
})

test('evidence gate message mapping accepts only the exact fixed-code format', () => {
  assert.equal(safeEvidenceGateCode(new Error('Phase 3 runtime evidence: missing_tool_gate_evidence')), 'missing_tool_gate_evidence')
  for (const error of [
    new Error('Phase 3 runtime evidence: SECRET_GATE'),
    new Error('Phase 3 runtime evidence: missing_tool_gate_evidence SECRET_MESSAGE'),
    new Error('Phase 3 runtime evidence: missing_tool_gate_evidence '),
    new Error('Phase 3 runtime evidence: missing_tool_gate_evidence\n'),
    new Error('Phase 3 runtime evidence: missing_tool_gate_evidence\nSECRET_MESSAGE'),
    new Error(' Phase 3 runtime evidence: missing_tool_gate_evidence'),
    new Error('Phase 3 runtime evidence: MISSING_TOOL_GATE_EVIDENCE'),
    { code: 'missing_tool_gate_evidence', message: 'SECRET_ERROR' },
    { message: true }, null, undefined,
  ]) {
    assert.equal(safeEvidenceGateCode(error), 'runtime_evidence_rejected')
  }
})
