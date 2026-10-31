"""Observable retries for model requests only, never ARE/tool execution.

Only safe operational fields leave this module.  Prompts, reference answers,
HTTP bodies, credentials, endpoint URLs and raw exception messages do not.
The official ARE source is left untouched; its imported completion alias is
patched before engines are constructed.
"""

from __future__ import annotations

import functools
import hashlib
import importlib
import json
import math
import os
import re
import time
import uuid
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Mapping

from gaia2_model_diagnostics import safe_model_diagnostics, safe_request_summary
from gaia2_model_http_guard import guarded_sdk_attempt, _AttemptFailureReceipt


_JUDGE_REQUEST_CONTEXT = ContextVar("gaia2_judge_request_context", default=None)
_JUDGE_LAST_RESPONSE_CONTEXT = ContextVar("gaia2_judge_last_response_context", default=None)
_JUDGE_EXPECTED_MARKERS = ContextVar("gaia2_judge_expected_markers", default=None)
_JUDGE_CHECKER_PATH = "are/simulation/validation/utils/llm_utils.py"
_BOOLEAN_MARKER_PATTERN = re.compile(r"\[\[(true|false)\]\]", re.IGNORECASE)


@dataclass(frozen=True)
class ModelRetryPolicy:
    max_attempts: int = 6
    backoff_base_seconds: float = 2.0
    backoff_max_seconds: float = 120.0
    max_retry_wait_seconds: float = 3600.0
    request_timeout_seconds: float = 60.0

    def __post_init__(self) -> None:
        if isinstance(self.max_attempts, bool) or not isinstance(self.max_attempts, int) or self.max_attempts < 1:
            raise ValueError("model retry max_attempts must be a positive integer")
        for name in ("backoff_base_seconds", "backoff_max_seconds", "max_retry_wait_seconds", "request_timeout_seconds"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise ValueError(f"model retry {name} must be a finite nonnegative number")
        if self.request_timeout_seconds <= 0:
            raise ValueError("model request timeout must be positive")

    @classmethod
    def from_environment(cls) -> "ModelRetryPolicy":
        return cls(
            max_attempts=int(os.environ.get("GAIA2_MODEL_MAX_ATTEMPTS", "6")),
            backoff_base_seconds=float(os.environ.get("GAIA2_MODEL_BACKOFF_BASE_SECONDS", "2")),
            backoff_max_seconds=float(os.environ.get("GAIA2_MODEL_BACKOFF_MAX_SECONDS", "120")),
            max_retry_wait_seconds=float(os.environ.get("GAIA2_MODEL_MAX_RETRY_WAIT_SECONDS", "3600")),
            request_timeout_seconds=float(os.environ.get("GAIA2_E2E_LLM_TIMEOUT_SECONDS", "60")),
        )


class ModelRequestFailure(RuntimeError):
    """Sanitized terminal model failure; the original exception is not chained."""

    def __init__(self, metadata: Mapping[str, Any]):
        self.metadata = dict(metadata)
        self.category = metadata["category"]
        self.retryable = metadata["retryable"]
        self.status_code = metadata.get("httpStatus")
        self.next_retry_at = metadata.get("nextRetryAt")
        super().__init__(f"GAIA2 model request failed: {self.category}")


def _iso(timestamp: float) -> str | None:
    try:
        return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, OverflowError, OSError):
        return None


