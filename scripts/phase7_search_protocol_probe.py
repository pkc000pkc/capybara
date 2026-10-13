"""Probe the frozen Search tool schema without running ARE or executing tools.

The probe reconstructs the same native tool list used by the official bridge,
then optionally sends one ``tool_choice=none`` request to the configured
OpenAI-compatible endpoint. It records only safe counts, names and provider
status; response bodies and credentials never enter the report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "scripts"))

from are.simulation.benchmark.scenario_loader import load_scenario  # noqa: E402
from are.simulation.apps.system import SystemApp  # noqa: E402
from capybara_official_bridge import _compact_provider_tool_schema, _native_openai_tool  # noqa: E402


HISTORY_FUNCTIONS = frozenset({
    "get_last_message_from_user", "get_last_message_from_agent",
    "get_last_unread_messages", "get_all_messages",
})
ALLOWED_TYPES = frozenset({"string", "number", "integer", "boolean", "array", "object"})


def _credentials(path: Path) -> tuple[str, str]:
    lines = path.read_text(encoding="utf-8").splitlines()
    base = next((line.split(":", 1)[1].strip() for line in lines if re.match(r"^base_url\s*:", line, re.I)), None)
    key = next((re.split(r"[:=]", line, maxsplit=1)[1].strip() for line in lines if re.match(r"^key\s*[:=]", line, re.I)), None)
    if not base or not key:
        raise ValueError("credential source must contain base_url and key")
    return base.rstrip("/"), key


def _safe_tool_summary(tools: list[dict]) -> tuple[list[str], list[dict]]:
    names = []
    invalid = []
    for index, tool in enumerate(tools):
        function = tool.get("function", {})
        name = function.get("name")
        names.append(name)
        parameters = function.get("parameters")
        if not isinstance(name, str) or not name or len(name) > 64:
            invalid.append({"index": index, "kind": "name"})
        if not isinstance(parameters, dict) or parameters.get("type") != "object" or parameters.get("additionalProperties") is not False:
            invalid.append({"index": index, "kind": "parameters"})
        for property_name, value in (parameters.get("properties", {}) if isinstance(parameters, dict) else {}).items():
            if not isinstance(value, dict) or value.get("type") not in ALLOWED_TYPES:
                invalid.append({"index": index, "kind": "property", "property": property_name})
    return names, invalid


def _probe(endpoint: str, key: str, model: str, tools: list[dict]) -> dict:
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": "You are a connectivity probe."}, {"role": "user", "content": "Reply exactly PROBE_OK."}],
        "tools": tools,
        "tool_choice": "none",
        "max_tokens": 8,
    }
    request = Request(endpoint + "/chat/completions", data=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), headers={"authorization": f"Bearer {key}", "content-type": "application/json"}, method="POST")
    try:
        with urlopen(request, timeout=35) as response:
            return {"httpStatus": response.status, "ok": 200 <= response.status < 300}
    except HTTPError as error:
        return {"httpStatus": error.code, "ok": False, "errorType": "http_error"}
    except (URLError, TimeoutError):
        return {"httpStatus": None, "ok": False, "errorType": "transport_error"}


def _read_first_scenario(path: str) -> str:
    """Read the scenario JSON from either official parquet layout.

    Older local fixtures exposed a ``scenario`` column.  The current official
    validation datasets expose the same JSON under ``data``.  The probe is
    read-only and should accept both layouts so a schema failure is not
    confused with a model or provider failure.
    """
    schema = pq.read_schema(path)
    if "scenario" in schema.names:
        column = "scenario"
    elif "data" in schema.names:
        column = "data"
    else:
        raise ValueError("parquet fixture must contain a scenario or data column")
    value = pq.read_table(path, columns=[column]).column(column)[0].as_py()
    if isinstance(value, bytes):
        value = value.decode("utf-8")
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if not isinstance(value, str) or not value:
        raise ValueError(f"parquet {column} value must be non-empty JSON text")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--parquet", required=True)
    parser.add_argument("--credentials", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--execute-probe", action="store_true")
    args = parser.parse_args()

    scenario_json = _read_first_scenario(args.parquet)
    scenario, _ = load_scenario(scenario_json, args.parquet, False)
    if scenario is None:
        raise ValueError("frozen scenario could not be loaded")
    scenario.initialize()
    native = []
    for tool in scenario.get_tools():
        if str(tool.class_name) == "AgentUserInterface" and str(tool.func_name) in HISTORY_FUNCTIONS:
            continue
        native.append(_compact_provider_tool_schema(tool, _native_openai_tool(tool)))
    # The live official bridge admits the two read-only SystemApp tools even
    # when the imported scenario JSON does not list SystemApp explicitly.
    # Include them here so the offline probe measures the same 101-tool
    # request that the actor actually sends.
    existing = {tool["function"]["name"] for tool in native}
    for tool in SystemApp().get_tools():
        converted = _compact_provider_tool_schema(tool, _native_openai_tool(tool))
        if converted["function"]["name"] not in existing:
            native.append(converted)
            existing.add(converted["function"]["name"])
    names, invalid = _safe_tool_summary(native)
    encoded = json.dumps(native, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    report = {
        "schemaVersion": "gaia2-phase7-search-protocol-probe-v1",
        "scenarioId": scenario.scenario_id,
        "model": args.model,
        "toolCount": len(native),
        "toolDefinitionsUtf8Bytes": len(encoded),
        "toolNames": names,
        "invalidToolDefinitions": invalid,
        "benchmarkExecution": False,
        "toolsExecuted": False,
        "networkProbeRequested": args.execute_probe,
        "toolInventoryHash": hashlib.sha256(encoded).hexdigest(),
    }
    if args.execute_probe:
        endpoint, key = _credentials(Path(args.credentials))
        report["networkProbe"] = _probe(endpoint, key, args.model, native)
    Path(args.output).write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: report[key] for key in ("schemaVersion", "scenarioId", "toolCount", "toolDefinitionsUtf8Bytes", "invalidToolDefinitions", "networkProbeRequested", "networkProbe") if key in report}, ensure_ascii=False))
    return 0 if not report["invalidToolDefinitions"] and report.get("networkProbe", {"ok": True})["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
