"""Offline binding tests for the project conflictReceipt extension."""
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gaia2_runtime_hooks import HookProtocolError, RuntimeHookClient
from gaia2_conflict_recovery import canonical_hash


class ConflictClientTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.path = self.workspace / "plugin-runtime" / "000003-before_model-abcd-1234.json"
        self.path.parent.mkdir()
        offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        offline.start()
        self.addCleanup(offline.stop)
        env = patch.dict(os.environ, {"GAIA2_CONFLICT_RECOVERY_ENABLED": "1",
            "GAIA2_CONFLICT_RECOVERY_WORKSPACE": str(self.workspace),
            "GAIA2_TEMPORAL_ENABLED": "0", "GAIA2_RETRIEVAL_ENABLED": "0"})
        env.start()
        self.addCleanup(env.stop)
        self.client = RuntimeHookClient(url="http://127.0.0.1:1/invoke", token="offline-fixture-only",
            execution_id="execution", session_id="session")
        self.payload = {"messages": [], "clock": {"now": 10, "revision": 2}, "loop": {"iteration": 2}}
        self.state = {"schemaVersion": "gaia2-conflict-state-v1", "status": "idle", "userRef": None,
            "blockedAction": None, "blockerIds": [], "requests": [], "reason": None}
        context = "offline conflict context"
        self.result = {"decision": {"action": "allow", "reason": "fixture"}, "context": context,
            "contextHash": hashlib.sha256(context.encode()).hexdigest(), "variablesHash": "a" * 64,
            "revision": 7, "hookReceipts": [{"hookId": "gaia2-conflict-gate", "status": "passed"}],
            "evidencePath": str(self.path)}
        self.report = {"schemaVersion": "capybara-runtime-plugin-invocation-v1", "executionId": "execution",
            "sessionId": "session", "sequence": 3,
            "input": {**copy.deepcopy(self.payload), "checkpoint": "before_model"},
            "variables": {"gaia2_conflict_state": copy.deepcopy(self.state)},
            **{k: copy.deepcopy(self.result[k]) for k in ("contextHash", "variablesHash", "revision", "decision", "hookReceipts")}}
        self.result["conflictReceipt"] = {"schemaVersion": "gaia2-conflict-receipt-v1", "executionId": "execution",
            "sessionId": "session", "checkpoint": "before_model", "sequence": 3,
            "revision": 7, "contextHash": self.result["contextHash"], "variablesHash": "a" * 64,
            "state": copy.deepcopy(self.state), "stateHash": canonical_hash(self.state),
            "sourceReceiptRef": {"path": self.path.relative_to(self.workspace).as_posix(), "sha256": ""}}
        self.save()

    def save(self):
        raw = json.dumps(self.report, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        self.path.write_bytes(raw)
        self.result["conflictReceipt"]["sourceReceiptRef"]["sha256"] = hashlib.sha256(raw).hexdigest()

    def validate(self):
        self.client.validate_response(self.result)
        return self.client.validate_conflict_receipt(self.result, checkpoint="before_model", payload=self.payload)

    def reject(self, code="conflict_receipt_binding"):
        with self.assertRaises(HookProtocolError) as caught:
            self.validate()
        self.assertEqual(caught.exception.code, code)

    def activate(self):
        self.state.update(status="blocked", userRef="user-1", reason="确认当前观察",
            blockedAction={"id": "write-1", "canonicalName": "Calendar__add_calendar_event", "mutationKey": "b" * 64, "resourceKey": "Calendar"},
            blockerIds=["obs-old", "obs-new"], requests=[{"queryTool": "Calendar__get_calendar_events_from_to",
                "queryArguments": {"start_datetime": "2024-10-18 00:00:00", "limit": 100},
                "queryHash": "c" * 64, "resourceKey": "Calendar", "observationIds": ["obs-old", "obs-new"],
                "expectedLatestResultHash": "d" * 64}])
        self.report["variables"]["gaia2_conflict_state"] = copy.deepcopy(self.state)
        self.result["conflictReceipt"].update(state=copy.deepcopy(self.state), stateHash=canonical_hash(self.state))
        self.save()

    def test_idle_and_blocked_unicode_state(self):
        self.assertEqual(self.validate()["state"]["status"], "idle")
        self.activate()
        self.assertEqual(self.validate()["state"], self.state)

    def test_missing_schema(self):
        self.result.pop("conflictReceipt")
        self.reject("conflict_receipt_required")

    def test_identity_and_checkpoint(self):
        original = copy.deepcopy(self.result)
        for key in ("executionId", "sessionId", "checkpoint"):
            self.result = copy.deepcopy(original)
            self.result["conflictReceipt"][key] = "other"
            self.reject("conflict_receipt_identity")

    def test_report_identity_input_sequence_and_decision(self):
        original = copy.deepcopy(self.report)
        for key, value in (("executionId", "other"), ("sessionId", "other"), ("sequence", 4),
                           ("input", {"checkpoint": "before_model"}),
                           ("decision", {"action": "block", "reason": "other"}), ("hookReceipts", [])):
            self.report = copy.deepcopy(original)
            self.report[key] = value
            self.save()
            self.reject()

    def test_state_tamper_with_valid_hash_is_still_rejected(self):
        self.activate()
        self.result["conflictReceipt"]["state"]["reason"] = "forged"
        self.result["conflictReceipt"]["stateHash"] = canonical_hash(self.result["conflictReceipt"]["state"])
        self.reject()

    def test_report_variable_change_even_with_valid_file_hash(self):
        self.report["variables"]["gaia2_conflict_state"]["reason"] = "other"
        self.save()
        self.reject()

    def test_missing_or_wrong_schema_state(self):
        for state in (None, [], {"schemaVersion": "wrong"}):
            self.report["variables"]["gaia2_conflict_state"] = copy.deepcopy(state)
            self.result["conflictReceipt"]["state"] = copy.deepcopy(state)
            self.result["conflictReceipt"]["stateHash"] = canonical_hash(state)
            self.save()
            self.reject()

    def test_hash_and_source_bytes(self):
        self.path.write_bytes(self.path.read_bytes() + b" ")
        self.reject()

    def test_state_hash_rejected(self):
        self.result["conflictReceipt"]["stateHash"] = "b" * 64
        self.reject()

    def test_response_report_revision_and_hash_binding(self):
        original = copy.deepcopy(self.result)
        for key, value in (("revision", 8), ("variablesHash", "b" * 64), ("contextHash", "b" * 64)):
            self.result = copy.deepcopy(original)
            self.result["conflictReceipt"][key] = value
            self.reject()

    def test_path_traversal_absolute_bad_reference_and_missing_workspace(self):
        original = copy.deepcopy(self.result["conflictReceipt"]["sourceReceiptRef"])
        for value in (None, [], "invalid", {"path": "../escape", "sha256": "a" * 64},
                      {"path": str(self.path), "sha256": "a" * 64}):
            self.result["conflictReceipt"]["sourceReceiptRef"] = value
            self.reject("conflict_receipt_path")
        self.result["conflictReceipt"]["sourceReceiptRef"] = original
        with patch.dict(os.environ, {"GAIA2_CONFLICT_RECOVERY_WORKSPACE": ""}):
            self.reject("conflict_receipt_path")

    def test_symlink_report_if_supported(self):
        backing = self.workspace / "backing.json"
        self.path.replace(backing)
        try:
            self.path.symlink_to(backing)
        except (OSError, NotImplementedError) as error:
            self.skipTest("Cannot create fixture symlink: " + type(error).__name__)
        self.reject()

    def test_missing_or_malformed_variables(self):
        for value in ({}, [], None):
            self.report["variables"] = value
            self.save()
            self.reject()

    def test_invoke_requires_extension_only_when_opted_in(self):
        class Response:
            status = 200
            def __enter__(this): return this
            def __exit__(this, *_): return False
            def read(this, _): return json.dumps(self.result).encode()
        self.client.opener.open = lambda *_args, **_kwargs: Response()
        self.assertEqual(self.client.invoke("before_model", **self.payload)["conflictReceipt"]["state"], self.state)
        self.result.pop("conflictReceipt")
        with self.assertRaises(HookProtocolError) as caught:
            self.client.invoke("before_model", **self.payload)
        self.assertEqual(caught.exception.code, "conflict_receipt_required")
        with patch.dict(os.environ, {"GAIA2_CONFLICT_RECOVERY_ENABLED": "0"}):
            self.assertNotIn("conflictReceipt", self.client.invoke("before_model", **self.payload))


if __name__ == "__main__":
    unittest.main()
