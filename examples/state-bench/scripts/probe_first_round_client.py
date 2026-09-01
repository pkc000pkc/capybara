from __future__ import annotations

import json

from clients.openai_compatible import OpenAICompatibleClient


def main() -> None:
    agent = OpenAICompatibleClient.from_env()
    first = agent.complete_with_tools(
        instructions="Call probe once and wait for its result.",
        input=[{"role": "user", "content": "Probe Responses tool chaining."}],
        tools=[
            {
                "type": "function",
                "name": "probe",
                "description": "Compatibility probe.",
                "parameters": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                    "additionalProperties": False,
                },
                "strict": True,
            }
        ],
        max_tokens=256,
    )
    calls = [item for item in first.output if item.type == "function_call"]
    if len(calls) != 1:
        raise RuntimeError(f"Expected one function call, got {len(calls)}")
    follow_up = agent.complete_with_tools(
        instructions="Call probe once and wait for its result.",
        input=[
            {
                "type": "function_call_output",
                "call_id": calls[0].call_id,
                "output": json.dumps({"ok": True}),
            }
        ],
        tools=[
            {
                "type": "function",
                "name": "probe",
                "description": "Compatibility probe.",
                "parameters": {
                    "type": "object",
                    "properties": {"value": {"type": "string"}},
                    "required": ["value"],
                    "additionalProperties": False,
                },
                "strict": True,
            }
        ],
        previous_response_id=first.id,
        max_tokens=256,
    )
    if not follow_up.output_text:
        raise RuntimeError("Responses tool follow-up returned no text")

    judge = OpenAICompatibleClient.for_model("gpt-5.4")
    judged = judge.complete_json(
        prompt='Return {"passed": true, "reason": "ok"}.',
        system_prompt="Return valid JSON only.",
        max_tokens=256,
        reasoning_effort="high",
    )
    if judged.get("passed") is not True:
        raise RuntimeError(f"JSON reasoning probe failed: {judged}")
    print(
        json.dumps(
            {
                "agent_model": agent.model_name,
                "tool_call": calls[0].name,
                "tool_follow_up": bool(follow_up.output_text),
                "judge_model": judge.model_name,
                "judge_json": True,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
