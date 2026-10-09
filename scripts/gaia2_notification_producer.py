"""Trusted parent-side notification origin binding for the GAIA2 child scope.

The official ARE ``Message`` has no origin or occurrence identifier.  This
module therefore deliberately does *not* infer authority from message text,
timestamp, or attachment content.  A trusted parent producer must bind an
origin to one immutable child scope and provide an occurrence id plus sequence
when publishing a message drained from the official queue.  The producer then
feeds the existing parent-owned projection and exposes only scoped readers.

No queue is read or consumed here.  Keeping queue ownership outside this
module makes the bridge/host integration an explicit later step instead of
silently granting a child access to the parent queue.
"""

from __future__ import annotations

import hashlib
import math
import threading
from dataclasses import dataclass
from typing import Any

from are.simulation.notification_system import Message, MessageType
from gaia2_deadline_notifications import (
    ProjectedNotification,
    ScopedArrivedNotificationProjection,
    message_hash,
)


SCHEMA_REGISTRY = "gaia2-scoped-notification-origin-registry-v1"
SCHEMA_RECEIPT = "gaia2-scoped-notification-publish-receipt-v1"


class NotificationProducerError(RuntimeError):
    """Fixed, non-sensitive producer failure codes."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _fail(code: str) -> None:
    raise NotificationProducerError(code) from None


def _identifier(value: Any, code: str) -> str:
    try:
        valid = type(value) is str and bool(value) and len(value.encode("utf-8")) <= 512
    except (UnicodeError, TypeError):
        valid = False
    if not valid:
        _fail(code)
    return value


def _finite_nonnegative(value: Any, code: str) -> float:
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        _fail(code)
    return float(value)


def _sequence(value: Any) -> int:
    if type(value) is not int or value < 1:
        _fail("NOTIFICATION_PRODUCER_SEQUENCE_INVALID")
    return value


@dataclass
class _OriginBinding:
    origin_id: str
    scope_id: str
    child_execution_id: str
    app_id: str
    projection: ScopedArrivedNotificationProjection
    active: bool = True
    last_sequence: int = 0
    last_arrival: float | None = None
    occurrences: dict[str, tuple[int, float, str, bool]] | None = None


class ScopedNotificationOriginRegistry:
    """Parent-owned immutable origin-to-child-scope registry.

    ``bind_origin`` and ``publish`` are trusted-parent operations.  The class
    intentionally has no method which reads an ARE queue; a later bridge owns
    queue draining and must supply the occurrence metadata explicitly.
    """

    def __init__(self):
        self.__bindings: dict[str, _OriginBinding] = {}
        self.__tombstones: set[str] = set()
        self.__occurrence_origins: dict[str, str] = {}
        self.__lock = threading.RLock()

    @staticmethod
    def __binding_hash(origin_id: str, scope_id: str, child_execution_id: str, app_id: str) -> str:
        value = "\x00".join((origin_id, scope_id, child_execution_id, app_id)).encode("utf-8")
        return hashlib.sha256(value).hexdigest()

    def bind_origin(self, *, origin_id: str, scope_id: str, child_execution_id: str,
                    app_id: str, projection: ScopedArrivedNotificationProjection) -> bool:
        origin_id = _identifier(origin_id, "NOTIFICATION_PRODUCER_ORIGIN_INVALID")
        scope_id = _identifier(scope_id, "NOTIFICATION_PRODUCER_SCOPE_INVALID")
        child_execution_id = _identifier(child_execution_id, "NOTIFICATION_PRODUCER_CHILD_INVALID")
        app_id = _identifier(app_id, "NOTIFICATION_PRODUCER_APP_INVALID")
        if type(projection) is not ScopedArrivedNotificationProjection:
            _fail("NOTIFICATION_PRODUCER_PROJECTION_INVALID")
        if projection.scope_id != scope_id:
            _fail("NOTIFICATION_PRODUCER_SCOPE_MISMATCH")
        with self.__lock:
            if origin_id in self.__tombstones:
                _fail("NOTIFICATION_PRODUCER_ORIGIN_REVOKED")
            existing = self.__bindings.get(origin_id)
            if existing is not None:
                if (existing.scope_id, existing.child_execution_id, existing.app_id,
                        existing.projection) == (scope_id, child_execution_id, app_id, projection):
                    return False
                _fail("NOTIFICATION_PRODUCER_ORIGIN_REBIND")
            self.__bindings[origin_id] = _OriginBinding(origin_id, scope_id,
                child_execution_id, app_id, projection, occurrences={})
            return True

    def revoke_origin(self, *, origin_id: str) -> None:
        origin_id = _identifier(origin_id, "NOTIFICATION_PRODUCER_ORIGIN_INVALID")
        with self.__lock:
            binding = self.__bindings.get(origin_id)
            if binding is None:
                if origin_id in self.__tombstones:
                    return
                _fail("NOTIFICATION_PRODUCER_ORIGIN_UNKNOWN")
            binding.active = False
            self.__tombstones.add(origin_id)

    def __resolve(self, origin_id: str) -> _OriginBinding:
        origin_id = _identifier(origin_id, "NOTIFICATION_PRODUCER_ORIGIN_INVALID")
        binding = self.__bindings.get(origin_id)
        if binding is None:
            if origin_id in self.__tombstones:
                _fail("NOTIFICATION_PRODUCER_ORIGIN_REVOKED")
            _fail("NOTIFICATION_PRODUCER_ORIGIN_UNKNOWN")
        if not binding.active:
            _fail("NOTIFICATION_PRODUCER_ORIGIN_REVOKED")
        return binding

    def publish(self, *, origin_id: str, occurrence_id: str, sequence: int,
                arrived_at: float, message: Message) -> dict[str, Any]:
        """Publish one trusted occurrence into its bound scope projection.

        The occurrence id and sequence are parent evidence, not values
        derived from untrusted message content.  Exact duplicate occurrences
        are idempotent; the same id with any changed field is rejected.
        ``ENVIRONMENT_STOP`` revokes the origin and never enters the child
        projection.
        """
        occurrence_id = _identifier(occurrence_id, "NOTIFICATION_PRODUCER_OCCURRENCE_INVALID")
        sequence = _sequence(sequence)
        arrival = _finite_nonnegative(arrived_at, "NOTIFICATION_PRODUCER_ARRIVAL_INVALID")
        if type(message) is not Message:
            _fail("NOTIFICATION_PRODUCER_MESSAGE_INVALID")
        digest = message_hash(message)
        with self.__lock:
            binding = self.__resolve(origin_id)
            occurrences = binding.occurrences
            assert occurrences is not None
            existing = occurrences.get(occurrence_id)
            terminal = message.message_type == MessageType.ENVIRONMENT_STOP
            record = (sequence, arrival, digest, terminal)
            if existing is not None:
                if existing != record:
                    _fail("NOTIFICATION_PRODUCER_OCCURRENCE_CONFLICT")
                return {"schemaVersion": SCHEMA_RECEIPT, "status": "duplicate",
                        "scopeId": binding.scope_id, "sequence": sequence,
                        "occurrenceIdHash": hashlib.sha256(occurrence_id.encode("utf-8")).hexdigest()}
            prior_origin = self.__occurrence_origins.get(occurrence_id)
            if prior_origin is not None and prior_origin != binding.origin_id:
                _fail("NOTIFICATION_PRODUCER_OCCURRENCE_FOREIGN")
            if sequence <= binding.last_sequence:
                _fail("NOTIFICATION_PRODUCER_SEQUENCE_STALE")
            if binding.last_arrival is not None and arrival < binding.last_arrival:
                _fail("NOTIFICATION_PRODUCER_ARRIVAL_STALE")
            if terminal:
                # STOP is a lifecycle revoke, not a child-visible message.
                occurrences[occurrence_id] = record
                self.__occurrence_origins[occurrence_id] = binding.origin_id
                binding.last_sequence, binding.last_arrival = sequence, arrival
                binding.active = False
                self.__tombstones.add(binding.origin_id)
                return {"schemaVersion": SCHEMA_RECEIPT, "status": "stopped",
                        "scopeId": binding.scope_id, "sequence": sequence,
                        "occurrenceIdHash": hashlib.sha256(occurrence_id.encode("utf-8")).hexdigest()}
            accepted = binding.projection.ingest(scope_id=binding.scope_id,
                notification_id=occurrence_id, sequence=sequence, arrived_at=arrival, message=message)
            occurrences[occurrence_id] = record
            self.__occurrence_origins[occurrence_id] = binding.origin_id
            binding.last_sequence, binding.last_arrival = sequence, arrival
            return {"schemaVersion": SCHEMA_RECEIPT, "status": "accepted" if accepted else "duplicate",
                    "scopeId": binding.scope_id, "sequence": sequence,
                    "occurrenceIdHash": hashlib.sha256(occurrence_id.encode("utf-8")).hexdigest()}

    def project(self, *, origin_id: str, are_now: float) -> tuple[ProjectedNotification, ...]:
        with self.__lock:
            binding = self.__resolve(origin_id)
            return binding.projection.project(are_now=are_now)

    def drain(self, *, origin_id: str, are_now: float,
              limit: int | None = None) -> tuple[ProjectedNotification, ...]:
        with self.__lock:
            binding = self.__resolve(origin_id)
            return binding.projection.drain(are_now=are_now, limit=limit)

    def snapshot(self) -> dict[str, Any]:
        with self.__lock:
            return {"schemaVersion": SCHEMA_REGISTRY,
                    "activeOrigins": sum(1 for item in self.__bindings.values() if item.active),
                    "revokedOrigins": len(self.__tombstones),
                    "bindings": [{"originHash": self.__binding_hash(item.origin_id, item.scope_id,
                        item.child_execution_id, item.app_id), "scopeId": item.scope_id,
                        "childExecutionId": item.child_execution_id, "appId": item.app_id,
                        "active": item.active, "lastSequence": item.last_sequence,
                        "occurrenceCount": len(item.occurrences or {})}
                        for item in self.__bindings.values()]}
