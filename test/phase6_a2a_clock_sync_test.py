"""Offline clock admission contracts; no provider or native dispatch calls."""

import hashlib
import math
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

from gaia2_a2a_wire import value_hash
from gaia2_official_a2a import (
    A2A_DEADLINE_CLOCK_CONTRACT, OfficialA2AClient, OfficialA2AError,
)


class Clock:
    def __init__(self, now=1000.0):
        self.now = now

    def time(self):
        return self.now


class ClockPeer:
    def __init__(self, *, sync_failure=False, deadline=None):
        self.calls = []
        self.now = None
        self.sync_failure = sync_failure
        self.deadline = deadline

    def call(self, method, payload):
        self.calls.append((method, payload))
        if method == "a2a_sync_clock":
            now = payload["now"]
            if self.sync_failure or self.now is not None and now < self.now:
                raise RuntimeError("controlled_clock_rejection")
            self.now = now
            return {"now": now}
        if self.deadline is not None and self.now >= self.deadline:
            raise RuntimeError("controlled_scope_expired")
        if method == "a2a_before_model":
            context = "controlled dynamic context"
            return {"context": context,
                    "contextHash": hashlib.sha256(context.encode()).hexdigest(),
                    "variablesHash": "f" * 64, "revision": 1,
                    "evidence": {"path": "controlled.json", "sha256": "0" * 64}}
        return {"ok": True}


def client(clock, peer):
    value = object.__new__(OfficialA2AClient)
    scope = {
        "parentExecutionId": "parent-1", "parentSessionId": "session-1",
        "environmentGeneration": "official-parent-1", "appId": "Contacts",
        "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
        "toolInventoryHash": "a" * 64, "taskHash": "b" * 64,
        "parentActionId": "action-1", "requestId": "scope-request-1",
        "childExecutionId": "child-1", "childSessionId": "child-session-1",
        "task": "controlled task", "deadline": 1600.0, "maxNativeActions": 100,
    }
    fields = {
        "scope": scope, "handle_token": "controlled-handle", "peer": peer,
        "env": SimpleNamespace(time_manager=clock), "model_requests": 0,
        "sdk_attempts": 0, "child_model_requests_base": 0,
        "child_sdk_attempts_base": 0, "failure_code": None,
        "failure_callback": None, "closed": False, "child_scope_hashes": [],
        "execution_id": "parent-1", "session_id": "session-1",
        "scenario_id": "controlled-no-scenario", "app": SimpleNamespace(name="Contacts"),
        "excluded_tools": {}, "notification_reader_factory": None,
        "notification_pump_factory": None, "require_notification_pump": False,
        "require_generation_time": False, "deadline_factory": None,
        "guard_receipt": None,
        "owner": SimpleNamespace(excluded_tool_snapshot=lambda: {}),
    }
    for name, field in fields.items():
        setattr(value, "_OfficialA2AClient__" + name, field)
    return value


def gate_input(value, projected_now=-123.0):
    request = {"requestId": "1" * 32, "iteration": 0,
               "messages": [{"role": "user", "content": "controlled input"}],
               "projectedMessages": [{"role": "user", "content": "controlled input",
                                      "id": "message-1", "requestId": "1" * 32}],
               "clock": {"now": projected_now, "revision": 1}}
    model_scope = {"schemaVersion": "capybara-scoped-model-scope-v1",
                   "delegationScopeHash": value_hash(value._OfficialA2AClient__scope),
                   "modelRole": "child_actor", "configHash": "c" * 64,
                   "maxLogicalRequests": 40, "maxSdkAttempts": 240}
    return request, model_scope


def attempt_payload():
    return {"permitId": "2" * 32, "requestId": "1" * 32,
            "attempt": 1, "actualInputHash": "3" * 64}