def _seconds(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return max(0.0, result) if math.isfinite(result) else None


def _timestamp(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value) if math.isfinite(value) else None
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    except (ValueError, OverflowError):
        try:
            parsed = parsedate_to_datetime(value)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed.timestamp()
        except (ValueError, TypeError, OverflowError):
            return None


def _structured_body(error: Exception) -> Mapping[str, Any]:
    body = getattr(error, "body", None)
    if not isinstance(body, Mapping):
        response = getattr(error, "response", None)
        try:
            body = response.json() if response is not None else None
        except Exception:
            body = None
    return body if isinstance(body, Mapping) else {}


def _headers(error: Exception) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for source in (getattr(error, "headers", None), getattr(getattr(error, "response", None), "headers", None)):
        if source is not None and hasattr(source, "items"):
            result.update({str(key).lower(): value for key, value in source.items()})
    return result


def retry_delay_hint(error: Exception, now: float) -> tuple[float | None, str | None]:
    """Read only explicitly structured cooldown data, not prose messages."""
    hints: list[tuple[float, str]] = []
    headers = _headers(error)
    if "retry-after" in headers:
        seconds = _seconds(headers["retry-after"])
        if seconds is None:
            deadline = _timestamp(headers["retry-after"])
            seconds = max(0.0, deadline - now) if deadline is not None else None
        if seconds is not None:
            hints.append((seconds, "retry_after"))
    if "retry-after-ms" in headers:
        seconds = _seconds(headers["retry-after-ms"])
        if seconds is not None:
            hints.append((seconds / 1000.0, "retry_after_ms"))
    body = _structured_body(error)
    containers = [body]
    if isinstance(body.get("error"), Mapping):
        containers.append(body["error"])
    for container in list(containers):
        if isinstance(container.get("cooldown"), Mapping):
            containers.append(container["cooldown"])
    for container in containers:
        for key in ("retry_after", "retry_after_seconds", "cooldown_seconds", "remaining_seconds"):
            seconds = _seconds(container.get(key))
            if seconds is not None:
                hints.append((seconds, "structured_cooldown"))
        for key in ("retry_at", "reset_at", "next_retry_at"):
            deadline = _timestamp(container.get(key))
            if deadline is not None:
                hints.append((max(0.0, deadline - now), "structured_cooldown"))
    return max(hints, key=lambda item: item[0]) if hints else (None, None)


def classify_model_error(error: Exception) -> dict[str, Any]:
    """Classify from status/type/structured codes without copying error text."""
    response = getattr(error, "response", None)
    status = getattr(error, "status_code", getattr(response, "status_code", None))
    if not isinstance(status, int) or isinstance(status, bool):
        status = None
    names = {base.__name__.lower() for base in type(error).__mro__}
    body = _structured_body(error)
    nested = body.get("error") if isinstance(body.get("error"), Mapping) else body
    code = nested.get("code", body.get("code"))
    permanent_codes = {"invalid_api_key", "insufficient_quota", "invalid_request_error", "model_not_found", "unsupported_provider", "configuration_error"}
    if isinstance(code, str) and code in permanent_codes or status in (400, 401, 403, 404, 405, 422, 501, 505) or names & {"authenticationerror", "permissiondeniederror", "badrequesterror", "invalidrequesterror", "notfounderror", "unsupportedparamserror", "configurationerror", "valueerror", "typeerror"}:
        category, retryable = "configuration_error", False
    elif status == 429 or "ratelimiterror" in names:
        category, retryable = "rate_limit", True
    elif status == 408 or names & {"timeouterror", "timeout", "apitimeouterror", "readtimeout", "connecttimeout"}:
        category, retryable = "request_timeout", True
    elif status is not None and 500 <= status <= 599 or names & {"connectionerror", "apiconnectionerror", "connecterror", "readerror", "remoteprotocolerror"}:
        category, retryable = "transport_error", True
    else:
        category, retryable = "runtime_error", False
    return {"category": category, "retryable": retryable, "httpStatus": status}


def _classify_attempt_failure(error, diagnostic, trusted_http):
    candidate = (trusted_http is not None and trusted_http["responseStatus"] == 408
        and diagnostic["sdkReportedStatus"] == 400 and diagnostic["exceptionClass"] == "BadRequestError")
    if not candidate:
        return classify_model_error(error)
    try:
        classification = classify_model_error(error)
    except Exception:
        # Only this trusted mismatch candidate gains a fail-closed fallback;
        # the public/unguarded classifier retains its previous behavior.
        return {"category": "configuration_error", "retryable": False, "httpStatus": 400}
    # Pinned LiteLLM can map an actual HTTP 408 to SDK 400/BadRequestError.
    # Only the trusted, closed attempt receipt can correct that mismatch.
    # A sanitized null diagnostic code is NOT proof that the raw code is absent.
    try:
        # Unlike the legacy classifier's best-effort fallback, this opt-in
        # correction requires readable raw structure. Unknown is not absent.
        body = getattr(error, "body", None)
        if body is None:
            response = getattr(error, "response", None)
            body = response.json() if response is not None else None
        if type(body) is not dict or "error" in body and type(body["error"]) is not dict:
            return classification
        nested = body.get("error", body)
        codes = (nested.get("code"), body.get("code"), getattr(error, "code", None))
        types = (nested.get("type"), body.get("type"), getattr(error, "type", None))
        eligible = (all(code is None for code in codes)
            and all(value is None or type(value) is str and value in ("invalid_request_error", "server_error") for value in types))
    except Exception:
        eligible = False
    if eligible:
        return {"category": "request_timeout", "retryable": True, "httpStatus": 408,
            "classificationSource": "trusted_http_guard", "httpStatusSource": "trusted_http_guard",
            "httpGuardClosedRecordSha256": trusted_http["closedRecordSha256"]}
    return classification


def _safe_usage(result: Any) -> dict[str, Any]:
    """Token counters only; absent/invalid usage is unknown, never inferred."""
    try:
        usage = result.get("usage") if isinstance(result, Mapping) else getattr(result, "usage", None)
        safe = {}
        for target, aliases in (("inputTokens", ("prompt_tokens", "input_tokens")),
                                ("outputTokens", ("completion_tokens", "output_tokens")),
                                ("totalTokens", ("total_tokens",))):
            for name in aliases:
                value = usage.get(name) if isinstance(usage, Mapping) else getattr(usage, name, None)
                if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991:
                    safe[target] = value
                    break
        return {"usageAvailable": bool(safe), **({"usage": safe} if safe else {})}
    except Exception:
        return {"usageAvailable": False}


def _safe_output_hash(result: Any) -> str:
    """Hash the provider result without placing response text in telemetry."""
    try:
        if isinstance(result, bytes):
            payload = result
        elif isinstance(result, str):
            payload = result.encode("utf-8", errors="strict")
        else:
            model_dump = getattr(result, "model_dump", None)
            value = model_dump() if callable(model_dump) else result
            payload = json.dumps(value, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":"), default=str).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()
    except Exception:
        # A successful SDK response still receives a deterministic redacted
        # identity even when its object is not JSON serializable.
        return hashlib.sha256(repr(result).encode("utf-8", errors="replace")).hexdigest()


