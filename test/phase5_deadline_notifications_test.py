"""Model-free 5.2c2.3 primitives: OS deadline and scoped arrived messages."""

from __future__ import annotations

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from are.simulation.notification_system import Message, MessageType
from gaia2_deadline_notifications import (
    DeadlineNotificationError,
    ProjectedNotification,
    ScopedArrivedNotificationProjection,
    ScopedOSDeadline,
    message_hash,
)


class Clock:
    def __init__(self, value=100.0):
        self.value = value

    def __call__(self):
        return self.value


def msg(text: str, second: int = 0) -> Message:
    return Message(MessageType.USER_MESSAGE, text,
                   datetime.fromtimestamp(1_700_000_000 + second, tz=timezone.utc))


class DeadlineTests(unittest.TestCase):
    def test_os_deadline_is_independent_from_are_time_and_expires_sticky(self):
        clock = Clock()
        deadline = ScopedOSDeadline(scope_id="child-a", duration_seconds=5, monotonic_clock=clock)
        self.assertAlmostEqual(deadline.check(stage="gate"), 5.0)
        # An ARE pause or jump is not part of this clock's observation.
        are_now = 9_999_999.0
        self.assertEqual(are_now, 9_999_999.0)
        clock.value = 104.5
        self.assertAlmostEqual(deadline.remaining(stage="sdk_attempt"), 0.5)
        clock.value = 105.0
        self.assertEqual(deadline.remaining(stage="finish"), 0.0)
        with self.assertRaisesRegex(DeadlineNotificationError, "OS_DEADLINE_EXPIRED"):
            deadline.check(stage="finish")
        clock.value = 104.0
        # An expired request cannot be revived by moving a test clock back.
        with self.assertRaisesRegex(DeadlineNotificationError, "OS_DEADLINE_INVALID"):
            deadline.check(stage="late")

    def test_backward_or_invalid_monotonic_clock_is_sticky(self):
        clock = Clock()
        deadline = ScopedOSDeadline(scope_id="child-b", duration_seconds=20, monotonic_clock=clock)
        clock.value = 101.0
        deadline.check(stage="first")
        clock.value = 100.5
        with self.assertRaisesRegex(DeadlineNotificationError, "OS_DEADLINE_INVALID"):
            deadline.check(stage="rollback")
        clock.value = 102.0
        with self.assertRaisesRegex(DeadlineNotificationError, "OS_DEADLINE_INVALID"):
            deadline.remaining(stage="restored")

    def test_deadline_rejects_invalid_duration_and_scope(self):
        for value in (-1, float("nan"), float("inf"), True):
            with self.subTest(value=value), self.assertRaises(DeadlineNotificationError):
                ScopedOSDeadline(scope_id="child", duration_seconds=value)
        with self.assertRaisesRegex(DeadlineNotificationError, "DEADLINE_SCOPE_INVALID"):
            ScopedOSDeadline(scope_id="", duration_seconds=1)


