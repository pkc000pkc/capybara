"""Small trusted primitives for the 5.2c2.3 deadline/notification slice.

The official ARE clock and a request's operating-system deadline are different
clocks.  ``ScopedOSDeadline`` owns a private monotonic clock and only answers
whether a request may continue.  It never reads ``TimeManager`` and therefore
cannot turn a paused simulation into extra wall-clock budget.

``ScopedArrivedNotificationProjection`` is a parent-owned, in-memory
projection.  A trusted producer supplies a scope, an arrival sequence and an
official ARE ``Message``.  The projection exposes only messages whose
simulation timestamp has arrived for its one fixed scope.  It does not read or
consume the official notification queue.  Conflicting identities and stale
sequences fail closed with fixed error codes.

These classes intentionally do not call a provider, modify ARE, or implement
the parent routing policy.  They are the pieces a later runner/parent owner can
bind after its gate has authenticated the real scope.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from are.simulation.notification_system import Message, MessageType


SCHEMA_DEADLINE = "gaia2-scoped-os-deadline-v1"
SCHEMA_PROJECTION = "gaia2-scoped-arrived-notification-projection-v1"


class DeadlineNotificationError(RuntimeError):
    """Fixed safe codes; timing/message contents are never exception text."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _fail(code: str) -> None:
    raise DeadlineNotificationError(code) from None


def _finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def _identifier(value: Any, code: str) -> str:
    try:
        valid = type(value) is str and bool(value) and len(value.encode("utf-8")) <= 512
    except (UnicodeError, TypeError):
        valid = False
    if not valid:
        _fail(code)
    return value


def _safe_now(value: Any) -> float:
    if not _finite(value) or value < 0:
        _fail("NOTIFICATION_CLOCK_INVALID")
    return float(value)


def _json_value(value: Any, *, depth: int = 0) -> Any:
    """Admit only bounded JSON primitives for message identity."""
    if depth > 64:
        _fail("NOTIFICATION_MESSAGE_INVALID")
    kind = type(value)
    if value is None or kind in (bool, int, str):
        if kind is str:
            try:
                value.encode("utf-8", errors="strict")
            except UnicodeError:
                _fail("NOTIFICATION_MESSAGE_INVALID")
        return value
    if kind is float:
        if not math.isfinite(value):
            _fail("NOTIFICATION_MESSAGE_INVALID")
        return value
    if kind is list:
        return [_json_value(item, depth=depth + 1) for item in value]
    if kind is dict:
        result = {}
        for key, child in value.items():
            if type(key) is not str:
                _fail("NOTIFICATION_MESSAGE_INVALID")
            result[key] = _json_value(child, depth=depth + 1)
        return result
    _fail("NOTIFICATION_MESSAGE_INVALID")


def _message_json(message: Message) -> str:
    """Return a deterministic, bounded representation for message identity."""
    if type(message) is not Message or type(message.message_type) is not MessageType:
        _fail("NOTIFICATION_MESSAGE_INVALID")
    if type(message.message) is not str:
        _fail("NOTIFICATION_MESSAGE_INVALID")
    if not isinstance(message.timestamp, datetime):
        _fail("NOTIFICATION_MESSAGE_INVALID")
    if not isinstance(message.attachments, list):
        _fail("NOTIFICATION_MESSAGE_INVALID")
    attachments: list[Any] = []
    for attachment in message.attachments:
        try:
            # Official Attachment is a pydantic model.  Only its JSON-mode
            # primitive projection is admitted; arbitrary objects are not an
            # identity source.
            if hasattr(attachment, "model_dump"):
                value = attachment.model_dump(mode="json")
            elif type(attachment) is dict:
                value = copy.deepcopy(attachment)
            else:
                _fail("NOTIFICATION_MESSAGE_INVALID")
            attachments.append(_json_value(value))
        except DeadlineNotificationError:
            raise
        except BaseException:
            _fail("NOTIFICATION_MESSAGE_INVALID")
    value = {"messageType": message.message_type.value, "message": message.message,
             "timestamp": message.timestamp.isoformat(), "attachments": attachments}
    try:
        encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                             separators=(",", ":"))
    except (TypeError, ValueError, UnicodeError):
        _fail("NOTIFICATION_MESSAGE_INVALID")
    if len(encoded.encode("utf-8")) > 4 * 1024 * 1024:
        _fail("NOTIFICATION_MESSAGE_TOO_LARGE")
    return encoded


