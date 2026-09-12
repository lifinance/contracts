/**
 * Rehearses the Safe verify path end to end, without signing anything.
 *
 * Run this to exercise the confirm-stage gate chain against real proposals: it
 * reads them from the store, runs every merged gate twice, compares the two
 * passes, and prints a report naming every gate the chain is meant to run —
 * including the ones no commit has wired yet.
 *
 *   bunx tsx script/deploy/safe/verify-rehearsal.ts --networks tron,arbitrum
 *
 * It never signs, proposes or executes, and the preflight proves that before it
 * opens anything. `--corrupt` damages every proposal's calldata to establish
 * that the chain can still refuse — a rehearsal that only ever grades green has
 * not shown that its gates work. `--status` selects the corpus: `pending` is
 * the live case, and `executed` gives the chain something to grade when nothing
 * is in flight, at the cost of judging historical cuts against today's anchor.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient, type Collection } from 'mongodb'
import type { Hex } from 'viem'

import {
  summariseGate,
  type IShadowObservation,
} from '../codehash/false-refusal-budget'

import {
  createCheckLedger,
  recordCheck,
  type ICheckLedger,
} from './check-ledger'
import {
  CONFIRM_CHECK_DEFINITIONS,
  targetStateCheckResult,
} from './confirm-check-registry'
import {
  createPinnedTargetStateReader,
  createTargetStateDeps,
  evaluateTargetStateIntent,
} from './pinned-target-state'
import { buildGateReport, renderGateReport } from './rehearsal-report'
import {
  collectRefusalObservations,
  gradeCorruptionProbe,
  summariseRehearsal,
  type IRehearsalPassEntry,
} from './rehearsal-run'
import { READ_ONLY_RUN, runRehearsalPreflight } from './rehearsal-write-guard'
import type { ISafeTxDocument, SafeTxStatus } from './safe-utils'

/** The statuses the store actually holds, so a typo cannot silently match nothing. */
const SAFE_TX_STATUSES: readonly SafeTxStatus[] = [
  'pending',
  'submitted',
  'executed',
  'reverted',
]

/**
 * Narrows the `--status` flag to a real status.
 *
 * Validated rather than cast: an unrecognised value would match no row, and a
 * rehearsal over zero rows reads far too much like a clean one.
 */
const parseStatus = (value: string): SafeTxStatus => {
  const status = SAFE_TX_STATUSES.find((candidate) => candidate === value)
  if (!status)
    throw new Error(
      `--status must be one of ${SAFE_TX_STATUSES.join(', ')}; got "${value}"`
    )
  return status
}

/**
 * Opens the proposal store without ensuring any index.
 *
 * Deliberately not `getSafeMongoCollection`, which calls `createIndex` twice on
 * connect: opening the store the ordinary way is itself a write, and it is
 * exactly the kind nobody would think to switch off.
 */
async function openReadOnlyProposalStore(): Promise<{
  client: MongoClient
  pendingTransactions: Collection<ISafeTxDocument>
}> {
  const uri = process.env.SC_MONGODB_URI
  if (!uri) throw new Error('SC_MONGODB_URI environment variable is required')

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000 })
  await client.connect()
  return {
    client,
    pendingTransactions: client
      .db('sc_private')
      .collection<ISafeTxDocument>('pendingTransactions'),
  }
}

/** Damages a proposal's calldata so the chain has something it must refuse. */
const corruptCalldata = (calldata: Hex): Hex =>
  (calldata.length > 10
    ? `${calldata.slice(0, 10)}${'f'.repeat(64)}${calldata.slice(74)}`
    : '0xdeadbeef') as Hex

/**
 * Runs every merged gate over one proposal and returns its ledger.
 *
 * Only `target-state` is wired on this commit; the rest of the roster is
 * reported absent rather than quietly skipped.
 */
function runGateChain(
  doc: ISafeTxDocument,
  network: string,
  corrupt: boolean,
  readPinnedState: ReturnType<typeof createPinnedTargetStateReader>
): ICheckLedger {
  const ledger = createCheckLedger({
    expectedNetworks: [network],
    checks: [...CONFIRM_CHECK_DEFINITIONS],
  })

  const raw = doc.safeTx?.data?.data as Hex | undefined
  const calldata = raw ? (corrupt ? corruptCalldata(raw) : raw) : undefined

  const verdict = evaluateTargetStateIntent(
    calldata ? [calldata] : [],
    network,
    createTargetStateDeps(network, { readPinnedState })
  )
  recordCheck(ledger, targetStateCheckResult(verdict, network))

  return ledger
}

