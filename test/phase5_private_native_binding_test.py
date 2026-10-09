"""Real ARE Apps in an unstarted Environment; no Scenario/model/network."""

import copy
import hashlib
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import gaia2_a2a_wire as wire
from gaia2_private_native_binding import NativeAppBinding, NativeBindingError
from are.simulation.apps.app import App
from are.simulation.apps.apartment_listing import Apartment, RentAFlat
from are.simulation.apps.contacts import Contact, Contacts
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.tool_utils import AppTool, OperationType, app_tool
from are.simulation.types import CompletedEvent, EventRegisterer, event_registered


def mutate_format(value):
    value.append("formatted")
    return value


class Ledger(App):
    def __init__(self):
        super().__init__("Ledger")
        self.values = []
        self.calls = 0
        self.reads = 0
        self.replay_event = None
        self.entered = self.release = None
        self.erase_callback = False
        self.read_failure = False
        self.internal_write_on_read = False

    @app_tool()
    @event_registered(operation_type=OperationType.WRITE)
    def write(self, value: str, optional: str = "default") -> dict:
        """Write a local fixture value.
        :param value: test value
        :param optional: test default
        :returns: local values
        """
        self.calls += 1
        self.values.append(value)
        if self.replay_event is not None:
            self.add_event(self.replay_event)
        if self.erase_callback:
            for key in list(self.add_event_callbacks):
                if key.startswith("phase5-private-native-"):
                    self.add_event_callbacks.pop(key)
        if self.entered is not None:
            self.entered.set()
            if not self.release.wait(3):
                raise RuntimeError("fixture_timeout")
        if value == "fail":
            raise RuntimeError("private raw exception must not escape")
        if value == "helper":
            self.read()
        if value == "caught":
            try:
                self.read()
            except RuntimeError:
                pass
        return {"values": list(self.values), "optional": optional}

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def read(self) -> dict:
        """Read local fixture values.
        :returns: observed values
        """
        self.reads += 1
        if self.read_failure:
            raise RuntimeError("private internal read failure")
        if self.internal_write_on_read:
            self.internal_write_on_read = False
            self.write("ungated")
        return {"values": list(self.values)}

    @app_tool(llm_formatter=mutate_format)
    @event_registered(operation_type=OperationType.WRITE)
    def formatted_write(self, value: str) -> list:
        """Return a list mutated by the original formatter.
        :param value: test value
        :returns: mutable local values
        """
        self.calls += 1
        return [value]

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def kwargs_read(self, named: str = "default", **kwargs) -> dict:
        """Observe actual variadic binding without expanding effective kwargs.
        :param named: named value
        :param kwargs: extra values
        :returns: actual keyword shape
        """
        self.calls += 1
        return {"named": named, "kwargs": kwargs}

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def unsupported(self) -> object:
        """Return an unsupported object, never stringify it.
        :returns: unsupported value
        """
        return object()

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def expert_agent(self, task: str) -> str:
        """A forbidden nested expert.
        :param task: controlled task
        :returns: forbidden value
        """
        self.calls += 1
        raise AssertionError("nested expert must never execute")


