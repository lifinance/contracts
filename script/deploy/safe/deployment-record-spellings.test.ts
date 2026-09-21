import { describe, expect, it } from 'bun:test' // eslint-disable-line import/no-unresolved

import { createTronAddressSpellings } from '../shared/tron-address-spellings'

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

  // The record on the network, whose address the translator cannot read — not a
  // record on another network, which exits at the network guard before the
  // translator is ever asked.
  it('sets no record spelling on a record it could not respell', () => {
    const out = withCalldataSpellings(
      [entry({ address: '0xnot-an-address' })],
      'tron',
      tronToHex
    )
    expect(out?.[0]?.address).toBe('0xnot-an-address')
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

  it('respells a real Tron record through the translator production uses', () => {
    // The stubs above pin the respelling rule; this pins that the one
    // translator wired at the call site actually satisfies it. Nothing else
    // couples the two, so a guard tightened inside the translator can drop a
    // spelling here while every test in both files stays green.
    const spellings = createTronAddressSpellings('tron')
    const base58 = 'TMck2qdZHmsdurz4uE4eNVBt14JHHLeoEB'
    const hex = '0x7fc2ad654bbe72fef9f46d92a9f51dc10d3b8c7e'

    expect(
      withCalldataSpellings(
        [entry({ address: base58 })],
        'tron',
        spellings
      )?.[0]?.address
    ).toBe(hex)
    // Tron's own `41` hex spelling, which has to be respelt to be found. The
    // `0x` spelling would pass this whether or not it was translated, so it
    // says nothing.
    expect(
      withCalldataSpellings(
        [entry({ address: `41${hex.slice(2)}` })],
        'tron',
        spellings
      )?.[0]?.address
    ).toBe(hex)
  })

  it('passes an unread record set and a network without a translator through', () => {
    expect(withCalldataSpellings(undefined, 'tron', tronToHex)).toBeUndefined()
    const same = [entry({})]
    expect(withCalldataSpellings(same, 'tron', undefined)).toBe(same)
  })
})
