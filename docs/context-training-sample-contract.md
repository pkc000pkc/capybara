# Context organization training sample contract

This contract follows `capybara-doc/llm-doc/上下文整理算法设计.md`. A runtime sample records the complete organization boundary instead of retaining only the final context text:

```text
project_context + context + raw cache + messages + system_prompt
                              ↓
                   normalized observations
                              ↓
                    project/session proposal
                              ↓
                       runtime decision
                              ↓
             post-organization project/session context
```

`ContextTrainingRecorder` stores the serialized `project_context` and its revision together with the session context and revision, normalized candidates, raw runtime cache, raw LLM messages, and the rendered project system prompt. Each sample also records `projectId`, `sessionId`, optional `runId`, and `scope` (`project` or `session`). Proposals retain local operations, source references and evidence references. Decisions retain accepted, rejected, archived and recall links plus the execution evidence needed to train a small model without guessing runtime outcomes:

- apply, candidate-review and evidence-review receipts, including rejection/conflict error codes;
- archive records with the pre-archive body, lineage, evidence and operation result;
- recall records with the query, returned candidate/archive IDs, selected IDs and match reasons;
- candidate and evidence review records;
- preserved conflict records with separate supporting and contradicting evidence references.

Candidate operations also retain a placement classification: `durability` (`project`, `session`, or `transient`), `target` (`project`, `session`, or `cache`), confidence, reason, and `projectAnchors`. A project operation is trainable only when it has project durability, project target, at least one valid project anchor, and evidence references. A missing or mismatched classification is recorded as a RuntimeLoop promotion rejection rather than being silently written to `project_context`.

Project anchors are checked against the current project before promotion. File/config/prompt/tool/manifest anchors must resolve inside the project directory; artifact anchors must match an artifact evidence record; explicit anchors require message, artifact, or external evidence. A Session candidate with a valid project classification can be copied into the Project Candidate set, rebound to a fresh Project Projection, and then applied through the normal semantic-diff gates.

Every newly recorded runtime sample has `schemaVersion: 2`. `validateContextTrainingSample` checks that a completed sample contains an input, a decision, a post-organization output, source/evidence references for operations, and both evidence sides for preserved conflicts. Export depends on the learning task: `toTrainableContextExample` produces the legacy analysis/review `{ input, target }` representation; automatic organizer executions use the model-only chat export described below. A recall with no matches remains a valid negative retrieval example as long as the query and empty result are explicit.

Project and session context are separate identities. A session context may point to a project context through `parentDocumentId` and `parentRevision`; a session revision cannot silently replace the project document. The runtime snapshot exposes both scope references through optional `contextScopes` while preserving older snapshots that do not contain the field.

The recorder is an evidence/training boundary. It does not rewrite messages, system prompts, context documents, or run history. The runtime remains responsible for applying proposals through the target ContextDocumentEngine revision, project persistence gate, and evidence gates. The recorded `systemPrompt` is the rendered project prompt; Capybara's internal constitution and auxiliary control prompts remain runtime metadata rather than project knowledge.

Current reusable runtime surfaces:

- `ContextDocumentEngine.serialize()` for the canonical context document input;
- `RuntimeLoop.exportState()` for context document, receipts, projections and messages;
- `variables.apply` and `template.update` for governed system-variable/template edits;
- `runtime.tools.attach` / `runtime.tools.detach` for tool catalog changes;
- `runtime.skills.*` and the skill marketplace API for reviewed skill installation and use.

Child-session and process status are separate observable records. `RuntimeChildSession`
describes parent/session/run linkage and child status, while `RuntimeProcessRecord`
describes an application, program, script, or tool process. Unknown status is
preserved in both records and snapshots can be restored without converting it to
success or failure.

## 2026-11-17 design alignment: projection and control evidence

The [unified V2 design](D:/gitlocals/kanli8-human/capybara-github/capybara/docs/v2-context-capability-control-design.md) defines additional evidence needed to evaluate information preservation and continuing task quality. Automatic organization now records an `organization` extension (`schemaVersion: 1`) inside the version-2 runtime sample:

