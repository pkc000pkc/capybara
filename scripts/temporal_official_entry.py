"""Evidence-only bootstrap of the unchanged official benchmark CLI."""
from __future__ import annotations
import copy
import json
import os
from pathlib import Path
import signal
import sys

signal.SIGALRM = getattr(signal, "SIGALRM", signal.SIGTERM)
signal.alarm = getattr(signal, "alarm", lambda _seconds: 0)
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import capybara_official_bridge as bridge
from gaia2_runtime_hooks import RuntimeHookClient

OUTPUT = Path(os.environ["GAIA2_TEMPORAL_EVIDENCE_DIR"]).resolve()
OUTPUT.mkdir(parents=True, exist_ok=False)
original_model = bridge._call_model
model_index = 0
def call_model(messages, tools, model_name, provider, endpoint):
    global model_index
    index = model_index
    model_index += 1
    # No endpoint, credential, or arbitrary provider exception is serialized.
    request = {"index": index, "model": model_name, "messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools)}
    path = OUTPUT / f"model-{index:06d}-input.json"
    with path.open("x", encoding="utf-8") as stream:
        json.dump(request, stream, ensure_ascii=False, default=str)
    result = original_model(messages, tools, model_name, provider, endpoint)
    message = result.choices[0].message
    response = {"index": index, "content": message.content, "toolCalls": [
        {"id": call.id, "name": call.function.name, "arguments": call.function.arguments}
        for call in (message.tool_calls or [])]}
    with (OUTPUT / f"model-{index:06d}-output.json").open("x", encoding="utf-8") as stream:
        json.dump(response, stream, ensure_ascii=False, default=str)
    return result
bridge._call_model = call_model
original_invoke = RuntimeHookClient.invoke
hook_index = 0
def invoke(client, checkpoint, **payload):
    global hook_index
    result = original_invoke(client, checkpoint, **payload)
    index = hook_index
    hook_index += 1
    with (OUTPUT / f"hook-{index:06d}-{checkpoint}.json").open("x", encoding="utf-8") as stream:
        json.dump({"checkpoint": checkpoint, "request": payload, "response": result}, stream, ensure_ascii=False, default=str)
    return result
RuntimeHookClient.invoke = invoke
bridge.install()
from are.simulation.benchmark import main
main()
