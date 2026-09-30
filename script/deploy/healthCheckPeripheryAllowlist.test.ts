/**
 * `registered-periphery-allowlisted`: the address the diamond's PeripheryRegistry resolves for a
 * `whitelistPeripheryFunctions` contract must have that contract's selectors allowlisted.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Hex } from 'viem'

import {
  HEALTH_CHECK_INVARIANTS,
  type IHealthCheckContext,
  type IHealthCheckInvariant,
} from './healthCheckInvariants'
import type { IPendingRegistration } from './safe/pending-registrations'

const DIAMOND = '0xD1A0000000000000000000000000000000000002'
const OLD_WRAPPER = '0x5215E9fd223BC909083fbdB2860213873046e45d'
const NEW_WRAPPER = '0x31F6b192Ec4a7eEF00E09ee17c36ca518c65bbfe'
const ZERO = '0x0000000000000000000000000000000000000000'
const DEPOSIT = '0xd0e30db0'
const WITHDRAW = '0x3ccfd60b'

const REQUIREMENTS = {
  TokenWrapper: [
    { selector: DEPOSIT, signature: 'deposit()' },
    { selector: WITHDRAW, signature: 'withdraw()' },
  ],
}

const allowlistInvariant = (): IHealthCheckInvariant => {
  const found = HEALTH_CHECK_INVARIANTS.find(
    (i) => i.name === 'registered-periphery-allowlisted'
  )
  if (!found) throw new Error('registered-periphery-allowlisted not registered')
  return found
}

interface IFakeChain {
  registry?: Record<string, string>
  /** `${lowercased address}:${selector}` pairs the diamond allowlists. */
  allowlisted?: string[]
  /** Error thrown by every allowlist read. */
  allowlistError?: Error
  /** Error thrown by every registry read. */
  registryError?: Error
}

function makeCtx(
  chain: IFakeChain,
  extra: Partial<IHealthCheckContext> = {}
): { ctx: IHealthCheckContext; allowlistReads: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const allowlistReads: string[] = []
  const allowlisted = new Set(chain.allowlisted ?? [])
  const ctx = {
    network: 'testnet1',
    networkLower: 'testnet1',
    environment: 'production',
    isTron: false,
    isTestnet: false,
    supportsGasZip: true,
    diamondAddress: DIAMOND,
    deployedContracts: {},
    globalConfig: { whitelistPeripheryFunctions: REQUIREMENTS },
    onChainFacets: [],
    peripheryRegistryCache: new Map(),
    pendingRegistrations: new Map(),
    publicClient: {
      readContract: async ({
        functionName,
        args,
      }: {
        functionName: string
        args: string[]
      }) => {
        if (functionName === 'getPeripheryContract') {
          if (chain.registryError) throw chain.registryError
          return chain.registry?.[args[0] ?? ''] ?? ZERO
        }
        if (functionName === 'isContractSelectorWhitelisted') {
          const key = `${String(args[0]).toLowerCase()}:${String(args[1])}`
          allowlistReads.push(key)
          if (chain.allowlistError) throw chain.allowlistError
          return allowlisted.has(key)
        }
        throw new Error(`unexpected read ${functionName}`)
      },
    },
    errors,
    warnings,
    logError: (msg: string) => {
      errors.push(msg)
    },
    logWarn: (msg: string) => {
      warnings.push(msg)
    },
    ...extra,
  } as unknown as IHealthCheckContext
  return { ctx, allowlistReads }
}

const pair = (address: string, selector: string): string =>
  `${address.toLowerCase()}:${selector}`

