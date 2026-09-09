// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import type { Hex } from 'viem'

import {
  buildSignedSetRecord,
  bySignedSetKey,
  formatSignedSetForDisplay,
  type ISignedAuthorityEntry,
  type ISignedCodehashEntry,
} from './signed-set-record'

const OP_ID =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex // pre-commit-checker: not a secret — a synthetic test hash
const DIAMOND = '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'
const TIMELOCK = '0x00000000000000000000000000000000000000a1'
const AT = new Date('2026-09-09T10:00:00.000Z')

const codehash = (
  overrides: Partial<ISignedCodehashEntry> = {}
): ISignedCodehashEntry => ({
  address: DIAMOND,
  contractName: 'LiFiDiamond',
  rawHash: '0xdeadbeef',
  maskedHash: '0xfeedface',
  rawByteLength: 1440,
  observationError: undefined,
  ...overrides,
})

const authority = (
  overrides: Partial<ISignedAuthorityEntry> = {}
): ISignedAuthorityEntry => ({
  label: 'LiFiDiamond.owner()',
  liveValue: TIMELOCK,
  expectedValue: TIMELOCK,
  readError: undefined,
  ...overrides,
})

const build = (
  codehashes: ISignedCodehashEntry[] = [codehash()],
  authorities: ISignedAuthorityEntry[] = [authority()]
) =>
  buildSignedSetRecord(
    {
      operationId: OP_ID,
      network: 'Mainnet',
      chainId: 1,
      safeTxHash: '0xsafetx',
      signer: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
      derivedFromCommit: 'abc1234',
      codehashes,
      authorities,
    },
    AT
  )

describe('buildSignedSetRecord', () => {
  it('carries the observed set and the identity of the run that made it', () => {
    const record = build()

    expect(record.operationId).toBe(OP_ID)
    expect(record.chainId).toBe(1)
    expect(record.safeTxHash).toBe('0xsafetx')
    expect(record.derivedFromCommit).toBe('abc1234')
    expect(record.codehashes).toHaveLength(1)
    expect(record.authorities).toHaveLength(1)
    expect(record.createdAt).toBe(AT)
  })

  it('lowercases the network and the signer so the natural key is stable', () => {
    const record = build()

    expect(record.network).toBe('mainnet')
    expect(record.signer).toBe(DIAMOND)
  })

  it('states on the document itself that it is not the execute-time oracle', () => {
    // Pinned to the literal sentence rather than to the exported constant: an
    // assertion written through the symbol would move with any rewrite of it.
    expect(build().advisory).toBe(
      'Reconstruction record only. The pre-broadcast gate re-derives its verdict from main and never reads these values.'
    )
  })

  it('keeps an unreadable entry rather than dropping it', () => {
    const record = build([
      codehash({
        rawHash: undefined,
        maskedHash: undefined,
        rawByteLength: undefined,
        observationError: 'RPC timed out',
      }),
    ])

    expect(record.codehashes).toHaveLength(1)
    expect(record.codehashes[0]?.observationError).toBe('RPC timed out')
  })

  it('records a missing commit as missing', () => {
    const record = buildSignedSetRecord(
      {
        operationId: OP_ID,
        network: 'mainnet',
        chainId: 1,
        safeTxHash: '0xsafetx',
        signer: DIAMOND,
        derivedFromCommit: undefined,
        codehashes: [],
        authorities: [],
      },
      AT
    )

    expect(record.derivedFromCommit).toBeUndefined()
  })
})

describe('formatSignedSetForDisplay', () => {
  it('prints one line per observed address, with its hash and length', () => {
    const lines = formatSignedSetForDisplay(build())

    expect(lines[0]).toContain(OP_ID)
    expect(lines[0]).toContain('not the execute-time check')
    expect(lines.join('\n')).toContain(DIAMOND)
    expect(lines.join('\n')).toContain('0xdeadbeef')
    expect(lines.join('\n')).toContain('1440 bytes')
  })

  it('marks an address it could not read instead of omitting it', () => {
    const lines = formatSignedSetForDisplay(
      build([
        codehash({
          rawHash: undefined,
          rawByteLength: undefined,
          observationError: 'RPC timed out',
        }),
      ])
    )

    expect(lines.join('\n')).toContain('NOT READ — RPC timed out')
    expect(lines.join('\n')).toContain(DIAMOND)
  })

  it('names an address main could not bind to a contract', () => {
    const lines = formatSignedSetForDisplay(
      build([codehash({ contractName: undefined })])
    )

    expect(lines.join('\n')).toContain('unnamed')
  })

  it('says so explicitly when there is nothing in the set', () => {
    // An empty set rendered as silence reads as "everything checked out".
    const lines = formatSignedSetForDisplay(build([], []))

    expect(lines.join('\n')).toContain('codehashes: none')
    expect(lines.join('\n')).toContain('authorities: none declared')
  })

  it('prints an authority alongside what main declares for it', () => {
    const lines = formatSignedSetForDisplay(build())

    expect(lines.join('\n')).toContain('LiFiDiamond.owner()')
    expect(lines.join('\n')).toContain(`main declares ${TIMELOCK}`)
  })

  it('marks an authority it could not read, and one main declares nothing for', () => {
    const unread = formatSignedSetForDisplay(
      build(
        [codehash()],
        [authority({ liveValue: undefined, readError: 'reverted' })]
      )
    )
    const undeclared = formatSignedSetForDisplay(
      build([codehash()], [authority({ expectedValue: undefined })])
    )

    expect(unread.join('\n')).toContain('NOT READ — reverted')
    expect(undeclared.join('\n')).toContain('main declares nothing')
  })
})

describe('bySignedSetKey', () => {
  it('wraps both fields so a value arriving as an object cannot become an operator', () => {
    expect(bySignedSetKey('Mainnet', OP_ID)).toEqual({
      network: { $eq: 'mainnet' },
      operationId: { $eq: OP_ID },
    })
  })
})
