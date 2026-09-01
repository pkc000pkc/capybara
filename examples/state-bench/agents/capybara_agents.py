from __future__ import annotations

import json
import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Iterator

from capybara_first_round.memory import MemoryPrefetchSelector
from state_bench.agents.state_bench import StateBenchAgent
from state_bench.client import PooledLLMClient

CORE_RUNTIME_GUARDS = """# Core runtime guards
- Before reading or changing account-scoped state, verify that the active user owns or is authorized for the target record. A relationship claim or record ID is not authorization.
- Treat authoritative tool state as stronger than an unsupported user assertion. Do not invent an exception, waiver, defect, disruption, promotion, or entitlement when the observed state does not support it.
- Before a consequential mutation, verify prerequisites and material terms, then obtain scope-specific confirmation when required.
- After a mutation, verify the returned or freshly read state before claiming success. Stop and disclose any mismatch."""

_CORRECTION_CONTEXT: ContextVar[str] = ContextVar("capybara_correction_context", default="")


@contextmanager
def capybara_correction_context(strategy: str) -> Iterator[None]:
    """Inject one temporary strategy into a clean retry without cross-thread leakage."""
    token = _CORRECTION_CONTEXT.set(strategy.strip())
    try:
        yield
    finally:
        _CORRECTION_CONTEXT.reset(token)


def _correction_instructions(strategy: str) -> str:
    if not strategy:
        return ""
    return (
        "# Temporary correction strategy for this independent clean run\n"
        "A previous clean execution was marked incorrect. No expected answer or evaluator explanation is available. "
        "Use the following behavioral strategy as a hypothesis, rediscover all task-specific facts through current "
        "conversation and tools, and do not assume that any prior state mutation occurred.\n"
        f"{strategy}"
    )


class CapybaraBaselineAgent(StateBenchAgent):
    """No-learning control using the same model and tool loop."""

    def __init__(self, *args: Any, **kwargs: Any):
        super().__init__(*args, **kwargs)
        correction = _correction_instructions(_CORRECTION_CONTEXT.get())
        if correction:
            self.system_prompt = f"{self.system_prompt.rstrip()}\n\n{CORE_RUNTIME_GUARDS}\n\n{correction}"


