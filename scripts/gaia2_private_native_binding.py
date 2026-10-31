"""Trusted single-App native owner for a private pipe, never an Actor API.

This slice retains ARE's actual Tool -> AppToolAdapter -> AppTool -> registered
function -> formatter call chain. It does not build an AppAgent, authorize a
delegation, supervise a process, or synchronize clocks. Legacy millisecond
deadlines stay opaque. The official trusted ARE-seconds opt-in compares the
bound deadline at native admission, using the actual Environment TimeManager.
The owner clock is checked for finite, monotonic observations.

Only frozen methods of this actual App are covered as internal native calls.
Other Apps' callbacks are not observable here: cross-App internal effects need
a future trusted Environment-wide observer and an explicit edge policy.
Python privacy is not a sandbox for hostile in-process Python code.
"""

from __future__ import annotations

import copy
import dataclasses
from decimal import Decimal
from fractions import Fraction
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
import gaia2_source_pinned_reads as source_pinned_reads
from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.agents.default_agent.default_tools import FinalAnswerTool
from are.simulation.apps.app import App
from are.simulation.environment import Environment
from are.simulation.time_manager import TimeManager
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
_CHILD_IDENTITY_KEYS = frozenset(("schemaVersion", "scopeHash", "environmentGeneration",
    "parentExecutionId", "parentSessionId", "appId", "parentCanonicalName",
    "taskArgumentKey", "toolInventoryHash", "taskHash", "parentActionId",
    "requestId", "childExecutionId", "childSessionId"))
_CHILD_IDENTITY_SCHEMA = "gaia2-child-identity-v1"
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_TICKET = re.compile(r"[0-9a-f]{32}\Z")
# Dataclass Apps (including Contacts/RentAFlat) are unhashable. Key by identity,
# with a weak-reference cleanup that cannot remove a later id-reused object.
_OWNERS: dict[int, weakref.ReferenceType] = {}
_OWNER_LOCK = threading.Lock()
_MAX_CHILDREN = 100000
_MAX_TICKETS = 100000
# Kept as private compatibility aliases; both callers share one reviewed policy.
_SOURCE_RETURN_PIN_ID = source_pinned_reads.SOURCE_RETURN_PIN_ID
_SOURCE_RETURN_FILES = source_pinned_reads.SOURCE_RETURN_FILES


def _source_return_pin(app: App, tool: AppTool, *, has_are_clock: bool) -> str | None:
    return source_pinned_reads.source_return_pin(app, tool, has_are_clock=has_are_clock)


def _source_return_state(app: App) -> None:
    # The reviewed implementation iterates only these containers/keys. Reject
    # overloaded containers whose iteration could execute an unrelated effect.
    if not source_pinned_reads.source_return_state_is_safe(app):
        _fail("NATIVE_SOURCE_RETURN_STATE_INVALID")


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


def _registry_json_number(value: int | float) -> str:
    """ECMAScript base-10 shortest round-trip, closest/even on a tie.

    The private wire has already rejected nonfinite/unsafe integral values.
    Fraction arithmetic chooses decimal digits without intermediate float
    rounding. Python repr is used only to bound the decimal exponent search,
    never as the result's digits or JSON spelling. Binary64 needs <=17 digits.
    See ECMA-262 Number::toString, radix 10, steps 5-12 and Note 2.
    """
    if value == 0:
        return "0"
    if type(value) is int or value.is_integer():
        return str(int(value))
    magnitude = abs(value)
    exact = Fraction.from_float(magnitude)
    exponent = Decimal(repr(magnitude)).adjusted()
    for count in range(1, 18):
        candidates = []
        for power in range(exponent - count, exponent - count + 3):
            scale = Fraction(10 ** power) if power >= 0 else Fraction(1, 10 ** -power)
            scaled = exact / scale
            floor = scaled.numerator // scaled.denominator
            for significand in (floor, floor + 1):
                if (significand <= 0 or len(str(significand)) != count
                        or count > 1 and significand % 10 == 0):
                    continue
                if float(f"{significand}e{power}") == magnitude:
                    candidates.append((abs(significand * scale - exact), significand % 2, significand, power))
        if not candidates:
            continue
        _, _, significand, power = min(candidates)
        digits = str(significand)
        position = len(digits) + power
        if -5 <= position <= 21:
            if position >= len(digits):
                result = digits + "0" * (position - len(digits))
            elif position > 0:
                result = digits[:position] + "." + digits[position:]
            else:
                result = "0." + "0" * -position + digits
        else:
            result = digits[0] + ("." + digits[1:] if len(digits) > 1 else "")
            result += "e" + ("+" if position - 1 >= 0 else "-") + str(abs(position - 1))
        return ("-" if value < 0 else "") + result
    _fail("NATIVE_REGISTRY_NUMBER_INVALID")


def _registry_canonical_json(value: Any) -> str:
    """Historical registry JSON, distinct from tagged private-wire bytes.

    Exactly the backend's recursive canonical(value): Object.keys().sort()
    uses UTF-16 order (including numeric-looking keys); leaves use
    JSON.stringify. Normalization also preserves the wire's existing bounds,
    rejection of unsafe values, and distinct bool/number identities.
    """
    value = _clone(value)
    def visit(item):
        if item is None:
            return "null"
        if type(item) is bool:
            return "true" if item else "false"
        if type(item) is str:
            return json.dumps(item, ensure_ascii=False, separators=(",", ":"))
        if type(item) in (int, float):
            return _registry_json_number(item)
        if type(item) is list:
            return "[" + ",".join(visit(child) for child in item) + "]"
        if type(item) is dict:
            keys = sorted(item, key=lambda key: key.encode("utf-16-be"))
            return "{" + ",".join(visit(key) + ":" + visit(item[key]) for key in keys) + "}"
        _fail("NATIVE_REGISTRY_VALUE_INVALID")
    return visit(value)


def _registry_action_hash(value: Any) -> str:
    return hashlib.sha256(_registry_canonical_json(value).encode("utf-8")).hexdigest()


