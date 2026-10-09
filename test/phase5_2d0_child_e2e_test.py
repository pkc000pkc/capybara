"""5.2d0 minimum parent -> child -> native -> completion rehearsal.

This is an offline integration seam, not an official Scenario or provider
claim.  The parent bridge drains one real ARE ``MessageQueue`` occurrence into
the scoped projection; the child reads it through its independent reader,
executes one real Contacts read through ``NativeAppBinding``, and then emits
the trusted final-answer completion receipt through the existing fixture
dispatcher.
"""

from datetime import datetime, timezone
import importlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import capybara_official_bridge as bridge
from are.simulation.notification_system import Message, MessageType
from gaia2_deadline_notifications import ScopedArrivedNotificationProjection
from gaia2_notification_producer import ScopedNotificationOriginRegistry


def controlled_action(name: str, arguments: dict) -> str:
    return "Thought: controlled\nAction:\n" + json.dumps(
        {"action": name, "action_input": arguments},
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "<end_action>"


class ChildE2E2d0Tests(unittest.TestCase):
    """One complete trusted local chain with no Scenario/provider/network."""

    def setUp(self):
        # Reuse the established NativeAppBinding fixture without importing its
        # TestCase class at module import time (unittest discovery must not
        # collect the imported parent suite a second time).
        try:
            fixture_module = importlib.import_module("test.phase5_scoped_app_agent_test")
        except ModuleNotFoundError:
            fixture_module = importlib.import_module("phase5_scoped_app_agent_test")
        self._fixture_case = fixture_module.Tests(methodName="runTest")
        self._fixture_case.setUp()
        self.addCleanup(self._fixture_case.doCleanups)

    def test_parent_bridge_child_reader_native_and_completion(self):
        registry = ScopedNotificationOriginRegistry()

        def reader_factory(env, scope):
            projection = ScopedArrivedNotificationProjection(scope_id=scope["requestId"])
            registry.bind_origin(
                origin_id=scope["childExecutionId"],
                scope_id=scope["requestId"],
                child_execution_id=scope["childExecutionId"],
                app_id=scope["appId"],
                projection=projection,
            )
            return registry.open_reader(
                origin_id=scope["childExecutionId"],
                scope_id=scope["requestId"],
                child_execution_id=scope["childExecutionId"],
                app_id=scope["appId"],
                time_manager=env.time_manager,
            )

        runner, owner, app, env, scope, engine, dispatch = self._fixture_case.fixture(
            responses=[
                controlled_action("Contacts__get_current_user_details", {}),
                controlled_action("final_answer", {"answer": "child completed"}),
            ],
            notification_reader_factory=reader_factory,
        )

        binding = bridge.BridgeNotificationBinding(
            registry, scope["childExecutionId"], "2d0-occurrence"
        )
        now = env.time_manager.time()
        env.notification_system.message_queue.put(
            Message(
                MessageType.USER_MESSAGE,
                "parent update before child action",
                datetime.fromtimestamp(now, tz=timezone.utc),
            )
        )
        parent_messages = []
        revision, changed, stopped = bridge._drain_notifications(
            env, parent_messages, 0, binding=binding
        )
        self.assertEqual((revision, changed, stopped), (1, True, False))
        self.assertEqual(len(parent_messages), 1)
        self.assertEqual(parent_messages[0]["notificationSequence"], 1)
        self.assertEqual(env.notification_system.message_queue.list_view(), [])

        self.assertEqual(runner.run(), "child completed")

        # Parent evidence: bridge consumed only the arrived queue item and
        # assigned a distinct occurrence/sequence; child evidence: the reader
        # delivered it exactly once before the first model call.
        snapshot = runner.snapshot()
        self.assertTrue(snapshot["notificationReaderAttached"])
        self.assertFalse(snapshot["notificationSystemAttached"])
        self.assertEqual(snapshot["notificationReader"]["lastSequence"], 1)
        self.assertEqual(len(snapshot["notificationDeliveryReceipts"]), 1)
        self.assertIn(
            "parent update before child action",
            json.dumps(engine.received_messages, ensure_ascii=False),
        )

        # Child-native evidence: one ordinary Contacts read and one final
        # answer both crossed NativeAppBinding, and completion has a verified
        # receipt reference rather than a model-only success claim.
        self.assertEqual(len(dispatch.calls), 2)
        self.assertEqual(dispatch.calls[0]["tool"], "Contacts__get_current_user_details")
        self.assertEqual(dispatch.calls[1]["tool"], "final_answer")
        self.assertEqual([item["status"] for item in dispatch.outcomes], ["succeeded", "succeeded"])
        self.assertTrue(snapshot["completionEvidenceRef"])
        # The final-answer AUI tool is an owner completion receipt, not an
        # App event; only the Contacts read appears in ARE's event log.
        self.assertEqual(len(env.event_log), 1)
        self.assertIs(owner.take_native_result(dispatch.outcomes[0]["dispatchId"]), app.contacts["contact-1"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
