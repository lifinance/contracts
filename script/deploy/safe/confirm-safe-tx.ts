/**
 * Confirm Safe Transactions
 *
 * This script allows users to confirm and execute pending Safe transactions.
 * It fetches pending transactions from MongoDB, displays their details,
 * and provides options to sign and/or execute them.
 */

import {
  formatAddressForNetworkCliDisplay,
  isTronNetworkKey,
} from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import * as dotenv from 'dotenv'
import { type Collection } from 'mongodb'
import {
  createPublicClient,
  fallback,
  http,
  type Address,
  type Hex,
  type Transport,
} from 'viem'

import globalConfig from '../../../config/global.json'
import networksData from '../../../config/networks.json'
import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { redactUrls } from '../../utils/redactUrls'
import { getRPCEnvVarName } from '../../utils/utils'
import {
  buildExplorerAddressUrl,
  getFallbackTransportForChain,
} from '../../utils/viemScriptHelpers'
import { createDefaultCache } from '../shared/deployment-cache'
import { getGitCommit, sanitizeProvenanceText } from '../shared/git-provenance'
import { tronHexSuffix } from '../tron/helpers/tronHexSuffix'

import {
  CALLDATA_ADDRESS_MANIFEST_ENTRY,
  evaluateCalldataAddresses,
  renderCalldataAddresses,
  type IAddressReference,
  type ICalldataAddressVerdict,
  type IDeploymentIndexEntry,
} from './calldata-address-check'
import {
  authoritiesOfInstalled,
  buildDeploymentIndex,
  collectAddressReferences,
  referencedNames,
} from './calldata-address-collector'
import { buildCalldataEffectLines } from './calldata-effect-lines'
import {
  createCheckLedger,
  recordCheck,
  type ICheckLedger,
  type ICheckResult,
} from './check-ledger'
import { readBooleanFlag, readValueFlag } from './cli-flags'
import {
  assertCodehashSignGateAllowsSigning,
  gateInputFor,
  proposalKeyOf,
  blockingUnevaluatedGate,
  createGatedSigner,
  evaluateCodehashSignGate,
  renderCodehashSignGate,
  type ICodehashSignGate,
} from './codehash-sign-gate'
import {
  createSignTimeCodehashDeps,
  type ISignTimeCodehashDeps,
} from './codehash-sign-gate-deps'
import {
  ALL_GATE_DEFINITIONS,
  authorityExpectationAnchors,
  CONFIRM_CHECK_DEFINITIONS,
  EXECUTABILITY_CHECK_ID,
  proposalCheckResults,
  RPC_QUORUM_CHECK_ID,
  worstResultPerCheck,
} from './confirm-check-registry'
import {
  assertIntegrityAssertsAllowSigning,
  createIntegrityAssertDeps,
  runIntegrityAsserts,
  type IIntegrityAssertRun,
} from './confirm-integrity-asserts'
import {
  buildAcknowledgementKey,
  buildProposalKey,
  computeChangeFingerprint,
  createAcknowledgementLedger,
  evaluateProposalIntegrity,
  recordAcknowledgement,
  renderQueueSummary,
  rollUpQueue,
  type INetworkOutcome,
} from './confirm-safe-tx-ack'
import {
  ConfirmSafeTxPrefetchQueue,
  createDeferredLogger,
  ProposalEvidencePrefetchQueue,
  type IConfirmSafeTxNetworkContext,
  type IDeferredLine,
  type IPrefetchedEvidence,
} from './confirm-safe-tx-prefetch'
import {
  describeOperationValue,
  evaluateDelegateCallGate,
} from './delegatecall-gate'
import {
  collectExecutabilityInput,
  createExecutabilityChainReader,
} from './executability-collector'
import {
  evaluateExecutability,
  type IExecutabilityVerdict,
} from './executability-simulation'
import { executabilityNotes } from './executability-view'
import type { ILedgerAccountResult } from './ledger'
import {
  LEDGER_FLEX_HASH_NOTE,
  LEDGER_FLEX_WRAP_NOTE,
  renderLedgerFlexFlow,
  renderLedgerFlexHashFlow,
} from './ledger-flex-preview'
import {
  blockedByEvaluationError,
  createPinnedAnchor,
  createPinnedBlobReader,
  createPinnedTargetStateReader,
  createTargetStateDeps,
  evaluateTargetStateIntent,
  formatTargetStateLines,
  renderTargetStateRefusal,
  type ITargetStateVerdict,
} from './pinned-target-state'
import {
  observeCalldata,
  resolveGateCoverage,
  viemGateReaders,
} from './prebroadcast-gate'
import { asPrintable, printableField, trustedMarkup } from './printable-field'
import { buildReadOnlyClient } from './read-only-safe-client'
import { reconcileAllSubmittedSafeTxs } from './reconcile'
import { renderCheckLedger } from './render-check-ledger'
import { evaluateRpcQuorum, type IRpcQuorumVerdict } from './rpc-quorum'
import {
  collectProviderObservations,
  createCodeReader,
  createPinnedBlock,
  ENDPOINT_READ_BUDGET_MS,
} from './rpc-quorum-collector'
import { getTargetName } from './safe-decode-utils'
import {
  buildCalldataTarget,
  buildSafeTxDetailLines,
  CLAIM_QUESTION,
  signatureTally,
  type ISafeTxDetailInput,
} from './safe-tx-detail-display'
import {
  parseAccountIndex,
  canExecuteWithNonceStatus,
  getNetworksWithActionableTransactions,
  getNetworksWithPendingTransactions,
  getPendingTransactionsByNetwork,
  getPrivateKey,
  getSafeMongoCollection,
  getOrInitializeSafeClient,
  hasEnoughSignatures,
  isFutureNonceExecutionAllowed,
  resolveSafeSigningMode,
  resolveSignerVerificationDisplay,
  isSignedByProductionWallet,
  mongoSafeTxRowFilter,
  PrivateKeyTypeEnum,
  releaseAllPooledSafeClients,
  safeTxStatusConsumedNonce,
  serializeSafeTxForMongo,
  shouldShowSignAndExecuteWithDeployer,
  wouldMeetThreshold,
  type IAugmentedSafeTxDocument,
  type ISafeTransaction,
  type ISafeTxDocument,
  type ISafeTxMongoDocument,
  type SafeClient,
  type SafeNonceStatus,
  type SafeTxStatus,
} from './safe-utils'
import { getSignTimeTransportConfig } from './sign-time-transport'
import {
  buildSignedSetRecord,
  formatSignedSetForDisplay,
  persistSignedSetRecord,
  toSignedAuthorityEntries,
  toSignedCodehashEntries,
} from './signed-set-record'
import {
  networkPreflight,
  PREFLIGHT_EXIT_CODE,
  PREFLIGHT_PROBE_TIMEOUT_MS,
  renderNetworkPreflight,
} from './signer-preflight'
import {
  foldLines,
  checkSummary,
  PROPOSAL_SEPARATOR,
  renderGateDetail,
  renderCheckGroups,
  renderDeferredTodos,
  renderGateManifest,
  renderProposalOutcome,
  renderTodos,
  TODOS_DEFERRED_SUMMARY,
  zoneHeading,
} from './signer-view'
import {
  CHECK_DOCS,
  integrityResults,
  opensDeviceScreens,
  signerChecks,
  signerTodos,
  viewDefinitions,
} from './signer-zones'
import {
  computeOperationIdBatch,
  decodeScheduleBatch,
  enqueueTimelockOpIfApplicable,
  isScheduleBatchCalldata,
} from './timelock-queue'

dotenv.config()

// One set of sign-time codehash dependencies per run: they hold a MongoDB
// connection and a rebuild cache, and a rebuild repeated per network would
// recompile the same commit dozens of times on a fleet rollout.
let codehashDeps: ISignTimeCodehashDeps | undefined
const getCodehashDeps = (): ISignTimeCodehashDeps => {
  codehashDeps ??= createSignTimeCodehashDeps()
  return codehashDeps
}

// One read of the deploy log per run, shared by every proposal: the log is the
// only source written before a proposal exists, and re-reading it per proposal
// would re-fetch the whole fleet on a fleet-wide rollout.
//
// Held as the read in flight rather than as a flag beside the result: a second
// caller arriving while the first is still awaiting passes a flag check and
// reads the not-yet-assigned records as "the log is unavailable", which grades
// every address as one nobody deployed. Proposals are prepared concurrently, so
// that second caller exists.
let deploymentRecordsRead:
  | Promise<IDeploymentIndexEntry[] | undefined>
  | undefined
const readDeploymentRecords = async (): Promise<
  IDeploymentIndexEntry[] | undefined
> => {
  deploymentRecordsRead ??= loadDeploymentRecords()
  return deploymentRecordsRead
}

const loadDeploymentRecords = async (): Promise<
  IDeploymentIndexEntry[] | undefined
> => {
  if (!process.env.MONGODB_URI) return undefined

  try {
    // Same config the run's warm refresh uses, so this reads that cache rather
    // than re-fetching the fleet.
    return await createDefaultCache({
      mongoUri: process.env.MONGODB_URI,
      databaseName: 'contract-deployments',
      batchSize: 100,
    }).get('production')
  } catch {
    // Left undefined, which the index reports as unavailable. An empty record
    // read as available would grade every address as one nobody deployed.
    return undefined
  }
}

// Created once the run's network set is known, because the ledger's
// denominator is that set: a check that never ran on a network must show as a
// missing row rather than shrink the total it is measured against.
//
// Read once, at the end of the run: the verdict is rendered from these rows, so
// a status any row below claims is a status a signer is shown.
let checkLedger: ICheckLedger | undefined

// Networks the preflight refused, kept out of the ledger's denominator and
// therefore invisible to its verdict. Held here so the end of the run can say
// the coverage was short: a ledger that is green for the networks it graded
// must not read as a green run when a network was never graded at all.
let refusedNetworks: string[] = []

const recordEveryCheck = (
  network: string,
  row: Pick<ICheckResult, 'status' | 'actual' | 'anchor'>
): void => {
  if (!checkLedger) return

  for (const definition of CONFIRM_CHECK_DEFINITIONS)
    recordCheck(checkLedger, {
      checkId: definition.checkId,
      network,
      // Quantified over the proposals this run would sign, which is empty on
      // every branch that reaches `recordNothingToGrade` — a network can carry
      // pending transactions and still offer this signer nothing to act on.
      expected: 'every proposal this run would sign graded before signing',
      ...row,
    })
}

/**
 * Records a network the run positively established had nothing to grade.
 *
 * The denominator is fixed before the run can learn that a network it listed as
 * actionable carries no proposal for this operator. Left unrecorded it rolls up
 * as missing and hard-blocks a run on which nothing was wrong.
 *
 * `not-applicable` on `A-LOCAL`, never a pass: nothing on this network was
 * compared, so the row must satisfy no verified counter.
 *
 * Only for outcomes that answered. A read that *failed* has not established
 * anything and belongs in `recordCouldNotGrade` — mixing the two is how a fully
 * green run comes to verify nothing.
 * @param network - The network that carried no proposal.
 * @param reason - What the run established instead, shown on the row.
 */
const recordNothingToGrade = (network: string, reason: string): void =>
  recordEveryCheck(network, {
    status: 'not-applicable',
    actual: `no proposal was graded on ${network} — ${reason}`,
    anchor: 'A-LOCAL',
  })

/**
 * Records a network the run could not reach a verdict on at all.
 *
 * Distinct from `recordNothingToGrade` in exactly the way `check-ledger.ts`'s
 * header requires: a check that could not run is not a check that passed. The
 * row is unverified, so the verdict blocks and names the network — which is the
 * correct outcome for an infrastructure failure, and costs nothing operationally
 * because this ledger reports rather than gates.
 * @param network - The network that could not be graded.
 * @param reason - What failed, shown on the row.
 */
