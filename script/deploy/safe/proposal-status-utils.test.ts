/**
 * Tests for the pure proposal-summary helpers. The helpers normalize raw
 * MongoDB Safe tx documents (object- or Map-shaped signatures, bigint/number
 * nonces, Date/string timestamps), so the suite covers each input shape and
 * the malformed-document edge cases.
 */

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import {
  getSelector,
  getSigners,
  summarizeProposalDoc,
} from './proposal-status-utils'
import type { ISafeTxDocument } from './safe-utils'

const SIGNER_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SIGNER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function buildDoc(overrides: Partial<ISafeTxDocument> = {}): ISafeTxDocument {
  return {
    safeAddress: '0x1111111111111111111111111111111111111111',
    network: 'arbitrum',
    chainId: 42161,
    safeTx: {
      data: {
        to: '0x2222222222222222222222222222222222222222' as `0x${string}`,
        value: 0n,
        data: '0x1f931c1c0000000000000000000000000000000000000000000000000000000000000060' as `0x${string}`,
        operation: 0,
        nonce: 99n,
      },
      signatures: {
        [SIGNER_A.toLowerCase()]: { signer: SIGNER_A, data: '0xsig1' },
      },
    } as unknown as ISafeTxDocument['safeTx'],
    safeTxHash: '0xhash',
    proposer: '0x3333333333333333333333333333333333333333',
    timestamp: new Date('2026-06-12T10:00:00.000Z'),
    status: 'pending',
    ...overrides,
  }
}

describe('getSigners', () => {
  it('reads object-shaped signatures and lowercases signer addresses', () => {
    const doc = buildDoc()
    expect(getSigners(doc)).toEqual([SIGNER_A.toLowerCase()])
  })

  it('reads Map-shaped signatures (in-memory shape)', () => {
    const doc = buildDoc()
    doc.safeTx.signatures = new Map([
      [SIGNER_A.toLowerCase(), { signer: SIGNER_A, data: '0xsig1' }],
      [SIGNER_B, { signer: SIGNER_B, data: '0xsig2' }],
    ]) as unknown as ISafeTxDocument['safeTx']['signatures']
    expect(getSigners(doc)).toEqual([SIGNER_A.toLowerCase(), SIGNER_B])
  })

  it('returns empty for missing signatures', () => {
    const doc = buildDoc()
    delete (doc.safeTx as unknown as Record<string, unknown>).signatures
    expect(getSigners(doc)).toEqual([])
  })

  it('returns empty for empty signatures object', () => {
    const doc = buildDoc()
    doc.safeTx.signatures =
      {} as unknown as ISafeTxDocument['safeTx']['signatures']
    expect(getSigners(doc)).toEqual([])
  })

  it('skips malformed signature entries', () => {
    const doc = buildDoc()
    doc.safeTx.signatures = {
      a: null,
      b: 'not-an-object',
      c: { data: '0xsig' },
      d: { signer: 12345, data: '0xsig' },
      e: { signer: SIGNER_B, data: '0xsig2' },
    } as unknown as ISafeTxDocument['safeTx']['signatures']
    expect(getSigners(doc)).toEqual([SIGNER_B])
  })
})

describe('getSelector', () => {
  it('extracts the 4-byte selector', () => {
    expect(
      getSelector('0x1f931c1c0000000000000000000000000000000000000060')
    ).toBe('0x1f931c1c')
  })

  it('returns 0x for empty calldata', () => {
    expect(getSelector('0x')).toBe('0x')
  })

  it('returns 0x for short calldata', () => {
    expect(getSelector('0x1f93')).toBe('0x')
  })

  it('returns 0x for non-string input', () => {
    expect(getSelector(undefined)).toBe('0x')
    expect(getSelector(42)).toBe('0x')
  })

  it('returns 0x for non-hex strings', () => {
    expect(getSelector('1f931c1c00000000')).toBe('0x')
  })
})

describe('summarizeProposalDoc', () => {
  it('summarizes a well-formed pending proposal', () => {
    const summary = summarizeProposalDoc(buildDoc())
    expect(summary).toEqual({
      network: 'arbitrum',
      chainId: 42161,
      safeAddress: '0x1111111111111111111111111111111111111111',
      nonce: 99,
      to: '0x2222222222222222222222222222222222222222',
      selector: '0x1f931c1c',
      status: 'pending',
      signatureCount: 1,
      signers: [SIGNER_A.toLowerCase()],
      proposer: '0x3333333333333333333333333333333333333333',
      safeTxHash: '0xhash',
      timestamp: '2026-06-12T10:00:00.000Z',
    })
  })

  it('includes executionHash when present', () => {
    const summary = summarizeProposalDoc(
      buildDoc({ status: 'executed', executionHash: '0xexec' })
    )
    expect(summary.status).toBe('executed')
    expect(summary.executionHash).toBe('0xexec')
  })

  it('handles string timestamps and numeric nonces from raw documents', () => {
    const doc = buildDoc({
      timestamp: '2026-06-12T11:00:00.000Z' as unknown as Date,
    })
    ;(doc.safeTx.data as unknown as Record<string, unknown>).nonce = 7
    const summary = summarizeProposalDoc(doc)
    expect(summary.timestamp).toBe('2026-06-12T11:00:00.000Z')
    expect(summary.nonce).toBe(7)
  })

  it('defaults missing nested fields without throwing', () => {
    const doc = buildDoc({
      timestamp: undefined as unknown as Date,
    })
    ;(doc as unknown as Record<string, unknown>).safeTx = {}
    const summary = summarizeProposalDoc(doc)
    expect(summary.nonce).toBe(0)
    expect(summary.to).toBe('')
    expect(summary.selector).toBe('0x')
    expect(summary.signatureCount).toBe(0)
    expect(summary.timestamp).toBe('')
  })
})
