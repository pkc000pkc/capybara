"""Offline cross-domain checks for source-bound task-contract recovery.

Only model transport responses are controlled. Production normalization, model
adapters and the durable runtime execute unchanged; no HTTP or ARE task runs.
"""
import ast
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import gaia2_task_contract_model as adapter
from gaia2_task_contract import TaskContractError, TaskContractRuntime, task_contract_hash
from gaia2_task_contract_normalize import (
    QuoteNormalizationError, normalize_task_contract, semantic_payload, verify_extraction,
)


CASES = (
    ("Warehouse", "Monitor stock updates for 37 seconds; do not notify before the deadline.", 37),
    ("AddressBook", "请持续监控联系人变更九十秒🙂，截止前不要通知我。", 90),
    ("Reservations", "Watch reservation changes for 865 seconds; do not notify before the deadline.", 865),
)


def source(text_value=CASES[0][1], arrived_at=100.0):
    return {"schemaVersion": "gaia2-task-contract-source-v1", "executionId": "controlled-execution",
            "sessionId": "controlled-session", "userRef": "user-original", "text": text_value,
            "sourceHash": hashlib.sha256(text_value.encode("utf-8")).hexdigest(), "arrivedAt": arrived_at}


def raw_proposal(src, duration=37, *, recipe=False, resolution="obligations"):
    value = {"schemaVersion": "gaia2-task-contract-proposal-v2", "sourceHash": src["sourceHash"],
             "resolution": resolution, "notificationPolicy": "forbid_until_deadline",
             "obligations": [{"quote": src["text"], "mode": "monitor_until",
                              "goal": "Monitor the complete user-requested scope through its original deadline",
                              "timeBasis": {"kind": "relative", "durationSeconds": duration}}],
             "revocations": []}
    if recipe:
        value["obligations"][0]["recipe"] = None
    return value


def response(name, value):
    return {"choices": [{"finish_reason": "tool_calls", "message": {"content": None, "tool_calls": [
        {"id": "controlled-call", "type": "function", "function": {
            "name": name, "arguments": json.dumps(value, ensure_ascii=False)}}]}}]}


def reviewed(src, extracted, *, approved=True):
    prop = extracted["normalizedProposal"]
    return {"schemaVersion": "gaia2-task-contract-review-v2", "sourceHash": src["sourceHash"],
            "proposalHash": extracted["normalizedProposalHash"], "rawProposalHash": extracted["rawProposalHash"],
            "anchoringHash": extracted["anchoringHash"], "decision": "approved" if approved else "ambiguous",
            "notificationVerified": approved,
            "obligationChecks": [{"index": index, "spanVerified": True, "modeVerified": True, "timeVerified": True}
                                 for index in range(len(prop["obligations"]))] if approved else [],
            "revocationChecks": [], "reason": "Independent source review accepted the contract." if approved
            else "The source does not support an unambiguous interpretation."}


