/**
 * Tests for the timelock watcher's per-operation checks and verdict. Every
 * failing case is paired with the same input minus the defect, so a check that
 * always fails, or never does, cannot pass.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  numberToHex,
  toHex,
  pad,
  parseAbi,
  parseAbiItem,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem'

import type { IGateReport } from '../codehash/verify-cut-targets'

import type { IPreBroadcastGateResult } from './prebroadcast-rederive'
import type { ICollectedDiamondCuts } from './safe-decode-utils'
import { evaluateCancelDecision } from './timelock-cancel-decision'
import {
  recomputeOperationIds,
  type IScannedOperation,
} from './timelock-watcher-scan'
import {
  REQUIRED_CHECKS,
  buildWatcherCancelInput,
  classifyOperation,
  gradeAuthorities,
  gradeAuthority,
  gradeCodehash,
  gradeDelay,
  gradeDelegatecall,
  gradeIdentity,
  gradeState,
  gradeTargets,
  installsCode,
  stageOf,
  type ICheckOutcome,
} from './timelock-watcher-verdict'

const TIMELOCK: Address = '0x5604A94A3438C3074EFFF803fab14B7244fe4E29'
const DIAMOND: Address = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE'
const SAFE: Address = '0x2deA87C92aAB9257409987A019be44ea9e774226'
const STRANGER: Address = '0x000000000000000000000000000000000000dEaD'
const DEPLOYER: Address = '0x11F1022cA6AdEF6400e5677528a80d49a069C00c'
const ZERO32: Hex = `0x${'0'.repeat(64)}`

const opOf = (
  calls: { target: Address; data: Hex; value?: bigint }[],
  overrides: Partial<IScannedOperation> = {}
): IScannedOperation => ({
  id: ZERO32,
  calls: calls.map((c, index) => ({
    index,
    target: c.target,
    value: (c.value ?? 0n).toString(),
    data: c.data,
  })),
  predecessor: ZERO32,
  delay: '10800',
  salt: pad('0x01', { size: 32 }),
  blockNumber: '1',
  ...overrides,
})

const allPass = (): ICheckOutcome[] =>
  REQUIRED_CHECKS.map((check) => ({ check, status: 'pass', detail: '' }))

describe('classifyOperation', () => {
  it('is ok when every required check passes', () => {
    expect(classifyOperation(allPass())).toEqual({ verdict: 'ok', reasons: [] })
  })

  it('is mismatch when any check fails, and names it', () => {
    const checks = allPass().map((c) =>
      c.check === 'targets'
        ? { ...c, status: 'fail' as const, detail: 'unknown target' }
        : c
    )
    expect(classifyOperation(checks)).toEqual({
      verdict: 'mismatch',
      reasons: ['targets: unknown target'],
    })
  })

  it('is unverified when a check could not run', () => {
    const checks = allPass().map((c) =>
      c.check === 'codehash'
        ? { ...c, status: 'unknown' as const, detail: 'rpc down' }
        : c
    )
    expect(classifyOperation(checks).verdict).toBe('unverified')
  })

  it('lets a failure outrank an unknown', () => {
    const checks = allPass().map((c) =>
      c.check === 'codehash'
        ? { ...c, status: 'unknown' as const }
        : c.check === 'delay'
        ? { ...c, status: 'fail' as const }
        : c
    )
    expect(classifyOperation(checks).verdict).toBe('mismatch')
  })

  it('treats a missing check as unknown, never as ok', () => {
    const checks = allPass().filter((c) => c.check !== 'authorities')
    const result = classifyOperation(checks)
    expect(result.verdict).toBe('unverified')
    expect(result.reasons[0]).toContain('authorities')
  })

  it('treats a skipped check as no objection', () => {
    const checks = allPass().map((c) =>
      c.check === 'codehash' ? { ...c, status: 'skip' as const } : c
    )
    expect(classifyOperation(checks).verdict).toBe('ok')
  })
})

describe('gradeIdentity', () => {
  const op = opOf([{ target: DIAMOND, data: '0x12345678' }])
  const ids = recomputeOperationIds(op)

  it('passes when the logged id is the batch hash', () => {
    if (!ids) throw new Error('fixture must recompute')
    const graded = gradeIdentity(ids.batch, ids)
    expect(graded.outcome.status).toBe('pass')
    expect(graded.leg).toBe('match')
  })

  it('passes when the logged id is the single-call hash', () => {
    if (!ids?.single) throw new Error('fixture must recompute a single id')
    expect(gradeIdentity(ids.single, ids).outcome.status).toBe('pass')
  })

  it('fails when the logged id is neither', () => {
    const graded = gradeIdentity(pad('0xbad', { size: 32 }), ids)
    expect(graded.outcome.status).toBe('fail')
    expect(graded.leg).toBe('mismatch')
  })

  it('is unknown when the parameters are incomplete', () => {
    const [first] = op.calls
    if (!first) throw new Error('fixture must have a call')
    const gappy = { ...op, calls: [{ ...first, index: 1 }] }
    const graded = gradeIdentity(ZERO32, recomputeOperationIds(gappy))
    expect(graded.outcome.status).toBe('unknown')
    expect(graded.leg).toBe('error')
  })
})

describe('stageOf and gradeState', () => {
  it('maps getTimestamp onto the stage', () => {
    expect(stageOf(0n, 100n)).toBe('unset')
    expect(stageOf(1n, 100n)).toBe('done')
    expect(stageOf(100n, 100n)).toBe('ready')
    expect(stageOf(101n, 100n)).toBe('pending')
  })

  it('passes a live operation and names when it is executable', () => {
    const graded = gradeState('pending', 1_800_000_000n)
    expect(graded.status).toBe('pass')
    expect(graded.detail).toContain('2027-01-15')
  })

  it('fails an operation the timelock reports as executed', () => {
    expect(gradeState('done', 1n).status).toBe('fail')
  })

  it('is unknown, not failed, for a zero read no cancel explains', () => {
    const graded = gradeState('unset', 0n)
    expect(graded.status).toBe('unknown')
    expect(graded.detail).toContain('no Cancelled log')
  })

  it('is unknown when getTimestamp could not be read', () => {
    expect(gradeState(undefined, undefined).status).toBe('unknown')
  })
})

describe('gradeDelay', () => {
  const agreed = 10_800n
  const plain = opOf([{ target: DIAMOND, data: '0x12345678' }])

  it('passes a delay at the agreed minimum', () => {
    expect(gradeDelay(plain, agreed, agreed, TIMELOCK).status).toBe('pass')
  })

  it('fails a delay below the agreed minimum', () => {
    const short = { ...plain, delay: '10799' }
    expect(gradeDelay(short, agreed, agreed, TIMELOCK).status).toBe('fail')
  })

  it('fails when the live minimum was lowered', () => {
    const graded = gradeDelay(plain, agreed, 60n, TIMELOCK)
    expect(graded.status).toBe('fail')
    expect(graded.detail).toContain('60s')
  })

  it('fails an updateDelay that lowers the minimum, and not one that keeps it', () => {
    const encode = (seconds: bigint): Hex =>
      encodeFunctionData({
        abi: parseAbi(['function updateDelay(uint256)']),
        args: [seconds],
      })
    const lowering = opOf([{ target: TIMELOCK, data: encode(60n) }])
    const keeping = opOf([{ target: TIMELOCK, data: encode(agreed) }])
    expect(gradeDelay(lowering, agreed, agreed, TIMELOCK).status).toBe('fail')
    expect(gradeDelay(keeping, agreed, agreed, TIMELOCK).status).toBe('pass')
  })

  it('only reads updateDelay on the timelock itself', () => {
    const elsewhere = opOf([
      {
        target: DIAMOND,
        data: encodeFunctionData({
          abi: parseAbi(['function updateDelay(uint256)']),
          args: [60n],
        }),
      },
    ])
    expect(gradeDelay(elsewhere, agreed, agreed, TIMELOCK).status).toBe('pass')
  })

  it('fails a truncated updateDelay', () => {
    const truncated = opOf([{ target: TIMELOCK, data: '0x64d62353' }])
    expect(gradeDelay(truncated, agreed, agreed, TIMELOCK).status).toBe('fail')
  })

  it('is unknown when the live minimum could not be read', () => {
    expect(gradeDelay(plain, agreed, undefined, TIMELOCK).status).toBe(
      'unknown'
    )
  })
})

describe('gradeTargets', () => {
  const known = new Map([
    [DIAMOND.toLowerCase(), 'LiFiDiamond'],
    [SAFE.toLowerCase(), 'Safe'],
  ])

  it('passes calls to known addresses and names them', () => {
    const graded = gradeTargets(
      opOf([
        { target: DIAMOND, data: '0x' },
        { target: SAFE, data: '0x' },
      ]),
      known
    )
    expect(graded.status).toBe('pass')
    expect(graded.detail).toBe('LiFiDiamond, Safe')
  })

  it('fails a call to an address main does not know', () => {
    const graded = gradeTargets(
      opOf([
        { target: DIAMOND, data: '0x' },
        { target: STRANGER, data: '0x' },
      ]),
      known
    )
    expect(graded.status).toBe('fail')
    expect(graded.detail).toContain(`1→${STRANGER}`)
  })
})

describe('gradeDelegatecall', () => {
  const execAbi = parseAbi([
    'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
  ])
  const exec = (operation: number, data: Hex = '0x'): Hex =>
    encodeFunctionData({
      abi: execAbi,
      args: [
        DIAMOND,
        0n,
        data,
        operation,
        0n,
        0n,
        0n,
        STRANGER,
        STRANGER,
        '0x',
      ],
    })
  const packed = (operation: number): Hex => {
    const inner: Hex = '0xabcdef'
    return concatHex([
      numberToHex(operation, { size: 1 }),
      DIAMOND,
      numberToHex(0n, { size: 32 }),
      numberToHex(3n, { size: 32 }),
      inner,
    ])
  }
  const multiSend = (operation: number): Hex =>
    encodeFunctionData({
      abi: parseAbi(['function multiSend(bytes transactions)']),
      args: [packed(operation)],
    })

  it('passes a plain call', () => {
    expect(
      gradeDelegatecall(opOf([{ target: DIAMOND, data: '0x12345678' }])).status
    ).toBe('pass')
  })

  it('fails a Safe execTransaction with operation 1, and passes operation 0', () => {
    expect(
      gradeDelegatecall(opOf([{ target: SAFE, data: exec(1) }])).status
    ).toBe('fail')
    expect(
      gradeDelegatecall(opOf([{ target: SAFE, data: exec(0) }])).status
    ).toBe('pass')
  })

  it('fails a multiSend carrying a delegatecall, and passes one that does not', () => {
    expect(
      gradeDelegatecall(opOf([{ target: SAFE, data: multiSend(1) }])).status
    ).toBe('fail')
    expect(
      gradeDelegatecall(opOf([{ target: SAFE, data: multiSend(0) }])).status
    ).toBe('pass')
  })

  it('reads a multiSend nested in execTransaction', () => {
    expect(
      gradeDelegatecall(opOf([{ target: SAFE, data: exec(0, multiSend(1)) }]))
        .status
    ).toBe('fail')
    expect(
      gradeDelegatecall(opOf([{ target: SAFE, data: exec(0, multiSend(0)) }]))
        .status
    ).toBe('pass')
  })

  it('is unknown for a malformed multiSend or an undecodable known selector', () => {
    const malformed = encodeFunctionData({
      abi: parseAbi(['function multiSend(bytes transactions)']),
      args: ['0x00'],
    })
    expect(
      gradeDelegatecall(opOf([{ target: SAFE, data: malformed }])).status
    ).toBe('unknown')
    expect(
      gradeDelegatecall(opOf([{ target: SAFE, data: '0x6a761202' }])).status
    ).toBe('unknown')
  })

  it('names a diamondCut _init delegatecall, and says nothing when _init is zero', () => {
    const cut = (init: Address): Hex =>
      encodeFunctionData({
        abi: parseAbi([
          'function diamondCut((address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)',
        ]),
        args: [[], init, '0x'],
      })
    const withInit = gradeDelegatecall(
      opOf([{ target: DIAMOND, data: cut(STRANGER) }])
    )
    expect(withInit.status).toBe('pass')
    expect(withInit.detail).toContain(STRANGER)
    const noInit = gradeDelegatecall(
      opOf([
        {
          target: DIAMOND,
          data: cut('0x0000000000000000000000000000000000000000'),
        },
      ])
    )
    expect(noInit.detail).toBe('no delegatecall-shaped payload')
  })
})

describe('gradeAuthority', () => {
  const known = new Map([
    [SAFE.toLowerCase(), 'Safe'],
    [TIMELOCK.toLowerCase(), 'LiFiTimelockController'],
  ])
  const call = (signature: string, args: readonly unknown[]): Hex => {
    const item = parseAbiItem(`function ${signature}`) as AbiFunction
    return encodeFunctionData({
      abi: [item],
      functionName: item.name,
      args,
    } as never)
  }
  const role = pad('0x01', { size: 32 })

  it('passes an operation that hands nothing to anyone', () => {
    expect(
      gradeAuthority(opOf([{ target: DIAMOND, data: '0x8da5cb5b' }]), known)
        .status
    ).toBe('pass')
  })

  it('fails ownership to an unknown address, and passes it to a known one', () => {
    const to = (who: Address) =>
      opOf([
        { target: DIAMOND, data: call('transferOwnership(address)', [who]) },
      ])
    expect(gradeAuthority(to(STRANGER), known).status).toBe('fail')
    const graded = gradeAuthority(to(SAFE), known)
    expect(graded.status).toBe('pass')
    expect(graded.detail).toContain('Safe')
  })

  it('fails a role granted to an unknown address, and passes one granted to a known one', () => {
    const grant = (who: Address) =>
      opOf([
        {
          target: TIMELOCK,
          data: call('grantRole(bytes32,address)', [role, who]),
        },
      ])
    expect(gradeAuthority(grant(STRANGER), known).status).toBe('fail')
    expect(gradeAuthority(grant(SAFE), known).status).toBe('pass')
  })

  it('fails an unknown executor, and ignores a revoked one', () => {
    const setExec = (on: boolean) =>
      opOf([
        {
          target: DIAMOND,
          data: call('setCanExecute(bytes4,address,bool)', [
            '0x12345678',
            STRANGER,
            on,
          ]),
        },
      ])
    expect(gradeAuthority(setExec(true), known).status).toBe('fail')
    expect(gradeAuthority(setExec(false), known).status).toBe('pass')
  })

  it('fails a withdrawal to an unknown address, and passes one to a known one', () => {
    const withdraw = (who: Address) =>
      opOf([
        {
          target: DIAMOND,
          data: call('withdraw(address,address,uint256)', [STRANGER, who, 1n]),
        },
      ])
    expect(gradeAuthority(withdraw(STRANGER), known).status).toBe('fail')
    expect(gradeAuthority(withdraw(SAFE), known).status).toBe('pass')
  })

  it('leaves an arbitrary call from the diamond unverified', () => {
    const op = opOf([
      {
        target: DIAMOND,
        data: call(
          'executeCallAndWithdraw(address,bytes,address,address,uint256)',
          [STRANGER, '0x', STRANGER, SAFE, 0n]
        ),
      },
    ])
    expect(gradeAuthority(op, known).status).toBe('unknown')
  })

  it('gives governing timelock roles only to the Safe or the timelock', () => {
    const proposer = keccak256(toHex('PROPOSER_ROLE'))
    const withHot = new Map([
      ...known,
      [DEPLOYER.toLowerCase(), 'deployerWallet'],
    ])
    const grant = (who: Address) =>
      opOf([
        {
          target: TIMELOCK,
          data: call('grantRole(bytes32,address)', [proposer, who]),
        },
      ])
    expect(gradeAuthority(grant(DEPLOYER), withHot).status).toBe('fail')
    expect(gradeAuthority(grant(SAFE), withHot).status).toBe('pass')
  })

  it('leaves a canceller grant to a not-yet-known address unverified, not failed', () => {
    const canceller = keccak256(toHex('CANCELLER_ROLE'))
    const op = opOf([
      {
        target: TIMELOCK,
        data: call('grantRole(bytes32,address)', [canceller, STRANGER]),
      },
    ])
    expect(gradeAuthority(op, known).status).toBe('unknown')
  })

  it('leaves ownership to a known address that is not an owner unverified', () => {
    const withHot = new Map([
      ...known,
      [DEPLOYER.toLowerCase(), 'deployerWallet'],
    ])
    const op = opOf([
      { target: DIAMOND, data: call('transferOwnership(address)', [DEPLOYER]) },
    ])
    expect(gradeAuthority(op, withHot).status).toBe('unknown')
  })

  it('reads an authority call made from a diamondCut _init', () => {
    const cutWith = (to: Address) =>
      call('diamondCut((address,uint8,bytes4[])[],address,bytes)', [
        [],
        STRANGER,
        call('transferOwnership(address)', [to]),
      ])
    const attack = gradeAuthority(
      opOf([{ target: DIAMOND, data: cutWith(STRANGER) }]),
      known
    )
    expect(attack.status).toBe('fail')
    expect(attack.detail).toContain('_init')
    expect(
      gradeAuthority(
        opOf([{ target: DIAMOND, data: cutWith(TIMELOCK) }]),
        known
      ).status
    ).toBe('pass')
  })

  it('counts an address the operation installs as known', () => {
    const op = opOf([
      {
        target: DIAMOND,
        data: call('setCanExecute(bytes4,address,bool)', [
          '0x12345678',
          STRANGER,
          true,
        ]),
      },
    ])
    expect(gradeAuthority(op, known).status).toBe('fail')
    expect(
      gradeAuthority(op, known, new Set([STRANGER.toLowerCase()])).status
    ).toBe('pass')
  })

  it('is unknown for a truncated authority call', () => {
    expect(
      gradeAuthority(opOf([{ target: DIAMOND, data: '0xf2fde38b' }]), known)
        .status
    ).toBe('unknown')
  })
})

describe('gradeAuthorities', () => {
  const result = (
    disposition: IPreBroadcastGateResult['disposition']
  ): IPreBroadcastGateResult => ({
    disposition,
    reason: `${disposition} reason`,
    findings: disposition === 'PROCEED' ? [] : [`${disposition} finding`],
    alerts: [],
    blocksBroadcast: disposition !== 'PROCEED',
  })

  it('maps PROCEED, BLOCK and HOLD onto pass, fail and unknown', () => {
    expect(gradeAuthorities(result('PROCEED')).status).toBe('pass')
    expect(gradeAuthorities(result('BLOCK'))).toEqual({
      check: 'authorities',
      status: 'fail',
      detail: 'BLOCK finding',
    })
    expect(gradeAuthorities(result('HOLD')).status).toBe('unknown')
  })

  it('is unknown when the gate could not run', () => {
    expect(gradeAuthorities({ error: 'rpc down' }).status).toBe('unknown')
  })
})

describe('gradeCodehash', () => {
  const collected = (
    overrides: Partial<ICollectedDiamondCuts> = {}
  ): ICollectedDiamondCuts => ({
    calls: [],
    registrations: [],
    refusals: [],
    unopened: [],
    knownCalls: [],
    ...overrides,
  })
  const report = (
    verdicts: ('MATCH' | 'MISMATCH' | 'UNVERIFIABLE')[],
    refusals: string[] = []
  ): IGateReport => ({
    blocksSigning: verdicts.some((v) => v !== 'MATCH'),
    refusals,
    summary: '',
    targets: verdicts.map((verdict, i) => ({
      address: `0x${String(i).padStart(40, '0')}`,
      verdict,
      reason: verdict.toLowerCase(),
      matchedLineages: [],
      excludedByteCount: 0,
      pricedByteCount: 0,
      immutables: {} as IGateReport['targets'][number]['immutables'],
    })),
  })

  it('knows when an operation installs code', () => {
    expect(installsCode(collected())).toBe(false)
    expect(
      installsCode(collected({ calls: [{ cuts: [], init: STRANGER }] }))
    ).toBe(true)
    expect(
      installsCode(
        collected({ registrations: [{ name: 'X', address: STRANGER }] })
      )
    ).toBe(true)
    expect(installsCode(collected({ refusals: ['undecodable cut'] }))).toBe(
      true
    )
  })

  it('passes an operation installing nothing, and says what it could not open', () => {
    expect(
      gradeCodehash({ kind: 'not-applicable', collected: collected() }).detail
    ).toBe('installs no code')
    expect(
      gradeCodehash({
        kind: 'not-applicable',
        collected: collected({ unopened: ['0xdeadbeef'] }),
      }).detail
    ).toContain('0xdeadbeef')
  })

  it('passes when every target matches', () => {
    expect(
      gradeCodehash({
        kind: 'evaluated',
        collected: collected(),
        reports: [report(['MATCH', 'MATCH'])],
      }).status
    ).toBe('pass')
  })

  it('fails when a target mismatches', () => {
    expect(
      gradeCodehash({
        kind: 'evaluated',
        collected: collected(),
        reports: [report(['MATCH', 'MISMATCH'])],
      }).status
    ).toBe('fail')
  })

  it('is unknown for an unverifiable target or a refusal', () => {
    expect(
      gradeCodehash({
        kind: 'evaluated',
        collected: collected(),
        reports: [report(['MATCH', 'UNVERIFIABLE'])],
      }).status
    ).toBe('unknown')
    expect(
      gradeCodehash({
        kind: 'evaluated',
        collected: collected({ refusals: ['undecodable cut'] }),
        reports: [report(['MATCH'])],
      }).status
    ).toBe('unknown')
  })

  it('is unknown when deferred or failed, and replays a cached result', () => {
    expect(gradeCodehash({ kind: 'deferred', reason: 'budget' }).status).toBe(
      'unknown'
    )
    expect(gradeCodehash({ kind: 'error', reason: 'forge' }).status).toBe(
      'unknown'
    )
    expect(
      gradeCodehash({ kind: 'cached', status: 'fail', detail: 'x' }).status
    ).toBe('fail')
    expect(
      gradeCodehash({ kind: 'cached', status: 'pass', detail: 'x' }).status
    ).toBe('pass')
  })
})

describe('buildWatcherCancelInput', () => {
  const pass = (check: ICheckOutcome['check']): ICheckOutcome => ({
    check,
    status: 'pass',
    detail: '',
  })

  it('carries a proven integrity divergence into the matrix', () => {
    const input = buildWatcherCancelInput({
      identity: 'match',
      codehash: { check: 'codehash', status: 'fail', detail: '' },
      authorities: pass('authorities'),
      stage: 'pending',
      signTimeRecordPresent: false,
    })
    expect(input.integrity).toBe('mismatch')
    expect(input.operationState).toBe('pending')
    expect(evaluateCancelDecision(input).action).not.toBe('execute')
  })

  it('reports an unreadable leg as an error, not a match', () => {
    const input = buildWatcherCancelInput({
      identity: 'match',
      codehash: pass('codehash'),
      authorities: { check: 'authorities', status: 'unknown', detail: '' },
      stage: undefined,
      signTimeRecordPresent: true,
    })
    expect(input.integrity).toBe('error')
    expect(input.operationState).toBe('unset')
    expect(input.signTimeVerdictRecord).toBe('present')
  })

  it('reports clean legs as a match', () => {
    const input = buildWatcherCancelInput({
      identity: 'match',
      codehash: pass('codehash'),
      authorities: pass('authorities'),
      stage: 'ready',
      signTimeRecordPresent: true,
    })
    expect(input.integrity).toBe('match')
    expect(input.deploymentRecord).toBe('present')
  })
})

describe('recomputeOperationIds', () => {
  it('matches the encoding OZ hashes for a batch', () => {
    const op = opOf([
      { target: DIAMOND, data: '0x12' },
      { target: SAFE, data: '0x34', value: 5n },
    ])
    const ids = recomputeOperationIds(op)
    expect(ids?.single).toBeUndefined()
    expect(ids?.batch).toMatch(/^0x[0-9a-f]{64}$/)
    const reordered = { ...op, calls: [...op.calls].reverse() }
    expect(recomputeOperationIds(reordered)).toBeUndefined()
  })

  it('offers the single-call hash only for one call', () => {
    const ids = recomputeOperationIds(opOf([{ target: DIAMOND, data: '0x12' }]))
    expect(ids?.single).toMatch(/^0x[0-9a-f]{64}$/)
    expect(ids?.single).not.toBe(ids?.batch)
  })

  it('refuses an operation with no calls', () => {
    expect(recomputeOperationIds(opOf([]))).toBeUndefined()
  })

  it('hashes the single form exactly as abi.encode(target, value, data, predecessor, salt)', () => {
    const op = opOf([{ target: DIAMOND, data: '0x12' }])
    const encoded = encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes' },
        { type: 'bytes32' },
        { type: 'bytes32' },
      ],
      [DIAMOND, 0n, '0x12', op.predecessor, op.salt]
    )
    expect(recomputeOperationIds(op)?.single).toBe(keccak256(encoded))
  })
})
