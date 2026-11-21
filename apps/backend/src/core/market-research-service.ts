import { createHash } from 'node:crypto'

import {
  ProductWorkLedger,
  type Action,
  type ActorRef,
  type AdmissionContext,
  type ArtifactStatus,
  type EvidenceStatus,
  type PermissionLevel,
  type Receipt,
  type Risk,
  type SourceRef,
} from '#core/product-work-ledger'
import { ProjectArtifactIndex } from '#core/project-artifact-index'

export type ResearchStep = 'market_data' | 'report_download' | 'python_analysis' | 'dashboard_publish' | 'dashboard_open'
export type ProviderStatus = 'succeeded' | 'failed' | 'unknown'
export type ResearchRunStatus = 'succeeded' | 'partial' | 'failed' | 'unknown'

export type ProviderError = { code: string; message: string; retryable: boolean }

export type ProviderResult<T> = {
  status: ProviderStatus
  value?: T
  error?: ProviderError
  evidence?: ResearchEvidenceInput[]
  artifacts?: ResearchArtifactInput[]
}

export type DailyBar = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

export type MarketDataResult = {
  ticker: string
  exchange?: string
  currency?: string
  bars: DailyBar[]
  asOf: string
}

export type ReportDownloadResult = {
  ticker: string
  reports: Array<{ title: string; sourceUrl: string; artifactId: string; contentHash: string }>
}

export type PythonAnalysisResult = {
  ticker: string
  summary: string
  metrics: Record<string, number | string>
  recommendation: {
    disposition: 'for_review'
    stance: 'positive' | 'neutral' | 'negative' | 'insufficient_evidence'
    rationale: string[]
    risks: string[]
    uncertainties: string[]
  }
}

export type DashboardResult = {
  applicationId: string
  versionId: string
  status: 'published' | 'running'
  address?: string
  persistentAddress?: string
}

export type ResearchEvidenceInput = {
  kind: string
  source: string
  locator?: string
  summary: string
  payload?: unknown
  status?: EvidenceStatus
}

export type ResearchEvidence = ResearchEvidenceInput & {
  evidenceId: string
  runId: string
  capturedAt: string
  contentHash: string
  sourceRefs: SourceRef[]
}

export type ResearchArtifactInput = {
  kind: string
  contentRef: string
  contentHash: string
  status: ArtifactStatus
  summary: string
  relativePath?: string
}

export type ResearchArtifact = ResearchArtifactInput & {
  artifactId: string
  runId: string
  sourceRefs: SourceRef[]
}

export type MarketDataProvider = {
  fetchDailySeries(input: { ticker: string; exchange?: string; startDate: string; endDate: string; runId: string }): Promise<ProviderResult<MarketDataResult>>
}

export type ReportProvider = {
  downloadReports(input: { ticker: string; reportUrls: string[]; runId: string }): Promise<ProviderResult<ReportDownloadResult>>
}

export type PythonAnalysisExecutor = {
  analyze(input: { ticker: string; marketData: MarketDataResult; reports: ReportDownloadResult; runId: string }): Promise<ProviderResult<PythonAnalysisResult>>
}

export type DashboardPublisher = {
  publish(input: { ticker: string; marketData: MarketDataResult; reports: ReportDownloadResult; analysis: PythonAnalysisResult; runId: string }): Promise<ProviderResult<DashboardResult>>
  open(input: { applicationId: string; versionId: string; runId: string }): Promise<ProviderResult<DashboardResult>>
}

export type MarketResearchProviders = {
  marketData?: MarketDataProvider
  reports?: ReportProvider
  python?: PythonAnalysisExecutor
  dashboard?: DashboardPublisher
}

export type MarketResearchRequest = {
  projectId: string
  runId: string
  projectPath?: string
  ticker: string
  exchange?: string
  reportUrls: string[]
  today?: string
}

export type ResearchStepResult<T = unknown> = {
  step: ResearchStep
  status: ProviderStatus | 'not_executed'
  action: Action
  receipt: Receipt
  value?: T
  evidenceIds: string[]
  artifactIds: string[]
  error?: ProviderError
}

