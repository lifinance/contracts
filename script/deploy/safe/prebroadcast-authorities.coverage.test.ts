import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  DECLARED_STORAGE_AUTHORITIES,
  type AuthorityExpectationSource,
} from './prebroadcast-authorities'

const PERIPHERY_DIR = join(import.meta.dir, '../../../src/Periphery')
const DEPLOY_SCRIPTS_DIR = join(import.meta.dir, '../facets')

/** Base contracts that put `owner` and `pendingOwner` into a contract's storage. */
const OWNERSHIP_BASES = ['TransferrableOwnership', 'WithdrawablePeriphery']

/**
 * Periphery carrying an owner that this gate deliberately does not assert, and
 * why.
 */
const NOT_ASSERTED: Readonly<Record<string, string>> = {
  LiFiDEXAggregator:
    'deployRequirements.json declares no _owner for it, so main states no expectation to compare against',
}

/** Periphery with no owner to assert. Cross-checked against the source below. */
const NO_OWNER: Readonly<Record<string, string>> = {
  Patcher: 'holds no ownership state',
}

const peripheryNames = (): string[] =>
  readdirSync(PERIPHERY_DIR)
    .filter((file) => file.endsWith('.sol'))
    .map((file) => file.replace(/\.sol$/, ''))

const mentionsOwnershipBase = (name: string): boolean => {
  const source = readFileSync(join(PERIPHERY_DIR, `${name}.sol`), 'utf8')
  return OWNERSHIP_BASES.some((base) => source.includes(base))
}

/**
 * Every periphery contract has to be classified, whatever it inherits from.
 *
 * Enumerating the directory rather than the contracts whose declaration names
 * an ownership base: that scan reads the inheritance list, and a base reached
 * through another base — or a declaration written across several lines — is
 * one the scan does not see and therefore never asks anyone about.
 */
describe('DECLARED_STORAGE_AUTHORITIES coverage', () => {
  const periphery = peripheryNames()

  it('enumerates the periphery directory', () => {
    expect(periphery).toContain('FeeCollector')
    expect(periphery).toContain('Executor')
    expect(periphery.length).toBeGreaterThan(14)
  })

  it.each(periphery)('classifies %s', (name) => {
    const classifications = [
      DECLARED_STORAGE_AUTHORITIES[name] !== undefined,
      NOT_ASSERTED[name] !== undefined,
      NO_OWNER[name] !== undefined,
    ].filter(Boolean)
    expect(classifications).toHaveLength(1)
  })

  it.each(Object.keys(NO_OWNER))('confirms %s holds no owner', (name) => {
    expect(mentionsOwnershipBase(name)).toBe(false)
  })

  it.each(
    Object.keys(DECLARED_STORAGE_AUTHORITIES).filter((name) =>
      periphery.includes(name)
    )
  )('reads both ownership slots on %s', (name) => {
    const getters = (DECLARED_STORAGE_AUTHORITIES[name] ?? []).map(
      (authority) => authority.getter
    )
    expect(getters).toContain('owner')
    expect(getters).toContain('pendingOwner')
  })

  /**
   * The deploy script, not `deployRequirements.json`, is what actually decides
   * the owner a fresh deployment is constructed with. The two disagree — the
   * requirement file says FeeCollector takes `.withdrawWallet` while
   * `DeployFeeCollector.s.sol` passes `.feeCollectorOwner`, and the live fleet
   * follows the script — so this pins the table against the script.
   */
  it('takes every owner expectation from the contract\u2019s deploy script', () => {
    const compared: string[] = []

    for (const name of Object.keys(DECLARED_STORAGE_AUTHORITIES)) {
      const script = join(DEPLOY_SCRIPTS_DIR, `Deploy${name}.s.sol`)
      if (!existsSync(script)) continue

      const keys = [
        ...readFileSync(script, 'utf8').matchAll(
          /\.readAddress\(\s*"\.(\w+)"/g
        ),
      ]
        .map((match) => match[1])
        .filter((key) => /wallet|owner/i.test(key ?? ''))
      if (keys.length === 0) continue

      const source: AuthorityExpectationSource | undefined = (
        DECLARED_STORAGE_AUTHORITIES[name] ?? []
      ).find((authority) => authority.getter === 'owner')?.source

      expect(source?.from).toBe('globalConfig')
      expect(keys).toContain(
        source?.from === 'globalConfig' ? source.key : undefined
      )
      compared.push(name)
    }

    // An empty loop would pass while comparing nothing.
    expect(compared.length).toBeGreaterThan(10)
  })
})
