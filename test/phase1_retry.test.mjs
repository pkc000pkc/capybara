import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { classifyExecutionFailure } from '../src/phase1_errors.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const python = process.env.GAIA2_PYTHON || 'C:/Users/pkc00/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'

test('model-only retries, cooldown hints, safe terminal failures and actual ARE alias integration (Python fakes)', () => {
  const result = spawnSync(python, ['-c', String.raw`
import sys, json, unittest, types
sys.path.insert(0, 'scripts')
from gaia2_model_retry import ModelRetryPolicy, ModelRequestFailure, wrap_completion, retry_delay_hint, classify_model_error, install_model_retries

class HttpFailure(Exception):
    def __init__(self, status, headers=None, body=None):
        super().__init__('SECRET_KEY actor prompt reference answer endpoint')
        self.status_code = status
        self.headers = headers or {}
        self.body = body or {}

class Tests(unittest.TestCase):
    def setup_wrapper(self, outcomes, **changes):
        clock = [1728975600.0]
        waits = []
        events = []
        calls = []
        def invoke(*args, **kwargs):
            calls.append(kwargs)
            value = outcomes.pop(0)
            if isinstance(value, Exception): raise value
            return value
        def sleep(seconds):
            waits.append(seconds)
            clock[0] += seconds
        def emit(kind, **payload): events.append({'type':kind, **payload})
        policy = ModelRetryPolicy(**changes)
        wrapped = wrap_completion(invoke, 'actor', emit, policy=policy, clock=lambda:clock[0], sleep=sleep)
        return wrapped, waits, events, calls

    def test_429_retry_after_backoff_sdk_retry_off(self):
        call, waits, events, calls = self.setup_wrapper([HttpFailure(429, {'Retry-After':'7'}), HttpFailure(503), 'ok'])
        self.assertEqual(call(messages=[{'content':'private prompt'}], num_retries=99, max_retries=99, timeout=99), 'ok')
        self.assertEqual(waits, [7, 4])
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(item['max_retries']==item['num_retries']==0 and item['timeout']==60 for item in calls))
        self.assertTrue(all(item['retry_policy'] is None and item['drop_params'] is False and item['fallbacks']==[] for item in calls))
        self.assertEqual(events[-1]['cumulativeWaitSeconds'], 11)
        scheduled = [event for event in events if event['type']=='model_retry_scheduled']
        self.assertEqual(scheduled[0]['delaySource'], 'retry_after')
        self.assertEqual(scheduled[0]['nextRetryAt'], '2024-10-15T07:00:07Z')
        self.assertNotIn('private prompt', json.dumps(events))
        self.assertNotIn('SECRET_KEY', json.dumps(events))

    def test_http_date_and_structured_cooldown(self):
        hint, source = retry_delay_hint(HttpFailure(429, {'Retry-After':'Tue, 15 Oct 2024 07:00:12 GMT'}), 1728975600)
        self.assertEqual((hint, source), (12, 'retry_after'))
        hint, source = retry_delay_hint(HttpFailure(429, {'Retry-After':'3'}, {'error': {'cooldown': {'remaining_seconds':25}, 'next_retry_at':'2024-10-15T07:00:20Z'}}), 1728975600)
        self.assertEqual((hint, source), (25, 'structured_cooldown'))
        self.assertEqual(retry_delay_hint(HttpFailure(429, {'Retry-After':'invalid'}), 1728975600), (None, None))

    def test_long_cooldown_observable_and_bounded(self):
        call, waits, events, calls = self.setup_wrapper([HttpFailure(429, {'Retry-After':'65'}), 'ok'])
        self.assertEqual(call(), 'ok')
        self.assertEqual(waits, [30,30,5])
        self.assertEqual(len([event for event in events if event['type']=='model_retry_waiting']), 2)
        call, waits, events, calls = self.setup_wrapper([HttpFailure(429, {'Retry-After':'4000'})])
        with self.assertRaises(ModelRequestFailure) as caught: call()
        self.assertEqual(waits, [])
        self.assertTrue(caught.exception.metadata['retryExhausted'])
        self.assertEqual(caught.exception.metadata['nextRetryAt'], '2024-10-15T08:06:40Z')
        call, waits, events, calls = self.setup_wrapper([HttpFailure(429, {'Retry-After':'1e308'}, {'error':{'code':[]}})])
        with self.assertRaises(ModelRequestFailure) as caught: call()
        self.assertEqual(caught.exception.category, 'rate_limit')
        self.assertIsNone(caught.exception.metadata['nextRetryAt'])
        self.assertEqual(waits, [])

    def test_fatal_config_errors_never_retry(self):
        for error in [HttpFailure(400), HttpFailure(401), HttpFailure(403), HttpFailure(404), HttpFailure(422), HttpFailure(429, body={'error':{'code':'insufficient_quota'}}), ValueError('SECRET_KEY bad provider')]:
            call, waits, events, calls = self.setup_wrapper([error])
            with self.assertRaises(ModelRequestFailure) as caught: call()
            self.assertFalse(caught.exception.retryable)
            self.assertEqual(caught.exception.category, 'configuration_error')
            self.assertEqual(len(calls),1)
            self.assertEqual(waits, [])
            self.assertIsNone(caught.exception.__cause__)
            self.assertTrue(caught.exception.__suppress_context__)
            self.assertNotIn('SECRET_KEY', str(caught.exception))

    def test_transport_timeout_and_retry_exhaustion(self):
        for error, category in [(HttpFailure(408),'request_timeout'), (TimeoutError('private'),'request_timeout'), (ConnectionError('private'),'transport_error'), (HttpFailure(502),'transport_error')]:
            call, waits, events, calls = self.setup_wrapper([error, error], max_attempts=2)
            with self.assertRaises(ModelRequestFailure) as caught: call()
            self.assertEqual(caught.exception.category,category)
            self.assertEqual(len(calls),2)
            self.assertEqual(caught.exception.metadata['cumulativeWaitSeconds'],2)
            self.assertTrue(caught.exception.retryable)
        self.assertFalse(classify_model_error(RuntimeError('429 retry me'))['retryable'])

    def test_non_idempotent_tool_outside_wrapper_not_replayed(self):
        call, waits, events, calls = self.setup_wrapper([HttpFailure(429), {'tool_calls':['write']}])
        response = call()
        tool_calls = []
        def write_tool():
            tool_calls.append('write')
            raise ConnectionError('unknown write result')
        with self.assertRaises(ConnectionError):
            if response['tool_calls']: write_tool()
        self.assertEqual(tool_calls, ['write'])
        self.assertEqual(len(calls),2)

    def test_policy_validation(self):
        for value in [0, -1, 1.5, True]:
            with self.assertRaises(ValueError): ModelRetryPolicy(max_attempts=value)
        with self.assertRaises(ValueError): ModelRetryPolicy(request_timeout_seconds=0)
        with self.assertRaises(ValueError): ModelRetryPolicy(backoff_base_seconds=float('nan'))

    def test_cancellation_while_waiting_has_no_raw_sdk_context(self):
        def completion(**kwargs): raise HttpFailure(429)
        def sleep(seconds): raise KeyboardInterrupt()
        call = wrap_completion(completion, 'actor', lambda *args, **kwargs:None, sleep=sleep)
        with self.assertRaises(KeyboardInterrupt) as caught: call()
        self.assertIsNone(caught.exception.__context__)

    def test_install_patches_exact_alias_and_is_idempotent(self):
        calls=[]
        fake=types.ModuleType('litellm')
        def complete(*args,**kwargs): calls.append(kwargs); return 'ok'
        fake.completion=complete
        engine=types.ModuleType('are.simulation.agents.llm.litellm.litellm_engine')
        engine.completion=complete
        sys.modules['litellm']=fake
        sys.modules[engine.__name__]=engine
        events=[]
        def emit(kind,**payload): events.append({'type':kind, **payload})
        actor=install_model_retries(emit)
        judge=engine.completion
        self.assertIs(install_model_retries(emit, actor_completion=actor), actor)
        self.assertIs(engine.completion,judge)
        self.assertEqual(actor(),'ok')
        self.assertEqual(judge(),'ok')
        self.assertEqual([event['modelRole'] for event in events if event['type']=='model_request_attempt'],['actor','judge'])
        self.assertEqual(fake.completion,complete)
        self.assertEqual(fake.num_retries,0)
        self.assertFalse(fake.drop_params)

unittest.main(verbosity=2)
`], { cwd: root, encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message)
  assert.match(result.stderr, /Ran 9 tests/)
})

test('execution classifier does not treat infra exceptions or score alone as business failure', () => {
  assert.equal(classifyExecutionFailure({ report: { score: 0, status: 'failed' } }).category, 'missing_result')
  assert.equal(classifyExecutionFailure({ report: { evaluationComplete: true, businessPassed: false } }).category, 'business_failure')
  assert.equal(classifyExecutionFailure({ report: { evaluationComplete: true, businessPassed: false, hasException: true } }).category, 'runtime_error')
  assert.equal(classifyExecutionFailure({ report: { judgeStatus: 'completed', score: 0, has_exception: true } }).category, 'runtime_error')
  assert.equal(classifyExecutionFailure({ report: { judgeStatus: 'completed', score: 0, exceptionType: 'ModelRequestFailure' } }).category, 'runtime_error')
  assert.equal(classifyExecutionFailure({ processResult: { exitCode: 1 }, report: { evaluationComplete: true, businessPassed: false } }).category, 'runtime_error')
  assert.equal(classifyExecutionFailure({ processResult: { timedOut: true } }).category, 'process_timeout')
  assert.equal(classifyExecutionFailure({ processResult: { signal: 'SIGINT' } }).category, 'interrupted')
  for (const processResult of [{ spawnError: { code: 'ENOENT' } }, { loggingError: { code: 'ENOSPC' } }, { heartbeatError: { code: 'EACCES' } }, { terminationErrors: [{ code: 'EPERM' }] }, { exitCode: null }]) {
    assert.equal(classifyExecutionFailure({ processResult, report: { evaluationComplete: true, businessPassed: false } }).category, 'runtime_error')
  }
})

test('execution classifier preserves operational cooldown and ignores recovered failures', () => {
  const failed = { type: 'model_request_failed', requestId: 'safe-request', category: 'rate_limit', retryable: true, nextRetryAt: '2026-10-08T12:01:00Z', requestAttempt: 6, cumulativeWaitSeconds: 120, retryExhausted: true, modelRole: 'judge', httpStatus: 429, message: 'SECRET' }
  const result = classifyExecutionFailure({ report: { evaluationComplete: true, businessPassed: false, hasException: true }, events: [failed] })
  assert.equal(result.category, 'rate_limit')
  assert.equal(result.nextRetryAt, '2026-10-08T12:01:00.000Z')
  assert.equal(result.requestAttempts, 6)
  assert.equal(result.modelRole, 'judge')
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
  assert.equal(classifyExecutionFailure({ processResult: { loggingError: { code: 'ENOSPC' } }, events: [failed] }).category, 'runtime_error')
  assert.equal(classifyExecutionFailure({ report: { evaluationComplete: true, businessPassed: false }, events: [failed, { type: 'model_request_succeeded', requestId: failed.requestId }] }).category, 'business_failure')
})
