"""Offline real-ARE entity calls only: no model, benchmark or old campaign."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / ".official-python"))

import gaia2_entity_evidence as evidence
from are.simulation.apps.calendar import Calendar, CalendarApp, CalendarEvent
from are.simulation.apps.calendar_v2 import CalendarV2
from are.simulation.apps.contacts import Contact, Contacts, ContactsApp, InternalContacts
from are.simulation.environment import Environment, EnvironmentConfig
from are.simulation.tool_utils import AppTool
from are.simulation.types import EventRegisterer


class FaultStorage(dict):
    """Faults happen inside the real getter, without replacing official code."""
    def __init__(self, values, failure):
        super().__init__(values)
        self.failure = failure

    def __contains__(self, key):
        raise self.failure


class EntityEvidenceTests(unittest.TestCase):
    def setUp(self):
        connection = patch.object(socket.socket, "connect", side_effect=AssertionError("network_forbidden"))
        connection.start()
        self.addCleanup(connection.stop)
        self.calendar = Calendar(events={
            "event-a": CalendarEvent("event-a", "A", 1200, 1400),
            "event-b": CalendarEvent("event-b", "B", 1500, 1600),
        })
        self.contacts = Contacts(contacts={
            "contact-a": Contact("Alice", "Example", contact_id="contact-a"),
            "contact-b": Contact("Bob", "Example", contact_id="contact-b"),
        })
        self.env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        self.env.register_apps([self.calendar, self.contacts])
        self.tracker = evidence.EntityEvidenceTracker("execution-test", "session-test")
        self.index = 0

    def action(self, app, method, entity_id, **changes):
        tool = next(item for item in app.get_tools() if item.func_name == method)
        self.index += 1
        arguments = {"event_id" if method.endswith("calendar_event") else "contact_id": entity_id}
        write = method.startswith("delete_")
        action = {"id": "call-" + str(self.index), "name": tool._public_name,
                  "canonicalName": type(app).__name__ + "__" + method,
                  "effect": "write" if write else "read", "arguments": arguments,
                  "mutationKey": evidence._hash({"tool": tool.name, "arguments": arguments}),
                  "resourceKey": app.name, "idempotent": not write,
                  "authoritativeRead": not write}
        action.update(changes)
        return tool, action

    def execute(self, app, method, entity_id, tracker=None):
        tracker = tracker or self.tracker
        tool, action = self.action(app, method, entity_id)
        binding = tracker.prepare(tool, action)
        error = None
        try:
            raw = tool(**action["arguments"])
        except Exception as native_error:
            error = native_error
            result = {"status": "failed_before_execution", "errorType": type(error).__name__}
            outcome = {"status": "failed_before_execution", "complete": True, "executed": True}
        else:
            result = json.loads(json.dumps(raw, default=str))
            outcome = {"status": "succeeded", "complete": True, "executed": True}
        outcome["resultHash"] = evidence._hash(result)
        original = copy.deepcopy(outcome)
        semantic = tracker.complete(binding, outcome, result=result, error=error,
                                    observed_at=self.env.time_manager.time())
        self.assertEqual(outcome, original, "core must not normalize raw outcome")
        return semantic, result, error

    def test_01_calendar_delete_then_exact_native_missing_has_link(self):
        deleted, _, error = self.execute(self.calendar, "delete_calendar_event", "event-a")
        self.assertIsNone(error)
        self.assertEqual(deleted["kind"], "delete_succeeded")
        missing, raw, error = self.execute(self.calendar, "get_calendar_event", "event-a")
        self.assertIs(type(error), ValueError)
        self.assertEqual(raw["status"], "failed_before_execution")
        self.assertEqual(missing["kind"], "entity_absent")
        self.assertEqual(missing["deleteReceiptRef"], deleted["deleteReceiptRef"])
        self.assertEqual(missing["nativeProof"], {"kind": "missing_branch", "exceptionType": "ValueError", "branchLine": 279})
        self.assertNotIn("nativeVersion", json.dumps(missing))

    def test_02_contacts_delete_and_missing_keyerror_are_supported(self):
        deleted, _, _ = self.execute(self.contacts, "delete_contact", "contact-a")
        absent, _, error = self.execute(self.contacts, "get_contact", "contact-a")
        self.assertEqual(absent["entityRef"], {"resourceKey": "Contacts", "entityType": "Contact", "entityId": "contact-a"})
        self.assertIs(type(error), KeyError)
        self.assertEqual(absent["deleteReceiptRef"], deleted["deleteReceiptRef"])
        self.assertEqual(absent["nativeProof"]["branchLine"], 221)

    def test_03_prepare_does_not_execute_or_inspect_storage(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        class NoInspection:
            def __getattribute__(self, name):
                raise AssertionError("storage_must_not_be_read")
        self.calendar.events = NoInspection()
        before = len(self.env.event_log)
        self.assertIsNotNone(self.tracker.prepare(tool, action))
        self.assertEqual(len(self.env.event_log), before)

    def test_04_native_missing_without_delete_is_not_verification(self):
        absent, _, error = self.execute(self.calendar, "get_calendar_event", "not-there")
        self.assertIs(type(error), ValueError)
        self.assertIsNone(absent)

    def test_05_other_entity_cannot_borrow_successful_delete(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        absent, _, _ = self.execute(self.calendar, "get_calendar_event", "another-missing")
        self.assertIsNone(absent)

    def test_06_other_resource_alias_cannot_borrow_receipt(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        other = Calendar(name="OtherCalendar")
        self.env.register_apps([other])
        absent, _, _ = self.execute(other, "get_calendar_event", "event-a")
        self.assertIsNone(absent)

    def test_07_other_session_cannot_borrow_receipt(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        absent, _, _ = self.execute(self.calendar, "get_calendar_event", "event-a",
                                    evidence.EntityEvidenceTracker("execution-test", "other-session"))
        self.assertIsNone(absent)

    def test_08_native_present_read_revokes_prior_delete_link(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        self.calendar.events["event-a"] = CalendarEvent("event-a", "Recreated", 1200, 1400)
        present, _, _ = self.execute(self.calendar, "get_calendar_event", "event-a")
        self.assertEqual(present["kind"], "entity_present")
        self.assertIsNone(present["deleteReceiptRef"])
        del self.calendar.events["event-a"]  # An external deletion is not our receipt.
        absent, _, _ = self.execute(self.calendar, "get_calendar_event", "event-a")
        self.assertIsNone(absent)

    def test_09_new_delete_has_distinct_receipt_not_native_version(self):
        first, _, _ = self.execute(self.contacts, "delete_contact", "contact-a")
        self.contacts.contacts["contact-a"] = Contact("New", "Person", contact_id="contact-a")
        second, _, _ = self.execute(self.contacts, "delete_contact", "contact-a")
        absent, _, _ = self.execute(self.contacts, "get_contact", "contact-a")
        self.assertNotEqual(first["deleteReceiptRef"]["receiptId"], second["deleteReceiptRef"]["receiptId"])
        self.assertEqual(absent["deleteReceiptRef"], second["deleteReceiptRef"])

    def test_10_resource_invalidation_retains_other_resource(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        self.execute(self.contacts, "delete_contact", "contact-a")
        self.tracker.invalidate(resource_key="Calendar")
        self.assertIsNone(self.execute(self.calendar, "get_calendar_event", "event-a")[0])
        self.assertEqual(self.execute(self.contacts, "get_contact", "contact-a")[0]["kind"], "entity_absent")

    def test_11_entity_specific_and_all_invalidation(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        self.execute(self.calendar, "delete_calendar_event", "event-b")
        self.tracker.invalidate(entity_type="CalendarEvent", entity_id="event-a")
        self.assertIsNone(self.execute(self.calendar, "get_calendar_event", "event-a")[0])
        self.tracker.invalidate()
        self.assertIsNone(self.execute(self.calendar, "get_calendar_event", "event-b")[0])

    def test_12_permission_failure_is_not_absence(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        self.calendar.events = FaultStorage(self.calendar.events, PermissionError("denied"))
        semantic, _, error = self.execute(self.calendar, "get_calendar_event", "event-a")
        self.assertIs(type(error), PermissionError)
        self.assertIsNone(semantic)

    def test_13_same_valueerror_text_from_storage_is_not_missing_branch(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        self.calendar.events = FaultStorage(self.calendar.events, ValueError("Calendar Event with id event-a does not exist."))
        semantic, _, error = self.execute(self.calendar, "get_calendar_event", "event-a")
        self.assertIs(type(error), ValueError)
        self.assertIsNone(semantic)

    def test_14_timeout_is_not_absence(self):
        self.execute(self.contacts, "delete_contact", "contact-a")
        self.contacts.contacts = FaultStorage(self.contacts.contacts, TimeoutError("deadline"))
        self.assertIsNone(self.execute(self.contacts, "get_contact", "contact-a")[0])

    def test_15_unknown_failure_is_not_absence(self):
        self.execute(self.contacts, "delete_contact", "contact-a")
        self.contacts.contacts = FaultStorage(self.contacts.contacts, RuntimeError("unknown"))
        self.assertIsNone(self.execute(self.contacts, "get_contact", "contact-a")[0])

    def test_16_monkeypatched_official_method_is_unsupported(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        with patch.object(CalendarApp, "get_calendar_event", lambda self, event_id: None):
            self.assertIsNone(self.tracker.prepare(tool, action))

    def test_17_tool_subclass_is_not_authority(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        class FakeTool(AppTool):
            pass
        tool.__class__ = FakeTool
        self.assertIsNone(self.tracker.prepare(tool, action))

    def test_18_forged_action_identity_does_not_pin(self):
        for key, value in (("canonicalName", "Calendar__other"), ("resourceKey", "Other"),
                           ("mutationKey", "0" * 64), ("effect", "write"), ("authoritativeRead", False)):
            tool, action = self.action(self.calendar, "get_calendar_event", "event-a", **{key: value})
            self.assertIsNone(self.tracker.prepare(tool, action), key)

    def test_19_only_one_exact_typed_entity_argument(self):
        for args in ({"event_id": ""}, {"event_id": 1}, {"event_id": "a", "extra": True}, {"other": "a"}):
            tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
            action["arguments"] = args
            action["mutationKey"] = evidence._hash({"tool": tool.name, "arguments": args})
            self.assertIsNone(self.tracker.prepare(tool, action))

    def test_20_changed_source_pin_is_unsupported(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        with patch.dict(evidence.SOURCE_PINS, {"simulation/apps/calendar.py": ("0" * 64, 16748)}):
            self.assertIsNone(self.tracker.prepare(tool, action))

    def test_21_loaded_code_change_is_not_hidden_by_same_source_file(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        leaf = tool.function.__wrapped__.__wrapped__
        def replacement(self, event_id):
            raise ValueError("does not exist")
        original_code = leaf.__code__
        try:
            leaf.__code__ = replacement.__code__
            self.assertIsNone(self.tracker.prepare(tool, action))
        finally:
            leaf.__code__ = original_code

    def test_22_same_text_foreign_exception_without_native_chain_rejected(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        binding = self.tracker.prepare(tool, action)
        try:
            raise ValueError("Calendar Event with id event-a does not exist.")
        except ValueError as error:
            result = {"errorType": "ValueError"}
            outcome = {"status": "failed_before_execution", "complete": True, "executed": True,
                       "resultHash": evidence._hash(result)}
            self.assertIsNone(self.tracker.complete(binding, outcome, result=result, error=error,
                                                   observed_at=self.env.time_manager.time()))

    def test_23_missing_keyerror_from_wrong_storage_leaf_rejected(self):
        self.execute(self.contacts, "delete_contact", "contact-a")
        self.contacts.contacts = FaultStorage(self.contacts.contacts, KeyError("Contact contact-a does not exist."))
        self.assertIsNone(self.execute(self.contacts, "get_contact", "contact-a")[0])

    def test_24_augmented_random_failure_tool_does_not_pin(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        tool.failure_probability = 0.1
        self.assertIsNone(self.tracker.prepare(tool, action))

    def test_25_binding_cannot_be_reused_or_cross_session(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        binding = self.tracker.prepare(tool, action)
        outcome = {"status": "succeeded", "complete": True, "executed": True, "resultHash": evidence._hash("x")}
        other = evidence.EntityEvidenceTracker("execution-test", "other-session")
        with self.assertRaises(evidence.EntityEvidenceError):
            other.complete(binding, outcome, result="x", observed_at=1000)
        self.assertIsNone(self.tracker.complete(binding, outcome, result="x", observed_at=1000))
        with self.assertRaises(evidence.EntityEvidenceError):
            self.tracker.complete(binding, outcome, result="x", observed_at=1000)
        with self.assertRaises(evidence.EntityEvidenceError):
            self.tracker.prepare(tool, action)

    def test_26_result_hash_mismatch_is_protocol_error(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        binding = self.tracker.prepare(tool, action)
        with self.assertRaises(evidence.EntityEvidenceError) as caught:
            self.tracker.complete(binding, {"status": "succeeded", "complete": True, "executed": True,
                                  "resultHash": "0" * 64}, result="value", observed_at=1000)
        self.assertEqual(caught.exception.code, "outcome")

    def test_27_bad_or_backwards_clock_fails_closed(self):
        for value in (float("nan"), float("inf"), -1, True):
            tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
            binding = self.tracker.prepare(tool, action)
            with self.assertRaises(evidence.EntityEvidenceError):
                self.tracker.complete(binding, {}, observed_at=value)
        self.execute(self.calendar, "get_calendar_event", "event-a")
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        with self.assertRaises(evidence.EntityEvidenceError):
            self.tracker.complete(self.tracker.prepare(tool, action), {}, observed_at=1)

    def test_28_native_capture_mode_cannot_claim_execution(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        with EventRegisterer.capture_mode():
            self.assertIsNone(self.tracker.prepare(tool, action))

    def test_29_patched_native_dispatch_wrapper_rejected(self):
        tool, action = self.action(self.calendar, "get_calendar_event", "event-a")
        with patch.object(AppTool, "__call__", lambda self, **kwargs: "fake"):
            self.assertIsNone(self.tracker.prepare(tool, action))

    def test_30_other_methods_and_hidden_contacts_are_unsupported(self):
        tool = next(t for t in self.calendar.get_tools() if t.func_name == "get_calendar_events_from_to")
        self.assertIsNone(self.tracker.prepare(tool, {}))
        hidden = InternalContacts()
        tool, action = self.action(hidden, "get_contact", "contact-a")
        self.assertIsNone(self.tracker.prepare(tool, action))

    def test_31_wrong_delete_return_does_not_create_receipt(self):
        tool, action = self.action(self.calendar, "delete_calendar_event", "event-a")
        binding = self.tracker.prepare(tool, action)
        result = "Event another-entity successfully deleted."
        outcome = {"status": "succeeded", "complete": True, "executed": True, "resultHash": evidence._hash(result)}
        self.assertIsNone(self.tracker.complete(binding, outcome, result=result, observed_at=self.env.time_manager.time()))
        del self.calendar.events["event-a"]
        self.assertIsNone(self.execute(self.calendar, "get_calendar_event", "event-a")[0])

    def test_32_reviewed_real_inherited_classes_and_aliases(self):
        for cls in (CalendarApp, CalendarV2):
            app = cls(name="Alias" + cls.__name__, events={"a": CalendarEvent("a", "A", 1200, 1400)})
            self.env.register_apps([app])
            self.assertEqual(self.execute(app, "delete_calendar_event", "a")[0]["kind"], "delete_succeeded")
            self.assertEqual(self.execute(app, "get_calendar_event", "a")[0]["kind"], "entity_absent")
        app = ContactsApp(name="AddressBook", contacts={"a": Contact("A", "B", contact_id="a")})
        self.env.register_apps([app])
        self.assertEqual(self.execute(app, "delete_contact", "a")[0]["kind"], "delete_succeeded")
        self.assertEqual(self.execute(app, "get_contact", "a")[0]["kind"], "entity_absent")

    def test_33_successful_contacts_read_is_present(self):
        result, _, _ = self.execute(self.contacts, "get_contact", "contact-a")
        self.assertEqual(result["kind"], "entity_present")

    def test_34_same_alias_different_native_owner_cannot_borrow_receipt(self):
        self.execute(self.calendar, "delete_calendar_event", "event-a")
        other = Calendar()
        other_env = Environment(EnvironmentConfig(start_time=self.env.time_manager.time(), duration=None, verbose=False))
        other_env.register_apps([other])
        tool, action = self.action(other, "get_calendar_event", "event-a")
        binding = self.tracker.prepare(tool, action)
        try:
            tool(**action["arguments"])
        except ValueError as error:
            result = {"status": "failed_before_execution", "errorType": "ValueError"}
            outcome = {"status": "failed_before_execution", "complete": True, "executed": True,
                       "resultHash": evidence._hash(result)}
            semantic = self.tracker.complete(binding, outcome, result=result, error=error,
                                             observed_at=other_env.time_manager.time())
            self.assertIsNone(semantic)

    def test_35_returned_receipt_is_not_mutable_internal_memory(self):
        deleted, _, _ = self.execute(self.calendar, "delete_calendar_event", "event-a")
        expected = dict(deleted["deleteReceiptRef"])
        deleted["deleteReceiptRef"]["receiptId"] = "0" * 64
        absent, _, _ = self.execute(self.calendar, "get_calendar_event", "event-a")
        self.assertEqual(absent["deleteReceiptRef"], expected)


if __name__ == "__main__":
    unittest.main()
