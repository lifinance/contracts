/**
 * Tron branch of `registered-periphery-allowlisted`.
 *
 * Separate file because it replaces the Tron read primitives in the module registry — keeping that
 * out of the EVM suite stops the stub leaking into it.
 */
import {
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
import * as tronUtils from './tron/tronUtils'

const TRON_DIAMOND = 'TVQY5uYUJHqPJ3kmpKcQmiRcaEbGvJYVfR'
const TRON_WRAPPER = 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2'
const DEPOSIT = '0xd0e30db0'
const WITHDRAW = '0x3ccfd60b'

/** Selectors the stubbed diamond allowlists for TRON_WRAPPER in the next `run()`. */
let allowlisted = new Set<string>()
const allowlistQueries: string[] = []

mock.module('./tron/tronUtils', () => ({
  ...tronUtils,
  callTronContract: async (
    _contractAddress: string,
    functionSignature: string
  ) => {
    if (!functionSignature.startsWith('getPeripheryContract'))
      throw new Error(`unexpected read ${functionSignature}`)
    return TRON_WRAPPER
  },
  callTronContractBoolean: async (
    _tronWeb: TronWeb,
    _contractAddress: string,
    _functionSignature: string,
    params: Array<{ type: string; value: string }>
  ) => {
    const [address, selector] = params.map((param) => param.value)
    allowlistQueries.push(`${address}:${selector}`)
    return address === TRON_WRAPPER && allowlisted.has(String(selector))
  },
}))

const { HEALTH_CHECK_INVARIANTS } = await import('./healthCheckInvariants')

const invariant = HEALTH_CHECK_INVARIANTS.find(
  (i) => i.name === 'registered-periphery-allowlisted'
) as IHealthCheckInvariant

const tronWeb = new TronWeb({ fullHost: 'http://127.0.0.1' })

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
    diamondAddress: TRON_DIAMOND,
    deployedContracts: {},
    globalConfig: {
      whitelistPeripheryFunctions: {
        TokenWrapper: [{ selector: DEPOSIT }, { selector: WITHDRAW }],
      },
    },
    onChainFacets: [],
    peripheryRegistryCache: new Map(),
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

describe('registered-periphery-allowlisted on Tron', () => {
  it('passes when the registered base58 address holds both selectors', async () => {
    allowlisted = new Set([DEPOSIT, WITHDRAW])
    allowlistQueries.length = 0
    const ctx = makeTronCtx()
    await invariant.run(ctx)
    expect(allowlistQueries.sort()).toEqual(
      [`${TRON_WRAPPER}:${DEPOSIT}`, `${TRON_WRAPPER}:${WITHDRAW}`].sort()
    )
    expect(ctx.errors).toEqual([])
  })

  it('errors when the registered address lacks a selector', async () => {
    allowlisted = new Set([DEPOSIT])
    const ctx = makeTronCtx()
    await invariant.run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain(TRON_WRAPPER)
    expect(ctx.errors[0]).toContain(WITHDRAW)
  })
})
