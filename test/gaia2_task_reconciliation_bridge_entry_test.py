"""Offline entry-boundary checks for the current reconciliation bridge helper.

This extracts the real nested helper from capybara_official_bridge.py and
injects only trusted protocol dependencies. It never starts ARE, LiteLLM, HTTP,
or a model process.
"""
import ast
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gaia2_task_reconciliation_protocol import (
    ReconciliationProtocolError,
    argument_digest,
    normalize_argument_checks,
    normalize_supersede_quote,
    resolve_scope_anchor,
    source_text_hash,
)


class ProtocolError(RuntimeError):
    pass


def safe_json_value(value):
    try:
        json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError):
        return False
    return True


def load_reconcile_helper(context):
    path = ROOT / "scripts" / "capybara_official_bridge.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    function = next(node for node in ast.walk(tree)
                    if isinstance(node, ast.FunctionDef) and node.name == "_task_reconcile_request")
    unit = ast.fix_missing_locations(ast.Module(body=[copy.deepcopy(function)], type_ignores=[]))
    exec(compile(unit, str(path), "exec"), context)
    return context["_task_reconcile_request"]


class FakeTool:
    class_name = "EmailClientV2"
    func_name = "send_email"
    _public_name = "send_email"


class TaskReconciliationBridgeEntryTests(unittest.TestCase):
    def context(self):
        first = "Send exactly one email to alice@example.com."
        second = "Continue the same request and keep the subject short."
        messages = [
            {"id": "user-one", "role": "user", "notificationType": "USER_MESSAGE", "content": first},
            {"id": "user-two", "role": "user", "notificationType": "USER_MESSAGE", "content": second},
        ]
        return {
            "messages": messages,
            "app_tools": [FakeTool()],
            "HookProtocolError": ProtocolError,
            "ReconciliationProtocolError": ReconciliationProtocolError,
            "resolve_scope_anchor": resolve_scope_anchor,
            "source_text_hash": source_text_hash,
            "normalize_argument_checks": normalize_argument_checks,
            "normalize_supersede_quote": normalize_supersede_quote,
            "safe_json_value": safe_json_value,
            "_canonical": lambda tool: (tool.class_name, tool.func_name),
        }, first, second

    def test_entry_normalizes_scope_argument_and_supersede_contract(self):
        context, first, second = self.context()
        request = load_reconcile_helper(context)({
            "mode": "enforce",
            "quote": first,
            "scopeAnchor": {"continuationQuotes": [second]},
            "supersedeQuote": "exactly one email",
            "obligations": [{
                "id": "send-one",
                "canonicalName": "send_email",
                "resourceKey": "Emails",
                "effect": "write",
                "minCalls": 1,
                "maxCalls": 1,
                "argumentChecks": [{"path": "/recipient", "op": "equals_hash", "value": "alice@example.com"}],
            }],
        })
        self.assertEqual(request["schemaVersion"], "gaia2-task-reconciliation-request-v1")
        self.assertEqual(request["source"]["userRef"], "user-one")
        self.assertEqual(request["source"]["sourceHash"], source_text_hash(first))
        self.assertEqual([item["userRef"] for item in request["source"]["scopeAnchor"]["members"]],
                         ["user-one", "user-two"])
        self.assertEqual(request["source"]["replacement"],
                         {"mode": "supersede", "quote": "exactly one email"})
        self.assertEqual(request["obligations"][0]["argumentChecks"], [{
            "path": "/recipient", "op": "equals_hash",
            "expectedHash": argument_digest("alice@example.com"),
        }])

    def test_entry_rejects_duplicate_scope_and_unknown_tool(self):
        context, first, _ = self.context()
        helper = load_reconcile_helper(context)
        with self.assertRaises(ProtocolError):
            helper({"mode": "enforce", "quote": first,
                    "scopeAnchor": {"continuationQuotes": [first]}, "obligations": []})
        with self.assertRaises(ProtocolError):
            helper({"mode": "advisory", "quote": first, "obligations": [{
                "id": "bad", "canonicalName": "Unknown__tool", "minCalls": 0, "maxCalls": 0,
            }]})


if __name__ == "__main__":
    unittest.main()
