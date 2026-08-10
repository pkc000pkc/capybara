#!/usr/bin/env python3
"""Audit Capybara AppWorld runs and build official leaderboard bundles."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from importlib.metadata import version as package_version
from pathlib import Path
from typing import Any, Iterable


SPLITS = ("test_normal", "test_challenge")
DATASET_IDS = {
    "test_normal": "appworld-test-normal-all-scenarios",
    "test_challenge": "appworld-test-challenge-all-scenarios",
}
REQUIRED_TASK_FILES = (
    Path("logs/environment_io.md"),
    Path("logs/api_calls.jsonl"),
    Path("version/code.txt"),
    Path("version/data.txt"),
)
REQUIRED_EVALUATION_FILES = (
    Path("evaluation/report.md"),
    Path("evaluation/version.txt"),
)


@dataclass(frozen=True)
class ExportContext:
    backend: str
    project: Path
    root: Path


@dataclass(frozen=True)
class RunAudit:
    split: str
    run: dict[str, Any]
    cases: list[dict[str, Any]]
    official_task_ids: list[str]
    ready_cases: list[dict[str, Any]]
    missing_task_ids: list[str]
    unexpected_task_ids: list[str]
    duplicate_task_ids: list[str]
    incomplete_task_ids: list[str]
    artifact_errors: list[str]

    @property
    def complete(self) -> bool:
        return (
            self.run.get("status") == "completed"
            and not self.missing_task_ids
            and not self.unexpected_task_ids
            and not self.duplicate_task_ids
            and not self.incomplete_task_ids
            and not self.artifact_errors
            and len(self.ready_cases) == len(self.official_task_ids)
        )


def api_get(context: ExportContext, route: str) -> Any:
    query = urllib.parse.urlencode({"projectPath": str(context.project)})
    url = f"{context.backend.rstrip('/')}{route}?{query}"
    request = urllib.request.Request(url, headers={"accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Capybara API returned {error.code} for {route}: {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"Cannot reach Capybara backend at {context.backend}: {error.reason}") from error


def official_task_ids(context: ExportContext, split: str) -> list[str]:
    path = context.root / "data" / "datasets" / f"{split}.txt"
    if not path.is_file():
        raise RuntimeError(f"Official AppWorld split file was not found: {path}")
    values = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(values) != len(set(values)):
        raise RuntimeError(f"Official AppWorld split contains duplicate task IDs: {path}")
    return values


def source_task_directory(context: ExportContext, case: dict[str, Any]) -> Path | None:
    experiment_run_id = case.get("experimentRunId")
    experiment_case_id = case.get("experimentCaseId")
    task_id = case.get("sampleId")
    if not all(isinstance(value, str) and value for value in (experiment_run_id, experiment_case_id, task_id)):
        return None
    return (
        context.root
        / "experiments"
        / "outputs"
        / "capybara"
        / experiment_run_id
        / experiment_case_id
        / "tasks"
        / task_id
    )


def task_artifact_errors(context: ExportContext, case: dict[str, Any]) -> list[str]:
    task_id = str(case.get("sampleId", "<unknown>"))
    source = source_task_directory(context, case)
    if source is None:
        return [f"{task_id}: missing experimentRunId or experimentCaseId"]
    if not source.is_dir():
        return [f"{task_id}: AppWorld output directory not found: {source}"]
    errors = [f"{task_id}: missing {relative}" for relative in REQUIRED_TASK_FILES if not (source / relative).is_file()]
    expected_databases = [path.stem + ".jsonl" for path in (context.root / "data" / "base_dbs").glob("*.db")]
    errors.extend(
        f"{task_id}: missing dbs/{database}"
        for database in expected_databases
        if not (source / "dbs" / database).is_file()
    )
    return errors


def audit_run(context: ExportContext, run_id: str, split: str) -> RunAudit:
    run = api_get(context, f"/api/experiments/training/{run_id}")
    case_payload = api_get(context, f"/api/experiments/training/{run_id}/cases")
    cases = [case for case in case_payload.get("items", []) if case.get("phase") == "testing"]
    expected_dataset_id = DATASET_IDS[split]
    configured_dataset_id = run.get("config", {}).get("testDatasetId")
    if configured_dataset_id != expected_dataset_id:
        raise RuntimeError(
            f"Run {run_id} uses testing dataset {configured_dataset_id!r}; expected {expected_dataset_id!r}"
        )

    expected_ids = official_task_ids(context, split)
    expected_set = set(expected_ids)
    counts: dict[str, int] = {}
    for case in cases:
        task_id = str(case.get("sampleId", ""))
        counts[task_id] = counts.get(task_id, 0) + 1
    actual_set = set(counts)
    duplicate_ids = sorted(task_id for task_id, count in counts.items() if count > 1)
    incomplete_ids = sorted(
        str(case.get("sampleId")) for case in cases if case.get("status") != "completed"
    )
    ready_cases = [
        case
        for case in cases
        if case.get("status") == "completed" and str(case.get("sampleId")) in expected_set
    ]
    artifact_errors = [
        error
        for case in ready_cases
        for error in task_artifact_errors(context, case)
    ]
    return RunAudit(
        split=split,
        run=run,
        cases=cases,
        official_task_ids=expected_ids,
        ready_cases=ready_cases,
        missing_task_ids=sorted(expected_set - actual_set),
        unexpected_task_ids=sorted(actual_set - expected_set),
        duplicate_task_ids=duplicate_ids,
        incomplete_task_ids=incomplete_ids,
        artifact_errors=artifact_errors,
    )


def audit_summary(audit: RunAudit) -> dict[str, Any]:
    progress = audit.run.get("progress", {}).get("testing", {})
    return {
        "runId": audit.run.get("id"),
        "name": audit.run.get("name"),
        "split": audit.split,
        "status": audit.run.get("status"),
        "snapshotId": audit.run.get("snapshotId"),
        "progress": progress,
        "officialTasks": len(audit.official_task_ids),
        "registeredCases": len(audit.cases),
        "readyArtifacts": len(audit.ready_cases) - len({error.split(":", 1)[0] for error in audit.artifact_errors}),
        "missingTaskIds": audit.missing_task_ids,
        "unexpectedTaskIds": audit.unexpected_task_ids,
        "duplicateTaskIds": audit.duplicate_task_ids,
        "incompleteTasks": len(audit.incomplete_task_ids),
        "artifactErrors": audit.artifact_errors,
        "readyForOfficialExport": audit.complete,
    }


def experiment_provenance(context: ExportContext, cases: Iterable[dict[str, Any]]) -> dict[str, Any]:
    run_ids = sorted({str(case["experimentRunId"]) for case in cases})

    def load(run_id: str) -> dict[str, Any]:
        return api_get(context, f"/api/experiments/{run_id}")

    with ThreadPoolExecutor(max_workers=12) as executor:
        runs = list(executor.map(load, run_ids))
    model_fingerprints = {
        json.dumps(run.get("model", {}), sort_keys=True, separators=(",", ":")) for run in runs
    }
    project_fingerprints = {
        json.dumps(run.get("project", {}), sort_keys=True, separators=(",", ":")) for run in runs
    }
    evaluator_fingerprints = {
        json.dumps(run.get("evaluator", {}), sort_keys=True, separators=(",", ":")) for run in runs
    }
    if len(model_fingerprints) != 1:
        raise RuntimeError("AppWorld Cases were executed with different LLM configurations")
    if len(project_fingerprints) != 1:
        raise RuntimeError("AppWorld Cases were executed from different project Git versions")
    if len(evaluator_fingerprints) != 1:
        raise RuntimeError("AppWorld Cases were scored with different AppWorld evaluator revisions")
    return {
        "model": json.loads(next(iter(model_fingerprints))),
        "project": json.loads(next(iter(project_fingerprints))),
        "evaluator": json.loads(next(iter(evaluator_fingerprints))),
        "experimentRuns": len(runs),
    }


def validate_pair(normal: RunAudit, challenge: RunAudit, provenance: dict[str, Any]) -> None:
    if not normal.complete or not challenge.complete:
        raise RuntimeError("Both AppWorld testing Runs must be completed and pass artifact validation")
    normal_snapshot = normal.run.get("snapshotId")
    challenge_snapshot = challenge.run.get("snapshotId")
    if not normal_snapshot or normal_snapshot != challenge_snapshot:
        raise RuntimeError(
            "Normal and Challenge Runs must reference the same immutable training snapshot "
            f"(normal={normal_snapshot!r}, challenge={challenge_snapshot!r})"
        )
    if not provenance.get("model") or not provenance.get("project"):
        raise RuntimeError("Model and project provenance could not be established")


def require_complete_pair(normal: RunAudit, challenge: RunAudit) -> None:
    if normal.complete and challenge.complete:
        return
    summary = {
        "test_normal": audit_summary(normal),
        "test_challenge": audit_summary(challenge),
    }
    raise RuntimeError(
        "Both AppWorld testing Runs must be completed and pass artifact validation:\n"
        + json.dumps(summary, indent=2, ensure_ascii=True)
    )


def run_command(arguments: list[str], cwd: Path) -> None:
    print("+", subprocess.list2cmdline(arguments), flush=True)
    subprocess.run(arguments, cwd=cwd, check=True)


def validate_submission_text(name: str, value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise RuntimeError(f"{name} must not be empty")
    if "\n" in normalized or "\r" in normalized:
        raise RuntimeError(f"{name} must be a single line")
    return normalized


def validate_public_url(value: str) -> str:
    url = validate_submission_text("--url", value)
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RuntimeError("--url must be an absolute public HTTP(S) URL")
    hostname = (parsed.hostname or "").lower()
    if hostname in {"localhost", "127.0.0.1", "::1"} or hostname.endswith(".local"):
        raise RuntimeError("--url must not point to localhost or a private development host")
    request = urllib.request.Request(
        url,
        headers={"accept": "text/html,*/*", "user-agent": "Capybara-AppWorld-Exporter/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status >= 400:
                raise RuntimeError(f"--url returned HTTP {response.status}: {url}")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"--url returned HTTP {error.code}: {url}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"--url is not publicly reachable: {url} ({error.reason})") from error
    return url


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assemble_experiment(
    context: ExportContext,
    audit: RunAudit,
    experiment_name: str,
    provenance: dict[str, Any],
) -> Path:
    outputs = context.root / "experiments" / "outputs"
    destination = outputs / experiment_name
    if destination.exists():
        raise RuntimeError(
            f"Official experiment output already exists: {destination}. "
            "Choose a new --name-prefix; existing results are never overwritten."
        )
    stage = outputs / f".capybara-export-{uuid.uuid4()}"
    tasks = stage / "tasks"
    tasks.mkdir(parents=True)
    try:
        by_task_id = {str(case["sampleId"]): case for case in audit.ready_cases}
        for task_id in audit.official_task_ids:
            source = source_task_directory(context, by_task_id[task_id])
            if source is None:
                raise RuntimeError(f"Cannot locate AppWorld output for {task_id}")
            shutil.copytree(source, tasks / task_id)
        manifest = {
            "version": 1,
            "trainingRunId": audit.run["id"],
            "snapshotId": audit.run["snapshotId"],
            "split": audit.split,
            "tasks": len(audit.official_task_ids),
            "provenance": provenance,
        }
        (stage / "capybara-export.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=True) + "\n",
            encoding="utf-8",
        )
        stage.rename(destination)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return destination


def evaluate_experiment(context: ExportContext, experiment_name: str, split: str) -> None:
    run_command(
        [
            sys.executable,
            "-m",
            "appworld.cli",
            "evaluate",
            experiment_name,
            split,
            "--root",
            str(context.root),
        ],
        context.project,
    )
    experiment = context.root / "experiments" / "outputs" / experiment_name
    for relative in (Path(f"evaluations/{split}.json"), Path(f"evaluations/{split}.txt")):
        if not (experiment / relative).is_file():
            raise RuntimeError(f"Official AppWorld evaluator did not create {experiment / relative}")


def create_bundle(
    context: ExportContext,
    experiment_name: str,
    split: str,
    method_name: str,
    method_tooltip: str,
    llm_name: str,
    llm_tooltip: str,
    url: str,
    task_ids: list[str],
) -> tuple[Path, dict[str, Any]]:
    os.environ["APPWORLD_ROOT"] = str(context.root)
    from appworld import update_root
    from appworld.apps import get_all_apps
    from appworld.common.constants import PASSWORD, SALT
    from appworld.common.utils import pack_bundle, unpack_bundle
    from appworld.leaderboard import prepare_metadata

    update_root(str(context.root))
    prepare_metadata(
        experiment_name=experiment_name,
        dataset_name=split,
        method_name=method_name,
        method_tooltip=method_tooltip,
        llm_name=llm_name,
        llm_tooltip=llm_tooltip,
        url=url,
        save=True,
    )
    outputs = context.root / "experiments" / "outputs"
    experiment = outputs / experiment_name
    bundle = experiment / "leaderboard.bundle"
    include_paths = [
        os.path.join("metadata.json"),
        os.path.join("evaluation", "report.md"),
        os.path.join("evaluation", "version.txt"),
        os.path.join("evaluations", "test_normal.json"),
        os.path.join("evaluations", "test_normal.txt"),
        os.path.join("evaluations", "test_challenge.json"),
        os.path.join("evaluations", "test_challenge.txt"),
        os.path.join("logs", "environment_io.md"),
        os.path.join("logs", "api_calls.jsonl"),
        os.path.join("version", "code.txt"),
        os.path.join("version", "data.txt"),
        os.path.join("dbs", "model_hashes.json"),
        *[os.path.join("dbs", app_name + ".jsonl") for app_name in get_all_apps()],
    ]
    pack_bundle(
        bundle_file_path=str(bundle),
        base_directory=str(outputs),
        include_directories=[experiment_name],
        include_file_path_substrings=include_paths,
        exclude_extensions=[],
        password=PASSWORD,
        salt=SALT,
    )
    if not bundle.is_file() or bundle.stat().st_size == 0:
        raise RuntimeError(f"Official AppWorld bundle was not created: {bundle}")

    with tempfile.TemporaryDirectory(prefix="capybara-appworld-bundle-") as temporary:
        unpack_bundle(
            bundle_file_path=str(bundle),
            base_directory=temporary,
            password=PASSWORD,
            salt=SALT,
        )
        unpacked = Path(temporary) / experiment_name
        required_global = [
            Path("metadata.json"),
            Path(f"evaluations/{split}.json"),
            Path(f"evaluations/{split}.txt"),
        ]
        missing = [str(relative) for relative in required_global if not (unpacked / relative).is_file()]
        unpacked_task_ids = sorted(
            path.name for path in (unpacked / "tasks").iterdir() if path.is_dir()
        )
        if unpacked_task_ids != sorted(task_ids):
            missing_ids = sorted(set(task_ids) - set(unpacked_task_ids))
            unexpected_ids = sorted(set(unpacked_task_ids) - set(task_ids))
            raise RuntimeError(
                "Bundle task set does not match the official split "
                f"(missing={missing_ids[:20]}, unexpected={unexpected_ids[:20]})"
            )
        required_databases = [app_name + ".jsonl" for app_name in get_all_apps()]
        for task_id in task_ids:
            task = unpacked / "tasks" / task_id
            missing.extend(
                f"tasks/{task_id}/{relative.as_posix()}"
                for relative in (*REQUIRED_TASK_FILES, *REQUIRED_EVALUATION_FILES)
                if not (task / relative).is_file()
            )
            missing.extend(
                f"tasks/{task_id}/dbs/{database}"
                for database in required_databases
                if not (task / "dbs" / database).is_file()
            )
        if missing:
            preview = "\n".join(f"- {item}" for item in missing[:30])
            raise RuntimeError(f"Bundle verification failed; missing files:\n{preview}")
        metadata = json.loads((unpacked / "metadata.json").read_text(encoding="utf-8"))
        expected_metadata = {
            "dataset": split,
            "method": {"name": method_name, "tooltip": method_tooltip},
            "llm": {"name": llm_name, "tooltip": llm_tooltip},
            "url": url,
        }
        for key, expected in expected_metadata.items():
            if metadata.get(key) != expected:
                raise RuntimeError(
                    f"Bundle metadata mismatch for {experiment_name}.{key}: "
                    f"expected {expected!r}, got {metadata.get(key)!r}"
                )
        if not re.fullmatch(r"[0-9a-f]{8}", str(metadata.get("id", ""))):
            raise RuntimeError(f"Bundle metadata has an invalid experiment ID: {metadata.get('id')!r}")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(metadata.get("date", ""))):
            raise RuntimeError(f"Bundle metadata has an invalid date: {metadata.get('date')!r}")
    return bundle, metadata


def make_official_entry(
    context: ExportContext,
    normal_experiment: str,
    challenge_experiment: str,
    expected_method: dict[str, str],
    expected_llm: dict[str, str],
    expected_url: str,
) -> dict[str, Any]:
    source = """
