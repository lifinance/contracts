/**
 * Tests for the proposal-funnel deploy gate in `funnel-deploy-gate.ts`.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { EnvironmentEnum } from '../../common/types'
import {
  TIMELOCK_SCHEDULE_BATCH_ABI,
  TIMELOCK_ZERO_PREDECESSOR,
} from '../safe/timelock-abi'

import { DIAMOND_CUT_ABI, ZERO_ADDRESS } from './constants'
import {
  assertFunnelDeployGate,
  collectInstalledFacetAddresses,
  resolveGateEnvironment,
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
  selectors: Hex[] = SELECTORS
): Hex =>
  encodeFunctionData({
    abi: DIAMOND_CUT_ABI,
    functionName: 'diamondCut',
    args: [
      [{ facetAddress, action, functionSelectors: selectors }],
      ZERO_ADDRESS as Address,
      '0x' as Hex,
    ],
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

  it('reports a diamondCut selector whose body cannot be decoded', () => {
    const truncated = (cut(FACET_A, 0).slice(0, 30) + 'ff') as Hex
    const result = collectInstalledFacetAddresses([truncated])
    expect(result.addresses).toEqual([])
    expect(result.undecodable).toHaveLength(1)
  })
})

describe('resolveGateEnvironment', () => {
  it('is staging only when ENVIRONMENT says exactly staging', () => {
    expect(resolveGateEnvironment({ ENVIRONMENT: 'staging' })).toBe(
      EnvironmentEnum.staging
    )
  })

  it('treats every other explicit ENVIRONMENT as production', () => {
    for (const value of [
      'production',
      'prod',
      'PRODUCTION',
      'Staging',
      ' staging',
    ])
      expect(resolveGateEnvironment({ ENVIRONMENT: value })).toBe(
        EnvironmentEnum.production
      )
  })

  it('gates when ENVIRONMENT is unset, whatever PRODUCTION says', () => {
    expect(resolveGateEnvironment({})).toBe(EnvironmentEnum.production)
    expect(resolveGateEnvironment({ PRODUCTION: 'false' })).toBe(
      EnvironmentEnum.production
    )
    expect(resolveGateEnvironment({ ENVIRONMENT: '' })).toBe(
      EnvironmentEnum.production
    )
  })
})

const deps = (
  overrides: Partial<IFunnelGateDeps> = {}
): { deps: IFunnelGateDeps; gateCalls: { facets: string[] }[] } => {
  const gateCalls: { facets: string[] }[] = []
  return {
    gateCalls,
    deps: {
      environment: () => EnvironmentEnum.production,
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

  it('skips staging entirely', async () => {
    const { deps: d, gateCalls } = deps({
      environment: () => EnvironmentEnum.staging,
    })
    await assertFunnelDeployGate(
      { network: 'mainnet', calldatas: [cut(FACET_A, 0)] },
      d
    )
    expect(gateCalls).toEqual([])
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
      /could not be decoded/
    )
    expect(gateCalls).toEqual([])
  })

  it('refuses when the deployments file for the network cannot be read', async () => {
    const { deps: d } = deps({
      deployedNames: async () => {
        throw new Error('Deployments file not found for mainnet')
      },
    })
    await expectRefusal(
      assertFunnelDeployGate(
        { network: 'mainnet', calldatas: [cut(FACET_A, 0)] },
        d
      ),
      /Deployments file not found/
    )
  })
})

describe('gate condition, retargeted from diamondUpdateFacet.sh (#2128)', () => {
  // getPrivateKey hands out the production key for every value that does not
  // contain "staging", so a typo like "prod" reaches it. The gate must run for
  // those too, and the shell gate it replaces matched ENVIRONMENT != "staging".
  it.each([
    ['production', false, 'RUNS'],
    ['prod', false, 'RUNS'],
    ['', false, 'RUNS'],
    [undefined, false, 'RUNS'],
    ['staging', false, 'SKIPPED'],
    // testnets carry production target state but no Safe, and an unmerged facet
    // is deployed there before it is audited - gating them would block that
    ['production', true, 'SKIPPED'],
    ['staging', true, 'SKIPPED'],
  ] as [string | undefined, boolean, string][])(
    'decides ENVIRONMENT=%p on isTestnet=%p as %s',
    async (environment, isTestnet, expected) => {
      const { deps: d, gateCalls } = deps({
        environment: () =>
          resolveGateEnvironment(
            environment === undefined ? {} : { ENVIRONMENT: environment }
          ),
        isTestnet: () => isTestnet,
      })
      await assertFunnelDeployGate(
        { network: 'mainnet', calldatas: [cut(FACET_A, 0)] },
        d
      )
      expect(gateCalls.length > 0 ? 'RUNS' : 'SKIPPED').toBe(expected)
    }
  )
})
