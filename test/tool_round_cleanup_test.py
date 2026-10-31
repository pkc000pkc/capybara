"""Offline ACK-loss cleanup with the actual Bridge and shared Node scheduler.

The fault transport invokes the real service first, then deliberately discards
one response. No Python copy of scheduling state, model, native tool or network
endpoint is used. Original result messages and complete tool pairs are checked.
"""
import ast
import copy
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from typing import Any
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gaia2_runtime_hooks import HookProtocolError
from gaia2_tool_round import ToolRoundAdapter


CALLS = [("call-0", "Warehouse__read", '{}'),
         ("call-1", "Warehouse__write", '{"id":"one"}'),
         ("call-2", "AddressBook__read", '{}')]


class FaultTransport:
    def __init__(self, workspace):
        self.requests, self.responses, self.fail_op = [], [], None
        backend = Path(json.loads((ROOT / "config/phase0-protocol.json").read_text(encoding="utf-8"))["runtime"]["backendRoot"])
        program = """
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const [root, backend, workspace] = process.argv.slice(1);
const { ToolRoundScheduler } = await import(pathToFileURL(join(backend, 'src/core/tools/tool-round-scheduler.ts')).href);
const { createToolRoundService } = await import(pathToFileURL(join(root, 'src/tool_round_service.mjs')).href);
const service = createToolRoundService({ Scheduler: ToolRoundScheduler, workspaceDir: workspace,
  executionId: 'cleanup-execution', sessionId: 'cleanup-session' });
process.stdout.write(JSON.stringify({ready:true}) + '\\n');
for await (const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
  try { process.stdout.write(JSON.stringify(service.invoke(JSON.parse(line))) + '\\n'); }
  catch (error) { process.stdout.write(JSON.stringify({error:error.code||error.message}) + '\\n'); }
}
"""
        self.worker = subprocess.Popen(["node", "--import", (backend / "node_modules/tsx/dist/loader.mjs").as_uri(),
            "--input-type=module", "-e", program, str(ROOT), str(backend), workspace], cwd=str(backend),
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8",
            bufsize=1, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        ready = self.worker.stdout.readline()
        if not ready or json.loads(ready) != {"ready": True}:
            raise AssertionError("The real shared scheduler worker did not initialize")

    def tool_round(self, op, round_id, **payload):
        envelope = {"executionId": "cleanup-execution", "sessionId": "cleanup-session", "op": op,
                    "roundId": round_id, "requestId": uuid.uuid4().hex, **payload}
        self.requests.append(copy.deepcopy(envelope))
        self.worker.stdin.write(json.dumps(envelope, ensure_ascii=False) + "\n")
        self.worker.stdin.flush()
        response = json.loads(self.worker.stdout.readline(8 * 1024 * 1024 + 1))
        if "error" in response:
            raise AssertionError("Unexpected shared service error: " + response["error"])
        self.responses.append(copy.deepcopy(response))
        if self.fail_op == op:
            self.fail_op = None
            raise HookProtocolError("injected_lost_ack")
        return response

    def close(self):
        self.worker.stdin.close()
        try:
            self.worker.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.worker.terminate()
            self.worker.wait(timeout=5)
        self.worker.stdout.close()
        self.worker.stderr.close()


def production_helpers(context):
    path = ROOT / "scripts/capybara_official_bridge.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names = {"_close_tool_round", "_new_message", "_provider_message_sequence", "_validate_provider_tool_pairs", "_stable_hash"}
    definitions = [copy.deepcopy(node) for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name in names]
    class Lift(ast.NodeTransformer):
        def visit_Nonlocal(self, node):
            return ast.copy_location(ast.Global(names=node.names), node)
    unit = ast.fix_missing_locations(ast.Module(body=[Lift().visit(node) for node in definitions], type_ignores=[]))
    exec(compile(unit, str(path), "exec"), context)
    return context["_close_tool_round"]


class ToolRoundCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="tool-round-ack-cleanup-")
        self.client = FaultTransport(self.temporary.name)
        self.adapter = ToolRoundAdapter(self.client, "round-" + uuid.uuid4().hex, CALLS, [], lambda *a, **kw: None,
                                        defer_begin=True)
        self.native_executions = 0
        self.context = {"Any": Any, "json": json, "hashlib": hashlib, "math": math, "uuid": uuid, "HookProtocolError": HookProtocolError,
            "MessageType": SimpleNamespace(USER_MESSAGE=SimpleNamespace(value="USER_MESSAGE"),
                                           ENVIRONMENT_NOTIFICATION=SimpleNamespace(value="ENVIRONMENT_NOTIFICATION")),
            "active_tool_round": self.adapter, "revision": 0, "iteration": 0, "calls": copy.deepcopy(CALLS),
            "messages": [{"role": "system", "content": "Controlled synthetic run"},
                         {"role": "user", "content": "Read, write, and inspect records."},
                         {"role": "assistant", "content": "", "tool_calls": [
                             {"id": identity, "type": "function", "function": {"name": name, "arguments": arguments}}
                             for identity, name, arguments in CALLS]}],
            "_emit_runtime_event": lambda *a, **kw: None}
        self.close_round = production_helpers(self.context)

    def tearDown(self):
        self.client.close()
        self.temporary.cleanup()

    def begin(self):
        self.adapter.begin()

    def actual_result(self, ordinal=0):
        self.native_executions += 1
        message = {"role": "tool", "name": CALLS[ordinal][1], "tool_call_id": CALLS[ordinal][0],
                   "content": json.dumps({"status": "succeeded", "result": {"synthetic": "actual-native-result"}})}
        self.context["messages"].append(message)
        return copy.deepcopy(message)

    def assert_complete(self):
        self.context["_validate_provider_tool_pairs"](self.context["messages"])
        messages = [row for row in self.context["messages"] if row["role"] == "tool"]
        self.assertEqual([row["tool_call_id"] for row in messages], [row[0] for row in CALLS])
        self.assertEqual(len({row["tool_call_id"] for row in messages}), len(CALLS))
        return [json.loads(row["content"]) for row in messages]

    def test_begin_ack_loss_has_no_native_dispatch_and_flushes_all_cancelled_results_without_retry(self):
        self.client.fail_op = "begin"
        with self.assertRaises(HookProtocolError):
            self.begin()
        self.assertTrue(self.adapter.rpc_failed)
        self.close_round("round_interrupted", uncertain=True)
        results = self.assert_complete()
        self.assertTrue(all(row["status"] == "cancelled" and row["executed"] is False for row in results))
        self.assertEqual([row["op"] for row in self.client.requests], ["begin"])
        self.assertEqual(self.native_executions, 0)

    def test_claim_ack_loss_flushes_unexecuted_results_and_does_not_retry_next_or_native(self):
        self.begin()
        self.client.fail_op = "next"
        with self.assertRaises(HookProtocolError):
            self.adapter.claim(0)
        self.close_round("round_interrupted", uncertain=True)
        results = self.assert_complete()
        self.assertTrue(all(row["status"] == "cancelled" and row["executed"] is False for row in results))
        self.assertEqual([row["op"] for row in self.client.requests], ["begin", "next"])
        self.assertEqual(self.native_executions, 0)

    def test_settle_ack_loss_preserves_existing_actual_result_and_flushes_tail_without_resettlement(self):
        self.begin()
        self.adapter.claim(0)
        original = self.actual_result()
        self.client.fail_op = "settle"
        with self.assertRaises(HookProtocolError):
            self.adapter.settle("succeeded")
        count = len(self.client.requests)
        self.close_round("round_interrupted", uncertain=True)
        self.assertEqual(len(self.client.requests), count)
        self.assertEqual(self.context["messages"][3], original)
        results = self.assert_complete()
        self.assertEqual(results[0]["status"], "succeeded")
        self.assertTrue(all(row["status"] == "cancelled" and row["executed"] is False for row in results[1:]))
        self.assertEqual(self.native_executions, 1)

    def test_after_hook_failure_preserves_actual_result_but_settles_inflight_unknown_and_cancels_tail(self):
        self.begin()
        self.adapter.claim(0)
        original = self.actual_result()
        self.close_round("after_tool_rejected", uncertain=True)
        results = self.assert_complete()
        self.assertEqual(self.context["messages"][3], original)
        self.assertEqual(results[0]["status"], "succeeded")
        self.assertEqual(self.adapter.state["nodes"][0]["status"], "unknown")
        self.assertEqual([row["status"] for row in self.adapter.state["nodes"]], ["unknown", "cancelled", "cancelled"])
        self.assertEqual(self.native_executions, 1)

    def test_inflight_without_native_result_receives_unknown_not_fabricated_success(self):
        self.begin()
        self.adapter.claim(0)
        self.close_round("native_outcome_unresolved", uncertain=True)
        results = self.assert_complete()
        self.assertEqual(results[0]["status"], "unknown")
        self.assertIsNone(results[0]["executed"])
        self.assertEqual([row["status"] for row in results[1:]], ["cancelled", "cancelled"])
        self.assertEqual(self.native_executions, 0)

    def test_cancel_ack_loss_after_one_success_flushes_tail_and_does_not_retry_cancel(self):
        self.begin()
        self.adapter.claim(0)
        original = self.actual_result()
        self.adapter.settle("succeeded")
        self.client.fail_op = "cancel"
        with self.assertRaises(HookProtocolError):
            self.adapter.cancel("user_update")
        count = len(self.client.requests)
        self.close_round("round_interrupted", uncertain=True)
        results = self.assert_complete()
        self.assertEqual(len(self.client.requests), count)
        self.assertEqual(self.context["messages"][3], original)
        self.assertEqual([row["status"] for row in results], ["succeeded", "cancelled", "cancelled"])
        self.assertEqual(self.native_executions, 1)

    def test_successful_terminal_cleanup_never_duplicates_results_or_reissues_calls(self):
        self.begin()
        for ordinal in range(len(CALLS)):
            self.adapter.claim(ordinal)
            self.actual_result(ordinal)
            self.adapter.settle("succeeded")
        before = copy.deepcopy(self.context["messages"])
        count = len(self.client.requests)
        self.close_round("round_finished")
        self.close_round("round_finished")
        self.assert_complete()
        self.assertEqual(self.context["messages"], before)
        self.assertEqual(len(self.client.requests), count)
        self.assertEqual(self.native_executions, 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
