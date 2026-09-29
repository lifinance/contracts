/**
 * Per-operation checks and the `ok` / `mismatch` / `unverified` verdict of the
 * report-only timelock watcher.
 *
 * Import it from `timelock-watcher.ts`. Every function here is pure: the caller
 * reads the chain and the existing gates, and this module grades what they
 * returned. A check that could not run grades `unknown`, which can never
 * produce `ok`.
 */

import {
  decodeAbiParameters,
  decodeFunctionData,
  keccak256,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'

import type { IGateReport } from '../codehash/verify-cut-targets'
import { ZERO_ADDRESS } from '../shared/constants'

import type { IPreBroadcastGateResult } from './prebroadcast-rederive'
import type { ICollectedDiamondCuts } from './safe-decode-utils'
import type {
  ICancelDecisionInput,
  TProvingLegOutcome,
} from './timelock-cancel-decision'
import type { IRecomputedIds, IScannedOperation } from './timelock-watcher-scan'

export type TWatcherVerdict = 'ok' | 'mismatch' | 'unverified'

export type TCheckStatus = 'pass' | 'fail' | 'unknown' | 'skip'

export type TCheckName =
  | 'op-id'
  | 'state'
  | 'delay'
  | 'targets'
  | 'delegatecall'
  | 'authority'
  | 'authorities'
  | 'codehash'

export interface ICheckOutcome {
  check: TCheckName
  status: TCheckStatus
  detail: string
}

/** Every check a complete report carries, in display order. */
export const REQUIRED_CHECKS: readonly TCheckName[] = [
  'op-id',
  'state',
  'delay',
  'targets',
  'delegatecall',
  'authority',
  'authorities',
  'codehash',
]

const SAFE_EXEC_ABI = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
])
const MULTISEND_ABI = parseAbi(['function multiSend(bytes transactions)'])
const UPDATE_DELAY_ABI = parseAbi(['function updateDelay(uint256 newDelay)'])
const DIAMOND_CUT_INIT_ABI = parseAbi([
  'function diamondCut((address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)',
])

const SAFE_EXEC_SELECTOR = '0x6a761202'
const MULTISEND_SELECTOR = '0x8d80ff0a'
const UPDATE_DELAY_SELECTOR = '0x64d62353'

const AUTHORITY_ABI = parseAbi([
  'function transferOwnership(address newOwner)',
  'function grantRole(bytes32 role, address account)',
  'function setCanExecute(bytes4 selector, address executor, bool canExecute)',
  'function withdraw(address assetAddress, address to, uint256 amount)',
  'function executeCallAndWithdraw(address callTo, bytes callData, address assetAddress, address to, uint256 amount)',
])

const AUTHORITY_SELECTORS = new Set([
  '0xf2fde38b', // transferOwnership(address)
  '0x2f2ff15d', // grantRole(bytes32,address)
  '0xa4c3366e', // setCanExecute(bytes4,address,bool)
  '0xd9caed12', // withdraw(address,address,uint256)
  '0x1458d7ad', // executeCallAndWithdraw(address,bytes,address,address,uint256)
])
const DIAMOND_CUT_SELECTOR = '0x1f931c1c'

const selectorOf = (data: Hex): string => data.slice(0, 10).toLowerCase()

/**
 * Classifies an operation from its check outcomes.
 *
 * A missing check counts as `unknown`: the verdict speaks for every required
 * check or it does not say `ok`.
 *
 * @param checks - Outcomes the caller produced.
 * @returns The verdict and the checks behind anything other than `ok`.
 */
export const classifyOperation = (
  checks: readonly ICheckOutcome[]
): { verdict: TWatcherVerdict; reasons: string[] } => {
  const byName = new Map(checks.map((c) => [c.check, c]))
  const graded: ICheckOutcome[] = REQUIRED_CHECKS.map(
    (name) =>
      byName.get(name) ?? {
        check: name,
        status: 'unknown',
        detail: 'this check produced no outcome',
      }
  )
  const failed = graded.filter((c) => c.status === 'fail')
  if (failed.length > 0)
    return {
      verdict: 'mismatch',
      reasons: failed.map((c) => `${c.check}: ${c.detail}`),
    }
  const unknown = graded.filter((c) => c.status === 'unknown')
  if (unknown.length > 0)
    return {
      verdict: 'unverified',
      reasons: unknown.map((c) => `${c.check}: ${c.detail}`),
    }
  return { verdict: 'ok', reasons: [] }
}

