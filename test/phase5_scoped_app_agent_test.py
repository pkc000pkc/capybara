"""Offline actual ARE AppAgent loop plus real Apps, with trusted test dispatch.

The fixture callback uses NativeAppBinding and synthetic completed receipts;
it is not a claim of real TS Host execution. The separate Node integration
supplies that actual Host chain. No Scenario, provider or network is used here.
"""

import copy
from datetime import datetime, timezone
import hashlib
import json
import logging
from pathlib import Path
import socket
import sys
import tempfile
from types import MethodType
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import gaia2_a2a_wire as wire
from gaia2_private_native_binding import NativeAppBinding, NativeBindingError
from gaia2_scoped_app_agent import ControlledAppAgentEngine, ScopedAppAgentFatal, build_scoped_app_agent
from are.simulation.agents.agent_log import FinalAnswerLog, ObservationLog, ToolCallLog, TaskLog, LLMInputLog, LLMOutputThoughtActionLog
from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.agents.default_agent.base_agent import BaseAgent, ConditionalStep, RunningState
from are.simulation.agents.default_agent.tools.json_action_executor import JsonActionExecutor
from are.simulation.apps.apartment_listing import Apartment, RentAFlat
from are.simulation.apps.contacts import Contact, Contacts
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.notification_system import Message, MessageType


def action(name, arguments):
    return "Thought: controlled\nAction:\n" + json.dumps({"action": name, "action_input": arguments},
        ensure_ascii=False, separators=(",", ":")) + "<end_action>"


def fixed_failure(*args, **kwargs):
    raise RuntimeError("private callback exception must never enter ErrorLog")


