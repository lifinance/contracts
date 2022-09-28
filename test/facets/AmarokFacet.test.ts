import {
  IERC20 as ERC20,
  IERC20__factory as ERC20__factory,
  AmarokFacet,
  DexManagerFacet,
} from '../../typechain'
import { deployments, network } from 'hardhat'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers'
import { constants, Contract, ethers, utils } from 'ethers'
import { node_url } from '../../utils/network'
import { expect } from '../chai-setup'
import approvedFunctionSelectors from '../../utils/approvedFunctions'
import config from '../../config/amarok'

const GOERLI_USDC_ADDRESS = '0x98339D8C260052B7ad81c28c16C0b98420f2B46a'
const GOERLI_TOKEN_ADDRESS = '0x7ea6eA49B0b0Ae9c5db7907d139D9Cd3439862a1'
const OPTIMISM_GOERLI_TOKEN_ADDRESS =
  '0x68Db1c8d85C09d546097C65ec7DCBFF4D6497CbF'
const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const ZERO_ADDRESS = constants.AddressZero
const SEND_AMOUNT = utils.parseEther('1000')
const SWAP_AMOUNT_IN = utils.parseUnits('1020', 6)
const SWAP_AMOUNT_OUT = utils.parseEther('1000')

describe('AmarokFacet', function () {
  let alice: SignerWithAddress
  let lifi: AmarokFacet
  let dexMgr: DexManagerFacet
  let owner: SignerWithAddress
  let testToken: ERC20
  let dai: ERC20
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let validLiFiData: any
  let validAmarokData: any
  let swapData: any
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      await deployments.fixture('DeployAmarokFacet')

      owner = await ethers.getSigners()
      owner = owner[0]
      const diamond = await ethers.getContract('LiFiDiamond')
      lifi = <AmarokFacet>(
        await ethers.getContractAt('AmarokFacet', diamond.address)
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
        params: ['0x9Dc99fAf98d363Ec0909D1f5C3627dDdEA2a85D4'],
      })

      alice = await ethers.getSigner(
        '0x9Dc99fAf98d363Ec0909D1f5C3627dDdEA2a85D4'
      )

      testToken = ERC20__factory.connect(GOERLI_TOKEN_ADDRESS, alice)
      dai = ERC20__factory.connect(GOERLI_USDC_ADDRESS, alice)

      validAmarokData = {
        callData: '0x',
        forceSlow: false,
        receiveLocal: false,
        callback: ZERO_ADDRESS,
        callbackFee: 0,
        relayerFee: 0,
        slippageTol: 9995, // 9995 to tolerate .05% slippage
        originMinOut: 0,
      }

      const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

      const uniswap = new Contract(
        UNISWAP_ADDRESS,
        [
          'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
        ],
        alice
      )

      // Generate swap calldata
      const swapCallData =
        await uniswap.populateTransaction.swapTokensForExactTokens(
          SWAP_AMOUNT_OUT,
          SWAP_AMOUNT_IN,
          [GOERLI_USDC_ADDRESS, GOERLI_TOKEN_ADDRESS],
          lifi.address,
          deadline
        )

      swapData = [
        {
          callTo: <string>swapCallData.to,
          approveTo: <string>swapCallData.to,
          sendingAssetId: GOERLI_USDC_ADDRESS,
          receivingAssetId: GOERLI_TOKEN_ADDRESS,
          callData: <string>swapCallData?.data,
          fromAmount: SWAP_AMOUNT_IN,
        },
      ]

      // Approve ERC20 for swapping
      await dai.connect(alice).approve(lifi.address, SWAP_AMOUNT_IN)
      await testToken.approve(lifi.address, SEND_AMOUNT)
    }
  )

  before(async function () {
    this.timeout(0)
    await network.provider.request({
      method: 'hardhat_reset',
      params: [
        {
          forking: {
            jsonRpcUrl: node_url('goerli'),
            blockNumber: 7487011,
          },
        },
      ],
    })
  })

  beforeEach(async function () {
    this.timeout(0)
    await setupTest()
  })

  describe('startBridgeTokensViaAmarok function', () => {
    describe('should be reverted to starts a bridge transaction', () => {
      it('when the sending amount is zero', async function () {
        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'amarok',
          integrator: '',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: GOERLI_TOKEN_ADDRESS,
          receiver: alice.address,
          minAmount: 0,
          destinationChainId: 420,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        const amarokData = {
          ...validAmarokData,
        }

        await expect(
          lifi.connect(alice).startBridgeTokensViaAmarok(bridgeData, amarokData)
        ).to.be.revertedWith('InvalidAmount()')
      })

      it('when the receiver is zero address', async function () {
        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'amarok',
          integrator: '',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: GOERLI_TOKEN_ADDRESS,
          receiver: ethers.constants.AddressZero,
          minAmount: SEND_AMOUNT,
          destinationChainId: 420,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        const amarokData = {
          ...validAmarokData,
        }

        await expect(
          lifi.connect(alice).startBridgeTokensViaAmarok(bridgeData, amarokData)
        ).to.be.revertedWith('InvalidReceiver()')
      })

      it('when the user does not have enough amount', async () => {
        const testTokenBalance = await testToken.balanceOf(alice.address)
        await testToken.transfer(lifi.address, testTokenBalance)

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'amarok',
          integrator: '',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: GOERLI_TOKEN_ADDRESS,
          receiver: alice.address,
          minAmount: SEND_AMOUNT,
          destinationChainId: 420,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaAmarok(bridgeData, validAmarokData)
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance')
      })

      it('when sending native asset', async () => {
        const amarokData = {
          ...validAmarokData,
          assetId: ZERO_ADDRESS,
          amount: utils.parseEther('3'),
        }
        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'amarok',
          integrator: '',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: ZERO_ADDRESS,
          receiver: alice.address,
          minAmount: utils.parseEther('3'),
          destinationChainId: 420,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaAmarok(bridgeData, amarokData, {
              value: utils.parseEther('3'),
            })
        ).to.be.revertedWith('TokenAddressIsZero()')
      })
    })

    it('should be possible to starts a bridge transaction', async () => {
      const bridgeData = {
        transactionId: utils.randomBytes(32),
        bridge: 'amarok',
        integrator: '',
        referrer: ethers.constants.AddressZero,
        sendingAssetId: GOERLI_TOKEN_ADDRESS,
        receiver: alice.address,
        minAmount: SEND_AMOUNT,
        destinationChainId: 420,
        hasSourceSwaps: false,
        hasDestinationCall: false,
      }

      await expect(
        lifi
          .connect(alice)
          .startBridgeTokensViaAmarok(bridgeData, validAmarokData)
      )
        .to.emit(lifi, 'LiFiTransferStarted')
        .withArgs(
          utils.hexlify(validLiFiData.transactionId),
          'amarok',
          '',
          validLiFiData.integrator,
          validLiFiData.referrer,
          validLiFiData.sendingAssetId,
          OPTIMISM_GOERLI_TOKEN_ADDRESS,
          validLiFiData.receiver,
          validLiFiData.amount,
          validLiFiData.destinationChainId,
          false,
          false
        )
    })
  })

  describe('swapAndStartBridgeTokensViaAmarok function', () => {
    describe('should be reverted to perform a swap then starts a bridge transaction', () => {
      it('when the receiver is zero address', async function () {
        const amarokData = {
          ...validAmarokData,
        }

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'amarok',
          integrator: '',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: GOERLI_TOKEN_ADDRESS,
          receiver: ethers.constants.AddressZero,
          minAmount: SEND_AMOUNT,
          destinationChainId: 420,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaAmarok(
              validLiFiData,
              swapData,
              amarokData
            )
        ).to.be.revertedWith('InvalidReceiver()')
      })

      it('when the user does not have enough amount', async () => {
        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'amarok',
          integrator: '',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: GOERLI_TOKEN_ADDRESS,
          receiver: alice.address,
          minAmount: SEND_AMOUNT,
          destinationChainId: 420,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        const daiBalance = await dai.connect(alice).balanceOf(alice.address)
        await dai.connect(alice).transfer(testToken.address, daiBalance)

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaAmarok(
              bridgeData,
              swapData,
              validAmarokData
            )
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance')
      })

      it('when sending native asset', async () => {
        const amarokData = {
          ...validAmarokData,
          assetId: ZERO_ADDRESS,
          amount: utils.parseEther('3'),
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaAmarok(
              validLiFiData,
              swapData,
              amarokData,
              {
                value: utils.parseEther('3'),
              }
            )
        ).to.be.revertedWith('TokenAddressIsZero()')
      })

      it('when the dex is not approved', async function () {
        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'amarok',
          integrator: '',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: GOERLI_TOKEN_ADDRESS,
          receiver: alice.address,
          minAmount: SEND_AMOUNT,
          destinationChainId: 420,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        await dexMgr.removeDex(UNISWAP_ADDRESS)

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaAmarok(
              bridgeData,
              swapData,
              validAmarokData
            )
        ).to.be.revertedWith('ContractCallNotAllowed()')
      })
    })

    it('should be possible to perform a swap then starts a bridge transaction', async function () {
      const bridgeData = {
        transactionId: utils.randomBytes(32),
        bridge: 'amarok',
        integrator: '',
        referrer: ethers.constants.AddressZero,
        sendingAssetId: GOERLI_USDC_ADDRESS,
        receiver: alice.address,
        minAmount: SWAP_AMOUNT_OUT,
        destinationChainId: 420,
        hasSourceSwaps: false,
        hasDestinationCall: false,
      }

      await expect(
        lifi
          .connect(alice)
          .swapAndStartBridgeTokensViaAmarok(
            bridgeData,
            swapData,
            validAmarokData
          )
      )
        .to.emit(lifi, 'AssetSwapped')
        .and.to.emit(lifi, 'LiFiTransferStarted')
        .withArgs(bridgeData)
    })
  })
})
