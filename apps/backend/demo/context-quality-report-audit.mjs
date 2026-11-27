import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function allAnswersPass(arm) {
  return Array.isArray(arm?.answers)
    && arm.answers.length > 0
    && arm.answers.every(answer => answer?.validShape !== false && answer.correct === answer.expected)
}

/**
 * Audit a persisted context-quality report without invoking a model or RuntimeLoop.
 * The report is an evaluation artifact, not a training target.
 */
export function auditContextQualityReport(report) {
  const failures = []
  const results = Array.isArray(report?.results) ? report.results : []
  if (!results.length) failures.push('REPORT_RESULTS_REQUIRED')
  const rows = results.map((row) => {
    const raw = row.raw
    const organized = row.organized
    const checks = {
      comparable: row.comparable === true,
      delivery: row.deliveryPassed === true || (row.deliveryPassed === undefined && allAnswersPass(raw) && allAnswersPass(organized)),
      rawAnswers: allAnswersPass(raw),
      organizedAnswers: allAnswersPass(organized),
      sourceHashes: sameJson(raw?.rawSources, organized?.rawSources),
      coverage: Number(organized?.coveredThrough ?? 0) > 0,
      noRepeatedReads: organized?.originalReadCount === raw?.originalReadCount
        && organized?.mainCalls?.every(call => call.rawReadGroups === 0),
      lowerMainInput: Number.isFinite(raw?.mainInput) && Number.isFinite(organized?.mainInput)
        && organized.mainInput < raw.mainInput,
      noFactLoss: Object.values(organized?.documentFacts ?? {}).every(Boolean),
      zeroCorrectDelta: row.comparison?.correctFieldsDelta === 0,
    }
    for (const [name, passed] of Object.entries(checks)) {
      if (!passed) failures.push(`${row.id ?? 'unknown'}:${name}`)
    }
    return { id: row.id, checks }
  })
  return {
    passed: failures.length === 0,
    scenarioCount: results.length,
    failures,
    rows,
    source: {
      mainModel: report?.mainModel,
      organizerModel: report?.organizerModel,
      promptBindings: Array.isArray(report?.promptBindings) ? report.promptBindings.length : 0,
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const reportPath = process.argv[2]
  if (!reportPath) throw new Error('Usage: node demo/context-quality-report-audit.mjs <report.json>')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const audit = auditContextQualityReport(report)
  process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`)
  if (!audit.passed) process.exitCode = 1
}
