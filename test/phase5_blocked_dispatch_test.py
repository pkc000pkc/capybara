"""Offline real ARE owner/runner with synthetic sealed Host gate receipts.

These tests exercise the Python contract, not a claim of actual Node Host
execution. The production bridge integration separately supplies that Host.
No provider, Scenario, benchmark result or external network is used here.
"""

import copy
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
import uuid
import random
import re
import shutil
import struct
import subprocess
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "test"))
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

import gaia2_a2a_wire as wire
import phase5_official_a2a_contract_test as adapter_fixture
from gaia2_official_a2a import OfficialA2AError
from gaia2_private_native_binding import (
    NativeAppBinding, NativeBindingError, _registry_action_hash, _registry_canonical_json,
)
from gaia2_scoped_app_agent import ControlledAppAgentEngine, ScopedAppAgentFatal, build_scoped_app_agent
from are.simulation.environment import Environment, EnvironmentConfig
from phase5_private_native_binding_test import Ledger
from phase5_scoped_app_agent_test import action


def sealed(directory, prefix, body):
    data = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    path = directory / (prefix + "-" + uuid.uuid4().hex + ".json")
    with path.open("xb") as output:
        output.write(data)
    return {"path": str(path), "sha256": hashlib.sha256(data).hexdigest()}


class Fixture:
    def __init__(self, directory):
        self.app = Ledger()
        self.env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
        self.env.register_apps([self.app])
        self.owner = NativeAppBinding(self.app, environment_generation="blocked-env", parent_execution_id="blocked-parent",
            parent_session_id="blocked-session", evidence_root=directory / "native", clock=self.env.time_manager.time,
            clock_environment=self.env, trusted_source_files=(Path(__file__), ROOT / "scripts/gaia2_scoped_app_agent.py"))
        self.root = directory
        self.tools = {tool["publicName"]: tool for tool in self.owner.manifest()["tools"]}
        self.scope = self.new_scope()
        self.owner.bind_child({"scope": self.scope})
        self.scope_hash = wire.value_hash(self.scope)
        self.sequence = 0

    def new_scope(self):
        identifier = uuid.uuid4().hex
        task = "offline blocked dispatch task"
        return {"environmentGeneration": "blocked-env", "parentExecutionId": "blocked-parent", "parentSessionId": "blocked-session",
            "appId": self.app.name, "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
            "toolInventoryHash": self.owner.manifest()["toolInventoryHash"], "taskHash": hashlib.sha256(task.encode()).hexdigest(),
            "parentActionId": "parent-" + identifier, "requestId": str(uuid.uuid4()), "childExecutionId": "child-" + identifier,
            "childSessionId": "session-" + identifier, "task": task, "deadline": 1, "maxNativeActions": 12}

    def proof(self, name="Ledger__write", arguments=None, decision="read_back", transform=None, scope=None):
        scope = scope or self.scope
        arguments = {"value": "one"} if arguments is None else arguments
        tool = self.tools[name]
        prepared = self.owner.prepare_native({"scope": scope, "toolId": tool["toolId"], "rawArguments": arguments})
        dispatch = str(uuid.uuid4())
        before_clock = self.owner.observe_clock({"scope": scope, "ticketId": prepared["ticketId"],
            "dispatchId": dispatch, "checkpoint": "before_tool"})
        clock_ref = {**before_clock["evidenceRef"], "path": str(self.root / "native" / before_clock["evidenceRef"]["path"])}
        args_hash = _registry_action_hash(prepared["effectiveArguments"])
        native_action = {key: value for key, value in tool.items() if key not in ("publicName", "signatureHash", "formatterSourceHash")}
        native_action.update(id=dispatch, dispatchId=dispatch, arguments=prepared["effectiveArguments"], argumentsHash=args_hash,
            mutationKey=_registry_action_hash([scope["environmentGeneration"], scope["appId"], tool["resourceKey"], tool["canonicalName"], args_hash]))
        projected = {"id": dispatch, "name": tool["toolId"], "canonicalName": tool["canonicalName"],
            "arguments": native_action["arguments"], "effect": tool["effect"], "mutationKey": native_action["mutationKey"],
            "resourceKey": tool["resourceKey"], "authoritativeRead": tool["effect"] == "read"}
        before = {"schemaVersion": "capybara-runtime-plugin-invocation-v1", "executionId": scope["childExecutionId"],
            "sessionId": scope["childSessionId"], "safetyFailure": None,
            "input": {"checkpoint": "before_tool", "action": projected, "clock": before_clock["clock"]},
            "decision": {"action": decision}, "hookReceipts": [{"hookId": "gaia2-conflict-gate", "matched": True,
                "status": "passed", "decision": {"action": decision}}],
            "trustedNativeCheckpoint": {"schemaVersion": "capybara-trusted-native-checkpoint-v1", "scopeHash": wire.value_hash(scope),
                "actionHash": wire.value_hash(native_action), "checkpoint": "before_tool", "clockEvidenceRef": clock_ref, "hookOutcome": None}}
        if transform:
            transform(before)
        hook_ref = sealed(self.root, "synthetic-before", before)
        payload = {"scope": scope, "ticketId": prepared["ticketId"], "dispatchId": dispatch,
            "beforeClockEvidenceRef": clock_ref, "beforeHookEvidenceRef": hook_ref, "gateDecision": decision}
        return payload, native_action, tool, prepared

    def commit(self, payload, prepared):
        return self.owner.commit_native({"scope": payload["scope"], "ticketId": payload["ticketId"],
            "dispatchId": payload["dispatchId"], "toolId": prepared["toolId"],
            "effectiveArgumentsHash": prepared["effectiveArgumentsHash"]})

    def blocked_ack(self, payload, native_action, tool, discarded):
        self.sequence += 1
        discard_ref = {**discarded["evidenceRef"], "path": str(self.root / "native" / discarded["evidenceRef"]["path"])}
        rejection = {"schemaVersion": "capybara-runtime-delegation-receipt-v1", "environmentGeneration": self.scope["environmentGeneration"],
            "parentExecutionId": self.scope["parentExecutionId"], "parentSessionId": self.scope["parentSessionId"],
            "sequence": self.sequence, "previousHash": None, "kind": "native_rejected",
            "data": {"scope": self.scope, "action": native_action, "started": False, "nativeReturned": False,
                "resultHash": hashlib.sha256(b"native_outcome_unknown").hexdigest(), "code": "DELEGATION_BEFORE_BLOCKED",
                "beforeEvidence": payload["beforeHookEvidenceRef"], "gateDecision": payload["gateDecision"], "nativeDiscardEvidenceRef": discard_ref}}
        ref = sealed(self.root, "synthetic-rejected", rejection)
        return {"schemaVersion": "capybara-scoped-agent-dispatch-blocked-v1", "scopeHash": self.scope_hash,
            "dispatchId": payload["dispatchId"], "toolId": tool["toolId"], "toolKind": tool["toolKind"], "status": "blocked",
            "childCompleted": False, "completionEvidenceRef": None, "gateDecision": payload["gateDecision"], "nativeRejectionEvidenceRef": ref}

    def completed(self, request):
        tool = self.tools[request["tool"]]
        prepared = self.owner.prepare_native({"scope": self.scope, "toolId": tool["toolId"], "rawArguments": request["arguments"]})
        dispatch = str(uuid.uuid4())
        self.owner.observe_clock({"scope": self.scope, "ticketId": prepared["ticketId"], "dispatchId": dispatch, "checkpoint": "before_tool"})
        payload = {"scope": self.scope, "ticketId": prepared["ticketId"], "dispatchId": dispatch}
        outcome = self.commit(payload, prepared)
        if outcome["status"] != "succeeded":
            raise RuntimeError("fixture_native_unknown")
        self.owner.observe_clock({"scope": self.scope, "ticketId": prepared["ticketId"], "dispatchId": dispatch, "checkpoint": "after_tool"})
        final = tool["toolKind"] == "child_final_answer"
        ref = None
        if final:
            ref = sealed(self.root, "synthetic-completed", {"schemaVersion": "capybara-runtime-delegation-receipt-v1",
                "environmentGeneration": self.scope["environmentGeneration"], "parentExecutionId": self.scope["parentExecutionId"],
                "parentSessionId": self.scope["parentSessionId"], "sequence": 1, "previousHash": None, "kind": "completed",
                "data": {"scope": self.scope, "finalDispatchId": dispatch, "finalEvidence": {"fixtureOnly": True}}})
        return {"schemaVersion": "capybara-scoped-agent-dispatch-v1", "scopeHash": self.scope_hash, "dispatchId": dispatch,
            "toolId": tool["toolId"], "toolKind": tool["toolKind"], "status": "completed", "childCompleted": final, "completionEvidenceRef": ref}


