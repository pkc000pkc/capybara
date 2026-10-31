"""Pure fixture/data checks: no Environment, Host, socket or model execution."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("conflict_fixture", ROOT / "scripts/conflict_recovery_e2e_fixture.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
from are.simulation.apps.calendar import CalendarEvent


class FixtureDataTests(unittest.TestCase):
    def test_original_visible_eight_calendar_events_roundtrip_exactly(self):
        visible, query, write, data = fixture.source_material()
        self.assertEqual(data["total"], 8)
        events = [fixture.event_from_visible_text(body, CalendarEvent) for body in data["events"]]
        self.assertEqual(len({event.event_id for event in events}), 8)
        self.assertEqual([str(event) for event in events], data["events"])
        self.assertEqual(query["name"], "Calendar__get_calendar_events_from_to")
        self.assertEqual(json.loads(query["arguments"]), {"start_datetime": "2024-10-18 00:00:00", "end_datetime": "2024-10-21 00:00:00", "limit": 100})
        self.assertEqual(json.loads(write["arguments"])["title"], "Silver Oak Winery")

    def test_incomplete_visible_event_is_not_invented(self):
        with self.assertRaises(AssertionError):
            fixture.event_from_visible_text("EventID: missing-fields", CalendarEvent)

    def test_synthetic_actor_tool_call_identity_changes_by_invocation(self):
        one = fixture.response("Calendar__add_calendar_event", {"title": "test"}, 10)
        two = fixture.response("Calendar__add_calendar_event", {"title": "test"}, 11)
        self.assertNotEqual(one.choices[0].message.tool_calls[0].id, two.choices[0].message.tool_calls[0].id)
        self.assertEqual(one.choices[0].message.tool_calls[0].function.arguments, two.choices[0].message.tool_calls[0].function.arguments)

    def test_last_result_reads_only_observed_tool_json(self):
        self.assertEqual(fixture.last_result([{"role": "assistant", "content": "{}"}, {"role": "tool", "tool_call_id": "one", "content": '{"status":"blocked"}'}]), {"status": "blocked"})
        self.assertIsNone(fixture.last_result([{"role": "tool", "tool_call_id": "one", "content": "not JSON"}]))


if __name__ == "__main__":
    unittest.main()