def _effective_request_timeout(policy: ModelRetryPolicy, request_summary: Mapping[str, Any]) -> float:
    """Give larger provider payloads a bounded response budget.

    This is transport policy, not task logic: a long conversation plus the
    complete tool registry can legitimately take longer to serialize and
    generate. Small requests retain the configured timeout; large requests
    scale up to five minutes, while retry/backoff and the outer process budget
    remain authoritative.
    """
    content = request_summary.get("contentUtf8Bytes")
    tools = request_summary.get("toolDefinitionsUtf8Bytes")
    if not isinstance(content, int) or not isinstance(tools, int) or content < 0 or tools < 0:
        return policy.request_timeout_seconds
    payload_bytes = content + tools
    scaled = 60.0 + math.ceil(payload_bytes / 20_000) * 15.0
    return min(300.0, max(policy.request_timeout_seconds, scaled))


def _response_content(result: Any) -> str | None:
    try:
        choices = getattr(result, "choices", None)
        message = getattr(choices[0], "message", None) if choices else None
        content = getattr(message, "content", None)
        return content if isinstance(content, str) else None
    except Exception:
        return None


def _marker_summary(value: Any, expected: tuple[str, str] | None = None) -> dict[str, Any]:
    text = value if isinstance(value, str) else ""
    upper = {
        "true": "[[True]]" in text, "false": "[[False]]" in text,
        "success": "[[Success]]" in text, "failure": "[[Failure]]" in text,
    }
    lower = {
        "true": "[[true]]" in text, "false": "[[false]]" in text,
        "success": "[[success]]" in text, "failure": "[[failure]]" in text,
    }
    parsed = None
    if expected is not None and all(isinstance(item, str) for item in expected):
        parsed = sum(text.count(item) for item in expected) == 1
    return {"upper": upper, "lower": lower, "parseStatus": "parsed" if parsed is True else "unparsed" if parsed is False else "unknown"}


def _take_judge_request_context() -> dict[str, Any] | None:
    value = _JUDGE_REQUEST_CONTEXT.get()
    _JUDGE_REQUEST_CONTEXT.set(None)
    return value if isinstance(value, dict) else None


def _normalize_boolean_markers(value: Any, success_marker: Any, failure_marker: Any) -> tuple[Any, bool]:
    """Case-fold one unambiguous Boolean marker for the frozen checker.

    The official checker compares literal marker strings. Normalize only the
    exact Boolean protocol tokens, only when exactly one Boolean token is
    present, and only when the checker is configured with corresponding
    Boolean markers. Ambiguous responses and non-Boolean checkers remain
    untouched.
    """
    if not isinstance(value, str) or not isinstance(success_marker, str) or not isinstance(failure_marker, str):
        return value, False
    if (success_marker.lower() != "[[true]]" or failure_marker.lower() != "[[false]]"):
        return value, False
    matches = list(_BOOLEAN_MARKER_PATTERN.finditer(value))
    if len(matches) != 1:
        return value, False
    target = success_marker if matches[0].group(1).lower() == "true" else failure_marker
    normalized = value[:matches[0].start()] + target + value[matches[0].end():]
    return normalized, normalized != value