const recordCouldNotGrade = (network: string, reason: string): void =>
  recordEveryCheck(network, {
    status: 'error',
    actual: `nothing could be graded on ${network} — ${reason}`,
    anchor: 'A-UNRESOLVED',
  })

// Acknowledgements roll up across networks so a fleet-wide rollout counts once;
// the operator's chosen action is never remembered.
const acknowledgementLedger = createAcknowledgementLedger()
const networkOutcomes: INetworkOutcome[] = []

// One verified fetch and one resolved commit for the whole run, however many networks
// it covers — and shared with the source-version read below, so the target state and the
// contract version a proposal is graded against always come from the same commit.
const pinnedAnchor = createPinnedAnchor()
const readPinnedTargetState = createPinnedTargetStateReader({
  anchor: pinnedAnchor,
})
const readPinnedBlob = createPinnedBlobReader({ anchor: pinnedAnchor })

// Networks the run tried to process. A network can be attempted and still
// contribute no outcome (not an owner, ownership read failed, nothing
// actionable), and a per-change N/N must never be read as fleet coverage when
// that happened.
const networksAttempted = new Set<string>()

// Global arrays to record execution failures and timeouts
const globalFailedExecutions: Array<{
  chain: string
  safeTxHash: string
  error: string
}> = []
const globalTimeoutExecutions: Array<{
  chain: string
  safeTxHash: string
  error: string
}> = []

// `reconcileCoverageKey` values for each Safe whose `submitted` rows were
// resolved by the startup reconcile sweep. Used to skip the redundant
// per-network reconcile inside prepareConfirmSafeTxNetwork — per Safe, not
// per network.
const startupReconciledKeys = new Set<string>()

// Quickfix to allow BigInt printing https://stackoverflow.com/a/70315718
;(BigInt.prototype as unknown as Record<string, unknown>).toJSON = function () {
  return this.toString()
}

/**
 * Main function to process Safe transactions for a given network
 * @param privKeyType - Type of private key (SAFE_SIGNER or DEPLOYER)
 * @param pendingTransactions - MongoDB collection
 * @param rpcUrl - Optional RPC URL override
 * @param prepared - Network context prepared (or prefetched) before the interactive loop
 */
