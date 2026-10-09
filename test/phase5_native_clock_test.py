"""Actual ARE Environment/TimeManager probes, offline and independent of models."""

import copy
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
sys.path.insert(0, str(ROOT / "test"))

import gaia2_a2a_wire as wire
from gaia2_private_native_binding import NativeAppBinding, NativeBindingError
from are.simulation.apps.contacts import Contacts
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.time_manager import TimeManager
from phase5_private_native_binding_test import Ledger


class Tests(unittest.TestCase):
    def setUp(self):
        offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        offline.start(); self.addCleanup(offline.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-native-clock-")
        self.addCleanup(self.temp.cleanup)
        self.index, self.owners = 0, []
        self.addCleanup(lambda: [owner.close() for owner in self.owners])

    def fixture(self, *, actual=True, legacy_clock=None):
        app = Ledger()
        env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
        env.register_apps([app])
        # Real ARE checks pause_passed_time by truthiness. Establish a positive
        # offset before pausing, instead of replacing its actual wall clock.
        env.time_manager.add_offset(1)
        env.time_manager.pause()
        self.index += 1
        root = Path(self.temp.name) / str(self.index)
        owner = NativeAppBinding(app, environment_generation="clock-env", parent_execution_id="clock-parent",
            parent_session_id="clock-session", evidence_root=root, clock=legacy_clock or env.time_manager.time,
            clock_environment=env if actual else None, trusted_source_files=(Path(__file__),))
        self.owners.append(owner)
        manifest = owner.manifest()
        task = "private clock task"
        scope = {"parentExecutionId": "clock-parent", "parentSessionId": "clock-session", "environmentGeneration": "clock-env",
            "appId": app.name, "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
            "toolInventoryHash": manifest["toolInventoryHash"], "taskHash": hashlib.sha256(task.encode()).hexdigest(),
            "parentActionId": "clock-action-" + str(self.index), "requestId": str(uuid.uuid4()),
            "childExecutionId": "clock-child-" + str(self.index), "childSessionId": "clock-child-session-" + str(self.index),
            "task": task, "deadline": 1, "maxNativeActions": 8}
        owner.bind_child({"scope": scope})
        return owner, app, env, root, scope

    def prepare(self, f, name="read", arguments=None):
        owner, _, _, _, scope = f
        meta = next(item for item in owner.manifest()["tools"] if item["publicName"] == ("final_answer" if name == "final_answer" else "Ledger__" + name))
        prepared = owner.prepare_native({"scope": scope, "toolId": meta["toolId"], "rawArguments": arguments or {}})
        return prepared, str(uuid.uuid4())

    def probe(self, f, prepared, dispatch, checkpoint):
        return f[0].observe_clock({"scope": f[4], "ticketId": prepared["ticketId"], "dispatchId": dispatch, "checkpoint": checkpoint})

    def commit(self, f, prepared, dispatch):
        return f[0].commit_native({"scope": f[4], "ticketId": prepared["ticketId"], "dispatchId": dispatch,
            "toolId": prepared["toolId"], "effectiveArgumentsHash": prepared["effectiveArgumentsHash"]})

    def receipt(self, f, ack):
        ref = ack["evidenceRef"]
        data = (f[3] / ref["path"]).read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), ref["sha256"])
        return json.loads(data)

    def test_01_actual_are_clock_not_legacy_or_model_clock_with_exact_provenance(self):
        f = self.fixture(legacy_clock=lambda: 999999)
        prepared, dispatch = self.prepare(f)
        before = self.probe(f, prepared, dispatch, "before_tool")
        self.assertEqual(set(before), {"schemaVersion", "scopeHash", "ticketId", "dispatchId", "checkpoint", "clock", "evidenceRef"})
        self.assertEqual(before["clock"]["now"], f[2].time_manager.time())
        self.assertNotEqual(before["clock"]["now"], 999999)
        f[2].time_manager.add_offset(3)
        outcome = self.commit(f, prepared, dispatch)
        after = self.probe(f, prepared, dispatch, "after_tool")
        self.assertEqual(after["clock"]["now"], before["clock"]["now"] + 3)
        self.assertEqual((before["clock"]["revision"], after["clock"]["revision"]), (1, 2))
        body = self.receipt(f, after)
        self.assertEqual(set(body), {"schemaVersion", "sourceManifestHash", "scopeHash", "ticketId", "dispatchId", "toolId",
            "canonicalName", "toolKind", "effect", "rawArgumentsHash", "effectiveArgumentsHash", "checkpoint", "clock",
            "clockAuthority", "revisionMeaning", "nativeReturnEvidenceRef"})
        self.assertEqual(body["sourceManifestHash"], wire.value_hash(f[0].manifest()))
        self.assertEqual(body["nativeReturnEvidenceRef"], outcome["nativeReturnEvidenceRef"])
        self.assertEqual(body["clockAuthority"], "ARE")
        self.assertEqual(body["revisionMeaning"], "owner_observation_sequence_not_are_revision")
        self.assertIsNone(self.receipt(f, before)["nativeReturnEvidenceRef"])
        self.assertNotIn("private clock task", json.dumps(body))
        self.assertEqual(len(f[4]), 15)
        self.assertEqual(f[0].manifest()["schemaVersion"], "gaia2-native-app-binding-v1")
        self.assertIn(str(ROOT / ".official-python/are/simulation/environment.py"), [ref["path"] for ref in f[0].manifest()["sourceRefs"]])

    def test_02_legacy_owner_advertises_no_are_clock_authority(self):
        f = self.fixture(actual=False)
        self.assertNotIn("observe_clock", f[0].handlers())
        prepared, dispatch = self.prepare(f)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_AUTHORITY_UNAVAILABLE"):
            self.probe(f, prepared, dispatch, "before_tool")
        self.assertEqual(self.commit(f, prepared, dispatch)["status"], "succeeded")

    def test_03_before_once_and_actual_native_requires_matching_before(self):
        f = self.fixture()
        prepared, dispatch = self.prepare(f)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_BEFORE_REQUIRED"):
            self.commit(f, prepared, dispatch)
        self.assertEqual(f[1].reads, 0)
        self.probe(f, prepared, dispatch, "before_tool")
        for candidate in (dispatch, str(uuid.uuid4())):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_BEFORE_INVALID_OR_REUSED"):
                self.probe(f, prepared, candidate, "before_tool")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_AFTER_INVALID_OR_REUSED"):
            self.probe(f, prepared, dispatch, "after_tool")
        self.assertEqual(self.commit(f, prepared, dispatch)["status"], "succeeded")
        self.probe(f, prepared, dispatch, "after_tool")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_AFTER_INVALID_OR_REUSED"):
            self.probe(f, prepared, dispatch, "after_tool")

    def test_04_wrong_scope_ticket_uuid_or_actor_clock_never_samples(self):
        f = self.fixture(); prepared, dispatch = self.prepare(f)
        base = {"scope": f[4], "ticketId": prepared["ticketId"], "dispatchId": dispatch, "checkpoint": "before_tool"}
        for value in ({**base, "clock": {"now": 1}}, {**base, "result": "fake"}, {**base, "ticketId": "f" * 32},
                {**base, "dispatchId": "not-uuid"}, {**base, "checkpoint": "before_model"}):
            with self.assertRaises(NativeBindingError):
                f[0].observe_clock(value)
        changed = copy.deepcopy(base); changed["scope"]["childSessionId"] = "foreign-session"
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_SCOPE_INVALID"):
            f[0].observe_clock(changed)
        self.assertEqual(self.probe(f, prepared, dispatch, "before_tool")["clock"]["revision"], 1)

    def test_05_environment_or_time_manager_replacement_and_method_drift_fail_closed(self):
        for target in ("manager", "app", "membership", "function"):
            f = self.fixture(); prepared, dispatch = self.prepare(f)
            if target == "manager": f[2].time_manager = TimeManager()
            if target == "app": f[1].time_manager = TimeManager()
            if target == "membership": f[2].apps[f[1].name] = Contacts()
            if target == "function": f[2].time_manager.time = lambda: 1000
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_BINDING_CHANGED"):
                self.probe(f, prepared, dispatch, "before_tool")
            self.assertEqual(f[1].reads, 0)

    def test_06_actual_clock_rollback_never_falls_back_to_finite_legacy_clock(self):
        f = self.fixture(legacy_clock=lambda: 42)
        prepared, dispatch = self.prepare(f)
        self.probe(f, prepared, dispatch, "before_tool")
        f[2].time_manager.add_offset(-50)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_INVALID"):
            self.commit(f, prepared, dispatch)
        self.assertEqual(f[1].reads, 0)
        f[2].time_manager.add_offset(100)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_INVALID"):
            self.commit(f, prepared, dispatch)

    def test_07_final_completed_and_unknown_write_allow_only_historical_after_probe(self):
        for name, arguments, status in (("final_answer", {"answer": "done"}, "succeeded"),
                ("write", {"value": "fail"}, "unknown")):
            f = self.fixture(); prepared, dispatch = self.prepare(f, name, arguments)
            self.probe(f, prepared, dispatch, "before_tool")
            outcome = self.commit(f, prepared, dispatch)
            self.assertEqual(outcome["status"], status)
            after = self.probe(f, prepared, dispatch, "after_tool")
            self.assertEqual(self.receipt(f, after)["nativeReturnEvidenceRef"], outcome["nativeReturnEvidenceRef"])
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_TERMINAL"):
                self.prepare(f)
            f[0].close()
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_OWNER_CLOSED"):
                self.probe(f, prepared, dispatch, "after_tool")

    def test_08_tampered_clock_or_actual_native_return_ref_refuses_authority(self):
        f = self.fixture(); prepared, dispatch = self.prepare(f)
        before = self.probe(f, prepared, dispatch, "before_tool")
        (f[3] / before["evidenceRef"]["path"]).write_bytes(b"{}")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_EVIDENCE_CHANGED"):
            self.commit(f, prepared, dispatch)
        self.assertEqual(f[1].reads, 0)
        f = self.fixture(); prepared, dispatch = self.prepare(f, "write", {"value": "one"})
        self.probe(f, prepared, dispatch, "before_tool")
        outcome = self.commit(f, prepared, dispatch)
        (f[3] / outcome["nativeReturnEvidenceRef"]["path"]).write_bytes(b"{}")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_EVIDENCE_CHANGED"):
            self.probe(f, prepared, dispatch, "after_tool")
        self.assertEqual(f[1].calls, 1)

    def test_09_constructor_rejects_environment_not_owning_same_app_and_manager(self):
        app = Ledger()
        env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_ENVIRONMENT_INVALID"):
            NativeAppBinding(app, environment_generation="e", parent_execution_id="p", parent_session_id="s",
                evidence_root=Path(self.temp.name) / "invalid", clock=lambda: 1, clock_environment=env)


if __name__ == "__main__":
    unittest.main()
