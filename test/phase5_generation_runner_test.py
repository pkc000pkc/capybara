"""Offline c2.2b runner integration with a real RUNNING ARE environment.

The SDK, model gate and native dispatch are deterministic private fakes.  The
runner itself uses the real ScopedRetryModelEngine, real ARE pause/resume and
the persisted generation ledger; no provider or official Scenario is called.
"""

from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "test"))

import gaia2_a2a_wire as wire
from gaia2_generation_time import ScopedAREGenerationTimeOwner
from gaia2_generation_time_ledger import ScopedGenerationTimeLedger
from gaia2_model_retry import ModelRetryPolicy
from gaia2_private_native_binding import NativeAppBinding
from gaia2_scoped_app_agent import ScopedAppAgentFatal, build_scoped_app_agent
from gaia2_scoped_model_broker import ScopedRetryModelEngine, scoped_model_config_hash
from are.simulation.apps.contacts import Contact, Contacts
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.types import EnvironmentState

from phase5_scoped_app_agent_test import SyntheticModelAuthority, TrustedFixtureDispatch, action


class Retry503(Exception):
    status_code = 503


class FakeSDK:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(copy.deepcopy(kwargs))
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class Monotonic:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        self.value += 0.25
        return self.value


def response(text: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage={"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5})


def ledger_factory(**kwargs):
    return ScopedGenerationTimeLedger(**kwargs)


class Tests(unittest.TestCase):
    def setUp(self):
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.temp = __import__("tempfile").TemporaryDirectory(prefix="gaia2-generation-runner-")
        self.addCleanup(self.temp.cleanup)
        self.envs = []
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
        for env in self.envs:
            try:
                env.stop()
                if env.thread is not None:
                    env.thread.join(timeout=2)
            except BaseException:
                pass

    def fixture(self, outcomes, owner_factory_override=None, ledger_factory_override=None):
        env = Environment(EnvironmentConfig(start_time=1000, duration=60, verbose=False))
        app = Contacts(contacts={"contact-1": Contact("Local", "User", contact_id="contact-1", is_user=True)})
        env.register_apps([app])
        env.start()
        self.assertIs(env.state, EnvironmentState.RUNNING)
        self.envs.append(env)
        root = Path(self.temp.name) / ("native-" + uuid.uuid4().hex)
        native = NativeAppBinding(app, environment_generation="generation-env", parent_execution_id="generation-parent",
            parent_session_id="generation-session", evidence_root=root, clock=env.time_manager.time,
            trusted_source_files=(ROOT / "scripts/gaia2_scoped_app_agent.py", __file__))
        self.owners.append(native)
        manifest = native.manifest()
        task = "generation integration task"
        scope = {"parentExecutionId": "generation-parent", "parentSessionId": "generation-session",
            "environmentGeneration": "generation-env", "appId": app.name,
            "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
            "toolInventoryHash": manifest["toolInventoryHash"],
            "taskHash": hashlib.sha256(task.encode()).hexdigest(),
            "parentActionId": "parent-" + uuid.uuid4().hex, "requestId": uuid.uuid4().hex,
            "childExecutionId": "child-" + uuid.uuid4().hex, "childSessionId": "session-" + uuid.uuid4().hex,
            "task": task, "deadline": 1000, "maxNativeActions": 10}
        dispatch = TrustedFixtureDispatch(native, scope, root)
        policy = ModelRetryPolicy(max_attempts=2, backoff_base_seconds=0, backoff_max_seconds=0,
            max_retry_wait_seconds=10, request_timeout_seconds=5)
        cfg = lambda: {"model": "generation-fake", "custom_llm_provider": "openai"}
        config_hash = scoped_model_config_hash(cfg(), policy)
        binding = {"schemaVersion": "capybara-scoped-model-scope-v1",
            "delegationScopeHash": wire.value_hash(scope), "modelRole": "child_actor",
            "configHash": config_hash, "maxLogicalRequests": 4, "maxSdkAttempts": 8}
        sdk = FakeSDK(outcomes)
        monotonic = Monotonic()
        engine = ScopedRetryModelEngine(role="child_actor", model_scope_hash=wire.value_hash(binding),
            sdk_completion=sdk, sdk_kwargs_factory=cfg, policy=policy,
            max_logical_requests=4, max_sdk_attempts=8, monotonic_clock=monotonic)
        authority = SyntheticModelAuthority(scope, binding, root)

        def owner_factory():
            return ScopedAREGenerationTimeOwner(env=env, app=app,
                trusted_source_files=(ROOT / "scripts/gaia2_scoped_app_agent.py", __file__))

        owner_factory = owner_factory_override or owner_factory
        trusted_ledger_factory = ledger_factory_override or ledger_factory

        runner = build_scoped_app_agent(app=app, owner=native, env=env, scope=scope, llm_engine=engine,
            dispatch=dispatch, model_binding=binding, model_gate=authority.gate,
            model_attempt=authority.attempt, model_finish=authority.finish,
            generation_time_owner_factory=owner_factory, generation_ledger_factory=trusted_ledger_factory)
        self.runners.append(runner)
        return runner, engine, sdk, authority, dispatch, env

    def test_two_logical_requests_retry_and_persist_finished_ledgers(self):
        outcomes = [Retry503(), response(action("Contacts__get_current_user_details", {})),
            response(action("final_answer", {"answer": "done"}))]
        runner, engine, sdk, authority, dispatch, env = self.fixture(outcomes)
        self.assertEqual(runner.run(), "done")
        self.assertEqual((len(authority.requests), len(authority.attempts), len(authority.finishes)), (2, 3, 2))
        self.assertEqual(len(sdk.calls), 3)
        self.assertIs(env.state, EnvironmentState.RUNNING)
        ledgers = runner._ScopedAppAgentRunner__generation_ledgers
        self.assertEqual(len(ledgers), 2)
        for ledger in ledgers:
            verified = ledger.verify(expected_phase="finished")
            self.assertEqual(verified["phase"], "finished")
            self.assertEqual(len(verified["evidenceRefs"]), 5)
        records = runner.snapshot()["modelRequests"]
        self.assertEqual([record["generationOffsetMode"] for record in records],
            ["successfulSdkElapsedSeconds", "successfulSdkElapsedSeconds"])

    def test_gate_reject_does_not_create_owner_pause_or_ledger(self):
        calls = []
        def owner_factory():
            calls.append(True)
            raise AssertionError("owner factory must not run after rejected gate")
        runner, _engine, _sdk, authority, _dispatch, env = self.fixture(
            [response(action("final_answer", {"answer": "never"}))], owner_factory_override=owner_factory)
        authority.before_block = True
        with self.assertRaises(ScopedAppAgentFatal):
            runner.run()
        self.assertEqual(calls, [])
        self.assertEqual(runner._ScopedAppAgentRunner__generation_ledgers, [])
        self.assertIs(env.state, EnvironmentState.RUNNING)

    def test_sdk_failure_releases_with_zero_cleanup_and_records_failed(self):
        runner, _engine, _sdk, _authority, _dispatch, env = self.fixture([Retry503(), Retry503()])
        with self.assertRaises(ScopedAppAgentFatal):
            runner.run()
        self.assertIs(env.state, EnvironmentState.RUNNING)
        ledgers = runner._ScopedAppAgentRunner__generation_ledgers
        self.assertEqual(len(ledgers), 1)
        self.assertEqual(ledgers[0].phase, "failed")
        failed = ledgers[0].verify(expected_phase="failed")
        self.assertEqual(failed["phase"], "failed")

    def test_unknown_successful_sdk_timing_fails_closed_and_never_delivers_parser_result(self):
        original_get_last_usage = ScopedRetryModelEngine.get_last_usage

        def unknown_timing_usage(engine):
            usage = original_get_last_usage(engine)
            engine._ScopedRetryModelEngine__last_timing = {
                "schemaVersion": "gaia2-scoped-model-timing-v1",
                "logicalElapsedSeconds": None,
                "sdkAttemptElapsedSeconds": None,
                "successfulSdkElapsedSeconds": None,
                "cooldownSeconds": None,
            }
            return usage

        with patch.object(ScopedRetryModelEngine, "get_last_usage", unknown_timing_usage):
            runner, _engine, _sdk, _authority, dispatch, env = self.fixture(
                [response(action("final_answer", {"answer": "must-not-deliver"}))])
            with self.assertRaisesRegex(ScopedAppAgentFatal, "SCOPED_AGENT_GENERATION_TIMING_UNKNOWN"):
                runner.run()
        self.assertIs(env.state, EnvironmentState.RUNNING)
        self.assertEqual(dispatch.calls, [])
        self.assertEqual(len(runner._ScopedAppAgentRunner__generation_ledgers), 1)
        self.assertEqual(runner._ScopedAppAgentRunner__generation_ledgers[0].phase, "failed")
        self.assertNotIn("generationOffset", runner.snapshot()["modelRequests"][0])

    def test_finish_failure_releases_before_failure_terminal(self):
        runner, _engine, _sdk, authority, _dispatch, env = self.fixture(
            [response(action("final_answer", {"answer": "done"}))])
        authority.finish_block = True
        with self.assertRaises(ScopedAppAgentFatal):
            runner.run()
        self.assertIs(env.state, EnvironmentState.RUNNING)
        self.assertEqual(runner._ScopedAppAgentRunner__generation_ledgers[0].phase, "failed")

    def test_finish_ack_then_ledger_failure_never_delivers_parser_result(self):
        created = {}

        def failing_finish_factory(**kwargs):
            generation_ledger = ledger_factory(**kwargs)
            original_model_finished = generation_ledger.model_finished

            def model_finished_then_fail(*, output_hash, usage):
                receipt = original_model_finished(output_hash=output_hash, usage=usage)
                created["receipt"] = copy.deepcopy(receipt)
                raise RuntimeError("ledger write failed after terminal append")

            generation_ledger.model_finished = model_finished_then_fail
            created["ledger"] = generation_ledger
            return generation_ledger

        runner, _engine, _sdk, authority, dispatch, env = self.fixture(
            [response(action("final_answer", {"answer": "acknowledged-but-not-delivered"}))],
            ledger_factory_override=failing_finish_factory)
        with self.assertRaises(ScopedAppAgentFatal):
            runner.run()
        self.assertIs(env.state, EnvironmentState.RUNNING)
        # The Host/model completion ACK is irreversible and was observed, but
        # the official parser must not receive a result after ledger failure.
        self.assertEqual(len(authority.finishes), 1)
        self.assertEqual(dispatch.calls, [])
        self.assertIn("receipt", created)
        self.assertEqual(created["ledger"].phase, "finished")

    def test_reused_owner_factory_is_rejected_on_second_logical_request(self):
        state = {"owner": None}
        def owner_factory():
            if state["owner"] is None:
                env = self.envs[0]
                app = next(iter(env.apps.values()))
                state["owner"] = ScopedAREGenerationTimeOwner(env=env, app=app,
                    trusted_source_files=(ROOT / "scripts/gaia2_scoped_app_agent.py", __file__))
            return state["owner"]
        outcomes = [response(action("Contacts__get_current_user_details", {})),
            response(action("final_answer", {"answer": "done"}))]
        runner, _engine, _sdk, _authority, _dispatch, env = self.fixture(outcomes, owner_factory_override=owner_factory)
        with self.assertRaises(ScopedAppAgentFatal):
            runner.run()
        self.assertIs(env.state, EnvironmentState.RUNNING)
        self.assertEqual(len(runner._ScopedAppAgentRunner__generation_ledgers), 1)

    def test_foreign_owner_factory_is_rejected_without_pause(self):
        foreign = {}
        def owner_factory():
            if "owner" not in foreign:
                other_env = Environment(EnvironmentConfig(start_time=1000, duration=60, verbose=False))
                other_app = Contacts()
                other_env.register_apps([other_app])
                other_env.start()
                self.envs.append(other_env)
                foreign["owner"] = ScopedAREGenerationTimeOwner(env=other_env, app=other_app,
                    trusted_source_files=(ROOT / "scripts/gaia2_scoped_app_agent.py", __file__))
            return foreign["owner"]
        runner, _engine, _sdk, _authority, _dispatch, env = self.fixture(
            [response(action("final_answer", {"answer": "never"}))], owner_factory_override=owner_factory)
        with self.assertRaises(ScopedAppAgentFatal):
            runner.run()
        self.assertIs(env.state, EnvironmentState.RUNNING)
        self.assertEqual(runner._ScopedAppAgentRunner__generation_ledgers, [])

    def test_ledger_tamper_after_release_is_fail_closed(self):
        created = {}
        def tampering_factory(**kwargs):
            ledger = ledger_factory(**kwargs)
            original = ledger.pause_released
            def pause_released(*, lease_id, offset):
                ref = original(lease_id=lease_id, offset=offset)
                path = Path(kwargs["evidence_root"]) / ref["path"]
                raw = path.read_bytes()
                path.write_bytes(raw.replace(b'"offset":', b'"offset":0.0,"tampered":', 1))
                return ref
            ledger.pause_released = pause_released
            created["ledger"] = ledger
            return ledger
        runner, _engine, _sdk, _authority, _dispatch, env = self.fixture(
            [response(action("final_answer", {"answer": "done"}))], ledger_factory_override=tampering_factory)
        with self.assertRaises(ScopedAppAgentFatal):
            runner.run()
        self.assertIs(env.state, EnvironmentState.RUNNING)
        self.assertIs(created["ledger"], runner._ScopedAppAgentRunner__generation_ledgers[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
