"""Offline immutable evidence delivery; no model, native write or network."""
import copy
import hashlib
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gaia2_conflict_recovery import (
    ConflictRecoveryController, ConflictRecoveryError, MAX_DELIVERY_CHUNK_BYTES,
    MAX_RESULT_BYTES, native_hash)


class EvidenceDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.body = {"rows": ["x" * 80_000]}
        self.calls = []
        self.guard_state = {"userRef": "user", "stopped": False}
        self.core = self.controller()
        self.action = {"id": "write", "canonicalName": "Warehouse__update", "resourceKey": "Warehouse",
                       "mutationKey": "a" * 64}
        self.plan = {"schemaVersion": "gaia2-conflict-state-v2", "status": "blocked", "userRef": "user",
                     "blockedAction": copy.deepcopy(self.action), "blockerIds": ["old"],
                     "requiredResources": ["Warehouse"], "reason": "eligible_bounded_evidence_recovery",
                     "requests": [{"mode": "native_read", "queryTool": "Warehouse__list_items",
                                   "queryArguments": {"offset": 0, "limit": 2}, "queryHash": "b" * 64,
                                   "resourceKey": "Warehouse", "observationIds": ["old"],
                                   "expectedLatestResultHash": native_hash(self.body),
                                   "sourceActionId": "old-source", "sourceObservedAt": 10}]}
        network = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        network.start()
        self.addCleanup(network.stop)

    def controller(self, session="session"):
        return ConflictRecoveryController(self.temp.name, "exec", session, self.read,
                                          lambda: copy.deepcopy(self.guard_state), self.restore)

    def receipt(self, query, restore=False):
        return {"actionId": query["sourceActionId"] if restore else "native-" + str(len(self.calls)),
                "canonicalName": query["queryTool"], "resourceKey": query["resourceKey"],
                "queryHash": query["queryHash"], "resultHash": native_hash(self.body),
                "observedAt": query["sourceObservedAt"] if restore else 20,
                "result": copy.deepcopy(self.body), "complete": True, "viewComplete": True,
                "sourceRef": {"path": "plugin-runtime/000003-before_tool-abcd.json" if restore
                              else "plugin-runtime/000004-after_tool-abcd.json", "sha256": "d" * 64}}

    def read(self, query):
        self.calls.append("read")
        return self.receipt(query)

    def restore(self, query):
        self.calls.append("restore")
        return self.receipt(query, True)

    def pending(self, call="one"):
        for query in self.plan["requests"]:
            query["expectedLatestResultHash"] = native_hash(self.body)
        result = self.core.run(self.plan, self.action, "user", call)
        self.assertEqual(result["status"], "delivery_pending")
        self.assertLessEqual(len(json.dumps(result, ensure_ascii=False).encode()), MAX_RESULT_BYTES)
        self.assertEqual(result["observations"], [])
        self.assertTrue(all(result[key] is False for key in
                            ("originalWriteExecuted", "permissionGranted", "businessSuccess")))
        return result

    def collect(self, result, index=0):
        offset, fragments, chunks = 0, [], []
        while offset is not None:
            chunk = self.core.read_delivery(result["deliveryId"], index, offset)
            self.assertLessEqual(len(json.dumps(chunk, ensure_ascii=False).encode()), MAX_DELIVERY_CHUNK_BYTES)
            self.assertEqual(chunk["offset"], offset)
            fragment = chunk["text"].encode("utf-8")
            self.assertGreater(len(fragment), 0)
            self.assertEqual(hashlib.sha256(fragment).hexdigest(), chunk["chunkHash"])
            self.assertFalse(chunk["viewComplete"])
            self.assertTrue(all(chunk[key] is False for key in
                                ("originalWriteExecuted", "permissionGranted", "businessSuccess")))
            if chunk["nextOffset"] is not None:
                self.assertEqual(chunk["nextOffset"], offset + len(fragment))
            fragments.append(fragment)
            chunks.append(chunk)
            offset = chunk["nextOffset"]
        raw = b"".join(fragments)
        self.assertEqual(len(raw), chunks[-1]["totalBytes"])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), chunks[-1]["resultBytesHash"])
        self.assertEqual(json.loads(raw), self.body)
        return chunks

    def test_80kb_is_delivered_without_truncation_or_native_repeat(self):
        result = self.pending()
        self.assertEqual(result["recoveryStatus"], "confirmed")
        self.assertEqual(result["receiptCount"], 1)
        manifest = self.core.get_delivery(result["deliveryId"])
        self.assertEqual(manifest["receipts"], result["delivery"]["receipts"])
        chunks = self.collect(result)
        self.assertGreater(len(chunks[0]["text"].encode()), 2048, "fill the bounded wire budget")
        self.assertEqual(self.calls, ["read"])

    def test_one_megabyte_unicode_and_escaping_roundtrips(self):
        self.body = {"rows": [("汉字😀\"\\\n\t" * 70_000)]}
        self.assertGreater(len(json.dumps(self.body, ensure_ascii=False).encode()), 1_000_000)
        result = self.pending()
        self.collect(result)
        self.assertEqual(self.calls, ["read"])

    def test_utf8_offsets_and_invalid_arguments_are_rejected(self):
        self.body = {"rows": ["😀汉" * 4000]}
        result = self.pending()
        first = self.core.read_delivery(result["deliveryId"], 0, 0)
        raw = json.dumps(self.body, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        middle = raw.index("😀".encode()) + 1
        for index, offset in [(0, middle), (0, -1), (0, len(raw)), (0, True), (True, 0), (-1, 0), (1, 0)]:
            with self.subTest(index=index, offset=offset), self.assertRaises(ConflictRecoveryError):
                self.core.read_delivery(result["deliveryId"], index, offset)
        self.assertEqual(first["observedAt"], 20)

    def test_small_v2_result_stays_inline_and_legacy_v1_stays_oversized(self):
        self.body = {"rows": ["small"]}
        self.plan["requests"][0]["expectedLatestResultHash"] = native_hash(self.body)
        result = self.core.run(self.plan, self.action, "user", "small")
        self.assertEqual(result["status"], "confirmed")
        self.assertNotIn("deliveryId", result)
        legacy = copy.deepcopy(self.plan)
        legacy["schemaVersion"] = "gaia2-conflict-state-v1"
        legacy["reason"] = "eligible_exact_query_confirmation"
        del legacy["requiredResources"]
        for key in ("mode", "sourceActionId", "sourceObservedAt"):
            del legacy["requests"][0][key]
        self.body = {"rows": ["x" * 9000]}
        legacy["requests"][0]["expectedLatestResultHash"] = native_hash(self.body)
        result = self.core.run(legacy, self.action, "user", "legacy")
        self.assertEqual(result["status"], "oversized_observation")

    def test_repeated_logical_call_and_exact_plan_reuse_issued_delivery(self):
        first = self.pending()
        same_call = self.core.run(self.plan, self.action, "user", "one")
        # The Host plan must bind the new action id even though it represents
        # the same mutation and exact evidence plan.
        retry_action = {**self.action, "id": "write-retry"}
        retry_plan = {**copy.deepcopy(self.plan), "blockedAction": retry_action}
        second = self.core.run(retry_plan, retry_action, "user", "two")
        self.assertEqual(first, same_call)
        self.assertEqual(second["deliveryId"], first["deliveryId"])
        self.assertEqual(second["blockedAction"]["id"], "write-retry")
        self.assertEqual(self.calls, ["read"])
        self.collect(second)

    def test_pending_reuse_and_reads_obey_user_and_stop_fences(self):
        first = self.pending()
        self.guard_state = {"userRef": "new-user", "stopped": False}
        with self.assertRaises(ConflictRecoveryError) as caught:
            self.core.read_delivery(first["deliveryId"], 0, 0)
        self.assertEqual(caught.exception.code, "user_update")
        self.assertEqual(self.core.run(self.plan, self.action, "user", "two")["status"], "user_update")
        self.guard_state = {"userRef": "user", "stopped": True}
        with self.assertRaises(ConflictRecoveryError) as caught:
            self.core.get_delivery(first["deliveryId"])
        self.assertEqual(caught.exception.code, "environment_stop")
        self.assertEqual(self.core.run(self.plan, self.action, "user", "one")["status"], "environment_stop")
        self.assertEqual(self.calls, ["read"])

    def test_delivery_survives_restart_but_not_cross_session_or_guessed_id(self):
        first = self.pending()
        self.core = self.controller()
        self.collect(first)
        other = self.controller("another-session")
        for identity in (first["deliveryId"], "0" * 32, "../state.json", "", None):
            with self.subTest(identity=identity), self.assertRaises(ConflictRecoveryError):
                other.read_delivery(identity, 0, 0)
        self.assertEqual(self.calls, ["read"])

    def test_group_and_native_artifact_tampering_are_rejected(self):
        first = self.pending()
        self.core.read_delivery(first["deliveryId"], 0, 0)  # Populate verified-byte cache first.
        group_path = Path(self.temp.name) / first["evidenceRef"]["path"]
        old = group_path.read_bytes()
        group = json.loads(old)
        group_path.write_bytes(old + b" ")
        with self.assertRaises(ConflictRecoveryError) as caught:
            self.core.read_delivery(first["deliveryId"], 0, 0)
        self.assertEqual(caught.exception.code, "source_hash")
        group_path.write_bytes(old)
        native_path = Path(self.temp.name) / group["receipts"][0]["evidenceRef"]["path"]
        native_path.write_bytes(native_path.read_bytes() + b" ")
        with self.assertRaises(ConflictRecoveryError) as caught:
            self.core.read_delivery(first["deliveryId"], 0, 0)
        self.assertEqual(caught.exception.code, "source_hash")

    def test_restoration_retains_original_time_and_changed_native_result_is_not_permission(self):
        self.plan["requests"][0]["mode"] = "restore_view"
        restored = self.pending()
        self.assertEqual(self.core.read_delivery(restored["deliveryId"], 0, 0)["observedAt"], 10)
        self.assertEqual(self.calls, ["restore"])
        self.plan["requests"][0].update(mode="native_read", sourceActionId="later-source", sourceObservedAt=11,
                                       expectedLatestResultHash="c" * 64)
        changed = self.core.run(self.plan, self.action, "user", "changed")
        self.assertEqual(changed["status"], "delivery_pending")
        self.assertEqual(changed["recoveryStatus"], "changed")
        self.assertFalse(changed["permissionGranted"])

    def test_multiple_receipts_manifest_covers_each_original_action(self):
        other = copy.deepcopy(self.plan["requests"][0])
        other.update(mode="restore_view", queryTool="Warehouse__get_item", queryArguments={"id": "a"},
                     queryHash="c" * 64, observationIds=["old-point"], sourceActionId="point-source")
        self.plan["requests"].append(other)
        self.plan["blockerIds"].append("old-point")
        result = self.pending()
        self.assertEqual(result["receiptCount"], 2)
        self.assertEqual([item["actionId"] for item in result["delivery"]["receipts"]],
                         ["native-1", "point-source"])
        self.collect(result, 1)
        self.assertEqual(self.calls, ["read", "restore"])


if __name__ == "__main__":
    unittest.main()
