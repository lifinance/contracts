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
  /** Exit code of the paired proposer, or per name. */
  proposeRc?: number | Record<string, number>
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
  const proposeCases =
    typeof options.proposeRc === 'object'
      ? Object.entries(options.proposeRc)
          .map(([name, rc]) => `*" --contract ${name} "*) return ${rc} ;;`)
          .join('\n        ')
      : ''
  const proposeDefault =
    typeof options.proposeRc === 'number' ? options.proposeRc : 0
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
    sleep() { :; }
    # Keyed on the script, not the launcher: "bun <script>" and "bunx tsx <script>"
    # must land on the same branch, or a launcher change flips the verdict.
    launch() {
      [[ "$1" == "tsx" ]] && shift
      case "$1" in
        script/deploy/safe/propose-to-safe.ts)
          echo "PLAIN_PROPOSE $*"
          return 0
          ;;
        script/tasks/proposePeripheryWithWhitelist.ts) ;;
        *)
          echo "UNEXPECTED_LAUNCH $*"
          return 1
          ;;
      esac
      if [[ " $* " == *" --preflight "* ]]; then
        echo "PREFLIGHT $*"
        case " $* " in
          ${preflightCases}
        esac
        return 3
      fi
      echo "PAIRED_PROPOSE $*"
      case " $* " in
        ${proposeCases}
      esac
      return ${proposeDefault}
    }
    bun() { launch "$@"; }
    bunx() { launch "$@"; }
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
        `PREFLIGHT script/tasks/proposePeripheryWithWhitelist.ts --contract TokenWrapper --networks fuse --address ${NEW_WRAPPER} --diamond ${DIAMOND} --preflight`
      )
      expect(out).toContain(
        `PAIRED_PROPOSE script/tasks/proposePeripheryWithWhitelist.ts --contract TokenWrapper --networks fuse --address ${NEW_WRAPPER} --diamond ${DIAMOND}`
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
      // each call knows the other name moves too, so a shared old address is removed
      for (const proposal of proposals)
        expect(proposal).toContain('--replacing TokenWrapper,GasZipPeriphery')
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
    'names what was already proposed when a later paired proposal is refused',
    () => {
      const { out, rc } = run({
        contracts: {
          FeeCollector: FEE_COLLECTOR,
          TokenWrapper: NEW_WRAPPER,
          GasZipPeriphery: NEW_GASZIP,
        },
        preflight: { TokenWrapper: 0, GasZipPeriphery: 0 },
        proposeRc: { GasZipPeriphery: 4 },
      })
      expect(out).toContain(
        '[error] [fuse] proposed before the failure: FeeCollector TokenWrapper; not proposed: GasZipPeriphery'
      )
      expect(out).not.toContain('nothing was proposed')
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

describe('diamondUpdatePeriphery preflight retries', () => {
  it(
    'retries a preflight whose chain read failed, and not one that was refused',
    () => {
      const unreadable = run({
        contracts: { TokenWrapper: NEW_WRAPPER },
        preflight: { TokenWrapper: 1 },
        attempts: 3,
      })
      const refused = run({
        contracts: { TokenWrapper: NEW_WRAPPER },
        preflight: { TokenWrapper: 4 },
        attempts: 3,
      })
      expect(unreadable.out.match(/^PREFLIGHT/gm)).toHaveLength(3)
      expect(unreadable.out).not.toContain('PAIRED_PROPOSE')
      expect(unreadable.rc).toBe(1)
      expect(refused.out.match(/^PREFLIGHT/gm)).toHaveLength(1)
      expect(refused.rc).toBe(1)
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

describe('dropRegistryDriftPairs', () => {
  // As diamondSyncWhitelist's Stage 3 leaves them: TokenWrapper's new and old
  // addresses, and an unrelated DEX pair on each side.
  const sync = (driftOutput: string, driftRc = 0) => {
    const harness = `
      source "$SYNC"
      bunx() {
        echo "DRIFT_CALL $*" >&2
        printf '%b' "$DRIFT_OUTPUT"
        return $DRIFT_RC
      }
      NEW_PAIRS=("${NEW_WRAPPER}|0xd0e30db0" "${NEW_WRAPPER}|0x3ccfd60b" "${UNRELATED_DEX}|0x12aa3caf")
      NEW_ADDRESSES=("${NEW_WRAPPER}" "${NEW_WRAPPER}" "${UNRELATED_DEX}")
      REMOVED_PAIRS=("${OLD_WRAPPER}|0xd0e30db0" "${OLD_WRAPPER}|0x3ccfd60b" "${UNRELATED_DEX}|0x2e1a7d4d")
      dropRegistryDriftPairs fuse ${DIAMOND} config/whitelist.json
      echo "rc=$?"
      echo "NEW=\${NEW_PAIRS[*]}"
      echo "ADDRESSES=\${NEW_ADDRESSES[*]}"
      echo "REMOVED=\${REMOVED_PAIRS[*]}"
    `
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      SYNC,
      DRIFT_OUTPUT: driftOutput,
      DRIFT_RC: String(driftRc),
    }
    const result = spawnSync('bash', ['-c', harness], {
      cwd: sandbox,
      encoding: 'utf8',
      env,
      timeout: TIMEOUT_MS,
    })
    return `${result.stdout}${result.stderr}`
  }
  const excludeWrapper = [NEW_WRAPPER, OLD_WRAPPER]
    .flatMap((a) =>
      ['0xd0e30db0', '0x3ccfd60b'].map((s) => `EXCLUDE ${a.toLowerCase()}|${s}`)
    )
    .join('\\n')

  it('leaves both addresses of a drifted name out and keeps every DEX pair', () => {
    const out = sync(
      `[warn] [fuse] TokenWrapper: registry points at ${OLD_WRAPPER}, config at ${NEW_WRAPPER} — left to the paired registration batch\\n${excludeWrapper}\\n`
    )
    expect(out).toContain(
      `DRIFT_CALL tsx script/tasks/whitelistRegistryDrift.ts --network fuse --diamond ${DIAMOND} --whitelist config/whitelist.json`
    )
    expect(out).toContain('rc=0')
    expect(out).toContain(`NEW=${UNRELATED_DEX}|0x12aa3caf\n`)
    expect(out).toContain(`ADDRESSES=${UNRELATED_DEX}\n`)
    expect(out).toContain(`REMOVED=${UNRELATED_DEX}|0x2e1a7d4d\n`)
    expect(out).toContain(
      `TokenWrapper: registry points at ${OLD_WRAPPER}, config at ${NEW_WRAPPER}`
    )
    expect(out).toContain('left 4 pair(s) out of this sync')
  })

  it('syncs every pair when registry and config agree', () => {
    const out = sync('')
    expect(out).toContain('rc=0')
    expect(out).toContain(
      `NEW=${NEW_WRAPPER}|0xd0e30db0 ${NEW_WRAPPER}|0x3ccfd60b ${UNRELATED_DEX}|0x12aa3caf\n`
    )
    expect(out).toContain(
      `REMOVED=${OLD_WRAPPER}|0xd0e30db0 ${OLD_WRAPPER}|0x3ccfd60b ${UNRELATED_DEX}|0x2e1a7d4d\n`
    )
    expect(out).not.toContain('out of this sync')
  })

  it('refuses the network when the registry cannot be read', () => {
    const out = sync('[error] could not read getPeripheryContract\\n', 4)
    expect(out).toContain('rc=1')
    expect(out).toContain('could not read getPeripheryContract')
  })
})

describe('diamondSyncWhitelist registry check', () => {
  // The real guard block, lifted out of the source and run with the pair lists
  // and the drift check stubbed.
  const guard = (
    pairs: { new: string[]; removed: string[] },
    driftRc: number
  ) => {
    const source = readFileSync(SYNC, 'utf8')
    const start = source.indexOf(
      // eslint-disable-next-line no-template-curly-in-string
      '    if [[ ${#NEW_PAIRS[@]} -gt 0 || ${#REMOVED_PAIRS[@]} -gt 0 ]]'
    )
    const end =
      source.indexOf('      return 1\n    fi\n', start) +
      '      return 1\n    fi\n'.length
    if (start < 0 || end < start) throw new Error('guard block not found')
    const harness = `
      dropRegistryDriftPairs() { echo "DRIFT_CALLED"; return $DRIFT_RC; }
      getWhitelistFilePath() { echo w.json; }
      f() {
        local NETWORK=fuse DIAMOND_ADDRESS=0x1 ENVIRONMENT=production FAILED_LOG_FILE=/dev/null
        NEW_PAIRS=($NEW)
        REMOVED_PAIRS=($REMOVED)
${source.slice(start, end)}
        echo "PASSED_GUARD"
      }
      f
    `
    const result = spawnSync('bash', ['-c', harness], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        NEW: pairs.new.join(' '),
        REMOVED: pairs.removed.join(' '),
        DRIFT_RC: String(driftRc),
      },
      timeout: TIMEOUT_MS,
    })
    return `${result.stdout}${result.stderr}`
  }

  it('does not read the registry when there is nothing to write', () => {
    const out = guard({ new: [], removed: [] }, 1)
    expect(out).not.toContain('DRIFT_CALLED')
    expect(out).toContain('PASSED_GUARD')
    expect(out).not.toContain('refusing to sync')
  })

  it.each([
    [{ new: ['a|0x1'], removed: [] }],
    [{ new: [], removed: ['a|0x1'] }],
  ])(
    'still refuses the network when pairs are pending and the registry cannot be read',
    (pairs) => {
      const out = guard(pairs, 1)
      expect(out).toContain('DRIFT_CALLED')
      expect(out).toContain('refusing to sync')
      expect(out).not.toContain('PASSED_GUARD')
    }
  )
})

describe('diamondSyncWhitelist placement', () => {
  it('filters after both pair lists exist, refuses the network on a failed read, and runs before anything is sent or proposed', () => {
    const source = readFileSync(SYNC, 'utf8')
    const call = source.indexOf(
      '&& ! dropRegistryDriftPairs "$NETWORK" "$DIAMOND_ADDRESS" "$(getWhitelistFilePath "$ENVIRONMENT")"; then'
    )
    const refusal = source.indexOf('return 1', call)
    const removalsComputed = source.lastIndexOf('REMOVED_PAIRS+=(')
    const firstUse = source.indexOf('COMBINED_PROPOSAL_MAX_PAIRS=300')
    expect(call).toBeGreaterThan(-1)
    expect(removalsComputed).toBeGreaterThan(-1)
    expect(call).toBeGreaterThan(removalsComputed)
    expect(refusal).toBeGreaterThan(call)
    expect(refusal).toBeLessThan(source.indexOf('fi', call) + 3)
    expect(firstUse).toBeGreaterThan(call)
  })
})

describe('regenerateWhitelistForPairedNetworks', () => {
  const regenerate = (rc: number) => {
    const harness = `
      source "$TASK"
      error() { echo "[error] $*"; }
      bunx() { echo "REGEN $*"; return ${rc}; }
      regenerateWhitelistForPairedNetworks "for TokenWrapper " fuse gnosis
      echo "rc=$?"
    `
    const result = spawnSync('bash', ['-c', harness], {
      cwd: sandbox,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', TASK },
      timeout: TIMEOUT_MS,
    })
    return `${result.stdout}${result.stderr}`
  }

  it('fails when the file cannot be regenerated, and succeeds when it can', () => {
    const failed = regenerate(1)
    const ok = regenerate(0)
    expect(failed).toContain(
      'REGEN tsx script/tasks/updateWhitelistPeriphery.ts'
    )
    expect(failed).toContain(
      '[error] could not regenerate config/whitelist.json'
    )
    expect(failed).toContain('rc=1')
    expect(ok).toContain(
      'no separate allowlist sync for TokenWrapper on fuse gnosis'
    )
    expect(ok).toContain('rc=0')
    expect(ok).not.toContain('[error]')
  })

  // Both wrappers exit through one final check; a failed regeneration must reach it.
  for (const file of [
    join(REPO_ROOT, 'script', 'deploy', 'deployContractToNetworks.sh'),
    join(REPO_ROOT, 'script', 'tasks', 'proposeContractToNetworks.sh'),
  ])
    it(`makes ${file
      .split('/')
      .pop()} exit non-zero when regeneration fails`, () => {
      const source = readFileSync(file, 'utf8')
      const call = source.indexOf('regenerateWhitelistForPairedNetworks ')
      const latch = source.indexOf('|| WHITELIST_REGEN_FAILED=true', call)
      const exit = source.indexOf(
        'if [[ $' +
          '{#FAILED_NETWORKS[@]} -gt 0 || "$WHITELIST_REGEN_FAILED" == "true" ]]; then\n    exit 1',
        latch
      )
      expect(call).toBeGreaterThan(-1)
      expect(latch).toBeGreaterThan(call)
      expect(source.slice(call, latch)).not.toContain('\n')
      expect(exit).toBeGreaterThan(latch)
      expect(source).not.toContain(
        'bunx tsx script/tasks/updateWhitelistPeriphery.ts; then'
      )
    })
})
