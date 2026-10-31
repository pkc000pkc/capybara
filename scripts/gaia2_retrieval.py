"""Deterministic, evidence-backed retrieval worksets for the GAIA2 bridge.

This module never calls a model or an ARE tool directly.  ``native_reader`` is
the bridge's normal, audited native-tool path; ``control_hook`` must complete
the actual Host acknowledgement before returning.  Local control is not an
authoritative read and does not itself establish business progress.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import uuid
from pathlib import Path
from typing import Any, Callable


TOOL_NAME = "capybara_retrieval_step"
CANONICAL_NAME = "CapybaraRetrieval__step"
NATIVE_TOOL = "Contacts__get_contacts"
OPS = ("begin", "review_next", "review_finish", "continue_read", "reopen", "revise")


class RetrievalError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def native_hash(value: Any) -> str:
    """The bridge's _stable_hash, deliberately not the projection hash format."""
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def tool_schema() -> dict[str, Any]:
    quote = {"type": "object", "properties": {
        "path": {"type": "string"}, "quote": {"type": "string", "minLength": 1},
        "start": {"type": "integer", "minimum": 0}},
        "required": ["path", "quote"], "additionalProperties": False}
    record = {"type": "object", "properties": {
        "recordRef": {"type": "string"},
        "decision": {"type": "string", "enum": ["keep", "reject", "defer"]},
        "quotes": {"type": "array", "description": "Exact evidence is required only when rejecting text from active context.", "items": quote}},
        "required": ["recordRef", "decision", "quotes"], "additionalProperties": False}
    return {"type": "function", "function": {
        "name": TOOL_NAME,
        "description": (
            "Explicit local retrieval control, not a native business action. Begin reads one "
            "Contacts page (10 records), then read 1/2/4 consecutive pages as useful. "
            "Classification is optional and may cover only selected pages or records; "
            "unclassified records remain deferred with their original text. keep matches, "
            "reject known nonmatches with exact quoted evidence, defer uncertainty. "
            "review_next can combine an optional partial review with the next read; "
            "continue_read requires no review, and review_finish only records local progress. "
            "review_next and continue_read REQUIRE nextRead={tool:'Contacts__get_contacts',arguments:{offset:<nextOffset>},pages:1|2|4}; without nextRead nothing is committed or read. "
            "Use returned scopeId/criteriaVersion/revision and stable record/page refs. "
            "criteria.userRef='latest' binds the latest arrived user request. Reopen restores "
            "original evidence, not freshness. A changed criterion requires revise."),
        "parameters": {"type": "object", "properties": {
            "op": {"type": "string", "enum": list(OPS)},
            "requestId": {"type": "string", "minLength": 1, "description": "Unique per logical operation. Different op/arguments require a NEW ID. Reuse only for an exact idempotent retry."},
            "scopeId": {"type": "string"},
            "expectedRevision": {"type": "integer", "minimum": 0},
            "criteriaVersion": {"type": "integer", "minimum": 1},
            "criteria": {"type": "object", "properties": {
                "userRef": {"type": "string", "description": "Use latest unless a public user ref is known."},
                "predicate": {"type": "string", "minLength": 1},
                "stopRule": {"type": "string", "enum": ["find_all", "find_one", "inspect"]}},
                "required": ["predicate"], "additionalProperties": False},
            "reviews": {"type": "array", "items": {"type": "object", "properties": {
                "pageRef": {"type": "string"}, "resultHash": {"type": "string"},
                "records": {"type": "array", "items": record}},
                "required": ["pageRef", "resultHash", "records"], "additionalProperties": False}},
            "nextRead": {"type": "object", "description": "REQUIRED for review_next and continue_read. Choose pages=2 for the next 20 records (two native 10-record pages), or 1/4 within budget.", "properties": {
                "tool": {"type": "string", "enum": [NATIVE_TOOL]},
                "arguments": {"type": "object", "properties": {
                    "offset": {"type": "integer", "minimum": 0}},
                    "required": ["offset"], "additionalProperties": False},
                "pages": {"type": "integer", "enum": [1, 2, 4]}},
                "required": ["tool", "arguments", "pages"], "additionalProperties": False},
            "pageRefs": {"type": "array", "items": {"type": "string"}, "minItems": 1}},
            "required": ["op", "requestId"], "additionalProperties": False}}}


