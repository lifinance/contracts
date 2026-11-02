/**
 * RPC handling for the timelock executor: reads through every configured endpoint, re-sends a
 * signed `executeBatch` tx that an endpoint accepted and then dropped, and names that outcome.
 * Used by `execute-pending-timelock-tx.ts`; kept separate so it can be unit-tested.
 */

import { consola } from 'consola'
import {
  createClient,
  createPublicClient,
  TransactionReceiptNotFoundError,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem'
import { getTransactionReceipt, sendRawTransaction } from 'viem/actions'

import { normalizeRpcUrlForNetwork } from '../../mongoDb/rpcEndpoints'
import { redactErrorReason } from '../../utils/redactUrls'
import {
  getFallbackTransportForChain,
  getHttpTransportForRpcUrl,
} from '../../utils/viemScriptHelpers'

import {
  confirmTimelockExecution,
  type IConfirmTimelockExecutionParams,
  type TimelockExecutionConfirmation,
} from './confirm-timelock-execution'

export type TimelockExecutionOutcome =
  | TimelockExecutionConfirmation
  | 'not-on-chain'

/** One RPC endpoint, addressed on its own rather than through `fallback()`. */
export interface IRpcEndpoint {
  /** Broadcasts already-signed bytes; resolves with the hash the endpoint reports. */
  sendRawTransaction: (serializedTransaction: Hex) => Promise<Hex>
  /** `false` only when the endpoint answers that it has no receipt; any other failure rejects. */
  hasReceipt: (hash: Hex) => Promise<boolean>
}

export interface IChainEndpoints {
  /** Absent when the primary URL is unusable. */
  primary?: IRpcEndpoint
  fallbacks: IRpcEndpoint[]
}

export interface IConfirmWithRebroadcastParams
  extends IConfirmTimelockExecutionParams {
  hash: Hex
  /** Signed bytes of the submitted tx; without them nothing is re-sent. */
  rawTransaction?: Hex
  /** Without endpoints (e.g. Tron) this is plain {@link confirmTimelockExecution}. */
  endpoints?: IChainEndpoints
  logPrefix?: string
}

function endpointFor(chain: Chain, rpcUrl: string): IRpcEndpoint {
  const client = createClient({
    chain,
    transport: getHttpTransportForRpcUrl(rpcUrl),
  })
  return {
    sendRawTransaction: (serializedTransaction) =>
      sendRawTransaction(client, { serializedTransaction }),
    hasReceipt: async (hash) => {
      try {
        await getTransactionReceipt(client, { hash })
        return true
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return false
        throw error
      }
    },
  }
}

/**
 * Addresses each of the chain's endpoints individually, split into the primary (index 0) and
 * the fallbacks behind it.
 *
 * @param chain - Chain whose `rpcUrls.default.http` lists the primary first.
 * @returns The usable endpoints; an unusable URL is skipped without shifting the others' roles.
 */
export function buildChainEndpoints(chain: Chain): IChainEndpoints {
  const endpoints: IChainEndpoints = { fallbacks: [] }
  chain.rpcUrls.default.http.forEach((rpcUrl, index) => {
    let endpoint: IRpcEndpoint
    try {
      endpoint = endpointFor(chain, rpcUrl)
    } catch {
      // getFallbackTransportForChain already warns about this endpoint, without its URL.
      return
    }
    if (index === 0) endpoints.primary = endpoint
    else endpoints.fallbacks.push(endpoint)
  })
  return endpoints
}

/**
 * Builds the executor's read client and per-endpoint handles.
 *
 * @param chain - The network's chain (primary plus configured fallbacks).
 * @param networkName - Key from `config/networks.json`, for URL normalisation.
 * @param rpcUrlOverride - Operator-chosen endpoint; when set it is the only one used.
 * @returns A public client on {@link getFallbackTransportForChain} and the endpoints behind it.
 * @throws If the chain has no usable RPC URL.
 */
export function createExecutorRpc(
  chain: Chain,
  networkName: string,
  rpcUrlOverride?: string
): { publicClient: PublicClient; endpoints: IChainEndpoints } {
  const rpcChain: Chain = rpcUrlOverride
    ? {
        ...chain,
        rpcUrls: {
          ...chain.rpcUrls,
          default: {
            http: [normalizeRpcUrlForNetwork(networkName, rpcUrlOverride)],
          },
        },
      }
    : chain
  return {
    publicClient: createPublicClient({
      chain: rpcChain,
      transport: getFallbackTransportForChain(rpcChain),
    }) as PublicClient,
    endpoints: buildChainEndpoints(rpcChain),
  }
}

async function rebroadcast(
  rawTransaction: Hex,
  fallbacks: IRpcEndpoint[],
  logPrefix: string
): Promise<void> {
  const results = await Promise.allSettled(
    fallbacks.map((endpoint) => endpoint.sendRawTransaction(rawTransaction))
  )
  results.forEach((result, index) => {
    const label = `fallback endpoint ${index + 1}/${fallbacks.length}`
    // A rejection is expected when the endpoint already holds the tx ("already known",
    // "nonce too low" once mined), so it is logged and polling carries on.
    if (result.status === 'fulfilled')
      consola.info(`${logPrefix} 📡 Re-broadcast accepted by ${label}`)
    else
      consola.warn(
        `${logPrefix} ⚠️ Re-broadcast rejected by ${label}: ${redactErrorReason(
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason)
        )}`
      )
  })
}

async function noEndpointHasReceipt(
  endpoints: IChainEndpoints,
  hash: Hex
): Promise<boolean> {
  const all = [endpoints.primary, ...endpoints.fallbacks].filter(
    (endpoint): endpoint is IRpcEndpoint => endpoint !== undefined
  )
  if (all.length === 0) return false
  const results = await Promise.allSettled(
    all.map((endpoint) => endpoint.hasReceipt(hash))
  )
  return results.every((r) => r.status === 'fulfilled' && r.value === false)
}

/**
 * {@link confirmTimelockExecution}, then — if the operation is still not done — re-sends the
 * identical signed tx to every fallback endpoint and polls one more window.
 *
 * viem's `fallback()` only switches endpoints on an error, so a tx the primary accepts and then
 * drops never reaches another endpoint by itself. The bytes are re-sent unchanged (same nonce,
 * same hash): a re-sign under a fresh nonce could mine behind a late original and revert,
 * which counts toward the op's revert-block threshold.
 *
 * @param params - The confirmation inputs plus the tx hash, its signed bytes and the endpoints.
 * @returns `not-on-chain` when every endpoint answers it has no receipt for the hash; otherwise
 *   the confirmation result. Neither `unconfirmed` nor `not-on-chain` may mark the op executed.
 */
export async function confirmWithRebroadcast(
  params: IConfirmWithRebroadcastParams
): Promise<TimelockExecutionOutcome> {
  const { hash, rawTransaction, endpoints, logPrefix = '' } = params
  const poll = {
    isOperationDone: params.isOperationDone,
    attempts: params.attempts,
    delayMs: params.delayMs,
  }

  const first = await confirmTimelockExecution({
    ...poll,
    receipt: params.receipt,
  })
  if (first !== 'unconfirmed' || !endpoints) return first

  if (rawTransaction && endpoints.fallbacks.length > 0) {
    consola.warn(
      `${logPrefix} ⚠️ tx ${hash} not confirmed; re-broadcasting the same signed tx to ${endpoints.fallbacks.length} fallback endpoint(s)`
    )
    await rebroadcast(rawTransaction, endpoints.fallbacks, logPrefix)
    const second = await confirmTimelockExecution(poll)
    if (second !== 'unconfirmed') return second
  }

  return (await noEndpointHasReceipt(endpoints, hash))
    ? 'not-on-chain'
    : 'unconfirmed'
}
