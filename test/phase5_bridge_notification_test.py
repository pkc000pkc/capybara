"""Opt-in parent-owned notification bridge wiring tests."""

from datetime import datetime, timezone
from pathlib import Path
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
from gaia2_deadline_notifications import ScopedArrivedNotificationProjection
from gaia2_notification_producer import (
    NotificationReaderError,
    ScopedNotificationOriginRegistry,
)
from gaia2_runtime_hooks import HookProtocolError


def message(kind: MessageType, text: str, second: float) -> Message:
    return Message(kind, text, datetime.fromtimestamp(second, tz=timezone.utc))


class BridgeNotificationTests(unittest.TestCase):
    def environment(self) -> Environment:
        env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        env.state = EnvironmentState.RUNNING
        return env

    def binding(self):
        registry = ScopedNotificationOriginRegistry()
        projection = ScopedArrivedNotificationProjection(scope_id="request-1")
        registry.bind_origin(origin_id="origin-1", scope_id="request-1",
                             child_execution_id="child-1", app_id="Contacts",
                             projection=projection)
        return bridge.BridgeNotificationBinding(registry, "origin-1", "run-occurrence"), registry

    def test_default_path_keeps_historical_message_shape(self):
        env = self.environment()
        env.notification_system.message_queue.put(message(MessageType.USER_MESSAGE, "hello", 1000))
        messages = []
        revision, changed, stopped = bridge._drain_notifications(env, messages, 0)
        self.assertEqual((revision, changed, stopped), (1, True, False))
        self.assertEqual(messages[0]["content"], "hello")
        self.assertNotIn("notificationId", messages[0])
        self.assertEqual(env.notification_system.message_queue.list_view(), [])

    def test_opt_in_path_assigns_scoped_occurrences_and_sequences(self):
        env = self.environment()
        binding, registry = self.binding()
        reader = registry.open_reader(origin_id="origin-1", scope_id="request-1",
                                      child_execution_id="child-1", app_id="Contacts",
                                      time_manager=env.time_manager)
        env.notification_system.message_queue.put(message(MessageType.USER_MESSAGE, "same", 1000))
        env.notification_system.message_queue.put(message(MessageType.USER_MESSAGE, "same", 1000))
        messages = []
        revision, changed, stopped = bridge._drain_notifications(env, messages, 0, binding=binding)
        self.assertEqual((revision, changed, stopped), (2, True, False))
        self.assertEqual([item["notificationSequence"] for item in messages], [1, 2])
        self.assertEqual([item["notificationId"] for item in messages],
                         ["run-occurrence:1", "run-occurrence:2"])
        self.assertEqual(binding.next_sequence, 3)
        self.assertEqual(registry.snapshot()["bindings"][0]["occurrenceCount"], 2)
        self.assertEqual([item.notification_id for item in reader.poll()],
                         ["run-occurrence:1", "run-occurrence:2"])
        self.assertEqual(reader.poll(), ())
        with self.assertRaises(AttributeError):
            binding.origin_id = "foreign-origin"

    def test_future_message_remains_hidden_until_official_clock_arrives(self):
        env = self.environment()
        binding, _ = self.binding()
        env.notification_system.message_queue.put(message(MessageType.USER_MESSAGE, "future", 1010))
        messages = []
        revision, changed, stopped = bridge._drain_notifications(env, messages, 0, binding=binding)
        self.assertEqual((revision, changed, stopped), (0, False, False))
        self.assertEqual(len(env.notification_system.message_queue.list_view()), 1)
        env.time_manager.add_offset(10)
        revision, changed, stopped = bridge._drain_notifications(env, messages, revision, binding=binding)
        self.assertEqual((revision, changed, stopped), (1, True, False))
        self.assertGreaterEqual(messages[0]["observedAt"], 1010.0)
        self.assertLess(messages[0]["observedAt"], 1011.0)

    def test_stop_flushes_arrived_normal_records_then_revokes_origin(self):
        env = self.environment()
        binding, registry = self.binding()
        reader = registry.open_reader(origin_id="origin-1", scope_id="request-1",
                                      child_execution_id="child-1", app_id="Contacts",
                                      time_manager=env.time_manager)
        env.notification_system.message_queue.put(message(MessageType.USER_MESSAGE, "before stop", 1000))
        env.notification_system.message_queue.put(message(MessageType.ENVIRONMENT_STOP, "stop", 1001))
        messages = []
        revision, changed, stopped = bridge._drain_notifications(env, messages, 0, binding=binding)
        self.assertEqual((revision, changed, stopped), (1, True, False))
        env.time_manager.add_offset(1)
        revision, changed, stopped = bridge._drain_notifications(env, messages, revision, binding=binding)
        self.assertEqual((revision, changed, stopped), (1, False, True))
        self.assertEqual(registry.snapshot()["revokedOrigins"], 1)
        env.notification_system.message_queue.put(message(MessageType.USER_MESSAGE, "late", 1002))
        env.time_manager.add_offset(1)
        with self.assertRaisesRegex(HookProtocolError, "notification_producer_origin_revoked"):
            bridge._drain_notifications(env, messages, revision, binding=binding)
        with self.assertRaisesRegex(NotificationReaderError, "NOTIFICATION_READER_ORIGIN_REVOKED"):
            reader.poll()

    def test_factory_is_trusted_once_and_never_actor_selected(self):
        binding, _ = self.binding()
        with patch.object(bridge, "_notification_binding_factory", None), \
             patch.object(bridge, "_notification_binding_configured", False):
            bridge.configure_notification_bridge(lambda env, scenario_id: binding)
            self.assertIs(bridge._notification_binding_for_run(object(), "scenario-1"), binding)
            with self.assertRaisesRegex(HookProtocolError, "notification_factory_reconfiguration"):
                bridge.configure_notification_bridge(lambda env, scenario_id: binding)

    def test_factory_fail_closed_on_invalid_binding_or_exception(self):
        with patch.object(bridge, "_notification_binding_factory", lambda env, scenario_id: object()):
            with self.assertRaisesRegex(HookProtocolError, "invalid_notification_binding"):
                bridge._notification_binding_for_run(object(), "scenario-1")
        with patch.object(bridge, "_notification_binding_factory", lambda env, scenario_id: 1 / 0):
            with self.assertRaisesRegex(HookProtocolError, "notification_binding_factory_failed"):
                bridge._notification_binding_for_run(object(), "scenario-1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
