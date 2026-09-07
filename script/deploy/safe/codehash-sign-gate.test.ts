/**
 * The sign-time codehash gate as `confirm-safe-tx.ts` consumes it: the decode,
 * the verdict, how it renders, and the funnel that refuses.
 *
 * The placement assertions here are run, not read. A gate that refuses
 * everything passes a suite that only ever checks the refusal, so both
 * directions are driven against a spy: the signature must not be reached when
 * the gate blocks, and must be reached when it does not.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { encodeFunctionData, getAddress, type Hex } from 'viem'

import type { IAttestedBuild, IObservedCode } from '../codehash/attested-set'
import { FacetCutActionEnum } from '../codehash/cut-classification'
import type { IVerifyCutDeps } from '../codehash/verify-cut-targets'

import {
  assertCodehashSignGateAllowsSigning,
  blockingUnevaluatedGate,
  createGatedSigner,
  evaluateCodehashSignGate,
  renderCodehashSignGate,
  unevaluatedCodehashSignGate,
} from './codehash-sign-gate'
import { ABI_DIAMOND_CUT } from './safe-decode-utils'
import { TIMELOCK_SCHEDULE_BATCH_ABI } from './timelock-abi'

const FACET = '0x1111111111111111111111111111111111111111'
const DIAMOND = '0x4444444444444444444444444444444444444444'
const ZERO = '0x0000000000000000000000000000000000000000'
const OTHER = '0x2222222222222222222222222222222222222222'
const NETWORK = 'mainnet'

const MASKED = `0x${'ab'.repeat(32)}`
const RAW = `0x${'cd'.repeat(32)}`

const observed = (over: Partial<IObservedCode> = {}): IObservedCode => ({
  maskedHash: MASKED,
  rawHash: RAW,
  rawByteLength: 1440,
  maskedByteCount: 0,
  ...over,
})

const attested = (over: Partial<IAttestedBuild> = {}): IAttestedBuild => ({
  lineage:
    'AcrossFacet@1.0.0 rebuilt at abc123def (default: solc 0.8.29, cancun)',
  solcVersion: '0.8.29',
  maskedHash: MASKED,
  rawByteLength: 1440,
  rawHash: undefined,
  ...over,
})

const cutCalldata = (facet = FACET, action = FacetCutActionEnum.Add): Hex =>
  encodeFunctionData({
    abi: ABI_DIAMOND_CUT,
    functionName: 'diamondCut',
    args: [
      [[facet as `0x${string}`, action, ['0xaabbccdd']]] as never,
      ZERO as `0x${string}`,
      '0x',
    ],
  })

const wrapped = (payloads: Hex[]): Hex =>
  encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      payloads.map(() => DIAMOND as `0x${string}`),
      payloads.map(() => 0n),
      payloads,
      `0x${'00'.repeat(32)}` as Hex,
      `0x${'11'.repeat(32)}` as Hex,
      86_400n,
    ],
  })

const deps = (over: Partial<IVerifyCutDeps> = {}): IVerifyCutDeps => ({
  scope: () => ({ isClosedSet: true }),
  observe: async () => observed(),
  attestationsFor: async () => [attested()],
  ...over,
})

/** The verdict glyph a rendered bucket leads with. */
const glyph = (rendered: string): string => {
  const found = /[✓✗?!⚠]/.exec(rendered)
  return found?.[0] ?? ''
}

/** The ANSI colour a rendered bucket uses. */
const colour = (rendered: string): string => {
  const after = rendered.split(`${String.fromCharCode(27)}[`)[1] ?? ''
  return /^(\d+)m/.exec(after)?.[1] ?? ''
}

