"""Generic v2 recovery negatives. Network and model calls are forbidden."""
import copy
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gaia2_conflict_recovery import ConflictRecoveryController, ConflictRecoveryError, ConflictInterrupt, ConflictNativeError, native_hash


class EvidenceRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls, self.guards = [], []
        self.body = {"rows": ["a", "b"]}
        self.overrides = {}
        self.action = {"id": "write", "canonicalName": "Catalog__update", "resourceKey": "Catalog", "mutationKey": "a" * 64,
                       "resourceDependencies": ["Stock"]}
        self.plan = {"schemaVersion": "gaia2-conflict-state-v2", "status": "blocked", "userRef": "user",
            "blockedAction": {key: self.action[key] for key in ("id", "canonicalName", "resourceKey", "mutationKey")},
            "blockerIds": ["obs-point", "obs-page"], "requiredResources": ["Catalog", "Stock"],
            "reason": "eligible_bounded_evidence_recovery", "requests": [
                {"mode": mode, "queryTool": tool, "queryArguments": args, "queryHash": digit * 64, "resourceKey": resource,
                 "observationIds": ["obs-" + source], "expectedLatestResultHash": native_hash(self.body),
                 "sourceActionId": source, "sourceObservedAt": 10}
                for mode, tool, args, digit, resource, source in [
                    ("restore_view", "Catalog__get_item", {"id": "a"}, "b", "Catalog", "point"),
                    ("native_read", "Stock__list_items", {"offset": 0, "limit": 2}, "c", "Stock", "page")]]}
        self.core = ConflictRecoveryController(self.temp.name, "exec", "session", self.read, self.guard, self.restore)
        guard = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        guard.start(); self.addCleanup(guard.stop)

    def guard(self):
        return self.guards.pop(0) if self.guards else {"userRef": "user", "stopped": False}

    def receipt(self, query, restore):
        return {"actionId": query["sourceActionId"] if restore else "new-read", "canonicalName": query["queryTool"],
            "resourceKey": query["resourceKey"], "queryHash": query["queryHash"], "resultHash": native_hash(self.body),
            "result": copy.deepcopy(self.body), "observedAt": query["sourceObservedAt"] if restore else 20,
            "complete": True, "viewComplete": True,
            "sourceRef": {"path": "plugin-runtime/000003-before_tool-abcd.json" if restore else "plugin-runtime/000004-after_tool-abcd.json", "sha256": "d" * 64},
            **copy.deepcopy(self.overrides)}

    def read(self, query):
        self.calls.append(("read", query)); return self.receipt(query, False)

    def restore(self, query):
        self.calls.append(("restore", query)); return self.receipt(query, True)

    def run_core(self, call="one"):
        return self.core.run(self.plan, self.action, "user", call)

    def test_mixed_cross_resource_recovery_is_readonly_and_preserves_old_clock(self):
        result = self.run_core()
        self.assertEqual(result["status"], "confirmed")
        self.assertEqual(result["nativeReadCount"], 1)
        self.assertEqual(result["restoredViewCount"], 1)
        self.assertEqual([row["observedAt"] for row in result["observations"]], [10, 20])
        self.assertTrue(all(result[key] is False for key in ("originalWriteExecuted", "permissionGranted", "businessSuccess")))

    def test_same_logical_call_reuses_result_without_callbacks(self):
        first = self.run_core(); self.assertEqual(self.run_core(), first); self.assertEqual(len(self.calls), 2)

    def test_same_evidence_plan_cannot_repeat_with_new_call_id(self):
        self.run_core(); self.assertEqual(self.run_core("two")["status"], "budget_exhausted"); self.assertEqual(len(self.calls), 2)

    def test_restoration_cannot_change_source_time_hash_or_action(self):
        for field, value in [("observedAt", 20), ("actionId", "invented"), ("resultHash", "e" * 64)]:
            with self.subTest(field=field):
                self.overrides = {field: value}
                with self.assertRaises(ConflictRecoveryError):
                    ConflictRecoveryController._receipt(self.receipt(self.plan["requests"][0], True), self.plan["requests"][0])

    def test_partial_coverage_duplicate_blockers_and_unrelated_resource_rejected(self):
        original = copy.deepcopy(self.plan)
        for update in (lambda p: p["blockerIds"].append("obs-missing"),
                       lambda p: p["requests"].append(copy.deepcopy(p["requests"][0])),
                       lambda p: p["requests"][0].update(resourceKey="Elsewhere"),
                       lambda p: p["requests"][0].update(queryTool="Catalog__delete_item"),
                       lambda p: p["requests"][0].update(sourceObservedAt=True)):
            self.plan = copy.deepcopy(original); update(self.plan)
            with self.assertRaises(ConflictRecoveryError): self.run_core()
        self.assertEqual(self.calls, [])

    def test_nine_queries_are_rejected_before_dispatch(self):
        self.plan["requests"] *= 5
        with self.assertRaises(ConflictRecoveryError): self.run_core()
        self.assertEqual(self.calls, [])

    def test_user_update_between_groups_stops_without_native_query(self):
        normal = {"userRef": "user", "stopped": False}
        self.guards = [normal, normal, {"userRef": "new-user", "stopped": False}]
        result = self.run_core()
        self.assertEqual(result["status"], "user_update"); self.assertEqual(result["observations"], [])
        self.assertEqual([kind for kind, _ in self.calls], ["restore"])

    def test_stop_before_first_restore_does_nothing(self):
        self.guards = [{"userRef": "user", "stopped": True}]
        self.assertEqual(self.run_core()["status"], "environment_stop"); self.assertEqual(self.calls, [])

    def test_clipped_or_incomplete_restoration_never_confirms(self):
        self.overrides = {"viewComplete": False}
        result = self.run_core()
        self.assertEqual(result["status"], "incomplete_observation"); self.assertEqual(result["observations"], [])
        self.assertEqual(result["nativeReadCount"], 0)

    def test_oversized_body_is_not_published_as_full_confirmation(self):
        self.body = {"rows": ["x" * 9000]}
        for row in self.plan["requests"]: row["expectedLatestResultHash"] = native_hash(self.body)
        result = self.run_core()
        self.assertEqual(result["status"], "delivery_pending"); self.assertEqual(result["observations"], [])
        self.assertEqual(result["recoveryStatus"], "confirmed")
        self.assertFalse(result["permissionGranted"])
        self.assertIsNotNone(result["evidenceRef"])

    def test_changed_native_evidence_is_not_permission(self):
        def changed(query):
            receipt = self.read(query)
            receipt.update(result={"rows": ["changed"]}, resultHash=native_hash({"rows": ["changed"]}))
            return receipt
        self.core.native_reader = changed
        result = self.run_core()
        self.assertEqual(result["status"], "changed"); self.assertFalse(result["permissionGranted"])

    def test_native_failure_does_not_fall_back_to_write_or_continue(self):
        def failure(query): raise ConflictNativeError("Controlled failure", executed=False)
        self.core.native_reader = failure
        result = self.run_core()
        self.assertEqual(result["status"], "native_error"); self.assertEqual(result["observations"], [])
        self.assertEqual(result["nativeReadCount"], 0)

    def test_missing_restorer_is_explicit_manual_not_native_fallback(self):
        self.core.view_restorer = None
        self.assertEqual(self.run_core()["status"], "manual_required"); self.assertEqual(self.calls, [])


if __name__ == "__main__": unittest.main()
