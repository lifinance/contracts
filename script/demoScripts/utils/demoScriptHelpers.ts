import { privateKeyToAccount } from 'viem/accounts'
import path from 'path'
import { fileURLToPath } from 'url'
import { providers, Wallet, BigNumber, constants, Contract } from 'ethers'
import { node_url } from '../../utils/network'
import { addressToBytes32 as addressToBytes32Lz } from '@layerzerolabs/lz-v2-utilities'
import { ERC20__factory } from '../../../typechain'
import { LibSwap } from '../../../typechain/AcrossFacetV3'
import {
  Narrow,
  createPublicClient,
  createWalletClient,
  getContract,
  http,
  parseAbi,
  formatEther,
  formatUnits,
  zeroAddress,
} from 'viem'
import networks from '../../../config/networks.json'
import { Environment } from '../../utils/viemScriptHelpers'
import { SupportedChain } from './demoScriptChainConfig'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'
import { config } from 'dotenv'

config()

export const DEV_WALLET_ADDRESS = '0xb9c0dE368BECE5e76B52545a8E377a4C118f597B'

export const DEFAULT_DEST_PAYLOAD_ABI = [
  'bytes32', // Transaction Id
  'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[]', // Swap Data
  'address', // Receiver
]

export enum TX_TYPE {
  ERC20,
  NATIVE,
  ERC20_WITH_SRC,
  NATIVE_WITH_SRC,
  ERC20_WITH_DEST,
  NATIVE_WITH_DEST,
}

export const isNativeTX = (type: TX_TYPE): boolean => {
  return (
    type === TX_TYPE.NATIVE ||
    type === TX_TYPE.NATIVE_WITH_DEST ||
    type === TX_TYPE.NATIVE_WITH_SRC
  )
}

// Common token addresses on mainnet
export const ADDRESS_USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const ADDRESS_USDT_ETH = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
export const ADDRESS_USDC_POL = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
export const ADDRESS_USDT_POL = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
export const ADDRESS_USDC_OPT = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
export const ADDRESS_USDT_OPT = '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58'
export const ADDRESS_USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
export const ADDRESS_USDT_ARB = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'
export const ADDRESS_USDCe_OPT = '0x7F5c764cBc14f9669B88837ca1490cCa17c31607'
export const ADDRESS_WETH_ETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
export const ADDRESS_WETH_OPT = '0x4200000000000000000000000000000000000006'
export const ADDRESS_WETH_POL = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'
export const ADDRESS_WETH_ARB = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
export const ADDRESS_WMATIC_POL = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270 '

export const ADDRESS_UNISWAP_ETH = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
export const ADDRESS_UNISWAP_BSC = '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24'
export const ADDRESS_UNISWAP_POL = '0xedf6066a2b290C185783862C7F4776A2C8077AD1'
export const ADDRESS_UNISWAP_OPT = '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2'
export const ADDRESS_UNISWAP_ARB = '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24'
// const UNISWAP_ADDRESS_DST = '0x4A7b5Da61326A6379179b40d00F57E5bbDC962c2' // Uniswap OPT

/// ############# HELPER FUNCTIONS ###################### ///

///
export const addressToBytes32 = (address: string) => {
  return addressToBytes32Lz(address)
}

export const getProvider = (
  networkName: string
): providers.FallbackProvider => {
  const rpcProviderSrc = new providers.JsonRpcProvider(node_url(networkName))
  return new providers.FallbackProvider([rpcProviderSrc])
}

export const getWalletFromPrivateKeyInDotEnv = (
  provider: providers.FallbackProvider
): Wallet => {
  return new Wallet(process.env.PRIVATE_KEY as string, provider)
}

export const sendTransaction = async (
  wallet: Wallet,
  to: string,
  data: string,
  msgValue = BigNumber.from(0)
) => {
  const gasPrice = await wallet.provider.getGasPrice()
  const maxPriorityFeePerGas = gasPrice.mul(2)
  const maxFeePerGas = gasPrice.mul(3)

  if (!maxPriorityFeePerGas || !maxFeePerGas)
    throw Error('error while estimating gas fees')

  const tx = {
    to,
    data,
    value: msgValue,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit: await wallet.estimateGas({ to, data, value: msgValue }),
  }
  // console.log(`tx: ${JSON.stringify(tx, null, 2)}`)

  const transactionResponse = await wallet.sendTransaction(tx)
  // console.log('transaction hash:', transactionResponse.hash)

  // Wait for the transaction to be mined
  await transactionResponse.wait()
  // console.log('transaction mined')

  return transactionResponse
}

