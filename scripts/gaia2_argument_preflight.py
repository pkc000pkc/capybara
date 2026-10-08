"""Pure pre-execution official argument serialization checks.

No tool/function call, Event construction, capture mode or Trace import occurs.
Values are never coerced, defaults are only bound for checking, and only fixed
reason codes/counts escape. The full official Trace audit remains mandatory.
"""

from __future__ import annotations

import inspect
import math
from typing import Any

from are.simulation.data_handler.exporter import JsonScenarioExporter
from are.simulation.scenarios.scenario import Scenario
from are.simulation.tool_utils import AppTool


def safe_json_value(value: Any) -> bool:
    """Plain JSON values, finite floats and UTF-8 strings; no custom conversion."""
    ancestors: set[int] = set()
    remaining = 100000

    def visit(item: Any, depth: int) -> bool:
        nonlocal remaining
        remaining -= 1
        if remaining < 0 or depth > 64:
            return False
        kind = type(item)
        if item is None or kind in (bool, int):
            return True
        if kind is float:
            return math.isfinite(item)
        if kind is str:
            item.encode("utf-8", errors="strict")
            return True
        if kind not in (list, dict) or id(item) in ancestors:
            return False
        ancestors.add(id(item))
        try:
            if kind is list:
                return all(visit(child, depth + 1) for child in item)
            return all(type(key) is str and visit(key, depth + 1) and visit(child, depth + 1)
                       for key, child in item.items())
        finally:
            ancestors.remove(id(item))

    try:
        return visit(value, 0)
    except Exception:
        return False


def _same_json(left: Any, right: Any) -> bool:
    if type(left) is not type(right):
        return False
    if type(left) is list:
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right))
    if type(left) is dict:
        return left.keys() == right.keys() and all(_same_json(value, right[key]) for key, value in left.items())
    return left == right


def validate_tool_arguments(tool: Any, arguments: Any) -> dict[str, Any]:
    """Match AppTool's call prefix and official event bind/apply_defaults.

    The exporter skips only literal 'self'. A differently named instance (for
    example MCP's self_instance) cannot be silently dropped. **kwargs stays a
    bound dictionary exactly as in event_registered; metadata is not a signature.
    """
    def outcome(valid: bool, reason: str | None, count: int | None = None) -> dict[str, Any]:
        return {"schemaVersion": "gaia2-official-argument-preflight-v1",
                "valid": valid, "reason": reason, "parameterCount": count}

    if type(arguments) is not dict or not safe_json_value(arguments):
        return outcome(False, "unsafe_json_argument")
    if not isinstance(tool, AppTool) or not callable(tool.function):
        return outcome(False, "no_callable_tool")
    try:
        prefix = (tool.class_instance,) if tool.class_instance is not None else ()
        bound = inspect.signature(tool.function).bind(*prefix, **arguments)
        bound.apply_defaults()
    except Exception:
        return outcome(False, "argument_binding_failed")
    effective = {key: value for key, value in bound.arguments.items() if key != "self"}
    count = len(effective)
    for name, value in effective.items():
        if not safe_json_value(value):
            return outcome(False, "unsafe_json_argument", count)
        try:
            exported = JsonScenarioExporter.convert_action_args(name, value)
            restored = Scenario._parse_parameter_value(exported.value, exported.value_type)
            if not safe_json_value(restored) or not _same_json(value, restored):
                return outcome(False, "official_argument_not_roundtrippable", count)
        except Exception:
            return outcome(False, "official_argument_not_roundtrippable", count)
    return outcome(True, None, count)
