/**
 * The Safe deployment guards.
 *
 * Each refusal is paired with the configuration that must still pass, because a
 * guard that refused every deployment would satisfy the refusals alone — and
 * the command cannot be run to find out.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import { SAFE_THRESHOLD } from '../shared/constants'

import {
  assertSafeAddressOverrideAllowed,
  assertSafeThresholdFloor,
  compareOwnerSets,
  describeOwnerSetDivergence,
  evaluateSafeAddressOverride,
  evaluateSafeThresholdFloor,
} from './safe-deploy-guards'

const ZERO = '0x0000000000000000000000000000000000000000'

const configOwners = globalConfig.safeOwners as string[]

const networkEntries = Object.entries(
  networks as Record<string, { safeAddress?: string; type?: string }>
)

const mainnetWithSafe = networkEntries.filter(
  ([, entry]) =>
    entry.type !== 'testnet' &&
    typeof entry.safeAddress === 'string' &&
    entry.safeAddress.length > 0 &&
    entry.safeAddress !== ZERO
)

const testnets = networkEntries.filter(([, entry]) => entry.type === 'testnet')

const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined)
    throw new Error(`committed config carries no ${what}`)
  return value
}

const [sampleNetwork, sampleEntry] = required(
  mainnetWithSafe[0],
  'mainnet with a Safe address'
)
const sampleSafeAddress = required(
  sampleEntry.safeAddress,
  'sample Safe address'
)
const firstConfigOwner = required(configOwners[0], 'configured Safe owner')

describe('committed config the guards are judged against', () => {
  it('declares more owners than the threshold floor requires', () => {
    expect(configOwners.length).toBeGreaterThan(SAFE_THRESHOLD)
  })

  it('names a live Safe on every mainnet, and on no testnet', () => {
    const mainnets = networkEntries.filter(
      ([, entry]) => entry.type !== 'testnet'
    )
    expect(mainnetWithSafe.length).toBe(mainnets.length)
    expect(mainnetWithSafe.length).toBeGreaterThan(0)
    expect(testnets.length).toBeGreaterThan(0)
    for (const [, entry] of testnets)
      expect(entry.safeAddress === undefined || entry.safeAddress === '').toBe(
        true
      )
  })
})

describe('evaluateSafeAddressOverride', () => {
  it('refuses every mainnet in committed config when the flag is absent', () => {
    for (const [network, entry] of mainnetWithSafe) {
      const verdict = evaluateSafeAddressOverride({
        network,
        existing: entry.safeAddress,
        allowOverride: false,
      })
      expect(verdict.occupied).toBe(true)
      expect(verdict.allowed).toBe(false)
      expect(verdict.refusal).toContain(entry.safeAddress as string)
      expect(verdict.refusal).toContain('--allowOverride')
    }
  })

  it('allows the same mainnets once the flag is stated', () => {
    for (const [network, entry] of mainnetWithSafe) {
      const verdict = evaluateSafeAddressOverride({
        network,
        existing: entry.safeAddress,
        allowOverride: true,
      })
      expect(verdict.occupied).toBe(true)
      expect(verdict.allowed).toBe(true)
      expect(verdict.refusal).toBeUndefined()
    }
  })

  it('allows bring-up on every network committed config leaves empty', () => {
    for (const [network, entry] of testnets) {
      const verdict = evaluateSafeAddressOverride({
        network,
        existing: entry.safeAddress,
        allowOverride: false,
      })
      expect(verdict.occupied).toBe(false)
      expect(verdict.allowed).toBe(true)
    }
  })

  it('treats an explicit zero address as unoccupied', () => {
    const verdict = evaluateSafeAddressOverride({
      network: 'mainnet',
      existing: ZERO,
      allowOverride: false,
    })
    expect(verdict.occupied).toBe(false)
    expect(verdict.allowed).toBe(true)
  })

  it('treats a checksummed and a lowercase address alike', () => {
    expect(
      evaluateSafeAddressOverride({
        network: 'mainnet',
        existing: sampleSafeAddress.toLowerCase(),
        allowOverride: false,
      }).allowed
    ).toBe(false)
  })
})

describe('assertSafeAddressOverrideAllowed', () => {
  it('throws for a mainnet from committed config without the flag', () => {
    expect(() =>
      assertSafeAddressOverrideAllowed({
        network: sampleNetwork,
        existing: sampleSafeAddress,
        allowOverride: false,
      })
    ).toThrow(sampleSafeAddress)
  })

  it('returns the verdict when the flag is stated', () => {
    expect(
      assertSafeAddressOverrideAllowed({
        network: sampleNetwork,
        existing: sampleSafeAddress,
        allowOverride: true,
      }).occupied
    ).toBe(true)
  })
})

describe('evaluateSafeThresholdFloor', () => {
  it('refuses every threshold under the floor on a mainnet', () => {
    for (let threshold = 1; threshold < SAFE_THRESHOLD; threshold++) {
      const verdict = evaluateSafeThresholdFloor({
        network: sampleNetwork,
        threshold,
        isTestnet: false,
      })
      expect(verdict.allowed).toBe(false)
      expect(verdict.floor).toBe(SAFE_THRESHOLD)
      expect(verdict.refusal).toContain(`--threshold ${threshold}`)
      expect(verdict.refusal).toContain(sampleNetwork)
    }
  })

  it('allows the floor itself and anything above it on every mainnet', () => {
    for (const [network] of mainnetWithSafe)
      for (const threshold of [SAFE_THRESHOLD, configOwners.length]) {
        const verdict = evaluateSafeThresholdFloor({
          network,
          threshold,
          isTestnet: false,
        })
        expect(verdict.allowed).toBe(true)
        expect(verdict.refusal).toBeUndefined()
      }
  })

  it('allows a single confirmation on a testnet but not on a mainnet', () => {
    const [testnet] = required(testnets[0], 'testnet')
    expect(
      evaluateSafeThresholdFloor({
        network: testnet,
        threshold: 1,
        isTestnet: true,
      })
    ).toEqual({ allowed: true, floor: 1 })
    expect(
      evaluateSafeThresholdFloor({
        network: testnet,
        threshold: 1,
        isTestnet: false,
      }).allowed
    ).toBe(false)
  })
})

describe('assertSafeThresholdFloor', () => {
  it('throws for one confirmation on a mainnet from committed config', () => {
    expect(() =>
      assertSafeThresholdFloor({
        network: sampleNetwork,
        threshold: 1,
        isTestnet: false,
      })
    ).toThrow(`below the ${SAFE_THRESHOLD} confirmations`)
  })

  it('refuses a threshold that is not a whole number, and says so', () => {
    // These compare above the floor while being no count of signatures at all.
    // The refusal names that, rather than telling the operator their value is
    // below a floor it in fact exceeds.
    // `1e100` is deliberately absent: it *is* a whole number, and an absurdly
    // large one is refused downstream by `threshold > owners.length`.
    for (const threshold of [3.5, 2.5, Infinity, -Infinity, NaN]) {
      expect(
        () =>
          assertSafeThresholdFloor({
            network: sampleNetwork,
            threshold,
            isTestnet: false,
          }),
        String(threshold)
      ).toThrow('not a whole number')
    }
  })

  it('returns the floor for the threshold the script defaults to', () => {
    expect(
      assertSafeThresholdFloor({
        network: sampleNetwork,
        threshold: SAFE_THRESHOLD,
        isTestnet: false,
      })
    ).toEqual({ allowed: true, floor: SAFE_THRESHOLD })
  })
})

describe('the normalisers that decide what counts as no Safe', () => {
  // `config/networks.json` is hand-edited, so these forms are reachable by a
  // typo rather than by an attack. Each one denotes *no Safe*, so reading it as
  // occupied would refuse a legitimate first deployment.
  it('reads an upper-case or padded zero address as no Safe', () => {
    for (const existing of [
      '0X0000000000000000000000000000000000000000',
      '  0x0000000000000000000000000000000000000000  ',
      '0x0000000000000000000000000000000000000000',
    ]) {
      const verdict = evaluateSafeAddressOverride({
        network: sampleNetwork,
        existing,
        allowOverride: false,
      })

      expect(verdict.occupied, existing).toBe(false)
      expect(verdict.allowed, existing).toBe(true)
    }
  })

  it('still reads a real address as occupied, however it is spelled', () => {
    // Paired presence: leniency about the zero address must not make a Safe
    // that exists look absent.
    for (const existing of [
      '0xE3C8121DF9b1c5A7d383Ab4923fF848a6510F357',
      '0xe3c8121df9b1c5a7d383ab4923ff848a6510f357',
      '  0xE3C8121DF9b1c5A7d383Ab4923fF848a6510F357  ',
      `0x${'0'.repeat(39)}1`,
    ]) {
      const verdict = evaluateSafeAddressOverride({
        network: sampleNetwork,
        existing,
        allowOverride: false,
      })

      expect(verdict.occupied, existing).toBe(true)
      expect(verdict.allowed, existing).toBe(false)
    }
  })

  it('does not treat surrounding whitespace as an owner difference', () => {
    const owner = '0xE3C8121DF9b1c5A7d383Ab4923fF848a6510F357'
    expect(compareOwnerSets([owner], [`  ${owner}  `]).matchesConfig).toBe(true)
  })
})

describe('compareOwnerSets', () => {
  it('matches the committed owner set against itself', () => {
    expect(compareOwnerSets(configOwners, configOwners)).toEqual({
      matchesConfig: true,
      absent: [],
      beyondConfig: [],
    })
  })

  it('matches across checksum casing and reordering', () => {
    const deployed = [...configOwners]
      .reverse()
      .map((owner) => owner.toUpperCase().replace('0X', '0x'))
    expect(compareOwnerSets(configOwners, deployed).matchesConfig).toBe(true)
  })

  it('reports an owner the committed config does not declare', () => {
    const intruder = '0x00000000000000000000000000000000000000ff'
    const comparison = compareOwnerSets(configOwners, [
      ...configOwners,
      intruder,
    ])
    expect(comparison.matchesConfig).toBe(false)
    expect(comparison.beyondConfig).toEqual([intruder])
    expect(comparison.absent).toEqual([])
  })

  it('reports a configured owner the Safe does not have', () => {
    const comparison = compareOwnerSets(configOwners, configOwners.slice(1))
    expect(comparison.matchesConfig).toBe(false)
    expect(comparison.absent).toEqual([firstConfigOwner.toLowerCase()])
    expect(comparison.beyondConfig).toEqual([])
  })

  it('reports both directions at once', () => {
    const intruder = '0x00000000000000000000000000000000000000ff'
    const comparison = compareOwnerSets(configOwners, [
      ...configOwners.slice(1),
      intruder,
    ])
    expect(comparison.absent).toEqual([firstConfigOwner.toLowerCase()])
    expect(comparison.beyondConfig).toEqual([intruder])
  })

  it('reports a Safe that kept one configured owner and added three', () => {
    const attackers = [
      '0x00000000000000000000000000000000000000a1',
      '0x00000000000000000000000000000000000000a2',
      '0x00000000000000000000000000000000000000a3',
    ]
    const comparison = compareOwnerSets(configOwners, [
      firstConfigOwner,
      ...attackers,
    ])
    expect(comparison.beyondConfig).toEqual(attackers)
    expect(comparison.absent).toEqual(
      configOwners.slice(1).map((owner) => owner.toLowerCase())
    )
  })
})

describe('describeOwnerSetDivergence', () => {
  it('says nothing when the deployed owners are the committed ones', () => {
    expect(
      describeOwnerSetDivergence({
        network: sampleNetwork,
        safeAddress: sampleSafeAddress,
        comparison: compareOwnerSets(configOwners, configOwners),
      })
    ).toEqual([])
  })

  it('names the network, the Safe and each undeclared owner', () => {
    const intruder = '0x00000000000000000000000000000000000000ff'
    const lines = describeOwnerSetDivergence({
      network: sampleNetwork,
      safeAddress: sampleSafeAddress,
      comparison: compareOwnerSets(configOwners, [...configOwners, intruder]),
    })
    const report = lines.join('\n')
    expect(lines.length).toBe(3)
    expect(report).toContain(sampleNetwork)
    expect(report).toContain(sampleSafeAddress)
    expect(report).toContain(intruder)
    expect(report).toContain('deliberate override')
    expect(report).not.toContain('does not have')
  })

  it('names a configured owner that is missing', () => {
    const lines = describeOwnerSetDivergence({
      network: sampleNetwork,
      safeAddress: sampleSafeAddress,
      comparison: compareOwnerSets(configOwners, configOwners.slice(1)),
    })
    const report = lines.join('\n')
    expect(lines.length).toBe(3)
    expect(report).toContain(firstConfigOwner.toLowerCase())
    expect(report).toContain('does not have')
    expect(report).not.toContain('does not declare')
  })

  it('names both directions on one report', () => {
    const intruder = '0x00000000000000000000000000000000000000ff'
    const lines = describeOwnerSetDivergence({
      network: sampleNetwork,
      safeAddress: sampleSafeAddress,
      comparison: compareOwnerSets(configOwners, [
        ...configOwners.slice(1),
        intruder,
      ]),
    })
    expect(lines.length).toBe(4)
    expect(lines.join('\n')).toContain(intruder)
    expect(lines.join('\n')).toContain(firstConfigOwner.toLowerCase())
  })
})
