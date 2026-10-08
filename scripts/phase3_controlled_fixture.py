"""Synthetic, model-free actor fixture through the real ARE bridge and host.

Only the Actor is scripted. The ARE AppTools, notification consumption, time,
authenticated HTTP client and actual TypeScript plugin decisions are real.
This is integration evidence, not a GAIA2 benchmark run or score.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
from types import SimpleNamespace
from typing import Any


_original_connect = socket.socket.connect
_external_attempts: list[str] = []


def _loopback_only(sock, address):
    if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
        _external_attempts.append(type(address).__name__)
        raise RuntimeError("Controlled fixture forbids external network")
    return _original_connect(sock, address)


socket.socket.connect = _loopback_only

import capybara_official_bridge as bridge  # noqa: E402
from gaia2_model_retry import wrap_completion  # noqa: E402
from gaia2_runtime_hooks import HookProtocolError  # noqa: E402
from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender  # noqa: E402
from are.simulation.apps.app import App  # noqa: E402
from are.simulation.apps.system import SystemApp  # noqa: E402
from are.simulation.environment import Environment, EnvironmentConfig  # noqa: E402
from are.simulation.scenarios.scenario import Scenario  # noqa: E402
from are.simulation.tool_utils import OperationType, app_tool  # noqa: E402
from are.simulation.types import EnvironmentState, Event, EventType, event_registered  # noqa: E402


def _hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def _save(path: Path, value: Any) -> dict[str, str]:
    with path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n")
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


class ControlledLedger(App):
    def __init__(self):
        super().__init__()
        self.values: list[str] = []
        self.calls = {"write": 0, "read": 0, "failed_read": 0}

    @app_tool()
    @event_registered(operation_type=OperationType.WRITE)
    def write(self, value: str) -> dict:
        """Append a value to the authoritative controlled ledger.
        :param value: the value to append
        :returns: the current authoritative ledger
        """
        self.calls["write"] += 1
        self.values.append(value)
        if value == "uncertain":
            raise RuntimeError("Controlled mutation occurred before its response failed")
        return {"values": list(self.values)}

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def read(self) -> dict:
        """Read the authoritative current controlled ledger.
        :returns: the current authoritative ledger
        """
        self.calls["read"] += 1
        return {"values": list(self.values)}

    @app_tool()
    @event_registered(operation_type=OperationType.READ)
    def failed_read(self) -> dict:
        """A controlled retrieval that fails without returning evidence.
        :returns: no usable evidence because the retrieval fails
        """
        self.calls["failed_read"] += 1
        raise RuntimeError("Controlled read did not return authoritative evidence")


class ControlledScenario(Scenario):
    def validate(self, env):
        self.validation_calls += 1
        # Keep the official state-only validation implementation. This custom
        # scenario has no benchmark reference answers or LLM judge.
        return super().validate(env)


def _response(name: str, arguments: dict, call_id: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
        content=None, tool_calls=[SimpleNamespace(id=call_id,
            function=SimpleNamespace(name=name, arguments=json.dumps(arguments)))],
    ))])


def run_fixture(case: str, report_path: Path) -> dict:
    env = Environment(config=EnvironmentConfig(start_time=1000, duration=60, verbose=False))
    aui, system, ledger = AgentUserInterface(), SystemApp(), ControlledLedger()
    env.register_apps([aui, system, ledger])
    env.state = EnvironmentState.RUNNING
    scenario = ControlledScenario(scenario_id=f"phase3_controlled_{case}", apps=[aui, system, ledger],
                                  nb_turns=1, start_time=1000, duration=60,
                                  additional_system_prompt="Controlled public task instructions.")
    scenario.validation_calls = 0
    oracle_marker = "HIDDEN_ORACLE_SENTINEL_8DD72D"
    future_marker = "FUTURE_NOT_YET_VISIBLE_70FA12"
    scenario.hints = [oracle_marker]
    future = Event.from_function(aui.send_message_to_agent, event_type=EventType.USER,
                                 content=future_marker).at_absolute_time(2000)
    scenario.events = [future]
    env.event_queue.put(future)
    env.world_logs = [oracle_marker]
    aui.send_message_to_agent("Controlled initial user request.")
    if case in ("dynamic", "wait"):
        update = Event.from_function(aui.send_message_to_agent, event_type=EventType.USER,
                                     content="Use the UPDATED request, not the obsolete plan.").at_absolute_time(1010)
        env.event_queue.put(update)

    runtime_events = []
    original_emit = bridge._emit_runtime_event

    def emit(kind, **payload):
        runtime_events.append({"type": kind, **payload})
        original_emit(kind, **payload)

    bridge._emit_runtime_event = emit
    actor_calls = []

    def completion(**kwargs):
        assert kwargs["model"] == "controlled-no-model"
        assert kwargs.get("api_key") is None and kwargs.get("api_base") is None
        assert env.state == EnvironmentState.PAUSED
        messages = kwargs["messages"]
        assert messages[1]["role"] == "system"
        prefix = "Live Capybara dynamic context:\n"
        assert messages[1]["content"].startswith(prefix)
        context = messages[1]["content"][len(prefix):]
        context_hash = hashlib.sha256(context.encode("utf-8")).hexdigest()
        injected = next(event for event in reversed(runtime_events) if event["type"] == "dynamic_context_injected")
        assert context_hash == injected["contextHash"] == injected["injectedContextHash"]
        visible = json.dumps(messages, ensure_ascii=False)
        assert oracle_marker not in visible and future_marker not in visible
        actor_calls.append({"iteration": len(actor_calls), "messages": messages,
                            "context": context, "contextHash": context_hash,
                            "hookRevision": injected["hookRevision"], "inputHash": _hash(messages)})
        index = len(actor_calls) - 1
        if case == "dynamic":
            if index == 0:
                assert "UPDATED request" not in visible
                env.time_manager.add_offset(10)
                return _response("ControlledLedger__write", {"value": "obsolete"}, "dynamic-old")
            if index == 1:
                assert "UPDATED request" in visible
                assert actor_calls[0]["contextHash"] != context_hash
                return _response("ControlledLedger__write", {"value": "updated"}, "dynamic-new")
            return _response("AgentUserInterface__send_message_to_user", {"content": "Updated request executed."}, "dynamic-finish")
        if case == "unknown":
            steps = [
                ("ControlledLedger__write", {"value": "uncertain"}, "unknown-first"),
                ("ControlledLedger__write", {"value": "uncertain"}, "unknown-retry"),
                ("ControlledLedger__read", {}, "unknown-readback"),
                ("ControlledLedger__write", {"value": "replacement"}, "unknown-after-read"),
                ("AgentUserInterface__send_message_to_user", {"content": "Read-back observed the earlier effect; confirmation is required, no write was replayed."}, "unknown-finish"),
            ]
            assert index < len(steps)
            return _response(*steps[index])
        if case == "unverified_evidence":
            steps = [
                ("ControlledLedger__failed_read", {}, "unverified-read-failed"),
                ("ControlledLedger__write", {"value": "must-not-execute"}, "unverified-write"),
                ("ControlledLedger__read", {}, "unverified-fresh-read"),
                ("AgentUserInterface__send_message_to_user", {"content": "Fresh evidence obtained; the blocked write did not execute."}, "unverified-finish"),
            ]
            assert index < len(steps)
            return _response(*steps[index])
        if case == "wait":
            if index == 0:
                return _response("SystemApp__wait_for_notification", {"timeout": 30}, "official-wait")
            assert "UPDATED request" in visible
            return _response("AgentUserInterface__send_message_to_user", {"content": "Arrived notification handled."}, "wait-finish")
        if case == "hook_failure":
            assert index == 0, "Actor continued after a failed post-execution ledger hook"
            return _response("ControlledLedger__write", {"value": "once"}, "failed-hook-write")
        raise AssertionError("Unknown controlled case")

    bridge.completion = wrap_completion(completion, "actor", emit)
    failure = None
    validation = None
    try:
        validation = bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env,
                                                  "default", "controlled-no-model")
    except HookProtocolError as error:
        failure = error.code
        if case != "hook_failure" or failure != "after_tool_rejected":
            raise
    if case == "dynamic":
        assert ledger.values == ["updated"] and ledger.calls == {"write": 1, "read": 0, "failed_read": 0}
        assert len(actor_calls) == 3
        assert any(event.get("reason") == "stale_dynamic_context" for event in runtime_events)
    elif case == "unknown":
        assert ledger.values == ["uncertain"] and ledger.calls == {"write": 1, "read": 1, "failed_read": 0}
        assert len(actor_calls) == 5
        assert len([event for event in runtime_events if event["type"] == "tool_call_blocked"]) == 2
    elif case == "unverified_evidence":
        assert ledger.values == [] and ledger.calls == {"write": 0, "read": 1, "failed_read": 1}
        assert len(actor_calls) == 4
    elif case == "wait":
        assert ledger.calls == {"write": 0, "read": 0, "failed_read": 0} and env.time_manager.time() >= 1010
        assert len(actor_calls) == 2
    elif case == "hook_failure":
        assert failure == "after_tool_rejected" and ledger.values == ["once"]
        assert len(actor_calls) == 1 and scenario.validation_calls == 0
    if case != "hook_failure":
        assert validation.success is True and scenario.validation_calls == 1
    assert not _external_attempts
    ended = next(event for event in reversed(runtime_events) if event["type"] == "attempt_execution_ended")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    actors = _save(report_path.parent / "actor-inputs.json", actor_calls)
    completed = _save(report_path.parent / "are-completed-events.json", env.event_log.to_dict())
    report = {
        "schemaVersion": "gaia2-phase3-controlled-fixture-v1", "status": "passed", "case": case,
        "syntheticFixtureOnly": True, "benchmarkExecuted": False, "realModelCalls": 0,
        "fakeActorRequests": len(actor_calls), "externalNetworkAttempts": len(_external_attempts),
        "executionId": os.environ["GAIA2_EXECUTION_ID"], "sessionId": os.environ["GAIA2_SESSION_ID"],
        "scenarioId": scenario.scenario_id, "callbackCounts": ledger.calls, "ledger": ledger.values,
        "userReplyCount": len([message for message in aui.messages if message.sender == Sender.AGENT]),
        "validationBoundary": "ARE Scenario.validate state-only synthetic fixture",
        "validationCalls": scenario.validation_calls, "expectedTechnicalFailure": failure,
        "terminationReason": ended["terminationReason"], "usage": ended["usage"],
        "officialClockAtEnd": env.time_manager.time(), "hiddenAndFutureInputsAbsent": True,
        "artifacts": [actors, completed], "uploaded": False, "officialSubmissionReady": False,
    }
    _save(report_path, report)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=["dynamic", "unknown", "unverified_evidence", "wait", "hook_failure"], required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    result = run_fixture(args.case, args.report.resolve())
    print(json.dumps({"status": result["status"], "case": result["case"], "realModelCalls": 0, "benchmarkExecuted": False}))


if __name__ == "__main__":
    main()
