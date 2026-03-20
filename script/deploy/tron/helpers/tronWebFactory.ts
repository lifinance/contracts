/**
 * Central TronWeb construction (RPC URL normalization, optional key, TronGrid headers).
 */

import { TronWeb } from 'tronweb'

import type { TronTvmNetworkName } from '../types'

import { tronWebFullHostFromRpcUrl } from './tronJsonRpcForViem'
import {
  getTronGridAPIKey,
  getTronRPCConfig,
  isTronGridRpcUrl,
} from './tronRpcConfig'

const TRON_PRO_API_KEY_HEADER = 'TRON-PRO-API-KEY' as const

/**
 * Normalize RPC URL (env / `networks.json`) to TronWeb’s native HTTP root.
 * With `networkKey` `tron` / `tronshasta`, strips `/jsonrpc`; otherwise trims trailing slashes only.
 */
export function resolveTronWebRpcUrlToFullHost(
  rpcUrl: string,
  networkKey?: TronTvmNetworkName
): string {
  const raw = rpcUrl.trim()
  if (networkKey !== undefined)
    return tronWebFullHostFromRpcUrl(networkKey, raw)

  return raw.replace(/\/+$/, '')
}

export interface ICreateTronWebOptions {
  /**
   * RPC URL as in env / `networks.json` (may end with `/jsonrpc` or trailing slashes).
   * When `networkKey` is `tron` or `tronshasta`, normalized to TronWeb’s native HTTP root
   * via {@link tronWebFullHostFromRpcUrl}. Otherwise only trailing slashes are trimmed.
   */
  rpcUrl: string
  networkKey?: TronTvmNetworkName
  privateKey?: string
  headers?: Record<string, string>
  /**
   * Optional TronGrid PRO API key. Used only when `headers` does not already set
   * `TRON-PRO-API-KEY`. If still unset and the resolved host looks like TronGrid, the key is
   * taken from the environment via {@link getTronGridAPIKey} (e.g. `TRONGRID_API_KEY`).
   */
  tronProApiKey?: string
  /** Passed to {@link getTronGridAPIKey} when resolving the key from the environment. */
  verbose?: boolean
}

export function createTronWeb(options: ICreateTronWebOptions): TronWeb {
  const fullHost = resolveTronWebRpcUrlToFullHost(
    options.rpcUrl,
    options.networkKey
  )
  const cfg: {
    fullHost: string
    privateKey?: string
    headers?: Record<string, string>
  } = { fullHost }

  if (options.privateKey !== undefined && options.privateKey !== '')
    cfg.privateKey = options.privateKey

  const merged: Record<string, string> = { ...(options.headers ?? {}) }
  let apiKey = merged[TRON_PRO_API_KEY_HEADER]?.trim()
  if (!apiKey) {
    apiKey = options.tronProApiKey?.trim()
    if (!apiKey && isTronGridRpcUrl(fullHost))
      apiKey = getTronGridAPIKey(options.verbose ?? false)?.trim()
    if (apiKey) merged[TRON_PRO_API_KEY_HEADER] = apiKey
  }

  if (Object.keys(merged).length > 0) cfg.headers = merged

  return new TronWeb(cfg)
}

/** TronWeb for `tron` / `tronshasta` using {@link getTronRPCConfig} + normalized host. */
export function createTronWebForTvmNetworkKey(options: {
  networkKey: TronTvmNetworkName
  privateKey: string
  verbose?: boolean
}): TronWeb {
  const { rpcUrl, headers } = getTronRPCConfig(
    options.networkKey,
    options.verbose
  )

  return createTronWeb({
    rpcUrl,
    networkKey: options.networkKey,
    privateKey: options.privateKey,
    headers,
    verbose: options.verbose,
  })
}

/** Read-only / RPC-only (no signing key) — e.g. wait loops, codec smoke tests. */
export function createTronWebReadOnly(options: {
  rpcUrl: string
  networkKey?: TronTvmNetworkName
  headers?: Record<string, string>
  tronProApiKey?: string
  verbose?: boolean
}): TronWeb {
  return createTronWeb({
    rpcUrl: options.rpcUrl,
    networkKey: options.networkKey,
    headers: options.headers,
    tronProApiKey: options.tronProApiKey,
    verbose: options.verbose,
  })
}
