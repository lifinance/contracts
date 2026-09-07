/**
 * Tests for the proposal-funnel deploy gate in `funnel-deploy-gate.ts`.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_ZERO_PREDECESSOR,
} from '../safe/timelock-abi'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from './constants'
import {
  assertFunnelDeployGate,
  collectInstalledFacetAddresses,
  evmHexAddress,
  indexDeploymentsByAddress,
  type IFunnelGateDeps,
} from './funnel-deploy-gate'

const FACET_A = '0x1111111111111111111111111111111111111111' as Address
const FACET_B = '0x2222222222222222222222222222222222222222' as Address
const DIAMOND = '0x3333333333333333333333333333333333333333' as Address
const TIMELOCK = '0x4444444444444444444444444444444444444444' as Address

const SELECTORS = ['0xaabbccdd', '0x11223344'] as Hex[]

const cut = (
  facetAddress: Address,
  action: number,
  options: { selectors?: Hex[]; init?: Address } = {}
): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      [
        {
          facetAddress,
          action,
          functionSelectors: options.selectors ?? SELECTORS,
        },
      ],
      options.init ?? (ZERO_ADDRESS as Address),
      options.init ? ('0xdeadbeef' as Hex) : ('0x' as Hex),
    ],
  })

const schedule = (target: Address, payload: Hex): Hex =>
  encodeFunctionData({
    abi: parseAbi([
      'function schedule(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt, uint256 delay)',
    ]),
    functionName: 'schedule',
    args: [
      target,
      0n,
      payload,
      TIMELOCK_ZERO_PREDECESSOR,
      TIMELOCK_ZERO_PREDECESSOR,
      86400n,
    ],
  })

/** An envelope this module does not know, carrying a cut inside it. */
const unknownWrapper = (payload: Hex): Hex =>
  encodeFunctionData({
    abi: parseAbi(['function multiSend(bytes transactions)']),
    functionName: 'multiSend',
    args: [payload],
  })

const scheduleBatch = (targets: Address[], payloads: Hex[]): Hex =>
  encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      targets,
      targets.map(() => 0n),
      payloads,
      TIMELOCK_ZERO_PREDECESSOR,
      TIMELOCK_ZERO_PREDECESSOR,
      86400n,
    ],
  })

/**
 * Asserts a refusal by inspecting the rejection itself. `expect(...).rejects` is
 * avoided deliberately: it resolves to `undefined` when the call does NOT reject,
 * which is exactly the case these tests exist to catch.
 * @param promise - the call expected to refuse
 * @param pattern - expected message
 */
const expectRefusal = async (
  promise: Promise<unknown>,
  pattern: RegExp
): Promise<void> => {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error
  )
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).message).toMatch(pattern)
}

