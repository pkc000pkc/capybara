"""Controlled loopback transport tests. Never calls an external model."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager, redirect_stdout
from contextvars import copy_context
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
os.environ.update(LITELLM_LOCAL_MODEL_COST_MAP="True", LITELLM_TELEMETRY="False",
    HF_HUB_OFFLINE="1", HF_DATASETS_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
    HTTP_PROXY="", HTTPS_PROXY="", ALL_PROXY="", http_proxy="", https_proxy="", all_proxy="",
    NO_PROXY="127.0.0.1,::1", no_proxy="127.0.0.1,::1")
_connect = socket.socket.connect
EXTERNAL_ATTEMPTS = []


def loopback_only(sock, address):
    if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
        EXTERNAL_ATTEMPTS.append(type(address).__name__)
        raise AssertionError("EXTERNAL_NETWORK_FORBIDDEN")
    return _connect(sock, address)


socket.socket.connect = loopback_only
import litellm
import httpx2
import openai
import gaia2_model_http_guard as guard
import gaia2_scoped_model_broker as broker_module
from gaia2_deadline_notifications import ScopedOSDeadline
from gaia2_model_retry import ModelRetryPolicy, ModelRequestFailure, wrap_completion, classify_model_error, install_model_retries
from gaia2_scoped_model_broker import ScopedRetryModelEngine, ScopedModelBrokerError, model_input_hash

TRIGGERS = {"alternating": "Conversation roles must alternate user/assistant",
    "last-user": "Last message must have role `user`",
    "tool-index": "unknown field: parameter index is not a valid field"}


@contextmanager
def server(mode="normal"):
    state = {"received": 0, "hashes": []}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass
        def do_POST(self):
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            state["received"] += 1
            state["hashes"].append(hashlib.sha256(raw).hexdigest())
            if mode == "redirect":
                self.send_response(307)
                self.send_header("Location", "/other/chat/completions")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            status = (400 if mode in TRIGGERS else 408 if mode == "408-always" or mode == "408" and state["received"] == 1
                else int(mode) if mode in ("400", "401", "403", "422")
                else 503 if mode == "503" and state["received"] == 1 else 200)
            value = {"error": {"message": TRIGGERS[mode], "code": "invalid_request_error"}} if mode in TRIGGERS else (
                {"error": {"message": "controlled transient", "type": "invalid_request_error" if status == 408 else "server_error"}} if status >= 400 else {
                "id": "controlled", "object": "chat.completion", "created": 1, "model": "gpt-6-luna",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "controlled-ok"}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
            data = json.dumps(value).encode()
            self.send_response(status)
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


def sdk_kwargs(endpoint, kind="normal"):
    messages = [{"role": "user", "content": "controlled private prompt"}]
    if kind == "alternating":
        messages.append({"role": "user", "content": "controlled followup"})
    if kind == "last-user":
        messages.append({"role": "assistant", "content": "controlled prior"})
    if kind == "tool-index":
        messages.extend([{"role": "assistant", "content": None, "tool_calls": [{"id": "controlled-call", "index": 0,
            "type": "function", "function": {"name": "controlled_tool", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "controlled-call", "content": "controlled result"}])
    return {"model": "gpt-6-luna", "custom_llm_provider": "openai", "messages": messages,
        "api_base": endpoint, "api_key": "controlled-non-secret", "timeout": 5.0,
        "num_retries": 0, "max_retries": 0, "retry_policy": None,
        "context_window_fallback_dict": {}, "fallbacks": [], "drop_params": False}


def trusted_child_identity():
    return {"parentExecutionId": os.environ["GAIA2_EXECUTION_ID"], "parentSessionId": os.environ["GAIA2_SESSION_ID"],
        "childExecutionId": "controlled-child-execution", "childSessionId": "controlled-child-session",
        "delegationScopeHash": "a" * 64, "modelScopeHash": "b" * 64, "configHash": "c" * 64,
        "permitId": "d" * 32, "actualInputHash": "e" * 64}


def emit_to(events, extra_identity=None):
    def emit(kind, **fields):
        events.append({"type": kind, "executionId": os.environ.get("GAIA2_EXECUTION_ID"),
            "sessionId": os.environ.get("GAIA2_SESSION_ID"), **fields, **(extra_identity or {})})
    return emit


def transport_code_replacement(*args, **kwargs):
    return None


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="gaia2-http-guard-unit-")
        self.addCleanup(self.tmp.cleanup)
        self.out = Path(self.tmp.name)
        (self.out / "official-entry").mkdir()
        value = {"schemaVersion": "gaia2-official-entry-handshake-v1", "runId": "controlled-run",
            "manifestHash": "f" * 64, "executionId": "controlled-execution", "sessionId": "controlled-session",
            "scenarioId": "controlled-scenario", "scenarioVersion": "1", "scenarioHash": "a" * 64,
            "config": "mini", "runNumber": 1, "attemptIndex": 1, "correctionOrdinal": 0,
            "phase": "standard", "launcherProcessId": os.getppid()}
        raw = guard._json(value) + b"\n"
        entry = self.out / "official-entry/run-manifest.json"
        entry.write_bytes(raw)
        self.environment = patch.dict(os.environ, {"GAIA2_MODEL_HTTP_GUARD_REQUIRED": "1",
            "GAIA2_OFFICIAL_ENTRY_REQUIRED": "1", "GAIA2_OFFICIAL_ENTRY_PATH": str(entry),
            "GAIA2_OFFICIAL_ENTRY_SHA256": hashlib.sha256(raw).hexdigest(),
            "GAIA2_RUNTIME_EVENT_FILE": str(self.out / "runtime-events.jsonl"),
            "GAIA2_EXECUTION_ID": "controlled-execution", "GAIA2_SESSION_ID": "controlled-session"})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.addCleanup(self.close_journal)
        guard._controller = None
        litellm.num_retries = 0
        litellm.drop_params = litellm.modify_params = litellm.add_function_to_prompt = False

    def close_journal(self):
        if guard._controller is not None and guard._controller.fd is not None:
            os.close(guard._controller.fd)
        guard._controller = None

    def rows(self):
        rows = [json.loads(line) for line in (self.out / "model-http-dispatch.jsonl").read_bytes().splitlines()]
        previous = None
        for index, row in enumerate(rows, 1):
            self.assertEqual(row["sequence"], index)
            self.assertEqual(row["previousRecordSha256"], previous)
            expected = row.pop("recordSha256")
            self.assertEqual(hashlib.sha256(guard._json(row)).hexdigest(), expected)
            row["recordSha256"] = expected
            previous = expected
        serialized = json.dumps(rows)
        for forbidden in ("controlled private prompt", "controlled-non-secret", "http://", "Authorization", "messages", "api_key"):
            self.assertNotIn(forbidden, serialized)
        return rows

    def call(self, endpoint, *, completion=litellm.completion, role="actor", kind="normal", request_id="1" * 32, attempt=1):
        kwargs = sdk_kwargs(endpoint, kind)
        original = copy.deepcopy(kwargs)
        try:
            return guard.guarded_sdk_attempt(completion, role, request_id, attempt, kwargs=kwargs,
                additional_identity=trusted_child_identity() if role == "child_actor" else None)
        finally:
            self.assertEqual(kwargs, original)

    def assert_permanent(self, call, code=None):
        with self.assertRaises(guard.ModelHttpGuardFailure) as caught:
            call()
        self.assertFalse(classify_model_error(caught.exception)["retryable"])
        if code:
            self.assertEqual(caught.exception.guard_code, code)

    def scoped_engine(self, endpoint, events, before, **options):
        config = sdk_kwargs(endpoint)
        messages = config.pop("messages")
        identity = trusted_child_identity()
        scope_identity = {key: identity[key] for key in ("parentExecutionId", "parentSessionId",
            "childExecutionId", "childSessionId", "delegationScopeHash")}
        engine = ScopedRetryModelEngine(role="child_actor", model_scope_hash="b" * 64,
            sdk_completion=options.pop("sdk_completion", litellm.completion),
            sdk_kwargs_factory=lambda: copy.deepcopy(config),
            policy=ModelRetryPolicy(max_attempts=2, request_timeout_seconds=5),
            max_logical_requests=1, max_sdk_attempts=2, emit=emit_to(events, scope_identity),
            before_attempt=before, http_guard_identity=scope_identity, **options)
        return engine, messages

    def verify_http(self, events):
        entry = Path(os.environ["GAIA2_OFFICIAL_ENTRY_PATH"]).read_text()
        receipt = json.loads(entry)
        value = {"journal": (self.out / "model-http-dispatch.jsonl").read_text(), "events": events,
            "identity": {name: receipt[name] for name in (
                "runId", "manifestHash", "executionId", "sessionId", "scenarioId", "runNumber", "phase", "config")},
            "entry": entry, "pid": os.getpid()}
        script = """import {readFileSync} from 'node:fs';
