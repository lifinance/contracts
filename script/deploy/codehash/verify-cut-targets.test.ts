/**
 * The sign-time gate as a whole: classify the cut, then judge every address it
 * would install.
 *
 * Two properties matter more than the happy path. **Three buckets stay three** —
 * MISMATCH and UNVERIFIABLE both stop a signature but are different facts, and
 * collapsing them is what trains a signer to click through grey. And **nothing
 * fails open**: an address whose code or attestations cannot be read is not a
 * pass, because "we could not check" and "we checked and it is fine" are the two
 * things a gate exists to keep apart.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { getAddress } from 'viem'

import type { IAttestedBuild, IObservedCode } from './attested-set'
import { FacetCutActionEnum } from './cut-classification'
import type {
  ImmutablePricing,
  IPricedImmutables,
} from './immutable-expectations'
import {
  verifyCutTargets,
  type IAttestationLookup,
  type IVerifyCutDeps,
} from './verify-cut-targets'

const A = getAddress('0x1111111111111111111111111111111111111111')
const B = getAddress('0x2222222222222222222222222222222222222222')
const INIT = getAddress('0x3333333333333333333333333333333333333333')
const ZERO = '0x0000000000000000000000000000000000000000'

const HASH = `0x${'ab'.repeat(32)}`
const OTHER = `0x${'cd'.repeat(32)}`

const observed = (maskedHash: string): IObservedCode => ({
  maskedHash,
  rawByteLength: 100,
  rawHash: maskedHash,
  maskedByteCount: 0,
})

// `solcVersion` and `rawHash` are declared required-but-nullable on
// IAttestedBuild rather than optional, so a caller cannot omit them by accident.
// Spelling them out here is that design working.
const attested = (
  maskedHash: string,
  lineage = 'main@abc1234'
): IAttestedBuild => ({
  lineage,
  provenance: 'A-LOCAL',
  maskedHash,
  rawByteLength: 100,
  rawHash: maskedHash,
  solcVersion: '0.8.29',
})

const add = (facetAddress: string) => ({
  facetAddress,
  action: FacetCutActionEnum.Add,
})
const remove = (facetAddress: string) => ({
  facetAddress,
  action: FacetCutActionEnum.Remove,
})

const deps = (overrides?: {
  observe?: (address: string) => Promise<IObservedCode>
  attestationsFor?: (address: string) => Promise<IAttestationLookup>
  price?: (
    address: string,
    network: string,
    runtimeCode: string
  ) => Promise<ImmutablePricing>
  isClosedSet?: boolean
}) => ({
  scope: () => ({ isClosedSet: overrides?.isClosedSet ?? true }),
  observe: overrides?.observe ?? (async () => observed(HASH)),
  attestationsFor:
    overrides?.attestationsFor ?? (async () => ({ builds: [attested(HASH)] })),
  // Layer 2 refuses unless a test says otherwise, so every existing expectation
  // describes the verdict layer 1 reaches on its own.
  price:
    overrides?.price ??
    (async () => ({
      decided: false as const,
      reason: 'no layer 2 in this test',
    })),
})

/** A layer-2 answer that accounts for `bytes` of masked code. */
const priced = (
  bytes: number,
  over: Partial<Omit<IPricedImmutables, 'decided'>> = {}
): ImmutablePricing => ({
  decided: true,
  slots: [],
  disagreements: [],
  pricedByteCount: bytes,
  unpricedByteCount: 0,
  disagreeingByteCount: 0,
  ...over,
})

