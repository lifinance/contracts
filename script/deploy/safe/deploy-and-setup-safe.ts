/**
 * deploy-and-setup-safe.ts
 *
 * Safe multisig deployment & setup script for any EVM chain.
 *
 * This script supports two deployment paths:
 *   1. **On-chain Safe**: if @safe-global/safe-deployments provides a Safe singleton,
 *      proxy factory and fallback handler for your chain, it will reuse those.
 *   2. **Local v1.4.1 fallback**: otherwise it deploys the Safe implementation & proxy
 *      factory bytecode you ship in `safe/`, then verifies their on-chain code.
 *
 * Workflow:
 *   • Merge owners from `config/global.json` + `--owners` CLI argument
 *   • Prompt for `staging` vs. `production` key (env vars `PRIVATE_KEY` / `PRIVATE_KEY_PRODUCTION`)
 *   • Lookup or deploy Safe implementation & proxy factory
 *   • Create a Safe proxy via `createProxyWithNonce(...)` with the `setup(...)` initializer
 *   • Wait for the `ProxyCreation` event, verify proxy bytecode (if fallback)
 *   • Call `getOwners()` and `getThreshold()` on the new Safe to confirm on-chain state
 *   • Update `config/networks.json` with the new `safeAddress`
 *
 * Required parameters:
 *   --network        SupportedChain name (e.g. arbitrum)
 *   --threshold      number of required confirmations
 *
 * Optional parameters:
 *   --owners         comma-separated extra owner addresses
 *   --fallbackHandler  custom fallback handler address (default: zero)
 *   --paymentToken   ERC20 token address for payment (default: zero = ETH)
 *   --payment        payment amount in wei (default: 0)
 *   --paymentReceiver address to receive payment (default: zero)
 *
 * Environment variables:
 *   PRIVATE_KEY               deployer key for staging
 *   PRIVATE_KEY_PRODUCTION    deployer key for production
 *   ETH_NODE_URI_<NETWORK>    RPC URL(s) for each network, loaded via `.env`
 *
 * Example:
 *   bun deploy-and-setup-safe.ts --network arbitrum --threshold 3 \
 *     --owners 0xAb…123,0xCd…456 --paymentToken 0xErc…789 --payment 1000000000000000
 */

import { defineCommand, runMain } from 'citty'
import {
  Address,
  zeroAddress,
  isAddress,
  getAddress,
  encodeFunctionData,
  decodeEventLog,
  Log,
} from 'viem'
import * as dotenv from 'dotenv'
import { SupportedChain } from '../../demoScripts/utils/demoScriptChainConfig'
import { setupEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import consola from 'consola'
import {
  getSafeSingletonDeployment,
  getSafeL2SingletonDeployment,
  getProxyFactoryDeployment,
  getFallbackHandlerDeployment,
} from '@safe-global/safe-deployments'

dotenv.config()

// ABI fragments for local v1.4.1 fallback
const SAFE_ABI = [
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
] as const

const SAFE_PROXY_FACTORY_ABI = [
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
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        internalType: 'address',
        name: 'proxy',
        type: 'address',
      },
      {
        indexed: false,
        internalType: 'address',
        name: 'singleton',
        type: 'address',
      },
    ],
    name: 'ProxyCreation',
    type: 'event',
  },
] as const