- actual organizer request messages, raw model response and accepted proposal for each bounded source pack;
- Constitution/Organizer prompt role, version and content hash;
- the read-only runtime-state snapshot supplied to that organization call;
- coverage frontiers before and after the call, including commit identity and real receipt IDs;
- `outcome=committed|no_change|rejected`, durable commit identity where applicable, and actual failure code for rejected attempts;
- pre/post project and session documents and revisions, raw source material, operations and runtime decisions in the surrounding sample.

`task=context_organization` is attached when sampling starts, before any model call or telemetry completion. `toOrganizationTrainableExamples` exports version-3 chat examples. The assistant target is the original model's validated `OrganizationOutput`; runtime-created candidate/evidence IDs, commit results and receipts remain provenance or review labels. Rejected executions are retained for diagnosis and correction data but are excluded from positive generator targets. A valid zero-operation/no-coverage response is a positive no-change example. `toTrainableContextExample` rejects these records with `ORGANIZATION_TRAINING_EXPORT_REQUIRED`, even when later telemetry fails, so the runtime decision bundle cannot accidentally become a generator target. Missing organization execution evidence is an explicit validation error and excludes the incomplete record.

An assistant proposal may use `coverageProposal: "auto"` and a snapshot-bound `add_entry` with `sourceObservationId`. The runtime record preserves its resolved coverage and archive receipts under `organization.coverageAfter` and `organization.sourceArchives`. The assistant chat target preserves the literal proposal.

### Local export and trainer

Export from saved V2 session snapshots with the backend CLI. Use one `--session` per selected ID. Desktop storage defaults to `.capybara/sessions.sqlite`. Runner storage uses its configured data directory, typically `--data-dir <project-directory>/.capybara/runtime`. The output must be a new file in an existing directory on a filesystem that supports hard links.

```powershell
capybara export-context-training <project-directory> --session <session-id> --output <new-file.jsonl>
```

The exporter opens the session database read-only and verifies the sample's project and session identities. It exports structurally validated committed and no-change attempts. Other attempts remain in the original records. `provenance.projectGroup` and `provenance.sessionGroup` are grouping hashes for the originating directory and session.

Run the tokenizer audit from the model project's managed Python environment. `--max-length` is the maximum sequence length after formatting. Overlong rows cause the command to report the sample IDs and exit before model allocation.

```powershell
python scripts/train_lora.py --data <new-file.jsonl> --model <chat-model-or-local-path> --max-length 16384 --dry-run --check-tokens
```

Version 3 uses the model tokenizer's native chat template. Input tokens include all original request turns and the final assistant prefix. The supervised suffix contains the final assistant proposal and the template's stop tokens. Input and padding labels are `-100`; a model that supports suffix logits can still attend to the complete prompt while computing output logits for the supervised suffix. The legacy `messages`/`evidence`/`expected` representation remains readable by the local trainer. [Local trainer](D:/gitlocals/kanli8-human/capybara-llm/scripts/train_lora.py)

The captured Organizer messages come from the RuntimeLoop call boundary. The HTTP client can append its JSON-format instruction before dispatch. Use the serialized request for exact transport counts. Its hash, measured input tokens and chat-tokenizer revision are written to the runtime model-budget ledger when the configured tokenizer admits the call. Preserve both views when reconciling training data with the served prompt.

Chat exports can also carry `organizationVersion: 2` in the user input. Its assistant proposal contains the matching `batch` and local references. The source, node and candidate reference maps are recorded as `provenance.referenceBinding`. The trainer supervises the original assistant proposal. Canonical diff bindings and evidence receipts remain host provenance, including when a heading edit changes only structural nodes.

Quality review checks each expected claim in active document text together with evidence for its own source. In mixed inputs, review distinguishes irrelevant text within an otherwise useful source from an entirely irrelevant source eligible for an archive proposal. All orders of the same underlying materials share a task group. Keep separate held-out scenarios whose topics and originals do not appear in the development corpus. Evaluate committed content and actual archive receipts separately from accepted schema and retained original history.

An `organizationVersion: 3` Organizer request uses the same batch and local reference binding. Its observation target contains source numbers and optional classification. The host materializes the source text, and the edit target cannot supply replacement body text. Keep the materialized contents and exact source spans in application evidence, alongside the model's choices and actual dispositions. A held-out extraction also measures whether the subsequent main request still presents the complete raw result through tool messages or pending candidates.

