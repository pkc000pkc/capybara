"""Credential-owning correction request broker; never executes ARE tools.

Input is a bounded methods-only prompt produced by a frozen training Hook.
Operational retries reuse the Actor/Judge policy, but have a distinct role.
Neither raw HTTP responses nor SDK exceptions are written to evidence.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import litellm
from gaia2_model_retry import ModelRequestFailure, wrap_completion


def main() -> int:
    if len(sys.argv) != 3:
        raise ValueError("broker input and output required")
    input_path, output_path = map(Path, sys.argv[1:])
    if output_path.exists() or input_path.stat().st_size > 32768:
        raise ValueError("invalid broker files")
    request = json.loads(input_path.read_text(encoding="utf-8"))
    if (not isinstance(request, dict) or set(request) != {"input", "max_output_tokens"}
            or not isinstance(request["input"], str) or not request["input"].strip()
            or isinstance(request["max_output_tokens"], bool)
            or not isinstance(request["max_output_tokens"], int)
            or not 1 <= request["max_output_tokens"] <= 2000):
        raise ValueError("invalid broker request")
    events_path = os.environ["GAIA2_TRAINING_MODEL_EVENTS"]

    def emit(kind: str, **metadata) -> None:
        with open(events_path, "a", encoding="utf-8") as stream:
            stream.write(json.dumps({"type": kind, **metadata}, allow_nan=False) + "\n")

    # The inherited environment cannot activate silent parameter dropping or
    # SDK retries; all retry attempts are emitted by our observable wrapper.
    litellm.num_retries = 0
    litellm.drop_params = False
    call = wrap_completion(litellm.completion, "correction", emit)
    response = call(model=os.environ["GAIA2_TRAINING_MODEL"],
                    custom_llm_provider=os.environ["GAIA2_TRAINING_PROVIDER"],
                    api_base=os.environ["GAIA2_TRAINING_ENDPOINT"],
                    api_key=os.environ["OPENAI_API_KEY"],
                    messages=[{"role": "user", "content": request["input"]}],
                    max_tokens=request["max_output_tokens"],
                    response_format={"type": "json_object"})
    message = response.choices[0].message
    content = message.content
    if (not isinstance(content, str) or not content.strip()
            or len(content.encode("utf-8")) > 32768
            or getattr(message, "tool_calls", None)):
        raise ValueError("invalid correction model response")
    usage = {}
    for source, target in (("prompt_tokens", "input_tokens"),
                           ("completion_tokens", "output_tokens"),
                           ("total_tokens", "total_tokens")):
        value = getattr(getattr(response, "usage", None), source, None)
        if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 9007199254740991:
            usage[target] = value
    with output_path.open("x", encoding="utf-8") as stream:
        json.dump({"output_text": content, "usage": usage}, stream, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"status": "completed", "modelRole": "correction"}))
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except ModelRequestFailure as error:
        print(json.dumps({"status": "failed", "category": error.category,
                          "retryable": error.retryable}), file=sys.stderr)
        code = 2
    except Exception:
        print(json.dumps({"status": "failed", "category": "invalid_training_broker_request_or_response"}), file=sys.stderr)
        code = 2
    sys.exit(code)
