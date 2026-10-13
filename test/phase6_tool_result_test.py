"""Offline strict native-result tests plus the real RuntimeHost Cab fixture."""
import copy
import json
import math
import socket
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

network_attempts = []
original_connect = socket.socket.connect


def loopback_only(sock, address):
    if not isinstance(address, tuple) or address[0] not in ('127.0.0.1', '::1'):
        network_attempts.append(True)
        raise AssertionError('External network forbidden')
    return original_connect(sock, address)


socket.socket.connect = loopback_only
sys.path.insert(0, str(Path('scripts').resolve()))
import capybara_official_bridge as bridge
from gaia2_runtime_hooks import HookProtocolError
from are.simulation.apps.agent_user_interface import AgentUserInterface
from are.simulation.apps.cab import CabApp, Ride
from are.simulation.apps.system import SystemApp
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.scenarios.scenario import Scenario, ScenarioValidationResult
from are.simulation.types import EnvironmentState


class ToolResultTests(unittest.TestCase):
    def tearDown(self):
        self.assertEqual(network_attempts, [])

    def test_numeric_history_keys_hash_the_exact_projected_view(self):
        for count in (0, 1, 10, 11, 20):
            for offset in (0, 8, 20):
                with self.subTest(count=count, offset=offset):
                    native = {'rides': {offset + index: {'fare': 1.25} for index in range(count)},
                              'range': (offset, offset + count), 'total': 87}
                    expected = json.loads(json.dumps(native))
                    actual, fingerprint = bridge._actor_visible_tool_result(native)
                    self.assertEqual(actual, expected)
                    self.assertEqual(fingerprint, bridge._stable_hash(expected))
                    self.assertEqual(bridge._actor_visible_tool_result(actual), (actual, fingerprint))
        failing_old_shape = {index: 'ride' for index in range(20)}
        projected, fingerprint = bridge._actor_visible_tool_result(failing_old_shape)
        self.assertNotEqual(bridge._stable_hash(failing_old_shape), fingerprint)
        self.assertEqual(fingerprint, bridge._stable_hash(projected))

    def test_noncolliding_mixed_native_keys_are_preserved(self):
        actual, fingerprint = bridge._actor_visible_tool_result({2: 'integer', '01': 'string'})
        self.assertEqual(actual, {'2': 'integer', '01': 'string'})
        self.assertEqual(fingerprint, bridge._stable_hash(actual))

    def test_key_coercion_collisions_fail_closed_at_any_depth(self):
        collisions = ({1: 'a', '1': 'b'}, {None: 'a', 'null': 'b'},
                      {True: 'a', 'true': 'b'}, {1.5: 'a', '1.5': 'b'})
        for native in collisions:
            for value in (native, {'nested': [native]}):
                with self.subTest(value=value):
                    with self.assertRaises(HookProtocolError) as error:
                        bridge._actor_visible_tool_result(value)
                    self.assertEqual(error.exception.code, 'invalid_tool_result_payload')

    def test_nonfinite_and_non_utf8_observations_are_rejected(self):
        for value in (math.nan, math.inf, -math.inf, {'nested': [math.nan]},
                      {math.inf: 'key'}, '\ud800', {'\ud800': 'key'}, {'value': '\udfff'}):
            with self.subTest(value=repr(value)):
                with self.assertRaises(HookProtocolError) as error:
                    bridge._actor_visible_tool_result(value)
                self.assertEqual(error.exception.code, 'invalid_tool_result_payload')

    def test_default_str_runs_once_without_exposing_object_internals(self):
        class PublicView:
            def __init__(self):
                self.secret = 'not an Actor property'
                self.calls = 0
            def __str__(self):
                self.calls += 1
                return 'public view'
        value = PublicView()
        projected, fingerprint = bridge._actor_visible_tool_result({'object': value})
        self.assertEqual(value.calls, 1)
        self.assertEqual(projected, {'object': 'public view'})
        self.assertEqual(fingerprint, bridge._stable_hash(projected))

    def test_resources_close_even_when_projection_fails(self):
        class Handle:
            calls = 0
            def __str__(self): return 'closed public handle'
            def close(self): self.calls += 1
        for invalid in ({1: 'a', '1': 'b'}, math.nan, '\ud800'):
            handle = Handle()
            with self.assertRaises(HookProtocolError):
                bridge._actor_visible_tool_result({'handle': handle, 'bad': invalid})
            self.assertEqual(handle.calls, 1)
        handle = Handle()
        projected, fingerprint = bridge._actor_visible_tool_result([handle, handle])
        self.assertEqual(handle.calls, 1)
        self.assertEqual(projected, ['closed public handle'] * 2)

    def test_failed_resource_close_is_still_a_technical_failure(self):
        class Handle:
            def __str__(self): return 'public'
            def close(self): raise RuntimeError('private close failure')
        with self.assertRaises(HookProtocolError) as error:
            bridge._actor_visible_tool_result(Handle())
        self.assertEqual(error.exception.code, 'tool_result_resource_close_failed')


