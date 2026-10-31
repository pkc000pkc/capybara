import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from gaia2_window_obligation import WindowObligationError, WindowObligationLedger


class WindowObligationTests(unittest.TestCase):
    def setUp(self):
        self.ledger = WindowObligationLedger("execution", "session")
        self.source = "Wait for a reply during the next 120 seconds and do not notify me."
        self.span = {"start": 0, "end": len(self.source), "text": self.source}
        self.ledger.register(user_ref="user-1", source_text=self.source, span=self.span,
                             mode="monitor_until", goal="Monitor the reply", scene_start=100,
                             deadline=220, notification_policy="forbid_until_deadline")
        self.obligation = self.ledger.snapshot()["obligations"][0]["id"]

    def evidence(self, action="read-1", observed=100):
        return {"actionId": action, "observedAt": observed, "complete": True, "viewComplete": True}

    def test_timeout_and_scan_budget_do_not_complete_window(self):
        self.ledger.set_budget("sdk", 6)
        self.ledger.set_budget("wait", 3)
        self.ledger.note_wait(self.obligation, waits=1, scans=1, signal="unchanged", now=130)
        self.ledger.note_wait(self.obligation, waits=1, scans=1, signal="scan_budget", now=160)
        state = self.ledger.snapshot()["obligations"][0]
        self.assertEqual(state["status"], "technical_termination")
        self.assertEqual(state["terminationSignal"], "scan_budget")
        self.assertFalse(self.ledger.finish(160)["allowed"])

    def test_candidate_requires_review_and_monitor_cannot_complete_early(self):
        self.ledger.candidate(self.obligation, self.evidence(observed=140), now=140)
        reply = self.ledger.authorize_reply(self.obligation, now=140)
        self.assertFalse(reply["allowed"])
        self.assertEqual(reply["reason"], "window_pending")
        with self.assertRaisesRegex(WindowObligationError, "monitor-until"):
            self.ledger.review(self.obligation, action_id="read-1", decision="condition_satisfied",
                               reason="candidate found", now=140)
        self.ledger.review(self.obligation, action_id="read-1", decision="continue",
                           reason="candidate is not sufficient", now=140)
        self.assertEqual(self.ledger.snapshot()["obligations"][0]["status"], "pending")

    def test_deadline_requires_final_complete_evidence(self):
        self.ledger.advance(220)
        self.assertEqual(self.ledger.snapshot()["obligations"][0]["status"], "window_expired_unreviewed")
        reply = self.ledger.authorize_reply(self.obligation, now=220)
        self.assertFalse(reply["allowed"])
        self.ledger.candidate(self.obligation, self.evidence("read-final", observed=220), now=220)
        self.ledger.review(self.obligation, action_id="read-final", decision="deadline_reviewed",
                           reason="final complete read covers the window", now=220)
        self.assertTrue(self.ledger.finish(220)["allowed"])
        self.assertTrue(self.ledger.authorize_reply(self.obligation, now=220)["allowed"])

    def test_early_reply_can_be_progress_but_not_completion(self):
        progress = self.ledger.authorize_reply(self.obligation, now=110, final=False, claims_completion=False)
        self.assertTrue(progress["allowed"])
        completion = self.ledger.authorize_reply(self.obligation, now=110, final=True, claims_completion=True)
        self.assertFalse(completion["allowed"])

    def test_three_budgets_are_independent(self):
        self.ledger.set_budget("sdk", 2)
        self.ledger.set_budget("wait", 4)
        self.ledger.set_budget("outer", 900)
        self.ledger.consume_budget("sdk", 1)
        self.ledger.consume_budget("wait", 2)
        state = self.ledger.snapshot()["budgets"]
        self.assertEqual(state["sdk"], {"limit": 2, "consumed": 1})
        self.assertEqual(state["wait"], {"limit": 4, "consumed": 2})
        self.assertEqual(state["outer"], {"limit": 900, "consumed": 0})
        with self.assertRaisesRegex(WindowObligationError, "cannot be rebound"):
            self.ledger.set_budget("wait", 8)

    def test_source_span_and_clock_are_verified(self):
        with self.assertRaisesRegex(WindowObligationError, "exact source span"):
            self.ledger.register(user_ref="user-2", source_text=self.source, span={"start": 0, "end": 2, "text": "bad"},
                                 mode="monitor_until", goal="x", scene_start=100, deadline=220)
        self.ledger.advance(100)
        with self.assertRaisesRegex(WindowObligationError, "nondecreasing"):
            self.ledger.advance(99)


if __name__ == "__main__":
    unittest.main()
