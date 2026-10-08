"""Phase 5.1a local authority only; no IPC, models or production delegation.

The trusted adapter owns this object and the registration/start methods. Actor
JSON is restricted to tool/arguments. Handles are identity capabilities, not
serialized proofs. Python object privacy is not a sandbox for hostile Python
code: the security boundary here is untrusted Actor JSON, not in-process code.
Original ARE Tool/AppTool instances are retained and called, never reimplemented.
"""

from __future__ import annotations

import copy
import hashlib
import inspect
import json
import math
import threading
import uuid
import weakref
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Mapping

from are.simulation.agents.default_agent.default_tools import FinalAnswerTool
from are.simulation.apps.app import App
from are.simulation.tool_utils import AppTool, AppToolAdapter
from are.simulation.types import CompletedEvent, EventRegisterer, EventType


class A2AContractError(RuntimeError):
    """Fixed codes only; native exception text is not an authority or receipt."""


class GateDecision(Enum):
    ALLOW = "allow"
    BLOCK = "block"
    READ_BACK = "read_back"


def _json(value: Any) -> str:
    ancestors: set[int] = set()
    remaining = 100000

    def visit(item: Any, depth: int) -> None:
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 64:
            raise A2AContractError("unsafe_json")
        kind = type(item)
        if item is None or kind in (bool, int):
            return
        if kind is float and math.isfinite(item):
            return
        if kind is str:
            item.encode("utf-8", errors="strict")
            return
        if kind not in (list, dict) or id(item) in ancestors:
            raise A2AContractError("unsafe_json")
        ancestors.add(id(item))
        try:
            if kind is list:
                for child in item:
                    visit(child, depth + 1)
            else:
                for key, child in item.items():
                    if type(key) is not str or key in ("__proto__", "prototype", "constructor"):
                        raise A2AContractError("unsafe_json")
                    visit(key, depth + 1)
                    visit(child, depth + 1)
        finally:
            ancestors.remove(id(item))

    try:
        visit(value, 0)
        encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False,
                             separators=(",", ":"))
        if len(encoded.encode("utf-8")) > 4 * 1024 * 1024:
            raise A2AContractError("json_size_limit")
        return encoded
    except (ValueError, TypeError, UnicodeError, RecursionError) as error:
        raise A2AContractError("unsafe_json") from error


def _hash(value: Any) -> str:
    return hashlib.sha256(_json(value).encode("utf-8")).hexdigest()


def _finite_number(value: Any) -> bool:
    try:
        return type(value) in (float, int) and math.isfinite(value)
    except (OverflowError, ValueError, TypeError):
        return False


class _Opaque:
    __slots__ = ("__weakref__",)


# No value here holds a runtime or App strongly. An App object has one owner
# for its entire lifetime, even after close/GC; rebranding an old app as a new
# environment must not erase unresolved external effects. Fresh environments
# require fresh App instances. This is local ownership, not an IPC certificate.
_APP_OWNERS: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
_APP_OWNER_LOCK = threading.Lock()


@dataclass(frozen=True)
class ActionView:
    environment_generation: str
    app: str
    parent_execution_id: str
    parent_session_id: str
    parent_action_id: str
    request_id: str
    child_session_id: str
    dispatch_id: str
    canonical_tool: str
    tool_kind: str
    effect: str
    arguments_hash: str
    mutation_key: str
    resource_key: str


@dataclass(frozen=True)
class NativeObservation:
    action: ActionView
    status: str
    result_hash: str | None
    error_type: str | None
    native_completed_event_ref: str | None


@dataclass
class _Binding:
    app: App
    tools: dict[str, tuple[Any, AppTool | None]]
    inventory_hash: str


@dataclass
class _Child:
    app: str
    parent_action_id: str
    task_hash: str
    deadline: float
    max_actions: int
    request_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    child_session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    state: str = "registered"
    used_actions: int = 0
    parent_allow_ref: str | None = None
    initialization_ref: str | None = None
    final_dispatch_id: str | None = None
    actions: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class _Ticket:
    child: _Child
    public_name: str
    arguments: dict[str, Any]
    effective_arguments: dict[str, Any]
    consumed: bool = False