class A2AClockSyncTests(unittest.TestCase):
    def setUp(self):
        deny = patch.object(socket.socket, "connect",
                            side_effect=AssertionError("network_forbidden"))
        deny.start()
        self.addCleanup(deny.stop)

    def test_model_gate_sync_uses_bound_clock_not_projected_clock(self):
        clock, peer = Clock(1008.5), ClockPeer()
        value = client(clock, peer)
        request, binding = gate_input(value)
        value._model_gate(request, model_scope=binding, model_scope_hash=value_hash(binding))
        self.assertEqual([name for name, _ in peer.calls],
                         ["a2a_sync_clock", "a2a_before_model"])
        self.assertEqual(peer.calls[0][1], {"now": 1008.5})
        # Do not rewrite the Native Hook input as part of synchronizing authority.
        self.assertEqual(peer.calls[1][1]["input"]["clock"], request["clock"])
        self.assertEqual(value._OfficialA2AClient__model_requests, 1)

    def test_attempt_and_finish_refresh_after_trusted_clock_advances(self):
        clock, peer = Clock(1030.0), ClockPeer()
        value = client(clock, peer)
        value._OfficialA2AClient__model_requests = 1
        ack = value._model_attempt(attempt_payload(), model_scope_hash="4" * 64)
        self.assertEqual(ack["sdkAttemptsUsed"], 1)
        clock.now = 1032.25
        value._model_finish({**attempt_payload(), "outputHash": "5" * 64, "usage": None},
                            model_scope_hash="4" * 64)
        self.assertEqual([name for name, _ in peer.calls],
                         ["a2a_sync_clock", "a2a_assert_model",
                          "a2a_sync_clock", "a2a_complete_model"])
        self.assertEqual([data["now"] for name, data in peer.calls if name == "a2a_sync_clock"],
                         [1030.0, 1032.25])
        self.assertEqual(value._OfficialA2AClient__sdk_attempts, 1)

    def test_invalid_clock_prevents_attempt_ack_and_counter(self):
        for now in (math.nan, math.inf, -1.0, True):
            with self.subTest(now_type=type(now).__name__):
                peer = ClockPeer()
                value = client(Clock(now), peer)
                with self.assertRaisesRegex(OfficialA2AError, "^A2A_CLOCK_INVALID$"):
                    value._model_attempt(attempt_payload(), model_scope_hash="4" * 64)
                self.assertEqual(peer.calls, [])
                self.assertEqual(value._OfficialA2AClient__sdk_attempts, 0)

    def test_sync_failure_does_not_consume_logical_admission(self):
        peer = ClockPeer(sync_failure=True)
        value = client(Clock(), peer)
        request, binding = gate_input(value)
        with self.assertRaisesRegex(OfficialA2AError, "^A2A_CLOCK_SYNC_FAILED$"):
            value._model_gate(request, model_scope=binding, model_scope_hash=value_hash(binding))
        self.assertEqual([name for name, _ in peer.calls], ["a2a_sync_clock"])
        self.assertEqual(value._OfficialA2AClient__model_requests, 0)

    def test_sync_failure_does_not_consume_sdk_attempt(self):
        peer = ClockPeer(sync_failure=True)
        value = client(Clock(), peer)
        with self.assertRaisesRegex(OfficialA2AError, "^A2A_CLOCK_SYNC_FAILED$"):
            value._model_attempt(attempt_payload(), model_scope_hash="4" * 64)
        self.assertEqual([name for name, _ in peer.calls], ["a2a_sync_clock"])
        self.assertEqual(value._OfficialA2AClient__sdk_attempts, 0)

    def test_finish_sync_failure_never_sends_completion_ack(self):
        peer = ClockPeer(sync_failure=True)
        value = client(Clock(), peer)
        value._OfficialA2AClient__sdk_attempts = 1
        with self.assertRaisesRegex(OfficialA2AError, "^A2A_CLOCK_SYNC_FAILED$"):
            value._model_finish(attempt_payload(), model_scope_hash="4" * 64)
        self.assertEqual([name for name, _ in peer.calls], ["a2a_sync_clock"])
        self.assertEqual(value._OfficialA2AClient__sdk_attempts, 1)

    def test_clock_advance_past_deadline_is_seen_before_model_ack(self):
        peer = ClockPeer(deadline=1005.0)
        value = client(Clock(1006.0), peer)
        body = Mock(side_effect=AssertionError("provider_forbidden"))
        with self.assertRaisesRegex(OfficialA2AError, "^A2A_MODEL_ATTEMPT_REJECTED$"):
            value._model_attempt(attempt_payload(), model_scope_hash="4" * 64)
            body()
        body.assert_not_called()
        self.assertEqual(peer.now, 1006.0)
        self.assertEqual(value._OfficialA2AClient__sdk_attempts, 0)
        self.assertEqual([name for name, _ in peer.calls],
                         ["a2a_sync_clock", "a2a_assert_model"])

    def test_clock_advance_past_deadline_rejects_gate_without_admitted_count(self):
        peer = ClockPeer(deadline=1005.0)
        value = client(Clock(1006.0), peer)
        request, binding = gate_input(value)
        body = Mock(side_effect=AssertionError("provider_forbidden"))
        with self.assertRaisesRegex(RuntimeError, "^controlled_scope_expired$"):
            value._model_gate(request, model_scope=binding, model_scope_hash=value_hash(binding))
            body()
        body.assert_not_called()
        self.assertEqual(value._OfficialA2AClient__model_requests, 0)
        self.assertEqual(value._OfficialA2AClient__sdk_attempts, 0)
        self.assertEqual([name for name, _ in peer.calls],
                         ["a2a_sync_clock", "a2a_before_model"])

    def test_invalid_ack_does_not_become_admitted_sdk_or_logical_receipt(self):
        class InvalidPeer(ClockPeer):
            def call(self, method, payload):
                result = super().call(method, payload)
                return result if method == "a2a_sync_clock" else {"ok": False}

        peer = InvalidPeer()
        value = client(Clock(), peer)
        with self.assertRaisesRegex(OfficialA2AError, "^A2A_MODEL_ATTEMPT_REJECTED$"):
            value._model_attempt(attempt_payload(), model_scope_hash="4" * 64)
        self.assertEqual(value._OfficialA2AClient__sdk_attempts, 0)
        request, binding = gate_input(value)
        with self.assertRaisesRegex(OfficialA2AError, "^A2A_MODEL_GATE_INVALID$"):
            value._model_gate(request, model_scope=binding, model_scope_hash=value_hash(binding))
        self.assertEqual(value._OfficialA2AClient__model_requests, 0)

    def test_backward_clock_remote_rejection_prevents_sdk_counter(self):
        clock, peer = Clock(1002.0), ClockPeer()
        value = client(clock, peer)
        value.sync_clock()
        clock.now = 1001.0
        with self.assertRaisesRegex(OfficialA2AError, "^A2A_CLOCK_SYNC_FAILED$"):
            value._model_attempt(attempt_payload(), model_scope_hash="4" * 64)
        self.assertEqual(value._OfficialA2AClient__sdk_attempts, 0)
        self.assertNotIn("a2a_assert_model", [name for name, _ in peer.calls])

    def test_snapshot_declares_source_pinned_are_seconds_contract(self):
        value = client(Clock(), ClockPeer())
        before = value_hash(value._OfficialA2AClient__scope)
        snap = value.snapshot()
        self.assertEqual(snap["deadlineClockContract"], A2A_DEADLINE_CLOCK_CONTRACT)
        self.assertEqual(snap["deadlineClockUnit"], "seconds")
        self.assertEqual(A2A_DEADLINE_CLOCK_CONTRACT, "gaia2-official-a2a-clock-v2")
        self.assertEqual(value_hash(value._OfficialA2AClient__scope), before)


if __name__ == "__main__":
    unittest.main()
