/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  IERC20 as ERC20,
  IERC20__factory as ERC20__factory,
  GnosisBridgeFacet,
  DexManagerFacet,
} from '../../typechain'
import { deployments, network } from 'hardhat'
import { BigNumber, constants, Contract, ethers, utils } from 'ethers'
import { node_url } from '../../utils/network'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers'
import { expect } from '../chai-setup'
import approvedFunctionSelectors from '../../utils/approvedFunctions'
import config from '../../config/gnosis'

const BRIDGE_MAINNET = config.mainnet.xDaiBridge
const UNISWAP_ADDRESS = '0xE592427A0AEce92De3Edee1F18E0157C05861564'
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const DAI_ADDRESS = config.mainnet.token
const BRIDGE_XDAI = '0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6'

describe('GnosisBridgeFacet', function () {
  describe('Transfer Dai from Ethereum to Gnosis', async function () {
    let lifi: GnosisBridgeFacet
    let alice: SignerWithAddress
    let bob: SignerWithAddress
    let bridgeData: any
    let gnosisBridgeData: any
    let dai: ERC20
    let dexMgr: DexManagerFacet
    let usdc: ERC20
    const daiSendAmount: BigNumber = utils.parseEther('1000')

    if (network.name != 'hardhat') {
      throw 'Only hardhat supported for testing'
    }

    const setupTest = deployments.createFixture(
      async ({ deployments, ethers }) => {
        await deployments.fixture('DeployGnosisBridgeFacet')
        const diamond = await ethers.getContract('LiFiDiamond')
        lifi = <GnosisBridgeFacet>(
          await ethers.getContractAt('GnosisBridgeFacet', diamond.address)
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
          params: ['0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503'],
        })

        await network.provider.request({
          method: 'hardhat_impersonateAccount',
          params: ['0x29e1a61fccd40408f489336993e798d14d57d77f'],
        })

        alice = await ethers.getSigner(
          '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503'
        )

        bob = await ethers.getSigner(
          '0x29e1a61fccd40408f489336993e798d14d57d77f'
        )

        usdc = ERC20__factory.connect(USDC_ADDRESS, alice)
        dai = ERC20__factory.connect(DAI_ADDRESS, alice)
        gnosisBridgeData = {}

        await dai.approve(lifi.address, daiSendAmount)
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
              blockNumber: 14841000,
            },
          },
        ],
      })
    })

    beforeEach(async () => {
      await setupTest()
    })

    describe('starts a bridge transaction on the sending chain', async () => {
      describe('should be reverted to starts a bridge transaction', async () => {
        it('when sending amount is exceed allowances', async () => {
          const bridgeData = {
            transactionId: utils.randomBytes(32),
            bridge: 'gnosis',
            integrator: 'ACME Devs',
            referrer: ethers.constants.AddressZero,
            sendingAssetId: config.mainnet.token,
            receiver: bob.address,
            minAmount: daiSendAmount.add(1),
            destinationChainId: config.mainnet.dstChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false,
          }

          await expect(
            lifi.connect(alice).startBridgeTokensViaXDaiBridge(bridgeData, {
              gasLimit: 500000,
            })
          ).to.be.revertedWith('Dai/insufficient-allowance')
        })

        it('when sending amount is zero', async () => {
          const bridgeData = {
            transactionId: utils.randomBytes(32),
            bridge: 'gnosis',
            integrator: 'ACME Devs',
            referrer: ethers.constants.AddressZero,
            sendingAssetId: config.mainnet.token,
            receiver: bob.address,
            minAmount: daiSendAmount,
            destinationChainId: config.mainnet.dstChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false,
          }

          await expect(
            lifi.connect(alice).startBridgeTokensViaXDaiBridge(
              { ...bridgeData, minAmount: 0 },
              {
                gasLimit: 500000,
              }
            )
          ).to.be.revertedWith('InvalidAmount')
        })

        it('when receiver is zero address', async () => {
          const bridgeData = {
            transactionId: utils.randomBytes(32),
            bridge: 'gnosis',
            integrator: 'ACME Devs',
            referrer: ethers.constants.AddressZero,
            sendingAssetId: config.mainnet.token,
            receiver: bob.address,
            minAmount: daiSendAmount,
            destinationChainId: config.mainnet.dstChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false,
          }
          await expect(
            lifi.connect(alice).startBridgeTokensViaXDaiBridge(
              { ...bridgeData, receiver: constants.AddressZero },
              {
                gasLimit: 500000,
              }
            )
          ).to.be.reverted
        })

        it('when receiver is xDaiBridge address', async () => {
          await expect(
            lifi.connect(alice).startBridgeTokensViaXDaiBridge(
              { ...bridgeData, receiver: BRIDGE_MAINNET },
              {
                gasLimit: 500000,
              }
            )
          ).to.be.reverted
        })

        it('when receiver is xDaiBridge address on other side', async () => {
          await expect(
            lifi.connect(alice).startBridgeTokensViaXDaiBridge(
              { ...bridgeData, receiver: BRIDGE_XDAI },
              {
                gasLimit: 500000,
              }
            )
          ).to.be.reverted
        })

        it('when destination chain id is incorrect', async () => {
          const bridgeData = {
            transactionId: utils.randomBytes(32),
            bridge: 'gnosis',
            integrator: 'ACME Devs',
            referrer: ethers.constants.AddressZero,
            sendingAssetId: config.mainnet.token,
            receiver: bob.address,
            minAmount: daiSendAmount,
            destinationChainId: config.mainnet.dstChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false,
          }
          await expect(
            lifi.connect(alice).startBridgeTokensViaXDaiBridge(
              {
                ...bridgeData,
                destinationChainId: 1,
              },
              gnosisBridgeData,
              {
                gasLimit: 500000,
              }
            )
          ).to.be.revertedWith('InvalidDestinationChain')
        })

        it('when sending asset id is incorrect', async () => {
          const bridgeData = {
            transactionId: utils.randomBytes(32),
            bridge: 'gnosis',
            integrator: 'ACME Devs',
            referrer: ethers.constants.AddressZero,
            sendingAssetId: config.mainnet.token,
            receiver: bob.address,
            minAmount: daiSendAmount,
            destinationChainId: config.mainnet.dstChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false,
          }
          await expect(
            lifi.connect(alice).startBridgeTokensViaXDaiBridge(
              {
                ...bridgeData,
                sendingAssetId: alice.address,
              },
              gnosisBridgeData,
              {
                gasLimit: 500000,
              }
            )
          ).to.be.revertedWith('InvalidSendingToken')
        })
      })

      it('should be possible to starts a bridge transaction', async () => {
        const daiBalanceOfXDaiBridge = await dai.balanceOf(BRIDGE_MAINNET)
        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'gnosis',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: config.mainnet.token,
          receiver: bob.address,
          minAmount: daiSendAmount,
          destinationChainId: config.mainnet.dstChainId,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }
        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaXDaiBridge(bridgeData, gnosisBridgeData, {
              gasLimit: 500000,
            })
        ).to.emit(lifi, 'LiFiTransferStarted')

        expect(await dai.balanceOf(BRIDGE_MAINNET)).to.be.equal(
          daiBalanceOfXDaiBridge.add(daiSendAmount)
        )
      })
    })

    describe('performs a swap then starts bridge transaction on the sending chain', async () => {
      let swapData: any
      const amountIn = utils.parseUnits('1020', 6)

      beforeEach(async () => {
        const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

        const uniswap = new Contract(
          UNISWAP_ADDRESS,
          [
            'function exactOutputSingle(tuple(address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)',
          ],
          alice
        )

        // Generate swap calldata
        const swapCallData =
          await uniswap.populateTransaction.exactOutputSingle([
            USDC_ADDRESS,
            DAI_ADDRESS,
            3000,
            lifi.address,
            deadline,
            daiSendAmount,
            amountIn,
            0,
          ])

        swapData = [
          {
            callTo: <string>swapCallData.to,
            approveTo: <string>swapCallData.to,
            sendingAssetId: USDC_ADDRESS,
            receivingAssetId: DAI_ADDRESS,
            callData: <string>swapCallData?.data,
            fromAmount: amountIn,
            requiresDeposit: true,
          },
        ]
      })

      describe('should be reverted to perform a swap then starts a bridge transaction', async () => {
        it('when sending amount is exceed allowances', async () => {
          const bridgeData = {
            transactionId: utils.randomBytes(32),
            bridge: 'gnosis',
            integrator: 'ACME Devs',
            referrer: ethers.constants.AddressZero,
            sendingAssetId: config.mainnet.token,
            receiver: bob.address,
            minAmount: daiSendAmount.add(1),
            destinationChainId: config.mainnet.dstChainId,
            hasSourceSwaps: true,
            hasDestinationCall: false,
          }

          await expect(
            lifi
              .connect(alice)
              .swapAndStartBridgeTokensViaXDaiBridge(
                bridgeData,
                swapData,
                gnosisBridgeData,
                {
                  gasLimit: 500000,
                }
              )
          ).to.be.revertedWith('ERC20: transfer amount exceeds allowance')
        })

        it('when receiver is zero address', async () => {
          await usdc.approve(lifi.address, amountIn)
          await expect(
            lifi
              .connect(alice)
              .swapAndStartBridgeTokensViaXDaiBridge(
                { ...bridgeData, receiver: constants.AddressZero },
                swapData,
                {
                  gasLimit: 500000,
                }
              )
          ).to.be.reverted
        })

        it('when receiver is xDaiBridge address', async () => {
          await usdc.approve(lifi.address, amountIn)
          await expect(
            lifi
              .connect(alice)
              .swapAndStartBridgeTokensViaXDaiBridge(
                { ...bridgeData, receiver: BRIDGE_MAINNET },
                swapData,
                {
                  gasLimit: 500000,
                }
              )
          ).to.be.reverted
        })

        it('when receiver is xDaiBridge address on other side', async () => {
          await usdc.approve(lifi.address, amountIn)
          await expect(
            lifi
              .connect(alice)
              .swapAndStartBridgeTokensViaXDaiBridge(
                { ...bridgeData, receiver: BRIDGE_XDAI },
                swapData,
                {
                  gasLimit: 500000,
                }
              )
          ).to.be.reverted
        })

        it('when destination chain id is incorrect', async () => {
          const bridgeData = {
            transactionId: utils.randomBytes(32),
            bridge: 'gnosis',
            integrator: 'ACME Devs',
            referrer: ethers.constants.AddressZero,
            sendingAssetId: config.mainnet.token,
            receiver: bob.address,
            minAmount: daiSendAmount,
            destinationChainId: config.mainnet.dstChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false,
          }
          await usdc.approve(lifi.address, amountIn)
          await expect(
            lifi.connect(alice).swapAndStartBridgeTokensViaXDaiBridge(
              {
                ...bridgeData,
                destinationChainId: 1,
              },
              swapData,
              gnosisBridgeData,
              {
                gasLimit: 500000,
              }
            )
          ).to.be.revertedWith('InvalidDestinationChain')
        })

        it('when sending asset id is incorrect', async () => {
          const bridgeData = {
            transactionId: utils.randomBytes(32),
            bridge: 'gnosis',
            integrator: 'ACME Devs',
            referrer: ethers.constants.AddressZero,
            sendingAssetId: config.mainnet.token,
            receiver: bob.address,
            minAmount: daiSendAmount.add(1),
            destinationChainId: config.mainnet.dstChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false,
          }
          await usdc.approve(lifi.address, amountIn)
          await expect(
            lifi.connect(alice).swapAndStartBridgeTokensViaXDaiBridge(
              {
                ...bridgeData,
                sendingAssetId: alice.address,
              },
              swapData,
              gnosisBridgeData,
              {
                gasLimit: 500000,
              }
            )
          ).to.be.revertedWith('InvalidSendingToken')
        })

        it('when the dex is not approved', async () => {
          const bridgeData = {
            transactionId: utils.randomBytes(32),
            bridge: 'gnosis',
            integrator: 'ACME Devs',
            referrer: ethers.constants.AddressZero,
            sendingAssetId: config.mainnet.token,
            receiver: bob.address,
            minAmount: daiSendAmount.add(1),
            destinationChainId: config.mainnet.dstChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false,
          }
          await dexMgr.removeDex(UNISWAP_ADDRESS)

          await usdc.approve(lifi.address, amountIn)

          await expect(
            lifi
              .connect(alice)
              .swapAndStartBridgeTokensViaXDaiBridge(
                bridgeData,
                swapData,
                gnosisBridgeData,
                {
                  gasLimit: 500000,
                }
              )
          ).to.be.revertedWith('ContractCallNotAllowed')
        })
      })

      it('should be possible to perform a swap then starts a bridge transaction', async () => {
        await usdc.approve(lifi.address, amountIn)

        const bridgeData = {
          transactionId: utils.randomBytes(32),
          bridge: 'gnosis',
          integrator: 'ACME Devs',
          referrer: ethers.constants.AddressZero,
          sendingAssetId: config.mainnet.token,
          receiver: bob.address,
          minAmount: daiSendAmount,
          destinationChainId: config.mainnet.dstChainId,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        }

        const daiBalanceOfXDaiBridge = await dai.balanceOf(BRIDGE_MAINNET)

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaXDaiBridge(
              bridgeData,
              swapData,
              gnosisBridgeData,
              {
                gasLimit: 500000,
              }
            )
        ).to.emit(lifi, 'LiFiTransferStarted')

        expect(await dai.balanceOf(BRIDGE_MAINNET)).to.be.equal(
          daiBalanceOfXDaiBridge.add(daiSendAmount)
        )
      })
    })
  })
})
