import { randomBytes } from 'crypto'

import dotenv from 'dotenv'
import {
  type Narrow,
  type PublicClient,
  getContract,
  parseUnits,
  encodeFunctionData,
  getAddress,
  parseAbi,
  formatUnits,
} from 'viem'

import lidoWrapperConfig from '../../config/lidowrapper.json'
import deploymentsOPT from '../../deployments/optimism.staging.json'
import diamondAbi from '../../diamond.json'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import lidoWrapperArtifact from '../../out/LidoWrapper.sol/LidoWrapper.json'
import type { LibSwap } from '../../typechain/GenericSwapFacetV3'
import type { SupportedChain } from '../common/types'

import {
  ensureBalance,
  ensureAllowance,
  executeTransaction,
  setupEnvironment,
  DEV_WALLET_ADDRESS,
  getConfigElement,
  parseAmountToHumanReadable,
} from './utils/demoScriptHelpers'

dotenv.config()

// Successful Transactions
// wstETH > stETH (via GenericSwapFacetV3): https://optimistic.etherscan.io/tx/0x4622d4ad989b07caae12588bab5e7e9dc8cc3cfa7eae33c3fa520a256cdbcaa2
// stETH > wstETH (via GenericSwapFacetV3): https://optimistic.etherscan.io/tx/0xabeef0c26c8492d466bef579583a35835be03ad55a79edc8f731a6bf6e4b48d0

// ABIs
const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const LIDO_WRAPPER_ABI = lidoWrapperArtifact.abi as Narrow<
  typeof lidoWrapperArtifact.abi
>
const ST_ETH_ABI = [
  'function getSharesByTokens(uint256) view returns (uint256)',
  'function getTokensByShares(uint256) view returns (uint256)',
]

