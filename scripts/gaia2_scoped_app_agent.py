"""Instance-scoped official AppAgent, for a trusted private dispatcher only.

The actual ARE builder, BaseAgent loop/parser/logger and tools are retained.
Only this instance's dispatch and parsed-action exception boundary, and its
TerminationStep, are replaced. The parsed-action body is the original method.
dispatcher is trusted constructor authority, not an Actor-provided callback,
scope, proof or endpoint. It owns the Node child handle and real Host chain.

This module does not call providers, consume an Environment notification queue,
construct native events or re-execute a tool. A broker is admitted only through
the trusted child model gate. This does not synchronize Node and ARE clocks.
"""

from __future__ import annotations

import copy
import hashlib
import inspect
import json
import math
import os
from pathlib import Path
import re
import stat
from types import MethodType
from typing import Any, Callable
import uuid

import gaia2_a2a_wire as wire
from gaia2_private_native_binding import NativeAppBinding
from are.simulation.agents.agent_builder import AppAgentBuilder
from are.simulation.agents.agent_config_builder import AppAgentConfigBuilder
from are.simulation.agents.agent_log import ErrorLog, FinalAnswerLog, ObservationLog, LLMInputLog
from are.simulation.agents.default_agent.agent_factory import are_simulation_react_json_app_agent
from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.agents.default_agent.base_agent import BaseAgent, RunningState, TerminationStep
from are.simulation.agents.default_agent.tools.json_action_executor import JsonActionExecutor
from are.simulation.agents.llm.llm_engine import LLMEngine
from are.simulation.agents.llm.llm_engine_builder import LLMEngineBuilder
from are.simulation.agents.llm.types import MessageRole
from are.simulation.apps.app import App
from are.simulation.environment import Environment
from are.simulation.exceptions import FatalError
from gaia2_generation_time import ScopedAREGenerationTimeOwner
from gaia2_generation_time_ledger import ScopedGenerationTimeLedger

_SCOPE_KEYS = frozenset(("parentExecutionId", "parentSessionId", "environmentGeneration",
    "appId", "parentCanonicalName", "taskArgumentKey", "toolInventoryHash", "taskHash",
    "parentActionId", "requestId", "childExecutionId", "childSessionId", "task", "deadline", "maxNativeActions"))
_ACK_KEYS = frozenset(("schemaVersion", "scopeHash", "dispatchId", "toolId", "toolKind",
    "status", "childCompleted", "completionEvidenceRef"))
_MODEL_SCOPE_KEYS = frozenset(("schemaVersion", "delegationScopeHash", "modelRole", "configHash",
    "maxLogicalRequests", "maxSdkAttempts"))
_GATE_KEYS = frozenset(("schemaVersion", "permitId", "requestId", "scopeHash", "modelScopeHash",
    "originalMessagesHash", "actualInputHash", "context", "contextHash", "variablesHash", "revision", "beforeEvidenceRef"))
_SDK_KEYS = frozenset(("schemaVersion", "permitId", "requestId", "scopeHash", "modelScopeHash", "attempt",
    "actualInputHash", "logicalRequestsUsed", "sdkAttemptsUsed"))
_FINISH_KEYS = frozenset(("schemaVersion", "permitId", "requestId", "scopeHash", "modelScopeHash",
    "actualInputHash", "outputHash", "status", "usage"))
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_ID32 = re.compile(r"[0-9a-f]{32}\Z")
_MAX_BYTES = 4 * 1024 * 1024
_MAX_SAFE = 2**53 - 1
_CONTEXT_PREFIX = "Live Capybara dynamic context:\n"


class ScopedAppAgentFatal(FatalError):
    """Only fixed local codes enter official ErrorLog, never callback text."""

    category = "ScopedAppAgentFatal"


def _fatal(code: str) -> None:
    raise ScopedAppAgentFatal(code) from None


def _clone(value: Any) -> Any:
    try:
        return wire.decode_value(wire.encode_value(value))
    except wire.A2AWireError:
        _fatal("SCOPED_AGENT_UNSAFE_VALUE")


def _exact(value: Any, keys: frozenset | set) -> None:
    if type(value) is not dict or set(value) != keys:
        _fatal("SCOPED_AGENT_CONTRACT_INVALID")
    _clone(value)


def _safe_uint(value: Any, minimum: int = 0) -> bool:
    return type(value) is int and minimum <= value <= _MAX_SAFE


def _usage(value: Any) -> dict | None:
    if value is None:
        return None
    if (type(value) is not dict or not value or set(value) - {"inputTokens", "outputTokens", "totalTokens"}
            or any(not _safe_uint(number) for number in value.values())):
        _fatal("SCOPED_AGENT_MODEL_USAGE_INVALID")
    return _clone(value)


def _read_evidence(ref: Any) -> dict:
    _exact(ref, {"path", "sha256"})
    if type(ref["path"]) is not str or type(ref["sha256"]) is not str or not _HASH.fullmatch(ref["sha256"]):
        _fatal("SCOPED_AGENT_MODEL_EVIDENCE_INVALID")
    try:
        raw = _regular(Path(ref["path"])).read_bytes()
        if len(raw) > _MAX_BYTES or hashlib.sha256(raw).hexdigest() != ref["sha256"]:
            _fatal("SCOPED_AGENT_MODEL_EVIDENCE_INVALID")
        def pairs(items):
            result = {}
            for key, value in items:
                if key in result:
                    _fatal("SCOPED_AGENT_MODEL_EVIDENCE_INVALID")
                result[key] = value
            return result
        receipt = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
            parse_constant=lambda _: _fatal("SCOPED_AGENT_MODEL_EVIDENCE_INVALID"))
        if type(receipt) is not dict:
            _fatal("SCOPED_AGENT_MODEL_EVIDENCE_INVALID")
        return _clone(receipt)
    except BaseException:
        _fatal("SCOPED_AGENT_MODEL_EVIDENCE_INVALID")


