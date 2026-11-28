# V2 runtime governance evidence

This is a reproducible acceptance slice for the context and internal-capability line.

Run from `apps/backend` with the project fixture configured:

```powershell
$env:CAPYBARA_TEST_PROJECT_DIR='../../examples/test-project'
npx tsx --conditions=development --test `
  test/project-system-variables.test.ts `
  test/skill-marketplace.test.ts `
  test/resource-registry.test.ts `
  test/context-document-runtime.test.ts `
  test/context-training-runtime.test.ts `
  test/runtime-activity-state.test.ts
```

The current run passes 27/27 tests and covers:

- project-scoped and session-scoped variable updates, JSON Patch revisions and invalid-template rollback;
- system prompt/template rendering and dynamic context injection;
- tools, skills and harness resource APIs with optimistic revisions;
- pinned skill marketplace preview/install/removal and unsafe-input rejection;
- ContextDocument projection, candidate/evidence governance and child merge;
- RuntimeLoop export/restore of context training samples;
- child-session and process status snapshots, including explicit `unknown` states.

The RuntimeLoop snapshot now carries optional `contextScopes`, `contextTrainingSamples`, `children`, and `processes` fields. Older snapshots remain valid because all four fields are optional. `RuntimeActivityState` provides the typed update and replay boundary; an adapter or Supervisor can drive it from real child/process events without changing the existing timeline semantics.
