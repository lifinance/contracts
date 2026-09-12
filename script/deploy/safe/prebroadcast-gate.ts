/**
 * The pre-broadcast gate: assembles live observations and the expectations
 * `main` declares, then asks `evaluatePreBroadcastGate` whether the operation
 * may run.
 *
 * Import `runPreBroadcastGate` from the executor immediately before the point
 * where it would broadcast, and `observeCalldata` from `confirm-safe-tx.ts` to
 * build a signer's record. Every dependency that touches the network or MongoDB
 * is injected, so the whole path can be driven in a test without a chain.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import {
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import { redactErrorReason, redactUrls } from '../../utils/redactUrls'
import { strip0x } from '../codehash/hex'

import {
  AUTHORITY_ABI,
  DECLARED_STORAGE_AUTHORITIES,
  buildAddressNameIndex,
  extractCalldataAddresses,
  resolveExpectedAuthority,
  type AuthorityGetter,
  type IPreBroadcastAuthority,
} from './prebroadcast-authorities'
import {
  deriveGateInput,
  evaluatePreBroadcastGate,
  type IPreBroadcastGateResult,
} from './prebroadcast-rederive'

/**
 * Which chains this gate reads code on.
 *
 * `uncovered-tron` is a deliberate member of the set that may proceed, not an
 * oversight: a Tron code read needs a TronWeb client the executor does not
 * carry here, so the gate would otherwise hold every Tron operation forever.
 * The executor prints the gap rather than a verdict, and it is tracked as its
 * own ticket.
 */
export type GateCoverage = 'covered' | 'uncovered-tron'

/**
 * Whether the gate can read code on a network.
 *
 * @param network - Network name as it appears in `config/networks.json`.
 * @returns The coverage class.
 */
export const resolveGateCoverage = (network: string): GateCoverage =>
  isTronNetworkKey(network) ? 'uncovered-tron' : 'covered'

/**
 * What one pass over the calldata needs. Split out from the full dependency
 * set so the sign-time record writer, which has no verdict to reach, cannot be
 * handed a stored record at all.
 */
export interface IObservationDependencies {
  /** Live runtime code at an address, `0x` when none. */
  readCode: (address: Address) => Promise<string>
  /** Live value of a zero-argument address getter. */
  readAuthority: (address: Address, getter: AuthorityGetter) => Promise<string>
  /** Parsed `deployments/<network>.json` for this network. */
  deployments: Record<string, unknown>
  /** Parsed `config/global.json`. */
  globalConfig: Record<string, unknown>
}

/** Everything the gate reaches the outside world through. */
export interface IGateDependencies extends IObservationDependencies {
  /** The stored sign-time record, or null. Only its presence is used. */
  signTimeRecord: unknown
  /** Reads the timestamp the timelock has stored against the operation id. */
  readScheduledAt: () => Promise<bigint>
}

export interface IGateOperation {
  operationId: string
  targets: readonly string[]
  payloads: readonly string[]
}

/**
 * Turns a thrown value into the text an observation carries.
 *
 * viem embeds the full node URL — API key included — in the message it throws
 * on a failed request, and this string is persisted to the sign-time record.
 * Redacted but uncapped, per [CONV:REDACT-RPC-URL]: the record is the durable
 * forensic artifact, and the 180-char Slack cap lands mid-`Details:` on a real
 * rate-limit error. Capping happens where the text is published.
 */
const describeError = (error: unknown): string =>
  redactUrls(error instanceof Error ? error.message : String(error))

/** One address the operation names, and the code seen at it. */
export interface IObservedTarget {
  /**
   * The address as it appears in the operation parameters, lowercased. Never a
   * display name and never a name-resolved address: the calldata's own bytes
   * are what executes.
   */
  address: string
  /**
   * Contract name resolved from the deployments file at `main` by exact address
   * match, or undefined when no entry holds this address.
   */
  resolvedContractName: string | undefined
  /** keccak of the exact bytes at the address; undefined when unread. */
  rawHash: string | undefined
  /** Byte length as deployed; undefined when unread. */
  rawByteLength: number | undefined
  /** Why the live read yielded nothing. */
  observationError: string | undefined
}

