"""Native entity semantics over genuine ARE tools and a live Node Hook Host.

All Actors are fixed scripts. Negative storage faults are synthetic and occur
inside a documented dictionary membership boundary, never by replacing an ARE
getter/function, its metadata, a Hook result, or the original event log.
"""
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
from conflict_recovery_e2e_fixture import last_result, response, save

DELETE_CASES = ("calendar_absent", "contacts_absent", "calendar_permission_error", "contacts_unsupported_error", "unknown_write_no_replay")
WAIT_CASES = ("wait_monitor_contacts", "wait_condition_calendar", "wait_condition_timeout_calendar", "wait_text_finish_contacts", "wait_none", "wait_no_notify",
    "wait_user_update_contacts", "wait_cancel_contacts", "wait_stop_contacts", "wait_budget_contacts")
CASES = DELETE_CASES + WAIT_CASES
FIRST_ID, SECOND_ID = "semantics-entity-first", "semantics-entity-second"


class FaultStorage(dict):
    """A synthetic storage adapter fault, with the actual ARE getter unchanged."""
    def __init__(self, values, fault_kind):
        super().__init__(values)
        self.fault_kind = fault_kind
        self.active = False
        self.faults = []

    def __contains__(self, key):
        if self.active and key == FIRST_ID:
            self.faults.append({"key": key, "boundary": "synthetic_storage_dict.__contains__",
                "officialToolFunctionChanged": False, "hostResultForged": False})
            if self.fault_kind == "permission":
                raise PermissionError("Synthetic storage access denied")
            raise RuntimeError("Synthetic unsupported storage failure")
        return super().__contains__(key)


