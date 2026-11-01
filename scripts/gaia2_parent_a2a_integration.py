"""Answer-blind parent-side A2A result integration.

The child publishing a result and a real parent model request containing that
result are separate facts.  This module keeps that boundary explicit and is
independent of ARE, providers, and the Hook host.
"""

from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping


class A2AIntegrationError(RuntimeError):
    """Stable parent-integration error code; child exception text is excluded."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _clone(value: Any) -> Any:
    try:
        return copy.deepcopy(value)
    except BaseException:
        raise A2AIntegrationError("unsafe_child_result") from None


def _hash(value: Any) -> str:
    try:
        raw = json.dumps(value, sort_keys=True, ensure_ascii=False,
                         separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeError):
        raise A2AIntegrationError("unsafe_child_result") from None
    return hashlib.sha256(raw).hexdigest()


def _text(value: Any, maximum: int = 512) -> bool:
    return type(value) is str and 0 < len(value) <= maximum


def _digest(value: Any) -> str:
    if type(value) is not str or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
        raise A2AIntegrationError("child_result_hash_invalid")
    return value


@dataclass(frozen=True)
class ChildResult:
    """Bounded completion receipt; never native evidence by itself."""

    resultId: str
    callId: str
    parentActionId: str
    childExecutionId: str
    childSessionId: str
    status: str
    effect: str
    resultHash: str
    result: Any
    executed: bool | None
    complete: bool
    completionEvidenceRef: Mapping[str, Any] | None = None
    obligationId: str | None = None
    canonicalName: str | None = None
    resourceKey: str | None = None

    @classmethod
    def from_payload(cls, value: Any) -> "ChildResult":
        if not isinstance(value, dict):
            raise A2AIntegrationError("child_result_schema")
        required = {"resultId", "callId", "parentActionId", "childExecutionId",
                    "childSessionId", "status", "effect", "resultHash", "result",
                    "executed", "complete"}
        if set(value) - (required | {"completionEvidenceRef", "obligationId", "canonicalName", "resourceKey"}) or not required.issubset(value):
            raise A2AIntegrationError("child_result_schema")
        for key in ("resultId", "callId", "parentActionId", "childExecutionId", "childSessionId"):
            if not _text(value[key]):
                raise A2AIntegrationError("child_result_identity")
        if value["status"] not in {"succeeded", "failed", "unknown", "not_executed"}:
            raise A2AIntegrationError("child_result_status")
        if value["effect"] not in {"read", "write", "finish", "wait", "unknown"}:
            raise A2AIntegrationError("child_result_effect")
        _digest(value["resultHash"])
        if value["executed"] not in (True, False, None) or type(value["complete"]) is not bool:
            raise A2AIntegrationError("child_result_outcome")
        evidence = value.get("completionEvidenceRef")
        if evidence is not None:
            if not isinstance(evidence, dict) or not _text(evidence.get("path"), 2048):
                raise A2AIntegrationError("child_result_evidence")
            _digest(evidence.get("sha256"))
            evidence = _clone(evidence)
        obligation = value.get("obligationId")
        if obligation is not None and not _text(obligation, 200):
            raise A2AIntegrationError("child_result_obligation")
        canonical_name, resource_key = value.get("canonicalName"), value.get("resourceKey")
        if canonical_name is not None and not _text(canonical_name, 200):
            raise A2AIntegrationError("child_result_canonical")
        if resource_key is not None and not _text(resource_key, 200):
            raise A2AIntegrationError("child_result_resource")
        result = _clone(value["result"])
        if _hash(result) != value["resultHash"]:
            raise A2AIntegrationError("child_result_hash_mismatch")
        if len(json.dumps(result, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")) > 32768:
            raise A2AIntegrationError("child_result_size")
        return cls(resultId=value["resultId"], callId=value["callId"],
                   parentActionId=value["parentActionId"], childExecutionId=value["childExecutionId"],
                   childSessionId=value["childSessionId"], status=value["status"], effect=value["effect"],
                   resultHash=value["resultHash"], result=result, executed=value["executed"],
                   complete=value["complete"], completionEvidenceRef=evidence, obligationId=obligation,
                   canonicalName=canonical_name, resourceKey=resource_key)

    def public_projection(self) -> dict[str, Any]:
        return {"resultId": self.resultId, "callId": self.callId, "status": self.status,
                "effect": self.effect, "resultHash": self.resultHash, "result": _clone(self.result),
                "obligationId": self.obligationId, "canonicalName": self.canonicalName,
                "resourceKey": self.resourceKey}

    def fingerprint(self) -> str:
        return _hash({"resultId": self.resultId, "callId": self.callId,
                      "parentActionId": self.parentActionId, "childExecutionId": self.childExecutionId,
                      "childSessionId": self.childSessionId, "status": self.status, "effect": self.effect,
                      "resultHash": self.resultHash, "executed": self.executed, "complete": self.complete,
                      "completionEvidenceRef": self.completionEvidenceRef, "obligationId": self.obligationId,
                      "canonicalName": self.canonicalName, "resourceKey": self.resourceKey})


class ParentObligationLedger:
    """Conservative parent obligation projection for delegated calls."""

    def __init__(self, *, max_obligations: int = 64):
        if type(max_obligations) is not int or not 1 <= max_obligations <= 256:
            raise A2AIntegrationError("obligation_budget_invalid")
        self._max = max_obligations
        self._rows: dict[str, dict[str, Any]] = {}
        self._result_ids: set[str] = set()

    def register(self, obligation: Mapping[str, Any]) -> dict[str, Any]:
        if not isinstance(obligation, Mapping) or not _text(obligation.get("id"), 200) or obligation["id"] in self._rows:
            raise A2AIntegrationError("obligation_schema")
        if len(self._rows) >= self._max or not _text(obligation.get("canonicalName"), 200):
            raise A2AIntegrationError("obligation_budget")
        effect = obligation.get("effect", "unknown")
        if effect not in {"read", "write", "finish", "wait", "unknown"}:
            raise A2AIntegrationError("obligation_schema")
        minimum, maximum = obligation.get("minCalls", 0), obligation.get("maxCalls", 64)
        if type(minimum) is not int or type(maximum) is not int or not 0 <= minimum <= maximum <= 64:
            raise A2AIntegrationError("obligation_schema")
        self._rows[obligation["id"]] = {"id": obligation["id"], "canonicalName": obligation["canonicalName"],
            "resourceKey": obligation.get("resourceKey"), "effect": effect, "minCalls": minimum, "maxCalls": maximum,
            "actualCalls": 0, "attemptedCalls": 0, "failedCalls": 0, "unknownCalls": 0, "notExecutedCalls": 0,
            "status": "missing", "integratedResultIds": []}
        return self.snapshot()

    def _row_for(self, result: ChildResult) -> dict[str, Any] | None:
        if result.obligationId is not None:
            return self._rows.get(result.obligationId)
        if result.canonicalName is None:
            return None
        matches = [row for row in self._rows.values()
                   if row["canonicalName"] == result.canonicalName
                   and (row["resourceKey"] is None or row["resourceKey"] == result.resourceKey)
                   and row["effect"] in ("unknown", result.effect)]
        return matches[0] if len(matches) == 1 else None

    def apply(self, result: ChildResult) -> dict[str, Any] | None:
        if result.resultId in self._result_ids:
            return self.snapshot()
        self._result_ids.add(result.resultId)
        row = self._row_for(result)
        if row is None:
            return None
        row["attemptedCalls"] += 1
        # A result status is not sufficient.  Successful accounting requires
        # explicit execution, completion, and trusted child evidence.
        if result.status == "succeeded" and result.executed is True and result.complete is True and result.completionEvidenceRef is not None:
            row["actualCalls"] += 1
        elif result.status == "unknown" or result.status == "succeeded" or (result.effect in {"write", "finish"} and result.executed is not False):
            row["unknownCalls"] += 1
        elif result.status in {"failed", "not_executed"}:
            row["failedCalls" if result.status == "failed" else "notExecutedCalls"] += 1
        row["integratedResultIds"].append(result.resultId)
        row["status"] = ("overrun" if row["actualCalls"] > row["maxCalls"] else
                          "satisfied" if row["actualCalls"] >= row["minCalls"] else "missing")
        return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        return {"schemaVersion": "gaia2-parent-obligation-ledger-v1", "obligations": _clone(list(self._rows.values()))}


class ParentA2AInbox:
    """Exactly-once parent inbox with explicit model-request integration."""

    def __init__(self, *, ledger: ParentObligationLedger | None = None, max_results: int = 64):
        if type(max_results) is not int or not 1 <= max_results <= 256:
            raise A2AIntegrationError("inbox_budget_invalid")
        if ledger is not None and type(ledger) is not ParentObligationLedger:
            raise A2AIntegrationError("inbox_ledger_invalid")
        self.ledger = ledger or ParentObligationLedger()
        self._max = max_results
        self._entries: dict[str, dict[str, Any]] = {}

    def publish(self, value: ChildResult | Mapping[str, Any]) -> dict[str, Any]:
        result = value if isinstance(value, ChildResult) else ChildResult.from_payload(value)
        prior = self._entries.get(result.resultId)
        fingerprint = result.fingerprint()
        if prior is not None:
            if prior["fingerprint"] != fingerprint:
                raise A2AIntegrationError("child_result_conflict")
            return self.snapshot()
        if len(self._entries) >= self._max:
            raise A2AIntegrationError("inbox_budget")
        self._entries[result.resultId] = {"result": result, "fingerprint": fingerprint,
                                           "status": "published", "modelRequestId": None}
        return self.snapshot()

    def pending(self) -> tuple[ChildResult, ...]:
        return tuple(entry["result"] for entry in self._entries.values() if entry["status"] == "published")

    def integrate(self, *, model_request_id: str, result_ids: list[str] | tuple[str, ...] | None = None) -> dict[str, Any]:
        if not _text(model_request_id, 200):
            raise A2AIntegrationError("model_request_identity")
        selected = list(result_ids) if result_ids is not None else [item.resultId for item in self.pending()]
        if len(selected) > self._max or len(set(selected)) != len(selected):
            raise A2AIntegrationError("inbox_selection")
        integrated = []
        for result_id in selected:
            entry = self._entries.get(result_id)
            if entry is None:
                raise A2AIntegrationError("inbox_result_unknown")
            if entry["status"] == "integrated":
                if entry["modelRequestId"] != model_request_id:
                    raise A2AIntegrationError("inbox_replay")
                continue
            entry["status"], entry["modelRequestId"] = "integrated", model_request_id
            self.ledger.apply(entry["result"])
            integrated.append(result_id)
        return {"modelRequestId": model_request_id, "integratedResultIds": integrated,
                "pendingResultIds": [item.resultId for item in self.pending()], "ledger": self.ledger.snapshot()}

    def projection(self) -> list[dict[str, Any]]:
        return [entry["result"].public_projection() for entry in self._entries.values() if entry["status"] == "published"]

    def terminal_drain(self, *, request_model: Callable[[list[dict[str, Any]]], str | None] | None = None,
                       stopped: bool = False, limit: int = 1) -> dict[str, Any]:
        """Use at most ``limit`` parent opportunities and return evidence."""
        if type(limit) is not int or limit < 0 or limit > 4:
            raise A2AIntegrationError("drain_limit_invalid")
        pending_before = [item.resultId for item in self.pending()]
        attempts = 0
        integrated: list[str] = []
        reason = "already_converged"
        if pending_before:
            if stopped:
                reason = "stop_observed"
            elif limit == 0 or request_model is None:
                reason = "drain_not_attempted"
            else:
                attempts = 1
                try:
                    model_request_id = request_model(_clone(self.projection()))
                except BaseException:
                    model_request_id = None
                if _text(model_request_id, 200):
                    integrated = self.integrate(model_request_id=model_request_id,
                                                result_ids=pending_before)["integratedResultIds"]
                    reason = "integrated" if not self.pending() else "incomplete_ack"
                else:
                    reason = "model_request_not_acknowledged"
        pending_after = [item.resultId for item in self.pending()]
        return {"schemaVersion": "gaia2-a2a-terminal-drain-v1", "success": not pending_after,
                "status": "succeeded" if not pending_after else "failed", "attempts": attempts,
                "maxAttempts": limit, "publishedBefore": pending_before,
                "integratedResultIds": integrated, "pendingResultIds": pending_after,
                "reason": reason, "ledger": self.ledger.snapshot()}

    def snapshot(self) -> dict[str, Any]:
        return {"schemaVersion": "gaia2-parent-a2a-inbox-v1", "entries": [
            {"resultId": item["result"].resultId, "callId": item["result"].callId,
             "resultHash": item["result"].resultHash, "status": item["status"],
             "modelRequestId": item["modelRequestId"]}
            for item in self._entries.values()], "ledger": self.ledger.snapshot()}


__all__ = ["A2AIntegrationError", "ChildResult", "ParentObligationLedger", "ParentA2AInbox"]
