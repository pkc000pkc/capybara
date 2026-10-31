"""Bounded exact-query reads or hash-bound view restoration for Host plans.

The original mutation is NEVER executed here.  ``confirmed`` only compares the
new native result with the Host's latest observation, not permission or task
success. V2 covers at most eight groups atomically; restoration retains the
original native timestamp. The bridge must recheck the real gate before the
actor can retry. Legacy v1 evidence remains readable without migration.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import uuid
from pathlib import Path
from typing import Any, Callable


MAX_RESULT_BYTES = 8192
MAX_DELIVERY_CHUNK_BYTES = 4096
MAX_DELIVERY_TEXT_BYTES = 3072
MAX_QUERY_BYTES = 4096
MAX_GROUPS = 64
MAX_CALLS = 256
STATE_SCHEMA = "gaia2-conflict-state-v1"
RESULT_SCHEMA = "gaia2-conflict-recovery-result-v1"


class ConflictRecoveryError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class ConflictNativeError(RuntimeError):
    def __init__(self, message: str, code: str = "native_error", executed: bool = True):
        super().__init__(message)
        self.code, self.executed = code, executed


class ConflictInterrupt(RuntimeError):
    """The bridge's post-ACK arrival fence prevented native execution."""
    def __init__(self, kind: str):
        if kind not in {"user_update", "environment_stop"}:
            raise ConflictRecoveryError("interrupt_kind", "Invalid arrived-message interruption")
        super().__init__(kind)
        self.kind = kind


def _bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def _clone(value: Any) -> Any:
    return json.loads(_bytes(value))


def _wire_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8"))


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(_bytes(value)).hexdigest()


def native_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def _sha(value: Any) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) is not None


def _text(value: Any) -> bool:
    return isinstance(value, str) and 0 < len(value) <= 512


def _canonical(value: Any) -> bool:
    return _text(value) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*__[A-Za-z][A-Za-z0-9_]*", value) is not None


