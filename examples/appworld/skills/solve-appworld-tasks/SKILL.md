---
name: solve-appworld-tasks
description: Solve stateful AppWorld benchmark tasks through API discovery, authenticated application calls, state verification, and Supervisor completion. Use when the current task runs in an AppWorld environment or requires operating its simulated apps through the appworld_execute project tool.
---

# Solve AppWorld Tasks

## Workflow

1. Search the resource catalog for `AppWorld` and load the returned execution tool and this Skill.
2. Use the pre-bound `apis` object directly; never import it or inspect Python internals.
3. Call API-document helpers with keyword arguments. Use
   `show_api_descriptions(app_name="...")` to list one app and
   `show_api_doc(app_name="...", api_name="...")` for an exact signature.
4. Inspect only the relevant API descriptions and exact API documents. Combine related read-only
   documentation calls into one execution when practical.
5. Obtain account credentials through the Supervisor API when authentication is required.
6. Call the minimum application APIs needed to satisfy the instruction.
7. Read the affected state back and confirm the requested values.
8. Call `apis.supervisor.complete_task()` for action tasks or `apis.supervisor.complete_task(answer=value)` for information tasks.
9. Finish only after `appworld_execute` returns `completed: true`.

## Reconstructing collection changes

When a task describes changes in messages, notes, or search results, first build the complete
desired collection from all relevant pages. Paginate explicitly until the source is exhausted,
resolve every title to a stable ID, and write down the desired ID set before mutating. Read the
current collection, compute exact `to_add` and `to_remove` sets, apply only those deltas, then read
the collection again and compare the full stable-ID set. Repair any remaining delta and do not
complete the task while a requested add or removal is missing, even if the mutation response says
success.

## Constraints

- Treat each execution result as authoritative and preserve state across calls.
- Never inspect task databases, host files, evaluator code, ground truth, or private metadata.
- Never invent API names or parameters; inspect their documentation first.
- Treat `show_api_doc` and other API-document helper parameters as keyword-only.
- Avoid broad listings when a filtered API is available.
- Do not retry a mutating call until its resulting state has been checked.
- Keep printed output narrow enough to remain useful in context.

Read [the API workflow reference](references/api-workflow.md) when API discovery, login, or completion semantics are unclear.