An `organizationVersion: 4` file disposition target contains the exact batch, one K/A/R choice for each offered source in order, and a heading. File archive review uses a fresh batch bound to its own input. Raw requests and replies remain in the execution record. When review changes the first set of choices, the first reply is excluded from supervised export. The resulting document diff and receipts retain the applied dispositions as host evidence.

File batches keep the spans from one read together when they fit. Several such batches can contribute to one tool group's coverage. Archive choices for a read split between batches are deferred. A proposed archive of an entire read requires agreement on every span in the separate review. A review veto retains the complete read.

The main request in version 4 may carry a verified `contentRef` for a native file read and an artifact reference in a duplicate candidate body. The main request artifact records the resulting wire projection. Durable history, artifact pages, archival spans, and Organizer requests continue to bind to the original data. Reversible representation changes do not advance the history coverage frontier or create an organizer training target.

File-disposition requests may use a compact rendering of the original task instructions. `input.systemPrompt` retains the complete original rendered prompt. `organization.attempts[].messages` preserves the prompt and instruction view actually sent. The chat training example uses those actual messages with the reviewed model proposal.

The main request may carry `unresolved_lines` for a committed partial file projection. The source log and Organizer input retain the full read. The omission proofs bind UTF-16 source spans to live entries or durable archive receipts. These proofs and the main request view are audit data. The Organizer target continues to record dispositions over its original input.

The V4 main request can carry `entry-ref` and `candidate-ref` with readable evidence IDs and source locations. The saved request retains this exact view with its projection binding. Replay and export retain the original document and source records, including the full evidence metadata.

Optional file names and line numbers in the main request are host-derived from the cited immutable read. Timed-answer evaluation labels are held outside model inputs and training targets. Review source assignment, action, time, prerequisites, observed states, and prohibitions before treating downstream answers as correct.

A V4 finish can contain `fileQuotes` to fill exact excerpts into null fields in the final JSON. Model outputs retain the proposed evidence IDs and JSON pointers. The rendered reply and quote receipts are host results used for evaluation and provenance.

### Reviewed data and splits

Record one review per inspected row in a separate JSONL file. Each review carries `sampleId`, `rowSha256`, `reviewId`, `reason`, and `decision` (`accept` or `reject`). Compute `rowSha256` over the exact UTF-8 export line without its line ending. Accepted rows additionally carry `split` (`train`, `validation`, or `test`) and `sourceTaskGroup`. Use one source-task group for variants that share the originating task, including copies in different project directories. A review checks that the retained facts match the cited source, current conditions and scope, preserves both sides of any conflict, and leaves archived information recoverable.

```powershell
python scripts/prepare_v2_dataset.py --input <new-file.jsonl> --reviews <reviews.jsonl> --output <new-dataset-directory>
python scripts/train_lora.py --dataset <new-dataset-directory> --max-length 16384 --dry-run --check-tokens
```

The preparation step excludes rejected and unreviewed rows. It refuses changed rows, missing review references, duplicates and any project, session or source-task group that appears in multiple splits. It publishes three JSONL files and a manifest with counts and file hashes. `--dataset` verifies and reads only `train.jsonl`; review metadata stays in provenance. An empty validation or test split can support development, while a comparative quality run requires independent held-out cases. [Dataset preparation](D:/gitlocals/kanli8-human/capybara-llm/scripts/prepare_v2_dataset.py)

For a CUDA memory-constrained training run, `--fused-sdpa` requires the model to use CUDA SDPA and disables its full-matrix math fallback. This keeps the complete training input and assistant-only loss mask. Check the fused kernel's support and measure memory on the model and sequence lengths used for the actual run.

The complete closure still requires:

- canonical `session_context` identity, with an explicit alias for existing `context` samples;
- the exact project/session projections supplied to each model request, including bindings, budgets and content hashes;
- explicit admission of semantically reviewed targets; successful structural validation and persistence alone do not prove information fidelity;
- the remaining capability, Skill, tokenizer and model configuration bindings beyond the prompt and runtime-state metadata already recorded;
- coverage of every path, including explicit recall and ordinary Envelope diffs, with consistent commit/recovery and rejection metadata;
- later recall outcomes and downstream task quality, alongside token cost and structural validity.

