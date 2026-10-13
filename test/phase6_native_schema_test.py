"""Native nullable checkout schema and official Trace roundtrips, fully offline.

The three positive checkout cases execute real Shopping AppTools against an
in-memory ARE Environment, not a model, benchmark runner, or invented event.
Invalid empty strings are rejected before execution and by the real importer.
"""

import copy
import json
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
NETWORK_ATTEMPTS = []
MODEL_ATTEMPTS = []


def forbidden_network(*args, **kwargs):
    NETWORK_ATTEMPTS.append(True)
    raise AssertionError("network_forbidden")


def forbidden_model(*args, **kwargs):
    MODEL_ATTEMPTS.append(True)
    raise AssertionError("model_forbidden")


# Restore these patches immediately after imports so discovery does not alter
# another test module's controlled loopback transport or environment.
with patch.dict(os.environ, {"LITELLM_LOCAL_MODEL_COST_MAP": "true",
                             "LITELLM_TELEMETRY": "False"}), \
        patch.object(socket.socket, "connect", forbidden_network), \
        patch.object(socket, "create_connection", forbidden_network), \
        patch.object(socket, "getaddrinfo", forbidden_network):
    import capybara_official_bridge as bridge
    import litellm
    from jsonschema import Draft202012Validator
    from are.simulation.apps.shopping import Item, Product, ShoppingApp
    from are.simulation.data_handler.exporter import JsonScenarioExporter
    from are.simulation.data_handler.importer import JsonScenarioImporter
    from are.simulation.data_handler.models import ExportedTrace, TRACE_V1_VERSION
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.scenarios.scenario import Scenario
    from are.simulation.tool_utils import AppTool, AppToolArg
    from gaia2_argument_preflight import validate_tool_arguments


def nullable_default(self, value: str | None = None):
    raise AssertionError("schema_or_preflight_invoked_fixture")


def nullable_required(self, value: str | None):
    raise AssertionError("schema_or_preflight_invoked_fixture")


def mixed_required(self, value: str | int | None):
    raise AssertionError("schema_or_preflight_invoked_fixture")


def string_required(self, value: str):
    raise AssertionError("schema_or_preflight_invoked_fixture")


def nested_required(self, value: dict):
    raise AssertionError("schema_or_preflight_invoked_fixture")


def fixture_tool(function, arg_type, *, has_default=False, default=None):
    return AppTool(class_name="NativeSchemaFixture", app_name="NativeSchemaFixture",
                   name="NativeSchemaFixture__value", function_description="Pure schema fixture.",
                   args=[AppToolArg(name="value", arg_type=arg_type,
                                    description="Controlled input.", has_default=has_default,
                                    default=default)],
                   function=function, class_instance=object(), write_operation=False)