def _callable_identity(value: Any) -> tuple:
    """Bound methods are ephemeral; freeze the actual receiver/function chain."""
    receiver = getattr(value, "__self__", None)
    if receiver is not None and not hasattr(value, "__func__"):
        # E.g. a trusted function's built-in __call__ method-wrapper. Its
        # temporary object id changes on every access; the descriptor doesn't.
        descriptor = getattr(type(receiver), getattr(value, "__name__", ""), None)
        return (id(receiver), id(descriptor), None, None, None)
    function = getattr(value, "__func__", value)
    return (id(receiver), id(function),
        id(getattr(function, "__code__", None)), id(getattr(function, "__defaults__", None)),
        id(getattr(function, "__kwdefaults__", None)))


def _regular(path: Path) -> Path:
    if not path.is_absolute():
        _fatal("SCOPED_AGENT_EVIDENCE_INVALID")
    for item in (path, *path.parents):
        try:
            info = item.lstat()
        except OSError:
            _fatal("SCOPED_AGENT_EVIDENCE_INVALID")
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            _fatal("SCOPED_AGENT_EVIDENCE_INVALID")
    if not path.is_file() or os.path.normcase(str(path.resolve())) != os.path.normcase(str(path)):
        _fatal("SCOPED_AGENT_EVIDENCE_INVALID")
    return path


def _safe_model_messages(messages: Any) -> list[dict]:
    if type(messages) is not list:
        _fatal("SCOPED_AGENT_MODEL_INPUT_INVALID")
    result = []
    for message in messages:
        if type(message) is not dict or set(message) - {"role", "content", "attachments"}:
            _fatal("SCOPED_AGENT_MODEL_INPUT_INVALID")
        role = message.get("role")
        if type(role) is MessageRole:
            role = role.value
        if type(role) is not str or role not in MessageRole.roles() or type(message.get("content")) is not str:
            _fatal("SCOPED_AGENT_MODEL_INPUT_INVALID")
        # Controlled text-only slice. Never type-erase a multimodal attachment.
        if message.get("attachments") not in (None, []):
            _fatal("SCOPED_AGENT_ATTACHMENT_UNSUPPORTED")
        result.append({"role": role, "content": message["content"], "attachments": None})
    return _clone(result)


class ControlledAppAgentEngine(LLMEngine):
    """Finite offline response sequence; exhaustion is fatal, never fallback."""

    def __init__(self, responses: list[str] | tuple[str, ...]):
        if type(responses) not in (list, tuple) or not responses or len(responses) > 100000:
            _fatal("SCOPED_AGENT_RESPONSES_INVALID")
        for response in responses:
            if type(response) is not str:
                _fatal("SCOPED_AGENT_RESPONSES_INVALID")
            _clone(response)
        super().__init__("controlled-scoped-app-agent")
        self.__responses = tuple(responses)
        self.calls = 0
        self.received_messages: list[list[dict]] = []
        self.input_hashes: list[str] = []

    def chat_completion(self, messages, stop_sequences=(), **kwargs):
        safe = _safe_model_messages(messages)
        self.calls += 1
        self.received_messages.append(safe)
        self.input_hashes.append(wire.value_hash(safe))
        if self.calls > len(self.__responses):
            _fatal("SCOPED_AGENT_MODEL_EXHAUSTED")
        response = self.__responses[self.calls - 1]
        for stop in stop_sequences:
            if type(stop) is not str:
                _fatal("SCOPED_AGENT_MODEL_INPUT_INVALID")
            response = response.split(stop)[0]
        return response, {"completion_duration": 0}


class _InjectedEngineBuilder(LLMEngineBuilder):
    def __init__(self, engine: LLMEngine):
        self.__engine = engine

    def create_engine(self, engine_config, mock_responses=None):
        if mock_responses is not None:
            _fatal("SCOPED_AGENT_MODEL_FALLBACK_FORBIDDEN")
        return self.__engine


