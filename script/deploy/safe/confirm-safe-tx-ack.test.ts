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
  isChangeAcknowledged,
  recordAcknowledgement,
  renderChangeRollup,
  rollUpByChange,
  shouldPromptForAcknowledgement,
  type INetworkOutcome,
} from './confirm-safe-tx-ack'

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

describe('shouldPromptForAcknowledgement', () => {
  it('prompts the first time an effect is seen', () => {
    expect(
      shouldPromptForAcknowledgement({
        alreadyAcknowledged: false,
        integrityOk: true,
      })
    ).toBe(true)
  })

  it('does not re-prompt for an effect already acknowledged this run', () => {
    expect(
      shouldPromptForAcknowledgement({
        alreadyAcknowledged: true,
        integrityOk: true,
      })
    ).toBe(false)
  })

  it('always re-prompts when the nonce verdict failed, even if acknowledged', () => {
    expect(
      shouldPromptForAcknowledgement({
        alreadyAcknowledged: true,
        integrityOk: false,
      })
    ).toBe(true)
  })
})

describe('acknowledgement ledger', () => {
  const fingerprint = computeChangeFingerprint('0xdeadbeef')
  const KEY = effectKey(DIAMOND_A, fingerprint)
  const PROPOSAL = buildProposalKey({ to: DIAMOND_A, chainId: 1, nonce: 1 })

  it('records and reports an acknowledgement', () => {
    const ledger = createAcknowledgementLedger()
    expect(isChangeAcknowledged(ledger, KEY)).toBe(false)

    expect(
      recordAcknowledgement(ledger, {
        acknowledgementKey: KEY,
        proposalKey: PROPOSAL,
        integrityOk: true,
      })
    ).toBe(true)
    expect(isChangeAcknowledged(ledger, KEY)).toBe(true)
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
    expect(isChangeAcknowledged(ledger, KEY)).toBe(false)
  })

  it('does not leak an acknowledgement to a different effect', () => {
    const ledger = createAcknowledgementLedger()
    recordAcknowledgement(ledger, {
      acknowledgementKey: KEY,
      proposalKey: PROPOSAL,
      integrityOk: true,
    })

    expect(
      isChangeAcknowledged(ledger, effectKey(DIAMOND_B, fingerprint))
    ).toBe(false)
    expect(
      isChangeAcknowledged(
        ledger,
        effectKey(DIAMOND_A, fingerprint, DELEGATECALL)
      )
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

describe('rollUpByChange', () => {
  const fingerprint = computeChangeFingerprint('0xdeadbeef')
  const KEY = effectKey(DIAMOND_A, fingerprint)

  const outcome = (
    chainId: number,
    nonceCurrent: boolean
  ): INetworkOutcome => ({
    network: `net-${chainId}`,
    proposalKey: buildProposalKey({ to: DIAMOND_A, chainId, nonce: 1 }),
    acknowledgementKey: KEY,
    fingerprint,
    nonceCurrent,
    acknowledged: true,
  })

  it('renders N/N and reads complete when every network passed and was reviewed', () => {
    const rollups = rollUpByChange(
      Array.from({ length: 57 }, (_, i) => outcome(i + 1, true))
    )

    expect(rollups[0]?.networks).toBe(57)
    expect(rollups[0]?.noncesUsable).toBe(57)
    expect(rollups[0]?.complete).toBe(true)
    expect(renderChangeRollup(rollups)[0]).toContain('57/57')
    expect(renderChangeRollup(rollups)[0]?.startsWith('✓')).toBe(true)
  })

  it('cannot render 56/57 as complete', () => {
    const rollups = rollUpByChange(
      Array.from({ length: 57 }, (_, i) => outcome(i + 1, i !== 56))
    )
    const line = renderChangeRollup(rollups)[0] ?? ''

    expect(rollups[0]?.noncesUsable).toBe(56)
    expect(rollups[0]?.networks).toBe(57)
    expect(rollups[0]?.complete).toBe(false)
    expect(rollups[0]?.staleNetworks).toEqual(['net-57'])
    expect(line).toContain('56/57')
    expect(line).toContain('stale nonce on net-57')
    expect(line.startsWith('✗')).toBe(true)
  })

  it('is not complete when a network was never reviewed, even with every nonce usable', () => {
    const rollups = rollUpByChange([
      outcome(1, true),
      { ...outcome(2, true), acknowledged: false },
    ])
    const line = renderChangeRollup(rollups)[0] ?? ''

    expect(rollups[0]?.noncesUsable).toBe(2)
    expect(rollups[0]?.acknowledged).toBe(1)
    expect(rollups[0]?.complete).toBe(false)
    expect(line.startsWith('✗')).toBe(true)
    expect(line).toContain('reviewed 1/2')
  })

  it('counts one network once even if it is revisited', () => {
    expect(
      rollUpByChange([outcome(1, true), outcome(1, true)])[0]?.networks
    ).toBe(1)
  })

  it('lets a later entry for the same proposal supersede the provisional one', () => {
    const rollups = rollUpByChange([
      { ...outcome(1, true), acknowledged: false },
      { ...outcome(1, true), acknowledged: true },
    ])

    expect(rollups[0]?.networks).toBe(1)
    expect(rollups[0]?.acknowledged).toBe(1)
  })

  it('keeps distinct effects in distinct rollups', () => {
    const other: INetworkOutcome = {
      ...outcome(1, true),
      acknowledgementKey: effectKey(DIAMOND_B, fingerprint),
    }

    expect(rollUpByChange([outcome(1, true), other]).length).toBe(2)
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
