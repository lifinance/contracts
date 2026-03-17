#!/usr/bin/env bun
/**
 * Deploy a Safe (Gnosis Safe–style) multisig contract on Tron.
 *
 * Same flow as EVM deploy-safe.ts: deploy Safe implementation, deploy
 * SafeProxyFactory(singleton), then create a Safe proxy via
 * createProxyWithNonce(singleton, initializer, salt) and run setup(owners, threshold, ...).
 *
 * Uses Safe v1.4.1 artifacts from safe/london/ (Tron uses deployedWithEvmVersion: london).
 * TVM is largely EVM-compatible; if deployment or execution fails, consider compiling
 * the Safe contracts with Tron’s solc and replacing the artifact paths.
 *
 * Reads owners from config/global.json (safeOwners) as EVM 0x addresses and converts
 * them to Tron base58 for TVM ABI encoding (same 20-byte identity on-chain). Updates
 * config/networks.json with tron.safeAddress (base58).
 */
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import type { SupportedChain } from '../../common/types'
import { getEnvVar } from '../../demoScripts/utils/demoScriptHelpers'
import { sleep } from '../../utils/delay'

import { TronContractDeployer } from './TronContractDeployer.js'
import type { IForgeArtifact } from './types.js'
import { getTronRPCConfig } from './utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAFE_BASE = path.join(__dirname, '../../../safe/london/out')
const NETWORK: SupportedChain = 'tron'