def run(report_path, case):
    actor_inputs, captures, runtime_events, external = [], [], [], []
    original_connect = socket.socket.connect
    def loopback_only(sock, address):
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
            external.append(type(address).__name__)
            raise RuntimeError("Synthetic runtime semantics fixture forbids external network")
        return original_connect(sock, address)
    socket.socket.connect = loopback_only
    import capybara_official_bridge as bridge
    from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender
    from are.simulation.apps.app import App
    from are.simulation.apps.calendar import Calendar, CalendarEvent
    from are.simulation.apps.contacts import Contact, Contacts
    from are.simulation.apps.system import SystemApp
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.scenarios.scenario import Scenario
    from are.simulation.tool_utils import OperationType, app_tool
    from are.simulation.types import EventType, event_registered
    from gaia2_runtime_hooks import RuntimeHookClient

    original_model = bridge._call_model
    original_invoke, original_emit = RuntimeHookClient.invoke, bridge._emit_runtime_event

    class OutcomeLedger(App):
        def __init__(self):
            super().__init__("OutcomeLedger")
            self.effects = []
        @app_tool()
        @event_registered(operation_type=OperationType.READ)
        def read(self) -> dict:
            """Read actual synthetic effects.
            :returns: a complete effect list
            """
            return {"effects": list(self.effects)}
        @app_tool()
        @event_registered(operation_type=OperationType.WRITE)
        def write_uncertain(self, value: str) -> str:
            """Apply a real synthetic effect, then raise an ambiguous exception.
            :param value: the actual appended effect
            :returns: never returns successfully
            """
            self.effects.append(value)
            raise RuntimeError("Synthetic effect happened before unknown outcome")

    calendar = Calendar()
    calendar.events = {key: CalendarEvent(event_id=key, title=f"Synthetic {key}",
        start_datetime=1729321200, end_datetime=1729324800) for key in (FIRST_ID, SECOND_ID)}
    contacts = Contacts(name="PeopleBook")
    contacts.contacts = {key: Contact(first_name="Synthetic", last_name=key, contact_id=key) for key in (FIRST_ID, SECOND_ID)}
    contacts_case = case.startswith("contacts_")
    entity_app = contacts if contacts_case else calendar
    mapping_name = "contacts" if contacts_case else "events"
    fault_kind = "permission" if case == "calendar_permission_error" else "unsupported" if case == "contacts_unsupported_error" else None
    storage = (FaultStorage(getattr(entity_app, mapping_name), fault_kind)
        if fault_kind is not None else getattr(entity_app, mapping_name))
    setattr(entity_app, mapping_name, storage)
    public = entity_app.name
    get_name = "get_contact" if contacts_case else "get_calendar_event"
    original_getter = getattr(type(entity_app), get_name)
    delete_name = "delete_contact" if contacts_case else "delete_calendar_event"
    identity_key = "contact_id" if contacts_case else "event_id"
    list_name = "get_contacts" if contacts_case else "get_calendar_events_from_to"
    list_args = {"offset": 0} if contacts_case else {
        "start_datetime": "2024-10-18 00:00:00", "end_datetime": "2024-10-21 00:00:00", "limit": 100}
    canonical = "Contacts" if contacts_case else "Calendar"
    ledger, aui, system = OutcomeLedger(), AgentUserInterface(), SystemApp()
    apps = [aui, system, ledger] if case == "unknown_write_no_replay" else [aui, system, entity_app]
    fixture_identity = {"case": case, "source": "synthetic_fixed_entities_not_official_task",
        "nativeClass": type(entity_app).__name__, "publicName": public, "entityIds": [FIRST_ID, SECOND_ID],
        "initialNativeStrings": [str(value) for value in storage.values()],
        "storageFaultKind": fault_kind, "officialToolsUnmodified": True}
    env = Environment(config=EnvironmentConfig(start_time=1728975600, duration=3600, verbose=False))
    env.register_apps(apps)
    scenario = Scenario(scenario_id=f"runtime_semantics_{case}", apps=apps, nb_turns=1,
        start_time=1728975600, duration=3600,
        additional_system_prompt="Controlled native entity-semantics validation; do not claim synthetic results are benchmark success.")
    aui.send_message_to_agent("Synthetic validation only. Read both entities, delete the first and verify its exact identity is absent. "
        "Only then delete the second and read back. A real failed read must not be relabeled as absence. Never replay an unknown write.")
    os.environ["GAIA2_E2E_TOOL_ALLOWLIST"] = ",".join(["AgentUserInterface__send_message_to_user",
        *(["OutcomeLedger__read", "OutcomeLedger__write_uncertain"] if case == "unknown_write_no_replay" else
          [f"{public}__{list_name}", f"{public}__{get_name}", f"{public}__{delete_name}"])])

    def invoke(client, checkpoint, **payload):
        result = original_invoke(client, checkpoint, **payload)
        captures.append({"checkpoint": checkpoint, "request": copy.deepcopy(payload), "response": copy.deepcopy(result)})
        return result
    def emit(kind, **payload):
        runtime_events.append({"type": kind, **payload})
        original_emit(kind, **payload)
    RuntimeHookClient.invoke = invoke
    bridge._emit_runtime_event = emit
    bridge.install()
    pair_checks = 0

    def model(messages, tools, *_args):
        nonlocal pair_checks
        bridge._validate_provider_tool_pairs(messages)
        pair_checks += 1
        index = len(actor_inputs)
        item = {"index": index, "messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools)}
        actor_inputs.append(item)
        if case == "unknown_write_no_replay":
            if index == 0:
                value = response("OutcomeLedger__read", {}, index)
            elif index in (1, 2):
                value = response("OutcomeLedger__write_uncertain", {"value": "effect_once"}, index)
            elif index == 3:
                value = response("AgentUserInterface__send_message_to_user", {"content": "Stopped safely; the uncertain write was not replayed."}, index)
            else:
                raise AssertionError("Unknown-write fixed Actor plan exceeded")
        elif index == 0:
            value = response(f"{public}__{list_name}", list_args, index)
        elif index == 1:
            value = response(f"{public}__{delete_name}", {identity_key: FIRST_ID}, index)
        elif index == 2:
            if fault_kind is not None:
                storage.active = True
            value = response(f"{public}__{get_name}", {identity_key: FIRST_ID}, index)
        elif index == 3:
            if fault_kind is not None:
                storage.active = False
            value = response(f"{public}__{delete_name}", {identity_key: SECOND_ID}, index)
        elif index == 4 and fault_kind is None:
            value = response(f"{public}__{get_name}", {identity_key: SECOND_ID}, index)
        elif (index == 4 and fault_kind is not None) or (index == 5 and fault_kind is None):
            value = response("AgentUserInterface__send_message_to_user", {"content": "Synthetic entity-semantics check finished without assuming an unsafe write succeeded."}, index)
        else:
            raise AssertionError("Entity fixed Actor plan exceeded")
        item["responseTools"] = [{"id": call.id, "name": call.function.name, "arguments": json.loads(call.function.arguments)}
            for call in value.choices[0].message.tool_calls]
        return value
    bridge._call_model = model
    failure = None
    started = thread_seen = joined = False
    try:
        env.start(); started = True; thread_seen = env.thread.is_alive()
        bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default", "controlled-no-model", None, None)
    except Exception as error:
        failure = {"type": type(error).__name__, "code": getattr(error, "code", None), "controlledDiagnostic": str(error)[:400]}
    finally:
        try:
            env.stop()
            if env.thread is not None:
                env.join(); joined = not env.thread.is_alive()
        finally:
            socket.socket.connect, bridge._call_model = original_connect, original_model
            RuntimeHookClient.invoke, bridge._emit_runtime_event = original_invoke, original_emit

    after = [item for item in captures if item["checkpoint"] == "after_tool"]
    def host_variables(capture):
        receipt = capture["response"]["semanticReceipt"]
        workspace = Path(os.environ["GAIA2_ENTITY_SEMANTICS_WORKSPACE"]).resolve()
        source_path = (workspace / receipt["sourceReceiptRef"]["path"]).resolve()
        assert source_path.is_relative_to(workspace)
        source = json.loads(source_path.read_text(encoding="utf-8"))
        assert source["input"] == {**capture["request"], "checkpoint": capture["checkpoint"]}
        return source["variables"]
    completed = env.event_log.list_view()
    deletes = [event for event in completed if event.event_type == EventType.AGENT and event.action
        and event.action.function_name == delete_name and not event.failed()]
    blocked = [event for event in runtime_events if event["type"] == "tool_call_blocked"]
    checks = {"noTechnicalFailure": failure is None, "realAreThreadStartedAndJoined": started and thread_seen and joined,
        "noRealModelRequests": not any(event["type"] == "model_request_attempt" for event in runtime_events),
        "noExternalNetwork": not external, "strictProviderPairsAtEveryActor": pair_checks == len(actor_inputs) and pair_checks > 0,
        "actualLiveHostReceipts": bool(captures) and all(item["response"].get("conflictReceipt") and item["response"].get("temporalReceipt") for item in captures)}
    if case == "unknown_write_no_replay":
        native_writes = [event for event in completed if event.event_type == EventType.AGENT and event.action and event.action.function_name == "write_uncertain"]
        checks.update({"fourActorCalls": len(actor_inputs) == 4, "exactlyOneEffectAndNativeWrite": ledger.effects == ["effect_once"] and len(native_writes) == 1,
            "unknownStatusPreserved": any(item["request"].get("outcome", {}).get("status") == "unknown" for item in after),
            "secondCallIdStillBlocked": any(item.get("callId") == "conflict-fixture-2" for item in blocked),
            "noAutomaticConfirmationForUnknown": not any(event["type"] == "tool_call_completed" and event.get("dispatchSource") == "conflict_recovery" for event in runtime_events)})
    else:
        reads = [item for item in after if item["request"].get("action", {}).get("canonicalName") == f"{canonical}__{get_name}"]
        checks.update({"nativeIdentityAndReadCount": len(reads) == (2 if fault_kind is None else 1),
            "publicAliasPreserved": not contacts_case or public == "PeopleBook",
            "originalGetterFunctionNotModified": getattr(type(entity_app), get_name) is original_getter})
        if fault_kind is None:
            evidence = [item["request"].get("outcome", {}).get("semanticEvidence") for item in reads]
            raw_results = [last_result(actor_inputs[index + 1]["messages"], f"conflict-fixture-{index}")
                if len(actor_inputs) > index + 1 else None for index in (2, 4)]
            variables = [host_variables(item) for item in reads]
            observations = [next((value for value in values["gaia2_observation_state"]["observations"]
                if value["actionId"] == item["request"]["action"]["id"]), None) for item, values in zip(reads, variables)]
            checks.update({"sixActorCalls": len(actor_inputs) == 6, "bothNativeDeletesSucceeded": len(deletes) == 2 and not storage,
                "originalErrorResultsNotRewritten": all(isinstance(raw, dict) and raw.get("status") == "failed_before_execution"
                    and raw.get("errorType") == ("KeyError" if contacts_case else "ValueError")
                    and item["request"]["outcome"].get("status") == raw["status"]
                    and item["request"]["outcome"].get("errorType") == raw["errorType"]
                    and hashlib.sha256(json.dumps(raw, default=str, sort_keys=True).encode()).hexdigest() == item["request"]["outcome"]["resultHash"]
                    for item, raw in zip(reads, raw_results)),
                "bothAbsenceReceiptsBoundToDeletion": len(evidence) == 2 and all(isinstance(value, dict)
                    and value.get("schemaVersion") == "gaia2-entity-evidence-v1" and value.get("kind") == "entity_absent"
                    and value.get("deleteReceiptRef") for value in evidence),
                "exactEntityAndDeleteBindings": len(evidence) == 2 and all(value["entityRef"] == {
                    "resourceKey": public, "entityType": "Contact" if contacts_case else "CalendarEvent", "entityId": entity_id}
                    and value["callRef"]["actionId"] == f"conflict-fixture-{read_index}"
                    and value["deleteReceiptRef"]["actionId"] == f"conflict-fixture-{delete_index}"
                    and value["callRef"]["resultHash"] == read["request"]["outcome"]["resultHash"]
                    and value["callRef"]["queryHash"] == read["request"]["action"]["mutationKey"]
                    for value, entity_id, read_index, delete_index, read in zip(evidence,
                        (FIRST_ID, SECOND_ID), (2, 4), (1, 3), reads)),
                "noFailedObservationPollution": all(observation and observation["status"] == "verified_absent_after_delete"
                    and observation["outcomeStatus"] == "failed_before_execution"
                    and observation["observationId"] not in values["gaia2_observation_state"]["unverified_ids"]
                    for observation, values in zip(observations, variables)),
                "actualEntityStateRecordsEvidence": all(value in values["gaia2_entity_state"]["records"]
                    for value, values in zip(evidence, variables)),
                "semanticHintVisibleBeforeNextWrite": any(message.get("role") == "system"
                    and "Exact entity evidence contract:" in str(message.get("content"))
                    and "entity_absent" in str(message.get("content")) for message in actor_inputs[3]["messages"]),
                "noDeleteBlocked": not any(event.get("canonicalName") == f"{canonical}__{delete_name}" for event in blocked)})
        else:
            failed_variables = host_variables(reads[0]) if len(reads) == 1 else None
            failed_observation = next((value for value in failed_variables["gaia2_observation_state"]["observations"]
                if value["actionId"] == reads[0]["request"]["action"]["id"]), None) if failed_variables else None
            checks.update({"fiveActorCalls": len(actor_inputs) == 5, "onlyFirstNativeDeleteSucceeded": len(deletes) == 1 and SECOND_ID in storage,
                "trueNativeFailureNotAbsence": len(reads) == 1 and reads[0]["request"]["outcome"].get("status") != "succeeded"
                    and not reads[0]["request"]["outcome"].get("semanticEvidence"),
                "otherDeleteRemainsBlocked": any(event.get("canonicalName") == f"{canonical}__{delete_name}" and event.get("callId") == "conflict-fixture-3" for event in blocked),
                "failedObservationRemainsUnverified": failed_observation is not None and failed_observation["status"] == "failed"
                    and failed_observation["observationId"] in failed_variables["gaia2_observation_state"]["unverified_ids"],
                "actualSyntheticStorageFault": len(storage.faults) == 1})
    artifacts = [save(report_path.parent / "actor-inputs.json", actor_inputs), save(report_path.parent / "hook-receipts.json", captures),
        save(report_path.parent / "are-completed-events.json", env.event_log.to_dict()), save(report_path.parent / "fixture-identity.json", fixture_identity)]
    outputs = [message for message in aui.messages if message.sender == Sender.AGENT]
    report = {"schemaVersion": "gaia2-runtime-semantics-e2e-fixture-v1", "case": case, "status": "passed" if all(checks.values()) else "failed",
        "syntheticFixtureOnly": True, "benchmarkExecuted": False, "officialSubmissionReady": False, "realModelRequests": 0,
        "externalAttempts": len(external), "actorRequests": len(actor_inputs), "providerPairValidationCount": pair_checks,
        "nativeDeletes": len(deletes), "blockedTools": len(blocked), "userReplies": len(outputs), "storageFaults": getattr(storage, "faults", []),
        "environmentLifecycle": {"startedWithPublicAPI": started, "threadObservedAlive": thread_seen, "threadJoined": joined},
        "failure": failure, "checks": checks, "artifacts": artifacts,
        "fixtureSource": {"path": str(Path(__file__).resolve()), "sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}}
    save(report_path, report)
    return report


def run_wait(report_path, case):
    """Fixed strategies consume only actual visible state/evidence; no model calls."""
    actor_inputs, captures, runtime_events, external, resolver_records = [], [], [], [], []
    original_connect = socket.socket.connect
    def loopback_only(sock, address):
        if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
            external.append(type(address).__name__)
            raise RuntimeError("Synthetic wait fixture forbids external network")
        return original_connect(sock, address)
    socket.socket.connect = loopback_only
    import capybara_official_bridge as bridge
    import gaia2_task_contract_model as resolver
    from gaia2_task_contract import task_contract_hash
    from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender
    from are.simulation.apps.app import App
    from are.simulation.apps.calendar import Calendar, CalendarEvent
    from are.simulation.apps.contacts import Contact, Contacts
    from are.simulation.apps.system import SystemApp
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.scenarios.scenario import Scenario
    from are.simulation.tool_utils import OperationType
    from are.simulation.types import Event, EventType, event_registered
    from gaia2_runtime_hooks import RuntimeHookClient

    class StopControl(App):
        """Hidden synthetic ENV endpoint calling the genuine Environment.stop API."""
        def __init__(self):
            super().__init__("SyntheticSceneControl")
            self.stop_callback = None
            self.stopped = False
        def get_state(self):
            return {"stopped": self.stopped}
        @event_registered(operation_type=OperationType.READ, event_type=EventType.ENV)
        def end_scene(self) -> str:
            self.stopped = True
            self.stop_callback()
            return "Synthetic ENV stop"

    contacts = Contacts(name="WatchPeople", view_limit=10)
    contacts.contacts[FIRST_ID] = Contact(first_name="Synthetic", last_name="Watch", contact_id=FIRST_ID, description="PENDING")
    calendar = Calendar(name="WatchCalendar")
    calendar.events[FIRST_ID] = CalendarEvent(event_id=FIRST_ID, title="PENDING", start_datetime=1729321200, end_datetime=1729324800)
    calendar_case = case in ("wait_condition_calendar", "wait_condition_timeout_calendar")
    app = calendar if calendar_case else contacts
    query_tool = f"{app.name}__get_calendar_events_from_to" if calendar_case else f"{app.name}__get_contacts"
    query_arguments = {"start_datetime": "2024-10-18 00:00:00", "end_datetime": "2024-10-21 00:00:00", "limit": 100} if calendar_case else {"offset": 0}
    aui, system, control = AgentUserInterface(), SystemApp(), StopControl()
    apps = [aui, system, app, control]
    env = Environment(config=EnvironmentConfig(start_time=1728975600, duration=3600, verbose=False))
    env.register_apps(apps); control.stop_callback = env.stop
    scenario = Scenario(scenario_id=f"runtime_semantics_{case}", apps=apps, nb_turns=1, start_time=1728975600, duration=3600,
        additional_system_prompt="Controlled waiting-obligation validation; all outcomes are synthetic and not benchmark scores.")
    task_text = ("Synthetic ordinary task: send a short acknowledgement; no waiting is requested." if case == "wait_none" else
        "Synthetic condition task: wait at most 180 seconds for the Calendar candidate, then finish when that condition is observed." if calendar_case else
        "Synthetic monitoring task: keep checking Contacts for the full next 180 seconds, including after an early candidate is observed.")
    if case == "wait_no_notify":
        task_text += " Do not send any notification, including after the monitoring period."
    ordinary_update = "Additional ordinary request: keep the original monitoring deadline unchanged."
    cancel_update = "Explicitly cancel the previous monitoring obligation; acknowledge cancellation only."
    aui.send_message_to_agent(task_text)
    os.environ["GAIA2_E2E_TOOL_ALLOWLIST"] = ",".join([query_tool, "SystemApp__wait_for_notification",
        "AgentUserInterface__send_message_to_user", "capybara_task_obligation_step", "capybara_wait_watch"])
    scheduled, anchor, original_deadline = False, None, None
    original_extract, original_review = resolver.extract_task_contract, resolver.review_task_contract

    def extract(source, _model_call, prior_obligations=None):
        nonlocal scheduled, anchor, original_deadline
        resolver_records.append({"kind": "extract", "source": copy.deepcopy(source), "prior": copy.deepcopy(prior_obligations or [])})
        value = {"schemaVersion": "gaia2-task-contract-proposal-v1", "sourceHash": source["sourceHash"],
            "resolution": "none", "notificationPolicy": "forbid" if case == "wait_no_notify" else "allow", "obligations": [], "revocations": []}
        if task_text in source["text"]:
            if case != "wait_none":
                value["resolution"] = "obligations"
                start = source["text"].index(task_text)
                value["obligations"] = [{"span": {"start": start, "end": start + len(task_text), "text": task_text},
                    "mode": "condition_once" if calendar_case else "monitor_until", "goal": "Review actual native query evidence for the stated synthetic request",
                    "timeBasis": {"kind": "relative", "durationSeconds": 180}, "recipe": None}]
            if not scheduled:
                scheduled = True; anchor = source["arrivedAt"]; original_deadline = anchor + 180
                if case not in ("wait_none", "wait_budget_contacts", "wait_stop_contacts", "wait_cancel_contacts", "wait_condition_timeout_calendar"):
                    candidate = (Event.from_function(calendar.add_calendar_event, event_type=EventType.ENV,
                        title="CANDIDATE_READY", start_datetime="2024-10-19 14:00:00", end_datetime="2024-10-19 14:30:00") if calendar_case else
                        Event.from_function(contacts.edit_contact, event_type=EventType.ENV, contact_id=FIRST_ID, updates={"description": "CANDIDATE_READY"}))
                    candidate.event_time = anchor + 95; env.event_queue.put(candidate)
                if case in ("wait_user_update_contacts", "wait_cancel_contacts"):
                    update = Event.from_function(aui.send_message_to_agent, event_type=EventType.USER,
                        content=cancel_update if case == "wait_cancel_contacts" else ordinary_update)
                    update.event_time = anchor + 65; env.event_queue.put(update)
                if case in ("wait_no_notify", "wait_stop_contacts"):
                    stop = Event.from_function(control.end_scene, event_type=EventType.ENV)
                    stop.event_time = anchor + (240 if case == "wait_no_notify" else 65); env.event_queue.put(stop)
        elif ordinary_update in source["text"]:
            pass
        elif cancel_update in source["text"]:
            start = source["text"].index(cancel_update)
            value["revocations"] = [{"obligationId": item["id"], "span": {"start": start, "end": start + len(cancel_update), "text": cancel_update}}
                for item in prior_obligations or []]
        else:
            value["resolution"], value["notificationPolicy"] = "ambiguous", "forbid"
        return value

    def review(source, proposal, _model_call, prior_obligations=None):
        resolver_records.append({"kind": "review", "sourceHash": source["sourceHash"], "proposalHash": task_contract_hash(proposal)})
        return {"schemaVersion": "gaia2-task-contract-review-v1", "sourceHash": source["sourceHash"],
            "proposalHash": task_contract_hash(proposal), "decision": "approved", "notificationVerified": True,
            "obligationChecks": [{"index": index, "spanVerified": True, "modeVerified": True, "timeVerified": True} for index in range(len(proposal["obligations"]))],
            "revocationChecks": [{"index": index, "explicitRevocation": True} for index in range(len(proposal["revocations"]))],
            "reason": "Trusted synthetic fixture independently reviewed its fixed visible USER request."}
    resolver.extract_task_contract, resolver.review_task_contract = extract, review
    original_model, original_invoke, original_emit = bridge._call_model, RuntimeHookClient.invoke, bridge._emit_runtime_event
    def invoke(client, checkpoint, **payload):
        result = original_invoke(client, checkpoint, **payload)
        captures.append({"checkpoint": checkpoint, "request": copy.deepcopy(payload), "response": copy.deepcopy(result)})
        return result
    def emit(kind, **payload):
        runtime_events.append({"type": kind, **payload}); original_emit(kind, **payload)
    RuntimeHookClient.invoke, bridge._emit_runtime_event = invoke, emit
    bridge.install()
    pair_checks, bound, baseline_done, initial_finish_sent = 0, False, False, False
    reviews = []
    def state_now():
        return next((item["response"]["semanticReceipt"]["taskContractState"] for item in reversed(captures)
            if isinstance(item["response"].get("semanticReceipt"), dict)), None)

    def model(messages, tools, *_args):
        nonlocal pair_checks, bound, baseline_done, initial_finish_sent
        bridge._validate_provider_tool_pairs(messages); pair_checks += 1
        index = len(actor_inputs)
        if index >= 25:
            raise AssertionError("Bounded synthetic wait Actor exceeded its plan")
        item = {"index": index, "messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools), "sceneNow": env.time_manager.time()}
        actor_inputs.append(item)
        state = state_now(); item["actualTaskState"] = copy.deepcopy(state)
        assert state and state["enabled"] is True
        assert any(source["resolution"] in ("registered", "reviewed_none") for source in state["sources"])
        obligation = state["obligations"][0] if state["obligations"] else None
        if obligation:
            assert obligation["id"] in json.dumps(messages), "An obligation ID used by the script must really be visible to the Actor"
        if not initial_finish_sent:
            initial_finish_sent = True
            if case == "wait_text_finish_contacts":
                result = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="Premature synthetic text completion", tool_calls=[]))])
            else:
                result = response("AgentUserInterface__send_message_to_user", {"content": "Premature synthetic reply" if obligation else "Ordinary synthetic task acknowledged."}, index)
        elif obligation and not bound:
            previous = last_result(messages)
            assert previous and previous.get("taskContractContinuation", {}).get("status") == "bind_required"
            bound = True
            result = response("capybara_task_obligation_step", {"op": "bind_recipe", "obligationId": obligation["id"],
                "queryTool": query_tool, "queryArguments": query_arguments, "intervalSeconds": 30,
                "maxScans": 1 if case == "wait_budget_contacts" else 12}, index)
        elif obligation and not baseline_done:
            baseline_done = True
            result = response(query_tool, query_arguments, index)
        elif obligation and obligation["pendingEvidence"] is not None:
            pending = obligation["pendingEvidence"]
            decision = ("deadline_reviewed" if pending["observedAt"] >= obligation["deadline"] else
                "condition_satisfied" if calendar_case else "continue")
            reviews.append({"decision": decision, "actionId": pending["actionId"], "sceneNow": env.time_manager.time(), "deadline": obligation["deadline"]})
            result = response("capybara_task_obligation_step", {"op": "review_event", "obligationId": obligation["id"],
                "actionId": pending["actionId"], "decision": decision, "reason": "Synthetic Actor explicitly reviewed the exact actual native observation."}, index)
        else:
            result = response("AgentUserInterface__send_message_to_user", {"content": "Synthetic cancellation acknowledged." if case == "wait_cancel_contacts" else "Synthetic final reply after independent task-contract checks."}, index)
        item["responseTools"] = [{"id": call.id, "name": call.function.name, "arguments": json.loads(call.function.arguments)}
            for call in result.choices[0].message.tool_calls]
        item["responseText"] = result.choices[0].message.content
        return result
    bridge._call_model = model
    failure, started, thread_seen, joined = None, False, False, False
    try:
        env.start(); started = True; thread_seen = env.thread.is_alive()
        bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default", "controlled-no-model", None, None)
    except Exception as error:
        failure = {"type": type(error).__name__, "code": getattr(error, "code", None), "controlledDiagnostic": str(error)[:400]}
    finally:
        try:
            env.stop()
            if env.thread is not None:
                env.join(); joined = not env.thread.is_alive()
        finally:
            socket.socket.connect, bridge._call_model = original_connect, original_model
            RuntimeHookClient.invoke, bridge._emit_runtime_event = original_invoke, original_emit
            resolver.extract_task_contract, resolver.review_task_contract = original_extract, original_review
    final_state = state_now()
    obligations = final_state.get("obligations", []) if final_state else []
    outputs = [message for message in aui.messages if message.sender == Sender.AGENT]
    signals = [event for event in runtime_events if event["type"] == "task_obligation_signaled"]
    waits = [event for event in runtime_events if event["type"] == "tool_call_completed" and event.get("canonicalName") == "SystemApp__wait_for_notification"]
    native_queries = [item for item in captures if item["checkpoint"] == "after_tool" and item["request"].get("action", {}).get("canonicalName") == ("Calendar__get_calendar_events_from_to" if calendar_case else "Contacts__get_contacts")]
    actor_writes = [event for event in runtime_events if event["type"] == "tool_call_started" and event.get("effect") == "write"]
    budget_expected = case == "wait_budget_contacts"
    checks = {"noUnexpectedTechnicalFailure": failure is None or budget_expected and failure["type"] in ("HookProtocolError", "BridgeBudgetExceeded"),
        "realAreThreadStartedAndJoined": started and thread_seen and joined, "noExternalNetwork": not external,
        "noRealModelRequests": not any(event["type"] in ("model_request_attempt", "task_contract_model_request") for event in runtime_events),
        "trustedResolverUsedWithoutActorDeclaration": len(resolver_records) >= 2 and all(item["kind"] != "extract"
            or any(expected in item["source"]["text"] for expected in (task_text, ordinary_update, cancel_update)) for item in resolver_records),
        "strictProviderPairsAtEveryActor": pair_checks == len(actor_inputs) and pair_checks > 0,
        "noBusinessWrites": not actor_writes,
        "originalUserAnchoredDeadlineUnchanged": case == "wait_none" or bool(obligations) and all(item["deadline"] == original_deadline for item in obligations),
        "actualTaskStateCommittedToHost": final_state is not None and final_state.get("enabled") is True}
    if case == "wait_none":
        checks.update({"ordinaryNoWaitAllowed": len(actor_inputs) == 1 and len(outputs) == 1,
            "independentlyReviewedNone": not obligations and all(source["resolution"] == "reviewed_none" for source in final_state["sources"]),
            "noUnnecessaryWaitOrQuery": not waits and not native_queries})
    elif budget_expected:
        checks.update({"budgetNotReportedAsSatisfied": obligations and all(item["status"] == "technical_blocked" for item in obligations),
            "noReplyOnTechnicalBoundary": not outputs, "boundedNativeWaits": len(waits) <= 2,
            "scanBudgetSignalAudited": any(item.get("signal") == "scan_budget" for item in signals)})
    elif case == "wait_stop_contacts":
        checks.update({"stopNotReportedAsSatisfied": obligations and all(item["status"] != "satisfied" for item in obligations),
            "noReplyAfterStop": not outputs, "realEnvStopEventRan": control.stopped})
    elif case == "wait_cancel_contacts":
        checks.update({"explicitCancellationIsRevokedNotSatisfied": obligations and all(item["status"] == "revoked" for item in obligations),
            "newUserWasIndependentlyResolved": len(final_state["sources"]) == 2,
            "cancellationNotGenericCompletion": len(outputs) == 1 and "cancellation" in str(outputs[0].content).lower()})
    elif case == "wait_condition_timeout_calendar":
        checks.update({"conditionTimeoutUsesFinalNativeReview": obligations and all(item["status"] == "satisfied" for item in obligations)
            and len(reviews) == 1 and reviews[0]["decision"] == "deadline_reviewed" and reviews[0]["sceneNow"] >= original_deadline,
            "completionReasonMeansWindowOnly": all(item.get("completionReason") == "deadline_reviewed" for item in obligations),
            "neverClaimedConditionSatisfied": not any(item["decision"] == "condition_satisfied" for item in reviews),
            "deadlineNotBusinessSuccess": bool(signals) and all(item.get("businessSuccess") is False for item in signals),
            "oneFinalReply": len(outputs) == 1})
    else:
        candidate_signals = [item for item in signals if item.get("signal") == "candidate_changed"]
        checks.update({"candidateActuallyWokeActor": bool(candidate_signals),
            "explicitNativeEvidenceReview": bool(reviews), "obligationSatisfiedOnlyAfterReview": obligations and all(item["status"] == "satisfied" for item in obligations),
            "rawWatchNeverRequired": not any(call["name"] == "capybara_wait_watch" for item in actor_inputs for call in item["responseTools"]),
            "queryAliasPreserved": bool(native_queries) and all(item["request"]["action"].get("name") == query_tool for item in native_queries)})
        if calendar_case:
            checks["conditionOnceCanFinishBeforeDeadline"] = (len(outputs) == 1 and reviews[-1]["decision"] == "condition_satisfied"
                and reviews[-1]["sceneNow"] < original_deadline and all(item.get("completionReason") == "condition_satisfied" for item in obligations))
        else:
            checks.update({"candidateDidNotFinishMonitor": any(item["decision"] == "continue" and item["sceneNow"] < original_deadline for item in reviews),
                "finalNativeReadAfterOriginalDeadlineReviewed": any(item["decision"] == "deadline_reviewed" for item in reviews),
                "multipleUnchangedScansStayedCodeOnly": bool(candidate_signals) and candidate_signals[0].get("nativeWaits", 0) >= (1 if case == "wait_user_update_contacts" else 3)})
            if case == "wait_no_notify":
                checks.update({"noNotificationEvenAfterCompletion": not outputs, "realEnvStopEventRan": control.stopped,
                    "notificationPolicyPreserved": all(source["notificationPolicy"] == "forbid" for source in final_state["sources"])})
            else:
                checks["onlyFinalReplyAfterDeadline"] = len(outputs) == 1 and env.time_manager.time() >= original_deadline
            if case == "wait_text_finish_contacts":
                checks["textOnlyPrematureFinishUsedSameGate"] = actor_inputs[0]["responseText"] == "Premature synthetic text completion" and len(outputs) == 1 and "Premature" not in str(outputs[0].content)
            if case == "wait_user_update_contacts":
                checks["ordinaryUserUpdateDidNotCancelMonitor"] = len(final_state["sources"]) == 2 and any(item.get("signal") == "user_update" for item in signals)
    artifacts = [save(report_path.parent / "actor-inputs.json", actor_inputs), save(report_path.parent / "hook-receipts.json", captures),
        save(report_path.parent / "are-completed-events.json", env.event_log.to_dict()), save(report_path.parent / "resolver-invocations.json", resolver_records),
        save(report_path.parent / "fixture-identity.json", {"case": case, "taskText": task_text, "source": "synthetic_user_source_with_independent_trusted_stubs",
            "queryTool": query_tool, "queryArguments": query_arguments, "candidateOffsetSeconds": 95, "durationSeconds": 180, "actorScriptDoesNotRegisterObligations": True})]
    report = {"schemaVersion": "gaia2-runtime-semantics-e2e-fixture-v1", "case": case, "status": "passed" if all(checks.values()) else "failed",
        "syntheticFixtureOnly": True, "benchmarkExecuted": False, "officialSubmissionReady": False, "realModelRequests": 0, "externalAttempts": len(external),
        "actorRequests": len(actor_inputs), "providerPairValidationCount": pair_checks, "nativeDeletes": 0,
        "blockedTools": sum(event["type"] == "tool_call_blocked" for event in runtime_events), "userReplies": len(outputs),
        "nativeWaits": len(waits), "taskSignals": signals, "eventReviews": reviews, "finalTaskState": final_state,
        "originalUserAnchor": anchor, "originalDeadline": original_deadline,
        "environmentLifecycle": {"startedWithPublicAPI": started, "threadObservedAlive": thread_seen, "threadJoined": joined},
        "failure": failure, "checks": checks, "artifacts": artifacts}
    save(report_path, report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--case", choices=CASES, required=True)
    args = parser.parse_args()
    result = (run_wait if args.case in WAIT_CASES else run)(args.report.resolve(), args.case)
    print(json.dumps({"status": result["status"], "case": args.case, "actorRequests": result["actorRequests"], "realModelRequests": 0}))
    raise SystemExit(0 if result["status"] == "passed" else 2)
