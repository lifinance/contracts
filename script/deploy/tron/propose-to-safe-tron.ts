#!/usr/bin/env bun
/**
 * Propose to Safe (Tron)
 *
 * Creates a Safe transaction proposal on Tron (e.g. schedule Timelock → Diamond.confirmOwnershipTransfer)
 * and stores it in MongoDB. Use for step 2 of ownership transfer when the new owner is the Timelock.
 *
 * Usage:
 *   bun run script/deploy/tron/propose-to-safe-tron.ts
 *   bun run script/deploy/tron/propose-to-safe-tron.ts --dryRun
 */

import 'dotenv/config'

import * as fs from 'fs'
import * as path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { signMessage } from 'viem/accounts'

import { getEnvVar } from '../../demoScripts/utils/demoScriptHelpers'
import {
  getNextNonce,
  getSafeMongoCollection,
  type ISafeSignature,
  type ISafeTransaction,
  OperationTypeEnum,
  storeTransactionInMongoDB,
} from '../safe/safe-utils'
import { TIMELOCK_SCHEDULE_BATCH_ABI } from '../safe/timelock-abi'

import {
  TRON_DIAMOND_CONFIRM_OWNERSHIP_SELECTOR,
  TRON_SAFE_GET_TX_HASH_ABI,
} from './constants.js'
import type { TronTvmNetworkName } from './helpers/tronTvmChain.js'
import { createTronWebForTvmNetworkKey } from './helpers/tronWebFactory.js'
import {
  tronBase58ToEvm20Hex,
  tronZeroAddressBase58,
} from './tronAddressHelpers.js'

