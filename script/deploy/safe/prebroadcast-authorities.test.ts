// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  buildAddressNameIndex,
  extractCalldataAddresses,
  resolveExpectedAuthority,
} from './prebroadcast-authorities'

const DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'
const FACET = '0x00000000000000000000000000000000000000aa'
const STRANGER = '0x00000000000000000000000000000000000000ff'
const TIMELOCK = '0x00000000000000000000000000000000000000a1'

const asWord = (address: string): string =>
  address.replace(/^0x/, '').toLowerCase().padStart(64, '0')

describe('extractCalldataAddresses', () => {
  const known = new Set([DIAMOND, FACET])

  it('returns the inner-call targets', () => {
    expect(extractCalldataAddresses([DIAMOND], ['0x'], known)).toEqual([
      DIAMOND,
    ])
  })

  it('finds a known address inside a payload word', () => {
    const payload = `0x1f931c1c${asWord(FACET)}`
    expect(extractCalldataAddresses([DIAMOND], [payload], known)).toEqual([
      DIAMOND,
      FACET,
    ])
  })

  it('finds it under a selector no decoder in this repo knows', () => {
    // The property a decode-driven list cannot have: the set of calls a
    // timelock operation may carry is open.
    const payload = `0xdeadbeef${asWord(FACET)}`
    expect(extractCalldataAddresses([], [payload], known)).toEqual([FACET])
  })

  it('finds nothing when the payload holds no address main can name', () => {
    const payload = `0x1f931c1c${asWord(STRANGER)}`
    expect(extractCalldataAddresses([], [payload], known)).toEqual([])
  })

  it('ignores the zero address even when it is in the known set', () => {
    const zero = '0x0000000000000000000000000000000000000000'
    const payload = `0x1f931c1c${asWord(zero)}`
    expect(
      extractCalldataAddresses([], [payload], new Set([...known, zero]))
    ).toEqual([])
  })

  it('finds both addresses in the top-level frame', () => {
    const payload = `0x1f931c1c${asWord(FACET)}${asWord(DIAMOND)}`
    expect(extractCalldataAddresses([], [payload], known)).toEqual([
      FACET,
      DIAMOND,
    ])
  })

  it('finds an address that only a nested frame reaches', () => {
    // A call carried in a `bytes` argument — diamondCut's init `_calldata` is
    // the one that matters — shifts its own words by its own selector, so its
    // addresses sit on no 32-byte stride of the outer frame. A single-alignment
    // scan gives such an address no codehash row and no authority row at all:
    // not a verdict about it, the absence of one.
    const payload = `0xdeadbeef${asWord(FACET)}1f931c1c${asWord(DIAMOND)}`

    expect(extractCalldataAddresses([], [payload], known)).toEqual([
      FACET,
      DIAMOND,
    ])
  })

  it('still names nothing the deployments file does not hold', () => {
    // The paired present for the widening: a 4-byte stride examines eight times
    // as many windows, so it has to stay incapable of naming an address main
    // cannot — otherwise the added coverage is noise the gate must then read
    // code for, and a failed read holds the operation.
    const payload = `0xdeadbeef${asWord(STRANGER)}1f931c1c${asWord(STRANGER)}`
    expect(extractCalldataAddresses([], [payload], known)).toEqual([])
  })

  it('deduplicates an address that is both a target and in a payload', () => {
    const payload = `0x1f931c1c${asWord(DIAMOND)}`
    expect(extractCalldataAddresses([DIAMOND], [payload], known)).toEqual([
      DIAMOND,
    ])
  })

  it('lowercases and trims a checksummed target', () => {
    expect(
      extractCalldataAddresses(
        ['  0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE  '],
        [],
        known
      )
    ).toEqual([DIAMOND])
  })

  it('tolerates a payload that is not hex at all', () => {
    expect(extractCalldataAddresses([], ['', '0x', 'nonsense'], known)).toEqual(
      []
    )
  })
})

describe('buildAddressNameIndex', () => {
  it('inverts name → address into address → name', () => {
    const index = buildAddressNameIndex({ LiFiDiamond: DIAMOND })
    expect(index.get(DIAMOND)).toBe('LiFiDiamond')
  })

  it('keys on the address bytes, not on the name', () => {
    const index = buildAddressNameIndex({
      LiFiDiamond: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
    })
    expect(index.get(DIAMOND)).toBe('LiFiDiamond')
    expect(index.has('lifidiamond')).toBe(false)
  })

  it('maps an address bound to two names to undefined rather than picking one', () => {
    const index = buildAddressNameIndex({
      OwnershipFacet: FACET,
      SomethingElse: FACET,
    })
    expect(index.has(FACET)).toBe(true)
    expect(index.get(FACET)).toBeUndefined()
  })

  it('keeps one name when the same pair appears twice', () => {
    const index = buildAddressNameIndex({ OwnershipFacet: FACET })
    expect(index.get(FACET)).toBe('OwnershipFacet')
  })

  it('skips entries that are not addresses', () => {
    const index = buildAddressNameIndex({
      Nested: { inner: DIAMOND },
      Truncated: '0x1234',
      Empty: '',
      Real: FACET,
    })
    expect([...index.keys()]).toEqual([FACET])
  })
})

describe('resolveExpectedAuthority', () => {
  const deployments = { LiFiTimelockController: TIMELOCK }
  const globalConfig = { pauserWallet: FACET, threshold: 3 }

  it('resolves an expectation declared in the deployments file', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'deployments', contractName: 'LiFiTimelockController' },
        deployments,
        globalConfig
      )
    ).toBe(TIMELOCK)
  })

  it('resolves an expectation declared in the global config', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'globalConfig', key: 'pauserWallet' },
        deployments,
        globalConfig
      )
    ).toBe(FACET)
  })

  it('lowercases a checksummed expectation', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'deployments', contractName: 'D' },
        { D: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE' },
        globalConfig
      )
    ).toBe(DIAMOND)
  })

  it('reports undefined rather than a default when nothing is declared', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'deployments', contractName: 'Absent' },
        deployments,
        globalConfig
      )
    ).toBeUndefined()
    expect(
      resolveExpectedAuthority(
        { from: 'globalConfig', key: 'threshold' },
        deployments,
        globalConfig
      )
    ).toBeUndefined()
  })

  it('reports undefined for a declared value that is not an address', () => {
    expect(
      resolveExpectedAuthority(
        { from: 'globalConfig', key: 'k' },
        deployments,
        { k: '0xnope' }
      )
    ).toBeUndefined()
  })
})
