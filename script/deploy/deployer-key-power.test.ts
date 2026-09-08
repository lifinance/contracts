/**
 * The assertion is exercised against the committed `config/global.json` and
 * `config/networks.json`, not fixtures — a widened copy is derived from the real files so a
 * refusal proves the check fires on the document it will actually read in CI.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import globalConfig from '../../config/global.json'
import networksConfig from '../../config/networks.json'

import {
  assertDeployerKeyPowerBounded,
  DEPLOYER_KEY_POWERS,
  DOCUMENTED_DEPLOYER_CONFIG_SLOTS,
  findDeployerConfigSlots,
  renderDeployerKeyPowerInventory,
  type IDeployerPower,
} from './deployer-key-power'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const expectRefusal = (run: () => void, match: string | RegExp): string => {
  let message: string | undefined
  try {
    run()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  if (message === undefined)
    throw new Error(`expected a refusal matching ${String(match)}, got none`)
  expect(message).toMatch(match)
  return message
}

describe('deployer key power — the committed config', () => {
  it('grants the deployer exactly the documented slots', () => {
    const slots = findDeployerConfigSlots(globalConfig, networksConfig)

    expect(slots.length).toBeGreaterThan(0)
    expect([...new Set(slots.map((s) => s.slot))].sort()).toEqual(
      [...DOCUMENTED_DEPLOYER_CONFIG_SLOTS].sort()
    )
    expect(slots.map((s) => s.path)).toEqual([
      'global.json:deployerWallet',
      'global.json:tronWallets.deployerWallet',
      'global.json:safeOwners[0]',
    ])
  })

  it('passes the bound on the real config/global.json and config/networks.json', () => {
    expect(() =>
      assertDeployerKeyPowerBounded(globalConfig, networksConfig)
    ).not.toThrow()
  })

  it('prints the inventory with every power and the resolved slots', () => {
    const rendered = renderDeployerKeyPowerInventory(
      globalConfig,
      networksConfig
    )
    for (const power of DEPLOYER_KEY_POWERS)
      expect(rendered).toContain(power.id)
    expect(rendered).toContain('global.json:safeOwners[0]')
  })
})

describe('deployer key power — a widened config refuses', () => {
  it('refuses a documented role field reassigned to the deployer', () => {
    const widened = clone(globalConfig)
    widened.pauserWallet = globalConfig.deployerWallet
    expectRefusal(
      () => assertDeployerKeyPowerBounded(widened, networksConfig),
      /undocumented grant: global\.json:pauserWallet/
    )
  })

  it('refuses a config field that did not exist when the check was written', () => {
    const widened = clone(globalConfig) as Record<string, unknown>
    widened.someNewOperatorWallet = globalConfig.deployerWallet
    expectRefusal(
      () => assertDeployerKeyPowerBounded(widened, networksConfig),
      /undocumented grant: global\.json:someNewOperatorWallet/
    )
  })

  it('refuses the deployer standing in for a network Safe', () => {
    const widened = clone(networksConfig) as Record<
      string,
      { safeAddress?: string }
    >
    const mainnet = widened.mainnet
    if (!mainnet) throw new Error('config/networks.json has no mainnet entry')
    mainnet.safeAddress = globalConfig.deployerWallet
    expectRefusal(
      () => assertDeployerKeyPowerBounded(globalConfig, widened),
      /undocumented grant: networks\.json:mainnet\.safeAddress/
    )
  })

  it('refuses the Tron identity pasted into another Tron slot', () => {
    const widened = clone(globalConfig)
    widened.tronWallets.pauserWallet = globalConfig.tronWallets.deployerWallet
    expectRefusal(
      () => assertDeployerKeyPowerBounded(widened, networksConfig),
      /undocumented grant: global\.json:tronWallets\.pauserWallet/
    )
  })

  it('refuses a duplicated owner entry, which the signature count is derived from', () => {
    const widened = clone(globalConfig)
    widened.safeOwners.push(globalConfig.deployerWallet)
    expectRefusal(
      () => assertDeployerKeyPowerBounded(widened, networksConfig),
      /occupies 2 safeOwners slots, expected exactly 1/
    )
  })

  it('reports every violation in one pass rather than only the first', () => {
    const widened = clone(globalConfig)
    widened.pauserWallet = globalConfig.deployerWallet
    widened.safeOwners.push(globalConfig.deployerWallet)
    const message = expectRefusal(
      () => assertDeployerKeyPowerBounded(widened, networksConfig),
      /undocumented grant/
    )
    expect(message).toMatch(/occupies 2 safeOwners slots/)
  })
})

describe('deployer key power — the integrity bound', () => {
  it('refuses a threshold one signature can reach', () => {
    expectRefusal(
      () =>
        assertDeployerKeyPowerBounded(globalConfig, networksConfig, {
          safeThreshold: 1,
        }),
      /the key alone reaches the threshold/
    )
  })

  it('passes at a threshold above one, so the bound is not a blanket refusal', () => {
    expect(() =>
      assertDeployerKeyPowerBounded(globalConfig, networksConfig, {
        safeThreshold: 2,
      })
    ).not.toThrow()
  })

  it('refuses an inventory claiming an integrity power in production steady state', () => {
    const promoted: IDeployerPower[] = [
      ...DEPLOYER_KEY_POWERS,
      {
        id: 'schedule-without-safe',
        power: 'Schedule a timelock operation without the Safe',
        surface: 'hypothetical',
        class: 'integrity',
        scope: 'production-mainnet',
        status: 'current',
        note: 'Would falsify R7.1.',
      },
    ]
    expectRefusal(
      () =>
        assertDeployerKeyPowerBounded(globalConfig, networksConfig, {
          powers: promoted,
        }),
      /schedule-without-safe/
    )
  })

  it('accepts the shipped inventory, whose integrity powers are all out of production steady state', () => {
    const integrity = DEPLOYER_KEY_POWERS.filter((p) => p.class === 'integrity')
    expect(integrity.length).toBeGreaterThan(0)
    for (const power of integrity)
      expect(power.scope).not.toBe('production-mainnet')
    expect(() =>
      assertDeployerKeyPowerBounded(globalConfig, networksConfig, {
        powers: DEPLOYER_KEY_POWERS,
      })
    ).not.toThrow()
  })
})

describe('deployer key power — the F7 executor row', () => {
  it('carries timelock execution as pending, not as a power held today', () => {
    const pending = DEPLOYER_KEY_POWERS.filter((p) => p.status === 'pending')
    expect(pending.map((p) => p.id)).toEqual(['timelock-execute'])
    expect(pending[0]?.note).toMatch(/EXSC-872/)
  })
})
