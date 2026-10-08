"""Small native-tool bridge used by the GAIA2 official one-scenario smoke.

The official ARE 1.2.0 default agent expects a textual ReAct protocol.  The
configured gpt-6-luna endpoint exposes reliable OpenAI function calls instead,
so this bridge keeps the official Environment, AppTool objects and verifier,
while adapting the model turn to native tool calls.
"""

from __future__ import annotations

import json
import logging
import os
import time
import hashlib
from datetime import datetime, timezone
from typing import Any

from litellm import completion
from gaia2_model_retry import install_model_retries

from are.simulation.notification_system import MessageType
from are.simulation.scenarios.scenario import ScenarioValidationResult

logger = logging.getLogger(__name__)


def _stable_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode("utf-8")).hexdigest()


def _emit_runtime_event(event_type: str, **payload: Any) -> None:
    """Emit a compact, evaluator-blind lifecycle event for Capybara hooks.

    The official ARE process remains the source of truth for execution and
    judging.  This sidecar is intentionally limited to operational metadata;
    it never serializes Oracle events or reference answers.
    """
    path = os.environ.get("GAIA2_RUNTIME_EVENT_FILE")
    if not path:
        return
    record = {
        "type": event_type,
        "attemptIndex": int(os.environ.get("GAIA2_E2E_ATTEMPT_INDEX", "0") or 0),
        "executionId": os.environ.get("GAIA2_EXECUTION_ID"),
        "sessionId": os.environ.get("GAIA2_SESSION_ID"),
        "time": time.time(),
        **payload,
    }
    try:
        with open(path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps(record, default=str, sort_keys=True) + "\n")
    except OSError:
        logger.debug("Unable to emit Capybara runtime event", exc_info=True)