// makes sure the sending wallet has sufficient balance and registers approval in the sending token from wallet to our diamond
export const ensureBalanceAndAllowanceToDiamond = async (
  tokenAddress: string,
  wallet: Wallet,
  diamondAddress: string,
  amount: BigNumber,
  isNative = false
) => {
  // check allowance only for ERC20
  const token = ERC20__factory.connect(tokenAddress, wallet)
  if (!isNative) {
    // get current allowance in srcToken
    const allowance = await token.allowance(wallet.address, diamondAddress)
    // console.log('current allowance: %s ', allowance)

    // set allowance
    if (amount.gt(allowance)) {
      const approveTxData = token.interface.encodeFunctionData('approve', [
        diamondAddress,
        amount,
      ])

      await sendTransaction(wallet, tokenAddress, approveTxData)
      console.log(`allowance set to: ${amount} `)
    }
  }

  // check if wallet has sufficient balance
  let balance
  if (isNative || tokenAddress == constants.AddressZero)
    balance = await wallet.getBalance()
  else balance = await token.balanceOf(wallet.address)
  if (amount.gt(balance))
    throw Error(
      `Wallet has insufficient balance (should have ${amount} but only has ${balance})`
    )
  console.log(
    `Current wallet balance in sendingAsset is sufficient: ${balance}`
  )
}

export const getUniswapSwapDataERC20ToERC20 = async (
  uniswapAddress: string,
  chainId: number,
  sendingAssetId: string,
  receivingAssetId: string,
  fromAmount: BigNumber,
  receiverAddress: string,
  requiresDeposit = true,
  minAmountOut = 0,
  deadline = Math.floor(Date.now() / 1000) + 60 * 60
) => {
  // prepare destSwap callData
  const uniswap = new Contract(uniswapAddress, [
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  ])
  const path = [sendingAssetId, receivingAssetId]

  // get minAmountOut from Uniswap router
  console.log(`finalFromAmount  : ${fromAmount}`)

  let finalMinAmountOut: BigNumber
  if (minAmountOut.toString() !== '0') {
    finalMinAmountOut = minAmountOut
  } else {
    const amountsOut = await getAmountsOutUniswap(
      uniswapAddress,
      chainId,
      [sendingAssetId, receivingAssetId],
      fromAmount
    )
    // Use the second element (index 1) as the estimated output
    finalMinAmountOut = BigNumber.from(amountsOut[1]).mul(99).div(100)
  }
  console.log(`finalMinAmountOut: ${finalMinAmountOut}`)

  const uniswapCalldata = (
    await uniswap.populateTransaction.swapExactTokensForTokens(
      fromAmount, // amountIn
      finalMinAmountOut,
      path,
      receiverAddress,
      deadline
    )
  ).data

  if (!uniswapCalldata) throw Error('Could not create Uniswap calldata')

  // construct LibSwap.SwapData
  const swapData: LibSwap.SwapDataStruct = {
    callTo: uniswapAddress,
    approveTo: uniswapAddress,
    sendingAssetId,
    receivingAssetId,
    fromAmount,
    callData: uniswapCalldata,
    requiresDeposit,
  }

  return swapData
}

