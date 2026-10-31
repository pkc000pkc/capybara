"""Trusted registration adapter for reviewed, source-bound waiting windows.

The model may propose a contract, but this adapter never parses natural
language, derives a duration, or accepts a model-authored recipe.  It accepts
only the code-anchored normalized proposal and the independent review result
produced by the existing task-contract protocol.  It then materializes the
narrow ``WindowObligationLedger`` used by the runtime finish gate.
"""
from __future__ import annotations

import hashlib
from typing import Any

from gaia2_task_contract import task_contract_hash
from gaia2_task_contract import MAX_SOURCE_BYTES
from gaia2_task_contract_model import _proposal as validate_proposal
from gaia2_task_contract_model import _review as validate_review
from gaia2_window_obligation import WindowObligationError, WindowObligationLedger


SCHEMA = "gaia2-window-registration-v1"
SOURCE_SCHEMA = "gaia2-window-obligation-source-v1"


class WindowRegistrationError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


def _fail(code: str, message: str):
    raise WindowRegistrationError(code, message)


def _source(source: Any) -> dict:
    if not isinstance(source, dict):
        _fail("source_schema", "visible USER source must be an object")
    required = {"schemaVersion", "executionId", "sessionId", "userRef", "text", "sourceHash", "arrivedAt"}
    if set(source) != required or source.get("schemaVersion") != "gaia2-task-contract-source-v1":
        _fail("source_schema", "source identity is incomplete")
    if any(not isinstance(source.get(key), str) or not source[key] or len(source[key]) > 512
           for key in ("executionId", "sessionId", "userRef")):
        _fail("source_identity", "source identity is invalid")
    text = source.get("text")
    if not isinstance(text, str) or not text or len(text.encode("utf-8")) > MAX_SOURCE_BYTES:
        _fail("source_text", "source text is required")
    if hashlib.sha256(text.encode("utf-8")).hexdigest() != source.get("sourceHash"):
        _fail("source_hash", "source hash does not match the original USER text")
    if not isinstance(source.get("arrivedAt"), (int, float)) or isinstance(source.get("arrivedAt"), bool):
        _fail("source_clock", "source arrival must be an ARE scene timestamp")
    return source


def _legacy_review(review: Any) -> dict:
    if not isinstance(review, dict):
        _fail("review_schema", "independent review is required")
    # Review-v2 adds only provenance bindings.  The existing validator owns
    # the semantic review fields; extra fields are checked by the caller.
    fields = {"schemaVersion", "sourceHash", "proposalHash", "decision",
              "notificationVerified", "obligationChecks", "revocationChecks", "reason"}
    if review.get("schemaVersion") == "gaia2-task-contract-review-v2":
        if set(review) != fields | {"rawProposalHash", "anchoringHash"}:
            _fail("review_schema", "review-v2 fields are not exact")
        converted = {key: review[key] for key in fields}
        converted["schemaVersion"] = "gaia2-task-contract-review-v1"
        return converted
    if set(review) != fields:
        _fail("review_schema", "review-v1 fields are not exact")
    return review


