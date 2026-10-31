import hashlib
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from gaia2_task_contract import task_contract_hash
from gaia2_window_obligation import WindowObligationLedger
from gaia2_window_registration import (WindowRegistrationError, build_window_obligation_source,
                                       register_reviewed_windows)


class WindowRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.text = "Wait for a reply during the next 120 seconds and do not notify me."
        self.source = {
            "schemaVersion": "gaia2-task-contract-source-v1", "executionId": "e-1",
            "sessionId": "s-1", "userRef": "user-1", "text": self.text,
            "sourceHash": hashlib.sha256(self.text.encode()).hexdigest(), "arrivedAt": 100.0,
        }
        span = {"start": 0, "end": len(self.text), "text": self.text}
        self.proposal = {
            "schemaVersion": "gaia2-task-contract-proposal-v1", "sourceHash": self.source["sourceHash"],
            "resolution": "obligations", "notificationPolicy": "forbid_until_deadline",
            "obligations": [{"span": span, "mode": "monitor_until", "goal": "Monitor the reply",
                             "timeBasis": {"kind": "relative", "durationSeconds": 120}, "recipe": None}],
            "revocations": [],
        }
        self.review = {
            "schemaVersion": "gaia2-task-contract-review-v1", "sourceHash": self.source["sourceHash"],
            "proposalHash": task_contract_hash(self.proposal), "decision": "approved",
            "notificationVerified": True, "obligationChecks": [{"index": 0, "spanVerified": True,
                "modeVerified": True, "timeVerified": True}], "revocationChecks": [], "reason": "verified",
        }

    def test_registers_from_original_arrival_not_registration_time(self):
        ledger = WindowObligationLedger("e-1", "s-1")
        result = register_reviewed_windows(ledger=ledger, source=self.source, proposal=self.proposal,
                                           review=self.review, are_now=105.0)
        self.assertEqual(result["status"], "registered")
        obligation = result["state"]["obligations"][0]
        self.assertEqual(obligation["sceneStart"], 100.0)
        self.assertEqual(obligation["deadline"], 220.0)
        self.assertEqual(obligation["span"]["text"], self.text)

    def test_builds_internal_host_source_envelope_from_registered_state(self):
        ledger = WindowObligationLedger("e-1", "s-1")
        registration = register_reviewed_windows(ledger=ledger, source=self.source, proposal=self.proposal,
                                                 review=self.review, are_now=105.0)
        envelope = build_window_obligation_source(source=self.source, registration=registration,
                                                  parser_receipt_hash="a" * 64)
        self.assertEqual(envelope["schemaVersion"], "gaia2-window-obligation-source-v1")
        self.assertEqual(envelope["sourceHash"], self.source["sourceHash"])
        self.assertEqual(envelope["obligations"][0]["deadline"], 220.0)
        self.assertEqual(envelope["obligations"][0]["span"]["text"], self.text)

    def test_registration_is_idempotent_for_same_user_occurrence(self):
        ledger = WindowObligationLedger("e-1", "s-1")
        first = register_reviewed_windows(ledger=ledger, source=self.source, proposal=self.proposal,
                                          review=self.review, are_now=101.0)
        second = register_reviewed_windows(ledger=ledger, source=self.source, proposal=self.proposal,
                                           review=self.review, are_now=102.0)
        self.assertEqual(first["registered"], 1)
        self.assertEqual(second["status"], "already_registered")
        self.assertEqual(len(second["state"]["obligations"]), 1)

    def test_unapproved_or_ambiguous_review_cannot_register(self):
        ledger = WindowObligationLedger("e-1", "s-1")
        rejected = dict(self.review, decision="ambiguous", notificationVerified=False)
        with self.assertRaisesRegex(WindowRegistrationError, "review_rejected"):
            register_reviewed_windows(ledger=ledger, source=self.source, proposal=self.proposal,
                                      review=rejected, are_now=101.0)

    def test_changed_source_span_and_hash_fail_closed(self):
        ledger = WindowObligationLedger("e-1", "s-1")
        changed = dict(self.proposal, obligations=[dict(self.proposal["obligations"][0], span={"start": 0, "end": 4, "text": "Oops"})])
        changed["sourceHash"] = self.source["sourceHash"]
        with self.assertRaisesRegex(WindowRegistrationError, "source_span"):
            register_reviewed_windows(ledger=ledger, source=self.source, proposal=changed,
                                      review=self.review, are_now=101.0)
        bad_source = dict(self.source, text=self.text + " altered")
        with self.assertRaisesRegex(WindowRegistrationError, "source_hash"):
            register_reviewed_windows(ledger=ledger, source=bad_source, proposal=self.proposal,
                                      review=self.review, are_now=101.0)

    def test_registration_rejects_are_time_before_original_arrival(self):
        with self.assertRaisesRegex(WindowRegistrationError, "registration ARE time"):
            register_reviewed_windows(ledger=WindowObligationLedger("e-1", "s-1"), source=self.source,
                                      proposal=self.proposal, review=self.review, are_now=99.0)


if __name__ == "__main__":
    unittest.main()
