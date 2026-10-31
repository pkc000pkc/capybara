"""Offline tests of the actual Bridge evidence-view and compaction helpers.

No Bridge import, model call, native action or benchmark run is required. AST
loading avoids importing providers while executing production helper bodies.
"""
import ast
import copy
import hashlib
import json
from pathlib import Path
from typing import Any
import unittest


ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "scripts" / "capybara_official_bridge.py"


def stable_hash(value):
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def encoded_hash(value):
    return hashlib.sha256(value).hexdigest()


def serialize(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def production_helpers():
    names = {"_mark_evidence_delivery_views", "_model_wire_bytes", "_compact_tool_result", "_history_groups", "_group_has_verified_observations", "_compact_model_input"}
    tree = ast.parse(BRIDGE.read_text(encoding="utf-8"), filename=str(BRIDGE))
    nodes = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in names]
    class ControlledHookProtocolError(RuntimeError):
        def __init__(self, code):
            super().__init__(code)
            self.code = code
    context = {"Any": Any, "json": json, "hashlib": hashlib, "HookProtocolError": ControlledHookProtocolError,
               "_stable_hash": stable_hash,
               "_MODEL_INPUT_MAX_BYTES": 120000, "_MODEL_INPUT_MAX_MESSAGES": 80, "_COMPACTED_TOOL_RESULT_BYTES": 4096}
    exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(BRIDGE), "exec"), context)
    return context


def fixture(payload=None, *, chunk_bytes=64, delivery_id="delivery-original", receipt_index=0, action_id="native-original"):
    payload = payload if payload is not None else {"rows": [{"id": "item-1", "text": "complete stock data " * 12}]}
    text = serialize(payload)
    data = text.encode("utf-8")
    identity = {"actionId": action_id, "canonicalName": "Warehouse__list_items", "resourceKey": "Warehouse",
                "queryHash": "a" * 64, "resultHash": stable_hash(payload), "observedAt": 100.25, "complete": True}
    frame = {"role": "tool", "tool_call_id": action_id, "content": text,
             "observation": {**identity, "viewComplete": False, "viewIncompleteReason": "hidden"}}
    receipt = {"receiptIndex": receipt_index, "actionId": action_id, "totalBytes": len(data), "resultBytesHash": encoded_hash(data)}
    deliveries = {delivery_id: {"manifest": {"receipts": [receipt]}, "coverage": []}}
    chunks, provider = {}, []
    offset = 0
    while offset < len(data):
        end = min(offset + chunk_bytes, len(data))
        while True:
            try:
                part = data[offset:end].decode("utf-8")
                break
            except UnicodeDecodeError:
                end -= 1
        call_id = "evidence-read-" + str(len(chunks))
        chunk = {"deliveryId": delivery_id, "receiptIndex": receipt_index, "offset": offset, "text": part,
                 "totalBytes": len(data), "resultBytesHash": encoded_hash(data), "chunkHash": encoded_hash(part.encode("utf-8")), **identity}
        chunks[call_id] = chunk
        provider.append({"role": "tool", "tool_call_id": call_id, "content": serialize(chunk)})
        offset = end
    return [frame], deliveries, chunks, provider


def wire_history(provider):
    result = [{"role": "system", "content": "Controlled system"}, {"role": "user", "content": "Inspect evidence."}]
    for message in provider:
        result.extend([{"role": "assistant", "content": "", "tool_calls": [{"id": message["tool_call_id"], "type": "function",
            "function": {"name": "capybara_evidence_read", "arguments": "{}"}}]}, copy.deepcopy(message)])
    return result


class EvidenceDeliveryBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.helpers = production_helpers()

    def mark(self, values):
        return self.helpers["_mark_evidence_delivery_views"](*values)

    def covered(self, deliveries):
        return next(iter(deliveries.values()))["coverage"][0]["covered"]

    def test_complete_exact_provider_chunks_restore_view_not_original_time(self):
        values = fixture()
        frames, deliveries, _, _ = values
        original_content = frames[0]["content"]
        self.assertEqual(self.mark(values), ["native-original"])
        self.assertTrue(frames[0]["observation"]["viewComplete"])
        self.assertNotIn("viewIncompleteReason", frames[0]["observation"])
        self.assertTrue(self.covered(deliveries))
        self.assertEqual(frames[0]["observation"]["observedAt"], 100.25)
        self.assertEqual(frames[0]["content"], original_content)

    def test_partial_delivery_is_not_complete_and_reports_next_missing_byte(self):
        frames, deliveries, chunks, provider = fixture()
        first = chunks[provider[0]["tool_call_id"]]
        self.mark((frames, deliveries, chunks, provider[:1]))
        self.assertFalse(frames[0]["observation"]["viewComplete"])
        coverage = next(iter(deliveries.values()))["coverage"][0]
        self.assertFalse(coverage["covered"])
        self.assertEqual(coverage["nextMissingOffset"], len(first["text"].encode("utf-8")))

    def test_missing_middle_chunk_prevents_gap_from_being_treated_as_coverage(self):
        frames, deliveries, chunks, provider = fixture()
        self.mark((frames, deliveries, chunks, provider[:1] + provider[2:]))
        self.assertFalse(self.covered(deliveries))
        self.assertFalse(frames[0]["observation"]["viewComplete"])

    def test_provider_content_changed_after_read_revokes_previously_complete_view(self):
        values = fixture()
        frames, deliveries, chunks, provider = values
        self.mark(values)
        provider[0]["content"] += " "
        self.assertEqual(self.mark((frames, deliveries, chunks, provider)), ["native-original"])
        self.assertFalse(self.covered(deliveries))
        self.assertFalse(frames[0]["observation"]["viewComplete"])

    def test_bad_chunk_bytes_hash_or_whole_result_hash_cannot_restore_authority(self):
        for field in ("text", "chunkHash", "resultBytesHash"):
            with self.subTest(field=field):
                frames, deliveries, chunks, provider = fixture()
                chunk = next(iter(chunks.values()))
                chunk[field] = chunk[field] + "changed" if field == "text" else "0" * 64
                provider[0]["content"] = serialize(chunk)
                self.mark((frames, deliveries, chunks, provider))
                self.assertFalse(self.covered(deliveries))

    def test_cross_delivery_or_receipt_chunk_cannot_complete_original_receipt(self):
        for field, value in (("deliveryId", "other-delivery"), ("receiptIndex", 1), ("actionId", "other-action")):
            with self.subTest(field=field):
                frames, deliveries, chunks, provider = fixture()
                chunk = next(iter(chunks.values()))
                chunk[field] = value
                provider[0]["content"] = serialize(chunk)
                self.mark((frames, deliveries, chunks, provider))
                self.assertFalse(self.covered(deliveries))

    def test_identical_duplicate_chunk_is_harmless_but_conflicting_duplicate_blocks(self):
        for conflict in (False, True):
            with self.subTest(conflict=conflict):
                frames, deliveries, chunks, provider = fixture()
                duplicate = copy.deepcopy(next(iter(chunks.values())))
                if conflict:
                    duplicate["text"] = "X" + duplicate["text"][1:]
                    duplicate["chunkHash"] = encoded_hash(duplicate["text"].encode("utf-8"))
                chunks["duplicate-call"] = duplicate
                provider.append({"role": "tool", "tool_call_id": "duplicate-call", "content": serialize(duplicate)})
                self.mark((frames, deliveries, chunks, provider))
                self.assertEqual(self.covered(deliveries), not conflict)

    def test_out_of_order_visible_chunks_are_assembled_by_verified_byte_offsets(self):
        frames, deliveries, chunks, provider = fixture()
        self.mark((frames, deliveries, dict(reversed(list(chunks.items()))), list(reversed(provider))))
        self.assertTrue(self.covered(deliveries))
        self.assertTrue(frames[0]["observation"]["viewComplete"])

    def test_unicode_offsets_are_utf8_bytes_not_character_counts(self):
        values = fixture({"rows": ["🙂中文résumé🌱" * 40]}, chunk_bytes=37)
        frames, deliveries, chunks, _ = values
        offsets = [chunk["offset"] for chunk in chunks.values()]
        self.assertNotEqual(offsets[1], len(next(iter(chunks.values()))["text"]))
        self.mark(values)
        self.assertTrue(self.covered(deliveries))
        self.assertTrue(frames[0]["observation"]["viewComplete"])

    def test_every_visible_chunk_must_match_original_native_identity(self):
        for field, bad in (("canonicalName", "Other__read"), ("resourceKey", "Other"), ("queryHash", "b" * 64),
                           ("resultHash", "c" * 64), ("observedAt", 999.0), ("complete", False)):
            with self.subTest(field=field):
                frames, deliveries, chunks, provider = fixture()
                call_id = list(chunks)[1]  # Not the first chunk: every piece must be bound.
                chunks[call_id][field] = bad
                provider[1]["content"] = serialize(chunks[call_id])
                self.mark((frames, deliveries, chunks, provider))
                self.assertFalse(self.covered(deliveries))

    def test_raw_full_native_body_in_same_provider_view_can_restore_visibility(self):
        frames, deliveries, chunks, _ = fixture()
        provider = [{"role": "tool", "tool_call_id": frames[0]["tool_call_id"], "content": frames[0]["content"]}]
        self.mark((frames, deliveries, chunks, provider))
        self.assertTrue(frames[0]["observation"]["viewComplete"])

    def test_actual_compactor_hiding_a_previously_read_chunk_revokes_coverage(self):
        values = fixture(chunk_bytes=64)
        frames, deliveries, chunks, provider = values
        self.mark(values)
        compacted, receipt = self.helpers["_compact_model_input"](wire_history(provider), [], max_messages=8)
        self.assertTrue(receipt["compacted"])
        self.assertTrue(receipt["hiddenToolCallIds"])
        self.mark((frames, deliveries, chunks, compacted))
        self.assertFalse(frames[0]["observation"]["viewComplete"])
        self.assertFalse(self.covered(deliveries))

    def test_latest_complete_page_is_preserved_before_old_history_is_evicted(self):
        page = json.dumps({"contacts": [{"id": f"contact-{index}", "age": index,
                                           "city_living": "Dublin" if index % 2 else "Galway"}
                                          for index in range(80)],
                           "metadata": {"range": [10, 90], "total": 104}},
                          ensure_ascii=False)
        latest_id = "latest-authoritative-page"
        messages = [
            {"role": "system", "content": "Controlled system"},
            {"role": "user", "content": "Compute the requested city/age totals."},
        ]
        for index in range(24):
            call_id = f"old-{index}"
            messages.extend([
                {"role": "assistant", "content": "", "tool_calls": [{"id": call_id, "type": "function",
                    "function": {"name": "Contacts__get_contacts", "arguments": "{}"}}]},
                {"role": "tool", "tool_call_id": call_id, "content": "old observation " + ("x" * 2500)},
            ])
        messages.extend([
            {"role": "assistant", "content": "", "tool_calls": [{"id": latest_id, "type": "function",
                "function": {"name": "Contacts__get_contacts", "arguments": "{\"offset\":10}"}}]},
            {"role": "tool", "tool_call_id": latest_id, "content": page},
        ])
        tools = [{"type": "function", "function": {"name": f"Tool_{index}",
                  "description": "schema " + ("s" * 900), "parameters": {"type": "object"}}}
                 for index in range(55)]
        compacted, receipt = self.helpers["_compact_model_input"](messages, tools)
        self.assertTrue(receipt["compacted"])
        latest = next(item for item in compacted if item.get("role") == "tool" and item.get("tool_call_id") == latest_id)
        self.assertEqual(latest["content"], page)
        self.assertNotIn(latest_id, receipt["truncatedToolCallIds"])
        self.assertTrue(receipt["hiddenToolCallIds"] or receipt["truncatedToolCallIds"])

    def test_single_oversized_unstructured_observation_fails_closed(self):
        messages = [
            {"role": "system", "content": "Controlled system"},
            {"role": "user", "content": "Inspect the result."},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "huge", "type": "function",
                "function": {"name": "Warehouse__read", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "huge", "content": "x" * 200000},
        ]
        with self.assertRaises(self.helpers["HookProtocolError"]) as caught:
            self.helpers["_compact_model_input"](messages, [], max_bytes=120000)
        self.assertEqual(caught.exception.code, "evidence_delivery_capacity_blocked")

    def test_single_oversized_verified_native_observation_is_bounded_and_marked_incomplete(self):
        messages = [
            {"role": "system", "content": "Controlled system"},
            {"role": "user", "content": "Inspect the result."},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "huge-read", "type": "function",
                "function": {"name": "Warehouse__read", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "huge-read", "content": "x" * 200000,
             "observation": {"actionId": "huge-read", "canonicalName": "Warehouse__read",
                             "resourceKey": "Warehouse", "complete": True, "viewComplete": True}},
        ]
        compacted, receipt = self.helpers["_compact_model_input"](messages, [], max_bytes=120000)
        self.assertTrue(receipt["compacted"])
        self.assertIn("huge-read", receipt["truncatedToolCallIds"])
        self.assertIn("latest_observation_bounded", receipt["compactionReason"])
        tool = next(item for item in compacted if item.get("role") == "tool")
        self.assertIn("runtime compaction", tool["content"])
        self.assertLess(len(tool["content"].encode("utf-8")), 5000)

    def test_verified_large_reads_can_share_small_native_error_receipts(self):
        messages = [
            {"role": "system", "content": "Controlled system"},
            {"role": "user", "content": "Inspect the result."},
            {"role": "assistant", "content": "", "tool_calls": [
                {"id": "large-read", "type": "function", "function": {"name": "Warehouse__read", "arguments": "{}"}},
                {"id": "failed-read", "type": "function", "function": {"name": "Chats__read", "arguments": "{}"}},
            ]},
            {"role": "tool", "tool_call_id": "large-read", "content": "x" * 200000,
             "observation": {"actionId": "large-read", "canonicalName": "Warehouse__read",
                             "resourceKey": "Warehouse", "complete": True, "viewComplete": True}},
            {"role": "tool", "tool_call_id": "failed-read", "content": "{\"status\":\"failed_before_execution\",\"error_code\":\"invalid_limit\"}"},
        ]
        compacted, receipt = self.helpers["_compact_model_input"](messages, [], max_bytes=120000)
        self.assertTrue(receipt["compacted"])
        self.assertIn("large-read", receipt["truncatedToolCallIds"])
        self.assertNotIn("failed-read", receipt["truncatedToolCallIds"])

    def test_actual_compactor_truncating_a_chunk_revokes_coverage(self):
        values = fixture({"body": "x" * 16000}, chunk_bytes=20000)
        frames, deliveries, chunks, provider = values
        self.mark(values)
        self.assertTrue(self.covered(deliveries))
        with self.assertRaises(self.helpers["HookProtocolError"]) as caught:
            self.helpers["_compact_model_input"](wire_history(provider), [], max_bytes=7000)
        self.assertEqual(caught.exception.code, "evidence_delivery_capacity_blocked")
        self.assertTrue(self.covered(deliveries))

    def test_one_megabyte_is_deliverable_in_chunks_but_provider_budget_does_not_forge_full_coverage(self):
        values = fixture({"body": "x" * 1048576}, chunk_bytes=2048)
        frames, deliveries, chunks, provider = values
        self.assertGreater(len(chunks), 500)
        self.mark(values)
        self.assertTrue(self.covered(deliveries))
        compacted, receipt = self.helpers["_compact_model_input"](wire_history(provider), [])
        self.assertTrue(receipt["compacted"])
        self.assertLessEqual(receipt["compactedBytes"], 120000)
        self.mark((frames, deliveries, chunks, compacted))
        self.assertFalse(self.covered(deliveries))
        self.assertFalse(frames[0]["observation"]["viewComplete"])
        self.assertEqual(next(iter(deliveries.values()))["coverage"][0]["nextMissingOffset"], 0)

    def test_reference_or_actor_prose_is_never_equivalent_to_exact_local_read_tool_result(self):
        frames, deliveries, chunks, provider = fixture()
        for forged in ([{"role": "assistant", "content": serialize(next(iter(chunks.values())))}],
                       [{"role": "tool", "tool_call_id": "unknown-call", "content": provider[0]["content"]}],
                       [{"role": "tool", "tool_call_id": provider[0]["tool_call_id"], "content": "Evidence exists at delivery-original"}]):
            with self.subTest(provider=forged):
                self.mark((frames, deliveries, chunks, forged))
                self.assertFalse(self.covered(deliveries))
                self.assertFalse(frames[0]["observation"]["viewComplete"])


if __name__ == "__main__":
    unittest.main()