def _native_json_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Convert ARE's Python type labels into strict JSON Schema labels.

    ARE's ``AppTool.to_open_ai`` intentionally emits human-readable labels
    such as ``str | None`` and ``list[str]``.  OpenAI-compatible endpoints
    require JSON Schema primitives instead, so this adapter keeps the useful
    descriptions while normalising the type surface.
    """
    raw_type = str(schema.get("type", "string"))
    lowered = raw_type.lower()
    if "list[" in lowered or lowered.startswith("list"):
        json_type = "array"
        items: dict[str, Any] = {"type": "string"}
        if "int" in lowered and "str" not in lowered:
            items = {"type": "integer"}
        elif "float" in lowered and "str" not in lowered:
            items = {"type": "number"}
        result: dict[str, Any] = {"type": json_type, "items": items}
    elif "dict" in lowered or "any" in lowered:
        result = {"type": "object", "additionalProperties": True}
    elif "bool" in lowered:
        result = {"type": "boolean"}
    elif "float" in lowered:
        result = {"type": "number"}
    elif "int" in lowered or "integer" in lowered:
        result = {"type": "integer"}
    else:
        result = {"type": "string"}
    if schema.get("description"):
        result["description"] = schema["description"]
    return result


def _native_openai_tool(tool) -> dict[str, Any]:
    source = tool.to_open_ai()
    function = source["function"]
    parameters = function.get("parameters", {})
    properties = parameters.get("properties", {})
    normalized_properties = {
        name: _native_json_schema(value)
        for name, value in properties.items()
    }
    required = []
    for name in parameters.get("required", []):
        original = properties.get(name, {})
        if "none" not in str(original.get("type", "")).lower():
            required.append(name)
    function["parameters"] = {
        "type": "object",
        "properties": normalized_properties,
        "required": required,
        "additionalProperties": False,
    }
    return source


def _read_user_task(env, timeout_seconds: float = 20.0) -> str:
    """Read the first scheduled user message without consuming notifications."""
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        now = datetime.fromtimestamp(env.time_manager.time(), tz=timezone.utc)
        messages = env.notification_system.message_queue.get_by_timestamp(now)
        user_messages = [
            message
            for message in messages
            if message.message_type == MessageType.USER_MESSAGE
        ]
        for message in messages:
            if message.message_type != MessageType.USER_MESSAGE:
                env.notification_system.message_queue.put(message)
        if user_messages:
            return "\n".join(message.message for message in user_messages)
        time.sleep(0.1)
    raise TimeoutError("GAIA2 bridge did not receive the scheduled user message")


def _call_model(messages: list[dict[str, Any]], tools: list[dict[str, Any]], model: str, provider: str | None, endpoint: str | None):
    custom_provider = None if provider in (None, "local") else provider
    return completion(
        model=model,
        custom_llm_provider=custom_provider,
        messages=messages,
        tools=tools,
        tool_choice="auto",
        api_base=endpoint,
        api_key=os.environ.get("OPENAI_API_KEY"),
        timeout=float(os.environ.get("GAIA2_E2E_LLM_TIMEOUT_SECONDS", "60")),
    )


def _native_run_with_agent(
    self,
    scenario_id: str,
    scenario,
    env,
    agent: str,
    model: str,
    provider: str | None = None,
    endpoint: str | None = None,
    max_turns: int | None = None,
    simulated_generation_time_mode: str = "measured",
    use_custom_logger: bool = True,
) -> ScenarioValidationResult:
    del self, agent, max_turns, simulated_generation_time_mode, use_custom_logger

    _emit_runtime_event("official_run_started", scenarioId=scenario_id, toolCount=len(scenario.get_tools()))
    app_tools = scenario.get_tools()
    allowlist = {
        name.strip()
        for name in os.environ.get("GAIA2_E2E_TOOL_ALLOWLIST", "").split(",")
        if name.strip()
    }
    if allowlist:
        app_tools = [tool for tool in app_tools if tool._public_name in allowlist]
    tool_map = {tool._public_name: tool for tool in app_tools}
    openai_tools = [_native_openai_tool(tool) for tool in app_tools]
    task = _read_user_task(env)
    _emit_runtime_event("user_task_observed", taskHash=_stable_hash(task), taskLength=len(task))
    system = (
        "You are an agent inside the official Meta Agents Research Environments. "
        "Complete the user's task by calling the provided native tools. "
        "Use one tool call at a time. Do not return a plan instead of executing. "
        "For this smoke test, perform the requested operation immediately; "
        "the first response must be a tool call when a tool can complete the task. "
        "When the task is complete, call AgentUserInterface__send_message_to_user "
        "with a concise final response."
    )
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        {"role": "user", "content": task},
    ]
    max_actions = int(os.environ.get("GAIA2_E2E_MAX_ACTIONS", "24"))
    sent_user_message = False

    for turn in range(max_actions):
        _emit_runtime_event("model_request", turn=turn, toolCount=len(openai_tools))
        response = _call_model(messages, openai_tools, model, provider, endpoint)
        choice = response.choices[0]
        message = choice.message
        tool_calls = list(getattr(message, "tool_calls", None) or [])
        content = getattr(message, "content", None)
        _emit_runtime_event(
            "model_response",
            turn=turn,
            toolCallCount=len(tool_calls),
            hasContent=bool(content),
        )
        if not tool_calls:
            if isinstance(content, str) and content.strip() and not sent_user_message:
                aui = next(
                    (tool for tool in app_tools if tool._public_name == "AgentUserInterface__send_message_to_user"),
                    None,
                )
                if aui is not None:
                    aui(content=content.strip())
                    sent_user_message = True
            break

        assistant_message: dict[str, Any] = {
            "role": "assistant",
            "content": content or "",
            "tool_calls": [],
        }
        for call in tool_calls:
            function = call.function
            assistant_message["tool_calls"].append(
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": function.name, "arguments": function.arguments},
                }
            )
        messages.append(assistant_message)

        for call in tool_calls:
            function = call.function
            try:
                decoded_arguments = json.loads(function.arguments or "{}")
            except Exception:
                decoded_arguments = {}
            _emit_runtime_event(
                "tool_call_started",
                turn=turn,
                callId=call.id,
                function=function.name,
                argumentKeys=sorted(decoded_arguments.keys()) if isinstance(decoded_arguments, dict) else [],
                argumentHash=_stable_hash(decoded_arguments),
            )
            tool = tool_map.get(function.name)
            if tool is None:
                result = f"Unknown tool: {function.name}"
            else:
                try:
                    arguments = json.loads(function.arguments or "{}")
                    result = tool(**arguments)
                    if function.name == "AgentUserInterface__send_message_to_user":
                        sent_user_message = True
                except Exception as error:  # send a structured observation back to the model
                    result = {"error": str(error)[:500]}
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.id,
                    "name": function.name,
                    "content": json.dumps(result, default=str),
                }
            )
            _emit_runtime_event(
                "tool_call_completed",
                turn=turn,
                callId=call.id,
                function=function.name,
                ok=not (isinstance(result, dict) and "error" in result),
                resultHash=_stable_hash(result),
            )

    time.sleep(0.5)
    validation = scenario.validate(env)
    _emit_runtime_event(
        "official_validation_completed",
        validationType=type(validation).__name__,
        validationSuccess=getattr(validation, "success", None),
        hasException=getattr(validation, "exception", None) is not None,
    )
    return validation


def install() -> None:
    """Install the bridge before the official benchmark CLI constructs runners."""
    global completion
    from are.simulation import scenario_runner

    completion = install_model_retries(_emit_runtime_event, actor_completion=completion)
    scenario_runner.ScenarioRunner._run_with_agent = _native_run_with_agent
    logger.info("Installed Capybara native-tool bridge for official ARE runner")
