"""Bounded, advisory projection of caller-authenticated execution history.

This module consumes only execution metadata and the existing write ledger. It
does not inspect native tool bodies, change state, authorize completion, or
resolve/retry unknown calls. Mutation receipts must be authenticated by the
caller; the checks here bind an authenticated receipt to its historical row.
"""

import json
import re


_MAX_BYTES = 8192
_MAX_LABEL_BYTES = 256
_MAX_CALL_ID_BYTES = 256
_MAX_RISK_IDS = 8
_MAX_READ_GROUPS = 24
_MAX_READ_QUERY_HASHES = 12
_COUNT_KEYS = ("succeeded", "confirmed_applied", "failed", "unknown", "not_executed", "unsettled")
_STATUSES = frozenset(("succeeded", "failed", "failed_before_execution", "unknown", "blocked", "cancelled"))
_EFFECTS = frozenset(("write", "finish", "unknown"))
_RISK_ORDER = ("unsettled", "unknown", "failed", "not_executed")
_BINDING_FIELDS = ("canonicalName", "resourceKey", "mutationKey", "resultHash", "effect", "executed", "complete", "effectApplied")
_READ_HASH = re.compile(r"^[a-f0-9]{64}$")


def _counts():
    return dict.fromkeys(_COUNT_KEYS, 0)


def _text(value):
    return type(value) is str and bool(value)


def _bounded_text(value, maximum):
    # Omit whole values, never a shortened identifier or a lossy replacement.
    if not _text(value) or any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    try:
        return value if len(value.encode("utf-8")) <= maximum else None
    except UnicodeError:
        return None


def _size(value):
    # Default separators are larger than compact separators, so this bound
    # guarantees both ordinary and compact ensure_ascii=False UTF-8 JSON.
    return len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))


def _base():
    return {"schemaVersion": "gaia2-execution-facts-v1",
            "scope": "write_finish_unknown_and_cancelled_queue", "totalCalls": 0,
            "counts": _counts(), "groups": [], "riskDetails": [], "diagnostics": [],
            "omittedGroups": 0, "projectionComplete": True, "historyIsCurrentState": False,
            "businessCompletion": "not_inferred",
            "readCoverage": {"schemaVersion": "gaia2-read-coverage-v1", "totalCalls": 0,
                              "counts": {"succeeded": 0, "failed": 0, "not_executed": 0, "unknown": 0},
                              "groups": [], "omittedGroups": 0, "repeatedQueries": 0,
                              "projectionComplete": True}}


def _read_record(outcome, observation, identity, diagnostic):
    """Project only authenticated read metadata; never copy the result body."""
    if not isinstance(outcome, dict) or outcome.get("effect") != "read":
        return None
    if not _text(identity):
        diagnostic("read_missing_action_id")
        return None
    observation = observation if isinstance(observation, dict) else {}
    tool = observation.get("canonicalName") or outcome.get("canonicalName")
    resource = observation.get("resourceKey") or outcome.get("resourceKey")
    if not _bounded_text(tool, _MAX_LABEL_BYTES) or not _bounded_text(resource, _MAX_LABEL_BYTES):
        diagnostic("read_invalid_identity")
        return None
    status = outcome.get("status")
    if status == "succeeded" and outcome.get("executed") is True and outcome.get("complete") is True:
        category = "succeeded"
    elif status in ("failed", "failed_before_execution"):
        category = "failed"
    elif status in ("blocked", "cancelled") or outcome.get("executed") is False:
        category = "not_executed"
    else:
        category = "unknown"
    query_hash = observation.get("queryHash")
    result_hash = observation.get("resultHash")
    if query_hash is not None and (not isinstance(query_hash, str) or _READ_HASH.fullmatch(query_hash) is None):
        diagnostic("read_invalid_query_hash")
        query_hash = None
    if result_hash is not None and (not isinstance(result_hash, str) or _READ_HASH.fullmatch(result_hash) is None):
        diagnostic("read_invalid_result_hash")
        result_hash = None
    observed_at = observation.get("observedAt", outcome.get("observedAt"))
    if isinstance(observed_at, bool) or not isinstance(observed_at, (int, float)):
        diagnostic("read_invalid_observed_at")
        observed_at = None
    row = {"identity": identity, "tool": tool, "resource": resource, "status": category}
    if query_hash is not None:
        row["queryHash"] = query_hash
    if result_hash is not None:
        row["resultHash"] = result_hash
    if observed_at is not None:
        row["observedAt"] = observed_at
    if isinstance(observation.get("viewComplete"), bool):
        row["viewComplete"] = observation["viewComplete"]
    row["fingerprint"] = query_hash or (tool + "|" + resource + "|" + (result_hash or ""))
    return row


