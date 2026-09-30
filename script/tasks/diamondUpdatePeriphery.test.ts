/**
 * Which proposal `diamondUpdatePeriphery` creates for a registration.
 *
 * Drives the real function with the chain and the proposers stubbed, while the
 * route decision runs for real: `--preflight` is the only call let through to
 * `proposePeripheryWithWhitelist.ts`, and it reads the committed config. So
 * what these cases pin is the placement — the Safe branch hands a diamond-called
 * registration to the paired proposer, and refuses before any proposal when
 * `config/whitelist.json` does not cover it.
 */
import { spawnSync } from 'child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
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

import { withholdCredentials } from '../deploy/safe/spawn-env'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const TASK = join(REPO_ROOT, 'script', 'tasks', 'diamondUpdatePeriphery.sh')
const TIMEOUT_MS = 90_000 // 90 seconds: each preflight starts a tsx process

const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
// Not in config/whitelist.json for any network, so the whitelist cannot cover it.
const UNLISTED = '0x00000000000000000000000000000000c0ffee01'

interface IWhitelistFile {
  PERIPHERY: Record<string, { name: string; address: string }[]>
}

const listedTokenWrapper = (): string => {
  const whitelist = JSON.parse(
    readFileSync(join(REPO_ROOT, 'config', 'whitelist.json'), 'utf8')
  ) as IWhitelistFile
  const entry = whitelist.PERIPHERY.fuse?.find((e) => e.name === 'TokenWrapper')
  if (!entry)
    throw new Error('fixture: fuse TokenWrapper absent from whitelist.json')
  return entry.address
}

let sandbox: string

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'diamond-update-periphery-'))
  for (const link of ['script', 'config', 'node_modules', 'package.json'])
    symlinkSync(join(REPO_ROOT, link), join(sandbox, link))
  mkdirSync(join(sandbox, 'deployments'))
})

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

const run = (options: {
  contracts: Record<string, string>
  environment?: string
  debug?: boolean
}): { out: string; rc: number } => {
  writeFileSync(
    join(sandbox, 'deployments', 'fuse.json'),
    JSON.stringify({ LiFiDiamond: DIAMOND, ...options.contracts })
  )
  const harness = `
    source "$TASK"
    source() { return 0; }
    error() { echo "[error] $*"; }
    warning() { echo "[warning] $*"; }
    echoDebug() { :; }
    getFileSuffix() { echo ""; }
    getPeripheryAddressFromDiamond() { echo "0x0000000000000000000000000000000000000000"; }
    isTestnetNetwork() { return 1; }
    verifySelectorMatchesSignature() { return 0; }
    doNotContinueUnlessGasIsBelowThreshold() { :; }
    getRPCUrl() { echo "http://127.0.0.1:1"; }
    getPrivateKey() { echo "0xkey"; }
    getContractAddressFromDeploymentLogs() { echo "${DIAMOND}"; }
    redactRpcUrl() { echo "redacted"; }
    cast() { case "$1" in codesize) echo 100 ;; calldata) echo 0xabcdef ;; estimate) echo 1000 ;; esac; }
    saveDiamondPeriphery() { echo "SAVED_LOG"; }
    universalCast() { echo "DIRECT_SEND $*"; }
    bun() { echo "PLAIN_PROPOSE $*"; }
    bunx() {
      if [[ " $* " == *" --preflight "* ]]; then command bunx "$@"; else echo "PAIRED_PROPOSE $*"; fi
    }
    MAX_ATTEMPTS_PER_SCRIPT_EXECUTION=1
    DEBUG="${options.debug ? 'true' : 'false'}"
    diamondUpdatePeriphery fuse "${
      options.environment ?? 'production'
    }" LiFiDiamond false false "${Object.keys(options.contracts).join(
    ' '
  )}" 2>&1
    echo "rc=$?"
  `
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TASK,
    SEND_PROPOSALS_DIRECTLY_TO_DIAMOND: '',
  }
  // `bun test` sets NODE_ENV=test, under which consola drops the preflight's info lines.
  delete env.NODE_ENV
  withholdCredentials(env)
  const result = spawnSync('bash', ['-c', harness], {
    cwd: sandbox,
    encoding: 'utf8',
    env,
    timeout: TIMEOUT_MS,
  })
  const out = `${result.stdout}${result.stderr}`
  const rc = Number(/rc=(\d+)\s*$/.exec(out)?.[1] ?? -1)
  return { out, rc }
}