An organizer proposal is a model target only with its provenance and review status. Runtime-issued authority, accepted receipts, task completion and successful persistence are labels derived from actual execution records, never from model assertions. Opposing claims remain separate evidence-bearing content; their coexistence is not a label asking the organizer to choose a winner.

A recorder or mirror-export failure after durable commit is a telemetry failure, not a rollback. It must not relabel a committed proposal as rejected or restore an old in-memory document. Incomplete training records require repair or exclusion; they are not silently admitted as complete examples.

Archive/recall and project-frozen examples retain their true scope. A project candidate requires a verified project anchor; unrelated material does not become project memory merely because it was archived during a project session. Train/validation/test splits must isolate related projects and sessions to prevent repeated documents or task results leaking across splits.

## Storage authority and session lifecycle

Canonical SQLite documents, committed frontiers and original sources determine the inputs after recovery. A directory snapshot with a larger document revision is not a knowledge commit; malformed snapshot candidates or tree metadata do not replace an existing canonical document. Legacy imports are atomic and begin with zero historical coverage. A raw snapshot prefix that contradicts a persisted original is rejected.

Each connection's actual read fingerprint includes the complete stored state and a host-issued `write_version`. Even archive-only commits with identical document bytes advance that version. CAS rejection, transaction rollback and source lifecycle results are runtime outcomes, not generator fields or claims the organizer can sign. A failed transaction preserves the writer's read base so an exact retry can succeed after the injected fault is removed.

Explicit session clearing is a user lifecycle operation, not an organizer archive proposal or evidence that content was useless. It clears session resources while preserving originals actually referenced by project evidence/candidates. Tombstones stop old writers or snapshots from restoring the cleared session. Qualified project origins remain readable from a new session; ambiguous legacy origins remain ambiguous. Training resources must retain these distinctions rather than turn cleanup or rejected writes into positive organization targets.

## Projection publications and outcome replay

The publication journal retains the actual document Markdown, its hash and visible identities, scope, session, channel, and publication identity. Model publications bind the complete run/request pair; a timeline step ID alone can repeat in another run. A publication proves that the host prepared this input, not that a remote model received or understood it. Only document projections completely present in the outbound request are recorded as model input. Knowledge-section payloads and entry references participate in metadata-write integrity checks.

Outcome journals keep the original proposal/receipt separately from transport attempts. A retry may have a new proposal ID but retain the original immutable receipt. Training decisions identify the current attempt's operations; `subjectId` remains the original receipt's proposal identity, while `attemptProposalId` and `replayed` express the association when they differ. Grouping project/session operations must not change this pairing. An aborted batch records `batchFailure`: new actions are rejected, while an earlier committed action replay retains its true applied result. Neither telemetry nor batch failure can relabel that earlier commit as rejected.

Rejected archive proposals remain negative evidence and do not populate successful `archivedNodeIds`. Durable success receipts must match the canonical receipt for the same idempotency key; matching text or an invented success object is insufficient. Restoring historical standalone rejection/idempotency records does not restore old knowledge. A rolled-back batch establishes no new action idempotency result: a safe retry can succeed after the fault is resolved, while the original failed attempt retains its negative label. These journals and fields are runtime provenance and review labels, never generator authority targets.

## Stage and capability provenance

MCP source bindings additionally retain the configured server identity, raw remote tool name, actual connection/protocol, actual outgoing RPC ID and the governed capability version. Mutating calls reserve an operation in `runtime_mcp_operations` before transport dispatch. Canonical unknown operations override an empty or older snapshot and block duplicate dispatch/completion; a confirmed remote result remains a real result even if final local journal persistence fails. These host records are provenance and execution labels, never generator authority targets.

An outbound Skill reference result may replace duplicated body text with `contentRef=active_skill_context` only when the active reference identity/hash/content match and the actual system input contains its complete rendered body. The original tool artifact/history retain the full body. Training must distinguish the actual model projection from the immutable original and retain the binding to the active version. This view optimization does not advance factual history coverage or authorize silently dropping facts.