class _CaseFoldedJudge:
    """Temporary proxy that normalizes only the response seen by LLMChecker."""

    def __init__(self, delegate: Callable[..., Any], success_marker: Any,
                 failure_marker: Any, emit: Callable[..., None]):
        self._delegate = delegate
        self._success_marker = success_marker
        self._failure_marker = failure_marker
        self._emit = emit

    def __call__(self, user_prompt_args):
        response = self._delegate(user_prompt_args)
        normalized, transformed = _normalize_boolean_markers(
            response, self._success_marker, self._failure_marker)
        context = _JUDGE_LAST_RESPONSE_CONTEXT.get()
        _JUDGE_LAST_RESPONSE_CONTEXT.set(None)
        if transformed:
            event = {
                "modelRole": "judge",
                "checkerPath": _JUDGE_CHECKER_PATH,
                "rawResponseHash": _safe_output_hash(response),
                "normalizedResponseHash": _safe_output_hash(normalized),
                "caseFoldBooleanMarkers": True,
                "normalization": "boolean_marker_casefold_v1",
            }
            if isinstance(context, dict):
                event.update({key: context[key] for key in ("requestId", "requestAttempt")
                              if key in context})
            self._emit("judge_protocol_normalized", **event)
        return normalized


def _install_judge_provenance_observer(emit: Callable[..., None]) -> None:
    """Observe frozen ARE checker boundaries without editing ARE files."""
    try:
        module = importlib.import_module("are.simulation.validation.utils.llm_utils")
        function_class = module.LLMFunction
        checker_class = module.LLMChecker
        if not getattr(function_class, "_gaia2_provenance_wrapped", False):
            original_function_call = function_class.__call__

            @functools.wraps(original_function_call)
            def observed_function_call(self, user_prompt_args):
                response = original_function_call(self, user_prompt_args)
                context = _take_judge_request_context()
                _JUDGE_LAST_RESPONSE_CONTEXT.set(context)
                expected = _JUDGE_EXPECTED_MARKERS.get()
                if context is not None:
                    checker = _marker_summary(response, expected)
                    raw = context.get("rawMarkers") if isinstance(context.get("rawMarkers"), dict) else {}
                    conflict = any(raw.get("upper", {}).get(name) and checker.get("lower", {}).get(name)
                                   and not checker.get("upper", {}).get(name) for name in ("true", "false"))
                    emit("judge_response_observed", modelRole="judge", requestId=context["requestId"],
                         requestAttempt=context["requestAttempt"], rawResponseHash=context["rawResponseHash"],
                         checkerResponseHash=_safe_output_hash(response), rawMarkers=raw,
                         checkerMarkers=checker, parseStatus=checker["parseStatus"],
                         markerConflict=conflict, checkerPath=_JUDGE_CHECKER_PATH)
                return response

            function_class.__call__ = observed_function_call
            function_class._gaia2_provenance_wrapped = True
        if not getattr(checker_class, "_gaia2_provenance_wrapped", False):
            original_checker_call = checker_class.__call__

            @functools.wraps(original_checker_call)
            def observed_checker_call(self, user_prompt_args):
                expected = (getattr(self, "success_str", ""), getattr(self, "failure_str", ""))
                token = _JUDGE_EXPECTED_MARKERS.set(expected)
                original_judge = self.judge
                self.judge = _CaseFoldedJudge(original_judge, expected[0], expected[1], emit)
                try:
                    return original_checker_call(self, user_prompt_args)
                finally:
                    self.judge = original_judge
                    _JUDGE_EXPECTED_MARKERS.reset(token)

            checker_class.__call__ = observed_checker_call
            checker_class._gaia2_provenance_wrapped = True
    except Exception:
        # A missing/changed optional checker is an unknown-provenance case;
        # never turn observer installation into a model or task failure.
        return


