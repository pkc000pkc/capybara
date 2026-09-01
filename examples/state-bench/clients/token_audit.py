from __future__ import annotations

import json
import os
import threading
import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator, Mapping

_AUDIT_CONTEXT: ContextVar[dict[str, Any]] = ContextVar("state_bench_token_audit_context", default={})
_TOKEN_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)


@contextmanager
def token_audit_context(**metadata: Any) -> Iterator[None]:
    """Attach task metadata to every model request made in this context."""
    current = dict(_AUDIT_CONTEXT.get())
    current.update({key: value for key, value in metadata.items() if value is not None})
    token = _AUDIT_CONTEXT.set(current)
    try:
        yield
    finally:
        _AUDIT_CONTEXT.reset(token)


def extract_response_usage(response: Any) -> dict[str, int] | None:
    """Normalize Responses API usage without estimating missing provider data."""
    usage = getattr(response, "usage", None)
    if usage is None:
        return None
    input_details = getattr(usage, "input_tokens_details", None)
    output_details = getattr(usage, "output_tokens_details", None)
    return {
        "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
        "cached_input_tokens": int(getattr(input_details, "cached_tokens", 0) or 0),
        "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
        "reasoning_output_tokens": int(getattr(output_details, "reasoning_tokens", 0) or 0),
        "total_tokens": int(getattr(usage, "total_tokens", 0) or 0),
    }


def _request_kind(kwargs: Mapping[str, Any]) -> str:
    if kwargs.get("tools"):
        return "tools"
    text = kwargs.get("text")
    if isinstance(text, Mapping):
        response_format = text.get("format")
        if isinstance(response_format, Mapping) and response_format.get("type") == "json_object":
            return "json"
    return "chat"


def _empty_totals() -> dict[str, int]:
    return {
        "requests": 0,
        "successful_requests": 0,
        "failed_requests": 0,
        "requests_without_usage": 0,
        **{field: 0 for field in _TOKEN_FIELDS},
    }


class TokenAuditLedger:
    """Append-only, crash-resistant JSONL ledger for all provider requests."""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._write_lock = threading.Lock()
        self._sequence = max(
            (int(event.get("sequence", 0) or 0) for event in self.events()),
            default=0,
        )

    def record(
        self,
        *,
        role: str,
        requested_model: str,
        request_kind: str,
        elapsed_seconds: float,
        response: Any | None = None,
        error: BaseException | None = None,
    ) -> dict[str, Any]:
        context = dict(_AUDIT_CONTEXT.get())
        usage = extract_response_usage(response) if response is not None else None
        provider_status = getattr(response, "status", None)
        provider_failed = response is not None and provider_status not in (None, "completed")
        event: dict[str, Any] = {
            "schema_version": 1,
            "timestamp": datetime.now(UTC).isoformat(),
            **context,
            "role": role,
            "request_kind": request_kind,
            "requested_model": requested_model,
            "response_model": getattr(response, "model", None),
            "response_id": getattr(response, "id", None),
            "provider_request_id": (
                getattr(response, "_request_id", None)
                if response is not None
                else getattr(error, "request_id", None)
            ),
            "status": "error" if error is not None or provider_failed else "success",
            "provider_status": provider_status,
            "elapsed_seconds": round(elapsed_seconds, 6),
            "usage": usage,
        }
        if error is not None:
            event["error_type"] = type(error).__name__
            event["error_message"] = str(error)
            event["http_status"] = getattr(error, "status_code", None)
        elif provider_failed:
            incomplete_details = getattr(response, "incomplete_details", None)
            event["error_type"] = "IncompleteResponse"
            event["error_message"] = str(getattr(incomplete_details, "reason", None) or provider_status)

        serialized: str
        with self._write_lock:
            self._sequence += 1
            event["sequence"] = self._sequence
            serialized = json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n"
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(serialized)
                handle.flush()
                os.fsync(handle.fileno())
        return event

    def events(self) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        events: list[dict[str, Any]] = []
        lines = self.path.read_text(encoding="utf-8").splitlines()
        for index, line in enumerate(lines):
            if not line.strip():
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                if index == len(lines) - 1:
                    continue
                raise
            if isinstance(item, dict):
                events.append(item)
        return events

    def summarize(self, **filters: Any) -> dict[str, Any]:
        selected = [
            event
            for event in self.events()
            if all(event.get(key) == value for key, value in filters.items())
        ]
        total = _empty_totals()
        by_role: dict[str, dict[str, int]] = {}
        for event in selected:
            role = str(event.get("role") or "unknown")
            role_total = by_role.setdefault(role, _empty_totals())
            for target in (total, role_total):
                target["requests"] += 1
                status_field = "failed_requests" if event.get("status") == "error" else "successful_requests"
                target[status_field] += 1
            usage = event.get("usage")
            if not isinstance(usage, dict):
                total["requests_without_usage"] += 1
                role_total["requests_without_usage"] += 1
                continue
            for field in _TOKEN_FIELDS:
                value = int(usage.get(field, 0) or 0)
                total[field] += value
                role_total[field] += value
        return {
            "schema_version": 1,
            "ledger_path": self.path.as_posix(),
            **total,
            "by_role": dict(sorted(by_role.items())),
        }


class AuditedResponses:
    """Proxy around ``OpenAI.responses`` that observes every retry attempt."""

    def __init__(self, resource: Any, ledger: TokenAuditLedger, *, role: str, model: str):
        self._resource = resource
        self._ledger = ledger
        self._role = role
        self._model = model

    def create(self, **kwargs: Any) -> Any:
        started = time.monotonic()
        requested_model = str(kwargs.get("model") or self._model)
        kind = _request_kind(kwargs)
        try:
            response = self._resource.create(**kwargs)
        except BaseException as error:
            self._ledger.record(
                role=self._role,
                requested_model=requested_model,
                request_kind=kind,
                elapsed_seconds=time.monotonic() - started,
                error=error,
            )
            raise
        self._ledger.record(
            role=self._role,
            requested_model=requested_model,
            request_kind=kind,
            elapsed_seconds=time.monotonic() - started,
            response=response,
        )
        return response

    def __getattr__(self, name: str) -> Any:
        return getattr(self._resource, name)


class AuditedOpenAI:
    """Transparent OpenAI SDK proxy exposing an audited Responses resource."""

    def __init__(self, client: Any, ledger: TokenAuditLedger, *, role: str, model: str):
        self._client = client
        self.responses = AuditedResponses(client.responses, ledger, role=role, model=model)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)
