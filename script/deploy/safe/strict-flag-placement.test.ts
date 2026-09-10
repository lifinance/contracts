/**
 * Where the strict flag readers sit, not what they decide — `cli-flags.test.ts`
 * covers the decision.
 *
 * `readBooleanFlag`'s logic was already tested when these call sites moved onto
 * it, so the only new thing is the routing: that each command really refuses an
 * unreadable value before it acts. Reverting every one of those call sites back
 * to `flagIsOn` left the whole suite green, which is what this file exists to
 * stop.
 *
 * Spawns the real entry points, following `ticket-gate-placement.test.ts`.
 */

import { existsSync, rmSync } from 'fs'
import { join } from 'path'

import {
  afterAll,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

const REFUSAL = "accepts no value, 'true' or 'false'"

/**
 * Not a real network. Every command here is spawned for real, and one of them
 * deploys: pointed at a live network, a run that gets PAST the reader — which
 * is exactly what happens when someone mutation-tests these call sites — will
 * deploy a Safe and rewrite that network's `safeAddress`. A name with no
 * `ETH_NODE_URI_*` behind it stops in `setupEnvironment` before any of that,
 * and a refused run never gets there at all.
 *
 * Do not put a real network name here, even one that "obviously" cannot reach a
 * key: the spawned child re-reads the repo env file itself, so unsetting the
 * keys in this process does not take them away from it.
 */
const PROBE_NETWORK = 'zzplacementprobe'

/**
 * Set rather than deleted: bun re-loads the repo `.env` in the child for every
 * name the passed environment leaves unset, so deleting a credential hands the
 * real one back instead of withholding it.
 *
 * Malformed rather than merely wrong, so a child that reached past the reader
 * dies before it can act: a key viem cannot parse throws where a
 * valid-but-unfunded one would derive an address, and a URI the driver rejects
 * on construction throws where an unreachable host would first spend its 30 s
 * server-selection budget.
 */
const MALFORMED_KEYS = [
  'PRIVATE_KEY',
  'PRIVATE_KEY_PRODUCTION',
  'SAFE_SIGNER_PRIVATE_KEY',
] as const
const MALFORMED_KEY = 'malformed-in-tests'
const MALFORMED_STORES = ['MONGODB_URI', 'SC_MONGODB_URI'] as const
const MALFORMED_STORE = 'malformed-in-tests://no-store'

/**
 * Some of these commands transitively import generated `typechain/` types, and
 * the CI job that runs this suite does not generate them, so the child dies at
 * module load before reaching the reader. Such a run cannot judge the placement
 * either way — it is asserted as unbuilt and counted, and `judged` below keeps
 * this file from passing while judging nothing.
 */
const UNBUILT = "Cannot find module '../../../typechain'"

let judged = 0
const unjudged: string[] = []

/** 20 seconds: long enough to reach the reader, short enough that a run past it is cheap. */
const TIMEOUT_MS = 20_000

const run = (script: string, args: string[]): string => {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  }
  // `bun test` sets NODE_ENV=test; these children are exercised as CLIs.
  delete env.NODE_ENV
  // The store URIs matter as much as the keys here: `execute-pending-timelock-tx.ts`
  // opens the timelock queue in its fleet prefetch before it reads any key, so a
  // malformed key alone would not keep a run past the reader off the real queue.
  for (const name of MALFORMED_KEYS) env[name] = MALFORMED_KEY
  for (const name of MALFORMED_STORES) env[name] = MALFORMED_STORE

  const result = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, '..', '..', script), ...args],
    {
      env,
      timeout: TIMEOUT_MS,
      // stdin closed so an interactive prompt cannot hang the suite.
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    }
  )

  // A timeout-killed child is not a result: an absence-assertion would
  // otherwise pass on a run killed before the thing could appear.
  if (result.signalCode !== null && result.signalCode !== undefined)
    throw new Error(
      `child was killed by ${result.signalCode} after ${TIMEOUT_MS}ms, so its output proves nothing`
    )

  return `${result.stdout.toString()}${result.stderr.toString()}`
}

/** Enough required arguments to reach each command's body. */
const REACHABLE: Record<string, string[]> = {
  // A name no real network uses: a refused run writes nothing, but a run
  // under mutation DOES write, and it must not be able to edit a real
  // deployment log. The stray file is removed below.
  'deploy/updateDiamondLog.ts': [
    '--network',
    PROBE_NETWORK,
    '--name',
    'PlacementProbe',
    '--address',
    '0x1111111111111111111111111111111111111111',
    '--version',
    '1.0.0',
  ],
  'deploy/safe/deploy-safe.ts': ['--network', PROBE_NETWORK],
  'deploy/tron/deploy-safe-tron.ts': ['--threshold', '3'],
}

