"""Slim production-path rehearsal: real ARE/Host, fixed fake Actor, loopback only."""
import argparse
import copy
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / ".official-python")]
from temporal_e2e_fixture import save


def response(name, arguments, index):
    return SimpleNamespace(choices=[SimpleNamespace(finish_reason="tool_calls", message=SimpleNamespace(content=None,
        tool_calls=[SimpleNamespace(type="function", id=f"slim-{index}", function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))]))])


def assert_slim_inputs(inputs):
    for item in inputs:
        names = [tool["function"]["name"] for tool in item["tools"]]
        assert not any("task_obligation" in name or "propose_task_contract" in name or "review_task_contract" in name for name in names)
        system = "\n".join(str(message.get("content", "")) for message in item["messages"] if message.get("role") == "system")
        assert "Independent task contracts" not in system and "notification is forbidden" not in system


def run(report_path, case):
    # Reuse the existing real ARE candidate/deadline/USER wait fixture, not a
    # fake clock or fake native waiter. It also asserts no Actor callback on scans.
    if case in ("wait_candidate", "wait_deadline", "wait_user"):
        from temporal_e2e_fixture import run as temporal_run
        result = temporal_run(report_path.parent / "temporal-fixture-report.json", {"wait_candidate": "candidate", "wait_deadline": "deadline", "wait_user": "user_update"}[case], user_delay=95)
        inputs = json.loads((report_path.parent / "actor-inputs.json").read_text(encoding="utf-8"))
        assert_slim_inputs(inputs)
        result["case"] = case
        if case == "wait_user":
            result["userEventDelaySeconds"] = 95
            result["knownOverdueBoundaryNotRetestedOrRelabelled"] = True
        result["checks"]["noTaskContractControlsOrPrompt"] = True
        save(report_path, result)
        return result

    captures, inputs, events, external, compactions = [], [], [], [], []
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
    from are.simulation.types import Event, EventType, StopEvent, event_registered
    from gaia2_runtime_hooks import RuntimeHookClient

    class Ledger(App):
        def __init__(self):
            super().__init__(); self.values = []
        @app_tool()
        @event_registered(operation_type=OperationType.WRITE)
        def write(self, value: str) -> dict:
            """Append a synthetic value.
            :param value: value to append
            :returns: observed ledger
            """
            self.values.append(value)
            return {"values": list(self.values)}
        @app_tool()
        @event_registered(operation_type=OperationType.WRITE)
        def uncertain(self, value: str) -> str:
            """Apply an effect and lose its outcome.
            :param value: value to append
            :returns: never successfully returns
            """
            self.values.append(value)
            raise RuntimeError("Controlled unknown result after native effect")

    class ControlledScenario(Scenario):
        def validate(self, _environment):
            return ScenarioValidationResult(success=True)

    calendar, ledger, contacts, aui, system = Calendar(), Ledger(), Contacts(), AgentUserInterface(), SystemApp()
    calendar.events["slim-cancel-target"] = CalendarEvent(event_id="slim-cancel-target", title="Cancel this fixture", start_datetime=1729245600, end_datetime=1729249200)
    contacts.contacts["slim-watch"] = Contact(first_name="Wait", last_name="Fixture", contact_id="slim-watch", description="PENDING")
    apps = [calendar, ledger, contacts, aui, system]
    env = Environment(config=EnvironmentConfig(start_time=1728975600, duration=3600, verbose=False)); env.register_apps(apps)
    scenario = ControlledScenario(scenario_id=f"runtime_slim_{case}", apps=apps, nb_turns=1, start_time=1728975600, duration=3600)
    aui.send_message_to_agent("Cancel the fixture event, perform only the prescribed synthetic operations, and report when done. No extra semantic approval is needed." if case == "cancel" else
        "Perform the fixed synthetic native operations and report the observed outcome. Never replay an unknown or already successful non-idempotent operation.")
    os.environ["GAIA2_E2E_TOOL_ALLOWLIST"] = ",".join(["Calendar__get_calendar_events_from_to", "Calendar__delete_calendar_event", "Calendar__add_calendar_event", "Ledger__write", "Ledger__uncertain", "Contacts__get_contacts", "SystemApp__wait_for_notification", "SystemApp__get_current_time", "AgentUserInterface__send_message_to_user", "capybara_wait_watch"])
    original_invoke, original_emit, original_model, original_compact = RuntimeHookClient.invoke, bridge._emit_runtime_event, bridge._call_model, bridge._compact_model_input
    original_window_resolver = None
    original_window_pipeline_enabled = os.environ.get("GAIA2_WINDOW_PIPELINE_ENABLED")
    original_window_evidence_dir = os.environ.get("GAIA2_WINDOW_EVIDENCE_DIR")
    if case == "finish_loop":
        # Controlled registration uses the actual projected USER identity and
        # text, but bypasses the model extractor/reviewer. This keeps the
        # gate-loop test deterministic and model-free.
        import hashlib
        import gaia2_window_pipeline as window_pipeline
        original_window_resolver = window_pipeline.resolve_user_window_source
        def controlled_window_resolver(*, evidence_root, execution_id, session_id, user_ref, text, arrived_at, are_now, model_call):
            del evidence_root, model_call
            source_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
            span = {"start": 0, "end": len(text), "text": text}
            span_hash = hashlib.sha256(json.dumps(span, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
            return {"schemaVersion": "gaia2-window-pipeline-v1", "status": "registered", "sourceHash": source_hash,
                    "parserReceiptHash": "a" * 64, "windowSource": {
                        "schemaVersion": "gaia2-window-obligation-source-v1", "enabled": True,
                        "executionId": execution_id, "sessionId": session_id, "userRef": user_ref,
                        "sourceHash": source_hash, "span": span, "sceneStart": float(arrived_at),
                        "parserReceiptHash": "a" * 64, "obligations": [{
                            "id": "controlled-window-1", "mode": "monitor_until", "goal": "Wait for the controlled window to finish",
                            "deadline": float(are_now) + 120, "notificationPolicy": "forbid_until_deadline",
                            "sourceSpanHash": span_hash, "span": span,
                        }]}}
        window_pipeline.resolve_user_window_source = controlled_window_resolver
        os.environ["GAIA2_WINDOW_PIPELINE_ENABLED"] = "1"
        os.environ["GAIA2_WINDOW_EVIDENCE_DIR"] = os.environ.get("GAIA2_TEMPORAL_WORKSPACE", str(report_path.parent))
    def invoke(client, checkpoint, **payload):
        result = original_invoke(client, checkpoint, **payload)
        captures.append({"checkpoint": checkpoint, "request": copy.deepcopy(payload), "response": copy.deepcopy(result)})
        return result
    def emit(kind, **payload):
        events.append({"type": kind, **copy.deepcopy(payload)}); original_emit(kind, **payload)
    def compact(messages, tools, *args, **kwargs):
        result = original_compact(messages, tools, max_messages=6) if case == "hidden" else original_compact(messages, tools, *args, **kwargs)
        compactions.append(copy.deepcopy(result[1])); return result
    RuntimeHookClient.invoke, bridge._emit_runtime_event, bridge._compact_model_input = invoke, emit, compact
    query = {"start_datetime": "2024-10-18 00:00:00", "end_datetime": "2024-10-21 00:00:00", "limit": 100}
    create = {"title": "Allowed new operation", "start_datetime": "2024-10-20 10:00:00", "end_datetime": "2024-10-20 11:00:00"}
    plans = {
        "cancel": [("Calendar__get_calendar_events_from_to", query), ("Calendar__delete_calendar_event", {"event_id": "slim-cancel-target"})],
        "stale": [("Calendar__get_calendar_events_from_to", query), ("SystemApp__wait_for_notification", {"timeout": 65}), ("Calendar__add_calendar_event", create)],
        "hidden": [("Calendar__get_calendar_events_from_to", query), *[("SystemApp__get_current_time", {}) for _ in range(4)], ("Calendar__add_calendar_event", create)],
        "changed": [("Calendar__get_calendar_events_from_to", query), ("Calendar__get_calendar_events_from_to", query), ("Calendar__add_calendar_event", create)],
        "unknown_repeat": [("Ledger__uncertain", {"value": "unknown"}), ("Ledger__uncertain", {"value": "unknown"}), ("Ledger__write", {"value": "different"}), ("Ledger__write", {"value": "different"})],
    }
    finish = ("AgentUserInterface__send_message_to_user", {"content": "Synthetic fixed operation completed or uncertainty preserved; no benchmark claim."})
    def model(messages, tools, *_args):
        bridge._validate_provider_tool_pairs(messages)
        index = len(inputs); inputs.append({"messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools)})
        assert_slim_inputs([inputs[-1]])
        if case == "wait_stop":
            if index == 0:
                selected = ("Contacts__get_contacts", {"offset": 0})
            elif index == 1:
                stop = StopEvent(); stop.event_time = env.time_manager.time() + 65; env.event_queue.put(stop)
                selected = ("capybara_wait_watch", {"queryTool": "Contacts__get_contacts", "queryArguments": {"offset": 0}, "baselineRef": "latest", "intervalSeconds": 30, "maxScans": 12, "goal": "Stop when official STOP arrives"})
            else:
                raise AssertionError("STOP must not return to Actor or send a user message")
        elif case == "finish_loop":
            selected = finish
        else:
            plan = plans[case]
            if case == "changed" and index == 1:
                event = Event.from_function(calendar.add_calendar_event, event_type=EventType.ENV, title="External change", start_datetime="2024-10-19 12:00:00", end_datetime="2024-10-19 12:30:00")
                event.event_time = env.time_manager.time(); env.process_event(event)
            if index > len(plan):
                raise AssertionError("Unexpected extra Actor call")
            selected = plan[index] if index < len(plan) else finish
        return response(*selected, index)
    bridge._call_model = model; bridge.install()
    failure = None
    try:
        env.start(); bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default", "controlled-no-model")
    except Exception as error:
        failure = {"type": type(error).__name__, "code": getattr(error, "code", None), "message": str(error)[:400]}
    finally:
        env.stop()
        if env.thread is not None: env.join()
        RuntimeHookClient.invoke, bridge._emit_runtime_event, bridge._call_model, bridge._compact_model_input = original_invoke, original_emit, original_model, original_compact
        if original_window_resolver is not None:
            import gaia2_window_pipeline as window_pipeline
            window_pipeline.resolve_user_window_source = original_window_resolver
        if original_window_pipeline_enabled is None:
            os.environ.pop("GAIA2_WINDOW_PIPELINE_ENABLED", None)
        else:
            os.environ["GAIA2_WINDOW_PIPELINE_ENABLED"] = original_window_pipeline_enabled
        if original_window_evidence_dir is None:
            os.environ.pop("GAIA2_WINDOW_EVIDENCE_DIR", None)
        else:
            os.environ["GAIA2_WINDOW_EVIDENCE_DIR"] = original_window_evidence_dir
        socket.socket.connect = connect
    replies = [message for message in aui.messages if message.sender == Sender.AGENT]
    final_values = json.loads(Path(captures[-1]["response"]["evidencePath"]).read_text(encoding="utf-8"))["variables"] if captures else {}
    observations = final_values.get("gaia2_observation_state", {}).get("observations", [])
    writes = final_values.get("gaia2_write_state", {})
    checks = {"noTechnicalFailure": failure is None, "noExternalNetwork": not external, "noContractModelCalls": not any("task_contract" in event["type"] for event in events),
        "environmentJoined": env.thread is not None and not env.thread.is_alive(), "noTaskContractControlsOrPrompt": True,
        "noFinishBoundary": not failure or "finish_boundary" not in failure.get("message", ""), "expectedReplies": len(replies) == (0 if case == "wait_stop" else 1)}
    if case == "finish_loop":
        checks.update(noTechnicalFailure=failure is not None,
            finishGateLoopStopped=any(event["type"] == "finish_gate_loop_stopped" for event in events),
            finishGateBlockedThreeTimes=sum(1 for event in events
                                            if event["type"] == "tool_call_blocked"
                                            and event.get("reason") == "window_obligation_pending") == 3,
            noNativeWrites=not any(event["type"] == "tool_call_started" and event.get("effect") == "write" for event in events),
            expectedReplies=len(replies) == 0,
            actorRequests=len(inputs) == 3)
    if case == "cancel": checks["nativeDeletionSucceededWithoutSemanticApproval"] = "slim-cancel-target" not in calendar.events
    if case in ("stale", "hidden", "changed"):
        checks["anotherNativeWriteSucceeded"] = any(event.title == "Allowed new operation" for event in calendar.events.values())
        if case == "stale": checks["staleDiagnosticExists"] = any(row.get("status") == "stale" for row in observations)
        if case == "hidden": checks["originalReadReallyHidden"] = any("slim-0" in receipt.get("hiddenToolCallIds", []) for receipt in compactions)
        if case == "changed":
            query_hashes = [capture["request"]["outcome"]["resultHash"] for capture in captures
                if capture["checkpoint"] == "after_tool" and capture["request"].get("action", {}).get("canonicalName") == "Calendar__get_calendar_events_from_to"]
            checks["actualQueryResultChanged"] = len(set(query_hashes)) == 2
            checks["changedReadDiagnosticExists"] = any(row.get("status") in ("conflicting", "superseded_by_fresh_read") for row in observations)
    if case == "unknown_repeat":
        checks.update(actualEffectsExactlyOnce=ledger.values == ["unknown", "different"], exactUnknownStillRecorded=len(writes.get("unknown", [])) == 1,
            exactRepeatsBlocked=len(writes.get("blocked", [])) >= 2)
    if case == "wait_stop":
        signals = [capture["response"].get("temporalReceipt", {}).get("state", {}).get("signal", {}).get("kind") for capture in captures
                   if isinstance(capture["response"].get("temporalReceipt", {}).get("state", {}).get("signal"), dict)]
        checks["officialStopSignal"] = "environment_stop" in signals
        checks["onlyTwoActorCalls"] = len(inputs) == 2
    save(report_path.parent / "actor-inputs.json", inputs); save(report_path.parent / "hook-receipts.json", captures)
    save(report_path.parent / "are-events.json", env.event_log.to_dict())
    report = {"schemaVersion": "gaia2-runtime-slim-controlled-fixture-v1", "case": case, "status": "passed" if all(checks.values()) else "failed", "checks": checks,
        "actorRequests": len(inputs), "realModelRequests": 0, "externalAttempts": len(external), "failure": failure, "hookReceipts": len(captures), "diagnosticStatuses": [row.get("status") for row in observations]}
    save(report_path, report); return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--case", required=True); parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(); result = run(args.report.resolve(), args.case)
    print(json.dumps({"case": args.case, "status": result["status"], "actorRequests": result["actorRequests"], "realModelRequests": 0}))
    raise SystemExit(0 if result["status"] == "passed" else 2)
