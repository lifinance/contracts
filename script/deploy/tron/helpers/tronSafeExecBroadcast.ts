/**
 * Broadcast Gnosis Safe `execTransaction` on Tron via TronWeb + `wallet/triggersmartcontract`.
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
} from '../types'

import { tronScanTransactionUrl } from './tronScanUrls'
import { createTronWebForTvmNetworkKey } from './tronWebFactory'

export type {
  IExecuteSafeExecTronWebResult,
  ITronSafeExecParams,
} from '../types'

function parseSafeExecFeeLimitSun(): number {
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

function tronTxIdToExecutionHashHex(txId: string): Hex {
  const hex = txId.startsWith('0x') ? txId.slice(2) : txId
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return `0x${hex.toLowerCase()}` as Hex

  return `0x${hex}` as Hex
}

export async function broadcastTronSafeExecTransaction(
  params: IBroadcastTronSafeExecParams
): Promise<IExecuteSafeExecTronWebResult> {
  const tronWeb = createTronWebForTvmNetworkKey({
    networkKey: params.networkName,
    privateKey: params.privateKeyHex,
  })

  const ownerCheck = tronWeb.defaultAddress.base58
  if (typeof ownerCheck !== 'string' || !ownerCheck.startsWith('T'))
    throw new Error('TronWeb defaultAddress.base58 missing after init')

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
  const dataHexNo0x = calldata.slice(2)

  const ownerBase58 = tronWeb.defaultAddress.base58 as string
  const safeBase58 = evmHexToTronBase58(tronWeb, params.safeAddressEvm)
  const contractAddressHex = tronWeb.address.toHex(safeBase58)
  const ownerAddressHex = tronWeb.address.toHex(ownerBase58)

  const callValue =
    params.value > 0n
      ? (() => {
          if (params.value > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error(
              '[tron] Safe exec `value` too large for Tron trigger call_value; use 0 or a smaller amount.'
            )

          return Number(params.value)
        })()
      : 0

  const feeLimit = parseSafeExecFeeLimitSun()

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

  if (!triggerResult?.result?.result) {
    throw new Error(
      `wallet/triggersmartcontract failed: ${JSON.stringify(
        triggerResult?.result ?? triggerResult
      )}`
    )
  }

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
  const hash = tronTxIdToExecutionHashHex(txId)
  const tronScanUrl = tronScanTransactionUrl(params.networkName, txId)
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
