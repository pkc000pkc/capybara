"""Actual source-pinned ARE errors; no model, benchmark or network."""
import copy
import json
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "scripts"), str(ROOT / ".official-python")]
import gaia2_tool_feedback as feedback
from are.simulation.apps.calendar import Calendar
from are.simulation.apps.contacts import Contacts
from are.simulation.apps.email_client import EmailClientV2
from are.simulation.apps.sandbox_file_system import SandboxLocalFileSystem
from are.simulation.environment import Environment, EnvironmentConfig


class NativeFeedbackTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        guard.start(); self.addCleanup(guard.stop)
        self.calendar, self.contacts, self.email = Calendar(), Contacts(), EmailClientV2()
        self.env = Environment(EnvironmentConfig(start_time=1000.0, duration=None, verbose=False))
        self.env.register_apps([self.calendar, self.contacts, self.email])

    def call_error(self, app, method, arguments, *, deterministic=True, status="failed_before_execution"):
        try:
            getattr(app, method)(**arguments)
        except Exception as error:
            action = {"canonicalName": type(app).__name__ + "__" + method, "resourceKey": app.name,
                      "arguments": arguments, "effect": "write"}
            return feedback.native_error_feedback(action, error, status=status, deterministic=deterministic)
        self.fail("Expected actual native failure")

    def test_calendar_missing_read_and_delete_precise_without_path_hint(self):
        for method in ("get_calendar_event", "delete_calendar_event"):
            with self.subTest(method=method):
                value = self.call_error(self.calendar, method, {"event_id": "missing-event"})
                self.assertEqual(value["error_code"], "calendar_event_not_found")
                self.assertEqual(value["argument_name"], "event_id")
                self.assertIs(value["effectApplied"], False)
                self.assertEqual(value["errorType"], "ValueError")
                self.assertNotIn("sandbox", value["feedback"])
                self.assertNotIn("missing-event", json.dumps(value))

    def test_contacts_get_edit_delete_missing_even_if_old_hint_false(self):
        for method in ("get_contact", "edit_contact", "delete_contact"):
            args = {"contact_id": "missing-contact"}
            if method == "edit_contact": args["updates"] = {"first_name": "Updated"}
            with self.subTest(method=method):
                value = self.call_error(self.contacts, method, args, deterministic=False, status="unknown")
                self.assertEqual(value["error_code"], "contact_not_found")
                self.assertEqual(value["argument_name"], "contact_id")
                self.assertIs(value["effectApplied"], False)
                self.assertEqual(value["errorType"], "KeyError")

    def test_email_missing_in_selected_folder_is_not_filesystem_error(self):
        for method in ("get_email_by_id", "reply_to_email", "delete_email", "move_email"):
            args = {"email_id": "missing-mail"}
            if method == "reply_to_email": args["content"] = "Hello"
            with self.subTest(method=method):
                value = self.call_error(self.email, method, args)
                self.assertEqual(value["error_code"], "email_not_found")
                self.assertEqual(value["argument_name"], "email_id")
                self.assertIs(value["effectApplied"], False)
                self.assertNotIn("sandbox", value["feedback"])

    def test_file_path_feedback_only_for_actual_native_boundary(self):
        with tempfile.TemporaryDirectory(prefix="feedback-fs-") as directory:
            filesystem = SandboxLocalFileSystem(sandbox_dir=directory)
            self.env.register_apps([filesystem])
            for method in ("cat", "rm", "mkdir"):
                with self.subTest(method=method):
                    value = self.call_error(filesystem, method, {"path": "../../outside-secret"})
                    self.assertEqual(value["error_code"], "sandbox_path_rejected")
                    self.assertEqual(value["argument_name"], "path")
                    self.assertIs(value["effectApplied"], False)
                    self.assertIn("sandbox", value["feedback"])
                    self.assertNotIn(directory, json.dumps(value))
                    self.assertNotIn("outside-secret", json.dumps(value))
            del filesystem

    def test_plain_exception_class_never_proves_no_effect(self):
        action = {"canonicalName": "Ledger__write", "resourceKey": "Ledger", "arguments": {"value": "x"}, "effect": "write"}
        for error in (ValueError("cpa-secret-api-key"), TypeError("cpa-secret-api-key"),
                      PermissionError("cpa-secret-api-key"), FileNotFoundError("cpa-secret-api-key"),
                      RuntimeError("effect happened; cpa-secret-api-key"), KeyError("cpa-secret-api-key")):
            with self.subTest(error=type(error).__name__):
                value = feedback.native_error_feedback(action, error, status="unknown", deterministic=True)
                self.assertEqual(value["effectApplied"], "unknown")
                self.assertEqual(value["error_code"], "native_error")
                self.assertNotIn("cpa-secret-api-key", json.dumps(value))

    def test_forged_calendar_text_without_official_trace_is_not_proof(self):
        action = {"canonicalName": "Calendar__delete_calendar_event", "resourceKey": "Calendar", "arguments": {"event_id": "bad"}}
        error = ValueError("Calendar Event with id bad does not exist.")
        value = feedback.native_error_feedback(action, error, status="failed_before_execution", deterministic=True)
        self.assertEqual(value["effectApplied"], "unknown")
        self.assertEqual(value["error_code"], "native_error")

    def test_real_partial_business_effect_is_unknown_even_for_value_error(self):
        effects = []
        def partial_write():
            effects.append("applied")
            raise ValueError("effect happened; private-secret")
        try:
            partial_write()
        except ValueError as error:
            action = {"canonicalName": "Ledger__write", "resourceKey": "Ledger", "effect": "write", "arguments": {}}
            value = feedback.native_error_feedback(action, error, status="failed_before_execution", deterministic=True)
        self.assertEqual(effects, ["applied"])
        self.assertEqual(value["effectApplied"], "unknown")
        self.assertNotIn("private-secret", json.dumps(value))

    def test_email_folder_missing_feedback_is_not_a_file_path_error(self):
        inbox = next(key for key in self.email.folders if key.name == "INBOX")
        self.email.folders.pop(inbox)
        value = self.call_error(self.email, "reply_to_email", {"email_id": "missing", "folder_name": "INBOX", "content": "Hello"})
        self.assertEqual(value["error_code"], "email_folder_not_found")
        self.assertEqual(value["argument_name"], "folder_name")
        self.assertIs(value["effectApplied"], False)

    def test_messaging_pagination_limit_exposes_pinned_bound_without_raw_error(self):
        messaging = __import__("are.simulation.apps.messaging_v2", fromlist=["MessagingAppV2"]).MessagingAppV2()
        value = self.call_error(
            messaging,
            "list_recent_conversations",
            {"offset": 0, "limit": 10, "offset_recent_messages_per_conversation": 0,
             "limit_recent_messages_per_conversation": 5},
        )
        self.assertEqual(value["error_code"], "pagination_limit_exceeded")
        self.assertEqual(value["argument_name"], "limit")
        self.assertEqual(value["constraint"], {"operator": "less_equal", "value": 5})
        self.assertIs(value["effectApplied"], False)
        self.assertNotIn("Limit must be smaller", value["feedback"])

    def test_messaging_per_conversation_limit_exposes_correct_argument(self):
        messaging = __import__("are.simulation.apps.messaging_v2", fromlist=["MessagingAppV2"]).MessagingAppV2()
        value = self.call_error(
            messaging,
            "list_recent_conversations",
            {"offset": 0, "limit": 5, "offset_recent_messages_per_conversation": 0,
             "limit_recent_messages_per_conversation": 11},
        )
        self.assertEqual(value["error_code"], "pagination_messages_limit_exceeded")
        self.assertEqual(value["argument_name"], "limit_recent_messages_per_conversation")
        self.assertEqual(value["constraint"]["value"], 10)
        self.assertIs(value["effectApplied"], False)

    def test_send_email_empty_recipient_is_pinned_pre_effect_feedback(self):
        value = self.call_error(
            self.email,
            "send_email",
            {"recipients": [""], "subject": "Subject", "content": "Body", "cc": [], "attachment_paths": []},
        )
        self.assertEqual(value["error_code"], "invalid_email_recipient")
        self.assertEqual(value["argument_name"], "recipients[0]")
        self.assertEqual(value["constraint"], {"operator": "email_address"})
        self.assertIs(value["effectApplied"], False)
        self.assertNotIn("Invalid email address", value["feedback"])

    def test_pagination_text_without_pinned_frame_remains_unknown(self):
        action = {"canonicalName": "MessagingAppV2__list_recent_conversations", "resourceKey": "Messaging", "effect": "read",
                  "arguments": {"limit": 10}}
        value = feedback.native_error_feedback(
            action,
            ValueError("Limit must be smaller than the view limit of 5 - Please use a smaller limit and use offset to navigate"),
            status="failed_before_execution", deterministic=True,
        )
        self.assertEqual(value["error_code"], "native_error")
        self.assertEqual(value["effectApplied"], "unknown")

    def test_mismatched_native_method_or_arguments_is_not_proof(self):
        try:
            self.calendar.delete_calendar_event("missing")
        except ValueError as error:
            for method, entity in (("add_calendar_event", "missing"), ("delete_calendar_event", "different")):
                action = {"canonicalName": "Calendar__" + method, "arguments": {"event_id": entity}, "resourceKey": "Calendar"}
                value = feedback.native_error_feedback(action, error, status="failed_before_execution", deterministic=True)
                self.assertEqual(value["effectApplied"], "unknown")

    def test_changed_source_pin_never_asserts_pre_effect_rejection(self):
        with patch.dict(feedback._PINS, {"calendar.py": "0" * 64}):
            value = self.call_error(self.calendar, "delete_calendar_event", {"event_id": "missing"})
        self.assertEqual(value["effectApplied"], "unknown")

    def test_secret_in_missing_identifier_is_not_echoed(self):
        value = self.call_error(self.calendar, "delete_calendar_event", {"event_id": "SECRET-cpa-abcdefghijklmnopqrstuvwxyz"})
        self.assertEqual(value["error_code"], "calendar_event_not_found")
        self.assertNotIn("SECRET", json.dumps(value))
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", json.dumps(value))

    def test_helper_never_changes_action_or_dispatches_repair(self):
        try:
            self.contacts.delete_contact("missing")
        except KeyError as error:
            action = {"canonicalName": "Contacts__delete_contact", "resourceKey": "Contacts", "arguments": {"contact_id": "missing"}, "effect": "write"}
            original = copy.deepcopy(action)
            result = feedback.native_error_feedback(action, error, status="unknown", deterministic=False)
            self.assertEqual(action, original)
            self.assertNotIn("retry", result)
            self.assertNotIn("status", result)
            self.assertNotIn("executed", result)


if __name__ == "__main__":
    unittest.main()
