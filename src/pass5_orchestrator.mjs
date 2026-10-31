import { createHash } from 'node:crypto'
import { RuntimeAttempt } from './runtime_attempt.mjs'

function clone(value) {
  return structuredClone(value)
}

function seedFor(rootSeed, attemptIndex, correctionOrdinal = 0) {
  const digest = createHash('sha256').update(`${rootSeed}:${attemptIndex}:${correctionOrdinal}`).digest()
  return digest.readInt32BE(0)
}

function assertNoEvaluatorLeak(value, label = 'input') {
  const text = JSON.stringify(value ?? {})
  for (const key of ['expectedAnswer', 'referenceAnswer', 'oracle', 'judgeRationale', 'scorerRationale']) {
    if (text.includes(`"${key}"`)) throw new Error(`sealed evaluator violation: ${label} contains ${key}`)
  }
}

/** Five independent attempts with answer-blind correction and trusted aggregation. */
export class Pass5Orchestrator {
  constructor({ rootSeed = 17, attempts = 5, noiseProfile = 'off', maxCorrections = 1,
    runtimeFactory = (options) => new RuntimeAttempt(options), verifier = null, correction = null } = {}) {
    if (!Number.isInteger(attempts) || attempts !== 5) throw new Error('GAIA2 pass@5 requires exactly five attempts')
    if (!Number.isInteger(rootSeed)) throw new Error('rootSeed must be an integer')
    if (verifier !== null && typeof verifier !== 'function') throw new Error('verifier must be a function or null')
    if (correction !== null && typeof correction !== 'function') throw new Error('correction must be a function or null')
    this.rootSeed = rootSeed
    this.attempts = attempts
    this.noiseProfile = noiseProfile
    this.maxCorrections = Math.max(0, Math.floor(maxCorrections))
    this.runtimeFactory = runtimeFactory
    this.verifier = verifier
    this.correction = correction
  }

  async runScenario({ scenarioId, capability, eventPlan = [], plan = { steps: [] }, runAttempt } = {}) {
    if (!scenarioId || !capability) throw new Error('scenarioId and capability are required')
    if (runAttempt !== undefined && typeof runAttempt !== 'function') throw new Error('runAttempt must be a function')
    const outcomes = []
    for (let attemptIndex = 1; attemptIndex <= this.attempts; attemptIndex += 1) {
      const seed = seedFor(this.rootSeed, attemptIndex)
      const attempt = this.runtimeFactory({ scenarioId, capability, attemptIndex, seed, noiseProfile: this.noiseProfile })
      const initialStateHash = attempt.checkpoint().stateHash
      let correctionOrdinal = 0
      let strategy = null
      const corrections = []
      let execution
      try {
        execution = await this.#execute({ attempt, runAttempt, eventPlan, plan, mode: 'initial', strategy })
      } catch (error) {
        execution = { passed: false, infrastructureError: false, failureReason: String(error?.message ?? error) }
      }
      while (!execution.passed && this.correction && correctionOrdinal < this.maxCorrections && !execution.infrastructureError) {
        correctionOrdinal += 1
        const failure = this.#sanitizeFailure(execution)
        assertNoEvaluatorLeak(failure, 'correction failure')
        strategy = await this.correction({
          scenarioId, capability, attemptIndex, correctionOrdinal,
          failure, observableTrace: clone(execution.trace ?? []),
        })
        assertNoEvaluatorLeak(strategy, 'correction strategy')
        corrections.push({ ordinal: correctionOrdinal, strategyHash: hash(strategy) })
        const replay = this.runtimeFactory({ scenarioId, capability, attemptIndex, seed: seedFor(this.rootSeed, attemptIndex, correctionOrdinal), noiseProfile: this.noiseProfile })
        execution = await this.#execute({ attempt: replay, runAttempt, eventPlan, plan, mode: 'correction', strategy })
      }
      const verification = this.verifier
        ? await this.verifier({ scenarioId, capability, attemptIndex, execution: clone(execution), corrections: clone(corrections) })
        : { status: 'not_configured', passed: Boolean(execution.passed) }
      if (verification && Object.hasOwn(verification, 'referenceAnswer')) throw new Error('sealed evaluator violation: verifier result leaked referenceAnswer')
      const finalPassed = verification.status === 'evaluated' ? verification.passed === true : execution.passed === true
      const runtime = execution.runtime ?? {}
      const failureClass = verification.failureClass ?? execution.failureClass
      const reliability = verification.reliability ?? execution.reliability
      const modelEvaluable = verification.modelEvaluable ?? execution.modelEvaluable
      const scoreReliability = verification.scoreReliability ?? execution.scoreReliability
      outcomes.push({
        attemptIndex,
        seed,
        noiseSeed: runtime.noiseSeed ?? seedFor(this.rootSeed, attemptIndex),
        initialStateHash,
        finalStateHash: runtime.stateHash ?? null,
        passed: finalPassed,
        infrastructureError: execution.infrastructureError === true,
        ...(failureClass === undefined ? {} : { failureClass }),
        ...(reliability === undefined ? {} : { reliability }),
        ...(modelEvaluable === undefined ? {} : { modelEvaluable }),
        ...(scoreReliability === undefined ? {} : { scoreReliability }),
        failureReason: execution.failureReason ?? null,
        correctionCount: corrections.length,
        corrections,
        verification: { status: verification.status ?? 'not_configured', passed: verification.passed ?? null },
        official: execution.official ?? null,
        noise: runtime.noise ?? null,
        traceHash: runtime.traceHash ?? null,
      })
    }
    return this.aggregate({ scenarioId, capability, outcomes })
  }

