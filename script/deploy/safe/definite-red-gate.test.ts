// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import type { ImmutableVerdictStatus } from '../codehash/immutable-verdict'
import type { ITargetVerdict } from '../codehash/verify-cut-targets'

import type { ICodehashSignGate } from './codehash-sign-gate'
import {
  assertNoDefiniteRed,
  definiteRedGates,
  evaluateDefiniteReds,
  executabilityDefiniteReds,
  immutablesDefiniteReds,
  rpcQuorumDefiniteReds,
  storageAuthorityDefiniteReds,
  type IDefiniteRedVerdict,
} from './definite-red-gate'
import type {
  IExecutabilityCall,
  IExecutabilityVerdict,
  TCallOutcome,
} from './executability-simulation'
import {
  evaluateRpcQuorum,
  type IProviderObservation,
  type IRpcQuorumVerdict,
  type TQuorumStatus,
} from './rpc-quorum'
import type { ISignedAuthorityEntry } from './signed-set-record'

const KEY = '0xdiamond|0|0xdeadbeef|0|7'
const OTHER_KEY = '0xdiamond|0|0xdeadbeef|0|8'

const OWNER = '0x1111111111111111111111111111111111111111'
const DRIFTED = '0x000000000000000000000000000000000000dEaD'

const authority = (
  overrides: Partial<ISignedAuthorityEntry> = {}
): ISignedAuthorityEntry => ({
  label: 'TokenWrapper.owner',
  liveValue: OWNER,
  expectedValue: OWNER,
  readError: undefined,
  ...overrides,
})

const call = (outcome: TCallOutcome, path = 'call[0]'): IExecutabilityCall => ({
  path,
  description: 'diamondCut',
  target: OWNER,
  modelled: true,
  simulation: outcome === 'unknown' ? 'none' : 'succeeded',
  findings: [],
  outcome,
})

const simulation = (
  calls: IExecutabilityCall[],
  overrides: Partial<IExecutabilityVerdict> = {}
): IExecutabilityVerdict => ({
  refuses: calls.some((one) => one.outcome === 'would-revert'),
  error: calls.some((one) => one.outcome === 'unknown'),
  findings: [],
  errors: [],
  warnings: [],
  notSimulated: [],
  calls,
  reason: '',
  ...overrides,
})

const CODE = '0x6080604052348015'
const OTHER_CODE = '0xdeadbeefdeadbeef'
const BLOCK = 21_000_000n
const HASH =
  '0xaaaa000000000000000000000000000000000000000000000000000000000001'
const OTHER_HASH =
  '0xbbbb000000000000000000000000000000000000000000000000000000000002'
const PROVIDER_A = 'https://eth-mainnet.g.alchemy.com/v2/key-one'
const PROVIDER_B = 'https://mainnet.infura.io/v3/key-two'
const PROVIDER_A_SECOND_ENDPOINT = 'https://polygon.g.alchemy.com/v2/key-one'

const answered = (
  endpointUrl: string,
  overrides: Partial<IProviderObservation> = {}
): IProviderObservation => ({
  endpointUrl,
  outcome: 'ok',
  value: CODE,
  blockNumber: BLOCK,
  blockHash: HASH,
  ...overrides,
})

const unreachable = (endpointUrl: string): IProviderObservation => ({
  endpointUrl,
  outcome: 'error',
  error: 'fetch failed',
})

const target = (
  status: ImmutableVerdictStatus | string,
  address = OWNER
): ITargetVerdict =>
  ({
    address,
    verdict: 'MATCH',
    reason: '',
    matchedLineages: [],
    excludedByteCount: 32,
    pricedByteCount: 32,
    immutables: { status, detail: `${address}: ${status}` },
  } as ITargetVerdict)

const gateWith = (targets: ITargetVerdict[]): ICodehashSignGate => ({
  blocksSigning: false,
  evaluated: true,
  refusals: [],
  targets,
  summary: '',
})

describe('gate G: a declared authority read and found different', () => {
  it('blocks on a live value that differs from the declared one', () => {
    const reds = storageAuthorityDefiniteReds([
      authority({ liveValue: DRIFTED }),
    ])
    expect(reds).toHaveLength(1)
    expect(reds[0]?.gate).toBe('G')
    expect(reds[0]?.reason).toContain(DRIFTED)
  })

  it('passes a value that matches, compared as the registry compares it', () => {
    // The present half of the pair above: the same entry, matching.
    expect(storageAuthorityDefiniteReds([authority()])).toEqual([])
    expect(
      storageAuthorityDefiniteReds([
        authority({
          liveValue: ` ${OWNER.toUpperCase().replace('0X', '0x')} `,
        }),
      ])
    ).toEqual([])
  })

  it('leaves an unread value, a missing expectation and no observation advisory', () => {
    expect(
      storageAuthorityDefiniteReds([
        authority({ liveValue: undefined, readError: 'rpc timeout' }),
      ])
    ).toEqual([])
    expect(
      storageAuthorityDefiniteReds([authority({ liveValue: undefined })])
    ).toEqual([])
    expect(
      storageAuthorityDefiniteReds([
        authority({ liveValue: DRIFTED, expectedValue: undefined }),
      ])
    ).toEqual([])
    expect(storageAuthorityDefiniteReds(undefined)).toEqual([])
    expect(storageAuthorityDefiniteReds([])).toEqual([])
  })

  it('blocks on a mismatch even beside an unread entry', () => {
    // The registry's row reduces this pair to one status; the decision must
    // not inherit a reduction in which the unread entry could win.
    const reds = storageAuthorityDefiniteReds([
      authority({ label: 'A.owner', liveValue: undefined, readError: 'x' }),
      authority({ label: 'B.owner', liveValue: DRIFTED }),
    ])
    expect(reds.map((red) => red.reason)).toEqual([
      `B.owner holds ${DRIFTED}, while ${OWNER} is declared`,
    ])
  })

  it('blocks on a value of a shape it cannot compare', () => {
    const reds = storageAuthorityDefiniteReds([
      authority({ liveValue: 42 as unknown as string }),
    ])
    expect(reds).toHaveLength(1)
  })
})

