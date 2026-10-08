import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runManifestCli } from '../src/phase1_cli.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
await runManifestCli({ root, entrypoint: 'all' })
