from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
FIRST_ROUND_CONFIG = ROOT / "config" / "capybara_first_round.json"


def load_first_round_config() -> dict[str, Any]:
    return json.loads(FIRST_ROUND_CONFIG.read_text(encoding="utf-8"))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_output(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def resolve_source_project() -> Path:
    configured = os.environ.get("CAPYBARA_SOURCE_PROJECT")
    if configured:
        return Path(configured).expanduser().resolve()
    return (ROOT.parent / "test-project").resolve()


def resolve_capybara_repo() -> Path:
    configured = os.environ.get("CAPYBARA_MAIN_REPO")
    if configured:
        return Path(configured).expanduser().resolve()
    return (ROOT.parents[1] / "capybara-github" / "capybara").resolve()


def load_compatible_credentials() -> tuple[str, str, str]:
    base_url = os.environ.get("STATE_BENCH_COMPAT_BASE_URL", "").strip()
    api_key = os.environ.get("STATE_BENCH_COMPAT_API_KEY", "").strip()
    model = os.environ.get("STATE_BENCH_COMPAT_AGENT_MODEL", "").strip()
    if base_url and api_key:
        return base_url.rstrip("/"), api_key, model or "gpt-5.6-luna"

    source = resolve_source_project()
    config_path = source / ".capybara" / "config.json"
    secrets_path = source / ".capybara" / "secrets.json"
    if not config_path.is_file() or not secrets_path.is_file():
        raise FileNotFoundError(
            f"OpenAI-compatible credentials are not configured and the sibling Capybara project is incomplete: {source}"
        )
    project_config = json.loads(config_path.read_text(encoding="utf-8"))
    secrets = json.loads(secrets_path.read_text(encoding="utf-8"))
    llm = project_config.get("llm") or {}
    secret_llm = secrets.get("llm") or {}
    resolved_base = base_url or str(llm.get("base_url") or "").strip()
    resolved_key = api_key or str(secret_llm.get("api_key") or "").strip()
    configured_model = str(load_first_round_config().get("agent_model") or "").strip()
    resolved_model = model or configured_model
    if not resolved_base or not resolved_key:
        raise ValueError(f"Missing LLM base URL or API key in {source}")
    if not resolved_model:
        raise ValueError("The first-round agent model is not configured")
    return resolved_base.rstrip("/"), resolved_key, resolved_model


def validate_held_out_selection(config: dict[str, Any]) -> None:
    expected_count = int(config["held_out_tasks_per_domain"])
    for domain, domain_config in config["domains"].items():
        selected = list(domain_config["held_out_tasks"])
        if len(selected) != expected_count or len(set(selected)) != expected_count:
            raise ValueError(f"{domain} must define {expected_count} unique held-out tasks")
        split_path = ROOT / "state_bench" / "domains" / domain / "splits" / "train_test.json"
        split = json.loads(split_path.read_text(encoding="utf-8"))["splits"]
        test_ids = set(split["test"])
        invalid = sorted(set(selected) - test_ids)
        if invalid:
            raise ValueError(f"{domain} selection is not held out: {', '.join(invalid)}")
        for task_id in selected:
            task_path = ROOT / "state_bench" / "domains" / domain / "tasks" / f"{task_id}.json"
            env_path = ROOT / "state_bench" / "domains" / domain / "task_envs" / f"{task_id}.json"
            if not task_path.is_file() or not env_path.is_file():
                raise FileNotFoundError(f"Held-out task package is incomplete: {domain}/{task_id}")
