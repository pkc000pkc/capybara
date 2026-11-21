"""Best-effort filesystem boundary for Python application workers."""
import builtins
import json
import os
import pathlib
import sys

try:
    _configured = json.loads(os.environ.get("CAPYBARA_ALLOWED_ROOTS", "[]"))
except Exception:
    _configured = []

_roots = [str(pathlib.Path(value).resolve()) for value in _configured if isinstance(value, str)]
_roots.extend([
    str(pathlib.Path.cwd().resolve()),
    str(pathlib.Path(sys.prefix).resolve()),
    str(pathlib.Path(sys.base_prefix).resolve()),
    str(pathlib.Path(sys.executable).resolve().parent),
])

def _allowed(value):
    if not isinstance(value, (str, bytes, os.PathLike)):
        return True
    try:
        candidate = pathlib.Path(os.fsdecode(value)).resolve()
    except Exception:
        return True
    return any(candidate == pathlib.Path(root) or str(candidate).startswith(str(pathlib.Path(root)) + os.sep) for root in _roots)

def _assert_allowed(value):
    if not _allowed(value):
        error = PermissionError(f"Capybara application path is outside its allowed roots: {value}")
        error.errno = 13
        error.args = (13, str(error))
        raise error

_original_open = builtins.open
def _guarded_open(file, *args, **kwargs):
    _assert_allowed(file)
    return _original_open(file, *args, **kwargs)
builtins.open = _guarded_open

_original_os_open = os.open
def _guarded_os_open(file, *args, **kwargs):
    _assert_allowed(file)
    return _original_os_open(file, *args, **kwargs)
os.open = _guarded_os_open
