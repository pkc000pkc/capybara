"""Model-free 5.1a tests with real pinned ARE tool objects and native events.

Run with the project's configured Python, -B and PYTHONPATH=.official-python.
No Scenario, model transport, TS IPC, conversion, export or artifact file IO.
The trusted gates below are local test doubles, NOT real TS owned receipts.
"""

import copy
import hashlib
import json
import socket
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from gaia2_a2a_runtime import A2AContractError, GateDecision, LocalA2ARuntime
from are.simulation.agents.agent_log import ToolCallLog
from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.agents.default_agent.default_tools import FinalAnswerTool
from are.simulation.apps.app import App
from are.simulation.tool_utils import AppTool, OperationType, app_tool
from are.simulation.types import CompletedEvent, event_registered


class ControlledLedger(App):
    def __init__(self, name="Ledger"):
        super().__init__(name=name)
        self.values = []
        self.reads = 0
        self.entered = None
        self.release = None

    @app_tool()
    @event_registered(operation_type=OperationType.WRITE)
    def write(self, value: str) -> dict:
        """Append a controlled value.
        :param value: controlled test value
        :returns: current values
        """
        self.values.append(value)
        if self.entered is not None:
            self.entered.set()
            if not self.release.wait(5):
                raise RuntimeError("controlled_timeout")
        if value == "uncertain":
            raise ValueError("effect occurred; this text must not become authority")
        if value == "helper":
            self.read()  # Official internal event, not a separate dispatcher call.
        return {"values": list(self.values)}

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def read(self) -> dict:
        """Observe the controlled app.
        :returns: current values
        """
        self.reads += 1
        return {"values": list(self.values)}


class SequenceModel:
    """A local Actor JSON iterator, not a provider or official agent replacement."""
    def __init__(self, actions):
        self.actions = iter(actions)
        self.calls = 0

    def next_action(self):
        self.calls += 1
        return next(self.actions)


