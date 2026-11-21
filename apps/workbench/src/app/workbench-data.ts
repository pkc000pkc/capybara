export type WorkbenchMenu = {
  label: string
  items: Array<{ label: string; shortcut?: string; disabled?: boolean }>
}

export type WorkbenchSession = {
  id: string
  title: string
  subtitle: string
  status: 'working' | 'waiting' | 'paused' | 'complete'
  lastRun: string
  next: string
}

export type WorkbenchProject = {
  id: string
  name: string
  description: string
  agent: string
  responsibility: string
  sessions: WorkbenchSession[]
  selectedSessionId: string
  tokenSummary: string
}

export type WorkbenchThreadEntry =
  | { id: string; kind: 'instruction'; author: 'human'; time: string; title: string; body: string; scope?: string }
  | { id: string; kind: 'work'; author: 'agent'; time: string; title: string; body: string; status: 'done' | 'waiting' | 'active'; details?: string[] }
  | { id: string; kind: 'evidence'; author: 'agent'; time: string; title: string; body: string; source: string }

export type WorkbenchApplicationBlock =
  | { id: string; kind: 'summary'; label: string; value: string; tone?: 'default' | 'accent' | 'muted' }
  | { id: string; kind: 'list'; title: string; items: string[] }
  | { id: string; kind: 'references'; title: string; items: Array<{ label: string; meta: string; artifactId?: string; status?: string }> }
  | { id: string; kind: 'runtime'; title: string; status: 'running' | 'stopped' | 'waiting'; detail: string }

export type WorkbenchApplication = {
  id: string
  projectId: string
  name: string
  version: string
  status: 'running' | 'stopped' | 'waiting'
  address: string
  blocks: WorkbenchApplicationBlock[]
}

export const workbenchMenus: WorkbenchMenu[] = [
  { label: '文件', items: [{ label: '新会话', shortcut: 'Ctrl N' }, { label: '打开项目', shortcut: 'Ctrl O' }, { label: '项目文件' }, { label: '导出项目快照', shortcut: 'Ctrl S' }] },
  { label: '视图', items: [{ label: '项目侧栏' }, { label: '项目应用' }, { label: '深色外观' }] },
  { label: '工具', items: [{ label: '定时与触发' }, { label: '协作任务' }, { label: '进程管理' }, { label: '项目资源' }, { label: '能力演化' }, { label: '本地运行与恢复' }, { label: 'Token 用量' }, { label: '设置', shortcut: 'Ctrl ,' }] },
  { label: '帮助', items: [{ label: '关于概念稿' }] },
]

export const workbenchProjects: WorkbenchProject[] = [
  { id: 'travel', name: '周末旅行计划', description: '整理两天一晚的安排，提醒你还有哪些事情没决定。', agent: '旅行协作', responsibility: '持续整理出行资料、安排和待决定事项', selectedSessionId: 'travel-plan', tokenSummary: '128.4k tokens', sessions: [
    { id: 'travel-plan', title: '更新旅行安排', subtitle: '定时任务 · 每周五 18:00', status: 'waiting', lastRun: '今天 14:32', next: '等待下一次指示或触发' },
    { id: 'travel-materials', title: '整理新增资料', subtitle: '资料变化时触发', status: 'working', lastRun: '今天 12:50', next: '等待旅行文件夹新增资料' },
    { id: 'travel-prep', title: '出发准备清单', subtitle: '每天 09:00', status: 'complete', lastRun: '昨天 09:00', next: '完成 · 可继续补充要求' },
  ] },
  { id: 'research', name: '论文阅读', description: '把原文、引用位置和自己的想法分开整理。', agent: '阅读协作', responsibility: '持续整理论文资料、引用和阅读问题', selectedSessionId: 'research-reading', tokenSummary: '74.1k tokens', sessions: [
    { id: 'research-reading', title: '整理论文阅读清单', subtitle: '手动会话', status: 'waiting', lastRun: '昨天 17:20', next: '等待你的指示' },
    { id: 'research-notes', title: '补齐引用位置', subtitle: '手动会话', status: 'paused', lastRun: '10 月 14 日', next: '已暂停 · 等待补充资料' },
  ] },
  { id: 'home', name: '家庭账本', description: '先保留用途不明的账单，等你确认后再分类。', agent: '账本协作', responsibility: '持续整理账单、分类和待确认事项', selectedSessionId: 'home-bills', tokenSummary: '42.8k tokens', sessions: [
    { id: 'home-bills', title: '整理本月账单', subtitle: '手动会话', status: 'waiting', lastRun: '10 月 13 日', next: '等待你的指示' },
    { id: 'home-summary', title: '更新月度小结', subtitle: '每月 1 日', status: 'complete', lastRun: '10 月 1 日', next: '完成 · 下次 11 月 1 日' },
  ] },
]

