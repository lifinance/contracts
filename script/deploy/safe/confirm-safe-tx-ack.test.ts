/**
 * Unit tests for the acknowledgement ledger, plus a source-shape guard on
 * `confirm-safe-tx.ts` that keeps the deleted action cache from returning.
 */

import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import {
  buildAcknowledgementKey,
  buildProposalKey,
  computeChangeFingerprint,
  createAcknowledgementLedger,
  evaluateProposalIntegrity,
  recordAcknowledgement,
  renderQueueSummary,
  rollUpQueue,
  type IAcknowledgementLedger,
  type INetworkOutcome,
} from './confirm-safe-tx-ack'

/**
 * The ledger's read side. Local to the tests: production code records and rolls
 * up, and never asks whether one effect is already acknowledged.
 */
const isAcknowledged = (ledger: IAcknowledgementLedger, key: Hex): boolean =>
  (ledger.acknowledgedProposalKeys.get(key)?.size ?? 0) > 0

const REPO_ROOT = join(import.meta.dir, '..', '..', '..')

const readJson = (relativePath: string): Record<string, never> =>
  JSON.parse(readFileSync(join(REPO_ROOT, relativePath), 'utf8'))

const ABI_INIT_OPTIMISM = [
  {
    type: 'function',
    name: 'initOptimism',
    inputs: [
      {
        name: 'configs',
        type: 'tuple[]',
        components: [
          { name: 'assetId', type: 'address' },
          { name: 'bridge', type: 'address' },
        ],
      },
      { name: 'standardBridge', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

const ABI_DIAMOND_CUT = [
  {
    type: 'function',
    name: 'diamondCut',
    inputs: [
      {
        name: '_diamondCut',
        type: 'tuple[]',
        components: [
          { name: 'facetAddress', type: 'address' },
          { name: 'action', type: 'uint8' },
          { name: 'functionSelectors', type: 'bytes4[]' },
        ],
      },
      { name: '_init', type: 'address' },
      { name: '_calldata', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const

/**
 * Builds the `diamondCut` calldata a facet update proposes. The init payload
 * comes from the network's own config; the facet address and selector list are
 * held constant across networks so only the payload varies.
 */
const buildDiamondCutCalldata = (
  facet: Address,
  selectors: Hex[],
  initTarget: Address,
  initCalldata: Hex
): Hex =>
  encodeFunctionData({
    abi: ABI_DIAMOND_CUT,
    functionName: 'diamondCut',
    args: [
      [{ facetAddress: facet, action: 1, functionSelectors: selectors }],
      initTarget,
      initCalldata,
    ],
  })

const buildInitOptimismCalldata = (network: string): Hex => {
  const config = readJson('config/optimism.json') as unknown as Record<
    string,
    { standardBridge: Address; tokens: { assetId: Address; bridge: Address }[] }
  >
  const entry = config[network]
  if (!entry)
    throw new Error(
      `config/optimism.json has no ${network} entry — this test anchors the per-network payload divergence on it; re-anchor on another config if the stanza was removed`
    )

  return encodeFunctionData({
    abi: ABI_INIT_OPTIMISM,
    functionName: 'initOptimism',
    args: [
      entry.tokens.map((t) => ({ assetId: t.assetId, bridge: t.bridge })),
      entry.standardBridge,
    ],
  })
}

// Real production addresses, pinned as constants rather than read back from
// `deployments/**`. That directory is NOT in the unit-test workflow's path
// filter, so a deployments-only change does not run this suite — reading it here
// would surface the failure in whichever unrelated PR next touched `script/**`.
// The properties under test are the fingerprint and the effect key; neither
// needs the deployment registry to be live.
const DIAMOND_A: Address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const DIAMOND_B: Address = '0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37'
const ZERO: Address = '0x0000000000000000000000000000000000000000'
// OptimismBridgeFacet on mainnet and CelerCircleBridgeFacet on arbitrum.
const OPTIMISM_BRIDGE_FACET: Address =
  '0x54678c366682a29112609882DC58dEF6753BFC27'
const CELER_CIRCLE_FACET: Address = '0xB815B47ad429436892Fc3C6ed1D401F515C7F763'

const CALL = 0
const DELEGATECALL = 1

const effectKey = (
  to: Address,
  fingerprint: Hex,
  operation = CALL,
  value = 0n
): Hex => buildAcknowledgementKey({ to, value, operation, fingerprint })

describe('computeChangeFingerprint', () => {
  it('is keccak of the full calldata, not a semantic label', () => {
    // Same facet, same selectors, same version label — only the per-network
    // init payload differs. A `facet+version+selectors` label collapses these.
    const facet = OPTIMISM_BRIDGE_FACET
    const selectors: Hex[] = ['0x8a2e4b73', '0x0e2ce9a1']

    const mainnetCut = buildDiamondCutCalldata(
      facet,
      selectors,
      facet,
      buildInitOptimismCalldata('mainnet')
    )
    const mumbaiCut = buildDiamondCutCalldata(
      facet,
      selectors,
      facet,
      buildInitOptimismCalldata('mumbai')
    )

    expect(mainnetCut).not.toBe(mumbaiCut)
    expect(computeChangeFingerprint(mainnetCut)).not.toBe(
      computeChangeFingerprint(mumbaiCut)
    )
  })

  it('gives byte-identical calldata one fingerprint', () => {
    const facet = CELER_CIRCLE_FACET
    const selectors: Hex[] = ['0x2e2fb18b']
    const first = buildDiamondCutCalldata(facet, selectors, ZERO, '0x')
    const second = buildDiamondCutCalldata(facet, selectors, ZERO, '0x')

    expect(first).toBe(second)
    expect(computeChangeFingerprint(first)).toBe(
      computeChangeFingerprint(second)
    )
  })

  it('treats an absent payload as the empty payload', () => {
    expect(computeChangeFingerprint(undefined)).toBe(
      computeChangeFingerprint('0x')
    )
  })
})

describe('buildProposalKey', () => {
  it('includes to, chainId and nonce', () => {
    const key = buildProposalKey({ to: DIAMOND_A, chainId: 42161, nonce: 7 })
    expect(key).toContain(DIAMOND_A.toLowerCase())
    expect(key).toContain('42161')
    expect(key).toContain('7')
  })

  it('never collapses two networks carrying byte-identical calldata', () => {
    expect(
      buildProposalKey({ to: DIAMOND_A, chainId: 42161, nonce: 7 })
    ).not.toBe(buildProposalKey({ to: DIAMOND_A, chainId: 8453, nonce: 7 }))
  })

  it('never collapses two nonces on the same Safe', () => {
    expect(buildProposalKey({ to: DIAMOND_A, chainId: 1, nonce: 7 })).not.toBe(
      buildProposalKey({ to: DIAMOND_A, chainId: 1, nonce: 8 })
    )
  })

  it('is case-insensitive on the target address', () => {
    expect(
      buildProposalKey({ to: DIAMOND_A.toUpperCase(), chainId: 1, nonce: 1 })
    ).toBe(
      buildProposalKey({ to: DIAMOND_A.toLowerCase(), chainId: 1, nonce: 1 })
    )
  })
})

describe('buildAcknowledgementKey', () => {
  const fingerprint = computeChangeFingerprint('0xdeadbeef')

  it('collapses the same effect on two networks to one key', () => {
    expect(effectKey(DIAMOND_A, fingerprint)).toBe(
      effectKey(DIAMOND_A, fingerprint)
    )
  })

  it('separates identical bytes aimed at a different target', () => {
    // Real, currently distinct production diamond addresses.
    expect(effectKey(DIAMOND_A, fingerprint)).not.toBe(
      effectKey(DIAMOND_B, fingerprint)
    )
  })

  it('separates a DelegateCall from a Call carrying the same bytes', () => {
    expect(effectKey(DIAMOND_A, fingerprint, CALL)).not.toBe(
      effectKey(DIAMOND_A, fingerprint, DELEGATECALL)
    )
  })

  it('separates a value-bearing transaction from a zero-value one', () => {
    expect(effectKey(DIAMOND_A, fingerprint, CALL, 0n)).not.toBe(
      effectKey(DIAMOND_A, fingerprint, CALL, 10n ** 19n)
    )
  })

  it('is case-insensitive on the target address', () => {
    expect(effectKey(DIAMOND_A.toUpperCase() as Address, fingerprint)).toBe(
      effectKey(DIAMOND_A.toLowerCase() as Address, fingerprint)
    )
  })

  it('accepts value as a number, string or bigint interchangeably', () => {
    const asNumber = buildAcknowledgementKey({
      to: DIAMOND_A,
      value: 5,
      operation: CALL,
      fingerprint,
    })
    const asString = buildAcknowledgementKey({
      to: DIAMOND_A,
      value: '5',
      operation: CALL,
      fingerprint,
    })
    const asBigint = buildAcknowledgementKey({
      to: DIAMOND_A,
      value: 5n,
      operation: CALL,
      fingerprint,
    })

    expect(asNumber).toBe(asString)
    expect(asString).toBe(asBigint)
  })
})

describe('evaluateProposalIntegrity', () => {
  it('passes a current nonce', () => {
    expect(evaluateProposalIntegrity({ nonceStatus: 'current' })).toEqual({
      ok: true,
      failures: [],
    })
  })

  it('fails a stale nonce', () => {
    expect(evaluateProposalIntegrity({ nonceStatus: 'stale' })).toEqual({
      ok: false,
      failures: ['stale-nonce'],
    })
  })

  it('passes a future nonce — sequential execution within one run is legitimate', () => {
    expect(evaluateProposalIntegrity({ nonceStatus: 'future' }).ok).toBe(true)
  })
})

describe('acknowledgement ledger', () => {
  const fingerprint = computeChangeFingerprint('0xdeadbeef')
  const KEY = effectKey(DIAMOND_A, fingerprint)
  const PROPOSAL = buildProposalKey({ to: DIAMOND_A, chainId: 1, nonce: 1 })

  it('records and reports an acknowledgement', () => {
    const ledger = createAcknowledgementLedger()
    expect(isAcknowledged(ledger, KEY)).toBe(false)

    expect(
      recordAcknowledgement(ledger, {
        acknowledgementKey: KEY,
        proposalKey: PROPOSAL,
        integrityOk: true,
      })
    ).toBe(true)
    expect(isAcknowledged(ledger, KEY)).toBe(true)
  })

  it('never acknowledges a proposal whose nonce verdict failed', () => {
    const ledger = createAcknowledgementLedger()

    expect(
      recordAcknowledgement(ledger, {
        acknowledgementKey: KEY,
        proposalKey: PROPOSAL,
        integrityOk: false,
      })
    ).toBe(false)
    expect(isAcknowledged(ledger, KEY)).toBe(false)
  })

  it('does not leak an acknowledgement to a different effect', () => {
    const ledger = createAcknowledgementLedger()
    recordAcknowledgement(ledger, {
      acknowledgementKey: KEY,
      proposalKey: PROPOSAL,
      integrityOk: true,
    })

    expect(isAcknowledged(ledger, effectKey(DIAMOND_B, fingerprint))).toBe(
      false
    )
    expect(
      isAcknowledged(ledger, effectKey(DIAMOND_A, fingerprint, DELEGATECALL))
    ).toBe(false)
  })

  it('stores no action verb', () => {
    const ledger = createAcknowledgementLedger()
    recordAcknowledgement(ledger, {
      acknowledgementKey: KEY,
      proposalKey: PROPOSAL,
      integrityOk: true,
    })

    const dumped = JSON.stringify(
      [...ledger.acknowledgedProposalKeys.entries()].map(([key, proposals]) => [
        key,
        [...proposals],
      ])
    )

    expect(dumped).not.toContain('Execute')
    expect(dumped).not.toContain('Sign')
  })
})

describe('rollUpQueue / renderQueueSummary', () => {
  const fingerprint = computeChangeFingerprint('0xdeadbeef')
  const KEY = effectKey(DIAMOND_A, fingerprint)

  const outcome = (
    chainId: number,
    over: Partial<INetworkOutcome> = {}
  ): INetworkOutcome => ({
    network: `net-${chainId}`,
    proposalKey: buildProposalKey({ to: DIAMOND_A, chainId, nonce: 1 }),
    acknowledgementKey: KEY,
    fingerprint,
    signatures: 1,
    threshold: 3,
    nonceCurrent: true,
    signedThisRun: false,
    executedThisRun: false,
    blocked: false,
    alreadySigned: false,
    ...over,
  })

  const fleet = (
    count: number,
    over: Partial<INetworkOutcome> = {},
    offset = 0
  ): INetworkOutcome[] =>
    Array.from({ length: count }, (_, i) => outcome(offset + i + 1, over))

  /**
   * The cell of `row` sitting under `label` in `header`.
   *
   * Reads the row at the character span the header label occupies, so a column
   * that drifts out from under its own heading fails — a row asserted by token
   * order alone stays green through exactly that defect.
   *
   * @param header - The column-header line.
   * @param row - A row line from the same table.
   * @param label - The column heading to read under.
   * @returns The trimmed cell text.
   */
  const cellUnder = (header: string, row: string, label: string): string => {
    const end = header.indexOf(label) + label.length
    expect(header.indexOf(label)).toBeGreaterThan(-1)
    // Columns are right-aligned, so the cell ends where its heading ends and
    // starts after the previous column's gap.
    return (
      row
        .slice(0, end)
        .trimEnd()
        .split(/\s{2,}/)
        .at(-1) ?? ''
    )
  }

  const table = (outcomes: INetworkOutcome[]) => {
    const lines = renderQueueSummary(rollUpQueue(outcomes))
    const [heading, , header, ...rest] = lines as [
      string,
      string,
      string,
      ...string[]
    ]
    return {
      lines,
      heading,
      header,
      rows: rest.slice(0, -1),
      footer: rest.at(-1) ?? '',
    }
  }

  it('buckets a fleet rollout by signatures held, in one row', () => {
    const summary = rollUpQueue([
      ...fleet(40, { signatures: 1 }),
      ...fleet(17, { signatures: 2 }, 40),
    ])

    expect(summary.rollups.length).toBe(1)
    expect(summary.proposals).toBe(57)
    expect(summary.networks).toBe(57)
    expect(summary.rollups[0]?.bySignatureCount.get(1)).toBe(40)
    expect(summary.rollups[0]?.bySignatureCount.get(2)).toBe(17)
    expect(summary.rollups[0]?.ready).toBe(0)
  })

  it('moves a proposal at threshold out of the buckets and into ready', () => {
    const summary = rollUpQueue([
      ...fleet(2, { signatures: 1 }),
      ...fleet(3, { signatures: 3 }, 2),
    ])
    const rollup = summary.rollups[0]

    expect(rollup?.ready).toBe(3)
    expect(rollup?.bySignatureCount.get(3)).toBeUndefined()
    expect(rollup?.bySignatureCount.get(1)).toBe(2)
  })

  it('leaves an executed proposal out of both the buckets and ready', () => {
    const summary = rollUpQueue([
      outcome(1, { signatures: 3, signedThisRun: true, executedThisRun: true }),
      outcome(2, { signatures: 1 }),
    ])
    const rollup = summary.rollups[0]
    const bucketed = [...(rollup?.bySignatureCount.values() ?? [])].reduce(
      (sum, count) => sum + count,
      0
    )

    expect(rollup?.executed).toBe(1)
    expect(rollup?.ready).toBe(0)
    // Every proposal is in exactly one of buckets / ready / executed; the
    // literal is the outcome count above, so a rollup that lost one fails.
    expect(bucketed + (rollup?.ready ?? 0) + (rollup?.executed ?? 0)).toBe(2)
    expect(rollup?.proposals).toBe(2)
  })

  it('counts a Sign & Execute as both signed and executed', () => {
    const summary = rollUpQueue([
      outcome(1, { signatures: 3, signedThisRun: true, executedThisRun: true }),
    ])

    expect(summary.signed).toBe(1)
    expect(summary.executed).toBe(1)
  })

  it('separates a signature added this run from one already on the proposal', () => {
    const summary = rollUpQueue([
      outcome(1, { signedThisRun: true, alreadySigned: false }),
      outcome(2, { signedThisRun: false, alreadySigned: true }),
      // Already mine and signed again in this run is one signature, not two
      // columns' worth: `already` is what this run did not have to do.
      outcome(3, { signedThisRun: true, alreadySigned: true }),
    ])

    expect(summary.rollups[0]?.signed).toBe(2)
    expect(summary.rollups[0]?.already).toBe(1)
  })

  it('counts a blocked proposal in its signature bucket, not out of the queue', () => {
    const summary = rollUpQueue([outcome(1, { signatures: 2, blocked: true })])

    expect(summary.blocked).toBe(1)
    expect(summary.rollups[0]?.bySignatureCount.get(2)).toBe(1)
  })

  it('lets a later entry for the same proposal supersede the provisional one', () => {
    const summary = rollUpQueue([
      outcome(1, { blocked: true, signatures: 1 }),
      outcome(1, { signedThisRun: true, signatures: 2 }),
    ])

    expect(summary.proposals).toBe(1)
    expect(summary.blocked).toBe(0)
    expect(summary.signed).toBe(1)
    expect(summary.rollups[0]?.bySignatureCount.get(2)).toBe(1)
  })

  it('keeps distinct effects in distinct rows', () => {
    const other: INetworkOutcome = {
      ...outcome(1),
      acknowledgementKey: effectKey(DIAMOND_B, fingerprint),
      proposalKey: buildProposalKey({ to: DIAMOND_B, chainId: 1, nonce: 1 }),
    }

    expect(rollUpQueue([outcome(1), other]).rollups.length).toBe(2)
  })

  it('renders each count under its own heading', () => {
    const { header, rows, heading } = table([
      ...fleet(40, { signatures: 1 }),
      ...fleet(17, { signatures: 2, signedThisRun: true }, 40),
    ])
    const row = rows[0] ?? ''

    expect(heading).toContain('Pending proposal queue')
    expect(cellUnder(header, row, 'proposals')).toBe('57')
    expect(cellUnder(header, row, '1')).toBe('40')
    expect(cellUnder(header, row, '2')).toBe('17')
    expect(cellUnder(header, row, 'signed')).toBe('17')
  })

  it('prints a column only when a row has something to put in it', () => {
    const quiet = table(fleet(3, { signatures: 1 }))
    const loud = table([
      ...fleet(3, { signatures: 1 }),
      outcome(9, { signatures: 1, blocked: true }),
    ])

    expect(quiet.header).not.toContain('blocked')
    expect(loud.header).toContain('blocked')
    expect(cellUnder(loud.header, loud.rows[0] ?? '', 'blocked')).toBe('1')
  })

  it('prints an empty cell as a dot, never as a zero', () => {
    const { header, rows } = table([
      outcome(1, { signatures: 1 }),
      outcome(2, { signatures: 1, blocked: true }),
      // A second change with nothing blocked, so its `blocked` cell is empty.
      {
        ...outcome(3, { signatures: 1 }),
        acknowledgementKey: effectKey(DIAMOND_B, fingerprint),
        proposalKey: buildProposalKey({ to: DIAMOND_B, chainId: 3, nonce: 1 }),
      },
    ])

    expect(cellUnder(header, rows[1] ?? '', 'blocked')).toBe('·')
    // Cells only — the payload column is hex and carries zeroes of its own.
    expect((rows[1] ?? '').split(/\s{2,}/).slice(2)).not.toContain('0')
  })

  it('states in the footer what the run did, including the zeroes', () => {
    const { footer } = table([
      ...fleet(2, { signatures: 1 }),
      outcome(9, { signatures: 3, signedThisRun: true }),
    ])

    expect(footer).toContain('3 pending at run start')
    expect(footer).toContain('1 at threshold')
    expect(footer).toContain('signed 1')
    expect(footer).toContain('executed 0')
  })

  it('names the stale nonces in the footer only when there are some', () => {
    const clean = table(fleet(2, { signatures: 1 }))
    const stale = table([
      ...fleet(2, { signatures: 1 }),
      outcome(9, { signatures: 1, nonceCurrent: false }),
    ])

    expect(clean.footer).not.toContain('stale')
    expect(stale.footer).toContain('1 on a stale nonce')
  })

  it('renders nothing at all when the run saw no proposal', () => {
    expect(renderQueueSummary(rollUpQueue([]))).toEqual([])
  })
})

describe('confirm-safe-tx.ts carries no action cache', () => {
  const source = readFileSync(
    join(import.meta.dir, 'confirm-safe-tx.ts'),
    'utf8'
  )

  // WHAT THIS CATCHES: every in-place reintroduction of the deleted cache —
  // reading a remembered choice into `action` via `||`, `??`, an if/else, a
  // ternary, a `Map.get`, or an assignment to a property instead of the local.
  // Also catches the local being renamed away, via the non-zero assertion.
  //
  // WHAT IT DOES NOT CATCH, verified by writing each one: reassigning
  // `consola.prompt` to a caching shim at module scope (the call site stays
  // byte-identical); a replay branch that acts and `continue`s before `action`
  // is ever assigned; and a cached value smuggled through the options object.
  // Those need a behavioural test, which needs a seam `processTxs` does not have
  // — extracting one is tracked separately. This guard is the cheap 80%, not a
  // proof, and it is written to say so rather than to look complete.
  //
  // Comments and string literals are stripped first: `confirm-safe-tx.ts`
  // already discusses "the operator's chosen action" in prose, and prose must
  // not be able to fail this.
  const executableSource = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')

  const ASSIGNMENT = /(?<![\w.$])action\s*=(?!=)/g
  // Matches the prompt call without pinning its user-facing label, so rewording
  // the prompt is not a test failure.
  const FROM_PROMPT = /^action = \(?await consola\.prompt\(/

  it('assigns action only from the prompt, on every assignment', () => {
    const collapsed = executableSource.replace(/\s+/g, ' ')
    const assignments = [...collapsed.matchAll(ASSIGNMENT)].map((match) =>
      collapsed.slice(match.index, (match.index ?? 0) + 40)
    )

    expect(assignments.length).toBeGreaterThan(0)
    expect(assignments.filter((a) => !FROM_PROMPT.test(a))).toEqual([])
  })

  it('does not reassign the prompt itself', () => {
    expect(
      [...executableSource.matchAll(/consola\.prompt\s*=(?!=)/g)].length
    ).toBe(0)
  })

  it('has no calldata-keyed response cache', () => {
    expect(
      source.split('\n').filter((line) => line.includes('storedResponses'))
    ).toEqual([])
  })
})

describe('confirm-safe-tx.ts previews the hash the device will sign', () => {
  const source = readFileSync(
    join(import.meta.dir, 'confirm-safe-tx.ts'),
    'utf8'
  )

  // WHAT THIS CATCHES: the preview being fed the stored, proposer-written
  // `safeTxHash` instead of the value the Safe computes from the normalised
  // struct. That substitution is invisible to the renderer's own unit tests —
  // both values are well-formed hashes — and it turns the preview into a
  // picture of what the proposer claims the device will show.
  //
  // WHAT IT DOES NOT CATCH: a helper that computes the hash and returns the
  // stored one anyway, or the preview being moved into a branch that never
  // runs. Both need a behavioural seam `processTxs` does not have.
  it('renders the filmstrip from the computed hash, not the stored one', () => {
    const call = source.match(/renderLedgerFlexHashFlow\(\{[^}]*\}\)/)

    expect(call?.[0]).toContain('hash: deviceHash')
  })

  it('computes that hash by asking the Safe contract', () => {
    expect(source).toContain('deviceHash = await safe.getTransactionHash(')
  })

  it('asks for no second review confirmation', () => {
    expect(source).not.toContain('Confirm you reviewed this change')
    expect(source).not.toContain('shouldPromptForAcknowledgement')
  })

  // The absence above is only safe while the action select is still there: it
  // is what the acknowledgement now rests on, so deleting it would satisfy the
  // two negative assertions while leaving the flow with no acknowledgement at
  // all. Pinned as a present, not only as an absence.
  //
  // WHAT IT DOES NOT CATCH: the select being rendered with its options built
  // somewhere else, or an option list that offers no signing action. Both need
  // the behavioural seam `processTxs` does not have.
  it('still offers the action select the acknowledgement rests on', () => {
    expect(source).toContain("await consola.prompt('Select action:'")
    expect(source).toContain("const options = ['Do Nothing']")
    expect(source).toContain("options.push('Sign')")
  })

  it('still lets the operator decline a proposal outright', () => {
    expect(source).toContain("if (action === 'Do Nothing') continue")
  })

  // A machine verdict the operator can no longer act on is a log line, not a
  // warning. Positional rather than presence-only, because the failure mode is
  // the warning drifting below the prompt it exists to inform.
  it('warns about a failing nonce verdict before the action select', () => {
    const warned = source.indexOf('Nonce check failed on this proposal')
    const selected = source.indexOf("await consola.prompt('Select action:'")

    expect(warned).toBeGreaterThan(-1)
    expect(selected).toBeGreaterThan(-1)
    expect(warned).toBeLessThan(selected)
  })
})