async function runPropose(options: { dryRun?: boolean }) {
  const networkName = 'tron'
  const deploymentPath = path.join(process.cwd(), 'deployments', 'tron.json')
  if (!fs.existsSync(deploymentPath))
    throw new Error('deployments/tron.json not found')

  const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
  const diamondAddressBase58 = deployments.LiFiDiamond
  const timelockAddressBase58 = deployments.LiFiTimelockController
  if (!diamondAddressBase58 || !timelockAddressBase58)
    throw new Error(
      'LiFiDiamond or LiFiTimelockController missing in deployments/tron.json'
    )

  const networksPath = path.join(process.cwd(), 'config', 'networks.json')
  const networks = JSON.parse(fs.readFileSync(networksPath, 'utf8'))
  const safeAddressBase58 = networks[networkName]?.safeAddress
  if (!safeAddressBase58)
    throw new Error('tron.safeAddress not set in config/networks.json')

  const privateKey = getEnvVar('PRIVATE_KEY_PRODUCTION')
  const tronWeb = createTronWebForTvmNetworkKey({
    networkKey: networkName as TronTvmNetworkName,
    privateKey,
  })
  const proposerBase58 =
    typeof tronWeb.defaultAddress.base58 === 'string'
      ? tronWeb.defaultAddress.base58
      : ''
  if (!proposerBase58)
    throw new Error(
      'TronWeb defaultAddress.base58 missing after loading PRIVATE_KEY_PRODUCTION'
    )

  const chainId = networks[networkName].chainId as number
  const safeAddressEvm = tronBase58ToEvm20Hex(tronWeb, safeAddressBase58)
  const timelockAddressEvm = tronBase58ToEvm20Hex(
    tronWeb,
    timelockAddressBase58
  )
  const diamondAddressEvm = tronBase58ToEvm20Hex(tronWeb, diamondAddressBase58)
  const proposerEvm = tronBase58ToEvm20Hex(tronWeb, proposerBase58)

  consola.info('Network: tron')
  consola.info(`Safe: ${safeAddressBase58}`)
  consola.info(`Timelock: ${timelockAddressBase58}`)
  consola.info(`Diamond: ${diamondAddressBase58}`)
  consola.info(`Proposer: ${proposerBase58}`)

  // 1) Get min delay from Timelock
  const timelockAbi = [
    {
      inputs: [],
      name: 'getMinDelay',
      outputs: [{ type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ]
  const timelock = tronWeb.contract(timelockAbi, timelockAddressBase58)
  let minDelayBigInt: bigint
  try {
    const minDelayRes = await timelock.getMinDelay().call()
    const valueStr =
      typeof minDelayRes === 'string'
        ? minDelayRes
        : minDelayRes?.toString?.() ?? '0'
    minDelayBigInt = BigInt(valueStr)
  } catch (e) {
    throw new Error(
      `Could not read getMinDelay from Timelock at ${timelockAddressBase58}: ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }

  const salt = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex
  const scheduleBatchCalldata = encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      [diamondAddressEvm],
      [0n],
      [TRON_DIAMOND_CONFIRM_OWNERSHIP_SELECTOR],
      '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex, // [pre-commit-checker: not a secret]
      salt,
      minDelayBigInt,
    ],
  })

  // 2) Get current Safe nonce on chain
  const safeAbiNonce = [
    {
      inputs: [],
      name: 'nonce',
      outputs: [{ type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ]
  const safeContract = tronWeb.contract(safeAbiNonce, safeAddressBase58)
  let chainNonceBigInt: bigint
  try {
    const nonceRes = await safeContract.nonce().call()
    const valueStr =
      typeof nonceRes === 'string' ? nonceRes : nonceRes?.toString?.() ?? '0'
    chainNonceBigInt = BigInt(valueStr)
  } catch (e) {
    throw new Error(
      'Failed to read Safe nonce on Tron: ' +
        (e instanceof Error ? e.message : String(e))
    )
  }

  const { client: mongoClient, pendingTransactions } =
    await getSafeMongoCollection()
  const nextNonce = await getNextNonce(
    pendingTransactions,
    safeAddressEvm,
    networkName,
    chainId,
    chainNonceBigInt
  )

  const safeTxData = {
    to: timelockAddressEvm,
    value: 0n,
    data: scheduleBatchCalldata,
    operation: OperationTypeEnum.Call,
    nonce: nextNonce,
  }

  // 3) Get transaction hash from Safe contract (Tron). Pass base58 for addresses; TronWeb encodes for the contract.
  const zeroBase58 = tronZeroAddressBase58(tronWeb)
  const safeFullAbi = [...TRON_SAFE_GET_TX_HASH_ABI]
  const safeForHash = tronWeb.contract(safeFullAbi, safeAddressBase58)
  let txHashHex: string
  try {
    const res = await safeForHash
      .getTransactionHash(
        timelockAddressBase58,
        '0',
        scheduleBatchCalldata,
        0,
        '0',
        '0',
        '0',
        zeroBase58,
        zeroBase58,
        nextNonce.toString()
      )
      .call()
    const raw = res?.toString?.() ?? (typeof res === 'string' ? res : '')
    txHashHex = raw.startsWith('0x') ? raw : '0x' + raw
  } catch (e) {
    consola.error(
      'getTransactionHash failed. Ensure Safe ABI and parameters are correct for Tron.'
    )
    throw e
  }

  const txHashBytes32 = (
    txHashHex.length === 66
      ? txHashHex
      : `0x${txHashHex.replace(/^0x/, '').padStart(64, '0')}`
  ) as Hex

  if (options.dryRun) {
    consola.info('[DRY RUN] Would store proposal:')
    consola.info('  to: ' + timelockAddressEvm)
    consola.info('  data: scheduleBatch(Diamond, confirmOwnershipTransfer())')
    consola.info('  nonce: ' + nextNonce.toString())
    consola.info('  safeTxHash: ' + txHashBytes32)
    await mongoClient.close()
    return
  }

  // 4) Sign hash (EIP-191 over tx hash bytes32, then r+s+v with v+4 for Safe eth_sign)
  const pk = privateKey.startsWith('0x')
    ? (privateKey as Hex)
    : (`0x${privateKey}` as Hex)
  const rawSig = await signMessage({
    message: { raw: txHashBytes32 },
    privateKey: pk,
  })
  if (!rawSig || rawSig.length < 130)
    throw new Error('Invalid signature length from signMessage')
  const r = rawSig.slice(0, 66)
  const s = rawSig.slice(66, 130)
  const vByte = rawSig.slice(130, 132)
  const vVal = parseInt(vByte, 16)
  const safeV = (vVal + 4).toString(16).padStart(2, '0')
  const safeSignatureHex = `0x${r.slice(2)}${s}${safeV}` as Hex

  const sig: ISafeSignature = {
    signer: proposerEvm,
    data: safeSignatureHex,
  }
  const signatures = new Map<string, ISafeSignature>()
  signatures.set(proposerEvm.toLowerCase(), sig)

  const safeTx: ISafeTransaction = {
    data: safeTxData,
    signatures,
  }
  // Mongo stores signatures as plain object; ensure serializable shape
  const safeTxForMongo = {
    data: safeTx.data,
    signatures: Object.fromEntries(safeTx.signatures),
  } as unknown as ISafeTransaction

  const result = await storeTransactionInMongoDB(
    pendingTransactions,
    safeAddressEvm as Address,
    networkName,
    chainId,
    safeTxForMongo,
    txHashBytes32,
    proposerEvm as Address
  )
  await mongoClient.close()

  if (result === null) {
    consola.info(
      'Proposal already exists (duplicate intent) - no new proposal created.'
    )
    return
  }
  if (!result.acknowledged)
    throw new Error('MongoDB insert was not acknowledged')
  consola.success(
    'Proposal stored in MongoDB. Other Safe owners can sign; then execute via confirm-safe-tx / execute-pending-timelock (when Tron execution is supported).'
  )
}

const main = defineCommand({
  meta: {
    name: 'propose-to-safe-tron',
    description:
      'Propose Diamond confirmOwnershipTransfer (via Timelock) to Tron Safe and store in MongoDB',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Do not write to MongoDB',
      default: false,
    },
  },
  async run({ args }) {
    try {
      await runPropose({ dryRun: args.dryRun })
      process.exit(0)
    } catch (e) {
      consola.error(e instanceof Error ? e.message : e)
      process.exit(1)
    }
  },
})

if (import.meta.main) runMain(main)
export { runPropose }
