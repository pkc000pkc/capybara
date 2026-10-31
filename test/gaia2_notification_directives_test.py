import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gaia2_notification_directives import (NotificationDirectiveError,
    evaluate_directives, legacy_directives, normalize_directives)


def directive(**changes):
    value = {"channel": "aui", "trigger": "finish", "phase": "final",
             "decision": "forbid", "expiresAt": None}
    value.update(changes)
    return value


class NotificationDirectiveTests(unittest.TestCase):
    def test_legacy_scalar_mapping_preserves_boundary(self):
        value = legacy_directives("forbid_until_deadline", deadline=100)
        self.assertFalse(evaluate_directives(value, now=99)["allowed"])
        self.assertTrue(evaluate_directives(value, now=100)["allowed"])
        self.assertFalse(evaluate_directives(legacy_directives("forbid"), now=100000)["allowed"])
        self.assertEqual(legacy_directives("allow"), [])

    def test_channel_and_phase_are_isolated(self):
        value = normalize_directives([directive(channel="aui", trigger="finish", phase="after")])
        self.assertFalse(evaluate_directives(value, channel="aui", trigger="finish", phase="after")["allowed"])
        self.assertTrue(evaluate_directives(value, channel="a2a", trigger="finish", phase="after")["allowed"])
        self.assertTrue(evaluate_directives(value, channel="aui", trigger="candidate", phase="after")["allowed"])

    def test_explicit_deny_wins_over_allow_and_order_does_not_matter(self):
        deny = directive(channel="aui", trigger="finish", phase="final")
        allow = directive(channel="any", trigger="any", phase="any", decision="allow")
        # Allow is accepted as an explicit directive, but cannot mask a deny.
        self.assertFalse(evaluate_directives([allow, deny])["allowed"])
        self.assertFalse(evaluate_directives([deny, allow])["allowed"])

    def test_invalid_duplicate_and_expiry_are_rejected(self):
        with self.assertRaises(NotificationDirectiveError):
            normalize_directives([directive(), directive()])
        with self.assertRaises(NotificationDirectiveError):
            normalize_directives([directive(decision="allow", expiresAt=10)])
        with self.assertRaises(NotificationDirectiveError):
            normalize_directives([directive(expiresAt=101)], deadline=100)

    def test_conditional_phase_can_allow_initial_report_and_forbid_after_trigger(self):
        value = normalize_directives([
            directive(trigger="finish", phase="final", decision="allow"),
            directive(trigger="candidate", phase="after", decision="forbid"),
        ])
        self.assertTrue(evaluate_directives(value, trigger="finish", phase="final")["allowed"])
        self.assertFalse(evaluate_directives(value, trigger="candidate", phase="after")["allowed"])


if __name__ == "__main__":
    unittest.main()