describe('gate I: the simulation ran and a call reverts', () => {
  it('blocks on a reverting call', () => {
    const reds = executabilityDefiniteReds(
      simulation([call('would-execute'), call('would-revert', 'call[1]')])
    )
    expect(reds).toEqual([{ gate: 'I', reason: 'call[1] would revert' }])
  })

  it('passes a simulation in which every call executes', () => {
    expect(
      executabilityDefiniteReds(
        simulation([call('would-execute'), call('would-execute', 'call[1]')])
      )
    ).toEqual([])
  })

  it('leaves an unmade simulation and an unsimulated call advisory', () => {
    expect(executabilityDefiniteReds(undefined)).toEqual([])
    expect(
      executabilityDefiniteReds(
        simulation([call('unknown')], { error: true, errors: ['no eth_call'] })
      )
    ).toEqual([])
  })

  it('does not block on a Safe-nonce finding, which keeps a queued proposal signable', () => {
    // `refuses` is true here because of the nonce, not because of any call.
    const queued = simulation([call('would-execute')], {
      refuses: true,
      reason: 'nonce already used',
    })
    expect(executabilityDefiniteReds(queued)).toEqual([])
  })

  it('blocks on a call outcome it does not recognise', () => {
    const reds = executabilityDefiniteReds(
      simulation([call('reverted-maybe' as TCallOutcome)])
    )
    expect(reds).toHaveLength(1)
    expect(reds[0]?.reason).toContain('does not recognise')
  })
})

describe('gate J: two or more providers answered and disagree', () => {
  it('blocks when two independent providers return different values', () => {
    const verdict = evaluateRpcQuorum([
      answered(PROVIDER_A),
      answered(PROVIDER_B, { value: OTHER_CODE }),
    ])
    expect(verdict.status).toBe('disagreement')
    expect(rpcQuorumDefiniteReds(verdict)).toHaveLength(1)
    expect(rpcQuorumDefiniteReds(verdict)[0]?.gate).toBe('J')
  })

  it('blocks when two independent providers are on different chains', () => {
    const verdict = evaluateRpcQuorum([
      answered(PROVIDER_A),
      answered(PROVIDER_B, { blockHash: OTHER_HASH }),
    ])
    expect(verdict.status).toBe('fork-divergence')
    expect(rpcQuorumDefiniteReds(verdict)).toHaveLength(1)
  })

  it('passes when the providers agree', () => {
    const verdict = evaluateRpcQuorum([
      answered(PROVIDER_A),
      answered(PROVIDER_B),
    ])
    expect(verdict.status).toBe('agreed')
    expect(rpcQuorumDefiniteReds(verdict)).toEqual([])
  })

  it('leaves one unreachable provider beside one that answered advisory', () => {
    const verdict = evaluateRpcQuorum([
      answered(PROVIDER_A),
      unreachable(PROVIDER_B),
    ])
    expect(verdict.status).toBe('insufficient-responses')
    expect(rpcQuorumDefiniteReds(verdict)).toEqual([])
  })

  it('leaves an unreachable provider advisory when the rest answered and agree', () => {
    // At a quorum of three, two agreeing providers answer and the third does
    // not: the responder floor alone would not keep this signable.
    const verdict = evaluateRpcQuorum(
      [
        answered(PROVIDER_A),
        answered(PROVIDER_B),
        unreachable('https://rpc.ankr.com/eth/key-three'),
      ],
      3
    )
    expect(verdict.status).toBe('insufficient-responses')
    expect(verdict.respondingProviders).toBe(2)
    expect(rpcQuorumDefiniteReds(verdict)).toEqual([])
  })

  it('leaves too few providers, no answers and an empty agreement advisory', () => {
    for (const verdict of [
      evaluateRpcQuorum([answered(PROVIDER_A)]),
      evaluateRpcQuorum([unreachable(PROVIDER_A), unreachable(PROVIDER_B)]),
      evaluateRpcQuorum([
        answered(PROVIDER_A, { value: '0x' }),
        answered(PROVIDER_B, { value: '0x' }),
      ]),
    ]) {
      expect(verdict.reachesQuorum).toBe(false)
      expect(rpcQuorumDefiniteReds(verdict)).toEqual([])
    }
    expect(rpcQuorumDefiniteReds(undefined)).toEqual([])
  })

  it('does not count two endpoints of one provider disagreeing as providers disagreeing', () => {
    const verdict = evaluateRpcQuorum([
      answered(PROVIDER_A),
      answered(PROVIDER_A_SECOND_ENDPOINT, { value: OTHER_CODE }),
    ])
    expect(verdict.status).toBe('disagreement')
    expect(verdict.respondingProviders).toBe(1)
    expect(rpcQuorumDefiniteReds(verdict)).toEqual([])
  })

  it('blocks on a status it does not recognise', () => {
    const verdict = {
      ...evaluateRpcQuorum([answered(PROVIDER_A), answered(PROVIDER_B)]),
      status: 'agreed-mostly' as TQuorumStatus,
    } as IRpcQuorumVerdict
    expect(rpcQuorumDefiniteReds(verdict)).toHaveLength(1)
  })

  it('does not read a status inherited from the prototype as a member', () => {
    const verdict = {
      ...evaluateRpcQuorum([answered(PROVIDER_A), answered(PROVIDER_B)]),
      status: 'toString' as TQuorumStatus,
    } as IRpcQuorumVerdict
    expect(rpcQuorumDefiniteReds(verdict)).toHaveLength(1)
  })
})