const FACTORY_ABI = [
  {
    inputs: [
      { internalType: 'address', name: '_singleton', type: 'address' },
      { internalType: 'bytes', name: 'initializer', type: 'bytes' },
      { internalType: 'uint256', name: 'saltNonce', type: 'uint256' },
    ],
    name: 'createProxyWithNonce',
    outputs: [{ internalType: 'address', name: 'proxy', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
]

function loadSafeArtifacts(): {
  safe: IForgeArtifact
  factory: IForgeArtifact
} {
  const safePath = path.join(SAFE_BASE, 'Safe_flattened.sol', 'Safe.json')
  const factoryPath = path.join(
    SAFE_BASE,
    'SafeProxyFactory_flattened.sol',
    'SafeProxyFactory.json'
  )
  if (!fs.existsSync(safePath) || !fs.existsSync(factoryPath)) {
    throw new Error(
      `Safe artifacts not found. Run Foundry build in safe/london (e.g. forge build -C safe/london). Expected: ${safePath}, ${factoryPath}`
    )
  }
  const safe = JSON.parse(fs.readFileSync(safePath, 'utf8')) as IForgeArtifact
  const factory = JSON.parse(
    fs.readFileSync(factoryPath, 'utf8')
  ) as IForgeArtifact
  if (!safe.bytecode?.object || !factory.bytecode?.object) {
    throw new Error('Safe or Factory artifact missing bytecode.object')
  }
  return { safe, factory }
}

/**
 * Convert EVM address (0x + 40 hex) to Tron base58.
 * Same 20-byte identity; TronWeb expects base58 for address type when encoding for TVM.
 */
function evmAddressToTronBase58(tronWeb: TronWeb, evmAddress: string): string {
  const hex = evmAddress.startsWith('0x') ? evmAddress.slice(2) : evmAddress
  if (hex.length !== 40)
    throw new Error(`Invalid EVM address length: ${evmAddress}`)
  return tronWeb.address.fromHex('41' + hex)
}

/** Encode setup(owners, threshold, zero, 0x, zero, zero, 0, zero) for Safe. Owners and zero must be Tron base58. */
function encodeSetup(
  tronWeb: TronWeb,
  ownersBase58: string[],
  threshold: number
): string {
  const zeroBase58 = evmAddressToTronBase58(
    tronWeb,
    '0x0000000000000000000000000000000000000000'
  )
  const params = [
    { type: 'address[]', value: ownersBase58 },
    { type: 'uint256', value: threshold },
    { type: 'address', value: zeroBase58 },
    { type: 'bytes', value: '0x' },
    { type: 'address', value: zeroBase58 },
    { type: 'address', value: zeroBase58 },
    { type: 'uint256', value: 0 },
    { type: 'address', value: zeroBase58 },
  ]
  const types = params.map((p) => p.type)
  const values = params.map((p) => p.value)
  return tronWeb.utils.abi.encodeParams(types, values)
}

/** Parse ProxyCreation(proxy, singleton) from Tron tx log */
function parseProxyCreationFromLogs(
  logs: { address?: string; topics?: string[]; data?: string }[]
): string | null {
  const PROXY_CREATION_TOPIC =
    '4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235'
  for (const log of logs) {
    const topics = log.topics ?? []
    const t0 = (topics[0] ?? '').replace(/^0x/i, '')
    if (t0.toLowerCase() === PROXY_CREATION_TOPIC && topics[1]) {
      const hex = (topics[1] ?? '').replace(/^0x/i, '')
      const addrHex = hex.slice(-40)
      return '41' + addrHex
    }
  }
  return null
}

async function run(options: {
  threshold: number
  dryRun: boolean
  allowOverride: boolean
  safetyMargin: number
}) {
  const ownersFromConfig = (globalConfig as { safeOwners?: string[] })
    .safeOwners
  if (!Array.isArray(ownersFromConfig) || ownersFromConfig.length === 0) {
    throw new Error(
      'config/global.json must have safeOwners (array of 0x addresses)'
    )
  }
  const ownersEvm = ownersFromConfig as string[]
  const threshold = options.threshold
  if (threshold < 1 || threshold > ownersEvm.length) {
    throw new Error(
      `Threshold must be between 1 and ${ownersEvm.length} (number of owners)`
    )
  }

  const existing = (networks as Record<string, { safeAddress?: string }>)[
    NETWORK
  ]?.safeAddress
  if (
    existing &&
    existing.length > 0 &&
    existing !== '0x0000000000000000000000000000000000000000' &&
    !options.allowOverride
  ) {
    throw new Error(
      `Safe already set for tron in networks.json: ${existing}. Use --allowOverride to replace.`
    )
  }

  const privateKey = getEnvVar('PRIVATE_KEY_PRODUCTION')
  const { rpcUrl, headers } = getTronRPCConfig(NETWORK, false)
  const tronWebConfig: {
    fullHost: string
    privateKey: string
    headers?: Record<string, string>
  } = { fullHost: rpcUrl, privateKey }
  if (headers) tronWebConfig.headers = headers
  const tronWeb = new TronWeb(tronWebConfig)
  const deployer = new TronContractDeployer({
    fullHost: rpcUrl,
    privateKey,
    headers,
    dryRun: options.dryRun,
    safetyMargin: options.safetyMargin,
  })

  const ownersBase58 = ownersEvm.map((addr) =>
    evmAddressToTronBase58(tronWeb, addr)
  )
  consola.info('Deploying Safe (Gnosis Safe–style) on Tron')
  consola.info(`Deployer: ${tronWeb.defaultAddress.base58}`)
  consola.info(
    `Owners (EVM→Tron base58): ${ownersBase58.length}, threshold: ${threshold}, safetyMargin: ${options.safetyMargin}`
  )
  consola.info('Safe owners (Tron base58 addresses):')
  ownersEvm.forEach((evmAddr, i) => {
    consola.info(`  ${i + 1}. ${ownersBase58[i]}  (EVM: ${evmAddr})`)
  })

  const { safe: safeArtifact, factory: factoryArtifact } = loadSafeArtifacts()

  if (options.dryRun) {
    consola.info(
      '[DRY RUN] Would deploy Safe impl, SafeProxyFactory, and create Safe proxy with setup().'
    )
    return
  }

  // Delay before first RPC to avoid 429 rate limits
  await sleep(5000)

  // 1) Deploy Safe implementation (no constructor)
  consola.info('Deploying Safe implementation...')
  const safeResult = await deployer.deployContract(safeArtifact, [])
  const singletonAddress = safeResult.contractAddress
  consola.success(`Safe implementation: ${singletonAddress}`)
  await sleep(5000)

  // 2) Deploy SafeProxyFactory(singleton)
  consola.info('Deploying SafeProxyFactory...')
  const factoryResult = await deployer.deployContract(factoryArtifact, [
    singletonAddress,
  ])
  const factoryAddress = factoryResult.contractAddress
  consola.success(`SafeProxyFactory: ${factoryAddress}`)
  await sleep(5000)

  // 3) Encode setup and call createProxyWithNonce (owners in Tron base58 for TVM ABI)
  const initializer = encodeSetup(tronWeb, ownersBase58, threshold)
  const deployerHex =
    typeof tronWeb.defaultAddress.hex === 'string'
      ? tronWeb.defaultAddress.hex.replace(/^41/, '')
      : ''
  const salt =
    BigInt(Date.now()) ^ BigInt.asUintN(64, BigInt('0x' + deployerHex))

  const factoryContract = tronWeb.contract(
    [...FACTORY_ABI, ...factoryArtifact.abi],
    factoryAddress
  )

  await sleep(5000)
  consola.info('Creating Safe proxy (createProxyWithNonce + setup)...')
  const createTx = await factoryContract
    .createProxyWithNonce(singletonAddress, initializer, salt.toString())
    .send({
      feeLimit: 50_000_000,
      shouldPollResponse: true,
    })
  consola.info(`Transaction: ${createTx}`)

  await sleep(5000)
  const txInfo = await tronWeb.trx.getTransactionInfo(createTx)
  await sleep(5000)
  const logs = txInfo?.log ?? []
  const proxyHex = parseProxyCreationFromLogs(logs)
  let safeAddress: string
  if (proxyHex) {
    safeAddress = tronWeb.address.fromHex(proxyHex)
    consola.success(`Safe proxy: ${safeAddress}`)
  } else {
    consola.warn(
      'Could not parse ProxyCreation event; check transaction on explorer for proxy address.'
    )
    const manual = await consola.prompt('Enter Safe proxy address (base58):', {
      type: 'text',
    })
    const manualStr = typeof manual === 'string' ? manual : String(manual ?? '')
    if (!manualStr.trim()) throw new Error('No Safe proxy address provided.')
    safeAddress = manualStr.trim()
  }

  // Update networks.json
  const networksPath = path.join(process.cwd(), 'config', 'networks.json')
  const networksContent = JSON.parse(
    fs.readFileSync(networksPath, 'utf8')
  ) as Record<string, unknown>
  if (
    !networksContent[NETWORK] ||
    typeof networksContent[NETWORK] !== 'object'
  ) {
    throw new Error(`Missing or invalid networks.json entry for ${NETWORK}`)
  }
  ;(networksContent[NETWORK] as Record<string, unknown>).safeAddress =
    safeAddress
  fs.writeFileSync(
    networksPath,
    JSON.stringify(networksContent, null, 2),
    'utf8'
  )
  consola.success(
    `Updated config/networks.json: tron.safeAddress = ${safeAddress}`
  )
}

const main = defineCommand({
  meta: {
    name: 'deploy-safe-tron',
    description:
      'Deploy a Safe (Gnosis Safe–style) multisig contract on Tron and set tron.safeAddress in networks.json',
  },
  args: {
    threshold: {
      type: 'string',
      description: 'Number of required confirmations (default: 3)',
      default: '3',
    },
    dryRun: {
      type: 'boolean',
      description: 'Do not send transactions',
      default: false,
    },
    allowOverride: {
      type: 'boolean',
      description:
        'Allow overwriting existing tron.safeAddress in networks.json',
      default: false,
    },
    safetyMargin: {
      type: 'string',
      description:
        'Energy estimate multiplier (default 1.2). Lower (e.g. 1.1) reduces required TRX but may cause deployment to fail if estimate is tight.',
      default: '1.2',
    },
  },
  async run({ args }) {
    const threshold = parseInt(args.threshold, 10)
    if (isNaN(threshold) || threshold < 1) {
      consola.error('Invalid --threshold; must be a positive integer.')
      process.exit(1)
    }
    const safetyMargin = parseFloat(args.safetyMargin)
    if (isNaN(safetyMargin) || safetyMargin < 1 || safetyMargin > 3) {
      consola.error('Invalid --safetyMargin; must be a number between 1 and 3.')
      process.exit(1)
    }
    try {
      await run({
        threshold,
        dryRun: args.dryRun,
        allowOverride: args.allowOverride,
        safetyMargin,
      })
      process.exit(0)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      consola.error('Deploy failed:', message)
      process.exit(1)
    }
  },
})

if (import.meta.main) runMain(main)

export { run }
