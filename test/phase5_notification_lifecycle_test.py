"""Controlled parent lifecycle tests for the scoped child notification reader.

The coordinator is intentionally same-process: it owns the official ARE clock
and projection while a future IPC adapter remains a separate phase.
"""

from datetime import datetime, timezone
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import capybara_official_bridge as bridge
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.notification_system import Message, MessageType
from are.simulation.types import EnvironmentState
from gaia2_notification_producer import (
    NotificationProducerError,
    NotificationReaderError,
    ScopedChildNotificationLifecycle,
    ScopedNotificationOriginRegistry,
)


def message(kind: MessageType, text: str, timestamp: float) -> Message:
    return Message(kind, text, datetime.fromtimestamp(timestamp, tz=timezone.utc))


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        self.env.state = EnvironmentState.RUNNING
        self.registry = ScopedNotificationOriginRegistry()
        self.scope = {"requestId": "request-1", "childExecutionId": "child-1", "appId": "Contacts"}

    def lifecycle(self, scope=None):
        return ScopedChildNotificationLifecycle(registry=self.registry,
            scope=scope or self.scope, time_manager=self.env.time_manager)

    def test_coordinator_binds_bridge_and_child_then_closes_fail_closed(self):
        lifecycle = self.lifecycle()
        binding = bridge.BridgeNotificationBinding.from_lifecycle(lifecycle)
        self.env.notification_system.message_queue.put(message(MessageType.USER_MESSAGE, "parent update", 1000))
        messages = []
        revision, changed, stopped = bridge._drain_notifications(self.env, messages, 0, binding=binding)
        self.assertEqual((revision, changed, stopped), (1, True, False))
        self.assertEqual([record.message.message for record in lifecycle.reader.poll()], ["parent update"])
        self.assertEqual(lifecycle.snapshot()["reader"]["lastSequence"], 1)
        lifecycle.close("completed")
        lifecycle.close("completed")
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOSED"):
            lifecycle.reader.poll()
        self.assertTrue(lifecycle.snapshot()["closed"])
        self.assertEqual(lifecycle.snapshot()["closeReason"], "completed")
        self.assertTrue(lifecycle.snapshot()["originRevoked"])

    def test_stop_and_parent_close_revoke_origin_before_reader_close(self):
        lifecycle = self.lifecycle()
        lifecycle.close("stop")
        snapshot = lifecycle.snapshot()
        self.assertTrue(snapshot["closed"])
        self.assertEqual(snapshot["closeReason"], "stop")
        self.assertTrue(snapshot["reader"]["closed"])
        # Reader close is the public terminal code; the registry is already
        # revoked and therefore cannot accept a late projection.
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_CLOSED"):
            lifecycle.reader.poll()
        with self.assertRaisesRegex(bridge.HookProtocolError, "notification_producer_origin_revoked"):
            bridge.BridgeNotificationBinding(lifecycle.registry, lifecycle.origin_id, "late").project(1000)

    def test_bridge_stop_closes_attached_lifecycle(self):
        lifecycle = self.lifecycle()
        binding = bridge.BridgeNotificationBinding.from_lifecycle(lifecycle)
        self.env.notification_system.message_queue.put(message(MessageType.ENVIRONMENT_STOP, "stop", 1000))
        revision, changed, stopped = bridge._drain_notifications(self.env, [], 0, binding=binding)
        self.assertEqual((revision, changed, stopped), (0, False, True))
        self.assertTrue(lifecycle.snapshot()["closed"])
        self.assertEqual(lifecycle.snapshot()["closeReason"], "stop")
        self.assertTrue(lifecycle.snapshot()["reader"]["closed"])

    def test_attached_lifecycle_rejects_a_foreign_environment_clock(self):
        lifecycle = self.lifecycle()
        binding = bridge.BridgeNotificationBinding.from_lifecycle(lifecycle)
        foreign = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        with self.assertRaisesRegex(bridge.HookProtocolError, "notification_lifecycle_clock_mismatch"):
            bridge._drain_notifications(foreign, [], 0, binding=binding)
        lifecycle.close("failed")

    def test_revoke_failure_still_closes_reader_and_lifecycle(self):
        lifecycle = self.lifecycle()
        with patch.object(lifecycle.registry, "revoke_origin",
                          side_effect=NotificationProducerError("injected_revoke_failure")):
            with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_LIFECYCLE_REVOKE_FAILED"):
                lifecycle.close("failed")
        snapshot = lifecycle.snapshot()
        self.assertTrue(snapshot["closed"])
        self.assertTrue(snapshot["reader"]["closed"])

    def test_two_lifecycles_are_scope_isolated_and_prefixes_do_not_collide(self):
        first = self.lifecycle()
        second = self.lifecycle({"requestId": "request-2", "childExecutionId": "child-2", "appId": "Contacts"})
        self.assertNotEqual(first.occurrence_prefix, second.occurrence_prefix)
        self.registry.publish(origin_id=first.origin_id, occurrence_id="first", sequence=1,
                              arrived_at=1000, message=message(MessageType.USER_MESSAGE, "first", 1000))
        self.registry.publish(origin_id=second.origin_id, occurrence_id="second", sequence=1,
                              arrived_at=1000, message=message(MessageType.USER_MESSAGE, "second", 1000))
        self.assertEqual([item.message.message for item in first.reader.poll()], ["first"])
        self.assertEqual([item.message.message for item in second.reader.poll()], ["second"])
        first.close()
        second.close()

    def test_invalid_scope_and_rebind_fail_without_leaking_a_live_origin(self):
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_LIFECYCLE_SCOPE_INVALID"):
            self.lifecycle({"requestId": "", "childExecutionId": "child-x", "appId": "Contacts"})
        lifecycle = self.lifecycle()
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_LIFECYCLE_BINDING_FAILED"):
            self.lifecycle()
        lifecycle.close("failed")

    def test_reader_open_failure_revokes_origin_without_touching_existing_owner(self):
        with patch.object(self.registry, "open_reader",
                          side_effect=NotificationProducerError("injected_reader_failure")):
            with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_LIFECYCLE_BINDING_FAILED"):
                self.lifecycle()
        snapshot = self.registry.snapshot()
        self.assertEqual(snapshot["activeOrigins"], 0)
        self.assertEqual(snapshot["revokedOrigins"], 1)
        self.assertEqual(len(snapshot["bindings"]), 1)
        self.assertFalse(snapshot["bindings"][0]["active"])

    def test_reader_open_failure_does_not_revoke_idempotent_existing_binding(self):
        existing = self.lifecycle()
        with patch.object(self.registry, "open_reader",
                          side_effect=NotificationProducerError("injected_reader_failure")):
            with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_LIFECYCLE_BINDING_FAILED"):
                self.lifecycle()
        snapshot = self.registry.snapshot()
        self.assertEqual(snapshot["activeOrigins"], 1)
        self.assertEqual(snapshot["revokedOrigins"], 0)
        self.assertTrue(snapshot["bindings"][0]["active"])
        existing.close("failed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
