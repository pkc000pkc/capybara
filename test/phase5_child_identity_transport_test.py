"""5.2d1 fixed child identity envelope at the Python pipe boundary."""

import hashlib
from pathlib import Path
import socket
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import gaia2_a2a_wire as wire
from gaia2_private_native_binding import NativeAppBinding, NativeBindingError
from are.simulation.apps.contacts import Contacts
from are.simulation.environment import Environment, EnvironmentConfig


class FixedChildIdentityTransportTests(unittest.TestCase):
    def setUp(self):
        self.offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        self.offline.start()
        self.addCleanup(self.offline.stop)
        self.tmp = tempfile.TemporaryDirectory(prefix="gaia2-child-identity-")
        self.addCleanup(self.tmp.cleanup)
        self.env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
        self.app = Contacts()
        self.env.register_apps([self.app])
        self.owner = NativeAppBinding(self.app, environment_generation="env-1",
            parent_execution_id="parent-exec", parent_session_id="parent-session",
            evidence_root=Path(self.tmp.name) / "evidence", clock=self.env.time_manager.time)
        self.addCleanup(self.owner.close)

    def scope(self):
        task = "fixed child task"
        suffix = uuid.uuid4().hex
        return {
            "parentExecutionId": "parent-exec", "parentSessionId": "parent-session",
            "environmentGeneration": "env-1", "appId": self.app.name,
            "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
            "toolInventoryHash": self.owner.manifest()["toolInventoryHash"],
            "taskHash": hashlib.sha256(task.encode()).hexdigest(), "task": task,
            "parentActionId": "parent-" + suffix, "requestId": str(uuid.uuid4()),
            "childExecutionId": "child-" + suffix, "childSessionId": "session-" + suffix,
            "deadline": 10, "maxNativeActions": 4,
        }

    @staticmethod
    def identity(scope):
        return {
            "schemaVersion": "gaia2-child-identity-v1", "scopeHash": wire.value_hash(scope),
            **{key: scope[key] for key in (
                "environmentGeneration", "parentExecutionId", "parentSessionId", "appId",
                "parentCanonicalName", "taskArgumentKey", "toolInventoryHash", "taskHash",
                "parentActionId", "requestId", "childExecutionId", "childSessionId")},
        }

    def test_pipe_handler_requires_identity_and_binds_hash(self):
        scope = self.scope()
        identity = self.identity(scope)
        handlers = self.owner.handlers()
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_IDENTITY_REQUIRED"):
            handlers["bind_child"]({"scope": scope})
        self.assertEqual(handlers["bind_child"]({"scope": scope, "identity": identity}),
                         {"scopeHash": wire.value_hash(scope)})
        tool = next(item for item in self.owner.manifest()["tools"]
                    if item["canonicalName"].endswith("__search_contacts"))
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_IDENTITY_MISMATCH"):
            handlers["prepare_native"]({"scope": scope, "identity": {**identity, "childExecutionId": "parent-exec"},
                "toolId": tool["toolId"], "rawArguments": {"query": "Old"}})
        prepared = handlers["prepare_native"]({"scope": scope, "identity": identity,
            "toolId": tool["toolId"], "rawArguments": {"query": "Old"}})
        self.assertEqual(prepared["scopeHash"], identity["scopeHash"])

    def test_scope_hash_and_child_id_are_redundant_guards(self):
        scope = self.scope()
        identity = self.identity(scope)
        handlers = self.owner.handlers()
        handlers["bind_child"]({"scope": scope, "identity": identity})
        foreign = {**scope, "childSessionId": "foreign-session"}
        foreign_identity = {**identity, "childSessionId": foreign["childSessionId"],
                            "scopeHash": wire.value_hash(foreign)}
        with self.assertRaisesRegex(NativeBindingError, "NATIVE_CHILD_SCOPE_INVALID"):
            handlers["cancel_child"]({"scope": foreign, "identity": foreign_identity})


if __name__ == "__main__":
    unittest.main()
