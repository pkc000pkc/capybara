"""Pure exact USER-quote anchoring. No model, native tool, clock or I/O.

Only coordinates are derived. Source text is never stripped, normalized, split
at AUI labels or approximately matched. Python str offsets are codepoints.
"""
from __future__ import annotations

import hashlib
import json

NORMALIZER_VERSION = "exact-user-quotes-v2"
RAW_SCHEMA = "gaia2-task-contract-proposal-v2"
EXTRACTION_SCHEMA = "gaia2-task-contract-extraction-v2"
ANCHOR_SCHEMA = "gaia2-task-contract-anchoring-v1"
MAX_EXTRACTION_BYTES = 786432


class QuoteNormalizationError(ValueError):
    def __init__(self, code, path="/"):
        super().__init__("TASK_QUOTE_" + code)
        self.code = code
        self.path = path


def _fail(code, path="/"):
    raise QuoteNormalizationError(code, path)


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def content_hash(value):
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _clone(value):
    return json.loads(canonical_bytes(value))


def semantic_payload(raw):
    """Used to constrain the ONE quote repair; order and semantics cannot move."""
    value = _clone(raw)
    for key in ("obligations", "revocations"):
        for item in value[key]:
            item.pop("quote", None)
            item.pop("quoteContext", None)
            # A null recipe is runtime bookkeeping, not model semantics.
            if key == "obligations" and item.get("recipe") is None:
                item.pop("recipe", None)
    return value


def _raw_schema(raw, source):
    if (type(raw) is not dict or set(raw) != {"schemaVersion", "sourceHash", "resolution", "notificationPolicy", "obligations", "revocations"}
            or raw["schemaVersion"] != RAW_SCHEMA or raw["sourceHash"] != source["sourceHash"]
            or raw["resolution"] not in ("obligations", "none", "ambiguous")
            or raw["notificationPolicy"] not in ("allow", "forbid_until_deadline", "forbid")
            or type(raw["obligations"]) is not list or len(raw["obligations"]) > 16
            or type(raw["revocations"]) is not list or len(raw["revocations"]) > 64
            or len(canonical_bytes(raw)) > 65536):
        _fail("raw_proposal_schema")
    for collection in ("obligations", "revocations"):
        required = {"quote", "mode", "goal", "timeBasis"} if collection == "obligations" else {"obligationId", "quote"}
        allowed = required | {"quoteContext"} | ({"recipe"} if collection == "obligations" else set())
        for index, item in enumerate(raw[collection]):
            path = "/" + collection + "/" + str(index)
            if type(item) is not dict:
                _fail("raw_field_type", path)
            if required - set(item):
                _fail("raw_missing_field", path + "/" + sorted(required - set(item))[0])
            if set(item) - allowed:
                _fail("raw_unknown_field", path + "/" + sorted(set(item) - allowed)[0])
            if type(item["quote"]) is not str or not item["quote"]:
                _fail("quote_schema", path + "/quote")
            if collection == "obligations" and item.get("recipe") is not None:
                _fail("untrusted_recipe", path + "/recipe")
            context = item.get("quoteContext")
            if context is not None and (type(context) is not dict or set(context) != {"before", "after"}
                    or any(type(context[k]) is not str or len(context[k]) > 4096 for k in ("before", "after"))):
                _fail("quote_context_schema", path + "/quoteContext")


def normalize_task_contract(source, raw):
    text = source.get("text") if type(source) is dict else None
    if (type(text) is not str or not text or len(text.encode("utf-8")) > 262144
            or source.get("sourceHash") != hashlib.sha256(text.encode("utf-8")).hexdigest()):
        _fail("source_hash")
    _raw_schema(raw, source)
    normalized = _clone(raw)
    normalized["schemaVersion"] = "gaia2-task-contract-proposal-v1"
    for item in normalized["obligations"]:
        item["recipe"] = None
    matches, errors = [], []
    for collection in ("obligations", "revocations"):
        for index, original in enumerate(raw[collection]):
            quote, context = original["quote"], original.get("quoteContext", {"before": "", "after": ""})
            found, start = [], 0
            # Include overlapping exact occurrences. Never select the first.
            while True:
                position = text.find(quote, start)
                if position < 0:
                    break
                end = position + len(quote)
                before, after = context["before"], context["after"]
                if (position >= len(before) and text[position-len(before):position] == before
                        and text[end:end+len(after)] == after):
                    found.append(position)
                start = position + 1
            path = "/" + collection + "/" + str(index)
            if len(found) != 1:
                errors.append({"itemPath": path, "code": "quote_not_found" if not found else "quote_not_unique", "matchCount": len(found)})
                continue
            position = found[0]
            span = {"start": position, "end": position + len(quote), "text": quote}
            item = normalized[collection][index]
            del item["quote"]
            item.pop("quoteContext", None)
            item["span"] = span
            matches.append({"itemPath": path, "matchCount": 1, "span": span})
    if errors:
        normalized = None
    receipt = {"schemaVersion": ANCHOR_SCHEMA, "normalizerVersion": NORMALIZER_VERSION,
               "sourceHash": source["sourceHash"], "rawProposalHash": content_hash(raw),
               "normalizedProposalHash": None if normalized is None else content_hash(normalized),
               "status": "unresolved" if errors else "normalized", "matches": matches, "errors": errors}
    return {"status": receipt["status"], "normalizedProposal": normalized, "anchoringReceipt": receipt,
            "anchoringHash": content_hash(receipt)}


