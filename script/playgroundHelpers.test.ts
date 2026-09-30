/**
 * `proposePeripheryContractRegistration` routes a diamond-called registration
 * through the paired proposer and proposes nothing when the preflight refuses.
 *
 * The real function runs with every proposer stubbed; the preflight answer is
 * the fixture's.
 */
import { spawnSync } from 'child_process'
import { mkdtempSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { withholdCredentials } from './deploy/safe/spawn-env'

const REPO_ROOT = join(import.meta.dir, '..')
const HELPERS = join(REPO_ROOT, 'script', 'playgroundHelpers.sh')
const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const WRAPPER = '0x254bA6498aDDA926C75d49E9909f308bFaf4720E'

let sandbox: string

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'playground-periphery-'))
  for (const link of ['script', 'config', 'node_modules', 'package.json'])
    symlinkSync(join(REPO_ROOT, link), join(sandbox, link))
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const run = (preflightRc: number): { out: string; rc: number } => {
  const harness = `
    source "$HELPERS" >/dev/null 2>&1
    error() { echo "[error] $*"; }
    success() { echo "[success] $*"; }
    validateDependencies() { return 0; }
    getContractsDirectory() { pwd; }
    getContractAddressFromDeploymentLogs() {
      if [[ "$3" == "LiFiDiamond" ]]; then echo "${DIAMOND}"; else echo "${WRAPPER}"; fi
    }
    getRPCUrl() { echo "http://127.0.0.1:1"; }
    getPrivateKey() { echo "0xkey"; }
    cast() { echo 0xabcdef; }
    bunx() {
      if [[ " $* " == *" --preflight "* ]]; then echo "PREFLIGHT $*"; return ${preflightRc}; fi
      if [[ " $* " == *"proposePeripheryWithWhitelist.ts"* ]]; then echo "PAIRED_PROPOSE $*"; return 0; fi
      echo "PLAIN_PROPOSE $*" >> proposals.log
      return 0
    }
    echo '{}' > tracking.json
    rm -f proposals.log
    # the function re-enables errexit on its way out
    if proposePeripheryContractRegistration fuse production TokenWrapper tracking.json; then RC=0; else RC=$?; fi
    cat proposals.log 2>/dev/null || true
    echo "rc=$RC"
  `
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HELPERS,
  }
  withholdCredentials(env)
  const result = spawnSync('bash', ['-c', harness], {
    cwd: sandbox,
    encoding: 'utf8',
    env,
    timeout: 30_000,
  })
  const out = `${result.stdout}${result.stderr}`
  return { out, rc: Number(/rc=(\d+)/.exec(out)?.[1] ?? -1) }
}

describe('proposePeripheryContractRegistration', () => {
  it('proposes a paired registration through the paired proposer only', () => {
    const { out, rc } = run(0)
    expect(out).toContain(
      `PAIRED_PROPOSE tsx ./script/tasks/proposePeripheryWithWhitelist.ts --contract TokenWrapper --networks fuse --address ${WRAPPER} --diamond ${DIAMOND}`
    )
    expect(out).not.toContain('PLAIN_PROPOSE')
    expect(rc).toBe(0)
  })

  it('keeps a registration that is not paired on propose-to-safe', () => {
    const { out, rc } = run(3)
    expect(out).toContain(
      'PLAIN_PROPOSE tsx ./script/deploy/safe/propose-to-safe.ts'
    )
    expect(out).not.toContain('PAIRED_PROPOSE')
    expect(rc).toBe(0)
  })

  it('proposes nothing when the preflight refuses', () => {
    const { out, rc } = run(4)
    expect(out).toContain('nothing was proposed')
    expect(out).not.toContain('PAIRED_PROPOSE')
    expect(out).not.toContain('PLAIN_PROPOSE')
    expect(rc).toBe(1)
  })
})