def _read_coverage(records):
    coverage = _base()["readCoverage"]
    grouped = {}
    for row in records:
        coverage["totalCalls"] += 1
        status = row["status"] if row["status"] in coverage["counts"] else "unknown"
        coverage["counts"][status] += 1
        key = (row["tool"], row["resource"])
        group = grouped.setdefault(key, {"tool": row["tool"], "resource": row["resource"],
                                         "totalCalls": 0, "counts": {"succeeded": 0, "failed": 0,
                                         "not_executed": 0, "unknown": 0}, "queryHashes": [],
                                         "omittedQueryHashes": 0, "repeatedQueries": 0,
                                         "latestObservedAt": None})
        group["totalCalls"] += 1
        group["counts"][status] += 1
        observed_at = row.get("observedAt")
        if isinstance(observed_at, (int, float)) and not isinstance(observed_at, bool):
            latest = group["latestObservedAt"]
            group["latestObservedAt"] = observed_at if latest is None else max(latest, observed_at)
        query = row.get("queryHash") or row["fingerprint"]
        if query in group["queryHashes"]:
            group["repeatedQueries"] += 1
            coverage["repeatedQueries"] += 1
        elif len(group["queryHashes"]) < _MAX_READ_QUERY_HASHES:
            group["queryHashes"].append(query)
        else:
            group["omittedQueryHashes"] += 1
    candidates = list(grouped.values())
    candidates.sort(key=lambda group: (-group["totalCalls"], group["tool"], group["resource"]))
    coverage["omittedGroups"] = len(candidates)
    return coverage, candidates


def _receipt_matches(row, receipt):
    if (type(receipt) is not dict or receipt.get("schemaVersion") != "gaia2-mutation-evidence-v1"
            or receipt.get("kind") != "mutation_confirmed"
            or receipt.get("confirmation") != "confirmed_applied"):
        return False
    ref = receipt.get("callRef")
    if type(ref) is not dict:
        return False
    return (row.get("status") == "succeeded" and _text(row.get("actionId"))
            and row["actionId"] == ref.get("actionId")
            and _text(ref.get("canonicalName"))
            and ("canonicalName" not in row or row["canonicalName"] == ref["canonicalName"])
            and _text(row.get("resourceKey")) and row["resourceKey"] == receipt.get("resourceKey")
            and type(row.get("mutationKey")) is str
            and re.fullmatch(r"[a-f0-9]{64}", row["mutationKey"]) is not None
            and row["mutationKey"] == ref.get("queryHash")
            and type(row.get("resultHash")) is str
            and re.fullmatch(r"[a-f0-9]{64}", row["resultHash"]) is not None
            and row["resultHash"] == ref.get("resultHash")
            and ("effect" not in row or row["effect"] == "write")
            and ("executed" not in row or row["executed"] is True)
            and ("complete" not in row or row["complete"] is True))


