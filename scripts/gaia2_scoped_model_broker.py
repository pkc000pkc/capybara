"""Trusted instance-local model retries, not an Actor API or HTTP observer.

The constructor owns the role, pristine SDK callable and kwargs factory. A
trusted scoped runner binds a one-use permit before each logical request and
supplies one stable guard. That guard authorizes every individual SDK attempt.
No ARE/LiteLLM aliases or process globals are changed. A compatible real SDK
callable may be injected, but this module never imports or calls a provider by
itself. Python privacy is not a sandbox for hostile in-process Python code.
"""

from __future__ import annotations

import hashlib
import inspect
import math
from pathlib import Path
import re
import stat
import sys
import threading
import time
from typing import Any, Callable, Mapping

import gaia2_a2a_wire as wire
from gaia2_model_retry import ModelRetryPolicy, classify_model_error, retry_delay_hint, _iso, _safe_usage
from are.simulation.agents.llm.llm_engine import LLMEngine
from are.simulation.agents.llm.types import MessageRole

ROLES = ("actor", "child_actor", "judge", "correction")
EVENT_SCHEMA = "gaia2-scoped-model-event-v1"
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_ID = re.compile(r"[a-f0-9]{32}\Z")
_RETRY_CODES = {"configuration_error": "SCOPED_MODEL_CONFIGURATION_ERROR",
    "rate_limit": "SCOPED_MODEL_RATE_LIMIT", "request_timeout": "SCOPED_MODEL_REQUEST_TIMEOUT",
    "transport_error": "SCOPED_MODEL_TRANSPORT_ERROR", "runtime_error": "SCOPED_MODEL_RUNTIME_ERROR"}


class ScopedModelBrokerError(RuntimeError):
    """Fixed codes and safe metadata only; no credential-bearing cause."""

    def __init__(self, code: str, metadata: dict | None = None):
        self.code = code
        self.metadata = _clone(metadata or {})
        self.category = self.metadata.get("category", "runtime_error")
        self.retryable = self.metadata.get("retryable", False)
        super().__init__(code)


def _fail(code: str, metadata: dict | None = None) -> None:
    raise ScopedModelBrokerError(code, metadata) from None


def _clone(value: Any) -> Any:
    try:
        return wire.decode_value(wire.encode_value(value))
    except BaseException:
        raise ScopedModelBrokerError("SCOPED_MODEL_UNSAFE_VALUE") from None


def _identity(value: Any) -> tuple:
    receiver = getattr(value, "__self__", None)
    function = getattr(value, "__func__", value)
    if receiver is not None and not hasattr(value, "__func__"):
        function = getattr(type(receiver), getattr(value, "__name__", ""), None)
    elif receiver is None and not inspect.isroutine(value):
        receiver, function = value, getattr(type(value), "__call__", None)
    return (id(receiver), id(function), id(getattr(function, "__code__", None)),
        id(getattr(function, "__defaults__", None)), id(getattr(function, "__kwdefaults__", None)))


def _pristine(value: Any) -> None:
    if not callable(value):
        _fail("SCOPED_MODEL_SDK_INVALID")
    seen = set()
    cursor = value
    while cursor is not None and id(cursor) not in seen:
        seen.add(id(cursor))
        if (getattr(cursor, "_gaia2_model_retry", False)
                or getattr(getattr(cursor, "__self__", None), "_gaia2_model_retry", False)):
            _fail("SCOPED_MODEL_WRAPPED_SDK_FORBIDDEN")
        cursor = getattr(cursor, "__wrapped__", None)
    # Pinned LiteLLM treats zero as a fallback to its global retry setting.
    # Reject such a configuration; changing process globals is forbidden here.
    module = getattr(getattr(value, "__func__", value), "__module__", "")
    if type(module) is str and module.startswith("litellm"):
        litellm = sys.modules.get("litellm")
        if litellm is not None and getattr(litellm, "num_retries", 0) not in (None, 0):
            _fail("SCOPED_MODEL_SDK_AUTORETRY_FORBIDDEN")


