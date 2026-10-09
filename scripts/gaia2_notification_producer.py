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
    DeadlineNotificationError,
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


class NotificationReaderError(RuntimeError):
    """Fixed, non-sensitive errors exposed by a scoped child reader."""

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


def _callable_identity(value: Any) -> tuple:
    """Stable identity for a bound clock/projection method."""
    receiver = getattr(value, "__self__", None)
    function = getattr(value, "__func__", value)
    return (id(receiver), id(function), id(getattr(function, "__code__", None)),
            id(getattr(function, "__defaults__", None)), id(getattr(function, "__kwdefaults__", None)))


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

    def open_reader(self, *, origin_id: str, scope_id: str, child_execution_id: str,
                    app_id: str, time_manager: Any) -> "ScopedChildNotificationReader":
        """Create a read-only cursor for one already-bound child scope.

        This is a trusted parent operation.  The returned reader has no queue
        reference and cannot bind, publish, revoke, or reassign an origin.
        ``time_manager`` is retained by identity so the child cannot choose a
        wall clock or pass an arbitrary arrival time to the projection.
        """
        origin_id = _identifier(origin_id, "NOTIFICATION_PRODUCER_ORIGIN_INVALID")
        scope_id = _identifier(scope_id, "NOTIFICATION_PRODUCER_SCOPE_INVALID")
        child_execution_id = _identifier(child_execution_id, "NOTIFICATION_PRODUCER_CHILD_INVALID")
        app_id = _identifier(app_id, "NOTIFICATION_PRODUCER_APP_INVALID")
        if time_manager is None or not callable(getattr(time_manager, "time", None)):
            _fail("NOTIFICATION_PRODUCER_CLOCK_INVALID")
        with self.__lock:
            binding = self.__resolve(origin_id)
            if (binding.scope_id, binding.child_execution_id, binding.app_id) != (
                    scope_id, child_execution_id, app_id):
                _fail("NOTIFICATION_PRODUCER_READER_SCOPE_MISMATCH")
            binding_token = self.__reader_binding_token_locked(origin_id, binding)
        return ScopedChildNotificationReader(self, origin_id, scope_id,
            child_execution_id, app_id, time_manager, binding_token=binding_token)

    def __reader_binding_token_locked(self, origin_id: str, binding: _OriginBinding) -> tuple:
        return (id(self), self.__binding_hash(origin_id, binding.scope_id,
            binding.child_execution_id, binding.app_id), id(binding), id(binding.projection),
            _callable_identity(binding.projection.project), binding.scope_id,
            binding.child_execution_id, binding.app_id)

    def _reader_binding_token(self, origin_id: str) -> tuple:
        """Trusted internal identity check used by a previously opened reader."""
        with self.__lock:
            binding = self.__resolve(origin_id)
            return self.__reader_binding_token_locked(origin_id, binding)

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