/**
 * Grades the op-id: the logged parameters must hash to the id they were logged
 * under.
 *
 * @param operationId - The id the timelock logged.
 * @param recomputed - Ids recomputed from the logged parameters.
 * @returns The check outcome and the proving-leg outcome the cancel matrix takes.
 */
export const gradeIdentity = (
  operationId: Hex,
  recomputed: IRecomputedIds | undefined
): { outcome: ICheckOutcome; leg: TProvingLegOutcome } => {
  if (!recomputed)
    return {
      leg: 'error',
      outcome: {
        check: 'op-id',
        status: 'unknown',
        detail:
          'the logged calls are not indexed 0..n-1, so the parameters are incomplete',
      },
    }
  const id = operationId.toLowerCase()
  const matches =
    recomputed.batch.toLowerCase() === id ||
    recomputed.single?.toLowerCase() === id
  return matches
    ? {
        leg: 'match',
        outcome: {
          check: 'op-id',
          status: 'pass',
          detail: 'the logged parameters hash to the scheduled id',
        },
      }
    : {
        leg: 'mismatch',
        outcome: {
          check: 'op-id',
          status: 'fail',
          detail: `the logged parameters hash to ${recomputed.batch}, not to the scheduled id`,
        },
      }
}

/** Where an operation stands, from `getTimestamp` and the block time. */
export type TOperationStage = 'pending' | 'ready' | 'done' | 'unset'

/**
 * Maps a `getTimestamp` value onto the operation's stage.
 *
 * @param timestamp - `getTimestamp(id)`.
 * @param now - Latest block timestamp, in seconds.
 * @returns The stage.
 */
export const stageOf = (timestamp: bigint, now: bigint): TOperationStage =>
  timestamp === 0n
    ? 'unset'
    : timestamp === 1n
    ? 'done'
    : timestamp <= now
    ? 'ready'
    : 'pending'

/**
 * Grades the schedule state of an operation the caller already knows is live.
 *
 * @param stage - The stage, or `undefined` when `getTimestamp` could not be read.
 * @param readyAt - `getTimestamp(id)`, for the detail line.
 * @returns The check outcome.
 */
export const gradeState = (
  stage: TOperationStage | undefined,
  readyAt: bigint | undefined
): ICheckOutcome => {
  if (stage === undefined)
    return {
      check: 'state',
      status: 'unknown',
      detail: 'getTimestamp could not be read, so the operation is unconfirmed',
    }
  if (stage === 'pending' || stage === 'ready')
    return {
      check: 'state',
      status: 'pass',
      detail: `${stage}, executable from ${
        readyAt !== undefined
          ? new Date(Number(readyAt) * 1000).toISOString()
          : 'an unknown time'
      }`,
    }
  if (stage === 'unset')
    return {
      check: 'state',
      status: 'unknown',
      detail:
        'the timelock holds no schedule under this id, but no Cancelled log follows its schedule: a node behind the scheduling block, or a reorg',
    }
  return {
    check: 'state',
    status: 'fail',
    detail: `the timelock reports this operation as ${stage}`,
  }
}

/**
 * Grades the delay: the scheduled delay, the timelock's live minimum, and any
 * `updateDelay` the operation carries must all be at least the agreed minimum.
 *
 * @param op - The operation.
 * @param agreedMinimum - `config/timelockController.json` `minDelay`, in seconds.
 * @param liveMinimum - `getMinDelay()`, or `undefined` when it could not be read.
 * @param timelock - The timelock's address, to spot `updateDelay` on itself.
 * @returns The check outcome.
 */
