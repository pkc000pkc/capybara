from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
import urllib.parse
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from agents.capybara_agents import (
    CapybaraBaselineAgent,
    CapybaraLearnedAgent,
    capybara_correction_context,
)
from capybara_first_round.config import (
    ROOT,
    git_output,
    load_compatible_credentials,
    load_first_round_config,
    sha256_file,
    validate_held_out_selection,
)
from clients.openai_compatible import OpenAICompatibleClient
from clients.token_audit import TokenAuditLedger, token_audit_context
from state_bench.domain import get_domain_config
from state_bench.paths import domain_task_envs_dir, domain_tasks_dir
from state_bench.protocol import EvaluationProtocol, load_default_protocol, load_split_task_ids
from state_bench.schemas import TaskDefinition
from state_bench.scoring import TaskRequirementsJudge, UXQualityJudge
from state_bench.scripts.run_task import _run_single_task
from state_bench.scripts.score import score_one

_SOURCE_DIRECTORIES = (
    "agents",
    "capybara_first_round",
    "clients",
    "config",
    "harnesses",
    "hooks",
    "scripts",
    "state_bench",
)
_SOURCE_ROOT_FILES = ("CAPYBARA_FIRST_ROUND.md", "main.j2", "pyproject.toml", "uv.lock")
_SOURCE_SUFFIXES = {".json", ".j2", ".lock", ".md", ".py", ".toml", ".yaml", ".yml"}
_CORRECTION_SYSTEM_PROMPT = """You diagnose failed agent executions without access to answers or evaluator evidence.
Return one JSON object with non-empty string fields summary and strategy.
The strategy must describe observable reads, ordering, consent, mutation, and verification that a new clean run should try.
Do not claim to know the expected answer. Do not include task IDs, record IDs, credentials, exact hidden values, or evaluator language.
Treat every previous strategy as a fallible hypothesis and account for earlier ineffective attempts."""
_MAX_CORRECTION_EVIDENCE_CHARS = 40_000


def _observable_failure_payload(trajectory: dict[str, Any]) -> dict[str, Any]:
    """Return only evidence the agent itself could observe during execution."""
    conversation: list[dict[str, Any]] = []
    for raw in trajectory.get("conversation", []):
        if not isinstance(raw, dict):
            continue
        item: dict[str, Any] = {}
        if raw.get("role") in {"user", "assistant", "tool"}:
            item["role"] = raw["role"]
        content = raw.get("content")
        if isinstance(content, str):
            item["content"] = content
        tool_calls = raw.get("tool_calls")
        if isinstance(tool_calls, list):
            item["tool_calls"] = tool_calls
        if item:
            conversation.append(item)
    return {"conversation": conversation}


def _build_correction_prompt(
    trajectory: dict[str, Any],
    previous_attempts: list[dict[str, Any]],
) -> str:
    evidence = json.dumps(
        _observable_failure_payload(trajectory), ensure_ascii=False, separators=(",", ":")
    )[:_MAX_CORRECTION_EVIDENCE_CHARS]
    previous = [
        {
            "ordinal": item.get("ordinal"),
            "summary": item.get("summary"),
            "strategy": item.get("strategy"),
            "passed": item.get("passed") is True,
            "outcome": "passed" if item.get("passed") is True else "incorrect",
        }
        for item in previous_attempts
    ]
    return "\n\n".join(
        [
            "The previous independent execution was marked incorrect. Diagnose the first likely behavioral divergence "
            "using only the observable conversation and tool evidence below.",
            "No expected answer, state assertions, task requirements, Judge rationale, reference, or scoring details "
            "are available. The next run starts from the original clean environment.",
            f"Observable failed execution:\n{evidence}",
            f"Previous sanitized correction outcomes:\n{json.dumps(previous, ensure_ascii=False)}",
        ]
    )


def _parse_correction_proposal(value: Any) -> tuple[str, str]:
    if not isinstance(value, dict):
        raise ValueError("correction model returned a non-object response")
    summary = str(value.get("summary") or "").strip()
    strategy = str(value.get("strategy") or "").strip()
    if not summary or not strategy:
        raise ValueError("correction model omitted summary or strategy")
    return summary, strategy


def _load_correction_attempts(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    value = json.loads(path.read_text(encoding="utf-8"))
    attempts = value.get("attempts") if isinstance(value, dict) else None
    if not isinstance(attempts, list) or not all(isinstance(item, dict) for item in attempts):
        raise ValueError(f"Invalid correction attempt ledger: {path}")
    return attempts


def _source_files(root: Path = ROOT) -> list[Path]:
    paths: list[Path] = []
    for name in _SOURCE_ROOT_FILES:
        path = root / name
        if path.is_file():
            paths.append(path)
    for name in _SOURCE_DIRECTORIES:
        directory = root / name
        if not directory.is_dir():
            continue
        paths.extend(
            path
            for path in directory.rglob("*")
            if path.is_file()
            and path.suffix.lower() in _SOURCE_SUFFIXES
            and "__pycache__" not in path.parts
        )
    return sorted(set(paths), key=lambda path: path.relative_to(root).as_posix())


def _source_inventory(root: Path = ROOT) -> tuple[str, dict[str, dict[str, Any]]]:
    digest = hashlib.sha256()
    inventory: dict[str, dict[str, Any]] = {}
    for path in _source_files(root):
        relative = path.relative_to(root).as_posix()
        content_hash = sha256_file(path)
        inventory[relative] = {"sha256": content_hash, "size": path.stat().st_size}
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content_hash.encode("ascii"))
        digest.update(b"\0")
    return digest.hexdigest(), inventory