afterAll(() => {
  // Only a run that was NOT refused writes one of these, so their absence is
  // itself part of what this file asserts — but clean up either way.
  for (const suffix of ['.diamond.json', '.diamond.staging.json']) {
    const stray = join(
      import.meta.dir,
      '..',
      '..',
      '..',
      'deployments',
      `${PROBE_NETWORK}${suffix}`
    )
    if (existsSync(stray)) rmSync(stray)
  }
})

afterAll(() => {
  // add-safe-owners-and-threshold, updateDiamondLog and deploy-safe-tron (x2)
  // import no generated types, so they always reach their reader. Judging fewer
  // than four flags means a broken harness reporting success.
  expect(judged).toBeGreaterThanOrEqual(4)
  if (unjudged.length)
    console.info(
      `strict-flag placement: ${
        unjudged.length
      } flag run(s) not judged because typechain/ is absent (${unjudged.join(
        ', '
      )}); run \`bun typechain\` to cover them`
    )
})

describe('a flag whose ON widens the run refuses a value it cannot read', () => {
  it.each([
    [
      'deploy/safe/add-safe-owners-and-threshold.ts',
      'all-networks',
      'allNetworks',
    ],
    [
      'deploy/safe/add-safe-owners-and-threshold.ts',
      'ledger-live',
      'ledgerLive',
    ],
    ['deploy/safe/execute-pending-timelock-tx.ts', 'execute-all', 'executeAll'],
    ['deploy/safe/execute-pending-timelock-tx.ts', 'reject-all', 'rejectAll'],
    ['deploy/safe/deploy-safe.ts', 'allow-override', 'allowOverride'],
    ['deploy/updateDiamondLog.ts', 'is-production', 'isProduction'],
    [
      'deploy/tron/deploy-and-register-periphery.ts',
      'skip-confirmation',
      'skipConfirmation',
    ],
    [
      'deploy/tron/deploy-and-register-periphery.ts',
      'register-only',
      'registerOnly',
    ],
    ['deploy/tron/deploy-safe-tron.ts', 'allow-override', 'allowOverride'],
    ['deploy/tron/deploy-safe-tron.ts', 'setup-only', 'setupOnly'],
  ])('%s refuses --%s with a value it cannot read', (script, flag, camel) => {
    const base = REACHABLE[script] ?? []
    for (const value of ['0', 'no']) {
      // `0` and `no` are what an operator types meaning "off"; reading either
      // as on is what widens the run.
      const output = run(script, [...base, `--${flag}`, value])
      if (output.includes(UNBUILT)) {
        // Asserted, not merely skipped, so "could not judge" cannot quietly
        // cover a child that failed for some other reason.
        expect(output).toContain(UNBUILT)
        unjudged.push(`--${flag}`)
        continue
      }
      expect(output).toContain(REFUSAL)
      // Names THIS flag, which is the part a child that died earlier cannot
      // produce — and which also catches a call site wired to another flag's
      // spelling.
      expect(output).toContain(`--${camel} accepts no value`)
      judged += 1
    }
  })

  /**
   * The refusals above say a value is rejected; these say a readable one is
   * accepted AND reaches the code that acts on it, so the pair cannot both be
   * satisfied by a command that refuses everything. Only the two commands that
   * fail fast on their own arguments can show this without running a deploy.
   */
  it('accepts readable values, and uses what they resolved to', () => {
    // Both readers ran and both returned true, so the conflict check fires —
    // where the generated types this command needs are present.
    const conflict = run('deploy/safe/execute-pending-timelock-tx.ts', [
      '--execute-all',
      '--reject-all',
    ])
    if (!conflict.includes(UNBUILT))
      expect(conflict).toContain('Cannot use both --executeAll and --rejectAll')

    // The reader ran and returned false, so the "pick one" check fires. This
    // command imports no generated types, so it is judged everywhere.
    const output = run('deploy/safe/add-safe-owners-and-threshold.ts', [
      '--no-all-networks',
    ])
    expect(output).toContain(
      'Provide either --network <name> or --all-networks'
    )
    expect(output).not.toContain(REFUSAL)
  })
})
