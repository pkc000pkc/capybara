"""Pure notification-directive normalization and evaluation.

The task-contract v1 protocol has one source-wide notificationPolicy.  This
module provides the versioned, channel/trigger/phase-aware primitive used by
the next protocol revision without changing the legacy wire format.  It has
no model, clock, filesystem, or native-tool dependencies.

An omitted directive list means the legacy/default allow policy.  A matching
deny always wins over matching allows; an expiry is active only while
``now < expiresAt`` so the exact deadline boundary remains compatible with
the existing ``forbid_until_deadline`` semantics.
"""
from __future__ import annotations

import math
from typing import Any, Iterable


DIRECTIVE_SCHEMA = "gaia2-notification-directive-v1"
MAX_DIRECTIVES = 64
CHANNELS = frozenset({"aui", "user_message", "environment", "a2a", "any"})
TRIGGERS = frozenset({"candidate", "deadline", "finish", "user_update", "environment_stop", "any"})
PHASES = frozenset({"before", "during", "after", "final", "any"})
DECISIONS = frozenset({"allow", "forbid"})
_FIELDS = frozenset({"channel", "trigger", "phase", "decision", "expiresAt"})


class NotificationDirectiveError(ValueError):
    """Raised when untrusted directives are malformed or contradictory."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or "NOTIFICATION_DIRECTIVE_" + code)


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def _specificity(value: str) -> int:
    return 0 if value == "any" else 1


def _sort_key(item: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(item[key] if item[key] is not None else "" for key in
                 ("channel", "trigger", "phase", "decision", "expiresAt"))


def normalize_directives(directives: Iterable[dict[str, Any]] | None,
                        *, deadline: float | None = None) -> list[dict[str, Any]]:
    """Validate, canonicalize and deterministically sort directives.

    ``deadline`` is an optional trusted source-bound upper bound.  A forbid
    expiry cannot extend beyond it.  Allow directives never carry an expiry.
    Duplicate canonical directives are rejected instead of silently merged.
    """
    if directives is None:
        return []
    if not isinstance(directives, list) or len(directives) > MAX_DIRECTIVES:
        raise NotificationDirectiveError("schema", "directive list is outside bounds")
    if deadline is not None and not _finite(deadline):
        raise NotificationDirectiveError("deadline", "trusted deadline is invalid")
    result: list[dict[str, Any]] = []
    for raw in directives:
        if not isinstance(raw, dict) or set(raw) != _FIELDS:
            raise NotificationDirectiveError("schema", "directive keys are not exact")
        values = {key: raw[key] for key in _FIELDS}
        if (values["channel"] not in CHANNELS or values["trigger"] not in TRIGGERS
                or values["phase"] not in PHASES or values["decision"] not in DECISIONS):
            raise NotificationDirectiveError("enum", "directive enum is invalid")
        expires = values["expiresAt"]
        if expires is not None:
            if values["decision"] != "forbid" or not _finite(expires):
                raise NotificationDirectiveError("expiry", "only a forbid may expire")
            if deadline is not None and expires > deadline:
                raise NotificationDirectiveError("expiry", "expiry exceeds trusted deadline")
        result.append({"channel": values["channel"], "trigger": values["trigger"],
                       "phase": values["phase"], "decision": values["decision"],
                       "expiresAt": expires})
    result.sort(key=_sort_key)
    if len(result) != len({tuple(_sort_key(item)) for item in result}):
        raise NotificationDirectiveError("duplicate", "duplicate directives are not allowed")
    return result


def legacy_directives(policy: str, *, deadline: float | None = None) -> list[dict[str, Any]]:
    """Convert the v1 scalar policy into canonical directives.

    Legacy ``allow`` is represented by an empty deny set, so a later narrow
    deny cannot be shadowed by a synthetic wildcard allow.
    """
    if policy == "allow":
        return []
    if policy == "forbid":
        expiry = None
    elif policy == "forbid_until_deadline" and _finite(deadline):
        expiry = deadline
    else:
        raise NotificationDirectiveError("legacy_policy", "invalid scalar policy or deadline")
    return normalize_directives([{"channel": "aui", "trigger": "any", "phase": "any",
                                  "decision": "forbid", "expiresAt": expiry}], deadline=deadline)


def _matches(item: dict[str, Any], channel: str, trigger: str, phase: str) -> bool:
    return ((item["channel"] in ("any", channel))
            and (item["trigger"] in ("any", trigger))
            and (item["phase"] in ("any", phase)))


def evaluate_directives(directives: Iterable[dict[str, Any]] | None, *,
                        channel: str = "aui", trigger: str = "finish",
                        phase: str = "final", now: float | None = None) -> dict[str, Any]:
    """Evaluate one notification decision without inferring business success."""
    if channel not in CHANNELS - {"any"} or trigger not in TRIGGERS - {"any"} or phase not in PHASES - {"any"}:
        raise NotificationDirectiveError("query", "evaluation query enum is invalid")
    if now is not None and not _finite(now):
        raise NotificationDirectiveError("query", "evaluation time is invalid")
    canonical = normalize_directives(directives)
    matched = []
    for index, item in enumerate(canonical):
        if not _matches(item, channel, trigger, phase):
            continue
        expiry = item["expiresAt"]
        if item["decision"] == "forbid" and expiry is not None and now is not None and now >= expiry:
            continue
        matched.append((index, item))
    denies = [(index, item) for index, item in matched if item["decision"] == "forbid"]
    # A deny wins on equal specificity.  Specificity is reported for auditing,
    # but does not permit a broad allow to override a narrow deny.
    ranked = sorted(matched, key=lambda pair: (_specificity(pair[1]["channel"])
                                                + _specificity(pair[1]["trigger"])
                                                + _specificity(pair[1]["phase"])), reverse=True)
    allowed = not denies
    return {"allowed": allowed, "matchedDirectiveIds": [index for index, _ in ranked],
            "blockingDirectiveIds": [index for index, _ in denies],
            "decision": "allow" if allowed else "forbid"}

