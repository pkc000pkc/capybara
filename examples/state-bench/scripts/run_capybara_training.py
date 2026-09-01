from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from capybara_first_round.artifact import export_learning_artifact
from capybara_first_round.config import ROOT, git_output, load_first_round_config, sha256_file
from capybara_first_round.projection import (
    MANIFEST_OUTPUT,
    SANITY_OUTPUT,
    TRAIN_OUTPUT,
    TRAIN_SCORING_PROMPT,
)

CANONICAL_MAPPING = {
    "id": "/id",
    "question": "/question",
    "thinking": "/thinking",
    "answer": "/answer",
    "expectedTools": "/expectedTools",
    "metadata": "/metadata",
}


def selected_domains(value: str, config: dict[str, Any]) -> list[str]:
    requested = [item.strip() for item in value.split(",") if item.strip()]
    unknown = [item for item in requested if item not in config["domains"]]
    if unknown:
        raise ValueError(f"Unknown STATE-Bench domain(s): {', '.join(unknown)}")
    if not requested:
        raise ValueError("At least one STATE-Bench domain is required")
    return list(dict.fromkeys(requested))


def create_training_batch(
    source: Path,
    output: Path,
    domains: list[str],
    cases_per_domain: int,
) -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    records = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    selected: list[dict[str, Any]] = []
    selected_ids: dict[str, list[str]] = {}
    for domain in domains:
        domain_records = [record for record in records if record.get("metadata", {}).get("domain") == domain]
        if len(domain_records) < cases_per_domain:
            raise ValueError(
                f"Training projection has only {len(domain_records)} case(s) for {domain}; "
                f"requested {cases_per_domain}"
            )
        chosen = domain_records[:cases_per_domain]
        selected.extend(chosen)
        selected_ids[domain] = [str(record["id"]) for record in chosen]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in selected),
        encoding="utf-8",
        newline="\n",
    )
    return selected, selected_ids


def project_variable_values(path: Path) -> dict[str, str]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {
        str(item["key"]): str(item.get("value", ""))
        for item in payload.get("variables", [])
        if item.get("scope") == "project"
    }


def value_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def variable_audit(before: dict[str, str], after: dict[str, str]) -> list[dict[str, Any]]:
    items = []
    for name in sorted(before.keys() | after.keys()):
        before_value = before.get(name, "")
        after_value = after.get(name, "")
        items.append(
            {
                "name": name,
                "before_hash": value_hash(before_value),
                "after_hash": value_hash(after_value),
                "changed": before_value != after_value,
                "before_value": before_value,
                "after_value": after_value,
                "unified_diff": "".join(
                    difflib.unified_diff(
                        before_value.splitlines(keepends=True),
                        after_value.splitlines(keepends=True),
                        fromfile=f"variables/{name}.before",
                        tofile=f"variables/{name}.after",
                    )
                ),
            }
        )
    return items


def training_variable_audit(report: Any) -> list[dict[str, Any]]:
    source = report.get("items", []) if isinstance(report, dict) else []
    items: list[dict[str, Any]] = []
    for raw in source:
        name = str(raw["name"])
        baseline = str(raw.get("baselineValue", ""))
        run = str(raw.get("runValue", ""))
        project = str(raw.get("projectValue", ""))
        snapshot = str(raw.get("snapshotValue", run))
        items.append(
            {
                "name": name,
                "state": raw.get("state"),
                "changed": baseline != run,
                "baseline_hash": value_hash(baseline),
                "run_hash": value_hash(run),
                "project_hash": value_hash(project),
                "snapshot_hash": value_hash(snapshot),
                "baseline_value": baseline,
                "run_value": run,
                "project_value": project,
                "snapshot_value": snapshot,
                "baseline_to_run_diff": "".join(
                    difflib.unified_diff(
                        baseline.splitlines(keepends=True),
                        run.splitlines(keepends=True),
                        fromfile=f"variables/{name}.baseline",
                        tofile=f"variables/{name}.run",
                    )
                ),
                "run_to_snapshot_diff": "".join(
                    difflib.unified_diff(
                        run.splitlines(keepends=True),
                        snapshot.splitlines(keepends=True),
                        fromfile=f"variables/{name}.run",
                        tofile=f"variables/{name}.snapshot",
                    )
                ),
                "source_case_ids": raw.get("sourceCaseIds", []),
                "candidate_ids": raw.get("candidateIds", []),
            }
        )
    return items


