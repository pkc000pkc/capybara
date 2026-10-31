"""Offline evidence-path integration. Only the supplied loopback Hook server is reachable.

Synthetic native results, real recovery controller, Bridge raw-view restoration,
Host receipts and Python receipt validation. No model or benchmark loader.
"""
import json
import os
from pathlib import Path
import socket
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / ".official-python")]
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["HF_HUB_OFFLINE"] = "1"
payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
port = payload["port"]
original_connect = socket.socket.connect
def only_host(sock, address):
    if not isinstance(address, tuple) or address[:2] != ("127.0.0.1", port):
        raise AssertionError("No model or external network is allowed")
    return original_connect(sock, address)
socket.socket.connect = only_host

import capybara_official_bridge as bridge
from gaia2_conflict_recovery import ConflictRecoveryController, native_hash
from gaia2_runtime_hooks import RuntimeHookClient

os.environ.update(GAIA2_HOOK_URL=f"http://127.0.0.1:{port}/invoke", GAIA2_HOOK_TOKEN=payload["token"],
                  GAIA2_EXECUTION_ID=payload["executionId"], GAIA2_SESSION_ID=payload["sessionId"],
                  GAIA2_CONFLICT_RECOVERY_ENABLED="1", GAIA2_CONFLICT_RECOVERY_WORKSPACE=payload["workspace"])
client = RuntimeHookClient()
messages = payload["messages"]
native_reads = []
captures = []
now = payload["now"]

def invoke(checkpoint, **kwargs):
    reply = client.invoke(checkpoint, messages=bridge._hook_messages(messages), clock={"now": now, "revision": len(captures) + 1},
                          loop={"iteration": len(captures) + 1}, **kwargs)
    captures.append(reply)
    assert reply["decision"]["action"] == "allow"
    return reply

def native_reader(query):
    # Fixed controlled native fixture, not a callback that can run a mutation.
    assert query["mode"] == "native_read"
    native_reads.append(query["queryHash"])
    action = {"id": "recovery-read-" + str(len(native_reads)), "name": query["queryTool"], "canonicalName": query["queryTool"],
              "effect": "read", "arguments": query["queryArguments"], "mutationKey": query["queryHash"],
              "resourceKey": query["resourceKey"], "authoritativeRead": True, "idempotent": True}
    invoke("before_tool", action=action)
    result = payload["nativeResults"][query["queryHash"]]
    outcome = {"status": "succeeded", "complete": True, "executed": True, "resultHash": native_hash(result), "result": result}
    observation = bridge._tool_observation_metadata(action, outcome, now)
    messages.append({"role": "tool", "tool_call_id": action["id"], "content": json.dumps(result), "observation": observation})
    after = invoke("after_tool", action=action, outcome=outcome)
    return {**observation, "result": result, "sourceRef": after["conflictReceipt"]["sourceReceiptRef"]}

def restore(query):
    return bridge._restore_observation_receipt(query, messages, payload["sourceRef"])

controller = ConflictRecoveryController(Path(payload["workspace"]) / "controlled-evidence",
    payload["executionId"], payload["sessionId"], native_reader,
    lambda: {"userRef": payload["userRef"], "stopped": False}, restore)
result = controller.run(payload["plan"], payload["action"], payload["userRef"], "controlled-recovery")
assert result["status"] == ("delivery_pending" if payload.get("largeEvidence") else "confirmed"), result
assert result["originalWriteExecuted"] is False and result["permissionGranted"] is False
delivery_chunks = 0
if result["status"] == "delivery_pending":
    manifest = controller.get_delivery(result["deliveryId"])
    deliveries = {result["deliveryId"]: {"manifest": manifest, "coverage": []}}
    chunks, provider = {}, []
    for entry in manifest["receipts"]:
        offset = 0
        while offset is not None:
            chunk = controller.read_delivery(result["deliveryId"], entry["receiptIndex"], offset)
            identity = "local-chunk-" + str(len(chunks))
            chunks[identity] = chunk
            provider.append({"role": "tool", "tool_call_id": identity, "content": json.dumps(chunk, ensure_ascii=False, allow_nan=False)})
            offset = chunk["nextOffset"]
    delivery_chunks = len(chunks)
    bridge._mark_evidence_delivery_views(messages, deliveries, chunks, provider[:-1])
    assert not all(row["covered"] for row in deliveries[result["deliveryId"]]["coverage"])
    bridge._mark_evidence_delivery_views(messages, deliveries, chunks, provider)
    assert all(row["covered"] for row in deliveries[result["deliveryId"]]["coverage"])
    again = controller.run(payload["plan"], payload["action"], payload["userRef"], "controlled-recovery-again")
    assert again["deliveryId"] == result["deliveryId"] and len(native_reads) == 1
else:
    restored = [row["actionId"] for row in result["observations"] if row["mode"] == "restore_view"]
    bridge._mark_restored_observation_views(messages, {"recovery-output": restored}, {})
print(json.dumps({"result": result, "messages": messages, "nativeReads": native_reads,
                  "validatedHostReceipts": len(captures), "deliveryChunks": delivery_chunks, "realModelRequests": 0, "writeExecutions": 0}))
