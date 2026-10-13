"""Controlled Shopping/real-Hook fixture; never a benchmark or model score.

The Node wrapper owns HookHost startup and GAIA2_HOOK_* identity. This script
uses actual unmodified official Shopping tools and an in-memory FakeActor.
Only the wrapper's loopback Hook endpoint is permitted to receive traffic.
"""

import argparse
import copy
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "scripts"))
os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
os.environ.setdefault("LITELLM_TELEMETRY", "False")
NETWORK_ATTEMPTS = []
MODEL_ATTEMPTS = []


def run(case):
    endpoint = urlsplit(os.environ.get("GAIA2_HOOK_URL", ""))
    assert endpoint.scheme == "http" and endpoint.hostname == "127.0.0.1"
    assert endpoint.port and endpoint.path == "/invoke"
    assert not endpoint.username and not endpoint.password and not endpoint.query and not endpoint.fragment
    assert os.environ.get("GAIA2_EXECUTION_ID") and os.environ.get("GAIA2_SESSION_ID")
    # FakeActor deliberately has no SDK attempt and makes no HTTP-proof claim.
    assert os.environ.get("GAIA2_MODEL_HTTP_GUARD_REQUIRED") not in ("1", "true", "True")
    allowed_port = endpoint.port
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_getaddrinfo = socket.getaddrinfo

    def allowed_address(address):
        return (isinstance(address, tuple) and len(address) >= 2
                and address[0] in ("127.0.0.1", "::1") and address[1] == allowed_port)

    def connect(sock, address):
        if not allowed_address(address):
            NETWORK_ATTEMPTS.append(True)
            raise AssertionError("external_network_forbidden")
        return original_connect(sock, address)

    def connect_ex(sock, address):
        if not allowed_address(address):
            NETWORK_ATTEMPTS.append(True)
            raise AssertionError("external_network_forbidden")
        return original_connect_ex(sock, address)

    def getaddrinfo(host, port, *args, **kwargs):
        if host not in ("127.0.0.1", "::1") or port != allowed_port:
            NETWORK_ATTEMPTS.append(True)
            raise AssertionError("external_dns_forbidden")
        return original_getaddrinfo(host, port, *args, **kwargs)

    def forbidden_model(*args, **kwargs):
        MODEL_ATTEMPTS.append(True)
        raise AssertionError("real_model_forbidden")

    # Install the network restrictions before importing the model libraries.
    with patch.object(socket.socket, "connect", connect), \
            patch.object(socket.socket, "connect_ex", connect_ex), \
            patch.object(socket, "getaddrinfo", getaddrinfo):
        import capybara_official_bridge as bridge
        import litellm
        from jsonschema import Draft202012Validator
        from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender
        from are.simulation.apps.shopping import Item, Product, Shopping
        from are.simulation.apps.system import SystemApp
        from are.simulation.data_handler.exporter import JsonScenarioExporter
        from are.simulation.data_handler.importer import JsonScenarioImporter
        from are.simulation.data_handler.models import ExportedTrace, TRACE_V1_VERSION
        from are.simulation.environment import Environment, EnvironmentConfig
        from are.simulation.scenarios.scenario import Scenario, ScenarioValidationResult
        from are.simulation.types import EnvironmentState, EventType
        from gaia2_source_pinned_reads import SOURCE_RETURN_PIN_ID, shopping_getter_read_pin

        class ShoppingScenario(Scenario):
            def validate(self, env):
                self.judge_calls += 1
                assert shopping.cart == {} and len(shopping.orders) == 1
                assert next(iter(shopping.orders.values())).order_total == 200.0
                return ScenarioValidationResult(success=True)

        product = Product(name="Controlled product", product_id="product-1",
                          variants={"item-1": Item(price=100.0, item_id="item-1")})
        shopping = Shopping(name="Shopping", products={"product-1": product},
                            discount_codes={"item-1": {"SAVE": 10.0}})
        aui, system = AgentUserInterface(), SystemApp()
        scenario = ShoppingScenario(scenario_id="controlled-shopping-" + case,
                                    apps=[aui, system, shopping], nb_turns=1,
                                    run_number=1, config="execution", seed=123,
                                    start_time=1000.0, duration=60)
        scenario.judge_calls = 0
        scenario.initialize()  # Embedded native state: no HF recovery or oracle.
        env = Environment(EnvironmentConfig(start_time=1000.0, duration=60, verbose=False))
        env.register_apps([aui, system, shopping])
        env.state = EnvironmentState.RUNNING
        aui.send_message_to_agent("Check the current cart, buy two controlled items without a discount, and verify the order.")
        initial_event_count = len(env.event_log)
        actual_tools = {tool.func_name: tool for tool in shopping.get_tools()}
        getter = actual_tools["get_all_discount_codes"]
        assert shopping_getter_read_pin(shopping, getter, has_are_clock=True) == SOURCE_RETURN_PIN_ID
        getter_action = bridge._action_for_tool(getter, "shopping-getter", {}, env=env)
        assert getter_action["canonicalName"] == "Shopping__get_all_discount_codes"
        assert getter_action["resourceKey"] == "Shopping"
        assert getter_action["effect"] == "read" and getter_action["authoritativeRead"] is True

        checkout_arguments = {} if case == "omit" else {"discount_code": None}
        checkout_schema = bridge._native_openai_tool(actual_tools["checkout"])["function"]["parameters"]
        assert checkout_schema["required"] == []
        assert checkout_schema["properties"]["discount_code"]["type"] == ["string", "null"]
        assert checkout_schema["properties"]["discount_code"]["minLength"] == 1
        assert Draft202012Validator(checkout_schema).is_valid(checkout_arguments)
        steps = [
            ("shopping-getter", "Shopping__get_all_discount_codes", {}),
            ("cart-before", "Shopping__list_cart", {}),
            ("add-to-cart", "Shopping__add_to_cart", {"item_id": "item-1", "quantity": 2}),
            ("cart-after-add", "Shopping__list_cart", {}),
            # The cart changed from empty to nonempty. Confirm the same fresh
            # query again to resolve the existing conflict policy, never bypass it.
            ("cart-after-add-confirm", "Shopping__list_cart", {}),
            ("checkout", "Shopping__checkout", checkout_arguments),
            ("orders-after", "Shopping__list_orders", {}),
            ("finish", "AgentUserInterface__send_message_to_user", {"content": "Controlled order verified."}),
        ]
        events, actor_summaries, observed_results = [], [], {}
        original_emit = bridge._emit_runtime_event

        def emit(kind, **data):
            events.append({"type": kind, **data})
            original_emit(kind, **data)

        def fake_actor(messages, tools, *unused):
            assert env.state == EnvironmentState.PAUSED
            index = len(actor_summaries)
            assert index < len(steps), "FakeActor continued unexpectedly"
            if index:
                previous_id = steps[index - 1][0]
                observations = [message for message in messages if message.get("tool_call_id") == previous_id]
                assert len(observations) == 1
                payload = json.loads(observations[0]["content"])
                assert not (type(payload) is dict and payload.get("status") in
                            ("blocked", "unknown", "failed_before_execution")), "controlled_step_did_not_execute"
                observed_results[previous_id] = copy.deepcopy(payload)
                if previous_id == "shopping-getter":
                    assert payload == {"SAVE": ["item-1"]}
                    assert len(env.event_log) == initial_event_count  # No invented getter CE.
                elif previous_id == "cart-before":
                    assert payload == {} and shopping.cart == {} and shopping.orders == {}
                elif previous_id == "add-to-cart":
                    assert payload == "item-1" and shopping.cart["item-1"].quantity == 2
                elif previous_id in ("cart-after-add", "cart-after-add-confirm"):
                    assert type(payload) is dict and set(payload) == {"item-1"}
                    assert shopping.cart["item-1"].quantity == 2
                    if previous_id == "cart-after-add-confirm":
                        assert payload == observed_results["cart-after-add"]
                elif previous_id == "checkout":
                    assert shopping.cart == {} and len(shopping.orders) == 1
                    assert payload == next(iter(shopping.orders))
                    assert shopping.orders[payload].order_total == 200.0
                elif previous_id == "orders-after":
                    assert type(payload) is dict and set(payload) == set(shopping.orders)
            call_id, name, arguments = steps[index]
            actor_summaries.append({"callId": call_id, "tool": name,
                                    "nativeCompletedEvents": len(env.event_log),
                                    "cartQuantity": sum(item.quantity for item in shopping.cart.values()),
                                    "orderCount": len(shopping.orders)})
            call = SimpleNamespace(id=call_id, function=SimpleNamespace(
                name=name, arguments=json.dumps(arguments, allow_nan=False)))
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=[call]))])

        with patch.object(bridge, "_call_model", fake_actor), \
                patch.object(bridge, "_emit_runtime_event", emit), \
                patch.object(bridge, "completion", forbidden_model), \
                patch.object(litellm, "completion", forbidden_model):
            validation = bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env,
                                                       "default", "controlled-no-model")
        assert validation.success and scenario.judge_calls == 1
        assert len(actor_summaries) == len(steps)
        assert not any(event["type"] == "tool_call_blocked" for event in events)
        assert not any(event["type"] in ("model_request_attempt", "model_request_failed") for event in events)
        started = [event for event in events if event["type"] == "tool_call_started"]
        completed = [event for event in events if event["type"] == "tool_call_completed"]
        assert [event["callId"] for event in started] == [step[0] for step in steps]
        assert [event["callId"] for event in completed] == [step[0] for step in steps]
        assert all(event["status"] == "succeeded" and event["ok"] for event in completed)
        assert started[0]["effect"] == "read"
        getter_completed = completed[0]
        assert getter_completed["resultHash"] == bridge._stable_hash({"SAVE": ["item-1"]})
        checkout_completed = next(event for event in completed if event["callId"] == "checkout")
        assert [message.content for message in aui.messages if message.sender == Sender.AGENT] == ["Controlled order verified."]
        ended = next(event for event in reversed(events) if event["type"] == "attempt_execution_ended")
        assert ended["terminationReason"] == "conversation_turn_limit"
        assert ended["evaluationAttempted"] is True
        assert ended["usage"]["toolsExecuted"] == 8 and ended["usage"]["blockedTools"] == 0
        assert ended["usage"]["completedTurns"] == 1 and ended["usage"]["unknownMutationOutcomes"] == 0

        native_events = env.event_log.list_view()
        agents = [event for event in native_events if event.event_type == EventType.AGENT]
        expected_functions = ["list_cart", "add_to_cart", "list_cart", "list_cart",
                              "checkout", "list_orders", "send_message_to_user"]
        assert [event.function_name() for event in agents] == expected_functions
        assert all(event.metadata.exception is None for event in native_events)
        assert not any(event.function_name() == "get_all_discount_codes" for event in native_events)
        checkout_native = next(event for event in agents if event.function_name() == "checkout")
        assert checkout_native.action.args["discount_code"] is None
        order_id = next(iter(shopping.orders))
        assert checkout_native.metadata.return_value == order_id

        text = JsonScenarioExporter().export_to_json(env, scenario, scenario.scenario_id)
        trace = ExportedTrace.model_validate_json(text)
        assert trace.version == TRACE_V1_VERSION and not trace.metadata.definition.has_exception
        assert trace.metadata.definition.scenario_id == scenario.scenario_id
        assert len(trace.apps) == 3 and len(trace.completed_events) == len(native_events)
        checkout_exported = next(event for event in trace.completed_events if event.action.function == "checkout")
        assert len(checkout_exported.action.args) == 1
        parameter = checkout_exported.action.args[0]
        assert parameter.name == "discount_code" and parameter.value is None and parameter.value_type is None
        restored, imported_events, logs = JsonScenarioImporter().import_from_json(text)
        assert restored.scenario_id == scenario.scenario_id and restored.run_number == 1
        assert len(imported_events) == len(native_events) and logs == []
        checkout_imported = next(event for event in imported_events if event.function_name() == "checkout")
        assert checkout_imported.action.args == {"discount_code": None}
        assert checkout_imported.metadata.return_value == order_id
        assert not NETWORK_ATTEMPTS and not MODEL_ATTEMPTS
        return {
            "case": case, "status": "passed", "syntheticFixtureOnly": True,
            "benchmarkExecuted": False, "officialSubmissionReady": False,
            "realModelCalls": len(MODEL_ATTEMPTS), "externalNetworkAttempts": len(NETWORK_ATTEMPTS),
            "fakeActorSteps": len(actor_summaries), "actorSummaries": actor_summaries,
            "validationCalls": scenario.judge_calls, "events": events, "usage": ended["usage"],
            "expectedCallIds": [step[0] for step in steps],
            "getter": {"callId": "shopping-getter", "canonicalName": getter_action["canonicalName"],
                       "resourceKey": "Shopping", "effect": "read", "authoritativeRead": True,
                       "sourcePinId": SOURCE_RETURN_PIN_ID, "projectedResult": {"SAVE": ["item-1"]},
                       "resultHash": getter_completed["resultHash"], "nativeCompletedEventDelta": 0},
            "checkout": {"callId": "checkout", "canonicalName": "Shopping__checkout",
                         "arguments": checkout_arguments, "boundNativeArguments": {"discount_code": None},
                         "resultHash": checkout_completed["resultHash"], "orderId": order_id,
                         "nativeCompletedEventId": checkout_native.event_id, "orderTotal": 200.0},
            "nativeCompletedEvents": [{"eventId": event.event_id, "eventType": event.event_type.value,
                                       "function": event.function_name()} for event in native_events],
            "trace": {"version": trace.version, "scenarioId": restored.scenario_id,
                      "runNumber": restored.run_number, "embeddedApps": len(trace.apps),
                      "completedEventCount": len(imported_events), "exportSchemaValid": True,
                      "officialImportValid": True, "checkoutArguments": checkout_imported.action.args},
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Synthetic Shopping/real Hook fixture; no model or benchmark.")
    parser.add_argument("--case", choices=("omit", "null"), required=True)
    arguments = parser.parse_args()
    print("SHOPPING_HOOK_AUDIT:" + json.dumps(run(arguments.case), allow_nan=False))
