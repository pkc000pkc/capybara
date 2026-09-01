from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from clients.token_audit import (
    AuditedResponses,
    TokenAuditLedger,
    extract_response_usage,
    token_audit_context,
)


def _response(response_id: str, *, input_tokens: int = 100, output_tokens: int = 20):
    usage = SimpleNamespace(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        input_tokens_details=SimpleNamespace(cached_tokens=10),
        output_tokens_details=SimpleNamespace(reasoning_tokens=5),
    )
    return SimpleNamespace(
        id=response_id,
        model="provider-model",
        status="completed",
        usage=usage,
        _request_id=f"request-{response_id}",
    )


class _Responses:
    def __init__(self, role: str, *, fail: bool = False):
        self.role = role
        self.fail = fail

    def create(self, **kwargs):
        if self.fail:
            raise RuntimeError(f"{self.role} unavailable")
        return _response(f"{self.role}-{kwargs['request_number']}")


def test_extract_response_usage_preserves_provider_totals() -> None:
    assert extract_response_usage(_response("one")) == {
        "input_tokens": 100,
        "cached_input_tokens": 10,
        "output_tokens": 20,
        "reasoning_output_tokens": 5,
        "total_tokens": 120,
    }
    assert extract_response_usage(SimpleNamespace(usage=None)) is None


def test_ledger_separates_roles_and_records_failed_requests(tmp_path) -> None:
    ledger = TokenAuditLedger(tmp_path / "tokens.jsonl")
    agent = AuditedResponses(_Responses("agent"), ledger, role="agent", model="agent-model")
    judge = AuditedResponses(_Responses("judge"), ledger, role="ux_judge", model="judge-model")
    failing = AuditedResponses(_Responses("sim", fail=True), ledger, role="simulator", model="judge-model")

    with token_audit_context(run_tag="smoke", domain="travel", task_id="task-1", run_idx=1, task_attempt=1):
        agent.create(model="agent-model", request_number=1, tools=[{"type": "function"}])
        judge.create(
            model="judge-model",
            request_number=1,
            text={"format": {"type": "json_object"}},
        )
        with pytest.raises(RuntimeError, match="sim unavailable"):
            failing.create(model="judge-model", request_number=1)

    summary = ledger.summarize(run_tag="smoke", domain="travel", task_id="task-1")
    assert summary["requests"] == 3
    assert summary["successful_requests"] == 2
    assert summary["failed_requests"] == 1
    assert summary["requests_without_usage"] == 1
    assert summary["total_tokens"] == 240
    assert summary["by_role"]["agent"]["total_tokens"] == 120
    assert summary["by_role"]["ux_judge"]["total_tokens"] == 120
    assert summary["by_role"]["simulator"]["failed_requests"] == 1

    events = ledger.events()
    assert [event["request_kind"] for event in events] == ["tools", "json", "chat"]
    assert all(event["task_attempt"] == 1 for event in events)
    assert events[-1]["usage"] is None
    assert events[-1]["error_type"] == "RuntimeError"


def test_concurrent_contexts_are_isolated_and_every_event_is_valid_json(tmp_path) -> None:
    ledger = TokenAuditLedger(tmp_path / "tokens.jsonl")
    responses = AuditedResponses(_Responses("agent"), ledger, role="agent", model="agent-model")

    def make_request(task_number: int) -> None:
        task_id = f"task-{task_number}"
        with token_audit_context(run_tag="parallel", domain="travel", task_id=task_id, run_idx=1):
            responses.create(model="agent-model", request_number=task_number, tools=[{"type": "function"}])

    with ThreadPoolExecutor(max_workers=8) as executor:
        list(executor.map(make_request, range(24)))

    events = ledger.events()
    assert len(events) == 24
    assert len({event["sequence"] for event in events}) == 24
    assert {event["task_id"] for event in events} == {f"task-{number}" for number in range(24)}
    assert ledger.summarize(run_tag="parallel")["total_tokens"] == 24 * 120


def test_ledger_continues_sequence_and_ignores_only_a_truncated_last_line(tmp_path) -> None:
    path = tmp_path / "tokens.jsonl"
    first = TokenAuditLedger(path)
    first.record(
        role="agent",
        requested_model="agent-model",
        request_kind="tools",
        elapsed_seconds=0.1,
        response=_response("one"),
    )
    second = TokenAuditLedger(path)
    event = second.record(
        role="agent",
        requested_model="agent-model",
        request_kind="tools",
        elapsed_seconds=0.1,
        response=_response("two"),
    )
    assert event["sequence"] == 2

    with path.open("a", encoding="utf-8") as handle:
        handle.write('{"incomplete":')
    assert len(second.events()) == 2


def test_incomplete_provider_response_is_failed_but_keeps_reported_usage(tmp_path) -> None:
    ledger = TokenAuditLedger(tmp_path / "tokens.jsonl")
    response = _response("incomplete")
    response.status = "incomplete"
    response.incomplete_details = SimpleNamespace(reason="content_filter")

    event = ledger.record(
        role="ux_judge",
        requested_model="judge-model",
        request_kind="json",
        elapsed_seconds=0.1,
        response=response,
    )

    assert event["status"] == "error"
    assert event["error_type"] == "IncompleteResponse"
    assert event["usage"]["total_tokens"] == 120
    summary = ledger.summarize()
    assert summary["failed_requests"] == 1
    assert summary["requests_without_usage"] == 0
    assert summary["total_tokens"] == 120