class Tests(unittest.TestCase):
    def setUp(self):
        offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        offline.start(); self.addCleanup(offline.stop)
        previous_logging = logging.root.manager.disable
        logging.disable(logging.CRITICAL); self.addCleanup(lambda: logging.disable(previous_logging))
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-blocked-dispatch-")
        self.addCleanup(self.temp.cleanup)
        self.index = 0

    def fixture(self):
        self.index += 1
        directory = Path(self.temp.name) / str(self.index)
        directory.mkdir()
        fixture = Fixture(directory)
        self.addCleanup(fixture.owner.close)
        return fixture

    def runner(self, fixture, responses, dispatch):
        runner = build_scoped_app_agent(app=fixture.app, owner=fixture.owner, env=fixture.env, scope=fixture.scope,
            llm_engine=ControlledAppAgentEngine(responses), dispatch=dispatch)
        self.addCleanup(runner.close)
        return runner

    def test_01_discard_has_source_bound_negative_proof_zero_execution_and_no_replay(self):
        for decision in ("block", "read_back"):
            with self.subTest(decision=decision):
                f = self.fixture()
                payload, _, _, prepared = f.proof(decision=decision)
                ack = f.owner.discard_native(payload)
                self.assertEqual(set(ack), {"schemaVersion", "scopeHash", "ticketId", "dispatchId", "discarded", "evidenceRef"})
                body = json.loads((f.root / "native" / ack["evidenceRef"]["path"]).read_text())
                self.assertEqual(set(body), {"schemaVersion", "sourceManifestHash", "scopeHash", "ticketId", "dispatchId", "toolId",
                    "canonicalName", "toolKind", "effect", "rawArgumentsHash", "effectiveArgumentsHash", "gateDecision",
                    "beforeClockEvidenceRef", "beforeHookEvidenceRef", "discarded", "consumed", "nativeStarted"})
                self.assertEqual(body["sourceManifestHash"], wire.value_hash(f.owner.manifest()))
                self.assertEqual((body["discarded"], body["consumed"], body["nativeStarted"]), (True, False, False))
                self.assertEqual(f.app.calls, 0)
                self.assertEqual(f.env.event_log.list_view(), [])
                with self.assertRaisesRegex(NativeBindingError, "NATIVE_TICKET_INVALID_OR_CONSUMED"):
                    f.commit(payload, prepared)
                with self.assertRaisesRegex(NativeBindingError, "NATIVE_DISCARD_STATE_INVALID"):
                    f.owner.discard_native(payload)
                with self.assertRaisesRegex(NativeBindingError, "NATIVE_RESULT_UNAVAILABLE"):
                    f.owner.take_agent_observation(payload["dispatchId"])
                self.assertEqual(f.owner.cancel_child({"scope": f.scope})["status"], "cancelled")

    def test_02_transport_identity_missing_or_foreign_never_discards(self):
        f = self.fixture(); payload, _, _, _ = f.proof()
        handler = f.owner.handlers()["discard_native"]
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_IDENTITY_REQUIRED"):
            handler(payload)
        identity = f.owner._NativeAppBinding__children[f.scope["requestId"]]["identity"]
        foreign = copy.deepcopy(identity); foreign["childSessionId"] = "foreign"
        with self.assertRaises(NativeBindingError):
            handler({**payload, "identity": foreign})
        self.assertTrue(handler({**payload, "identity": identity})["discarded"])

    def test_03_cross_scope_ticket_dispatch_or_ref_is_rejected(self):
        f = self.fixture(); payload, _, _, _ = f.proof()
        other = f.new_scope(); f.owner.bind_child({"scope": other})
        variants = [{**payload, "scope": other}, {**payload, "ticketId": "f" * 32},
            {**payload, "dispatchId": str(uuid.uuid4())}, {**payload, "gateDecision": "allow"},
            {**payload, "beforeClockEvidenceRef": {**payload["beforeClockEvidenceRef"], "sha256": "0" * 64}},
            {**payload, "beforeHookEvidenceRef": {**payload["beforeHookEvidenceRef"], "sha256": "0" * 64}},
            {**payload, "nativeReturn": "fake"}]
        for candidate in variants:
            with self.subTest(keys=sorted(candidate)):
                with self.assertRaises(NativeBindingError):
                    f.owner.discard_native(candidate)
        self.assertTrue(f.owner.discard_native(payload)["discarded"])
        self.assertEqual(f.app.calls, 0)

    def test_04_allow_wrong_action_clock_or_failed_hook_never_discards(self):
        mutations = [lambda body: body["decision"].update(action="allow"),
            lambda body: body["input"]["action"].update(canonicalName="Other__write"),
            lambda body: body["input"]["clock"].update(now=0),
            lambda body: body["trustedNativeCheckpoint"].update(actionHash="0" * 64),
            lambda body: body["hookReceipts"][0].update(status="failed"),
            lambda body: body["hookReceipts"][0].update(matched=False),
            lambda body: body.update(safetyFailure="fake")]
        for index, mutation in enumerate(mutations):
            with self.subTest(index=index):
                f = self.fixture(); payload, _, _, _ = f.proof(transform=mutation)
                with self.assertRaises(NativeBindingError):
                    f.owner.discard_native(payload)
                self.assertEqual(f.app.calls, 0)

    def test_05_consumed_ticket_cannot_become_blocked(self):
        f = self.fixture(); payload, _, _, prepared = f.proof()
        self.assertEqual(f.commit(payload, prepared)["status"], "succeeded")
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_DISCARD_STATE_INVALID"):
            f.owner.discard_native(payload)
        self.assertEqual(f.app.calls, 1)

    def test_06_active_dispatch_blocks_discard_atomically(self):
        f = self.fixture(); blocked, _, _, _ = f.proof()
        active, _, _, active_prepared = f.proof(arguments={"value": "active"})
        f.app.entered, f.app.release = threading.Event(), threading.Event()
        result = []
        thread = threading.Thread(target=lambda: result.append(f.commit(active, active_prepared)))
        thread.start()
        try:
            self.assertTrue(f.app.entered.wait(2))
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_DISCARD_ACTIVE"):
                f.owner.discard_native(blocked)
        finally:
            f.app.release.set(); thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result[0]["status"], "succeeded")
        self.assertTrue(f.owner.discard_native(blocked)["discarded"])

    def test_07_unknown_prior_write_cannot_be_washed_by_a_read_ticket(self):
        f = self.fixture(); payload, _, _, prepared = f.proof(arguments={"value": "fail"})
        self.assertEqual(f.commit(payload, prepared)["status"], "unknown")
        other = f.new_scope(); f.owner.bind_child({"scope": other})
        read, _, _, _ = f.proof("Ledger__read", {}, scope=other)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_DISCARD_STATE_INVALID"):
            f.owner.discard_native(read)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_UNRESOLVED_APP_MUTATION"):
            f.owner.prepare_native({"scope": other, "toolId": f.tools["Ledger__write"]["toolId"], "rawArguments": {"value": "again"}})
        self.assertEqual(f.app.calls, 1)

    def test_08_negative_receipt_failure_poison_prevents_ticket_commit(self):
        f = self.fixture(); payload, _, _, prepared = f.proof()
        with patch.object(f.owner, "_NativeAppBinding__receipt", side_effect=OSError("private failure")):
            with self.assertRaisesRegex(NativeBindingError, "NATIVE_DISCARD_EVIDENCE_FAILED"):
                f.owner.discard_native(payload)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_BINDING_CHANGED"):
            f.commit(payload, prepared)
        self.assertEqual(f.app.calls, 0)

    def test_09_feedback_then_fresh_read_write_once_and_real_finish(self):
        f = self.fixture(); calls = []
        def dispatch(request):
            calls.append(copy.deepcopy(request))
            if len(calls) == 1:
                payload, native_action, tool, _ = f.proof(request["tool"], request["arguments"])
                return f.blocked_ack(payload, native_action, tool, f.owner.discard_native(payload))
            return f.completed(request)
        runner = self.runner(f, [action("Ledger__write", {"value": "one"}), action("Ledger__read", {}),
            action("Ledger__write", {"value": "one"}), action("final_answer", {"answer": "done"})], dispatch)
        self.assertEqual(runner.run(), "done")
        state = runner.snapshot()
        self.assertEqual((len(state["blockedActions"]), len(state["actions"]), state["originalObservationsTaken"]), (1, 3, 3))
        self.assertEqual((f.app.calls, f.app.reads, f.app.values), (1, 1, ["one"]))
        self.assertEqual(state["blockedActions"][0]["gateDecision"], "read_back")
        self.assertTrue(state["completed"])
        self.assertFalse(state["failed"])
        contents = "\n".join(str(getattr(log, "content", "")) for log in runner.base_agent.logs)
        self.assertIn("not a native tool result", contents)
        self.assertNotIn("private failure", contents)

    def test_10_block_is_control_feedback_not_a_successful_action(self):
        f = self.fixture(); count = [0]
        def dispatch(request):
            count[0] += 1
            if count[0] == 1:
                payload, native_action, tool, _ = f.proof(request["tool"], request["arguments"], decision="block")
                return f.blocked_ack(payload, native_action, tool, f.owner.discard_native(payload))
            return f.completed(request)
        runner = self.runner(f, [action("Ledger__write", {"value": "one"}), action("final_answer", {"answer": "not written"})], dispatch)
        self.assertEqual(runner.run(), "not written")
        state = runner.snapshot()
        self.assertEqual((len(state["actions"]), len(state["blockedActions"]), state["originalObservationsTaken"]), (1, 1, 1))
        self.assertEqual(f.app.calls, 0)

    def test_11_forged_blocked_ack_or_negative_proof_is_fatal(self):
        for alteration in ("value", "hash", "completed", "scope", "decision", "receipt"):
            with self.subTest(alteration=alteration):
                f = self.fixture()
                def dispatch(request):
                    payload, native_action, tool, _ = f.proof(request["tool"], request["arguments"])
                    ack = f.blocked_ack(payload, native_action, tool, f.owner.discard_native(payload))
                    if alteration == "value": ack["value"] = "fake tool result"
                    if alteration == "hash": ack["resultHash"] = "0" * 64
                    if alteration == "completed": ack["childCompleted"] = True
                    if alteration == "scope": ack["scopeHash"] = "0" * 64
                    if alteration == "decision": ack["gateDecision"] = "allow"
                    if alteration == "receipt": ack["nativeRejectionEvidenceRef"]["sha256"] = "0" * 64
                    return ack
                runner = self.runner(f, [action("Ledger__write", {"value": "one"})], dispatch)
                with self.assertRaises(ScopedAppAgentFatal): runner.run()
                state = runner.snapshot()
                self.assertTrue(state["failed"])
                self.assertEqual((state["actions"], state["blockedActions"], state["originalObservationsTaken"]), ([], [], 0))
                self.assertEqual(f.app.calls, 0)

    def test_12_after_or_unknown_dispatch_exception_still_fatal_no_feedback(self):
        for after in (False, True):
            with self.subTest(after=after):
                f = self.fixture()
                def dispatch(request):
                    if after: f.completed(request)
                    raise RuntimeError("private ambiguous native failure")
                runner = self.runner(f, [action("Ledger__write", {"value": "one"})], dispatch)
                with self.assertRaises(ScopedAppAgentFatal): runner.run()
                state = runner.snapshot()
                self.assertEqual(state["blockedActions"], [])
                self.assertTrue(state["failed"])
                self.assertEqual(f.app.calls, int(after))

    def test_15_sealed_rejection_or_discard_semantics_cannot_be_forged(self):
        for alteration in ("started", "returned", "unknown", "foreign_action", "consumed", "native_started", "manifest", "raw_query"):
            with self.subTest(alteration=alteration):
                f = self.fixture()
                def dispatch(request):
                    payload, native_action, tool, _ = f.proof(request["tool"], request["arguments"])
                    ack = f.blocked_ack(payload, native_action, tool, f.owner.discard_native(payload))
                    rejection = json.loads(Path(ack["nativeRejectionEvidenceRef"]["path"]).read_text())
                    data = rejection["data"]
                    if alteration == "started": data["started"] = True
                    if alteration == "returned": data["nativeReturned"] = True
                    if alteration == "unknown": data["code"] = "DELEGATION_NATIVE_FAILED"
                    if alteration == "foreign_action": data["action"]["resourceKey"] = "Other"
                    if alteration in ("consumed", "native_started", "manifest", "raw_query"):
                        discarded = json.loads(Path(data["nativeDiscardEvidenceRef"]["path"]).read_text())
                        if alteration == "consumed": discarded["consumed"] = True
                        if alteration == "native_started": discarded["nativeStarted"] = True
                        if alteration == "manifest": discarded["sourceManifestHash"] = "0" * 64
                        if alteration == "raw_query": discarded["rawArgumentsHash"] = wire.value_hash({"value": "foreign"})
                        data["nativeDiscardEvidenceRef"] = sealed(f.root, "forged-discard", discarded)
                    ack["nativeRejectionEvidenceRef"] = sealed(f.root, "forged-rejection", rejection)
                    return ack
                runner = self.runner(f, [action("Ledger__write", {"value": "one"})], dispatch)
                with self.assertRaises(ScopedAppAgentFatal): runner.run()
                state = runner.snapshot()
                self.assertEqual((state["actions"], state["blockedActions"], state["originalObservationsTaken"]), ([], [], 0))
                self.assertEqual(f.app.calls, 0)

    def test_16_replayed_blocked_dispatch_is_fatal_without_second_native_action(self):
        f = self.fixture(); cache = []
        def dispatch(request):
            if not cache:
                payload, native_action, tool, _ = f.proof(request["tool"], request["arguments"])
                cache.append(f.blocked_ack(payload, native_action, tool, f.owner.discard_native(payload)))
            return copy.deepcopy(cache[0])
        runner = self.runner(f, [action("Ledger__write", {"value": "one"}), action("Ledger__write", {"value": "one"})], dispatch)
        with self.assertRaises(ScopedAppAgentFatal): runner.run()
        state = runner.snapshot()
        self.assertEqual((len(state["blockedActions"]), state["actions"], state["originalObservationsTaken"]), (1, [], 0))
        self.assertEqual(f.app.calls, 0)

    def test_17_blocked_final_answer_does_not_complete_or_consume_an_observation(self):
        f = self.fixture(); requests = []
        def dispatch(request):
            requests.append(request)
            if len(requests) == 1:
                payload, native_action, tool, _ = f.proof("final_answer", request["arguments"], decision="block")
                return f.blocked_ack(payload, native_action, tool, f.owner.discard_native(payload))
            return f.completed(request)
        runner = self.runner(f, [action("final_answer", {"answer": "not completed"}),
            action("Ledger__read", {}), action("final_answer", {"answer": "real completion"})], dispatch)
        self.assertEqual(runner.run(), "real completion")
        state = runner.snapshot()
        self.assertEqual((len(state["blockedActions"]), len(state["actions"]), state["originalObservationsTaken"]), (1, 2, 2))
        self.assertEqual(state["blockedActions"][0]["toolKind"], "child_final_answer")
        self.assertNotEqual(state["blockedActions"][0]["dispatchId"], state["actions"][-1]["dispatchId"])

    def test_18_no_after_clock_or_event_is_invented_for_discarded_ticket(self):
        f = self.fixture(); payload, _, _, _ = f.proof()
        f.owner.discard_native(payload)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CLOCK_AFTER_INVALID_OR_REUSED"):
            f.owner.observe_clock({"scope": f.scope, "ticketId": payload["ticketId"], "dispatchId": payload["dispatchId"],
                "checkpoint": "after_tool"})
        names = [path.name.split("-", 1)[0] for path in (f.root / "native" / "json").iterdir()]
        self.assertEqual(sorted(names), ["clock", "discard"])
        self.assertEqual(f.env.event_log.list_view(), [])

    def test_19_legacy_owner_does_not_advertise_unprovable_discard_capability(self):
        app = Ledger(); env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False)); env.register_apps([app])
        owner = NativeAppBinding(app, environment_generation="legacy", parent_execution_id="parent", parent_session_id="session",
            evidence_root=Path(self.temp.name) / "legacy", clock=env.time_manager.time)
        self.addCleanup(owner.close)
        self.assertNotIn("discard_native", owner.handlers())
        self.assertNotIn("observe_clock", owner.handlers())

    def node_canonical(self, values):
        node = shutil.which("node")
        self.assertIsNotNone(node, "The cross-language contract requires the configured local Node runtime")
        registry = (ROOT.parents[1] / "capybara-backend/src/core/plugins/runtime-delegation-registry.ts").read_text(encoding="utf-8")
        matched = re.search(r"function canonical\(value: JsonValue\): string \{(.*?)\n\}", registry, re.S)
        self.assertIsNotNone(matched, "Read the actual backend canonical implementation, not a duplicated test guess")
        canonical = "function canonical(value) {" + matched.group(1).replace(" as JsonValue", "") + "\n}"
        script = ("const { createHash } = require('node:crypto');"
            "const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);"
            + canonical + "\nlet input = ''; process.stdin.setEncoding('utf8');"
            "process.stdin.on('data', value => { input += value; });"
            "process.stdin.on('end', () => { const results = JSON.parse(input).map(value => { const text = canonical(value);"
            "return {text, hash: createHash('sha256').update(text).digest('hex')}; }); process.stdout.write(JSON.stringify(results)); });")
        result = subprocess.run([node, "-e", script], input=json.dumps(values, ensure_ascii=False, allow_nan=False).encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
        self.assertEqual(result.returncode, 0, "Local canonical-reference subprocess failed")
        return json.loads(result.stdout.decode("utf-8"))

    def test_20_registry_canonical_matches_actual_node_utf16_keys_and_numeric_boundaries(self):
        values = [{}, {"value": "one", "optional": "default"}, {"2": True, "10": 1, "01": 1.0, "0": -0.0},
            {"\ue000": "BMP", "😀": "nonBMP", "中": {"line": "quote\"slash\\\b\f\n\r\t\u001f\u2028\u2029"}},
            {"array": [True, 1, 1.0, False, 0, -0.0, None, "🦫"]}]
        numbers = [0, -0.0, 1.0, -1.0, 0.1, 0.1 + 0.2, 1.5, -1.5, 1e-5, 1e-6, 1e-7,
            math.nextafter(1e-6, 0), math.nextafter(1e-6, 1), math.nextafter(1e-7, 0), math.nextafter(1e-7, 1),
            5e-324, math.nextafter(2.0 ** -1022, 0), 2.0 ** -1022, 0.0000012345678901234567,
            9007199254740991, 9007199254740990.0, -9007199254740991]
        values.extend({"number": number} for number in numbers)
        expected = self.node_canonical(values)
        for index, (value, reference) in enumerate(zip(values, expected)):
            with self.subTest(index=index):
                self.assertEqual(_registry_canonical_json(value), reference["text"])
                self.assertEqual(_registry_action_hash(value), reference["hash"])
        self.assertNotEqual(_registry_action_hash({"value": True}), _registry_action_hash({"value": 1}))
        self.assertEqual(_registry_action_hash({"value": 1}), _registry_action_hash({"value": 1.0}))
        self.assertNotEqual(_registry_action_hash({"value": "one"}), wire.value_hash({"value": "one"}))

    def test_21_registry_canonical_matches_5000_deterministic_binary64_values_in_local_node(self):
        generator = random.Random(20261013)
        values = []
        while len(values) < 5000:
            value = struct.unpack(">d", generator.getrandbits(64).to_bytes(8, "big"))[0]
            if math.isfinite(value) and (not value.is_integer() or abs(value) <= wire.MAX_SAFE_INTEGER):
                values.append(value)
        expected = self.node_canonical(values)
        for index, (value, reference) in enumerate(zip(values, expected)):
            with self.subTest(index=index):
                self.assertEqual(_registry_canonical_json(value), reference["text"])

    def test_22_registry_canonical_preserves_existing_wire_rejections_and_depth_bounds(self):
        for value in (float("nan"), float("inf"), -float("inf"), 1e20, 1e21, wire.MAX_SAFE_INTEGER + 1,
                      {"constructor": "forbidden"}, {"surrogate": "\ud800"}):
            with self.subTest(type=type(value).__name__):
                with self.assertRaises(NativeBindingError): _registry_action_hash(value)
        cyclic = []; cyclic.append(cyclic)
        with self.assertRaises(NativeBindingError): _registry_action_hash(cyclic)

    def test_23_wire_hash_substituted_for_registry_action_hash_is_rejected(self):
        f = self.fixture()
        payload, native_action, _, _ = f.proof()
        before = json.loads(Path(payload["beforeHookEvidenceRef"]["path"]).read_text())
        legacy_wrong = copy.deepcopy(native_action)
        legacy_wrong["argumentsHash"] = wire.value_hash(native_action["arguments"])
        legacy_wrong["mutationKey"] = wire.value_hash([f.scope["environmentGeneration"], f.scope["appId"],
            native_action["resourceKey"], native_action["canonicalName"], legacy_wrong["argumentsHash"]])
        before["trustedNativeCheckpoint"]["actionHash"] = wire.value_hash(legacy_wrong)
        before["input"]["action"]["mutationKey"] = legacy_wrong["mutationKey"]
        payload["beforeHookEvidenceRef"] = sealed(f.root, "wrong-wire-action", before)
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_DISCARD_HOOK_INVALID"):
            f.owner.discard_native(payload)
        self.assertEqual(f.app.calls, 0)

    def captured_adapter(self, result):
        fixture = adapter_fixture.OfficialA2AContractTests("runTest")
        client = fixture.lifetime_client()
        fixture.begin(client)
        client._OfficialA2AClient__tool_ids = {"Contacts__get_contact": "native-1"}
        with patch("gaia2_official_a2a.build_scoped_app_agent", side_effect=adapter_fixture.CapturedRunner):
            captured = client.child_runner()
        # FakePeer now acknowledges a2a_sync_clock without consuming replies;
        # only the actual a2a_dispatch response belongs in this queue.
        client._OfficialA2AClient__peer = adapter_fixture.FakePeer([result])
        return captured.kwargs["dispatch"]

    def test_13_official_adapter_forwards_only_distinct_blocked_ack(self):
        f = self.fixture(); payload, native_action, tool, _ = f.proof()
        ack = f.blocked_ack(payload, native_action, tool, f.owner.discard_native(payload))
        raw = {"dispatchId": ack["dispatchId"], "status": "blocked", "gateDecision": "read_back",
            "evidence": ack["nativeRejectionEvidenceRef"], "toolId": "native-1", "toolKind": "app_tool", "completionEvidenceRef": None}
        dispatch = self.captured_adapter(raw)
        converted = dispatch({"tool": "Contacts__get_contact", "arguments": {}})
        self.assertEqual(set(converted), {"schemaVersion", "scopeHash", "dispatchId", "toolId", "toolKind", "status",
            "childCompleted", "completionEvidenceRef", "gateDecision", "nativeRejectionEvidenceRef"})
        self.assertEqual(converted["schemaVersion"], "capybara-scoped-agent-dispatch-blocked-v1")
        self.assertFalse(converted["childCompleted"])
        self.assertNotIn("value", converted)
        self.assertNotIn("resultHash", converted)

    def test_14_official_adapter_rejects_fake_success_or_extra_value_in_blocked_result(self):
        raw = {"dispatchId": str(uuid.uuid4()), "status": "blocked", "gateDecision": "read_back",
            "evidence": {"path": str(Path(self.temp.name) / "not-read.json"), "sha256": "0" * 64},
            "toolId": "native-1", "toolKind": "app_tool", "completionEvidenceRef": None}
        for update in ({"value": "fake"}, {"resultHash": "0" * 64}, {"toolId": "foreign"}, {"gateDecision": "allow"},
                       {"completionEvidenceRef": raw["evidence"]}, {"toolKind": "child_final_answer"}):
            with self.subTest(update=sorted(update)):
                dispatch = self.captured_adapter({**raw, **update})
                with self.assertRaisesRegex(OfficialA2AError, "A2A_NATIVE_BLOCKED_RESULT_INVALID"):
                    dispatch({"tool": "Contacts__get_contact", "arguments": {}})


if __name__ == "__main__":
    unittest.main()
