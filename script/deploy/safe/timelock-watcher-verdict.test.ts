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
import { ZERO_ADDRESS } from '../shared/constants'

import { runPreBroadcastGate } from './prebroadcast-gate'
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
  confirmedScheduledAt,
  gradeAuthorities,
  gradeAuthority,
  gradeCodehash,
  gradeDelay,
  gradeDelegatecall,
  gradeIdentity,
  gradeState,
  gradeTargets,
  installedAddresses,
  installsCode,
  pendingRegistrationsOf,
  scheduledAtReaderFor,
  stageOf,
  type IAuthorityContext,
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

  it('hands gate G only a read the state check confirmed live', () => {
    expect(confirmedScheduledAt('pending', 1_800_000_000n)).toBe(1_800_000_000n)
    expect(confirmedScheduledAt('ready', 100n)).toBe(100n)
    expect(confirmedScheduledAt('unset', 0n)).toBeUndefined()
    expect(confirmedScheduledAt('done', 1n)).toBeUndefined()
    expect(confirmedScheduledAt(undefined, undefined)).toBeUndefined()
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
  const REFUND: Address = '0x156CeBba59DEB2cB23742F70dCb0a11cC775591F'
  const WITHDRAW: Address = '0x08647cc950813966142A416D40C382e2c5DB73bB'
  const PERIPHERY: Address = '0x0000000000000000000000000000000000001111'
  const FEE_COLLECTOR: Address = '0x0000000000000000000000000000000000002222'
  const OWNER_OF_FEES: Address = '0x0000000000000000000000000000000000003333'
  const SIGNER: Address = '0x0000000000000000000000000000000000004444'
  const known = new Map([
    [SAFE.toLowerCase(), 'Safe'],
    [TIMELOCK.toLowerCase(), 'LiFiTimelockController'],
    [DIAMOND.toLowerCase(), 'LiFiDiamond'],
    [DEPLOYER.toLowerCase(), 'deployerWallet'],
    [REFUND.toLowerCase(), 'refundWallet'],
    [WITHDRAW.toLowerCase(), 'withdrawWallet'],
    [PERIPHERY.toLowerCase(), 'ERC20Proxy'],
    [FEE_COLLECTOR.toLowerCase(), 'FeeCollector'],
    [OWNER_OF_FEES.toLowerCase(), 'feeCollectorOwner'],
  ])
  const context = { known, safeOwners: new Set([SIGNER.toLowerCase()]) }
  const call = (signature: string, args: readonly unknown[]): Hex => {
    const item = parseAbiItem(`function ${signature}`) as AbiFunction
    return encodeFunctionData({
      abi: [item],
      functionName: item.name,
      args,
    } as never)
  }
  const one = (target: Address, data: Hex) => opOf([{ target, data }])
  const grade = (
    target: Address,
    data: Hex,
    ctx: IAuthorityContext = context
  ) => gradeAuthority(one(target, data), ctx).status
  const role = (name: string) => keccak256(toHex(name))
  const owner = (to: Address) => call('transferOwnership(address)', [to])
  const grant = (name: string, to: Address) =>
    call('grantRole(bytes32,address)', [role(name), to])

  it('passes an operation that hands nothing to anyone', () => {
    expect(grade(DIAMOND, '0x8da5cb5b')).toBe('pass')
  })

  it('lets the diamond be owned by the timelock only', () => {
    expect(grade(DIAMOND, owner(TIMELOCK))).toBe('pass')
    expect(grade(DIAMOND, owner(REFUND))).toBe('unknown')
    expect(grade(DIAMOND, owner(STRANGER))).toBe('fail')
  })

  it('lets a periphery be owned by the timelock, the Safe or the refund wallet', () => {
    expect(grade(PERIPHERY, owner(REFUND))).toBe('pass')
    expect(grade(PERIPHERY, owner(SAFE))).toBe('pass')
    expect(grade(PERIPHERY, owner(DEPLOYER))).toBe('unknown')
    expect(grade(PERIPHERY, owner(STRANGER))).toBe('fail')
  })

  it('lets the withdraw wallet own only the fee contracts deployed that way', () => {
    expect(grade(FEE_COLLECTOR, owner(WITHDRAW))).toBe('pass')
    expect(grade(PERIPHERY, owner(WITHDRAW))).toBe('unknown')
    expect(grade(DIAMOND, owner(WITHDRAW))).toBe('unknown')
  })

  it('gives the executor role to a known wallet, and leaves an unknown one unverified', () => {
    expect(grade(TIMELOCK, grant('EXECUTOR_ROLE', DEPLOYER))).toBe('pass')
    expect(grade(TIMELOCK, grant('EXECUTOR_ROLE', STRANGER))).toBe('unknown')
  })

  it('treats a fee forwarder like a fee collector', () => {
    const FORWARDER: Address = '0x0000000000000000000000000000000000005555'
    const ctx = {
      ...context,
      known: new Map([...known, [FORWARDER.toLowerCase(), 'FeeForwarder']]),
    }
    expect(grade(FORWARDER, owner(WITHDRAW), ctx)).toBe('pass')
    expect(grade(FORWARDER, owner(REFUND), ctx)).toBe('unknown')
  })

  it('does not let a fee collector be owned by the refund wallet', () => {
    expect(grade(FEE_COLLECTOR, owner(OWNER_OF_FEES))).toBe('pass')
    expect(grade(FEE_COLLECTOR, owner(REFUND))).toBe('unknown')
  })

  it('gives governing timelock roles only to the Safe or the timelock', () => {
    for (const name of ['PROPOSER_ROLE', 'TIMELOCK_ADMIN_ROLE']) {
      expect(grade(TIMELOCK, grant(name, SAFE))).toBe('pass')
      expect(grade(TIMELOCK, grant(name, DEPLOYER))).toBe('fail')
    }
  })

  it('gives the canceller role to a known wallet or a Safe owner, and leaves a new one unverified', () => {
    expect(grade(TIMELOCK, grant('CANCELLER_ROLE', DEPLOYER))).toBe('pass')
    expect(grade(TIMELOCK, grant('CANCELLER_ROLE', SIGNER))).toBe('pass')
    expect(grade(TIMELOCK, grant('CANCELLER_ROLE', STRANGER))).toBe('unknown')
  })

  it('does not let a Safe owner be an executor or a withdrawal recipient', () => {
    expect(
      grade(
        DIAMOND,
        call('withdraw(address,address,uint256)', [STRANGER, SIGNER, 1n])
      )
    ).toBe('fail')
    expect(
      grade(
        DIAMOND,
        call('setCanExecute(bytes4,address,bool)', ['0x1458d7ad', SIGNER, true])
      )
    ).toBe('fail')
  })

  it('fails a role this check has no rule for when the grantee is unknown', () => {
    expect(
      grade(
        TIMELOCK,
        call('grantRole(bytes32,address)', [
          pad('0x01', { size: 32 }),
          STRANGER,
        ])
      )
    ).toBe('fail')
    expect(
      grade(
        TIMELOCK,
        call('grantRole(bytes32,address)', [pad('0x01', { size: 32 }), SAFE])
      )
    ).toBe('unknown')
  })

  it('lets a selector executor be the refund wallet or an installed contract only', () => {
    const exec = (who: Address, on = true) =>
      call('setCanExecute(bytes4,address,bool)', ['0x12345678', who, on])
    expect(grade(DIAMOND, exec(REFUND))).toBe('pass')
    expect(grade(DIAMOND, exec(DEPLOYER))).toBe('unknown')
    expect(grade(DIAMOND, exec(STRANGER))).toBe('fail')
    expect(grade(DIAMOND, exec(STRANGER, false))).toBe('pass')
    expect(
      grade(DIAMOND, exec(STRANGER), {
        ...context,
        installed: new Set([STRANGER.toLowerCase()]),
      })
    ).toBe('pass')
  })

  it('lets a withdrawal go to the withdraw wallet only', () => {
    const withdraw = (to: Address) =>
      call('withdraw(address,address,uint256)', [STRANGER, to, 1n])
    expect(grade(DIAMOND, withdraw(WITHDRAW))).toBe('pass')
    expect(grade(DIAMOND, withdraw(DEPLOYER))).toBe('unknown')
    expect(grade(DIAMOND, withdraw(STRANGER))).toBe('fail')
  })

  it('leaves an arbitrary call from the diamond unverified', () => {
    expect(
      grade(
        DIAMOND,
        call('executeCallAndWithdraw(address,bytes,address,address,uint256)', [
          STRANGER,
          '0x',
          STRANGER,
          WITHDRAW,
          0n,
        ])
      )
    ).toBe('unknown')
  })

  it('is unknown for a truncated authority call', () => {
    expect(grade(DIAMOND, '0xf2fde38b')).toBe('unknown')
  })

  const cutWith = (init: Hex) =>
    call('diamondCut((address,uint8,bytes4[])[],address,bytes)', [
      [],
      PERIPHERY,
      init,
    ])
  const exec = (to: Address, data: Hex) =>
    call(
      'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
      [to, 0n, data, 0, 0n, 0n, 0n, STRANGER, STRANGER, '0x']
    )
  const multiSend = (to: Address, data: Hex) => {
    const inner = concatHex([
      numberToHex(0, { size: 1 }),
      to,
      numberToHex(0n, { size: 32 }),
      numberToHex(BigInt((data.length - 2) / 2), { size: 32 }),
      data,
    ])
    return call('multiSend(bytes)', [inner])
  }

  it('reads a diamondCut _init as a call on the diamond', () => {
    const attack = gradeAuthority(one(DIAMOND, cutWith(owner(REFUND))), context)
    expect(attack.status).toBe('unknown')
    expect(attack.detail).toContain('_init')
    expect(grade(DIAMOND, cutWith(owner(STRANGER)))).toBe('fail')
    expect(grade(DIAMOND, cutWith(owner(TIMELOCK)))).toBe('pass')
  })

  it('leaves a cut or registration made from inside _init unverified, not judged by gate K', () => {
    const register = call('registerPeripheryContract(string,address)', [
      'Executor',
      STRANGER,
    ])
    expect(grade(DIAMOND, register)).toBe('pass')
    const nested = gradeAuthority(one(DIAMOND, cutWith(register)), context)
    expect(nested.status).toBe('unknown')
    expect(nested.detail).toContain('gate K does not judge')
    expect(grade(DIAMOND, cutWith(cutWith('0x')))).toBe('unknown')
  })

  it('reads calls a Safe execTransaction and a multiSend carry, against their own targets', () => {
    expect(grade(SAFE, exec(TIMELOCK, grant('PROPOSER_ROLE', STRANGER)))).toBe(
      'fail'
    )
    expect(grade(SAFE, exec(TIMELOCK, grant('PROPOSER_ROLE', SAFE)))).toBe(
      'pass'
    )
    expect(grade(SAFE, multiSend(DIAMOND, owner(REFUND)))).toBe('unknown')
    expect(grade(SAFE, multiSend(PERIPHERY, owner(REFUND)))).toBe('pass')
    expect(
      grade(
        SAFE,
        exec(SAFE, multiSend(TIMELOCK, grant('PROPOSER_ROLE', STRANGER)))
      )
    ).toBe('fail')
  })

  it('grades a Safe call against its own target', () => {
    expect(grade(SAFE, exec(DIAMOND, owner(REFUND)))).toBe('unknown')
    expect(grade(SAFE, exec(PERIPHERY, owner(REFUND)))).toBe('pass')
  })

  it('still reads calls three envelopes deep', () => {
    const threeDeep = exec(
      SAFE,
      exec(SAFE, multiSend(TIMELOCK, grant('PROPOSER_ROLE', STRANGER)))
    )
    expect(grade(SAFE, threeDeep)).toBe('fail')
  })

  it('leaves calls nested past the depth it reads unverified, not passed', () => {
    const deep = exec(
      SAFE,
      exec(
        SAFE,
        exec(SAFE, multiSend(TIMELOCK, grant('PROPOSER_ROLE', STRANGER)))
      )
    )
    const graded = gradeAuthority(one(SAFE, deep), context)
    expect(graded.status).toBe('unknown')
    expect(graded.detail).toContain('deeper than this check reads')
  })

  describe('selector whitelist', () => {
    const USDC: Address = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    const TRANSFER_FROM: Hex = '0x23b872dd'
    const SWAP: Hex = '0x7617b389'
    const listed = {
      ...context,
      whitelist: new Set([`${PERIPHERY.toLowerCase()}:${SWAP}`]),
    }
    const single = (contract: Address, selector: Hex, on = true) =>
      call('setContractSelectorWhitelist(address,bytes4,bool)', [
        contract,
        selector,
        on,
      ])
    const batch = (contracts: Address[], selectors: Hex[], on = true) =>
      call('batchSetContractSelectorWhitelist(address[],bytes4[],bool)', [
        contracts,
        selectors,
        on,
      ])

    it('passes a pair main lists, and fails one it does not', () => {
      expect(grade(DIAMOND, single(PERIPHERY, SWAP), listed)).toBe('pass')
      const graded = gradeAuthority(
        one(DIAMOND, single(USDC, TRANSFER_FROM)),
        listed
      )
      expect(graded.status).toBe('fail')
      expect(graded.detail).toContain(`${USDC.toLowerCase()}:${TRANSFER_FROM}`)
    })

    it('fails a batch carrying one unlisted pair among listed ones', () => {
      expect(grade(DIAMOND, batch([PERIPHERY], [SWAP]), listed)).toBe('pass')
      expect(
        grade(DIAMOND, batch([PERIPHERY, USDC], [SWAP, TRANSFER_FROM]), listed)
      ).toBe('fail')
    })

    it('leaves a pair on a contract a pending operation registers unverified, never passed', () => {
      const rollout = {
        ...listed,
        pendingRegistrations: new Set([STRANGER.toLowerCase()]),
      }
      expect(grade(DIAMOND, single(STRANGER, TRANSFER_FROM), rollout)).toBe(
        'unknown'
      )
      const installedOnly = {
        ...listed,
        installed: new Set([STRANGER.toLowerCase()]),
      }
      expect(
        grade(DIAMOND, single(STRANGER, TRANSFER_FROM), installedOnly)
      ).toBe('fail')
    })

    it('leaves an unlisted pair on an address main names unverified', () => {
      const graded = gradeAuthority(
        one(DIAMOND, single(PERIPHERY, TRANSFER_FROM)),
        listed
      )
      expect(graded.status).toBe('unknown')
      expect(graded.detail).toContain('ERC20Proxy')
    })

    it('passes a removal, which only narrows the whitelist', () => {
      expect(
        grade(DIAMOND, batch([USDC], [TRANSFER_FROM], false), listed)
      ).toBe('pass')
    })

    it("is unverified when main's whitelist could not be read", () => {
      expect(grade(DIAMOND, single(PERIPHERY, SWAP), context)).toBe('unknown')
    })
  })

  describe('revoked roles', () => {
    const revoke = (name: string, from: Address) =>
      call('revokeRole(bytes32,address)', [role(name), from])
    const renounce = (name: string, from: Address) =>
      call('renounceRole(bytes32,address)', [role(name), from])

    it('fails taking a governing role from anyone', () => {
      expect(grade(TIMELOCK, revoke('PROPOSER_ROLE', SAFE))).toBe('fail')
      expect(grade(TIMELOCK, revoke('TIMELOCK_ADMIN_ROLE', STRANGER))).toBe(
        'fail'
      )
      expect(grade(TIMELOCK, renounce('PROPOSER_ROLE', SAFE))).toBe('fail')
    })

    it('fails taking the canceller role from the Safe, and passes an offboarded wallet', () => {
      expect(grade(TIMELOCK, revoke('CANCELLER_ROLE', SAFE))).toBe('fail')
      expect(grade(TIMELOCK, revoke('CANCELLER_ROLE', DEPLOYER))).toBe('pass')
      expect(grade(TIMELOCK, revoke('CANCELLER_ROLE', STRANGER))).toBe('pass')
    })

    it('leaves another role unverified', () => {
      expect(grade(TIMELOCK, revoke('EXECUTOR_ROLE', ZERO_ADDRESS))).toBe(
        'unknown'
      )
    })
  })

  describe('calls it does not grade', () => {
    it('leaves an owner-gated call it does not know unverified', () => {
      const graded = gradeAuthority(
        one(
          DIAMOND,
          call('registerOptimismBridge(address,address)', [STRANGER, STRANGER])
        ),
        context
      )
      expect(graded.status).toBe('unknown')
      expect(graded.detail).toContain('does not grade')
    })

    it('passes a benign call', () => {
      expect(grade(PERIPHERY, call('confirmOwnershipTransfer()', []))).toBe(
        'pass'
      )
      expect(
        grade(
          DIAMOND,
          call('registerPeripheryContract(string,address)', [
            'Executor',
            PERIPHERY,
          ])
        )
      ).toBe('pass')
    })
  })
})

