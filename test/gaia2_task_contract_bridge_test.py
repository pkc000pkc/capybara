"""Offline Bridge-helper integration checks; no HTTP/ARE scenario execution.

Compile the actual nested helper AST with injected trusted callback fakes. This
does not duplicate its implementation or import/install the production Bridge.
Fake scene values exercise boundary control flow only, never create a production
clock or change an official result.
"""
import ast
import copy
import hashlib
import json
import math
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gaia2_temporal import TemporalError, TemporalInterrupt, TemporalNativeError


class ProtocolError(RuntimeError):
    pass


class BudgetError(RuntimeError):
    pass


def stable_hash(value):
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def load_helper(name, context):
    path = ROOT / "scripts" / "capybara_official_bridge.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    function = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)
    class Lift(ast.NodeTransformer):
        def visit_Nonlocal(self, node):
            return ast.copy_location(ast.Global(names=node.names), node)
    function = Lift().visit(copy.deepcopy(function))
    unit = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
    exec(compile(unit, str(path), "exec"), context)
    return context[name]


class TemporalFake:
    def __init__(self, signal="initial_observation"):
        self.signal, self.calls = signal, []

    def run(self, arguments, **kwargs):
        if arguments["maxScans"] > 64:
            raise TemporalError("arguments", "real controller maxScans is 64")
        self.calls.append(copy.deepcopy(arguments))
        return {"signal": {"kind": self.signal}, "observation": None, "businessSuccess": False}

    def snapshot(self):
        return {"waitCount": 0, "scanCount": 0, "baselineHash": stable_hash({"same": True})}


