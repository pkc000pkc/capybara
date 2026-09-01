from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from capybara_first_round.config import (
    ROOT,
    load_compatible_credentials,
    sha256_file,
)
from scripts.run_capybara_training import CANONICAL_MAPPING, ApiClient, wait_for_status

FIXTURE = ROOT / "correction_smoke" / "project"
SCORING_PROMPT = """Grade the isolated automatic recovery smoke.

Expected public marker:
{{ answer }}

Actual output:
{{ actual }}

Return exactly one JSON object with no Markdown fence:
{"score": 1 or 0, "passed": true or false, "rationale": "concise observable reason"}
Pass only when the actual output contains the complete marker RECOVERY_APPLIED.
"""


def git(project: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-C", str(project), *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )


def ensure_dataset(client: ApiClient, path: str, name: str) -> dict[str, Any]:
    return client.request(
        "POST",
        "/api/datasets/import",
        {"path": path, "mapping": CANONICAL_MAPPING},
    ) | {"name": name}


def prefetch_audit(detail: dict[str, Any]) -> dict[str, Any]:
    trace = detail.get("trace", {})
    model_loops = [
        {
            "step_id": step.get("id"),
            "status": step.get("status"),
            "loop_status": step.get("detail", {}).get("loopStatus"),
        }
        for step in trace.get("timeline", [])
        if step.get("type") == "model"
    ]
    events = []
    for artifact in trace.get("artifacts", []):
        value = artifact.get("value", {})
        if not isinstance(value, dict) or value.get("hookId") != "smoke-runtime-prefetch":
            continue
        metadata = value.get("result", {}).get("metadata", {})
        events.append(
            {
                "artifact_id": artifact.get("meta", {}).get("id"),
                "loop_iteration": value.get("loopIteration"),
                "matched": value.get("matched"),
                "attempts": value.get("attempts"),
                "terminal": metadata.get("terminal"),
                "selected": metadata.get("selected", []),
                "injected": metadata.get("injected", ""),
            }
        )
    return {
        "experiment_run_id": detail.get("runId"),
        "experiment_case_id": detail.get("id"),
        "model_loops": model_loops,
        "hook_events": events,
        "hook_ran_after_every_loop": len(events) == len(model_loops),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a synthetic Luna automatic-correction smoke")
    parser.add_argument("--backend-url", default="http://127.0.0.1:3005")
    parser.add_argument("--run-tag", default=datetime.now(UTC).strftime("luna-correction-%Y%m%dT%H%M%SZ"))
    parser.add_argument("--timeout-seconds", type=float, default=1800)
    args = parser.parse_args()

    run_root = ROOT / "runs" / args.run_tag
    project = run_root / "correction-smoke-project"
    if project.exists():
        raise FileExistsError(f"Correction smoke run directory already exists: {project}")
    shutil.copytree(FIXTURE, project)
    base_url, api_key, model = load_compatible_credentials()
    if model != "gpt-5.6-luna":
        raise ValueError(f"Correction smoke requires gpt-5.6-luna, resolved {model!r}")
    config_path = project / ".capybara" / "config.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["llm"]["base_url"] = base_url
    config["llm"]["model"] = model
    config_path.write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8", newline="\n")
    secrets_path = project / ".capybara" / "secrets.json"
    secrets_path.write_text(
        json.dumps({"version": 1, "llm": {"api_key": api_key}}, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    git(project, "init", "--initial-branch=main")
    git(project, "config", "user.name", "Capybara Correction Smoke")
    git(project, "config", "user.email", "capybara-smoke@example.invalid")
    git(project, "add", ".")
    git(project, "commit", "-m", "synthetic correction smoke fixture")

    variables_file = project / ".capybara" / "system-variables.json"
    project_hash_before = sha256_file(variables_file)
    client = ApiClient(args.backend_url, project)
    train = ensure_dataset(client, "datasets/train.jsonl", "Synthetic correction train")
    test = ensure_dataset(client, "datasets/test.jsonl", "Synthetic correction test")
    train = client.request(
        "PUT",
        f"/api/datasets/{train['id']}",
        {"name": "Synthetic correction train", "tags": ["synthetic"], "scoringPrompt": SCORING_PROMPT},
    )
    test = client.request(
        "PUT",
        f"/api/datasets/{test['id']}",
        {"name": "Synthetic correction test", "tags": ["synthetic"], "scoringPrompt": SCORING_PROMPT},
    )
    created = client.request(
        "POST",
        "/api/experiments/training",
        {
            "name": args.run_tag,
            "trainDatasetId": train["id"],
            "testDatasetId": test["id"],
            "trainLimit": 1,
            "testLimit": 1,
            "learningMode": "auto",
            "reviewScope": "failed",
            "pauseOnFailure": False,
            "variableSource": "project",
            "correctionHook": {"hookId": "smoke-correction", "parameters": {}},
            "experienceExtractorHook": {"hookId": "smoke-learning", "parameters": {}},
            "maxCorrectionAttempts": 2,
            "maxCorrectionTokens": 16000,
            "maxCorrectionWallTimeMs": 600000,
            "maxReplayRevisions": 1,
            "timeoutMs": 600000,
        },
    )
    run_id = created["id"]
    ready = wait_for_status(
        client,
        run_id,
        {"ready_to_freeze", "waiting_review", "paused_failure", "failed", "cancelled"},
        args.timeout_seconds,
    )
    if ready["status"] != "ready_to_freeze":
        raise RuntimeError(f"Correction smoke did not reach freeze: {ready}")
    snapshot = client.request("POST", f"/api/experiments/training/{run_id}/freeze", {})
    client.request("POST", f"/api/experiments/training/{run_id}/test", {})
    completed = wait_for_status(client, run_id, {"completed", "failed", "cancelled"}, args.timeout_seconds)
    if completed["status"] != "completed":
        raise RuntimeError(f"Correction smoke sanity test failed: {completed}")

    analysis = client.request("GET", f"/api/experiments/training/{run_id}/analysis")
    attempts = client.request("GET", f"/api/experiments/training/{run_id}/correction-attempts")["items"]
    experiences = client.request("GET", f"/api/experiments/training/{run_id}/experiences")["items"]
    variables = client.request("GET", f"/api/experiments/training/{run_id}/variables")["items"]
    cases = client.request("GET", f"/api/experiments/training/{run_id}/cases")["items"]
    if not attempts:
        raise AssertionError("Automatic correction produced no attempts")
    source = next(item for item in cases if item["phase"] == "training")
    test_case = next(item for item in cases if item["phase"] == "testing")
    memory = next(item for item in variables if item["name"] == "memory_smoke")
    source_detail = client.request(
        "GET",
        f"/api/experiments/{source['experimentRunId']}/cases/{source['experimentCaseId']}",
    )
    correction_detail = client.request(
        "GET",
        f"/api/experiments/{attempts[-1]['experimentRunId']}/cases/{attempts[-1]['experimentCaseId']}",
    )
    test_detail = client.request(
        "GET",
        f"/api/experiments/{test_case['experimentRunId']}/cases/{test_case['experimentCaseId']}",
    )
    prefetch = {
        "source": prefetch_audit(source_detail),
        "correction": prefetch_audit(correction_detail),
        "frozen_test": prefetch_audit(test_detail),
    }
    project_hash_after = sha256_file(variables_file)

    if source.get("passed") is not False:
        raise AssertionError("Synthetic source case must preserve its initial failed evaluation")
    if "RECOVERY_APPLIED" in source.get("question", ""):
        raise AssertionError("Synthetic training question leaked the expected recovery marker")
    if any(
        "RECOVERY_APPLIED" in str(attempt.get(field, ""))
        for attempt in attempts
        for field in ("summary", "strategy")
    ):
        raise AssertionError("Correction proposal leaked the expected recovery marker")
    if attempts[-1].get("passed") is not True:
        raise AssertionError("Automatic correction did not produce a successful clean attempt")
    child_ids = [attempt.get("experimentRunId") for attempt in attempts]
    if not all(child_ids) or len(child_ids) != len(set(child_ids)):
        raise AssertionError("Correction attempts did not use distinct child experiments")
    if source.get("experimentRunId") in child_ids:
        raise AssertionError("Correction reused the failed source environment")
    if len(experiences) != 1 or experiences[0].get("status") != "applied" or not experiences[0].get("replayPassed"):
        raise AssertionError("Successful correction memory did not pass replay admission")
    if memory.get("runValue") != "RECOVERY_APPLIED" or memory.get("snapshotValue") != "RECOVERY_APPLIED":
        raise AssertionError("Admitted smoke memory was not frozen")
    if test_case.get("passed") is not True:
        raise AssertionError("Frozen smoke memory did not pass held-out sanity")
    if not all(item["hook_ran_after_every_loop"] for item in prefetch.values()):
        raise AssertionError("Ordinary runtime Hook did not run after every model loop")
    if not any(
        event["selected"] == ["memory_smoke"] and event["injected"] == "RECOVERY_APPLIED"
        for event in prefetch["frozen_test"]["hook_events"]
    ):
        raise AssertionError("Frozen smoke memory was not automatically prefetched")
    if project_hash_before != project_hash_after:
        raise AssertionError("Synthetic training wrote run-scoped memory into the project file")
    if analysis.get("provenance", {}).get("model", {}).get("model") != "gpt-5.6-luna":
        raise AssertionError("Synthetic correction smoke did not use gpt-5.6-luna")

    report = {
        "schema_version": 1,
        "kind": "synthetic_state_machine_smoke",
        "included_in_state_bench_score": False,
        "run_tag": args.run_tag,
        "run_id": run_id,
        "model": "gpt-5.6-luna",
        "status": completed["status"],
        "source_case": source,
        "correction_attempts": attempts,
        "experience_candidates": experiences,
        "memory_variable": memory,
        "test_case": test_case,
        "snapshot": snapshot,
        "runtime_prefetch": prefetch,
        "project_variables_hash_before": project_hash_before,
        "project_variables_hash_after": project_hash_after,
        "project_write_violations": int(project_hash_before != project_hash_after),
        "events": analysis.get("events", []),
    }
    report_dir = ROOT / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    report_path = report_dir / f"{args.run_tag}.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(
        json.dumps(
            {
                "report": str(report_path),
                "run_id": run_id,
                "correction_attempts": len(attempts),
                "candidate_status": experiences[0]["status"],
                "snapshot_hash": snapshot["contentHash"],
                "project_write_violations": 0,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
