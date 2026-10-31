"""Controlled Actors over real ARE Contacts, clock, ENV events and live Node Hooks."""
from __future__ import annotations

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
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "scripts"))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n")
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def response(name, arguments, index):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None,
        tool_calls=[SimpleNamespace(id=f"temporal-fixture-{index}", function=SimpleNamespace(
            name=name, arguments=json.dumps(arguments))) ]))])


def run(report_path, case, *, user_delay=65):
    external = []
    connect = socket.socket.connect
    def loopback_only(sock, address):
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
            external.append(type(address).__name__)
            raise RuntimeError("Controlled temporal fixture forbids external network")
        return connect(sock, address)
    socket.socket.connect = loopback_only
    import capybara_official_bridge as bridge
    from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender
    from are.simulation.apps.contacts import Contact, Contacts
    from are.simulation.apps.system import SystemApp
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.scenarios.scenario import Scenario
    from are.simulation.types import EnvironmentState, Event, EventType
    from gaia2_runtime_hooks import RuntimeHookClient

    # Native public names use app.name, not the Python class used by the
    # canonical evidence registry. Exercise that distinction in every case.
    contacts = Contacts(name="TemporalContacts", view_limit=10)
    public_query_tool = f"{contacts.name}__get_contacts"
    contacts.contacts["temporal-fixture-contact"] = Contact(first_name="Waiting", last_name="Fixture",
        contact_id="temporal-fixture-contact", description="PENDING")
    aui, system = AgentUserInterface(), SystemApp()
    env = Environment(config=EnvironmentConfig(start_time=1000, duration=3600, verbose=False))
    env.register_apps([aui, system, contacts])
    task_text = "Read Contacts, then delegate a read-only watch for a change. Do not edit contacts. Report the wake signal only."
    scenario = Scenario(scenario_id=f"temporal_e2e_{case}", apps=[aui, system, contacts], nb_turns=1,
        start_time=1000, duration=3600, additional_system_prompt="Synthetic temporal controller rehearsal; no business writes.")
    scenario.hints = ["HIDDEN_TEMPORAL_ORACLE_SENTINEL_23915"]
    aui.send_message_to_agent(task_text)
    os.environ["GAIA2_E2E_TOOL_ALLOWLIST"] = ",".join([public_query_tool, "SystemApp__wait_for_notification",
        "SystemApp__get_current_time", "AgentUserInterface__send_message_to_user", "capybara_wait_watch"])
    actor_inputs, receipts, events = [], [], []
    invoke = RuntimeHookClient.invoke
    def capture_hook(client, checkpoint, **payload):
        result = invoke(client, checkpoint, **payload)
        receipts.append({"checkpoint": checkpoint, "request": copy.deepcopy(payload), "response": copy.deepcopy(result)})
        return result
    RuntimeHookClient.invoke = capture_hook
    emit = bridge._emit_runtime_event
    def capture_emit(kind, **payload):
        events.append({"type": kind, **payload})
        emit(kind, **payload)
    bridge._emit_runtime_event = capture_emit
    bridge.install()
    call_model = bridge._call_model
    anchor = None
    thread_alive_during_actor = False
    provider_pair_validation_count = 0
    def model(messages, tools, *_args):
        nonlocal anchor, thread_alive_during_actor, provider_pair_validation_count
        # A scripted Actor must accept only the same valid tool-result grouping
        # required by the provider; do not let synthetic E2E mask wire defects.
        bridge._validate_provider_tool_pairs(messages)
        provider_pair_validation_count += 1
        thread_alive_during_actor = thread_alive_during_actor or (env.thread is not None and env.thread.is_alive())
        index = len(actor_inputs)
        item = {"index": index, "messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools)}
        actor_inputs.append(item)
        assert "HIDDEN_TEMPORAL_ORACLE_SENTINEL_23915" not in json.dumps(messages)
        assert any(m.get("role") == "user" and task_text in str(m.get("content")) for m in messages)
        if index == 0:
            result = response(public_query_tool, {"offset": 0}, index)
        elif index == 1:
            anchor = env.time_manager.time()
            if case == "candidate":
                event = Event.from_function(contacts.edit_contact, event_type=EventType.ENV,
                    contact_id="temporal-fixture-contact", updates={"description": "CANDIDATE_READY"})
                event.event_time = anchor + 95
                env.event_queue.put(event)
            elif case == "user_update":
                event = Event.from_function(aui.send_message_to_agent, event_type=EventType.ENV,
                    content="Stop the original monitoring goal; the user has updated the request.")
                event.event_time = anchor + user_delay
                env.event_queue.put(event)
            args = {"queryTool": public_query_tool, "queryArguments": {"offset": 0},
                "baselineRef": "latest", "intervalSeconds": 30, "maxScans": 12,
                "goal": "Wake on any Contacts result change; otherwise continue read-only monitoring."}
            if case == "deadline":
                args["until"] = anchor + 90
            result = response("capybara_wait_watch", args, index)
        elif index == 2:
            result = response("AgentUserInterface__send_message_to_user", {"content": f"Monitoring returned for {case}; no business action performed."}, index)
        else:
            raise AssertionError("Controlled Actor was unexpectedly called during the code wait loop")
        item["responseTools"] = [{"name": c.function.name, "arguments": json.loads(c.function.arguments)}
                                  for c in result.choices[0].message.tool_calls]
        return result
    bridge._call_model = model
    failure, validation = None, None
    environment_started = False
    environment_stopped = False
    environment_joined = False
    try:
        # Match the official runner's public lifecycle. Merely assigning
        # RUNNING leaves due ENV events unprocessed while Hook IPC takes time.
        env.start()
        environment_started = True
        validation = bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default", "controlled-no-model", None, None)
    except Exception as error:
        failure = {"type": type(error).__name__, "code": getattr(error, "code", None), "controlledDiagnostic": str(error)[:500]}
    finally:
        try:
            env.stop()
            environment_stopped = True
            if env.thread is not None:
                env.join()
                environment_joined = not env.thread.is_alive()
        finally:
            bridge._call_model = call_model
            RuntimeHookClient.invoke = invoke
            socket.socket.connect = connect
    completed = env.event_log.list_view()
    reads = [e for e in completed if e.action and e.action.function_name == "get_contacts" and not e.failed()]
    waits = [e for e in completed if e.action and e.action.function_name == "wait_for_notification" and not e.failed()]
    writes = [e for e in completed if e.event_type == EventType.AGENT and e.action
        and e.action.app_name != "AgentUserInterface"
        and getattr(e.action.operation_type, "value", e.action.operation_type) == "write"]
    last_input = actor_inputs[2]["messages"] if len(actor_inputs) > 2 else []
    result_values = []
    for message in last_input:
        if message.get("role") == "tool" and "wait_watch" in str(message.get("name", "")):
            try: result_values.append(json.loads(message["content"]))
            except (ValueError, TypeError, KeyError): pass
    def find_signal(value):
        if isinstance(value, dict):
            if isinstance(value.get("signal"), dict): return value["signal"].get("kind")
            for item in value.values():
                signal = find_signal(item)
                if signal: return signal
        return None
    signal = next((find_signal(v) for v in result_values if find_signal(v)), None)
    expected = {"candidate": {"candidate_changed"}, "deadline": {"deadline", "deadline_approaching"}, "user_update": {"user_update"}}[case]
    checks = {"noTechnicalFailure": failure is None, "threeActorRequestsOnly": len(actor_inputs) == 3,
        "strictProviderToolPairsValidated": provider_pair_validation_count == len(actor_inputs) == 3,
        "realAreEventLoopWasRunning": environment_started and thread_alive_during_actor,
        "realAreEventLoopStoppedAndJoined": environment_stopped and environment_joined and env.state == EnvironmentState.STOPPED,
        "noExternalNetwork": not external, "zeroBusinessWrites": not writes,
        "nativeWaitsAudited": len(waits) >= 2, "nativeReadsAudited": len(reads) >= (4 if case == "candidate" else 2),
        "actualHostTemporalReceipt": any(isinstance(r["response"].get("temporalReceipt"), dict) for r in receipts),
        "correctWakeSignal": signal in expected,
        "oneUserReply": len([m for m in aui.messages if m.sender == Sender.AGENT]) == 1,
        "officialValidationCompleted": validation is not None and validation.success is True}
    # ARE Contact objects in old CompletedEvent.return_value can alias mutable app
    # state. Use the JSON that actually crossed the Host boundary at that time.
    contact_receipts = [r for r in receipts if r["checkpoint"] == "after_tool"
        and r["request"].get("action", {}).get("canonicalName") == "Contacts__get_contacts"
        and r["request"].get("outcome", {}).get("status") == "succeeded"]
    checks["publicAliasResolvedToCanonicalNative"] = (public_query_tool != "Contacts__get_contacts"
        and bool(contact_receipts)
        and all(r["request"]["action"].get("name") == public_query_tool for r in contact_receipts)
        and any(call.get("name") == "capybara_wait_watch" and call.get("arguments", {}).get("queryTool") == public_query_tool
            for item in actor_inputs for call in item.get("responseTools", [])))
    scan_evidence = [{"actionId": r["request"]["action"]["id"],
        "resultHash": r["request"]["outcome"].get("resultHash"),
        "sourceReceiptRef": r["response"]["temporalReceipt"]["sourceReceiptRef"],
        "pending": "Description: PENDING" in json.dumps(r["request"]["outcome"].get("result")),
        "candidate": "Description: CANDIDATE_READY" in json.dumps(r["request"]["outcome"].get("result"))}
        for r in contact_receipts]
    if case == "candidate":
        checks["candidateArrivedThroughEnvEvent"] = any(e.event_type == EventType.ENV and e.action
            and e.action.function_name == "edit_contact" and not e.failed() for e in completed)
        checks["candidateBodyVisibleAfterWake"] = "CANDIDATE_READY" in json.dumps(last_input)
        baseline = scan_evidence[0] if scan_evidence else {}
        scans = scan_evidence[1:]
        first_candidate = next((i for i, value in enumerate(scans) if value["candidate"]), None)
        checks["twoUnchangedScansBeforeCandidate"] = (baseline.get("pending") is True
            and first_candidate is not None and first_candidate >= 2
            and all(value["pending"] and value["resultHash"] == baseline.get("resultHash") for value in scans[:first_candidate]))
    if case == "user_update":
        checks["userUpdatePreserved"] = any(m.get("role") == "user" and "user has updated" in str(m.get("content")) for m in last_input)
    artifacts = [save(report_path.parent / "actor-inputs.json", actor_inputs), save(report_path.parent / "hook-receipts.json", receipts),
        save(report_path.parent / "are-completed-events.json", env.event_log.to_dict())]
    result = {"schemaVersion": "gaia2-temporal-e2e-fixture-v1", "status": "passed" if all(checks.values()) else "failed",
        "case": case, "mode": "controlled", "syntheticFixtureOnly": True, "officialSubmissionReady": False,
        "benchmarkExecuted": False, "checks": checks, "actorRequests": len(actor_inputs), "realModelRequests": 0,
        "providerPairValidationCount": provider_pair_validation_count,
        "externalAttempts": len(external), "nativeReads": len(reads), "nativeWaits": len(waits), "businessWrites": len(writes),
        "wakeSignal": signal, "immutableScanEvidence": scan_evidence,
        "nativeToolBinding": {"publicName": public_query_tool, "canonicalName": "Contacts__get_contacts", "appName": contacts.name},
        "environmentLifecycle": {"startedWithPublicAPI": environment_started, "threadObservedAliveDuringActor": thread_alive_during_actor,
            "stopCalled": environment_stopped, "threadJoined": environment_joined, "finalState": env.state.value},
        "worldTimeStart": anchor, "worldTimeEnd": env.time_manager.time(), "failure": failure, "artifacts": artifacts}
    save(report_path, result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--case", choices=["candidate", "deadline", "user_update"], default="candidate")
    args = parser.parse_args()
    result = run(args.report.resolve(), args.case)
    print(json.dumps({"status": result["status"], "case": args.case, "syntheticFixtureOnly": True, "realModelRequests": 0}))
    raise SystemExit(0 if result["status"] == "passed" else 2)
