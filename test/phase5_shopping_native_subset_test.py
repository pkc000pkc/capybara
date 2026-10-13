"""Complete fixed-source Shopping support and sticky drift checks, offline.

The actual official ShoppingApp and ARE Environment are used without starting
a Scenario, child runner, provider or network transport. The single reviewed
pure getter has actual return evidence, never an invented CompletedEvent.
"""

import hashlib
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import gaia2_a2a_wire as wire
import gaia2_private_native_binding as native_binding
from gaia2_private_native_binding import NativeAppBinding, NativeBindingError
from are.simulation.apps.shopping import ShoppingApp, Shopping
from are.simulation.apps.app import App
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.tool_utils import AppToolAdapter, AppToolArg, app_tool, OperationType
from are.simulation.types import Action, CompletedEvent, EventMetadata, EventType


def forbidden_replacement(self):
    """A changed excluded function must never become a native permit."""
    raise AssertionError("excluded_function_must_not_execute")


class ShoppingNativeSubsetTests(unittest.TestCase):
    def setUp(self):
        offline = patch.object(socket.socket, "connect",
                               side_effect=AssertionError("network_forbidden"))
        offline.start()
        self.addCleanup(offline.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-shopping-subset-")
        self.addCleanup(self.temp.cleanup)
        self.owners = []
        self.addCleanup(lambda: [owner.close() for owner in self.owners])
        self.index = 0

    def fixture(self, *, sources=(), app=None, customize=None, has_are_clock=True, clock_factory=None):
        # Each fixture has a new native instance: never recycle an owner or its
        # lifetime tombstone after drift has made its binding terminal.
        app = app if app is not None else ShoppingApp(name="Shopping")
        env = Environment(EnvironmentConfig(start_time=1000.0, duration=None,
                                            verbose=False))
        env.register_apps([app])
        excluded = next(tool for tool in app.get_tools()
                        if tool.func_name == "get_all_discount_codes")
        public_name = AppToolAdapter(excluded).name
        if customize is not None:
            customize(excluded)
        self.index += 1
        root = Path(self.temp.name) / f"owner-{self.index}"
        owner = NativeAppBinding(
            app, environment_generation="shopping-env",
            parent_execution_id="shopping-parent",
            parent_session_id="shopping-session", evidence_root=root,
            clock=clock_factory(app, env) if clock_factory else env.time_manager.time,
            clock_environment=env if has_are_clock else None,
            trusted_source_files=(Path(__file__), *sources))
        self.owners.append(owner)
        return owner, app, env, root, excluded, public_name

    def child(self, owner):
        manifest = owner.manifest()
        unique = uuid.uuid4().hex
        task = "controlled Shopping native subset check"
        scope = {
            "parentExecutionId": "shopping-parent",
            "parentSessionId": "shopping-session",
            "environmentGeneration": "shopping-env", "appId": "Shopping",
            "parentCanonicalName": "AppAgent__expert_agent",
            "taskArgumentKey": "task",
            "toolInventoryHash": manifest["toolInventoryHash"],
            "taskHash": hashlib.sha256(task.encode()).hexdigest(), "task": task,
            "parentActionId": "shopping-action-" + unique,
            "requestId": str(uuid.uuid4()),
            "childExecutionId": "shopping-child-" + unique,
            "childSessionId": "shopping-child-session-" + unique,
            "deadline": 1.0, "maxNativeActions": 10,
        }
        self.assertEqual(owner.bind_child({"scope": scope}),
                         {"scopeHash": wire.value_hash(scope)})
        return scope

    def binding_changed(self, owner):
        with self.assertRaisesRegex(NativeBindingError, "^NATIVE_BINDING_CHANGED$"):
            owner.manifest()
        with self.assertRaisesRegex(NativeBindingError, "^NATIVE_BINDING_CHANGED$"):
            owner.excluded_tool_snapshot()

    def receipt(self, root, ref):
        data = (root / ref["path"]).read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), ref["sha256"])
        return json.loads(data)

    def dispatch(self, owner, scope, method, arguments=None):
        meta = next(tool for tool in owner.manifest()["tools"]
                    if tool["canonicalName"].endswith("__" + method) or tool["canonicalName"] == method)
        prepared = owner.prepare_native({"scope": scope, "toolId": meta["toolId"],
                                         "rawArguments": arguments or {}})
        payload = {"scope": scope, "ticketId": prepared["ticketId"],
                   "dispatchId": str(uuid.uuid4()), "toolId": meta["toolId"],
                   "effectiveArgumentsHash": prepared["effectiveArgumentsHash"]}
        before = owner.observe_clock({"scope": scope, "ticketId": payload["ticketId"],
                                      "dispatchId": payload["dispatchId"], "checkpoint": "before_tool"})
        outcome = owner.commit_native(payload)
        after = owner.observe_clock({"scope": scope, "ticketId": payload["ticketId"],
                                     "dispatchId": payload["dispatchId"], "checkpoint": "after_tool"})
        return prepared, payload, before, outcome, after

    def test_01_real_shopping_exposes_all_twelve_native_tools_and_final(self):
        owner, app, env, _, excluded, public_name = self.fixture()
        originals = tuple(app.get_tools())
        manifest = owner.manifest()
        native = [tool for tool in manifest["tools"]
                  if tool["toolKind"] == "app_tool"]
        final = [tool for tool in manifest["tools"]
                 if tool["toolKind"] == "child_final_answer"]
        expected = {AppToolAdapter(tool).name: tool for tool in originals}
        self.assertEqual(manifest["schemaVersion"], "gaia2-native-app-binding-v2")
        self.assertEqual(len(originals), 12)
        self.assertEqual(len(expected), 12)
        self.assertEqual(len(native), 12)
        self.assertEqual(len(final), 1)
        self.assertEqual(len(manifest["tools"]), 13)
        self.assertEqual({tool["publicName"] for tool in native}, set(expected))
        self.assertEqual(final[0]["publicName"], "final_answer")
        self.assertEqual(final[0]["effect"], "finish")
        self.assertEqual(final[0]["completionEvidenceKind"], "child_final_answer")
        self.assertIsNone(final[0]["sourcePinId"])
        for tool in native:
            self.assertEqual(tool["effect"],
                             "write" if expected[tool["publicName"]].write_operation
                             else "read")
            self.assertEqual(tool["completionEvidenceKind"], "source_pinned_return"
                             if tool["publicName"] == public_name else "are_completed_event")
            self.assertEqual(tool["sourcePinId"], native_binding._SOURCE_RETURN_PIN_ID
                             if tool["publicName"] == public_name else None)
        self.assertIn(public_name, {tool["publicName"] for tool in manifest["tools"]})
        self.assertIsNone(excluded.write_operation)
        self.assertEqual(manifest["toolInventoryHash"], wire.value_hash(manifest["tools"]))
        self.assertIn(str(ROOT / ".official-python" / "are" / "simulation" /
                          "apps" / "shopping.py"),
                      [ref["path"] for ref in manifest["sourceRefs"]])
        self.assertEqual(tuple(app.get_tools()), originals)
        self.assertEqual(len(env.event_log), 0)

    def test_02_excluded_snapshot_is_exact_explicit_and_defensively_copied(self):
        owner, _, _, _, excluded, public_name = self.fixture()
        expected = {
            "schemaVersion": "gaia2-private-native-excluded-tools-v1",
            "appId": "Shopping", "toolCount": 0,
            "sourceManifestHash": wire.value_hash(owner.manifest()),
            "tools": [],
        }
        snapshot = owner.excluded_tool_snapshot()
        self.assertEqual(snapshot, expected)
        snapshot["tools"].append({"reasonCode": "changed_copy"})
        snapshot["toolCount"] = 100
        self.assertEqual(owner.excluded_tool_snapshot(), expected)
        self.assertIsNone(excluded.write_operation)

    def test_03_exact_getter_returns_actual_result_without_any_native_event(self):
        owner, app, env, root, excluded, public_name = self.fixture()
        app.discount_codes = {"item-1": {"SAVE10": 10.0, "SAVE20": 20.0},
                              "item-2": {"SAVE10": 10.0}}
        scope = self.child(owner)
        canonical = "ShoppingApp__get_all_discount_codes"
        manifest = owner.manifest()
        self.assertIn(canonical, {tool["canonicalName"] for tool in manifest["tools"]})
        # Neither the original public/adapter name nor an invented ID may be
        # substituted for a permitted native ID by a runner or pipe client.
        for tool_id in (public_name, excluded.name, canonical, "native-9999"):
            with self.subTest(tool_id=tool_id):
                with self.assertRaisesRegex(NativeBindingError,
                                            "^NATIVE_TOOL_OR_ARGUMENTS_INVALID$"):
                    owner.prepare_native({"scope": scope, "toolId": tool_id,
                                          "rawArguments": {}})
        prepared, payload, before, outcome, after = self.dispatch(owner, scope, "get_all_discount_codes")
        expected = {"SAVE10": ["item-1", "item-2"], "SAVE20": ["item-1"]}
        self.assertEqual(outcome["schemaVersion"], "gaia2-private-native-outcome-v2")
        self.assertEqual(outcome["completionEvidenceKind"], "source_pinned_return")
        self.assertEqual(outcome["sourcePinId"], native_binding._SOURCE_RETURN_PIN_ID)
        self.assertEqual(outcome["status"], "succeeded")
        self.assertEqual(outcome["agentObservation"], expected)
        self.assertEqual(outcome["nativeRawResultHash"], wire.value_hash(expected))
        self.assertIsNone(outcome["nativeCompletedEventRef"])
        returned = self.receipt(root, outcome["nativeReturnEvidenceRef"])
        self.assertEqual(returned["schemaVersion"], "gaia2-private-native-return-v2")
        self.assertEqual(returned["nativeRawProjection"], expected)
        self.assertEqual(returned["sourceManifestHash"], wire.value_hash(manifest))
        self.assertEqual(returned["scopeHash"], wire.value_hash(scope))
        self.assertEqual(returned["effectiveArgumentsHash"], prepared["effectiveArgumentsHash"])
        self.assertGreaterEqual(returned["ownerClock"], before["clock"]["now"])
        self.assertLessEqual(returned["ownerClock"], after["clock"]["now"])
        native = owner.take_native_result(payload["dispatchId"])
        self.assertEqual(native, expected)
        self.assertIs(native, owner.take_agent_observation(payload["dispatchId"]))
        with self.assertRaisesRegex(NativeBindingError, "^NATIVE_RESULT_UNAVAILABLE$"):
            owner.take_native_result(payload["dispatchId"])
        self.assertEqual(list((root / "json").glob("completed-event-*.json")), [])
        self.assertEqual(len(env.event_log), 0)
        self.assertEqual(owner.manifest(), manifest)
        self.assertIsNone(excluded.write_operation)

    def test_04_excluded_none_to_bool_drift_is_sticky_after_restore(self):
        for effect in (True, False):
            with self.subTest(effect=effect):
                owner, _, env, _, excluded, _ = self.fixture()
                with patch.object(excluded, "write_operation", effect):
                    self.binding_changed(owner)
                self.assertIsNone(excluded.write_operation)
                self.binding_changed(owner)
                self.assertEqual(len(env.event_log), 0)

    def test_05_excluded_function_replacement_is_sticky_after_restore(self):
        owner, _, env, _, excluded, _ = self.fixture()
        original = excluded.function
        with patch.object(excluded, "function", forbidden_replacement):
            self.binding_changed(owner)
        self.assertIs(excluded.function, original)
        self.binding_changed(owner)
        self.assertEqual(len(env.event_log), 0)

    def test_06_excluded_function_defaults_drift_is_sticky_after_restore(self):
        owner, _, env, _, excluded, _ = self.fixture()
        original = excluded.function.__defaults__
        self.assertIsNone(original)
        with patch.object(excluded.function, "__defaults__", ("unexpected",)):
            self.binding_changed(owner)
        self.assertIs(excluded.function.__defaults__, original)
        self.binding_changed(owner)
        self.assertEqual(len(env.event_log), 0)

    def test_07_excluded_argument_metadata_drift_is_sticky_after_restore(self):
        owner, _, env, _, excluded, _ = self.fixture()
        self.assertEqual(excluded.args, [])
        excluded.args.append(AppToolArg(name="unexpected", arg_type="string",
                                       description="changed excluded metadata",
                                       has_default=True, default="changed",
                                       type_obj=str))
        try:
            self.binding_changed(owner)
        finally:
            excluded.args.clear()
        self.assertEqual(excluded.args, [])
        self.binding_changed(owner)
        self.assertEqual(len(env.event_log), 0)

    def test_08_trusted_source_bytes_are_frozen_and_failure_is_sticky(self):
        source = Path(self.temp.name) / "trusted-subset-policy.txt"
        source.write_text("explicit unsupported Shopping subset\n", encoding="utf-8")
        owner, _, env, _, _, _ = self.fixture(sources=(source,))
        self.assertIn(str(source), [ref["path"] for ref in owner.manifest()["sourceRefs"]])
        source.write_text("changed unsupported policy\n", encoding="utf-8")
        self.binding_changed(owner)
        source.write_text("explicit unsupported Shopping subset\n", encoding="utf-8")
        self.binding_changed(owner)
        self.assertEqual(len(env.event_log), 0)

    def assert_getter_excluded(self, owner):
        manifest = owner.manifest()
        self.assertEqual(manifest["schemaVersion"], "gaia2-native-app-binding-v1")
        self.assertFalse(any(tool["canonicalName"].endswith("__get_all_discount_codes")
                             for tool in manifest["tools"]))
        snapshot = owner.excluded_tool_snapshot()
        self.assertEqual(snapshot["toolCount"], 1)
        self.assertEqual(snapshot["tools"][0]["reasonCode"], "NATIVE_TOOL_EFFECT_UNDECLARED")

    def test_09_real_shopping_alias_is_supported_but_same_name_subclass_is_not(self):
        owner, app, env, _, original, _ = self.fixture(app=Shopping())
        self.assertEqual(owner.manifest()["appType"], "are.simulation.apps.shopping.Shopping")
        self.assertEqual(owner.excluded_tool_snapshot()["toolCount"], 0)
        _, _, _, outcome, _ = self.dispatch(owner, self.child(owner), "get_all_discount_codes")
        self.assertEqual(outcome["agentObservation"], {})
        self.assertEqual(len(env.event_log), 0)
        self.assertIsNone(original.write_operation)

        class Impostor(ShoppingApp):
            pass
        # Even matching the canonical class name is not an exact official class.
        Impostor.__name__ = "ShoppingApp"
        owner, _, env, _, _, _ = self.fixture(app=Impostor(name="Shopping"))
        self.assert_getter_excluded(owner)
        self.assertEqual(len(env.event_log), 0)

    def test_10_no_actual_are_clock_means_no_source_return_authority(self):
        owner, _, env, _, _, _ = self.fixture(has_are_clock=False)
        self.assert_getter_excluded(owner)
        self.assertEqual(len(env.event_log), 0)

    def test_11_loaded_function_code_replacement_before_owner_is_not_pinned(self):
        function = ShoppingApp.get_all_discount_codes
        actual_code = function.__code__
        function.__code__ = forbidden_replacement.__code__
        try:
            owner, _, env, _, _, _ = self.fixture()
            self.assert_getter_excluded(owner)
            self.assertEqual(len(env.event_log), 0)
        finally:
            function.__code__ = actual_code

    def test_12_initial_metadata_drift_is_excluded_not_promoted(self):
        for key, value in (("return_type", "any"), ("_public_description", "unreviewed"),
                           ("return_description", "unreviewed")):
            with self.subTest(key=key):
                owner, _, env, _, _, _ = self.fixture(customize=lambda tool: setattr(tool, key, value))
                self.assert_getter_excluded(owner)
                self.assertEqual(len(env.event_log), 0)

    def test_13_disk_bytes_are_not_their_own_trusted_source_pin(self):
        path = ROOT / ".official-python" / "are" / "simulation" / "apps" / "shopping.py"
        actual_read = Path.read_bytes
        def changed_bytes(target):
            data = actual_read(target)
            return data + b"\n# unreviewed-source-drift\n" if target == path else data
        # The owner could capture these changed bytes as its initial baseline;
        # the hard policy must still reject them instead of calling that a pin.
        with patch.object(Path, "read_bytes", changed_bytes):
            owner, _, env, _, _, _ = self.fixture()
            self.assert_getter_excluded(owner)
            self.assertEqual(len(env.event_log), 0)

    def test_14_source_method_flags_and_return_metadata_drift_are_sticky(self):
        for key, value in (("_is_app_tool", False), ("_is_data_tool", False),
                           ("__event_registered__", True)):
            with self.subTest(key=key):
                owner, _, _, _, original, _ = self.fixture()
                with patch.object(original.function, key, value, create=True):
                    self.binding_changed(owner)
                self.binding_changed(owner)
        owner, _, _, _, original, _ = self.fixture()
        with patch.object(original, "return_type", "any"):
            self.binding_changed(owner)
        self.binding_changed(owner)

    def test_15_normal_completed_event_and_final_modes_remain_distinct(self):
        owner, app, env, root, _, _ = self.fixture()
        app.discount_codes = {"item-1": {"SAVE10": 10.0}}
        scope = self.child(owner)
        prepared, _, _, outcome, _ = self.dispatch(owner, scope, "get_discount_code_info", {"discount_code": "SAVE10"})
        self.assertEqual(prepared["completionEvidenceKind"], "are_completed_event")
        self.assertIsNone(prepared["sourcePinId"])
        self.assertEqual(outcome["agentObservation"], {"item-1": 10.0})
        self.assertEqual(len(env.event_log), 1)
        self.assertIsNotNone(outcome["nativeCompletedEventRef"])
        self.assertEqual(self.receipt(root, outcome["nativeCompletedEventRef"])["schemaVersion"],
                         "gaia2-private-native-ce-v1")
        returned = self.receipt(root, outcome["nativeReturnEvidenceRef"])
        self.assertEqual(returned["completionEvidenceKind"], "are_completed_event")
        self.assertIsNone(returned["sourcePinId"])
        self.assertIsNone(returned["nativeRawProjection"])
        self.assertIsNone(returned["ownerClock"])
        prepared, _, _, outcome, _ = self.dispatch(owner, scope, "final_answer", {"answer": "done"})
        self.assertEqual(prepared["completionEvidenceKind"], "child_final_answer")
        self.assertEqual(outcome["status"], "succeeded")
        self.assertIsNone(outcome["nativeCompletedEventRef"])
        returned = self.receipt(root, outcome["nativeReturnEvidenceRef"])
        self.assertEqual(returned["completionEvidenceKind"], "child_final_answer")
        self.assertIsNone(returned["sourcePinId"])
        self.assertIsNone(returned["nativeRawProjection"])
        self.assertIsNone(returned["ownerClock"])
        self.assertEqual(len(env.event_log), 1)

    def test_16_source_read_requires_real_before_clock_and_consumes_no_fake_ce(self):
        owner, _, env, _, _, _ = self.fixture()
        scope = self.child(owner)
        meta = next(tool for tool in owner.manifest()["tools"] if tool["completionEvidenceKind"] == "source_pinned_return")
        prepared = owner.prepare_native({"scope": scope, "toolId": meta["toolId"], "rawArguments": {}})
        with self.assertRaisesRegex(NativeBindingError, "^NATIVE_CLOCK_BEFORE_REQUIRED$"):
            owner.commit_native({"scope": scope, "ticketId": prepared["ticketId"], "dispatchId": str(uuid.uuid4()),
                                 "toolId": meta["toolId"], "effectiveArgumentsHash": prepared["effectiveArgumentsHash"]})
        self.assertEqual(len(env.event_log), 0)

    def test_17_unrelated_actual_event_cannot_stand_in_for_source_return(self):
        state = {"owner": None, "armed": True}
        def clock_factory(app, env):
            def clock():
                owner = state["owner"]
                if owner is not None and owner._NativeAppBinding__active is not None and state["armed"]:
                    state["armed"] = False
                    app.list_cart()  # One actual event, but not this getter's CE.
                return env.time_manager.time()
            return clock
        owner, _, env, root, _, _ = self.fixture(clock_factory=clock_factory)
        state["owner"] = owner
        _, payload, _, outcome, _ = self.dispatch(owner, self.child(owner), "get_all_discount_codes")
        self.assertEqual(outcome["status"], "failed")
        self.assertEqual(outcome["errorCode"], "NATIVE_SOURCE_RETURN_UNEXPECTED_EVENT")
        self.assertIsNone(outcome["agentObservation"])
        self.assertIsNone(outcome["nativeCompletedEventRef"])
        returned = self.receipt(root, outcome["nativeReturnEvidenceRef"])
        self.assertIsNone(returned["nativeRawProjection"])
        self.assertIsNone(returned["ownerClock"])
        self.assertEqual(len(env.event_log), 1)
        self.assertEqual(list((root / "json").glob("completed-event-*.json")), [])
        with self.assertRaisesRegex(NativeBindingError, "^NATIVE_RESULT_UNAVAILABLE$"):
            owner.take_native_result(payload["dispatchId"])

    def test_18_overloaded_container_is_rejected_before_getter_can_execute(self):
        class Dangerous(dict):
            def __iter__(self):
                raise AssertionError("overloaded_container_must_not_execute")
        owner, app, env, _, _, _ = self.fixture()
        app.discount_codes = Dangerous()
        scope = self.child(owner)
        tool = next(tool for tool in owner.manifest()["tools"] if tool["completionEvidenceKind"] == "source_pinned_return")
        with self.assertRaisesRegex(NativeBindingError, "^NATIVE_SOURCE_RETURN_STATE_INVALID$"):
            owner.prepare_native({"scope": scope, "toolId": tool["toolId"], "rawArguments": {}})
        self.assertEqual(len(env.event_log), 0)

    def test_19_arbitrary_undeclared_same_named_tool_is_still_excluded(self):
        class Unreviewed(App):
            def __init__(self):
                super().__init__("Shopping")
                self.calls = 0

            @app_tool()
            def get_all_discount_codes(self) -> dict[str, list[str]]:
                """An undeclared implementation, not an official pure getter.
                :returns: arbitrary fixture value
                """
                self.calls += 1
                return {}
        app = Unreviewed()
        owner, _, env, _, _, public_name = self.fixture(app=app)
        self.assert_getter_excluded(owner)
        self.assertEqual(len(owner.manifest()["tools"]), 1)  # final only
        scope = self.child(owner)
        for tool_id in (public_name, "native-0000"):
            with self.assertRaisesRegex(NativeBindingError, "^NATIVE_TOOL_OR_ARGUMENTS_INVALID$"):
                owner.prepare_native({"scope": scope, "toolId": tool_id, "rawArguments": {}})
        self.assertEqual(app.calls, 0)
        self.assertEqual(len(env.event_log), 0)

    def test_20_fabricated_getter_completed_event_is_not_a_return_permit(self):
        state = {"owner": None, "armed": True}
        def clock_factory(app, env):
            def clock():
                owner = state["owner"]
                if owner is not None and owner._NativeAppBinding__active is not None and state["armed"]:
                    state["armed"] = False
                    app.add_event(CompletedEvent(event_type=EventType.AGENT,
                        event_id="fake-getter-" + uuid.uuid4().hex, event_time=env.time_manager.time(),
                        action=Action(function=ShoppingApp.get_all_discount_codes, args={"self": app},
                                      app=app, operation_type=OperationType.READ),
                        metadata=EventMetadata(return_value={"FAKE": ["not-real"]}, completed=True)))
                return env.time_manager.time()
            return clock
        owner, _, _, root, _, _ = self.fixture(clock_factory=clock_factory)
        state["owner"] = owner
        _, payload, _, outcome, _ = self.dispatch(owner, self.child(owner), "get_all_discount_codes")
        self.assertEqual(outcome["status"], "failed")
        self.assertEqual(outcome["errorCode"], "NATIVE_INTERNAL_EVENT_UNBOUND")
        self.assertIsNone(outcome["agentObservation"])
        self.assertIsNone(outcome["nativeCompletedEventRef"])
        returned = self.receipt(root, outcome["nativeReturnEvidenceRef"])
        self.assertIsNone(returned["nativeRawProjection"])
        self.assertIsNone(returned["ownerClock"])
        self.assertEqual(list((root / "json").glob("completed-event-*.json")), [])
        with self.assertRaisesRegex(NativeBindingError, "^NATIVE_RESULT_UNAVAILABLE$"):
            owner.take_native_result(payload["dispatchId"])

    def test_21_return_owner_clock_is_are_not_injected_operational_clock(self):
        owner, _, _, root, _, _ = self.fixture(clock_factory=lambda app, env: lambda: 0.0)
        _, _, before, outcome, after = self.dispatch(owner, self.child(owner), "get_all_discount_codes")
        returned = self.receipt(root, outcome["nativeReturnEvidenceRef"])
        self.assertGreaterEqual(before["clock"]["now"], 1000.0)
        self.assertGreaterEqual(returned["ownerClock"], before["clock"]["now"])
        self.assertLessEqual(returned["ownerClock"], after["clock"]["now"])
        self.assertNotEqual(returned["ownerClock"], 0.0)

    def test_22_source_read_does_not_wash_earlier_uncertain_write(self):
        owner, _, env, _, _, _ = self.fixture()
        _, _, _, write, _ = self.dispatch(owner, self.child(owner), "add_to_cart", {"item_id": "missing-item"})
        self.assertEqual(write["status"], "unknown")
        scope = self.child(owner)
        _, _, _, read, _ = self.dispatch(owner, scope, "get_all_discount_codes")
        self.assertEqual(read["status"], "succeeded")
        self.assertEqual(read["agentObservation"], {})
        self.assertEqual(len(env.event_log), 1)  # Only the original failed write.
        for name, args in (("add_to_cart", {"item_id": "another-item"}), ("final_answer", {"answer": "done"})):
            meta = next(tool for tool in owner.manifest()["tools"]
                        if tool["canonicalName"].endswith("__" + name) or tool["canonicalName"] == name)
            with self.assertRaisesRegex(NativeBindingError, "^NATIVE_UNRESOLVED_APP_MUTATION$"):
                owner.prepare_native({"scope": scope, "toolId": meta["toolId"], "rawArguments": args})


if __name__ == "__main__":
    unittest.main(verbosity=2)
