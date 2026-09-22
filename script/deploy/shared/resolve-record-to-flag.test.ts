import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved, import/order
} from 'bun:test'

import type { IDeploymentRecord } from './mongo-log-utils'
import { resolveRecordToFlag } from './resolve-record-to-flag'

function makeRecord(
  overrides: Partial<IDeploymentRecord> = {}
): IDeploymentRecord {
  return {
    contractName: 'EcoFacet',
    network: 'tron',
    version: '2.0.0',
    address: 'TRzEvqhoK6pC58rmUFMgCoEtQgiHYh2FCQ',
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

describe('resolveRecordToFlag', () => {
  it('returns the record when it names the verified address', () => {
    const record = makeRecord()

    expect(
      resolveRecordToFlag(
        record,
        'EcoFacet',
        'tron',
        'TRzEvqhoK6pC58rmUFMgCoEtQgiHYh2FCQ'
      )
    ).toBe(record)
  })

  it('refuses when the newest record is a different deployment', () => {
    // The case this guard exists for: an abandoned deploy left an earlier
    // EcoFacet on tron, so "newest record" and "address just verified" can name
    // different contracts.
    const record = makeRecord({
      address: 'TTukYpunN8FipnhvpbGhhd5646Er3YUhom',
    })

    expect(() =>
      resolveRecordToFlag(
        record,
        'EcoFacet',
        'tron',
        'TRzEvqhoK6pC58rmUFMgCoEtQgiHYh2FCQ'
      )
    ).toThrow(/Refusing to flag a record for an address this run did not/)
  })

  it('names both addresses so the mismatch can be acted on', () => {
    const record = makeRecord({
      address: 'TTukYpunN8FipnhvpbGhhd5646Er3YUhom',
    })

    expect(() =>
      resolveRecordToFlag(
        record,
        'EcoFacet',
        'tron',
        'TRzEvqhoK6pC58rmUFMgCoEtQgiHYh2FCQ'
      )
    ).toThrow(
      /TTukYpunN8FipnhvpbGhhd5646Er3YUhom[\s\S]*TRzEvqhoK6pC58rmUFMgCoEtQgiHYh2FCQ/
    )
  })

  it('refuses when no record exists at all', () => {
    expect(() =>
      resolveRecordToFlag(
        null,
        'EcoFacet',
        'tron',
        'TRzEvqhoK6pC58rmUFMgCoEtQgiHYh2FCQ'
      )
    ).toThrow('No deployment record for EcoFacet on tron')
  })

  it('compares addresses exactly, since Tron base58 is case-sensitive', () => {
    const record = makeRecord({
      address: 'trzevqhok6pc58rmufmgcoetqgihyh2fcq',
    })

    expect(() =>
      resolveRecordToFlag(
        record,
        'EcoFacet',
        'tron',
        'TRzEvqhoK6pC58rmUFMgCoEtQgiHYh2FCQ'
      )
    ).toThrow(/Refusing to flag/)
  })
})
