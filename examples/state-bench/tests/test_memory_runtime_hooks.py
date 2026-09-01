from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SELECTOR_PATH = ROOT / "hooks" / "memory-runtime-selector.ts"
ADMISSION_PATH = ROOT / "hooks" / "state-bench-admission.ts"

NODE_RUNNER = r"""
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const source = payload.source
  .replace(/^import[^\n]*\n/u, "")
  .replace("export default defineHook({", "const hookDefinition = defineHook({");
const load = new Function("defineHook", `${source}\nreturn hookDefinition;`);
const hook = load((definition) => definition);
Promise.resolve(hook.run(payload.context)).then(
  (result) => process.stdout.write(JSON.stringify({ ok: true, result })),
  (error) => process.stdout.write(JSON.stringify({ ok: false, error: String(error) })),
);
"""


def run_hook(path: Path, context: dict) -> dict:
    payload = json.dumps(
        {"source": path.read_text(encoding="utf-8"), "context": context},
        ensure_ascii=False,
    )
    completed = subprocess.run(
        ["node", "-e", NODE_RUNNER],
        input=payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        cwd=ROOT,
    )
    return json.loads(completed.stdout)


def selector_context(query: str, state: dict | None = None, terminal: bool = False) -> dict:
    general = [
        {
            "id": "general-guard-account-authorization",
            "memoryKey": "*:guard:preflight:account_authorization",
            "domain": "*",
            "mode": "guard",
            "phase": "preflight",
            "intent": "account_authorization",
            "trigger": "Before reading a booking for an account, verify authorization and ownership.",
            "rule": "Do not access another account without authoritative ownership evidence.",
            "tools": ["get_booking"],
            "tags": ["booking", "authorization"],
            "requiredEvidence": ["Active account owns the booking"],
            "blockWhen": ["Ownership is not verified"],
            "confidence": 0.75,
            "evidenceCount": 2,
        }
    ]
    travel = [
        {
            "id": "travel-advice-preflight-booking-policy",
            "memoryKey": "travel:advice:preflight:booking_policy",
            "domain": "travel",
            "mode": "advice",
            "phase": "preflight",
            "intent": "booking_policy",
            "trigger": "A flight booking change needs policy review.",
            "rule": "Read the current booking and applicable policy before comparing options.",
            "tools": ["get_booking", "get_policies"],
            "tags": ["flight", "booking", "policy"],
            "requiredEvidence": [],
            "blockWhen": [],
            "confidence": 0.75,
            "evidenceCount": 2,
        }
    ]
    return {
        "variables": {
            "builtin": {
                "prompts": {
                    "memory_manifest": json.dumps({"releaseId": "release-2"}),
                    "memory_general": json.dumps(general),
                    "memory_travel": json.dumps(travel),
                    "memory_customer_support": "[]",
                    "memory_shopping_assistant": "[]",
                    "memory_runtime_context": "",
                    "memory_runtime_state": json.dumps(state or {"iteration": 0}),
                }
            }
        },
        "messages": [{"role": "user", "content": query}],
        "loop": {"runId": "run-1", "iteration": 1, "terminal": terminal},
    }


def runtime_state(result: dict) -> dict:
    patches = result["result"]["patches"]
    value = next(item["value"] for item in patches if item["path"].endswith("memory_runtime_state"))
    return json.loads(value)


def test_runtime_selector_reserves_guard_and_advice_slots_without_repeats() -> None:
    first = run_hook(
        SELECTOR_PATH,
        selector_context("Review authorization and booking policy before changing my flight booking."),
    )

    assert first["ok"] is True
    first_state = runtime_state(first)
    assert first_state["phase"] == "preflight"
    assert first_state["selectedGuardIds"] == ["general-guard-account-authorization"]
    assert first_state["selectedAdviceIds"] == ["travel-advice-preflight-booking-policy"]
    assert first_state["totalInjectedTokens"] <= 300

    second = run_hook(
        SELECTOR_PATH,
        selector_context(
            "Review authorization and booking policy before changing my flight booking.",
            first_state,
        ),
    )
    second_state = runtime_state(second)
    assert second_state["selectedIds"] == []
    assert second_state["usedIds"] == first_state["usedIds"]


def test_runtime_selector_allows_no_memory_for_irrelevant_query() -> None:
    outcome = run_hook(SELECTOR_PATH, selector_context("Hello and thank you."))

    assert outcome["ok"] is True
    assert runtime_state(outcome)["selectedIds"] == []


def admission_context(*, question: str, score: float = 1.0, passed: bool = True) -> dict:
    return {
        "training": {
            "phase": "replay",
            "case": {"question": question},
            "evaluation": {"passed": passed, "score": score},
            "correctionAttempts": [],
            "candidate": {
                "id": "candidate-1",
                "patches": [
                    {
                        "variableName": "memory_travel",
                        "unifiedDiff": '+    "memoryKey": "travel:advice:preflight:policy"\n'
                        '+    "mode": "advice"\n+    "phase": "preflight"',
                    }
                ],
            },
        }
    }


def test_admission_rejects_analysis_only_replay() -> None:
    outcome = run_hook(
        ADMISSION_PATH,
        admission_context(
            question="Analyze one official STATE-Bench training-only trajectory for reusable procedural learning."
        ),
    )

    assert outcome["result"]["admission"]["verdict"] == "reject"
    assert "not execution" in outcome["result"]["admission"]["reasons"][0]


def test_admission_accepts_passing_v2_task_replay_and_rejects_low_score() -> None:
    accepted = run_hook(ADMISSION_PATH, admission_context(question="Domain: travel\nExecute the train task."))
    rejected = run_hook(
        ADMISSION_PATH,
        admission_context(question="Domain: travel\nExecute the train task.", score=0.7),
    )

    assert accepted["result"]["admission"]["verdict"] == "accept"
    assert rejected["result"]["admission"]["verdict"] == "reject"
