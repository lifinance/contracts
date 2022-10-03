/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  StargateFacet,
  DexManagerFacet,
  Executor,
  Receiver,
  PeripheryRegistryFacet,
  IERC20 as ERC20,
  IERC20__factory as ERC20__factory,
} from '../../typechain'
import { deployments, ethers, network } from 'hardhat'
import { constants, utils } from 'ethers'
import { node_url } from '../../utils/network'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers'
import { expect } from '../chai-setup'
import approvedFunctionSelectors from '../../utils/approvedFunctions'
import config, { POOLS, PAYLOAD_ABI } from '../../config/stargate'

const WMATIC_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'
const UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'
const ZERO_ADDRESS = constants.AddressZero

const SRC_CHAIN = 'polygon'
const SRC_ASSET = 'USDC'
const DST_CHAIN = 'optimism'

describe('StargateFacet', function () {
  let lifi: StargateFacet
  let executor: Executor
  let receiver: Receiver
  let dexMgr: DexManagerFacet
  let alice: SignerWithAddress
  let sgRouter: SignerWithAddress
  let usdc: ERC20
  let wmatic: ERC20
  let validBridgeData: any
  let validStargateData: any
  let swapData: any
  let payloadSwapData: any

  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      await deployments.fixture('DeployStargateFacet')
      await deployments.fixture('DeployExecutor')
      await deployments.fixture('DeployReceiver')

      const diamond = await ethers.getContract('LiFiDiamond')

      lifi = <StargateFacet>(
        await ethers.getContractAt('StargateFacet', diamond.address)
      )
      dexMgr = <DexManagerFacet>(
        await ethers.getContractAt('DexManagerFacet', diamond.address)
      )
      const registryFacet = <PeripheryRegistryFacet>(
        await ethers.getContractAt('PeripheryRegistryFacet', diamond.address)
      )
      const executorAddr = await registryFacet.getPeripheryContract('Executor')

      executor = <Executor>await ethers.getContractAt('Executor', executorAddr)
      receiver = await ethers.getContract('Receiver')

      await dexMgr.addDex(UNISWAP_ADDRESS)
      await dexMgr.batchSetFunctionApprovalBySignature(
        approvedFunctionSelectors,
        true
      )

      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: ['0x06959153b974d0d5fdfd87d561db6d8d4fa0bb0b'],
      })
      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [config[SRC_CHAIN].stargateRouter],
      })
      await network.provider.request({
        method: 'hardhat_setBalance',
        params: [
          config[SRC_CHAIN].stargateRouter,
          utils.parseEther('10').toHexString(),
        ],
      })

      alice = await ethers.getSigner(
        '0x06959153b974d0d5fdfd87d561db6d8d4fa0bb0b'
      )
      sgRouter = await ethers.getSigner(config[SRC_CHAIN].stargateRouter)

      wmatic = ERC20__factory.connect(WMATIC_ADDRESS, alice)
      usdc = ERC20__factory.connect(POOLS[SRC_ASSET][SRC_CHAIN], alice)

      validBridgeData = {
        transactionId: utils.randomBytes(32),
        bridge: 'polygon',
        integrator: 'ACME Devs',
        referrer: ZERO_ADDRESS,
        sendingAssetId: usdc.address,
        receiver: alice.address,
        minAmount: utils.parseUnits('1000', 6),
        destinationChainId: config[DST_CHAIN].chainId,
        hasSourceSwaps: false,
        hasDestinationCall: false,
      }

      validStargateData = {
        dstPoolId: 1,
        minAmountLD: utils.parseUnits('100', 6),
        dstGasForCall: 0,
        lzFee: 0,
        callTo: alice.address,
        callData: '0x',
      }

      const to = lifi.address // should be a checksummed recipient address
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

      const iface = new utils.Interface([
        'function swapETHForExactTokens(uint256,address[],address,uint256)',
      ])

      // Generate swap data
      const uniswapData = iface.encodeFunctionData('swapETHForExactTokens', [
        utils.parseUnits('1000', 6),
        [wmatic.address, usdc.address],
        to,
        deadline,
      ])

      swapData = [
        {
          callTo: UNISWAP_ADDRESS,
          approveTo: UNISWAP_ADDRESS,
          sendingAssetId: ZERO_ADDRESS,
          receivingAssetId: usdc.address,
          fromAmount: utils.parseEther('1500'),
          callData: uniswapData,
          requiresDeposit: false,
        },
      ]

      const payloadIface = new utils.Interface([
        'function swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
      ])

      // Generate swap calldata
      const payloadUniswapData = payloadIface.encodeFunctionData(
        'swapExactTokensForETH',
        [
          utils.parseUnits('1000', 6),
          utils.parseEther('600'),
          [usdc.address, wmatic.address],
          to,
          deadline,
        ]
      )

      payloadSwapData = [
        {
          callTo: UNISWAP_ADDRESS,
          approveTo: UNISWAP_ADDRESS,
          sendingAssetId: usdc.address,
          receivingAssetId: ZERO_ADDRESS,
          fromAmount: utils.parseUnits('1000', 6),
          callData: payloadUniswapData,
          requiresDeposit: false,
        },
      ]

      await usdc.approve(lifi.address, utils.parseUnits('1000', 6))

      await lifi.setStargatePoolId(usdc.address, POOLS[SRC_ASSET].id)
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
            blockNumber: 33758700,
          },
        },
      ],
    })
  })

  beforeEach(async () => {
    await setupTest()
  })

  describe('startBridgeTokensViaStargate function', () => {
    it(`should be possible to starts a bridge transaction`, async () => {
      const bridgeData = {
        ...validBridgeData,
        destinationChainId: config[DST_CHAIN].chainId,
      }

      const [requiredGasFee] = await lifi.quoteLayerZeroFee(
        bridgeData.destinationChainId,
        validStargateData
      )

      const stargateData = {
        ...validStargateData,
        lzFee: requiredGasFee,
      }

      await expect(
        lifi
          .connect(alice)
          .startBridgeTokensViaStargate(bridgeData, stargateData, {
            gasLimit: 500000,
            value: requiredGasFee,
          })
      ).to.emit(lifi, 'LiFiTransferStarted')
    })

    describe('should be reverted to starts a bridge transaction', () => {
      it('when the destination is a same chain', async () => {
        const bridgeData = {
          ...validBridgeData,
          destinationChainId: config[SRC_CHAIN].chainId,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(bridgeData, validStargateData, {
              gasLimit: 500000,
              value: utils.parseEther('10'),
            })
        ).to.be.revertedWith('Stargate: local chainPath does not exist')
      })

      it('when the destination chain is invalid', async () => {
        const bridgeData = {
          ...validBridgeData,
          destinationChainId: 99999,
        }

        await expect(
          lifi.quoteLayerZeroFee(
            bridgeData.destinationChainId,
            validStargateData
          )
        ).to.be.reverted

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(bridgeData, validStargateData, {
              gasLimit: 500000,
              value: utils.parseEther('10'),
            })
        ).to.be.revertedWith('UnknownLayerZeroChain')
      })

      it('when the fee is low', async () => {
        const [requiredGasFee] = await lifi.quoteLayerZeroFee(
          validBridgeData.destinationChainId,
          validStargateData
        )

        const stargateData = {
          ...validStargateData,
          lzFee: requiredGasFee.sub(1),
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(validBridgeData, stargateData, {
              gasLimit: 500000,
              value: requiredGasFee.sub(1),
            })
        ).to.be.revertedWith('LayerZero: not enough native for fees')
      })

      it('when the sending amount is zero', async () => {
        const bridgeData = {
          ...validBridgeData,
          minAmount: 0,
        }

        const [requiredGasFee] = await lifi.quoteLayerZeroFee(
          bridgeData.destinationChainId,
          validStargateData
        )

        const stargateData = {
          ...validStargateData,
          lzFee: requiredGasFee,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(bridgeData, stargateData, {
              gasLimit: 500000,
              value: requiredGasFee,
            })
        ).to.be.revertedWith('InvalidAmount()')
      })

      it('when the receiving amount is less then minimum acceptable amount', async () => {
        const [requiredGasFee] = await lifi.quoteLayerZeroFee(
          validBridgeData.destinationChainId,
          validStargateData
        )

        const stargateData = {
          ...validStargateData,
          lzFee: requiredGasFee.sub(1),
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(validBridgeData, stargateData, {
              gasLimit: 500000,
              value: requiredGasFee.sub(1),
            })
        ).to.be.revertedWith('LayerZero: not enough native for fees')
      })

      it('when the user does not have enough amount', async () => {
        const usdcBalance = await usdc.balanceOf(alice.address)
        await usdc.transfer(lifi.address, usdcBalance)

        const [requiredGasFee] = await lifi.quoteLayerZeroFee(
          validBridgeData.destinationChainId,
          validStargateData
        )

        const stargateData = {
          ...validStargateData,
          lzFee: requiredGasFee,
        }

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(validBridgeData, stargateData, {
              gasLimit: 500000,
              value: requiredGasFee,
            })
        ).to.be.revertedWith('InsufficientBalance')
      })
    })
  })

  describe('swapAndStartBridgeTokensViaStargate function', () => {
    it(`should be possible to perform a swap then starts a bridge transaction`, async () => {
      const bridgeData = {
        ...validBridgeData,
        destinationChainId: config[DST_CHAIN].chainId,
        hasSourceSwaps: true,
      }

      const [requiredGasFee] = await lifi.quoteLayerZeroFee(
        bridgeData.destinationChainId,
        validStargateData
      )

      const stargateData = {
        ...validStargateData,
        lzFee: requiredGasFee,
      }

      await expect(
        lifi
          .connect(alice)
          .swapAndStartBridgeTokensViaStargate(
            bridgeData,
            swapData,
            stargateData,
            {
              gasLimit: 1000000,
              value: utils.parseEther('1500').add(requiredGasFee),
            }
          )
      ).to.emit(lifi, 'LiFiTransferStarted')
    })

    describe('should be reverted to perform a swap then starts a bridge transaction', () => {
      it('when the destination is a same chain', async () => {
        const bridgeData = {
          ...validBridgeData,
          destinationChainId: config[SRC_CHAIN].chainId,
          hasSourceSwaps: true,
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              bridgeData,
              swapData,
              validStargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('1500').add(utils.parseEther('10')),
              }
            )
        ).to.be.revertedWith('Stargate: local chainPath does not exist')
      })

      it('when the destination chain is invalid', async () => {
        const bridgeData = {
          ...validBridgeData,
          destinationChainId: 9999,
          hasSourceSwaps: true,
        }

        await expect(
          lifi.quoteLayerZeroFee(
            bridgeData.destinationChainId,
            validStargateData
          )
        ).to.be.reverted

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              bridgeData,
              swapData,
              validStargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('1500').add(utils.parseEther('10')),
              }
            )
        ).to.be.revertedWith('UnknownLayerZeroChain')
      })

      it('when the fee is low', async () => {
        const bridgeData = {
          ...validBridgeData,
          hasSourceSwaps: true,
        }

        const [requiredGasFee] = await lifi.quoteLayerZeroFee(
          bridgeData.destinationChainId,
          validStargateData
        )

        const stargateData = {
          ...validStargateData,
          lzFee: requiredGasFee.sub(1),
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              bridgeData,
              swapData,
              stargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('1500').add(requiredGasFee).sub(1),
              }
            )
        ).to.be.revertedWith('LayerZero: not enough native for fees')
      })

      it('when the receiving amount is less then minimum acceptable amount', async () => {
        const bridgeData = {
          ...validBridgeData,
          hasSourceSwaps: true,
        }

        const [requiredGasFee] = await lifi.quoteLayerZeroFee(
          bridgeData.destinationChainId,
          validStargateData
        )

        const stargateData = {
          ...validStargateData,
          lzFee: requiredGasFee.sub(1),
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              bridgeData,
              swapData,
              stargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('1500').add(requiredGasFee).sub(1),
              }
            )
        ).to.be.revertedWith('LayerZero: not enough native for fees')
      })

      it('when the dex is not approved', async () => {
        await dexMgr.removeDex(UNISWAP_ADDRESS)

        const bridgeData = {
          ...validBridgeData,
          hasSourceSwaps: true,
        }

        const [requiredGasFee] = await lifi.quoteLayerZeroFee(
          bridgeData.destinationChainId,
          validStargateData
        )

        const stargateData = {
          ...validStargateData,
          lzFee: requiredGasFee,
        }

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              bridgeData,
              swapData,
              stargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('1500').add(requiredGasFee),
              }
            )
        ).to.be.revertedWith('ContractCallNotAllowed()')
      })
    })
  })

  describe('sgReceive function', () => {
    describe('should be reverted', () => {
      it('when sender is not stargate router', async () => {
        const payload = ethers.utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
          utils.randomBytes(32),
          [],
          POOLS[SRC_ASSET][SRC_CHAIN],
          alice.address,
        ])

        await expect(
          receiver.sgReceive(
            1,
            config[SRC_CHAIN].stargateRouter,
            0,
            usdc.address,
            utils.parseUnits('1000', 6),
            payload
          )
        ).to.be.revertedWith('InvalidStargateRouter')
      })

      it('when call swapAndCompleteBridgeTokens directly', async () => {
        await expect(
          executor
            .connect(sgRouter)
            .swapAndCompleteBridgeTokens(
              utils.randomBytes(32),
              payloadSwapData,
              usdc.address,
              alice.address
            )
        ).to.be.revertedWith('InvalidAmount()')
      })

      it('when token arrived amount is low', async () => {
        const payload = ethers.utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
          utils.randomBytes(32),
          payloadSwapData.map((data: any) => Object.values(data)),
          usdc.address,
          alice.address,
        ])

        await expect(
          receiver
            .connect(sgRouter)
            .sgReceive(
              1,
              config[SRC_CHAIN].stargateRouter,
              0,
              usdc.address,
              utils.parseUnits('1000', 6),
              payload
            )
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance')
      })
    })

    describe('should be possible to process sgReceive', () => {
      it('should process swapAndCompleteBridgeTokens', async () => {
        const payload = ethers.utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
          utils.randomBytes(32),
          payloadSwapData.map((data: any) => Object.values(data)),
          usdc.address,
          alice.address,
        ])
        await usdc.transfer(receiver.address, utils.parseUnits('1000', 6))
        await expect(
          receiver
            .connect(sgRouter)
            .sgReceive(
              1,
              config[SRC_CHAIN].stargateRouter,
              0,
              usdc.address,
              utils.parseUnits('1000', 6),
              payload
            )
        ).to.emit(executor, 'LiFiTransferCompleted')
      })

      it('should send to receiver when fails to call swapAndCompleteBridgeTokens', async () => {
        const payload = ethers.utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
          utils.randomBytes(32),
          payloadSwapData.map((data: any) => Object.values(data)),
          usdc.address,
          alice.address,
        ])

        await usdc.transfer(receiver.address, utils.parseUnits('100', 6))
        const usdcBalance = await usdc.balanceOf(alice.address)
        await expect(
          receiver
            .connect(sgRouter)
            .sgReceive(
              1,
              config[SRC_CHAIN].stargateRouter,
              0,
              usdc.address,
              utils.parseUnits('100', 6),
              payload
            )
        ).to.emit(receiver, 'LiFiTransferCompleted')
        expect(await usdc.balanceOf(alice.address)).to.equal(
          usdcBalance.add(utils.parseUnits('100', 6))
        )
      })
    })
  })
})
