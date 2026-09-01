from __future__ import annotations

import hashlib
import json
import math
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

MEMORY_VARIABLES = {
    "memory_general": "*",
    "memory_travel": "travel",
    "memory_customer_support": "customer_support",
    "memory_shopping_assistant": "shopping_assistant",
}
LEARNING_VARIABLES = MEMORY_VARIABLES

CASE_ID_PATTERN = re.compile(
    r"(?<![A-Z0-9])(?:BK|ORD|ITEM|PROD|SP|TRK|FLT|RES|CART)[-_]"
    r"(?=[A-Z0-9_-]*\d)[A-Z0-9_-]+(?![A-Z0-9])|"
    r"(?<![A-Z0-9])(?:cust|user|shop)[-_](?=[A-Z0-9_-]*\d)[A-Z0-9_-]+(?![A-Z0-9])",
    re.IGNORECASE,
)
LEGACY_GUARD_PATTERN = re.compile(
    r"authori[sz]|ownership|privacy|other account|account owner|unsupported (?:claim|assertion)|"
    r"explicit (?:consent|confirmation)|before (?:committing|mutation)|do not trust|"
    r"authoritative (?:record|result|state)|verify .* after",
    re.IGNORECASE,
)


def canonical_snapshot_hash(variables: dict[str, str]) -> str:
    canonical = json.dumps(dict(sorted(variables.items())), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _finite_number(value: Any, fallback: float, label: str) -> float:
    if value is None:
        return fallback
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label} must be numeric") from exc
    if not math.isfinite(parsed):
        raise ValueError(f"{label} must be finite")
    return parsed


def _string_list(value: Any, label: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return [str(item).strip() for item in value if str(item).strip()]


def _atomic_entries(variable: str, domain: str, value: str) -> list[dict[str, Any]]:
    parsed = json.loads(value)
    if not isinstance(parsed, list):
        raise ValueError(f"Frozen memory variable must be a JSON array: {variable}")
    entries: list[dict[str, Any]] = []
    for index, raw in enumerate(parsed):
        if not isinstance(raw, dict):
            raise ValueError(f"{variable}[{index}] must be an object")
        entry_id = raw.get("id")
        trigger = raw.get("trigger")
        rule = raw.get("rule")
        if not all(isinstance(item, str) and item.strip() for item in (entry_id, trigger, rule)):
            raise ValueError(f"{variable}[{index}] requires string id, trigger, and rule")
        entry_domain = str(raw.get("domain") or domain)
        if entry_domain != domain:
            raise ValueError(f"{variable}[{index}] has mismatched domain {entry_domain!r}")
        legacy_text = f"{trigger}\n{rule}"
        mode = str(raw.get("mode") or ("guard" if LEGACY_GUARD_PATTERN.search(legacy_text) else "advice")).strip().lower()
        phase = str(raw.get("phase") or "any").strip().lower()
        if mode not in {"guard", "advice"}:
            raise ValueError(f"{variable}[{index}].mode must be guard or advice")
        if phase not in {"any", "preflight", "decision", "mutation", "verification"}:
            raise ValueError(f"{variable}[{index}].phase is invalid")
        intent = str(raw.get("intent") or entry_id).strip().lower()
        memory_key = str(raw.get("memoryKey") or f"{domain}:{mode}:{phase}:{intent}").strip().lower()
        required_evidence = _string_list(raw.get("requiredEvidence"), f"{variable}[{index}].requiredEvidence")
        block_when = _string_list(raw.get("blockWhen"), f"{variable}[{index}].blockWhen")
        tags = _string_list(raw.get("tags"), f"{variable}[{index}].tags")
        tools = _string_list(raw.get("tools"), f"{variable}[{index}].tools")
        text = "\n".join(
            [memory_key, intent, trigger, rule, *tags, *required_evidence, *block_when]
        )
        leak = CASE_ID_PATTERN.search(text)
        if leak:
            raise ValueError(f"Frozen memory artifact contains task-specific identifier: {variable}={leak.group(0)}")
        confidence = _finite_number(raw.get("confidence"), 0.5, f"{variable}[{index}].confidence")
        evidence_count = int(
            _finite_number(raw.get("evidenceCount"), 1, f"{variable}[{index}].evidenceCount")
        )
        success_count = int(
            _finite_number(raw.get("successCount"), 1, f"{variable}[{index}].successCount")
        )
        failure_count = int(
            _finite_number(raw.get("failureCount"), 0, f"{variable}[{index}].failureCount")
        )
        if not 0 <= confidence <= 1:
            raise ValueError(f"{variable}[{index}].confidence must be between 0 and 1")
        if evidence_count < 1 or success_count < 1 or failure_count < 0:
            raise ValueError(f"{variable}[{index}] has invalid empirical counts")
        entries.append(
            {
                "id": entry_id.strip(),
                "memory_key": memory_key,
                "domain": domain,
                "mode": mode,
                "phase": phase,
                "intent": intent,
                "trigger": trigger.strip(),
                "rule": rule.strip(),
                "tools": tools,
                "tags": tags,
                "confidence": confidence,
                "evidence_count": evidence_count,
                "success_count": success_count,
                "failure_count": failure_count,
                "required_evidence": required_evidence,
                "block_when": block_when,
                "estimated_tokens": math.ceil(len(text) / 4),
                "source_variable": variable,
            }
        )
    return entries


def export_learning_artifact(snapshot: dict[str, Any], output_path: Path, metadata: dict[str, Any]) -> dict[str, Any]:
    variables = snapshot.get("variables")
    if not isinstance(variables, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in variables.items()
    ):
        raise TypeError("Capybara snapshot variables must be a string mapping")
    computed_hash = canonical_snapshot_hash(variables)
    if snapshot.get("contentHash") != computed_hash:
        raise ValueError(
            f"Capybara snapshot hash mismatch: expected {snapshot.get('contentHash')}, computed {computed_hash}"
        )
    try:
        manifest = json.loads(variables["memory_manifest"])
    except (KeyError, json.JSONDecodeError) as exc:
        raise ValueError("Frozen snapshot has no valid memory_manifest") from exc
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") not in {1, 2}:
        raise ValueError("Frozen memory_manifest must use schemaVersion 1 or 2")

    entries = [
        entry
        for variable, domain in MEMORY_VARIABLES.items()
        for entry in _atomic_entries(variable, domain, variables.get(variable, "[]"))
    ]
    if not entries:
        raise ValueError("Frozen learning artifact has no atomic memory entries")
    ids = [entry["id"] for entry in entries]
    if len(ids) != len(set(ids)):
        raise ValueError("Frozen learning artifact repeats an atomic memory ID")

    artifact = {
        "schema_version": 2,
        "created_at": datetime.now(UTC).isoformat(),
        "read_only": True,
        "snapshot_id": snapshot.get("id"),
        "training_run_id": snapshot.get("runId"),
        "snapshot_content_hash": computed_hash,
        "release_id": str(manifest.get("releaseId") or snapshot.get("id") or "unknown"),
        "memory_manifest": manifest,
        "entries": entries,
        "metadata": metadata,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(artifact, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return artifact
