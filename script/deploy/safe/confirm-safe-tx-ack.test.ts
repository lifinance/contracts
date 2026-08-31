import { readFileSync } from 'fs'
import { join } from 'path'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import {
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
 * Builds the real `diamondCut` calldata a facet update proposes: the facet
 * address and selectors from `deployments/<network>.json`, and the init payload
 * a network's own config produces.
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
  if (!entry) throw new Error(`config/optimism.json has no ${network} entry`)

  return encodeFunctionData({
    abi: ABI_INIT_OPTIMISM,
    functionName: 'initOptimism',
    args: [
      entry.tokens.map((t) => ({ assetId: t.assetId, bridge: t.bridge })),
      entry.standardBridge,
    ],
  })
}

const deployedAddress = (network: string, contract: string): Address => {
  const record = readJson(`deployments/${network}.json`) as unknown as Record<
    string,
    Address
  >
  const address = record[contract]
  if (!address)
    throw new Error(`deployments/${network}.json has no ${contract}`)

  return address
}

const DIAMOND: Address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const ZERO: Address = '0x0000000000000000000000000000000000000000'

describe('computeChangeFingerprint', () => {
  it('is keccak of the full calldata, not a semantic label', () => {
    // Same facet, same selectors, same version label — only the per-network
    // init payload differs. A `facet+version+selectors` label collapses these.
    const facet = deployedAddress('mainnet', 'OptimismBridgeFacet')
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

  it('collapses a byte-identical cut across networks to one fingerprint', () => {
    // CelerCircleBridgeFacet is CREATE3-deterministic and has no init payload,
    // so the proposed bytes are identical on every network it is cut into.
    const onArbitrum = deployedAddress('arbitrum', 'CelerCircleBridgeFacet')
    const onBase = deployedAddress('base', 'CelerCircleBridgeFacet')
    expect(onArbitrum).toBe(onBase)

    const selectors: Hex[] = ['0x2e2fb18b']
    const arbitrumCut = buildDiamondCutCalldata(
      onArbitrum,
      selectors,
      ZERO,
      '0x'
    )
    const baseCut = buildDiamondCutCalldata(onBase, selectors, ZERO, '0x')

    expect(arbitrumCut).toBe(baseCut)
    expect(computeChangeFingerprint(arbitrumCut)).toBe(
      computeChangeFingerprint(baseCut)
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
    const key = buildProposalKey({ to: DIAMOND, chainId: 42161, nonce: 7 })
    expect(key).toContain(DIAMOND.toLowerCase())
    expect(key).toContain('42161')
    expect(key).toContain('7')
  })

  it('never collapses two networks carrying byte-identical calldata', () => {
    const a = buildProposalKey({ to: DIAMOND, chainId: 42161, nonce: 7 })
    const b = buildProposalKey({ to: DIAMOND, chainId: 8453, nonce: 7 })
    expect(a).not.toBe(b)
  })

  it('never collapses two nonces on the same Safe', () => {
    expect(buildProposalKey({ to: DIAMOND, chainId: 1, nonce: 7 })).not.toBe(
      buildProposalKey({ to: DIAMOND, chainId: 1, nonce: 8 })
    )
  })

  it('is case-insensitive on the target address', () => {
    expect(
      buildProposalKey({ to: DIAMOND.toUpperCase(), chainId: 1, nonce: 1 })
    ).toBe(
      buildProposalKey({ to: DIAMOND.toLowerCase(), chainId: 1, nonce: 1 })
    )
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
  it('prompts the first time a change is seen', () => {
    expect(
      shouldPromptForAcknowledgement({
        alreadyAcknowledged: false,
        integrityOk: true,
      })
    ).toBe(true)
  })

  it('does not re-prompt for a change already acknowledged this run', () => {
    expect(
      shouldPromptForAcknowledgement({
        alreadyAcknowledged: true,
        integrityOk: true,
      })
    ).toBe(false)
  })

  it('always re-prompts when integrity failed, even if acknowledged', () => {
    expect(
      shouldPromptForAcknowledgement({
        alreadyAcknowledged: true,
        integrityOk: false,
      })
    ).toBe(true)
  })
})

describe('acknowledgement ledger', () => {
  const FINGERPRINT = computeChangeFingerprint('0xdeadbeef')

  it('records and reports an acknowledgement', () => {
    const ledger = createAcknowledgementLedger()
    expect(isChangeAcknowledged(ledger, FINGERPRINT)).toBe(false)

    const recorded = recordAcknowledgement(ledger, {
      fingerprint: FINGERPRINT,
      proposalKey: buildProposalKey({ to: DIAMOND, chainId: 1, nonce: 1 }),
      integrityOk: true,
    })

    expect(recorded).toBe(true)
    expect(isChangeAcknowledged(ledger, FINGERPRINT)).toBe(true)
  })

  it('never acknowledges a proposal that failed integrity', () => {
    const ledger = createAcknowledgementLedger()
    const recorded = recordAcknowledgement(ledger, {
      fingerprint: FINGERPRINT,
      proposalKey: buildProposalKey({ to: DIAMOND, chainId: 1, nonce: 1 }),
      integrityOk: false,
    })

    expect(recorded).toBe(false)
    expect(isChangeAcknowledged(ledger, FINGERPRINT)).toBe(false)
  })

  it('does not leak an acknowledgement to a different change', () => {
    const ledger = createAcknowledgementLedger()
    recordAcknowledgement(ledger, {
      fingerprint: FINGERPRINT,
      proposalKey: buildProposalKey({ to: DIAMOND, chainId: 1, nonce: 1 }),
      integrityOk: true,
    })

    expect(
      isChangeAcknowledged(ledger, computeChangeFingerprint('0xc0ffee'))
    ).toBe(false)
  })

  it('stores no action — the ledger exposes no action field', () => {
    const ledger = createAcknowledgementLedger()
    recordAcknowledgement(ledger, {
      fingerprint: FINGERPRINT,
      proposalKey: buildProposalKey({ to: DIAMOND, chainId: 1, nonce: 1 }),
      integrityOk: true,
    })

    expect(JSON.stringify(ledger)).not.toContain('Execute')
    expect(JSON.stringify(ledger)).not.toContain('Sign')
  })
})

describe('rollUpByChange', () => {
  const FINGERPRINT = computeChangeFingerprint('0xdeadbeef')

  const outcome = (
    chainId: number,
    checksPassed: boolean
  ): INetworkOutcome => ({
    network: `net-${chainId}`,
    proposalKey: buildProposalKey({ to: DIAMOND, chainId, nonce: 1 }),
    fingerprint: FINGERPRINT,
    checksPassed,
    acknowledged: true,
  })

  it('renders N/N and reads green when every network passed', () => {
    const outcomes = Array.from({ length: 57 }, (_, i) => outcome(i + 1, true))
    const rollups = rollUpByChange(outcomes)

    expect(rollups[0]?.networks).toBe(57)
    expect(rollups[0]?.checksPassed).toBe(57)
    expect(rollups[0]?.green).toBe(true)
    expect(renderChangeRollup(rollups).join('\n')).toContain('57/57')
  })

  it('cannot render 56/57 as green', () => {
    const outcomes = Array.from({ length: 57 }, (_, i) =>
      outcome(i + 1, i !== 56)
    )
    const rollups = rollUpByChange(outcomes)
    const rendered = renderChangeRollup(rollups).join('\n')

    expect(rollups[0]?.checksPassed).toBe(56)
    expect(rollups[0]?.networks).toBe(57)
    expect(rollups[0]?.green).toBe(false)
    expect(rendered).toContain('56/57')
    expect(rendered).not.toContain('✓')
    expect(rendered).toContain('✗')
    expect(rollups[0]?.failedNetworks).toEqual(['net-57'])
    expect(rendered).toContain('failed on net-57')
  })

  it('counts one network once even if it is revisited', () => {
    const [rollup] = rollUpByChange([outcome(1, true), outcome(1, true)])
    expect(rollup?.networks).toBe(1)
  })

  it('keeps distinct changes in distinct rollups', () => {
    const other: INetworkOutcome = {
      ...outcome(1, true),
      fingerprint: computeChangeFingerprint('0xc0ffee'),
    }
    expect(rollUpByChange([outcome(1, true), other]).length).toBe(2)
  })

  it('reports the acknowledgement roll-up separately from the check count', () => {
    const outcomes = [
      { ...outcome(1, true), acknowledged: true },
      { ...outcome(2, true), acknowledged: false },
    ]
    const [rollup] = rollUpByChange(outcomes)

    expect(rollup?.acknowledged).toBe(1)
    expect(rollup?.checksPassed).toBe(2)
  })
})

describe('confirm-safe-tx.ts carries no action cache', () => {
  const source = readFileSync(
    join(import.meta.dir, 'confirm-safe-tx.ts'),
    'utf8'
  )

  // Matched against the source rather than behaviour: the loop is interactive,
  // so nothing else stops a future edit from reintroducing the replay.
  const offendingLines = (pattern: RegExp): string[] =>
    source.split('\n').filter((line) => pattern.test(line))

  it('has no calldata-keyed response cache', () => {
    expect(offendingLines(/storedResponses/)).toEqual([])
  })

  it('prompts for the action rather than reading a remembered one', () => {
    const collapsed = source.replace(/\s+/g, ' ')
    const fallback = collapsed.match(
      /action = [^;]{0,40}\|\| \(?await consola\.prompt/
    )
    expect(fallback?.[0] ?? null).toBeNull()
  })

  it('assigns no action into a cache', () => {
    expect(offendingLines(/\w+\[[^\]]*\]\s*=\s*action\s*$/)).toEqual([])
  })
})
