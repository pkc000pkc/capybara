import hashlib
import json
import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from gaia2_parent_a2a_integration import (A2AIntegrationError, ParentA2AInbox,
                                          ParentObligationLedger)


def result_payload(**overrides):
    result = {"answer": "child result"}
    value = {
        "resultId": "result-1", "callId": "call-1", "parentActionId": "delegate-1",
        "childExecutionId": "child-exec-1", "childSessionId": "child-session-1",
        "status": "succeeded", "effect": "read", "result": result,
        "canonicalName": "delegate-1", "resourceKey": "AppAgent",
        "resultHash": hashlib.sha256(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "executed": True, "complete": True,
        "completionEvidenceRef": {"path": "child/evidence.json", "sha256": "a" * 64},
        "obligationId": "obligation-1",
    }
    value.update(overrides)
    if "result" in overrides and "resultHash" not in overrides:
        value["resultHash"] = hashlib.sha256(json.dumps(value["result"], sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return value


class ParentA2AIntegrationTests(unittest.TestCase):
    def setUp(self):
        ledger = ParentObligationLedger()
        ledger.register({"id": "obligation-1", "canonicalName": "delegate-1",
                         "effect": "read", "minCalls": 1, "maxCalls": 1})
        self.inbox = ParentA2AInbox(ledger=ledger)

    def test_publish_does_not_integrate_or_satisfy_before_parent_request(self):
        self.inbox.publish(result_payload())
        snapshot = self.inbox.snapshot()
        self.assertEqual(snapshot["entries"][0]["status"], "published")
        self.assertEqual(snapshot["ledger"]["obligations"][0]["actualCalls"], 0)
        self.assertEqual(self.inbox.terminal_drain(limit=0)["status"], "failed")
        self.assertEqual(self.inbox.pending()[0].resultId, "result-1")

    def test_model_request_ack_transitions_to_integrated_once(self):
        self.inbox.publish(result_payload())
        projection = self.inbox.projection()
        self.assertEqual(projection[0]["resultHash"], result_payload()["resultHash"])
        integrated = self.inbox.integrate(model_request_id="model-request-1")
        self.assertEqual(integrated["integratedResultIds"], ["result-1"])
        row = integrated["ledger"]["obligations"][0]
        self.assertEqual(row["status"], "satisfied")
        self.assertEqual(row["actualCalls"], 1)
        self.assertEqual(self.inbox.integrate(model_request_id="model-request-1")["integratedResultIds"], [])
        with self.assertRaisesRegex(A2AIntegrationError, "inbox_replay"):
            self.inbox.integrate(model_request_id="model-request-2", result_ids=["result-1"])

    def test_duplicate_publish_is_idempotent_but_conflict_is_rejected(self):
        payload = result_payload()
        self.inbox.publish(payload)
        self.inbox.publish(payload)
        self.assertEqual(len(self.inbox.snapshot()["entries"]), 1)
        conflict = dict(payload, status="failed")
        with self.assertRaisesRegex(A2AIntegrationError, "child_result_conflict"):
            self.inbox.publish(conflict)

    def test_unknown_write_never_counts_as_success_or_replayable(self):
        payload = result_payload(status="unknown", effect="write", executed=None,
                                 complete=False, result={"status": "unknown"})
        self.inbox.publish(payload)
        self.inbox.integrate(model_request_id="model-request-unknown")
        row = self.inbox.snapshot()["ledger"]["obligations"][0]
        self.assertEqual(row["actualCalls"], 0)
        self.assertEqual(row["unknownCalls"], 1)
        self.assertEqual(row["status"], "missing")

    def test_success_without_child_evidence_is_unknown_even_for_read(self):
        payload = result_payload(completionEvidenceRef=None)
        self.inbox.publish(payload)
        self.inbox.integrate(model_request_id="model-request-no-evidence")
        row = self.inbox.snapshot()["ledger"]["obligations"][0]
        self.assertEqual(row["actualCalls"], 0)
        self.assertEqual(row["unknownCalls"], 1)

    def test_terminal_drain_has_bounded_success_and_failure_evidence(self):
        self.inbox.publish(result_payload())
        failed = self.inbox.terminal_drain(request_model=lambda _: None, limit=1)
        self.assertFalse(failed["success"])
        self.assertEqual(failed["attempts"], 1)
        self.assertEqual(failed["reason"], "model_request_not_acknowledged")
        succeeded = self.inbox.terminal_drain(request_model=lambda _: "model-request-drain", limit=1)
        self.assertTrue(succeeded["success"])
        self.assertEqual(succeeded["integratedResultIds"], ["result-1"])
        self.assertEqual(succeeded["pendingResultIds"], [])

    def test_stop_never_synthesizes_consumption(self):
        self.inbox.publish(result_payload())
        evidence = self.inbox.terminal_drain(request_model=lambda _: "should-not-run", stopped=True, limit=1)
        self.assertFalse(evidence["success"])
        self.assertEqual(evidence["reason"], "stop_observed")
        self.assertEqual(evidence["attempts"], 0)
        self.assertEqual(self.inbox.snapshot()["entries"][0]["status"], "published")


if __name__ == "__main__":
    unittest.main(verbosity=2)
