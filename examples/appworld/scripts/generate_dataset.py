from __future__ import annotations

import argparse
import hashlib
import json
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import appworld
from appworld import update_root
from appworld.task import load_task_ids, task_id_to_generator_id


PROJECTION_VERSION = 1
NORMALIZED_RECORD_TIMESTAMP = "1970-01-01T00:00:00.000Z"
EXPECTED_TOOLS = ["search_resources", "load_resources", "appworld_execute"]
APPWORLD_TASKS_PER_SCENARIO = 3


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"expected a JSON object: {path}")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def data_version(root: Path) -> str:
    version_file = root / "data" / "version.txt"
    if version_file.is_file():
        value = version_file.read_text(encoding="utf-8").strip()
        if value:
            return value
    from appworld.common.constants import DB_VERSION

    return str(DB_VERSION)


def task_projection(root: Path, split: str, task_id: str) -> dict[str, Any]:
    task_dir = root / "data" / "tasks" / task_id
    specs = read_json(task_dir / "specs.json")
    metadata = read_json(task_dir / "ground_truth" / "metadata.json")
    instruction = specs.get("instruction")
    if not isinstance(instruction, str) or not instruction.strip():
        raise RuntimeError(f"task {task_id} does not contain a non-empty instruction")
    difficulty = metadata.get("difficulty")
    if not isinstance(difficulty, int) or difficulty not in {1, 2, 3}:
        raise RuntimeError(f"task {task_id} has an invalid difficulty")
    scenario_id = task_id_to_generator_id(task_id)
    return {
        "task_id": task_id,
        "scenario_id": scenario_id,
        "split": split,
        "difficulty": difficulty,
        "instruction": instruction,
    }


def select_tasks(
    candidates: list[dict[str, Any]],
    selection: str,
    limit: int | None,
) -> tuple[list[dict[str, Any]], bool]:
    if selection == "tasks":
        selected = candidates if limit is None else candidates[:limit]
        selected_ids = {item["task_id"] for item in selected}
        scenario_sizes: dict[str, int] = {}
        selected_sizes: dict[str, int] = {}
        for item in candidates:
            scenario = str(item["scenario_id"])
            scenario_sizes[scenario] = scenario_sizes.get(scenario, 0) + 1
            if item["task_id"] in selected_ids:
                selected_sizes[scenario] = selected_sizes.get(scenario, 0) + 1
        complete = bool(selected) and all(
            count == scenario_sizes[scenario]
            for scenario, count in selected_sizes.items()
        )
        return selected, complete

    scenarios: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
    for item in candidates:
        scenarios.setdefault(str(item["scenario_id"]), []).append(item)
    incomplete = {
        scenario: len(items)
        for scenario, items in scenarios.items()
        if len(items) != APPWORLD_TASKS_PER_SCENARIO
    }
    if incomplete:
        detail = ", ".join(f"{scenario}={count}" for scenario, count in list(incomplete.items())[:5])
        raise RuntimeError(f"scenario selection requires exactly three tasks per scenario: {detail}")
    selected_scenarios = list(scenarios.values()) if limit is None else list(scenarios.values())[:limit]
    return [item for scenario in selected_scenarios for item in scenario], True


def default_dataset_id(split: str, difficulty: int | None, selection: str, limit: int | None) -> str:
    difficulty_label = f"d{difficulty}" if difficulty is not None else "all"
    unit = "tasks" if selection == "tasks" else "scenarios"
    count_label = str(limit) if limit is not None else "all"
    return f"appworld-{split.replace('_', '-')}-{difficulty_label}-{unit}-{count_label}"


def dataset_purpose(split: str) -> str:
    return "training-context" if split == "train" else "closed-book-eval"


