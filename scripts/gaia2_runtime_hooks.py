"""Authenticated loopback IPC for the live Capybara plugin host.

The bridge waits for every hook receipt.  A missing host, invalid receipt or
transport failure is a technical failure, never permission to execute a tool.
No proxy, DNS lookup, redirect, credential or raw transport error is exposed.
"""

from __future__ import annotations

import json
import hashlib
import math
import os
import re
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


class HookProtocolError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(f"GAIA2 live hook rejected: {code}")


class _NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise HookProtocolError("redirect_not_allowed")


def _object_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise HookProtocolError("duplicate_response_key")
        result[key] = value
    return result


# RuntimePluginHost adds these fields after admission. They are trusted Host
# projections, not Actor-authored input; receipt binding must compare the
# caller-visible action while retaining all identity and argument evidence in
# the Host report itself. Keep this list identical to src/host_invocation_digest.mjs.
_DERIVED_ACTION_FIELDS = frozenset((
    "argumentHash", "argumentFieldHashes", "argumentFieldNumbers", "argumentMetadataComplete",
))


def _host_input_projection(value: Any) -> Any:
    if not isinstance(value, dict) or not isinstance(value.get("action"), dict):
        return value
    projected = dict(value)
    projected["action"] = {key: item for key, item in value["action"].items()
                            if key not in _DERIVED_ACTION_FIELDS}
    return projected