// ABI for reading owners & threshold
const SAFE_READ_ABI = [
  {
    inputs: [],
    name: 'getOwners',
    outputs: [{ internalType: 'address[]', name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getThreshold',
    outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const

// Compare on-chain bytecode vs. expected
async function compareDeployedBytecode(
  publicClient: any,
  address: Address,
  expected: `0x${string}`,
  name: string
): Promise<boolean> {
  const deployed = await publicClient.getCode({ address })
  const ok = deployed === expected
  if (ok) consola.success(`${name} bytecode verified`)
  else {
    consola.error(`${name} bytecode mismatch`)
    consola.debug('On-chain:', deployed.slice(0, 100), '…')
    consola.debug('Expected :', expected.slice(0, 100), '…')
  }
  return ok
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Deploy local Safe implementation & factory v1.4.1
async function deployLocalContracts(publicClient: any, walletClient: any) {
  const SAFE_ARTIFACT = JSON.parse(
    readFileSync(
      join(__dirname, '../../../safe/out/Safe_flattened.sol/Safe.json'),
      'utf8'
    )
  )
  const FACTORY_ARTIFACT = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../safe/out/SafeProxyFactory_flattened.sol/SafeProxyFactory.json'
      ),
      'utf8'
    )
  )
  const PROXY_ARTIFACT = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../safe/out/SafeProxyFactory_flattened.sol/SafeProxy.json'
      ),
      'utf8'
    )
  )

  const SAFE_BYTECODE = SAFE_ARTIFACT.bytecode.object as `0x${string}`
  const SAFE_DEPLOYED = SAFE_ARTIFACT.deployedBytecode.object as `0x${string}`
  const FACTORY_BYTECODE = FACTORY_ARTIFACT.bytecode.object as `0x${string}`
  const FACTORY_DEPLOYED = FACTORY_ARTIFACT.deployedBytecode
    .object as `0x${string}`
  const PROXY_DEPLOYED = PROXY_ARTIFACT.deployedBytecode.object as `0x${string}`

  // Deploy Safe implementation
  consola.info('📦 Deploying local Safe implementation…')
  const implTx = await walletClient.deployContract({
    abi: SAFE_ABI,
    bytecode: SAFE_BYTECODE,
  })
  const implRcpt = await publicClient.waitForTransactionReceipt({
    hash: implTx,
    confirmations: 5,
  })
  const implAddr = implRcpt.contractAddress!
  consola.success(`✔ Safe impl @ ${implAddr}`)
  await sleep(5000)
  await compareDeployedBytecode(
    publicClient,
    implAddr,
    SAFE_DEPLOYED,
    'Safe impl'
  )

  // Deploy ProxyFactory
  consola.info('📦 Deploying local SafeProxyFactory…')
  const facTx = await walletClient.deployContract({
    abi: SAFE_PROXY_FACTORY_ABI,
    bytecode: FACTORY_BYTECODE,
  })
  const facRcpt = await publicClient.waitForTransactionReceipt({
    hash: facTx,
    confirmations: 5,
  })
  const facAddr = facRcpt.contractAddress!
  consola.success(`✔ SafeProxyFactory @ ${facAddr}`)
  await sleep(5000)
  await compareDeployedBytecode(
    publicClient,
    facAddr,
    FACTORY_DEPLOYED,
    'SafeProxyFactory'
  )

  return { implAddr, facAddr, proxyBytecode: PROXY_DEPLOYED }
}

// Create the Safe proxy and run setup
async function createSafeProxy(params: {
  publicClient: any
  walletClient: any
  factoryAddress: Address
  singletonAddress: Address
  proxyBytecode?: `0x${string}`
  owners: Address[]
  threshold: number
  fallbackHandler: Address
  paymentToken: Address
  payment: bigint
  paymentReceiver: Address
}) {
  const {
    publicClient,
    walletClient,
    factoryAddress,
    singletonAddress,
    proxyBytecode,
    owners,
    threshold,
    fallbackHandler,
    paymentToken,
    payment,
    paymentReceiver,
  } = params

  // Build initializer calldata
  const initializer = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'setup',
    args: [
      owners,
      BigInt(threshold),
      zeroAddress,
      '0x',
      fallbackHandler,
      paymentToken,
      payment,
      paymentReceiver,
    ],
  })

  // Unique salt
  const salt =
    BigInt(Date.now()) ^
    BigInt.asUintN(64, BigInt(walletClient.account.address))

  consola.info('⚙️  Creating Safe proxy…')
  const txHash = await walletClient.writeContract({
    address: factoryAddress,
    abi: SAFE_PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [singletonAddress, initializer, salt],
  })
  const rcpt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 5,
  })
  if (rcpt.status === 'reverted') throw new Error('Proxy creation reverted')

  // Decode ProxyCreation event
  const proxyEvent = rcpt.logs
    .map((log: Log) => {
      try {
        return decodeEventLog({
          abi: SAFE_PROXY_FACTORY_ABI,
          data: log.data,
          topics: log.topics,
        })
      } catch {
        return null
      }
    })
    .find((e) => e && e.eventName === 'ProxyCreation')

  if (!proxyEvent) {
    throw new Error('ProxyCreation event not found')
  }

  const safeAddr = (proxyEvent.args as any).proxy as Address
  consola.success(`🎉 Safe deployed @ ${safeAddr}`)

  if (proxyBytecode) {
    const code = await publicClient.getCode({ address: safeAddr })
    if (code === proxyBytecode) consola.success('✔ Proxy bytecode verified')
    else consola.warn('⚠️ Proxy bytecode mismatch (continuing)')
  }

  return safeAddr
}