def _write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    os.replace(temporary, path)


def lock_evaluation_source(output_root: Path, *, resume: bool, root: Path = ROOT) -> dict[str, Any]:
    """Archive and lock the exact source/data inputs used by a run tag."""
    fingerprint, inventory = _source_inventory(root)
    manifest_path = output_root / "evaluation_source_manifest.json"
    archive_path = output_root / "evaluation_source_snapshot.zip"
    if manifest_path.is_file():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if existing.get("fingerprint") != fingerprint:
            raise RuntimeError(
                "Evaluation source changed since this run tag was created; use a new run tag instead of resuming"
            )
        source_only_names = {manifest_path.name, archive_path.name}
        has_runtime_state = any(path.name not in source_only_names for path in output_root.iterdir())
        if not resume and has_runtime_state:
            raise RuntimeError(f"Run tag already exists; pass --resume or choose a new run tag: {output_root}")
        return existing

    if resume and any(output_root.iterdir()):
        raise RuntimeError(
            f"Cannot safely resume legacy output without an evaluation source manifest: {output_root}"
        )

    temporary_archive = archive_path.with_name(f".{archive_path.name}.{os.getpid()}.tmp")
    with zipfile.ZipFile(temporary_archive, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in _source_files(root):
            archive.write(path, path.relative_to(root).as_posix())
    os.replace(temporary_archive, archive_path)
    metadata = {
        "schema_version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "fingerprint": fingerprint,
        "archive_path": archive_path.relative_to(root).as_posix(),
        "archive_sha256": sha256_file(archive_path),
        "git_head": git_output(root, "rev-parse", "HEAD"),
        "git_status": git_output(root, "status", "--short"),
        "files": inventory,
    }
    _write_json_atomic(manifest_path, metadata)
    return metadata


def _prefetch_events(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    memory = trajectory.get("memory_prefetch") or (trajectory.get("metadata") or {}).get("memory_prefetch") or {}
    events = memory.get("events") or []
    return events if isinstance(events, list) else []


def selected_domains(value: str, config: dict[str, Any]) -> list[str]:
    requested = [item.strip() for item in value.split(",") if item.strip()]
    unknown = [item for item in requested if item not in config["domains"]]
    if unknown:
        raise ValueError(f"Unknown STATE-Bench domain(s): {', '.join(unknown)}")
    if not requested:
        raise ValueError("At least one STATE-Bench domain is required")
    return list(dict.fromkeys(requested))


def selected_task_ids(domain: str, tasks_per_domain: int, protocol: EvaluationProtocol) -> list[str]:
    task_ids = load_split_task_ids(domain, protocol.split, protocol.split_version)
    if tasks_per_domain < 1 or tasks_per_domain > len(task_ids):
        raise ValueError(
            f"tasks_per_domain for {domain} must be between 1 and {len(task_ids)}, got {tasks_per_domain}"
        )
    return task_ids[:tasks_per_domain]


def _load_trajectory(path: Path, *, task_id: str, learned: bool) -> tuple[dict[str, Any] | None, str | None]:
    if not path.is_file():
        return None, None
    try:
        trajectory = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return None, f"Invalid existing trajectory: {type(exc).__name__}: {exc}"
    if trajectory.get("task_id") != task_id:
        return None, f"Existing trajectory task mismatch: expected {task_id}, got {trajectory.get('task_id')}"
    if not isinstance(trajectory.get("conversation"), list):
        return None, "Existing trajectory has no conversation"
    if learned and not _prefetch_events(trajectory):
        return None, "Existing learned trajectory has no automatic prefetch events"
    return trajectory, None


def _is_fully_scored(trajectory: dict[str, Any]) -> bool:
    return trajectory.get("task_completion_pass") is not None and trajectory.get("ux_score") is not None


def _augment_trajectory(
    path: Path,
    *,
    group: str,
    config: dict[str, Any],
    snapshot_hash: str | None,
    endpoint: str,
    wall_seconds: float | None,
    token_audit: dict[str, Any] | None = None,
    simulator_model: str | None = None,
    judge_model: str | None = None,
) -> dict[str, Any]:
    trajectory = json.loads(path.read_text(encoding="utf-8"))
    trajectory.update(
        {
            "experiment_group": group,
            "local_evaluation_client": {
                "provider": "openai_compatible_proxy",
                "simulator_model": simulator_model or config["simulator_model"],
                "judge_model": judge_model or config["judge_model"],
                "judge_reasoning_effort": config["judge_reasoning_effort"],
                "endpoint_host": urllib.parse.urlparse(endpoint).netloc,
                "official_submission_eligible": False,
            },
            "benchmark_commit": config["benchmark_commit"],
            "snapshot_content_hash": snapshot_hash,
            **({"wall_seconds": round(wall_seconds, 3)} if wall_seconds is not None else {}),
            **({"all_model_token_usage": token_audit} if token_audit is not None else {}),
        }
    )
    events = _prefetch_events(trajectory)
    trajectory["prefetch_events"] = len(events)
    trajectory["prefetch_injected_tokens"] = sum(int(event.get("injected_tokens", 0)) for event in events)
    trajectory["prefetch_selected_ids"] = sorted(
        {entry_id for event in events for entry_id in event.get("selected_ids", [])}
    )
    path.write_text(
        json.dumps(trajectory, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return trajectory


def _append_checkpoint(path: Path, result: dict[str, Any]) -> None:
    serialized = json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n"
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(serialized)
        handle.flush()
        os.fsync(handle.fileno())


def _prior_results(output_root: Path) -> dict[tuple[str, str, int], dict[str, Any]]:
    results: dict[tuple[str, str, int], dict[str, Any]] = {}
    manifest_path = output_root / "run_manifest.json"
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        for item in manifest.get("results", []):
            results[(str(item.get("domain")), str(item.get("task_id")), int(item.get("run_idx", 1)))] = item
    checkpoint_path = output_root / "results.jsonl"
    if checkpoint_path.is_file():
        for line in checkpoint_path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            results[(str(item.get("domain")), str(item.get("task_id")), int(item.get("run_idx", 1)))] = item
    return results


def _result_from_trajectory(
    trajectory: dict[str, Any],
    *,
    domain: str,
    task_id: str,
    run_idx: int,
    output_path: Path,
    token_audit: dict[str, Any] | None,
    wall_seconds: float | None,
    reused_existing: bool,
    resumed_scoring: bool,
    interaction_attempts: int,
    scoring_attempts: int,
    interaction_errors: list[str],
    scoring_errors: list[str],
    prior_validation_error: str | None,
) -> dict[str, Any]:
    return {
        "domain": domain,
        "task_id": task_id,
        "run_idx": run_idx,
        "status": "OK",
        "output_path": output_path.relative_to(ROOT).as_posix(),
        "task_completion_pass": trajectory.get("task_completion_pass"),
        "ux_score": trajectory.get("ux_score"),
        "prefetch_events": trajectory.get("prefetch_events", len(_prefetch_events(trajectory))),
        "prefetch_injected_tokens": trajectory.get("prefetch_injected_tokens", 0),
        "prefetch_selected_ids": trajectory.get("prefetch_selected_ids", []),
        "attempts": interaction_attempts,
        "scoring_attempts": scoring_attempts,
        "attempt_errors": interaction_errors,
        "scoring_errors": scoring_errors,
        "prior_validation_error": prior_validation_error,
        "wall_seconds": wall_seconds,
        "all_model_token_usage": token_audit,
        "reused_existing": reused_existing,
        "resumed_scoring": resumed_scoring,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run local full-test STATE-Bench evaluation with frozen learning")
    parser.add_argument("--group", choices=["baseline", "learned"], required=True)
    parser.add_argument("--run-tag", required=True)
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--retry-attempts", type=int, default=2)
    parser.add_argument(
        "--correction-attempts",
        type=int,
        default=4,
        help="Sanitized clean-run attempts for a failed first result (0 disables; otherwise 3-5)",
    )
    parser.add_argument(
        "--resume",
        "--reuse-existing",
        dest="resume",
        action="store_true",
        help="Resume the same source-locked run, reusing interactions and rescoring incomplete trajectories",
    )
    parser.add_argument(
        "--domains",
        default="travel,customer_support,shopping_assistant",
        help="Comma-separated protocol domains (default: all three)",
    )
    parser.add_argument(
        "--tasks-per-domain",
        type=int,
        default=None,
        help="Test tasks per domain (default: all 50)",
    )
    parser.add_argument(
        "--num-runs",
        type=int,
        default=None,
        help="Runs per task (default: protocol value, currently 5)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and source-lock the run plan without constructing clients or making model calls",
    )
    args = parser.parse_args()
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    if args.retry_attempts < 1:
        parser.error("--retry-attempts must be at least 1")
    if args.correction_attempts not in {0, 3, 4, 5}:
        parser.error("--correction-attempts must be 0 or between 3 and 5")

    load_dotenv(ROOT / ".env")
    config = load_first_round_config()
    validate_held_out_selection(config)
    protocol = load_default_protocol()
    protocol_errors = protocol.validate_prompt_hashes()
    if protocol_errors:
        raise RuntimeError("Protocol prompt validation failed:\n" + "\n".join(protocol_errors))
    domains = selected_domains(args.domains, config)
    invalid_protocol_domains = sorted(set(domains) - set(protocol.domains))
    if invalid_protocol_domains:
        parser.error(f"Domains not in locked protocol: {', '.join(invalid_protocol_domains)}")
    tasks_per_domain = args.tasks_per_domain or len(
        load_split_task_ids(domains[0], protocol.split, protocol.split_version)
    )
    num_runs = args.num_runs or protocol.num_runs
    if num_runs < 1 or num_runs > protocol.num_runs:
        parser.error(f"--num-runs must be between 1 and protocol limit {protocol.num_runs}")

    selected_tasks = {domain: selected_task_ids(domain, tasks_per_domain, protocol) for domain in domains}
    for domain, task_ids in selected_tasks.items():
        for task_id in task_ids:
            TaskDefinition.load(domain_tasks_dir(domain) / f"{task_id}.json")
            env_path = domain_task_envs_dir(domain) / f"{task_id}.json"
            if not env_path.is_file():
                raise FileNotFoundError(f"Missing test environment: {env_path}")

    artifact_path = args.artifact.resolve() if args.artifact else None
    if args.group == "learned":
        if artifact_path is None or not artifact_path.is_file():
            parser.error("--artifact is required for the learned group")
        os.environ["CAPYBARA_LEARNINGS_PATH"] = str(artifact_path)
    else:
        os.environ.pop("CAPYBARA_LEARNINGS_PATH", None)
    artifact_hash_before = sha256_file(artifact_path) if artifact_path else None
    artifact = json.loads(artifact_path.read_text(encoding="utf-8")) if artifact_path else None
    if artifact is not None:
        if artifact.get("read_only") is not True:
            raise ValueError("Evaluation artifact must declare read_only=true")
        if not isinstance(artifact.get("entries"), list) or not artifact["entries"]:
            raise ValueError("Evaluation artifact has no frozen memory entries")
    snapshot_hash = artifact.get("snapshot_content_hash") if artifact else None
    project_variables = ROOT / ".capybara" / "system-variables.json"
    project_variables_hash_before = sha256_file(project_variables)
    base_url, api_key, resolved_agent_model = load_compatible_credentials()
    if not base_url or not api_key or not resolved_agent_model:
        raise ValueError("OpenAI-compatible credentials or agent model are incomplete")
    simulator_model = os.environ.get("STATE_BENCH_COMPAT_SIMULATOR_MODEL", config["simulator_model"]).strip()
    eval_model = os.environ.get("STATE_BENCH_COMPAT_EVAL_MODEL", config["judge_model"]).strip()

    output_root = ROOT / "runs" / args.run_tag / args.group
    output_root.mkdir(parents=True, exist_ok=True)
    source_snapshot = lock_evaluation_source(output_root, resume=args.resume)
    total_trajectories = len(domains) * tasks_per_domain * num_runs
    if args.dry_run:
        print(
            json.dumps(
                {
                    "status": "READY",
                    "run_tag": args.run_tag,
                    "group": args.group,
                    "domains": domains,
                    "tasks_per_domain": tasks_per_domain,
                    "num_runs": num_runs,
                    "total_trajectories": total_trajectories,
                    "workers": args.workers,
                    "correction_attempts": args.correction_attempts,
                    "prefetch_top_k": config["prefetch_top_k"],
                    "agent_model": resolved_agent_model,
                    "simulator_model": simulator_model,
                    "judge_model": eval_model,
                    "endpoint_host": urllib.parse.urlparse(base_url).netloc,
                    "source_fingerprint": source_snapshot["fingerprint"],
                    "model_calls": 0,
                },
                indent=2,
            )
        )
        return

    token_ledger = TokenAuditLedger(output_root / "token_usage.jsonl")
    agent_client = OpenAICompatibleClient.from_env(audit_ledger=token_ledger, audit_role="agent")
    simulator_client = OpenAICompatibleClient.for_model(
        simulator_model, audit_ledger=token_ledger, audit_role="simulator"
    )
    task_judge_client = OpenAICompatibleClient.for_model(
        eval_model, audit_ledger=token_ledger, audit_role="task_judge"
    )
    ux_judge_client = OpenAICompatibleClient.for_model(
        eval_model, audit_ledger=token_ledger, audit_role="ux_judge"
    )
    correction_client = OpenAICompatibleClient.for_model(
        resolved_agent_model, audit_ledger=token_ledger, audit_role="correction_hook"
    )
    agent_class = CapybaraBaselineAgent if args.group == "baseline" else CapybaraLearnedAgent
    prior_results = _prior_results(output_root) if args.resume else {}
    started_at = datetime.now(UTC)
    all_results: list[dict[str, Any]] = []
    checkpoint_path = output_root / "results.jsonl"

    for domain_name in domains:
        domain = get_domain_config(domain_name)
        tasks = [
            TaskDefinition.load(domain_tasks_dir(domain_name) / f"{task_id}.json")
            for task_id in selected_tasks[domain_name]
        ]
        task_judge = TaskRequirementsJudge(
            client=task_judge_client,
            prompts_dir=domain.prompts_dir,
            system_prompt=domain.judge_system_prompt,
            reasoning_effort=config["judge_reasoning_effort"],
        )
        ux_judge = UXQualityJudge(
            client=ux_judge_client,
            prompts_dir=domain.prompts_dir,
            system_prompt=domain.judge_system_prompt,
            reasoning_effort=config["judge_reasoning_effort"],
        )

        def run_corrections(
            task: TaskDefinition,
            run_idx: int,
            official_trajectory: dict[str, Any],
            result: dict[str, Any],
        ) -> dict[str, Any]:
            first_pass = official_trajectory.get("task_completion_pass") == 1
            if first_pass:
                return {
                    **result,
                    "official_pass_at_1": 1,
                    "pass_after_correction": True,
                    "correction_status": "not_needed",
                    "correction_attempt_count": 0,
                    "correction_attempts": [],
                }
            if args.correction_attempts == 0:
                return {
                    **result,
                    "official_pass_at_1": 0,
                    "pass_after_correction": False,
                    "correction_status": "disabled",
                    "correction_attempt_count": 0,
                    "correction_attempts": [],
                }

            correction_root = output_root / "corrections" / domain_name / f"run{run_idx}" / task.task_id
            correction_root.mkdir(parents=True, exist_ok=True)
            attempts_path = correction_root / "attempts.json"
            attempts = _load_correction_attempts(attempts_path) if args.resume else []
            failed_trajectory = official_trajectory
            for previous in attempts:
                if previous.get("passed") is True:
                    return {
                        **result,
                        "official_pass_at_1": 0,
                        "pass_after_correction": True,
                        "correction_status": "recovered",
                        "correction_attempt_count": len(attempts),
                        "correction_attempts": attempts,
                    }
                previous_path = previous.get("output_path")
                if isinstance(previous_path, str):
                    loaded, _error = _load_trajectory(
                        ROOT / previous_path, task_id=task.task_id, learned=args.group == "learned"
                    )
                    if loaded is not None and _is_fully_scored(loaded):
                        failed_trajectory = loaded

            for ordinal in range(len(attempts) + 1, args.correction_attempts + 1):
                attempt_started = time.monotonic()
                attempt_dir = correction_root / f"attempt{ordinal}"
                attempt_dir.mkdir(parents=True, exist_ok=True)
                attempt_output = attempt_dir / f"{task.task_id}.json"
                attempt: dict[str, Any] = {
                    "ordinal": ordinal,
                    "status": "ERR",
                    "passed": False,
                    "source_outcome": "incorrect",
                    "output_path": attempt_output.relative_to(ROOT).as_posix(),
                }
                try:
                    with token_audit_context(
                        run_tag=args.run_tag,
                        group=args.group,
                        domain=domain_name,
                        task_id=task.task_id,
                        run_idx=run_idx,
                        phase="correction_hook",
                        correction_attempt=ordinal,
                    ):
                        proposal = correction_client.complete_json(
                            prompt=_build_correction_prompt(failed_trajectory, attempts),
                            system_prompt=_CORRECTION_SYSTEM_PROMPT,
                            max_tokens=3500,
                            reasoning_effort=config["agent_reasoning_effort"],
                        )
                    summary, strategy = _parse_correction_proposal(proposal)
                    if task.task_id.lower() in f"{summary}\n{strategy}".lower():
                        raise ValueError("correction strategy included the hidden benchmark task ID")
                    attempt.update({"summary": summary, "strategy": strategy})
                except Exception as exc:
                    attempt.update(
                        {
                            "terminal_reason": "hook_error",
                            "error": f"{type(exc).__name__}: {exc}",
                            "wall_seconds": round(time.monotonic() - attempt_started, 3),
                            "hook_token_usage": token_ledger.summarize(
                                run_tag=args.run_tag,
                                group=args.group,
                                domain=domain_name,
                                task_id=task.task_id,
                                run_idx=run_idx,
                                phase="correction_hook",
                                correction_attempt=ordinal,
                            ),
                        }
                    )
                    attempts.append(attempt)
                    _write_json_atomic(attempts_path, {"schema_version": 1, "attempts": attempts})
                    continue

                interaction_errors: list[str] = []
                correction_trajectory: dict[str, Any] | None = None
                for technical_attempt in range(1, args.retry_attempts + 1):
                    try:
                        with token_audit_context(
                            run_tag=args.run_tag,
                            group=args.group,
                            domain=domain_name,
                            task_id=task.task_id,
                            run_idx=run_idx,
                            phase="correction_interaction",
                            correction_attempt=ordinal,
                            technical_attempt=technical_attempt,
                        ), capybara_correction_context(strategy):
                            interaction_result = _run_single_task(
                                task,
                                run_idx,
                                None,
                                agent_client,
                                simulator_client,
                                domain,
                                attempt_dir,
                                protocol=protocol,
                                agent_model={
                                    "model_name": resolved_agent_model,
                                    "reasoning_level": config["agent_reasoning_effort"],
                                },
                                agent_class=agent_class,
                                retrieve_learnings_top_k=int(config["prefetch_top_k"]),
                                agent_reasoning_effort=config["agent_reasoning_effort"],
                                task_requirements_judge=None,
                                ux_judge=None,
                            )
                    except Exception as exc:
                        interaction_result = {"status": "ERR", "error": f"{type(exc).__name__}: {exc}"}
                    if interaction_result.get("status") == "OK":
                        correction_trajectory, validation_error = _load_trajectory(
                            attempt_output, task_id=task.task_id, learned=args.group == "learned"
                        )
                        if correction_trajectory is not None:
                            break
                        interaction_result = {"status": "ERR", "error": validation_error or "missing trajectory"}
                    interaction_errors.append(str(interaction_result.get("error", "unknown interaction error")))

                scoring_errors: list[str] = []
                scoring_attempts = 0
                if correction_trajectory is not None:
                    for scoring_attempt in range(1, args.retry_attempts + 1):
                        scoring_attempts = scoring_attempt
                        try:
                            with token_audit_context(
                                run_tag=args.run_tag,
                                group=args.group,
                                domain=domain_name,
                                task_id=task.task_id,
                                run_idx=run_idx,
                                phase="correction_scoring",
                                correction_attempt=ordinal,
                                scoring_attempt=scoring_attempt,
                            ):
                                scoring_result = score_one(
                                    attempt_output,
                                    domain_tasks_dir(domain_name),
                                    task_judge,
                                    ux_judge,
                                    attempt_output,
                                    protocol,
                                    domain_name,
                                )
                        except Exception as exc:
                            scoring_result = {"status": "ERR", "error": f"{type(exc).__name__}: {exc}"}
                        correction_trajectory, validation_error = _load_trajectory(
                            attempt_output, task_id=task.task_id, learned=args.group == "learned"
                        )
                        if (
                            scoring_result.get("status") == "OK"
                            and correction_trajectory is not None
                            and _is_fully_scored(correction_trajectory)
                        ):
                            break
                        scoring_errors.append(
                            str(scoring_result.get("error") or validation_error or "incomplete correction score")
                        )

                if correction_trajectory is not None and _is_fully_scored(correction_trajectory):
                    attempt_usage = token_ledger.summarize(
                        run_tag=args.run_tag,
                        group=args.group,
                        domain=domain_name,
                        task_id=task.task_id,
                        run_idx=run_idx,
                        correction_attempt=ordinal,
                    )
                    correction_trajectory = _augment_trajectory(
                        attempt_output,
                        group=f"{args.group}_correction",
                        config=config,
                        snapshot_hash=snapshot_hash,
                        endpoint=agent_client.endpoint,
                        wall_seconds=time.monotonic() - attempt_started,
                        token_audit=attempt_usage,
                        simulator_model=simulator_model,
                        judge_model=eval_model,
                    )
                    passed = correction_trajectory.get("task_completion_pass") == 1
                    attempt.update(
                        {
                            "status": "OK",
                            "passed": passed,
                            "task_completion_pass": correction_trajectory.get("task_completion_pass"),
                            "ux_score": correction_trajectory.get("ux_score"),
                            "interaction_errors": interaction_errors,
                            "scoring_attempts": scoring_attempts,
                            "scoring_errors": scoring_errors,
                            "token_usage": attempt_usage,
                            "hook_token_usage": token_ledger.summarize(
                                run_tag=args.run_tag,
                                group=args.group,
                                domain=domain_name,
                                task_id=task.task_id,
                                run_idx=run_idx,
                                phase="correction_hook",
                                correction_attempt=ordinal,
                            ),
                            "terminal_reason": "succeeded" if passed else (
                                "max_attempts" if ordinal == args.correction_attempts else "incorrect"
                            ),
                            "wall_seconds": round(time.monotonic() - attempt_started, 3),
                        }
                    )
                    failed_trajectory = correction_trajectory
                else:
                    attempt.update(
                        {
                            "terminal_reason": "execution_error" if correction_trajectory is None else "scoring_error",
                            "interaction_errors": interaction_errors,
                            "scoring_attempts": scoring_attempts,
                            "scoring_errors": scoring_errors,
                            "wall_seconds": round(time.monotonic() - attempt_started, 3),
                        }
                    )
                attempts.append(attempt)
                _write_json_atomic(attempts_path, {"schema_version": 1, "attempts": attempts})
                if attempt.get("passed") is True:
                    break

            recovered = any(item.get("passed") is True for item in attempts)
            return {
                **result,
                "official_pass_at_1": 0,
                "pass_after_correction": recovered,
                "correction_status": "recovered" if recovered else "unresolved",
                "correction_attempt_count": len(attempts),
                "correction_attempts": attempts,
            }

        def run_one(task: TaskDefinition, run_idx: int) -> dict[str, Any]:
            task_started = time.monotonic()
            run_dir = output_root / domain_name / f"run{run_idx}"
            run_dir.mkdir(parents=True, exist_ok=True)
            output_path = run_dir / f"{task.task_id}.json"
            prior = prior_results.get((domain_name, task.task_id, run_idx), {})
            prior_validation_error: str | None = None
            trajectory: dict[str, Any] | None = None
            if args.resume:
                trajectory, prior_validation_error = _load_trajectory(
                    output_path, task_id=task.task_id, learned=args.group == "learned"
                )

            if trajectory is not None and _is_fully_scored(trajectory):
                existing_wall = trajectory.get("wall_seconds")
                wall_seconds = float(existing_wall) if isinstance(existing_wall, (int, float)) else None
                task_audit = token_ledger.summarize(
                    run_tag=args.run_tag,
                    group=args.group,
                    domain=domain_name,
                    task_id=task.task_id,
                    run_idx=run_idx,
                )
                if task_audit["requests"] == 0:
                    task_audit = trajectory.get("all_model_token_usage") or prior.get("all_model_token_usage")
                trajectory = _augment_trajectory(
                    output_path,
                    group=args.group,
                    config=config,
                    snapshot_hash=snapshot_hash,
                    endpoint=agent_client.endpoint,
                    wall_seconds=wall_seconds,
                    token_audit=task_audit,
                    simulator_model=simulator_model,
                    judge_model=eval_model,
                )
                result = _result_from_trajectory(
                    trajectory,
                    domain=domain_name,
                    task_id=task.task_id,
                    run_idx=run_idx,
                    output_path=output_path,
                    token_audit=task_audit,
                    wall_seconds=wall_seconds,
                    reused_existing=True,
                    resumed_scoring=False,
                    interaction_attempts=int(prior.get("attempts", 0)),
                    scoring_attempts=int(prior.get("scoring_attempts", 0)),
                    interaction_errors=list(prior.get("attempt_errors", [])),
                    scoring_errors=list(prior.get("scoring_errors", [])),
                    prior_validation_error=prior_validation_error,
                )
                return run_corrections(task, run_idx, trajectory, result)

            resumed_scoring = trajectory is not None
            interaction_errors: list[str] = []
            interaction_attempts = 0
            if trajectory is None:
                for attempt in range(1, args.retry_attempts + 1):
                    interaction_attempts = attempt
                    try:
                        with token_audit_context(
                            run_tag=args.run_tag,
                            group=args.group,
                            domain=domain_name,
                            task_id=task.task_id,
                            run_idx=run_idx,
                            phase="interaction",
                            task_attempt=attempt,
                        ):
                            interaction_result = _run_single_task(
                                task,
                                run_idx,
                                None,
                                agent_client,
                                simulator_client,
                                domain,
                                run_dir,
                                protocol=protocol,
                                agent_model={
                                    "model_name": resolved_agent_model,
                                    "reasoning_level": config["agent_reasoning_effort"],
                                },
                                agent_class=agent_class,
                                retrieve_learnings_top_k=int(config["prefetch_top_k"]),
                                agent_reasoning_effort=config["agent_reasoning_effort"],
                                task_requirements_judge=None,
                                ux_judge=None,
                            )
                    except Exception as exc:
                        interaction_result = {"status": "ERR", "error": f"{type(exc).__name__}: {exc}"}
                    if interaction_result.get("status") == "OK":
                        trajectory, validation_error = _load_trajectory(
                            output_path, task_id=task.task_id, learned=args.group == "learned"
                        )
                        if trajectory is not None:
                            break
                        interaction_result = {"status": "ERR", "error": validation_error or "missing trajectory"}
                    interaction_errors.append(str(interaction_result.get("error", "unknown interaction error")))

            if trajectory is None:
                task_audit = token_ledger.summarize(
                    run_tag=args.run_tag,
                    group=args.group,
                    domain=domain_name,
                    task_id=task.task_id,
                    run_idx=run_idx,
                )
                return {
                    "domain": domain_name,
                    "task_id": task.task_id,
                    "run_idx": run_idx,
                    "status": "ERR",
                    "error": interaction_errors[-1] if interaction_errors else prior_validation_error,
                    "attempts": interaction_attempts,
                    "attempt_errors": interaction_errors,
                    "scoring_attempts": 0,
                    "scoring_errors": [],
                    "prior_validation_error": prior_validation_error,
                    "wall_seconds": round(time.monotonic() - task_started, 3),
                    "all_model_token_usage": task_audit,
                }

            scoring_errors: list[str] = []
            scoring_attempts = 0
            for scoring_attempt in range(1, args.retry_attempts + 1):
                scoring_attempts = scoring_attempt
                try:
                    with token_audit_context(
                        run_tag=args.run_tag,
                        group=args.group,
                        domain=domain_name,
                        task_id=task.task_id,
                        run_idx=run_idx,
                        phase="scoring",
                        scoring_attempt=scoring_attempt,
                    ):
                        scoring_result = score_one(
                            output_path,
                            domain_tasks_dir(domain_name),
                            task_judge,
                            ux_judge,
                            output_path,
                            protocol,
                            domain_name,
                        )
                except Exception as exc:
                    scoring_result = {"status": "ERR", "error": f"{type(exc).__name__}: {exc}"}
                trajectory, validation_error = _load_trajectory(
                    output_path, task_id=task.task_id, learned=args.group == "learned"
                )
                if scoring_result.get("status") == "OK" and trajectory is not None and _is_fully_scored(trajectory):
                    break
                error = scoring_result.get("error") or validation_error or "scoring did not produce complete scores"
                scoring_errors.append(str(error))

            wall_seconds = time.monotonic() - task_started
            task_audit = token_ledger.summarize(
                run_tag=args.run_tag,
                group=args.group,
                domain=domain_name,
                task_id=task.task_id,
                run_idx=run_idx,
            )
            if trajectory is None or not _is_fully_scored(trajectory):
                return {
                    "domain": domain_name,
                    "task_id": task.task_id,
                    "run_idx": run_idx,
                    "status": "ERR",
                    "error": scoring_errors[-1] if scoring_errors else "trajectory is not fully scored",
                    "attempts": interaction_attempts,
                    "attempt_errors": interaction_errors,
                    "scoring_attempts": scoring_attempts,
                    "scoring_errors": scoring_errors,
                    "prior_validation_error": prior_validation_error,
                    "wall_seconds": round(wall_seconds, 3),
                    "all_model_token_usage": task_audit,
                    "resumed_scoring": resumed_scoring,
                }

            trajectory = _augment_trajectory(
                output_path,
                group=args.group,
                config=config,
                snapshot_hash=snapshot_hash,
                endpoint=agent_client.endpoint,
                wall_seconds=wall_seconds,
                token_audit=task_audit,
                simulator_model=simulator_model,
                judge_model=eval_model,
            )
            result = _result_from_trajectory(
                trajectory,
                domain=domain_name,
                task_id=task.task_id,
                run_idx=run_idx,
                output_path=output_path,
                token_audit=task_audit,
                wall_seconds=round(wall_seconds, 3),
                reused_existing=False,
                resumed_scoring=resumed_scoring,
                interaction_attempts=interaction_attempts,
                scoring_attempts=scoring_attempts,
                interaction_errors=interaction_errors,
                scoring_errors=scoring_errors,
                prior_validation_error=prior_validation_error,
            )
            return run_corrections(task, run_idx, trajectory, result)

        work_items = [(task, run_idx) for run_idx in range(1, num_runs + 1) for task in tasks]
        with ThreadPoolExecutor(max_workers=min(args.workers, len(work_items))) as executor:
            futures = {executor.submit(run_one, task, run_idx): (task.task_id, run_idx) for task, run_idx in work_items}
            for future in as_completed(futures):
                task_id, run_idx = futures[future]
                try:
                    result = future.result()
                except Exception as exc:
                    result = {
                        "domain": domain_name,
                        "task_id": task_id,
                        "run_idx": run_idx,
                        "status": "ERR",
                        "error": f"Unexpected worker failure: {type(exc).__name__}: {exc}",
                    }
                all_results.append(result)
                _append_checkpoint(checkpoint_path, result)
                print(
                    json.dumps(
                        {
                            "group": args.group,
                            "domain": domain_name,
                            "task": result.get("task_id"),
                            "run": result.get("run_idx"),
                            "status": result.get("status"),
                            "pass": result.get("task_completion_pass"),
                            "pass_after_correction": result.get("pass_after_correction"),
                            "correction_attempts": result.get("correction_attempt_count", 0),
                            "ux": result.get("ux_score"),
                            "reused": result.get("reused_existing", False),
                            "resumed_scoring": result.get("resumed_scoring", False),
                            "all_model_tokens": (result.get("all_model_token_usage") or {}).get("total_tokens"),
                        },
                        ensure_ascii=False,
                    )
                )

    artifact_hash_after = sha256_file(artifact_path) if artifact_path else None
    project_variables_hash_after = sha256_file(project_variables)
    source_fingerprint_after, _inventory_after = _source_inventory(ROOT)
    finished_at = datetime.now(UTC)
    token_audit_summary = token_ledger.summarize(run_tag=args.run_tag, group=args.group)
    failed_at_pass_1 = [item for item in all_results if item.get("task_completion_pass") == 0]
    recovered_after_correction = [
        item for item in failed_at_pass_1 if item.get("pass_after_correction") is True
    ]
    manifest = {
        "schema_version": 3,
        "run_tag": args.run_tag,
        "group": args.group,
        "started_at": started_at.isoformat(),
        "finished_at": finished_at.isoformat(),
        "duration_seconds": round((finished_at - started_at).total_seconds(), 3),
        "benchmark_commit": git_output(ROOT, "rev-parse", "HEAD"),
        "evaluation_source": {
            "fingerprint": source_snapshot["fingerprint"],
            "fingerprint_after": source_fingerprint_after,
            "changed_during_run": source_snapshot["fingerprint"] != source_fingerprint_after,
            "archive_path": source_snapshot["archive_path"],
            "archive_sha256": source_snapshot["archive_sha256"],
        },
        "agent_model": resolved_agent_model,
        "agent_reasoning_effort": config["agent_reasoning_effort"],
        "simulator_model": simulator_model,
        "judge_model": eval_model,
        "judge_reasoning_effort": config["judge_reasoning_effort"],
        "evaluation_client": "openai_compatible_proxy",
        "official_submission_eligible": False,
        "token_audit": token_audit_summary,
        "workers": args.workers,
        "retry_attempts": args.retry_attempts,
        "correction": {
            "enabled": args.correction_attempts > 0,
            "max_attempts": args.correction_attempts,
            "failure_evidence": "observable_conversation_and_tool_calls_only",
            "judge_evidence_exposed": False,
            "official_pass_at_1_unchanged": True,
            "failed_at_pass_1": len(failed_at_pass_1),
            "recovered": len(recovered_after_correction),
            "unresolved": len(failed_at_pass_1) - len(recovered_after_correction),
            "attempts": sum(int(item.get("correction_attempt_count", 0)) for item in all_results),
        },
        "resumed": args.resume,
        "selection": {
            "protocol_id": protocol.protocol_id,
            "split": protocol.split,
            "split_version": protocol.split_version,
            "domains": domains,
            "tasks_per_domain": tasks_per_domain,
            "num_runs": num_runs,
            "total_trajectories": total_trajectories,
            "task_ids": selected_tasks,
        },
        "artifact_path": artifact_path.relative_to(ROOT).as_posix() if artifact_path else None,
        "snapshot_content_hash": snapshot_hash,
        "artifact_hash_before": artifact_hash_before,
        "artifact_hash_after": artifact_hash_after,
        "project_variables_hash_before": project_variables_hash_before,
        "project_variables_hash_after": project_variables_hash_after,
        "test_write_violations": int(
            artifact_hash_before != artifact_hash_after or project_variables_hash_before != project_variables_hash_after
        ),
        "results": sorted(all_results, key=lambda item: (item["domain"], item["run_idx"], item["task_id"])),
    }
    manifest_path = output_root / "run_manifest.json"
    _write_json_atomic(manifest_path, manifest)

    failures = [item for item in all_results if item.get("status") != "OK"]
    if len(all_results) != total_trajectories:
        raise RuntimeError(f"Expected {total_trajectories} results, got {len(all_results)}; see {manifest_path}")
    if failures:
        raise RuntimeError(f"{len(failures)} trajectory(s) failed; resume with --resume after inspection: {manifest_path}")
    if any(item.get("task_completion_pass") is None or item.get("ux_score") is None for item in all_results):
        raise RuntimeError(f"One or more trajectories are missing required scores: {manifest_path}")
    if args.group == "learned" and any(int(item.get("prefetch_events", 0)) < 1 for item in all_results):
        raise RuntimeError(f"Learned evaluation contains a trajectory without automatic prefetch: {manifest_path}")
    if args.group == "learned" and manifest["test_write_violations"] != 0:
        raise RuntimeError("Frozen evaluation modified the artifact or project variables")
    if manifest["evaluation_source"]["changed_during_run"]:
        raise RuntimeError("Evaluation source changed while the run was in progress")
    print(
        json.dumps(
            {
                "manifest": str(manifest_path),
                "trajectories": len(all_results),
                "token_ledger": str(token_ledger.path),
                "total_tokens": token_audit_summary["total_tokens"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
