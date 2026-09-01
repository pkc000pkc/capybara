from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOK_PATH = ROOT / "hooks" / "state-bench-learning.ts"

NODE_RUNNER = r"""
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const source = payload.source
  .replace(/^import[^\n]*\n/u, "")
  .replace("export default defineHook({", "const hookDefinition = defineHook({");
const load = new Function("defineHook", `${source}\nreturn hookDefinition;`);
const hook = load((definition) => definition);
const requests = [];
const outputs = [...payload.outputs];
const llm = {
  responses: {
    async create(request) {
      requests.push(request);
      if (outputs.length === 0) throw new Error("unexpected LLM request");
      return { output_text: outputs.shift() };
    },
  },
};
const training = {
  runId: "run-test",
  phase: "training",
  parameters: { generalEntries: "24", domainEntries: "48" },
  case: {
    id: "case-test",
    sampleId: "sample-test",
    question: "Domain: travel\nResolve the observable booking workflow.",
    thinking: "",
    expectedAnswer: "OFFICIAL_REFERENCE_SECRET",
    actualAnswer: "The visible execution succeeded.",
    expectedTools: [],
    actualTools: ["search"],
    toolCalls: [],
  },
  evaluation: {
    passed: true,
    score: 1,
    rationale: "EVALUATOR_PRIVATE_SECRET",
    metrics: {},
  },
  correctionAttempts: payload.correctionAttempts || [],
};
const variables = {
  builtin: {
    prompts: {
      memory_general: "[]",
      memory_travel: "[]",
      memory_manifest: "",
      ...(payload.prompts || {}),
    },
  },
};
hook.run({ llm, training, variables }).then(
  (result) => process.stdout.write(JSON.stringify({ ok: true, result, requests })),
  (error) => process.stdout.write(JSON.stringify({ ok: false, error: String(error), requests })),
);
"""


def run_hook(
    outputs: list[str],
    prompts: dict[str, str] | None = None,
    correction_attempts: list[dict] | None = None,
) -> dict:
    payload = json.dumps(
        {
            "source": HOOK_PATH.read_text(encoding="utf-8"),
            "outputs": outputs,
            "prompts": prompts or {},
            "correctionAttempts": correction_attempts or [],
        },
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


def valid_entry() -> dict:
    return {
        "intent": "booking_preflight",
        "mode": "advice",
        "phase": "preflight",
        "trigger": "A booking change requires locating the current record.",
        "rule": "Search for the booking before attempting a state-changing tool call.",
        "tools": ["search"],
        "tags": ["booking", "ordering"],
        "requiredEvidence": ["Current booking record"],
        "blockWhen": [],
    }


def test_learning_hook_repairs_malformed_json_once_without_private_context() -> None:
    malformed = '{"domainEntries":[{"id":"broken" "trigger":"missing comma"}],"generalEntries":[]}'
    repaired = json.dumps({"domainEntries": [valid_entry()], "generalEntries": []})

    outcome = run_hook([malformed, repaired])

    assert outcome["ok"] is True
    assert len(outcome["requests"]) == 2
    repair_prompt = outcome["requests"][1]["input"]
    assert malformed in repair_prompt
    assert "OFFICIAL_REFERENCE_SECRET" not in outcome["requests"][0]["input"]
    assert "EVALUATOR_PRIVATE_SECRET" not in outcome["requests"][0]["input"]
    assert "OFFICIAL_REFERENCE_SECRET" not in repair_prompt
    assert "EVALUATOR_PRIVATE_SECRET" not in repair_prompt
    assert outcome["requests"][0]["max_output_tokens"] == 4000
    assert outcome["requests"][1]["max_output_tokens"] == 4000
    patch = outcome["result"]["experiences"][0]["patches"][0]["unifiedDiff"]
    assert valid_entry()["rule"] in patch


def test_learning_hook_rejects_invalid_repair_output() -> None:
    malformed = '{"domainEntries":['
    outcome = run_hook([malformed, "still not JSON"])

    assert outcome["ok"] is False
    assert len(outcome["requests"]) == 2
    assert "memory extractor returned no JSON object" in outcome["error"]


def test_learning_hook_keeps_entry_sanitization_after_repair() -> None:
    malformed = '{"domainEntries":['
    incomplete_entry = valid_entry()
    incomplete_entry.pop("trigger")
    repaired = json.dumps({"domainEntries": [incomplete_entry], "generalEntries": []})

    outcome = run_hook([malformed, repaired])

    assert outcome["ok"] is False
    assert "memory entry requires intent, trigger, and rule" in outcome["error"]


def test_learning_hook_defaults_non_finite_numeric_fields() -> None:
    entry = valid_entry()
    entry["confidence"] = "not-a-number"
    entry["evidenceCount"] = "not-a-number"

    outcome = run_hook([json.dumps({"domainEntries": [entry], "generalEntries": []})])

    assert outcome["ok"] is True
    assert len(outcome["requests"]) == 1
    patch = outcome["result"]["experiences"][0]["patches"][0]["unifiedDiff"]
    assert '"confidence": 0.6667' in patch
    assert '"evidenceCount": 1' in patch
    assert '"memoryKey": "travel:advice:preflight:booking_preflight"' in patch


def test_learning_hook_merges_by_stable_memory_key_and_accumulates_evidence() -> None:
    existing = {
        "id": "travel-advice-preflight-booking_preflight",
        "memoryKey": "travel:advice:preflight:booking_preflight",
        "domain": "travel",
        **valid_entry(),
        "confidence": 0.6667,
        "evidenceCount": 1,
        "successCount": 1,
        "failureCount": 0,
        "correctionCount": 0,
    }

    outcome = run_hook(
        [json.dumps({"domainEntries": [valid_entry()], "generalEntries": []})],
        {"memory_travel": json.dumps([existing])},
    )

    assert outcome["ok"] is True
    patch = outcome["result"]["experiences"][0]["patches"][0]["unifiedDiff"]
    assert patch.count('+    "memoryKey": "travel:advice:preflight:booking_preflight"') == 1
    assert '"evidenceCount": 2' in patch
    assert '"successCount": 2' in patch
    assert '"confidence": 0.75' in patch


def test_learning_hook_counts_failed_corrections_as_negative_evidence() -> None:
    attempts = [
        {"ordinal": 1, "summary": "first", "strategy": "try one", "passed": False},
        {"ordinal": 2, "summary": "second", "strategy": "try two", "passed": False},
        {"ordinal": 3, "summary": "third", "strategy": "try three", "passed": True},
    ]

    outcome = run_hook(
        [json.dumps({"domainEntries": [valid_entry()], "generalEntries": []})],
        correction_attempts=attempts,
    )

    assert outcome["ok"] is True
    patch = outcome["result"]["experiences"][0]["patches"][0]["unifiedDiff"]
    assert '"evidenceCount": 3' in patch
    assert '"successCount": 1' in patch
    assert '"failureCount": 2' in patch
    assert '"correctionCount": 3' in patch
    assert '"confidence": 0.4' in patch


def test_learning_hook_rejects_general_advice_entries() -> None:
    entry = valid_entry()
    outcome = run_hook([json.dumps({"domainEntries": [], "generalEntries": [entry]})])

    assert outcome["ok"] is False
    assert "general memory entries must be cross-domain guards" in outcome["error"]
