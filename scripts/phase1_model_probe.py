"""Two minimal requests through the exact Actor and ARE Judge model boundaries."""
import hashlib
import json
import os
import time
from pathlib import Path

from capybara_official_bridge import _call_model, install
from are.simulation.agents.are_simulation_agent_config import LLMEngineConfig
from are.simulation.validation.configs import create_judge_engine

install()
results = []
for role in ("actor", "judge"):
    start = time.monotonic()
    try:
        if role == "actor":
            tools = [{"type": "function", "function": {"name": "phase1_ping", "description": "Connectivity-only function; never executed.", "parameters": {"type": "object", "properties": {"value": {"type": "string"}}, "required": ["value"], "additionalProperties": False}}}]
            response = _call_model([{"role": "user", "content": "Call phase1_ping with value phase1_ok. This is only a connectivity check."}], tools, os.environ["GAIA2_PROBE_ACTOR_MODEL"], "local", os.environ["GAIA2_PROBE_ENDPOINT"])
            call = response.choices[0].message.tool_calls[0]
            valid = call.function.name == "phase1_ping" and json.loads(call.function.arguments).get("value") == "phase1_ok"
            text = call.function.arguments
        else:
            engine = create_judge_engine(LLMEngineConfig(model_name=os.environ["GAIA2_PROBE_JUDGE_MODEL"], provider="local", endpoint=os.environ["GAIA2_PROBE_ENDPOINT"]))
            text, _ = engine.chat_completion([{"role": "user", "content": "Reply with exactly PHASE1_JUDGE_OK. This is only a connectivity check."}])
            valid = text.strip() == "PHASE1_JUDGE_OK"
        results.append({"role": role, "status": "passed" if valid else "invalid_response", "elapsedSeconds": round(time.monotonic() - start, 3), "responseChars": len(text), "responseHash": hashlib.sha256(text.encode()).hexdigest()})
    except Exception as error:
        results.append({"role": role, "status": "failed", "category": getattr(error, "category", "runtime_error"), "exceptionType": type(error).__name__, "elapsedSeconds": round(time.monotonic() - start, 3)})

report = {"schemaVersion": "gaia2-phase1-model-probe-v1", "status": "passed" if all(row["status"] == "passed" for row in results) else "failed", "actorModel": os.environ["GAIA2_PROBE_ACTOR_MODEL"], "judgeModel": os.environ["GAIA2_PROBE_JUDGE_MODEL"], "actorBoundary": "capybara_official_bridge._call_model", "judgeBoundary": "ARE create_judge_engine LiteLLMEngine.chat_completion", "results": results, "toolsExecuted": False, "benchmarkExecuted": False}
path = Path(os.environ["GAIA2_PROBE_REPORT"])
with path.open("x", encoding="utf-8") as stream:
    json.dump(report, stream, indent=2)
print(json.dumps(report))
raise SystemExit(0 if report["status"] == "passed" else 2)
