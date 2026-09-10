/**
 * Bytecode fixtures are crafted rather than measured, because what is under
 * test is which byte ranges decide a verdict. `TRAILER_12` and `TRAILER_16` are
 * both well-formed solc metadata trailers over the same declared version
 * (0.8.29) differing only in length, so a pair built from them strips to the
 * same body at two different deployed lengths — the case the `rawByteLength`
 * pin exists for. Both were checked against `readMetadataTrailer`.
 *
 * Attested builds are produced with `normalizeRuntimeCode`, the function a real
 * attestation is built with, and every case runs with `REFS` rather than no
 * immutable ranges: masking is what the attested-set check is blind through,
 * and a fixture without ranges would exercise exact-body equality instead.
 *
 * An end-to-end run against a real artifact needs `out/` and the `anvil`
 * binary, neither of which the suite has, so nothing here drives a real node.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IAttestedBuild } from './attested-set'
import { verifyByConstructorReplay } from './constructor-replay'
import type {
  IConstructorReplayDeps,
  IReplayRequest,
  ReplayOutcome,
  ReplayVerification,
} from './constructor-replay'
import type { ExpectedArgs } from './expected-constructor-args'
import { normalizeRuntimeCode } from './rebuild-attestations'

const BODY = `60806040${'ab'.repeat(28)}`

/** {"solc": h'00081d'} plus its length word: 12 bytes come off. */
const TRAILER_12 = 'a164736f6c634300081d000a'

/** {"solc": h'00081d', "x": "y"} plus its length word: 16 bytes come off. */
const TRAILER_16 = 'a264736f6c634300081d61786179000e'

const CREATION_CODE = `0x60806040${'cd'.repeat(16)}`

const IMMUTABLE_WORD =
  '0000000000000000000000005c7bcd6e7de5423a257d81b442095a1a6ced35c5'
const TAMPERED_WORD =
  '000000000000000000000000dead000000000000000000000000000000000000'

/** A third value, so a second replay can differ from the first as well as from the deployment. */
const OTHER_WORD =
  '000000000000000000000000beef000000000000000000000000000000000000'

const withImmutable = (word: string, trailer: string): string =>
  `0x${BODY}${word}${trailer}`

/**
 * The word `withImmutable` splices, as Foundry would report it. Production
 * artifacts always carry these when a contract has immutables, and masking is
 * what makes the attested-set check blind to the spliced word — a fixture that
 * passes `undefined` here tests exact-body equality instead.
 */
const REFS = { '1': [{ start: BODY.length / 2, length: 32 }] }

const DERIVED: ExpectedArgs = {
  ok: true,
  args: [
    {
      name: '_spokePool',
      type: 'address',
      value: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
      origin: 'config/across.json.mainnet.acrossSpokePool',
    },
  ],
  encoded: IMMUTABLE_WORD,
}

/** The attestation a build of `runtimeCode` would produce. */
const attesting = (
  runtimeCode: string,
  lineage = 'upstream cancun'
): IAttestedBuild[] => {
  const normalized = normalizeRuntimeCode(runtimeCode, REFS, {
    isZk: false,
  })
  if (!normalized.ok) throw new Error(normalized.reason)
  return [
    {
      lineage,
      solcVersion: '0.8.29',
      maskedHash: normalized.maskedHash,
      rawByteLength: normalized.rawByteLength,
      rawHash: undefined,
    },
  ]
}

/** Returns fixed code for any request, and counts the calls it received. */
const evmReturning = (
  runtimeCode: string
): IConstructorReplayDeps & { calls: IReplayRequest[] } => {
  const calls: IReplayRequest[] = []
  return {
    calls,
    replay: async (request) => {
      calls.push(request)
      return { ok: true, runtimeCode }
    },
  }
}

const evmFailing = (reason: string): IConstructorReplayDeps => ({
  replay: async (): Promise<ReplayOutcome> => ({ ok: false, reason }),
})

/** Answers each call from `outcomes` in turn, as a real node reached by two replays would. */
const evmAnswering = (
  outcomes: readonly ReplayOutcome[]
): IConstructorReplayDeps & { calls: IReplayRequest[] } => {
  const calls: IReplayRequest[] = []
  return {
    calls,
    replay: async (request) => {
      calls.push(request)
      return (
        outcomes[calls.length - 1] ?? {
          ok: false,
          reason: 'the test offered no further outcome',
        }
      )
    },
  }
}