describe('collectInstalledFacetAddresses', () => {
  it('picks up the facet address of an Add cut', () => {
    const result = collectInstalledFacetAddresses([cut(FACET_A, 0)])
    expect(result.addresses).toEqual([FACET_A])
    expect(result.undecodable).toEqual([])
  })

  it('picks up a Replace cut, which also installs code', () => {
    expect(collectInstalledFacetAddresses([cut(FACET_A, 1)]).addresses).toEqual(
      [FACET_A]
    )
  })

  it('ignores a Remove cut, which installs no code', () => {
    expect(
      collectInstalledFacetAddresses([cut(ZERO_ADDRESS as Address, 2)])
        .addresses
    ).toEqual([])
  })

  it('ignores calldata that is not a diamondCut', () => {
    expect(
      collectInstalledFacetAddresses(['0xdeadbeef' as Hex]).addresses
    ).toEqual([])
    expect(collectInstalledFacetAddresses(['0x' as Hex]).addresses).toEqual([])
  })

  it('unwraps a diamondCut already wrapped in a timelock scheduleBatch', () => {
    const wrapped = scheduleBatch([DIAMOND], [cut(FACET_A, 0)])
    expect(collectInstalledFacetAddresses([wrapped]).addresses).toEqual([
      FACET_A,
    ])
  })

  it('unwraps a nested scheduleBatch rather than trusting the outer shape', () => {
    const inner = scheduleBatch([DIAMOND], [cut(FACET_B, 0)])
    const outer = scheduleBatch([TIMELOCK], [inner])
    expect(collectInstalledFacetAddresses([outer]).addresses).toEqual([FACET_B])
  })

  it('deduplicates and checksums addresses across several calls', () => {
    const result = collectInstalledFacetAddresses([
      cut(FACET_A.toLowerCase() as Address, 0),
      cut(FACET_A, 1),
      cut(FACET_B, 0),
    ])
    expect(result.addresses).toEqual([FACET_A, FACET_B])
  })

  it('attributes a non-zero _init delegatecall target as well', () => {
    const result = collectInstalledFacetAddresses([
      cut(FACET_A, 0, { init: FACET_B }),
    ])
    expect(result.addresses).toEqual([FACET_A, FACET_B])
  })

  it('does not double-count an _init that is the facet being added', () => {
    const result = collectInstalledFacetAddresses([
      cut(FACET_A, 0, { init: FACET_A }),
    ])
    expect(result.addresses).toEqual([FACET_A])
  })

  it('ignores a zero _init, which the diamond never delegatecalls', () => {
    expect(
      collectInstalledFacetAddresses([cut(FACET_A, 0)]).addresses
    ).not.toContain(ZERO_ADDRESS)
  })

  it('unwraps the singular timelock schedule, which OZ exposes and our tooling never emits', () => {
    const wrapped = schedule(DIAMOND, cut(FACET_A, 0))
    expect(collectInstalledFacetAddresses([wrapped]).addresses).toEqual([
      FACET_A,
    ])
  })

  it('refuses an envelope it does not know that carries a cut inside it', () => {
    const wrapped = unknownWrapper(cut(FACET_A, 0))
    const result = collectInstalledFacetAddresses([wrapped])
    // the point: NOT an empty, innocent-looking result that skips the gate
    expect(result.addresses).toEqual([])
    expect(result.undecodable).toEqual([0])
  })

  it('refuses an unreadable envelope even when a readable cut sits beside it', () => {
    // the sibling case: the decodable half must not vouch for the other half
    const batch = scheduleBatch(
      [DIAMOND, TIMELOCK],
      [cut(FACET_A, 0), unknownWrapper(cut(FACET_B, 0))]
    )
    const result = collectInstalledFacetAddresses([batch])

    expect(result.addresses).toEqual([FACET_A])
    expect(result.undecodable).toEqual([0])
  })

  it('refuses a nested unreadable envelope, not just a top-level one', () => {
    const batch = scheduleBatch([TIMELOCK], [unknownWrapper(cut(FACET_B, 0))])
    expect(collectInstalledFacetAddresses([batch]).undecodable).toEqual([0])
  })

  it('leaves a call with no cut selector in it alone', () => {
    const result = collectInstalledFacetAddresses([
      unknownWrapper('0xdeadbeef' as Hex),
    ])
    expect(result.addresses).toEqual([])
    expect(result.undecodable).toEqual([])
  })

  it('reports a diamondCut selector whose body cannot be decoded', () => {
    const truncated = (cut(FACET_A, 0).slice(0, 30) + 'ff') as Hex
    const result = collectInstalledFacetAddresses([truncated])
    expect(result.addresses).toEqual([])
    expect(result.undecodable).toHaveLength(1)
  })
})

const deps = (
  overrides: Partial<IFunnelGateDeps> = {}
): { deps: IFunnelGateDeps; gateCalls: { facets: string[] }[] } => {
  const gateCalls: { facets: string[] }[] = []
  return {
    gateCalls,
    deps: {
      isTestnet: () => false,
      currentBranch: () => 'deploy/across',
      deployedNames: async () =>
        new Map([
          [FACET_A.toLowerCase(), 'AcrossFacet'],
          [FACET_B.toLowerCase(), 'LiFiDiamond'],
        ]),
      facetSourceExists: (name: string) => name === 'AcrossFacet',
      runGate: async (input: { facets: string[] }) => {
        gateCalls.push({ facets: input.facets })
        return []
      },
      ...overrides,
    },
  }
}

