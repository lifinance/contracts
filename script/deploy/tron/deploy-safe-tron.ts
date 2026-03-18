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
import { CREATE_PROXY_SAFETY_MARGIN } from './constants.js'
import type { IForgeArtifact } from './types.js'
import {
  getTronRPCConfig,
  getAccountAvailableResources,
  calculateEstimatedCost,
  estimateContractCallEnergy,
  promptEnergyRentalReminder,
  retryWithRateLimit,
} from './utils.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAFE_BASE = path.join(__dirname, '../../../safe/london/out')
const NETWORK: SupportedChain = 'tron'

/** Temp file for singleton/factory addresses during deploy; removed only when the full run succeeds. Not written to networks.json. */
const TRON_SAFE_TEMP_PATH = path.join(
  process.cwd(),
  'config',
  '.tron-safe-deploy-temp.json'
)

interface ITronSafeTemp {
  safeSingletonAddress?: string
  safeProxyFactoryAddress?: string
}

function readTronSafeTemp(): ITronSafeTemp | null {
  try {
    if (!fs.existsSync(TRON_SAFE_TEMP_PATH)) return null
    const raw = fs.readFileSync(TRON_SAFE_TEMP_PATH, 'utf8')
    const data = JSON.parse(raw) as ITronSafeTemp
    return data
  } catch {
    return null
  }
}

function writeTronSafeTemp(data: ITronSafeTemp): void {
  fs.writeFileSync(TRON_SAFE_TEMP_PATH, JSON.stringify(data, null, 2), 'utf8')
}

function removeTronSafeTemp(): void {
  try {
    if (fs.existsSync(TRON_SAFE_TEMP_PATH)) fs.unlinkSync(TRON_SAFE_TEMP_PATH)
  } catch {
    // ignore
  }
}

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