def _record(row, identity, *, ledger, unknown_ledger, diagnostic):
    status = row.get("status", "unknown" if unknown_ledger else None)
    valid = type(status) is str and status in _STATUSES
    for key in ("executed", "complete"):
        if key in row and type(row[key]) is not bool:
            valid = False
    if "effectApplied" in row and row["effectApplied"] is not None and type(row["effectApplied"]) is not bool:
        valid = False
    if status == "succeeded" and (row.get("executed") is False or row.get("complete") is False
                                  or not ledger and row.get("executed") is not True):
        valid = False
    if status in ("blocked", "cancelled") and (row.get("executed") is not False or row.get("effectApplied") is True):
        valid = False
    if status == "failed_before_execution" and row.get("effectApplied") is True:
        valid = False
    if unknown_ledger and status != "unknown":
        valid = False
    if not _text(identity):
        valid = False
        diagnostic("missing_action_id")
    if not valid:
        diagnostic("invalid_execution_metadata")
    category = "unsettled"
    if valid:
        if status in ("failed", "failed_before_execution"):
            category = "failed"
        elif status in ("blocked", "cancelled"):
            category = "not_executed"
        else:
            category = status
    fields = {}
    for key in _BINDING_FIELDS:
        value = row.get(key)
        if type(value) is bool and key in ("executed", "complete", "effectApplied"):
            fields[key] = value
        elif _text(value) and key not in ("executed", "complete", "effectApplied"):
            fields[key] = value
        elif key in row and value is not None and key not in ("executed", "complete", "effectApplied"):
            diagnostic("invalid_descriptor")
    confirmed = False
    if ledger and "mutationReceipt" in row:
        confirmed = valid and _receipt_matches(row, row["mutationReceipt"])
        if confirmed:
            fields.setdefault("canonicalName", row["mutationReceipt"]["callRef"]["canonicalName"])
        else:
            diagnostic("receipt_binding_mismatch")
    return {"identity": identity if _text(identity) else None, "status": category,
            "nativeStatus": status if type(status) is str else None, "fields": fields,
            "confirmed": confirmed, "conflicts": set(), "invalid": not valid}


def _merge(prior, incoming, diagnostic):
    conflict = prior["nativeStatus"] != incoming["nativeStatus"]
    for key, value in incoming["fields"].items():
        if key in prior["fields"] and prior["fields"][key] != value:
            prior["conflicts"].add(key)
            conflict = True
        else:
            prior["fields"].setdefault(key, value)
    if conflict:
        diagnostic("conflicting_duplicate_outcomes")
    prior["invalid"] = prior["invalid"] or incoming["invalid"] or conflict
    prior["confirmed"] = prior["confirmed"] or incoming["confirmed"]
    if prior["invalid"]:
        prior["status"] = "unsettled"