export const gradeDelay = (
  op: IScannedOperation,
  agreedMinimum: bigint,
  liveMinimum: bigint | undefined,
  timelock: string
): ICheckOutcome => {
  const failures: string[] = []
  if (BigInt(op.delay) < agreedMinimum)
    failures.push(
      `scheduled with a ${op.delay}s delay, below the agreed ${agreedMinimum}s`
    )
  if (liveMinimum !== undefined && liveMinimum < agreedMinimum)
    failures.push(
      `the timelock's minimum delay is ${liveMinimum}s, below the agreed ${agreedMinimum}s`
    )
  for (const call of op.calls)
    if (
      call.target.toLowerCase() === timelock.toLowerCase() &&
      selectorOf(call.data) === UPDATE_DELAY_SELECTOR
    ) {
      try {
        const { args } = decodeFunctionData({
          abi: UPDATE_DELAY_ABI,
          data: call.data,
        })
        if (args[0] < agreedMinimum)
          failures.push(
            `call ${call.index} lowers the timelock's minimum delay to ${args[0]}s`
          )
      } catch {
        failures.push(`call ${call.index} carries an undecodable updateDelay`)
      }
    }
  if (failures.length > 0)
    return { check: 'delay', status: 'fail', detail: failures.join('; ') }
  if (liveMinimum === undefined)
    return {
      check: 'delay',
      status: 'unknown',
      detail: `scheduled delay ${op.delay}s is at least the agreed ${agreedMinimum}s, but getMinDelay could not be read`,
    }
  return {
    check: 'delay',
    status: 'pass',
    detail: `${op.delay}s, at least the agreed ${agreedMinimum}s`,
  }
}

/**
 * Grades the targets (gate E): every call must go to an address main knows.
 *
 * @param op - The operation.
 * @param known - Lowercased address → name, from the deployments file at main,
 *   the network's Safe and the timelock itself.
 * @returns The check outcome.
 */
export const gradeTargets = (
  op: IScannedOperation,
  known: ReadonlyMap<string, string>
): ICheckOutcome => {
  const unknown = op.calls.filter((c) => !known.has(c.target.toLowerCase()))
  if (unknown.length > 0)
    return {
      check: 'targets',
      status: 'fail',
      detail: `call(s) to address(es) main does not know: ${unknown
        .map((c) => `${c.index}→${c.target}`)
        .join(', ')}`,
    }
  return {
    check: 'targets',
    status: 'pass',
    detail: op.calls
      .map((c) => known.get(c.target.toLowerCase()) ?? c.target)
      .join(', '),
  }
}

/**
 * Reads the inner transactions of a packed `multiSend` payload.
 *
 * @param packed - The `transactions` argument.
 * @returns Each inner transaction's operation byte, target and calldata, or `undefined`
 *   when the packing is malformed.
 */
const multiSendEntries = (
  packed: Hex
): { operation: number; to: Address; data: Hex }[] | undefined => {
  const bytes = packed.slice(2)
  const entries: { operation: number; to: Address; data: Hex }[] = []
  let at = 0
  // operation (1 byte) | to (20) | value (32) | dataLength (32) | data
  while (at < bytes.length) {
    if (at + 170 > bytes.length) return undefined
    const length = Number(BigInt(`0x${bytes.slice(at + 106, at + 170)}`))
    if (at + 170 + length * 2 > bytes.length) return undefined
    entries.push({
      operation: parseInt(bytes.slice(at, at + 2), 16),
      to: `0x${bytes.slice(at + 2, at + 42)}`,
      data: `0x${bytes.slice(at + 170, at + 170 + length * 2)}`,
    })
    at += 170 + length * 2
  }
  return entries
}

/**
 * Grades delegatecall-shaped payloads: a Safe `execTransaction` or `multiSend`
 * with operation 1 is refused, an undecodable one is unknown, and a
 * `diamondCut` with a non-zero `_init` is named so the reader can see that the
 * diamond will delegatecall it; the code there is judged by the codehash check.
 *
 * @param op - The operation.
 * @returns The check outcome.
 */