const main = defineCommand({
  meta: {
    name: 'verify-rehearsal',
    description: 'Rehearse the Safe verify path read-only, signing nothing',
  },
  args: {
    networks: {
      type: 'string',
      required: true,
      description: 'Comma-separated network keys to rehearse',
    },
    corrupt: {
      type: 'boolean',
      default: false,
      description:
        'Damage every proposal, to establish the chain can still refuse',
    },
    status: {
      type: 'string',
      default: 'pending',
      description:
        "Row status to rehearse over. 'pending' is the live case; 'executed' gives the chain a corpus when nothing is in flight",
    },
  },
  async run({ args }) {
    const networks = args.networks
      .split(',')
      .map((network) => network.trim())
      .filter(Boolean)
    if (!networks.length) throw new Error('no networks given')
    const status = parseStatus(args.status)

    // Captured from inside `openStore` so the client is never constructed
    // before the preflight has refused a write-configured run.
    let client: MongoClient | undefined
    const preflight = await runRehearsalPreflight({
      config: READ_ONLY_RUN,
      openStore: async () => {
        const opened = await openReadOnlyProposalStore()
        client = opened.client
        return opened.pendingTransactions
      },
    })
    const pendingTransactions = preflight.store
    consola.success(
      `Preflight: ${preflight.evidence.length} write methods refused; run is read-only`
    )

    try {
      const docs = (await pendingTransactions
        .find({ network: { $in: networks }, status })
        .toArray()) as ISafeTxDocument[]

      consola.info(
        `Rehearsing ${docs.length} ${status} proposal(s) on ${networks.join(
          ', '
        )}`
      )

      // One reader for the whole run. It memoizes the `origin/main` read
      // internally, so building it per proposal — as an earlier draft did —
      // discards the memo and re-fetches the remote once per row.
      const readPinnedState = createPinnedTargetStateReader()

      const pass = (corrupt: boolean): IRehearsalPassEntry[] =>
        docs.map((doc) => ({
          proposal: doc.safeTxHash,
          ledger: runGateChain(doc, doc.network, corrupt, readPinnedState),
        }))

      const first = pass(false)
      const second = pass(false)

      const summary = summariseRehearsal({ first, second })
      if (summary.verdict === 'not-measured')
        consola.warn(
          'Not measured: no row was graded, so this run establishes nothing about determinism'
        )
      else if (summary.verdict === 'non-deterministic') {
        consola.error(
          `Non-deterministic: ${summary.findings.length} difference(s) over ${summary.rowsGraded} row(s)`
        )
        for (const finding of summary.findings)
          consola.error(
            `  ${finding.proposal} ${finding.checkId}/${finding.network} ${finding.field}: ${finding.first} -> ${finding.second}`
          )
      } else
        consola.success(
          `Deterministic: two passes graded ${summary.rowsGraded} row(s) identically`
        )

      const observations: IShadowObservation[] = [
        ...collectRefusalObservations(first),
      ]
      const budget = summariseGate({
        gate: 'confirm-gate-chain',
        corpus: `pending proposals on ${networks.join(', ')}`,
        denominator: observations.length,
        coverageNote:
          'only the gates merged on this commit ran; see the roster below for the rest',
        observations,
      })
      consola.info(
        `Refusals: ${budget.refusals}/${budget.denominator} rows (unexplained ${budget.unexplained})`
      )

      // Grouped rather than listed: 30 rows refusing for one reason is a
      // property of the gate, and a flat list of 30 lines hides that.
      const byReason = new Map<string, number>()
      for (const observation of observations)
        if (observation.refused)
          byReason.set(
            observation.reason,
            (byReason.get(observation.reason) ?? 0) + 1
          )
      for (const [reason, count] of [...byReason.entries()].sort(
        (a, b) => b[1] - a[1]
      ))
        consola.info(`  ${count}x ${reason}`)

      const rowCounts: Record<string, number> = {}
      for (const entry of first)
        for (const result of entry.ledger.results)
          rowCounts[result.checkId] = (rowCounts[result.checkId] ?? 0) + 1

      consola.info(
        `\nGate roster\n${renderGateReport(
          buildGateReport({
            registered: CONFIRM_CHECK_DEFINITIONS.map((check) => check.checkId),
            rowCounts,
          })
        )}`
      )

      if (args.corrupt) {
        const outcome = gradeCorruptionProbe(pass(true))
        if (outcome === 'refused')
          consola.success(
            'Corruption probe: the chain refused damaged calldata'
          )
        else if (outcome === 'did-not-refuse')
          consola.error(
            'Corruption probe: the chain graded damaged calldata without refusing'
          )
        else
          consola.warn(
            'Corruption probe: not exercised — there was nothing to damage'
          )
      }
    } finally {
      await client?.close(true)
    }
  },
})

if (process.argv[1] && process.argv[1].endsWith('verify-rehearsal.ts'))
  void runMain(main)