/**
 * Reads the live code at one address and hashes exactly what is there.
 *
 * No masking and no comparison. The observation exists so a signer's record can
 * say what their machine saw, and the value of that record is that three
 * signers' copies are comparable to each other — which they are only if every
 * machine hashes the same bytes it read, with nothing derived from a local
 * build folded in. Grading these against an attested set is EXSC-1004's job,
 * once EXSC-952 has minted a set nobody's laptop produced.
 *
 * @param address - Lowercased address from the calldata.
 * @param contractName - Name the deployments file bound to it, if any.
 * @param dependencies - Injected readers.
 * @returns The observation, readable or not.
 */
const observeTarget = async (
  address: string,
  contractName: string | undefined,
  dependencies: IObservationDependencies
): Promise<IObservedTarget> => {
  let code: string
  try {
    code = await dependencies.readCode(address as Address)
  } catch (error) {
    return {
      address,
      resolvedContractName: contractName,
      rawHash: undefined,
      rawByteLength: undefined,
      observationError: describeError(error),
    }
  }

  const body = strip0x(code)
  if (!/^[0-9a-fA-F]*$/.test(body) || body.length % 2 !== 0)
    return {
      address,
      resolvedContractName: contractName,
      rawHash: undefined,
      rawByteLength: undefined,
      observationError: `live code at ${address} is not an even-length hex string`,
    }

  return {
    address,
    resolvedContractName: contractName,
    rawHash: keccak256(`0x${body}` as Hex),
    rawByteLength: body.length / 2,
    observationError: undefined,
  }
}

/**
 * Reads every storage authority declared for the contracts in this operation.
 *
 * @param resolved - Address → contract name for the operation's addresses.
 * @param dependencies - Injected readers.
 * @returns One row per declared authority.
 */
const observeAuthorities = async (
  resolved: ReadonlyArray<{
    address: string
    contractName: string | undefined
  }>,
  dependencies: IObservationDependencies
): Promise<IPreBroadcastAuthority[]> => {
  const rows: IPreBroadcastAuthority[] = []

  for (const { address, contractName } of resolved) {
    if (contractName === undefined) continue
    const declared = Object.prototype.hasOwnProperty.call(
      DECLARED_STORAGE_AUTHORITIES,
      contractName
    )
      ? DECLARED_STORAGE_AUTHORITIES[contractName]
      : undefined
    if (declared === undefined) continue

    for (const authority of declared) {
      const label = `${contractName}.${authority.getter}()`
      const expectedValue = resolveExpectedAuthority(
        authority.source,
        dependencies.deployments,
        dependencies.globalConfig
      )
      try {
        const liveValue = await dependencies.readAuthority(
          address as Address,
          authority.getter
        )
        rows.push({
          label,
          liveValue: liveValue.trim().toLowerCase(),
          expectedValue,
          expectationSource: authority.source.from,
          readError: undefined,
        })
      } catch (error) {
        rows.push({
          label,
          liveValue: undefined,
          expectedValue,
          expectationSource: authority.source.from,
          readError: describeError(error),
        })
      }
    }
  }

  return rows
}

/**
 * Re-derives whether a queued timelock operation may be broadcast.
 *
 * Asks the timelock what it has scheduled under the id, resolves every address
 * in the calldata that `main` can name, reads their declared storage
 * authorities and decides. The stored sign-time record reaches the decision
 * only as a boolean.
 *
 * @param operation - The operation about to be executed.
 * @param dependencies - Injected readers.
 * @returns The gate result.
 */
export const runPreBroadcastGate = async (
  operation: IGateOperation,
  dependencies: IGateDependencies
): Promise<IPreBroadcastGateResult> => {
  let scheduledAt: bigint | undefined
  try {
    scheduledAt = await dependencies.readScheduledAt()
  } catch {
    scheduledAt = undefined
  }

  const { targets, authorities } = await observeCalldata(
    operation,
    dependencies
  )

  return evaluatePreBroadcastGate(
    deriveGateInput({
      operationId: operation.operationId,
      scheduledAt,
      addressesNamed: targets.length,
      addressesResolved: targets.filter(
        (target) =>
          target.resolvedContractName !== undefined &&
          target.resolvedContractName.length > 0
      ).length,
      authorities,
      signTimeRecord: dependencies.signTimeRecord,
    })
  )
}

