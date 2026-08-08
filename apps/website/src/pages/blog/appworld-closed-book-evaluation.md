---
layout: ../../layouts/BlogPostLayout.astro
title: "Building Frozen Context for Closed-Book Agent Evaluation"
description: "How Capybara turns execution evidence into a frozen, auditable context snapshot, then evaluates it on AppWorld without test-time learning."
published: 2026-08-08
category: "Research / AppWorld"
readTime: "7 min read"
lang: "en"
---

An agent does not execute from model weights alone. It also depends on its context: operating methods, domain knowledge, tool conventions, and rules for verifying state. When that context is an informal prompt that changes between runs, neither its quality nor its effect can be evaluated reliably.

This AppWorld experiment tested a narrower proposition: can execution evidence be distilled into a compact context asset, frozen at a known version, and evaluated without allowing test feedback to alter it?

The experiment was designed to validate that lifecycle. It was not designed to prove that learned context caused a performance improvement; that requires controlled baselines and ablations that are still in progress.

## Principle: Context is a versioned asset

High-quality context combines two things:

- **Methodology:** reusable ways to discover APIs, order calls, verify state, and recover from failure.
- **Necessary information:** project and domain facts that the agent needs, without unrelated or repeated material.

Treating this context as an asset changes the engineering model. Each revision needs provenance, a bounded size, a visible diff, and an evaluation history. A learning system may propose changes, but the resulting snapshot must remain inspectable and selectable by the user.

For Capybara, that leads to four practical requirements:

1. Context changes must be grounded in execution evidence.
2. Case-specific details must be separated from reusable methods.
3. Evaluation must use an immutable snapshot.
4. Test outcomes must never flow back into the snapshot being measured.

## Process: From runs to frozen context

The experiment used all 90 cases in the official AppWorld training split. For each case, a training Hook read the execution trace and the official evaluator result. It looked for evidence such as API discovery, call ordering, state verification, repeated mistakes, and recovery strategies.

The pipeline was:

```text
execution trace + evaluator result
    -> candidate experience
    -> redaction and deduplication
    -> relevance and size checks
    -> closed-book replay
    -> versioned context snapshot
```

Candidates were organized into four layers:

| Context variable | Purpose |
| --- | --- |
| `appworld_case_experience` | Reusable evidence from an individual case |
| `appworld_run_experience` | Patterns and failure modes across cases |
| `appworld_project_experience` | Project-level AppWorld and API methodology |
| `execution_policy` | Rules for execution, verification, retry, and completion |

Successes and task failures could both produce useful candidates. Infrastructure failures were retained for diagnosis but were not promoted as domain experience.

The 90 training cases produced 90 candidates. After filtering and replay, 78 were applied and 12 were rejected. The resulting snapshot contained four variables totaling 24,214 bytes. That size is an implementation fact, not a quality metric; the important property is that every accepted change can be traced back to evidence and compared with its parent snapshot.

## Evaluation boundary: Freeze before measuring

The final snapshot was frozen before either test split was run. The Normal and Challenge evaluations used the same context snapshot, model, protocol, project revision, and evaluator revision.

Both runs were marked `evaluationOnly=true`. In that mode:

- no experience candidates are created or applied;
- frozen variables cannot be modified;
- test results are unavailable to subsequent test cases;
- diagnostics are inspected only after evaluation.

The stored variables matched the frozen snapshot exactly, and both evaluation runs produced zero learning candidates. This provides a concrete isolation boundary: the experiment measures one context version rather than a context that silently improves while the benchmark is running.

## Results

The frozen snapshot completed every task in both official AppWorld test splits.

| Split | Completed | Passed | Task Goal Completion | Scenario Goal Completion | Avg. interactions |
| --- | ---: | ---: | ---: | ---: | ---: |
| `test_normal` | 168 / 168 | 143 | 85.1 | 73.2 | 9.34 |
| `test_challenge` | 417 / 417 | 306 | 73.4 | 52.5 | 11.17 |

The difficulty breakdown shows where the behavior was less consistent:

| Split | Level 1 TGC / SGC | Level 2 TGC / SGC | Level 3 TGC / SGC |
| --- | --- | --- | --- |
| Normal | 94.7 / 84.2 | 93.8 / 81.2 | 69.8 / 57.1 |
| Challenge | 83.3 / 58.3 | 68.7 / 48.0 | 73.3 / 53.8 |

Challenge was interrupted by infrastructure and API quota failures. Recovery resumed from failed infrastructure attempts and did not rerun completed tasks, including valid zero-score results. This preserved full task coverage without selecting only favorable attempts.

The two split results should be reported separately. The 449 passes across 585 tasks are a useful coverage summary, but they are not an official combined AppWorld leaderboard metric.

The encrypted bundles were rebuilt through AppWorld's official `unpack -> evaluate -> make` workflow. The workflow reproduced the same scores and returned `Added to leaderboard`. The [leaderboard pull request](https://github.com/StonyBrookNLP/appworld-leaderboard/pull/15) is still awaiting maintainer review.

## Conclusion

This experiment establishes that Capybara can turn run evidence into a bounded project context, preserve its provenance, freeze it, and execute a full benchmark without test-time learning. It also shows that the resulting runs can be recovered, audited, and packaged through the official AppWorld evaluation path.

More importantly, it makes context a controlled object in the agent engineering process. The model can propose what to retain, but the context version being used remains explicit, comparable, and under user control.

## Limitations and next experiments

These results do not yet isolate the causal value of the training Hook. The evaluation still needs:

- fixed no-Hook and baseline-context comparisons;
- ablations for each context layer;
- repeated trials to measure variance;
- evaluation on benchmarks beyond AppWorld;
- tests of context evolution during ordinary project work.

The current AppWorld test results have also now been observed. Future changes informed by their failures cannot be described as evaluation on an unseen test set. The next credible step is therefore a preregistered comparison on a fresh validation boundary, with snapshot versions and acceptance rules fixed before execution.
