import { TronWeb } from 'tronweb'

import { getRPCEnvVarName } from '../../../utils/network'
import { isTronNetworkKey } from '../../shared/tron-network-keys'
import { TRON_DEPLOY_NETWORK } from '../constants'

import { tronWebFullHostFromRpcUrl } from './tronJsonRpcForViem'

const tronWebCodecByNetwork = new Map<string, TronWeb>()

/**
 * TronWeb `fullHost` for codec-only usage, from the same source as viem
 * (`getViemChainForNetworkName` in `script/utils/viemScriptHelpers.ts`):
 * `ETH_NODE_URI_<NETWORK>` only (see {@link getRPCEnvVarName}), with `/jsonrpc`
 * stripped for Tron networks (native HTTP API root).
 *
 * @param networkName `tron` or `tronshasta` (case-insensitive)
 */
export function getTronWebCodecFullHostForNetwork(networkName: string): string {
  const key = networkName.toLowerCase()
  if (!isTronNetworkKey(key)) {
    throw new Error(
      `getTronWebCodecFullHostForNetwork: expected a Tron network key, got ${networkName}`
    )
  }

  const envKey = getRPCEnvVarName(key)
  const rpcUrlRaw = process.env[envKey]

  if (!rpcUrlRaw?.trim()) {
    throw new Error(
      `Could not find RPC URL for network ${key}, please set ${envKey} in your environment`
    )
  }

  return tronWebFullHostFromRpcUrl(key, rpcUrlRaw)
}

/**
 * TronWeb `fullHost` for codec-only usage for {@link TRON_DEPLOY_NETWORK} (main Tron).
 * Prefer {@link getTronWebCodecFullHostForNetwork} when the chain is known at call site.
 */
export function getTronWebCodecFullHost(): string {
  return getTronWebCodecFullHostForNetwork(TRON_DEPLOY_NETWORK)
}

/**
 * Shared TronWeb for address / ABI codec helpers only (no private key), keyed by network.
 * `fullHost` comes from {@link getTronWebCodecFullHostForNetwork} (RPC env only).
 */
export function getTronWebCodecOnlyForNetwork(networkName: string): TronWeb {
  const key = networkName.toLowerCase()
  if (!isTronNetworkKey(key)) {
    throw new Error(
      `getTronWebCodecOnlyForNetwork: expected a Tron network key, got ${networkName}`
    )
  }

  let inst = tronWebCodecByNetwork.get(key)
  if (!inst) {
    inst = new TronWeb({ fullHost: getTronWebCodecFullHostForNetwork(key) })
    tronWebCodecByNetwork.set(key, inst)
  }

  return inst
}

/**
 * Shared TronWeb for address / ABI codec helpers only (no private key).
 * Same as {@link getTronWebCodecOnlyForNetwork}(`TRON_DEPLOY_NETWORK`).
 */
export function getTronWebCodecOnly(): TronWeb {
  return getTronWebCodecOnlyForNetwork(TRON_DEPLOY_NETWORK)
}
