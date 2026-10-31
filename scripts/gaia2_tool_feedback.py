"""Bounded native-error diagnostics, never a repair or retry authority.

Only errors raised by the pinned ARE 1.2.0 implementation can prove a specific
pre-effect rejection. Exception names, model-supplied text and caller hints are
not that proof. Unmapped exceptions never establish that a write had no effect.
Raw error messages, argument values and host paths are not returned to the Actor.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import re
from typing import Any


_APPS = Path(__file__).resolve().parents[1] / ".official-python/are/simulation/apps"
_PINS = {
    "calendar.py": "62ffa557068dd1e5983758f8f25423cb6e81a48f4191edace98a2e0173881c7c",
    "contacts.py": "188862e4ba05bf06895321399c2dd1e54ef9a29fe9dc2573679abb98e5bcf47f",
    "email_client.py": "0da4b444925cef30e6945bff6c0d135d23fddc1c9c54c208acf889d606f24a57",
    "sandbox_file_system.py": "c0c39d09c4d67c3875d978558cc79a5bbe9aeb0611917afa09f9d64115ea7ae4",
    # Pagination and message-validation diagnostics are source-pinned just
    # like the existing resource-not-found diagnostics.  A matching exception
    # string without the official raising frame is never enough to claim a
    # pre-effect rejection.
    "messaging.py": "e384b05c23b9303a08e0099bd62949fe30230c5aca5e921971f38063bdbc10fd",
    "messaging_v2.py": "e28b815b4b5f61d786b610d962158d4928fff6fa4e9be3897167855be8b63b34",
}


def _pinned_frames(error: BaseException, filename: str, method: str) -> list:
    """Bind the actual raising stack to the official file and called method."""
    path = _APPS / filename
    try:
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != _PINS[filename]:
            return []
        expected = path.resolve()
        frames = []
        cursor = error.__traceback__
        while cursor is not None:
            frame = cursor.tb_frame
            if (Path(frame.f_code.co_filename).resolve() == expected
                    and frame.f_globals.get("__name__") == "are.simulation.apps." + filename[:-3]):
                frames.append(frame)
            cursor = cursor.tb_next
        return frames if any(frame.f_code.co_name == method for frame in frames) else []
    except (OSError, ValueError, RuntimeError):
        return []


def _identifier(value: Any, pattern: str) -> str | None:
    return value if type(value) is str and re.fullmatch(pattern, value) else None


def native_error_feedback(action: dict, error: BaseException, *, status: str,
                          deterministic: bool) -> dict:
    """Return safe diagnostics and an evidence-based no-effect classification.

    ``status`` and ``deterministic`` are compatibility hints, not authority.
    The caller retains the actual ``executed`` flag (a native call did occur),
    and may classify this call as a pre-effect rejection only when
    ``effectApplied is False``. This helper never resolves historical unknown
    writes, changes IDs, dispatches a read, or performs an automatic retry.
    """
    action = action if type(action) is dict else {}
    canonical = _identifier(action.get("canonicalName"), r"[A-Za-z][A-Za-z0-9_]{0,80}__[A-Za-z][A-Za-z0-9_]{0,100}")
    resource = _identifier(action.get("resourceKey"), r"[A-Za-z][A-Za-z0-9_.:-]{0,120}")
    exception_type = _identifier(type(error).__name__, r"[A-Za-z][A-Za-z0-9_]{0,79}") or "NativeError"
    result = {"errorType": exception_type, "error_code": "native_error", "tool": canonical,
              "resource": resource, "argument_name": None, "effectApplied": "unknown",
              "feedback": "The native call failed. Its effect is not established by the exception type. Inspect the actual result and authoritative state as needed; do not blindly replay an unknown write."}
    if canonical is None or type(error.args) is not tuple or len(error.args) != 1 or type(error.args[0]) is not str:
        return result
    owner, method = canonical.split("__", 1)
    arguments = action.get("arguments") if type(action.get("arguments")) is dict else {}
    message = error.args[0]
    code, argument, hint = None, None, None

    if owner in {"Calendar", "CalendarApp"} and method in {"get_calendar_event", "delete_calendar_event"}:
        event_id = arguments.get("event_id")
        if (type(error) is ValueError and type(event_id) is str
                and message == f"Calendar Event with id {event_id} does not exist."
                and _pinned_frames(error, "calendar.py", method)):
            code, argument = "calendar_event_not_found", "event_id"
            hint = "The supplied event_id does not exist in this Calendar. No calendar event was deleted or changed by this call. Check the exact identifier from a native Calendar result; do not guess a replacement ID."

    elif owner in {"Contacts", "ContactsApp", "InternalContacts"} and method in {"get_contact", "edit_contact", "delete_contact"}:
        contact_id = arguments.get("contact_id")
        expected = f"Contact {contact_id} does not exist." if method == "get_contact" else "Contact does not exist."
        if (type(error) is KeyError and type(contact_id) is str and message == expected
                and _pinned_frames(error, "contacts.py", method)):
            code, argument = "contact_not_found", "contact_id"
            hint = "The supplied contact_id does not exist in this Contacts app. No contact was created, changed or deleted by this call. Check the exact identifier from the same app's native result; do not guess a replacement ID."

    elif owner in {"EmailClientV2", "EmailClientApp"} and method in {"get_email_by_id", "reply_to_email", "forward_email", "move_email", "delete_email"}:
        email_id = arguments.get("email_id")
        frames = _pinned_frames(error, "email_client.py", method)
        if (type(error) is ValueError and type(email_id) is str
                and message == f"Email with id {email_id} does not exist" and frames):
            code, argument = "email_not_found", "email_id"
            hint = "The supplied email_id was not found in the selected folder. This call did not send, move or delete an email. Verify the exact ID and folder with the same native email app; do not infer that all mail is absent."
        elif (type(error) is ValueError and method != "move_email" and frames
              and type(arguments.get("folder_name", "INBOX")) is str
              and message == f"Folder {arguments.get('folder_name', 'INBOX')} not found"):
            code, argument = "email_folder_not_found", "folder_name"
            hint = "The selected email folder is unavailable in this app. This call did not send, move or delete an email. Check the native folder name; this is not a file-system path error."

    elif owner in {"MessagingAppV2", "MessagingApp"} and method in {
            "list_recent_conversations", "list_conversations_by_participant"}:
        frames = (_pinned_frames(error, "messaging_v2.py", method)
                  or _pinned_frames(error, "messaging.py", method))
        # The official apps expose two independently bounded pagination
        # parameters.  Read the bounded value from the pinned native message,
        # but bind the argument name to the model's actual call.
        match = re.fullmatch(
            r"Limit must be smaller than the view limit of ([0-9]+) - Please use a smaller limit and use offset to navigate",
            message,
        )
        arguments = arguments if type(arguments) is dict else {}
        if match and frames:
            bound = int(match.group(1))
            if (type(arguments.get("limit")) is int and arguments["limit"] > bound):
                code, argument = "pagination_limit_exceeded", "limit"
            elif (type(arguments.get("limit_recent_messages_per_conversation")) is int
                  and arguments["limit_recent_messages_per_conversation"] > bound):
                code, argument = "pagination_messages_limit_exceeded", "limit_recent_messages_per_conversation"
            if code is not None:
                result.update(
                    error_code=code,
                    argument_name=argument,
                    effectApplied=False,
                    constraint={"operator": "less_equal", "value": bound},
                    feedback=(f"The {argument} argument exceeds the native view limit of {bound}. "
                              "Use a smaller limit and advance with offset; no business mutation was performed."),
                )
                return result

    elif owner in {"EmailClientV2", "EmailClientApp"} and method == "send_email":
        frames = _pinned_frames(error, "email_client.py", method)
        arguments = arguments if type(arguments) is dict else {}
        message_is_validation = (
            type(error) is ValueError and message.startswith("Invalid email address: ")
        )
        if frames and message_is_validation:
            recipients = arguments.get("recipients")
            cc = arguments.get("cc")
            invalid_recipient = (next((index for index, value in enumerate(recipients)
                                       if type(value) is not str or "@" not in value), None)
                                 if type(recipients) is list else None)
            invalid_cc = (next((index for index, value in enumerate(cc)
                                if type(value) is not str or "@" not in value), None)
                          if type(cc) is list else None)
            if invalid_recipient is not None:
                result.update(
                    error_code="invalid_email_recipient",
                    argument_name=f"recipients[{invalid_recipient}]",
                    effectApplied=False,
                    constraint={"operator": "email_address"},
                    feedback=("The recipients argument contains an invalid email address. "
                              "Correct that recipient before calling send_email again; the message was rejected before it was added to SENT."),
                )
                return result
            if invalid_cc is not None:
                result.update(
                    error_code="invalid_email_cc",
                    argument_name=f"cc[{invalid_cc}]",
                    effectApplied=False,
                    constraint={"operator": "email_address"},
                    feedback=("The cc argument contains an invalid email address. "
                              "Correct that address before calling send_email again; the message was rejected before it was added to SENT."),
                )
                return result

    elif owner in {"SandboxLocalFileSystem", "Files"} and method in {
            "open", "cat", "mkdir", "makedirs", "mv", "ls", "rm", "rmdir", "exists", "display", "info", "tree", "read_document"}:
        frames = _pinned_frames(error, "sandbox_file_system.py", method)
        validation = next((frame for frame in reversed(frames) if frame.f_code.co_name == "_validate_path"), None)
        if (type(error) is PermissionError and validation is not None
                and message.startswith("Operation not allowed outside sandbox: ")):
            raw_path = validation.f_locals.get("path")
            fields = [field for field in ("path", "path1", "path2", "file_path") if field in arguments and arguments[field] == raw_path]
            code, argument = "sandbox_path_rejected", fields[0] if len(fields) == 1 else None
            hint = "The file path was rejected by the native sandbox boundary before the file operation. Use a path inside the configured sandbox and inspect native file results; do not substitute a host path."

    if code is not None:
        result.update(error_code=code, argument_name=argument, effectApplied=False, feedback=hint)
    return result