export const getUniswapDataERC20toExactETH = async (
  uniswapAddress: string,
  chainId: number,
  sendingAssetId: string, // USDT
  exactAmountOut: BigNumber, // Desired ETH output
  receiverAddress: string,
  requiresDeposit = true,
  deadline = Math.floor(Date.now() / 1000) + 60 * 60
) => {
  // Get provider for the chain
  const provider = getProviderForChainId(chainId)

  const uniswap = new Contract(
    uniswapAddress,
    [
      'function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)',
      'function swapTokensForExactETH(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    ],
    provider // Connect the contract to the provider
  )

  const path = [sendingAssetId, ADDRESS_WETH_OPT]

  try {
    // Get the required USDT input amount for the exact ETH output
    const amounts = await uniswap.getAmountsIn(exactAmountOut, path)
    const requiredUsdtAmount = amounts[0]
    const maxAmountIn = BigNumber.from(requiredUsdtAmount).mul(105).div(100) // 5% max slippage

    console.log('Required USDT input:', requiredUsdtAmount.toString())
    console.log('Max USDT input with slippage:', maxAmountIn.toString())
    console.log('Exact ETH output:', exactAmountOut.toString())

    const uniswapCalldata = (
      await uniswap.populateTransaction.swapTokensForExactETH(
        exactAmountOut,
        maxAmountIn,
        path,
        receiverAddress,
        deadline
      )
    ).data

    if (!uniswapCalldata) throw Error('Could not create Uniswap calldata')

    return {
      callTo: uniswapAddress,
      approveTo: uniswapAddress,
      sendingAssetId, // USDT address
      receivingAssetId: constants.AddressZero, // ETH (zero address)
      fromAmount: maxAmountIn, // Required USDT amount with slippage
      callData: uniswapCalldata,
      requiresDeposit,
    }
  } catch (error) {
    console.error('Error in Uniswap contract interaction:', error)
    throw error
  }
}

export const getUniswapDataERC20toExactERC20 = async (
  uniswapAddress: string,
  chainId: number,
  sendingAssetId: string,
  receivingAssetId: string,
  exactAmountOut: BigNumber,
  receiverAddress: string,
  requiresDeposit = true,
  deadline = Math.floor(Date.now() / 1000) + 60 * 60
) => {
  // Get provider for the chain
  const provider = getProviderForChainId(chainId)

  const uniswap = new Contract(
    uniswapAddress,
    [
      'function getAmountsIn(uint amountOut, address[] calldata path) external view returns (uint[] memory amounts)',
      'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)',
    ],
    provider
  )

  const path = [sendingAssetId, receivingAssetId]

  try {
    // Get the required input amount for the exact output
    const amounts = await uniswap.getAmountsIn(exactAmountOut, path)
    const requiredInputAmount = amounts[0]
    const maxAmountIn = BigNumber.from(requiredInputAmount).mul(105).div(100) // 5% max slippage

    console.log('Required input amount:', requiredInputAmount.toString())
    console.log('Max input with slippage:', maxAmountIn.toString())
    console.log('Exact output amount:', exactAmountOut.toString())

    const uniswapCalldata = (
      await uniswap.populateTransaction.swapTokensForExactTokens(
        exactAmountOut,
        maxAmountIn,
        path,
        receiverAddress,
        deadline
      )
    ).data

    if (!uniswapCalldata) throw Error('Could not create Uniswap calldata')

    return {
      callTo: uniswapAddress,
      approveTo: uniswapAddress,
      sendingAssetId,
      receivingAssetId,
      fromAmount: maxAmountIn,
      callData: uniswapCalldata,
      requiresDeposit,
    }
  } catch (error) {
    console.error('Error in Uniswap contract interaction:', error)
    throw error
  }
}

export const getUniswapSwapDataERC20ToETH = async (
  uniswapAddress: string,
  chainId: number,
  sendingAssetId: string,
  receivingAssetId: string,
  fromAmount: BigNumber,
  receiverAddress: string,
  requiresDeposit = true,
  minAmountOut = 0,
  deadline = Math.floor(Date.now() / 1000) + 60 * 60
) => {
  // prepare destSwap callData
  const uniswap = new Contract(uniswapAddress, [
    'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  ])
  const path = [sendingAssetId, receivingAssetId]

  // get minAmountOut from Uniswap router
  console.log(`finalFromAmount  : ${fromAmount}`)

  const finalMinAmountOut =
    minAmountOut == 0
      ? await getAmountsOutUniswap(
          uniswapAddress,
          chainId,
          [sendingAssetId, receivingAssetId],
          fromAmount
        )
      : minAmountOut
  console.log(`finalMinAmountOut: ${finalMinAmountOut}`)

  const uniswapCalldata = (
    await uniswap.populateTransaction.swapExactTokensForETH(
      fromAmount, // amountIn
      finalMinAmountOut,
      path,
      receiverAddress,
      deadline
    )
  ).data

  if (!uniswapCalldata) throw Error('Could not create Uniswap calldata')

  // construct LibSwap.SwapData
  const swapData: LibSwap.SwapDataStruct = {
    callTo: uniswapAddress,
    approveTo: uniswapAddress,
    sendingAssetId,
    receivingAssetId: '0x0000000000000000000000000000000000000000',
    fromAmount,
    callData: uniswapCalldata,
    requiresDeposit,
  }

  return swapData
}

export const getAmountsOutUniswap = async (
  uniswapAddress: string,
  chainId: number,
  path: string[],
  fromAmount: BigNumber
): Promise<string[]> => {
  const provider = getProviderForChainId(chainId)
  console.log('Getting amounts out from Uniswap:')
  console.log('- Router:', uniswapAddress)
  console.log('- Chain ID:', chainId)
  console.log('- Path:', path)
  console.log('- From Amount:', fromAmount.toString())

  // prepare ABI
  const uniswapABI = parseAbi([
    'function getAmountsOut(uint256, address[]) public view returns(uint256[])',
  ])

  // get uniswap contract
  const uniswap = new Contract(uniswapAddress, uniswapABI, provider)

  try {
    // Call Uniswap contract to get amountsOut
    const amounts = await uniswap.callStatic.getAmountsOut(
      fromAmount.toString(),
      path
    )

    console.log(
      'Amounts returned:',
      amounts.map((a: any) => a.toString())
    )

    if (!amounts || amounts.length < 2) {
      throw new Error('Invalid amounts returned from Uniswap')
    }

    return amounts
  } catch (error) {
    console.error('Error calling Uniswap contract:', error)
    throw new Error(`Failed to get amounts out: ${error.message}`)
  }
}

export const getNetworkNameForChainId = (chainId: number): string => {
  const network = Object.entries(networks).find(
    ([, info]) => info.chainId === chainId
  )

  if (!network) throw Error(`Could not find a network with chainId ${chainId}`)

  return network[0]
}

const getProviderForChainId = (chainId: number) => {
  // get network name for chainId
  const networkName = getNetworkNameForChainId(chainId)

  // get provider for network name
  const provider = getProvider(networkName)
  if (!provider)
    throw Error(`Could not find a provider for network ${networkName}`)
  else return provider
}

/**
 * Convert an Ethereum address to a 32-byte hexadecimal string.
 * The address is stripped of its "0x" prefix and zero-padded to 64 characters.
 *
 */
export const zeroPadAddressToBytes32 = (address: string): `0x${string}` => {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error('Invalid Ethereum address format')
  }
  const hexAddress = address.replace(/^0x/, '')
  return `0x${hexAddress.padStart(64, '0')}`
}

/**
 * Converts an Ethereum address to a 32-byte hexadecimal string,
 * mimicking Solidity's `bytes32(bytes20(uint160(address)))` conversion.
 * The address is right-padded with zeros to fit into a 32-byte value.
 *
 * @param address - A valid Ethereum address (20 bytes).
 * @returns A 32-byte hexadecimal string representation of the address.
 */
export function addressToBytes32RightPadded(address: string): `0x${string}` {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new Error('Invalid Ethereum address format')
  }
  const hex = address.replace(/^0x/, '').toLowerCase()
  return `0x${hex.padEnd(64, '0')}`
}

/**
 * Retrieve the value of an environment variable.
 * Throws an error if the environment variable is not defined.
 */
export const getEnvVar = (varName: string): string => {
  const value = process.env[varName]
  if (!value) {
    throw new Error(`Missing required environment variable: ${varName}`)
  }
  return value
}

/**
 * Normalize a private key to ensure it starts with "0x".
 * If the private key already starts with "0x", it is returned unchanged.
 *
 */
const normalizePrivateKey = (pk: string): `0x${string}` => {
  // Private key should be 64 characters (32 bytes) excluding '0x'
  const cleanPk = pk.replace(/^0x/, '')
  if (!/^[a-fA-F0-9]{64}$/.test(cleanPk)) {
    throw new Error('Invalid private key format')
  }
  if (!pk.startsWith('0x')) {
    return `0x${pk}` as `0x${string}`
  }
  return pk as `0x${string}`
}

/**
 * Return the correct RPC environment variable
 * (e.g. `ETH_NODE_URI_ARBITRUM` or `ETH_NODE_URI_MAINNET`)
 */
const getRpcUrl = (chain: SupportedChain) => {
  const envKey = `ETH_NODE_URI_${chain.toUpperCase()}`
  return getEnvVar(envKey) as string
}

/**
 * Utility function to dynamically import the deployments file for a chain.
 */
export const getDeployments = async (
  chain: SupportedChain,
  environment: Environment = Environment.staging
) => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const fileName =
    environment === Environment.production
      ? `${chain}.json`
      : `${chain}.staging.json`
  const filePath = path.resolve(__dirname, `../../../deployments/${fileName}`)

  try {
    const deployments = await import(filePath)
    return deployments
  } catch (error) {
    throw new Error(
      `Deployments file not found for ${chain} (${environment}): ${filePath}`
    )
  }
}

