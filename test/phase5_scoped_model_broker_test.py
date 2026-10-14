"""Offline SDK fakes through the actual ARE LLMEngine type, no providers/tools."""

import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

import gaia2_a2a_wire as wire
from gaia2_model_retry import ModelRetryPolicy, wrap_completion
import gaia2_scoped_model_broker as broker_module
from gaia2_deadline_notifications import ScopedOSDeadline
from gaia2_scoped_model_broker import (ScopedRetryModelEngine, ScopedModelBrokerError,
    model_input_hash, normalize_model_messages, scoped_model_config_hash)
from are.simulation.agents.llm.llm_engine import LLMEngine
from are.simulation.agents.llm.types import MessageRole
from are.simulation.agents.decoding_types import DecodingSchema

SECRET = "SECRET_provider_key_do_not_log"
ENDPOINT = "https://private-endpoint.invalid/SECRET_provider"
MESSAGES = [{"role": MessageRole.SYSTEM, "content": "private prompt: " + SECRET},
    {"role": MessageRole.USER, "content": "private reference answer 🦫"}]


class HttpFailure(Exception):
    def __init__(self, status, headers=None, body=None):
        super().__init__(SECRET + " " + ENDPOINT + " raw exception")
        self.status_code = status
        self.headers = headers or {}
        self.body = body or {}


class FakeSdk:
    def __init__(self, outcomes, interleave=None):
        self.outcomes, self.calls = list(outcomes), []
        self.interleave = interleave

    def __call__(self, **kwargs):
        self.calls.append(copy.deepcopy(kwargs))
        if self.interleave is not None:
            callback, self.interleave = self.interleave, None
            callback()
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


class TrustedConfig:
    def __init__(self):
        self.value = {"model": "controlled-model", "custom_llm_provider": "openai",
            "api_key": SECRET, "api_base": ENDPOINT, "num_retries": 99, "max_retries": 99}

    def __call__(self):
        return copy.deepcopy(self.value)


class TrustedGuard:
    def __init__(self, max_attempts=100):
        self.calls, self.max_attempts = [], max_attempts
        self.revoked = False

    def __call__(self, payload):
        if self.revoked or len(self.calls) >= self.max_attempts:
            raise RuntimeError(SECRET + " late authorization revoked")
        assert set(payload) == {"permitId", "requestId", "attempt", "actualInputHash"}
        self.calls.append(copy.deepcopy(payload))
        return None  # A real runner returns only after verifying Node ACK9.


class Clock:
    def __init__(self):
        self.now, self.waits, self.after_sleep = 1728975600.0, [], None

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.waits.append(seconds)
        self.now += seconds
        if self.after_sleep:
            self.after_sleep()


class SafeEmitter:
    def __init__(self):
        self.events = []

    def __call__(self, kind, **fields):
        self.events.append({"type": kind, **fields})


def response(text="True Original response<end_action>", usage=True):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage={"prompt_tokens": 2, "completion_tokens": 3, "total_tokens": 5,
            "rawSecret": SECRET, "endpoint": ENDPOINT} if usage else None)