The main model-request artifact retains the host-created CapabilityProjection: complete request identity, execution phase, ready/active/blocked task IDs, plan revision, allowed decisions and exact capability bindings. Each binding retains the source/version, schema hash, permissions and effect/replay contract. Native tool requests inherit an authorization from this record; Workflow and foreach steps inherit the same record. The execution receipt's capabilityBinding links back to it. Model plan proposals can name known capabilities and propose node phases, but do not generate permissions or these host authorization objects.

Task-control planning state, request projections and queued authorization bindings survive runtime snapshots. A reopened action is not a new grant: current permissions, source/schema versions and stage are checked again. Rejected, stale or unbound requests remain execution evidence rather than positive tool-use targets. A queued batch rejected before dispatch must not acquire successful tool labels.

Host-observed capability drift may schedule a new model decision from refreshed authority. The refusal artifact retains the original binding, projection, pending calls and reason; tool refusals explicitly carry `dispatched=false` and no successful execution receipt. Completed batch members and Workflow steps retain their original success provenance, while rejected or skipped steps keep negative outcomes. A later successful fresh call does not relabel the earlier refusal.

The host recovery notice is recorded with `origin=runtime`, not as a new end-user instruction or authorization. `taskControl.capabilityRecovery` is host budget/provenance, persists across reconnect and human replies, and is not a model-generated authority target. Dataset construction must not train replay of already completed writes, turn refusal text into completion evidence, or label a bounded recovery failure as semantic answer success. Tampered/unbound projections and unknown side effects remain outside automatic reauthorization.

Request-size admission currently estimates the actual serialized messages and tool schemas. It reserves complete uncovered history before allocating document projection space, and omits repeated per-tool schema metadata from model-facing directories. This is an estimate, not provider-billed token usage or proof that all model tokenizers are calibrated. Budget/transport failures remain infrastructure outcomes, separate from semantic answer failures; the unchanged 10,000-token correction fixtures and Skill history scenario are retained as regressions.

## Versioned document-tree operations

Each context document now persists `tree.version=1`, ordered root children and stable heading IDs. Its readable projection remains a recursive list; `nodeIdsByPath` links that view to stable identity. Markdown serialization retains the complete tree and entry heading paths, including archived and superseded lineage. Active projections retain physical tree order; pinning changes selection priority rather than the order of the document.

Structural proposals use `diffVersion=2`, a visible target node ID/hash, and one of `add_heading`, `rename_heading`, `move_node`, or `reorder_children`. Training operations retain that exact action, version, target identity and `structure` payload instead of relabeling them as `mark_status`. Real apply receipts retain `changedNodeIds`, including host-created heading identities. Those receipt IDs stay execution labels; the model's original output remains the generator target.

The `capybara:tree` metadata in actual request projections supplies visible identities, parent/child references and hashes. It consumes the same input budget as the document body. Hidden siblings are not valid guessed edit targets. Partial reorder replaces only the selected sibling slots; omitted or archived nodes retain their positions. Source-bound layout-only receipts do not by themselves advance coverage of factual source spans.

The latest user message is retained as a source-bearing session candidate for incremental document requests. Once accepted, it may be explicitly pinned in later projections without restoring rejected/stale sources. This preserves the authorizing source for successive layout edits while keeping the raw message and runtime authorization authoritative.

## Capability authority and child labels

Internal execution receipts retain the host-bound permission list, side-effect class and replay policy alongside source/schema hashes and the request projection. Skill script source versions bind the active Skill entry and registered script paths/content. A source or permission refusal is not an executed operation and cannot become a positive execution label. Direct Skill commands recheck the same contract before spawning; a refused command retains its real error artifact.

Imported child content remains a pending claim. The candidate's actor/source labels do not create a child execution, completion timestamp, success label or result-consumption receipt. A child's real failure is retained even when an imported document claims success; training must join authoritative lifecycle and evidence records separately. Hook RPC permission refusals likewise do not count as host model calls or successful capability execution.

## Auxiliary role evidence

An auxiliary call binds the actual session/task/run/request, snapshot, model/protocol, prompt and schema hashes to its complete provider request. Persist budget reservations before dispatch and retain conservative reservations across interruption; actual usage and reservations are separate values. Host-generated execution IDs, times, statuses and consumption receipts are labels, not targets the model should invent.