class CabScenario(Scenario):
    def validate(self, env):
        self.judge_calls += 1
        return ScenarioValidationResult(success=True)


def run_cab_fixture(count):
    """Actual ARE AppTool and live hooks; FakeActor is not a benchmark score."""
    env = Environment(config=EnvironmentConfig(start_time=1000, duration=60, verbose=False))
    aui, system = AgentUserInterface(), SystemApp()
    cab = CabApp(ride_history=[Ride(ride_id=f'controlled-ride-{index}', price=float(index))
                               for index in range(87)])
    env.register_apps([aui, system, cab])
    env.state = EnvironmentState.RUNNING
    scenario = CabScenario(scenario_id=f'controlled-cab-{count}', apps=[aui, system, cab],
                           nb_turns=1, start_time=1000, duration=60)
    scenario.judge_calls = 0
    aui.send_message_to_agent('Read the requested ride history and confirm completion.')
    actor_inputs, events = [], []
    original_emit = bridge._emit_runtime_event

    def emit(kind, **data):
        events.append({'type': kind, **data})
        original_emit(kind, **data)

    def model(messages, tools, *unused):
        actor_inputs.append(copy.deepcopy(messages))
        if len(actor_inputs) == 1:
            name, arguments, call_id = 'CabApp__get_ride_history', {'offset': 0, 'limit': count}, 'cab-history'
        elif len(actor_inputs) == 2:
            name, arguments, call_id = 'AgentUserInterface__send_message_to_user', {'content': 'History checked.'}, 'finish'
        else:
            raise AssertionError('FakeActor continued unexpectedly')
        call = SimpleNamespace(id=call_id, function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=[call]))])

    with patch.object(bridge, '_call_model', model), patch.object(bridge, '_emit_runtime_event', emit):
        result = bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env,
                                             'default', 'controlled-no-model')
    assert result.success and scenario.judge_calls == 1
    observation = next(message for message in actor_inputs[1] if message.get('tool_call_id') == 'cab-history')
    payload = json.loads(observation['content'])
    assert len(payload['rides']) == count and payload['range'] == [0, count] and payload['total'] == 87
    assert payload['rides']['0'] == str(cab.ride_history[0])
    completion = next(event for event in events if event['type'] == 'tool_call_completed' and event['callId'] == 'cab-history')
    assert completion['resultHash'] == bridge._stable_hash(payload)
    assert not network_attempts
    return {'case': count, 'status': 'passed', 'syntheticFixtureOnly': True,
            'benchmarkExecuted': False, 'officialSubmissionReady': False,
            'realModelCalls': 0, 'externalNetworkAttempts': len(network_attempts),
            'projectedResult': payload, 'resultHash': completion['resultHash'],
            'validationCalls': scenario.judge_calls, 'events': events}


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--cab-fixture':
        count = int(sys.argv[2])
        if count not in (10, 11, 20): raise SystemExit('unknown Cab fixture')
        print('CAB_RESULT_AUDIT:' + json.dumps(run_cab_fixture(count)))
    else:
        unittest.main(verbosity=2)
