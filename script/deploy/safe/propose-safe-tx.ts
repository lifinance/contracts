/**
 * The one entry point that turns a call into a stored Safe proposal.
 *
 * The checks that ride on storage — the mandatory Linear ticket, the resolved
 * reason, the duplicate-intent refusal, the nonce-collision retry — are only as
 * wide as the set of paths that reach it. `.eslintrc.funnel-fence.cjs` refuses
 * any other file that names `storeTransactionInMongoDB`, so a propose route
 * added later either comes through here or fails lint.
 *
 * Checks that need more than the proposal — the production deploy gate, the
 * proposal card — stay at their call sites; this seam is what makes the set of
 * those call sites enumerable.
 *
 * `docs/MultisigSigningProcess.md` §4.2 records which paths reach it.
 */

import type { Collection } from 'mongodb'
import type { Address, Hex } from 'viem'

import {
  OperationTypeEnum,
  isAddressASafeOwner,
  storeTransactionInMongoDB,
  type IParkedTaskRef,
  type IProposalProvenanceOptions,
  type ISafeTransaction,
  type ISafeTxDocument,
  type SafeClient,
} from './safe-utils'

/**
 * What to propose: a single call this builds, or a transaction the caller has
 * already built (`createAddOwnerTx`, `createChangeThresholdTx`).
 *
 * The nonce belongs to the caller in both forms. Resolving it here would need a
 * "trust the caller's value" branch for the loops that propose several
 * transactions off one on-chain read, and that branch is indistinguishable from
 * an unvalidated override.
 */
export type ProposalPayload =
  | {
      kind: 'call'
      to: Address
      value?: bigint
      data: Hex
      operation?: OperationTypeEnum
      nonce: bigint
    }
  | { kind: 'prebuilt'; safeTx: ISafeTransaction }

export interface IProposeSafeTxInput {
  safe: SafeClient
  network: string
  chainId: number
  safeAddress: Address
  pendingTransactions: Collection<ISafeTxDocument>
  payload: ProposalPayload
  /** Origin-PR links when this proposal carries drained facet removals. */
  parkedTaskRefs?: IParkedTaskRef[]
  provenance?: IProposalProvenanceOptions
}

export interface IProposeSafeTxResult {
  safeTxHash: Hex
  /** `false` when a pending proposal with the same intent already existed. */
  stored: boolean
}

/**
 * Signs and stores one Safe proposal.
 *
 * @param input - the Safe client, its network identity, the proposal store, and
 *   the transaction to propose
 * @returns the proposal's Safe tx hash, and whether this call created the record
 * @throws If the signer is not a Safe owner, or the store rejects the write.
 */
export const proposeSafeTx = async (
  input: IProposeSafeTxInput
): Promise<IProposeSafeTxResult> => {
  const proposer = input.safe.account.address

  // Before the signature: a proposal signed by a non-owner is still stored and
  // still occupies a Safe nonce, and fails only at execution time.
  const owners = await input.safe.getOwners()
  if (!isAddressASafeOwner(owners, proposer))
    throw new Error(
      `Signer ${proposer} is not an owner of Safe ${input.safeAddress} on ${input.network}`
    )

  const safeTx =
    input.payload.kind === 'prebuilt'
      ? input.payload.safeTx
      : await input.safe.createTransaction({
          transactions: [
            {
              to: input.payload.to,
              value: input.payload.value ?? 0n,
              data: input.payload.data,
              operation: input.payload.operation ?? OperationTypeEnum.Call,
              nonce: input.payload.nonce,
            },
          ],
        })

  const signedTx = await input.safe.signTransaction(safeTx)
  // Hashed off the signed transaction, so the stored hash and the stored
  // signature can only ever describe the same bytes.
  const safeTxHash = await input.safe.getTransactionHash(signedTx)

  const result = await storeTransactionInMongoDB(
    input.pendingTransactions,
    input.safeAddress,
    input.network,
    input.chainId,
    signedTx,
    safeTxHash,
    proposer,
    input.parkedTaskRefs,
    input.provenance
  )

  if (result === null) return { safeTxHash, stored: false }

  if (!result.acknowledged)
    throw new Error('MongoDB insert was not acknowledged')

  return { safeTxHash, stored: true }
}