def message_hash(message: Message) -> str:
    """Hash only the official message fields admitted by the projection."""
    return hashlib.sha256(_message_json(message).encode("utf-8")).hexdigest()


class ScopedOSDeadline:
    """A request-local deadline measured only by an injected OS monotonic clock.

    The callback is captured once and every reading is checked for finite,
    non-decreasing values.  A bad clock is sticky: restoring the callback's
    value cannot reopen a request after the trusted observation failed.
    """

    def __init__(self, *, scope_id: str, duration_seconds: float,
                 monotonic_clock: Callable[[], float] = time.monotonic):
        self.__scope_id = _identifier(scope_id, "DEADLINE_SCOPE_INVALID")
        if not _finite(duration_seconds) or duration_seconds < 0:
            _fail("DEADLINE_DURATION_INVALID")
        if not callable(monotonic_clock):
            _fail("DEADLINE_CLOCK_INVALID")
        self.__clock = monotonic_clock
        self.__duration = float(duration_seconds)
        self.__failed = False
        self.__expired = False
        self.__last: float | None = None
        self.__last_stage: str | None = None
        self.__lock = threading.RLock()
        started = self.__read("start")
        deadline = started + self.__duration
        if not math.isfinite(deadline):
            self.__failed = True
            _fail("DEADLINE_CLOCK_INVALID")
        self.__started = started
        self.__deadline = deadline

    @property
    def scope_id(self) -> str:
        return self.__scope_id

    @property
    def duration_seconds(self) -> float:
        return self.__duration

    def __read(self, stage: str) -> float:
        if self.__failed:
            _fail("OS_DEADLINE_INVALID")
        try:
            value = self.__clock()
        except BaseException:
            self.__failed = True
            _fail("OS_DEADLINE_INVALID")
        if not _finite(value):
            self.__failed = True
            _fail("OS_DEADLINE_INVALID")
        value = float(value)
        if self.__last is not None and value < self.__last:
            self.__failed = True
            _fail("OS_DEADLINE_INVALID")
        self.__last = value
        self.__last_stage = stage
        return value

    def remaining(self, *, stage: str = "observe") -> float:
        """Return non-negative seconds; zero means the deadline is reached."""
        if type(stage) is not str or not stage or len(stage.encode("utf-8")) > 256:
            _fail("DEADLINE_STAGE_INVALID")
        with self.__lock:
            now = self.__read(stage)
            remaining = self.__deadline - now
            if not math.isfinite(remaining):
                self.__failed = True
                _fail("OS_DEADLINE_INVALID")
            if remaining <= 0:
                self.__expired = True
                return 0.0
            return float(remaining)

    def check(self, *, stage: str) -> float:
        """Authorize one stage and return its remaining OS seconds."""
        remaining = self.remaining(stage=stage)
        if remaining <= 0:
            _fail("OS_DEADLINE_EXPIRED")
        return remaining

    def snapshot(self) -> dict[str, Any]:
        with self.__lock:
            remaining = self.remaining(stage="snapshot")
            return {"schemaVersion": SCHEMA_DEADLINE, "scopeId": self.__scope_id,
                    "durationSeconds": self.__duration,
                    "elapsedSeconds": max(0.0, self.__duration - remaining),
                    "remainingSeconds": remaining, "expired": self.__expired,
                    "failed": self.__failed, "lastStage": self.__last_stage}


@dataclass(frozen=True)
class ProjectedNotification:
    scope_id: str
    notification_id: str
    sequence: int
    arrived_at: float
    message_hash: str
    message: Message


@dataclass
class _NotificationRecord:
    projection: ProjectedNotification
    delivered: bool = False


