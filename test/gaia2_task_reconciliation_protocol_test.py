import hashlib
import unittest

from scripts.gaia2_task_reconciliation_protocol import (ReconciliationProtocolError, argument_digest,
                                                        normalize_argument_checks, normalize_supersede_quote,
                                                        resolve_scope_anchor)


def user(user_id, text):
    return {"id": user_id, "role": "user", "notificationType": "USER_MESSAGE", "content": text}


class ReconciliationProtocolTests(unittest.TestCase):
    def setUp(self):
        self.users = [user("u1", "Book the first appointment."), user("u2", "Continue the first appointment."), user("u3", "Start something else.")]

    def test_root_and_continuation_bind_to_raw_text_hashes_in_order(self):
        root, members = resolve_scope_anchor(
            quote="Book the first appointment.", users=self.users,
            continuation_quotes=["Continue the first appointment."])
        self.assertEqual(root["id"], "u1")
        self.assertEqual([item["userRef"] for item in members], ["u1", "u2"])
        self.assertEqual(members[0]["sourceHash"], hashlib.sha256(root["content"].encode()).hexdigest())

    def test_unanchored_mode_uses_latest_user_only(self):
        root, members = resolve_scope_anchor(quote="Start something else.", users=self.users)
        self.assertEqual(root["id"], "u3")
        self.assertEqual([item["userRef"] for item in members], ["u3"])

    def test_unanchored_repeated_quote_is_rejected(self):
        with self.assertRaisesRegex(ReconciliationProtocolError, "quote_binding"):
            resolve_scope_anchor(quote="Repeat", users=[user("u1", "Repeat. Repeat.")])

    def test_ambiguous_duplicate_and_reverse_quotes_fail_closed(self):
        duplicate = [user("u1", "Same phrase."), user("u2", "Same phrase."), user("u3", "Later phrase.")]
        with self.assertRaisesRegex(ReconciliationProtocolError, "scope_quote"):
            resolve_scope_anchor(quote="Same phrase.", users=duplicate, continuation_quotes=["Later phrase."])
        with self.assertRaisesRegex(ReconciliationProtocolError, "scope_duplicate"):
            resolve_scope_anchor(quote="Book the first appointment.", users=self.users,
                                 continuation_quotes=["Book the first appointment."])
        with self.assertRaisesRegex(ReconciliationProtocolError, "scope_order"):
            resolve_scope_anchor(quote="Continue the first appointment.", users=self.users,
                                 continuation_quotes=["Book the first appointment."])

    def test_argument_checks_normalize_values_to_hashes_without_oracle_data(self):
        checks = normalize_argument_checks([
            {"path": "/recipient", "op": "equals_hash", "value": "person@example.com"},
            {"path": "/labels", "op": "array_contains_hash", "expectedHash": argument_digest("urgent")},
            {"path": "/amount", "op": "number_range", "min": 1, "max": 10},
            {"path": "/subject", "op": "present"},
        ], safe_json_value=lambda value: True)
        self.assertEqual(checks[0]["expectedHash"], argument_digest("person@example.com"))
        self.assertEqual(checks[2]["min"], 1)
        with self.assertRaisesRegex(ReconciliationProtocolError, "argument_range"):
            normalize_argument_checks([{ "path": "/amount", "op": "number_range", "min": 10, "max": 1 }], safe_json_value=lambda value: True)

    def test_argument_hash_normalizes_integral_float_like_javascript(self):
        self.assertEqual(argument_digest(1), argument_digest(1.0))
        self.assertEqual(argument_digest({"amount": 1, "items": [2]}), argument_digest({"items": [2.0], "amount": 1.0}))
        self.assertEqual(argument_digest(1e-6), hashlib.sha256(b"0.000001").hexdigest())
        self.assertEqual(argument_digest(1e-7), hashlib.sha256(b"1e-7").hexdigest())

    def test_supersede_quote_is_unique_in_the_new_user_text(self):
        self.assertEqual(normalize_supersede_quote("Replace this task.", "Replace this task."), "Replace this task.")
        with self.assertRaisesRegex(ReconciliationProtocolError, "supersede_quote"):
            normalize_supersede_quote("Replace", "Replace. Replace.")


if __name__ == "__main__":
    unittest.main()