class ConflictRecoveryController:
    def __init__(self, evidence_root: str | Path, execution_id: str, session_id: str,
                 native_reader: Callable[[dict], dict], guard: Callable[[], dict],
                 view_restorer: Callable[[dict], dict] | None = None):
        if not _text(execution_id) or not _text(session_id):
            raise ConflictRecoveryError("identity", "Execution and session identities are required")
        self.execution_id, self.session_id = execution_id, session_id
        self.native_reader, self.guard = native_reader, guard
        self.view_restorer = view_restorer
        self._delivery_cache = {}
        self.root = Path(evidence_root).absolute()
        self._no_symlink(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.root = self.root.resolve()
        self.directory = self.root / canonical_hash([execution_id, session_id])[:24]
        self._no_symlink(self.directory)
        self.directory.mkdir(exist_ok=True)
        self.state_path = self.directory / "state.json"
        self._ledger = {"schemaVersion": "gaia2-conflict-recovery-ledger-v1",
            "executionId": execution_id, "sessionId": session_id, "calls": {}, "groups": {}, "deliveries": {}}
        if self.state_path.exists():
            self._ledger = self._read_path(self.state_path)
            if (self._ledger.get("schemaVersion") != "gaia2-conflict-recovery-ledger-v1"
                    or self._ledger.get("executionId") != execution_id
                    or self._ledger.get("sessionId") != session_id
                    or not isinstance(self._ledger.get("calls"), dict)
                    or not isinstance(self._ledger.get("groups"), dict)
                    or len(self._ledger["calls"]) > MAX_CALLS or len(self._ledger["groups"]) > MAX_GROUPS):
                raise ConflictRecoveryError("identity", "Stored recovery ledger identity or bounds are invalid")
            # Old ledgers remain readable; delivery records are technical
            # references, never permission or native-completeness claims.
            self._ledger.setdefault("deliveries", {})
            if (not isinstance(self._ledger["deliveries"], dict)
                    or len(self._ledger["deliveries"]) > MAX_GROUPS):
                raise ConflictRecoveryError("identity", "Stored delivery ledger exceeds its session bounds")

    @staticmethod
    def _no_symlink(path: Path) -> None:
        for part in (path, *path.parents):
            if part.is_symlink():
                raise ConflictRecoveryError("source_path", "Symlink evidence paths are forbidden")

    def _read_path(self, path: Path) -> dict:
        self._no_symlink(path)
        if not path.resolve().is_relative_to(self.directory.resolve()):
            raise ConflictRecoveryError("source_path", "Cross-session evidence paths are forbidden")
        try:
            value = json.loads(path.read_text(encoding="utf-8"),
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (UnicodeError, ValueError) as error:
            raise ConflictRecoveryError("source_protocol", "Evidence is not finite JSON") from error
        if not isinstance(value, dict):
            raise ConflictRecoveryError("source_protocol", "Evidence must be an object")
        return value

    def _atomic(self, path: Path, value: dict) -> None:
        self._no_symlink(path)
        temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
        with temporary.open("xb") as stream:
            stream.write(_bytes(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)

    def _save(self) -> None:
        self._atomic(self.state_path, self._ledger)

    def _artifact(self, call_id: str, kind: str, value: dict) -> dict:
        path = self.directory / (canonical_hash(call_id)[:24] + "-" + kind + "-" + uuid.uuid4().hex + ".json")
        self._atomic(path, {"schemaVersion": "gaia2-conflict-recovery-evidence-v1",
            "executionId": self.execution_id, "sessionId": self.session_id,
            "callId": call_id, "kind": kind, **_clone(value)})
        return {"path": path.relative_to(self.root).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def _load_ref(self, ref: dict) -> dict:
        if not isinstance(ref, dict) or not isinstance(ref.get("path"), str) or not _sha(ref.get("sha256")):
            raise ConflictRecoveryError("source_path", "Malformed issued evidence reference")
        relative = Path(ref["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise ConflictRecoveryError("source_path", "Only issued relative evidence references are accepted")
        path = self.root / relative
        value = self._read_path(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != ref["sha256"]:
            raise ConflictRecoveryError("source_hash", "Recovery evidence bytes were modified")
        if value.get("executionId") != self.execution_id or value.get("sessionId") != self.session_id:
            raise ConflictRecoveryError("source_binding", "Recovery evidence identity mismatch")
        return value

    def snapshot(self) -> dict:
        """A bounded technical ledger; it is not a replacement Host conflict state."""
        return _clone(self._ledger)

    def _delivery_source(self, delivery_id: str) -> tuple[dict, list]:
        if not isinstance(delivery_id, str) or re.fullmatch(r"[a-f0-9]{32}", delivery_id) is None:
            raise ConflictRecoveryError("delivery_id", "Only an issued opaque delivery identity is accepted")
        entry = self._ledger["deliveries"].get(delivery_id)
        if not isinstance(entry, dict) or not _text(entry.get("userRef")):
            raise ConflictRecoveryError("delivery_id", "Delivery does not belong to this execution and session")
        signal = self._guard_signal(entry.get("userRef"))
        if signal:
            raise ConflictRecoveryError(signal, "Arrived-message fence revoked this evidence delivery")
        call = self._ledger["calls"].get(entry.get("callId"))
        if not isinstance(call, dict) or call.get("status") != "completed":
            raise ConflictRecoveryError("delivery_binding", "Delivery has no completed issued recovery call")
        cached = self._delivery_cache.get(delivery_id)
        if cached and cached["entry"] == entry and cached["resultRef"] == call.get("resultRef"):
            # Revalidate file bytes on every access, but do not repeatedly
            # parse, normalize and hash the same multi-megabyte JSON value.
            # Every path was previously confined and validated by _load_ref.
            self._no_symlink(self.directory)
            for path, expected in cached["sources"]:
                if path.parent != self.directory:
                    self._no_symlink(path.parent)
                if path.is_symlink():
                    raise ConflictRecoveryError("source_path", "Symlink evidence paths are forbidden")
                if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
                    raise ConflictRecoveryError("source_hash", "Recovery evidence bytes were modified")
            signal = self._guard_signal(entry["userRef"])
            if signal:
                raise ConflictRecoveryError(signal, "Arrived-message fence revoked this evidence delivery")
            return entry, cached["receipts"]
        saved = self._load_ref(call.get("resultRef"))
        result = saved.get("result", {})
        if (saved.get("kind") != "result" or saved.get("callId") != entry["callId"]
                or result.get("status") != "delivery_pending" or result.get("deliveryId") != delivery_id
                or result.get("evidenceRef") != entry.get("evidenceRef")
                or result.get("userRef") != entry.get("userRef")):
            raise ConflictRecoveryError("delivery_binding", "Delivery does not match its immutable issued result")
        group = self._load_ref(entry.get("evidenceRef"))
        receipts = group.get("receipts")
        if (group.get("kind") != "recovery-group" or group.get("callId") != entry["callId"]
                or not isinstance(receipts, list) or not 1 <= len(receipts) <= 8
                or len(receipts) != entry.get("receiptCount") or len(receipts) != result.get("receiptCount")):
            raise ConflictRecoveryError("delivery_binding", "Delivery group identity or receipt coverage changed")
        references = [call["resultRef"], entry["evidenceRef"]]
        for row in receipts:
            if not isinstance(row, dict) or row.get("mode") not in ("restore_view", "native_read"):
                raise ConflictRecoveryError("delivery_binding", "Delivery contains an invalid receipt")
            native = self._load_ref(row.get("evidenceRef"))
            references.append(row["evidenceRef"])
            expected_kind = "restored-view" if row["mode"] == "restore_view" else "native-read"
            query = native.get("request")
            if (native.get("kind") != expected_kind or native.get("callId") != entry["callId"]
                    or not isinstance(query, dict) or query.get("mode") != row["mode"]):
                raise ConflictRecoveryError("delivery_binding", "Delivery receipt is not its issued native evidence")
            receipt = self._receipt(native.get("receipt"), query)
            expected = {"mode": row["mode"], **receipt, "evidenceRef": row["evidenceRef"]}
            if canonical_hash(expected) != canonical_hash(row):
                raise ConflictRecoveryError("delivery_binding", "Delivery receipt differs from its native evidence")
        signal = self._guard_signal(entry["userRef"])
        if signal:
            raise ConflictRecoveryError(signal, "Arrived-message fence revoked this evidence delivery")
        self._delivery_cache[delivery_id] = {
            "entry": _clone(entry), "resultRef": _clone(call["resultRef"]), "receipts": receipts,
            "sources": [(self.root / ref["path"], ref["sha256"]) for ref in references],
            "bytes": [_bytes(row["result"]) for row in receipts]}
        self._delivery_cache[delivery_id]["hashes"] = [hashlib.sha256(raw).hexdigest()
                                                        for raw in self._delivery_cache[delivery_id]["bytes"]]
        return entry, receipts

    @staticmethod
    def _delivery_manifest(receipts: list) -> dict:
        return {"schemaVersion": "gaia2-evidence-delivery-manifest-v1", "encoding": "utf-8-json",
                "maxChunkBytes": MAX_DELIVERY_CHUNK_BYTES,
                "receipts": [{"receiptIndex": index, "actionId": row["actionId"],
                              "totalBytes": len(_bytes(row["result"])),
                              "resultBytesHash": hashlib.sha256(_bytes(row["result"])).hexdigest()}
                             for index, row in enumerate(receipts)]}

    def get_delivery(self, delivery_id: str) -> dict:
        """Trusted local manifest lookup; a reference grants no view authority."""
        entry, receipts = self._delivery_source(delivery_id)
        result = {"deliveryId": delivery_id, "receiptCount": len(receipts),
                  **self._delivery_manifest(receipts)}
        signal = self._guard_signal(entry["userRef"])
        if signal:
            raise ConflictRecoveryError(signal, "Arrived-message fence revoked this evidence delivery")
        return _clone(result)

    def read_delivery(self, delivery_id: str, receipt_index: int, offset: int) -> dict:
        """Read bounded immutable JSON fragments without any native dispatch.

        Offsets count canonical UTF-8 bytes and must lie on code-point
        boundaries. Reading a final fragment does not grant presentation
        completeness: the Bridge must verify actual provider-visible coverage.
        """
        entry, receipts = self._delivery_source(delivery_id)
        if type(receipt_index) is not int or not 0 <= receipt_index < len(receipts):
            raise ConflictRecoveryError("delivery_index", "Receipt index is outside this issued delivery")
        row = receipts[receipt_index]
        raw = self._delivery_cache[delivery_id]["bytes"][receipt_index]
        if type(offset) is not int or not 0 <= offset < len(raw):
            raise ConflictRecoveryError("delivery_offset", "Offset is outside this original JSON result")
        try:
            raw[:offset].decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise ConflictRecoveryError("delivery_offset", "Offset must start on a UTF-8 code-point boundary") from None
        end = min(len(raw), offset + MAX_DELIVERY_TEXT_BYTES)
        while end > offset:
            try:
                text = raw[offset:end].decode("utf-8", errors="strict")
                break
            except UnicodeDecodeError:
                end -= 1
        else:
            raise ConflictRecoveryError("delivery_offset", "No complete UTF-8 code point fits this chunk")

        base = {"schemaVersion": "gaia2-evidence-delivery-chunk-v1", "status": "chunk",
                "deliveryId": delivery_id, "receiptIndex": receipt_index, "receiptCount": len(receipts),
                "offset": offset, "totalBytes": len(raw),
                "resultBytesHash": self._delivery_cache[delivery_id]["hashes"][receipt_index],
                **{key: row[key] for key in ("mode", "actionId", "canonicalName", "resourceKey", "queryHash",
                                             "resultHash", "observedAt", "complete", "sourceRef")},
                "viewComplete": False, "sourceViewComplete": row["viewComplete"],
                "originalWriteExecuted": False, "permissionGranted": False, "businessSuccess": False}

        def envelope(fragment):
            data = fragment.encode("utf-8")
            next_offset = offset + len(data)
            return {**base, "text": fragment, "nextOffset": next_offset if next_offset < len(raw) else None,
                    "chunkHash": hashlib.sha256(data).hexdigest()}

        # Account for escaping and metadata in the final JSON, not only raw
        # text bytes. Binary search fills the wire budget without splitting
        # Unicode characters, including quotes, backslashes and control chars.
        lo, hi, best = 1, len(text), None
        while lo <= hi:
            mid = (lo + hi) // 2
            candidate = envelope(text[:mid])
            wire_size = _wire_size(candidate)
            if wire_size <= MAX_DELIVERY_CHUNK_BYTES:
                best, lo = candidate, mid + 1
            else:
                hi = mid - 1
        if best is None:
            raise ConflictRecoveryError("delivery_metadata_size", "Delivery metadata leaves no safe chunk return budget")
        signal = self._guard_signal(entry["userRef"])
        if signal:
            raise ConflictRecoveryError(signal, "Arrived-message fence revoked this evidence delivery")
        return _clone(best)

    @staticmethod
    def _validate(plan: Any, action: Any, user_ref: Any) -> tuple[dict, dict]:
        if isinstance(plan, dict) and plan.get("schemaVersion") == "gaia2-conflict-state-v2":
            return ConflictRecoveryController._validate_v2(plan, action, user_ref)
        if not _text(user_ref) or not isinstance(plan, dict) or not isinstance(action, dict):
            raise ConflictRecoveryError("plan", "A trusted plan, action and current user reference are required")
        if plan.get("schemaVersion") != STATE_SCHEMA or plan.get("status") != "blocked" or plan.get("userRef") != user_ref:
            raise ConflictRecoveryError("plan_binding", "Recovery requires this user's currently blocked Host plan")
        blocked = plan.get("blockedAction")
        identity = ("id", "canonicalName", "mutationKey", "resourceKey")
        if not isinstance(blocked, dict) or any(not _text(blocked.get(k)) or blocked[k] != action.get(k) for k in identity):
            raise ConflictRecoveryError("action_binding", "Host plan belongs to a different blocked action")
        if not _canonical(blocked["canonicalName"]) or not _sha(blocked["mutationKey"]):
            raise ConflictRecoveryError("action_binding", "Malformed blocked mutation identity")
        blockers, requests = plan.get("blockerIds"), plan.get("requests")
        if (not isinstance(blockers, list) or not 0 <= len(blockers) <= 64
                or any(not _text(item) for item in blockers) or len(set(blockers)) != len(blockers)
                or not isinstance(requests, list) or len(requests) > 1):
            raise ConflictRecoveryError("plan", "Only a bounded single-query Host recovery plan is accepted")
        try:
            normalized, bound_action = _clone(plan), {k: action[k] for k in identity}
        except (ValueError, TypeError) as error:
            raise ConflictRecoveryError("plan", "Recovery plans must be finite JSON") from error
        if not requests:
            return normalized, bound_action
        query = requests[0]
        if not isinstance(query, dict) or not _canonical(query.get("queryTool")) or not isinstance(query.get("queryArguments"), dict):
            raise ConflictRecoveryError("query", "A canonical native query and exact arguments are required")
        app, method = query["queryTool"].split("__", 1)
        if (app in {"SystemApp", "AgentUserInterface", "AppAgent", "CapybaraTemporal", "CapybaraRetrieval", "CapybaraConflict"}
                or re.match(r"^(get|list|read|search|lookup|find|fetch|query|count|has|is)(_|$)", method) is None):
            raise ConflictRecoveryError("query_read_only", "Automatic confirmation accepts native read queries only")
        if len(_bytes(query["queryArguments"])) > MAX_QUERY_BYTES:
            raise ConflictRecoveryError("query_size", "Exact query arguments exceed 4096 UTF-8 bytes")
        observation_ids = query.get("observationIds")
        if (not _sha(query.get("queryHash")) or not _sha(query.get("expectedLatestResultHash"))
                or query.get("resourceKey") != blocked["resourceKey"]
                or not isinstance(observation_ids, list) or not 1 <= len(observation_ids) <= 64
                or any(not _text(item) for item in observation_ids)
                or len(set(observation_ids)) != len(observation_ids) or set(observation_ids) != set(blockers)):
            raise ConflictRecoveryError("query_binding", "Recovery query does not cover precisely this plan's blockers")
        return normalized, bound_action

    @staticmethod
    def _validate_v2(plan, action, user_ref):
        resources, requests = plan.get("requiredResources"), plan.get("requests")
        if (set(plan) != {"schemaVersion", "status", "userRef", "blockedAction", "blockerIds", "requests", "reason", "requiredResources"}
                or not isinstance(resources, list) or not 1 <= len(resources) <= 33
                or any(not _text(value) for value in resources) or len(set(resources)) != len(resources)
                or not isinstance(action, dict) or action.get("resourceKey") not in resources
                or not isinstance(requests, list) or not 1 <= len(requests) <= 8
                or plan.get("reason") != "eligible_bounded_evidence_recovery"):
            raise ConflictRecoveryError("plan", "Invalid bounded evidence recovery plan")
        covered = []
        bound_action = None
        for query in requests:
            if (not isinstance(query, dict) or query.get("mode") not in ("restore_view", "native_read")
                    or set(query) != {"mode", "queryTool", "queryArguments", "queryHash", "resourceKey", "observationIds", "expectedLatestResultHash", "sourceActionId", "sourceObservedAt"}
                    or not _text(query.get("sourceActionId"))
                    or type(query.get("sourceObservedAt")) not in (int, float)
                    or not math.isfinite(query["sourceObservedAt"]) or query["sourceObservedAt"] < 0
                    or query.get("resourceKey") not in resources):
                raise ConflictRecoveryError("query_binding", "Invalid evidence source binding")
            original_action = plan.get("blockedAction")
            if not isinstance(original_action, dict) or any(original_action.get(key) != action.get(key)
                    for key in ("id", "canonicalName", "mutationKey", "resourceKey")):
                raise ConflictRecoveryError("action_binding", "Evidence plan belongs to a different action")
            subquery = {key: value for key, value in query.items()
                        if key not in ("mode", "sourceActionId", "sourceObservedAt")}
            subaction = {**action, "resourceKey": query["resourceKey"]}
            subplan = {**plan, "schemaVersion": STATE_SCHEMA, "blockedAction": {**original_action, "resourceKey": query["resourceKey"]},
                       "requests": [subquery], "blockerIds": query.get("observationIds"),
                       "reason": "eligible_exact_query_confirmation"}
            ConflictRecoveryController._validate(subplan, subaction, user_ref)
            covered.extend(query["observationIds"])
            bound_action = {key: action[key] for key in ("id", "canonicalName", "mutationKey", "resourceKey")}
        if (not isinstance(plan.get("blockerIds"), list) or len(covered) > 64
                or len(covered) != len(set(covered)) or len(covered) != len(plan["blockerIds"])
                or set(covered) != set(plan["blockerIds"]) or len(_bytes(plan)) > 65536):
            raise ConflictRecoveryError("query_binding", "Recovery must cover every blocker exactly once")
        return _clone(plan), bound_action

    def _guard_signal(self, user_ref: str) -> str | None:
        try:
            current = self.guard()
        except TimeoutError as error:
            raise ConflictRecoveryError("guard_protocol", "Arrived-message guard failed") from error
        if (not isinstance(current, dict) or "userRef" not in current or type(current.get("stopped")) is not bool
                or current.get("userRef") is not None and not _text(current.get("userRef"))):
            raise ConflictRecoveryError("guard_protocol", "Guard must expose only arrived user identity and stop state")
        if current["stopped"]:
            return "environment_stop"
        if current.get("userRef") != user_ref:
            return "user_update"
        return None

    @staticmethod
    def _receipt(receipt: Any, query: dict) -> dict:
        if not isinstance(receipt, dict) or "result" not in receipt or not _text(receipt.get("actionId")):
            raise ConflictRecoveryError("source_protocol", "Native recovery read must return its audited receipt")
        if (receipt.get("canonicalName") != query["queryTool"] or receipt.get("queryHash") != query["queryHash"]
                or receipt.get("resourceKey", query["resourceKey"]) != query["resourceKey"]):
            raise ConflictRecoveryError("source_binding", "Native read is not the exact admitted recovery query")
        if not _sha(receipt.get("resultHash")) or native_hash(receipt["result"]) != receipt["resultHash"]:
            raise ConflictRecoveryError("source_hash", "Native result does not match its result hash")
        observed = receipt.get("observedAt")
        if isinstance(observed, bool) or not isinstance(observed, (int, float)) or not math.isfinite(observed) or observed < 0:
            raise ConflictRecoveryError("source_protocol", "Native read must carry a finite scene timestamp")
        source = receipt.get("sourceRef")
        if (not isinstance(source, dict) or not isinstance(source.get("path"), str)
                or re.fullmatch(r"plugin-runtime/\d{6}-(?:before_tool|after_tool)-[a-f0-9-]+\.json" if query.get("mode") == "restore_view"
                                else r"plugin-runtime/\d{6}-after_tool-[a-f0-9-]+\.json", source["path"]) is None
                or not _sha(source.get("sha256"))):
            raise ConflictRecoveryError("source_binding", "Read receipt requires its issued Host source reference")
        if type(receipt.get("complete")) is not bool or type(receipt.get("viewComplete")) is not bool:
            raise ConflictRecoveryError("source_protocol", "Native completeness flags are required")
        if query.get("mode") == "restore_view" and (receipt["actionId"] != query["sourceActionId"]
                or observed != query["sourceObservedAt"] or receipt["resultHash"] != query["expectedLatestResultHash"]):
            raise ConflictRecoveryError("source_binding", "Restoration cannot change identity, time or native bytes")
        try:
            return _clone(receipt)
        except (ValueError, TypeError) as error:
            raise ConflictRecoveryError("source_protocol", "Native evidence must be finite JSON") from error

    def _finish(self, call_id: str, action: dict, user_ref: str, status: str,
                count: int = 0, receipt: dict | None = None, evidence: dict | None = None,
                reason: str | None = None, observations: list | None = None, restored: int = 0) -> dict:
        result = {"schemaVersion": RESULT_SCHEMA, "executionId": self.execution_id,
            "sessionId": self.session_id, "blockedAction": action, "userRef": user_ref,
            "status": status, "originalWriteExecuted": False, "permissionGranted": False,
            "businessSuccess": False, "nativeReadCount": count, "observation": receipt,
            "evidenceRef": evidence, "reason": reason}
        if observations is not None:
            result.update(schemaVersion="gaia2-conflict-recovery-result-v2",
                          observations=observations, restoredViewCount=restored)
        if _wire_size(result) > MAX_RESULT_BYTES:
            if observations and status in ("confirmed", "changed") and evidence is not None:
                delivery_id = uuid.uuid4().hex
                self._ledger["deliveries"][delivery_id] = {
                    "callId": call_id, "userRef": user_ref, "evidenceRef": evidence,
                    "receiptCount": len(observations), "recoveryStatus": status}
                result.update(status="delivery_pending", recoveryStatus=status, observation=None,
                              observations=[], deliveryId=delivery_id, receiptCount=len(observations),
                              delivery=self._delivery_manifest(observations),
                              reason="immutable_evidence_requires_bounded_delivery")
                # Pathological long native action identities can exceed even
                # the control budget. The trusted Bridge can fetch the full
                # bound manifest via get_delivery without sending it to LLM.
                if _wire_size(result) > MAX_RESULT_BYTES:
                    result["delivery"] = {"schemaVersion": "gaia2-evidence-delivery-manifest-v1",
                                          "manifestDeferred": True,
                                          "maxChunkBytes": MAX_DELIVERY_CHUNK_BYTES}
            else:
                # Legacy v1 remains unchanged. Failed or incomplete evidence
                # cannot become a successful deliverable by hiding its body.
                result.update(status="oversized_observation", observation=None,
                              reason="full_native_receipt_exceeds_8192_byte_return_budget")
                if observations is not None:
                    result["observations"] = []
        if _wire_size(result) > MAX_RESULT_BYTES:
            raise ConflictRecoveryError("result_size", "Even recovery metadata exceeds its return budget")
        return self._complete_result(call_id, result)

    def _complete_result(self, call_id: str, result: dict) -> dict:
        reference = self._artifact(call_id, "result", {"result": result})
        call = self._ledger["calls"][call_id]
        call.update(status="completed", resultRef=reference)
        self._save()
        return _clone(result)

    def run(self, plan: dict, action: dict, user_ref: str, call_id: str) -> dict:
        normalized, bound_action = self._validate(plan, action, user_ref)
        if not _text(call_id):
            raise ConflictRecoveryError("call_id", "A bounded nonempty logical call identity is required")
        fingerprint = canonical_hash({"plan": normalized, "action": bound_action, "userRef": user_ref})
        previous = self._ledger["calls"].get(call_id)
        if previous is not None:
            if previous.get("fingerprint") != fingerprint:
                raise ConflictRecoveryError("call_reuse", "A logical call identity cannot identify different recovery input")
            if previous.get("status") != "completed":
                raise ConflictRecoveryError("needs_reconcile", "An interrupted native recovery read cannot silently replay")
            saved = self._load_ref(previous["resultRef"])
            if saved.get("kind") != "result" or saved.get("callId") != call_id:
                raise ConflictRecoveryError("source_binding", "Saved result belongs to a different logical call")
            if saved["result"].get("evidenceRef") is not None:
                self._load_ref(saved["result"]["evidenceRef"])
            if saved["result"].get("status") == "delivery_pending":
                signal = self._guard_signal(user_ref)
                if signal:
                    return self._finish(call_id, bound_action, user_ref, signal)
                self._delivery_source(saved["result"].get("deliveryId"))
            return _clone(saved["result"])
        if len(self._ledger["calls"]) >= MAX_CALLS:
            raise ConflictRecoveryError("ledger_budget", "Recovery call ledger reached its bounded session budget")
        if any(entry.get("status") != "completed" for entry in self._ledger["calls"].values()):
            raise ConflictRecoveryError("needs_reconcile", "Interrupted recovery requires explicit reconciliation")
        self._ledger["calls"][call_id] = {"fingerprint": fingerprint, "status": "running"}
        self._save()
        signal = self._guard_signal(user_ref)
        if signal:
            return self._finish(call_id, bound_action, user_ref, signal)
        if not normalized["requests"]:
            return self._finish(call_id, bound_action, user_ref, "manual_required", reason=normalized.get("reason"))
        group_key = canonical_hash([bound_action["mutationKey"], user_ref,
                                    bound_action["canonicalName"], bound_action["resourceKey"]])
        if normalized["schemaVersion"] == "gaia2-conflict-state-v2":
            group_key = canonical_hash([group_key, normalized["requests"]])
        previous_group = self._ledger["groups"].get(group_key)
        if previous_group is not None and normalized["schemaVersion"] == "gaia2-conflict-state-v2":
            previous_call = self._ledger["calls"].get(previous_group.get("callId"), {})
            if previous_call.get("status") == "completed":
                prior = self._load_ref(previous_call["resultRef"])
                pending = prior.get("result", {})
                if pending.get("status") == "delivery_pending":
                    # The same exact source/query/result plan reuses immutable
                    # data, never repeats native work due to display capacity.
                    self._delivery_source(pending.get("deliveryId"))
                    signal = self._guard_signal(user_ref)
                    if signal:
                        return self._finish(call_id, bound_action, user_ref, signal)
                    return self._complete_result(call_id, {**pending, "blockedAction": bound_action})
        if previous_group is not None or len(self._ledger["groups"]) >= MAX_GROUPS:
            return self._finish(call_id, bound_action, user_ref, "budget_exhausted", reason="one_recovery_per_evidence_plan;64_groups_per_session")
        query = normalized["requests"][0]
        self._ledger["groups"][group_key] = {"mutationKey": bound_action["mutationKey"],
            "userRef": user_ref, "canonicalName": bound_action["canonicalName"],
            "resourceKey": bound_action["resourceKey"], "callId": call_id}
        self._save()  # Reserve before dispatch; crashes must never permit replay.
        if normalized["schemaVersion"] == "gaia2-conflict-state-v2":
            return self._run_v2(normalized, bound_action, user_ref, call_id)
        signal = self._guard_signal(user_ref)
        if signal:
            return self._finish(call_id, bound_action, user_ref, signal)
        try:
            raw = self.native_reader(_clone(query))
        except ConflictInterrupt as interrupted:
            return self._finish(call_id, bound_action, user_ref, interrupted.kind)
        except (TimeoutError, ConflictNativeError) as error:
            executed = isinstance(error, TimeoutError) or error.executed is True
            evidence = self._artifact(call_id, "native-error", {
                "errorType": type(error).__name__, "code": getattr(error, "code", "timeout"),
                "executed": executed})
            signal = self._guard_signal(user_ref)
            return self._finish(call_id, bound_action, user_ref, signal or "native_error",
                count=int(executed), evidence=evidence, reason=getattr(error, "code", "timeout"))
        receipt = self._receipt(raw, query)
        evidence = self._artifact(call_id, "native-read", {"request": query, "receipt": receipt})
        signal = self._guard_signal(user_ref)
        if signal:
            return self._finish(call_id, bound_action, user_ref, signal, count=1, evidence=evidence)
        if not receipt["complete"] or not receipt["viewComplete"] or receipt.get("oldBlocker"):
            return self._finish(call_id, bound_action, user_ref, "incomplete_observation", count=1,
                                receipt=receipt, evidence=evidence)
        status = "confirmed" if receipt["resultHash"] == query["expectedLatestResultHash"] else "changed"
        return self._finish(call_id, bound_action, user_ref, status, count=1, receipt=receipt, evidence=evidence)

    def _run_v2(self, plan, action, user_ref, call_id):
        receipts, count, restored = [], 0, 0
        status = "confirmed"
        for query in plan["requests"]:
            signal = self._guard_signal(user_ref)
            if signal:
                return self._finish(call_id, action, user_ref, signal, count=count, observations=[], restored=restored)
            restore = query["mode"] == "restore_view"
            callback = self.view_restorer if restore else self.native_reader
            if callback is None:
                return self._finish(call_id, action, user_ref, "manual_required", count=count,
                                    observations=[], reason="view_restorer_unavailable")
            try:
                raw = callback(_clone(query))
            except ConflictInterrupt as error:
                return self._finish(call_id, action, user_ref, error.kind, count=count, observations=[])
            except (TimeoutError, ConflictNativeError) as error:
                if not restore and (isinstance(error, TimeoutError) or error.executed):
                    count += 1
                return self._finish(call_id, action, user_ref, "native_error", count=count,
                                    observations=[], reason=getattr(error, "code", "timeout"))
            receipt = self._receipt(raw, query)
            count += int(not restore)
            restored += int(restore)
            evidence = self._artifact(call_id, "restored-view" if restore else "native-read", {"request": query, "receipt": receipt})
            receipts.append({"mode": query["mode"], **receipt, "evidenceRef": evidence})
            signal = self._guard_signal(user_ref)
            if signal:
                return self._finish(call_id, action, user_ref, signal, count=count, observations=[], evidence=evidence, restored=restored)
            if not receipt["complete"] or not receipt["viewComplete"] or receipt.get("oldBlocker"):
                return self._finish(call_id, action, user_ref, "incomplete_observation", count=count,
                                    observations=[], evidence=evidence, restored=restored)
            if receipt["resultHash"] != query["expectedLatestResultHash"]:
                status = "changed"
        evidence = self._artifact(call_id, "recovery-group", {"receipts": receipts})
        return self._finish(call_id, action, user_ref, status, count=count, evidence=evidence,
                            observations=receipts, restored=restored)