def registry_file(project: Path) -> dict[str, Any]:
    file = project / ".capybara" / "datasets.json"
    if not file.is_file():
        return {"version": 1, "items": []}
    value = read_json(file)
    if value.get("version") != 1 or not isinstance(value.get("items"), list):
        raise RuntimeError("invalid .capybara/datasets.json registry")
    return value


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a local Capybara projection of AppWorld tasks.")
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--split", default="dev", choices=["train", "dev", "test_normal", "test_challenge"])
    parser.add_argument("--selection", default="tasks", choices=["tasks", "scenarios"])
    parser.add_argument("--limit", default=1, type=int, help="Number of tasks or complete scenarios to select.")
    parser.add_argument("--all", action="store_true", help="Select every matching task or complete scenario.")
    parser.add_argument("--difficulty", type=int, choices=[1, 2, 3])
    parser.add_argument("--dataset-id")
    args = parser.parse_args()
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    limit = None if args.all else args.limit

    project = args.project.resolve()
    root = args.root.resolve()
    update_root(str(root))
    package_version = appworld.__version__
    installed_data_version = data_version(root)
    task_ids = sorted(load_task_ids(args.split))
    candidates = [task_projection(root, args.split, task_id) for task_id in task_ids]
    if args.difficulty is not None:
        candidates = [item for item in candidates if item["difficulty"] == args.difficulty]
    selected, scenario_complete = select_tasks(candidates, args.selection, limit)
    if not selected:
        raise RuntimeError("no AppWorld tasks matched the requested projection")

    dataset_id = args.dataset_id or default_dataset_id(args.split, args.difficulty, args.selection, limit)
    purpose = dataset_purpose(args.split)
    records = [
        {
            "id": item["task_id"],
            "question": item["instruction"],
            "thinking": "",
            "answer": "",
            "expectedTools": EXPECTED_TOOLS,
            "metadata": {
                "tags": ["appworld", args.split, f"difficulty-{item['difficulty']}"],
                "public": {},
                "private": {
                    "appworld": {
                        "task_id": item["task_id"],
                        "split": args.split,
                        "difficulty": item["difficulty"],
                        "scenario_id": item["scenario_id"],
                    }
                },
                "createdAt": NORMALIZED_RECORD_TIMESTAMP,
                "updatedAt": NORMALIZED_RECORD_TIMESTAMP,
            },
        }
        for item in selected
    ]
    data_source = "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records)
    content_hash = hashlib.sha256(data_source.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    dataset_dir = project / "datasets" / dataset_id
    old_source_file = dataset_dir / "source.json"
    old_source = read_json(old_source_file) if old_source_file.is_file() else {}
    data_file = dataset_dir / "data" / f"{args.split}.jsonl"
    data_file.parent.mkdir(parents=True, exist_ok=True)
    data_file.write_text(data_source, encoding="utf-8", newline="\n")
    (dataset_dir / "README.md").write_text(
        "---\nconfigs:\n- config_name: default\n  data_files:\n"
        f"  - split: {args.split}\n    path: data/{args.split}.jsonl\n---\n\n"
        f"# {dataset_id}\n\n"
        "Local QTA projection of official AppWorld tasks. The official data license requires public "
        "redistribution of this derivative to remain encrypted. Do not publish this directory unencrypted.\n",
        encoding="utf-8",
        newline="\n",
    )
    scenario_ids = list(dict.fromkeys(str(item["scenario_id"]) for item in selected))
    source = {
        "benchmark": "appworld",
        "packageVersion": package_version,
        "dataVersion": installed_data_version,
        "projectionVersion": PROJECTION_VERSION,
        "purpose": purpose,
        "split": args.split,
        "selection": args.selection,
        "difficulty": args.difficulty,
        "scenarioComplete": scenario_complete,
        "taskIds": [record["id"] for record in records],
        "scenarioIds": scenario_ids,
        "contentHash": content_hash,
        "generatedAt": now,
    }
    write_json(old_source_file, source)

    registry = registry_file(project)
    items = registry["items"]
    existing = next((item for item in items if isinstance(item, dict) and item.get("id") == dataset_id), None)
    unchanged = old_source.get("contentHash") == content_hash
    created_at = existing.get("createdAt", now) if existing else now
    updated_at = existing.get("updatedAt", now) if existing and unchanged else now
    version = int(existing.get("version", 1)) if existing and unchanged else int(existing.get("version", 0)) + 1 if existing else 1
    unit_label = "task smoke" if args.selection == "tasks" else "complete scenarios"
    scope_label = "all" if limit is None else str(limit)
    reference = {
        "id": dataset_id,
        "name": f"AppWorld {args.split.replace('_', '-')} {unit_label} {scope_label}",
        "storage": "huggingface",
        "path": f"datasets/{dataset_id}",
        "version": version,
        "tags": [
            "appworld",
            args.split,
            purpose,
            "state-evaluated",
            "scenario-complete" if scenario_complete else "smoke-only",
        ],
        "scoringPrompt": "",
        "createdAt": created_at,
        "updatedAt": updated_at,
    }
    if existing:
        items[items.index(existing)] = reference
    else:
        items.append(reference)
    write_json(project / ".capybara" / "datasets.json", registry)
    print(json.dumps(source, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
