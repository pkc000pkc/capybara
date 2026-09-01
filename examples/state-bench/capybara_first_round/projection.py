from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from capybara_first_round.config import ROOT, git_output, load_first_round_config, sha256_file

TRAIN_OUTPUT = ROOT / "datasets" / "capybara" / "first_round_train.jsonl"
SANITY_OUTPUT = ROOT / "datasets" / "capybara" / "first_round_sanity.jsonl"
MANIFEST_OUTPUT = ROOT / "datasets" / "capybara" / "first_round_manifest.json"

TRAIN_SCORING_PROMPT = """You are grading an offline procedural analysis of a STATE-Bench training trajectory.

Expected contract:
{{ answer }}

Actual analysis:
{{ actual }}

Pass only when the actual analysis is substantive, contains all four required headings, distinguishes reliable procedures from failure risks, includes verification or user-control guidance, states transfer limits, and does not merely repeat task-specific IDs or an exact answer. Project tools are not expected.

Return exactly one JSON object with this shape and no Markdown fence:
{"score": <number from 0 to 1>, "passed": <boolean>, "rationale": "<concise explanation>"}
Set passed=true only when score is at least 0.8.
"""

EXPECTED_ANALYSIS = (
    "A valid response contains the Markdown headings Reliable procedures, Failure modes and safeguards, "
    "Verification and user control, and Transfer limits. It extracts reusable behavior from the supplied "
    "training-only trajectory, separates supported actions from possible mistakes, and excludes task-specific IDs, "
    "exact answers, credentials, and held-out information."
)


def _natural_key(path: Path) -> tuple[int, str]:
    match = re.match(r"(\d+)-", path.stem)
    return (int(match.group(1)) if match else 10**9, path.stem)


def selected_training_paths(domain: str, limit: int) -> list[Path]:
    source = ROOT / "datasets" / "train_task_trajectories" / domain
    paths = sorted(source.glob("*.json"), key=_natural_key)
    if len(paths) < limit:
        raise ValueError(f"{domain} has only {len(paths)} training trajectories")
    return paths[:limit]


def _trajectory_question(domain: str, path: Path, conversation: list[dict[str, Any]]) -> str:
    payload = json.dumps(conversation, ensure_ascii=False, indent=2)
    return f"""Analyze one official STATE-Bench training-only trajectory for reusable procedural learning.

Domain: {domain}
Training source label: {path.stem}

The source below is demonstration evidence, not a new task to execute. Do not call tools. Inspect the full order of user messages, assistant claims, tool arguments, tool results, and later user feedback. Identify which behavior is supported, which behavior may be unsafe or incorrect, how state changes should be verified, and what transfers to another task. Do not retain task-specific identifiers or exact answers.

Training trajectory conversation JSON:
{payload}
"""


def _record(domain: str, path: Path) -> dict[str, Any]:
    source = json.loads(path.read_text(encoding="utf-8"))
    conversation = source.get("conversation")
    if not isinstance(conversation, list) or not conversation:
        raise ValueError(f"Training trajectory has no conversation: {path}")
    return {
        "id": f"{domain}:{path.stem}",
        "question": _trajectory_question(domain, path, conversation),
        "thinking": "Treat the supplied trajectory as training evidence and extract only reusable procedure.",
        "answer": EXPECTED_ANALYSIS,
        "expectedTools": [],
        "metadata": {
            "tags": ["state-bench", "training-only", domain, "first-round"],
            "domain": domain,
            "source_path": path.relative_to(ROOT).as_posix(),
            "source_sha256": sha256_file(path),
        },
    }


def _write_jsonl(path: Path, records: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n" for record in records)
    path.write_text(text, encoding="utf-8", newline="\n")


def prepare_projection(cases_per_domain: int | None = None) -> dict[str, Any]:
    config = load_first_round_config()
    current_commit = git_output(ROOT, "rev-parse", "HEAD")
    if current_commit != config["benchmark_commit"]:
        raise ValueError(f"STATE-Bench commit mismatch: expected {config['benchmark_commit']}, got {current_commit}")

    limit = int(config["train_trajectories_per_domain"] if cases_per_domain is None else cases_per_domain)
    if limit < 1:
        raise ValueError("cases_per_domain must be at least 1")
    records: list[dict[str, Any]] = []
    selected: dict[str, list[dict[str, str]]] = {}
    for domain in config["domains"]:
        paths = selected_training_paths(domain, limit)
        domain_records = [_record(domain, path) for path in paths]
        records.extend(domain_records)
        selected[domain] = [
            {
                "record_id": record["id"],
                "source_path": record["metadata"]["source_path"],
                "source_sha256": record["metadata"]["source_sha256"],
            }
            for record in domain_records
        ]
    _write_jsonl(TRAIN_OUTPUT, records)

    sanity_record = {
        "id": "state-bench:first-round-snapshot-sanity",
        "question": (
            "Review the replay-approved STATE-Bench guidance currently present in the system prompt. "
            "Return the four required analysis headings and explain how to apply guidance conservatively without "
            "using task-specific facts or modifying any variable. Do not call tools."
        ),
        "thinking": "This is a synthetic read-only snapshot sanity check, not a held-out benchmark task.",
        "answer": EXPECTED_ANALYSIS,
        "expectedTools": [],
        "metadata": {"tags": ["state-bench", "synthetic", "snapshot-sanity"]},
    }
    _write_jsonl(SANITY_OUTPUT, [sanity_record])

    manifest = {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "benchmark_commit": current_commit,
        "benchmark_version": config["benchmark_version"],
        "selection_rule": "lowest numeric filename prefixes from train_task_trajectories only",
        "held_out_task_files_read": False,
        "records": len(records),
        "cases_per_domain": limit,
        "selected": selected,
        "train_jsonl": TRAIN_OUTPUT.relative_to(ROOT).as_posix(),
        "train_jsonl_sha256": sha256_file(TRAIN_OUTPUT),
        "sanity_jsonl": SANITY_OUTPUT.relative_to(ROOT).as_posix(),
        "sanity_jsonl_sha256": sha256_file(SANITY_OUTPUT),
    }
    MANIFEST_OUTPUT.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return manifest
