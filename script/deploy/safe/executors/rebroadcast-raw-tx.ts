/**
 * Re-sends an already-signed transaction to every configured RPC endpoint and waits for a
 * receipt from whichever endpoint sees it mined first.
 *
 * Used by the EVM chain caller when the primary endpoint accepted a transaction but never
 * produced a receipt: viem's `fallback()` transport cannot cover that case, because an
 * endpoint that silently drops a transaction raises no error for it to switch on.
 */

import { consola } from 'consola'
import { createPublicClient, http } from 'viem'
import type { Hash, Hex, PublicClient, TransactionReceipt } from 'viem'

import { redactUrls } from '../../../utils/redactUrls'
import { getTransportConfigFromRpcUrl } from '../../../utils/viemScriptHelpers'

export type RebroadcastClient = Pick<
  PublicClient,
  'sendRawTransaction' | 'waitForTransactionReceipt'
>

export interface IRebroadcastParams {
  serializedTransaction: Hex
  hash: Hash
  rpcUrls: readonly string[]
  networkName?: string
  /** How long to wait for a receipt after re-sending. */
  timeoutMs?: number
  /** Builds the per-endpoint client; injectable for tests. */
  clientFor?: (rpcUrl: string) => RebroadcastClient
}

export interface IRebroadcastResult {
  /** Endpoints that accepted the re-sent bytes. */
  accepted: number
  /** Endpoints a client could be built for. */
  attempted: number
  receipt?: TransactionReceipt
}

const DEFAULT_TIMEOUT_MS = 60_000 // 60 seconds

const defaultClientFor = (rpcUrl: string): RebroadcastClient => {
  const { url, fetchOptions, retryCount, retryDelay } =
    getTransportConfigFromRpcUrl(rpcUrl)
  return createPublicClient({
    transport: http(url, {
      ...(fetchOptions ? { fetchOptions } : {}),
      ...(retryCount !== undefined ? { retryCount } : {}),
      ...(retryDelay !== undefined ? { retryDelay } : {}),
    }),
  })
}

const errorText = (error: unknown): string =>
  redactUrls(error instanceof Error ? error.message : String(error))

/**
 * Re-sends `serializedTransaction` to each endpoint in `rpcUrls`, then waits for a receipt on
 * any of them.
 *
 * Re-sending the identical signed bytes cannot execute twice: they carry the same nonce and
 * hash as the original, so a node that already has the transaction rejects the copy.
 *
 * @param params - The signed bytes, their hash, the endpoints, and timing.
 * @returns How many endpoints accepted the bytes, and the receipt if one arrived in time.
 */
export async function rebroadcastRawTransaction(
  params: IRebroadcastParams
): Promise<IRebroadcastResult> {
  const { serializedTransaction, hash, networkName } = params
  const clientFor = params.clientFor ?? defaultClientFor
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const label = networkName ?? 'network'

  const clients: RebroadcastClient[] = []
  for (const rpcUrl of new Set(params.rpcUrls))
    try {
      clients.push(clientFor(rpcUrl))
    } catch (error) {
      consola.warn(
        `${label}: skipping unusable RPC endpoint — ${errorText(error)}`
      )
    }

  const sends = await Promise.allSettled(
    clients.map((client) =>
      client.sendRawTransaction({ serializedTransaction })
    )
  )
  const accepted = sends.filter((send) => send.status === 'fulfilled').length
  for (const send of sends)
    if (send.status === 'rejected')
      consola.warn(
        `${label}: an endpoint rejected the re-sent tx — ${errorText(
          send.reason
        )}`
      )
  consola.info(
    `${label}: re-sent tx ${hash} to ${accepted}/${clients.length} RPC endpoint(s)`
  )

  if (!clients.length) return { accepted, attempted: 0 }

  try {
    const receipt = await Promise.any(
      clients.map((client) =>
        client.waitForTransactionReceipt({ hash, timeout: timeoutMs })
      )
    )
    return { accepted, attempted: clients.length, receipt }
  } catch {
    return { accepted, attempted: clients.length }
  }
}
