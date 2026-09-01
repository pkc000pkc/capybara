from __future__ import annotations

import json
import zipfile
from types import SimpleNamespace

import pytest

from agents.capybara_agents import (
    CapybaraBaselineAgent,
    CapybaraLearnedAgent,
    capybara_correction_context,
)
from capybara_first_round.artifact import (
    MEMORY_VARIABLES,
    canonical_snapshot_hash,
    export_learning_artifact,
)
from capybara_first_round.config import (
    load_compatible_credentials,
    load_first_round_config,
    validate_held_out_selection,
)
from capybara_first_round.memory import MemoryPrefetchSelector
from capybara_first_round.projection import selected_training_paths
from scripts import run_local_first_round_eval as evaluation_runner
from scripts.run_capybara_training import create_training_batch, registered_dataset_path
from scripts.run_capybara_training import selected_domains as training_domains
from scripts.run_local_first_round_eval import (
    _build_correction_prompt,
    _is_fully_scored,
    _load_trajectory,
    _observable_failure_payload,
    _parse_correction_proposal,
    _prefetch_events,
    lock_evaluation_source,
    selected_task_ids,
)
from scripts.run_local_first_round_eval import selected_domains as evaluation_domains
from state_bench.agents.base import AgentRuntimeContext
from state_bench.client import LLMClient
from state_bench.protocol import load_default_protocol


def _runtime_context(domain: str) -> AgentRuntimeContext:
    return AgentRuntimeContext(
        task_id="held-out-task",
        user_id="held-out-user",
        domain=domain,
        now="2026-08-12T00:00:00Z",
    )


def _fake_client() -> LLMClient:
    return LLMClient.__new__(LLMClient)


def _entry(
    entry_id: str,
    domain: str,
    trigger: str,
    rule: str,
    *,
    mode: str | None = None,
    phase: str = "any",
) -> dict[str, object]:
    selected_mode = mode or ("guard" if domain == "*" else "advice")
    return {
        "id": entry_id,
        "memoryKey": f"{domain}:{selected_mode}:{phase}:{entry_id}",
        "domain": domain,
        "mode": selected_mode,
        "phase": phase,
        "intent": entry_id,
        "trigger": trigger,
        "rule": rule,
        "tools": [],
        "tags": trigger.split(),
        "confidence": 0.8,
        "evidenceCount": 1,
        "successCount": 1,
        "failureCount": 0,
        "requiredEvidence": [],
        "blockWhen": [],
    }


def _learning_variables() -> dict[str, str]:
    return {
        "memory_manifest": json.dumps(
            {"schemaVersion": 1, "releaseId": "release-1", "domains": list(MEMORY_VARIABLES.values())}
        ),
        "memory_general": json.dumps(
            [
                _entry(
                    "general-consent",
                    "*",
                    "explicit consent before irreversible change",
                    "Ask for explicit consent before mutation.",
                    phase="mutation",
                )
            ]
        ),
        "memory_travel": json.dumps(
            [_entry("travel-policy", "travel", "booking policy flight", "Read policy before changing a booking.")]
        ),
        "memory_customer_support": json.dumps(
            [_entry("support-order", "customer_support", "order return", "Inspect the order before a remedy.")]
        ),
        "memory_shopping_assistant": json.dumps(
            [_entry("shopping-promo", "shopping_assistant", "cart promotion", "Check eligibility before cart changes.")]
        ),
        "memory_runtime_context": "",
        "memory_runtime_state": json.dumps({"iteration": 0}),
    }


def _artifact_entries() -> list[dict[str, object]]:
    variables = _learning_variables()
    entries: list[dict[str, object]] = []
    for variable, domain in MEMORY_VARIABLES.items():
        for raw in json.loads(variables[variable]):
            entries.append(
                {
                    **raw,
                    "evidence_count": raw.pop("evidenceCount", 1),
                    "source_variable": variable,
                }
            )
    return entries