def registered_dataset_path(value: str) -> Path:
    path = Path(value)
    return (path if path.is_absolute() else ROOT / path).resolve()


class ApiClient:
    def __init__(self, base_url: str, project_root: Path):
        self.base_url = base_url.rstrip("/")
        self.project_root = project_root.resolve()

    def request(self, method: str, path: str, body: Any | None = None, timeout: float = 300) -> Any:
        query = urllib.parse.urlencode({"projectPath": str(self.project_root)})
        url = f"{self.base_url}{path}?{query}"
        payload = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=payload,
            method=method,
            headers={"Content-Type": "application/json"} if payload is not None else {},
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"{method} {path} failed with HTTP {exc.code}: {detail}") from exc


def ensure_dataset(client: ApiClient, path: Path, name: str, tags: list[str]) -> dict[str, Any]:
    relative = path.relative_to(ROOT).as_posix()
    datasets = client.request("GET", "/api/datasets")["items"]
    expected_path = path.resolve()
    dataset = next(
        (item for item in datasets if item.get("path") and registered_dataset_path(str(item["path"])) == expected_path),
        None,
    )
    if dataset is None:
        dataset = client.request(
            "POST",
            "/api/datasets/import",
            {"path": relative, "mapping": CANONICAL_MAPPING},
        )
    return client.request(
        "PUT",
        f"/api/datasets/{dataset['id']}",
        {"name": name, "tags": tags, "scoringPrompt": TRAIN_SCORING_PROMPT},
    )


