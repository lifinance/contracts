import { describe, expect, it } from 'bun:test' // eslint-disable-line import/no-unresolved

import type { IDeploymentIndexEntry } from './calldata-address-check'
import { withCalldataSpellings } from './deployment-record-spellings'

const entry = (
  over: Partial<IDeploymentIndexEntry>
): IDeploymentIndexEntry => ({
  contractName: 'LiFiIntentEscrowFacetV2',
  network: 'tron',
  version: '1.0.0',
  address: 'TMck2qdZHmsdurz4uE4eNVBt14JHHLeoEB',
  timestamp: '2026-08-19T07:13:10.755Z',
  ...over,
})

const tronToHex = {
  toCalldataSpelling: (address: string) =>
    address.startsWith('T')
      ? '0x7fc2ad654bbe72fef9f46d92a9f51dc10d3b8c7e'
      : undefined,
}

describe('withCalldataSpellings', () => {
  it('adds a calldata-spelt copy beside each record on the network', () => {
    const out = withCalldataSpellings([entry({})], 'tron', tronToHex)
    expect(out).toHaveLength(2)
    expect(out?.[0]?.address).toBe('TMck2qdZHmsdurz4uE4eNVBt14JHHLeoEB')
    expect(out?.[1]?.address).toBe('0x7fc2ad654bbe72fef9f46d92a9f51dc10d3b8c7e')
    expect(out?.[1]?.contractName).toBe('LiFiIntentEscrowFacetV2')
    expect(out?.[1]?.timestamp).toBe('2026-08-19T07:13:10.755Z')
  })

  it('leaves records on other networks alone', () => {
    const out = withCalldataSpellings(
      [
        entry({
          network: 'mainnet',
          address: '0x1111111111111111111111111111111111111111',
        }),
      ],
      'tron',
      tronToHex
    )
    expect(out).toHaveLength(1)
  })

  it('keeps a record its address cannot be translated from', () => {
    const out = withCalldataSpellings(
      [entry({ address: 'not-an-address' })],
      'tron',
      tronToHex
    )
    expect(out).toHaveLength(1)
    expect(out?.[0]?.address).toBe('not-an-address')
  })

  it('adds nothing when the spelling is already the calldata one', () => {
    const out = withCalldataSpellings(
      [entry({ address: '0x7fc2ad654bbe72fef9f46d92a9f51dc10d3b8c7e' })],
      'tron',
      { toCalldataSpelling: (address) => address.toUpperCase() }
    )
    expect(out).toHaveLength(1)
  })

  it('passes an unread record set and a network without a translator through', () => {
    expect(withCalldataSpellings(undefined, 'tron', tronToHex)).toBeUndefined()
    const same = [entry({})]
    expect(withCalldataSpellings(same, 'tron', undefined)).toBe(same)
  })
})
