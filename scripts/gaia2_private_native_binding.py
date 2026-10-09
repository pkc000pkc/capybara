"""Trusted single-App native owner for a private pipe, never an Actor API.

This slice retains ARE's actual Tool -> AppToolAdapter -> AppTool -> registered
function -> formatter call chain. It does not build an AppAgent, authorize a
delegation, supervise a process, or synchronize clocks. The TS deadline belongs
to the trusted TS owner; here it is bound but deliberately not compared with
ARE seconds. The owner clock is checked for finite, monotonic observations.

Only frozen methods of this actual App are covered as internal native calls.
Other Apps' callbacks are not observable here: cross-App internal effects need
a future trusted Environment-wide observer and an explicit edge policy.
Python privacy is not a sandbox for hostile in-process Python code.
"""

from __future__ import annotations

import copy
import dataclasses
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import re
import stat
import threading
import typing
import uuid
import weakref
from enum import Enum
from typing import Any, Callable

import gaia2_a2a_wire as wire
import gaia2_argument_preflight as preflight
from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.agents.default_agent.default_tools import FinalAnswerTool
from are.simulation.apps.app import App
from are.simulation.tool_utils import AppTool, AppToolAdapter, OperationType
from are.simulation.tools import Tool
from are.simulation.types import CompletedEvent, EventRegisterer, EventType


