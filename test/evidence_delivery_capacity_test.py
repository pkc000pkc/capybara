"""Synthetic evidence capacity tests with the retained real tool schemas only.

The historical input is used exclusively as a 103-tool schema inventory. No
historical messages, task text, answers, results or business traces are used.
Projection, protected compaction and tool-schema focusing execute real code.
"""
import ast
import copy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / "test")]
from gaia2_evidence_delivery import project_evidence
from evidence_delivery_bridge_test import production_helpers
from evidence_delivery_projection_test import fixture


REGISTRY_PATH = ROOT / "runs" / "conflict-recovery-official-one-20261026T024302021Z-069bc32b" / "task-02" / "output" / "model-evidence" / "model-000001-input.json"
CONTROL_NAMES = {"capybara_evidence_read", "capybara_evidence_select_tools"}


class CapacityProtocolError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def wire_bytes(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))


def real_tools_only():
    # Extract only schemas; deliberately never expose/use the other envelope fields.
    return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))["tools"]


def local_control_schemas(tree):
    result = {}
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute) or node.func.attr != "append" or len(node.args) != 1:
            continue
        try:
            value = ast.literal_eval(node.args[0])
        except (ValueError, TypeError):
            continue
        if isinstance(value, dict) and value.get("function", {}).get("name") in CONTROL_NAMES:
            result[value["function"]["name"]] = value
    if set(result) != CONTROL_NAMES:
        raise AssertionError("Current Bridge must expose both complete local evidence-control schemas")
    return list(result.values())


def actual_focused_tools(tree, all_tools, names):
    """Execute the Bridge's schema-selection AST, not a copied implementation."""
    assignment = next(node for node in ast.walk(tree) if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == "actor_tools" for target in node.targets)
                      and isinstance(node.value, ast.Name) and node.value.id == "openai_tools")
    selection = next(node for node in ast.walk(tree) if isinstance(node, ast.If)
                     and ast.unparse(node.test) == "evidence_focused_tools is not None")
    context = {"openai_tools": all_tools, "evidence_focused_tools": set(names) if names is not None else None}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[assignment, selection], type_ignores=[])), "bridge-tool-focus", "exec"), context)
    return context["actor_tools"]


def native_frames(chunks, body):
    first = next(iter(chunks.values()))
    fields = ("actionId", "canonicalName", "resourceKey", "queryHash", "resultHash", "observedAt", "complete")
    return [{"role": "tool", "tool_call_id": first["actionId"], "content": json.dumps(body, ensure_ascii=False),
             "observation": {**{key: first[key] for key in fields}, "viewComplete": False, "viewIncompleteReason": "hidden"}}]


class EvidenceDeliveryCapacityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tree = ast.parse((ROOT / "scripts" / "capybara_official_bridge.py").read_text(encoding="utf-8"))
        cls.registry = real_tools_only()
        cls.controls = local_control_schemas(cls.tree)
        cls.all_tools = cls.registry + cls.controls
        cls.helpers = production_helpers()
        cls.helpers["HookProtocolError"] = CapacityProtocolError

    def projected(self, domain="Warehouse", size=80000):
        # Different synthetic domains use the same generic capacity contract.
        body = {"domain": domain, "records": [{"id": domain + "-synthetic", "data": "x" * size}], "total": 1}
        messages, chunks, deliveries, body = fixture(domain, body)
        deliveries[next(iter(deliveries))]["coverage"] = []
        projected, data, proofs = project_evidence(messages, chunks, deliveries, "user")
        self.assertEqual(len(data), 1)
        self.assertEqual(len(proofs), 1)
        # Match production ordering: original system, dynamic context, history,
        # protected data, and the full discoverable name-only catalog.
        actor_input = [projected[0], {"role": "system", "content": "Live synthetic dynamic context."}, *projected[1:], *data,
                       {"role": "system", "content": "Full discoverable tool catalog: " + json.dumps([tool["function"]["name"] for tool in self.all_tools])}]
        return actor_input, data, proofs, chunks, deliveries, body

    def assert_capacity_blocked(self, actor_input, tools, protected):
        original = copy.deepcopy((actor_input, tools, protected))
        with self.assertRaises(CapacityProtocolError) as caught:
            self.helpers["_compact_model_input"](actor_input, tools, protected_context=protected)
        self.assertEqual(caught.exception.code, "evidence_delivery_capacity_blocked")
        self.assertEqual((actor_input, tools, protected), original, "capacity refusal cannot clip or mutate protected data")

    def test_retained_real_schema_inventory_is_103_tools_and_55152_wire_bytes(self):
        self.assertEqual(len(self.registry), 103)
        self.assertEqual(wire_bytes(self.registry), 55152)
        self.assertTrue(all(tool.get("type") == "function" and isinstance(tool.get("function", {}).get("parameters"), dict)
                            for tool in self.registry))

    def test_full_real_registry_plus_complete_80kb_data_cannot_fit_and_fails_explicitly(self):
        actor_input, data, *_ = self.projected()
        self.assertGreater(self.helpers["_model_wire_bytes"](actor_input, self.registry), 120000)
        self.assert_capacity_blocked(actor_input, self.registry, data)

    def test_focused_2_to_8_unchanged_schemas_plus_controls_preserve_complete_cross_domain_data(self):
        selections = (
            ("Warehouse", ["Shopping__list_all_products", "Shopping__get_product_details"]),
            ("AddressBook", ["Contacts__get_contacts", "Contacts__get_contact", "Contacts__search_contacts", "Contacts__edit_contact"]),
            ("Reservations", ["Calendar__add_calendar_event", "Calendar__get_calendar_event", "Calendar__delete_calendar_event",
                              "Calendar__get_calendar_events_from_to", "Calendar__read_today_calendar_events", "Calendar__get_all_tags",
                              "Calendar__get_calendar_events_by_tag", "Calendar__search_events"]),
        )
        original_catalog = copy.deepcopy(self.all_tools)
        by_name = {tool["function"]["name"]: tool for tool in self.all_tools}
        for domain, names in selections:
            with self.subTest(domain=domain, requestedSchemas=len(names)):
                actor_input, data, proofs, chunks, deliveries, body = self.projected(domain)
                focused = actual_focused_tools(self.tree, self.all_tools, names)
                focus_names = {tool["function"]["name"] for tool in focused}
                self.assertTrue(set(names) <= focus_names)
                self.assertTrue(CONTROL_NAMES <= focus_names)
                self.assertTrue({"capybara_wait_watch", "capybara_task_obligation_step", "SystemApp__get_current_time",
                                 "SystemApp__wait_for_notification", "AgentUserInterface__send_message_to_user"} <= focus_names)
                for tool in focused:
                    self.assertEqual(tool, by_name[tool["function"]["name"]], "focus must retain every original description and parameter constraint")
                compacted, receipt = self.helpers["_compact_model_input"](actor_input, focused, protected_context=data)
                self.assertTrue(receipt["compacted"])
                self.assertLessEqual(receipt["compactedBytes"], 120000)
                self.assertLessEqual(len(compacted), 80)
                self.assertTrue(all(message in compacted for message in data))
                payload = json.loads(data[0]["content"].split("\n", 1)[1])
                self.assertEqual(payload["originalResult"], body)
                frames = native_frames(chunks, body)
                self.helpers["_mark_evidence_delivery_views"](frames, deliveries, chunks, compacted, proofs)
                self.assertTrue(frames[0]["observation"]["viewComplete"])
                self.assertTrue(next(iter(deliveries.values()))["coverage"][0]["covered"])
        self.assertEqual(self.all_tools, original_catalog, "focus presentation cannot mutate the full available schemas")

    def test_omitted_or_byte_changed_projection_revokes_coverage_despite_retained_proofs_and_references(self):
        actor_input, data, proofs, chunks, deliveries, body = self.projected()
        focused = actual_focused_tools(self.tree, self.all_tools, ["Shopping__list_all_products", "Shopping__get_product_details"])
        compacted, _ = self.helpers["_compact_model_input"](actor_input, focused, protected_context=data)
        frames = native_frames(chunks, body)
        self.helpers["_mark_evidence_delivery_views"](frames, deliveries, chunks, compacted, proofs)
        self.assertTrue(frames[0]["observation"]["viewComplete"])
        for modified in ([message for message in compacted if message not in data],
                         [{**message, "content": message["content"] + " "} if message in data else message for message in compacted]):
            with self.subTest(projectionPresent=any(message in modified for message in data)):
                self.helpers["_mark_evidence_delivery_views"](frames, deliveries, chunks, modified, proofs)
                self.assertFalse(frames[0]["observation"]["viewComplete"])
                self.assertFalse(next(iter(deliveries.values()))["coverage"][0]["covered"])

    def test_one_megabyte_protected_original_is_explicitly_blocked_without_increasing_budget(self):
        actor_input, data, *_ = self.projected("Reservations", 1048576)
        focused = actual_focused_tools(self.tree, self.all_tools, ["Calendar__get_calendar_event", "Calendar__add_calendar_event"])
        self.assertGreater(len(data[0]["content"].encode("utf-8")), 1048576)
        self.assert_capacity_blocked(actor_input, focused, data)
        self.assertEqual(self.helpers["_MODEL_INPUT_MAX_BYTES"], 120000)
        self.assertEqual(self.helpers["_MODEL_INPUT_MAX_MESSAGES"], 80)

    def test_focus_never_removes_full_catalog_and_none_restores_all_original_schemas(self):
        focused = actual_focused_tools(self.tree, self.all_tools, ["Contacts__get_contacts", "Contacts__get_contact"])
        self.assertLess(len(focused), len(self.all_tools))
        self.assertEqual(actual_focused_tools(self.tree, self.all_tools, None), self.all_tools)
        self.assertIn("Calendar__add_calendar_event", [tool["function"]["name"] for tool in self.all_tools])

    def test_protected_context_must_be_an_exact_system_message_present_in_request(self):
        messages = [{"role": "system", "content": "system"}, {"role": "user", "content": "synthetic request"}]
        for protected in ([{"role": "system", "content": "not in request"}], [messages[1]]):
            with self.assertRaises(CapacityProtocolError) as caught:
                self.helpers["_compact_model_input"](messages, [], protected_context=protected)
            self.assertEqual(caught.exception.code, "evidence_delivery_protected_context_binding")


if __name__ == "__main__":
    unittest.main()
