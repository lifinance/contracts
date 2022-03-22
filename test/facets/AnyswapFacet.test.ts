/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  AnyswapFacet,
  DexManagerFacet,
  ERC20,
  ERC20__factory,
} from '../../typechain'
import { deployments, network } from 'hardhat'
import { constants, utils } from 'ethers'
import { node_url } from '../../utils/network'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers'
import { expect } from '../chai-setup'

const ANYSWAP_ROUTER = '0x4f3aff3a747fcade12598081e80c6605a8be192f'
const USDT_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
const WMATIC_ADDRESS = '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270'
const anyUSDT_ADDRESS = '0xE3eeDa11f06a656FcAee19de663E84C7e61d3Cac'
const UNISWAP_ADDRESS = '0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff'

describe('AnyswapFacet', function () {
  let lifi: AnyswapFacet
  let dexMgr: DexManagerFacet
  let alice: SignerWithAddress
  let lifiData: any
  let token: ERC20
  let usdt: ERC20
  let wmatic: ERC20

  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      await deployments.fixture('DeployAnyswapFacet')
      const diamond = await ethers.getContract('LiFiDiamond')
      lifi = <AnyswapFacet>(
        await ethers.getContractAt('AnyswapFacet', diamond.address)
      )
      dexMgr = <DexManagerFacet>(
        await ethers.getContractAt('DexManagerFacet', diamond.address)
      )
      await dexMgr.addDex(UNISWAP_ADDRESS)

      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: ['0x6722846282868a9c084b423aee79eb8ff69fc497'],
      })

      alice = await ethers.getSigner(
        '0x6722846282868a9c084b423aee79eb8ff69fc497'
      )

      wmatic = ERC20__factory.connect(WMATIC_ADDRESS, alice)

      usdt = ERC20__factory.connect(USDT_ADDRESS, alice)
      lifiData = {
        transactionId: utils.randomBytes(32),
        integrator: 'ACME Devs',
        referrer: constants.AddressZero,
        sendingAssetId: usdt.address,
        receivingAssetId: usdt.address,
        receiver: alice.address,
        destinationChainId: 100,
        amount: utils.parseUnits('1000', 6),
      }
      token = ERC20__factory.connect(anyUSDT_ADDRESS, alice)
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
            blockNumber: 25689963,
          },
        },
      ],
    })
  })

  beforeEach(async () => {
    await setupTest()
  })

  it('starts a bridge transaction on the sending chain', async () => {
    const AnyswapData = {
      token: token.address,
      router: ANYSWAP_ROUTER,
      amount: utils.parseUnits('1000', 6),
      recipient: alice.address,
      toChainId: 100,
    }

    await lifi
      .connect(alice)
      .startBridgeTokensViaAnyswap(lifiData, AnyswapData, {
        gasLimit: 500000,
      })
  })

  it('performs a swap then starts bridge transaction on the sending chain', async () => {
    const to = lifi.address // should be a checksummed recipient address
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

    const iface = new utils.Interface([
      'function swapETHForExactTokens(uint,address[],address,uint256)',
    ])

    // Generate swap calldata
    const uniswapData = iface.encodeFunctionData('swapETHForExactTokens', [
      utils.parseUnits('1000', 6),
      [wmatic.address, usdt.address],
      to,
      deadline,
    ])

    const swapData = [
      {
        callTo: UNISWAP_ADDRESS,
        approveTo: UNISWAP_ADDRESS,
        sendingAssetId: '0x0000000000000000000000000000000000000000',
        receivingAssetId: usdt.address,
        fromAmount: utils.parseEther('700'),
        callData: uniswapData,
      },
    ]

    const AnyswapData = {
      token: token.address,
      router: ANYSWAP_ROUTER,
      amount: utils.parseUnits('1000', 6),
      recipient: alice.address,
      toChainId: 137,
    }

    await lifi
      .connect(alice)
      .swapAndStartBridgeTokensViaAnyswap(lifiData, swapData, AnyswapData, {
        gasLimit: 500000,
        value: utils.parseEther('700'),
      })
  })

  it('fails to perform a swap when the dex is not approved', async () => {
    await dexMgr.removeDex(UNISWAP_ADDRESS)
    const to = lifi.address // should be a checksummed recipient address
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

    const iface = new utils.Interface([
      'function swapETHForExactTokens(uint,address[],address,uint256)',
    ])

    // Generate swap calldata
    const uniswapData = iface.encodeFunctionData('swapETHForExactTokens', [
      utils.parseUnits('1000', 6),
      [wmatic.address, usdt.address],
      to,
      deadline,
    ])

    const swapData = [
      {
        callTo: UNISWAP_ADDRESS,
        approveTo: UNISWAP_ADDRESS,
        sendingAssetId: '0x0000000000000000000000000000000000000000',
        receivingAssetId: usdt.address,
        fromAmount: utils.parseEther('700'),
        callData: uniswapData,
      },
    ]

    const AnyswapData = {
      token: token.address,
      router: ANYSWAP_ROUTER,
      amount: utils.parseUnits('1000', 6),
      recipient: alice.address,
      toChainId: 137,
    }

    await expect(
      lifi
        .connect(alice)
        .swapAndStartBridgeTokensViaAnyswap(lifiData, swapData, AnyswapData, {
          gasLimit: 500000,
          value: utils.parseEther('700'),
        })
    ).to.be.revertedWith('Contract call not allowed!')
  })
})
