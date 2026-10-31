"""Trusted business-window state for GAIA2 waiting obligations.

This module is intentionally smaller than the historical task-contract
resolver.  It does not extract user intent, call an LLM, perform a native
read, or decide whether a candidate is semantically relevant.  A trusted
caller supplies an exact source span, an ARE-clock deadline and complete
evidence.  The module only records the lifecycle and prevents a timeout or a
scan budget from being mistaken for business completion.

The three budgets are deliberately independent:

* ``sdk``: model request/retry budget;
* ``wait``: controller wait/scan budget;
* ``outer``: scenario/process supervision budget.

All timestamps are ARE scene seconds.  Wall-clock/OS deadlines must not be
passed as ``now`` or ``deadline``.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
from copy import deepcopy
from typing import Any


SCHEMA = "gaia2-window-obligation-v1"
STATUSES = {
    "pending",
    "candidate_pending_review",
    "window_completed",
    "window_expired_unreviewed",
    "technical_termination",
    "user_interrupted",
    "cancelled",
}
MODES = {"monitor_until", "condition_once"}
TECHNICAL_SIGNALS = {
    "scan_budget",
    "native_error",
    "incomplete_observation",
    "clock_error",
    "environment_stop",
    "sdk_budget",
    "outer_budget",
}


class WindowObligationError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _text(value: Any, maximum: int = 2048) -> bool:
    return isinstance(value, str) and 0 < len(value) <= maximum


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def _clone(value: Any) -> Any:
    return deepcopy(value)


class WindowObligationLedger:
    """A bounded, deterministic lifecycle ledger for one execution/session."""

    def __init__(self, execution_id: str, session_id: str, *, max_obligations: int = 64,
                 max_evidence: int = 128):
        if not _text(execution_id, 512) or not _text(session_id, 512):
            raise WindowObligationError("identity", "execution and session identities are required")
        if type(max_obligations) is not int or not 1 <= max_obligations <= 256:
            raise WindowObligationError("budget", "max_obligations is outside its bounds")
        if type(max_evidence) is not int or not 1 <= max_evidence <= 1024:
            raise WindowObligationError("budget", "max_evidence is outside its bounds")
        self.execution_id = execution_id
        self.session_id = session_id
        self.max_obligations = max_obligations
        self.max_evidence = max_evidence
        self._now: float | None = None
        self._revision = 0
        self._obligations: dict[str, dict[str, Any]] = {}
        self._budgets = {
            "sdk": {"limit": None, "consumed": 0},
            "wait": {"limit": None, "consumed": 0},
            "outer": {"limit": None, "consumed": 0},
        }

    @property
    def revision(self) -> int:
        return self._revision

    def _clock(self, now: float) -> float:
        if not _finite(now) or (self._now is not None and now < self._now):
            raise WindowObligationError("clock_error", "ARE scene time must be finite and nondecreasing")
        self._now = float(now)
        return self._now

    def _touch(self) -> None:
        self._revision += 1

    def snapshot(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA,
            "executionId": self.execution_id,
            "sessionId": self.session_id,
            "revision": self._revision,
            "areNow": self._now,
            "budgets": _clone(self._budgets),
            "obligations": _clone(list(self._obligations.values())),
        }

    def set_budget(self, kind: str, limit: int | float | None) -> dict[str, Any]:
        if kind not in self._budgets:
            raise WindowObligationError("budget_kind", "unknown budget kind")
        if limit is not None and (not _finite(limit) or limit <= 0):
            raise WindowObligationError("budget", "budget limit must be positive or null")
        prior = self._budgets[kind]
        if prior["consumed"] > 0 and limit != prior["limit"]:
            raise WindowObligationError("budget_rebind", "a consumed budget cannot be rebound")
        self._budgets[kind] = {"limit": limit, "consumed": 0}
        self._touch()
        return self.snapshot()

    def consume_budget(self, kind: str, amount: int | float = 1) -> dict[str, Any]:
        if kind not in self._budgets or type(amount) not in (int, float) or isinstance(amount, bool) or amount < 0 or not math.isfinite(amount):
            raise WindowObligationError("budget", "invalid budget consumption")
        budget = self._budgets[kind]
        consumed = budget["consumed"] + amount
        budget["consumed"] = consumed
        self._touch()
        limit = budget["limit"]
        if limit is not None and consumed > limit:
            self._terminate_all("%s_budget" % kind)
            raise WindowObligationError("%s_budget" % kind, "%s budget exhausted" % kind)
        return self.snapshot()

    def _terminate_all(self, signal: str) -> None:
        for item in self._obligations.values():
            if item["status"] in {"pending", "candidate_pending_review", "window_expired_unreviewed"}:
                item["status"] = "technical_termination"
                item["terminationSignal"] = signal

    def register(self, *, user_ref: str, source_text: str, span: dict[str, Any], mode: str,
                 goal: str, scene_start: float, deadline: float,
                 notification_policy: str = "allow") -> dict[str, Any]:
        """Register an obligation from a trusted exact source span.

        The caller must have already performed semantic extraction and review;
        this method only verifies the immutable source anchor and time bounds.
        """
        if len(self._obligations) >= self.max_obligations:
            raise WindowObligationError("obligation_budget", "obligation budget exhausted")
        if not _text(user_ref, 512) or not isinstance(source_text, str) or not source_text:
            raise WindowObligationError("source", "bounded visible user source is required")
        if (not isinstance(span, dict) or set(span) != {"start", "end", "text"}
                or type(span.get("start")) is not int or type(span.get("end")) is not int
                or not 0 <= span["start"] < span["end"] <= len(source_text)
                or span["text"] != source_text[span["start"]:span["end"]]):
            raise WindowObligationError("source_span", "exact source span is required")
        if mode not in MODES or not _text(goal) or notification_policy not in {"allow", "forbid_until_deadline", "forbid"}:
            raise WindowObligationError("obligation", "invalid obligation fields")
        if not _finite(scene_start) or not _finite(deadline) or deadline < scene_start:
            raise WindowObligationError("deadline", "ARE deadline must not precede scene start")
        source_hash = hashlib.sha256(source_text.encode("utf-8")).hexdigest()
        obligation_id = "window-" + _hash([self.execution_id, self.session_id, user_ref, source_hash, len(self._obligations)])[:24]
        item = {
            "schemaVersion": SCHEMA,
            "id": obligation_id,
            "executionId": self.execution_id,
            "sessionId": self.session_id,
            "userRef": user_ref,
            "sourceHash": source_hash,
            "span": _clone(span),
            "mode": mode,
            "goal": goal,
            "notificationPolicy": notification_policy,
            "sceneStart": float(scene_start),
            "deadline": float(deadline),
            "status": "pending",
            "candidateEvidence": None,
            "lastReviewedActionId": None,
            "completionReason": None,
            "terminationSignal": None,
            "waitCount": 0,
            "scanCount": 0,
            "lastSignal": None,
            "sourceSpanHash": _hash(span),
        }
        self._obligations[obligation_id] = item
        self._touch()
        return self.snapshot()

    def _item(self, obligation_id: str) -> dict[str, Any]:
        item = self._obligations.get(obligation_id)
        if item is None:
            raise WindowObligationError("obligation_identity", "unknown window obligation")
        return item

    def advance(self, now: float) -> dict[str, Any]:
        now = self._clock(now)
        for item in self._obligations.values():
            if item["status"] == "pending" and now >= item["deadline"]:
                item["status"] = "window_expired_unreviewed"
                item["lastSignal"] = "deadline"
        self._touch()
        return self.snapshot()

    def note_wait(self, obligation_id: str, *, waits: int = 0, scans: int = 0,
                  signal: str = "unchanged", now: float | None = None) -> dict[str, Any]:
        item = self._item(obligation_id)
        if now is not None:
            self._clock(now)
        if type(waits) is not int or type(scans) is not int or waits < 0 or scans < 0:
            raise WindowObligationError("wait_counts", "wait and scan counts must be bounded integers")
        if waits + scans > self.max_evidence:
            self._terminate_all("wait_budget")
            raise WindowObligationError("wait_budget", "wait evidence budget exhausted")
        item["waitCount"] += waits
        item["scanCount"] += scans
        item["lastSignal"] = signal
        if signal in TECHNICAL_SIGNALS:
            item["status"] = "technical_termination"
            item["terminationSignal"] = signal
        elif item["status"] == "pending" and self._now is not None and self._now >= item["deadline"]:
            item["status"] = "window_expired_unreviewed"
        self._touch()
        return self.snapshot()

    def candidate(self, obligation_id: str, evidence: dict[str, Any], *, now: float) -> dict[str, Any]:
        item = self._item(obligation_id)
        now = self._clock(now)
        if item["status"] not in {"pending", "window_expired_unreviewed", "candidate_pending_review"}:
            raise WindowObligationError("candidate_status", "inactive obligation cannot accept candidate evidence")
        if (not isinstance(evidence, dict) or not _text(evidence.get("actionId"), 512)
                or evidence.get("complete") is not True or evidence.get("viewComplete") is not True
                or not _finite(evidence.get("observedAt")) or evidence["observedAt"] > now):
            raise WindowObligationError("candidate_evidence", "complete current native evidence is required")
        if len(self.snapshot()["obligations"]) > self.max_obligations:
            raise WindowObligationError("obligation_budget", "obligation evidence budget exhausted")
        item["candidateEvidence"] = {key: _clone(evidence[key]) for key in ("actionId", "observedAt", "complete", "viewComplete")}
        item["status"] = "candidate_pending_review"
        item["lastSignal"] = "candidate_changed"
        self._touch()
        return self.snapshot()

    def review(self, obligation_id: str, *, action_id: str, decision: str,
               reason: str, now: float, observed_at: float | None = None) -> dict[str, Any]:
        item = self._item(obligation_id)
        now = self._clock(now)
        if decision not in {"continue", "condition_satisfied", "deadline_reviewed"} or not _text(action_id) or not _text(reason):
            raise WindowObligationError("review", "bounded Actor review is required")
        evidence = item.get("candidateEvidence")
        if item["status"] not in {"pending", "candidate_pending_review", "window_expired_unreviewed"} or not evidence or evidence["actionId"] != action_id:
            raise WindowObligationError("review_binding", "review must bind the current candidate evidence")
        observed = evidence["observedAt"] if observed_at is None else observed_at
        if not _finite(observed) or observed > now:
            raise WindowObligationError("review_time", "review evidence timestamp is invalid")
        if decision == "condition_satisfied":
            if item["mode"] != "condition_once":
                raise WindowObligationError("monitor_early_completion", "monitor-until cannot complete on a candidate")
            item["status"] = "window_completed"
            item["completionReason"] = "condition_satisfied"
        elif decision == "deadline_reviewed":
            if now < item["deadline"] or observed < item["deadline"]:
                raise WindowObligationError("deadline_evidence", "final review requires ARE time and evidence at deadline")
            item["status"] = "window_completed"
            item["completionReason"] = "deadline_reviewed"
        else:
            item["status"] = "window_expired_unreviewed" if now >= item["deadline"] else "pending"
            item["completionReason"] = None
        item["lastReviewedActionId"] = action_id
        item["candidateEvidence"] = None
        item["lastSignal"] = decision
        self._touch()
        return self.snapshot()

    def interrupt(self, obligation_id: str, reason: str) -> dict[str, Any]:
        if reason not in {"user_update", "environment_stop", "cancelled"}:
            raise WindowObligationError("interrupt", "invalid interruption reason")
        item = self._item(obligation_id)
        if item["status"] in {"pending", "candidate_pending_review", "window_expired_unreviewed"}:
            item["status"] = "user_interrupted" if reason == "user_update" else "cancelled"
            item["terminationSignal"] = reason
            item["lastSignal"] = reason
            self._touch()
        return self.snapshot()

    def authorize_reply(self, obligation_id: str, *, now: float,
                        final: bool = True, claims_completion: bool = True) -> dict[str, Any]:
        """Return a deterministic final-AUI decision; never call the model."""
        item = self._item(obligation_id)
        now = self._clock(now)
        if not final or not claims_completion:
            return {"allowed": True, "reason": "progress_reply", "status": item["status"]}
        if item["status"] in {"pending", "candidate_pending_review"}:
            return {"allowed": False, "reason": "window_pending", "status": item["status"],
                    "deadline": item["deadline"], "areNow": now}
        if item["status"] == "window_expired_unreviewed":
            return {"allowed": False, "reason": "window_expired_unreviewed", "status": item["status"],
                    "deadline": item["deadline"], "areNow": now}
        if item["status"] == "window_completed":
            return {"allowed": True, "reason": "window_completed", "status": item["status"]}
        return {"allowed": False, "reason": "obligation_terminated", "status": item["status"]}

    def finish(self, now: float) -> dict[str, Any]:
        now = self._clock(now)
        pending = []
        for item in self._obligations.values():
            if item["status"] == "pending" and now >= item["deadline"]:
                item["status"] = "window_expired_unreviewed"
            if item["status"] != "window_completed":
                pending.append(item["id"])
        self._touch()
        return {"allowed": not pending, "reason": "ready" if not pending else "obligations_pending",
                "pendingObligationIds": pending, "state": self.snapshot()}


__all__ = ["SCHEMA", "STATUSES", "WindowObligationError", "WindowObligationLedger"]
