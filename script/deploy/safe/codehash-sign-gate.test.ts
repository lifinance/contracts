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
  gateInputFor,
  type ICodehashGateInput,
  proposalKeyOf,
  blockingUnevaluatedGate,
  createGatedSigner,
  evaluateCodehashSignGate,
  renderCodehashSignGate,
  unevaluatedCodehashSignGate,
} from './codehash-sign-gate'
import { ABI_DIAMOND_CUT } from './safe-decode-utils'
import {
  initializeSafeTransaction,
  type ISafeTxDocument,
  type ISignedSafeTransaction,
  type SafeClient,
} from './safe-utils'
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
  provenance: 'A-LOCAL',
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

/**
 * A struct produced by the real `initializeSafeTransaction`, so it is in the
 * WeakSet that `isSignedStruct` consults.
 *
 * There is deliberately no registrar to call instead: the only way to obtain a
 * member is to go through the one function that makes them, which is what stops
 * a forged struct being a one-line test helper away.
 * @param data - the calldata the signature would cover
 * @returns The struct Safe would hash and sign
 */
const signedStruct = async (
  data?: string,
  over: { to?: string; nonce?: number; operation?: number } = {}
): Promise<ISignedSafeTransaction> =>
  initializeSafeTransaction(
    {
      network: 'mainnet',
      safeTx: {
        data: {
          to: over.to ?? DIAMOND,
          value: '0',
          data,
          operation: over.operation ?? 0,
          nonce: over.nonce ?? 7,
        },
        signatures: new Map(),
      },
    } as unknown as ISafeTxDocument,
    {
      createTransaction: async (options: {
        transactions: { to: string; value: string; data?: string }[]
      }) => ({ data: options.transactions[0], signatures: new Map() }),
    } as unknown as SafeClient
  )

/**
 * The gate's input, built the only way it can be.
 * @param data - calldata of the transaction that would be signed
 * @param network - `config/networks.json` key
 * @returns An `ICodehashGateInput`
 */
const gateInput = async (
  data?: string,
  network: string = NETWORK
): Promise<ICodehashGateInput> =>
  gateInputFor({ safeTransaction: await signedStruct(data) }, network)

describe('gateInputFor', () => {
  // Which bytes the gate judges is enforced by object identity, checked at
  // runtime. Four earlier versions were each defeated: a pin on the call site's
  // spelling (by a comment reciting it), the same pin on comment-stripped text
  // (by a string literal, and by a fake comment marker that deleted the real
  // call site), an interface naming the right field (by `{ safeTransaction:
  // row.safeTx }`, since the two are the same type), and a type-level brand (by
  // a spread, which keeps the brand and swaps the bytes). A type cannot express
  // "this exact object", which was the question all along.
  it('reads the calldata of the struct that gets signed', async () => {
    expect(
      gateInputFor({ safeTransaction: await signedStruct('0xaabb') }, 'mainnet')
        .struct.data.data
    ).toBe('0xaabb')
  })

  it('passes the network key straight through', async () => {
    expect(
      gateInputFor(
        { safeTransaction: await signedStruct('0xaabb') },
        'Abstract'
      ).network
    ).toBe('Abstract')
  })

  it('reports absent calldata as undefined', async () => {
    expect(
      gateInputFor({ safeTransaction: await signedStruct() }, 'mainnet').struct
        .data.data
    ).toBeUndefined()
  })

  it('REFUSES a spread of the signed struct carrying the document bytes', async () => {
    // The route that defeated the type-level brand, cast-free and green:
    // `{ ...struct, data: row.safeTx.data }` satisfies every type involved and
    // reads as an innocuous normalisation. It is a different object, so the
    // identity check stops it.
    const struct = await signedStruct('0xaabb')
    const forged = { ...struct, data: { ...struct.data, data: '0xdead' } }

    expect(() =>
      gateInputFor(
        { safeTransaction: forged as ISignedSafeTransaction },
        'mainnet'
      )
    ).toThrow(/not the one Safe will hash and sign/)
  })

  it('REFUSES a hand-written brand', async () => {
    // The other cast-free forge: writing `__signedStruct` by hand satisfied the
    // type. It cannot put the object in the WeakSet.
    const struct = await signedStruct('0xaabb')
    const forged = {
      data: struct.data,
      signatures: struct.signatures,
      __signedStruct: 'initializeSafeTransaction',
    } as unknown as ISignedSafeTransaction

    expect(() => gateInputFor({ safeTransaction: forged }, 'mainnet')).toThrow(
      /Nothing has been signed/
    )
  })

  it('accepts the real struct, so the refusals above are not blanket', async () => {
    // Paired positive. Without it, a check that refused everything would satisfy
    // both cases above while disabling the gate.
    const struct = await signedStruct('0xaabb')

    expect(() =>
      gateInputFor({ safeTransaction: struct }, 'mainnet')
    ).not.toThrow()
  })
})