/**
 * Sets up the environment for interacting with a blockchain network and its contracts.
 *
 * This function initializes public and wallet clients, retrieves deployment information,
 * and prepares a specific contract instance for interaction.
 */
export const setupEnvironment = async (
  chain: SupportedChain,
  facetAbi: Narrow<readonly any[]> | null,
  environment: Environment = Environment.staging,
  customRpcUrl?: string
) => {
  // Use customRpcUrl if provided, otherwise fallback to getRpcUrl
  const RPC_URL = customRpcUrl || getRpcUrl(chain)
  const PRIVATE_KEY = getPrivateKeyForEnvironment(environment)
  const typedPrivateKey = normalizePrivateKey(PRIVATE_KEY)

  const viemChain = getViemChainForNetworkName(chain)

  const publicClient = createPublicClient({
    chain: viemChain,
    transport: http(RPC_URL),
  })

  const walletAccount = privateKeyToAccount(typedPrivateKey)

  const walletClient = createWalletClient({
    chain: viemChain,
    transport: http(RPC_URL),
    account: walletAccount,
  })

  const deployments = facetAbi ? await getDeployments(chain, environment) : null

  const client = { public: publicClient, wallet: walletClient }

  const lifiDiamondAddress = deployments
    ? (deployments.LiFiDiamond as `0x${string}`)
    : null

  const lifiDiamondContract =
    facetAbi && lifiDiamondAddress
      ? getContract({
          address: lifiDiamondAddress,
          abi: facetAbi,
          client,
        })
      : null

  return {
    walletAccount,
    lifiDiamondContract,
    lifiDiamondAddress,
    publicClient,
    walletClient,
    client,
    chain: viemChain,
  }
}

