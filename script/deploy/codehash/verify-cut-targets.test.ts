/**
 * The sign-time gate as a whole: classify the cut, then judge every address it
 * would install.
 *
 * Two properties matter more than the happy path. **Three buckets stay three** —
 * MISMATCH and UNVERIFIABLE both stop a signature but are different facts, and
 * collapsing them is what trains a signer to click through grey. And **nothing
 * fails open**: an address whose code or attestations cannot be read is not a
 * pass, because "we could not check" and "we checked and it is fine" are the two
 * things a gate exists to keep apart.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { getAddress } from 'viem'

import type { IAttestedBuild, IObservedCode } from './attested-set'
import { FacetCutActionEnum } from './cut-classification'
import { verifyCutTargets } from './verify-cut-targets'

const A = getAddress('0x1111111111111111111111111111111111111111')
const B = getAddress('0x2222222222222222222222222222222222222222')
const INIT = getAddress('0x3333333333333333333333333333333333333333')
const ZERO = '0x0000000000000000000000000000000000000000'

const HASH = `0x${'ab'.repeat(32)}`
const OTHER = `0x${'cd'.repeat(32)}`

const observed = (maskedHash: string): IObservedCode => ({
  maskedHash,
  rawByteLength: 100,
  rawHash: maskedHash,
  maskedByteCount: 0,
})

// `solcVersion` and `rawHash` are declared required-but-nullable on
// IAttestedBuild rather than optional, so a caller cannot omit them by accident.
// Spelling them out here is that design working.
const attested = (
  maskedHash: string,
  lineage = 'main@abc1234'
): IAttestedBuild => ({
  lineage,
  maskedHash,
  rawByteLength: 100,
  rawHash: maskedHash,
  solcVersion: '0.8.29',
})

const add = (facetAddress: string) => ({
  facetAddress,
  action: FacetCutActionEnum.Add,
})
const remove = (facetAddress: string) => ({
  facetAddress,
  action: FacetCutActionEnum.Remove,
})

const deps = (overrides?: {
  observe?: (address: string) => Promise<IObservedCode>
  attestationsFor?: (address: string) => Promise<IAttestedBuild[]>
  isClosedSet?: boolean
}) => ({
  scope: () => ({ isClosedSet: overrides?.isClosedSet ?? true }),
  observe: overrides?.observe ?? (async () => observed(HASH)),
  attestationsFor: overrides?.attestationsFor ?? (async () => [attested(HASH)]),
})

describe('verifyCutTargets', () => {
  it('passes a cut whose installed code matches an attested build', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps()
    )

    expect(report.blocksSigning).toBe(false)
    expect(report.refusals).toEqual([])
    expect(report.targets).toHaveLength(1)
    expect(report.targets[0]?.verdict).toBe('MATCH')
    expect(report.targets[0]?.address).toBe(A)
  })

  it('blocks on a MISMATCH and says which address', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({ observe: async () => observed(OTHER) })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.verdict).toBe('MISMATCH')
    expect(report.summary).toContain(A)
  })

  it('keeps UNVERIFIABLE distinct from MISMATCH while still blocking', async () => {
    // Three buckets, not two. Both stop the signature; a signer told "grey" and
    // a signer told "red" are being asked different questions.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({ attestationsFor: async () => [], isClosedSet: false })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.targets[0]?.verdict).not.toBe('MISMATCH')
  })

  it('never consults the chain for an address it does not gate', async () => {
    // A Remove installs nothing, so reading its code is not merely wasteful —
    // a verdict on it would invite blocking a removal, which criterion (d)
    // forbids.
    const looked: string[] = []
    const report = await verifyCutTargets(
      { cuts: [remove(A)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async (address) => {
          looked.push(address)
          return observed(HASH)
        },
      })
    )

    expect(looked).toEqual([])
    expect(report.blocksSigning).toBe(false)
    expect(report.targets).toEqual([])
  })

  it('gates the additive half of a mixed batch and only that half', async () => {
    const looked: string[] = []
    const report = await verifyCutTargets(
      { cuts: [add(A), remove(B)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async (address) => {
          looked.push(address)
          return observed(HASH)
        },
      })
    )

    expect(looked).toEqual([A])
    expect(report.blocksSigning).toBe(false)
  })

  it('judges _init as its own target', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: INIT, network: 'mainnet' },
      deps({
        observe: async (address) => observed(address === INIT ? OTHER : HASH),
      })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets.find((t) => t.address === INIT)?.verdict).toBe(
      'MISMATCH'
    )
  })

  it('blocks on a classification refusal without reading any code', async () => {
    // A removal-only cut carrying _init is malformed, not unverifiable, so
    // there is nothing to compare and asking the chain would imply otherwise.
    const looked: string[] = []
    const report = await verifyCutTargets(
      { cuts: [remove(A)], init: INIT, network: 'mainnet' },
      deps({
        observe: async (address) => {
          looked.push(address)
          return observed(HASH)
        },
      })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.refusals).toHaveLength(1)
    expect(looked).toEqual([])
    expect(report.targets).toEqual([])
  })

  it('blocks when the deployed code cannot be read, rather than passing', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async () => {
          throw new Error('rpc unreachable')
        },
      })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.targets[0]?.reason).toMatch(/could not be read/)
    expect(report.targets[0]?.reason).toMatch(/rpc unreachable/)
  })

  it('blocks when the attestations cannot be read, rather than treating it as none', async () => {
    // "No attested build" and "we could not find out" look identical from the
    // outside and must not: the first is a missing rebuild, the second is an
    // infrastructure failure that could hide either answer.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        attestationsFor: async () => {
          throw new Error('attestation store down')
        },
      })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.targets[0]?.reason).toMatch(/attestation store down/)
  })

  it('judges every target even after one has already failed', async () => {
    // Stopping at the first would show a signer one problem at a time, and a
    // second MISMATCH is a different fact worth seeing at once.
    const report = await verifyCutTargets(
      { cuts: [add(A), add(B)], init: ZERO, network: 'mainnet' },
      deps({ observe: async () => observed(OTHER) })
    )

    expect(report.targets).toHaveLength(2)
    expect(report.targets.every((t) => t.verdict === 'MISMATCH')).toBe(true)
  })

  it('passes the network through to the scope, never a default', async () => {
    const asked: string[] = []
    await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'abstract' },
      {
        ...deps(),
        scope: (network: string) => {
          asked.push(network)
          return { isClosedSet: true }
        },
      }
    )

    expect(asked).toEqual(['abstract'])
  })

  it('reports the excluded immutable byte count, so a MATCH is not over-read', async () => {
    // compareToAttestedSet's own docstring: a MATCH says nothing about masked
    // immutables, so a caller that has not run layer 2 must not render an
    // unqualified green.
    // The attestation must NOT pin exact bytes here: a rawHash-pinned build is
    // compared byte for byte, so it correctly reports zero excluded bytes. This
    // case is about the normalised-comparison path, where the masking is real.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async () => ({ ...observed(HASH), maskedByteCount: 64 }),
        attestationsFor: async () => [
          { ...attested(HASH), rawHash: undefined },
        ],
      })
    )

    expect(report.targets[0]?.verdict).toBe('MATCH')
    expect(report.targets[0]?.excludedByteCount).toBeGreaterThan(0)
    expect(report.summary).toMatch(/immutable/i)
  })
})
