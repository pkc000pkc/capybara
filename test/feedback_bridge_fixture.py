"""Real ARE/production Host rehearsal of precise feedback and batch summaries.

Only the Actor is scripted. Native results, Host reports, ordered scheduler,
official notification waits and STOP remain real. No benchmark/model request.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / ".official-python")]
from temporal_e2e_fixture import save


def call(name, arguments, identity):
    return SimpleNamespace(type="function", id=identity,
        function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))


def answer(calls):
    return SimpleNamespace(choices=[SimpleNamespace(finish_reason="tool_calls",
        message=SimpleNamespace(content=None, tool_calls=calls))])


def summaries(messages):
    found = []
    for message in messages:
        content = message.get("content")
        if message.get("role") != "system" or not isinstance(content, str) or "gaia2-tool-round-summary-v1" not in content:
            continue
        # Presentation prefixes are not protocol. Find the actual bounded JSON
        # summary without requiring the Bridge to use a particular sentence.
        for position, character in enumerate(content):
            if character != "{":
                continue
            try:
                value, _ = json.JSONDecoder().raw_decode(content[position:])
            except ValueError:
                continue
            if isinstance(value, dict) and value.get("schemaVersion") == "gaia2-tool-round-summary-v1":
                found.append(value)
                break
    return found


def run(report_path, case):
    captures, inputs, events, external, inspected_summaries = [], [], [], [], []
    connect = socket.socket.connect
    def loopback_only(sock, address):
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
            external.append(type(address).__name__)
            raise AssertionError("No external network permitted")
        return connect(sock, address)
    socket.socket.connect = loopback_only

    import capybara_official_bridge as bridge
    from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender
    from are.simulation.apps.app import App
    from are.simulation.apps.calendar import Calendar, CalendarEvent
    from are.simulation.apps.contacts import Contact, Contacts
    from are.simulation.apps.system import SystemApp
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.scenarios.scenario import Scenario
    from are.simulation.scenarios.validation_result import ScenarioValidationResult
    from are.simulation.tool_utils import OperationType, app_tool
    from are.simulation.types import StopEvent, event_registered
    from gaia2_runtime_hooks import RuntimeHookClient

    class Ledger(App):
        def __init__(self):
            super().__init__(); self.effects = []
        @app_tool()
        @event_registered(operation_type=OperationType.WRITE)
        def write(self, value: str) -> dict:
            """Append a fixed synthetic value.
            :param value: value to append
            :returns: actual ledger state
            """
            self.effects.append(value)
            return {"values": list(self.effects)}
        @app_tool()
        @event_registered(operation_type=OperationType.WRITE)
        def uncertain(self, value: str) -> str:
            """Apply a synthetic effect and lose the acknowledgement.
            :param value: actual effect
            :returns: no successful return
            """
            self.effects.append(value)
            raise RuntimeError("SECRET_UNTRUSTED_EXCEPTION must not enter feedback")

    class ControlledScenario(Scenario):
        def validate(self, _environment):
            return ScenarioValidationResult(success=True)

    calendar, contacts, ledger, aui, system = Calendar(), Contacts(), Ledger(), AgentUserInterface(), SystemApp()
    for identity in ("feedback-event-a", "feedback-event-b"):
        calendar.events[identity] = CalendarEvent(event_id=identity, title="Synthetic " + identity,
            start_datetime=1729245600, end_datetime=1729249200)
    for identity in ("feedback-contact-a", "feedback-contact-b"):
        contacts.contacts[identity] = Contact(first_name="Synthetic", last_name=identity, contact_id=identity)
    apps = [calendar, contacts, ledger, aui, system]
    env = Environment(config=EnvironmentConfig(start_time=1728975600, duration=3600, verbose=False))
    env.register_apps(apps)
    scenario = ControlledScenario(scenario_id="feedback_" + case, apps=apps, nb_turns=1,
        start_time=1728975600, duration=3600)
    aui.send_message_to_agent("Do not notify me. Remain silent and wait for the official stop."
        if case == "silent_stop" else "Perform only the fixed synthetic operations, inspect their real outcomes, and notify me when done.")
    os.environ["GAIA2_E2E_TOOL_ALLOWLIST"] = ",".join([
        "Calendar__delete_calendar_event", "Contacts__delete_contact", "Contacts__get_contacts",
        "Ledger__write", "Ledger__uncertain", "AgentUserInterface__send_message_to_user", "SystemApp__wait_for_notification"])
    plans = {
        "calendar_batch": [("Calendar__delete_calendar_event", {"event_id": "feedback-event-a"}),
            ("Calendar__delete_calendar_event", {"event_id": "missing-event"}),
            ("Calendar__delete_calendar_event", {"event_id": "feedback-event-b"})],
        "contacts_batch": [("Contacts__delete_contact", {"contact_id": "feedback-contact-a"}),
            ("Contacts__delete_contact", {"contact_id": "missing-contact"}),
            ("Contacts__delete_contact", {"contact_id": "feedback-contact-b"})],
        "unknown_batch": [("Ledger__write", {"value": "first"}), ("Ledger__uncertain", {"value": "uncertain"}),
            ("Ledger__write", {"value": "must-not-run"})],
        "success_batch": [("Calendar__delete_calendar_event", {"event_id": "feedback-event-a"}),
            ("Contacts__delete_contact", {"contact_id": "feedback-contact-a"})],
    }
    original_invoke, original_emit, original_model = RuntimeHookClient.invoke, bridge._emit_runtime_event, bridge._call_model
    def invoke(client, checkpoint, **payload):
        result = original_invoke(client, checkpoint, **payload)
        captures.append({"checkpoint": checkpoint, "request": copy.deepcopy(payload), "response": copy.deepcopy(result)})
        return result
    def emit(kind, **payload):
        events.append({"type": kind, **copy.deepcopy(payload)}); original_emit(kind, **payload)
    RuntimeHookClient.invoke, bridge._emit_runtime_event = invoke, emit

    def model(messages, tools, *_args):
        bridge._validate_provider_tool_pairs(messages)
        index = len(inputs)
        inputs.append({"messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools)})
        system_text = "\n".join(str(message.get("content", "")) for message in messages if message.get("role") == "system")
        assert "When this turn is complete, call" not in system_text
        assert not any("task_obligation" in tool["function"]["name"] for tool in tools)
        if case == "silent_stop":
            assert index == 0, "STOP must not require another Actor request or user notification"
            stop = StopEvent(); stop.event_time = env.time_manager.time() + 30; env.event_queue.put(stop)
            return answer([call("SystemApp__wait_for_notification", {"timeout": 60}, "silent-wait")])
        if index == 0:
            if case == "notify_allowed":
                return answer([call("Contacts__get_contacts", {"offset": 0}, "lookup")])
            return answer([call(name, arguments, f"batch-{ordinal}") for ordinal, (name, arguments) in enumerate(plans[case])])
        assert index == 1, "Controlled flow must finish after the actual outcomes are inspected"
        if case != "notify_allowed":
            found = summaries(messages)
            assert len(found) == 1, found
            summary = found[0]; inspected_summaries.append(summary)
            expected = {"succeeded": 1, "failed": 0, "unknown": 0, "not_executed": 1, "unsettled": 0}
            if case == "success_batch":
                expected.update(succeeded=2, not_executed=0)
            else:
                expected["unknown" if case == "unknown_batch" else "failed"] = 1
            assert summary["counts"] == expected, summary
            assert summary["businessCompletion"] == "not_inferred"
            nodes = summary["nodes"]
            assert [node["callId"] for node in nodes] == [f"batch-{ordinal}" for ordinal in range(len(plans[case]))]
            assert nodes[0]["status"] == "succeeded"
            results = {message["tool_call_id"]: json.loads(message["content"]) for message in messages
                if message.get("role") == "tool" and message.get("tool_call_id", "").startswith("batch-")}
            assert len(results) == len(plans[case])
            if case != "success_batch":
                assert results["batch-2"]["executed"] is False
                assert nodes[2]["status"] == "not_executed"
            if case in ("calendar_batch", "contacts_batch"):
                field = "event_id" if case == "calendar_batch" else "contact_id"
                code = "calendar_event_not_found" if case == "calendar_batch" else "contact_not_found"
                assert results["batch-1"]["argument_name"] == field, results["batch-1"]
                assert results["batch-1"]["error_code"] == code
                assert results["batch-1"]["effectApplied"] is False
                assert "sandbox" not in json.dumps(results["batch-1"]).lower()
                assert nodes[1]["status"] == "failed" and nodes[1]["effectApplied"] is False
                assert nodes[1]["argumentRefs"][field] == ("missing-event" if case == "calendar_batch" else "missing-contact")
                assert nodes[1]["invoked"] is True and nodes[2]["invoked"] is False
            if case == "unknown_batch":
                assert results["batch-1"]["status"] == "unknown"
                assert nodes[1]["status"] == "unknown" and nodes[1]["effectApplied"] is None
                assert "SECRET_UNTRUSTED_EXCEPTION" not in json.dumps(results)
            # The summary is a new advisory view, not a rewrite of original
            # native messages. Verify exact original result hashes against
            # authenticated actual after_tool outcomes.
            for capture in captures:
                identity = capture["request"].get("action", {}).get("id")
                if capture["checkpoint"] == "after_tool" and identity in results:
                    observed_hash = hashlib.sha256(json.dumps(results[identity], default=str, sort_keys=True).encode()).hexdigest()
                    assert observed_hash == capture["request"]["outcome"]["resultHash"]
        return answer([call("AgentUserInterface__send_message_to_user",
            {"content": "Observed fixed synthetic outcomes; no general business-success assertion."}, "fixture-finish")])

    bridge._call_model = model; bridge.install()
    failure = None
    try:
        env.start(); bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default", "controlled-no-model")
    except Exception as error:
        failure = {"type": type(error).__name__, "code": getattr(error, "code", None), "message": str(error)[:600]}
    finally:
        env.stop()
        if env.thread is not None: env.join()
        RuntimeHookClient.invoke, bridge._emit_runtime_event, bridge._call_model = original_invoke, original_emit, original_model
        socket.socket.connect = connect
    replies = [message for message in aui.messages if message.sender == Sender.AGENT]
    checks = {"noTechnicalFailure": failure is None, "noExternalNetwork": not external,
        "environmentJoined": env.thread is not None and not env.thread.is_alive(),
        "onlyExpectedActorRequests": len(inputs) == (1 if case == "silent_stop" else 2),
        "correctNotificationChoice": len(replies) == (0 if case == "silent_stop" else 1),
        "providerPairsUnchanged": True, "summaryReadByActor": bool(inspected_summaries) if case in plans else True}
    if case == "calendar_batch": checks["nativeEffectsNotFabricated"] = "feedback-event-a" not in calendar.events and "feedback-event-b" in calendar.events
    if case == "contacts_batch": checks["nativeEffectsNotFabricated"] = "feedback-contact-a" not in contacts.contacts and "feedback-contact-b" in contacts.contacts
    if case == "unknown_batch": checks["nativeUnknownEffectNotReplayed"] = ledger.effects == ["first", "uncertain"]
    if case == "success_batch": checks["bothNativeEffectsApplied"] = "feedback-event-a" not in calendar.events and "feedback-contact-a" not in contacts.contacts
    if case == "silent_stop": checks["officialStopEndedWait"] = any(event["type"] == "attempt_execution_ended" and event.get("terminationReason") == "environment_stop" for event in events)
    save(report_path.parent / "actor-inputs.json", inputs)
    save(report_path.parent / "hook-receipts.json", captures)
    save(report_path.parent / "are-events.json", env.event_log.to_dict())
    report = {"schemaVersion": "gaia2-feedback-bridge-fixture-v1", "case": case,
        "status": "passed" if all(checks.values()) else "failed", "checks": checks,
        "actorRequests": len(inputs), "summaries": inspected_summaries, "realModelRequests": 0,
        "externalAttempts": len(external), "failure": failure, "hookReceipts": len(captures)}
    save(report_path, report); return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--case", required=True); parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(); result = run(args.report.resolve(), args.case)
    print(json.dumps({"case": args.case, "status": result["status"], "actorRequests": result["actorRequests"], "realModelRequests": 0}))
    raise SystemExit(0 if result["status"] == "passed" else 2)
