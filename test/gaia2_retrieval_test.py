import copy
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from gaia2_retrieval import (RetrievalError, RetrievalRuntime, NATIVE_TOOL,
                            canonical_hash, native_hash, tool_schema)


class RetrievalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls, self.hooks = [], []
        self.total = 25
        self.fail_offset = None
        self.incomplete = False
        self.old_blocker = False
        self.runtime = RetrievalRuntime(self.temp.name, "exec", "session", self.native, self.hook)
        self.network = patch.object(socket.socket, "connect", side_effect=AssertionError("network forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def native(self, name, arguments):
        offset = arguments["offset"]
        self.calls.append((name, copy.deepcopy(arguments)))
        if offset == self.fail_offset:
            raise TimeoutError("offline simulated failure")
        end = min(offset + 10, self.total)
        result = {"contacts": [f"ID: c{i}; Name: Person {i}; Job: {'Producer' if i == 14 else 'Analyst'}"
                               for i in range(offset, end)],
                  "metadata": {"range": [offset, end], "total": self.total}}
        return {"result": result, "actionId": "action-" + str(len(self.calls)),
                "queryHash": native_hash(arguments), "resultHash": native_hash(result),
                "observedAt": 1000 + len(self.calls), "complete": not self.incomplete,
                "viewComplete": not self.incomplete, "oldBlocker": self.old_blocker}

    def hook(self, phase, payload):
        self.hooks.append((phase, copy.deepcopy(payload)))
        return True

    def begin(self, **kwargs):
        args = {"op": "begin", "requestId": "begin", "criteria": {
            "userRef": "latest", "predicate": "Job Producer", "stopRule": "find_all"}}
        args.update(kwargs)
        return self.runtime.step(args, call_id="call-1", user_ref="user-visible-1")

    def bound(self, op, request_id, **kwargs):
        scope = self.runtime.snapshot()["scope"]
        return {"op": op, "requestId": request_id, "scopeId": scope["scopeId"],
                "criteriaVersion": scope["criteriaVersion"], "expectedRevision": scope["revision"], **kwargs}

    def reviews(self, decision=None):
        reviews = []
        for page in self.runtime.snapshot()["pages"]:
            if page["reviewCommitted"]:
                continue
            records = []
            for record in page["records"]:
                kind = decision or ("keep" if "Producer" in record["body"] else "reject")
                records.append({"recordRef": record["recordRef"], "decision": kind,
                    "quotes": [{"path": record["path"], "quote": record["body"]}]})
            reviews.append({"pageRef": page["pageRef"], "resultHash": page["resultHash"], "records": records})
        return reviews

    def next_read(self, pages=2, offset=10):
        return {"tool": NATIVE_TOOL, "arguments": {"offset": offset}, "pages": pages}

    def assert_error(self, code, fn):
        with self.assertRaises(RetrievalError) as caught:
            fn()
        self.assertEqual(caught.exception.code, code)

    def test_schema_and_first_page(self):
        self.assertEqual(tool_schema()["function"]["name"], "capybara_retrieval_step")
        result = self.begin()
        self.assertEqual(len(result["pages"][0]["records"]), 10)
        self.assertEqual(result["scope"]["criteria"]["userRef"], "user-visible-1")
        self.assertEqual(self.calls, [(NATIVE_TOOL, {"offset": 0})])
        self.assertFalse(result["coverage"]["allRead"])

    def test_provider_projection_bounds_unreviewed_page_window(self):
        self.total = 100
        first = self.begin()
        messages = [{"role": "tool", "tool_call_id": "call-1", "content": json.dumps(first)}]
        offset = 10
        for index in range(2, 4):
            result = self.runtime.step(self.bound("continue_read", f"read-{index}",
                nextRead=self.next_read(pages=4, offset=offset)), call_id=f"call-{index}")
            messages.append({"role": "tool", "tool_call_id": f"call-{index}", "content": json.dumps(result)})
            offset += 40
        projected, _ = self.runtime.project_messages(messages)
        latest = json.loads(projected[-1]["content"])
        self.assertLessEqual(len(latest["pages"]), self.runtime.MAX_VISIBLE_PENDING_PAGES)
        self.assertTrue(latest["retrieval"]["pendingPageSummary"])
        self.assertEqual(len(self.runtime.snapshot()["pages"]), 9)
        self.assertLess(len(projected[-1]["content"].encode()), 240_000)

    def test_latest_needs_trusted_ref(self):
        self.assert_error("user_ref", lambda: self.runtime.step({"op": "begin", "requestId": "a",
            "criteria": {"predicate": "x"}}))
        self.assertEqual(self.calls, [])

    def test_batches_middle_match_and_projection(self):
        first = self.begin()
        args = self.bound("review_next", "next", reviews=self.reviews(), nextRead=self.next_read())
        second = self.runtime.step(args, call_id="call-2")
        self.assertEqual([x[1]["offset"] for x in self.calls], [0, 10, 20])
        self.assertEqual([p["range"] for p in second["pages"]], [[10, 20], [20, 25]])
        self.runtime.step(self.bound("review_finish", "finish", reviews=self.reviews()), call_id="call-3")
        snapshot = self.runtime.snapshot()
        self.assertEqual(len(snapshot["candidates"]), 1)
        self.assertIn("c14", snapshot["candidates"][0]["body"])
        self.assertEqual(snapshot["scope"]["status"], "reviewed")
        messages = [{"role": "assistant", "tool_calls": [{"id": "call-1"}]},
                    {"role": "tool", "tool_call_id": "call-1", "content": json.dumps(first)},
                    {"role": "tool", "tool_call_id": "call-2", "content": json.dumps(second)},
                    {"role": "user", "content": "preserve user"}]
        projected, plan = self.runtime.project_messages(messages)
        self.assertEqual(projected[0], messages[0])
        self.assertEqual(projected[-1], messages[-1])
        self.assertEqual(len(projected), len(messages))
        viewed = json.loads(projected[1]["content"])
        self.assertTrue(viewed["archived"])
        self.assertNotIn("pages", viewed)
        latest = json.loads(projected[2]["content"])
        self.assertEqual(latest["pages"], [])
        self.assertNotIn("pages", latest["retrieval"])
        self.assertNotIn("certificates", latest["projection"])
        self.assertIn("Producer", projected[2]["content"])
        self.assertNotIn("Name: Person 0;", projected[1]["content"])
        for cert in plan["certificates"]:
            self.assertEqual(cert["projectionHash"], canonical_hash({
                "retainedRecords": cert["retainedRecords"], "rejectRefs": cert["rejectRefs"]}))
        self.assertIn("Name: Person 0;", messages[1]["content"])

    def test_quote_reject_is_atomic_and_does_not_read(self):
        self.begin()
        reviews = self.reviews()
        reviews[0]["records"][-1]["quotes"][0]["quote"] = "not in source"
        self.assert_error("quote", lambda: self.runtime.step(self.bound("review_next", "bad",
            reviews=reviews, nextRead=self.next_read())))
        self.assertEqual(len(self.calls), 1)
        self.assertFalse(self.runtime.snapshot()["pages"][0]["reviewCommitted"])

    def test_partial_review_retains_unclassified_records(self):
        self.begin()
        reviews = self.reviews()
        reviews[0]["records"].pop()
        self.runtime.step(self.bound("review_finish", "partial", reviews=reviews))
        snapshot = self.runtime.snapshot()
        untouched = snapshot["pages"][0]["records"][-1]
        self.assertEqual(untouched["decision"], "defer")
        self.assertFalse(untouched["classified"])
        self.assertIn("body", untouched)
        self.assertEqual(snapshot["coverage"]["unclassified"], 1)
        self.assertFalse(snapshot["coverage"]["allReviewed"])
        self.assertEqual(snapshot["candidates"], [untouched])

    def test_cross_page_record_rejected(self):
        self.begin()
        reviews = self.reviews()
        reviews[0]["records"][0]["recordRef"] = "other-session-record"
        self.assert_error("record_ref", lambda: self.runtime.step(self.bound("review_finish", "bad", reviews=reviews)))

    def test_idempotent_replay_and_changed_id(self):
        first = self.begin()
        args = {"op": "begin", "requestId": "begin", "criteria": {
            "userRef": "latest", "predicate": "Job Producer", "stopRule": "find_all"}}
        self.assertEqual(self.runtime.step(args, call_id="replayed", user_ref="other"), first)
        self.assertEqual(len(self.calls), 1)
        args["criteria"]["predicate"] = "changed"
        self.assert_error("request_id", lambda: self.runtime.step(args))

    def test_stale_revision_and_scope(self):
        self.begin()
        args = self.bound("review_finish", "bad", reviews=self.reviews())
        args["expectedRevision"] = 0
        self.assert_error("revision", lambda: self.runtime.step(args))
        args["scopeId"] = "other"
        self.assert_error("scope", lambda: self.runtime.step(args))

    def test_unsupported_tool_and_gap(self):
        self.begin()
        args = self.bound("review_next", "bad", reviews=self.reviews(), nextRead=self.next_read())
        args["nextRead"]["tool"] = "Other__read"
        self.assert_error("tool_scope", lambda: self.runtime.step(args))
        args["nextRead"] = self.next_read(offset=11)
        self.assert_error("coverage_gap", lambda: self.runtime.step(args))
        self.assertEqual(len(self.calls), 1)

    def test_ack_precedes_next_read(self):
        self.begin()
        order = []
        native = self.runtime.native_reader
        self.runtime.control_hook = lambda phase, payload: order.append("hook:" + phase)
        self.runtime.native_reader = lambda name, args: (order.append("read"), native(name, args))[1]
        self.runtime.step(self.bound("review_next", "next", reviews=self.reviews(), nextRead=self.next_read()))
        self.assertEqual(order[:2], ["hook:review_commit", "read"])

    def test_ack_failure_never_reads_next(self):
        self.begin()
        self.runtime.control_hook = lambda phase, payload: False
        args = self.bound("review_next", "next", reviews=self.reviews(), nextRead=self.next_read())
        self.assert_error("hook_ack", lambda: self.runtime.step(args))
        self.assertEqual(len(self.calls), 1)
        self.assertTrue(self.runtime.snapshot()["needsReconcile"])
        self.assert_error("interrupted_request", lambda: self.runtime.step(args))

    def test_committed_review_survives_failed_read(self):
        self.begin()
        self.fail_offset = 10
        args = self.bound("review_next", "next", reviews=self.reviews(), nextRead=self.next_read())
        result = self.runtime.step(args)
        self.assertTrue(result["reviewCommitted"])
        self.assertEqual(result["nextReadStatus"], "failed")
        count = len(self.calls)
        self.assertEqual(self.runtime.step(args), result)
        self.assertEqual(len(self.calls), count)
        self.fail_offset = None
        result = self.runtime.step(self.bound("continue_read", "continue", nextRead=self.next_read()))
        self.assertEqual(result["nextReadStatus"], "succeeded")
        self.assertEqual(len(result["pages"]), 2)

    def test_incomplete_or_existing_blocker_never_archived(self):
        for flag in ("incomplete", "old_blocker"):
            with self.subTest(flag=flag):
                setattr(self, flag, True)
                runtime = RetrievalRuntime(self.temp.name, "exec", flag, self.native, self.hook)
                previous, self.runtime = self.runtime, runtime
                self.begin()
                self.assert_error("protected_page", lambda: self.runtime.step(self.bound(
                    "review_finish", "finish", reviews=self.reviews())))
                self.assertEqual(self.runtime.projection()["certificates"], [])
                self.assertIn("body", self.runtime.snapshot()["pages"][0]["records"][0])
                self.runtime = previous
                setattr(self, flag, False)

    def test_defer_retains_original_and_prevents_complete(self):
        self.total = 3
        self.begin()
        self.runtime.step(self.bound("review_finish", "finish", reviews=self.reviews("defer")))
        snapshot = self.runtime.snapshot()
        self.assertEqual(len(snapshot["candidates"]), 3)
        self.assertEqual(snapshot["scope"]["status"], "incomplete")
        self.assertTrue(all("body" in r for r in snapshot["pages"][0]["records"]))

    def test_incomplete_page_cannot_claim_full_coverage_even_with_keep(self):
        self.total = 3
        self.incomplete = True
        self.begin()
        self.runtime.step(self.bound("review_finish", "finish", reviews=self.reviews("keep")))
        snapshot = self.runtime.snapshot()
        self.assertFalse(snapshot["coverage"]["allRead"])
        self.assertEqual(snapshot["scope"]["status"], "incomplete")

    def test_ack_failure_cannot_project(self):
        self.begin()
        self.runtime.control_hook = lambda phase, payload: False
        self.assert_error("hook_ack", lambda: self.runtime.step(self.bound(
            "review_finish", "finish", reviews=self.reviews())))
        self.assert_error("needs_reconcile", lambda: self.runtime.project_messages([]))

    def test_reopen_restores_exact_body_without_freshness(self):
        first = self.begin()
        self.runtime.step(self.bound("review_finish", "finish", reviews=self.reviews()))
        old = self.runtime.snapshot()["pages"][0]
        self.runtime.step(self.bound("reopen", "open", pageRefs=[old["pageRef"]]))
        page = self.runtime.snapshot()["pages"][0]
        self.assertEqual(page["records"], first["pages"][0]["records"])
        self.assertEqual(page["observedAt"], old["observedAt"])
        self.assertEqual(page["actionId"], old["actionId"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.runtime.projection()["certificates"], [])

    def test_revise_invalidates_dispositions(self):
        self.begin()
        self.runtime.step(self.bound("review_finish", "finish", reviews=self.reviews()))
        self.runtime.step(self.bound("revise", "revise", criteria={"userRef": "u2", "predicate": "Analyst"}))
        snapshot = self.runtime.snapshot()
        self.assertEqual(snapshot["scope"]["criteriaVersion"], 2)
        self.assertEqual(snapshot["projection"]["certificates"], [])
        self.assertTrue(all(r["decision"] == "defer" and not r["classified"] for r in snapshot["pages"][0]["records"]))

    def test_no_review_pagination_retains_every_original_once(self):
        first = self.begin()
        args = self.bound("continue_read", "read-more", nextRead=self.next_read())
        second = self.runtime.step(args, call_id="call-2")
        self.assertEqual([arguments["offset"] for _, arguments in self.calls], [0, 10, 20])
        self.assertFalse(second["reviewCommitted"])
        self.assertTrue(second["coverage"]["allRead"])
        self.assertFalse(second["coverage"]["allReviewed"])
        self.assertEqual(second["coverage"]["unclassified"], 25)
        self.assertEqual(len(second["retrieval"]["candidates"]), 25)
        projected, _ = self.runtime.project_messages([
            {"role": "tool", "tool_call_id": "call-1", "content": json.dumps(first)},
            {"role": "tool", "tool_call_id": "call-2", "content": json.dumps(second)}])
        text = "\n".join(message["content"] for message in projected)
        for record in second["retrieval"]["candidates"]:
            self.assertEqual(record["decision"], "defer")
            self.assertEqual(text.count(record["body"]), 1)
        self.assertEqual(self.runtime.step(args), second)
        self.assertEqual(len(self.calls), 3, "An exact retry must not reread any page")

    def test_review_next_without_reviews_and_later_cross_page_partial_review(self):
        self.begin()
        self.runtime.step(self.bound("review_next", "unreviewed-next", nextRead=self.next_read(pages=1)))
        pages = self.runtime.snapshot()["pages"]
        partial = []
        for page in pages:
            record = page["records"][0]
            partial.append({"pageRef": page["pageRef"], "resultHash": page["resultHash"], "records": [
                {"recordRef": record["recordRef"], "decision": "reject", "quotes": [
                    {"path": record["path"], "quote": record["body"]}]}]})
        result = self.runtime.step(self.bound("review_next", "partial-next", reviews=partial,
            nextRead=self.next_read(pages=1, offset=20)))
        self.assertEqual([args["offset"] for _, args in self.calls], [0, 10, 20])
        self.assertEqual(len(result["retrieval"]["candidates"]), 23)
        self.assertEqual(result["coverage"]["unclassified"], 23)
        self.assertFalse(result["coverage"]["allReviewed"])
        self.assertEqual(len(result["projection"]["certificates"]), 2)
        # An already partially reviewed page may receive another selected record;
        # omissions preserve earlier decisions and all untouched source bodies.
        record = pages[0]["records"][1]
        self.runtime.step(self.bound("review_finish", "later-partial", reviews=[{
            "pageRef": pages[0]["pageRef"], "resultHash": pages[0]["resultHash"], "records": [
                {"recordRef": record["recordRef"], "decision": "keep", "quotes": []}]}]))
        snapshot = self.runtime.snapshot()
        self.assertEqual(snapshot["pages"][0]["records"][0]["decision"], "reject")
        self.assertEqual(snapshot["pages"][0]["records"][1]["decision"], "keep")
        self.assertEqual(snapshot["coverage"]["unclassified"], 22)
        self.assertEqual(len(self.calls), 3)

    def test_revise_after_partial_cleanup_restores_raw_evidence_and_allows_no_review_read(self):
        first = self.begin()
        original = first["pages"][0]
        review = self.reviews()[0]
        review["records"] = review["records"][:2]
        self.runtime.step(self.bound("review_finish", "partial", reviews=[review]))
        self.runtime.step(self.bound("revise", "new-condition", criteria={"userRef": "new-user", "predicate": "Job Analyst"}))
        restored = self.runtime.snapshot()
        self.assertEqual(restored["scope"]["criteriaVersion"], 2)
        self.assertEqual(restored["projection"]["certificates"], [])
        self.assertEqual(len(restored["candidates"]), 10)
        page = restored["pages"][0]
        for key in ("sourceRef", "actionId", "resultHash", "observedAt"):
            self.assertEqual(page[key], original[key])
        self.assertEqual([row["body"] for row in page["records"]], [row["body"] for row in original["records"]])
        self.assertTrue(all(row["decision"] == "defer" and not row["classified"] for row in page["records"]))
        self.runtime.step(self.bound("continue_read", "new-read", nextRead=self.next_read()))
        self.assertEqual([args["offset"] for _, args in self.calls], [0, 10, 20])

    def test_reject_still_requires_evidence_but_keep_and_defer_do_not(self):
        self.begin()
        page = self.runtime.snapshot()["pages"][0]
        review = {"pageRef": page["pageRef"], "resultHash": page["resultHash"], "records": [
            {"recordRef": page["records"][0]["recordRef"], "decision": "reject", "quotes": []}]}
        self.assert_error("review", lambda: self.runtime.step(self.bound("review_finish", "no-proof", reviews=[review])))
        review["records"][0]["decision"] = "keep"
        self.runtime.step(self.bound("review_finish", "keep", reviews=[review]))
        self.assertEqual(self.runtime.snapshot()["pages"][0]["records"][0]["decision"], "keep")
        self.assertEqual(len(self.calls), 1)

    def test_total_change_not_claimed_complete(self):
        self.begin()
        self.total = 26
        result = self.runtime.step(self.bound("review_next", "next", reviews=self.reviews(), nextRead=self.next_read()))
        self.assertEqual(result["nextReadStatus"], "source_changed")
        self.assertEqual(result["coverage"]["consistency"], "changed")
        self.assertFalse(result["coverage"]["allRead"])
        self.assertEqual(len(self.calls), 2)

    def test_persistence_hash_validation_and_session_isolation(self):
        self.begin()
        restored = RetrievalRuntime(self.temp.name, "exec", "session", self.native, self.hook)
        self.assertEqual(restored.snapshot(), self.runtime.snapshot())
        other = RetrievalRuntime(self.temp.name, "exec", "other", self.native, self.hook)
        self.assertIsNone(other.snapshot()["scope"])
        page = self.runtime.snapshot()["pages"][0]
        path = Path(self.temp.name) / page["sourceRef"]["path"]
        path.write_text("tampered", encoding="utf-8")
        self.assert_error("source_hash", lambda: RetrievalRuntime(self.temp.name, "exec", "session", self.native))

    def test_result_hash_mismatch_not_registered(self):
        native = self.runtime.native_reader
        def changed(name, args):
            response = native(name, args)
            response["resultHash"] = "bad"
            return response
        self.runtime.native_reader = changed
        self.assert_error("native_hash", lambda: self.begin())
        self.assertEqual(self.runtime.snapshot()["pages"], [])

    def test_safety_failure_is_not_a_recoverable_read(self):
        class HookProtocolError(RuntimeError):
            pass
        def failed(name, args):
            raise HookProtocolError("retrieval_stale_before_read")
        self.runtime.native_reader = failed
        with self.assertRaises(HookProtocolError):
            self.begin()
        self.assertEqual(self.runtime.snapshot()["pages"], [])

    def test_native_protocol_errors_escape_instead_of_failed_result(self):
        changes = {
            "native_binding": lambda response: response.pop("queryHash"),
            "native_result": lambda response: response.update(result=None),
            "pagination": lambda response: response["result"]["metadata"].update(range=[0, 9]),
        }
        for code, change in changes.items():
            with self.subTest(code=code):
                previous = self.runtime
                self.runtime = RetrievalRuntime(self.temp.name, "exec", code, self.native, self.hook)
                native = self.runtime.native_reader
                def corrupt(name, args):
                    response = native(name, args)
                    change(response)
                    if isinstance(response.get("result"), dict):
                        response["resultHash"] = native_hash(response["result"])
                    return response
                self.runtime.native_reader = corrupt
                self.assert_error(code, lambda: self.begin())
                self.assertEqual(self.runtime.snapshot()["pages"], [])
                self.runtime = previous

    def test_duplicate_native_identity_escapes(self):
        self.begin()
        original_action = self.runtime.snapshot()["pages"][0]["actionId"]
        native = self.runtime.native_reader
        def duplicate(name, args):
            response = native(name, args)
            response["actionId"] = original_action
            return response
        self.runtime.native_reader = duplicate
        self.assert_error("duplicate_page", lambda: self.runtime.step(self.bound(
            "review_next", "next", reviews=self.reviews(), nextRead=self.next_read())))
        self.assertEqual(len(self.runtime.snapshot()["pages"]), 1)

    def test_projection_binding_error_escapes(self):
        first = self.begin()
        first["pages"][0]["resultHash"] = "changed"
        messages = [{"role": "tool", "tool_call_id": "call-1", "content": json.dumps(first)}]
        self.assert_error("projection_binding", lambda: self.runtime.project_messages(messages))

    def test_unknown_stop_exception_is_not_a_failed_page(self):
        def stop(name, args):
            raise RuntimeError("stale-generation-stop")
        self.runtime.native_reader = stop
        with self.assertRaisesRegex(RuntimeError, "stale-generation-stop"):
            self.begin()
        self.assertEqual(self.runtime.snapshot()["pages"], [])

    def test_receipt_http_roundtrip_uses_json_integer_clock(self):
        # JSON.stringify on the Node server writes an integral ARE clock as
        # 10, and the HTTP parser therefore supplies a Python int, not 10.0.
        server_projection = '{"observedAt":10,"schemaVersion":"test"}'
        receipt_projection = json.loads(server_projection)
        self.assertIsInstance(receipt_projection["observedAt"], int)
        self.assertEqual(receipt_projection, {"observedAt": 10.0, "schemaVersion": "test"})
        self.assertEqual(canonical_hash(receipt_projection),
                         canonical_hash({"observedAt": 10, "schemaVersion": "test"}))

    def test_twenty_old_steps_do_not_replicate_current_candidates(self):
        first = self.begin()
        begin_args = {"op": "begin", "requestId": "begin", "criteria": {
            "userRef": "latest", "predicate": "Job Producer", "stopRule": "find_all"}}
        history = [{"role": "user", "content": "preserve the complete user request"}]
        for index in range(20):
            call_id = "history-" + str(index)
            replay = self.runtime.step(begin_args, call_id=call_id, user_ref="user-visible-1")
            history.extend([{"role": "assistant", "content": "observable plan " + str(index),
                             "tool_calls": [{"id": call_id, "type": "function",
                                             "function": {"name": "capybara_retrieval_step", "arguments": "{}"}}]},
                            {"role": "tool", "tool_call_id": call_id, "content": json.dumps(replay)}])
        reviews = self.reviews()
        reviews[0]["records"][0]["decision"] = "keep"
        reviews[0]["records"][1]["decision"] = "defer"
        completed = self.runtime.step(self.bound("review_finish", "finish", reviews=reviews), call_id="latest")
        history.extend([{"role": "assistant", "tool_calls": [{"id": "latest", "type": "function",
            "function": {"name": "capybara_retrieval_step", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "latest", "content": json.dumps(completed)}])
        before_snapshot = self.runtime.snapshot()
        projected, plan = self.runtime.project_messages(history)
        self.assertEqual(self.runtime.snapshot(), before_snapshot)
        self.assertEqual(plan, before_snapshot["projection"])
        self.assertEqual(len(projected), len(history))
        for before, after in zip(history, projected):
            if before["role"] != "tool":
                self.assertEqual(before, after)
            else:
                self.assertEqual(before["tool_call_id"], after["tool_call_id"])
        old_views = [json.loads(item["content"]) for item in projected
                     if item["role"] == "tool" and item["tool_call_id"] != "latest"]
        self.assertEqual(len(old_views), 20)
        self.assertTrue(all(item["archived"] and "retrieval" not in item and "projection" not in item
                            and "pages" not in item for item in old_views))
        latest = json.loads(projected[-1]["content"])
        self.assertEqual(len(latest["retrieval"]["candidates"]), 2)
        self.assertEqual(latest["pages"], [])
        self.assertNotIn("pages", latest["retrieval"])
        self.assertNotIn("certificates", latest["projection"])
        tool_text = "\n".join(item["content"] for item in projected if item["role"] == "tool")
        for candidate in before_snapshot["candidates"]:
            self.assertEqual(tool_text.count(candidate["body"]), 1)
        short, _ = self.runtime.project_messages([history[0], *history[-2:]])
        short_text = "\n".join(item["content"] for item in short if item["role"] == "tool")
        for candidate in before_snapshot["candidates"]:
            self.assertEqual(short_text.count(candidate["body"]), tool_text.count(candidate["body"]))
        self.assertEqual(latest["retrieval"]["candidates"], json.loads(short[-1]["content"])["retrieval"]["candidates"])
        self.assertIn("Name: Person 9;", history[2]["content"])
        self.assertNotIn("Name: Person 9;", tool_text)

    def test_latest_workset_pending_pages_once_and_reviewed_candidates_once(self):
        first = self.begin()
        reviews = self.reviews()
        reviews[0]["records"][0]["decision"] = "keep"
        reviews[0]["records"][1]["decision"] = "defer"
        second = self.runtime.step(self.bound("review_next", "next", reviews=reviews,
            nextRead=self.next_read()), call_id="call-2")
        messages = [{"role": "tool", "tool_call_id": "call-1", "content": json.dumps(first)},
                    {"role": "tool", "tool_call_id": "call-2", "content": json.dumps(second)}]
        projected, _ = self.runtime.project_messages(messages)
        latest = json.loads(projected[-1]["content"])
        self.assertEqual([page["range"] for page in latest["pages"]], [[10, 20], [20, 25]])
        self.assertEqual(len(latest["retrieval"]["candidates"]), 2)
        self.assertNotIn("pages", latest["retrieval"])
        all_tools = "\n".join(item["content"] for item in projected)
        for page in self.runtime.snapshot()["pages"]:
            for record in page["records"]:
                if record.get("decision") == "reject":
                    continue
                self.assertEqual(all_tools.count(record["body"]), 1)
        self.assertEqual(json.loads(projected[0]["content"])["archived"], True)

    def test_no_unregistered_message_projection(self):
        first = self.begin()
        messages = [{"role": "tool", "tool_call_id": "not-issued", "content": json.dumps(first)}]
        self.assertEqual(self.runtime.project_messages(messages)[0], messages)


if __name__ == "__main__":
    unittest.main()
