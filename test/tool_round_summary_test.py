"""Offline advisory batch summary: no scheduler RPC, native tools or model."""
import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gaia2_tool_round import ToolRoundAdapter


def adapter(calls=None):
    return ToolRoundAdapter(None, "round-fixture", calls or [
        ("first", "Calendar__delete_calendar_event", '{"event_id":"kept-id"}'),
        ("second", "Calendar__delete_calendar_event", '{"event_id":"bad-id"}'),
        ("third", "Calendar__delete_calendar_event", '{"event_id":"tail-id"}')], [], lambda *_: None, defer_begin=True)


def message(identity, status, *, name="Calendar__delete_calendar_event", executed=True, body=None, **extra):
    return {"role": "tool", "tool_call_id": identity, "name": name,
        "content": json.dumps(body if body is not None else {"arbitrary": "native business data"}),
        "executionOutcome": {"status": status, "executed": executed, "complete": status != "unknown", **extra}}


class ToolRoundSummaryTests(unittest.TestCase):
    def test_actual_success_native_failure_and_unexecuted_tail_are_separate(self):
        summary = adapter().result_summary([
            message("first", "succeeded"),
            message("second", "failed_before_execution", errorCode="entity_not_found", argumentName="event_id"),
            message("third", "cancelled", executed=False)])
        self.assertEqual(summary["counts"], dict(succeeded=1, failed=1, unknown=0, not_executed=1, unsettled=0))
        self.assertEqual([node["callId"] for node in summary["nodes"]], ["first", "second", "third"])
        self.assertEqual([node["invoked"] for node in summary["nodes"]], [True, True, False])
        self.assertEqual([node["effectApplied"] for node in summary["nodes"]], [None, False, False])
        self.assertEqual(summary["nodes"][1]["errorCode"], "entity_not_found")
        self.assertEqual(summary["nodes"][1]["argumentName"], "event_id")
        self.assertEqual(summary["nodes"][2]["argumentRefs"], {"event_id": "tail-id"})
        self.assertFalse(summary["automaticReplay"])
        self.assertEqual(summary["businessCompletion"], "not_inferred")

    def test_original_order_does_not_depend_on_message_arrival_order(self):
        summary = adapter().result_summary([message("third", "blocked", executed=False),
            message("first", "succeeded"), message("second", "unknown")])
        self.assertEqual([node["status"] for node in summary["nodes"]], ["succeeded", "unknown", "not_executed"])

    def test_business_status_claims_cannot_change_true_execution_outcome(self):
        summary = adapter().result_summary([
            message("first", "succeeded", body={"status": "failed", "executed": False}),
            message("second", "unknown", body={"status": "succeeded", "effectApplied": True}),
            message("third", "cancelled", executed=False, body={"status": "succeeded"})])
        self.assertEqual([node["status"] for node in summary["nodes"]], ["succeeded", "unknown", "not_executed"])
        self.assertIsNone(summary["nodes"][1]["effectApplied"])

    def test_missing_trusted_metadata_is_unsettled_even_with_scheduler_success(self):
        value = adapter()
        value.state = {"nodes": [{"status": "succeeded"}] * 3, "status": "completed"}
        summary = value.result_summary([
            {"role": "tool", "tool_call_id": "first", "name": "Calendar__delete_calendar_event",
             "content": '{"status":"succeeded","executed":true}'}])
        self.assertEqual(summary["counts"]["unsettled"], 3)
        self.assertTrue(all(row["invoked"] is None for row in summary["nodes"]))

    def test_duplicate_results_never_pick_an_arbitrary_winner(self):
        result = message("first", "succeeded")
        summary = adapter().result_summary([result, copy.deepcopy(result)])
        self.assertEqual(summary["nodes"][0]["status"], "unsettled")
        self.assertEqual(summary["nodes"][0]["diagnostic"], "duplicate_tool_results")

    def test_unknown_inflight_after_ack_loss_is_not_labelled_unexecuted(self):
        value = adapter()
        value.rpc_failed = True
        value.state = {"status": "cancelled", "nodes": [{"status": "cancelled"}] * 3}
        summary = value.result_summary([message("first", "unknown", executed=None),
            message("second", "cancelled", executed=False), message("third", "cancelled", executed=False)])
        self.assertEqual(summary["counts"]["unknown"], 1)
        self.assertEqual(summary["counts"]["not_executed"], 2)
        self.assertIsNone(summary["nodes"][0]["invoked"])
        self.assertIsNone(summary["nodes"][0]["effectApplied"])

    def test_actual_result_survives_a_lost_settle_ack_or_after_hook_failure(self):
        value = adapter()
        value.rpc_failed = True
        value.state = {"nodes": [{"status": "unknown"}, {"status": "cancelled"}, {"status": "cancelled"}]}
        summary = value.result_summary([message("first", "succeeded", effectApplied=True),
            message("second", "cancelled", executed=False), message("third", "cancelled", executed=False)])
        self.assertEqual(summary["nodes"][0]["status"], "succeeded")
        self.assertTrue(summary["nodes"][0]["effectApplied"])

    def test_unsettled_current_result_without_local_metadata_cannot_be_fabricated(self):
        value = adapter()
        value.inflight = {"id": "first"}
        value.rpc_failed = True
        summary = value.result_summary([])
        self.assertEqual(summary["counts"]["unsettled"], 3)
        self.assertEqual(summary["counts"]["not_executed"], 0)

    def test_only_exact_tool_identity_can_supply_outcome(self):
        rows = [message("first", "succeeded", name="Other__delete"),
            {"role": "user", "tool_call_id": "second", "name": "Calendar__delete_calendar_event",
             "executionOutcome": {"status": "succeeded", "executed": True}}]
        self.assertEqual(adapter().result_summary(rows)["counts"]["unsettled"], 3)

    def test_malformed_metadata_is_only_diagnostic_not_a_runtime_failure(self):
        for bad in (None, [], {"status": ["succeeded"]}, {"status": "succeeded", "executed": 1},
                    {"status": "succeeded", "executed": True, "complete": "yes"},
                    {"status": "succeeded", "executed": True, "effectApplied": "true"}):
            with self.subTest(bad=bad):
                row = message("first", "succeeded")
                row["executionOutcome"] = bad
                self.assertEqual(adapter().result_summary([row])["nodes"][0]["status"], "unsettled")

    def test_summary_preserves_messages_calls_and_scheduler_state(self):
        value = adapter()
        messages = [message("first", "succeeded")]
        before = copy.deepcopy((messages, value.calls, value.state))
        first, second = value.result_summary(messages), value.result_summary(messages)
        self.assertEqual(first, second)
        self.assertEqual((messages, value.calls, value.state), before)

    def test_contradictory_execution_facts_are_not_relabelled_as_safe_non_execution(self):
        for status, executed in (("failed_before_execution", True), ("cancelled", False),
                                 ("blocked", True), ("succeeded", False)):
            with self.subTest(status=status, executed=executed):
                summary = adapter().result_summary([message("first", status, executed=executed, effectApplied=True)])
                node = summary["nodes"][0]
                self.assertEqual(node["status"], "unsettled")
                self.assertIsNone(node["effectApplied"])
                self.assertIsNone(node["invoked"])

    def test_reference_allowlist_excludes_business_content_paths_and_secrets(self):
        args = {"event_id": "exact-opaque-id", "contact_id": "姓名🙂", "id": 42,
            "content": "TOP_SECRET_CONTENT", "api_key": "TOP_SECRET_KEY", "path": "TOP_SECRET_PATH",
            "access_token_id": "TOP_SECRET_TOKEN", "authorization": "TOP_SECRET_AUTH", "subject": "TOP_SECRET_SUBJECT"}
        value = adapter([("one", "Calendar__delete_calendar_event", json.dumps(args, ensure_ascii=False))])
        summary = value.result_summary([message("one", "succeeded")])
        self.assertEqual(summary["nodes"][0]["argumentRefs"], {"contact_id": "姓名🙂", "event_id": "exact-opaque-id", "id": 42})
        self.assertNotIn("TOP_SECRET", json.dumps(summary))

    def test_long_identifier_is_omitted_never_silently_truncated(self):
        identifier = "long-" + "x" * 300
        value = adapter([("one", "Calendar__delete_calendar_event", json.dumps({"event_id": identifier}))])
        summary = value.result_summary([message("one", "succeeded")])
        self.assertNotIn("argumentRefs", summary["nodes"][0])
        self.assertNotIn(identifier[:30], json.dumps(summary))

    def test_malformed_duplicate_and_nonfinite_args_do_not_leak_or_raise(self):
        for args in ('{"event_id":"one","event_id":"two"}', '{"id":NaN}', '[1,2]', "{broken"):
            with self.subTest(args=args):
                summary = adapter([("one", "Calendar__delete_calendar_event", args)]).result_summary([message("one", "succeeded")])
                self.assertNotIn("argumentRefs", summary["nodes"][0])

    def test_untrusted_reason_text_is_never_copied(self):
        summary = adapter().result_summary([message("first", "failed", errorCode="SECRET with whitespace", argumentName="token://SECRET")])
        self.assertNotIn("SECRET", json.dumps(summary))

    def test_large_batch_counts_every_node_and_prioritizes_failure_and_tail(self):
        calls = [("call-" + str(index), "Calendar__delete_calendar_event", json.dumps({"event_id": "id-" + str(index)})) for index in range(64)]
        rows = [message(identity, "succeeded") for identity, _, _ in calls[:62]]
        rows.extend([message("call-62", "failed_before_execution"), message("call-63", "cancelled", executed=False)])
        summary = adapter(calls).result_summary(rows)
        self.assertEqual(summary["totalCalls"], 64)
        self.assertEqual(summary["counts"], dict(succeeded=62, failed=1, unknown=0, not_executed=1, unsettled=0))
        self.assertTrue(summary["truncated"])
        self.assertGreater(summary["omittedNodes"], 0)
        self.assertIn(62, [row["ordinal"] for row in summary["nodes"]])
        self.assertIn(63, [row["ordinal"] for row in summary["nodes"]])
        self.assertEqual([row["ordinal"] for row in summary["nodes"]], sorted(row["ordinal"] for row in summary["nodes"]))
        self.assertLessEqual(len(json.dumps(summary, ensure_ascii=False, separators=(",", ":")).encode()), 8192)
        self.assertLessEqual(len(json.dumps(summary, ensure_ascii=False).encode()), 8192)

    def test_utf8_size_limit_applies_to_32_and_64_failure_rows(self):
        for length in (32, 64):
            calls = [("调用🙂-" + str(index), "Calendar__delete_calendar_event", json.dumps({"event_id": "日程🙂" * 10 + str(index)}, ensure_ascii=False)) for index in range(length)]
            rows = [message(identity, "failed_before_execution") for identity, _, _ in calls]
            summary = adapter(calls).result_summary(rows)
            self.assertEqual(summary["counts"]["failed"], length)
            self.assertEqual(len(summary["nodes"]) + summary["omittedNodes"], length)
            self.assertLessEqual(len(json.dumps(summary, ensure_ascii=False, separators=(",", ":")).encode()), 8192)
            self.assertLessEqual(len(json.dumps(summary, ensure_ascii=False).encode()), 8192)

    def test_binary_invalid_unicode_and_non_list_history_are_conservative(self):
        self.assertEqual(adapter().result_summary(None)["counts"]["unsettled"], 3)
        value = adapter([("\ud800", "Calendar__delete_calendar_event", '{"event_id":"\\ud800"}')])
        summary = value.result_summary([])
        self.assertIsNone(summary["nodes"][0]["callId"])
        self.assertNotIn("argumentRefs", summary["nodes"][0])
        json.dumps(summary, ensure_ascii=False).encode("utf-8")


if __name__ == "__main__":
    unittest.main(verbosity=2)