export type MarketResearchResult = {
  status: ResearchRunStatus
  ticker: string
  period: { startDate: string; endDate: string }
  steps: ResearchStepResult[]
  recommendation?: PythonAnalysisResult['recommendation']
  application?: DashboardResult
  evidence: ResearchEvidence[]
  artifacts: ResearchArtifact[]
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function dateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid date: ${value}`)
  return value
}

function lastMonthWindow(today: string): { startDate: string; endDate: string } {
  const end = new Date(`${dateOnly(today)}T00:00:00.000Z`)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - 29)
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) }
}

function providerError(code: string, message: string, retryable = false): ProviderError {
  return { code, message, retryable }
}

export class MarketResearchService {
  readonly ledger: ProductWorkLedger
  private readonly providers: MarketResearchProviders
  private readonly actor: ActorRef
  private readonly now: () => string
  private readonly evidenceStore = new Map<string, ResearchEvidence>()
  private readonly artifactStore = new Map<string, ResearchArtifact>()

  constructor(options: { ledger?: ProductWorkLedger; providers?: MarketResearchProviders; actor?: ActorRef; now?: () => string } = {}) {
    this.ledger = options.ledger ?? new ProductWorkLedger({ actor: options.actor ?? { type: 'capability-adapter', id: 'market-research' } })
    this.providers = options.providers ?? {}
    this.actor = options.actor ?? { type: 'capability-adapter', id: 'market-research' }
    this.now = options.now ?? (() => new Date().toISOString())
  }

  getEvidence(id: string): ResearchEvidence | undefined {
    const value = this.evidenceStore.get(id)
    return value ? structuredClone(value) : undefined
  }

  getArtifact(id: string): ResearchArtifact | undefined {
    const value = this.artifactStore.get(id)
    return value ? structuredClone(value) : undefined
  }

  async run(input: MarketResearchRequest): Promise<MarketResearchResult> {
    if (!/^\d{6}$/.test(input.ticker)) throw new Error('ticker must be a six-digit security code')
    const window = lastMonthWindow(input.today ?? this.now().slice(0, 10))
    const evidence: ResearchEvidence[] = []
    const artifacts: ResearchArtifact[] = []
    const steps: ResearchStepResult[] = []

    const market = await this.runStep<MarketDataResult>(input, 'market_data', 'market-data.daily', 'read', 'L0', this.providers.marketData
      ? () => this.providers.marketData!.fetchDailySeries({ ticker: input.ticker, exchange: input.exchange, ...window, runId: input.runId })
      : undefined, evidence, artifacts)
    steps.push(market)

    const reports = await this.runStep<ReportDownloadResult>(input, 'report_download', 'market-data.reports', 'reversible-write', 'L1', market.status === 'succeeded' && this.providers.reports
      ? () => this.providers.reports!.downloadReports({ ticker: input.ticker, reportUrls: input.reportUrls, runId: input.runId })
      : undefined, evidence, artifacts, market.status !== 'succeeded' ? providerError('BLOCKED_BY_MARKET_DATA', 'daily market data was not verified') : undefined)
    steps.push(reports)

    const analysis = await this.runStep<PythonAnalysisResult>(input, 'python_analysis', 'analysis.python', 'execution', 'L2', market.status === 'succeeded' && reports.status === 'succeeded' && this.providers.python
      ? () => this.providers.python!.analyze({ ticker: input.ticker, marketData: market.value!, reports: reports.value!, runId: input.runId })
      : undefined, evidence, artifacts, market.status !== 'succeeded' || reports.status !== 'succeeded' ? providerError('BLOCKED_BY_SOURCE_EVIDENCE', 'analysis requires verified market data and report artifacts') : undefined)
    steps.push(analysis)

    const dashboard = await this.runStep<DashboardResult>(input, 'dashboard_publish', 'application.publish', 'execution', 'L2', analysis.status === 'succeeded' && this.providers.dashboard
      ? () => this.providers.dashboard!.publish({ ticker: input.ticker, marketData: market.value!, reports: reports.value!, analysis: analysis.value!, runId: input.runId })
      : undefined, evidence, artifacts, analysis.status !== 'succeeded' ? providerError('BLOCKED_BY_ANALYSIS', 'dashboard requires a verified Python analysis') : undefined)
    steps.push(dashboard)

    const opened = await this.runStep<DashboardResult>(input, 'dashboard_open', 'application.open', 'read', 'L0', dashboard.status === 'succeeded' && this.providers.dashboard
      ? () => this.providers.dashboard!.open({ applicationId: dashboard.value!.applicationId, versionId: dashboard.value!.versionId, runId: input.runId })
      : undefined, evidence, artifacts, dashboard.status !== 'succeeded' ? providerError('BLOCKED_BY_DASHBOARD', 'dashboard was not published') : undefined)
    steps.push(opened)

    const terminal = steps.filter((step) => step.status !== 'not_executed')
    const hasUnknown = terminal.some((step) => step.status === 'unknown')
    const hasFailed = terminal.some((step) => step.status === 'failed')
    const allSucceeded = steps.every((step) => step.status === 'succeeded')
    const status: ResearchRunStatus = allSucceeded ? 'succeeded' : hasUnknown ? 'unknown' : hasFailed ? 'failed' : 'partial'
    return {
      status,
      ticker: input.ticker,
      period: window,
      steps,
      ...(analysis.value?.recommendation ? { recommendation: analysis.value.recommendation } : {}),
      ...(opened.value ?? dashboard.value ? { application: opened.value ?? dashboard.value } : {}),
      evidence,
      artifacts,
    }
  }

  private async runStep<T>(
    input: MarketResearchRequest,
    step: ResearchStep,
    capabilityId: string,
    risk: Risk,
    permissionLevel: PermissionLevel,
    execute: (() => Promise<ProviderResult<T>>) | undefined,
    evidence: ResearchEvidence[],
    artifacts: ResearchArtifact[],
    blocked?: ProviderError,
  ): Promise<ResearchStepResult<T>> {
    const action = this.ledger.createAction({
      runId: input.runId,
      projectId: input.projectId,
      capabilityId,
      operation: `market-research.${step}`,
      arguments: { ticker: input.ticker, step },
      target: { projectId: input.projectId, objectId: input.ticker },
      risk,
      permissionRequest: {
        level: permissionLevel,
        actorId: this.actor.id,
        projectId: input.projectId,
        capabilityId,
        operation: `market-research.${step}`,
        targetSummary: `${step} ${input.ticker}`,
        scope: { objects: [input.ticker] },
        reason: `research market information for ${input.ticker}`,
        expectedSideEffect: risk === 'read' ? 'none' : 'local-reversible',
      },
      idempotencyKey: `${input.runId}:${step}:${input.ticker}`,
      cancelMode: 'cooperative',
      actor: this.actor,
    })
    const context: AdmissionContext = { projectId: input.projectId, preAuthorized: true, schemaValid: true, scopeAllowed: true, policyAllowed: true, authorized: true }
    const admission = this.ledger.admitAction(action, context)
    if (admission.disposition !== 'accepted') {
      const receipt = admission.receipt ?? this.ledger.getReceipt(action.id)
      if (!receipt) throw new Error(`admission ${admission.disposition} did not produce a receipt`)
      return { step, status: 'not_executed', action: admission.action, receipt, evidenceIds: [], artifactIds: [], error: providerError('ADMISSION_REJECTED', admission.reasons.join('; ')) }
    }
    if (!execute) {
      if (blocked) {
        const receipt = this.ledger.recordReceipt({ actionId: action.id, status: 'not_executed', evidenceRefs: [], sideEffect: 'none', error: blocked, idempotencyKey: `${input.runId}:${step}:blocked` })
        return { step, status: 'not_executed', action: this.ledger.getAction(action.id) ?? admission.action, receipt, evidenceIds: [], artifactIds: [], error: blocked }
      }
      const receipt = this.ledger.recordReceipt({ actionId: action.id, status: 'unknown', evidenceRefs: [], sideEffect: 'unknown', error: blocked ?? providerError('PROVIDER_UNAVAILABLE', `no provider is registered for ${step}`), idempotencyKey: `${input.runId}:${step}:unknown` })
      return { step, status: 'unknown', action: this.ledger.getAction(action.id) ?? admission.action, receipt, evidenceIds: [], artifactIds: [], error: receipt.error }
    }
    this.ledger.recordReceipt({ actionId: action.id, status: 'started', evidenceRefs: [], sideEffect: risk === 'read' ? 'none' : 'local-reversible', idempotencyKey: `${input.runId}:${step}:started` })
    let result: ProviderResult<T>
    try {
      result = await execute()
    } catch (error) {
      result = { status: 'unknown', error: providerError('PROVIDER_EXCEPTION', error instanceof Error ? error.message : String(error), true) }
    }
    if (result.status === 'succeeded' && (result.evidence?.length ?? 0) === 0 && (result.artifacts?.length ?? 0) === 0) {
      result = { ...result, status: 'unknown', error: providerError('MISSING_EVIDENCE', `${step} provider returned success without evidence or artifacts`) }
    }
    const capturedEvidence = this.persistEvidence(input, action, result.evidence ?? [], evidence)
    const capturedArtifacts = this.persistArtifacts(input, action, result.artifacts ?? [], artifacts)
    const receiptStatus = result.status
    const receipt = this.ledger.recordReceipt({ actionId: action.id, status: receiptStatus, evidenceRefs: capturedEvidence.map((item) => item.evidenceId), resultHash: result.value === undefined ? undefined : hash(result.value), sideEffect: risk === 'read' ? 'none' : 'local-reversible', error: result.error, idempotencyKey: `${input.runId}:${step}:${receiptStatus}` })
    return { step, status: result.status, action: this.ledger.getAction(action.id) ?? admission.action, receipt, ...(result.value === undefined ? {} : { value: result.value }), evidenceIds: capturedEvidence.map((item) => item.evidenceId), artifactIds: capturedArtifacts.map((item) => item.artifactId), ...(result.error ? { error: result.error } : {}) }
  }

  private persistEvidence(input: MarketResearchRequest, action: Action, entries: ResearchEvidenceInput[], output: ResearchEvidence[]): ResearchEvidence[] {
    return entries.map((entry, index) => {
      const value: ResearchEvidence = { ...structuredClone(entry), evidenceId: `${input.runId}:evidence:${action.id}:${index + 1}`, runId: input.runId, capturedAt: this.now(), contentHash: hash(entry.payload ?? entry.summary), sourceRefs: [{ type: 'project', id: input.projectId, relation: 'references' }, { type: 'action', id: action.id, relation: 'references' }] }
      this.evidenceStore.set(value.evidenceId, value)
      output.push(value)
      this.ledger.appendRunEvent(input.runId, { eventType: 'artifact.created', idempotencyKey: `research-evidence:${value.evidenceId}`, projectId: input.projectId, actor: this.actor, sourceRefs: value.sourceRefs, payload: { evidenceId: value.evidenceId, kind: value.kind, source: value.source } })
      return value
    })
  }

  private persistArtifacts(input: MarketResearchRequest, action: Action, entries: ResearchArtifactInput[], output: ResearchArtifact[]): ResearchArtifact[] {
    const artifactIndex = input.projectPath ? new ProjectArtifactIndex(input.projectPath) : undefined
    return entries.map((entry, ordinal) => {
      const value: ResearchArtifact = { ...structuredClone(entry), artifactId: `${input.runId}:artifact:${action.id}:${ordinal + 1}`, runId: input.runId, sourceRefs: [{ type: 'project', id: input.projectId, relation: 'references' }, { type: 'action', id: action.id, relation: 'produced-by' }] }
      this.artifactStore.set(value.artifactId, value)
      output.push(value)
      artifactIndex?.upsert({
        artifactId: value.artifactId,
        kind: value.kind,
        contentRef: value.contentRef,
        contentHash: value.contentHash,
        status: value.status,
        summary: value.summary,
        ...(value.relativePath ? { relativePath: value.relativePath } : {}),
        sourceRefs: value.sourceRefs,
        runId: value.runId,
      })
      this.ledger.appendRunEvent(input.runId, { eventType: 'artifact.created', idempotencyKey: `research-artifact:${value.artifactId}`, projectId: input.projectId, actor: this.actor, sourceRefs: value.sourceRefs, payload: { artifactId: value.artifactId, kind: value.kind, status: value.status } })
      return value
    })
  }
}
