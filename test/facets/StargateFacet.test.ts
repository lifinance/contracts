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

const TEST_CHAINS: any = {
  Ethereum: 'mainnet',
  BSC: 'bsc',
  Avalanche: 'avalanche',
  Polygon: 'polygon',
  Arbitrum: 'arbitrumOne',
  Optimism: 'optimisticEthereum',
  Fantom: 'opera',
}
const SRC_CHAIN = 'Polygon'
const SRC_ASSET = 'USDT'

describe('StargateFacet', function () {
  let lifi: StargateFacet
  let executor: Executor
  let receiver: Receiver
  let dexMgr: DexManagerFacet
  let alice: SignerWithAddress
  let sgRouter: SignerWithAddress
  let usdt: ERC20
  let wmatic: ERC20
  let lifiData: any
  let testStargateData: any
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
        params: ['0x6722846282868a9c084b423aee79eb8ff69fc497'],
      })
      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: [config[TEST_CHAINS[SRC_CHAIN]].stargateRouter],
      })
      await network.provider.request({
        method: 'hardhat_setBalance',
        params: [
          config[TEST_CHAINS[SRC_CHAIN]].stargateRouter,
          utils.parseEther('10').toHexString(),
        ],
      })

      alice = await ethers.getSigner(
        '0x6722846282868a9c084b423aee79eb8ff69fc497'
      )
      sgRouter = await ethers.getSigner(
        config[TEST_CHAINS[SRC_CHAIN]].stargateRouter
      )

      wmatic = ERC20__factory.connect(WMATIC_ADDRESS, alice)
      usdt = ERC20__factory.connect(
        POOLS[SRC_ASSET][TEST_CHAINS[SRC_CHAIN]],
        alice
      )

      lifiData = {
        transactionId: utils.randomBytes(32),
        integrator: 'ACME Devs',
        referrer: constants.AddressZero,
        sendingAssetId: usdt.address,
        receivingAssetId: usdt.address,
        receiver: alice.address,
        destinationChainId: 1,
        amount: utils.parseUnits('1000', 6),
      }
      testStargateData = {
        dstChainId: 1,
        srcPoolId: 2,
        dstPoolId: 2,
        amountLD: utils.parseUnits('1000', 6),
        minAmountLD: utils.parseUnits('100', 6),
        dstGasForCall: 0,
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
        [wmatic.address, usdt.address],
        to,
        deadline,
      ])

      swapData = [
        {
          callTo: UNISWAP_ADDRESS,
          approveTo: UNISWAP_ADDRESS,
          sendingAssetId: ethers.constants.AddressZero,
          receivingAssetId: usdt.address,
          fromAmount: utils.parseEther('700'),
          callData: uniswapData,
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
          [usdt.address, wmatic.address],
          to,
          deadline,
        ]
      )

      payloadSwapData = [
        {
          callTo: UNISWAP_ADDRESS,
          approveTo: UNISWAP_ADDRESS,
          sendingAssetId: usdt.address,
          receivingAssetId: ethers.constants.AddressZero,
          fromAmount: utils.parseUnits('1000', 6),
          callData: payloadUniswapData,
        },
      ]

      await usdt.approve(lifi.address, utils.parseUnits('1000', 6))
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
            blockNumber: 26850000,
          },
        },
      ],
    })
  })

  beforeEach(async () => {
    await setupTest()
  })

  describe('startBridgeTokensViaStargate function', () => {
    describe(`should be possible to starts a bridge transaction On ${SRC_CHAIN}`, () => {
      const chains: string[] = Object.keys(TEST_CHAINS)
      const tokenNames: string[] = Object.keys(POOLS)
      chains.forEach((chain: string) => {
        if (chain != SRC_CHAIN) {
          config[TEST_CHAINS[chain]].pools.forEach((pool: any) => {
            const tokenName = tokenNames.find(
              (token: string) => POOLS[token] == pool
            )
            it(`to send to ${tokenName} on ${chain}`, async () => {
              const stargateData = {
                ...testStargateData,
                dstChainId: config[TEST_CHAINS[chain]].layerZeroChainId,
                dstPoolId: pool.id,
              }

              const quoteData = await lifi.quoteLayerZeroFee(stargateData)
              const requiredGasFee = quoteData[0]

              await expect(
                lifi.connect(alice).startBridgeTokensViaStargate(
                  {
                    ...lifiData,
                    receivingAssetId: pool[TEST_CHAINS[chain]],
                    destinationChainId: config[TEST_CHAINS[chain]].chainId,
                  },
                  stargateData,
                  {
                    gasLimit: 500000,
                    value: requiredGasFee,
                  }
                )
              )
                .to.emit(lifi, 'LiFiTransferStarted')
                .withArgs(
                  utils.hexlify(lifiData.transactionId),
                  'stargate',
                  '',
                  lifiData.integrator,
                  lifiData.referrer,
                  lifiData.sendingAssetId,
                  pool[TEST_CHAINS[chain]],
                  lifiData.receiver,
                  lifiData.amount,
                  config[TEST_CHAINS[chain]].chainId,
                  false,
                  false
                )
            })
          })
        }
      })
    })

    describe('should be reverted to starts a bridge transaction', () => {
      describe('when the destination is a same chain', () => {
        const tokenNames: string[] = Object.keys(POOLS)
        config[TEST_CHAINS[SRC_CHAIN]].pools.forEach((pool: any) => {
          const tokenName = tokenNames.find(
            (token: string) => POOLS[token] == pool
          )
          it(`sending to ${tokenName} on ${SRC_CHAIN} from ${SRC_CHAIN}`, async () => {
            const stargateData = {
              ...testStargateData,
              dstChainId: config[TEST_CHAINS[SRC_CHAIN]].layerZeroChainId,
              dstPoolId: pool.id,
            }

            await expect(lifi.quoteLayerZeroFee(stargateData)).to.be.reverted

            await expect(
              lifi.connect(alice).startBridgeTokensViaStargate(
                {
                  ...lifiData,
                  destinationChainId: config[TEST_CHAINS[SRC_CHAIN]].chainId,
                },
                stargateData,
                {
                  gasLimit: 500000,
                  value: utils.parseEther('10'),
                }
              )
            ).to.be.revertedWith('Stargate: local chainPath does not exist')
          })
        })
      })

      it('when the destination chain is invalid', async () => {
        const stargateData = {
          ...testStargateData,
          dstChainId: 99999,
        }

        await expect(lifi.quoteLayerZeroFee(stargateData)).to.be.reverted

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(lifiData, stargateData, {
              gasLimit: 500000,
              value: utils.parseEther('10'),
            })
        ).to.be.reverted
      })

      it('when the destination token is invalid', async () => {
        const stargateData = {
          ...testStargateData,
          dstPoolId: 99999,
        }

        const quoteData = await lifi.quoteLayerZeroFee(stargateData)
        const requiredGasFee = quoteData[0]

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(lifiData, stargateData, {
              gasLimit: 500000,
              value: requiredGasFee,
            })
        ).to.be.revertedWith('Stargate: local chainPath does not exist')
      })

      it('when the fee is low', async () => {
        const stargateData = testStargateData

        const quoteData = await lifi.quoteLayerZeroFee(stargateData)
        const requiredGasFee = quoteData[0]

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(lifiData, stargateData, {
              gasLimit: 500000,
              value: requiredGasFee.sub(1),
            })
        ).to.be.revertedWith('LayerZero: not enough native for fees')
      })

      it('when the sending amount is zero', async () => {
        const stargateData = {
          ...testStargateData,
          amountLD: 0,
        }

        const quoteData = await lifi.quoteLayerZeroFee(stargateData)
        const requiredGasFee = quoteData[0]

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(lifiData, stargateData, {
              gasLimit: 500000,
              value: requiredGasFee,
            })
        ).to.be.revertedWith('InvalidAmount()')
      })

      it('when the receiving amount is less then minimum acceptable amount', async () => {
        const stargateData = {
          ...testStargateData,
          minAmountLD: utils.parseUnits('1000', 6),
        }

        const quoteData = await lifi.quoteLayerZeroFee(stargateData)
        const requiredGasFee = quoteData[0]

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(lifiData, stargateData, {
              gasLimit: 500000,
              value: requiredGasFee.sub(1),
            })
        ).to.be.revertedWith('Stargate: slippage too high')
      })

      it('when the user does not have enough amount', async () => {
        const stargateData = {
          ...testStargateData,
        }

        const usdtBalance = await usdt.balanceOf(alice.address)
        await usdt.transfer(lifi.address, usdtBalance)

        const quoteData = await lifi.quoteLayerZeroFee(stargateData)
        const requiredGasFee = quoteData[0]

        await expect(
          lifi
            .connect(alice)
            .startBridgeTokensViaStargate(lifiData, stargateData, {
              gasLimit: 500000,
              value: requiredGasFee,
            })
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance')
      })
    })
  })

  describe('swapAndStartBridgeTokensViaStargate function', () => {
    describe(`should be possible to perform a swap then starts a bridge transaction on ${SRC_CHAIN}`, () => {
      const chains: string[] = Object.keys(TEST_CHAINS)
      const tokenNames: string[] = Object.keys(POOLS)
      chains.forEach((chain: string) => {
        if (chain != SRC_CHAIN) {
          config[TEST_CHAINS[chain]].pools.forEach((pool: any) => {
            const tokenName = tokenNames.find(
              (token: string) => POOLS[token] == pool
            )
            it(`to send to ${tokenName} on ${chain}`, async () => {
              const stargateData = {
                ...testStargateData,
                dstChainId: config[TEST_CHAINS[chain]].layerZeroChainId,
                dstPoolId: pool.id,
              }

              const quoteData = await lifi.quoteLayerZeroFee(stargateData)
              const requiredGasFee = quoteData[0]

              await expect(
                lifi.connect(alice).swapAndStartBridgeTokensViaStargate(
                  {
                    ...lifiData,
                    receivingAssetId: pool[TEST_CHAINS[chain]],
                    destinationChainId: config[TEST_CHAINS[chain]].chainId,
                  },
                  swapData,
                  stargateData,
                  {
                    gasLimit: 1000000,
                    value: utils.parseEther('700').add(requiredGasFee),
                  }
                )
              )
                .to.emit(lifi, 'LiFiTransferStarted')
                .withArgs(
                  utils.hexlify(lifiData.transactionId),
                  'stargate',
                  '',
                  lifiData.integrator,
                  lifiData.referrer,
                  lifiData.sendingAssetId,
                  pool[TEST_CHAINS[chain]],
                  lifiData.receiver,
                  lifiData.amount,
                  config[TEST_CHAINS[chain]].chainId,
                  true,
                  false
                )
            })
          })
        }
      })
    })

    describe('should be reverted to perform a swap then starts a bridge transaction', () => {
      describe('when the destination is a same chain', () => {
        const tokenNames: string[] = Object.keys(POOLS)
        config[TEST_CHAINS[SRC_CHAIN]].pools.forEach((pool: any) => {
          const tokenName = tokenNames.find(
            (token: string) => POOLS[token] == pool
          )
          it(`sending to ${tokenName} on ${SRC_CHAIN} from ${SRC_CHAIN}`, async () => {
            const stargateData = {
              ...testStargateData,
              dstChainId: config[TEST_CHAINS[SRC_CHAIN]].layerZeroChainId,
              dstPoolId: pool.id,
            }

            await expect(lifi.quoteLayerZeroFee(stargateData)).to.be.reverted

            await expect(
              lifi.connect(alice).swapAndStartBridgeTokensViaStargate(
                {
                  ...lifiData,
                  destinationChainId: config[TEST_CHAINS[SRC_CHAIN]].chainId,
                },
                swapData,
                stargateData,
                {
                  gasLimit: 1000000,
                  value: utils.parseEther('700').add(utils.parseEther('10')),
                }
              )
            ).to.be.revertedWith('Stargate: local chainPath does not exist')
          })
        })
      })

      it('when the destination chain is invalid', async () => {
        const stargateData = {
          ...testStargateData,
          dstChainId: 99999,
        }

        await expect(lifi.quoteLayerZeroFee(stargateData)).to.be.reverted

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              lifiData,
              swapData,
              stargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('700').add(utils.parseEther('10')),
              }
            )
        ).to.be.reverted
      })

      it('when the destination token is invalid', async () => {
        const stargateData = {
          ...testStargateData,
          dstPoolId: 99999,
        }

        const quoteData = await lifi.quoteLayerZeroFee(stargateData)
        const requiredGasFee = quoteData[0]

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              lifiData,
              swapData,
              stargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('700').add(requiredGasFee),
              }
            )
        ).to.be.revertedWith('Stargate: local chainPath does not exist')
      })

      it('when the fee is low', async () => {
        const stargateData = testStargateData

        const quoteData = await lifi.quoteLayerZeroFee(stargateData)
        const requiredGasFee = quoteData[0]

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              lifiData,
              swapData,
              stargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('700').add(requiredGasFee).sub(1),
              }
            )
        ).to.be.revertedWith('LayerZero: not enough native for fees')
      })

      it('when the receiving amount is less then minimum acceptable amount', async () => {
        const stargateData = {
          ...testStargateData,
          minAmountLD: utils.parseUnits('1000', 6),
        }

        const quoteData = await lifi.quoteLayerZeroFee(stargateData)
        const requiredGasFee = quoteData[0]

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              lifiData,
              swapData,
              stargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('700').add(requiredGasFee).sub(1),
              }
            )
        ).to.be.revertedWith('Stargate: slippage too high')
      })

      it('when the dex is not approved', async () => {
        await dexMgr.removeDex(UNISWAP_ADDRESS)

        const stargateData = testStargateData

        const quoteData = await lifi.quoteLayerZeroFee(stargateData)
        const requiredGasFee = quoteData[0]

        await expect(
          lifi
            .connect(alice)
            .swapAndStartBridgeTokensViaStargate(
              lifiData,
              swapData,
              stargateData,
              {
                gasLimit: 1000000,
                value: utils.parseEther('700').add(requiredGasFee),
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
          Object.values(lifiData),
          [],
          POOLS[SRC_ASSET][TEST_CHAINS[SRC_CHAIN]],
          alice.address,
        ])
        await expect(
          receiver.sgReceive(
            1,
            config[TEST_CHAINS[SRC_CHAIN]].stargateRouter,
            0,
            usdt.address,
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
              lifiData,
              payloadSwapData,
              usdt.address,
              alice.address
            )
        ).to.be.revertedWith('InvalidAmount()')
      })

      it('when token arrived amount is low', async () => {
        const payload = ethers.utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
          Object.values(lifiData),
          payloadSwapData.map((data: any) => Object.values(data)),
          usdt.address,
          alice.address,
        ])

        await expect(
          receiver
            .connect(sgRouter)
            .sgReceive(
              1,
              config[TEST_CHAINS[SRC_CHAIN]].stargateRouter,
              0,
              usdt.address,
              utils.parseUnits('1000', 6),
              payload
            )
        ).to.be.revertedWith('ERC20: transfer amount exceeds balance')
      })
    })

    describe('should be possible to process sgReceive', () => {
      it('should process swapAndCompleteBridgeTokens', async () => {
        const payload = ethers.utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
          Object.values(lifiData),
          payloadSwapData.map((data: any) => Object.values(data)),
          usdt.address,
          alice.address,
        ])
        await usdt.transfer(receiver.address, utils.parseUnits('1000', 6))
        await expect(
          receiver
            .connect(sgRouter)
            .sgReceive(
              1,
              config[TEST_CHAINS[SRC_CHAIN]].stargateRouter,
              0,
              usdt.address,
              utils.parseUnits('1000', 6),
              payload
            )
        ).to.emit(executor, 'LiFiTransferCompleted')
      })

      it('should send to receiver when fails to call swapAndCompleteBridgeTokens', async () => {
        const payload = ethers.utils.defaultAbiCoder.encode(PAYLOAD_ABI, [
          Object.values(lifiData),
          payloadSwapData.map((data: any) => Object.values(data)),
          usdt.address,
          alice.address,
        ])

        await usdt.transfer(receiver.address, utils.parseUnits('100', 6))
        const usdtBalance = await usdt.balanceOf(alice.address)
        await expect(
          receiver
            .connect(sgRouter)
            .sgReceive(
              1,
              config[TEST_CHAINS[SRC_CHAIN]].stargateRouter,
              0,
              usdt.address,
              utils.parseUnits('100', 6),
              payload
            )
        ).to.emit(receiver, 'LiFiTransferCompleted')
        expect(await usdt.balanceOf(alice.address)).to.equal(
          usdtBalance.add(utils.parseUnits('100', 6))
        )
      })
    })
  })
})