def wrap_completion(
    completion: Callable[..., Any],
    role: str,
    emit: Callable[..., None],
    *,
    policy: ModelRetryPolicy | None = None,
    clock: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> Callable[..., Any]:
    """Wrap one model request; caller-side tool execution is never in scope."""
    if role not in ("actor", "judge", "correction"):
        raise ValueError("model retry role must be actor, judge or correction")
    if getattr(completion, "_gaia2_model_retry", False):
        return completion

    @functools.wraps(completion)
    def call(*args: Any, **kwargs: Any) -> Any:
        active = policy or ModelRetryPolicy.from_environment()
        request_id = uuid.uuid4().hex
        _JUDGE_REQUEST_CONTEXT.set(None)
        waited = 0.0
        # LiteLLM retry and its underlying OpenAI client retry must both be off.
        kwargs.update(num_retries=0, max_retries=0, retry_policy=None, context_window_fallback_dict={}, fallbacks=[], drop_params=False, timeout=active.request_timeout_seconds)
        request_summary = safe_request_summary(kwargs)
        kwargs["timeout"] = _effective_request_timeout(active, request_summary)
        for attempt in range(1, active.max_attempts + 1):
            operational = {"modelRole": role, "requestId": request_id, "requestAttempt": attempt, "maxRequestAttempts": active.max_attempts, "cumulativeWaitSeconds": waited}
            emit("model_request_attempt", **operational, requestSummary=request_summary)
            failure_receipt = _AttemptFailureReceipt(role, request_id, attempt)
            try:
                result = guarded_sdk_attempt(completion, role, request_id, attempt,
                    args=args, kwargs=kwargs, _failure_receipt=failure_receipt)
            except Exception as error:
                diagnostic = safe_model_diagnostics(error, request_summary)
                trusted_http = failure_receipt.consume(error, role, request_id, attempt)
                classification = _classify_attempt_failure(error, diagnostic, trusted_http)
                now = clock()
                if trusted_http is not None and trusted_http["responseStatus"] == 408 and not classification["retryable"]:
                    # Failed/unknown raw metadata already denied correction.
                    # No retry is possible, so do not re-read it for cooldowns.
                    hint, hint_source = None, None
                else:
                    hint, hint_source = retry_delay_hint(error, now)
            else:
                if role == "judge":
                    context = {"requestId": request_id, "requestAttempt": attempt,
                               "rawResponseHash": _safe_output_hash(result),
                               "rawMarkers": _marker_summary(_response_content(result))}
                    _JUDGE_REQUEST_CONTEXT.set(context)
                emit("model_request_succeeded", **operational, outputHash=_safe_output_hash(result), **_safe_usage(result))
                return result
            # Leave the SDK exception handler before waiting: cancellation or a
            # logging failure must not inherit a raw credential-bearing cause.
            backoff = min(active.backoff_max_seconds, active.backoff_base_seconds * 2 ** min(attempt - 1, 30))
            delay = max(backoff, hint or 0.0)
            next_retry_at = _iso(now + delay) if classification["retryable"] else None
            exhausted = attempt >= active.max_attempts or waited + delay > active.max_retry_wait_seconds
            metadata = {**operational, **classification, "nextRetryAt": next_retry_at, "retryExhausted": bool(exhausted and classification["retryable"]), "diagnostic": diagnostic}
            emit("model_request_failed", **metadata)
            if not classification["retryable"] or exhausted:
                raise ModelRequestFailure(metadata) from None
            emit("model_retry_scheduled", **metadata, waitSeconds=delay, delaySource=hint_source if hint is not None and hint >= backoff else "exponential_backoff", cumulativeWaitSecondsAfterRetry=waited + delay)
            remaining = delay
            # Keep cancellation responsive and make long cooldowns observable.
            while remaining > 0:
                chunk = min(remaining, 30.0)
                sleep(chunk)
                waited += chunk
                remaining = max(0.0, remaining - chunk)
                if remaining > 0:
                    emit("model_retry_waiting", **{**operational, "cumulativeWaitSeconds": waited}, nextRetryAt=next_retry_at, remainingWaitSeconds=remaining)
        raise AssertionError("unreachable model retry state")

    call._gaia2_model_retry = True  # type: ignore[attr-defined]
    return call


def install_model_retries(emit: Callable[..., None], *, actor_completion: Callable[..., Any] | None = None) -> Callable[..., Any]:
    """Install exact ARE completion aliases, without touching ARE source files."""
    import litellm

    # Pinned LiteLLM's synchronous wrapper uses `num_retries or global_value`,
    # so a per-call zero alone does not disable a configured global retry.
    litellm.num_retries = 0
    litellm.drop_params = False

    # The pinned ARE judge constructs LiteLLMEngine from this module.  Replacing
    # litellm.completion alone would miss its existing imported function alias.
    engine = importlib.import_module("are.simulation.agents.llm.litellm.litellm_engine")
    engine.completion = wrap_completion(engine.completion, "judge", emit)
    _install_judge_provenance_observer(emit)
    actor = actor_completion or litellm.completion
    return wrap_completion(actor, "actor", emit)
