import { providers, Wallet, utils, constants, Contract } from 'ethers'
import chalk from 'chalk'
import { StargateFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import config, { POOLS, PAYLOAD_ABI } from '../config/stargate'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const srcChain = 'polygon'
const srcAsset = 'USDC'
const dstChain = 'bsc'
const dstAsset = 'USDT'
const amountToSwap = '1'
const amountOutMin = '0.99'

const SRC_LIFI_ADDRESS = '0x9DD11f4fc672006EA9E666b6a222C5A8141f2Ac0'
const DST_LIFI_ADDRESS = '0x9DD11f4fc672006EA9E666b6a222C5A8141f2Ac0'
const STARGATE_ROUTER = config[srcChain].stargateRouter

const UNISWAP_ADDRESS = '0x10ed43c718714eb63d5aa57b78b54704e256024e'
const BSC_BUSD_ADDRESS = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'
const busd_out_min = '0.98'

async function main() {
  const srcChainProvider1 = new providers.JsonRpcProvider(node_url(srcChain))
  const srcChainProvider = new providers.FallbackProvider([srcChainProvider1])

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(srcChainProvider)
  const walletAddress = await wallet.getAddress()

  const srcLifi = StargateFacet__factory.connect(SRC_LIFI_ADDRESS, wallet)
  const token = ERC20__factory.connect(POOLS[srcAsset][srcChain], wallet)

  const amount = utils.parseUnits(amountToSwap, 6)
  const amountMin = utils.parseUnits(amountOutMin, 6)
  const allowance = await token.allowance(walletAddress, SRC_LIFI_ADDRESS)

  if (amount.gt(allowance)) {
    await token.approve(SRC_LIFI_ADDRESS, amount)

    msg('Token approved for swapping')
  }

  const lifiData = {
    transactionId: utils.randomBytes(32),
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: POOLS[srcAsset][srcChain],
    receivingAssetId: POOLS[dstAsset][dstChain],
    receiver: walletAddress,
    destinationChainId: config[dstChain].chainId,
    amount: amount.toString(),
  }

  const uniswap = new Contract(UNISWAP_ADDRESS, [
    'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
  ])
  const path = [POOLS[dstAsset][dstChain], BSC_BUSD_ADDRESS]
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

  const swapData = await uniswap.populateTransaction.swapExactTokensForTokens(
    utils.parseEther(amountOutMin),
    utils.parseEther(busd_out_min),
    path,
    DST_LIFI_ADDRESS,
    deadline
  )

  const payload = utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
    Object.values(lifiData),
    [
      {
        callTo: <string>swapData.to,
        approveTo: <string>swapData.to,
        sendingAssetId: POOLS[dstAsset][dstChain],
        receivingAssetId: BSC_BUSD_ADDRESS,
        fromAmount: utils.parseEther(amountOutMin),
        callData: <string>swapData?.data,
      },
    ],
    BSC_BUSD_ADDRESS,
    walletAddress,
  ])

  const StargateData = {
    router: STARGATE_ROUTER,
    dstChainId: config[dstChain].layerZeroChainId,
    srcPoolId: POOLS[srcAsset].id,
    dstPoolId: POOLS[dstAsset].id,
    amountLD: amount.toString(),
    minAmountLD: amountMin,
    dstGasForCall: '600000',
    callTo: DST_LIFI_ADDRESS,
    callData: payload,
  }

  const quoteData = await srcLifi.quoteLayerZeroFee(StargateData)
  const requiredGasFee = quoteData[0]
  console.log('Required native gas fee:', requiredGasFee.toString())

  const trx = await srcLifi.startBridgeTokensViaStargate(
    lifiData,
    StargateData,
    {
      gasLimit: 1000000,
      value: requiredGasFee,
    }
  )

  msg('Bridge process started on sending chain')

  await trx.wait()

  const dstChainProvider1 = new providers.JsonRpcProvider(node_url(dstChain))
  const dstChainProvider = new providers.FallbackProvider([dstChainProvider1])
  wallet = wallet.connect(dstChainProvider)

  const dstLifi = StargateFacet__factory.connect(DST_LIFI_ADDRESS, wallet)

  let received = false
  let timeout = 1500

  msg('Waiting for completion on receiving chain')

  dstLifi.on(
    'LiFiTransferCompleted',
    (
      transactionId: string,
      assetId: string,
      receiver: string,
      amount: any,
      timestamp: any
    ) => {
      if (transactionId == utils.hexlify(lifiData.transactionId)) {
        received = true
        msg('Bridge completed on receiving chain')
        console.log('LiFiTransferCompleted', {
          transactionId,
          assetId,
          receiver,
          amount: amount.toString(),
          timestamp: timestamp.toString(),
        })
      }
    }
  )

  while (!received) {
    await new Promise((res) => setTimeout(res, 1000))
    timeout--
    if (timeout <= 0) {
      throw 'Bridge failed to complete on receiving chain'
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