describe('installedAddresses', () => {
  it('lists cut facets and registrations, never the zero address of a removal', () => {
    const zero = '0x0000000000000000000000000000000000000000'
    const installed = installedAddresses({
      calls: [
        {
          cuts: [
            { facetAddress: STRANGER, action: 0 },
            { facetAddress: zero, action: 2 },
          ],
          init: zero,
        },
      ],
      registrations: [{ name: 'Executor', address: SAFE }],
      refusals: [],
      unopened: [],
      knownCalls: [],
    } as unknown as ICollectedDiamondCuts)
    expect([...installed].sort()).toEqual(
      [STRANGER.toLowerCase(), SAFE.toLowerCase()].sort()
    )
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

  it('passes an operation installing nothing', () => {
    const graded = gradeCodehash({
      kind: 'not-applicable',
      collected: collected(),
    })
    expect(graded).toMatchObject({ status: 'pass', detail: 'installs no code' })
  })

  it('passes unopened calldata whose selector the authority check grades', () => {
    expect(
      gradeCodehash({
        kind: 'not-applicable',
        collected: collected({ unopened: ['0xa4c3366e'] }),
      }).status
    ).toBe('pass')
  })

  it('is unverified when calldata the decoder could not open may install code', () => {
    const graded = gradeCodehash({
      kind: 'not-applicable',
      collected: collected({ unopened: ['0xdeadbeef'] }),
    })
    expect(graded.status).toBe('unknown')
    expect(graded.detail).toContain('0xdeadbeef')
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

describe('pendingRegistrationsOf', () => {
  const NEW: Address = '0x0000000000000000000000000000000000005555'
  const known = new Map([[DIAMOND.toLowerCase(), 'LiFiDiamond']])
  const register = (address: Address) =>
    encodeFunctionData({
      abi: [
        parseAbiItem(
          'function registerPeripheryContract(string _name, address _contractAddress)'
        ),
      ],
      args: ['Executor', address],
    })

  it('collects an address registered at the diamond that main does not name', () => {
    const ops = [opOf([{ target: DIAMOND, data: register(NEW) }])]
    expect(pendingRegistrationsOf(ops, DIAMOND, known)).toEqual(
      new Set([NEW.toLowerCase()])
    )
  })

  it('ignores a registration sent elsewhere, a known address and a removal', () => {
    const ops = [
      opOf([{ target: SAFE, data: register(NEW) }]),
      opOf([{ target: DIAMOND, data: register(DIAMOND) }]),
      opOf([{ target: DIAMOND, data: register(ZERO_ADDRESS as Address) }]),
    ]
    expect(pendingRegistrationsOf(ops, DIAMOND, known).size).toBe(0)
  })
})

describe('gate G on the watcher reader', () => {
  const FACET: Address = '0x00000000000000000000000000000000000000aa'
  const PAUSER: Address = '0x00000000000000000000000000000000000000b2'
  const deployments = {
    LiFiDiamond: DIAMOND.toLowerCase(),
    OwnershipFacet: FACET,
    LiFiTimelockController: TIMELOCK.toLowerCase(),
  }
  const gateG = async (readScheduledAt: () => Promise<bigint>) =>
    gradeAuthorities(
      await runPreBroadcastGate(
        {
          operationId: ZERO32,
          targets: [DIAMOND.toLowerCase()],
          payloads: [`0x1f931c1c${FACET.slice(2).padStart(64, '0')}`],
        },
        {
          readCode: async (address: Address) =>
            address.toLowerCase() === FACET
              ? `0x${'22'.repeat(64)}`
              : `0x${'11'.repeat(64)}`,
          readAuthority: async (_: Address, getter: string) =>
            getter === 'pauserWallet' ? PAUSER : TIMELOCK.toLowerCase(),
          deployments,
          pinnedDeployments: deployments,
          globalConfig: { pauserWallet: PAUSER },
          signTimeRecord: {},
          readScheduledAt,
        }
      )
    ).status

  it('is unverified, not a mismatch, when the state check did not confirm the operation live', async () => {
    expect(await gateG(scheduledAtReaderFor('unset', 0n))).toBe('unknown')
    expect(await gateG(scheduledAtReaderFor(undefined, undefined))).toBe(
      'unknown'
    )
    expect(await gateG(async () => 0n)).toBe('fail')
  })

  it('reads the confirmed schedule of a live operation', async () => {
    expect(await gateG(scheduledAtReaderFor('pending', 1_800_000_000n))).toBe(
      'pass'
    )
  })
})