describe('registered-periphery-allowlisted invariant', () => {
  it('is a production-scoped error', () => {
    expect(allowlistInvariant().severity).toBe('error')
    expect(allowlistInvariant().scope.environments).toEqual(['production'])
  })

  it('passes when the registered address holds every configured selector', async () => {
    const { ctx, allowlistReads } = makeCtx({
      registry: { TokenWrapper: OLD_WRAPPER },
      allowlisted: [pair(OLD_WRAPPER, DEPOSIT), pair(OLD_WRAPPER, WITHDRAW)],
    })
    await allowlistInvariant().run(ctx)
    expect(allowlistReads.sort()).toEqual(
      [pair(OLD_WRAPPER, DEPOSIT), pair(OLD_WRAPPER, WITHDRAW)].sort()
    )
    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toEqual([])
  })

  it('errors when the registry points at an address the allowlist does not cover', async () => {
    // Gnosis after op 38: the new TokenWrapper is registered, only the old one is allowlisted.
    const { ctx } = makeCtx({
      registry: { TokenWrapper: NEW_WRAPPER },
      allowlisted: [pair(OLD_WRAPPER, DEPOSIT), pair(OLD_WRAPPER, WITHDRAW)],
    })
    await allowlistInvariant().run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('TokenWrapper')
    expect(ctx.errors[0]).toContain(NEW_WRAPPER)
    expect(ctx.errors[0]).toContain(DEPOSIT)
    expect(ctx.errors[0]).toContain(WITHDRAW)
  })

  it('names only the selector that is missing', async () => {
    const { ctx } = makeCtx({
      registry: { TokenWrapper: NEW_WRAPPER },
      allowlisted: [pair(NEW_WRAPPER, DEPOSIT)],
    })
    await allowlistInvariant().run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain(WITHDRAW)
    expect(ctx.errors[0]).not.toContain(DEPOSIT)
  })

  it('leaves an unregistered contract to periphery-registered', async () => {
    const { ctx, allowlistReads } = makeCtx({ registry: {} })
    await allowlistInvariant().run(ctx)
    expect(allowlistReads).toEqual([])
    expect(ctx.errors).toEqual([])
  })

  it('warns, never passes silently, when an allowlist read fails in transport', async () => {
    const { ctx } = makeCtx({
      registry: { TokenWrapper: NEW_WRAPPER },
      allowlistError: new Error('fetch failed'),
    })
    await allowlistInvariant().run(ctx)
    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('TokenWrapper')
    expect(ctx.warnings[0]).toContain('could not be read')
  })

  it('errors when the allowlist read reverts', async () => {
    const { ctx } = makeCtx({
      registry: { TokenWrapper: NEW_WRAPPER },
      allowlistError: new Error('execution reverted'),
    })
    await allowlistInvariant().run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('could not be read')
  })

  it('warns when the registry itself cannot be read', async () => {
    const { ctx, allowlistReads } = makeCtx({
      registryError: new Error('fetch failed'),
    })
    await allowlistInvariant().run(ctx)
    expect(allowlistReads).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('TokenWrapper')
  })

  const LDA = '0x6140b987d6B51Fd75b66C3B07733Beb5167c42fc'
  const LDA_SELECTOR = '0x2646478b'
  const scopedConfig = (networks: string[]): Partial<IHealthCheckContext> => ({
    globalConfig: {
      whitelistPeripheryFunctions: {
        ...REQUIREMENTS,
        LiFiDEXAggregator: [{ selector: LDA_SELECTOR }],
      },
      whitelistPeripheryNetworks: { LiFiDEXAggregator: networks },
    } as unknown as IHealthCheckContext['globalConfig'],
  })

  it('skips a registered contract deliberately not allowlisted on this network', async () => {
    const { ctx, allowlistReads } = makeCtx(
      { registry: { LiFiDEXAggregator: LDA } },
      scopedConfig(['lens'])
    )
    await allowlistInvariant().run(ctx)
    expect(allowlistReads).toEqual([])
    expect(ctx.errors).toEqual([])
  })

  it('requires a scoped contract on a network its scope lists', async () => {
    const { ctx, allowlistReads } = makeCtx(
      { registry: { LiFiDEXAggregator: LDA } },
      scopedConfig(['testnet1'])
    )
    await allowlistInvariant().run(ctx)
    expect(allowlistReads).toEqual([pair(LDA, LDA_SELECTOR)])
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('LiFiDEXAggregator')
  })

  it('refuses a scope naming a contract that is not diamond-called', async () => {
    const { ctx } = makeCtx(
      { registry: {} },
      {
        globalConfig: {
          whitelistPeripheryFunctions: REQUIREMENTS,
          whitelistPeripheryNetworks: { Typo: ['lens'] },
        } as unknown as IHealthCheckContext['globalConfig'],
      }
    )
    await allowlistInvariant().run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('Typo')
  })

  it('refuses a config that would require nothing', async () => {
    const { ctx } = makeCtx(
      { registry: { TokenWrapper: NEW_WRAPPER } },
      {
        globalConfig: {
          whitelistPeripheryFunctions: { TokenWrapper: [] },
        } as unknown as IHealthCheckContext['globalConfig'],
      }
    )
    await allowlistInvariant().run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('whitelistPeripheryFunctions')
  })

  const queued = (selector: Hex): IHealthCheckContext['pendingRegistrations'] =>
    new Map([
      [
        'testnet1',
        new Map<string, IPendingRegistration[]>([
          [
            NEW_WRAPPER.toLowerCase(),
            [
              {
                kind: 'whitelist',
                address: NEW_WRAPPER.toLowerCase(),
                selector,
                operationId: `0x${'ab'.repeat(32)}` as Hex,
                target: DIAMOND.toLowerCase(),
              } as IPendingRegistration,
            ],
          ],
        ]),
      ],
    ])

  it('downgrades a missing selector a queued timelock operation allowlists', async () => {
    const { ctx } = makeCtx(
      {
        registry: { TokenWrapper: NEW_WRAPPER },
        allowlisted: [pair(NEW_WRAPPER, DEPOSIT)],
      },
      { pendingRegistrations: queued(WITHDRAW) }
    )
    await allowlistInvariant().run(ctx)
    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toEqual([])
  })

  it('still errors when the queued operation allowlists a different selector', async () => {
    const { ctx } = makeCtx(
      {
        registry: { TokenWrapper: NEW_WRAPPER },
        allowlisted: [pair(NEW_WRAPPER, DEPOSIT)],
      },
      { pendingRegistrations: queued(DEPOSIT) }
    )
    await allowlistInvariant().run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain(WITHDRAW)
  })

  it('keeps the error and warns when the timelock queue is unreachable', async () => {
    const { ctx } = makeCtx(
      {
        registry: { TokenWrapper: NEW_WRAPPER },
        allowlisted: [],
      },
      { pendingRegistrations: { unreachable: 'no tunnel' } }
    )
    await allowlistInvariant().run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('no tunnel')
  })
})
