"""Best-effort operational diagnostics, never raw requests or error messages.

SDK status and response objects are not transport observations: pinned LiteLLM
can synthesize both without HTTP dispatch. Unknown strings stay unknown.
This module has no network, logging, retry or request mutation capability.
"""

from __future__ import annotations

import json
from typing import Any


ERROR_CODES = frozenset({
    "invalid_api_key", "insufficient_quota", "invalid_request_error",
    "model_not_found", "unsupported_provider", "configuration_error",
    "context_length_exceeded", "invalid_service_tier", "rate_limit_exceeded",
    "server_is_overloaded", "credit_balance_exhausted",
    "organization_spend_limit_exceeded", "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded", "429",
})
ERROR_TYPES = frozenset({
    "invalid_request_error", "rate_limit_error", "insufficient_quota",
    "authentication_error", "permission_error", "server_error",
    "service_unavailable_error", "throttling_error",
})
EXCEPTION_CLASSES = frozenset({
    "BadRequestError", "APIStatusError", "AuthenticationError",
    "PermissionDeniedError", "NotFoundError", "UnprocessableEntityError",
    "RateLimitError", "InternalServerError", "APIConnectionError",
    "APITimeoutError", "Timeout", "ReadTimeout", "ConnectTimeout",
    "ConnectError", "ReadError", "RemoteProtocolError", "UnsupportedParamsError",
    "InvalidRequestError", "ConfigurationError", "ValueError", "TypeError",
    "TimeoutError", "ConnectionError",
})
ROLES = ("system", "developer", "user", "assistant", "tool", "function", "unknown")
MAX_SAFE_INTEGER = 9007199254740991
MAX_ITEMS = 10000


def _getattr(value: Any, key: str) -> Any:
    try:
        return getattr(value, key, None)
    except Exception:
        return None


def _enum(value: Any, allowed: frozenset[str]) -> str | None:
    return value if type(value) is str and value in allowed else None


def _count(value: Any) -> int | None:
    return value if type(value) is int and 0 <= value <= MAX_SAFE_INTEGER else None


def _sanitize_summary(value: Any) -> dict[str, Any]:
    source = value if type(value) is dict else {}
    roles = source.get("roles") if type(source.get("roles")) is dict else {}
    return {"messagesCount": _count(source.get("messagesCount")),
            "roles": {role: _count(roles.get(role)) for role in ROLES},
            **{key: _count(source.get(key)) for key in (
                "contentUtf8Bytes", "imageParts", "toolsCount", "toolDefinitionsUtf8Bytes")}}


def safe_request_summary(kwargs: Any) -> dict[str, Any]:
    """Count keyword request structure; bytes are not wire bytes or tokens.

    Do not traverse arbitrary iterables/getters, stringify unknown objects, or
    consume generators. A malformed/unsupported portion has null counters.
    """
    result = {"messagesCount": None, "roles": {role: None for role in ROLES},
              "contentUtf8Bytes": None, "imageParts": None, "toolsCount": None,
              "toolDefinitionsUtf8Bytes": None}
    if type(kwargs) is not dict:
        return result
    try:
        messages = kwargs.get("messages")
        if type(messages) in (list, tuple) and len(messages) <= MAX_ITEMS and all(type(m) is dict for m in messages):
            result["messagesCount"] = len(messages)
            roles = {role: 0 for role in ROLES}
            content_bytes, images, content_known = 0, 0, True
            for message in messages:
                role = message.get("role")
                roles[role if type(role) is str and role in roles else "unknown"] += 1
                content = message.get("content")
                if type(content) is str:
                    content_bytes += len(content.encode("utf-8"))
                elif content is None:
                    pass
                elif type(content) in (list, tuple) and len(content) <= MAX_ITEMS:
                    for part in content:
                        if type(part) is not dict:
                            content_known = False
                        elif part.get("type") in ("image_url", "input_image"):
                            images += 1
                        elif part.get("type") in ("text", "input_text", "output_text") and type(part.get("text")) is str:
                            content_bytes += len(part["text"].encode("utf-8"))
                        else:
                            content_known = False
                else:
                    content_known = False
            result["roles"] = roles
            result["contentUtf8Bytes"] = _count(content_bytes) if content_known else None
            result["imageParts"] = _count(images) if content_known else None
    except Exception:
        # Diagnostic failure must not change the request or its retry policy.
        result["contentUtf8Bytes"] = result["imageParts"] = None
    try:
        tools = kwargs.get("tools")
        if type(tools) in (list, tuple) and len(tools) <= MAX_ITEMS and all(type(t) is dict for t in tools):
            result["toolsCount"] = len(tools)
            encoded = json.dumps(tools, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            result["toolDefinitionsUtf8Bytes"] = _count(len(encoded))
    except Exception:
        result["toolDefinitionsUtf8Bytes"] = None
    return result


def safe_model_diagnostics(error: Exception, request_summary: dict[str, Any]) -> dict[str, Any]:
    """Only exact enums escape; code/type provenance is SDK, not HTTP proof."""
    result = {"schemaVersion": "gaia2-model-diagnostic-v1", "sdkReportedStatus": None,
              "dispatchObserved": None, "errorCode": None, "errorType": None,
              "codeSource": None, "typeSource": None, "exceptionClass": None,
              "requestSummary": _sanitize_summary(request_summary)}
    try:
        response = _getattr(error, "response")
        status = _getattr(error, "status_code")
        if status is None:
            status = _getattr(response, "status_code")
        if type(status) is int and 100 <= status <= 599:
            result["sdkReportedStatus"] = status
        for base in type(error).__mro__:
            name = _enum(base.__name__, EXCEPTION_CLASSES)
            if name is not None:
                result["exceptionClass"] = name
                break
        body, source = _getattr(error, "body"), "sdk_body"
        if type(body) is not dict:
            try:
                body = response.json() if response is not None else None
            except Exception:
                body = None
            source = "sdk_response_json"
        body = body if type(body) is dict else {}
        nested = body.get("error") if type(body.get("error")) is dict else body
        for key, target, provenance, allowed in (
            ("code", "errorCode", "codeSource", ERROR_CODES),
            ("type", "errorType", "typeSource", ERROR_TYPES),
        ):
            if key in nested:
                value, observed_source = nested[key], source
            elif key in body:
                value, observed_source = body[key], source
            else:
                value, observed_source = _getattr(error, key), "sdk_attribute"
            safe = _enum(value, allowed)
            result[target] = safe
            result[provenance] = observed_source if safe is not None else None
    except Exception:
        pass
    return result
