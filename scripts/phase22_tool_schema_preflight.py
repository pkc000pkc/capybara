"""Phase 22 read-only tool-schema budget preflight.

This utility deliberately does not start the ARE runner or call the model.  It
loads one immutable source fixture for each standard capability, builds the
same native OpenAI tool schemas used by the bridge, and reports the effect of
candidate allowlists.  A candidate is diagnostic evidence only: it is not
permitted to mutate an original pass@5 manifest or to claim benchmark
readiness.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any


HISTORY_FUNCTIONS = {
    "get_last_message_from_user",
    "get_last_message_from_agent",
    "get_last_unread_messages",
    "get_all_messages",
}
CAPABILITIES = ("execution", "search", "adaptability", "time", "ambiguity")


def canonical(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            json.dumps(str(key), ensure_ascii=False, separators=(",", ":"))
            + ":"
            + canonical(value[key])
            for key in sorted(value)
        ) + "}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def source_hash(scenario: dict[str, Any]) -> str:
    """Hash the frozen source shape, excluding the runner-injected run number."""
    value = json.loads(json.dumps(scenario, ensure_ascii=False))
    definition = value.get("metadata", {}).get("definition", {})
    if isinstance(definition, dict):
        definition.pop("run_number", None)
    return digest(value)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def find_fixture(fixtures_roots: list[Path], config: str, scenario_id: str) -> Path:
    matches = []
    for fixtures_root in fixtures_roots:
        for path in fixtures_root.rglob("scenario.json"):
            try:
                scenario = read_json(path)
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            if scenario.get("metadata", {}).get("definition", {}).get("scenario_id") != scenario_id:
                continue
            if path.parent.name == config:
                matches.append(path)
    if not matches:
        roots = ", ".join(str(root) for root in fixtures_roots)
        raise RuntimeError(f"fixture not found for {config}/{scenario_id} below {roots}")
    return sorted(matches)[0]


def build_tools(fixture: Path) -> tuple[list[Any], list[dict[str, Any]]]:
    # The official runtime is intentionally imported from the frozen lock, not
    # from a globally installed package.
    from are.simulation.benchmark.scenario_loader import load_scenario
    from are.simulation.apps.system import SystemApp
    from capybara_official_bridge import _compact_provider_tool_schema, _native_openai_tool

    scenario, _ = load_scenario(fixture.read_text(encoding="utf-8"), str(fixture), False)
    if scenario is None:
        raise RuntimeError(f"official loader rejected fixture: {fixture}")
    scenario.initialize()
    all_tools = scenario.get_tools()
    visible = [
        tool for tool in all_tools
        if str(getattr(tool, "func_name", "")) not in HISTORY_FUNCTIONS
    ]
    existing = {f"{tool.class_name}__{tool.func_name}" for tool in visible}
    for tool in SystemApp().get_tools():
        key = f"{tool.class_name}__{tool.func_name}"
        if key not in existing:
            visible.append(tool)
            existing.add(key)
    schemas = [_compact_provider_tool_schema(tool, _native_openai_tool(tool)) for tool in visible]
    return visible, schemas


def budget(schemas: list[dict[str, Any]]) -> dict[str, Any]:
    encoded = json.dumps(
        schemas, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return {
        "toolsCount": len(schemas),
        "toolDefinitionsUtf8Bytes": len(encoded),
        "schemaSha256": hashlib.sha256(encoded).hexdigest(),
    }


def historical_budget(roots: list[Path], config: str) -> dict[str, Any] | None:
    """Read only the already-recorded request summaries from older runs."""
    observed = []
    for root in roots:
        pattern = f"executions/standard-{config}-*/sessions/*/runtime-events.jsonl"
        for path in root.glob(pattern):
            try:
                for line in path.read_text(encoding="utf-8").splitlines():
                    event = json.loads(line)
                    summary = event.get("requestSummary")
                    if event.get("type") == "model_request_attempt" and isinstance(summary, dict):
                        count = summary.get("toolsCount")
                        size = summary.get("toolDefinitionsUtf8Bytes")
                        if isinstance(count, int) and isinstance(size, int):
                            observed.append({"toolsCount": count, "toolDefinitionsUtf8Bytes": size})
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
    if not observed:
        return None
    return {
        "sampleCount": len(observed),
        "maxToolsCount": max(item["toolsCount"] for item in observed),
        "maxToolDefinitionsUtf8Bytes": max(item["toolDefinitionsUtf8Bytes"] for item in observed),
        "samples": [
            {"toolsCount": count, "toolDefinitionsUtf8Bytes": size}
            for count, size in sorted({
                (item["toolsCount"], item["toolDefinitionsUtf8Bytes"])
                for item in observed
            })
        ],
    }


def candidate_reports(tools: list[Any], schemas: list[dict[str, Any]], max_tools: int,
                     max_bytes: int) -> list[dict[str, Any]]:
    names = [str(getattr(tool, "_public_name", "")) for tool in tools]
    full = budget(schemas)
    candidates = []
    for index, name in enumerate(names):
        reduced = [schema for offset, schema in enumerate(schemas) if offset != index]
        measured = budget(reduced)
        candidates.append({
            "removed": [name],
            **measured,
            "withinConfiguredBudget": measured["toolsCount"] <= max_tools
            and measured["toolDefinitionsUtf8Bytes"] <= max_bytes,
        })
    candidates.sort(key=lambda item: (
        not item["withinConfiguredBudget"],
        item["toolDefinitionsUtf8Bytes"],
        item["removed"],
    ))
    return [{"full": full, "singleRemovalCandidates": candidates[:10]}]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--fixtures-root", required=True, action="append")
    parser.add_argument("--historical-run-root", action="append", default=[])
    parser.add_argument("--output")
    # The official live registry includes the two SystemApp tools, so the
    # valid current inventory is 101 tools; the provider byte budget remains
    # the limiting boundary.
    parser.add_argument("--max-tools", type=int, default=101)
    parser.add_argument("--max-bytes", type=int, default=50000)
    args = parser.parse_args()
    if args.max_tools < 1 or args.max_bytes < 1:
        raise SystemExit("budget limits must be positive")

    root = Path(__file__).resolve().parents[1]
    manifest_path = (root / args.manifest).resolve() if not Path(args.manifest).is_absolute() else Path(args.manifest).resolve()
    fixtures_roots = [
        (root / value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
        for value in args.fixtures_root
    ]
    historical_roots = [
        (root / value).resolve() if not Path(value).is_absolute() else Path(value).resolve()
        for value in args.historical_run_root
    ]
    manifest = read_json(manifest_path)
    if manifest.get("schemaVersion") != "gaia2-run-manifest-v1" or manifest.get("mode") != "internal_pass5":
        raise SystemExit("phase22 preflight requires an internal_pass5 manifest")
    missing_roots = [str(path) for path in fixtures_roots if not path.is_dir()]
    if missing_roots:
        raise SystemExit(f"fixtures root is missing: {', '.join(missing_roots)}")

    by_config = {}
    for task in manifest.get("tasks", []):
        config = task.get("config")
        if config not in CAPABILITIES or config in by_config:
            continue
        fixture = find_fixture(fixtures_roots, config, task["scenarioId"])
        scenario = read_json(fixture)
        scenario_hash = digest(scenario)
        source_scenario_hash = source_hash(scenario)
        if scenario_hash != task.get("scenarioHash") and source_scenario_hash != task.get("scenarioHash"):
            raise SystemExit(
                f"fixture hash mismatch for {config}: expected {task.get('scenarioHash')}, got {scenario_hash}"
            )
        tools, schemas = build_tools(fixture)
        report = {
            "config": config,
            "scenarioId": task["scenarioId"],
            "fixture": str(fixture.relative_to(root)).replace(os.sep, "/"),
            "fixtureSource": "historical_native_fixture_read_only",
            "fixtureHash": scenario_hash,
            "sourceScenarioHash": source_scenario_hash,
            "runNumberInjectedByHistoricalRunner": scenario_hash != source_scenario_hash,
            "toolNames": [str(getattr(tool, "_public_name", "")) for tool in tools],
            "budget": budget(schemas),
            "withinConfiguredBudget": budget(schemas)["toolsCount"] <= args.max_tools
            and budget(schemas)["toolDefinitionsUtf8Bytes"] <= args.max_bytes,
            "candidateReports": candidate_reports(tools, schemas, args.max_tools, args.max_bytes),
            "historicalLiveBudget": historical_budget(historical_roots, config),
        }
        live = report["historicalLiveBudget"]
        report["historicalLiveWithinConfiguredBudget"] = (
            live is None
            or (live["maxToolsCount"] <= args.max_tools
                and live["maxToolDefinitionsUtf8Bytes"] <= args.max_bytes)
        )
        by_config[config] = report

    missing = sorted(set(CAPABILITIES) - set(by_config))
    if missing:
        raise SystemExit(f"missing capability fixtures: {', '.join(missing)}")
    output = {
        "schemaVersion": "gaia2-phase22-tool-schema-preflight-v1",
        "manifestPath": str(manifest_path.relative_to(root)).replace(os.sep, "/"),
        "manifestHash": manifest.get("manifestHash"),
        "fixtureRoots": [str(path.relative_to(root)).replace(os.sep, "/") for path in fixtures_roots],
        "historicalRunRoots": [str(path.relative_to(root)).replace(os.sep, "/") for path in historical_roots],
        "limits": {"maxTools": args.max_tools, "maxToolDefinitionsUtf8Bytes": args.max_bytes},
        "modelRequests": 0,
        "officialExecution": False,
        "candidateAllowlistBound": False,
        "capabilities": [by_config[config] for config in CAPABILITIES],
        "allWithinConfiguredBudget": all(item["withinConfiguredBudget"] for item in by_config.values()),
        "allHistoricalLiveWithinConfiguredBudget": all(item["historicalLiveWithinConfiguredBudget"] for item in by_config.values()),
    }
    output_path = Path(args.output) if args.output and Path(args.output).is_absolute() else root / (args.output or str(manifest_path.parent.relative_to(root) / "tool-schema-preflight.json"))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"status": "preflight_complete", "reportPath": str(output_path), "allWithinConfiguredBudget": output["allWithinConfiguredBudget"], "allHistoricalLiveWithinConfiguredBudget": output["allHistoricalLiveWithinConfiguredBudget"], "modelRequests": 0}, ensure_ascii=False, indent=2))
    return 0 if output["allWithinConfiguredBudget"] and output["allHistoricalLiveWithinConfiguredBudget"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