class Tests(unittest.TestCase):
    def setUp(self):
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-native-binding-")
        self.addCleanup(self.temp.cleanup)
        self.index = 0
        self.owners = []
        self.addCleanup(lambda: [owner.close() for owner in self.owners])

    def owner(self, app=None, clock=None, sources=()):
        app = app or Ledger()
        env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
        env.register_apps([app])
        self.index += 1
        directory = Path(self.temp.name) / f"owner-{self.index}"
        owner = NativeAppBinding(app, environment_generation="environment-1", parent_execution_id="parent-exec",
            parent_session_id="parent-session", evidence_root=directory,
            clock=clock or env.time_manager.time, trusted_source_files=sources)
        self.owners.append(owner)
        return owner, app, env, directory

    def scope(self, owner, **updates):
        unique = uuid.uuid4().hex
        manifest = owner.manifest()
        task = "controlled private task 🦫"
        scope = {"parentExecutionId": "parent-exec", "parentSessionId": "parent-session",
            "environmentGeneration": "environment-1", "appId": manifest["appId"],
            "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
            "toolInventoryHash": manifest["toolInventoryHash"],
            "taskHash": hashlib.sha256(task.encode("utf-8")).hexdigest(), "task": task,
            "parentActionId": "parent-" + unique, "requestId": str(uuid.uuid4()),
            "childExecutionId": "execution-" + unique, "childSessionId": "session-" + unique,
            # Intentionally a different clock domain, not a native deadline.
            "deadline": 1, "maxNativeActions": 10}
        scope.update(updates)
        return scope

    def child(self, owner, **updates):
        scope = self.scope(owner, **updates)
        self.assertEqual(owner.bind_child({"scope": scope}), {"scopeHash": wire.value_hash(scope)})
        return scope

    def tool(self, owner, name):
        return next(tool for tool in owner.manifest()["tools"] if tool["canonicalName"].endswith("__" + name) or tool["canonicalName"] == name)

    def prepare(self, owner, scope, name="write", arguments=None):
        return owner.prepare_native({"scope": scope, "toolId": self.tool(owner, name)["toolId"],
            "rawArguments": {"value": "one"} if arguments is None else arguments})

    def commit_payload(self, scope, prepared):
        return {"scope": scope, "ticketId": prepared["ticketId"], "dispatchId": str(uuid.uuid4()),
            "toolId": prepared["toolId"], "effectiveArgumentsHash": prepared["effectiveArgumentsHash"]}

    def run_native(self, owner, scope, name, arguments):
        prepared = self.prepare(owner, scope, name, arguments)
        payload = self.commit_payload(scope, prepared)
        return prepared, owner.commit_native(payload), payload

    def receipt(self, root, ref):
        path = root / ref["path"]
        data = path.read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), ref["sha256"])
        return json.loads(data)

    def test_01_contacts_raw_two_effective_thirteen_real_direct_ce(self):
        owner, app, env, root = self.owner(Contacts())
        original = tuple(app.get_tools())
        scope = self.child(owner)
        raw = {"first_name": "Local", "last_name": "Fixture"}
        prepared = self.prepare(owner, scope, "add_new_contact", raw)
        self.assertEqual(len(raw), 2)
        self.assertEqual(len(prepared["effectiveArguments"]), 13)
        self.assertEqual(prepared["effectiveArguments"]["age"], None)
        self.assertEqual(prepared["rawArgumentsHash"], wire.value_hash(raw))
        self.assertNotEqual(prepared["rawArgumentsHash"], prepared["effectiveArgumentsHash"])
        self.assertEqual(len(app.contacts), 0)
        self.assertEqual(len(env.event_log), 0)
        payload = self.commit_payload(scope, prepared)
        result = owner.commit_native(payload)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(len(app.contacts), 1)
        self.assertEqual(len(env.event_log), 1)
        ce = env.event_log.list_view()[0]
        self.assertIsInstance(ce, CompletedEvent)
        self.assertIs(ce.action.app, app)
        self.assertEqual(tuple(id(tool) for tool in app.get_tools()), tuple(id(tool) for tool in original))
        self.assertTrue(all(isinstance(tool, AppTool) for tool in original))
        receipt = self.receipt(root, result["nativeCompletedEventRef"])
        self.assertEqual(receipt["eventId"], ce.event_id)
        self.assertEqual(receipt["sourceManifestHash"], wire.value_hash(owner.manifest()))
        self.assertEqual(receipt["effectiveArgumentsHash"], prepared["effectiveArgumentsHash"])
        self.assertEqual(receipt["nativeRawResultHash"], result["agentObservationHash"])
        self.assertEqual(receipt["exception"], None)
        self.assertEqual(receipt["completed"], True)
        self.assertEqual(owner.take_native_result(payload["dispatchId"]), result["agentObservation"])
        with self.assertRaises(NativeBindingError):
            owner.take_native_result(payload["dispatchId"])
        dispatch = self.receipt(root, result["dispatchEvidenceRef"])
        self.assertEqual(dispatch["status"], "pending")
        returned = self.receipt(root, result["nativeReturnEvidenceRef"])
        self.assertTrue(returned["returned"])
        self.assertEqual(returned["nativeCompletedEventRef"], result["nativeCompletedEventRef"])

    def test_02_rent_real_formatter_none_to_string_runs_once(self):
        apartment = Apartment("Fixture", "Local", "00001", 1200.0, 1, 1, "Apartment", 500, apartment_id="apt-1")
        owner, app, env, root = self.owner(RentAFlat(apartments={"apt-1": apartment}))
        scope = self.child(owner)
        prepared, result, payload = self.run_native(owner, scope, "save_apartment", {"apartment_id": "apt-1"})
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["agentObservation"], "Successfully saved apartment")
        self.assertEqual(app.saved_apartments, ["apt-1"])
        self.assertEqual(len(env.event_log), 1)
        receipt = self.receipt(root, result["nativeCompletedEventRef"])
        self.assertIsNone(receipt["nativeRawProjection"])
        self.assertEqual(receipt["nativeRawResultHash"], wire.value_hash(None))
        self.assertNotEqual(result["nativeRawResultHash"], result["agentObservationHash"])
        self.assertEqual(receipt["formatterSourceHash"], self.tool(owner, "save_apartment")["formatterSourceHash"])
        self.assertIsNone(owner.take_native_result(payload["dispatchId"]))
        self.assertEqual(owner.take_agent_observation(payload["dispatchId"]), "Successfully saved apartment")
        with self.assertRaises(NativeBindingError):
            owner.take_agent_observation(payload["dispatchId"])

    def test_03_real_dataclass_enum_tuple_projection_and_private_identity(self):
        contact = Contact("Local", "User", contact_id="contact-1", is_user=True)
        owner, app, env, root = self.owner(Contacts(contacts={contact.contact_id: contact}))
        scope = self.child(owner)
        _, result, payload = self.run_native(owner, scope, "get_current_user_details", {})
        observation = result["agentObservation"]
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(observation["nativeType"], "dataclass")
        self.assertEqual(observation["fields"]["gender"]["nativeType"], "enum")
        self.assertEqual(observation["fields"]["first_name"], "Local")
        self.assertIs(owner.take_native_result(payload["dispatchId"]), contact)
        contact.first_name = "Changed"
        self.assertEqual(observation["fields"]["first_name"], "Local")
        receipt = self.receipt(root, result["nativeCompletedEventRef"])
        self.assertEqual(receipt["nativeRawProjection"]["fields"]["first_name"], "Local")
        _, listed, _ = self.run_native(owner, scope, "get_contacts", {})
        self.assertEqual(listed["status"], "succeeded")
        self.assertEqual(listed["agentObservation"]["metadata"]["range"], {"nativeType": "tuple", "items": [0, 1]})
        source_paths = [ref["path"] for ref in owner.manifest()["sourceRefs"]]
        self.assertTrue(any(path.endswith("contacts.py") for path in source_paths))

    def test_04_formatter_in_place_freezes_callback_before_mutation(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        _, result, payload = self.run_native(owner, scope, "formatted_write", {"value": "raw"})
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(app.calls, 1)
        self.assertEqual(result["agentObservation"], ["raw", "formatted"])
        receipt = self.receipt(root, result["nativeCompletedEventRef"])
        self.assertEqual(receipt["nativeRawProjection"], ["raw"])
        self.assertNotEqual(result["nativeRawResultHash"], result["agentObservationHash"])
        self.assertEqual(env.event_log.list_view()[0].metadata.return_value, ["raw", "formatted"])

    def test_05_real_final_tool_no_ce_and_terminal_barrier(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        queued = self.prepare(owner, scope)
        _, result, payload = self.run_native(owner, scope, "final_answer", {"answer": {"done": True}})
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["agentObservation"], {"done": True})
        self.assertIsNone(result["nativeCompletedEventRef"])
        self.assertEqual(len(env.event_log), 0)
        self.assertEqual(result["toolId"], "final_answer")
        self.assertEqual(result["effect"], "finish")
        self.assertEqual(self.receipt(root, result["nativeReturnEvidenceRef"])["toolKind"], "child_final_answer")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_TERMINAL"):
            owner.commit_native(self.commit_payload(scope, queued))
        self.assertEqual(app.calls, 0)

    def test_06_manifest_exact_inventory_sources_and_nested_expert_excluded(self):
        app = Ledger()
        expert = next(tool for tool in app.get_tools() if tool.func_name == "expert_agent")
        expert._public_name = "Ledger__safe_read"
        owner, app, env, root = self.owner(app)
        manifest = owner.manifest()
        self.assertEqual(set(manifest), {"schemaVersion", "environmentGeneration", "parentExecutionId", "parentSessionId",
            "appId", "appType", "evidenceRoot", "parentCanonicalName", "taskArgumentKey", "sourceRefs", "tools", "toolInventoryHash"})
        self.assertEqual(manifest["toolInventoryHash"], wire.value_hash(manifest["tools"]))
        self.assertEqual(owner.inspect_app(None), manifest)
        for payload in ({}, {"passed": True}, False, []):
            with self.subTest(payload=payload), self.assertRaisesRegex(NativeBindingError, "NATIVE_PAYLOAD_INVALID"):
                owner.inspect_app(payload)
        self.assertNotIn("Ledger__safe_read", [tool["publicName"] for tool in manifest["tools"]])
        self.assertEqual(set(owner.handlers()), {"inspect_app", "bind_child", "prepare_native", "commit_native", "cancel_child"})
        for ref in manifest["sourceRefs"]:
            data = Path(ref["path"]).read_bytes()
            self.assertEqual(len(data), ref["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), ref["sha256"])
        scope = self.child(owner)
        for tool_id in (expert.name, "Ledger__safe_read", "expert_agent", "native-9999"):
            with self.subTest(tool_id=tool_id), self.assertRaises(NativeBindingError):
                owner.prepare_native({"scope": scope, "toolId": tool_id, "rawArguments": {"task": "not executed"}})
        self.assertEqual(app.calls, 0)
        manifest["tools"].clear()
        self.assertGreater(len(owner.manifest()["tools"]), 0)

    def test_07_fake_scope_and_legacy_task_hash_are_rejected(self):
        owner, app, env, root = self.owner()
        scope = self.scope(owner)
        for key, wrong in (("environmentGeneration", "other"), ("parentExecutionId", "other"),
            ("parentSessionId", "other"), ("appId", "other"), ("parentCanonicalName", "Ledger__expert_agent"),
            ("taskArgumentKey", "other"), ("toolInventoryHash", "0" * 64),
            ("taskHash", wire.value_hash(scope["task"])), ("deadline", float("nan")),
            ("maxNativeActions", True), ("maxNativeActions", 0)):
            bad = {**scope, key: wrong}
            with self.subTest(key=key, wrong=repr(wrong)), self.assertRaises(NativeBindingError):
                owner.bind_child({"scope": bad})
        for bad in ({**scope, "passed": True}, {key: value for key, value in scope.items() if key != "taskHash"}):
            with self.assertRaises(NativeBindingError):
                owner.bind_child({"scope": bad})
        owner.bind_child({"scope": scope})
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_REUSED"):
            owner.bind_child({"scope": scope})
        self.assertEqual(app.calls, 0)

    def test_08_ticket_scope_effective_hash_repeat_and_cross_child_failclosed(self):
        owner, app, env, root = self.owner()
        first, second = self.child(owner), self.child(owner)
        prepared = self.prepare(owner, first)
        payload = self.commit_payload(first, prepared)
        for key, value in (("ticketId", "0" * 32), ("scope", second), ("toolId", "final_answer"),
                           ("effectiveArgumentsHash", "0" * 64), ("dispatchId", "not-uuid")):
            with self.subTest(key=key), self.assertRaises(NativeBindingError):
                owner.commit_native({**payload, key: value})
        self.assertEqual(app.calls, 0)
        self.assertEqual(owner.commit_native(payload)["status"], "succeeded")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_TICKET_INVALID_OR_CONSUMED"):
            owner.commit_native(payload)
        another = self.prepare(owner, second)
        other_payload = self.commit_payload(second, another)
        other_payload["dispatchId"] = payload["dispatchId"]
        with self.assertRaises(NativeBindingError):
            owner.commit_native(other_payload)
        self.assertEqual(app.calls, 1)

    def test_09_true_kwargs_binding_preserved_not_effective_expanded(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        prepared, result, _ = self.run_native(owner, scope, "kwargs_read", {"extra": "one"})
        self.assertEqual(prepared["effectiveArguments"], {"named": "default", "kwargs": {"extra": "one"}})
        self.assertEqual(result["agentObservation"], prepared["effectiveArguments"])
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(app.calls, 1)

    def test_10_prepare_invalid_arguments_has_no_native_side_effects(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        for raw in ({}, {"value": "one", "extra": True}, {"value": float("inf")}, {"value": {"__proto__": True}}):
            with self.subTest(raw=repr(raw)), self.assertRaises(NativeBindingError):
                self.prepare(owner, scope, arguments=raw)
        self.assertEqual(app.calls, 0)
        self.assertEqual(len(env.event_log), 0)

    def test_11_defaults_write_fault_formatter_and_public_name_drift(self):
        for mutation in ("defaults", "write", "fault", "public", "formatter", "adapter"):
            with self.subTest(mutation=mutation):
                owner, app, env, root = self.owner()
                scope = self.child(owner)
                prepared = self.prepare(owner, scope)
                tool = next(tool for tool in app.get_tools() if tool.func_name == "write")
                target, attribute, value = {
                    "defaults": (tool.function.__wrapped__, "__defaults__", ("changed",)),
                    "write": (tool, "write_operation", False),
                    "fault": (tool, "failure_probability", 1.0),
                    "public": (tool, "_public_name", "changed"),
                    "formatter": (tool.function, "llm_formatter", mutate_format),
                    "adapter": (tool, "function", Ledger.read),
                }[mutation]
                with patch.object(target, attribute, value):
                    with self.assertRaisesRegex(NativeBindingError, "NATIVE_BINDING_CHANGED"):
                        owner.commit_native(self.commit_payload(scope, prepared))
                self.assertEqual(app.calls, 0)

    def test_12_file_source_drift_rejects_and_unknown_not_washed(self):
        source = Path(self.temp.name) / "trusted-factory.txt"
        source.write_text("original factory", encoding="utf-8")
        owner, app, env, root = self.owner(sources=(source,))
        scope = self.child(owner)
        prepared = self.prepare(owner, scope)
        source.write_text("changed factory", encoding="utf-8")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_BINDING_CHANGED"):
            owner.commit_native(self.commit_payload(scope, prepared))
        source.write_text("original factory", encoding="utf-8")
        other = self.child(owner)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            self.prepare(owner, other)
        self.assertEqual(app.calls, 0)

    def test_13_write_exception_unknown_across_child_read_does_not_clear(self):
        owner, app, env, root = self.owner()
        first = self.child(owner)
        _, outcome, _ = self.run_native(owner, first, "write", {"value": "fail"})
        self.assertEqual(outcome["status"], "unknown")
        self.assertEqual(outcome["errorCode"], "NATIVE_TOOL_FAILED")
        self.assertNotIn("private raw exception", json.dumps(outcome))
        self.assertIsNone(outcome["nativeCompletedEventRef"])
        second = self.child(owner)
        for name, args in (("write", {"value": "different"}), ("final_answer", {"answer": "done"})):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
                self.prepare(owner, second, name, args)
        _, observed, _ = self.run_native(owner, second, "read", {})
        self.assertEqual(observed["status"], "succeeded")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            self.prepare(owner, second)
        self.assertEqual(app.values, ["fail"])
        self.assertEqual(app.calls, 1)

    def test_14_internal_real_same_app_event_is_recorded_not_second_dispatch(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        _, outcome, _ = self.run_native(owner, scope, "write", {"value": "helper"})
        self.assertEqual(outcome["status"], "succeeded")
        self.assertEqual(len(env.event_log), 2)
        self.assertEqual(app.calls, 1)
        receipt = self.receipt(root, outcome["nativeCompletedEventRef"])
        self.assertEqual([item["canonicalName"] for item in receipt["observedEvents"]], ["Ledger__read", "Ledger__write"])
        self.assertEqual([item["operation"] for item in receipt["observedEvents"]], ["read", "write"])

    def test_15_old_event_id_replay_rejected(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        self.run_native(owner, scope, "write", {"value": "old"})
        app.replay_event = env.event_log.list_view()[0]
        _, outcome, _ = self.run_native(owner, scope, "write", {"value": "new"})
        self.assertEqual(outcome["status"], "unknown")
        self.assertEqual(outcome["errorCode"], "NATIVE_EVENT_INVALID")
        self.assertEqual(app.calls, 2)

    def test_16_close_callback_and_late_return_never_succeed(self):
        app = Ledger()
        box = []
        app.register_to_env("controlled-close", lambda event: box[0].close())
        owner, app, env, root = self.owner(app)
        box.append(owner)
        scope = self.child(owner)
        _, outcome, _ = self.run_native(owner, scope, "write", {"value": "close"})
        self.assertEqual(outcome["status"], "unknown")
        self.assertEqual(app.values, ["close"])
        self.assertIn("environment", app.add_event_callbacks)
        self.assertIn("controlled-close", app.add_event_callbacks)
        self.assertFalse(any(key.startswith("phase5-private-native-") for key in app.add_event_callbacks))
        owner.close()
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_OWNER_CLOSED"):
            owner.manifest()
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_APP_ALREADY_OWNED"):
            NativeAppBinding(app, environment_generation="wash", parent_execution_id="p", parent_session_id="s",
                evidence_root=Path(self.temp.name) / "wash", clock=env.time_manager.time)

    def test_17_cancel_inflight_retains_unknown_and_zero_queued_execution(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        app.entered, app.release = threading.Event(), threading.Event()
        prepared = self.prepare(owner, scope)
        queued = self.prepare(owner, scope, arguments={"value": "queued"})
        payload = self.commit_payload(scope, prepared)
        results = []
        thread = threading.Thread(target=lambda: results.append(owner.commit_native(payload)))
        thread.start()
        self.assertTrue(app.entered.wait(3))
        try:
            self.assertEqual(owner.cancel_child({"scope": scope})["status"], "unknown")
        finally:
            app.release.set()
            thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(results[0]["status"], "unknown")
        with self.assertRaises(NativeBindingError):
            owner.commit_native(self.commit_payload(scope, queued))
        self.assertEqual(app.calls, 1)
        other = self.child(owner)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            self.prepare(owner, other)

    def test_18_capture_disabled_clock_budget_and_root_reuse_failclosed(self):
        now = [1000.0]
        owner, app, env, root = self.owner(clock=lambda: now[0])
        scope = self.child(owner, maxNativeActions=1)
        with EventRegisterer.capture_mode(), self.assertRaisesRegex(NativeBindingError, "NATIVE_EVENT_MODE_INVALID"):
            self.prepare(owner, scope)
        with EventRegisterer.disable(), self.assertRaisesRegex(NativeBindingError, "NATIVE_EVENT_MODE_INVALID"):
            self.prepare(owner, scope)
        self.run_native(owner, scope, "read", {})
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_BUDGET_EXHAUSTED"):
            self.prepare(owner, scope)
        other = self.child(owner)
        now[0] = 999.0
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_INVALID"):
            self.prepare(owner, other)
        now[0] = 1001.0
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_INVALID"):
            self.prepare(owner, other)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_EVIDENCE_ROOT_NOT_FRESH"):
            NativeAppBinding(Ledger(), environment_generation="e", parent_execution_id="p", parent_session_id="s",
                evidence_root=root, clock=lambda: 1.0)

    def test_19_unknown_type_read_fails_without_string_coercion(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        _, outcome, _ = self.run_native(owner, scope, "unsupported", {})
        self.assertEqual(outcome["status"], "failed")
        self.assertEqual(outcome["errorCode"], "NATIVE_RESULT_UNSUPPORTED")
        self.assertIsNone(outcome["agentObservation"])
        self.assertIsNone(outcome["agentObservationHash"])

    def test_20_prebody_fault_missing_callback_and_fixed_outcome_keys(self):
        app = Ledger()
        app.set_failure_probability(1.0)
        owner, app, env, root = self.owner(app)
        scope = self.child(owner)
        _, outcome, _ = self.run_native(owner, scope, "write", {"value": "one"})
        self.assertEqual(outcome["status"], "unknown")
        self.assertEqual(app.calls, 0)
        self.assertEqual(len(env.event_log), 0)
        self.assertEqual(set(outcome), {"schemaVersion", "scopeHash", "ticketId", "dispatchId", "toolId", "canonicalName",
            "toolKind", "effect", "rawArgumentsHash", "effectiveArgumentsHash", "status", "agentObservation",
            "agentObservationHash", "nativeRawResultHash", "nativeCompletedEventRef", "dispatchEvidenceRef",
            "nativeReturnEvidenceRef", "errorCode"})
        owner2, app2, env2, root2 = self.owner()
        scope2 = self.child(owner2)
        app2.erase_callback = True
        _, missing, _ = self.run_native(owner2, scope2, "write", {"value": "one"})
        self.assertEqual(missing["status"], "unknown")
        self.assertEqual(missing["errorCode"], "NATIVE_BINDING_CHANGED")
        self.assertIsNone(missing["nativeCompletedEventRef"])
        self.assertEqual(app2.calls, 1)

    def test_21_failed_or_closed_has_no_success_projection_or_owner_result(self):
        for mode in ("exception", "cancel", "closed"):
            with self.subTest(mode=mode):
                owner, app, env, root = self.owner()
                scope = self.child(owner)
                prepared = self.prepare(owner, scope, arguments={"value": "fail" if mode == "exception" else "one"})
                payload = self.commit_payload(scope, prepared)
                if mode == "exception":
                    outcome = owner.commit_native(payload)
                else:
                    app.entered, app.release = threading.Event(), threading.Event()
                    outcomes = []
                    thread = threading.Thread(target=lambda: outcomes.append(owner.commit_native(payload)))
                    thread.start()
                    self.assertTrue(app.entered.wait(3))
                    try:
                        if mode == "cancel":
                            owner.cancel_child({"scope": scope})
                        else:
                            owner.close()
                    finally:
                        app.release.set()
                        thread.join(3)
                    self.assertFalse(thread.is_alive())
                    outcome = outcomes[0]
                self.assertEqual(outcome["status"], "unknown")
                receipt = self.receipt(root, outcome["nativeReturnEvidenceRef"])
                for key in ("agentObservation", "agentObservationHash", "nativeCompletedEventRef", "nativeRawResultHash"):
                    self.assertIsNone(outcome[key])
                    self.assertIsNone(receipt[key])
                for accessor in (owner.take_native_result, owner.take_agent_observation):
                    with self.assertRaises(NativeBindingError):
                        accessor(payload["dispatchId"])
                self.assertEqual(app.calls, 1)

    def test_22_source_changed_during_body_is_unknown_no_result_capability(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        prepared = self.prepare(owner, scope)
        tool = next(tool for tool in app.get_tools() if tool.func_name == "write")
        # The existing real observer mutates metadata during native execution.
        app.register_to_env("drift-after-body", lambda event: setattr(tool, "write_operation", False))
        payload = self.commit_payload(scope, prepared)
        outcome = owner.commit_native(payload)
        self.assertEqual(outcome["status"], "unknown")
        self.assertEqual(outcome["errorCode"], "NATIVE_BINDING_CHANGED")
        self.assertIsNone(outcome["agentObservation"])
        self.assertEqual(app.calls, 1)
        tool.write_operation = True
        for accessor in (owner.take_native_result, owner.take_agent_observation):
            with self.assertRaises(NativeBindingError):
                accessor(payload["dispatchId"])
        other = self.child(owner)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            self.prepare(owner, other)

    def test_23_default_identity_and_bool_effect_type_cannot_alias(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        prepared = self.prepare(owner, scope)
        tool = next(tool for tool in app.get_tools() if tool.func_name == "write")
        with patch.object(tool, "write_operation", 1):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_BINDING_CHANGED"):
                owner.commit_native(self.commit_payload(scope, prepared))
        innermost = tool.function.__wrapped__
        original_defaults = innermost.__defaults__
        self.assertEqual(original_defaults, ("default",))
        equal_new_defaults = tuple(["default"])
        self.assertIsNot(equal_new_defaults, original_defaults)
        with patch.object(innermost, "__defaults__", equal_new_defaults):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_BINDING_CHANGED"):
                owner.commit_native(self.commit_payload(scope, prepared))
        self.assertEqual(app.calls, 0)

    def test_24_callback_environment_removed_or_public_adapter_renamed_denied(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        prepared = self.prepare(owner, scope)
        callback = app.add_event_callbacks.pop("environment")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_BINDING_CHANGED"):
            owner.commit_native(self.commit_payload(scope, prepared))
        app.add_event_callbacks["environment"] = callback
        self.assertEqual(app.calls, 0)
        self.assertEqual(len(env.event_log), 0)

    def test_25_internal_failed_event_and_read_hidden_write_preserve_unknown(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        app.read_failure = True
        _, failed, _ = self.run_native(owner, scope, "write", {"value": "caught"})
        self.assertEqual(failed["status"], "unknown")
        self.assertEqual(failed["errorCode"], "NATIVE_INTERNAL_EVENT_FAILED")
        self.assertEqual(len(env.event_log), 2)
        app.read_failure = False
        other = self.child(owner)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            self.prepare(owner, other)
        owner2, app2, env2, root2 = self.owner()
        scope2 = self.child(owner2)
        app2.internal_write_on_read = True
        _, hidden, _ = self.run_native(owner2, scope2, "read", {})
        self.assertEqual(hidden["status"], "failed")
        self.assertEqual(hidden["errorCode"], "NATIVE_INTERNAL_WRITE_NOT_GATED")
        self.assertEqual(app2.values, ["ungated"])
        other2 = self.child(owner2)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            self.prepare(owner2, other2)

    def test_26_real_contact_partial_edit_failure_unknown_after_actual_effect(self):
        contact = Contact("Old", "Fixture", contact_id="contact-1")
        owner, app, env, root = self.owner(Contacts(contacts={"contact-1": contact}))
        scope = self.child(owner)
        _, outcome, _ = self.run_native(owner, scope, "edit_contact", {
            "contact_id": "contact-1", "updates": {"first_name": "Changed", "not_a_contact_field": "invalid"}})
        self.assertEqual(outcome["status"], "unknown")
        self.assertEqual(contact.first_name, "Changed")
        self.assertEqual(len(env.event_log), 1)
        other = self.child(owner)
        _, observed, _ = self.run_native(owner, other, "get_contact", {"contact_id": "contact-1"})
        self.assertEqual(observed["status"], "succeeded")
        self.assertEqual(observed["agentObservation"]["fields"]["first_name"], "Changed")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            self.prepare(owner, other, "edit_contact", {"contact_id": "contact-1", "updates": {"first_name": "Old"}})

    def test_27_return_evidence_failure_retains_unknown_and_no_owner_result(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        prepared = self.prepare(owner, scope)
        payload = self.commit_payload(scope, prepared)
        original = owner._NativeAppBinding__receipt
        def fail_return(prefix, body):
            if prefix == "return":
                raise OSError("private file IO text")
            return original(prefix, body)
        with patch.object(owner, "_NativeAppBinding__receipt", fail_return):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_COMPLETION_EVIDENCE_FAILED"):
                owner.commit_native(payload)
        self.assertEqual(app.calls, 1)
        for accessor in (owner.take_native_result, owner.take_agent_observation):
            with self.assertRaises(NativeBindingError):
                accessor(payload["dispatchId"])
        other = self.child(owner)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            self.prepare(owner, other)

    def test_28_dispatch_evidence_failure_zero_execution_still_no_auto_replay(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        prepared = self.prepare(owner, scope)
        payload = self.commit_payload(scope, prepared)
        with patch.object(owner, "_NativeAppBinding__receipt", side_effect=OSError("private IO failure")):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_DISPATCH_EVIDENCE_FAILED"):
                owner.commit_native(payload)
        self.assertEqual(app.calls, 0)
        self.assertEqual(len(env.event_log), 0)
        other = self.child(owner)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            self.prepare(owner, other)

    def test_29_original_raw_and_agent_accessor_independent_closed_source_checked(self):
        owner, app, env, root = self.owner()
        scope = self.child(owner)
        _, outcome, payload = self.run_native(owner, scope, "formatted_write", {"value": "raw"})
        raw_original = owner.take_native_result(payload["dispatchId"])
        agent_original = owner.take_agent_observation(payload["dispatchId"])
        self.assertIs(raw_original, agent_original)
        self.assertEqual(raw_original, ["raw", "formatted"])
        for accessor in (owner.take_native_result, owner.take_agent_observation):
            with self.assertRaises(NativeBindingError):
                accessor(payload["dispatchId"])
        _, outcome2, payload2 = self.run_native(owner, scope, "read", {})
        owner.close()
        for accessor in (owner.take_native_result, owner.take_agent_observation):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_OWNER_CLOSED"):
                accessor(payload2["dispatchId"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
