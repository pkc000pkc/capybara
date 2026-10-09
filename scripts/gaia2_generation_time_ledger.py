"""Append-only, safe generation-time evidence for the trusted c2.2a slice."""

from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re
import stat
import os
from typing import Any


class GenerationLedgerError(RuntimeError):
    """Fixed safe error codes only; values are never included in messages."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


_HASH = re.compile(r"[a-f0-9]{64}\Z")
_ID = re.compile(r"[a-f0-9]{32}\Z")
_CODE = re.compile(r"[A-Z0-9_]{1,80}\Z")
_TIMING_KEYS = frozenset(("logicalElapsedSeconds", "sdkAttemptElapsedSeconds",
    "successfulSdkElapsedSeconds", "cooldownSeconds"))
_USAGE_KEYS = frozenset(("inputTokens", "outputTokens", "totalTokens"))
_KINDS = frozenset(("admission", "pause_acquired", "model_returned", "pause_released",
    "model_finished", "failed"))


def _fail(code: str) -> None:
    raise GenerationLedgerError(code) from None


def _hash(value: Any) -> bool:
    return type(value) is str and _HASH.fullmatch(value) is not None


def _id(value: Any) -> bool:
    return type(value) is str and _ID.fullmatch(value) is not None


def _number(value: Any) -> bool:
    try:
        return type(value) in (int, float) and math.isfinite(value) and value >= 0
    except (TypeError, ValueError, OverflowError):
        return False


def _safe_usage(value: Any) -> dict | None:
    if value is None:
        return None
    if (type(value) is not dict or not value or set(value) - _USAGE_KEYS
            or any(type(item) is not int or item < 0 or item > 2**53 - 1 for item in value.values())):
        _fail("GENERATION_LEDGER_USAGE_INVALID")
    return {key: value[key] for key in sorted(value)}


def _safe_timing(value: Any) -> dict:
    if type(value) is not dict or set(value) != _TIMING_KEYS:
        _fail("GENERATION_LEDGER_TIMING_INVALID")
    if any(item is not None and not _number(item) for item in value.values()):
        _fail("GENERATION_LEDGER_TIMING_INVALID")
    return {key: value[key] for key in sorted(value)}


def _regular_directory(path: Path) -> Path:
    if not path.is_absolute():
        _fail("GENERATION_LEDGER_ROOT_INVALID")
    try:
        for item in path.parents:
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                _fail("GENERATION_LEDGER_ROOT_INVALID")
        if path.exists():
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                _fail("GENERATION_LEDGER_ROOT_INVALID")
        path.mkdir(parents=True, exist_ok=True)
        if not path.is_dir() or path.resolve(strict=True) != path:
            _fail("GENERATION_LEDGER_ROOT_INVALID")
    except GenerationLedgerError:
        raise
    except BaseException:
        _fail("GENERATION_LEDGER_ROOT_INVALID")
    return path


class ScopedGenerationTimeLedger:
    """Trusted append-only chain with no raw model/endpoint/exception fields."""

    def __init__(self, *, evidence_root: str | Path, source_manifest_hash: str,
                 scope_hash: str, model_scope_hash: str, permit_id: str,
                 request_id: str, actual_input_hash: str):
        if (not _hash(source_manifest_hash) or not _hash(scope_hash)
                or not _hash(model_scope_hash) or not _hash(actual_input_hash)
                or not _id(permit_id) or not _id(request_id)):
            _fail("GENERATION_LEDGER_IDENTITY_INVALID")
        root = Path(evidence_root)
        self.__root = _regular_directory(root)
        self.__json = _regular_directory(root / "json")
        self.__common = {"sourceManifestHash": source_manifest_hash, "scopeHash": scope_hash,
            "modelScopeHash": model_scope_hash, "permitId": permit_id,
            "requestId": request_id, "actualInputHash": actual_input_hash}
        self.__sequence = 0
        self.__previous_hash = None
        self.__phase = "new"
        self.__lease_id = None
        self.__output_hash = None
        self.__refs: list[dict] = []

    @property
    def phase(self) -> str:
        return self.__phase

    @property
    def previous_hash(self) -> str | None:
        return self.__previous_hash

    def __append(self, kind: str, fields: dict) -> dict:
        if kind not in _KINDS:
            _fail("GENERATION_LEDGER_KIND_INVALID")
        value = {"schemaVersion": "gaia2-generation-time-ledger-v1", **self.__common,
            "sequence": self.__sequence + 1, "previousHash": self.__previous_hash,
            "kind": kind, **fields}
        raw = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        name = f"{self.__sequence + 1:06d}-generation-time.json"
        target = self.__json / name
        try:
            with target.open("xb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            digest = hashlib.sha256(raw).hexdigest()
        except FileExistsError:
            _fail("GENERATION_LEDGER_WRITE_FAILED")
        except BaseException:
            _fail("GENERATION_LEDGER_WRITE_FAILED")
        ref = {"path": f"json/{name}", "sha256": digest}
        self.__sequence += 1
        self.__previous_hash = digest
        self.__refs.append(ref)
        return dict(ref)

    def admission(self) -> dict:
        if self.__phase != "new":
            _fail("GENERATION_LEDGER_ORDER_INVALID")
        ref = self.__append("admission", {})
        self.__phase = "admitted"
        return ref

    def pause_acquired(self, *, lease_id: str) -> dict:
        if self.__phase != "admitted" or not _id(lease_id):
            _fail("GENERATION_LEDGER_ORDER_INVALID")
        self.__lease_id = lease_id
        ref = self.__append("pause_acquired", {"leaseId": lease_id})
        self.__phase = "paused"
        return ref

    def model_returned(self, *, output_hash: str, timing: dict, usage: dict | None) -> dict:
        if self.__phase != "paused" or not _hash(output_hash):
            _fail("GENERATION_LEDGER_ORDER_INVALID")
        safe_timing = _safe_timing(timing)
        safe_usage = _safe_usage(usage)
        self.__output_hash = output_hash
        ref = self.__append("model_returned", {"outputHash": output_hash,
            "timing": safe_timing, "usage": safe_usage})
        self.__phase = "returned"
        return ref

    def pause_released(self, *, lease_id: str, offset: float) -> dict:
        if self.__phase not in ("paused", "returned") or lease_id != self.__lease_id or not _number(offset):
            _fail("GENERATION_LEDGER_ORDER_INVALID")
        ref = self.__append("pause_released", {"leaseId": lease_id, "offset": float(offset)})
        self.__phase = "released"
        return ref

    def model_finished(self, *, output_hash: str, usage: dict | None) -> dict:
        if self.__phase != "released" or output_hash != self.__output_hash or not _hash(output_hash):
            _fail("GENERATION_LEDGER_ORDER_INVALID")
        ref = self.__append("model_finished", {"outputHash": output_hash, "usage": _safe_usage(usage)})
        self.__phase = "finished"
        return ref

    def failed(self, *, code: str) -> dict:
        if self.__phase in ("new", "finished", "failed") or type(code) is not str or _CODE.fullmatch(code) is None:
            _fail("GENERATION_LEDGER_ORDER_INVALID")
        ref = self.__append("failed", {"failureCode": code})
        self.__phase = "failed"
        return ref

    def snapshot(self) -> dict:
        return {"schemaVersion": "gaia2-generation-time-ledger-v1", **self.__common,
            "sequence": self.__sequence, "previousHash": self.__previous_hash,
            "phase": self.__phase, "evidenceRefs": [dict(ref) for ref in self.__refs]}
