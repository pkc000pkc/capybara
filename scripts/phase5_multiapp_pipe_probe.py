"""Offline real Hook/pipe/native-owner integration, never a benchmark score.

The Node harness starts the production phase3 Hook server. This trusted fixture
uses the real official A2A pool and ARE AppAgent/native objects, but deliberately
drives the private owner instead of calling a child SDK/model loop. It exercises
scope admission, native Hook receipts, clock evidence, completion and drainage.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace
import uuid
from unittest.mock import patch
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "scripts"))

from are.simulation.agents.default_agent.app_agent import AppAgent
from are.simulation.apps.apartment_listing import Apartment, RentAFlat
from are.simulation.apps.cab import CabApp
from are.simulation.apps.calendar import Calendar
from are.simulation.apps.city import CityApp
from are.simulation.apps.contacts import Contact, Contacts
from are.simulation.apps.email_client import EmailClientV2
from are.simulation.apps.messaging_v2 import MessagingAppV2
from are.simulation.apps.sandbox_file_system import SandboxLocalFileSystem
from are.simulation.apps.shopping import Shopping
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.tool_utils import AppToolAdapter
from are.simulation.types import CompletedEvent
from gaia2_a2a_wire import A2AWireError
from gaia2_official_a2a import OfficialA2AError, connect_official_a2a_pool
from gaia2_runtime_hooks import RuntimeHookClient


def require(condition: bool, code: str) -> None:
    if not condition:
        raise AssertionError(code)


def receipt_rows(directory: Path, schema: str) -> list[dict]:
    rows = []
    for filename in sorted(directory.glob("*.json")):
        value = json.loads(filename.read_text(encoding="utf-8"))
        if value.get("schemaVersion") == schema:
            rows.append(value)
    return rows


def run_probe(workspace: Path, mode: str = "serial") -> dict:
    require(workspace.is_dir(), "WORKSPACE_REQUIRED")
    hooks = RuntimeHookClient()
    original_connect = socket.socket.connect
    allowed_ports = {urlsplit(hooks.url).port, int(os.environ["GAIA2_A2A_PIPE_PORT"])}
    network = {"externalNetworkAttempts": 0, "realModelCalls": 0}

    def loopback_only(sock, address):
        if (not isinstance(address, tuple) or address[0] != "127.0.0.1"
                or address[1] not in allowed_ports):
            network["externalNetworkAttempts"] += 1
            raise AssertionError("EXTERNAL_NETWORK_FORBIDDEN")
        return original_connect(sock, address)

    def forbid_sdk(*_args, **_kwargs):
        network["realModelCalls"] += 1
        raise AssertionError("MODEL_SDK_FORBIDDEN")

    env = Environment(EnvironmentConfig(start_time=1000, duration=None, verbose=False))
    contact = Contact("Controlled", "Person", contact_id="contact-1", is_user=True)
    apartment = Apartment("Controlled", "Local", "00001", 1200.0, 1, 1,
                          "Apartment", 500, apartment_id="apt-1")
    native_apps = {
        "Contacts": Contacts(contacts={contact.contact_id: contact}),
        "RentAFlat": RentAFlat(apartments={apartment.apartment_id: apartment}),
    }
    if mode == "full-inventory":
        # Only the name/class inventory is copied from the pinned official mini
        # fixture. States are empty controlled states, never benchmark events,
        # task text or validation answers. Files remains inside this capture.
        sandbox = workspace / "official-native-fixture-files"
        sandbox.mkdir()
        native_apps = {
            "Files": SandboxLocalFileSystem(name="Files", sandbox_dir=str(sandbox)),
            "Contacts": Contacts(name="Contacts"),
            "Messages": MessagingAppV2(name="Messages"),
            "Chats": MessagingAppV2(name="Chats"),
            "Emails": EmailClientV2(name="Emails"),
            "Calendar": Calendar(name="Calendar"),
            "RentAFlat": RentAFlat(name="RentAFlat"),
            "City": CityApp(name="City"),
            "Cabs": CabApp(name="Cabs"),
            "Shopping": Shopping(name="Shopping"),
        }
    env.register_apps(list(native_apps.values()))
    wrappers = []
    for app in native_apps.values():
        tools = {adapter.name: adapter for adapter in map(AppToolAdapter, app.get_tools())}
        # Real ARE wrapper/tool objects; this inner object must never be run.
        wrappers.append(AppAgent(SimpleNamespace(), tools, app.name))
    env.register_apps(wrappers)
    require(all(app.time_manager is env.time_manager for app in native_apps.values()),
            "SHARED_ARE_CLOCK_REQUIRED")
    pool = None
    parent_actions = []
    children = []
    negative = {}
    interleaving = {}
    inventory = {}
    a = b = reply_a = None
    cleanup = {"poolCloseAcknowledged": False, "parentAttemptEndAfterPoolClose": False}
    common_task = "Read the scoped native state and return a controlled final answer."

    def parent_allow(app_id: str, suffix: str) -> tuple[dict, dict]:
        action = {
            "id": "parent-" + suffix, "name": app_id + "__expert_agent",
            "canonicalName": "AppAgent__expert_agent", "effect": "unknown",
            "resourceKey": app_id, "arguments": {"task": common_task},
            "a2aPermission": True, "requestId": uuid.uuid4().hex,
        }
        response = hooks.invoke("before_tool", action=action,
                                loop={"runId": hooks.execution_id, "iteration": len(parent_actions)},
                                clock={"now": env.time_manager.time(), "revision": 1})
        require(response["decision"]["action"] == "allow", "PARENT_HOOK_MUST_ALLOW")
        parent_actions.append(action)
        return response, action

    def expect_rejected(name: str, operation) -> None:
        before = len(env.event_log)
        try:
            operation()
        except (OfficialA2AError, A2AWireError) as failure:
            negative[name] = {"rejected": True, "code": failure.code,
                              "nativeEventsBefore": before, "nativeEventsAfter": len(env.event_log)}
            require(before == len(env.event_log), "REJECTION_HAS_NATIVE_EFFECT")
        else:
            raise AssertionError("NEGATIVE_ACCEPTED_" + name)

    def cancel_during_native(event) -> None:
        if type(event) is not CompletedEvent or interleaving:
            return
        # The real ARE native call has reached its CompletedEvent callback,
        # but commit_native has not returned. The Node server is still awaiting
        # the native frame with nativeInFlight=true. All of this is reentrant
        # on one Python execution thread, with no worker/thread/model fixture.
        interleaving["cancelAtRealCompletedEvent"] = True
        # Use the production client cancellation seam so its successful ACK
        # also clears the local capability. A later reset must not send a
        # duplicate cancellation against an already-terminal Node handle.
        a.reset_child(completed=False)
        interleaving["cancelAcknowledgedBeforeNativeReturn"] = True
        allow_b, _ = parent_allow("RentAFlat", "b-inflight")
        expect_rejected("begin_b_during_cancelled_a_native", lambda: b.begin_child(
            parent_response=allow_b, task=common_task))
        interleaving["bBeginRejectedBeforeNativeReturn"] = True

    callback_key = "controlled-cancel-inflight"
    if mode == "cancel-inflight":
        # Register before owner capture so the production source/identity guard
        # sees the callback throughout the owner lifetime without rebinding it.
        native_apps["Contacts"].register_to_env(callback_key, cancel_during_native)

    def finish_child(client, reply: dict, action: dict) -> None:
        app_id = reply["scope"]["appId"]
        owner = client._OfficialA2AClient__owner
        peer = client._OfficialA2AClient__peer
        read_name = "get_contacts" if app_id == "Contacts" else "list_all_apartments"
        read_tool = next(tool for tool in owner.manifest()["tools"]
                         if tool["canonicalName"].endswith("__" + read_name))
        read_result = peer.call("a2a_dispatch", {"handleToken": reply["handleToken"],
                               "tool": read_tool["toolId"], "arguments": {}})
        require(read_result.get("status") == "completed", "NATIVE_READ_REQUIRED")
        finish = peer.call("a2a_dispatch", {"handleToken": reply["handleToken"],
                           "tool": "final_answer", "arguments": {"answer": "controlled native result"}})
        require(finish.get("status") == "completed" and isinstance(finish.get("completionEvidenceRef"), dict),
                "CHILD_COMPLETION_EVIDENCE_REQUIRED")
        client.reset_child(completed=True)
        parent_after = hooks.invoke("after_tool", action=action,
            loop={"runId": hooks.execution_id, "iteration": len(parent_actions) - 1},
            clock={"now": env.time_manager.time(), "revision": 1},
            outcome={"status": "succeeded", "complete": True, "executed": True,
                     "delegated": True, "resultHash": hashlib.sha256(b"controlled native result").hexdigest()})
        require(parent_after["decision"]["action"] == "allow", "PARENT_AFTER_HOOK_REQUIRED")
        children.append({"appId": app_id, "scope": reply["scope"],
                         "nativeReadDispatchId": read_result["dispatchId"],
                         "finalDispatchId": finish["dispatchId"],
                         "completionEvidenceRef": finish["completionEvidenceRef"]})
        print("MULTIAPP_PIPE_PROGRESS:" + json.dumps({"completedApps": [item["appId"] for item in children]}), flush=True)

    def run_child_cases() -> dict:
        nonlocal a, b, reply_a
        a, b = pool.client_for("Contacts"), pool.client_for("RentAFlat")
        allow_a, action_a = parent_allow("Contacts", "a1")
        if mode == "serial":
            expect_rejected("foreign_parent_receipt", lambda: b.begin_child(parent_response=allow_a, task=common_task))
        reply_a = a.begin_child(parent_response=allow_a, task=common_task)
        if mode == "serial":
            expect_rejected("foreign_peer_handle", lambda: b._OfficialA2AClient__peer.call(
                "a2a_dispatch", {"handleToken": reply_a["handleToken"], "tool": "final_answer",
                                 "arguments": {"answer": "must not execute"}}))
            allow_busy, _ = parent_allow("RentAFlat", "b-busy")
            expect_rejected("concurrent_child", lambda: b.begin_child(parent_response=allow_busy, task=common_task))
            finish_child(a, reply_a, action_a)
            allow_b, action_b = parent_allow("RentAFlat", "b1")
            reply_b = b.begin_child(parent_response=allow_b, task=common_task)
            finish_child(b, reply_b, action_b)
            allow_a2, action_a2 = parent_allow("Contacts", "a2")
            reply_a2 = a.begin_child(parent_response=allow_a2, task=common_task)
            finish_child(a, reply_a2, action_a2)
        else:
            owner, peer = a._OfficialA2AClient__owner, a._OfficialA2AClient__peer
            read = next(tool for tool in owner.manifest()["tools"]
                        if tool["canonicalName"].endswith("__get_contacts"))
            try:
                peer.call("a2a_dispatch", {"handleToken": reply_a["handleToken"],
                          "tool": read["toolId"], "arguments": {}})
            except (OfficialA2AError, A2AWireError) as failure:
                interleaving["cancelledDispatchRejected"] = True
                interleaving["cancelledDispatchErrorCode"] = failure.code
            else:
                raise AssertionError("CANCELLED_NATIVE_DISPATCH_ACCEPTED")
            require(interleaving.get("bBeginRejectedBeforeNativeReturn") is True,
                    "NATIVE_INTERLEAVING_NOT_REACHED")
            a.reset_child(completed=False)
        return pool.snapshot()

    with patch.object(socket.socket, "connect", loopback_only), \
            patch("gaia2_official_a2a._sdk_completion", forbid_sdk), \
            patch("litellm.completion", forbid_sdk):
        try:
            pool = connect_official_a2a_pool(env=env, apps=wrappers,
                scenario_id="controlled-multiapp-pipe", workspace=workspace,
                model="no-model-fixture", provider="openai", endpoint="http://127.0.0.1:1/v1",
                api_key="fixture-not-a-credential")
            require(pool.snapshot()["status"] == "committed", "POOL_COMMIT_REQUIRED")
            if mode == "full-inventory":
                app_ids = sorted(native_apps)
                require(pool.snapshot()["expectedAppIds"] == app_ids, "FULL_INVENTORY_COMMIT_REQUIRED")
                require(type(native_apps["Messages"]) is type(native_apps["Chats"])
                        and native_apps["Messages"] is not native_apps["Chats"],
                        "SAME_CLASS_DISTINCT_NAMED_APPS_REQUIRED")
                for app_id in app_ids:
                    client = pool.client_for(app_id)
                    manifest = client._OfficialA2AClient__owner.manifest()
                    wrapper = next(app for app in wrappers if app.name == app_id)
                    require(env.apps[app_id] is wrapper
                            and client._OfficialA2AClient__app is native_apps[app_id]
                            and all(adapter.app_tool.class_instance is native_apps[app_id]
                                    for adapter in wrapper.app_agent.tools.values())
                            and manifest["appId"] == app_id
                            and all(tool["resourceKey"] == app_id for tool in manifest["tools"]),
                            "FULL_INVENTORY_OWNER_BINDING_INVALID")
                    inventory[app_id] = {
                        "nativeClass": type(native_apps[app_id]).__name__,
                        "nativeType": type(native_apps[app_id]).__module__ + "." + type(native_apps[app_id]).__qualname__,
                        "manifestAppId": manifest["appId"],
                        "dispatchableAppTools": sum(tool["toolKind"] == "app_tool" for tool in manifest["tools"]),
                        "finalAnswerTools": sum(tool["toolKind"] == "child_final_answer" for tool in manifest["tools"]),
                    }
                first = pool.client_for(app_ids[0])
                expect_rejected("duplicate_pool_commit", lambda: first._OfficialA2AClient__peer.call(
                    "a2a_commit_apps", {"appIds": app_ids}))
                shopping = pool.client_for("Shopping")
                excluded = shopping.snapshot()["excludedTools"]
                require(excluded["appId"] == "Shopping" and excluded["toolCount"] == 0
                        and excluded["tools"] == [], "SHOPPING_FULL_INVENTORY_REQUIRED")
                require(inventory["Shopping"]["dispatchableAppTools"] == 12
                        and inventory["Shopping"]["finalAnswerTools"] == 1,
                        "SHOPPING_ORIGINAL_TOOLS_MUST_REMAIN_USABLE")
                getter = next(tool for tool in shopping.native_manifest()["tools"]
                    if tool["publicName"] == "Shopping__get_all_discount_codes")
                require(getter["completionEvidenceKind"] == "source_pinned_return"
                        and getter["sourcePinId"] == "are-1.2-shopping-discount-codes-read-v1",
                        "SHOPPING_READ_REQUIRES_FIXED_SOURCE_RETURN")
                originals = native_apps["Shopping"].get_tools()
                require(len(originals) == 12
                        and next(tool for tool in originals if tool.name == getter["publicName"]).write_operation is None,
                        "SHOPPING_ORIGINAL_METADATA_MUST_REMAIN_UNCHANGED")
                inventory["Shopping"]["excludedTools"] = excluded
                snapshot = pool.snapshot()
            else:
                snapshot = run_child_cases()
            require(all(item["modelRequests"] == 0 and item["sdkAttempts"] == 0 for item in snapshot["clients"]),
                    "PRIVATE_OWNER_PROBE_MUST_NOT_CALL_MODEL")
        finally:
            if pool is not None:
                pool.close()
                cleanup["poolCloseAcknowledged"] = pool.snapshot()["status"] == "closed"
            if mode == "cancel-inflight":
                native_apps["Contacts"].add_event_callbacks.pop(callback_key, None)

        # This call deliberately happens after the pool has drained/closed all
        # App pipes. Child authority must close without killing parent Hooks.
        ended = hooks.invoke("attempt_end", loop={"runId": hooks.execution_id,
            "iteration": len(parent_actions), "terminal": True, "terminationReason": "controlled_fixture_complete"},
            clock={"now": env.time_manager.time(), "revision": 1},
            outcome={"status": "succeeded", "complete": True})
        cleanup["parentAttemptEndAfterPoolClose"] = ended["decision"]["action"] == "allow"
        require(cleanup["parentAttemptEndAfterPoolClose"], "PARENT_HOOK_MUST_SURVIVE_POOL_CLOSE")

    registry = receipt_rows(workspace / "plugin-delegation", "capybara-runtime-delegation-receipt-v1")
    require(registry and registry[-1].get("kind") == "closed", "REGISTRY_MUST_DRAIN")
    native = {}
    for name, app in native_apps.items():
        rows = receipt_rows(workspace / ("a2a-native-" + name) / "json", "gaia2-private-native-clock-receipt-v1")
        clocks = sorted(rows, key=lambda row: row["clock"]["revision"])
        require((clocks or mode == "full-inventory" or mode == "cancel-inflight" and name == "RentAFlat")
                and [row["clock"]["revision"] for row in clocks] == list(range(1, len(clocks) + 1)),
                "PER_APP_CLOCK_SEQUENCE_INVALID")
        returns = receipt_rows(workspace / ("a2a-native-" + name) / "json", "gaia2-private-native-return-v1")
        require(all(row["status"] == "succeeded" for row in returns), "NATIVE_RETURNS_MUST_SUCCEED")
        require(list(app.add_event_callbacks) == ["environment"], "OWNER_CALLBACK_CLEANUP_REQUIRED")
        native[name] = {"clockRevisions": [row["clock"]["revision"] for row in clocks],
                        "nativeReturns": len(returns), "callbacksAfterClose": list(app.add_event_callbacks)}
    events = env.event_log.list_view()
    require(all(type(event) is CompletedEvent for event in events), "REAL_COMPLETED_EVENTS_REQUIRED")
    expected_events = {"Contacts": 2, "RentAFlat": 1} if mode == "serial" else {} if mode == "full-inventory" else {"Contacts": 1}
    require(dict(Counter(event.action.app.name for event in events)) == expected_events,
            "REAL_NATIVE_EVENT_COUNTS_INVALID")
    return {"schemaVersion": "gaia2-multiapp-pipe-probe-v1", "status": "passed",
        "syntheticFixtureOnly": True, "controlledPrivateOwnerProbe": True,
        "benchmarkExecuted": False, "officialSubmissionReady": False,
        **network, "mode": mode, "interleaving": interleaving, "inventory": inventory,
        "parallelFixtureThreads": 0, "sharedAREClock": True, "appOrder": [item["appId"] for item in children],
        "poolBeforeClose": snapshot, "poolAfterClose": pool.snapshot(), "children": children,
        "negativeCases": negative, "native": native, "cleanup": cleanup,
        "realNativeEventCounts": dict(Counter(event.action.app.name for event in events)),
        "parentReceiptCount": len(parent_actions), "registryClosed": True}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--mode", choices=("serial", "cancel-inflight", "full-inventory"), default="serial")
    args = parser.parse_args()
    report = run_probe(args.workspace.absolute(), args.mode)
    print("MULTIAPP_PIPE_PROBE:" + json.dumps(report, ensure_ascii=False, sort_keys=True), flush=True)
