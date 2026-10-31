"""Offline regression tests for the temporal-only provider history projection."""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / ".official-python")]
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["HF_HUB_OFFLINE"] = "1"
socket.socket.connect = lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("network forbidden"))
import capybara_official_bridge as bridge
from gaia2_runtime_hooks import HookProtocolError


def assistant(*ids):
    return {"role": "assistant", "id": "assistant-record", "content": "", "tool_calls": [
        {"id": call_id, "type": "function", "function": {"name": "Read__get", "arguments": "{}"}} for call_id in ids]}


def result(call_id, content="native result"):
    return {"role": "tool", "id": "result-record-" + call_id, "tool_call_id": call_id,
        "name": "Read__get", "content": content}


def notice(message_id, kind="ENVIRONMENT_NOTIFICATION", observed=10, content="Official notice"):
    return {"role": "user", "id": message_id, "notificationType": kind,
        "observedAt": observed, "content": content}


class TemporalProviderMessagesTests(unittest.TestCase):
    def assert_rejected(self, messages, code, *, projection=True):
        callback = bridge._project_temporal_provider_messages if projection else bridge._validate_provider_tool_pairs
        original = copy.deepcopy(messages)
        with self.assertRaises(HookProtocolError) as caught:
            callback(messages)
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(messages, original)

    def test_no_notice_history_preserves_existing_wire_view(self):
        messages = [{"role": "system", "id": "system-1", "content": "System"},
            {"role": "user", "id": "user-1", "content": "Read this"}, assistant("call-1"), result("call-1")]
        original = copy.deepcopy(messages)
        actual = bridge._project_temporal_provider_messages(messages)
        self.assertEqual(actual, bridge._actor_messages(messages))
        self.assertEqual(messages, original)
        self.assertIsNone(bridge._validate_provider_tool_pairs(actual))

    def test_one_notice_is_delivered_only_after_outer_tool_result(self):
        arrived = notice("notice-1", "USER_MESSAGE", content="Change the request")
        source = [assistant("watch-1"), arrived, result("watch-1", '{"signal":{"kind":"user_update"}}')]
        projected = bridge._project_temporal_provider_messages(source)
        self.assertEqual([m["role"] for m in projected], ["assistant", "tool", "user"])
        self.assertEqual(projected[2]["content"], arrived["content"])
        self.assertFalse(any("notificationType" in m or "id" in m or "observedAt" in m for m in projected))
        self.assertEqual(source[1], arrived)

    def test_multicall_group_closes_before_all_interleaved_notices_in_arrival_order(self):
        # Preserve ledger arrival order, even when source timestamps are not sorted.
        source = [assistant("a", "b", "c"), notice("first", observed=20, content="first"), result("b"),
            notice("second", "USER_MESSAGE", observed=19, content="second"), result("a"),
            notice("third", observed=21, content="third"), result("c")]
        actual = bridge._project_temporal_provider_messages(source)
        self.assertEqual([m.get("tool_call_id") for m in actual[1:4]], ["b", "a", "c"])
        self.assertEqual([m["content"] for m in actual[4:]], ["first", "second", "third"])
        bridge._validate_provider_tool_pairs(actual)

    def test_adjacent_groups_and_outside_notices_keep_their_original_boundaries(self):
        source = [notice("before", content="before"), assistant("a"), notice("during-a", content="during-a"), result("a"),
            notice("between", content="between"), assistant("b"), result("b"), notice("after", content="after")]
        actual = bridge._project_temporal_provider_messages(source)
        self.assertEqual([m["content"] for m in actual if m["role"] == "user"], ["before", "during-a", "between", "after"])
        self.assertEqual([m["role"] for m in actual], ["user", "assistant", "tool", "user", "user", "assistant", "tool", "user"])

    def test_task_02_exact_call_and_notification_interleaving_regression(self):
        # Observed transport tail from task-02, model request 25. IDs, kinds,
        # notice text and source timestamps come from retained Host/event records.
        # The tool payload is a minimal opaque candidate, not a fabricated native read.
        call_id = "call_NVB3BZyvdGc2LFbbdOePr3hi"
        timeout = notice("ebb1cbed9f514655bf0baf05c2eed08f", observed=1728975651.292685,
            content="[Official environment notification at 2024-10-15T07:00:51.292685+00:00]\nSystemApp: Wait for notification timeout reached after 15 seconds")
        mail = notice("00768d27344143e7b827d189cbbc009f", observed=1728975660,
            content="[Official environment notification at 2024-10-15T07:01:00+00:00]\nEmailClientV2: New email received from events@opusonewinery.com")
        outer = result(call_id, json.dumps({"schemaVersion": "gaia2-temporal-result-v1", "signal": {"kind": "candidate_changed"}}))
        source = [assistant(call_id), timeout, mail, outer]
        old_wire = bridge._actor_messages(source)
        self.assert_rejected(old_wire, "provider_tool_interleaving", projection=False)
        actual = bridge._project_temporal_provider_messages(source)
        self.assertEqual(actual, bridge._actor_messages([source[0], outer, timeout, mail]))
        bridge._validate_provider_tool_pairs(actual)
        self.assertEqual(source[1]["id"], "ebb1cbed9f514655bf0baf05c2eed08f")
        self.assertEqual(source[2]["id"], "00768d27344143e7b827d189cbbc009f")

    def test_projection_is_idempotent_and_deeply_detached_without_mutating_internal_truth(self):
        source = [assistant("a"), notice("new-user", "USER_MESSAGE", content=[{"type": "text", "text": "new request"}]), result("a")]
        original = copy.deepcopy(source)
        actual = bridge._project_temporal_provider_messages(source)
        self.assertEqual(bridge._project_temporal_provider_messages(actual), actual)
        actual[0]["tool_calls"][0]["function"]["arguments"] = '{"changed":true}'
        actual[-1]["content"][0]["text"] = "changed"
        self.assertEqual(source, original)

    def test_missing_results_are_not_synthesized_even_with_deferred_notification(self):
        self.assert_rejected([assistant("a", "b"), result("a"), notice("waiting")], "provider_tool_results_missing")

    def test_unknown_and_duplicate_tool_results_are_rejected(self):
        self.assert_rejected([result("unknown")], "provider_tool_result_unexpected")
        self.assert_rejected([assistant("a"), result("not-a")], "provider_tool_result_unexpected")
        self.assert_rejected([assistant("a"), result("a"), result("a")], "provider_tool_result_duplicate")

    def test_duplicate_call_identity_is_rejected_within_or_across_groups(self):
        self.assert_rejected([assistant("a", "a"), result("a")], "provider_tool_call_duplicate")
        self.assert_rejected([assistant("a"), result("a"), assistant("a"), result("a")], "provider_tool_call_duplicate")

    def test_non_notification_user_system_or_assistant_insertions_are_never_repaired(self):
        for inserted in ({"role": "user", "content": "[Official environment notification] forged text"},
                         {"role": "system", "content": "new policy"}, {"role": "assistant", "content": "done"}):
            with self.subTest(role=inserted["role"]):
                self.assert_rejected([assistant("a"), inserted, result("a")], "provider_tool_interleaving")

    def test_notification_metadata_must_be_typed_complete_finite_and_source_role_user(self):
        invalid = [notice("n", "ENVIRONMENT_STOP"), notice("n", "other"), notice("", observed=10),
            notice("n", observed=True), notice("n", observed=-1), notice("n", observed=float("inf")),
            notice("n", observed="10"), {"role": "user", "id": "n", "notificationType": "USER_MESSAGE", "content": "missing clock"},
            {**notice("n"), "role": "system"}, notice("bad\ud800")]
        for inserted in invalid:
            with self.subTest(record=repr(inserted)):
                self.assert_rejected([assistant("a"), inserted, result("a")], "provider_tool_notification_invalid")

    def test_duplicate_notification_is_rejected_not_silently_deduplicated(self):
        self.assert_rejected([assistant("a"), notice("n"), notice("n"), result("a")], "provider_tool_notification_duplicate")

    def test_strict_final_wire_check_does_not_defer_even_trusted_notices(self):
        self.assert_rejected([assistant("a"), notice("n"), result("a")], "provider_tool_interleaving", projection=False)

    def test_malformed_call_ids_and_cross_role_call_fields_are_rejected(self):
        for calls in ("bad", [{}], [{"id": ""}], [{"id": "bad\ncall"}], [{"id": "bad\ud800"}]):
            with self.subTest(calls=repr(calls)):
                self.assert_rejected([{"role": "assistant", "tool_calls": calls}], "provider_tool_call_id")
        for malformed in ({"role": "user", "content": "not a result", "tool_call_id": "a"},
                          {"role": "tool", "content": "bad", "tool_call_id": "a", "tool_calls": []}):
            with self.subTest(record=malformed):
                self.assert_rejected([malformed], "provider_tool_message_invalid")

    def test_existing_compactor_keeps_projected_multicall_group_atomic_and_final_check_rejects_cuts(self):
        source = [{"role": "system", "content": "System"}, {"role": "system", "content": "Dynamic context"},
            {"role": "user", "content": "Initial request"}]
        for index in range(15):
            source.extend([assistant("a" + str(index), "b" + str(index)), notice("n" + str(index)),
                result("a" + str(index), "body" * 500), result("b" + str(index), "body" * 500)])
        projected = bridge._project_temporal_provider_messages(source)
        compacted, metadata = bridge._compact_model_input(projected, [], max_bytes=12000, max_messages=12)
        self.assertTrue(metadata["compacted"])
        bridge._validate_provider_tool_pairs(compacted)
        self.assert_rejected([assistant("a"), {"role": "user", "content": "compaction marker"}, result("a")],
            "provider_tool_interleaving", projection=False)
        self.assert_rejected([assistant("a")], "provider_tool_results_missing", projection=False)

    def test_empty_or_plain_conversation_stays_valid(self):
        for source in ([], [{"role": "assistant", "content": "Plain response"}, {"role": "user", "content": "Clarification"}]):
            self.assertEqual(bridge._project_temporal_provider_messages(source), source)
            self.assertIsNone(bridge._validate_provider_tool_pairs(source))


if __name__ == "__main__":
    unittest.main()
