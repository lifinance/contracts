/**
 * Which proposals `diamondUpdatePeriphery` creates for a run's registrations,
 * and in which order.
 *
 * Drives the real function with the chain and every proposer stubbed. The
 * `proposePeripheryWithWhitelist.ts` preflight is stubbed too, answering per
 * name with the exit code the fixture gives it; what the TypeScript side
 * decides is pinned in its own suite. What these cases pin is the bash
 * placement: every preflight runs before any proposal, a refusal stops the
 * whole run, each paired name gets its own proposal, and a refusal is not
 * retried.
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
const SYNC = join(REPO_ROOT, 'script', 'tasks', 'diamondSyncWhitelist.sh')
const TIMEOUT_MS = 30_000

const DIAMOND = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const NEW_WRAPPER = '0x254bA6498aDDA926C75d49E9909f308bFaf4720E'
const OLD_WRAPPER = '0x5215E9fd223BC909083fbdB2860213873046e45d'
const NEW_GASZIP = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2'
const FEE_COLLECTOR = '0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4'
const UNRELATED_DEX = '0xDef1C0ded9bec7F1a1670819833240f027b25EfF'

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
  /** Preflight exit code per name; 3 (not paired) when absent. */
  preflight?: Record<string, number>
  /** Exit code of the paired proposer. */
  proposeRc?: number
  environment?: string
  attempts?: number
  /** Bash run after diamondUpdatePeriphery, in the same shell. */
  after?: string
}): { out: string; rc: number } => {
  writeFileSync(
    join(sandbox, 'deployments', 'fuse.json'),
    JSON.stringify({ LiFiDiamond: DIAMOND, ...options.contracts })
  )
  const preflightCases = Object.entries(options.preflight ?? {})
    .map(([name, rc]) => `*" --contract ${name} "*) return ${rc} ;;`)
    .join('\n          ')
  const harness = `
    source "$TASK"
    source "$SYNC"
    source() { return 0; }
    error() { echo "[error] $*"; }
    warning() { echo "[warning] $*"; }
    echoDebug() { :; }
    getFileSuffix() { echo ""; }
    getPeripheryAddressFromDiamond() {
      if [[ "$3" == "TokenWrapper" ]]; then echo "${OLD_WRAPPER}"; else echo "0x0000000000000000000000000000000000000000"; fi
    }
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
    sleep() { :; }
    bunx() {
      if [[ " $* " == *" --preflight "* ]]; then
        echo "PREFLIGHT $*"
        case " $* " in
          ${preflightCases}
        esac
        return 3
      fi
      echo "PAIRED_PROPOSE $*"
      return ${options.proposeRc ?? 0}
    }
    MAX_ATTEMPTS_PER_SCRIPT_EXECUTION=${options.attempts ?? 1}
    DEBUG="true"
    diamondUpdatePeriphery fuse "${
      options.environment ?? 'production'
    }" LiFiDiamond false false "${Object.keys(options.contracts).join(
    ' '
  )}" 2>&1
    echo "rc=$?"
    ${options.after ?? ''}
  `
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TASK,
    SYNC,
    SEND_PROPOSALS_DIRECTLY_TO_DIAMOND: '',
  }
  withholdCredentials(env)
  const result = spawnSync('bash', ['-c', harness], {
    cwd: sandbox,
    encoding: 'utf8',
    env,
    timeout: TIMEOUT_MS,
  })
  const out = `${result.stdout}${result.stderr}`
  const rc = Number(/rc=(\d+)/.exec(out)?.[1] ?? -1)
  return { out, rc }
}

