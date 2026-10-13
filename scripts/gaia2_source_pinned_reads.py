"""One reviewed official read exception; never infer effects from tool names.

These checks do not call a tool, replace its implementation, or invent native
completion evidence. The caller supplies clock authority from its trusted ARE
Environment; a model argument or a synthetic clock is not such authority.
"""

from __future__ import annotations

import hashlib
import inspect
import os
from pathlib import Path
import stat
import sys
import types
from typing import Any

from are.simulation.apps import shopping as official_shopping
from are.simulation.tool_utils import AppTool, AppToolAdapter
from are.simulation import tool_utils as official_tool_utils
from are.simulation import tools as official_tools
from are.simulation.tools import Tool


SOURCE_RETURN_PIN_ID = "are-1.2-shopping-discount-codes-read-v1"
# Reviewed ARE 1.2.0 bytes, not hashes learned from whichever files are installed.
SOURCE_RETURN_FILES = {
    "simulation/apps/shopping.py": ("7436b99640628ef737418396287fe8b7fb4912bd81bfee72e251a748aaeae205", 25517),
    "simulation/tool_utils.py": ("dfbbe5bbfebd79b9aad214843e652600a4b7604d21a73b28d82bf9686d575f7f", 20251),
    "simulation/tools.py": ("ba32076c4ab3089ea64c0a6e83813af8e9f54dbcb11d2bf4aa96a4a6cb1cad7c", 6774),
}


def _no_links(path: Path) -> None:
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400):
            raise ValueError("SOURCE_PIN_PATH_INVALID") from None


def _code_shape(code: types.CodeType) -> tuple:
    def constant(value: Any) -> Any:
        if type(value) is types.CodeType:
            return ("code", _code_shape(value))
        if type(value) is tuple:
            return ("tuple", tuple(constant(item) for item in value))
        if value is None or type(value) in (bool, int, float, str, bytes):
            return (type(value), value)
        raise ValueError("SOURCE_PIN_CODE_INVALID") from None
    return (code.co_name, code.co_qualname, code.co_argcount, code.co_posonlyargcount,
            code.co_kwonlyargcount, code.co_nlocals, code.co_stacksize, code.co_flags,
            code.co_code, tuple(constant(value) for value in code.co_consts),
            code.co_names, code.co_varnames, code.co_freevars, code.co_cellvars,
            code.co_exceptiontable)


def _find_code(code: types.CodeType, qualname: str) -> types.CodeType | None:
    if code.co_qualname == qualname:
        return code
    for child in code.co_consts:
        if type(child) is types.CodeType:
            result = _find_code(child, qualname)
            if result is not None:
                return result
    return None


def source_return_pin(app: Any, tool: Any, *, has_are_clock: bool) -> str | None:
    """Match exact official identity, metadata, file bytes, and loaded code.

    Compilation is comparison only: none of the compiled code is executed.
    State is checked separately so private owners retain their fixed rejection
    code for invalid state at prepare/commit time.
    """
    try:
        if (has_are_clock is not True or sys.version_info[:2] != (3, 12)
                or type(app) not in (official_shopping.ShoppingApp, official_shopping.Shopping)
                or type(tool) is not AppTool or tool.class_instance is not app
                or type(app.name) is not str):
            return None
        if any(type(value) is not str for value in (
                tool.class_name, tool.app_name, tool.func_name, tool.name,
                tool._public_name, tool.return_type, tool.return_description,
                tool.function_description, tool._public_description)):
            return None
        if (tool.class_name != type(app).__name__ or tool.app_name != app.name
                or tool.func_name != "get_all_discount_codes" or tool.write_operation is not None
                or tool.name != app.name + "__get_all_discount_codes"
                or tool._public_name != tool.name or type(tool.args) is not list or tool.args != []
                or tool.return_type != "dict[str, list[str]]"
                or tool.return_description != "Dictionary mapping discount codes to list of item IDs they apply to"
                or tool.function_description != "Returns all the discount codes that are available with the items they apply to."
                or tool._public_description != tool.function_description):
            return None
        function = tool.function
        if (not inspect.isfunction(function)
                or function is not official_shopping.ShoppingApp.get_all_discount_codes
                or getattr(type(app), "get_all_discount_codes") is not function
                or getattr(function, "__wrapped__", None) is not None
                or getattr(function, "llm_formatter", None) is not None
                or getattr(function, "__event_registered__", False) is not False
                or getattr(function, "__operation_type__", None) is not None
                or getattr(function, "_is_app_tool", None) is not True
                or getattr(function, "_is_data_tool", None) is not True
                or getattr(function, "_is_env_tool", False) is not False
                or getattr(function, "_is_user_tool", False) is not False
                or function.__defaults__ is not None or function.__kwdefaults__ is not None
                or function.__closure__ is not None):
            return None
        signature = inspect.signature(function)
        parameters = tuple(signature.parameters.values())
        if (len(parameters) != 1 or parameters[0].name != "self"
                or parameters[0].kind is not inspect.Parameter.POSITIONAL_OR_KEYWORD
                or parameters[0].default is not inspect.Parameter.empty
                or parameters[0].annotation is not inspect.Parameter.empty
                or signature.return_annotation != dict[str, list[str]]):
            return None
        root = Path(__file__).resolve().parents[1] / ".official-python" / "are"
        compiled = {}
        for relative, (expected_hash, expected_bytes) in SOURCE_RETURN_FILES.items():
            path = root / relative
            _no_links(path)
            data = path.read_bytes()
            if len(data) != expected_bytes or hashlib.sha256(data).hexdigest() != expected_hash:
                return None
            compiled[relative] = compile(data, str(path), "exec", dont_inherit=True, optimize=0)
        checks = (
            (function, official_shopping, "simulation/apps/shopping.py", "ShoppingApp.get_all_discount_codes"),
            (AppTool.__call__, official_tool_utils, "simulation/tool_utils.py", "AppTool.__call__"),
            (AppToolAdapter.forward, official_tool_utils, "simulation/tool_utils.py", "AppToolAdapter.forward"),
            (Tool.__call__, official_tools, "simulation/tools.py", "Tool.__call__"),
            (official_tools.handle_agent_inputs, official_tools, "simulation/tools.py", "handle_agent_inputs"),
            (official_tools.handle_agent_outputs, official_tools, "simulation/tools.py", "handle_agent_outputs"),
        )
        for actual, module, relative, qualname in checks:
            path = root / relative
            if (not inspect.isfunction(actual) or actual.__globals__ is not vars(module)
                    or Path(os.path.abspath(inspect.getsourcefile(actual))) != path
                    or Path(os.path.abspath(module.__file__)) != path):
                return None
            expected = _find_code(compiled[relative], qualname)
            if expected is None or _code_shape(actual.__code__) != _code_shape(expected):
                return None
    except (AttributeError, OSError, ValueError, TypeError):
        return None
    return SOURCE_RETURN_PIN_ID


def source_return_state_is_safe(app: Any) -> bool:
    """Reject overloaded getter containers/keys without iterating those objects."""
    if type(app) not in (official_shopping.ShoppingApp, official_shopping.Shopping):
        return False
    try:
        codes = app.discount_codes
    except AttributeError:
        return False
    return (type(codes) is dict and all(type(key) is str and type(value) is dict
            and all(type(code) is str for code in value) for key, value in codes.items()))


def shopping_getter_read_pin(app: Any, tool: Any, *, has_are_clock: bool = False) -> str | None:
    """Trusted bridge entry: the pin AND reviewed state must match each call."""
    pin = source_return_pin(app, tool, has_are_clock=has_are_clock)
    return pin if pin is not None and source_return_state_is_safe(app) else None