def _project(messages, write_state):
    diagnostics = {}

    def diagnostic(code, count=1):
        diagnostics[code] = diagnostics.get(code, 0) + count

    records, anonymous, read_records = {}, [], []

    def add(row, identity, *, ledger=False, unknown_ledger=False):
        record = _record(row, identity, ledger=ledger, unknown_ledger=unknown_ledger, diagnostic=diagnostic)
        if record["identity"] is None:
            anonymous.append(record)
        elif record["identity"] in records:
            _merge(records[record["identity"]], record, diagnostic)
        else:
            records[record["identity"]] = record

    if write_state is not None:
        if type(write_state) is not dict:
            diagnostic("invalid_write_state")
        else:
            for key in ("actions", "unknown"):
                rows = write_state.get(key, [])
                if type(rows) is not list:
                    diagnostic("invalid_ledger_collection")
                    continue
                for row in rows:
                    if type(row) is not dict:
                        diagnostic("invalid_ledger_entry")
                        continue
                    add(row, row.get("actionId"), ledger=True, unknown_ledger=key == "unknown")
    if type(messages) is not list:
        diagnostic("invalid_messages")
    else:
        for message in messages:
            if type(message) is not dict:
                diagnostic("invalid_message")
                continue
            if message.get("role") != "tool" or "executionOutcome" not in message:
                continue
            outcome = message["executionOutcome"]
            if type(outcome) is not dict:
                diagnostic("invalid_execution_metadata")
                continue
            effect, status = outcome.get("effect"), outcome.get("status")
            if effect == "read":
                read = _read_record(outcome, message.get("observation"), message.get("tool_call_id"), diagnostic)
                if read is not None:
                    read_records.append(read)
                continue
            relevant = (type(effect) is str and effect in _EFFECTS or status == "cancelled"
                        or effect is None and status == "unknown"
                        or _text(message.get("tool_call_id")) and message["tool_call_id"] in records)
            if relevant:
                # Only the authenticated metadata is used. Neither content nor
                # the public tool name supplies canonical execution identity.
                add(outcome, message.get("tool_call_id"))

    facts, grouped = _base(), {}
    read_coverage, read_groups = _read_coverage(read_records)
    facts["readCoverage"] = read_coverage
    risky = {key: [] for key in _RISK_ORDER}
    all_records = list(records.values()) + anonymous
    facts["totalCalls"] = len(all_records)
    for record in all_records:
        status, fields = record["status"], record["fields"]
        facts["counts"][status] += 1
        confirmed = status == "succeeded" and record["confirmed"]
        if confirmed:
            facts["counts"]["confirmed_applied"] += 1
        tool = "unknown_tool" if "canonicalName" in record["conflicts"] else fields.get("canonicalName", "unknown_tool")
        resource = "unknown_resource" if "resourceKey" in record["conflicts"] else fields.get("resourceKey", "unknown_resource")
        key = (tool, resource)
        group = grouped.setdefault(key, {"tool": tool, "resource": resource, "totalCalls": 0, "counts": _counts()})
        group["totalCalls"] += 1
        group["counts"][status] += 1
        if confirmed:
            group["counts"]["confirmed_applied"] += 1
        if status in risky:
            risky[status].append(record["identity"])

    remaining = _MAX_RISK_IDS
    for status in _RISK_ORDER:
        ids = []
        for identity in risky[status]:
            if remaining and _bounded_text(identity, _MAX_CALL_ID_BYTES) is not None:
                ids.append(identity)
                remaining -= 1
            else:
                diagnostic("risk_call_ids_omitted")
        if ids:
            facts["riskDetails"].append({"status": status, "callIds": ids})

    candidates = []
    for group in grouped.values():
        if (_bounded_text(group["tool"], _MAX_LABEL_BYTES) is None
                or _bounded_text(group["resource"], _MAX_LABEL_BYTES) is None):
            facts["omittedGroups"] += 1
            diagnostic("group_labels_omitted")
        else:
            candidates.append(group)
    # Keep risky groups first, then stable history order. No recency window
    # discards old successes: global counts always cover the whole input.
    candidates.sort(key=lambda group: tuple(-group["counts"][key] for key in _RISK_ORDER))
    facts["diagnostics"] = [{"code": code, "count": count} for code, count in sorted(diagnostics.items())]
    facts["projectionComplete"] = not any(code.startswith("invalid_") or code.startswith("read_invalid_") or code in {
        "missing_action_id", "read_missing_action_id", "read_invalid_identity",
        "conflicting_duplicate_outcomes", "receipt_binding_mismatch"} for code in diagnostics)
    facts["readCoverage"]["projectionComplete"] = not any(code.startswith("read_") for code in diagnostics)
    # Reserve enough digits for the final omission count before packing. Group
    # sizes add exactly under the normal JSON list separators.
    facts["omittedGroups"] += len(candidates)
    used = _size(facts)
    for group in candidates:
        added = _size(group) + (2 if facts["groups"] else 0)
        if used + added <= _MAX_BYTES:
            facts["groups"].append(group)
            facts["omittedGroups"] -= 1
            used += added
    # Read coverage is metadata-only and is packed independently from the
    # mutation groups.  It lets the actor remember page/query identity after
    # compaction without treating a historical read as current state or task
    # completion.  Omit whole groups when the fixed projection budget is full.
    for group in read_groups:
        added = _size(group) + (2 if facts["readCoverage"]["groups"] else 0)
        if used + added <= _MAX_BYTES:
            facts["readCoverage"]["groups"].append(group)
            facts["readCoverage"]["omittedGroups"] -= 1
            used += added
    return facts


def build_execution_facts(messages, write_state=None):
    """Return <=8192 UTF-8 bytes of history, without mutating either input.

    ``confirmed_applied`` is a subset of ``succeeded`` rather than another
    exclusive status. Other counts partition totalCalls. Missing descriptive
    metadata never authorizes inference from provider-native business text.
    """
    try:
        return _project(messages, write_state)
    except Exception:
        # Projection is advisory and must not become another execution gate.
        facts = _base()
        facts["projectionComplete"] = False
        facts["diagnostics"] = [{"code": "projection_error", "count": 1}]
        return facts
