import {
  IERC20 as ERC20,
  IERC20__factory as ERC20__factory,
  ArbitrumBridgeFacet,
  DexManagerFacet,
} from '../../typechain'
import { deployments, network } from 'hardhat'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers'
import { constants, Contract, utils } from 'ethers'
import { node_url } from '../../utils/network'
import { expect } from '../chai-setup'
import approvedFunctionSelectors from '../../utils/approvedFunctions'

const USDC_ADDRESS = '0x98339D8C260052B7ad81c28c16C0b98420f2B46a'
const TEST_TOKEN_ADDRESS = '0x7ea6eA49B0b0Ae9c5db7907d139D9Cd3439862a1'
const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const ZERO_ADDRESS = constants.AddressZero
const SEND_AMOUNT = utils.parseUnits('1000', 6)
const SWAP_AMOUNT_IN = utils.parseEther('1200')
const SWAP_AMOUNT_OUT = utils.parseUnits('1000', 6)
const MAX_SUBMISSION_COST = utils.parseEther('0.01')
const MAX_GAS = 100000
const MAX_GAS_PRICE = utils.parseUnits('10', 9)

describe('ArbitrumBridgeFacet', function () {
  let alice: SignerWithAddress
  let lifi: ArbitrumBridgeFacet
  let dexMgr: DexManagerFacet
  let token: ERC20
  let usdc: ERC20
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let owner: any
  let swapData: any
  let validBridgeData: any
  let arbitrumData: any
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      await deployments.fixture('DeployArbitrumBridgeFacet')

      owner = await ethers.getSigners()
      owner = owner[0]
      const diamond = await ethers.getContract('LiFiDiamond')
      lifi = <ArbitrumBridgeFacet>(
        await ethers.getContractAt('ArbitrumBridgeFacet', diamond.address)
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
        params: ['0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0'],
      })

      alice = await ethers.getSigner(
        '0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0'
      )

      token = ERC20__factory.connect(TEST_TOKEN_ADDRESS, alice)
      usdc = ERC20__factory.connect(USDC_ADDRESS, alice)

      validBridgeData = {
        transactionId: utils.randomBytes(32),
        bridge: 'arbitrum',
        integrator: 'ACME Devs',
        referrer: ZERO_ADDRESS,
        sendingAssetId: USDC_ADDRESS,
        receiver: alice.address,
        minAmount: SEND_AMOUNT,
        destinationChainId: 421613,
        hasSourceSwaps: false,
        hasDestinationCall: false,
      }

      arbitrumData = {
        maxSubmissionCost: MAX_SUBMISSION_COST,
        maxGas: MAX_GAS,
        maxGasPrice: MAX_GAS_PRICE,
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
          [TEST_TOKEN_ADDRESS, USDC_ADDRESS],
          lifi.address,
          deadline
        )

      swapData = [
        {
          callTo: <string>swapCallData.to,
          approveTo: <string>swapCallData.to,
          sendingAssetId: TEST_TOKEN_ADDRESS,
          receivingAssetId: USDC_ADDRESS,
          callData: <string>swapCallData?.data,
          fromAmount: SWAP_AMOUNT_IN,
          requiresDeposit: true,
        },
      ]

      // Approve ERC20 for swapping
      await token.approve(lifi.address, SWAP_AMOUNT_IN)
      await usdc.approve(lifi.address, SEND_AMOUNT)
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
            blockNumber: 7842360,
          },
        },
      ],
    })
  })

  beforeEach(async function () {
    this.timeout(0)
    await setupTest()
  })

  describe('startBridgeTokensViaArbitrumBridge function', () => {
    describe('should be reverted to starts a bridge transaction', () => {
      it('when the sending amount is zero', async function () {
        const bridgeData = {
          ...validBridgeData,
          minAmount: 0,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaArbitrumBridge(bridgeData, arbitrumData)
        ).to.be.revertedWith('InvalidAmount()')
      })

      it('when the receiver is zero address', async function () {
        const bridgeData = {
          ...validBridgeData,
          receiver: ZERO_ADDRESS,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaArbitrumBridge(bridgeData, arbitrumData)
        ).to.be.revertedWith('InvalidReceiver()')
      })

      it('when the user does not have enough amount', async () => {
        const tokenBalance = await token.balanceOf(alice.address)
        await token.transfer(lifi.address, tokenBalance)

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaArbitrumBridge(validBridgeData, arbitrumData)
        ).to.be.revertedWith('InvalidAmount')
      })

      it('when the user sent no enough gas', async () => {
        const cost = MAX_SUBMISSION_COST.add(MAX_GAS_PRICE.mul(MAX_GAS))

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaArbitrumBridge(validBridgeData, arbitrumData, {
              value: cost.sub(1),
            })
        ).to.be.revertedWith('InvalidAmount()')
      })

      it('when the sending native asset amount is not enough', async () => {
        const bridgeData = {
          ...validBridgeData,
          sendingAssetId: ZERO_ADDRESS,
          minAmount: utils.parseEther('3'),
        }
        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaArbitrumBridge(bridgeData, arbitrumData, {
              value: utils.parseEther('2'),
            })
        ).to.be.revertedWith('InvalidAmount()')
      })
    })

    describe('should be possible to starts a bridge transaction', () => {
      it('when transfer non-native asset', async function () {
        const cost = MAX_SUBMISSION_COST.add(MAX_GAS_PRICE.mul(MAX_GAS))

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaArbitrumBridge(validBridgeData, arbitrumData, {
              value: cost,
            })
        ).to.emit(lifi, 'LiFiTransferStarted')
      })

      it('when transfer native asset', async function () {
        const cost = MAX_SUBMISSION_COST.add(MAX_GAS_PRICE.mul(MAX_GAS))

        const bridgeData = {
          ...validBridgeData,
          sendingAssetId: ZERO_ADDRESS,
          minAmount: utils.parseEther('3'),
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaArbitrumBridge(bridgeData, arbitrumData, {
              value: utils.parseEther('3').add(cost),
            })
        ).to.emit(lifi, 'LiFiTransferStarted')
      })
    })
  })

  describe('swapAndStartBridgeTokensViaArbitrumBridge function', () => {
    describe('should be reverted to perform a swap then starts a bridge transaction', () => {
      it('when the receiver is zero address', async function () {
        const bridgeData = {
          ...validBridgeData,
          receiver: ZERO_ADDRESS,
          hasSourceSwaps: true,
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaArbitrumBridge(
              bridgeData,
              swapData,
              arbitrumData
            )
        ).to.be.revertedWith('InvalidReceiver()')
      })

      it('when the user does not have enough amount', async () => {
        const usdcBalance = await usdc.balanceOf(alice.address)
        await usdc.transfer(token.address, usdcBalance)

        const bridgeData = {
          ...validBridgeData,
          hasSourceSwaps: true,
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaArbitrumBridge(
              bridgeData,
              swapData,
              arbitrumData
            )
        ).to.be.revertedWith('InvalidAmount')
      })

      it('when the dex is not approved', async function () {
        await dexMgr.removeDex(UNISWAP_ADDRESS)

        const bridgeData = {
          ...validBridgeData,
          hasSourceSwaps: true,
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaArbitrumBridge(
              bridgeData,
              swapData,
              arbitrumData
            )
        ).to.be.revertedWith('ContractCallNotAllowed()')
      })
    })

    it('should be possible to perform a swap then starts a bridge transaction', async function () {
      const cost = MAX_SUBMISSION_COST.add(MAX_GAS_PRICE.mul(MAX_GAS))

      const bridgeData = {
        ...validBridgeData,
        hasSourceSwaps: true,
      }

      await expect(
        lifi
          .connect(alice)
          .swapAndStartBridgeTokensViaArbitrumBridge(
            bridgeData,
            swapData,
            arbitrumData,
            {
              value: cost,
            }
          )
      )
        .to.emit(lifi, 'AssetSwapped')
        .and.to.emit(lifi, 'LiFiTransferStarted')
    })
  })
})