describe('diamondUpdatePeriphery on the Safe route', () => {
  it(
    'proposes a diamond-called registration through the paired proposer',
    () => {
      const address = listedTokenWrapper()
      const { out, rc } = run({ contracts: { TokenWrapper: address } })
      expect(out).toContain(
        `PAIRED_PROPOSE tsx script/tasks/proposePeripheryWithWhitelist.ts --contract TokenWrapper --networks fuse --address ${address} --diamond ${DIAMOND}`
      )
      expect(out).not.toContain('PLAIN_PROPOSE')
      expect(out).not.toContain('DIRECT_SEND')
      expect(rc).toBe(0)
    },
    TIMEOUT_MS
  )

  it(
    'takes the same route with DEBUG on',
    () => {
      const { out } = run({
        contracts: { TokenWrapper: listedTokenWrapper() },
        debug: true,
      })
      expect(out).toContain('PAIRED_PROPOSE')
      expect(out).not.toContain('PLAIN_PROPOSE')
    },
    TIMEOUT_MS
  )

  it(
    'leaves a name outside whitelistPeripheryFunctions on propose-to-safe',
    () => {
      const { out, rc } = run({ contracts: { FeeCollector: UNLISTED } })
      expect(out).toContain(
        'PLAIN_PROPOSE script/deploy/safe/propose-to-safe.ts'
      )
      expect(out).not.toContain('PAIRED_PROPOSE')
      expect(rc).toBe(0)
    },
    TIMEOUT_MS
  )

  it(
    'leaves an out-of-scope LiFiDEXAggregator on propose-to-safe',
    () => {
      const { out, rc } = run({ contracts: { LiFiDEXAggregator: UNLISTED } })
      expect(out).toContain('out-of-scope')
      expect(out).toContain('PLAIN_PROPOSE')
      expect(out).not.toContain('PAIRED_PROPOSE')
      expect(rc).toBe(0)
    },
    TIMEOUT_MS
  )

  it(
    'refuses the whole run before any proposal while whitelist.json does not cover the address',
    () => {
      const { out, rc } = run({
        contracts: { FeeCollector: UNLISTED, TokenWrapper: UNLISTED },
      })
      expect(out).toContain('update config/whitelist.json first')
      expect(out).toContain('[error] [fuse] nothing was proposed')
      // FeeCollector alone would have been proposed (case above); the refusal
      // for TokenWrapper has to stop it too
      expect(out).not.toContain('PLAIN_PROPOSE')
      expect(out).not.toContain('PAIRED_PROPOSE')
      expect(rc).toBe(1)
    },
    TIMEOUT_MS
  )

  it(
    'splits a mixed run into one plain and one paired proposal',
    () => {
      const { out, rc } = run({
        contracts: {
          FeeCollector: UNLISTED,
          TokenWrapper: listedTokenWrapper(),
        },
      })
      expect(out.match(/PLAIN_PROPOSE/g)?.length).toBe(1)
      expect(out.match(/PAIRED_PROPOSE/g)?.length).toBe(1)
      expect(out).toContain('--contract TokenWrapper ')
      expect(rc).toBe(0)
    },
    TIMEOUT_MS
  )
})

describe('diamondUpdatePeriphery off the Safe route', () => {
  it(
    'still broadcasts directly on staging and consults no proposer',
    () => {
      const { out } = run({
        contracts: { TokenWrapper: UNLISTED },
        environment: 'staging',
        // the quiet branch sends its output to /dev/null
        debug: true,
      })
      expect(out).toContain('DIRECT_SEND send fuse staging')
      expect(out).not.toContain('PAIRED_PROPOSE')
      expect(out).not.toContain('PLAIN_PROPOSE')
      expect(out).not.toContain('update config/whitelist.json')
    },
    TIMEOUT_MS
  )
})
