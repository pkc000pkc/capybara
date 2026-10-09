"""5.2d2 production-like trusted child factory wiring.

This is still an offline controlled slice: the parent bridge/provider and
official Scenario are not replaced.  It proves that the explicit factory
configuration creates the real native owner, coordinator, lifecycle reader,
and scoped child runner, and that STOP/parent cleanup revokes authority.
"""

from pathlib import Path
import copy
import hashlib
import json
import socket
import sys
import tempfile
import unittest
import uuid
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "test"))

from are.simulation.apps.contacts import Contact, Contacts
from are.simulation.environment import Environment, EnvironmentConfig
from gaia2_private_native_binding import NativeAppBinding
from gaia2_notification_producer import ScopedNotificationOriginRegistry
from gaia2_production_delegation import (
    ProductionDelegationError,
    make_production_delegation_factory,
)
from gaia2_scoped_app_agent import ControlledAppAgentEngine, build_scoped_app_agent
import capybara_official_bridge as bridge
from phase5_parent_a2a_coordinator_test import NoBindTrustedDispatch, action
from phase3_live_bridge_test import response, setup_scenario


class ProductionDelegationTests(unittest.TestCase):
    def setUp(self):
        self.network = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-5-2d2-production-")
        self.addCleanup(self.temp.cleanup)
        contact = Contact("Local", "User", contact_id="contact-1", is_user=True)
        self.app = Contacts(contacts={contact.contact_id: contact})
        self.env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        self.env.register_apps([self.app])
        self.owners = []
        self.runners = []

    def tearDown(self):
        for runner in self.runners:
            try:
                runner.close()
            except BaseException:
                pass
        for owner in self.owners:
            try:
                owner.close()
            except BaseException:
                pass

    def owner_factory(self, env, scenario_id):
        self.assertIs(env, self.env)
        self.assertEqual(scenario_id, "phase5-2d2")
        owner = NativeAppBinding(
            self.app, environment_generation="environment-1",
            parent_execution_id="parent-exec-" + uuid.uuid4().hex,
            parent_session_id="parent-session-" + uuid.uuid4().hex,
            evidence_root=Path(self.temp.name) / ("owner-" + uuid.uuid4().hex),
            clock=env.time_manager.time, clock_environment=env,
            trusted_source_files=(ROOT / "scripts" / "gaia2_scoped_app_agent.py", __file__),
        )
        self.owners.append(owner)
        return owner

    def child_factory(self, env, scenario_id, owner, scope, notification_reader):
        self.assertIs(env, self.env)
        self.assertEqual(scenario_id, "phase5-2d2")
        self.assertIs(owner, self.owners[-1])
        dispatch = NoBindTrustedDispatch(owner, scope, Path(self.temp.name))
        engine = ControlledAppAgentEngine([
            action("Contacts__get_current_user_details", {}),
            action("final_answer", {"answer": "production-like child complete"}),
        ])
        runner = build_scoped_app_agent(
            app=self.app, owner=owner, env=env, scope=scope,
            llm_engine=engine, dispatch=dispatch,
            notification_reader=notification_reader,
        )
        self.runners.append(runner)
        return runner

    @staticmethod
    def parent_action():
        return {"id": "parent-action-" + uuid.uuid4().hex,
                "canonicalName": "AppAgent__expert_agent",
                "arguments": {"task": "Read the current contact"}}

    @staticmethod
    def allow():
        return {"decision": {"action": "allow", "reason": "trusted 5.2d2 test gate"}}

    def test_factory_builds_real_owner_lifecycle_reader_and_child(self):
        factory = make_production_delegation_factory(
            owner_factory=self.owner_factory, child_factory=self.child_factory,
            max_native_actions=5,
        )
        handle = factory(self.env, "phase5-2d2")
        child = handle.begin_child(action=self.parent_action(), parent_gate=self.allow())
        self.assertEqual(handle.run_child(child), "production-like child complete")
        runner = self.runners[-1]
        snapshot = runner.snapshot()
        self.assertTrue(snapshot["completed"])
        self.assertTrue(snapshot["completionEvidenceRef"])
        self.assertTrue(snapshot["notificationReader"]["closed"])
        self.assertEqual(handle.snapshot()["coordinator"]["children"][0]["status"], "completed")
        handle.close("parent_close")
        with self.assertRaises(Exception):
            self.owners[-1].manifest()

    def test_stop_closes_runner_and_owner(self):
        factory = make_production_delegation_factory(
            owner_factory=self.owner_factory, child_factory=self.child_factory,
        )
        handle = factory(self.env, "phase5-2d2")
        child = handle.begin_child(action=self.parent_action(), parent_gate=self.allow())
        handle.close("stop")
        self.assertTrue(self.runners[-1].snapshot()["closed"])
        self.assertTrue(child.lifecycle.snapshot()["closed"])
        self.assertTrue(child.lifecycle.snapshot()["originRevoked"])
        with self.assertRaises(Exception):
            self.owners[-1].manifest()
        # close is idempotent and does not re-enter the owner.
        handle.close("parent_close")

    def test_owner_factory_must_pin_exact_environment(self):
        foreign = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        foreign_app = Contacts(contacts={"foreign": Contact("Foreign", "User", contact_id="foreign", is_user=True)})
        foreign.register_apps([foreign_app])
        def foreign_owner(_env, _scenario):
            return NativeAppBinding(
                foreign_app, environment_generation="environment-1",
                parent_execution_id="foreign-exec", parent_session_id="foreign-session",
                evidence_root=Path(self.temp.name) / "foreign-owner",
                clock=foreign.time_manager.time, clock_environment=foreign,
                trusted_source_files=(ROOT / "scripts" / "gaia2_scoped_app_agent.py", __file__),
            )
        factory = make_production_delegation_factory(
            owner_factory=foreign_owner, child_factory=self.child_factory,
        )
        with self.assertRaisesRegex(ProductionDelegationError, "PRODUCTION_OWNER_INVALID"):
            factory(self.env, "phase5-2d2")

    def test_native_bridge_invokes_factory_only_after_parent_allow(self):
        """The bridge path uses the real coordinator, not a coordinator double."""
        scenario, env, _aui, _system, _ledger = setup_scenario()
        inner = Contacts(contacts={"contact-1": Contact("Local", "User", contact_id="contact-1", is_user=True)})
        env.register_apps([inner])
        delegated = __import__("are.simulation.agents.default_agent.app_agent",
                               fromlist=["AppAgent"]).AppAgent(inner, {}, "DelegatedLedger")
        scenario.apps.append(delegated)
        env.register_apps([delegated])
        owners = []

        def owner_factory(run_env, _scenario_id):
            owner = NativeAppBinding(
                inner, environment_generation="environment-1",
                parent_execution_id="bridge-parent-" + uuid.uuid4().hex,
                parent_session_id="bridge-session-" + uuid.uuid4().hex,
                evidence_root=Path(self.temp.name) / ("bridge-owner-" + uuid.uuid4().hex),
                clock=run_env.time_manager.time, clock_environment=run_env,
                trusted_source_files=(ROOT / "scripts" / "gaia2_scoped_app_agent.py", __file__),
            )
            owners.append(owner)
            return owner

        def child_factory(run_env, _scenario_id, owner, scope, notification_reader):
            dispatch = NoBindTrustedDispatch(owner, scope, Path(self.temp.name))
            runner = build_scoped_app_agent(
                app=inner, owner=owner, env=run_env, scope=scope,
                llm_engine=ControlledAppAgentEngine([
                    action("Contacts__get_current_user_details", {}),
                    action("final_answer", {"answer": "bridge child complete"}),
                ]),
                dispatch=dispatch, notification_reader=notification_reader,
            )
            self.runners.append(runner)
            return runner

        hooks = []
        events = []

        def hook(_client, checkpoint, _env, _messages, revision, _iteration,
                 *, action=None, outcome=None, terminal=False, termination_reason=None):
            hooks.append((checkpoint, copy.deepcopy(action), copy.deepcopy(outcome)))
            context = "trusted bridge production-like context"
            return {"decision": {"action": "allow", "reason": "controlled production gate"},
                    "context": context,
                    "contextHash": hashlib.sha256(context.encode()).hexdigest(),
                    "variablesHash": hashlib.sha256(b"{}").hexdigest(),
                    "hookReceipts": [{"checkpoint": checkpoint}], "revision": revision,
                    "evidencePath": "controlled://phase5-2d2"}

        steps = [
            response("DelegatedLedger__expert_agent", {"task": "Read the current contact"}, call_id="child-call"),
            response("AgentUserInterface__send_message_to_user", {"content": "parent complete"}, call_id="finish"),
        ]

        def model(*_args, **_kwargs):
            return steps.pop(0)

        with patch.object(bridge, "RuntimeHookClient", lambda: object()), \
             patch.object(bridge, "_invoke_hook", hook), \
             patch.object(bridge, "_emit_runtime_event", lambda kind, **data: events.append({"type": kind, **data})), \
             patch.object(bridge, "_call_model", model), \
             patch.object(bridge, "_delegation_coordinator_factory", None), \
             patch.object(bridge, "_delegation_coordinator_configured", False):
            # Explicit adapter configuration is the only way this production-
            # like branch becomes reachable; Actor/model input cannot install it.
            bridge.configure_production_delegation_bridge(
                owner_factory=owner_factory, child_factory=child_factory,
                max_native_actions=5,
            )
            result = bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env,
                                                   "default", "controlled-no-model")
        self.assertTrue(result.success)
        self.assertEqual(len(owners), 1)
        self.assertEqual(len(self.runners), 1)
        self.assertTrue(any(event["type"] == "delegation_completed" for event in events))
        self.assertEqual([name for name, _, _ in hooks if name == "before_tool"], ["before_tool", "before_tool"])
        self.assertEqual(
            [event.action.function_name for event in env.event_log.list_view()].count("get_current_user_details"),
            1,
        )
        with self.assertRaises(Exception):
            owners[0].manifest()


if __name__ == "__main__":
    unittest.main(verbosity=2)
