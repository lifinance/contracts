/**
 * Hashes are the two lineage values measured on this repo's own artifacts, so a
 * fixture that stands for "main's build" is a real one. Provenance is in
 * `bytecode-trailer.test.ts`.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IAttestedBuild, IObservedCode } from './attested-set'
import { evaluateDeploySelfCheck } from './deploy-self-check'

const MAIN_HASH =
  // pre-commit-checker: not a secret — keccak of public runtime bytecode
  '0x632dab2dd5d993b30427c6e779ba627ff5a9db3621b26901502a773aa0938f86'
const MAIN_BYTES = 1440
/** A feature branch that genuinely changed the code. */
const BRANCH_HASH = `0x${'ab'.repeat(32)}`

const ATTESTED: IAttestedBuild[] = [
  {
    lineage: 'upstream london',
    solcVersion: '0.8.17',
    maskedHash: MAIN_HASH,
    rawByteLength: MAIN_BYTES,
    rawHash: undefined,
  },
]

const CLOSED = { isClosedSet: true }

const onChain = (over: Partial<IObservedCode> = {}): IObservedCode => ({
  maskedHash: MAIN_HASH,
  rawByteLength: MAIN_BYTES,
  rawHash: `0x${'11'.repeat(32)}`,
  maskedByteCount: 0,
  solcVersion: '0.8.17',
  ...over,
})

describe('evaluateDeploySelfCheck', () => {
  it('passes silently when the deploy is main-identical', () => {
    // T1: built bytes equal main's bytes, so the sign-time gate will verify it
    // and there is nothing for the operator to decide.
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain(),
      builtMaskedHash: MAIN_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('PASS')
    expect(result.requiresExplicitContinue).toBe(false)
    expect(result.blocksProposal).toBe(false)
    expect(result.attestedVerdict).toBe('MATCH')
  })

  it('refuses when the deployed code is not the artifact this run built', () => {
    // A stale `out/` or the wrong profile. The proposal would describe code
    // nobody reviewed, and unlike a branch mismatch there is no honest version
    // of this.
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain({ maskedHash: BRANCH_HASH }),
      builtMaskedHash: MAIN_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('REFUSE')
    expect(result.blocksProposal).toBe(true)
    expect(result.requiresExplicitContinue).toBe(false)
    expect(result.reason).toMatch(/not the artifact this run built/)
    // The attested comparison is not reached: it would answer a question that
    // does not matter once the artifact itself disagrees.
    expect(result.attestedVerdict).toBe('NOT_EVALUATED')
  })

  it('asks for an explicit continue on a feature branch, and does not block', () => {
    // The deploy is internally consistent — the chain holds what was built — but
    // no attested build of main matches, so a signer cannot verify it yet.
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain({ maskedHash: BRANCH_HASH }),
      builtMaskedHash: BRANCH_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('CONFIRM')
    expect(result.requiresExplicitContinue).toBe(true)
    expect(result.blocksProposal).toBe(false)
    expect(result.reason).toMatch(
      /will fail at sign time until the branch is merged and the facet version audited/
    )
    expect(result.attestedVerdict).toBe('MISMATCH')
  })

  it('refuses when the artifact could not be read at all', () => {
    // Our own build output. Not being able to read it is a local problem, and
    // treating it as "cannot tell" would let an unchecked deploy through.
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain(),
      builtMaskedHash: undefined,
      builtRawByteLength: undefined,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('REFUSE')
    expect(result.blocksProposal).toBe(true)
    expect(result.reason).toMatch(/could not be read/)
  })

  it('ignores case and prefix when comparing against the artifact', () => {
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain({ maskedHash: MAIN_HASH.slice(2).toUpperCase() }),
      builtMaskedHash: MAIN_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('PASS')
  })

  it('asks for a continue rather than refusing when nothing is attested yet', () => {
    // A first-time deploy on a new network has no attested build to compare
    // against. The sign-time gate will read UNVERIFIABLE, which is worth saying,
    // but refusing here would stop every new-chain rollout with no remedy.
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain(),
      builtMaskedHash: MAIN_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: [],
      scope: CLOSED,
    })

    expect(result.outcome).toBe('CONFIRM')
    expect(result.blocksProposal).toBe(false)
    expect(result.attestedVerdict).toBe('UNVERIFIABLE')
  })

  it('keeps the artifact check ahead of the attested one', () => {
    // Both disagree. The refusal has to win: an operator told "this will fail at
    // sign time, continue?" would say yes on a feature branch, and would then
    // have proposed a stale artifact.
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain({ maskedHash: `0x${'cd'.repeat(32)}` }),
      builtMaskedHash: BRANCH_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('REFUSE')
    expect(result.requiresExplicitContinue).toBe(false)
  })

  it('names the contract in every outcome', () => {
    // The self-check runs per contract inside a fleet rollout, so a message
    // without a name is unusable in the scrollback.
    const outcomes = [
      {
        builtMaskedHash: MAIN_HASH,
        builtRawByteLength: MAIN_BYTES,
        attested: ATTESTED,
      },
      {
        builtMaskedHash: BRANCH_HASH,
        builtRawByteLength: MAIN_BYTES,
        attested: ATTESTED,
      },
      {
        builtMaskedHash: undefined,
        builtRawByteLength: undefined,
        attested: ATTESTED,
      },
    ].map(
      (over) =>
        evaluateDeploySelfCheck({
          contractName: 'ReceiverStargateV2',
          observed: onChain(),
          scope: CLOSED,
          ...over,
        }).reason
    )

    for (const reason of outcomes)
      expect(reason).toContain('ReceiverStargateV2')
  })
})

describe('what the normalised hash does not pin', () => {
  it('refuses code that normalises to the artifact but is longer', () => {
    // The same defect this repo fixed one layer down in `compareToAttestedSet`:
    // the normalised hash is taken with the trailer removed, and the trailer's
    // own length word says how much to remove, so appended bytes survive it.
    // Reaching CONFIRM here would let an operator wave through a payload.
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain({ rawByteLength: MAIN_BYTES + 3002 }),
      builtMaskedHash: MAIN_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('REFUSE')
    expect(result.blocksProposal).toBe(true)
    expect(result.requiresExplicitContinue).toBe(false)
    expect(result.reason).toContain('4442 bytes where the artifact is 1440')
  })

  it('refuses when bytes are missing as well as when they are added', () => {
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain({ rawByteLength: MAIN_BYTES - 8 }),
      builtMaskedHash: MAIN_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('REFUSE')
  })

  it('refuses when the artifact length could not be read', () => {
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain(),
      builtMaskedHash: MAIN_HASH,
      builtRawByteLength: undefined,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('REFUSE')
    expect(result.reason).toMatch(/could not be read/)
  })

  it('still passes when hash and length both agree', () => {
    // The control: a length check that refused everything would satisfy the
    // three assertions above just as well.
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain(),
      builtMaskedHash: MAIN_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.outcome).toBe('PASS')
  })
})

describe('the remedy has to match the verdict', () => {
  it('tells a feature branch to merge and get the version audited', () => {
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain({ maskedHash: BRANCH_HASH }),
      builtMaskedHash: BRANCH_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: ATTESTED,
      scope: CLOSED,
    })

    expect(result.attestedVerdict).toBe('MISMATCH')
    expect(result.reason).toMatch(/until the branch is merged/)
  })

  it('does not tell an unverifiable deploy to merge, because merging will not fix it', () => {
    // An empty attested set stays unverifiable after a merge; what it needs is
    // something to compare against. Offering the wrong remedy is worse than
    // offering none — the operator does it, nothing changes, and the warning
    // stops meaning anything.
    const result = evaluateDeploySelfCheck({
      contractName: 'AccessManagerFacet',
      observed: onChain(),
      builtMaskedHash: MAIN_HASH,
      builtRawByteLength: MAIN_BYTES,
      attested: [],
      scope: CLOSED,
    })

    expect(result.attestedVerdict).toBe('UNVERIFIABLE')
    expect(result.reason).toMatch(/until an attested build of main exists/)
    expect(result.reason).not.toMatch(/until the branch is merged/)
  })
})