describe('diamondUpdatePeriphery on the Safe route', () => {
  it(
    'proposes a diamond-called registration through the paired proposer',
    () => {
      const { out, rc } = run({
        contracts: { TokenWrapper: NEW_WRAPPER },
        preflight: { TokenWrapper: 0 },
      })
      expect(out).toContain(
        `PREFLIGHT tsx script/tasks/proposePeripheryWithWhitelist.ts --contract TokenWrapper --networks fuse --address ${NEW_WRAPPER} --diamond ${DIAMOND} --preflight`
      )
      expect(out).toContain(
        `PAIRED_PROPOSE tsx script/tasks/proposePeripheryWithWhitelist.ts --contract TokenWrapper --networks fuse --address ${NEW_WRAPPER} --diamond ${DIAMOND}`
      )
      expect(out).not.toContain('PLAIN_PROPOSE')
      expect(out).not.toContain('DIRECT_SEND')
      expect(rc).toBe(0)
    },
    TIMEOUT_MS
  )

  it(
    'leaves a name the preflight calls not paired on propose-to-safe',
    () => {
      const { out, rc } = run({ contracts: { FeeCollector: FEE_COLLECTOR } })
      expect(out).toContain(
        'PLAIN_PROPOSE script/deploy/safe/propose-to-safe.ts'
      )
      expect(out).not.toContain('PAIRED_PROPOSE')
      expect(rc).toBe(0)
    },
    TIMEOUT_MS
  )

  it(
    'gives each paired name its own proposal',
    () => {
      const { out, rc } = run({
        contracts: { TokenWrapper: NEW_WRAPPER, GasZipPeriphery: NEW_GASZIP },
        preflight: { TokenWrapper: 0, GasZipPeriphery: 0 },
      })
      const proposals = out
        .split('\n')
        .filter((line) => line.startsWith('PAIRED_PROPOSE'))
      expect(proposals).toHaveLength(2)
      expect(proposals[0]).toContain(
        `--contract TokenWrapper --networks fuse --address ${NEW_WRAPPER} `
      )
      expect(proposals[1]).toContain(
        `--contract GasZipPeriphery --networks fuse --address ${NEW_GASZIP} `
      )
      expect(rc).toBe(0)
    },
    TIMEOUT_MS
  )

  it(
    'runs every preflight before the first proposal',
    () => {
      const { out } = run({
        contracts: {
          TokenWrapper: NEW_WRAPPER,
          FeeCollector: FEE_COLLECTOR,
          GasZipPeriphery: NEW_GASZIP,
        },
        preflight: { TokenWrapper: 0, GasZipPeriphery: 0 },
      })
      const lines = out.split('\n')
      const lastPreflight = lines.findLastIndex((l) =>
        l.startsWith('PREFLIGHT')
      )
      const firstProposal = lines.findIndex(
        (l) => l.startsWith('PAIRED_PROPOSE') || l.startsWith('PLAIN_PROPOSE')
      )
      expect(lines.filter((l) => l.startsWith('PREFLIGHT'))).toHaveLength(3)
      expect(firstProposal).toBeGreaterThan(lastPreflight)
    },
    TIMEOUT_MS
  )

  it(
    'refuses the whole run before any proposal, plain ones included, when one preflight refuses',
    () => {
      const { out, rc } = run({
        contracts: { FeeCollector: FEE_COLLECTOR, TokenWrapper: NEW_WRAPPER },
        preflight: { TokenWrapper: 4 },
      })
      expect(out).toContain('[error] [fuse] nothing was proposed')
      // FeeCollector alone would have been proposed (case above)
      expect(out).not.toContain('PLAIN_PROPOSE')
      expect(out).not.toContain('PAIRED_PROPOSE')
      expect(rc).toBe(1)
    },
    TIMEOUT_MS
  )

  it(
    'does not retry a refused paired proposal but retries a failed one',
    () => {
      const refused = run({
        contracts: { TokenWrapper: NEW_WRAPPER },
        preflight: { TokenWrapper: 0 },
        proposeRc: 4,
        attempts: 3,
      })
      const failed = run({
        contracts: { TokenWrapper: NEW_WRAPPER },
        preflight: { TokenWrapper: 0 },
        proposeRc: 1,
        attempts: 3,
      })
      expect(refused.out.match(/PAIRED_PROPOSE/g)).toHaveLength(1)
      expect(refused.out).toContain('was refused')
      expect(refused.rc).toBe(1)
      expect(failed.out.match(/PAIRED_PROPOSE/g)).toHaveLength(3)
      expect(failed.rc).toBe(1)
    },
    TIMEOUT_MS
  )
})

