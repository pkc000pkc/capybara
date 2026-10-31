"""A deterministic signal-driven wait loop over the real ARE tool callbacks.

There is no second clock, sleeping, model call, semantic filter, or business
write in this module.  The bridge owns read-only admission and audited native
execution.  Complete poll artifacts stay on disk; only the final observation
is returned to the actor.  A Host commit must ACK before another native call.
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


TOOL_NAME = "capybara_wait_watch"
CANONICAL_NAME = "CapybaraTemporal__watch"
STATE_SCHEMA = "gaia2-temporal-state-v1"
# ARE's wait notification carries an integer scene timestamp while the
# authoritative TimeManager may be sampled with fractional precision.  A
# notification can therefore legitimately report an `areAfter` just below the
# controller's fractional `areBefore` even though the scene clock has
# advanced.  Only this sub-second precision mismatch is repairable; a larger
# regression remains a hard clock error.
SCENE_RECEIPT_RECONCILIATION_TOLERANCE = 1.0


class TemporalError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class TemporalNativeError(RuntimeError):
    """Only an explicit audited execution failure, never a Hook/protocol error."""
    def __init__(self, message: str, code: str = "native_error"):
        super().__init__(message)
        self.code = code


class TemporalInterrupt(RuntimeError):
    """An arrived user/stop signal prevented native execution after admission.

    The bridge may discover this immediately after a before_tool Host roundtrip.
    It must raise before calling ARE, rather than execute a stale wait/read.
    """
    def __init__(self, kind: str):
        if kind not in {"user_update", "environment_stop"}:
            raise TemporalError("interrupt_kind", "Only arrived user or environment stop may interrupt native execution")
        super().__init__(kind)
        self.kind = kind


def _clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def canonical_hash(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
        separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()


def native_hash(value: Any) -> str:
    """Exactly the bridge's stable native-result hash, not a projection hash."""
    return hashlib.sha256(json.dumps(value, default=str, sort_keys=True).encode()).hexdigest()


def tool_schema() -> dict[str, Any]:
    return {"type": "function", "function": {
        "name": TOOL_NAME,
        "description": (
            "Delegate repeated waits and the SAME admitted read-only query to the built-in "
            "ARE wait controller. Ordinary unchanged scans do not call the model. It wakes "
            "you on changed complete evidence, new user input, deadline, stop or a technical "
            "limit. goal is a description, NOT a semantic predicate executed by code. "
            "The runtime binds baselineRef=latest to a trusted identical previous query; "
            "use the exact available public tool name when aliases are duplicated; without "
            "a baseline it returns the initial observation immediately. Decide "
            "relevance yourself, and delegate again if more waiting is needed. No mail "
            "resend, cancellation or other business write is performed. until is an "
            "absolute ARE scene epoch timestamp, not wall time."),
        "parameters": {"type": "object", "properties": {
            "goal": {"type": "string", "minLength": 1},
            "queryTool": {"type": "string", "minLength": 1},
            "queryArguments": {"type": "object"},
            "baselineRef": {"type": "string", "default": "latest"},
            "intervalSeconds": {"type": "integer", "minimum": 1, "maximum": 3600, "default": 30},
            "maxScans": {"type": "integer", "minimum": 1, "maximum": 64, "default": 12},
            "until": {"type": "number", "minimum": 0,
                      "description": "Absolute ARE scene epoch deadline; optional."}},
            "required": ["goal", "queryTool", "queryArguments"],
            "additionalProperties": False}}}


def validate_arguments(arguments: Any) -> dict:
    """Pure pre-admission validation; it creates no state and calls no callback."""
    return TemporalController._arguments(arguments)