export const workbenchThreadEntries: Record<string, WorkbenchThreadEntry[]> = {
  'travel-plan': [
    { id: 'travel-instruction-1', kind: 'instruction', author: 'human', time: '14:01', title: '更新旅行安排', body: '根据旅行资料更新两天一晚的安排，把未决定的事列出来，不替我预订。', scope: '当前会话' },
    { id: 'travel-work-1', kind: 'work', author: 'agent', time: '14:02', title: '已整理当前工作范围', body: '我会保留已有安排、资料来源和待决定事项，并把需要你确认的内容单独列出。', status: 'done', details: ['读取 8 份项目资料', '保留 2 个待确认事项', '没有执行预订或外部提交'] },
    { id: 'travel-evidence-1', kind: 'evidence', author: 'agent', time: '14:12', title: '资料依据已绑定', body: '住宿资料、交通时间和集合地点已回到当前项目应用。', source: '项目文件 · 旅行资料索引 v3' },
    { id: 'travel-work-2', kind: 'work', author: 'agent', time: '14:32', title: '等待你的下一步指示', body: '当前草稿已经保留。你可以继续补充要求、纠正范围，或安排下一次运行。', status: 'waiting' },
  ],
  'travel-materials': [{ id: 'travel-materials-1', kind: 'instruction', author: 'human', time: '12:50', title: '整理新增资料', body: '把新增资料加入旅行资料索引，原文件留在原处。', scope: '整个项目' }, { id: 'travel-materials-2', kind: 'work', author: 'agent', time: '13:10', title: '等待资料变化', body: '当前没有新的文件变化需要接回。', status: 'waiting' }],
  'travel-prep': [{ id: 'travel-prep-1', kind: 'instruction', author: 'human', time: '昨天 09:00', title: '检查出发准备', body: '只列出还没完成和待决定的事项。', scope: '当前会话' }, { id: 'travel-prep-2', kind: 'work', author: 'agent', time: '昨天 09:08', title: '准备清单已完成', body: '已保留 3 项待完成事项和 1 项待决定事项。', status: 'done', details: ['证件：已确认', '交通：待确认集合时间', '住宿：已保留来源'] }],
  'research-reading': [{ id: 'research-reading-1', kind: 'instruction', author: 'human', time: '昨天 17:20', title: '整理论文阅读清单', body: '先列资料缺项，保留未读标记，再按论文问题分组。', scope: '当前会话' }, { id: 'research-reading-2', kind: 'work', author: 'agent', time: '昨天 17:28', title: '阅读清单草稿已保留', body: '两篇论文仍未读取全文，原文、引用位置和想法保持分区。', status: 'waiting' }],
  'research-notes': [{ id: 'research-notes-1', kind: 'work', author: 'agent', time: '10 月 14 日', title: '等待补充资料', body: '当前工作已暂停，已有笔记和来源仍可继续查看。', status: 'waiting' }],
  'home-bills': [{ id: 'home-bills-1', kind: 'instruction', author: 'human', time: '10 月 13 日', title: '整理本月账单', body: '用途不明的账单不要自行分类，先列出需要我确认的记录。', scope: '当前会话' }, { id: 'home-bills-2', kind: 'work', author: 'agent', time: '10 月 13 日', title: '账单小结已保留', body: '三条示例账单中有一条用途待确认，未自动归类。', status: 'waiting' }],
  'home-summary': [{ id: 'home-summary-1', kind: 'work', author: 'agent', time: '10 月 1 日', title: '月度小结已完成', body: '当前小结保留三类已确认支出和两条待补充记录。', status: 'done' }],
}

export const workbenchApplications: WorkbenchApplication[] = [
  { id: 'travel-app', projectId: 'travel', name: '旅行安排工作台', version: 'v3 · 当前预览', status: 'running', address: '本地地址 · 运行中', blocks: [{ id: 'travel-summary', kind: 'summary', label: '当前状态', value: '两天一晚 · 还有 2 项待决定', tone: 'accent' }, { id: 'travel-next', kind: 'list', title: '待决定事项', items: ['确认第二天集合时间', '决定是否保留备用住宿'] }, { id: 'travel-plan', kind: 'list', title: '行程草稿', items: ['周六上午 · 抵达与入住', '周六下午 · 城市步行路线', '周日 · 集合后返程'] }, { id: 'travel-sources', kind: 'references', title: '资料来源', items: [{ label: '旅行资料索引', meta: 'v3 · 8 份资料' }, { label: '交通时间表', meta: '来源会话 · 今天 14:12' }] }, { id: 'travel-runtime', kind: 'runtime', title: '本地应用运行', status: 'running', detail: '运行版 v2 · 会话最新版 v3' }] },
  { id: 'research-app', projectId: 'research', name: '论文阅读工作台', version: 'v2 · 当前预览', status: 'stopped', address: '本地地址 · 已停止', blocks: [{ id: 'research-summary', kind: 'summary', label: '阅读状态', value: '2 篇待阅读 · 3 个引用待补齐' }, { id: 'research-next', kind: 'list', title: '接下来读', items: ['论文 A 的问题与方法', '论文 B 的结果与局限'] }, { id: 'research-runtime', kind: 'runtime', title: '本地应用运行', status: 'stopped', detail: '运行版 v1 · 尚未启动' }] },
  { id: 'home-app', projectId: 'home', name: '家庭账本工作台', version: 'v1 · 当前预览', status: 'waiting', address: '本地地址 · 等待启动', blocks: [{ id: 'home-summary', kind: 'summary', label: '账单状态', value: '3 条示例账单 · 1 条用途待确认' }, { id: 'home-next', kind: 'list', title: '需要补充', items: ['确认一条用途不明的记录', '再更新月度小结'] }, { id: 'home-runtime', kind: 'runtime', title: '本地应用运行', status: 'waiting', detail: '新版本已准备 · 等待启动' }] },
]

export function projectById(projectId: string): WorkbenchProject | undefined { return workbenchProjects.find((project) => project.id === projectId) }
export function sessionById(sessionId: string): WorkbenchSession | undefined { for (const project of workbenchProjects) { const session = project.sessions.find((item) => item.id === sessionId); if (session) return session } return undefined }
export function applicationForProject(projectId: string): WorkbenchApplication | undefined { return workbenchApplications.find((application) => application.projectId === projectId) }
