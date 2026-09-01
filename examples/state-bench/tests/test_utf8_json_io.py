from __future__ import annotations

import json

from state_bench.domain import get_domain_config
from state_bench.paths import domain_tasks_dir
from state_bench.schemas import TaskDefinition, Trajectory
from state_bench.scoring import build_task_requirements_prompt, build_ux_prompt


def test_task_definition_loads_utf8_and_trajectory_saves_utf8(tmp_path) -> None:
    source_path = domain_tasks_dir("travel") / "4-strategy_cancel_rebook_cheaper_user_baits_change_state.json"
    task_data = json.loads(source_path.read_text(encoding="utf-8"))
    task_data["task_summary"] += " cancel\u2011and\u2011rebook"
    task_path = tmp_path / "task.json"
    task_path.write_text(json.dumps(task_data, ensure_ascii=False), encoding="utf-8")
    task = TaskDefinition.load(task_path)
    assert "cancel\u2011and\u2011rebook" in task.task_summary

    output_path = tmp_path / "trajectory.json"
    trajectory = Trajectory(
        task_id=task.task_id,
        user_id=task.user_id,
        task_summary=task.task_summary,
        conversation=[{"role": "assistant", "content": "cancel\u2011and\u2011rebook"}],
    )
    trajectory.save(output_path)

    raw = output_path.read_bytes()
    decoded = raw.decode("utf-8")
    assert "cancel\u2011and\u2011rebook" in decoded
    assert json.loads(decoded)["task_summary"] == task.task_summary


def test_shopping_judge_prompts_load_as_utf8_on_windows() -> None:
    domain = get_domain_config("shopping_assistant")
    task = TaskDefinition.load(domain_tasks_dir(domain.name) / "4-brand_bundle_missed.json")
    conversation = [{"role": "user", "content": task.opening_message}]

    task_prompt = build_task_requirements_prompt(task, conversation, [], domain.prompts_dir)
    ux_prompt = build_ux_prompt(task, conversation, [], domain.prompts_dir)

    assert task.task_summary in task_prompt
    assert task.opening_message in ux_prompt