def wait_for_status(
    client: ApiClient,
    run_id: str,
    terminal: set[str],
    timeout_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    previous = None
    while time.monotonic() < deadline:
        run = client.request("GET", f"/api/experiments/training/{run_id}")
        marker = (run["status"], json.dumps(run.get("progress", {}), sort_keys=True))
        if marker != previous:
            print(json.dumps({"status": run["status"], "progress": run.get("progress")}, ensure_ascii=False))
            previous = marker
        if run["status"] in terminal:
            return run
        time.sleep(2)
    raise TimeoutError(f"Training run {run_id} did not reach {sorted(terminal)}")


def code_fingerprint() -> str:
    paths = [
        ROOT / ".capybara" / "config.json",
        ROOT / ".capybara" / "system-variables.json",
        ROOT / "config" / "capybara_first_round.json",
        ROOT / "main.j2",
        ROOT / "hooks" / "state-bench-learning.ts",
        ROOT / "hooks" / "state-bench-correction.ts",
        ROOT / "hooks" / "state-bench-admission.ts",
        ROOT / "hooks" / "memory-runtime-selector.ts",
        ROOT / "harnesses" / "memory" / "manifest.json",
        ROOT / "harnesses" / "memory" / "learned-memory.j2",
        ROOT / "capybara_first_round" / "projection.py",
        ROOT / "capybara_first_round" / "artifact.py",
    ]
    digest = hashlib.sha256()
    for path in paths:
        digest.update(path.relative_to(ROOT).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the first Capybara STATE-Bench training round")
    parser.add_argument("--backend-url", default="http://127.0.0.1:3005")
    parser.add_argument("--run-tag", default=datetime.now(UTC).strftime("first-round-%Y%m%dT%H%M%SZ"))
    parser.add_argument(
        "--resume-run-id",
        help="Attach to an existing training run instead of creating another run",
    )
    parser.add_argument("--timeout-seconds", type=float, default=4 * 60 * 60)
    parser.add_argument(
        "--domains",
        default="travel,customer_support,shopping_assistant",
        help="Comma-separated training domains (default: all three)",
    )
    parser.add_argument(
        "--train-cases-per-domain",
        type=int,
        default=1,
        help="Cases selected from the prepared projection for each domain (default: 1)",
    )
    args = parser.parse_args()
    if args.train_cases_per_domain < 1:
        parser.error("--train-cases-per-domain must be at least 1")

    if not TRAIN_OUTPUT.is_file() or not SANITY_OUTPUT.is_file() or not MANIFEST_OUTPUT.is_file():
        raise FileNotFoundError("Run scripts/prepare_capybara_first_round.py first")
    secrets_path = ROOT / ".capybara" / "secrets.json"
    if not secrets_path.is_file():
        raise FileNotFoundError(f"Capybara project secret file is missing: {secrets_path}")

    config = load_first_round_config()
    domains = selected_domains(args.domains, config)
    manifest = json.loads(MANIFEST_OUTPUT.read_text(encoding="utf-8"))
    selected_counts = {
        domain: len(manifest.get("selected", {}).get(domain, []))
        for domain in domains
    }
    if any(args.train_cases_per_domain > count for count in selected_counts.values()):
        parser.error(
            "--train-cases-per-domain cannot exceed the prepared projection: "
            + ", ".join(f"{domain}={count}" for domain, count in selected_counts.items())
        )
    capacities = config["learning_capacity_entries"]
    if manifest["train_jsonl_sha256"] != sha256_file(TRAIN_OUTPUT):
        raise ValueError("Training projection hash does not match its manifest")
    run_dir = ROOT / "runs" / args.run_tag / "capybara"
    snapshot_dir = ROOT / "snapshots" / args.run_tag
    batch_path = run_dir / "training_batch.jsonl"
    batch_records, selected_ids = create_training_batch(
        TRAIN_OUTPUT,
        batch_path,
        domains,
        args.train_cases_per_domain,
    )
    project_variables_path = ROOT / ".capybara" / "system-variables.json"
    project_variables_before = project_variable_values(project_variables_path)
    project_variables_hash_before_training = sha256_file(project_variables_path)
    client = ApiClient(args.backend_url, ROOT)
    if args.resume_run_id:
        run_id = args.resume_run_id
        existing = client.request("GET", f"/api/experiments/training/{run_id}")
        if existing["name"] != args.run_tag:
            raise ValueError(
                f"Existing run name {existing['name']!r} does not match --run-tag {args.run_tag!r}"
            )
        if int(existing["config"]["trainLimit"]) != len(batch_records):
            raise ValueError("Existing run train limit does not match the requested small-batch selection")
        if existing["status"] == "failed":
            existing = client.request("POST", f"/api/experiments/training/{run_id}/retry", {})
        if existing["status"] in {"running", "queued", "paused"}:
            run = wait_for_status(
                client,
                run_id,
                {"ready_to_freeze", "waiting_review", "paused_failure", "failed", "cancelled"},
                args.timeout_seconds,
            )
        else:
            run = existing
    else:
        train_dataset = ensure_dataset(
            client,
            batch_path,
            f"STATE-Bench small training batch {args.run_tag}",
            ["state-bench", "training-only", "small-batch", args.run_tag],
        )
        sanity_dataset = ensure_dataset(
            client,
            SANITY_OUTPUT,
            "STATE-Bench frozen snapshot sanity",
            ["state-bench", "synthetic", "snapshot-sanity"],
        )
        created = client.request(
            "POST",
            "/api/experiments/training",
            {
                "name": args.run_tag,
                "trainDatasetId": train_dataset["id"],
                "testDatasetId": sanity_dataset["id"],
                "trainLimit": len(batch_records),
                "testLimit": 1,
                "learningMode": "auto",
                "reviewScope": "failed",
                "pauseOnFailure": False,
                "variableSource": "project",
                "experienceExtractorHook": {
                    "hookId": "state-bench-learning",
                    "parameters": {
                        "generalEntries": str(capacities["general"]),
                        "domainEntries": str(capacities["domain"]),
                    },
                },
                "correctionHook": {"hookId": "state-bench-correction", "parameters": {}},
                "maxCorrectionAttempts": 4,
                "maxCorrectionTokens": 40000,
                "maxCorrectionWallTimeMs": 1200000,
                "maxReplayRevisions": 2,
                "timeoutMs": 1_800_000,
            },
        )
        run_id = created["id"]
        run = wait_for_status(
            client,
            run_id,
            {"ready_to_freeze", "waiting_review", "paused_failure", "failed", "cancelled"},
            args.timeout_seconds,
        )
    if run["status"] == "ready_to_freeze":
        snapshot = client.request("POST", f"/api/experiments/training/{run_id}/freeze", {})
        project_variables_after_freeze = project_variable_values(project_variables_path)
        project_variables_hash_after_freeze = sha256_file(project_variables_path)
        variables_before_test = sha256_file(project_variables_path)
        client.request("POST", f"/api/experiments/training/{run_id}/test", {})
        completed = wait_for_status(
            client,
            run_id,
            {"completed", "failed", "cancelled"},
            args.timeout_seconds,
        )
    elif args.resume_run_id and run["status"] in {"ready_for_test", "testing", "completed"}:
        analysis = client.request("GET", f"/api/experiments/training/{run_id}/analysis")
        snapshot = analysis.get("snapshot")
        if not isinstance(snapshot, dict):
            raise RuntimeError("Existing training run has no frozen snapshot")
        project_variables_after_freeze = project_variable_values(project_variables_path)
        project_variables_hash_after_freeze = sha256_file(project_variables_path)
        variables_before_test = sha256_file(project_variables_path)
        if run["status"] == "ready_for_test":
            client.request("POST", f"/api/experiments/training/{run_id}/test", {})
            completed = wait_for_status(
                client,
                run_id,
                {"completed", "failed", "cancelled"},
                args.timeout_seconds,
            )
        elif run["status"] == "testing":
            completed = wait_for_status(
                client,
                run_id,
                {"completed", "failed", "cancelled"},
                args.timeout_seconds,
            )
        else:
            completed = run
    else:
        raise RuntimeError(f"Training did not finish automatically: {run['status']} {run.get('failure')}")
    if completed["status"] != "completed":
        raise RuntimeError(f"Snapshot sanity test failed: {completed.get('failure')}")
    variables_after_test = sha256_file(project_variables_path)

    run_dir.mkdir(parents=True, exist_ok=True)
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    variables_report = client.request("GET", f"/api/experiments/training/{run_id}/variables")
    details = {
        "schema_version": 1,
        "run_tag": args.run_tag,
        "run": completed,
        "snapshot": snapshot,
        "analysis": client.request("GET", f"/api/experiments/training/{run_id}/analysis"),
        "variables": variables_report,
        "training_variable_audit": training_variable_audit(variables_report),
        "experiences": client.request("GET", f"/api/experiments/training/{run_id}/experiences"),
        "correction_attempts": client.request("GET", f"/api/experiments/training/{run_id}/correction-attempts"),
        "cases": client.request("GET", f"/api/experiments/training/{run_id}/cases"),
        "project_system_variables_hash_before_test": variables_before_test,
        "project_system_variables_hash_after_test": variables_after_test,
        "project_system_variables_hash_before_training": project_variables_hash_before_training,
        "project_system_variables_hash_after_freeze": project_variables_hash_after_freeze,
        "project_variable_audit": variable_audit(project_variables_before, project_variables_after_freeze),
        "test_write_violations": int(variables_before_test != variables_after_test),
        "benchmark_commit": git_output(ROOT, "rev-parse", "HEAD"),
        "code_fingerprint": code_fingerprint(),
        "training_projection_sha256": manifest["train_jsonl_sha256"],
        "resumed_existing_run": bool(args.resume_run_id),
        "training_batch_sha256": sha256_file(batch_path),
        "training_selection": {
            "domains": domains,
            "cases_per_domain": args.train_cases_per_domain,
            "total_cases": len(batch_records),
            "sample_ids": selected_ids,
        },
    }
    (run_dir / "training_result.json").write_text(
        json.dumps(details, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    (snapshot_dir / "capybara_snapshot.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    artifact_path = snapshot_dir / "learnings.json"
    artifact = export_learning_artifact(
        snapshot,
        artifact_path,
        {
            "run_tag": args.run_tag,
            "benchmark_commit": details["benchmark_commit"],
            "benchmark_version": config["benchmark_version"],
            "code_fingerprint": details["code_fingerprint"],
            "training_projection_sha256": manifest["train_jsonl_sha256"],
            "test_write_violations": details["test_write_violations"],
        },
    )
    summary = {
        "run_tag": args.run_tag,
        "training_run_id": run_id,
        "training_status": completed["status"],
        "snapshot_id": snapshot["id"],
        "snapshot_hash": artifact["snapshot_content_hash"],
        "learning_entries": len(artifact["entries"]),
        "training_cases": len(batch_records),
        "training_domains": domains,
        "correction_attempts": len(details["correction_attempts"].get("items", [])),
        "changed_project_variables": [
            item["name"] for item in details["training_variable_audit"] if item["changed"]
        ],
        "test_write_violations": details["test_write_violations"],
        "artifact_path": str(artifact_path),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