def _source(value: Any) -> tuple[Path, str]:
    try:
        try:
            path = inspect.getsourcefile(value)
        except (OSError, TypeError):
            path = None
        if path is None:
            path = inspect.getsourcefile(type(value))
        if path is None:
            _fail("SCOPED_MODEL_SOURCE_UNAVAILABLE")
        target = Path(path).absolute()
        for cursor in (target, *target.parents):
            info = cursor.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                _fail("SCOPED_MODEL_SOURCE_INVALID")
        if not target.is_file() or target.resolve(strict=True) != target:
            _fail("SCOPED_MODEL_SOURCE_INVALID")
        data = target.read_bytes()
        return target, hashlib.sha256(data).hexdigest()
    except ScopedModelBrokerError:
        raise
    except BaseException:
        _fail("SCOPED_MODEL_SOURCE_UNAVAILABLE")


def normalize_model_messages(messages: Any) -> list[dict]:
    """Canonical original ARE text messages, before provider role conversion.

    Its wire hash is also the scoped runner's actualInputHash. Nonempty
    attachments are rejected, never silently erased or stringified.
    """
    if type(messages) is not list or not messages:
        _fail("SCOPED_MODEL_INPUT_INVALID")
    result = []
    for message in messages:
        if type(message) is not dict or set(message) - {"role", "content", "attachments"}:
            _fail("SCOPED_MODEL_INPUT_INVALID")
        role = message.get("role")
        if type(role) is MessageRole:
            role = role.value
        if type(role) is not str or role not in MessageRole.roles() or type(message.get("content")) is not str:
            _fail("SCOPED_MODEL_INPUT_INVALID")
        attachment = message.get("attachments")
        if attachment is not None and not (type(attachment) is list and not attachment):
            _fail("SCOPED_MODEL_ATTACHMENT_UNSUPPORTED")
        result.append({"role": role, "content": message["content"], "attachments": None})
    return _clone(result)


def model_input_hash(messages: Any) -> str:
    return wire.value_hash(normalize_model_messages(messages))


def _policy_value(policy: ModelRetryPolicy) -> dict:
    if type(policy) is not ModelRetryPolicy:
        _fail("SCOPED_MODEL_POLICY_INVALID")
    return {name: getattr(policy, name) for name in ("max_attempts", "backoff_base_seconds",
        "backoff_max_seconds", "max_retry_wait_seconds", "request_timeout_seconds")}


def _sdk_kwargs(value: Any, policy: ModelRetryPolicy) -> dict:
    if type(value) is not dict or set(value) & {"messages", "tools", "tool_choice", "stop", "stream", "mock_response"}:
        _fail("SCOPED_MODEL_SDK_CONFIG_INVALID")
    result = _clone(value)
    result.update(num_retries=0, max_retries=0, retry_policy=None,
        context_window_fallback_dict={}, fallbacks=[], drop_params=False,
        timeout=policy.request_timeout_seconds)
    return result


def scoped_model_config_hash(sdk_kwargs: dict, policy: ModelRetryPolicy) -> str:
    """Trusted factory helper. Secret values are hashed, never returned/logged."""
    effective = _sdk_kwargs(sdk_kwargs, policy)
    return wire.value_hash({"factoryKwargs": _clone(sdk_kwargs), "effectiveKwargs": effective,
        "retryPolicy": _policy_value(policy)})


def _response_text(result: Any) -> str:
    try:
        if type(result) is str:
            text = result
        else:
            choices = result.get("choices") if isinstance(result, Mapping) else getattr(result, "choices", None)
            choice = choices[0]
            message = choice.get("message") if isinstance(choice, Mapping) else getattr(choice, "message", None)
            text = message.get("content") if isinstance(message, Mapping) else getattr(message, "content", None)
        if type(text) is not str:
            _fail("SCOPED_MODEL_RESPONSE_INVALID")
        text.encode("utf-8", errors="strict")
        return text
    except ScopedModelBrokerError:
        raise
    except BaseException:
        _fail("SCOPED_MODEL_RESPONSE_INVALID")


