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
_PHASES = frozenset(("new", "admitted", "paused", "returned", "released", "finished", "failed"))
_EVENT_KEYS = {
    "admission": frozenset(), "pause_acquired": frozenset(("leaseId",)),
    "model_returned": frozenset(("outputHash", "timing", "usage")),
    "pause_released": frozenset(("leaseId", "offset")),
    "model_finished": frozenset(("outputHash", "usage")),
    "failed": frozenset(("failureCode",))}
_MAX_EVENT_BYTES = 1024 * 1024


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
            try:
                info = item.lstat()
            except FileNotFoundError:
                # A fresh ledger may be nested below an existing native
                # evidence root.  Missing ancestors are created below, then
                # all resulting path components are checked again.
                continue
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                _fail("GENERATION_LEDGER_ROOT_INVALID")
        if path.exists():
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                _fail("GENERATION_LEDGER_ROOT_INVALID")
        path.mkdir(parents=True, exist_ok=True)
        if not path.is_dir() or path.resolve(strict=True) != path:
            _fail("GENERATION_LEDGER_ROOT_INVALID")
        for item in (path, *path.parents):
            info = item.lstat()
            if (stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400
                    or item.resolve(strict=True) != item):
                _fail("GENERATION_LEDGER_ROOT_INVALID")
    except GenerationLedgerError:
        raise
    except BaseException:
        _fail("GENERATION_LEDGER_ROOT_INVALID")
    return path


def _directory_identity(path: Path) -> tuple:
    """Read-only regular-directory check; never recreate a replaced root."""
    try:
        info = path.lstat()
        if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                or getattr(info, "st_file_attributes", 0) & 0x400
                or path.resolve(strict=True) != path):
            _fail("GENERATION_LEDGER_PATH_CHANGED")
        return (info.st_dev, info.st_ino)
    except GenerationLedgerError:
        raise
    except BaseException:
        _fail("GENERATION_LEDGER_PATH_CHANGED")


