"""Real ARE/production Host projection after compaction; no real model or benchmark."""
import argparse
import copy
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / '.official-python')]
from temporal_e2e_fixture import save


def call(name, arguments, identity):
    return SimpleNamespace(type='function', id=identity,
        function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))


def answer(calls):
    return SimpleNamespace(choices=[SimpleNamespace(finish_reason='tool_calls',
        message=SimpleNamespace(content=None, tool_calls=calls))])


def fact_pack(messages):
    for message in messages:
        content = message.get('content')
        if message.get('role') == 'system' and isinstance(content, str) and 'gaia2-execution-facts-v1' in content:
            for i, char in enumerate(content):
                if char == '{':
                    try:
                        value, _ = json.JSONDecoder().raw_decode(content[i:])
                    except ValueError:
                        continue
                    if value.get('schemaVersion') == 'gaia2-execution-facts-v1':
                        return value
    raise AssertionError('Every Actor input must contain persistent execution facts')


def run(path, case):
    captures, inputs, packs, compactions, external = [], [], [], [], []
    connect = socket.socket.connect
    def only_loopback(sock, address):
        if not isinstance(address, tuple) or address[0] not in ('127.0.0.1', '::1'):
            external.append(type(address).__name__)
            raise AssertionError('External network forbidden')
        return connect(sock, address)
    socket.socket.connect = only_loopback
    import capybara_official_bridge as bridge
    from gaia2_runtime_hooks import RuntimeHookClient
    from are.simulation.apps.app import App
    from are.simulation.apps.calendar import Calendar, CalendarEvent
    from are.simulation.apps.contacts import Contact, Contacts
    from are.simulation.apps.email_client import EmailClientV2
    from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender
    from are.simulation.apps.system import SystemApp
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.scenarios.scenario import Scenario
    from are.simulation.scenarios.validation_result import ScenarioValidationResult
    from are.simulation.tool_utils import OperationType, app_tool
    from are.simulation.types import event_registered

    class Ledger(App):
        def __init__(self):
            super().__init__(); self.values = []
        @app_tool()
        @event_registered(operation_type=OperationType.WRITE)
        def record(self, value: str) -> dict:
            """Record a synthetic value with a deliberately misleading business status.
            :param value: synthetic value
            :returns: actual native result, not execution metadata
            """
            self.values.append(value)
            return {'status': 'failed', 'value': value, 'padding': 'fixture-only ' * 400}
        @app_tool()
        @event_registered(operation_type=OperationType.WRITE)
        def uncertain(self, value: str) -> str:
            """Apply one effect and lose the response.
            :param value: synthetic value
            :returns: never returns normally
            """
            self.values.append(value)
            raise RuntimeError('Controlled partial operation')

    class ControlledScenario(Scenario):
        def validate(self, _environment):
            return ScenarioValidationResult(success=True)

    calendar, contacts, mail, ledger, aui, system = Calendar(), Contacts(), EmailClientV2(name='Mail'), Ledger(), AgentUserInterface(), SystemApp()
    for i in range(8):
        calendar.events[f'historical-{i}'] = CalendarEvent(event_id=f'historical-{i}', title=f'Old fixture {i}', start_datetime=1729245600, end_datetime=1729249200)
        contacts.contacts[f'historical-{i}'] = Contact(contact_id=f'historical-{i}', first_name='Historical', last_name=str(i))
    apps = [calendar, contacts, mail, ledger, aui, system]
    env = Environment(config=EnvironmentConfig(start_time=1728975600, duration=3600, verbose=False)); env.register_apps(apps)
    scenario = ControlledScenario(scenario_id='persistent_' + case, apps=apps, nb_turns=1, start_time=1728975600, duration=3600)
    aui.send_message_to_agent('Perform the controlled synthetic operations, retain actual execution facts, and report when done.')
    allowed = ['Calendar__delete_calendar_event', 'Calendar__add_calendar_event', 'Contacts__delete_contact',
        'Mail__send_email', 'Ledger__record', 'Ledger__uncertain', 'AgentUserInterface__send_message_to_user']
    os.environ['GAIA2_E2E_TOOL_ALLOWLIST'] = ','.join(allowed)
    original_invoke, original_model, original_compact = RuntimeHookClient.invoke, bridge._call_model, bridge._compact_model_input
    updated = False
    def invoke(client, checkpoint, **payload):
        nonlocal updated
        result = original_invoke(client, checkpoint, **payload)
        captures.append({'checkpoint': checkpoint, 'request': copy.deepcopy(payload), 'response': copy.deepcopy(result)})
        if case == 'user_update' and not updated and checkpoint == 'after_tool':
            done = result.get('semanticReceipt', {}).get('writeState', {}).get('actions', [])
            if sum(item.get('canonicalName') == 'Calendar__delete_calendar_event' and item.get('status') == 'succeeded' for item in done) == 8:
                aui.send_message_to_agent('New visible request: continue the fixture, but historical successes are not proof this new request is complete.')
                updated = True
        return result
    def compact(messages, tools, **kwargs):
        result = original_compact(messages, tools, max_messages=24, **kwargs)
        compactions.append(copy.deepcopy(result[1])); return result
    primary = 'Contacts__delete_contact' if case == 'contacts_history' else 'EmailClientV2__send_email' if case == 'email_history' else 'Calendar__delete_calendar_event'
    def primary_call(i):
        if case == 'contacts_history': return call('Contacts__delete_contact', {'contact_id': f'historical-{i}'}, f'early-{i}')
        if case == 'email_history': return call('Mail__send_email', {'recipients': ['fixture@example.invalid'], 'subject': f'Fixture {i}', 'content': 'Controlled native email'}, f'early-{i}')
        return call('Calendar__delete_calendar_event', {'event_id': f'historical-{i}'}, f'early-{i}')
    def model(messages, tools, *_args):
        bridge._validate_provider_tool_pairs(messages)
        index = len(inputs); pack = fact_pack(messages)
        inputs.append({'messages': copy.deepcopy(messages), 'tools': copy.deepcopy(tools)}); packs.append(pack)
        assert pack['historyIsCurrentState'] is False and pack['businessCompletion'] == 'not_inferred'
        if case == 'mixed_outcomes':
            if index == 0:
                return answer([primary_call(0), call('Calendar__delete_calendar_event', {'event_id': 'missing'}, 'bad'),
                    call('Ledger__record', {'value': 'must-not-run'}, 'tail-1')])
            if index == 1:
                assert pack['counts']['failed'] == 1 and pack['counts']['not_executed'] == 1, pack
                return answer([call('Ledger__uncertain', {'value': 'unknown-effect'}, 'unknown'),
                    call('Ledger__record', {'value': 'must-not-run-2'}, 'tail-2')])
            if index == 2:
                assert pack['counts']['unknown'] == 1 and pack['counts']['not_executed'] == 2, pack
                return answer([call('Ledger__record', {'value': 'different-operation'}, 'later-success')])
            assert index == 3
            assert pack['counts']['succeeded'] == 2 and pack['counts']['confirmed_applied'] == 1, pack
            return answer([call('AgentUserInterface__send_message_to_user', {'content': 'Fixture complete; actual effects only.'}, 'finish')])
        if index == 0:
            return answer([primary_call(i) for i in range(8)])
        group = next(g for g in pack['groups'] if g['tool'] == primary)
        assert group['counts']['succeeded'] == group['counts']['confirmed_applied'] == 8, pack
        if 1 <= index <= 16:
            return answer([call('Ledger__record', {'value': f'later-{index}'}, f'pad-{index}')])
        if index == 17:
            return answer([call('Calendar__add_calendar_event', {'title': 'Later fixture', 'start_datetime': '2024-10-20 10:00:00', 'end_datetime': '2024-10-20 11:00:00'}, 'later-create')])
        assert index == 18
        visible_ids = {m.get('tool_call_id') for m in messages if m.get('role') == 'tool'}
        assert not visible_ids.intersection({f'early-{i}' for i in range(8)}), 'Old native bodies must really be compacted'
        assert pack['counts']['succeeded'] == 25 and pack['counts']['confirmed_applied'] == 9, pack
        if case == 'user_update': assert 'New visible request' in json.dumps(messages)
        return answer([call('AgentUserInterface__send_message_to_user', {'content': 'Historical native facts retained after compaction.'}, 'finish')])
    RuntimeHookClient.invoke, bridge._call_model, bridge._compact_model_input = invoke, model, compact
    failure = None
    try:
        bridge.install(); env.start()
        bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, 'default', 'controlled-no-model')
    except Exception as error:
        failure = {'type': type(error).__name__, 'code': getattr(error, 'code', None), 'message': str(error)[:1200]}
    finally:
        env.stop()
        if env.thread is not None: env.join()
        RuntimeHookClient.invoke, bridge._call_model, bridge._compact_model_input = original_invoke, original_model, original_compact
        socket.socket.connect = connect
    original_results = True
    for capture in captures:
        if capture['checkpoint'] != 'after_tool': continue
        outcome, action = capture['request'].get('outcome', {}), capture['request'].get('action', {})
        if not action.get('id') or action['id'].startswith('temporal-local'): continue
        matching = [m for m in capture['request'].get('messages', []) if m.get('toolCallId') == action['id']]
        if matching and outcome.get('resultHash'):
            try: original_results = original_results and bridge._stable_hash(json.loads(matching[-1]['content'])) == outcome['resultHash']
            except (ValueError, TypeError): original_results = False
    checks = {'noTechnicalFailure': failure is None, 'noExternalNetwork': not external,
        'environmentJoined': env.thread is not None and not env.thread.is_alive(), 'originalNativeResultHashes': original_results,
        'factsEveryActorRequest': len(packs) == len(inputs) and bool(packs), 'factCountsVerifiedByScriptedActor': failure is None,
        'noFalseTaskCompletion': all(p['businessCompletion'] == 'not_inferred' for p in packs)}
    if case == 'mixed_outcomes': checks['unknownNeverReplayed'] = ledger.values == ['unknown-effect', 'different-operation']
    else: checks['realCompactionOccurred'] = any(c['compacted'] for c in compactions)
    save(path.parent / 'actor-inputs.json', inputs); save(path.parent / 'hook-receipts.json', captures)
    save(path.parent / 'fact-packs.json', packs); save(path.parent / 'are-events.json', env.event_log.to_dict())
    result = {'schemaVersion': 'gaia2-persistent-facts-fixture-v1', 'case': case, 'status': 'passed' if all(checks.values()) else 'failed',
        'checks': checks, 'failure': failure, 'actorRequests': len(inputs), 'realModelRequests': 0, 'externalAttempts': len(external)}
    save(path, result); return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--case', required=True); parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args(); result = run(args.report.resolve(), args.case)
    print(json.dumps(result)); raise SystemExit(0 if result['status'] == 'passed' else 2)