export const gradeDelegatecall = (op: IScannedOperation): ICheckOutcome => {
  const failures: string[] = []
  const unknown: string[] = []
  const notes: string[] = []
  for (const call of op.calls) {
    const selector = selectorOf(call.data)
    try {
      if (selector === SAFE_EXEC_SELECTOR) {
        const { args } = decodeFunctionData({
          abi: SAFE_EXEC_ABI,
          data: call.data,
        })
        if (args[3] !== 0)
          failures.push(`call ${call.index} is a Safe delegatecall`)
        const inner = selectorOf(args[2])
        if (inner === MULTISEND_SELECTOR) {
          const [packed] = decodeAbiParameters(
            [{ type: 'bytes' }],
            `0x${args[2].slice(10)}`
          )
          const operations = multiSendEntries(packed)
          if (!operations)
            unknown.push(`call ${call.index} carries a malformed multiSend`)
          else if (operations.some((o) => o.operation !== 0))
            failures.push(`call ${call.index} multiSends a delegatecall`)
        }
      } else if (selector === MULTISEND_SELECTOR) {
        const { args } = decodeFunctionData({
          abi: MULTISEND_ABI,
          data: call.data,
        })
        const operations = multiSendEntries(args[0])
        if (!operations)
          unknown.push(`call ${call.index} carries a malformed multiSend`)
        else if (operations.some((o) => o.operation !== 0))
          failures.push(`call ${call.index} multiSends a delegatecall`)
      } else if (selector === DIAMOND_CUT_SELECTOR) {
        const { args } = decodeFunctionData({
          abi: DIAMOND_CUT_INIT_ABI,
          data: call.data,
        })
        if (args[1].toLowerCase() !== ZERO_ADDRESS)
          notes.push(
            `call ${call.index} makes the diamond delegatecall ${args[1]}`
          )
      }
    } catch {
      unknown.push(
        `call ${call.index} carries selector ${selector} that could not be decoded`
      )
    }
  }
  if (failures.length > 0)
    return {
      check: 'delegatecall',
      status: 'fail',
      detail: [...failures, ...unknown].join('; '),
    }
  if (unknown.length > 0)
    return {
      check: 'delegatecall',
      status: 'unknown',
      detail: unknown.join('; '),
    }
  return {
    check: 'delegatecall',
    status: 'pass',
    detail:
      notes.length > 0
        ? `${notes.join('; ')} (code judged by codehash)`
        : 'no delegatecall-shaped payload',
  }
}

const roleHash = (name: string): string => keccak256(toHex(name)).toLowerCase()

/** Timelock roles only the Safe or the timelock itself may hold. */
const GOVERNING_ROLES = new Map([
  [roleHash('TIMELOCK_ADMIN_ROLE'), 'TIMELOCK_ADMIN_ROLE'],
  [roleHash('PROPOSER_ROLE'), 'PROPOSER_ROLE'],
])

/**
 * Roles a wallet main names may hold. The executor role is held by the zero
 * address, so anyone can execute already; a grant narrows nothing and widens
 * nothing, and an unknown grantee is only unverified.
 */
const OPERATING_ROLES = new Map([
  [roleHash('CANCELLER_ROLE'), 'CANCELLER_ROLE'],
  [roleHash('EXECUTOR_ROLE'), 'EXECUTOR_ROLE'],
])
const GOVERNORS = new Set(['Safe', 'LiFiTimelockController'])

/** Deepest envelope `reachedCalls` opens; anything deeper is unverified. */
const MAX_CALL_DEPTH = 3

/** A call an operation makes, directly or from inside another call. */
interface IReachedCall {
  label: string
  /** The contract whose code or storage the call acts on. */
  target: string
  data: Hex
}

const ENVELOPE_SELECTORS = new Set([
  DIAMOND_CUT_SELECTOR,
  SAFE_EXEC_SELECTOR,
  MULTISEND_SELECTOR,
])

/**
 * Every call the operation makes, including the `_init` call of a
 * `diamondCut` (which runs on the diamond), and the calls a Safe
 * `execTransaction` or `multiSend` carries.
 *
 * @param op - The operation.
 * @returns The calls, and the labels of envelopes too deep to open.
 */
