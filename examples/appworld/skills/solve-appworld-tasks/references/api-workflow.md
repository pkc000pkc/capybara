# AppWorld API Workflow

Use these calls only through `appworld_execute`.

The execution environment already defines `apis`. Do not use `import apis`, `from apis import ...`,
`.__doc__`, or other Python introspection.

## Discover

```python
print(apis.api_docs.show_app_descriptions())
print(apis.api_docs.show_api_descriptions(app_name="supervisor"))
print(apis.api_docs.show_api_doc(app_name="supervisor", api_name="show_account_passwords"))
```

All API-document helper arguments are keyword-only. Related documentation calls may be placed in
the same `appworld_execute` block to avoid unnecessary model rounds.

Inspect the descriptions for the one or two apps implied by the task. Then inspect the exact API document before calling an unfamiliar API.

## Authenticate

Use the Supervisor's documented account-password API to obtain the task user's credentials. Call each app's documented login API and retain the returned access token in the stateful Python environment.

## Act And Verify

Call APIs through `apis.<app_name>.<api_name>(**parameters)`. After a mutation, call a read API that proves the requested state and check identifiers, quantities, recipients, dates, and status values.

For collection or playlist updates, treat messages and notes as a paginated source of truth. Read
all pages, extract every requested item, resolve names to stable IDs, and calculate the exact
desired-ID set before writing. Compare it with the current set (`to_add = desired - current`,
`to_remove = current - desired`), apply only those deltas, then re-read and compare the complete
set. Repair until the sets are identical; counts or mutation success messages alone are not proof.

## Complete

For action-only tasks:

```python
apis.supervisor.complete_task()
```

For tasks asking for information:

```python
apis.supervisor.complete_task(answer=answer_value)
```

The surrounding tool result must report `completed: true` before the Agent returns a completed Loop status.
