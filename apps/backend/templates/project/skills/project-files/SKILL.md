---
name: project-files
description: Inspect, search, create, update, and delete files inside a project workspace. Use when a task requires source-code or document discovery, deterministic file inventory, targeted edits, or verification of workspace changes.
compatibility: Requires project-scoped file tools provided by Capybara.
metadata:
  author: capybara
  version: "2"
  capybara-required-tools: "project-files:read_file project-files:list_files project-files:search_file project-files:search_in_file project-files:write_file project-files:delete_file"
---

# Project Files

Inspect and change only files inside the selected project workspace.

## Workflow

1. Resolve the requested location against the workspace boundary.
2. Inspect the narrowest relevant path before reading many files.
3. Search for unknown paths or symbols before opening candidate files.
4. Read the current content before modifying or deleting a file.
5. Apply the smallest requested change.
6. Read the changed file or run the relevant check to verify the result.

## Tool Selection

- Use `project-files:list_files` for a shallow directory listing.
- Use `project-files:search_file` to locate files by name.
- Use `project-files:search_in_file` to locate text before reading full files.
- Use `project-files:read_file` for targeted text reads.
- Use `project-files:write_file` only when the task authorizes a change.
- Use `project-files:delete_file` only when the task explicitly requires deletion.

## Bundled Resources

- Run `scripts/inventory.mjs` when a deterministic recursive inventory is more efficient than repeated directory calls. Pass the workspace with `--root` and keep `--path` relative to it.
- Read [the safety reference](references/safety.md) before broad traversal, overwrite, or deletion.