class Tests(unittest.TestCase):
    def setUp(self):
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.serial = 0

    def engine(self, outcomes, role="child_actor", logical=10, sdk_limit=20, policy=None, guard=None,
               deadline_timeout_policy="fixed"):
        sdk, cfg, clock, emitter = FakeSdk(outcomes), TrustedConfig(), Clock(), SafeEmitter()
        guard = guard or TrustedGuard()
        policy = policy or ModelRetryPolicy(max_attempts=3, backoff_base_seconds=2,
            backoff_max_seconds=120, max_retry_wait_seconds=3600, request_timeout_seconds=5)
        engine = ScopedRetryModelEngine(role=role, model_scope_hash=hashlib.sha256(role.encode()).hexdigest(),
            sdk_completion=sdk, sdk_kwargs_factory=cfg, policy=policy, max_logical_requests=logical,
            max_sdk_attempts=sdk_limit, emit=emitter, clock=clock.time, sleep=clock.sleep)
        if deadline_timeout_policy != "fixed":
            engine = ScopedRetryModelEngine(role=role, model_scope_hash=hashlib.sha256(role.encode()).hexdigest(),
                sdk_completion=sdk, sdk_kwargs_factory=cfg, policy=policy, max_logical_requests=logical,
                max_sdk_attempts=sdk_limit, emit=emitter, clock=clock.time, sleep=clock.sleep,
                deadline_timeout_policy=deadline_timeout_policy)
        return engine, sdk, cfg, clock, emitter, guard

    def begin(self, fixture, messages=MESSAGES, guard=None, deadline=None):
        engine, _, _, _, _, default_guard = fixture
        self.serial += 1
        permit, request = f"{self.serial:032x}", f"{self.serial + 1000:032x}"
        engine.begin_request(permit_id=permit, request_id=request,
            actual_input_hash=model_input_hash(messages), before_attempt=guard or default_guard,
            **({"deadline": deadline} if deadline is not None else {}))
        return permit, request

    def run_model(self, fixture, messages=MESSAGES, **kwargs):
        self.begin(fixture, messages)
        return fixture[0](messages, **kwargs)

    def safe(self, fixture):
        encoded = json.dumps({"events": fixture[4].events, "snapshot": fixture[0].snapshot()}, sort_keys=True)
        for hidden in (SECRET, ENDPOINT, "private prompt", "private reference answer", "raw exception", "controlled-model"):
            self.assertNotIn(hidden, encoded)

    def test_01_actual_llmengine_one_logical_two_sdk_zero_tools_original_string(self):
        f = self.engine([HttpFailure(429, {"Retry-After": "7"}), response()])
        self.assertIsInstance(f[0], LLMEngine)
        original, metadata = self.run_model(f, stop_sequences=["<end_action>"], additional_trace_tags=["judge_llm"])
        self.assertEqual(original, "True Original response<end_action>")
        self.assertEqual(metadata["outputHash"], hashlib.sha256(original.encode()).hexdigest())
        self.assertEqual(f[0].last_usage, {"inputTokens": 2, "outputTokens": 3, "totalTokens": 5})
        snapshot = f[0].snapshot()
        self.assertEqual((snapshot["logicalRequestsUsed"], snapshot["sdkAttemptsUsed"]), (1, 2))
        self.assertEqual(snapshot["lastSdkAttempts"], 2)
        self.assertEqual(f[3].waits, [7])
        self.assertEqual([p["attempt"] for p in f[5].calls], [1, 2])
        self.assertEqual(len(f[1].calls), 2)
        for call in f[1].calls:
            self.assertNotIn("tools", call)
            self.assertNotIn("additional_trace_tags", call)
            self.assertEqual((call["num_retries"], call["max_retries"]), (0, 0))
            self.assertEqual(call["fallbacks"], [])
            self.assertEqual(call["context_window_fallback_dict"], {})
            self.assertIsNone(call["retry_policy"])
            self.assertFalse(call["drop_params"])
            self.assertEqual(call["timeout"], 5)
        self.safe(f)

    def test_02_role_interleaving_is_instance_local_no_alias_retag(self):
        actor = self.engine([response("actor")], role="actor")
        child = self.engine([response("child")], role="child_actor")
        judge = self.engine([response("judge")], role="judge")
        correction = self.engine([response("correction")], role="correction")
        self.begin(actor)
        actor[1].interleave = lambda: self.run_model(judge)
        self.assertEqual(actor[0](MESSAGES)[0], "actor")
        self.run_model(child); self.run_model(correction)
        for fixture, role in ((actor, "actor"), (child, "child_actor"), (judge, "judge"), (correction, "correction")):
            self.assertTrue(all(event["modelRole"] == role for event in fixture[4].events))
            self.assertEqual(fixture[0].snapshot()["sdkAttemptsUsed"], 1)
            self.safe(fixture)

    def test_03_permanent_errors_never_retry_and_raw_exception_suppressed(self):
        for error in (HttpFailure(401), HttpFailure(400), HttpFailure(429, body={"error": {"code": "insufficient_quota"}}), ValueError(SECRET)):
            f = self.engine([error])
            self.begin(f)
            with self.assertRaises(ScopedModelBrokerError) as caught:
                f[0](MESSAGES)
            self.assertEqual(caught.exception.code, "SCOPED_MODEL_CONFIGURATION_ERROR")
            self.assertFalse(caught.exception.retryable)
            self.assertTrue(caught.exception.__suppress_context__)
            self.assertIsNone(caught.exception.__cause__)
            self.assertNotIn(SECRET, str(caught.exception))
            self.assertEqual(len(f[1].calls), 1)
            self.assertEqual(f[3].waits, [])
            self.safe(f)

    def test_04_wrapped_judge_cannot_be_rebranded_or_nested(self):
        f = self.engine([response()], role="judge")
        old_wrapper = wrap_completion(f[1], "judge", f[4])
        for role in ("actor", "child_actor", "judge", "correction"):
            with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_WRAPPED_SDK_FORBIDDEN"):
                ScopedRetryModelEngine(role=role, model_scope_hash="f" * 64, sdk_completion=old_wrapper,
                    sdk_kwargs_factory=f[2], policy=ModelRetryPolicy(), max_logical_requests=1, max_sdk_attempts=1)
        self.assertIs(wrap_completion(old_wrapper, "actor", f[4]), old_wrapper)  # Legacy behavior unchanged.
        self.assertEqual(f[1].calls, [])

    def test_05_source_callable_and_configuration_drift_never_dispatch(self):
        f = self.engine([response()]); self.begin(f)
        f[2].value["api_key"] = "changed private key"
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_CONFIG_CHANGED"):
            f[0](MESSAGES)
        self.assertEqual(f[1].calls, [])
        f = self.engine([response()]); self.begin(f)
        with patch.object(FakeSdk, "__call__", new=TrustedConfig.__call__):
            with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_SOURCE_CHANGED"):
                f[0](MESSAGES)
        self.assertEqual(f[1].calls, [])
        f = self.engine([response()])
        f[0]._ScopedRetryModelEngine__role = "judge"
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_SOURCE_CHANGED"):
            self.begin(f)

    def test_06_independent_logical_and_sdk_budgets_and_late_revocation(self):
        f = self.engine([HttpFailure(503), response()], sdk_limit=1)
        self.begin(f)
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_SDK_BUDGET_EXHAUSTED"):
            f[0](MESSAGES)
        self.assertEqual(len(f[1].calls), 1)
        self.assertEqual(len(f[5].calls), 1)
        f = self.engine([HttpFailure(503), response()])
        f[3].after_sleep = lambda: setattr(f[5], "revoked", True)
        self.begin(f)
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_ATTEMPT_DENIED"):
            f[0](MESSAGES)
        self.assertEqual((f[0].snapshot()["logicalRequestsUsed"], f[0].snapshot()["sdkAttemptsUsed"]), (1, 1))
        self.assertEqual(len(f[1].calls), 1)
        self.safe(f)
        f = self.engine([response()], logical=1)
        self.run_model(f)
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_LOGICAL_BUDGET_EXHAUSTED"):
            self.begin(f)
        self.assertEqual(len(f[1].calls), 1)

    def test_07_guard_freeze_permit_replay_and_hash_binding(self):
        f = self.engine([response(), response()])
        provenance = f[0].snapshot()["sourceIdentityHash"]
        permit, request = self.begin(f)
        self.assertEqual(f[0](MESSAGES)[0], "True Original response<end_action>")
        self.assertEqual(f[0].snapshot()["sourceIdentityHash"], provenance)
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_PERMIT_REUSED"):
            f[0].begin_request(permit_id=permit, request_id=request, actual_input_hash=model_input_hash(MESSAGES), before_attempt=f[5])
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_GUARD_CHANGED"):
            self.begin(f, guard=TrustedGuard())
        self.begin(f)
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_INPUT_HASH_CHANGED"):
            f[0]([{"role": "user", "content": "tampered"}])
        self.assertEqual(len(f[1].calls), 1)
        self.assertIsNone(f[0].get_last_usage())
        self.assertFalse(f[0].snapshot()["requestActive"])

    def test_08_message_role_conversion_no_attachment_erasure_actor_kwargs(self):
        messages = [{"role": MessageRole.TOOL_RESPONSE, "content": "original typed observation", "attachments": []},
            {"role": MessageRole.TOOL_CALL, "content": "original tool call"}]
        f = self.engine([response()]); self.run_model(f, messages=messages)
        self.assertEqual([message["role"] for message in f[1].calls[0]["messages"]], ["user", "assistant"])
        self.assertEqual(normalize_model_messages(messages)[0]["role"], "tool-response")
        # Match the real BaseAgent call, through inherited LLMEngine.__call__;
        # do not remove its fixed kwargs in an integration fixture.
        f = self.engine([response()])
        original, metadata = self.run_model(f, stop_sequences=["<end_action>", "Observation:"],
            additional_trace_tags=["action"], schema=None)
        self.assertEqual(original, "True Original response<end_action>")
        self.assertEqual(metadata["usage"], {"inputTokens": 2, "outputTokens": 3, "totalTokens": 5})
        self.assertEqual(len(f[1].calls), 1)
        self.assertNotIn("schema", f[1].calls[0])
        self.assertNotIn("additional_trace_tags", f[1].calls[0])
        self.safe(f)
        for attachment in ([object()], {"mime": "image/png"}, (), "image"):
            with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_ATTACHMENT_UNSUPPORTED"):
                model_input_hash([{"role": "user", "content": "text", "attachments": attachment}])
        for kwargs in ({"role": "judge"}, {"modelRole": "judge"}, {"api_base": ENDPOINT}, {"num_retries": 9},
                {"tools": []}, {"unknown_option": None}, {"schema": {}}, {"schema": object()},
                {"schema": DecodingSchema(type="regex", decoding_schema="private schema " + SECRET)}):
            f = self.engine([response()]); self.begin(f)
            with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_ACTOR_KWARGS_FORBIDDEN"):
                f[0](MESSAGES, **kwargs)
            self.assertEqual(f[1].calls, [])
            self.safe(f)

    def test_09_unknown_usage_is_not_inferred_and_result_metadata_is_detached(self):
        f = self.engine([response(usage=False)])
        _, metadata = self.run_model(f)
        self.assertIsNone(metadata["usage"])
        self.assertIsNone(f[0].last_usage)
        self.assertFalse(next(event for event in f[4].events if event["type"] == "model_request_succeeded")["usageAvailable"])
        f = self.engine([response()]); _, metadata = self.run_model(f)
        metadata["usage"]["inputTokens"] = 999
        usage = f[0].last_usage; usage["inputTokens"] = 888
        snapshot = f[0].snapshot(); snapshot["lastUsage"]["inputTokens"] = 777
        self.assertEqual(f[0].last_usage["inputTokens"], 2)
        self.safe(f)

    def test_10_config_hash_matches_wire_object_and_explicit_sdk_kwargs_no_fallback(self):
        cfg = {"model": "controlled-scoped-model", "custom_llm_provider": "openai"}
        policy = ModelRetryPolicy(max_attempts=2, backoff_base_seconds=0, backoff_max_seconds=0,
            max_retry_wait_seconds=0, request_timeout_seconds=5)
        expected = {"factoryKwargs": cfg, "effectiveKwargs": {**cfg, "num_retries": 0, "max_retries": 0,
            "retry_policy": None, "context_window_fallback_dict": {}, "fallbacks": [], "drop_params": False, "timeout": 5},
            "retryPolicy": {"max_attempts": 2, "backoff_base_seconds": 0, "backoff_max_seconds": 0,
                "max_retry_wait_seconds": 0, "request_timeout_seconds": 5}}
        self.assertEqual(scoped_model_config_hash(cfg, policy), wire.value_hash(expected))
        for extra in ("messages", "tools", "tool_choice", "stream", "stop", "mock_response"):
            with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_SDK_CONFIG_INVALID"):
                scoped_model_config_hash({**cfg, extra: None}, policy)

    def test_11_long_cooldown_chunks_and_structured_hints_match_legacy_semantics(self):
        f = self.engine([HttpFailure(429, {"Retry-After": "1"}, {"error": {"cooldown": {"remaining_seconds": 65}}}), response()])
        self.run_model(f)
        self.assertEqual(f[3].waits, [30, 30, 5])
        scheduled = next(event for event in f[4].events if event["type"] == "model_retry_scheduled")
        self.assertEqual((scheduled["waitSeconds"], scheduled["delaySource"]), (65, "structured_cooldown"))
        self.assertEqual(len([event for event in f[4].events if event["type"] == "model_retry_waiting"]), 2)
        self.safe(f)

    def test_12_deadline_admission_caps_provider_timeout_without_config_hash_drift(self):
        f = self.engine([response()], deadline_timeout_policy="remaining")
        deadline_clock = Clock()
        deadline = ScopedOSDeadline(scope_id="00000000000000000000000000000001", duration_seconds=2,
            monotonic_clock=deadline_clock.time)
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_DEADLINE_SCOPE_MISMATCH"):
            self.begin(f, deadline=deadline)
        deadline_clock = Clock()
        permit, request = f[0], None
        self.serial += 1
        request = f"{self.serial + 1000:032x}"
        permit = f"{self.serial:032x}"
        deadline = ScopedOSDeadline(scope_id=request, duration_seconds=2, monotonic_clock=deadline_clock.time)
        before_hash = f[0].config_hash
        f[0].begin_request(permit_id=permit, request_id=request, actual_input_hash=model_input_hash(MESSAGES),
            before_attempt=f[5], deadline=deadline)
        f[0](MESSAGES)
        self.assertEqual(f[0].config_hash, before_hash)
        self.assertEqual(f[1].calls[0]["timeout"], 2.0)

    def test_13_deadline_expiry_after_sdk_attempt_fails_closed(self):
        f = self.engine([response()], deadline_timeout_policy="remaining")
        class StepClock:
            def __init__(self): self.now = 100.0
            def __call__(self):
                self.now += 1.0
                return self.now
        deadline_clock = StepClock()
        self.serial += 1
        request = f"{self.serial + 1000:032x}"
        permit = f"{self.serial:032x}"
        deadline = ScopedOSDeadline(scope_id=request, duration_seconds=2, monotonic_clock=deadline_clock)
        f[0].begin_request(permit_id=permit, request_id=request, actual_input_hash=model_input_hash(MESSAGES),
            before_attempt=f[5], deadline=deadline)
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_DEADLINE_EXPIRED"):
            f[0](MESSAGES)

    def test_14_deadline_expiry_during_cooldown_does_not_retry(self):
        f = self.engine([HttpFailure(503), response()], deadline_timeout_policy="remaining")
        deadline_clock = Clock()
        self.serial += 1
        request = f"{self.serial + 1000:032x}"
        permit = f"{self.serial:032x}"
        deadline = ScopedOSDeadline(scope_id=request, duration_seconds=1, monotonic_clock=deadline_clock.time)
        f[3].after_sleep = lambda: setattr(deadline_clock, "now", deadline_clock.now + 1.5)
        f[0].begin_request(permit_id=permit, request_id=request, actual_input_hash=model_input_hash(MESSAGES),
            before_attempt=f[5], deadline=deadline)
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_DEADLINE_EXPIRED"):
            f[0](MESSAGES)
        self.assertEqual(len(f[1].calls), 1)

    def test_15_remaining_policy_requires_deadline_and_reused_deadline_is_rejected(self):
        f = self.engine([response()], deadline_timeout_policy="remaining")
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_DEADLINE_REQUIRED"):
            self.begin(f)
        deadline_clock = Clock()
        self.serial += 1
        request = f"{self.serial + 1000:032x}"
        permit = f"{self.serial:032x}"
        deadline = ScopedOSDeadline(scope_id=request, duration_seconds=5, monotonic_clock=deadline_clock.time)
        f[0].begin_request(permit_id=permit, request_id=request, actual_input_hash=model_input_hash(MESSAGES),
            before_attempt=f[5], deadline=deadline)
        f[0](MESSAGES)
        self.serial += 1
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_DEADLINE_SCOPE_MISMATCH"):
            f[0].begin_request(permit_id=f"{self.serial:032x}", request_id=f"{self.serial + 1000:032x}",
                actual_input_hash=model_input_hash(MESSAGES), before_attempt=f[5], deadline=deadline)

    def test_16_trusted_receipt_classifier_and_diagnostic_alias_changes_deny_before_ack(self):
        def replaced(*args, **kwargs):
            raise AssertionError("untrusted helper must never execute")
        targets = [(broker_module, "_classify_attempt_failure"), (broker_module, "safe_model_diagnostics"),
            (broker_module, "safe_request_summary"), (broker_module, "_AttemptFailureReceipt"),
            (broker_module._AttemptFailureReceipt, "__init__"),
            (broker_module._AttemptFailureReceipt, "consume"), (broker_module._AttemptFailureReceipt, "_seal")]
        for target, attribute in targets:
            f = self.engine([response()])
            self.begin(f)
            with self.subTest(attribute=attribute), patch.object(target, attribute, replaced):
                with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_SOURCE_CHANGED"):
                    f[0](MESSAGES)
            self.assertEqual(f[1].calls, [])
            self.assertEqual(f[5].calls, [])
            self.assertEqual(f[0].snapshot()["sdkAttemptsUsed"], 0)

    def test_17_unguarded_child_fake408_attributes_do_not_override_sdk400(self):
        class BadRequestError(RuntimeError):
            status_code = 400
            body = {"error": {"type": "invalid_request_error"}}
            trusted_http_status = 408
            responseStatus = 408
            classificationSource = "trusted_http_guard"
            httpGuardClosedRecordSha256 = "a" * 64
        f = self.engine([BadRequestError(SECRET)])
        self.begin(f)
        with self.assertRaisesRegex(ScopedModelBrokerError, "SCOPED_MODEL_CONFIGURATION_ERROR") as caught:
            f[0](MESSAGES)
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(len(f[1].calls), 1)
        self.assertEqual(f[3].waits, [])
        self.assertNotIn("classificationSource", caught.exception.metadata)
        self.safe(f)


if __name__ == "__main__":
    unittest.main()
