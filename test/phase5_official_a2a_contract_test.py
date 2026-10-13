"""Focused contracts for the official A2A adapter seam.

These tests do not start ARE or a provider.  They cover the adapter boundary
that can otherwise silently accept a foreign child scope, a false model ACK, or
an A2A child without the required notification/deadline capabilities.
"""

from pathlib import Path
import hashlib
import json
import math
import os
import socket
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

from gaia2_a2a_wire import value_hash
from gaia2_official_a2a import (
    OfficialA2AClient,
    OfficialA2AError,
    _guard_receipt,
    _validate_scope,
    connect_official_a2a,
)
from gaia2_scoped_model_broker import ScopedRetryModelEngine, ScopedModelBrokerError


def scope(task="delegate task"):
    return {
        "parentExecutionId": "exec-1",
        "parentSessionId": "session-1",
        "environmentGeneration": "official-exec-1",
        "appId": "Contacts",
        "parentCanonicalName": "AppAgent__expert_agent",
        "taskArgumentKey": "task",
        "toolInventoryHash": "a" * 64,
        "taskHash": hashlib.sha256(task.encode()).hexdigest(),
        "parentActionId": "parent-action-1",
        "requestId": "request-1",
        "childExecutionId": "child-execution-1",
        "childSessionId": "child-session-1",
        "task": task,
        "deadline": 1100.0,
        "maxNativeActions": 100,
    }


class FakePeer:
    def __init__(self, replies):
        self.replies = list(replies)
        self.calls = []

    def call(self, method, payload):
        self.calls.append((method, payload))
        reply = self.replies.pop(0)
        if isinstance(reply, BaseException):
            raise reply
        return reply


class ScopedPeer:
    """Offline owner ACKs, including a fresh scope for every delegation."""

    def __init__(self):
        self.calls = []
        self.children = 0

    def call(self, method, payload):
        self.calls.append((method, payload))
        if method == "a2a_begin_child":
            self.children += 1
            child_scope = scope(payload["task"])
            child_scope["childExecutionId"] = "child-execution-" + str(self.children)
            child_scope["childSessionId"] = "child-session-" + str(self.children)
            return {"handleToken": f"00000000-0000-0000-0000-{self.children:012x}",
                    "scope": child_scope}
        if method == "a2a_before_model":
            context = "trusted dynamic context"
            return {"context": context,
                    "contextHash": hashlib.sha256(context.encode()).hexdigest(),
                    "variablesHash": "f" * 64, "revision": 1,
                    "evidence": {"path": "owned.json", "sha256": "0" * 64}}
        if method == "a2a_cancel_child":
            return None
        return {"ok": True}


SECRET = "PRIVATE_API_KEY_PROMPT_AND_EXCEPTION"
ENDPOINT = "https://private-model.invalid/secret"


class HttpFailure(Exception):
    def __init__(self, status):
        self.status_code = status
        super().__init__(SECRET + " " + ENDPOINT)


class FakeSdk:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = []

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        result = self.outcomes.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


class FakeClock:
    def __init__(self):
        self.now = 1000.0
        self.waits = []

    def time(self):
        return self.now

    def sleep(self, seconds):
        self.waits.append(seconds)
        self.now += seconds


class SafeEmitter:
    def __init__(self):
        self.events = []

    def __call__(self, kind, **fields):
        self.events.append({"type": kind, **fields})


