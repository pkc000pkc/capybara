"""Pure, answer-blind normalization for Actor-owned task reconciliation.

This module intentionally has no ARE, LiteLLM or runtime-host imports. The
bridge supplies the visible USER ledger; this code only binds exact quotes to
that ledger and emits stable source hashes.
"""

from __future__ import annotations

import hashlib
import json
import math
from typing import Any


class ReconciliationProtocolError(ValueError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def source_text_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _javascript_number(value: int | float) -> str:
    """Serialize JSON numbers with the same thresholds as JSON.stringify."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if not math.isfinite(value):
        raise ValueError("non-finite JSON number")
    if value == 0:
        return "0"
    if value.is_integer() and abs(value) < 1e21:
        return str(int(value))
    raw = repr(value).lower()
    negative = raw.startswith("-")
    unsigned = raw[1:] if negative else raw
    magnitude = abs(value)
    if "e" not in unsigned:
        return raw
    mantissa, exponent_text = unsigned.split("e", 1)
    exponent = int(exponent_text)
    # ECMAScript uses fixed notation for [1e-6, 1e21), even when Python's
    # shortest representation selected an exponent.
    if 1e-6 <= magnitude < 1e21:
        digits = mantissa.replace(".", "")
        decimal_position = (mantissa.find(".") if "." in mantissa else len(mantissa)) + exponent
        if decimal_position <= 0:
            result = "0." + ("0" * (-decimal_position)) + digits
        elif decimal_position >= len(digits):
            result = digits + ("0" * (decimal_position - len(digits)))
        else:
            result = digits[:decimal_position] + "." + digits[decimal_position:]
        if "." in result:
            result = result.rstrip("0").rstrip(".")
        return ("-" if negative else "") + result
    # Normalize exponent padding: JS emits e-7/e+21, not e-07/e+021.
    return ("-" if negative else "") + mantissa + "e" + ("+" if exponent >= 0 else "-") + str(abs(exponent))


def _canonical_argument_json(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _javascript_number(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, list):
        return "[" + ",".join(_canonical_argument_json(item) for item in value) + "]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("JSON object keys must be strings")
        return "{" + ",".join(
            json.dumps(key, ensure_ascii=False) + ":" + _canonical_argument_json(value[key])
            for key in sorted(value)
        ) + "}"
    raise ValueError("unsupported JSON value")


def argument_digest(value: Any) -> str:
    raw = _canonical_argument_json(value).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def normalize_supersede_quote(value: Any, content: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > 4096 or not isinstance(content, str) or content.count(value) != 1:
        raise ReconciliationProtocolError("task_reconciliation_supersede_quote")
    return value


def normalize_argument_checks(raw_checks: Any, *, safe_json_value) -> list[dict[str, Any]]:
    """Normalize Actor field checks without any hidden task/evaluator data."""
    if raw_checks is None:
        return []
    if not isinstance(raw_checks, list) or len(raw_checks) > 16:
        raise ReconciliationProtocolError("task_reconciliation_argument_checks")
    normalized: list[dict[str, Any]] = []
    for check in raw_checks:
        if not isinstance(check, dict) or set(check) - {"path", "op", "expectedHash", "value", "min", "max"}:
            raise ReconciliationProtocolError("task_reconciliation_argument_check")
        path, op = check.get("path"), check.get("op")
        if not isinstance(path, str) or not path or len(path) > 128 or not path.startswith("/"):
            raise ReconciliationProtocolError("task_reconciliation_argument_path")
        if op not in ("equals_hash", "present", "array_contains_hash", "number_range"):
            raise ReconciliationProtocolError("task_reconciliation_argument_op")
        item: dict[str, Any] = {"path": path, "op": op}
        supplied_hash = check.get("expectedHash")
        has_value = "value" in check
        if op in ("equals_hash", "array_contains_hash"):
            if supplied_hash is None and not has_value:
                raise ReconciliationProtocolError("task_reconciliation_argument_hash")
            if has_value:
                value = check.get("value")
                if not safe_json_value(value) or len(json.dumps(value, ensure_ascii=False, separators=(",", ":"))) > 4096:
                    raise ReconciliationProtocolError("task_reconciliation_argument_value")
                supplied_hash = argument_digest(value)
            if not isinstance(supplied_hash, str) or len(supplied_hash) != 64 or any(char not in "0123456789abcdef" for char in supplied_hash):
                raise ReconciliationProtocolError("task_reconciliation_argument_hash")
            item["expectedHash"] = supplied_hash
        elif op == "present":
            if any(key in check for key in ("expectedHash", "value", "min", "max")):
                raise ReconciliationProtocolError("task_reconciliation_argument_present")
        else:
            if has_value or "expectedHash" in check:
                raise ReconciliationProtocolError("task_reconciliation_argument_range")
            minimum, maximum = check.get("min"), check.get("max")
            if minimum is None and maximum is None:
                raise ReconciliationProtocolError("task_reconciliation_argument_range")
            if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                   for value in (minimum, maximum) if value is not None) or minimum is not None and maximum is not None and maximum < minimum:
                raise ReconciliationProtocolError("task_reconciliation_argument_range")
            if minimum is not None:
                item["min"] = minimum
            if maximum is not None:
                item["max"] = maximum
        normalized.append(item)
    return normalized


def _unique_user_for_quote(quote: str, users: list[dict[str, Any]], requested_ref: str | None = None) -> dict[str, Any]:
    candidates = [item for item in users
                  if isinstance(item.get("content"), str)
                  and item["content"].count(quote) == 1
                  and quote in item["content"]]
    if requested_ref not in (None, "", "latest"):
        candidates = [item for item in candidates if item.get("id") == requested_ref]
    if len(candidates) != 1:
        raise ReconciliationProtocolError("task_reconciliation_scope_quote")
    return candidates[0]


def resolve_scope_anchor(*, quote: str, users: list[dict[str, Any]], requested_ref: str | None = None,
                         continuation_quotes: list[str] | None = None) -> tuple[dict[str, Any], list[dict[str, str]]]:
    if not isinstance(quote, str) or not quote or len(quote) > 4096:
        raise ReconciliationProtocolError("task_reconciliation_quote")
    if not isinstance(users, list):
        raise ReconciliationProtocolError("task_reconciliation_user")
    if continuation_quotes is None:
        if requested_ref in (None, "", "latest"):
            user = users[-1] if users else None
        else:
            user = next((item for item in users if item.get("id") == requested_ref), None)
        if not isinstance(user, dict) or not isinstance(user.get("content"), str) or user["content"].count(quote) != 1:
            raise ReconciliationProtocolError("task_reconciliation_quote_binding")
        content = user["content"]
        return user, [{"userRef": user["id"], "sourceHash": source_text_hash(content), "quote": quote}]

    if not isinstance(continuation_quotes, list) or not (1 <= len(continuation_quotes) <= 8):
        raise ReconciliationProtocolError("task_reconciliation_scope_anchor")
    if any(not isinstance(item, str) or not item or len(item) > 4096 for item in continuation_quotes):
        raise ReconciliationProtocolError("task_reconciliation_scope_anchor")
    user = _unique_user_for_quote(quote, users, requested_ref)
    root_index = users.index(user)
    members = [{"userRef": user["id"], "sourceHash": source_text_hash(user["content"]), "quote": quote}]
    seen = {user["id"]}
    previous_index = root_index
    for continuation_quote in continuation_quotes:
        continuation = _unique_user_for_quote(continuation_quote, users)
        continuation_index = users.index(continuation)
        if continuation["id"] in seen:
            raise ReconciliationProtocolError("task_reconciliation_scope_duplicate")
        if continuation_index <= previous_index:
            raise ReconciliationProtocolError("task_reconciliation_scope_order")
        seen.add(continuation["id"])
        members.append({"userRef": continuation["id"], "sourceHash": source_text_hash(continuation["content"]), "quote": continuation_quote})
        previous_index = continuation_index
    return user, members
