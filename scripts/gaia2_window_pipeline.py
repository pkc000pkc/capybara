"""Trusted USER-to-window registration pipeline.

This is the narrow production seam between the constrained extractor/reviewer
and the runtime window ledger.  It never classifies natural language itself:
the extractor and reviewer are injected callbacks, and registration only
accepts their source-bound, independently approved artifacts.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from gaia2_task_contract import TaskContractRuntime, task_contract_hash
from gaia2_task_contract_model import extract_task_contract, review_task_contract
from gaia2_window_obligation import WindowObligationLedger
from gaia2_window_registration import build_window_obligation_source, register_reviewed_windows


SCHEMA = "gaia2-window-pipeline-v1"


def _receipt_hash(value: Any) -> str:
    return task_contract_hash(value)


def resolve_user_window_source(*, evidence_root: str | Path, execution_id: str,
                               session_id: str, user_ref: str, text: str,
                               arrived_at: float, are_now: float,
                               model_call: Callable[[list[dict], list[dict]], Any]) -> dict:
    """Run the constrained extractor/reviewer and return a Hook envelope.

    Ambiguous/no-obligation results are returned as a non-registered status;
    they never become a pending window.  Protocol or transport errors remain
    visible in the TaskContractRuntime state and do not default-approve.
    """
    runtime = TaskContractRuntime(evidence_root, execution_id, session_id,
                                  lambda source: extract_task_contract(source, model_call),
                                  lambda source, proposal: review_task_contract(source, proposal, model_call))
    state = runtime.resolve_user(user_ref, text, arrived_at)
    source_record = next(item for item in state["sources"] if item["userRef"] == user_ref)
    result = {"schemaVersion": SCHEMA, "status": source_record["resolution"],
              "sourceHash": source_record["sourceHash"], "state": state,
              "sourceRecord": source_record, "windowSource": None}
    if source_record["resolution"] != "registered":
        return result
    proposal_ref = source_record.get("normalizedProposalRef") or source_record.get("proposalRef")
    review_ref = source_record.get("reviewRef")
    if not proposal_ref or not review_ref:
        result["status"] = "technical_unresolved"
        return result
    proposal = runtime.load_evidence_ref(proposal_ref)
    review = runtime.load_evidence_ref(review_ref)
    source = {"schemaVersion": "gaia2-task-contract-source-v1", "executionId": execution_id,
              "sessionId": session_id, "userRef": user_ref, "text": text,
              "sourceHash": source_record["sourceHash"], "arrivedAt": arrived_at}
    ledger = WindowObligationLedger(execution_id, session_id)
    registration = register_reviewed_windows(ledger=ledger, source=source,
                                             proposal=proposal, review=review,
                                             are_now=are_now)
    if registration["status"] != "registered":
        result["status"] = registration["status"]
        return result
    parser_receipt = {"schemaVersion": SCHEMA, "source": source,
                      "sourceRecord": source_record, "proposal": proposal,
                      "review": review, "registration": registration}
    envelope = build_window_obligation_source(
        source=source, registration=registration,
        parser_receipt_hash=_receipt_hash(parser_receipt))
    result.update({"status": "registered", "registration": registration,
                   "windowSource": envelope,
                   "parserReceiptHash": _receipt_hash(parser_receipt)})
    return result


__all__ = ["SCHEMA", "resolve_user_window_source"]
