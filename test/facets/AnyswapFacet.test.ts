import { AnyswapFacet, ERC20__factory } from '../../typechain'
import { deployments, network } from 'hardhat'
import { constants, utils } from 'ethers'
import {
  uniswapRouterBytecode,
  uniswapFactoryBytecode,
  wethBytecode,
  uniswapRouterAbi,
  uniswapFactoryAbi,
  wethAbi,
} from '../../test/fixtures/uniswap'
import { node_url } from '../../utils/network'

const ANYSWAP_ROUTER = '0x4f3aff3a747fcade12598081e80c6605a8be192f'
const USDT_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
const WETH_ADDRESS = '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619'
const anyUSDT_ADDRESS = '0xE3eeDa11f06a656FcAee19de663E84C7e61d3Cac'

describe('AnyswapFacet', function () {
  let lifi: AnyswapFacet
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let alice: any
  let lifiData: any
  let token: any
  let usdt: any
  let uniswap: any
  let weth: any
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      await deployments.fixture('DeployAnyswapFacet')
      const diamond = await ethers.getContract('LiFiDiamond')
      lifi = <AnyswapFacet>(
        await ethers.getContractAt('AnyswapFacet', diamond.address)
      )

      await network.provider.request({
        method: 'hardhat_impersonateAccount',
        params: ['0x6722846282868a9c084b423aee79eb8ff69fc497'],
      })

      alice = await ethers.getSigner(
        '0x6722846282868a9c084b423aee79eb8ff69fc497'
      )

      const UniswapFactory = new ethers.ContractFactory(
        uniswapFactoryAbi,
        uniswapFactoryBytecode,
        alice
      )
      const uniswapFactory = await UniswapFactory.deploy(
        '0x0000000000000000000000000000000000000000'
      )
      weth = ERC20__factory.connect(WETH_ADDRESS, alice)
      const UniswapV2Router02 = new ethers.ContractFactory(
        uniswapRouterAbi,
        uniswapRouterBytecode,
        alice
      )
      uniswap = await UniswapV2Router02.deploy(
        uniswapFactory.address,
        weth.address
      )

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

    await usdt.approve(uniswap.address, utils.parseUnits('2000', 6))

    await uniswap.addLiquidityETH(
      usdt.address,
      utils.parseUnits('2000', 6),
      0,
      0,
      alice.address,
      deadline,
      {
        value: utils.parseEther('0.01'),
      }
    )

    const iface = new utils.Interface([
      'function swapETHForExactTokens(uint,address[],address,uint256)',
    ])

    // Generate swap calldata
    const uniswapData = iface.encodeFunctionData('swapETHForExactTokens', [
      utils.parseUnits('1000', 6),
      [weth.address, usdt.address],
      to,
      deadline,
    ])

    const swapData = [
      {
        callTo: uniswap.address,
        approveTo: uniswap.address,
        sendingAssetId: '0x0000000000000000000000000000000000000000',
        receivingAssetId: usdt.address,
        fromAmount: utils.parseEther('0.02'),
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
        value: utils.parseEther('0.02'),
      })
  })
})
