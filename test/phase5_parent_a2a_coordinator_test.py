"""5.2d0 trusted parent -> child coordinator seam.

These tests use a real ARE ``Environment``, ``NativeAppBinding`` and
``ScopedAppAgentRunner`` with a finite controlled engine.  They do not call a
provider, official Scenario, Node/TS process, or network.  The suite proves
the lazy gate boundary and cleanup ordering only; it is not a production A2A
claim.
"""

from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import gaia2_a2a_wire as wire
from gaia2_parent_a2a_coordinator import ParentA2AError, ParentA2ACoordinator
from gaia2_private_native_binding import NativeAppBinding
from gaia2_scoped_app_agent import ControlledAppAgentEngine, build_scoped_app_agent
from gaia2_notification_producer import ScopedNotificationOriginRegistry
from are.simulation.apps.contacts import Contact, Contacts
from are.simulation.environment import Environment, EnvironmentConfig


def action(name: str, arguments: dict) -> str:
    return "Thought: controlled\nAction:\n" + json.dumps(
        {"action": name, "action_input": arguments}, ensure_ascii=False,
        separators=(",", ":")) + "<end_action>"


class NoBindTrustedDispatch:
    """The established fixture dispatch with owner.bind_child left to d0."""

    def __init__(self, owner, scope, root):
        self.owner, self.scope, self.root = owner, scope, root
        self.scope_hash = wire.value_hash(scope)
        self.tools = {tool["publicName"]: tool for tool in owner.manifest()["tools"]}
        self.calls, self.outcomes = [], []
        self.error = None

    def __call__(self, request):
        self.calls.append(json.loads(json.dumps(request, ensure_ascii=False)))
        tool = self.tools[request["tool"]]
        prepared = self.owner.prepare_native({"scope": self.scope, "toolId": tool["toolId"],
            "rawArguments": request["arguments"]})
        dispatch_id = str(uuid.uuid4())
        self.owner.observe_clock({"scope": self.scope, "ticketId": prepared["ticketId"],
            "dispatchId": dispatch_id, "checkpoint": "before_tool"})
        try:
            outcome = self.owner.commit_native({"scope": self.scope, "ticketId": prepared["ticketId"],
                "dispatchId": dispatch_id, "toolId": tool["toolId"],
                "effectiveArgumentsHash": prepared["effectiveArgumentsHash"]})
        except BaseException as error:
            self.error = getattr(error, "code", type(error).__name__)
            raise
        self.outcomes.append(outcome)
        self.owner.observe_clock({"scope": self.scope, "ticketId": prepared["ticketId"],
            "dispatchId": dispatch_id, "checkpoint": "after_tool"})
        if outcome["status"] != "succeeded":
            raise RuntimeError("controlled_native_failed")
        final = tool["toolKind"] == "child_final_answer"
        ref = None
        if final:
            receipt = {"schemaVersion": "capybara-runtime-delegation-receipt-v1",
                "environmentGeneration": self.scope["environmentGeneration"],
                "parentExecutionId": self.scope["parentExecutionId"],
                "parentSessionId": self.scope["parentSessionId"], "sequence": 1,
                "previousHash": None, "kind": "completed",
                "data": {"scope": self.scope, "finalDispatchId": dispatch_id,
                          "finalEvidence": {"fixtureOnly": True}}}
            data = json.dumps(receipt, ensure_ascii=False, separators=(",", ":")).encode()
            path = self.root / ("controlled-completed-" + uuid.uuid4().hex + ".json")
            path.write_bytes(data)
            ref = {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}
        return {"schemaVersion": "capybara-scoped-agent-dispatch-v1",
            "scopeHash": self.scope_hash, "dispatchId": dispatch_id,
            "toolId": tool["toolId"], "toolKind": tool["toolKind"],
            "status": "completed", "childCompleted": final,
            "completionEvidenceRef": ref}


