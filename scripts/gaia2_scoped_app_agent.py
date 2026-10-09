"""Instance-scoped official AppAgent, for a trusted private dispatcher only.

The actual ARE builder, BaseAgent loop/parser/logger and tools are retained.
Only this instance's dispatch and parsed-action exception boundary, and its
TerminationStep, are replaced. The parsed-action body is the original method.
dispatcher is trusted constructor authority, not an Actor-provided callback,
scope, proof or endpoint. It owns the Node child handle and real Host chain.

This module does not call providers, consume an Environment notification queue,
construct native events or re-execute a tool. Production model brokering and
cross-clock synchronization are deliberately outside this controlled slice.
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
from are.simulation.agents.agent_log import ErrorLog, FinalAnswerLog, ObservationLog
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

_SCOPE_KEYS = frozenset(("parentExecutionId", "parentSessionId", "environmentGeneration",
    "appId", "parentCanonicalName", "taskArgumentKey", "toolInventoryHash", "taskHash",
    "parentActionId", "requestId", "childExecutionId", "childSessionId", "task", "deadline", "maxNativeActions"))
_ACK_KEYS = frozenset(("schemaVersion", "scopeHash", "dispatchId", "toolId", "toolKind",
    "status", "childCompleted", "completionEvidenceRef"))
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_MAX_BYTES = 4 * 1024 * 1024


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
                 scope: dict, llm_engine: LLMEngine, dispatch: Callable[[dict], dict]):
        if (not isinstance(app, App) or not isinstance(owner, NativeAppBinding)
                or not isinstance(env, Environment) or not isinstance(llm_engine, LLMEngine)
                or not callable(dispatch) or env.apps.get(app.name) is not app
                or app.time_manager is not env.time_manager):
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
        config.max_iterations = scope["maxNativeActions"]
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
        self.base_agent.total_iterations = scope["maxNativeActions"]
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
        self.__collect_sources(dispatch, type(llm_engine), AppAgentBuilder, AppAgentConfigBuilder,
            BaseAgent, JsonActionExecutor, TerminationStep, LLMEngine, _InjectedEngineBuilder,
            ControlledAppAgentEngine, type(self), AppAgent, are_simulation_react_json_app_agent,
            self.executor._append_final_answer, type(self.executor).extract_action)
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
            _callable_identity(self.__official_execute_parsed),
            _callable_identity(self.__dispatch), _callable_identity(getattr(self.__dispatch, "__call__", None)),
            id(self.__owner), _callable_identity(self.__owner.manifest),
            _callable_identity(self.__owner.take_agent_observation),
            _callable_identity(base.pause_env), _callable_identity(base.resume_env),
            _callable_identity(self.__model.chat_completion), _callable_identity(type(self.__model).__call__),
            tuple((id(step), _callable_identity(step.condition), _callable_identity(step.function))
                for step in base.conditional_pre_steps),
            tuple((id(step), _callable_identity(step.condition), _callable_identity(step.function))
                for step in base.conditional_post_steps))

    def __check(self) -> None:
        if self.__closed:
            _fatal("SCOPED_AGENT_CLOSED")
        try:
            if self.__snapshot_instances() != self.__instance_snapshot:
                _fatal("SCOPED_AGENT_SOURCE_CHANGED")
            if wire.value_hash(self.__owner.manifest()) != self.__manifest_hash:
                _fatal("SCOPED_AGENT_SOURCE_CHANGED")
            for ref in self.__sources.values():
                data = _regular(Path(ref["path"])).read_bytes()
                if len(data) != ref["bytes"] or hashlib.sha256(data).hexdigest() != ref["sha256"]:
                    _fatal("SCOPED_AGENT_SOURCE_CHANGED")
        except ScopedAppAgentFatal:
            raise
        except BaseException:
            _fatal("SCOPED_AGENT_SOURCE_CHANGED")

    def __model_call(self, messages, stop_sequences=(), **kwargs):
        self.__check()
        if self.__failed or self.__completed:
            _fatal("SCOPED_AGENT_TERMINAL")
        safe = _safe_model_messages(messages)
        self.__wrapped_task_hash = hashlib.sha256(self.base_agent.task.encode("utf-8")).hexdigest()
        self.__actor_input_hashes.append(wire.value_hash(safe))
        self.__model_calls += 1
        if self.__model_calls > self.__scope["maxNativeActions"]:
            _fatal("SCOPED_AGENT_BUDGET_EXHAUSTED")
        try:
            result = self.__model(messages, stop_sequences=stop_sequences, **kwargs)
        except BaseException:
            _fatal("SCOPED_AGENT_MODEL_FAILED")
        self.__check()
        return result

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
                          dispatch: Callable[[dict], dict]) -> ScopedAppAgentRunner:
    return ScopedAppAgentRunner(app=app, owner=owner, env=env, scope=scope,
        llm_engine=llm_engine, dispatch=dispatch)
