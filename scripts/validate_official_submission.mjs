import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSubmissionAuditCli } from '../src/phase2_cli.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
await runSubmissionAuditCli({ root })
