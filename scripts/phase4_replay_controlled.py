"""Model-free strategy-consumption replay, using real ARE and real TS Hooks.

This is deliberately a synthetic integration fixture, never an original task
grade. Its Actor is scripted; all IPC, AppTools, notifications and time are real.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import phase3_controlled_fixture as fixture
from are.simulation.scenarios.validation_result import ScenarioValidationResult


def run_graded_control(report_path, passed):
    """Actual ARE state-only validation, not an original benchmark grade."""
    env = fixture.Environment(config=fixture.EnvironmentConfig(start_time=1000, duration=60, verbose=False))
    aui, system, ledger = fixture.AgentUserInterface(), fixture.SystemApp(), fixture.ControlledLedger()
    env.register_apps([aui, system, ledger]); env.state = fixture.EnvironmentState.RUNNING
    class Scenario(fixture.Scenario):
        def validate(self, environment):
            self.validation_calls += 1
            return ScenarioValidationResult(success=passed)
    scenario = Scenario(scenario_id=os.environ["GAIA2_CONTROLLED_SCENARIO_ID"], apps=[aui, system, ledger],
                        nb_turns=1, start_time=1000, duration=60)
    scenario.validation_calls = 0
    scenario.hints = ["HIDDEN_ORACLE_SENTINEL_8DD72D"]
    aui.send_message_to_agent("Controlled fresh user request.")
    steps = [("ControlledLedger__write", {"value": "uncertain"}, "unknown-first"),
             ("ControlledLedger__read", {}, "unknown-readback"),
             ("ControlledLedger__write", {"value": "uncertain"}, "unknown-after-read"),
             ("AgentUserInterface__send_message_to_user", {"content": "Controlled current state observed."}, "finish")]
    actors = []
    def completion(**kwargs):
        messages = kwargs["messages"]
        assert kwargs["parallel_tool_calls"] is True
        assert env.state == fixture.EnvironmentState.PAUSED
        context = messages[1]["content"].split("Live Capybara dynamic context:\n", 1)[1]
        assert os.environ["GAIA2_CORRECTION_STRATEGY_TEXT"] in context
        assert "HIDDEN_ORACLE_SENTINEL_8DD72D" not in json.dumps(messages)
        actors.append({"messages": messages, "context": context, "contextHash": hashlib.sha256(context.encode()).hexdigest()})
        return fixture._response(*steps[len(actors) - 1])
    fixture.bridge.completion = fixture.wrap_completion(completion, "actor", fixture.bridge._emit_runtime_event)
    validation = fixture.bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default", "controlled-no-model")
    assert validation.success is passed and scenario.validation_calls == 1
    assert ledger.calls == {"write": 1, "read": 1, "failed_read": 0}
    assert ledger.values == ["uncertain"]
    assert not fixture._external_attempts
    fixture._save(report_path.parent / "actor-inputs.json", actors)
    fixture._save(report_path.parent / "are-completed-events.json", env.event_log.to_dict())
    result = {"schemaVersion": "gaia2-phase4-graded-control-v1", "status": "passed", "case": "unknown",
              "syntheticFixtureOnly": True, "benchmarkExecuted": False, "realModelCalls": 0,
              "externalNetworkAttempts": 0, "callbackCounts": ledger.calls, "validationSuccess": passed,
              "scenarioId": scenario.scenario_id, "officialSubmissionReady": False}
    fixture._save(report_path, result)
    return result

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", choices=["unknown", "dynamic"], required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--grade", choices=["passed", "failed"])
    args = parser.parse_args()
    report_path = args.report.resolve()
    result = run_graded_control(report_path, args.grade == "passed") if args.grade else fixture.run_fixture(args.case, report_path)
    actors = json.loads((report_path.parent / "actor-inputs.json").read_text(encoding="utf-8"))
    text = os.environ["GAIA2_CORRECTION_STRATEGY_TEXT"]
    strategy_hash = os.environ["GAIA2_CORRECTION_STRATEGY_HASH"]
    assert hashlib.sha256(text.encode("utf-8")).hexdigest() == strategy_hash
    assert os.environ["GAIA2_E2E_CORRECTION_ORDINAL"] == "1"
    for actor in actors:
        assert text in actor["messages"][1]["content"]
        visible = json.dumps(actor["messages"])
        for forbidden in ("FUTURE_USER_SENTINEL", "LATE_USER_ANSWER_SENTINEL", "OLD_RECORD_ID_SENTINEL", "OLD_RECORD_SENTINEL", "RAW_TOOL_CONTENT_SENTINEL", "987654.125"):
            assert forbidden not in visible
    proof = {"schemaVersion": "gaia2-phase4-controlled-consumption-v1", "syntheticFixtureOnly": True,
             "benchmarkExecuted": False, "realModelCalls": 0, "actorInputHashReconstructed": True,
             "strategyConsumedModelRequests": len(actors), "consumedStrategyHash": strategy_hash,
             "freshClockOrigin": 1000, "case": args.case, "actualCallbackCounts": result["callbackCounts"],
             "externalNetworkAttempts": result["externalNetworkAttempts"], "officialSubmissionReady": False}
    with (report_path.parent / "strategy-consumption.json").open("x", encoding="utf-8") as stream:
        json.dump(proof, stream)
    print(json.dumps(proof))


if __name__ == "__main__":
    main()
