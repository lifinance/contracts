/**
 * The pre-flight scan decides which networks a signer is even offered, so the
 * Safe it reads ownership from must be the one the interactive run will use.
 * `prepareConfirmSafeTxNetwork` points its client at the Safe `networks.json`
 * names and keeps the proposal document's claim only for the integrity
 * assertions to compare; the scan has to answer the same way, or a row naming a
 * foreign Safe decides whether its whole network is visible.
 */

import {
  beforeEach,
  describe,
  expect,
  it,
  mock,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import type { Collection } from 'mongodb'
import type { Address } from 'viem'

import networks from '../../../config/networks.json'

import type { ISafeTxDocument } from './safe-utils'

const SIGNER = '0x1111111111111111111111111111111111111111' as Address

/** Addresses `getOwners` was asked about, in call order. */
let readAddresses: string[] = []
/** Lower-cased address -> owner set the fake chain answers with. */
let ownersByAddress: Record<string, Address[]> = {}

mock.module('./read-only-safe-client', () => ({
  buildReadOnlyClient: () => ({
    readContract: async ({
      address,
      functionName,
    }: {
      address: Address
      functionName: string
    }) => {
      if (functionName === 'getOwners')
        readAddresses.push(address.toLowerCase())
      const owners = ownersByAddress[address.toLowerCase()]
      if (!owners)
        throw new Error(
          `The contract function "${functionName}" returned no data ("0x").`
        )
      return functionName === 'getThreshold' ? 1n : owners
    },
  }),
}))

const { getNetworksWithActionableTransactions } = await import('./safe-utils')

const doc = (
  network: string,
  safeAddress: string,
  nonce: number
): ISafeTxDocument =>
  ({
    network,
    safeAddress,
    status: 'pending',
    safeTx: { data: { nonce }, signatures: {} },
  } as unknown as ISafeTxDocument)

/** Minimal stand-in for the pending-transactions collection the scan reads. */
const collectionOf = (docs: ISafeTxDocument[]) =>
  ({
    distinct: async () => [...new Set(docs.map((d) => d.network))],
    find: () => ({ toArray: async () => docs }),
  } as unknown as Collection<ISafeTxDocument>)

const configuredSafe = (network: string): Address => {
  const address = (networks as Record<string, { safeAddress?: string }>)[
    network
  ]?.safeAddress
  if (!address) throw new Error(`${network} names no Safe in networks.json`)
  return address as Address
}

describe('getNetworksWithActionableTransactions — which Safe decides', () => {
  beforeEach(() => {
    readAddresses = []
    ownersByAddress = {}
  })

  it('reads the configured Safe, not a document naming a foreign one', async () => {
    const optimism = configuredSafe('optimism')
    const foreign = configuredSafe('mainnet')
    ownersByAddress[optimism.toLowerCase()] = [SIGNER]

    const actionable = await getNetworksWithActionableTransactions(
      // The foreign row sorts first: the scan orders by nonce, so this is the
      // document the pre-fix code would have resolved ownership from.
      collectionOf([doc('optimism', foreign, 0), doc('optimism', optimism, 1)]),
      SIGNER
    )

    expect(actionable).toEqual(['optimism'])
    expect(readAddresses).toEqual([optimism.toLowerCase()])
    expect(readAddresses).not.toContain(foreign.toLowerCase())
  })

  it('falls back to the document when the network names no Safe', async () => {
    const claimed = '0x2222222222222222222222222222222222222222' as Address
    ownersByAddress[claimed.toLowerCase()] = [SIGNER]

    const actionable = await getNetworksWithActionableTransactions(
      collectionOf([doc('sepolia', claimed, 0)]),
      SIGNER
    )

    expect(actionable).toEqual(['sepolia'])
    expect(readAddresses).toEqual([claimed.toLowerCase()])
  })

  it('does not offer a network whose configured Safe cannot be read', async () => {
    // No owner set registered, so the fake chain answers "0x" the way a call to
    // an address holding no code does.
    const actionable = await getNetworksWithActionableTransactions(
      collectionOf([doc('optimism', configuredSafe('optimism'), 0)]),
      SIGNER
    )

    expect(actionable).toEqual([])
  })

  it('does not offer a network whose configured Safe the signer does not own', async () => {
    const optimism = configuredSafe('optimism')
    ownersByAddress[optimism.toLowerCase()] = [
      '0x3333333333333333333333333333333333333333' as Address,
    ]

    const actionable = await getNetworksWithActionableTransactions(
      collectionOf([doc('optimism', optimism, 0)]),
      SIGNER
    )

    expect(actionable).toEqual([])
  })
})
