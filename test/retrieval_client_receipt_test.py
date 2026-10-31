"""Offline project-receipt binding tests: no model, service or native tools."""
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
from gaia2_retrieval import canonical_hash
from gaia2_runtime_hooks import HookProtocolError, RuntimeHookClient


class RetrievalReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name)
        self.report_path = self.workspace / "plugin-runtime" / "000003-before_model-abcd-1234.json"
        self.report_path.parent.mkdir()
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.environ = patch.dict(os.environ, {"GAIA2_RETRIEVAL_WORKSPACE": str(self.workspace),
                                                "GAIA2_RETRIEVAL_ENABLED": "1"})
        self.environ.start()
        self.addCleanup(self.environ.stop)
        self.client = RuntimeHookClient(url="http://127.0.0.1:1/invoke", token="offline-fixture-only",
                                        execution_id="execution-1", session_id="session-1")
        self.payload = {"messages": [], "clock": {"now": 10}, "revision": 7, "iteration": 2}
        self.scope = {"scopeId": "scope-1", "criteriaVersion": 1, "revision": 2,
                      "criteria": {"userRef": "user-1", "predicate": "Job Producer"}}
        # This is the HTTP-parsed shape emitted by Node JSON.stringify: an
        # integral clock is JSON 10, not Python's original float spelling 10.0.
        self.projection = json.loads('{"schemaVersion":"gaia2-retrieval-projection-v1",'
            '"scopeId":"scope-1","criteriaVersion":1,"revision":2,"certificates":['
            '{"actionId":"action-1","observedAt":10,"retainedRecords":[],"rejectRefs":["record-1"]}]}')
        context = "offline retrieval status"
        self.result = {"decision": {"action": "allow", "reason": "fixture"}, "context": context,
            "revision": 7, "variablesHash": "a" * 64,
            "contextHash": hashlib.sha256(context.encode()).hexdigest(),
            "hookReceipts": [{"hookId": "retrieval-view-plan", "status": "succeeded"}],
            "evidencePath": str(self.report_path)}
        self.report = {"schemaVersion": "capybara-runtime-plugin-invocation-v1",
            "executionId": "execution-1", "sessionId": "session-1", "sequence": 3,
            "input": {**copy.deepcopy(self.payload), "checkpoint": "before_model"},
            "variables": {"gaia2_retrieval_scope": copy.deepcopy(self.scope),
                          "gaia2_retrieval_projection": copy.deepcopy(self.projection)},
            **{key: copy.deepcopy(self.result[key]) for key in
               ("revision", "variablesHash", "contextHash", "decision", "hookReceipts")}}
        self.result["retrievalReceipt"] = {"schemaVersion": "gaia2-retrieval-receipt-v1",
            "executionId": "execution-1", "sessionId": "session-1", "checkpoint": "before_model",
            "sequence": 3, "revision": 7, "variablesHash": self.result["variablesHash"],
            "contextHash": self.result["contextHash"], "scope": copy.deepcopy(self.scope),
            "projection": copy.deepcopy(self.projection), "planHash": canonical_hash(self.projection),
            "sourceReceiptRef": {"path": self.report_path.relative_to(self.workspace).as_posix(), "sha256": ""}}
        self.write_report()

    def write_report(self):
        data = json.dumps(self.report, ensure_ascii=False, separators=(",", ":")).encode()
        self.report_path.write_bytes(data)
        self.result["retrievalReceipt"]["sourceReceiptRef"]["sha256"] = hashlib.sha256(data).hexdigest()

    def validate(self):
        RuntimeHookClient.validate_response(self.result)
        return self.client.validate_retrieval_receipt(self.result, checkpoint="before_model", payload=self.payload)

    def assert_rejected(self, code):
        with self.assertRaises(HookProtocolError) as caught:
            self.validate()
        self.assertEqual(caught.exception.code, code)

    def test_valid_http_integer_clock(self):
        receipt = self.validate()
        self.assertIsInstance(receipt["projection"]["certificates"][0]["observedAt"], int)
        self.assertEqual(receipt["projection"]["certificates"][0]["observedAt"], 10.0)
        self.assertEqual(receipt["planHash"], canonical_hash(receipt["projection"]))

    def test_missing_receipt(self):
        self.result.pop("retrievalReceipt")
        self.assert_rejected("retrieval_receipt_required")

    def test_cross_session_receipt(self):
        self.result["retrievalReceipt"]["sessionId"] = "another-session"
        self.assert_rejected("retrieval_receipt_identity")

    def test_cross_session_report_even_with_matching_file_sha(self):
        self.report["sessionId"] = "another-session"
        self.write_report()
        self.assert_rejected("retrieval_receipt_binding")

    def test_report_sha_tampering(self):
        self.report_path.write_bytes(self.report_path.read_bytes() + b"\n")
        self.assert_rejected("retrieval_receipt_binding")

    def test_plan_hash_mismatch(self):
        self.result["retrievalReceipt"]["planHash"] = "b" * 64
        self.assert_rejected("retrieval_receipt_binding")

    def test_scope_tampering(self):
        self.result["retrievalReceipt"]["scope"]["criteriaVersion"] = 2
        self.assert_rejected("retrieval_receipt_binding")

    def test_projection_tampering_even_with_recomputed_plan_hash(self):
        receipt = self.result["retrievalReceipt"]
        receipt["projection"]["certificates"][0]["rejectRefs"] = []
        receipt["planHash"] = canonical_hash(receipt["projection"])
        self.assert_rejected("retrieval_receipt_binding")

    def test_path_escape_and_absolute_path(self):
        for value in ("../plugin-runtime/000003-before_model-abcd.json",
                      "plugin-runtime/../000003-before_model-abcd.json", str(self.report_path),
                      "plugin-runtime/000003-before_model-abcd.json/other"):
            with self.subTest(path=value):
                self.result["retrievalReceipt"]["sourceReceiptRef"]["path"] = value
                self.assert_rejected("retrieval_receipt_path")

    def test_symlink_report_is_rejected_if_supported(self):
        backing = self.workspace / "backing-report.json"
        self.report_path.replace(backing)
        try:
            self.report_path.symlink_to(backing)
        except (OSError, NotImplementedError) as error:
            self.skipTest("Host does not permit file symlink creation: " + type(error).__name__)
        self.assert_rejected("retrieval_receipt_binding")

    def test_revision_sequence_and_input_binding(self):
        baseline = copy.deepcopy(self.report)
        for key, value in (("revision", 8), ("sequence", 4), ("input", {"checkpoint": "before_model"})):
            with self.subTest(field=key):
                self.report = copy.deepcopy(baseline)
                self.report[key] = value
                self.write_report()
                self.assert_rejected("retrieval_receipt_binding")


if __name__ == "__main__":
    unittest.main()
