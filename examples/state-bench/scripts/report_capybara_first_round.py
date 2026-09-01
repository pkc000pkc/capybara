from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from statistics import mean
from typing import Any

from capybara_first_round.config import (
    ROOT,
    git_output,
    load_first_round_config,
    resolve_capybara_repo,
    sha256_file,
)


def _average(values: list[float | int | None]) -> float | None:
    available = [float(value) for value in values if value is not None]
    return round(mean(available), 4) if available else None


def _load_trajectories(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    trajectories = []
    for result in manifest["results"]:
        if result.get("status") != "OK":
            continue
        path = ROOT / result["output_path"]
        trajectory = json.loads(path.read_text(encoding="utf-8"))
        trajectory["_domain"] = result["domain"]
        trajectories.append(trajectory)
    return trajectories


def _metrics(trajectories: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [item for item in trajectories if item.get("task_completion_pass") is not None]
    passes = sum(int(item["task_completion_pass"] == 1) for item in scored)
    selected_ids = sorted(
        {entry_id for item in trajectories for entry_id in item.get("prefetch_selected_ids", [])}
    )
    return {
        "tasks": len(trajectories),
        "scored": len(scored),
        "passes": passes,
        "pass_at_1": round(passes / len(scored), 4) if scored else None,
        "state_pass_rate": _average([item.get("state_requirements_met") for item in trajectories]),
        "task_requirements_pass_rate": _average(
            [item.get("task_requirements_met") for item in trajectories]
        ),
        "average_ux": _average([item.get("ux_score") for item in trajectories]),
        "average_turns": _average([item.get("turns") for item in trajectories]),
        "average_tool_calls": _average([item.get("tool_calls") for item in trajectories]),
        "average_input_tokens": _average([item.get("input_tokens") for item in trajectories]),
        "average_output_tokens": _average([item.get("output_tokens") for item in trajectories]),
        "average_total_tokens": _average([item.get("total_tokens") for item in trajectories]),
        "average_wall_seconds": _average([item.get("wall_seconds") for item in trajectories]),
        "prefetch_events": sum(int(item.get("prefetch_events", 0)) for item in trajectories),
        "prefetch_injected_tokens": sum(
            int(item.get("prefetch_injected_tokens", 0)) for item in trajectories
        ),
        "prefetch_selected_ids": selected_ids,
    }


def _group_metrics(trajectories: list[dict[str, Any]]) -> dict[str, Any]:
    by_domain: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in trajectories:
        by_domain[item["_domain"]].append(item)
    return {
        "overall": _metrics(trajectories),
        "domains": {domain: _metrics(items) for domain, items in sorted(by_domain.items())},
    }


def _format_rate(value: float | None) -> str:
    return "n/a" if value is None else f"{value * 100:.1f}%"


def _format_number(value: float | None, digits: int = 2) -> str:
    return "n/a" if value is None else f"{value:.{digits}f}"


def _growth(after: float | None, before: float | None) -> float | None:
    if after is None or before in (None, 0):
        return None
    return round((after - before) / before, 4)


def _delta(after: float | None, before: float | None) -> float | None:
    if after is None or before is None:
        return None
    return round(after - before, 4)


def _selection_keys(manifest: dict[str, Any]) -> set[tuple[str, str]]:
    selection = manifest.get("selection") or {}
    return {
        (domain, task_id)
        for domain, task_ids in (selection.get("task_ids") or {}).items()
        for task_id in task_ids
    }


def _validate_prefetch_trace(item: dict[str, Any]) -> list[dict[str, Any]]:
    memory = item.get("memory_prefetch") or (item.get("metadata") or {}).get("memory_prefetch") or {}
    events = memory.get("events") or []
    if not isinstance(events, list) or not events:
        raise ValueError(f"learned trajectory has no automatic prefetch trace: {item['task_id']}")
    expected_iterations = list(range(1, len(events) + 1))
    actual_iterations = [int(event.get("iteration", 0)) for event in events]
    if actual_iterations != expected_iterations:
        raise ValueError(f"prefetch iterations are not contiguous for {item['task_id']}")
    previous_total = 0
    for event in events:
        selections = event.get("selections") or []
        selected_ids = event.get("selected_ids") or []
        if len(selected_ids) > 2 or len(selections) != len(selected_ids):
            raise ValueError(f"prefetch selection cardinality is invalid for {item['task_id']}")
        if [selection.get("id") for selection in selections] != selected_ids:
            raise ValueError(f"prefetch IDs and selection details differ for {item['task_id']}")
        injected = int(event.get("injected_tokens", 0))
        total = int(event.get("total_injected_tokens", 0))
        if injected < 0 or injected > 900 or total != previous_total + injected or total > 1800:
            raise ValueError(f"prefetch token budget is invalid for {item['task_id']}")
        if any(
            not isinstance(selection.get("score"), int)
            or not isinstance(selection.get("reason"), dict)
            or int(selection.get("tokens", 0)) < 1
            for selection in selections
        ):
            raise ValueError(f"prefetch score/reason/token evidence is incomplete for {item['task_id']}")
        previous_total = total
    if int(memory.get("total_injected_tokens", -1)) != previous_total:
        raise ValueError(f"prefetch trace total differs from metadata for {item['task_id']}")
    return events


def _audit_inputs(
    training_result: dict[str, Any],
    baseline_manifest: dict[str, Any],
    learned_manifest: dict[str, Any],
    baseline: list[dict[str, Any]],
    learned: list[dict[str, Any]],
) -> dict[str, Any]:
    baseline_selection = _selection_keys(baseline_manifest)
    learned_selection = _selection_keys(learned_manifest)
    if not baseline_selection or baseline_selection != learned_selection:
        raise ValueError("baseline and learned selections are missing or differ")
    for label, manifest, trajectories in (
        ("baseline", baseline_manifest, baseline),
        ("learned", learned_manifest, learned),
    ):
        result_keys = {(item["domain"], item["task_id"]) for item in manifest["results"]}
        trajectory_keys = {(item["_domain"], item["task_id"]) for item in trajectories}
        if result_keys != baseline_selection or trajectory_keys != baseline_selection:
            raise ValueError(f"{label} result set does not match its declared small-batch selection")
        if any(item.get("task_completion_pass") is None or item.get("ux_score") is None for item in trajectories):
            raise ValueError(f"{label} contains an unscored trajectory")
        if int(manifest.get("test_write_violations", 0)) != 0:
            raise ValueError(f"{label} recorded a frozen-state write violation")
        if any(int(item.get("attempts", 0)) != 1 for item in manifest["results"]):
            raise ValueError(f"{label} is not a single-attempt Pass@1 run")
        if any(item.get("attempt_errors") for item in manifest["results"]):
            raise ValueError(f"{label} contains attempt errors")

    if baseline_manifest["evaluation_code_fingerprint"] != learned_manifest["evaluation_code_fingerprint"]:
        raise ValueError("baseline and learned evaluation code fingerprints differ")
    if any(int(item.get("prefetch_events", 0)) != 0 for item in baseline):
        raise ValueError("baseline trajectory unexpectedly recorded a memory prefetch")
    for item in learned:
        if int(item.get("prefetch_events", 0)) < 1:
            raise ValueError(f"learned trajectory has no automatic prefetch event: {item['task_id']}")
        if int(item.get("prefetch_injected_tokens", 0)) < 1:
            raise ValueError(f"learned trajectory injected no prefetched memory: {item['task_id']}")
        if not item.get("prefetch_selected_ids"):
            raise ValueError(f"learned trajectory selected no memory IDs: {item['task_id']}")
        _validate_prefetch_trace(item)
    if learned_manifest["artifact_hash_before"] != learned_manifest["artifact_hash_after"]:
        raise ValueError("learned evaluation modified the frozen artifact")
    if learned_manifest["project_variables_hash_before"] != learned_manifest["project_variables_hash_after"]:
        raise ValueError("learned evaluation modified project variables")
    if int(training_result.get("test_write_violations", 0)) != 0:
        raise ValueError("snapshot sanity test recorded a project-variable write")
    return {
        "selected_tasks": len(baseline_selection),
        "task_keys": sorted(f"{domain}:{task_id}" for domain, task_id in baseline_selection),
        "prefetch_verified": True,
        "frozen_state_unchanged": True,
    }


def _items(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and isinstance(value.get("items"), list):
        return value["items"]
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description="Summarize a local Capybara STATE-Bench small-batch round")
    parser.add_argument("--run-tag", required=True)
    args = parser.parse_args()

    config = load_first_round_config()
    run_root = ROOT / "runs" / args.run_tag
    baseline_manifest = json.loads((run_root / "baseline" / "run_manifest.json").read_text(encoding="utf-8"))
    learned_manifest = json.loads((run_root / "learned" / "run_manifest.json").read_text(encoding="utf-8"))
    training_result = json.loads((run_root / "capybara" / "training_result.json").read_text(encoding="utf-8"))
    baseline = _load_trajectories(baseline_manifest)
    learned = _load_trajectories(learned_manifest)
    input_audit = _audit_inputs(training_result, baseline_manifest, learned_manifest, baseline, learned)
    baseline_metrics = _group_metrics(baseline)
    learned_metrics = _group_metrics(learned)
    capybara_repo = resolve_capybara_repo()
    artifact = json.loads((ROOT / learned_manifest["artifact_path"]).read_text(encoding="utf-8"))
    if artifact["snapshot_content_hash"] != learned_manifest["snapshot_content_hash"]:
        raise ValueError("artifact and learned manifest snapshot hashes differ")

    baseline_by_key = {(item["_domain"], item["task_id"]): item for item in baseline}
    learned_by_key = {(item["_domain"], item["task_id"]): item for item in learned}
    comparisons = []
    for domain, task_id in sorted(baseline_by_key):
        before = baseline_by_key[(domain, task_id)]
        after = learned_by_key[(domain, task_id)]
        comparisons.append(
            {
                "domain": domain,
                "task_id": task_id,
                "baseline_pass": before.get("task_completion_pass"),
                "learned_pass": after.get("task_completion_pass"),
                "baseline_ux": before.get("ux_score"),
                "learned_ux": after.get("ux_score"),
                "baseline_total_tokens": before.get("total_tokens"),
                "learned_total_tokens": after.get("total_tokens"),
                "prefetch_events": after.get("prefetch_events", 0),
                "prefetch_injected_tokens": after.get("prefetch_injected_tokens", 0),
                "prefetch_selected_ids": after.get("prefetch_selected_ids", []),
                "prefetch_trace": _validate_prefetch_trace(after),
            }
        )

    improved_tasks = sum(item["baseline_pass"] == 0 and item["learned_pass"] == 1 for item in comparisons)
    regressed_tasks = sum(item["baseline_pass"] == 1 and item["learned_pass"] == 0 for item in comparisons)
    unchanged_tasks = len(comparisons) - improved_tasks - regressed_tasks
    pass_delta = _delta(
        learned_metrics["overall"]["pass_at_1"], baseline_metrics["overall"]["pass_at_1"]
    )
    ux_delta = _delta(
        learned_metrics["overall"]["average_ux"], baseline_metrics["overall"]["average_ux"]
    )
    token_growth = _growth(
        learned_metrics["overall"]["average_total_tokens"],
        baseline_metrics["overall"]["average_total_tokens"],
    )
    wall_time_growth = _growth(
        learned_metrics["overall"]["average_wall_seconds"],
        baseline_metrics["overall"]["average_wall_seconds"],
    )
    correction_attempts = _items(training_result.get("correction_attempts"))
    experiences = _items(training_result.get("experiences"))
    candidate_statuses = dict(sorted(Counter(str(item.get("status", "unknown")) for item in experiences).items()))
    variable_audit = training_result.get("training_variable_audit") or []
    changed_variables = [item for item in variable_audit if item.get("changed")]
    project_file_audit = training_result.get("project_variable_audit") or []
    all_training_cases = _items(training_result.get("cases"))
    training_cases = [item for item in all_training_cases if item.get("phase") == "training"]
    sanity_cases = [item for item in all_training_cases if item.get("phase") == "testing"]
    unresolved_cases = [item for item in training_cases if item.get("status") == "unresolved"]
    write_violations = (
        int(training_result.get("test_write_violations", 0))
        + int(baseline_manifest.get("test_write_violations", 0))
        + int(learned_manifest.get("test_write_violations", 0))
    )
    learned_failed_tasks = [
        f"{item['domain']}:{item['task_id']}"
        for item in comparisons
        if item["learned_pass"] != 1
    ]

    summary = {
        "schema_version": 2,
        "run_tag": args.run_tag,
        "local_non_official": True,
        "official_submission_eligible": False,
        "reason": (
            "GPT-5.4 and protocol-locked prompts used an OpenAI-compatible proxy, "
            "not the official Azure evaluation client."
        ),
        "benchmark_version": config["benchmark_version"],
        "benchmark_commit": config["benchmark_commit"],
        "capybara_commit": git_output(capybara_repo, "rev-parse", "HEAD"),
        "capybara_hook_runner_sha256": sha256_file(
            capybara_repo / "apps" / "backend" / "src" / "core" / "hooks" / "hook-runner.ts"
        ),
        "training_code_fingerprint": training_result["code_fingerprint"],
        "evaluation_code_fingerprint": learned_manifest["evaluation_code_fingerprint"],
        "agent_model": config["agent_model"],
        "simulator_model": config["simulator_model"],
        "judge_model": config["judge_model"],
        "snapshot_content_hash": learned_manifest["snapshot_content_hash"],
        "training_run_id": training_result["run"]["id"],
        "training_selection": training_result.get("training_selection"),
        "evaluation_selection": learned_manifest.get("selection"),
        "baseline": baseline_metrics,
        "learned": learned_metrics,
        "pass_at_1_delta": pass_delta,
        "ux_delta": ux_delta,
        "average_total_tokens_growth": token_growth,
        "average_wall_seconds_growth": wall_time_growth,
        "task_changes": {
            "improved": improved_tasks,
            "regressed": regressed_tasks,
            "unchanged": unchanged_tasks,
        },
        "training_audit": {
            "cases": len(training_cases),
            "sanity_cases": len(sanity_cases),
            "unresolved_cases": [item.get("sampleId") for item in unresolved_cases],
            "correction_attempts": correction_attempts,
            "experience_candidates": experiences,
            "candidate_statuses": candidate_statuses,
            "variable_changes": variable_audit,
            "project_file_variables": project_file_audit,
        },
        "learning_artifact": {
            "release_id": artifact.get("release_id"),
            "entries": artifact["entries"],
            "estimated_tokens": sum(int(entry.get("estimated_tokens", 0)) for entry in artifact["entries"]),
        },
        "test_write_violations": write_violations,
        "audit": {
            **input_audit,
            "baseline_scored": len(baseline),
            "learned_scored": len(learned),
            "baseline_prefetch_events": baseline_metrics["overall"]["prefetch_events"],
            "learned_prefetch_events": learned_metrics["overall"]["prefetch_events"],
            "learned_prefetch_injected_tokens": learned_metrics["overall"]["prefetch_injected_tokens"],
            "learned_prefetch_selected_ids": learned_metrics["overall"]["prefetch_selected_ids"],
            "baseline_single_attempt": all(
                int(item.get("attempts", 0)) == 1 for item in baseline_manifest["results"]
            ),
            "learned_single_attempt": all(
                int(item.get("attempts", 0)) == 1 for item in learned_manifest["results"]
            ),
            "artifact_hash_unchanged": learned_manifest["artifact_hash_before"]
            == learned_manifest["artifact_hash_after"],
            "project_variables_hash_unchanged": learned_manifest["project_variables_hash_before"]
            == learned_manifest["project_variables_hash_after"],
        },
        "comparisons": comparisons,
    }
    summary["small_batch_assessment"] = {
        "pipeline_completed": True,
        "automatic_prefetch_verified": input_audit["prefetch_verified"],
        "frozen_runtime_writes_zero": write_violations == 0,
        "unresolved_training_cases": len(unresolved_cases),
        "regressed_tasks": regressed_tasks,
        "learned_failed_tasks": learned_failed_tasks,
        "decision": (
            "inspect_before_expanding"
            if write_violations != 0 or unresolved_cases or regressed_tasks
            else "small_batch_all_tasks_passed"
            if not learned_failed_tasks
            else "pipeline_verified_with_remaining_task_failures"
        ),
    }

    report_dir = ROOT / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    json_path = report_dir / f"{args.run_tag}.json"
    markdown_path = report_dir / f"{args.run_tag}.md"
    json_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n"
    )

    lines = [
        f"# Capybara STATE-Bench small batch: {args.run_tag}",
        "",
        "> Local, non-official result. GPT-5.6-Luna was the agent model; simulator and judge used "
        "the protocol model names through an OpenAI-compatible proxy.",
        "",
        "## Result",
        "",
        "| Group | Tasks | Pass@1 | UX | Avg tokens | Avg wall | Prefetch events | Injected memory tokens |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for label, metrics in (("Baseline", baseline_metrics["overall"]), ("Frozen learning", learned_metrics["overall"])):
        lines.append(
            f"| {label} | {metrics['tasks']} | {_format_rate(metrics['pass_at_1'])} | "
            f"{_format_number(metrics['average_ux'])} | {_format_number(metrics['average_total_tokens'], 0)} | "
            f"{_format_number(metrics['average_wall_seconds'])}s | {metrics['prefetch_events']} | "
            f"{metrics['prefetch_injected_tokens']} |"
        )
    lines.extend(
        [
            "",
            f"Pass@1 delta: **{'n/a' if pass_delta is None else f'{pass_delta * 100:+.1f} pp'}**.  ",
            f"UX delta: **{'n/a' if ux_delta is None else f'{ux_delta:+.2f}'}**.  ",
            f"Average token growth: **{'n/a' if token_growth is None else f'{token_growth * 100:+.1f}%'}**.  ",
            f"Average wall-time growth: **{'n/a' if wall_time_growth is None else f'{wall_time_growth * 100:+.1f}%'}**.  ",
            f"Task changes: **{improved_tasks} improved, {regressed_tasks} regressed, {unchanged_tasks} unchanged**.  ",
            f"Automatic prefetch: **{learned_metrics['overall']['prefetch_events']} events, "
            f"{learned_metrics['overall']['prefetch_injected_tokens']} injected tokens**.  ",
            f"Frozen-state write violations: **{write_violations}**.",
            "",
            "## Training audit",
            "",
            f"- Training cases: **{len(training_cases)}**",
            f"- Correction attempts: **{len(correction_attempts)}**",
            f"- Unresolved cases: **{len(unresolved_cases)}**",
            f"- Candidate lifecycle: `{json.dumps(candidate_statuses, ensure_ascii=False, sort_keys=True)}`",
            f"- Changed project variables: **{len(changed_variables)}**",
            "",
            "| Variable | Changed | Baseline SHA-256 | Run SHA-256 |",
            "| --- | --- | --- | --- |",
        ]
    )
    for item in variable_audit:
        lines.append(
            f"| `{item['name']}` | {'yes' if item['changed'] else 'no'} | "
            f"`{item['baseline_hash'][:12]}` | `{item['run_hash'][:12]}` |"
        )
    lines.extend(
        [
            "",
            "## Prefetch trace",
            "",
            "| Domain | Task | Events | Injected tokens | Selected IDs |",
            "| --- | --- | ---: | ---: | --- |",
        ]
    )
    for item in comparisons:
        selected = ", ".join(f"`{entry_id}`" for entry_id in item["prefetch_selected_ids"])
        lines.append(
            f"| {item['domain']} | `{item['task_id']}` | {item['prefetch_events']} | "
            f"{item['prefetch_injected_tokens']} | {selected} |"
        )
    lines.extend(
        [
            "",
            "## Task comparison",
            "",
            "| Domain | Task | Baseline | Learned | Baseline UX | Learned UX | Baseline tokens | Learned tokens |",
            "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    for item in comparisons:
        lines.append(
            f"| {item['domain']} | `{item['task_id']}` | {item['baseline_pass']} | {item['learned_pass']} | "
            f"{_format_number(item['baseline_ux'])} | {_format_number(item['learned_ux'])} | "
            f"{item['baseline_total_tokens']} | {item['learned_total_tokens']} |"
        )
    lines.extend(
        [
            "",
            "## Reproducibility",
            "",
            f"- STATE-Bench: `{config['benchmark_version']}` at `{config['benchmark_commit']}`",
            f"- Capybara repository commit: `{summary['capybara_commit']}`",
            f"- Training run: `{summary['training_run_id']}`",
            f"- Frozen snapshot SHA-256: `{summary['snapshot_content_hash']}`",
            f"- Agent: `{config['agent_model']}`; simulator/judge: "
            f"`{config['simulator_model']}` / `{config['judge_model']}`",
            "- Baseline and learned groups used identical declared task selections and evaluation fingerprints.",
            "- The complete correction chain, candidate records, variable values, hashes, and unified diffs are in the JSON report.",
            "",
        ]
    )
    markdown_path.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    print(json.dumps({"json": str(json_path), "markdown": str(markdown_path), "summary": summary}, indent=2))


if __name__ == "__main__":
    main()
