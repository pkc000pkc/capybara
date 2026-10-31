"""Offline core tests: every native action is an injected fake, no network/LLM."""
import copy
import json
import math
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gaia2_temporal import (CANONICAL_NAME, TOOL_NAME, TemporalController,
                            TemporalError, TemporalNativeError, TemporalInterrupt, native_hash, tool_schema,
                            validate_arguments)


class TemporalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.now = 1000.0
        self.waits, self.reads, self.commits = [], [], []
        self.results = [{"messages": []}]
        self.notifications = []
        self.wait_step = None
        self.reader_error = self.waiter_error = None
        self.bad_read = self.bad_wait = None
        self.fail_phase = None
        self.notice_error = self.commit_error = None
        self.clock_values = []
        self.controller = self.make_controller()
        forbidden = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        forbidden.start()
        self.addCleanup(forbidden.stop)

    def make_controller(self):
        return TemporalController(self.temp.name, "execution", "session", self.clock,
                                  self.read, self.wait, self.notices, self.commit)

    def clock(self):
        return self.clock_values.pop(0) if self.clock_values else self.now

    def receipt(self, result=None, **fields):
        result = {"messages": []} if result is None else result
        return {"result": copy.deepcopy(result), "actionId": "baseline",
                "canonicalName": "MessagingApp__get_messages",
                "queryHash": native_hash({"thread_id": "thread-1"}),
                "resultHash": native_hash(result), "observedAt": self.now,
                "complete": True, "viewComplete": True, **fields}

    def read(self, tool, args):
        self.reads.append((tool, copy.deepcopy(args)))
        if self.reader_error:
            raise self.reader_error
        value = self.results.pop(0) if len(self.results) > 1 else self.results[0]
        receipt = self.receipt(value, actionId="read-" + str(len(self.reads)))
        if self.bad_read:
            receipt.update(self.bad_read)
        return receipt

    def wait(self, seconds):
        self.waits.append(seconds)
        if self.waiter_error:
            raise self.waiter_error
        before = self.now
        self.now += seconds if self.wait_step is None else self.wait_step
        receipt = {"actionId": "wait-" + str(len(self.waits)),
            "canonicalName": "SystemApp__wait_for_notification",
            "queryHash": native_hash({"timeout": seconds}), "resultHash": native_hash(None),
            "observedAt": self.now, "complete": True, "viewComplete": True,
            "areBefore": before, "areAfter": self.now}
        if self.bad_wait:
            receipt.update(self.bad_wait)
        return receipt

    def notices(self):
        if self.notice_error:
            raise self.notice_error
        return self.notifications.pop(0) if self.notifications else {
            "userChanged": False, "stopped": False, "notificationIds": []}

    def commit(self, state):
        self.commits.append(copy.deepcopy(state))
        if self.commit_error:
            raise self.commit_error
        return state["phase"] != self.fail_phase

    def args(self, **fields):
        return {"goal": "Wait for a reply; do not cancel anything",
                "queryTool": "MessagingApp__get_messages",
                "queryArguments": {"thread_id": "thread-1"},
                "intervalSeconds": 30, "maxScans": 3, **fields}

    def run_watch(self, **fields):
        return self.controller.run(self.args(**fields), baseline=self.receipt(),
                                   user_ref="user-1", call_id="call-1")

    def assert_signal(self, result, kind):
        self.assertEqual(result["signal"]["kind"], kind)
        self.assertEqual(result["state"]["signal"], result["signal"])
        self.assertEqual(result["state"]["status"], "signaled")
        self.assertEqual(result["taskOutcome"], "undetermined")

    def assert_error(self, code, callback):
        with self.assertRaises(TemporalError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_schema_is_flat_and_bounded(self):
        schema = tool_schema()["function"]
        self.assertEqual(schema["name"], TOOL_NAME)
        self.assertEqual(CANONICAL_NAME, "CapybaraTemporal__watch")
        self.assertFalse(schema["parameters"]["additionalProperties"])
        self.assertEqual(schema["parameters"]["properties"]["maxScans"]["maximum"], 64)

    def test_public_validation_is_pre_admission_and_pure(self):
        validated = validate_arguments(self.args())
        self.assertEqual(validated["baselineRef"], "latest")
        self.assert_error("arguments", lambda: validate_arguments(self.args(until=math.nan)))
        self.assertIsNone(self.controller.snapshot())
        self.assertEqual(self.waits + self.reads + self.commits, [])

    def test_no_baseline_returns_initial_without_waiting(self):
        result = self.controller.run(self.args(), user_ref="u", call_id="initial")
        self.assert_signal(result, "initial_observation")
        self.assertEqual(self.waits, [])
        self.assertEqual(len(self.reads), 1)
        self.assertFalse(result["technicalStop"])
        self.assertEqual(result["observation"]["result"], {"messages": []})

    def test_multiple_unchanged_scans_do_not_return_to_actor(self):
        result = self.run_watch()
        self.assert_signal(result, "scan_budget")
        self.assertEqual(self.waits, [30, 30, 30])
        self.assertEqual(len(self.reads), 3)
        self.assertEqual(result["state"]["scanCount"], 3)
        self.assertEqual(result["state"]["waitCount"], 3)
        self.assertEqual(result["state"]["sceneNow"], 1090)
        self.assertTrue(result["technicalStop"])
        self.assertEqual(len([s for s in self.commits if s["status"] == "signaled"]), 1)
        self.assertEqual(len([s for s in self.commits if s["phase"] == "unchanged"]), 3)

    def test_changed_evidence_wakes_once_and_never_interprets_semantics(self):
        self.results = [{"messages": []}, {"messages": []}, {"messages": ["unrelated spam"]}]
        result = self.run_watch()
        self.assert_signal(result, "candidate_changed")
        self.assertFalse(result["technicalStop"])
        self.assertEqual(result["observation"]["result"]["messages"], ["unrelated spam"])
        self.assertEqual(self.waits, [30, 30, 30])
        self.assertEqual(result["state"]["baselineHash"], native_hash({"messages": []}))

    def test_no_raw_poll_bodies_in_snapshot(self):
        self.results = [{"messages": ["unique-current-body"]}]
        result = self.run_watch()
        self.assertNotIn("unique-current-body", json.dumps(result["state"]))
        self.assertEqual(json.dumps(result).count("unique-current-body"), 1)
        self.assertEqual(result["state"]["lastEvidenceRef"]["actionId"], "read-1")

    def test_all_native_originals_are_independent_hashed_artifacts(self):
        result = self.run_watch()
        evidence = list(self.controller.directory.glob("watch-*.json"))
        self.assertEqual(len(evidence), 8)  # baseline, 3 waits, 3 reads, final result
        for ref in result["state"]["waitRefs"]:
            artifact = self.controller._load_ref(ref["sourceRef"])
            self.assertEqual(artifact["receipt"]["actionId"], ref["actionId"])
        artifact = self.controller._load_ref(result["evidenceRef"])
        self.assertEqual(artifact["kind"], "scan")
        self.assertEqual(artifact["receipt"], result["observation"])

    def test_defaults_are_applied(self):
        self.results = [{"messages": ["new"]}]
        args = self.args()
        del args["intervalSeconds"], args["maxScans"]
        result = self.controller.run(args, baseline=self.receipt())
        self.assertEqual(result["state"]["intervalSeconds"], 30)
        self.assertEqual(result["state"]["maxScans"], 12)
        self.assertEqual(result["state"]["baselineRef"], "latest")

    def test_invalid_arguments_before_native_actions(self):
        for fields in ({"unknown": 1}, {"intervalSeconds": 0}, {"intervalSeconds": True},
                       {"intervalSeconds": 3601}, {"maxScans": 0}, {"maxScans": 65},
                       {"maxScans": 1.0}, {"until": math.inf}, {"until": math.nan},
                       {"until": -1}, {"until": True}, {"queryTool": "not-canonical"},
                       {"goal": " "}, {"queryArguments": []}, {"baselineRef": ""},
                       {"queryArguments": {"bad": math.nan}}):
            with self.subTest(fields=fields):
                self.assert_error("arguments", lambda: self.controller.run(self.args(**fields)))
        self.assertEqual(self.reads + self.waits + self.commits, [])

    def test_user_update_before_wait(self):
        self.notifications = [{"userChanged": True, "stopped": False, "notificationIds": ["u2"]}]
        result = self.run_watch()
        self.assert_signal(result, "user_update")
        self.assertEqual(self.waits + self.reads, [])
        self.assertFalse(result["technicalStop"])

    def test_environment_stop_after_wait_prevents_scan(self):
        empty = {"userChanged": False, "stopped": False, "notificationIds": []}
        self.notifications = [empty, empty, {"userChanged": False, "stopped": True, "notificationIds": []}]
        result = self.run_watch()
        self.assert_signal(result, "environment_stop")
        self.assertEqual(self.waits, [30])
        self.assertEqual(self.reads, [])

    def test_user_arriving_during_wait_admission_prevents_native_wait(self):
        admission_attempts = []

        def guarded_wait(seconds):
            admission_attempts.append(seconds)
            # Simulates the bridge draining a USER arrival after before_tool ACK.
            raise TemporalInterrupt("user_update")

        self.controller.native_waiter = guarded_wait
        result = self.run_watch()
        self.assert_signal(result, "user_update")
        self.assertFalse(result["technicalStop"])
        self.assertEqual(admission_attempts, [30])
        self.assertEqual(self.waits + self.reads, [])
        self.assertEqual(result["state"]["waitCount"], 0)
        self.assertEqual(result["state"]["scanCount"], 0)
        self.assertEqual(result["state"]["waitRefs"], [])
        self.assertEqual(self.now, 1000)

    def test_stop_arriving_during_read_admission_prevents_native_read(self):
        admission_attempts = []

        def guarded_read(tool, arguments):
            admission_attempts.append((tool, copy.deepcopy(arguments)))
            # No baseline: this initial read must also respect the post-ACK fence.
            raise TemporalInterrupt("environment_stop")

        self.controller.native_reader = guarded_read
        result = self.controller.run(self.args(), user_ref="user-1", call_id="stopped-in-admission")
        self.assert_signal(result, "environment_stop")
        self.assertEqual(len(admission_attempts), 1)
        self.assertEqual(self.waits + self.reads, [])
        self.assertEqual(result["state"]["waitCount"], 0)
        self.assertEqual(result["state"]["scanCount"], 0)
        self.assertIsNone(result["state"]["lastEvidenceRef"])
        self.assertIsNone(result["observation"])
        self.assertEqual(self.now, 1000)

    def test_user_update_during_read_wins_over_candidate(self):
        empty = {"userChanged": False, "stopped": False, "notificationIds": []}
        self.notifications = [empty, empty, empty, {"userChanged": True, "stopped": False, "notificationIds": ["u2"]}]
        self.results = [{"messages": ["new"]}]
        result = self.run_watch()
        self.assert_signal(result, "user_update")
        self.assertEqual(result["observation"]["result"], {"messages": ["new"]})

    def test_ordinary_notifications_never_wake_actor(self):
        self.notifications = [{"userChanged": False, "stopped": False, "notificationIds": ["timeout", "spam"]}] * 12
        result = self.run_watch()
        self.assert_signal(result, "scan_budget")
        self.assertEqual(result["state"]["notificationIds"], ["timeout", "spam"])

    def test_deadline_already_reached(self):
        result = self.run_watch(until=1000)
        self.assert_signal(result, "deadline")
        self.assertEqual(self.waits, [])
        self.assertEqual(len(self.reads), 1)
        self.assertEqual(result["observation"]["observedAt"], 1000)
        self.assertFalse(result["technicalStop"])

    def test_deadline_caps_wait_and_no_post_deadline_scan(self):
        result = self.run_watch(until=1045)
        self.assert_signal(result, "deadline")
        self.assertEqual(self.waits, [30, 15])
        self.assertEqual(len(self.reads), 2)
        self.assertEqual(result["state"]["sceneNow"], 1045)

    def test_subsecond_deadline_does_not_create_zero_wait_or_fake_expiry(self):
        result = self.run_watch(until=1000.5)
        self.assert_signal(result, "deadline_approaching")
        self.assertLess(result["state"]["sceneNow"], result["state"]["deadline"])
        self.assertEqual(self.waits + self.reads, [])
        self.assertFalse(result["technicalStop"])

    def test_early_wait_notification_still_scans_and_continues(self):
        self.wait_step = 5
        result = self.run_watch()
        self.assert_signal(result, "scan_budget")
        self.assertEqual(result["state"]["sceneNow"], 1015)
        self.assertEqual(len(self.waits), 3)

    def test_wait_without_scene_progress_recovers_until_scan_budget(self):
        self.wait_step = 0
        result = self.run_watch()
        self.assert_signal(result, "scan_budget")
        self.assertEqual(len(self.waits), 3)
        self.assertEqual(len(self.reads), 3)

    def test_fractional_wait_scene_receipt_reconciles_from_authoritative_clock(self):
        self.now = 1000.8
        self.wait_step = 0.5
        self.bad_wait = {"areBefore": 1000.9, "areAfter": 1000.6}
        result = self.run_watch(maxScans=1)
        self.assert_signal(result, "scan_budget")
        self.assertEqual(result["state"]["waitCount"], 1)
        wait_artifact = next(self.controller._load_ref(ref["sourceRef"])
                             for ref in result["state"]["waitRefs"])
        self.assertTrue(wait_artifact["sceneReceiptReconciled"])
        self.assertEqual(wait_artifact["receipt"]["rawAreAfter"], 1000.6)
        self.assertEqual(wait_artifact["receipt"]["areAfter"], 1001.3)

    def test_fractional_wait_observed_at_uses_reconciled_interval(self):
        """An integer ARE receipt below a fractional pre-sample is not a protocol failure."""
        self.wait_step = 10
        self.bad_wait = {"areBefore": 1010.4, "areAfter": 1010.0}
        result = self.run_watch(maxScans=1)
        self.assert_signal(result, "scan_budget")
        self.assertEqual(result["state"]["waitCount"], 1)
        wait_artifact = next(self.controller._load_ref(ref["sourceRef"])
                             for ref in result["state"]["waitRefs"])
        self.assertTrue(wait_artifact["sceneReceiptReconciled"])
        self.assertEqual(wait_artifact["receipt"]["observedAt"], 1010.0)
        self.assertEqual(wait_artifact["receipt"]["rawAreAfter"], 1010.0)

    def test_wait_scene_receipt_may_be_before_latest_clock_sample(self):
        self.wait_step = 4
        self.bad_wait = {"areBefore": 1000.1, "areAfter": 1003.5}
        self.results = [{"messages": ["new"]}]
        result = self.run_watch()
        self.assert_signal(result, "candidate_changed")

    def test_invalid_wait_receipt_time_fails_closed(self):
        for fields in ({"areBefore": 999}, {"areAfter": 999}, {"areAfter": math.inf},
                       {"areAfter": 2000}):
            with self.subTest(fields=fields):
                self.setUp()
                self.bad_wait = fields
                result = self.run_watch()
                self.assert_signal(result, "clock_error")
                self.assertEqual(self.reads, [])

    def test_invalid_initial_clock_does_not_invent_scene_start(self):
        self.clock_values = [math.nan]
        self.assert_error("clock_error", self.run_watch)
        self.assertIsNone(self.controller.snapshot())
        self.assertEqual(self.waits + self.reads + self.commits, [])

    def test_clock_regression_during_loop_wakes_with_last_valid_clock(self):
        self.clock_values = [1000, 999]
        result = self.run_watch()
        self.assert_signal(result, "clock_error")
        self.assertEqual(result["state"]["sceneNow"], 1000)
        self.assertEqual(self.waits + self.reads, [])

    def test_incomplete_baseline_does_not_wait(self):
        result = self.controller.run(self.args(), baseline=self.receipt(viewComplete=False))
        self.assert_signal(result, "incomplete_observation")
        self.assertEqual(self.waits + self.reads, [])

    def test_incomplete_scan_wakes_instead_of_hash_comparison(self):
        self.bad_read = {"complete": False}
        result = self.run_watch()
        self.assert_signal(result, "incomplete_observation")
        self.assertEqual(len(self.waits), 1)

    def test_old_blocker_is_not_cleared_by_wait(self):
        result = self.controller.run(self.args(), baseline=self.receipt(oldBlocker=True))
        self.assert_signal(result, "incomplete_observation")
        self.assertEqual(self.waits + self.reads, [])

    def test_native_read_timeout_is_technical_signal_and_not_retried(self):
        self.reader_error = TimeoutError("do not leak endpoint details")
        result = self.run_watch()
        self.assert_signal(result, "native_error")
        self.assertTrue(result["technicalStop"])
        self.assertEqual(len(self.reads), 1)
        self.assertNotIn("endpoint", json.dumps(result))

    def test_explicit_native_wait_failure_is_signal(self):
        self.waiter_error = TemporalNativeError("gateway failed", "tool_failed")
        result = self.run_watch()
        self.assert_signal(result, "native_error")
        self.assertEqual(result["signal"]["detail"], "tool_failed")
        self.assertEqual(self.reads, [])

    def test_unknown_native_protocol_exception_is_not_swallowed(self):
        self.reader_error = RuntimeError("HookProtocolError")
        baseline = self.receipt()
        invoke = lambda: self.controller.run(self.args(), baseline=baseline, user_ref="u", call_id="protocol")
        with self.assertRaisesRegex(RuntimeError, "HookProtocolError"):
            invoke()
        self.assert_error("needs_reconcile", invoke)
        self.assertEqual(len(self.reads), 1)

    def test_host_rejects_registration_before_any_native_call(self):
        self.fail_phase = "registered"
        self.assert_error("commit_failed", self.run_watch)
        self.assertEqual(self.waits + self.reads, [])
        self.assert_error("needs_reconcile", self.run_watch)

    def test_host_rejects_wait_return_before_scan(self):
        self.fail_phase = "wait_returned"
        self.assert_error("commit_failed", self.run_watch)
        self.assertEqual(self.waits, [30])
        self.assertEqual(self.reads, [])

    def test_host_timeout_cannot_be_misclassified_as_native_failure(self):
        self.commit_error = TimeoutError("ACK timed out")
        self.assert_error("commit_failed", self.run_watch)
        self.assertEqual(self.waits + self.reads, [])

    def test_notification_timeout_is_protocol_not_native_error(self):
        self.notice_error = TimeoutError("notification service timed out")
        self.assert_error("notification_protocol", self.run_watch)
        self.assertEqual(self.waits + self.reads, [])

    def test_broken_hash_and_wrong_tool_are_protocol_failures(self):
        for fields, code in (({"resultHash": "0" * 64}, "source_hash"),
                             ({"canonicalName": "OtherApp__list"}, "source_binding"),
                             ({"queryHash": "1" * 64}, "source_binding"),
                             ({"observedAt": 2000}, "source_protocol")):
            with self.subTest(fields=fields):
                self.setUp()
                self.bad_read = fields
                self.assert_error(code, self.run_watch)

    def test_exact_call_retry_reuses_durable_result_without_native_calls(self):
        baseline = self.receipt()
        result = self.controller.run(self.args(), baseline=baseline, user_ref="u", call_id="same")
        calls = (len(self.reads), len(self.waits), len(self.commits))
        reloaded = self.make_controller()
        repeated = reloaded.run(self.args(), baseline=baseline, user_ref="u", call_id="same")
        self.assertEqual(repeated, result)
        self.assertEqual((len(self.reads), len(self.waits), len(self.commits)), calls)

    def test_changed_input_with_same_call_id_is_rejected(self):
        baseline = self.receipt()
        self.controller.run(self.args(), baseline=baseline, call_id="same")
        self.assert_error("call_reuse", lambda: self.controller.run(self.args(goal="other"), baseline=baseline, call_id="same"))

    def test_artifact_tamper_prevents_replay(self):
        baseline = self.receipt()
        self.controller.run(self.args(), baseline=baseline, call_id="same")
        ref = self.controller._ledger["calls"]["same"]["resultRef"]
        path = self.controller.root / ref["path"]
        original = path.read_bytes()
        # This test deliberately tampers with its disposable fixture evidence.
        path.write_bytes(original + b" ")
        self.assert_error("source_hash", lambda: self.make_controller().run(self.args(), baseline=baseline, call_id="same"))

    def test_session_evidence_is_isolated(self):
        result = self.run_watch()
        other = TemporalController(self.temp.name, "execution", "other-session", self.clock,
                                   self.read, self.wait, self.notices)
        self.assert_error("source_path", lambda: other._load_ref(result["evidenceRef"]))

    def test_maximum_scan_count_and_refs_are_bounded(self):
        result = self.run_watch(maxScans=64, intervalSeconds=1)
        self.assert_signal(result, "scan_budget")
        self.assertEqual(len(result["state"]["waitRefs"]), 64)
        self.assertEqual(result["state"]["scanCount"], 64)

    def test_new_watch_after_signal_uses_new_identity(self):
        first = self.run_watch(maxScans=1)
        second = self.controller.run(self.args(maxScans=1), baseline=self.receipt(), call_id="next")
        self.assertNotEqual(first["watchId"], second["watchId"])
        self.assertEqual(second["state"]["scanCount"], 1)


if __name__ == "__main__":
    unittest.main()