def _sealed_native_evidence(ref: Any) -> dict:
    """Read a sealed private-owner/Host receipt, never an Actor value."""
    _exact(ref, {"path", "sha256"})
    if (type(ref["path"]) is not str or not Path(ref["path"]).is_absolute()
            or type(ref["sha256"]) is not str or not _HEX.fullmatch(ref["sha256"])):
        _fail("NATIVE_DISCARD_EVIDENCE_INVALID")
    try:
        target = Path(ref["path"])
        _no_links(target)
        if (not target.is_file()
                or os.path.normcase(str(target.resolve())) != os.path.normcase(str(target))):
            _fail("NATIVE_DISCARD_EVIDENCE_INVALID")
        data = target.read_bytes()
        if len(data) > 4 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != ref["sha256"]:
            _fail("NATIVE_DISCARD_EVIDENCE_INVALID")
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    _fail("NATIVE_DISCARD_EVIDENCE_INVALID")
                result[key] = value
            return result
        value = json.loads(data.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
                           parse_constant=lambda _: _fail("NATIVE_DISCARD_EVIDENCE_INVALID"))
        if type(value) is not dict:
            _fail("NATIVE_DISCARD_EVIDENCE_INVALID")
        return _clone(value)
    except (OSError, ValueError, UnicodeError):
        _fail("NATIVE_DISCARD_EVIDENCE_INVALID")


def _validate_native_blocked_before(*, scope: dict, action: dict, gate_decision: str,
                                    before_hook_ref: dict, before_clock_ref: dict,
                                    source_manifest_hash: str) -> dict:
    """Exact pre-execution negative proof; not permission to execute a tool."""
    if gate_decision not in ("block", "read_back"):
        _fail("NATIVE_DISCARD_GATE_INVALID")
    clock = _sealed_native_evidence(before_clock_ref)
    common = {"sourceManifestHash": source_manifest_hash, "scopeHash": wire.value_hash(scope),
        "dispatchId": action["dispatchId"], "toolId": action["toolId"],
        "canonicalName": action["canonicalName"], "toolKind": action["toolKind"], "effect": action["effect"],
        "rawArgumentsHash": clock.get("rawArgumentsHash"), "effectiveArgumentsHash": wire.value_hash(action["arguments"])}
    if (set(clock) != {"schemaVersion", *common, "ticketId", "checkpoint", "clock", "clockAuthority",
                       "revisionMeaning", "nativeReturnEvidenceRef"}
            or clock.get("schemaVersion") != "gaia2-private-native-clock-receipt-v1"
            or any(clock.get(key) != value for key, value in common.items())
            or type(clock["ticketId"]) is not str or not _TICKET.fullmatch(clock["ticketId"])
            or type(clock["rawArgumentsHash"]) is not str or not _HEX.fullmatch(clock["rawArgumentsHash"])
            or clock["checkpoint"] != "before_tool" or clock["nativeReturnEvidenceRef"] is not None
            or clock["clockAuthority"] != "ARE"
            or clock["revisionMeaning"] != "owner_observation_sequence_not_are_revision"
            or type(clock["clock"]) is not dict or set(clock["clock"]) != {"now", "revision"}
            or not _finite(clock["clock"]["now"]) or clock["clock"]["now"] < 0
            or type(clock["clock"]["revision"]) is not int or not 1 <= clock["clock"]["revision"] <= wire.MAX_SAFE_INTEGER):
        _fail("NATIVE_DISCARD_CLOCK_INVALID")
    before = _sealed_native_evidence(before_hook_ref)
    # The Host may attach trusted, derived Action metadata (for example
    # argumentHash/argumentFieldHashes) after the native binding has prepared
    # its ticket.  Reconstructing the projection from the Python ticket would
    # silently drop those fields and make an otherwise valid negative proof
    # fail closed.  Use the sealed Host Action as the canonical projection,
    # while still checking the fields that bind it to this private ticket.
    input_value = before.get("input")
    input_action = input_value.get("action") if type(input_value) is dict else None
    if (type(input_action) is not dict
            or input_action.get("id") != action["id"]
            or input_action.get("name") != action["toolId"]
            or input_action.get("canonicalName") != action["canonicalName"]
            or input_action.get("arguments") != action["arguments"]
            or input_action.get("effect") != action["effect"]
            or input_action.get("mutationKey") != action["mutationKey"]
            or input_action.get("resourceKey") != action["resourceKey"]
            or input_action.get("authoritativeRead") is not (action["effect"] == "read")):
        _fail("NATIVE_DISCARD_HOOK_INVALID")
    projected = dict(input_action)
    trusted = {"schemaVersion": "capybara-trusted-native-checkpoint-v1", "scopeHash": wire.value_hash(scope),
        "actionHash": wire.value_hash(action), "checkpoint": "before_tool", "clockEvidenceRef": before_clock_ref,
        "hookOutcome": None}
    hooks = before.get("hookReceipts")
    if (before.get("schemaVersion") != "capybara-runtime-plugin-invocation-v1"
            or before.get("executionId") != scope["childExecutionId"] or before.get("sessionId") != scope["childSessionId"]
            or "safetyFailure" not in before or before["safetyFailure"] is not None
            or wire.value_hash(before.get("input")) != wire.value_hash({"checkpoint": "before_tool", "action": projected, "clock": clock["clock"]})
            or wire.value_hash(before.get("trustedNativeCheckpoint")) != wire.value_hash(trusted)
            or type(before.get("decision")) is not dict or before["decision"].get("action") != gate_decision
            or type(hooks) is not list or not hooks or any(type(hook) is not dict or hook.get("status") != "passed" for hook in hooks)
            or not any(hook.get("matched") is True and hook.get("hookId") in
                       ("gaia2-a2a-guard", "gaia2-write-guard", "gaia2-conflict-gate")
                       and type(hook.get("decision")) is dict and hook["decision"].get("action") == gate_decision
                       for hook in hooks)):
        _fail("NATIVE_DISCARD_HOOK_INVALID")
    return clock


