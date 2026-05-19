/**
 * Central TronWeb construction (RPC URL normalization, optional key, TronGrid headers).
 */

import { TronWeb } from 'tronweb'

import { TRON_PRO_API_KEY_HEADER } from '../constants'
import type { ICreateTronWebOptions, TronTvmNetworkName } from '../types'

import { isTronGridRpcUrl } from './isTronGridRpcUrl'
import { tronWebFullHostFromRpcUrl } from './tronJsonRpcForViem'
import { getTronGridAPIKey, getTronRPCConfig } from './tronRpcConfig'

/**
 * Normalize RPC URL from env to TronWeb’s native HTTP root.
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
