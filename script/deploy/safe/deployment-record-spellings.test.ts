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
  it('respells each record on the network the way the calldata does, in place', () => {
    const out = withCalldataSpellings([entry({})], 'tron', tronToHex)
    expect(out).toHaveLength(1)
    expect(out?.[0]?.address).toBe('0x7fc2ad654bbe72fef9f46d92a9f51dc10d3b8c7e')
    expect(out?.[0]?.contractName).toBe('LiFiIntentEscrowFacetV2')
    expect(out?.[0]?.timestamp).toBe('2026-08-19T07:13:10.755Z')
  })

  // Respelling is what the lookup needs, but base58 is the string a Tron signer
  // can put into an explorer, so the record's own spelling has to survive it.
  it('carries the record spelling the calldata does not use', () => {
    const out = withCalldataSpellings([entry({})], 'tron', tronToHex)
    expect(out?.[0]?.recordSpelling).toBe('TMck2qdZHmsdurz4uE4eNVBt14JHHLeoEB')
  })

  it('sets no record spelling when nothing was respelt', () => {
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
    expect(out?.[0]?.recordSpelling).toBeUndefined()
  })

  // Two records of one name at one deploy time read as a tie the check cannot
  // decide, so the respelling must never leave the original beside the copy.
  it('never yields two spellings of one record', () => {
    const out = withCalldataSpellings(
      [entry({}), entry({ version: '1.0.1' })],
      'tron',
      tronToHex
    )
    expect(out).toHaveLength(2)
    expect(new Set(out?.map((one) => one.address)).size).toBe(1)
    expect(out?.every((one) => one.address.startsWith('0x'))).toBe(true)
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

  it('keeps the entry count whatever the translator says', () => {
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
