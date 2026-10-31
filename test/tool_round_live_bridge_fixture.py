"""Actual ARE/Bridge/Host loop, scripted Actor and shared Node scheduler.

Only the supplied authenticated loopback Host is reachable. No real model,
official task, benchmark loader, production credential or evaluator data.
"""
import copy
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / ".official-python")]
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
test_case = payload["case"]
os.environ.update(LITELLM_LOCAL_MODEL_COST_MAP="True", HF_HUB_OFFLINE="1", GAIA2_MODEL_HTTP_GUARD_REQUIRED="0",
    GAIA2_HOOK_URL=f"http://127.0.0.1:{payload['port']}/invoke", GAIA2_HOOK_TOKEN=payload["token"],
    GAIA2_EXECUTION_ID=payload["executionId"], GAIA2_SESSION_ID=payload["sessionId"],
    GAIA2_TOOL_ROUND_WORKSPACE=payload["workspace"], GAIA2_E2E_MAX_ACTIONS="12",
    GAIA2_RETRIEVAL_ENABLED="0", GAIA2_TEMPORAL_ENABLED="0", GAIA2_CONFLICT_RECOVERY_ENABLED="0",
    GAIA2_ENTITY_SEMANTICS_ENABLED="0", GAIA2_TASK_CONTRACT_ENABLED="0", GAIA2_MUTATION_RECEIPTS_ENABLED="0",
    GAIA2_E2E_TOOL_ALLOWLIST="Warehouse__read,AddressBook__read,Reservations__read,Ledger__read,Ledger__write,AgentUserInterface__send_message_to_user,SystemApp__wait_for_notification,SystemApp__get_current_time")
external_attempts = []
original_connect = socket.socket.connect


def only_host(sock, address):
    if not isinstance(address, tuple) or address[:2] != ("127.0.0.1", payload["port"]):
        external_attempts.append(type(address).__name__)
        raise AssertionError("Only the controlled loopback Host may be reached")
    return original_connect(sock, address)


socket.socket.connect = only_host
import capybara_official_bridge as bridge
from are.simulation.apps.agent_user_interface import AgentUserInterface
from are.simulation.apps.app import App
from are.simulation.apps.system import SystemApp
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.scenarios.scenario import Scenario
from are.simulation.scenarios.validation_result import ScenarioValidationResult
from are.simulation.tool_utils import OperationType, app_tool
from are.simulation.types import event_registered
from gaia2_runtime_hooks import RuntimeHookClient

native_order, captures, inputs, events, created_messages = [], [], [], [], []
injection_done = False


def inject_after_first():
    global injection_done
    if injection_done or len(native_order) != 1:
        return
    injection_done = True
    if test_case == "user_update_tail":
        aui.send_message_to_agent("Updated instruction: cancel the remaining queued tool actions.")
    elif test_case == "stop_tail":
        env.stop()


class Resource(App):
    def __init__(self):
        super().__init__()
        self.reads = 0

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def read(self) -> dict:
        """Read fixed synthetic records.
        :returns: actual synthetic records
        """
        self.reads += 1
        native_order.append(self.name + "__read")
        inject_after_first()
        return {"domain": self.name, "records": ["synthetic-record"], "readCount": self.reads}


class Warehouse(Resource):
    pass


class AddressBook(Resource):
    pass


class Reservations(Resource):
    pass


class Ledger(App):
    def __init__(self):
        super().__init__()
        self.values = []
        self.reads = 0

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def read(self) -> dict:
        """Read the actual synthetic ledger.
        :returns: ledger state
        """
        self.reads += 1
        native_order.append("Ledger__read")
        inject_after_first()
        return {"values": list(self.values)}

    @app_tool()
    @event_registered(operation_type=OperationType.WRITE)
    def write(self, value: str) -> dict:
        """Append one actual synthetic value.
        :param value: value to append
        :returns: ledger state
        """
        native_order.append("Ledger__write:" + value)
        self.values.append(value)
        if value == "uncertain":
            raise RuntimeError("Controlled unknown write outcome")
        inject_after_first()
        return {"values": list(self.values)}