/**
 * Retrieves a specific element from the configuration for a given blockchain chain.
 */
export const getConfigElement = (
  config: Record<string, any>,
  chain: SupportedChain,
  elementKey: string
) => {
  const chainConfig = config[chain]
  if (!chainConfig || !chainConfig[elementKey]) {
    throw new Error(
      `Element '${elementKey}' not found for chain '${chain}' in the config.`
    )
  }
  return chainConfig[elementKey]
}

/**
 * Executes a blockchain transaction, validates its receipt (optional), and handles errors.
 */
export const getUniswapDataExactETHToERC20 = async (
  uniswapAddress: string,
  chainId: number,
  exactETHAmount: bigint,
  receivingAssetId: string,
  receiverAddress: string,
  requiresDeposit = false,
  deadline = Math.floor(Date.now() / 1000) + 60 * 60
) => {
  const provider = getProviderForChainId(chainId)

  const uniswap = new Contract(
    uniswapAddress,
    [
      'function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)',
      'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    ],
    provider
  )

  const path = [ADDRESS_WETH_ETH, receivingAssetId]

  try {
    // Get the expected output amount for the exact ETH input
    const amounts = await uniswap.getAmountsOut(exactETHAmount, path)
    const expectedOutput = amounts[1]
    const minAmountOut = BigNumber.from(expectedOutput).mul(95).div(100) // 5% slippage tolerance

    console.log('Exact ETH input:', formatEther(exactETHAmount))
    console.log('Expected USDC output:', formatUnits(expectedOutput, 6))
    console.log('Min USDC output with slippage:', formatUnits(minAmountOut, 6))

    const uniswapCalldata = (
      await uniswap.populateTransaction.swapExactETHForTokens(
        minAmountOut,
        path,
        receiverAddress,
        deadline
      )
    ).data

    if (!uniswapCalldata) throw Error('Could not create Uniswap calldata')

    return {
      callTo: uniswapAddress,
      approveTo: uniswapAddress,
      sendingAssetId: zeroAddress, // ETH
      receivingAssetId,
      fromAmount: exactETHAmount,
      callData: uniswapCalldata,
      requiresDeposit,
    }
  } catch (error) {
    console.error('Error in Uniswap contract interaction:', error)
    throw error
  }
}

export const executeTransaction = async <T>(
  transaction: () => Promise<T>,
  transactionDescription: string,
  publicClient?: any,
  validateReceipt = false
): Promise<T | null> => {
  try {
    console.info(`Executing: ${transactionDescription}`)
    const result = await transaction()
    console.info(
      `${transactionDescription} broadcasted successfully with hash: ${result}`
    )

    if (validateReceipt && publicClient) {
      console.info(`Waiting for transaction receipt...`)
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: result as any,
      })
      if (receipt.status === 'success') {
        console.info(
          `${transactionDescription} completed successfully, included in a block.`
        )
      } else {
        console.error(
          `${transactionDescription} failed. Receipt failure:`,
          receipt
        )
        process.exit(1)
      }
    }

    return result
  } catch (error) {
    console.error(`${transactionDescription} failed:`, error)
    process.exit(1)
  }
}

