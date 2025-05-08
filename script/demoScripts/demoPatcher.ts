import {
  parseAbi,
  encodeFunctionData,
  formatUnits,
  parseUnits,
  zeroAddress,
  getCreate2Address,
  keccak256,
  concat,
  encodeAbiParameters,
  parseAbiParameters,
  TypedDataEncoder,
  SignTypedDataParameters,
  hashTypedData,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arbitrum } from 'viem/chains'
import { createPublicClient, createWalletClient, http } from 'viem'
import {
  SupportedChainId,
  OrderKind,
  TradingSdk,
  SwapAdvancedSettings,
  TradeParameters,
  TraderParameters,
} from '@cowprotocol/cow-sdk'
import { getEnvVar } from './utils/demoScriptHelpers'
import deploymentsArbitrum from '../../deployments/arbitrum.staging.json'

// Import necessary types and utilities
import {
  logKeyValue,
  logSectionHeader,
  logSuccess,
} from '../../dump/src/lib/utils/logging'
import { truncateCalldata } from '../../dump/src/lib/utils/formatting'
import { left, Result, right } from '../../dump/src/lib/result'

// Define CoW Protocol constants
const COW_SHED_FACTORY = '0x00E989b87700514118Fa55326CD1cCE82faebEF6'
const COW_SHED_IMPLEMENTATION = '0x2CFFA8cf11B90C9F437567b86352169dF4009F73'

// Define interfaces and types
interface Token {
  readonly address: string
  readonly decimals: number
}

interface ICall {
  target: string
  callData: string
  value: bigint
  allowFailure: boolean
  isDelegateCall: boolean
}

interface PatchOperation {
  valueSource: string
  valueGetter: string
  valueToReplace: string | number | bigint
}

type TransactionIntent =
  | {
      readonly type: 'regular'
      readonly targetAddress: string
      readonly callData: string
      readonly nativeValue?: bigint
      readonly allowFailure?: boolean
      readonly isDelegateCall?: boolean
    }
  | {
      readonly type: 'dynamicValue'
      readonly patcherAddress: string
      readonly valueSource: string
      readonly valueGetter: string
      readonly targetAddress: string
      readonly callDataToPatch: string
      readonly valueToReplace: string | number | bigint
      readonly nativeValue?: bigint
      readonly delegateCall?: boolean
    }
  | {
      readonly type: 'multiPatch'
      readonly patcherAddress: string
      readonly targetAddress: string
      readonly callDataToPatch: string
      readonly patchOperations: readonly PatchOperation[]
      readonly nativeValue?: bigint
      readonly delegateCall?: boolean
    }

// ABIs
const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const DUMMY_TARGET_ABI = parseAbi([
  'function deposit(address token, uint256 amount, bool flag) returns (bool)',
  'function multiDeposit(address token, uint256 amount1, uint256 amount2, bool flag) returns (bool)',
  'function getDoubledBalance(address token, address account) view returns (uint256)',
])

const PATCHER_ABI = parseAbi([
  'function dynamicValuePatch(address valueSource, bytes valueGetter, address targetAddress, bytes callDataToPatch, bytes32 valueToReplace, uint256 offset, bool delegateCall) payable returns (bytes memory)',
  'function multiPatch(address targetAddress, bytes callDataToPatch, (address valueSource, bytes valueGetter, bytes32 valueToReplace, uint256 offset)[] patchOperations, bool delegateCall) payable returns (bytes memory)',
])

