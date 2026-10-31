"""No ARE execution, socket connection, Host, or model in these unit checks."""
import importlib.util
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "scripts/runtime_semantics_e2e_fixture.py"
spec = importlib.util.spec_from_file_location("runtime_semantics_fixture", SOURCE)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class StorageFaultTests(unittest.TestCase):
    def test_profiles_are_bounded_and_waiting_is_explicitly_separate(self):
        self.assertEqual(len(fixture.DELETE_CASES), 5)
        self.assertEqual(len(fixture.WAIT_CASES), 10)
        self.assertEqual(len(set(fixture.CASES)), 15)
        self.assertIn("wait_condition_timeout_calendar", fixture.WAIT_CASES)
        self.assertIn("wait_no_notify", fixture.WAIT_CASES)

    def test_inactive_storage_is_an_ordinary_dictionary(self):
        values = fixture.FaultStorage({fixture.FIRST_ID: "one", fixture.SECOND_ID: "two"}, "permission")
        self.assertIn(fixture.FIRST_ID, values)
        del values[fixture.FIRST_ID]
        self.assertNotIn(fixture.FIRST_ID, values)
        self.assertEqual(values.faults, [])

    def test_permission_fault_is_not_a_missing_entity_error(self):
        values = fixture.FaultStorage({}, "permission")
        values.active = True
        with self.assertRaises(PermissionError):
            fixture.FIRST_ID in values
        self.assertEqual(len(values.faults), 1)
        self.assertFalse(values.faults[0]["officialToolFunctionChanged"])
        self.assertFalse(values.faults[0]["hostResultForged"])

    def test_unsupported_fault_preserves_other_entity_and_cannot_be_called_absent(self):
        values = fixture.FaultStorage({fixture.SECOND_ID: "two"}, "unsupported")
        values.active = True
        with self.assertRaises(RuntimeError):
            fixture.FIRST_ID in values
        self.assertIn(fixture.SECOND_ID, values)
        values.active = False
        self.assertNotIn(fixture.FIRST_ID, values)


if __name__ == "__main__":
    unittest.main()
