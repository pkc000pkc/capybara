import json
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import gaia2_window_pipeline as pipeline


class WindowPipelineTests(unittest.TestCase):
    def test_model_extraction_review_and_registration_produce_host_envelope(self):
        text = "Wait for a reply during the next minute and do not notify me."
        source_hash = hashlib.sha256(text.encode()).hexdigest()
        quote = "Wait for a reply during the next minute"
        raw = {"schemaVersion": "gaia2-task-contract-proposal-v2", "sourceHash": source_hash,
               "resolution": "obligations", "notificationPolicy": "forbid_until_deadline",
               "obligations": [{"quote": quote, "mode": "monitor_until", "goal": "Monitor the reply",
                                "timeBasis": {"kind": "relative", "durationSeconds": 60}}], "revocations": []}

        def response(name, arguments):
            return {"choices": [{"finish_reason": "tool_calls", "message": {"content": None,
                "tool_calls": [{"type": "function", "id": "call-1", "function": {"name": name, "arguments": json.dumps(arguments)}}]}}]}

        def model_call(messages, tools):
            name = tools[0]["function"]["name"]
            if name == "capybara_propose_task_contract":
                return response(name, raw)
            payload = json.loads(messages[-1]["content"])
            normalized = payload["normalizedProposal"]
            return response(name, {"schemaVersion": "gaia2-task-contract-review-v2",
                "sourceHash": source_hash, "proposalHash": payload["proposalHash"], "decision": "approved",
                "notificationVerified": True, "obligationChecks": [{"index": 0, "spanVerified": True, "modeVerified": True, "timeVerified": True}],
                "revocationChecks": [], "reason": "independent review", "rawProposalHash": payload["rawProposalHash"],
                "anchoringHash": payload["anchoringHash"]})

        with tempfile.TemporaryDirectory() as directory:
            result = pipeline.resolve_user_window_source(evidence_root=directory, execution_id="e-1", session_id="s-1",
                user_ref="u-1", text=text, arrived_at=100.0, are_now=101.0, model_call=model_call)
        self.assertEqual(result["status"], "registered")
        self.assertEqual(result["windowSource"]["schemaVersion"], "gaia2-window-obligation-source-v1")
        self.assertEqual(result["windowSource"]["obligations"][0]["deadline"], 160.0)
        self.assertEqual(result["windowSource"]["obligations"][0]["span"]["text"], quote)

    def test_dependent_clause_can_inherit_explicit_window_without_actor_action_scope(self):
        text = ("Delete the matching events. If a reply arrives during the next minute, "
                "accept it; if a later reply arrives during that period, decline it. Do not notify me now.")
        first = "If a reply arrives during the next minute, accept it"
        second = "if a later reply arrives during that period, decline it"
        source_hash = hashlib.sha256(text.encode()).hexdigest()
        raw = {"schemaVersion": "gaia2-task-contract-proposal-v2", "sourceHash": source_hash,
               "resolution": "obligations", "notificationPolicy": "forbid",
               "obligations": [
                   {"quote": first, "mode": "condition_once", "goal": "Handle the first reply",
                    "timeBasis": {"kind": "relative", "durationSeconds": 60}},
                   {"quote": second, "mode": "monitor_until", "goal": "Handle later replies during that period",
                    "timeBasis": {"kind": "relative", "durationSeconds": 60}},
               ], "revocations": []}

        def response(name, arguments):
            return {"choices": [{"finish_reason": "tool_calls", "message": {"content": None,
                "tool_calls": [{"type": "function", "id": "call-2", "function": {
                    "name": name, "arguments": json.dumps(arguments)}}]}}]}

        def model_call(messages, tools):
            name = tools[0]["function"]["name"]
            if name == "capybara_propose_task_contract":
                return response(name, raw)
            payload = json.loads(messages[-1]["content"])
            return response(name, {"schemaVersion": "gaia2-task-contract-review-v2",
                "sourceHash": source_hash, "proposalHash": payload["proposalHash"], "decision": "approved",
                "notificationVerified": True,
                "obligationChecks": [{"index": 0, "spanVerified": True, "modeVerified": True, "timeVerified": True},
                                      {"index": 1, "spanVerified": True, "modeVerified": True, "timeVerified": True}],
                "revocationChecks": [], "reason": "dependent window is source-bound",
                "rawProposalHash": payload["rawProposalHash"], "anchoringHash": payload["anchoringHash"]})

        with tempfile.TemporaryDirectory() as directory:
            result = pipeline.resolve_user_window_source(evidence_root=directory, execution_id="e-2", session_id="s-2",
                user_ref="u-2", text=text, arrived_at=100.0, are_now=101.0, model_call=model_call)
        self.assertEqual(result["status"], "registered")
        self.assertEqual([item["deadline"] for item in result["windowSource"]["obligations"]], [160.0, 160.0])
        self.assertEqual(result["windowSource"]["obligations"][1]["span"]["text"], second)


if __name__ == "__main__":
    unittest.main()