class Tests(unittest.TestCase):
    def setUp(self):
        self.network = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.now = [1000.0]
        self.app = ControlledLedger()
        self.events = []
        self.app.register_to_env("controlled-observer", self.events.append)
        self.gates = []
        self.afters = []
        self.parent_counter = 0

    def runtime(self, before=None, after=None, apps=None, generation="env-1"):
        def allow(view):
            self.gates.append(view)
            return GateDecision.ALLOW
        def observe(value):
            self.afters.append(value)
        return LocalA2ARuntime(apps=apps or {self.app.name: self.app}, environment_generation=generation,
            parent_execution_id="parent-exec", parent_session_id="parent-session",
            clock=lambda: self.now[0], before=before or allow, after=after or observe)

    def child(self, runtime, app="Ledger", budget=10):
        self.parent_counter += 1
        handle = runtime.register_child(app_name=app, parent_action_id=f"parent-action-{self.parent_counter}",
            task="controlled task", deadline=1100.0, max_actions=budget)
        runtime.start_child(handle)
        return handle

    def action(self, runtime, child, tool="Ledger__write", arguments=None):
        return runtime.prepare_action(child, {"tool": tool, "arguments": arguments if arguments is not None else {"value": "one"}})

    def test_01_real_original_apptool_block_zero_allow_one_and_real_event(self):
        original = self.app.get_tools()
        self.assertTrue(all(isinstance(tool, AppTool) for tool in original))
        def gate(view):
            return GateDecision.BLOCK if view.tool_kind == "app_tool" else GateDecision.ALLOW
        blocked = self.runtime(before=gate)
        blocked_child = self.child(blocked)
        self.assertEqual(blocked.dispatch(self.action(blocked, blocked_child))["status"], "blocked")
        self.assertEqual(self.app.values, [])
        self.assertEqual(self.events, [])
        blocked.close()
        self.app = ControlledLedger()
        self.app.register_to_env("controlled-observer", self.events.append)
        original = self.app.get_tools()
        allowed = self.runtime()
        child = self.child(allowed)
        self.assertEqual(allowed.dispatch(self.action(allowed, child))["result"], {"values": ["one"]})
        self.assertEqual(self.app.values, ["one"])
        self.assertEqual(len(self.events), 1)
        self.assertIsInstance(self.events[0], CompletedEvent)
        self.assertIs(self.events[0].action.app, self.app)
        self.assertEqual([id(tool) for tool in self.app.get_tools()], [id(tool) for tool in original])
        action = allowed.snapshot()["children"][0]["actions"][0]
        self.assertIsNotNone(action["nativeCompletedEventRef"])
        self.assertIsNotNone(action["beforeRef"])
        self.assertIsNotNone(action["nativeReturnRef"])
        self.assertIsNotNone(action["afterRef"])

    def test_02_boolean_json_authority_fake_identity_unknown_and_cross_app_denied(self):
        runtime = self.runtime()
        child = self.child(runtime)
        for extra in ("effect", "canonicalName", "a2aPermission", "requestId", "passed", "proof"):
            with self.subTest(extra=extra), self.assertRaisesRegex(A2AContractError, "actor_action_invalid"):
                runtime.prepare_action(child, {"tool": "Ledger__write", "arguments": {"value": "one"}, extra: True})
        for tool in ("Other__write", "expert_agent", "unknown"):
            with self.subTest(tool=tool), self.assertRaisesRegex(A2AContractError, "tool_not_in_app"):
                self.action(runtime, child, tool)
        with self.assertRaisesRegex(A2AContractError, "argument_binding_invalid"):
            self.action(runtime, child, arguments={"value": "one", "a2aPermission": True})
        for handle in ({"passed": True}, copy.copy(child), object(), True):
            with self.assertRaisesRegex(A2AContractError, "child_handle_invalid"):
                runtime.start_child(handle)
        other_runtime = self.runtime(apps={"Ledger": ControlledLedger()}, generation="env-2")
        with self.assertRaisesRegex(A2AContractError, "child_handle_invalid"):
            other_runtime.start_child(child)
        self.assertEqual(self.app.values, [])

    def test_03_unknown_is_shared_across_requests_readback_does_not_clear_it(self):
        runtime = self.runtime()
        first = self.child(runtime)
        uncertain = runtime.dispatch(self.action(runtime, first, arguments={"value": "uncertain"}))
        self.assertEqual(uncertain["status"], "unknown")
        ledger = runtime.snapshot()["ledger"]
        self.assertEqual(ledger[0]["status"], "unknown")
        second = self.child(runtime)
        self.assertEqual(runtime.dispatch(self.action(runtime, second, arguments={"value": "uncertain"}))["status"], "blocked")
        self.assertEqual(runtime.dispatch(self.action(runtime, second, arguments={"value": "different"}))["status"], "blocked")
        self.assertEqual(runtime.dispatch(self.action(runtime, second, "Ledger__read", {}))["status"], "succeeded")
        observed = runtime.snapshot()
        self.assertEqual(observed["ledger"][0]["status"], "unknown")
        self.assertTrue(observed["ledger"][0]["readBackObserved"])
        self.assertNotEqual(observed["children"][0]["requestId"], observed["children"][1]["requestId"])
        self.assertEqual(observed["children"][0]["actions"][0]["mutationKey"], observed["children"][1]["actions"][0]["mutationKey"])
        with self.assertRaisesRegex(A2AContractError, "unresolved_app_mutation"):
            runtime.complete_child(second)
        # A projected variable/ledger patch has no authority effect.
        observed["ledger"].clear()
        observed["children"][0]["state"] = "completed"
        self.assertEqual(runtime.snapshot()["ledger"][0]["status"], "unknown")
        self.assertEqual(self.app.values, ["uncertain"])

    def test_04_real_final_return_after_no_completed_event_and_mock_actor(self):
        runtime = self.runtime()
        child = self.child(runtime)
        model = SequenceModel([{"tool": "Ledger__read", "arguments": {}},
                               {"tool": "final_answer", "arguments": {"answer": "done"}}])
        for _ in range(2):
            result = runtime.dispatch(runtime.prepare_action(child, model.next_action()))
            self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["result"], "done")
        self.assertEqual(len(self.events), 1)  # Real read event, no final-answer event.
        before = runtime.snapshot()
        final = before["children"][0]["actions"][-1]
        self.assertEqual(final["toolKind"], "child_final_answer")
        self.assertIsNone(final["nativeCompletedEventRef"])
        self.assertTrue(all(final[key] for key in ("beforeRef", "nativeReturnRef", "afterRef")))
        runtime.complete_child(child)
        snapshot = runtime.snapshot()
        self.assertEqual(snapshot["children"][0]["state"], "completed")
        self.assertEqual(snapshot["parentExecutionId"], "parent-exec")
        self.assertEqual(snapshot["parentSessionId"], "parent-session")
        self.assertFalse(snapshot["productionDelegationEnabled"])
        self.assertFalse(snapshot["tsIpcConnected"])
        self.assertNotIn("completedTurns", snapshot)
        self.assertEqual(model.calls, 2)

    def test_05_fake_final_log_string_and_passed_do_not_complete_child(self):
        runtime = self.runtime()
        child = self.child(runtime)
        fake_log = ToolCallLog(tool_name="final_answer", tool_arguments={"answer": "done"}, timestamp=1000, agent_id="child")
        self.assertEqual(fake_log.tool_name, "final_answer")
        answer = FinalAnswerTool()(answer="done")  # Even an out-of-scope real return is insufficient.
        self.assertEqual(answer, "done")
        with self.assertRaisesRegex(A2AContractError, "real_final_answer_required"):
            runtime.complete_child(child)
        with self.assertRaises(TypeError):
            runtime.complete_child(child, passed=True)
        self.assertEqual(runtime.snapshot()["children"][0]["state"], "running")
        self.assertEqual(self.events, [])

    def test_06_blocked_native_exception_or_failed_after_final_never_completes(self):
        for mode in ("block", "native_exception", "after_failure", "after_boolean"):
            with self.subTest(mode=mode):
                self.app = ControlledLedger()
                def before(view):
                    return GateDecision.BLOCK if mode == "block" and view.tool_kind == "child_final_answer" else GateDecision.ALLOW
                def after(unused):
                    if mode == "after_failure":
                        raise RuntimeError("controlled_after_failure")
                    if mode == "after_boolean":
                        return True
                runtime = self.runtime(before=before, after=after)
                child = self.child(runtime)
                ticket = self.action(runtime, child, "final_answer", {"answer": "done"})
                if mode == "native_exception":
                    def controlled_final(self, answer):
                        raise ValueError("controlled_final_error")
                    with patch.object(FinalAnswerTool, "forward", controlled_final):
                        result = runtime.dispatch(ticket)
                else:
                    result = runtime.dispatch(ticket)
                self.assertNotEqual(result["status"], "succeeded")
                with self.assertRaises(A2AContractError):
                    runtime.complete_child(child)
                self.assertNotEqual(runtime.snapshot()["children"][0]["state"], "completed")
                self.assertEqual(self.events, [])

    def test_07_action_capability_consumed_exactly_once_concurrently(self):
        runtime = self.runtime()
        child = self.child(runtime)
        ticket = self.action(runtime, child)
        def call():
            try:
                return runtime.dispatch(ticket)["status"]
            except A2AContractError as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda unused: call(), range(2)))
        self.assertCountEqual(outcomes, ["succeeded", "action_handle_consumed"])
        self.assertEqual(self.app.values, ["one"])
        self.assertEqual(len(self.events), 1)
        with self.assertRaisesRegex(A2AContractError, "action_handle_invalid"):
            runtime.dispatch(copy.copy(ticket))

    def run_close_race(self, phase):
        entered, release = threading.Event(), threading.Event()
        def before(view):
            if phase == "before" and view.tool_kind == "app_tool":
                entered.set()
                self.assertTrue(release.wait(5))
            return GateDecision.ALLOW
        def after(unused):
            if phase == "after":
                entered.set()
                self.assertTrue(release.wait(5))
        if phase == "native":
            self.app.entered, self.app.release = entered, release
        runtime = self.runtime(before=before, after=after)
        child = self.child(runtime)
        first, queued = self.action(runtime, child), self.action(runtime, child, arguments={"value": "queued"})
        outcomes = []
        def dispatch(ticket):
            try:
                outcomes.append(runtime.dispatch(ticket)["status"])
            except A2AContractError as error:
                outcomes.append(str(error))
        active = threading.Thread(target=dispatch, args=(first,))
        waiting = threading.Thread(target=dispatch, args=(queued,))
        closer = threading.Thread(target=runtime.close)
        active.start()
        self.assertTrue(entered.wait(5))
        waiting.start()
        closer.start()
        try:
            deadline = time.monotonic() + 3
            while not runtime.snapshot()["closed"] and time.monotonic() < deadline:
                time.sleep(0.005)
            snapshot = runtime.snapshot()
            self.assertTrue(snapshot["closed"])
            self.assertTrue(closer.is_alive())  # Revoked before waiting for drain.
            with self.assertRaises(A2AContractError):
                runtime.prepare_action(child, {"tool": "Ledger__read", "arguments": {}})
            if phase != "before":
                self.assertEqual(snapshot["ledger"][0]["status"], "unknown")
        finally:
            release.set()
            for thread in (active, waiting, closer):
                thread.join(5)
                self.assertFalse(thread.is_alive())
        self.assertEqual(self.app.values, [] if phase == "before" else ["one"])
        if phase != "before":
            self.assertEqual(runtime.snapshot()["ledger"][0]["status"], "unknown")
            self.assertIn("unknown", outcomes)
        self.assertNotEqual(runtime.snapshot()["children"][0]["state"], "completed")

    def test_08_close_revokes_before_before_native_and_after_queue_drain(self):
        for phase in ("before", "native", "after"):
            with self.subTest(phase=phase):
                self.app = ControlledLedger()
                self.app.register_to_env("controlled-observer", self.events.append)
                self.run_close_race(phase)

    def test_09_registration_start_budget_deadline_cancel_and_terminal_reuse(self):
        runtime = self.runtime()
        child = self.child(runtime, budget=1)
        with self.assertRaisesRegex(A2AContractError, "start_reused"):
            runtime.start_child(child)
        with self.assertRaisesRegex(A2AContractError, "parent_action_consumed"):
            runtime.register_child(app_name="Ledger", parent_action_id="parent-action-1", task="repeat", deadline=1100, max_actions=2)
        runtime.dispatch(self.action(runtime, child, "Ledger__read", {}))
        with self.assertRaisesRegex(A2AContractError, "deadline_or_budget_exhausted"):
            runtime.dispatch(self.action(runtime, child))
        cancelled = self.child(runtime)
        runtime.cancel_child(cancelled)
        with self.assertRaisesRegex(A2AContractError, "child_terminal"):
            runtime.complete_child(cancelled)
        expired = self.child(runtime)
        self.now[0] = 1100
        with self.assertRaisesRegex(A2AContractError, "deadline_expired"):
            self.action(runtime, expired)

    def test_10_local_receipt_hash_order_separate_from_parent_v1(self):
        parent_v1 = {"schemaVersion": "capybara-runtime-plugin-invocation-v1", "sequence": 9,
                     "executionId": "parent-exec", "sessionId": "parent-session", "previousHash": "a" * 64}
        raw_before = json.dumps(parent_v1, sort_keys=True)
        runtime = self.runtime()
        child = self.child(runtime)
        runtime.dispatch(self.action(runtime, child, "final_answer", {"answer": {"done": True}}))
        runtime.complete_child(child)
        receipts = runtime.snapshot()["receipts"]
        previous = None
        for index, receipt in enumerate(receipts, 1):
            body = {key: value for key, value in receipt.items() if key != "sha256"}
            raw = json.dumps(body, sort_keys=True, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            self.assertEqual(receipt["sha256"], hashlib.sha256(raw.encode()).hexdigest())
            self.assertEqual(receipt["previousHash"], previous)
            self.assertEqual(receipt["sequence"], index)
            self.assertEqual(receipt["schemaVersion"], "gaia2-local-child-receipt-v1")
            previous = receipt["sha256"]
        kinds = [receipt["kind"] for receipt in receipts]
        self.assertLess(kinds.index("before_allowed"), kinds.index("native_dispatched"))
        self.assertLess(kinds.index("native_dispatched"), kinds.index("native_return"))
        self.assertLess(kinds.index("native_return"), kinds.index("after_observed"))
        self.assertEqual(json.dumps(parent_v1, sort_keys=True), raw_before)
        self.assertFalse(any(receipt["schemaVersion"] == parent_v1["schemaVersion"] for receipt in receipts))
        with self.assertRaisesRegex(A2AContractError, "child_terminal"):
            runtime.complete_child(child)

    def test_11_production_appagent_is_deliberately_not_connected(self):
        app_agent = AppAgent(app_agent=SequenceModel([]), tools={}, name="Expert")
        with self.assertRaisesRegex(A2AContractError, "production_delegation_disabled"):
            self.runtime(apps={"Expert": app_agent})
        self.assertEqual(self.events, [])

    def test_12_no_boolean_gate_or_cross_app_unknown_authority(self):
        def forged_gate(view):
            return GateDecision.ALLOW if view.tool_kind == "delegation" else True
        runtime = self.runtime(before=forged_gate)
        child = self.child(runtime)
        self.assertEqual(runtime.dispatch(self.action(runtime, child))["status"], "blocked")
        runtime.close()
        self.app = ControlledLedger()
        other_app = ControlledLedger("Other")
        shared = self.runtime(apps={"Ledger": self.app, "Other": other_app})
        old = self.child(shared)
        shared.dispatch(self.action(shared, old, arguments={"value": "uncertain"}))
        other = self.child(shared, app="Other")
        self.assertEqual(shared.dispatch(self.action(shared, other, "Other__write", {"value": "safe"}))["status"], "succeeded")
        self.assertEqual(other_app.values, ["safe"])
        self.assertEqual(shared.snapshot()["ledger"][0]["status"], "unknown")

    def test_13_registration_gate_also_drains_and_cannot_resurrect_after_close(self):
        entered, release = threading.Event(), threading.Event()
        def before(unused):
            entered.set()
            self.assertTrue(release.wait(5))
            return GateDecision.ALLOW
        runtime = self.runtime(before=before)
        errors = []
        def register():
            try:
                self.child(runtime)
            except A2AContractError as error:
                errors.append(str(error))
        registration = threading.Thread(target=register)
        closer = threading.Thread(target=runtime.close)
        registration.start()
        self.assertTrue(entered.wait(5))
        closer.start()
        try:
            deadline = time.monotonic() + 3
            while not runtime.snapshot()["closed"] and time.monotonic() < deadline:
                time.sleep(0.005)
            self.assertTrue(runtime.snapshot()["closed"])
            self.assertTrue(closer.is_alive())
        finally:
            release.set()
            registration.join(5)
            closer.join(5)
        self.assertFalse(registration.is_alive())
        self.assertFalse(closer.is_alive())
        self.assertEqual(errors, ["parent_closed"])
        self.assertEqual(runtime.snapshot()["children"], [])

    def test_14_cancel_pending_write_late_success_retains_unknown(self):
        self.app.entered, self.app.release = threading.Event(), threading.Event()
        runtime = self.runtime()
        child = self.child(runtime)
        result = []
        thread = threading.Thread(target=lambda: result.append(runtime.dispatch(self.action(runtime, child))))
        thread.start()
        self.assertTrue(self.app.entered.wait(5))
        try:
            runtime.cancel_child(child)
            self.assertEqual(runtime.snapshot()["ledger"][0]["status"], "unknown")
        finally:
            self.app.release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result[0]["status"], "unknown")
        self.assertEqual(runtime.snapshot()["children"][0]["state"], "unknown")
        self.assertEqual(runtime.snapshot()["ledger"][0]["status"], "unknown")
        with self.assertRaises(A2AContractError):
            runtime.complete_child(child)

    def test_15_missing_native_event_and_native_prefunction_fault_remain_unknown(self):
        for mode in ("missing_event", "prefunction_fault"):
            with self.subTest(mode=mode):
                app = ControlledLedger("Isolated")
                events = []
                app.register_to_env("test-observer", events.append)
                if mode == "prefunction_fault":
                    app.set_failure_probability(1.0)
                runtime = self.runtime(apps={"Isolated": app})
                child = self.child(runtime, app="Isolated")
                if mode == "missing_event":
                    for key in list(app.add_event_callbacks):
                        if key.startswith("phase5-local-"):
                            del app.add_event_callbacks[key]
                outcome = runtime.dispatch(self.action(runtime, child, "Isolated__write", {"value": "one"}))
                self.assertEqual(outcome["status"], "unknown")
                self.assertEqual(runtime.snapshot()["ledger"][0]["status"], "unknown")
                self.assertEqual(app.values, ["one"] if mode == "missing_event" else [])
                self.assertEqual(len(events), 1 if mode == "missing_event" else 0)

    def test_16_internal_native_event_not_counted_as_second_direct_dispatch(self):
        runtime = self.runtime()
        child = self.child(runtime)
        outcome = runtime.dispatch(self.action(runtime, child, arguments={"value": "helper"}))
        self.assertEqual(outcome["status"], "succeeded")
        self.assertEqual(len(self.events), 2)
        self.assertEqual([event.action.function_name for event in self.events], ["read", "write"])
        projection = runtime.snapshot()
        self.assertEqual(len(projection["children"][0]["actions"]), 1)
        action = projection["children"][0]["actions"][0]
        self.assertEqual(action["observedNativeEventCount"], 2)
        direct = [receipt for receipt in projection["receipts"] if receipt["kind"] == "native_completed_event"]
        self.assertEqual(len(direct), 1)
        self.assertEqual(direct[0]["canonicalTool"], "ControlledLedger__write")
        self.assertEqual(len([view for view in self.gates if view.tool_kind == "app_tool"]), 1)
        self.assertEqual(len(self.afters), 1)

    def test_17_inventory_change_unsafe_json_and_final_dispatch_barrier(self):
        runtime = self.runtime()
        child = self.child(runtime)
        for value in (float("nan"), float("inf"), {"__proto__": True}, "\ud800"):
            with self.subTest(value=repr(value)), self.assertRaises(A2AContractError):
                self.action(runtime, child, arguments={"value": value})
        queued = self.action(runtime, child)
        runtime.dispatch(self.action(runtime, child, "final_answer", {"answer": "done"}))
        with self.assertRaisesRegex(A2AContractError, "child_final_answer_already_dispatched"):
            runtime.dispatch(queued)
        with self.assertRaisesRegex(A2AContractError, "child_final_answer_already_dispatched"):
            self.action(runtime, child)
        runtime.complete_child(child)
        another = self.child(runtime)
        ticket = self.action(runtime, another)
        tool = next(tool for tool in self.app.get_tools() if tool.func_name == "write")
        with patch.object(tool, "write_operation", False):
            with self.assertRaisesRegex(A2AContractError, "tool_inventory_changed"):
                runtime.dispatch(ticket)
        self.assertEqual(self.app.values, [])

    def test_18_last_budget_unit_can_really_end_and_fail_is_terminal(self):
        runtime = self.runtime()
        child = self.child(runtime, budget=1)
        runtime.dispatch(self.action(runtime, child, "final_answer", {"answer": "done"}))
        runtime.complete_child(child)
        other = self.child(runtime)
        runtime.fail_child(other)
        with self.assertRaisesRegex(A2AContractError, "child_terminal"):
            self.action(runtime, other)
        self.assertEqual(runtime.snapshot()["children"][1]["state"], "failed")

    def test_19_clock_rollback_is_sticky_fail_closed(self):
        runtime = self.runtime()
        child = self.child(runtime)
        self.now[0] = 1001.0
        ticket = self.action(runtime, child)
        self.now[0] = 1000.0
        with self.assertRaisesRegex(A2AContractError, "trusted_clock_invalid"):
            runtime.dispatch(ticket)
        self.assertTrue(runtime.snapshot()["clockFailed"])
        self.assertEqual(self.app.values, [])
        self.now[0] = 1002.0
        with self.assertRaises(A2AContractError):
            self.child(runtime)
        with self.assertRaises(A2AContractError):
            runtime.complete_child(child)

    def test_20_owner_tombstone_prevents_unknown_reset_and_close_preserves_env_callback(self):
        env_callback = lambda unused: None
        self.app.register_to_env("real-env", env_callback)
        runtime = self.runtime()
        child = self.child(runtime)
        runtime.dispatch(self.action(runtime, child, arguments={"value": "uncertain"}))
        with self.assertRaisesRegex(A2AContractError, "app_already_owned"):
            self.runtime()
        self.assertTrue(any(key.startswith("phase5-local-") for key in self.app.add_event_callbacks))
        runtime.close()
        self.assertIs(self.app.add_event_callbacks["real-env"], env_callback)
        self.assertIn("controlled-observer", self.app.add_event_callbacks)
        self.assertFalse(any(key.startswith("phase5-local-") for key in self.app.add_event_callbacks))
        self.assertEqual(runtime.snapshot()["ledger"][0]["status"], "unknown")
        with self.assertRaisesRegex(A2AContractError, "app_already_owned"):
            self.runtime(generation="attempted-rebrand")
        fresh = self.runtime(apps={"Ledger": ControlledLedger()}, generation="fresh-env")
        fresh_child = self.child(fresh)
        self.assertEqual(fresh.dispatch(self.action(fresh, fresh_child))["status"], "succeeded")

    def test_21_real_event_return_must_match_actual_forward_return(self):
        runtime = self.runtime()
        child = self.child(runtime)
        tool = next(tool for tool in self.app.get_tools() if tool.func_name == "write")
        with patch.object(tool.function, "llm_formatter", lambda unused: {"changed": True}, create=True):
            result = runtime.dispatch(self.action(runtime, child))
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(self.app.values, ["one"])
        action = runtime.snapshot()["children"][0]["actions"][0]
        self.assertIsNone(action["nativeCompletedEventRef"])
        self.assertEqual(runtime.snapshot()["ledger"][0]["status"], "unknown")

    def test_22_invalid_and_raising_clocks_are_sticky_fail_closed(self):
        for invalid in (True, float("nan"), float("inf"), -1.0, 10 ** 400, "raising"):
            with self.subTest(invalid=repr(invalid)):
                values = [1000.0]
                def clock():
                    if values[0] == "raising":
                        raise RuntimeError("clock unavailable")
                    return values[0]
                app = ControlledLedger()
                runtime = LocalA2ARuntime(apps={"Ledger": app}, environment_generation="clock-test",
                    parent_execution_id="parent", parent_session_id="session", clock=clock,
                    before=lambda unused: GateDecision.ALLOW, after=lambda unused: None)
                child = self.child(runtime)
                ticket = self.action(runtime, child)
                values[0] = invalid
                with self.assertRaisesRegex(A2AContractError, "trusted_clock_invalid"):
                    runtime.dispatch(ticket)
                values[0] = 1001.0
                with self.assertRaises(A2AContractError):
                    self.child(runtime)
                self.assertEqual(app.values, [])
                self.assertTrue(runtime.snapshot()["clockFailed"])
                runtime.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
