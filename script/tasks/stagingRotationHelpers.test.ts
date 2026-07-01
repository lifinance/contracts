import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { getAddress, isAddress, type Address } from 'viem'

import {
  classifyOwnershipState,
  getStagingDiamonds,
} from './stagingRotationHelpers'

const OUTGOING = '0x85A8F3cf6d255BD497Bd1Dd83a338Cce0B14C3B3' as Address
const INCOMING = '0xcf1A07FEd1b622B1d9B80D86DE06D8c43E4fBDdB' as Address

describe('classifyOwnershipState', () => {
  it('returns "done" when the current owner already equals the incoming owner', () => {
    expect(classifyOwnershipState(INCOMING, INCOMING, false)).toBe('done')
  })

  it('compares addresses checksum-insensitively', () => {
    expect(
      classifyOwnershipState(
        INCOMING.toLowerCase() as Address,
        getAddress(INCOMING),
        false
      )
    ).toBe('done')
  })

  it('returns "pending" when confirm would succeed from the incoming owner', () => {
    expect(classifyOwnershipState(OUTGOING, INCOMING, true)).toBe('pending')
  })

  it('returns "not-started" when confirm would revert and owner is unchanged', () => {
    expect(classifyOwnershipState(OUTGOING, INCOMING, false)).toBe(
      'not-started'
    )
  })
})

describe('getStagingDiamonds', () => {
  it('returns active EVM staging diamonds with checksummed addresses, excluding Tron', async () => {
    const diamonds = await getStagingDiamonds()

    expect(diamonds.length).toBeGreaterThan(0)
    for (const { network, diamond } of diamonds) {
      expect(typeof network).toBe('string')
      expect(isAddress(diamond)).toBe(true)
      expect(diamond).toBe(getAddress(diamond))
    }

    const networkNames = diamonds.map((entry) => entry.network)
    expect(networkNames).not.toContain('tron')
    expect(networkNames).not.toContain('tronshasta')
  })
})
