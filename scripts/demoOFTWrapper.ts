import { providers, Wallet, utils, constants, BigNumber } from 'ethers'
import { OFTWrapperFacet__factory, ERC20__factory } from '../typechain'
import { node_url } from '../utils/network'
import deployments from '../deployments/goerli.staging.json'
import chalk from 'chalk'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const LIFI_ADDRESS = deployments.LiFiDiamond
const OFT_ADDRESS = '0x61493e3f3Aeb2Cf99F9d2907333d91c6721474D7'
const OFTV2_ADDRESS = '0xDEb9bB3ddc214f9c8417C1263579038285C78D91'
const OFTFEEV2_ADDRESS = '0x1D265df1138520Da9a7ba16F5D027C4B20813C76'
const ZERO_ADDRESS = constants.AddressZero
const destinationChainId = 97 // bsc testnet

const amount = utils.parseEther('5')

async function main() {
  const jsonProvider = new providers.JsonRpcProvider(node_url('goerli'))
  const provider = new providers.FallbackProvider([jsonProvider])

  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  wallet = wallet.connect(provider)
  const walletAddress = await wallet.getAddress()

  const lifi = OFTWrapperFacet__factory.connect(LIFI_ADDRESS, wallet)

  // Bridge OFT Asset
  {
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'oftwrapper',
      integrator: 'ACME Devs',
      referrer: ZERO_ADDRESS,
      sendingAssetId: OFT_ADDRESS,
      receiver: walletAddress,
      minAmount: amount,
      destinationChainId: destinationChainId,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const oftWrapperData = {
      tokenType: 0, // OFT
      receiver: utils.zeroPad(walletAddress, 32),
      minAmount: amount.mul(9).div(10),
      lzFee: BigNumber.from(0),
      adapterParams: utils.solidityPack(['uint16', 'uint256'], [1, 500000]),
    }

    const [nativeFee] = await lifi.estimateSendFee(bridgeData, oftWrapperData)

    oftWrapperData.lzFee = nativeFee

    // Approve OFT for bridging
    const token = ERC20__factory.connect(OFT_ADDRESS, wallet)
    const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
    if (amount.gt(allowance)) {
      await token.approve(LIFI_ADDRESS, amount)

      msg('Token approved for swapping')
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.startBridgeTokensViaOFTWrapper(bridgeData, oftWrapperData, {
      gasLimit: 500000,
      value: nativeFee,
    })
  }

  // Bridge OFTV2 Asset
  {
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'oftwrapper',
      integrator: 'ACME Devs',
      referrer: ZERO_ADDRESS,
      sendingAssetId: OFTV2_ADDRESS,
      receiver: walletAddress,
      minAmount: amount,
      destinationChainId: destinationChainId,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const oftWrapperData = {
      tokenType: 1, // OFTV2
      receiver: utils.zeroPad(walletAddress, 32),
      minAmount: amount.mul(9).div(10),
      lzFee: BigNumber.from(0),
      adapterParams: utils.solidityPack(['uint16', 'uint256'], [1, 500000]),
    }

    const [nativeFee] = await lifi.estimateSendFee(bridgeData, oftWrapperData)

    oftWrapperData.lzFee = nativeFee

    // Approve OFTV2 for bridging
    const token = ERC20__factory.connect(OFTV2_ADDRESS, wallet)
    const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
    if (amount.gt(allowance)) {
      await token.approve(LIFI_ADDRESS, amount)

      msg('Token approved for swapping')
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.startBridgeTokensViaOFTWrapper(bridgeData, oftWrapperData, {
      gasLimit: 500000,
      value: nativeFee,
    })
  }

  // Bridge OFTFEEV2 Asset
  {
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'oftwrapper',
      integrator: 'ACME Devs',
      referrer: ZERO_ADDRESS,
      sendingAssetId: OFTFEEV2_ADDRESS,
      receiver: walletAddress,
      minAmount: amount,
      destinationChainId: destinationChainId,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const oftWrapperData = {
      tokenType: 2, // OFTFEEV2
      receiver: utils.zeroPad(walletAddress, 32),
      minAmount: amount.mul(9).div(10),
      lzFee: BigNumber.from(0),
      adapterParams: utils.solidityPack(['uint16', 'uint256'], [1, 500000]),
    }

    const [nativeFee] = await lifi.estimateSendFee(bridgeData, oftWrapperData)

    oftWrapperData.lzFee = nativeFee

    // Approve OFTFEEV2 for bridging
    const token = ERC20__factory.connect(OFTFEEV2_ADDRESS, wallet)
    const allowance = await token.allowance(walletAddress, LIFI_ADDRESS)
    if (amount.gt(allowance)) {
      await token.approve(LIFI_ADDRESS, amount)

      msg('Token approved for swapping')
    }

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.startBridgeTokensViaOFTWrapper(bridgeData, oftWrapperData, {
      gasLimit: 500000,
      value: nativeFee,
    })
  }
}

main()
  .then(() => {
    console.error('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })
