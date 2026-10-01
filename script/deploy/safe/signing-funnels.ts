/**
 * The sign and execute funnels behind every signing action of
 * `confirm-safe-tx.ts`, and the dispatch from a chosen action to them. Built
 * from injected dependencies so the refusals they run can be driven in a test
 * without a key, a device, the store or a chain.
 */

import { consola } from 'consola'

import {
  assertCodehashSignGateAllowsSigning,
  createGatedSigner,
  proposalKeyOf,
  type ICodehashSignGate,
} from './codehash-sign-gate'
import {
  assertIntegrityAssertsAllowSigning,
  type IIntegrityAssertRun,
} from './confirm-integrity-asserts'
import {
  assertNoDefiniteRed,
  type IDefiniteRedVerdict,
} from './definite-red-gate'
import type {
  IAugmentedSafeTxDocument,
  ISafeTransaction,
  ISafeTxMongoDocument,
  SafeClient,
} from './safe-utils'

/** The per-proposal verdicts both funnels refuse on. */
export interface ISigningFunnelVerdicts {
  codehashGate: ICodehashSignGate
  integrityRun: IIntegrityAssertRun | undefined
  definiteRed: IDefiniteRedVerdict | undefined
}

export interface ISigningFunnelDeps {
  /** The run's own Safe client, used whenever a funnel is not handed another. */
  safe: SafeClient
  /**
   * Read on every call rather than captured, because the caller adopts a fresh
   * set per proposal and a captured value would be the previous proposal's.
   */
  verdicts: () => ISigningFunnelVerdicts
  /** Puts an already-refusal-checked transaction on the chain and records it. */
  broadcast: (
    safeTransaction: ISafeTransaction,
    txDoc: ISafeTxMongoDocument,
    safeClient: SafeClient
  ) => Promise<boolean>
  persistSigned: (
    txDoc: ISafeTxMongoDocument,
    signedTx: ISafeTransaction
  ) => Promise<void>
  initDeployerClient: () => Promise<SafeClient>
  isSignedByDeployer: (safeTx: ISafeTransaction) => boolean
  logError?: (context: string, error: unknown) => void
}

/** What one action did to the proposal, as observed rather than as chosen. */
export interface ISigningActionOutcome {
  signatures: number
  signedThisRun: boolean
  executedThisRun: boolean
}

/**
 * @param deps - Everything the funnels reach past their refusals.
 * @returns The two funnels and `runAction`, which dispatches a chosen menu
 *   option to them.
 */
export const createSigningFunnels = (deps: ISigningFunnelDeps) => {
  const { safe } = deps
  const logError =
    deps.logError ??
    ((context: string, error: unknown) => consola.error(context, error))

  /**
   * Signs a SafeTransaction.
   *
   * Every sign path goes through here — Sign, Sign & Execute, and both deployer
   * steps of Sign and Execute With Deployer — so the codehash refusal is
   * evaluated once and cannot be missed by a path added later. It is the first
   * statement, ahead of every other check in this function, so nothing it would
   * otherwise swallow runs first.
   *
   * @param safeTransaction - The transaction to sign
   * @param client - Which Safe client signs; the run's own by default
   * @returns The signed transaction
   */
  const signTransaction = createGatedSigner<
    [ISafeTransaction, SafeClient?],
    ISafeTransaction
  >({
    gate: () => deps.verdicts().codehashGate,
    // Which transaction this signature will cover, so the verdict is checked
    // against it rather than merely being non-blocking.
    keyOf: (safeTransaction) => proposalKeyOf(safeTransaction.data),
    sign: async (safeTransaction, client = safe) => {
      const { integrityRun, definiteRed } = deps.verdicts()
      // After the codehash refusal `createGatedSigner` has already run, never
      // before it: placed first this would swallow that refusal, and the
      // codehash verdict is the more specific answer of the two. Still ahead of
      // every statement of this body, so nothing signs before it.
      assertIntegrityAssertsAllowSigning(
        integrityRun,
        proposalKeyOf(safeTransaction.data)
      )
      assertNoDefiniteRed(definiteRed, proposalKeyOf(safeTransaction.data))

      consola.info('Signing transaction')
      try {
        const signedTx = await client.signTransaction(safeTransaction)
        consola.success('Transaction signed')
        return signedTx
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        consola.error('Error signing transaction:', error)
        throw new Error(`Failed to sign transaction: ${errorMsg}`)
      }
    },
  })

  /**
   * Executes a SafeTransaction once every refusal has passed.
   * @param safeTransaction - The transaction to execute
   * @param txDoc - The pendingTransactions row being processed
   * @param safeClient - The Safe client to use for execution (defaults to main safe client)
   * @returns Whether the broadcast consumed the Safe nonce
   */
  const executeTransaction = async (
    safeTransaction: ISafeTransaction,
    txDoc: ISafeTxMongoDocument,
    safeClient: SafeClient = safe
  ): Promise<boolean> => {
    const { codehashGate, integrityRun, definiteRed } = deps.verdicts()
    // Execution is the irreversible step, and it needs no signature of ours: a
    // proposal already at threshold is broadcast from here with other people's
    // signatures, so the sign funnel is never consulted and the gate's verdict
    // sat on screen in red while nothing refused.
    //
    // Two route-disjoint gates is D23's ruling. WP-1.4 read D9's "the gate is
    // never in two places" as forbidding a second gate anywhere and left the
    // direct-broadcast route open; the same reading would leave this one open.
    // Every execute branch calls this helper, so asserting here covers all of
    // them by construction, and the sign-then-execute paths simply assert twice.
    assertCodehashSignGateAllowsSigning(
      codehashGate,
      proposalKeyOf(safeTransaction.data)
    )

    // The same route-disjoint pair, for the same reason: a proposal already at
    // threshold reaches the chain from here without the sign funnel being
    // consulted. Ordered after the codehash refusal so that one still reports
    // first, and before anything this function broadcasts.
    assertIntegrityAssertsAllowSigning(
      integrityRun,
      proposalKeyOf(safeTransaction.data)
    )
    assertNoDefiniteRed(definiteRed, proposalKeyOf(safeTransaction.data))

    return deps.broadcast(safeTransaction, txDoc, safeClient)
  }

  /**
   * Runs one chosen menu option against one proposal. A failure is logged and
   * ends the action, never the run.
   *
   * @param action - The option the signer chose
   * @param tx - The proposal it was chosen for
   * @returns What the action did
   */
  const runAction = async (
    action: string,
    tx: IAugmentedSafeTxDocument
  ): Promise<ISigningActionOutcome> => {
    let signedThisRun = false
    let executedThisRun = false
    let signatures = tx.safeTransaction.signatures.size

    if (action === 'Sign')
      try {
        const safeTransaction = tx.safeTransaction
        const signedTx = await signTransaction(safeTransaction)
        await deps.persistSigned(tx, signedTx)
        signedThisRun = true
        signatures = signedTx.signatures.size
      } catch (error) {
        logError('Error signing transaction:', error)
      }

    if (action === 'Sign & Execute')
      try {
        const safeTransaction = tx.safeTransaction
        const signedTx = await signTransaction(safeTransaction)
        await deps.persistSigned(tx, signedTx)
        signedThisRun = true
        signatures = signedTx.signatures.size
        if (await executeTransaction(signedTx, tx)) executedThisRun = true
      } catch (error) {
        logError('Error signing and executing transaction:', error)
      }

    if (action === 'Sign and Execute With Deployer')
      try {
        // Step 1: Sign with current user
        const safeTransaction = tx.safeTransaction
        const signedTx = await signTransaction(safeTransaction)

        // Step 2: Update MongoDB with current user's signature
        await deps.persistSigned(tx, signedTx)
        signedThisRun = true
        signatures = signedTx.signatures.size

        // Step 3: Initialize deployer Safe client
        consola.info('Initializing deployer wallet...')
        const deployerSafe = await deps.initDeployerClient()

        // Step 4: Check if deployer needs to sign
        const needsDeployerSignature = !deps.isSignedByDeployer(signedTx)
        let finalTx = signedTx

        if (needsDeployerSignature) {
          consola.info('Deployer signature needed - signing with deployer...')
          // Sign with deployer
          const deployerSignedTx = await signTransaction(signedTx, deployerSafe)

          // Update MongoDB with deployer's signature
          await deps.persistSigned(tx, deployerSignedTx)
          finalTx = deployerSignedTx
          signatures = deployerSignedTx.signatures.size
        } else
          consola.info(
            'Deployer has already signed - proceeding to execution...'
          )

        // Step 5: Execute with deployer using shared executeTransaction function
        consola.info('Executing transaction with deployer wallet...')
        if (await executeTransaction(finalTx, tx, deployerSafe))
          executedThisRun = true
      } catch (error) {
        logError(
          'Error signing and executing transaction with deployer:',
          error
        )
      }

    if (action === 'Execute')
      try {
        if (await executeTransaction(tx.safeTransaction, tx))
          executedThisRun = true
      } catch (error) {
        logError('Error executing transaction:', error)
      }

    if (action === 'Execute with Deployer')
      try {
        const safeTransaction = tx.safeTransaction
        consola.info('Initializing deployer wallet...')
        const deployerSafe = await deps.initDeployerClient()
        consola.info('Executing transaction with deployer wallet...')
        if (await executeTransaction(safeTransaction, tx, deployerSafe))
          executedThisRun = true
      } catch (error) {
        logError('Error executing with deployer:', error)
      }

    return { signatures, signedThisRun, executedThisRun }
  }

  return { signTransaction, executeTransaction, runAction }
}
