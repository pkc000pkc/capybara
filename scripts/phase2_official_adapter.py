"""Offline, pinned-ARE result construction and reconstruction; never uploads.

The Node caller owns run/state/hash provenance checks. This boundary deliberately
uses ARE's own envelope writer, trace importer, HF row constructor and schema,
with a strict preflight before the permissive official reconstruction helpers.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import uuid


class AdapterRejected(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class Phase2TechnicalFailure(Exception):
    """A category-only wrapper: no raw provider/exception text is exported."""


FUNCTIONS = [
    "are.simulation.multi_scenario_runner._export_benchmark_result_jsonl",
    "are.simulation.data_handler.models.ExportedTrace.model_validate_json",
    "are.simulation.data_handler.importer.JsonScenarioImporter.import_from_json",
    "are.simulation.benchmark.gaia2_upload_script.reconstruct_results_from_output_dir",
    "are.simulation.benchmark.report_stats.combine_results_to_dataframe",
    "are.simulation.benchmark.report_stats.build_trace_rows_polars",
    "are.simulation.benchmark.hf_upload_utils.create_hf_schema",
    "pyarrow.Table.from_pylist",
    "datasets.Dataset",
    "are.simulation.benchmark.report_stats.generate_json_stats_report",
]
PHASES = {"standard", "agent2agent", "noise"}
CAPABILITIES = {"execution", "search", "adaptability", "time", "ambiguity"}
SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$")
SAFE_CATEGORY = re.compile(r"^[a-z][a-z0-9_]{0,79}$")
TRACE_FIELDS = {"world_logs", "apps", "events", "completed_events", "version", "context", "augmentation", "metadata"}


def reject(condition: bool, code: str) -> None:
    if condition:
        raise AdapterRejected(code)


def absolute_path(value, code: str) -> Path:
    reject(not isinstance(value, str) or not Path(value).is_absolute(), code)
    path = Path(value)
    for candidate in (path, *path.parents):
        reject(link_like(candidate), "symlink_not_allowed")
    return path.resolve()


def link_like(path: Path) -> bool:
    # Windows directory junctions also redirect traversal outside the package,
    # but are not classified as symlinks by pathlib.is_symlink().
    return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())


def package_path(root: Path, relative: str, *, must_exist: bool = True) -> Path:
    reject(not isinstance(relative, str) or not relative, "invalid_package_path")
    reject("\\" in relative or ":" in relative, "nonportable_package_path")
    portable = PurePosixPath(relative)
    reject(portable.is_absolute() or any(part in {".", ".."} for part in portable.parts), "external_package_path")
    reject(portable.as_posix() != relative, "noncanonical_package_path")
    candidate = root.joinpath(*portable.parts)
    for node in (candidate, *candidate.parents):
        reject(link_like(node), "symlink_not_allowed")
        if node == root:
            break
    resolved = candidate.resolve()
    reject(not resolved.is_relative_to(root), "external_package_path")
    if must_exist:
        reject(not candidate.is_file(), "missing_package_file")
    return candidate


def strict_json(text: str):
    def pairs(values):
        obj = {}
        for key, value in values:
            reject(key in obj, "duplicate_json_key")
            obj[key] = value
        return obj

    def invalid_number(_):
        raise AdapterRejected("nonfinite_json_number")

    return json.loads(text, object_pairs_hook=pairs, parse_constant=invalid_number)


def json_lines(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            value = strict_json(line)
            reject(not isinstance(value, dict), "invalid_jsonl_row")
            rows.append(value)
    reject(not rows, "empty_jsonl_file")
    return rows


def write_json_new(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


def write_lines_new(path: Path, rows: list[dict]) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False, allow_nan=False) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


@contextlib.contextmanager
def working_directory(root: Path):
    previous = Path.cwd()
    os.chdir(root)
    try:
        yield
    finally:
        os.chdir(previous)


def identity(phase, config, scenario_id, run_number) -> tuple[str, str, str, int]:
    reject(phase not in PHASES, "unsupported_phase")
    reject(not isinstance(config, str), "invalid_config")
    reject(config not in (CAPABILITIES if phase == "standard" else {"mini"}), "invalid_phase_config")
    reject(not isinstance(scenario_id, str) or not scenario_id or len(scenario_id) > 500, "invalid_scenario_id")
    reject(type(run_number) is not int or run_number < 1, "invalid_run_number")
    return phase, config, scenario_id, run_number


def validate_trace(path: Path, key: tuple[str, str, str, int], *, scored: bool):
    from are.simulation.data_handler.importer import JsonScenarioImporter
    from are.simulation.data_handler.models import ExportedTrace, TRACE_V1_VERSION

    raw = path.read_bytes()
    text = raw.decode("utf-8")
    parsed = strict_json(text)
    reject(not isinstance(parsed, dict) or not TRACE_FIELDS.issubset(parsed), "trace_missing_field")
    reject(any(not isinstance(parsed[field], list) for field in ("world_logs", "apps", "events", "completed_events")), "trace_invalid_list")
    trace = ExportedTrace.model_validate_json(text)
    reject(trace.version != TRACE_V1_VERSION, "unsupported_trace_version")
    definition = trace.metadata.definition
    phase, config, scenario_id, run_number = key
    reject(definition.scenario_id != scenario_id or type(definition.run_number) is not int or definition.run_number != run_number, "trace_identity_mismatch")
    reject(definition.config is not None and definition.config != config, "trace_config_mismatch")
    expected = (phase == "agent2agent", phase == "noise", phase == "noise")
    actual = (definition.has_a2a_augmentation, definition.has_tool_augmentation, definition.has_env_events_augmentation)
    reject(actual != expected, "trace_augmentation_mismatch")
    reject(scored and (definition.has_exception or definition.exception_type is not None), "scored_trace_has_exception")
    # Import, but never initialize or benchmark-load: missing HF app snapshots
    # must not trigger ARE's optional online recovery of scenario application data.
    scenario, completed_events, world_logs = JsonScenarioImporter().import_from_json(text)
    reject(scenario.scenario_id != scenario_id or scenario.run_number != run_number, "imported_trace_identity_mismatch")
    reject(len(completed_events) != len(trace.completed_events) or len(world_logs) != len(trace.world_logs), "imported_trace_count_mismatch")
    return raw, trace


def scan_envelopes(root: Path) -> tuple[list[dict], list[str]]:
    entries = []
    seen = set()
    seen_executions = set()
    paths = []
    for child in root.rglob("*"):
        reject(link_like(child), "symlink_not_allowed")
        if child.is_file() and child.name == "output.jsonl":
            relative = child.relative_to(root).as_posix()
            parts = PurePosixPath(relative).parts
            reject(len(parts) != 3 or parts[0] not in PHASES, "noncanonical_output_layout")
            paths.append(relative)
            for entry in json_lines(child):
                reject(not {"task_id", "trace_id", "score", "metadata"}.issubset(entry), "envelope_missing_field")
                metadata = entry["metadata"]
                reject(not isinstance(metadata, dict), "invalid_envelope_metadata")
                reject(not {"scenario_id", "run_number", "status", "has_exception"}.issubset(metadata), "metadata_missing_field")
                key = identity(parts[0], parts[1], metadata["scenario_id"], metadata["run_number"])
                reject(key in seen, "duplicate_scenario_run")
                seen.add(key)
                reject(entry["task_id"] != key[2], "envelope_task_identity_mismatch")
                reject(metadata.get("phase", key[0]) != key[0] or metadata.get("config", key[1]) != key[1], "metadata_layout_mismatch")
                execution_id = metadata.get("execution_id")
                if execution_id is not None:
                    reject(not isinstance(execution_id, str) or not SAFE_COMPONENT.fullmatch(execution_id), "invalid_execution_id")
                    reject(execution_id in seen_executions, "duplicate_execution_id")
                    seen_executions.add(execution_id)
                status, score, has_exception = metadata["status"], entry["score"], metadata["has_exception"]
                reject(type(has_exception) is not bool, "invalid_exception_flag")
                reject(status not in {"success", "failed", "exception", "no_validation"}, "invalid_status")
                if status in {"success", "failed"}:
                    reject(type(score) not in {int, float} or not math.isfinite(score) or score != (1 if status == "success" else 0), "score_status_mismatch")
                    reject(has_exception or metadata.get("exception_type") is not None, "scored_envelope_has_exception")
                else:
                    reject(score is not None, "technical_score_must_be_null")
                    reject(has_exception != (status == "exception"), "technical_status_mismatch")
                trace_path = package_path(root, entry["trace_id"])
                reject(trace_path.relative_to(root).parts[:2] != parts[:2], "trace_layout_mismatch")
                raw, _ = validate_trace(trace_path, key, scored=status in {"success", "failed"})
                # Official text-mode readers apply universal newline conversion.
                # Keep copied Trace bytes intact, but compare their data-column
                # text under the exact same newline semantics (including CRLF).
                trace_text = raw.decode("utf-8").replace("\r\n", "\n").replace("\r", "\n")
                entries.append({"phase": key[0], "config": key[1], "scenarioId": key[2], "runNumber": key[3], "executionId": execution_id, "status": status, "score": score, "trace_id": entry["trace_id"], "traceDataSha256": hashlib.sha256(trace_text.encode("utf-8")).hexdigest()})
    reject(not entries, "no_result_rows")
    entries.sort(key=lambda entry: (entry["phase"], entry["config"], entry["scenarioId"], entry["runNumber"]))
    return entries, sorted(paths)


def check(spec: dict) -> dict:
    import pyarrow as pa
    import pyarrow.parquet as parquet
    from datasets import Dataset
    from are.simulation.benchmark.gaia2_upload_script import reconstruct_results_from_output_dir
    from are.simulation.benchmark.hf_upload_utils import create_hf_schema
    from are.simulation.benchmark.report_stats import (
        build_trace_rows_polars,
        combine_results_to_dataframe,
        generate_json_stats_report,
    )

    root = absolute_path(spec.get("packageRoot"), "invalid_package_root")
    reject(not root.is_dir(), "missing_package_root")
    model, provider = spec.get("model"), spec.get("provider")
    reject(not isinstance(model, str) or not model or not isinstance(provider, str) or not provider, "invalid_model_metadata")
    entries, native_paths = scan_envelopes(root)
    with working_directory(root):
        results = reconstruct_results_from_output_dir(str(root), model, provider)
        frame = combine_results_to_dataframe(results)
        rows = build_trace_rows_polars(frame)
        reject(len(rows) != len(entries), "official_reconstructed_count_mismatch")
        expected = {(entry["phase"], entry["config"], entry["scenarioId"], entry["runNumber"]): entry for entry in entries}
        for row in rows:
            key = identity(row.get("phase_name"), row.get("config"), row.get("scenario_id"), row.get("run_number"))
            reject(key not in expected, "official_reconstructed_identity_mismatch")
            source = expected[key]
            reject(row.get("task_id") != key[2] or row.get("status") != source["status"] or row.get("score") != source["score"], "official_reconstructed_result_mismatch")
            reject(not isinstance(row.get("data"), str) or hashlib.sha256(row["data"].encode("utf-8")).hexdigest() != source["traceDataSha256"], "official_reconstructed_trace_mismatch")
        schema = create_hf_schema()
        reject(len(schema) != 17, "unexpected_official_schema")
        table = pa.Table.from_pylist(rows, schema=schema)
        dataset = Dataset(table)
        reject(len(dataset) != len(entries), "hf_dataset_count_mismatch")
        reject(not table.schema.equals(schema), "hf_schema_mismatch")
        normalized = table.to_pylist()
        normalized.sort(key=lambda row: (row["phase_name"], row["config"], row["scenario_id"], row["run_number"]))
        stats = generate_json_stats_report(frame, model, provider)
    if spec.get("hfRowsPath") is not None:
        reference = absolute_path(spec["hfRowsPath"], "invalid_hf_rows_path")
        reject(not reference.is_relative_to(root), "external_hf_rows_path")
        reference_rows = json_lines(reference)
        for row in reference_rows:
            reject(set(row) != set(schema.names), "existing_hf_schema_fields_mismatch")
            identity(row.get("phase_name"), row.get("config"), row.get("scenario_id"), row.get("run_number"))
            reject(row.get("score") is not None and (type(row["score"]) not in {int, float} or not math.isfinite(row["score"])), "invalid_existing_hf_score")
            reject(any(type(row.get(field)) is not bool for field in ("has_exception", "has_app_noise", "has_env_noise")), "invalid_existing_hf_flag")
        supplied = pa.Table.from_pylist(reference_rows, schema=schema).to_pylist()
        supplied.sort(key=lambda row: (row["phase_name"], row["config"], row["scenario_id"], row["run_number"]))
        reject(supplied != normalized, "existing_hf_rows_mismatch")
    artifacts = root / "_official" / f"check-{uuid.uuid4()}"
    artifacts.mkdir(parents=True, exist_ok=False)
    write_lines_new(artifacts / "hf-rows.jsonl", normalized)
    parquet.write_table(table, artifacts / "hf-rows.parquet")
    write_json_new(artifacts / "computed_stats.json", stats)
    write_json_new(artifacts / "hf-schema.json", {"fields": [{"name": field.name, "type": str(field.type), "nullable": field.nullable} for field in schema]})
    artifact_paths = native_paths + [entry["trace_id"] for entry in entries] + [path.relative_to(root).as_posix() for path in sorted(artifacts.iterdir())]
    return {
        "schemaVersion": "gaia2-phase2-official-adapter-v1",
        "status": "passed",
        "traceValidationPassed": True,
        "hfSchemaValid": True,
        "reconstructedCount": len(entries),
        "successCount": sum(entry["status"] == "success" for entry in entries),
        "businessFailureCount": sum(entry["status"] == "failed" for entry in entries),
        "technicalCount": sum(entry["status"] in {"exception", "no_validation"} for entry in entries),
        "identityRows": [{key: value for key, value in entry.items() if key not in {"trace_id", "traceDataSha256"}} for entry in entries],
        "officialFunctions": FUNCTIONS,
        "artifactPaths": sorted(set(artifact_paths)),
        "hfRowsPath": (artifacts / "hf-rows.jsonl").relative_to(root).as_posix(),
        "stats": stats,
        "officialStatisticsAreObservational": True,
        "networkUsed": False,
        "modelUsed": False,
        "uploaded": False,
        "evaluationCompletenessChecked": False,
        "officialSubmissionReady": False,
    }


def build(spec: dict) -> dict:
    from are.simulation.multi_scenario_runner import _export_benchmark_result_jsonl
    from are.simulation.scenarios.config import MultiScenarioRunnerConfig
    from are.simulation.scenarios.validation_result import MultiScenarioValidationResult, ScenarioValidationResult

    root = absolute_path(spec.get("packageRoot"), "invalid_package_root")
    reject(not root.is_dir(), "missing_package_root")
    # Node has already copied immutable manifest/provenance evidence into this
    # exclusively-created package. Keep those inputs untouched; never merge
    # with an older output tree, phases, tool artifacts or arbitrary files.
    reserved = {"run-manifest.json": "file", "evidence": "directory", "provenance": "directory"}
    for child in root.iterdir():
        reject(link_like(child), "symlink_not_allowed")
        reject(child.name not in reserved, "package_root_not_empty")
        kind = reserved[child.name]
        reject(not (child.is_file() if kind == "file" else child.is_dir()), "invalid_reserved_package_entry")
        if kind == "directory":
            for descendant in child.rglob("*"):
                reject(link_like(descendant), "symlink_not_allowed")
    model, provider = spec.get("model"), spec.get("provider")
    reject(not isinstance(model, str) or not model or not isinstance(provider, str) or not provider, "invalid_model_metadata")
    rows = spec.get("rows")
    reject(not isinstance(rows, list) or not rows, "no_result_rows")
    groups = {}
    seen = set()
    executions = set()
    prepared = []
    for row in rows:
        reject(not isinstance(row, dict), "invalid_build_row")
        reject(not {"executionId", "phase", "config", "scenarioId", "runNumber", "success", "traceSourcePath"}.issubset(row), "build_row_missing_field")
        key = identity(row.get("phase"), row.get("config"), row.get("scenarioId"), row.get("runNumber"))
        reject(key in seen, "duplicate_scenario_run")
        seen.add(key)
        execution_id = row.get("executionId")
        reject(not isinstance(execution_id, str) or not SAFE_COMPONENT.fullmatch(execution_id), "invalid_execution_id")
        reject(execution_id in executions, "duplicate_execution_id")
        executions.add(execution_id)
        success = row.get("success")
        reject(success is not None and type(success) is not bool, "invalid_success_flag")
        failure_category = row.get("failureCategory")
        reject(failure_category is not None and (not isinstance(failure_category, str) or not SAFE_CATEGORY.fullmatch(failure_category)), "invalid_failure_category")
        reject(type(success) is bool and failure_category is not None and not (success is False and failure_category == "business_failure"), "scored_build_row_has_exception")
        duration = row.get("duration")
        reject(duration is not None and (type(duration) not in {int, float} or not math.isfinite(duration) or duration < 0), "invalid_duration")
        source = absolute_path(row.get("traceSourcePath"), "invalid_trace_source")
        reject(not source.is_file(), "missing_trace_source")
        raw, _ = validate_trace(source, key, scored=type(success) is bool)
        prepared.append((row, key, raw))
    normalizations = []
    for row, key, raw in prepared:
        phase, config, scenario_id, run_number = key
        relative = f"{phase}/{config}/hf/{row['executionId']}.json"
        trace_path = package_path(root, relative, must_exist=False)
        trace_path.parent.mkdir(parents=True, exist_ok=True)
        with trace_path.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        group_key = phase, config
        if group_key not in groups:
            groups[group_key] = MultiScenarioValidationResult(run_config=MultiScenarioRunnerConfig(model=spec.get("model"), model_provider=spec.get("provider"), agent="default", oracle=False, export=True, output_dir=str(root / phase / config), trace_dump_format="hf", a2a_app_prop=1.0 if phase == "agent2agent" else 0.0))
        technical_category = row.get("failureCategory") if row.get("success") is None else None
        groups[group_key].add_result(ScenarioValidationResult(success=row.get("success"), exception=Phase2TechnicalFailure(technical_category) if technical_category is not None else None, export_path=relative, duration=row.get("duration")), scenario_id, run_number)
    for (phase, config), result in groups.items():
        output_dir = root / phase / config
        _export_benchmark_result_jsonl(result, str(output_dir))
        envelope_path = output_dir / "output.jsonl"
        official_rows = json_lines(envelope_path)
        bound_rows = {(row["scenarioId"], row["runNumber"]): row for row in rows if row["phase"] == phase and row["config"] == config}
        for envelope in official_rows:
            metadata = envelope["metadata"]
            source = bound_rows[(metadata["scenario_id"], metadata["run_number"])]
            # Scores and statuses are never touched. These additions make the
            # envelope's official identity inspectable without any path guessing.
            for field, value in {"phase": phase, "config": config, "execution_id": source["executionId"]}.items():
                reject(field in metadata, "official_metadata_collision")
                metadata[field] = value
                normalizations.append({"path": envelope_path.relative_to(root).as_posix(), "scenarioId": source["scenarioId"], "runNumber": source["runNumber"], "field": f"metadata.{field}", "source": "verified_task_identity", "value": value})
        # The official writer already closed this newly-owned file. Preserve its
        # native content before adding explicitly recorded compatible metadata.
        native_path = output_dir / "native-output.jsonl"
        envelope_path.rename(native_path)
        write_lines_new(envelope_path, official_rows)
    summary = check(spec)
    summary["normalizations"] = normalizations
    summary["artifactPaths"] += [f"{phase}/{config}/native-output.jsonl" for phase, config in sorted(groups)]
    summary["artifactPaths"] = sorted(set(summary["artifactPaths"]))
    return summary


def fixture(spec: dict) -> dict:
    from are.simulation.data_handler.exporter import JsonScenarioExporter
    from are.simulation.environment import Environment
    from are.simulation.scenarios.scenario import Scenario
    from are.simulation.types import CapabilityTag

    path = absolute_path(spec.get("tracePath"), "invalid_fixture_path")
    config = spec.get("config", "execution")
    key = identity("standard", config, spec.get("scenarioId"), spec.get("runNumber"))
    reject(path.exists(), "fixture_path_exists")
    scenario = Scenario(scenario_id=key[2], run_number=key[3], config=config, duration=1, start_time=0, tags=(CapabilityTag[config.capitalize()],))
    text = JsonScenarioExporter().export_to_json(Environment(), scenario, scenario.scenario_id, model_id="phase2-controlled-no-model", agent_id="phase2-controlled-no-model", validation_decision="Valid")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    validate_trace(path, key, scored=False)
    return {"schemaVersion": "gaia2-phase2-official-fixture-v1", "status": "passed", "syntheticFixtureOnly": True, "networkUsed": False, "modelUsed": False, "toolsExecuted": False, "traceSha256": hashlib.sha256(path.read_bytes()).hexdigest(), "scenarioId": key[2], "runNumber": key[3], "config": config, "officialFunctions": ["are.simulation.environment.Environment", "are.simulation.scenarios.scenario.Scenario", "are.simulation.data_handler.exporter.JsonScenarioExporter.export_to_json", FUNCTIONS[1], FUNCTIONS[2]]}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--operation", choices=("build", "check", "fixture"), required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    # Offline flags prevent lazy HuggingFace imports from consulting online state.
    # No upload helper, actor, judge or scenario runner is called by this adapter.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    os.environ["LITELLM_TELEMETRY"] = "False"
    report = None
    output = None
    try:
        output = absolute_path(args.output, "invalid_report_path")
        reject(output.exists(), "report_path_exists")
        spec_path = absolute_path(args.spec, "invalid_spec_path")
        spec = strict_json(spec_path.read_text(encoding="utf-8"))
        reject(not isinstance(spec, dict), "invalid_spec")
        # Capturing stdout/stderr avoids leaking permissive upstream diagnostics
        # containing trace text, provider data or exception messages.
        with open(os.devnull, "w", encoding="utf-8") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            report = {"build": build, "check": check, "fixture": fixture}[args.operation](spec)
        write_json_new(output, report)
        print(json.dumps({"status": report["status"], "operation": args.operation, "reconstructedCount": report.get("reconstructedCount"), "syntheticFixtureOnly": report.get("syntheticFixtureOnly", False)}))
        return 0
    except Exception as error:
        report = {"schemaVersion": "gaia2-phase2-official-adapter-v1", "status": "failed", "code": error.code if isinstance(error, AdapterRejected) else "official_adapter_error", "errorType": type(error).__name__, "networkUsed": False, "modelUsed": False, "uploaded": False, "officialSubmissionReady": False}
        if output is not None and not output.exists():
            try:
                write_json_new(output, report)
            except Exception:
                pass
        print(json.dumps(report))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
