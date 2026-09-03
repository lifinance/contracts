import {
  evmHexToTronBase58,
  getTronWebCodecOnlyForNetwork,
} from '@lifi/tron-devkit'
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  getConstructorArgs,
  resolveCoreFacetConstructorArgs,
  type ArtifactLoader,
} from './coreFacetConstructorArgs'

const ONE_ADDRESS_ABI = [
  {
    type: 'constructor',
    inputs: [{ name: '_a', type: 'address', internalType: 'address' }],
    stateMutability: 'nonpayable',
  },
]

const NO_CONSTRUCTOR_ABI = [
  {
    type: 'function',
    name: 'x',
    inputs: [],
    outputs: [],
    stateMutability: 'view',
  },
]

const loaderFor =
  (abiByFacet: Record<string, unknown>): ArtifactLoader =>
  async (contractName: string) => ({ abi: abiByFacet[contractName] })

const NETWORKS_FIXTURE = {
  tron: { nativeAddress: '0x0000000000000000000000000000000000000000' },
}

/**
 * Asserts `promise` rejects with an error whose message matches `match`. Kept as
 * a helper (rather than `expect().rejects`) so the awaited value is a real
 * Promise — `@typescript-eslint/await-thenable` rejects awaiting bun's matcher.
 */
async function expectRejects(
  promise: Promise<unknown>,
  match: RegExp | string
): Promise<void> {
  let error: Error | undefined
  try {
    await promise
  } catch (caught) {
    error = caught as Error
  }
  expect(error).toBeInstanceOf(Error)
  if (match instanceof RegExp) expect(error?.message).toMatch(match)
  else expect(error?.message).toContain(match)
}

describe('getConstructorArgs', () => {
  it('supplies the pauser wallet to EmergencyPauseFacet', async () => {
    const globalConfig = await Bun.file('config/global.json').json()
    expect(
      await getConstructorArgs('EmergencyPauseFacet', 'tron', NETWORKS_FIXTURE)
    ).toEqual([globalConfig.pauserWallet])
  })

  it('supplies the native token address to GenericSwapFacetV3', async () => {
    expect(
      await getConstructorArgs('GenericSwapFacetV3', 'tron', NETWORKS_FIXTURE)
    ).toEqual([NETWORKS_FIXTURE.tron.nativeAddress])
  })

  it('throws when the native token address is missing', async () => {
    await expectRejects(
      getConstructorArgs('GenericSwapFacetV3', 'tron', {}),
      'nativeAddress not found for tron'
    )
  })

  it('supplies the configured input settler to LiFiIntentEscrowFacetV2', async () => {
    const escrowConfig = await Bun.file('config/lifiintentescrow.json').json()
    const args = await getConstructorArgs(
      'LiFiIntentEscrowFacetV2',
      'tron',
      NETWORKS_FIXTURE
    )

    expect(args).toHaveLength(1)
    expect(args[0]).toMatch(/^0x[0-9a-f]{40}$/u)
    expect(
      evmHexToTronBase58(
        getTronWebCodecOnlyForNetwork('tron'),
        args[0] as string
      )
    ).toBe(escrowConfig.tron.lifiEscrowInputSettler)
  })

  it('throws for a network with no input settler configured', async () => {
    await expectRejects(
      getConstructorArgs(
        'LiFiIntentEscrowFacetV2',
        'tronshasta',
        NETWORKS_FIXTURE
      ),
      'lifiEscrowInputSettler not found for tronshasta'
    )
  })

  it('returns no arguments for a facet that takes none', async () => {
    expect(
      await getConstructorArgs('DiamondCutFacet', 'tron', NETWORKS_FIXTURE)
    ).toEqual([])
  })
})

describe('resolveCoreFacetConstructorArgs', () => {
  it('keys each facet to the arguments it will be deployed with', async () => {
    const resolved = await resolveCoreFacetConstructorArgs(
      ['DiamondCutFacet', 'GenericSwapFacetV3'],
      'tron',
      NETWORKS_FIXTURE,
      loaderFor({
        DiamondCutFacet: NO_CONSTRUCTOR_ABI,
        GenericSwapFacetV3: ONE_ADDRESS_ABI,
      })
    )

    expect(resolved.get('DiamondCutFacet')).toEqual([])
    expect(resolved.get('GenericSwapFacetV3')).toEqual([
      NETWORKS_FIXTURE.tron.nativeAddress,
    ])
  })

  it('throws when a facet has a constructor but no branch supplying it', async () => {
    await expectRejects(
      resolveCoreFacetConstructorArgs(
        ['UnhandledFacet'],
        'tron',
        NETWORKS_FIXTURE,
        loaderFor({ UnhandledFacet: ONE_ADDRESS_ABI })
      ),
      /UnhandledFacet expects 1 constructor arguments, got 0.*coreFacetConstructorArgs\.ts/su
    )
  })

  it('throws when arguments are supplied to a facet that takes none', async () => {
    await expectRejects(
      resolveCoreFacetConstructorArgs(
        ['GenericSwapFacetV3'],
        'tron',
        NETWORKS_FIXTURE,
        loaderFor({ GenericSwapFacetV3: NO_CONSTRUCTOR_ABI })
      ),
      /expects 0 constructor arguments, got 1/u
    )
  })

  it('throws when the artifact holds no readable ABI', async () => {
    await expectRejects(
      resolveCoreFacetConstructorArgs(
        ['DiamondCutFacet'],
        'tron',
        NETWORKS_FIXTURE,
        loaderFor({})
      ),
      /no readable ABI/u
    )
  })
})
