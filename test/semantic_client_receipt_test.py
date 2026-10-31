"""Offline binding tests for the shared entity/task semantic Host receipt."""
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


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class SemanticClientTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.workspace = Path(temp.name)
        self.path = self.workspace / "plugin-runtime" / "000003-before_model-abcd-1234.json"
        self.path.parent.mkdir()
        offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        offline.start(); self.addCleanup(offline.stop)
        env = patch.dict(os.environ, {"GAIA2_ENTITY_SEMANTICS_ENABLED": "1", "GAIA2_ENTITY_SEMANTICS_WORKSPACE": str(self.workspace),
            "GAIA2_TASK_CONTRACT_ENABLED": "0", "GAIA2_TASK_CONTRACT_WORKSPACE": "",
            "GAIA2_CONFLICT_RECOVERY_ENABLED": "0", "GAIA2_TEMPORAL_ENABLED": "0", "GAIA2_RETRIEVAL_ENABLED": "0"})
        env.start(); self.addCleanup(env.stop)
        self.client = RuntimeHookClient(url="http://127.0.0.1:1/invoke", token="offline-fixture-only",
            execution_id="execution", session_id="session")
        self.payload = {"messages": [], "clock": {"now": 10, "revision": 2}, "loop": {"iteration": 2}}
        self.entity = {"schemaVersion": "gaia2-entity-state-v1", "enabled": False, "records": []}
        self.task = {"schemaVersion": "gaia2-task-contract-state-v1", "enabled": False, "sources": [], "obligations": []}
        context = "Exact entity evidence contract: 中文原始错误保留"
        self.result = {"decision": {"action": "allow", "reason": "fixture"}, "context": context,
            "contextHash": hashlib.sha256(context.encode()).hexdigest(), "variablesHash": "a" * 64,
            "revision": 7, "hookReceipts": [{"hookId": "gaia2-noise-classifier", "status": "passed"}], "evidencePath": str(self.path)}
        self.report = {"schemaVersion": "capybara-runtime-plugin-invocation-v1", "executionId": "execution", "sessionId": "session", "sequence": 3,
            "input": {**copy.deepcopy(self.payload), "checkpoint": "before_model"}, "context": context,
            "variables": {"gaia2_entity_state": copy.deepcopy(self.entity), "gaia2_task_contract_state": copy.deepcopy(self.task)},
            **{key: copy.deepcopy(self.result[key]) for key in ("contextHash", "variablesHash", "revision", "decision", "hookReceipts")}}
        self.result["semanticReceipt"] = {"schemaVersion": "gaia2-semantic-receipt-v1", "executionId": "execution", "sessionId": "session",
            "checkpoint": "before_model", "sequence": 3, "revision": 7, "contextHash": self.result["contextHash"], "variablesHash": "a" * 64,
            "entityState": copy.deepcopy(self.entity), "entityStateHash": digest(self.entity), "taskContractState": copy.deepcopy(self.task), "taskContractStateHash": digest(self.task),
            "sourceReceiptRef": {"path": self.path.relative_to(self.workspace).as_posix(), "sha256": ""}}
        self.save()

    def save(self):
        raw = json.dumps(self.report, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        self.path.write_bytes(raw)
        self.result["semanticReceipt"]["sourceReceiptRef"]["sha256"] = hashlib.sha256(raw).hexdigest()

    def validate(self):
        self.client.validate_response(self.result)
        return self.client.validate_semantic_receipt(self.result, checkpoint="before_model", payload=self.payload)

    def reject(self, code="semantic_receipt_binding"):
        with self.assertRaises(HookProtocolError) as caught:
            self.validate()
        self.assertEqual(caught.exception.code, code)

    def test_disabled_states_and_unicode_context(self):
        self.assertEqual(self.validate()["entityState"], self.entity)
        self.assertEqual(self.validate()["taskContractState"], self.task)

    def test_missing_receipt_and_foreign_identity(self):
        original = copy.deepcopy(self.result)
        self.result.pop("semanticReceipt"); self.reject("semantic_receipt_required")
        for key in ("executionId", "sessionId", "checkpoint"):
            self.result = copy.deepcopy(original)
            self.result["semanticReceipt"][key] = "other"
            self.reject("semantic_receipt_identity")

    def test_report_identity_input_sequence_decision_and_hooks(self):
        original = copy.deepcopy(self.report)
        for key, value in (("executionId", "other"), ("sessionId", "other"), ("sequence", 4),
                ("input", {"checkpoint": "before_model"}), ("decision", {"action": "block", "reason": "other"}), ("hookReceipts", [])):
            self.report = copy.deepcopy(original); self.report[key] = value; self.save(); self.reject()

    def test_source_sha_and_both_state_hashes(self):
        self.path.write_bytes(self.path.read_bytes() + b" "); self.reject(); self.save()
        for key in ("entityStateHash", "taskContractStateHash"):
            old = self.result["semanticReceipt"][key]
            self.result["semanticReceipt"][key] = "b" * 64; self.reject()
            self.result["semanticReceipt"][key] = old

    def test_response_variable_state_is_not_trusted(self):
        self.result["variables"] = {"gaia2_entity_state": {"enabled": True}}
        self.assertFalse(self.validate()["entityState"]["enabled"])
        self.result["semanticReceipt"]["entityState"]["enabled"] = True
        self.result["semanticReceipt"]["entityStateHash"] = digest(self.result["semanticReceipt"]["entityState"])
        self.reject()

    def test_foreign_record_and_bad_schema_refused_even_after_hash_rebinding(self):
        original_report, original_result = copy.deepcopy(self.report), copy.deepcopy(self.result)
        for state in ({"schemaVersion": "wrong", "enabled": False, "records": []},
                {"schemaVersion": "gaia2-entity-state-v1", "enabled": True, "records": [{"schemaVersion": "gaia2-entity-evidence-v1", "executionId": "other", "sessionId": "session"}]},
                {"schemaVersion": "gaia2-entity-state-v1", "enabled": False, "records": [{}]}):
            self.report, self.result = copy.deepcopy(original_report), copy.deepcopy(original_result)
            self.report["variables"]["gaia2_entity_state"] = state
            self.result["semanticReceipt"].update(entityState=copy.deepcopy(state), entityStateHash=digest(state))
            self.save(); self.reject()

    def test_report_variable_and_context_changes_rejected(self):
        original = copy.deepcopy(self.report)
        for mutate in (lambda: self.report["variables"]["gaia2_entity_state"].update(enabled=True),
                       lambda: self.report.update(context="forged")):
            self.report = copy.deepcopy(original); mutate(); self.save(); self.reject()

    def test_response_hash_revision_binding(self):
        original = copy.deepcopy(self.result)
        for key, value in (("revision", 8), ("variablesHash", "b" * 64), ("contextHash", "b" * 64)):
            self.result = copy.deepcopy(original); self.result["semanticReceipt"][key] = value; self.reject()

    def test_path_checkpoint_sequence_and_workspace_binding(self):
        original = copy.deepcopy(self.result["semanticReceipt"])
        for value in (None, [], {"path": "../escape", "sha256": "a" * 64}, {"path": str(self.path), "sha256": "a" * 64},
                {"path": "plugin-runtime/000003-after_tool-abcd-1234.json", "sha256": "a" * 64}):
            self.result["semanticReceipt"]["sourceReceiptRef"] = value; self.reject("semantic_receipt_path")
        self.result["semanticReceipt"] = copy.deepcopy(original)
        self.result["semanticReceipt"]["sequence"] = 4; self.reject("semantic_receipt_path")
        self.result["semanticReceipt"] = copy.deepcopy(original)
        with patch.dict(os.environ, {"GAIA2_ENTITY_SEMANTICS_WORKSPACE": ""}): self.reject("semantic_receipt_path")
        with patch.dict(os.environ, {"GAIA2_TASK_CONTRACT_WORKSPACE": str(self.workspace / "other")}): self.reject()

    def test_symlink_report_if_supported(self):
        backing = self.workspace / "backing.json"; self.path.replace(backing)
        try: self.path.symlink_to(backing)
        except (OSError, NotImplementedError) as error: self.skipTest("Cannot create fixture symlink: " + type(error).__name__)
        self.reject()

    def test_invoke_requires_shared_receipt_only_for_explicit_capability(self):
        class Response:
            status = 200
            def __enter__(this): return this
            def __exit__(this, *_): return False
            def read(this, _): return json.dumps(self.result).encode()
        self.client.opener.open = lambda *_args, **_kwargs: Response()
        self.assertIn("semanticReceipt", self.client.invoke("before_model", **self.payload))
        self.result.pop("semanticReceipt")
        with self.assertRaises(HookProtocolError) as caught: self.client.invoke("before_model", **self.payload)
        self.assertEqual(caught.exception.code, "semantic_receipt_required")
        with patch.dict(os.environ, {"GAIA2_ENTITY_SEMANTICS_ENABLED": "0"}):
            self.assertNotIn("semanticReceipt", self.client.invoke("before_model", **self.payload))

    def test_v2_omits_retired_approval_state_and_ignores_legacy_workspace(self):
        receipt = self.result['semanticReceipt']
        receipt['schemaVersion'] = 'gaia2-semantic-receipt-v2'
        receipt.pop('taskContractState')
        receipt.pop('taskContractStateHash')
        self.report['variables'].pop('gaia2_task_contract_state')
        self.save()
        with patch.dict(os.environ, {'GAIA2_TASK_CONTRACT_WORKSPACE': str(self.workspace / 'retired')}):
            self.assertEqual(self.validate()['entityState'], self.entity)
        self.assertNotIn('taskContractState', self.validate())

    def test_v2_cannot_reintroduce_task_approval_as_execution_evidence(self):
        self.result['semanticReceipt']['schemaVersion'] = 'gaia2-semantic-receipt-v2'
        self.reject()

    def activate_task(self):
        original = {"role": "user", "id": "user-1", "notificationType": "USER_MESSAGE", "content": "普通任务，无等待"}
        self.payload["messages"] = [original]
        self.report["input"] = {**copy.deepcopy(self.payload), "checkpoint": "before_model"}
        state = {"schemaVersion": "gaia2-task-contract-state-v1", "enabled": True, "executionId": "execution", "sessionId": "session",
            "revision": 1, "clock": 10, "interruption": None, "obligations": [], "sources": [{"userRef": "user-1",
                "sourceHash": hashlib.sha256(original["content"].encode()).hexdigest(), "arrivedAt": 10, "resolution": "reviewed_none",
                "notificationPolicy": "allow", "obligationIds": [], "reason": "independently reviewed"}]}
        self.report["variables"]["gaia2_task_contract_state"] = copy.deepcopy(state)
        self.result["semanticReceipt"].update(taskContractState=copy.deepcopy(state), taskContractStateHash=digest(state))
        self.save()

    def test_active_task_state_binds_actual_unicode_user_and_identity(self):
        self.activate_task()
        self.assertTrue(self.validate()["taskContractState"]["enabled"])
        state = self.result["semanticReceipt"]["taskContractState"]
        state["sessionId"] = "other"
        self.report["variables"]["gaia2_task_contract_state"] = copy.deepcopy(state)
        self.result["semanticReceipt"]["taskContractStateHash"] = digest(state)
        self.save(); self.reject()

    def test_task_source_hash_cannot_be_forged_even_if_state_and_source_file_sha_rebound(self):
        self.activate_task()
        state = self.result["semanticReceipt"]["taskContractState"]
        state["sources"][0]["sourceHash"] = "f" * 64
        self.report["variables"]["gaia2_task_contract_state"] = copy.deepcopy(state)
        self.result["semanticReceipt"]["taskContractStateHash"] = digest(state)
        self.save(); self.reject()


if __name__ == "__main__":
    unittest.main()
