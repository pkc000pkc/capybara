/**
 * Renderer-facing contract for the native desktop boundary.
 *
 * The renderer receives an opaque project reference and display metadata. The
 * native path, directory handle and file contents remain in the desktop host.
 * Picking a directory never uploads or scans it.
 */
export type NativeProjectDirectorySelection = {
  projectId: string
  displayName: string
  isEmpty: boolean
  opaqueDirectoryRef: string
}

export type NativeDirectoryPickerResult =
  | { kind: 'selected'; selection: NativeProjectDirectorySelection }
  | { kind: 'cancelled' }

export type WorkbenchProjectRegistration = {
  projectId: string
  displayName: string
  isEmpty: boolean
  source: 'native-directory-picker'
}

export type RegisteredProject = WorkbenchProjectRegistration & { opaqueDirectoryRef: string }

export type ProductCapabilityState = 'available' | 'unavailable' | 'unknown'

export type ProductCapabilityStatus = {
  projectId: string
  backend: { state: ProductCapabilityState; detail: string }
  applicationRuntime: { state: ProductCapabilityState; detail: string }
  browserGateway: { state: ProductCapabilityState; detail: string }
  marketResearch: { state: ProductCapabilityState; detail: string }
}

export type MarketResearchHostResult = {
  status: string
  ticker: string
  period: { startDate: string; endDate: string }
  steps: Array<{ step: string; status: string }>
  recommendation?: { disposition: 'for_review'; stance: string; rationale: string[]; risks: string[]; uncertainties: string[] }
  application?: { applicationId: string; versionId: string; status: string; address?: string; persistentAddress?: string }
  evidence: unknown[]
  artifacts: unknown[]
}

export type BrowserReadHostResult = {
  status: string
  result?: { url?: string; title?: string; textExcerpt?: string; contentHash?: string }
  evidence?: unknown[]
  error?: { code?: string; message?: string }
}

export type BrowserSessionState = {
  browserInstanceId: string
  projectId?: string
  url: string
  title: string
  loading: boolean
  layout: 'side' | 'full'
}

export type BrowserSessionEvent = {
  type: string
  browserInstanceId: string
  projectId?: string
  timestamp?: string
  state?: BrowserSessionState
  url?: string
  title?: string
  errorCode?: number
  errorDescription?: string
  filename?: string
  [key: string]: unknown
}

export type ProjectApiInput = { opaqueDirectoryRef: string; path: string; method?: string; body?: unknown }
export type SystemModelSettings = { llm: { provider:string; model:string; base_url:string; protocol:string; api_key_configured?:boolean }; scope:'system' }

export type ApplicationManifestView = {
  appId: string
  projectId?: string
  sourceRoot: string
  start: { command: string; args: string[]; shell: boolean }
  build?: { command?: string; args?: string[]; timeoutMs?: number }
  port: { mode: string; environment: string }
  health: { path: string; timeoutMs: number; startupTimeoutMs: number }
  dataDirectory: string
  browser: { entryPath: string; allowedOrigins: string[] }
  versionId: string
}

export type ApplicationInstanceView = {
  projectId: string
  appId: string
  versionId: string
  instanceId: string
  processId: string
  pid: number | null
  port: number
  status: string
  health: { status: string; path?: string; httpStatus?: number; body?: string }
  startedAt: string
  readyAt?: string | null
  stoppedAt?: string | null
  exitCode?: number | null
  signal?: string | null
  error?: string | null
  stdout?: string
  stderr?: string
  dataDirectory: string
  browserUrl: string
  manifest?: ApplicationManifestView
  operation?: string
  previousVersionId?: string | null
  restoredVersionId?: string | null
  updateError?: string | null
}

export type ApplicationReceiptView = {
  id: string
  receiptId: string
  operation?: string
  status?: string
  timestamp?: string
  projectId?: string
  appId?: string
  versionId?: string
  instanceId?: string
  processId?: string
  turnId?: string
  stepId?: string
  callId?: string
  [key: string]: unknown
}

