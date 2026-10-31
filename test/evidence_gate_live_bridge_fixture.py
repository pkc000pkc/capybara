"""Real ARE loop + real Hook Host, scripted Actor, synthetic data only."""
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
os.environ.update(LITELLM_LOCAL_MODEL_COST_MAP="True", HF_HUB_OFFLINE="1", GAIA2_MODEL_HTTP_GUARD_REQUIRED="0",
    GAIA2_HOOK_URL=f"http://127.0.0.1:{payload['port']}/invoke", GAIA2_HOOK_TOKEN=payload["token"],
    GAIA2_EXECUTION_ID=payload["executionId"], GAIA2_SESSION_ID=payload["sessionId"],
    GAIA2_CONFLICT_RECOVERY_ENABLED="1", GAIA2_CONFLICT_RECOVERY_WORKSPACE=payload["workspace"],
    GAIA2_E2E_TOOL_ALLOWLIST="Records__read,Records__write,AgentUserInterface__send_message_to_user")
original_connect = socket.socket.connect
def only_host(sock, address):
    if not isinstance(address, tuple) or address[:2] != ("127.0.0.1", payload["port"]):
        raise AssertionError("No model endpoint or external network is allowed")
    return original_connect(sock, address)
socket.socket.connect = only_host

import capybara_official_bridge as bridge
from are.simulation.apps.agent_user_interface import AgentUserInterface
from are.simulation.apps.app import App
from are.simulation.apps.system import SystemApp
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.scenarios.scenario import Scenario
from are.simulation.tool_utils import OperationType, app_tool
from are.simulation.types import event_registered
from gaia2_runtime_hooks import RuntimeHookClient

class Records(App):
    def __init__(self):
        super().__init__(); self.items = []; self.reads = 0
    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def read(self) -> dict:
        """Read synthetic records.
        :returns: records
        """
        self.reads += 1; return {"records": list(self.items), **({"rawOriginal": "x" * (80 * 1024)} if payload.get("largeEvidence") else {})}
    @app_tool()
    @event_registered(operation_type=OperationType.WRITE)
    def write(self, value: str) -> dict:
        """Append a synthetic record.
        :param value: record value
        :returns: records
        """
        self.items.append(value); return {"records": list(self.items)}

records, aui, system = Records(), AgentUserInterface(), SystemApp()
apps = [records, aui, system]
env = Environment(config=EnvironmentConfig(start_time=1000, duration=3600, verbose=False))
env.register_apps(apps)
scenario = Scenario(scenario_id="generic-evidence-live-loop", apps=apps, nb_turns=1, start_time=1000, duration=3600)
aui.send_message_to_agent("Controlled records scenario: inspect, append once, then report.")
captures, inputs = [], []
invoke_original = RuntimeHookClient.invoke
def invoke(client, checkpoint, **kwargs):
    result = invoke_original(client, checkpoint, **kwargs)
    captures.append({"checkpoint": checkpoint, "request": copy.deepcopy(kwargs), "response": copy.deepcopy(result)})
    return result
RuntimeHookClient.invoke = invoke

compact_original = bridge._compact_model_input
def compact(messages, tools, **kwargs):
    projected, metadata = compact_original(messages, tools, **kwargs)
    # Controlled presentation loss: remove the entire balanced read group from
    # provider input, preserving raw Bridge history. No false tool metadata.
    if any(row.get("tool_call_id") == "live-read" for row in projected):
        projected = [row for row in projected if row.get("tool_call_id") != "live-read"
                     and not any(call.get("id") == "live-read" for call in row.get("tool_calls", []))]
        metadata = {**metadata, "compacted": True,
                    "hiddenToolCallIds": sorted(set(metadata.get("hiddenToolCallIds", [])) | {"live-read"})}
    bridge._validate_provider_tool_pairs(projected)
    return projected, metadata
bridge._compact_model_input = compact

