"""Offline recovery core tests. No ARE, model, Host service or network."""
import copy
import json
import math
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gaia2_conflict_recovery import (ConflictRecoveryController, ConflictRecoveryError,
    ConflictInterrupt, ConflictNativeError, MAX_RESULT_BYTES, canonical_hash, native_hash)


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls, self.guards = [], []
        self.value = {"events": []}
        self.error = None
        self.guard_error = None
        self.receipt_overrides = {}
        self.action = {"id": "blocked-1", "canonicalName": "Calendar__add_calendar_event",
            "mutationKey": native_hash({"title": "meeting"}), "resourceKey": "Calendar", "effect": "write"}
        self.plan = {"schemaVersion": "gaia2-conflict-state-v1", "status": "blocked",
            "userRef": "user-1", "blockedAction": {k: self.action[k] for k in (
                "id", "canonicalName", "mutationKey", "resourceKey")}, "blockerIds": ["obs-old", "obs-new"],
            "requests": [{"queryTool": "Calendar__get_calendar_events_from_to",
                "queryArguments": {"start_datetime": "2024-10-18 00:00:00", "end_datetime": "2024-10-21 00:00:00", "offset": 0, "limit": 100},
                "queryHash": "a" * 64, "resourceKey": "Calendar", "observationIds": ["obs-old", "obs-new"],
                "expectedLatestResultHash": native_hash(self.value)}], "reason": "confirm_latest_once"}
        self.core = self.make_core()
        offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        offline.start()
        self.addCleanup(offline.stop)

    def make_core(self, session="session"):
        return ConflictRecoveryController(self.temp.name, "execution", session, self.native, self.guard)

    def guard(self):
        if self.guard_error:
            raise self.guard_error
        return self.guards.pop(0) if self.guards else {"userRef": "user-1", "stopped": False}

    def native(self, request):
        self.calls.append(copy.deepcopy(request))
        if self.error:
            raise self.error
        return {"result": copy.deepcopy(self.value), "actionId": "fresh-read-" + str(len(self.calls)),
            "canonicalName": request["queryTool"], "resourceKey": request["resourceKey"],
            "queryHash": request["queryHash"], "resultHash": native_hash(self.value),
            "observedAt": 1728975600.5, "complete": True, "viewComplete": True,
            "sourceRef": {"path": "plugin-runtime/000003-after_tool-abcd-1234.json", "sha256": "b" * 64},
            **copy.deepcopy(self.receipt_overrides)}

    def run_core(self, call_id="call-1", **kwargs):
        return self.core.run(kwargs.get("plan", self.plan), kwargs.get("action", self.action),
                             kwargs.get("user_ref", "user-1"), call_id)

    def assert_error(self, code, callback):
        with self.assertRaises(ConflictRecoveryError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_exact_one_query_confirmed_never_grants_write_or_success(self):
        result = self.run_core()
        self.assertEqual(result["status"], "confirmed")
        self.assertEqual(result["nativeReadCount"], 1)
        self.assertEqual(self.calls, self.plan["requests"])
        for flag in ("originalWriteExecuted", "permissionGranted", "businessSuccess"):
            self.assertIs(result[flag], False)
        self.assertEqual(self.core._load_ref(result["evidenceRef"])["receipt"], result["observation"])

    def test_changed_result_returns_to_actor_not_confirmation(self):
        self.value = {"events": ["new authoritative event"]}
        result = self.run_core()
        self.assertEqual(result["status"], "changed")
        self.assertEqual(result["observation"]["result"], self.value)
        self.assertFalse(result["permissionGranted"])

    def test_manual_plan_has_no_native_read(self):
        self.plan.update(requests=[], blockerIds=[], reason="manual_unknown_write")
        result = self.run_core()
        self.assertEqual(result["status"], "manual_required")
        self.assertEqual(result["reason"], "manual_unknown_write")
        self.assertEqual(self.calls, [])

    def test_wrong_user_and_action_bindings_are_rejected(self):
        self.assert_error("plan_binding", lambda: self.run_core(user_ref="different-user"))
        for field in ("id", "canonicalName", "mutationKey", "resourceKey"):
            action = copy.deepcopy(self.action)
            action[field] = "different"
            self.assert_error("action_binding", lambda: self.run_core(action=action))
        self.assertEqual(self.calls, [])

    def test_multiple_queries_are_not_automatically_deduplicated_or_scanned(self):
        self.plan["requests"] *= 2
        self.assert_error("plan", self.run_core)
        self.assertEqual(self.calls, [])

    def test_write_system_aui_delegation_and_local_tools_are_forbidden(self):
        for tool in ("Calendar__delete_calendar_event", "SystemApp__get_current_time",
                     "AgentUserInterface__get_messages", "AppAgent__read_result", "CapybaraTemporal__get_state"):
            with self.subTest(tool=tool):
                self.plan["requests"][0]["queryTool"] = tool
                self.assert_error("query_read_only", self.run_core)
        self.assertEqual(self.calls, [])

    def test_query_scope_hash_and_observation_coverage_are_bound(self):
        original = copy.deepcopy(self.plan)
        for field, value in (("resourceKey", "Other"), ("queryHash", "bad"),
                             ("expectedLatestResultHash", "bad"), ("observationIds", ["obs-new"]),
                             ("observationIds", ["obs-old", "obs-old"])):
            self.plan = copy.deepcopy(original)
            self.plan["requests"][0][field] = value
            self.assert_error("query_binding", self.run_core)

    def test_query_argument_utf8_bound_and_nonfinite_input(self):
        self.plan["requests"][0]["queryArguments"] = {"s": "界" * 1500}
        self.assert_error("query_size", self.run_core)
        self.plan["requests"][0]["queryArguments"] = {"bad": math.nan}
        self.assert_error("plan", self.run_core)
        self.assertEqual(self.calls, [])

    def test_same_hash_but_incomplete_view_is_not_confirmed(self):
        self.receipt_overrides = {"viewComplete": False}
        result = self.run_core()
        self.assertEqual(result["status"], "incomplete_observation")
        self.assertEqual(result["nativeReadCount"], 1)

    def test_old_blocker_is_not_confirmation(self):
        self.receipt_overrides = {"oldBlocker": True}
        self.assertEqual(self.run_core()["status"], "incomplete_observation")

    def test_oversized_result_is_artifact_only_not_clipped_confirmation(self):
        self.value = {"events": ["界" * 5000]}
        self.plan["requests"][0]["expectedLatestResultHash"] = native_hash(self.value)
        result = self.run_core()
        self.assertEqual(result["status"], "oversized_observation")
        self.assertIsNone(result["observation"])
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False).encode()), MAX_RESULT_BYTES)
        self.assertEqual(self.core._load_ref(result["evidenceRef"])["receipt"]["result"], self.value)

    def test_user_update_before_read_stops_without_native(self):
        self.guards = [{"userRef": "user-2", "stopped": False}]
        result = self.run_core()
        self.assertEqual(result["status"], "user_update")
        self.assertEqual(result["nativeReadCount"], 0)
        self.assertEqual(self.calls, [])

    def test_stop_before_dispatch_reservation_stops_without_native(self):
        self.guards = [{"userRef": "user-1", "stopped": False}, {"userRef": "user-1", "stopped": True}]
        result = self.run_core()
        self.assertEqual(result["status"], "environment_stop")
        self.assertEqual(self.calls, [])

    def test_user_update_after_read_retains_evidence_but_not_confirmation(self):
        self.guards = [{"userRef": "user-1", "stopped": False}] * 2 + [{"userRef": "user-2", "stopped": False}]
        result = self.run_core()
        self.assertEqual(result["status"], "user_update")
        self.assertEqual(result["nativeReadCount"], 1)
        self.assertIsNone(result["observation"])
        self.assertIsNotNone(result["evidenceRef"])

    def test_post_ack_arrival_interrupt_does_not_count_blocked_read(self):
        for kind in ("user_update", "environment_stop"):
            with self.subTest(kind=kind):
                core = self.make_core(session=kind)
                self.error = ConflictInterrupt(kind)
                result = core.run(self.plan, self.action, "user-1", "call")
                self.assertEqual(result["status"], kind)
                self.assertEqual(result["nativeReadCount"], 0)

    def test_native_error_is_not_retried_and_does_not_leak_message(self):
        self.error = ConflictNativeError("private endpoint URL", code="native_failed", executed=True)
        result = self.run_core()
        self.assertEqual(result["status"], "native_error")
        self.assertEqual(result["nativeReadCount"], 1)
        self.assertNotIn("endpoint", json.dumps(result))
        self.assertEqual(len(self.calls), 1)

    def test_pre_execution_native_gate_error_is_not_counted(self):
        self.error = ConflictNativeError("native gate blocked", code="native_gate", executed=False)
        self.assertEqual(self.run_core()["nativeReadCount"], 0)

    def test_native_timeout_is_single_failure_not_hidden_retry(self):
        self.error = TimeoutError("no response")
        self.assertEqual(self.run_core()["status"], "native_error")
        self.assertEqual(len(self.calls), 1)

    def test_protocol_error_is_not_swallowed_and_interrupt_does_not_replay(self):
        self.error = RuntimeError("HookProtocolError")
        with self.assertRaisesRegex(RuntimeError, "HookProtocolError"):
            self.run_core()
        self.assert_error("needs_reconcile", self.run_core)
        self.assert_error("needs_reconcile", lambda: self.run_core(call_id="different"))
        self.assertEqual(len(self.calls), 1)

    def test_bad_native_identity_hash_and_time_fail_closed(self):
        for overrides, code in (({"queryHash": "c" * 64}, "source_binding"),
                                ({"canonicalName": "Calendar__other_read"}, "source_binding"),
                                ({"resultHash": "c" * 64}, "source_hash"),
                                ({"observedAt": math.inf}, "source_protocol"),
                                ({"complete": "true"}, "source_protocol"),
                                ({"sourceRef": {"path": "../escape", "sha256": "b" * 64}}, "source_binding")):
            with self.subTest(overrides=overrides):
                core = self.make_core(session=code + str(len(self.calls)))
                self.receipt_overrides = overrides
                self.assert_error(code, lambda: core.run(self.plan, self.action, "user-1", "call"))

    def test_guard_timeout_and_malformed_guard_are_protocol_errors(self):
        self.guard_error = TimeoutError("guard not available")
        self.assert_error("guard_protocol", self.run_core)
        self.assertEqual(self.calls, [])
        self.guard_error = None
        core = self.make_core(session="malformed")
        self.guards = [{"stopped": False}]
        self.assert_error("guard_protocol", lambda: core.run(self.plan, self.action, "user-1", "call"))

    def test_exact_call_replay_after_reload_has_no_native_or_guard(self):
        first = self.run_core()
        reloaded = self.make_core()
        reloaded.guard = lambda: (_ for _ in ()).throw(AssertionError("no guard during exact replay"))
        second = reloaded.run(self.plan, self.action, "user-1", "call-1")
        self.assertEqual(first, second)
        self.assertEqual(len(self.calls), 1)

    def test_same_call_different_payload_is_rejected(self):
        self.run_core()
        self.plan["reason"] = "other reason"
        self.assert_error("call_reuse", self.run_core)

    def test_different_call_id_same_mutation_user_cannot_reset_budget(self):
        self.run_core()
        self.action["id"] = self.plan["blockedAction"]["id"] = "blocked-again"
        result = self.run_core(call_id="new-call")
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertEqual(result["nativeReadCount"], 0)
        self.assertEqual(len(self.calls), 1)

    def test_new_user_version_has_its_own_once_only_budget(self):
        self.run_core()
        self.plan["userRef"] = "user-2"
        self.core.guard = lambda: {"userRef": "user-2", "stopped": False}
        result = self.run_core(call_id="new-user", user_ref="user-2")
        self.assertEqual(result["status"], "confirmed")
        self.assertEqual(len(self.calls), 2)

    def test_session_budget_is_bounded_to_64_mutations(self):
        for index in range(65):
            key = canonical_hash(index)
            self.action["mutationKey"] = self.plan["blockedAction"]["mutationKey"] = key
            result = self.run_core(call_id="call-" + str(index))
        self.assertEqual(result["status"], "budget_exhausted")
        self.assertEqual(len(self.calls), 64)
        self.assertEqual(len(self.core.snapshot()["groups"]), 64)

    def test_result_and_original_artifact_tamper_prevent_replay(self):
        result = self.run_core()
        path = self.core.root / result["evidenceRef"]["path"]
        path.write_bytes(path.read_bytes() + b" ")
        self.assert_error("source_hash", self.run_core)

    def test_cross_session_artifact_is_rejected(self):
        result = self.run_core()
        other = self.make_core(session="other")
        self.assert_error("source_path", lambda: other._load_ref(result["evidenceRef"]))

    def test_ledger_persistence_failure_prevents_native(self):
        with patch("gaia2_conflict_recovery.os.replace", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.run_core()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
