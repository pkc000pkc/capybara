"""Independent scoped-attempt boundary regressions; synthetic identity only.

Tests exercise the real broker/guard, never an external model. Node-shaped
receipts in these unit fixtures are not claims of real Node/ARE supervision.
The post-SDK case uses a controlled loopback server and the actual pinned SDK.
"""
from __future__ import annotations

import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import contextmanager, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
os.environ.update(LITELLM_LOCAL_MODEL_COST_MAP="True", LITELLM_TELEMETRY="False",
    HF_HUB_OFFLINE="1", HF_DATASETS_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
    HTTP_PROXY="", HTTPS_PROXY="", ALL_PROXY="", http_proxy="", https_proxy="", all_proxy="",
    NO_PROXY="127.0.0.1,::1", no_proxy="127.0.0.1,::1")

_original_connect = socket.socket.connect
EXTERNAL_NETWORK_ATTEMPTS = []


def import_safe_loopback_only(sock, address):
    if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
        EXTERNAL_NETWORK_ATTEMPTS.append(type(address).__name__)
        raise AssertionError("EXTERNAL_NETWORK_FORBIDDEN")
    return _original_connect(sock, address)


# Install before SDK imports as well as before the controlled HTTP calls.
socket.socket.connect = import_safe_loopback_only

import litellm
import gaia2_model_http_guard as guard
from gaia2_deadline_notifications import ScopedOSDeadline
from gaia2_model_retry import ModelRetryPolicy
from gaia2_scoped_model_broker import ScopedRetryModelEngine, ScopedModelBrokerError, model_input_hash

REQUEST_ID = "1" * 32
PERMIT_ID = "2" * 32
MESSAGES = [{"role": "user", "content": "controlled boundary input"}]
CHILD_IDENTITY = {"parentExecutionId": "boundary-execution", "parentSessionId": "boundary-session",
    "childExecutionId": "boundary-child", "childSessionId": "boundary-child-session",
    "delegationScopeHash": "b" * 64}


class DeadlineClock:
    def __init__(self, expire_on_read=None):
        self.reads = 0
        self.expire_on_read = expire_on_read
    def __call__(self):
        self.reads += 1
        return 11.0 if self.expire_on_read and self.reads >= self.expire_on_read else 0.0


class TimingClock:
    def __init__(self, fail_on_read=None):
        self.reads = 0
        self.fail_on_read = fail_on_read
    def __call__(self):
        self.reads += 1
        return math.nan if self.fail_on_read and self.reads >= self.fail_on_read else float(self.reads)


class Configuration:
    def __init__(self, endpoint):
        self.kwargs = {"model": "gpt-6-luna", "custom_llm_provider": "openai",
            "api_base": endpoint, "api_key": "controlled-non-secret"}
    def __call__(self):
        return copy.deepcopy(self.kwargs)


class FakeSdk:
    def __init__(self):
        self.calls = 0
    def __call__(self, **kwargs):
        self.calls += 1
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="controlled"))])


class Admission:
    def __init__(self):
        self.calls = []
    def __call__(self, payload):
        self.calls.append(copy.deepcopy(payload))


class Events:
    def __init__(self):
        self.rows = []
    def __call__(self, kind, **fields):
        self.rows.append({"type": kind, "executionId": "boundary-execution", "sessionId": "boundary-session",
            **fields, **CHILD_IDENTITY})


class StopAfterSdk:
    def __call__(self, stage):
        if stage == "sdk_attempt_after":
            raise RuntimeError("CONTROLLED_STOP_AFTER_SDK")


