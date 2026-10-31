"""Source-pinned native entity receipts, not a tool runner or result normalizer.

The trusted Bridge calls prepare immediately before its *real* native dispatch,
then complete with that dispatch's unchanged result, exception, outcome and ARE
timestamp. No native call, clock, model, private app storage or future event is
read here. In particular, an arbitrary ValueError/KeyError or error string never
establishes absence. A reviewed missing branch can verify only the exact entity
previously deleted successfully in this execution/session.

Receipt IDs are audit identities, NOT native entity versions. Unsupported code,
methods, arguments and failures yield no semantic evidence; raw outcomes remain
the caller's property. Protocol misuse raises EntityEvidenceError fail-closed.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from functools import lru_cache
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import stat
import sys
import types
from typing import Any

from are.simulation import tool_utils as native_tools
from are.simulation import types as native_types
from are.simulation.apps import calendar as native_calendar
from are.simulation.apps import calendar_v2 as native_calendar_v2
from are.simulation.apps import contacts as native_contacts
from are.simulation.utils import type_utils as native_type_utils

SCHEMA = "gaia2-entity-evidence-v1"
# Reviewed ARE 1.2.0 bytes. Never learn these pins from the installed runtime.
SOURCE_PINS = {
    "simulation/apps/calendar.py": ("62ffa557068dd1e5983758f8f25423cb6e81a48f4191edace98a2e0173881c7c", 16748),
    "simulation/apps/calendar_v2.py": ("ff4b6851b76842729c55914d17caded5ab739aa8fe1042fd7236ab0948226976", 2291),
    "simulation/apps/contacts.py": ("188862e4ba05bf06895321399c2dd1e54ef9a29fe9dc2573679abb98e5bcf47f", 15362),
    "simulation/tool_utils.py": ("dfbbe5bbfebd79b9aad214843e652600a4b7604d21a73b28d82bf9686d575f7f", 20251),
    "simulation/types.py": ("8d51f7d520b3f67cf956c1b22a9d619ed68aa5534cb6c6ab2f1c613b46ece7b3", 57410),
    "simulation/utils/type_utils.py": ("2804c0ccbab3ffa88484f81771670fd127b8e7562871a6406df75af1eaa47f5b", 3238),
}
_ROOT = Path(__file__).resolve().parents[1] / ".official-python" / "are"
_MISSING = object()


class EntityEvidenceError(ValueError):
    def __init__(self, code: str):
        super().__init__("ENTITY_EVIDENCE_" + code)
        self.code = code


def _hash(value: Any) -> str:
    # The Bridge's actual native result/query hash, not the canonical receipt ID.
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def _digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                    separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _plain_text(value: Any, maximum: int = 512) -> bool:
    return (type(value) is str and 0 < len(value) <= maximum and value == value.strip()
            and all(ord(char) >= 32 and ord(char) != 127 for char in value))


def _is_hash(value: Any) -> bool:
    return type(value) is str and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _code_data(code: types.CodeType) -> list:
    def constant(value):
        if type(value) is types.CodeType:
            return ["code", _code_data(value)]
        if type(value) is tuple:
            return ["tuple", [constant(child) for child in value]]
        if type(value) is bytes:
            return ["bytes", value.hex()]
        if value is None or type(value) in (bool, int, float, str):
            return [type(value).__name__, value]
        raise ValueError("unsupported code constant")
    return [code.co_name, code.co_qualname, code.co_argcount, code.co_posonlyargcount,
            code.co_kwonlyargcount, code.co_nlocals, code.co_stacksize, code.co_flags,
            code.co_code.hex(), [constant(v) for v in code.co_consts], list(code.co_names),
            list(code.co_varnames), list(code.co_freevars), list(code.co_cellvars),
            code.co_exceptiontable.hex(), code.co_firstlineno, code.co_linetable.hex()]


def _find_code(code: types.CodeType, name: str):
    if code.co_qualname == name:
        return code
    for value in code.co_consts:
        if type(value) is types.CodeType:
            found = _find_code(value, name)
            if found is not None:
                return found
    return None


def _no_links(path: Path):
    for part in (path, *path.parents):
        info = part.lstat()
        if stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400):
            raise ValueError("source path is a link")


@lru_cache(maxsize=6)
def _compiled(relative: str, data: bytes):
    return compile(data, str(_ROOT / relative), "exec", dont_inherit=True, optimize=0)


def _reviewed_sources():
    result = {}
    for relative, (sha, size) in SOURCE_PINS.items():
        path = _ROOT / relative
        _no_links(path)
        data = path.read_bytes()
        if len(data) != size or hashlib.sha256(data).hexdigest() != sha:
            return None
        result[relative] = _compiled(relative, data)
    return result


def _function_matches(function, module, relative, qualname, sources):
    expected = _find_code(sources[relative], qualname)
    return (inspect.isfunction(function) and expected is not None
            and function.__globals__ is vars(module)
            and Path(os.path.abspath(function.__code__.co_filename)) == _ROOT / relative
            and Path(os.path.abspath(module.__file__)) == _ROOT / relative
            and _code_data(function.__code__) == _code_data(expected))


def _closure(function):
    return dict(zip(function.__code__.co_freevars,
                    (cell.cell_contents for cell in (function.__closure__ or ()))))


@dataclass(frozen=True)
class _Contract:
    id: str
    entity_type: str
    argument: str
    getter: str
    deleter: str
    module: Any
    owner: Any
    classes: tuple
    source: str
    missing_line: int
    exception_type: type
    result_prefix: str


_CONTRACTS = (
    _Contract("are-1.2.0-calendar-entity-v1", "CalendarEvent", "event_id",
              "get_calendar_event", "delete_calendar_event", native_calendar,
              native_calendar.CalendarApp,
              (native_calendar.CalendarApp, native_calendar.Calendar, native_calendar_v2.CalendarV2),
              "simulation/apps/calendar.py", 279, ValueError, "EventID: "),
    _Contract("are-1.2.0-contacts-entity-v1", "Contact", "contact_id",
              "get_contact", "delete_contact", native_contacts, native_contacts.ContactsApp,
              (native_contacts.ContactsApp, native_contacts.Contacts),
              "simulation/apps/contacts.py", 221, KeyError, "Contact ID: "),
)


def _pin(tool, action):
    """Return reviewed leaf/wrappers or None; never inspect app storage."""
    try:
        if sys.version_info[:2] != (3, 12) or type(tool) is not native_tools.AppTool:
            return None
        app = tool.class_instance
        contract = next((item for item in _CONTRACTS if type(app) in item.classes), None)
        if contract is None or type(action) is not dict:
            return None
        method = tool.func_name
        if method not in (contract.getter, contract.deleter):
            return None
        arguments = action.get("arguments")
        if (type(arguments) is not dict or set(arguments) != {contract.argument}
                or not _plain_text(arguments[contract.argument]) or not _plain_text(app.name)
                or tool.class_name != type(app).__name__ or tool.app_name != app.name
                or tool.name != app.name + "__" + method
                or action.get("canonicalName") != type(app).__name__ + "__" + method
                or action.get("resourceKey") != app.name
                or action.get("mutationKey") != _hash({"tool": tool.name, "arguments": arguments})
                or tool.failure_probability is not None
                or tool.write_operation is not (method == contract.deleter)
                or action.get("effect") != ("write" if method == contract.deleter else "read")
                or action.get("authoritativeRead") is not (method == contract.getter)):
            return None
        sources = _reviewed_sources()
        if sources is None:
            return None
        checks = (
            (native_tools.AppTool.__call__, native_tools, "simulation/tool_utils.py", "AppTool.__call__"),
            (native_type_utils.check_type, native_type_utils, "simulation/utils/type_utils.py", "check_type"),
            (native_types.EventRegisterer.is_active.__func__, native_types, "simulation/types.py", "EventRegisterer.is_active"),
            (native_types.EventRegisterer.is_capture_mode.__func__, native_types, "simulation/types.py", "EventRegisterer.is_capture_mode"),
        )
        if not all(_function_matches(*check, sources) for check in checks):
            return None
        if native_types.EventRegisterer.is_capture_mode():
            return None
        outer = tool.function
        if outer is not getattr(contract.owner, method) or outer is not getattr(type(app), method):
            return None
        event_wrapper = getattr(outer, "__wrapped__", None)
        leaf = getattr(event_wrapper, "__wrapped__", None)
        if (not _function_matches(outer, native_type_utils, "simulation/utils/type_utils.py",
                                  "type_check.<locals>.wrapper", sources)
                or not _function_matches(event_wrapper, native_types, "simulation/types.py",
                    "EventRegisterer.event_registered.<locals>.with_event.<locals>.wrapper", sources)
                or not _function_matches(leaf, contract.module, contract.source,
                                           contract.owner.__name__ + "." + method, sources)
                or getattr(leaf, "__wrapped__", None) is not None
                or leaf.__closure__ is not None
                or _closure(outer) != {"func": event_wrapper}):
            return None
        cells = _closure(event_wrapper)
        operation = native_tools.OperationType.WRITE if method == contract.deleter else native_tools.OperationType.READ
        if (set(cells) != {"cls", "event_type", "func", "operation_type"}
                or cells["cls"] is not native_types.EventRegisterer or cells["func"] is not leaf
                or cells["event_type"] is not native_types.EventType.AGENT
                or cells["operation_type"] is not operation):
            return None
        for function in (outer, event_wrapper, leaf):
            if (function.__defaults__ is not None or function.__kwdefaults__ is not None
                    or getattr(function, "llm_formatter", None) is not None
                    or getattr(function, "__operation_type__", None) is not operation):
                return None
        if any(name in vars(contract.module) for name in ("ValueError", "KeyError")):
            return None
        return contract, leaf, outer, event_wrapper
    except (AttributeError, OSError, ValueError, TypeError):
        return None


@dataclass(frozen=True)
class _Binding:
    owner: object
    tool: Any
    action: dict
    contract: _Contract
    leaf: Any
    outer: Any
    event_wrapper: Any
    entity_key: tuple


class EntityEvidenceTracker:
    """Bounded session-local audit memory; never persists or replays a tool.

    complete is a trusted post-dispatch API, not an Actor-facing validator.
    A failed/missing proof is deliberately insufficient without the earlier
    exact successful delete receipt. Resource invalidation is conservative.
    """
    def __init__(self, execution_id: str, session_id: str):
        if not _plain_text(execution_id) or not _plain_text(session_id):
            raise EntityEvidenceError("identity")
        self.execution_id, self.session_id = execution_id, session_id
        self._owner = object()
        self._pending = {}
        self._seen = set()
        self._deletes = OrderedDict()
        self._last_observed = None

    def prepare(self, tool, action):
        pin = _pin(tool, action)
        if pin is None:
            return None
        if not _plain_text(action.get("id")):
            raise EntityEvidenceError("action_id")
        if action["id"] in self._seen:
            raise EntityEvidenceError("action_reuse")
        if len(self._seen) >= 512:
            raise EntityEvidenceError("call_budget")
        contract, leaf, outer, event_wrapper = pin
        snapshot = json.loads(json.dumps(action, ensure_ascii=False, allow_nan=False))
        # Resource aliases alone do not identify an actual native app owner.
        # The retained owner below also prevents Python object-ID reuse.
        key = (action["resourceKey"], contract.entity_type, action["arguments"][contract.argument], id(tool.class_instance))
        binding = _Binding(self._owner, tool, snapshot, contract, leaf, outer, event_wrapper, key)
        self._pending[id(binding)] = binding
        self._seen.add(action["id"])
        return binding

    def invalidate(self, resource_key=None, entity_type=None, entity_id=None):
        for value in (resource_key, entity_type, entity_id):
            if value is not None and not _plain_text(value):
                raise EntityEvidenceError("invalidation_scope")
        for key in list(self._deletes):
            if all(value is None or key[i] == value for i, value in enumerate((resource_key, entity_type, entity_id))):
                del self._deletes[key]

    def complete(self, binding, outcome, *, result=None, error=None, observed_at):
        if binding is None:
            return None
        if (type(binding) is not _Binding or binding.owner is not self._owner
                or self._pending.pop(id(binding), None) is not binding):
            raise EntityEvidenceError("binding")
        if (type(observed_at) not in (int, float) or not math.isfinite(observed_at) or observed_at < 0
                or self._last_observed is not None and observed_at < self._last_observed):
            raise EntityEvidenceError("clock")
        self._last_observed = observed_at
        if (type(outcome) is not dict or not _is_hash(outcome.get("resultHash"))
                or outcome["resultHash"] != _hash(result)
                or type(outcome.get("executed")) is not bool
                or type(outcome.get("complete")) is not bool):
            raise EntityEvidenceError("outcome")
        if outcome["executed"] is not True:
            return None
        pin = _pin(binding.tool, binding.action)
        if pin is None or any(a is not b for a, b in zip(pin, (binding.contract, binding.leaf, binding.outer, binding.event_wrapper))):
            self._deletes.pop(binding.entity_key, None)
            return None
        action, contract = binding.action, binding.contract
        entity_id = action["arguments"][contract.argument]
        call_ref = {"actionId": action["id"], "canonicalName": action["canonicalName"],
                    "queryHash": action["mutationKey"], "resultHash": outcome["resultHash"],
                    "observedAt": observed_at}
        kind, proof, delete_ref = None, None, None
        if action["effect"] == "write":
            self._deletes.pop(binding.entity_key, None)
            expected = ("Event " if contract.entity_type == "CalendarEvent" else "Contact ") + entity_id + " successfully deleted."
            if (error is not None or outcome.get("status") != "succeeded" or outcome["complete"] is not True
                    or type(result) is not str or result != expected):
                return None
            kind, proof = "delete_succeeded", {"kind": "returned_delete", "exceptionType": None, "branchLine": None}
            delete_ref = {"receiptId": _digest([self.execution_id, self.session_id, call_ref]), **call_ref}
            self._deletes[binding.entity_key] = {"receipt": delete_ref, "owner": binding.tool.class_instance}
            while len(self._deletes) > 64:
                self._deletes.popitem(last=False)
        elif error is None and outcome.get("status") == "succeeded" and outcome["complete"] is True:
            # Successful point reads invalidate deletion memory even when a
            # malformed presentation prevents us from exposing a present proof.
            self._deletes.pop(binding.entity_key, None)
            if type(result) is not str or not result.strip().startswith(contract.result_prefix + entity_id + "\n"):
                return None
            kind, proof = "entity_present", {"kind": "returned_entity", "exceptionType": None, "branchLine": None}
        else:
            if (outcome.get("status") not in ("failed", "failed_before_execution") or outcome["complete"] is not True
                    or not self._missing_branch(binding, error)):
                return None
            deletion = self._deletes.get(binding.entity_key)
            if deletion is None or deletion["owner"] is not binding.tool.class_instance:
                return None
            delete_ref = deletion["receipt"]
            if observed_at < delete_ref["observedAt"]:
                return None
            kind = "entity_absent"
            proof = {"kind": "missing_branch", "exceptionType": contract.exception_type.__name__,
                     "branchLine": contract.missing_line}
        return {"schemaVersion": SCHEMA, "kind": kind, "executionId": self.execution_id,
                "sessionId": self.session_id,
                "entityRef": {"resourceKey": binding.entity_key[0], "entityType": contract.entity_type, "entityId": entity_id},
                "callRef": call_ref,
                "contractRef": {"id": contract.id, "sourceSha256": SOURCE_PINS[contract.source][0],
                                "callableSha256": _digest(_code_data(binding.leaf.__code__)),
                                "toolUtilsSha256": SOURCE_PINS["simulation/tool_utils.py"][0],
                                "typesSha256": SOURCE_PINS["simulation/types.py"][0],
                                "typeUtilsSha256": SOURCE_PINS["simulation/utils/type_utils.py"][0]},
                "nativeProof": proof,
                "deleteReceiptRef": None if delete_ref is None else dict(delete_ref)}

    @staticmethod
    def _missing_branch(binding, error):
        if type(error) is not binding.contract.exception_type or error.__cause__ is not None:
            return False
        frames = []
        trace = error.__traceback__
        while trace is not None:
            frames.append(trace)
            trace = trace.tb_next
        if not frames:
            return False
        leaf = frames[-1]
        arguments = binding.action["arguments"]
        if (leaf.tb_frame.f_code is not binding.leaf.__code__
                or leaf.tb_lineno != binding.contract.missing_line
                or leaf.tb_frame.f_locals.get("self") is not binding.tool.class_instance
                or leaf.tb_frame.f_locals.get(binding.contract.argument, _MISSING) != arguments[binding.contract.argument]):
            return False
        # The missing branch must be reached through this actual AppTool and
        # the reviewed wrapper chain, not by raising a same-text error elsewhere.
        def has_frame(code, tool_frame=False):
            for item in frames:
                local = item.tb_frame.f_locals
                if item.tb_frame.f_code is not code:
                    continue
                if tool_frame:
                    if local.get("self") is binding.tool and local.get("args") == () and local.get("kwargs") == arguments:
                        return True
                elif (local.get("kwargs") == arguments
                      and (local.get("self") is binding.tool.class_instance
                           or local.get("args") == (binding.tool.class_instance,))):
                    return True
            return False
        return (has_frame(native_tools.AppTool.__call__.__code__, True)
                and has_frame(binding.outer.__code__) and has_frame(binding.event_wrapper.__code__))
