"""Offline tests for the c2.2a generation-time evidence chain."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

import sys
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

from gaia2_generation_time_ledger import GenerationLedgerError, ScopedGenerationTimeLedger
from gaia2_model_retry import ModelRetryPolicy
from gaia2_scoped_model_broker import ScopedRetryModelEngine
import gaia2_a2a_wire as wire


class Tests(unittest.TestCase):
    def setUp(self):
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-generation-ledger-")
        self.addCleanup(self.temp.cleanup)

    @staticmethod
    def args():
        return {"source_manifest_hash": hashlib.sha256(b"source").hexdigest(),
            "scope_hash": hashlib.sha256(b"scope").hexdigest(),
            "model_scope_hash": hashlib.sha256(b"model").hexdigest(),
            "permit_id": hashlib.sha256(b"permit").hexdigest()[:32],
            "request_id": hashlib.sha256(b"request").hexdigest()[:32],
            "actual_input_hash": hashlib.sha256(b"input").hexdigest()}

    def ledger(self):
        return ScopedGenerationTimeLedger(evidence_root=Path(self.temp.name) / "evidence", **self.args())

    def test_01_append_only_chain_and_safe_common_identity(self):
        ledger = self.ledger()
        refs = [ledger.admission(), ledger.pause_acquired(lease_id="a" * 32),
            ledger.model_returned(output_hash="b" * 64,
                timing={"logicalElapsedSeconds": 4.0, "sdkAttemptElapsedSeconds": 2.0,
                    "successfulSdkElapsedSeconds": 1.0, "cooldownSeconds": 1.0},
                usage={"inputTokens": 2, "outputTokens": 3, "totalTokens": 5}),
            ledger.pause_released(lease_id="a" * 32, offset=2),
            ledger.model_finished(output_hash="b" * 64, usage={"totalTokens": 5})]
        snapshot = ledger.snapshot()
        self.assertEqual((snapshot["sequence"], snapshot["phase"]), (5, "finished"))
        self.assertEqual(snapshot["previousHash"], refs[-1]["sha256"])
        self.assertEqual(len(snapshot["evidenceRefs"]), 5)
        prior = None
        for index, ref in enumerate(refs, 1):
            raw = (Path(self.temp.name) / "evidence" / ref["path"]).read_bytes()
            value = json.loads(raw)
            self.assertEqual(value["sequence"], index)
            self.assertEqual(value["previousHash"], prior)
            self.assertEqual(hashlib.sha256(raw).hexdigest(), ref["sha256"])
            prior = ref["sha256"]

    def test_02_failure_after_release_is_terminal_and_no_finish(self):
        ledger = self.ledger()
        ledger.admission(); ledger.pause_acquired(lease_id="c" * 32)
        ledger.pause_released(lease_id="c" * 32, offset=0)
        ledger.failed(code="SCOPED_MODEL_RATE_LIMIT")
        self.assertEqual(ledger.snapshot()["phase"], "failed")
        with self.assertRaisesRegex(GenerationLedgerError, "GENERATION_LEDGER_ORDER_INVALID"):
            ledger.model_finished(output_hash="d" * 64, usage=None)

    def test_03_unknown_timing_and_usage_are_null_not_zero(self):
        ledger = self.ledger(); ledger.admission(); ledger.pause_acquired(lease_id="e" * 32)
        ledger.model_returned(output_hash="f" * 64,
            timing={"logicalElapsedSeconds": None, "sdkAttemptElapsedSeconds": None,
                "successfulSdkElapsedSeconds": None, "cooldownSeconds": None}, usage=None)
        body = json.loads((Path(self.temp.name) / "evidence" / "json/000003-generation-time.json").read_bytes())
        self.assertIsNone(body["timing"]["logicalElapsedSeconds"])
        self.assertIsNone(body["usage"])

    def test_04_strict_order_timing_usage_and_identity_reject(self):
        ledger = self.ledger()
        with self.assertRaisesRegex(GenerationLedgerError, "GENERATION_LEDGER_ORDER_INVALID"):
            ledger.pause_acquired(lease_id="a" * 32)
        ledger.admission(); ledger.pause_acquired(lease_id="a" * 32)
        with self.assertRaisesRegex(GenerationLedgerError, "GENERATION_LEDGER_TIMING_INVALID"):
            ledger.model_returned(output_hash="b" * 64, timing={"logicalElapsedSeconds": 1}, usage=None)
        with self.assertRaisesRegex(GenerationLedgerError, "GENERATION_LEDGER_USAGE_INVALID"):
            ledger.model_returned(output_hash="b" * 64,
                timing={"logicalElapsedSeconds": 1, "sdkAttemptElapsedSeconds": 1,
                    "successfulSdkElapsedSeconds": 1, "cooldownSeconds": 0}, usage={"raw": 1})

    def test_05_raw_secret_and_extra_payload_never_enter_evidence(self):
        ledger = self.ledger(); ledger.admission(); ledger.pause_acquired(lease_id="1" * 32)
        ledger.model_returned(output_hash="2" * 64,
            timing={"logicalElapsedSeconds": 0, "sdkAttemptElapsedSeconds": 0,
                "successfulSdkElapsedSeconds": 0, "cooldownSeconds": 0}, usage=None)
        raw = (Path(self.temp.name) / "evidence" / "json/000003-generation-time.json").read_text(encoding="utf-8")
        self.assertNotIn("endpoint", raw); self.assertNotIn("rawSecret", raw); self.assertNotIn("prompt", raw)

    def test_06_broker_reports_independent_monotonic_timing_fields(self):
        class Monotonic:
            def __init__(self):
                self.value = 0.0
            def __call__(self):
                self.value += 0.25
                return self.value

        class SDK:
            def __call__(self, **_kwargs):
                return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="answer"))],
                    usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})

        monotonic = Monotonic()
        sdk = SDK()
        config = lambda: {"model": "controlled-scoped-model", "custom_llm_provider": "openai"}
        guard = lambda _payload: {"ok": True}
        engine = ScopedRetryModelEngine(role="child_actor", model_scope_hash="a" * 64,
            sdk_completion=sdk, sdk_kwargs_factory=config, policy=ModelRetryPolicy(max_attempts=1),
            max_logical_requests=1, max_sdk_attempts=1, before_attempt=guard,
            clock=lambda: 1.0, sleep=lambda _seconds: None, monotonic_clock=monotonic)
        messages = [{"role": "user", "content": "hello", "attachments": None}]
        request_id = "3" * 32
        engine.begin_request(permit_id="4" * 32, request_id=request_id,
            actual_input_hash=wire.value_hash(messages))
        engine.chat_completion(messages)
        timing = engine.get_last_timing()
        self.assertEqual(set(timing), {"schemaVersion", "logicalElapsedSeconds", "sdkAttemptElapsedSeconds",
            "successfulSdkElapsedSeconds", "cooldownSeconds"})
        self.assertGreater(timing["logicalElapsedSeconds"], 0)
        self.assertGreater(timing["sdkAttemptElapsedSeconds"], 0)
        self.assertGreater(timing["successfulSdkElapsedSeconds"], 0)
        self.assertEqual(timing["cooldownSeconds"], 0.0)

    def test_07_broker_failed_request_marks_success_timing_unknown_and_resets(self):
        class Monotonic:
            def __init__(self):
                self.value = 0.0
            def __call__(self):
                self.value += 0.5
                return self.value

        class FailingSDK:
            def __call__(self, **_kwargs):
                raise ValueError("private raw exception")

        monotonic = Monotonic()
        engine = ScopedRetryModelEngine(role="child_actor", model_scope_hash="5" * 64,
            sdk_completion=FailingSDK(), sdk_kwargs_factory=lambda: {"model": "controlled-scoped-model"},
            policy=ModelRetryPolicy(max_attempts=1), max_logical_requests=1, max_sdk_attempts=1,
            before_attempt=lambda _payload: {"ok": True}, clock=lambda: 1.0,
            sleep=lambda _seconds: None, monotonic_clock=monotonic)
        messages = [{"role": "user", "content": "hello", "attachments": None}]
        engine.begin_request(permit_id="6" * 32, request_id="7" * 32,
            actual_input_hash=wire.value_hash(messages))
        with self.assertRaises(Exception):
            engine.chat_completion(messages)
        timing = engine.get_last_timing()
        self.assertIsNone(timing["successfulSdkElapsedSeconds"])
        self.assertIsNotNone(timing["logicalElapsedSeconds"])

    def test_08_success_timing_failure_precedes_success_events(self):
        class RollingBackMonotonic:
            def __init__(self):
                self.calls = 0
            def __call__(self):
                self.calls += 1
                return 10.0 if self.calls < 4 else 9.0

        class SDK:
            def __call__(self, **_kwargs):
                return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="answer"))])

        events = []
        engine = ScopedRetryModelEngine(role="child_actor", model_scope_hash="8" * 64,
            sdk_completion=SDK(), sdk_kwargs_factory=lambda: {"model": "controlled-scoped-model"},
            policy=ModelRetryPolicy(max_attempts=1), max_logical_requests=1, max_sdk_attempts=1,
            before_attempt=lambda _payload: {"ok": True}, emit=lambda kind, **event: events.append((kind, event)),
            clock=lambda: 1.0, sleep=lambda _seconds: None, monotonic_clock=RollingBackMonotonic())
        messages = [{"role": "user", "content": "hello", "attachments": None}]
        engine.begin_request(permit_id="9" * 32, request_id="a" * 32,
            actual_input_hash=wire.value_hash(messages))
        with self.assertRaises(Exception):
            engine.chat_completion(messages)
        self.assertNotIn("model_request_succeeded", [kind for kind, _event in events])
        self.assertFalse(any(event.get("status") == "succeeded" for _kind, event in events))
        self.assertIn("model_request_rejected", [kind for kind, _event in events])
        self.assertIsNone(engine.get_last_timing()["logicalElapsedSeconds"])

    def test_09_second_success_event_failure_is_terminal_without_result(self):
        class SDK:
            def __call__(self, **_kwargs):
                return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="answer"))])

        events = []
        def emit(kind, **event):
            events.append(kind)
            if kind == "model_logical_request_finished" and event.get("status") == "succeeded":
                raise RuntimeError("ledger sink failure")

        engine = ScopedRetryModelEngine(role="child_actor", model_scope_hash="b" * 64,
            sdk_completion=SDK(), sdk_kwargs_factory=lambda: {"model": "controlled-scoped-model"},
            policy=ModelRetryPolicy(max_attempts=1), max_logical_requests=1, max_sdk_attempts=1,
            before_attempt=lambda _payload: {"ok": True}, emit=emit,
            clock=lambda: 1.0, sleep=lambda _seconds: None, monotonic_clock=lambda: 1.0)
        messages = [{"role": "user", "content": "hello", "attachments": None}]
        engine.begin_request(permit_id="c" * 32, request_id="d" * 32,
            actual_input_hash=wire.value_hash(messages))
        with self.assertRaisesRegex(Exception, "SCOPED_MODEL_LEDGER_FAILED"):
            engine.chat_completion(messages)
        self.assertIn("model_request_succeeded", events)
        self.assertNotIn("model_request_rejected", events)
        with self.assertRaisesRegex(Exception, "SCOPED_MODEL_LEDGER_FAILED"):
            engine.begin_request(permit_id="e" * 32, request_id="f" * 32,
                actual_input_hash=wire.value_hash(messages))

    def test_10_nonfinite_timing_delta_is_rejected_and_not_recorded(self):
        class HugeMonotonic:
            def __init__(self):
                self.values = iter((-1e308, -1e308, 1e308))
            def __call__(self):
                return next(self.values)

        class SDK:
            def __call__(self, **_kwargs):
                return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="answer"))])

        events = []
        engine = ScopedRetryModelEngine(role="child_actor", model_scope_hash="c" * 64,
            sdk_completion=SDK(), sdk_kwargs_factory=lambda: {"model": "controlled-scoped-model"},
            policy=ModelRetryPolicy(max_attempts=1), max_logical_requests=1, max_sdk_attempts=1,
            before_attempt=lambda _payload: {"ok": True}, emit=lambda kind, **event: events.append((kind, event)),
            clock=lambda: 1.0, sleep=lambda _seconds: None, monotonic_clock=HugeMonotonic())
        messages = [{"role": "user", "content": "hello", "attachments": None}]
        engine.begin_request(permit_id="1" * 32, request_id="2" * 32,
            actual_input_hash=wire.value_hash(messages))
        with self.assertRaisesRegex(Exception, "SCOPED_MODEL_TIMING_INVALID"):
            engine.chat_completion(messages)
        self.assertIsNone(engine.get_last_timing()["logicalElapsedSeconds"])
        self.assertNotIn("model_request_succeeded", [kind for kind, _event in events])


if __name__ == "__main__":
    unittest.main(verbosity=2)