// CoW Protocol constants and ABIs
console.log('COW_SHED_FACTORY:', COW_SHED_FACTORY)
console.log('COW_SHED_IMPLEMENTATION:', COW_SHED_IMPLEMENTATION)
const PROXY_CREATION_CODE =
  '0x60a034608e57601f61037138819003918201601f19168301916001600160401b038311848410176093578084926040948552833981010312608e57604b602060458360a9565b920160a9565b6080527f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc556040516102b490816100bd8239608051818181608f01526101720152f35b600080fd5b634e487b7160e01b600052604160045260246000fd5b51906001600160a01b0382168203608e5756fe60806040526004361015610018575b3661019457610194565b6000803560e01c908163025b22bc1461003b575063f851a4400361000e5761010d565b3461010a5760207ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc36011261010a5773ffffffffffffffffffffffffffffffffffffffff60043581811691828203610106577f0000000000000000000000000000000000000000000000000000000000000000163314600014610101577f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc557fbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b8280a280f35b61023d565b8380fd5b80fd5b346101645760007ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc360112610164576020610146610169565b73ffffffffffffffffffffffffffffffffffffffff60405191168152f35b600080fd5b333003610101577f000000000000000000000000000000000000000000000000000000000000000090565b60ff7f68df44b1011761f481358c0f49a711192727fb02c377d697bcb0ea8ff8393ac0541615806101ef575b1561023d5760046040517ff92ee8a9000000000000000000000000000000000000000000000000000000008152fd5b507f400ada75000000000000000000000000000000000000000000000000000000007fffffffff000000000000000000000000000000000000000000000000000000006000351614156101c0565b7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc546000808092368280378136915af43d82803e1561027a573d90f35b3d90fdfea2646970667358221220c7c26ff3040b96a28e96d6d27b743972943aeaef81cc821544c5fe1e24f9b17264736f6c63430008190033'

const FACTORY_ABI = parseAbi([
  'function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, address user, bytes signature) external',
])

const SHED_ABI = parseAbi([
  'function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, bytes signature) external',
])

// Helper functions
const encodeBalanceOfCall = (account: string): string => {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account],
  })
}

const encodeTransferCall = (to: string, amount: string): string => {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [to, BigInt(amount)],
  })
}

const encodeGetDoubledBalanceCall = (
  token: string,
  account: string
): string => {
  return encodeFunctionData({
    abi: DUMMY_TARGET_ABI,
    functionName: 'getDoubledBalance',
    args: [token, account],
  })
}

// Process transaction intent
const processTransactionIntent = (
  intent: TransactionIntent,
  verbose: boolean
): Result<Error, ICall> => {
  switch (intent.type) {
    case 'regular': {
      const call: ICall = {
        target: intent.targetAddress,
        callData: intent.callData,
        value: intent.nativeValue ?? BigInt(0),
        allowFailure: intent.allowFailure ?? false,
        isDelegateCall: intent.isDelegateCall ?? false,
      }

      if (verbose) {
        logKeyValue('Call data', truncateCalldata(intent.callData, 10))
        logSuccess('Regular call created')
      }

      return right(call)
    }

    case 'dynamicValue': {
      try {
        if (!intent.patcherAddress || intent.patcherAddress === zeroAddress) {
          return left(new Error('patcherAddress must be provided'))
        }

        if (verbose) {
          logSectionHeader(`Creating dynamic value patch call`)
          logKeyValue('Call', truncateCalldata(intent.callDataToPatch, 10))
          logKeyValue('Value Source', intent.valueSource)
          logKeyValue('Value Getter', truncateCalldata(intent.valueGetter, 10))
          logKeyValue('Target', intent.targetAddress)
          logKeyValue('Value to replace', intent.valueToReplace.toString())
          logKeyValue(
            'Native Value',
            (intent.nativeValue || BigInt(0)).toString()
          )
        }

        // Create dynamic patch call
        const callData = encodeFunctionData({
          abi: PATCHER_ABI,
          functionName: 'dynamicValuePatch',
          args: [
            intent.valueSource,
            intent.valueGetter,
            intent.targetAddress,
            intent.callDataToPatch,
            `0x${intent.valueToReplace
              .toString()
              .padStart(64, '0')}` as `0x${string}`,
            BigInt(0), // offset
            intent.delegateCall ?? false,
          ],
        })

        const call: ICall = {
          target: intent.patcherAddress,
          callData,
          value: intent.nativeValue ?? BigInt(0),
          allowFailure: false,
          isDelegateCall: false,
        }

        if (verbose) {
          logSuccess('Dynamic value patch call created')
        }

        return right(call)
      } catch (error) {
        return left(
          new Error(`Failed to create dynamic value patch: ${error.message}`)
        )
      }
    }

    case 'multiPatch': {
      try {
        if (verbose) {
          logSectionHeader(
            `Creating multi-patch call with ${intent.patchOperations.length} operations`
          )
          logKeyValue(
            'Call data to patch',
            truncateCalldata(intent.callDataToPatch, 10)
          )
          logKeyValue('Target', intent.targetAddress)
        }

        // Format patch operations for the contract call
        const patchOperations = intent.patchOperations.map((op) => {
          return {
            valueSource: op.valueSource,
            valueGetter: op.valueGetter,
            valueToReplace: `0x${op.valueToReplace
              .toString()
              .padStart(64, '0')}` as `0x${string}`,
            offset: BigInt(0),
          }
        })

        // Create multi-patch call
        const callData = encodeFunctionData({
          abi: PATCHER_ABI,
          functionName: 'multiPatch',
          args: [
            intent.targetAddress,
            intent.callDataToPatch,
            patchOperations,
            intent.delegateCall ?? false,
          ],
        })

        const call: ICall = {
          target: intent.patcherAddress,
          callData,
          value: intent.nativeValue ?? BigInt(0),
          allowFailure: false,
          isDelegateCall: false,
        }

        if (verbose) {
          logSuccess('Multi-patch call created')
        }

        return right(call)
      } catch (error) {
        return left(new Error(`Failed to create multi-patch: ${error.message}`))
      }
    }
  }
}

