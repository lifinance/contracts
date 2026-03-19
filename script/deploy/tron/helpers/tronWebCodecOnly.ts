import { TronWeb } from 'tronweb'

import networksConfig from '../../../../config/networks.json'
import type { INetworksObject } from '../../../common/types'
import { TRON_NETWORK_KEYS } from '../../shared/constants'
import { TRON_DEPLOY_NETWORK } from '../constants'

import { tronWebFullHostFromRpcUrl } from './tronJsonRpcForViem'

const networks = networksConfig as INetworksObject

const tronWebCodecByNetwork = new Map<string, TronWeb>()

/**
 * TronWeb `fullHost` for codec-only usage, from the same source as viem
 * (`getViemChainForNetworkName` in `script/utils/viemScriptHelpers.ts`):
 * `ETH_NODE_URI_<NETWORK>` (e.g. `ETH_NODE_URI_TRON`) or `networks.json` `rpcUrl`,
 * with `/jsonrpc` stripped for Tron networks (native HTTP API root).
 *
 * @param networkName `tron` or `tronshasta` (case-insensitive)
 */
export function getTronWebCodecFullHostForNetwork(networkName: string): string {
  const key = networkName.toLowerCase()
  if (!TRON_NETWORK_KEYS.has(key)) {
    throw new Error(
      `getTronWebCodecFullHostForNetwork: expected a Tron network key, got ${networkName}`
    )
  }

  const network = networks[key as keyof INetworksObject]
  if (!network) {
    throw new Error(
      `Chain ${key} does not exist. Please check that the network exists in 'config/networks.json'`
    )
  }

  const envKey = `ETH_NODE_URI_${key.toUpperCase()}`
  const rpcUrlRaw = process.env[envKey] || network.rpcUrl

  if (!rpcUrlRaw) {
    throw new Error(
      `Could not find RPC URL for network ${key}, please add one with the key ${envKey} to your .env file`
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
 * `fullHost` comes from {@link getTronWebCodecFullHostForNetwork} (`.env` + `networks.json`).
 */
export function getTronWebCodecOnlyForNetwork(networkName: string): TronWeb {
  const key = networkName.toLowerCase()
  if (!TRON_NETWORK_KEYS.has(key)) {
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
