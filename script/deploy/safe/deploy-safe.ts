/**
 * deploy-safe.ts
 *
 * Safe multisig deployment & setup script for any EVM chain.
 *
 * This script supports two deployment paths:
 *   1. **On chain Safe**: if @safe-global/safe-deployments provides a Safe singleton,
 *      proxy factory and fallback handler for your chain, it will reuse those.
 *   2. **Local v1.4.1 fallback**: otherwise it deploys the Safe implementation & proxy
 *      factory bytecode from either:
 *         - safe/cancun/ (for Cancun EVM networks)
 *         - safe/london/ (for London EVM networks)
 *      The appropriate version is automatically selected based on the network's
 *      deployedWithEvmVersion in networks.json.
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
 *
 * Optional parameters:
 *   --threshold      number of required confirmations (default: 3)
 *   --owners         comma-separated extra owner addresses
 *   --fallbackHandler  custom fallback handler address (default: zero)
 *   --paymentToken   ERC20 token address for payment (default: zero = ETH)
 *   --payment        payment amount in wei (default: 0)
 *   --paymentReceiver address to receive payment (default: zero)
 *   --allowOverride  whether to allow overriding existing Safe address in networks.json (default: false)
 *   --rpcUrl         custom RPC URL (uses network default if not provided)
 *   --evmVersion     EVM version to use (london or cancun). Defaults to network setting from networks.json
 *
 * Environment variables:
 *   PRIVATE_KEY               deployer key for staging
 *   PRIVATE_KEY_PRODUCTION    deployer key for production
 *   ETH_NODE_URI_<NETWORK>    RPC URL(s) for each network, loaded via `.env`
 *
 * Example:
 *   bun deploy-and-setup-safe.ts --network arbitrum \
 *     --owners 0xAb…123,0xCd…456 --paymentToken 0xErc…789 --payment 1000000000000000
 */

// Node.js built-in modules first
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

// Third-party dependencies in alphabetical order
import {
  getFallbackHandlerDeployment,
  getProxyFactoryDeployment,
  getSafeL2SingletonDeployment,
  getSafeSingletonDeployment,
} from '@safe-global/safe-deployments'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import * as dotenv from 'dotenv'
import {
  type Address,
  type Log,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddress,
  zeroAddress,
} from 'viem'

// Local imports last, in alphabetical order
import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import { IEnvironmentEnum, type SupportedChain } from '../../common/types'
import { setupEnvironment } from '../../demoScripts/utils/demoScriptHelpers'

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