describe('evaluateCodehashSignGate', () => {
  it('does not build its dependencies for a proposal carrying no cut', async () => {
    // Building them reads `foundry.toml` and creates a checkout root, and the
    // caller turns a throw into a refusal — so an eager build refuses a fee
    // change or a role grant on a broken toolchain config, which this gate
    // makes no claim about. The thunk is the seam that keeps that impossible.
    let built = 0
    const result = await evaluateCodehashSignGate(
      await gateInput('0xdeadbeef', NETWORK),
      () => {
        built += 1
        return deps()
      }
    )

    expect(built).toBe(0)
    expect(result.blocksSigning).toBe(false)
  })

  it('builds its dependencies once per evaluation, not once per cut', async () => {
    // Nothing in the type pins this, and the only reason it held was that the
    // caller memoises. A thunk that constructs would otherwise get one checkout
    // root and one connection per cut in a batch, against a single close().
    let built = 0
    await evaluateCodehashSignGate(
      await gateInput(
        wrapped([cutCalldata(FACET), cutCalldata(OTHER)]),
        NETWORK
      ),
      () => {
        built += 1
        return deps()
      }
    )

    expect(built).toBe(1)
  })

  it('lowercases the network before any lookup sees it', async () => {
    // `config/networks.json` is keyed lowercase and every lookup this reaches
    // throws on another spelling, so a caller handing over what an operator
    // typed was refused rather than judged. Normalising here rather than at the
    // call site is what stops the next caller repeating it.
    const asked: string[] = []
    await evaluateCodehashSignGate(
      await gateInput(cutCalldata(), 'Mainnet'),
      () =>
        deps({
          scope: (network: string) => {
            asked.push(network)
            return { isClosedSet: true }
          },
        })
    )

    expect(asked).toEqual(['mainnet'])
  })

  it('does build them once a cut is present, so the seam is not just dead', async () => {
    // The paired positive. Without it, a thunk that is never invoked at all
    // would satisfy the assertion above while disabling the gate entirely.
    let built = 0
    const gate = await evaluateCodehashSignGate(
      await gateInput(cutCalldata(), NETWORK),
      () => {
        built += 1
        return deps({ observe: async () => observed({ maskedHash: OTHER }) })
      }
    )

    expect(built).toBe(1)
    expect(gate.blocksSigning).toBe(true)
  })

  it('does not block a proposal that carries no diamondCut', async () => {
    const gate = await evaluateCodehashSignGate(
      await gateInput('0x', NETWORK),
      () => deps()
    )

    expect(gate.blocksSigning).toBe(false)
    expect(gate.evaluated).toBe(false)
    expect(gate.targets).toEqual([])
  })

  it('passes a cut whose target matches an attested build', async () => {
    const gate = await evaluateCodehashSignGate(
      await gateInput(wrapped([cutCalldata()]), NETWORK),
      () => deps()
    )

    expect(gate.evaluated).toBe(true)
    expect(gate.blocksSigning).toBe(false)
    expect(gate.targets.map((t) => t.verdict)).toEqual(['MATCH'])
    expect(gate.targets[0]?.address).toBe(getAddress(FACET))
  })

  it('blocks a cut whose target matches nothing attested', async () => {
    const gate = await evaluateCodehashSignGate(
      await gateInput(wrapped([cutCalldata()]), NETWORK),
      () =>
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
      await gateInput(wrapped([cutCalldata()]), NETWORK),
      () =>
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
      await gateInput(wrapped([cutCalldata()]), 'notanetwork'),
      () =>
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
      await gateInput(hidden, NETWORK),
      () => deps()
    )

    expect(gate.blocksSigning).toBe(true)
    expect(gate.evaluated).toBe(true)
    expect(gate.refusals[0]).toContain('could not open')
  })

  it('judges every cut in a batch, not only the first', async () => {
    const other = OTHER
    const gate = await evaluateCodehashSignGate(
      await gateInput(wrapped([cutCalldata(), cutCalldata(other)]), NETWORK),
      () =>
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
      await gateInput(data, NETWORK),
      () => recording
    )
    const second = await evaluateCodehashSignGate(
      await gateInput(data, NETWORK),
      () => recording
    )

    expect(second).toEqual(first)
    expect(seen).toEqual([getAddress(FACET), getAddress(FACET)])
    // Non-vacuous: a different value must reach a different address, so the
    // equality above is a property of the input rather than of a cached answer.
    await evaluateCodehashSignGate(
      await gateInput(wrapped([cutCalldata(OTHER)]), NETWORK),
      () => recording
    )
    expect(seen[2]).toBe(getAddress(OTHER))
  })

  it('carries the excluded immutable bytes through, and they block', async () => {
    // `verifyCutTargets` grades a hash match with masked bytes UNVERIFIABLE
    // until layer 2 checks their values, so the count has to survive the wiring
    // for the display to be able to say what was not compared.
    const gate = await evaluateCodehashSignGate(
      await gateInput(wrapped([cutCalldata()]), NETWORK),
      () => deps({ observe: async () => observed({ maskedByteCount: 128 }) })
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
        await gateInput(wrapped([cutCalldata()]), NETWORK),
        () => deps(over)
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
      await gateInput('0xdeadbeef00000000', NETWORK),
      () => deps()
    )

    expect(gate.summary).toContain('0xdeadbeef')
    expect(gate.summary).toMatch(/could not open/)
    expect(gate.madeNoClaim).toBe(true)
  })

  it('does not claim an unopened frame for an ordinary decodable cut', async () => {
    // Paired positive: a proposal it fully read must not be described as
    // unopened, or the message above becomes noise on every proposal.
    const gate = await evaluateCodehashSignGate(
      await gateInput(wrapped([cutCalldata()]), NETWORK),
      () => deps()
    )

    expect(gate.summary).not.toMatch(/could not open/)
    expect(gate.madeNoClaim).toBeUndefined()
  })
})