class NativeSchemaTests(unittest.TestCase):
    def setUp(self):
        for blocker in (patch.object(socket.socket, "connect", forbidden_network),
                        patch.object(socket, "create_connection", forbidden_network),
                        patch.object(socket, "getaddrinfo", forbidden_network),
                        patch.object(bridge, "completion", forbidden_model),
                        patch.object(litellm, "completion", forbidden_model)):
            blocker.start()
            self.addCleanup(blocker.stop)

    def tearDown(self):
        self.assertEqual(NETWORK_ATTEMPTS, [])
        self.assertEqual(MODEL_ATTEMPTS, [])

    def native_fixture(self):
        product = Product(name="Controlled product", product_id="product-1",
                          variants={"item-1": Item(price=100.0, item_id="item-1")})
        app = ShoppingApp(name="Shopping", products={"product-1": product},
                          discount_codes={"item-1": {"SAVE": 10.0}})
        scenario = Scenario(scenario_id="controlled-native-nullable-checkout",
                            apps=[app], run_number=1, config="execution", seed=123,
                            start_time=1000.0, duration=None)
        scenario.initialize()  # Includes complete native app state; no HF recovery.
        env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        env.register_apps([app])
        tools = {tool.func_name: tool for tool in app.get_tools()}
        return app, env, scenario, tools

    def parameters(self, tool):
        return bridge._native_openai_tool(tool)["function"]["parameters"]

    def assert_preflight(self, tool, arguments, valid, reason=None):
        original = copy.deepcopy(arguments)
        with patch.object(AppTool, "__call__", side_effect=AssertionError("preflight_executed_tool")):
            report = validate_tool_arguments(tool, arguments)
        self.assertEqual(arguments, original)
        self.assertIs(report["valid"], valid)
        self.assertEqual(report["reason"], reason)
        return report

    def test_01_nullable_native_label_keeps_both_types_and_description(self):
        source = {"type": "str | None", "description": "Nullable native argument."}
        before = copy.deepcopy(source)
        normalized = bridge._native_json_schema(source)
        self.assertEqual(normalized["type"], ["string", "null"])
        self.assertEqual(normalized["description"], source["description"])
        self.assertEqual(source, before)

    def test_02_real_checkout_schema_allows_omit_null_and_nonempty_not_empty(self):
        _, _, _, tools = self.native_fixture()
        raw = tools["checkout"].to_open_ai()["function"]["parameters"]
        self.assertEqual(raw["properties"]["discount_code"]["type"], "str | None")
        schema = self.parameters(tools["checkout"])
        self.assertEqual(schema["required"], [])
        self.assertIs(schema["additionalProperties"], False)
        self.assertEqual(schema["properties"]["discount_code"]["type"], ["string", "null"])
        self.assertEqual(schema["properties"]["discount_code"]["minLength"], 1)
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
        for arguments in ({}, {"discount_code": None}, {"discount_code": "SAVE"}):
            self.assertTrue(validator.is_valid(arguments))
        for arguments in ({"discount_code": ""}, {"discount_code": 1},
                          {"discount_code": False}, {"unknown": None}):
            self.assertFalse(validator.is_valid(arguments))

    def test_03_default_none_is_optional_without_coercing_explicit_null(self):
        tool = fixture_tool(nullable_default, "str | None", has_default=True)
        schema = self.parameters(tool)
        self.assertEqual(schema["required"], [])
        self.assertEqual(schema["properties"]["value"]["minLength"], 1)
        self.assertEqual(self.assert_preflight(tool, {}, True)["parameterCount"], 1)
        self.assert_preflight(tool, {"value": None}, True)

    def test_04_nullable_without_default_remains_required(self):
        tool = fixture_tool(nullable_required, "str | None")
        schema = self.parameters(tool)
        self.assertEqual(schema["required"], ["value"])
        self.assertEqual(schema["properties"]["value"]["type"], ["string", "null"])
        validator = Draft202012Validator(schema)
        self.assertFalse(validator.is_valid({}))
        self.assertTrue(validator.is_valid({"value": None}))
        self.assert_preflight(tool, {}, False, "argument_binding_failed")
        self.assert_preflight(tool, {"value": None}, True)

    def test_05_mixed_union_does_not_discard_string_integer_or_null(self):
        tool = fixture_tool(mixed_required, "str | int | None")
        schema = self.parameters(tool)
        self.assertEqual(schema["required"], ["value"])
        self.assertEqual(schema["properties"]["value"]["type"], ["string", "integer", "null"])
        validator = Draft202012Validator(schema)
        for value in ("SAVE", 0, 7, None):
            self.assertTrue(validator.is_valid({"value": value}))
            self.assert_preflight(tool, {"value": value}, True)
        self.assertFalse(validator.is_valid({"value": []}))
        self.assert_preflight(tool, {"value": ""}, False, "official_argument_not_roundtrippable")

    def test_06_nonnullable_top_level_string_still_rejects_empty(self):
        tool = fixture_tool(string_required, "str")
        schema = self.parameters(tool)
        self.assertEqual(schema["properties"]["value"]["type"], "string")
        self.assertEqual(schema["properties"]["value"]["minLength"], 1)
        validator = Draft202012Validator(schema)
        self.assertTrue(validator.is_valid({"value": "value"}))
        self.assertFalse(validator.is_valid({"value": ""}))
        self.assertFalse(validator.is_valid({"value": None}))

    def test_07_nested_empty_json_strings_remain_roundtrippable(self):
        list_schema = bridge._native_json_schema({"type": "list[str]"})
        self.assertNotIn("minLength", list_schema["items"])
        self.assertTrue(Draft202012Validator(list_schema).is_valid([""]))
        tool = fixture_tool(nested_required, "dict")
        schema = self.parameters(tool)
        self.assertNotIn("minLength", schema["properties"]["value"])
        arguments = {"value": {"nested": "", "items": [""]}}
        self.assertTrue(Draft202012Validator(schema).is_valid(arguments))
        self.assert_preflight(tool, arguments, True)

    def checkout_roundtrip(self, arguments, expected_discount, expected_total):
        app, env, scenario, tools = self.native_fixture()
        self.assertEqual(tools["add_to_cart"](item_id="item-1", quantity=2), "item-1")
        self.assert_preflight(tools["checkout"], arguments, True)
        self.assertTrue(Draft202012Validator(self.parameters(tools["checkout"])).is_valid(arguments))
        original = copy.deepcopy(arguments)
        order_id = tools["checkout"](**arguments)
        self.assertEqual(arguments, original)
        self.assertEqual(app.cart, {})
        self.assertEqual(len(app.orders), 1)
        self.assertEqual(app.orders[order_id].order_status, "processed")
        self.assertEqual(app.orders[order_id].order_total, expected_total)
        self.assertEqual(app.orders[order_id].order_items["item-1"].quantity, 2)
        actual_events = env.event_log.list_view()
        self.assertEqual([event.function_name() for event in actual_events], ["add_to_cart", "checkout"])
        self.assertIsNone(actual_events[-1].metadata.exception)
        self.assertEqual(actual_events[-1].metadata.return_value, order_id)
        self.assertEqual(actual_events[-1].action.args["discount_code"], expected_discount)

        text = JsonScenarioExporter().export_to_json(env, scenario, scenario.scenario_id)
        trace = ExportedTrace.model_validate_json(text)
        self.assertEqual(trace.version, TRACE_V1_VERSION)
        self.assertFalse(trace.metadata.definition.has_exception)
        self.assertEqual(trace.metadata.definition.scenario_id, scenario.scenario_id)
        self.assertEqual(len(trace.apps), 1)  # Complete embedded state, no online fallback.
        self.assertEqual(len(trace.completed_events), 2)
        parameter = trace.completed_events[-1].action.args[0]
        self.assertEqual(parameter.name, "discount_code")
        self.assertEqual(parameter.value, expected_discount)
        self.assertEqual(parameter.value_type, "str" if expected_discount is not None else None)
        restored, completed, logs = JsonScenarioImporter().import_from_json(text)
        self.assertEqual(restored.scenario_id, scenario.scenario_id)
        self.assertEqual(restored.run_number, 1)
        self.assertEqual(logs, [])
        self.assertEqual(len(completed), 2)
        self.assertEqual(completed[-1].function_name(), "checkout")
        self.assertEqual(completed[-1].action.args, {"discount_code": expected_discount})
        self.assertEqual(completed[-1].metadata.return_value, order_id)
        self.assertIsNone(completed[-1].metadata.exception)
        return json.loads(text)

    def test_08_real_checkout_omitted_parameter_binds_none_and_imports(self):
        self.checkout_roundtrip({}, None, 200.0)

    def test_09_real_checkout_explicit_null_imports_without_coercion(self):
        self.checkout_roundtrip({"discount_code": None}, None, 200.0)

    def test_10_real_checkout_nonempty_discount_executes_and_imports(self):
        self.checkout_roundtrip({"discount_code": "SAVE"}, "SAVE", 180.0)

    def test_11_empty_string_is_rejected_before_native_checkout_mutation(self):
        app, env, _, tools = self.native_fixture()
        tools["add_to_cart"](item_id="item-1", quantity=2)
        before = copy.deepcopy(app.get_state())
        self.assert_preflight(tools["checkout"], {"discount_code": ""}, False,
                              "official_argument_not_roundtrippable")
        self.assertEqual(app.get_state(), before)
        self.assertEqual(app.orders, {})
        self.assertEqual(len(env.event_log), 1)

    def test_12_official_importer_rejects_empty_string_trace_not_rewrites_to_null(self):
        # Explicitly corrupted in-memory negative fixture, not a fabricated
        # successful native execution and not a submitted benchmark result.
        trace = self.checkout_roundtrip({"discount_code": None}, None, 200.0)
        parameter = trace["completed_events"][-1]["action"]["args"][0]
        parameter.update(value="", value_type="str")
        with self.assertRaisesRegex(ValueError, "Non-optional type str cannot be None or empty"):
            JsonScenarioImporter().import_from_json(json.dumps(trace))
        self.assertEqual(parameter["value"], "")


if __name__ == "__main__":
    result = unittest.TextTestRunner(verbosity=2).run(
        unittest.defaultTestLoader.loadTestsFromTestCase(NativeSchemaTests))
    print(json.dumps({"testsRun": result.testsRun,
                      "failures": len(result.failures), "errors": len(result.errors),
                      "externalNetworkAttempts": len(NETWORK_ATTEMPTS),
                      "modelCalls": len(MODEL_ATTEMPTS)}))
    sys.exit(0 if result.wasSuccessful() else 1)