const sleep = (ms: number): Promise<void> => {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

// At the top of the file, add new type for EVM versions
type EVMVersion = 'london' | 'cancun'

// Modify the command arguments to include EVM version
const main = defineCommand({
  meta: {
    name: 'deploy-safe',
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
      description: 'Number of required confirmations (default: 3)',
      required: false,
      default: '3',
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
    allowOverride: {
      type: 'boolean',
      description:
        'Whether to allow overriding existing Safe address in networks.json (default: true)',
      required: false,
      default: true,
    },
    rpcUrl: {
      type: 'string',
      description:
        'Custom RPC URL (optional, uses network default if not provided)',
      required: false,
    },
    evmVersion: {
      type: 'string',
      description:
        'EVM version to use (london or cancun). Defaults to network setting from networks.json',
      required: false,
    },
  },
  async run({ args }) {
    // choose env
    // const environment = (await consola.prompt(
    //   'Which environment do you want to deploy to?',
    //   {
    //     type: 'select',
    //     options: [
    //       { value: 'staging', label: 'staging (uses PRIVATE_KEY)' },
    //       {
    //         value: 'production',
    //         label: 'production (uses PRIVATE_KEY_PRODUCTION)',
    //       },
    //     ],
    //   }
    // )) as unknown as EnvironmentEnum
    // we currently use SAFEs only in production but will keep this code just in case
    const environment: IEnvironmentEnum = IEnvironmentEnum.production

    // validate network & existing
    const networkName = args.network as SupportedChain
    const existing = networks[networkName]?.safeAddress
    if (existing && existing !== zeroAddress && !args.allowOverride)
      throw new Error(
        `Safe already deployed on ${networkName} @ ${existing}. Use --allowOverride flag to force redeployment.`
      )

    // parse & validate threshold + owners
    const isDefaultThreshold = !process.argv.includes('--threshold')
    const threshold = Number(args.threshold)
    if (isNaN(threshold) || threshold < 1)
      throw new Error('Threshold must be a positive integer')

    if (isDefaultThreshold)
      consola.info('ℹ Using default threshold of 3 required confirmations')

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
    if (threshold > owners.length)
      throw new Error('Threshold cannot exceed number of owners')

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
    const { publicClient, walletClient, walletAccount, chain } =
      await setupEnvironment(networkName, null, environment, args.rpcUrl)
    consola.info('Deployer:', walletAccount.address)

    // Determine EVM version
    const networkConfig = networks[networkName]
    let evmVersion: EVMVersion = 'cancun' // Default to cancun

    if (args.evmVersion) {
      // If explicitly specified via CLI
      if (!['london', 'cancun'].includes(args.evmVersion))
        throw new Error(
          'Invalid EVM version. Must be either "london" or "cancun"'
        )

      evmVersion = args.evmVersion as EVMVersion
    } else if (networkConfig?.deployedWithEvmVersion)
      // Use network-specific version if available
      evmVersion =
        networkConfig.deployedWithEvmVersion.toLowerCase() as EVMVersion

    consola.info(`Using EVM version: ${evmVersion}`)

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

    if (!factoryAddr && factoryD) {
      consola.warn(
        `No factory deployment found for chain ID ${chainId}. Using latest version.`
      )
      const networks = Object.keys(factoryD.networkAddresses).sort(
        (a, b) => parseInt(b) - parseInt(a)
      )

      if (networks.length > 0) {
        const latestNetwork = networks[0]
        if (!latestNetwork || !factoryD.networkAddresses[latestNetwork])
          throw new Error('Invalid network address configuration')
        factoryAddr = factoryD.networkAddresses[latestNetwork] as `0x${string}`
        consola.info(
          `Using factory from network ${latestNetwork}: ${factoryAddr}`
        )
      } else
        throw new Error(
          'No Safe factory deployment found in @safe-global/safe-deployments'
        )
    }

    let fallbackAddr = fallbackD?.networkAddresses?.[chainId] as `0x${string}`

    if (!fallbackAddr && fallbackD) {
      consola.warn(
        `No fallback handler deployment found for chain ID ${chainId}. Using latest version.`
      )
      const networks = Object.keys(fallbackD.networkAddresses).sort(
        (a, b) => parseInt(b) - parseInt(a)
      )

      if (networks.length > 0) {
        const latestNetwork = networks[0]
        if (!latestNetwork || !fallbackD.networkAddresses[latestNetwork])
          throw new Error('Invalid network address configuration')
        fallbackAddr = fallbackD.networkAddresses[
          latestNetwork
        ] as `0x${string}`
        consola.info(
          `Using fallback handler from network ${latestNetwork}: ${fallbackAddr}`
        )
      } else {
        fallbackAddr = zeroAddress
        consola.warn(`Using zero address for fallback handler`)
      }
    }

    let proxyBytecode: `0x${string}` | undefined

    if (singletonAddr && factoryAddr) {
      consola.success('✅ Using @safe-global/safe-deployments contracts')
      consola.info(`Implementation    : ${singletonAddr}`)
      consola.info(`ProxyFactory      : ${factoryAddr}`)
      consola.info(`FallbackHandler   : ${fallbackAddr}`)
    } else {
      consola.warn(
        `⚠️  No on-chain Safe deployments found for this chain. Deploying local v1.4.1 (${evmVersion})`
      )
      const deployed = await deployLocalContracts(
        publicClient,
        walletClient,
        evmVersion
      )
      singletonAddr = deployed.implAddr
      factoryAddr = deployed.facAddr
      fallbackAddr = fallbackHandler
      proxyBytecode = deployed.proxyBytecode
    }

    // create Safe proxy + setup
    const safeAddress = await createSafeProxy({
      publicClient,
      walletClient,
      factoryAddress: factoryAddr,
      singletonAddress: singletonAddr,
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

    try {
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

      const expected = owners.map((o) => o.toLowerCase())
      const actual = (actualOwners as Address[]).map((o) => o.toLowerCase())

      const missing = expected.filter((o) => !actual.includes(o))
      const extra = actual.filter((o) => !expected.includes(o))

      if (missing.length || extra.length) {
        consola.error('❌ Owner mismatch detected:')
        if (missing.length) consola.error(`  • Missing:  ${missing.join(', ')}`)
        if (extra.length) consola.error(`  • Unexpected: ${extra.join(', ')}`)
        throw new Error('Owner verification failed')
      } else consola.success('✔ Owners match expected')

      if (BigInt(threshold) !== BigInt(actualThreshold)) {
        consola.error(
          `❌ Threshold mismatch: expected=${threshold}, actual=${actualThreshold}`
        )
        throw new Error('Threshold verification failed')
      } else consola.success('✔ Threshold matches expected')
    } catch (error) {
      consola.error('❌ Verification failed with error:', error)
      consola.error(`Safe address: ${safeAddress}`)
      consola.error(
        'Please check the deployed Safe manually and update networks.json if needed'
      )
      throw error
    }

    // update networks.json
    try {
      if (args.allowOverride) {
        ;(networks as any)[networkName] = {
          ...networks[networkName],
          safeAddress,
        }
        writeFileSync(
          join(__dirname, '../../../config/networks.json'),
          JSON.stringify(networks, null, 2),
          'utf8'
        )
        consola.success(`✔ networks.json updated with Safe @ ${safeAddress}`)
      } else
        consola.info(`ℹ Skipping networks.json update (--allowOverride=false)`)
    } catch (error) {
      consola.error('❌ Failed to update networks.json:', error)
      consola.error(
        `Please manually update the safeAddress for ${networkName} to: ${safeAddress}`
      )
      throw error
    }

    if (safeAddress) {
      consola.info('-'.repeat(80))
      consola.info('🎉 Deployment complete!')
      consola.info(`Safe Address: \u001b[32m${safeAddress}\u001b[0m`)
      const explorerUrl = chain.blockExplorers?.default?.url
      if (explorerUrl)
        consola.info(
          `Explorer URL: \u001b[36m${explorerUrl}/address/${safeAddress}\u001b[0m`
        )

      consola.info('-'.repeat(80))
    }
  },
})

runMain(main)

async function deployLocalContracts(
  publicClient: any,
  walletClient: any,
  evmVersion: EVMVersion
) {
  const basePath = evmVersion === 'london' ? 'london' : 'cancun'

  const SAFE_ARTIFACT = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../safe/${basePath}/out/Safe_flattened.sol/Safe.json`
      ),
      'utf8'
    )
  )
  const FACTORY_ARTIFACT = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../safe/${basePath}/out/SafeProxyFactory_flattened.sol/SafeProxyFactory.json`
      ),
      'utf8'
    )
  )
  const PROXY_ARTIFACT = JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../safe/${basePath}/out/SafeProxyFactory_flattened.sol/SafeProxy.json`
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

  // deploy Safe implementation
  consola.info('📦 Estimating gas for Safe implementation deployment...')
  const safeGasEstimate = await publicClient.estimateGas({
    account: walletClient.account.address,
    data: SAFE_BYTECODE,
  })
  consola.info(`Estimated gas for Safe implementation: ${safeGasEstimate}`)

  consola.info('📦 Deploying local Safe implementation…')
  const implTx = await walletClient.deployContract({
    abi: SAFE_ABI,
    bytecode: SAFE_BYTECODE,
    gas: safeGasEstimate,
  })
  const implRcpt = await publicClient.waitForTransactionReceipt({
    hash: implTx,
    confirmations: 5,
  })
  if (!implRcpt.contractAddress)
    throw new Error('Contract address not found in receipt')
  const implAddr = implRcpt.contractAddress
  consola.success(`✔ Safe impl @ ${implAddr}`)
  await sleep(5000)
  await compareDeployedBytecode(
    publicClient,
    implAddr,
    SAFE_DEPLOYED,
    'Safe impl'
  )

  // deploy ProxyFactory
  consola.info('📦 Estimating gas for ProxyFactory deployment...')
  const factoryGasEstimate = await publicClient.estimateGas({
    account: walletClient.account.address,
    data: FACTORY_BYTECODE,
  })
  consola.info(`Estimated gas for ProxyFactory: ${factoryGasEstimate}`)

  consola.info('📦 Deploying local SafeProxyFactory…')
  const facTx = await walletClient.deployContract({
    abi: SAFE_PROXY_FACTORY_ABI,
    bytecode: FACTORY_BYTECODE,
    gas: factoryGasEstimate,
  })
  const facRcpt = await publicClient.waitForTransactionReceipt({
    hash: facTx,
    confirmations: 5,
  })
  if (!facRcpt.contractAddress)
    throw new Error('Contract address not found in receipt')
  const facAddr = facRcpt.contractAddress
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

// create the Safe proxy and run setup
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

  // build initializer calldata
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

  try {
    const txHash = await walletClient.writeContract({
      address: factoryAddress,
      abi: SAFE_PROXY_FACTORY_ABI,
      functionName: 'createProxyWithNonce',
      args: [singletonAddress, initializer, salt],
    })

    consola.info(`Transaction submitted: ${txHash}`)
    const rcpt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      confirmations: 5,
    })

    if (rcpt.status === 'reverted') {
      consola.error('❌ Proxy creation transaction reverted')
      throw new Error('Proxy creation reverted')
    }

    // decode ProxyCreation event
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
      .find((e: any) => e && e.eventName === 'ProxyCreation')

    if (!proxyEvent) {
      consola.warn('No ProxyCreation events found in transaction logs')
      consola.info(`Please check transaction ${txHash} on the explorer`)

      const explorerUrl = publicClient.chain?.blockExplorers?.default?.url
      if (explorerUrl) consola.info(`Explorer URL: ${explorerUrl}/tx/${txHash}`)

      const safeAddress = (await consola.prompt(
        'Enter the deployed Safe address:',
        {
          type: 'text',
          validate: (input: string) =>
            /^0x[a-fA-F0-9]{40}$/.test(input)
              ? true
              : 'Please enter a valid Ethereum address',
        }
      )) as Address
      const safeAddress = await consola.prompt(
        'Enter the deployed Safe address:',
        {
          type: 'text',
          validate: (input: string) =>
            /^0x[a-fA-F0-9]{40}$/.test(input)
              ? true
              : 'Please enter a valid Ethereum address',
        }
      )

      return safeAddress
    }

    const safeAddr = proxyEvent.args.proxy as Address
    consola.success(`🎉 Safe deployed @ ${safeAddr}`)

    // verify on-chain proxy bytecode
    if (proxyBytecode)
      try {
        const code = await publicClient.getCode({ address: safeAddr })
        if (code === proxyBytecode) consola.success('✔ Proxy bytecode verified')
        else {
          consola.error('❌ Proxy bytecode mismatch')
          consola.debug('On-chain:', code.slice(0, 100), '…')
          consola.debug('Expected:', proxyBytecode.slice(0, 100), '…')
          throw new Error('Proxy bytecode verification failed')
        }
      } catch (error) {
        consola.error('❌ Failed to verify proxy bytecode:', error)
        throw error
      }

    return safeAddr
  } catch (error) {
    consola.error('❌ Failed to create Safe proxy:', error)
    throw error
  }
}