class ControlledScenario(Scenario):
    def validate(self, _environment):
        # This is a synthetic fixture verdict, not an official benchmark score.
        self.fixture_validations += 1
        return ScenarioValidationResult(success=True)


warehouse, address_book, reservations, ledger = Warehouse(), AddressBook(), Reservations(), Ledger()
aui, system = AgentUserInterface(), SystemApp()
apps = [warehouse, address_book, reservations, ledger, aui, system]
env = Environment(config=EnvironmentConfig(start_time=1000, duration=3600, verbose=False))
env.register_apps(apps)
scenario = ControlledScenario(scenario_id="synthetic-tool-round-" + test_case, apps=apps, nb_turns=1, start_time=1000, duration=3600)
scenario.fixture_validations = 0
aui.send_message_to_agent("Controlled synthetic batch task. Apply each queued tool once, preserve outcomes and obey interruption boundaries.")

original_invoke = RuntimeHookClient.invoke
original_emit = bridge._emit_runtime_event
original_message = bridge._new_message


def invoke(client, checkpoint, **kwargs):
    result = original_invoke(client, checkpoint, **kwargs)
    captures.append({"checkpoint": checkpoint, "request": copy.deepcopy(kwargs), "response": copy.deepcopy(result)})
    return result


def emit(kind, **kwargs):
    events.append({"type": kind, **copy.deepcopy(kwargs)})
    original_emit(kind, **kwargs)


def new_message(*args, **kwargs):
    result = original_message(*args, **kwargs)
    created_messages.append(result)
    return result


RuntimeHookClient.invoke = invoke
bridge._emit_runtime_event, bridge._new_message = emit, new_message


def call(name, arguments, identity):
    return SimpleNamespace(id=identity, type="function", function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))


def answer(calls):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None, tool_calls=calls))])


if test_case == "read_three":
    first_calls = [call("Warehouse__read", {}, "batch-first"), call("AddressBook__read", {}, "batch-second"), call("Reservations__read", {}, "batch-third")]
elif test_case == "write_two":
    first_calls = [call("Ledger__write", {"value": "one"}, "batch-first"), call("Ledger__write", {"value": "two"}, "batch-second")]
elif test_case == "unknown_tail":
    first_calls = [call("Ledger__write", {"value": "uncertain"}, "batch-first"), call("Ledger__write", {"value": "must-not-run"}, "batch-second"), call("Warehouse__read", {}, "batch-third")]
elif test_case == "hook_block_tail":
    first_calls = [call("Ledger__write", {"value": "block"}, "batch-first"), call("Ledger__write", {"value": "must-not-run"}, "batch-second")]
elif test_case in ("user_update_tail", "stop_tail"):
    first_calls = [call("Warehouse__read", {}, "batch-first"), call("AddressBook__read", {}, "batch-second"), call("Ledger__write", {"value": "must-not-run"}, "batch-third")]
elif test_case == "aui_barrier":
    first_calls = [call("Warehouse__read", {}, "batch-first"), call("AgentUserInterface__send_message_to_user", {"content": "Must not send mixed-batch message"}, "batch-second")]
elif test_case == "wait_barrier":
    first_calls = [call("Warehouse__read", {}, "batch-first"), call("SystemApp__wait_for_notification", {"timeout": 30}, "batch-second")]
elif test_case == "control_barrier":
    first_calls = [call("Warehouse__read", {}, "batch-first"), call("capybara_retrieval_step", {"op": "continue_read"}, "batch-second")]
elif test_case == "invalid_tail":
    first_calls = [call("NotLoaded__read", {}, "batch-first"), call("Ledger__write", {"value": "must-not-run"}, "batch-second")]
else:
    raise AssertionError("Unknown fixed controlled case")