const verify = (
  observedRuntimeCode: string,
  deps: IConstructorReplayDeps,
  attestedBuilds: IAttestedBuild[],
  expectedArgs: ExpectedArgs = DERIVED
): Promise<ReplayVerification> =>
  verifyByConstructorReplay(
    {
      observedRuntimeCode,
      creationCode: CREATION_CODE,
      chainId: 42161,
      attestedBuilds,
      immutableReferences: REFS,
      expectedArgs,
    },
    deps
  )

describe('when the replay reproduces the deployed bytes', () => {
  it('matches on every byte and excludes none', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(honest, evmReturning(honest), attesting(honest))

    expect(result.decided).toBe(true)
    if (!result.decided) return
    expect(result.comparison.verdict).toBe('MATCH')
    expect(result.comparison.excludedByteCount).toBe(0)
    expect(result.comparison.blocksSigning).toBe(false)
  })

  it('reports the lineage of the attested build, never one the caller named', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(
      honest,
      evmReturning(honest),
      attesting(honest, 'zksync 1.5.7')
    )

    expect(result.decided).toBe(true)
    if (!result.decided) return
    expect(result.comparison.matchedLineages).toEqual(['zksync 1.5.7'])
  })

  it('passes the local EVM our creation code, the derived args and the chain, nothing else', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const evm = evmReturning(honest)

    await verify(honest, evm, attesting(honest))

    expect(evm.calls).toEqual([
      {
        creationCode: CREATION_CODE,
        encodedArgs: IMMUTABLE_WORD,
        chainId: 42161,
      },
    ])
  })

  it('still matches when only the metadata trailer differs at equal length', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const replayed = withImmutable(IMMUTABLE_WORD, 'a164736f6c634300081c000a')

    const result = await verify(
      observed,
      evmReturning(replayed),
      attesting(replayed)
    )

    expect(result.decided).toBe(true)
    if (!result.decided) return
    expect(result.comparison.verdict).toBe('MATCH')
    expect(result.comparison.excludedByteCount).toBe(0)
  })
})

describe('the attested-build precondition', () => {
  it('refuses when the replayed code normalises to no attested build', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const otherBody = `0x${'11'.repeat(32)}${IMMUTABLE_WORD}${TRAILER_12}`

    const result = await verify(
      honest,
      evmReturning(honest),
      attesting(otherBody)
    )

    expect(result.decided).toBe(false)
    if (result.decided) return
    expect(result.reason).toContain('no attested build')
  })

  it('does not see a constructor that differs only in what it writes to an immutable', async () => {
    const attested = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const tampered = withImmutable(TAMPERED_WORD, TRAILER_12)

    const result = await verify(
      tampered,
      evmReturning(tampered),
      attesting(attested)
    )

    expect(result.decided).toBe(true)
    if (!result.decided) return
    expect(result.comparison.verdict).toBe('MATCH')
  })

  it('refuses against an empty attested set rather than taking the match on trust', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(honest, evmReturning(honest), [])

    expect(result.decided).toBe(false)
  })

  it('refuses an attested build that strips to the same body at another length', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(
      honest,
      evmReturning(honest),
      attesting(withImmutable(IMMUTABLE_WORD, TRAILER_16))
    )

    expect(result.decided).toBe(false)
  })

  it('refuses a replay whose immutable ranges do not fit the code', async () => {
    const result = await verifyByConstructorReplay(
      {
        observedRuntimeCode: withImmutable(IMMUTABLE_WORD, TRAILER_12),
        creationCode: CREATION_CODE,
        chainId: 42161,
        attestedBuilds: attesting(withImmutable(IMMUTABLE_WORD, TRAILER_12)),
        immutableReferences: { '1': [{ start: 4096, length: 32 }] },
        expectedArgs: DERIVED,
      },
      evmReturning(withImmutable(IMMUTABLE_WORD, TRAILER_12))
    )

    expect(result.decided).toBe(false)
    if (result.decided) return
    expect(result.reason).toContain('normalised')
  })
})

describe('when an immutable does not hold what config declares', () => {
  it('blocks signing on the immutable bytes alone', async () => {
    const observed = withImmutable(TAMPERED_WORD, TRAILER_12)
    const replayed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(
      observed,
      evmReturning(replayed),
      attesting(replayed)
    )

    expect(result.decided).toBe(true)
    if (!result.decided) return
    expect(result.comparison.verdict).toBe('MISMATCH')
    expect(result.comparison.blocksSigning).toBe(true)
  })
})