/**
 * Ensures that the address wallet has the required token balance.
 */
export const ensureBalance = async (
  asset: any,
  walletAddress: string,
  requiredAmount: bigint,
  publicClient: any = null
): Promise<void> => {
  let balance: bigint

  if (asset === zeroAddress) {
    // Special case: asset represents the native token (e.g. ETH).
    // Retrieve the native balance using the public client.
    balance = await publicClient.getBalance({ address: walletAddress })
  } else {
    // Standard ERC20 balance check using the asset's balanceOf method.
    balance = (await asset.read.balanceOf([walletAddress])) as bigint
  }

  if (balance < requiredAmount) {
    console.error(
      `Insufficient balance. Required: ${requiredAmount}, Available: ${balance}`
    )
    process.exit(1)
  } else {
    console.info(`Balance: ${balance}`)
  }
}

/**
 * Ensures that the owner wallet has approved the required allowance for a spender.
 */
export const ensureAllowance = async (
  tokenContract: any,
  ownerAddress: string,
  spenderAddress: string,
  requiredAmount: bigint,
  publicClient: any
): Promise<void> => {
  const allowance: bigint = (await tokenContract.read.allowance([
    ownerAddress,
    spenderAddress,
  ])) as bigint

  if (allowance < requiredAmount) {
    console.info(`Required amount: ${requiredAmount}`)
    console.info(`Allowance is insufficient. Approving required amount...`)
    const hash = await tokenContract.write.approve([
      spenderAddress,
      requiredAmount,
    ])
    console.info(`Approval transaction broadcasted (hash): ${hash}`)

    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status === 'success') {
      console.info(
        'Token allowance approved successfully, included in a block.'
      )
    } else {
      console.error(
        'Approval transaction failed. Receipt indicates a failure:',
        receipt
      )
      process.exit(1)
    }
  } else {
    console.info('Sufficient allowance already exists.')
  }
}

export const getPrivateKeyForEnvironment = (
  environment: Environment
): string => {
  return environment === Environment.production
    ? getEnvVar('PRIVATE_KEY_PRODUCTION')
    : getEnvVar('PRIVATE_KEY')
}