class NativeBindingError(RuntimeError):
    """Fixed codes only; never expose native exceptions, arguments or task text."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


_SCOPE_KEYS = frozenset(("parentExecutionId", "parentSessionId", "environmentGeneration",
    "appId", "parentCanonicalName", "taskArgumentKey", "toolInventoryHash", "taskHash",
    "parentActionId", "requestId", "childExecutionId", "childSessionId", "task",
    "deadline", "maxNativeActions"))
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_TICKET = re.compile(r"[0-9a-f]{32}\Z")
# Dataclass Apps (including Contacts/RentAFlat) are unhashable. Key by identity,
# with a weak-reference cleanup that cannot remove a later id-reused object.
_OWNERS: dict[int, weakref.ReferenceType] = {}
_OWNER_LOCK = threading.Lock()
_MAX_CHILDREN = 100000
_MAX_TICKETS = 100000


def _fail(code: str) -> typing.NoReturn:
    raise NativeBindingError(code) from None


def _clone(value: Any) -> Any:
    try:
        return wire.decode_value(wire.encode_value(value))
    except wire.A2AWireError:
        _fail("NATIVE_UNSAFE_VALUE")


def _exact(value: Any, keys: set[str] | frozenset[str]) -> None:
    if type(value) is not dict or set(value) != keys:
        _fail("NATIVE_PAYLOAD_INVALID")
    _clone(value)


def _finite(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except (OverflowError, TypeError, ValueError):
        return False


def _function(value: Any) -> Any:
    return value.__func__ if inspect.ismethod(value) else value


def _chain(value: Any) -> tuple[Any, ...]:
    result = []
    seen = set()
    value = _function(value)
    while value is not None:
        if not inspect.isfunction(value) or id(value) in seen or len(result) >= 64:
            _fail("NATIVE_CALLABLE_INVALID")
        seen.add(id(value))
        result.append(value)
        value = getattr(value, "__wrapped__", None)
    return tuple(result)


def _linked(path: Path) -> bool:
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _no_links(path: Path) -> None:
    for item in (path, *path.parents):
        try:
            if _linked(item):
                _fail("NATIVE_EVIDENCE_PATH_INVALID")
        except FileNotFoundError:
            continue


class NativeAppBinding:
    """Constructor/handler map are trusted owner facilities, not tool schemas."""

    def __init__(self, app: App, *, environment_generation: str,
                 parent_execution_id: str, parent_session_id: str,
                 evidence_root: str | Path, clock: Callable[[], float],
                 trusted_source_files: tuple[str | Path, ...] = ()):
        if not isinstance(app, App) or not callable(clock):
            _fail("NATIVE_INITIALIZATION_INVALID")
        identities = (environment_generation, parent_execution_id, parent_session_id, app.name)
        if any(type(item) is not str or not item for item in identities):
            _fail("NATIVE_IDENTITY_INVALID")
        _clone(list(identities))
        self.__app = app
        self.__environment = environment_generation
        self.__execution = parent_execution_id
        self.__session = parent_session_id
        self.__clock = clock
        self.__last_clock = None
        self.__clock_failed = False
        self.__closed = False
        self.__unknown = False
        self.__lock = threading.RLock()
        self.__dispatch_lock = threading.Lock()
        self.__active = None
        self.__children: dict[str, dict] = {}
        self.__parent_actions: set[str] = set()
        self.__tickets: dict[str, dict] = {}
        self.__dispatches: set[str] = set()
        self.__seen_events: set[str] = set()
        self.__native_results: dict[str, Any] = {}
        self.__agent_observations: dict[str, Any] = {}
        self.__failed_diagnostics: dict[str, dict] = {}
        self.__sources: dict[str, dict] = {}
        self.__tools: dict[str, dict] = {}
        self.__callback_key = "phase5-private-native-" + uuid.uuid4().hex
        self.__callback = self.__observe_event
        self.__environment_callbacks = tuple(app.add_event_callbacks.items())
        self.__original_tools = tuple(app.get_tools())
        self.__internal = {}
        self.__collect_methods()
        for index, original in enumerate(tool for tool in self.__original_tools
                                         if tool.func_name != "expert_agent"):
            if (not isinstance(original, AppTool) or original.class_instance is not app
                    or original.app_name != app.name or type(original.write_operation) is not bool):
                _fail("NATIVE_TOOL_BINDING_INVALID")
            functions = _chain(original.function)
            if any(item.__name__ == "expert_agent" for item in functions):
                _fail("NATIVE_NESTED_EXPERT_FORBIDDEN")
            adapter = AppToolAdapter(original)
            self.__tools[f"native-{index:04d}"] = {
                "adapter": adapter, "original": original, "functions": functions,
                "signature": inspect.signature(original.function),
                "formatter": getattr(original.function, "llm_formatter", None)}
        final = FinalAnswerTool()
        self.__tools["final_answer"] = {"adapter": final, "original": None,
            "functions": _chain(final.forward), "signature": inspect.signature(final.forward),
            "formatter": None}
        public = [entry["adapter"].name for entry in self.__tools.values()]
        if any(type(name) is not str or not name for name in public) or len(set(public)) != len(public):
            _fail("NATIVE_TOOL_INVENTORY_INVALID")
        for required in (App, type(app), AppTool, AppToolAdapter, Tool, FinalAnswerTool,
                         AppAgent, EventRegisterer, CompletedEvent,
                         preflight.validate_tool_arguments, preflight.JsonScenarioExporter,
                         preflight.Scenario, wire.encode_value, type(app.time_manager)):
            self.__add_source_object(required)
        self.__add_source_path(Path(__file__))
        for source in trusted_source_files:
            self.__add_source_path(Path(source))
        for entry in self.__tools.values():
            for function in entry["functions"]:
                self.__add_source_object(function)
                self.__add_annotation_sources(function)
            if entry["formatter"] is not None:
                for function in _chain(entry["formatter"]):
                    self.__add_source_object(function)
        self.__now()
        self.__snapshot = self.__current_snapshot()
        root = Path(os.path.abspath(os.fspath(evidence_root)))
        _no_links(root)
        if os.path.lexists(root) or not root.parent.is_dir():
            _fail("NATIVE_EVIDENCE_ROOT_NOT_FRESH")
        # A lifetime tombstone has no reference back to the App. A closed owner
        # cannot be replaced to erase an uncertain effect from this same object.
        with _OWNER_LOCK:
            if id(app) in _OWNERS and _OWNERS[id(app)]() is app:
                _fail("NATIVE_APP_ALREADY_OWNED")
            app_id = id(app)
            def forgotten(reference: weakref.ReferenceType) -> None:
                with _OWNER_LOCK:
                    if _OWNERS.get(app_id) is reference:
                        del _OWNERS[app_id]
            _OWNERS[app_id] = weakref.ref(app, forgotten)
        try:
            root.mkdir()
            (root / "json").mkdir()
            self.__root = root
            app.register_to_env(self.__callback_key, self.__callback)
            tools = self.__inventory()
            self.__manifest = {"schemaVersion": "gaia2-native-app-binding-v1",
                "environmentGeneration": environment_generation,
                "parentExecutionId": parent_execution_id, "parentSessionId": parent_session_id,
                "appId": app.name, "appType": type(app).__module__ + "." + type(app).__qualname__,
                "evidenceRoot": str(root), "parentCanonicalName": "AppAgent__expert_agent",
                "taskArgumentKey": "task", "sourceRefs": sorted(self.__sources.values(), key=lambda ref: ref["path"].encode("utf-8")),
                "tools": tools, "toolInventoryHash": wire.value_hash(tools)}
            self.__manifest_hash = wire.value_hash(self.__manifest)
        except BaseException:
            self.__closed = True
            app.add_event_callbacks.pop(self.__callback_key, None)
            raise

    def __add_source_path(self, path: Path) -> None:
        path = Path(os.path.abspath(path))
        _no_links(path)
        try:
            data = path.read_bytes()
        except (OSError, ValueError):
            _fail("NATIVE_SOURCE_UNAVAILABLE")
        self.__sources[str(path)] = {"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

    def __add_source_object(self, item: Any) -> None:
        try:
            source = inspect.getsourcefile(item)
        except (TypeError, OSError):
            source = None
        if source is None:
            _fail("NATIVE_SOURCE_UNAVAILABLE")
        self.__add_source_path(Path(source))

    def __add_annotation_sources(self, function: Any) -> None:
        def visit(value: Any) -> None:
            for child in typing.get_args(value):
                visit(child)
            if inspect.isclass(value) and value.__module__ != "builtins":
                source = inspect.getsourcefile(value)
                if source:
                    self.__add_source_path(Path(source))
        try:
            for annotation in typing.get_type_hints(function).values():
                visit(annotation)
        except (TypeError, NameError):
            _fail("NATIVE_ANNOTATION_INVALID")

    def __collect_methods(self) -> None:
        # Freeze every native event method, including helpers not public tools.
        for name in dir(type(self.__app)):
            value = getattr(type(self.__app), name, None)
            if not inspect.isfunction(value):
                continue
            functions = _chain(value)
            if any(getattr(fn, "__event_registered__", False) for fn in functions):
                self.__internal[name] = (value, functions)
                for function in functions:
                    self.__add_source_object(function)

    def __project(self, value: Any) -> Any:
        active: set[int] = set()
        budget = 100000

        def type_name(cls: type) -> str:
            try:
                path = inspect.getsourcefile(cls)
            except TypeError:
                path = None
            if path is None or str(Path(os.path.abspath(path))) not in self.__sources:
                _fail("NATIVE_RESULT_TYPE_UNBOUND")
            return cls.__module__ + "." + cls.__qualname__

        def visit(item: Any, depth: int) -> Any:
            nonlocal budget
            budget -= 1
            if depth > 64 or budget < 0:
                _fail("NATIVE_RESULT_LIMIT")
            cls = type(item)
            if item is None or cls in (bool, int, float, str):
                return _clone(item)
            if id(item) in active:
                _fail("NATIVE_RESULT_CYCLE")
            active.add(id(item))
            try:
                if cls is list:
                    return [visit(child, depth + 1) for child in item]
                if cls is dict:
                    if any(type(key) is not str for key in item):
                        _fail("NATIVE_RESULT_UNSUPPORTED")
                    return {key: visit(child, depth + 1) for key, child in item.items()}
                if cls is tuple:
                    return {"nativeType": "tuple", "items": [visit(child, depth + 1) for child in item]}
                if isinstance(item, Enum):
                    return {"nativeType": "enum", "typeName": type_name(cls),
                            "name": item.name, "value": visit(item.value, depth + 1)}
                if dataclasses.is_dataclass(item) and not inspect.isclass(item):
                    return {"nativeType": "dataclass", "typeName": type_name(cls),
                            "fields": {field.name: visit(getattr(item, field.name), depth + 1)
                                       for field in dataclasses.fields(item)}}
                _fail("NATIVE_RESULT_UNSUPPORTED")
            finally:
                active.remove(id(item))
        return _clone(visit(value, 0))

    def __signature_description(self, signature: inspect.Signature) -> dict:
        def annotation(value: Any) -> str | None:
            if value is inspect.Signature.empty:
                return None
            # Annotation text is source metadata, not arbitrary output values.
            if type(value) is str:
                return value
            return str(value)
        return {"parameters": [{"name": parameter.name, "kind": parameter.kind.name,
                "annotation": annotation(parameter.annotation),
                "hasDefault": parameter.default is not inspect.Signature.empty,
                "default": None if parameter.default is inspect.Signature.empty else self.__project(parameter.default)}
                for parameter in signature.parameters.values()], "returnAnnotation": annotation(signature.return_annotation)}

    def __inventory(self) -> list[dict]:
        result = []
        for tool_id, entry in self.__tools.items():
            original, adapter = entry["original"], entry["adapter"]
            formatter = entry["formatter"]
            formatter_hash = None
            if formatter is not None:
                function = _chain(formatter)[0]
                path = str(Path(os.path.abspath(inspect.getsourcefile(function))))
                formatter_hash = wire.value_hash({"sourceSha256": self.__sources[path]["sha256"],
                    "qualname": function.__module__ + "." + function.__qualname__})
            result.append({"toolId": tool_id, "publicName": adapter.name,
                "canonicalName": f"{original.class_name}__{original.func_name}" if original else "final_answer",
                "effect": "write" if original and original.write_operation else "read" if original else "finish",
                "toolKind": "app_tool" if original else "child_final_answer",
                "resourceKey": self.__app.name,
                "signatureHash": wire.value_hash(self.__signature_description(entry["signature"])),
                "formatterSourceHash": formatter_hash})
        return _clone(result)

    def __function_snapshot(self, function: Any) -> tuple:
        return tuple((id(fn), id(fn.__code__), id(fn.__defaults__), id(fn.__kwdefaults__),
                      wire.value_hash(self.__project(fn.__defaults__)),
                      wire.value_hash(self.__project(fn.__kwdefaults__)),
                      wire.value_hash(self.__signature_description(inspect.signature(fn))),
                      tuple(id(cell.cell_contents) for cell in (fn.__closure__ or ())))
                     for fn in _chain(function))

    def __current_snapshot(self) -> tuple:
        entries = []
        for entry in self.__tools.values():
            original, adapter = entry["original"], entry["adapter"]
            formatter = getattr(original.function, "llm_formatter", None) if original else None
            metadata = None
            if original:
                metadata = (original.class_name, original.app_name, original.name,
                    original._public_name, original._public_description, original.write_operation,
                    type(original.write_operation), original.failure_probability, type(original.failure_probability),
                    original.failure_message_template, original.seed, type(original.seed),
                    id(original.rng), id(original.class_instance), id(original.function),
                    tuple((id(arg), arg.name, arg.arg_type, arg.has_default,
                           id(arg.default), type(arg.default), wire.value_hash(self.__project(arg.default)), id(arg.type_obj)) for arg in original.args))
            entries.append((id(adapter), id(original), adapter.name,
                wire.value_hash(self.__project(adapter.inputs)), metadata,
                self.__function_snapshot(original.function if original else adapter.forward),
                id(formatter), self.__function_snapshot(formatter) if formatter else None,
                self.__function_snapshot(adapter.forward), self.__function_snapshot(adapter.__call__)))
        internal = tuple((name, self.__function_snapshot(getattr(type(self.__app), name))) for name in self.__internal)
        return (type(self.__app), self.__app.name, id(self.__app.time_manager),
                tuple(id(tool) for tool in self.__app.get_tools()), tuple(entries), internal,
                self.__function_snapshot(AppTool.__call__), self.__function_snapshot(App.add_event),
                self.__function_snapshot(self.__app.add_event),
                self.__function_snapshot(self.__app.time_manager.time),
                self.__function_snapshot(EventRegisterer.event_registered),
                self.__function_snapshot(EventRegisterer.is_active),
                self.__function_snapshot(EventRegisterer.is_capture_mode),
                self.__function_snapshot(preflight.validate_tool_arguments))

    def __check(self) -> None:
        if self.__closed:
            _fail("NATIVE_OWNER_CLOSED")
        try:
            same = self.__current_snapshot() == self.__snapshot
            same = same and self.__app.add_event_callbacks.get(self.__callback_key) is self.__callback
            same = same and all(self.__app.add_event_callbacks.get(key) is callback
                                for key, callback in self.__environment_callbacks)
            for ref in self.__sources.values():
                path = Path(ref["path"])
                _no_links(path)
                data = path.read_bytes()
                same = same and len(data) == ref["bytes"] and hashlib.sha256(data).hexdigest() == ref["sha256"]
        except (Exception,):
            same = False
        if not same:
            self.__unknown = True
            _fail("NATIVE_BINDING_CHANGED")
        if not EventRegisterer.is_active() or EventRegisterer.is_capture_mode():
            _fail("NATIVE_EVENT_MODE_INVALID")

    def __now(self) -> float:
        if self.__clock_failed:
            _fail("NATIVE_CLOCK_INVALID")
        try:
            now = self.__clock()
        except BaseException:
            now = None
        if not _finite(now) or now < 0 or self.__last_clock is not None and now < self.__last_clock:
            self.__clock_failed = True
            if self.__active is not None and self.__active["effect"] in ("write", "finish"):
                self.__unknown = True
            _fail("NATIVE_CLOCK_INVALID")
        self.__last_clock = now
        return now

    def manifest(self) -> dict:
        with self.__lock:
            self.__check()
            return _clone(self.__manifest)

    def inspect_app(self, payload: Any) -> dict:
        if payload is not None:
            _fail("NATIVE_PAYLOAD_INVALID")
        return self.manifest()

    def __scope_shape(self, scope: Any) -> tuple[dict, str]:
        _exact(scope, _SCOPE_KEYS)
        expected = {"parentExecutionId": self.__execution, "parentSessionId": self.__session,
            "environmentGeneration": self.__environment, "appId": self.__app.name,
            "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
            "toolInventoryHash": self.__manifest["toolInventoryHash"]}
        if any(scope[key] != value for key, value in expected.items()):
            _fail("NATIVE_SCOPE_MISMATCH")
        for key in _SCOPE_KEYS - {"deadline", "maxNativeActions"}:
            if type(scope[key]) is not str or not scope[key]:
                _fail("NATIVE_SCOPE_INVALID")
        if (not _HEX.fullmatch(scope["taskHash"]) or hashlib.sha256(scope["task"].encode("utf-8")).hexdigest() != scope["taskHash"]
                or not _finite(scope["deadline"]) or scope["deadline"] < 0
                or type(scope["maxNativeActions"]) is not int or not 1 <= scope["maxNativeActions"] <= 100000):
            _fail("NATIVE_SCOPE_INVALID")
        return _clone(scope), wire.value_hash(scope)

    def bind_child(self, payload: Any) -> dict:
        _exact(payload, {"scope"})
        with self.__lock:
            self.__check()
            self.__now()
            scope, digest = self.__scope_shape(payload["scope"])
            if (scope["requestId"] in self.__children or scope["parentActionId"] in self.__parent_actions
                    or len(self.__children) >= _MAX_CHILDREN
                    or any(child["scope"]["childExecutionId"] == scope["childExecutionId"]
                           or child["scope"]["childSessionId"] == scope["childSessionId"] for child in self.__children.values())):
                _fail("NATIVE_CHILD_REUSED")
            self.__parent_actions.add(scope["parentActionId"])
            self.__children[scope["requestId"]] = {"scope": scope, "hash": digest, "status": "running", "count": 0}
            return {"scopeHash": digest}

    def __child(self, scope: Any) -> dict:
        _, digest = self.__scope_shape(scope)
        child = self.__children.get(scope["requestId"])
        if child is None or child["hash"] != digest:
            _fail("NATIVE_CHILD_SCOPE_INVALID")
        if child["status"] != "running":
            _fail("NATIVE_CHILD_TERMINAL")
        return child

    def prepare_native(self, payload: Any) -> dict:
        _exact(payload, {"scope", "toolId", "rawArguments"})
        with self.__lock:
            self.__check()
            self.__now()
            child = self.__child(payload["scope"])
            tool_id, arguments = payload["toolId"], payload["rawArguments"]
            if type(tool_id) is not str or tool_id not in self.__tools or type(arguments) is not dict:
                _fail("NATIVE_TOOL_OR_ARGUMENTS_INVALID")
            entry = self.__tools[tool_id]
            meta = next(item for item in self.__manifest["tools"] if item["toolId"] == tool_id)
            if self.__unknown and meta["effect"] in ("write", "finish"):
                _fail("NATIVE_UNRESOLVED_APP_MUTATION")
            if child["count"] >= child["scope"]["maxNativeActions"] or len(self.__tickets) >= _MAX_TICKETS:
                _fail("NATIVE_BUDGET_EXHAUSTED")
            original = entry["original"]
            try:
                bound = entry["signature"].bind(*((self.__app,) if original else ()), **arguments)
                bound.apply_defaults()
                effective = {key: value for key, value in bound.arguments.items() if key != "self"}
                effective = _clone(effective)
            except Exception:
                _fail("NATIVE_ARGUMENT_BINDING_INVALID")
            if original and preflight.validate_tool_arguments(original, arguments)["valid"] is not True:
                _fail("NATIVE_ARGUMENT_PREFLIGHT_REJECTED")
            ticket_id = uuid.uuid4().hex
            response = {"ticketId": ticket_id, "scopeHash": child["hash"], "toolId": tool_id,
                "canonicalName": meta["canonicalName"], "toolKind": meta["toolKind"], "effect": meta["effect"],
                "rawArgumentsHash": wire.value_hash(arguments), "effectiveArguments": effective,
                "effectiveArgumentsHash": wire.value_hash(effective)}
            self.__tickets[ticket_id] = {"child": child, "raw": copy.deepcopy(arguments),
                "effective": copy.deepcopy(effective), "response": _clone(response), "consumed": False}
            return _clone(response)

    def __receipt(self, prefix: str, body: dict) -> dict:
        _no_links(self.__root / "json")
        data = json.dumps(_clone(body), sort_keys=True, ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
        name = prefix + "-" + uuid.uuid4().hex + ".json"
        target, temp = self.__root / "json" / name, self.__root / "json" / (name + ".pending")
        try:
            with temp.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            # Link publishes complete bytes atomically and refuses replacement.
            os.link(temp, target)
            temp.unlink()
        except OSError:
            _fail("NATIVE_EVIDENCE_WRITE_FAILED")
        return {"path": "json/" + name, "sha256": hashlib.sha256(data).hexdigest()}

    def __observe_event(self, event: Any) -> None:
        with self.__lock:
            active = self.__active
            if active is None or active["thread"] != threading.get_ident():
                if isinstance(event, CompletedEvent) and type(event.event_id) is str:
                    self.__seen_events.add(event.event_id)
                return
            try:
                if (type(event) is not CompletedEvent or event.event_type is not EventType.AGENT
                        or event.action.app is not self.__app or type(event.event_id) is not str
                        or event.event_id in self.__seen_events or not event.event_id
                        or not _finite(event.event_time) or event.event_time < 0):
                    _fail("NATIVE_EVENT_INVALID")
                self.__seen_events.add(event.event_id)
                function = event.action.function
                method = next((name for name, (_, functions) in self.__internal.items() if function in functions), None)
                if method is None or method == "expert_agent":
                    _fail("NATIVE_INTERNAL_EVENT_UNBOUND")
                operation = event.action.operation_type
                if operation not in (OperationType.READ, OperationType.WRITE):
                    _fail("NATIVE_EVENT_INVALID")
                arguments = event.action.args
                if type(arguments) is not dict or arguments.get("self") is not self.__app:
                    _fail("NATIVE_EVENT_ARGUMENTS_INVALID")
                effective = _clone({key: value for key, value in arguments.items() if key != "self"})
                raw = self.__project(event.metadata.return_value)
                item = {"eventId": event.event_id, "eventTime": event.event_time,
                    "canonicalName": type(self.__app).__name__ + "__" + method,
                    "appId": self.__app.name, "operation": operation.value,
                    "completed": event.metadata.completed is True,
                    "exception": None if event.metadata.exception is None else "NATIVE_TOOL_FAILED",
                    "effectiveArgumentsHash": wire.value_hash(effective),
                    "nativeRawProjection": raw, "nativeRawResultHash": wire.value_hash(raw),
                    "function": function, "originalResult": event.metadata.return_value}
                active["events"].append(item)
                if active["effect"] == "read" and operation is OperationType.WRITE:
                    self.__unknown = True
                    _fail("NATIVE_INTERNAL_WRITE_NOT_GATED")
            except Exception as error:
                active["eventError"] = error.code if isinstance(error, NativeBindingError) else "NATIVE_EVENT_INVALID"
                if active["effect"] in ("write", "finish"):
                    self.__unknown = True

    def commit_native(self, payload: Any) -> dict:
        _exact(payload, {"scope", "ticketId", "dispatchId", "toolId", "effectiveArgumentsHash"})
        if (type(payload["ticketId"]) is not str or not _TICKET.fullmatch(payload["ticketId"])
                or type(payload["dispatchId"]) is not str):
            _fail("NATIVE_COMMIT_INVALID")
        try:
            if str(uuid.UUID(payload["dispatchId"])) != payload["dispatchId"]:
                _fail("NATIVE_COMMIT_INVALID")
        except (ValueError, AttributeError):
            _fail("NATIVE_COMMIT_INVALID")
        # No owner lock is held across the native call. close()/cancel_child()
        # revoke synchronously, including when called by a native callback.
        if self.__active is not None and self.__active["thread"] == threading.get_ident():
            _fail("NATIVE_REENTRANT_DISPATCH_FORBIDDEN")
        with self.__dispatch_lock:
            with self.__lock:
                self.__check()
                self.__now()
                child = self.__child(payload["scope"])
                ticket = self.__tickets.get(payload["ticketId"])
                if ticket is None or ticket["child"] is not child or ticket["consumed"]:
                    _fail("NATIVE_TICKET_INVALID_OR_CONSUMED")
                response = ticket["response"]
                if (payload["toolId"] != response["toolId"] or payload["effectiveArgumentsHash"] != response["effectiveArgumentsHash"]
                        or payload["dispatchId"] in self.__dispatches):
                    _fail("NATIVE_TICKET_BINDING_MISMATCH")
                if self.__unknown and response["effect"] in ("write", "finish"):
                    _fail("NATIVE_UNRESOLVED_APP_MUTATION")
                if child["count"] >= child["scope"]["maxNativeActions"]:
                    _fail("NATIVE_BUDGET_EXHAUSTED")
                ticket["consumed"] = True
                self.__dispatches.add(payload["dispatchId"])
                child["count"] += 1
                binding = {"sourceManifestHash": self.__manifest_hash, "scopeHash": child["hash"],
                    "ticketId": payload["ticketId"], "dispatchId": payload["dispatchId"],
                    "toolId": response["toolId"], "canonicalName": response["canonicalName"],
                    "toolKind": response["toolKind"], "effect": response["effect"],
                    "rawArgumentsHash": response["rawArgumentsHash"],
                    "effectiveArgumentsHash": response["effectiveArgumentsHash"]}
                try:
                    dispatch_ref = self.__receipt("dispatch", {"schemaVersion": "gaia2-private-native-dispatch-v1",
                        **binding, "status": "pending", "ownerClock": self.__last_clock})
                except BaseException:
                    child["status"] = "unknown" if response["effect"] in ("write", "finish") else "failed"
                    if child["status"] == "unknown":
                        self.__unknown = True
                    _fail("NATIVE_DISPATCH_EVIDENCE_FAILED")
                entry = self.__tools[response["toolId"]]
                active = {"thread": threading.get_ident(), "effect": response["effect"], "child": child,
                          "events": [], "eventError": None, "binding": binding}
                self.__active = active
            error_code = None
            returned = False
            result = None
            observation = observation_hash = raw_hash = ce_ref = None
            try:
                result = entry["adapter"](**ticket["raw"])
                returned = True
                # The callback already froze CE.return_value before formatter.
                observation = self.__project(result)
                observation_hash = wire.value_hash(observation)
                with self.__lock:
                    self.__check()
                    self.__now()
                    if child["status"] != "running":
                        _fail("NATIVE_CHILD_TERMINAL")
                    if active["eventError"]:
                        _fail(active["eventError"])
                    if any(event["completed"] is not True or event["exception"] is not None
                           for event in active["events"]):
                        _fail("NATIVE_INTERNAL_EVENT_FAILED")
                    if entry["original"] is None:
                        if active["events"]:
                            _fail("NATIVE_FINAL_UNEXPECTED_EVENT")
                        raw_hash = observation_hash
                    else:
                        direct = [event for event in active["events"] if event["function"] in entry["functions"]]
                        if (len(direct) != 1 or direct[0]["completed"] is not True
                                or direct[0]["exception"] is not None
                                or direct[0]["effectiveArgumentsHash"] != response["effectiveArgumentsHash"]
                                or direct[0]["operation"] != response["effect"]):
                            _fail("NATIVE_DIRECT_EVENT_MISMATCH")
                        event = direct[0]
                        raw_hash = event["nativeRawResultHash"]
                        if entry["formatter"] is None and raw_hash != observation_hash:
                            _fail("NATIVE_RETURN_EVENT_MISMATCH")
                        ce_ref = self.__receipt("completed-event", {"schemaVersion": "gaia2-private-native-ce-v1",
                            **binding, "nativeRawProjection": event["nativeRawProjection"],
                            "nativeRawResultHash": raw_hash, "eventId": event["eventId"], "eventTime": event["eventTime"],
                            "completed": True, "exception": None,
                            "formatterSourceHash": next(tool["formatterSourceHash"] for tool in self.__manifest["tools"] if tool["toolId"] == response["toolId"]),
                            "observedEvents": [{key: value for key, value in item.items()
                                if key not in ("function", "originalResult", "nativeRawProjection", "nativeRawResultHash")}
                                for item in active["events"]]})
            except BaseException as error:
                error_code = error.code if isinstance(error, NativeBindingError) else "NATIVE_TOOL_FAILED"
            with self.__lock:
                if self.__closed or child["status"] != "running":
                    error_code = error_code or ("NATIVE_OWNER_CLOSED" if self.__closed else "NATIVE_CHILD_TERMINAL")
                status = "succeeded" if error_code is None else "unknown" if response["effect"] in ("write", "finish") else "failed"
                if status == "unknown":
                    self.__unknown = True
                if status != "succeeded":
                    # Untrusted consumers receive no success-shaped return or
                    # CE after revocation/failure. The immutable files remain,
                    # with their private owner diagnostic association retained.
                    self.__failed_diagnostics[payload["dispatchId"]] = {
                        "agentObservation": observation, "agentObservationHash": observation_hash,
                        "nativeRawResultHash": raw_hash, "nativeCompletedEventRef": ce_ref,
                        "errorCode": error_code}
                    observation = observation_hash = raw_hash = ce_ref = None
                try:
                    native_return_ref = self.__receipt("return", {"schemaVersion": "gaia2-private-native-return-v1", **binding,
                        "status": status, "returned": returned, "agentObservation": observation,
                        "agentObservationHash": observation_hash, "nativeRawResultHash": raw_hash,
                        "nativeCompletedEventRef": ce_ref, "dispatchEvidenceRef": dispatch_ref, "errorCode": error_code})
                    # Complete the same snapshot/clock barrier before either
                    # original result becomes available to the trusted owner.
                    if status == "succeeded":
                        self.__check()
                        self.__now()
                except BaseException:
                    child["status"] = "unknown" if response["effect"] in ("write", "finish") else "failed"
                    if child["status"] == "unknown":
                        self.__unknown = True
                    self.__failed_diagnostics[payload["dispatchId"]] = {
                        "agentObservation": observation, "agentObservationHash": observation_hash,
                        "nativeRawResultHash": raw_hash, "nativeCompletedEventRef": ce_ref,
                        "errorCode": "NATIVE_COMPLETION_EVIDENCE_FAILED"}
                    raise NativeBindingError("NATIVE_COMPLETION_EVIDENCE_FAILED") from None
                finally:
                    self.__active = None
                if status != "succeeded":
                    child["status"] = status
                elif response["toolKind"] == "child_final_answer":
                    child["status"] = "completed"
                if status == "succeeded":
                    self.__native_results[payload["dispatchId"]] = event["originalResult"] if entry["original"] else result
                    self.__agent_observations[payload["dispatchId"]] = result
                return _clone({"schemaVersion": "gaia2-private-native-outcome-v1",
                    **{key: value for key, value in binding.items() if key != "sourceManifestHash"},
                    "status": status, "agentObservation": observation, "agentObservationHash": observation_hash,
                    "nativeRawResultHash": raw_hash, "nativeCompletedEventRef": ce_ref,
                    "dispatchEvidenceRef": dispatch_ref, "nativeReturnEvidenceRef": native_return_ref,
                    "errorCode": error_code})

    def cancel_child(self, payload: Any) -> dict:
        _exact(payload, {"scope"})
        with self.__lock:
            self.__check()
            self.__now()
            child = self.__child(payload["scope"])
            child["status"] = "cancelled"
            if self.__active is not None and self.__active["child"] is child and self.__active["effect"] in ("write", "finish"):
                self.__unknown = True
                child["status"] = "unknown"
            return {"scopeHash": child["hash"], "status": child["status"]}

    def take_native_result(self, dispatch_id: str) -> Any:
        """Trusted owner only; not in handlers(). Return original object once."""
        with self.__lock:
            self.__check()
            self.__now()
            if dispatch_id not in self.__native_results:
                _fail("NATIVE_RESULT_UNAVAILABLE")
            return self.__native_results.pop(dispatch_id)

    def take_agent_observation(self, dispatch_id: str) -> Any:
        """Trusted owner only; actual adapter return, independently once-only."""
        with self.__lock:
            self.__check()
            self.__now()
            if dispatch_id not in self.__agent_observations:
                _fail("NATIVE_RESULT_UNAVAILABLE")
            return self.__agent_observations.pop(dispatch_id)

    def handlers(self) -> dict[str, Callable]:
        return {"inspect_app": self.inspect_app, "bind_child": self.bind_child,
            "prepare_native": self.prepare_native, "commit_native": self.commit_native,
            "cancel_child": self.cancel_child}

    def close(self) -> None:
        """Synchronous revocation, never waits for an in-flight native callback."""
        with self.__lock:
            if self.__closed:
                return
            self.__closed = True
            if self.__active is not None and self.__active["effect"] in ("write", "finish"):
                self.__unknown = True
            for child in self.__children.values():
                if child["status"] == "running":
                    child["status"] = "unknown" if self.__active is not None and self.__active["child"] is child else "cancelled"
            self.__app.add_event_callbacks.pop(self.__callback_key, None)
