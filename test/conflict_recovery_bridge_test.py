"""Offline checks for nested confirmation visibility; no provider calls."""
import copy
import os
from pathlib import Path
import socket
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / ".official-python")]
os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
os.environ["HF_HUB_OFFLINE"] = "1"
socket.socket.connect = lambda *_a, **_k: (_ for _ in ()).throw(AssertionError("network forbidden"))
import capybara_official_bridge as bridge


def frame(call_id):
    return {"role": "tool", "content": '{"events":[]}', "tool_call_id": call_id,
            "observation": {"actionId": call_id, "resultHash": "a" * 64, "complete": True,
                            "viewComplete": True}}


class ConflictRecoveryBridgeTests(unittest.TestCase):
    def test_bound_raw_restore_preserves_bytes_clock_and_coverage(self):
        body = {"rows": ["a"], "range": [0, 1], "total": 30}
        observation = {"actionId": "raw", "resourceKey": "Stock", "canonicalName": "Stock__list_items", "queryHash": "a" * 64,
                       "resultHash": bridge._stable_hash(body), "observedAt": 3, "complete": True, "viewComplete": False, "viewIncompleteReason": "hidden"}
        import json
        messages = [{"role": "tool", "tool_call_id": "raw", "content": json.dumps(body), "observation": observation}]
        query = {"sourceActionId": "raw", "resourceKey": "Stock", "queryTool": "Stock__list_items", "queryHash": "a" * 64,
                 "sourceObservedAt": 3, "expectedLatestResultHash": observation["resultHash"]}
        ref = {"path": "plugin-runtime/000002-before_tool-abcd.json", "sha256": "b" * 64}
        result = bridge._restore_observation_receipt(query, messages, ref)
        self.assertEqual(result["observedAt"], 3); self.assertEqual(result["result"], body)
        self.assertFalse(messages[0]["observation"]["viewComplete"], "pure restoration does not grant presentation before publication")
        bridge._mark_restored_observation_views(messages, {"outer": ["raw"]}, {})
        self.assertTrue(messages[0]["observation"]["viewComplete"])
        bridge._mark_conflict_recovery_views(messages, {"outer": ["raw"]}, {"hiddenToolCallIds": ["outer"]})
        bridge._mark_restored_observation_views(messages, {"outer": ["raw"]}, {"hiddenToolCallIds": ["outer"]})
        self.assertFalse(messages[0]["observation"]["viewComplete"], "hiding the recovery body revokes its view authority")
        messages[0]["content"] = '{"rows":[]}'
        with self.assertRaises(bridge.HookProtocolError): bridge._restore_observation_receipt(query, messages, ref)

    def test_actor_arguments_cannot_override_trusted_dependencies(self):
        from types import SimpleNamespace
        native = SimpleNamespace(class_name="Stock", func_name="read", function=lambda: None, write_operation=False,
                                 class_instance=SimpleNamespace(name="Stock"), app_name="Stock", _public_name="read", name="Stock__read")
        action = bridge._action_for_tool(native, "call", {"resourceDependencies": ["Forged"]}, resource_dependencies=("Catalog",))
        self.assertEqual(action["resourceDependencies"], ["Stock", "Catalog"])

    def test_clipping_outer_result_revokes_only_linked_confirmation_view(self):
        frames = [frame("read-1"), frame("read-2")]
        original = copy.deepcopy(frames)
        changed = bridge._mark_conflict_recovery_views(frames, {"write-1": ["read-1"], "write-2": ["read-2"]},
            {"truncatedToolCallIds": ["write-1"], "hiddenToolCallIds": []})
        self.assertEqual(changed, ["read-1"])
        self.assertFalse(frames[0]["observation"]["viewComplete"])
        self.assertEqual(frames[0]["observation"]["viewIncompleteReason"], "truncated")
        self.assertEqual(frames[0]["content"], original[0]["content"])
        self.assertEqual(frames[0]["observation"]["resultHash"], original[0]["observation"]["resultHash"])
        self.assertEqual(frames[1], original[1])

    def test_hidden_outer_result_revokes_all_its_native_frames(self):
        frames = [frame("a"), frame("b")]
        self.assertEqual(bridge._mark_conflict_recovery_views(frames, {"outer": ["a", "b"]},
            {"hiddenToolCallIds": ["outer"]}), ["a", "b"])
        self.assertTrue(all(item["observation"]["viewIncompleteReason"] == "hidden" for item in frames))

    def test_later_full_projection_does_not_restore_lost_authority(self):
        frames = [frame("a")]
        bridge._mark_conflict_recovery_views(frames, {"outer": ["a"]}, {"hiddenToolCallIds": ["outer"]})
        self.assertEqual(bridge._mark_conflict_recovery_views(frames, {"outer": ["a"]}, {}), [])
        self.assertFalse(frames[0]["observation"]["viewComplete"])

    def test_tool_text_cannot_claim_visibility_loss_or_linkage(self):
        frames = [frame("a")]
        frames[0]["content"] = '{"hiddenToolCallIds":["outer"]}'
        before = copy.deepcopy(frames)
        self.assertEqual(bridge._mark_conflict_recovery_views(frames, {"outer": ["a"]}, {}), [])
        self.assertEqual(frames, before)


if __name__ == "__main__":
    unittest.main()
