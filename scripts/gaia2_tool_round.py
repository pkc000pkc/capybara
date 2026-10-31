"""Native-execution adapter for the backend-owned ordered tool scheduler.

All planning/claim/settlement authority remains in the shared Node scheduler.
This adapter performs no tool invocation, inference, clock change or retries.
"""
import json
import re

from gaia2_runtime_hooks import HookProtocolError

EXCLUSIVE_CONTROLS = {"capybara_wait_watch", "capybara_retrieval_step", "execute_workflow"}

# Keep the Actor-side preflight bound aligned with the backend scheduler's
# authenticated plan bound.  Oversized rounds are rejected before any native
# dispatch; this value is intentionally duplicated at the process boundary.
MAX_TOOL_ROUND_NODES = 64
_SUMMARY_MAX_BYTES = 8192
_REFERENCE_FIELDS = frozenset(("id", "event_id", "contact_id", "email_id", "message_id", "thread_id",
    "file_id", "folder_id", "reservation_id", "booking_id", "order_id", "item_id", "entity_id",
    "record_id", "document_id", "task_id"))
_OUTCOME_STATUSES = frozenset(("succeeded", "failed", "failed_before_execution", "unknown", "blocked", "cancelled"))


def _encoded_size(value):
    # Bound both conventional and compact JSON views. Whitespace added by a
    # pretty-printer is not part of this machine-readable summary contract.
    return len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))


def _bounded_text(value, maximum):
    """Never produce a shortened identifier that looks like an actual ID."""
    if type(value) is not str or not value or any(ord(char) < 32 for char in value):
        return None
    try:
        return value if len(value.encode("utf-8")) <= maximum else None
    except UnicodeError:
        return None


def _argument_refs(arguments):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate argument")
            result[key] = value
        return result
    try:
        if type(arguments) is not str or len(arguments.encode("utf-8")) > 262144:
            return {}
        parsed = json.loads(arguments, object_pairs_hook=unique,
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError("nonfinite argument")))
        if type(parsed) is not dict:
            return {}
        refs = {}
        for key in sorted(_REFERENCE_FIELDS & parsed.keys()):
            value = parsed[key]
            if _bounded_text(value, 128) is not None:
                refs[key] = value
            elif type(value) is int and len(str(value)) <= 20:
                refs[key] = value
        return refs
    except (ValueError, TypeError, UnicodeError, RecursionError):
        return {}


