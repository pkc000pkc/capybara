# Evaluation integrity

Experiments accept `readonlyAssets: true` in the creation request. The option is
persisted in the run configuration and therefore survives resumption. Existing
experiments default to false. Training testing cases enable it automatically.

Runtime execution carries an asynchronous, project-scoped policy. Mutations
through the project write queue and direct ProjectResources saves are rejected.
ProjectFileService also protects plugins, harnesses, hooks, skills, tools, roles,
variables, main.j2, capybara.plugin.json and configuration/variable files under
.capybara. Ordinary task output files remain writable. Preparation and evaluator
execution are outside the actor policy; they must restore and inspect task state.
Configured Skill/Harness paths and Tool package directories are protected even
when they use custom names. All .j2 templates are protected.
Direct Hook, Skill, Harness and template save APIs enforce the same policy.
Filesystem-write tools are checked before spawning: known path arguments cannot
target resources, the project root or paths outside the project; unspecified
filesystem writes are rejected. Resolved symlink targets are checked as well.
Tool implementations must honor their declared permissions and path arguments;
arbitrary process execution is not intercepted by this filesystem argument check.

Case traces expose `assetWrites` (blocked/started/completed/failed operations) and
`llmRequests` (logical request ID, role, optional hook ID, result status, model,
duration, provider usage and retry notifications). Missing usage is null rather
than a zero-cost claim. Retries without provider usage cannot be assigned exact
token costs. No prompts, response bodies, retry reasons or credentials are copied
into these audit records. Adapter-owned simulator/judge calls need adapter-side
accounting. Training extraction/correction already report their Hook usage/events;
the case request ledger covers the runtime and LLM scorer.
Write events share an operation ID across started/completed/failed states and
include Hook attribution when available. A queued transaction and its underlying
resource save are separate operations; do not count every event as a mutation.

This is an application boundary, not an operating-system sandbox. Arbitrary Hook
code, external tool processes and adapters can access the filesystem according to
their host permissions. For untrusted projects, run the actor and evaluator with
separate OS permissions/containers and mount context assets read-only. Do not
interpret this option as proof of total filesystem or hidden-answer isolation.

Training Hooks default to referencePolicy hidden. The hidden fixture strips
expected answers, reasoning, expected tools, evaluator details/reference/metrics
and judge rationale, retaining observable traces and a binary outcome. This does
not remove a reference that was already embedded in project variables, candidate
text, tool observations or user-provided prompts. Audit those inputs separately.

NO-GATE assets can be constructed by a project experiment script. The production
training admission rule still requires successful replay; disabling an admission
Hook does not bypass it. Intermediate learning snapshots may likewise be saved
by project orchestration without changing the production freeze state machine.
