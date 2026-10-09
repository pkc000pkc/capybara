"""Trusted parent notification origin/occurrence binding tests."""

from datetime import datetime, timezone, timedelta
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

from are.simulation.notification_system import Message, MessageType, MessageQueue
from gaia2_deadline_notifications import ScopedArrivedNotificationProjection
from gaia2_notification_producer import (
    NotificationProducerError,
    NotificationReaderError,
    ScopedNotificationOriginRegistry,
)


def msg(text: str, second: int = 0, kind: MessageType = MessageType.USER_MESSAGE) -> Message:
    return Message(kind, text, datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=second))


class ProducerTests(unittest.TestCase):
    def setUp(self):
        self.registry = ScopedNotificationOriginRegistry()
        self.projection = ScopedArrivedNotificationProjection(scope_id="request-1")
        self.assertTrue(self.registry.bind_origin(origin_id="origin-1", scope_id="request-1",
            child_execution_id="child-1", app_id="Contacts", projection=self.projection))

    def publish(self, occurrence="occ-1", sequence=1, arrived=10, message=None):
        return self.registry.publish(origin_id="origin-1", occurrence_id=occurrence,
            sequence=sequence, arrived_at=arrived, message=message or msg("hello"))

    def test_binding_is_immutable_and_snapshot_hides_origin_raw_value(self):
        self.assertFalse(self.registry.bind_origin(origin_id="origin-1", scope_id="request-1",
            child_execution_id="child-1", app_id="Contacts", projection=self.projection))
        with self.assertRaisesRegex(NotificationProducerError, "ORIGIN_REBIND"):
            self.registry.bind_origin(origin_id="origin-1", scope_id="request-2",
                child_execution_id="child-2", app_id="Contacts",
                projection=ScopedArrivedNotificationProjection(scope_id="request-2"))
        view = self.registry.snapshot()
        self.assertEqual(view["bindings"][0]["scopeId"], "request-1")
        self.assertNotIn("origin-1", str(view))

    def test_unknown_foreign_and_invalid_origin_fail_closed(self):
        with self.assertRaisesRegex(NotificationProducerError, "ORIGIN_UNKNOWN"):
            self.registry.publish(origin_id="foreign", occurrence_id="occ", sequence=1,
                arrived_at=1, message=msg("x"))
        with self.assertRaisesRegex(NotificationProducerError, "ORIGIN_INVALID"):
            self.registry.publish(origin_id="", occurrence_id="occ", sequence=1,
                arrived_at=1, message=msg("x"))

    def test_arrival_only_projection_preserves_same_text_occurrences(self):
        self.publish("occ-1", 1, 10, msg("same"))
        self.publish("occ-2", 2, 10, msg("same"))
        self.assertEqual([item.notification_id for item in self.registry.project(origin_id="origin-1", are_now=9)], [])
        visible = self.registry.project(origin_id="origin-1", are_now=10)
        self.assertEqual([item.notification_id for item in visible], ["occ-1", "occ-2"])
        self.assertEqual([item.message.message for item in visible], ["same", "same"])

    def test_exact_duplicate_is_idempotent_and_changed_occurrence_conflicts(self):
        first = self.publish()
        duplicate = self.publish()
        self.assertEqual(first["status"], "accepted")
        self.assertEqual(duplicate["status"], "duplicate")
        with self.assertRaisesRegex(NotificationProducerError, "OCCURRENCE_CONFLICT"):
            self.publish(message=msg("tampered"))

    def test_sequence_and_arrival_rollback_are_rejected(self):
        self.publish("occ-1", 2, 20)
        with self.assertRaisesRegex(NotificationProducerError, "SEQUENCE_STALE"):
            self.publish("occ-2", 1, 21)
        with self.assertRaisesRegex(NotificationProducerError, "ARRIVAL_STALE"):
            self.publish("occ-3", 3, 19)

    def test_stop_revokes_origin_and_never_enters_child_projection(self):
        result = self.publish("stop-1", 2, 20, msg("stop", kind=MessageType.ENVIRONMENT_STOP))
        self.assertEqual(result["status"], "stopped")
        with self.assertRaisesRegex(NotificationProducerError, "ORIGIN_REVOKED"):
            self.publish("late", 3, 21)
        self.assertEqual(self.projection.project(are_now=100), ())
        with self.assertRaisesRegex(NotificationProducerError, "ORIGIN_REVOKED"):
            self.registry.bind_origin(origin_id="origin-1", scope_id="request-1",
                child_execution_id="child-1", app_id="Contacts", projection=self.projection)

    def test_scope_reader_isolation_and_parent_queue_is_not_consumed(self):
        second_projection = ScopedArrivedNotificationProjection(scope_id="request-2")
        self.registry.bind_origin(origin_id="origin-2", scope_id="request-2",
            child_execution_id="child-2", app_id="Contacts", projection=second_projection)
        self.publish("one", 1, 10)
        self.registry.publish(origin_id="origin-2", occurrence_id="two", sequence=1,
            arrived_at=10, message=msg("two"))
        self.assertEqual([item.notification_id for item in self.registry.drain(origin_id="origin-1", are_now=10)], ["one"])
        self.assertEqual([item.notification_id for item in self.registry.project(origin_id="origin-2", are_now=10)], ["two"])
        queue = MessageQueue()
        queued = msg("still parent-owned")
        queue.put(queued)
        before = queue.list_view()
        self.publish("three", 2, 11, msg("projection only"))
        self.assertEqual(queue.list_view(), before)

    def test_occurrence_id_cannot_move_between_origins(self):
        second_projection = ScopedArrivedNotificationProjection(scope_id="request-2")
        self.registry.bind_origin(origin_id="origin-2", scope_id="request-2",
            child_execution_id="child-2", app_id="Contacts", projection=second_projection)
        self.publish("global-occurrence", 1, 10)
        with self.assertRaisesRegex(NotificationProducerError, "OCCURRENCE_FOREIGN"):
            self.registry.publish(origin_id="origin-2", occurrence_id="global-occurrence", sequence=1,
                arrived_at=10, message=msg("same"))

    def test_message_and_contract_inputs_are_strict(self):
        with self.assertRaisesRegex(NotificationProducerError, "MESSAGE_INVALID"):
            self.registry.publish(origin_id="origin-1", occurrence_id="occ", sequence=1,
                arrived_at=1, message={"message": "not official"})
        with self.assertRaisesRegex(NotificationProducerError, "SEQUENCE_INVALID"):
            self.registry.publish(origin_id="origin-1", occurrence_id="occ", sequence=True,
                arrived_at=1, message=msg("x"))
        with self.assertRaisesRegex(NotificationProducerError, "PROJECTION_INVALID"):
            self.registry.bind_origin(origin_id="other", scope_id="request-1",
                child_execution_id="child", app_id="Contacts", projection=object())

    def test_scoped_reader_is_fanout_exactly_once_and_deep_copied(self):
        class Clock:
            def __init__(self):
                self.now = 10.0
            def time(self):
                return self.now
        clock = Clock()
        first = self.registry.open_reader(origin_id="origin-1", scope_id="request-1",
            child_execution_id="child-1", app_id="Contacts", time_manager=clock)
        second = self.registry.open_reader(origin_id="origin-1", scope_id="request-1",
            child_execution_id="child-1", app_id="Contacts", time_manager=clock)
        self.publish("one", 1, 10, msg("same"))
        self.publish("two", 2, 10, msg("same"))
        first_view = first.poll()
        self.assertEqual([item.notification_id for item in first_view], ["one", "two"])
        first_view[0].message.message = "tampered local copy"
        self.assertEqual(first.poll(), ())
        self.assertEqual([item.message.message for item in second.poll()], ["same", "same"])
        self.assertEqual(second.poll(), ())

    def test_scoped_reader_hides_future_and_fails_sticky_on_clock_rollback(self):
        class Clock:
            def __init__(self):
                self.now = 10.0
            def time(self):
                return self.now
        clock = Clock()
        reader = self.registry.open_reader(origin_id="origin-1", scope_id="request-1",
            child_execution_id="child-1", app_id="Contacts", time_manager=clock)
        self.publish("future", 1, 20, msg("future"))
        self.assertEqual(reader.poll(), ())
        clock.now = 20.0
        self.assertEqual([item.notification_id for item in reader.poll()], ["future"])
        clock.now = 19.0
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOCK_INVALID"):
            reader.poll()
        clock.now = 20.0
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOCK_INVALID"):
            reader.poll()

    def test_reader_scope_close_and_revocation_fail_closed(self):
        class Clock:
            def time(self):
                return 10.0
        with self.assertRaisesRegex(NotificationProducerError, "READER_SCOPE_MISMATCH"):
            self.registry.open_reader(origin_id="origin-1", scope_id="other",
                child_execution_id="child-1", app_id="Contacts", time_manager=Clock())
        reader = self.registry.open_reader(origin_id="origin-1", scope_id="request-1",
            child_execution_id="child-1", app_id="Contacts", time_manager=Clock())
        reader.close()
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOSED"):
            reader.poll()


if __name__ == "__main__":
    unittest.main(verbosity=2)
