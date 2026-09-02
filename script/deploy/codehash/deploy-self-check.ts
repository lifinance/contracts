/**
 * Post-deploy, pre-propose self-check.
 *
 * Import this after a deploy and before proposing: it answers whether the code
 * now on chain is the artifact this run built, and whether a signer will be able
 * to verify it later. Two questions with different consequences, which is why
 * one function decides both.
 */

import { compareToAttestedSet } from './attested-set'
import type {
  IAttestedBuild,
  ILineageScope,
  IObservedCode,
  CodehashVerdict,
} from './attested-set'

const normalizeHash = (hash: string): string =>
  (/^0x/i.test(hash) ? hash.slice(2) : hash).toLowerCase()

export type SelfCheckOutcome = 'PASS' | 'CONFIRM' | 'REFUSE'

export interface IDeploySelfCheck {
  contractName: string
  /** The code found at the deployed address, normalised. */
  observed: IObservedCode
  /**
   * Normalised hash of the artifact this deploy used. Undefined when the
   * artifact could not be read — which is a refusal, not a warning: it is our
   * own build output.
   */
  builtMaskedHash: string | undefined
  /** Every attested build of main for this contract. */
  attested: IAttestedBuild[]
  scope: ILineageScope
}

export interface IDeploySelfCheckResult {
  outcome: SelfCheckOutcome
  /** One line for the operator. */
  reason: string
  /** Carried so a caller can render the sign-time verdict it implies. */
  attestedVerdict: CodehashVerdict | 'NOT_EVALUATED'
  /** True only for CONFIRM: the operator has to say yes. */
  requiresExplicitContinue: boolean
  /** True for REFUSE: no proposal may be created. */
  blocksProposal: boolean
}

/**
 * Decides whether a freshly deployed contract may be proposed.
 *
 * The two comparisons are not the same kind of fact. Deployed-versus-built is
 * entirely within this run's control, so a mismatch is a stale `out/` or the
 * wrong profile and there is no legitimate case for continuing. Deployed-versus-
 * attested is expected to differ on a feature branch, so it is a warning about
 * what will happen at sign time, not an error now.
 *
 * @param input - The deployed code, the artifact it should match, and the
 * attested builds to compare against.
 * @returns The outcome, the sign-time verdict it implies, and why.
 */
export const evaluateDeploySelfCheck = (
  input: IDeploySelfCheck
): IDeploySelfCheckResult => {
  const { contractName, observed, builtMaskedHash, attested, scope } = input

  if (builtMaskedHash === undefined)
    return {
      outcome: 'REFUSE',
      reason: `${contractName}: the artifact this deploy used could not be read, so there is nothing to compare the deployed code against`,
      attestedVerdict: 'NOT_EVALUATED',
      requiresExplicitContinue: false,
      blocksProposal: true,
    }

  if (normalizeHash(observed.maskedHash) !== normalizeHash(builtMaskedHash))
    return {
      outcome: 'REFUSE',
      reason: `${contractName}: the code at the deployed address is not the artifact this run built. A stale \`out/\` or the wrong build profile would do this, and either means the proposal would describe different code than was reviewed`,
      attestedVerdict: 'NOT_EVALUATED',
      requiresExplicitContinue: false,
      blocksProposal: true,
    }

  const attestedComparison = compareToAttestedSet(observed, attested, scope)

  if (attestedComparison.verdict === 'MATCH')
    return {
      outcome: 'PASS',
      reason: `${contractName}: deployed code is the artifact this run built, and ${attestedComparison.reason}`,
      attestedVerdict: 'MATCH',
      requiresExplicitContinue: false,
      blocksProposal: false,
    }

  return {
    outcome: 'CONFIRM',
    reason: `${contractName}: deployed code is the artifact this run built, but it matches no attested build of main — ${attestedComparison.reason}. This will fail at sign time until the branch is merged and the facet version audited`,
    attestedVerdict: attestedComparison.verdict,
    requiresExplicitContinue: true,
    blocksProposal: false,
  }
}