describe('assertFunnelDeployGate', () => {
  it('runs the gate exactly once per proposal, with the resolved facet names', async () => {
    const { deps: d, gateCalls } = deps()
    await assertFunnelDeployGate(
      { network: 'mainnet', calldatas: [cut(FACET_A, 0), cut(FACET_A, 1)] },
      d
    )
    expect(gateCalls).toEqual([{ facets: ['AcrossFacet'] }])
  })

  it('throws with the gate failures when the gate rejects', async () => {
    const { deps: d } = deps({
      runGate: async () => ['AcrossFacet diverges from origin/main'],
    })
    await expectRefusal(
      assertFunnelDeployGate(
        { network: 'mainnet', calldatas: [cut(FACET_A, 0)] },
        d
      ),
      /diverges from origin\/main/
    )
  })

  it('skips testnets', async () => {
    const { deps: d, gateCalls } = deps({ isTestnet: () => true })
    await assertFunnelDeployGate(
      { network: 'sepolia', calldatas: [cut(FACET_A, 0)] },
      d
    )
    expect(gateCalls).toEqual([])
  })

  it('does not call the gate when no call installs facet code', async () => {
    const { deps: d, gateCalls } = deps()
    await assertFunnelDeployGate(
      { network: 'mainnet', calldatas: ['0xdeadbeef' as Hex] },
      d
    )
    expect(gateCalls).toEqual([])
  })

  it('refuses a facet address that is not in the network deployments', async () => {
    const { deps: d, gateCalls } = deps()
    await expectRefusal(
      assertFunnelDeployGate(
        { network: 'mainnet', calldatas: [cut(DIAMOND, 0)] },
        d
      ),
      new RegExp(DIAMOND, 'i')
    )
    expect(gateCalls).toEqual([])
  })

  it('refuses an _init pointing at something that is not a facet', async () => {
    const { deps: d, gateCalls } = deps()
    await expectRefusal(
      assertFunnelDeployGate(
        { network: 'mainnet', calldatas: [cut(FACET_A, 0, { init: DIAMOND })] },
        d
      ),
      new RegExp(DIAMOND, 'i')
    )
    expect(gateCalls).toEqual([])
  })

  it('refuses an address that resolves to a name with no facet source', async () => {
    const { deps: d } = deps()
    await expectRefusal(
      assertFunnelDeployGate(
        { network: 'mainnet', calldatas: [cut(FACET_B, 0)] },
        d
      ),
      /LiFiDiamond/
    )
  })

  it('refuses an undecodable diamondCut instead of treating it as a non-cut', async () => {
    const { deps: d, gateCalls } = deps()
    const truncated = (cut(FACET_A, 0).slice(0, 30) + 'ff') as Hex
    await expectRefusal(
      assertFunnelDeployGate({ network: 'mainnet', calldatas: [truncated] }, d),
      /no cut could be read out of it/
    )
    expect(gateCalls).toEqual([])
  })

  it('refuses when the deployments file for the network cannot be read, and says the gate refused', async () => {
    const { deps: d } = deps({
      deployedNames: async () => {
        throw new Error('Deployments file not found for mainnet')
      },
    })
    const caught = await assertFunnelDeployGate(
      { network: 'mainnet', calldatas: [cut(FACET_A, 0)] },
      d
    ).then(
      () => undefined,
      (error: unknown) => error as Error
    )
    expect(caught).toBeInstanceOf(Error)
    // the cause has to survive, AND the message has to name the gate: a bare
    // file error tells the operator nothing about why the deploy stopped
    expect(caught?.message).toMatch(/Production deploy gate/)
    expect(caught?.message).toMatch(/Deployments file not found/)
  })
})

