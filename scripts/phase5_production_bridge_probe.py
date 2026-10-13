"""Offline production parent/child/Node integration; no benchmark or model score."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import sys
import time
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "scripts"))

import capybara_official_bridge as bridge
import gaia2_official_a2a as official_a2a
from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.apps.agent_user_interface import AgentUserInterface
from are.simulation.apps.apartment_listing import Apartment, RentAFlat
from are.simulation.apps.shopping import Shopping
from are.simulation.apps.system import SystemApp
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.notification_system import Message, MessageType
from are.simulation.scenarios.scenario import Scenario
from are.simulation.scenarios.validation_result import ScenarioValidationResult
from are.simulation.tool_utils import AppToolAdapter
from are.simulation.types import EnvironmentState


class ControlledScenario(Scenario):
    def validate(self, env):
        return ScenarioValidationResult(success=True)


def parent_response(name, arguments, ordinal):
    call = SimpleNamespace(id=f"controlled-call-{ordinal}", function=SimpleNamespace(
        name=name, arguments=json.dumps(arguments)))
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
        content=None, tool_calls=[call]))])


def child_response(name, arguments):
    text = 'Thought: controlled\nAction:\n' + json.dumps(
        {"action": name, "action_input": arguments}, separators=(",", ":")) + '<end_action>'
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage={"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})


def run(workspace: Path, mode: str):
    env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
    aui, system = AgentUserInterface(), SystemApp()
    readback_mode = mode == "readback-then-fresh"
    app = (RentAFlat(name="RentAFlat", apartments={"apt-1": Apartment(
        "Controlled", "Local", "00001", 1200.0, 1, 1, "Apartment", 500,
        apartment_id="apt-1")}) if readback_mode else
        Shopping(name="Shopping", discount_codes={"item-1": {"SAVE": 0.1}}))
    env.register_apps([aui, system, app])
    wrapper = AppAgent(SimpleNamespace(), {tool.name: tool for tool in
        map(AppToolAdapter, app.get_tools())}, app.name)
    env.register_apps([wrapper])
    scenario_id = "controlled-production-a2a-" + mode
    scenario = ControlledScenario(scenario_id=scenario_id, apps=[aui, system, wrapper],
        nb_turns=1, start_time=1000.0, duration=None)
    env.time_manager.resume()
    env.start()
    aui.send_message_to_agent("Save apt-1 after checking saved apartments and reply."
        if readback_mode else "Read current Shopping discount codes and reply.")
    parent_calls, sdk_calls = [], []
    blocked_dispatches, completed_dispatches = [], []
    clock_advanced = False
    original_builder = official_a2a.build_scoped_app_agent

    def controlled_builder(**kwargs):
        if not readback_mode:
            return original_builder(**kwargs)
        dispatch = kwargs["dispatch"]

        def timed_dispatch(action):
            nonlocal clock_advanced
            result = dispatch(action)
            if result.get("status") == "blocked":
                assert action["tool"] == "RentAFlat__save_apartment"
                assert result.get("gateDecision") == "read_back"
                assert result.get("schemaVersion") == "capybara-scoped-agent-dispatch-blocked-v1"
                assert "value" not in result and "resultHash" not in result
                assert app.saved_apartments == []
                blocked_dispatches.append(result)
            else:
                completed_dispatches.append(result)
            if (action["tool"] == "RentAFlat__list_saved_apartments"
                    and result.get("status") == "completed" and not clock_advanced):
                # Controlled fixture only: advance the real ARE clock via its
                # public offset API *after* native/Hook completion, outside any
                # model permit or pause lease. Production time is unchanged.
                assert not env.pause_event.is_set()
                env.time_manager.add_offset(61.0)
                clock_advanced = True
            return result

        kwargs["dispatch"] = timed_dispatch
        return original_builder(**kwargs)
    original_connect = socket.socket.connect
    ports = {urlsplit(os.environ["GAIA2_HOOK_URL"]).port,
             int(os.environ["GAIA2_A2A_PIPE_PORT"])}

    def loopback_only(sock, address):
        if not isinstance(address, tuple) or address[0] != "127.0.0.1" or address[1] not in ports:
            raise AssertionError("EXTERNAL_NETWORK_FORBIDDEN")
        return original_connect(sock, address)

    def actor(**kwargs):
        parent_calls.append(kwargs)
        index = len(parent_calls)
        needs_replan = mode in ("user-after-sdk", "user-after-offset")
        if index == 1 or needs_replan and index == 2:
            if index == 2:
                messages = kwargs["messages"]
                update = next(i for i, item in enumerate(messages)
                    if item.get("role") == "user" and "CONTROLLED_LIVE_UPDATE" in str(item.get("content")))
                result = next(i for i, item in enumerate(messages) if item.get("role") == "tool")
                if not result < update:
                    raise AssertionError("PARENT_TOOL_RESPONSE_ORDER_BROKEN")
            return parent_response(app.name + "__expert_agent", {"task":
                "Check saved apartments and save apt-1 exactly once." if readback_mode
                else "Read the current discount codes and return the result."}, index)
        return parent_response("AgentUserInterface__send_message_to_user",
            {"content": "Controlled reply after the child result."}, index)

    def sdk(**kwargs):
        sdk_calls.append(kwargs)
        index = len(sdk_calls)
        if readback_mode:
            if index in (1, 3):
                if index == 3:
                    assert len(blocked_dispatches) == 1 and app.saved_apartments == []
                return child_response("RentAFlat__list_saved_apartments", {})
            if index in (2, 4):
                assert app.saved_apartments == []
                return child_response("RentAFlat__save_apartment", {"apartment_id": "apt-1"})
            if index == 5:
                assert app.saved_apartments == ["apt-1"]
                return child_response("final_answer", {"answer": "Apartment saved once."})
            raise AssertionError("UNEXPECTED_READBACK_MODEL_REQUEST")
        if index == 1 and mode == "stop-after-sdk":
            env.stop()
        elif index == 1 and mode in ("user-after-sdk", "user-after-offset"):
            due = env.time_manager.time() + (0.015 if mode == "user-after-offset" else 0)
            env.notification_system.message_queue.put(Message(MessageType.USER_MESSAGE,
                "CONTROLLED_LIVE_UPDATE re-read before acting", datetime.fromtimestamp(due, tz=timezone.utc)))
            if mode == "user-after-offset":
                time.sleep(0.04)
        # The obsolete first response must not execute in either update mode.
        effective_index = index - (1 if mode.startswith("user-") else 0)
        if effective_index <= 1:
            return child_response("Shopping__get_all_discount_codes", {})
        return child_response("final_answer", {"answer": "SAVE applies to item-1."})

    future = Message(MessageType.USER_MESSAGE, "CONTROLLED_FUTURE_NOT_VISIBLE",
        datetime.fromtimestamp(env.time_manager.time() + 100000, tz=timezone.utc))
    env.notification_system.message_queue.put(future)
    try:
        with patch.object(socket.socket, "connect", loopback_only), \
                patch.object(bridge, "completion", actor), \
                patch("gaia2_official_a2a._sdk_completion", sdk), \
                patch.object(official_a2a, "build_scoped_app_agent", controlled_builder):
            validation = bridge._native_run_with_agent(None, scenario_id, scenario, env,
                "controlled", "controlled-model", "openai", "http://127.0.0.1:1/v1")
        if not validation.success or env.pause_event.is_set():
            raise AssertionError("VALIDATION_OR_PAUSE_CLEANUP_FAILED")
        event_file = Path(os.environ["GAIA2_RUNTIME_EVENT_FILE"])
        events = [json.loads(line) for line in event_file.read_text(encoding="utf-8").splitlines()]
        snapshots = [event for event in events if event["type"] == "a2a_child_runtime_snapshot"]
        pumps = [event for event in events if event["type"] == "a2a_parent_notification_pumped"]
        completed = [event for event in snapshots if event["runnerSnapshot"]["completed"]]
        failed = [event for event in snapshots if event["runnerSnapshot"]["failed"]]
        if mode == "normal":
            assert len(completed) == 1 and not failed and len(sdk_calls) == 2
        elif readback_mode:
            assert len(completed) == 1 and not failed and len(sdk_calls) == 5
            snapshot = completed[0]["runnerSnapshot"]
            assert len(blocked_dispatches) == 1 and len(completed_dispatches) == 4
            assert len(snapshot["blockedActions"]) == 1 and len(snapshot["actions"]) == 4
            # The pinned runner also takes the official observation after
            # final_answer. Preserve that existing successful-action count;
            # the blocked attempt must not add a fifth observation.
            assert snapshot["originalObservationsTaken"] == 4
            assert app.saved_apartments == ["apt-1"] and clock_advanced
        elif mode.startswith("user-"):
            assert len(completed) == 1 and len(failed) == 1 and len(sdk_calls) == 3
            assert failed[0]["runnerSnapshot"]["actions"] == []
            assert failed[0]["runnerSnapshot"]["failureCode"] == "SCOPED_AGENT_NOTIFICATION_STALE"
            stage = "model_returned" if mode == "user-after-offset" else "sdk_attempt_after"
            assert any(event["stage"] == stage and event["publishedCount"] == 1 for event in pumps)
        else:
            assert not completed and len(failed) == 1 and len(sdk_calls) == 1
            assert failed[0]["runnerSnapshot"]["actions"] == []
            assert env.state is EnvironmentState.STOPPED
        assert any(item.message == future.message for item in env.notification_system.message_queue.list_view())
        assert all("CONTROLLED_FUTURE_NOT_VISIBLE" not in str(call["messages"]) for call in parent_calls + sdk_calls)
        return {"status": "passed", "mode": mode, "syntheticFixtureOnly": True,
            "benchmarkExecuted": False, "realModelCalls": 0, "externalNetworkAttempts": 0,
            "parentCalls": len(parent_calls), "sdkCalls": len(sdk_calls), "childSnapshots": len(snapshots),
            "childCompleted": len(completed), "childFailed": len(failed), "pauseCleared": True,
            "blockedDispatches": len(blocked_dispatches), "completedDispatches": len(completed_dispatches),
            "controlledClockAdvanceSeconds": 61.0 if clock_advanced else 0.0,
            "savedApartments": list(app.saved_apartments) if readback_mode else None,
            "futureHidden": True, "parentToolMessageOrderVerified": mode.startswith("user-"),
            "eventPath": str(event_file), "workspace": str(workspace)}
    finally:
        env.stop()
        if env.thread is not None:
            env.thread.join(timeout=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--mode", required=True,
        choices=("normal", "user-after-sdk", "user-after-offset", "stop-after-sdk", "readback-then-fresh"))
    args = parser.parse_args()
    print("PRODUCTION_BRIDGE_PROBE:" + json.dumps(run(Path(args.workspace), args.mode)))
