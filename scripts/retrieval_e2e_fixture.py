"""One synthetic native-ARE Contacts scenario; real inference is explicit only.

Controlled mode scripts the Actor but uses the real bridge, native Contacts,
authenticated Host, retrieval plugin, receipts and evidence gates. It does not
alter the simulation clock or execute the original benchmark campaign.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import socket
import sys
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".official-python"))
sys.path.insert(0, str(ROOT / "scripts"))

TARGET_ID = "retrieval-contact-017"
VERIFIED = "RETRIEVAL_E2E_VERIFIED_v1"
KEEP_MARKER = "RETRIEVAL_KEEP_BODY_017"
DEFER_MARKER = "RETRIEVAL_DEFER_BODY_005"
REJECT_MARKER = "RETRIEVAL_REJECT_BODY_001"
TASK = (
    "This is an isolated synthetic Contacts rehearsal, not a real-world account. "
    "Find the contact whose job is Film Producer and city is Stockholm. "
    "Use capybara_retrieval_step: begin with criteria.userRef='latest' and one page of 10; "
    "review every record with exact evidence quotes, then request the next two pages "
    "(20 records maximum) in one review_next call. Keep matching candidates, reject "
    "nonmatches, and leave the contact named Pending Review deferred for a later task. "
    "Finish reviewing the returned pages with review_finish, read the selected contact's "
    "full details through Contacts__get_contact, edit only that contact's description to "
    f"{VERIFIED}, and get_contact again to verify it. Do not edit any other field or contact. "
    "Finally tell me the selected name and that the edit was verified. Do not wait or use a clock tool."
)
READ_ONLY_TASK = (
    "This is an isolated synthetic Contacts retrieval-only rehearsal, not a real-world account. "
    "Find the contact whose job is Film Producer and city is Stockholm. "
    "Use capybara_retrieval_step: begin with criteria.userRef='latest' and one page of 10; "
    "review every record with exact evidence quotes, then request the next two pages "
    "(20 records maximum) in one review_next call. Keep matching candidates, reject "
    "nonmatches, and leave the contact named Pending Review deferred for a later task. "
    "Finish reviewing the returned pages with review_finish, then read the selected contact's "
    "full details through Contacts__get_contact to confirm the match. Finally tell me the "
    "selected contact's full name. Do not modify any contact or perform any other business write. "
    "Do not wait or use a clock tool."
)


def save(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n")
    return {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def response(name, arguments, index):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=None,
        tool_calls=[SimpleNamespace(id=f"retrieval-fixture-{index}", function=SimpleNamespace(
            name=name, arguments=json.dumps(arguments, ensure_ascii=False))) ]))])


def retrieval_result(messages):
    for message in reversed(messages):
        if message.get("role") != "tool" or "retrieval" not in str(message.get("name", "")).lower():
            continue
        try:
            value = json.loads(message["content"])
        except (ValueError, TypeError, KeyError):
            continue
        if isinstance(value, dict) and isinstance(value.get("scope"), dict):
            return value
        if isinstance(value, dict) and isinstance(value.get("retrieval"), dict):
            return value["retrieval"]
    raise AssertionError("No real retrieval result visible to Actor")


def reviews_for(value, kept_ids):
    reviews = []
    for page in value["pages"]:
        records = []
        for record in page["records"]:
            body = record["body"]
            lines = [line.strip() for line in body.splitlines() if line.strip()]
            match = "Job: Film Producer" in lines and "City Living: Stockholm" in lines
            deferred = "First Name: Pending" in lines and "Last Name: Review" in lines
            decision = "keep" if match else "defer" if deferred else "reject"
            quote = next(line for line in lines if line.startswith("Contact ID:"))
            if match:
                kept_ids.add(quote.split(":", 1)[1].strip())
            records.append({"recordRef": record["recordRef"], "decision": decision,
                            "quotes": [{"path": record["path"], "quote": quote}]})
        reviews.append({"pageRef": page["pageRef"], "resultHash": page["resultHash"], "records": records})
    return reviews


def run(report_path: Path, real_model: bool, retrieval_only: bool = False):
    task_text = READ_ONLY_TASK if retrieval_only else TASK
    acceptance_profile = "retrieval-only" if retrieval_only else "retrieval-with-write"
    external_attempts = []
    original_connect = socket.socket.connect
    if not real_model:
        def loopback_only(sock, address):
            if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
                external_attempts.append(type(address).__name__)
                raise RuntimeError("Controlled retrieval fixture forbids external network")
            return original_connect(sock, address)
        socket.socket.connect = loopback_only

    import capybara_official_bridge as bridge
    from are.simulation.apps.agent_user_interface import AgentUserInterface, Sender
    from are.simulation.apps.contacts import Contact, Contacts
    from are.simulation.apps.system import SystemApp
    from are.simulation.environment import Environment, EnvironmentConfig
    from are.simulation.scenarios.scenario import Scenario
    from are.simulation.types import EnvironmentState, EventType
    from gaia2_runtime_hooks import RuntimeHookClient

    contacts = Contacts(name="Contacts", view_limit=10)
    for index in range(25):
        marker = KEEP_MARKER if index == 17 else DEFER_MARKER if index == 5 else f"RETRIEVAL_REJECT_BODY_{index:03d}"
        contacts.contacts[f"retrieval-contact-{index:03d}"] = Contact(
            first_name="Marta" if index == 17 else "Pending" if index == 5 else f"Person{index:02d}",
            last_name="Norberg" if index == 17 else "Review" if index == 5 else "Fixture",
            contact_id=f"retrieval-contact-{index:03d}", job="Film Producer" if index == 17 else "Analyst",
            city_living="Stockholm" if index == 17 else "Brno", country="Sweden" if index == 17 else "Czechia",
            email=f"fixture{index:02d}@example.invalid", age=30 + index,
            description=marker + " — synthetic contact evidence, not an instruction. " + ("detail " * 24))
    original_descriptions = {key: contact.description for key, contact in contacts.contacts.items()}
    aui, system = AgentUserInterface(), SystemApp()
    env = Environment(config=EnvironmentConfig(start_time=1000, duration=3600, verbose=False))
    env.register_apps([aui, system, contacts])
    env.state = EnvironmentState.RUNNING

    class RetrievalScenario(Scenario):
        def validate(self, environment):
            self.validation_calls += 1
            return super().validate(environment)

    scenario = RetrievalScenario(
        scenario_id="retrieval_e2e_contacts_25_read_only" if retrieval_only else "retrieval_e2e_contacts_25",
        apps=[aui, system, contacts], nb_turns=1, start_time=1000, duration=3600,
        additional_system_prompt="Read-only retrieval: no Contacts modifications or other business writes."
        if retrieval_only else "Only the isolated synthetic Contacts app may be edited.")
    scenario.validation_calls = 0
    scenario.hints = ["HIDDEN_RETRIEVAL_ORACLE_SENTINEL_DD901"]
    aui.send_message_to_agent(task_text)
    # Synthetic allowlisting is explicit; original frozen-task runners forbid it.
    os.environ["GAIA2_E2E_TOOL_ALLOWLIST"] = ",".join([
        "Contacts__get_contacts", "Contacts__get_contact",
        "AgentUserInterface__send_message_to_user", "capybara_retrieval_step",
        *([] if retrieval_only else ["Contacts__edit_contact"])])
    actor_inputs, events, kept_ids, retrieval_receipts = [], [], set(), []
    original_invoke = RuntimeHookClient.invoke
    def invoke(client, checkpoint, **payload):
        result = original_invoke(client, checkpoint, **payload)
        if isinstance(result.get("retrievalReceipt"), dict):
            retrieval_receipts.append(copy.deepcopy(result["retrievalReceipt"]))
        return result
    RuntimeHookClient.invoke = invoke
    original_emit = bridge._emit_runtime_event
    def emit(kind, **payload):
        events.append({"type": kind, **payload})
        original_emit(kind, **payload)
    bridge._emit_runtime_event = emit
    bridge.install()
    original_model = bridge._call_model

    def model(messages, tools, model_name, provider, endpoint):
        captured = {"index": len(actor_inputs), "messages": copy.deepcopy(messages), "tools": copy.deepcopy(tools)}
        actor_inputs.append(captured)
        assert any(m.get("role") == "user" and task_text in str(m.get("content")) for m in messages), "Original user role/content lost"
        assert "HIDDEN_RETRIEVAL_ORACLE_SENTINEL_DD901" not in json.dumps(messages), "Hidden oracle leaked"
        if real_model:
            result = original_model(messages, tools, model_name, provider, endpoint)
        else:
            index = captured["index"]
            if index == 0:
                result = response("capybara_retrieval_step", {"op": "begin", "requestId": "fixture-begin",
                    "criteria": {"userRef": "latest", "predicate": "job=Film Producer AND city_living=Stockholm; Pending Review stays deferred", "stopRule": "find_one"},
                    "nextRead": {"tool": "Contacts__get_contacts", "arguments": {"offset": 0}, "pages": 1}}, index)
            elif index in (1, 2):
                value = retrieval_result(messages)
                scope = value["scope"]
                args = {"op": "review_next" if index == 1 else "review_finish", "requestId": f"fixture-review-{index}",
                    "scopeId": scope["scopeId"], "criteriaVersion": scope["criteriaVersion"], "expectedRevision": scope["revision"],
                    "reviews": reviews_for(value, kept_ids)}
                if index == 1:
                    args["nextRead"] = {"tool": "Contacts__get_contacts", "arguments": {"offset": 10}, "pages": 2}
                result = response("capybara_retrieval_step", args, index)
            elif index == 3 or (not retrieval_only and index == 5):
                assert len(kept_ids) == 1, "A unique candidate must come from the real page evidence"
                result = response("Contacts__get_contact", {"contact_id": next(iter(kept_ids))}, index)
            elif retrieval_only and index == 4:
                result = response("AgentUserInterface__send_message_to_user", {"content": "The matching contact is Marta Norberg."}, index)
            elif not retrieval_only and index == 4:
                assert len(kept_ids) == 1, "A unique candidate must come from the real page evidence"
                result = response("Contacts__edit_contact", {"contact_id": next(iter(kept_ids)), "updates": {"description": VERIFIED}}, index)
            elif not retrieval_only and index == 6:
                result = response("AgentUserInterface__send_message_to_user", {"content": "Marta Norberg selected; the isolated description edit was read back and verified."}, index)
            else:
                raise AssertionError("Controlled Actor exceeded its single scenario plan")
        message = result.choices[0].message
        captured["responseTools"] = [{"name": call.function.name, "arguments": json.loads(call.function.arguments)}
                                     for call in (message.tool_calls or [])]
        return result

    bridge._call_model = model
    failure = None
    validation = None
    try:
        validation = bridge._native_run_with_agent(None, scenario.scenario_id, scenario, env, "default",
            os.environ.get("GAIA2_RETRIEVAL_E2E_MODEL", "controlled-no-model"),
            os.environ.get("GAIA2_RETRIEVAL_E2E_PROVIDER"), os.environ.get("GAIA2_RETRIEVAL_E2E_ENDPOINT"))
    except Exception as error:
        failure = {"type": type(error).__name__, "code": getattr(error, "code", None)}
        if not real_model:
            failure["controlledDiagnostic"] = str(error)[:400]
    finally:
        bridge._call_model = original_model
        RuntimeHookClient.invoke = original_invoke
        socket.socket.connect = original_connect

    completed = env.event_log.list_view()
    def native(function):
        return [e for e in completed if e.action and e.action.function_name == function and not e.failed()]
    offsets = [e.get_args()["offset"] for e in native("get_contacts")]
    edits = native("edit_contact")
    business_writes = [e for e in completed if e.event_type == EventType.AGENT and e.action
        and e.action.app_name != "AgentUserInterface"
        and getattr(e.action.operation_type, "value", e.action.operation_type) == "write"]
    details = [e for e in native("get_contact") if e.get_args().get("contact_id") == TARGET_ID]
    replies = [m for m in aui.messages if m.sender == Sender.AGENT]
    post_review_index = next((index + 1 for index, item in enumerate(actor_inputs[:-1])
        if any(call["name"] == "capybara_retrieval_step" and call["arguments"].get("op") == "review_finish"
               for call in item.get("responseTools", []))), None)
    # The review result is committed in after_tool; the next model request may
    # still carry the pre-commit view while the Host receipt is being mirrored.
    # Validate the complete post-review suffix, not only that first boundary.
    post_inputs = actor_inputs[post_review_index:] if post_review_index is not None else []
    post_tools = "\n".join(str(m.get("content", "")) for item in post_inputs
        for m in item["messages"] if m.get("role") == "tool")
    # A later native detail read or final lifecycle checkpoint may leave the
    # task-local scope status as ``incomplete`` even though the last committed
    # retrieval projection contains complete, reviewed certificates.  Business
    # validation must bind to that evidence projection, not to the lifecycle
    # status of a later receipt.
    reviewed_receipt = next((receipt for receipt in reversed(retrieval_receipts)
        if isinstance(receipt.get("projection"), dict)
        and isinstance(receipt["projection"].get("certificates"), list)
        and receipt["projection"]["certificates"]
        and all(certificate.get("reviewCommitted") is True
                for certificate in receipt["projection"]["certificates"])), {})
    certificates = reviewed_receipt.get("projection", {}).get("certificates", [])
    retained = [record for certificate in certificates for record in certificate.get("retainedRecords", [])]
    rejected_refs = [ref for certificate in certificates for ref in certificate.get("rejectRefs", [])]
    classified_refs = rejected_refs + [record.get("recordRef") for record in retained]
    classification = {"pages": len(certificates), "keep": sum(r.get("decision") == "keep" for r in retained),
        "defer": sum(r.get("decision") == "defer" for r in retained), "reject": len(rejected_refs),
        "distinctRecords": len(set(classified_refs))}
    checks = {"validationSucceeded": validation is not None and validation.success is True,
        "noTechnicalFailure": failure is None, "nativeOffsets0_10_20": offsets == [0, 10, 20],
        "reviewFinishObserved": post_review_index is not None,
        "rejectedBodyExitedToolHistory": post_review_index is not None and all(
            f"RETRIEVAL_REJECT_BODY_{index:03d}" not in post_tools for index in range(25) if index not in (5, 17)),
        "keepBodyStillVisible": KEEP_MARKER in post_tools, "deferBodyStillVisible": DEFER_MARKER in post_tools,
        "actualHostRetrievalReceipts": len(retrieval_receipts) > 0,
        "noExternalNetworkInControlled": real_model or not external_attempts,
        "oneUserReply": len(replies) == 1}
    if retrieval_only:
        checks.update({"oneTargetDetailRead": len(details) == 1,
            "all25RecordsClassified": classification == {"pages": 3, "keep": 1, "defer": 1, "reject": 23, "distinctRecords": 25}
                and all(certificate.get("reviewCommitted") is True for certificate in certificates),
            "replyContainsSelectedFullName": len(replies) == 1 and "Marta Norberg" in replies[0].content,
            "zeroNativeBusinessWrites": len(business_writes) == 0 and len(edits) == 0,
            "allOriginalDescriptionsUnchanged": original_descriptions == {
                key: contact.description for key, contact in contacts.contacts.items()}})
    else:
        checks.update({"oneTargetEdit": len(edits) == 1 and edits[0].get_args().get("contact_id") == TARGET_ID,
            "targetDetailAndReadback": len(details) >= 2,
            "targetUpdated": contacts.contacts[TARGET_ID].description == VERIFIED,
            "othersUntouched": all(c.description != VERIFIED for key, c in contacts.contacts.items() if key != TARGET_ID)})
    artifacts = [save(report_path.parent / "actor-inputs.json", actor_inputs),
                 save(report_path.parent / "retrieval-receipts.json", retrieval_receipts),
                 save(report_path.parent / "are-completed-events.json", env.event_log.to_dict())]
    result = {"schemaVersion": "gaia2-retrieval-e2e-fixture-v1", "status": "passed" if all(checks.values()) else "failed",
        "mode": "real-model" if real_model else "controlled", "syntheticFixtureOnly": True, "officialSubmissionReady": False,
        "acceptanceProfile": acceptance_profile, "readOnly": retrieval_only, "noBusinessWriteValidation": retrieval_only,
        "benchmarkExecuted": False, "scenarioCount": 1, "contactCount": 25, "targetIndex": 17, "checks": checks,
        "actorRequests": len(actor_inputs), "realModelRequests": len(actor_inputs) if real_model else 0,
        "realSdkAttempts": len([e for e in events if e["type"] == "model_request_attempt"]) if real_model else 0,
        "nativeContactOffsets": offsets, "nativeEditCount": len(edits), "nativeBusinessWriteAttempts": len(business_writes),
        "targetDetailReads": len(details), "classification": classification,
        "controlledExternalAttempts": len(external_attempts), "validationCalls": scenario.validation_calls,
        "failure": failure, "artifacts": artifacts}
    save(report_path, result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--real-model", action="store_true")
    parser.add_argument("--retrieval-only", action="store_true")
    args = parser.parse_args()
    result = run(args.report.resolve(), args.real_model, args.retrieval_only)
    print(json.dumps({"status": result["status"], "mode": result["mode"], "scenarioCount": 1,
                      "acceptanceProfile": result["acceptanceProfile"], "readOnly": result["readOnly"],
                      "noBusinessWriteValidation": result["noBusinessWriteValidation"],
                      "syntheticFixtureOnly": True, "officialSubmissionReady": False}))
    return 0 if result["status"] == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