// CoW Shed SDK implementation with Viem
class CowShedSdk {
  private factoryAddress: string
  private implementationAddress: string
  private proxyCreationCode: string
  private chainId: number

  constructor(options: {
    factoryAddress: string
    implementationAddress: string
    proxyCreationCode?: string
    chainId: number
  }) {
    this.factoryAddress = options.factoryAddress
    this.implementationAddress = options.implementationAddress
    this.proxyCreationCode = options.proxyCreationCode || PROXY_CREATION_CODE
    this.chainId = options.chainId
  }

  computeProxyAddress(user: string): string {
    console.log('Computing proxy address for user:', user)

    if (!user || user === 'undefined' || !user.startsWith('0x')) {
      throw new Error(`Invalid user address: ${user}`)
    }

    // Ensure addresses are properly formatted
    if (!this.factoryAddress || !this.factoryAddress.startsWith('0x')) {
      throw new Error(`Invalid factory address: ${this.factoryAddress}`)
    }

    if (
      !this.implementationAddress ||
      !this.implementationAddress.startsWith('0x')
    ) {
      throw new Error(
        `Invalid implementation address: ${this.implementationAddress}`
      )
    }

    const factoryAddress = this.factoryAddress as `0x${string}`
    const implementationAddress = this.implementationAddress as `0x${string}`
    const userAddress = user as `0x${string}`

    console.log('Using addresses:', {
      factoryAddress,
      implementationAddress,
      userAddress,
    })

    try {
      const salt = encodeAbiParameters(parseAbiParameters('address'), [
        userAddress,
      ])
      console.log('Salt:', salt)

      const initCode = concat([
        this.proxyCreationCode as `0x${string}`,
        encodeAbiParameters(parseAbiParameters('address, address'), [
          implementationAddress,
          userAddress,
        ]),
      ])
      console.log(
        'InitCode (first 66 chars):',
        initCode.substring(0, 66) + '...'
      )

      const initCodeHash = keccak256(initCode)
      console.log('InitCodeHash:', initCodeHash)

      // Log each parameter individually to identify which one might be undefined
      console.log('getCreate2Address parameters:', {
        factoryAddress: factoryAddress,
        factoryAddressType: typeof factoryAddress,
        salt: salt,
        saltType: typeof salt,
        bytecodeHash: initCodeHash,
        bytecodeHashType: typeof initCodeHash,
      })

      // Validate each parameter
      if (!factoryAddress || factoryAddress === 'undefined') {
        throw new Error('factoryAddress is undefined')
      }
      if (!salt || salt === 'undefined') {
        throw new Error('salt is undefined')
      }
      if (!initCodeHash || initCodeHash === 'undefined') {
        throw new Error('initCodeHash is undefined')
      }

      // Ensure all parameters are properly formatted as hex strings
      const formattedFactoryAddress = factoryAddress.startsWith('0x')
        ? factoryAddress
        : (`0x${factoryAddress}` as `0x${string}`)
      const formattedSalt = salt.startsWith('0x')
        ? salt
        : (`0x${salt}` as `0x${string}`)
      const formattedInitCodeHash = initCodeHash.startsWith('0x')
        ? initCodeHash
        : (`0x${initCodeHash}` as `0x${string}`)

      const proxyAddress = getCreate2Address({
        factoryAddress: formattedFactoryAddress,
        salt: formattedSalt,
        bytecodeHash: formattedInitCodeHash,
      })

      console.log('Computed proxy address:', proxyAddress)
      return proxyAddress
    } catch (error) {
      console.error('Error in computeProxyAddress:', error)
      throw error // Re-throw the error to propagate it
    }
  }

