"""Trusted ARE generation-time pause lease.

This module is deliberately independent of the model broker and AppAgent
runner.  It binds one real ARE Environment/App/TimeManager instance, acquires
at most one pause lease for that environment, and releases only a pause that
it acquired itself.  It never accepts an Actor clock and never patches ARE.
"""

from __future__ import annotations

import hashlib
import inspect
import math
import os
from pathlib import Path
import threading
import time
import uuid
import weakref
from typing import Any

from are.simulation.apps.app import App
from are.simulation.environment import Environment
from are.simulation.time_manager import TimeManager
from are.simulation.types import EnvironmentState


class GenerationTimeError(RuntimeError):
    """Fixed safe error code; no trusted exception text is exposed."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


_HEX64 = "0123456789abcdef"
_GLOBAL_LOCK = threading.RLock()
_ACTIVE_LEASES: dict[int, tuple[Any, str]] = {}
_TERMINAL_STATES = (EnvironmentState.STOPPED, EnvironmentState.FAILED)


def _fail(code: str) -> None:
    raise GenerationTimeError(code) from None


def _finite_nonnegative(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except (OverflowError, ValueError, TypeError):
        return False


def _finite_number(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except (OverflowError, ValueError, TypeError):
        return False


def _path(value: Any) -> Path:
    try:
        source = inspect.getsourcefile(value)
    except (OSError, TypeError):
        source = None
    if source is None:
        try:
            source = inspect.getsourcefile(type(value))
        except (OSError, TypeError):
            source = None
    if source is None:
        _fail("GENERATION_SOURCE_UNAVAILABLE")
    return Path(os.path.abspath(source))


def _source_ref(value: Any) -> tuple[str, str, int]:
    path = Path(os.path.abspath(value)) if isinstance(value, (str, Path)) else _path(value)
    try:
        raw = path.read_bytes()
    except OSError:
        _fail("GENERATION_SOURCE_UNAVAILABLE")
    return str(path), hashlib.sha256(raw).hexdigest(), len(raw)


def _callable_snapshot(value: Any) -> tuple:
    function = getattr(value, "__func__", value)
    if not callable(function):
        _fail("GENERATION_METHOD_INVALID")
    try:
        code = getattr(function, "__code__", None)
        source = _source_ref(function)
        signature = str(inspect.signature(function))
        return (id(function), id(getattr(value, "__self__", None)), id(code), source,
            id(getattr(function, "__defaults__", None)), id(getattr(function, "__kwdefaults__", None)),
            getattr(function, "__qualname__", ""), signature)
    except (OSError, TypeError, ValueError):
        _fail("GENERATION_METHOD_INVALID")


def _source_hash(refs: tuple[tuple[str, str, int], ...]) -> str:
    payload = "\n".join(f"{path}\0{sha}\0{size}" for path, sha, size in refs).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _hex(value: Any, length: int) -> bool:
    return type(value) is str and len(value) == length and all(char in _HEX64 for char in value)


class ScopedAREGenerationTimeOwner:
    """One trusted pause lease owner for one actual ARE Environment.

    `acquire` requires a running environment and performs the real ARE pause.
    `release` performs at most one real resume, applying the trusted offset.
    All arguments are owner-side values; no Actor clock or endpoint is used.
    """

    def __init__(self, *, env: Environment, app: App,
                 trusted_source_files: tuple[str | Path, ...] = ()):
        if type(env) is not Environment or not isinstance(app, App):
            _fail("GENERATION_INITIALIZATION_INVALID")
        if env.apps.get(app.name) is not app or app.time_manager is not env.time_manager:
            _fail("GENERATION_ENVIRONMENT_BINDING_INVALID")
        if type(env.time_manager) is not TimeManager:
            _fail("GENERATION_ENVIRONMENT_BINDING_INVALID")
        refs = [_source_ref(type(self)), _source_ref(Environment), _source_ref(TimeManager), _source_ref(type(app))]
        for item in trusted_source_files:
            refs.append(_source_ref(item))
        self.__env = env
        self.__app = app
        self.__manager = env.time_manager
        self.__lock = threading.RLock()
        self.__refs = tuple(sorted(set(refs), key=lambda item: item[0].encode("utf-8")))
        self.__source_hash = _source_hash(self.__refs)
        self.__methods = ("start", "pause", "resume", "resume_with_offset", "time", "time_passed",
            "real_time_passed", "reset", "set_offset", "add_offset")
        # Freeze only the references needed for emergency cleanup after a
        # partially successful pause. Normal release still uses the freshly
        # verified environment method.
        self.__trusted_pause_event = env.pause_event
        self.__trusted_pause_event_clear = env.pause_event.clear
        self.__trusted_time_now = time.time
        self.__snapshot = self.__current_snapshot()
        self.__lease: dict[str, Any] | None = None
        self.__pause_state: dict[str, Any] | None = None
        self.__acquire_baseline: dict[str, Any] | None = None
        self.__pause_stamp: tuple | None = None
        self.__resume_attempted = False
        self.__closed = False
        self.__failed = False
        self.__failure_code: str | None = None

    @property
    def source_manifest_hash(self) -> str:
        return self.__source_hash

    def source_refs(self) -> list[dict]:
        """Detached, source-verified inventory for evaluator-side archival."""
        self.__check()
        return [{"path": path, "sha256": sha, "bytes": size}
                for path, sha, size in self.__refs]

    @property
    def environment_id(self) -> int:
        return id(self.__env)

    @property
    def lease_id(self) -> str | None:
        return None if self.__lease is None else self.__lease["leaseId"]

    def __current_snapshot(self) -> tuple:
        function = getattr(self.__manager.real_time_passed, "__func__", self.__manager.real_time_passed)
        time_module = getattr(function, "__globals__", {}).get("time")
        return (id(self.__env), type(self.__env), id(self.__app), type(self.__app),
            self.__app.name, id(self.__env.apps.get(self.__app.name)), id(self.__manager),
            type(self.__manager), id(self.__env.time_manager), type(self.__env.time_manager),
            id(self.__app.time_manager), id(self.__env.pause_event),
            tuple((name, _callable_snapshot(getattr(self.__env, name))) for name in
                ("start", "pause", "resume", "resume_with_offset", "tick", "log_debug")),
            tuple((name, _callable_snapshot(getattr(self.__manager, name))) for name in self.__methods[4:]),
            id(time_module), id(getattr(time_module, "time", None)),
            tuple((path, sha, size) for path, sha, size in self.__refs))

    def __check(self) -> None:
        if self.__closed:
            _fail("GENERATION_OWNER_CLOSED")
        if self.__failed:
            _fail(self.__failure_code or "GENERATION_OWNER_FAILED")
        self.__verify_binding()

    def __verify_binding(self) -> None:
        """Allow only identity verification during a failed acquire cleanup."""
        try:
            current = self.__current_snapshot()
            for path, expected, size in self.__refs:
                file = Path(path)
                raw = file.read_bytes()
                if len(raw) != size or hashlib.sha256(raw).hexdigest() != expected:
                    _fail("GENERATION_SOURCE_CHANGED")
        except GenerationTimeError as error:
            self.__failed = True
            self.__failure_code = self.__failure_code or error.code
            raise
        except BaseException:
            self.__failed = True
            self.__failure_code = self.__failure_code or "GENERATION_BINDING_CHANGED"
            _fail("GENERATION_BINDING_CHANGED")
        if current != self.__snapshot:
            self.__failed = True
            self.__failure_code = self.__failure_code or "GENERATION_BINDING_CHANGED"
            _fail("GENERATION_BINDING_CHANGED")
        if (self.__env.apps.get(self.__app.name) is not self.__app
                or self.__env.time_manager is not self.__manager or self.__app.time_manager is not self.__manager):
            self.__failed = True
            self.__failure_code = self.__failure_code or "GENERATION_BINDING_CHANGED"
            _fail("GENERATION_BINDING_CHANGED")

    def __safe_now(self) -> float:
        try:
            now = self.__manager.time()
        except BaseException:
            self.__failed = True
            _fail("GENERATION_CLOCK_INVALID")
        if not _finite_nonnegative(now):
            self.__failed = True
            _fail("GENERATION_CLOCK_INVALID")
        return float(now)

    def __clear_global(self, lease_id: str) -> None:
        with _GLOBAL_LOCK:
            current = _ACTIVE_LEASES.get(id(self.__env))
            if current is not None and current[0]() is self and current[1] == lease_id:
                _ACTIVE_LEASES.pop(id(self.__env), None)

    def __global_owned(self, lease_id: str) -> bool:
        with _GLOBAL_LOCK:
            current = _ACTIVE_LEASES.get(id(self.__env))
            return current is not None and current[0]() is self and current[1] == lease_id

    def __stamp(self) -> tuple:
        return (self.__manager.pause_real_start_time, self.__manager.pause_passed_time,
            self.__manager.pause_offset)

    def __owns_pause(self) -> bool:
        return (self.__env.state is EnvironmentState.PAUSED and self.__manager.is_paused is True
            and self.__env.pause_event.is_set() and self.__pause_stamp is not None
            and self.__lease is not None and self.__global_owned(self.__lease["leaseId"])
            and self.__stamp() == self.__pause_stamp)

    def __state(self) -> dict[str, Any]:
        return {"environmentState": self.__env.state, "pauseEventSet": self.__env.pause_event.is_set(),
            "offset": self.__manager.offset, "pauseRealStartTime": self.__manager.pause_real_start_time,
            "pausePassedTime": self.__manager.pause_passed_time, "pauseOffset": self.__manager.pause_offset,
            "isPaused": self.__manager.is_paused}

    def __same_receivers(self) -> bool:
        return (self.__env.time_manager is self.__manager
            and self.__app.time_manager is self.__manager
            and self.__env.pause_event is self.__trusted_pause_event)

    def __restore_acquire_state(self, baseline: dict[str, Any],
                                terminal_state: EnvironmentState | None = None) -> None:
        if not self.__same_receivers():
            _fail("GENERATION_PAUSE_CLEANUP_DENIED")
        self.__manager.offset = baseline["offset"]
        self.__manager.pause_real_start_time = baseline["pauseRealStartTime"]
        self.__manager.pause_passed_time = baseline["pausePassedTime"]
        self.__manager.pause_offset = baseline["pauseOffset"]
        self.__manager.is_paused = baseline["isPaused"]
        if not baseline["pauseEventSet"]:
            self.__trusted_pause_event_clear()
        self.__env.state = terminal_state or baseline["environmentState"]
        current = self.__state()
        expected = {**baseline, "environmentState": terminal_state or baseline["environmentState"]}
        if current != expected:
            _fail("GENERATION_PAUSE_CLEANUP_FAILED")

    def __resume_trusted(self, offset: float) -> None:
        lease_id = None if self.__lease is None else self.__lease["leaseId"]
        terminal_state = self.__env.state if self.__env.state in _TERMINAL_STATES else None
        if (not self.__same_receivers() or self.__pause_state is None or lease_id is None
                or not self.__global_owned(lease_id) or self.__pause_stamp is None
                or self.__stamp() != self.__pause_stamp or not self.__manager.is_paused):
            _fail("GENERATION_PAUSE_CLEANUP_DENIED")
        # ARE's terminal thread may already clear its pause_event. An exact
        # still-paused clock stamp/global owner remains the authority here.
        if not self.__env.pause_event.is_set() and terminal_state is None:
            _fail("GENERATION_PAUSE_CLEANUP_DENIED")
        if self.__env.state not in (EnvironmentState.PAUSED, EnvironmentState.RUNNING, *_TERMINAL_STATES):
            _fail("GENERATION_PAUSE_CLEANUP_DENIED")
        pause_start = self.__pause_state["pauseRealStartTime"]
        now = self.__trusted_time_now()
        if (not _finite_number(pause_start) or not _finite_number(now)
                or now < pause_start or not _finite_number(offset)):
            _fail("GENERATION_PAUSE_CLEANUP_DENIED")
        current_offset = self.__pause_state["offsetBeforePause"]
        pause_offset = self.__pause_state["pauseOffset"]
        if not _finite_number(current_offset) or not _finite_number(pause_offset):
            _fail("GENERATION_PAUSE_CLEANUP_DENIED")
        new_offset = current_offset - (now - pause_start) + pause_offset + offset
        if not math.isfinite(new_offset):
            _fail("GENERATION_PAUSE_CLEANUP_DENIED")
        self.__manager.offset = new_offset
        self.__manager.pause_offset = 0.0
        self.__manager.is_paused = False
        self.__manager.pause_passed_time = None
        self.__manager.pause_real_start_time = None
        self.__trusted_pause_event_clear()
        # Terminal cleanup removes only this owner's pause. It must not revive
        # the ARE event loop or clear its stop_event by calling env.resume().
        self.__env.state = terminal_state or EnvironmentState.RUNNING
        if (self.__env.state is not (terminal_state or EnvironmentState.RUNNING) or self.__manager.is_paused
                or self.__env.pause_event.is_set()):
            _fail("GENERATION_PAUSE_CLEANUP_FAILED")
        self.__lease.update({"released": True, "offset": float(offset), "cleanup": True})
        if terminal_state is not None:
            self.__lease["environmentState"] = terminal_state.value
        self.__clear_global(lease_id)

    def __cleanup_failed_acquire(self, baseline: dict[str, Any], lease_id: str) -> None:
        current = self.__state()
        terminal_state = current["environmentState"] if current["environmentState"] in _TERMINAL_STATES else None
        if (not self.__same_receivers() or (not current["pauseEventSet"] and terminal_state is None)
                or not self.__global_owned(lease_id)
                or self.__pause_stamp is None or self.__stamp() != self.__pause_stamp
                or current["environmentState"] not in (EnvironmentState.RUNNING, EnvironmentState.PAUSED, *_TERMINAL_STATES)
                or current == baseline or self.__resume_attempted):
            _fail("GENERATION_PAUSE_CLEANUP_DENIED")
        self.__resume_attempted = True
        try:
            self.__restore_acquire_state(baseline, terminal_state)
        except BaseException:
            _fail("GENERATION_PAUSE_CLEANUP_FAILED")

    def acquire(self, *, scope_hash: str, model_scope_hash: str, permit_id: str,
                request_id: str, actual_input_hash: str) -> dict:
        with self.__lock:
            return self.__acquire(scope_hash=scope_hash, model_scope_hash=model_scope_hash,
                permit_id=permit_id, request_id=request_id, actual_input_hash=actual_input_hash)

    def __acquire(self, *, scope_hash: str, model_scope_hash: str, permit_id: str,
                  request_id: str, actual_input_hash: str) -> dict:
        self.__check()
        if self.__lease is not None:
            _fail("GENERATION_LEASE_ACTIVE")
        if (not _hex(scope_hash, 64) or not _hex(model_scope_hash, 64)
                or not _hex(actual_input_hash, 64) or not _hex(permit_id, 32)
                or not _hex(request_id, 32)):
            _fail("GENERATION_LEASE_INVALID")
        with _GLOBAL_LOCK:
            active = _ACTIVE_LEASES.get(id(self.__env))
            if active is not None and active[0]() is not None:
                _fail("GENERATION_ENVIRONMENT_LEASE_ACTIVE")
        if (self.__env.state is not EnvironmentState.RUNNING or self.__manager.is_paused
                or self.__env.pause_event.is_set()):
            _fail("GENERATION_ENVIRONMENT_NOT_RUNNING")
        with _GLOBAL_LOCK:
            active = _ACTIVE_LEASES.get(id(self.__env))
            if active is not None and active[0]() is not None:
                _fail("GENERATION_ENVIRONMENT_LEASE_ACTIVE")
            lease_id = uuid.uuid4().hex
            _ACTIVE_LEASES[id(self.__env)] = (weakref.ref(self), lease_id)
        acquired_pause = False
        baseline = self.__state()
        self.__acquire_baseline = baseline
        try:
            before = self.__safe_now()
            self.__env.pause()
            # Capture our transition before verifying a callback that may have
            # drifted or stopped the environment during the actual pause.
            if self.__manager.is_paused is True and self.__env.pause_event.is_set():
                self.__pause_stamp = self.__stamp()
                self.__pause_state = {"offsetBeforePause": baseline["offset"],
                    "pauseRealStartTime": self.__manager.pause_real_start_time,
                    "pauseOffset": self.__manager.pause_offset}
                acquired_pause = True
            self.__verify_binding()
            after = self.__safe_now()
            passed = self.__manager.pause_passed_time
            if (self.__env.state is not EnvironmentState.PAUSED or not self.__manager.is_paused
                    or not self.__env.pause_event.is_set() or not _finite_nonnegative(passed) or passed <= 0):
                _fail("GENERATION_PAUSE_INVALID")
            self.__lease = {"leaseId": lease_id, "scopeHash": scope_hash, "modelScopeHash": model_scope_hash,
                "permitId": permit_id, "requestId": request_id, "actualInputHash": actual_input_hash,
                "sourceManifestHash": self.__source_hash,
                "beforeNow": before, "pausedNow": after, "pausePassedTime": float(passed),
                "released": False}
            self.__acquire_baseline = None
            return dict(self.__lease)
        except BaseException as error:
            if (not acquired_pause and (self.__env.pause_event.is_set()
                    or self.__env.state in _TERMINAL_STATES and self.__manager.is_paused)):
                self.__pause_stamp = self.__stamp()
                acquired_pause = True
            self.__failed = True
            cleanup_code = None
            try:
                if (self.__env.pause_event.is_set()
                        or self.__env.state in _TERMINAL_STATES and self.__manager.is_paused):
                    self.__cleanup_failed_acquire(baseline, lease_id)
            except BaseException as cleanup_error:
                cleanup_code = (cleanup_error.code if isinstance(cleanup_error, GenerationTimeError)
                                else "GENERATION_PAUSE_CLEANUP_FAILED")
            finally:
                self.__clear_global(lease_id)
            if isinstance(error, GenerationTimeError):
                if cleanup_code is not None:
                    error.cleanup_code = cleanup_code
                raise error from None
            if cleanup_code is not None:
                _fail("GENERATION_PAUSE_CLEANUP_FAILED")
            _fail("GENERATION_PAUSE_FAILED")

    def release(self, *, lease_id: str, offset: float) -> dict:
        with self.__lock:
            return self.__release(lease_id=lease_id, offset=offset)

    def __release(self, *, lease_id: str, offset: float) -> dict:
        if self.__lease is None or self.__lease["released"] or lease_id != self.__lease["leaseId"]:
            _fail("GENERATION_LEASE_NOT_ACTIVE")
        if not _finite_nonnegative(offset):
            _fail("GENERATION_OFFSET_INVALID")
        try:
            self.__check()
        except GenerationTimeError as error:
            self.__failed = True
            try:
                if self.__env.pause_event.is_set() and not self.__resume_attempted:
                    self.__resume_attempted = True
                    self.__resume_trusted(0.0)
            except BaseException as cleanup_error:
                # Preserve the original source/binding denial even when a
                # secondary cleanup attempt is unsafe. No authority is restored.
                error.cleanup_code = (cleanup_error.code if isinstance(cleanup_error, GenerationTimeError)
                                      else "GENERATION_PAUSE_CLEANUP_FAILED")
            finally:
                self.__clear_global(lease_id)
            raise error from None
        if not self.__owns_pause() or self.__resume_attempted:
            self.__failed = True
            try:
                if self.__env.pause_event.is_set() and not self.__resume_attempted:
                    self.__resume_attempted = True
                    self.__resume_trusted(0.0)
            except BaseException:
                self.__clear_global(lease_id)
                _fail("GENERATION_PAUSE_CLEANUP_FAILED")
            self.__clear_global(lease_id)
            _fail("GENERATION_PAUSE_STATE_CHANGED")
        try:
            before = self.__safe_now()
            self.__resume_attempted = True
            self.__env.resume_with_offset(float(offset))
            after = self.__safe_now()
        except GenerationTimeError:
            self.__failed = True
            try:
                if self.__env.pause_event.is_set():
                    self.__resume_trusted(0.0)
            except BaseException:
                self.__clear_global(lease_id)
                _fail("GENERATION_PAUSE_CLEANUP_FAILED")
            self.__clear_global(lease_id)
            raise
        except BaseException:
            self.__failed = True
            try:
                if self.__env.pause_event.is_set():
                    self.__resume_trusted(0.0)
            except BaseException:
                self.__clear_global(lease_id)
                _fail("GENERATION_PAUSE_CLEANUP_FAILED")
            self.__clear_global(lease_id)
            _fail("GENERATION_RESUME_FAILED")
        if self.__env.state is not EnvironmentState.RUNNING or self.__manager.is_paused:
            self.__failed = True
            try:
                if self.__env.pause_event.is_set():
                    self.__resume_trusted(0.0)
            except BaseException:
                self.__clear_global(lease_id)
                _fail("GENERATION_PAUSE_CLEANUP_FAILED")
            self.__clear_global(lease_id)
            _fail("GENERATION_RESUME_INVALID")
        self.__lease["released"] = True
        self.__lease["offset"] = float(offset)
        self.__lease["resumeBeforeNow"] = before
        self.__lease["resumeAfterNow"] = after
        self.__clear_global(lease_id)
        return dict(self.__lease)

    def cleanup(self, *, lease_id: str) -> dict:
        """Failure-only, idempotent cleanup of this exact pause lease.

        A released lease preserves its original credited offset. A terminal
        environment is never resumed to RUNNING. Safe physical cleanup after
        source drift does not repair the failed owner's capability: callers
        still receive its original fixed source/binding error.
        """
        with self.__lock:
            if self.__lease is None or lease_id != self.__lease["leaseId"]:
                _fail("GENERATION_LEASE_NOT_ACTIVE")
            if self.__lease["released"]:
                if self.__failure_code is not None:
                    _fail(self.__failure_code)
                return {**self.__lease, "cleanup": True}
            if self.__closed:
                _fail("GENERATION_OWNER_CLOSED")
            if self.__env.state in _TERMINAL_STATES:
                original_error = None
                try:
                    self.__check()
                except GenerationTimeError as error:
                    original_error = error
                try:
                    self.__resume_attempted = True
                    self.__resume_trusted(0.0)
                except GenerationTimeError as cleanup_error:
                    if original_error is not None:
                        original_error.cleanup_code = cleanup_error.code
                        raise original_error from None
                    raise
                if original_error is not None:
                    raise original_error from None
                return dict(self.__lease)
            released = self.__release(lease_id=lease_id, offset=0.0)
            return {**released, "cleanup": True}

    def snapshot(self) -> dict:
        self.__check()
        return {"schemaVersion": "gaia2-generation-time-owner-v1", "environmentId": id(self.__env),
            "appId": self.__app.name, "sourceManifestHash": self.__source_hash,
            "lease": None if self.__lease is None else dict(self.__lease),
            "closed": self.__closed, "failed": self.__failed}

    def close(self) -> None:
        with self.__lock:
            self.__close()

    def __close(self) -> None:
        if self.__closed:
            _fail("GENERATION_OWNER_CLOSED")
        if self.__lease is not None and not self.__lease["released"]:
            try:
                self.cleanup(lease_id=self.__lease["leaseId"])
            except GenerationTimeError:
                self.__clear_global(self.__lease["leaseId"])
                self.__failed = True
                self.__closed = True
                raise
        self.__closed = True
        if self.__lease is not None and self.__failed:
            _fail("GENERATION_OWNER_FAILED")