def test_correction_prompt_uses_only_observable_failure_evidence() -> None:
    trajectory = {
        "task_id": "hidden-task-id",
        "conversation": [
            {"role": "user", "content": "observable request"},
            {
                "role": "assistant",
                "content": "observable failed answer",
                "tool_calls": [{"name": "lookup", "arguments": {"query": "visible"}, "result": {"ok": True}}],
            },
        ],
        "state_requirements_gt": "SECRET_STATE_ASSERTION",
        "state_requirements_details": "SECRET_STATE_DETAILS",
        "task_requirements_details": "SECRET_JUDGE_DETAILS",
        "state_requirements_reasoning": "SECRET_JUDGE_REASONING",
    }
    previous = [
        {
            "ordinal": 1,
            "summary": "observable hypothesis",
            "strategy": "observable strategy",
            "passed": False,
            "rationale": "SECRET_PREVIOUS_JUDGE_RATIONALE",
        }
    ]

    payload = _observable_failure_payload(trajectory)
    prompt = _build_correction_prompt(trajectory, previous)

    assert payload == {"conversation": trajectory["conversation"]}
    assert "observable request" in prompt
    assert "observable strategy" in prompt
    assert "hidden-task-id" not in prompt
    assert "SECRET_STATE_ASSERTION" not in prompt
    assert "SECRET_STATE_DETAILS" not in prompt
    assert "SECRET_JUDGE_DETAILS" not in prompt
    assert "SECRET_JUDGE_REASONING" not in prompt
    assert "SECRET_PREVIOUS_JUDGE_RATIONALE" not in prompt


def test_correction_context_is_temporary_and_thread_local() -> None:
    plain = CapybaraBaselineAgent(_fake_client(), "base prompt", [], {}, runtime_context=_runtime_context("travel"))
    assert "temporary clean-run strategy" not in plain.system_prompt

    with capybara_correction_context("Read authoritative state, then verify the mutation."):
        corrected = CapybaraBaselineAgent(
            _fake_client(), "base prompt", [], {}, runtime_context=_runtime_context("travel")
        )
    after = CapybaraBaselineAgent(_fake_client(), "base prompt", [], {}, runtime_context=_runtime_context("travel"))

    assert "Read authoritative state, then verify the mutation." in corrected.system_prompt
    assert "No expected answer or evaluator explanation is available" in corrected.system_prompt
    assert "Read authoritative state, then verify the mutation." not in after.system_prompt


def test_correction_proposal_requires_summary_and_strategy() -> None:
    assert _parse_correction_proposal({"summary": "cause", "strategy": "retry cleanly"}) == (
        "cause",
        "retry cleanly",
    )
    with pytest.raises(ValueError, match="omitted"):
        _parse_correction_proposal({"summary": "cause"})


def test_configured_tasks_are_unique_official_held_out_tasks() -> None:
    config = load_first_round_config()
    validate_held_out_selection(config)
    assert config["agent_model"] == "gpt-5.6-luna"
    assert config["evaluation_tasks_per_domain"] == 50
    assert config["num_runs"] == 5
    assert config["prefetch_top_k"] == 2

    invalid = json.loads(json.dumps(config))
    invalid["domains"]["travel"]["held_out_tasks"][0] = "1-cancel_flight"
    with pytest.raises(ValueError, match="not held out"):
        validate_held_out_selection(invalid)


def test_compatible_credentials_use_round_model_not_credential_project(monkeypatch) -> None:
    monkeypatch.delenv("STATE_BENCH_COMPAT_AGENT_MODEL", raising=False)
    _base_url, _api_key, model = load_compatible_credentials()
    assert model == "gpt-5.6-luna"


def test_projection_selects_exactly_first_five_training_trajectories_per_domain() -> None:
    expected_prefixes = {
        "travel": [1, 2, 3, 5, 7],
        "customer_support": [1, 2, 3, 4, 5],
        "shopping_assistant": [1, 2, 3, 5, 6],
    }
    for domain in ("travel", "customer_support", "shopping_assistant"):
        paths = selected_training_paths(domain, 5)
        prefixes = [int(path.stem.split("-", 1)[0]) for path in paths]
        assert prefixes == expected_prefixes[domain]
        assert all("train_task_trajectories" in path.parts for path in paths)


def test_registered_dataset_path_normalizes_relative_and_absolute_paths() -> None:
    relative = "datasets/capybara/first_round_train.jsonl"
    absolute = registered_dataset_path(relative)
    assert absolute.is_absolute()
    assert registered_dataset_path(str(absolute)) == absolute


