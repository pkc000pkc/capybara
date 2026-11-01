"""Trusted official-entry A2A client for the phase-5 private pipe.

The official ARE process owns the real Environment/App and therefore owns the
Python NativeAppBinding.  The Hook Host owns child RuntimePluginHost instances
and the delegation registry.  This module only carries the fixed private wire
between those two trusted owners; no Actor/model value selects a provider,
scope, app, or native callback.
"""

from __future__ import annotations

import copy
import hashlib
import math
import os
from pathlib import Path
import re
import select
import socket
import uuid
from typing import Any, Callable

import litellm
from litellm import completion as _sdk_completion

from gaia2_a2a_wire import PrivatePipePeer, value_hash
from gaia2_model_retry import ModelRetryPolicy
from gaia2_private_native_binding import NativeAppBinding
from gaia2_generation_time import ScopedAREGenerationTimeOwner
from gaia2_generation_time_ledger import ScopedGenerationTimeLedger
from gaia2_scoped_model_broker import ScopedRetryModelEngine, scoped_model_config_hash
from gaia2_scoped_app_agent import build_scoped_app_agent
from gaia2_runtime_hooks import HookProtocolError
from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.environment import Environment


class OfficialA2AError(RuntimeError):
    """Fixed adapter error; provider/native details never cross the seam."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _safe_text(value: Any) -> str:
    if type(value) is not str or not value:
        raise OfficialA2AError("A2A_VALUE_INVALID")
    value.encode("utf-8", errors="strict")
    return value


def _finite_number(value: Any) -> bool:
    """Return whether an ARE clock/deadline scalar is finite and safe to compare."""
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except (OverflowError, TypeError, ValueError):
        return False


# The source-pinned reader uses this marker, not optional event fields, to
# distinguish the ARE-seconds contract from legacy millisecond registries.
A2A_DEADLINE_CLOCK_CONTRACT = "gaia2-official-a2a-clock-v2"

_ID32 = re.compile(r"^[a-f0-9]{32}$")
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_UUID = re.compile(r"^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$")
_SCOPE_KEYS = frozenset((
    "parentExecutionId", "parentSessionId", "environmentGeneration", "appId",
    "parentCanonicalName", "taskArgumentKey", "toolInventoryHash", "taskHash",
    "parentActionId", "requestId", "childExecutionId", "childSessionId", "task",
    "deadline", "maxNativeActions",
))
_MODEL_EVENT_TYPES = frozenset((
    "model_logical_request_started", "model_request_attempt", "model_request_failed",
    "model_retry_scheduled", "model_retry_waiting", "model_request_succeeded",
    "model_request_rejected", "model_logical_request_finished",
))
_MODEL_EVENT_FIELDS = frozenset((
    "schemaVersion", "modelRole", "modelScopeHash", "configHash", "permitId",
    "requestId", "actualInputHash", "requestAttempt", "maxRequestAttempts",
    "cumulativeWaitSeconds", "category", "retryable", "httpStatus", "nextRetryAt",
    "retryExhausted", "waitSeconds", "delaySource", "cumulativeWaitSecondsAfterRetry",
    "remainingWaitSeconds", "outputHash", "usageAvailable", "usage", "status",
    "sdkAttempts", "failureCode",
    "classificationSource", "httpStatusSource", "httpGuardClosedRecordSha256",
))


def _app_ids(value: Any) -> tuple[str, ...]:
    """Canonical trusted owner inventory, not a model-selected App list."""
    if (type(value) not in (tuple, list) or not value
            or any(type(item) is not str or not _SAFE_ID.fullmatch(item) for item in value)
            or len(set(value)) != len(value)):
        raise OfficialA2AError("A2A_OWNER_APP_IDS_INVALID")
    return tuple(sorted(value))


def _pool_apps(env: Any, apps: Any) -> dict[str, AppAgent]:
    if type(env) is not Environment or type(apps) not in (tuple, list) or not apps:
        raise OfficialA2AError("A2A_POOL_APPS_INVALID")
    selected: dict[str, AppAgent] = {}
    for app in apps:
        name = getattr(app, "name", None)
        if (type(app) is not AppAgent or type(name) is not str or not _SAFE_ID.fullmatch(name)
                or name in selected or env.apps.get(name) is not app
                or not callable(getattr(app, "expert_agent", None))
                or getattr(app.expert_agent, "__func__", None) is not AppAgent.expert_agent):
            raise OfficialA2AError("A2A_POOL_APP_IDENTITY_INVALID")
        selected[name] = app
    # Include every official wrapper already installed by ARE. A caller may
    # not silently prepare a subset and add another owner later through Actor
    # arguments. Ordinary non-wrapper Apps are not delegation authorities.
    registered = {name: app for name, app in env.apps.items() if isinstance(app, AppAgent)}
    if set(registered) != set(selected) or any(registered[name] is not selected[name] for name in selected):
        raise OfficialA2AError("A2A_POOL_APP_SET_INVALID")
    return {name: selected[name] for name in sorted(selected)}


def _validate_scope(scope: Any, *, execution_id: str, session_id: str,
                   app_id: str, task: str, are_now: float) -> dict[str, Any]:
    """Validate the complete parent-issued child identity before storing it.

    The pipe already checks the scope on the Node side.  Repeating the identity
    check at this boundary prevents a Python adapter from accepting a response
    that is valid for a different parent/session or task.  This is deliberately
    a fixed-code validator; no provider or native exception text crosses it.
    """
    if (type(scope) is not dict or set(scope) != _SCOPE_KEYS
            or any(type(scope.get(key)) is not str or not scope[key]
                   for key in ("parentExecutionId", "parentSessionId", "environmentGeneration", "appId",
                               "parentCanonicalName", "taskArgumentKey", "toolInventoryHash", "taskHash",
                               "parentActionId", "requestId", "childExecutionId", "childSessionId", "task"))):
        raise OfficialA2AError("A2A_CHILD_IDENTITY_INVALID")
    if (scope["parentExecutionId"] != execution_id or scope["parentSessionId"] != session_id
            or scope["appId"] != app_id or scope["parentCanonicalName"] != "AppAgent__expert_agent"
            or scope["taskArgumentKey"] != "task" or scope["task"] != task
            or not _HASH.fullmatch(scope["toolInventoryHash"])
            or scope["taskHash"] != hashlib.sha256(task.encode("utf-8", errors="strict")).hexdigest()):
        raise OfficialA2AError("A2A_CHILD_IDENTITY_INVALID")
    if (not _SAFE_ID.fullmatch(scope["environmentGeneration"])
            or not _SAFE_ID.fullmatch(scope["parentActionId"])
            or not _SAFE_ID.fullmatch(scope["requestId"])
            or not _SAFE_ID.fullmatch(scope["childExecutionId"])
            or not _SAFE_ID.fullmatch(scope["childSessionId"])):
        raise OfficialA2AError("A2A_CHILD_IDENTITY_INVALID")
    if (not _finite_number(are_now)
            or not _finite_number(scope["deadline"])
            or not scope["deadline"] > are_now
            or type(scope["maxNativeActions"]) is not int
            or isinstance(scope["maxNativeActions"], bool) or scope["maxNativeActions"] < 1):
        raise OfficialA2AError("A2A_CHILD_SCOPE_INVALID")
    return dict(scope)


def _guard_receipt(*, scope: dict[str, Any], snapshot: dict[str, Any],
                   require_notification: bool, require_deadline: bool,
                   require_notification_pump: bool = False,
                   require_generation_time: bool = False) -> dict[str, Any]:
    """Create a fixed, answer-blind receipt for dynamic child guard binding."""
    if type(snapshot) is not dict:
        raise OfficialA2AError("A2A_CHILD_SNAPSHOT_INVALID")
    notification_bound = snapshot.get("notificationReaderAttached") is True
    deadline_bound = snapshot.get("deadlineOptIn") is True
    pump_bound = snapshot.get("notificationPumpAttached") is True
    generation_bound = (snapshot.get("generationTimeOptIn") is True
                        and snapshot.get("generationTimeOwnerFactoryBound") is True
                        and snapshot.get("generationLedgerFactoryBound") is True
                        and snapshot.get("generationTimingOffsetMode") == "successfulSdkElapsedSeconds"
                        and snapshot.get("generationTimingSource") == "ScopedRetryModelEngine.monotonic_clock")
    admissible = ((not require_notification or notification_bound)
                  and (not require_deadline or deadline_bound)
                  and (not require_notification_pump or pump_bound)
                  and (not require_generation_time or generation_bound))
    status = "bound" if (notification_bound and deadline_bound
                         and (not require_notification_pump or pump_bound)
                         and (not require_generation_time or generation_bound)) else "unbound"
    reason = None if admissible else (
        "A2A_NOTIFICATION_READER_UNBOUND" if require_notification and not notification_bound
        else "A2A_DEADLINE_UNBOUND" if require_deadline and not deadline_bound
        else "A2A_NOTIFICATION_PUMP_UNBOUND" if require_notification_pump and not pump_bound
        else "A2A_GENERATION_TIME_UNBOUND")
    receipt = {
        "schemaVersion": "gaia2-official-a2a-guard-binding-v1",
        "scopeHash": value_hash(scope),
        "notificationRequired": bool(require_notification),
        "notificationBound": notification_bound,
        "deadlineRequired": bool(require_deadline),
        "deadlineBound": deadline_bound,
        "status": status,
        "admissible": admissible,
        "reasonCode": reason,
    }
    if require_notification_pump or require_generation_time:
        receipt.update(schemaVersion="gaia2-official-a2a-guard-binding-v2",
                       notificationPumpRequired=require_notification_pump,
                       notificationPumpBound=pump_bound,
                       generationTimeRequired=require_generation_time,
                       generationTimeBound=generation_bound)
    return receipt


class OfficialA2AClient:
    """One Python ARE app owner bound to one Node Host delegation facade."""

    def __init__(self, *, env, app, scenario_id: str, workspace: str | Path,
                 model: str, provider: str, endpoint: str, api_key: str,
                 notification_reader_factory: Callable[[dict[str, Any]], Any] | None = None,
                 notification_pump_factory: Callable[[dict[str, Any]], Callable[[str], bool]] | None = None,
                 require_notification_pump: bool = False,
                 require_generation_time: bool = False,
                 deadline_factory: Callable[[str], Any] | None = None,
                 model_event_emitter: Callable[..., None] | None = None,
                 expected_app_ids: tuple[str, ...] | list[str] | None = None):
        self.__env = env
        # Generation time belongs to the official registered wrapper, not the
        # unwrapped native tool owner. ARE requires exact env.apps identity.
        self.__registered_app = app
        # In official A2A mode the scenario replaces the original App in
        # ``env.apps`` with an AppAgent wrapper.  Its private AppToolAdapter
        # instances still point at the original native App, which owns the
        # actual state and event callbacks.  Bind that original object so the
        # child can see the app's real tools instead of only the wrapper's
        # expert_agent entry point.
        native_app = app
        wrapper_agent = getattr(app, "app_agent", None)
        wrapper_tools = getattr(wrapper_agent, "tools", None)
        if isinstance(wrapper_tools, dict):
            candidates = []
            for tool in wrapper_tools.values():
                original = getattr(getattr(tool, "app_tool", None), "class_instance", None)
                if original is not None and getattr(original, "name", None) == getattr(app, "name", None):
                    candidates.append(original)
            if candidates and all(candidate is candidates[0] for candidate in candidates):
                native_app = candidates[0]
        self.__app = native_app
        self.__expected_app_ids = None if expected_app_ids is None else _app_ids(expected_app_ids)
        if self.__expected_app_ids is not None and self.__app.name not in self.__expected_app_ids:
            raise OfficialA2AError("A2A_OWNER_APP_IDS_INVALID")
        self.__owner_prepared = False
        self.__owner_committed = False
        self.__scenario_id = _safe_text(scenario_id)
        self.__model, self.__provider, self.__endpoint, self.__api_key = map(_safe_text, (model, provider, endpoint, api_key))
        # These factories are trusted constructor capabilities supplied by the
        # parent integration.  They are never read from Actor/model payloads or
        # ordinary environment variables.  Until both are bound, official A2A
        # child completion remains fail-closed by default.
        if (notification_reader_factory is not None and not callable(notification_reader_factory)) \
                or (notification_pump_factory is not None and not callable(notification_pump_factory)) \
                or (deadline_factory is not None and not callable(deadline_factory)):
            raise OfficialA2AError("A2A_DYNAMIC_GUARD_FACTORY_INVALID")
        if type(require_notification_pump) is not bool or type(require_generation_time) is not bool:
            raise OfficialA2AError("A2A_DYNAMIC_GUARD_REQUIREMENT_INVALID")
        if model_event_emitter is not None and not callable(model_event_emitter):
            raise OfficialA2AError("A2A_MODEL_EVENT_EMITTER_INVALID")
        self.__notification_reader_factory = notification_reader_factory
        self.__notification_pump_factory = notification_pump_factory
        self.__require_notification_pump = require_notification_pump
        self.__require_generation_time = require_generation_time
        self.__failure_code: str | None = None
        self.__failure_callback: Callable[[str], None] | None = None
        self.__deadline_factory = deadline_factory
        self.__model_event_emitter = model_event_emitter
        self.__require_notification = os.environ.get("GAIA2_A2A_REQUIRE_NOTIFICATION_READER", "1") != "0"
        self.__require_deadline = os.environ.get("GAIA2_A2A_REQUIRE_DEADLINE", "1") != "0"
        self.__guard_receipt: dict[str, Any] | None = None
        self.__execution_id = _safe_text(os.environ.get("GAIA2_EXECUTION_ID"))
        self.__session_id = _safe_text(os.environ.get("GAIA2_SESSION_ID"))
        host = _safe_text(os.environ.get("GAIA2_A2A_PIPE_HOST"))
        try:
            port = int(os.environ.get("GAIA2_A2A_PIPE_PORT", "0"))
        except ValueError:
            raise OfficialA2AError("A2A_PIPE_CONFIGURATION") from None
        channel = _safe_text(os.environ.get("GAIA2_A2A_PIPE_CHANNEL"))
        binding = _safe_text(os.environ.get("GAIA2_A2A_PIPE_BINDING"))
        if len(channel) != 64 or len(binding) != 64 or port < 1 or port > 65535:
            raise OfficialA2AError("A2A_PIPE_CONFIGURATION")
        try:
            sock = socket.create_connection((host, port), timeout=30.0)
            sock.settimeout(None)
        except OSError:
            raise OfficialA2AError("A2A_PIPE_CONNECT_FAILED") from None
        self.__socket = sock
        # Keep the evidence root within this run's workspace; NativeAppBinding
        # itself rejects pre-existing/symlinked roots.
        evidence_root = Path(workspace).absolute() / ("a2a-native-" + str(app.name))
        source_files = (Path(__file__).absolute(), Path(__file__).absolute().with_name("gaia2_private_native_binding.py"),
                        Path(__file__).absolute().with_name("gaia2_a2a_wire.py"), Path(__file__).absolute().with_name("gaia2_scoped_app_agent.py"))
        self.__generation_source_files = (*source_files,
            Path(__file__).absolute().with_name("gaia2_generation_time.py"),
            Path(__file__).absolute().with_name("gaia2_generation_time_ledger.py"))
        try:
            self.__owner = NativeAppBinding(
                native_app, environment_generation="official-" + self.__execution_id,
                parent_execution_id=self.__execution_id, parent_session_id=self.__session_id,
                evidence_root=evidence_root, clock=env.time_manager.time,
                clock_environment=env, trusted_source_files=source_files,
                deadline_clock_unit="seconds",
            )
            manifest = self.__owner.manifest()
            self.__excluded_tools = self.__owner.excluded_tool_snapshot()
            tools = manifest.get("tools") if isinstance(manifest, dict) else None
            if (manifest.get("schemaVersion") not in ("gaia2-native-app-binding-v1", "gaia2-native-app-binding-v2")
                    or not isinstance(tools, list)
                    or any(not isinstance(item, dict) or type(item.get("publicName")) is not str
                           or type(item.get("toolId")) is not str for item in tools)):
                raise OfficialA2AError("A2A_NATIVE_MANIFEST_INVALID")
            self.__tool_ids = {item["publicName"]: item["toolId"] for item in tools}
            self.__manifest_version = manifest["schemaVersion"]
            self.__tool_evidence_kinds = {item["publicName"]: item.get("completionEvidenceKind") for item in tools}
            if len(self.__tool_ids) != len(tools):
                raise OfficialA2AError("A2A_NATIVE_MANIFEST_INVALID")
            self.__read_stream = sock.makefile("rb", buffering=0)
            self.__write_stream = sock.makefile("wb", buffering=0)
            self.__peer = PrivatePipePeer(
                self.__read_stream, self.__write_stream, channel, binding,
                self.__owner.handlers(), on_closed=lambda _code: None,
            )
            self.__handle_token: str | None = None
            self.__scope: dict[str, Any] | None = None
            self.__closed = False
            self.__model_requests = 0
            self.__sdk_attempts = 0
            self.__child_model_requests_base = 0
            self.__child_sdk_attempts_base = 0
            self.__child_scope_hashes: list[str] = []
            if self.__expected_app_ids is None:
                # Preserve the historical, trusted single-App handshake.
                self.__peer.call("a2a_connect_ready", None)
                self.__owner_prepared = True
                self.__owner_committed = True
            else:
                ready = self.__peer.call("a2a_connect_ready", {"appIds": list(self.__expected_app_ids)})
                if (type(ready) is not dict or set(ready) != {"appId", "status"}
                        or ready.get("appId") != self.__app.name or ready.get("status") != "prepared"):
                    raise OfficialA2AError("A2A_OWNER_PREPARE_INVALID")
                self.__owner_prepared = True
            self.sync_clock()
        except BaseException as error:
            self.__closed = True
            try:
                self.__owner.close()
            except BaseException:
                pass
            try:
                self.__peer.close()
            except BaseException:
                pass
            self.__close_transport()
            failure = OfficialA2AError("A2A_PIPE_HANDSHAKE_FAILED")
            failure.causeCode = (getattr(error, "code", None) if _safe_text(getattr(error, "code", None))
                                 else "native_handshake_" + type(error).__name__.lower())
            raise failure from None

    @property
    def app_name(self) -> str:
        return self.__app.name

    def native_manifest(self) -> dict[str, Any]:
        """Trusted evaluator view; never a tool or Actor-selected capability."""
        return copy.deepcopy(self.__owner.manifest())

    def child_evidence_identity(self) -> dict[str, Any]:
        """Current child identity without delegated task/model payloads."""
        if self.__scope is None or self.__handle_token is None:
            raise OfficialA2AError("A2A_CHILD_NOT_STARTED")
        return {"scopeHash": value_hash(self.__scope), **{key: self.__scope[key] for key in (
            "parentExecutionId", "parentSessionId", "environmentGeneration", "appId",
            "parentActionId", "requestId", "childExecutionId", "childSessionId")}}

    def _pool_socket(self):
        """Trusted router inventory; never exposed to Actor/tool payloads."""
        return None if self.__closed or self.__peer.closed else self.__socket

    def _install_pool_router(self, router: Callable[[], None]) -> None:
        if (self.__closed or not self.__owner_prepared or self.__expected_app_ids is None
                or not callable(router)):
            raise OfficialA2AError("A2A_POOL_ROUTER_INVALID")
        self.__peer.install_router(router)

    def _serve_pool_frame(self) -> None:
        if self.__closed:
            raise OfficialA2AError("A2A_POOL_PEER_CLOSED")
        self.__peer.serve_once()

    def _revoke_pool_admission(self) -> None:
        # Retain native owners/uncertain-effect tombstones; only prevent any
        # later child from being admitted after an EOF or wire routing failure.
        self.__owner_committed = False

    def _install_failure_callback(self, callback: Callable[[str], None]) -> None:
        """One trusted pool-wide admission revoker, never an Actor callback."""
        if self.__closed or self.__failure_callback is not None or not callable(callback):
            raise OfficialA2AError("A2A_POOL_FAILURE_CALLBACK_INVALID")
        self.__failure_callback = callback

    def __fail(self, code: str) -> None:
        self.__failure_code = self.__failure_code or code
        self.__owner_committed = False
        if self.__failure_callback is not None:
            self.__failure_callback(self.__failure_code)

    def __check_admission(self) -> None:
        if self.__failure_code is not None:
            raise OfficialA2AError(self.__failure_code)

    def __close_transport(self) -> None:
        # socket.makefile keeps an independent fd reference. Closing just the
        # socket cannot deliver the expected EOF while these streams survive.
        seen = set()
        for field in ("__read_stream", "__write_stream", "__socket"):
            stream = getattr(self, "_OfficialA2AClient" + field, None)
            if stream is None or id(stream) in seen:
                continue
            seen.add(id(stream))
            try:
                stream.close()
            except BaseException:
                pass

    def _mark_owner_committed(self, app_ids: tuple[str, ...] | list[str]) -> None:
        """Pool-owned local admission after the shared Node commit ACK."""
        if (self.__closed or not self.__owner_prepared or self.__expected_app_ids is None
                or _app_ids(app_ids) != self.__expected_app_ids):
            raise OfficialA2AError("A2A_OWNER_COMMIT_INVALID")
        self.__owner_committed = True

    def _commit_owner(self, app_ids: tuple[str, ...] | list[str]) -> None:
        ids = _app_ids(app_ids)
        if (self.__closed or self.__owner_committed or not self.__owner_prepared
                or self.__expected_app_ids is None or ids != self.__expected_app_ids):
            raise OfficialA2AError("A2A_OWNER_COMMIT_INVALID")
        try:
            reply = self.__peer.call("a2a_commit_apps", {"appIds": list(ids)})
        except BaseException:
            raise OfficialA2AError("A2A_OWNER_COMMIT_FAILED") from None
        if (type(reply) is not dict or set(reply) != {"status", "appIds"}
                or reply.get("status") != "committed" or reply.get("appIds") != list(ids)):
            raise OfficialA2AError("A2A_OWNER_COMMIT_INVALID")
        self._mark_owner_committed(ids)

    def _close_owner(self) -> None:
        """Revoke/drain only Node delegation, not the parent Hook Host."""
        try:
            reply = self.__peer.call("a2a_close_owner", None)
        except BaseException:
            raise OfficialA2AError("A2A_OWNER_CLOSE_FAILED") from None
        if type(reply) is not dict or set(reply) != {"status"} or reply.get("status") != "closed":
            raise OfficialA2AError("A2A_OWNER_CLOSE_FAILED")
        self.__owner_committed = False

    def sync_clock(self) -> None:
        now = self.__env.time_manager.time()
        if not _finite_number(now) or now < 0:
            raise OfficialA2AError("A2A_CLOCK_INVALID")
        try:
            self.__peer.call("a2a_sync_clock", {"now": float(now)})
        except BaseException:
            raise OfficialA2AError("A2A_CLOCK_SYNC_FAILED") from None

    def begin_child(self, *, parent_response: dict[str, Any], task: str) -> dict[str, Any]:
        self.__check_admission()
        if self.__closed or self.__handle_token is not None:
            raise OfficialA2AError("A2A_CHILD_REUSED")
        if (getattr(self, "_OfficialA2AClient__expected_app_ids", None) is not None
                and not self.__owner_committed):
            raise OfficialA2AError("A2A_OWNER_NOT_COMMITTED")
        if (type(parent_response) is not dict or type(parent_response.get("evidencePath")) is not str
                or not parent_response["evidencePath"]
                or type(parent_response.get("decision")) is not dict
                or parent_response["decision"].get("action") != "allow"):
            raise OfficialA2AError("A2A_PARENT_RECEIPT_INVALID")
        evidence_hash = parent_response.get("evidenceSha256") or parent_response.get("sha256")
        if evidence_hash is not None and (type(evidence_hash) is not str or not _HASH.fullmatch(evidence_hash)):
            raise OfficialA2AError("A2A_PARENT_RECEIPT_INVALID")
        task = _safe_text(task)
        are_now = self.__env.time_manager.time()
        if not _finite_number(are_now) or are_now < 0:
            raise OfficialA2AError("A2A_CLOCK_INVALID")
        self.sync_clock()
        try:
            reply = self.__peer.call("a2a_begin_child", {"appId": self.__app.name,
                "parentEvidencePath": parent_response["evidencePath"], "task": task})
        except BaseException:
            raise OfficialA2AError("A2A_CHILD_BEGIN_FAILED") from None
        if (type(reply) is not dict or type(reply.get("handleToken")) is not str
                or type(reply.get("scope")) is not dict):
            raise OfficialA2AError("A2A_CHILD_SCOPE_INVALID")
        if not _UUID.fullmatch(reply["handleToken"]):
            raise OfficialA2AError("A2A_CHILD_HANDLE_INVALID")
        scope = _validate_scope(reply["scope"], execution_id=self.__execution_id,
                                session_id=self.__session_id, app_id=self.__app.name,
                                task=task, are_now=float(are_now))
        self.__handle_token, self.__scope = reply["handleToken"], scope
        self.__child_scope_hashes.append(value_hash(scope))
        # The client lives across delegations, while each scoped runner starts
        # its logical/SDK budgets at zero. Preserve lifetime snapshot totals
        # and bind a fresh counter origin only after the new scope is valid.
        self.__child_model_requests_base = self.__model_requests
        self.__child_sdk_attempts_base = self.__sdk_attempts
        self.__guard_receipt = None
        return reply

    def _model_binding(self) -> tuple[dict, str, ModelRetryPolicy, dict]:
        self.__check_admission()
        if self.__scope is None or self.__handle_token is None:
            raise OfficialA2AError("A2A_CHILD_NOT_STARTED")
        policy = ModelRetryPolicy.from_environment()
        sdk_kwargs = {"model": self.__model, "custom_llm_provider": self.__provider,
                      "api_base": self.__endpoint, "api_key": self.__api_key,
                      "timeout": policy.request_timeout_seconds}
        max_logical = 40
        max_attempts = max(80, policy.max_attempts * max_logical)
        config_hash = scoped_model_config_hash(sdk_kwargs, policy)
        model_scope = {"schemaVersion": "capybara-scoped-model-scope-v1",
                       "delegationScopeHash": value_hash(self.__scope), "modelRole": "child_actor",
                       "configHash": config_hash, "maxLogicalRequests": max_logical,
                       "maxSdkAttempts": max_attempts}
        return model_scope, value_hash(model_scope), policy, sdk_kwargs

    def _model_gate(self, request: dict[str, Any], *, model_scope: dict, model_scope_hash: str) -> dict[str, Any]:
        projected = request.get("projectedMessages")
        if type(projected) is not list:
            raise OfficialA2AError("A2A_MODEL_PROJECTION_MISSING")
        messages = request.get("messages")
        if type(messages) is not list:
            raise OfficialA2AError("A2A_MODEL_REQUEST_INVALID")
        request_id = request.get("requestId")
        if type(request_id) is not str or not _ID32.fullmatch(request_id):
            raise OfficialA2AError("A2A_MODEL_REQUEST_INVALID")
        if self.__scope is None or value_hash(self.__scope) != model_scope.get("delegationScopeHash"):
            raise OfficialA2AError("A2A_CHILD_SCOPE_INVALID")
        # Only the constructor-bound ARE TimeManager advances admission time.
        # A request's clock projection is never the registry clock authority.
        self.sync_clock()
        original_hash = value_hash(messages)
        response = self.__peer.call("a2a_before_model", {"handleToken": self.__handle_token, "input": {
            "requestId": request_id, "modelScope": model_scope, "originalMessagesHash": original_hash,
            "iteration": request.get("iteration", 0), "messages": projected, "clock": request["clock"]}})
        if (type(response) is not dict or type(response.get("context")) is not str
                or type(response.get("contextHash")) is not str or type(response.get("variablesHash")) is not str
                or not _HASH.fullmatch(response["contextHash"])
                or hashlib.sha256(response["context"].encode("utf-8")).hexdigest() != response["contextHash"]
                or not _HASH.fullmatch(response["variablesHash"])
                or type(response.get("revision")) is not int or response["revision"] < 0
                or type(response.get("evidence")) is not dict):
            raise OfficialA2AError("A2A_MODEL_GATE_INVALID")
        context = response["context"]
        actual = list(messages)
        actual.insert(1, {"role": "system", "content": "Live Capybara dynamic context:\n" + context,
                          "attachments": None})
        actual_hash = value_hash(actual)
        permit = uuid.uuid4().hex
        # Rejected/invalid admission is not a child logical-request receipt.
        self.__model_requests += 1
        return {"schemaVersion": "capybara-scoped-model-gate-v1", "permitId": permit,
            "requestId": request_id, "scopeHash": value_hash(self.__scope),
            "modelScopeHash": model_scope_hash, "originalMessagesHash": original_hash,
            "actualInputHash": actual_hash, "context": context,
            "contextHash": response["contextHash"], "variablesHash": response["variablesHash"],
            "revision": response["revision"], "beforeEvidenceRef": response["evidence"]}

    def _model_attempt(self, payload: dict[str, Any], *, model_scope_hash: str) -> dict[str, Any]:
        # Retry/cooldown and generation bookkeeping can advance ARE time even
        # when no native tool has run since the previous logical admission.
        self.sync_clock()
        try:
            reply = self.__peer.call("a2a_assert_model", {"handleToken": self.__handle_token,
                "requestId": payload["requestId"]})
        except BaseException:
            raise OfficialA2AError("A2A_MODEL_ATTEMPT_REJECTED") from None
        if type(reply) is not dict or set(reply) != {"ok"} or reply.get("ok") is not True:
            raise OfficialA2AError("A2A_MODEL_ATTEMPT_REJECTED")
        # Count only the successful trusted ACK, never an unstarted SDK call.
        self.__sdk_attempts += 1
        return {"schemaVersion": "capybara-scoped-model-sdk-attempt-v1", **payload,
            "scopeHash": value_hash(self.__scope), "modelScopeHash": model_scope_hash,
            "logicalRequestsUsed": self.__model_requests - self.__child_model_requests_base,
            "sdkAttemptsUsed": self.__sdk_attempts - self.__child_sdk_attempts_base}

    def _model_finish(self, payload: dict[str, Any], *, model_scope_hash: str) -> dict[str, Any]:
        self.sync_clock()
        try:
            reply = self.__peer.call("a2a_complete_model", {"handleToken": self.__handle_token,
                "requestId": payload["requestId"]})
        except BaseException:
            raise OfficialA2AError("A2A_MODEL_FINISH_REJECTED") from None
        if type(reply) is not dict or set(reply) != {"ok"} or reply.get("ok") is not True:
            raise OfficialA2AError("A2A_MODEL_FINISH_REJECTED")
        return {"schemaVersion": "capybara-scoped-model-completion-v1", **payload,
            "scopeHash": value_hash(self.__scope), "modelScopeHash": model_scope_hash,
            "status": "completed"}

    def _model_emitter(self, *, model_scope: dict, model_scope_hash: str):
        """Bind safe broker events to the validated child, never an Actor field.

        Capture the exact scope and trusted callback now: later delegations on
        this client cannot relabel an earlier engine's events. Only the broker's
        fixed operational fields cross the seam; task, prompts and SDK config
        are deliberately absent from the identity and event inventories.
        """
        emit = self.__model_event_emitter
        if emit is None:
            return None
        if (self.__scope is None or model_scope.get("delegationScopeHash") != value_hash(self.__scope)
                or model_scope.get("modelRole") != "child_actor"
                or model_scope_hash != value_hash(model_scope)):
            raise OfficialA2AError("A2A_MODEL_EVENT_BINDING_INVALID")
        identity = {key: self.__scope[key] for key in (
            "parentExecutionId", "parentSessionId", "childExecutionId", "childSessionId", "appId")}
        identity["delegationScopeHash"] = value_hash(self.__scope)
        config_hash = model_scope["configHash"]

        def bound_emit(kind: str, **fields: Any) -> None:
            if (kind not in _MODEL_EVENT_TYPES or set(fields) - _MODEL_EVENT_FIELDS
                    or fields.get("schemaVersion") != "gaia2-scoped-model-event-v1"
                    or fields.get("modelRole") != "child_actor"
                    or fields.get("modelScopeHash") != model_scope_hash
                    or fields.get("configHash") != config_hash):
                raise OfficialA2AError("A2A_MODEL_EVENT_INVALID")
            proof_fields = ("classificationSource", "httpStatusSource", "httpGuardClosedRecordSha256")
            if any(key in fields for key in proof_fields):
                if (not all(key in fields for key in proof_fields)
                        or kind not in ("model_request_failed", "model_retry_scheduled")
                        or type(fields["classificationSource"]) is not str or fields["classificationSource"] != "trusted_http_guard"
                        or type(fields["httpStatusSource"]) is not str or fields["httpStatusSource"] != "trusted_http_guard"
                        or type(fields["httpGuardClosedRecordSha256"]) is not str or not _HASH.fullmatch(fields["httpGuardClosedRecordSha256"])
                        or type(fields.get("category")) is not str or fields["category"] != "request_timeout" or fields.get("retryable") is not True
                        or type(fields.get("retryExhausted")) is not bool
                        or kind == "model_retry_scheduled" and fields["retryExhausted"] is not False
                        or type(fields.get("httpStatus")) is not int or fields["httpStatus"] != 408
                        or type(fields.get("requestAttempt")) is not int or fields["requestAttempt"] < 1
                        or type(fields.get("maxRequestAttempts")) is not int or fields["maxRequestAttempts"] < fields["requestAttempt"]):
                    raise OfficialA2AError("A2A_MODEL_EVENT_INVALID")
            # These identities are produced by the broker, not SDK text.
            if any(type(fields.get(key)) is not str or not pattern.fullmatch(fields[key])
                   for key, pattern in (("permitId", _ID32), ("requestId", _ID32),
                                        ("actualInputHash", _HASH))):
                raise OfficialA2AError("A2A_MODEL_EVENT_INVALID")
            usage = fields.get("usage")
            if usage is not None and (type(usage) is not dict
                    or set(usage) - {"inputTokens", "outputTokens", "totalTokens"}
                    or any(type(value) is not int or not 0 <= value <= 9007199254740991
                           for value in usage.values())):
                raise OfficialA2AError("A2A_MODEL_EVENT_INVALID")
            emit(kind, **fields, **identity)

        return bound_emit

    def child_runner(self):
        self.__check_admission()
        if self.__scope is None or self.__handle_token is None:
            raise OfficialA2AError("A2A_CHILD_NOT_STARTED")
        model_scope, model_scope_hash, policy, sdk_kwargs = self._model_binding()
        config_hash = model_scope["configHash"]
        engine = ScopedRetryModelEngine(
            role="child_actor", model_scope_hash=model_scope_hash, sdk_completion=_sdk_completion,
            sdk_kwargs_factory=lambda: dict(sdk_kwargs), policy=policy,
            max_logical_requests=model_scope["maxLogicalRequests"], max_sdk_attempts=model_scope["maxSdkAttempts"],
            config_hash=config_hash,
            emit=self._model_emitter(model_scope=model_scope, model_scope_hash=model_scope_hash),
            deadline_timeout_policy="remaining" if self.__deadline_factory is not None else "fixed",
            http_guard_identity={**{key: self.__scope[key] for key in (
                "parentExecutionId", "parentSessionId", "childExecutionId", "childSessionId")},
                "delegationScopeHash": value_hash(self.__scope)},
        )

        def dispatch(action: dict[str, Any]) -> dict[str, Any]:
            self.sync_clock()
            public_name = action.get("tool")
            tool_id = self.__tool_ids.get(public_name)
            if type(tool_id) is not str:
                raise OfficialA2AError("A2A_TOOL_MAPPING_FAILED")
            try:
                result = self.__peer.call("a2a_dispatch", {"handleToken": self.__handle_token,
                    "tool": tool_id, "arguments": action.get("arguments", {})})
            except BaseException:
                raise OfficialA2AError("A2A_NATIVE_DISPATCH_FAILED") from None
            if type(result) is dict and result.get("status") == "blocked":
                # A normal Host nonallow decision has its own negative ACK.
                # It carries no tool value, return hash, native event or success.
                if (set(result) != {"dispatchId", "status", "gateDecision", "evidence", "toolId", "toolKind", "completionEvidenceRef"}
                        or type(result["dispatchId"]) is not str or not _UUID.fullmatch(result["dispatchId"])
                        or result["toolId"] != tool_id or result["toolKind"] not in ("app_tool", "child_final_answer")
                        or (result["toolKind"] == "child_final_answer") is not (public_name == "final_answer")
                        or result["completionEvidenceRef"] is not None or result["gateDecision"] not in ("block", "read_back")
                        or type(result["evidence"]) is not dict or set(result["evidence"]) != {"path", "sha256"}
                        or type(result["evidence"]["path"]) is not str or not Path(result["evidence"]["path"]).is_absolute()
                        or type(result["evidence"]["sha256"]) is not str or not _HASH.fullmatch(result["evidence"]["sha256"])):
                    raise OfficialA2AError("A2A_NATIVE_BLOCKED_RESULT_INVALID")
                return {"schemaVersion": "capybara-scoped-agent-dispatch-blocked-v1", "scopeHash": value_hash(self.__scope),
                    "dispatchId": result["dispatchId"], "toolId": tool_id, "toolKind": result["toolKind"], "status": "blocked",
                    "childCompleted": False, "completionEvidenceRef": None, "gateDecision": result["gateDecision"],
                    "nativeRejectionEvidenceRef": copy.deepcopy(result["evidence"])}
            if type(result) is not dict or type(result.get("dispatchId")) is not str or result.get("status") != "completed":
                raise OfficialA2AError("A2A_NATIVE_RESULT_INVALID")
            # Native v2 does not change the child-facing ACK schema. Its pure
            # read result is evidence-backed in Node, never a fabricated CE.
            if self.__tool_evidence_kinds.get(public_name) == "source_pinned_return" \
                    and (result.get("toolKind") != "app_tool" or result.get("completionEvidenceRef") is not None):
                raise OfficialA2AError("A2A_NATIVE_SOURCE_RETURN_INVALID")
            return {"schemaVersion": "capybara-scoped-agent-dispatch-v1", "scopeHash": value_hash(self.__scope),
                "dispatchId": result["dispatchId"], "toolId": result.get("toolId"),
                "toolKind": result.get("toolKind"), "status": "completed",
                "childCompleted": result.get("toolKind") == "child_final_answer",
                "completionEvidenceRef": result.get("completionEvidenceRef")}

        gate = lambda request: self._model_gate(request, model_scope=model_scope,
                                                model_scope_hash=model_scope_hash)
        # Ask the scoped runner to include its deterministic occurrence-ID
        # projection in this external gate request.  Other gates retain the
        # original four-field in-process callback contract.
        gate.accepts_projected_messages = True
        notification_reader = None
        notification_pump = None
        if self.__notification_reader_factory is not None:
            try:
                notification_reader = self.__notification_reader_factory(dict(self.__scope))
            except BaseException:
                raise OfficialA2AError("A2A_NOTIFICATION_READER_BIND_FAILED") from None
        try:
            # Reader creation installs the active parent lifecycle. The pump
            # factory may only capture that already installed identity.
            if self.__notification_pump_factory is not None:
                try:
                    notification_pump = self.__notification_pump_factory(dict(self.__scope))
                except BaseException:
                    raise OfficialA2AError("A2A_NOTIFICATION_PUMP_BIND_FAILED") from None
                if not callable(notification_pump):
                    raise OfficialA2AError("A2A_NOTIFICATION_PUMP_BIND_FAILED")
            generation_owner_factory = None
            generation_ledger_factory = None
            if self.__require_generation_time:
                registered_app, env = self.__registered_app, self.__env
                generation_sources = self.__generation_source_files

                def generation_owner_factory():
                    return ScopedAREGenerationTimeOwner(env=env, app=registered_app,
                        trusted_source_files=generation_sources)

                def generation_ledger_factory(**kwargs):
                    return ScopedGenerationTimeLedger(**kwargs)

            runner = build_scoped_app_agent(app=self.__app, owner=self.__owner, env=self.__env,
                scope=self.__scope, llm_engine=engine, dispatch=dispatch, model_binding=model_scope,
                model_gate=gate,
                model_attempt=lambda payload: self._model_attempt(payload, model_scope_hash=model_scope_hash),
                model_finish=lambda payload: self._model_finish(payload, model_scope_hash=model_scope_hash),
                max_logical_requests=model_scope["maxLogicalRequests"],
                deadline_factory=self.__deadline_factory,
                notification_reader=notification_reader,
                notification_pump=notification_pump,
                generation_time_owner_factory=generation_owner_factory,
                generation_ledger_factory=generation_ledger_factory)
            self.__guard_receipt = _guard_receipt(
                scope=self.__scope, snapshot=runner.snapshot(),
                require_notification=self.__require_notification,
                require_deadline=self.__require_deadline,
                require_notification_pump=self.__require_notification_pump,
                require_generation_time=self.__require_generation_time)
            if not self.__guard_receipt["admissible"]:
                reason = self.__guard_receipt["reasonCode"]
                try:
                    runner.close()
                except BaseException:
                    pass
                raise OfficialA2AError(reason)
            return runner
        except OfficialA2AError:
            try:
                if notification_reader is not None and callable(getattr(notification_reader, "close", None)):
                    notification_reader.close()
            except BaseException:
                pass
            raise
        except BaseException:
            try:
                if notification_reader is not None and callable(getattr(notification_reader, "close", None)):
                    notification_reader.close()
            except BaseException:
                pass
            raise OfficialA2AError("A2A_CHILD_RUNNER_BIND_FAILED") from None

    def snapshot(self) -> dict[str, Any]:
        """Return answer-blind identity, guard and budget state for audit."""
        scope = None if self.__scope is None else dict(self.__scope)
        excluded = (copy.deepcopy(self.__excluded_tools) if self.__closed
                    else self.__owner.excluded_tool_snapshot())
        return {
            "schemaVersion": "gaia2-official-a2a-client-v1",
            "executionId": self.__execution_id,
            "sessionId": self.__session_id,
            "scenarioId": self.__scenario_id,
            "appId": self.__app.name,
            "scopeHash": None if scope is None else value_hash(scope),
            "childActive": self.__handle_token is not None,
            "closed": self.__closed,
            "modelRequests": self.__model_requests,
            "sdkAttempts": self.__sdk_attempts,
            "deadlineClockContract": A2A_DEADLINE_CLOCK_CONTRACT,
            "deadlineClockUnit": "seconds",
            "childScopeHashes": list(self.__child_scope_hashes),
            "failed": self.__failure_code is not None,
            "failureCode": self.__failure_code,
            "notificationReaderFactoryBound": self.__notification_reader_factory is not None,
            "notificationPumpFactoryBound": self.__notification_pump_factory is not None,
            "generationTimeFactoryBound": self.__require_generation_time,
            "notificationPumpRequired": self.__require_notification_pump,
            "generationTimeRequired": self.__require_generation_time,
            "deadlineFactoryBound": self.__deadline_factory is not None,
            "guard": None if self.__guard_receipt is None else dict(self.__guard_receipt),
            "excludedTools": excluded,
        }

    def reset_child(self, *, completed: bool) -> None:
        """Release the local child slot so one pipe can serve later turns.

        The Node side keeps the opaque handle as an audit record.  A failed
        child is explicitly revoked; a completed child is already closed by
        the final native dispatch and only the Python-side capability is
        cleared here.
        """
        if type(completed) is not bool:
            raise OfficialA2AError("A2A_CHILD_RESET_INVALID")
        if completed:
            self.__check_admission()
        if self.__handle_token is None:
            return
        token = self.__handle_token
        if not completed:
            try:
                reply = self.__peer.call("a2a_cancel_child", {"handleToken": token})
                if reply is not None:
                    raise OfficialA2AError("A2A_CHILD_CANCEL_FAILED")
            except BaseException:
                self.__fail("A2A_CHILD_CANCEL_FAILED")
                # An unacknowledged handle remains active/uncertain in all
                # snapshots. No later child may overwrite this identity.
                raise OfficialA2AError("A2A_CHILD_CANCEL_FAILED") from None
        self.__handle_token = None
        self.__scope = None

    def close(self) -> None:
        if self.__closed:
            return
        error = None
        try:
            if self.__handle_token is not None:
                self.reset_child(completed=False)
        except BaseException as caught:
            error = caught
        finally:
            self.__closed = True
            try:
                self.__owner.close()
            except BaseException:
                error = error or OfficialA2AError("A2A_NATIVE_OWNER_CLOSE_FAILED")
            finally:
                try:
                    self.__peer.close()
                except BaseException:
                    error = error or OfficialA2AError("A2A_PIPE_CLOSE_FAILED")
                self.__close_transport()
        if error is not None:
            raise error


def connect_official_a2a(*, env, app, scenario_id: str, workspace: str | Path,
                         model: str, provider: str, endpoint: str, api_key: str,
                         notification_reader_factory: Callable[[dict[str, Any]], Any] | None = None,
                         notification_pump_factory: Callable[[dict[str, Any]], Callable[[str], bool]] | None = None,
                         require_notification_pump: bool = False,
                         require_generation_time: bool = False,
                         deadline_factory: Callable[[str], Any] | None = None,
                         model_event_emitter: Callable[..., None] | None = None,
                         expected_app_ids: tuple[str, ...] | list[str] | None = None) -> OfficialA2AClient:
    """Trusted constructor called only by the official bridge, never Actor input."""
    return OfficialA2AClient(env=env, app=app, scenario_id=scenario_id, workspace=workspace,
                             model=model, provider=provider, endpoint=endpoint, api_key=api_key,
                             notification_reader_factory=notification_reader_factory,
                             notification_pump_factory=notification_pump_factory,
                             require_notification_pump=require_notification_pump,
                             require_generation_time=require_generation_time,
                             deadline_factory=deadline_factory,
                             model_event_emitter=model_event_emitter,
                             expected_app_ids=expected_app_ids)


class OfficialA2AClientPool:
    """Eager, all-or-nothing owners for ARE's complete AppAgent inventory."""

    def __init__(self, *, env, apps: tuple[AppAgent, ...] | list[AppAgent],
                 scenario_id: str, workspace: str | Path, model: str, provider: str,
                 endpoint: str, api_key: str,
                 notification_reader_factory: Callable[[dict[str, Any]], Any] | None = None,
                 notification_pump_factory: Callable[[dict[str, Any]], Callable[[str], bool]] | None = None,
                 require_notification_pump: bool = False,
                 require_generation_time: bool = False,
                 deadline_factory: Callable[[str], Any] | None = None,
                 model_event_emitter: Callable[..., None] | None = None):
        self.__env = env
        self.__apps = _pool_apps(env, apps)
        self.__app_ids = tuple(self.__apps)
        self.__clients: dict[str, OfficialA2AClient] = {}
        self.__used_app_ids: set[str] = set()
        self.__status = "preparing"
        self.__router_failed = False
        self.__shutdown_complete = False
        failure_code = "unknown"
        try:
            for name, app in self.__apps.items():
                try:
                    self.__clients[name] = connect_official_a2a(
                        env=env, app=app, scenario_id=scenario_id, workspace=workspace,
                        model=model, provider=provider, endpoint=endpoint, api_key=api_key,
                        notification_reader_factory=notification_reader_factory,
                        notification_pump_factory=notification_pump_factory,
                        require_notification_pump=require_notification_pump,
                        require_generation_time=require_generation_time,
                        deadline_factory=deadline_factory, model_event_emitter=model_event_emitter,
                        expected_app_ids=self.__app_ids)
                except OfficialA2AError as error:
                    failure_code = (getattr(error, "causeCode", None) if _safe_text(getattr(error, "causeCode", None))
                                    else error.code if _safe_text(error.code) else "child_initialization_failed")
                    raise
                except BaseException:
                    failure_code = "child_initialization_failed"
                    raise
                self.__clients[name]._install_failure_callback(self.__client_failed)
            self.__install_router()
            first = self.__clients[self.__app_ids[0]]
            first._commit_owner(self.__app_ids)
            for client in self.__clients.values():
                client._mark_owner_committed(self.__app_ids)
            self.__status = "committed"
        except BaseException:
            self.__status = "failed"
            self.__close_clients()
            self.__shutdown_complete = True
            failure = OfficialA2AError("A2A_POOL_INITIALIZATION_FAILED")
            failure.causeCode = failure_code
            raise failure from None

    def __install_router(self) -> None:
        # Install one callback only after every peer's prepare call completed:
        # no pending request is rerouted or taken over by the pool bootstrap.
        router = self.__route_pool_frame
        for client in self.__clients.values():
            client._install_pool_router(router)

    def __client_failed(self, _code: str) -> None:
        self.__status = "failed"
        self.__router_failed = True
        for client in self.__clients.values():
            client._revoke_pool_admission()

    def __route_pool_frame(self) -> None:
        if self.__router_failed or self.__shutdown_complete:
            raise OfficialA2AError("A2A_POOL_ROUTER_FAILED")
        try:
            clients = [(client._pool_socket(), client) for client in self.__clients.values()]
            clients = [(sock, client) for sock, client in clients if sock is not None]
            if not clients or len({id(sock) for sock, _ in clients}) != len(clients):
                raise OfficialA2AError("A2A_POOL_ROUTER_INVALID")
            # One execution thread serves one complete frame at a time. While
            # A waits for Node's drain/commit response, B can receive its idle
            # cancel_child callback. No background native handler is created.
            readable, _, _ = select.select([sock for sock, _ in clients], [], [])
            if not readable:
                raise OfficialA2AError("A2A_POOL_ROUTER_INVALID")
            selected = next(client for sock, client in clients if sock is readable[0])
            selected._serve_pool_frame()
        except BaseException:
            self.__router_failed = True
            self.__status = "failed"
            for client in self.__clients.values():
                client._revoke_pool_admission()
            raise OfficialA2AError("A2A_POOL_ROUTER_FAILED") from None

    def client_for(self, app_id: str) -> OfficialA2AClient:
        if self.__status != "committed":
            raise OfficialA2AError("A2A_POOL_NOT_COMMITTED")
        if type(app_id) is not str or app_id not in self.__clients:
            raise OfficialA2AError("A2A_POOL_APP_UNKNOWN")
        if _pool_apps(self.__env, list(self.__apps.values())) != self.__apps:
            raise OfficialA2AError("A2A_POOL_APP_IDENTITY_INVALID")
        self.__used_app_ids.add(app_id)
        return self.__clients[app_id]

    def snapshot(self) -> dict[str, Any]:
        clients = [self.__clients[name].snapshot()
                   for name in self.__app_ids if name in self.__clients]
        return {
            "schemaVersion": "gaia2-official-a2a-client-pool-v1",
            "status": self.__status,
            "expectedAppIds": list(self.__app_ids),
            "usedAppIds": sorted(self.__used_app_ids),
            "clients": clients,
            "excludedTools": [copy.deepcopy(client["excludedTools"]) for client in clients
                              if client["excludedTools"]["toolCount"] > 0],
        }

    def __close_clients(self) -> bool:
        failed = False
        if self.__clients:
            try:
                self.__clients[self.__app_ids[0]]._close_owner()
            except BaseException:
                failed = True
        for client in self.__clients.values():
            try:
                client.close()
            except BaseException:
                failed = True
        return failed

    def close(self) -> None:
        if self.__shutdown_complete:
            return
        self.__status = "closing"
        failed = self.__close_clients()
        self.__shutdown_complete = True
        self.__status = "failed" if failed or self.__router_failed else "closed"
        if failed or self.__router_failed:
            raise OfficialA2AError("A2A_POOL_CLOSE_FAILED")


def connect_official_a2a_pool(*, env, apps: tuple[AppAgent, ...] | list[AppAgent],
                            scenario_id: str, workspace: str | Path, model: str,
                            provider: str, endpoint: str, api_key: str,
                            notification_reader_factory: Callable[[dict[str, Any]], Any] | None = None,
                            notification_pump_factory: Callable[[dict[str, Any]], Callable[[str], bool]] | None = None,
                            require_notification_pump: bool = False,
                            require_generation_time: bool = False,
                            deadline_factory: Callable[[str], Any] | None = None,
                            model_event_emitter: Callable[..., None] | None = None) -> OfficialA2AClientPool:
    """Trusted official bootstrap only; never exposed as an Actor tool."""
    return OfficialA2AClientPool(env=env, apps=apps, scenario_id=scenario_id, workspace=workspace,
        model=model, provider=provider, endpoint=endpoint, api_key=api_key,
        notification_reader_factory=notification_reader_factory, deadline_factory=deadline_factory,
        notification_pump_factory=notification_pump_factory,
        require_notification_pump=require_notification_pump,
        require_generation_time=require_generation_time,
        model_event_emitter=model_event_emitter)
