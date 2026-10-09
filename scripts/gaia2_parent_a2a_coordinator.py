"""Trusted same-process parent -> AppAgent child coordinator (GAIA2 5.2d0).

This module is deliberately a seam, not a replacement for the official
``ScenarioRunner`` entry point.  The parent bridge owns the model gate and
passes only a trusted, already-validated ``before_tool`` receipt here.  The
coordinator then creates one child scope lazily, binds the existing native
owner and notification lifecycle, and invokes a constructor-supplied child
runner.  Actor JSON cannot select a scope, origin, clock, runner, or cleanup
operation.

The child factory is intentionally a controlled constructor callback for this
slice.  A future production adapter may construct ``ScopedAppAgentRunner``
with the returned scope and reader, but this class does not import or invoke a
provider, Scenario, Node/TS pipe, or private transport by itself.
"""

from __future__ import annotations

import copy
import hashlib
import math
import threading
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from gaia2_a2a_wire import value_hash
from gaia2_notification_producer import (
    ScopedChildNotificationLifecycle,
    ScopedNotificationOriginRegistry,
)
from gaia2_private_native_binding import NativeAppBinding
from are.simulation.environment import Environment


class ParentA2AError(RuntimeError):
    """Fixed coordinator error code; child exception text never crosses the seam."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _clone(value: Any) -> Any:
    """Copy trusted scope values without exposing a mutable internal object."""
    try:
        return copy.deepcopy(value)
    except BaseException:
        raise ParentA2AError("CHILD_SCOPE_UNSAFE") from None


def _finite(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except (TypeError, ValueError, OverflowError):
        return False


@dataclass(frozen=True)
class ParentChildHandle:
    """Opaque-ish trusted handle returned to the parent adapter only.

    The scope is copied at construction and never used as authority by the
    child runner; the ``NativeAppBinding`` remains the authority for native
    dispatch.  Callers should treat this as a trusted in-process object, not
    an IPC payload or Actor-visible value.
    """

    scope: dict[str, Any]
    scope_hash: str
    lifecycle: ScopedChildNotificationLifecycle
    runner: Any


class ParentA2ACoordinator:
    """One parent-run lifetime with lazy, sequential child delegation.

    ``child_factory`` has the fixed trusted signature
    ``child_factory(scope=<dict>, notification_reader=<reader>)``.  It must
    return an object exposing ``run()``, ``close()`` and ``snapshot()``.
    ``snapshot()`` must prove a completion evidence reference before a parent
    success can be returned.  The factory cannot be supplied by Actor input.
    """

    _ALLOWED_CLOSE_REASONS = frozenset(("parent_close", "stop", "failed", "cancelled"))

    def __init__(self, *, env: Any, owner: NativeAppBinding,
                 registry: ScopedNotificationOriginRegistry,
                 child_factory: Callable[..., Any],
                 child_deadline_seconds: float = 600.0,
                 max_native_actions: int = 100):
        if type(owner) is not NativeAppBinding or type(registry) is not ScopedNotificationOriginRegistry:
            raise ParentA2AError("COORDINATOR_INITIALIZATION_INVALID")
        if not callable(child_factory) or type(env) is not Environment:
            raise ParentA2AError("COORDINATOR_INITIALIZATION_INVALID")
        try:
            time_manager = env.time_manager
            now = time_manager.time()
            manifest = owner.manifest()
        except BaseException:
            raise ParentA2AError("COORDINATOR_INITIALIZATION_INVALID") from None
        if not callable(getattr(time_manager, "time", None)) or not _finite(now) or now < 0:
            raise ParentA2AError("COORDINATOR_CLOCK_INVALID")
        if (type(manifest) is not dict or type(manifest.get("environmentGeneration")) is not str
                or not manifest["environmentGeneration"] or type(manifest.get("parentExecutionId")) is not str
                or not manifest["parentExecutionId"] or type(manifest.get("parentSessionId")) is not str
                or not manifest["parentSessionId"] or type(manifest.get("appId")) is not str
                or not manifest["appId"] or type(manifest.get("toolInventoryHash")) is not str
                or len(manifest["toolInventoryHash"]) != 64):
            raise ParentA2AError("COORDINATOR_MANIFEST_INVALID")
        if not _finite(child_deadline_seconds) or child_deadline_seconds <= 0:
            raise ParentA2AError("COORDINATOR_DEADLINE_INVALID")
        if type(max_native_actions) is not int or isinstance(max_native_actions, bool) \
                or not 1 <= max_native_actions <= 100000:
            raise ParentA2AError("COORDINATOR_BUDGET_INVALID")
        # Environment identity is checked by the existing NativeAppBinding at
        # child bind time; keeping the manager here pins notification clocks to
        # this exact ARE environment.
        if getattr(env, "apps", {}).get(manifest["appId"]) is not owner.bound_app:
            raise ParentA2AError("COORDINATOR_APP_INVALID")
        if owner.clock_environment is not env:
            raise ParentA2AError("COORDINATOR_CLOCK_ENVIRONMENT_INVALID")
        self.__env = env
        self.__owner = owner
        self.__registry = registry
        self.__factory = child_factory
        self.__time_manager = time_manager
        self.__manifest = _clone(manifest)
        self.__deadline_seconds = float(child_deadline_seconds)
        self.__max_native_actions = max_native_actions
        self.__lock = threading.RLock()
        self.__closed = False
        self.__close_reason: str | None = None
        self.__active: ParentChildHandle | None = None
        self.__children: list[dict[str, Any]] = []
        self.__parent_action_ids: set[str] = set()

    @property
    def environment(self) -> Any:
        return self.__env

    @property
    def owner(self) -> NativeAppBinding:
        return self.__owner

    @property
    def active_child(self) -> ParentChildHandle | None:
        with self.__lock:
            return self.__active

    @staticmethod
    def _validate_parent_gate(gate: Any) -> None:
        if (type(gate) is not dict or type(gate.get("decision")) is not dict
                or gate["decision"].get("action") != "allow"
                or type(gate["decision"].get("reason")) is not str
                or not gate["decision"]["reason"]):
            raise ParentA2AError("PARENT_GATE_NOT_ALLOWED")

    @staticmethod
    def _validate_action(action: Any) -> tuple[str, str]:
        if type(action) is not dict:
            raise ParentA2AError("PARENT_ACTION_INVALID")
        if action.get("canonicalName") != "AppAgent__expert_agent":
            raise ParentA2AError("PARENT_ACTION_NOT_DELEGATION")
        parent_action_id = action.get("id")
        arguments = action.get("arguments")
        try:
            task_bytes = arguments["task"].encode("utf-8", errors="strict") if type(arguments) is dict else b""
        except (UnicodeError, AttributeError):
            task_bytes = b""
        if (type(parent_action_id) is not str or not parent_action_id
                or type(arguments) is not dict or set(arguments) != {"task"}
                or type(arguments["task"]) is not str or not arguments["task"]
                or len(task_bytes) > 1024 * 1024):
            raise ParentA2AError("PARENT_ACTION_INVALID")
        return parent_action_id, arguments["task"]

    def _scope(self, parent_action_id: str, task: str) -> dict[str, Any]:
        try:
            now = self.__time_manager.time()
        except BaseException:
            raise ParentA2AError("COORDINATOR_CLOCK_INVALID") from None
        if not _finite(now) or now < 0:
            raise ParentA2AError("COORDINATOR_CLOCK_INVALID")
        scope = {
            "parentExecutionId": self.__manifest["parentExecutionId"],
            "parentSessionId": self.__manifest["parentSessionId"],
            "environmentGeneration": self.__manifest["environmentGeneration"],
            "appId": self.__manifest["appId"],
            "parentCanonicalName": "AppAgent__expert_agent",
            "taskArgumentKey": "task",
            "toolInventoryHash": self.__manifest["toolInventoryHash"],
            "taskHash": hashlib.sha256(task.encode("utf-8")).hexdigest(),
            "parentActionId": parent_action_id,
            "requestId": str(uuid.uuid4()),
            "childExecutionId": str(uuid.uuid4()),
            "childSessionId": str(uuid.uuid4()),
            "task": task,
            "deadline": float(now) + self.__deadline_seconds,
            "maxNativeActions": self.__max_native_actions,
        }
        return scope

    def begin_child(self, *, action: dict[str, Any], parent_gate: dict[str, Any]) -> ParentChildHandle:
        """Create one child only after the trusted parent before-tool allow."""
        self._validate_parent_gate(parent_gate)
        parent_action_id, task = self._validate_action(action)
        with self.__lock:
            if self.__closed:
                raise ParentA2AError("COORDINATOR_CLOSED")
            if self.__active is not None:
                raise ParentA2AError("CHILD_ALREADY_ACTIVE")
            if parent_action_id in self.__parent_action_ids:
                raise ParentA2AError("PARENT_ACTION_REUSED")
            scope = self._scope(parent_action_id, task)
            # Bind the lifecycle first so any owner failure can revoke the
            # origin without leaving a live child reader behind.
            try:
                lifecycle = ScopedChildNotificationLifecycle(
                    registry=self.__registry, scope=scope, time_manager=self.__time_manager,
                    occurrence_prefix=scope["childExecutionId"] + ":notification")
            except BaseException:
                raise ParentA2AError("CHILD_NOTIFICATION_BIND_FAILED") from None
            try:
                bound = self.__owner.bind_child({"scope": _clone(scope)})
                if (type(bound) is not dict or bound.get("scopeHash") != value_hash(scope)):
                    raise ParentA2AError("CHILD_NATIVE_BIND_INVALID")
            except BaseException:
                try:
                    lifecycle.close("failed")
                except BaseException:
                    pass
                raise ParentA2AError("CHILD_NATIVE_BIND_FAILED") from None
            try:
                runner = self.__factory(scope=_clone(scope), notification_reader=lifecycle.reader)
            except BaseException:
                try:
                    self.__owner.cancel_child({"scope": _clone(scope)})
                except BaseException:
                    pass
                try:
                    lifecycle.close("failed")
                except BaseException:
                    pass
                raise ParentA2AError("CHILD_FACTORY_FAILED") from None
            if (not callable(getattr(runner, "run", None))
                    or not callable(getattr(runner, "close", None))
                    or not callable(getattr(runner, "snapshot", None))):
                try:
                    self.__owner.cancel_child({"scope": _clone(scope)})
                except BaseException:
                    pass
                try:
                    lifecycle.close("failed")
                except BaseException:
                    pass
                raise ParentA2AError("CHILD_RUNNER_INVALID")
            handle = ParentChildHandle(_clone(scope), value_hash(scope), lifecycle, runner)
            self.__parent_action_ids.add(parent_action_id)
            self.__active = handle
            self.__children.append({"handle": handle, "status": "running", "result": None})
            return handle

    def run_child(self, handle: ParentChildHandle) -> str:
        """Run one child and close its notification origin exactly once."""
        with self.__lock:
            if (self.__active is not handle or type(handle) is not ParentChildHandle
                    or handle.scope_hash != value_hash(handle.scope)
                    or handle.lifecycle.scope_id != handle.scope["requestId"]
                    or handle.lifecycle.child_execution_id != handle.scope["childExecutionId"]):
                raise ParentA2AError("CHILD_HANDLE_INVALID")
            if self.__closed:
                raise ParentA2AError("COORDINATOR_CLOSED")
        try:
            result = handle.runner.run()
            if type(result) is not str:
                raise ValueError()
            snapshot = getattr(handle.runner, "snapshot", None)
            if not callable(snapshot):
                raise ValueError()
            child_snapshot = snapshot()
            if (type(child_snapshot) is not dict or child_snapshot.get("completed") is not True
                    or not child_snapshot.get("completionEvidenceRef")
                    or handle.lifecycle.snapshot().get("closed") is True):
                raise ValueError()
        except BaseException:
            with self.__lock:
                record = next(item for item in self.__children if item["handle"] is handle)
                record["status"] = "failed"
                self.__active = None
            try:
                self.__owner.cancel_child({"scope": _clone(handle.scope)})
            except BaseException:
                pass
            try:
                handle.lifecycle.close("failed")
            except BaseException:
                pass
            try:
                handle.runner.close()
            except BaseException:
                pass
            raise ParentA2AError("CHILD_RUN_FAILED") from None
        with self.__lock:
            record = next(item for item in self.__children if item["handle"] is handle)
            if self.__closed:
                record["status"] = "cancelled"
                self.__active = None
                close_as = "cancelled"
            else:
                record["status"] = "completed"
                record["result"] = result
                self.__active = None
                close_as = "completed"
        cleanup_error = None
        try:
            handle.lifecycle.close(close_as)
        except BaseException:
            cleanup_error = "CHILD_NOTIFICATION_CLOSE_FAILED"
        try:
            handle.runner.close()
        except BaseException:
            # A completed native child has already emitted its own evidence;
            # cleanup failure is still terminal and never a success claim.
            cleanup_error = cleanup_error or "CHILD_RUNNER_CLOSE_FAILED"
        if cleanup_error is not None:
            raise ParentA2AError(cleanup_error) from None
        if close_as != "completed":
            raise ParentA2AError("CHILD_CANCELLED")
        return result

    def close(self, reason: str = "parent_close") -> None:
        """Revoke native child authority before closing lifecycle/runner."""
        if reason not in self._ALLOWED_CLOSE_REASONS:
            raise ParentA2AError("COORDINATOR_CLOSE_REASON_INVALID")
        with self.__lock:
            if self.__closed:
                return
            self.__closed = True
            self.__close_reason = reason
            handle = self.__active
            if handle is not None:
                record = next(item for item in self.__children if item["handle"] is handle)
                record["status"] = "cancelled" if reason in ("parent_close", "stop", "cancelled") else "failed"
                self.__active = None
        if handle is None:
            return
        try:
            # Native binding's cancel is the authority barrier; it runs before
            # reader close so a late child action cannot become a new dispatch.
            self.__owner.cancel_child({"scope": _clone(handle.scope)})
        except BaseException:
            pass
        try:
            handle.lifecycle.close("stop" if reason == "stop" else reason)
        except BaseException:
            pass
        try:
            handle.runner.close()
        except BaseException:
            pass

    def snapshot(self) -> dict[str, Any]:
        with self.__lock:
            children = []
            for record in self.__children:
                handle = record["handle"]
                runner_snapshot = None
                snapshot = getattr(handle.runner, "snapshot", None)
                if callable(snapshot):
                    try:
                        runner_snapshot = _clone(snapshot())
                    except BaseException:
                        runner_snapshot = {"status": "unavailable"}
                children.append({"scopeHash": handle.scope_hash, "parentActionId": handle.scope["parentActionId"],
                                 "requestId": handle.scope["requestId"], "childExecutionId": handle.scope["childExecutionId"],
                                 "status": record["status"], "lifecycle": handle.lifecycle.snapshot(),
                                 "runner": runner_snapshot, "result": record["result"]})
            return {"schemaVersion": "gaia2-parent-a2a-coordinator-v1", "closed": self.__closed,
                    "closeReason": self.__close_reason, "children": children,
                    "active": self.__active is not None}
