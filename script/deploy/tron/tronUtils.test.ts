import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  parseTronAddressOutput,
  parseTroncastArrayOutput,
  sendGuardedDiamondCut,
} from './tronUtils'

describe('parseTronAddressOutput', () => {
  const ADDR = 'TDCo8wrqwRVC7HaRAAsuCdbnS4AdAdtcn9'

  it('returns a bare address unchanged', () => {
    expect(parseTronAddressOutput(ADDR)).toBe(ADDR)
  })

  it('trims surrounding whitespace and quotes', () => {
    expect(parseTronAddressOutput(`  "${ADDR}"\n`)).toBe(ADDR)
  })

  // Regression: callTronContract prepends TronWeb's diagnostic lines to the return value.
  // Trimming the whole blob left it starting with the first diagnostic line, so every
  // "does this look like a T... address" test failed and the caller reported the contract as
  // unregistered — four false failures on tron's periphery-registered invariant, while the
  // registry actually held the correct addresses.
  it('extracts the address from output preceded by TronWeb diagnostics', () => {
    const output = [
      // RPC URL intentionally a placeholder: a real endpoint here would match an .env
      // value and trip the pre-commit secret scanner.
      '⚙ Initializing TronWeb with mainnet network: <rpc-url>',
      '⚙ Calling getPeripheryContract on TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt',
      '⚙ Parsing param 0: ERC20Proxy as string',
      "⚙ Formatted params: [ 'ERC20Proxy' ]",
      '⚙ Function signature: getPeripheryContract(string)',
      ADDR,
    ].join('\n')
    expect(parseTronAddressOutput(output)).toBe(ADDR)
  })

  it('ignores trailing blank lines after the address', () => {
    expect(parseTronAddressOutput(`⚙ Calling foo\n${ADDR}\n\n`)).toBe(ADDR)
  })

  it('returns an empty string when there is no non-diagnostic line', () => {
    expect(
      parseTronAddressOutput('⚙ Initializing TronWeb\n⚙ Calling foo')
    ).toBe('')
  })

  it('returns an empty string for empty input', () => {
    expect(parseTronAddressOutput('')).toBe('')
  })
})

describe('parseTroncastArrayOutput', () => {
  // Regression: getAllContractSelectorPairs() returns `address[],bytes4[][]`. callTronContract
  // prepends the troncast command echo (`$ bun run …`) and TronWeb's diagnostic lines — one of
  // which, "⚙ Formatted params: []", itself contains a `[`. The old parser trimmed the whole
  // blob and required it to start with `[`; it started with `$ bun run …` instead, so it threw
  // "Expected array format" and the whitelist-integrity invariant reported the swallowed
  // "Whitelist configuration not available" on tron. This is the real captured mainnet output.
  const REAL_OUTPUT = [
    '$ bun run script/troncast/index.ts call "TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt" "getAllContractSelectorPairs() returns (address[],bytes4[][])" --rpc-url <rpc-url>',
    '⚙ Initializing TronWeb with mainnet network: <rpc-url>',
    '⚙ Calling getAllContractSelectorPairs on TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt',
    '⚙ Formatted params: []',
    '⚙ Function signature: getAllContractSelectorPairs()',
    '[[TBfUqkmaBBMFA87ZCCu9aibjo2EZLTSJv2 TA7qd9KpEBH7qASAxxUpjWVfE3GiTwpd7q] [[0x3ccfd60b 0xd0e30db0] [0xe0cbc5f2 0xeedd56e1]]]',
  ].join('\n')

  it('parses the address[],bytes4[][] payload past the echo and diagnostic lines', () => {
    const parsed = parseTroncastArrayOutput(REAL_OUTPUT)
    expect(parsed).toEqual([
      [
        'TBfUqkmaBBMFA87ZCCu9aibjo2EZLTSJv2',
        'TA7qd9KpEBH7qASAxxUpjWVfE3GiTwpd7q',
      ],
      [
        ['0x3ccfd60b', '0xd0e30db0'],
        ['0xe0cbc5f2', '0xeedd56e1'],
      ],
    ])
  })

  it('does not mistake the "[" inside "⚙ Formatted params: []" for the payload start', () => {
    // If the diagnostic line were not stripped, the first `[` in the blob would be the empty
    // params array, and the parser would return `[]` instead of the real pairs.
    const parsed = parseTroncastArrayOutput(REAL_OUTPUT)
    expect((parsed[0] as unknown[]).length).toBe(2)
  })

  it('parses a bare bracketed payload with no diagnostics', () => {
    expect(parseTroncastArrayOutput('[[TAbc] [[0x11111111]]]')).toEqual([
      ['TAbc'],
      [['0x11111111']],
    ])
  })

  it('handles an empty on-chain result (no whitelisted pairs)', () => {
    const output = ['⚙ Initializing TronWeb', '[[] []]'].join('\n')
    expect(parseTroncastArrayOutput(output)).toEqual([[], []])
  })

  it('throws when no bracketed payload is present after stripping diagnostics', () => {
    expect(() =>
      parseTroncastArrayOutput('⚙ Initializing TronWeb\n⚙ Calling foo')
    ).toThrow('Expected array format')
  })

  it('throws on empty input', () => {
    expect(() => parseTroncastArrayOutput('')).toThrow('Expected array format')
  })
})