class RetrievalRuntime:
    """One execution/session's retrieval scope, with durable idempotency receipts.

    native_reader(name, arguments) returns result/actionId/queryHash/resultHash/
    observedAt/complete/viewComplete and optional oldBlocker.  result is the
    exact JSON-visible native result (Contacts values already converted to str).

    control_hook(phase, payload) handles review_commit/state_update synchronously.
    Raising (or returning False) means no ACK; no subsequent read is permitted.
    A missing callback is intentionally supported for isolated offline tests.
    """
    # Provider-facing retrieval views are intentionally bounded.  The full
    # page bodies remain in the raw-page artifacts and durable local state; a
    # model should receive only the newest page window and can reopen an older
    # page when its evidence is still needed.  This prevents a full collection
    # scan from turning one tool result into an uncompactable model message.
    MAX_VISIBLE_PENDING_PAGES = 4

    def __init__(self, evidence_root: str | Path, execution_id: str, session_id: str,
                 native_reader: Callable[[str, dict], dict],
                 control_hook: Callable[[str, dict], Any] | None = None):
        if not execution_id or not session_id:
            raise RetrievalError("identity", "Execution and session identities are required")
        self.root = Path(evidence_root).absolute()
        self._no_symlink(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.root = self.root.resolve()
        self.execution_id, self.session_id = execution_id, session_id
        self.native_reader, self.control_hook = native_reader, control_hook
        token = canonical_hash([execution_id, session_id])[:24]
        self.directory = self.root / token
        self._no_symlink(self.directory)
        self.directory.mkdir(exist_ok=True)
        self.state_path = self.directory / "state.json"
        self._state: dict[str, Any] = {"schemaVersion": "gaia2-retrieval-state-v1",
            "executionId": execution_id, "sessionId": session_id, "scope": None,
            "pages": [], "requests": {}, "calls": {}, "needsReconcile": False,
            "consistency": "stable", "control": {}}
        if self.state_path.exists():
            self._state = self._read_path(self.state_path)
            if (self._state.get("schemaVersion") != "gaia2-retrieval-state-v1" or
                    self._state.get("executionId") != execution_id or
                    self._state.get("sessionId") != session_id):
                raise RetrievalError("identity", "Stored state identity does not match")
            for page in self._state["pages"]:
                self._raw_page(page)
                for record in page["records"]:
                    if record.get("decision") is None:
                        record.update(decision="defer", classified=False)

    @staticmethod
    def _no_symlink(path: Path) -> None:
        for candidate in [path, *path.parents]:
            if candidate.exists() and candidate.is_symlink():
                raise RetrievalError("source_path", "Symlinks are not retrieval evidence")

    def _read_path(self, path: Path) -> dict:
        self._no_symlink(path)
        if not path.resolve().is_relative_to(self.root):
            raise RetrievalError("source_path", "Evidence path escapes its session root")
        return json.loads(path.read_text(encoding="utf-8"))

    def _atomic(self, path: Path, value: Any) -> None:
        self._no_symlink(path)
        temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    def _save(self) -> None:
        self._atomic(self.state_path, self._state)

    def _raw_page(self, page: dict) -> dict:
        ref = page["sourceRef"]
        relative = Path(ref["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise RetrievalError("source_path", "Only issued relative evidence paths are accepted")
        path = self.root / relative
        self._no_symlink(path)
        if not path.resolve().is_relative_to(self.directory.resolve()):
            raise RetrievalError("source_path", "Cross-session evidence is forbidden")
        if hashlib.sha256(path.read_bytes()).hexdigest() != ref["sha256"]:
            raise RetrievalError("source_hash", "Raw page artifact hash changed")
        raw = self._read_path(path)
        if (raw.get("executionId") != self.execution_id or raw.get("sessionId") != self.session_id
                or raw.get("pageRef") != page["pageRef"]
                or native_hash(raw["result"]) != page["resultHash"]):
            raise RetrievalError("source_binding", "Raw page is not bound to this native observation")
        return raw

    def _criteria(self, supplied: Any, user_ref: str | None) -> dict:
        if not isinstance(supplied, dict) or set(supplied) - {"userRef", "predicate", "stopRule"}:
            raise RetrievalError("criteria", "A bounded explicit criterion is required")
        predicate = supplied.get("predicate")
        if not isinstance(predicate, str) or not predicate.strip():
            raise RetrievalError("criteria", "Criterion predicate cannot be empty")
        ref = supplied.get("userRef", "latest")
        if ref == "latest":
            ref = user_ref
        if not isinstance(ref, str) or not ref:
            raise RetrievalError("user_ref", "latest requires a trusted arrived USER reference")
        stop = supplied.get("stopRule", "inspect")
        if stop not in ("find_all", "find_one", "inspect"):
            raise RetrievalError("criteria", "Unknown stopping rule")
        return {"userRef": ref, "predicate": predicate, "stopRule": stop}

    def _bound(self, args: dict) -> None:
        scope = self._state["scope"]
        if not scope or args.get("scopeId") != scope["scopeId"]:
            raise RetrievalError("scope", "Scope does not belong to this session")
        if args.get("expectedRevision") != scope["revision"]:
            raise RetrievalError("revision", "Expected revision is no longer current")
        if args.get("criteriaVersion") != scope["criteriaVersion"]:
            raise RetrievalError("criteria_version", "Criterion version is no longer current")
        if self._state["needsReconcile"]:
            raise RetrievalError("needs_reconcile", "Unacknowledged state requires explicit reconciliation")

    def _ack(self, phase: str, args: dict) -> None:
        self._state["control"] = {"op": args["op"], "requestId": args["requestId"],
            "phase": phase, "expectedRevision": args.get("expectedRevision"),
            "scopeId": self._state["scope"]["scopeId"],
            "criteriaVersion": self._state["scope"]["criteriaVersion"]}
        self._save()
        if self.control_hook is not None:
            try:
                response = self.control_hook(phase, {"retrieval": self.snapshot(),
                    "requestId": args["requestId"], "op": args["op"]})
                if response is False:
                    raise RetrievalError("hook_ack", "Host did not acknowledge retrieval state")
            except Exception as exc:
                self._state["needsReconcile"] = True
                self._save()
                raise RetrievalError("hook_ack", "Host acknowledgement failed; no next read permitted") from exc

    def _next_spec(self, spec: Any) -> dict:
        if not isinstance(spec, dict) or set(spec) != {"tool", "arguments", "pages"}:
            raise RetrievalError("next_read", "nextRead requires tool, arguments and pages")
        if spec["tool"] != NATIVE_TOOL:
            raise RetrievalError("tool_scope", "Only the explicit Contacts pagination adapter is enabled")
        arguments = spec["arguments"]
        if not isinstance(arguments, dict) or set(arguments) != {"offset"}:
            raise RetrievalError("next_read", "Contacts native method accepts offset only")
        offset, pages = arguments["offset"], spec["pages"]
        if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
            raise RetrievalError("next_read", "offset must be a nonnegative integer")
        if isinstance(pages, bool) or pages not in (1, 2, 4):
            raise RetrievalError("next_read", "pages must be 1, 2 or 4")
        expected = self.coverage()["nextOffset"]
        if offset != expected:
            raise RetrievalError("coverage_gap", "Read must continue at the next contiguous visible offset")
        return _clone(spec)

    def _register(self, response: Any, offset: int, call_id: str | None) -> dict:
        if not isinstance(response, dict) or not isinstance(response.get("result"), dict):
            raise RetrievalError("native_result", "Native callback must return a JSON-visible result")
        result = _clone(response["result"])
        metadata, contacts = result.get("metadata"), result.get("contacts")
        required = ("actionId", "queryHash", "resultHash", "observedAt", "complete", "viewComplete")
        if any(key not in response for key in required):
            raise RetrievalError("native_binding", "Native observation binding is incomplete")
        if native_hash(result) != response["resultHash"]:
            raise RetrievalError("native_hash", "Native result hash does not match visible data")
        if not isinstance(contacts, list) or any(not isinstance(item, str) for item in contacts):
            raise RetrievalError("native_result", "Contacts adapter only consumes visible contact strings")
        if not isinstance(metadata, dict):
            raise RetrievalError("pagination", "Native range and total metadata are required")
        interval, total = metadata.get("range"), metadata.get("total")
        if (not isinstance(interval, list) or len(interval) != 2
                or any(isinstance(v, bool) or not isinstance(v, int) for v in interval)
                or isinstance(total, bool) or not isinstance(total, int)
                or interval[0] != offset or interval[1] != offset + len(contacts)
                or not 0 <= interval[0] <= interval[1] <= total or len(contacts) > 10
                or (not contacts and offset < total)):
            raise RetrievalError("pagination", "Native page has an invalid or nonprogressing visible range")
        old_totals = {p["total"] for p in self._state["pages"]}
        if old_totals and total not in old_totals:
            self._state["consistency"] = "changed"
        if any(p["actionId"] == response["actionId"] for p in self._state["pages"]):
            raise RetrievalError("duplicate_page", "Native action ID was already registered")
        scope = self._state["scope"]
        page_ref = "page-" + uuid.uuid4().hex
        records = [{"recordRef": page_ref + ":" + str(index), "path": "/contacts/" + str(index),
                    "body": body, "decision": "defer", "quotes": [], "classified": False}
                   for index, body in enumerate(contacts)]
        artifact = {"schemaVersion": "gaia2-retrieval-raw-page-v1", "executionId": self.execution_id,
            "sessionId": self.session_id, "scopeId": scope["scopeId"], "pageRef": page_ref,
            "actionId": response["actionId"], "queryHash": response["queryHash"],
            "resultHash": response["resultHash"], "observedAt": response["observedAt"], "result": result}
        path = self.directory / (page_ref + ".json")
        self._atomic(path, artifact)
        page = {"pageRef": page_ref, "actionId": response["actionId"], "resourceKey": "Contacts",
            "canonicalName": NATIVE_TOOL, "queryHash": response["queryHash"],
            "resultHash": response["resultHash"], "observedAt": response["observedAt"],
            "complete": response["complete"] is True, "beforeViewComplete": response["viewComplete"] is True,
            "oldBlocker": response.get("oldBlocker") is True,
            "records": records, "range": interval, "total": total,
            "nextOffset": interval[1] if interval[1] < total else None,
            "sourceRef": {"path": path.relative_to(self.root).as_posix(),
                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest()},
            "scopeId": scope["scopeId"], "criteriaVersion": scope["criteriaVersion"],
            "reviewCommitted": False, "callId": call_id}
        self._state["pages"].append(page)
        scope["revision"] += 1
        self._save()
        return page

    def _read(self, spec: dict, args: dict, call_id: str | None) -> tuple[list[str], str, str | None]:
        refs: list[str] = []
        offset = spec["arguments"]["offset"]
        for _ in range(spec["pages"]):
            coverage = self.coverage()
            if coverage["total"] is not None and offset >= coverage["total"]:
                break
            try:
                # The request's durable in-progress marker exists before entering native code.
                response = self.native_reader(NATIVE_TOOL, {"offset": offset})
            except TimeoutError:
                return refs, "failed", "TimeoutError"
            except RuntimeError as exc:
                if str(exc) != "retrieval_native_read_failed":
                    raise
                return refs, "failed", "retrieval_native_read_failed"
            # Invalid bindings, stop/generation/Hook errors and unknown exceptions
            # are safety failures, not a recoverable native-read error.
            page = self._register(response, offset, call_id)
            refs.append(page["pageRef"])
            self._ack("state_update", args)
            if self._state["consistency"] != "stable":
                return refs, "source_changed", "source_changed"
            if page["nextOffset"] is None:
                break
            offset = page["nextOffset"]
        return refs, "succeeded", None

    def _review(self, reviews: Any) -> None:
        if reviews is None:
            reviews = []
        if not isinstance(reviews, list):
            raise RetrievalError("review", "Optional reviews must be a list of selected page records")
        pages = {p["pageRef"]: p for p in self._state["pages"]}
        refs = [review.get("pageRef") for review in reviews if isinstance(review, dict)]
        if len(refs) != len(reviews) or len(set(refs)) != len(refs) or any(ref not in pages for ref in refs):
            raise RetrievalError("page_ref", "Review page references must be unique and belong to this scope")
        staged = []
        for review in reviews:
            if set(review) != {"pageRef", "resultHash", "records"}:
                raise RetrievalError("review", "Unknown review field")
            page = pages[review["pageRef"]]
            self._raw_page(page)
            if review["resultHash"] != page["resultHash"]:
                raise RetrievalError("review_hash", "Review references a different native result")
            decisions = review["records"]
            if not isinstance(decisions, list):
                raise RetrievalError("review", "Selected record decisions must be a list")
            by_ref = {d.get("recordRef"): d for d in decisions if isinstance(d, dict)}
            if len(by_ref) != len(decisions) or not set(by_ref).issubset({r["recordRef"] for r in page["records"]}):
                raise RetrievalError("record_ref", "Duplicate or cross-page record reference")
            changes = []
            for record in page["records"]:
                if record["recordRef"] not in by_ref:
                    continue
                decision = by_ref[record["recordRef"]]
                if set(decision) != {"recordRef", "decision", "quotes"}:
                    raise RetrievalError("review", "Unknown record decision field")
                kind, quotes = decision["decision"], decision["quotes"]
                if kind not in ("keep", "reject", "defer") or not isinstance(quotes, list) or kind == "reject" and not quotes:
                    raise RetrievalError("review", "A valid decision is required; reject also needs exact evidence quotes")
                if kind == "reject" and (not page["complete"] or not page["beforeViewComplete"] or page["oldBlocker"]):
                    raise RetrievalError("protected_page", "An existing blocker or incomplete page cannot be archived")
                for quote in quotes:
                    if not isinstance(quote, dict) or set(quote) - {"path", "quote", "start"}:
                        raise RetrievalError("quote", "Unknown quote field")
                    text = quote.get("quote")
                    if quote.get("path") != record["path"] or not isinstance(text, str) or not text:
                        raise RetrievalError("quote", "Quote must identify the exact visible record path")
                    body = record["body"]
                    start = quote.get("start")
                    if start is None:
                        if body.count(text) != 1:
                            raise RetrievalError("quote", "Quote is absent or ambiguous; supply exact start")
                    elif (isinstance(start, bool) or not isinstance(start, int) or start < 0
                          or body[start:start + len(text)] != text):
                        raise RetrievalError("quote", "Quote does not match the original visible characters")
                changes.append((record, kind, _clone(quotes)))
            staged.append((page, changes))
        # No mutation until all pages and record quotes have passed validation.
        for page, changes in staged:
            for record, kind, quotes in changes:
                record.update(decision=kind, quotes=quotes, classified=True)
            if changes:
                page["reviewCommitted"] = True
        if any(changes for _, changes in staged):
            self._state["scope"]["revision"] += 1

    def coverage(self) -> dict:
        pages = self._state["pages"]
        ranges = sorted((p["range"] for p in pages), key=lambda r: r[0])
        cursor = 0
        for start, end in ranges:
            if start != cursor:
                break
            cursor = end
        total = pages[-1]["total"] if pages else None
        all_read = (bool(pages) and cursor == total and self._state["consistency"] == "stable"
                    and all(p["complete"] and p["beforeViewComplete"] for p in pages))
        fully_reviewed = lambda page: all(r.get("classified", page["reviewCommitted"]) for r in page["records"])
        return {"readRanges": _clone(ranges), "reviewedRanges": [p["range"] for p in pages if fully_reviewed(p)],
            "nextOffset": cursor, "total": total, "allRead": all_read,
            "allReviewed": bool(pages) and all(fully_reviewed(p) for p in pages),
            "consistency": self._state["consistency"],
            "unclassified": sum(not r.get("classified", p["reviewCommitted"]) for p in pages for r in p["records"]),
            "deferred": sum(r["decision"] == "defer" for p in pages for r in p["records"])}

    def projection(self) -> dict:
        scope = self._state["scope"]
        if not scope:
            return {"schemaVersion": "gaia2-retrieval-projection-v1", "scopeId": None,
                    "criteriaVersion": 0, "revision": 0, "certificates": []}
        certificates = []
        for page in self._state["pages"]:
            if (not page["reviewCommitted"] or not page["complete"] or not page["beforeViewComplete"]
                    or page["oldBlocker"] or page["criteriaVersion"] != scope["criteriaVersion"]):
                continue
            retained = [_clone(r) for r in page["records"] if r["decision"] != "reject"]
            rejects = [r["recordRef"] for r in page["records"] if r["decision"] == "reject"]
            cert = {key: _clone(page[key]) for key in ("pageRef", "actionId", "resourceKey", "canonicalName",
                "queryHash", "resultHash", "observedAt", "complete", "beforeViewComplete", "sourceRef",
                "scopeId", "criteriaVersion", "reviewCommitted", "oldBlocker")}
            cert.update(retainedRecords=retained, rejectRefs=rejects, protected=False,
                        projectionHash=canonical_hash({"retainedRecords": retained, "rejectRefs": rejects}))
            certificates.append(cert)
        return {"schemaVersion": "gaia2-retrieval-projection-v1", "scopeId": scope["scopeId"],
                "criteriaVersion": scope["criteriaVersion"], "revision": scope["revision"],
                "certificates": certificates}

    def _page_view(self, page: dict) -> dict:
        view = _clone(page)
        if page["reviewCommitted"] and not page["oldBlocker"] and page["complete"] and page["beforeViewComplete"]:
            for record in view["records"]:
                if record["decision"] == "reject":
                    record.pop("body", None)
            view["viewComplete"] = not any(r["decision"] == "reject" for r in page["records"])
        else:
            view["viewComplete"] = page["beforeViewComplete"]
        return view

    def snapshot(self) -> dict:
        return {"schemaVersion": "gaia2-retrieval-workset-v1", "executionId": self.execution_id,
            "sessionId": self.session_id, "scope": _clone(self._state["scope"]),
            "pages": [self._page_view(p) for p in self._state["pages"]],
            "candidates": [_clone(r) for p in self._state["pages"] for r in p["records"]
                           if r["decision"] in ("keep", "defer")],
            "coverage": self.coverage(), "projection": self.projection(),
            "control": _clone(self._state["control"]), "needsReconcile": self._state["needsReconcile"]}

    def step(self, args: dict, *, call_id: str | None = None, user_ref: str | None = None) -> dict:
        if not isinstance(args, dict) or set(args) - set(tool_schema()["function"]["parameters"]["properties"]):
            raise RetrievalError("schema", "Unknown retrieval control argument")
        op, request_id = args.get("op"), args.get("requestId")
        if op not in OPS or not isinstance(request_id, str) or not request_id:
            raise RetrievalError("schema", "A supported op and nonempty requestId are required")
        fingerprint = canonical_hash(args)
        previous = self._state["requests"].get(request_id)
        if previous:
            if previous["fingerprint"] != fingerprint:
                raise RetrievalError("request_id", "A requestId cannot be reused with different arguments")
            if previous["status"] == "complete":
                if call_id:
                    self._state["calls"][call_id] = request_id
                    self._save()
                return _clone(previous["result"])
            raise RetrievalError("interrupted_request", "An interrupted/failed request is never automatically replayed")
        if op == "begin":
            if self._state["scope"]:
                raise RetrievalError("scope", "This session already has a retrieval scope")
            criterion = self._criteria(args.get("criteria"), user_ref)
            if any(key in args for key in ("reviews", "pageRefs")):
                raise RetrievalError("schema", "begin cannot review or reopen pages")
            spec = self._next_spec(args.get("nextRead", {"tool": NATIVE_TOOL,
                "arguments": {"offset": 0}, "pages": 1}))
            if spec["pages"] != 1:
                raise RetrievalError("next_read", "The first retrieval read is exactly one native page")
            self._state["scope"] = {"scopeId": "scope-" + uuid.uuid4().hex,
                "executionId": self.execution_id, "sessionId": self.session_id,
                "criteriaVersion": 1, "revision": 1, "criteria": criterion, "status": "active"}
        else:
            self._bound(args)
            spec = self._next_spec(args.get("nextRead")) if op in ("review_next", "continue_read") else None
            if op not in ("review_next", "continue_read") and "nextRead" in args:
                raise RetrievalError("schema", "This operation does not read the next page")
        # Validate reviews on a copy before writing the durable execution marker.
        before = copy.deepcopy(self._state)
        try:
            if op in ("review_next", "review_finish", "continue_read"):
                self._review(args.get("reviews"))
            elif op == "reopen":
                refs = args.get("pageRefs")
                if not isinstance(refs, list) or not refs or len(set(refs)) != len(refs):
                    raise RetrievalError("page_ref", "reopen requires unique pageRefs")
                selected = [p for p in self._state["pages"] if p["pageRef"] in refs]
                if len(selected) != len(refs):
                    raise RetrievalError("page_ref", "Unknown or cross-session page reference")
                for page in selected:
                    self._raw_page(page)
                    page["reviewCommitted"] = False
                    for record in page["records"]:
                        record.update(decision="defer", quotes=[], classified=False)
                self._state["scope"]["revision"] += 1
                self._state["scope"]["status"] = "active"
            elif op == "revise":
                criterion = self._criteria(args.get("criteria"), user_ref)
                scope = self._state["scope"]
                scope["criteria"] = criterion
                scope["criteriaVersion"] += 1
                scope["revision"] += 1
                scope["status"] = "active"
                for page in self._state["pages"]:
                    self._raw_page(page)
                    page["criteriaVersion"] = scope["criteriaVersion"]
                    page["reviewCommitted"] = False
                    for record in page["records"]:
                        record.update(decision="defer", quotes=[], classified=False)
            if op == "review_finish":
                coverage = self.coverage()
                stop = self._state["scope"]["criteria"]["stopRule"]
                complete = (coverage["allRead"] and coverage["allReviewed"] and not coverage["deferred"])
                found = any(r["decision"] == "keep" for p in self._state["pages"] for r in p["records"])
                self._state["scope"]["status"] = "reviewed" if (complete or (stop == "find_one" and found)) else "incomplete"
        except Exception:
            self._state = before
            raise
        self._state["requests"][request_id] = {"fingerprint": fingerprint, "status": "in_progress"}
        if call_id:
            self._state["calls"][call_id] = request_id
        self._save()
        new_refs, read_status, error = [], "not_requested", None
        try:
            # Every committed decision is acknowledged before any following native call.
            self._ack("review_commit" if op != "begin" else "state_update", args)
            if spec is not None:
                new_refs, read_status, error = self._read(spec, args, call_id)
            snapshot = self.snapshot()
            result = {"schemaVersion": "gaia2-retrieval-step-v1", "requestId": request_id,
                "op": op, "scope": snapshot["scope"], "reviewCommitted": bool(args.get("reviews")) and op in ("review_next", "review_finish", "continue_read"),
                "nextReadStatus": read_status, "pages": [self._page_view(p) for p in self._state["pages"]
                    if p["pageRef"] in new_refs], "pageRefs": new_refs, "coverage": snapshot["coverage"],
                "projection": snapshot["projection"], "retrieval": snapshot}
            if error:
                result["nextReadError"] = error
            self._state["requests"][request_id].update(status="complete", result=_clone(result))
            self._save()
            return result
        except Exception:
            self._state["requests"][request_id]["status"] = "failed"
            self._save()
            raise

    def project_messages(self, messages: list[dict]) -> tuple[list[dict], dict]:
        """Keep one current Actor workset, with body-free historical receipts.

        Only registered step-result bodies change; user/assistant messages and
        call/result pairing do not.  The returned full plan and the Host snapshot
        are deliberately separate from the bounded provider presentation.
        The caller must validate the real Host receipt before using this view.
        """
        if self._state["needsReconcile"]:
            raise RetrievalError("needs_reconcile", "Unacknowledged review cannot produce a model view")
        projected = copy.deepcopy(messages)
        pages = {p["pageRef"]: p for p in self._state["pages"]}
        issued = []
        for index, message in enumerate(projected):
            call_id = message.get("tool_call_id", message.get("toolCallId"))
            if message.get("role") != "tool" or call_id not in self._state["calls"]:
                continue
            content = message.get("content")
            if not isinstance(content, str):
                raise RetrievalError("projection_binding", "Registered provider result is not JSON text")
            try:
                original = json.loads(content)
            except (ValueError, TypeError) as exc:
                raise RetrievalError("projection_binding", "Registered provider result is not valid JSON") from exc
            if (not isinstance(original, dict) or original.get("schemaVersion") != "gaia2-retrieval-step-v1"
                    or original.get("requestId") != self._state["calls"][call_id]):
                raise RetrievalError("projection_binding", "Provider step result does not match its issued call")
            for page in original.get("pages", []):
                known = pages.get(page.get("pageRef"))
                if not known or page.get("resultHash") != known["resultHash"]:
                    raise RetrievalError("projection_binding", "Step page binding changed")
            issued.append((index, original))
        plan = self.projection()
        if not issued:
            return projected, plan

        # Node JSON.stringify writes an integral float as an integer.  This
        # summary hash is informational; authority still comes from the full
        # receipt validated by the bridge, not a provider-visible hash.
        def node_number_shape(value):
            if isinstance(value, float) and value.is_integer():
                return int(value)
            if isinstance(value, list):
                return [node_number_shape(item) for item in value]
            if isinstance(value, dict):
                return {key: node_number_shape(item) for key, item in value.items()}
            return value

        snapshot = self.snapshot()
        plan_summary = {"schemaVersion": "gaia2-retrieval-projection-summary-v1",
            "scopeId": plan["scopeId"], "criteriaVersion": plan["criteriaVersion"],
            "revision": plan["revision"], "planHash": canonical_hash(node_number_shape(plan)),
            "certificateCount": len(plan["certificates"]),
            "pageRefs": [cert["pageRef"] for cert in plan["certificates"]]}
        pending_all = [self._page_view(p) for p in self._state["pages"] if not p["reviewCommitted"]]
        pending = pending_all[-self.MAX_VISIBLE_PENDING_PAGES:]
        pending_omitted = pending_all[:-self.MAX_VISIBLE_PENDING_PAGES]
        pending_refs = {record["recordRef"] for page in pending_all for record in page["records"]}
        candidates = [_clone(record) for record in snapshot["candidates"] if record["recordRef"] not in pending_refs]
        for candidate in candidates:
            # Full body is retained exactly once.  Quotation spans reference it
            # without duplicating that same text (which may be the full body).
            body = candidate["body"]
            candidate["quoteRefs"] = [{"path": quote["path"],
                "start": quote.get("start", body.find(quote["quote"])),
                "length": len(quote["quote"]), "quoteHash": canonical_hash(quote["quote"])}
                for quote in candidate.pop("quotes", [])]
        latest_index = issued[-1][0]
        for index, original in issued:
            if index != latest_index:
                view = {"schemaVersion": "gaia2-retrieval-step-v1", "requestId": original["requestId"],
                    "op": original["op"], "scopeId": snapshot["scope"]["scopeId"], "archived": True,
                    "pageRefs": list(original.get("pageRefs", [])),
                    "summary": {"pageCount": len(original.get("pageRefs", [])),
                        "reviewCommitted": original.get("reviewCommitted", False),
                        "nextReadStatus": original.get("nextReadStatus", "not_requested")}}
                if "nextReadError" in original:
                    view["summary"]["nextReadError"] = original["nextReadError"]
            else:
                workset = {"schemaVersion": "gaia2-retrieval-actor-workset-v1",
                    "scope": snapshot["scope"], "candidates": candidates,
                    "reviewPages": [{"pageRef": page["pageRef"], "resultHash": page["resultHash"],
                                     "range": page["range"], "reviewCommitted": page["reviewCommitted"]}
                                    for page in self._state["pages"]],
                    "pendingPageSummary": [{"pageRef": page["pageRef"], "range": page["range"],
                                             "resultHash": page["resultHash"], "recordCount": len(page["records"]),
                                             "complete": page["complete"], "beforeViewComplete": page["beforeViewComplete"]}
                                            for page in pending_omitted],
                    "coverage": snapshot["coverage"], "control": snapshot["control"],
                    "needsReconcile": snapshot["needsReconcile"]}
                view = {"schemaVersion": "gaia2-retrieval-step-v1", "requestId": original["requestId"],
                    "op": original["op"], "scope": snapshot["scope"], "archived": False,
                    "reviewCommitted": original.get("reviewCommitted", False),
                    "nextReadStatus": original.get("nextReadStatus", "not_requested"),
                    "pages": pending, "pageRefs": [page["pageRef"] for page in pending],
                    "coverage": snapshot["coverage"], "projection": plan_summary, "retrieval": workset}
                if "nextReadError" in original:
                    view["nextReadError"] = original["nextReadError"]
            projected[index]["content"] = json.dumps(view, ensure_ascii=False, separators=(",", ":"))
        return projected, plan