def register_reviewed_windows(*, ledger: WindowObligationLedger, source: dict,
                              proposal: dict, review: dict, are_now: float) -> dict:
    """Register only a code-anchored, independently approved proposal.

    ``proposal`` must be the normalized v1 proposal whose spans are exact
    slices of ``source.text``.  ``review`` must be an approved independent
    review.  Relative deadlines are calculated from the original USER
    ``arrivedAt`` timestamp, never from model or registration wall time.
    """
    if not isinstance(ledger, WindowObligationLedger):
        _fail("ledger", "a trusted WindowObligationLedger is required")
    source = _source(source)
    if not isinstance(are_now, (int, float)) or isinstance(are_now, bool) or are_now < source["arrivedAt"]:
        _fail("clock", "registration ARE time must be at or after USER arrival")
    if not isinstance(proposal, dict) or proposal.get("schemaVersion") != "gaia2-task-contract-proposal-v1":
        _fail("proposal_schema", "only normalized v1 proposals may register")
    try:
        validate_proposal(proposal, source, [])
    except Exception as error:
        _fail(getattr(error, "code", "proposal_invalid"), "normalized proposal failed source validation")
    normalized_review = _legacy_review(review)
    try:
        validate_review(normalized_review, source, proposal)
    except Exception as error:
        _fail(getattr(error, "code", "review_invalid"), "independent review failed validation")
    if normalized_review.get("decision") != "approved" or normalized_review.get("notificationVerified") is not True:
        _fail("review_rejected", "only an approved review can register windows")
    if proposal.get("resolution") == "ambiguous":
        _fail("ambiguous", "ambiguous source resolution cannot register windows")
    obligations = proposal.get("obligations") or []
    if proposal.get("notificationPolicy") == "forbid_until_deadline" and not obligations:
        _fail("notification_deadline", "until-deadline policy requires an obligation")

    existing = [item for item in ledger.snapshot().get("obligations", [])
                if item.get("userRef") == source["userRef"] and item.get("sourceHash") == source["sourceHash"]]
    if existing:
        return {"schemaVersion": SCHEMA, "status": "already_registered",
                "sourceHash": source["sourceHash"], "proposalHash": task_contract_hash(proposal),
                "reviewHash": task_contract_hash(review), "registered": 0,
                "state": ledger.snapshot()}

    registered = 0
    for item in obligations:
        basis = item.get("timeBasis")
        if not isinstance(basis, dict):
            _fail("time_basis", "explicit time basis is required")
        if basis.get("kind") == "relative":
            deadline = source["arrivedAt"] + basis["durationSeconds"]
        elif basis.get("kind") == "absolute":
            deadline = basis["deadline"]
        else:
            _fail("time_basis", "relative or absolute ARE time basis is required")
        try:
            ledger.register(user_ref=source["userRef"], source_text=source["text"],
                            span=item["span"], mode=item["mode"], goal=item["goal"],
                            scene_start=source["arrivedAt"], deadline=deadline,
                            notification_policy=proposal["notificationPolicy"])
        except WindowObligationError as error:
            _fail(error.code, str(error))
        registered += 1
    return {"schemaVersion": SCHEMA, "status": "registered" if registered else "reviewed_none",
            "sourceHash": source["sourceHash"], "proposalHash": task_contract_hash(proposal),
            "reviewHash": task_contract_hash(review), "registered": registered,
            "state": ledger.snapshot()}


def build_window_obligation_source(*, source: dict, registration: dict,
                                   parser_receipt_hash: str) -> dict:
    """Convert a successful registration into the Bridge/Hook source envelope.

    The envelope is an internal Host input.  It contains no model-authored
    text beyond the already anchored goal/span and cannot be created from an
    Actor tool call.  ``parser_receipt_hash`` must bind the extractor,
    anchoring and independent review evidence produced by the caller.
    """
    source = _source(source)
    if not isinstance(parser_receipt_hash, str) or len(parser_receipt_hash) != 64:
        _fail("parser_receipt", "a content-addressed parser receipt is required")
    state = registration.get("state") if isinstance(registration, dict) else None
    if (not isinstance(state, dict) or state.get("schemaVersion") != "gaia2-window-obligation-v1"
            or registration.get("status") != "registered" or not state.get("obligations")):
        _fail("registration_state", "only a successful registration can enter the Host")
    obligations = []
    for item in state["obligations"]:
        if (item.get("userRef") != source["userRef"] or item.get("sourceHash") != source["sourceHash"]
                or item.get("status") != "pending" or item.get("executionId") != state.get("executionId")
                or item.get("sessionId") != state.get("sessionId")):
            _fail("registration_state", "registration state is not bound to the source")
        obligations.append({key: item[key] for key in (
            "id", "mode", "goal", "deadline", "notificationPolicy", "sourceSpanHash", "span")})
    full_span = {"start": 0, "end": len(source["text"]), "text": source["text"]}
    return {"schemaVersion": SOURCE_SCHEMA, "enabled": True,
            "executionId": source["executionId"], "sessionId": source["sessionId"],
            "userRef": source["userRef"], "sourceHash": source["sourceHash"],
            "span": full_span, "sceneStart": source["arrivedAt"],
            "parserReceiptHash": parser_receipt_hash, "obligations": obligations}


__all__ = ["SCHEMA", "SOURCE_SCHEMA", "WindowRegistrationError",
           "register_reviewed_windows", "build_window_obligation_source"]