@contextmanager
def loopback_server():
    state = {"received": 0}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            state["received"] += 1
            data = json.dumps({"id": "controlled-boundary", "object": "chat.completion", "created": 1,
                "model": "gpt-6-luna", "choices": [{"index": 0, "message": {"role": "assistant", "content": "controlled"},
                    "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    instance = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=instance.serve_forever, daemon=True)
    worker.start()
    try:
        yield state, "http://127.0.0.1:" + str(instance.server_port) + "/v1"
    finally:
        instance.shutdown()
        instance.server_close()
        worker.join(2)


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-model-attempt-boundary-")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name)
        (self.output / "official-entry").mkdir()
        self.entry = {"schemaVersion": "gaia2-official-entry-handshake-v1", "runId": "boundary-run",
            "manifestHash": "a" * 64, "executionId": "boundary-execution", "sessionId": "boundary-session",
            "scenarioId": "boundary-scenario", "scenarioVersion": "1", "scenarioHash": "c" * 64,
            "config": "mini", "runNumber": 1, "attemptIndex": 1, "correctionOrdinal": 0,
            "phase": "agent2agent", "launcherProcessId": os.getppid()}
        entry_bytes = json.dumps(self.entry, separators=(",", ":")).encode() + b"\n"
        entry_path = self.output / "official-entry/run-manifest.json"
        entry_path.write_bytes(entry_bytes)
        self.env_patch = patch.dict(os.environ, {"GAIA2_MODEL_HTTP_GUARD_REQUIRED": "1", "GAIA2_OFFICIAL_ENTRY_REQUIRED": "1",
            "GAIA2_OFFICIAL_ENTRY_PATH": str(entry_path), "GAIA2_OFFICIAL_ENTRY_SHA256": hashlib.sha256(entry_bytes).hexdigest(),
            "GAIA2_RUNTIME_EVENT_FILE": str(self.output / "runtime-events.jsonl"),
            "GAIA2_EXECUTION_ID": "boundary-execution", "GAIA2_SESSION_ID": "boundary-session"})
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)
        guard._controller = None
        self.addCleanup(self.close_journal)
        litellm.num_retries = 0
        litellm.drop_params = litellm.modify_params = litellm.add_function_to_prompt = False
        original_connect = socket.socket.connect
        self.external_network_attempts = EXTERNAL_NETWORK_ATTEMPTS
        def loopback_only(sock, address):
            if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
                self.external_network_attempts.append(type(address).__name__)
                raise AssertionError("EXTERNAL_NETWORK_FORBIDDEN")
            return original_connect(sock, address)
        self.network_patch = patch.object(socket.socket, "connect", loopback_only)
        self.network_patch.start()
        self.addCleanup(self.network_patch.stop)
        guard.install_model_http_guard()

    def close_journal(self):
        if guard._controller is not None and guard._controller.fd is not None:
            os.close(guard._controller.fd)
        guard._controller = None

    def engine(self, *, sdk=None, endpoint="http://127.0.0.1:1/v1", timing=None):
        self.sdk = sdk or FakeSdk()
        self.events, self.admission = Events(), Admission()
        config = Configuration(endpoint)
        return ScopedRetryModelEngine(role="child_actor", model_scope_hash="d" * 64,
            sdk_completion=self.sdk, sdk_kwargs_factory=config, policy=ModelRetryPolicy(max_attempts=2, request_timeout_seconds=5),
            max_logical_requests=2, max_sdk_attempts=2, emit=self.events, before_attempt=self.admission,
            http_guard_identity=CHILD_IDENTITY, **({"monotonic_clock": timing} if timing is not None else {}))

    def start(self, engine, *, deadline=None, safe_point=None):
        engine.begin_request(permit_id=PERMIT_ID, request_id=REQUEST_ID, actual_input_hash=model_input_hash(MESSAGES),
            deadline=deadline, safe_point=safe_point)

    def journal_rows(self):
        return [json.loads(line) for line in (self.output / "model-http-dispatch.jsonl").read_bytes().splitlines()]

    def verify_http(self):
        # This verifies event/lease correspondence, not actual process birth or
        # a real Node launch. The separate Node integration must prove those.
        value = {"journal": (self.output / "model-http-dispatch.jsonl").read_text(),
            "events": self.events.rows, "identity": {name: self.entry[name] for name in (
                "runId", "manifestHash", "executionId", "sessionId", "scenarioId", "runNumber", "phase", "config")},
            "entry": (self.output / "official-entry/run-manifest.json").read_text(), "pid": os.getpid()}
        script = """import {readFileSync} from 'node:fs';
import {verifyModelHttpDispatchEvidence} from './src/phase6_http_evidence.mjs';
const v=JSON.parse(readFileSync(0,'utf8'));
try{const result=verifyModelHttpDispatchEvidence({journalBytes:Buffer.from(v.journal),events:v.events,
identity:v.identity,officialEntryBytes:Buffer.from(v.entry),pythonProcessId:v.pid});
console.log(JSON.stringify({passed:true,result}));}catch(e){console.log(JSON.stringify({passed:false,code:e.message}));}
"""
        result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT,
            input=json.dumps(value), capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, "CONTROLLED_NODE_VALIDATOR_FAILED")
        return json.loads(result.stdout)

    def assert_pre_sdk_rejection(self, code):
        self.assertEqual(getattr(self.sdk, "calls", 0), 0)
        self.assertEqual(self.admission.calls, [], "unused Node SDK grants must not masquerade as executed attempts")
        self.assertFalse(any(row["type"] == "model_request_attempt" for row in self.events.rows),
            "final local admission failure must precede SDK attempt accounting")
        rejection = next(row for row in self.events.rows if row["type"] == "model_request_rejected")
        self.assertEqual(rejection["failureCode"], code)
        self.assertNotIn("requestAttempt", rejection)
        finished = next(row for row in self.events.rows if row["type"] == "model_logical_request_finished")
        self.assertEqual(finished["status"], "rejected")
        self.assertEqual(finished["sdkAttempts"], 0)
        self.assertEqual([row["type"] for row in self.journal_rows()], ["guard_initialized"])
        proof = self.verify_http()
        self.assertTrue(proof["passed"], proof)
        self.assertEqual(proof["result"]["attempts"], 0)
        self.assertEqual(proof["result"]["preSdkRejections"], 1)
        self.assertEqual(self.external_network_attempts, [])

    def test_final_deadline_failure_before_sdk_has_no_grant_attempt_or_lease(self):
        engine = self.engine()
        clock = DeadlineClock(expire_on_read=4)
        deadline = ScopedOSDeadline(scope_id=REQUEST_ID, duration_seconds=10, monotonic_clock=clock)
        self.start(engine, deadline=deadline)
        with self.assertRaises(ScopedModelBrokerError) as caught:
            engine.chat_completion(MESSAGES)
        self.assertEqual(caught.exception.code, "SCOPED_MODEL_DEADLINE_EXPIRED")
        self.assert_pre_sdk_rejection(caught.exception.code)
        snapshot = engine.snapshot()
        self.assertEqual(snapshot["lastSdkAttempts"], 0)
        self.assertEqual(snapshot["sdkAttemptsUsed"], 0)

    def test_invalid_attempt_timing_before_sdk_has_no_grant_attempt_or_lease(self):
        engine = self.engine(timing=TimingClock(fail_on_read=2))
        self.start(engine)
        with self.assertRaises(ScopedModelBrokerError) as caught:
            engine.chat_completion(MESSAGES)
        self.assertEqual(caught.exception.code, "SCOPED_MODEL_TIMING_INVALID")
        self.assert_pre_sdk_rejection(caught.exception.code)

    def test_real_sdk_return_then_stop_binds_v1_rejection_to_existing_lease(self):
        with loopback_server() as (state, endpoint):
            engine = self.engine(sdk=litellm.completion, endpoint=endpoint)
            self.start(engine, safe_point=StopAfterSdk())
            with self.assertRaises(ScopedModelBrokerError) as caught:
                engine.chat_completion(MESSAGES)
            self.assertEqual(caught.exception.code, "SCOPED_MODEL_SAFE_POINT_DENIED")
            self.assertEqual(state["received"], 1)
        attempts = [row for row in self.events.rows if row["type"] == "model_request_attempt"]
        self.assertEqual(len(attempts), 1)
        self.assertEqual(len(self.admission.calls), 1)
        self.assertFalse(any(row["type"] == "model_request_succeeded" for row in self.events.rows))
        rejected = next(row for row in self.events.rows if row["type"] == "model_request_rejected")
        self.assertNotIn("requestAttempt", rejected)
        self.assertNotIn("usage", rejected)
        finished = next(row for row in self.events.rows if row["type"] == "model_logical_request_finished")
        self.assertEqual((finished["status"], finished["sdkAttempts"]), ("rejected", 1))
        closed = [row for row in self.journal_rows() if row["type"] == "sdk_attempt_closed"]
        self.assertEqual(len(closed), 1)
        self.assertEqual((closed[0]["sdkCallStatus"], closed[0]["transportStatus"]), ("succeeded", "succeeded"))
        proof = self.verify_http()
        self.assertTrue(proof["passed"], proof)
        self.assertEqual(proof["result"]["attempts"], 1)
        self.assertEqual(proof["result"]["inferredRejectedAttempts"], 1)
        self.assertEqual(proof["result"]["preSdkRejections"], 0)
        self.assertEqual(self.external_network_attempts, [])


if __name__ == "__main__":
    with redirect_stdout(io.StringIO()):
        unittest.main(verbosity=2)