/** What one pass over an operation's calldata observed. */
export interface IObservedCalldata {
  targets: IObservedTarget[]
  authorities: IPreBroadcastAuthority[]
}

/**
 * Reads live code and declared authorities for every address in the calldata.
 *
 * Shared by the gate and by the sign-time record writer, on purpose: the record
 * has to describe the same addresses the gate will later look at, and a second
 * implementation of the resolution would let the two drift.
 *
 * @param operation - The operation whose calldata to walk.
 * @param dependencies - Injected readers.
 * @returns One target row per resolved address, plus every declared authority.
 */
export const observeCalldata = async (
  operation: IGateOperation,
  dependencies: IObservationDependencies
): Promise<IObservedCalldata> => {
  const nameIndex = buildAddressNameIndex(dependencies.deployments)
  const addresses = extractCalldataAddresses(
    operation.targets,
    operation.payloads,
    new Set(nameIndex.keys())
  )

  const resolved = addresses.map((address) => ({
    address,
    contractName: nameIndex.get(address),
  }))

  const targets = await Promise.all(
    resolved.map(({ address, contractName }) =>
      observeTarget(address, contractName, dependencies)
    )
  )

  const authorities = await observeAuthorities(resolved, dependencies)

  return { targets, authorities }
}

/**
 * Builds the two on-chain readers from a viem client.
 *
 * @param publicClient - Client for the network the operation lives on.
 * @returns The `readCode` and `readAuthority` dependencies.
 */
export const viemGateReaders = (
  publicClient: PublicClient
): Pick<IGateDependencies, 'readCode' | 'readAuthority'> => ({
  readCode: async (address) =>
    (await publicClient.getCode({ address })) ?? '0x',
  readAuthority: async (address, getter) => {
    const value = await publicClient.readContract({
      address,
      abi: AUTHORITY_ABI,
      functionName: getter,
    })
    return value as string
  },
})

/**
 * Builds the schedule-timestamp reader from a viem client.
 *
 * Asks the controller what it has stored against the id, rather than asking it
 * to re-hash parameters we already hold. `hashOperationBatch` is pure, so
 * hashing the row's own parameters could only ever confirm that viem and solc
 * agree on ABI encoding — worth knowing once in a test, not once per operation
 * per tick. `getTimestamp` reads state instead: a row whose parameters were
 * edited consistently in both places hashes to a new id the controller has
 * never scheduled, and comes back zero here.
 *
 * This does not make the broadcast safe on its own — `executeBatch` re-derives
 * the id and enforces `isOperationReady` regardless of what we read. It turns
 * that revert into a pre-flight refusal an operator can act on.
 *
 * @param publicClient - Client for the network.
 * @param timelockAddress - The controller to ask.
 * @param operationId - The id the row is being executed under.
 * @returns The reader dependency.
 */
export const viemScheduledAtReader =
  (
    publicClient: PublicClient,
    timelockAddress: Address,
    operationId: Hex
  ): IGateDependencies['readScheduledAt'] =>
  async () => {
    const timestamp = await publicClient.readContract({
      address: timelockAddress,
      abi: parseAbi([
        'function getTimestamp(bytes32 id) view returns (uint256)',
      ]),
      functionName: 'getTimestamp',
      args: [operationId],
    })
    return timestamp as bigint
  }

/**
 * The message an unattended run has to escalate when it broadcast without a
 * complete verdict.
 *
 * The gate's own dispositions are already carried by the caller's failure path.
 * What this covers is the quieter case: the gate said PROCEED while naming a
 * gap in what it could check, the network is one it cannot cover at all, or —
 * under shadow mode — the gate never reached a disposition, because a read it
 * needed or the gate itself threw. In an operator's shell those reach a reader
 * through the console. The ten-minute cron has no reader, so a gap that only
 * reaches the log is a gap nobody ever learns about — which is how the audit
 * trail of a skipped sign-time record comes to look identical to a verified
 * one.
 *
 * @param input - The network and operation, and the gaps to escalate.
 * @returns The message, or null when the run has nothing a reader must act on.
 */
