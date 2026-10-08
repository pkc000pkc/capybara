"""Model-free cross-language pipe fixture, not an official AppAgent adapter.

stdout is exclusively the inherited private pipe. It has no server port, Actor
control surface, model configuration or native App tool. Do not deploy this
fixture as a production coordinator.
"""

import hashlib
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / "scripts"))
from gaia2_a2a_wire import PrivatePipePeer, read_frame, value_hash, write_frame


def main():
    reader, writer = sys.stdin.buffer, sys.stdout.buffer
    setup = read_frame(reader)
    if (type(setup) is not dict or set(setup) != {"channelId", "bindingHash", "wireSourceSha256", "workerSourceSha256"}
            or hashlib.sha256((root / "scripts/gaia2_a2a_wire.py").read_bytes()).hexdigest() != setup["wireSourceSha256"]
            or hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != setup["workerSourceSha256"]):
        raise ValueError("A2A_FIXTURE_SOURCE")
    stopping = False
    def shutdown(_):
        nonlocal stopping
        stopping = True
        return True
    handlers = {
        "echo": lambda value: value,
        "wire_hash": value_hash,
        "manifest": lambda _: {"wireSourceSha256": setup["wireSourceSha256"], "workerSourceSha256": setup["workerSourceSha256"]},
        # Same fixed ID is deliberately used in opposite directions by the
        # fixture; direction-local request ownership must not falsely collide.
        "nested": lambda value: peer.call("reflect", value, request_id="f" * 32),
        "fault": lambda _: (_ for _ in ()).throw(ValueError("private test error, never transmitted")),
        "shutdown": shutdown,
    }
    peer = PrivatePipePeer(reader, writer, setup["channelId"], setup["bindingHash"], handlers)
    # Shutdown is just a fixture's normal loop stop, not a permission to revoke
    # an active native invocation. The production owner must drain its registry.
    while not stopping:
        peer.serve_once()
    peer.close()


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # No raw exception, payload, nonce, arguments or prompt enters logs.
        sys.stderr.write("A2A_FIXTURE_FAILED\n")
        sys.exit(1)
