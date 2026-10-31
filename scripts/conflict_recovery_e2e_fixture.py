"""Scripted Actors, genuine ARE tools and live Host; never a benchmark score.

The Calendar path copies only the eight events visible in a completed Actor
input, not oracle actions or sealed validation data. Negative injections use
real ARE ENV/USER events at a documented IPC delivery boundary.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "scripts"))
SOURCE_BASE = ROOT / "runs/temporal-official-ten-20261019T154626382Z-7082b888/task-02/output/temporal-evidence"
SOURCE_INPUT = SOURCE_BASE / "model-000001-input.json"
SOURCE_QUERY = SOURCE_BASE / "model-000000-output.json"
SOURCE_WRITE = SOURCE_BASE / "model-000020-output.json"
CASES = ("confirmed", "changed_budget", "user_before_read", "user_after_read", "stop_before_read", "unknown_write")


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, default=str)
        stream.write("\n")
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def response(name, arguments, index):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None,
        tool_calls=[SimpleNamespace(id=f"conflict-fixture-{index}", function=SimpleNamespace(
            name=name, arguments=json.dumps(arguments, ensure_ascii=False))) ]))])


def source_material():
    visible = json.loads(SOURCE_INPUT.read_text(encoding="utf-8"))
    query = json.loads(SOURCE_QUERY.read_text(encoding="utf-8"))["toolCalls"][0]
    write = json.loads(SOURCE_WRITE.read_text(encoding="utf-8"))["toolCalls"][0]
    value = next(json.loads(item["content"]) for item in visible["messages"]
        if item.get("role") == "tool" and item.get("tool_call_id") == query["id"])
    assert value["total"] == 8 and value["range"] == [0, 8] and len(value["events"]) == 8
    return visible, query, write, value


def last_result(messages, call_id=None):
    for item in reversed(messages):
        if item.get("role") == "tool" and (call_id is None or item.get("tool_call_id") == call_id):
            try:
                return json.loads(item["content"])
            except (TypeError, ValueError, KeyError):
                continue
    return None


def event_from_visible_text(body, event_class):
    fields = {}
    for label in ("EventID", "Title", "Start", "End", "Tag", "Description", "Location", "Attendees"):
        match = re.search(r"^" + re.escape(label) + r": (.*)$", body, re.MULTILINE)
        assert match, f"Visible source event missing {label}"
        fields[label] = match[1]
    event = event_class(event_id=fields["EventID"], title=fields["Title"],
        start_datetime=datetime.fromisoformat(fields["Start"]).timestamp(),
        end_datetime=datetime.fromisoformat(fields["End"]).timestamp(),
        tag=None if fields["Tag"] == "None" else fields["Tag"],
        description=None if fields["Description"] == "None" else fields["Description"],
        location=None if fields["Location"] == "None" else fields["Location"],
        attendees=[name.strip() for name in fields["Attendees"].split(",") if name.strip()])
    assert str(event) == body, "Synthetic event must exactly match the visible native source text"
    return event


def run(report_path, case):
    external, actor_inputs, captures, runtime_events, injections = [], [], [], [], []
    original_connect = socket.socket.connect
    def loopback_only(sock, address):
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
            external.append(type(address).__name__)
            raise RuntimeError("Controlled conflict fixture forbids external network")
        return original_connect(sock, address)
    socket.socket.connect = loopback_only
    import capybara_official_bridge as bridge
    from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender
    from are.simulation.apps.app import App
    from are.simulation.apps.calendar import Calendar, CalendarEvent
    from are.simulation.apps.system import SystemApp
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.scenarios.scenario import Scenario
    from are.simulation.tool_utils import OperationType, app_tool
    from are.simulation.types import EnvironmentState, Event, EventType, event_registered
    from gaia2_runtime_hooks import RuntimeHookClient

    visible, source_query, source_write, initial = source_material()
    query_arguments = json.loads(source_query["arguments"])
    write_arguments = json.loads(source_write["arguments"])
    calendar = Calendar()
    for body in initial["events"]:
        event = event_from_visible_text(body, CalendarEvent)
        calendar.events[event.event_id] = event
    source_ids = list(calendar.events)

    class OutcomeLedger(App):
        """An isolated genuine App for the non-idempotent unknown-outcome test."""
        def __init__(self):
            super().__init__("OutcomeLedger")
            self.effects = []
        @app_tool()
        @event_registered(operation_type=OperationType.READ)
        def read(self) -> dict:
            """Read actual synthetic effects.
            :returns: the observed effect list
            """
            return {"effects": list(self.effects)}
        @app_tool()
        @event_registered(operation_type=OperationType.WRITE)
        def write_uncertain(self, value: str) -> str:
            """Perform one synthetic effect, then fail with an unknown outcome.
            :param value: value appended before the exception
            :returns: never returns successfully
            """
            self.effects.append(value)
            raise RuntimeError("Synthetic native effect occurred before failure")

    ledger = OutcomeLedger()
    aui, system = AgentUserInterface(), SystemApp()
    apps = [aui, system, ledger] if case == "unknown_write" else [aui, system, calendar]
    env = Environment(config=EnvironmentConfig(start_time=1728975600, duration=3600, verbose=False))
    env.register_apps(apps)
    scenario = Scenario(scenario_id=f"conflict_recovery_e2e_{case}", apps=apps, nb_turns=1,
        start_time=1728975600, duration=3600,
        additional_system_prompt="Controlled synthetic recovery validation. A confirmation read is never permission to execute or retry a write.")
    task_text = ("Synthetic unknown-outcome rehearsal. Never replay a write whose outcome is unknown."
        if case == "unknown_write" else
        "Synthetic reconstruction of visible Calendar data only. Cancel the eight events between October 18 and 21, "
        "verify the empty range, then add Silver Oak Winery on October 19 from 15:00 to 16:00 at Oakville Estate Tasting Room. "
        "An automatic confirmation must not execute the blocked write. Submit a fresh explicit write only if evidence permits it, then read back.")
    aui.send_message_to_agent(task_text)
    os.environ["GAIA2_E2E_TOOL_ALLOWLIST"] = ",".join(["AgentUserInterface__send_message_to_user",
        *(["OutcomeLedger__read", "OutcomeLedger__write_uncertain"] if case == "unknown_write" else
          ["Calendar__get_calendar_events_from_to", "Calendar__delete_calendar_event", "Calendar__add_calendar_event"])])

    original_invoke = RuntimeHookClient.invoke
    original_emit = bridge._emit_runtime_event
    original_model = bridge._call_model
    injected = False
    strict_count = 0
    recoveries = []
    retry_context_retained = False

    def inject(kind):
        nonlocal injected
        if injected:
            return
        injected = True
        now = env.time_manager.time()
        if kind == "changed":
            event = Event.from_function(calendar.add_calendar_event, event_type=EventType.ENV,
                title="Concurrent fixture update", start_datetime="2024-10-19 12:00:00",
                end_datetime="2024-10-19 12:30:00", location="Synthetic ENV")
            event.event_time = now
            env.process_event(event)
        elif kind == "user":
            event = Event.from_function(aui.send_message_to_agent, event_type=EventType.USER,
                content="New user instruction: stop the old Calendar creation request; do not create Silver Oak.")
            event.event_time = now
            env.process_event(event)
        elif kind == "stop":
            env.stop()
        injections.append({"kind": kind, "sceneTime": now,
            "boundary": "after_actual_Host_receipt_before_RuntimeHookClient_invoke_returns",
            "realAreEvent": kind != "stop", "source": "synthetic_fixture_not_Actor_arguments"})

    def invoke(client, checkpoint, **payload):
        result = original_invoke(client, checkpoint, **payload)
        captures.append({"checkpoint": checkpoint, "request": copy.deepcopy(payload), "response": copy.deepcopy(result)})
        action = payload.get("action", {})
        # The original Actor query IDs are conflict-fixture-N; only the
        # bridge-generated native recovery read can enter this injection seam.
        internal_read = (action.get("canonicalName") == "Calendar__get_calendar_events_from_to"
            and not str(action.get("id", "")).startswith("conflict-fixture-"))
        if internal_read and not injected:
            if checkpoint == "before_tool" and case in ("changed_budget", "user_before_read", "stop_before_read"):
                inject("changed" if case == "changed_budget" else "user" if case == "user_before_read" else "stop")
            elif checkpoint == "after_tool" and case == "user_after_read":
                inject("user")
        return result
    RuntimeHookClient.invoke = invoke
    def emit(kind, **payload):
        runtime_events.append({"type": kind, **payload})
        original_emit(kind, **payload)
    bridge._emit_runtime_event = emit
    bridge.install()

    def successful_adds():
        return [event for event in env.event_log.list_view() if event.event_type == EventType.AGENT
            and event.action and event.action.function_name == "add_calendar_event" and not event.failed()]

    def model(messages, tools, *_args):
        nonlocal strict_count, retry_context_retained
        bridge._validate_provider_tool_pairs(messages)
        strict_count += 1
        index = len(actor_inputs)
        item = {"index": index, "messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools)}
        actor_inputs.append(item)
        if case == "unknown_write":
            if index == 0:
                result = response("OutcomeLedger__read", {}, index)
            elif index in (1, 2):
                result = response("OutcomeLedger__write_uncertain", {"value": "one_effect_only"}, index)
            elif index == 3:
                result = response("AgentUserInterface__send_message_to_user", {"content": "The write outcome is unknown; it was not replayed."}, index)
            else:
                raise AssertionError("Unknown-outcome scenario exceeded its fixed Actor plan")
        elif index == 0:
            result = response("Calendar__get_calendar_events_from_to", query_arguments, index)
        elif 1 <= index <= 8:
            result = response("Calendar__delete_calendar_event", {"event_id": source_ids[index - 1]}, index)
        elif index == 9:
            result = response("Calendar__get_calendar_events_from_to", query_arguments, index)
        elif index == 10:
            result = response("Calendar__add_calendar_event", write_arguments, index)
        else:
            previous = last_result(messages)
            if isinstance(previous, dict) and isinstance(previous.get("conflictRecovery"), dict):
                recoveries.append(copy.deepcopy(previous["conflictRecovery"]))
            if case == "confirmed":
                if index == 11:
                    assert not successful_adds(), "The first blocked write must not execute during recovery"
                    assert recoveries and recoveries[-1]["status"] == "confirmed"
                    assert recoveries[-1]["originalWriteExecuted"] is False
                    assert recoveries[-1]["permissionGranted"] is False
                    assert recoveries[-1]["businessSuccess"] is False
                    observed = recoveries[-1].get("observation")
                    assert observed and observed["result"]["events"] == [] and observed["complete"] is True
                    retry_context_retained = any(message.get("role") == "system" and "Conflict recovery contract:" in str(message.get("content")) for message in messages)
                    result = response("Calendar__add_calendar_event", write_arguments, index)
                elif index == 12:
                    result = response("Calendar__get_calendar_events_from_to", query_arguments, index)
                elif index == 13:
                    result = response("AgentUserInterface__send_message_to_user", {"content": "The synthetic Calendar write was explicitly resubmitted once and read back."}, index)
                else:
                    raise AssertionError("Confirmed Calendar scenario exceeded its fixed Actor plan")
            elif case == "changed_budget":
                if index == 11:
                    assert recoveries and recoveries[-1]["status"] == "changed"
                    result = response("Calendar__add_calendar_event", write_arguments, index)
                elif index == 12:
                    assert recoveries[-1]["status"] == "budget_exhausted"
                    result = response("AgentUserInterface__send_message_to_user", {"content": "Concurrent state changed; no write was executed and automatic confirmation budget is exhausted."}, index)
                else:
                    raise AssertionError("Changed/budget scenario exceeded its fixed Actor plan")
            elif case in ("user_before_read", "user_after_read") and index == 11:
                assert recoveries and recoveries[-1]["status"] == "user_update"
                assert any(message.get("notificationType") == "USER_MESSAGE" and "New user instruction" in str(message.get("content"))
                    for message in bridge._hook_messages(messages)) or "New user instruction" in json.dumps(messages)
                result = response("AgentUserInterface__send_message_to_user", {"content": "Acknowledged the new user instruction; stopped the old creation request."}, index)
            else:
                raise AssertionError("No further Actor or business action is allowed after STOP")
        item["responseTools"] = [{"name": call.function.name, "arguments": json.loads(call.function.arguments), "id": call.id}
                                 for call in result.choices[0].message.tool_calls]
        return result

    bridge._call_model = model
    failure, validation = None, None
    started = joined = thread_seen = False
    try:
        env.start()
        started = True
        thread_seen = env.thread.is_alive()
        validation = bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default", "controlled-no-model", None, None)
    except Exception as error:
        failure = {"type": type(error).__name__, "code": getattr(error, "code", None), "controlledDiagnostic": str(error)[:500]}
    finally:
        try:
            env.stop()
            if env.thread is not None:
                env.join()
                joined = not env.thread.is_alive()
        finally:
            bridge._call_model = original_model
            RuntimeHookClient.invoke = original_invoke
            bridge._emit_runtime_event = original_emit
            socket.socket.connect = original_connect

    # Derive recovery results from actual tool outcomes rather than only from
    # the next model input (STOP legitimately has no next model invocation).
    all_recoveries = []
    for history in [item["messages"] for item in actor_inputs] + [item["request"].get("messages", []) for item in captures]:
        for message in history:
            if message.get("role") != "tool":
                continue
            try:
                value = json.loads(message["content"])
            except (TypeError, ValueError, KeyError):
                continue
            recovery = value.get("conflictRecovery") if isinstance(value, dict) else None
            call_id = message.get("tool_call_id", message.get("toolCallId"))
            if recovery and not any(item["callId"] == call_id for item in all_recoveries):
                all_recoveries.append({"callId": call_id, "value": recovery})
    for captured in captures:
        value = captured["request"].get("outcome", {}).get("result")
        recovery = value.get("conflictRecovery") if isinstance(value, dict) else None
        if recovery and not any(item["callId"] == captured["request"].get("action", {}).get("id") for item in all_recoveries):
            all_recoveries.append({"callId": captured["request"]["action"]["id"], "value": recovery})
    automatic_reads = [event for event in runtime_events if event["type"] == "tool_call_completed" and event.get("dispatchSource") == "conflict_recovery"]
    completed = env.event_log.list_view()
    adds = successful_adds()
    deletes = [event for event in completed if event.event_type == EventType.AGENT and event.action
        and event.action.function_name == "delete_calendar_event" and not event.failed()]
    outputs = [message for message in aui.messages if message.sender == Sender.AGENT]
    checks = {"noTechnicalFailure": failure is None, "noRealModelRequests": not any(event["type"] == "model_request_attempt" for event in runtime_events),
        "noExternalNetwork": not external, "strictProviderPairsAtEveryActor": strict_count == len(actor_inputs) and strict_count > 0,
        "realAreThreadStartedAndJoined": started and thread_seen and joined,
        "actualConflictReceipts": any(isinstance(item["response"].get("conflictReceipt"), dict) for item in captures)}
    if case == "confirmed":
        checks.update({"fourteenActorCalls": len(actor_inputs) == 14, "eightNativeDeletes": len(deletes) == 8,
            "oneInternalConfirmationRead": len(automatic_reads) == 1, "exactlyOneExplicitNativeAdd": len(adds) == 1,
            "confirmedVisibleToActor": any(item["value"].get("status") == "confirmed" for item in all_recoveries),
            "confirmedDidNotGrantWriteOrClaimSuccess": all(item["value"].get("originalWriteExecuted") is False
                and item["value"].get("permissionGranted") is False and item["value"].get("businessSuccess") is False for item in all_recoveries),
            "replanDidNotEraseConflictContext": retry_context_retained and any(item["response"].get("hookReceipts")
                and any(hook.get("hookId") == "gaia2-replan" and hook.get("matched") for hook in item["response"]["hookReceipts"]) for item in captures),
            "readbackShowsOneSilverOak": len(calendar.events) == 1 and next(iter(calendar.events.values())).title == "Silver Oak Winery",
            "oneUserReply": len(outputs) == 1})
    elif case == "changed_budget":
        statuses = [item["value"].get("status") for item in all_recoveries]
        checks.update({"thirteenActorCalls": len(actor_inputs) == 13, "eightNativeDeletes": len(deletes) == 8,
            "changedThenBudgetExhausted": statuses == ["changed", "budget_exhausted"],
            "oneConfirmationAcrossDifferentCallIds": len(automatic_reads) == 1 and len({item["callId"] for item in all_recoveries}) == 2,
            "zeroNativeActorAdds": not adds, "concurrentEnvEventPreserved": any(event.title == "Concurrent fixture update" for event in calendar.events.values())})
    elif case in ("user_before_read", "user_after_read"):
        checks.update({"twelveActorCalls": len(actor_inputs) == 12, "oldWriteNeverExecuted": not adds,
            "exactUserUpdateSignal": any(item["value"].get("status") == "user_update" for item in all_recoveries),
            "beforeOrAfterReadBoundaryHonored": len(automatic_reads) == (0 if case == "user_before_read" else 1),
            "realUserInjection": len(injections) == 1 and injections[0]["kind"] == "user"})
    elif case == "stop_before_read":
        ended = next((event for event in runtime_events if event["type"] == "attempt_execution_ended"), {})
        checks.update({"noActorAfterStop": len(actor_inputs) == 11, "zeroNativeConfirmationAfterStop": not automatic_reads,
            "oldWriteNeverExecuted": not adds, "noSyntheticSuccessReply": not outputs,
            "environmentStopRecorded": ended.get("terminationReason") == "environment_stop"})
    else:
        states = [item["response"].get("conflictReceipt", {}).get("state") for item in captures]
        writes = [event for event in completed if event.event_type == EventType.AGENT and event.action and event.action.function_name == "write_uncertain"]
        unknown_preserved = any(item["request"].get("outcome", {}).get("status") == "unknown" for item in captures)
        checks.update({"fourActorCalls": len(actor_inputs) == 4, "oneActualUnknownEffect": ledger.effects == ["one_effect_only"] and len(writes) == 1,
            "unknownOutcomeNotRelabeled": unknown_preserved, "noAutomaticReadOrReplayForUnknown": not automatic_reads,
            "dedicatedAppNotPretendedCalendar": all(app.name != "Calendar" for app in apps)})
    artifacts = [save(report_path.parent / "actor-inputs.json", actor_inputs), save(report_path.parent / "hook-receipts.json", captures),
        save(report_path.parent / "are-completed-events.json", env.event_log.to_dict())]
    sources = [{"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in (SOURCE_INPUT, SOURCE_QUERY, SOURCE_WRITE)]
    report = {"schemaVersion": "gaia2-conflict-recovery-e2e-fixture-v1", "case": case, "status": "passed" if all(checks.values()) else "failed",
        "mode": "controlled", "syntheticFixtureOnly": True, "officialSubmissionReady": False, "benchmarkExecuted": False,
        "fullOriginalTaskExecuted": False, "copiedVisibleEventsOnly": case != "unknown_write", "originalVisibleEventCount": 8,
        "actorRequests": len(actor_inputs), "providerPairValidationCount": strict_count, "realModelRequests": 0, "externalAttempts": len(external),
        "automaticConfirmationReads": len(automatic_reads), "nativeActorAdds": len(adds), "nativeActorDeletes": len(deletes),
        "recoveryResults": all_recoveries, "injections": injections, "sourceVisibleRefs": sources,
        "environmentLifecycle": {"startedWithPublicAPI": started, "threadObservedAlive": thread_seen, "threadJoined": joined},
        "failure": failure, "checks": checks, "artifacts": artifacts}
    save(report_path, report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--case", choices=CASES, default="confirmed")
    args = parser.parse_args()
    result = run(args.report.resolve(), args.case)
    print(json.dumps({"status": result["status"], "case": args.case, "actorRequests": result["actorRequests"],
        "automaticConfirmationReads": result["automaticConfirmationReads"], "syntheticFixtureOnly": True, "realModelRequests": 0}))
    raise SystemExit(0 if result["status"] == "passed" else 2)