class ScopedArrivedNotificationProjection:
    """One scope's arrived-message view, without queue ownership or mutation."""

    def __init__(self, *, scope_id: str):
        self.__scope_id = _identifier(scope_id, "NOTIFICATION_SCOPE_INVALID")
        self.__records: dict[str, _NotificationRecord] = {}
        self.__sequences: dict[int, str] = {}
        self.__last_sequence = 0
        self.__last_arrival: float | None = None
        self.__last_now: float | None = None
        self.__clock_failed = False
        self.__lock = threading.RLock()

    @property
    def scope_id(self) -> str:
        return self.__scope_id

    def __now(self, value: Any) -> float:
        if self.__clock_failed:
            _fail("NOTIFICATION_CLOCK_INVALID")
        now = _safe_now(value)
        if self.__last_now is not None and now < self.__last_now:
            self.__clock_failed = True
            _fail("NOTIFICATION_CLOCK_INVALID")
        self.__last_now = now
        return now

    def ingest(self, *, scope_id: str, notification_id: str, sequence: int,
               arrived_at: float, message: Message) -> bool:
        """Add one trusted producer record; return False for exact duplicates."""
        if scope_id != self.__scope_id:
            _fail("NOTIFICATION_SCOPE_MISMATCH")
        _identifier(notification_id, "NOTIFICATION_ID_INVALID")
        if type(sequence) is not int or sequence < 1:
            _fail("NOTIFICATION_SEQUENCE_INVALID")
        if not _finite(arrived_at) or arrived_at < 0:
            _fail("NOTIFICATION_ARRIVAL_INVALID")
        arrival = float(arrived_at)
        digest = message_hash(message)
        with self.__lock:
            existing = self.__records.get(notification_id)
            if existing is not None:
                old = existing.projection
                if (old.scope_id, old.sequence, old.arrived_at, old.message_hash) == (
                        self.__scope_id, sequence, arrival, digest):
                    return False
                _fail("NOTIFICATION_CONFLICT")
            prior_id = self.__sequences.get(sequence)
            if prior_id is not None and prior_id != notification_id:
                _fail("NOTIFICATION_SEQUENCE_CONFLICT")
            if sequence <= self.__last_sequence:
                _fail("NOTIFICATION_STALE")
            if self.__last_arrival is not None and arrival < self.__last_arrival:
                _fail("NOTIFICATION_STALE")
            if self.__last_now is not None and arrival < self.__last_now:
                # Once this scope has observed a simulation timestamp, a
                # newly arriving older sequence is stale.  Accepting it would
                # make a late producer replay appear current.
                _fail("NOTIFICATION_STALE")
            try:
                copied = copy.deepcopy(message)
            except BaseException:
                _fail("NOTIFICATION_MESSAGE_INVALID")
            projection = ProjectedNotification(self.__scope_id, notification_id,
                sequence, arrival, digest, copied)
            self.__records[notification_id] = _NotificationRecord(projection)
            self.__sequences[sequence] = notification_id
            self.__last_sequence = sequence
            self.__last_arrival = arrival
            return True

    def __project(self, *, are_now: float, consume: bool,
                  limit: int | None = None) -> tuple[ProjectedNotification, ...]:
        now = self.__now(are_now)
        if limit is not None and (type(limit) is not int or limit < 1):
            _fail("NOTIFICATION_LIMIT_INVALID")
        result: list[ProjectedNotification] = []
        for record in sorted(self.__records.values(), key=lambda item: item.projection.sequence):
            if record.delivered or record.projection.arrived_at > now:
                continue
            result.append(ProjectedNotification(record.projection.scope_id,
                record.projection.notification_id, record.projection.sequence,
                record.projection.arrived_at, record.projection.message_hash,
                copy.deepcopy(record.projection.message)))
            if consume:
                record.delivered = True
            if limit is not None and len(result) >= limit:
                break
        return tuple(result)

    def project(self, *, are_now: float) -> tuple[ProjectedNotification, ...]:
        """Return arrived messages without consuming the parent-owned records."""
        with self.__lock:
            return self.__project(are_now=are_now, consume=False)

    def drain(self, *, are_now: float, limit: int | None = None) -> tuple[ProjectedNotification, ...]:
        """Consume only arrived messages from this projection."""
        with self.__lock:
            return self.__project(are_now=are_now, consume=True, limit=limit)

    def snapshot(self, *, are_now: float) -> dict[str, Any]:
        """Safe view; future payloads remain absent from the projection."""
        with self.__lock:
            visible = self.__project(are_now=are_now, consume=False)
            visible_ids = {item.notification_id for item in visible}
            pending = sum(1 for item in self.__records.values()
                          if not item.delivered and item.projection.notification_id not in visible_ids)
            return {"schemaVersion": SCHEMA_PROJECTION, "scopeId": self.__scope_id,
                    "lastSequence": self.__last_sequence,
                    "visibleCount": len(visible), "futureCount": pending,
                    "notifications": [{"notificationId": item.notification_id,
                                       "sequence": item.sequence, "arrivedAt": item.arrived_at,
                                       "messageHash": item.message_hash,
                                       "message": copy.deepcopy(item.message)} for item in visible]}