export const buildGateGapAlert = (input: {
  readonly network: string
  readonly operationId: string
  readonly gaps: readonly string[]
}): string | null => {
  const gaps = input.gaps.filter((gap) => gap.trim().length > 0)
  if (gaps.length === 0) return null

  const bullets = gaps.map((gap) => `• ${redactErrorReason(gap)}`).join('\n')
  return [
    `⚠️ Pre-broadcast gate proceeded without a complete verdict on ${input.network}`,
    `operation ${input.operationId}`,
    bullets,
  ].join('\n')
}

/** Env var that makes a pre-broadcast refusal binding. */
export const PRE_BROADCAST_GATE_ENFORCE_ENV = 'PRE_BROADCAST_GATE_ENFORCE'

/**
 * Whether a pre-broadcast refusal is binding.
 *
 * Off unless the variable is exactly `'true'`; anything else — unset, empty,
 * `'1'`, `'TRUE'`, `'yes'` — reads as off. Defaulting to off rather than on
 * inverts the usual reflex because a `HOLD` refuses the broadcast: an authority
 * read that fails intermittently would stop honest rollouts on every chain it
 * touches. The gate has to demonstrate it does not hold on honest traffic
 * before an unattended cron is allowed to act on it.
 *
 * The same flag gates the gate's Slack alerting, for the same reason: output
 * nobody may act on does not belong on the channel carrying escalations
 * somebody must.
 *
 * @param env - The environment to read, normally `process.env`.
 * @returns True only for the exact opt-in.
 */
export const isPreBroadcastGateEnforcing = (env: {
  readonly [key: string]: string | undefined
}): boolean => env[PRE_BROADCAST_GATE_ENFORCE_ENV] === 'true'

/**
 * What an operation is worth when the gate could not reach a verdict at all —
 * a deployment record that would not load, a record store that would not
 * answer, a throw out of the gate itself.
 *
 * `'retry'` only where a refusal is binding. The executor turns any outcome
 * other than `'ok'` into `failed`, so answering `'retry'` under shadow mode
 * would stop a production broadcast and report an honest operation as failed on
 * the strength of a verdict this run is not permitted to act on. That is the
 * inversion `persistSignedSetRecord` refuses on the write side, and it applies
 * with more force here: these paths are not even a refusal, only an absence of
 * one.
 *
 * @param env - The environment to read, normally `process.env`.
 * @returns `'retry'` when enforcing, `'ok'` in shadow mode.
 */
export const unverifiedGateOutcome = (env: {
  readonly [key: string]: string | undefined
}): 'ok' | 'retry' => (isPreBroadcastGateEnforcing(env) ? 'retry' : 'ok')

/**
 * The message for a refusal the run declined to act on.
 *
 * Must not share wording with {@link buildGateGapAlert}: that one says nothing
 * was checked, this one says something was checked and found wrong, and the
 * two warrant different responses.
 *
 * @param input - The network and operation, the disposition, and its findings.
 * @returns The message, or null when there is no refusal to report.
 */
export const buildShadowRefusalAlert = (input: {
  readonly network: string
  readonly operationId: string
  readonly disposition: string
  readonly findings: readonly string[]
}): string | null => {
  const findings = input.findings.filter((f) => f.trim().length > 0)
  if (findings.length === 0) return null

  const bullets = findings
    .map((finding) => `• ${redactErrorReason(finding)}`)
    .join('\n')
  return [
    `🕶️ Pre-broadcast gate returned ${input.disposition} on ${input.network} and was OVERRIDDEN by shadow mode — the operation executed`,
    `operation ${input.operationId}`,
    bullets,
    `Shadow mode is on until the gate has shown it does not refuse honest traffic; a HOLD would otherwise stop rollouts on every chain.`,
  ].join('\n')
}
