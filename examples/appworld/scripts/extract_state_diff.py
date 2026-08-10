from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import date, datetime
from enum import Enum
from typing import Any

from appworld import update_root
from appworld.apps.model_lib import get_db_home_path
from appworld.collections.models import ModelCollection, ModelCollectionPair
from appworld.task import Task


OMITTED_FIELDS = {"id", "record_hash", "_db_home_path"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Extract bounded AppWorld record-level state changes.")
    parser.add_argument("--root")
    parser.add_argument("--task-id")
    parser.add_argument("--output-dbs")
    parser.add_argument("--batch", action="store_true")
    parser.add_argument("--max-records", type=int, default=100)
    parser.add_argument("--max-fields", type=int, default=40)
    parser.add_argument("--max-value-chars", type=int, default=2_000)
    return parser.parse_args()


def json_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ") if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, Enum):
        return json_value(value.value)
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_value(item) for item in value]
    return str(value)


def bounded_value(value: Any, maximum: int) -> Any:
    normalized = json_value(value)
    encoded = json.dumps(normalized, ensure_ascii=False, separators=(",", ":"))
    if len(encoded) <= maximum:
        return normalized
    if isinstance(normalized, str):
        return f"{normalized[:maximum]}... [truncated {len(normalized) - maximum} chars]"
    return {
        "preview": encoded[:maximum],
        "truncated": True,
        "originalCharacters": len(encoded),
    }


def record_dict(record: Any) -> dict[str, Any]:
    return record.to_dict(keep_computed=False, humanize=False)


def field_names(before: dict[str, Any] | None, after: dict[str, Any] | None) -> list[str]:
    names = (set(before or {}) | set(after or {})) - OMITTED_FIELDS
    return sorted(names, key=lambda name: (name in {"created_at", "updated_at"}, name))


def record_change(
    operation: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
    max_fields: int,
    max_value_chars: int,
) -> dict[str, Any]:
    identifier = (after or before or {}).get("id")
    changed_names = []
    for name in field_names(before, after):
        before_value = json_value((before or {}).get(name))
        after_value = json_value((after or {}).get(name))
        if operation == "updated" and before_value == after_value:
            continue
        changed_names.append(name)
    selected_names = changed_names[:max_fields]
    fields = []
    for name in selected_names:
        field: dict[str, Any] = {"field": name}
        if before is not None:
            field["before"] = bounded_value(before.get(name), max_value_chars)
        if after is not None:
            field["after"] = bounded_value(after.get(name), max_value_chars)
        fields.append(field)
    result: dict[str, Any] = {
        "recordId": json_value(identifier),
        "operation": operation,
        "fields": fields,
    }
    if len(changed_names) > len(selected_names):
        result["truncatedFields"] = len(changed_names) - len(selected_names)
    return result


def extract_case(
    root_value: str,
    task_id: str,
    output_dbs_value: str,
    max_records: int,
    max_fields: int,
    max_value_chars: int,
) -> dict[str, Any]:
    root = os.path.abspath(root_value)
    output_dbs = os.path.abspath(output_dbs_value)
    update_root(root)
    task = Task.load(task_id=task_id)
    start = task.model_collection
    end_memory = get_db_home_path(
        storage_type="memory",
        type="task_output",
        task_id=f"capybara_state_diff_{uuid.uuid4().hex}",
    )
    end = ModelCollection.load(
        to_db_home_path=end_memory,
        from_db_home_path=output_dbs,
        load_apps=task.allowed_apps,
    )
    models = ModelCollectionPair(
        start_db_home_path=start.from_db_home_path,
        start_model_collection=start,
        end_db_home_path=end_memory,
        end_model_collection=end,
    )
    remaining = max(0, max_records)
    changes = []
    for model_name in sorted(models.changed_model_names()):
        application, model = model_name.split(".", 1)
        added, updated_after, removed = models.changed_records(model_name, updated_state="end")
        _, updated_before, _ = models.changed_records(model_name, updated_state="start")
        before_by_id = {record.id: record_dict(record) for record in updated_before}
        after_by_id = {record.id: record_dict(record) for record in updated_after}
        candidates = [
            *(record_change("added", None, record_dict(record), max_fields, max_value_chars) for record in added),
            *(
                record_change(
                    "updated",
                    before_by_id.get(identifier),
                    after_by_id.get(identifier),
                    max_fields,
                    max_value_chars,
                )
                for identifier in sorted(set(before_by_id) | set(after_by_id))
            ),
            *(record_change("removed", record_dict(record), None, max_fields, max_value_chars) for record in removed),
        ]
        selected = candidates[:remaining]
        remaining -= len(selected)
        change: dict[str, Any] = {
            "application": application,
            "model": model,
            "records": len(candidates),
            "added": len(added),
            "updated": len(updated_after),
            "removed": len(removed),
            "recordChanges": selected,
        }
        if len(candidates) > len(selected):
            change["truncatedRecords"] = len(candidates) - len(selected)
        changes.append(change)
    return {"changes": changes}


def main() -> None:
    args = parse_args()
    if args.max_records < 0 or args.max_fields < 1 or args.max_value_chars < 100:
        raise ValueError("state diff limits are invalid")
    if args.batch:
        payload = json.load(sys.stdin)
        items = []
        for item in payload.get("items", []):
            try:
                result = extract_case(
                    payload["root"],
                    item["taskId"],
                    item["outputDbs"],
                    args.max_records,
                    args.max_fields,
                    args.max_value_chars,
                )
                items.append({"id": item["id"], **result})
            except Exception as error:
                items.append({"id": item.get("id"), "error": str(error)})
        output = {"items": items}
    else:
        if not args.root or not args.task_id or not args.output_dbs:
            raise ValueError("--root, --task-id and --output-dbs are required outside batch mode")
        output = extract_case(
            args.root,
            args.task_id,
            args.output_dbs,
            args.max_records,
            args.max_fields,
            args.max_value_chars,
        )
    print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