class ToolRoundAdapter:
    def __init__(self, client, round_id, calls, exclusive_names, emit, *, defer_begin=False):
        self.client, self.round_id, self.emit = client, round_id, emit
        self.calls = [{"id": identity, "name": name, "arguments": arguments} for identity, name, arguments in calls]
        self.exclusive_names = sorted(set(exclusive_names) | EXCLUSIVE_CONTROLS)
        self.state, self.inflight, self.rpc_failed = None, None, False
        if not defer_begin:
            self.begin()

    def begin(self):
        self.state = self._rpc("begin", calls=self.calls, exclusiveToolNames=self.exclusive_names)["state"]
        if (len(self.state["nodes"]) != len(self.calls) or any(
                any(node.get(key) != original[key] for key in ("id", "name", "arguments"))
                or node.get("ordinal") != ordinal or re.fullmatch(r"[a-f0-9]{64}", node.get("nodeHash", "")) is None
                for ordinal, (node, original) in enumerate(zip(self.state["nodes"], self.calls)))):
            raise HookProtocolError("tool_round_plan_binding")

    def _rpc(self, op, **payload):
        if self.rpc_failed:
            raise HookProtocolError("tool_round_rpc_already_failed")
        try:
            value = self.client.tool_round(op, self.round_id, **payload)
        except Exception:
            self.rpc_failed = True
            raise
        self.state = value["state"]
        self.emit("tool_round_" + op, roundId=self.round_id, status=self.state["status"],
                  cursor=self.state["cursor"], inFlightId=self.state["inFlightId"],
                  sourceRef=value["sourceRef"], reason=self.state["reason"])
        return value

    def cancel(self, reason):
        if self.state is not None and self.state["status"] not in ("completed", "cancelled", "rejected"):
            self._rpc("cancel", reason=reason)

    def claim(self, ordinal):
        current = self.state["nodes"][ordinal]
        if current["status"] == "cancelled":
            return False
        value = self._rpc("next")
        node = value["node"]
        if not node or node["ordinal"] != ordinal or any(node.get(key) != current[key] for key in ("id", "name", "arguments", "nodeHash")):
            raise HookProtocolError("tool_round_claim_binding")
        self.inflight = node
        return True

    def settle(self, status, reason=None):
        if self.inflight is None:
            return
        normalized = status if status in ("succeeded", "blocked", "unknown") else "failed"
        settlement = {"id": self.inflight["id"], "nodeHash": self.inflight["nodeHash"], "status": normalized}
        if reason:
            settlement["reason"] = reason
        self._rpc("settle", settlement=settlement)
        self.inflight = None

    def cancelled_result(self, ordinal):
        nodes = (self.state or {}).get("nodes", [])
        node = nodes[ordinal] if isinstance(nodes, list) and ordinal < len(nodes) and isinstance(nodes[ordinal], dict) else {}
        return {"status": "cancelled", "reason": node.get("reason") or (self.state or {}).get("reason") or "tool_round_cancelled",
                "executed": False, "roundId": self.round_id, "originalWriteExecuted": False,
                "feedback": "This queued call was not executed. Inspect prior actual results and current instructions before replanning; do not replay unknown writes."}

    def result_summary(self, messages):
        """Summarize real local outcomes, never business data or scheduler claims.

        ``executionOutcome`` is adapter-owned message metadata supplied by the
        Bridge after actual dispatch. It is not part of the provider's native
        tool body. Missing/duplicate metadata remains unsettled even when the
        scheduler says that a node succeeded. This advisory view has no hooks,
        native execution, retry, clock, or business-completion authority.
        """
        results = {}
        for message in messages if type(messages) is list else []:
            if type(message) is dict and message.get("role") == "tool" and type(message.get("tool_call_id")) is str:
                results.setdefault(message["tool_call_id"], []).append(message)
        counts = dict.fromkeys(("succeeded", "failed", "unknown", "not_executed", "unsettled"), 0)
        nodes = []
        for ordinal, call in enumerate(self.calls):
            identity, name = call.get("id"), call.get("name")
            node = {"ordinal": ordinal, "callId": _bounded_text(identity, 256),
                    "tool": _bounded_text(name, 256), "status": "unsettled", "invoked": None, "effectApplied": None}
            if node["callId"] is None:
                node["callIdOmitted"] = True
            if node["tool"] is None:
                node["toolOmitted"] = True
            matches = results.get(identity, [])
            message = matches[0] if len(matches) == 1 else None
            outcome = message.get("executionOutcome") if message is not None else None
            status = outcome.get("status") if type(outcome) is dict else None
            executed = outcome.get("executed") if type(outcome) is dict else None
            valid = (message is not None and message.get("name") == name and type(outcome) is dict
                and type(status) is str and status in _OUTCOME_STATUSES and (executed is None or type(executed) is bool)
                and ("complete" not in outcome or type(outcome["complete"]) is bool)
                and ("effectApplied" not in outcome or outcome["effectApplied"] is None or type(outcome["effectApplied"]) is bool))
            if valid and (status == "failed_before_execution" and outcome.get("effectApplied") is True
                          or status in ("cancelled", "blocked") and (executed is True or outcome.get("effectApplied") is True)
                          or status == "succeeded" and executed is not True):
                valid = False
            if valid:
                node["nativeStatus"] = status
                node["invoked"] = executed
                if status == "succeeded" and executed is True:
                    node["status"] = "succeeded"
                    node["effectApplied"] = outcome.get("effectApplied")
                elif status in ("failed", "failed_before_execution"):
                    node["status"] = "failed"
                    node["effectApplied"] = False if status == "failed_before_execution" else outcome.get("effectApplied")
                elif status == "unknown":
                    node["status"] = "unknown"
                    node["invoked"] = True if executed is True else None
                elif status in ("cancelled", "blocked") and executed is False:
                    node.update(status="not_executed", invoked=False, effectApplied=False)
                for source, target in (("errorCode", "errorCode"), ("argumentName", "argumentName")):
                    code = outcome.get(source)
                    if type(code) is str and re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,79}", code):
                        node[target] = code
            elif len(matches) > 1:
                node["diagnostic"] = "duplicate_tool_results"
            else:
                node["diagnostic"] = "missing_or_invalid_execution_metadata"
            refs = _argument_refs(call.get("arguments"))
            if refs:
                node["argumentRefs"] = refs
            counts[node["status"]] += 1
            nodes.append(node)
        summary = {"schemaVersion": "gaia2-tool-round-summary-v1", "roundId": _bounded_text(self.round_id, 256),
            "totalCalls": len(self.calls), "counts": counts, "nodes": nodes, "truncated": False, "omittedNodes": 0,
            "businessCompletion": "not_inferred", "automaticReplay": False,
            "feedback": "Historical batch outcomes only; later actions may change the current state. This is not business-completion approval. Failed and unexecuted calls differ. Inspect original results before replanning; never blindly replay an unknown outcome."}
        # Retain every count, but prefer actionable failure/unknown/tail rows
        # over successful rows when a large batch cannot fit the view budget.
        while _encoded_size(summary) > _SUMMARY_MAX_BYTES and summary["nodes"]:
            removable = next((index for index in range(len(summary["nodes"]) - 1, -1, -1)
                              if summary["nodes"][index]["status"] == "succeeded"), len(summary["nodes"]) - 1)
            del summary["nodes"][removable]
            summary["truncated"] = True
            summary["omittedNodes"] += 1
        return summary
