#!/usr/bin/env node

import 'dotenv/config'

import { randomBytes } from 'node:crypto'
import path from 'node:path'

import { buildRunnerApp } from './runner-app.ts'

interface ServeOptions {
  projectDir: string
  workspaceDir?: string
  dataDir?: string
  host: string
  port: number
  token: string
  generatedToken: boolean
  allowedOrigins: string[]
}

const HELP = `Capybara local Agent runner

Usage:
  capybara serve [project-directory] [options]

Options:
  --host <host>             Bind address (default: 127.0.0.1)
  --port <port>             Listen port (default: 3210)
  --workspace <directory>   Tool workspace (default: project directory)
  --data-dir <directory>    Runtime data directory (default: .capybara/runtime)
  --token <token>           Access token (default: generated securely)
  --allow-origin <origin>   Allow a browser origin; may be repeated
  -h, --help                Show this help

Environment:
  CAPYBARA_RUNNER_TOKEN     Default access token
`

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function portNumber(value: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('port must be an integer between 0 and 65535')
  }
  return port
}

function parseServeOptions(args: string[]): ServeOptions {
  const invocationDir = path.resolve(process.env.INIT_CWD ?? process.cwd())
  let projectDir: string | undefined
  let workspaceDir: string | undefined
  let dataDir: string | undefined
  let host = '127.0.0.1'
  let port = 3_210
  let token = process.env.CAPYBARA_RUNNER_TOKEN
  const allowedOrigins: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--host') host = optionValue(args, index++, argument)
    else if (argument === '--port') port = portNumber(optionValue(args, index++, argument))
    else if (argument === '--workspace') workspaceDir = optionValue(args, index++, argument)
    else if (argument === '--data-dir') dataDir = optionValue(args, index++, argument)
    else if (argument === '--token') token = optionValue(args, index++, argument)
    else if (argument === '--allow-origin') allowedOrigins.push(optionValue(args, index++, argument))
    else if (argument?.startsWith('-')) throw new Error(`unknown option: ${argument}`)
    else if (projectDir) throw new Error(`unexpected argument: ${argument}`)
    else projectDir = argument
  }

  const generatedToken = !token
  return {
    projectDir: path.resolve(invocationDir, projectDir ?? '.'),
    ...(workspaceDir ? { workspaceDir: path.resolve(invocationDir, workspaceDir) } : {}),
    ...(dataDir ? { dataDir: path.resolve(invocationDir, dataDir) } : {}),
    host,
    port,
    token: token ?? randomBytes(24).toString('base64url'),
    generatedToken,
    allowedOrigins,
  }
}

async function serve(args: string[]): Promise<void> {
  const options = parseServeOptions(args)
  const app = await buildRunnerApp({
    projectDir: options.projectDir,
    workspaceDir: options.workspaceDir,
    dataDir: options.dataDir,
    token: options.token,
    allowedOrigins: options.allowedOrigins,
  })
  const address = await app.listen({ host: options.host, port: options.port })

  console.log(`Capybara Runner started`)
  console.log(`Agent project: ${options.projectDir}`)
  console.log(`Server: ${address}`)
  console.log(`Access token: ${options.token}${options.generatedToken ? ' (generated)' : ''}`)
  if (options.allowedOrigins.length > 0) {
    console.log(`Allowed origins: ${options.allowedOrigins.join(', ')}`)
  }

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    console.log(`Stopping Capybara Runner (${signal})`)
    await app.close()
  }
  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '-h' || command === '--help') {
    console.log(HELP)
    return
  }
  if (command !== 'serve') throw new Error(`unknown command: ${command}\n\n${HELP}`)
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP)
    return
  }
  await serve(args)
}

try {
  await main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