const reachedCalls = (
  op: IScannedOperation
): { calls: IReachedCall[]; tooDeep: string[] } => {
  const calls: IReachedCall[] = []
  const tooDeep: string[] = []
  const visit = (call: IReachedCall, depth: number): void => {
    calls.push(call)
    const selector = selectorOf(call.data)
    if (!ENVELOPE_SELECTORS.has(selector)) return
    if (depth >= MAX_CALL_DEPTH) {
      tooDeep.push(call.label)
      return
    }
    try {
      if (selector === DIAMOND_CUT_SELECTOR) {
        const { args } = decodeFunctionData({
          abi: DIAMOND_CUT_INIT_ABI,
          data: call.data,
        })
        if (args[1].toLowerCase() !== ZERO_ADDRESS && args[2].length > 2)
          visit(
            {
              label: `${call.label} → _init`,
              target: call.target,
              data: args[2],
            },
            depth + 1
          )
      } else if (selector === SAFE_EXEC_SELECTOR) {
        const { args } = decodeFunctionData({
          abi: SAFE_EXEC_ABI,
          data: call.data,
        })
        if (args[2].length > 2)
          visit(
            {
              label: `${call.label} → Safe call`,
              target: args[0],
              data: args[2],
            },
            depth + 1
          )
      } else {
        const { args } = decodeFunctionData({
          abi: MULTISEND_ABI,
          data: call.data,
        })
        for (const [i, inner] of (multiSendEntries(args[0]) ?? []).entries())
          if (inner.data.length > 2)
            visit(
              {
                label: `${call.label} → multiSend ${i}`,
                target: inner.to,
                data: inner.data,
              },
              depth + 1
            )
      }
    } catch {
      // An undecodable envelope is the delegatecall check's finding.
    }
  }
  for (const call of op.calls)
    visit(
      { label: `call ${call.index}`, target: call.target, data: call.data },
      0
    )
  return { calls, tooDeep }
}

/** Who an operation may hand something to: every name is an allowlist entry. */
export interface IAuthorityContext {
  /** Lowercased address → name: the deployments file at main, the network's
   *  Safe, the timelock, and the wallets `config/global.json` names. */
  known: ReadonlyMap<string, string>
  /** Lowercased Safe owners, which may be granted the canceller role only. */
  safeOwners?: ReadonlySet<string>
  /** Lowercased addresses this operation installs, whose code gate K judges. */
  installed?: ReadonlySet<string>
}

/**
 * Grades what an operation will hand authority or funds to, in every call it
 * reaches. Gate G reads the authorities as they stand, which a pending
 * operation has not changed yet, so this reads the arguments instead, against
 * the shapes the repo's own flows produce:
 * - the diamond's ownership may only go to the timelock; another contract's
 *   to the timelock, the Safe or the refund wallet, and a fee collector's or
 *   fee forwarder's to the withdraw wallet or
 *   the fee collector owner;
 * - a timelock admin or proposer role only to the Safe or the timelock; the
 *   canceller or executor role to a wallet main names or a Safe owner;
 * - a selector executor only to the refund wallet or a contract the operation
 *   installs; a withdrawal only to the withdraw wallet.
 *
 * Anything else handed to an address main does not know fails; handed to one
 * it knows, or made as an arbitrary call from the diamond, it is unverified.
 *
 * @param op - The operation.
 * @param context - The names that make an address an allowed recipient.
 * @returns The check outcome.
 */
