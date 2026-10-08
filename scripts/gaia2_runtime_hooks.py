"""Authenticated loopback IPC for the live Capybara plugin host.

The bridge waits for every hook receipt.  A missing host, invalid receipt or
transport failure is a technical failure, never permission to execute a tool.
No proxy, DNS lookup, redirect, credential or raw transport error is exposed.
"""

from __future__ import annotations

import json
import hashlib
import math
import os
import re
from typing import Any
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class HookProtocolError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(f"GAIA2 live hook rejected: {code}")


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise HookProtocolError("redirect_not_allowed")


def _object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise HookProtocolError("duplicate_response_key")
        result[key] = value
    return result


class RuntimeHookClient:
    def __init__(self, *, url: str | None = None, token: str | None = None,
                 execution_id: str | None = None, session_id: str | None = None,
                 timeout_seconds: float | None = None):
        self.url = url if url is not None else os.environ.get("GAIA2_HOOK_URL")
        self.token = token if token is not None else os.environ.get("GAIA2_HOOK_TOKEN")
        self.execution_id = execution_id if execution_id is not None else os.environ.get("GAIA2_EXECUTION_ID")
        self.session_id = session_id if session_id is not None else os.environ.get("GAIA2_SESSION_ID")
        try:
            timeout = timeout_seconds if timeout_seconds is not None else float(os.environ.get("GAIA2_HOOK_TIMEOUT_SECONDS", "30"))
            parsed = urlsplit(self.url or "")
            port = parsed.port
        except (ValueError, TypeError):
            raise HookProtocolError("invalid_host_configuration") from None
        if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1")
                or not port or parsed.username or parsed.password or parsed.path != "/invoke"
                or parsed.query or parsed.fragment):
            raise HookProtocolError("loopback_host_required")
        if (not isinstance(self.token, str) or not self.token.strip()
                or any(ord(c) < 32 or ord(c) >= 127 for c in self.token)):
            raise HookProtocolError("host_token_required")
        if any(not isinstance(value, str) or not value.strip() for value in (self.execution_id, self.session_id)):
            raise HookProtocolError("execution_identity_required")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise HookProtocolError("invalid_host_timeout")
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), _NoRedirects())

    def invoke(self, checkpoint: str, **payload: Any) -> dict[str, Any]:
        if checkpoint not in ("before_model", "before_tool", "after_tool", "attempt_end"):
            raise HookProtocolError("invalid_checkpoint")
        envelope = {**payload, "executionId": self.execution_id, "sessionId": self.session_id, "checkpoint": checkpoint}
        try:
            body = json.dumps(envelope, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except (ValueError, TypeError):
            raise HookProtocolError("invalid_request_payload") from None
        request = Request(self.url, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {self.token}",
        })
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                if response.status != 200:
                    raise HookProtocolError("host_http_failure")
                raw = response.read(8 * 1024 * 1024 + 1)
        except HookProtocolError:
            raise
        except Exception:
            raise HookProtocolError("host_transport_failure") from None
        if len(raw) > 8 * 1024 * 1024:
            raise HookProtocolError("host_response_too_large")
        try:
            result = json.loads(raw.decode("utf-8"), object_pairs_hook=_object_pairs,
                                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except HookProtocolError:
            raise
        except (UnicodeError, ValueError, TypeError):
            raise HookProtocolError("invalid_host_json") from None
        return self.validate_response(result)

    @staticmethod
    def validate_response(result: Any) -> dict[str, Any]:
        if not isinstance(result, dict):
            raise HookProtocolError("invalid_host_response")
        decision = result.get("decision")
        if not isinstance(decision, dict) or decision.get("action") not in ("allow", "block", "read_back"):
            raise HookProtocolError("invalid_host_decision")
        if not isinstance(decision.get("reason"), str) or not decision["reason"]:
            raise HookProtocolError("decision_reason_required")
        if "context" not in result or not isinstance(result["context"], str):
            raise HookProtocolError("context_required")
        for field in ("contextHash", "variablesHash"):
            if not isinstance(result.get(field), str) or re.fullmatch(r"[0-9a-f]{64}", result[field]) is None:
                raise HookProtocolError("invalid_receipt_hash")
        if result["contextHash"] != hashlib.sha256(result["context"].encode("utf-8")).hexdigest():
            raise HookProtocolError("context_hash_mismatch")
        if not isinstance(result.get("hookReceipts"), list) or not result["hookReceipts"]:
            raise HookProtocolError("hook_receipt_required")
        revision = result.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise HookProtocolError("invalid_host_revision")
        if not isinstance(result.get("evidencePath"), str) or not result["evidencePath"]:
            raise HookProtocolError("evidence_path_required")
        return result