/** The message a rejected promise carried, or '' when it resolved. */
const rejection = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise
    return ''
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('evaluateCodehashSignGate', () => {
  it('does not block a proposal that carries no diamondCut', async () => {
    const gate = await evaluateCodehashSignGate(
      { data: '0x', network: NETWORK },
      deps()
    )

    expect(gate.blocksSigning).toBe(false)
    expect(gate.evaluated).toBe(false)
    expect(gate.targets).toEqual([])
  })

  it('passes a cut whose target matches an attested build', async () => {
    const gate = await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata()]), network: NETWORK },
      deps()
    )

    expect(gate.evaluated).toBe(true)
    expect(gate.blocksSigning).toBe(false)
    expect(gate.targets.map((t) => t.verdict)).toEqual(['MATCH'])
    expect(gate.targets[0]?.address).toBe(getAddress(FACET))
  })

  it('blocks a cut whose target matches nothing attested', async () => {
    const gate = await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata()]), network: NETWORK },
      deps({
        attestationsFor: async () => [
          attested({ maskedHash: `0x${'99'.repeat(32)}` }),
        ],
      })
    )

    expect(gate.blocksSigning).toBe(true)
    expect(gate.targets.map((t) => t.verdict)).toEqual(['MISMATCH'])
  })

  it('blocks with UNVERIFIABLE when the attestation lookup fails', async () => {
    const gate = await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata()]), network: NETWORK },
      deps({
        attestationsFor: async () => {
          throw new Error('the deployment record could not be read')
        },
      })
    )

    expect(gate.blocksSigning).toBe(true)
    expect(gate.targets.map((t) => t.verdict)).toEqual(['UNVERIFIABLE'])
  })

  it('blocks when the scope itself cannot be established', async () => {
    const gate = await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata()]), network: 'notanetwork' },
      deps({
        scope: () => {
          throw new Error('not in config/networks.json')
        },
      })
    )

    expect(gate.blocksSigning).toBe(true)
    expect(gate.summary).toContain('not in config/networks.json')
  })

  it('carries the decoder refusal through instead of reporting no cut', async () => {
    const hidden = `0xdeadc0de${cutCalldata().slice(2)}` as Hex

    const gate = await evaluateCodehashSignGate(
      { data: hidden, network: NETWORK },
      deps()
    )

    expect(gate.blocksSigning).toBe(true)
    expect(gate.evaluated).toBe(true)
    expect(gate.refusals[0]).toContain('could not open')
  })

  it('judges every cut in a batch, not only the first', async () => {
    const other = OTHER
    const gate = await evaluateCodehashSignGate(
      {
        data: wrapped([cutCalldata(), cutCalldata(other)]),
        network: NETWORK,
      },
      deps({
        observe: async (address) =>
          address.toLowerCase() === other.toLowerCase()
            ? observed({ maskedHash: `0x${'77'.repeat(32)}` })
            : observed(),
      })
    )

    expect(gate.targets.map((t) => [t.address, t.verdict])).toEqual([
      [getAddress(FACET), 'MATCH'],
      [getAddress(other), 'MISMATCH'],
    ])
    expect(gate.blocksSigning).toBe(true)
  })

  it('reads the one value it was handed, so two evaluations cannot diverge', async () => {
    const data = wrapped([cutCalldata()])
    const seen: string[] = []
    const recording = deps({
      observe: async (address) => {
        seen.push(address)
        return observed()
      },
    })

    const first = await evaluateCodehashSignGate(
      { data, network: NETWORK },
      recording
    )
    const second = await evaluateCodehashSignGate(
      { data, network: NETWORK },
      recording
    )

    expect(second).toEqual(first)
    expect(seen).toEqual([getAddress(FACET), getAddress(FACET)])
    // Non-vacuous: a different value must reach a different address, so the
    // equality above is a property of the input rather than of a cached answer.
    await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata(OTHER)]), network: NETWORK },
      recording
    )
    expect(seen[2]).toBe(getAddress(OTHER))
  })

  it('carries the excluded immutable bytes through, and they block', async () => {
    // `verifyCutTargets` grades a hash match with masked bytes UNVERIFIABLE
    // until layer 2 checks their values, so the count has to survive the wiring
    // for the display to be able to say what was not compared.
    const gate = await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata()]), network: NETWORK },
      deps({ observe: async () => observed({ maskedByteCount: 128 }) })
    )

    expect(gate.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(gate.targets[0]?.excludedByteCount).toBe(128)
    expect(gate.blocksSigning).toBe(true)
  })
})

