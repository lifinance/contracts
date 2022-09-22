import {
  IERC20 as ERC20,
  IERC20__factory as ERC20__factory,
  PolygonBridgeFacet,
  DexManagerFacet,
} from '../../typechain'
import { deployments, network } from 'hardhat'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers'
import { constants, Contract, ethers, utils } from 'ethers'
import { node_url } from '../../utils/network'
import { expect } from '../chai-setup'
import approvedFunctionSelectors from '../../utils/approvedFunctions'

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const DAI_ADDRESS = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const POS_DAI_ADDRESS = '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'
const UNISWAP_ADDRESS = '0xE592427A0AEce92De3Edee1F18E0157C05861564'
const ZERO_ADDRESS = constants.AddressZero
const SEND_AMOUNT = utils.parseEther('1000')
const SWAP_AMOUNT_IN = utils.parseUnits('1020', 6)
const SWAP_AMOUNT_OUT = utils.parseEther('1000')
const ROOT_CHAIN_MGR = '0xA0c68C638235ee32657e8f720a23ceC1bFc77C77'
const ERC20_PREDICATE = '0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf'

describe('PolygonBridgeFacet', function () {
  let alice: SignerWithAddress
  let lifi: PolygonBridgeFacet
  let dexMgr: DexManagerFacet
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let owner: any
  let dai: ERC20
  let usdc: ERC20
  let bridgeData: any
  let validPolygonData: any
  let swapData: any
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      await deployments.fixture('DeployPolygonBridgeFacet')

      owner = await ethers.getSigners()
      owner = owner[0]
      const diamond = await ethers.getContract('LiFiDiamond')
      lifi = <PolygonBridgeFacet>(
        await ethers.getContractAt('PolygonBridgeFacet', diamond.address)
      )

      dexMgr = <DexManagerFacet>(
        await ethers.getContractAt('DexManagerFacet', diamond.address)
      )
      await dexMgr.addDex(UNISWAP_ADDRESS)
      await dexMgr.batchSetFunctionApprovalBySignature(
        approvedFunctionSelectors,
        true
      )

      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: ['0xaD0135AF20fa82E106607257143d0060A7eB5cBf'],
      })

      alice = await ethers.getSigner(
        '0xaD0135AF20fa82E106607257143d0060A7eB5cBf'
      )

      dai = ERC20__factory.connect(DAI_ADDRESS, alice)
      usdc = ERC20__factory.connect(USDC_ADDRESS, alice)

      const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

      const uniswap = new Contract(
        UNISWAP_ADDRESS,
        [
          'function exactOutputSingle(tuple(address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)',
        ],
        alice
      )

      // Generate swap calldata
      const swapCallData = await uniswap.populateTransaction.exactOutputSingle([
        USDC_ADDRESS,
        DAI_ADDRESS,
        3000,
        lifi.address,
        deadline,
        SWAP_AMOUNT_OUT,
        SWAP_AMOUNT_IN,
        0,
      ])

      swapData = [
        {
          callTo: <string>swapCallData.to,
          approveTo: <string>swapCallData.to,
          sendingAssetId: USDC_ADDRESS,
          receivingAssetId: DAI_ADDRESS,
          callData: <string>swapCallData?.data,
          fromAmount: SWAP_AMOUNT_IN,
          requiresDeposit: true,
        },
      ]

      validPolygonData = {
        rootChainManager: ROOT_CHAIN_MGR,
        erc20Predicate: ERC20_PREDICATE,
        receiver: alice.address,
        assetId: DAI_ADDRESS,
        amount: SEND_AMOUNT,
      }

      // Approve ERC20 for swapping
      await usdc.approve(lifi.address, SWAP_AMOUNT_IN)
      await dai.approve(lifi.address, SEND_AMOUNT)
    }
  )

  before(async function () {
    this.timeout(0)
    await network.provider.request({
      method: 'hardhat_reset',
      params: [
        {
          forking: {
            jsonRpcUrl: node_url('mainnet'),
            blockNumber: 14954000,
          },
        },
      ],
    })
  })

  beforeEach(async function () {
    this.timeout(0)
    await setupTest()
  })

  describe('startBridgeTokensViaPolygonBridge function', () => {
    describe('should be reverted to starts a bridge transaction', () => {
      it('when the sending amount is zero', async function () {
        const polygonData = {
          ...validPolygonData,
          amount: '0',
        }

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'polygon',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: DAI_ADDRESS,
          receiver: alice.address,
          minAmount: '0',
          destinationChainId: 137,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaPolygonBridge(bridgeData, polygonData)
        ).to.be.revertedWith('InvalidAmount()')
      })

      it('when the receiver is zero address', async function () {
        const polygonData = {
          ...validPolygonData,
          receiver: ZERO_ADDRESS,
        }

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'polygon',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: DAI_ADDRESS,
          receiver: ZERO_ADDRESS,
          minAmount: SEND_AMOUNT,
          destinationChainId: 137,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaPolygonBridge(bridgeData, polygonData)
        ).to.be.revertedWith('InvalidReceiver()')
      })

      it('when the user does not have enough amount', async () => {
        const daiBalance = await dai.balanceOf(alice.address)
        await dai.transfer(lifi.address, daiBalance)

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'polygon',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: DAI_ADDRESS,
          receiver: alice.address,
          minAmount: SEND_AMOUNT,
          destinationChainId: 137,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaPolygonBridge(bridgeData, validPolygonData)
        ).to.be.revertedWith('InsufficientBalance')
      })

      it('when the sending native asset amount is not enough', async () => {
        const polygonData = {
          ...validPolygonData,
          assetId: ZERO_ADDRESS,
          amount: utils.parseEther('10'),
        }

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'polygon',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: ZERO_ADDRESS,
          receiver: alice.address,
          minAmount: utils.parseEther('10'),
          destinationChainId: 137,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaPolygonBridge(bridgeData, polygonData, {
              gasLimit: 500000,
              value: utils.parseEther('9'),
            })
        ).to.be.revertedWith('InvalidAmount()')
      })
    })

    describe('should be possible to starts a bridge transaction', () => {
      it('when transfer non-native asset', async function () {
        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'polygon',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: DAI_ADDRESS,
          receiver: alice.address,
          minAmount: SEND_AMOUNT,
          destinationChainId: 137,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }
        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaPolygonBridge(bridgeData, validPolygonData, {
              gasLimit: 500000,
            })
        ).to.emit(lifi, 'LiFiTransferStarted')
      })

      it('when transfer native asset', async function () {
        const polygonData = {
          ...validPolygonData,
          assetId: ZERO_ADDRESS,
          amount: utils.parseEther('10'),
        }

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'polygon',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: ZERO_ADDRESS,
          receiver: alice.address,
          minAmount: utils.parseEther('10'),
          destinationChainId: 137,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaPolygonBridge(bridgeData, polygonData, {
              gasLimit: 500000,
              value: utils.parseEther('10'),
            })
        ).to.emit(lifi, 'LiFiTransferStarted')
      })
    })
  })

  describe('swapAndStartBridgeTokensViaPolygonBridge function', () => {
    describe('should be reverted to perform a swap then starts a bridge transaction', () => {
      it('when the receiver is zero address', async function () {
        const polygonData = {
          ...validPolygonData,
          receiver: ZERO_ADDRESS,
        }

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'polygon',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: DAI_ADDRESS,
          receiver: ZERO_ADDRESS,
          minAmount: SEND_AMOUNT,
          destinationChainId: 137,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaPolygonBridge(
              bridgeData,
              swapData,
              polygonData
            )
        ).to.be.revertedWith('InvalidReceiver()')
      })

      it('when the user does not have enough amount', async () => {
        const usdcBalance = await usdc.balanceOf(alice.address)
        await usdc.transfer(dai.address, usdcBalance)

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'polygon',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: DAI_ADDRESS,
          receiver: alice.address,
          minAmount: SEND_AMOUNT,
          destinationChainId: 137,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaPolygonBridge(
              bridgeData,
              swapData,
              validPolygonData
            )
        ).to.be.revertedWith('InsufficientBalance')
      })

      it('when the dex is not approved', async function () {
        await dexMgr.removeDex(UNISWAP_ADDRESS)
        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'polygon',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: DAI_ADDRESS,
          receiver: alice.address,
          minAmount: SEND_AMOUNT,
          destinationChainId: 137,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }
        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaPolygonBridge(
              bridgeData,
              swapData,
              validPolygonData
            )
        ).to.be.revertedWith('ContractCallNotAllowed()')
      })
    })

    it('should be possible to perform a swap then starts a bridge transaction', async function () {
      const bridgeData = {
        transactionId: utils.randomBytes(32),
        bridge: 'polygon',
        integrator: 'ACME Devs',
        referrer: ethers.constants.AddressZero,
        sendingAssetId: DAI_ADDRESS,
        receiver: alice.address,
        minAmount: SEND_AMOUNT,
        destinationChainId: 137,
        hasSourceSwaps: false,
        hasDestinationCall: false,
      }
      await expect(
        lifi
          .connect(alice)
          .swapAndStartBridgeTokensViaPolygonBridge(
            bridgeData,
            swapData,
            validPolygonData
          )
      )
        .to.emit(lifi, 'AssetSwapped')
        .and.to.emit(lifi, 'LiFiTransferStarted')
    })
  })
})