/**
 * The diamondCut send in `registerFacetToDiamond`: an estimate the 5000 TRX fee
 * limit cannot pay for stops the broadcast, an affordable one reaches it. Every
 * case is a spy over the broadcast, since a thrown error alone does not show
 * the send was skipped.
 */
describe('sendGuardedDiamondCut', () => {
  const DIAMOND = 'TAuErcuAtU6BPt6YwL51JZ4RpDCPQASCU2'
  const FACET = 'TVQY5uYUJHqPJ3kmpKcQmiRcaEbGvJYVfR'
  const FULL_HOST = 'https://tron.invalid'
  /** 100 SUN per energy: the 5000 TRX limit buys 50,000,000 energy. */
  const SUN_PER_ENERGY = 100
  /**
   * `estimateDiamondCutEnergy` multiplies by `DIAMOND_CUT_ENERGY_MULTIPLIER`
   * (10), so 20,000 raw becomes 200,000 energy — 20,000,000 SUN, well inside
   * the limit. 6,000,000 raw becomes 60,000,000 energy, which is not.
   */
  const AFFORDABLE_ENERGY_USED = 20_000
  const UNAFFORDABLE_ENERGY_USED = 6_000_000

  let sends: unknown[]
  let energyUsed: number | null
  let energyPrices: string
  let estimateRequests: number

  const facetCuts = [[FACET, 0, ['0x12345678']]]

  const tronWebStub = {
    utils: { abi: { encodeParams: (): string => '0xabcd' } },
    trx: { getEnergyPrices: async (): Promise<string> => energyPrices },
    defaultAddress: { base58: DIAMOND },
  }

  const diamondStub = {
    diamondCut: (...args: unknown[]) => ({
      send: async (): Promise<string> => {
        sends.push(args)
        return 'deadbeef'
      },
    }),
  }

  const call = (): Promise<string> =>
    sendGuardedDiamondCut({
      tronWeb: tronWebStub,
      diamond: diamondStub,
      network: 'tron',
      facetName: 'OwnershipFacet',
      diamondAddress: DIAMOND,
      facetCuts,
      fullHost: FULL_HOST,
    })

  /**
   * Awaited, so the spy assertion that follows observes a settled call rather
   * than one that has not started yet.
   */
  const refusal = (): Promise<Error | undefined> =>
    call().then(
      () => undefined,
      (error: unknown) => error as Error
    )

  /** Answers the devkit's estimate request; any other URL is a test bug. */
  const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
    const target = String(url)
    if (!target.includes('/wallet/triggerconstantcontract'))
      throw new Error(`unexpected fetch to ${target}`)

    estimateRequests += 1
    return new Response(
      JSON.stringify(
        energyUsed === null
          ? { result: { result: false, message: 'REVERT' } }
          : { result: { result: true }, energy_used: energyUsed }
      ),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }

  let originalFetch: typeof globalThis.fetch
  let originalAllow: string | undefined

  beforeEach(() => {
    sends = []
    estimateRequests = 0
    energyUsed = AFFORDABLE_ENERGY_USED
    energyPrices = `1:${SUN_PER_ENERGY}`
    originalAllow = process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    originalFetch = globalThis.fetch
    globalThis.fetch = fakeFetch as unknown as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalAllow === undefined)
      delete process.env.ALLOW_GAS_ESTIMATE_FALLBACK
    else process.env.ALLOW_GAS_ESTIMATE_FALLBACK = originalAllow
  })

  it('broadcasts when the estimate fits the fee limit', async () => {
    expect(await call()).toBe('deadbeef')
    expect(estimateRequests).toBeGreaterThan(0)
    expect(sends).toHaveLength(1)
  })

  it('never reaches the send when estimation fails', async () => {
    energyUsed = null

    const error = await refusal()

    expect(error?.message).toMatch(/refusing to broadcast/)
    expect(estimateRequests).toBeGreaterThan(0)
    expect(sends).toEqual([])
  })

  it('never reaches the send when the estimate exceeds the fee limit', async () => {
    energyUsed = UNAFFORDABLE_ENERGY_USED

    const error = await refusal()

    expect(error?.message).toMatch(/exceeds the fee limit/)
    expect(sends).toEqual([])
  })

  it('never reaches the send when the energy price is unreadable', async () => {
    energyPrices = ''

    const error = await refusal()

    expect(error?.message).toMatch(/Could not price/)
    expect(sends).toEqual([])
  })

  it('names the network and the facet in the refusal', async () => {
    energyUsed = null

    const error = await refusal()

    expect(error?.message).toMatch(/on tron .*OwnershipFacet/)
  })

  it('broadcasts on a failed estimate when the escape hatch names the network', async () => {
    energyUsed = null
    process.env.ALLOW_GAS_ESTIMATE_FALLBACK = 'tron'

    expect(await call()).toBe('deadbeef')
    expect(sends).toHaveLength(1)
  })
})