  hashToSignWithUser(
    calls: readonly ICall[],
    nonce: `0x${string}`,
    deadline: bigint,
    user: string
  ): `0x${string}` {
    const proxy = this.computeProxyAddress(user)
    return this.hashToSign(calls, nonce, deadline, proxy)
  }

  private hashToSign(
    calls: readonly ICall[],
    nonce: `0x${string}`,
    deadline: bigint,
    proxy: string
  ): `0x${string}` {
    const domain = {
      name: 'COWShed',
      version: '1.0.0',
      chainId: this.chainId,
      verifyingContract: proxy as `0x${string}`,
    }

    const types = {
      ExecuteHooks: [
        { name: 'calls', type: 'Call[]' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'deadline', type: 'uint256' },
      ],
      Call: [
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'callData', type: 'bytes' },
        { name: 'allowFailure', type: 'bool' },
        { name: 'isDelegateCall', type: 'bool' },
      ],
    }

    const message = {
      calls: calls.map((call) => ({
        target: call.target as `0x${string}`,
        value: call.value,
        callData: call.callData as `0x${string}`,
        allowFailure: call.allowFailure,
        isDelegateCall: call.isDelegateCall,
      })),
      nonce,
      deadline,
    }

    return hashTypedData({
      domain,
      types,
      primaryType: 'ExecuteHooks',
      message,
    })
  }

  static encodeExecuteHooksForFactory(
    calls: readonly ICall[],
    nonce: `0x${string}`,
    deadline: bigint,
    user: string,
    signature: `0x${string}`
  ): string {
    return encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'executeHooks',
      args: [
        calls.map((call) => ({
          target: call.target as `0x${string}`,
          value: call.value,
          callData: call.callData as `0x${string}`,
          allowFailure: call.allowFailure,
          isDelegateCall: call.isDelegateCall,
        })),
        nonce,
        deadline,
        user as `0x${string}`,
        signature,
      ],
    })
  }
}

// Real implementation of CoW Protocol functions
const calculateCowShedProxyAddress = async (
  chainId: number,
  owner: string
): Promise<string> => {
  console.log('calculateCowShedProxyAddress called with:', { chainId, owner })

  if (!owner || owner === 'undefined') {
    throw new Error('Owner address is undefined or empty')
  }

  console.log('Using COW_SHED_FACTORY:', COW_SHED_FACTORY)
  console.log('Using COW_SHED_IMPLEMENTATION:', COW_SHED_IMPLEMENTATION)

  // Validate inputs before creating the SDK
  if (
    !COW_SHED_FACTORY ||
    COW_SHED_FACTORY === 'undefined' ||
    COW_SHED_FACTORY === zeroAddress
  ) {
    throw new Error('COW_SHED_FACTORY is undefined or invalid')
  }

  if (
    !COW_SHED_IMPLEMENTATION ||
    COW_SHED_IMPLEMENTATION === 'undefined' ||
    COW_SHED_IMPLEMENTATION === zeroAddress
  ) {
    throw new Error('COW_SHED_IMPLEMENTATION is undefined or invalid')
  }

  const shedSDK = new CowShedSdk({
    factoryAddress: COW_SHED_FACTORY,
    implementationAddress: COW_SHED_IMPLEMENTATION,
    chainId,
  })

  const proxyAddress = shedSDK.computeProxyAddress(owner)
  console.log('Computed proxy address:', proxyAddress)

  return proxyAddress
}

