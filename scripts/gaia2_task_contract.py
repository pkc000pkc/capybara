"""Durable visible-user waiting obligations; no model, native tool, or clock driver.

Only constructor-injected trusted extractor/reviewer callbacks may register an
obligation or a no-wait resolution. Actor tool arguments are never declarations.
Spans use Python Unicode codepoint offsets, and sourceHash hashes original UTF-8.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import uuid

from gaia2_notification_directives import (NotificationDirectiveError,
    evaluate_directives, legacy_directives, normalize_directives)

STATE_SCHEMA = "gaia2-task-contract-state-v1"
MAX_SOURCES = 64
MAX_OBLIGATIONS = 64
MAX_CALLS = 256
MAX_SOURCE_BYTES = 262144
MAX_DURATION = 366 * 86400
MAX_RESOLVER_ATTEMPTS = 2
RETRYABLE_RESOLVER_ERRORS = {"model_transport_error", "resolver_callback_error", "raw_missing_field", "raw_field_type",
    "raw_unknown_field", "raw_proposal_schema", "quote_schema", "quote_context_schema", "quote_not_found", "quote_not_unique",
    "response_choices", "response_finish", "response_content", "response_tool_count", "response_tool_type", "response_tool_name",
    "response_json", "response_json_object", "response_size", "response_duplicate_key", "response_nonfinite",
    "review_schema", "review_checks", "proposal_schema", "obligation_schema"}
ACTIVE = {"pending", "elapsed_pending_review", "interrupted", "technical_blocked"}
SIGNALS = {"initial_observation", "candidate_changed", "deadline", "deadline_approaching", "timeout", "unchanged",
    "scan_budget", "native_error", "incomplete_observation", "clock_error", "environment_stop", "user_update", "cancelled"}


class TaskContractError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def canonical_bytes(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def task_contract_hash(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def native_hash(value):
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def clone(value):
    return json.loads(canonical_bytes(value))


def finite(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def text(value, maximum=512):
    return isinstance(value, str) and 0 < len(value) <= maximum


def fail(code, message):
    raise TaskContractError(code, message)


class TaskContractRuntime:
    def __init__(self, evidence_root, execution_id, session_id, extractor, reviewer, *,
                 max_watch_calls=32, max_native_waits=128, max_native_scans=128):
        if not text(execution_id) or not text(session_id) or not callable(extractor) or not callable(reviewer):
            fail("constructor", "Trusted identities and extractor/reviewer callbacks are required")
        limits = (max_watch_calls, max_native_waits, max_native_scans)
        if any(type(value) is not int or value < 1 or value > 4096 for value in limits):
            fail("budget", "Task-contract bounds must be finite positive integers")
        self.execution_id, self.session_id = execution_id, session_id
        self.extractor, self.reviewer = extractor, reviewer
        self.limits = {"watchCalls": max_watch_calls, "nativeWaits": max_native_waits, "nativeScans": max_native_scans}
        self.root = Path(evidence_root).absolute()
        self._no_symlink(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.root = self.root.resolve()
        self.directory = self.root / task_contract_hash([execution_id, session_id])[:24]
        self._no_symlink(self.directory)
        self.directory.mkdir(exist_ok=True)
        self.path = self.directory / "state.json"
        self.state = {"schemaVersion": STATE_SCHEMA, "enabled": True, "executionId": execution_id,
            "sessionId": session_id, "revision": 0, "clock": None, "interruption": None, "sources": [], "obligations": []}
        self.calls, self.reviews = {}, {}
        if self.path.exists():
            stored = self._read_path(self.path)
            ledger_hash = stored.pop("ledgerHash", None) if isinstance(stored, dict) else None
            if ledger_hash != task_contract_hash(stored):
                fail("stored_state_hash", "Task-contract ledger bytes are not internally consistent")
            if stored.get("schemaVersion") != "gaia2-task-contract-ledger-v1" or stored.get("limits") != self.limits:
                fail("stored_state", "Task-contract ledger schema or limits differ")
            self.state, self.calls, self.reviews = stored.get("state"), stored.get("calls"), stored.get("reviews")
            self._validate_loaded()

    @staticmethod
    def _no_symlink(path):
        if any(item.is_symlink() for item in (path, *path.parents)):
            fail("evidence_path", "Task-contract evidence cannot traverse symbolic links")

    def _read_path(self, path):
        self._no_symlink(path)
        if not path.resolve().is_relative_to(self.directory.resolve()):
            fail("evidence_path", "Task-contract evidence escapes its session")
        try:
            return json.loads(path.read_text(encoding="utf-8"), parse_constant=lambda _: fail("evidence_json", "Non-finite JSON evidence"))
        except (ValueError, UnicodeError) as error:
            raise TaskContractError("evidence_json", "Unreadable task-contract evidence") from error

    def _artifact(self, kind, value):
        name = kind + "-" + uuid.uuid4().hex + ".json"
        target = self.directory / name
        payload = canonical_bytes(value)
        with target.open("xb") as stream:
            stream.write(payload)
        return {"path": self.directory.name + "/" + name, "sha256": hashlib.sha256(payload).hexdigest()}

    def _load_ref(self, ref):
        if not isinstance(ref, dict) or set(ref) != {"path", "sha256"} or not isinstance(ref["path"], str):
            fail("evidence_ref", "Invalid task-contract evidence reference")
        target = self.root / ref["path"]
        self._no_symlink(target)
        if not target.resolve().is_relative_to(self.directory) or not target.is_file():
            fail("evidence_path", "Cross-session or missing task-contract evidence")
        if hashlib.sha256(target.read_bytes()).hexdigest() != ref["sha256"]:
            fail("evidence_hash", "Task-contract evidence changed")
        return self._read_path(target)

    def _validate_loaded(self):
        state = self.state
        if (not isinstance(state, dict) or state.get("schemaVersion") != STATE_SCHEMA or state.get("enabled") is not True
            or state.get("executionId") != self.execution_id or state.get("sessionId") != self.session_id
            or not isinstance(state.get("sources"), list) or len(state["sources"]) > MAX_SOURCES
            or not isinstance(state.get("obligations"), list) or len(state["obligations"]) > MAX_OBLIGATIONS
            or not isinstance(self.calls, dict) or len(self.calls) > MAX_CALLS
            or not isinstance(self.reviews, dict) or len(self.reviews) > MAX_CALLS):
            fail("stored_state", "Stored task-contract identity or bounds differ")
        for source in state["sources"]:
            if (source.get("resolution") not in {"registered", "reviewed_none", "ambiguous"}
                or source.get("notificationPolicy") not in {"allow", "forbid_until_deadline", "forbid"}
                or not finite(source.get("arrivedAt")) or not isinstance(source.get("obligationIds"), list)):
                fail("stored_state", "Stored source resolution or notification policy is invalid")
            original = self._load_ref(source["evidenceRef"])
            if (original.get("executionId") != self.execution_id or original.get("sessionId") != self.session_id
                or original.get("userRef") != source["userRef"] or original.get("sourceHash") != source["sourceHash"]
                or hashlib.sha256(original["text"].encode("utf-8")).hexdigest() != source["sourceHash"]):
                fail("stored_state", "Stored source identity differs")
            for key in ("proposalRef", "reviewRef", "rawProposalRef", "normalizedProposalRef", "anchoringRef", "extractionRef"):
                if source.get(key) is not None:
                    self._load_ref(source[key])
            if "resolverAttempts" in source:
                history = source.get("attemptHistory")
                if (type(source["resolverAttempts"]) is not int or source["resolverAttempts"] not in (1, 2)
                        or type(source.get("resolverRetryable")) is not bool or type(history) is not list
                        or len(history) != source["resolverAttempts"] - 1
                        or source["resolverRetryable"] and (source["resolution"] != "ambiguous" or source["resolverAttempts"] != 1)):
                    fail("stored_resolver_history", "Resolver budget/history is inconsistent")
                for old in history:
                    if (type(old) is not dict or any(old.get(key) != source[key] for key in ("userRef", "sourceHash", "arrivedAt", "evidenceRef"))
                            or old.get("resolution") != "ambiguous" or old.get("resolverRetryable") is not True or old.get("resolverAttempts") != 1):
                        fail("stored_resolver_history", "Original source identity or failed attempt changed")
                    for key in ("evidenceRef", "proposalRef", "reviewRef", "rawProposalRef", "normalizedProposalRef", "anchoringRef", "extractionRef"):
                        if old.get(key) is not None:
                            self._load_ref(old[key])
        for item in state["obligations"]:
            if (item.get("status") not in ACTIVE | {"satisfied", "revoked"}
                or item.get("mode") not in {"monitor_until", "condition_once"} or not finite(item.get("deadline"))
                or not any(source["userRef"] == item.get("userRef") and source["sourceHash"] == item.get("sourceHash")
                    and item.get("id") in source["obligationIds"] for source in state["sources"])):
                fail("stored_state", "Stored obligation status or source binding is invalid")
            if item.get("completionReason") not in {None, "condition_satisfied", "deadline_reviewed"} or ((item["status"] == "satisfied") != (item.get("completionReason") is not None)):
                fail("stored_state", "Stored waiting-duty completion reason is inconsistent")
            if item.get("pendingEvidence") is not None:
                self._load_ref(item["pendingEvidence"]["evidenceRef"])

    def _commit(self):
        self.state["revision"] += 1
        if len(canonical_bytes(self.state)) > 131072:
            fail("state_budget", "Task-contract state exceeds the audited Host receipt bound")
        value = {"schemaVersion": "gaia2-task-contract-ledger-v1", "limits": self.limits,
            "state": self.state, "calls": self.calls, "reviews": self.reviews}
        value["ledgerHash"] = task_contract_hash(value)
        temporary = self.path.with_name("state.tmp-" + uuid.uuid4().hex)
        self._no_symlink(self.path)
        with temporary.open("xb") as stream:
            stream.write(canonical_bytes(value)); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, self.path)

    def snapshot(self):
        return clone(self.state)

    @staticmethod
    def _source_directives(source, deadlines):
        """Return canonical notification directives for one source.

        Existing v1 ledgers have only ``notificationPolicy``.  They are
        deterministically projected here; a future proposal-v3 may provide
        an explicit ``notificationDirectives`` list, which is validated at the
        same boundary.  A malformed or missing trusted projection remains
        fail-closed for the AUI channel.
        """
        value = source.get("notificationDirectives")
        if value is not None:
            return normalize_directives(value, deadline=max(deadlines) if deadlines else None)
        policy = source.get("notificationPolicy")
        if policy == "forbid_until_deadline" and not deadlines:
            return legacy_directives("forbid")
        return legacy_directives(policy, deadline=max(deadlines) if deadlines else None)

    def load_evidence_ref(self, ref):
        """Read an already-issued resolver artifact without exposing path logic.

        The window registration pipeline uses this narrow accessor to bind the
        normalized proposal and independent review to the same session ledger.
        It does not accept arbitrary paths or model-authored content.
        """
        return clone(self._load_ref(ref))

    def _clock(self, now):
        if not finite(now) or self.state["clock"] is not None and now < self.state["clock"]:
            for item in self.state["obligations"]:
                if item["status"] in ACTIVE:
                    item["status"], item["lastSignal"] = "technical_blocked", "clock_error"
            self.state["interruption"] = "clock_error"
            self._commit()
            fail("clock_error", "Official ARE clock is invalid or moved backwards")
        self.state["clock"] = now

    def advance(self, now):
        self._clock(now)
        for item in self.state["obligations"]:
            if item["status"] == "pending" and now >= item["deadline"]:
                item["status"] = "elapsed_pending_review"
        self._commit()
        return self.snapshot()

    @staticmethod
    def _span(span, source_text):
        if (not isinstance(span, dict) or set(span) != {"start", "end", "text"}
            or type(span.get("start")) is not int or type(span.get("end")) is not int
            or not 0 <= span["start"] < span["end"] <= len(source_text)
            or span["text"] != source_text[span["start"]:span["end"]]):
            fail("source_span", "An exact original-user Unicode codepoint span is required")

    def _proposal(self, proposal, review, source):
        if (not isinstance(proposal, dict) or set(proposal) != {"schemaVersion", "sourceHash", "resolution", "notificationPolicy", "obligations", "revocations"}
            or proposal["schemaVersion"] != "gaia2-task-contract-proposal-v1" or proposal["sourceHash"] != source["sourceHash"]
            or proposal["resolution"] not in {"obligations", "none", "ambiguous"}
            or proposal["notificationPolicy"] not in {"allow", "forbid_until_deadline", "forbid"}
            or not isinstance(proposal["obligations"], list) or len(proposal["obligations"]) > 16
            or not isinstance(proposal["revocations"], list) or len(proposal["revocations"]) > 64):
            fail("proposal_schema", "Invalid trusted extractor proposal")
        if (not isinstance(review, dict) or review.get("schemaVersion") not in {"gaia2-task-contract-review-v1", "gaia2-task-contract-review-v2"}
            or review.get("sourceHash") != source["sourceHash"] or review.get("proposalHash") != task_contract_hash(proposal)
            or review.get("decision") != "approved" or review.get("notificationVerified") is not True
            or not text(review.get("reason"), 2000)):
            fail("review_rejected", "Independent source/proposal/notification review is required")
        obligations, revocations = proposal["obligations"], proposal["revocations"]
        if proposal["resolution"] == "ambiguous":
            fail("ambiguous", "Trusted source resolution remains ambiguous")
        if proposal["resolution"] == "none" and obligations or proposal["resolution"] == "obligations" and not obligations and not revocations:
            fail("proposal_resolution", "Proposal resolution and obligation set disagree")
        if proposal["notificationPolicy"] == "forbid_until_deadline" and not obligations:
            fail("notification_deadline", "Until-deadline notification policy needs an explicit source deadline")
        expected_checks = [{"index": index, "spanVerified": True, "modeVerified": True, "timeVerified": True} for index in range(len(obligations))]
        if review.get("obligationChecks") != expected_checks:
            fail("review_obligations", "Every obligation needs independent span/mode/time review")
        if review.get("revocationChecks") != [{"index": index, "explicitRevocation": True} for index in range(len(revocations))]:
            fail("review_revocations", "Every revocation needs independent explicit-user review")
        prepared = []
        for index, item in enumerate(obligations):
            if (not isinstance(item, dict) or set(item) != {"span", "mode", "goal", "timeBasis", "recipe"}
                or item["mode"] not in {"monitor_until", "condition_once"} or not text(item["goal"], 2000) or item["recipe"] is not None):
                fail("obligation_schema", "Invalid obligation or untrusted extractor recipe")
            self._span(item["span"], source["text"])
            basis = item["timeBasis"]
            if not isinstance(basis, dict):
                fail("time_basis", "Explicit verified time basis is required")
            if basis.get("kind") == "relative" and set(basis) == {"kind", "durationSeconds"} and finite(basis["durationSeconds"]) and 0 < basis["durationSeconds"] <= MAX_DURATION:
                deadline = source["arrivedAt"] + basis["durationSeconds"]
            elif basis.get("kind") == "absolute" and set(basis) == {"kind", "deadline"} and finite(basis["deadline"]) and source["arrivedAt"] <= basis["deadline"] <= source["arrivedAt"] + MAX_DURATION:
                deadline = basis["deadline"]
            else:
                fail("time_basis", "Relative or absolute official-clock deadline is invalid")
            prepared.append({"id": "obligation-" + task_contract_hash([self.execution_id, self.session_id, source["userRef"], source["sourceHash"], index])[:24],
                "userRef": source["userRef"], "sourceHash": source["sourceHash"], "span": clone(item["span"]),
                "mode": item["mode"], "deadline": deadline, "goal": item["goal"], "recipe": None, "status": "pending",
                "pendingEvidence": None, "counts": {"watchCalls": 0, "nativeWaits": 0, "nativeScans": 0},
                "lastSignal": None, "lastReviewedActionId": None, "completionReason": None})
        revoke_ids = []
        for item in revocations:
            if not isinstance(item, dict) or set(item) != {"obligationId", "span"}:
                fail("revocation_schema", "Explicit revocation identity and source span are required")
            self._span(item["span"], source["text"])
            target = self._obligation(item["obligationId"])
            if target["userRef"] == source["userRef"] or target["status"] not in ACTIVE:
                fail("revocation_target", "Only a prior unfinished obligation can be explicitly revoked")
            revoke_ids.append(target["id"])
        if len(set(revoke_ids)) != len(revoke_ids):
            fail("revocation_target", "Duplicate obligation revocations are invalid")
        return prepared, revoke_ids

    def resolve_user(self, user_ref, text_value, arrived_at):
        if not text(user_ref) or not isinstance(text_value, str) or not text_value or len(text_value.encode("utf-8")) > MAX_SOURCE_BYTES or not finite(arrived_at):
            fail("user_source", "A real bounded visible user source and official arrival time are required")
        source_hash = hashlib.sha256(text_value.encode("utf-8")).hexdigest()
        existing = next((item for item in self.state["sources"] if item["userRef"] == user_ref), None)
        if existing:
            if existing["sourceHash"] != source_hash or existing["arrivedAt"] != arrived_at:
                fail("source_identity", "A user occurrence cannot change its original text or clock anchor")
            if (existing["resolution"] != "ambiguous" or existing.get("resolverRetryable") is not True
                    or existing.get("resolverAttempts", 1) >= MAX_RESOLVER_ATTEMPTS):
                return self.snapshot()
        if existing is None and len(self.state["sources"]) >= MAX_SOURCES:
            self.state["interruption"] = "source_budget"
            self._commit()
            fail("source_budget", "Visible-user source budget exhausted")
        source = {"schemaVersion": "gaia2-task-contract-source-v1", "executionId": self.execution_id,
            "sessionId": self.session_id, "userRef": user_ref, "text": text_value, "sourceHash": source_hash, "arrivedAt": arrived_at}
        record = {"userRef": user_ref, "sourceHash": source_hash, "arrivedAt": arrived_at, "resolution": "ambiguous",
            "notificationPolicy": "forbid", "notificationDirectives": legacy_directives("forbid"),
            "obligationIds": [], "reason": None,
            "evidenceRef": existing["evidenceRef"] if existing else self._artifact("user", source), "proposalRef": None, "reviewRef": None,
            "rawProposalRef": None, "normalizedProposalRef": None, "anchoringRef": None, "extractionRef": None,
            "resolverProtocol": "legacy_trusted_v1", "resolverAttempts": 1 if existing is None else existing.get("resolverAttempts", 1) + 1,
            "resolverRetryable": False, "errorCategory": None,
            "attemptHistory": [] if existing is None else clone(existing.get("attemptHistory", [])) + [
                {key: clone(value) for key, value in existing.items() if key != "attemptHistory"}]}
        try:
            extracted = clone(self.extractor(clone(source)))
            if isinstance(extracted, dict) and extracted.get("schemaVersion") == "gaia2-task-contract-extraction-v2":
                from gaia2_task_contract_normalize import verify_extraction, MAX_EXTRACTION_BYTES
                if len(canonical_bytes(extracted)) > MAX_EXTRACTION_BYTES:
                    fail("extraction_size", "Bounded extraction evidence is required")
                record["resolverProtocol"] = "quote_v2"
                record["extractionRef"] = self._artifact("extraction", extracted)
                record["rawProposalRef"] = self._artifact("raw-proposal", {
                    "schemaVersion": "gaia2-task-contract-raw-v2", "sourceHash": source_hash,
                    "rawProposal": extracted.get("rawProposal"), "rawProposalHash": extracted.get("rawProposalHash"),
                    "attempts": extracted.get("attempts")})
                verify_extraction(source, extracted)
                if extracted["anchoringReceipt"] is not None:
                    record["anchoringRef"] = self._artifact("anchoring", extracted["anchoringReceipt"])
                if extracted["normalizedProposal"] is not None:
                    record["normalizedProposalRef"] = self._artifact("normalized-proposal", extracted["normalizedProposal"])
                    record["proposalRef"] = record["normalizedProposalRef"]
                if extracted["status"] != "normalized":
                    fail(extracted.get("reason") or "anchoring_unresolved", "Source quote extraction remains unresolved")
                proposal = extracted["normalizedProposal"]
                review_input = extracted
            else:
                # Explicit compatibility for trusted constructor-injected old
                # fixtures, never the production quote-only model adapter.
                proposal = extracted
                review_input = proposal
            if len(canonical_bytes(proposal)) > 65536:
                fail("proposal_size", "Extractor proposal exceeds safe bounds")
            if record["proposalRef"] is None:
                record["proposalRef"] = self._artifact("proposal", proposal)
            review = clone(self.reviewer(clone(source), clone(review_input)))
            if len(canonical_bytes(review)) > 32768:
                fail("review_size", "Reviewer result exceeds safe bounds")
            record["reviewRef"] = self._artifact("review", review)
            if record["resolverProtocol"] == "quote_v2":
                # Independent re-anchoring happens again before authority is
                # registered. An old approval cannot follow a changed quote,
                # source, semantic proposal or anchoring derivation.
                verify_extraction(source, extracted)
                if (review.get("schemaVersion") != "gaia2-task-contract-review-v2"
                        or review.get("sourceHash") != source_hash
                        or review.get("rawProposalHash") != extracted["rawProposalHash"]
                        or review.get("proposalHash") != extracted["normalizedProposalHash"]
                        or review.get("anchoringHash") != extracted["anchoringHash"]):
                    fail("review_hash_binding", "Review differs from actual source/raw/normalized/anchoring hashes")
            prepared, revoke_ids = self._proposal(proposal, review, source)
            if len(self.state["obligations"]) + len(prepared) > MAX_OBLIGATIONS:
                fail("obligation_budget", "Task-contract obligation budget exhausted")
            for obligation_id in revoke_ids:
                target = self._obligation(obligation_id)
                target["status"], target["pendingEvidence"] = "revoked", None
            self.state["obligations"].extend(prepared)
            deadlines = [item["deadline"] for item in prepared]
            record.update({"resolution": "registered" if prepared or revoke_ids else "reviewed_none",
                "notificationPolicy": proposal["notificationPolicy"],
                "notificationDirectives": legacy_directives(proposal["notificationPolicy"],
                    deadline=max(deadlines) if deadlines else None) if proposal["notificationPolicy"] != "forbid_until_deadline" or deadlines
                    else legacy_directives("forbid"),
                "obligationIds": [item["id"] for item in prepared], "reason": review["reason"]})
        except Exception as error:
            # Resolver adapters expose only bounded public diagnostic codes;
            # never copy arbitrary provider exception strings into context.
            code = getattr(error, "code", None)
            record["reason"] = code if type(code) is str and re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code) else "trusted_resolver_failed"
            record["errorCategory"] = ("semantic_ambiguous" if record["reason"] in {"ambiguous", "review_rejected"}
                else "transport_error" if record["reason"] in {"model_transport_error", "resolver_callback_error"}
                else "quote_error" if record["reason"] in {"quote_not_found", "quote_not_unique"}
                else "protocol_error" if record["reason"] in RETRYABLE_RESOLVER_ERRORS else "integrity_or_validation_error")
            record["resolverRetryable"] = record["reason"] in RETRYABLE_RESOLVER_ERRORS and record["resolverAttempts"] < MAX_RESOLVER_ATTEMPTS
        if existing is None:
            self.state["sources"].append(record)
        else:
            self.state["sources"][self.state["sources"].index(existing)] = record
        self._commit()
        return self.snapshot()

    def _obligation(self, obligation_id):
        value = next((item for item in self.state["obligations"] if item["id"] == obligation_id), None)
        if value is None:
            fail("obligation_identity", "Unknown task-contract obligation")
        return value

    def bind_recipe(self, obligation_id, recipe):
        item = self._obligation(obligation_id)
        if (not isinstance(recipe, dict) or set(recipe) != {"queryTool", "queryArguments", "queryHash", "intervalSeconds", "maxScans"}
            or not isinstance(recipe["queryTool"], str) or re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*__[A-Za-z][A-Za-z0-9_]*", recipe["queryTool"]) is None
            or not isinstance(recipe.get("queryHash"), str) or re.fullmatch(r"[a-f0-9]{64}", recipe["queryHash"]) is None
            or not isinstance(recipe["queryArguments"], dict) or len(canonical_bytes(recipe["queryArguments"])) > 4096
            or type(recipe["intervalSeconds"]) is not int or not 1 <= recipe["intervalSeconds"] <= 900
            or type(recipe["maxScans"]) is not int or not 1 <= recipe["maxScans"] <= 1000):
            fail("recipe_schema", "A bounded root-validated native read recipe is required")
        if item["status"] not in {"pending", "elapsed_pending_review"}:
            fail("recipe_status", "Inactive or technically blocked obligations cannot acquire recipes")
        if item["recipe"] is not None and item["recipe"] != recipe:
            fail("recipe_rebind", "An existing exact native query recipe cannot be silently replaced")
        item["recipe"] = clone(recipe)
        self._commit()
        return self.snapshot()

    def _evidence(self, item, value, now):
        if (not isinstance(value, dict) or not text(value.get("actionId")) or not finite(value.get("observedAt"))
            or value["observedAt"] > now or value["observedAt"] < next(source["arrivedAt"] for source in self.state["sources"] if source["userRef"] == item["userRef"])
            or value.get("complete") is not True or value.get("viewComplete") is not True or "result" not in value
            or native_hash(value["result"]) != value.get("resultHash") or len(canonical_bytes(value)) > 32768):
            fail("native_evidence", "Complete actual native evidence and original result hash are required")
        recipe = item["recipe"]
        if (recipe is None or value.get("canonicalName") != recipe["queryTool"]
            or value.get("queryHash") != recipe["queryHash"]):
            fail("native_evidence_binding", "Native evidence differs from the root-validated exact query")
        ref = self._artifact("native", value)
        return {key: clone(value[key]) for key in ("actionId", "canonicalName", "queryHash", "resultHash", "observedAt", "complete", "viewComplete")} | {"evidenceRef": ref}

    def note_signal(self, obligation_id, kind, evidence, now, call_id, counts):
        if (kind not in SIGNALS or not text(call_id) or not isinstance(counts, dict) or set(counts) != {"nativeWaits", "nativeScans"}
            or any(type(value) is not int or value < 0 or value > 4096 for value in counts.values())):
            fail("signal_schema", "A bounded actual controller signal and counts are required")
        self._clock(now)
        item = self._obligation(obligation_id)
        request_hash = task_contract_hash([obligation_id, kind, evidence, now, counts])
        if call_id in self.calls:
            if self.calls[call_id] != request_hash:
                fail("signal_replay", "A controller call identity cannot change its evidence")
            return self.snapshot()
        if len(self.calls) >= MAX_CALLS:
            fail("call_budget", "Controller call ledger budget exhausted")
        if item["status"] not in {"pending", "elapsed_pending_review"}:
            fail("signal_status", "Inactive or blocked obligations cannot accept more controller signals")
        self.calls[call_id] = request_hash
        item["counts"]["watchCalls"] += 1
        for key in counts:
            item["counts"][key] += counts[key]
        item["lastSignal"] = kind
        if any(item["counts"][key] > self.limits[key] for key in self.limits) or kind in {"native_error", "incomplete_observation", "clock_error"}:
            item["status"], item["pendingEvidence"] = "technical_blocked", None
        elif kind in {"environment_stop", "cancelled"}:
            item["status"], item["pendingEvidence"] = "interrupted", None
        elif kind == "scan_budget":
            # A scan budget bounds one controller invocation; it is not the
            # business-window deadline. Keep the obligation active so the
            # actor can register the next wait call without converting a
            # normal rescan boundary into a technical failure.
            item["pendingEvidence"] = None
            item["status"] = "elapsed_pending_review" if now >= item["deadline"] else "pending"
        elif kind == "user_update":
            item["pendingEvidence"] = None
            item["status"] = "elapsed_pending_review" if now >= item["deadline"] else "pending"
        else:
            if evidence is not None:
                try:
                    item["pendingEvidence"] = self._evidence(item, evidence, now)
                except TaskContractError:
                    item["status"], item["pendingEvidence"] = "technical_blocked", None
                    self._commit()
                    raise
            item["status"] = "elapsed_pending_review" if now >= item["deadline"] else "pending"
        self._commit()
        return self.snapshot()

    def review_event(self, obligation_id, action_id, decision, reason, now):
        if decision not in {"continue", "condition_satisfied", "deadline_reviewed"} or not text(action_id) or not text(reason, 2000):
            fail("event_review", "An explicit bounded Actor evidence review is required")
        self._clock(now)
        item = self._obligation(obligation_id)
        review_key = task_contract_hash([obligation_id, action_id])
        value_hash = task_contract_hash([decision, reason])
        if review_key in self.reviews:
            if self.reviews[review_key] != value_hash:
                fail("review_replay", "Already reviewed native evidence cannot receive a different semantic decision")
            return self.snapshot()
        evidence = item["pendingEvidence"]
        if item["status"] not in {"pending", "elapsed_pending_review"} or evidence is None or evidence["actionId"] != action_id:
            fail("event_review_binding", "Only the current complete actual native evidence can be reviewed")
        self._load_ref(evidence["evidenceRef"])
        if len(self.reviews) >= MAX_CALLS:
            fail("review_budget", "Native evidence review budget exhausted")
        if decision == "condition_satisfied":
            if item["mode"] != "condition_once":
                fail("monitor_early_completion", "A monitor-until obligation cannot complete on a candidate")
            item["status"] = "satisfied"
            item["completionReason"] = "condition_satisfied"
        elif decision == "deadline_reviewed":
            if now < item["deadline"] or evidence["observedAt"] < item["deadline"]:
                fail("deadline_evidence", "Elapsed clock alone is not final deadline evidence")
            item["status"] = "satisfied"
            item["completionReason"] = "deadline_reviewed"
        self.reviews[review_key] = value_hash
        item["lastReviewedActionId"], item["pendingEvidence"] = action_id, None
        self._artifact("event-review", {"obligationId": obligation_id, "actionId": action_id, "decision": decision, "reason": reason, "reviewedAt": now})
        self._commit()
        return self.snapshot()

    def finish_decision(self, now, *, channel="aui", trigger="finish", phase="final"):
        self.advance(now)
        sources = self.state["sources"]
        unresolved = [item["userRef"] for item in sources if item["resolution"] == "ambiguous"]
        pending = [item["id"] for item in self.state["obligations"] if item["status"] in ACTIVE]
        notification_blockers = []
        for source in sources:
            deadlines = [item["deadline"] for item in self.state["obligations"] if item["userRef"] == source["userRef"]]
            try:
                notification = evaluate_directives(self._source_directives(source, deadlines),
                    channel=channel, trigger=trigger, phase=phase, now=now)
            except (NotificationDirectiveError, KeyError, TypeError):
                # A corrupted/unknown directive projection must never open the
                # user-facing channel.  Business completion remains separate.
                notification = {"allowed": False}
            if not notification["allowed"]:
                notification_blockers.append(source["userRef"])
        allowed = bool(sources) and not unresolved and not pending and self.state["interruption"] is None
        return {"allowed": allowed, "reason": "ready" if allowed else "source_unresolved" if not sources or unresolved else "interrupted" if self.state["interruption"] else "obligations_pending",
            "pendingObligationIds": pending, "unresolvedSourceRefs": unresolved,
            "notificationAllowed": allowed and not notification_blockers, "notificationBlockers": notification_blockers}

    def interrupt(self, reason):
        if reason not in {"environment_stop", "cancelled", "budget_exhausted", "clock_error", "user_update"}:
            fail("interrupt_reason", "Unknown task-contract interruption")
        if reason == "user_update":
            for item in self.state["obligations"]:
                if item["status"] in {"pending", "elapsed_pending_review"}:
                    item["pendingEvidence"], item["lastSignal"] = None, reason
            self._commit()
            return self.snapshot()
        if self.state["interruption"] is None:
            self.state["interruption"] = reason
        for item in self.state["obligations"]:
            if item["status"] in {"pending", "elapsed_pending_review"}:
                item["status"] = "technical_blocked" if reason in {"budget_exhausted", "clock_error"} else "interrupted"
                item["pendingEvidence"] = None
                item["lastSignal"] = reason
        self._commit()
        return self.snapshot()
