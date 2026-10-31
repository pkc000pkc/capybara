"""Offline temporal receipt tests. No model, Hook service, ARE, or sockets."""
from __future__ import annotations

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


def state_hash(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


class TemporalClientReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.report_path = self.workspace / "plugin-runtime" / "000003-before_model-abcd-1234.json"
        self.report_path.parent.mkdir()
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.environ = patch.dict(os.environ, {"GAIA2_TEMPORAL_ENABLED": "1",
            "GAIA2_TEMPORAL_WORKSPACE": str(self.workspace)})
        self.environ.start()
        self.addCleanup(self.environ.stop)
        self.client = RuntimeHookClient(url="http://127.0.0.1:1/invoke", token="offline-fixture-only",
            execution_id="execution-1", session_id="session-1")
        self.payload = {"messages": [], "clock": {"now": 10, "revision": 2}, "loop": {"iteration": 2}}
        self.state = {"schemaVersion": "gaia2-temporal-state-v1", "enabled": False, "status": "idle"}
        context = "offline controller context"
        self.result = {"decision": {"action": "allow", "reason": "offline fixture"}, "context": context,
            "revision": 7, "variablesHash": "a" * 64, "contextHash": hashlib.sha256(context.encode()).hexdigest(),
            "hookReceipts": [{"hookId": "gaia2-event-sync", "status": "passed"}],
            "evidencePath": str(self.report_path)}
        self.report = {"schemaVersion": "capybara-runtime-plugin-invocation-v1", "executionId": "execution-1",
            "sessionId": "session-1", "sequence": 3, "input": {**copy.deepcopy(self.payload), "checkpoint": "before_model"},
            "variables": {"gaia2_temporal_state": copy.deepcopy(self.state)},
            **{key: copy.deepcopy(self.result[key]) for key in ("revision", "variablesHash", "contextHash", "decision", "hookReceipts")}}
        self.result["temporalReceipt"] = {"schemaVersion": "gaia2-temporal-receipt-v1", "executionId": "execution-1",
            "sessionId": "session-1", "checkpoint": "before_model", "sequence": 3, "revision": 7,
            "variablesHash": self.result["variablesHash"], "contextHash": self.result["contextHash"],
            "state": copy.deepcopy(self.state), "stateHash": state_hash(self.state),
            "sourceReceiptRef": {"path": self.report_path.relative_to(self.workspace).as_posix(), "sha256": ""}}
        self.write_report()

    def write_report(self):
        raw = json.dumps(self.report, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.report_path.write_bytes(raw)
        self.result["temporalReceipt"]["sourceReceiptRef"]["sha256"] = hashlib.sha256(raw).hexdigest()

    def activate(self, status="running", signal=None):
        # Node JSON.stringify emits integral scene times as 10, not 10.0.
        self.state = {"schemaVersion": "gaia2-temporal-state-v1", "enabled": True, "watchId": "watch-1",
            "executionId": "execution-1", "sessionId": "session-1", "userRef": "user-1", "goal": "等待回信",
            "status": status, "signal": signal, "sceneStart": 10, "sceneNow": 10, "deadline": None,
            "intervalSeconds": 30, "maxScans": 12, "scanCount": 0, "waitCount": 0, "queryTool": "Mail__get_emails",
            "queryArguments": {}, "baselineHash": None, "lastEvidenceRef": None, "waitRefs": []}
        self.report["variables"]["gaia2_temporal_state"] = copy.deepcopy(self.state)
        self.result["temporalReceipt"]["state"] = copy.deepcopy(self.state)
        self.result["temporalReceipt"]["stateHash"] = state_hash(self.state)
        self.write_report()

    def validate(self):
        RuntimeHookClient.validate_response(self.result)
        return self.client.validate_temporal_receipt(self.result, checkpoint="before_model", payload=self.payload)

    def assert_rejected(self, code="temporal_receipt_binding"):
        with self.assertRaises(HookProtocolError) as caught:
            self.validate()
        self.assertEqual(caught.exception.code, code)

    def test_valid_initial_state(self):
        self.assertEqual(self.validate()["state"], self.state)

    def test_valid_active_state_and_unicode_hash(self):
        self.activate()
        receipt = self.validate()
        self.assertEqual(receipt["state"]["goal"], "等待回信")
        self.assertEqual(receipt["stateHash"], state_hash(receipt["state"]))
        self.assertIsInstance(receipt["state"]["sceneNow"], int)

    def test_valid_signal_preserves_original_user_ref(self):
        self.activate("signaled", {"kind": "user_update"})
        receipt = self.validate()
        self.assertEqual(receipt["state"]["userRef"], "user-1")
        self.assertEqual(receipt["state"]["signal"]["kind"], "user_update")

    def test_missing_or_wrong_schema_receipt(self):
        for value in (None, {}, {"schemaVersion": "wrong"}):
            with self.subTest(value=value):
                self.result["temporalReceipt"] = value
                self.assert_rejected("temporal_receipt_required")

    def test_cross_session_and_execution_receipt(self):
        baseline = copy.deepcopy(self.result["temporalReceipt"])
        for field in ("sessionId", "executionId"):
            with self.subTest(field=field):
                self.result["temporalReceipt"] = copy.deepcopy(baseline)
                self.result["temporalReceipt"][field] = "another-owner"
                self.assert_rejected("temporal_receipt_identity")

    def test_cross_session_and_execution_report_with_valid_file_sha(self):
        baseline = copy.deepcopy(self.report)
        for field in ("sessionId", "executionId"):
            with self.subTest(field=field):
                self.report = copy.deepcopy(baseline)
                self.report[field] = "another-owner"
                self.write_report()
                self.assert_rejected()

    def test_wrong_checkpoint_receipt(self):
        self.result["temporalReceipt"]["checkpoint"] = "after_tool"
        self.assert_rejected("temporal_receipt_identity")

    def test_wrong_checkpoint_and_input_report(self):
        baseline = copy.deepcopy(self.report)
        for mutate in (lambda r: r["input"].update(checkpoint="after_tool"),
                       lambda r: r["input"]["clock"].update(now=11),
                       lambda r: r["input"]["loop"].update(iteration=3)):
            with self.subTest(mutation=mutate):
                self.report = copy.deepcopy(baseline)
                mutate(self.report)
                self.write_report()
                self.assert_rejected()

    def test_source_bytes_modified_without_sha_refresh(self):
        self.report_path.write_bytes(self.report_path.read_bytes() + b"\n")
        self.assert_rejected()

    def test_source_sha_modified(self):
        self.result["temporalReceipt"]["sourceReceiptRef"]["sha256"] = "b" * 64
        self.assert_rejected()

    def test_state_hash_modified(self):
        self.result["temporalReceipt"]["stateHash"] = "b" * 64
        self.assert_rejected()

    def test_state_tampered_even_with_recomputed_hash(self):
        self.activate()
        receipt = self.result["temporalReceipt"]
        receipt["state"]["scanCount"] = 3
        receipt["stateHash"] = state_hash(receipt["state"])
        self.assert_rejected()

    def test_report_state_tampered_even_with_valid_file_sha(self):
        self.activate()
        self.report["variables"]["gaia2_temporal_state"]["waitCount"] = 9
        self.write_report()
        self.assert_rejected()

    def test_missing_temporal_variable_report(self):
        self.report["variables"] = {}
        self.write_report()
        self.assert_rejected()

    def test_response_revision_context_and_variable_hash_are_bound(self):
        baseline = copy.deepcopy(self.result)
        for field, value in (("revision", 8), ("variablesHash", "b" * 64), ("contextHash", "b" * 64)):
            with self.subTest(field=field):
                self.result = copy.deepcopy(baseline)
                self.result["temporalReceipt"][field] = value
                self.assert_rejected()

    def test_report_sequence_revision_and_hook_receipts_are_bound(self):
        baseline = copy.deepcopy(self.report)
        for field, value in (("sequence", 4), ("revision", 8), ("hookReceipts", []),
                             ("decision", {"action": "block", "reason": "changed"})):
            with self.subTest(field=field):
                self.report = copy.deepcopy(baseline)
                self.report[field] = value
                self.write_report()
                self.assert_rejected()

    def test_path_traversal_absolute_and_invalid_suffix(self):
        for path in ("../plugin-runtime/000003-before_model-abcd.json",
                     "plugin-runtime/../000003-before_model-abcd.json", str(self.report_path),
                     "plugin-runtime/000003-before_model-abcd.json/other"):
            with self.subTest(path=path):
                self.result["temporalReceipt"]["sourceReceiptRef"]["path"] = path
                self.assert_rejected("temporal_receipt_path")

    def test_symlink_report_rejected_if_supported(self):
        backing = self.workspace / "backing-report.json"
        self.report_path.replace(backing)
        try:
            self.report_path.symlink_to(backing)
        except (OSError, NotImplementedError) as error:
            self.skipTest("Host cannot create file symlinks: " + type(error).__name__)
        self.assert_rejected()

    def test_malformed_source_reference_type_is_protocol_rejection(self):
        for value in (None, [], "not-a-reference"):
            with self.subTest(value=value):
                self.result["temporalReceipt"]["sourceReceiptRef"] = value
                self.assert_rejected("temporal_receipt_path")

    def test_malformed_report_variables_type_is_protocol_rejection(self):
        for value in (None, [], "not-variables"):
            with self.subTest(value=value):
                self.report["variables"] = value
                self.write_report()
                self.assert_rejected()


if __name__ == "__main__":
    unittest.main()
