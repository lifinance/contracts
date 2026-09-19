import type { TronWeb } from 'tronweb'
import type { Address, Hex } from 'viem'

import {
  TIMELOCK_OPERATION_STATE_ABI,
  pickTimelockSaltWith,
  type ITimelockOperationReader,
} from '../safe/timelock-abi'

/** The subset of TronWeb this reader touches; a test supplies a fake. */
export interface ITronTimelockContractSource {
  contract: (
    abi: readonly unknown[],
    address: string
  ) => {
    hashOperationBatch: (
      targets: readonly string[],
      values: readonly string[],
      payloads: readonly string[],
      predecessor: string,
      salt: string
    ) => { call: () => Promise<unknown> }
    getTimestamp: (operationId: string) => { call: () => Promise<unknown> }
  }
}

/**
 * Normalises whatever TronWeb hands back for a `bytes32` view: a hex string
 * with or without its prefix.
 */
const toHex32 = (value: unknown): Hex => {
  const raw =
    typeof value === 'string'
      ? value
      : (value as { toString?: () => string })?.toString?.() ?? ''
  const stripped = raw.startsWith('0x') ? raw.slice(2) : raw
  if (!/^[0-9a-fA-F]{64}$/.test(stripped))
    throw new Error(
      `Timelock returned an unreadable operation id: ${String(value)}`
    )
  return `0x${stripped.toLowerCase()}` as Hex
}

const toBigInt = (value: unknown): bigint => {
  if (typeof value === 'bigint') return value
  const raw =
    typeof value === 'string'
      ? value
      : (value as { toString?: () => string })?.toString?.() ?? ''
  if (!/^\d+$/.test(raw))
    throw new Error(
      `Timelock returned an unreadable timestamp: ${String(value)}`
    )
  return BigInt(raw)
}

/**
 * The timelock reads salt selection needs, through TronWeb.
 *
 * `uint256[]` values are passed as decimal strings: TronWeb encodes a JS
 * number lossily above 2^53 and does not accept a bigint.
 *
 * @param tronWeb - a TronWeb whose `contract()` can reach the timelock
 * @param timelockAddressBase58 - the timelock as `deployments/tron.json` spells it
 * @returns a reader `pickTimelockSaltWith` can probe the timelock through
 */
export const createTronTimelockReader = (
  tronWeb: ITronTimelockContractSource,
  timelockAddressBase58: string
): ITimelockOperationReader => {
  const timelock = tronWeb.contract(
    TIMELOCK_OPERATION_STATE_ABI,
    timelockAddressBase58
  )
  return {
    hashOperationBatch: async (targets, values, payloads, predecessor, salt) =>
      toHex32(
        await timelock
          .hashOperationBatch(
            targets,
            values.map((value) => value.toString()),
            payloads,
            predecessor,
            salt
          )
          .call()
      ),
    getTimestamp: async (operationId) =>
      toBigInt(await timelock.getTimestamp(operationId).call()),
  }
}

export interface IPickTronTimelockSaltInput {
  tronWeb: ITronTimelockContractSource | TronWeb
  chainId: number
  timelockAddressBase58: string
  /** The same timelock as 20-byte EVM hex, which the salt preimage carries. */
  timelockAddressEvm: Address
  targets: Address[]
  payloads: Hex[]
}

/**
 * Picks the Tron `scheduleBatch` salt the way every EVM path does: derived
 * from the action, advanced only past operation ids the timelock already
 * knows, refused when the same batch is still pending.
 *
 * Values are all zero, which is what `encodeTimelockScheduleBatch` schedules
 * when the Tron routes omit them; the probe must ask about that same array.
 *
 * @param input - the action, the chain, and a TronWeb to read the timelock with
 * @returns the salt to schedule under
 */
export const pickTronTimelockSalt = (
  input: IPickTronTimelockSaltInput
): Promise<Hex> =>
  pickTimelockSaltWith(
    {
      chainId: input.chainId,
      timelockAddress: input.timelockAddressEvm,
      targetAddresses: input.targets,
      originalCalldatas: input.payloads,
      values: input.targets.map(() => 0n),
    },
    createTronTimelockReader(
      input.tronWeb as ITronTimelockContractSource,
      input.timelockAddressBase58
    )
  )
