"""5.2d1 controlled bridge seam for the nested AppAgent action.

The tests exercise only the parent bridge's trusted coordinator hook.  The
child itself is represented by a deterministic coordinator double; no model
provider, official Scenario runner, Node/TS pipe, or production transport is
claimed here.
"""

from pathlib import Path
import copy
import hashlib
import json
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "test"))
sys.path.insert(0, str(ROOT / ".official-python"))

import capybara_official_bridge as bridge
from gaia2_runtime_hooks import HookProtocolError
from are.simulation.agents.default_agent.app_agent import AppAgent

from phase3_live_bridge_test import response, setup_scenario


class TrustedCoordinatorDouble:
    """Minimal trusted protocol; Actor input never sees this object."""

    def __init__(self, env, trace):
        self.environment = env
        self.trace = trace
        self.begin_calls = []
        self.run_calls = []
        self.close_calls = []

    def begin_child(self, *, action, parent_gate):
        self.trace.append(("begin_child", action["id"], parent_gate["decision"]["action"]))
        self.begin_calls.append((copy.deepcopy(action), copy.deepcopy(parent_gate)))
        return object()

    def run_child(self, handle):
        self.trace.append(("run_child", handle))
        self.run_calls.append(handle)
        return "trusted child result"

    def close(self, reason):
        self.trace.append(("close", reason))
        self.close_calls.append(reason)