class BridgeTaskHelperTests(unittest.TestCase):
    def fixture(self, signal="initial_observation", now=2.0):
        clock = {"now": now}
        item = {"id": "obligation-one", "userRef": "user-one", "status": "pending", "goal": "Monitor a bounded user request",
                "mode": "monitor_until", "deadline": 10.0, "pendingEvidence": None,
                "recipe": {"queryTool": "EmailClientV2__list_emails", "queryArguments": {"folder_name": "INBOX", "offset": 0, "limit": 10},
                           "queryHash": "a" * 64, "intervalSeconds": 1, "maxScans": 12},
                "counts": {"watchCalls": 0, "nativeWaits": 0, "nativeScans": 0}}
        records, commits, native_calls, interruptions = [], [], [], []
        temporal = TemporalFake(signal)
        def receipt():
            return {"actionId": "native-final", "canonicalName": item["recipe"]["queryTool"], "queryHash": "a" * 64,
                    "resultHash": stable_hash({"same": True}), "result": {"same": True},
                    "complete": True, "viewComplete": True, "observedAt": clock["now"]}
        def native(name, arguments, **kwargs):
            native_calls.append((name, dict(arguments)))
            if name == "SystemApp__wait_for_notification":
                clock["now"] += arguments["timeout"]
            return receipt()
        runtime = SimpleNamespace(limits={"watchCalls": 32, "nativeWaits": 128, "nativeScans": 128},
                                  interrupt=interruptions.append)
        context = {"copy": copy, "uuid": uuid, "math": math,
                   "HookProtocolError": ProtocolError, "BridgeBudgetExceeded": BudgetError,
                   "env": SimpleNamespace(time_manager=SimpleNamespace(time=lambda: clock["now"])),
                   "temporal": temporal, "temporal_user_ref": None, "temporal_stopped": False,
                   "task_runtime": runtime, "task_evidence": {}, "task_finish_deferrals": 0, "task_silent_waits": 0,
                   "_latest_user_ref": lambda: "user-one", "_task_obligation": lambda _id: copy.deepcopy(item),
                   "_temporal_baseline": lambda _args: receipt(), "_temporal_native": native,
                   "_temporal_notifications": lambda: {"userChanged": False, "stopped": False, "notificationIds": []},
                   "_task_record_signal": lambda *args: records.append(copy.deepcopy(args)),
                   "_task_commit": commits.append, "_emit_runtime_event": lambda *a, **kw: None,
                   "_stable_hash": stable_hash}
        return context, clock, item, records, commits, native_calls, interruptions, receipt

    def test_01_valid_large_recipe_is_capped_at_real_controller_limit(self):
        context, _, item, records, *_ = self.fixture()
        item["recipe"]["maxScans"] = 1000  # Runtime schema may retain a wider cumulative request.
        result = load_helper("_task_run_obligation", context)(item["id"], "watch-one")
        self.assertEqual(result["signal"]["kind"], "initial_observation")
        self.assertLessEqual(context["temporal"].calls[0]["maxScans"], 64)
        self.assertEqual(records[0][1], "initial_observation")

    def test_02_original_contract_deadline_not_watch_start_is_used(self):
        context, _, item, *_ = self.fixture(now=7.0)
        load_helper("_task_run_obligation", context)(item["id"], "watch-one")
        self.assertEqual(context["temporal"].calls[0]["until"], 10.0)
        self.assertEqual(context["temporal"].calls[0]["queryTool"], "EmailClientV2__list_emails")

    def test_03_elapsed_deadline_requires_actual_final_read(self):
        context, clock, item, records, _, native_calls, *_ = self.fixture(now=10.0)
        result = load_helper("_task_run_obligation", context)(item["id"], "watch-final")
        self.assertEqual(context["temporal"].calls, [])
        self.assertEqual(native_calls, [(item["recipe"]["queryTool"], item["recipe"]["queryArguments"])])
        self.assertEqual(result["signal"]["kind"], "deadline")
        self.assertGreaterEqual(result["observation"]["observedAt"], item["deadline"])
        self.assertEqual(records[0][-2:], (0, 1))
        self.assertEqual(clock["now"], 10.0)

    def test_04_pending_evidence_must_be_reviewed_without_repeat_scan(self):
        context, _, item, records, _, native_calls, _, receipt = self.fixture()
        item["pendingEvidence"] = {"actionId": "native-final"}
        context["task_evidence"]["native-final"] = receipt()
        result = load_helper("_task_run_obligation", context)(item["id"], "watch-again")
        self.assertEqual(result["status"], "review_required")
        self.assertEqual(records, [])
        self.assertEqual(native_calls, [])
        self.assertEqual(context["temporal"].calls, [])

    def test_05_cumulative_budget_is_not_completion_or_an_unbounded_retry(self):
        context, _, item, _, _, native_calls, interruptions, _ = self.fixture()
        item["counts"]["nativeScans"] = 128
        result = load_helper("_task_run_obligation", context)(item["id"], "watch-over-budget")
        self.assertEqual(result["status"], "technical_blocked")
        self.assertFalse(result["businessSuccess"])
        self.assertEqual(interruptions, ["budget_exhausted"])
        self.assertEqual(native_calls, [])

    def test_06_ordinary_early_notification_does_not_become_clock_error(self):
        context, clock, item, records, _, native_calls, _, receipt = self.fixture("deadline_approaching", now=9.5)
        waits = []
        def native(name, arguments, **kwargs):
            native_calls.append((name, dict(arguments)))
            if name == "SystemApp__wait_for_notification":
                waits.append(True)
                clock["now"] = 9.75 if len(waits) == 1 else 10.0
            return receipt()
        context["_temporal_native"] = native
        result = load_helper("_task_run_obligation", context)(item["id"], "watch-subsecond")
        self.assertEqual(result["signal"]["kind"], "deadline")
        self.assertEqual(len(waits), 2)
        self.assertNotIn("clock_error", [record[1] for record in records])
        self.assertGreaterEqual(result["observation"]["observedAt"], item["deadline"])

    def test_07_user_or_stop_during_boundary_wait_interrupts_without_final_read(self):
        for kind in ("user_update", "environment_stop"):
            context, _, item, records, _, native_calls, *_ = self.fixture("deadline_approaching", now=9.5)
            def native(name, arguments, **kwargs):
                native_calls.append((name, arguments))
                raise TemporalInterrupt(kind)
            context["_temporal_native"] = native
            result = load_helper("_task_run_obligation", context)(item["id"], "watch-interrupted")
            self.assertEqual(result["signal"]["kind"], kind)
            self.assertEqual(len(native_calls), 1)
            self.assertEqual(native_calls[0][0], "SystemApp__wait_for_notification")
            self.assertEqual(records[0][1], kind)

    def test_08_default_off_sync_has_no_clock_hook_or_model_activity(self):
        def forbidden(*a, **kw):
            raise AssertionError("default-off task path must be inert")
        context = {"task_runtime": None, "_task_commit": forbidden, "_drain_notifications": forbidden,
                   "env": None, "messages": [], "revision": 0, "active_turn": True, "temporal_stopped": False}
        self.assertIsNone(load_helper("_task_sync", context)())

    def test_09_sync_registers_original_arrival_time_not_later_clock(self):
        context, _, _, _, _, _, _, _ = self.fixture(now=99.0)
        registrations, sources = [], []
        runtime = SimpleNamespace(snapshot=lambda: {"sources": sources})
        def resolve(user, content, arrived):
            registrations.append((user, content, arrived))
            sources.append({"userRef": user})
        runtime.resolve_user = resolve
        runtime.advance = lambda now: registrations.append(("clock", now))
        context.update(task_runtime=runtime, revision=0, active_turn=True, notification_binding=None,
                       messages=[{"id": "original-user", "role": "user", "notificationType": "USER_MESSAGE",
                                  "observedAt": 1.25, "content": "Monitor for four minutes"}],
                       _drain_notifications=lambda env, messages, revision, **kw: (revision, False, False))
        load_helper("_task_sync", context)()
        self.assertEqual(registrations[0], ("original-user", "Monitor for four minutes", 1.25))
        self.assertEqual(registrations[1], ("clock", 99.0))

    def test_10_early_finish_without_recipe_is_blocked_and_bounded(self):
        context, _, item, _, _, native_calls, *_ = self.fixture()
        item["recipe"] = None
        context["task_runtime"].finish_decision = lambda now: {"pendingObligationIds": [item["id"]], "allowed": False,
                                                              "notificationAllowed": False, "reason": "obligations_pending"}
        context["task_runtime"].snapshot = lambda: {"obligations": [copy.deepcopy(item)]}
        context["_task_run_obligation"] = lambda obligation, call: {"status": "bind_required", "businessSuccess": False}
        helper = load_helper("_task_defer_finish", context)
        self.assertEqual(helper()["status"], "bind_required")
        self.assertEqual(helper()["status"], "bind_required")
        with self.assertRaises(ProtocolError):
            helper()
        self.assertEqual(native_calls, [])

    def test_11_notification_forbidden_stays_silent_until_real_stop(self):
        context, _, _, _, _, native_calls, *_ = self.fixture()
        context["task_runtime"].finish_decision = lambda now: {"pendingObligationIds": [], "allowed": True,
                                                              "notificationAllowed": False, "reason": "ready"}
        context["task_runtime"].snapshot = lambda: {"obligations": []}
        def native(name, arguments, **kwargs):
            native_calls.append((name, arguments))
            raise TemporalInterrupt("environment_stop")
        context["_temporal_native"] = native
        result = load_helper("_task_defer_finish", context)()
        self.assertEqual(result, {"status": "environment_stop", "businessSuccess": False, "notificationSent": False})
        self.assertEqual(native_calls[0][0], "SystemApp__wait_for_notification")
        self.assertEqual(context["task_silent_waits"], 1)

    def test_12_failed_final_read_returns_native_error_not_old_deadline(self):
        context, _, item, records, *_ = self.fixture(now=10.0)
        def native(name, arguments, **kwargs):
            raise TemporalNativeError("controlled native failure")
        context["_temporal_native"] = native
        result = load_helper("_task_run_obligation", context)(item["id"], "failed-final")
        self.assertEqual(result["signal"]["kind"], "native_error")
        self.assertIsNone(result["observation"])
        self.assertEqual(records[0][1], "native_error")

    def test_13_real_changed_scan_during_early_wake_returns_candidate(self):
        context, clock, item, records, _, native_calls, _, receipt = self.fixture("deadline_approaching", now=9.5)
        def native(name, arguments, **kwargs):
            native_calls.append((name, dict(arguments)))
            if name == "SystemApp__wait_for_notification":
                clock["now"] = 9.75
                return receipt()
            changed = receipt()
            changed.update(result={"changed": True}, resultHash=stable_hash({"changed": True}))
            return changed
        context["_temporal_native"] = native
        result = load_helper("_task_run_obligation", context)(item["id"], "changed-before-deadline")
        self.assertEqual(result["signal"]["kind"], "candidate_changed")
        self.assertLess(result["observation"]["observedAt"], item["deadline"])
        self.assertEqual(len(native_calls), 2)
        self.assertEqual(records[0][1], "candidate_changed")
        self.assertFalse(result["businessSuccess"])

    def test_14_actual_backwards_boundary_clock_still_fails_closed(self):
        context, clock, item, records, *_ = self.fixture("deadline_approaching", now=9.5)
        def native(name, arguments, **kwargs):
            clock["now"] = 9.0
            return {}
        context["_temporal_native"] = native
        result = load_helper("_task_run_obligation", context)(item["id"], "backwards-clock")
        self.assertEqual(result["signal"]["kind"], "clock_error")
        self.assertEqual(records[0][1], "clock_error")
        self.assertFalse(result["businessSuccess"])

    def test_15_late_user_interrupt_drops_previous_scan_from_return(self):
        context, clock, item, records, _, native_calls, _, receipt = self.fixture("deadline_approaching", now=9.5)
        waits = []
        def native(name, arguments, **kwargs):
            native_calls.append((name, arguments))
            if name == "SystemApp__wait_for_notification":
                waits.append(True)
                if len(waits) == 2:
                    raise TemporalInterrupt("user_update")
                clock["now"] = 9.75
            return receipt()
        context["_temporal_native"] = native
        result = load_helper("_task_run_obligation", context)(item["id"], "user-after-scan")
        self.assertEqual(len(waits), 2)
        self.assertEqual(result["signal"]["kind"], "user_update")
        self.assertIsNone(result["observation"])
        self.assertIsNone(records[0][2])


if __name__ == "__main__":
    unittest.main()