describe('when the constructor stores where it was deployed', () => {
  it('refuses instead of blocking, because a replay cannot land where the deployment did', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const first = withImmutable(TAMPERED_WORD, TRAILER_12)
    const evm = evmAnswering([
      { ok: true, runtimeCode: first },
      { ok: true, runtimeCode: withImmutable(OTHER_WORD, TRAILER_12) },
    ])

    const result = await verify(observed, evm, attesting(first))

    expect(result.decided).toBe(false)
    if (result.decided) return
    expect(result.reason).toContain('two local replays')
    expect(evm.calls).toHaveLength(2)
  })

  it('reports undecided when the constructor ran once but not a second time', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const first = withImmutable(TAMPERED_WORD, TRAILER_12)
    const evm = evmAnswering([
      { ok: true, runtimeCode: first },
      { ok: false, reason: 'the constructor reverted on the local EVM' },
    ])

    const result = await verify(observed, evm, attesting(first))

    expect(result.decided).toBe(false)
    if (result.decided) return
    expect(result.reason).toContain('not a second time')
  })

  it('spends no second replay on a deployment that already matched', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const evm = evmReturning(honest)

    await verify(honest, evm, attesting(honest))

    expect(evm.calls).toHaveLength(1)
  })
})

describe('the deployed-length pin', () => {
  it('refuses a deployment that strips to the attested body at another length', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_16)
    const replayed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(
      observed,
      evmReturning(replayed),
      attesting(replayed)
    )

    expect(result.decided).toBe(true)
    if (!result.decided) return
    expect(result.comparison.verdict).toBe('MISMATCH')
    expect(result.comparison.reason).toContain('not accounted for')
  })
})

describe('when the immutables cannot be reconstructed', () => {
  it('reports undecided and never runs the local EVM', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const evm = evmReturning(observed)

    const result = await verify(observed, evm, attesting(observed), {
      ok: false,
      reason: 'EcoFacet constructor arg _backendSigner is not annotated',
    })

    expect(result.decided).toBe(false)
    expect(evm.calls).toEqual([])
  })

  it('carries the derivation refusal into the signer-facing line', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(
      observed,
      evmReturning(observed),
      attesting(observed),
      {
        ok: false,
        reason: 'EcoFacet constructor arg _backendSigner is not annotated',
      }
    )

    expect(result.decided).toBe(false)
    if (result.decided) return
    expect(result.reason).toContain('_backendSigner')
  })

  it('reports undecided when the local EVM could not run the constructor', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(
      observed,
      evmFailing('the constructor reverted on the local EVM'),
      attesting(observed)
    )

    expect(result.decided).toBe(false)
    if (result.decided) return
    expect(result.reason).toContain('reverted')
  })

  it('reports undecided when the replay returns code that is not bytes', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(
      observed,
      evmReturning('0xabc'),
      attesting(observed)
    )

    expect(result.decided).toBe(false)
    if (result.decided) return
    expect(result.reason).toContain('replayed code')
  })

  it('reports undecided for empty deployed code rather than matching empty against empty', async () => {
    const result = await verify(
      '0x',
      evmReturning('0x'),
      attesting(withImmutable(IMMUTABLE_WORD, TRAILER_12))
    )

    expect(result.decided).toBe(false)
    if (result.decided) return
    expect(result.reason).toContain('deployed code')
  })
})

describe('what this layer never does', () => {
  it('reports zero excluded bytes on every verdict it reaches', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const results = await Promise.all([
      verify(honest, evmReturning(honest), attesting(honest)),
      verify(
        withImmutable(TAMPERED_WORD, TRAILER_12),
        evmReturning(honest),
        attesting(honest)
      ),
      verify(honest, evmFailing('anvil did not come up'), attesting(honest)),
      verify(honest, evmReturning(honest), attesting(honest), {
        ok: false,
        reason: 'no config',
      }),
    ])

    const reached = results.flatMap((result) =>
      result.decided ? [result.comparison] : []
    )

    expect(reached.map((comparison) => comparison.verdict)).toEqual([
      'MATCH',
      'MISMATCH',
    ])
    expect(reached.map((comparison) => comparison.excludedByteCount)).toEqual([
      0, 0,
    ])
  })

  it('leaves the masking path to run wherever it reached no verdict about the code', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const results = await Promise.all([
      verify(honest, evmReturning(honest), attesting(honest)),
      verify(
        withImmutable(TAMPERED_WORD, TRAILER_12),
        evmReturning(honest),
        attesting(honest)
      ),
      verify(honest, evmFailing('anvil did not come up'), attesting(honest)),
      verify(honest, evmReturning(honest), attesting(honest), {
        ok: false,
        reason: 'no config',
      }),
    ])

    expect(results.map((result) => result.decided)).toEqual([
      true,
      true,
      false,
      false,
    ])
  })
})