/** Minimal ABI for calling setup() on an existing Safe proxy. */
const SETUP_ABI = [
  {
    inputs: [
      { internalType: 'address[]', name: '_owners', type: 'address[]' },
      { internalType: 'uint256', name: '_threshold', type: 'uint256' },
      { internalType: 'address', name: 'to', type: 'address' },
      { internalType: 'bytes', name: 'data', type: 'bytes' },
      { internalType: 'address', name: 'fallbackHandler', type: 'address' },
      { internalType: 'address', name: 'paymentToken', type: 'address' },
      { internalType: 'uint256', name: 'payment', type: 'uint256' },
      {
        internalType: 'address payable',
        name: 'paymentReceiver',
        type: 'address',
      },
    ],
    name: 'setup',
    outputs: [],
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

/** Encode setup(owners, threshold, zero, 0x, zero, zero, 0, zero) for Safe. Uses 0x addresses (EVM-style) so contract ABI encoder accepts them. */
function encodeSetup(
  tronWeb: TronWeb,
  ownersBase58: string[],
  threshold: number
): string {
  const zeroHex = '0x0000000000000000000000000000000000000000'
  const ownersHex = ownersBase58.map((b58) =>
    tronWeb.address.toHex(b58).replace(/^41/, '0x')
  )
  const params = [
    { type: 'address[]', value: ownersHex },
    { type: 'uint256', value: threshold },
    { type: 'address', value: zeroHex },
    { type: 'bytes', value: '0x' },
    { type: 'address', value: zeroHex },
    { type: 'address', value: zeroHex },
    { type: 'uint256', value: 0 },
    { type: 'address', value: zeroHex },
  ]
  const types = params.map((p) => p.type)
  const values = params.map((p) => p.value)
  return tronWeb.utils.abi.encodeParams(types, values)
}

const PROXY_CREATION_TOPIC =
  '4f51faf6c4561ff95f067657e43439f0f856d97c04d9ec9070a6199ad418e235'

function normalizeTopic(t: string | undefined): string {
  if (!t) return ''
  const hex = String(t).replace(/^0x/i, '').trim()
  return hex.toLowerCase()
}

/** Parse ProxyCreation(proxy, singleton) from Tron tx log. Topic1 is proxy address (32-byte padded hex); we return TRON hex (41 + 20 bytes); caller converts to base58 (T...). */
function parseProxyCreationFromLogs(
  logs: { address?: string; topics?: string[]; data?: string }[]
): string | null {
  for (const log of logs) {
    const topics = log.topics ?? []
    const t0 = normalizeTopic(topics[0])
    if (t0 !== PROXY_CREATION_TOPIC) continue
    const t1 = (topics[1] ?? '').replace(/^0x/i, '').trim()
    if (t1.length >= 40) {
      const addrHex = t1.slice(-40) // last 20 bytes (40 hex chars)
      return '41' + addrHex // TRON hex; base58 (T...) via tronWeb.address.fromHex
    }
  }
  return null
}

/** Fallback: try to get created proxy from TRON internal_transactions (transferTo_address). */
function parseProxyFromInternalTx(
  tronWeb: TronWeb,
  txInfo: {
    internal_transactions?: Array<{ transferTo_address?: string }>
  },
  factoryAddress: string,
  singletonAddress: string
): string | null {
  const internal = txInfo?.internal_transactions
  if (!Array.isArray(internal)) return null
  for (const it of internal) {
    const raw = (it.transferTo_address ?? '')
      .replace(/^0x/i, '')
      .replace(/^41/i, '')
    if (raw.length !== 40) continue
    const toBase58 = tronWeb.address.fromHex('41' + raw)
    if (toBase58 !== factoryAddress && toBase58 !== singletonAddress)
      return toBase58
  }
  return null
}

/**
 * Call getThreshold() on a Safe proxy and return the value, or null if the call fails.
 * Used to verify the Safe was properly initialized (threshold should be >= 1).
 */
async function verifySafeThreshold(
  tronWeb: TronWeb,
  safeAddressBase58: string
): Promise<number | null> {
  try {
    const issuer =
      (typeof tronWeb.defaultAddress?.base58 === 'string'
        ? tronWeb.defaultAddress.base58
        : typeof tronWeb.defaultAddress?.hex === 'string'
        ? tronWeb.defaultAddress.hex
        : '') || ''
    const result = await tronWeb.transactionBuilder.triggerConstantContract(
      safeAddressBase58,
      'getThreshold()',
      {},
      [],
      issuer
    )
    const hex = result?.constant_result?.[0]
    if (!hex || typeof hex !== 'string') return null
    const raw = hex.startsWith('0x') ? hex : `0x${hex}`
    if (raw.length < 66) return null
    return Number(BigInt(raw))
  } catch {
    return null
  }
}

/**
 * Call setup() on an existing Safe proxy (e.g. one that was created but never initialized).
 * Uses tron.safeAddress from config/networks.json. Does not deploy any new contracts.
 */
async function runSetupOnly(args: {
  tronWeb: TronWeb
  networksContent: Record<
    string,
    {
      safeAddress?: string
      safeSingletonAddress?: string
      safeProxyFactoryAddress?: string
    }
  >
  networksPath: string
  ownersBase58: string[]
  ownersEvm: string[]
  threshold: number
  dryRun: boolean
  safetyMargin: number
}): Promise<void> {
  const {
    tronWeb,
    networksContent,
    ownersBase58,
    ownersEvm,
    threshold,
    dryRun,
    safetyMargin,
  } = args
  const safeAddress = (
    networksContent[NETWORK] as { safeAddress?: string }
  )?.safeAddress?.trim()
  if (!safeAddress) {
    throw new Error(
      `tron.safeAddress is not set in config/networks.json. Set it to the existing Safe proxy address (base58) to run setup only.`
    )
  }

  consola.info(
    'Setup only: calling setup() on existing Safe proxy (no deployment).'
  )
  consola.info(`Safe proxy: ${safeAddress}`)
  consola.info(
    `Owners: ${ownersBase58.length}, threshold: ${threshold} (from config/global.json)`
  )
  ownersEvm.forEach((evmAddr, i) => {
    consola.info(`  ${i + 1}. ${ownersBase58[i]}  (EVM: ${evmAddr})`)
  })

  if (dryRun) {
    consola.info('[DRY RUN] Would call setup() on the Safe proxy.')
    return
  }

  await promptEnergyRentalReminder()
  await sleep(5000)

  const zeroHex = '0x0000000000000000000000000000000000000000'
  const ownersHex = ownersBase58.map((b58) =>
    tronWeb.address.toHex(b58).replace(/^41/, '0x')
  )
  const setupParamsHex = encodeSetup(tronWeb, ownersBase58, threshold)

  const { rpcUrl } = getTronRPCConfig(NETWORK, false)
  const deployerBase58 =
    typeof tronWeb.defaultAddress?.base58 === 'string'
      ? tronWeb.defaultAddress.base58
      : ''
  if (!deployerBase58)
    throw new Error('Deployer address (base58) not available')

  const estimatedEnergy = await estimateContractCallEnergy({
    fullHost: rpcUrl,
    tronWeb,
    contractAddressBase58: safeAddress,
    functionSelector:
      'setup(address[],uint256,address,bytes,address,address,uint256,address)',
    parameterHex: setupParamsHex,
    safetyMargin,
  })
  const { availableEnergy } = await getAccountAvailableResources(
    rpcUrl,
    deployerBase58
  )
  const { totalCost } = await calculateEstimatedCost(
    tronWeb,
    estimatedEnergy,
    0
  )
  const feeLimitSun = Math.min(
    Math.max(Math.ceil(Number(tronWeb.toSun(totalCost))), 5_000_000),
    100_000_000
  )
  consola.info(
    `setup(): estimated energy ${estimatedEnergy}, available ${availableEnergy}; fee limit ${
      feeLimitSun / 1_000_000
    } TRX`
  )

  const safeContract = tronWeb.contract(SETUP_ABI, safeAddress)
  await sleep(3000)
  const txId = await retryWithRateLimit(
    () =>
      safeContract
        .setup(
          ownersHex,
          threshold,
          zeroHex,
          '0x',
          zeroHex,
          zeroHex,
          0,
          zeroHex
        )
        .send({
          feeLimit: feeLimitSun,
          shouldPollResponse: true,
        }),
    3,
    10000,
    (attempt, delay) =>
      consola.warn(
        `Rate limit or connection issue, retry ${attempt}/3 in ${
          delay / 1000
        }s...`
      )
  )
  const txIdStr = typeof txId === 'string' && txId ? txId : String(txId ?? '')
  if (!txIdStr) throw new Error('setup() did not return a transaction ID')
  consola.success(`setup() transaction: ${txIdStr}`)

  await sleep(5000)
  const onChainThreshold = await verifySafeThreshold(tronWeb, safeAddress)
  if (onChainThreshold !== null) {
    if (onChainThreshold === 0) {
      consola.warn(
        'getThreshold() still 0 after setup(). Check the transaction; setup may have reverted.'
      )
    } else {
      consola.success(`Verified Safe threshold: ${onChainThreshold}`)
    }
  }
}

async function run(options: {
  threshold: number
  dryRun: boolean
  allowOverride: boolean
  safetyMargin: number
  setupOnly?: boolean
  safeSingletonAddress?: string
  safeProxyFactoryAddress?: string
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

  const privateKey = getEnvVar('PRIVATE_KEY_PRODUCTION')
  const { rpcUrl, headers } = getTronRPCConfig(NETWORK, false)
  const tronWebConfig: {
    fullHost: string
    privateKey: string
    headers?: Record<string, string>
  } = { fullHost: rpcUrl, privateKey }
  if (headers) tronWebConfig.headers = headers
  const tronWeb = new TronWeb(tronWebConfig)
  const ownersBase58 = ownersEvm.map((addr) =>
    evmAddressToTronBase58(tronWeb, addr)
  )

  const networksPath = path.join(process.cwd(), 'config', 'networks.json')
  const networksContent = JSON.parse(
    fs.readFileSync(networksPath, 'utf8')
  ) as Record<
    string,
    {
      safeAddress?: string
      safeSingletonAddress?: string
      safeProxyFactoryAddress?: string
    }
  >

  if (options.setupOnly) {
    await runSetupOnly({
      tronWeb,
      networksContent,
      networksPath,
      ownersBase58,
      ownersEvm,
      threshold,
      dryRun: options.dryRun,
      safetyMargin: options.safetyMargin,
    })
    return
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

  const deployer = new TronContractDeployer({
    fullHost: rpcUrl,
    privateKey,
    headers,
    dryRun: options.dryRun,
    safetyMargin: options.safetyMargin,
  })

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

  await promptEnergyRentalReminder()

  // Delay before first RPC to avoid 429 rate limits
  await sleep(10000)

  const tempState = readTronSafeTemp()
  const existingSingleton =
    options.safeSingletonAddress?.trim() ||
    process.env.TRON_SAFE_SINGLETON_ADDRESS?.trim() ||
    tempState?.safeSingletonAddress?.trim()
  const existingFactory =
    options.safeProxyFactoryAddress?.trim() ||
    process.env.TRON_SAFE_PROXY_FACTORY_ADDRESS?.trim() ||
    tempState?.safeProxyFactoryAddress?.trim()

  let singletonAddress: string
  let factoryAddress: string

  if (existingSingleton && existingFactory) {
    consola.info(
      `Using existing Safe impl: ${existingSingleton} and Factory: ${existingFactory} (skip deploy)`
    )
    singletonAddress = existingSingleton
    factoryAddress = existingFactory
    const fromFlagsOrEnv =
      options.safeSingletonAddress && options.safeProxyFactoryAddress
    if (fromFlagsOrEnv) {
      writeTronSafeTemp({
        safeSingletonAddress: singletonAddress,
        safeProxyFactoryAddress: factoryAddress,
      })
      consola.info(
        'Saved singleton/factory to temp file for this run (not written to networks.json).'
      )
    }
    await sleep(3000)
  } else {
    // 1) Deploy Safe implementation (no constructor)
    if (!existingSingleton) {
      consola.info('Deploying Safe implementation...')
      const safeResult = await deployer.deployContract(safeArtifact, [])
      singletonAddress = safeResult.contractAddress
      consola.success(`Safe implementation: ${singletonAddress}`)
      writeTronSafeTemp({
        ...readTronSafeTemp(),
        safeSingletonAddress: singletonAddress,
      })
      await sleep(8000)
    } else {
      singletonAddress = existingSingleton
      consola.info(`Using existing Safe implementation: ${singletonAddress}`)
    }

    // 2) Deploy SafeProxyFactory(singleton)
    if (!existingFactory) {
      consola.info('Deploying SafeProxyFactory...')
      const factoryResult = await deployer.deployContract(factoryArtifact, [
        singletonAddress,
      ])
      factoryAddress = factoryResult.contractAddress
      consola.success(`SafeProxyFactory: ${factoryAddress}`)
      writeTronSafeTemp({
        ...readTronSafeTemp(),
        safeSingletonAddress: singletonAddress,
        safeProxyFactoryAddress: factoryAddress,
      })
      await sleep(8000)
    } else {
      factoryAddress = existingFactory
      consola.info(`Using existing SafeProxyFactory: ${factoryAddress}`)
      await sleep(3000)
    }
  }

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

  await sleep(8000)
  consola.info('Creating Safe proxy (createProxyWithNonce + setup)...')

  // Estimate energy and set fee limit so delegated energy is used first (cheaper deployment)
  await sleep(5000)
  const createProxyParamsHex = tronWeb.utils.abi.encodeParams(
    ['address', 'bytes', 'uint256'],
    [
      tronWeb.address.toHex(singletonAddress).replace(/^41/, '0x'),
      initializer,
      salt.toString(),
    ]
  )
  const estimatedEnergy = await estimateContractCallEnergy({
    fullHost: rpcUrl,
    tronWeb,
    contractAddressBase58: factoryAddress,
    functionSelector: 'createProxyWithNonce(address,bytes,uint256)',
    parameterHex: createProxyParamsHex,
    safetyMargin: CREATE_PROXY_SAFETY_MARGIN,
  })
  const deployerBase58 =
    typeof tronWeb.defaultAddress.base58 === 'string'
      ? tronWeb.defaultAddress.base58
      : ''
  if (!deployerBase58)
    throw new Error('Deployer address (base58) not available')
  const { availableEnergy } = await getAccountAvailableResources(
    rpcUrl,
    deployerBase58
  )
  const { totalCost } = await calculateEstimatedCost(
    tronWeb,
    estimatedEnergy,
    0
  )
  const feeLimitSun = Math.min(
    Math.max(Math.ceil(Number(tronWeb.toSun(totalCost))), 5_000_000), // min 5 TRX
    100_000_000
  ) // max 100 TRX
  consola.info(
    `createProxyWithNonce: estimated energy ${estimatedEnergy}, available ${availableEnergy}; fee limit ${
      feeLimitSun / 1_000_000
    } TRX (delegation used first)`
  )

  await sleep(5000)
  const singletonHex = tronWeb.address
    .toHex(singletonAddress)
    .replace(/^41/, '0x')
  const createTx = await retryWithRateLimit(
    () =>
      factoryContract
        .createProxyWithNonce(singletonHex, initializer, salt.toString())
        .send({
          feeLimit: feeLimitSun,
          shouldPollResponse: true,
        }),
    3,
    10000,
    (attempt, delay) =>
      consola.warn(
        `Rate limit (429) or connection issue, retry ${attempt}/3 in ${
          delay / 1000
        }s...`
      )
  )
  const txId =
    typeof createTx === 'string' && createTx ? createTx : String(createTx ?? '')
  if (!txId)
    throw new Error('createProxyWithNonce did not return a transaction ID')
  consola.info(`Transaction: ${txId}`)

  await sleep(8000)
  const txInfo = await tronWeb.trx.getTransactionInfo(txId)
  await sleep(5000)
  const logs = txInfo?.log ?? []
  const proxyHex = parseProxyCreationFromLogs(logs)
  const fromInternal =
    !proxyHex && txInfo
      ? parseProxyFromInternalTx(
          tronWeb,
          txInfo,
          factoryAddress,
          singletonAddress
        )
      : null
  let safeAddress: string
  if (proxyHex) {
    safeAddress = tronWeb.address.fromHex(
      proxyHex.startsWith('41') ? proxyHex : '41' + proxyHex.slice(-40)
    )
    consola.success(`Safe proxy: ${safeAddress}`)
  } else if (fromInternal) {
    safeAddress = fromInternal
    consola.success(`Safe proxy (from internal tx): ${safeAddress}`)
  } else {
    const txUrl = `https://tronscan.org/#/transaction/${txId}`
    consola.warn(
      'Could not parse ProxyCreation event; get the Safe proxy address from the transaction.'
    )
    consola.info(
      `Open: ${txUrl} → "Internal Transactions" or "Event Logs" tab for the new proxy address (base58, starts with T).`
    )
    const manual = await consola.prompt('Enter Safe proxy address (base58):', {
      type: 'text',
    })
    const manualStr = typeof manual === 'string' ? manual : String(manual ?? '')
    if (!manualStr.trim()) throw new Error('No Safe proxy address provided.')
    safeAddress = manualStr.trim()
  }

  // Verify Safe was initialized: getThreshold() should be >= 1
  await sleep(2000)
  const onChainThreshold = await verifySafeThreshold(tronWeb, safeAddress)
  if (onChainThreshold !== null) {
    if (onChainThreshold === 0) {
      consola.warn(
        'Safe getThreshold() returned 0. The Safe may not be properly initialized (setup() may have failed). Check the deployment transaction and consider redeploying.'
      )
    } else {
      consola.success(`Verified Safe threshold: ${onChainThreshold}`)
    }
  }

  // Update networks.json with final Safe proxy address only (do not persist singleton/factory)
  if (
    !networksContent[NETWORK] ||
    typeof networksContent[NETWORK] !== 'object'
  ) {
    throw new Error(`Missing or invalid networks.json entry for ${NETWORK}`)
  }
  const networkEntry = networksContent[NETWORK] as Record<string, unknown>
  networkEntry.safeAddress = safeAddress
  delete networkEntry.safeSingletonAddress
  delete networkEntry.safeProxyFactoryAddress
  fs.writeFileSync(
    networksPath,
    JSON.stringify(networksContent, null, 2),
    'utf8'
  )
  consola.success(
    `Updated config/networks.json: tron.safeAddress = ${safeAddress}`
  )
  removeTronSafeTemp()
  consola.info('Removed temp file (deploy completed successfully).')
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
    safeSingletonAddress: {
      type: 'string',
      description:
        'Existing Safe implementation address (base58). If set with --safeProxyFactoryAddress, skips deploying Safe impl and Factory and only runs createProxyWithNonce.',
      default: '',
    },
    safeProxyFactoryAddress: {
      type: 'string',
      description:
        'Existing SafeProxyFactory address (base58). Use with --safeSingletonAddress to skip deploy and only create the Safe proxy.',
      default: '',
    },
    setupOnly: {
      type: 'boolean',
      description:
        'Only call setup() on the existing Safe at tron.safeAddress (no deployment). Use when the proxy was created but never initialized.',
      default: false,
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
        setupOnly: args.setupOnly,
        safeSingletonAddress: args.safeSingletonAddress || undefined,
        safeProxyFactoryAddress: args.safeProxyFactoryAddress || undefined,
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
