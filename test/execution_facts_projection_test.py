"""Regression tests for the bounded read-coverage projection."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gaia2_execution_facts import build_execution_facts  # noqa: E402


def read_message(index, query_hash, *, tool="Contacts__get_contacts", offset=0):
    action_id = f"call-{index}"
    result_hash = f"{index + 1:064x}"
    return {
        "role": "tool",
        "tool_call_id": action_id,
        # The body is deliberately large and must never be copied into facts.
        "content": "sensitive native result " * 500,
        "executionOutcome": {
            "canonicalName": tool,
            "resourceKey": tool.split("__", 1)[0],
            "effect": "read",
            "status": "succeeded",
            "executed": True,
            "complete": True,
            "observedAt": 100 + index,
        },
        "observation": {
            "actionId": action_id,
            "canonicalName": tool,
            "resourceKey": tool.split("__", 1)[0],
            "queryHash": query_hash,
            "resultHash": result_hash,
            "observedAt": 100 + index,
            "complete": True,
            "viewComplete": True,
            "queryArguments": {"offset": offset, "limit": 10},
        },
    }


class ExecutionFactsReadCoverageTests(unittest.TestCase):
    def test_read_coverage_survives_compaction_and_marks_repeated_queries(self):
        query_a = "a" * 64
        query_b = "b" * 64
        messages = [read_message(0, query_a, offset=0), read_message(1, query_a, offset=0),
                    read_message(2, query_b, offset=10)]
        facts = build_execution_facts(messages, {"actions": [], "unknown": []})
        coverage = facts["readCoverage"]
        self.assertEqual(facts["totalCalls"], 0, "read calls do not become mutation history")
        self.assertEqual(coverage["totalCalls"], 3)
        self.assertEqual(coverage["counts"]["succeeded"], 3)
        self.assertEqual(coverage["repeatedQueries"], 1)
        self.assertEqual(len(coverage["groups"]), 1)
        self.assertEqual(set(coverage["groups"][0]["queryHashes"]), {query_a, query_b})
        self.assertLessEqual(len(str(facts).encode("utf-8")), 8192)
        self.assertNotIn("sensitive native result", str(facts))

    def test_read_groups_are_separated_by_native_resource(self):
        messages = [read_message(0, "a" * 64), read_message(1, "b" * 64, tool="Emails__list_emails")]
        coverage = build_execution_facts(messages)["readCoverage"]
        self.assertEqual({row["resource"] for row in coverage["groups"]}, {"Contacts", "Emails"})
        self.assertEqual(coverage["totalCalls"], 2)


if __name__ == "__main__":
    unittest.main()