class NativeAppBinding:
    """Constructor/handler map are trusted owner facilities, not tool schemas."""

    def __init__(self, app: App, *, environment_generation: str,
                 parent_execution_id: str, parent_session_id: str,
                 evidence_root: str | Path, clock: Callable[[], float],
                 trusted_source_files: tuple[str | Path, ...] = (),
                 clock_environment: Environment | None = None,
                 deadline_clock_unit: str = "milliseconds"):
        if not isinstance(app, App) or not callable(clock):
            _fail("NATIVE_INITIALIZATION_INVALID")
        if type(deadline_clock_unit) is not str or deadline_clock_unit not in ("milliseconds", "seconds"):
            _fail("NATIVE_DEADLINE_CLOCK_UNIT_INVALID")
        if deadline_clock_unit == "seconds" and clock_environment is None:
            _fail("NATIVE_DEADLINE_CLOCK_AUTHORITY_REQUIRED")
        identities = (environment_generation, parent_execution_id, parent_session_id, app.name)
        if any(type(item) is not str or not item for item in identities):
            _fail("NATIVE_IDENTITY_INVALID")
        _clone(list(identities))
        self.__app = app
        self.__environment = environment_generation
        self.__execution = parent_execution_id
        self.__session = parent_session_id
        self.__clock = clock
        # Constructor authority only. Legacy millisecond scopes stay opaque;
        # only the official ARE-seconds opt-in enforces owner admission expiry.
        self.__deadline_clock_unit = deadline_clock_unit
        self.__last_clock = None
        self.__clock_failed = False
        # Legacy clock is operational only. ARE authority is opt-in and comes
        # exclusively from this actual Environment's shared TimeManager.
        if clock_environment is not None:
            if (type(clock_environment) is not Environment
                    or type(clock_environment.time_manager) is not TimeManager
                    or app.time_manager is not clock_environment.time_manager):
                _fail("NATIVE_CLOCK_ENVIRONMENT_INVALID")
            registered = clock_environment.apps.get(app.name)
            if registered is not app:
                # Official A2A replaces the native App with AppAgent in the
                # environment registry.  The wrapper's trusted AppToolAdapter
                # objects retain the original App instance; accepting exactly
                # that identity preserves ARE clock authority and event
                # logging without granting a caller arbitrary app access.
                tools = getattr(getattr(registered, "app_agent", None), "tools", None)
                if not isinstance(tools, dict) or not any(
                        getattr(getattr(tool, "app_tool", None), "class_instance", None) is app
                        for tool in tools.values()):
                    _fail("NATIVE_CLOCK_ENVIRONMENT_INVALID")
        self.__clock_environment = clock_environment
        self.__are_time_manager = clock_environment.time_manager if clock_environment is not None else None
        self.__are_last_clock = None
        self.__are_clock_failed = False
        self.__clock_revision = 0
        self.__clock_dispatches: dict[str, dict] = {}
        self.__closed = False
        self.__unknown = False
        self.__binding_failed = False
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
        self.__original_entries: list[dict] = []
        self.__excluded_tools: list[dict] = []
        self.__internal = {}
        self.__collect_methods()
        index = 0
        for original in self.__original_tools:
            if (not isinstance(original, AppTool) or original.class_instance is not app
                    or original.app_name != app.name
                    or type(original.name) is not str or not original.name
                    or type(original.write_operation) not in (bool, type(None))):
                _fail("NATIVE_TOOL_BINDING_INVALID")
            functions = _chain(original.function)
            expert = original.func_name == "expert_agent"
            if not expert and any(item.__name__ == "expert_agent" for item in functions):
                _fail("NATIVE_NESTED_EXPERT_FORBIDDEN")
            adapter = AppToolAdapter(original)
            entry = {
                "adapter": adapter, "original": original, "functions": functions,
                "signature": inspect.signature(original.function),
                "formatter": getattr(original.function, "llm_formatter", None),
                "completionEvidenceKind": "are_completed_event", "sourcePinId": None}
            # The authoritative ARE registry is retained intact. Unknown
            # metadata is an unsupported capability, never an inferred read;
            # its complete original entry remains source/identity-frozen.
            self.__original_entries.append(entry)
            if expert:
                continue
            tool_id = f"native-{index:04d}"
            index += 1
            if original.write_operation is None:
                source_pin = _source_return_pin(app, original, has_are_clock=clock_environment is not None)
                if source_pin is None:
                    self.__excluded_tools.append({
                        "publicName": adapter.name,
                        "canonicalName": f"{original.class_name}__{original.func_name}",
                        "reasonCode": "NATIVE_TOOL_EFFECT_UNDECLARED"})
                    continue
                entry["completionEvidenceKind"] = "source_pinned_return"
                entry["sourcePinId"] = source_pin
            self.__tools[tool_id] = entry
        final = FinalAnswerTool()
        self.__tools["final_answer"] = {"adapter": final, "original": None,
            "functions": _chain(final.forward), "signature": inspect.signature(final.forward),
            "formatter": None, "completionEvidenceKind": "child_final_answer", "sourcePinId": None}
        self.__version = 2 if any(entry["sourcePinId"] is not None for entry in self.__tools.values()) else 1
        public = [entry["adapter"].name for entry in self.__original_entries
                  if entry["original"].func_name != "expert_agent"] + [final.name]
        if any(type(name) is not str or not name for name in public) or len(set(public)) != len(public):
            _fail("NATIVE_TOOL_INVENTORY_INVALID")
        for required in (App, type(app), AppTool, AppToolAdapter, Tool, FinalAnswerTool,
                         AppAgent, EventRegisterer, CompletedEvent,
                         preflight.validate_tool_arguments, preflight.JsonScenarioExporter,
                         preflight.Scenario, wire.encode_value, type(app.time_manager)):
            self.__add_source_object(required)
        if clock_environment is not None:
            self.__add_source_object(Environment)
            self.__add_source_object(TimeManager)
        self.__add_source_path(Path(__file__))
        self.__add_source_object(source_pinned_reads.source_return_pin)
        for source in trusted_source_files:
            self.__add_source_path(Path(source))
        for entry in (*self.__original_entries, self.__tools["final_answer"]):
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
            self.__manifest = {"schemaVersion": f"gaia2-native-app-binding-v{self.__version}",
                "environmentGeneration": environment_generation,
                "parentExecutionId": parent_execution_id, "parentSessionId": parent_session_id,
                "appId": app.name, "appType": type(app).__module__ + "." + type(app).__qualname__,
                "evidenceRoot": str(root), "parentCanonicalName": "AppAgent__expert_agent",
                "taskArgumentKey": "task", "sourceRefs": sorted(self.__sources.values(), key=lambda ref: ref["path"].encode("utf-8")),
                "tools": tools, "toolInventoryHash": wire.value_hash(tools)}
            if self.__deadline_clock_unit == "seconds":
                self.__manifest["nativeAdmissionDeadline"] = {
                    "schemaVersion": "gaia2-native-admission-deadline-v1",
                    "unit": "seconds", "clockAuthority": "ARE"}
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
            metadata = {"toolId": tool_id, "publicName": adapter.name,
                "canonicalName": f"{original.class_name}__{original.func_name}" if original else "final_answer",
                "effect": "write" if original and original.write_operation else "read" if original else "finish",
                "toolKind": "app_tool" if original else "child_final_answer",
                "resourceKey": self.__app.name,
                "signatureHash": wire.value_hash(self.__signature_description(entry["signature"])),
                "formatterSourceHash": formatter_hash}
            if self.__version == 2:
                metadata.update(completionEvidenceKind=entry["completionEvidenceKind"],
                                sourcePinId=entry["sourcePinId"])
            result.append(metadata)
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
        # Freeze all original entries, not only the dispatch subset. Removing
        # an unknown tool from the manifest must not hide metadata, argument,
        # function/default or formatter drift on that still-registered tool.
        for entry in (*self.__original_entries, self.__tools["final_answer"]):
            original, adapter = entry["original"], entry["adapter"]
            formatter = getattr(original.function, "llm_formatter", None) if original else None
            metadata = None
            if original:
                metadata = (original.class_name, original.app_name, original.name,
                    original._public_name, original._public_description, original.function_description,
                    original.return_type, original.return_description, original.write_operation,
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
            if entry["sourcePinId"] is not None:
                entries.append((entry["sourcePinId"], _source_return_pin(self.__app, original,
                               has_are_clock=self.__clock_environment is not None)))
        internal = tuple((name, self.__function_snapshot(getattr(type(self.__app), name))) for name in self.__internal)
        clock_binding = None
        if self.__clock_environment is not None:
            env, manager = self.__clock_environment, self.__are_time_manager
            clock_binding = (id(env), type(env), id(env.time_manager), type(env.time_manager),
                id(env.apps.get(self.__app.name)), id(manager), type(manager),
                tuple(self.__function_snapshot(getattr(manager, name)) for name in
                    ("time", "time_passed", "real_time_passed", "reset", "pause", "resume", "set_offset", "add_offset")),
                tuple(self.__function_snapshot(getattr(env, name)) for name in
                    ("register_apps", "add_to_log", "pause", "resume", "resume_with_offset")),
                id(_function(manager.real_time_passed).__globals__.get("time")),
                id(getattr(_function(manager.real_time_passed).__globals__.get("time"), "time", None)))
        return (type(self.__app), self.__app.name, id(self.__app.time_manager),
                type(self.__deadline_clock_unit), self.__deadline_clock_unit,
                tuple(id(tool) for tool in self.__app.get_tools()), tuple(entries), internal,
                self.__function_snapshot(AppTool.__call__), self.__function_snapshot(App.add_event),
                self.__function_snapshot(self.__app.add_event),
                self.__function_snapshot(self.__app.time_manager.time),
                self.__function_snapshot(EventRegisterer.event_registered),
                self.__function_snapshot(EventRegisterer.is_active),
                self.__function_snapshot(EventRegisterer.is_capture_mode),
                self.__function_snapshot(preflight.validate_tool_arguments),
                tuple(self.__function_snapshot(function) for function in (
                    source_pinned_reads.source_return_pin,
                    source_pinned_reads.source_return_state_is_safe,
                    source_pinned_reads.shopping_getter_read_pin,
                    source_pinned_reads._code_shape,
                    source_pinned_reads._find_code,
                    source_pinned_reads._no_links)), clock_binding)

    def __check(self) -> None:
        if self.__closed:
            _fail("NATIVE_OWNER_CLOSED")
        if self.__binding_failed:
            _fail("NATIVE_BINDING_CHANGED")
        try:
            same = self.__current_snapshot() == self.__snapshot
            same = same and wire.value_hash(self.__manifest) == self.__manifest_hash
            expected_deadline = ({"schemaVersion": "gaia2-native-admission-deadline-v1",
                "unit": "seconds", "clockAuthority": "ARE"}
                if self.__deadline_clock_unit == "seconds" else None)
            same = same and (self.__manifest.get("nativeAdmissionDeadline") == expected_deadline
                if expected_deadline is not None else "nativeAdmissionDeadline" not in self.__manifest)
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
            self.__binding_failed = True
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

    def __are_now(self) -> float:
        """Actual ARE seconds, never legacy/Actor/model clock fallback."""
        if self.__clock_environment is None:
            _fail("NATIVE_CLOCK_AUTHORITY_UNAVAILABLE")
        if self.__are_clock_failed or self.__clock_failed:
            _fail("NATIVE_CLOCK_INVALID")
        try:
            now = self.__are_time_manager.time()
        except BaseException:
            now = None
        if not _finite(now) or now < 0 or self.__are_last_clock is not None and now < self.__are_last_clock:
            self.__are_clock_failed = True
            if self.__active is not None and self.__active["effect"] in ("write", "finish"):
                self.__unknown = True
            _fail("NATIVE_CLOCK_INVALID")
        self.__are_last_clock = now
        return now

    def __clock_evidence(self, ref: dict) -> None:
        try:
            _exact(ref, {"path", "sha256"})
            if type(ref["path"]) is not str or not re.fullmatch(r"json/[a-z0-9-]+\.json", ref["path"]):
                _fail("NATIVE_CLOCK_EVIDENCE_CHANGED")
            target = self.__root / ref["path"]
            _no_links(target)
            if not target.is_file() or hashlib.sha256(target.read_bytes()).hexdigest() != ref["sha256"]:
                _fail("NATIVE_CLOCK_EVIDENCE_CHANGED")
        except BaseException:
            self.__are_clock_failed = True
            _fail("NATIVE_CLOCK_EVIDENCE_CHANGED")

    def observe_clock(self, payload: Any) -> dict:
        """Trusted private owner probe, independently bound to one dispatch.

        revision counts these owner observations, not ARE native revisions.
        An after sample of a terminal dispatch is historical evidence only;
        it cannot restore a native permit or manufacture a successful outcome.
        """
        _exact(payload, {"scope", "ticketId", "dispatchId", "checkpoint"})
        if self.__clock_environment is None:
            _fail("NATIVE_CLOCK_AUTHORITY_UNAVAILABLE")
        dispatch_id, ticket_id, checkpoint = payload["dispatchId"], payload["ticketId"], payload["checkpoint"]
        if (type(dispatch_id) is not str or type(ticket_id) is not str or not _TICKET.fullmatch(ticket_id)
                or type(checkpoint) is not str or checkpoint not in ("before_tool", "after_tool")):
            _fail("NATIVE_CLOCK_PROBE_INVALID")
        try:
            if str(uuid.UUID(dispatch_id)) != dispatch_id:
                _fail("NATIVE_CLOCK_PROBE_INVALID")
        except (ValueError, AttributeError):
            _fail("NATIVE_CLOCK_PROBE_INVALID")
        with self.__lock:
            self.__check()
            _, scope_hash = self.__scope_shape(payload["scope"])
            child = self.__children.get(payload["scope"]["requestId"])
            ticket = self.__tickets.get(ticket_id)
            if (child is None or child["hash"] != scope_hash or ticket is None or ticket["child"] is not child):
                _fail("NATIVE_CLOCK_SCOPE_INVALID")
            response = ticket["response"]
            common = {"sourceManifestHash": self.__manifest_hash, "scopeHash": child["hash"],
                "ticketId": ticket_id, "dispatchId": dispatch_id, "toolId": response["toolId"],
                "canonicalName": response["canonicalName"], "toolKind": response["toolKind"], "effect": response["effect"],
                "rawArgumentsHash": response["rawArgumentsHash"], "effectiveArgumentsHash": response["effectiveArgumentsHash"]}
            prior = self.__clock_dispatches.get(dispatch_id)
            native_return_ref = None
            if checkpoint == "before_tool":
                if (child["status"] != "running" or ticket["consumed"] or ticket.get("discarded") is True or dispatch_id in self.__dispatches
                        or prior is not None or any(item["binding"]["ticketId"] == ticket_id for item in self.__clock_dispatches.values())):
                    _fail("NATIVE_CLOCK_BEFORE_INVALID_OR_REUSED")
            else:
                if (prior is None or prior["binding"] != common or not ticket["consumed"]
                        or dispatch_id not in self.__dispatches or prior["afterObserved"]
                        or prior["nativeReturnEvidenceRef"] is None
                        or self.__active is not None and self.__active["binding"]["dispatchId"] == dispatch_id):
                    _fail("NATIVE_CLOCK_AFTER_INVALID_OR_REUSED")
                native_return_ref = _clone(prior["nativeReturnEvidenceRef"])
            try:
                if checkpoint == "after_tool":
                    self.__clock_evidence(prior["beforeEvidenceRef"])
                    self.__clock_evidence(native_return_ref)
                now = self.__are_now()
                if self.__clock_revision >= wire.MAX_SAFE_INTEGER:
                    _fail("NATIVE_CLOCK_REVISION_EXHAUSTED")
                self.__clock_revision += 1
                clock = {"now": now, "revision": self.__clock_revision}
                evidence = self.__receipt("clock", {"schemaVersion": "gaia2-private-native-clock-receipt-v1",
                    **common, "checkpoint": checkpoint, "clock": clock, "clockAuthority": "ARE",
                    "revisionMeaning": "owner_observation_sequence_not_are_revision",
                    "nativeReturnEvidenceRef": native_return_ref})
            except BaseException:
                if checkpoint == "after_tool" and response["effect"] in ("write", "finish"):
                    self.__unknown = True
                    child["status"] = "unknown"
                raise
            if checkpoint == "before_tool":
                self.__clock_dispatches[dispatch_id] = {"binding": common, "beforeObserved": True,
                    "afterObserved": False, "nativeReturnEvidenceRef": None, "beforeEvidenceRef": _clone(evidence)}
            else:
                prior["afterObserved"] = True
            return _clone({"schemaVersion": "gaia2-private-native-clock-v1", "scopeHash": child["hash"],
                "ticketId": ticket_id, "dispatchId": dispatch_id, "checkpoint": checkpoint,
                "clock": clock, "evidenceRef": evidence})

    def manifest(self) -> dict:
        with self.__lock:
            self.__check()
            return _clone(self.__manifest)

    @property
    def bound_app(self) -> App:
        """Trusted in-process identity for a parent coordinator.

        This is not exposed through ``handlers()`` or the private pipe.  A
        coordinator uses identity (rather than only ``appId``) to ensure the
        child runner and the native owner target the same ARE App instance.
        """
        with self.__lock:
            self.__check()
            return self.__app

    @property
    def clock_environment(self) -> Environment | None:
        """Trusted ARE Environment identity, never Actor/pipe input."""
        with self.__lock:
            self.__check()
            return self.__clock_environment

    def inspect_app(self, payload: Any) -> dict:
        if payload is not None:
            _fail("NATIVE_PAYLOAD_INVALID")
        return self.manifest()

    def excluded_tool_snapshot(self) -> dict:
        """Answer-blind unsupported inventory, outside the strict pipe manifest.

        This trusted diagnostic API does not mutate ARE tools or grant a
        dispatch ID. Return a copy of the constructor-time exclusion list;
        drift cannot reclassify or silently rebaseline an excluded tool.
        """
        with self.__lock:
            self.__check()
            return _clone({"schemaVersion": "gaia2-private-native-excluded-tools-v1",
                "appId": self.__app.name, "toolCount": len(self.__excluded_tools),
                "sourceManifestHash": self.__manifest_hash,
                "tools": sorted(self.__excluded_tools,
                    key=lambda item: (item["publicName"], item["canonicalName"]))})

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

    def __child_identity(self, identity: Any, scope: dict, digest: str) -> dict:
        """Validate the fixed cross-process child identity envelope.

        The envelope carries only stable parent/child identity and the hash of
        the complete scope.  It is intentionally redundant with ``scope``:
        the redundancy makes a parent/child substitution fail at the Python
        boundary before any ticket or native callback can be created.
        """
        _exact(identity, _CHILD_IDENTITY_KEYS)
        expected = {
            "schemaVersion": _CHILD_IDENTITY_SCHEMA,
            "scopeHash": digest,
            "environmentGeneration": scope["environmentGeneration"],
            "parentExecutionId": scope["parentExecutionId"],
            "parentSessionId": scope["parentSessionId"],
            "appId": scope["appId"],
            "parentCanonicalName": scope["parentCanonicalName"],
            "taskArgumentKey": scope["taskArgumentKey"],
            "toolInventoryHash": scope["toolInventoryHash"],
            "taskHash": scope["taskHash"],
            "parentActionId": scope["parentActionId"],
            "requestId": scope["requestId"],
            "childExecutionId": scope["childExecutionId"],
            "childSessionId": scope["childSessionId"],
        }
        if identity != expected:
            _fail("NATIVE_CHILD_IDENTITY_MISMATCH")
        return _clone(identity)

    def __scope_payload(self, payload: Any, keys: frozenset[str], *, transport: bool = False) -> tuple[dict, str, dict | None]:
        _exact(payload, keys)
        scope, digest = self.__scope_shape(payload["scope"])
        identity = payload.get("identity")
        # Legacy direct in-process callers are retained for the controlled
        # d0 seam.  The inherited pipe handlers below always set transport=True
        # and therefore require the fixed identity envelope.
        if transport and identity is None:
            _fail("NATIVE_CHILD_IDENTITY_REQUIRED")
        checked = self.__child_identity(identity, scope, digest) if identity is not None else None
        return scope, digest, checked

    def bind_child(self, payload: Any) -> dict:
        _exact(payload, {"scope"} if "identity" not in payload else {"scope", "identity"})
        with self.__lock:
            self.__check()
            self.__now()
            scope, digest = self.__scope_shape(payload["scope"])
            identity = self.__child_identity(payload["identity"], scope, digest) if "identity" in payload else None
            if (scope["requestId"] in self.__children or scope["parentActionId"] in self.__parent_actions
                    or len(self.__children) >= _MAX_CHILDREN
                    or any(child["scope"]["childExecutionId"] == scope["childExecutionId"]
                           or child["scope"]["childSessionId"] == scope["childSessionId"] for child in self.__children.values())):
                _fail("NATIVE_CHILD_REUSED")
            self.__parent_actions.add(scope["parentActionId"])
            self.__children[scope["requestId"]] = {"scope": scope, "identity": identity or self.__child_identity({
                "schemaVersion": _CHILD_IDENTITY_SCHEMA, "scopeHash": digest,
                **{key: scope[key] for key in _CHILD_IDENTITY_KEYS if key not in ("schemaVersion", "scopeHash")}}, scope, digest),
                "hash": digest, "status": "running", "count": 0}
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
            if entry["sourcePinId"] is not None:
                _source_return_state(self.__app)
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
            if self.__version == 2:
                response.update(completionEvidenceKind=entry["completionEvidenceKind"],
                                sourcePinId=entry["sourcePinId"])
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
                if ticket is None or ticket["child"] is not child or ticket["consumed"] or ticket.get("discarded") is True:
                    _fail("NATIVE_TICKET_INVALID_OR_CONSUMED")
                response = ticket["response"]
                if (payload["toolId"] != response["toolId"] or payload["effectiveArgumentsHash"] != response["effectiveArgumentsHash"]
                        or payload["dispatchId"] in self.__dispatches):
                    _fail("NATIVE_TICKET_BINDING_MISMATCH")
                if self.__unknown and response["effect"] in ("write", "finish"):
                    _fail("NATIVE_UNRESOLVED_APP_MUTATION")
                entry = self.__tools[response["toolId"]]
                if entry["sourcePinId"] is not None:
                    _source_return_state(self.__app)
                if child["count"] >= child["scope"]["maxNativeActions"]:
                    _fail("NATIVE_BUDGET_EXHAUSTED")
                binding = {"sourceManifestHash": self.__manifest_hash, "scopeHash": child["hash"],
                    "ticketId": payload["ticketId"], "dispatchId": payload["dispatchId"],
                    "toolId": response["toolId"], "canonicalName": response["canonicalName"],
                    "toolKind": response["toolKind"], "effect": response["effect"],
                    "rawArgumentsHash": response["rawArgumentsHash"],
                    "effectiveArgumentsHash": response["effectiveArgumentsHash"]}
                native_admission = None
                clock_dispatch = self.__clock_dispatches.get(payload["dispatchId"])
                if self.__clock_environment is not None:
                    if (clock_dispatch is None or clock_dispatch["binding"]["ticketId"] != payload["ticketId"]
                            or clock_dispatch["binding"]["scopeHash"] != child["hash"]
                            or clock_dispatch["nativeReturnEvidenceRef"] is not None):
                        _fail("NATIVE_CLOCK_BEFORE_REQUIRED")
                    self.__clock_evidence(clock_dispatch["beforeEvidenceRef"])
                    admitted_at = self.__are_now()
                    if self.__deadline_clock_unit == "seconds":
                        # This fresh owner ARE sample is the admission
                        # linearization point, not a cached Hook/Actor time.
                        # No native body, ticket consumption or budget charge
                        # has happened here. OS preemption after admission is
                        # not a promise that an in-flight call cannot expire.
                        deadline = child["scope"]["deadline"]
                        if admitted_at >= deadline:
                            ticket["discarded"] = True
                            clock_dispatch["discarded"] = True
                            child["status"] = "failed"
                            self.__dispatches.add(payload["dispatchId"])
                            try:
                                refusal_ref = self.__receipt("admission-refusal", {
                                    "schemaVersion": "gaia2-private-native-admission-refusal-receipt-v1",
                                    **binding, "status": "rejected", "errorCode": "NATIVE_SCOPE_DEADLINE_EXPIRED",
                                    "nativeBodyStarted": False, "ticketRevoked": True, "childTerminated": True,
                                    "unit": "seconds", "clockAuthority": "ARE", "observedAt": admitted_at,
                                    "deadline": deadline, "beforeClockEvidenceRef": _clone(clock_dispatch["beforeEvidenceRef"])})
                            except BaseException:
                                # Revocation precedes writing: lost proof is a
                                # sticky failure, never a reusable reservation.
                                self.__binding_failed = True
                                _fail("NATIVE_ADMISSION_EVIDENCE_FAILED")
                            return _clone({"schemaVersion": "gaia2-private-native-admission-refusal-v1",
                                **binding, "status": "rejected", "errorCode": "NATIVE_SCOPE_DEADLINE_EXPIRED",
                                "refusalEvidenceRef": refusal_ref})
                        native_admission = {"schemaVersion": "gaia2-native-admission-v1",
                            "unit": "seconds", "clockAuthority": "ARE", "checkedAt": admitted_at,
                            "deadline": deadline, "status": "admitted"}
                ticket["consumed"] = True
                self.__dispatches.add(payload["dispatchId"])
                child["count"] += 1
                try:
                    dispatch_ref = self.__receipt("dispatch", {"schemaVersion": "gaia2-private-native-dispatch-v1",
                        **binding, "status": "pending", "ownerClock": native_admission["checkedAt"] if native_admission else self.__last_clock,
                        **({"nativeAdmission": native_admission} if native_admission else {})})
                except BaseException:
                    child["status"] = "unknown" if response["effect"] in ("write", "finish") else "failed"
                    if child["status"] == "unknown":
                        self.__unknown = True
                    _fail("NATIVE_DISPATCH_EVIDENCE_FAILED")
                active = {"thread": threading.get_ident(), "effect": response["effect"], "child": child,
                          "events": [], "eventError": None, "binding": binding}
                self.__active = active
            error_code = None
            returned = False
            result = None
            observation = observation_hash = raw_hash = ce_ref = None
            native_result = raw_projection = return_owner_clock = None
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
                        native_result = result
                    elif entry["sourcePinId"] is not None:
                        # ARE intentionally registers no event for this exact
                        # pure getter. The actual adapter return is the native
                        # result; an unrelated or forged event cannot replace it.
                        if active["events"]:
                            _fail("NATIVE_SOURCE_RETURN_UNEXPECTED_EVENT")
                        raw_hash = observation_hash
                        raw_projection = observation
                        native_result = result
                        return_owner_clock = self.__are_now()
                    else:
                        direct = [event for event in active["events"] if event["function"] in entry["functions"]]
                        if (len(direct) != 1 or direct[0]["completed"] is not True
                                or direct[0]["exception"] is not None
                                or direct[0]["effectiveArgumentsHash"] != response["effectiveArgumentsHash"]
                                or direct[0]["operation"] != response["effect"]):
                            _fail("NATIVE_DIRECT_EVENT_MISMATCH")
                        event = direct[0]
                        native_result = event["originalResult"]
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
                    raw_projection = return_owner_clock = None
                try:
                    return_body = {"schemaVersion": f"gaia2-private-native-return-v{self.__version}", **binding,
                        "status": status, "returned": returned, "agentObservation": observation,
                        "agentObservationHash": observation_hash, "nativeRawResultHash": raw_hash,
                        "nativeCompletedEventRef": ce_ref, "dispatchEvidenceRef": dispatch_ref, "errorCode": error_code}
                    if self.__version == 2:
                        return_body.update(completionEvidenceKind=entry["completionEvidenceKind"],
                            sourcePinId=entry["sourcePinId"], nativeRawProjection=raw_projection,
                            ownerClock=return_owner_clock)
                    native_return_ref = self.__receipt("return", return_body)
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
                if self.__clock_environment is not None:
                    clock_dispatch["nativeReturnEvidenceRef"] = _clone(native_return_ref)
                if status != "succeeded":
                    child["status"] = status
                elif response["toolKind"] == "child_final_answer":
                    child["status"] = "completed"
                if status == "succeeded":
                    self.__native_results[payload["dispatchId"]] = native_result
                    self.__agent_observations[payload["dispatchId"]] = result
                outcome = {"schemaVersion": f"gaia2-private-native-outcome-v{self.__version}",
                    **{key: value for key, value in binding.items() if key != "sourceManifestHash"},
                    "status": status, "agentObservation": observation, "agentObservationHash": observation_hash,
                    "nativeRawResultHash": raw_hash, "nativeCompletedEventRef": ce_ref,
                    "dispatchEvidenceRef": dispatch_ref, "nativeReturnEvidenceRef": native_return_ref,
                    "errorCode": error_code}
                if self.__version == 2:
                    outcome.update(completionEvidenceKind=entry["completionEvidenceKind"],
                                   sourcePinId=entry["sourcePinId"])
                return _clone(outcome)

    def discard_native(self, payload: Any) -> dict:
        """Revoke one uncommitted ticket after a real nonallow Host decision.

        This never samples an after clock, constructs a native return/event,
        consumes an observation, or removes uncertainty from any prior write.
        The dispatch mutex makes the no-active check and revocation atomic
        against the real commit path, including other bound child scopes.
        """
        _exact(payload, {"scope", "ticketId", "dispatchId", "beforeClockEvidenceRef", "beforeHookEvidenceRef", "gateDecision"})
        if (type(payload["ticketId"]) is not str or not _TICKET.fullmatch(payload["ticketId"])
                or type(payload["dispatchId"]) is not str or payload["gateDecision"] not in ("block", "read_back")):
            _fail("NATIVE_DISCARD_INVALID")
        try:
            if str(uuid.UUID(payload["dispatchId"])) != payload["dispatchId"]:
                _fail("NATIVE_DISCARD_INVALID")
        except (ValueError, AttributeError):
            _fail("NATIVE_DISCARD_INVALID")
        if not self.__dispatch_lock.acquire(blocking=False):
            _fail("NATIVE_DISCARD_ACTIVE")
        try:
            with self.__lock:
                self.__check()
                self.__now()
                child = self.__child(payload["scope"])
                ticket = self.__tickets.get(payload["ticketId"])
                prior = self.__clock_dispatches.get(payload["dispatchId"])
                if (self.__active is not None or self.__unknown or ticket is None or ticket["child"] is not child
                        or ticket["consumed"] is not False or ticket.get("discarded") is True
                        or payload["dispatchId"] in self.__dispatches or prior is None
                        or prior["binding"]["scopeHash"] != child["hash"]
                        or prior["binding"]["ticketId"] != payload["ticketId"] or prior["afterObserved"]
                        or prior["nativeReturnEvidenceRef"] is not None or prior.get("discarded") is True):
                    _fail("NATIVE_DISCARD_STATE_INVALID")
                response = ticket["response"]
                meta = next(item for item in self.__manifest["tools"] if item["toolId"] == response["toolId"])
                arguments_hash = _registry_action_hash(ticket["effective"])
                action = {key: value for key, value in meta.items() if key not in ("publicName", "signatureHash", "formatterSourceHash")}
                action.update(id=payload["dispatchId"], dispatchId=payload["dispatchId"], arguments=ticket["effective"],
                    argumentsHash=arguments_hash, mutationKey=_registry_action_hash([self.__environment, self.__app.name,
                        meta["resourceKey"], meta["canonicalName"], arguments_hash]))
                expected_ref = {"path": str(self.__root / prior["beforeEvidenceRef"]["path"]),
                                "sha256": prior["beforeEvidenceRef"]["sha256"]}
                if payload["beforeClockEvidenceRef"] != expected_ref:
                    _fail("NATIVE_DISCARD_CLOCK_BINDING_INVALID")
                observed = _validate_native_blocked_before(scope=payload["scope"], action=action,
                    gate_decision=payload["gateDecision"], before_hook_ref=payload["beforeHookEvidenceRef"],
                    before_clock_ref=payload["beforeClockEvidenceRef"], source_manifest_hash=self.__manifest_hash)
                if any(observed.get(key) != value for key, value in prior["binding"].items()):
                    _fail("NATIVE_DISCARD_CLOCK_BINDING_INVALID")
                try:
                    evidence = self.__receipt("discard", {"schemaVersion": "gaia2-private-native-discard-v1",
                        **prior["binding"], "gateDecision": payload["gateDecision"],
                        "beforeClockEvidenceRef": payload["beforeClockEvidenceRef"], "beforeHookEvidenceRef": payload["beforeHookEvidenceRef"],
                        "discarded": True, "consumed": False, "nativeStarted": False})
                except Exception:
                    # A lost negative receipt cannot become a reusable permit.
                    self.__binding_failed = True
                    _fail("NATIVE_DISCARD_EVIDENCE_FAILED")
                ticket["discarded"] = True
                prior["discarded"] = True
                return _clone({"schemaVersion": "gaia2-private-native-discard-ack-v1", "scopeHash": child["hash"],
                    "ticketId": payload["ticketId"], "dispatchId": payload["dispatchId"], "discarded": True, "evidenceRef": evidence})
        finally:
            self.__dispatch_lock.release()

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
        # Pipe-facing wrappers require the fixed identity envelope.  The
        # underlying methods continue to accept the legacy direct shape for
        # same-process d0 callers, but transport never does.
        def bind_child_transport(payload: Any) -> dict:
            if type(payload) is not dict or "identity" not in payload:
                _fail("NATIVE_CHILD_IDENTITY_REQUIRED")
            scope, digest, identity = self.__scope_payload(payload, frozenset(("scope", "identity")), transport=True)
            return self.bind_child({"scope": scope, "identity": identity})

        def prepare_native_transport(payload: Any) -> dict:
            if type(payload) is not dict or "identity" not in payload:
                _fail("NATIVE_CHILD_IDENTITY_REQUIRED")
            self.__scope_payload(payload, frozenset(("scope", "identity", "toolId", "rawArguments")), transport=True)
            return self.prepare_native({key: value for key, value in payload.items() if key != "identity"})

        def commit_native_transport(payload: Any) -> dict:
            if type(payload) is not dict or "identity" not in payload:
                _fail("NATIVE_CHILD_IDENTITY_REQUIRED")
            self.__scope_payload(payload, frozenset(("scope", "identity", "ticketId", "dispatchId", "toolId", "effectiveArgumentsHash")), transport=True)
            return self.commit_native({key: value for key, value in payload.items() if key != "identity"})

        def cancel_child_transport(payload: Any) -> dict:
            if type(payload) is not dict or "identity" not in payload:
                _fail("NATIVE_CHILD_IDENTITY_REQUIRED")
            self.__scope_payload(payload, frozenset(("scope", "identity")), transport=True)
            return self.cancel_child({"scope": payload["scope"]})

        result = {"inspect_app": self.inspect_app, "bind_child": bind_child_transport,
            "prepare_native": prepare_native_transport, "commit_native": commit_native_transport,
            "cancel_child": cancel_child_transport}
        if self.__clock_environment is not None:
            def observe_clock_transport(payload: Any) -> dict:
                if type(payload) is not dict or "identity" not in payload:
                    _fail("NATIVE_CHILD_IDENTITY_REQUIRED")
                self.__scope_payload(payload, frozenset(("scope", "identity", "ticketId", "dispatchId", "checkpoint")), transport=True)
                return self.observe_clock({key: value for key, value in payload.items() if key != "identity"})
            result["observe_clock"] = observe_clock_transport
            def discard_native_transport(payload: Any) -> dict:
                if type(payload) is not dict or "identity" not in payload:
                    _fail("NATIVE_CHILD_IDENTITY_REQUIRED")
                self.__scope_payload(payload, frozenset(("scope", "identity", "ticketId", "dispatchId",
                    "beforeClockEvidenceRef", "beforeHookEvidenceRef", "gateDecision")), transport=True)
                return self.discard_native({key: value for key, value in payload.items() if key != "identity"})
            result["discard_native"] = discard_native_transport
        return result

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
