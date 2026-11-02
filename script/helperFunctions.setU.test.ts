/**
 * Pins that `script/helperFunctions.sh` survives a `set -u` caller whose `.env`
 * omits optional settings: `DEBUG` is defaulted once at load, and `getPrivateKey`
 * reports a missing key instead of aborting the shell.
 */
import { spawnSync } from 'child_process'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { withholdCredentials } from './deploy/safe/spawn-env'

const REPO_ROOT = join(import.meta.dir, '..')

interface IRun {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Loads the helpers under `set -euo pipefail` with `.env` and sibling scripts
 * skipped, so the result depends only on the environment passed in.
 * @param body - bash run after the helpers are loaded
 * @param debug - the caller's `DEBUG`; omitted means unset
 */
const runUnderSetU = (body: string, debug?: string): IRun => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  withholdCredentials(env)
  delete env.DEBUG
  if (debug !== undefined) env.DEBUG = debug

  const harness = `
    set -euo pipefail
    source() { return 0; }
    getZkToolchainPin() { echo ""; }
    . script/helperFunctions.sh
    unset -f source
    ${body}
  `
  const result = spawnSync('bash', ['-c', harness], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env,
  })
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  }
}

describe('helperFunctions.sh under set -u', () => {
  it('defaults an unset DEBUG to false, so echoDebug stays quiet', () => {
    const result = runUnderSetU('echoDebug "hidden"; echo "DEBUG=$DEBUG"')

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('DEBUG=false')
    expect(result.stderr).not.toContain('hidden')
  })

  it('keeps DEBUG=true from the caller, so echoDebug prints', () => {
    const result = runUnderSetU('echoDebug "shown"', 'true')

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('[debug] shown')
  })

  it('reports a missing PRIVATE_KEY_PRODUCTION instead of aborting', () => {
    const result = runUnderSetU(`
      unset PRIVATE_KEY_PRODUCTION
      if getPrivateKey mainnet production; then echo "returned 0"; else echo "returned $?"; fi
    `)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('could not find PRIVATE_KEY_PRODUCTION')
    expect(result.stdout).toEndWith('returned 1')
  })

  it('reports a missing PRIVATE_KEY instead of aborting', () => {
    const result = runUnderSetU(`
      unset PRIVATE_KEY
      if getPrivateKey mainnet staging; then echo "returned 0"; else echo "returned $?"; fi
    `)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('could not find PRIVATE_KEY value')
    expect(result.stdout).toEndWith('returned 1')
  })
})
