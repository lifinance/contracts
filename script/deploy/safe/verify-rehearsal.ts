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
import { collectDiamondCutCalls } from '../shared/diamond-cut-calls'

import {
  createCheckLedger,
  recordCheck,
  type ICheckLedger,
} from './check-ledger'
import { readBooleanFlag } from './cli-flags'
import {
  CONFIRM_CHECK_DEFINITIONS,
  targetStateCheckResult,
} from './confirm-check-registry'
import {
  createPinnedTargetStateReader,
  createTargetStateDeps,
  evaluateTargetStateIntent,
} from './pinned-target-state'
import {
  buildGateReport,
  checkGradingAnchors,
  renderGateReport,
  renderGradingAnchors,
  verdictsAreActionable,
  renderSignerWorkload,
  summariseSignerWorkload,
} from './rehearsal-report'
import {
  collectRefusalObservations,
  gradeCorruptionProbe,
  refusalClasses,
  rowCountsByCheck,
  summariseRehearsal,
  survivedCorruption,
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

/**
 * An address no deployment record can resolve, for the mutation below.
 *
 * Recognisable on sight in a survivor line, and deliberately not a plausible
 * facet: if the gate grades this as a known contract, that is the finding.
 */
const UNRESOLVABLE_FACET = 'deadbeef'.repeat(5)

/**
 * A cut's facet address is only a usable needle if it is distinctive.
 *
 * A `Remove` action carries the zero address, whose hex is forty zeroes — a run
 * that occurs in almost every word of ABI padding, in a timelock `predecessor`,
 * and in every array offset. Substituting it rewrites the whole payload rather
 * than the field being aimed at, and the gate then refuses because nothing
 * decodes: a pass the probe did not earn.
 */
const isUsableNeedle = (address: string): boolean =>
  !/^0+$/.test(address) && !/^f+$/i.test(address)

/**
 * Damages the field the gate actually grades: a cut's facet address.
 *
 * Substituting the address reaches the inner cut at any nesting depth without
 * this module knowing the wrapper's shape: a timelock `schedule` and a direct
 * `diamondCut` are damaged alike. It rewrites the address anywhere else it
 * appears too — the `schedule` target included — so a refusal establishes that
 * the chain noticed the change, not which field it noticed.
 *
 * @param calldata - the proposal payload
 * @returns the payload with every usable facet address replaced, or one whose
 * leading word is damaged when no cut offered a needle to aim at
 */
const corruptCalldata = (calldata: Hex): Hex => {
  const collected = collectDiamondCutCalls([calldata])
  const addresses = collected.calls
    .flatMap((call) =>
      call.cuts.map((cut) => cut.facetAddress.slice(2).toLowerCase())
    )
    .filter(isUsableNeedle)

  if (addresses.length === 0)
    return (
      calldata.length > 10
        ? `${calldata.slice(0, 10)}${'f'.repeat(64)}${calldata.slice(74)}`
        : '0xdeadbeef'
    ) as Hex

  let damaged = calldata.toLowerCase()
  for (const address of new Set(addresses))
    damaged = damaged.split(address).join(UNRESOLVABLE_FACET)
  return damaged as Hex
}

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
    gradeWithoutAnchors: {
      type: 'boolean',
      description:
        'Grade even though a local anchor the gates read is missing. Every refusal is then suspect.',
    },
    status: {
      type: 'string',
      default: 'pending',
      description:
        "Row status to rehearse over. 'pending' is the live case; 'executed' gives the chain a corpus when nothing is in flight",
    },
  },
  async run({ args }) {
    // Lowercased, as every writer in this package stores them. An uncased key
    // matches no document, and the run would then report "not measured" — a
    // typo reading as a clean rehearsal is the worst outcome for this tool.
    const networks = args.networks
      .split(',')
      .map((network) => network.trim().toLowerCase())
      .filter(Boolean)
    if (!networks.length) throw new Error('no networks given')
    const status = parseStatus(args.status)
    const actionable = verdictsAreActionable(status)

    // Before anything is graded. A missing deployment cache turns the
    // target-state gate into a refusal on essentially every proposal, and the
    // refusals it produces are indistinguishable from real ones — so a run that
    // grades anyway publishes a corpus of false reds as findings.
    const anchors = checkGradingAnchors(process.cwd())
    consola.info(`Grading anchors\n${renderGradingAnchors(anchors)}`)
    const missing = anchors.filter((anchor) => !anchor.present)
    // Read from argv, not from `args`: citty parses a multi-word flag's
    // `--no-` form to the string 'false', which is truthy. See `cli-flags.ts`.
    const gradeWithoutAnchors = readBooleanFlag(process.argv, {
      camel: 'gradeWithoutAnchors',
      kebab: 'grade-without-anchors',
    })
    if (missing.length && !gradeWithoutAnchors)
      throw new Error(
        `Refusing to grade: ${missing.length} grading anchor(s) missing. Every verdict would rest on a file this checkout does not have. Re-run where they exist, or pass --grade-without-anchors to grade anyway and read every refusal as suspect.`
      )

    // Captured from inside `openStore` so the client is never constructed
    // before the preflight has refused a write-configured run.
    let client: MongoClient | undefined
    try {
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
        `Preflight: ${preflight.evidence.length} write surfaces refused; run is read-only`
      )

      const docs = (await pendingTransactions
        .find({ network: { $in: networks }, status })
        .toArray()) as ISafeTxDocument[]

      // Nothing to grade is a normal state, not a failure — an empty pending
      // queue means no wave is in flight. Returning here rather than running
      // the sections over zero rows: "0/0 refused, all of one class (none)" is
      // not a result, and four blocks of zeroes bury the one line that is.
      if (docs.length === 0) {
        consola.info(
          `No ${status} proposals on ${networks.join(
            ', '
          )} — nothing to verify. Run this once a wave is in the store and before anyone signs.`
        )
        return
      }

      consola.info(
        `Rehearsing ${docs.length} ${status} proposal(s) on ${networks.join(
          ', '
        )}`
      )

      // One reader per pass, not one per run. The reader memoizes its
      // `origin/main` read, so sharing it across both passes would replay the
      // first pass's answer into the second — and the remote anchor is the one
      // genuinely moving input the determinism check exists to catch.
      const pass = (corrupt: boolean): IRehearsalPassEntry[] => {
        const readPinnedState = createPinnedTargetStateReader()
        return docs.map((doc) => ({
          proposal: doc.safeTxHash,
          ledger: runGateChain(doc, doc.network, corrupt, readPinnedState),
        }))
      }

      const first = pass(false)
      const second = pass(false)

      const summary = summariseRehearsal({ first, second })
      // Tracked so the process can exit non-zero. consola sets no exit code, so
      // a wrapper or scheduled run would otherwise read a rehearsal that
      // established nothing — or one that found a difference — as success.
      let failed = false
      if (summary.verdict === 'not-measured') {
        failed = true
        consola.warn(
          'Not measured: no row was graded, so this run establishes nothing about determinism'
        )
      } else if (summary.verdict === 'non-deterministic') {
        failed = true
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
        corpus: `${status} proposals on ${networks.join(', ')}`,
        denominator: observations.length,
        coverageNote:
          'only the gates merged on this commit ran; see the roster below for the rest',
        observations,
      })

      // A budget over a single refusal class is not a measurement. Every
      // refusal lands in the one bucket this release has already ruled correct,
      // so `unexplained` is 0 for any corpus on any day — and that 0 is what
      // EXSC-977's promotion criterion reads to decide a gate may start
      // blocking. Withheld rather than printed with a caveat: a number nobody
      // can move should not appear next to numbers that move.
      const classes = refusalClasses(first)
      if (!actionable)
        consola.info(
          `Verdicts withheld: '${status}' proposals are graded against the target state origin/main declares now, not the one they were proposed against, so every version comparison is against an anchor from its own future. What this run establishes: the chain survives ${docs.length} real proposal shapes and agrees with itself. What it does not establish: anything about these proposals. Use --status pending for verdicts a signer can act on.`
        )
      else if (classes.length > 1)
        consola.info(
          `Refusals: ${budget.refusals}/${budget.denominator} rows (unexplained ${budget.unexplained})`
        )
      else
        consola.warn(
          `Refusal budget: not measured — ${budget.refusals}/${
            budget.denominator
          } rows refused, all of one class (${
            classes[0] ?? 'none'
          }), so "unexplained 0" would be a constant, not a result`
        )

      // Grouped rather than listed: 30 rows refusing for one reason is a
      // property of the gate, and a flat list of 30 lines hides that.
      const byReason = actionable ? new Map<string, number>() : undefined
      if (byReason) {
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
      }

      if (actionable)
        consola.info(
          `\nWho has to act\n${renderSignerWorkload(
            summariseSignerWorkload(first)
          )}`
        )

      consola.info(
        `\nGate roster\n${renderGateReport(
          buildGateReport({
            registered: CONFIRM_CHECK_DEFINITIONS.map((check) => check.checkId),
            rowCounts: rowCountsByCheck(first),
          })
        )}`
      )

      if (args.corrupt) {
        const corrupted = pass(true)
        const outcome = gradeCorruptionProbe(first, corrupted)
        if (outcome === 'refused')
          consola.success(
            'Corruption probe: every row the chain had read and graded now refuses'
          )
        else if (outcome === 'did-not-refuse') {
          failed = true
          const survivors = survivedCorruption(first, corrupted)
          consola.error(
            `Corruption probe: ${survivors.length} row(s) did not refuse after their calldata was damaged`
          )
          for (const slot of survivors.slice(0, 10))
            consola.error(`  survived: ${slot}`)
        } else {
          failed = true
          consola.warn(
            'Corruption probe: not exercised — no row was both readable and not already refusing, so damaging one proves nothing'
          )
        }
      }

      if (failed) process.exitCode = 1
    } finally {
      await client?.close(true)
    }
  },
})

if (process.argv[1] && process.argv[1].endsWith('verify-rehearsal.ts'))
  void runMain(main)