export type ApplicationRuntimeStatus = { manifest: ApplicationManifestView; versions?: ApplicationManifestView[]; instances: ApplicationInstanceView[]; receipts?: ApplicationReceiptView[] }

export interface SessionDirectoryItem {
  id: string
  name: string
  kind: string
  role: string
  description: string
  status: string
  capabilities: string[]
  createdAt?: string
  updatedAt?: string
  requestCount?: number
}

export interface SessionDirectorySnapshot {
  projectId: string
  revision: number
  generatedAt: string
  currentSessionId?: string
  items: SessionDirectoryItem[]
}

export interface WorkbenchNativeBridge {
  /** Canonical desktop IPC method. */
  selectProjectDirectory(): Promise<NativeDirectoryPickerResult>
  /** Compatibility alias while the initial renderer calls the picker by its older name. */
  pickProjectDirectory(): Promise<NativeDirectoryPickerResult>
  registerProjectDirectory(selection: NativeProjectDirectorySelection): Promise<WorkbenchProjectRegistration>
  listProjects(): Promise<{ items: RegisteredProject[] }>
  closeProject(input: { opaqueDirectoryRef: string }): Promise<{ closed: boolean; projectId: string; displayName: string }>
  minimizeWindow(): Promise<{ changed: boolean }>
  toggleMaximizeWindow(): Promise<{ maximized: boolean }>
  closeWindow(): Promise<{ closed: boolean }>
  copyText(input: { text: string }): Promise<{ copied: boolean }>
  prepareProjectDirectory(input: { opaqueDirectoryRef: string }): Promise<{ status: 'ready' | 'initialized'; files?: string[] }>
  getProductCapabilityStatus(input: { opaqueDirectoryRef: string }): Promise<ProductCapabilityStatus>
  runMarketResearch(input: { opaqueDirectoryRef: string; ticker: string; reportUrls: string[]; today?: string }): Promise<MarketResearchHostResult>
  loadMarketResearch(input: { opaqueDirectoryRef: string }): Promise<MarketResearchHostResult | null>
  readBrowserPage(input: { url: string }): Promise<BrowserReadHostResult>
  openBrowserSession(input: { opaqueDirectoryRef: string; browserInstanceId?: string; url: string; allowExternal: boolean; allowedOrigins: string[]; layout?: 'side' | 'full'; resume?: boolean }): Promise<{ opened: boolean; state: BrowserSessionState }>
  navigateBrowserSession(input: { opaqueDirectoryRef: string; browserInstanceId: string; url: string }): Promise<BrowserSessionState>
  controlBrowserSession(input: { opaqueDirectoryRef: string; browserInstanceId: string; action: 'back' | 'forward' | 'reload' }): Promise<BrowserSessionState>
  getBrowserSessionState(input: { opaqueDirectoryRef: string; browserInstanceId: string }): Promise<BrowserSessionState | null>
  screenshotBrowserSession(input: { opaqueDirectoryRef: string; browserInstanceId: string }): Promise<{ state: BrowserSessionState; dataUrl: string }>
  closeBrowserSession(input: { opaqueDirectoryRef: string; browserInstanceId: string }): Promise<{ closed: boolean }>
  projectApi<T = unknown>(input: ProjectApiInput): Promise<T>
  getModelSettings(): Promise<SystemModelSettings>
  saveModelSettings(input:{llm:SystemModelSettings['llm'] & {api_key?:string}}): Promise<SystemModelSettings>
  getApplicationStatus(input: { opaqueDirectoryRef: string; appId?: string }): Promise<ApplicationRuntimeStatus | null>
  startApplication(input: { opaqueDirectoryRef: string; appId?: string; manifest?: unknown; turnId?: string; stepId?: string; callId?: string }): Promise<ApplicationInstanceView>
  stopApplication(input: { opaqueDirectoryRef: string; appId?: string; instanceId?: string; reason?: string }): Promise<ApplicationInstanceView | { stopped: boolean; status: string }>
  restartApplication(input: { opaqueDirectoryRef: string; appId?: string; instanceId?: string; manifest?: unknown; turnId?: string; stepId?: string; callId?: string }): Promise<ApplicationInstanceView>
  updateApplication(input: { opaqueDirectoryRef: string; appId?: string; instanceId?: string; manifest?: unknown; turnId?: string; stepId?: string; callId?: string }): Promise<ApplicationInstanceView>
  rollbackApplication(input: { opaqueDirectoryRef: string; appId?: string; instanceId?: string; targetVersionId: string; failedVersionId?: string; reason?: string; turnId?: string; stepId?: string; callId?: string }): Promise<ApplicationInstanceView>
  healthCheckApplication(input: { opaqueDirectoryRef: string; instanceId: string }): Promise<ApplicationInstanceView>
  setApplicationLayout(input: { layout: 'side' | 'full' }): Promise<{ layout: 'side' | 'full' }>
  closeApplicationView(input: { instanceId?: string }): Promise<{ closed: boolean }>
  openApplication(input: { url?: string; opaqueDirectoryRef?: string; instanceId?: string; title?: string }): Promise<{ opened: boolean; instanceId?: string; url?: string }>
  connectRuntime(input: { opaqueDirectoryRef: string; sessionId?: string }): Promise<{ runtimeId: string; sessionId: string }>
  listRuntimeSessions(input: { opaqueDirectoryRef: string }): Promise<{ items: Array<{ id: string; name: string; createdAt?: string; updatedAt?: string; requestCount?: number; restorable?: boolean }> }>
  listSessionDirectory(input: { opaqueDirectoryRef: string }): Promise<SessionDirectorySnapshot>
  appendRuntimeMessage(input: { opaqueDirectoryRef: string; sessionId: string; role?: 'user' | 'assistant'; text: string; id?: string; requestId?: string }): Promise<{ id: string; role: 'user' | 'assistant'; status: string; content: Array<{ type: string; text: string }>; createdAt: string; completedAt: string }>
  sendSessionMessage(input: { opaqueDirectoryRef: string; sourceSessionId: string; targetSessionId: string; type?: string; payload?: { text?: string }; idempotencyKey?: string }): Promise<{ receiptId: string; messageId: string; callbackId: string; status: string; callbackText: string; target: SessionDirectoryItem; source: SessionDirectoryItem }>
  sendRuntimeFrame(input: { runtimeId: string; frame: unknown }): Promise<{ accepted: boolean }>
  readMcpInputUrl(input: { runtimeId: string; requestId: string; urlId: string }): Promise<{ url: string; host: string; message: string }>
  openMcpInputUrl(input: { runtimeId: string; requestId: string; urlId: string }): Promise<{ opened: boolean }>
  closeRuntime(input: { runtimeId: string }): Promise<{ closed: boolean }>
  onRuntimeEvent(listener: (payload: { runtimeId: string; data: string }) => void): () => void
  onRuntimeClosed(listener: (payload: { runtimeId: string; code: number; reason: string }) => void): () => void
  onApplicationEvent(listener: (payload: Record<string, unknown>) => void): () => void
  onBrowserEvent(listener: (payload: BrowserSessionEvent) => void): () => void
}

