"""Trusted official-entry A2A client for the phase-5 private pipe.

The official ARE process owns the real Environment/App and therefore owns the
Python NativeAppBinding.  The Hook Host owns child RuntimePluginHost instances
and the delegation registry.  This module only carries the fixed private wire
between those two trusted owners; no Actor/model value selects a provider,
scope, app, or native callback.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import socket
import uuid
from typing import Any

import litellm
from litellm import completion as _sdk_completion

from gaia2_a2a_wire import PrivatePipePeer, value_hash
from gaia2_model_retry import ModelRetryPolicy
from gaia2_private_native_binding import NativeAppBinding
from gaia2_scoped_model_broker import ScopedRetryModelEngine, scoped_model_config_hash
from gaia2_scoped_app_agent import build_scoped_app_agent
from gaia2_runtime_hooks import HookProtocolError


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


class OfficialA2AClient:
    """One Python ARE app owner bound to one Node Host delegation facade."""

    def __init__(self, *, env, app, scenario_id: str, workspace: str | Path,
                 model: str, provider: str, endpoint: str, api_key: str):
        self.__env = env
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
        self.__scenario_id = _safe_text(scenario_id)
        self.__model, self.__provider, self.__endpoint, self.__api_key = map(_safe_text, (model, provider, endpoint, api_key))
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
        try:
            self.__owner = NativeAppBinding(
                native_app, environment_generation="official-" + self.__execution_id,
                parent_execution_id=self.__execution_id, parent_session_id=self.__session_id,
                evidence_root=evidence_root, clock=env.time_manager.time,
                clock_environment=env, trusted_source_files=source_files,
            )
            manifest = self.__owner.manifest()
            tools = manifest.get("tools") if isinstance(manifest, dict) else None
            if (not isinstance(tools, list)
                    or any(not isinstance(item, dict) or type(item.get("publicName")) is not str
                           or type(item.get("toolId")) is not str for item in tools)):
                raise OfficialA2AError("A2A_NATIVE_MANIFEST_INVALID")
            self.__tool_ids = {item["publicName"]: item["toolId"] for item in tools}
            if len(self.__tool_ids) != len(tools):
                raise OfficialA2AError("A2A_NATIVE_MANIFEST_INVALID")
            self.__peer = PrivatePipePeer(
                sock.makefile("rb"), sock.makefile("wb"), channel, binding,
                self.__owner.handlers(), on_closed=lambda _code: None,
            )
            self.__handle_token: str | None = None
            self.__scope: dict[str, Any] | None = None
            self.__closed = False
            self.__model_requests = 0
            self.__sdk_attempts = 0
            self.__peer.call("a2a_connect_ready", None)
            self.sync_clock()
        except BaseException:
            try:
                self.__owner.close()
            except BaseException:
                pass
            try:
                sock.close()
            except BaseException:
                pass
            raise OfficialA2AError("A2A_PIPE_HANDSHAKE_FAILED") from None

    @property
    def app_name(self) -> str:
        return self.__app.name

    def sync_clock(self) -> None:
        now = self.__env.time_manager.time()
        if type(now) not in (int, float) or now < 0:
            raise OfficialA2AError("A2A_CLOCK_INVALID")
        try:
            self.__peer.call("a2a_sync_clock", {"now": float(now)})
        except BaseException:
            raise OfficialA2AError("A2A_CLOCK_SYNC_FAILED") from None

    def begin_child(self, *, parent_response: dict[str, Any], task: str) -> dict[str, Any]:
        if self.__closed or self.__handle_token is not None:
            raise OfficialA2AError("A2A_CHILD_REUSED")
        if type(parent_response) is not dict or type(parent_response.get("evidencePath")) is not str:
            raise OfficialA2AError("A2A_PARENT_RECEIPT_INVALID")
        self.sync_clock()
        try:
            reply = self.__peer.call("a2a_begin_child", {"appId": self.__app.name,
                "parentEvidencePath": parent_response["evidencePath"], "task": _safe_text(task)})
        except BaseException:
            raise OfficialA2AError("A2A_CHILD_BEGIN_FAILED") from None
        if (type(reply) is not dict or type(reply.get("handleToken")) is not str
                or type(reply.get("scope")) is not dict):
            raise OfficialA2AError("A2A_CHILD_SCOPE_INVALID")
        self.__handle_token, self.__scope = reply["handleToken"], reply["scope"]
        return reply

    def _model_binding(self) -> tuple[dict, str, ModelRetryPolicy, dict]:
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
        self.__model_requests += 1
        request_id = request.get("requestId") or uuid.uuid4().hex
        original_hash = value_hash(request["messages"])
        response = self.__peer.call("a2a_before_model", {"handleToken": self.__handle_token, "input": {
            "requestId": request_id, "modelScope": model_scope, "originalMessagesHash": original_hash,
            "iteration": request.get("iteration", 0), "messages": projected, "clock": request["clock"]}})
        if (type(response) is not dict or type(response.get("context")) is not str
                or type(response.get("contextHash")) is not str or type(response.get("variablesHash")) is not str
                or type(response.get("revision")) is not int or type(response.get("evidence")) is not dict):
            raise OfficialA2AError("A2A_MODEL_GATE_INVALID")
        context = response["context"]
        actual = list(request["messages"])
        actual.insert(1, {"role": "system", "content": "Live Capybara dynamic context:\n" + context,
                          "attachments": None})
        permit = uuid.uuid4().hex
        return {"schemaVersion": "capybara-scoped-model-gate-v1", "permitId": permit,
            "requestId": request_id, "scopeHash": value_hash(self.__scope),
            "modelScopeHash": model_scope_hash, "originalMessagesHash": original_hash,
            "actualInputHash": value_hash(actual), "context": context,
            "contextHash": response["contextHash"], "variablesHash": response["variablesHash"],
            "revision": response["revision"], "beforeEvidenceRef": response["evidence"]}

    def _model_attempt(self, payload: dict[str, Any], *, model_scope_hash: str) -> dict[str, Any]:
        self.__sdk_attempts += 1
        try:
            self.__peer.call("a2a_assert_model", {"handleToken": self.__handle_token,
                "requestId": payload["requestId"]})
        except BaseException:
            raise OfficialA2AError("A2A_MODEL_ATTEMPT_REJECTED") from None
        return {"schemaVersion": "capybara-scoped-model-sdk-attempt-v1", **payload,
            "scopeHash": value_hash(self.__scope), "modelScopeHash": model_scope_hash,
            "logicalRequestsUsed": self.__model_requests, "sdkAttemptsUsed": self.__sdk_attempts}

    def _model_finish(self, payload: dict[str, Any], *, model_scope_hash: str) -> dict[str, Any]:
        try:
            self.__peer.call("a2a_complete_model", {"handleToken": self.__handle_token,
                "requestId": payload["requestId"]})
        except BaseException:
            raise OfficialA2AError("A2A_MODEL_FINISH_REJECTED") from None
        return {"schemaVersion": "capybara-scoped-model-completion-v1", **payload,
            "scopeHash": value_hash(self.__scope), "modelScopeHash": model_scope_hash,
            "status": "completed"}

    def child_runner(self):
        if self.__scope is None or self.__handle_token is None:
            raise OfficialA2AError("A2A_CHILD_NOT_STARTED")
        model_scope, model_scope_hash, policy, sdk_kwargs = self._model_binding()
        config_hash = model_scope["configHash"]
        engine = ScopedRetryModelEngine(
            role="child_actor", model_scope_hash=model_scope_hash, sdk_completion=_sdk_completion,
            sdk_kwargs_factory=lambda: dict(sdk_kwargs), policy=policy,
            max_logical_requests=model_scope["maxLogicalRequests"], max_sdk_attempts=model_scope["maxSdkAttempts"],
            config_hash=config_hash,
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
            if type(result) is not dict or type(result.get("dispatchId")) is not str or result.get("status") != "completed":
                raise OfficialA2AError("A2A_NATIVE_RESULT_INVALID")
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
        return build_scoped_app_agent(app=self.__app, owner=self.__owner, env=self.__env,
            scope=self.__scope, llm_engine=engine, dispatch=dispatch, model_binding=model_scope,
            model_gate=gate,
            model_attempt=lambda payload: self._model_attempt(payload, model_scope_hash=model_scope_hash),
            model_finish=lambda payload: self._model_finish(payload, model_scope_hash=model_scope_hash),
            max_logical_requests=model_scope["maxLogicalRequests"])

    def reset_child(self, *, completed: bool) -> None:
        """Release the local child slot so one pipe can serve later turns.

        The Node side keeps the opaque handle as an audit record.  A failed
        child is explicitly revoked; a completed child is already closed by
        the final native dispatch and only the Python-side capability is
        cleared here.
        """
        if self.__handle_token is None:
            return
        token = self.__handle_token
        if not completed:
            try:
                self.__peer.call("a2a_cancel_child", {"handleToken": token})
            except BaseException:
                pass
        self.__handle_token = None
        self.__scope = None

    def close(self) -> None:
        if self.__closed:
            return
        self.__closed = True
        try:
            if self.__handle_token is not None:
                self.reset_child(completed=False)
        finally:
            try:
                self.__owner.close()
            finally:
                try:
                    self.__peer.close()
                except BaseException:
                    pass
                try:
                    self.__socket.close()
                except BaseException:
                    pass


def connect_official_a2a(*, env, app, scenario_id: str, workspace: str | Path,
                         model: str, provider: str, endpoint: str, api_key: str) -> OfficialA2AClient:
    """Trusted constructor called only by the official bridge, never Actor input."""
    return OfficialA2AClient(env=env, app=app, scenario_id=scenario_id, workspace=workspace,
                             model=model, provider=provider, endpoint=endpoint, api_key=api_key)