def answer(name, args, identity):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None,
        tool_calls=[SimpleNamespace(id=identity, function=SimpleNamespace(name=name, arguments=json.dumps(args)))]))])

pending_delivery = None
next_receipt = 0
next_offset = 0
explicit_sent = False
delivery_reads = 0

def model(messages, tools, *_args):
    global pending_delivery, next_receipt, next_offset, explicit_sent, delivery_reads
    bridge._validate_provider_tool_pairs(messages)
    index = len(inputs); inputs.append(copy.deepcopy(messages))
    if index == 0: return answer("Records__read", {}, "live-read")
    if index == 1: return answer("Records__write", {"value": "one"}, "blocked-write")
    if index == 2:
        result = json.loads(next(row["content"] for row in reversed(messages) if row.get("tool_call_id") == "blocked-write"))
        recovery = result["conflictRecovery"]
        if payload.get("largeEvidence"):
            assert recovery["status"] == "delivery_pending", recovery
            assert recovery["recoveryStatus"] == "confirmed" and recovery["originalWriteExecuted"] is False
            assert records.items == [] and records.reads == 1
            pending_delivery = recovery
        else:
            assert recovery["status"] == "confirmed", recovery
            assert recovery["restoredViewCount"] == 1 and recovery["nativeReadCount"] == 0
            assert recovery["recheckDecision"] == "allow"
            assert recovery["originalWriteExecuted"] is False and records.items == []
            assert any("Conflict recovery contract:" in row.get("content", "") for row in messages if row["role"] == "system")
            return answer("Records__write", {"value": "one"}, "explicit-write")
    if payload.get("largeEvidence") and pending_delivery and not explicit_sent:
        previous = next((row for row in reversed(messages) if row.get("name") == "capybara_evidence_read"), None)
        if previous is not None:
            chunk = json.loads(previous["content"])
            if chunk.get("schemaVersion") == "gaia2-evidence-block-reference-v1":
                assert any("gaia2-evidence-projection-v1" in row.get("content", "") for row in messages if row["role"] == "system")
                next_receipt, next_offset = chunk["receiptIndex"] + 1, 0
            elif chunk["nextOffset"] is None:
                next_receipt = chunk["receiptIndex"] + 1
                next_offset = 0
            else:
                next_receipt, next_offset = chunk["receiptIndex"], chunk["nextOffset"]
        if next_receipt < pending_delivery["receiptCount"]:
            delivery_reads += 1
            return answer("capybara_evidence_read", {"deliveryId": pending_delivery["deliveryId"], "receiptIndex": next_receipt,
                "offset": next_offset}, "chunk-" + str(delivery_reads))
        explicit_sent = True
        assert records.items == [] and records.reads == 1
        assert any("x" * (80 * 1024) in row.get("content", "") for row in messages if row["role"] == "system")
        return answer("Records__write", {"value": "one"}, "explicit-write")
    if index == 3 or explicit_sent:
        assert records.items == ["one"]
        return answer("AgentUserInterface__send_message_to_user", {"content": "Controlled write completed once."}, "finish")
    raise AssertionError("Unexpected extra scripted Actor turn")
bridge._call_model = model
bridge.install()
try:
    env.start()
    bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default", "no-model")
finally:
    env.stop()
    if env.thread is not None: env.join()
assert records.items == ["one"] and records.reads == 1 and len(inputs) == 4 + delivery_reads
assert not env.thread.is_alive()
result = {"status": "passed", "scriptedActorCalls": len(inputs), "nativeReads": records.reads,
          "explicitNativeWrites": len(records.items), "automaticWriteReplays": 0,
          "realModelRequests": 0, "deliveryChunks": delivery_reads, "validatedHostReceipts": len(captures), "environmentThreadJoined": True}
Path(payload["workspace"], "bridge-loop-report.json").write_text(json.dumps({**result, "captures": captures, "actorInputs": inputs}, indent=2), encoding="utf-8")
print(json.dumps(result))
