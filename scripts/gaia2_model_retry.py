"""Observable retries for model requests only, never ARE/tool execution.

Only safe operational fields leave this module.  Prompts, reference answers,
HTTP bodies, credentials, endpoint URLs and raw exception messages do not.
The official ARE source is left untouched; its imported completion alias is
patched before engines are constructed.
"""

from __future__ import annotations

import functools
import importlib
import math
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, Mapping


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
    if role not in ("actor", "judge"):
        raise ValueError("model retry role must be actor or judge")
    if getattr(completion, "_gaia2_model_retry", False):
        return completion

    @functools.wraps(completion)
    def call(*args: Any, **kwargs: Any) -> Any:
        active = policy or ModelRetryPolicy.from_environment()
        request_id = uuid.uuid4().hex
        waited = 0.0
        # LiteLLM retry and its underlying OpenAI client retry must both be off.
        kwargs.update(num_retries=0, max_retries=0, retry_policy=None, context_window_fallback_dict={}, fallbacks=[], drop_params=False, timeout=active.request_timeout_seconds)
        for attempt in range(1, active.max_attempts + 1):
            operational = {"modelRole": role, "requestId": request_id, "requestAttempt": attempt, "maxRequestAttempts": active.max_attempts, "cumulativeWaitSeconds": waited}
            emit("model_request_attempt", **operational)
            try:
                result = completion(*args, **kwargs)
            except Exception as error:
                classification = classify_model_error(error)
                now = clock()
                hint, hint_source = retry_delay_hint(error, now)
            else:
                emit("model_request_succeeded", **operational)
                return result
            # Leave the SDK exception handler before waiting: cancellation or a
            # logging failure must not inherit a raw credential-bearing cause.
            backoff = min(active.backoff_max_seconds, active.backoff_base_seconds * 2 ** min(attempt - 1, 30))
            delay = max(backoff, hint or 0.0)
            next_retry_at = _iso(now + delay) if classification["retryable"] else None
            exhausted = attempt >= active.max_attempts or waited + delay > active.max_retry_wait_seconds
            metadata = {**operational, **classification, "nextRetryAt": next_retry_at, "retryExhausted": bool(exhausted and classification["retryable"])}
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
    actor = actor_completion or litellm.completion
    return wrap_completion(actor, "actor", emit)
