"""Offline real AppAgent / inherited private-pipe integration fixture.

Bootstrap is trusted test-parent authority. Only fixed cases select an engine
response sequence; no provider, Scenario, notification consumer or fallback is
ever constructed. stdout is exclusively the typed private wire.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
from pathlib import Path
import re
import socket
import sys
import warnings


class FixtureError(RuntimeError):
    pass


def _fail() -> None:
    raise FixtureError("A2A_APP_AGENT_FIXTURE_BOOTSTRAP") from None


def _deny_connect(*_args, **_kwargs):
    raise FixtureError("A2A_APP_AGENT_FIXTURE_NETWORK_DISABLED") from None


socket.socket.connect = _deny_connect
socket.socket.connect_ex = _deny_connect
logging.disable(logging.CRITICAL)
warnings.filterwarnings("ignore")

_ROOT = Path(__file__).absolute().parents[2]
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\Z")
_SETUP_KEYS = frozenset(("channelId", "bindingHash", "environmentGeneration",
    "parentExecutionId", "parentSessionId", "evidenceRoot", "appId",
    "workerSourceSha256", "nativeSourceSha256", "wireSourceSha256",
    "scopedAgentSourceSha256"))


def _regular(target: Path, *, directory: bool = False) -> Path:
    if not target.is_absolute():
        _fail()
    absolute = target.absolute()
    for cursor in (absolute, *absolute.parents):
        info = cursor.lstat()
        if (cursor.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400
                or getattr(cursor, "is_junction", lambda: False)()):
            _fail()
    if absolute.resolve(strict=True) != absolute:
        _fail()
    if not (absolute.is_dir() if directory else absolute.is_file()):
        _fail()
    return absolute


def _source_hash(target: Path) -> str:
    raw = _regular(target).read_bytes()
    if len(raw) > 4 * 1024 * 1024:
        _fail()
    return hashlib.sha256(raw).hexdigest()


def main() -> None:
    _regular(_ROOT / "scripts", directory=True)
    _regular(_ROOT / ".official-python", directory=True)
    sys.path.insert(0, str(_ROOT / "scripts"))
    sys.path.insert(0, str(_ROOT / ".official-python"))
    import gaia2_a2a_wire as wire

    reader, writer = sys.stdin.buffer, sys.stdout.buffer
    setup = wire.read_frame(reader)
    if type(setup) is not dict or frozenset(setup) != _SETUP_KEYS:
        _fail()
    if any(type(setup[key]) is not str or not _HASH.fullmatch(setup[key]) for key in (
            "channelId", "bindingHash", "workerSourceSha256", "nativeSourceSha256",
            "wireSourceSha256", "scopedAgentSourceSha256")):
        _fail()
    if any(type(setup[key]) is not str or not _ID.fullmatch(setup[key]) for key in (
            "environmentGeneration", "parentExecutionId", "parentSessionId")):
        _fail()
    if setup["appId"] not in ("Contacts", "RentAFlat"):
        _fail()
    if os.environ.get("HF_HUB_OFFLINE") != "1" or os.environ.get("TRANSFORMERS_OFFLINE") != "1":
        _fail()
    own_source = _ROOT / "test" / "fixtures" / "phase5_app_agent_pipe_worker.py"
    native_source = _ROOT / "scripts" / "gaia2_private_native_binding.py"
    wire_source = _ROOT / "scripts" / "gaia2_a2a_wire.py"
    scoped_source = _ROOT / "scripts" / "gaia2_scoped_app_agent.py"
    if _regular(Path(__file__).absolute()) != _regular(own_source):
        _fail()
    if _regular(Path(wire.__file__).absolute()) != _regular(wire_source):
        _fail()
    sources = ((own_source, "workerSourceSha256"), (native_source, "nativeSourceSha256"),
        (wire_source, "wireSourceSha256"), (scoped_source, "scopedAgentSourceSha256"))
    if any(_source_hash(source) != setup[key] for source, key in sources):
        _fail()
    if type(setup["evidenceRoot"]) is not str or not setup["evidenceRoot"]:
        _fail()
    evidence_root = Path(setup["evidenceRoot"])
    if not evidence_root.is_absolute() or os.path.lexists(evidence_root):
        _fail()
    _regular(evidence_root.parent, directory=True)

    import gaia2_private_native_binding as native_binding
    import gaia2_scoped_app_agent as scoped
    from are.simulation.agents.agent_log import ObservationLog, ToolCallLog
    from are.simulation.apps.apartment_listing import Apartment, RentAFlat
    from are.simulation.apps.contacts import Contact, Contacts
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.notification_system import Message, MessageType
    from are.simulation.types import EventRegisterer, EnvironmentState
    from datetime import datetime, timezone

    if (_regular(Path(native_binding.__file__).absolute()) != _regular(native_source)
            or _regular(Path(scoped.__file__).absolute()) != _regular(scoped_source)
            or any(_source_hash(source) != setup[key] for source, key in sources)
            or not EventRegisterer.is_active() or EventRegisterer.is_capture_mode()):
        _fail()
    env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
    if setup["appId"] == "Contacts":
        app = Contacts(contacts={"contact-1": Contact("Old", "Fixture", contact_id="contact-1")})
    else:
        app = RentAFlat(apartments={"apt-1": Apartment(name="Fixture", location="Local",
            zip_code="00001", price=1200.0, bedrooms=1, bathrooms=1,
            property_type="Apartment", square_footage=500, apartment_id="apt-1")})
    env.register_apps([app])
    if (env.state is not EnvironmentState.SETUP or env.thread is not None
            or env.apps[setup["appId"]] is not app or app.time_manager is not env.time_manager
            or "environment" not in app.add_event_callbacks):
        _fail()
    future_messages = (
        Message(MessageType.USER_MESSAGE, "Controlled future parent USER",
            datetime.fromtimestamp(1100.0, tz=timezone.utc)),
        Message(MessageType.ENVIRONMENT_STOP, "Controlled future parent STOP",
            datetime.fromtimestamp(1101.0, tz=timezone.utc)),
    )
    for message in future_messages:
        env.notification_system.message_queue.put(message)
    future_bindings = tuple((id(message), message.message_type, message.message, message.timestamp)
        for message in future_messages)
    owner = native_binding.NativeAppBinding(app,
        environment_generation=setup["environmentGeneration"],
        parent_execution_id=setup["parentExecutionId"],
        parent_session_id=setup["parentSessionId"], evidence_root=str(evidence_root),
        clock=env.time_manager.time, trusted_source_files=[__file__, str(scoped_source)])
    stopping = False
    runners = []
    agent_runs = []
    used_cases = set()

    def queue_preserved():
        queue = env.notification_system.message_queue.list_view()
        return all(any((id(item), item.message_type, item.message, item.timestamp) == binding
            for item in queue) for binding in future_bindings)

    def counter():
        result = {"appId": app.name, "eventCount": len(env.event_log),
            "timeManagerShared": app.time_manager is env.time_manager,
            "environmentState": env.state.name, "futureParentMessagesPreserved": queue_preserved(),
            "futureParentMessageCount": len(env.notification_system.message_queue.list_view())}
        if app.name == "Contacts":
            contact = app.contacts.get("contact-1")
            name = contact.first_name if contact is not None else None
            result.update({"contactCount": len(app.contacts),
                "nameOfContact1": name if name in (None, "Old", "Changed") else "OTHER"})
        else:
            result.update({"savedCount": len(app.saved_apartments), "apt1Saved": app.apartments["apt-1"].saved})
        return result

    def response(name, arguments):
        return "Thought: controlled\nAction:\n" + json.dumps({"action": name,
            "action_input": arguments}, ensure_ascii=False) + "<end_action>"

    def sequence(case):
        final = response("final_answer", {"answer": "Controlled child answer"})
        read = response("Contacts__get_contact", {"contact_id": "contact-1"})
        if case == "contacts-read-final" and app.name == "Contacts":
            return [read, final]
        if case == "rent-save-final" and app.name == "RentAFlat":
            return [response("RentAFlat__save_apartment", {"apartment_id": "apt-1"}), final]
        if case == "final-only":
            return [final]
        if case == "final-empty":
            return [response("final_answer", {"answer": ""})]
        if case == "final-whitespace":
            return [response("final_answer", {"answer": "  Controlled child answer  "})]
        if case == "partial-write" and app.name == "Contacts":
            return [response("Contacts__edit_contact", {"contact_id": "contact-1",
                "updates": {"first_name": "Changed", "z_invalid": "controlled value"}}), final]
        if case == "exhausted" and app.name == "Contacts":
            return [read]
        if case == "mock-forbidden":
            return [response("_mock", {}), final]
        _fail()

    def dispatch(action):
        return peer.call("dispatch_agent_action", action)

    def run_app_agent(payload):
        if (type(payload) is not dict or set(payload) != {"scope", "case"}
                or type(payload["scope"]) is not dict or type(payload["case"]) is not str
                or payload["case"] in used_cases):
            _fail()
        responses = sequence(payload["case"])
        used_cases.add(payload["case"])
        runner = None
        engine = scoped.ControlledAppAgentEngine(responses)
        status = "failed"
        answer = None
        try:
            runner = scoped.build_scoped_app_agent(app=app, owner=owner, env=env,
                scope=payload["scope"], llm_engine=engine, dispatch=dispatch)
            runners.append(runner)
            answer = runner.run()
            status = "completed"
        except BaseException:
            # The genuine Host is revoked synchronously by its trusted handler.
            # No exception text, raw model input or permission is fabricated.
            peer.call("abort_agent", None)
        try:
            logs = runner.base_agent.get_agent_logs() if runner is not None else []
            safe_logs = []
            for log in logs:
                record = {"type": type(log).__name__, "timestamp": log.timestamp}
                if isinstance(log, ToolCallLog):
                    record.update({"toolName": log.tool_name,
                        "argumentsHash": wire.value_hash(log.tool_arguments)})
                if isinstance(log, ObservationLog):
                    content = log.content
                    record.update({"contentSha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
                        "isOriginalContactString": "Contact ID: contact-1" in content,
                        "isRealRentFormatterString": content == "Successfully saved apartment",
                        "isControlledFinalString": content == "Controlled child answer",
                        "containsWireTypeTag": "nativeType" in content})
                safe_logs.append(record)
            snapshot = runner.snapshot() if runner is not None else None
            result = {"schemaVersion": "gaia2-controlled-app-agent-run-v1", "case": payload["case"],
                "status": status, "answer": answer, "runner": snapshot, "safeOfficialLogs": safe_logs,
                "controlledInferenceCalls": engine.calls, "realModelCalls": 0,
                "futureParentMessagesPreserved": queue_preserved(), "state": counter()}
            wire.value_hash(result)
            target = evidence_root.parent / ("agent-run-" + str(len(agent_runs) + 1) + ".json")
            with target.open("xb") as stream:
                stream.write((json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8"))
                stream.flush()
                os.fsync(stream.fileno())
            agent_runs.append(result)
            return result
        except BaseException:
            # Even a diagnostic failure AFTER verified final dispatch invalidates
            # the overall run. Never send a half-written success response.
            peer.call("abort_agent", None)
            raise FixtureError("A2A_APP_AGENT_DIAGNOSTIC_FAILED") from None

    def state_summary(payload):
        if payload is not None:
            _fail()
        return counter()

    def shutdown(payload):
        nonlocal stopping
        if payload is not None:
            _fail()
        stopping = True
        return True

    handlers = dict(owner.handlers())
    fixture_handlers = {"run_app_agent": run_app_agent, "state_summary": state_summary,
        "shutdown": shutdown}
    if set(handlers).intersection(fixture_handlers):
        owner.close()
        _fail()
    handlers.update(fixture_handlers)
    peer = wire.PrivatePipePeer(reader, writer, setup["channelId"], setup["bindingHash"],
        handlers, on_closed=lambda _code: owner.close())
    try:
        while not stopping:
            try:
                peer.serve_once()
            except wire.A2AWireError as error:
                if error.code != "A2A_WIRE_EOF":
                    raise
                break
    finally:
        for runner in runners:
            runner.close()
        peer.close()
        owner.close()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        sys.stderr.write("A2A_APP_AGENT_FIXTURE_FAILED\n")
        sys.stderr.flush()
        sys.exit(1)
