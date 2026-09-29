/** Explicit official-verifier boundary; absence is a state, never a pass. */
export class VerifierBridge {
  constructor(officialVerifier = null) {
    if (officialVerifier !== null && typeof officialVerifier !== 'function') {
      throw new Error('officialVerifier must be a function or null')
    }
    this.officialVerifier = officialVerifier
  }

  async evaluate(trace) {
    if (!this.officialVerifier) {
      return {
        status: 'not_configured',
        benchmarkOutcome: null,
        executionOutcome: 'not_evaluated',
        traceHash: trace.traceHash,
      }
    }
    const result = await this.officialVerifier(trace)
    return {
      status: 'evaluated',
      benchmarkOutcome: result.benchmarkOutcome ?? null,
      executionOutcome: result.executionOutcome ?? 'unknown',
      raw: result.raw ?? null,
      traceHash: trace.traceHash,
    }
  }
}