def model(messages, tools, *_args):
    bridge._validate_provider_tool_pairs(messages)
    index = len(inputs)
    inputs.append({"messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools)})
    if index == 0:
        return answer(first_calls)
    if index == 1:
        results = {row.get("tool_call_id"): json.loads(row["content"]) for row in messages if row.get("role") == "tool" and row.get("tool_call_id") in {value.id for value in first_calls}}
        assert set(results) == {value.id for value in first_calls}, results
        if test_case == "user_update_tail":
            assert "Updated instruction: cancel" in json.dumps(messages)
        return answer([call("AgentUserInterface__send_message_to_user", {"content": "Synthetic fixture finished; no benchmark claims."}, "fixture-finish")])
    raise AssertionError("Unexpected extra model turn")


bridge._call_model = model
bridge.install()
try:
    env.start()
    bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default", "controlled-no-model")
finally:
    env.stop()
    if env.thread is not None:
        env.join()

assert not external_attempts
assert env.thread is not None and not env.thread.is_alive()
for entry in inputs:
    bridge._validate_provider_tool_pairs(entry["messages"])
# The internal arrival ledger may legitimately contain a notice between tool
# results. Validate its actual production wire projection, not the raw ledger.
bridge._validate_provider_tool_pairs(bridge._project_temporal_provider_messages(created_messages))
first_ids = {value.id for value in first_calls}
tool_results = [row for row in created_messages if row.get("role") == "tool" and row.get("tool_call_id") in first_ids]
assert len(tool_results) == len(first_calls)
assert {row["tool_call_id"] for row in tool_results} == first_ids
parsed_results = {row["tool_call_id"]: json.loads(row["content"]) for row in tool_results}
if test_case == "read_three":
    assert native_order == ["Warehouse__read", "AddressBook__read", "Reservations__read"], native_order
    assert warehouse.reads == address_book.reads == reservations.reads == 1
elif test_case == "write_two":
    assert native_order == ["Ledger__write:one", "Ledger__write:two"]
    assert ledger.values == ["one", "two"]
elif test_case == "unknown_tail":
    assert native_order == ["Ledger__write:uncertain"] and ledger.values == ["uncertain"]
    assert parsed_results["batch-first"]["status"] == "unknown"
elif test_case in ("user_update_tail", "stop_tail"):
    assert native_order == ["Warehouse__read"] and warehouse.reads == 1 and address_book.reads == 0 and ledger.values == []
else:
    assert native_order == [] and ledger.values == []

if test_case not in ("read_three", "write_two"):
    for identity in first_ids - {"batch-first"}:
        assert parsed_results[identity].get("executed") is False, parsed_results[identity]
if test_case.endswith("_barrier"):
    assert all(value.get("executed") is False for value in parsed_results.values())
assert len(inputs) == (1 if test_case == "stop_tail" else 2), len(inputs)
executed_ids = {row["callId"] for row in events if row["type"] == "tool_call_started" and row["callId"] in first_ids}
before_ids = {row["request"].get("action", {}).get("id") for row in captures if row["checkpoint"] == "before_tool"}
after_ids = {row["request"].get("action", {}).get("id") for row in captures if row["checkpoint"] == "after_tool"}
assert executed_ids <= before_ids and executed_ids <= after_ids, (executed_ids, before_ids, after_ids)
result = {"case": test_case, "status": "passed", "nativeOrder": native_order, "ledgerValues": ledger.values,
    "actorRequests": len(inputs), "originalCallCount": len(first_calls), "originalResultCount": len(tool_results),
    "providerPairsVerified": True, "externalNetworkAttempts": len(external_attempts), "realModelRequests": 0,
    "benchmarkExecuted": False, "environmentThreadJoined": True}
Path(payload["workspace"], "fixture-evidence.json").write_text(json.dumps({**result, "actorInputs": inputs, "createdMessages": created_messages,
    "toolResults": parsed_results, "captures": captures, "runtimeEvents": events}, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(result))
