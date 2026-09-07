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
    expect(gate.refusals[0]).toContain('cannot open')
  })

  it('judges every cut in a batch, not only the first', async () => {
    const other = '0x2222222222222222222222222222222222222222'
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
  })

  it('surfaces the excluded immutable bytes a MATCH did not cover', async () => {
    const gate = await evaluateCodehashSignGate(
      { data: wrapped([cutCalldata()]), network: NETWORK },
      deps({ observe: async () => observed({ maskedByteCount: 128 }) })
    )

    expect(gate.blocksSigning).toBe(false)
    expect(gate.targets[0]?.excludedByteCount).toBe(128)
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

  it('names the excluded immutable bytes on a MATCH', async () => {
    const rendered = await render({
      observe: async () => observed({ maskedByteCount: 96 }),
    })

    expect(rendered).toContain('96')
    expect(rendered.toLowerCase()).toContain('immutable')
  })

  it('does not claim excluded bytes when none were excluded', async () => {
    expect((await render({})).toLowerCase()).not.toContain('immutable')
  })
})

describe('the sign funnel', () => {
  const blockingGate = {
    blocksSigning: true,
    evaluated: true,
    refusals: [],
    targets: [],
    summary: 'This cut will not be signed.',
  }
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

  it('refuses a gate that was never evaluated', () => {
    expect(() =>
      assertCodehashSignGateAllowsSigning({
        ...unevaluatedCodehashSignGate(),
        blocksSigning: true,
        summary: 'the codehash gate did not run for this proposal',
      })
    ).toThrow(/did not run/)
  })
})
