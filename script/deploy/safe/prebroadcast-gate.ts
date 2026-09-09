/**
 * The pre-broadcast gate: assembles live observations and `main`-derived
 * anchors, then asks `evaluatePreBroadcastGate` whether the operation may run.
 *
 * Import `runPreBroadcastGate` from the executor immediately before the point
 * where it would broadcast. Every dependency that touches the network, the
 * filesystem or MongoDB is injected, so the whole path can be driven in a test
 * without a chain.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { parseAbi, type Address, type Hex, type PublicClient } from 'viem'

import type { IAttestedBuild } from '../codehash/attested-set'

import {
  DECLARED_STORAGE_AUTHORITIES,
  buildAddressNameIndex,
  deriveGateInput,
  deriveLineageScope,
  extractCalldataAddresses,
  normalizeRuntimeCode,
  readArtifactAnchor,
  resolveExpectedAuthority,
  type IArtifactAnchor,
} from './prebroadcast-anchors'
import {
  evaluatePreBroadcastGate,
  type IPreBroadcastAuthority,
  type IPreBroadcastGateResult,
  type IPreBroadcastTarget,
} from './prebroadcast-rederive'

const AUTHORITY_ABI = parseAbi([
  'function owner() view returns (address)',
  'function pauserWallet() view returns (address)',
])

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
  readAuthority: (address: Address, getter: string) => Promise<string>
  /** Parsed `deployments/<network>.json` for this network. */
  deployments: Record<string, unknown>
  /** Parsed `config/global.json`. */
  globalConfig: Record<string, unknown>
  /** This network's `config/networks.json` entry. */
  networkConfig: { isZkEVM?: unknown; targetEvmVersion?: unknown }
  /** Directory holding forge's `out/`. */
  artifactRoot: string
  /** Label for the local build, e.g. the commit it was built from. */
  lineage: string
}

/** Everything the gate reaches the outside world through. */
export interface IGateDependencies extends IObservationDependencies {
  /** The stored sign-time record, or null. Only its presence is used. */
  signTimeRecord: unknown
  /** Reads the id the timelock itself derives from the operation parameters. */
  readOnChainOperationId: () => Promise<string>
}

export interface IGateOperation {
  operationId: string
  targets: readonly string[]
  payloads: readonly string[]
}

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Reads live code at one address and grades it against the local build.
 *
 * @param address - Lowercased address from the calldata.
 * @param contractName - Name the deployments file bound to it, if any.
 * @param anchor - The artifact anchor for that name, if one was readable.
 * @param dependencies - Injected readers and anchors.
 * @returns The target observation the gate decides on.
 */
const observeTarget = async (
  address: string,
  contractName: string | undefined,
  anchor: IArtifactAnchor | undefined,
  dependencies: IObservationDependencies
): Promise<IPreBroadcastTarget> => {
  const scope = deriveLineageScope(
    dependencies.networkConfig,
    anchor?.evmVersion
  )
  const attested: IAttestedBuild[] =
    anchor === undefined ? [] : [anchor.attested]

  let code: string
  try {
    code = await dependencies.readCode(address as Address)
  } catch (error) {
    return {
      address,
      resolvedContractName: contractName,
      observed: undefined,
      observationError: describeError(error),
      attested,
      scope,
    }
  }

  const normalized = normalizeRuntimeCode(code, anchor?.immutableReferences)
  if (normalized.error !== undefined)
    return {
      address,
      resolvedContractName: contractName,
      observed: undefined,
      observationError: normalized.error,
      attested,
      scope,
    }

  return {
    address,
    resolvedContractName: contractName,
    observed: normalized.observed,
    observationError: undefined,
    attested,
    scope,
  }
}

/**
 * Reads every storage authority declared for the contracts in this operation.
 *
 * @param resolved - Address → contract name for the operation's addresses.
 * @param dependencies - Injected readers and anchors.
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
          readError: undefined,
        })
      } catch (error) {
        rows.push({
          label,
          liveValue: undefined,
          expectedValue,
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
 * Reads the operation id back from the timelock, resolves every address in the
 * calldata that `main` can name, reads their live code and declared storage
 * authorities, and decides. The stored sign-time record reaches the decision
 * only as a boolean.
 *
 * @param operation - The operation about to be executed.
 * @param dependencies - Injected readers and anchors.
 * @returns The gate result.
 */
export const runPreBroadcastGate = async (
  operation: IGateOperation,
  dependencies: IGateDependencies
): Promise<IPreBroadcastGateResult> => {
  let onChainOperationId: string | undefined
  try {
    onChainOperationId = await dependencies.readOnChainOperationId()
  } catch {
    onChainOperationId = undefined
  }

  const { targets, authorities } = await observeCalldata(
    operation,
    dependencies
  )

  return evaluatePreBroadcastGate(
    deriveGateInput({
      operationId: operation.operationId,
      onChainOperationId,
      targets,
      authorities,
      signTimeRecord: dependencies.signTimeRecord,
    })
  )
}

/** What one pass over an operation's calldata observed. */
export interface IObservedCalldata {
  targets: IPreBroadcastTarget[]
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
 * @param dependencies - Injected readers and anchors.
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

  const anchors = new Map<string, IArtifactAnchor | undefined>()
  for (const { contractName } of resolved) {
    if (contractName === undefined || anchors.has(contractName)) continue
    anchors.set(
      contractName,
      readArtifactAnchor(
        contractName,
        dependencies.artifactRoot,
        dependencies.lineage
      )
    )
  }

  const targets = await Promise.all(
    resolved.map(({ address, contractName }) =>
      observeTarget(
        address,
        contractName,
        contractName === undefined ? undefined : anchors.get(contractName),
        dependencies
      )
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
      functionName: getter as 'owner' | 'pauserWallet',
    })
    return value as string
  },
})

/**
 * Builds the operation-id reader from a viem client.
 *
 * The id is recomputed by the timelock from the parameters it holds, not by us
 * from the queue row, so a row whose parameters were edited resolves to a
 * different id than the one being executed.
 *
 * @param publicClient - Client for the network.
 * @param timelockAddress - The controller holding the operation.
 * @param params - Operation parameters as read back off chain.
 * @returns The reader dependency.
 */
export const viemOperationIdReader =
  (
    publicClient: PublicClient,
    timelockAddress: Address,
    params: {
      targets: readonly Address[]
      values: readonly bigint[]
      payloads: readonly Hex[]
      predecessor: Hex
      salt: Hex
    }
  ): IGateDependencies['readOnChainOperationId'] =>
  async () => {
    const id = await publicClient.readContract({
      address: timelockAddress,
      abi: parseAbi([
        'function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)',
      ]),
      functionName: 'hashOperationBatch',
      args: [
        params.targets,
        params.values,
        params.payloads,
        params.predecessor,
        params.salt,
      ],
    })
    return id as string
  }
