"""Trusted callback stubs only: no models, ARE actions, sockets or real tasks."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from gaia2_task_contract import TaskContractError, TaskContractRuntime, native_hash, task_contract_hash


def proposal(source, *, mode="monitor_until", resolution="obligations", policy="allow", duration=100):
    return {"schemaVersion": "gaia2-task-contract-proposal-v1", "sourceHash": source["sourceHash"],
        "resolution": resolution, "notificationPolicy": policy, "revocations": [],
        "obligations": [] if resolution != "obligations" else [{"span": {"start": 0, "end": len(source["text"]), "text": source["text"]},
            "mode": mode, "goal": "Inspect genuine native evidence until the requested condition or deadline",
            "timeBasis": {"kind": "relative", "durationSeconds": duration}, "recipe": None}]}


def approved(source, value):
    return {"schemaVersion": "gaia2-task-contract-review-v1", "sourceHash": source["sourceHash"],
        "proposalHash": task_contract_hash(value), "decision": "approved", "notificationVerified": True,
        "obligationChecks": [{"index": index, "spanVerified": True, "modeVerified": True, "timeVerified": True} for index in range(len(value["obligations"]))],
        "revocationChecks": [{"index": index, "explicitRevocation": True} for index in range(len(value["revocations"]))], "reason": "Independent test reviewer validated the exact source."}


RECIPE = {"queryTool": "Contacts__get_contacts", "queryArguments": {"offset": 0}, "queryHash": "b" * 64, "intervalSeconds": 10, "maxScans": 10}


def evidence(at=110, action="native-read-1", recipe=None):
    recipe = recipe or RECIPE
    result = {"contacts": [], "metadata": {"total": 0, "range": [0, 0]}}
    return {"actionId": action, "canonicalName": recipe["queryTool"], "queryHash": recipe["queryHash"],
        "result": result, "resultHash": native_hash(result), "observedAt": at, "complete": True, "viewComplete": True}


class TaskContractTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="task-contract-unit-")
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def runtime(self, extractor=proposal, reviewer=approved, **kwargs):
        return TaskContractRuntime(self.root, "execution", "session", extractor, reviewer, **kwargs)

    def registered(self, **kwargs):
        runtime = self.runtime(**kwargs)
        runtime.resolve_user("user-1", "Monitor for one hundred seconds", 100)
        identity = runtime.snapshot()["obligations"][0]["id"]
        runtime.bind_recipe(identity, RECIPE)
        return runtime, identity

    def signal(self, runtime, identity, kind="candidate_changed", at=110, call="watch-1", native=None, counts=None):
        return runtime.note_signal(identity, kind, native if native is not None else evidence(at), at, call,
            counts or {"nativeWaits": 1, "nativeScans": 1})

    def test_no_sources_cannot_silently_finish(self):
        self.assertFalse(self.runtime().finish_decision(100)["allowed"])

    def test_independently_reviewed_no_wait_can_finish(self):
        runtime = self.runtime(lambda source: proposal(source, resolution="none"))
        runtime.resolve_user("user-1", "List my contacts", 100)
        self.assertEqual(runtime.snapshot()["sources"][0]["resolution"], "reviewed_none")
        self.assertTrue(runtime.finish_decision(100)["notificationAllowed"])

    def test_no_wait_without_independent_review_fails_closed(self):
        runtime = self.runtime(lambda source: proposal(source, resolution="none"), lambda *_: {"decision": "approved"})
        runtime.resolve_user("user-1", "List my contacts", 100)
        self.assertFalse(runtime.finish_decision(100)["allowed"])
        self.assertEqual(runtime.snapshot()["sources"][0]["resolution"], "ambiguous")

    def test_extractor_exception_is_not_no_wait(self):
        def broken(_source):
            raise RuntimeError("sensitive provider body must not be recorded")
        runtime = self.runtime(broken)
        runtime.resolve_user("user-1", "Wait", 100)
        self.assertEqual(runtime.snapshot()["sources"][0]["reason"], "trusted_resolver_failed")
        self.assertFalse(runtime.finish_decision(100)["allowed"])

    def test_ambiguous_model_output_remains_blocked(self):
        runtime = self.runtime(lambda source: proposal(source, resolution="ambiguous"))
        runtime.resolve_user("user-1", "Maybe later", 100)
        self.assertFalse(runtime.finish_decision(100)["allowed"])

    def test_unicode_codepoints_and_utf8_source_hash(self):
        runtime = self.runtime()
        value = "等🙂一百秒"
        runtime.resolve_user("user-1", value, 100)
        state = runtime.snapshot()
        self.assertEqual(state["sources"][0]["sourceHash"], hashlib.sha256(value.encode("utf-8")).hexdigest())
        self.assertEqual(state["obligations"][0]["span"]["end"], len(value))

    def test_invalid_exact_span_is_ambiguous(self):
        def changed(source):
            value = proposal(source)
            value["obligations"][0]["span"]["text"] = "different"
            return value
        runtime = self.runtime(changed)
        runtime.resolve_user("user-1", "Wait one hundred seconds", 100)
        self.assertEqual(runtime.snapshot()["sources"][0]["reason"], "source_span")

    def test_reviewer_must_bind_exact_proposal_hash(self):
        def wrong(source, value):
            result = approved(source, value)
            result["proposalHash"] = "a" * 64
            return result
        runtime = self.runtime(reviewer=wrong)
        runtime.resolve_user("user-1", "Wait", 100)
        self.assertFalse(runtime.finish_decision(100)["allowed"])

    def test_each_obligation_time_and_notification_need_review(self):
        for missing in ("notificationVerified", "obligationChecks"):
            with self.subTest(missing=missing):
                temporary = self.root / missing
                def reviewer(source, value):
                    result = approved(source, value); result.pop(missing)
                    return result
                runtime = TaskContractRuntime(temporary, "execution", "session", proposal, reviewer)
                runtime.resolve_user("user-1", "Wait", 100)
                self.assertFalse(runtime.finish_decision(100)["allowed"])

    def test_relative_deadline_keeps_original_user_anchor(self):
        runtime, identity = self.registered()
        self.signal(runtime, identity)
        runtime.review_event(identity, "native-read-1", "continue", "Candidate reviewed; continue monitoring", 111)
        self.signal(runtime, identity, at=150, call="watch-2", native=evidence(150, "native-read-2"))
        self.assertEqual(runtime.snapshot()["obligations"][0]["deadline"], 200)

    def test_scan_budget_keeps_window_active_for_next_watch(self):
        runtime, identity = self.registered()
        runtime.note_signal(identity, "scan_budget", None, 130, "watch-budget",
                            {"nativeWaits": 3, "nativeScans": 3})
        item = runtime.snapshot()["obligations"][0]
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["lastSignal"], "scan_budget")
        self.assertFalse(runtime.finish_decision(130)["allowed"])
        self.signal(runtime, identity, at=150, call="watch-next", native=evidence(150, "native-read-next"))
        self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "pending")

    def test_same_source_replay_is_idempotent_not_a_new_deadline(self):
        runtime, identity = self.registered()
        runtime.resolve_user("user-1", "Monitor for one hundred seconds", 100)
        self.assertEqual(len(runtime.snapshot()["obligations"]), 1)
        self.assertEqual(runtime.snapshot()["obligations"][0]["id"], identity)
        with self.assertRaises(TaskContractError):
            runtime.resolve_user("user-1", "Monitor for one hundred seconds", 150)

    def test_new_ordinary_user_does_not_cancel_existing_obligation(self):
        runtime = self.runtime(lambda source: proposal(source, resolution="none" if source["userRef"] == "user-2" else "obligations"))
        runtime.resolve_user("user-1", "Monitor", 100)
        runtime.resolve_user("user-2", "Also remember my name", 120)
        self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "pending")
        self.assertEqual(runtime.snapshot()["obligations"][0]["deadline"], 200)
        self.assertFalse(runtime.finish_decision(130)["allowed"])

    def test_explicit_new_user_reviewed_revocation_only(self):
        identity = None
        def extract(source):
            result = proposal(source, resolution="none" if source["userRef"] == "user-2" else "obligations")
            if source["userRef"] == "user-2":
                result["revocations"] = [{"obligationId": identity, "span": {"start": 0, "end": len(source["text"]), "text": source["text"]}}]
            return result
        runtime = self.runtime(extract)
        runtime.resolve_user("user-1", "Monitor", 100)
        identity = runtime.snapshot()["obligations"][0]["id"]
        runtime.resolve_user("user-2", "Cancel the previous monitoring request", 120)
        self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "revoked")
        self.assertTrue(runtime.finish_decision(120)["allowed"])

    def test_absolute_time_is_reviewed_and_structurally_bounded(self):
        def extract(source):
            result = proposal(source)
            result["obligations"][0]["timeBasis"] = {"kind": "absolute", "deadline": 220}
            return result
        runtime = self.runtime(extract)
        runtime.resolve_user("user-1", "Monitor until 220", 100)
        self.assertEqual(runtime.snapshot()["obligations"][0]["deadline"], 220)

    def test_bad_time_values_fail_closed(self):
        for value in (True, -1, 0, float("nan"), 999999999):
            with self.subTest(value=value):
                runtime = TaskContractRuntime(self.root / str(value), "execution", "session", lambda source: proposal(source, duration=value), approved)
                runtime.resolve_user("user-1", "Wait", 100)
                self.assertEqual(runtime.snapshot()["sources"][0]["resolution"], "ambiguous")

    def test_actor_cannot_inject_recipe_via_proposal(self):
        def extract(source):
            result = proposal(source); result["obligations"][0]["recipe"] = RECIPE
            return result
        runtime = self.runtime(extract)
        runtime.resolve_user("user-1", "Wait", 100)
        self.assertFalse(runtime.finish_decision(100)["allowed"])

    def test_candidate_initial_timeout_do_not_complete_monitor(self):
        for index, kind in enumerate(("candidate_changed", "initial_observation", "timeout")):
            runtime = TaskContractRuntime(self.root / kind, "execution", "session", proposal, approved)
            runtime.resolve_user("user-1", "Monitor", 100)
            identity = runtime.snapshot()["obligations"][0]["id"]
            runtime.bind_recipe(identity, RECIPE)
            self.signal(runtime, identity, kind=kind)
            self.assertFalse(runtime.finish_decision(110)["allowed"])
            self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "pending")

    def test_monitor_cannot_condition_complete_before_deadline(self):
        runtime, identity = self.registered()
        self.signal(runtime, identity)
        with self.assertRaises(TaskContractError):
            runtime.review_event(identity, "native-read-1", "condition_satisfied", "Candidate arrived", 111)
        self.assertFalse(runtime.finish_decision(112)["allowed"])

    def test_elapsed_time_without_final_evidence_is_not_satisfied(self):
        runtime, identity = self.registered()
        self.signal(runtime, identity)
        with self.assertRaises(TaskContractError):
            runtime.review_event(identity, "native-read-1", "deadline_reviewed", "Old evidence is not enough", 201)
        self.assertEqual(runtime.finish_decision(201)["pendingObligationIds"], [identity])

    def test_monitor_requires_complete_same_query_after_deadline_and_explicit_review(self):
        runtime, identity = self.registered()
        self.signal(runtime, identity, kind="deadline", at=201, native=evidence(200.5))
        self.assertFalse(runtime.finish_decision(201)["allowed"])
        runtime.review_event(identity, "native-read-1", "deadline_reviewed", "Final complete native evidence reviewed", 202)
        self.assertTrue(runtime.finish_decision(202)["allowed"])

    def test_condition_once_needs_explicit_matching_current_evidence_review(self):
        runtime, identity = self.registered(extractor=lambda source: proposal(source, mode="condition_once"))
        self.signal(runtime, identity)
        runtime.review_event(identity, "native-read-1", "condition_satisfied", "Visible candidate meets the user's condition", 111)
        self.assertTrue(runtime.finish_decision(111)["allowed"])
        self.assertEqual(runtime.snapshot()["obligations"][0]["completionReason"], "condition_satisfied")

    def test_condition_once_timeout_settles_wait_without_claiming_condition_success(self):
        runtime, identity = self.registered(extractor=lambda source: proposal(source, mode="condition_once"))
        self.signal(runtime, identity, kind="deadline", at=201, native=evidence(201))
        runtime.review_event(identity, "native-read-1", "deadline_reviewed", "Window elapsed; no candidate met the condition", 202)
        self.assertEqual(runtime.snapshot()["obligations"][0]["lastSignal"], "deadline")
        self.assertEqual(runtime.snapshot()["obligations"][0]["completionReason"], "deadline_reviewed")
        self.assertTrue(runtime.finish_decision(202)["allowed"])
        event_reviews = [json.loads(path.read_text(encoding="utf-8")) for path in runtime.directory.glob("event-review-*.json")]
        self.assertEqual(event_reviews[0]["decision"], "deadline_reviewed")
        self.assertNotIn("businessSuccess", runtime.snapshot())

    def test_wrong_action_id_cannot_review_current_native_evidence(self):
        runtime, identity = self.registered()
        self.signal(runtime, identity)
        with self.assertRaises(TaskContractError):
            runtime.review_event(identity, "fake", "continue", "Wrong observation", 111)

    def test_query_hash_is_root_bound_not_recomputed_from_canonical_alias(self):
        runtime, identity = self.registered()
        value = evidence()
        self.assertNotEqual(value["queryHash"], native_hash({"tool": RECIPE["queryTool"], "arguments": RECIPE["queryArguments"]}))
        self.signal(runtime, identity, native=value)
        self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "pending")

    def test_incomplete_tampered_or_wrong_query_native_evidence_blocks(self):
        for field, value in (("complete", False), ("viewComplete", False), ("resultHash", "x" * 64), ("queryHash", "c" * 64), ("observedAt", 120)):
            with self.subTest(field=field):
                runtime = TaskContractRuntime(self.root / field, "execution", "session", proposal, approved)
                runtime.resolve_user("user-1", "Monitor", 100)
                identity = runtime.snapshot()["obligations"][0]["id"]; runtime.bind_recipe(identity, RECIPE)
                native = evidence(); native[field] = value
                with self.assertRaises(TaskContractError):
                    self.signal(runtime, identity, native=native)
                self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "technical_blocked")

    def test_cross_watch_budget_not_reset_by_new_call_id(self):
        runtime, identity = self.registered(max_watch_calls=1)
        self.signal(runtime, identity)
        self.signal(runtime, identity, at=120, call="watch-2", native=evidence(120, "native-read-2"))
        item = runtime.snapshot()["obligations"][0]
        self.assertEqual(item["counts"]["watchCalls"], 2)
        self.assertEqual(item["status"], "technical_blocked")
        self.assertFalse(runtime.finish_decision(200)["allowed"])

    def test_same_call_id_cannot_increment_budget_or_change_evidence(self):
        runtime, identity = self.registered()
        self.signal(runtime, identity); self.signal(runtime, identity)
        self.assertEqual(runtime.snapshot()["obligations"][0]["counts"]["watchCalls"], 1)
        with self.assertRaises(TaskContractError):
            self.signal(runtime, identity, kind="initial_observation")

    def test_user_update_interrupts_watch_not_its_original_obligation(self):
        runtime, identity = self.registered()
        runtime.note_signal(identity, "user_update", None, 120, "watch-user", {"nativeWaits": 1, "nativeScans": 0})
        self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "pending")
        self.assertEqual(runtime.snapshot()["obligations"][0]["deadline"], 200)
        self.signal(runtime, identity, at=130, call="watch-next", native=evidence(130))
        self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "pending")

    def test_global_user_update_fence_is_not_an_obligation_revocation(self):
        runtime, identity = self.registered()
        runtime.interrupt("user_update")
        self.assertIsNone(runtime.snapshot()["interruption"])
        self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "pending")
        self.signal(runtime, identity, at=130, call="watch-next", native=evidence(130))
        self.assertEqual(runtime.snapshot()["obligations"][0]["deadline"], 200)

    def test_stop_cancel_budget_and_clock_are_not_success(self):
        for reason in ("environment_stop", "cancelled", "budget_exhausted", "clock_error"):
            runtime = TaskContractRuntime(self.root / reason, "execution", "session", proposal, approved)
            runtime.resolve_user("user-1", "Monitor", 100)
            runtime.interrupt(reason)
            self.assertFalse(runtime.finish_decision(500)["allowed"])
            self.assertNotEqual(runtime.snapshot()["obligations"][0]["status"], "satisfied")

    def test_finally_interrupt_preserves_prior_technical_reason_with_mixed_unfinished_rows(self):
        def two(source):
            value = proposal(source)
            value["obligations"].append(copy.deepcopy(value["obligations"][0]))
            return value
        runtime = self.runtime(two)
        runtime.resolve_user("user-1", "Monitor both sources", 100)
        first, second = runtime.snapshot()["obligations"]
        runtime.note_signal(first["id"], "native_error", None, 110, "watch-failed", {"nativeWaits": 1, "nativeScans": 0})
        runtime.interrupt("cancelled")
        state = runtime.snapshot()
        self.assertEqual((state["obligations"][0]["status"], state["obligations"][0]["lastSignal"]), ("technical_blocked", "native_error"))
        self.assertEqual((state["obligations"][1]["status"], state["obligations"][1]["lastSignal"]), ("interrupted", "cancelled"))
        runtime.interrupt("environment_stop")
        self.assertEqual(runtime.snapshot()["interruption"], "cancelled")
        self.assertEqual(runtime.snapshot()["obligations"], state["obligations"])

    def test_clock_rollback_permanently_blocks_unfinished_contract(self):
        runtime, identity = self.registered()
        runtime.advance(120)
        with self.assertRaises(TaskContractError):
            runtime.advance(119)
        self.assertEqual(runtime.snapshot()["obligations"][0]["status"], "technical_blocked")
        self.assertFalse(runtime.finish_decision(200)["allowed"])

    def test_notification_forbid_independent_of_no_wait_finish(self):
        runtime = self.runtime(lambda source: proposal(source, resolution="none", policy="forbid"))
        runtime.resolve_user("user-1", "Do not send me a notification", 100)
        decision = runtime.finish_decision(100)
        self.assertTrue(decision["allowed"])
        self.assertFalse(decision["notificationAllowed"])
        self.assertEqual(decision["notificationBlockers"], ["user-1"])

    def test_legacy_forbid_is_scoped_to_aui_channel(self):
        runtime = self.runtime(lambda source: proposal(source, resolution="none", policy="forbid"))
        runtime.resolve_user("user-1", "Do not send me a notification", 100)
        self.assertFalse(runtime.finish_decision(100, channel="aui")["notificationAllowed"])
        self.assertTrue(runtime.finish_decision(100, channel="a2a")["notificationAllowed"])

    def test_notification_query_phase_and_trigger_are_forward_compatible(self):
        runtime = self.runtime(lambda source: proposal(source, resolution="none", policy="allow"))
        runtime.resolve_user("user-1", "Report the result", 100)
        for trigger, phase in (("finish", "final"), ("candidate", "during"), ("deadline", "after")):
            decision = runtime.finish_decision(100, channel="aui", trigger=trigger, phase=phase)
            self.assertTrue(decision["allowed"])
            self.assertTrue(decision["notificationAllowed"])

    def test_forbid_until_deadline_does_not_relax_pending_evidence_gate(self):
        runtime, identity = self.registered(extractor=lambda source: proposal(source, policy="forbid_until_deadline"))
        self.assertFalse(runtime.finish_decision(199)["notificationAllowed"])
        self.assertFalse(runtime.finish_decision(201)["notificationAllowed"])
        self.signal(runtime, identity, kind="deadline", at=202, native=evidence(202))
        runtime.review_event(identity, "native-read-1", "deadline_reviewed", "Deadline and final native evidence reviewed", 203)
        self.assertTrue(runtime.finish_decision(203)["notificationAllowed"])

    def test_durable_resume_preserves_deadline_and_never_reextracts(self):
        runtime, identity = self.registered()
        self.signal(runtime, identity)
        def no_callback(*_args):
            raise AssertionError("Durable reopen must not call a model")
        resumed = self.runtime(no_callback, no_callback)
        self.assertEqual(resumed.snapshot(), runtime.snapshot())
        self.assertEqual(resumed.snapshot()["obligations"][0]["deadline"], 200)
        self.assertFalse(resumed.finish_decision(130)["allowed"])

    def test_evidence_tamper_detected_on_resume(self):
        runtime, _identity = self.registered()
        ref = runtime.snapshot()["sources"][0]["evidenceRef"]
        (self.root / ref["path"]).write_text("{}", encoding="utf-8")
        with self.assertRaises(TaskContractError) as caught:
            self.runtime()
        self.assertEqual(caught.exception.code, "evidence_hash")

    def test_ledger_tamper_detected_on_resume(self):
        runtime, _identity = self.registered()
        ledger = json.loads(runtime.path.read_text(encoding="utf-8"))
        ledger["state"]["obligations"][0]["status"] = "satisfied"
        runtime.path.write_text(json.dumps(ledger), encoding="utf-8")
        with self.assertRaises(TaskContractError) as caught:
            self.runtime()
        self.assertEqual(caught.exception.code, "stored_state_hash")

    def test_session_isolation_and_snapshot_deep_copy(self):
        runtime, _identity = self.registered()
        snapshot = runtime.snapshot(); snapshot["obligations"].clear()
        self.assertEqual(len(runtime.snapshot()["obligations"]), 1)
        another = TaskContractRuntime(self.root, "execution", "another-session", proposal, approved)
        self.assertNotEqual(another.directory, runtime.directory)
        self.assertEqual(another.snapshot()["sources"], [])


if __name__ == "__main__":
    unittest.main()