  aggregate({ scenarioId, capability, outcomes }) {
    if (!Array.isArray(outcomes) || outcomes.length !== 5) throw new Error('pass@5 aggregation requires five outcomes')
    // Keep the legacy orchestrator answer-blind, but use the same reliability
    // partition as capability_evaluator: technical and judge-protocol
    // attempts are invalid, not model failures.  A passed flag alone is never
    // sufficient evidence for pass@5.
    const technical = outcomes.filter((outcome) => isTechnicalOutcome(outcome))
    const judgeProtocol = outcomes.filter((outcome) => isJudgeProtocolOutcome(outcome))
    const valid = outcomes.filter((outcome) => isReliableOutcome(outcome))
    const passed = valid.filter((outcome) => outcome.passed === true)
    const indeterminate = outcomes.length - valid.length - technical.length - judgeProtocol.length
    const complete = valid.length === 5
    const correctionCount = outcomes.reduce((sum, outcome) => sum + outcome.correctionCount, 0)
    const noiseInjectedCount = outcomes.reduce((sum, outcome) => sum + Number(outcome.noise?.injected ?? 0), 0)
    const noiseRecoveredCount = valid.reduce((sum, outcome) => sum + (outcome.correctionCount > 0 && outcome.passed === true ? 1 : 0), 0)
    const noiseBlockedCount = outcomes.reduce((sum, outcome) => sum + Number(outcome.noise?.conflicting ?? 0) + Number(outcome.noise?.truncated ?? 0), 0)
    return {
      schemaVersion: 'gaia2-pass5-v1',
      scenarioId,
      capability,
      attempts: outcomes,
      taskPassAt5: complete && passed.length > 0,
      passAt5: complete ? (passed.length > 0 ? 1 : 0) : null,
      observedPassAt5: passed.length > 0 ? 1 : 0,
      passAt5Bounds: { lower: complete && passed.length > 0 ? 1 : 0, upper: passed.length > 0 ? 1 : (complete ? 0 : 1) },
      attemptPassRate: valid.length > 0 ? passed.length / valid.length : null,
      taskPassAll5: complete && passed.length === 5,
      unresolvedRate: valid.length > 0 ? (valid.length - passed.length) / outcomes.length : 0,
      infrastructureErrorRate: technical.length / outcomes.length,
      technicalAttemptCount: technical.length,
      judgeProtocolAttemptCount: judgeProtocol.length,
      indeterminateAttemptCount: indeterminate,
      complete,
      status: complete ? (passed.length > 0 ? 'passed' : 'failed') : 'incomplete',
      correctionSuccessRate: correctionCount ? noiseRecoveredCount / correctionCount : 0,
      noiseInjectedCount,
      noiseRecoveredCount,
      noiseBlockedCount,
      validAttemptCount: valid.length,
      aggregation: 'task_pass_at_5=any(reliable_model_evaluable_attempt_pass_i); technical_and_judge_protocol_attempts_are_invalid',
    }
  }

  async #execute({ attempt, runAttempt, eventPlan, plan, mode, strategy }) {
    await attempt.run({ eventPlan, plan })
    const execution = runAttempt
      ? await runAttempt({ attempt, attemptIndex: attempt.attemptIndex, runtime: attempt.result(), mode, strategy })
      : { passed: false, failureReason: 'no attempt runner configured' }
    assertNoEvaluatorLeak(execution, 'attempt execution')
    // Re-read the runtime after the external bridge returns so hook events
    // emitted during model/tool execution are included in trace/state hashes.
    return { ...execution, runtime: { ...attempt.result(), noise: attempt.noise.summary() } }
  }

  #sanitizeFailure(execution) {
    return {
      failureReason: String(execution.failureReason ?? 'attempt failed').slice(0, 1000),
      observableErrors: clone(execution.observableErrors ?? []),
      trace: clone(execution.trace ?? []),
      infrastructureError: execution.infrastructureError === true,
    }
  }
}

function isTechnicalOutcome(outcome) {
  return outcome?.infrastructureError === true
    || outcome?.technicalError !== undefined && outcome.technicalError !== null
    || outcome?.failureClass === 'technical'
    || outcome?.reliability === 'technical'
    || outcome?.scoreReliability === 'technical'
}

function isJudgeProtocolOutcome(outcome) {
  return !isTechnicalOutcome(outcome)
    && (outcome?.judgeProtocolAffected === true
      || outcome?.failureClass === 'judge_protocol'
      || outcome?.reliability === 'judge_protocol'
      || ['protocol_affected', 'unknown'].includes(outcome?.scoreReliability))
}

function isReliableOutcome(outcome) {
  return !isTechnicalOutcome(outcome) && !isJudgeProtocolOutcome(outcome)
    && outcome?.reliability !== 'indeterminate'
    && outcome?.failureClass !== 'indeterminate'
    && outcome?.modelEvaluable !== false
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export { seedFor }