describe('gate L: an immutable compared and found different', () => {
  it('blocks on an address whose immutables disagree', () => {
    const reds = immutablesDefiniteReds(
      gateWith([target('verified'), target('disagrees', DRIFTED)])
    )
    expect(reds).toHaveLength(1)
    expect(reds[0]?.gate).toBe('L')
    expect(reds[0]?.reason).toContain(DRIFTED)
  })

  it('passes and leaves every other verdict advisory', () => {
    const advisory: ImmutableVerdictStatus[] = [
      'none',
      'verified',
      'unpriced',
      'documented',
      'assumed',
      'unreadable',
    ]
    for (const status of advisory)
      expect(immutablesDefiniteReds(gateWith([target(status)]))).toEqual([])
    expect(immutablesDefiniteReds(gateWith([]))).toEqual([])
  })

  it('blocks on a verdict it does not recognise, and on a target with none', () => {
    expect(
      immutablesDefiniteReds(gateWith([target('roughly-right')]))
    ).toHaveLength(1)
    const bare = {
      ...target('verified'),
      immutables: undefined,
    } as unknown as ITargetVerdict
    expect(immutablesDefiniteReds(gateWith([bare]))).toHaveLength(1)
  })
})

describe('the verdict over one proposal', () => {
  const clean = {
    gradedKey: KEY,
    storageAuthority: [authority()],
    executability: simulation([call('would-execute')]),
    rpcQuorum: evaluateRpcQuorum([answered(PROVIDER_A), answered(PROVIDER_B)]),
    codehash: gateWith([target('verified')]),
  }

  it('is empty on a clean proposal and carries its key', () => {
    const verdict = evaluateDefiniteReds(clean)
    expect(verdict.gradedKey).toBe(KEY)
    expect(verdict.reds).toEqual([])
    expect(definiteRedGates(verdict)).toEqual([])
  })

  it('collects every gate that is red, once each and in letter order', () => {
    const verdict = evaluateDefiniteReds({
      ...clean,
      storageAuthority: [authority({ liveValue: DRIFTED })],
      executability: simulation([
        call('would-revert'),
        call('would-revert', 'call[1]'),
      ]),
      rpcQuorum: evaluateRpcQuorum([
        answered(PROVIDER_A),
        answered(PROVIDER_B, { value: OTHER_CODE }),
      ]),
      codehash: gateWith([target('disagrees')]),
    })
    expect(definiteRedGates(verdict)).toEqual(['G', 'I', 'J', 'L'])
    expect(verdict.reds).toHaveLength(5)
  })
})

describe('the refusal inside the sign and execute funnels', () => {
  const red: IDefiniteRedVerdict = {
    gradedKey: KEY,
    reds: [{ gate: 'I', reason: 'call[0] would revert' }],
  }

  it('lets a clean verdict about this transaction through', () => {
    expect(() =>
      assertNoDefiniteRed({ gradedKey: KEY, reds: [] }, KEY)
    ).not.toThrow()
  })

  it('refuses a definite red, naming the gate and the reason', () => {
    expect(() => assertNoDefiniteRed(red, KEY)).toThrow(
      'Gate I: call[0] would revert.'
    )
  })

  it('refuses when nothing was evaluated', () => {
    expect(() => assertNoDefiniteRed(undefined, KEY)).toThrow('never evaluated')
  })

  it('refuses a clean verdict about another transaction', () => {
    expect(() =>
      assertNoDefiniteRed({ gradedKey: OTHER_KEY, reds: [] }, KEY)
    ).toThrow('different transaction')
  })
})