class LocalA2ARuntime:
    """Trusted, instance-local scoped facade, deliberately not an RPC service.

    before/after are trusted constructor callbacks, not Actor inputs. before
    must return GateDecision; after must return None or raise. Their observations
    are immutable metadata, not mutable receipts. This module creates every
    authority receipt itself. A future TS/IPC bridge must separately verify its
    real Host references; these local receipts do not pretend to be TS Hooks.
    """

    def __init__(self, *, apps: Mapping[str, App], environment_generation: str,
                 parent_execution_id: str, parent_session_id: str,
                 clock: Callable[[], float], before: Callable[[ActionView], GateDecision],
                 after: Callable[[NativeObservation], None]):
        identities = (environment_generation, parent_execution_id, parent_session_id)
        if any(type(value) is not str or not value for value in identities):
            raise A2AContractError("identity_invalid")
        _json(list(identities))
        if not apps or not all(callable(value) for value in (clock, before, after)):
            raise A2AContractError("trusted_initialization_invalid")
        self.__environment = environment_generation
        self.__execution = parent_execution_id
        self.__session = parent_session_id
        self.__clock = clock
        self.__before = before
        self.__after = after
        self.__lock = threading.RLock()
        self.__native_lock = threading.Lock()
        self.__local = threading.local()
        self.__closed = False
        self.__clock_failed = False
        self.__last_clock: float | None = None
        self.__children: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
        self.__tickets: weakref.WeakKeyDictionary = weakref.WeakKeyDictionary()
        self.__all_children: list[_Child] = []
        self.__registered_parent_actions: set[str] = set()
        self.__ledger: dict[str, dict[str, Any]] = {}
        self.__receipts: list[dict[str, Any]] = []
        self.__bindings: dict[str, _Binding] = {}
        for name, app in apps.items():
            if type(name) is not str or not isinstance(app, App) or app.name != name:
                raise A2AContractError("app_binding_invalid")
            tools: dict[str, tuple[Any, AppTool | None]] = {}
            for tool in app.get_tools():
                if not isinstance(tool, AppTool) or tool.class_instance is not app:
                    raise A2AContractError("tool_binding_invalid")
                # Nested production expert_agent is intentionally not enabled.
                if tool.func_name == "expert_agent":
                    raise A2AContractError("production_delegation_disabled")
                adapter = AppToolAdapter(tool)
                if adapter.name in tools or adapter.name == "final_answer":
                    raise A2AContractError("tool_inventory_invalid")
                tools[adapter.name] = (adapter, tool)
            tools["final_answer"] = (FinalAnswerTool(), None)
            binding = _Binding(app, tools, self.__inventory(tools))
            self.__bindings[name] = binding
        # Observe actual event_registered callbacks; no Event/CompletedEvent is
        # constructed, capture mode used, or official executor monkey-patched.
        self.__callback_key = "phase5-local-" + str(uuid.uuid4())
        owner = _Opaque()
        with _APP_OWNER_LOCK:
            if any(binding.app in _APP_OWNERS for binding in self.__bindings.values()):
                raise A2AContractError("app_already_owned")
            for binding in self.__bindings.values():
                _APP_OWNERS[binding.app] = owner
        try:
            for binding in self.__bindings.values():
                binding.app.register_to_env(self.__callback_key, self.__observe_native_event)
        except BaseException:
            for binding in self.__bindings.values():
                binding.app.add_event_callbacks.pop(self.__callback_key, None)
            with _APP_OWNER_LOCK:
                for binding in self.__bindings.values():
                    if _APP_OWNERS.get(binding.app) is owner:
                        del _APP_OWNERS[binding.app]
            raise

    @staticmethod
    def __inventory(tools: dict[str, tuple[Any, AppTool | None]]) -> str:
        return _hash([{ "publicName": public, "canonicalName":
                       f"{tool.class_name}__{tool.func_name}" if tool else "final_answer",
                       "app": tool.app_name if tool else None,
                       "write": tool.write_operation if tool else None,
                       "signature": str(inspect.signature(tool.function if tool else native.forward)) }
                      for public, (native, tool) in sorted(tools.items())])

    def __now(self) -> float:
        if self.__clock_failed:
            raise A2AContractError("trusted_clock_failed")
        try:
            value = self.__clock()
        except BaseException:
            value = None
        if (not _finite_number(value) or value < 0
                or (self.__last_clock is not None and value < self.__last_clock)):
            self.__clock_failed = True
            for child in self.__all_children:
                pending = any(entry["requestId"] == child.request_id and entry["status"] == "pending"
                              for entry in self.__ledger.values())
                self.__revoke(child, "unknown" if pending else "failed")
            raise A2AContractError("trusted_clock_invalid")
        self.__last_clock = value
        return value

    def __receipt(self, kind: str, data: dict[str, Any]) -> str:
        prior = self.__receipts[-1]["sha256"] if self.__receipts else None
        body = {"schemaVersion": "gaia2-local-child-receipt-v1", "sequence": len(self.__receipts) + 1,
                "previousHash": prior, "kind": kind, **copy.deepcopy(data)}
        digest = _hash(body)
        self.__receipts.append({**body, "sha256": digest})
        return digest

    def __child(self, handle: Any, *, running: bool = False) -> _Child:
        if self.__closed:
            raise A2AContractError("parent_closed")
        if type(handle) is not _Opaque or handle not in self.__children:
            raise A2AContractError("child_handle_invalid")
        child = self.__children[handle]
        if child.state not in (("running",) if running else ("registered", "running")):
            raise A2AContractError("child_terminal")
        if self.__now() >= child.deadline:
            self.__revoke(child, "failed")
            raise A2AContractError("deadline_expired")
        return child

    def __scope(self, child: _Child) -> dict[str, str]:
        return {"environmentGeneration": self.__environment, "app": child.app,
                "parentExecutionId": self.__execution, "parentSessionId": self.__session,
                "parentActionId": child.parent_action_id, "requestId": child.request_id,
                "childSessionId": child.child_session_id}

    def register_child(self, *, app_name: str, parent_action_id: str, task: str,
                       deadline: float, max_actions: int) -> object:
        """Trusted adapter only; never expose registration to Actor JSON."""
        if getattr(self.__local, "dispatch_active", False):
            raise A2AContractError("reentrant_registration_forbidden")
        with self.__lock:
            if self.__closed:
                raise A2AContractError("parent_closed")
            if app_name not in self.__bindings or type(parent_action_id) is not str or not parent_action_id:
                raise A2AContractError("scope_invalid")
            if type(task) is not str or type(max_actions) is not int or max_actions < 1:
                raise A2AContractError("registration_invalid")
            if not _finite_number(deadline) or deadline <= self.__now():
                raise A2AContractError("deadline_invalid")
            if parent_action_id in self.__registered_parent_actions:
                raise A2AContractError("parent_action_consumed")
            self.__registered_parent_actions.add(parent_action_id)
            child = _Child(app_name, parent_action_id, _hash(task), deadline, max_actions)
            view = self.__view(child, "parent_registration", "delegation", "unknown", _hash(task))
        # Registration gates also participate in the drain barrier. They do
        # not hold the authority lock, so close can revoke before they finish.
        with self.__native_lock:
            with self.__lock:
                if self.__closed:
                    raise A2AContractError("parent_closed")
            self.__local.dispatch_active = True
            try:
                allowed = self.__before(view)
            except Exception as error:
                raise A2AContractError("parent_gate_failed") from error
            finally:
                self.__local.dispatch_active = False
        with self.__lock:
            if self.__closed:
                raise A2AContractError("parent_closed")
            if self.__now() >= deadline:
                raise A2AContractError("deadline_expired")
            if allowed is not GateDecision.ALLOW:
                raise A2AContractError("parent_not_allowed")
            child.parent_allow_ref = self.__receipt("parent_allow", {**self.__scope(child), "taskHash": child.task_hash})
            handle = _Opaque()
            self.__children[handle] = child
            self.__all_children.append(child)
            return handle

    def start_child(self, handle: object) -> None:
        with self.__lock:
            child = self.__child(handle)
            if child.state != "registered" or not child.parent_allow_ref:
                raise A2AContractError("start_reused")
            child.initialization_ref = self.__receipt("child_initialized", {**self.__scope(child),
                "parentAllowRef": child.parent_allow_ref, "toolInventoryHash": self.__bindings[child.app].inventory_hash,
                "taskHash": child.task_hash, "deadline": child.deadline, "maxActions": child.max_actions})
            child.state = "running"

    def available_tools(self, handle: object) -> tuple[str, ...]:
        with self.__lock:
            child = self.__child(handle, running=True)
            return tuple(sorted(self.__bindings[child.app].tools))

    def prepare_action(self, handle: object, actor_action: dict[str, Any]) -> object:
        """The only Actor JSON shape: tool and arguments; no permission/proof."""
        _json(actor_action)
        if type(actor_action) is not dict or set(actor_action) != {"tool", "arguments"}:
            raise A2AContractError("actor_action_invalid")
        name, arguments = actor_action["tool"], actor_action["arguments"]
        if type(name) is not str or type(arguments) is not dict:
            raise A2AContractError("actor_action_invalid")
        with self.__lock:
            child = self.__child(handle, running=True)
            if child.final_dispatch_id is not None:
                raise A2AContractError("child_final_answer_already_dispatched")
            binding = self.__bindings[child.app]
            if name not in binding.tools:
                raise A2AContractError("tool_not_in_app")
            native, tool = binding.tools[name]
            try:
                prefix = (tool.class_instance,) if tool else ()
                bound = inspect.signature(tool.function if tool else native.forward).bind(*prefix, **arguments)
                bound.apply_defaults()
                effective = {key: value for key, value in bound.arguments.items() if key != "self"}
                _json(effective)
            except Exception as error:
                raise A2AContractError("argument_binding_invalid") from error
            ticket = _Opaque()
            self.__tickets[ticket] = _Ticket(child, name, copy.deepcopy(arguments), copy.deepcopy(effective))
            return ticket

    def __view(self, child: _Child, canonical: str, kind: str, effect: str, arguments_hash: str) -> ActionView:
        resource = _hash([self.__environment, child.app])
        mutation = _hash([self.__environment, child.app, resource, canonical, arguments_hash])
        return ActionView(self.__environment, child.app, self.__execution, self.__session,
                          child.parent_action_id, child.request_id, child.child_session_id,
                          str(uuid.uuid4()), canonical, kind, effect, arguments_hash, mutation, resource)

    def __observe_native_event(self, event: Any) -> None:
        events = getattr(self.__local, "events", None)
        if events is not None:
            events.append(event)

    def dispatch(self, ticket_handle: object) -> dict[str, Any]:
        if getattr(self.__local, "dispatch_active", False):
            raise A2AContractError("reentrant_dispatch_forbidden")
        with self.__lock:
            if self.__closed:
                raise A2AContractError("parent_closed")
            if type(ticket_handle) is not _Opaque or ticket_handle not in self.__tickets:
                raise A2AContractError("action_handle_invalid")
            ticket = self.__tickets[ticket_handle]
            if ticket.consumed:
                raise A2AContractError("action_handle_consumed")
            ticket.consumed = True  # Consume before queuing, atomically.
        with self.__native_lock:
            self.__local.dispatch_active = True
            try:
                return self.__dispatch_once(ticket)
            finally:
                self.__local.dispatch_active = False

    def __dispatch_once(self, ticket: _Ticket) -> dict[str, Any]:
        child = ticket.child
        with self.__lock:
            if self.__closed or child.state != "running":
                raise A2AContractError("authority_revoked")
            if child.final_dispatch_id is not None:
                raise A2AContractError("child_final_answer_already_dispatched")
            if self.__now() >= child.deadline or child.used_actions >= child.max_actions:
                self.__revoke(child, "failed")
                raise A2AContractError("deadline_or_budget_exhausted")
            binding = self.__bindings[child.app]
            if self.__inventory(binding.tools) != binding.inventory_hash:
                self.__revoke(child, "failed")
                raise A2AContractError("tool_inventory_changed")
            native, tool = binding.tools[ticket.public_name]
            effect = "finish" if tool is None else "write" if tool.write_operation is True else "read" if tool.write_operation is False else "unknown"
            canonical = f"{tool.class_name}__{tool.func_name}" if tool else "final_answer"
            view = self.__view(child, canonical, "app_tool" if tool else "child_final_answer", effect, _hash(ticket.effective_arguments))
            action = {**self.__scope(child), "dispatchId": view.dispatch_id, "canonicalTool": canonical,
                      "toolKind": view.tool_kind, "effect": effect, "argumentsHash": view.arguments_hash,
                      "mutationKey": view.mutation_key, "resourceKey": view.resource_key,
                      "status": "pending", "beforeRef": None, "nativeReturnRef": None,
                      "afterRef": None, "nativeDispatchRef": None, "nativeCompletedEventRef": None,
                      "childInitializationRef": child.initialization_ref, "parentAllowRef": child.parent_allow_ref}
            child.actions.append(action)
            child.used_actions += 1
            unresolved = any(entry["resourceKey"] == view.resource_key and entry["status"] in ("pending", "unknown")
                             for entry in self.__ledger.values())
            if effect == "unknown" or (effect != "read" and unresolved):
                action["status"] = "blocked"
                action["beforeRef"] = self.__receipt("before_blocked", {**action, "reason": "unknown_scope"})
                return {"status": "blocked", "result": None, "dispatchId": view.dispatch_id}
        # Do not hold the authority lock across a possibly slow trusted Hook.
        # close/cancel can revoke while it is running, before native dispatch.
        try:
            gate = self.__before(view)
        except Exception:
            gate = GateDecision.BLOCK
        with self.__lock:
            if self.__closed or child.state != "running" or self.__now() >= child.deadline:
                action["status"] = "blocked"
                self.__revoke(child, "cancelled")
                raise A2AContractError("authority_revoked_before_dispatch")
            if type(gate) is not GateDecision or gate is not GateDecision.ALLOW:
                action["status"] = "blocked"
                action["beforeRef"] = self.__receipt("before_blocked", {**action, "reason": "trusted_gate_blocked"})
                self.__revoke(child, "failed")
                return {"status": "blocked", "result": None, "dispatchId": view.dispatch_id}
            action["beforeRef"] = self.__receipt("before_allowed", action)
            if effect == "finish":
                child.final_dispatch_id = view.dispatch_id
            if effect in ("write", "finish"):
                self.__ledger[view.mutation_key] = {"environmentGeneration": self.__environment,
                    "app": child.app, "requestId": child.request_id, "resourceKey": view.resource_key,
                    "mutationKey": view.mutation_key, "status": "pending", "readBackObserved": False}
            action["nativeDispatchRef"] = self.__receipt("native_dispatched", {**action, "beforeRef": action["beforeRef"]})
        result, error_type, status = None, None, "succeeded"
        events: list[Any] = []
        self.__local.events = events
        try:
            if EventRegisterer.is_capture_mode() or not EventRegisterer.is_active():
                raise A2AContractError("native_event_mode_invalid")
            # ARE Tool.__call__ delegates to the unchanged real forward. The
            # AppToolAdapter in turn calls the original AppTool, including its
            # pre-function fault sampling and event_registered wrapper.
            result = native(**ticket.arguments)
            result_hash = _hash(result)
        except BaseException as error:
            error_type = type(error).__name__
            result_hash = None
            status = "unknown" if effect in ("write", "finish") else "failed"
        finally:
            self.__local.events = None
        with self.__lock:
            event_ref = None
            if status == "succeeded" and tool is not None:
                try:
                    matches = []
                    for event in events:
                        if (isinstance(event, CompletedEvent) and event.event_type is EventType.AGENT
                                and event.action.app is binding.app
                                and inspect.unwrap(event.action.function) is inspect.unwrap(tool.function)):
                            args = {key: value for key, value in event.action.args.items() if key != "self"}
                            if _hash(args) == view.arguments_hash:
                                matches.append(event)
                    if len(matches) != 1 or not matches[0].metadata.completed or matches[0].metadata.exception is not None:
                        raise A2AContractError("native_event_not_closed")
                    event = matches[0]
                    event_result_hash = _hash(event.metadata.return_value)
                    if event_result_hash != result_hash:
                        raise A2AContractError("native_event_return_mismatch")
                    event_ref = self.__receipt("native_completed_event", {**self.__scope(child),
                        "dispatchId": view.dispatch_id, "eventId": event.event_id,
                        "eventTime": event.event_time, "argumentsHash": view.arguments_hash,
                        "canonicalTool": canonical, "eventResultHash": event_result_hash})
                except Exception:
                    status = "unknown" if effect == "write" else "failed"
                    error_type = "NativeEventNotClosed"
            action["nativeCompletedEventRef"] = event_ref
            action["observedNativeEventCount"] = len(events)
            action["nativeReturnRef"] = self.__receipt("native_return" if result_hash is not None else "native_exception",
                {**action, "resultHash": result_hash, "errorType": error_type, "status": status})
            observation = NativeObservation(view, status, result_hash, error_type, event_ref)
        after_ok = False
        try:
            if self.__after(observation) is not None:
                raise A2AContractError("after_gate_invalid")
            after_ok = True
        except Exception:
            status = "unknown" if effect in ("write", "finish") else "failed"
            error_type = "AfterGateFailed"
        with self.__lock:
            if after_ok:
                action["afterRef"] = self.__receipt("after_observed", {**action, "status": status,
                    "nativeReturnRef": action["nativeReturnRef"], "resultHash": result_hash})
            if self.__closed or child.state != "running" or self.__now() >= child.deadline:
                status = "unknown" if effect in ("write", "finish") else "failed"
                error_type = "AuthorityRevokedAfterDispatch"
            action["status"] = status
            action["resultHash"] = result_hash
            action["errorType"] = error_type
            entry = self.__ledger.get(view.mutation_key)
            if entry is not None and effect in ("write", "finish"):
                # An unknown created by cancellation/close is never overwritten
                # by a late successful native return or observation.
                if entry["status"] != "unknown":
                    entry["status"] = "completed" if status == "succeeded" else "unknown"
            if status == "succeeded" and effect == "read":
                for unknown in self.__ledger.values():
                    if unknown["resourceKey"] == view.resource_key and unknown["status"] == "unknown":
                        unknown["readBackObserved"] = True
            if status != "succeeded" and child.state == "running":
                self.__revoke(child, "unknown" if status == "unknown" else "failed")
            return {"status": status, "result": copy.deepcopy(result) if status == "succeeded" else None,
                    "dispatchId": view.dispatch_id}

    def complete_child(self, handle: object) -> None:
        """No caller receipt, log, answer, passed flag or permission argument."""
        with self.__lock:
            child = self.__child(handle, running=True)
            if any(entry["app"] == child.app and entry["status"] in ("pending", "unknown") for entry in self.__ledger.values()):
                raise A2AContractError("unresolved_app_mutation")
            finals = [action for action in child.actions if action["toolKind"] == "child_final_answer"]
            if (len(finals) != 1 or any(action["status"] != "succeeded" for action in child.actions)
                    or any(not finals[0][key] for key in ("beforeRef", "nativeDispatchRef", "nativeReturnRef", "afterRef"))
                    or finals[0]["nativeCompletedEventRef"] is not None):
                raise A2AContractError("real_final_answer_required")
            self.__receipt("child_completed", {**self.__scope(child), "finalDispatchId": finals[0]["dispatchId"],
                "finalAfterRef": finals[0]["afterRef"]})
            child.state = "completed"

    def __revoke(self, child: _Child, terminal: str) -> None:
        for entry in self.__ledger.values():
            if entry["requestId"] == child.request_id and entry["status"] == "pending":
                entry["status"] = "unknown"
        if child.state in ("registered", "running"):
            child.state = terminal

    def cancel_child(self, handle: object) -> None:
        with self.__lock:
            child = self.__child(handle)
            pending = any(entry["requestId"] == child.request_id and entry["status"] == "pending" for entry in self.__ledger.values())
            self.__revoke(child, "unknown" if pending else "cancelled")

    def fail_child(self, handle: object) -> None:
        with self.__lock:
            child = self.__child(handle)
            pending = any(entry["requestId"] == child.request_id and entry["status"] == "pending" for entry in self.__ledger.values())
            self.__revoke(child, "unknown" if pending else "failed")

    def close(self) -> None:
        if getattr(self.__local, "dispatch_active", False):
            raise A2AContractError("close_inside_dispatch_forbidden")
        with self.__lock:
            self.__closed = True  # Revoke before waiting for the native queue.
            for child in self.__all_children:
                pending = any(entry["requestId"] == child.request_id and entry["status"] == "pending" for entry in self.__ledger.values())
                self.__revoke(child, "unknown" if pending else "cancelled")
        with self.__native_lock:
            # Only this runtime's callback. Real environment callbacks and
            # other trusted observers must survive close unchanged.
            for binding in self.__bindings.values():
                binding.app.add_event_callbacks.pop(self.__callback_key, None)

    def snapshot(self) -> dict[str, Any]:
        """Read-only projection; mutating it cannot grant or clear authority."""
        with self.__lock:
            return copy.deepcopy({"schemaVersion": "gaia2-local-a2a-projection-v1", "closed": self.__closed,
                "clockFailed": self.__clock_failed,
                "environmentGeneration": self.__environment, "parentExecutionId": self.__execution,
                "parentSessionId": self.__session,
                "children": [{**self.__scope(child), "state": child.state, "taskHash": child.task_hash,
                              "usedActions": child.used_actions, "actions": child.actions} for child in self.__all_children],
                "ledger": list(self.__ledger.values()), "receipts": self.__receipts,
                "productionDelegationEnabled": False, "tsIpcConnected": False})
