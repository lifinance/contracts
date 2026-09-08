/**
 * The threshold floor on the Tron Safe deployment, judged against the network
 * and configuration the script itself feeds the guard.
 *
 * `safe-deploy-guards.test.ts` covers what the guard decides. What this adds is
 * the pair of things only the call site can be wrong about: the inputs
 * `deploy-safe-tron.ts` supplies, and where in `run()` the refusal happens.
 *
 * The script is never executed here, not even to be refused: its default path
 * deploys a Safe with the production key, so the ordering claim is read off the
 * source and every anchor it matches is asserted unique — a rename breaks this
 * file rather than quietly satisfying it.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import { isTestnetNetwork } from '../../utils/viemScriptHelpers'
import {
  assertSafeThresholdFloor,
  evaluateSafeThresholdFloor,
} from '../safe/safe-deploy-guards'
import { SAFE_THRESHOLD } from '../shared/constants'

import { TRON_DEPLOY_NETWORK } from './constants'

const configOwners = globalConfig.safeOwners as string[]

const tronEntry = (
  networks as Record<string, { type?: string; safeAddress?: string }>
)[TRON_DEPLOY_NETWORK]

const source = readFileSync(
  join(import.meta.dir, 'deploy-safe-tron.ts'),
  'utf8'
)

const soleIndex = (needle: string): number => {
  const first = source.indexOf(needle)
  expect(first, `${needle} appears in deploy-safe-tron.ts`).toBeGreaterThan(-1)
  expect(
    source.indexOf(needle, first + 1),
    `${needle} appears exactly once`
  ).toBe(-1)
  return first
}

describe('the committed config the Tron floor is judged against', () => {
  it('types the Tron deploy target as a mainnet carrying a live Safe', () => {
    expect(tronEntry?.type).toBe('mainnet')
    expect(isTestnetNetwork(TRON_DEPLOY_NETWORK)).toBe(false)
    expect(tronEntry?.safeAddress?.length).toBeGreaterThan(0)
  })

  it('declares more Safe owners than the floor requires', () => {
    expect(configOwners.length).toBeGreaterThan(SAFE_THRESHOLD)
  })
})

describe('the floor applied to the Tron deploy target', () => {
  it('refuses every threshold the owner-count check would have allowed', () => {
    for (let threshold = 1; threshold < SAFE_THRESHOLD; threshold++) {
      const verdict = evaluateSafeThresholdFloor({
        network: TRON_DEPLOY_NETWORK,
        threshold,
        isTestnet: isTestnetNetwork(TRON_DEPLOY_NETWORK),
      })
      expect(verdict.allowed, `--threshold ${threshold}`).toBe(false)
      expect(verdict.floor).toBe(SAFE_THRESHOLD)
      expect(verdict.refusal).toContain(TRON_DEPLOY_NETWORK)
    }
  })

  it('allows the threshold the CLI defaults to, and the full owner set', () => {
    for (const threshold of [SAFE_THRESHOLD, configOwners.length]) {
      const verdict = assertSafeThresholdFloor({
        network: TRON_DEPLOY_NETWORK,
        threshold,
        isTestnet: isTestnetNetwork(TRON_DEPLOY_NETWORK),
      })
      expect(verdict, `--threshold ${threshold}`).toEqual({
        allowed: true,
        floor: SAFE_THRESHOLD,
      })
    }
  })

  it('holds the CLI default at the floor rather than below it', () => {
    const defaultThreshold = Number(
      /threshold:[\s\S]{0,200}?default: '(\d+)'/.exec(source)?.[1]
    )
    expect(defaultThreshold).toBeGreaterThanOrEqual(SAFE_THRESHOLD)
  })
})

describe('where the Tron floor check sits in run()', () => {
  const guard = () => soleIndex('assertSafeThresholdFloor({')

  it('reads the testnet answer from repo config, not from a literal', () => {
    expect(source).toContain(
      'isTestnet: isTestnetNetwork(TRON_DEPLOY_NETWORK),'
    )
  })

  it('refuses before the production key is read', () => {
    expect(guard()).toBeLessThan(
      soleIndex("getEnvVar('PRIVATE_KEY_PRODUCTION')")
    )
  })

  it('refuses before the setup-only path, which sets a threshold of its own', () => {
    expect(guard()).toBeLessThan(soleIndex('if (options.setupOnly) {'))
  })

  it('leaves the owner-count check its own refusals, ahead of the floor', () => {
    expect(soleIndex('Threshold must be between 1 and')).toBeLessThan(guard())
  })
})
