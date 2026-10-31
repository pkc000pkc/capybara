"""Historical mutation facts from reviewed ARE native return contracts only.

This module never dispatches a tool, reads App storage, advances a clock or
consults a model. The Bridge brackets one actual dispatch with prepare/complete.
Unsupported methods and unsuccessful/unknown outcomes have no exemption. A
receipt proves that call completed, not that the resource is still unchanged.
"""
from __future__ import annotations

from dataclasses import dataclass
import inspect
import hashlib
import json
import math
import re
import sys

import gaia2_entity_evidence as pinning
from are.simulation.apps import email_client as native_email

SCHEMA = "gaia2-mutation-evidence-v1"
SOURCE_PINS = {**pinning.SOURCE_PINS,
    "simulation/apps/email_client.py": ("0da4b444925cef30e6945bff6c0d135d23fddc1c9c54c208acf889d606f24a57", 37989)}


class MutationEvidenceError(ValueError):
    def __init__(self, code):
        super().__init__("MUTATION_EVIDENCE_" + code)
        self.code = code


@dataclass(frozen=True)
class _Contract:
    id: str
    source: str
    module: object
    owner: type
    classes: tuple
    methods: dict


_CONTRACTS = (
    _Contract("are-1.2.0-calendar-mutation-v1", "simulation/apps/calendar.py",
        pinning.native_calendar, pinning.native_calendar.CalendarApp,
        (pinning.native_calendar.CalendarApp, pinning.native_calendar.Calendar,
         pinning.native_calendar_v2.CalendarV2),
        {"add_calendar_event": ("id", ("Event", None, None, None, None, None, None)),
         "delete_calendar_event": ("delete_event", None)}),
    _Contract("are-1.2.0-contacts-mutation-v1", "simulation/apps/contacts.py",
        pinning.native_contacts, pinning.native_contacts.ContactsApp,
        (pinning.native_contacts.ContactsApp, pinning.native_contacts.Contacts),
        {"add_new_contact": ("id", (None,) * 11),
         "edit_contact": ("edit_contact", None), "delete_contact": ("delete_contact", None)}),
    _Contract("are-1.2.0-email-mutation-v1", "simulation/apps/email_client.py",
        native_email, native_email.EmailClientV2, (native_email.EmailClientV2,),
        {"send_email": ("id", (None, "", "", None, None)),
         "reply_to_email": ("id", ("INBOX", "", None))}),
)


def _sources():
    result = pinning._reviewed_sources()
    if result is None:
        return None
    relative = "simulation/apps/email_client.py"
    path = pinning._ROOT / relative
    pinning._no_links(path)
    data = path.read_bytes()
    if len(data) != SOURCE_PINS[relative][1] or hashlib.sha256(data).hexdigest() != SOURCE_PINS[relative][0]:
        return None
    result[relative] = pinning._compiled(relative, data)
    return result


def _pin(tool, action):
    try:
        if (sys.version_info[:2] != (3, 12) or type(tool) is not pinning.native_tools.AppTool
                or type(action) is not dict):
            return None
        app, method = tool.class_instance, tool.func_name
        contract = next((c for c in _CONTRACTS if type(app) in c.classes and method in c.methods), None)
        if contract is None:
            return None
        arguments = action.get("arguments")
        if (type(arguments) is not dict or not pinning._plain_text(app.name)
                or tool.class_name != type(app).__name__ or tool.app_name != app.name
                or tool.name != app.name + "__" + method
                or action.get("canonicalName") != type(app).__name__ + "__" + method
                or action.get("resourceKey") != app.name
                or action.get("mutationKey") != pinning._hash({"tool": tool.name, "arguments": arguments})
                or tool.failure_probability is not None or tool.write_operation is not True
                or action.get("effect") != "write" or action.get("authoritativeRead") is not False):
            return None
        sources = _sources()
        if sources is None or pinning.native_types.EventRegisterer.is_capture_mode():
            return None
        checks = (
            (pinning.native_tools.AppTool.__call__, pinning.native_tools, "simulation/tool_utils.py", "AppTool.__call__"),
            (pinning.native_type_utils.check_type, pinning.native_type_utils, "simulation/utils/type_utils.py", "check_type"),
            (pinning.native_types.EventRegisterer.is_active.__func__, pinning.native_types, "simulation/types.py", "EventRegisterer.is_active"),
            (pinning.native_types.EventRegisterer.is_capture_mode.__func__, pinning.native_types, "simulation/types.py", "EventRegisterer.is_capture_mode"),
        )
        if not all(pinning._function_matches(*c, sources) for c in checks):
            return None
        outer = tool.function
        if (outer is not getattr(contract.owner, method) or outer is not getattr(type(app), method)
                or getattr(getattr(app, method), "__func__", None) is not outer):
            return None
        wrapper = getattr(outer, "__wrapped__", None)
        leaf = getattr(wrapper, "__wrapped__", None)
        if (not pinning._function_matches(outer, pinning.native_type_utils,
                "simulation/utils/type_utils.py", "type_check.<locals>.wrapper", sources)
                or not pinning._function_matches(wrapper, pinning.native_types, "simulation/types.py",
                "EventRegisterer.event_registered.<locals>.with_event.<locals>.wrapper", sources)
                # Some audited tools are inherited (for example
                # EmailClientV2.send_email). The leaf's immutable qualname is
                # used to locate the defining function in the pinned source;
                # the AppTool class/name checks above still bind the exposed
                # dispatch to the approved concrete App class.
                or not pinning._function_matches(leaf, contract.module, contract.source,
                leaf.__qualname__, sources)
                or getattr(leaf, "__wrapped__", None) is not None or leaf.__closure__ is not None
                or pinning._closure(outer) != {"func": wrapper}):
            return None
        cells = pinning._closure(wrapper)
        if (set(cells) != {"cls", "event_type", "func", "operation_type"}
                or cells["cls"] is not pinning.native_types.EventRegisterer
                or cells["func"] is not leaf or cells["event_type"] is not pinning.native_types.EventType.AGENT
                or cells["operation_type"] is not pinning.native_tools.OperationType.WRITE):
            return None
        for function in (outer, wrapper, leaf):
            if (function.__kwdefaults__ is not None or getattr(function, "llm_formatter", None) is not None
                    or getattr(function, "__operation_type__", None) is not pinning.native_tools.OperationType.WRITE):
                return None
        if (outer.__defaults__ is not None or wrapper.__defaults__ is not None
                or leaf.__defaults__ != contract.methods[method][1]):
            return None
        # Bind only the explicit parameters used by the actual dispatch; this
        # does not fill/change defaults or execute any business operation.
        inspect.signature(leaf).bind(app, **arguments)
        return contract, leaf, outer, wrapper
    except (AttributeError, OSError, ValueError, TypeError):
        return None