const setupCowShedPostHooks = async (
  chainId: number,
  walletClient: any,
  calls: ICall[],
  verbose: boolean
): Promise<{ shedDeterministicAddress: string; postHooks: any[] }> => {
  const account = walletClient.account
  const signerAddress = account.address

  console.log('Using COW_SHED_FACTORY:', COW_SHED_FACTORY)
  console.log('Using COW_SHED_IMPLEMENTATION:', COW_SHED_IMPLEMENTATION)

  const shedSDK = new CowShedSdk({
    factoryAddress: COW_SHED_FACTORY,
    implementationAddress: COW_SHED_IMPLEMENTATION,
    chainId,
  })

  // Generate nonce and deadline for CoW Shed
  const nonce = `0x${Array.from({ length: 64 }, () =>
    Math.floor(Math.random() * 16).toString(16)
  ).join('')}` as `0x${string}`
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200) // now + 2 hours
  const shedDeterministicAddress = shedSDK.computeProxyAddress(signerAddress)

  // Sign the post hooks
  const hashToSign = shedSDK.hashToSignWithUser(
    calls,
    nonce,
    deadline,
    signerAddress
  )

  // Sign with the wallet
  const signature = await walletClient.signMessage({
    account,
    message: { raw: hashToSign },
  })

  // Encode the post hooks call data
  const shedEncodedPostHooksCallData = CowShedSdk.encodeExecuteHooksForFactory(
    calls,
    nonce,
    deadline,
    signerAddress,
    signature
  )

  // Create the post hooks
  const postHooks = [
    {
      target: COW_SHED_FACTORY,
      callData: shedEncodedPostHooksCallData,
      gasLimit: '2000000',
    },
  ]

  // Log information if verbose is true
  if (verbose) {
    logKeyValue('CoW-Shed deterministic address', shedDeterministicAddress)
    logSuccess('Post hook ready for execution through CoW Protocol')
    logKeyValue(
      'CoW-Shed encoded post-hook',
      truncateCalldata(shedEncodedPostHooksCallData, 25)
    )
  }

  return {
    shedDeterministicAddress,
    postHooks,
  }
}

const cowFlow = async (
  chainId: number,
  walletClient: any,
  fromToken: Token,
  toToken: Token,
  fromAmount: bigint,
  postReceiver: string,
  preHooks: readonly any[],
  postHooks: readonly any[]
): Promise<Result<Error, string>> => {
  try {
    // Create trader parameters with a signer adapter for Viem wallet
    const traderParams: TraderParameters = {
      chainId,
      signer: {
        signMessage: async (message: string) => {
          return walletClient.signMessage({
            account: walletClient.account,
            message: { raw: message as `0x${string}` },
          })
        },
        getAddress: async () => walletClient.account.address,
      },
      appCode: 'LI.FI Patcher Demo',
    }

    // Create trade parameters
    const params: TradeParameters = {
      kind: OrderKind.SELL, // SELL order (specify amount in)
      sellToken: fromToken.address,
      sellTokenDecimals: fromToken.decimals,
      buyToken: toToken.address,
      buyTokenDecimals: toToken.decimals,
      amount: fromAmount.toString(),
      receiver: postReceiver,
    }

    // Create advanced settings with hooks
    const advancedSettings: SwapAdvancedSettings = {
      appData: {
        metadata: {
          hooks: {
            version: '1',
            pre: [...preHooks],
            post: [...postHooks],
          },
        },
      },
    }

    // Initialize the SDK and post the order
    const sdk = new TradingSdk(traderParams)
    const hash = await sdk.postSwapOrder(params, advancedSettings)

    return right(hash)
  } catch (error) {
    return left(new Error(`Failed to execute CoW flow: ${error.message}`))
  }
}

