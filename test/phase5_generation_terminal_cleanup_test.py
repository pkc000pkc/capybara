"""Offline cleanup ownership checks on real ARE clocks, without providers."""

import hashlib
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

from are.simulation.apps.contacts import Contacts
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.types import EnvironmentState
from gaia2_generation_time import GenerationTimeError, ScopedAREGenerationTimeOwner
from gaia2_generation_time_ledger import GenerationLedgerError


class ResumeSpy:
    def __init__(self, original):
        self.original, self.calls = original, []

    def __call__(self, offset):
        self.calls.append(offset)
        return self.original(offset)


class Tests(unittest.TestCase):
    def setUp(self):
        offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        offline.start()
        self.addCleanup(offline.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-terminal-pause-")
        self.addCleanup(self.temp.cleanup)
        self.envs, self.owners = [], []

    def tearDown(self):
        for owner in self.owners:
            try:
                owner.close()
            except GenerationTimeError:
                pass
        for env in self.envs:
            env.stop()
            # Only the test supervisor may restore deliberately forged pause
            # fields after an ownership-denial case; production must not do it.
            env.time_manager.resume()
            env.pause_event.clear()
            if env.thread is not None:
                env.thread.join(timeout=2)

    def new_owner(self, env, app, *, sources=()):
        owner = ScopedAREGenerationTimeOwner(env=env, app=app,
            trusted_source_files=(Path(__file__), *sources))
        self.owners.append(owner)
        return owner

    def fixture(self, *, sources=()):
        env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
        app = Contacts()
        env.register_apps([app])
        env.time_manager.add_offset(1)
        spy = ResumeSpy(env.resume_with_offset)
        env.resume_with_offset = spy
        env.start()
        self.envs.append(env)
        return env, app, self.new_owner(env, app, sources=sources), spy

    @staticmethod
    def args(index=1):
        return {"scope_hash": hashlib.sha256(f"scope-{index}".encode()).hexdigest(),
            "model_scope_hash": hashlib.sha256(f"model-{index}".encode()).hexdigest(),
            "permit_id": hashlib.sha256(f"permit-{index}".encode()).hexdigest()[:32],
            "request_id": hashlib.sha256(f"request-{index}".encode()).hexdigest()[:32],
            "actual_input_hash": hashlib.sha256(f"input-{index}".encode()).hexdigest()}

    def assert_unpaused(self, env, state):
        self.assertIs(env.state, state)
        self.assertFalse(env.pause_event.is_set())
        self.assertFalse(env.time_manager.is_paused)

    def test_terminal_cleanup_preserves_stop_or_failure_without_environment_resume(self):
        for state in (EnvironmentState.STOPPED, EnvironmentState.FAILED):
            with self.subTest(state=state):
                env, _, owner, spy = self.fixture()
                lease = owner.acquire(**self.args())
                env.stop(final_state=state)
                result = owner.cleanup(lease_id=lease["leaseId"])
                self.assert_unpaused(env, state)
                self.assertTrue(env.stop_event.is_set())
                self.assertEqual(spy.calls, [])
                self.assertTrue(result["released"])
                self.assertTrue(result["cleanup"])
                self.assertEqual(result["offset"], 0)
                self.assertEqual(result["environmentState"], state.value)
                self.assertEqual(owner.cleanup(lease_id=lease["leaseId"]), result)

    def test_successful_sdk_release_then_finally_cleanup_preserves_original_offset_once(self):
        env, _, owner, spy = self.fixture()
        lease = owner.acquire(**self.args())
        try:
            result = owner.release(lease_id=lease["leaseId"], offset=3.0)
        finally:
            cleaned = owner.cleanup(lease_id=lease["leaseId"])
        self.assert_unpaused(env, EnvironmentState.RUNNING)
        self.assertEqual(spy.calls, [3.0])
        self.assertEqual((result["offset"], cleaned["offset"]), (3.0, 3.0))
        self.assertTrue(cleaned["cleanup"])

    def test_failed_sdk_finally_cleans_with_zero_offset_and_no_model_retry(self):
        env, _, owner, spy = self.fixture()
        lease = owner.acquire(**self.args())
        with self.assertRaisesRegex(RuntimeError, "controlled_sdk_failure"):
            try:
                raise RuntimeError("controlled_sdk_failure")
            finally:
                owner.cleanup(lease_id=lease["leaseId"])
        self.assert_unpaused(env, EnvironmentState.RUNNING)
        self.assertEqual(spy.calls, [0.0])
        owner.cleanup(lease_id=lease["leaseId"])
        self.assertEqual(spy.calls, [0.0])

    def test_stopped_sdk_success_cannot_credit_time_or_resume_terminal_environment(self):
        env, _, owner, spy = self.fixture()
        lease = owner.acquire(**self.args())
        env.stop()
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_PAUSE_STATE_CHANGED"):
            try:
                owner.release(lease_id=lease["leaseId"], offset=3.0)
            finally:
                owner.cleanup(lease_id=lease["leaseId"])
        self.assert_unpaused(env, EnvironmentState.STOPPED)
        self.assertEqual(spy.calls, [])

    def test_wrong_or_foreign_lease_cleanup_has_no_pause_side_effect(self):
        env, app, owner, spy = self.fixture()
        lease = owner.acquire(**self.args())
        other = self.new_owner(env, app)
        for actual_owner, lease_id in ((owner, "0" * 32), (other, lease["leaseId"])):
            with self.subTest(owner=actual_owner is owner):
                with self.assertRaisesRegex(GenerationTimeError, "GENERATION_LEASE_NOT_ACTIVE"):
                    actual_owner.cleanup(lease_id=lease_id)
                self.assertIs(env.state, EnvironmentState.PAUSED)
                self.assertTrue(env.time_manager.is_paused)
        self.assertEqual(spy.calls, [])
        owner.cleanup(lease_id=lease["leaseId"])

    def test_released_old_owner_cleanup_does_not_release_new_owner_pause(self):
        env, app, owner, spy = self.fixture()
        first = owner.acquire(**self.args())
        owner.cleanup(lease_id=first["leaseId"])
        other = self.new_owner(env, app)
        second = other.acquire(**self.args(2))
        owner.cleanup(lease_id=first["leaseId"])
        owner.close()
        self.assertIs(env.state, EnvironmentState.PAUSED)
        self.assertTrue(env.pause_event.is_set())
        self.assertEqual(other.snapshot()["lease"]["leaseId"], second["leaseId"])
        self.assertEqual(spy.calls, [0.0])
        other.cleanup(lease_id=second["leaseId"])

    def test_drifted_old_owner_cannot_clear_new_owner_pause_after_emergency_cleanup(self):
        env, app, owner, spy = self.fixture()
        first = owner.acquire(**self.args())
        original = env.resume
        env.resume = lambda: None
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_BINDING_CHANGED"):
            owner.cleanup(lease_id=first["leaseId"])
        self.assert_unpaused(env, EnvironmentState.RUNNING)
        env.resume = original
        other = self.new_owner(env, app)
        second = other.acquire(**self.args(2))
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_BINDING_CHANGED"):
            owner.cleanup(lease_id=first["leaseId"])
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_OWNER_FAILED"):
            owner.close()
        self.assertIs(env.state, EnvironmentState.PAUSED)
        self.assertEqual(other.snapshot()["lease"]["leaseId"], second["leaseId"])
        self.assertEqual(spy.calls, [])
        other.cleanup(lease_id=second["leaseId"])

    def test_terminal_source_drift_stays_primary_over_ledger_error_after_physical_cleanup(self):
        source = Path(self.temp.name) / "factory.txt"
        source.write_text("original", encoding="utf-8")
        env, _, owner, spy = self.fixture(sources=(source,))
        lease = owner.acquire(**self.args())
        source.write_text("changed", encoding="utf-8")
        env.stop(final_state=EnvironmentState.FAILED)
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_SOURCE_CHANGED"):
            try:
                raise GenerationLedgerError("GENERATION_LEDGER_WRITE_FAILED")
            finally:
                owner.cleanup(lease_id=lease["leaseId"])
        self.assert_unpaused(env, EnvironmentState.FAILED)
        self.assertEqual(spy.calls, [])
        source.write_text("original", encoding="utf-8")
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_SOURCE_CHANGED"):
            owner.cleanup(lease_id=lease["leaseId"])
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_SOURCE_CHANGED"):
            owner.snapshot()

    def test_changed_pause_stamp_is_not_restored_as_an_owned_pause(self):
        env, _, owner, spy = self.fixture()
        lease = owner.acquire(**self.args())
        env.time_manager.pause_offset += 1.0
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_PAUSE_CLEANUP_FAILED"):
            owner.cleanup(lease_id=lease["leaseId"])
        self.assertIs(env.state, EnvironmentState.PAUSED)
        self.assertTrue(env.time_manager.is_paused)
        self.assertTrue(env.pause_event.is_set())
        self.assertEqual(env.time_manager.pause_offset, 1.0)
        self.assertEqual(spy.calls, [])

    def test_terminal_shutdown_clearing_pause_event_does_not_leave_owned_clock_paused(self):
        env, _, owner, spy = self.fixture()
        lease = owner.acquire(**self.args())
        env.stop()
        env.pause_event.clear()
        self.assertTrue(env.time_manager.is_paused)
        owner.cleanup(lease_id=lease["leaseId"])
        self.assert_unpaused(env, EnvironmentState.STOPPED)
        self.assertTrue(env.stop_event.is_set())
        self.assertEqual(spy.calls, [])

    def test_stop_during_partial_acquire_preserves_terminal_state_and_unpauses(self):
        env, _, owner, spy = self.fixture()
        original = env.time_manager.pause

        def pause_stop_then_fail():
            original()
            env.stop(final_state=EnvironmentState.FAILED)
            env.pause_event.clear()
            raise RuntimeError("controlled_pause_failure")

        env.time_manager.pause = pause_stop_then_fail
        try:
            with self.assertRaisesRegex(GenerationTimeError, "GENERATION_PAUSE_FAILED"):
                owner.acquire(**self.args())
        finally:
            env.time_manager.pause = original
        self.assert_unpaused(env, EnvironmentState.FAILED)
        self.assertTrue(env.stop_event.is_set())
        self.assertEqual(spy.calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
