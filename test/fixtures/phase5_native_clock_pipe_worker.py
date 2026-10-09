"""Offline actual AppAgent/native clock fixture, never an official Scenario.

The sole clock advancement case uses the actual ARE TimeManager.add_offset(5)
after a genuine Contacts CompletedEvent. No Actor clock, model clock cache,
provider, global SDK/ARE alias patch or original Contacts function replacement
is used. stdout is exclusively the inherited private wire.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import warnings

ROOT = Path(__file__).absolute().parents[2]
sys.path.insert(0, str(ROOT / 'test' / 'fixtures'))
from phase5_app_agent_pipe_worker import _regular, _source_hash, _deny_connect, FixtureError

socket.socket.connect = _deny_connect
socket.socket.connect_ex = _deny_connect
logging.disable(logging.CRITICAL)
warnings.filterwarnings('ignore')


def fail():
    raise FixtureError('NATIVE_CLOCK_FIXTURE_FAILED') from None


def main():
    sys.path.insert(0, str(ROOT / 'scripts'))
    sys.path.insert(0, str(ROOT / '.official-python'))
    import gaia2_a2a_wire as wire
    setup = wire.read_frame(sys.stdin.buffer)
    keys = {'channelId', 'bindingHash', 'environmentGeneration', 'parentExecutionId',
        'parentSessionId', 'evidenceRoot', 'appId', 'workerSourceSha256',
        'nativeSourceSha256', 'wireSourceSha256', 'scopedAgentSourceSha256',
        'brokerSourceSha256', 'fixtureHelperSourceSha256'}
    if type(setup) is not dict or set(setup) != keys or setup['appId'] != 'Contacts':
        fail()
    source_pairs = [(Path(__file__).absolute(), 'workerSourceSha256'),
        (ROOT / 'scripts/gaia2_private_native_binding.py', 'nativeSourceSha256'),
        (ROOT / 'scripts/gaia2_a2a_wire.py', 'wireSourceSha256'),
        (ROOT / 'scripts/gaia2_scoped_app_agent.py', 'scopedAgentSourceSha256'),
        (ROOT / 'scripts/gaia2_scoped_model_broker.py', 'brokerSourceSha256'),
        (ROOT / 'test/fixtures/phase5_app_agent_pipe_worker.py', 'fixtureHelperSourceSha256')]
    if any(type(setup[key]) is not str or _source_hash(source) != setup[key] for source, key in source_pairs):
        fail()
    if os.environ.get('HF_HUB_OFFLINE') != '1' or os.environ.get('TRANSFORMERS_OFFLINE') != '1':
        fail()
    evidence_root = Path(setup['evidenceRoot'])
    if not evidence_root.is_absolute() or os.path.lexists(evidence_root):
        fail()
    _regular(evidence_root.parent, directory=True)

    from gaia2_private_native_binding import NativeAppBinding
    from gaia2_scoped_app_agent import build_scoped_app_agent
    from gaia2_scoped_model_broker import ScopedRetryModelEngine, scoped_model_config_hash
    from gaia2_model_retry import ModelRetryPolicy
    from are.simulation.agents.agent_log import FinalAnswerLog, ObservationLog, ToolCallLog
    from are.simulation.apps.contacts import Contact, Contacts
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.notification_system import Message, MessageType
    from are.simulation.types import CompletedEvent, EventType
    from datetime import datetime, timezone
    if any(_source_hash(source) != setup[key] for source, key in source_pairs):
        fail()
    env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
    app = Contacts(contacts={'contact-1': Contact('Old', 'Fixture', contact_id='contact-1')})
    env.register_apps([app])
    future = (Message(MessageType.USER_MESSAGE, 'Future parent USER', datetime.fromtimestamp(1100, tz=timezone.utc)),
        Message(MessageType.ENVIRONMENT_STOP, 'Future parent STOP', datetime.fromtimestamp(1101, tz=timezone.utc)))
    for message in future:
        env.notification_system.message_queue.put(message)
    bindings = tuple((id(m), m.message_type, m.message, m.timestamp) for m in future)
    selected_case = None
    clock_advances = []

    def controlled_advance_after_real_event(event):
        if (selected_case == 'advance-clock' and not clock_advances and type(event) is CompletedEvent
                and event.event_type is EventType.AGENT and event.action.app is app
                and event.metadata.completed is True and event.metadata.exception is None):
            before = env.time_manager.time()
            env.time_manager.add_offset(5)
            after = env.time_manager.time()
            clock_advances.append({'reasonCode': 'CONTROLLED_AFTER_NATIVE_EVENT_OFFSET', 'advanceSeconds': 5,
                'before': before, 'after': after,
                'eventIdHash': hashlib.sha256(event.event_id.encode('utf8')).hexdigest()})

    # Constructor authority, before owner snapshots the actual registered
    # callback chain. This is not an Actor tool or a production event scheduler.
    app.register_to_env('phase5-clock-fixture-advance', controlled_advance_after_real_event)
    trusted = [str(source) for source, _key in source_pairs]
    trusted.extend([str(ROOT / 'scripts/gaia2_model_retry.py'), str(ROOT / 'scripts/gaia2_model_diagnostics.py')])
    owner = NativeAppBinding(app, environment_generation=setup['environmentGeneration'],
        parent_execution_id=setup['parentExecutionId'], parent_session_id=setup['parentSessionId'],
        evidence_root=str(evidence_root), clock=env.time_manager.time, trusted_source_files=trusted,
        clock_environment=env)
    policy = ModelRetryPolicy(max_attempts=2, backoff_base_seconds=0,
        backoff_max_seconds=0, max_retry_wait_seconds=0, request_timeout_seconds=5)

    def kwargs_factory():
        return {'model': 'controlled-scoped-model', 'custom_llm_provider': 'openai'}

    config_hash = scoped_model_config_hash(kwargs_factory(), policy)
    stopping = False
    used = False
    runners = []
    runs = []

    def preserved():
        queue = env.notification_system.message_queue.list_view()
        return len(queue) == 2 and all(any((id(m), m.message_type, m.message, m.timestamp) == binding for m in queue) for binding in bindings)

    def response(name, arguments):
        return 'Thought: controlled\nAction:\n' + json.dumps({'action': name,
            'action_input': arguments}, ensure_ascii=False) + '<end_action>'

    class TransientError(Exception):
        status_code = 429
        headers = {'Retry-After': '0'}

    class FakeSDK:
        def __init__(self, case):
            self.case = case
            self.calls = 0
            self.actual_sdk_input_hashes = []

        def __call__(self, **kwargs):
            self.calls += 1
            self.actual_sdk_input_hashes.append(wire.value_hash(kwargs['messages']))
            if self.case in ('retry', 'sdk-budget') and self.calls == 1:
                raise TransientError('controlled transient error')
            if self.case == 'late-response':
                peer.call('revoke_during_sdk', None)
            logical = self.calls - (1 if self.case in ('retry', 'sdk-budget') else 0)
            text = response('Contacts__get_contact', {'contact_id': 'contact-1'}) if logical == 1 else response('final_answer', {'answer': 'Controlled model-gated child answer'})
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
                usage={'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5})

    def final_logger(log):
        if isinstance(log, FinalAnswerLog):
            raise FixtureError('CONTROLLED_FINAL_LOG_FAILURE')

    def dispatch(action):
        return peer.call('dispatch_agent_action', action)

    def gate(payload):
        return peer.call('model_gate', payload)

    def sdk_attempt(payload):
        return peer.call('model_sdk_attempt', payload)

    def model_finish(payload):
        return peer.call('model_complete', payload)

    def run_app_agent(payload):
        nonlocal used, selected_case
        if used or type(payload) is not dict or set(payload) != {'scope', 'modelBinding', 'case'}:
            fail()
        used = True
        case = payload['case']
        if case not in ('normal', 'retry', 'advance-clock', 'sdk-budget', 'logical-budget', 'late-response', 'final-log-failure', 'foreign-binding'):
            fail()
        selected_case = case
        model_binding = payload['modelBinding']
        sdk = FakeSDK(case)
        events = []

        def emit(event, **fields):
            value = {'type': event, **fields}
            wire.value_hash(value)
            events.append(value)

        engine = ScopedRetryModelEngine(role='child_actor', model_scope_hash=wire.value_hash(model_binding),
            sdk_completion=sdk, sdk_kwargs_factory=kwargs_factory, policy=policy,
            max_logical_requests=model_binding['maxLogicalRequests'], max_sdk_attempts=model_binding['maxSdkAttempts'],
            config_hash=config_hash, emit=emit, sleep=lambda _seconds: None)
        runner = None
        status = 'failed'
        answer = None
        try:
            runner = build_scoped_app_agent(app=app, owner=owner, env=env, scope=payload['scope'],
                llm_engine=engine, dispatch=dispatch, model_binding=model_binding,
                model_gate=gate, model_attempt=sdk_attempt, model_finish=model_finish,
                log_callback=final_logger if case == 'final-log-failure' else None)
            runners.append(runner)
            answer = runner.run()
            status = 'completed'
        except BaseException:
            peer.call('abort_agent', None)
        try:
            logs = runner.base_agent.get_agent_logs() if runner else []
            safe_logs = []
            for log in logs:
                safe = {'type': type(log).__name__, 'timestamp': log.timestamp}
                if isinstance(log, ToolCallLog):
                    safe.update(toolName=log.tool_name, argumentsHash=wire.value_hash(log.tool_arguments))
                if isinstance(log, ObservationLog):
                    safe.update(contentSha256=hashlib.sha256(log.content.encode('utf8')).hexdigest(),
                        isOriginalContactString='Contact ID: contact-1' in log.content,
                        containsWireTypeTag='nativeType' in log.content)
                safe_logs.append(safe)
            result = {'schemaVersion': 'gaia2-controlled-native-clock-run-v1', 'case': case, 'status': status, 'answer': answer,
                'runner': runner.snapshot() if runner else None, 'engine': engine.snapshot(), 'safeOfficialLogs': safe_logs,
                'events': events, 'actualFakeSdkCalls': sdk.calls, 'actualSdkInputHashes': sdk.actual_sdk_input_hashes,
                'realModelCalls': 0, 'futureParentMessagesPreserved': preserved(), 'eventCount': len(env.event_log),
                'clockAdvanceCount': len(clock_advances), 'controlledClockAdvanceSeconds': sum(item['advanceSeconds'] for item in clock_advances),
                'controlledClockAdvances': clock_advances, 'officialScenarioExecuted': False}
            wire.value_hash(result)
            target = evidence_root.parent / 'model-agent-run.json'
            with target.open('xb') as stream:
                stream.write((json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf8'))
                stream.flush()
                os.fsync(stream.fileno())
            runs.append(result)
            return result
        except BaseException:
            peer.call('abort_agent', None)
            raise FixtureError('NATIVE_CLOCK_DIAGNOSTIC_FAILED') from None

    def manifest(payload):
        if payload is not None:
            fail()
        return {'configHash': config_hash}

    def state(payload):
        if payload is not None:
            fail()
        return {'eventCount': len(env.event_log), 'futureParentMessagesPreserved': preserved(), 'runs': len(runs)}

    def shutdown(payload):
        nonlocal stopping
        if payload is not None:
            fail()
        stopping = True
        return True

    handlers = dict(owner.handlers())
    handlers.update(run_app_agent=run_app_agent, model_manifest=manifest, state_summary=state, shutdown=shutdown)
    peer = wire.PrivatePipePeer(sys.stdin.buffer, sys.stdout.buffer, setup['channelId'], setup['bindingHash'], handlers,
        on_closed=lambda _code: owner.close())
    try:
        while not stopping:
            try:
                peer.serve_once()
            except wire.A2AWireError as error:
                if error.code != 'A2A_WIRE_EOF':
                    raise
                break
    finally:
        for runner in runners:
            runner.close()
        peer.close()
        owner.close()


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        sys.stderr.write('NATIVE_CLOCK_FIXTURE_FAILED\n')
        sys.stderr.flush()
        sys.exit(1)
