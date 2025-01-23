import { utils, constants, Contract, ethers, BigNumber } from 'ethers'
import {
  GlacisFacet__factory,
  ERC20__factory,
  ILiFi,
  type GlacisFacet,
} from '../../typechain'
import deployments from '../../deployments/arbitrum.staging.json'
import config from '../../config/glacis.json'
import { zeroPadValue } from 'ethers6'
import dotenv from 'dotenv'
dotenv.config()

async function main() {
  const RPC_URL = process.env.ETH_NODE_URI_ARBITRUM
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond
  const WORMHOLE_ADDRESS = '0xB0fFa8000886e57F86dd5264b9582b2Ad87b2b91' // Wormhole token on Arbitrum
  const destinationChainId = 10 // Optimism

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const glacis = GlacisFacet__factory.connect(LIFI_ADDRESS, provider) as any

  const signerAddress = await signer.getAddress()

  const token = ERC20__factory.connect(WORMHOLE_ADDRESS, provider)
  const amount = utils.parseUnits('0.5', 18)
  console.info(
    `Transfer ${amount} Wormhole on Arbitrum to Wormhole on Optimism`
  )
  console.info(`Currently connected to ${signerAddress}`)

  const balance = await token.balanceOf(signerAddress)
  console.info(`Token balance for connected wallet: ${balance.toString()}`)
  if (balance.eq(0)) {
    console.error(`Connected account has no funds.`)
    console.error(`Exiting...`)
    process.exit(1)
  }

  const currentAllowance = await token.allowance(
    await signer.getAddress(),
    LIFI_ADDRESS
  )

  if (currentAllowance.lt(amount)) {
    console.info('Allowance is insufficient. Approving the required amount...')
    const gasPrice = await provider.getGasPrice()
    try {
      const tx = await token
        .connect(signer)
        .approve(LIFI_ADDRESS, amount, { gasPrice })
      await tx.wait()
    } catch (error) {
      console.error('Approval failed:', error)
      process.exit(1)
    }
    console.info('Approval transaction complete. New allowance set.')
  } else {
    console.info('Sufficient allowance already exists. No need to approve.')
  }

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'glacis',
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: WORMHOLE_ADDRESS,
    receiver: signerAddress,
    destinationChainId: destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const airliftContract = new Contract(config.arbitrum.airlift, [
    'function quoteSend(address token, uint256 amount, bytes32 receiver, uint256 destinationChainId, address refundAddress, uint256 msgValue) external returns ((uint256, uint256), uint256, uint256, ((uint256, uint256), uint256, uint256))',
  ])

  // calculate native fee
  let estimatedFees
  try {
    estimatedFees = await airliftContract
      .connect(signer)
      .callStatic.quoteSend(
        WORMHOLE_ADDRESS,
        amount,
        zeroPadValue(signerAddress, 32),
        destinationChainId,
        signerAddress,
        utils.parseEther('1')
      )
    if (!estimatedFees) throw new Error('Invalid fee estimation')
  } catch (error) {
    console.error('Fee estimation failed:', error)
    process.exit(1)
  }
  const structuredFees = {
    gmpFee: {
      nativeFee: BigNumber.from(estimatedFees[0][0]),
      tokenFee: BigNumber.from(estimatedFees[0][1]),
    },
    airliftFee: {
      nativeFee: BigNumber.from(estimatedFees[3][0][0]),
      tokenFee: BigNumber.from(estimatedFees[3][0][1]),
    },
  }
  const nativeFee = structuredFees.gmpFee.nativeFee.add(
    structuredFees.airliftFee.nativeFee
  )

  const glacisBridgeData: GlacisFacet.GlacisDataStruct = {
    refundAddress: signerAddress,
    nativeFee,
  }

  console.info('Bridging WORMHOLE...')
  try {
    const tx = await glacis
      .connect(signer)
      .startBridgeTokensViaGlacis(bridgeData, glacisBridgeData, {
        value: nativeFee,
      })
    await tx.wait()
  } catch (error) {
    console.error('Bridge transaction failed:', error)
    process.exit(1)
  }
  console.info('Bridged WORMHOLE')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