describe('a verdict is about specific bytes', () => {
  // The route that defeated attempt 5, twice over. `gateInputFor` used to return
  // detached `{ data, network }`, so the bytes could be reassigned after the
  // identity check or replaced in a spread. And identity alone answered "some
  // struct a producer made", not "this proposal" — every pending row on the
  // network carries a member struct, so grading proposal 0 authorised signing
  // proposal N. Binding the verdict to the payload is what closes both.
  it('refuses to authorise a signature over calldata it did not grade', async () => {
    const graded = await evaluateCodehashSignGate(
      await gateInput(cutCalldata()),
      () => deps()
    )

    expect(graded.blocksSigning).toBe(false)
    expect(() =>
      assertCodehashSignGateAllowsSigning(graded, 'a-different-transaction')
    ).toThrow(/verdict is about a different transaction/)
  })

  it('authorises the transaction it did grade, so the check is not blanket', async () => {
    const data = cutCalldata()
    const graded = await evaluateCodehashSignGate(await gateInput(data), () =>
      deps()
    )

    expect(() =>
      assertCodehashSignGateAllowsSigning(graded, String(graded.gradedKey))
    ).not.toThrow()
  })

  it('stops the signer when the struct being signed is a different proposal', async () => {
    // The whole point, driven through the funnel rather than the assert: a
    // passing verdict on one proposal must not sign another. `sign` is a spy,
    // so this asserts the signature was never reached, not merely that
    // something threw.
    const reached: string[] = []
    const graded = await evaluateCodehashSignGate(
      await gateInput(cutCalldata()),
      () => deps()
    )
    const other = await signedStruct('0xdeadbeef')

    const sign = createGatedSigner<[ISignedSafeTransaction], string>({
      gate: () => graded,
      keyOf: (struct: ISignedSafeTransaction) => proposalKeyOf(struct.data),
      sign: async (struct) => {
        reached.push(String(struct.data.data))
        return 'signed'
      },
    })

    expect(await rejection(sign(other))).toMatch(
      /verdict is about a different transaction/
    )
    expect(reached).toEqual([])
  })

  it('signs the proposal it graded, so the funnel is not simply broken', async () => {
    const reached: string[] = []
    const struct = await signedStruct(cutCalldata())
    const graded = await evaluateCodehashSignGate(
      gateInputFor({ safeTransaction: struct }, NETWORK),
      () => deps()
    )

    const sign = createGatedSigner<[ISignedSafeTransaction], string>({
      gate: () => graded,
      keyOf: (s: ISignedSafeTransaction) => proposalKeyOf(s.data),
      sign: async (s) => {
        reached.push(String(s.data.data))
        return 'signed'
      },
    })

    expect(await sign(struct)).toBe('signed')
    expect(reached).toHaveLength(1)
  })

  it('does not let a verdict on one row authorise the same cut at another nonce', async () => {
    // The binding is the whole signed tuple, not the calldata: two re-proposed
    // rows can carry an identical cut at different nonces, and `data` alone
    // cannot tell them apart. The verdict is only about the calldata, so binding
    // wider costs nothing and closes the class instead of the instance.
    const cut = cutCalldata()
    const graded = await evaluateCodehashSignGate(
      gateInputFor({ safeTransaction: await signedStruct(cut) }, NETWORK),
      () => deps()
    )
    const reproposed = await signedStruct(cut, { nonce: 8 })

    expect(graded.blocksSigning).toBe(false)
    expect(() =>
      assertCodehashSignGateAllowsSigning(
        graded,
        proposalKeyOf(reproposed.data)
      )
    ).toThrow(/different transaction/)
  })

  it("still names the gate's own reason when the key also fails to match", () => {
    // The refusal used to report only the substitution, and a gate that never
    // ran carries no key — so a broken toolchain config told the operator their
    // calldata had been swapped, and sent the next reader after a substitution
    // that never happened.
    const couldNotRun = {
      ...blockingUnevaluatedGate(),
      evaluated: true,
      // Distinct texts on purpose: with the same string in both, the assertion
      // below passes off `summary` and observes nothing about whether
      // `refusals` survived — which is how the first version of this test
      // passed against the bug it was written for.
      refusals: ['REFUSAL-TEXT foundry.toml is unreadable'],
      summary: 'SUMMARY-TEXT the gate could not be evaluated',
    }

    let message = ''
    try {
      assertCodehashSignGateAllowsSigning(couldNotRun, 'some-transaction-key')
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('REFUSAL-TEXT')
    expect(message).toContain('SUMMARY-TEXT')
    expect(message).toMatch(/reached no verdict for this transaction/)
  })

  it('judges the struct as it stands when the gate runs, not a copy taken earlier', async () => {
    // The holder carries the reference, so there is no earlier copy to diverge
    // from: mutating the struct changes what is judged, which is the correct
    // semantics — the bytes Safe would sign are the bytes graded.
    const struct = await signedStruct(cutCalldata())
    const input = gateInputFor({ safeTransaction: struct }, NETWORK)
    struct.data.data = '0xdeadbeef'

    const graded = await evaluateCodehashSignGate(input, () => deps())

    expect(graded.gradedData).toBe('0xdeadbeef')
    expect(graded.madeNoClaim).toBe(true)
  })
})

describe('the sign funnel', () => {
  // A matching key on both, so these cases isolate the blocking decision. The
  // mismatch is asserted separately, and a gate with no key now refuses on its
  // own — which would confound every case here.
  const SAME_KEY = 'the-one-transaction'
  const blockingGate = { ...blockingUnevaluatedGate(), gradedKey: SAME_KEY }
  const passingGate = { ...blockingGate, blocksSigning: false }

  it('never reaches the signature when the gate blocks', async () => {
    const calls: string[] = []
    const sign = createGatedSigner<[string], string>({
      gate: () => blockingGate,
      keyOf: () => SAME_KEY,
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
      keyOf: () => SAME_KEY,
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
      keyOf: () => SAME_KEY,
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
      await gateInput(wrapped([cutCalldata()]), NETWORK),
      () =>
        deps({
          attestationsFor: async () => [
            attested({ maskedHash: `0x${'99'.repeat(32)}` }),
          ],
        })
    )

    let thrown = ''
    try {
      assertCodehashSignGateAllowsSigning(gate, String(gate.gradedKey))
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }

    expect(thrown).toContain(getAddress(FACET))
    expect(thrown).toContain('MISMATCH')
  })

  it('returns quietly for a gate that did not block', async () => {
    const gate = await evaluateCodehashSignGate(
      await gateInput(wrapped([cutCalldata()]), NETWORK),
      () => deps()
    )

    expect(gate.gradedKey).toBeDefined()
    expect(() =>
      assertCodehashSignGateAllowsSigning(gate, String(gate.gradedKey))
    ).not.toThrow()
  })

  it('refuses the state a proposal starts in', () => {
    // The real default, not a hand-built stand-in: flip its `blocksSigning` to
    // false and this is the assertion that catches it.
    expect(blockingUnevaluatedGate().blocksSigning).toBe(true)
    // Any key: the starting state graded nothing, so it both blocks and has no
    // verdict to match — the refusal names its own reason either way.
    expect(() =>
      assertCodehashSignGateAllowsSigning(
        blockingUnevaluatedGate(),
        'any-transaction'
      )
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