describe('verifyCutTargets', () => {
  it('passes a cut whose installed code matches an attested build', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps()
    )

    expect(report.blocksSigning).toBe(false)
    expect(report.refusals).toEqual([])
    expect(report.targets).toHaveLength(1)
    expect(report.targets[0]?.verdict).toBe('MATCH')
    expect(report.targets[0]?.address).toBe(A)
  })

  it('blocks on a MISMATCH and says which address', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({ observe: async () => observed(OTHER) })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.verdict).toBe('MISMATCH')
    expect(report.summary).toContain(A)
  })

  it('keeps UNVERIFIABLE distinct from MISMATCH while still blocking', async () => {
    // Three buckets, not two. Both stop the signature; a signer told "grey" and
    // a signer told "red" are being asked different questions.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        attestationsFor: async () => ({ builds: [] }),
        isClosedSet: false,
      })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.targets[0]?.verdict).not.toBe('MISMATCH')
  })

  it('says why the attested set is empty when the lookup knows', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        attestationsFor: async () => ({
          builds: [],
          absence:
            'the deployment record names Foo@1.0.0 but carries no commit',
        }),
        isClosedSet: false,
      })
    )

    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.targets[0]?.reason).toBe(
      'the deployment record names Foo@1.0.0 but carries no commit'
    )
    // Still the same refusal. A sentence that explains an empty set must not
    // also soften it.
    expect(report.blocksSigning).toBe(true)
  })

  it('falls back to the bare sentence when the lookup gives no reason', async () => {
    // The pair for the test above: without it, a lookup that stopped supplying
    // a reason would leave that assertion passing against a hardcoded string.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        attestationsFor: async () => ({ builds: [] }),
        isClosedSet: false,
      })
    )

    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.targets[0]?.reason).toBe(
      'no attested build is available for this contract, so nothing can be compared'
    )
  })

  it('never consults the chain for an address it does not gate', async () => {
    // A Remove installs nothing, so reading its code is not merely wasteful —
    // a verdict on it would invite blocking a removal, which criterion (d)
    // forbids.
    const looked: string[] = []
    const report = await verifyCutTargets(
      { cuts: [remove(A)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async (address) => {
          looked.push(address)
          return observed(HASH)
        },
      })
    )

    expect(looked).toEqual([])
    expect(report.blocksSigning).toBe(false)
    expect(report.targets).toEqual([])
  })

  it('gates the additive half of a mixed batch and only that half', async () => {
    const looked: string[] = []
    const report = await verifyCutTargets(
      { cuts: [add(A), remove(B)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async (address) => {
          looked.push(address)
          return observed(HASH)
        },
      })
    )

    expect(looked).toEqual([A])
    expect(report.blocksSigning).toBe(false)
  })

  it('judges _init as its own target', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: INIT, network: 'mainnet' },
      deps({
        observe: async (address) => observed(address === INIT ? OTHER : HASH),
      })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets.find((t) => t.address === INIT)?.verdict).toBe(
      'MISMATCH'
    )
  })

  it('blocks on a classification refusal without reading any code', async () => {
    // A removal-only cut carrying _init is malformed, not unverifiable, so
    // there is nothing to compare and asking the chain would imply otherwise.
    const looked: string[] = []
    const report = await verifyCutTargets(
      { cuts: [remove(A)], init: INIT, network: 'mainnet' },
      deps({
        observe: async (address) => {
          looked.push(address)
          return observed(HASH)
        },
      })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.refusals).toHaveLength(1)
    expect(looked).toEqual([])
    expect(report.targets).toEqual([])
  })

  it('blocks when the deployed code cannot be read, rather than passing', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async () => {
          throw new Error('rpc unreachable')
        },
      })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.targets[0]?.reason).toMatch(/could not be read/)
    expect(report.targets[0]?.reason).toMatch(/rpc unreachable/)
  })

  it('blocks when the attestations cannot be read, rather than treating it as none', async () => {
    // "No attested build" and "we could not find out" look identical from the
    // outside and must not: the first is a missing rebuild, the second is an
    // infrastructure failure that could hide either answer.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        attestationsFor: async () => {
          throw new Error('attestation store down')
        },
      })
    )

    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.targets[0]?.reason).toMatch(/attestation store down/)
  })

  it('judges every target even after one has already failed', async () => {
    // Stopping at the first would show a signer one problem at a time, and a
    // second MISMATCH is a different fact worth seeing at once.
    const report = await verifyCutTargets(
      { cuts: [add(A), add(B)], init: ZERO, network: 'mainnet' },
      deps({ observe: async () => observed(OTHER) })
    )

    expect(report.targets).toHaveLength(2)
    expect(report.targets.every((t) => t.verdict === 'MISMATCH')).toBe(true)
  })

  it('passes the network through to the scope, never a default', async () => {
    const asked: string[] = []
    await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'abstract' },
      {
        ...deps(),
        scope: (network: string) => {
          asked.push(network)
          return { isClosedSet: true }
        },
      }
    )

    expect(asked).toEqual(['abstract'])
  })

  it('will not report MATCH while bytes were excluded and layer 2 has not run', async () => {
    // `attested-set.ts` states this as a rendering instruction: "a caller that
    // has not run layer 2 must not render an unqualified green". Rendering is
    // not a gate. Two executable fail-opens rode on that gap — refs supplied
    // from the record's own commit can mask the entire body, and a comparison
    // that compared nothing reported blocksSigning: false.
    //
    // So while no layer-2 check is wired, masked bytes make the verdict grey.
    // No threshold is invented: any excluded byte is uncompared.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async () => ({ ...observed(HASH), maskedByteCount: 96 }),
        attestationsFor: async () => ({
          builds: [{ ...attested(HASH), rawHash: undefined }],
        }),
      })
    )

    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.reason).toMatch(/96 bytes/)
    expect(report.targets[0]?.reason).toMatch(/were not checked/)
  })

  const DEPLOYED = '0xfeed'

  const maskedMatch = (over: { price: IVerifyCutDeps['price'] }) =>
    verifyCutTargets({ cuts: [add(A)], init: ZERO, network: 'mainnet' }, {
      ...deps(over),
      observe: async () => ({
        ...observed(HASH),
        maskedByteCount: 96,
        runtimeCode: DEPLOYED,
      }),
      attestationsFor: async () => ({
        builds: [{ ...attested(HASH), rawHash: undefined }],
      }),
    } as IVerifyCutDeps)

  it('prices the bytes the comparison was built from, not a second read', async () => {
    let seen: string | undefined
    const report = await maskedMatch({
      price: async (_address, _network, runtimeCode) => {
        seen = runtimeCode
        return priced(96)
      },
    })

    // The whole point of the parameter: layer 1 masked these bytes and vouches
    // for nothing in them, so layer 2 grading a different reading would leave
    // the only check of the immutables resting on evidence layer 1 never saw.
    expect(seen).toBe(DEPLOYED)
    expect(report.targets[0]?.verdict).toBe('MATCH')
  })

  it('will not upgrade an observation that carries no bytes to price', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      {
        ...deps({ price: async () => priced(96) }),
        // No `runtimeCode`, as every pre-layer-2 producer of an observation
        // leaves it.
        observe: async () => ({ ...observed(HASH), maskedByteCount: 96 }),
        attestationsFor: async () => ({
          builds: [{ ...attested(HASH), rawHash: undefined }],
        }),
      } as IVerifyCutDeps
    )

    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.reason).toMatch(/did not carry the bytes/u)
  })

  it('reports MATCH once layer 2 has priced every masked byte', async () => {
    const report = await maskedMatch({ price: async () => priced(96) })

    expect(report.targets[0]?.verdict).toBe('MATCH')
    expect(report.blocksSigning).toBe(false)
    // The qualifier goes with the refusal: nothing is left for a renderer to
    // warn about.
    expect(report.targets[0]?.excludedByteCount).toBe(0)
    expect(report.summary).toMatch(/96 bytes holding immutables were compared/)
  })

  it('says nothing about immutables for a contract that has none', async () => {
    // The paired negative for the line above: a clean MATCH reached without
    // layer 2 must not claim a check that never happened.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps()
    )

    expect(report.targets[0]?.verdict).toBe('MATCH')
    expect(report.summary).not.toMatch(/immutables/)
  })

  it('reports MISMATCH, not grey, when a slot holds something config does not declare', async () => {
    const report = await maskedMatch({
      price: async () =>
        priced(64, {
          unpricedByteCount: 0,
          disagreeingByteCount: 32,
          disagreements: [
            {
              name: 'SPOKEPOOL',
              status: 'disagrees',
              byteCount: 32,
              observed: `0x${'ee'.repeat(32)}`,
              expected: `0x${'11'.repeat(32)}`,
              origin: 'config/across.json.mainnet.spokePool',
            },
          ],
        }),
    })

    expect(report.targets[0]?.verdict).toBe('MISMATCH')
    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.reason).toMatch(/SPOKEPOOL/)
    expect(report.targets[0]?.reason).toMatch(/across\.json/)
  })

  it('stays UNVERIFIABLE when a slot has no declared expectation', async () => {
    // The answer every contract still gets for a slot no entry covers, which
    // the registry being full makes rarer rather than impossible.
    const report = await maskedMatch({
      price: async () =>
        priced(64, {
          unpricedByteCount: 32,
          slots: [
            {
              name: 'EXECUTOR',
              status: 'undeclared',
              byteCount: 32,
              observed: `0x${'22'.repeat(32)}`,
              detail: 'no registry entry',
            },
          ],
        }),
    })

    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.blocksSigning).toBe(true)
    expect(report.targets[0]?.reason).toMatch(/EXECUTOR/)
  })

  it('leaves layer 1 alone when layer 2 throws, rather than reading the outage as a finding', async () => {
    const report = await maskedMatch({
      price: async () => {
        throw new Error('mongo is unreachable')
      },
    })

    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.targets[0]?.reason).toMatch(/mongo is unreachable/)
  })

  it('never consults layer 2 for a MISMATCH, so it cannot upgrade one', async () => {
    let asked = false
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async () => observed(OTHER),
        price: async () => {
          asked = true
          return priced(96)
        },
      })
    )

    expect(report.targets[0]?.verdict).toBe('MISMATCH')
    expect(asked).toBe(false)
  })

  it('still reports MATCH when nothing was excluded, so the downgrade is not blanket', async () => {
    // The paired positive. Without it the rule above could be "always grey",
    // which would pass its own test while making the gate useless.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps()
    )

    expect(report.targets[0]?.verdict).toBe('MATCH')
    expect(report.blocksSigning).toBe(false)
  })

  it('carries the excluded byte count through to the summary a signer reads', async () => {
    // The reporting half of the rule above. The attestation must NOT pin exact
    // bytes: a rawHash-pinned build is compared byte for byte and correctly
    // reports zero excluded bytes, so it cannot exercise the masking path at
    // all — that fixture was wrong in exactly the dimension under test.
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      deps({
        observe: async () => ({ ...observed(HASH), maskedByteCount: 64 }),
        attestationsFor: async () => ({
          builds: [{ ...attested(HASH), rawHash: undefined }],
        }),
      })
    )

    expect(report.targets[0]?.excludedByteCount).toBe(64)
    expect(report.summary).toMatch(/immutable/i)
    expect(report.summary).toContain('64')
  })
})

