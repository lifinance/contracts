/**
 * Bytecode fixtures are crafted rather than measured, because what is under
 * test is which byte ranges decide a verdict. `TRAILER_12` and `TRAILER_16` are
 * both well-formed solc metadata trailers over the same declared version
 * (0.8.29) differing only in length, so a pair built from them strips to the
 * same body at two different deployed lengths — the case the `rawByteLength`
 * pin exists for. Both were checked against `readMetadataTrailer`.
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

import { verifyByConstructorReplay } from './constructor-replay'
import type {
  IConstructorReplayDeps,
  IReplayRequest,
  ReplayOutcome,
} from './constructor-replay'
import type { ExpectedArgs } from './expected-constructor-args'

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
  expectedArgs: ExpectedArgs = DERIVED
) =>
  verifyByConstructorReplay(
    {
      lineage: 'upstream cancun',
      observedRuntimeCode,
      creationCode: CREATION_CODE,
      chainId: 42161,
      expectedArgs,
    },
    deps
  )

describe('when the replay reproduces the deployed bytes', () => {
  it('matches on every byte and excludes none', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(honest, evmReturning(honest))

    expect(result.comparison.verdict).toBe('MATCH')
    expect(result.comparison.excludedByteCount).toBe(0)
    expect(result.comparison.blocksSigning).toBe(false)
    expect(result.fallsBackToMasking).toBe(false)
    expect(result.comparison.matchedLineages).toEqual(['upstream cancun'])
  })

  it('passes the local EVM our creation code and the derived args, nothing else', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const evm = evmReturning(honest)

    await verify(honest, evm)

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

    const result = await verify(observed, evmReturning(replayed))

    expect(result.comparison.verdict).toBe('MATCH')
    expect(result.comparison.excludedByteCount).toBe(0)
  })
})

describe('when an immutable does not hold what config declares', () => {
  it('blocks signing on the immutable bytes alone', async () => {
    const observed = withImmutable(TAMPERED_WORD, TRAILER_12)
    const replayed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(observed, evmReturning(replayed))

    expect(result.comparison.verdict).toBe('MISMATCH')
    expect(result.comparison.blocksSigning).toBe(true)
    expect(result.fallsBackToMasking).toBe(false)
  })
})

describe('when the constructor stores where it was deployed', () => {
  it('refuses instead of blocking, because a replay cannot land where the deployment did', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const evm = evmAnswering([
      { ok: true, runtimeCode: withImmutable(TAMPERED_WORD, TRAILER_12) },
      { ok: true, runtimeCode: withImmutable(OTHER_WORD, TRAILER_12) },
    ])

    const result = await verify(observed, evm)

    expect(result.comparison.verdict).toBe('UNVERIFIABLE')
    expect(result.fallsBackToMasking).toBe(true)
    expect(result.comparison.reason).toContain('two local replays')
    expect(evm.calls).toHaveLength(2)
  })

  it('reports UNVERIFIABLE when the constructor ran once but not a second time', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const evm = evmAnswering([
      { ok: true, runtimeCode: withImmutable(TAMPERED_WORD, TRAILER_12) },
      { ok: false, reason: 'the constructor reverted on the local EVM' },
    ])

    const result = await verify(observed, evm)

    expect(result.comparison.verdict).toBe('UNVERIFIABLE')
    expect(result.fallsBackToMasking).toBe(true)
    expect(result.comparison.reason).toContain('not a second time')
  })

  it('spends no second replay on a deployment that already matched', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const evm = evmReturning(honest)

    await verify(honest, evm)

    expect(evm.calls).toHaveLength(1)
  })
})

describe('the deployed-length pin', () => {
  it('refuses a deployment that strips to the attested body at another length', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_16)
    const replayed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(observed, evmReturning(replayed))

    expect(result.comparison.verdict).toBe('MISMATCH')
    expect(result.comparison.reason).toContain('not accounted for')
  })
})

describe('when the immutables cannot be reconstructed', () => {
  it('reports UNVERIFIABLE and never runs the local EVM', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const evm = evmReturning(observed)

    const result = await verify(observed, evm, {
      ok: false,
      reason: 'EcoFacet constructor arg _backendSigner is not annotated',
    })

    expect(result.comparison.verdict).toBe('UNVERIFIABLE')
    expect(result.comparison.blocksSigning).toBe(true)
    expect(result.fallsBackToMasking).toBe(true)
    expect(evm.calls).toEqual([])
  })

  it('carries the derivation refusal into the signer-facing line', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(observed, evmReturning(observed), {
      ok: false,
      reason: 'EcoFacet constructor arg _backendSigner is not annotated',
    })

    expect(result.comparison.reason).toContain('_backendSigner')
  })

  it('reports UNVERIFIABLE when the local EVM could not run the constructor', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(
      observed,
      evmFailing('the constructor reverted on the local EVM')
    )

    expect(result.comparison.verdict).toBe('UNVERIFIABLE')
    expect(result.fallsBackToMasking).toBe(true)
    expect(result.comparison.reason).toContain('reverted')
  })

  it('reports UNVERIFIABLE when the replay returns code that is not bytes', async () => {
    const observed = withImmutable(IMMUTABLE_WORD, TRAILER_12)

    const result = await verify(observed, evmReturning('0xabc'))

    expect(result.comparison.verdict).toBe('UNVERIFIABLE')
    expect(result.comparison.reason).toContain('replayed code')
  })

  it('reports UNVERIFIABLE for empty deployed code rather than matching empty against empty', async () => {
    const result = await verify('0x', evmReturning('0x'))

    expect(result.comparison.verdict).toBe('UNVERIFIABLE')
    expect(result.comparison.reason).toContain('deployed code')
  })
})

describe('what this layer never does', () => {
  it('reports zero excluded bytes on every verdict it reaches', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const results = await Promise.all([
      verify(honest, evmReturning(honest)),
      verify(withImmutable(TAMPERED_WORD, TRAILER_12), evmReturning(honest)),
      verify(honest, evmFailing('anvil did not come up')),
      verify(honest, evmReturning(honest), { ok: false, reason: 'no config' }),
    ])

    expect(results.map((r) => r.comparison.excludedByteCount)).toEqual([
      0, 0, 0, 0,
    ])
    expect(results.map((r) => r.comparison.verdict)).toEqual([
      'MATCH',
      'MISMATCH',
      'UNVERIFIABLE',
      'UNVERIFIABLE',
    ])
  })

  it('falls back to masking only where it reached no verdict about the code', async () => {
    const honest = withImmutable(IMMUTABLE_WORD, TRAILER_12)
    const results = await Promise.all([
      verify(honest, evmReturning(honest)),
      verify(withImmutable(TAMPERED_WORD, TRAILER_12), evmReturning(honest)),
      verify(honest, evmFailing('anvil did not come up')),
      verify(honest, evmReturning(honest), { ok: false, reason: 'no config' }),
    ])

    expect(results.map((r) => r.fallsBackToMasking)).toEqual([
      false,
      false,
      true,
      true,
    ])
  })
})