export function assertNativeDirectorySelection(value: unknown): asserts value is NativeProjectDirectorySelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('directory selection must be an object')
  const selection = value as Record<string, unknown>
  for (const key of ['projectId', 'displayName', 'opaqueDirectoryRef']) {
    if (typeof selection[key] !== 'string' || selection[key].trim().length === 0) throw new Error(`directory selection ${key} is required`)
  }
  if (typeof selection.isEmpty !== 'boolean') throw new Error('directory selection isEmpty must be boolean')
  if ('path' in selection || 'absolutePath' in selection || 'files' in selection || 'contents' in selection) {
    throw new Error('directory selection cannot expose native paths, files, or contents')
  }
}

export function createMockNativeBridge(selection: NativeProjectDirectorySelection): WorkbenchNativeBridge {
  assertNativeDirectorySelection(selection)
  return {
    async selectProjectDirectory() {
      return { kind: 'selected', selection: structuredClone(selection) }
    },
    async pickProjectDirectory() {
      return { kind: 'selected', selection: structuredClone(selection) }
    },
    async registerProjectDirectory(next) {
      assertNativeDirectorySelection(next)
      return { projectId: next.projectId, displayName: next.displayName, isEmpty: next.isEmpty, source: 'native-directory-picker' }
    },
    async listProjects() { return { items: [] } },
    async closeProject() { return { closed: false, projectId: selection.projectId, displayName: selection.displayName } },
    async minimizeWindow() { return { changed: false } },
    async toggleMaximizeWindow() { return { maximized: false } },
    async closeWindow() { return { closed: false } },
    async copyText() { return { copied: false } },
    async prepareProjectDirectory() { throw new Error('mock runtime bridge is not connected') },
    async getProductCapabilityStatus() {
      return {
        projectId: selection.projectId,
        backend: { state: 'unknown', detail: 'mock runtime bridge is not connected' },
        applicationRuntime: { state: 'unknown', detail: 'mock runtime bridge is not connected' },
        browserGateway: { state: 'unknown', detail: 'mock runtime bridge is not connected' },
        marketResearch: { state: 'unknown', detail: 'mock runtime bridge is not connected' },
      }
    },
    async runMarketResearch() { throw new Error('mock runtime bridge is not connected') },
    async loadMarketResearch() { throw new Error('mock runtime bridge is not connected') },
    async readBrowserPage() { throw new Error('mock runtime bridge is not connected') },
    async openBrowserSession() { throw new Error('mock runtime bridge is not connected') },
    async navigateBrowserSession() { throw new Error('mock runtime bridge is not connected') },
    async controlBrowserSession() { throw new Error('mock runtime bridge is not connected') },
    async getBrowserSessionState() { throw new Error('mock runtime bridge is not connected') },
    async screenshotBrowserSession() { throw new Error('mock runtime bridge is not connected') },
    async closeBrowserSession() { return { closed: false } },
    async projectApi() { throw new Error('mock runtime bridge is not connected') },
    async getModelSettings() { throw new Error('mock runtime bridge is not connected') },
    async saveModelSettings() { throw new Error('mock runtime bridge is not connected') },
    async getApplicationStatus() { throw new Error('mock runtime bridge is not connected') },
    async startApplication() { throw new Error('mock runtime bridge is not connected') },
    async stopApplication() { throw new Error('mock runtime bridge is not connected') },
    async restartApplication() { throw new Error('mock runtime bridge is not connected') },
    async updateApplication() { throw new Error('mock runtime bridge is not connected') },
    async rollbackApplication() { throw new Error('mock runtime bridge is not connected') },
    async healthCheckApplication() { throw new Error('mock runtime bridge is not connected') },
    async setApplicationLayout() { return { layout: 'side' } },
    async closeApplicationView() { return { closed: false } },
    async openApplication() { throw new Error('mock runtime bridge is not connected') },
    async connectRuntime() { throw new Error('mock runtime bridge is not connected') },
    async listRuntimeSessions() { throw new Error('mock runtime bridge is not connected') },
    async listSessionDirectory() { throw new Error('mock runtime bridge is not connected') },
    async appendRuntimeMessage() { throw new Error('mock runtime bridge is not connected') },
    async sendSessionMessage() { throw new Error('mock runtime bridge is not connected') },
    async sendRuntimeFrame() { throw new Error('mock runtime bridge is not connected') },
    async readMcpInputUrl() { throw new Error('mock runtime bridge is not connected') },
    async openMcpInputUrl() { throw new Error('mock runtime bridge is not connected') },
    async closeRuntime() { return { closed: false } },
    onRuntimeEvent() { return () => undefined },
    onRuntimeClosed() { return () => undefined },
    onApplicationEvent() { return () => undefined },
    onBrowserEvent() { return () => undefined },
  }
}