class TaskContractNormalizationRecoveryTests(unittest.TestCase):
    def test_three_domains_missing_system_recipe_is_code_owned_and_input_is_immutable(self):
        for domain, text_value, duration in CASES:
            with self.subTest(domain=domain):
                src = source(text_value)
                raw = raw_proposal(src, duration)
                original = copy.deepcopy(raw)
                result = normalize_task_contract(src, raw)
                self.assertEqual(result["status"], "normalized")
                obligation = result["normalizedProposal"]["obligations"][0]
                self.assertIsNone(obligation["recipe"])
                self.assertEqual(obligation["timeBasis"]["durationSeconds"], duration)
                self.assertEqual(obligation["span"], {"start": 0, "end": len(text_value), "text": text_value})
                self.assertEqual(raw, original, "normalization must not rewrite captured raw model arguments")

    def test_missing_recipe_and_explicit_null_have_identical_semantics(self):
        src = source()
        missing, explicit = raw_proposal(src), raw_proposal(src, recipe=True)
        self.assertEqual(semantic_payload(missing), semantic_payload(explicit))
        self.assertEqual(normalize_task_contract(src, missing)["normalizedProposal"],
                         normalize_task_contract(src, explicit)["normalizedProposal"])

    def test_explicit_native_recipe_is_never_discarded_as_a_placeholder(self):
        src = source()
        raw = raw_proposal(src)
        raw["obligations"][0]["recipe"] = {"queryTool": "Warehouse__list_items", "queryArguments": {}}
        with self.assertRaises(QuoteNormalizationError) as caught:
            normalize_task_contract(src, raw)
        self.assertEqual(caught.exception.code, "untrusted_recipe")

    def test_missing_semantic_fields_are_not_defaulted(self):
        for field in ("quote", "goal", "mode", "timeBasis"):
            with self.subTest(field=field):
                src = source()
                raw = raw_proposal(src)
                del raw["obligations"][0][field]
                with self.assertRaises(QuoteNormalizationError) as caught:
                    normalize_task_contract(src, raw)
                self.assertEqual(caught.exception.code, "raw_missing_field")

    def test_unknown_obligation_field_is_not_silently_ignored(self):
        src = source()
        raw = raw_proposal(src)
        raw["obligations"][0]["assumeComplete"] = True
        with self.assertRaises(QuoteNormalizationError) as caught:
            normalize_task_contract(src, raw)
        self.assertEqual(caught.exception.code, "raw_unknown_field")

    def test_unicode_coordinates_are_code_computed(self):
        src = source("🙂前言。" + CASES[1][1])
        raw = raw_proposal(src, 90)
        raw["obligations"][0]["quote"] = CASES[1][1]
        span = normalize_task_contract(src, raw)["normalizedProposal"]["obligations"][0]["span"]
        self.assertEqual(span["start"], 4)
        self.assertEqual(src["text"][span["start"]:span["end"]], CASES[1][1])

    def test_nonunique_quote_stays_unresolved_without_adjacent_context(self):
        src = source("First: monitor stock. Second: monitor stock.")
        raw = raw_proposal(src)
        raw["obligations"][0]["quote"] = "monitor stock"
        result = normalize_task_contract(src, raw)
        self.assertEqual(result["status"], "unresolved")
        self.assertEqual(result["anchoringReceipt"]["errors"][0]["code"], "quote_not_unique")
        raw["obligations"][0]["quoteContext"] = {"before": "Second: ", "after": "."}
        fixed = normalize_task_contract(src, raw)
        self.assertEqual(fixed["status"], "normalized")
        self.assertEqual(fixed["normalizedProposal"]["obligations"][0]["span"]["start"], src["text"].rindex("monitor stock"))

    def test_changed_source_hash_cannot_acquire_authority(self):
        src = source()
        raw = raw_proposal(src)
        src["text"] += " Changed instructions."
        with self.assertRaises(QuoteNormalizationError) as caught:
            normalize_task_contract(src, raw)
        self.assertEqual(caught.exception.code, "source_hash")


