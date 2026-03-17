import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { config as dotenvConfig } from 'dotenv'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '../..')

// Load repo env first (shared conventions), then allow per-dev overrides.
const repoEnvPath = path.join(repoRoot, '.env')
if (existsSync(repoEnvPath)) {
  dotenvConfig({ path: repoEnvPath })
}

// Load per-developer MCP secrets (gitignored by default).
// This avoids putting secrets into `.cursor/mcp.json`.
const envPath = path.join(repoRoot, '.env.mcp.local')
if (existsSync(envPath)) {
  dotenvConfig({ path: envPath })
}

const delimiterIndex = process.argv.indexOf('--')
if (delimiterIndex === -1 || delimiterIndex === process.argv.length - 1) {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: bunx tsx script/mcp/run.ts -- <command> [args...]\n' +
      'Example: bunx tsx script/mcp/run.ts -- npx -y @modelcontextprotocol/server-slack@latest'
  )
  process.exit(2)
}

const parts = process.argv.slice(delimiterIndex + 1)
const command = parts[0]
if (!command) process.exit(2)
const args = parts.slice(1)

const child = spawn(command, args, {
  stdio: 'inherit',
  env: process.env,
})

child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
  if (signal) process.exit(1)
  process.exit(code ?? 1)
})