@dataclass(frozen=True)
class _Binding:
    owner: object
    tool: object
    action: dict
    pin: tuple


class MutationReceiptTracker:
    def __init__(self, execution_id, session_id):
        if not pinning._plain_text(execution_id) or not pinning._plain_text(session_id):
            raise MutationEvidenceError("identity")
        self.execution_id, self.session_id = execution_id, session_id
        self._owner, self._pending, self._seen = object(), {}, set()
        self._last_observed = None

    def prepare(self, tool, action):
        pin = _pin(tool, action)
        if pin is None:
            return None
        if not pinning._plain_text(action.get("id")):
            raise MutationEvidenceError("action_id")
        if action["id"] in self._seen:
            raise MutationEvidenceError("action_reuse")
        if len(self._seen) >= 8192:
            raise MutationEvidenceError("call_budget")
        binding = _Binding(self._owner, tool, json.loads(json.dumps(action, allow_nan=False)), pin)
        self._seen.add(action["id"])
        self._pending[id(binding)] = binding
        return binding

    def complete(self, binding, outcome, *, result=None, error=None, observed_at):
        if binding is None:
            return None
        if (type(binding) is not _Binding or binding.owner is not self._owner
                or self._pending.pop(id(binding), None) is not binding):
            raise MutationEvidenceError("binding")
        if (type(observed_at) not in (int, float) or not math.isfinite(observed_at) or observed_at < 0
                or self._last_observed is not None and observed_at < self._last_observed):
            raise MutationEvidenceError("clock")
        self._last_observed = observed_at
        if (type(outcome) is not dict or not pinning._is_hash(outcome.get("resultHash"))
                or outcome["resultHash"] != pinning._hash(result)
                or type(outcome.get("executed")) is not bool or type(outcome.get("complete")) is not bool):
            raise MutationEvidenceError("outcome")
        if (error is not None or outcome.get("status") != "succeeded"
                or outcome["complete"] is not True or outcome["executed"] is not True):
            return None
        current = _pin(binding.tool, binding.action)
        if current is None or any(a is not b for a, b in zip(current, binding.pin)):
            return None
        contract, leaf, _, _ = binding.pin
        action = binding.action
        form = contract.methods[binding.tool.func_name][0]
        if type(result) is not str:
            return None
        if form == "id":
            if re.fullmatch(r"[0-9a-f]{32}", result) is None:
                return None
        else:
            arg = "event_id" if form == "delete_event" else "contact_id"
            entity_id = action["arguments"].get(arg)
            if not pinning._plain_text(entity_id):
                return None
            expected = {"delete_event": f"Event {entity_id} successfully deleted.",
                        "delete_contact": f"Contact {entity_id} successfully deleted.",
                        "edit_contact": f"Contact {entity_id} updated successfully."}[form]
            if result != expected:
                return None
        evidence = {"schemaVersion": SCHEMA, "kind": "mutation_confirmed", "confirmation": "confirmed_applied",
            "executionId": self.execution_id, "sessionId": self.session_id, "resourceKey": action["resourceKey"],
            "callRef": {"actionId": action["id"], "canonicalName": action["canonicalName"],
                "queryHash": action["mutationKey"], "resultHash": outcome["resultHash"], "observedAt": observed_at},
            "contractRef": {"id": contract.id, "sourceSha256": SOURCE_PINS[contract.source][0],
                "callableSha256": pinning._digest(pinning._code_data(leaf.__code__)),
                "toolUtilsSha256": SOURCE_PINS["simulation/tool_utils.py"][0],
                "typesSha256": SOURCE_PINS["simulation/types.py"][0],
                "typeUtilsSha256": SOURCE_PINS["simulation/utils/type_utils.py"][0]},
            "nativeProof": {"kind": "returned_mutation", "exceptionType": None, "executed": True, "complete": True}}
        return {**evidence, "receiptId": pinning._digest(evidence)}
