import type { ApplicationRuntimeService, ApplicationRuntimeActionResult } from '#core/application-runtime-service'
import type {
  DashboardPublisher,
  DashboardResult,
  MarketDataResult,
  ProviderResult,
  PythonAnalysisResult,
  ReportDownloadResult,
  ResearchArtifactInput,
  ResearchEvidenceInput,
} from '#core/market-research-service'
import { LocalDashboardHost } from '#core/local-dashboard-host'

export type LocalDashboardPublisherOptions = {
  service: ApplicationRuntimeService
  applicationId: string
  versionId: string
  addressFactory?: (input: { applicationId: string; versionId: string }) => string
  host?: LocalDashboardHost
}

function operationEvidence(result: ApplicationRuntimeActionResult, kind: string): ResearchEvidenceInput {
  return { kind, source: 'application-runtime-service', locator: result.receipt.id, summary: `${result.operation} receipt ${result.receipt.status}`, payload: { actionId: result.action.id, receiptId: result.receipt.id, versionId: result.versionId, manifestVersion: result.manifest.versions } }
}

function dashboardArtifact(applicationId: string, versionId: string): ResearchArtifactInput {
  return { kind: 'application-dashboard', contentRef: `application:${applicationId}:${versionId}`, contentHash: `${applicationId}:${versionId}`, status: 'available', summary: 'Logical application dashboard artifact from verified application runtime state' }
}

export class LocalDashboardPublisher implements DashboardPublisher {
  private readonly service: ApplicationRuntimeService
  private readonly applicationId: string
  private readonly versionId: string
  private readonly addressFactory?: LocalDashboardPublisherOptions['addressFactory']
  private readonly host?: LocalDashboardHost

  constructor(options: LocalDashboardPublisherOptions) {
    this.service = options.service
    this.applicationId = options.applicationId
    this.versionId = options.versionId
    this.addressFactory = options.addressFactory
    this.host = options.host
  }

  async publish(input: { ticker: string; marketData: MarketDataResult; reports: ReportDownloadResult; analysis: PythonAnalysisResult; runId: string }): Promise<ProviderResult<DashboardResult>> {
    const preview = this.service.preview(this.versionId, input.runId)
    if (!preview.ok) return { status: 'failed', error: { code: 'DASHBOARD_PREVIEW_FAILED', message: preview.error ?? 'application preview failed', retryable: false }, evidence: [operationEvidence(preview, 'dashboard-preview')] }
    const deployed = this.service.deploy(this.versionId, { runId: input.runId, deploymentRef: `market-research:${input.ticker}:${this.versionId}` })
    if (!deployed.ok) return { status: 'failed', error: { code: 'DASHBOARD_DEPLOY_FAILED', message: deployed.error ?? 'application deploy failed', retryable: false }, evidence: [operationEvidence(preview, 'dashboard-preview'), operationEvidence(deployed, 'dashboard-deploy')] }
    const started = this.service.start(this.versionId, { runId: input.runId, instanceId: `logical:${this.applicationId}:${this.versionId}`, healthCheckRef: `logical-health:${this.applicationId}:${this.versionId}` })
    if (!started.ok) return { status: 'failed', error: { code: 'DASHBOARD_START_FAILED', message: started.error ?? 'application start failed', retryable: false }, evidence: [operationEvidence(preview, 'dashboard-preview'), operationEvidence(deployed, 'dashboard-deploy'), operationEvidence(started, 'dashboard-start')] }
    let hostResult: Awaited<ReturnType<LocalDashboardHost['publish']>> | undefined
    if (this.host) {
      try { hostResult = await this.host.publish({ applicationId: this.applicationId, versionId: this.versionId, ticker: input.ticker, marketData: input.marketData, reports: input.reports, analysis: input.analysis }) } catch (error) { return { status: 'unknown', error: { code: 'DASHBOARD_HOST_PUBLISH_FAILED', message: error instanceof Error ? error.message : String(error), retryable: true }, evidence: [operationEvidence(preview, 'dashboard-preview'), operationEvidence(deployed, 'dashboard-deploy'), operationEvidence(started, 'dashboard-start')] } }
    }
    const address = hostResult?.address ?? this.addressFactory?.({ applicationId: this.applicationId, versionId: this.versionId })
    const evidence = [operationEvidence(preview, 'dashboard-preview'), operationEvidence(deployed, 'dashboard-deploy'), operationEvidence(started, 'dashboard-start'), ...(hostResult ? [{ kind: 'dashboard-host', source: 'local-dashboard-host', locator: hostResult.address, summary: 'Local HTML dashboard host published', payload: hostResult }] : [])]
    const artifacts = [dashboardArtifact(this.applicationId, this.versionId), ...(hostResult ? [{ kind: 'application-dashboard-html', contentRef: hostResult.contentRef, contentHash: hostResult.contentHash, status: 'available' as const, summary: 'Generated HTML served by local dashboard host' }] : [])]
    return { status: 'succeeded', value: { applicationId: this.applicationId, versionId: this.versionId, status: 'published', ...(address ? { address } : {}), ...(hostResult?.persistentAddress ? { persistentAddress: hostResult.persistentAddress } : {}) }, evidence, artifacts }
  }

  async open(input: { applicationId: string; versionId: string; runId: string }): Promise<ProviderResult<DashboardResult>> {
    if (input.applicationId !== this.applicationId || input.versionId !== this.versionId) return { status: 'failed', error: { code: 'DASHBOARD_TARGET_MISMATCH', message: 'dashboard target does not match publisher', retryable: false } }
    const address = this.host?.open(this.applicationId, this.versionId) ?? this.addressFactory?.({ applicationId: this.applicationId, versionId: this.versionId })
    if (!address) return { status: 'unknown', error: { code: 'DASHBOARD_HOST_UNAVAILABLE', message: 'application is logically running but no local host address provider is configured', retryable: true }, artifacts: [dashboardArtifact(this.applicationId, this.versionId)] }
    return { status: 'succeeded', value: { applicationId: this.applicationId, versionId: this.versionId, status: 'running', address }, evidence: [{ kind: 'dashboard-open', source: 'local-dashboard-publisher', locator: address, summary: 'Local dashboard address resolved by host adapter', payload: { address, runId: input.runId } }], artifacts: [dashboardArtifact(this.applicationId, this.versionId)] }
  }
}