const processTxs = async (
  privKeyType: PrivateKeyTypeEnum,
  pendingTransactions: Collection<ISafeTxDocument>,
  rpcUrl: string | undefined,
  prepared: IConfirmSafeTxNetworkContext
) => {
  // Read from argv rather than from the parsed args, for the reason
  // `cli-flags.ts` documents: citty hands `--raw=false` back as the string
  // 'false'. Absent means off, which is the shorter block.
  const showRawCalldata = readBooleanFlag(process.argv, {
    camel: 'raw',
    kebab: 'raw',
  })

  const {
    network,
    networkKey,
    safe,
    chain,
    safeAddress,
    txSafeAddress,
    configuredSafeAddress,
    signerAddress,
    txs: initialTxs,
    onChainNonce,
  } = prepared

  consola.info(' ')
  consola.info('-'.repeat(80))
  consola.info('Chain:', chain.name)
  consola.info('Signer:', signerAddress)
  // Once per network rather than on every proposal: it is the same Safe for the
  // whole run, and `INT-SAFE-ADDRESS` grades each row against it. Config-derived
  // — this is the Safe the client is pointed at, never the one a row claims.
  consola.info('Safe:  ', safeAddress)

  // How many transactions this run has put on the wire for this Safe. Read by
  // the prefetch anchor: a broadcast moves the state every prefetched read was
  // taken against, and it moves it whether or not the Safe's nonce read
  // reflects that yet.
  let broadcastsMade = 0

  // The proposal's codehash verdict, taken per proposal from that proposal's
  // evidence bundle and read by the signer through `createGatedSigner`. It
  // starts blocking so a proposal whose evaluation never ran cannot be signed
  // on last proposal's answer.
  let codehashGate: ICodehashSignGate = blockingUnevaluatedGate()

  // The proposal's integrity verdict, taken per proposal from that proposal's
  // evidence bundle. Absent is the blocking state: `assertIntegrityAssertsAllowSigning` refuses an undefined
  // run, so a proposal whose assertions never ran cannot be signed on the last
  // proposal's answer — and the run carries the transaction it graded, which
  // that refusal compares against the one reaching the signer.
  let integrityRun: IIntegrityAssertRun | undefined

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
    gate: () => codehashGate,
    // Which transaction this signature will cover, so the verdict is checked
    // against it rather than merely being non-blocking.
    keyOf: (safeTransaction) => proposalKeyOf(safeTransaction.data),
    sign: async (safeTransaction, client = safe) => {
      // After the codehash refusal `createGatedSigner` has already run, never
      // before it: placed first this would swallow that refusal, and the
      // codehash verdict is the more specific answer of the two. Still ahead of
      // every statement of this body, so nothing signs before it.
      assertIntegrityAssertsAllowSigning(
        integrityRun,
        proposalKeyOf(safeTransaction.data)
      )

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
   * Persists a signed Safe tx on the exact MongoDB row being processed.
   * Filters by `_id` (or pending + identity fields) — never by safeTxHash alone,
   * which can match multiple rows when a reverted proposal was re-proposed.
   */
  async function persistSignedSafeTx(
    txDoc: ISafeTxMongoDocument,
    signedTx: ISafeTransaction
  ): Promise<void> {
    const result = await pendingTransactions.updateOne(
      mongoSafeTxRowFilter(txDoc, networkKey, chain.id),
      {
        $set: {
          safeTx: serializeSafeTxForMongo(
            signedTx
          ) as unknown as ISafeTransaction,
        },
      }
    )
    if (result.matchedCount === 0)
      // The hash comes off the stored row and is never compared to anything on
      // this path. It prints after signing, so it cannot corrupt the decision —
      // but it can repaint a success line over a real failure to persist, which
      // hides that the signature was never stored.
      throw new Error(
        `MongoDB update matched 0 rows for safeTxHash ${printableField(
          txDoc.safeTxHash
        )}. ` +
          `A duplicate row with the same hash may exist under a different status (e.g. reverted).`
      )
    consola.success('Transaction signed and stored in MongoDB')

    // Every signing branch funnels through here, so this is the one site that
    // sees the whole sign event.
    await recordSignedSet(txDoc, signedTx)
  }

  /**
   * What one proposal's calldata declares, read once and kept.
   *
   * Split out of `recordSignedSet` because gate G has to be graded before the
   * signer is asked to sign. A row recorded after the signature can describe
   * what was signed; it can no longer refuse it. The persistence half still
   * runs after signing and reads this cache rather than the chain again.
   *
   * `undefined` means nothing was read — the calldata was not a schedule
   * batch, the chain is outside the gate's coverage, or the read threw. Every
   * one of those leaves the ledger without a graded row, which blocks. That is
   * the same outcome as before this was moved, deliberately: this change moves
   * when gate G is graded, not what it decides.
   */
  interface IObservedSet {
    operationId: Hex
    observed: Awaited<ReturnType<typeof observeCalldata>>
  }
  // Survives a prefetch discard, unlike every other verdict in the bundle.
  //
  // When the anchor moves, `computeProposalEvidence` re-runs and every gate is
  // recomputed — except this one, which returns its earlier entry. That is safe
  // only because of what a Safe execution does here: it executes
  // `scheduleBatch`, which enqueues a timelock operation and changes neither
  // the code nor the storage authorities at the addresses this reads. The
  // observation is therefore the same before and after, and re-reading it would
  // buy nothing.
  //
  // The assumption is stated because it is the one that would fail first: a
  // proposal that mutated the diamond directly rather than scheduling would
  // leave this entry describing pre-execution state, and gate G would grade the
  // next proposal against it. Re-reading on discard is the fix if that day comes.
  const observedSets = new Map<string, IObservedSet>()

  async function observeSetForProposal(
    safeTxHash: string,
    callData: Hex | undefined,
    // Defaults to the terminal; the prefetch passes a deferred console so a
    // line about the next proposal cannot print under this one.
    log: {
      info: (message: string) => void
      warn: (message: string) => void
    } = consola
  ): Promise<IObservedSet | undefined> {
    const cached = observedSets.get(safeTxHash)
    if (cached) return cached

    if (!callData || !isScheduleBatchCalldata(callData)) return undefined

    if (resolveGateCoverage(networkKey) === 'uncovered-tron') {
      log.info(
        "Sign-time set not read: reading code on this chain is outside the gate's coverage (EXSC-954)"
      )
      return undefined
    }

    try {
      const params = decodeScheduleBatch(callData)
      const operationId = computeOperationIdBatch(
        params.targets,
        params.values,
        params.payloads,
        params.predecessor,
        params.salt
      )
      // Without an `--rpcUrl` override this is not a public endpoint: the
      // chain object is built from the network's configured RPC env var,
      // which `getViemChainForNetworkName` throws without, so the record is
      // always the run's own view.
      const publicClient = buildReadOnlyClient(networkKey, rpcUrl)
      const observed = await observeCalldata(
        {
          operationId,
          targets: params.targets,
          payloads: params.payloads,
        },
        {
          ...viemGateReaders(publicClient),
          deployments: (await getDeployments(
            networkKey as SupportedChain,
            EnvironmentEnum.production
          )) as unknown as Record<string, unknown>,
          ...(() => {
            const pinned = readPinnedBlob(`deployments/${networkKey}.json`)
            return pinned.ok ? { pinnedDeployments: pinned.value } : {}
          })(),
          globalConfig: globalConfig as unknown as Record<string, unknown>,
        }
      )

      const observedSet: IObservedSet = { operationId, observed }
      observedSets.set(safeTxHash, observedSet)
      return observedSet
    } catch (error) {
      log.warn(
        `Could not read the sign-time set; gate G has nothing to grade and will block: ${redactUrls(
          error instanceof Error ? error.message : String(error)
        )}`
      )
      return undefined
    }
  }

  /**
   * Persists what this machine saw at every address in the signed calldata
   * (WP-6.1 / R3.1): the address→codehash set plus the declared storage
   * authorities.
   *
   * A G6 reconstruction trail. The grading half moved to
   * `observeSetForProposal`, which runs before the signer decides; what is left
   * here cannot refuse a signature, so every failure is a warning. Blocking
   * here would turn a write error into a signing outage.
   */
  async function recordSignedSet(
    txDoc: ISafeTxMongoDocument,
    signedTx: ISafeTransaction
  ): Promise<void> {
    const callData = signedTx.data.data as Hex | undefined
    const observedSet = await observeSetForProposal(txDoc.safeTxHash, callData)
    if (!observedSet) return

    try {
      const record = buildSignedSetRecord(
        {
          operationId: observedSet.operationId,
          network: networkKey,
          chainId: chain.id,
          safeTxHash: txDoc.safeTxHash,
          signer: signerAddress,
          derivedFromCommit: getGitCommit(),
          codehashes: toSignedCodehashEntries(observedSet.observed.targets),
          authorities: toSignedAuthorityEntries(
            observedSet.observed.authorities
          ),
        },
        new Date()
      )

      consola.info(formatSignedSetForDisplay(record).join('\n'))
      await persistSignedSetRecord(record)
    } catch (error) {
      consola.warn(
        'Could not record the sign-time set (the pre-broadcast gate re-derives without it and will alert on the gap):',
        error
      )
    }
  }

  /**
   * Executes a SafeTransaction and updates its status in MongoDB
   * @param safeTransaction - The transaction to execute
   * @param txDoc - The pendingTransactions row being processed
   * @param safeClient - The Safe client to use for execution (defaults to main safe client)
   */
  // Returns true only for the 'executed' status (receipt success, or the Tron
  // no-receipt path) — the only outcome that consumes the Safe nonce. A
  // top-level revert rolls back the nonce increment, so 'reverted' did NOT
  // consume the nonce (in this repo safeTxGas=0 is why an inner-call failure
  // surfaces as a top-level revert (GS013) rather than ExecutionFailure). Both
  // 'reverted' and the unknown 'submitted' outcome return false, and the caller
  // must not advance expectedNonce in either case.
  async function executeTransaction(
    safeTransaction: ISafeTransaction,
    txDoc: ISafeTxMongoDocument,
    safeClient: SafeClient = safe
  ): Promise<boolean> {
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

    consola.info('Preparing to execute Safe transaction...')
    let safeTxHash = ''
    try {
      // Get the Safe transaction hash for reference
      safeTxHash = await safeClient.getTransactionHash(safeTransaction)
      consola.info(`Safe Transaction Hash: \u001b[36m${safeTxHash}\u001b[0m`)

      // Execute the transaction on-chain (timeout/polling handled in safeClient)
      consola.info('Submitting execution transaction to blockchain...')
      // Counted before the call, not after it: a broadcast that throws may
      // still have reached the chain, and a prefetch taken against the state
      // before it must be discarded either way.
      broadcastsMade++
      const exec = await safeClient.executeTransaction(safeTransaction)
      const executionHash = exec.hash

      consola.success(`✅ Transaction submitted successfully`)

      // Resolve the DB status from on-chain reality. With safeTxGas=0 the Safe
      // reverts whenever the inner call reverts, so the executor's normalized
      // status is authoritative (EVM resolves it from the receipt, Tron
      // synchronously via getTransactionInfo). An undefined status means the
      // outcome is unknown (EVM receipt poll timed out) — leave the row
      // 'submitted' for reconciliation to resolve.
      let nextStatus: SafeTxStatus
      if (exec.status)
        nextStatus = exec.status === 'success' ? 'executed' : 'reverted'
      else nextStatus = 'submitted'

      await pendingTransactions.updateOne(
        mongoSafeTxRowFilter(txDoc, networkKey, chain.id),
        {
          $set: {
            status: nextStatus,
            executionHash,
            submittedAt: new Date(),
          },
        }
      )

      // Only enqueue a timelock op once the Safe tx is confirmed on-chain.
      // 'submitted' rows get enqueued by reconcile when it later promotes
      // them to 'executed'; on 'reverted' the inner schedule never
      // executed, so nothing to queue.
      if (nextStatus === 'executed')
        await enqueueTimelockOpIfApplicable(
          safeTransaction.data.data,
          safeTransaction.data.to,
          safeTxHash,
          executionHash,
          chain.id,
          chain.name
        )

      if (nextStatus === 'executed')
        consola.success(
          `✅ Safe transaction confirmed and recorded as executed`
        )
      else if (nextStatus === 'reverted') {
        consola.error(
          `❌ Safe transaction reverted on-chain — recorded as reverted`
        )
        consola.error(
          `   The Safe nonce was NOT consumed — the execTransaction reverted, rolling back the nonce increment, so this nonce can be re-proposed. Inspect the receipt for the revert reason.`
        )
        globalFailedExecutions.push({
          chain: chain.name,
          safeTxHash,
          error: 'on-chain revert',
        })
      } else {
        consola.warn(
          `⚠️  Safe transaction submitted but not yet confirmed — recorded as submitted`
        )
        consola.warn(
          `   Reconciliation will resolve the final status on the next run.`
        )
        globalTimeoutExecutions.push({
          chain: chain.name,
          safeTxHash,
          error: 'confirmation pending',
        })
      }

      consola.info(`   - Safe Tx Hash:   \u001b[36m${safeTxHash}\u001b[0m`)
      const displayHash = exec.displayHash ?? executionHash
      const explorerSuffix = exec.explorerUrl
        ? ` \u001b[36m(${exec.explorerUrl})\u001b[0m`
        : ''
      consola.info(
        `   - Execution Hash: \u001b[33m${displayHash}\u001b[0m${explorerSuffix}`
      )
      consola.log(' ')

      return safeTxStatusConsumedNonce(nextStatus)
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.error('❌ Error executing Safe transaction:')
      consola.error(`   ${errorMsg}`)
      if (errorMsg.includes('GS026')) {
        consola.error(
          '   This appears to be a signature validation error (GS026).'
        )
        consola.error(
          '   Possible causes: invalid signature format or incorrect signer.'
        )
      }
      if (errorMsg.includes('GS013')) {
        consola.error(
          '   GS013 means the inner call (e.g. Timelock.schedule) failed and Safe was executed with safeTxGas=0 (underlying tx reverted).'
        )
      }
      // Record error in global arrays
      if (errorMsg.toLowerCase().includes('timeout'))
        globalTimeoutExecutions.push({
          chain: chain.name,
          safeTxHash: safeTxHash,
          error: errorMsg,
        })
      else
        globalFailedExecutions.push({
          chain: chain.name,
          safeTxHash: safeTxHash,
          error: errorMsg,
        })

      throw new Error(`Transaction execution failed: ${errorMsg}`)
    }
  }

  // The per-network reads every proposal's simulation and quorum gate shares.
  // Hoisted out of the proposal loop so a prefetched proposal reads the same
  // endpoint list the inline path would have.
  const endpoints = chain.rpcUrls.default.http
  const primaryEndpoint = rpcUrl ?? endpoints[0]

  // Two different reasons not to simulate, graded differently below. Tron is
  // reached through its own executor rather than `eth_call`, so the EVM
  // simulator does not cover it at all — a declared limit, recorded as an
  // acknowledgement. A network it does cover but has no endpoint for is a
  // read that should have happened and did not, which stays unverified.
  const evmSimulatable = !isTronNetworkKey(network) && Boolean(primaryEndpoint)

  /**
   * One proposal's chain-read evidence: every verdict that costs a read, and
   * nothing that depends on what the signer does.
   *
   * The split is the carry-forward decision, stated once here rather than
   * per gate. A signature is stored against one proposal's row and changes no
   * chain state, so a bundle read before it remains true after it — which is
   * what makes prefetching the next proposal worth anything. A broadcast does
   * change chain state, and so invalidates every bundle read before it; the
   * anchor below carries the run's own broadcasts, so those bundles are
   * discarded rather than reused.
   *
   * Everything that reads the signature set or the signer's position in the
   * queue — the option list, `canExecute`, the nonce interlocks — is left out
   * and recomputed in the loop, where it is cheap and where it has to be
   * current.
   */
  interface IProposalEvidence {
    codehash: ICodehashSignGate
    integrity: IIntegrityAssertRun | undefined
    executability: IExecutabilityVerdict | undefined
    rpcQuorum: IRpcQuorumVerdict | undefined
    calldataAddresses: ICalldataAddressVerdict | undefined
    observedSet: IObservedSet | undefined
    references: IAddressReference[]
    undecodable: string[]
    /** What the reads said, held back until this proposal is on screen. */
    lines: readonly IDeferredLine[]
    /**
     * Milliseconds each read cost, in the order they ran.
     *
     * Carried so a wait has an address. "The reads took 18s" says the prefetch
     * is not covering them; it does not say whether to give the window more
     * time or to stop prefetching the one read that dominates it.
     */
    timings: ReadonlyArray<{ stage: string; ms: number }>
  }

  /**
   * The bundle a proposal gets when the reads could not be made at all.
   *
   * Every field is absent, which is what the registry reads as "this check
   * could not be made": `proposalCheckResults` turns each one into an
   * `unresolved` row that blocks, while a bundle that never arrived would
   * produce no row at all and roll up as a check the run was never asked for.
   *
   * `rpcQuorum` is the exception, and deliberately so. An unmade quorum read
   * records `needs-ack` rather than `error` — the gate reports on endpoint
   * redundancy and must not block a run on the fleet's missing spare endpoints
   * — so an unreadable bundle leaves one acknowledgeable row among ten
   * blocking ones. Distinguishing "the bundle was unreadable" from "no quorum
   * read was configured" here would let it block too; it is not worth a second
   * shape when the other ten already refuse.
   */
  const unreadableEvidence = (error: unknown): IProposalEvidence => {
    const why = `the proposal's chain reads could not be made — ${printableField(
      redactUrls(error instanceof Error ? error.message : String(error))
    )}`
    return {
      codehash: {
        ...blockingUnevaluatedGate(),
        evaluated: true,
        refusals: [why],
        summary: why,
      },
      integrity: undefined,
      executability: undefined,
      rpcQuorum: undefined,
      calldataAddresses: undefined,
      observedSet: undefined,
      references: [],
      undecodable: [],
      lines: [{ level: 'error', message: why }],
      timings: [],
    }
  }

  /**
   * Takes every chain read one proposal is graded on.
   *
   * Each gate keeps its own failure handling, so one unreachable endpoint
   * leaves that gate unverified rather than emptying the bundle. Nothing here
   * writes to the terminal: the lines are carried on the bundle and printed
   * when the proposal they belong to is displayed, because a warning about the
   * next proposal, printed under this one's verdicts, describes nothing the
   * signer is looking at.
   *
   * That holds for what this function says, not for what the shared helpers it
   * calls say — `getFallbackTransportForChain` and `SafeClient`'s own read
   * errors write to the console directly, and they have call sites that are not
   * this run.
   */
  async function computeProposalEvidence(
    tx: IAugmentedSafeTxDocument
  ): Promise<IProposalEvidence> {
    const log = createDeferredLogger()

    // Measured between the reads rather than around them. Wrapping each call
    // re-spells it, and six placement guards pin those spellings to keep the
    // gates where they can still refuse — instrumentation does not get to
    // rewrite them. Each read below catches its own failure, so control reaches
    // the next mark whether the read answered or threw.
    const timings: { stage: string; ms: number }[] = []
    let lastMark = Date.now()
    const mark = (stage: string): void => {
      const now = Date.now()
      timings.push({ stage, ms: now - lastMark })
      lastMark = now
    }

    let codehash: ICodehashSignGate = blockingUnevaluatedGate()
    let integrity: IIntegrityAssertRun | undefined
    let calldataAddresses: ICalldataAddressVerdict | undefined

    // The struct itself reaches the gate, which reads its calldata when it
    // judges; the verdict is then bound to that transaction, so it cannot
    // authorise the signature of another row or of a mutated one. Displayed
    // here and refused inside
    // `signTransaction`: removing the Sign option instead would hide why a
    // specific proposal is unsignable, which is the same reason the nonce gate
    // runs after the choice.
    try {
      codehash = await evaluateCodehashSignGate(
        gateInputFor(tx, networkKey),
        getCodehashDeps
      )
    } catch (error) {
      // Blocking, not skipped: "the gate could not run" and "the gate passed"
      // are the two things it exists to keep apart.
      const why = `the codehash gate could not be evaluated — ${
        error instanceof Error ? error.message : String(error)
      }`
      codehash = {
        ...blockingUnevaluatedGate(),
        evaluated: true,
        refusals: [why],
        summary: why,
      }
    }

    mark('codehash gate')

    try {
      integrity = await runIntegrityAsserts(
        {
          network,
          chainId: chain.id,
          clientSafeAddress: safeAddress,
          ...(configuredSafeAddress ? { configuredSafeAddress } : {}),
          documentSafeAddress: tx.safeAddress,
          documentSafeTxHash: tx.safeTxHash,
          // Cast, not read through the interface: the check that refuses a
          // field outside the signed struct exists precisely for keys the
          // interface does not declare, and reading it as the declared type
          // would hand the assertion a shape in which they cannot appear.
          storedTxData: (tx.safeTx.data ?? {}) as unknown as Record<
            string,
            unknown
          >,
          storedSignatures: Object.values(tx.safeTx.signatures ?? {}),
          // The signed struct throughout, never the stored row: the row is what
          // is displayed, and a check that keys on it verifies the description
          // rather than the transaction.
          // These five fields must reach the module exactly as
          // `proposalKeyOf(safeTransaction.data)` in the funnels reads them: the
          // graded key is derived from them and compared against that one, and
          // `proposalKeyOf` reads an absent payload as the empty string. A
          // default substituted here disagrees with it and refuses every
          // proposal carrying no calldata. An unusable payload is for the
          // assertions to refuse, not for this call site to repair.
          to: tx.safeTransaction.data.to,
          data: tx.safeTransaction.data.data,
          signedValue: String(tx.safeTransaction.data.value),
          signedOperation: tx.safeTransaction.data.operation ?? 0,
          signedNonce: Number(tx.safeTransaction.data.nonce),
        },
        createIntegrityAssertDeps({
          network,
          safe,
          safeTx: tx.safeTransaction,
        })
      )
    } catch (error) {
      // Left undefined, which is the blocking state. "The assertions could not
      // run" and "the assertions passed" are the two things they exist to keep
      // apart, so a thrown lookup must not read as the second.
      integrity = undefined
      log.error(
        `    Proposal integrity: the assertions could not be run — ${printableField(
          redactUrls(error instanceof Error ? error.message : String(error))
        )}`
      )
    }

    mark('integrity asserts')

    let executability: IExecutabilityVerdict | undefined
    if (evmSimulatable && primaryEndpoint)
      try {
        // Every endpoint the chain has, in priority order, rather than the
        // primary alone: one throttled provider must not be the reason a
        // proposal goes unverified. Only when all of them fail does the row
        // below record `error`, which blocks — the signer investigates rather
        // than signing on a simulation nobody made.
        //
        // The override is kept outside the chain transport's own construction,
        // which throws when every configured endpoint is unusable: built inline
        // that throw would discard a `--rpcUrl` that works, in exactly the case
        // an override exists for.
        const overrideEndpoints = rpcUrl ? [rpcUrl] : []

        // Resolved before the chain transport, so the fallback message below
        // can say what is actually left. Through the same transport config as
        // the simulators further down, for the same reason: a `--rpcUrl`
        // carrying credentials is queried unauthenticated when it is handed to
        // `http()` bare, and the 401 that comes back is recorded as chain state
        // that could not be read.
        const overrideTransports = overrideEndpoints.flatMap((endpointUrl) => {
          try {
            const { url, fetchOptions, retryCount, retryDelay } =
              getSignTimeTransportConfig(endpointUrl)
            return [
              http(url, {
                ...(fetchOptions ? { fetchOptions } : {}),
                retryCount,
                retryDelay,
              }),
            ]
          } catch (error) {
            log.warn(
              `    Executability: the supplied --rpcUrl cannot be used on ${network} — ${redactUrls(
                error instanceof Error ? error.message : String(error)
              )}`
            )
            return []
          }
        })

        let chainTransport: Transport | undefined
        try {
          chainTransport = getFallbackTransportForChain(chain)
        } catch (error) {
          if (overrideTransports.length === 0) throw error
          log.warn(
            `    Executability: no endpoint from the chain config is usable on ${network}; simulating through the supplied override alone — ${redactUrls(
              error instanceof Error ? error.message : String(error)
            )}`
          )
        }

        const transports = [
          ...overrideTransports,
          ...(chainTransport ? [chainTransport] : []),
        ]
        const [onlyTransport] = transports
        if (!onlyTransport)
          throw new Error(
            `No usable RPC endpoint for ${network} — nothing could simulate this proposal`
          )
        const client = createPublicClient({
          chain,
          transport:
            transports.length === 1 ? onlyTransport : fallback(transports),
        })

        // One client per endpoint for the simulation itself. A fallback
        // transport decides revert-versus-unreachable by the node's wording, so
        // the payload's own answer has to be read endpoint by endpoint instead.
        //
        // Built through the same transport config the rest of the run uses, not
        // from the bare URL: that is where an endpoint's auth headers and retry
        // policy come from, and a simulator missing them fails to authenticate
        // on every endpoint — which this gate would then read as a proposal
        // nobody could simulate rather than as its own misconfiguration.
        const simulators = [...overrideEndpoints, ...endpoints].flatMap(
          (endpointUrl) => {
            try {
              const { url, fetchOptions, retryCount, retryDelay } =
                getSignTimeTransportConfig(endpointUrl)
              return [
                createPublicClient({
                  chain,
                  transport: http(url, {
                    ...(fetchOptions ? { fetchOptions } : {}),
                    retryCount,
                    retryDelay,
                  }),
                }),
              ]
            } catch {
              // An endpoint this chain cannot use, which the remaining ones are
              // there to cover. Dropped rather than simulated against, so its
              // own unusability is never reported as the proposal's verdict.
              return []
            }
          }
        )
        executability = evaluateExecutability(
          await collectExecutabilityInput(
            {
              network,
              safeAddress,
              to: tx.safeTransaction.data.to as Address,
              data: (tx.safeTransaction.data.data ?? '0x') as Hex,
              nonce: {
                proposalNonce: Number(tx.safeTransaction.data.nonce),
                safeNonce: Number(onChainNonce),
                // The proposal itself is in this list, and a nonce it shares
                // with itself is not a collision with another proposal.
                pendingNonces: initialTxs
                  .filter((pending) => pending.safeTxHash !== tx.safeTxHash)
                  .map((pending) => Number(pending.safeTx.data.nonce)),
              },
            },
            createExecutabilityChainReader(client, simulators)
          )
        )
      } catch (error) {
        // Left undefined, which the ledger records as unverified and blocks on.
        // A thrown collection is not a simulation that found nothing wrong, and
        // every configured endpoint was already tried before reaching here.
        log.error(
          `    Executability: this proposal could not be simulated on ${network}, so it is UNVERIFIED — investigate before signing: ${redactUrls(
            error instanceof Error ? error.message : String(error)
          )}`
        )
      }

    mark('executability simulation')

    const quorumTarget = tx.safeTransaction.data.to as Address
    let rpcQuorum: IRpcQuorumVerdict | undefined
    if (evmSimulatable && endpoints.length > 0)
      try {
        rpcQuorum = evaluateRpcQuorum(
          await collectProviderObservations(
            endpoints,
            createCodeReader(
              quorumTarget,
              chain.id,
              ENDPOINT_READ_BUDGET_MS,
              createPinnedBlock(endpoints, chain.id)
            )
          )
        )
      } catch (error) {
        log.warn(
          `    RPC quorum: the read could not be made — ${redactUrls(
            error instanceof Error ? error.message : String(error)
          )}`
        )
      }

    mark('rpc quorum')

    // Report-only and never gated on: the record is written by the deploying
    // machine, so this catches the typo and the address nobody deployed, not a
    // proposer who controls that machine. It carries no ledger row because the
    // only anchor it could rest on reports rather than decides — see
    // `check-ledger.ts`'s reporting-only anchors.
    // Hoisted out of the try below because gate G reads it too: it is a pure
    // decode of the proposal's own calldata, and only the record lookup under
    // it can fail.
    const { references, undecodable } = collectAddressReferences(
      tx.safeTransaction.data.data ? [tx.safeTransaction.data.data as Hex] : []
    )

    try {
      const records = await readDeploymentRecords()
      calldataAddresses = evaluateCalldataAddresses(
        {
          network,
          references,
          ...(undecodable.length > 0 ? { undecodable } : {}),
        },
        buildDeploymentIndex(
          records,
          references.map((reference) => reference.address),
          referencedNames(references)
        )
      )
    } catch (error) {
      log.warn(
        `    Calldata addresses: the check could not be run — ${redactUrls(
          error instanceof Error ? error.message : String(error)
        )}`
      )
    }

    mark('calldata addresses')

    // Read before the signer is asked to decide. The same call inside
    // `recordSignedSet` runs after the signature, where a refusal is no
    // longer available; the cache makes the second call free.
    const observedSet = await observeSetForProposal(
      tx.safeTxHash,
      tx.safeTransaction.data.data as Hex | undefined,
      log
    )

    mark('sign-time set')

    return {
      codehash,
      integrity,
      executability,
      rpcQuorum,
      calldataAddresses,
      observedSet,
      references,
      undecodable,
      lines: log.lines,
      timings,
    }
  }

  /**
   * What a prefetched bundle must still be true against when it is used.
   *
   * The Safe's own nonce, plus a counter this run bumps before every broadcast
   * it makes. The nonce catches another signer executing on this Safe while
   * the operator read; the counter catches this run's own execution, which
   * moves chain state whatever the nonce read then says. An unreadable nonce
   * resolves to nothing, which never matches — the bundle is recomputed
   * instead of being served against state nobody could confirm.
   */
  const resolveEvidenceAnchor = async (): Promise<string | undefined> => {
    try {
      return `${broadcastsMade}:${await safe.getNonce()}`
    } catch {
      return undefined
    }
  }

  const evidencePrefetch = new ProposalEvidencePrefetchQueue<
    IAugmentedSafeTxDocument,
    IProposalEvidence
  >((error) => unreadableEvidence(error))

  const seconds = (ms: number): string => (ms / 1000).toFixed(1)

  // Above this, a proposal's reads cost enough that where the time went is
  // worth a line. Below it the breakdown prints under every proposal and says
  // nothing a signer can act on.
  const SLOW_EVIDENCE_MS = 2000

  /**
   * Says where a proposal's evidence came from, how old it is, and what waiting
   * for it cost here.
   *
   * A verdict read minutes ago and shown as current is the thing this whole
   * gate set exists to prevent, so a served prefetch names its age even though
   * it was re-validated, and a discarded one names why it was thrown away.
   *
   * Every path carries its wait, the inline one included, which used to print
   * nothing. Whether preparing one proposal ahead earns its correctness surface
   * is a question about wall time, and it cannot be answered from a transcript
   * that records the wait only where the answer was already good: a served
   * bundle that still cost nine seconds and an inline read that cost eighteen
   * are both verdicts on the prefetch, and the silent path hid the second.
   */
  const describeEvidenceProvenance = (
    taken: IPrefetchedEvidence<IProposalEvidence>
  ): string[] => {
    if (taken.prefetched)
      return [
        `Chain reads for this proposal were taken ${seconds(
          taken.ageMs
        )}s ago, while you were reading, and you waited ${seconds(
          taken.waitedMs
        )}s for them here. Re-validated just now: the Safe's nonce is unchanged and this run has broadcast nothing since.`,
      ]
    if (taken.discarded)
      return [
        `Chain reads for this proposal were re-taken just now, costing ${seconds(
          taken.waitedMs
        )}s: ${taken.discarded}.`,
      ]
    return [
      `Chain reads for this proposal took ${seconds(
        taken.waitedMs
      )}s, with nothing prepared ahead of it.`,
    ]
  }

  /**
   * Which reads a wait was actually spent in, worst first.
   *
   * Printed only when there was a wait worth explaining. A breakdown under
   * every proposal is noise a signer learns to skip, and what the reads cost is
   * only interesting on the runs where the cost was paid — so this appears
   * exactly when there is something to diagnose. Without it a slow run says
   * only that it was slow, which does not distinguish "give the window more
   * time" from "stop prefetching the one read that dominates it".
   */
  const describeEvidenceCost = (
    taken: IPrefetchedEvidence<IProposalEvidence>
  ): string[] => {
    if (taken.waitedMs < SLOW_EVIDENCE_MS) return []

    const slowest = [...taken.value.timings]
      .filter((entry) => entry.ms >= 100)
      .sort((a, b) => b.ms - a.ms)
      .map((entry) => `${entry.stage} ${seconds(entry.ms)}s`)

    return slowest.length > 0 ? [`  Spent in: ${slowest.join(' · ')}`] : []
  }

  // Every proposal's ledger rows, accumulated rather than recorded as they are
  // graded. A ledger row is denominated per network while proposals are graded
  // one by one, and `rollUpChecks` reads two records for one (check, network)
  // pair as a retry — so recording per proposal lets the last proposal's verdict
  // stand for the whole network, and a clean one erase an earlier refusal.
  const proposalChecks: ICheckResult[] = []

  // A run walks several proposals and each one ends on a checklist, so the
  // separator is what keeps the next proposal's fields from reading as more of
  // the previous one's instructions.
  let proposalIndex = 0

  // Sort transactions by nonce in ascending order to process them in sequence.
  // In place, so the loop below and `nextProposal` cannot disagree about which
  // proposal follows which.
  const orderedTxs = initialTxs.sort((a, b) => {
    if (a.safeTx.data.nonce < b.safeTx.data.nonce) return -1
    if (a.safeTx.data.nonce > b.safeTx.data.nonce) return 1
    return 0
  })

  // Which proposal the signer reaches next, so its reads can be started while
  // this one is being read. Keyed on the document rather than on its hash:
  // position in the queue is a fact about this array, and two rows carrying
  // one hash must not be able to decide it.
  const nextProposal = new Map<
    IAugmentedSafeTxDocument,
    IAugmentedSafeTxDocument
  >()
  orderedTxs.forEach((proposal, index) => {
    const next = orderedTxs[index + 1]
    if (next) nextProposal.set(proposal, next)
  })

  // Once per network, not per proposal: the second proposal's gate J row points
  // at this paragraph instead of repeating it.
  let shownRpcQuorum: ICheckResult | undefined

  // Track expected nonce so sequential executions within a single run work correctly
  let expectedNonce = onChainNonce
  for (const tx of initialTxs) {
    // Recompute nonce status dynamically — expectedNonce advances after each successful execution
    const txNonce = BigInt(tx.safeTx.data.nonce)
    // 'stale': nonce already used on-chain (proposal was created with a wrong/old nonce, e.g. due to stale RPC)
    // 'future': nonce not yet reachable (a lower-nonce proposal must execute first)
    const nonceStatus: SafeNonceStatus =
      txNonce === expectedNonce
        ? 'current'
        : txNonce < expectedNonce
        ? 'stale'
        : 'future'

    codehashGate = blockingUnevaluatedGate()
    integrityRun = undefined
    if (proposalIndex++ > 0) consola.log(PROPOSAL_SEPARATOR.join('\n'))

    // This proposal's own reads, started before its first zone is drawn. The
    // slot already holds it from the previous iteration in every case but the
    // first, where scheduling here is what puts the rebuild and the chain reads
    // alongside the interval the signer spends reading what they are signing —
    // rather than in front of it, which is where the whole minute a cold
    // codehash rebuild costs used to land.
    evidencePrefetch.schedule(
      tx,
      () => computeProposalEvidence(tx),
      resolveEvidenceAnchor
    )

    // The block sanitises the stored addresses itself, so it can report a row
    // that needed it. These only decide how a clean address is displayed.
    const formatAddress = (address: string): string =>
      `${formatAddressForNetworkCliDisplay(
        network,
        address as Address
      )}${tronHexSuffix(network, address as Address)}`
    const explorerUrlFor = (address: string): string =>
      buildExplorerAddressUrl(network.toLowerCase(), address as Address) ?? ''

    // Looked up on the sanitised address: the record keys are repository
    // configuration, so a match names a contract this repo deployed. The block
    // decides whether to show the name — it refuses for an address it had to
    // repair, since sanitising a corrupt one can yield a valid one.
    const targetName = await getTargetName(
      sanitizeProvenanceText(tx.safeTx.data.to) as Address,
      network
    )

    // Only show nonce warning if the tx can be executed — irrelevant while still collecting signatures
    // `trustedMarkup`: both readings are a chain-read `bigint`, and the strings
    // carry colour codes of their own that sanitising would strip.
    const nonceWarning = trustedMarkup(
      nonceStatus === 'stale'
        ? ` [31m✗ STALE — on-chain nonce is ${expectedNonce}, this proposal's nonce was already used[0m`
        : nonceStatus === 'future' && tx.canExecute
        ? ` [33m⚠ on-chain nonce is ${expectedNonce} — cannot execute yet[0m`
        : ''
    )

    // The struct the signature covers, never the stored row: createTransaction
    // normalises an absent operation to Call, so those two copies can disagree.
    const operationVerdict = evaluateDelegateCallGate(tx.safeTransaction.data)

    // The verb follows the row, not the menu: a row already carrying the
    // threshold is executed without this signer being asked for a signature at
    // all, so asking them to check it "before signing" names the wrong act.
    //
    // The nonce is sanitised before it reaches the heading, which pads itself
    // from the string's length: an escape sequence in a stored nonce would be
    // measured as width and silently shift the rule it sits between.
    const { text: headingNonce } = asPrintable(tx.safeTx.data.nonce)
    consola.log(
      zoneHeading(
        1,
        `WHAT YOU ARE BEING ASKED TO ${tx.canExecute ? 'EXECUTE' : 'SIGN'}`,
        `${network} · nonce ${headingNonce} · ${signatureTally(
          tx.safeTransaction.signatures.size,
          tx.threshold
        )}`
      ).join('\n')
    )

    const detailInput: ISafeTxDetailInput = {
      network,
      heading: '',
      nonceWarning,
      to: tx.safeTx.data.to,
      toTargetName: targetName,
      formatAddress,
      explorerUrlFor,
      value: tx.safeTx.data.value,
      // `trustedMarkup`: two literals, and a value `describeOperationValue`
      // has already sanitised and bounded.
      operationLabel: trustedMarkup(
        tx.safeTransaction.data.operation === 0
          ? 'Call'
          : tx.safeTransaction.data.operation === 1
          ? 'DelegateCall'
          : `not Call (${describeOperationValue(
              tx.safeTransaction.data.operation
            )})`
      ),
      operationIsCall: tx.safeTransaction.data.operation === 0,
      data: tx.safeTx.data.data,
      showRawCalldata,
      parkedTaskRefs: tx.parkedTaskRefs,
      provenance: tx.provenance,
    }

    consola.log(buildSafeTxDetailLines(detailInput).join('\n'))
    consola.log(buildCalldataTarget(detailInput).join('\n'))

    if (tx.safeTx.data?.data)
      consola.log(
        (
          await buildCalldataEffectLines(tx.safeTx.data.data, {
            network,
            // The body of THE CALLDATA DOES, drawn at that block's own column.
            indent: '      ',
            target: tx.safeTx.data.to,
          })
        ).join('\n')
      )

    consola.log(CLAIM_QUESTION.join('\n'))

    let targetState: ITargetStateVerdict
    try {
      targetState = evaluateTargetStateIntent(
        tx.safeTx.data?.data ? [tx.safeTx.data.data as Hex] : [],
        network,
        createTargetStateDeps(network, {
          readPinnedState: readPinnedTargetState,
          anchor: pinnedAnchor,
        })
      )
    } catch (error) {
      targetState = blockedByEvaluationError(
        error instanceof Error ? error.message : String(error)
      )
    }

    // A display error must never block signing.
    const verificationDisplay = resolveSignerVerificationDisplay(
      resolveSafeSigningMode(process.env),
      isTronNetworkKey(network),
      tx.safeTx.data.data
    )

    // The hash the device will be asked to sign, computed by the Safe contract
    // from the normalised struct. Never the stored `safeTxHash`: the proposer
    // writes that field, so previewing it would show the operator a picture of
    // what the proposer CLAIMS the device will display.
    let deviceHash: Hex | undefined
    if (verificationDisplay === 'hash-compare')
      try {
        deviceHash = await safe.getTransactionHash(tx.safeTransaction)
      } catch (error) {
        consola.warn(
          `Could not compute the Safe transaction hash on ${network} — the Ledger screens cannot be previewed: ${printableField(
            redactUrls(error instanceof Error ? error.message : String(error))
          )}`
        )
      }

    let devicePanel: string[] = []
    let devicePanelNote: string | undefined
    if (verificationDisplay === 'filmstrip')
      try {
        devicePanel = renderLedgerFlexFlow({
          chainId: chain.id,
          verifyingContract: safeAddress,
          to: tx.safeTransaction.data.to,
          value: String(tx.safeTransaction.data.value),
          data: tx.safeTx.data.data,
        })
        devicePanelNote = LEDGER_FLEX_WRAP_NOTE
      } catch (error) {
        consola.debug(`Ledger Flex filmstrip skipped: ${error}`)
      }
    else if (verificationDisplay === 'hash-compare' && deviceHash)
      try {
        devicePanel = renderLedgerFlexHashFlow({ hash: deviceHash })
        devicePanelNote = LEDGER_FLEX_HASH_NOTE
      } catch (error) {
        consola.warn(`Ledger Flex hash screens could not be drawn: ${error}`)
      }

    // Report-only, and it names only the computed value: the stored hash is
    // proposer-written text and is not echoed a second time here.
    const storedHash = tx.safeTxHash
    const storedIsHash =
      typeof storedHash === 'string' && /^0x[0-9a-f]{64}$/i.test(storedHash)

    // Every chain read this proposal is graded on, in one step. Served from the
    // prefetch started while the signer was reading only while the anchor still
    // agrees, and re-taken here otherwise — so what is displayed below is
    // evidence about the state this proposal would be signed against, never
    // about a state it has left.
    const evidence = await evidencePrefetch.take(
      tx,
      () => computeProposalEvidence(tx),
      resolveEvidenceAnchor
    )

    // The next proposal's reads start before this one is displayed: the
    // interval in which a human reads is the only one in which the machine has
    // nothing else to do. One proposal ahead and no further — the win is that
    // interval, and depth past it only widens the window a read can go stale
    // in.
    const nextTx = nextProposal.get(tx)
    if (nextTx)
      evidencePrefetch.schedule(
        nextTx,
        () => computeProposalEvidence(nextTx),
        resolveEvidenceAnchor
      )

    // The reads' own lines first, in the order they were produced, then where
    // the reads came from — both above the verdicts they explain.
    for (const line of evidence.value.lines)
      if (line.level === 'error') consola.error(line.message)
      else if (line.level === 'warn') consola.warn(line.message)
      else consola.info(line.message)
    for (const line of foldLines(describeEvidenceProvenance(evidence)))
      consola.info(line)
    for (const line of describeEvidenceCost(evidence)) consola.info(line)

    codehashGate = evidence.value.codehash
    integrityRun = evidence.value.integrity
    const {
      executability,
      rpcQuorum,
      calldataAddresses,
      references,
      undecodable,
      observedSet,
    } = evidence.value

    // Rendered here and printed in zone 2: the gate's own block carries
    // per-address detail no single ledger row holds — the reason, and the
    // immutable bytes a verdict does not cover.
    const codehashLines = renderCodehashSignGate(codehashGate)
    // Carries no ledger row, so it has no grouped row to print under.
    const calldataAddressLines = calldataAddresses
      ? renderCalldataAddresses(calldataAddresses)
      : []

    // R2.6's subjects: the contracts this proposal puts into service, out of
    // every address the observation read.
    const installedAuthorities = authoritiesOfInstalled(
      observedSet?.observed.authorities ?? [],
      references
    )

    const proposalResults = proposalCheckResults({
      network,
      storageAuthority: observedSet
        ? {
            entries: toSignedAuthorityEntries(installedAuthorities),
            anchors: authorityExpectationAnchors(installedAuthorities),
            ...(undecodable.length > 0 ? { scopeUnreadable: undecodable } : {}),
          }
        : undefined,
      integrity: integrityRun,
      // The gate object this proposal was judged on, not a re-derivation of
      // it: the row must report the same verdict the refusal below acts on.
      codehash: codehashGate,
      targetState,
      executability,
      // Only a chain the simulator was never written for is out of scope. An
      // EVM network it does cover but could not reach is a read that should
      // have happened and did not, so it is left to record as unverified.
      ...(isTronNetworkKey(network)
        ? {
            executabilityOutOfScope: `${network} is executed through its own chain executor, which the EVM simulator does not cover`,
          }
        : {}),
      rpcQuorum,
    })
    proposalChecks.push(
      ...proposalResults.map((row) => ({ ...row, proposalNonce: headingNonce }))
    )

    // Every check the run graded, as one report. The gates each print well on
    // their own, and five of them in a row is how the signer learned to scroll
    // past all five.
    const signerCheckRows = signerChecks({
      results: proposalResults,
      notApplicable: integrityResults(integrityRun).notApplicable,
      // The simulation answers once per payload and a ledger row holds one
      // verdict, so the breakdown goes in as a note: the row keeps the single
      // answer the ledger and the refusal messages are written against, and the
      // signer still sees which call it was that would revert.
      ...(executability
        ? {
            notes: new Map([
              [EXECUTABILITY_CHECK_ID, executabilityNotes(executability)],
            ]),
          }
        : {}),
      rpcQuorumShown: shownRpcQuorum,
      definitions: viewDefinitions(ALL_GATE_DEFINITIONS),
    })

    consola.log(
      zoneHeading(
        2,
        'WHAT WAS CHECKED FOR YOU',
        checkSummary(signerCheckRows)
      ).join('\n')
    )
    // The roster first, then the rows that ask something of the signer. The
    // sections say what to read; only the manifest says what there was to read,
    // which is what makes a gate that reported nothing visible at all.
    consola.log(
      renderGateManifest({
        entries: signerCheckRows,
        roster: ALL_GATE_DEFINITIONS,
        mustReport: new Set(
          CONFIRM_CHECK_DEFINITIONS.map((definition) => definition.checkId)
        ),
        docUrls: CHECK_DOCS,
        reportOnly: [CALLDATA_ADDRESS_MANIFEST_ENTRY],
      }).join('\n')
    )
    consola.log(renderCheckGroups(signerCheckRows).join('\n'))
    shownRpcQuorum ??= proposalResults.find(
      (row) => row.checkId === RPC_QUORUM_CHECK_ID
    )
    // Per-finding detail under the row that reduced them: the ledger holds one
    // verdict per proposal, and a cut installing several facets has one line
    // per element to show.
    renderGateDetail([
      formatTargetStateLines(targetState),
      codehashLines,
    ]).forEach((line) => consola.log(line))
    // Carries no ledger row, so it has no grouped row to print under.
    foldLines(calldataAddressLines).forEach((line) => consola.log(line))

    // The slot, not the checklist. What goes in it is printed further down, once
    // an action has been chosen and every interlock that could still abort the
    // run has had its turn.
    consola.log(
      zoneHeading(3, 'WHAT ONLY YOU CAN DO', TODOS_DEFERRED_SUMMARY).join('\n')
    )
    consola.log(renderDeferredTodos().join('\n'))

    const integrity = evaluateProposalIntegrity({ nonceStatus })
    // Said before the action prompt, not after it: a verdict the operator can no
    // longer act on is a log line, not a warning.
    if (!integrity.ok)
      consola.warn(
        `Nonce check failed on this proposal (${integrity.failures.join(
          ', '
        )}).`
      )

    // Read from the normalised transaction, not the stored document: this is the
    // struct that gets hashed and signed, so the key describes what the operator
    // is about to approve.
    const signedData = tx.safeTransaction.data
    const fingerprint = computeChangeFingerprint(
      signedData.data as Hex | undefined
    )
    const proposalKey = buildProposalKey({
      to: signedData.to,
      chainId: chain.id,
      nonce: signedData.nonce,
    })
    const acknowledgementKey = buildAcknowledgementKey({
      to: signedData.to,
      value: signedData.value,
      operation: signedData.operation ?? 0,
      fingerprint,
    })

    /**
     * Records where this proposal stands, superseding any earlier record of it.
     *
     * Every path out of this iteration calls it, including the ones that
     * `continue` past the prompts: the summary counts the queue, so a proposal
     * the run refused has to be in it, and has to say it was refused.
     *
     * @param update - What this call observed; everything else is the state the proposal was fetched in.
     */
    const recordProposalOutcome = (
      update: Partial<INetworkOutcome> = {}
    ): void => {
      networkOutcomes.push({
        network,
        proposalKey,
        acknowledgementKey,
        fingerprint,
        signatures: tx.safeTransaction.signatures.size,
        threshold: tx.threshold,
        nonceCurrent: integrity.ok,
        alreadySigned: tx.hasSignedAlready,
        signedThisRun: false,
        executedThisRun: false,
        // A refused operation leaves `Do Nothing` as the only option, so the
        // proposal is blocked from here on whatever the operator picks.
        blocked: operationVerdict.refuses,
        ...update,
      })
    }

    // Recorded before the prompts so a proposal skipped, aborted or refused is
    // still in the queue the summary reports; a later call supersedes this one.
    recordProposalOutcome()

    // Restated here rather than left to the rows above: by the time the prompt
    // appears the signer has scrolled past every gate, the calldata and the
    // device panel, and this is the screen the decision is made on.
    consola.log(renderProposalOutcome(signerCheckRows).join('\n'))

    // Determine available actions based on signature status
    // Execute options are offered regardless of nonce status; the nonce gate runs
    // after the choice so the operator sees why a specific proposal is refused
    let action: string
    if (privKeyType === PrivateKeyTypeEnum.SAFE_SIGNER) {
      const options = ['Do Nothing']
      if (!operationVerdict.refuses) {
        if (!tx.hasSignedAlready) {
          options.push('Sign')

          // Check if signing with current user + deployer (if needed) would meet threshold
          if (
            shouldShowSignAndExecuteWithDeployer(
              tx.safeTransaction,
              tx.threshold,
              signerAddress
            )
          )
            options.push('Sign and Execute With Deployer')
        }

        if (tx.canExecute) {
          options.push('Execute')
          options.push('Execute with Deployer')
        }
      }

      action = await consola.prompt('Select action:', {
        type: 'select',
        options,
      })
    } else {
      const options = ['Do Nothing']
      if (!operationVerdict.refuses) {
        if (!tx.hasSignedAlready) {
          options.push('Sign')
          if (wouldMeetThreshold(tx.safeTransaction, tx.threshold))
            options.push('Sign & Execute')

          // Check if signing with current user + deployer (if needed) would meet threshold
          if (
            shouldShowSignAndExecuteWithDeployer(
              tx.safeTransaction,
              tx.threshold,
              signerAddress
            )
          )
            options.push('Sign and Execute With Deployer')
        }

        if (hasEnoughSignatures(tx.safeTransaction, tx.threshold)) {
          options.push('Execute')
          options.push('Execute with Deployer')
        }
      }

      action = await consola.prompt('Select action:', {
        type: 'select',
        options,
      })
    }

    if (action === 'Do Nothing') continue

    const isExecuteAction = [
      'Execute',
      'Execute with Deployer',
      'Sign & Execute',
      'Sign and Execute With Deployer',
    ].includes(action)

    // Both nonce mismatches are guaranteed on-chain reverts, so broadcasting is
    // refused by default (the future case is overridable — see safe-utils). Only
    // execute actions are gated: a future-nonce proposal must still be signable
    // so signatures accumulate while the blocking proposal is pending.
    const nonceDecision = isExecuteAction
      ? canExecuteWithNonceStatus(nonceStatus, {
          allowFutureNonce: isFutureNonceExecutionAllowed(),
        })
      : undefined

    if (nonceDecision?.reason === 'stale-nonce') {
      consola.error('')
      consola.error('='.repeat(80))
      consola.error('✗  STALE PROPOSAL — THIS TRANSACTION WILL REVERT')
      consola.error('='.repeat(80))
      consola.error(
        `  This proposal has nonce \u001b[31m${txNonce}\u001b[0m but the Safe's on-chain nonce is already \u001b[31m${expectedNonce}\u001b[0m.`
      )
      consola.error(
        `  Nonce ${txNonce} was already used — this proposal is stale and cannot be executed.`
      )
      consola.error(
        `  Likely cause: the RPC returned a stale nonce when the proposal was created.`
      )
      consola.error(
        `  Fix: delete this proposal and re-run propose-to-safe — it will assign the next valid nonce automatically.`
      )
      consola.error('='.repeat(80))
      consola.error('')
      consola.info('Execution aborted — proposal is stale')
      recordProposalOutcome({ blocked: true })
      continue
    }

    if (nonceDecision && nonceDecision.reason !== 'nonce-current') {
      if (!nonceDecision.canExecute) {
        // Check if there is actually a pending proposal for the blocking nonce in the DB
        const blockingPendingTx = await pendingTransactions.findOne({
          safeAddress: txSafeAddress,
          network: network.toLowerCase(),
          chainId: chain.id,
          status: 'pending',
          'safeTx.data.nonce': Number(expectedNonce),
        })

        consola.warn('')
        consola.warn('='.repeat(80))
        consola.warn('⚠  GS026 — THIS TRANSACTION WILL REVERT')
        consola.warn('='.repeat(80))
        consola.warn(
          `  This transaction has nonce \u001b[33m${txNonce}\u001b[0m but the Safe's current on-chain nonce is \u001b[33m${expectedNonce}\u001b[0m.`
        )
        consola.warn(
          `  The Safe requires nonce ${expectedNonce} to be executed first — executing this will revert with GS026.`
        )
        if (blockingPendingTx) {
          consola.warn(
            `  A pending proposal for nonce ${expectedNonce} exists in the database — execute that one first.`
          )
        } else {
          consola.warn(
            `  There is no pending proposal for nonce ${expectedNonce} in the database.`
          )
          consola.warn(
            `  You need to re-create a proposal with nonce \u001b[33m${expectedNonce}\u001b[0m and execute it first.`
          )
        }
        consola.warn('='.repeat(80))
        consola.warn('')

        consola.error(
          '  Execution refused — broadcasting would spend gas on a guaranteed revert.'
        )
        consola.info(
          '  Signing is still available: re-run and choose "Sign" to add your signature now.'
        )
        consola.info(
          '  If the blocking proposal was just executed elsewhere, re-run this script to refresh the on-chain nonce.'
        )
        consola.info(
          '  If the configured RPC is known to report an out-of-date on-chain nonce, re-run with ALLOW_FUTURE_NONCE_EXECUTION=true.'
        )
        consola.info('Execution aborted — proposal nonce is not reachable yet')
        recordProposalOutcome({ blocked: true })
        continue
      }

      consola.warn('')
      consola.warn('='.repeat(80))
      consola.warn('⚠  NONCE GAP — EXECUTING BY OPERATOR OVERRIDE')
      consola.warn('='.repeat(80))
      consola.warn(
        `  This transaction has nonce \u001b[33m${txNonce}\u001b[0m but the configured RPC reports on-chain nonce \u001b[33m${expectedNonce}\u001b[0m.`
      )
      consola.warn(
        '  ALLOW_FUTURE_NONCE_EXECUTION=true — proceeding on the assumption that the RPC nonce is out of date.'
      )
      consola.warn(
        '  If the RPC nonce is accurate, this execution will revert with GS026.'
      )
      consola.warn('='.repeat(80))
      consola.warn('')
    }

    // Placed after the nonce gates, which are older and refuse only execute
    // actions, and before the acknowledgement is recorded: a proposal that fails
    // this check must not be acknowledgeable, and no signature or broadcast has
    // happened yet at this point. Skipping to the next proposal keeps the rest of
    // the run intact.
    if (!targetState.cleared) {
      for (const line of renderTargetStateRefusal(targetState))
        consola.error(line)
      recordProposalOutcome({ blocked: true })
      continue
    }

    recordAcknowledgement(acknowledgementLedger, {
      acknowledgementKey,
      proposalKey,
      integrityOk: integrity.ok,
    })

    // What the run did to this proposal, as observed rather than as chosen: a
    // sign path that throws is caught below, and the summary must not report a
    // signature that never reached the store.
    let signedThisRun = false
    let executedThisRun = false
    let signatures = tx.safeTransaction.signatures.size

    // Zone 3, held back from the decision screen and printed here instead: after
    // the nonce and expected-state interlocks, which can still end the run, and
    // immediately before the device is touched. A signer comparing a hash
    // against a Ledger wants it at the foot of the scrollback, not above thirty
    // rows of gate output they have scrolled past since.
    if (opensDeviceScreens(action)) {
      consola.log(zoneHeading(3, 'WHAT ONLY YOU CAN DO').join('\n'))
      consola.log(
        renderTodos(
          signerTodos({
            ...(deviceHash ? { deviceHash } : {}),
            ...(deviceHash
              ? {
                  storedHash: !storedIsHash
                    ? ('unreadable' as const)
                    : storedHash.toLowerCase() !== deviceHash.toLowerCase()
                    ? ('disagrees' as const)
                    : ('agrees' as const),
                }
              : {}),
            devicePanel,
            ...(devicePanelNote ? { devicePanelNote } : {}),
          })
        ).join('\n')
      )
    }

    if (action === 'Sign')
      try {
        const safeTransaction = tx.safeTransaction
        const signedTx = await signTransaction(safeTransaction)
        await persistSignedSafeTx(tx, signedTx)
        signedThisRun = true
        signatures = signedTx.signatures.size
      } catch (error) {
        consola.error('Error signing transaction:', error)
      }

    if (action === 'Sign & Execute')
      try {
        const safeTransaction = tx.safeTransaction
        const signedTx = await signTransaction(safeTransaction)
        await persistSignedSafeTx(tx, signedTx)
        signedThisRun = true
        signatures = signedTx.signatures.size
        if (await executeTransaction(signedTx, tx)) {
          executedThisRun = true
          expectedNonce++
        }
      } catch (error) {
        consola.error('Error signing and executing transaction:', error)
      }

    if (action === 'Sign and Execute With Deployer')
      try {
        // Step 1: Sign with current user
        const safeTransaction = tx.safeTransaction
        const signedTx = await signTransaction(safeTransaction)

        // Step 2: Update MongoDB with current user's signature
        await persistSignedSafeTx(tx, signedTx)
        signedThisRun = true
        signatures = signedTx.signatures.size

        // Step 3: Initialize deployer Safe client
        consola.info('Initializing deployer wallet...')
        const deployerPrivateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION')
        const { safe: deployerSafe } = await getOrInitializeSafeClient(
          network,
          deployerPrivateKey,
          rpcUrl,
          false, // Not using ledger for deployer
          undefined,
          txSafeAddress
        )

        // Step 4: Check if deployer needs to sign
        const needsDeployerSignature = !isSignedByProductionWallet(signedTx)
        let finalTx = signedTx

        if (needsDeployerSignature) {
          consola.info('Deployer signature needed - signing with deployer...')
          // Sign with deployer
          const deployerSignedTx = await signTransaction(signedTx, deployerSafe)

          // Update MongoDB with deployer's signature
          await persistSignedSafeTx(tx, deployerSignedTx)
          finalTx = deployerSignedTx
          signatures = deployerSignedTx.signatures.size
        } else
          consola.info(
            'Deployer has already signed - proceeding to execution...'
          )

        // Step 5: Execute with deployer using shared executeTransaction function
        consola.info('Executing transaction with deployer wallet...')
        if (await executeTransaction(finalTx, tx, deployerSafe)) {
          executedThisRun = true
          expectedNonce++
        }
      } catch (error) {
        consola.error(
          'Error signing and executing transaction with deployer:',
          error
        )
      }

    if (action === 'Execute')
      try {
        if (await executeTransaction(tx.safeTransaction, tx)) {
          executedThisRun = true
          expectedNonce++
        }
      } catch (error) {
        consola.error('Error executing transaction:', error)
      }

    if (action === 'Execute with Deployer')
      try {
        const safeTransaction = tx.safeTransaction
        consola.info('Initializing deployer wallet...')
        const deployerPrivateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION')
        const { safe: deployerSafe } = await getOrInitializeSafeClient(
          network,
          deployerPrivateKey,
          rpcUrl,
          false,
          undefined,
          txSafeAddress
        )
        consola.info('Executing transaction with deployer wallet...')
        if (await executeTransaction(safeTransaction, tx, deployerSafe)) {
          executedThisRun = true
          expectedNonce++
        }
      } catch (error) {
        consola.error('Error executing with deployer:', error)
      }

    recordProposalOutcome({ signatures, signedThisRun, executedThisRun })
  }

  // One row per network, written once every proposal on it has been graded and
  // reduced worst-first. A `ready` network always carries at least one proposal,
  // so the empty branch records a broken invariant — unverified, never a network
  // the run established had nothing on it.
  if (checkLedger) {
    if (proposalChecks.length === 0)
      recordCouldNotGrade(network, 'the prepared network carried no proposal')
    else
      for (const result of worstResultPerCheck(proposalChecks))
        recordCheck(checkLedger, result)
  }
}

/**
 * Main command definition for the script
 */
const main = defineCommand({
  meta: {
    name: 'confirm-safe-tx',
    description: 'Confirm and execute transactions in a Gnosis Safe',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network name',
    },
    rpcUrl: {
      type: 'string',
      description: 'RPC URL',
    },
    privateKey: {
      type: 'string',
      description: 'Private key of the signer (not needed if using --ledger)',
      required: false,
    },
    ledger: {
      type: 'boolean',
      description: 'Use Ledger hardware wallet for signing',
      default: true,
      required: false,
    },
    ledgerLive: {
      type: 'boolean',
      description: 'Use Ledger Live derivation path',
      required: false,
    },
    accountIndex: {
      type: 'string',
      description: 'Ledger account index (default: 0)',
      required: false,
    },
    derivationPath: {
      type: 'string',
      description: 'Custom derivation path for Ledger (overrides ledgerLive)',
      required: false,
    },
    // No `default`: the value is read from argv by `readBooleanFlag`, and a
    // citty default would shadow what the caller actually passed.
    raw: {
      type: 'boolean',
      description:
        'Print the full calldata hex instead of its length and first four bytes',
      required: false,
    },
  },
  async run({ args }) {
    // Set up signing options
    let privateKey: string | undefined
    let keyType = PrivateKeyTypeEnum.DEPLOYER // default value
    // Read from argv, not from `args` — see `cli-flags.ts`. A Ledger is the
    // default signer here, so a misread flag signs from a different address.
    const useLedger = readBooleanFlag(
      process.argv,
      { camel: 'ledger', kebab: 'ledger' },
      { whenAbsent: true }
    )
    // Resolved once and read everywhere below. Two sources disagreed: citty
    // parses `--ledger-live=false` to the string 'false', which is truthy, so
    // the console announced a Ledger Live derivation while the client derived
    // from the default path.
    const useLedgerLive = readBooleanFlag(process.argv, {
      camel: 'ledgerLive',
      kebab: 'ledger-live',
    })
    const ledgerOptions = {
      ledgerLive: useLedgerLive,
      accountIndex: parseAccountIndex(
        readValueFlag(process.argv, {
          camel: 'accountIndex',
          kebab: 'account-index',
        })
      ),
      derivationPath: args.derivationPath,
    }

    // Validate that incompatible Ledger options aren't provided together
    if (args.derivationPath && useLedgerLive)
      throw new Error(
        "Cannot use both 'derivationPath' and 'ledgerLive' options together"
      )

    // If using ledger, we don't need a private key
    if (useLedger) {
      consola.info('Using Ledger hardware wallet for signing')
      if (useLedgerLive)
        consola.info(
          `Using Ledger Live derivation path with account index ${ledgerOptions.accountIndex}`
        )
      else if (args.derivationPath)
        consola.info(`Using custom derivation path: ${args.derivationPath}`)
      else consola.info(`Using default derivation path: m/44'/60'/0'/0/0`)

      privateKey = undefined
    } else if (!args.privateKey) {
      // If no private key and not using ledger, ask for key from env
      const keyChoice = await consola.prompt(
        'Which private key do you want to use from your .env file?',
        {
          type: 'select',
          options: ['PRIVATE_KEY_PRODUCTION', 'SAFE_SIGNER_PRIVATE_KEY'],
        }
      )

      privateKey = getPrivateKey(
        keyChoice as 'PRIVATE_KEY_PRODUCTION' | 'SAFE_SIGNER_PRIVATE_KEY'
      )
      keyType =
        keyChoice === 'SAFE_SIGNER_PRIVATE_KEY'
          ? PrivateKeyTypeEnum.SAFE_SIGNER
          : PrivateKeyTypeEnum.DEPLOYER
    } else privateKey = getPrivateKey('PRIVATE_KEY_PRODUCTION', args.privateKey)

    // Create ledger connection once if using ledger
    let ledgerResult: ILedgerAccountResult | undefined
    if (useLedger) {
      try {
        const { getLedgerAccount } = await import('./ledger')
        ledgerResult = await getLedgerAccount(ledgerOptions)
        consola.success('Ledger connected successfully for all networks')
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        consola.error(`Failed to connect to Ledger: ${errorMsg}`)
        throw error
      }

      // Fail fast with enable instructions rather than dying mid-sign. The
      // requirement is documented for the EIP-712 payload; whether a Flex also
      // needs it for the single message screen hash signing shows has not been
      // checked on a device, so the gate stays for both rather than being
      // narrowed on an assumption.
      const { checkBlindSigningEnabled, closeLedgerConnection } = await import(
        './ledger'
      )
      if (
        ledgerResult &&
        !(await checkBlindSigningEnabled(ledgerResult.transport))
      ) {
        await closeLedgerConnection(ledgerResult.transport)
        process.exit(1)
      }
    }

    try {
      // Connect to MongoDB early to use it for network detection
      const { client: mongoClient, pendingTransactions } =
        await getSafeMongoCollection()

      // Refresh .cache/deployments_production.json from MongoDB so every
      // signer (not just the deployer's machine) sees up-to-date facet
      // versions in the signing UI — unconditionally, since a facet deployed
      // minutes ago must show up even when the local cache is younger than
      // its TTL. Runs concurrently with the reconcile sweep and ownership
      // filtering below (it depends only on MONGODB_URI); the flow joins on
      // it at the Promise.all before the first network's prefetch starts.
      const deploymentCacheWarm = process.env.MONGODB_URI
        ? createDefaultCache({
            mongoUri: process.env.MONGODB_URI,
            databaseName: 'contract-deployments',
            batchSize: 100,
          })
            .refresh('production')
            .then(() => undefined)
            .catch((error) => {
              consola.debug(`Deployment cache refresh skipped: ${error}`)
            })
        : Promise.resolve()

      // Resolve in-flight `submitted` rows across all networks before the
      // pending-only selection runs. A network whose only row is `submitted`
      // (no sibling `pending` proposal) is otherwise never reconciled, so its
      // timelock op is never enqueued for auto-execution. Read-only on-chain.
      try {
        const reconciled = await reconcileAllSubmittedSafeTxs(
          pendingTransactions,
          args.network
            ? { network: args.network, rpcUrl: args.rpcUrl }
            : undefined
        )
        reconciled.forEach((k) => startupReconciledKeys.add(k))
      } catch (error: unknown) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        consola.warn(`Startup reconcile sweep failed: ${errorMsg}`)
      }

      // Get signer address early (needed for filtering actionable networks)
      let signerAddress: Address
      if (useLedger && ledgerResult?.account) {
        signerAddress = ledgerResult.account.address
      } else if (privateKey) {
        const { privateKeyToAccount } = await import('viem/accounts')
        const account = privateKeyToAccount(`0x${privateKey}` as Hex)
        signerAddress = account.address
      } else {
        throw new Error('No signer available (missing private key or Ledger)')
      }

      let networks: string[]
      let candidateNetworks: string[]

      if (args.network) {
        // If a specific network is provided, validate it exists and is active
        const networkConfig =
          networksData[args.network.toLowerCase() as keyof typeof networksData]
        if (!networkConfig)
          throw new Error(`Network ${args.network} not found in networks.json`)

        if (networkConfig.status !== 'active')
          throw new Error(`Network ${args.network} is not active`)

        candidateNetworks = [args.network]
      } else {
        // First, get all networks with pending transactions (for informational purposes)
        candidateNetworks = await getNetworksWithPendingTransactions(
          pendingTransactions
        )

        if (candidateNetworks.length === 0) {
          consola.info('No networks have pending transactions')
          await mongoClient.close(true)
          return
        }

        consola.info(
          `Found pending transactions on ${
            candidateNetworks.length
          } network(s): ${candidateNetworks.join(', ')}`
        )
      }

      // Before the ownership reads and before a ledger exists, so a network
      // that cannot be graded is named once with its cause instead of becoming
      // a column of unverified checks. `getNetworksWithActionableTransactions`
      // still probes it — it derives its own network list — but reports a failed
      // read as "not actionable", a true statement with a false explanation, so
      // the refusal has to be printed before it speaks.
      const preflightVerdict = await networkPreflight(candidateNetworks, {
        // `--rpc-url` cannot stand in for the variable: `buildReadOnlyClient`
        // resolves the chain before it looks at the override, and that resolve
        // is what needs the variable. Treating the flag as configuration here
        // let the run report a missing variable as an endpoint that did not
        // answer, and send the signer to check a host nothing had contacted.
        endpointConfigured: (network) =>
          Boolean(process.env[getRPCEnvVarName(network)]?.trim()),
        chainIdOf: (network) =>
          buildReadOnlyClient(network, args.rpcUrl, {
            signal: AbortSignal.timeout(PREFLIGHT_PROBE_TIMEOUT_MS),
          }).getChainId(),
        expectedChainId: (network) =>
          networksData[network.toLowerCase() as keyof typeof networksData]
            .chainId,
        envVarName: getRPCEnvVarName,
      })
      refusedNetworks = [...preflightVerdict.refused]
      renderNetworkPreflight(preflightVerdict).forEach((line) =>
        consola.log(line)
      )

      if (preflightVerdict.startable.length === 0) {
        process.exitCode = PREFLIGHT_EXIT_CODE
        await mongoClient.close(true)
        return
      }

      if (args.network) networks = [...preflightVerdict.startable]
      else {
        const startableWithPendingTxs = preflightVerdict.startable
        consola.info(`Checking ownership for signer: ${signerAddress}`)

        // Filtered to the networks the preflight cleared, so a refused one
        // cannot reach `networks` — and therefore the ledger — as "not a Safe
        // owner", which is what its failed ownership read would otherwise say.
        networks = (
          await getNetworksWithActionableTransactions(
            pendingTransactions,
            signerAddress,
            args.rpcUrl
          )
        ).filter((network) => preflightVerdict.startable.includes(network))

        if (networks.length === 0) {
          consola.info(
            'No networks found where you can take action. All pending transactions are either already signed by you or have enough signatures to execute.'
          )
          consola.info('Check the summary above for details on each network.')
          await mongoClient.close(true)
          return
        }

        // Show which networks are actionable
        if (networks.length < startableWithPendingTxs.length) {
          const nonActionableNetworks = startableWithPendingTxs.filter(
            (n) => !networks.includes(n)
          )
          consola.info(
            `You can take action on ${
              networks.length
            } network(s): ${networks.join(', ')}`
          )
          consola.info(
            `Skipping ${
              nonActionableNetworks.length
            } network(s) where you are not a Safe owner: ${nonActionableNetworks.join(
              ', '
            )}`
          )
        } else {
          // "this run can check", not "with pending transactions": the refused
          // networks were dropped above and counted in the block that named them.
          consola.info(
            `You can take action on all ${networks.length} network(s) this run can check`
          )
        }
      }

      // INVARIANT: `account` (the Ledger account created once at startup) MUST
      // be part of these params. With a pre-created account, SafeClient.init
      // skips getLedgerAccount(), so a background prefetch never opens a second
      // Ledger transport while the operator is signing on the current network —
      // hw-transport-node-hid does not support concurrent use. Removing it
      // would silently reintroduce device contention.
      const prefetchParamsBase = {
        pendingTransactions,
        privateKey,
        rpcUrl: args.rpcUrl,
        useLedger,
        ledgerOptions,
        account: ledgerResult?.account,
        startupReconciledKeys,
      }

      const [txsByNetwork] = await Promise.all([
        getPendingTransactionsByNetwork(pendingTransactions, networks),
        deploymentCacheWarm,
      ])

      const prefetchQueue = new ConfirmSafeTxPrefetchQueue()
      const firstNetwork = networks[0]
      if (firstNetwork) {
        const firstTxs = txsByNetwork[firstNetwork.toLowerCase()]
        if (firstTxs && firstTxs.length > 0)
          prefetchQueue.schedule(firstNetwork, {
            ...prefetchParamsBase,
            pendingTxs: firstTxs,
          })
      }

      checkLedger = createCheckLedger({
        expectedNetworks: networks.filter((network): network is string =>
          Boolean(network)
        ),
        checks: [...CONFIRM_CHECK_DEFINITIONS],
      })

      for (let i = 0; i < networks.length; i++) {
        const network = networks[i]
        if (!network) continue

        const networkTxs = txsByNetwork[network.toLowerCase()]
        if (!networkTxs || networkTxs.length === 0) {
          recordNothingToGrade(network, 'no pending transaction was fetched')
          continue
        }

        networksAttempted.add(network)

        const nextNetwork = networks[i + 1]
        if (nextNetwork) {
          const nextTxs = txsByNetwork[nextNetwork.toLowerCase()]
          if (nextTxs && nextTxs.length > 0)
            prefetchQueue.schedule(nextNetwork, {
              ...prefetchParamsBase,
              pendingTxs: nextTxs,
            })
        }

        const prepared = await prefetchQueue.take(network, {
          ...prefetchParamsBase,
          pendingTxs: networkTxs,
        })

        switch (prepared.kind) {
          case 'ready':
            await processTxs(
              keyType,
              pendingTransactions,
              args.rpcUrl,
              prepared.context
            )
            break
          case 'nothing-actionable':
            consola.success(`No actionable pending transactions on ${network}`)
            recordNothingToGrade(
              network,
              'nothing actionable was left once the network was prepared'
            )
            break
          case 'not-owner':
            consola.error(
              `[${network}] The current signer is not an owner of this Safe — cannot sign or execute`
            )
            consola.error(`  Signer: ${prepared.signerAddress}`)
            consola.error(`  Owners: ${prepared.owners.join(', ')}`)
            recordNothingToGrade(
              network,
              'the signer is not an owner of this Safe, so nothing here can be signed'
            )
            break
          case 'owner-check-failed':
            consola.error(
              `[${network}] Failed to check Safe ownership — skipping this network: ${prepared.error}`
            )
            recordCouldNotGrade(
              network,
              'the Safe ownership read failed, so ownership could not be established'
            )
            break
          case 'read-failed':
            // Unknown threshold/nonce state must abort rather than proceed —
            // a signing/execution decision on stale state is unsafe.
            throw new Error(
              `Could not read threshold/nonce for the Safe on ${network}: ${prepared.error}`
            )
          case 'prepare-error':
            throw new Error(`Failed to prepare ${network}: ${prepared.error}`)
          default: {
            const exhaustive: never = prepared
            throw new Error(
              `Unhandled prepare result: ${JSON.stringify(exhaustive)}`
            )
          }
        }
      }

      // Close MongoDB connection
      await mongoClient.close(true)
    } finally {
      await releaseAllPooledSafeClients().catch(() => undefined)
      if (codehashDeps) {
        const deps = codehashDeps
        codehashDeps = undefined
        await deps.close().catch(() => undefined)
      }
      // Always close ledger connection if it was created
      if (ledgerResult) {
        const { closeLedgerConnection } = await import('./ledger')
        await closeLedgerConnection(ledgerResult.transport)
      }

      // Both summaries print here, together and last. In `finally` because an
      // aborted run is where they matter most, and after the transport close so
      // a write failure here cannot leave the Ledger open. Together because a
      // queue summary shown without the execution failures beside it reads as
      // if the run succeeded.
      const executionsFailed =
        globalFailedExecutions.length > 0 || globalTimeoutExecutions.length > 0

      // Ahead of the queue summary: the ledger says what was verified, and the
      // table below only says where each proposal now stands. Withheld while
      // target-state was the only row — every real cut graded `needs-ack`, so a
      // correct rollout closed `0/N verified`. With the integrity, executability
      // and quorum rows beside it a clean proposal now closes mostly verified,
      // and an `executability` row that could not be read blocks; a block the
      // signer never sees is worse than no check at all.
      if (checkLedger)
        renderCheckLedger(checkLedger).forEach((line) => consola.info(line))

      // After the ledger, because it is about what the ledger does not cover.
      // The refused networks are absent from its denominator, so its verdict is
      // about the networks that could be graded and says nothing about these.
      if (refusedNetworks.length > 0) {
        consola.error(
          `Not covered by the verdict above: ${refusedNetworks.join(
            ', '
          )} — the run could not start there, so nothing on those networks was checked.`
        )
        process.exitCode = PREFLIGHT_EXIT_CODE
      }

      if (networkOutcomes.length > 0) {
        const summary = rollUpQueue(networkOutcomes)
        if (summary.networks < networksAttempted.size)
          consola.warn(
            `Covers ${summary.networks} of ${networksAttempted.size} networks attempted — the rest produced no reviewable proposal (not an owner, ownership read failed, or nothing actionable). The table below counts the covered networks, not the fleet.`
          )
        renderQueueSummary(summary).forEach((line) => consola.info(line))
        if (executionsFailed)
          consola.warn(
            'An execution failed this run — it is not counted as executed above, and the proposal is still queued. Details below.'
          )
      }

      if (executionsFailed) {
        consola.info('=== Execution Summary ===')
        if (globalFailedExecutions.length > 0) {
          consola.info('Failed Executions:')
          globalFailedExecutions.forEach((item) => {
            consola.info(
              `Chain: ${item.chain}, SafeTxHash: ${item.safeTxHash}, Error: ${item.error}`
            )
          })
        }
        if (globalTimeoutExecutions.length > 0) {
          consola.info('Timed Out Executions (saved in MongoDB):')
          globalTimeoutExecutions.forEach((item) => {
            consola.info(
              `Chain: ${item.chain}, SafeTxHash: ${item.safeTxHash}, Error: ${item.error}`
            )
          })
        }
      }
    }
  },
})

runMain(main)
