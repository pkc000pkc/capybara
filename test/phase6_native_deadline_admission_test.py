"""Actual ARE owner admission boundaries; no Scenario, model or network.

The fixture pauses its own unstarted TimeManager solely to make equality and
real add_offset boundaries deterministic. Production never pauses time here.
"""

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
from gaia2_private_native_binding import NativeAppBinding, NativeBindingError
from are.simulation.apps.app import App
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.tool_utils import OperationType, app_tool
from are.simulation.types import event_registered

COMMON = {"sourceManifestHash", "scopeHash", "ticketId", "dispatchId", "toolId",
          "canonicalName", "toolKind", "effect", "rawArgumentsHash", "effectiveArgumentsHash"}


class AdmissionLedger(App):
    def __init__(self):
        super().__init__("AdmissionLedger")
        self.calls = 0
        self.reads = 0
        self.values = []
        self.advance = 0

    @app_tool()
    @event_registered(operation_type=OperationType.WRITE)
    def write(self, value: str) -> dict:
        """Write one controlled value.
        :param value: controlled fixture value
        :returns: controlled values
        """
        self.calls += 1
        self.values.append(value)
        if self.advance:
            self.time_manager.add_offset(self.advance)
        if value == "fail":
            raise RuntimeError("controlled_private_failure")
        return {"values": list(self.values)}

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def read(self) -> dict:
        """Read controlled values.
        :returns: observed fixture values
        """
        self.reads += 1
        return {"values": list(self.values)}