class TemporalController:
    """One execution/session's wait controller with durable exact-call replay.

    Native callbacks must run the normal ARE/Hook path.  notification_reader
    exposes only already-arrived notifications.  Unknown exceptions deliberately
    propagate: a source/Hook failure cannot be mislabeled as a native timeout.
    """
    def __init__(self, evidence_root: str | Path, execution_id: str, session_id: str,
                 clock: Callable[[], float], native_reader: Callable[[str, dict], dict],
                 native_waiter: Callable[[int], dict], notification_reader: Callable[[], dict],
                 commit: Callable[[dict], Any] | None = None):
        if not isinstance(execution_id, str) or not execution_id or not isinstance(session_id, str) or not session_id:
            raise TemporalError("identity", "Execution and session identities are required")
        self.execution_id, self.session_id = execution_id, session_id
        self.clock, self.native_reader = clock, native_reader
        self.native_waiter, self.notification_reader, self.commit = native_waiter, notification_reader, commit
        self.root = Path(evidence_root).absolute()
        self._no_symlink(self.root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.root = self.root.resolve()
        self.directory = self.root / canonical_hash([execution_id, session_id])[:24]
        self._no_symlink(self.directory)
        self.directory.mkdir(exist_ok=True)
        self.state_path = self.directory / "state.json"
        self._ledger = {"schemaVersion": "gaia2-temporal-ledger-v1",
            "executionId": execution_id, "sessionId": session_id, "state": None, "calls": {}}
        if self.state_path.exists():
            self._ledger = self._read_json(self.state_path)
            if (self._ledger.get("schemaVersion") != "gaia2-temporal-ledger-v1"
                    or self._ledger.get("executionId") != execution_id
                    or self._ledger.get("sessionId") != session_id
                    or not isinstance(self._ledger.get("calls"), dict)):
                raise TemporalError("identity", "Stored wait ledger identity is invalid")
        self._active_call: str | None = None

    @staticmethod
    def _no_symlink(path: Path) -> None:
        for candidate in (path, *path.parents):
            if candidate.is_symlink():
                raise TemporalError("source_path", "Symlink evidence paths are forbidden")

    def _read_json(self, path: Path) -> dict:
        self._no_symlink(path)
        if not path.resolve().is_relative_to(self.directory.resolve()):
            raise TemporalError("source_path", "Evidence must belong to this execution/session")
        result = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(result, dict):
            raise TemporalError("source_protocol", "Evidence is not an object")
        return result

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
        self._atomic(self.state_path, self._ledger)

    def _artifact(self, kind: str, body: dict) -> dict:
        state = self._ledger["state"]
        value = {"schemaVersion": "gaia2-temporal-evidence-v1", "kind": kind,
            "executionId": self.execution_id, "sessionId": self.session_id,
            "watchId": state["watchId"], "callId": self._active_call, **_clone(body)}
        path = self.directory / (state["watchId"] + "-" + kind + "-" + uuid.uuid4().hex + ".json")
        self._atomic(path, value)
        return {"path": path.relative_to(self.root).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}

    def _load_ref(self, ref: dict) -> dict:
        if not isinstance(ref, dict) or not isinstance(ref.get("path"), str):
            raise TemporalError("source_path", "Invalid issued evidence reference")
        relative = Path(ref["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise TemporalError("source_path", "Only issued relative evidence paths are accepted")
        path = self.root / relative
        value = self._read_json(path)
        if hashlib.sha256(path.read_bytes()).hexdigest() != ref.get("sha256"):
            raise TemporalError("source_hash", "Wait evidence was modified")
        if value.get("executionId") != self.execution_id or value.get("sessionId") != self.session_id:
            raise TemporalError("source_binding", "Wait evidence belongs to another session")
        return value

    def snapshot(self) -> dict | None:
        return _clone(self._ledger["state"])

    def _checkpoint(self, status: str) -> None:
        self._ledger["state"]["phase"] = status
        self._ledger["state"]["status"] = "signaled" if status == "signaled" else "running"
        self._save()
        if self.commit is not None:
            # Persisted inflight calls cannot automatically replay after an ACK failure.
            try:
                acknowledged = self.commit(self.snapshot())
            except TimeoutError as error:
                raise TemporalError("commit_failed", "Temporal Host acknowledgement timed out") from error
            if acknowledged is False:
                raise TemporalError("commit_failed", "Host did not acknowledge temporal state")

    @staticmethod
    def _finite(value: Any) -> bool:
        return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0

    def _scene(self) -> float:
        try:
            now = self.clock()
        except TimeoutError as error:
            raise TemporalError("clock_protocol", "ARE clock callback failed") from error
        state = self._ledger["state"]
        if not self._finite(now) or (state is not None and now < state["sceneNow"]):
            raise TemporalError("clock_error", "ARE scene time must be finite, nonnegative and nondecreasing")
        return float(now)

    @staticmethod
    def _arguments(arguments: Any) -> dict:
        keys = {"goal", "queryTool", "queryArguments", "baselineRef", "intervalSeconds", "maxScans", "until"}
        if not isinstance(arguments, dict) or set(arguments) - keys:
            raise TemporalError("arguments", "Unknown temporal argument")
        for name in ("goal", "queryTool"):
            if not isinstance(arguments.get(name), str) or not arguments[name].strip():
                raise TemporalError("arguments", name + " must be a nonempty string")
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*__[A-Za-z][A-Za-z0-9_]*", arguments["queryTool"]):
            raise TemporalError("arguments", "queryTool must be a canonical native tool name")
        if not isinstance(arguments.get("queryArguments"), dict):
            raise TemporalError("arguments", "queryArguments must be an object")
        answer = {"baselineRef": "latest", "intervalSeconds": 30, "maxScans": 12, **arguments}
        if not isinstance(answer["baselineRef"], str) or not answer["baselineRef"]:
            raise TemporalError("arguments", "baselineRef must identify an admitted native read")
        for name, maximum in (("intervalSeconds", 3600), ("maxScans", 64)):
            if type(answer[name]) is not int or not 1 <= answer[name] <= maximum:
                raise TemporalError("arguments", name + " is outside its integer bounds")
        if "until" in answer and not TemporalController._finite(answer["until"]):
            raise TemporalError("arguments", "until must be a finite nonnegative ARE epoch timestamp")
        try:
            return _clone(answer)
        except (TypeError, ValueError) as error:
            raise TemporalError("arguments", "Arguments must be finite JSON") from error

    @staticmethod
    def _observation(receipt: Any) -> dict:
        if not isinstance(receipt, dict) or "result" not in receipt:
            raise TemporalError("source_protocol", "Native reader must return its full audited receipt")
        for field in ("actionId", "canonicalName", "queryHash", "resultHash"):
            if not isinstance(receipt.get(field), str) or not receipt[field]:
                raise TemporalError("source_protocol", "Missing native " + field)
        for field in ("queryHash", "resultHash"):
            if not re.fullmatch(r"[0-9a-f]{64}", receipt[field]):
                raise TemporalError("source_protocol", "Invalid native " + field)
        if native_hash(receipt["result"]) != receipt["resultHash"]:
            raise TemporalError("source_hash", "Native result hash does not match visible evidence")
        if not TemporalController._finite(receipt.get("observedAt")):
            raise TemporalError("source_protocol", "Native observation timestamp is invalid")
        if type(receipt.get("complete")) is not bool or type(receipt.get("viewComplete")) is not bool:
            raise TemporalError("source_protocol", "Native completeness flags are required")
        return _clone(receipt)

    def _notifications(self) -> str | None:
        try:
            notice = self.notification_reader()
        except TimeoutError as error:
            raise TemporalError("notification_protocol", "Arrived notification callback failed") from error
        if (not isinstance(notice, dict) or type(notice.get("userChanged")) is not bool
                or type(notice.get("stopped")) is not bool
                or not isinstance(notice.get("notificationIds"), list)
                or any(not isinstance(item, str) for item in notice["notificationIds"])):
            raise TemporalError("notification_protocol", "Only trusted arrived notification identities are accepted")
        state = self._ledger["state"]
        ids = list(dict.fromkeys(state["notificationIds"] + notice["notificationIds"]))
        state["notificationIds"] = ids[-128:]
        if notice["stopped"]:
            return "environment_stop"
        if notice["userChanged"]:
            return "user_update"
        return None

    def _finish(self, signal: str, observation: dict | None = None, detail: str | None = None) -> dict:
        state = self._ledger["state"]
        state["signal"] = {"kind": signal, **({"detail": detail} if detail is not None else {})}
        self._checkpoint("signaled")
        result = {"schemaVersion": "gaia2-temporal-result-v1", "watchId": state["watchId"],
            "status": "signaled", "signal": _clone(state["signal"]),
            "technicalStop": signal in {"scan_budget", "native_error", "incomplete_observation", "clock_error", "environment_stop"},
            "taskOutcome": "undetermined", "state": self.snapshot(),
            "observation": _clone(observation), "evidenceRef": _clone(state["lastArtifactRef"])}
        reference = self._artifact("result", {"result": result})
        self._ledger["calls"][self._active_call]["resultRef"] = reference
        self._ledger["calls"][self._active_call]["status"] = "completed"
        self._save()
        return result

    def _finish_deadline(self) -> dict:
        """Close a declared scene-time deadline with one final read.

        A deadline is a lifecycle boundary, not business success.  When a
        watch has an admitted baseline, the final authoritative read supplies
        the evidence needed by a separate window-lifecycle Hook to distinguish
        an actually reviewed monitor window from a silent/unfinished one.
        The read remains ordinary native evidence and is never interpreted by
        this controller.
        """
        state = self._ledger["state"]
        observation = None
        if state.get("baselineHash") is not None:
            try:
                observation = self._read()
            except TemporalNativeError as error:
                state["lastArtifactRef"] = self._artifact("native-error", {
                    "errorType": type(error).__name__, "code": getattr(error, "code", "timeout")})
                return self._finish("native_error", detail=getattr(error, "code", "timeout"))
            except TemporalError as error:
                if error.code == "clock_error":
                    return self._finish("clock_error", detail=str(error))
                raise
        return self._finish("deadline", observation)

    def _read(self) -> dict:
        state = self._ledger["state"]
        self._checkpoint("scanning")
        try:
            native = self.native_reader(state["queryTool"], _clone(state["queryArguments"]))
        except TimeoutError as error:
            raise TemporalNativeError("Native read timed out", "timeout") from error
        receipt = self._observation(native)
        if receipt["canonicalName"] != state["queryTool"]:
            raise TemporalError("source_binding", "Native read returned a different canonical tool")
        state["scanCount"] += 1
        now = self._scene()
        if receipt["observedAt"] > now or receipt["observedAt"] < state["sceneNow"]:
            raise TemporalError("source_protocol", "Native read is outside its actual scene interval")
        state["sceneNow"] = now
        state["lastArtifactRef"] = self._artifact("scan", {"receipt": receipt})
        state["lastEvidenceRef"] = {key: receipt[key] for key in (
            "actionId", "canonicalName", "queryHash", "resultHash", "observedAt", "complete", "viewComplete")}
        self._checkpoint("observed")
        return receipt

    def run(self, arguments: dict, baseline: dict | None = None, user_ref: str | None = None,
            call_id: str | None = None) -> dict:
        args = self._arguments(arguments)
        if user_ref is not None and (not isinstance(user_ref, str) or not user_ref):
            raise TemporalError("user_ref", "A user reference must be trusted and nonempty")
        if call_id is None:
            call_id = "temporal-call-" + uuid.uuid4().hex
        if not isinstance(call_id, str) or not call_id or len(call_id) > 512:
            raise TemporalError("call_id", "A bounded nonempty call identity is required")
        trusted = None if baseline is None else self._observation(baseline)
        fingerprint = canonical_hash({"arguments": args, "baseline": trusted, "userRef": user_ref})
        old = self._ledger["calls"].get(call_id)
        if old is not None:
            if old.get("fingerprint") != fingerprint:
                raise TemporalError("call_reuse", "A call identity cannot be reused for a different watch")
            if old.get("status") != "completed":
                raise TemporalError("needs_reconcile", "An interrupted watch cannot secretly replay native calls")
            cached = self._load_ref(old["resultRef"])
            if cached.get("kind") != "result" or cached.get("callId") != call_id:
                raise TemporalError("source_binding", "Cached result belongs to another logical call")
            return _clone(cached["result"])
        if any(item.get("status") != "completed" for item in self._ledger["calls"].values()):
            raise TemporalError("needs_reconcile", "An interrupted watch requires explicit reconciliation")
        # Initial clock errors have no valid sceneStart and cannot manufacture state.
        now = self._scene()
        self._active_call = call_id
        self._ledger["state"] = {"schemaVersion": STATE_SCHEMA,
            "watchId": "watch-" + uuid.uuid4().hex, "executionId": self.execution_id,
            "sessionId": self.session_id, "userRef": user_ref, "goal": args["goal"], "enabled": True,
            "queryTool": args["queryTool"], "queryArguments": args["queryArguments"],
            "baselineRef": args["baselineRef"], "status": "running", "signal": None,
            "phase": "registered", "sceneStart": now, "sceneNow": now,
            "deadline": args.get("until"), "intervalSeconds": args["intervalSeconds"],
            "maxScans": args["maxScans"], "scanCount": 0, "waitCount": 0,
            "baselineHash": None if trusted is None else trusted["resultHash"],
            "lastEvidenceRef": None, "lastArtifactRef": None, "waitRefs": [],
            "notificationIds": []}
        self._ledger["calls"][call_id] = {"fingerprint": fingerprint, "status": "running"}
        self._checkpoint("registered")
        state = self._ledger["state"]
        try:
            signal = self._notifications()
            if signal:
                return self._finish(signal)
            if state["deadline"] is not None and state["sceneNow"] >= state["deadline"]:
                return self._finish_deadline()
            if trusted is not None:
                if trusted["canonicalName"] != args["queryTool"]:
                    raise TemporalError("source_binding", "Baseline is not from the admitted query tool")
                if trusted["observedAt"] > now:
                    raise TemporalError("source_protocol", "Baseline cannot be from future scene time")
                state["lastArtifactRef"] = self._artifact("baseline", {"receipt": trusted})
                state["lastEvidenceRef"] = {key: trusted[key] for key in (
                    "actionId", "canonicalName", "queryHash", "resultHash", "observedAt", "complete", "viewComplete")}
                self._checkpoint("baseline_bound")
                if not trusted["complete"] or not trusted["viewComplete"] or trusted.get("oldBlocker"):
                    return self._finish("incomplete_observation", trusted)
            else:
                initial = self._read()
                signal = self._notifications()
                if signal:
                    return self._finish(signal, initial)
                if not initial["complete"] or not initial["viewComplete"] or initial.get("oldBlocker"):
                    return self._finish("incomplete_observation", initial)
                return self._finish("initial_observation", initial)
            while state["scanCount"] < state["maxScans"]:
                state["sceneNow"] = self._scene()
                signal = self._notifications()
                if signal:
                    return self._finish(signal)
                remaining = None if state["deadline"] is None else state["deadline"] - state["sceneNow"]
                if remaining is not None and remaining <= 0:
                    return self._finish_deadline()
                seconds = state["intervalSeconds"]
                if remaining is not None:
                    # Official timeout is integer seconds. Never issue a zero-second
                    # busy loop or invent a subsecond scene-clock implementation.
                    if remaining < 1:
                        return self._finish("deadline_approaching", detail="deadline_resolution_below_one_second")
                    seconds = min(seconds, int(remaining))
                before = state["sceneNow"]
                self._checkpoint("waiting")
                try:
                    waited = self.native_waiter(seconds)
                except TimeoutError as error:
                    raise TemporalNativeError("Native wait timed out", "timeout") from error
                if not isinstance(waited, dict) or not isinstance(waited.get("actionId"), str) or not waited["actionId"]:
                    raise TemporalError("source_protocol", "Native wait must return its audited action identity")
                start, end = waited.get("areBefore"), waited.get("areAfter")
                now = self._scene()
                if (not self._finite(start) or not self._finite(end)
                        or start < before or end > now):
                    return self._finish("clock_error", detail="invalid_native_wait_scene_receipt")
                reconciled = False
                raw_end = end
                if end < start:
                    # The official wait may return an integer notification
                    # timestamp that is a fraction of a second older than the
                    # controller sample taken immediately before dispatch.
                    # Re-read the authoritative ARE clock instead of turning
                    # that precision mismatch into cancellation.  A material
                    # regression remains fail-closed.
                    if (start - end) >= SCENE_RECEIPT_RECONCILIATION_TOLERANCE or now <= before:
                        return self._finish("clock_error", detail="invalid_native_wait_scene_receipt")
                    end = now
                    reconciled = True
                    waited = {**waited, "areAfter": end,
                              "rawAreAfter": raw_end,
                              "sceneReceiptReconciled": True}
                state["sceneNow"] = now
                state["waitCount"] += 1
                source_ref = self._artifact("wait", {"requestedSeconds": seconds, "receipt": waited,
                                                       "sceneReceiptReconciled": reconciled})
                required_wait_fields = ("actionId", "canonicalName", "queryHash", "resultHash", "observedAt")
                if any(key not in waited for key in required_wait_fields):
                    raise TemporalError("source_protocol", "Native wait receipt is missing its observation identity")
                if (waited["canonicalName"] != "SystemApp__wait_for_notification"
                        or any(not isinstance(waited[key], str) or not re.fullmatch(r"[0-9a-f]{64}", waited[key])
                               for key in ("queryHash", "resultHash"))
                        or not self._finite(waited["observedAt"])
                        # A reconciled receipt may carry an integer
                        # ``observedAt``/``areAfter`` fractionally below the
                        # sampled ``areBefore``.  Validate it against the
                        # authoritative reconciled interval while preserving
                        # the raw values in the evidence artifact.
                        or not (min(start, now) if reconciled else start)
                           <= waited["observedAt"] <= now
                        or waited.get("complete") is not True or waited.get("viewComplete") is not True):
                    raise TemporalError("source_protocol", "Native wait is not a complete audited official wait")
                state["waitRefs"].append({**{key: waited[key] for key in required_wait_fields}, "sourceRef": source_ref})
                state["waitRefs"] = state["waitRefs"][-64:]
                self._checkpoint("wait_returned")
                signal = self._notifications()
                if signal:
                    return self._finish(signal)
                if state["deadline"] is not None and now >= state["deadline"]:
                    return self._finish_deadline()
                observed = self._read()
                if observed["queryHash"] != trusted["queryHash"]:
                    raise TemporalError("source_binding", "Poll changed the admitted baseline query")
                signal = self._notifications()
                if signal:
                    return self._finish(signal, observed)
                if not observed["complete"] or not observed["viewComplete"] or observed.get("oldBlocker"):
                    return self._finish("incomplete_observation", observed)
                if observed["resultHash"] != state["baselineHash"]:
                    return self._finish("candidate_changed", observed)
                # No semantic interpretation, no LLM return, and no new baseline.
                self._checkpoint("unchanged")
            return self._finish("scan_budget", observed)
        except TemporalInterrupt as interrupted:
            # The bridge's post-ACK arrival fence did not execute a native action.
            # Do not invent an observation, failure receipt, scan or wait count.
            return self._finish(interrupted.kind)
        except TemporalNativeError as error:
            state["lastArtifactRef"] = self._artifact("native-error", {
                "errorType": type(error).__name__, "code": getattr(error, "code", "timeout")})
            return self._finish("native_error", detail=getattr(error, "code", "timeout"))
        except TemporalError as error:
            if error.code == "clock_error":
                return self._finish("clock_error", detail=str(error))
            raise