class TaskContractModelRecoveryTests(unittest.TestCase):
    def test_missing_system_recipe_needs_one_extraction_call_not_a_repair(self):
        for domain, text_value, duration in CASES:
            with self.subTest(domain=domain):
                src, calls = source(text_value), []
                raw = raw_proposal(src, duration)
                def transport(messages, tools):
                    calls.append(copy.deepcopy((messages, tools)))
                    return response(adapter.EXTRACT_TOOL_NAME, raw)
                result = adapter.extract_task_contract(src, transport)
                self.assertEqual(result["status"], "normalized")
                self.assertEqual(len(calls), 1)
                verify_extraction(src, result)
                self.assertNotIn("recipe", calls[0][1][0]["function"]["parameters"]["properties"]["obligations"]["items"]["required"])

    def test_quote_repair_may_toggle_missing_null_placeholder_but_not_semantics(self):
        src = source()
        raw, calls = raw_proposal(src), []
        raw["obligations"][0]["quote"] = "not present in original user text"
        fixed = copy.deepcopy(raw)
        fixed["obligations"][0].update(quote=src["text"], recipe=None)
        def transport(messages, tools):
            name = tools[0]["function"]["name"]
            calls.append(name)
            value = raw if name == adapter.EXTRACT_TOOL_NAME else {
                "baseRawProposalHash": task_contract_hash(raw), "proposal": fixed}
            return response(name, value)
        result = adapter.extract_task_contract(src, transport)
        self.assertEqual(result["status"], "normalized")
        self.assertEqual(calls, [adapter.EXTRACT_TOOL_NAME, adapter.REPAIR_TOOL_NAME])
        verify_extraction(src, result)

    def test_quote_repair_cannot_change_existing_duration(self):
        src = source()
        raw = raw_proposal(src)
        raw["obligations"][0]["quote"] = "absent"
        fixed = copy.deepcopy(raw)
        fixed["obligations"][0]["quote"] = src["text"]
        fixed["obligations"][0]["timeBasis"]["durationSeconds"] = 999
        calls = []
        def transport(messages, tools):
            name = tools[0]["function"]["name"]
            calls.append(name)
            return response(name, raw if name == adapter.EXTRACT_TOOL_NAME else {
                "baseRawProposalHash": task_contract_hash(raw), "proposal": fixed})
        result = adapter.extract_task_contract(src, transport)
        self.assertEqual(result["status"], "unresolved")
        self.assertEqual(result["reason"], "repair_semantic_change")
        self.assertEqual(len(calls), 2)

    def test_failed_quote_repair_is_bounded_and_cannot_default_to_none(self):
        src = source()
        raw, calls = raw_proposal(src), []
        raw["obligations"][0]["quote"] = "absent"
        def transport(messages, tools):
            name = tools[0]["function"]["name"]
            calls.append(name)
            return response(name, raw if name == adapter.EXTRACT_TOOL_NAME else {
                "baseRawProposalHash": task_contract_hash(raw), "proposal": raw})
        result = adapter.extract_task_contract(src, transport)
        self.assertEqual(result["status"], "unresolved")
        self.assertEqual(len(calls), 2)
        self.assertIsNone(result["normalizedProposal"])

    def test_independent_review_hash_binding_survives_code_owned_recipe(self):
        src = source()
        extracted = adapter.extract_task_contract(src, lambda messages, tools: response(adapter.EXTRACT_TOOL_NAME, raw_proposal(src)))
        review = reviewed(src, extracted)
        result = adapter.review_task_contract(src, extracted, lambda messages, tools: response(adapter.REVIEW_TOOL_NAME, review))
        self.assertEqual(result["decision"], "approved")
        review["anchoringHash"] = "0" * 64
        with self.assertRaises(adapter.TaskContractModelError):
            adapter.review_task_contract(src, extracted, lambda messages, tools: response(adapter.REVIEW_TOOL_NAME, review))

    def test_nonnull_recipe_cannot_be_smuggled_through_quote_repair(self):
        src = source()
        raw, calls = raw_proposal(src), []
        raw["obligations"][0]["quote"] = "absent"
        fixed = copy.deepcopy(raw)
        fixed["obligations"][0].update(quote=src["text"], recipe={"queryTool": "Warehouse__list_items"})
        def transport(messages, tools):
            name = tools[0]["function"]["name"]
            calls.append(name)
            return response(name, raw if name == adapter.EXTRACT_TOOL_NAME else {
                "baseRawProposalHash": task_contract_hash(raw), "proposal": fixed})
        result = adapter.extract_task_contract(src, transport)
        self.assertEqual(result["status"], "unresolved")
        self.assertEqual(result["reason"], "repair_semantic_change")
        self.assertEqual(len(calls), 2)


def load_bridge_helper(name, context):
    """Execute the production nested helper with only its external seams faked."""
    path = Path(__file__).resolve().parents[1] / "scripts" / "capybara_official_bridge.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    function = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)
    class Lift(ast.NodeTransformer):
        def visit_Nonlocal(self, node):
            return ast.copy_location(ast.Global(names=node.names), node)
    function = Lift().visit(copy.deepcopy(function))
    unit = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    exec(compile(unit, str(path), "exec"), context)
    return context[name]


class TaskContractRuntimeRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="task-contract-recovery-")

    def tearDown(self):
        self.temporary.cleanup()

    def runtime(self, duration=37, *, fail_count=0, approve=True):
        calls = {"extract": 0, "review": 0}
        def extract(src):
            calls["extract"] += 1
            if calls["extract"] <= fail_count:
                raise TaskContractError("model_transport_error", "Controlled transport failure")
            return adapter.extract_task_contract(src, lambda messages, tools: response(adapter.EXTRACT_TOOL_NAME, raw_proposal(src, duration)))
        def review(src, extracted):
            calls["review"] += 1
            return adapter.review_task_contract(src, extracted, lambda messages, tools: response(adapter.REVIEW_TOOL_NAME, reviewed(src, extracted, approved=approve)))
        args = (self.temporary.name, "controlled-execution", "controlled-session", extract, review)
        return TaskContractRuntime(*args), calls, args

    def test_three_domains_keep_distinct_original_deadlines_and_idempotent_registration(self):
        for domain, text_value, duration in CASES:
            with self.subTest(domain=domain), tempfile.TemporaryDirectory(prefix="contract-domain-") as directory:
                runtime, calls, args = self.runtime(duration)
                runtime = TaskContractRuntime(directory, *args[1:])
                runtime.resolve_user("user-original", text_value, 100.0)
                state = runtime.snapshot()
                self.assertEqual(state["sources"][0]["resolution"], "registered")
                self.assertEqual(state["obligations"][0]["deadline"], 100.0 + duration)
                self.assertIsNone(state["obligations"][0]["recipe"])
                self.assertFalse(runtime.finish_decision(100.0)["allowed"])
                runtime.resolve_user("user-original", text_value, 100.0)
                self.assertEqual(len(runtime.snapshot()["obligations"]), 1)
                self.assertEqual(calls, {"extract": 1, "review": 1})

    def test_technical_failure_can_recover_without_new_source_or_reset_deadline(self):
        runtime, calls, _ = self.runtime(fail_count=1)
        text_value = CASES[0][1]
        runtime.resolve_user("user-original", text_value, 100.0)
        failed = runtime.snapshot()["sources"][0]
        self.assertEqual(failed["resolution"], "ambiguous")
        self.assertFalse(runtime.finish_decision(105.0)["allowed"])
        runtime.resolve_user("user-original", text_value, 100.0)
        state = runtime.snapshot()
        self.assertEqual(len(state["sources"]), 1)
        self.assertEqual(state["sources"][0]["resolution"], "registered")
        for field in ("userRef", "sourceHash", "arrivedAt", "evidenceRef"):
            self.assertEqual(state["sources"][0][field], failed[field])
        self.assertEqual(state["obligations"][0]["deadline"], 137.0)
        self.assertEqual(calls, {"extract": 2, "review": 1})
        self.assertGreaterEqual(len(state["sources"][0]["attemptHistory"]), 1)
        runtime.resolve_user("user-original", text_value, 100.0)
        self.assertEqual(calls["extract"], 2)

    def test_technical_retry_budget_survives_reload(self):
        runtime, calls, args = self.runtime(fail_count=10)
        text_value = CASES[0][1]
        runtime.resolve_user("user-original", text_value, 100.0)
        reloaded = TaskContractRuntime(*args)
        for _ in range(4):
            reloaded.resolve_user("user-original", text_value, 100.0)
        self.assertEqual(calls["extract"], 2)
        self.assertEqual(calls["review"], 0)
        self.assertEqual(reloaded.snapshot()["obligations"], [])
        self.assertFalse(reloaded.finish_decision(1000.0)["allowed"])

    def test_reviewed_semantic_ambiguity_does_not_trigger_technical_reinterpretation(self):
        runtime, calls, _ = self.runtime(approve=False)
        for _ in range(4):
            runtime.resolve_user("user-original", CASES[0][1], 100.0)
        self.assertEqual(calls, {"extract": 1, "review": 1})
        self.assertEqual(runtime.snapshot()["obligations"], [])
        self.assertFalse(runtime.finish_decision(1000.0)["allowed"])

    def test_retry_cannot_change_original_text_or_arrival_time(self):
        runtime, calls, _ = self.runtime(fail_count=1)
        runtime.resolve_user("user-original", CASES[0][1], 100.0)
        for text_value, arrived_at in ((CASES[0][1] + " More", 100.0), (CASES[0][1], 101.0)):
            with self.assertRaises(TaskContractError) as caught:
                runtime.resolve_user("user-original", text_value, arrived_at)
            self.assertEqual(caught.exception.code, "source_identity")
        self.assertEqual(calls["extract"], 1)

    def test_same_source_two_failed_attempts_preserve_history_and_exhaust_budget(self):
        runtime, calls, _ = self.runtime(fail_count=20)
        runtime.resolve_user("user-original", CASES[0][1], 100.0)
        first = runtime.snapshot()["sources"][0]
        runtime.resolve_user("user-original", CASES[0][1], 100.0)
        exhausted = runtime.snapshot()["sources"][0]
        self.assertEqual(exhausted["resolverAttempts"], 2)
        self.assertFalse(exhausted["resolverRetryable"])
        self.assertEqual(exhausted["attemptHistory"], [{key: value for key, value in first.items() if key != "attemptHistory"}])
        for _ in range(5):
            runtime.resolve_user("user-original", CASES[0][1], 100.0)
        self.assertEqual(calls, {"extract": 2, "review": 0})
        self.assertEqual(runtime.snapshot()["obligations"], [])

    def test_reload_verifies_old_failed_extraction_artifact_not_only_current_attempt(self):
        calls = []
        def extract(src):
            raw = raw_proposal(src)
            if not calls:
                raw["obligations"][0]["quote"] = "not an original user clause"
            calls.append(True)
            def transport(messages, tools):
                name = tools[0]["function"]["name"]
                value = raw if name == adapter.EXTRACT_TOOL_NAME else {
                    "baseRawProposalHash": task_contract_hash(raw), "proposal": raw}
                return response(name, value)
            return adapter.extract_task_contract(src, transport)
        def review(src, extracted):
            return adapter.review_task_contract(src, extracted, lambda messages, tools: response(adapter.REVIEW_TOOL_NAME, reviewed(src, extracted)))
        args = (self.temporary.name, "controlled-execution", "controlled-session", extract, review)
        runtime = TaskContractRuntime(*args)
        runtime.resolve_user("user-original", CASES[0][1], 100.0)
        runtime.resolve_user("user-original", CASES[0][1], 100.0)
        record = runtime.snapshot()["sources"][0]
        self.assertEqual(record["resolution"], "registered")
        old_ref = record["attemptHistory"][0]["extractionRef"]
        self.assertIsNotNone(old_ref)
        TaskContractRuntime(*args)  # Establish that the untampered history reloads.
        old_artifact = Path(self.temporary.name) / old_ref["path"]
        old_artifact.write_bytes(b'{"tampered":true}')
        with self.assertRaises(TaskContractError) as caught:
            TaskContractRuntime(*args)
        self.assertEqual(caught.exception.code, "evidence_hash")

    def test_notification_semantics_need_independent_whole_source_review(self):
        seen = []
        def extract(src):
            raw = raw_proposal(src)
            raw["notificationPolicy"] = "allow"  # Deliberately unsupported extractor interpretation.
            return adapter.extract_task_contract(src, lambda messages, tools: response(adapter.EXTRACT_TOOL_NAME, raw))
        def review(src, extracted):
            value = reviewed(src, extracted, approved=False)
            def transport(messages, tools):
                seen.append(copy.deepcopy(messages))
                return response(adapter.REVIEW_TOOL_NAME, value)
            return adapter.review_task_contract(src, extracted, transport)
        runtime = TaskContractRuntime(self.temporary.name, "controlled-execution", "controlled-session", extract, review)
        runtime.resolve_user("user-original", CASES[0][1], 100.0)
        self.assertEqual(runtime.snapshot()["obligations"], [])
        self.assertEqual(runtime.snapshot()["sources"][0]["notificationPolicy"], "forbid")
        self.assertFalse(runtime.finish_decision(200.0)["notificationAllowed"])
        self.assertIn("ENTIRE ORIGINAL SOURCE", seen[0][0]["content"])
        self.assertEqual(json.loads(seen[0][1]["content"])["source"]["text"], CASES[0][1])

    def test_real_bridge_sync_retries_before_returning_to_actor_with_original_anchor(self):
        runtime, calls, _ = self.runtime(fail_count=1)
        commits = []
        context = {"task_runtime": runtime, "revision": 0, "active_turn": False, "temporal_stopped": False,
                   "notification_binding": None,
                   "messages": [{"id": "user-original", "role": "user", "notificationType": "USER_MESSAGE",
                                 "observedAt": 100.0, "content": CASES[0][1]}],
                   "env": SimpleNamespace(time_manager=SimpleNamespace(time=lambda: 108.0)),
                   "_task_commit": lambda reason: commits.append((reason, runtime.snapshot())),
                   "_drain_notifications": lambda env, messages, revision, **kwargs: (revision, False, False)}
        load_bridge_helper("_task_sync", context)()
        self.assertEqual(calls, {"extract": 2, "review": 1})
        self.assertEqual([state["sources"][0]["resolution"] for reason, state in commits if reason == "arrived_user_resolved"],
                         ["ambiguous", "registered"])
        self.assertEqual(runtime.snapshot()["obligations"][0]["deadline"], 137.0)
        self.assertEqual(runtime.snapshot()["sources"][0]["arrivedAt"], 100.0)
        self.assertEqual(runtime.snapshot()["clock"], 108.0)

    def test_real_bridge_sync_stops_retrying_at_two_technical_failures(self):
        runtime, calls, _ = self.runtime(fail_count=20)
        context = {"task_runtime": runtime, "revision": 0, "active_turn": False, "temporal_stopped": False,
                   "notification_binding": None,
                   "messages": [{"id": "user-original", "role": "user", "notificationType": "USER_MESSAGE",
                                 "observedAt": 100.0, "content": CASES[0][1]}],
                   "env": SimpleNamespace(time_manager=SimpleNamespace(time=lambda: 108.0)),
                   "_task_commit": lambda reason: None,
                   "_drain_notifications": lambda env, messages, revision, **kwargs: (revision, False, False)}
        helper = load_bridge_helper("_task_sync", context)
        helper()
        helper()
        self.assertEqual(calls, {"extract": 2, "review": 0})
        self.assertFalse(runtime.snapshot()["sources"][0]["resolverRetryable"])
        self.assertEqual(runtime.snapshot()["obligations"], [])


if __name__ == "__main__":
    unittest.main()