class CapturedRunner:
    """Expose the real retry engine constructed by OfficialA2AClient."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.engine = kwargs["llm_engine"]
        self.attempts = []

    def snapshot(self):
        return {"notificationReaderAttached": False, "deadlineOptIn": False}

    def authorize(self, payload):
        ack = self.kwargs["model_attempt"](payload)
        if (ack["logicalRequestsUsed"] != 1
                or ack["sdkAttemptsUsed"] != len(self.attempts) + 1):
            raise AssertionError("child_local_ack_mismatch")
        self.attempts.append(ack)


class OfficialA2AContractTests(unittest.TestCase):
    def setUp(self):
        self.offline = patch.object(socket.socket, "connect",
                                    side_effect=AssertionError("network_forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)

    def test_official_bridge_injects_trusted_dynamic_factories(self):
        source = (ROOT / "scripts" / "capybara_official_bridge.py").read_text(encoding="utf-8")
        # This is an adapter-wiring invariant: the official private-pipe
        # constructor must receive parent-owned capabilities, not fall back to
        # the client defaults that deliberately fail closed.
        self.assertIn("notification_reader_factory=_a2a_notification_reader_factory", source)
        self.assertIn("deadline_factory=_a2a_deadline_factory", source)
        self.assertIn("model_event_emitter=_emit_runtime_event", source)
        self.assertIn("notification_binding = BridgeNotificationBinding.from_lifecycle(lifecycle)", source)
        self.assertIn("_close_a2a_lifecycle", source)

    def client(self, peer):
        value = object.__new__(OfficialA2AClient)
        value._OfficialA2AClient__scope = scope()
        value._OfficialA2AClient__handle_token = "handle"
        value._OfficialA2AClient__peer = peer
        value._OfficialA2AClient__model_requests = 1
        value._OfficialA2AClient__sdk_attempts = 0
        value._OfficialA2AClient__child_model_requests_base = 0
        value._OfficialA2AClient__child_sdk_attempts_base = 0
        value._OfficialA2AClient__failure_code = None
        value._OfficialA2AClient__failure_callback = None
        value._OfficialA2AClient__child_scope_hashes = []
        return value

    def lifetime_client(self, emitter=None):
        value = self.client(ScopedPeer())
        value._OfficialA2AClient__scope = None
        value._OfficialA2AClient__handle_token = None
        value._OfficialA2AClient__closed = False
        value._OfficialA2AClient__model_requests = 0
        value._OfficialA2AClient__env = SimpleNamespace(
            time_manager=SimpleNamespace(time=lambda: 1000.0))
        value._OfficialA2AClient__app = SimpleNamespace(name="Contacts")
        excluded = {"schemaVersion": "gaia2-private-native-excluded-tools-v1",
            "appId": "Contacts", "toolCount": 0, "tools": [], "sourceManifestHash": "0" * 64}
        value._OfficialA2AClient__owner = SimpleNamespace(excluded_tool_snapshot=lambda: dict(excluded))
        value._OfficialA2AClient__excluded_tools = excluded
        value._OfficialA2AClient__scenario_id = "scenario-1"
        value._OfficialA2AClient__execution_id = "exec-1"
        value._OfficialA2AClient__session_id = "session-1"
        value._OfficialA2AClient__model = "controlled-model"
        value._OfficialA2AClient__provider = "openai"
        value._OfficialA2AClient__endpoint = ENDPOINT
        value._OfficialA2AClient__api_key = SECRET
        value._OfficialA2AClient__notification_reader_factory = None
        value._OfficialA2AClient__notification_pump_factory = None
        value._OfficialA2AClient__require_notification_pump = False
        value._OfficialA2AClient__require_generation_time = False
        value._OfficialA2AClient__deadline_factory = None
        value._OfficialA2AClient__require_notification = False
        value._OfficialA2AClient__require_deadline = False
        value._OfficialA2AClient__guard_receipt = None
        value._OfficialA2AClient__tool_evidence_kinds = {}
        value._OfficialA2AClient__model_event_emitter = emitter
        return value

    def begin(self, client):
        client.begin_child(parent_response={"evidencePath": "parent.json",
            "decision": {"action": "allow"}}, task="delegate task")

    def model_request(self, client):
        messages = [{"role": "user", "content": "private prompt " + SECRET,
                     "attachments": None}]
        return {"requestId": "1" * 32, "iteration": 0, "messages": messages,
                "projectedMessages": [{"role": "user", "content": messages[0]["content"],
                    "id": client._OfficialA2AClient__scope["childExecutionId"] + ".model-message-1",
                    "requestId": "1" * 32}], "clock": {"now": 1000.0, "revision": 1}}

    def retry_child(self, outcomes):
        emitter, sdk, clock = SafeEmitter(), FakeSdk(outcomes), FakeClock()
        client = self.lifetime_client(emitter)
        self.begin(client)

        def engine_factory(**kwargs):
            return ScopedRetryModelEngine(**kwargs, clock=clock.time,
                sleep=clock.sleep, monotonic_clock=clock.time)

        retry_env = {"GAIA2_MODEL_MAX_ATTEMPTS": "6", "GAIA2_MODEL_BACKOFF_BASE_SECONDS": "2",
            "GAIA2_MODEL_BACKOFF_MAX_SECONDS": "120", "GAIA2_MODEL_MAX_RETRY_WAIT_SECONDS": "3600",
            "GAIA2_E2E_LLM_TIMEOUT_SECONDS": "60"}
        with patch.dict(os.environ, retry_env), \
                patch("gaia2_official_a2a._sdk_completion", sdk), \
                patch("gaia2_official_a2a.ScopedRetryModelEngine", side_effect=engine_factory), \
                patch("gaia2_official_a2a.build_scoped_app_agent", side_effect=CapturedRunner):
            runner = client.child_runner()
        request = self.model_request(client)
        gate = runner.kwargs["model_gate"](request)
        actual = list(request["messages"])
        actual.insert(1, {"role": "system", "content": "Live Capybara dynamic context:\n" + gate["context"],
                          "attachments": None})
        runner.engine.begin_request(permit_id=gate["permitId"], request_id=gate["requestId"],
            actual_input_hash=gate["actualInputHash"], before_attempt=runner.authorize)
        return client, runner, actual, sdk, clock, emitter

    def assert_safe_child_events(self, client, emitter):
        encoded = json.dumps(emitter.events, sort_keys=True)
        for forbidden in (SECRET, ENDPOINT, "private prompt", "delegate task",
                          "api_key", "sdk_kwargs", "messages"):
            self.assertNotIn(forbidden, encoded)
        for event in emitter.events:
            self.assertEqual(event["modelRole"], "child_actor")
            self.assertEqual(event["parentExecutionId"], "exec-1")
            self.assertEqual(event["parentSessionId"], "session-1")
            self.assertEqual(event["childExecutionId"], "child-execution-1")
            self.assertEqual(event["childSessionId"], "child-session-1")
            self.assertEqual(event["delegationScopeHash"], value_hash(client._OfficialA2AClient__scope))

    def test_two_children_have_local_acks_and_preserve_lifetime_totals(self):
        for completed in (False, True):
            with self.subTest(first_child_completed=completed):
                client = self.lifetime_client()
                self.begin(client)
                model_scope, scope_hash, _, _ = client._model_binding()
                gate = client._model_gate(self.model_request(client), model_scope=model_scope,
                                         model_scope_hash=scope_hash)
                for attempt in (1, 2):
                    ack = client._model_attempt({"permitId": gate["permitId"],
                        "requestId": gate["requestId"], "actualInputHash": gate["actualInputHash"],
                        "attempt": attempt}, model_scope_hash=scope_hash)
                    self.assertEqual((ack["logicalRequestsUsed"], ack["sdkAttemptsUsed"]), (1, attempt))
                client.reset_child(completed=completed)
                self.assertEqual((client.snapshot()["modelRequests"], client.snapshot()["sdkAttempts"]), (1, 2))
                self.begin(client)
                model_scope, scope_hash, _, _ = client._model_binding()
                gate = client._model_gate(self.model_request(client), model_scope=model_scope,
                                         model_scope_hash=scope_hash)
                ack = client._model_attempt({"permitId": gate["permitId"], "requestId": gate["requestId"],
                    "actualInputHash": gate["actualInputHash"], "attempt": 1}, model_scope_hash=scope_hash)
                self.assertEqual((ack["logicalRequestsUsed"], ack["sdkAttemptsUsed"]), (1, 1))
                self.assertEqual((client.snapshot()["modelRequests"], client.snapshot()["sdkAttempts"]), (2, 3))

    def test_official_child_retries_six_503s_with_observable_safe_identity(self):
        client, runner, actual, sdk, clock, emitter = self.retry_child([HttpFailure(503) for _ in range(6)])
        with self.assertRaises(ScopedModelBrokerError) as caught:
            runner.engine(actual)
        self.assertEqual(caught.exception.code, "SCOPED_MODEL_TRANSPORT_ERROR")
        self.assertEqual(len(sdk.calls), 6)
        self.assertEqual([ack["attempt"] for ack in runner.attempts], [1, 2, 3, 4, 5, 6])
        self.assertEqual(sum(clock.waits), 62)
        failed = [event for event in emitter.events if event["type"] == "model_request_failed"]
        scheduled = [event for event in emitter.events if event["type"] == "model_retry_scheduled"]
        self.assertEqual(len(failed), 6)
        self.assertEqual([event["waitSeconds"] for event in scheduled], [2, 4, 8, 16, 32])
        self.assertEqual((failed[-1]["requestAttempt"], failed[-1]["maxRequestAttempts"],
                          failed[-1]["cumulativeWaitSeconds"], failed[-1]["retryExhausted"]), (6, 6, 62, True))
        for call in sdk.calls:
            self.assertEqual((call["num_retries"], call["max_retries"]), (0, 0))
            self.assertIsNone(call["retry_policy"])
            self.assertEqual(call["fallbacks"], [])
        self.assert_safe_child_events(client, emitter)

    def test_official_child_success_records_usage_without_output_or_config(self):
        response = {"choices": [{"message": {"content": "private output " + SECRET}}],
                    "usage": {"prompt_tokens": 2, "completion_tokens": 3,
                              "total_tokens": 5, "raw_secret": SECRET}}
        client, runner, actual, sdk, clock, emitter = self.retry_child([HttpFailure(503), response])
        text, metadata = runner.engine(actual)
        self.assertEqual(text, response["choices"][0]["message"]["content"])
        self.assertEqual(metadata["modelRole"], "child_actor")
        self.assertEqual(len(sdk.calls), 2)
        self.assertEqual(sum(clock.waits), 2)
        succeeded = next(event for event in emitter.events if event["type"] == "model_request_succeeded")
        self.assertEqual(succeeded["usage"], {"inputTokens": 2, "outputTokens": 3, "totalTokens": 5})
        self.assertEqual(succeeded["requestAttempt"], 2)
        self.assert_safe_child_events(client, emitter)

    def test_official_child_permanent_error_does_not_retry(self):
        client, runner, actual, sdk, clock, emitter = self.retry_child([HttpFailure(403)])
        with self.assertRaises(ScopedModelBrokerError) as caught:
            runner.engine(actual)
        self.assertFalse(caught.exception.retryable)
        self.assertEqual(caught.exception.code, "SCOPED_MODEL_CONFIGURATION_ERROR")
        self.assertEqual(len(sdk.calls), 1)
        self.assertEqual(clock.waits, [])
        self.assertFalse(any(event["type"] == "model_retry_scheduled" for event in emitter.events))
        self.assert_safe_child_events(client, emitter)

    def test_emitter_captures_scope_and_rejects_untrusted_fields(self):
        recorder = SafeEmitter()
        client = self.lifetime_client(recorder)
        self.begin(client)
        model_scope, scope_hash, _, _ = client._model_binding()
        emit = client._model_emitter(model_scope=model_scope, model_scope_hash=scope_hash)
        fields = {"schemaVersion": "gaia2-scoped-model-event-v1", "modelRole": "child_actor",
            "modelScopeHash": scope_hash, "configHash": model_scope["configHash"],
            "permitId": "a" * 32, "requestId": "b" * 32, "actualInputHash": "c" * 64}
        captured_scope_hash = value_hash(client._OfficialA2AClient__scope)
        client._OfficialA2AClient__scope["childExecutionId"] = "later-child"
        emit("model_logical_request_started", **fields)
        self.assertEqual(recorder.events[0]["childExecutionId"], "child-execution-1")
        self.assertEqual(recorder.events[0]["delegationScopeHash"], captured_scope_hash)
        for changed in ({"modelRole": "judge"}, {"modelScopeHash": "d" * 64},
                        {"childExecutionId": "self-signed"}, {"messages": SECRET},
                        {"task": SECRET}, {"sdk_kwargs": {"api_key": SECRET}},
                        {"usage": {"raw_secret": SECRET}}):
            with self.subTest(fields=sorted(changed)), self.assertRaises(OfficialA2AError):
                emit("model_request_attempt", **{**fields, **changed})
        self.assertEqual(len(recorder.events), 1)

    def test_emitter_constructor_validation_and_connect_forwarding(self):
        with self.assertRaisesRegex(OfficialA2AError, "A2A_MODEL_EVENT_EMITTER_INVALID"):
            OfficialA2AClient(env=None, app=SimpleNamespace(name="Contacts"),
                scenario_id="scenario-1", workspace="unused", model="controlled-model",
                provider="openai", endpoint=ENDPOINT, api_key=SECRET, model_event_emitter=object())
        emitter = SafeEmitter()
        with patch("gaia2_official_a2a.OfficialA2AClient") as constructor:
            connect_official_a2a(env=None, app=None, scenario_id="scenario-1", workspace="unused",
                model="controlled-model", provider="openai", endpoint=ENDPOINT, api_key=SECRET,
                model_event_emitter=emitter)
        self.assertIs(constructor.call_args.kwargs["model_event_emitter"], emitter)

    def test_scope_binds_parent_session_app_task_and_deadline(self):
        checked = _validate_scope(scope(), execution_id="exec-1", session_id="session-1",
                                  app_id="Contacts", task="delegate task", are_now=1000.0)
        self.assertEqual(checked["appId"], "Contacts")
        for key, value in (("parentExecutionId", "foreign"),
                           ("appId", "Other"), ("taskHash", "b" * 64),
                           ("deadline", 1000.0), ("maxNativeActions", 0)):
            changed = scope()
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(OfficialA2AError):
                _validate_scope(changed, execution_id="exec-1", session_id="session-1",
                                app_id="Contacts", task="delegate task", are_now=1000.0)
        for key, value in (("deadline", math.inf), ("deadline", math.nan),
                           ("deadline", 10 ** 400), ("deadline", -(10 ** 400))):
            changed = scope()
            changed[key] = value
            with self.subTest(key=f"{key}:{value}"), self.assertRaises(OfficialA2AError):
                _validate_scope(changed, execution_id="exec-1", session_id="session-1",
                                app_id="Contacts", task="delegate task", are_now=1000.0)

    def test_guard_receipt_is_unbound_until_both_capabilities_are_present(self):
        unbound = _guard_receipt(scope=scope(), snapshot={
            "notificationReaderAttached": False, "deadlineOptIn": False,
        }, require_notification=True, require_deadline=True)
        self.assertEqual(unbound["status"], "unbound")
        self.assertFalse(unbound["admissible"])
        self.assertEqual(unbound["reasonCode"], "A2A_NOTIFICATION_READER_UNBOUND")
        bound = _guard_receipt(scope=scope(), snapshot={
            "notificationReaderAttached": True, "deadlineOptIn": True,
        }, require_notification=True, require_deadline=True)
        self.assertEqual(bound["status"], "bound")
        self.assertTrue(bound["admissible"])
        self.assertEqual(bound["scopeHash"], value_hash(scope()))

    def test_production_guard_requires_pump_and_measured_generation_not_just_opt_in(self):
        snapshot = {"notificationReaderAttached": True, "deadlineOptIn": True,
            "notificationPumpAttached": True, "generationTimeOptIn": True,
            "generationTimeOwnerFactoryBound": True, "generationLedgerFactoryBound": True,
            "generationTimingOffsetMode": "successfulSdkElapsedSeconds",
            "generationTimingSource": "ScopedRetryModelEngine.monotonic_clock"}
        bound = _guard_receipt(scope=scope(), snapshot=snapshot,
            require_notification=True, require_deadline=True,
            require_notification_pump=True, require_generation_time=True)
        self.assertEqual(bound["schemaVersion"], "gaia2-official-a2a-guard-binding-v2")
        self.assertTrue(bound["admissible"])
        for key, failure in (("notificationPumpAttached", "A2A_NOTIFICATION_PUMP_UNBOUND"),
                ("generationLedgerFactoryBound", "A2A_GENERATION_TIME_UNBOUND"),
                ("generationTimingOffsetMode", "A2A_GENERATION_TIME_UNBOUND")):
            with self.subTest(key=key):
                denied = _guard_receipt(scope=scope(), snapshot={**snapshot, key: False},
                    require_notification=True, require_deadline=True,
                    require_notification_pump=True, require_generation_time=True)
                self.assertFalse(denied["admissible"])
                self.assertEqual(denied["reasonCode"], failure)
        legacy = _guard_receipt(scope=scope(), snapshot=snapshot,
            require_notification=True, require_deadline=True)
        self.assertEqual(legacy["schemaVersion"], "gaia2-official-a2a-guard-binding-v1")
        self.assertNotIn("notificationPumpBound", legacy)

    def test_cancel_requires_exact_ack_and_retains_uncertain_child_sticky(self):
        for reply in (RuntimeError(SECRET), {"ok": True}, False):
            with self.subTest(reply=type(reply).__name__):
                client = self.lifetime_client()
                self.begin(client)
                original_scope = dict(client._OfficialA2AClient__scope)
                original_token = client._OfficialA2AClient__handle_token
                client._OfficialA2AClient__peer = FakePeer([reply])
                revoked = []
                client._install_failure_callback(revoked.append)
                with self.assertRaisesRegex(OfficialA2AError, "A2A_CHILD_CANCEL_FAILED"):
                    client.reset_child(completed=False)
                self.assertEqual(revoked, ["A2A_CHILD_CANCEL_FAILED"])
                self.assertEqual(client._OfficialA2AClient__scope, original_scope)
                self.assertEqual(client._OfficialA2AClient__handle_token, original_token)
                self.assertTrue(client.snapshot()["failed"])
                with self.assertRaisesRegex(OfficialA2AError, "A2A_CHILD_CANCEL_FAILED"):
                    self.begin(client)
                with self.assertRaisesRegex(OfficialA2AError, "A2A_CHILD_CANCEL_FAILED"):
                    client.child_runner()
                with self.assertRaisesRegex(OfficialA2AError, "A2A_CHILD_CANCEL_FAILED"):
                    client.reset_child(completed=True)
                self.assertEqual(client._OfficialA2AClient__handle_token, original_token)

    def test_reader_created_before_pump_and_trusted_connect_parameters_forwarded(self):
        calls = []
        reader = SimpleNamespace(close=lambda: calls.append("reader_close"))
        def reader_factory(child_scope):
            self.assertEqual(child_scope, scope())
            calls.append("reader")
            return reader
        def pump_factory(child_scope):
            self.assertEqual(calls, ["reader"])
            calls.append("pump")
            return lambda stage: False
        client = self.lifetime_client()
        self.begin(client)
        client._OfficialA2AClient__notification_reader_factory = reader_factory
        client._OfficialA2AClient__notification_pump_factory = pump_factory
        with patch("gaia2_official_a2a.build_scoped_app_agent", side_effect=CapturedRunner):
            runner = client.child_runner()
        self.assertEqual(calls, ["reader", "pump"])
        self.assertIs(runner.kwargs["notification_reader"], reader)
        self.assertFalse(runner.kwargs["notification_pump"]("test"))
        with patch("gaia2_official_a2a.OfficialA2AClient") as constructor:
            connect_official_a2a(env=None, app=None, scenario_id="scenario-1", workspace="unused",
                model="controlled-model", provider="openai", endpoint=ENDPOINT, api_key=SECRET,
                notification_pump_factory=pump_factory,
                require_notification_pump=True, require_generation_time=True)
        self.assertIs(constructor.call_args.kwargs["notification_pump_factory"], pump_factory)
        self.assertTrue(constructor.call_args.kwargs["require_notification_pump"])
        self.assertTrue(constructor.call_args.kwargs["require_generation_time"])

    def test_model_attempt_and_finish_require_remote_positive_ack(self):
        payload = {"permitId": "a" * 32, "requestId": "b" * 32,
                   "attempt": 1, "actualInputHash": "c" * 64}
        client = self.client(FakePeer([{"ok": True}, {"ok": True}]))
        attempt = client._model_attempt(payload, model_scope_hash="d" * 64)
        self.assertEqual(attempt["sdkAttemptsUsed"], 1)
        finish_payload = {"permitId": payload["permitId"], "requestId": payload["requestId"],
                          "actualInputHash": payload["actualInputHash"],
                          "outputHash": "e" * 64, "usage": None}
        finished = client._model_finish(finish_payload, model_scope_hash="d" * 64)
        self.assertEqual(finished["status"], "completed")
        self.assertEqual([item[0] for item in client._OfficialA2AClient__peer.calls],
                         ["a2a_assert_model", "a2a_complete_model"])
        rejected = self.client(FakePeer([{"ok": False}]))
        with self.assertRaisesRegex(OfficialA2AError, "A2A_MODEL_ATTEMPT_REJECTED"):
            rejected._model_attempt(payload, model_scope_hash="d" * 64)

    def test_model_gate_keeps_parent_scope_and_hashes(self):
        context = "dynamic context"
        response = {"context": context,
                    "contextHash": hashlib.sha256(context.encode()).hexdigest(),
                    "variablesHash": "f" * 64, "revision": 1,
                    "evidence": {"path": "owned.json", "sha256": "0" * 64}}
        peer = FakePeer([response])
        client = self.client(peer)
        model_scope = {"schemaVersion": "capybara-scoped-model-scope-v1",
                       "delegationScopeHash": value_hash(scope()), "modelRole": "child_actor",
                       "configHash": "1" * 64, "maxLogicalRequests": 40, "maxSdkAttempts": 80}
        request = {"requestId": "1" * 32, "iteration": 0,
                   "messages": [{"role": "user", "content": "task", "attachments": None}],
                   "projectedMessages": [{"role": "user", "content": "task",
                                          "id": "child-execution-1.model-message-1",
                                          "requestId": "1" * 32}],
                   "clock": {"now": 1000.0, "revision": 1}}
        result = client._model_gate(request, model_scope=model_scope,
                                    model_scope_hash=value_hash(model_scope))
        self.assertEqual(result["requestId"], request["requestId"])
        self.assertEqual(result["scopeHash"], value_hash(scope()))
        self.assertEqual(result["actualInputHash"], value_hash([
            request["messages"][0], {"role": "system",
            "content": "Live Capybara dynamic context:\n" + context,
            "attachments": None}
        ]))

    def test_client_snapshot_preserves_explicit_exclusion_after_close_without_secrets(self):
        client = self.lifetime_client()
        excluded = {"schemaVersion": "gaia2-private-native-excluded-tools-v1",
            "appId": "Contacts", "toolCount": 1, "sourceManifestHash": "0" * 64,
            "tools": [{"publicName": "Contacts__unsupported",
                "canonicalName": "Contacts__unsupported", "reasonCode": "NATIVE_TOOL_EFFECT_UNDECLARED"}]}
        client._OfficialA2AClient__excluded_tools = excluded
        client._OfficialA2AClient__owner = SimpleNamespace(excluded_tool_snapshot=lambda: json.loads(json.dumps(excluded)))
        self.assertEqual(client.snapshot()["excludedTools"], excluded)
        client._OfficialA2AClient__closed = True
        first = client.snapshot()
        first["excludedTools"]["tools"].clear()
        second = client.snapshot()
        self.assertEqual(second["excludedTools"], excluded)
        self.assertNotIn(SECRET, json.dumps(second))
        self.assertNotIn(ENDPOINT, json.dumps(second))


if __name__ == "__main__":
    unittest.main(verbosity=2)
