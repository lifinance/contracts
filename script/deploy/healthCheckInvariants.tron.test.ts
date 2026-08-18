/**
 * Tron branch of the `immutable-bindings-match-config` invariant.
 *
 * Separate file because it replaces the Tron read primitive in the module registry — keeping that
 * out of `healthCheckInvariants.test.ts` stops the stub leaking into the EVM suites.
 */
import {
  beforeEach,
  describe,
  expect,
  it,
  mock,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { TronWeb } from 'tronweb'

import type {
  IHealthCheckContext,
  IHealthCheckInvariant,
} from './healthCheckInvariants'
import {
  collectImmutableBindingChecks,
  TRON_ZERO_ADDRESS_BASE58,
} from './shared/immutableBindings'
import * as tronUtils from './tron/tronUtils'

const TRON_OTHER = 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2'
const TRON_FACET = 'TVQY5uYUJHqPJ3kmpKcQmiRcaEbGvJYVfR'

/** What the stubbed `callTronContract` returns for the next `run()`. */
let onChainValue = ''

mock.module('./tron/tronUtils', () => ({
  ...tronUtils,
  // Registry lookups answer "unregistered" so the sibling periphery annotations resolve to
  // nothing and only the facet under test is compared.
  callTronContract: async (
    _contractAddress: string,
    functionSignature: string
  ) =>
    functionSignature.startsWith('getPeripheryContract')
      ? TRON_ZERO_ADDRESS_BASE58
      : onChainValue,
}))

// Imported after the stub is installed so the invariant closes over the mocked primitive.
const { HEALTH_CHECK_INVARIANTS } = await import('./healthCheckInvariants')

const invariant = HEALTH_CHECK_INVARIANTS.find(
  (i) => i.name === 'immutable-bindings-match-config'
) as IHealthCheckInvariant

// Offline: the constructor performs no network I/O, and only base58<->hex conversion is used.
const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1' })

/** Expected EcoFacet portal for Tron, taken through the collector the invariant itself uses. */
const expectedPortal = collectImmutableBindingChecks('tron', 'production').find(
  (check) => check.contractName === 'EcoFacet'
)?.expectedAddress

function makeTronCtx(): IHealthCheckContext {
  const errors: string[] = []
  const warnings: string[] = []
  return {
    networkLower: 'tron',
    environment: 'production',
    isTron: true,
    isTestnet: false,
    tronWeb,
    tronRpcUrl: 'http://127.0.0.1',
    diamondAddress: TRON_FACET,
    deployedContracts: { EcoFacet: TRON_FACET },
    coreFacetsToCheck: [],
    nonCoreFacets: ['EcoFacet'],
    onChainFacets: [{ address: TRON_FACET, selectors: ['0xffffffff'] }],
    errors,
    warnings,
    logError: (msg: string) => {
      errors.push(msg)
    },
    logWarn: (msg: string) => {
      warnings.push(msg)
    },
  } as unknown as IHealthCheckContext
}

describe('immutable-bindings-match-config on Tron', () => {
  beforeEach(() => {
    onChainValue = ''
  })

  it('eco.json has a tron portal entry in base58 (test precondition)', () => {
    expect(expectedPortal).toBeTruthy()
    expect(expectedPortal?.startsWith('T')).toBe(true)
  })

  it('passes when the base58 binding matches config', async () => {
    onChainValue = expectedPortal as string
    const ctx = makeTronCtx()

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
  })

  it('errors when the base58 binding differs from config', async () => {
    onChainValue = TRON_OTHER
    const ctx = makeTronCtx()

    await invariant.run(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('EcoFacet.PORTAL()')
    expect(ctx.errors[0]).toContain(TRON_OTHER)
    expect(ctx.errors[0]).toContain(expectedPortal as string)
  })

  it('errors on the base58 zero address rather than reading it as a real counterparty', async () => {
    onChainValue = TRON_ZERO_ADDRESS_BASE58
    const ctx = makeTronCtx()

    await invariant.run(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('zero address')
  })

  it('errors on the 41-hex zero address encoding rather than calling it malformed', async () => {
    // troncast normalizes decoded addresses to base58 today, so this encoding should not reach
    // the invariant — but the shape check must not reclassify a zero binding as "unverified",
    // which would downgrade the exact failure this invariant exists to catch.
    onChainValue = '410000000000000000000000000000000000000000'
    const ctx = makeTronCtx()

    await invariant.run(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('zero address')
  })

  it('never silently accepts a case-mangled Tron address', async () => {
    // base58 is case-significant, so a lowercased value is not the same address. It fails the
    // shape check and is reported as unverified rather than compared as if it were valid.
    onChainValue = (expectedPortal as string).toLowerCase()
    const ctx = makeTronCtx()

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings.some((w) => w.includes('left unverified'))).toBe(true)
  })
})