export const gradeAuthority = (
  op: IScannedOperation,
  context: IAuthorityContext
): ICheckOutcome => {
  const failures: string[] = []
  const unknown: string[] = []
  const granted: string[] = []
  const nameOf = (address: string): string | undefined =>
    context.known.get(address.toLowerCase())
  const judge = (
    label: string,
    what: string,
    to: string,
    allowed: (name: string) => boolean
  ): void => {
    const name = nameOf(to)
    if (name && allowed(name)) granted.push(`${label} ${what} ${name}`)
    else if (name)
      unknown.push(
        `${label} ${what} ${name}, which no honest flow hands this to`
      )
    else failures.push(`${label} ${what} ${to}, which main does not know`)
  }

  const { calls, tooDeep } = reachedCalls(op)
  for (const label of tooDeep)
    unknown.push(`${label} nests calls deeper than this check reads`)
  for (const call of calls) {
    if (!AUTHORITY_SELECTORS.has(selectorOf(call.data))) continue
    let decoded: ReturnType<typeof decodeFunctionData<typeof AUTHORITY_ABI>>
    try {
      decoded = decodeFunctionData({ abi: AUTHORITY_ABI, data: call.data })
    } catch {
      unknown.push(
        `${call.label} carries selector ${selectorOf(
          call.data
        )} that could not be decoded`
      )
      continue
    }
    const targetName = nameOf(call.target) ?? call.target
    switch (decoded.functionName) {
      case 'transferOwnership': {
        const allowed =
          targetName === 'LiFiDiamond'
            ? (name: string) => name === 'LiFiTimelockController'
            : /FeeCollector|FeeForwarder/.test(targetName)
            ? (name: string) =>
                name === 'withdrawWallet' || name === 'feeCollectorOwner'
            : (name: string) =>
                name === 'LiFiTimelockController' ||
                name === 'Safe' ||
                name === 'refundWallet'
        judge(
          call.label,
          `transfers ${targetName} ownership to`,
          decoded.args[0],
          allowed
        )
        break
      }
      case 'grantRole': {
        const [role, to] = decoded.args
        const governing = GOVERNING_ROLES.get(role.toLowerCase())
        if (governing) {
          const name = nameOf(to)
          if (name && GOVERNORS.has(name))
            granted.push(`${call.label} grants ${governing} to ${name}`)
          else
            failures.push(
              `${call.label} grants ${governing} to ${
                name ?? to
              }, which is neither the Safe nor the timelock`
            )
        } else if (OPERATING_ROLES.has(role.toLowerCase())) {
          const operating = OPERATING_ROLES.get(role.toLowerCase())
          const name =
            nameOf(to) ??
            (context.safeOwners?.has(to.toLowerCase())
              ? 'a Safe owner'
              : undefined)
          if (name) granted.push(`${call.label} grants ${operating} to ${name}`)
          else
            unknown.push(
              `${call.label} grants ${operating} to ${to}, which main does not know yet`
            )
        } else judge(call.label, `grants role ${role} to`, to, () => false)
        break
      }
      case 'setCanExecute': {
        const [selector, executor, canExecute] = decoded.args
        if (!canExecute) break
        if (context.installed?.has(executor.toLowerCase()))
          granted.push(
            `${call.label} lets ${selector} be called by a contract this operation installs`
          )
        else
          judge(
            call.label,
            `lets ${selector} be called by`,
            executor,
            (name) => name === 'refundWallet'
          )
        break
      }
      case 'withdraw':
        judge(
          call.label,
          'withdraws to',
          decoded.args[1],
          (name) => name === 'withdrawWallet'
        )
        break
      case 'executeCallAndWithdraw':
        unknown.push(
          `${call.label} makes the diamond call ${decoded.args[0]} with arbitrary calldata`
        )
        break
      default:
        unknown.push(
          `${call.label} carries an authority call this check does not read`
        )
    }
  }
  if (failures.length > 0)
    return {
      check: 'authority',
      status: 'fail',
      detail: [...failures, ...unknown].join('; '),
    }
  if (unknown.length > 0)
    return { check: 'authority', status: 'unknown', detail: unknown.join('; ') }
  return {
    check: 'authority',
    status: 'pass',
    detail:
      granted.length > 0
        ? granted.join('; ')
        : 'hands no ownership, role, executor right or withdrawal to anyone',
  }
}

/**
 * Addresses a cut or registration installs, for {@link IAuthorityContext}.
 *
 * @param collected - `collectDiamondCutTargets` over the operation.
 * @returns Lowercased addresses, the zero address (a removal) excluded.
 */
export const installedAddresses = (
  collected: ICollectedDiamondCuts
): Set<string> =>
  new Set(
    [
      ...collected.calls.flatMap((c) => c.cuts.map((cut) => cut.facetAddress)),
      ...collected.registrations.map((r) => r.address),
    ]
      .map((a) => a.toLowerCase())
      .filter((a) => a !== ZERO_ADDRESS)
  )

/**
 * Grades storage authorities (gate G) from the pre-broadcast gate's result.
 *
 * @param result - The gate's result, or the error that stopped it.
 * @returns The check outcome.
 */
export const gradeAuthorities = (
  result: IPreBroadcastGateResult | { error: string }
): ICheckOutcome => {
  if ('error' in result)
    return {
      check: 'authorities',
      status: 'unknown',
      detail: `the pre-broadcast gate could not run: ${result.error}`,
    }
  const status: TCheckStatus =
    result.disposition === 'PROCEED'
      ? 'pass'
      : result.disposition === 'BLOCK'
      ? 'fail'
      : 'unknown'
  return {
    check: 'authorities',
    status,
    detail:
      status === 'pass'
        ? result.reason
        : result.findings.join('; ') || result.reason,
  }
}