class NotificationProjectionTests(unittest.TestCase):
    def setUp(self):
        self.projection = ScopedArrivedNotificationProjection(scope_id="child-scope")

    def test_only_arrived_current_scope_is_projected_and_payload_is_copied(self):
        first = msg("arrived", 1)
        future = msg("future", 2)
        self.assertTrue(self.projection.ingest(scope_id="child-scope", notification_id="n1",
            sequence=1, arrived_at=10, message=first))
        self.assertTrue(self.projection.ingest(scope_id="child-scope", notification_id="n2",
            sequence=2, arrived_at=20, message=future))
        projected = self.projection.project(are_now=15)
        self.assertEqual([item.notification_id for item in projected], ["n1"])
        self.assertEqual(projected[0].scope_id, "child-scope")
        self.assertEqual(projected[0].message_hash, message_hash(first))
        projected[0].message.message = "mutated local copy"
        self.assertEqual(self.projection.project(are_now=15)[0].message.message, "arrived")
        view = self.projection.snapshot(are_now=15)
        self.assertEqual(view["visibleCount"], 1)
        self.assertEqual(view["futureCount"], 1)
        self.assertEqual([item["message"].message for item in view["notifications"]], ["arrived"])

    def test_drain_is_exactly_once_and_future_becomes_visible_later(self):
        self.projection.ingest(scope_id="child-scope", notification_id="n1", sequence=1,
                               arrived_at=10, message=msg("one"))
        self.projection.ingest(scope_id="child-scope", notification_id="n2", sequence=2,
                               arrived_at=20, message=msg("two"))
        self.assertEqual([item.notification_id for item in self.projection.drain(are_now=15)], ["n1"])
        self.assertEqual(self.projection.drain(are_now=15), ())
        self.assertEqual([item.notification_id for item in self.projection.drain(are_now=20)], ["n2"])

    def test_exact_duplicate_is_idempotent_but_conflict_fails_closed(self):
        value = msg("same")
        args = dict(scope_id="child-scope", notification_id="n1", sequence=1,
                    arrived_at=10, message=value)
        self.assertTrue(self.projection.ingest(**args))
        self.assertFalse(self.projection.ingest(**args))
        with self.assertRaisesRegex(DeadlineNotificationError, "NOTIFICATION_CONFLICT"):
            self.projection.ingest(scope_id="child-scope", notification_id="n1", sequence=1,
                                   arrived_at=10, message=msg("tampered"))

    def test_scope_sequence_and_stale_conflicts_are_rejected(self):
        self.projection.ingest(scope_id="child-scope", notification_id="n1", sequence=1,
                               arrived_at=10, message=msg("one"))
        with self.assertRaisesRegex(DeadlineNotificationError, "NOTIFICATION_SCOPE_MISMATCH"):
            self.projection.ingest(scope_id="other", notification_id="n2", sequence=2,
                                   arrived_at=11, message=msg("foreign"))
        with self.assertRaisesRegex(DeadlineNotificationError, "NOTIFICATION_SEQUENCE_CONFLICT"):
            self.projection.ingest(scope_id="child-scope", notification_id="n2", sequence=1,
                                   arrived_at=11, message=msg("same sequence"))
        self.projection.ingest(scope_id="child-scope", notification_id="n3", sequence=3,
                               arrived_at=12, message=msg("three"))
        with self.assertRaisesRegex(DeadlineNotificationError, "NOTIFICATION_STALE"):
            self.projection.ingest(scope_id="child-scope", notification_id="n2", sequence=2,
                                   arrived_at=13, message=msg("late"))
        with self.assertRaisesRegex(DeadlineNotificationError, "NOTIFICATION_STALE"):
            self.projection.ingest(scope_id="child-scope", notification_id="n4", sequence=4,
                                   arrived_at=11, message=msg("arrival rollback"))

    def test_are_projection_clock_is_non_decreasing_and_sticky(self):
        self.projection.ingest(scope_id="child-scope", notification_id="n1", sequence=1,
                               arrived_at=10, message=msg("one"))
        self.projection.project(are_now=10)
        with self.assertRaisesRegex(DeadlineNotificationError, "NOTIFICATION_STALE"):
            self.projection.ingest(scope_id="child-scope", notification_id="late", sequence=2,
                                   arrived_at=9, message=msg("late"))
        with self.assertRaisesRegex(DeadlineNotificationError, "NOTIFICATION_CLOCK_INVALID"):
            self.projection.project(are_now=9)
        with self.assertRaisesRegex(DeadlineNotificationError, "NOTIFICATION_CLOCK_INVALID"):
            self.projection.project(are_now=11)

    def test_invalid_message_and_sequence_are_rejected(self):
        for value in (object(), None):
            with self.subTest(value=type(value).__name__), self.assertRaisesRegex(
                    DeadlineNotificationError, "NOTIFICATION_MESSAGE_INVALID"):
                self.projection.ingest(scope_id="child-scope", notification_id="n1", sequence=1,
                                       arrived_at=10, message=value)
        for sequence in (0, -1, True):
            with self.subTest(sequence=sequence), self.assertRaisesRegex(
                    DeadlineNotificationError, "NOTIFICATION_SEQUENCE_INVALID"):
                self.projection.ingest(scope_id="child-scope", notification_id="n1", sequence=sequence,
                                       arrived_at=10, message=msg("bad sequence"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