class RuntimeHookClient:
    def __init__(self, *, url: str | None = None, token: str | None = None,
                 execution_id: str | None = None, session_id: str | None = None,
                 timeout_seconds: float | None = None):
        self.url = url if url is not None else os.environ.get("GAIA2_HOOK_URL")
        self.token = token if token is not None else os.environ.get("GAIA2_HOOK_TOKEN")
        self.execution_id = execution_id if execution_id is not None else os.environ.get("GAIA2_EXECUTION_ID")
        self.session_id = session_id if session_id is not None else os.environ.get("GAIA2_SESSION_ID")
        try:
            timeout = timeout_seconds if timeout_seconds is not None else float(os.environ.get("GAIA2_HOOK_TIMEOUT_SECONDS", "30"))
            parsed = urlsplit(self.url or "")
            port = parsed.port
        except (ValueError, TypeError):
            raise HookProtocolError("invalid_host_configuration") from None
        if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1")
                or not port or parsed.username or parsed.password or parsed.path != "/invoke"
                or parsed.query or parsed.fragment):
            raise HookProtocolError("loopback_host_required")
        if (not isinstance(self.token, str) or not self.token.strip()
                or any(ord(c) < 32 or ord(c) >= 127 for c in self.token)):
            raise HookProtocolError("host_token_required")
        if any(not isinstance(value, str) or not value.strip() for value in (self.execution_id, self.session_id)):
            raise HookProtocolError("execution_identity_required")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
            raise HookProtocolError("invalid_host_timeout")
        self.timeout = timeout
        self.opener = build_opener(ProxyHandler({}), _NoRedirects())

    def invoke(self, checkpoint: str, **payload: Any) -> dict[str, Any]:
        if checkpoint not in ("before_model", "before_tool", "after_tool", "attempt_end"):
            raise HookProtocolError("invalid_checkpoint")
        envelope = {**payload, "executionId": self.execution_id, "sessionId": self.session_id, "checkpoint": checkpoint}
        try:
            body = json.dumps(envelope, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        except (ValueError, TypeError):
            raise HookProtocolError("invalid_request_payload") from None
        request = Request(self.url, data=body, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {self.token}",
        })
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                if response.status != 200:
                    raise HookProtocolError("host_http_failure")
                raw = response.read(8 * 1024 * 1024 + 1)
        except HookProtocolError:
            raise
        except HTTPError as error:
            # urllib raises HTTPError before a response object is returned;
            # preserve only a bounded server code for diagnostics and never
            # expose the provider body or local credentials.
            code = int(getattr(error, "code", 0) or 0)
            detail = ""
            try:
                body = error.read(4096).decode("utf-8", errors="replace")
                parsed = json.loads(body)
                candidate = parsed.get("code") if isinstance(parsed, dict) else None
                if isinstance(candidate, str) and re.fullmatch(r"[A-Za-z0-9_]{1,80}", candidate):
                    detail = "_" + candidate.lower()
            except Exception:
                pass
            raise HookProtocolError((f"host_http_{code}" if 100 <= code <= 599 else "host_http_failure") + detail) from None
        except Exception:
            raise HookProtocolError("host_transport_failure") from None
        if len(raw) > 8 * 1024 * 1024:
            raise HookProtocolError("host_response_too_large")
        try:
            result = json.loads(raw.decode("utf-8"), object_pairs_hook=_object_pairs,
                                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except HookProtocolError:
            raise
        except (UnicodeError, ValueError, TypeError):
            raise HookProtocolError("invalid_host_json") from None
        self.validate_response(result)
        if os.environ.get("GAIA2_RETRIEVAL_ENABLED") == "1":
            self.validate_retrieval_receipt(result, checkpoint=checkpoint, payload=payload)
        if os.environ.get("GAIA2_TEMPORAL_ENABLED") == "1":
            self.validate_temporal_receipt(result, checkpoint=checkpoint, payload=payload)
        if os.environ.get("GAIA2_CONFLICT_RECOVERY_ENABLED") == "1":
            self.validate_conflict_receipt(result, checkpoint=checkpoint, payload=payload)
        if (os.environ.get("GAIA2_ENTITY_SEMANTICS_ENABLED") == "1"
                or os.environ.get("GAIA2_MUTATION_RECEIPTS_ENABLED") == "1"):
            self.validate_semantic_receipt(result, checkpoint=checkpoint, payload=payload)
        return result

    def tool_round(self, op, round_id, **payload):
        """Shared backend scheduler RPC, never an Actor-visible native tool.

        No transport retry: a lost claim ACK cannot be replayed safely.
        The exact request/response is independently bound to immutable bytes.
        """
        envelope = {"executionId": self.execution_id, "sessionId": self.session_id,
                    "op": op, "roundId": round_id, "requestId": uuid.uuid4().hex, **payload}
        try:
            body = json.dumps(envelope, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            request = Request(self.url.removesuffix("/invoke") + "/tool-round", data=body, method="POST",
                              headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"})
            with self.opener.open(request, timeout=self.timeout) as response:
                if response.status != 200:
                    raise ValueError()
                raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise ValueError()
            result = json.loads(raw.decode("utf-8"), object_pairs_hook=_object_pairs,
                                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if (result.get("schemaVersion") != "gaia2-tool-round-receipt-v1"
                    or any(result.get(key) != envelope[key] for key in ("executionId", "sessionId", "op", "roundId", "requestId"))
                    or result.get("state", {}).get("schemaVersion") != "capybara-tool-round-state-v1"
                    or result["state"].get("roundId") != round_id):
                raise ValueError()
            workspace = next((os.environ.get(key) for key in ("GAIA2_TOOL_ROUND_WORKSPACE", "GAIA2_CONFLICT_RECOVERY_WORKSPACE",
                "GAIA2_TEMPORAL_WORKSPACE", "GAIA2_RETRIEVAL_WORKSPACE", "GAIA2_TASK_CONTRACT_WORKSPACE") if os.environ.get(key)), None)
            ref = result.get("sourceRef", {})
            relative = ref.get("path")
            if not workspace or not isinstance(relative, str) or re.fullmatch(r"tool-round-runtime/\d{6}-[a-f0-9]{32}\.json", relative) is None:
                raise ValueError()
            root = Path(workspace).absolute()
            target = root.joinpath(*relative.split("/"))
            if (root.is_symlink() or target.is_symlink() or target.parent.is_symlink()
                    or not target.resolve().is_relative_to(root.resolve()) or not target.is_file() or target.stat().st_size > 8 * 1024 * 1024):
                raise ValueError()
            evidence_bytes = target.read_bytes()
            if hashlib.sha256(evidence_bytes).hexdigest() != ref.get("sha256"):
                raise ValueError()
            evidence = json.loads(evidence_bytes.decode("utf-8"), object_pairs_hook=_object_pairs)
            if (evidence.get("schemaVersion") != "gaia2-tool-round-evidence-v1" or evidence.get("request") != envelope
                    or evidence.get("response") != {key: value for key, value in result.items() if key != "sourceRef"}):
                raise ValueError()
            return result
        except Exception:
            raise HookProtocolError("tool_round_rpc_binding_failed") from None

    def validate_semantic_receipt(self, result, *, checkpoint, payload):
        """Authenticate execution evidence; v1 task state is historical compatibility only."""
        receipt = result.get("semanticReceipt")
        if not isinstance(receipt, dict) or receipt.get("schemaVersion") not in ("gaia2-semantic-receipt-v1", "gaia2-semantic-receipt-v2"):
            raise HookProtocolError("semantic_receipt_required")
        if (receipt.get("executionId") != self.execution_id or receipt.get("sessionId") != self.session_id
                or receipt.get("checkpoint") != checkpoint):
            raise HookProtocolError("semantic_receipt_identity")
        workspace_names = ["GAIA2_ENTITY_SEMANTICS_WORKSPACE", "GAIA2_MUTATION_RECEIPTS_WORKSPACE"]
        if receipt["schemaVersion"] == "gaia2-semantic-receipt-v1":
            workspace_names.append("GAIA2_TASK_CONTRACT_WORKSPACE")
        workspaces = [os.environ.get(name, "") for name in workspace_names]
        workspace = next((value for value in workspaces if value), "")
        ref = receipt.get("sourceReceiptRef")
        relative = ref.get("path") if isinstance(ref, dict) else None
        match = re.fullmatch(r"plugin-runtime/(\d{6})-(before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json", relative) if isinstance(relative, str) else None
        if (not workspace or not match or match[2] != checkpoint
                or not isinstance(receipt.get("sequence"), int) or isinstance(receipt.get("sequence"), bool)
                or receipt["sequence"] < 2 or int(match[1]) != receipt["sequence"]):
            raise HookProtocolError("semantic_receipt_path")
        root = Path(workspace).absolute()
        target = root.joinpath(*relative.split("/"))
        try:
            if (root.is_symlink() or os.path.normcase(str(root.resolve())) != os.path.normcase(str(root))
                    or any(value and os.path.normcase(str(Path(value).absolute())) != os.path.normcase(str(root)) for value in workspaces)):
                raise ValueError()
            current = root
            for part in relative.split("/"):
                current = current / part
                if current.is_symlink():
                    raise ValueError()
            if not target.is_file() or target.stat().st_size > 8 * 1024 * 1024:
                raise ValueError()
            raw = target.read_bytes()
            if hashlib.sha256(raw).hexdigest() != ref.get("sha256"):
                raise ValueError()
            report = json.loads(raw.decode("utf-8"), object_pairs_hook=_object_pairs,
                                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if (not isinstance(report, dict) or report.get("schemaVersion") != "capybara-runtime-plugin-invocation-v1"
                    or report.get("executionId") != self.execution_id or report.get("sessionId") != self.session_id
                    or _host_input_projection(report.get("input")) != _host_input_projection({**payload, "checkpoint": checkpoint})
                    or report.get("sequence") != receipt.get("sequence")):
                raise ValueError()
            for field in ("revision", "variablesHash", "contextHash"):
                if report.get(field) != receipt.get(field) or result.get(field) != receipt.get(field):
                    raise ValueError()
            if (not isinstance(report.get("revision"), int) or isinstance(report["revision"], bool) or report["revision"] < 0
                    or report.get("decision") != result.get("decision") or report.get("hookReceipts") != result.get("hookReceipts")
                    or report.get("context") != result.get("context") or not isinstance(report.get("context"), str)
                    or hashlib.sha256(report["context"].encode("utf-8")).hexdigest() != receipt.get("contextHash")):
                raise ValueError()
            values = report.get("variables")
            if not isinstance(values, dict):
                raise ValueError()
            state_fields = [("entityState", "gaia2_entity_state", "gaia2-entity-state-v1")]
            if receipt["schemaVersion"] == "gaia2-semantic-receipt-v1":
                state_fields.append(("taskContractState", "gaia2_task_contract_state", "gaia2-task-contract-state-v1"))
            elif "taskContractState" in receipt or "taskContractStateHash" in receipt:
                raise ValueError()
            for key, variable, schema in state_fields:
                state = receipt.get(key)
                if (not isinstance(state, dict) or state.get("schemaVersion") != schema
                        or not isinstance(state.get("enabled"), bool) or state != values.get(variable)):
                    raise ValueError()
                state_bytes = json.dumps(state, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
                if len(state_bytes) > 131072 or hashlib.sha256(state_bytes).hexdigest() != receipt.get(key + "Hash"):
                    raise ValueError()
                if key == "entityState":
                    records = state.get("records")
                    if not isinstance(records, list) or len(records) > 64 or not state["enabled"] and records:
                        raise ValueError()
                    for evidence in records:
                        if (not isinstance(evidence, dict) or evidence.get("schemaVersion") != "gaia2-entity-evidence-v1"
                                or evidence.get("executionId") != self.execution_id or evidence.get("sessionId") != self.session_id):
                            raise ValueError()
                elif state["enabled"]:
                    if (state.get("executionId") != self.execution_id or state.get("sessionId") != self.session_id
                            or not isinstance(state.get("sources"), list) or len(state["sources"]) > 64
                            or not isinstance(state.get("obligations"), list) or len(state["obligations"]) > 64
                            or not isinstance(state.get("revision"), int) or isinstance(state["revision"], bool) or state["revision"] < 0):
                        raise ValueError()
                    users = {item.get("id"): item for item in payload.get("messages", []) if isinstance(item, dict)
                             and item.get("role") == "user" and item.get("notificationType") == "USER_MESSAGE"}
                    for source in state["sources"]:
                        original = users.get(source.get("userRef")) if isinstance(source, dict) else None
                        if (not isinstance(original, dict) or not isinstance(original.get("content"), str)
                                or hashlib.sha256(original["content"].encode("utf-8")).hexdigest() != source.get("sourceHash")):
                            raise ValueError()
                        normalization_refs = ("rawProposalRef", "normalizedProposalRef", "anchoringRef", "extractionRef")
                        if any(key in source for key in normalization_refs):
                            def valid_ref(value):
                                return (isinstance(value, dict) and isinstance(value.get("path"), str)
                                    and re.fullmatch(r"[a-f0-9]{24}/[a-z-]+-[a-f0-9]{32}\.json", value["path"])
                                    and isinstance(value.get("sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", value["sha256"]))
                            if (any(key not in source or source[key] is not None and not valid_ref(source[key]) for key in normalization_refs)
                                    or source.get("resolution") != "ambiguous" and not all(valid_ref(source[key]) for key in normalization_refs)
                                    or source["normalizedProposalRef"] is not None and source["normalizedProposalRef"] != source.get("proposalRef")):
                                raise ValueError()
                        if "resolverAttempts" in source:
                            if (type(source["resolverAttempts"]) is not int or source["resolverAttempts"] not in (1, 2)
                                    or type(source.get("resolverRetryable")) is not bool or not isinstance(source.get("attemptHistory"), list)
                                    or len(source["attemptHistory"]) != source["resolverAttempts"] - 1
                                    or source["resolverRetryable"] and (source.get("resolution") != "ambiguous" or source["resolverAttempts"] != 1)):
                                raise ValueError()
                            for old in source["attemptHistory"]:
                                if (not isinstance(old, dict) or any(old.get(key) != source[key] for key in ("userRef", "sourceHash", "arrivedAt", "evidenceRef"))
                                        or old.get("resolution") != "ambiguous" or old.get("resolverRetryable") is not True or old.get("resolverAttempts") != 1):
                                    raise ValueError()
                    for obligation in state["obligations"]:
                        if not isinstance(obligation, dict):
                            raise ValueError()
                        reason = obligation.get("completionReason")
                        if obligation.get("status") == "satisfied":
                            if (reason not in ("condition_satisfied", "deadline_reviewed")
                                    or obligation.get("mode") == "monitor_until" and reason != "deadline_reviewed"):
                                raise ValueError()
                        elif reason is not None:
                            raise ValueError()
            if os.environ.get("GAIA2_MUTATION_RECEIPTS_ENABLED") == "1":
                write_state = receipt.get("writeState")
                if not isinstance(write_state, dict) or write_state != values.get("gaia2_write_state"):
                    raise ValueError()
                encoded = json.dumps(write_state, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
                if len(encoded) > 4 * 1024 * 1024 or hashlib.sha256(encoded).hexdigest() != receipt.get("writeStateHash"):
                    raise ValueError()
                self._validate_mutation_write_state(write_state)
            if hashlib.sha256(target.read_bytes()).hexdigest() != ref.get("sha256"):
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError, UnicodeError):
            raise HookProtocolError("semantic_receipt_binding") from None
        return receipt

    def _validate_mutation_write_state(self, state):
        """Validate the bounded historical mutation ledger from Host evidence.

        This is deliberately structural and source-bound. Current provider
        visibility, TTL, or a success-looking string cannot create a receipt;
        the Node Host validator has already authenticated the native proof.
        """
        if not isinstance(state, dict) or not all(isinstance(state.get(key), list)
                                                   for key in ("actions", "unknown", "blocked")):
            raise ValueError()
        if any(len(state[key]) > 8192 for key in ("actions", "unknown", "blocked")):
            raise ValueError()
        seen = set()
        for entry in state["actions"]:
            if not isinstance(entry, dict) or not isinstance(entry.get("actionId"), str):
                raise ValueError()
            receipt = entry.get("mutationReceipt")
            if receipt is None:
                continue
            if entry.get("status") != "succeeded" or entry["actionId"] in seen:
                raise ValueError()
            seen.add(entry["actionId"])
            if (not isinstance(receipt, dict)
                    or receipt.get("schemaVersion") != "gaia2-mutation-evidence-v1"
                    or receipt.get("kind") != "mutation_confirmed"
                    or receipt.get("confirmation") != "confirmed_applied"
                    or receipt.get("executionId") != self.execution_id
                    or receipt.get("sessionId") != self.session_id):
                raise ValueError()
            ref = receipt.get("callRef")
            if (not isinstance(ref, dict) or ref.get("actionId") != entry["actionId"]
                    or not isinstance(ref.get("queryHash"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", ref["queryHash"])
                    or not isinstance(ref.get("resultHash"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", ref["resultHash"])
                    or entry.get("mutationKey") != ref["queryHash"]
                    or entry.get("resultHash") != ref["resultHash"]
                    or entry.get("resourceKey") != receipt.get("resourceKey")):
                raise ValueError()
            body = {key: value for key, value in receipt.items() if key != "receiptId"}
            encoded = json.dumps(body, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":"), allow_nan=False).encode("utf-8")
            if (not isinstance(receipt.get("receiptId"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", receipt["receiptId"])
                    or hashlib.sha256(encoded).hexdigest() != receipt["receiptId"]
                    or len(json.dumps(receipt, ensure_ascii=False).encode("utf-8")) > 12000):
                raise ValueError()

    def validate_conflict_receipt(self, result, *, checkpoint, payload):
        """Bind a recovery plan to this exact invocation's actual Host report."""
        receipt = result.get("conflictReceipt")
        if not isinstance(receipt, dict) or receipt.get("schemaVersion") != "gaia2-conflict-receipt-v1":
            raise HookProtocolError("conflict_receipt_required")
        if (receipt.get("executionId") != self.execution_id or receipt.get("sessionId") != self.session_id
                or receipt.get("checkpoint") != checkpoint):
            raise HookProtocolError("conflict_receipt_identity")
        ref = receipt.get("sourceReceiptRef", {})
        if not isinstance(ref, dict):
            raise HookProtocolError("conflict_receipt_path")
        relative = ref.get("path")
        workspace = os.environ.get("GAIA2_CONFLICT_RECOVERY_WORKSPACE", "")
        if (not workspace or not isinstance(relative, str)
                or re.fullmatch(r"plugin-runtime/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json", relative) is None):
            raise HookProtocolError("conflict_receipt_path")
        root = Path(workspace).absolute()
        target = root.joinpath(*relative.split("/"))
        try:
            if root.is_symlink() or os.path.normcase(str(root.resolve())) != os.path.normcase(str(root)):
                raise ValueError()
            current = root
            for part in relative.split("/"):
                current = current / part
                if current.is_symlink():
                    raise ValueError()
            if not target.is_file() or target.stat().st_size > 8 * 1024 * 1024:
                raise ValueError()
            raw = target.read_bytes()
            if hashlib.sha256(raw).hexdigest() != ref.get("sha256"):
                raise ValueError()
            report = json.loads(raw.decode("utf-8"), object_pairs_hook=_object_pairs,
                                parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            if (not isinstance(report, dict) or report.get("schemaVersion") != "capybara-runtime-plugin-invocation-v1"
                    or report.get("executionId") != self.execution_id or report.get("sessionId") != self.session_id
                    or _host_input_projection(report.get("input")) != _host_input_projection({**payload, "checkpoint": checkpoint})
                    or report.get("sequence") != receipt.get("sequence")):
                raise ValueError()
            for field in ("revision", "variablesHash", "contextHash"):
                if report.get(field) != receipt.get(field) or result.get(field) != receipt.get(field):
                    raise ValueError()
            if report.get("decision") != result.get("decision") or report.get("hookReceipts") != result.get("hookReceipts"):
                raise ValueError()
            values = report.get("variables")
            state = receipt.get("state")
            if (not isinstance(values, dict) or not isinstance(state, dict)
                    or state.get("schemaVersion") not in ("gaia2-conflict-state-v1", "gaia2-conflict-state-v2")
                    or state != values.get("gaia2_conflict_state")):
                raise ValueError()
            state_bytes = json.dumps(state, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode("utf-8")
            if hashlib.sha256(state_bytes).hexdigest() != receipt.get("stateHash"):
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError):
            raise HookProtocolError("conflict_receipt_binding") from None
        return receipt

    def validate_temporal_receipt(self, result, *, checkpoint, payload):
        """Bind controller state to this exact invocation's actual Host report."""
        receipt = result.get("temporalReceipt")
        if not isinstance(receipt, dict) or receipt.get("schemaVersion") != "gaia2-temporal-receipt-v1":
            raise HookProtocolError("temporal_receipt_required")
        if (receipt.get("executionId") != self.execution_id or receipt.get("sessionId") != self.session_id
                or receipt.get("checkpoint") != checkpoint):
            raise HookProtocolError("temporal_receipt_identity")
        ref = receipt.get("sourceReceiptRef", {})
        if not isinstance(ref, dict):
            raise HookProtocolError("temporal_receipt_path")
        relative = ref.get("path")
        workspace = os.environ.get("GAIA2_TEMPORAL_WORKSPACE", "")
        if (not workspace or not isinstance(relative, str)
                or re.fullmatch(r"plugin-runtime/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json", relative) is None):
            raise HookProtocolError("temporal_receipt_path")
        root = Path(workspace).absolute()
        target = root.joinpath(*relative.split("/"))
        try:
            if root.is_symlink() or os.path.normcase(str(root.resolve())) != os.path.normcase(str(root)):
                raise ValueError()
            current = root
            for part in relative.split("/"):
                current = current / part
                if current.is_symlink():
                    raise ValueError()
            if not target.is_file() or target.stat().st_size > 8 * 1024 * 1024:
                raise ValueError()
            raw = target.read_bytes()
            if hashlib.sha256(raw).hexdigest() != ref.get("sha256"):
                raise ValueError()
            report = json.loads(raw.decode("utf-8"), object_pairs_hook=_object_pairs)
            if (report.get("schemaVersion") != "capybara-runtime-plugin-invocation-v1"
                    or report.get("executionId") != self.execution_id or report.get("sessionId") != self.session_id
                    or _host_input_projection(report.get("input")) != _host_input_projection({**payload, "checkpoint": checkpoint})
                    or report.get("sequence") != receipt.get("sequence")):
                raise ValueError()
            for field in ("revision", "variablesHash", "contextHash"):
                if report.get(field) != receipt.get(field) or result.get(field) != receipt.get(field):
                    raise ValueError()
            if report.get("decision") != result.get("decision") or report.get("hookReceipts") != result.get("hookReceipts"):
                raise ValueError()
            if (not isinstance(report.get("variables"), dict)
                    or receipt.get("state") != report["variables"].get("gaia2_temporal_state")):
                raise ValueError()
            state_bytes = json.dumps(receipt["state"], ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False).encode("utf-8")
            if hashlib.sha256(state_bytes).hexdigest() != receipt.get("stateHash"):
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError):
            raise HookProtocolError("temporal_receipt_binding") from None
        return receipt

    def validate_retrieval_receipt(self, result, *, checkpoint, payload):
        """Bind the project extension to the exact immutable Host report, not prompt text."""
        receipt = result.get("retrievalReceipt")
        if not isinstance(receipt, dict) or receipt.get("schemaVersion") != "gaia2-retrieval-receipt-v1":
            raise HookProtocolError("retrieval_receipt_required")
        if (receipt.get("executionId") != self.execution_id or receipt.get("sessionId") != self.session_id
                or receipt.get("checkpoint") != checkpoint):
            raise HookProtocolError("retrieval_receipt_identity")
        ref = receipt.get("sourceReceiptRef", {})
        relative = ref.get("path")
        workspace = os.environ.get("GAIA2_RETRIEVAL_WORKSPACE", "")
        if (not workspace or not isinstance(relative, str)
                or re.fullmatch(r"plugin-runtime/\d{6}-(?:before_model|before_tool|after_tool|attempt_end)-[a-f0-9-]+\.json", relative) is None):
            raise HookProtocolError("retrieval_receipt_path")
        root = Path(workspace).absolute()
        target = root.joinpath(*relative.split("/"))
        try:
            if root.is_symlink() or os.path.normcase(str(root.resolve())) != os.path.normcase(str(root)):
                raise ValueError()
            current = root
            for part in relative.split("/"):
                current = current / part
                if current.is_symlink():
                    raise ValueError()
            if not target.is_file() or target.stat().st_size > 8 * 1024 * 1024:
                raise ValueError()
            raw = target.read_bytes()
            if hashlib.sha256(raw).hexdigest() != ref.get("sha256"):
                raise ValueError()
            report = json.loads(raw.decode("utf-8"), object_pairs_hook=_object_pairs)
            expected = {**payload, "checkpoint": checkpoint}
            if (report.get("schemaVersion") != "capybara-runtime-plugin-invocation-v1"
                    or report.get("executionId") != self.execution_id or report.get("sessionId") != self.session_id
                    or _host_input_projection(report.get("input")) != _host_input_projection(expected)
                    or report.get("sequence") != receipt.get("sequence")):
                raise ValueError()
            for field in ("revision", "variablesHash", "contextHash"):
                if report.get(field) != receipt.get(field) or result.get(field) != receipt.get(field):
                    raise ValueError()
            if report.get("decision") != result.get("decision") or report.get("hookReceipts") != result.get("hookReceipts"):
                raise ValueError()
            values = report["variables"]
            if (receipt.get("scope") != values.get("gaia2_retrieval_scope")
                    or receipt.get("projection") != values.get("gaia2_retrieval_projection")):
                raise ValueError()
            if not isinstance(receipt.get("planHash"), str) or re.fullmatch(r"[a-f0-9]{64}", receipt["planHash"]) is None:
                raise ValueError()
            from gaia2_retrieval import canonical_hash
            if canonical_hash(receipt["projection"]) != receipt["planHash"]:
                raise ValueError()
        except (OSError, ValueError, KeyError, TypeError):
            raise HookProtocolError("retrieval_receipt_binding") from None
        return receipt

    @staticmethod
    def validate_response(result: Any) -> dict[str, Any]:
        if not isinstance(result, dict):
            raise HookProtocolError("invalid_host_response")
        decision = result.get("decision")
        if not isinstance(decision, dict) or decision.get("action") not in ("allow", "block", "read_back"):
            raise HookProtocolError("invalid_host_decision")
        if not isinstance(decision.get("reason"), str) or not decision["reason"]:
            raise HookProtocolError("decision_reason_required")
        if "context" not in result or not isinstance(result["context"], str):
            raise HookProtocolError("context_required")
        for field in ("contextHash", "variablesHash"):
            if not isinstance(result.get(field), str) or re.fullmatch(r"[0-9a-f]{64}", result[field]) is None:
                raise HookProtocolError("invalid_receipt_hash")
        if result["contextHash"] != hashlib.sha256(result["context"].encode("utf-8")).hexdigest():
            raise HookProtocolError("context_hash_mismatch")
        if not isinstance(result.get("hookReceipts"), list) or not result["hookReceipts"]:
            raise HookProtocolError("hook_receipt_required")
        revision = result.get("revision")
        if isinstance(revision, bool) or not isinstance(revision, int) or revision < 0:
            raise HookProtocolError("invalid_host_revision")
        if not isinstance(result.get("evidencePath"), str) or not result["evidencePath"]:
            raise HookProtocolError("evidence_path_required")
        return result