class Tests(unittest.TestCase):
    def setUp(self):
        offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        offline.start()
        self.addCleanup(offline.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-native-admission-")
        self.addCleanup(self.temp.cleanup)
        self.owners = []
        self.addCleanup(lambda: [owner.close() for owner in self.owners])
        self.index = 0

    def owner(self, unit="seconds", *, are=True, legacy_clock=None):
        app = AdmissionLedger()
        env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
        env.register_apps([app])
        # Pinned ARE 1.2 tests pause_passed_time by truthiness; a zero-duration
        # pause would keep reading wall time. Use its real offset API before
        # pausing this fixture, without replacing TimeManager functions.
        env.time_manager.add_offset(1)
        env.time_manager.pause()
        self.index += 1
        directory = Path(self.temp.name) / f"owner-{self.index}"
        owner = NativeAppBinding(app, environment_generation="admission-env",
            parent_execution_id="admission-parent", parent_session_id="admission-session",
            evidence_root=directory, clock=legacy_clock or env.time_manager.time,
            clock_environment=env if are else None,
            **({} if unit is None else {"deadline_clock_unit": unit}))
        self.owners.append(owner)
        return owner, app, env, directory

    def scope(self, owner, deadline):
        manifest = owner.manifest()
        token = uuid.uuid4().hex
        task = "controlled admission task"
        scope = {"parentExecutionId": "admission-parent", "parentSessionId": "admission-session",
            "environmentGeneration": "admission-env", "appId": manifest["appId"],
            "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
            "toolInventoryHash": manifest["toolInventoryHash"],
            "taskHash": hashlib.sha256(task.encode()).hexdigest(), "task": task,
            "parentActionId": "parent-" + token, "requestId": str(uuid.uuid4()),
            "childExecutionId": "child-" + token, "childSessionId": "session-" + token,
            "deadline": deadline, "maxNativeActions": 10}
        owner.bind_child({"scope": scope})
        return scope

    def prepare(self, owner, scope, *, name="write", arguments=None, before=True):
        tool = next(tool for tool in owner.manifest()["tools"]
            if tool["canonicalName"].endswith("__" + name) or tool["canonicalName"] == name)
        prepared = owner.prepare_native({"scope": scope, "toolId": tool["toolId"],
            "rawArguments": arguments if arguments is not None else {"value": "one"}})
        payload = {"scope": scope, "ticketId": prepared["ticketId"], "dispatchId": str(uuid.uuid4()),
            "toolId": prepared["toolId"], "effectiveArgumentsHash": prepared["effectiveArgumentsHash"]}
        observed = None
        if before:
            observed = owner.observe_clock({"scope": scope, "ticketId": prepared["ticketId"],
                "dispatchId": payload["dispatchId"], "checkpoint": "before_tool"})
        return payload, prepared, observed

    def receipt(self, directory, ref):
        data = (directory / ref["path"]).read_bytes()
        self.assertEqual(hashlib.sha256(data).hexdigest(), ref["sha256"])
        return json.loads(data)

    def assert_refusal(self, owner, app, env, directory, payload, before, result):
        self.assertEqual(set(result), {"schemaVersion", *COMMON, "status", "errorCode", "refusalEvidenceRef"})
        self.assertEqual(result["schemaVersion"], "gaia2-private-native-admission-refusal-v1")
        self.assertEqual(result["status"], "rejected")
        self.assertEqual(result["errorCode"], "NATIVE_SCOPE_DEADLINE_EXPIRED")
        proof = self.receipt(directory, result["refusalEvidenceRef"])
        self.assertEqual(set(proof), {"schemaVersion", *COMMON, "status", "errorCode", "nativeBodyStarted",
            "ticketRevoked", "childTerminated", "unit", "clockAuthority", "observedAt", "deadline", "beforeClockEvidenceRef"})
        self.assertEqual(proof["schemaVersion"], "gaia2-private-native-admission-refusal-receipt-v1")
        self.assertTrue(all(proof[key] == result[key] for key in COMMON | {"status", "errorCode"}))
        self.assertEqual(proof["sourceManifestHash"], wire.value_hash(owner.manifest()))
        self.assertEqual(proof["scopeHash"], wire.value_hash(payload["scope"]))
        self.assertEqual(proof["beforeClockEvidenceRef"], before["evidenceRef"])
        self.assertEqual(proof["unit"], "seconds")
        self.assertEqual(proof["clockAuthority"], "ARE")
        self.assertEqual(proof["observedAt"], env.time_manager.time())
        self.assertGreaterEqual(proof["observedAt"], proof["deadline"])
        self.assertIs(proof["nativeBodyStarted"], False)
        self.assertIs(proof["ticketRevoked"], True)
        self.assertIs(proof["childTerminated"], True)
        self.assertEqual(app.calls, 0)
        self.assertEqual(app.reads, 0)
        self.assertEqual(app.values, [])
        self.assertEqual(len(env.event_log), 0)
        child = owner._NativeAppBinding__children[payload["scope"]["requestId"]]
        ticket = owner._NativeAppBinding__tickets[payload["ticketId"]]
        self.assertEqual(child["count"], 0)
        self.assertEqual(child["status"], "failed")
        self.assertFalse(ticket["consumed"])
        self.assertTrue(ticket["discarded"])
        self.assertIsNone(owner._NativeAppBinding__active)
        names = [path.name for path in (directory / "json").iterdir()]
        self.assertEqual(sum(name.startswith("admission-refusal-") for name in names), 1)
        self.assertFalse(any(name.startswith(("dispatch-", "return-", "completed-event-")) for name in names))
        with self.assertRaises(NativeBindingError):
            owner.take_agent_observation(payload["dispatchId"])
        with self.assertRaises(NativeBindingError):
            owner.take_native_result(payload["dispatchId"])
        with self.assertRaises(NativeBindingError):
            owner.observe_clock({"scope": payload["scope"], "ticketId": payload["ticketId"],
                "dispatchId": payload["dispatchId"], "checkpoint": "after_tool"})

    def test_actual_are_offset_between_before_and_commit_refuses_body(self):
        owner, app, env, directory = self.owner()
        scope = self.scope(owner, env.time_manager.time() + 4)
        payload, _, before = self.prepare(owner, scope)
        self.assertLess(before["clock"]["now"], scope["deadline"])
        env.time_manager.add_offset(5)
        self.assert_refusal(owner, app, env, directory, payload, before, owner.commit_native(payload))

    def test_exact_deadline_refuses_and_ticket_scope_never_replay(self):
        owner, app, env, directory = self.owner()
        scope = self.scope(owner, env.time_manager.time())
        payload, _, before = self.prepare(owner, scope)
        result = owner.commit_native(payload)
        self.assert_refusal(owner, app, env, directory, payload, before, result)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_TERMINAL"):
            owner.commit_native(payload)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_TERMINAL"):
            self.prepare(owner, scope)
        self.assertEqual(app.calls, 0)

    def test_expired_read_and_final_answer_have_no_body_or_completion(self):
        for name, arguments, kind, effect in (("read", {}, "app_tool", "read"),
                ("final_answer", {"answer": {"done": True}}, "child_final_answer", "finish")):
            with self.subTest(name=name):
                owner, app, env, directory = self.owner()
                scope = self.scope(owner, env.time_manager.time())
                payload, _, before = self.prepare(owner, scope, name=name, arguments=arguments)
                result = owner.commit_native(payload)
                self.assert_refusal(owner, app, env, directory, payload, before, result)
                self.assertEqual(result["toolKind"], kind)
                self.assertEqual(result["effect"], effect)
                with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_TERMINAL"):
                    owner.commit_native(payload)

    def test_nonfinite_actual_are_sample_fails_closed_without_refusal_proof(self):
        owner, app, env, directory = self.owner(legacy_clock=lambda: 0.0)
        scope = self.scope(owner, env.time_manager.time() + 10)
        payload, _, _ = self.prepare(owner, scope)
        env.time_manager.add_offset(float("nan"))
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_INVALID"):
            owner.commit_native(payload)
        self.assertEqual(app.calls, 0)
        self.assertEqual(app.reads, 0)
        self.assertEqual(len(env.event_log), 0)
        child = owner._NativeAppBinding__children[scope["requestId"]]
        ticket = owner._NativeAppBinding__tickets[payload["ticketId"]]
        self.assertEqual(child["count"], 0)
        self.assertFalse(ticket["consumed"])
        self.assertIsNone(owner._NativeAppBinding__active)
        self.assertFalse(any(path.name.startswith(("admission-refusal-", "dispatch-", "return-", "completed-event-"))
            for path in (directory / "json").iterdir()))
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_INVALID"):
            owner.commit_native(payload)
        self.assertEqual(app.calls, 0)

    def test_just_before_deadline_admits_same_sample_and_real_ce_once(self):
        owner, app, env, directory = self.owner()
        self.assertEqual(owner.manifest()["nativeAdmissionDeadline"], {
            "schemaVersion": "gaia2-native-admission-deadline-v1", "unit": "seconds", "clockAuthority": "ARE"})
        scope = self.scope(owner, env.time_manager.time() + 0.001)
        payload, _, _ = self.prepare(owner, scope)
        result = owner.commit_native(payload)
        self.assertEqual(result["status"], "succeeded")
        dispatch = self.receipt(directory, result["dispatchEvidenceRef"])
        self.assertEqual(dispatch["nativeAdmission"], {"schemaVersion": "gaia2-native-admission-v1",
            "unit": "seconds", "clockAuthority": "ARE", "checkedAt": env.time_manager.time(),
            "deadline": scope["deadline"], "status": "admitted"})
        self.assertEqual(dispatch["ownerClock"], dispatch["nativeAdmission"]["checkedAt"])
        self.assertLess(dispatch["ownerClock"], scope["deadline"])
        self.assertEqual(app.calls, 1)
        self.assertEqual(len(env.event_log), 1)
        self.assertIsNotNone(result["nativeCompletedEventRef"])
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_TICKET_INVALID_OR_CONSUMED"):
            owner.commit_native(payload)
        self.assertEqual(app.calls, 1)

    def test_expiry_during_admitted_call_retains_actual_body_and_ce(self):
        owner, app, env, directory = self.owner()
        scope = self.scope(owner, env.time_manager.time() + 4)
        app.advance = 5
        payload, _, _ = self.prepare(owner, scope)
        result = owner.commit_native(payload)
        self.assertEqual(result["status"], "succeeded", "Node after gate handles expiry; owner must retain real facts")
        dispatch = self.receipt(directory, result["dispatchEvidenceRef"])
        self.assertLess(dispatch["nativeAdmission"]["checkedAt"], scope["deadline"])
        self.assertGreaterEqual(env.time_manager.time(), scope["deadline"])
        self.assertEqual(app.calls, 1)
        self.assertEqual(len(env.event_log), 1)
        self.assertTrue(result["nativeCompletedEventRef"])
        self.assertFalse(any(path.name.startswith("admission-refusal-") for path in (directory / "json").iterdir()))
        with self.assertRaises(NativeBindingError):
            owner.commit_native(payload)
        self.assertEqual(app.calls, 1)

    def test_default_milliseconds_preserves_opaque_legacy_deadline(self):
        owner, app, _, directory = self.owner(unit=None, are=False)
        self.assertNotIn("nativeAdmissionDeadline", owner.manifest())
        scope = self.scope(owner, 1)
        payload, _, _ = self.prepare(owner, scope, before=False)
        result = owner.commit_native(payload)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(app.calls, 1)
        self.assertNotIn("nativeAdmission", self.receipt(directory, result["dispatchEvidenceRef"]))

    def test_legacy_with_actual_are_clock_still_does_not_infer_seconds(self):
        owner, app, env, directory = self.owner(unit="milliseconds")
        scope = self.scope(owner, 1)
        payload, _, _ = self.prepare(owner, scope)
        result = owner.commit_native(payload)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(app.calls, 1)
        self.assertGreater(env.time_manager.time(), scope["deadline"])
        self.assertNotIn("nativeAdmissionDeadline", owner.manifest())
        self.assertNotIn("nativeAdmission", self.receipt(directory, result["dispatchEvidenceRef"]))

    def test_unit_types_and_seconds_without_actual_environment_fail_closed(self):
        for unit in (True, 1, None, {}, [], "Seconds", "minutes"):
            with self.subTest(unit=unit):
                app = AdmissionLedger()
                with self.assertRaisesRegex(NativeBindingError, "NATIVE_DEADLINE_CLOCK_UNIT_INVALID"):
                    NativeAppBinding(app, environment_generation="env", parent_execution_id="parent",
                        parent_session_id="session", evidence_root=Path(self.temp.name) / "invalid",
                        clock=lambda: 1000.0, deadline_clock_unit=unit)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_DEADLINE_CLOCK_AUTHORITY_REQUIRED"):
            self.owner(are=False)

    def test_runtime_unit_or_manifest_contract_mutation_invalidates_source_binding(self):
        for target in ("unit", "manifest"):
            with self.subTest(target=target):
                owner, app, env, _ = self.owner()
                scope = self.scope(owner, env.time_manager.time() + 10)
                payload, _, _ = self.prepare(owner, scope)
                if target == "unit":
                    owner._NativeAppBinding__deadline_clock_unit = "milliseconds"
                else:
                    del owner._NativeAppBinding__manifest["nativeAdmissionDeadline"]
                with self.assertRaisesRegex(NativeBindingError, "NATIVE_BINDING_CHANGED"):
                    owner.commit_native(payload)
                self.assertEqual(app.calls, 0)

    def test_legacy_clock_cannot_override_actual_are_deadline(self):
        owner, app, env, directory = self.owner(legacy_clock=lambda: 0.0)
        scope = self.scope(owner, env.time_manager.time() + 4)
        payload, _, before = self.prepare(owner, scope)
        env.time_manager.add_offset(5)
        self.assert_refusal(owner, app, env, directory, payload, before, owner.commit_native(payload))

    def test_cross_scope_ticket_and_actor_clock_or_unit_payload_are_rejected(self):
        owner, app, env, _ = self.owner()
        scope = self.scope(owner, env.time_manager.time() + 10)
        payload, _, _ = self.prepare(owner, scope)
        other = self.scope(owner, env.time_manager.time() + 10)
        for bad in ({**payload, "scope": other}, {**payload, "clock": 0.0},
                    {**payload, "deadline_clock_unit": "milliseconds"}):
            with self.assertRaises(NativeBindingError):
                owner.commit_native(bad)
        self.assertEqual(app.calls, 0)

    def test_refusal_evidence_failure_revokes_once_and_never_executes(self):
        owner, app, env, directory = self.owner()
        scope = self.scope(owner, env.time_manager.time())
        payload, _, _ = self.prepare(owner, scope)
        original = owner._NativeAppBinding__receipt
        def fail_refusal(prefix, body):
            if prefix == "admission-refusal":
                raise OSError("controlled_disk_failure")
            return original(prefix, body)
        with patch.object(owner, "_NativeAppBinding__receipt", side_effect=fail_refusal):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_ADMISSION_EVIDENCE_FAILED"):
                owner.commit_native(payload)
        self.assertEqual(app.calls, 0)
        self.assertEqual(len(env.event_log), 0)
        self.assertEqual(owner._NativeAppBinding__children[scope["requestId"]]["count"], 0)
        self.assertTrue(owner._NativeAppBinding__tickets[payload["ticketId"]]["discarded"])
        self.assertFalse(any(path.name.startswith("admission-refusal-") for path in (directory / "json").iterdir()))
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_BINDING_CHANGED"):
            owner.commit_native(payload)

    def test_refusal_does_not_clear_prior_actual_unknown_write(self):
        owner, app, env, directory = self.owner()
        initial = self.scope(owner, env.time_manager.time() + 100)
        payload, _, _ = self.prepare(owner, initial, arguments={"value": "fail"})
        outcome = owner.commit_native(payload)
        self.assertEqual(outcome["status"], "unknown")
        self.assertTrue(owner._NativeAppBinding__unknown)
        self.assertEqual(app.calls, 1)
        later = self.scope(owner, env.time_manager.time() + 4)
        read_payload, _, _ = self.prepare(owner, later, name="read", arguments={})
        env.time_manager.add_offset(5)
        refused = owner.commit_native(read_payload)
        self.assertEqual(refused["status"], "rejected")
        self.assertTrue(owner._NativeAppBinding__unknown)
        self.assertEqual(app.calls, 1)
        self.assertEqual(app.reads, 0)
        self.assertEqual(owner._NativeAppBinding__children[later["requestId"]]["count"], 0)
        self.assertEqual(self.receipt(directory, refused["refusalEvidenceRef"])["errorCode"], "NATIVE_SCOPE_DEADLINE_EXPIRED")


if __name__ == "__main__":
    unittest.main()