class RecorderRunner:
    def __init__(self, result="child complete", *, fail=False):
        self.result, self.fail = result, fail
        self.closed = False
        self.runs = 0

    def run(self):
        self.runs += 1
        if self.fail:
            raise RuntimeError("controlled_child_failure")
        return self.result

    def close(self):
        self.closed = True

    def snapshot(self):
        return {"completed": self.runs > 0 and not self.fail,
                "completionEvidenceRef": "controlled-completion" if self.runs > 0 and not self.fail else None}


class ParentErrorRunner(RecorderRunner):
    def run(self):
        self.runs += 1
        raise ParentA2AError("nested_child_failure")


class CoordinatorTests(unittest.TestCase):
    def setUp(self):
        self.no_network = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.no_network.start()
        self.addCleanup(self.no_network.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-parent-a2a-")
        self.addCleanup(self.temp.cleanup)
        contact = Contact("Local", "User", contact_id="contact-1", is_user=True)
        self.app = Contacts(contacts={contact.contact_id: contact})
        self.env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        self.env.register_apps([self.app])
        self.owner = NativeAppBinding(self.app, environment_generation="environment-1",
            parent_execution_id="parent-exec", parent_session_id="parent-session",
            evidence_root=Path(self.temp.name) / "owner-evidence", clock=self.env.time_manager.time,
            clock_environment=self.env,
            trusted_source_files=(ROOT / "scripts" / "gaia2_scoped_app_agent.py", __file__))
        self.addCleanup(self.owner.close)
        self.registry = ScopedNotificationOriginRegistry()
        self.factories = []
        self.coordinator = None

    def make_coordinator(self, factory):
        self.coordinator = ParentA2ACoordinator(env=self.env, owner=self.owner,
            registry=self.registry, child_factory=factory, child_deadline_seconds=600,
            max_native_actions=5)
        self.addCleanup(lambda: self.coordinator.close() if self.coordinator is not None else None)
        return self.coordinator

    @staticmethod
    def parent_action(task="Read the current contact"):
        return {"id": "parent-action-" + uuid.uuid4().hex,
                "canonicalName": "AppAgent__expert_agent",
                "arguments": {"task": task}}

    @staticmethod
    def allow():
        return {"decision": {"action": "allow", "reason": "controlled parent allow"}}

    def test_gate_is_required_and_scope_is_lazy(self):
        def factory(**kwargs):
            self.factories.append(kwargs)
            return RecorderRunner()
        coordinator = self.make_coordinator(factory)
        with self.assertRaisesRegex(ParentA2AError, "PARENT_GATE_NOT_ALLOWED"):
            coordinator.begin_child(action=self.parent_action(), parent_gate={"decision": {"action": "block", "reason": "no"}})
        self.assertEqual(self.factories, [])
        self.assertEqual(self.registry.snapshot()["activeOrigins"], 0)
        handle = coordinator.begin_child(action=self.parent_action(), parent_gate=self.allow())
        self.assertEqual(len(self.factories), 1)
        self.assertEqual(handle.scope["parentCanonicalName"], "AppAgent__expert_agent")
        self.assertEqual(handle.scope["taskHash"], hashlib.sha256(handle.scope["task"].encode()).hexdigest())
        self.assertEqual(handle.scope_hash, wire.value_hash(handle.scope))
        self.assertEqual(self.registry.snapshot()["activeOrigins"], 1)
        coordinator.close()

    def test_real_scoped_runner_runs_after_coordinator_bind(self):
        def factory(*, scope, notification_reader):
            dispatch = NoBindTrustedDispatch(self.owner, scope, Path(self.temp.name))
            engine = ControlledAppAgentEngine([
                action("Contacts__get_current_user_details", {}),
                action("final_answer", {"answer": "child complete"}),
            ])
            runner = build_scoped_app_agent(app=self.app, owner=self.owner, env=self.env,
                scope=scope, llm_engine=engine, dispatch=dispatch,
                notification_reader=notification_reader)
            self.factories.append((runner, dispatch, engine))
            return runner
        coordinator = self.make_coordinator(factory)
        handle = coordinator.begin_child(action=self.parent_action(), parent_gate=self.allow())
        self.assertEqual(coordinator.run_child(handle), "child complete")
        runner, dispatch, engine = self.factories[0]
        self.assertEqual(len(dispatch.calls), 2)
        self.assertEqual(len(dispatch.outcomes), 2)
        self.assertEqual(engine.calls, 2)
        self.assertTrue(runner.snapshot()["completed"])
        self.assertTrue(runner.snapshot()["completionEvidenceRef"])
        self.assertTrue(runner.snapshot()["notificationReader"]["closed"])
        self.assertEqual(coordinator.snapshot()["children"][0]["status"], "completed")
        self.assertTrue(coordinator.snapshot()["children"][0]["lifecycle"]["originRevoked"])

    def test_child_failure_revokes_owner_and_reader(self):
        holder = {}
        def factory(**kwargs):
            holder["runner"] = RecorderRunner(fail=True)
            return holder["runner"]
        coordinator = self.make_coordinator(factory)
        handle = coordinator.begin_child(action=self.parent_action(), parent_gate=self.allow())
        with self.assertRaisesRegex(ParentA2AError, "CHILD_RUN_FAILED"):
            coordinator.run_child(handle)
        self.assertTrue(holder["runner"].closed)
        self.assertTrue(handle.lifecycle.snapshot()["closed"])
        self.assertTrue(handle.lifecycle.snapshot()["originRevoked"])
        self.assertEqual(coordinator.snapshot()["children"][0]["status"], "failed")

    def test_parent_error_from_runner_is_sanitized_and_cleaned(self):
        holder = {}
        def factory(**kwargs):
            holder["runner"] = ParentErrorRunner()
            return holder["runner"]
        coordinator = self.make_coordinator(factory)
        handle = coordinator.begin_child(action=self.parent_action(), parent_gate=self.allow())
        with self.assertRaisesRegex(ParentA2AError, "CHILD_RUN_FAILED"):
            coordinator.run_child(handle)
        self.assertTrue(holder["runner"].closed)
        self.assertTrue(handle.lifecycle.snapshot()["closed"])
        self.assertTrue(handle.lifecycle.snapshot()["originRevoked"])

    def test_parent_close_and_stop_revoke_before_runner_cleanup(self):
        for reason in ("parent_close", "stop"):
            with self.subTest(reason=reason):
                local = []
                def factory(**kwargs):
                    runner = RecorderRunner()
                    local.append(runner)
                    return runner
                # A fresh owner/app is required for each child because native
                # parent_action IDs and child scopes are single-use.
                coordinator = self.make_coordinator(factory) if self.coordinator is None else ParentA2ACoordinator(
                    env=self.env, owner=self.owner, registry=self.registry, child_factory=factory)
                handle = coordinator.begin_child(action=self.parent_action(), parent_gate=self.allow())
                coordinator.close(reason)
                self.assertTrue(local[-1].closed)
                self.assertTrue(handle.lifecycle.snapshot()["closed"])
                self.assertTrue(handle.lifecycle.snapshot()["originRevoked"])
                self.assertEqual(handle.lifecycle.snapshot()["closeReason"], reason if reason == "stop" else reason)
                with self.assertRaisesRegex(ParentA2AError, "CHILD_HANDLE_INVALID"):
                    coordinator.run_child(handle)
                if coordinator is not self.coordinator:
                    coordinator.close()
                self.coordinator = None

    def test_factory_failure_cleans_owner_and_origin(self):
        def factory(**kwargs):
            raise RuntimeError("controlled_factory_failure")
        coordinator = self.make_coordinator(factory)
        with self.assertRaisesRegex(ParentA2AError, "CHILD_FACTORY_FAILED"):
            coordinator.begin_child(action=self.parent_action(), parent_gate=self.allow())
        self.assertEqual(self.registry.snapshot()["activeOrigins"], 0)
        self.assertEqual(self.registry.snapshot()["revokedOrigins"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