class ScopedChildNotificationReader:
    """Parent-owned, read-only cursor over one scoped projection.

    It deliberately does not implement ARE's ``BaseNotificationSystem`` and
    has no message queue.  Each reader owns a cursor, so the parent bridge and
    a child reader may both observe the same projected occurrence without a
    global consume race.  The reader's clock is fixed by the trusted parent
    and is never supplied by Actor/model input.
    """

    def __init__(self, registry: ScopedNotificationOriginRegistry, origin_id: str,
                 scope_id: str, child_execution_id: str, app_id: str,
                 time_manager: Any, *, binding_token: tuple | None = None):
        if type(registry) is not ScopedNotificationOriginRegistry:
            raise NotificationReaderError("NOTIFICATION_READER_REGISTRY_INVALID")
        if type(binding_token) is not tuple:
            raise NotificationReaderError("NOTIFICATION_READER_BINDING_INVALID")
        try:
            current_token = registry._reader_binding_token(origin_id)
        except NotificationProducerError:
            raise NotificationReaderError("NOTIFICATION_READER_BINDING_INVALID") from None
        if (current_token != binding_token or current_token[5:] !=
                (scope_id, child_execution_id, app_id)):
            raise NotificationReaderError("NOTIFICATION_READER_BINDING_INVALID")
        try:
            clock = getattr(time_manager, "time", None)
        except BaseException:
            clock = None
        if time_manager is None or not callable(clock):
            raise NotificationReaderError("NOTIFICATION_READER_CLOCK_INVALID")
        self.__registry = registry
        self.__origin_id = origin_id
        self.__scope_id = scope_id
        self.__child_execution_id = child_execution_id
        self.__app_id = app_id
        self.__time_manager = time_manager
        self.__clock = clock
        self.__binding_token = binding_token
        self.__clock_binding = (id(time_manager), _callable_identity(clock))
        self.__cursor = 0
        self.__read_count = 0
        self.__closed = False
        self.__clock_failed = False
        self.__binding_failed = False
        self.__clock_changed = False
        self.__revoked = False
        self.__lock = threading.RLock()

    @property
    def scope_id(self) -> str:
        return self.__scope_id

    @property
    def child_execution_id(self) -> str:
        return self.__child_execution_id

    @property
    def app_id(self) -> str:
        return self.__app_id

    @property
    def time_manager(self) -> Any:
        return self.__time_manager

    def __now(self) -> float:
        if self.__binding_failed:
            raise NotificationReaderError("NOTIFICATION_READER_BINDING_CHANGED") from None
        if self.__clock_changed:
            raise NotificationReaderError("NOTIFICATION_READER_CLOCK_CHANGED") from None
        if self.__clock_failed:
            raise NotificationReaderError("NOTIFICATION_READER_CLOCK_INVALID") from None
        try:
            if self.__registry._reader_binding_token(self.__origin_id) != self.__binding_token:
                self.__binding_failed = True
                raise NotificationReaderError("NOTIFICATION_READER_BINDING_CHANGED") from None
        except NotificationReaderError:
            raise
        except NotificationProducerError as error:
            if error.code == "NOTIFICATION_PRODUCER_ORIGIN_REVOKED":
                self.__revoked = True
                raise NotificationReaderError("NOTIFICATION_READER_ORIGIN_REVOKED") from None
            self.__binding_failed = True
            raise NotificationReaderError("NOTIFICATION_READER_BINDING_CHANGED") from None
        try:
            clock_binding = (id(self.__time_manager), _callable_identity(self.__time_manager.time))
        except BaseException:
            self.__clock_changed = True
            raise NotificationReaderError("NOTIFICATION_READER_CLOCK_CHANGED") from None
        if (clock_binding != self.__clock_binding
                or _callable_identity(self.__clock) != self.__clock_binding[1]):
            self.__clock_changed = True
            raise NotificationReaderError("NOTIFICATION_READER_CLOCK_CHANGED") from None
        try:
            now = self.__clock()
        except BaseException:
            self.__clock_failed = True
            raise NotificationReaderError("NOTIFICATION_READER_CLOCK_INVALID") from None
        if type(now) not in (int, float) or not math.isfinite(now) or now < 0:
            self.__clock_failed = True
            raise NotificationReaderError("NOTIFICATION_READER_CLOCK_INVALID") from None
        return float(now)

    def poll(self, *, limit: int | None = None) -> tuple[ProjectedNotification, ...]:
        """Return newly arrived records and advance only this reader cursor."""
        with self.__lock:
            if self.__closed:
                raise NotificationReaderError("NOTIFICATION_READER_CLOSED") from None
            if self.__revoked:
                raise NotificationReaderError("NOTIFICATION_READER_ORIGIN_REVOKED") from None
            if limit is not None and (type(limit) is not int or limit < 1):
                raise NotificationReaderError("NOTIFICATION_READER_LIMIT_INVALID") from None
            now = self.__now()
            try:
                projected = self.__registry.project(origin_id=self.__origin_id, are_now=now)
            except NotificationProducerError as error:
                if error.code == "NOTIFICATION_PRODUCER_ORIGIN_REVOKED":
                    self.__revoked = True
                    raise NotificationReaderError("NOTIFICATION_READER_ORIGIN_REVOKED") from None
                raise NotificationReaderError("NOTIFICATION_READER_PROJECTION_FAILED") from None
            except DeadlineNotificationError as error:
                if error.code == "NOTIFICATION_CLOCK_INVALID":
                    self.__clock_failed = True
                    raise NotificationReaderError("NOTIFICATION_READER_CLOCK_INVALID") from None
                raise NotificationReaderError("NOTIFICATION_READER_PROJECTION_FAILED") from None
            except BaseException:
                raise NotificationReaderError("NOTIFICATION_READER_PROJECTION_FAILED") from None
            try:
                if self.__registry._reader_binding_token(self.__origin_id) != self.__binding_token:
                    self.__binding_failed = True
                    raise NotificationReaderError("NOTIFICATION_READER_BINDING_CHANGED") from None
            except NotificationReaderError:
                raise
            except NotificationProducerError as error:
                if error.code == "NOTIFICATION_PRODUCER_ORIGIN_REVOKED":
                    self.__revoked = True
                    raise NotificationReaderError("NOTIFICATION_READER_ORIGIN_REVOKED") from None
                self.__binding_failed = True
                raise NotificationReaderError("NOTIFICATION_READER_BINDING_CHANGED") from None
            visible = tuple(item for item in projected if item.sequence > self.__cursor)
            if limit is not None:
                visible = visible[:limit]
            if visible:
                self.__cursor = visible[-1].sequence
                self.__read_count += len(visible)
            return visible

    def snapshot(self) -> dict[str, Any]:
        with self.__lock:
            return {"schemaVersion": "gaia2-scoped-child-notification-reader-v1",
                    "scopeId": self.__scope_id, "childExecutionId": self.__child_execution_id,
                    "appId": self.__app_id, "lastSequence": self.__cursor,
                    "readCount": self.__read_count, "closed": self.__closed,
                    "clockFailed": self.__clock_failed, "clockChanged": self.__clock_changed,
                    "bindingFailed": self.__binding_failed, "originRevoked": self.__revoked,
                    "bindingHash": self.__binding_token[1]}

    def identity_snapshot(self) -> tuple:
        """Return non-payload identity state for the trusted runner pin."""
        with self.__lock:
            return (id(self.__registry), self.__binding_token, self.__scope_id,
                    self.__child_execution_id, self.__app_id, id(self.__time_manager),
                    self.__clock_binding, _callable_identity(self.__clock))

    def close(self) -> None:
        with self.__lock:
            self.__closed = True
