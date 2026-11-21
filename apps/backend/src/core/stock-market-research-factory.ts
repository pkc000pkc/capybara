import fs from 'node:fs'
import path from 'node:path'

import { ApplicationVersionLifecycle, type ApplicationManifest, type ApplicationVersion } from '#core/application-manifest'
import { ApplicationRuntimeService } from '#core/application-runtime-service'
import { LocalDashboardHost } from '#core/local-dashboard-host'
import { LocalDashboardPublisher } from '#core/local-dashboard-publisher'
import { createEastmoneyMarketDataProvider } from '#core/market-data-eastmoney-provider'
import { MarketResearchService } from '#core/market-research-service'
import { createPythonLocalAnalysisExecutor } from '#core/python-local-executor'
import { createHttpReportProvider } from '#core/report-http-provider'
import { ProductWorkLedger } from '#core/product-work-ledger'

const dashboardHosts = new Set<LocalDashboardHost>()

export async function closeDefaultMarketResearchHosts(): Promise<void> {
  await Promise.all([...dashboardHosts].map(async (host) => {
    await host.close()
    dashboardHosts.delete(host)
  }))
}

function source(projectId: string, type: 'project' | 'instruction' | 'run', id: string, relation: 'references' | 'planned-from' = 'references') {
  return { projectId, type, id, relation } as const
}

function stockManifest(projectId: string, runId: string): ApplicationManifest {
  const instruction = source(projectId, 'instruction', `market-research:${runId}`, 'planned-from')
  return {
    schemaVersion: 1, appId: 'market-dashboard', projectId, name: '本地行情看板', description: '由 Capybara 市场研究工作生成的本地复核看板。',
    stack: { runtime: 'electron', ui: 'react', language: 'typescript', node: '22' },
    source: { conversationId: `market-research:${runId}`, instructionId: instruction.id, runId, instructionVersion: 1 },
    pages: [{ pageId: 'home', route: '/', title: '行情看板', entry: 'generated/index.html', layout: 'dashboard', components: [], bindings: ['market-result'], actions: [], accessibility: { landmark: 'main', title: '行情看板', keyboardOrder: [] }, sourceRefs: [instruction] }],
    dataBindings: [{ bindingId: 'market-result', sourceKind: 'run', sourceRef: source(projectId, 'run', runId), query: 'market-research.result', shape: 'MarketResearchResult', refresh: 'on_open', freshness: 'pinned_version', fallback: 'unknown', evidenceRefs: [], sourceRefs: [instruction] }],
    actions: [],
    permissions: [{ permissionId: 'market-read', capabilityId: 'market-research', scope: { projectId }, level: 'read', grantedBy: 'system', grantedAt: new Date().toISOString(), evidenceRefs: [], sourceRefs: [instruction] }],
    assets: [], checks: [], versions: { currentDraft: null, latestGenerated: null, latestVerified: null, latestPublished: 'v1', previewVersionId: null, deployedVersionId: null, runningVersionId: null }, preview: null, deployment: null,
    runtime: { status: 'stopped', previewVersionId: null, deployedVersionId: null, runningVersionId: null }, sourceRefs: [instruction],
  }
}

function stockVersion(projectId: string, runId: string): ApplicationVersion {
  const instruction = source(projectId, 'instruction', `market-research:${runId}`, 'planned-from')
  return { versionId: 'v1', appId: 'market-dashboard', number: 1, parentVersionId: null, stage: 'published', manifestHash: `market-dashboard:${runId}`, sourceTreeHash: `market-dashboard:${runId}`, artifactHash: `market-dashboard:${runId}`, sourceRefs: [instruction], diffRefs: [], checkRefs: [], previewRef: null, approvalRef: `market-research:${runId}`, createdAt: new Date().toISOString() }
}

function analysisScript(projectDir: string): string {
  const projectScript = path.join(projectDir, '.capybara', 'analysis', '000682_analysis.py')
  if (fs.existsSync(projectScript) && fs.statSync(projectScript).isFile()) return projectScript
  const userScript = path.join(projectDir, '000682_analysis.py')
  if (fs.existsSync(userScript) && fs.statSync(userScript).isFile()) return userScript
  const managedScript = path.resolve(import.meta.dirname, '../../../../examples/stock-analysis/000682_analysis.py')
  fs.mkdirSync(path.dirname(projectScript), { recursive: true })
  fs.copyFileSync(managedScript, projectScript, fs.constants.COPYFILE_EXCL)
  return projectScript
}

export function createDefaultMarketResearchService(input: { projectPath: string; projectId: string; runId: string }): MarketResearchService {
  const projectPath = path.resolve(input.projectPath)
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) throw new Error(`project directory was not found: ${projectPath}`)
  // Run ids are protocol identifiers and commonly contain `:`. They must not
  // be used verbatim as Windows directory names because `:` is reserved
  // outside the drive prefix. Keep the original id in receipts and evidence,
  // and only normalize the local quarantine path.
  const safeRunId = input.runId.replace(/[^a-zA-Z0-9._-]+/g, '_')
  const manifest = stockManifest(input.projectId, input.runId)
  const lifecycle = new ApplicationVersionLifecycle(manifest, [stockVersion(input.projectId, input.runId)])
  const ledger = new ProductWorkLedger({ projectId: input.projectId, actor: { type: 'capability-adapter', id: 'market-research-default' } })
  const runtime = new ApplicationRuntimeService({ manifest, lifecycle, ledger, defaultRunId: input.runId })
  const dashboardHost = new LocalDashboardHost({ storageDir: path.join(projectPath, '.capybara', 'runtime', 'research', safeRunId, 'dashboard') })
  dashboardHosts.add(dashboardHost)
  const dashboard = new LocalDashboardPublisher({ service: runtime, applicationId: 'market-dashboard', versionId: 'v1', host: dashboardHost })
  return new MarketResearchService({ ledger, actor: { type: 'capability-adapter', id: 'market-research-default' }, providers: {
    marketData: createEastmoneyMarketDataProvider(), reports: createHttpReportProvider({ projectRoot: projectPath, quarantineRoot: path.join(projectPath, '.capybara', 'runtime', 'research', safeRunId) }),
    python: createPythonLocalAnalysisExecutor({ workspaceDir: projectPath, scriptPath: analysisScript(projectPath), pythonExecutable: process.platform === 'win32' ? 'py' : 'python3' }), dashboard,
  } })
}