/**
 * zkEVM reaches a clean layer-1 MATCH with nothing masked, because its
 * immutables are not in the runtime code to mask — they live in
 * `ImmutableSimulator`. Keying the layer-2 handoff off the masked count alone
 * therefore skipped the whole family, and the MATCH rendered exactly like a
 * contract holding no immutables at all: the collapse `summarise` says must not
 * happen, on three active networks.
 *
 * Layer 2 cannot run here yet — the zk toolchain emits neither `deployedBytecode`
 * nor an AST, so nothing can name the simulator's slots. What the gate can stop
 * doing is claiming the values were covered.
 */
describe('verifyCutTargets on a chain holding immutables off-code', () => {
  const zkDeps = (over: Partial<IVerifyCutDeps> = {}) =>
    ({
      ...deps(),
      scope: () => ({ isClosedSet: true, holdsImmutablesOffCode: true }),
      observe: async () => ({ ...observed(HASH), runtimeCode: '0xfeed' }),
      attestationsFor: async () => ({
        builds: [{ ...attested(HASH), rawHash: undefined }],
      }),
      ...over,
    } as IVerifyCutDeps)

  const zkReport = (over: Partial<IVerifyCutDeps> = {}) =>
    verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'zksync' },
      zkDeps(over)
    )

  it('does not call a layer-1 match a match of the deployed code', async () => {
    const report = await zkReport()

    expect(report.targets[0]?.verdict).toBe('UNVERIFIABLE')
    expect(report.blocksSigning).toBe(true)
  })

  it('names where the unchecked values live, and counts no masked bytes', async () => {
    const report = await zkReport()

    expect(report.targets[0]?.reason).toMatch(/ImmutableSimulator/u)
    // The EVM sentence is built from the masked count. There are none here, so
    // reusing it would tell the signer "0 bytes were not checked".
    expect(report.targets[0]?.reason).not.toMatch(/\b0 bytes\b/u)
  })

  it('never renders the unqualified green', async () => {
    const report = await zkReport()

    expect(report.summary).not.toMatch(
      /Every address this cut installs matches a rebuild/u
    )
  })

  it('leaves a chain that inlines its immutables exactly as it was', async () => {
    const report = await verifyCutTargets(
      { cuts: [add(A)], init: ZERO, network: 'mainnet' },
      {
        ...deps(),
        scope: () => ({ isClosedSet: true, holdsImmutablesOffCode: false }),
      } as IVerifyCutDeps
    )

    expect(report.targets[0]?.verdict).toBe('MATCH')
    expect(report.blocksSigning).toBe(false)
  })
})