def _parse_exact(raw):
    def pairs(items):
        value = {}
        for key, child in items:
            if key in value:
                _fail("raw_arguments_duplicate_key")
            value[key] = child
        return value
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: _fail("raw_arguments_nonfinite"))


def verify_extraction(source, envelope):
    """Recompute the complete derivation, including quote-only repair provenance."""
    fields = {"schemaVersion", "sourceHash", "status", "rawProposal", "rawProposalHash", "normalizedProposal",
              "normalizedProposalHash", "anchoringReceipt", "anchoringHash", "attempts", "reason"}
    if (type(envelope) is not dict or set(envelope) != fields or envelope["schemaVersion"] != EXTRACTION_SCHEMA
            or envelope["sourceHash"] != source["sourceHash"] or envelope["status"] not in ("normalized", "unresolved")
            or type(envelope["attempts"]) is not list or not 1 <= len(envelope["attempts"]) <= 2
            or len(canonical_bytes(envelope)) > MAX_EXTRACTION_BYTES):
        _fail("extraction_schema")
    if envelope["status"] != "normalized":
        return envelope
    previous = None
    for index, attempt in enumerate(envelope["attempts"]):
        if (type(attempt) is not dict or set(attempt) != {"ordinal", "toolName", "rawArguments", "rawArgumentsSha256", "rawArgumentsTruncated", "parsed", "errorCode"}
                or attempt["ordinal"] != index or attempt["errorCode"] is not None
                or attempt["rawArgumentsTruncated"] is not False or type(attempt["rawArguments"]) is not str
                or hashlib.sha256(attempt["rawArguments"].encode("utf-8")).hexdigest() != attempt["rawArgumentsSha256"]
                or _parse_exact(attempt["rawArguments"]) != attempt["parsed"]):
            _fail("extraction_attempt_binding")
        if index == 0:
            if attempt["toolName"] != "capybara_propose_task_contract":
                _fail("extraction_attempt_tool")
            previous = attempt["parsed"]
            try:
                _raw_schema(previous, source)
            except QuoteNormalizationError as error:
                # Only an exact-quotation format repair may follow an invalid
                # first attempt. Semantic fields are never filled by code.
                if len(envelope["attempts"]) != 2 or not quote_repairable(error):
                    raise
        else:
            repair = attempt["parsed"]
            if (attempt["toolName"] != "capybara_repair_task_contract_quotes" or type(repair) is not dict
                    or set(repair) != {"baseRawProposalHash", "proposal"}
                    or repair["baseRawProposalHash"] != content_hash(previous)
                    or semantic_payload(repair["proposal"]) != semantic_payload(previous)):
                _fail("repair_semantic_change")
            previous = repair["proposal"]
            _raw_schema(previous, source)
    if envelope["rawProposal"] != previous or envelope["rawProposalHash"] != content_hash(previous):
        _fail("extraction_raw_binding")
    derived = normalize_task_contract(source, previous)
    for key in ("status", "normalizedProposal", "anchoringReceipt", "anchoringHash"):
        if envelope[key] != derived[key]:
            _fail("normalization_integrity")
    if envelope["normalizedProposalHash"] != content_hash(derived["normalizedProposal"]):
        _fail("normalization_integrity")
    return envelope


def quote_repairable(error):
    return (isinstance(error, QuoteNormalizationError)
            and (error.code in {"quote_schema", "quote_context_schema"}
                 or error.code == "raw_missing_field" and error.path.endswith("/quote")))