describe('diamondUpdatePeriphery off the Safe route', () => {
  it(
    'still broadcasts directly on staging and consults no proposer',
    () => {
      const { out } = run({
        contracts: { TokenWrapper: NEW_WRAPPER },
        preflight: { TokenWrapper: 0 },
        environment: 'staging',
      })
      expect(out).toContain('DIRECT_SEND send fuse staging')
      expect(out).not.toContain('PREFLIGHT')
      expect(out).not.toContain('PAIRED_PROPOSE')
      expect(out).not.toContain('PLAIN_PROPOSE')
    },
    TIMEOUT_MS
  )
})

describe('a whitelist sync after a paired registration in the same shell', () => {
  // As diamondSyncWhitelist's Stage 3 leaves them: the paired name's new and
  // replaced addresses, and an unrelated DEX pair on each side.
  const syncStage3 = (network: string) => `
    NEW_PAIRS=("${NEW_WRAPPER}|0xd0e30db0" "${NEW_WRAPPER}|0x3ccfd60b" "${UNRELATED_DEX}|0x12aa3caf")
    REMOVED_PAIRS=("${OLD_WRAPPER.toLowerCase()}|0xd0e30db0" "${UNRELATED_DEX}|0x2e1a7d4d")
    dropPairedRegistrationPairs ${network} production
    echo "NEW=\${NEW_PAIRS[*]}"
    echo "REMOVED=\${REMOVED_PAIRS[*]}"
  `

  it(
    'leaves the paired name out of the sync and keeps every other pair',
    () => {
      const { out } = run({
        contracts: { TokenWrapper: NEW_WRAPPER },
        preflight: { TokenWrapper: 0 },
        after: syncStage3('fuse'),
      })
      expect(out).toContain(`NEW=${UNRELATED_DEX}|0x12aa3caf\n`)
      expect(out).toContain(`REMOVED=${UNRELATED_DEX}|0x2e1a7d4d\n`)
      expect(out).toContain(
        '[info] [fuse] leaving TokenWrapper out of this sync (3 pair(s))'
      )
    },
    TIMEOUT_MS
  )

  it(
    'touches nothing on another network, or when nothing was paired',
    () => {
      const other = run({
        contracts: { TokenWrapper: NEW_WRAPPER },
        preflight: { TokenWrapper: 0 },
        after: syncStage3('gnosis'),
      })
      const plain = run({
        contracts: { FeeCollector: FEE_COLLECTOR },
        after: syncStage3('fuse'),
      })
      for (const { out } of [other, plain]) {
        expect(out).toContain(
          `NEW=${NEW_WRAPPER}|0xd0e30db0 ${NEW_WRAPPER}|0x3ccfd60b ${UNRELATED_DEX}|0x12aa3caf\n`
        )
        expect(out).not.toContain('out of this sync')
      }
    },
    TIMEOUT_MS
  )
})

describe('diamondSyncWhitelist placement', () => {
  it('drops the paired pairs after both pair lists exist and before anything is sent or proposed', () => {
    const source = readFileSync(SYNC, 'utf8')
    const call = source.indexOf(
      'dropPairedRegistrationPairs "$NETWORK" "$ENVIRONMENT"'
    )
    const removalsComputed = source.lastIndexOf('REMOVED_PAIRS+=(')
    const firstUse = source.indexOf('COMBINED_PROPOSAL_MAX_PAIRS=300')
    expect(call).toBeGreaterThan(-1)
    expect(removalsComputed).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(removalsComputed)
    expect(firstUse).toBeGreaterThan(call)
  })
})