// Main demo function
const demoPatcher = async (): Promise<Result<Error, string>> => {
  try {
    logSectionHeader('Running Patcher Example with Post-Swap Flow')

    // Setup environment
    console.log('Setting up environment...')

    // Get private key and ensure it has the correct format
    const privateKeyRaw = process.env.PRIVATE_KEY
    if (!privateKeyRaw) {
      throw new Error('PRIVATE_KEY environment variable is not set')
    }

    // Ensure the private key has the correct format (0x prefix)
    const privateKey = privateKeyRaw.startsWith('0x')
      ? (privateKeyRaw as `0x${string}`)
      : (`0x${privateKeyRaw}` as `0x${string}`)

    console.log('Creating account...')
    const account = privateKeyToAccount(privateKey)
    console.log('Account address:', account.address)

    console.log('Creating clients...')
    const rpcUrl = process.env.ETH_NODE_URI_ARBITRUM
    if (!rpcUrl) {
      throw new Error('ETH_NODE_URI_ARBITRUM environment variable is not set')
    }

    const publicClient = createPublicClient({
      chain: arbitrum,
      transport: http(rpcUrl),
    })

    const walletClient = createWalletClient({
      chain: arbitrum,
      transport: http(rpcUrl),
      account,
    })

    console.log('Getting contract addresses...')
    // Get the Patcher address from deployments
    const patcherAddress = deploymentsArbitrum.Patcher
    if (
      !patcherAddress ||
      patcherAddress === '0x0000000000000000000000000000000000000000'
    ) {
      throw new Error(
        'Patcher address not found in deployments or is zero address'
      )
    }
    console.log('Patcher address:', patcherAddress)

    // Use a mock address for the dummy target
    const dummyTargetAddress = '0x0000000000000000000000000000000000000001'

    const baseValuePlaceholder = '1000000000000000000'
    const doubledValuePlaceholder = '2000000000000000000'

    const originalTokenOwner = account.address
    // Use the correct Arbitrum chain ID
    const chainId = 42161

    // Define token information
    console.log('Setting up token information...')
    const fromToken = {
      address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', // WETH on Arbitrum
      decimals: 18,
    }

    const toToken = {
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC on Arbitrum
      decimals: 6,
    }

    // Calculate CoW Shed proxy address
    console.log('Calculating CoW Shed proxy address...')
    const shedProxyAddress = await calculateCowShedProxyAddress(
      chainId,
      originalTokenOwner
    )
    console.log('Shed proxy address:', shedProxyAddress)

    // Define transaction intents
    console.log('Defining transaction intents...')
    const transactionIntents: readonly TransactionIntent[] = [
      {
        type: 'dynamicValue',
        patcherAddress: patcherAddress,
        valueSource: toToken.address,
        valueGetter: encodeBalanceOfCall(shedProxyAddress),
        targetAddress: dummyTargetAddress,
        callDataToPatch: encodeFunctionData({
          abi: DUMMY_TARGET_ABI,
          functionName: 'deposit',
          args: [toToken.address, BigInt(baseValuePlaceholder), true],
        }),
        valueToReplace: baseValuePlaceholder,
        nativeValue: BigInt(0),
      },
      {
        type: 'multiPatch',
        patcherAddress: patcherAddress,
        targetAddress: dummyTargetAddress,
        callDataToPatch: encodeFunctionData({
          abi: DUMMY_TARGET_ABI,
          functionName: 'multiDeposit',
          args: [
            toToken.address,
            BigInt(baseValuePlaceholder),
            BigInt(doubledValuePlaceholder),
            true,
          ],
        }),
        patchOperations: [
          {
            valueSource: toToken.address,
            valueGetter: encodeBalanceOfCall(shedProxyAddress),
            valueToReplace: baseValuePlaceholder,
          },
          {
            valueSource: dummyTargetAddress,
            valueGetter: encodeGetDoubledBalanceCall(
              toToken.address,
              shedProxyAddress
            ),
            valueToReplace: doubledValuePlaceholder,
          },
        ],
        nativeValue: BigInt(0),
      },
      {
        type: 'dynamicValue',
        patcherAddress: patcherAddress,
        valueSource: toToken.address,
        valueGetter: encodeBalanceOfCall(shedProxyAddress),
        targetAddress: toToken.address,
        callDataToPatch: encodeTransferCall(
          originalTokenOwner,
          baseValuePlaceholder
        ),
        valueToReplace: baseValuePlaceholder,
        nativeValue: BigInt(0),
      },
    ]

    logKeyValue('Patcher Address', patcherAddress)
    logKeyValue('From Token', fromToken.address)
    logKeyValue('To Token', toToken.address)

    // Process transaction intents
    console.log('Processing transaction intents...')
    const processedIntents = transactionIntents.map((intent, index) => {
      logSectionHeader(`Processing intent ${index + 1} (type: ${intent.type})`)
      return processTransactionIntent(intent, true)
    })

    // Check for any errors in the processed intents
    console.log('Checking for errors in processed intents...')
    const errorResult = processedIntents.find(
      (result) => result._type === 'Left'
    )
    if (errorResult && errorResult._type === 'Left') {
      return errorResult
    }

    // Extract the successful calls
    console.log('Extracting successful calls...')
    const calls = processedIntents
      .filter(
        (result): result is { readonly _type: 'Right'; readonly data: ICall } =>
          result._type === 'Right'
      )
      .map((result) => result.data)

    // Setup post hooks for CoW Shed
    console.log('Setting up post hooks for CoW Shed...')
    const setupResult = await setupCowShedPostHooks(
      chainId,
      walletClient,
      calls,
      true
    )

    const { shedDeterministicAddress, postHooks } = setupResult

    // Amount to swap (for example, 0.1 token)
    console.log('Calculating swap amount...')
    const fromAmount = parseUnits('0.1', fromToken.decimals)

    logSectionHeader('Creating CoW Swap Order')
    logKeyValue('From Token', fromToken.address)
    logKeyValue('To Token', toToken.address)
    logKeyValue('Amount', fromAmount.toString())
    logKeyValue('Token Receiver', shedProxyAddress)
    logKeyValue('Post-hook receiver', shedDeterministicAddress)

    // Execute the CoW Protocol flow
    console.log('Executing CoW Protocol flow...')
    const cowHashResult = await cowFlow(
      chainId,
      walletClient,
      fromToken,
      toToken,
      fromAmount,
      shedProxyAddress,
      [],
      [...postHooks]
    )

    if (cowHashResult._type === 'Left') {
      return cowHashResult
    }

    const orderHash = cowHashResult.data

    logSectionHeader('CoW Swap Order Created')
    logSuccess('Order submitted successfully')
    logKeyValue('Order hash', orderHash)
    logKeyValue(
      'Explorer URL',
      `https://explorer.cow.fi/orders/${orderHash}?chainId=${chainId}`
    )

    return right(
      `Patcher integrated with CoW Protocol - Order created with hash: ${orderHash}`
    )
  } catch (error) {
    console.error('Error in demoPatcher:', error)
    return left(
      new Error(
        `Failed to execute patcher demo: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    )
  }
}

async function main() {
  try {
    const result = await demoPatcher()
    if (result && result._type === 'Left') {
      console.error(
        `Error: ${result.error ? result.error.message : 'Unknown error'}`
      )
      process.exit(1)
    } else if (result && result._type === 'Right') {
      console.log(result.data)
      process.exit(0)
    } else {
      console.error('Unexpected result format')
      process.exit(1)
    }
  } catch (error) {
    console.error('Unexpected error:', error)
    process.exit(1)
  }
}

// Run the script
main()
