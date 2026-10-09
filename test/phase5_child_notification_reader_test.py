"""Scoped child notification reader contract tests.

These tests intentionally exercise only the parent-owned projection and the
bridge fan-out seam.  They do not start a Scenario or a real provider.  The
child reader is not the official ARE ``BaseNotificationSystem``: it is a
read-only cursor over records already admitted by the trusted parent.
"""

from datetime import datetime, timezone
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import capybara_official_bridge as bridge
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.notification_system import BaseNotificationSystem, Message, MessageType
from are.simulation.types import EnvironmentState
from gaia2_deadline_notifications import ScopedArrivedNotificationProjection
from gaia2_notification_producer import (
    NotificationProducerError,
    NotificationReaderError,
    ScopedChildNotificationReader,
    ScopedNotificationOriginRegistry,
)


def msg(kind: MessageType, text: str, second: float) -> Message:
    return Message(kind, text, datetime.fromtimestamp(second, tz=timezone.utc))


class ChildNotificationReaderTests(unittest.TestCase):
    def setUp(self):
        self.env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        self.env.state = EnvironmentState.RUNNING
        self.registry = ScopedNotificationOriginRegistry()
        self.projection = ScopedArrivedNotificationProjection(scope_id="scope-1")
        self.registry.bind_origin(origin_id="origin-1", scope_id="scope-1",
                                  child_execution_id="child-1", app_id="Contacts",
                                  projection=self.projection)
        self.reader = self.registry.open_reader(origin_id="origin-1", scope_id="scope-1",
                                                child_execution_id="child-1", app_id="Contacts",
                                                time_manager=self.env.time_manager)

    def test_reader_is_not_official_notification_system_or_queue_owner(self):
        self.assertIs(type(self.reader), ScopedChildNotificationReader)
        self.assertNotIsInstance(self.reader, BaseNotificationSystem)
        self.assertFalse(hasattr(self.reader, "message_queue"))
        self.assertFalse(hasattr(self.reader, "publish"))
        self.assertFalse(hasattr(self.reader, "bind_origin"))
        queue = self.env.notification_system.message_queue
        queued = msg(MessageType.USER_MESSAGE, "parent-owned", 1000)
        queue.put(queued)
        before = queue.list_view()
        self.registry.publish(origin_id="origin-1", occurrence_id="occ-1", sequence=1,
                              arrived_at=1000, message=msg(MessageType.USER_MESSAGE, "projected", 1000))
        self.assertEqual(queue.list_view(), before)
        self.assertEqual(self.reader.snapshot()["lastSequence"], 0)

    def test_parent_bridge_and_child_reader_each_observe_one_occurrence(self):
        binding = bridge.BridgeNotificationBinding(self.registry, "origin-1", "occ")
        self.env.notification_system.message_queue.put(msg(MessageType.USER_MESSAGE, "same", 1000))
        self.env.notification_system.message_queue.put(msg(MessageType.USER_MESSAGE, "same", 1000))
        parent_messages = []
        revision, changed, stopped = bridge._drain_notifications(self.env, parent_messages, 0,
                                                                 binding=binding)
        self.assertEqual((revision, changed, stopped), (2, True, False))
        self.assertEqual([item["notificationSequence"] for item in parent_messages], [1, 2])
        child_records = self.reader.poll()
        self.assertEqual([item.sequence for item in child_records], [1, 2])
        self.assertEqual([item.message.message for item in child_records], ["same", "same"])
        self.assertEqual(self.reader.poll(), ())
        self.assertEqual(binding.parent_cursor, 2)

    def test_future_record_is_hidden_until_official_clock_reaches_arrival(self):
        self.registry.publish(origin_id="origin-1", occurrence_id="future", sequence=1,
                              arrived_at=1010, message=msg(MessageType.USER_MESSAGE, "future", 1010))
        self.assertEqual(self.reader.poll(), ())
        self.env.time_manager.add_offset(10)
        records = self.reader.poll()
        self.assertEqual([item.notification_id for item in records], ["future"])
        self.assertEqual(records[0].arrived_at, 1010.0)

    def test_reader_scope_binding_and_clock_failure_are_sticky(self):
        with self.assertRaisesRegex(NotificationProducerError, "NOTIFICATION_PRODUCER_READER_SCOPE_MISMATCH"):
            self.registry.open_reader(origin_id="origin-1", scope_id="other-scope",
                                      child_execution_id="child-1", app_id="Contacts",
                                      time_manager=self.env.time_manager)

        class Clock:
            def __init__(self):
                self.now = float("nan")

            def time(self):
                return self.now

        clock = Clock()
        projection = ScopedArrivedNotificationProjection(scope_id="scope-clock")
        registry = ScopedNotificationOriginRegistry()
        registry.bind_origin(origin_id="origin-clock", scope_id="scope-clock",
                             child_execution_id="child-clock", app_id="Contacts",
                             projection=projection)
        reader = registry.open_reader(origin_id="origin-clock", scope_id="scope-clock",
                                      child_execution_id="child-clock", app_id="Contacts",
                                      time_manager=clock)
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOCK_INVALID"):
            reader.poll()
        clock.now = 1000
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOCK_INVALID"):
            reader.poll()

    def test_reader_close_is_terminal_and_origin_rebind_is_not_reader_authority(self):
        self.reader.close()
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOSED"):
            self.reader.poll()
        with self.assertRaisesRegex(NotificationProducerError, "NOTIFICATION_PRODUCER_ORIGIN_REBIND"):
            self.registry.bind_origin(origin_id="origin-1", scope_id="scope-other",
                                       child_execution_id="child-other", app_id="Other",
                                       projection=ScopedArrivedNotificationProjection(scope_id="scope-other"))

    def test_direct_constructor_cannot_relabel_foreign_origin(self):
        projection = ScopedArrivedNotificationProjection(scope_id="scope-2")
        self.registry.bind_origin(origin_id="origin-2", scope_id="scope-2",
                                  child_execution_id="child-2", app_id="Contacts",
                                  projection=projection)
        token = self.registry._reader_binding_token("origin-2")
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_BINDING_INVALID"):
            ScopedChildNotificationReader(self.registry, "origin-2", "scope-1", "child-1",
                                          "Contacts", self.env.time_manager, binding_token=token)

    def test_clock_and_projection_binding_drift_are_sticky(self):
        class Clock:
            def __init__(self):
                self.now = 1000.0

            def time(self):
                return self.now

        clock = Clock()
        projection = ScopedArrivedNotificationProjection(scope_id="scope-clock-drift")
        registry = ScopedNotificationOriginRegistry()
        registry.bind_origin(origin_id="origin-clock-drift", scope_id="scope-clock-drift",
                             child_execution_id="child-clock-drift", app_id="Contacts",
                             projection=projection)
        reader = registry.open_reader(origin_id="origin-clock-drift", scope_id="scope-clock-drift",
                                      child_execution_id="child-clock-drift", app_id="Contacts",
                                      time_manager=clock)
        clock.time = lambda: 1000.0
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOCK_CHANGED"):
            reader.poll()
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOCK_CHANGED"):
            reader.poll()

        bindings = registry._ScopedNotificationOriginRegistry__bindings
        replacement = ScopedArrivedNotificationProjection(scope_id="scope-clock-drift")
        bindings["origin-clock-drift"].projection = replacement
        reader2 = registry.open_reader(origin_id="origin-clock-drift", scope_id="scope-clock-drift",
                                       child_execution_id="child-clock-drift", app_id="Contacts",
                                       time_manager=Clock())
        bindings["origin-clock-drift"].projection = ScopedArrivedNotificationProjection(
            scope_id="scope-clock-drift")
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_BINDING_CHANGED"):
            reader2.poll()

    def test_projection_method_tamper_is_sticky(self):
        original = self.projection.project
        self.projection.project = lambda *, are_now: ()
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_BINDING_CHANGED"):
            self.reader.poll()
        # Restoring the method cannot reopen a reader after a failed binding
        # check; this is required for fail-closed child lifecycle semantics.
        self.projection.project = original
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_BINDING_CHANGED"):
            self.reader.poll()


if __name__ == "__main__":
    unittest.main(verbosity=2)