/** Gate K's result over one operation, or why it did not produce one. */
export type TCodehashResult =
  | { kind: 'not-applicable'; collected: ICollectedDiamondCuts }
  | { kind: 'deferred'; reason: string }
  | { kind: 'error'; reason: string }
  | { kind: 'cached'; status: 'pass' | 'fail' | 'unknown'; detail: string }
  | {
      kind: 'evaluated'
      collected: ICollectedDiamondCuts
      reports: IGateReport[]
    }

/**
 * Whether an operation wires code in, so that gate K must judge it.
 *
 * @param collected - `collectDiamondCutTargets` over the operation.
 * @returns True when a cut, a registration or an undecodable frame is present.
 */
export const installsCode = (collected: ICollectedDiamondCuts): boolean =>
  collected.calls.length > 0 ||
  collected.registrations.length > 0 ||
  collected.refusals.length > 0

/**
 * Grades gate K: live code at every address the operation wires in must match
 * a rebuild of its recorded commit.
 *
 * @param result - What gate K produced for the operation.
 * @returns The check outcome.
 */
export const gradeCodehash = (result: TCodehashResult): ICheckOutcome => {
  if (result.kind === 'not-applicable')
    return {
      check: 'codehash',
      status: 'pass',
      detail:
        result.collected.unopened.length > 0
          ? `installs nothing this decoder can see (unopened: ${result.collected.unopened.join(
              ', '
            )})`
          : 'installs no code',
    }
  if (result.kind === 'deferred' || result.kind === 'error')
    return { check: 'codehash', status: 'unknown', detail: result.reason }
  if (result.kind === 'cached')
    return {
      check: 'codehash',
      status: result.status,
      detail: `${result.detail} (from an earlier run; the code is unchanged)`,
    }

  const targets = result.reports.flatMap((r) => r.targets)
  const mismatched = targets.filter((t) => t.verdict === 'MISMATCH')
  if (mismatched.length > 0)
    return {
      check: 'codehash',
      status: 'fail',
      detail: mismatched.map((t) => `${t.address}: ${t.reason}`).join('; '),
    }
  const refusals = [
    ...result.collected.refusals,
    ...result.reports.flatMap((r) => r.refusals),
  ]
  const unverifiable = targets.filter((t) => t.verdict !== 'MATCH')
  if (refusals.length > 0 || unverifiable.length > 0)
    return {
      check: 'codehash',
      status: 'unknown',
      detail: [
        ...refusals,
        ...unverifiable.map((t) => `${t.address}: ${t.reason}`),
      ].join('; '),
    }
  return {
    check: 'codehash',
    status: 'pass',
    detail: `${targets.length} address(es) match a rebuild of their recorded commit`,
  }
}

const legOf = (status: TCheckStatus): TProvingLegOutcome =>
  status === 'pass'
    ? 'match'
    : status === 'fail'
    ? 'mismatch'
    : status === 'skip'
    ? 'unsupported'
    : 'error'

/**
 * Builds the cancel matrix input the watcher can honestly state. Shown for
 * information only: nothing acts on it.
 *
 * @param input - The graded checks and the facts the matrix needs.
 * @returns The matrix input.
 */
export const buildWatcherCancelInput = (input: {
  identity: TProvingLegOutcome
  codehash: ICheckOutcome
  authorities: ICheckOutcome
  stage: TOperationStage | undefined
  signTimeRecordPresent: boolean
}): ICancelDecisionInput => {
  const codehashLeg = legOf(input.codehash.status)
  const authoritiesLeg = legOf(input.authorities.status)
  const integrity: TProvingLegOutcome =
    codehashLeg === 'mismatch' || authoritiesLeg === 'mismatch'
      ? 'mismatch'
      : codehashLeg === 'error' || authoritiesLeg === 'error'
      ? 'error'
      : 'match'
  return {
    integrity,
    opIdentity: input.identity,
    verdictProvenance: 'anchors',
    agreeingProviders: 1,
    executability: 'error',
    deploymentRecord: input.codehash.status === 'unknown' ? 'error' : 'present',
    signTimeVerdictRecord: input.signTimeRecordPresent ? 'present' : 'missing',
    operationState: input.stage ?? 'unset',
    cancellerAuthority: 'unknown',
    revertAttempts: 0,
    revertBlockThreshold: Number.MAX_SAFE_INTEGER,
  }
}