describe('gate condition, retargeted from diamondUpdateFacet.sh (#2128)', () => {
  // The shell gate read `ENVIRONMENT`, and a typo like "prod" had to keep the
  // gate on because the production key is handed out for anything not
  // containing "staging". This funnel has no environment predicate at all, so
  // the whole class is gone: what is left to pin is that no value of that name
  // can turn the gate off, and that testnets still exempt.
  it.each([
    ['production', 'RUNS'],
    ['prod', 'RUNS'],
    ['staging', 'RUNS'],
    ['', 'RUNS'],
    [undefined, 'RUNS'],
  ] as [string | undefined, string][])(
    'runs on a mainnet network with ENVIRONMENT=%p (%s)',
    async (environment) => {
      const previous = process.env.ENVIRONMENT
      if (environment === undefined) delete process.env.ENVIRONMENT
      else process.env.ENVIRONMENT = environment
      try {
        const { deps: d, gateCalls } = deps()
        await assertFunnelDeployGate(
          { network: 'mainnet', calldatas: [cut(FACET_A, 0)] },
          d
        )
        expect(gateCalls.length > 0 ? 'RUNS' : 'SKIPPED').toBe('RUNS')
      } finally {
        if (previous === undefined) delete process.env.ENVIRONMENT
        else process.env.ENVIRONMENT = previous
      }
    }
  )

  it('skips a testnet, whatever ENVIRONMENT says', async () => {
    const { deps: d, gateCalls } = deps({ isTestnet: () => true })
    await assertFunnelDeployGate(
      { network: 'sepolia', calldatas: [cut(FACET_A, 0)] },
      d
    )
    expect(gateCalls).toEqual([])
  })
})

describe('indexDeploymentsByAddress', () => {
  it('inverts a deployment log into lowercase address → name', () => {
    const map = indexDeploymentsByAddress({
      AcrossFacet: FACET_A,
      LiFiDiamond: DIAMOND,
    })
    expect(map.get(FACET_A.toLowerCase())).toBe('AcrossFacet')
    expect(map.get(DIAMOND.toLowerCase())).toBe('LiFiDiamond')
  })

  it('skips the JSON module default key rather than indexing it as a contract', () => {
    const map = indexDeploymentsByAddress({
      default: FACET_A,
      AcrossFacet: FACET_A,
    })
    expect([...map.values()]).toEqual(['AcrossFacet'])
  })

  it('skips values that are not addresses, so a version string cannot be attributed', () => {
    const map = indexDeploymentsByAddress({
      AcrossFacet: FACET_A,
      SomeVersion: '1.2.0',
      Nested: { a: 1 } as unknown as string,
    })
    expect([...map.values()]).toEqual(['AcrossFacet'])
  })

  it('lets the first entry win, so a later alias cannot rename the contract it points at', () => {
    const map = indexDeploymentsByAddress({
      AcrossFacet: FACET_A,
      AcrossFacetAlias: FACET_A,
    })
    expect(map.get(FACET_A.toLowerCase())).toBe('AcrossFacet')
  })

  it('uses the injected reader, which is how Tron base58 logs are attributed', () => {
    const map = indexDeploymentsByAddress(
      { SymbiosisFacet: 'TMY1N6base58like' },
      (value) => (value.startsWith('T') ? FACET_B.toLowerCase() : undefined)
    )
    expect(map.get(FACET_B.toLowerCase())).toBe('SymbiosisFacet')
  })
})

describe('evmHexAddress', () => {
  it('accepts a 20-byte hex address, lowercased', () => {
    expect(evmHexAddress(FACET_A)).toBe(FACET_A.toLowerCase())
  })

  it('rejects anything that is not one', () => {
    for (const value of [
      '1.2.0',
      '0x',
      '0xnothex',
      FACET_A.slice(0, 20),
      `${FACET_A}00`,
      'TMY1N6base58like',
    ])
      expect(evmHexAddress(value)).toBeUndefined()
  })
})
