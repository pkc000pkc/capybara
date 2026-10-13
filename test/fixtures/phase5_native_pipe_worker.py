"""Controlled real-ARE private-pipe fixture, never a production AppAgent.

Only the trusted test parent supplies the first setup frame and source hashes.
The fixture constructs an Environment in SETUP, not a Scenario or event loop.
stdout is exclusively canonical wire; errors never echo arguments or labels.
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
import re
import socket
import sys
import warnings


class FixtureError(RuntimeError):
    """Fixed local code; no exception text is forwarded to the parent."""


def _fail() -> None:
    raise FixtureError("A2A_NATIVE_FIXTURE_BOOTSTRAP") from None


def _deny_connect(*_args, **_kwargs):
    raise FixtureError("A2A_NATIVE_FIXTURE_NETWORK_DISABLED") from None


# Even an accidental dependency/network call cannot become a fixture model run.
socket.socket.connect = _deny_connect
socket.socket.connect_ex = _deny_connect
logging.disable(logging.CRITICAL)
warnings.filterwarnings("ignore")

_ROOT = Path(__file__).absolute().parents[2]
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,199}\Z")
_SETUP_KEYS = frozenset((
    "channelId", "bindingHash", "environmentGeneration", "parentExecutionId",
    "parentSessionId", "evidenceRoot", "appId", "workerSourceSha256",
    "nativeSourceSha256", "wireSourceSha256",
))


def _regular(target: Path, *, directory: bool = False) -> Path:
    if not target.is_absolute():
        _fail()
    absolute = target.absolute()
    for cursor in (absolute, *absolute.parents):
        cursor.lstat()
        if cursor.is_symlink() or getattr(cursor, "is_junction", lambda: False)():
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
    # No ARE/native import occurs until the setup hashes have been verified.
    # Keep bootstrap imports inside the fixed-error boundary as well.
    _regular(_ROOT / "scripts", directory=True)
    _regular(_ROOT / ".official-python", directory=True)
    sys.path.insert(0, str(_ROOT / "scripts"))
    sys.path.insert(0, str(_ROOT / ".official-python"))
    import gaia2_a2a_wire as wire

    reader, writer = sys.stdin.buffer, sys.stdout.buffer
    setup = wire.read_frame(reader)
    if type(setup) is not dict or frozenset(setup) != _SETUP_KEYS:
        _fail()
    if any(type(setup[key]) is not str or not _HASH.fullmatch(setup[key])
           for key in ("channelId", "bindingHash", "workerSourceSha256",
                       "nativeSourceSha256", "wireSourceSha256")):
        _fail()
    if any(type(setup[key]) is not str or not _ID.fullmatch(setup[key])
           for key in ("environmentGeneration", "parentExecutionId", "parentSessionId")):
        _fail()
    if setup["appId"] not in ("Contacts", "RentAFlat", "Shopping", "ShoppingApp"):
        _fail()
    if (os.environ.get("HF_HUB_OFFLINE") != "1"
            or os.environ.get("TRANSFORMERS_OFFLINE") != "1"):
        _fail()

    own_source = _ROOT / "test" / "fixtures" / "phase5_native_pipe_worker.py"
    native_source = _ROOT / "scripts" / "gaia2_private_native_binding.py"
    wire_source = _ROOT / "scripts" / "gaia2_a2a_wire.py"
    if _regular(Path(__file__).absolute()) != _regular(own_source):
        _fail()
    if _regular(Path(wire.__file__).absolute()) != _regular(wire_source):
        _fail()
    sources = (
        (own_source, "workerSourceSha256"),
        (native_source, "nativeSourceSha256"),
        (wire_source, "wireSourceSha256"),
    )
    if any(_source_hash(source) != setup[key] for source, key in sources):
        _fail()
    if type(setup["evidenceRoot"]) is not str or not setup["evidenceRoot"]:
        _fail()
    evidence_root = Path(setup["evidenceRoot"])
    if not evidence_root.is_absolute() or os.path.lexists(evidence_root):
        _fail()
    _regular(evidence_root.parent, directory=True)

    import gaia2_private_native_binding as native_binding
    from are.simulation.apps.apartment_listing import Apartment, RentAFlat
    from are.simulation.apps.contacts import Contact, Contacts
    from are.simulation.apps.shopping import Shopping, ShoppingApp
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.types import EventRegisterer, EnvironmentState

    if _regular(Path(native_binding.__file__).absolute()) != _regular(native_source):
        _fail()
    # A developing/replaced source cannot get past bootstrap by changing after
    # the first hash read but before the trusted factory is imported.
    if any(_source_hash(source) != setup[key] for source, key in sources):
        _fail()
    if not EventRegisterer.is_active() or EventRegisterer.is_capture_mode():
        _fail()

    env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
    if setup["appId"] == "Contacts":
        app = Contacts(contacts={
            "contact-1": Contact("Old", "Fixture", contact_id="contact-1"),
        })
    elif setup["appId"] == "RentAFlat":
        app = RentAFlat(apartments={
            "apt-1": Apartment(
                name="Fixture", location="Local", zip_code="00001", price=1200.0,
                bedrooms=1, bathrooms=1, property_type="Apartment", square_footage=500,
                apartment_id="apt-1",
            ),
        })
    else:
        cls = Shopping if setup["appId"] == "Shopping" else ShoppingApp
        app = cls(name=setup["appId"], discount_codes={
            "item-1": {"LOCAL10": 10.0, "LOCAL20": 20.0},
            "item-2": {"LOCAL10": 10.0},
        })
    env.register_apps([app])
    if (env.state is not EnvironmentState.SETUP or env.thread is not None
            or env.apps[setup["appId"]] is not app
            or app.time_manager is not env.time_manager
            or "environment" not in app.add_event_callbacks):
        _fail()

    owner = native_binding.NativeAppBinding(
        app,
        environment_generation=setup["environmentGeneration"],
        parent_execution_id=setup["parentExecutionId"],
        parent_session_id=setup["parentSessionId"],
        evidence_root=str(evidence_root),
        clock=env.time_manager.time,
        clock_environment=env if setup["appId"] in ("Shopping", "ShoppingApp") else None,
        trusted_source_files=[__file__],
    )
    stopping = False

    def counter() -> dict:
        # These observations are never permission, a Hook decision or scope.
        summary = {
            "appId": app.name,
            "eventCount": len(env.event_log),
            "timeManagerShared": app.time_manager is env.time_manager,
            "environmentState": env.state.name,
        }
        if app.name == "Contacts":
            contact = app.contacts.get("contact-1")
            name = contact.first_name if contact is not None else None
            summary.update({
                "contactCount": len(app.contacts),
                "nameOfContact1": name if name in (None, "Old", "Changed") else "OTHER",
            })
        elif app.name == "RentAFlat":
            summary.update({
                "savedCount": len(app.saved_apartments),
                "apt1Saved": app.apartments["apt-1"].saved,
            })
        else:
            summary.update({"discountItemCount": len(app.discount_codes),
                            "nativeToolCount": len(app.get_tools())})
        return summary

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

    def disconnect(payload):
        if payload is not None:
            _fail()
        owner.close()
        # Deliberate controlled pipe loss: no response or completion is forged.
        os._exit(0)

    handlers = dict(owner.handlers())
    fixture_handlers = {
        "state_summary": state_summary, "shutdown": shutdown, "disconnect": disconnect,
    }
    if set(handlers).intersection(fixture_handlers):
        owner.close()
        _fail()
    handlers.update(fixture_handlers)
    peer = wire.PrivatePipePeer(
        reader, writer, setup["channelId"], setup["bindingHash"], handlers,
        on_closed=lambda _code: owner.close(),
    )
    try:
        while not stopping:
            try:
                peer.serve_once()
            except wire.A2AWireError as error:
                # A trusted parent closing its inherited stdin is a normal
                # owner teardown, not a truncated/invalid protocol success.
                if error.code != "A2A_WIRE_EOF":
                    raise
                break
    finally:
        peer.close()
        owner.close()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        sys.stderr.write("A2A_NATIVE_FIXTURE_FAILED\n")
        sys.stderr.flush()
        sys.exit(1)