def test_small_batch_selection_is_domain_scoped_and_deterministic(tmp_path) -> None:
    config = load_first_round_config()
    assert training_domains("travel,shopping_assistant,travel", config) == [
        "travel",
        "shopping_assistant",
    ]
    assert evaluation_domains("customer_support", config) == ["customer_support"]
    with pytest.raises(ValueError, match="Unknown STATE-Bench domain"):
        training_domains("unknown", config)

    source = tmp_path / "source.jsonl"
    source.write_text(
        "".join(
            json.dumps(
                {
                    "id": f"{domain}:{index}",
                    "metadata": {"domain": domain},
                }
            )
            + "\n"
            for domain in ("travel", "customer_support")
            for index in range(1, 4)
        ),
        encoding="utf-8",
    )
    output = tmp_path / "batch.jsonl"
    records, selected = create_training_batch(source, output, ["travel", "customer_support"], 1)
    assert [record["id"] for record in records] == ["travel:1", "customer_support:1"]
    assert selected == {"travel": ["travel:1"], "customer_support": ["customer_support:1"]}
    assert len(output.read_text(encoding="utf-8").splitlines()) == 2


def test_full_evaluation_selection_uses_all_fifty_protocol_test_tasks() -> None:
    protocol = load_default_protocol()
    for domain in protocol.domains:
        task_ids = selected_task_ids(domain, 50, protocol)
        assert len(task_ids) == 50
        assert len(set(task_ids)) == 50
    with pytest.raises(ValueError, match="between 1 and 50"):
        selected_task_ids("travel", 51, protocol)


