# Project Development Guide

This file guides Codex and other agents while they develop the project in this directory. It belongs to the project, not to the Capybara platform source code. The user remains the final decision maker for scope, design, and acceptance.

## Start here

Before changing anything:

1. Read this file and inspect the project tree, README files, configuration, and git status.
2. Identify the relevant entry points, existing abstractions, tests, and run commands.
3. Restate the requested behavior and the smallest useful acceptance checks.
4. Confirm that every path you will touch is inside this project directory.

Do not assume that a sample, mock, static preview, or generated file is the real implementation. Follow the actual execution path and existing project conventions.

## Working rules

- Keep all work inside the selected project directory. Never read or write a parent, sibling, home, or unrelated workspace.
- Preserve existing user changes. Do not reset, checkout, or overwrite unrelated files.
- Prefer the project's current language, framework, libraries, naming, and helper APIs. Add an abstraction only when it removes real duplication or complexity.
- Make the smallest complete change that solves the request. Avoid unrelated refactors, dependency upgrades, and generated-file churn.
- Use relative project paths in configuration, tool arguments, scripts, and documentation. Do not hard-code machine-specific absolute paths.
- Keep credentials, tokens, cookies, private data, local databases, and machine-specific settings out of source control and reports.

## Project understanding

Maintain these sections as the project becomes more specific:

### Purpose

- Project goal: _describe the user-visible outcome_
- Main users: _describe who operates or consumes it_
- Important constraints: _list compatibility, performance, security, or data rules_

### Stack and commands

- Runtime and framework: _for example, Node.js, Python, or a web framework_
- Install: _command_
- Development: _command_
- Tests: _command_
- Lint and type checks: _commands_

### Structure

Document the important directories and ownership boundaries here. Keep the description short and update it when the structure changes.

## Features, tools, and workflows

- Keep user-facing features backed by real data and real execution paths once the feature is accepted. Do not leave a static demo in place after backend work is requested.
- Define tools as small functions with explicit input and output contracts, validation, timeouts, and actionable errors.
- When a task needs several tool calls, let the agent generate a temporary runtime workflow when appropriate. Do not create or save a predefined workflow unless the user explicitly requests a persistent workflow artifact.
- Keep scripts deterministic where possible. Document arguments, side effects, required environment, and how to verify the result.
- When adding a skill, use a focused `SKILL.md` with clear activation criteria, workflow, tool selection, and verification. Put long references and deterministic scripts beside it instead of bloating the entry document.

## Hooks and learned behavior

Use a hook when project-specific code must inspect or transform runtime state. Keep one hook definition per file, expose a clear registration/default export, and make trigger conditions explicit. Hooks should return reviewable changes or artifacts rather than silently mutating unrelated state.

Store user-defined hooks in the project-root `hooks/*.ts` directory so they can be watched, tested, and edited as project resources. Treat `.capybara/hooks/*.ts` as system-owned runtime hooks and do not modify them.

When the project uses training or feedback:

- Keep training and held-out testing separate.
- Give the training process the reference answer only during the training/evaluation step.
- Turn corrections into reviewable experience or variable changes, then replay before promotion when the project requires it.
- Treat missing results as pending, not as failure or regression.
- Record dataset identity, model/configuration, code revision, inputs, outputs, errors, and timestamps so results can be reproduced.

## Change and verification workflow

1. Inspect the narrowest relevant files before editing.
2. Implement the behavior using existing project patterns.
3. Add or update focused tests for the changed contract and important failure paths.
4. Run the affected tests, then the project's type check and lint commands.
5. Review the diff for secrets, absolute local paths, debug output, accidental deletions, and unrelated changes.
6. Report the changed files, verification results, and any remaining limitation clearly.

Do not commit or push unless the user explicitly asks. When a change is ready for review, leave the working tree inspectable and explain the next validation step.

## Communication

Ask only when a missing decision would materially change the implementation. Otherwise make a conservative assumption and state it. Use concise, factual updates while working, and distinguish verified behavior from assumptions or untested areas.
