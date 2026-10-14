"""Offline inherited-pipe ARE admission fixture; no model or Scenario."""
from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import socket
import sys
import warnings

ROOT = Path(__file__).absolute().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))


def deny(*_args, **_kwargs):
    raise RuntimeError("NATIVE_ADMISSION_FIXTURE_NETWORK_FORBIDDEN")


socket.socket.connect = deny
socket.socket.connect_ex = deny
logging.disable(logging.CRITICAL)
warnings.filterwarnings("ignore")


def main():
    import gaia2_a2a_wire as wire
    setup = wire.read_frame(sys.stdin.buffer)
    keys = {"channelId", "bindingHash", "environmentGeneration", "parentExecutionId", "parentSessionId",
            "evidenceRoot", "workerSourceSha256", "nativeSourceSha256", "wireSourceSha256", "mode"}
    modes = {"less", "equal", "after", "ack_extra", "cross_scope", "receipt_changed", "legacy", "old_unknown", "contract_extra", "contract_unit", "positive_missing"}
    if type(setup) is not dict or set(setup) != keys or setup["mode"] not in modes:
        raise RuntimeError("NATIVE_ADMISSION_FIXTURE_SETUP_INVALID")
    sources = ((Path(__file__).absolute(), "workerSourceSha256"),
               (ROOT / "scripts/gaia2_private_native_binding.py", "nativeSourceSha256"),
               (ROOT / "scripts/gaia2_a2a_wire.py", "wireSourceSha256"))
    if any(hashlib.sha256(source.read_bytes()).hexdigest() != setup[key] for source, key in sources):
        raise RuntimeError("NATIVE_ADMISSION_FIXTURE_SOURCE_INVALID")
    if os.environ.get("HF_HUB_OFFLINE") != "1":
        raise RuntimeError("NATIVE_ADMISSION_FIXTURE_OFFLINE_REQUIRED")
    from gaia2_private_native_binding import NativeAppBinding
    from are.simulation.apps.contacts import Contacts, Contact
    from are.simulation.environment import Environment, EnvironmentConfig
    env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
    app = Contacts(contacts={"contact-1": Contact("Old", "Fixture", contact_id="contact-1")})
    env.register_apps([app])
    # ARE checks pause_passed_time by truthiness. Use its real public offset
    # before pause, so equality is deterministic without replacing any clock.
    env.time_manager.add_offset(1)
    env.time_manager.pause()
    root = Path(setup["evidenceRoot"])
    owner = NativeAppBinding(app, environment_generation=setup["environmentGeneration"],
        parent_execution_id=setup["parentExecutionId"], parent_session_id=setup["parentSessionId"],
        evidence_root=root, clock=env.time_manager.time, clock_environment=env,
        deadline_clock_unit="milliseconds" if setup["mode"] == "legacy" else "seconds",
        trusted_source_files=(Path(__file__).absolute(),))
    stopping = False
    commit_calls = 0
    original = owner.handlers()

    def commit(payload):
        nonlocal commit_calls
        commit_calls += 1
        if ((commit_calls == 1 and setup["mode"] not in ("legacy", "old_unknown"))
                or setup["mode"] == "old_unknown" and commit_calls == 2):
            deadline = payload["scope"]["deadline"]
            delta = -1 if setup["mode"] in ("less", "positive_missing") else 0 if setup["mode"] in ("equal", "old_unknown") else 1
            env.time_manager.add_offset(deadline - env.time_manager.time() + delta)
        result = original["commit_native"](payload)
        if setup["mode"] == "ack_extra":
            result = {**result, "nativeBodyStarted": False}
        elif setup["mode"] == "cross_scope":
            result = {**result, "scopeHash": "f" * 64}
        elif setup["mode"] == "receipt_changed":
            target = root / result["refusalEvidenceRef"]["path"]
            with target.open("ab") as output:
                output.write(b" ")
        elif setup["mode"] == "positive_missing":
            target = root / result["dispatchEvidenceRef"]["path"]
            body = json.loads(target.read_text(encoding="utf-8"))
            del body["nativeAdmission"]
            raw = (json.dumps(body, sort_keys=True) + "\n").encode()
            with target.open("wb") as output:
                output.write(raw)
            result["dispatchEvidenceRef"]["sha256"] = hashlib.sha256(raw).hexdigest()
        return result

    def inspect(payload):
        result = original["inspect_app"](payload)
        if setup["mode"] == "contract_extra":
            result["nativeAdmissionDeadline"]["actorControlled"] = True
        elif setup["mode"] == "contract_unit":
            result["nativeAdmissionDeadline"]["unit"] = "milliseconds"
        return result

    def clock(payload):
        if payload is not None:
            raise RuntimeError("NATIVE_ADMISSION_FIXTURE_CLOCK_INVALID")
        return {"now": env.time_manager.time()}

    def state(payload):
        if payload is not None:
            raise RuntimeError("NATIVE_ADMISSION_FIXTURE_STATE_INVALID")
        return {"commitCalls": commit_calls, "nativeEvents": len(env.event_log),
                "contactChanged": app.contacts["contact-1"].first_name == "Changed", "modelCalls": 0}

    def shutdown(payload):
        nonlocal stopping
        if payload is not None:
            raise RuntimeError("NATIVE_ADMISSION_FIXTURE_SHUTDOWN_INVALID")
        stopping = True
        return True

    handlers = {**original, "inspect_app": inspect, "commit_native": commit, "fixture_clock": clock, "fixture_state": state, "shutdown": shutdown}
    peer = wire.PrivatePipePeer(sys.stdin.buffer, sys.stdout.buffer, setup["channelId"], setup["bindingHash"], handlers,
                               on_closed=lambda _code: owner.close())
    try:
        while not stopping:
            try:
                peer.serve_once()
            except wire.A2AWireError as error:
                if error.code != "A2A_WIRE_EOF":
                    raise
                break
    finally:
        summary = state(None)
        peer.close()
        owner.close()
        with (root.parent / "fixture-terminal.json").open("xb") as output:
            output.write((json.dumps({**summary, "exitedNormally": True}, sort_keys=True) + "\n").encode())


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        sys.stderr.write("NATIVE_ADMISSION_FIXTURE_FAILED\n")
        sys.exit(1)