import {verifyModelHttpDispatchEvidence} from './src/phase6_http_evidence.mjs';
const v=JSON.parse(readFileSync(0,'utf8'));
const result=verifyModelHttpDispatchEvidence({journalBytes:Buffer.from(v.journal),events:v.events,
identity:v.identity,officialEntryBytes:Buffer.from(v.entry),pythonProcessId:v.pid});
console.log(JSON.stringify(result));
"""
        result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT,
            input=json.dumps(value), capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, "CONTROLLED_NODE_HTTP_VALIDATOR_FAILED")
        return json.loads(result.stdout)

    def test_public_sdk_url_normalization_without_network(self):
        cases = (
            ("http://LOCALHOST:80/v1", "http://localhost/v1/chat/completions"),
            ("https://EXAMPLE.COM:443/v1", "https://example.com/v1/chat/completions"),
            ("http://LOCALHOST:8080/a/../v1", "http://localhost:8080/v1/chat/completions"),
            ("https://EXAMPLE.COM:443/v1//a%2Fb", "https://example.com/v1//a%2Fb/chat/completions"),
        )
        initial_external_attempts = len(EXTERNAL_ATTEMPTS)
        for endpoint, expected in cases:
            with self.subTest(endpoint=endpoint):
                client = openai.OpenAI(api_key="controlled-non-secret", base_url=endpoint,
                    max_retries=0, http_client=httpx2.Client())
                try:
                    self.assertEqual(guard._sdk_completion_url(client), expected)
                finally:
                    client.close()
        self.assertEqual(len(EXTERNAL_ATTEMPTS), initial_external_attempts)
        self.assertFalse((self.out / "model-http-dispatch.jsonl").exists())

    def test_normalized_dot_segments_actual_loopback_dispatch(self):
        with server() as (state, endpoint):
            self.assertEqual(self.call(endpoint + "/discard/../").choices[0].message.content, "controlled-ok")
            self.assertEqual(state["received"], 1)
        self.assertEqual(self.rows()[-1]["transportStatus"], "succeeded")

    def test_scoped_transport_alias_replacement_denied_before_sdk(self):
        events, before, replacements = [], [], []
        def replacement(*args, **kwargs):
            replacements.append(True)
        guard.install_model_http_guard()
        with server() as (state, endpoint):
            engine, messages = self.scoped_engine(endpoint, events, lambda payload: before.append(payload))
            engine.begin_request(permit_id="d" * 32, request_id="1" * 32,
                actual_input_hash=model_input_hash(messages))
            with patch.object(broker_module, "guarded_sdk_attempt", replacement):
                with self.assertRaises(ScopedModelBrokerError) as caught:
                    engine.chat_completion(messages)
                self.assertEqual(caught.exception.code, "SCOPED_MODEL_SOURCE_CHANGED")
            self.assertEqual(state["received"], 0)
            self.assertEqual(replacements, [])
            self.assertEqual(before, [])
            self.assertEqual(engine.snapshot()["sdkAttemptsUsed"], 0)
        self.assertFalse(any(row["type"] == "model_request_attempt" for row in events))
        self.assertEqual([row["type"] for row in self.rows()], ["guard_initialized"])

    def test_scoped_transport_code_replacement_denied_before_sdk(self):
        events, before = [], []
        guard.install_model_http_guard()
        with server() as (state, endpoint):
            engine, messages = self.scoped_engine(endpoint, events, lambda payload: before.append(payload))
            engine.begin_request(permit_id="d" * 32, request_id="1" * 32,
                actual_input_hash=model_input_hash(messages))
            transport = broker_module.guarded_sdk_attempt
            original = transport.__code__
            try:
                transport.__code__ = transport_code_replacement.__code__
                with self.assertRaises(ScopedModelBrokerError) as caught:
                    engine.chat_completion(messages)
                self.assertEqual(caught.exception.code, "SCOPED_MODEL_SOURCE_CHANGED")
            finally:
                transport.__code__ = original
            self.assertEqual(state["received"], 0)
            self.assertEqual(before, [])
            self.assertEqual(engine.snapshot()["sdkAttemptsUsed"], 0)
        self.assertFalse(any(row["type"] == "model_request_attempt" for row in events))
        self.assertEqual([row["type"] for row in self.rows()], ["guard_initialized"])

    def test_ack_elapsed_is_not_successful_sdk_elapsed(self):
        events, grants, clock = [], [], {"now": 0.0}
        def monotonic():
            return clock["now"]
        def admit(payload):
            grants.append(payload)
            clock["now"] += 7.0
        def completion(**kwargs):
            clock["now"] += 2.0
            return litellm.completion(**kwargs)
        with server() as (state, endpoint):
            engine, messages = self.scoped_engine(endpoint, events, admit,
                monotonic_clock=monotonic, sdk_completion=completion)
            engine.begin_request(permit_id="d" * 32, request_id="1" * 32,
                actual_input_hash=model_input_hash(messages))
            self.assertEqual(engine.chat_completion(messages)[0], "controlled-ok")
            timing = engine.get_last_timing()
            self.assertEqual(timing["successfulSdkElapsedSeconds"], 2.0)
            self.assertEqual(timing["sdkAttemptElapsedSeconds"], 2.0)
            self.assertEqual(timing["logicalElapsedSeconds"], 9.0)
            self.assertEqual(len(grants), 1)
            self.assertEqual(state["received"], 1)
        self.assertEqual(self.verify_http(events)["admittedDispatches"], 1)

    def test_ack_crosses_deadline_lease_closes_without_http(self):
        events, grants, clock = [], [], {"now": 0.0}
        def monotonic():
            return clock["now"]
        def admit(payload):
            grants.append(payload)
            clock["now"] = 11.0
        with server() as (state, endpoint):
            engine, messages = self.scoped_engine(endpoint, events, admit, monotonic_clock=monotonic)
            deadline = ScopedOSDeadline(scope_id="1" * 32, duration_seconds=10, monotonic_clock=monotonic)
            engine.begin_request(permit_id="d" * 32, request_id="1" * 32,
                actual_input_hash=model_input_hash(messages), deadline=deadline)
            with self.assertRaises(ScopedModelBrokerError) as caught:
                engine.chat_completion(messages)
            self.assertEqual(caught.exception.code, "SCOPED_MODEL_DEADLINE_EXPIRED")
            self.assertEqual(state["received"], 0)
            self.assertEqual(len(grants), 1)
            self.assertEqual(engine.snapshot()["sdkAttemptsUsed"], 1)
            self.assertIsNone(engine.get_last_usage())
        self.assertEqual([row["type"] for row in self.rows()],
            ["guard_initialized", "sdk_attempt_started", "sdk_attempt_closed"])
        closed = self.rows()[-1]
        self.assertEqual(closed["sdkCallStatus"], "failed")
        self.assertEqual(closed["transportStatus"], "failed")
        self.assertEqual(closed["admittedDispatches"], 0)
        self.assertTrue(closed["leaseClosed"] and closed["clientClosed"])
        self.assertEqual(sum(row["type"] == "model_request_attempt" for row in events), 1)
        rejected = next(row for row in events if row["type"] == "model_request_rejected")
        self.assertNotIn("requestAttempt", rejected)
        self.assertEqual(rejected["failureCode"], "SCOPED_MODEL_DEADLINE_EXPIRED")
        self.assertEqual(events[-1]["sdkAttempts"], 1)
        proof = self.verify_http(events)
        self.assertEqual(proof["attempts"], 1)
        self.assertEqual(proof["admittedDispatches"], 0)
        self.assertEqual(proof["inferredRejectedAttempts"], 1)

    def test_ack_within_deadline_dispatches_once(self):
        events, grants, clock = [], [], {"now": 0.0}
        def monotonic():
            return clock["now"]
        def admit(payload):
            grants.append(payload)
            clock["now"] = 7.0
        with server() as (state, endpoint):
            engine, messages = self.scoped_engine(endpoint, events, admit, monotonic_clock=monotonic)
            deadline = ScopedOSDeadline(scope_id="1" * 32, duration_seconds=10, monotonic_clock=monotonic)
            engine.begin_request(permit_id="d" * 32, request_id="1" * 32,
                actual_input_hash=model_input_hash(messages), deadline=deadline)
            self.assertEqual(engine.chat_completion(messages)[0], "controlled-ok")
            self.assertEqual(state["received"], 1)
            self.assertEqual(len(grants), 1)
        proof = self.verify_http(events)
        self.assertEqual(proof["attempts"], 1)
        self.assertEqual(proof["admittedDispatches"], 1)
        self.assertEqual(proof["responseCount"], 1)

    def test_actor_judge_correction_child_one_dispatch_each(self):
        with server() as (state, endpoint):
            for index, role in enumerate(("actor", "judge", "correction", "child_actor"), 1):
                result = self.call(endpoint, role=role, request_id=str(index) * 32)
                self.assertEqual(result.choices[0].message.content, "controlled-ok")
            self.assertEqual(state["received"], 4)
        rows = self.rows()
        closes = [row for row in rows if row["type"] == "sdk_attempt_closed"]
        self.assertEqual(len(closes), 4)
        self.assertTrue(all(row["admittedDispatches"] == row["responseCount"] == 1 and row["deniedDispatches"] == 0
            and row["clientClosed"] and row["leaseClosed"] and row["transportStatus"] == "succeeded" for row in closes))

    def test_litellm_compatibility_rewrites_denied(self):
        for index, kind in enumerate(TRIGGERS, 1):
            with self.subTest(kind=kind), server(kind) as (state, endpoint):
                self.assert_permanent(lambda: self.call(endpoint, kind=kind, request_id=str(index) * 32), "HTTP_GUARD_REDISPATCH_DENIED")
                self.assertEqual(state["received"], 1)
        rows = self.rows()
        denied = [row for row in rows if row["type"] == "redispatch_denied"]
        self.assertEqual(len(denied), 3)
        self.assertTrue(all(row["originalBodyHash"] != row["candidateBodyHash"] for row in denied))

    def test_redirect_second_send_denied(self):
        with server("redirect") as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint), "HTTP_GUARD_REDISPATCH_DENIED")
            self.assertEqual(state["received"], 1)
        self.assertEqual(self.rows()[-1]["deniedDispatches"], 1)

    def test_http_auth_second_send_denied(self):
        class TwoSendAuth(httpx2.Auth):
            def auth_flow(self, request):
                yield request
                yield request
        original_client = httpx2.Client
        class AuthenticatedClient(original_client):
            def __init__(self, **kwargs):
                super().__init__(auth=TwoSendAuth(), **kwargs)
        with patch.object(httpx2, "Client", AuthenticatedClient), server() as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint), "HTTP_GUARD_REDISPATCH_DENIED")
            self.assertEqual(state["received"], 1)
        self.assertEqual(self.rows()[-1]["deniedDispatches"], 1)

    def test_outer_503_retry_new_attempt_same_input(self):
        events, waits = [], []
        call = wrap_completion(litellm.completion, "actor", emit_to(events),
            policy=ModelRetryPolicy(max_attempts=2, request_timeout_seconds=5), sleep=waits.append)
        with server("503") as (state, endpoint):
            kwargs = sdk_kwargs(endpoint)
            original = copy.deepcopy(kwargs)
            self.assertEqual(call(**kwargs).choices[0].message.content, "controlled-ok")
            self.assertEqual(kwargs, original)
            self.assertEqual(state["received"], 2)
            self.assertEqual(len(set(state["hashes"])), 1)
        closes = [row for row in self.rows() if row["type"] == "sdk_attempt_closed"]
        self.assertEqual([row["requestAttempt"] for row in closes], [1, 2])
        self.assertEqual(len(set(row["requestId"] for row in closes)), 1)
        self.assertEqual(waits, [2])

    def test_real_litellm_http408_sdk400_retry_preserves_diagnostics_and_body(self):
        events, waits, caller_tool_effects = [], [], []
        call = wrap_completion(litellm.completion, "judge", emit_to(events),
            policy=ModelRetryPolicy(request_timeout_seconds=5), sleep=waits.append)
        with server("408") as (state, endpoint):
            kwargs = sdk_kwargs(endpoint)
            original = copy.deepcopy(kwargs)
            def caller_turn():
                caller_tool_effects.append("controlled tool effect")
                return call(**kwargs)
            self.assertEqual(caller_turn().choices[0].message.content, "controlled-ok")
            self.assertEqual(kwargs, original)
            self.assertEqual(state["received"], 2)
            self.assertEqual(len(set(state["hashes"])), 1)
        failed = next(row for row in events if row["type"] == "model_request_failed")
        self.assertEqual(failed["diagnostic"]["sdkReportedStatus"], 400)
        self.assertEqual(failed["diagnostic"]["exceptionClass"], "BadRequestError")
        self.assertEqual(failed["httpStatus"], 408)
        self.assertEqual(failed["category"], "request_timeout")
        self.assertTrue(failed["retryable"])
        self.assertEqual(failed["classificationSource"], "trusted_http_guard")
        self.assertEqual(failed["httpStatusSource"], "trusted_http_guard")
        closed = next(row for row in self.rows() if row["type"] == "sdk_attempt_closed")
        self.assertEqual(failed["httpGuardClosedRecordSha256"], closed["recordSha256"])
        self.assertEqual(waits, [2])
        self.assertEqual(caller_tool_effects, ["controlled tool effect"])
        self.assertEqual(EXTERNAL_ATTEMPTS, [])
        self.assertEqual(self.verify_http(events)["attempts"], 2)
        serialized = json.dumps(events)
        for forbidden in ("controlled private prompt", "controlled-non-secret", "http://", "Authorization", "api_key"):
            self.assertNotIn(forbidden, serialized)
        self.assertNotIn("usage", failed)

    def test_http408_retry_ceiling_remains_six(self):
        events, waits = [], []
        call = wrap_completion(litellm.completion, "actor", emit_to(events),
            policy=ModelRetryPolicy(request_timeout_seconds=5), sleep=waits.append)
        with server("408-always") as (state, endpoint):
            with self.assertRaises(ModelRequestFailure) as caught:
                call(**sdk_kwargs(endpoint))
            self.assertEqual(state["received"], 6)
            self.assertEqual(len(set(state["hashes"])), 1)
        self.assertEqual(waits, [2, 4, 8, 16, 30, 2])
        self.assertEqual(caught.exception.metadata["requestAttempt"], 6)
        self.assertTrue(caught.exception.metadata["retryExhausted"])
        self.assertEqual(self.verify_http(events)["attempts"], 6)
        self.assertEqual(sum(row["type"] == "model_request_failed" for row in events), 6)

    def test_real_permanent_http_statuses_never_get_408_override(self):
        for role, mode in (("actor", "400"), ("judge", "401"), ("correction", "403"), ("actor", "422")):
            events, waits = [], []
            call = wrap_completion(litellm.completion, role, emit_to(events),
                policy=ModelRetryPolicy(request_timeout_seconds=5), sleep=waits.append)
            with self.subTest(mode=mode), server(mode) as (state, endpoint):
                with self.assertRaises(ModelRequestFailure) as caught:
                    call(**sdk_kwargs(endpoint))
                self.assertEqual(state["received"], 1)
                self.assertFalse(caught.exception.retryable)
                self.assertNotIn("classificationSource", caught.exception.metadata)
                self.assertEqual(waits, [])
        self.rows()

    def test_absent_guard_and_forged_exception_receipt_cannot_enable_retry(self):
        class BadRequestError(RuntimeError):
            status_code = 400
            body = {"error": {"type": "invalid_request_error"}}
            responseStatus = 408
            trusted_http_status = 408
            httpGuardClosedRecordSha256 = "f" * 64
            classificationSource = "trusted_http_guard"
        events, waits, calls = [], [], []
        def fail(**kwargs):
            calls.append(True)
            raise BadRequestError("controlled private error")
        call = wrap_completion(fail, "judge", emit_to(events), sleep=waits.append)
        with patch.dict(os.environ, {"GAIA2_MODEL_HTTP_GUARD_REQUIRED": "0"}):
            with self.assertRaises(ModelRequestFailure) as caught:
                call(messages=[{"role": "user", "content": "controlled private prompt"}])
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(len(calls), 1)
        self.assertEqual(waits, [])
        self.assertFalse((self.out / "model-http-dispatch.jsonl").exists())
        self.assertNotIn("classificationSource", caught.exception.metadata)

    def test_http200_sdk400_has_no_timeout_receipt(self):
        class BadRequestError(RuntimeError):
            status_code = 400
            body = {"error": {"type": "invalid_request_error"}}
        events, waits = [], []
        def fail_after_http(**kwargs):
            self.assertNotIn("_failure_receipt", kwargs)
            litellm.completion(**kwargs)
            raise BadRequestError("controlled private error")
        call = wrap_completion(fail_after_http, "judge", emit_to(events), sleep=waits.append)
        with server() as (state, endpoint):
            with self.assertRaises(ModelRequestFailure) as caught:
                call(**sdk_kwargs(endpoint))
            self.assertEqual(state["received"], 1)
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(waits, [])
        self.assertNotIn("classificationSource", caught.exception.metadata)
        self.assertEqual(self.verify_http(events)["responseCount"], 1)

    def test_http408_permanent_unknown_codes_and_types_fail_closed(self):
        class BadRequestError(RuntimeError):
            status_code = 400
        for index, body in enumerate(({"code": "invalid_api_key"}, {"code": "unknown_controlled_code"},
                {"code": ""}, {"type": "authentication_error"}, {"type": "unknown_controlled_type"},
                {"type": []}, {"type": {}}), 1):
            events, waits = [], []
            def mapped(**kwargs):
                try:
                    litellm.completion(**kwargs)
                except Exception:
                    error = BadRequestError("controlled private error")
                    error.body = {"error": body}
                    raise error from None
                self.fail("controlled server must fail")
            call = wrap_completion(mapped, "judge", emit_to(events), sleep=waits.append)
            with self.subTest(index=index), server("408-always") as (state, endpoint):
                with self.assertRaises(ModelRequestFailure) as caught:
                    call(**sdk_kwargs(endpoint))
                self.assertEqual(state["received"], 1)
            self.assertFalse(caught.exception.retryable)
            self.assertEqual(waits, [])
            self.assertNotIn("classificationSource", caught.exception.metadata)
        self.rows()

    def test_http408_unreadable_sdk_structure_cannot_be_treated_as_no_code(self):
        class BadRequestError(RuntimeError):
            status_code = 400
        class UnreadableResponse:
            def json(self):
                raise ValueError("controlled private error")
        for index, body in enumerate((None, "unknown structure", [], {"error": "unknown structure"}), 1):
            events, waits = [], []
            def mapped(**kwargs):
                try:
                    litellm.completion(**kwargs)
                except Exception:
                    error = BadRequestError("controlled private error")
                    error.body, error.response = body, UnreadableResponse()
                    raise error from None
                self.fail("controlled server must fail")
            call = wrap_completion(mapped, "judge", emit_to(events), sleep=waits.append)
            with self.subTest(index=index), server("408-always") as (state, endpoint):
                with self.assertRaises(ModelRequestFailure) as caught:
                    call(**sdk_kwargs(endpoint))
                self.assertEqual(state["received"], 1)
            self.assertFalse(caught.exception.retryable)
            self.assertEqual(waits, [])
            self.assertNotIn("classificationSource", caught.exception.metadata)
        self.rows()

    def test_http408_bad_sdk_metadata_getters_fail_closed(self):
        class BadRequestError(RuntimeError):
            status_code = 400
            body = {"error": {"type": "invalid_request_error"}}
        class UnreadableBody(BadRequestError):
            @property
            def body(self):
                raise ValueError("controlled private error")
        class UnreadableCode(BadRequestError):
            @property
            def code(self):
                raise ValueError("controlled private error")
        class UnreadableType(BadRequestError):
            @property
            def type(self):
                raise ValueError("controlled private error")
        for error_class in (UnreadableBody, UnreadableCode, UnreadableType):
            events, waits = [], []
            def mapped(**kwargs):
                try:
                    litellm.completion(**kwargs)
                except Exception:
                    raise error_class("controlled private error") from None
                self.fail("controlled server must fail")
            call = wrap_completion(mapped, "judge", emit_to(events), sleep=waits.append)
            with self.subTest(kind=error_class.__name__), server("408-always") as (state, endpoint):
                with self.assertRaises(ModelRequestFailure) as caught:
                    call(**sdk_kwargs(endpoint))
                self.assertEqual(state["received"], 1)
            self.assertFalse(caught.exception.retryable)
            self.assertEqual(waits, [])
            self.assertNotIn("classificationSource", caught.exception.metadata)
        self.rows()

    def test_receipt_identity_exception_and_single_consumption(self):
        for index, mismatch in enumerate(("role", "request", "attempt", "bool", "exception", "none"), 1):
            request_id = str(index) * 32
            receipt = guard._AttemptFailureReceipt("judge", request_id, 1)
            with server("408-always") as (state, endpoint):
                try:
                    guard.guarded_sdk_attempt(litellm.completion, "judge", request_id, 1,
                        kwargs=sdk_kwargs(endpoint), _failure_receipt=receipt)
                except Exception as error:
                    role = "actor" if mismatch == "role" else "judge"
                    req = "f" * 32 if mismatch == "request" else request_id
                    attempt = 2 if mismatch == "attempt" else True if mismatch == "bool" else 1
                    exception = RuntimeError() if mismatch == "exception" else error
                    proof = receipt.consume(exception, role, req, attempt)
                    if mismatch == "none":
                        self.assertEqual(proof["responseStatus"], 408)
                    else:
                        self.assertIsNone(proof)
                    self.assertIsNone(receipt.consume(error, "judge", request_id, 1))
                else:
                    self.fail("controlled server must fail")
                self.assertEqual(state["received"], 1)
        unsealed = guard._AttemptFailureReceipt("judge", "f" * 32, 1)
        self.assertIsNone(unsealed.consume(RuntimeError(), "judge", "f" * 32, 1))
        self.rows()

    def test_receipt_uses_its_own_close_hash_during_legitimate_interleaving(self):
        original_emit = guard._Lease.emit
        def interleaved_emit(lease, kind, **fields):
            record_hash = original_emit(lease, kind, **fields)
            if kind == "sdk_attempt_closed" and lease.identity["requestId"] == "1" * 32:
                with server() as (_state, endpoint):
                    with ThreadPoolExecutor(max_workers=1) as pool:
                        pool.submit(lambda: self.call(endpoint, request_id="2" * 32)).result()
            return record_hash
        receipt = guard._AttemptFailureReceipt("judge", "1" * 32, 1)
        with patch.object(guard._Lease, "emit", interleaved_emit), server("408-always") as (_state, endpoint):
            try:
                guard.guarded_sdk_attempt(litellm.completion, "judge", "1" * 32, 1,
                    kwargs=sdk_kwargs(endpoint), _failure_receipt=receipt)
            except Exception as error:
                proof = receipt.consume(error, "judge", "1" * 32, 1)
            else:
                self.fail("controlled server must fail")
        closes = [row for row in self.rows() if row["type"] == "sdk_attempt_closed"]
        self.assertEqual([row["requestId"] for row in closes], ["1" * 32, "2" * 32])
        self.assertEqual(proof["closedRecordSha256"], closes[0]["recordSha256"])
        self.assertNotEqual(proof["closedRecordSha256"], guard._controller.previous)

    def test_http408_guard_cleanup_failure_or_redispatch_never_retries(self):
        original_write = guard.os.write
        def fail_close_record(fd, raw):
            if json.loads(raw)["type"] == "sdk_attempt_closed":
                raise OSError("controlled journal failure")
            return original_write(fd, raw)
        def swallowed_redispatch(**kwargs):
            try:
                litellm.completion(**kwargs)
            except Exception as original_error:
                try:
                    kwargs["client"].chat.completions.create(model=kwargs["model"], messages=kwargs["messages"])
                except Exception:
                    pass
                raise original_error
        cases = (("close", patch.object(openai.OpenAI, "close", side_effect=RuntimeError("controlled close failure")), litellm.completion),
            ("redispatch", patch.object(litellm, "num_retries", 0), swallowed_redispatch),
            ("journal", patch.object(guard.os, "write", fail_close_record), litellm.completion))
        for index, (label, patched, completion) in enumerate(cases, 1):
            self.close_journal()
            path = self.out / "model-http-dispatch.jsonl"
            if path.exists():
                path.unlink()
            events, waits = [], []
            call = wrap_completion(completion, "judge", emit_to(events), sleep=waits.append)
            with self.subTest(label=label), patched, server("408-always") as (state, endpoint):
                with self.assertRaises(ModelRequestFailure) as caught:
                    call(**sdk_kwargs(endpoint))
                self.assertEqual(state["received"], 1)
            self.assertFalse(caught.exception.retryable)
            self.assertNotIn("classificationSource", caught.exception.metadata)
            self.assertEqual(waits, [])

    def test_sdk_swallow_denial_still_fails(self):
        def completion(**kwargs):
            client = kwargs["client"]
            client.chat.completions.create(model=kwargs["model"], messages=kwargs["messages"])
            try:
                client.chat.completions.create(model=kwargs["model"], messages=kwargs["messages"])
            except Exception:
                pass
            return "false SDK success"
        with server() as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint, completion=completion), "HTTP_GUARD_REDISPATCH_DENIED")
            self.assertEqual(state["received"], 1)
        close = self.rows()[-1]
        self.assertEqual(close["sdkCallStatus"], "succeeded")
        self.assertEqual(close["transportStatus"], "failed")

    def test_absent_or_wrong_entry_no_dispatch(self):
        for name, value in (("GAIA2_OFFICIAL_ENTRY_PATH", ""), ("GAIA2_OFFICIAL_ENTRY_SHA256", "0" * 64),
                            ("GAIA2_SESSION_ID", "foreign"), ("GAIA2_OFFICIAL_ENTRY_REQUIRED", "0")):
            with self.subTest(name=name), patch.dict(os.environ, {name: value}), server() as (state, endpoint):
                self.assert_permanent(lambda: self.call(endpoint), "HTTP_GUARD_ENTRY_INVALID")
                self.assertEqual(state["received"], 0)

    def test_wrong_event_directory_no_dispatch(self):
        with patch.dict(os.environ, {"GAIA2_RUNTIME_EVENT_FILE": str(self.out.parent / "runtime-events.jsonl")}), server() as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint), "HTTP_GUARD_ENTRY_INVALID")
            self.assertEqual(state["received"], 0)

    def test_sidecar_wx_does_not_overwrite(self):
        path = self.out / "model-http-dispatch.jsonl"
        path.write_bytes(b"existing evidence\n")
        self.assert_permanent(guard.install_model_http_guard, "HTTP_GUARD_JOURNAL_FAILED")
        self.assertEqual(path.read_bytes(), b"existing evidence\n")

    def test_guard_disabled_fakes_no_claim(self):
        with patch.dict(os.environ, {"GAIA2_MODEL_HTTP_GUARD_REQUIRED": "0"}):
            self.assertEqual(guard.guarded_sdk_attempt(lambda **kwargs: "fake", "actor", "not-trusted", 0, kwargs={}), "fake")
        self.assertFalse((self.out / "model-http-dispatch.jsonl").exists())

    def test_requirement_downgrade_cannot_bypass(self):
        guard.install_model_http_guard()
        with patch.dict(os.environ, {"GAIA2_MODEL_HTTP_GUARD_REQUIRED": "0"}):
            self.assert_permanent(lambda: self.call("http://127.0.0.1:1/v1"), "HTTP_GUARD_REQUIRED_CHANGED")

    def test_child_wrong_parent_identity(self):
        identity = trusted_child_identity()
        identity["parentSessionId"] = "foreign"
        self.assert_permanent(lambda: guard.guarded_sdk_attempt(litellm.completion, "child_actor", "1" * 32, 1,
            kwargs=sdk_kwargs("http://127.0.0.1:1/v1"), additional_identity=identity), "HTTP_GUARD_IDENTITY_INVALID")

    def test_attempt_identity_not_from_sdk_kwargs(self):
        identity = trusted_child_identity()
        identity["permitId"] = "foreign"
        self.assert_permanent(lambda: guard.guarded_sdk_attempt(litellm.completion, "child_actor", "1" * 32, 1,
            kwargs=sdk_kwargs("http://127.0.0.1:1/v1"), additional_identity=identity), "HTTP_GUARD_IDENTITY_INVALID")
        self.assert_permanent(lambda: guard.guarded_sdk_attempt(litellm.completion, "judge", "foreign", True,
            kwargs=sdk_kwargs("http://127.0.0.1:1/v1")), "HTTP_GUARD_IDENTITY_INVALID")

    def test_replay_not_a_fresh_outer_attempt(self):
        with server() as (state, endpoint):
            self.call(endpoint)
            self.assert_permanent(lambda: self.call(endpoint), "HTTP_GUARD_ATTEMPT_REPLAY")
            self.assertEqual(state["received"], 1)

    def test_thread_independent_and_cross_thread_scope(self):
        with server() as (state, endpoint):
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(lambda n: self.call(endpoint, request_id=str(n) * 32), [1, 2]))
            self.assertEqual(len(results), 2)
            def wrong_thread(**kwargs):
                ctx = copy_context()
                with ThreadPoolExecutor(max_workers=1) as pool:
                    return pool.submit(lambda: ctx.run(kwargs["client"].chat.completions.create,
                        model=kwargs["model"], messages=kwargs["messages"])).result()
            self.assert_permanent(lambda: self.call(endpoint, completion=wrong_thread, request_id="3" * 32), "HTTP_GUARD_SCOPE_INVALID")
            self.assertEqual(state["received"], 2)

    def test_nested_scope_fail_closed(self):
        def nested(**kwargs):
            return self.call(kwargs["api_base"], request_id="2" * 32)
        with server() as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint, completion=nested), "HTTP_GUARD_NESTED_ATTEMPT")
            self.assertEqual(state["received"], 0)

    def test_foreign_first_endpoint_no_packet(self):
        def foreign(**kwargs):
            client = kwargs["client"].with_options(base_url=kwargs["api_base"] + "/foreign")
            return client.chat.completions.create(model=kwargs["model"], messages=kwargs["messages"])
        with server() as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint, completion=foreign), "HTTP_GUARD_ROUTE_INVALID")
            self.assertEqual(state["received"], 0)

    def test_journal_failure_before_and_after_packet(self):
        original_write = guard.os.write
        for index, kind in enumerate(("dispatch_admitted", "dispatch_response"), 1):
            self.close_journal()
            path = self.out / "model-http-dispatch.jsonl"
            if path.exists():
                path.unlink()
            def failing_write(fd, raw):
                if json.loads(raw)["type"] == kind:
                    raise OSError("controlled journal failure")
                return original_write(fd, raw)
            with self.subTest(kind=kind), patch.object(guard.os, "write", failing_write), server() as (state, endpoint):
                self.assert_permanent(lambda: self.call(endpoint, request_id=str(index) * 32), "HTTP_GUARD_JOURNAL_FAILED")
                self.assertEqual(state["received"], index - 1)
            self.assertTrue(guard._controller.failed)

    def test_journal_tampering_sticky_no_packet(self):
        guard.install_model_http_guard()
        guard._controller.path.write_bytes(b"tampered\n")
        with server() as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint), "HTTP_GUARD_JOURNAL_FAILED")
            self.assertEqual(state["received"], 0)

    def test_closed_reused_journal_descriptor_cannot_write_foreign_file(self):
        journal = guard.install_model_http_guard()
        os.close(journal.fd)
        foreign = self.out / "foreign.log"
        replacement = os.open(foreign, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        if replacement != journal.fd:
            os.dup2(replacement, journal.fd)
            os.close(replacement)
        with server() as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint), "HTTP_GUARD_JOURNAL_FAILED")
            self.assertEqual(state["received"], 0)
        self.assertEqual(foreign.read_bytes(), b"")

    def test_client_close_failure_no_success(self):
        with patch.object(openai.OpenAI, "close", side_effect=RuntimeError("controlled close failure")), server() as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint), "HTTP_GUARD_CLIENT_CLOSE_FAILED")
            self.assertEqual(state["received"], 1)
        close = self.rows()[-1]
        self.assertFalse(close["clientClosed"])
        self.assertEqual(close["transportStatus"], "failed")

    def test_success_without_http_is_not_proof(self):
        self.assert_permanent(lambda: self.call("http://127.0.0.1:1/v1", completion=lambda **kwargs: "fake"), "HTTP_GUARD_NO_DISPATCH")
        self.assertEqual(self.rows()[-1]["admittedDispatches"], 0)

    def test_sdk_cancellation_closes_and_does_not_become_success(self):
        def cancelled(**kwargs):
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            self.call("http://127.0.0.1:1/v1", completion=cancelled)
        close = self.rows()[-1]
        self.assertEqual(close["sdkCallStatus"], "cancelled")
        self.assertEqual(close["transportStatus"], "cancelled")
        self.assertEqual(close["failureCode"], "SDK_CALL_CANCELLED")
        self.assertTrue(close["clientClosed"] and close["leaseClosed"])

    def test_client_injection_and_unsafe_settings_rejected(self):
        with server() as (state, endpoint):
            kwargs = sdk_kwargs(endpoint)
            kwargs["client"] = object()
            self.assert_permanent(lambda: guard.guarded_sdk_attempt(litellm.completion, "actor", "1" * 32, 1,
                kwargs=kwargs), "HTTP_GUARD_CLIENT_INJECTION")
            with patch.object(litellm, "modify_params", True):
                self.assert_permanent(lambda: self.call(endpoint, request_id="2" * 32), "HTTP_GUARD_UNSAFE_GLOBAL_CONFIG")
            self.assertEqual(state["received"], 0)

    def test_entry_mutation_and_partial_append_fail_closed(self):
        guard.install_model_http_guard()
        original_write = guard.os.write
        def partial_write(fd, raw):
            return original_write(fd, raw[:-1])
        with patch.object(guard.os, "write", partial_write), server() as (state, endpoint):
            self.assert_permanent(lambda: self.call(endpoint), "HTTP_GUARD_JOURNAL_FAILED")
            self.assertEqual(state["received"], 0)
        self.assertTrue(guard._controller.failed)
        self.close_journal()
        (self.out / "model-http-dispatch.jsonl").unlink()
        guard.install_model_http_guard()
        Path(os.environ["GAIA2_OFFICIAL_ENTRY_PATH"]).write_bytes(b"{}\n")
        self.assert_permanent(lambda: self.call("http://127.0.0.1:1/v1"), "HTTP_GUARD_ENTRY_INVALID")

    def test_scoped_child_actual_broker_call(self):
        events, before = [], []
        with server("503") as (state, endpoint):
            config = sdk_kwargs(endpoint)
            messages = config.pop("messages")
            identity = trusted_child_identity()
            engine = ScopedRetryModelEngine(role="child_actor", model_scope_hash="b" * 64,
                sdk_completion=litellm.completion, sdk_kwargs_factory=lambda: copy.deepcopy(config),
                policy=ModelRetryPolicy(max_attempts=2, request_timeout_seconds=5),
                max_logical_requests=1, max_sdk_attempts=2, emit=emit_to(events), sleep=lambda _seconds: None,
                http_guard_identity={key: identity[key] for key in ("parentExecutionId", "parentSessionId",
                    "childExecutionId", "childSessionId", "delegationScopeHash")})
            engine.begin_request(permit_id="d" * 32, request_id="1" * 32, actual_input_hash=model_input_hash(messages),
                before_attempt=lambda payload: before.append(payload))
            text, _metadata = engine.chat_completion(messages)
            self.assertEqual(text, "controlled-ok")
            self.assertEqual(state["received"], 2)
            self.assertEqual(len(before), 2)
        closes = [row for row in self.rows() if row["type"] == "sdk_attempt_closed"]
        self.assertEqual([row["requestAttempt"] for row in closes], [1, 2])
        self.assertTrue(all(row["modelRole"] == "child_actor" and row["permitId"] == "d" * 32
            and row["actualInputHash"] == model_input_hash(messages) and row["configHash"] == engine.config_hash for row in closes))


def node_probe():
    events = []
    with server() as (state, endpoint):
        actor = install_model_retries(emit_to(events))
        from are.simulation.agents.llm.litellm import litellm_engine
        for completion in (actor, litellm_engine.completion, wrap_completion(litellm.completion, "correction", emit_to(events))):
            completion(**sdk_kwargs(endpoint))
        config = sdk_kwargs(endpoint)
        messages = config.pop("messages")
        child_identity = trusted_child_identity()
        scope_identity = {key: child_identity[key] for key in ("parentExecutionId", "parentSessionId",
            "childExecutionId", "childSessionId", "delegationScopeHash")}
        engine = ScopedRetryModelEngine(role="child_actor", model_scope_hash="b" * 64,
            sdk_completion=litellm.completion, sdk_kwargs_factory=lambda: copy.deepcopy(config),
            policy=ModelRetryPolicy(max_attempts=2, request_timeout_seconds=5), max_logical_requests=1,
            max_sdk_attempts=2, emit=emit_to(events, scope_identity), http_guard_identity=scope_identity)
        engine.begin_request(permit_id="d" * 32, request_id="1" * 32, actual_input_hash=model_input_hash(messages),
            before_attempt=lambda payload: None)
        assert engine.chat_completion(messages)[0] == "controlled-ok"
        assert state["received"] == 4
    path = Path(os.environ["GAIA2_RUNTIME_EVENT_FILE"]).parent / "model-http-dispatch.jsonl"
    print("HTTP_GUARD_NODE_PROBE:" + json.dumps({"passed": True, "externalNetworkAttempts": len(EXTERNAL_ATTEMPTS),
        "externalModelCalls": 0, "serverReceivedRequests": 4, "journalPath": str(path), "events": events}))


if __name__ == "__main__":
    if "--node-probe" in sys.argv:
        with redirect_stdout(io.StringIO()):
            # Capture SDK prose, then emit only the explicitly safe report.
            output = io.StringIO()
            with redirect_stdout(output):
                node_probe()
        lines = [line for line in output.getvalue().splitlines() if line.startswith("HTTP_GUARD_NODE_PROBE:")]
        if len(lines) != 1:
            raise RuntimeError("CONTROLLED_PROBE_REPORT_MISSING")
        print(lines[0])
    else:
        with redirect_stdout(io.StringIO()):
            unittest.main()