enum SwapDirectionEnum {
  ST_ETH_TO_WST_ETH,
  WST_ETH_TO_ST_ETH,
}

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'optimism'
  const swapDirection: SwapDirectionEnum =
    SwapDirectionEnum.WST_ETH_TO_ST_ETH as SwapDirectionEnum // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<  @DEV: SWITCH SWAP DIRECTION HERE

  const {
    client,
    publicClient,
    walletAccount,
    lifiDiamondAddress,
    lifiDiamondContract,
  } = await setupEnvironment(srcChain, diamondAbi)
  const signerAddress = walletAccount.address
  console.info(`Connected wallet address: ${signerAddress}`)

  // Get stETH/wstETH addresses from config
  const ST_ETH_ADDRESS_OPTIMISM = getAddress(
    getConfigElement(lidoWrapperConfig, srcChain, 'stETH')
  )
  const WST_ETH_ADDRESS_OPTIMISM = getAddress(
    getConfigElement(lidoWrapperConfig, srcChain, 'wstETH')
  )

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS =
    swapDirection === SwapDirectionEnum.ST_ETH_TO_WST_ETH
      ? ST_ETH_ADDRESS_OPTIMISM
      : WST_ETH_ADDRESS_OPTIMISM
  const DST_TOKEN_ADDRESS =
    swapDirection === SwapDirectionEnum.ST_ETH_TO_WST_ETH
      ? WST_ETH_ADDRESS_OPTIMISM
      : ST_ETH_ADDRESS_OPTIMISM
  const lidoWrapperAddress = deploymentsOPT.LidoWrapper

  // === Instantiate contracts ===

  const [srcTokenContract, dstTokenContract] = [
    SRC_TOKEN_ADDRESS,
    swapDirection === SwapDirectionEnum.ST_ETH_TO_WST_ETH
      ? WST_ETH_ADDRESS_OPTIMISM
      : ST_ETH_ADDRESS_OPTIMISM,
  ].map((address) => getContract({ address, abi: ERC20_ABI, client }))

  const srcTokenSymbol = (await srcTokenContract.read.symbol()) as string
  const dstTokenSymbol = (await dstTokenContract.read.symbol()) as string
  const srcTokenDecimals = (await srcTokenContract.read.decimals()) as bigint
  const dstTokenDecimals = (await dstTokenContract.read.decimals()) as bigint

  const initialSrcTokenBalance = (await srcTokenContract.read.balanceOf([
    signerAddress,
  ])) as bigint

  const initBalanceReadable = Number(
    formatUnits(initialSrcTokenBalance, Number(srcTokenDecimals))
  )

  console.info(
    `This script requires the signer wallet (${signerAddress}) to have an ${
      swapDirection === SwapDirectionEnum.ST_ETH_TO_WST_ETH ? 'stETH' : 'wstETH'
    } balance on OPT and it has: ${initBalanceReadable}`
  )

  // update fromAmount with 10% of current srcToken holdings
  const amount = parseUnits(
    (initBalanceReadable * 0.1).toString(),
    Number(srcTokenDecimals)
  )

  await ensureBalance(srcTokenContract, signerAddress, amount)

  await ensureAllowance(
    srcTokenContract,
    signerAddress,
    lifiDiamondAddress,
    amount,
    publicClient
  )

  const expAmountOut = await getLidoAmountOut(
    swapDirection,
    amount,
    ST_ETH_ADDRESS_OPTIMISM,
    client.public
  )

  console.info(
    `Swap ${parseAmountToHumanReadable(
      amount,
      srcTokenDecimals
    )} ${srcTokenSymbol} to ${dstTokenSymbol} (expecting: ${parseAmountToHumanReadable(
      expAmountOut,
      dstTokenDecimals
    )})`
  )

  // === Prepare SwapData ===
  const lidoWrapperCalldata = await getLidoWrapperCallData(
    swapDirection,
    amount
  )

  const lidoWrapperSwapData: LibSwap.SwapDataStruct = {
    // Edit fields as needed
    callTo: lidoWrapperAddress,
    approveTo: lidoWrapperAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receivingAssetId: DST_TOKEN_ADDRESS,
    fromAmount: amount,
    callData: lidoWrapperCalldata,
    requiresDeposit: true,
  }

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.swapTokensSingleV3ERC20ToERC20([
        `0x${randomBytes(32).toString('hex')}`,
        'integrator',
        'referrer',
        DEV_WALLET_ADDRESS,
        expAmountOut,
        lidoWrapperSwapData,
      ]),
    'Starting swapping tokens using LidoWrapper via GenericSwapFacetV3',
    publicClient,
    true
  )
}

const getLidoAmountOut = async (
  swapDirection: SwapDirectionEnum,
  fromAmount: bigint,
  ST_ETH_ADDRESS_OPTIMISM: string,
  client: PublicClient
): Promise<bigint> => {
  // get ST_ETH contract (independent of swap direction)
  const stETH = getContract({
    address: getAddress(ST_ETH_ADDRESS_OPTIMISM),
    abi: parseAbi(ST_ETH_ABI),
    client: client,
  })

  const amountOut =
    swapDirection === SwapDirectionEnum.ST_ETH_TO_WST_ETH
      ? ((await stETH.read.getSharesByTokens([fromAmount])) as bigint)
      : ((await stETH.read.getTokensByShares([fromAmount])) as bigint)

  if (!amountOut)
    throw new Error(
      'Error while getting expected output amount from stETH contract'
    )

  return amountOut - 1n // remove one token to allow for rounding errors in stETH contract
}

const getLidoWrapperCallData = async (
  direction: SwapDirectionEnum,
  amount: bigint
): Promise<`0x${string}`> => {
  const functionName =
    direction === SwapDirectionEnum.ST_ETH_TO_WST_ETH
      ? 'wrapStETHToWstETH'
      : 'unwrapWstETHToStETH'

  return encodeFunctionData({
    abi: LIDO_WRAPPER_ABI,
    functionName,
    args: [amount],
  })
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
