/**
 * Broadcast contract calls on Tron via TronWeb + `wallet/triggersmartcontract`.
 *
 * {@link broadcastTronContractCall} is the generic helper (any contract, any calldata).
 * {@link broadcastTronSafeExecTransaction} wraps it for Gnosis Safe `execTransaction`.
 */

import { consola } from 'consola'
import { encodeFunctionData, type Address, type Hex } from 'viem'

import { sleep } from '../../../utils/delay'
import { SAFE_SINGLETON_ABI } from '../../safe/config'
import {
  TRON_SAFE_EXEC_CONFIRM_POLL_MS,
  TRON_SAFE_EXEC_CONFIRM_TIMEOUT_MS_DEFAULT,
  TRON_SAFE_EXEC_DEFAULT_FEE_LIMIT_SUN,
  TRON_SAFE_EXEC_FEE_LIMIT_SUN_ENV,
} from '../constants'
import { evmHexToTronBase58 } from '../tronAddressHelpers'
import type {
  IBroadcastTronSafeExecParams,
  IExecuteSafeExecTronWebResult,
  TronTvmNetworkName,
} from '../types'

import { tronScanTransactionUrl } from './tronScanUrls'
import { createTronWebForTvmNetworkKey } from './tronWebFactory'

export type {
  IExecuteSafeExecTronWebResult,
  ITronSafeExecParams,
} from '../types'

function parseFeeLimitSun(): number {
  const raw = process.env[TRON_SAFE_EXEC_FEE_LIMIT_SUN_ENV]?.trim()
  if (raw === undefined || raw === '')
    return TRON_SAFE_EXEC_DEFAULT_FEE_LIMIT_SUN
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0)
    throw new Error(
      `${TRON_SAFE_EXEC_FEE_LIMIT_SUN_ENV} must be a positive integer (SUN), got: ${raw}`
    )

  return n
}

function tronTxIdToHex(txId: string): Hex {
  const hex = txId.startsWith('0x') ? txId.slice(2) : txId
  return `0x${hex.toLowerCase()}` as Hex
}

// ── Generic contract-call broadcast ──────────────────────────────────────────

export interface IBroadcastTronContractCallParams {
  networkKey: TronTvmNetworkName
  privateKeyHex: string
  contractAddress: Address
  calldata: Hex
  callValue?: bigint
  confirmTimeoutMs?: number
}

export interface IBroadcastTronContractCallResult {
  txId: string
  hash: Hex
}

/**
 * Broadcast an arbitrary contract call on Tron via TronWeb `wallet/triggersmartcontract`.
 * Signs with the given private key, broadcasts, and polls for indexing confirmation.
 */
export async function broadcastTronContractCall(
  params: IBroadcastTronContractCallParams
): Promise<IBroadcastTronContractCallResult> {
  const tronWeb = createTronWebForTvmNetworkKey({
    networkKey: params.networkKey,
    privateKey: params.privateKeyHex,
  })

  const ownerBase58 = tronWeb.defaultAddress.base58 as string
  if (!ownerBase58?.startsWith('T'))
    throw new Error('TronWeb defaultAddress.base58 missing after init')

  const contractBase58 = evmHexToTronBase58(tronWeb, params.contractAddress)
  const contractAddressHex = tronWeb.address.toHex(contractBase58)
  const ownerAddressHex = tronWeb.address.toHex(ownerBase58)
  const dataHexNo0x = params.calldata.slice(2)
  const feeLimit = parseFeeLimitSun()

  const callValue =
    params.callValue && params.callValue > 0n
      ? (() => {
          if (params.callValue > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error(
              '[tron] call_value too large for Tron trigger; use 0 or a smaller amount.'
            )
          return Number(params.callValue)
        })()
      : 0

  const triggerResult = (await tronWeb.fullNode.request(
    'wallet/triggersmartcontract',
    {
      owner_address: ownerAddressHex,
      contract_address: contractAddressHex,
      data: dataHexNo0x,
      fee_limit: feeLimit,
      call_value: callValue,
    },
    'post'
  )) as {
    result?: { result?: boolean; message?: string }
    transaction?: unknown
  }

  if (!triggerResult?.result?.result)
    throw new Error(
      `wallet/triggersmartcontract failed: ${JSON.stringify(
        triggerResult?.result ?? triggerResult
      )}`
    )

  const transaction = triggerResult.transaction
  if (!transaction)
    throw new Error('No transaction in triggersmartcontract result')

  const signedTransaction = (await tronWeb.trx.sign(
    transaction as Parameters<typeof tronWeb.trx.sign>[0],
    params.privateKeyHex
  )) as Awaited<ReturnType<typeof tronWeb.trx.sign>>

  const result = await tronWeb.trx.sendRawTransaction(
    signedTransaction as Parameters<typeof tronWeb.trx.sendRawTransaction>[0]
  )

  if (!result.result)
    throw new Error(`sendRawTransaction failed: ${JSON.stringify(result)}`)

  const txIdRaw = result.txid || result.transaction?.txID
  if (!txIdRaw || typeof txIdRaw !== 'string')
    throw new Error('Transaction id missing in sendRawTransaction result')

  const txId = (
    txIdRaw.startsWith('0x') ? txIdRaw.slice(2) : txIdRaw
  ).toLowerCase()
  const hash = tronTxIdToHex(txId)
  const tronScanUrl = tronScanTransactionUrl(params.networkKey, txId)
  consola.info(`Blockchain Transaction Hash (Tron): \u001b[33m${txId}\u001b[0m`)
  consola.info(`TronScan: \u001b[36m${tronScanUrl}\u001b[0m`)

  const timeoutMs =
    params.confirmTimeoutMs ?? TRON_SAFE_EXEC_CONFIRM_TIMEOUT_MS_DEFAULT
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await tronWeb.trx.getTransactionInfo(txId)
      if (info && typeof info === 'object' && (info as { id?: string }).id)
        break
    } catch {
      // not yet indexed
    }
    await sleep(TRON_SAFE_EXEC_CONFIRM_POLL_MS)
  }

  if (Date.now() - start >= timeoutMs)
    consola.warn(
      `⚠️  Tron tx confirmation timed out after ${timeoutMs}ms; check ${tronScanUrl}`
    )

  return { txId, hash }
}

// ── Safe execTransaction wrapper ─────────────────────────────────────────────

export async function broadcastTronSafeExecTransaction(
  params: IBroadcastTronSafeExecParams
): Promise<IExecuteSafeExecTronWebResult> {
  const calldata = encodeFunctionData({
    abi: SAFE_SINGLETON_ABI,
    functionName: 'execTransaction',
    args: [
      params.to,
      params.value,
      params.data,
      params.operation,
      0n,
      0n,
      0n,
      '0x0000000000000000000000000000000000000000' as Address,
      '0x0000000000000000000000000000000000000000' as Address,
      params.signatures,
    ],
  })

  return broadcastTronContractCall({
    networkKey: params.networkName,
    privateKeyHex: params.privateKeyHex,
    contractAddress: params.safeAddressEvm,
    calldata,
    callValue: params.value,
    confirmTimeoutMs: params.confirmTimeoutMs,
  })
}