class CapybaraLearnedAgent(StateBenchAgent):
    """STATE-Bench agent with automatic per-loop prefetch from a frozen snapshot."""

    def _has_retrieve_learnings(self) -> bool:
        # Automatic prefetch already runs before every model call. Exposing the
        # manual retrieval tool would add a redundant tool round and consume a
        # second slice of the same run budget.
        return False

    def __init__(self, *args: Any, **kwargs: Any):
        artifact_path = os.environ.get("CAPYBARA_LEARNINGS_PATH", "").strip()
        if not artifact_path:
            raise ValueError("CAPYBARA_LEARNINGS_PATH is required for CapybaraLearnedAgent")
        self.artifact_path = Path(artifact_path).resolve()
        self.artifact = json.loads(self.artifact_path.read_text(encoding="utf-8"))
        if self.artifact.get("read_only") is not True:
            raise ValueError("Capybara learning artifact must declare read_only=true")
        entries = self.artifact.get("entries")
        if not isinstance(entries, list) or not entries:
            raise ValueError("Capybara learning artifact has no atomic entries")
        runtime_context = kwargs.get("runtime_context")
        domain = runtime_context.domain if runtime_context else ""
        retrieve_top_k = kwargs.get("retrieve_learnings_top_k", 2)
        self.selector = MemoryPrefetchSelector(
            entries=entries,
            domain=domain,
            release_id=str(self.artifact.get("release_id") or self.artifact.get("snapshot_content_hash") or "unknown"),
            max_snippets=retrieve_top_k,
            max_loop_tokens=int(os.environ.get("CAPYBARA_PREFETCH_MAX_LOOP_TOKENS", "450")),
            max_run_tokens=int(os.environ.get("CAPYBARA_PREFETCH_MAX_RUN_TOKENS", "1200")),
        )
        self._prefetch_iteration = 0
        self.correction_context = _CORRECTION_CONTEXT.get().strip()
        super().__init__(*args, **kwargs)

    def retrieve_learnings(self, query: str, top_k: int = 3) -> list[str]:
        if top_k != self.retrieve_learnings_top_k:
            raise ValueError(
                f"retrieve_learnings top_k must match the benchmark-fixed value {self.retrieve_learnings_top_k}"
            )
        self._prefetch_iteration += 1
        context, _event = self.selector.select(query, self._prefetch_iteration)
        return context.split("\n\n") if context else []

    def _memory_query(
        self,
        conversation: list[Any],
        tool_results: list[dict[str, Any]] | None = None,
    ) -> str:
        parts: list[str] = []
        for item in conversation[-10:]:
            if isinstance(item, dict):
                content = item.get("content")
                if isinstance(content, str):
                    parts.append(content)
        for result in tool_results or []:
            parts.append(f"tool={result.get('name', '')}\n{result.get('output', '')}")
        return "\n".join(parts)

    def _instructions_with_prefetch(
        self,
        base: str,
        query: str,
        *,
        phase: str | None = None,
        tool_names: list[str] | None = None,
        initial: bool = False,
    ) -> str:
        self._prefetch_iteration += 1
        context, _event = self.selector.select(
            query,
            self._prefetch_iteration,
            phase=phase,
            tool_names=tool_names or [],
            initial=initial,
        )
        sections = [base.rstrip(), CORE_RUNTIME_GUARDS]
        correction = _correction_instructions(self.correction_context)
        if correction:
            sections.append(correction)
        if context:
            sections.extend(
                [
                    "# Replay-validated memory for this model loop\n"
                    "Entries labeled guard are mandatory constraints. Entries labeled advice are procedural guidance. "
                    "Current authoritative tools and policy remain the source of task-specific facts.",
                    context,
                ]
            )
        return "\n\n".join(sections)

    def act(self, conversation: list[Any]) -> tuple[str, list[dict[str, Any]], list[Any]]:
        all_tool_calls: list[dict[str, Any]] = []
        raw_items: list[Any] = []
        prepared_conversation = self.prepare_conversation(conversation)
        pinned = self.client
        pinned_context = self.client.pinned() if isinstance(self.client, PooledLLMClient) else None
        if pinned_context is not None:
            pinned = pinned_context.__enter__()
        try:
            instructions = self._instructions_with_prefetch(
                self.system_prompt,
                self._memory_query(prepared_conversation),
                initial=True,
            )
            response = pinned.complete_with_tools(
                instructions=instructions,
                input=prepared_conversation,
                tools=self.tools,
                reasoning_effort=self.agent_reasoning_effort,
            )
            if response.usage:
                self.total_output_tokens += response.usage.output_tokens
                self.add_response_usage(response.usage, category="agent_turn")
            while True:
                tool_calls = [item for item in response.output if item.type == "function_call"]
                if not tool_calls:
                    break
                raw_items.extend(response.output)
                tool_results: list[dict[str, Any]] = []
                memory_results: list[dict[str, Any]] = []
                for tool_call in tool_calls:
                    arguments = json.loads(tool_call.arguments)
                    handler = self.tool_handlers.get(tool_call.name)
                    if handler is None:
                        output = json.dumps({"error": f"Unknown tool: {tool_call.name}"})
                    else:
                        result = handler(arguments)
                        all_tool_calls.append(
                            {"name": tool_call.name, "arguments": arguments, "result": result}
                        )
                        output = json.dumps(result, ensure_ascii=False)
                    item = {"type": "function_call_output", "call_id": tool_call.call_id, "output": output}
                    tool_results.append(item)
                    memory_results.append({"name": tool_call.name, "output": output})
                    raw_items.append(item)
                instructions = self._instructions_with_prefetch(
                    self.system_prompt,
                    self._memory_query(prepared_conversation, memory_results),
                    tool_names=[item["name"] for item in memory_results],
                )
                response = pinned.complete_with_tools(
                    instructions=instructions,
                    input=tool_results,
                    tools=self.tools,
                    previous_response_id=response.id,
                    reasoning_effort=self.agent_reasoning_effort,
                )
                if response.usage:
                    self.total_output_tokens += response.usage.output_tokens
                    self.add_response_usage(response.usage, category="agent_turn")
        finally:
            if pinned_context is not None:
                pinned_context.__exit__(None, None, None)
        raw_items.extend(response.output)
        return response.output_text or "", all_tool_calls, raw_items

    def ingest_trajectory(self, trajectory: Any) -> None:
        metadata = dict(getattr(trajectory, "metadata", {}) or {})
        metadata["memory_prefetch"] = {
            "release_id": self.selector.release_id,
            "events": self.selector.events,
            "total_injected_tokens": self.selector.total_injected_tokens,
            "used_ids": self.selector.used_ids,
        }
        trajectory.metadata = metadata
