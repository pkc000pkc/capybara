"""Offline pool handshake over real ARE App wrappers/native owners, no models."""

import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"

import gaia2_a2a_wire as wire
from gaia2_a2a_wire import value_hash
from gaia2_scoped_model_broker import ScopedRetryModelEngine
from gaia2_scoped_app_agent import ScopedAppAgentFatal
from gaia2_notification_producer import ScopedChildNotificationLifecycle, ScopedNotificationOriginRegistry
import capybara_official_bridge as bridge
from gaia2_official_a2a import (
    OfficialA2AClient, OfficialA2AClientPool, OfficialA2AError,
    connect_official_a2a_pool,
)
from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.apps.apartment_listing import RentAFlat
from are.simulation.apps.contacts import Contacts
from are.simulation.apps.shopping import Shopping, ShoppingApp
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.tool_utils import AppToolAdapter
from are.simulation.types import EnvironmentState
from are.simulation.notification_system import Message, MessageType

SECRET = "PRIVATE_POOL_KEY_AND_TASK"
ENDPOINT = "https://private-pool.invalid/secret"
_SOCKET_CONNECT = socket.socket.connect


class IdleOwner:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class ClockedNativeDispatch:
    """Synthetic Node gate, actual private native callback/ARE clock probes."""

    def __init__(self, owner, child_scope):
        self.owner, self.scope = owner, child_scope
        self.root = Path(owner.manifest()["evidenceRoot"])
        self.tools = {tool["publicName"]: tool for tool in owner.manifest()["tools"]}
        self.outcomes = []
        owner.bind_child({"scope": child_scope})

    def __call__(self, request):
        tool = self.tools[request["tool"]]
        prepared = self.owner.prepare_native({"scope": self.scope, "toolId": tool["toolId"],
            "rawArguments": request["arguments"]})
        dispatch_id = str(uuid.uuid4())
        clock_probe = {"scope": self.scope, "ticketId": prepared["ticketId"], "dispatchId": dispatch_id}
        self.owner.observe_clock({**clock_probe, "checkpoint": "before_tool"})
        outcome = self.owner.commit_native({**clock_probe, "toolId": tool["toolId"],
            "effectiveArgumentsHash": prepared["effectiveArgumentsHash"]})
        self.outcomes.append(outcome)
        self.owner.observe_clock({**clock_probe, "checkpoint": "after_tool"})
        if outcome["status"] != "succeeded":
            raise AssertionError("synthetic_native_dispatch_failed")
        ref = None
        if tool["toolKind"] == "child_final_answer":
            receipt = {"schemaVersion": "capybara-runtime-delegation-receipt-v1",
                "environmentGeneration": self.scope["environmentGeneration"],
                "parentExecutionId": self.scope["parentExecutionId"], "parentSessionId": self.scope["parentSessionId"],
                "sequence": 1, "previousHash": None, "kind": "completed",
                "data": {"scope": self.scope, "finalDispatchId": dispatch_id,
                    "finalEvidence": {"fixtureOnly": True}}}
            raw = json.dumps(receipt, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            path = self.root / ("synthetic-pool-completed-" + uuid.uuid4().hex + ".json")
            with path.open("xb") as output:
                output.write(raw)
            ref = {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest()}
        return {"dispatchId": dispatch_id, "toolId": tool["toolId"], "toolKind": tool["toolKind"],
            "status": "completed", "completionEvidenceRef": ref}


class AfterFlushWriter:
    """Publish the A response only after B's real response frame is written."""

    def __init__(self, writer, callback):
        self.writer = writer
        self.callback = callback

    def write(self, data):
        return self.writer.write(data)

    def flush(self):
        self.writer.flush()
        if self.callback is not None:
            callback, self.callback = self.callback, None
            callback()

    def close(self):
        self.writer.close()


class FakeSocket:
    def __init__(self, server):
        self.server = server
        self.closed = False
        self.stream_buffers = []

    def settimeout(self, _timeout):
        pass

    def makefile(self, mode, buffering=-1):
        self.stream_buffers.append((mode, buffering))
        return self

    def close(self):
        self.closed = True
        self.server.events.append(("socket_closed", None))


class FakePeer:
    def __init__(self, read_stream, _write_stream, _channel, _binding, handlers, on_closed):
        self.server = read_stream.server
        self.manifest = handlers["inspect_app"](None)
        self.app_id = self.manifest["appId"]
        self.closed = False
        self.router = None
        self.model_revision = 0
        self.server.peers.append(self)

    def install_router(self, router):
        if self.router is not None:
            raise RuntimeError(SECRET)
        self.router = router
        self.server.events.append(("router_installed", self.app_id))

    def serve_once(self):
        raise RuntimeError("no_fake_frame_queued")

    def call(self, method, payload):
        self.server.events.append((method, self.app_id))
        if method == "a2a_connect_ready":
            if payload is None:
                self.server.committed = True
                return {"status": "ready"}
            self.server.expected_payloads.append(payload)
            if payload != {"appIds": self.server.app_ids}:
                raise RuntimeError(SECRET)
            self.server.prepared.add(self.app_id)
            if self.app_id == self.server.bad_prepare_app:
                return {"appId": "foreign", "status": "prepared"}
            return {"appId": self.app_id, "status": "prepared"}
        if method == "a2a_commit_apps":
            if payload != {"appIds": self.server.app_ids} or self.server.prepared != set(self.server.app_ids):
                raise RuntimeError(SECRET)
            self.server.committed = True
            if self.server.bad_commit:
                return {"status": "committed", "appIds": self.server.app_ids[:-1]}
            return {"status": "committed", "appIds": list(self.server.app_ids)}
        if method == "a2a_close_owner":
            if payload is not None:
                raise RuntimeError(SECRET)
            self.server.closed = True
            self.server.committed = False
            if self.server.bad_close:
                raise RuntimeError(SECRET)
            return {"status": "closed"}
        if method == "a2a_begin_child":
            if not self.server.committed or self.server.closed:
                raise RuntimeError(SECRET)
            self.server.children += 1
            task = payload["task"]
            scope = {"parentExecutionId": "pool-exec", "parentSessionId": "pool-session",
                "environmentGeneration": "official-pool-exec", "appId": self.app_id,
                "parentCanonicalName": "AppAgent__expert_agent", "taskArgumentKey": "task",
                "toolInventoryHash": self.manifest["toolInventoryHash"],
                "taskHash": hashlib.sha256(task.encode()).hexdigest(),
                "parentActionId": "action-" + str(self.server.children),
                "requestId": "request-" + str(self.server.children),
                "childExecutionId": "child-" + str(self.server.children),
                "childSessionId": "child-session-" + str(self.server.children),
                "task": task, "deadline": 2000.0, "maxNativeActions": 40}
            return {"handleToken": str(uuid.uuid4()), "scope": scope}
        if method == "a2a_before_model":
            context = "trusted pool context"
            if self.app_id in self.server.dispatchers:
                dispatcher = self.server.dispatchers[self.app_id]
                child_scope, request = dispatcher.scope, payload["input"]
                self.model_revision += 1
                context_hash = hashlib.sha256(context.encode()).hexdigest()
                receipt = {"schemaVersion": "capybara-runtime-plugin-invocation-v1",
                    "executionId": child_scope["childExecutionId"], "sessionId": child_scope["childSessionId"],
                    "scenarioId": "synthetic-pool-no-scenario", "sequence": self.model_revision * 3,
                    "input": {"checkpoint": "before_model", "loop": {"runId": child_scope["childExecutionId"],
                        "iteration": request["iteration"], "terminal": False},
                        "messages": request["messages"], "clock": request["clock"]},
                    "decision": {"action": "allow", "reason": "synthetic"}, "context": context,
                    "contextHash": context_hash, "variablesHash": "f" * 64, "revision": self.model_revision,
                    "hookReceipts": [], "trustedModelAdmission": {"delegationScopeHash": value_hash(child_scope),
                        "modelScope": request["modelScope"], "modelScopeHash": value_hash(request["modelScope"]),
                        "originalMessagesHash": request["originalMessagesHash"]}}
                raw = json.dumps(receipt, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
                path = dispatcher.root / ("synthetic-pool-gate-" + uuid.uuid4().hex + ".json")
                with path.open("xb") as output:
                    output.write(raw)
                return {"context": context, "contextHash": context_hash, "variablesHash": "f" * 64,
                    "revision": self.model_revision, "evidence": {"path": str(path), "sha256": hashlib.sha256(raw).hexdigest()}}
            return {"context": context,
                "contextHash": hashlib.sha256(context.encode()).hexdigest(),
                "variablesHash": "f" * 64, "revision": 1,
                "evidence": {"path": "owned.json", "sha256": "0" * 64}}
        if method == "a2a_dispatch" and self.app_id in self.server.dispatchers:
            dispatcher = self.server.dispatchers[self.app_id]
            public_name = next(name for name, tool in dispatcher.tools.items() if tool["toolId"] == payload["tool"])
            result = dispatcher({"tool": public_name, "arguments": payload["arguments"]})
            return {key: result[key] for key in ("dispatchId", "toolId", "toolKind", "status", "completionEvidenceRef")}
        if method == "a2a_cancel_child":
            if self.server.bad_cancel:
                raise RuntimeError(SECRET)
            return None
        return {"ok": True}

    def close(self):
        self.closed = True
        self.server.events.append(("peer_closed", self.app_id))


class FakeServer:
    def __init__(self, app_ids):
        self.app_ids = sorted(app_ids)
        self.prepared = set()
        self.committed = self.closed = False
        self.bad_prepare_app = None
        self.bad_commit = self.bad_close = False
        self.bad_cancel = False
        self.dispatchers = {}
        self.children = 0
        self.events, self.expected_payloads, self.peers, self.sockets = [], [], [], []

    def connect(self, _address, timeout):
        result = FakeSocket(self)
        self.sockets.append(result)
        return result


class Tests(unittest.TestCase):
    def setUp(self):
        offline = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        offline.start()
        self.addCleanup(offline.stop)
        self.temp = tempfile.TemporaryDirectory(prefix="gaia2-official-pool-")
        self.addCleanup(self.temp.cleanup)
        self.serial = 0
        self.pools, self.clients = [], []
        self.addCleanup(self.cleanup)
        self.context = patch.dict(os.environ, {
            "GAIA2_EXECUTION_ID": "pool-exec", "GAIA2_SESSION_ID": "pool-session",
            "GAIA2_A2A_PIPE_HOST": "127.0.0.1", "GAIA2_A2A_PIPE_PORT": "12345",
            "GAIA2_A2A_PIPE_CHANNEL": "a" * 64, "GAIA2_A2A_PIPE_BINDING": "b" * 64,
        })
        self.context.start()
        self.addCleanup(self.context.stop)

    def cleanup(self):
        for owner in self.pools + self.clients:
            try:
                owner.close()
            except OfficialA2AError:
                pass

    def fixture(self):
        env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
        native = [Contacts(), RentAFlat()]
        env.register_apps(native)
        wrapped = [AppAgent(app_agent=SimpleNamespace(),
            tools={tool.name: tool for tool in (AppToolAdapter(item) for item in app.get_tools())},
            name=app.name) for app in native]
        env.register_apps(wrapped)
        env.time_manager.add_offset(1)
        env.time_manager.pause()
        self.serial += 1
        workspace = Path(self.temp.name) / str(self.serial)
        workspace.mkdir()
        return env, native, wrapped, workspace, FakeServer(app.name for app in wrapped)

    def config(self, fixture):
        env, _, wrapped, workspace, _ = fixture
        return {"env": env, "apps": list(reversed(wrapped)), "scenario_id": "scenario-1",
            "workspace": workspace, "model": "controlled-model", "provider": "openai",
            "endpoint": ENDPOINT, "api_key": SECRET}

    def build(self, fixture, **overrides):
        server = fixture[-1]
        with patch("gaia2_official_a2a.socket.create_connection", side_effect=server.connect), \
                patch("gaia2_official_a2a.PrivatePipePeer", FakePeer):
            pool = connect_official_a2a_pool(**{**self.config(fixture), **overrides})
        self.pools.append(pool)
        return pool

    def assert_no_owner_callbacks(self, native):
        for app in native:
            self.assertFalse(any(name.startswith("phase5-private-native-") for name in app.add_event_callbacks))
            self.assertIn("environment", app.add_event_callbacks)

    def one_request(self, client):
        client.begin_child(parent_response={"evidencePath": "parent.json", "decision": {"action": "allow"}},
                           task=SECRET)
        model_scope, scope_hash, _, _ = client._model_binding()
        request_id = uuid.uuid4().hex
        messages = [{"role": "user", "content": SECRET, "attachments": None}]
        gate = client._model_gate({"requestId": request_id, "messages": messages,
            "projectedMessages": [{"role": "user", "content": SECRET,
                "id": "message-" + request_id, "requestId": request_id}],
            "clock": {"now": 1001.0, "revision": 1}}, model_scope=model_scope, model_scope_hash=scope_hash)
        ack = client._model_attempt({"permitId": gate["permitId"], "requestId": request_id,
            "actualInputHash": gate["actualInputHash"], "attempt": 1}, model_scope_hash=scope_hash)
        client.reset_child(completed=True)
        return ack

    def real_router_fixture(self):
        """Two genuine socket pairs and real wire peers, one execution thread."""
        def loopback_connect(sock, address):
            if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
                raise AssertionError("non_loopback_forbidden")
            return _SOCKET_CONNECT(sock, address)

        with patch.object(socket.socket, "connect", loopback_connect):
            pairs = [socket.socketpair(), socket.socketpair()]
        pool = object.__new__(OfficialA2AClientPool)
        pool._OfficialA2AClientPool__app_ids = ("A", "B")
        pool._OfficialA2AClientPool__clients = {}
        pool._OfficialA2AClientPool__used_app_ids = set()
        pool._OfficialA2AClientPool__status = "committed"
        pool._OfficialA2AClientPool__router_failed = False
        pool._OfficialA2AClientPool__shutdown_complete = False
        server_streams = []
        handled = []
        channel, binding = "a" * 64, "b" * 64
        for client_sock, server_sock in pairs:
            self.addCleanup(client_sock.close)
            self.addCleanup(server_sock.close)
            streams = (server_sock.makefile("rb", buffering=0), server_sock.makefile("wb", buffering=0))
            for stream in streams:
                self.addCleanup(stream.close)
            server_streams.append(streams)

        def after_b_response():
            self.assertEqual(handled, ["B_cancelled"])
            wire.write_frame(server_streams[0][1], {"schemaVersion": wire.SCHEMA_VERSION,
                "channelId": channel, "bindingHash": binding, "sequence": 1,
                "kind": "response", "requestId": "1" * 32, "method": "a2a_close_owner",
                "payload": {"ok": True, "value": {"status": "closed"}}})

        def cancel_b(payload):
            self.assertIsNone(payload)
            handled.append("B_cancelled")
            return {"cancelled": True}

        for index, name in enumerate(("A", "B")):
            sock = pairs[index][0]
            reader, writer = sock.makefile("rb", buffering=0), sock.makefile("wb", buffering=0)
            if name == "B":
                writer = AfterFlushWriter(writer, after_b_response)
            peer = wire.PrivatePipePeer(reader, writer, channel, binding,
                {"cancel_child": cancel_b} if name == "B" else {})
            client = object.__new__(OfficialA2AClient)
            fields = {"socket": sock, "peer": peer, "read_stream": reader, "write_stream": writer,
                "closed": False, "owner": IdleOwner(), "handle_token": None, "scope": None,
                "owner_prepared": True, "owner_committed": True, "expected_app_ids": ("A", "B"),
                "app": SimpleNamespace(name=name), "failure_code": None, "failure_callback": None}
            for key, value in fields.items():
                setattr(client, "_OfficialA2AClient__" + key, value)
            pool._OfficialA2AClientPool__clients[name] = client
            self.addCleanup(client.close)
        pool._OfficialA2AClientPool__install_router()
        return pool, pairs, server_streams, handled

    def test_complete_sorted_inventory_prepares_before_single_commit(self):
        f = self.fixture()
        pool = self.build(f)
        server = f[-1]
        handshake = [item for item in server.events if item[0] in ("a2a_connect_ready", "a2a_commit_apps")]
        self.assertEqual(handshake, [("a2a_connect_ready", "Contacts"),
            ("a2a_connect_ready", "RentAFlat"), ("a2a_commit_apps", "Contacts")])
        self.assertEqual(server.expected_payloads, [{"appIds": ["Contacts", "RentAFlat"]}] * 2)
        self.assertTrue(all(sock.stream_buffers == [("rb", 0), ("wb", 0)] for sock in server.sockets))
        self.assertIs(server.peers[0].router, server.peers[1].router)
        self.assertLess(server.events.index(("router_installed", "RentAFlat")),
                        server.events.index(("a2a_commit_apps", "Contacts")))
        self.assertEqual(pool.snapshot()["status"], "committed")
        self.assertEqual(pool.snapshot()["usedAppIds"], [])
        self.assertEqual([entry["appId"] for entry in pool.snapshot()["clients"]], ["Contacts", "RentAFlat"])
        # Real NativeAppBinding snapshots remain valid with two owners sharing
        # this ARE Environment/TimeManager; no sibling instrumentation drift.
        for name in server.app_ids:
            client = pool.client_for(name)
            self.assertEqual(client._OfficialA2AClient__owner.manifest()["appId"], name)
            self.assertIs(client._OfficialA2AClient__owner.clock_environment, f[0])

    def test_a_b_a_routes_back_to_same_client_with_cumulative_counts(self):
        f = self.fixture()
        pool = self.build(f)
        first = pool.client_for("Contacts")
        for name in ("Contacts", "RentAFlat", "Contacts"):
            ack = self.one_request(pool.client_for(name))
            self.assertEqual((ack["logicalRequestsUsed"], ack["sdkAttemptsUsed"]), (1, 1))
        self.assertIs(pool.client_for("Contacts"), first)
        totals = {entry["appId"]: (entry["modelRequests"], entry["sdkAttempts"])
                  for entry in pool.snapshot()["clients"]}
        self.assertEqual(totals, {"Contacts": (2, 2), "RentAFlat": (1, 1)})
        self.assertEqual(pool.snapshot()["usedAppIds"], ["Contacts", "RentAFlat"])
        snapshot = json.dumps(pool.snapshot(), sort_keys=True)
        for forbidden in (SECRET, ENDPOINT, "api_key", "task", "messages"):
            self.assertNotIn(forbidden, snapshot)

    def test_cancel_ack_failure_revokes_whole_pool_without_erasing_child(self):
        f = self.fixture()
        pool = self.build(f)
        client = pool.client_for("Contacts")
        client.begin_child(parent_response={"evidencePath": "parent.json", "decision": {"action": "allow"}},
                           task=SECRET)
        before = client.snapshot()
        f[-1].bad_cancel = True
        with self.assertRaisesRegex(OfficialA2AError, "A2A_CHILD_CANCEL_FAILED"):
            client.reset_child(completed=False)
        after = client.snapshot()
        self.assertTrue(after["childActive"])
        self.assertTrue(after["failed"])
        self.assertEqual(after["scopeHash"], before["scopeHash"])
        self.assertEqual(pool.snapshot()["status"], "failed")
        with self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_NOT_COMMITTED"):
            pool.client_for("RentAFlat")
        other = pool._OfficialA2AClientPool__clients["RentAFlat"]
        with self.assertRaisesRegex(OfficialA2AError, "A2A_OWNER_NOT_COMMITTED"):
            other.begin_child(parent_response={"evidencePath": "parent.json", "decision": {"action": "allow"}},
                              task=SECRET)
        with self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_CLOSE_FAILED"):
            pool.close()
        self.assertTrue(all(sock.closed for sock in f[-1].sockets))
        self.assert_no_owner_callbacks(f[1])

    def test_production_generation_uses_registered_wrapper_and_true_retry_timing(self):
        # Fake only the private Node ACK/native gate and SDK. Registered ARE
        # objects, owner lease, successful elapsed timing and persisted ledger
        # are actual production components, not a bound-flag assertion.
        from phase5_generation_runner_test import FakeSDK, Monotonic, Retry503, response
        from phase5_scoped_app_agent_test import action
        f = self.fixture()
        env, native, wrapped, workspace, server = f
        env.time_manager.resume()
        env.start()
        def stop_env():
            env.stop()
            if env.thread is not None:
                env.thread.join(timeout=2)
        self.addCleanup(stop_env)
        self.assertIs(env.state, EnvironmentState.RUNNING)
        with patch.dict(os.environ, {"GAIA2_A2A_REQUIRE_NOTIFICATION_READER": "0",
                "GAIA2_A2A_REQUIRE_DEADLINE": "0", "GAIA2_MODEL_MAX_ATTEMPTS": "2",
                "GAIA2_MODEL_BACKOFF_BASE_SECONDS": "2"}):
            pool = self.build(f, require_generation_time=True)
            client = pool.client_for("Contacts")
            self.assertIs(client._OfficialA2AClient__registered_app, wrapped[0])
            self.assertIs(client._OfficialA2AClient__app, native[0])
            client.begin_child(parent_response={"evidencePath": "parent.json", "decision": {"action": "allow"}},
                               task=SECRET)
            owner = client._OfficialA2AClient__owner
            server.dispatchers["Contacts"] = ClockedNativeDispatch(owner, client._OfficialA2AClient__scope)
            sdk = FakeSDK([Retry503(), response(action("final_answer", {"answer": "done"}))])
            monotonic, waits = Monotonic(), []
            def engine_factory(**kwargs):
                return ScopedRetryModelEngine(**kwargs, monotonic_clock=monotonic,
                    sleep=lambda seconds: waits.append(seconds))
            with patch("gaia2_official_a2a._sdk_completion", sdk), \
                    patch("gaia2_official_a2a.ScopedRetryModelEngine", side_effect=engine_factory):
                runner = client.child_runner()
            try:
                self.assertIsNone(runner.base_agent.simulated_generation_time_config)
                self.assertEqual(runner.run(), "done")
                self.assertEqual(len(sdk.calls), 2)
                self.assertAlmostEqual(sum(waits), 2)
                snapshot = runner.snapshot()
                request = snapshot["modelRequests"][0]
                timing = request["generationTiming"]
                self.assertEqual(request["generationOffset"], timing["successfulSdkElapsedSeconds"])
                self.assertGreater(timing["sdkAttemptElapsedSeconds"], timing["successfulSdkElapsedSeconds"])
                self.assertEqual(request["generationLedgerFinished"]["phase"], "finished")
                self.assertFalse(env.pause_event.is_set())
                self.assertIs(env.state, EnvironmentState.RUNNING)
                lease_owner = runner._ScopedAppAgentRunner__generation_owners[0]
                self.assertIs(lease_owner._ScopedAREGenerationTimeOwner__app, wrapped[0])
                self.assertTrue(lease_owner.snapshot()["lease"]["released"])
                self.assertTrue(client.snapshot()["guard"]["generationTimeBound"])
                identity = client.child_evidence_identity()
                self.assertNotIn(SECRET, json.dumps(identity))
                self.assertNotIn("task", identity)
                manifest = client.native_manifest()
                manifest["tools"].clear()
                self.assertTrue(client.native_manifest()["tools"])
                client.reset_child(completed=True)
                self.assertEqual(client.snapshot()["childScopeHashes"], [identity["scopeHash"]])
            finally:
                runner.close()

    def test_client_accepts_native_v2_true_shopping_return_without_completed_event(self):
        from phase5_generation_runner_test import FakeSDK, response
        from phase5_scoped_app_agent_test import action
        for native_type in (Shopping, ShoppingApp):
            with self.subTest(native_type=native_type.__name__):
                env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
                native = native_type(name="Shopping", discount_codes={"item-1": {"SAVE": 0.1}})
                env.register_apps([native])
                wrapper = AppAgent(app_agent=SimpleNamespace(), tools={tool.name: tool for tool in
                    (AppToolAdapter(item) for item in native.get_tools())}, name=native.name)
                env.register_apps([wrapper])
                env.time_manager.add_offset(1)
                env.time_manager.pause()
                self.serial += 1
                workspace = Path(self.temp.name) / str(self.serial)
                workspace.mkdir()
                server = FakeServer(["Shopping"])
                fixture = (env, [native], [wrapper], workspace, server)
                with patch.dict(os.environ, {"GAIA2_A2A_REQUIRE_NOTIFICATION_READER": "0",
                        "GAIA2_A2A_REQUIRE_DEADLINE": "0"}):
                    pool = self.build(fixture)
                    client = pool.client_for("Shopping")
                    manifest = client.native_manifest()
                    self.assertEqual(manifest["schemaVersion"], "gaia2-native-app-binding-v2")
                    self.assertEqual(client.snapshot()["excludedTools"]["toolCount"], 0)
                    getter = next(tool for tool in manifest["tools"]
                                  if tool["canonicalName"].endswith("__get_all_discount_codes"))
                    self.assertEqual(getter["completionEvidenceKind"], "source_pinned_return")
                    client.begin_child(parent_response={"evidencePath": "parent.json", "decision": {"action": "allow"}},
                                       task=SECRET)
                    owner = client._OfficialA2AClient__owner
                    dispatch = ClockedNativeDispatch(owner, client._OfficialA2AClient__scope)
                    server.dispatchers["Shopping"] = dispatch
                    sdk = FakeSDK([response(action(getter["publicName"], {})),
                        response(action("final_answer", {"answer": "done"}))])
                    with patch("gaia2_official_a2a._sdk_completion", sdk):
                        runner = client.child_runner()
                    try:
                        self.assertEqual(runner.run(), "done")
                        self.assertEqual(len(dispatch.outcomes), 2)
                        read = dispatch.outcomes[0]
                        self.assertEqual(read["schemaVersion"], "gaia2-private-native-outcome-v2")
                        self.assertEqual(read["completionEvidenceKind"], "source_pinned_return")
                        self.assertIsNone(read["nativeCompletedEventRef"])
                        self.assertEqual(read["agentObservation"], {"SAVE": ["item-1"]})
                        returned = json.loads((dispatch.root / read["nativeReturnEvidenceRef"]["path"]).read_bytes())
                        self.assertEqual(returned["nativeRawProjection"], {"SAVE": ["item-1"]})
                        self.assertIsNone(returned["nativeCompletedEventRef"])
                        self.assertIsNotNone(returned["ownerClock"])
                        self.assertEqual(len(env.event_log), 0)
                        self.assertEqual(runner.snapshot()["originalObservationsTaken"], 2)
                        client.reset_child(completed=True)
                    finally:
                        runner.close()

    def test_real_parent_pump_interrupts_sdk_retry_and_cleans_owned_pause(self):
        from phase5_generation_runner_test import Retry503, response
        from phase5_scoped_app_agent_test import action
        cases = [(kind, succeeded) for kind in (MessageType.USER_MESSAGE, MessageType.ENVIRONMENT_STOP)
                 for succeeded in (False, True)]
        for kind, succeeded in cases:
            with self.subTest(kind=kind, sdk_succeeded=succeeded):
                f = self.fixture()
                env, _, _, _, server = f
                env.time_manager.resume()
                env.start()
                lifecycle_slot, pending, revision, pump_events, sdk_calls = [], [], [0], [], []
                registry = ScopedNotificationOriginRegistry()
                def stop_env():
                    env.stop()
                    if env.thread is not None:
                        env.thread.join(timeout=2)
                self.addCleanup(stop_env)
                def reader_factory(child_scope):
                    lifecycle = ScopedChildNotificationLifecycle(registry=registry,
                        scope=child_scope, time_manager=env.time_manager)
                    lifecycle_slot.append(lifecycle)
                    return lifecycle.reader
                def pump_factory(child_scope):
                    lifecycle = lifecycle_slot[-1]
                    binding = bridge.BridgeNotificationBinding.from_lifecycle(lifecycle)
                    def revision_writer(value):
                        revision[0] = value
                    return bridge._A2AParentNotificationPump(env=env, lifecycle=lifecycle, binding=binding,
                        scope=child_scope, is_current=lambda: lifecycle_slot[-1] is lifecycle,
                        revision_reader=lambda: revision[0], revision_writer=revision_writer,
                        pending_messages=pending)
                def sdk(**kwargs):
                    sdk_calls.append(kwargs)
                    if kind is MessageType.ENVIRONMENT_STOP:
                        env.stop()
                    else:
                        env.notification_system.message_queue.put(Message(kind, "arrived USER update",
                            datetime.fromtimestamp(env.time_manager.time(), tz=timezone.utc)))
                    if not succeeded:
                        raise Retry503()
                    return response(action("final_answer", {"answer": "obsolete answer must never execute"}))
                # A future official record must not be pulled early by either
                # the client or parent pump while the SDK is synchronously busy.
                env.notification_system.message_queue.put(Message(MessageType.USER_MESSAGE, "future update",
                    datetime.fromtimestamp(env.time_manager.time() + 1000000, tz=timezone.utc)))
                with patch.dict(os.environ, {"GAIA2_A2A_REQUIRE_DEADLINE": "0",
                        "GAIA2_MODEL_MAX_ATTEMPTS": "6"}), \
                        patch.object(bridge, "_emit_runtime_event", side_effect=lambda name, **fields:
                            pump_events.append({"type": name, **fields})):
                    pool = self.build(f, notification_reader_factory=reader_factory,
                        notification_pump_factory=pump_factory,
                        require_notification_pump=True, require_generation_time=True)
                    client = pool.client_for("Contacts")
                    client.begin_child(parent_response={"evidencePath": "parent.json", "decision": {"action": "allow"}},
                                       task=SECRET)
                    owner = client._OfficialA2AClient__owner
                    dispatcher = ClockedNativeDispatch(owner, client._OfficialA2AClient__scope)
                    server.dispatchers["Contacts"] = dispatcher
                    with patch("gaia2_official_a2a._sdk_completion", sdk):
                        runner = client.child_runner()
                    try:
                        expected = ("SCOPED_AGENT_NOTIFICATION_STOPPED" if kind is MessageType.ENVIRONMENT_STOP
                                    else "SCOPED_AGENT_NOTIFICATION_STALE")
                        with self.assertRaisesRegex(ScopedAppAgentFatal, expected):
                            runner.run()
                        self.assertEqual(len(sdk_calls), 1)
                        self.assertEqual(dispatcher.outcomes, [])
                        self.assertEqual(client.snapshot()["sdkAttempts"], 1)
                        self.assertFalse(env.pause_event.is_set())
                        self.assertEqual(runner._ScopedAppAgentRunner__generation_ledgers[0].phase, "failed")
                        lease_owner = runner._ScopedAppAgentRunner__generation_owners[0]
                        self.assertTrue(lease_owner.snapshot()["lease"]["released"])
                        self.assertEqual(lease_owner.snapshot()["lease"]["offset"], 0)
                        stages = [event["stage"] for event in pump_events
                                  if event["type"] == "a2a_parent_notification_pumped"]
                        self.assertIn("sdk_attempt_after", stages)
                        self.assertEqual([item.message for item in env.notification_system.message_queue.list_view()
                            if item.message == "future update"], ["future update"])
                        if kind is MessageType.USER_MESSAGE:
                            self.assertIs(env.state, EnvironmentState.RUNNING)
                            self.assertEqual(len(pending), 1)
                            self.assertIn("arrived USER update", pending[0]["content"])
                            self.assertEqual(len(runner.snapshot()["notificationDeliveryReceipts"]), 1)
                        else:
                            self.assertIs(env.state, EnvironmentState.STOPPED)
                            self.assertTrue(lifecycle_slot[-1].snapshot()["originRevoked"])
                        client.reset_child(completed=False)
                    finally:
                        runner.close()
                        lifecycle_slot[-1].close("failed")

    def test_duplicate_foreign_missing_or_non_wrapper_apps_rejected_before_socket(self):
        for kind in ("duplicate", "foreign", "missing", "native", "actor_json", "forged_expert"):
            with self.subTest(kind=kind):
                f = self.fixture()
                env, native, wrapped, _, server = f
                apps = list(wrapped)
                if kind == "duplicate": apps.append(wrapped[0])
                elif kind == "foreign": apps[0] = AppAgent(SimpleNamespace(), {}, wrapped[0].name)
                elif kind == "missing": apps = apps[:1]
                elif kind == "native": apps[0] = native[0]
                elif kind == "actor_json": apps[0] = {"name": wrapped[0].name}
                else: wrapped[0].expert_agent = lambda task: SECRET
                with self.assertRaises(OfficialA2AError):
                    self.build(f, apps=apps)
                self.assertEqual(server.sockets, [])
                self.assert_no_owner_callbacks(native)

    def test_prepared_client_cannot_begin_before_commit_legacy_still_ready(self):
        for expected in (["Contacts", "RentAFlat"], None):
            with self.subTest(expected=expected):
                f = self.fixture()
                env, _, wrapped, workspace, server = f
                with patch("gaia2_official_a2a.socket.create_connection", side_effect=server.connect), \
                        patch("gaia2_official_a2a.PrivatePipePeer", FakePeer):
                    client = OfficialA2AClient(env=env, app=wrapped[0], scenario_id="scenario-1",
                        workspace=workspace, model="controlled-model", provider="openai",
                        endpoint=ENDPOINT, api_key=SECRET, expected_app_ids=expected)
                self.clients.append(client)
                if expected is None:
                    self.one_request(client)
                    self.assertEqual(server.children, 1)
                else:
                    with self.assertRaisesRegex(OfficialA2AError, "A2A_OWNER_NOT_COMMITTED"):
                        self.one_request(client)
                    self.assertEqual(server.children, 0)

    def test_bad_prepare_or_commit_cleans_partial_native_owners_and_peers(self):
        for kind in ("prepare", "commit"):
            with self.subTest(kind=kind):
                f = self.fixture()
                if kind == "prepare": f[-1].bad_prepare_app = "RentAFlat"
                else: f[-1].bad_commit = True
                # Retain the failed object only for this trusted test: even a
                # later direct selector must not expose a partially built owner.
                pool = object.__new__(OfficialA2AClientPool)
                with patch("gaia2_official_a2a.socket.create_connection", side_effect=f[-1].connect), \
                        patch("gaia2_official_a2a.PrivatePipePeer", FakePeer), \
                        self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_INITIALIZATION_FAILED") as caught:
                    pool.__init__(**self.config(f))
                self.assertNotIn(SECRET, str(caught.exception))
                self.assertEqual(pool.snapshot()["status"], "failed")
                with self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_NOT_COMMITTED"):
                    pool.client_for("Contacts")
                self.assertTrue(f[-1].closed)
                self.assertEqual(f[-1].children, 0)
                self.assertTrue(all(peer.closed for peer in f[-1].peers))
                self.assertTrue(all(sock.closed for sock in f[-1].sockets))
                self.assert_no_owner_callbacks(f[1])
                if kind == "prepare":
                    self.assertFalse(any(method == "a2a_commit_apps" for method, _ in f[-1].events))

    def test_pool_close_drains_node_first_then_closes_every_owner_even_on_error(self):
        for failing in (False, True):
            with self.subTest(close_rpc_failure=failing):
                f = self.fixture()
                pool = self.build(f)
                server = f[-1]
                server.bad_close = failing
                before = len(server.events)
                if failing:
                    with self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_CLOSE_FAILED"):
                        pool.close()
                else:
                    pool.close()
                self.assertEqual(server.events[before], ("a2a_close_owner", "Contacts"))
                self.assertTrue(all(peer.closed for peer in server.peers))
                self.assertTrue(all(sock.closed for sock in server.sockets))
                self.assertEqual(pool.snapshot()["status"], "failed" if failing else "closed")
                self.assert_no_owner_callbacks(f[1])
                with self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_NOT_COMMITTED"):
                    pool.client_for("Contacts")
                events = len(server.events)
                pool.close()
                self.assertEqual(len(server.events), events)

    def test_late_membership_drift_or_unknown_app_cannot_select_owner(self):
        f = self.fixture()
        pool = self.build(f)
        with self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_APP_UNKNOWN"):
            pool.client_for("ActorInventedApp")
        f[0].apps["Contacts"] = AppAgent(SimpleNamespace(), {}, "Contacts")
        with self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_APP_IDENTITY_INVALID"):
            pool.client_for("Contacts")
        self.assertEqual(f[-1].children, 0)

    def test_expected_ids_and_callback_parameters_rejected_without_network(self):
        invalid_ids = ([], "Contacts", ["Contacts", "Contacts"], ["Contacts", "../escape"], ["RentAFlat"])
        for expected in invalid_ids:
            with self.subTest(expected=expected):
                f = self.fixture()
                with patch("gaia2_official_a2a.socket.create_connection", side_effect=f[-1].connect), \
                        self.assertRaisesRegex(OfficialA2AError, "A2A_OWNER_APP_IDS_INVALID"):
                    OfficialA2AClient(env=f[0], app=f[2][0], scenario_id="scenario-1", workspace=f[3],
                        model="controlled-model", provider="openai", endpoint=ENDPOINT, api_key=SECRET,
                        expected_app_ids=expected)
                self.assertEqual(f[-1].sockets, [])
        f = self.fixture()
        with self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_INITIALIZATION_FAILED"):
            self.build(f, model_event_emitter=object())
        self.assertEqual(f[-1].sockets, [])

    def test_real_a_call_routes_idle_b_cancel_before_receiving_close_ack(self):
        pool, pairs, streams, handled = self.real_router_fixture()
        clients = pool._OfficialA2AClientPool__clients
        wire.write_frame(streams[1][1], {"schemaVersion": wire.SCHEMA_VERSION,
            "channelId": "a" * 64, "bindingHash": "b" * 64, "sequence": 1,
            "kind": "request", "requestId": "2" * 32, "method": "cancel_child", "payload": None})
        # A has no incoming bytes until B's actual handler response is written.
        # Serving A alone deadlocks; the installed pool router must service B.
        result = clients["A"]._OfficialA2AClient__peer.call(
            "a2a_close_owner", None, request_id="1" * 32)
        self.assertEqual(result, {"status": "closed"})
        self.assertEqual(handled, ["B_cancelled"])
        b_ack = wire.read_frame(streams[1][0])
        self.assertEqual(b_ack["payload"], {"ok": True, "value": {"cancelled": True}})
        self.assertEqual(wire.read_frame(streams[0][0])["method"], "a2a_close_owner")
        # Explicit stream cleanup is observable as TCP EOF, not merely a
        # logically closed peer whose makefile fd references remain alive.
        clients["A"].close()
        self.assertEqual(streams[0][0].read(1), b"")

    def test_real_idle_peer_eof_fails_pool_and_blocks_later_children(self):
        pool, pairs, streams, _ = self.real_router_fixture()
        clients = pool._OfficialA2AClientPool__clients
        owners = {name: client._OfficialA2AClient__owner for name, client in clients.items()}
        for stream in streams[1]:
            stream.close()
        pairs[1][1].close()
        with self.assertRaises(wire.A2AWireError):
            clients["A"]._OfficialA2AClient__peer.call("a2a_close_owner", None, request_id="1" * 32)
        self.assertEqual(pool._OfficialA2AClientPool__status, "failed")
        with self.assertRaisesRegex(OfficialA2AError, "A2A_POOL_NOT_COMMITTED"):
            pool.client_for("A")
        for name, client in clients.items():
            self.assertIs(client._OfficialA2AClient__owner, owners[name])
            with self.assertRaisesRegex(OfficialA2AError, "A2A_OWNER_NOT_COMMITTED"):
                client.begin_child(parent_response={}, task=SECRET)


if __name__ == "__main__":
    unittest.main(verbosity=2)