describe('renderCodehashSignGate', () => {
  const render = async (over: Partial<IVerifyCutDeps>): Promise<string> =>
    renderCodehashSignGate(
      await evaluateCodehashSignGate(
        { data: wrapped([cutCalldata()]), network: NETWORK },
        deps(over)
      )
    ).join('\n')

  it('renders MATCH, MISMATCH and UNVERIFIABLE as three distinct buckets', async () => {
    const match = await render({})
    const mismatch = await render({
      attestationsFor: async () => [
        attested({ maskedHash: `0x${'99'.repeat(32)}` }),
      ],
    })
    const unverifiable = await render({
      attestationsFor: async () => {
        throw new Error('record unreadable')
      },
    })

    expect(match).toContain('MATCH')
    expect(mismatch).toContain('MISMATCH')
    expect(unverifiable).toContain('UNVERIFIABLE')
    // No two of the three share a glyph and a colour, so a grey cannot read as
    // a red. Paired with the presence assertions above: a rendering that
    // printed nothing at all would fail those.
    const marks = [match, mismatch, unverifiable].map(
      (rendered) => `${glyph(rendered)}|${colour(rendered)}`
    )
    expect(marks.every((mark) => mark !== '|')).toBe(true)
    expect(new Set(marks).size).toBe(3)
  })

  it('renders nothing when the proposal carries no cut', () => {
    expect(renderCodehashSignGate(unevaluatedCodehashSignGate())).toEqual([])
  })

  it('names the excluded immutable bytes that were not compared', async () => {
    const rendered = await render({
      observe: async () => observed({ maskedByteCount: 96 }),
    })

    expect(rendered).toContain('96')
    expect(rendered.toLowerCase()).toContain('immutable')
  })

  it('does not claim excluded bytes on a match that compared every byte', async () => {
    expect((await render({})).toLowerCase()).not.toContain('immutable')
  })
})