def test_source_lock_archives_inputs_excludes_secrets_and_prevents_drift(monkeypatch, tmp_path) -> None:
    root = tmp_path / "repo"
    (root / "agents").mkdir(parents=True)
    (root / ".capybara").mkdir()
    (root / "agents" / "agent.py").write_text("MODEL = 'one'\n", encoding="utf-8")
    (root / "pyproject.toml").write_text("[project]\nname = 'test'\n", encoding="utf-8")
    (root / ".capybara" / "secrets.json").write_text('{"api_key":"secret"}', encoding="utf-8")
    output_root = root / "runs" / "run-1" / "learned"
    output_root.mkdir(parents=True)
    monkeypatch.setattr(evaluation_runner, "git_output", lambda *_args: "test-git-state")

    metadata = lock_evaluation_source(output_root, resume=False, root=root)
    archive_path = root / metadata["archive_path"]
    with zipfile.ZipFile(archive_path) as archive:
        archived = set(archive.namelist())
    assert "agents/agent.py" in archived
    assert "pyproject.toml" in archived
    assert all("secret" not in name for name in archived)

    assert lock_evaluation_source(output_root, resume=False, root=root)["fingerprint"] == metadata["fingerprint"]
    (output_root / "token_usage.jsonl").write_text("", encoding="utf-8")
    with pytest.raises(RuntimeError, match="pass --resume"):
        lock_evaluation_source(output_root, resume=False, root=root)
    assert lock_evaluation_source(output_root, resume=True, root=root)["fingerprint"] == metadata["fingerprint"]

    (root / "agents" / "agent.py").write_text("MODEL = 'two'\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="source changed"):
        lock_evaluation_source(output_root, resume=True, root=root)


def test_resume_accepts_unscored_interaction_and_detects_complete_scores(tmp_path) -> None:
    path = tmp_path / "trajectory.json"
    trajectory = {
        "task_id": "task-1",
        "conversation": [{"role": "user", "content": "hello"}],
        "memory_prefetch": {"events": [{"selected_ids": ["memory-1"]}]},
        "task_completion_pass": None,
        "ux_score": None,
    }
    path.write_text(json.dumps(trajectory), encoding="utf-8")

    loaded, error = _load_trajectory(path, task_id="task-1", learned=True)
    assert error is None
    assert loaded is not None
    assert _is_fully_scored(loaded) is False

    trajectory["task_completion_pass"] = 0
    trajectory["ux_score"] = 0.0
    path.write_text(json.dumps(trajectory), encoding="utf-8")
    loaded, error = _load_trajectory(path, task_id="task-1", learned=True)
    assert error is None
    assert loaded is not None
    assert _is_fully_scored(loaded) is True


def test_prefetch_events_follow_trajectory_top_level_serialization() -> None:
    events = [{"iteration": 1, "selected_ids": ["memory-1"]}]
    assert _prefetch_events({"memory_prefetch": {"events": events}}) == events
    assert _prefetch_events({"metadata": {"memory_prefetch": {"events": events}}}) == events


def test_snapshot_hash_and_atomic_artifact_export(tmp_path) -> None:
    variables = _learning_variables()
    reordered = dict(reversed(list(variables.items())))
    expected_hash = canonical_snapshot_hash(variables)
    assert canonical_snapshot_hash(reordered) == expected_hash
    snapshot = {"id": "snapshot-1", "runId": "run-1", "variables": reordered, "contentHash": expected_hash}
    artifact = export_learning_artifact(snapshot, tmp_path / "learnings.json", {"round": 1})

    assert artifact["schema_version"] == 2
    assert artifact["snapshot_content_hash"] == expected_hash
    assert artifact["read_only"] is True
    assert artifact["release_id"] == "release-1"
    assert {entry["id"] for entry in artifact["entries"]} == {
        "general-consent",
        "travel-policy",
        "support-order",
        "shopping-promo",
    }


def test_artifact_defaults_null_numeric_fields_from_frozen_snapshot(tmp_path) -> None:
    variables = _learning_variables()
    entries = json.loads(variables["memory_general"])
    entries[0]["confidence"] = None
    entries[0]["evidenceCount"] = None
    variables["memory_general"] = json.dumps(entries)
    snapshot = {
        "id": "snapshot-1",
        "runId": "run-1",
        "variables": variables,
        "contentHash": canonical_snapshot_hash(variables),
    }

    artifact = export_learning_artifact(snapshot, tmp_path / "learnings.json", {})
    entry = next(item for item in artifact["entries"] if item["id"] == "general-consent")
    assert entry["confidence"] == 0.5
    assert entry["evidence_count"] == 1


def test_artifact_rejects_case_identifier_leakage(tmp_path) -> None:
    variables = _learning_variables()
    entries = json.loads(variables["memory_travel"])
    entries[0]["rule"] += " Never expose BK-SECRET-123."
    variables["memory_travel"] = json.dumps(entries)
    snapshot = {
        "id": "snapshot-1",
        "runId": "run-1",
        "variables": variables,
        "contentHash": canonical_snapshot_hash(variables),
    }
    with pytest.raises(ValueError, match="task-specific identifier"):
        export_learning_artifact(snapshot, tmp_path / "learnings.json", {})


def test_artifact_rejects_case_identifier_leakage_in_memory_metadata(tmp_path) -> None:
    variables = _learning_variables()
    entries = json.loads(variables["memory_travel"])
    entries[0]["intent"] = "special_handling_for_BK-SECRET-123"
    variables["memory_travel"] = json.dumps(entries)
    snapshot = {
        "id": "snapshot-1",
        "runId": "run-1",
        "variables": variables,
        "contentHash": canonical_snapshot_hash(variables),
    }
    with pytest.raises(ValueError, match="task-specific identifier"):
        export_learning_artifact(snapshot, tmp_path / "learnings.json", {})


def test_artifact_allows_plain_domain_words_that_share_an_id_prefix(tmp_path) -> None:
    variables = _learning_variables()
    entries = json.loads(variables["memory_shopping_assistant"])
    entries[0]["rule"] += " Confirm before any cart-changing action."
    variables["memory_shopping_assistant"] = json.dumps(entries)
    snapshot = {
        "id": "snapshot-1",
        "runId": "run-1",
        "variables": variables,
        "contentHash": canonical_snapshot_hash(variables),
    }
    artifact = export_learning_artifact(snapshot, tmp_path / "learnings.json", {})
    assert any(entry["id"] == "shopping-promo" for entry in artifact["entries"])


def test_selector_is_domain_scoped_deterministic_capped_and_budgeted() -> None:
    entries = _artifact_entries()
    first_selector = MemoryPrefetchSelector(entries, "travel", "release-1", max_run_tokens=300)
    second_selector = MemoryPrefetchSelector(entries, "travel", "release-1", max_run_tokens=300)
    first_context, first_event = first_selector.select(
        "change flight booking policy with explicit consent", 1, phase="mutation"
    )
    second_context, second_event = second_selector.select(
        "change flight booking policy with explicit consent", 1, phase="mutation"
    )

    assert first_context == second_context
    assert first_event["selected_ids"] == second_event["selected_ids"]
    assert 1 <= len(first_event["selected_ids"]) <= 2
    assert "travel-policy" in first_event["selected_ids"]
    assert "support-order" not in first_event["selected_ids"]
    assert "shopping-promo" not in first_event["selected_ids"]
    assert first_event["selected_guard_ids"] == ["general-consent"]
    _, repeated = first_selector.select(
        "change flight booking policy with explicit consent", 2, phase="mutation"
    )
    assert repeated["selected_ids"] == []
    assert len(first_selector.used_ids) == len(set(first_selector.used_ids))
    assert first_selector.total_injected_tokens <= first_selector.max_run_tokens

    irrelevant = MemoryPrefetchSelector(entries, "travel", "release-1")
    context, event = irrelevant.select("unrelated conversational filler", 1, phase="decision")
    assert context == ""
    assert event["selected_ids"] == []


def test_learned_agent_uses_automatic_prefetch_without_redundant_retrieval_tool(
    monkeypatch, tmp_path
) -> None:
    artifact_path = tmp_path / "learnings.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "read_only": True,
                "release_id": "release-1",
                "snapshot_content_hash": "a" * 64,
                "entries": _artifact_entries(),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("CAPYBARA_LEARNINGS_PATH", str(artifact_path))
    agent = CapybaraLearnedAgent(
        _fake_client(),
        "system prompt",
        [],
        {},
        runtime_context=_runtime_context("travel"),
        retrieve_learnings_top_k=2,
    )
    assert agent.retrieval_enabled is False
    assert all(tool.get("name") != "retrieve_learnings" for tool in agent.tools)
    assert len(agent.retrieve_learnings("flight booking policy", top_k=2)) <= 2
    with pytest.raises(ValueError, match="benchmark-fixed value"):
        agent.retrieve_learnings("flight booking policy", top_k=3)
    instructions = agent._instructions_with_prefetch("system prompt", "flight booking policy")
    assert "Core runtime guards" in instructions
    assert len(agent.selector.events) == 2
    assert agent.selector.events[0]["selected_ids"] == ["travel-policy"]
    assert agent.selector.events[1]["selected_ids"] == []


def test_learned_agent_prefetches_before_initial_and_tool_follow_up_calls(monkeypatch, tmp_path) -> None:
    artifact_path = tmp_path / "learnings.json"
    artifact_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "read_only": True,
                "release_id": "release-1",
                "snapshot_content_hash": "a" * 64,
                "entries": _artifact_entries(),
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("CAPYBARA_LEARNINGS_PATH", str(artifact_path))
    client = _fake_client()
    requests = []

    def complete_with_tools(**kwargs):
        requests.append(kwargs)
        if len(requests) == 1:
            return SimpleNamespace(
                id="response-1",
                output=[
                    SimpleNamespace(
                        type="function_call",
                        call_id="call-1",
                        name="lookup",
                        arguments=json.dumps({"query": "booking"}),
                    )
                ],
                output_text="",
                usage=None,
            )
        return SimpleNamespace(
            id="response-2",
            output=[],
            output_text="done",
            usage=None,
        )

    client.complete_with_tools = complete_with_tools
    agent = CapybaraLearnedAgent(
        client,
        "system prompt",
        [
            {
                "type": "function",
                "name": "lookup",
                "description": "Look up a booking.",
                "parameters": {"type": "object", "properties": {}},
            }
        ],
        {"lookup": lambda args: {"booking": args["query"]}},
        runtime_context=_runtime_context("travel"),
        retrieve_learnings_top_k=2,
    )
    text, tool_calls, _raw = agent.act([{"role": "user", "content": "change my flight booking"}])

    assert text == "done"
    assert len(tool_calls) == 1
    assert len(requests) == 2
    assert len(agent.selector.events) == 2
    assert agent.selector.events[0]["phase"] == "preflight"
    assert agent.selector.events[1]["phase"] == "decision"
    selected = [entry_id for event in agent.selector.events for entry_id in event["selected_ids"]]
    assert len(selected) == len(set(selected))
    assert "Core runtime guards" in requests[0]["instructions"]
    assert "Replay-validated memory" in requests[0]["instructions"]


def test_baseline_has_no_retrieval_tool() -> None:
    agent = CapybaraBaselineAgent(
        _fake_client(), "system prompt", [], {}, runtime_context=_runtime_context("travel")
    )
    assert agent.retrieval_enabled is False
    assert all(tool.get("name") != "retrieve_learnings" for tool in agent.tools)
