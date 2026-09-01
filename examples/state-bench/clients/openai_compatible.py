from __future__ import annotations

import os
import threading
from typing import Any

from openai import OpenAI

from capybara_first_round.config import load_compatible_credentials
from clients.token_audit import AuditedOpenAI, TokenAuditLedger
from state_bench.client import LLMClient


class OpenAICompatibleClient(LLMClient):
    """LLMClient-compatible Responses API client for the authorized local proxy."""

    def __init__(
        self,
        *,
        base_url: str,
        api_key: str,
        model: str,
        audit_ledger: TokenAuditLedger | None = None,
        audit_role: str = "unspecified",
    ):
        self.provider = "openai_compatible_proxy"
        self.endpoint = base_url.rstrip("/")
        self.deployment = model
        self.deployments = [model]
        self._chat_response_history = {}
        self._response_history_lock = threading.Lock()
        raw_client = OpenAI(
            api_key=api_key,
            base_url=self.endpoint,
            timeout=float(os.environ.get("STATE_BENCH_COMPAT_TIMEOUT_SECONDS", "300")),
            max_retries=0,
        )
        self._client = (
            AuditedOpenAI(raw_client, audit_ledger, role=audit_role, model=model)
            if audit_ledger is not None
            else raw_client
        )

    def complete_with_tools(
        self,
        *,
        instructions: str,
        input: list[Any],
        tools: list[dict[str, Any]],
        previous_response_id: str | None = None,
        max_tokens: int = 4096,
        temperature: float | None = 0,
        reasoning_effort: str | None = None,
    ) -> Any:
        """Continue tool calls statelessly for proxies without HTTP response chaining."""
        expanded_input = list(input)
        if previous_response_id is not None:
            with self._response_history_lock:
                history = self._chat_response_history.get(previous_response_id)
            if history is None:
                raise ValueError(f"Unknown previous response id: {previous_response_id}")
            expanded_input = [*history, *expanded_input]

        response = super().complete_with_tools(
            instructions=instructions,
            input=expanded_input,
            tools=tools,
            previous_response_id=None,
            max_tokens=max_tokens,
            temperature=temperature,
            reasoning_effort=reasoning_effort,
        )
        with self._response_history_lock:
            self._chat_response_history[response.id] = [*expanded_input, *response.output]
        return response

    @classmethod
    def from_env(
        cls,
        *,
        audit_ledger: TokenAuditLedger | None = None,
        audit_role: str = "agent",
    ) -> "OpenAICompatibleClient":
        base_url, api_key, configured_model = load_compatible_credentials()
        model = os.environ.get("STATE_BENCH_COMPAT_AGENT_MODEL", configured_model).strip()
        return cls(
            base_url=base_url,
            api_key=api_key,
            model=model,
            audit_ledger=audit_ledger,
            audit_role=audit_role,
        )

    @classmethod
    def for_model(
        cls,
        model: str,
        *,
        audit_ledger: TokenAuditLedger | None = None,
        audit_role: str = "unspecified",
    ) -> "OpenAICompatibleClient":
        base_url, api_key, _ = load_compatible_credentials()
        return cls(
            base_url=base_url,
            api_key=api_key,
            model=model,
            audit_ledger=audit_ledger,
            audit_role=audit_role,
        )

    @property
    def provider_name(self) -> str:
        return self.provider

    @property
    def model_name(self) -> str:
        return self.deployment
