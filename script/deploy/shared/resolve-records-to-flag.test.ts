import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

import type { IDeploymentRecord } from './mongo-log-utils'
import { resolveRecordsToFlag } from './resolve-records-to-flag'

const VERIFIED_ADDRESS = 'TRzEvqhoK6pC58rmUFMgCoEtQgiHYh2FCQ'
const ABANDONED_ADDRESS = 'TTukYpunN8FipnhvpbGhhd5646Er3YUhom'

function makeRecord(
  overrides: Partial<IDeploymentRecord> = {}
): IDeploymentRecord {
  return {
    contractName: 'EcoFacet',
    network: 'tron',
    version: '2.0.0',
    address: VERIFIED_ADDRESS,
    optimizerRuns: '1000000',
    timestamp: new Date('2026-09-22T06:59:11Z'),
    constructorArgs: '0xdeadbeef',
    salt: '',
    verified: false,
    solcVersion: '0.8.29',
    evmVersion: 'cancun',
    zkSolcVersion: '',
    gitCommitHash: 'e2851bd1825d955ff45810abefa6a262482669d9',
    createdAt: new Date('2026-09-22T06:59:11Z'),
    updatedAt: new Date('2026-09-22T06:59:11Z'),
    contractNetworkKey: 'EcoFacet-tron',
    contractVersionKey: 'EcoFacet-2.0.0',
    ...overrides,
  }
}

describe('resolveRecordsToFlag', () => {
  it('returns the record naming the verified address', () => {
    const record = makeRecord()

    expect(
      resolveRecordsToFlag([record], 'EcoFacet', 'tron', VERIFIED_ADDRESS)
    ).toEqual([record])
  })

  it('finds the record even when an abandoned deploy logged a newer one', () => {
    // The ordering this selection exists for: an abandoned deploy left a record
    // that is newer than the contract actually in use, so "newest record" and
    // "address just verified" name different contracts.
    const live = makeRecord()
    const abandoned = makeRecord({
      address: ABANDONED_ADDRESS,
      version: '2.1.0',
      timestamp: new Date('2026-09-23T10:00:00Z'),
    })

    expect(
      resolveRecordsToFlag(
        [abandoned, live],
        'EcoFacet',
        'tron',
        VERIFIED_ADDRESS
      )
    ).toEqual([live])
  })

  it('returns every record naming the address, so none stays unflagged', () => {
    const first = makeRecord({ version: '2.0.0' })
    const relogged = makeRecord({
      version: '2.0.1',
      timestamp: new Date('2026-09-23T10:00:00Z'),
    })

    expect(
      resolveRecordsToFlag(
        [first, relogged],
        'EcoFacet',
        'tron',
        VERIFIED_ADDRESS
      )
    ).toEqual([first, relogged])
  })

  it('refuses when no record exists at all', () => {
    expect(() =>
      resolveRecordsToFlag([], 'EcoFacet', 'tron', VERIFIED_ADDRESS)
    ).toThrow('No deployment record for EcoFacet on tron')
  })

  it('names the recorded addresses when none match, so the gap is actionable', () => {
    const other = makeRecord({ address: ABANDONED_ADDRESS })

    expect(() =>
      resolveRecordsToFlag([other], 'EcoFacet', 'tron', VERIFIED_ADDRESS)
    ).toThrow(new RegExp(`${VERIFIED_ADDRESS}[\\s\\S]*${ABANDONED_ADDRESS}`))
  })

  it('compares addresses exactly, since Tron base58 is case-sensitive', () => {
    const record = makeRecord({ address: VERIFIED_ADDRESS.toLowerCase() })

    expect(() =>
      resolveRecordsToFlag([record], 'EcoFacet', 'tron', VERIFIED_ADDRESS)
    ).toThrow(/names the verified/)
  })
})
