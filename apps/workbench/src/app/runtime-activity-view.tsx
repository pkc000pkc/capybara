import { useMemo, useState } from 'react'
import { activityStatus, activityTime, readableValue, type ActivityRow } from './runtime-activity'
import { MessageBody } from './message-body'

type GovernanceRecord = { id: string; [key: string]: unknown }

function governanceSummary(record: GovernanceRecord): string {
  const parts = [
    typeof record.status === 'string' ? record.status : undefined,
    typeof record.kind === 'string' ? record.kind : undefined,
    typeof record.actor === 'string' ? record.actor : undefined,
    typeof record.referenceId === 'string' ? record.referenceId : undefined,
    typeof record.result === 'string' ? record.result : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : '已记录'
}

function GovernanceRecords({ title, records, empty }: { title: string; records: GovernanceRecord[]; empty: string }) {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copy = async (record: GovernanceRecord) => {
    const text = JSON.stringify(record, null, 2)
    try {
      const nativeBridge = typeof window !== 'undefined' ? window.capybaraDesktop : undefined
      if (nativeBridge?.copyText) {
        await nativeBridge.copyText({ text })
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('clipboard copy failed')
      }
      setCopiedId(record.id)
    } catch {
      try {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        const copied = document.execCommand('copy')
        textarea.remove()
        if (!copied) throw new Error('clipboard copy failed')
        setCopiedId(record.id)
      } catch {
        setCopiedId(null)
      }
    }
  }
  return <section className="wb-utility-section"><h3>{title} · {records.length}</h3>{records.length === 0 ? <p className="wb-app-note">{empty}</p> : records.map((record) => <details className="wb-governance-record" key={record.id}>
    <summary><span>{record.id}</span><strong>{governanceSummary(record)}</strong></summary>
    <div className="wb-governance-record-actions"><button type="button" onClick={() => void copy(record)}>{copiedId === record.id ? '已复制' : '复制 JSON'}</button></div>
    <pre>{readableValue(record, 8000)}</pre>
  </details>)}</section>
}

export function RuntimeGovernanceView({ candidates = [], evidence = [], receipts = [], applicationReceipts = [], reviewReceipts = [], evidenceReviews = [] }: {
  candidates?: GovernanceRecord[]
  evidence?: GovernanceRecord[]
  receipts?: GovernanceRecord[]
  applicationReceipts?: GovernanceRecord[]
  reviewReceipts?: GovernanceRecord[]
  evidenceReviews?: GovernanceRecord[]
}) {
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLowerCase()
  const filter = (records: GovernanceRecord[]) => normalizedQuery
    ? records.filter((record) => readableValue(record, 12_000).toLowerCase().includes(normalizedQuery))
    : records
  const counts = useMemo(() => ({
    candidates: filter(candidates).length,
    evidence: filter(evidence).length,
    receipts: filter(receipts).length,
    applicationReceipts: filter(applicationReceipts).length,
    reviewReceipts: filter(reviewReceipts).length,
    evidenceReviews: filter(evidenceReviews).length,
  }), [candidates, evidence, receipts, applicationReceipts, reviewReceipts, evidenceReviews, normalizedQuery])
  return <div className="wb-governance-view">
    <div className="wb-governance-toolbar"><label>筛选治理记录<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入 ID、状态、来源或工具名" /></label><span>{counts.candidates + counts.evidence + counts.receipts + counts.applicationReceipts + counts.reviewReceipts + counts.evidenceReviews} 条匹配</span></div>
    <GovernanceRecords title="候选信息" records={filter(candidates)} empty="当前没有候选信息。" />
    <GovernanceRecords title="证据引用" records={filter(evidence)} empty="当前没有证据引用。" />
    <GovernanceRecords title="应用收据" records={filter(receipts)} empty="当前没有上下文应用收据。" />
    <GovernanceRecords title="应用生命周期收据" records={filter(applicationReceipts)} empty="当前没有应用生命周期收据。" />
    <GovernanceRecords title="候选审核收据" records={filter(reviewReceipts)} empty="当前没有候选审核收据。" />
    <GovernanceRecords title="证据审核结果" records={filter(evidenceReviews)} empty="当前没有证据审核结果。" />
  </div>
}

export function RuntimeActivityRows({ rows, compact = false }: { rows: ActivityRow[]; compact?: boolean }) {
  return <ol className={`wb-trace-list${compact ? ' compact' : ''}`} aria-label="执行时间线">
    {rows.map((row) => <li className={`wb-trace-step${compact ? ' wb-trace-step-compact' : ''}`} key={row.id} data-status={row.status} data-child={!!row.parentTurnId} data-kind={row.kind}>
      <div className="wb-trace-title"><span>{row.parentTurnId ? '子代理 · ' : ''}{row.kind === 'tool' ? '工具 · ' : ''}{row.label}</span><strong>{activityStatus(row.status)}</strong></div>
      <div className="wb-trace-timing">{activityTime(row.startedAt)}{row.completedAt ? ` → ${activityTime(row.completedAt)}` : ''}{row.durationMs !== undefined ? ` · ${row.durationMs} ms` : ''}</div>
      {compact ? <p className="wb-trace-compact-summary">{row.summary || row.reasoningSummary || (row.kind === 'tool' ? `工具 ${row.label} 已${row.status === 'running' ? '开始' : '处理'}` : '模型正在整理下一步')}</p> : <>
        {row.summary && <p className="wb-trace-summary">{row.summary}</p>}
        {row.reasoningSummary && <p className="wb-trace-narrative">公开思考摘要：{row.reasoningSummary}</p>}
        {row.text && (row.text.length > 360 && row.status !== 'running'
          ? <details><summary>查看模型工作说明</summary><MessageBody text={row.text} /></details>
          : <MessageBody text={row.text} />)}
      </>}
      {row.error !== undefined && (compact ? <p role="status" className="wb-trace-compact-error">{readableValue(row.error, 240)}</p> : <pre role="status" className="wb-trace-error">{readableValue(row.error, 1800)}</pre>)}
      {(row.arguments !== undefined || row.result !== undefined || row.receipt !== undefined || row.artifactId || row.stepId) && <details>
        <summary>参数、结果与依据</summary>
        {row.arguments !== undefined && <><b>调用参数</b><pre>{readableValue(row.arguments)}</pre></>}
        {row.result !== undefined && <><b>工具结果</b><pre>{readableValue(row.result)}</pre></>}
        {row.receipt !== undefined && <><b>运行收据</b><pre>{readableValue(row.receipt)}</pre></>}
        {row.fileChanges !== undefined && <><b>文件核对（执行前 / 后）</b><pre>{readableValue(row.fileChanges)}</pre></>}
        {row.artifactId && <p className="wb-trace-reference">证据：{row.artifactId}<br />SHA-256：{row.hash || '待归档'}</p>}
        <p className="wb-trace-reference">轮次：{row.turnId || '—'}<br />步骤：{row.stepId || '—'}{row.callId && <><br />调用：{row.callId}</>}{row.consumedByStepId && <><br />结果用于：{row.consumedByStepId}</>}</p>
      </details>}
    </li>)}
  </ol>
}