describe('the render distinguishes every bucket, including the two that are not verdicts', () => {
  /**
   * Strips everything but the colour code and the glyph. Built from
   * `String.fromCharCode` rather than an escape in a literal regex, because a
   * control character inside one trips `no-control-regex`.
   */
  const ESC = String.fromCharCode(27)
  const marks = (lines: string[]): string[] =>
    lines
      .map((line) => new RegExp(`${ESC}\\[(\\d+)m(\\S+)`).exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[1]}|${m[2]}`)

  it('never renders "no cut found" as a green tick', () => {
    // The fail-open this closes: an envelope the decoder could not open produced
    // no cut and no refusal, and that was printed as `✓ MATCH` — an affirmative
    // claim about bytes nobody read. "We found no cut" and "we checked the cut
    // and it is clean" must not look the same to someone skimming glyphs.
    const lines = renderCodehashSignGate({
      blocksSigning: false,
      evaluated: true,
      refusals: [],
      targets: [],
      madeNoClaim: true,
      summary: 'No diamondCut was decoded from this calldata',
    })

    expect(lines.join('\n')).not.toContain('MATCH')
    expect(marks(lines)).not.toContain('32|✓')
    expect(lines.join('\n')).toContain('NO CLAIM')
  })

  it('still renders a verified match as a green tick, so the rule is not blanket', () => {
    // The paired positive. Without it "never green" could be satisfied by never
    // rendering green at all, which would pass while making MATCH unreadable.
    const lines = renderCodehashSignGate({
      blocksSigning: false,
      evaluated: true,
      refusals: [],
      targets: [
        {
          address: FACET,
          verdict: 'MATCH',
          reason: 'matches an attested build',
          matchedLineages: ['main@abc1234'],
          excludedByteCount: 0,
        },
      ],
      summary: 'ok',
    })

    expect(marks(lines)).toContain('32|✓')
  })

  it('gives REFUSED a different glyph from MISMATCH, both being red', () => {
    // The file states the rule itself: no two buckets may be distinguishable by
    // only one of word, glyph and colour. Its own renderer broke it.
    const refused = renderCodehashSignGate({
      blocksSigning: true,
      evaluated: true,
      refusals: ['a removal-only cut carries an _init'],
      targets: [],
      summary: 'refused',
    })
    const mismatched = renderCodehashSignGate({
      blocksSigning: true,
      evaluated: true,
      refusals: [],
      targets: [
        {
          address: FACET,
          verdict: 'MISMATCH',
          reason: 'does not match',
          matchedLineages: [],
          excludedByteCount: 0,
        },
      ],
      summary: 'mismatch',
    })

    const refusedMark = marks(refused)[0]
    const mismatchMark = marks(mismatched)[0]
    expect(refusedMark).toBeDefined()
    expect(mismatchMark).toBeDefined()
    expect(refusedMark).not.toBe(mismatchMark)
  })

  it('names the frames it could not open, rather than only saying no cut', async () => {
    // An envelope whose calldata does not happen to carry the cut selector: the
    // decoder cannot open it, finds no cut, and previously said so as a green
    // pass. It must now name what it could not read.
    const gate = await evaluateCodehashSignGate(
      { data: '0xdeadbeef00000000', network: NETWORK },
      deps()
    )

    expect(gate.summary).toContain('0xdeadbeef')
    expect(gate.summary).toMatch(/could not open/)
    expect(gate.madeNoClaim).toBe(true)
  })

  it('does not claim an unopened frame for an ordinary decodable cut', async () => {
    // Paired positive: a proposal it fully read must not be described as
    // unopened, or the message above becomes noise on every proposal.
    const gate = await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata()]), network: NETWORK },
      deps()
    )

    expect(gate.summary).not.toMatch(/could not open/)
    expect(gate.madeNoClaim).toBeUndefined()
  })
})

describe('the sign funnel', () => {
  const blockingGate = blockingUnevaluatedGate()
  const passingGate = { ...blockingGate, blocksSigning: false }

  it('never reaches the signature when the gate blocks', async () => {
    const calls: string[] = []
    const sign = createGatedSigner<[string], string>({
      gate: () => blockingGate,
      sign: async (tx) => {
        calls.push(tx)
        return tx
      },
    })

    expect(await rejection(sign('tx'))).toContain('will not be signed')
    expect(calls).toEqual([])
  })

  it('reaches the signature when the gate does not block', async () => {
    const calls: string[] = []
    const sign = createGatedSigner<[string], string>({
      gate: () => passingGate,
      sign: async (tx) => {
        calls.push(tx)
        return `signed:${tx}`
      },
    })

    expect(await sign('tx')).toBe('signed:tx')
    expect(calls).toEqual(['tx'])
  })

  it('refuses before the signature even when the signature would also fail', async () => {
    const calls: string[] = []
    const sign = createGatedSigner<[string], string>({
      gate: () => blockingGate,
      sign: async () => {
        calls.push('reached')
        throw new Error('the device was not connected')
      },
    })

    expect(await rejection(sign('tx'))).toContain('will not be signed')
    expect(calls).toEqual([])
  })
})

describe('assertCodehashSignGateAllowsSigning', () => {
  it('names the refusals and the per-address verdicts it refused on', async () => {
    const gate = await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata()]), network: NETWORK },
      deps({
        attestationsFor: async () => [
          attested({ maskedHash: `0x${'99'.repeat(32)}` }),
        ],
      })
    )

    let thrown = ''
    try {
      assertCodehashSignGateAllowsSigning(gate)
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }

    expect(thrown).toContain(getAddress(FACET))
    expect(thrown).toContain('MISMATCH')
  })

  it('returns quietly for a gate that did not block', async () => {
    const gate = await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata()]), network: NETWORK },
      deps()
    )

    expect(() => assertCodehashSignGateAllowsSigning(gate)).not.toThrow()
  })

  it('refuses the state a proposal starts in', () => {
    // The real default, not a hand-built stand-in: flip its `blocksSigning` to
    // false and this is the assertion that catches it.
    expect(blockingUnevaluatedGate().blocksSigning).toBe(true)
    expect(() =>
      assertCodehashSignGateAllowsSigning(blockingUnevaluatedGate())
    ).toThrow(/did not run/)
  })

  it('says why on screen rather than refusing silently', () => {
    const rendered = renderCodehashSignGate(blockingUnevaluatedGate()).join(
      '\n'
    )

    // Paired with the no-cut case below, which renders nothing at all: a
    // blocking gate that printed nothing would leave the refusal unexplained.
    expect(rendered).toContain('REFUSED')
    expect(rendered).toContain('did not run')
    expect(renderCodehashSignGate(unevaluatedCodehashSignGate())).toEqual([])
  })
})
