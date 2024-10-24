import { providers, Wallet, BigNumber, constants, Contract } from 'ethers'
import { node_url } from '../../utils/network'
import { addressToBytes32 as addressToBytes32Lz } from '@layerzerolabs/lz-v2-utilities'
import { ERC20__factory } from '../../../typechain'
import { LibSwap } from '../../../typechain/AcrossFacetV3'
import { parseAbi } from 'viem'
import networks from '../../../config/networks.json'

export const DEV_WALLET_ADDRESS = '0x29DaCdF7cCaDf4eE67c923b4C22255A4B2494eD7'

export const DEFAULT_DEST_PAYLOAD_ABI = [
  'bytes32', // Transaction Id
  'tuple(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)[]', // Swap Data
  'address', // Receiver
]

export enum TX_TYPE {
  ERC20,
  NATIVE,
  ERC20_WITH_DEST,
  NATIVE_WITH_DEST,
}

export const isNativeTX = (type: TX_TYPE): boolean => {
  return type === TX_TYPE.NATIVE || type === TX_TYPE.NATIVE_WITH_DEST
}

// Common token addresses on mainnet
export const ADDRESS_USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const ADDRESS_USDC_POL = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'
export const ADDRESS_USDC_OPT = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85'
export const ADDRESS_USDC_ARB = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
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

export const getAmountsOutUniswap = async (
  uniswapAddress: string,
  chainId: number,
  path: string[],
  fromAmount: BigNumber
): Promise<string[]> => {
  const provider = getProviderForChainId(chainId)

  // prepare ABI
  const uniswapABI = parseAbi([
    'function getAmountsOut(uint256, address[]) public returns(uint256[])',
  ])

  // get uniswap contract
  const uniswap = new Contract(uniswapAddress, uniswapABI, provider)

  // get amountsOut
  let amountsOut = undefined
  try {
    // Call Uniswap contract to get amountsOut
    const response = await uniswap.callStatic.getAmountsOut(
      fromAmount.toString(),
      path
    )

    // extract amountOut from second position in array
    amountsOut = response[1]
  } catch (error) {
    console.error(`Error reading contract: ${error}`)
  }

  if (!amountsOut)
    throw Error(
      `Could not get amountsOut from Uniswap for path (${path}) on chainId ${chainId}`
    )

  return amountsOut
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
