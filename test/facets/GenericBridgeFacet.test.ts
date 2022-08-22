import { Chain, Hop } from '@hop-protocol/sdk'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers'
import { constants, Contract, utils } from 'ethers'
import { deployments, ethers, network } from 'hardhat'
import {
  IERC20__factory as ERC20__factory,
  GenericBridgeFacet,
} from '../../typechain'
import { node_url } from '../../utils/network'
import config from '../../config/hop'
import { expect } from '../chai-setup'

const USDC_ADDRESS = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
const hUSDC_ADDRESS = '0x9ec9551d4A1a1593b0ee8124D98590CC71b3B09D'
const SADDLESWAP_ADDRESS = '0x5C32143C8B198F392d01f8446b754c181224ac26'

describe('Generic Bridge Facet', async () => {
  let alice: SignerWithAddress
  let bob: SignerWithAddress
  let lifi: GenericBridgeFacet
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lifiData: any

  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      await deployments.fixture('DeployGenericBridgeFacet')

      const diamond = await ethers.getContract('LiFiDiamond')
      lifi = <GenericBridgeFacet>(
        await ethers.getContractAt('GenericBridgeFacet', diamond.address)
      )

      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: ['0x7cd7a5a66d3cd2f13559d7f8a052fa6014e07d35'],
      })

      alice = await ethers.getSigner(
        '0x7cd7a5a66d3cd2f13559d7f8a052fa6014e07d35'
      )

      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: ['0x06959153b974d0d5fdfd87d561db6d8d4fa0bb0b'],
      })

      bob = await ethers.getSigner('0x06959153b974d0d5fdfd87d561db6d8d4fa0bb0b')

      lifiData = {
        transactionId: utils.randomBytes(32),
        integrator: 'ACME Devs',
        referrer: constants.AddressZero,
        sendingAssetId: USDC_ADDRESS,
        receivingAssetId: USDC_ADDRESS,
        receiver: alice.address,
        destinationChainId: 137,
        amount: utils.parseUnits('10000', 6),
      }
    }
  )

  before(async function () {
    this.timeout(0)
    await network.provider.request({
      method: 'hardhat_reset',
      params: [
        {
          forking: {
            jsonRpcUrl: node_url('polygon'),
            blockNumber: 23039952,
          },
        },
      ],
    })
  })

  beforeEach(async function () {
    this.timeout(0)
    await setupTest()
  })

  it('starts a bridge transaction on the sending chain', async () => {
    const amountIn = utils.parseUnits('1000', 6)
    const hop = new Hop('mainnet')
    const bridge = hop.connect(alice).bridge('USDC')

    const fee = await bridge.getTotalFee(amountIn, Chain.Polygon, Chain.Gnosis)

    // Approve ERC20 for bridging
    const token = ERC20__factory.connect(hUSDC_ADDRESS, alice)
    await token.approve(lifi.address, amountIn)

    // Get calldata for Hop bridge
    const abi = [
      'function send(uint256,address,uint256,uint256,uint256,uint256)',
    ]

    const bridgeContract = new ethers.Contract(
      config.polygon.USDC?.bridge || constants.AddressZero,
      abi,
      alice
    )

    const rawTx = await bridgeContract.populateTransaction.send(
      100,
      alice.address,
      amountIn,
      fee,
      0,
      0
    )

    const bridgeData = {
      amount: amountIn,
      assetId: hUSDC_ADDRESS,
      callTo: config.polygon.USDC?.bridge || constants.AddressZero,
      callData: <string>rawTx.data,
    }

    await expect(
      lifi.connect(alice).startBridgeTokensGeneric(lifiData, bridgeData, {
        gasLimit: 500000,
      })
    ).to.emit(lifi, 'LiFiTransferStarted')
  })

  it('performs a swap then starts bridge transaction on the sending chain', async () => {
    const amountIn = utils.parseUnits('1010', 6)
    const amountOut = utils.parseUnits('1000', 6)

    const hop = new Hop('mainnet')
    const bridge = hop.connect(bob).bridge('USDC')

    const fee = await bridge.getTotalFee(amountIn, Chain.Polygon, Chain.Gnosis)

    // Get calldata for Hop bridge
    const abi = [
      'function send(uint256,address,uint256,uint256,uint256,uint256)',
    ]

    const bridgeContract = new Contract(
      config.polygon.USDC?.bridge || constants.AddressZero,
      abi,
      bob
    )

    const rawTx = await bridgeContract.populateTransaction.send(
      100,
      bob.address,
      amountOut,
      fee,
      0,
      0
    )

    const bridgeData = {
      amount: amountOut,
      assetId: hUSDC_ADDRESS,
      callTo: config.polygon.USDC?.bridge || constants.AddressZero,
      callData: <string>rawTx.data,
    }

    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

    const saddleSwap = new Contract(
      SADDLESWAP_ADDRESS,
      [
        'function swap(uint8,uint8,uint256,uint256,uint256) external payable returns (uint256)',
      ],
      bob
    )

    // Generate swap calldata
    const swapData = await saddleSwap.populateTransaction.swap(
      0,
      1,
      amountIn,
      amountOut,
      deadline
    )

    // Approve ERC20 for swapping
    const token = ERC20__factory.connect(USDC_ADDRESS, bob)
    await token.approve(lifi.address, amountIn)

    await expect(
      lifi.connect(bob).swapAndStartBridgeTokensGeneric(
        lifiData,
        [
          {
            callTo: <string>swapData.to,
            approveTo: <string>swapData.to,
            sendingAssetId: USDC_ADDRESS,
            receivingAssetId: hUSDC_ADDRESS,
            callData: <string>swapData?.data,
            fromAmount: amountIn,
          },
        ],
        bridgeData,
        {
          gasLimit: 500000,
        }
      )
    )
      .to.emit(lifi, 'AssetSwapped')
      .and.to.emit(lifi, 'LiFiTransferStarted')
  })
})