class BridgeDelegationTests(unittest.TestCase):
    @staticmethod
    def hook_response(checkpoint, payload, *, decision="allow"):
        context = "controlled delegated context"
        return {
            "decision": {"action": decision, "reason": "controlled decision"},
            "context": context,
            "contextHash": hashlib.sha256(context.encode()).hexdigest(),
            "variablesHash": hashlib.sha256(b"{}").hexdigest(),
            "hookReceipts": [{"checkpoint": checkpoint}],
            "revision": payload.get("clock", {}).get("revision", 0),
            "evidencePath": "controlled://phase5-2d1",
        }

    def run_with(self, scenario, env, coordinator, responses, *, decisions=None):
        events = []
        hooks = []
        steps = list(responses)
        decisions = list(decisions or [])

        def invoke(_client, checkpoint, _env, _messages, revision, _iteration,
                   *, action=None, outcome=None, terminal=False,
                   termination_reason=None):
            payload = {"clock": {"revision": revision}}
            hooks.append((checkpoint, copy.deepcopy(action), copy.deepcopy(outcome)))
            decision = decisions.pop(0) if checkpoint == "before_tool" and decisions else "allow"
            return self.hook_response(checkpoint, payload, decision=decision)

        def model(*_args, **_kwargs):
            self.assertTrue(steps, "controlled actor unexpectedly continued")
            return steps.pop(0)

        with patch.object(bridge, "RuntimeHookClient", lambda: object()), \
             patch.object(bridge, "_invoke_hook", invoke), \
             patch.object(bridge, "_emit_runtime_event", lambda kind, **data: events.append({"type": kind, **data})), \
             patch.object(bridge, "_call_model", model), \
             patch.object(bridge, "_delegation_coordinator_factory", lambda _env, _scenario_id: coordinator):
            result = bridge._native_run_with_agent(
                None, scenario.scenario_id, scenario, env, "default", "controlled-no-model")
        return result, events, hooks

    def delegated_scenario(self):
        scenario, env, aui, _system, _ledger = setup_scenario()
        inner = SimpleNamespace(run=Mock())
        delegated = AppAgent(inner, {}, "DelegatedLedger")
        scenario.apps.append(delegated)
        env.register_apps([delegated])
        return scenario, env, delegated, inner

    def test_expert_branch_requires_live_parent_allow_and_runs_once(self):
        scenario, env, delegated, inner = self.delegated_scenario()
        trace = []
        coordinator = TrustedCoordinatorDouble(env, trace)
        tool_name = delegated.get_tools()[0]._public_name
        responses = [
            response(tool_name, {"task": "perform trusted child work"}, call_id="child-call"),
            response("AgentUserInterface__send_message_to_user", {"content": "parent complete"}, call_id="finish"),
        ]
        result, events, hooks = self.run_with(scenario, env, coordinator, responses)
        self.assertTrue(result.success)
        self.assertEqual(len(coordinator.begin_calls), 1)
        self.assertEqual(len(coordinator.run_calls), 1)
        self.assertEqual(coordinator.close_calls, ["parent_close"])
        self.assertEqual(coordinator.begin_calls[0][0]["canonicalName"], "AppAgent__expert_agent")
        self.assertEqual(coordinator.begin_calls[0][1]["decision"]["action"], "allow")
        self.assertEqual(inner.run.call_count, 0)
        self.assertIn(("begin_child", "child-call", "allow"), trace)
        self.assertIn(("run_child", coordinator.run_calls[0]), trace)
        self.assertEqual([item[0] for item in hooks if item[0] == "before_tool"],
                         ["before_tool", "before_tool"])
        self.assertTrue(any(item["type"] == "delegation_completed" for item in events))

    def test_expert_branch_never_creates_child_when_parent_gate_blocks(self):
        scenario, env, delegated, inner = self.delegated_scenario()
        trace = []
        coordinator = TrustedCoordinatorDouble(env, trace)
        tool_name = delegated.get_tools()[0]._public_name
        responses = [
            response(tool_name, {"task": "blocked child work"}, call_id="blocked-child"),
            response("AgentUserInterface__send_message_to_user", {"content": "parent replanned"}, call_id="finish"),
        ]
        result, events, hooks = self.run_with(scenario, env, coordinator, responses,
                                              decisions=["block", "allow"])
        self.assertTrue(result.success)
        self.assertEqual(coordinator.begin_calls, [])
        self.assertEqual(coordinator.run_calls, [])
        self.assertEqual(inner.run.call_count, 0)
        blocked = [item for item in events if item["type"] == "tool_call_blocked"]
        self.assertEqual(len(blocked), 1)
        self.assertEqual(blocked[0]["reason"], "hook_blocked")

    def test_factory_result_is_pinned_to_exact_environment_and_protocol(self):
        scenario, env, _delegated, _inner = self.delegated_scenario()
        with patch.object(bridge, "_delegation_coordinator_factory", lambda *_: object()):
            with self.assertRaisesRegex(HookProtocolError, "invalid_delegation_coordinator"):
                bridge._delegation_coordinator_for_run(env, scenario.scenario_id)
        foreign = object()
        class WrongEnvironment(TrustedCoordinatorDouble):
            pass
        coordinator = WrongEnvironment(foreign, [])
        with patch.object(bridge, "_delegation_coordinator_factory", lambda *_: coordinator):
            with self.assertRaisesRegex(HookProtocolError, "invalid_delegation_coordinator"):
                bridge._delegation_coordinator_for_run(env, scenario.scenario_id)

    def test_configuration_is_one_time_and_not_actor_selectable(self):
        with patch.object(bridge, "_delegation_coordinator_factory", None), \
             patch.object(bridge, "_delegation_coordinator_configured", False):
            bridge.configure_delegation_bridge(lambda *_: None)
            self.assertTrue(bridge._delegation_coordinator_configured)
            with self.assertRaisesRegex(HookProtocolError, "delegation_factory_reconfiguration"):
                bridge.configure_delegation_bridge(lambda *_: None)

    def test_child_format_diagnostic_projection_is_parent_visible_but_answer_blind(self):
        projected = bridge._safe_a2a_child_diagnostic({
            "failureCode": "SCOPED_AGENT_FORMAT_FAILURE_THRESHOLD",
            "failed": True, "completed": False,
            "formatFailureCount": 3, "consecutiveFormatFailures": 3,
            "originalObservationsTaken": 0, "modelCalls": 3, "engineCalls": 3,
            "lastFormatFailureCode": "missing_action",
            "lastFormatFailure": {
                "schemaVersion": "gaia2-a2a-child-diagnostic-v1", "kind": "parse_failure",
                "failureCode": "missing_action", "outputHash": "a" * 64, "errorHash": "b" * 64,
                "executionId": "child", "sessionId": "session", "requestId": "request",
                "sequence": 3, "iteration": 3, "consecutiveFormatFailures": 3,
                "formatFailureCount": 3, "logicalRequests": 3, "nativeActionCount": 0,
                "recoverable": False,
            },
            "rawModelOutput": "private model content must not cross the parent boundary",
        })
        self.assertEqual(projected["schemaVersion"], "gaia2-a2a-child-diagnostic-v1")
        self.assertEqual(projected["failureCode"], "SCOPED_AGENT_FORMAT_FAILURE_THRESHOLD")
        self.assertEqual(projected["consecutiveFormatFailures"], 3)
        self.assertEqual(projected["nativeActionCount"], 0)
        self.assertNotIn("rawModelOutput", projected)
        self.assertNotIn("private model content", json.dumps(projected))


if __name__ == "__main__":
    unittest.main(verbosity=2)