class ScopedAppAgentRunner:
    """Trusted instance lifetime. run() has no Actor kwargs or reset facility."""

    def __init__(self, *, app: App, owner: NativeAppBinding, env: Environment,
                 scope: dict, llm_engine: LLMEngine, dispatch: Callable[[dict], dict],
                 model_binding: dict | None = None, model_gate: Callable | None = None,
                 model_attempt: Callable | None = None, model_finish: Callable | None = None,
                 max_logical_requests: int | None = None, log_callback: Callable | None = None,
                 generation_time_owner_factory: Callable[[], ScopedAREGenerationTimeOwner] | None = None,
                 generation_ledger_factory: Callable[..., ScopedGenerationTimeLedger] | None = None):
        if (not isinstance(app, App) or not isinstance(owner, NativeAppBinding)
                or not isinstance(env, Environment) or not isinstance(llm_engine, LLMEngine)
                or not callable(dispatch) or env.apps.get(app.name) is not app
                or app.time_manager is not env.time_manager
                or (log_callback is not None and not callable(log_callback))):
            _fatal("SCOPED_AGENT_INITIALIZATION_INVALID")
        _exact(scope, _SCOPE_KEYS)
        manifest = owner.manifest()
        expected = {key: manifest[key] for key in ("parentExecutionId", "parentSessionId",
            "environmentGeneration", "appId", "parentCanonicalName", "taskArgumentKey", "toolInventoryHash")}
        if (any(scope[key] != value for key, value in expected.items()) or app.name != manifest["appId"]
                or type(app).__module__ + "." + type(app).__qualname__ != manifest["appType"]):
            _fatal("SCOPED_AGENT_SCOPE_INVALID")
        if (any(type(scope[key]) is not str or not scope[key] for key in _SCOPE_KEYS - {"deadline", "maxNativeActions"})
                or not _HASH.fullmatch(scope["taskHash"])
                or hashlib.sha256(scope["task"].encode("utf-8")).hexdigest() != scope["taskHash"]
                or type(scope["maxNativeActions"]) is not int or not 1 <= scope["maxNativeActions"] <= 100000
                or type(scope["deadline"]) not in (int, float) or not math.isfinite(scope["deadline"]) or scope["deadline"] < 0):
            _fatal("SCOPED_AGENT_SCOPE_INVALID")
        self.__owner = owner
        self.__env = env
        self.__manifest = manifest
        self.__manifest_hash = wire.value_hash(manifest)
        self.__scope = _clone(scope)
        self.__scope_hash = wire.value_hash(scope)
        # Generation-time integration is an explicit opt-in surface.  The
        # first runner slice only binds and audits the trusted objects; it
        # intentionally leaves the official BaseAgent simulation config at
        # None and does not alter model-call timing yet.
        if (generation_time_owner_factory is None) != (generation_ledger_factory is None):
            _fatal("SCOPED_AGENT_GENERATION_INTEGRATION_INVALID")
        if generation_time_owner_factory is not None:
            if not callable(generation_time_owner_factory):
                _fatal("SCOPED_AGENT_GENERATION_INTEGRATION_INVALID")
            if not callable(generation_ledger_factory):
                _fatal("SCOPED_AGENT_GENERATION_INTEGRATION_INVALID")
        self.__generation_time_owner_factory = generation_time_owner_factory
        self.__generation_ledger_factory = generation_ledger_factory
        self.__generation_owner_factory_identity = None if generation_time_owner_factory is None else _callable_identity(generation_time_owner_factory)
        self.__generation_ledger_factory_identity = None if generation_ledger_factory is None else _callable_identity(generation_ledger_factory)
        supplied = (model_binding, model_gate, model_attempt, model_finish)
        self.__gated = any(item is not None for item in supplied)
        if self.__gated:
            if model_binding is None or not all(callable(item) for item in supplied[1:]):
                _fatal("SCOPED_AGENT_MODEL_GATE_REQUIRED")
            _exact(model_binding, _MODEL_SCOPE_KEYS)
            if (model_binding["schemaVersion"] != "capybara-scoped-model-scope-v1"
                    or model_binding["delegationScopeHash"] != self.__scope_hash
                    or model_binding["modelRole"] != "child_actor"
                    or type(model_binding["configHash"]) is not str or not _HASH.fullmatch(model_binding["configHash"])
                    or any(not _safe_uint(model_binding[key], 1) or model_binding[key] > 100000
                        for key in ("maxLogicalRequests", "maxSdkAttempts"))
                    or (max_logical_requests is not None and max_logical_requests != model_binding["maxLogicalRequests"])
                    or any(not callable(getattr(llm_engine, method, None)) for method in ("begin_request", "get_last_usage", "snapshot"))):
                _fatal("SCOPED_AGENT_MODEL_BINDING_INVALID")
            self.__model_binding = _clone(model_binding)
            self.__model_scope_hash = wire.value_hash(model_binding)
            self.__logical_budget = model_binding["maxLogicalRequests"]
        else:
            # Only the explicit finite offline engine is permitted without a
            # model gate; a real/custom engine can never silently fall through.
            if type(llm_engine) is not ControlledAppAgentEngine:
                _fatal("SCOPED_AGENT_MODEL_GATE_REQUIRED")
            self.__model_binding = self.__model_scope_hash = None
            # Preserve the old controlled fixture limit only for compatibility.
            self.__logical_budget = scope["maxNativeActions"] if max_logical_requests is None else max_logical_requests
            if not _safe_uint(self.__logical_budget, 1) or self.__logical_budget > 100000:
                _fatal("SCOPED_AGENT_MODEL_BINDING_INVALID")
        self.__model_gate, self.__model_attempt, self.__model_finish = model_gate, model_attempt, model_finish
        self.__sdk_guard_callback = self.__sdk_guard  # Stable bound callable for broker identity freezing.
        self.__active_model = None
        self.__sdk_attempts = 0
        self.__engine_calls = 0
        self.__gate_revision = 0
        self.__gate_sequence = 0
        self.__gate_permits: set[str] = set()
        self.__gate_evidence: set[str] = set()
        self.__projected_history: list[dict] = []
        self.__original_input_hashes: list[str] = []
        self.__model_receipts: list[dict] = []
        self.__model = llm_engine
        self.__engine_identity_hash = None
        self.__dispatch = dispatch
        self.__started = False
        self.__closed = False
        self.__completed = False
        self.__failed = False
        self.__final_answer = None
        self.__completion_ref = None
        self.__seen_dispatches: set[str] = set()
        self.__actions: list[dict] = []
        self.__wrapped_task_hash = None
        self.__actor_input_hashes: list[str] = []
        self.__model_calls = 0
        self.__observations_taken = 0
        self.__failure_code = None
        self.__final_log_start = None
        self.__sources: dict[str, dict] = {ref["path"]: ref for ref in manifest["sourceRefs"]}
        self.__tools = {tool["publicName"]: tool for tool in manifest["tools"]}
        config = AppAgentConfigBuilder().build("default_app_agent")
        config.use_custom_logger = False
        config.max_iterations = self.__logical_budget
        # The official builder and factory are used unchanged. No provider engine
        # is constructed; its injected builder returns the trusted engine only.
        self.app_agent = AppAgentBuilder(_InjectedEngineBuilder(llm_engine)).build(config, app, env)
        self.base_agent = self.app_agent.app_agent
        self.executor = self.base_agent.action_executor
        if type(self.app_agent) is not AppAgent or type(self.base_agent) is not BaseAgent or type(self.executor) is not JsonActionExecutor:
            _fatal("SCOPED_AGENT_OFFICIAL_INSTANCE_INVALID")
        self.app_agent.register_time_manager(env.time_manager)
        self.base_agent.time_manager = env.time_manager
        self.base_agent.parent = None  # Parent relation is scope-bound, not guessed.
        self.base_agent.pause_env = env.pause
        self.base_agent.resume_env = env.resume_with_offset
        self.base_agent.total_iterations = self.__logical_budget
        # ARE increments format_try_count before comparing it to this value.
        # A zero limit rejects even the first valid response. One with retries
        # disabled means exactly one request per official step.
        self.base_agent.invalid_format_retries = 1
        self.base_agent.retry_llm_call_on_error = False
        # No shared notifications/pre-step: only the parent owner may consume
        # due notifications and revoke an obsolete child. No future queue view.
        self.base_agent.notification_system = None
        self.base_agent.simulated_generation_time_config = None
        # Keep actual official metadata Tools, but execution never falls through
        # to them. The owner invokes its retained original adapter exactly once.
        self.base_agent.tools = {name: tool for name, tool in self.base_agent.tools.items() if name in self.__tools}
        self.__official_execute_parsed = self.executor.execute_parsed_action
        self.executor.execute_tool_call = MethodType(self.__execute_tool_call, self.executor)
        self.executor.execute_parsed_action = MethodType(self.__execute_parsed_action, self.executor)
        self.base_agent.termination_step = TerminationStep(condition=self.__termination_condition,
            function=self.__termination_result, name="scoped_verified_final_answer")
        self.__model = llm_engine
        self.base_agent.llm_engine = self.__model_call
        self.__official_log_callback = self.base_agent.log_callback if log_callback is None else log_callback
        self.base_agent.log_callback = self.__log_callback
        self.__collect_sources(dispatch, type(llm_engine), AppAgentBuilder, AppAgentConfigBuilder,
            BaseAgent, JsonActionExecutor, TerminationStep, LLMEngine, _InjectedEngineBuilder,
            ControlledAppAgentEngine, type(self), AppAgent, are_simulation_react_json_app_agent,
            self.executor._append_final_answer, type(self.executor).extract_action, self.__official_log_callback)
        if self.__generation_time_owner_factory is not None:
            self.__collect_sources(self.__generation_time_owner_factory, self.__generation_ledger_factory,
                ScopedAREGenerationTimeOwner, ScopedGenerationTimeLedger)
        if self.__gated:
            self.__collect_sources(model_gate, model_attempt, model_finish, llm_engine.begin_request,
                llm_engine.get_last_usage, llm_engine.snapshot)
            self.__engine_binding()
        self.__instance_snapshot = self.__snapshot_instances()

    def __collect_sources(self, *objects: Any) -> None:
        for item in objects:
            try:
                source = inspect.getsourcefile(item)
            except (OSError, TypeError):
                source = None
            if source is None:
                # Trusted callable objects need their actual class source.
                try:
                    source = inspect.getsourcefile(type(item))
                except (OSError, TypeError):
                    source = None
            if source is None:
                _fatal("SCOPED_AGENT_SOURCE_UNAVAILABLE")
            path = _regular(Path(os.path.abspath(source)))
            data = path.read_bytes()
            self.__sources[str(path)] = {"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}

    def __snapshot_instances(self) -> tuple:
        base, executor = self.base_agent, self.executor
        return (id(self.app_agent), id(base), id(executor), id(base.time_manager), id(self.app_agent.time_manager),
            id(self.app_agent.app_agent), id(base.action_executor), id(self.__env.time_manager),
            id(self.__env.apps.get(self.__manifest["appId"])), id(base.parent),
            tuple((name, id(tool), tool.name) for name, tool in base.tools.items()),
            id(base.llm_engine), id(executor.execute_tool_call), id(base.termination_step),
            id(base.termination_step.condition), id(base.termination_step.function),
            id(BaseAgent.run), id(BaseAgent.step), id(BaseAgent.execute_agent_loop),
            id(JsonActionExecutor.parse_action), id(JsonActionExecutor.execute_parsed_action),
            id(AppAgent.expert_agent), base.max_iterations, base.total_iterations,
            base.invalid_format_retries, base.retry_llm_call_on_error,
            id(base.notification_system), id(base.simulated_generation_time_config),
            tuple(_callable_identity(getattr(base, name)) for name in (
                "run", "step", "execute_agent_loop", "initialize", "init_tools", "replay",
                "append_agent_log", "log_error", "make_timestamp", "build_history_from_logs",
                "update_system_prompt_tools")),
            tuple(_callable_identity(getattr(executor, name)) for name in (
                "parse_action", "execute_parsed_action", "extract_action", "_append_final_answer", "update_tools")),
            _callable_identity(self.app_agent.expert_agent), _callable_identity(base.log_callback),
            _callable_identity(self.__official_log_callback),
            _callable_identity(self.__official_execute_parsed),
            _callable_identity(self.__dispatch), _callable_identity(getattr(self.__dispatch, "__call__", None)),
            id(self.__owner), _callable_identity(self.__owner.manifest),
            _callable_identity(self.__owner.take_agent_observation),
            _callable_identity(base.pause_env), _callable_identity(base.resume_env),
            _callable_identity(self.__model.chat_completion), _callable_identity(type(self.__model).__call__),
            tuple((id(step), _callable_identity(step.condition), _callable_identity(step.function))
                for step in base.conditional_pre_steps),
            tuple((id(step), _callable_identity(step.condition), _callable_identity(step.function))
                for step in base.conditional_post_steps), self.__logical_budget,
            wire.value_hash(self.__model_binding),
            tuple((_callable_identity(callback), _callable_identity(getattr(callback, "__call__", None)))
                for callback in (self.__model_gate, self.__model_attempt, self.__model_finish, self.__sdk_guard_callback)),
            tuple(_callable_identity(getattr(self.__model, name, None)) for name in (
                "begin_request", "get_last_usage", "snapshot")) if self.__gated else (),
            self.__generation_owner_factory_identity,
            self.__generation_ledger_factory_identity,
            _callable_identity(self.__generation_ledger_factory) if self.__generation_ledger_factory is not None else ())

    def __engine_binding(self) -> None:
        if not self.__gated:
            return
        binding = self.__model_binding
        if (self.__model.model_role != "child_actor" or self.__model.model_scope_hash != self.__model_scope_hash
                or self.__model.config_hash != binding["configHash"]
                or self.__model.max_logical_requests != binding["maxLogicalRequests"]
                or self.__model.max_sdk_attempts != binding["maxSdkAttempts"]):
            _fatal("SCOPED_AGENT_MODEL_BINDING_CHANGED")

        snapshot = self.__model.snapshot()
        if (type(snapshot) is not dict or snapshot.get("schemaVersion") != "gaia2-scoped-model-engine-v1"
                or snapshot.get("modelRole") != "child_actor" or snapshot.get("modelScopeHash") != self.__model_scope_hash
                or snapshot.get("configHash") != binding["configHash"]
                or snapshot.get("maxLogicalRequests") != binding["maxLogicalRequests"]
                or snapshot.get("maxSdkAttempts") != binding["maxSdkAttempts"]
                or type(snapshot.get("sourceIdentityHash")) is not str or not _HASH.fullmatch(snapshot["sourceIdentityHash"])):
            _fatal("SCOPED_AGENT_MODEL_BINDING_CHANGED")
        if self.__engine_identity_hash is None:
            self.__engine_identity_hash = snapshot["sourceIdentityHash"]
        elif self.__engine_identity_hash != snapshot["sourceIdentityHash"]:
            _fatal("SCOPED_AGENT_MODEL_BINDING_CHANGED")

    def __generation_binding(self) -> None:
        """Audit the opt-in generation integration without starting it.

        The owner may acquire a lease only in the later c2.2b timing slice;
        this first slice merely pins its environment/source identity and the
        ledger-factory callable.  A closed/failed owner is not reusable.
        """
        if self.__generation_time_owner_factory is None:
            return
        if (_callable_identity(self.__generation_time_owner_factory)
                != self.__generation_owner_factory_identity):
            _fatal("SCOPED_AGENT_GENERATION_INTEGRATION_CHANGED")
        if (_callable_identity(self.__generation_ledger_factory)
                != self.__generation_ledger_factory_identity):
            _fatal("SCOPED_AGENT_GENERATION_INTEGRATION_CHANGED")

    def __log_callback(self, log):
        # The official append_agent_log method remains intact. Only its trusted
        # callback exception boundary is guarded, including pre-action logs.
        try:
            return self.__official_log_callback(log)
        except BaseException:
            self.__failed = True
            self.__failure_code = "SCOPED_AGENT_LOG_FAILED"
            _fatal(self.__failure_code)

    def __check(self) -> None:
        if self.__closed:
            _fatal("SCOPED_AGENT_CLOSED")
        try:
            if self.__snapshot_instances() != self.__instance_snapshot:
                _fatal("SCOPED_AGENT_SOURCE_CHANGED")
            if wire.value_hash(self.__owner.manifest()) != self.__manifest_hash:
                _fatal("SCOPED_AGENT_SOURCE_CHANGED")
            self.__engine_binding()
            self.__generation_binding()
            for ref in self.__sources.values():
                data = _regular(Path(ref["path"])).read_bytes()
                if len(data) != ref["bytes"] or hashlib.sha256(data).hexdigest() != ref["sha256"]:
                    _fatal("SCOPED_AGENT_SOURCE_CHANGED")
        except ScopedAppAgentFatal:
            raise
        except BaseException:
            _fatal("SCOPED_AGENT_SOURCE_CHANGED")

    def __projection(self, messages: list[dict], request_id: str) -> tuple[list[dict], list[dict]]:
        hashes = [wire.value_hash(message) for message in messages]
        ledger = self.__projected_history
        matched = min(len(ledger), len(hashes))
        while matched and [entry["hash"] for entry in ledger[-matched:]] != hashes[:matched]:
            matched -= 1
        if not matched and any(value in {entry["hash"] for entry in ledger} for value in hashes):
            _fatal("SCOPED_AGENT_MODEL_HISTORY_REPLAY")
        ids = [entry["id"] for entry in ledger[-matched:]] if matched else []
        appended = []
        for value in hashes[matched:]:
            identifier = self.__scope["childExecutionId"] + ".model-message-" + str(len(ledger) + len(appended) + 1)
            ids.append(identifier)
            appended.append({"hash": value, "id": identifier})
        projected = [{"role": {"tool-call": "assistant", "tool-response": "tool"}.get(message["role"], message["role"]),
            "content": message["content"], "id": identifier, "requestId": request_id}
            for message, identifier in zip(messages, ids)]
        return projected, ledger + appended

    def __admit_model(self, safe: list[dict]) -> list[dict]:
        now = self.__env.time_manager.time()
        if type(now) not in (int, float) or not math.isfinite(now) or now < 0:
            _fatal("SCOPED_AGENT_MODEL_CLOCK_INVALID")
        request = {"requestId": uuid.uuid4().hex, "iteration": self.base_agent.iterations,
            "messages": safe, "clock": {"now": now, "revision": self.__gate_revision}}
        ack = self.__model_gate(_clone(request))
        _exact(ack, _GATE_KEYS)
        if (ack["schemaVersion"] != "capybara-scoped-model-gate-v1"
                or type(ack["permitId"]) is not str or not _ID32.fullmatch(ack["permitId"])
                or ack["permitId"] in self.__gate_permits or ack["requestId"] != request["requestId"]
                or ack["scopeHash"] != self.__scope_hash or ack["modelScopeHash"] != self.__model_scope_hash
                or ack["originalMessagesHash"] != wire.value_hash(safe)
                or type(ack["context"]) is not str or ack["contextHash"] != hashlib.sha256(ack["context"].encode("utf-8")).hexdigest()
                or type(ack["variablesHash"]) is not str or not _HASH.fullmatch(ack["variablesHash"])
                or not _safe_uint(ack["revision"]) or ack["revision"] < self.__gate_revision):
            _fatal("SCOPED_AGENT_MODEL_GATE_ACK_INVALID")
        actual = _clone(safe)
        actual.insert(1, {"role": "system", "content": _CONTEXT_PREFIX + ack["context"], "attachments": None})
        if ack["actualInputHash"] != wire.value_hash(actual):
            _fatal("SCOPED_AGENT_MODEL_GATE_INPUT_INVALID")
        receipt = _read_evidence(ack["beforeEvidenceRef"])
        _exact(receipt.get("trustedModelAdmission"), {"delegationScopeHash", "modelScope", "modelScopeHash", "originalMessagesHash"})
        admission = {"delegationScopeHash": self.__scope_hash, "modelScope": self.__model_binding,
            "modelScopeHash": self.__model_scope_hash, "originalMessagesHash": wire.value_hash(safe)}
        projected, ledger = self.__projection(safe, request["requestId"])
        invocation = {"checkpoint": "before_model", "loop": {"runId": self.__scope["childExecutionId"],
            "iteration": request["iteration"], "terminal": False}, "messages": projected, "clock": request["clock"]}
        ref = ack["beforeEvidenceRef"]
        if (receipt.get("schemaVersion") != "capybara-runtime-plugin-invocation-v1"
                or receipt.get("executionId") != self.__scope["childExecutionId"]
                or receipt.get("sessionId") != self.__scope["childSessionId"]
                or not _safe_uint(receipt.get("sequence"), 1) or receipt["sequence"] <= self.__gate_sequence
                or ref["path"] in self.__gate_evidence
                or wire.value_hash(receipt.get("trustedModelAdmission")) != wire.value_hash(admission)
                or wire.value_hash(receipt.get("input")) != wire.value_hash(invocation)
                or type(receipt.get("decision")) is not dict or receipt["decision"].get("action") != "allow"
                or any(receipt.get(key) != ack[key] for key in ("context", "contextHash", "variablesHash", "revision"))
                or type(receipt.get("hookReceipts")) is not list
                or any(type(item) is not dict or item.get("status") != "passed" for item in receipt["hookReceipts"])):
            _fatal("SCOPED_AGENT_MODEL_GATE_EVIDENCE_INVALID")
        self.__projected_history = ledger
        self.__gate_revision = ack["revision"]
        self.__gate_sequence = receipt["sequence"]
        self.__gate_permits.add(ack["permitId"])
        self.__gate_evidence.add(ref["path"])
        record = {key: _clone(ack[key]) for key in _GATE_KEYS - {"schemaVersion", "context"}}
        record["iteration"] = request["iteration"]
        record["sdkAttempts"] = []
        record["completed"] = False
        self.__model_receipts.append(record)
        self.__active_model = {"permitId": ack["permitId"], "requestId": request["requestId"],
            "actualInputHash": ack["actualInputHash"], "attempt": 0, "record": record}
        self.__check()
        return actual

    def __sdk_guard(self, payload: dict) -> dict:
        try:
            self.__check()
            if self.__failed or self.__completed or self.__active_model is None:
                _fatal("SCOPED_AGENT_MODEL_REQUEST_INACTIVE")
            _exact(payload, {"permitId", "requestId", "attempt", "actualInputHash"})
            active = self.__active_model
            if (any(payload[key] != active[key] for key in ("permitId", "requestId", "actualInputHash"))
                    or not _safe_uint(payload["attempt"], 1) or payload["attempt"] != active["attempt"] + 1
                    or self.__sdk_attempts >= self.__model_binding["maxSdkAttempts"]):
                _fatal("SCOPED_AGENT_MODEL_SDK_ATTEMPT_INVALID")
            ack = self.__model_attempt(_clone(payload))
            _exact(ack, _SDK_KEYS)
            if (ack["schemaVersion"] != "capybara-scoped-model-sdk-attempt-v1"
                    or any(ack[key] != payload[key] for key in payload)
                    or ack["scopeHash"] != self.__scope_hash or ack["modelScopeHash"] != self.__model_scope_hash
                    or not _safe_uint(ack["logicalRequestsUsed"], 1) or ack["logicalRequestsUsed"] != self.__model_calls
                    or not _safe_uint(ack["sdkAttemptsUsed"], 1) or ack["sdkAttemptsUsed"] != self.__sdk_attempts + 1):
                _fatal("SCOPED_AGENT_MODEL_SDK_ACK_INVALID")
            self.__check()
            active["attempt"] += 1
            self.__sdk_attempts += 1
            active["record"]["sdkAttempts"].append(_clone(ack))
            return _clone(ack)
        except BaseException:
            self.__failed = True
            self.__failure_code = "SCOPED_AGENT_MODEL_SDK_FAILED"
            _fatal(self.__failure_code)

    def __model_call(self, messages, stop_sequences=(), **kwargs):
        try:
            self.__check()
            if self.__failed or self.__completed or self.__active_model is not None:
                _fatal("SCOPED_AGENT_TERMINAL")
            safe = _safe_model_messages(messages)
            if (not self.base_agent.logs or not isinstance(self.base_agent.logs[-1], LLMInputLog)
                    or wire.value_hash(_safe_model_messages(self.base_agent.logs[-1].content)) != wire.value_hash(safe)):
                _fatal("SCOPED_AGENT_MODEL_LOG_INPUT_INVALID")
            self.__wrapped_task_hash = hashlib.sha256(self.base_agent.task.encode("utf-8")).hexdigest()
            self.__original_input_hashes.append(wire.value_hash(safe))
            self.__model_calls += 1
            if self.__model_calls > self.__logical_budget:
                _fatal("SCOPED_AGENT_BUDGET_EXHAUSTED")
            actual = self.__admit_model(safe) if self.__gated else safe
            if self.__gated:
                active = self.__active_model
                self.__model.begin_request(permit_id=active["permitId"], request_id=active["requestId"],
                    actual_input_hash=active["actualInputHash"], before_attempt=self.__sdk_guard_callback)
                self.__check()
            self.__actor_input_hashes.append(wire.value_hash(actual))
            self.__engine_calls += 1
            # Keep the engine's actual tuple/metadata object in Python. Only
            # safe hashes/usage go to the private model-completion protocol.
            result = self.__model(actual if self.__gated else messages, stop_sequences=stop_sequences, **kwargs)
            self.__check()
            if self.__gated:
                if type(result) is not tuple or len(result) != 2 or type(result[0]) is not str:
                    _fatal("SCOPED_AGENT_MODEL_OUTPUT_INVALID")
                output_hash = hashlib.sha256(result[0].encode("utf-8", errors="strict")).hexdigest()
                if self.__active_model["attempt"] < 1:
                    _fatal("SCOPED_AGENT_MODEL_SDK_MISSING")
                usage = _usage(self.__model.get_last_usage())
                finish = {"permitId": active["permitId"], "requestId": active["requestId"],
                    "actualInputHash": active["actualInputHash"], "outputHash": output_hash, "usage": usage}
                ack = self.__model_finish(_clone(finish))
                _exact(ack, _FINISH_KEYS)
                if (ack["schemaVersion"] != "capybara-scoped-model-completion-v1"
                        or ack["scopeHash"] != self.__scope_hash or ack["modelScopeHash"] != self.__model_scope_hash
                        or ack["status"] != "completed" or any(ack[key] != finish[key] for key in finish)):
                    _fatal("SCOPED_AGENT_MODEL_FINISH_INVALID")
                self.__check()
                active["record"].update({"completed": True, "outputHash": output_hash, "usage": usage})
            return result
        except BaseException:
            self.__failed = True
            self.__failure_code = self.__failure_code or "SCOPED_AGENT_MODEL_FAILED"
            _fatal(self.__failure_code)
        finally:
            self.__active_model = None

    def __completion(self, ref: Any, dispatch_id: str) -> dict:
        _exact(ref, {"path", "sha256"})
        if type(ref["path"]) is not str or type(ref["sha256"]) is not str or not _HASH.fullmatch(ref["sha256"]):
            _fatal("SCOPED_AGENT_COMPLETION_INVALID")
        try:
            raw = _regular(Path(ref["path"])).read_bytes()
            if len(raw) > _MAX_BYTES or hashlib.sha256(raw).hexdigest() != ref["sha256"]:
                _fatal("SCOPED_AGENT_COMPLETION_INVALID")
            def pairs(items):
                result = {}
                for key, value in items:
                    if key in result:
                        _fatal("SCOPED_AGENT_COMPLETION_INVALID")
                    result[key] = value
                return result
            receipt = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
                parse_constant=lambda _: _fatal("SCOPED_AGENT_COMPLETION_INVALID"))
            _clone(receipt)
            if (type(receipt) is not dict or receipt.get("schemaVersion") != "capybara-runtime-delegation-receipt-v1"
                    or receipt.get("kind") != "completed"
                    or receipt.get("environmentGeneration") != self.__scope["environmentGeneration"]
                    or receipt.get("parentExecutionId") != self.__scope["parentExecutionId"]
                    or receipt.get("parentSessionId") != self.__scope["parentSessionId"]
                    or type(receipt.get("data")) is not dict
                    or wire.value_hash(receipt["data"].get("scope")) != self.__scope_hash
                    or receipt["data"].get("finalDispatchId") != dispatch_id):
                _fatal("SCOPED_AGENT_COMPLETION_INVALID")
        except BaseException:
            _fatal("SCOPED_AGENT_COMPLETION_INVALID")
        return _clone(ref)

    def __execute_tool_call(self, executor, parsed_action, append_agent_log, make_timestamp):
        self.__check()
        if self.__failed or self.__completed:
            _fatal("SCOPED_AGENT_TERMINAL")
        name = parsed_action.tool_name
        arguments = parsed_action.arguments if parsed_action.arguments else {}
        if type(name) is not str or name not in self.__tools or type(arguments) is not dict:
            _fatal("SCOPED_AGENT_ACTION_INVALID")
        tool = self.__tools[name]
        _clone(arguments)
        if tool["toolKind"] == "child_final_answer" and (set(arguments) != {"answer"} or type(arguments["answer"]) is not str):
            _fatal("SCOPED_AGENT_FINAL_ARGUMENT_INVALID")
        try:
            ack = self.__dispatch({"tool": name, "arguments": copy.deepcopy(arguments)})
            _exact(ack, _ACK_KEYS)
            if (ack["schemaVersion"] != "capybara-scoped-agent-dispatch-v1" or ack["scopeHash"] != self.__scope_hash
                    or ack["toolId"] != tool["toolId"] or ack["toolKind"] != tool["toolKind"]
                    or ack["status"] != "completed" or type(ack["childCompleted"]) is not bool
                    or type(ack["dispatchId"]) is not str or str(uuid.UUID(ack["dispatchId"])) != ack["dispatchId"]
                    or ack["dispatchId"] in self.__seen_dispatches):
                _fatal("SCOPED_AGENT_DISPATCH_ACK_INVALID")
            final = tool["toolKind"] == "child_final_answer"
            if ack["childCompleted"] is not final or (not final and ack["completionEvidenceRef"] is not None):
                _fatal("SCOPED_AGENT_DISPATCH_ACK_INVALID")
            completion_ref = self.__completion(ack["completionEvidenceRef"], ack["dispatchId"]) if final else None
            self.__check()
            observation = self.__owner.take_agent_observation(ack["dispatchId"])
            self.__observations_taken += 1
            self.__check()
            if final and (type(observation) is not str or observation != arguments["answer"]):
                _fatal("SCOPED_AGENT_FINAL_OBSERVATION_INVALID")
            self.__seen_dispatches.add(ack["dispatchId"])
            self.__actions.append({"dispatchId": ack["dispatchId"], "toolId": tool["toolId"],
                "toolKind": tool["toolKind"], "status": "completed", "childCompleted": final})
            if final:
                self.__completion_ref = completion_ref
                self.__final_answer = observation
                self.__completed = True
                self.__final_log_start = len(self.base_agent.logs)
            return observation
        except BaseException:
            self.__failed = True
            _fatal("SCOPED_AGENT_DISPATCH_FAILED")

    def __execute_parsed_action(self, executor, parsed_action, append_agent_log, make_timestamp, agent_id):
        """Run the unchanged ARE body; never retry a lost native observation.

        ARE normally logs and continues after ordinary execution/logging
        exceptions. A native action may already have changed the App at that
        point. Only this boundary converts that condition to sticky FatalError.
        Pre-dispatch format parsing remains the original bounded ARE behavior.
        """
        try:
            self.__check()
            self.__official_execute_parsed(parsed_action, append_agent_log, make_timestamp, agent_id)
            self.__check()
        except BaseException:
            self.__failed = True
            self.__failure_code = "SCOPED_AGENT_ACTION_FAILED"
            _fatal(self.__failure_code)

    def __termination_condition(self, agent):
        if self.__completed:
            return True
        if self.__closed or self.__failed or agent.iterations >= agent.total_iterations:
            self.__failure_code = "SCOPED_AGENT_CLOSED" if self.__closed else "SCOPED_AGENT_DISPATCH_FAILED" if self.__failed else "SCOPED_AGENT_BUDGET_EXHAUSTED"
            return True
        return False

    def __termination_result(self, agent):
        # BaseAgent calls this even after FatalError break, not just normal stop.
        self.__check()
        if not self.__completed or self.__failed or agent.custom_state.get("running_state") is RunningState.FAILED:
            _fatal(self.__failure_code or "SCOPED_AGENT_NOT_COMPLETED")
        # A completion receipt authorizes termination, but does not excuse an
        # error in the real official observation/final logging path. In
        # particular, ARE catches ordinary logger errors without FAILED state.
        tail = agent.logs[self.__final_log_start:]
        if (any(isinstance(log, ErrorLog) for log in tail)
                or len(tail) != 2 or not isinstance(tail[0], ObservationLog)
                or not isinstance(tail[1], FinalAnswerLog)
                or tail[0].content != (self.__final_answer.strip() if self.__final_answer else "No observation")
                or tail[1].content != self.__final_answer):
            _fatal("SCOPED_AGENT_FINAL_LOG_INVALID")
        self.__completion(self.__completion_ref, self.__actions[-1]["dispatchId"])
        return self.__final_answer

    def run(self) -> str:
        if self.__started:
            _fatal("SCOPED_AGENT_RUN_REUSED")
        self.__started = True
        try:
            self.__check()
            # Original expert_agent supplies the real AUI envelope and invokes
            # the actual BaseAgent.run(), initialize(), step() and logger.
            returned = self.app_agent.expert_agent(self.__scope["task"])
            self.__check()
            if not self.__completed or self.__failed or returned != self.__final_answer:
                _fatal("SCOPED_AGENT_NOT_COMPLETED")
            return returned
        except BaseException as exc:
            self.__failed = True
            self.__failure_code = self.__failure_code or (str(exc) if isinstance(exc, ScopedAppAgentFatal)
                else "SCOPED_AGENT_RUN_FAILED")
            _fatal(self.__failure_code)

    def snapshot(self) -> dict:
        return _clone({"schemaVersion": "gaia2-scoped-app-agent-v1", "scopeHash": self.__scope_hash,
            "sourceManifestHash": self.__manifest_hash, "sourceRefs": sorted(self.__sources.values(), key=lambda ref: ref["path"].encode("utf-8")),
            "originalTaskHash": self.__scope["taskHash"], "wrappedTaskHash": self.__wrapped_task_hash,
            "actorInputHashes": self.__actor_input_hashes, "modelCalls": self.__model_calls,
            "originalAreInputHashes": self.__original_input_hashes, "engineCalls": self.__engine_calls,
            "modelGateEnabled": self.__gated, "modelScopeHash": self.__model_scope_hash,
            "maxLogicalRequests": self.__logical_budget, "sdkAttemptsUsed": self.__sdk_attempts,
            "modelRequests": self.__model_receipts,
            "generationTimeOptIn": self.__generation_time_owner_factory is not None,
            "generationTimeOwnerFactoryBound": self.__generation_time_owner_factory is not None,
            "generationLedgerFactoryBound": self.__generation_ledger_factory is not None,
            "originalObservationsTaken": self.__observations_taken,
            "started": self.__started, "closed": self.__closed, "completed": self.__completed and not self.__failed,
            "failed": self.__failed, "failureCode": self.__failure_code,
            "completionEvidenceRef": self.__completion_ref, "actions": self.__actions,
            "appClockShared": self.app_agent.time_manager is self.__env.time_manager,
            "agentClockShared": self.base_agent.time_manager is self.__env.time_manager,
            "notificationSystemAttached": self.base_agent.notification_system is not None,
            "wrapperRegisteredInEnvironment": any(app is self.app_agent for app in self.__env.apps.values())})

    def close(self) -> None:
        self.__closed = True
        self.base_agent.stop()


def build_scoped_app_agent(*, app: App, owner: NativeAppBinding, env: Environment,
                          scope: dict, llm_engine: LLMEngine,
                          dispatch: Callable[[dict], dict], model_binding: dict | None = None,
                          model_gate: Callable | None = None, model_attempt: Callable | None = None,
                          model_finish: Callable | None = None, max_logical_requests: int | None = None,
                          log_callback: Callable | None = None,
                          generation_time_owner_factory: Callable[[], ScopedAREGenerationTimeOwner] | None = None,
                          generation_ledger_factory: Callable[..., ScopedGenerationTimeLedger] | None = None) -> ScopedAppAgentRunner:
    return ScopedAppAgentRunner(app=app, owner=owner, env=env, scope=scope,
        llm_engine=llm_engine, dispatch=dispatch, model_binding=model_binding, model_gate=model_gate,
        model_attempt=model_attempt, model_finish=model_finish, max_logical_requests=max_logical_requests,
        log_callback=log_callback, generation_time_owner_factory=generation_time_owner_factory,
        generation_ledger_factory=generation_ledger_factory)
