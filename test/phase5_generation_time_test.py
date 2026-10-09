"""Offline tests for the trusted ARE generation-time pause lease owner."""

from __future__ import annotations

import hashlib
from pathlib import Path
import socket
import sys
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

from are.simulation.apps.contacts import Contact, Contacts
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.types import EnvironmentState
from gaia2_generation_time import GenerationTimeError, ScopedAREGenerationTimeOwner


class Tests(unittest.TestCase):
    def setUp(self):
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.envs: list[Environment] = []

    def tearDown(self):
        for env in self.envs:
            try:
                env.stop()
                if env.thread is not None:
                    env.thread.join(timeout=2)
            except BaseException:
                pass

    def fixture(self, *, start: bool = True):
        env = Environment(EnvironmentConfig(start_time=1000, duration=60, verbose=False))
        app = Contacts(contacts={"contact-1": Contact("Old", "Fixture", contact_id="contact-1")})
        env.register_apps([app])
        # Keep this real ARE setup deterministic without replacing its clock.
        env.time_manager.add_offset(1)
        self.envs.append(env)
        if start:
            env.start()
            self.assertIs(env.state, EnvironmentState.RUNNING)
        owner = ScopedAREGenerationTimeOwner(env=env, app=app, trusted_source_files=(Path(__file__),))
        return env, app, owner

    @staticmethod
    def args(index: int = 1):
        return {"scope_hash": hashlib.sha256(f"scope-{index}".encode()).hexdigest(),
            "model_scope_hash": hashlib.sha256(f"model-{index}".encode()).hexdigest(),
            "permit_id": hashlib.sha256(f"permit-{index}".encode()).hexdigest()[:32],
            "request_id": hashlib.sha256(f"request-{index}".encode()).hexdigest()[:32],
            "actual_input_hash": hashlib.sha256(f"input-{index}".encode()).hexdigest()}

    def test_01_real_running_pause_resume_once_with_owner_metadata(self):
        env, _app, owner = self.fixture()
        lease = owner.acquire(**self.args())
        self.assertIs(env.state, EnvironmentState.PAUSED)
        self.assertTrue(env.time_manager.is_paused)
        self.assertGreater(lease["pausePassedTime"], 0)
        self.assertEqual(lease["sourceManifestHash"], owner.source_manifest_hash)
        released = owner.release(lease_id=lease["leaseId"], offset=2)
        self.assertIs(env.state, EnvironmentState.RUNNING)
        self.assertFalse(env.time_manager.is_paused)
        self.assertEqual(released["offset"], 2.0)
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_LEASE_NOT_ACTIVE"):
            owner.release(lease_id=lease["leaseId"], offset=0)
        owner.close()
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_OWNER_CLOSED"):
            owner.close()

    def test_02_not_running_and_external_pause_are_rejected(self):
        env, _app, owner = self.fixture(start=False)
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_ENVIRONMENT_NOT_RUNNING"):
            owner.acquire(**self.args(2))
        env.start()
        env.pause()
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_ENVIRONMENT_NOT_RUNNING"):
            owner.acquire(**self.args(3))
        env.resume()
        owner.close()

    def test_03_only_one_active_lease_per_environment(self):
        env, app, owner = self.fixture()
        other = ScopedAREGenerationTimeOwner(env=env, app=app, trusted_source_files=(Path(__file__),))
        lease = owner.acquire(**self.args(4))
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_ENVIRONMENT_LEASE_ACTIVE"):
            other.acquire(**self.args(5))
        owner.release(lease_id=lease["leaseId"], offset=0)
        other.close()
        owner.close()

    def test_04_environment_method_drift_is_sticky_and_never_resumed(self):
        env, _app, owner = self.fixture()
        original_resume = env.resume
        env.resume = lambda: None
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_BINDING_CHANGED"):
            owner.acquire(**self.args(6))
        env.resume = original_resume
        env.stop()
        if env.thread is not None:
            env.thread.join(timeout=2)
        owner.close()

    def test_05_constructor_rejects_foreign_app_or_time_manager(self):
        env, _app, owner = self.fixture(start=False)
        foreign = Contacts(contacts={})
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_ENVIRONMENT_BINDING_INVALID"):
            ScopedAREGenerationTimeOwner(env=env, app=foreign)
        self.assertIsNotNone(owner)

    def test_06_release_drift_clears_global_lease_without_resume(self):
        env, app, owner = self.fixture()
        lease = owner.acquire(**self.args(7))
        original_resume = env.resume
        env.resume = lambda: None
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_BINDING_CHANGED"):
            owner.release(lease_id=lease["leaseId"], offset=0)
        # Restore the real method and release the paused environment directly;
        # the failed owner must never invoke a drifted method itself.
        env.resume = original_resume
        original_resume()
        other = ScopedAREGenerationTimeOwner(env=env, app=app, trusted_source_files=(Path(__file__),))
        second = other.acquire(**self.args(8))
        other.release(lease_id=second["leaseId"], offset=0)
        other.close()
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_OWNER_FAILED"):
            owner.close()

    def test_07_zero_pause_elapsed_fails_closed_without_offset_patch(self):
        env = Environment(EnvironmentConfig(start_time=1000, duration=60, verbose=False))
        app = Contacts(contacts={})
        env.register_apps([app])
        original_time_passed = env.time_manager.time_passed
        # Test-only clock fixture: the actual ARE pause stores exactly zero;
        # the owner must reject it rather than adding an artificial offset.
        env.time_manager.time_passed = lambda: 0.0
        owner = ScopedAREGenerationTimeOwner(env=env, app=app, trusted_source_files=(Path(__file__),))
        self.envs.append(env)
        env.start()
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_PAUSE_INVALID"):
            owner.acquire(**self.args(9))
        self.assertIs(env.state, EnvironmentState.RUNNING)
        self.assertFalse(env.time_manager.is_paused)
        env.time_manager.time_passed = original_time_passed
        owner.close()

    def test_08_partial_pause_binding_failure_is_cleaned_by_frozen_method(self):
        env, _app, owner = self.fixture()
        original_pause = env.time_manager.pause
        original_resume = env.resume_with_offset

        def pause_and_drift():
            original_pause()
            env.resume_with_offset = lambda _offset: None

        env.time_manager.pause = pause_and_drift
        with self.assertRaisesRegex(GenerationTimeError, "GENERATION_BINDING_CHANGED"):
            owner.acquire(**self.args(10))
        self.assertIs(env.state, EnvironmentState.RUNNING)
        self.assertFalse(env.time_manager.is_paused)
        env.resume_with_offset = original_resume
        owner.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