const main = defineCommand({
  meta: {
    name: 'deploy-and-setup-safe',
    description: 'Deploys (or reuses) a Gnosis Safe multisig on an EVM chain',
  },
  args: {
    network: {
      type: 'string',
      description: 'Target network name (SupportedChain)',
      required: true,
    },
    threshold: {
      type: 'string',
      description: 'Number of required confirmations',
      required: true,
    },
    owners: {
      type: 'string',
      description: 'Comma-separated extra owner addresses',
      required: false,
    },
    fallbackHandler: {
      type: 'string',
      description: 'Override fallback handler address',
      required: false,
    },
    paymentToken: {
      type: 'string',
      description: 'Payment token (default: 0x0 = ETH)',
      required: false,
    },
    payment: {
      type: 'string',
      description: 'Payment amount in wei (default: 0)',
      required: false,
    },
    paymentReceiver: {
      type: 'string',
      description: 'Where to send payment (default: 0x0)',
      required: false,
    },
  },
  async run({ args }) {
    // 1️⃣ choose env
    const environment = (await consola.prompt(
      'Which environment do you want to deploy to?',
      {
        type: 'select',
        options: [
          { value: 'staging', label: 'staging (uses PRIVATE_KEY)' },
          {
            value: 'production',
            label: 'production (uses PRIVATE_KEY_PRODUCTION)',
          },
        ],
      }
    )) as 'staging' | 'production'

    // 2️⃣ validate network & existing
    const networkName = args.network as SupportedChain
    const existing = networks[networkName]?.safeAddress
    if (existing && existing !== zeroAddress) {
      throw new Error(
        `Safe already deployed on ${networkName} @ ${existing}. Remove or clear networks.json to redeploy.`
      )
    }

    // 3️⃣ parse & validate threshold + owners
    const threshold = Number(args.threshold)
    if (isNaN(threshold) || threshold < 1) {
      throw new Error('Threshold must be a positive integer')
    }

    const extraOwners = (args.owners || '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
      .map((o) => {
        if (!isAddress(o)) throw new Error(`Invalid owner address: ${o}`)
        return getAddress(o)
      })

    const ownersFromConfig = globalConfig.safeOwners as Address[]
    const owners = [
      ...new Set([...ownersFromConfig, ...extraOwners]),
    ] as Address[]
    if (threshold > owners.length) {
      throw new Error('Threshold cannot exceed number of owners')
    }

    // optional params
    const fallbackHandler =
      args.fallbackHandler && isAddress(args.fallbackHandler)
        ? getAddress(args.fallbackHandler)
        : zeroAddress
    const paymentToken =
      args.paymentToken && isAddress(args.paymentToken)
        ? getAddress(args.paymentToken)
        : zeroAddress
    const payment = args.payment ? BigInt(args.payment) : 0n
    const paymentReceiver =
      args.paymentReceiver && isAddress(args.paymentReceiver)
        ? getAddress(args.paymentReceiver)
        : zeroAddress

    // setup clients
    const { publicClient, walletClient, walletAccount } =
      await setupEnvironment(networkName, null, environment)
    consola.info('Deployer:', walletAccount.address)

    // attempt safe-deployments lookup
    const chainId = String(await publicClient.getChainId())
    const isL2 = Boolean((publicClient as any).chain?.contracts?.l2OutputOracle)
    const singletonD = isL2
      ? getSafeL2SingletonDeployment({ network: chainId })
      : getSafeSingletonDeployment({ network: chainId })
    const factoryD = getProxyFactoryDeployment({ network: chainId })
    const fallbackD = getFallbackHandlerDeployment({ network: chainId })

    let singletonAddr = singletonD?.networkAddresses?.[chainId] as `0x${string}`
    let factoryAddr = factoryD?.networkAddresses?.[chainId] as `0x${string}`
    let fallbackAddr =
      (fallbackD?.networkAddresses?.[chainId] as `0x${string}`) || zeroAddress
    let proxyBytecode: `0x${string}` | undefined

    if (singletonAddr && factoryAddr) {
      consola.success('✅ Using @safe-global/safe-deployments contracts')
      consola.info(`Implementation    : ${singletonAddr}`)
      consola.info(`ProxyFactory      : ${factoryAddr}`)
      consola.info(`FallbackHandler   : ${fallbackAddr}`)
    } else {
      consola.warn(
        '⚠️  No on-chain Safe deployments found for this chain. Deploying local v1.4.1'
      )
      const deployed = await deployLocalContracts(publicClient, walletClient)
      singletonAddr = deployed.implAddr
      factoryAddr = deployed.facAddr
      fallbackAddr = fallbackHandler
      proxyBytecode = deployed.proxyBytecode
    }

    // create Safe proxy + setup
    const safeAddress = await createSafeProxy({
      publicClient,
      walletClient,
      factoryAddress: factoryAddr!,
      singletonAddress: singletonAddr!,
      proxyBytecode,
      owners,
      threshold,
      fallbackHandler: fallbackAddr,
      paymentToken,
      payment,
      paymentReceiver,
    })

    // verify on-chain owners & threshold
    consola.info('🔍 Verifying Safe on-chain state…')
    const [actualOwners, actualThreshold] = await Promise.all([
      publicClient.readContract({
        address: safeAddress,
        abi: SAFE_READ_ABI,
        functionName: 'getOwners',
      }),
      publicClient.readContract({
        address: safeAddress,
        abi: SAFE_READ_ABI,
        functionName: 'getThreshold',
      }),
    ])

    // normalize to lowercase
    const expected = owners.map((o) => o.toLowerCase())
    const actual = (actualOwners as Address[]).map((o) => o.toLowerCase())

    const missing = expected.filter((o) => !actual.includes(o))
    const extra = actual.filter((o) => !expected.includes(o))

    if (missing.length || extra.length) {
      consola.error('❌ Owner mismatch detected:')
      if (missing.length) consola.error(`  • Missing:  ${missing.join(', ')}`)
      if (extra.length) consola.error(`  • Unexpected: ${extra.join(', ')}`)
      throw new Error('Owner verification failed')
    } else {
      consola.success('✔ Owners match expected')
    }

    if (BigInt(threshold) !== BigInt(actualThreshold as bigint)) {
      consola.error(
        `❌ Threshold mismatch: expected=${threshold}, actual=${actualThreshold}`
      )
      throw new Error('Threshold verification failed')
    } else {
      consola.success('✔ Threshold matches expected')
    }

    // update networks.json
    networks[networkName] = {
      ...networks[networkName],
      safeAddress,
    }
    writeFileSync(
      join(__dirname, '../../../config/networks.json'),
      JSON.stringify(networks, null, 2),
      'utf8'
    )
    consola.success(`✔ networks.json updated with Safe @ ${safeAddress}`)
    consola.info('🎉 Deployment & verification complete!')
    consola.info(
      'IMPORTANT: Please manually update the safeWebUrl and safeApiUrl in networks.json for proper Safe UI integration.'
    )
  },
})

runMain(main)