class TrustedFixtureDispatch:
    """Not an Actor API. Root integration replaces this with real TS Host."""

    def __init__(self, owner, scope, root):
        self.owner, self.scope, self.root = owner, scope, root
        self.scope_hash = wire.value_hash(scope)
        self.tools = {tool["publicName"]: tool for tool in owner.manifest()["tools"]}
        self.calls, self.prepared, self.outcomes = [], [], []
        self.before_block = False
        self.after_block = False
        self.after_commit = None
        self.ack_transform = None
        self.receipt_transform = None
        owner.bind_child({"scope": scope})

    def __call__(self, request):
        assert set(request) == {"tool", "arguments"}
        self.calls.append(copy.deepcopy(request))
        if self.before_block:
            raise RuntimeError("private before block")
        tool = self.tools[request["tool"]]
        prepared = self.owner.prepare_native({"scope": self.scope, "toolId": tool["toolId"],
            "rawArguments": request["arguments"]})
        self.prepared.append(prepared)
        dispatch_id = str(uuid.uuid4())
        outcome = self.owner.commit_native({"scope": self.scope, "ticketId": prepared["ticketId"],
            "dispatchId": dispatch_id, "toolId": tool["toolId"],
            "effectiveArgumentsHash": prepared["effectiveArgumentsHash"]})
        self.outcomes.append(outcome)
        if outcome["status"] != "succeeded":
            raise RuntimeError("private native unknown")
        if self.after_commit:
            self.after_commit(outcome)
        if self.after_block:
            raise RuntimeError("private after block")
        final = tool["toolKind"] == "child_final_answer"
        ref = None
        if final:
            receipt = {"schemaVersion": "capybara-runtime-delegation-receipt-v1",
                "environmentGeneration": self.scope["environmentGeneration"],
                "parentExecutionId": self.scope["parentExecutionId"], "parentSessionId": self.scope["parentSessionId"],
                "sequence": 1, "previousHash": None, "kind": "completed",
                "data": {"scope": self.scope, "finalDispatchId": dispatch_id, "finalEvidence": {"fixtureOnly": True}}}
            if self.receipt_transform:
                receipt = self.receipt_transform(receipt)
            data = json.dumps(receipt, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            path = self.root / ("controlled-completed-" + uuid.uuid4().hex + ".json")
            with path.open("xb") as output:
                output.write(data)
            ref = {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}
        ack = {"schemaVersion": "capybara-scoped-agent-dispatch-v1", "scopeHash": self.scope_hash,
            "dispatchId": dispatch_id, "toolId": tool["toolId"], "toolKind": tool["toolKind"],
            "status": "completed", "childCompleted": final, "completionEvidenceRef": ref}
        return self.ack_transform(ack) if self.ack_transform else ack


class SyntheticModelAuthority:
    """Synthetic child receipts only, NOT actual Host/broker/HTTP evidence."""

    def __init__(self, scope, binding, root):
        self.scope, self.binding, self.root = scope, binding, root
        self.scope_hash, self.model_hash = wire.value_hash(scope), wire.value_hash(binding)
        self.requests, self.attempts, self.finishes, self.history = [], [], [], []
        self.logical = self.sdk = 0
        self.last_ack = None
        self.gate_transform = self.receipt_transform = self.sdk_transform = self.finish_transform = None
        self.before_block = self.sdk_block = self.finish_block = False
        self.on_gate = self.on_finish = None

    def project(self, messages, request_id):
        hashes = [wire.value_hash(message) for message in messages]
        count = min(len(self.history), len(messages))
        while count and [entry[0] for entry in self.history[-count:]] != hashes[:count]:
            count -= 1
        ids = [entry[1] for entry in self.history[-count:]] if count else []
        for hashed in hashes[count:]:
            identifier = self.scope["childExecutionId"] + ".model-message-" + str(len(self.history) + 1)
            self.history.append((hashed, identifier))
            ids.append(identifier)
        return [{"role": {"tool-call": "assistant", "tool-response": "tool"}.get(message["role"], message["role"]),
            "content": message["content"], "id": identifier, "requestId": request_id}
            for message, identifier in zip(messages, ids)]

    def gate(self, request):
        assert set(request) == {"requestId", "iteration", "messages", "clock"}
        self.requests.append(copy.deepcopy(request))
        if self.before_block:
            raise RuntimeError("private model before block")
        self.logical += 1
        context = "Synthetic live child context revision " + str(self.logical)
        actual = copy.deepcopy(request["messages"])
        actual.insert(1, {"role": "system", "content": "Live Capybara dynamic context:\n" + context, "attachments": None})
        context_hash = hashlib.sha256(context.encode("utf-8")).hexdigest()
        variables_hash = hashlib.sha256(str(self.logical).encode()).hexdigest()
        receipt = {"schemaVersion": "capybara-runtime-plugin-invocation-v1",
            "executionId": self.scope["childExecutionId"], "sessionId": self.scope["childSessionId"],
            "scenarioId": "synthetic-no-scenario", "sequence": self.logical * 3,
            "input": {"checkpoint": "before_model", "loop": {"runId": self.scope["childExecutionId"],
                "iteration": request["iteration"], "terminal": False},
                "messages": self.project(request["messages"], request["requestId"]), "clock": request["clock"]},
            "decision": {"action": "allow", "reason": "synthetic"}, "context": context,
            "contextHash": context_hash, "variablesHash": variables_hash, "revision": self.logical,
            "hookReceipts": [], "trustedModelAdmission": {"delegationScopeHash": self.scope_hash,
                "modelScope": self.binding, "modelScopeHash": self.model_hash,
                "originalMessagesHash": wire.value_hash(request["messages"])}}
        if self.receipt_transform:
            receipt = self.receipt_transform(receipt)
        data = json.dumps(receipt, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        path = self.root / ("synthetic-before-model-" + uuid.uuid4().hex + ".json")
        with path.open("xb") as output:
            output.write(data)
        ack = {"schemaVersion": "capybara-scoped-model-gate-v1", "permitId": uuid.uuid4().hex,
            "requestId": request["requestId"], "scopeHash": self.scope_hash, "modelScopeHash": self.model_hash,
            "originalMessagesHash": wire.value_hash(request["messages"]), "actualInputHash": wire.value_hash(actual),
            "context": context, "contextHash": context_hash, "variablesHash": variables_hash, "revision": self.logical,
            "beforeEvidenceRef": {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}}
        self.last_ack = copy.deepcopy(ack)
        if self.on_gate:
            self.on_gate()
        return self.gate_transform(ack) if self.gate_transform else ack

    def attempt(self, request):
        assert set(request) == {"permitId", "requestId", "attempt", "actualInputHash"}
        self.attempts.append(copy.deepcopy(request))
        if self.sdk_block:
            raise RuntimeError("private sdk blocked")
        self.sdk += 1
        ack = {"schemaVersion": "capybara-scoped-model-sdk-attempt-v1", **request, "scopeHash": self.scope_hash,
            "modelScopeHash": self.model_hash, "logicalRequestsUsed": self.logical, "sdkAttemptsUsed": self.sdk}
        return self.sdk_transform(ack) if self.sdk_transform else ack

    def finish(self, request):
        assert set(request) == {"permitId", "requestId", "actualInputHash", "outputHash", "usage"}
        self.finishes.append(copy.deepcopy(request))
        if self.finish_block:
            raise RuntimeError("private finish failure")
        ack = {"schemaVersion": "capybara-scoped-model-completion-v1", **request, "scopeHash": self.scope_hash,
            "modelScopeHash": self.model_hash, "status": "completed"}
        if self.on_finish:
            self.on_finish()
        return self.finish_transform(ack) if self.finish_transform else ack


class SyntheticGatedEngine(ControlledAppAgentEngine):
    """No SDK or network. The attempt guard simulates admission reservations."""

    def __init__(self, responses, binding, attempts=(1,)):
        super().__init__(responses)
        self.binding = copy.deepcopy(binding)
        self.planned_attempts = attempts
        self.sdk_calls = self.logical_used = 0
        self.active = None
        self.guard = None
        self.usage = {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5}
        self.sdk_failure = self.skip_guard = False
        self.bad_result = None
        self.last_result = None

    @property
    def model_role(self): return self.binding["modelRole"]
    @property
    def model_scope_hash(self): return wire.value_hash(self.binding)
    @property
    def config_hash(self): return self.binding["configHash"]
    @property
    def max_logical_requests(self): return self.binding["maxLogicalRequests"]
    @property
    def max_sdk_attempts(self): return self.binding["maxSdkAttempts"]

    def snapshot(self):
        return {"schemaVersion": "gaia2-scoped-model-engine-v1", "modelRole": self.model_role,
            "modelScopeHash": self.model_scope_hash, "configHash": self.config_hash,
            "maxLogicalRequests": self.max_logical_requests, "maxSdkAttempts": self.max_sdk_attempts,
            "sourceIdentityHash": "a" * 64}

    def begin_request(self, *, permit_id, request_id, actual_input_hash, before_attempt):
        if self.active is not None:
            raise RuntimeError("synthetic request active")
        if self.guard is not None:
            assert before_attempt is self.guard
        self.guard = before_attempt
        self.active = {"permitId": permit_id, "requestId": request_id, "actualInputHash": actual_input_hash}
        self.logical_used += 1

    def get_last_usage(self): return self.usage

    def chat_completion(self, messages, stop_sequences=(), **kwargs):
        assert wire.value_hash(messages) == self.active["actualInputHash"]
        try:
            count = self.planned_attempts[min(self.logical_used - 1, len(self.planned_attempts) - 1)]
            for attempt in range(1, count + 1):
                if not self.skip_guard:
                    self.guard({**self.active, "attempt": attempt})
                self.sdk_calls += 1
                if self.sdk_failure:
                    raise RuntimeError("private sdk exception")
            result = super().chat_completion(messages, stop_sequences, **kwargs)
            self.last_result = self.bad_result if self.bad_result is not None else result
            return self.last_result
        finally:
            self.active = None


class Tests(unittest.TestCase):
    def setUp(self):
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.old_logging = logging.root.manager.disable
        logging.disable(logging.CRITICAL)
        self.addCleanup(lambda: logging.disable(self.old_logging))
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-scoped-app-agent-")
        self.addCleanup(self.temp.cleanup)
        self.index = 0
        self.owners, self.runners = [], []
        self.addCleanup(lambda: [owner.close() for owner in self.owners])
        self.addCleanup(lambda: [runner.close() for runner in self.runners])

    def fixture(self, app=None, responses=None, budget=10, function_dispatch=False, log_callback=None):
        contact = Contact("Local", "User", contact_id="contact-1", is_user=True)
        app = app or Contacts(contacts={contact.contact_id: contact})
        env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
        env.register_apps([app])
        self.index += 1
        root = Path(self.temp.name) / ("owner-" + str(self.index))
        owner = NativeAppBinding(app, environment_generation="environment-1", parent_execution_id="parent-exec",
            parent_session_id="parent-session", evidence_root=root, clock=env.time_manager.time,
            trusted_source_files=[ROOT / "scripts/gaia2_scoped_app_agent.py", __file__])
        self.owners.append(owner)
        manifest = owner.manifest()
        unique = uuid.uuid4().hex
        task = "controlled raw task 🦫; never leak future message"
        scope = {"parentExecutionId": "parent-exec", "parentSessionId": "parent-session",
            "environmentGeneration": "environment-1", "appId": app.name,
            "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
            "toolInventoryHash": manifest["toolInventoryHash"], "taskHash": hashlib.sha256(task.encode("utf-8")).hexdigest(),
            "parentActionId": "parent-" + unique, "requestId": str(uuid.uuid4()),
            "childExecutionId": "child-exec-" + unique, "childSessionId": "child-session-" + unique,
            "task": task, "deadline": 1, "maxNativeActions": budget}
        dispatcher = TrustedFixtureDispatch(owner, scope, root)
        engine = ControlledAppAgentEngine(responses or [action("final_answer", {"answer": "completed"})])
        def trusted_closure(request):
            return dispatcher(request)
        runner = build_scoped_app_agent(app=app, owner=owner, env=env, scope=scope, llm_engine=engine,
            dispatch=trusted_closure if function_dispatch else dispatcher)
        self.runners.append(runner)
        return runner, owner, app, env, scope, engine, dispatcher

    def model_fixture(self, responses=None, budget=10, logical=10, sdk=20, attempts=(1,), log_callback=None):
        old, owner, app, env, scope, _, dispatch = self.fixture(budget=budget)
        binding = {"schemaVersion": "capybara-scoped-model-scope-v1", "delegationScopeHash": wire.value_hash(scope),
            "modelRole": "child_actor", "configHash": "c" * 64, "maxLogicalRequests": logical, "maxSdkAttempts": sdk}
        engine = SyntheticGatedEngine(responses or [action("final_answer", {"answer": "gated completed"})], binding, attempts)
        authority = SyntheticModelAuthority(scope, binding, dispatch.root)
        runner = build_scoped_app_agent(app=app, owner=owner, env=env, scope=scope, llm_engine=engine,
            dispatch=dispatch, model_binding=binding, model_gate=authority.gate,
            model_attempt=authority.attempt, model_finish=authority.finish, log_callback=log_callback)
        self.runners.append(runner)
        return runner, owner, app, env, scope, engine, dispatch, authority

    def failed(self, runner):
        with self.assertRaises(ScopedAppAgentFatal) as caught:
            runner.run()
        self.assertTrue(str(caught.exception).startswith("SCOPED_AGENT_"))
        self.assertFalse(runner.snapshot()["completed"])
        self.assertTrue(runner.snapshot()["failed"])
        self.assertNotIn("private", str(caught.exception))

    def test_01_actual_official_instances_parser_loop_logger_and_wrapped_input(self):
        runner, owner, app, env, scope, engine, dispatch = self.fixture(responses=[
            action("Contacts__get_current_user_details", {}), action("final_answer", {"answer": "completed"})])
        self.assertIs(type(runner.app_agent), AppAgent)
        self.assertIs(type(runner.base_agent), BaseAgent)
        self.assertIs(type(runner.executor), JsonActionExecutor)
        self.assertIs(runner.app_agent.app_agent, runner.base_agent)
        self.assertIs(runner.base_agent.action_executor, runner.executor)
        self.assertEqual(runner.run(), "completed")
        logs = runner.base_agent.get_agent_logs()
        for kind in ("system_prompt", "task", "step", "llm_input", "llm_output", "thought", "rationale", "tool_call", "observation", "final_answer"):
            self.assertIn(kind, [log.get_type() for log in logs])
        self.assertEqual(runner.base_agent.iterations, 2)
        self.assertEqual(len(env.event_log), 1)
        self.assertEqual(len(dispatch.calls), 2)
        self.assertIs(owner.take_native_result(dispatch.outcomes[0]["dispatchId"]), app.contacts["contact-1"])
        observed = next(log.content for log in logs if isinstance(log, ObservationLog))
        self.assertEqual(observed, str(app.contacts["contact-1"]).strip())
        self.assertNotIn('"nativeType"', observed)
        self.assertIn(observed, engine.received_messages[1][-1]["content"])
        snapshot = runner.snapshot()
        task = next(log for log in logs if isinstance(log, TaskLog))
        self.assertEqual(snapshot["originalTaskHash"], hashlib.sha256(scope["task"].encode("utf-8")).hexdigest())
        self.assertEqual(snapshot["wrappedTaskHash"], hashlib.sha256(task.content.encode("utf-8")).hexdigest())
        self.assertNotEqual(snapshot["wrappedTaskHash"], snapshot["originalTaskHash"])
        self.assertEqual(snapshot["actorInputHashes"], engine.input_hashes)
        self.assertEqual(snapshot["originalObservationsTaken"], 2)
        self.assertEqual([item["childCompleted"] for item in snapshot["actions"]], [False, True])
        self.assertEqual(snapshot["modelCalls"], 2)
        self.assertTrue(snapshot["appClockShared"] and snapshot["agentClockShared"])
        self.assertFalse(snapshot["notificationSystemAttached"] or snapshot["wrapperRegisteredInEnvironment"])
        serialized = json.dumps(snapshot, ensure_ascii=False)
        self.assertNotIn(scope["task"], serialized)
        self.assertNotIn("Thought:", serialized)
        for ref in snapshot["sourceRefs"]:
            source = Path(ref["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(source).hexdigest(), ref["sha256"])
            self.assertEqual(len(source), ref["bytes"])

    def test_02_real_contacts_raw_two_defaults_thirteen_single_invocation(self):
        runner, owner, app, env, _, _, dispatch = self.fixture(app=Contacts(), responses=[
            action("Contacts__add_new_contact", {"first_name": "Fixture", "last_name": "Local"}),
            action("final_answer", {"answer": "added"})])
        self.assertEqual(runner.run(), "added")
        self.assertEqual(len(dispatch.calls[0]["arguments"]), 2)
        self.assertEqual(len(dispatch.prepared[0]["effectiveArguments"]), 13)
        self.assertNotEqual(dispatch.prepared[0]["rawArgumentsHash"], dispatch.prepared[0]["effectiveArgumentsHash"])
        self.assertEqual(len(app.contacts), 1)
        self.assertEqual(len(env.event_log), 1)
        self.assertEqual(env.event_log.list_view()[0].action.app, app)

    def test_03_formatter_none_to_string_original_observation_and_body_once(self):
        apartment = Apartment("Fixture", "Local", "00001", 1200., 1, 1, "Apartment", 500, apartment_id="apt-1")
        runner, owner, app, env, _, engine, dispatch = self.fixture(app=RentAFlat(apartments={"apt-1": apartment}), responses=[
            action("RentAFlat__save_apartment", {"apartment_id": "apt-1"}), action("final_answer", {"answer": "saved"})])
        self.assertEqual(runner.run(), "saved")
        self.assertEqual(app.saved_apartments, ["apt-1"])
        self.assertEqual(len(env.event_log), 1)
        self.assertIn("Successfully saved apartment", engine.received_messages[1][-1]["content"])
        self.assertNotEqual(dispatch.outcomes[0]["nativeRawResultHash"], dispatch.outcomes[0]["agentObservationHash"])
        self.assertIsNone(owner.take_native_result(dispatch.outcomes[0]["dispatchId"]))

    def test_04_final_without_native_ce_requires_completed_receipt(self):
        runner, _, _, env, _, _, dispatch = self.fixture()
        self.assertEqual(runner.run(), "completed")
        self.assertEqual(len(env.event_log), 0)
        self.assertIsNone(dispatch.outcomes[0]["nativeCompletedEventRef"])
        self.assertTrue(runner.snapshot()["completed"])
        self.assertEqual(len([log for log in runner.base_agent.logs if isinstance(log, FinalAnswerLog)]), 1)

    def test_05_tool_call_final_log_is_not_completion_and_before_block_zero_native(self):
        runner, _, _, env, _, _, dispatch = self.fixture()
        dispatch.before_block = True
        self.failed(runner)
        self.assertEqual(len(env.event_log), 0)
        self.assertEqual(len(dispatch.outcomes), 0)
        self.assertEqual(runner.snapshot()["originalObservationsTaken"], 0)
        self.assertTrue(any(isinstance(log, ToolCallLog) and log.tool_name == "final_answer" for log in runner.base_agent.logs))
        self.assertFalse(any(isinstance(log, FinalAnswerLog) for log in runner.base_agent.logs))
        self.assertIs(runner.base_agent.custom_state["running_state"], RunningState.FAILED)

    def test_06_after_block_never_consume_native_observation_or_reenter_model(self):
        runner, _, _, env, _, engine, dispatch = self.fixture(responses=[
            action("Contacts__get_contact", {"contact_id": "contact-1"}), action("final_answer", {"answer": "wrong"})])
        dispatch.after_block = True
        self.failed(runner)
        self.assertEqual(len(env.event_log), 1)
        self.assertEqual(engine.calls, 1)
        self.assertEqual(runner.snapshot()["originalObservationsTaken"], 0)
        self.assertFalse(any(isinstance(log, ObservationLog) for log in runner.base_agent.logs))

    def test_07_final_after_block_tool_log_cannot_fake_complete(self):
        runner, _, _, env, _, _, dispatch = self.fixture()
        dispatch.after_block = True
        self.failed(runner)
        self.assertEqual(len(env.event_log), 0)
        self.assertFalse(any(isinstance(log, FinalAnswerLog) for log in runner.base_agent.logs))

    def test_08_unknown_partial_write_sticky_across_child_read_cannot_clear(self):
        runner, owner, app, env, scope, engine, dispatch = self.fixture(responses=[
            action("Contacts__edit_contact", {"contact_id": "contact-1", "updates": {"first_name": "Changed", "invalid_field": "x"}}),
            action("final_answer", {"answer": "wrong"})])
        self.failed(runner)
        self.assertEqual(app.contacts["contact-1"].first_name, "Changed")
        self.assertEqual(dispatch.outcomes[0]["status"], "unknown")
        self.assertEqual(engine.calls, 1)
        new_scope = {**scope, "parentActionId": "new-parent-action", "requestId": str(uuid.uuid4()),
            "childExecutionId": "new-child-exec", "childSessionId": "new-child-session"}
        owner.bind_child({"scope": new_scope})
        tools = {tool["publicName"]: tool for tool in owner.manifest()["tools"]}
        read = owner.prepare_native({"scope": new_scope, "toolId": tools["Contacts__get_contact"]["toolId"],
            "rawArguments": {"contact_id": "contact-1"}})
        observed = owner.commit_native({"scope": new_scope, "ticketId": read["ticketId"], "dispatchId": str(uuid.uuid4()),
            "toolId": read["toolId"], "effectiveArgumentsHash": read["effectiveArgumentsHash"]})
        self.assertEqual(observed["status"], "succeeded")
        for name, args in (("Contacts__edit_contact", {"contact_id": "contact-1", "updates": {"first_name": "Old"}}),
                ("final_answer", {"answer": "wrong"})):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
                owner.prepare_native({"scope": new_scope, "toolId": tools[name]["toolId"], "rawArguments": args})
        self.assertEqual(len(env.event_log), 2)

    def test_09_ack_scope_extra_observation_kind_status_uuid_and_completion_shape(self):
        changes = [("scopeHash", "0" * 64), ("agentObservation", "forged"), ("toolKind", "child_final_answer"),
            ("toolId", "final_answer"), ("status", "succeeded"), ("dispatchId", "not-a-uuid"),
            ("childCompleted", True), ("completionEvidenceRef", {"path": "wrong", "sha256": "0" * 64})]
        for field, wrong in changes:
            with self.subTest(field=field):
                runner, _, _, env, _, engine, dispatch = self.fixture(responses=[action("Contacts__get_contact", {"contact_id": "contact-1"})])
                dispatch.ack_transform = lambda ack, field=field, wrong=wrong: {**ack, field: wrong}
                self.failed(runner)
                self.assertEqual(len(env.event_log), 1)
                self.assertEqual(engine.calls, 1)
                self.assertEqual(runner.snapshot()["originalObservationsTaken"], 0)

    def test_10_final_false_missing_ref_or_nonstring_observation_failclosed(self):
        for transform in (lambda ack: {**ack, "childCompleted": False},
                lambda ack: {**ack, "completionEvidenceRef": None},
                lambda ack: {**ack, "completionEvidenceRef": {"path": ack["completionEvidenceRef"]["path"], "sha256": "0" * 64}}):
            with self.subTest(transform=transform):
                runner, _, _, env, _, _, dispatch = self.fixture()
                dispatch.ack_transform = transform
                self.failed(runner)
                self.assertEqual(runner.snapshot()["originalObservationsTaken"], 0)
                self.assertEqual(len(env.event_log), 0)

    def test_11_completion_receipt_scope_parent_dispatch_kind_schema_bindings(self):
        for key, wrong in (("schemaVersion", "forged"), ("kind", "pending"), ("environmentGeneration", "other"),
                ("parentExecutionId", "other"), ("parentSessionId", "other"), ("scope", {"forged": True}),
                ("finalDispatchId", str(uuid.uuid4()))):
            with self.subTest(key=key):
                runner, _, _, _, _, _, dispatch = self.fixture()
                def alter(receipt, key=key, wrong=wrong):
                    receipt = copy.deepcopy(receipt)
                    if key in ("scope", "finalDispatchId"):
                        receipt["data"][key] = wrong
                    else:
                        receipt[key] = wrong
                    return receipt
                dispatch.receipt_transform = alter
                self.failed(runner)
                self.assertEqual(runner.snapshot()["originalObservationsTaken"], 0)

    def test_12_duplicate_dispatch_id_rejected_before_observation_getter(self):
        runner, _, _, env, _, _, dispatch = self.fixture(responses=[
            action("Contacts__get_contact", {"contact_id": "contact-1"}),
            action("Contacts__get_current_user_details", {}), action("final_answer", {"answer": "wrong"})])
        ids = []
        def reuse(ack):
            if not ids:
                ids.append(ack["dispatchId"])
                return ack
            return {**ack, "dispatchId": ids[0]}
        dispatch.ack_transform = reuse
        self.failed(runner)
        self.assertEqual(len(env.event_log), 2)
        self.assertEqual(runner.snapshot()["originalObservationsTaken"], 1)

    def test_13_mock_and_nested_expert_no_bypass_zero_dispatch(self):
        for name in ("_mock", "Contacts__expert_agent", "AppAgent__expert_agent", "Contacts__missing"):
            with self.subTest(name=name):
                runner, _, _, env, _, _, dispatch = self.fixture(responses=[action(name, {"task": "forged"})])
                self.failed(runner)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_14_final_string_only_arguments_dictionary_only_zero_dispatch(self):
        for args in ({"answer": {"done": True}}, {"answer": 1}, {"answer": "yes", "extra": True}, "direct string"):
            with self.subTest(args=args):
                runner, _, _, env, _, _, dispatch = self.fixture(responses=[action("final_answer", args)])
                self.failed(runner)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_15_response_exhaustion_no_provider_fallback(self):
        runner, _, _, env, _, engine, dispatch = self.fixture(responses=[action("Contacts__get_current_user_details", {})])
        self.failed(runner)
        self.assertEqual(engine.calls, 2)
        self.assertEqual(len(dispatch.calls), 1)
        self.assertEqual(len(env.event_log), 1)
        self.assertIs(runner.base_agent.custom_state["running_state"], RunningState.FAILED)

    def test_16_budget_limit_not_completion_no_auto_final_dispatch(self):
        runner, _, _, env, _, engine, dispatch = self.fixture(budget=1, responses=[
            action("Contacts__get_current_user_details", {}), action("final_answer", {"answer": "wrong"})])
        self.failed(runner)
        self.assertEqual(runner.snapshot()["failureCode"], "SCOPED_AGENT_BUDGET_EXHAUSTED")
        self.assertEqual(engine.calls, 1)
        self.assertEqual(len(env.event_log), 1)
        self.assertEqual(len(dispatch.calls), 1)
        self.assertFalse(any(isinstance(log, FinalAnswerLog) for log in runner.base_agent.logs))

    def test_17_future_user_stop_parent_queue_and_original_app_clock_untouched(self):
        runner, _, app, env, _, engine, _ = self.fixture()
        queue = env.notification_system.message_queue
        now = env.time_manager.time()
        future = Message(MessageType.USER_MESSAGE, "hidden future USER", datetime.fromtimestamp(now + 100, timezone.utc))
        stop = Message(MessageType.ENVIRONMENT_STOP, "hidden future STOP", datetime.fromtimestamp(now + 101, timezone.utc))
        queue.put(future)
        queue.put(stop)
        original = tuple(queue.list_view())
        self.assertEqual(runner.run(), "completed")
        self.assertIs(env.notification_system.message_queue, queue)
        self.assertEqual(tuple(queue.list_view()), original)
        self.assertTrue(all(before is after for before, after in zip(original, queue.list_view())))
        self.assertIs(app.time_manager, env.time_manager)
        self.assertIs(runner.app_agent.time_manager, env.time_manager)
        self.assertIs(runner.base_agent.time_manager, env.time_manager)
        # SETUP owns an actual running clock. It is shared, not frozen, and no
        # artificial generation-time offset is added by this controlled slice.
        self.assertGreaterEqual(env.time_manager.time(), now)
        self.assertIsNone(runner.base_agent.notification_system)
        self.assertNotIn("hidden future", json.dumps(engine.received_messages))
        self.assertTrue(all(now <= log.timestamp <= env.time_manager.time() for log in runner.base_agent.logs))

    def test_18_run_reuse_no_reset_start_logs_or_scope_input(self):
        runner, _, _, _, _, engine, dispatch = self.fixture()
        self.assertEqual(runner.run(), "completed")
        with self.assertRaisesRegex(ScopedAppAgentFatal, "SCOPED_AGENT_RUN_REUSED"):
            runner.run()
        for kwargs in ({"reset": True}, {"start_logs": []}, {"task": "replacement"}, {"scope": {}}):
            with self.subTest(kwargs=kwargs), self.assertRaises(TypeError):
                runner.run(**kwargs)
        self.assertEqual(engine.calls, 1)
        self.assertEqual(len(dispatch.calls), 1)

    def test_19_actual_loop_and_executor_pointers_frozen_zero_native_sticky(self):
        for target in ("app_agent_pointer", "executor_pointer"):
            with self.subTest(target=target):
                runner, _, _, env, _, engine, dispatch = self.fixture()
                if target == "app_agent_pointer":
                    original = runner.app_agent.app_agent
                    runner.app_agent.app_agent = object()
                else:
                    original = runner.base_agent.action_executor
                    runner.base_agent.action_executor = object()
                self.failed(runner)
                if target == "app_agent_pointer":
                    runner.app_agent.app_agent = original
                else:
                    runner.base_agent.action_executor = original
                with self.assertRaisesRegex(ScopedAppAgentFatal, "SCOPED_AGENT_RUN_REUSED"):
                    runner.run()
                self.assertEqual(engine.calls, 0)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_20_instance_override_on_actual_run_step_loop_expert_and_parser_frozen(self):
        for object_name, method in (("base_agent", "run"), ("base_agent", "step"), ("base_agent", "execute_agent_loop"),
                ("base_agent", "initialize"), ("base_agent", "append_agent_log"), ("app_agent", "expert_agent"),
                ("executor", "parse_action"), ("executor", "execute_parsed_action")):
            with self.subTest(object_name=object_name, method=method):
                runner, _, _, env, _, engine, dispatch = self.fixture()
                setattr(getattr(runner, object_name), method, MethodType(fixed_failure, getattr(runner, object_name)))
                self.failed(runner)
                self.assertEqual(engine.calls, 0)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_21_pre_post_logger_and_model_override_frozen_zero_native(self):
        for change in ("pre", "post", "log", "model"):
            with self.subTest(change=change):
                runner, _, _, env, _, engine, dispatch = self.fixture()
                if change == "pre":
                    runner.base_agent.conditional_pre_steps.append(ConditionalStep(condition=None, function=fixed_failure, name="forged"))
                elif change == "post":
                    runner.base_agent.conditional_post_steps.append(ConditionalStep(condition=None, function=fixed_failure, name="forged"))
                elif change == "log":
                    runner.base_agent.log_callback = fixed_failure
                else:
                    engine.chat_completion = fixed_failure
                self.failed(runner)
                self.assertEqual(engine.calls, 0)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_22_source_default_drift_before_run_zero_native(self):
        runner, _, app, env, _, engine, dispatch = self.fixture(responses=[
            action("Contacts__get_current_user_details", {})])
        native = next(tool for tool in app.get_tools() if tool.func_name == "get_current_user_details")
        native._public_name = "forged"
        self.failed(runner)
        self.assertEqual(engine.calls, 0)
        self.assertEqual(len(dispatch.calls), 0)
        self.assertEqual(len(env.event_log), 0)

    def test_23_close_or_disconnect_before_after_ack_retrieval_never_success(self):
        runner, _, _, env, _, engine, dispatch = self.fixture()
        runner.close()
        self.failed(runner)
        self.assertEqual(engine.calls, 0)
        self.assertEqual(len(dispatch.calls), 0)
        self.assertEqual(len(env.event_log), 0)
        for close_which in ("runner", "owner"):
            with self.subTest(close_which=close_which):
                runner, owner, _, env, _, _, dispatch = self.fixture()
                dispatch.after_commit = lambda outcome, runner=runner, owner=owner: runner.close() if close_which == "runner" else owner.close()
                self.failed(runner)
                self.assertEqual(runner.snapshot()["originalObservationsTaken"], 0)
                self.assertEqual(len(env.event_log), 0)

    def test_24_observation_getter_failure_after_complete_is_technical_failure(self):
        runner, owner, _, env, _, _, dispatch = self.fixture()
        def wrong_result_identity(ack):
            dispatch_id = str(uuid.uuid4())
            original = json.loads(Path(ack["completionEvidenceRef"]["path"]).read_bytes())
            original["data"]["finalDispatchId"] = dispatch_id
            data = json.dumps(original, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            path = dispatch.root / ("controlled-completed-" + uuid.uuid4().hex + ".json")
            with path.open("xb") as output:
                output.write(data)
            return {**ack, "dispatchId": dispatch_id,
                "completionEvidenceRef": {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}}
        # The actual getter, not a wire observation or replacement mock, rejects
        # an otherwise matched completion/ACK whose original result is absent.
        dispatch.ack_transform = wrong_result_identity
        self.failed(runner)
        self.assertEqual(len(dispatch.outcomes), 1)
        self.assertEqual(len(env.event_log), 0)
        self.assertEqual(runner.snapshot()["originalObservationsTaken"], 0)
        self.assertFalse(any(isinstance(log, FinalAnswerLog) for log in runner.base_agent.logs))

    def test_25_logging_failure_after_completed_receipt_cannot_be_success(self):
        for failing_type in (ObservationLog, FinalAnswerLog):
            with self.subTest(failing_type=failing_type):
                runner, _, _, _, _, _, dispatch = self.fixture()
                original = runner.base_agent.log_callback
                failed = []
                def logger(log):
                    if isinstance(log, failing_type):
                        failed.append(True)
                        raise RuntimeError("private official logger error")
                    return original(log)
                # This controlled test installs a trusted logger before
                # freezing, to test the real loop's ordinary-exception path.
                runner.base_agent.log_callback = logger
                runner._ScopedAppAgentRunner__instance_snapshot = runner._ScopedAppAgentRunner__snapshot_instances()
                self.failed(runner)
                self.assertTrue(failed)
                self.assertEqual(len(dispatch.outcomes), 1)
                self.assertEqual(runner.snapshot()["originalObservationsTaken"], 1)
                self.assertEqual(runner.snapshot()["failureCode"], "SCOPED_AGENT_ACTION_FAILED")
                self.assertIs(runner.base_agent.custom_state["running_state"], RunningState.FAILED)

    def test_26_malformed_response_budget_not_completion_no_dispatch(self):
        runner, _, _, env, _, engine, dispatch = self.fixture(budget=1, responses=["Thought: controlled without action"])
        self.failed(runner)
        self.assertEqual(engine.calls, 1)
        self.assertEqual(len(dispatch.calls), 0)
        self.assertEqual(len(env.event_log), 0)

    def test_27_scope_hash_binding_and_response_input_invalid_failclosed(self):
        runner, owner, app, env, scope, engine, dispatch = self.fixture()
        for key, wrong in (("taskHash", wire.value_hash(scope["task"])), ("parentCanonicalName", "Contacts__expert_agent"),
                ("maxNativeActions", True), ("toolInventoryHash", "0" * 64)):
            with self.subTest(key=key), self.assertRaises(ScopedAppAgentFatal):
                build_scoped_app_agent(app=app, owner=owner, env=env, scope={**scope, key: wrong}, llm_engine=engine, dispatch=dispatch)
        for responses in ([], "not-a-sequence", [object()], ["bad\ud800"]):
            with self.subTest(responses=repr(responses)), self.assertRaises(ScopedAppAgentFatal):
                ControlledAppAgentEngine(responses)

    def test_28_nonfinal_observation_logger_failure_stops_after_single_write(self):
        runner, _, app, env, _, engine, dispatch = self.fixture(app=Contacts(), responses=[
            action("Contacts__add_new_contact", {"first_name": "Fixture", "last_name": "Local"}),
            action("Contacts__add_new_contact", {"first_name": "Fixture", "last_name": "Local"}),
            action("final_answer", {"answer": "wrong"})])
        original = runner.base_agent.log_callback
        def logger(log):
            if isinstance(log, ObservationLog):
                raise RuntimeError("private observed write logging failure")
            return original(log)
        runner.base_agent.log_callback = logger
        runner._ScopedAppAgentRunner__instance_snapshot = runner._ScopedAppAgentRunner__snapshot_instances()
        self.failed(runner)
        self.assertEqual(len(app.contacts), 1)
        self.assertEqual(len(env.event_log), 1)
        self.assertEqual(len(dispatch.calls), 1)
        self.assertEqual(engine.calls, 1)
        self.assertEqual(runner.snapshot()["originalObservationsTaken"], 1)
        self.assertIs(runner.base_agent.custom_state["running_state"], RunningState.FAILED)

    def test_29_final_whitespace_original_return_not_erased(self):
        answer = "\n completed 🦫 \n"
        runner, _, _, env, _, _, _ = self.fixture(responses=[action("final_answer", {"answer": answer})])
        self.assertEqual(runner.run(), answer)
        self.assertEqual(len(env.event_log), 0)
        self.assertEqual(next(log.content for log in runner.base_agent.logs if isinstance(log, ObservationLog)), answer.strip())
        self.assertEqual(next(log.content for log in runner.base_agent.logs if isinstance(log, FinalAnswerLog)), answer)

    def test_30_empty_string_final_uses_original_official_no_observation_log(self):
        runner, _, _, env, _, _, _ = self.fixture(responses=[action("final_answer", {"answer": ""})])
        self.assertEqual(runner.run(), "")
        self.assertEqual(len(env.event_log), 0)
        self.assertEqual(next(log.content for log in runner.base_agent.logs if isinstance(log, ObservationLog)), "No observation")
        self.assertEqual(next(log.content for log in runner.base_agent.logs if isinstance(log, FinalAnswerLog)), "")

    def test_31_dispatch_and_original_getter_identity_frozen_before_native(self):
        for target in ("dispatch", "getter", "manifest"):
            with self.subTest(target=target):
                runner, owner, _, env, _, engine, dispatch = self.fixture()
                if target == "dispatch":
                    runner._ScopedAppAgentRunner__dispatch = fixed_failure
                elif target == "getter":
                    owner.take_agent_observation = fixed_failure
                else:
                    owner.manifest = fixed_failure
                self.failed(runner)
                self.assertEqual(engine.calls, 0)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_32_trusted_function_closure_dispatch_identity_is_stable(self):
        runner, _, _, env, _, _, dispatch = self.fixture(function_dispatch=True)
        self.assertEqual(runner.run(), "completed")
        self.assertEqual(len(dispatch.calls), 1)
        self.assertEqual(len(env.event_log), 0)

    def test_33_gated_child_context_is_in_engine_not_forged_into_original_are_input_log(self):
        runner, _, _, env, _, engine, dispatch, authority = self.model_fixture(responses=[
            action("Contacts__get_contact", {"contact_id": "contact-1"}),
            action("final_answer", {"answer": "gated completed"})])
        self.assertEqual(runner.run(), "gated completed")
        snapshot = runner.snapshot()
        self.assertTrue(snapshot["modelGateEnabled"])
        self.assertEqual(snapshot["modelScopeHash"], engine.model_scope_hash)
        self.assertEqual(snapshot["modelCalls"], 2)
        self.assertEqual(snapshot["engineCalls"], 2)
        self.assertEqual(snapshot["sdkAttemptsUsed"], 2)
        original = [log.content for log in runner.base_agent.logs if isinstance(log, LLMInputLog)]
        self.assertEqual(len(original), 2)
        for index, (before, actual) in enumerate(zip(original, engine.received_messages)):
            # Original ARE roles are str Enum values; the fixed normalization
            # preserves their text and attachments, not the injected context.
            normalized = [{"role": value["role"].value if hasattr(value["role"], "value") else value["role"],
                "content": value["content"], "attachments": None} for value in before]
            self.assertEqual(wire.value_hash(normalized), snapshot["originalAreInputHashes"][index])
            self.assertEqual(wire.value_hash(actual), snapshot["actorInputHashes"][index])
            self.assertNotEqual(snapshot["originalAreInputHashes"][index], snapshot["actorInputHashes"][index])
            self.assertEqual(actual[1]["role"], "system")
            self.assertEqual(actual[1]["content"], "Live Capybara dynamic context:\nSynthetic live child context revision " + str(index + 1))
            self.assertNotIn("Synthetic live child context", json.dumps(before))
        self.assertEqual(len(authority.requests), 2)
        self.assertEqual([request["iteration"] for request in authority.requests], [0, 1])
        self.assertEqual([request["clock"]["revision"] for request in authority.requests], [0, 1])
        self.assertEqual(len(authority.finishes), 2)
        self.assertEqual(authority.finishes[-1]["outputHash"], hashlib.sha256(engine.last_result[0].encode()).hexdigest())
        self.assertEqual(authority.finishes[-1]["usage"], {"inputTokens": 3, "outputTokens": 2, "totalTokens": 5})
        self.assertEqual(len(env.event_log), 1)
        self.assertEqual(len(dispatch.calls), 2)

    def test_34_native_and_logical_request_limits_are_independent(self):
        runner, _, _, env, _, engine, dispatch, authority = self.model_fixture(budget=1, logical=3, responses=[
            action("Contacts__get_contact", {"contact_id": "contact-1"}),
            action("final_answer", {"answer": "wrong"})])
        self.assertEqual(runner.base_agent.max_iterations, 3)
        self.assertEqual(runner.base_agent.total_iterations, 3)
        self.failed(runner)
        self.assertEqual(engine.calls, 2)
        self.assertEqual(len(authority.requests), 2)
        self.assertEqual(len(authority.finishes), 2)
        self.assertEqual(len(env.event_log), 1)
        self.assertEqual(len(dispatch.outcomes), 1)

    def test_35_single_logical_request_two_sdk_reservations_only_one_native_final(self):
        runner, _, _, env, _, engine, dispatch, authority = self.model_fixture(logical=1, sdk=2, attempts=(2,))
        self.assertEqual(runner.run(), "gated completed")
        self.assertEqual(len(authority.requests), 1)
        self.assertEqual([item["attempt"] for item in authority.attempts], [1, 2])
        self.assertEqual(engine.sdk_calls, 2)
        self.assertEqual(engine.calls, 1)
        self.assertEqual(len(dispatch.calls), 1)
        self.assertEqual(len(env.event_log), 0)
        self.assertEqual(runner.snapshot()["sdkAttemptsUsed"], 2)
        self.assertEqual(len(runner.snapshot()["modelRequests"][0]["sdkAttempts"]), 2)

    def test_36_sdk_budget_failure_does_not_execute_native_or_finish_model(self):
        runner, _, _, env, _, engine, dispatch, authority = self.model_fixture(logical=2, sdk=1, attempts=(2,))
        self.failed(runner)
        self.assertEqual(engine.sdk_calls, 1)
        self.assertEqual(len(authority.attempts), 1)
        self.assertEqual(len(authority.finishes), 0)
        self.assertEqual(len(dispatch.calls), 0)
        self.assertEqual(len(env.event_log), 0)

    def test_37_model_before_block_zero_engine_and_zero_native(self):
        runner, _, _, env, _, engine, dispatch, authority = self.model_fixture()
        authority.before_block = True
        self.failed(runner)
        self.assertEqual(engine.calls, 0)
        self.assertEqual(engine.sdk_calls, 0)
        self.assertEqual(runner.snapshot()["actorInputHashes"], [])
        self.assertEqual(len(dispatch.calls), 0)
        self.assertEqual(len(env.event_log), 0)

    def test_38_gate_exact_ack_and_hash_mismatches_fail_before_sdk(self):
        changes = [("scopeHash", "0" * 64), ("modelScopeHash", "0" * 64), ("requestId", "0" * 32),
            ("permitId", "not-id"), ("originalMessagesHash", "0" * 64), ("actualInputHash", "0" * 64),
            ("contextHash", "0" * 64), ("variablesHash", "unknown"), ("revision", True),
            ("agentObservation", "forged"), ("beforeEvidenceRef", None)]
        for key, value in changes:
            with self.subTest(key=key):
                runner, _, _, env, _, engine, dispatch, authority = self.model_fixture()
                authority.gate_transform = lambda ack, key=key, value=value: {**ack, key: value}
                self.failed(runner)
                self.assertEqual(engine.calls, 0)
                self.assertEqual(engine.sdk_calls, 0)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_39_receipt_is_child_scope_model_admission_input_and_allow_bound(self):
        changes = ["execution", "session", "scope", "model_scope", "original_hash", "iteration", "role", "clock", "id", "decision", "hook", "sequence"]
        for change in changes:
            with self.subTest(change=change):
                runner, _, _, env, scope, engine, dispatch, authority = self.model_fixture()
                def alter(receipt):
                    if change == "execution": receipt["executionId"] = scope["parentExecutionId"]
                    elif change == "session": receipt["sessionId"] = scope["parentSessionId"]
                    elif change == "scope": receipt["trustedModelAdmission"]["delegationScopeHash"] = "0" * 64
                    elif change == "model_scope": receipt["trustedModelAdmission"]["modelScope"]["modelRole"] = "judge"
                    elif change == "original_hash": receipt["trustedModelAdmission"]["originalMessagesHash"] = "0" * 64
                    elif change == "iteration": receipt["input"]["loop"]["iteration"] += 1
                    elif change == "role": receipt["input"]["messages"][0]["role"] = "user"
                    elif change == "clock": receipt["input"]["clock"]["now"] += 1
                    elif change == "id": receipt["input"]["messages"][0]["id"] = "forged"
                    elif change == "decision": receipt["decision"]["action"] = "block"
                    elif change == "hook": receipt["hookReceipts"] = [{"status": "failed"}]
                    elif change == "sequence": receipt["sequence"] = 0
                    return receipt
                authority.receipt_transform = alter
                self.failed(runner)
                self.assertEqual(engine.sdk_calls, 0)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_40_sdk_ack_block_mismatch_and_request_counts_fail_before_body(self):
        changes = [None, ("actualInputHash", "0" * 64), ("attempt", 2), ("permitId", "0" * 32),
            ("scopeHash", "0" * 64), ("modelScopeHash", "0" * 64), ("logicalRequestsUsed", 2),
            ("sdkAttemptsUsed", 2), ("extra", True)]
        for change in changes:
            with self.subTest(change=change):
                runner, _, _, env, _, engine, dispatch, authority = self.model_fixture()
                if change is None: authority.sdk_block = True
                else: authority.sdk_transform = lambda ack, change=change: {**ack, change[0]: change[1]}
                self.failed(runner)
                self.assertEqual(engine.sdk_calls, 0)
                self.assertEqual(len(authority.finishes), 0)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_41_model_finish_failure_never_delivers_output_to_official_parser(self):
        for change in (None, ("outputHash", "0" * 64), ("status", "failed"), ("usage", None), ("extra", True)):
            with self.subTest(change=change):
                runner, _, _, env, _, engine, dispatch, authority = self.model_fixture()
                if change is None: authority.finish_block = True
                else: authority.finish_transform = lambda ack, change=change: {**ack, change[0]: change[1]}
                self.failed(runner)
                self.assertEqual(engine.sdk_calls, 1)
                self.assertEqual(len(authority.finishes), 1)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)
                self.assertFalse(any(isinstance(log, ToolCallLog) for log in runner.base_agent.logs))

    def test_42_missing_sdk_guard_output_type_and_usage_fail_closed(self):
        for change in ("skip_guard", "bad_result", "usage_bool", "usage_unknown", "usage_nonfinite", "sdk_failure"):
            with self.subTest(change=change):
                runner, _, _, env, _, engine, dispatch, authority = self.model_fixture()
                if change == "skip_guard": engine.skip_guard = True
                elif change == "bad_result": engine.bad_result = ({"answer": "forged"}, {})
                elif change == "usage_bool": engine.usage = {"inputTokens": True}
                elif change == "usage_unknown": engine.usage = {"cost": "private"}
                elif change == "usage_nonfinite": engine.usage = {"totalTokens": float("nan")}
                else: engine.sdk_failure = True
                self.failed(runner)
                self.assertEqual(len(authority.finishes), 0)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_43_source_callback_broker_configuration_drift_zero_gate_sdk_native(self):
        for target in ("gate", "attempt", "finish", "begin", "usage", "config"):
            with self.subTest(target=target):
                runner, _, _, env, _, engine, dispatch, authority = self.model_fixture()
                if target == "gate": runner._ScopedAppAgentRunner__model_gate = fixed_failure
                elif target == "attempt": runner._ScopedAppAgentRunner__model_attempt = fixed_failure
                elif target == "finish": runner._ScopedAppAgentRunner__model_finish = fixed_failure
                elif target == "begin": engine.begin_request = fixed_failure
                elif target == "usage": engine.get_last_usage = fixed_failure
                else: engine.binding["configHash"] = "0" * 64
                self.failed(runner)
                self.assertEqual(len(authority.requests), 0)
                self.assertEqual(engine.sdk_calls, 0)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_44_revoke_after_gate_or_model_finish_discards_late_result(self):
        for stage in ("gate", "finish"):
            with self.subTest(stage=stage):
                runner, _, _, env, _, engine, dispatch, authority = self.model_fixture()
                if stage == "gate": authority.on_gate = runner.close
                else: authority.on_finish = runner.close
                self.failed(runner)
                self.assertEqual(engine.sdk_calls, 0 if stage == "gate" else 1)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_45_sdk_callback_outside_active_request_is_sticky_no_late_sdk(self):
        runner, _, _, env, _, engine, dispatch, authority = self.model_fixture()
        with self.assertRaises(ScopedAppAgentFatal):
            runner._ScopedAppAgentRunner__sdk_guard({"permitId": "0" * 32, "requestId": "0" * 32,
                "attempt": 1, "actualInputHash": "0" * 64})
        self.failed(runner)
        self.assertEqual(engine.sdk_calls, 0)
        self.assertEqual(len(authority.attempts), 0)
        self.assertEqual(len(dispatch.calls), 0)
        self.assertEqual(len(env.event_log), 0)

    def test_46_gated_logical_budget_does_not_auto_finish_or_reuse_native_budget(self):
        runner, _, _, env, _, engine, dispatch, authority = self.model_fixture(logical=1, budget=10, responses=[
            action("Contacts__get_contact", {"contact_id": "contact-1"}), action("final_answer", {"answer": "wrong"})])
        self.failed(runner)
        self.assertEqual(engine.calls, 1)
        self.assertEqual(len(authority.requests), 1)
        self.assertEqual(len(authority.finishes), 1)
        self.assertEqual(len(dispatch.calls), 1)
        self.assertEqual(len(env.event_log), 1)
        self.assertFalse(any(isinstance(log, FinalAnswerLog) for log in runner.base_agent.logs))

    def test_47_real_are_input_and_output_logging_failure_are_sticky(self):
        for failing_type in (LLMInputLog, LLMOutputThoughtActionLog):
            with self.subTest(failing_type=failing_type):
                def callback(log):
                    if isinstance(log, failing_type):
                        raise RuntimeError("private model logger failure")
                runner, _, _, env, _, engine, dispatch, authority = self.model_fixture(log_callback=callback)
                self.failed(runner)
                expected = 0 if failing_type is LLMInputLog else 1
                self.assertEqual(engine.sdk_calls, expected)
                self.assertEqual(len(authority.requests), expected)
                self.assertEqual(len(dispatch.calls), 0)
                self.assertEqual(len(env.event_log), 0)

    def test_48_final_native_completion_then_trusted_logger_failure_is_not_run_success(self):
        def callback(log):
            if isinstance(log, FinalAnswerLog):
                raise RuntimeError("private final logger failure")
        runner, _, _, env, _, engine, dispatch, authority = self.model_fixture(log_callback=callback)
        self.failed(runner)
        self.assertEqual(engine.sdk_calls, 1)
        self.assertEqual(len(authority.finishes), 1)
        self.assertEqual(len(dispatch.outcomes), 1)
        self.assertEqual(dispatch.outcomes[0]["status"], "succeeded")
        self.assertEqual(runner.snapshot()["originalObservationsTaken"], 1)
        self.assertEqual(len(env.event_log), 0)

    def test_49_custom_engine_without_gate_rejected_legacy_explicitly_not_gated(self):
        old, owner, app, env, scope, controlled, dispatch = self.fixture()
        self.assertEqual(old.run(), "completed")
        self.assertFalse(old.snapshot()["modelGateEnabled"])
        self.assertEqual(old.snapshot()["sdkAttemptsUsed"], 0)
        binding = {"schemaVersion": "capybara-scoped-model-scope-v1", "delegationScopeHash": wire.value_hash(scope),
            "modelRole": "child_actor", "configHash": "c" * 64, "maxLogicalRequests": 2, "maxSdkAttempts": 2}
        engine = SyntheticGatedEngine([action("final_answer", {"answer": "wrong"})], binding)
        with self.assertRaisesRegex(ScopedAppAgentFatal, "MODEL_GATE_REQUIRED"):
            build_scoped_app_agent(app=app, owner=owner, env=env, scope=scope, llm_engine=engine, dispatch=dispatch)

    def test_50_stable_projected_occurrence_ids_retained_under_suffix_crop(self):
        runner, _, _, _, scope, _, _, _ = self.model_fixture()
        message = {"role": "tool-response", "content": "same", "attachments": None}
        projected, ledger = runner._ScopedAppAgentRunner__projection([message, message], "1" * 32)
        self.assertEqual([value["role"] for value in projected], ["tool", "tool"])
        self.assertNotEqual(projected[0]["id"], projected[1]["id"])
        runner._ScopedAppAgentRunner__projected_history = ledger
        cropped, ledger2 = runner._ScopedAppAgentRunner__projection([message], "2" * 32)
        self.assertEqual(cropped[0]["id"], projected[1]["id"])
        self.assertEqual(ledger, ledger2)
        new = {"role": "tool-call", "content": "other", "attachments": None}
        grown, ledger3 = runner._ScopedAppAgentRunner__projection([message, new], "3" * 32)
        self.assertEqual(grown[0]["id"], projected[1]["id"])
        self.assertEqual(grown[1]["role"], "assistant")
        self.assertEqual(grown[1]["id"], scope["childExecutionId"] + ".model-message-3")
        runner._ScopedAppAgentRunner__projected_history = ledger3
        with self.assertRaises(ScopedAppAgentFatal):
            runner._ScopedAppAgentRunner__projection([message], "4" * 32)

    def test_51_model_completion_usage_unknown_is_nullable_not_zero(self):
        runner, _, _, _, _, engine, _, authority = self.model_fixture()
        engine.usage = None
        self.assertEqual(runner.run(), "gated completed")
        self.assertIsNone(authority.finishes[0]["usage"])
        self.assertIsNone(runner.snapshot()["modelRequests"][0]["usage"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
