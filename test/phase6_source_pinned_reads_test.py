"""Offline shared Shopping read-pin checks; no model or benchmark execution."""

import inspect
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import gaia2_private_native_binding as native_binding
import gaia2_source_pinned_reads as pins
import capybara_official_bridge as bridge
from are.simulation.apps.app import App
from are.simulation.apps.shopping import ShoppingApp, Shopping
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.time_manager import TimeManager
from are.simulation.tool_utils import AppTool, AppToolAdapter, OperationType, app_tool
from are.simulation.tools import Tool


def forbidden_replacement(*args, **kwargs):
    raise AssertionError("getter_or_adapter_must_not_execute_during_pin")


class ExplosiveDict(dict):
    def items(self):
        raise AssertionError("overloaded_items_must_not_execute")

    def __iter__(self):
        raise AssertionError("overloaded_iteration_must_not_execute")


class ExplosiveStr(str):
    def __eq__(self, other):
        raise AssertionError("overloaded_equality_must_not_execute")

    __hash__ = str.__hash__


class SharedSourcePinTests(unittest.TestCase):
    def setUp(self):
        offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        offline.start()
        self.addCleanup(offline.stop)
        self.app, self.env, self.tool = self.fixture()

    def fixture(self, app=None):
        app = app if app is not None else ShoppingApp(name="Shopping")
        env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        env.register_apps([app])
        tool = next(tool for tool in app.get_tools() if tool.func_name == "get_all_discount_codes")
        return app, env, tool

    def pin(self, app=None, tool=None, **kwargs):
        return pins.shopping_getter_read_pin(
            self.app if app is None else app, self.tool if tool is None else tool,
            has_are_clock=kwargs.get("has_are_clock", True))

    def test_01_exact_official_getter_pins_without_call_or_event(self):
        self.app.discount_codes = {"item-1": {"SAVE10": 10}, "item-2": {"SAVE10": 20}}
        before = self.env.time_manager.offset
        self.assertEqual(self.pin(), pins.SOURCE_RETURN_PIN_ID)
        self.assertEqual(len(self.env.event_log), 0)
        self.assertEqual(self.env.time_manager.offset, before)
        self.assertEqual(self.app.discount_codes, {"item-1": {"SAVE10": 10}, "item-2": {"SAVE10": 20}})

    def test_02_default_and_non_boolean_clock_never_grant_authority(self):
        self.assertIsNone(pins.shopping_getter_read_pin(self.app, self.tool))
        class ExplosiveBool:
            def __bool__(self):
                raise AssertionError("clock_truthiness_must_not_execute")
        for authority in (False, None, 0, 1, "true", ExplosiveBool()):
            with self.subTest(authority=type(authority).__name__):
                self.assertIsNone(self.pin(has_are_clock=authority))

    def test_03_real_alias_pins_but_same_name_subclass_does_not(self):
        app, _, tool = self.fixture(Shopping(name="Shopping"))
        self.assertEqual(self.pin(app, tool), pins.SOURCE_RETURN_PIN_ID)
        class ShoppingSubclass(ShoppingApp):
            pass
        app, _, tool = self.fixture(ShoppingSubclass(name="Shopping"))
        self.assertIsNone(self.pin(app, tool))

    def test_04_other_official_shopping_tools_are_not_source_exceptions(self):
        others = [tool for tool in self.app.get_tools() if tool is not self.tool]
        self.assertEqual(len(others), 11)
        for tool in others:
            with self.subTest(tool=tool.func_name):
                self.assertIsNone(self.pin(tool=tool))

    def test_05_same_named_unknown_app_remains_excluded(self):
        class PretendShopping(App):
            @app_tool()
            def get_all_discount_codes(self) -> dict[str, list[str]]:
                """Returns all the discount codes that are available with the items they apply to.

                :return: Dictionary mapping discount codes to list of item IDs they apply to
                """
                raise AssertionError("unknown_getter_must_not_execute")
        app, _, tool = self.fixture(PretendShopping(name="Shopping"))
        self.assertIsNone(self.pin(app, tool))

    def test_06_tool_instance_and_identity_must_be_exact(self):
        other_app, _, _ = self.fixture()
        with patch.object(self.tool, "class_instance", other_app):
            self.assertIsNone(self.pin())
        class AppToolSubclass(AppTool):
            pass
        original_class = type(self.tool)
        try:
            self.tool.__class__ = AppToolSubclass
            self.assertIsNone(self.pin())
        finally:
            self.tool.__class__ = original_class

    def test_07_metadata_drift_is_not_a_pin(self):
        replacements = {
            "class_name": "Shopping", "app_name": "Other", "name": "Other__get_all_discount_codes",
            "_public_name": "renamed", "return_type": "dict", "return_description": "changed",
            "function_description": "changed", "_public_description": "changed", "args": [object()],
            "write_operation": True,
        }
        for field, value in replacements.items():
            with self.subTest(field=field), patch.object(self.tool, field, value):
                self.assertIsNone(self.pin())
        with patch.object(self.tool, "class_name", ExplosiveStr("ShoppingApp")):
            self.assertIsNone(self.pin())

    def test_08_formatter_and_flags_cannot_promote_unknown_effect(self):
        function = self.tool.function
        replacements = {
            "llm_formatter": forbidden_replacement, "__wrapped__": forbidden_replacement,
            "__event_registered__": True, "__operation_type__": OperationType.WRITE,
            "_is_app_tool": False, "_is_data_tool": False, "_is_env_tool": True, "_is_user_tool": True,
        }
        for field, value in replacements.items():
            with self.subTest(field=field), patch.object(function, field, value, create=True):
                self.assertIsNone(self.pin())

    def test_09_signature_defaults_and_annotations_are_pinned(self):
        with patch.object(self.tool.function, "__defaults__", (None,)):
            self.assertIsNone(self.pin())
        with patch.object(self.tool.function, "__kwdefaults__", {"x": None}):
            self.assertIsNone(self.pin())
        with patch.object(self.tool.function, "__annotations__", {"return": dict}):
            self.assertIsNone(self.pin())

    def test_10_all_six_loaded_call_chain_functions_are_pinned(self):
        for function in (self.tool.function, AppTool.__call__, AppToolAdapter.forward, Tool.__call__,
                         pins.official_tools.handle_agent_inputs, pins.official_tools.handle_agent_outputs):
            with self.subTest(function=function.__qualname__):
                original_code = function.__code__
                try:
                    function.__code__ = forbidden_replacement.__code__
                    self.assertIsNone(self.pin())
                finally:
                    function.__code__ = original_code
        self.assertEqual(len(self.env.event_log), 0)

    def test_11_loaded_module_and_function_paths_are_pinned(self):
        for module in (pins.official_shopping, pins.official_tool_utils, pins.official_tools):
            with self.subTest(module=module.__name__), patch.object(module, "__file__", "foreign.py"):
                self.assertIsNone(self.pin())
        with patch.object(inspect, "getsourcefile", return_value="foreign.py"):
            self.assertIsNone(self.pin())

    def test_12_each_reviewed_disk_hash_is_fixed_not_self_derived(self):
        read_bytes = Path.read_bytes
        for relative in pins.SOURCE_RETURN_FILES:
            target = ROOT / ".official-python" / "are" / relative
            def changed(path, target=target):
                data = read_bytes(path)
                return data + b"\n# synthetic drift\n" if path == target else data
            with self.subTest(relative=relative), patch.object(Path, "read_bytes", changed):
                self.assertIsNone(self.pin())

    def test_13_source_unavailable_or_link_is_not_a_pin(self):
        with patch.object(Path, "read_bytes", side_effect=OSError("safe_synthetic_failure")):
            self.assertIsNone(self.pin())
        with patch.object(pins, "_no_links", side_effect=ValueError("SOURCE_PIN_PATH_INVALID")):
            self.assertIsNone(self.pin())

    def test_14_outer_and_inner_overloaded_containers_are_not_iterated(self):
        for state in (ExplosiveDict({"item": {"SAVE": 1}}), {"item": ExplosiveDict({"SAVE": 1})}):
            with self.subTest(kind=type(state).__name__):
                self.app.discount_codes = state
                self.assertIsNone(self.pin())

    def test_15_non_exact_item_and_code_keys_are_rejected(self):
        for state in ({1: {"SAVE": 1}}, {"item": {1: 1}},
                      {ExplosiveStr("item"): {"SAVE": 1}}, {"item": {ExplosiveStr("SAVE"): 1}}):
            self.app.discount_codes = state
            self.assertIsNone(self.pin())

    def test_16_values_not_iterated_by_getter_remain_uninterpreted(self):
        self.app.discount_codes = {"item": {"SAVE": object()}}
        self.assertEqual(self.pin(), pins.SOURCE_RETURN_PIN_ID)

    def test_17_source_and_state_are_separate_for_private_fixed_error(self):
        self.app.discount_codes = ExplosiveDict()
        self.assertEqual(pins.source_return_pin(self.app, self.tool, has_are_clock=True),
                         pins.SOURCE_RETURN_PIN_ID)
        self.assertFalse(pins.source_return_state_is_safe(self.app))
        with self.assertRaisesRegex(native_binding.NativeBindingError, "^NATIVE_SOURCE_RETURN_STATE_INVALID$"):
            native_binding._source_return_state(self.app)

    def test_18_private_owner_freezes_shared_helper_bytes(self):
        with tempfile.TemporaryDirectory(prefix="gaia2-shared-pin-") as temp:
            owner = native_binding.NativeAppBinding(
                self.app, environment_generation="shared-pin-env", parent_execution_id="pin-parent",
                parent_session_id="pin-session", evidence_root=Path(temp) / "owner",
                clock=self.env.time_manager.time, clock_environment=self.env)
            self.addCleanup(owner.close)
            helper = Path(pins.__file__).resolve()
            self.assertIn(str(helper), [ref["path"] for ref in owner.manifest()["sourceRefs"]])
            read_bytes = Path.read_bytes
            def changed(path):
                data = read_bytes(path)
                return data + b"\n# synthetic helper drift\n" if path == helper else data
            with patch.object(Path, "read_bytes", changed):
                with self.assertRaisesRegex(native_binding.NativeBindingError, "^NATIVE_BINDING_CHANGED$"):
                    owner.manifest()
            with self.assertRaisesRegex(native_binding.NativeBindingError, "^NATIVE_BINDING_CHANGED$"):
                owner.manifest()

    def test_19_private_owner_freezes_loaded_shared_policy_functions(self):
        with tempfile.TemporaryDirectory(prefix="gaia2-shared-pin-") as temp:
            owner = native_binding.NativeAppBinding(
                self.app, environment_generation="shared-pin-env", parent_execution_id="pin-parent",
                parent_session_id="pin-session", evidence_root=Path(temp) / "owner",
                clock=self.env.time_manager.time, clock_environment=self.env)
            self.addCleanup(owner.close)
            with patch.object(pins, "source_return_state_is_safe", forbidden_replacement):
                with self.assertRaisesRegex(native_binding.NativeBindingError, "^NATIVE_BINDING_CHANGED$"):
                    owner.manifest()
            with self.assertRaisesRegex(native_binding.NativeBindingError, "^NATIVE_BINDING_CHANGED$"):
                owner.manifest()

    def action(self, env=None):
        return bridge._action_for_tool(self.tool, "controlled-getter", {}, env=env)

    def assert_unknown_action(self, env=None):
        action = self.action(env)
        self.assertEqual(action["effect"], "unknown")
        self.assertFalse(action["idempotent"])
        self.assertFalse(action["authoritativeRead"])

    def test_20_actual_bridge_uses_pin_for_authoritative_read(self):
        action = self.action(self.env)
        self.assertEqual(action["effect"], "read")
        self.assertTrue(action["idempotent"])
        self.assertTrue(action["authoritativeRead"])
        self.assertEqual(action["canonicalName"], "ShoppingApp__get_all_discount_codes")
        self.assertEqual(action["arguments"], {})
        self.assertEqual(len(self.env.event_log), 0)
        self.assertIsNone(self.tool.write_operation)

    def test_21_actual_bridge_without_same_actual_clock_is_unknown(self):
        self.assert_unknown_action()
        self.assert_unknown_action(object())
        foreign = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        self.assert_unknown_action(foreign)
        class TimeManagerSubclass(TimeManager):
            pass
        with patch.object(self.env, "time_manager", TimeManagerSubclass()):
            self.assert_unknown_action(self.env)
        with patch.object(self.app, "time_manager", object()):
            self.assert_unknown_action(self.env)

    def test_22_actual_bridge_nonfinite_negative_bool_clock_is_unknown(self):
        for value in (float("nan"), float("inf"), -1.0, True, None):
            with self.subTest(value=value), patch.object(self.env.time_manager, "time", return_value=value):
                self.assert_unknown_action(self.env)
        with patch.object(self.env.time_manager, "time", side_effect=ValueError("safe_synthetic_clock_failure")):
            self.assert_unknown_action(self.env)

    def test_23_actual_bridge_metadata_formatter_or_container_drift_is_unknown(self):
        with patch.object(self.tool, "return_type", "dict"):
            self.assert_unknown_action(self.env)
        with patch.object(self.tool.function, "llm_formatter", forbidden_replacement):
            self.assert_unknown_action(self.env)
        with patch.object(self.tool.function, "__operation_type__", OperationType.WRITE, create=True):
            self.assert_unknown_action(self.env)
        self.app.discount_codes = ExplosiveDict()
        self.assert_unknown_action(self.env)
        self.app.discount_codes = {"item": ExplosiveDict()}
        self.assert_unknown_action(self.env)

    def test_24_actual_bridge_disk_or_loaded_source_drift_is_unknown(self):
        with patch.object(Path, "read_bytes", side_effect=OSError("safe_synthetic_failure")):
            self.assert_unknown_action(self.env)
        function = self.tool.function
        original_code = function.__code__
        try:
            function.__code__ = forbidden_replacement.__code__
            self.assert_unknown_action(self.env)
        finally:
            function.__code__ = original_code

    def test_25_actual_bridge_ordinary_are_clock_exception_is_unknown(self):
        # Official TimeManager.time raises an ordinary Exception here. This is
        # clock-proof failure only; no actual tool exception is being swallowed.
        with patch.object(self.env.time_manager, "start_time", None):
            self.assert_unknown_action(self.env)
        with patch.object(self.env.time_manager, "time", side_effect=RuntimeError("safe_synthetic_clock_failure")):
            self.assert_unknown_action(self.env)


if __name__ == "__main__":
    unittest.main(verbosity=2)