import json
import sys
from appworld import update_root
from appworld.leaderboard import make_leaderboard_entry

update_root(sys.argv[1])
entry = make_leaderboard_entry(
    testn_experiment_name=sys.argv[2],
    testc_experiment_name=sys.argv[3],
    force_evaluate=False,
    save=False,
)
print(json.dumps(entry, ensure_ascii=True))
"""
    print("+", "official AppWorld make (UTF-8)", flush=True)
    completed = subprocess.run(
        [
            sys.executable,
            "-X",
            "utf8",
            "-c",
            source,
            str(context.root),
            normal_experiment,
            challenge_experiment,
        ],
        cwd=context.project,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    entry = json.loads(completed.stdout)
    expected = {
        "method": expected_method,
        "llm": expected_llm,
        "url": expected_url,
    }
    for key, value in expected.items():
        if entry.get(key) != value:
            raise RuntimeError(
                f"Official AppWorld leaderboard entry mismatch for {key}: "
                f"expected {value!r}, got {entry.get(key)!r}"
            )
    for split in SPLITS:
        aggregate = entry.get(split, {}).get("all", {})
        if not all(key in aggregate for key in ("task_goal_completion", "scenario_goal_completion", "interactions")):
            raise RuntimeError(f"Official AppWorld leaderboard entry is incomplete for {split}")
    return entry


def stage_submission(
    submission_directory: Path,
    name_prefix: str,
    bundles: list[dict[str, Any]],
    leaderboard_entry: dict[str, Any],
) -> Path:
    if submission_directory.exists():
        raise RuntimeError(
            f"Submission directory already exists: {submission_directory}. "
            "Choose a new --submission-dir; review artifacts are never overwritten."
        )
    stage = submission_directory.with_name(
        f".{submission_directory.name}-{uuid.uuid4().hex}.tmp"
    )
    try:
        artifacts = []
        for item in bundles:
            source = Path(item["bundle"])
            relative = Path("experiments") / "outputs" / item["experiment"] / "leaderboard.bundle"
            local_relative = Path("pr-files") / relative
            destination = stage / local_relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            source_hash = sha256_file(source)
            destination_hash = sha256_file(destination)
            if source.stat().st_size != destination.stat().st_size or source_hash != destination_hash:
                raise RuntimeError(f"Staged bundle does not match its source: {destination}")
            artifacts.append(
                {
                    "split": item["split"],
                    "experiment": item["experiment"],
                    "prPath": relative.as_posix(),
                    "localPath": local_relative.as_posix(),
                    "bytes": destination.stat().st_size,
                    "sha256": destination_hash,
                    "encryptedBundle": True,
                    "unpackVerified": True,
                }
            )
        manifest = {
            "schemaVersion": 1,
            "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "readyForLeaderboardPr": True,
            "uploaded": False,
            "committed": False,
            "pushed": False,
            "pullRequestCreated": False,
            "experimentPrefix": name_prefix,
            "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}",
            "appworldVersion": package_version("appworld"),
            "officialCommand": (
                "/add-to-leaderboard "
                f"--python {sys.version_info.major}.{sys.version_info.minor} "
                f"--appworld {package_version('appworld')} {name_prefix}"
            ),
            "leaderboardEntry": leaderboard_entry,
            "artifacts": artifacts,
            "notes": [
                "The pr-files directory mirrors the official appworld-leaderboard repository layout.",
                "Only the two encrypted leaderboard.bundle files under pr-files belong in a future leaderboard PR.",
                "The local submission-manifest.json is review evidence and must not be included in the PR.",
                "No upload, Git commit, Git push, or pull request was performed.",
            ],
        }
        stage.mkdir(parents=True, exist_ok=True)
        (stage / "submission-manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        stage.rename(submission_directory)
    except Exception:
        shutil.rmtree(stage, ignore_errors=True)
        raise
    return submission_directory / "submission-manifest.json"


def common_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--project", default=".", help="Capybara AppWorld project directory")
    parser.add_argument(
        "--root",
        default=".venv/appworld-root",
        help="AppWorld root, relative to --project unless absolute",
    )
    parser.add_argument("--backend", default="http://127.0.0.1:3005", help="Capybara backend URL")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    audit = subparsers.add_parser("audit", help="Read-only audit of one training Run")
    common_arguments(audit)
    audit.add_argument("--run-id", required=True)
    audit.add_argument("--split", required=True, choices=SPLITS)

    build = subparsers.add_parser(
        "build",
        help="Build and verify paired official test_normal and test_challenge bundles",
    )
    common_arguments(build)
    build.add_argument("--normal-run-id", required=True)
    build.add_argument("--challenge-run-id", required=True)
    build.add_argument("--name-prefix", required=True)
    build.add_argument("--method-name", required=True)
    build.add_argument("--method-tooltip", required=True)
    build.add_argument("--llm-name")
    build.add_argument("--llm-tooltip")
    build.add_argument("--url", required=True)
    build.add_argument(
        "--submission-dir",
        help="Create a review-only directory mirroring the official leaderboard repository layout",
    )
    return parser.parse_args()


def export_context(args: argparse.Namespace) -> ExportContext:
    project = Path(args.project).resolve()
    root_value = Path(args.root)
    root = root_value.resolve() if root_value.is_absolute() else (project / root_value).resolve()
    if not project.is_dir():
        raise RuntimeError(f"Project directory was not found: {project}")
    if not (root / "data" / "datasets").is_dir():
        raise RuntimeError(f"AppWorld root was not found or is incomplete: {root}")
    return ExportContext(backend=args.backend, project=project, root=root)


def main() -> None:
    args = parse_args()
    context = export_context(args)
    if args.command == "audit":
        audit = audit_run(context, args.run_id, args.split)
        print(json.dumps(audit_summary(audit), indent=2, ensure_ascii=True))
        return

    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.name_prefix):
        raise RuntimeError("--name-prefix must use lowercase letters, numbers, hyphens, and underscores")
    normal = audit_run(context, args.normal_run_id, "test_normal")
    challenge = audit_run(context, args.challenge_run_id, "test_challenge")
    require_complete_pair(normal, challenge)
    all_cases = [*normal.ready_cases, *challenge.ready_cases]
    provenance = experiment_provenance(context, all_cases)
    validate_pair(normal, challenge, provenance)
    model = provenance["model"]
    method_name = validate_submission_text("--method-name", args.method_name)
    method_tooltip = validate_submission_text("--method-tooltip", args.method_tooltip)
    llm_name = validate_submission_text(
        "--llm-name",
        args.llm_name or str(model.get("model") or "unknown"),
    )
    llm_tooltip = validate_submission_text(
        "--llm-tooltip",
        args.llm_tooltip
        or f"Model ID {model.get('model', 'unknown')} via {model.get('protocol', 'unknown')} API",
    )
    url = validate_public_url(args.url)

    results = []
    bundle_metadata = []
    for audit in (normal, challenge):
        experiment_name = f"{args.name_prefix}_{audit.split}"
        destination = assemble_experiment(context, audit, experiment_name, provenance)
        evaluate_experiment(context, experiment_name, audit.split)
        bundle, metadata = create_bundle(
            context=context,
            experiment_name=experiment_name,
            split=audit.split,
            method_name=method_name,
            method_tooltip=method_tooltip,
            llm_name=llm_name,
            llm_tooltip=llm_tooltip,
            url=url,
            task_ids=audit.official_task_ids,
        )
        bundle_metadata.append(metadata)
        results.append(
            {
                "split": audit.split,
                "experiment": experiment_name,
                "directory": str(destination),
                "bundle": str(bundle),
                "bytes": bundle.stat().st_size,
            }
        )
    comparable_metadata = [
        {key: value for key, value in metadata.items() if key not in {"id", "dataset"}}
        for metadata in bundle_metadata
    ]
    if comparable_metadata[0] != comparable_metadata[1]:
        raise RuntimeError("Normal and Challenge bundle metadata must match except for ID and dataset")
    official_entry = make_official_entry(
        context=context,
        normal_experiment=results[0]["experiment"],
        challenge_experiment=results[1]["experiment"],
        expected_method={"name": method_name, "tooltip": method_tooltip},
        expected_llm={"name": llm_name, "tooltip": llm_tooltip},
        expected_url=url,
    )
    submission_manifest = None
    if args.submission_dir:
        submission_value = Path(args.submission_dir)
        submission_directory = (
            submission_value.resolve()
            if submission_value.is_absolute()
            else (context.project / submission_value).resolve()
        )
        submission_manifest = stage_submission(
            submission_directory=submission_directory,
            name_prefix=args.name_prefix,
            bundles=results,
            leaderboard_entry=official_entry,
        )
    print(
        json.dumps(
            {
                "readyForLeaderboardPr": True,
                "snapshotId": normal.run["snapshotId"],
                "provenance": provenance,
                "leaderboardEntry": official_entry,
                "submissionManifest": str(submission_manifest) if submission_manifest else None,
                "outputs": results,
            },
            indent=2,
            ensure_ascii=True,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1) from error