def _decode_event(raw: bytes) -> dict:
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
            value[key] = item
        return value
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=pairs,
            parse_constant=lambda _value: _fail("GENERATION_LEDGER_VERIFICATION_FAILED"))
        if type(value) is not dict:
            _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
        return value
    except GenerationLedgerError:
        raise
    except BaseException:
        _fail("GENERATION_LEDGER_VERIFICATION_FAILED")


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
        self.__directories = {path: _directory_identity(path)
            for path in (self.__json, self.__root, *self.__root.parents)}
        self.__common = {"sourceManifestHash": source_manifest_hash, "scopeHash": scope_hash,
            "modelScopeHash": model_scope_hash, "permitId": permit_id,
            "requestId": request_id, "actualInputHash": actual_input_hash}
        self.__sequence = 0
        self.__previous_hash = None
        self.__phase = "new"
        self.__lease_id = None
        self.__output_hash = None
        self.__usage = None
        self.__refs: list[dict] = []
        self.__events: list[dict] = []

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
            self.__check_directories()
            with target.open("xb") as stream:
                stream.write(raw)
                stream.flush()
                os.fsync(stream.fileno())
            digest = hashlib.sha256(raw).hexdigest()
        except GenerationLedgerError:
            raise
        except FileExistsError:
            _fail("GENERATION_LEDGER_WRITE_FAILED")
        except BaseException:
            _fail("GENERATION_LEDGER_WRITE_FAILED")
        ref = {"path": f"json/{name}", "sha256": digest}
        self.__sequence += 1
        self.__previous_hash = digest
        self.__refs.append(ref)
        # Keep detached, immutable-by-public-API event expectations. Verification
        # still reads every original file; this prevents a forged chain with
        # edited timing/usage from becoming authoritative by editing refs alone.
        self.__events.append(_decode_event(raw))
        return dict(ref)

    def __check_directories(self) -> None:
        for path, identity in self.__directories.items():
            if _directory_identity(path) != identity:
                _fail("GENERATION_LEDGER_PATH_CHANGED")

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
        self.__usage = safe_usage
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
        safe_usage = _safe_usage(usage)
        if safe_usage != self.__usage:
            _fail("GENERATION_LEDGER_ORDER_INVALID")
        ref = self.__append("model_finished", {"outputHash": output_hash, "usage": safe_usage})
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

    def verify(self, *, expected_phase: str) -> dict:
        """Verify this exact request's persisted chain, then return its snapshot.

        Trusted single-threaded owner API, not a general concurrent database.
        It rejects missing/extra files, path replacement, duplicate JSON keys,
        foreign identities, malformed events, reordered/replayed chains and
        differences from the events this instance actually committed.
        """
        if type(expected_phase) is not str or expected_phase not in _PHASES:
            _fail("GENERATION_LEDGER_PHASE_INVALID")
        try:
            self.__check_directories()
            if (self.__phase != expected_phase or type(self.__sequence) is not int
                    or self.__sequence < 0 or self.__sequence != len(self.__refs)
                    or self.__sequence != len(self.__events)):
                _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
            expected_names = {f"{index:06d}-generation-time.json" for index in range(1, self.__sequence + 1)}
            if (set(path.name for path in self.__root.iterdir()) != {"json"}
                    or set(path.name for path in self.__json.iterdir()) != expected_names):
                _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
            phase, previous, lease_id, output_hash, returned_usage = "new", None, None, None, None
            common_keys = set(self.__common) | {"schemaVersion", "sequence", "previousHash", "kind"}
            for index, (ref, committed) in enumerate(zip(self.__refs, self.__events), 1):
                name = f"{index:06d}-generation-time.json"
                if (type(ref) is not dict or set(ref) != {"path", "sha256"}
                        or ref["path"] != f"json/{name}" or not _hash(ref["sha256"])):
                    _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                path = self.__json / name
                info = path.lstat()
                if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode)
                        or getattr(info, "st_file_attributes", 0) & 0x400
                        or info.st_size > _MAX_EVENT_BYTES or path.resolve(strict=True) != path):
                    _fail("GENERATION_LEDGER_PATH_CHANGED")
                raw = path.read_bytes()
                if len(raw) > _MAX_EVENT_BYTES or hashlib.sha256(raw).hexdigest() != ref["sha256"]:
                    _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                value = _decode_event(raw)
                canonical = (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
                committed_canonical = (json.dumps(committed, ensure_ascii=False, sort_keys=True,
                    separators=(",", ":")) + "\n").encode("utf-8")
                if raw != canonical or raw != committed_canonical:
                    _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                kind = value.get("kind")
                if (type(kind) is not str or kind not in _KINDS
                        or set(value) != common_keys | _EVENT_KEYS[kind]
                        or value.get("schemaVersion") != "gaia2-generation-time-ledger-v1"
                        or type(value.get("sequence")) is not int or value["sequence"] != index
                        or value.get("previousHash") != previous
                        or any(value.get(key) != item for key, item in self.__common.items())
                        or value != committed):
                    _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                if kind == "admission":
                    if phase != "new":
                        _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                    phase = "admitted"
                elif kind == "pause_acquired":
                    if phase != "admitted" or not _id(value["leaseId"]):
                        _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                    phase, lease_id = "paused", value["leaseId"]
                elif kind == "model_returned":
                    if phase != "paused" or not _hash(value["outputHash"]):
                        _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                    _safe_timing(value["timing"])
                    returned_usage = _safe_usage(value["usage"])
                    phase, output_hash = "returned", value["outputHash"]
                elif kind == "pause_released":
                    if (phase not in ("paused", "returned") or value["leaseId"] != lease_id
                            or not _number(value["offset"])):
                        _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                    phase = "released"
                elif kind == "model_finished":
                    if (phase != "released" or output_hash is None or value["outputHash"] != output_hash
                            or _safe_usage(value["usage"]) != returned_usage):
                        _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                    phase = "finished"
                else:
                    if (phase in ("new", "finished", "failed") or type(value["failureCode"]) is not str
                            or _CODE.fullmatch(value["failureCode"]) is None):
                        _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
                    phase = "failed"
                previous = ref["sha256"]
            self.__check_directories()
            if (phase != expected_phase or previous != self.__previous_hash
                    or lease_id != self.__lease_id or output_hash != self.__output_hash
                    or returned_usage != self.__usage):
                _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
            return self.snapshot()
        except GenerationLedgerError:
            raise
        except BaseException:
            _fail("GENERATION_LEDGER_VERIFICATION_FAILED")