class ScopedRetryModelEngine(LLMEngine):
    """One immutable role/configuration, independent logical and SDK budgets.

    sdk_completion is a pristine LiteLLM-compatible callable, not a legacy
    retry wrapper. sdk_kwargs_factory is trusted, zero-argument constructor
    authority; Actor chat kwargs cannot select a role, endpoint or retries.
    """

    def __init__(self, *, role: str, model_scope_hash: str,
                 sdk_completion: Callable[..., Any], sdk_kwargs_factory: Callable[[], dict],
                 policy: ModelRetryPolicy, max_logical_requests: int, max_sdk_attempts: int,
                 before_attempt: Callable[[dict], Any] | None = None,
                 config_hash: str | None = None, emit: Callable[..., None] | None = None,
                 clock: Callable[[], float] = time.time, sleep: Callable[[float], None] = time.sleep,
                 monotonic_clock: Callable[[], float] = time.monotonic):
        if role not in ROLES or type(role) is not str or type(model_scope_hash) is not str or not _HASH.fullmatch(model_scope_hash):
            _fail("SCOPED_MODEL_IDENTITY_INVALID")
        if any(type(value) is not int or not 1 <= value <= 100000 for value in (max_logical_requests, max_sdk_attempts)):
            _fail("SCOPED_MODEL_BUDGET_INVALID")
        if (not all(callable(value) for value in (sdk_kwargs_factory, clock, sleep, monotonic_clock))
                or emit is not None and not callable(emit)
                or before_attempt is not None and not callable(before_attempt)):
            _fail("SCOPED_MODEL_CALLBACK_INVALID")
        _pristine(sdk_completion)
        _policy_value(policy)
        super().__init__("scoped-model")
        self.__role, self.__scope = role, model_scope_hash
        self.__sdk, self.__factory, self.__policy = sdk_completion, sdk_kwargs_factory, policy
        self.__logical_limit, self.__sdk_limit = max_logical_requests, max_sdk_attempts
        self.__guard, self.__emit, self.__clock, self.__sleep = before_attempt, emit, clock, sleep
        self.__monotonic = monotonic_clock
        self.__callbacks = {"sdk": sdk_completion, "factory": sdk_kwargs_factory, "clock": clock,
            "sleep": sleep, "monotonic": monotonic_clock}
        if emit is not None:
            self.__callbacks["emit"] = emit
        self.__identities = {name: _identity(value) for name, value in self.__callbacks.items()}
        self.__sources: dict[Path, str] = {}
        for value in (type(self), LLMEngine, MessageRole, ModelRetryPolicy, classify_model_error,
                retry_delay_hint, _safe_usage, wire.value_hash, *self.__callbacks.values()):
            # Built-in time functions have no Python source; their identity is
            # frozen, and the module's SDK/factory/guard sources remain pinned.
            if inspect.isbuiltin(value):
                continue
            path, sha = _source(value)
            self.__sources[path] = sha
        self.__guard_identity = None
        if before_attempt is not None:
            self.__freeze_guard(before_attempt)
        initial = self.__factory_value()
        self.__config = scoped_model_config_hash(initial, policy)
        if config_hash is not None and config_hash != self.__config:
            _fail("SCOPED_MODEL_CONFIG_CHANGED")
        self.__logical_used = self.__sdk_used = 0
        self.__pending = None
        self.__busy = False
        self.__seen_permits: set[str] = set()
        self.__seen_requests: set[str] = set()
        self.__last_request = self.__last_input = self.__last_output = self.__last_usage = None
        self.__last_attempts = 0
        self.__last_status = None
        self.__last_timing = None
        self.__timing_last = None
        self.__timing_failed = False
        self.__ledger_failed = False
        self.__lock = threading.RLock()
        # Constructor provenance stays stable when the trusted runner first
        # supplies its guard. That guard's source is still added to __sources
        # and rechecked on every call, but is separately frozen at first bind.
        self.__source_identity_hash = wire.value_hash(sorted(self.__sources.values()))
        self.__binding = (self.__role, self.__scope, self.__config, self.__logical_limit,
            self.__sdk_limit, id(self.__policy), _identity(type(self).chat_completion),
            _identity(type(self).begin_request), _identity(type(self).__call__), self.__source_identity_hash)

    @property
    def model_role(self):
        return self.__role

    @property
    def config_hash(self):
        return self.__config

    @property
    def model_scope_hash(self):
        return self.__scope

    @property
    def max_logical_requests(self):
        return self.__logical_limit

    @property
    def max_sdk_attempts(self):
        return self.__sdk_limit

    @property
    def last_usage(self):
        return self.get_last_usage()

    def get_last_usage(self):
        return _clone(self.__last_usage)

    def __factory_value(self) -> dict:
        try:
            value = self.__factory()
        except BaseException:
            _fail("SCOPED_MODEL_CONFIG_INVALID")
        if type(value) is not dict:
            _fail("SCOPED_MODEL_CONFIG_INVALID")
        return _clone(value)

    def __freeze_guard(self, guard: Callable[[dict], Any]) -> None:
        if not callable(guard):
            _fail("SCOPED_MODEL_GUARD_INVALID")
        identity = _identity(guard)
        if self.__guard_identity is not None and self.__guard_identity != identity:
            _fail("SCOPED_MODEL_GUARD_CHANGED")
        path, sha = _source(guard)
        if path in self.__sources and self.__sources[path] != sha:
            _fail("SCOPED_MODEL_SOURCE_CHANGED")
        self.__sources[path] = sha
        self.__guard_identity, self.__guard = identity, guard

    def __check(self) -> dict:
        try:
            if self.__ledger_failed:
                _fail("SCOPED_MODEL_LEDGER_FAILED")
            if self.__timing_failed:
                _fail("SCOPED_MODEL_TIMING_INVALID")
            binding = (self.__role, self.__scope, self.__config, self.__logical_limit,
                self.__sdk_limit, id(self.__policy), _identity(type(self).chat_completion),
                _identity(type(self).begin_request), _identity(type(self).__call__), self.__source_identity_hash)
            actual_callbacks = {"sdk": self.__sdk, "factory": self.__factory, "clock": self.__clock,
                "sleep": self.__sleep, "monotonic": self.__monotonic}
            if self.__emit is not None:
                actual_callbacks["emit"] = self.__emit
            if (binding != self.__binding or set(actual_callbacks) != set(self.__callbacks)
                    or any(_identity(value) != self.__identities[name] for name, value in actual_callbacks.items())):
                _fail("SCOPED_MODEL_SOURCE_CHANGED")
            if self.__guard is not None and _identity(self.__guard) != self.__guard_identity:
                _fail("SCOPED_MODEL_GUARD_CHANGED")
            _pristine(self.__sdk)
            for path, expected in self.__sources.items():
                actual_path, actual = _source_path(path)
                if actual_path != path or actual != expected:
                    _fail("SCOPED_MODEL_SOURCE_CHANGED")
            raw = self.__factory_value()
            if scoped_model_config_hash(raw, self.__policy) != self.__config:
                _fail("SCOPED_MODEL_CONFIG_CHANGED")
            return _sdk_kwargs(raw, self.__policy)
        except ScopedModelBrokerError:
            raise
        except BaseException:
            _fail("SCOPED_MODEL_SOURCE_CHANGED")

    def begin_request(self, *, permit_id: str, request_id: str, actual_input_hash: str,
                      before_attempt: Callable[[dict], Any] | None = None) -> None:
        with self.__lock:
            self.__check()
            if self.__pending is not None or self.__busy:
                _fail("SCOPED_MODEL_REQUEST_ACTIVE")
            if (type(permit_id) is not str or not _ID.fullmatch(permit_id)
                    or type(request_id) is not str or not _ID.fullmatch(request_id)
                    or type(actual_input_hash) is not str or not _HASH.fullmatch(actual_input_hash)):
                _fail("SCOPED_MODEL_PERMIT_INVALID")
            if permit_id in self.__seen_permits or request_id in self.__seen_requests:
                _fail("SCOPED_MODEL_PERMIT_REUSED")
            if self.__logical_used >= self.__logical_limit:
                _fail("SCOPED_MODEL_LOGICAL_BUDGET_EXHAUSTED")
            guard = before_attempt if before_attempt is not None else self.__guard
            if guard is None:
                _fail("SCOPED_MODEL_GUARD_REQUIRED")
            self.__freeze_guard(guard)
            self.__pending = {"permitId": permit_id, "requestId": request_id, "actualInputHash": actual_input_hash}
            self.__seen_permits.add(permit_id)
            self.__seen_requests.add(request_id)
            self.__last_request, self.__last_input = request_id, actual_input_hash
            self.__last_output = self.__last_usage = None
            self.__last_attempts, self.__last_status = 0, None
            self.__last_timing = None
            self.__timing_last = None

    def __timing_now(self) -> float:
        try:
            value = self.__monotonic()
        except BaseException:
            self.__timing_failed = True
            _fail("SCOPED_MODEL_TIMING_INVALID")
        if type(value) not in (int, float) or not math.isfinite(value):
            self.__timing_failed = True
            _fail("SCOPED_MODEL_TIMING_INVALID")
        value = float(value)
        if self.__timing_last is not None and value < self.__timing_last:
            self.__timing_failed = True
            _fail("SCOPED_MODEL_TIMING_INVALID")
        self.__timing_last = value
        return value

    def __timing_delta(self, start: float) -> float:
        delta = self.__timing_now() - start
        if not math.isfinite(delta) or delta < 0:
            self.__timing_failed = True
            _fail("SCOPED_MODEL_TIMING_INVALID")
        return delta

    def __timing_accumulate(self, total: float, delta: float) -> float:
        value = total + delta
        if not math.isfinite(value) or value < 0:
            self.__timing_failed = True
            _fail("SCOPED_MODEL_TIMING_INVALID")
        return value

    def get_last_timing(self):
        return _clone(self.__last_timing)

    def __event(self, kind: str, request: dict, **fields) -> None:
        if self.__ledger_failed:
            _fail("SCOPED_MODEL_LEDGER_FAILED")
        event = {"schemaVersion": EVENT_SCHEMA, "modelRole": self.__role,
            "modelScopeHash": self.__scope, "configHash": self.__config, **request, **fields}
        if self.__emit is not None:
            try:
                self.__emit(kind, **_clone(event))
            except BaseException:
                self.__ledger_failed = True
                _fail("SCOPED_MODEL_LEDGER_FAILED")

    def chat_completion(self, messages, stop_sequences=(), **kwargs):
        with self.__lock:
            self.__check()
            if self.__busy or self.__pending is None:
                _fail("SCOPED_MODEL_PERMIT_REQUIRED")
            request, self.__pending, self.__busy = self.__pending, None, True
        started, waited, attempted = False, 0.0, 0
        timing_start = None
        attempt_elapsed = 0.0
        attempt_observed = False
        success_elapsed = None
        cooldown_elapsed = 0.0
        try:
            # Official BaseAgent always passes schema=self.decoding_schema.
            # None is its default text-only mode, not an Actor SDK option.
            # Non-null schemas (including ARE DecodingSchema) are explicitly
            # unsupported here, and neither schema nor trace tags reach SDK.
            if set(kwargs) - {"additional_trace_tags", "schema"} or kwargs.get("schema") is not None:
                _fail("SCOPED_MODEL_ACTOR_KWARGS_FORBIDDEN")
            if "additional_trace_tags" in kwargs and (type(kwargs["additional_trace_tags"]) not in (list, tuple)
                    or any(type(tag) is not str for tag in kwargs["additional_trace_tags"])):
                _fail("SCOPED_MODEL_INPUT_INVALID")
            if type(stop_sequences) not in (tuple, list) or any(type(stop) is not str for stop in stop_sequences):
                _fail("SCOPED_MODEL_INPUT_INVALID")
            normalized = normalize_model_messages(messages)
            if wire.value_hash(normalized) != request["actualInputHash"]:
                _fail("SCOPED_MODEL_INPUT_HASH_CHANGED")
            converted = [{"role": {"tool-response": "user", "tool-call": "assistant"}.get(message["role"], message["role"]),
                "content": message["content"]} for message in normalized]
            self.__logical_used += 1
            started = True
            self.__event("model_logical_request_started", request)
            timing_start = self.__timing_now()
            began = self.__clock()
            for attempt in range(1, self.__policy.max_attempts + 1):
                sdk_kwargs = self.__check()
                if self.__sdk_used >= self.__sdk_limit:
                    _fail("SCOPED_MODEL_SDK_BUDGET_EXHAUSTED")
                guard_payload = {**request, "attempt": attempt}
                try:
                    # The trusted runner independently validates the full Node
                    # ACK. Only an exception-free guard return authorizes SDK.
                    self.__guard(_clone(guard_payload))
                except BaseException:
                    _fail("SCOPED_MODEL_ATTEMPT_DENIED")
                # A late source/config mutation in the guard cannot dispatch.
                sdk_kwargs = self.__check()
                operational = {"requestAttempt": attempt, "maxRequestAttempts": self.__policy.max_attempts,
                    "cumulativeWaitSeconds": waited}
                self.__event("model_request_attempt", request, **operational)
                self.__sdk_used += 1
                attempted += 1
                self.__last_attempts = attempted
                attempt_start = self.__timing_now()
                attempt_observed = True
                try:
                    result = self.__sdk(messages=_clone(converted), **sdk_kwargs)
                except Exception as error:
                    attempt_elapsed = self.__timing_accumulate(attempt_elapsed,
                        self.__timing_delta(attempt_start))
                    try:
                        classification = classify_model_error(error)
                        now = self.__clock()
                        hint, hint_source = retry_delay_hint(error, now)
                    except BaseException:
                        classification = {"category": "runtime_error", "retryable": False, "httpStatus": None}
                        now, hint, hint_source = 0.0, None, None
                else:
                    self.__check()
                    success_elapsed = self.__timing_delta(attempt_start)
                    attempt_elapsed = self.__timing_accumulate(attempt_elapsed, success_elapsed)
                    text = _response_text(result)
                    usage_result = _safe_usage(result)
                    usage = usage_result.get("usage")
                    logical_elapsed = self.__timing_delta(timing_start)
                    elapsed = max(0.0, self.__clock() - began)
                    if not math.isfinite(elapsed):
                        elapsed = 0.0
                    output_hash = hashlib.sha256(text.encode("utf-8", errors="strict")).hexdigest()
                    timing = {"schemaVersion": "gaia2-scoped-model-timing-v1",
                        "logicalElapsedSeconds": logical_elapsed, "sdkAttemptElapsedSeconds": attempt_elapsed,
                        "successfulSdkElapsedSeconds": success_elapsed, "cooldownSeconds": cooldown_elapsed}
                    # Timing, completion duration, and output identity are all
                    # computed before the irreversible success-event commit.
                    # Once status is marked succeeded, no rejection event may
                    # be appended for a later ledger callback failure.
                    self.__last_output, self.__last_usage = output_hash, usage
                    self.__last_timing = timing
                    self.__last_status = "succeeded"
                    self.__event("model_request_succeeded", request, **operational,
                        outputHash=output_hash, **usage_result)
                    self.__event("model_logical_request_finished", request, status="succeeded", sdkAttempts=attempted)
                    # Preserve the original SDK string for ARE's real parser;
                    # do not lowercase booleans, stringify or trim stop tokens.
                    return text, {"completion_duration": elapsed, "modelRole": self.__role,
                        "modelScopeHash": self.__scope, "configHash": self.__config,
                        "requestId": request["requestId"], "actualInputHash": request["actualInputHash"],
                        "outputHash": output_hash, "usage": _clone(usage)}
                backoff = min(self.__policy.backoff_max_seconds,
                    self.__policy.backoff_base_seconds * 2 ** min(attempt - 1, 30))
                delay = max(backoff, hint or 0.0)
                next_retry_at = _iso(now + delay) if classification["retryable"] else None
                exhausted = attempt >= self.__policy.max_attempts or waited + delay > self.__policy.max_retry_wait_seconds
                metadata = {**operational, **classification, "nextRetryAt": next_retry_at,
                    "retryExhausted": bool(exhausted and classification["retryable"])}
                self.__event("model_request_failed", request, **metadata)
                if not classification["retryable"] or exhausted:
                    self.__last_status = "failed"
                    self.__event("model_logical_request_finished", request, status="failed", sdkAttempts=attempted)
                    _fail(_RETRY_CODES[classification["category"]], {**request, **metadata})
                self.__event("model_retry_scheduled", request, **metadata, waitSeconds=delay,
                    delaySource=hint_source if hint is not None and hint >= backoff else "exponential_backoff",
                    cumulativeWaitSecondsAfterRetry=waited + delay)
                remaining = delay
                while remaining > 0:
                    chunk = min(remaining, 30.0)
                    cooldown_start = self.__timing_now()
                    try:
                        self.__sleep(chunk)
                    except BaseException:
                        _fail("SCOPED_MODEL_WAIT_CANCELLED")
                    waited += chunk
                    cooldown_elapsed = self.__timing_accumulate(cooldown_elapsed,
                        self.__timing_delta(cooldown_start))
                    remaining = max(0.0, remaining - chunk)
                    self.__check()
                    if remaining > 0:
                        self.__event("model_retry_waiting", request, **{**operational, "cumulativeWaitSeconds": waited},
                            nextRetryAt=next_retry_at, remainingWaitSeconds=remaining)
            _fail("SCOPED_MODEL_RUNTIME_ERROR")
        except ScopedModelBrokerError as failure:
            if self.__ledger_failed:
                self.__last_status = "failed"
                self.__last_output = self.__last_usage = None
                raise failure from None
            if self.__last_status not in ("failed", "succeeded"):
                self.__last_status = "rejected"
                self.__last_output = self.__last_usage = None
                self.__event("model_request_rejected", request, failureCode=failure.code)
                if started:
                    self.__event("model_logical_request_finished", request, status="rejected", sdkAttempts=attempted)
            raise failure from None
        except BaseException:
            if self.__ledger_failed:
                self.__last_status = "failed"
                self.__last_output = self.__last_usage = None
                _fail("SCOPED_MODEL_LEDGER_FAILED")
            if self.__last_status != "succeeded":
                self.__last_status = "rejected"
                self.__last_output = self.__last_usage = None
                self.__event("model_request_rejected", request, failureCode="SCOPED_MODEL_RUNTIME_ERROR")
                if started:
                    self.__event("model_logical_request_finished", request, status="rejected", sdkAttempts=attempted)
            _fail("SCOPED_MODEL_RUNTIME_ERROR")
        finally:
            if started and self.__last_timing is None and timing_start is not None:
                try:
                    logical_elapsed = self.__timing_delta(timing_start)
                except ScopedModelBrokerError:
                    logical_elapsed = None
                    cooldown_elapsed = None
                if self.__timing_failed:
                    logical_elapsed = None
                    attempt_value = None
                    success_value = None
                    cooldown_value = None
                else:
                    attempt_value = attempt_elapsed if attempt_observed else None
                    success_value = success_elapsed
                    cooldown_value = cooldown_elapsed
                self.__last_timing = {"schemaVersion": "gaia2-scoped-model-timing-v1",
                    "logicalElapsedSeconds": logical_elapsed, "sdkAttemptElapsedSeconds": attempt_value,
                    "successfulSdkElapsedSeconds": success_value, "cooldownSeconds": cooldown_value}
            with self.__lock:
                self.__busy = False

    def snapshot(self) -> dict:
        self.__check()
        return {"schemaVersion": "gaia2-scoped-model-engine-v1", "modelRole": self.__role,
            "modelScopeHash": self.__scope, "configHash": self.__config,
            "maxLogicalRequests": self.__logical_limit, "maxSdkAttempts": self.__sdk_limit,
            "logicalRequestsUsed": self.__logical_used, "sdkAttemptsUsed": self.__sdk_used,
            "requestActive": self.__pending is not None or self.__busy,
            "lastRequestId": self.__last_request, "lastActualInputHash": self.__last_input,
            "lastOutputHash": self.__last_output, "lastUsage": _clone(self.__last_usage),
            "lastSdkAttempts": self.__last_attempts, "lastStatus": self.__last_status,
            "sourceIdentityHash": self.__source_identity_hash}


def _source_path(path: Path) -> tuple[Path, str]:
    try:
        for cursor in (path, *path.parents):
            info = cursor.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                _fail("SCOPED_MODEL_SOURCE_CHANGED")
        if not path.is_file() or path.resolve(strict=True) != path:
            _fail("SCOPED_MODEL_SOURCE_CHANGED")
        return path, hashlib.sha256(path.read_bytes()).hexdigest()
    except BaseException:
        _fail("SCOPED_MODEL_SOURCE_CHANGED")