Reflection targets contain diagnosis, correction proposals, candidate diffs, evidence requests, retry prerequisites and uncertainties. The main role receives the complete validated output as guidance; dependencies, negation, prerequisites and unknowns must not disappear in a display summary. Candidate diffs are never applied by the auxiliary call itself. Schema-valid/succeeded and accepted guidance do not prove factual truth or successful correction.

Preserve malformed text, rejected source/evidence references, rejected tool intents and their arguments, stale results and late/unknown outcomes. A later valid attempt does not rewrite the earlier failure. Project/session knowledge, trace and auxiliary source journals remain distinct. Auxiliary journals provide supervision candidates; semantic admission, task isolation and model-only training export must still be verified separately.

Normalize stores source references and extracted suggestions. Organize receives both original spans and these suggestions as inputs. Only governed Organizer commits and archived originals can advance coverage. Recall stores the retrieved pool in the auxiliary request, the selected IDs and reasons in the model output, and the actual pending candidates in the recall journal. Record lexical fallback and stale outcomes separately from successful model selection.

Parent Merge inputs bind an actual child result and its immutable source. Dream binds an idle snapshot and identifies protected or frozen scopes. Their proposal outputs, subsequent human or main-model decisions, and accepted knowledge commits occupy separate fields in training data.

## Async child source and review evidence

Join child training evidence to the durable parent session/task/run, actual child session/run, worker lease, deadline and budget ledger. A child assistant message is not a successful execution label: success comes from the actual child run completion gate. Late callbacks retain a separate observation and cannot change a cancelled, timed-out or superseded primary outcome.

The host-issued result hash identifies an immutable source package. Read receipts bind the actual result, parent model request and bounded view; consumption is a later parent review with its own receipt. accept/reject/conflict are source-consumption decisions, while needs_more_evidence remains unresolved. None of these labels confirms the truth of a child claim or applies a knowledge diff. Store host IDs, hashes and timestamps as labels or input references, never as targets the small model is expected to invent.

Child originals live in a separate artifact source store rather than fabricated history messages. Retain a source across session cleanup only when the project actually references it; paged reads recheck source scope and hash. Compact model status projections and complete control ledgers are distinct artifacts, so omitted settled metadata cannot be interpreted as cancelled work or missing evidence.

## Wait control evidence

Wait proposals retain the actual request binding and referenced host deadline. Durable wait records distinguish pending, satisfied, timed_out and cancelled; matched signals retain exact origin, task/run, correlation and host receive time. Run cancellation is a separate durable control marker and does not relabel an already observed signal outcome. These host records are labels, not model-generated IDs, timestamps or business success. Signal payloads enter ordinary tool evidence only when read through `read_wait_signal`; a matched external/user observation still requires ordinary fact governance.

## Unified retrieval evidence

`recall_context` and `runtime.context.v2.memory.recall` share one runtime retrieval path. Each durable `context_recalls` journal binds the query and requested scopes to actual hits and the pending session candidates created or reused. The session document and journal commit atomically; a journal failure rolls back newly imported candidates. Retrieval leaves the source project and archive states unchanged, including during a project-frozen evaluation.

Recall training records retain `sourceArchiveIds` and `sources` in addition to the existing query, candidate IDs, archived-entry IDs and selected IDs. Each source mapping includes original project/session scope, document identity where applicable, original source ID/kind/status, exact sourceRef for a raw archive span, resulting candidate ID and evidence references. Candidate scope is session even when its source is project; these two scopes must not be collapsed in a training label. Archive IDs and selected IDs are unique; per-span source mappings remain separate.

Evidence can carry the original `sessionId` alongside reference ID, hash, locator and observed time. Archived raw-source records preserve source spans in UTF-16 offsets; a derived span index can be rebuilt from older archive references. Recall excerpts are not full originals. Paged reads are admitted only for this session or sources actually referenced by the current project document, and preserve hash/identity failures instead of guessing a source.

The retrieval baseline uses deterministic keyword matching. Its accepted journal is evidence of a completed retrieval operation, not a semantic relevance verdict or a fact-acceptance label. The main task model selects useful material through ordinary governed diffs; independent Recall Prompt selection, semantic quality admission and downstream evaluation remain separate verification requirements.
