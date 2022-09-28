import {
  IERC20__factory as ERC20__factory,
  CBridgeFacet,
  DexManagerFacet,
} from '../../typechain'
// import { expect } from '../chai-setup'
import { deployments, ethers, network } from 'hardhat'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signers'
import { constants, Contract, utils } from 'ethers'
import { node_url } from '../../utils/network'
import { expect } from '../chai-setup'
import approvedFunctionSelectors from '../../utils/approvedFunctions'

const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const DAI_ADDRESS = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const UNISWAP_ADDRESS = '0xE592427A0AEce92De3Edee1F18E0157C05861564'

describe('CBridgeFacet', function () {
  let alice: SignerWithAddress
  let lifi: CBridgeFacet
  let dexMgr: DexManagerFacet
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let owner: any
  let bridgeData: any
  let CBridgeData: any
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const setupTest = deployments.createFixture(
    async ({ deployments, ethers }) => {
      await deployments.fixture('DeployCBridgeFacet')

      owner = await ethers.getSigners()
      owner = owner[0]
      const diamond = await ethers.getContract('LiFiDiamond')
      lifi = <CBridgeFacet>(
        await ethers.getContractAt('CBridgeFacet', diamond.address)
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

      alice = await ethers.getSigner(
        '0x47ac0fb4f2d84898e4d9e7b4dab3c24507a6d503'
      )

      CBridgeData = {
        nonce: 1,
        maxSlippage: 5000,
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
            jsonRpcUrl: node_url('mainnet'),
            blockNumber: 13798171,
          },
        },
      ],
    })
  })

  beforeEach(async function () {
    this.timeout(0)
    await setupTest()
  })

  it('starts a bridge transaction on the sending chain', async function () {
    // Approve ERC20 for swapping
    const token = await ERC20__factory.connect(DAI_ADDRESS, alice)
    await token.approve(lifi.address, utils.parseUnits('100000', 10))
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'cbridge',
      integrator: 'ACME Devs',
      referrer: ethers.constants.AddressZero,
      sendingAssetId: DAI_ADDRESS,
      receiver: alice.address,
      minAmount: utils.parseUnits('100000', 10),
      destinationChainId: 137,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    await expect(
      lifi.connect(alice).startBridgeTokensViaCBridge(bridgeData, CBridgeData, {
        gasLimit: 500000,
      })
    ).to.emit(lifi, 'LiFiTransferStarted')
  })

  it('fails to start a native token bridge transaction without msg.value', async function () {
    const CBridgeDataNative = {
      nonce: 1,
      maxSlippage: 5000,
    }

    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'cbridge',
      integrator: 'ACME Devs',
      referrer: ethers.constants.AddressZero,
      sendingAssetId: constants.AddressZero,
      receiver: alice.address,
      minAmount: utils.parseUnits('1', 18),
      destinationChainId: 137,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    await expect(
      lifi
        .connect(alice)
        .startBridgeTokensViaCBridge(bridgeData, CBridgeDataNative, {
          gasLimit: 500000,
        })
    ).to.be.revertedWith('InvalidAmount()')
  })

  it('fails to start a native token bridge transaction with no enough msg.value', async function () {
    const CBridgeDataNative = {
      nonce: 1,
      maxSlippage: 5000,
    }

    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'cbridge',
      integrator: 'ACME Devs',
      referrer: ethers.constants.AddressZero,
      sendingAssetId: constants.AddressZero,
      receiver: alice.address,
      minAmount: utils.parseUnits('0.0001', 18),
      destinationChainId: 137,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    await expect(
      lifi
        .connect(alice)
        .startBridgeTokensViaCBridge(bridgeData, CBridgeDataNative, {
          gasLimit: 500000,
          value: utils.parseUnits('0.00001', 18),
        })
    ).to.be.revertedWith('InvalidAmount()')
  })

  it('starts a native token bridge transaction on the sending chain', async function () {
    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'cbridge',
      integrator: 'ACME Devs',
      referrer: ethers.constants.AddressZero,
      sendingAssetId: constants.AddressZero,
      receiver: alice.address,
      minAmount: utils.parseUnits('0.01', 18),
      destinationChainId: 137,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const CBridgeDataNative = {
      nonce: 1,
      maxSlippage: 5000,
    }
    await expect(
      lifi
        .connect(alice)
        .startBridgeTokensViaCBridge(bridgeData, CBridgeDataNative, {
          gasLimit: 500000,
          value: bridgeData.minAmount,
        })
    ).to.emit(lifi, 'LiFiTransferStarted')
  })

  it('performs a swap then starts bridge transaction on the sending chain', async function () {
    const amountIn = utils.parseUnits('1020', 6)
    const amountOut = utils.parseUnits('1000', 6) // 1 TestToken

    const to = lifi.address // should be a checksummed recipient address
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

    const uniswap = new Contract(
      UNISWAP_ADDRESS,
      [
        'function exactOutputSingle(tuple(address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)',
      ],
      alice
    )

    // Generate swap calldata
    const swapData = await uniswap.populateTransaction.exactOutputSingle([
      USDC_ADDRESS,
      DAI_ADDRESS,
      3000,
      to,
      deadline,
      amountOut,
      amountIn,
      0,
    ])

    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'cbridge',
      integrator: 'ACME Devs',
      referrer: ethers.constants.AddressZero,
      sendingAssetId: DAI_ADDRESS,
      receiver: alice.address,
      minAmount: utils.parseUnits('1000', 6),
      destinationChainId: 137,
      hasSourceSwaps: true,
      hasDestinationCall: false,
    }

    CBridgeData = {
      nonce: 1,
      maxSlippage: 5000,
    }

    // Approve ERC20 for swapping
    const token = ERC20__factory.connect(USDC_ADDRESS, alice)
    await token.approve(lifi.address, amountIn)

    await expect(
      lifi.connect(alice).swapAndStartBridgeTokensViaCBridge(
        bridgeData,
        [
          {
            callTo: <string>swapData.to,
            approveTo: <string>swapData.to,
            sendingAssetId: USDC_ADDRESS,
            receivingAssetId: DAI_ADDRESS,
            callData: <string>swapData?.data,
            fromAmount: amountIn,
            requiresDeposit: true,
          },
        ],
        CBridgeData,
        { gasLimit: 500000 }
      )
    )
      .to.emit(lifi, 'AssetSwapped')
      .and.to.emit(lifi, 'LiFiTransferStarted')
  })

  it('fails to perform a swap if the dex is not approved', async function () {
    await dexMgr.removeDex(UNISWAP_ADDRESS)

    const amountIn = utils.parseUnits('1020', 6)
    const amountOut = utils.parseUnits('1000', 6) // 1 TestToken

    const to = lifi.address // should be a checksummed recipient address
    const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

    const uniswap = new Contract(
      UNISWAP_ADDRESS,
      [
        'function exactOutputSingle(tuple(address,address,uint24,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)',
      ],
      alice
    )

    const bridgeData = {
      transactionId: utils.randomBytes(32),
      bridge: 'cbridge',
      integrator: 'ACME Devs',
      referrer: ethers.constants.AddressZero,
      sendingAssetId: DAI_ADDRESS,
      receiver: alice.address,
      minAmount: utils.parseUnits('1000', 6),
      destinationChainId: 137,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    // Generate swap calldata
    const swapData = await uniswap.populateTransaction.exactOutputSingle([
      USDC_ADDRESS,
      DAI_ADDRESS,
      3000,
      to,
      deadline,
      amountOut,
      amountIn,
      0,
    ])

    CBridgeData = {
      receiver: alice.address,
      assetId: DAI_ADDRESS,
      amount: utils.parseUnits('1000', 6),
      dstChainId: 137,
      nonce: 1,
      maxSlippage: 5000,
    }

    // Approve ERC20 for swapping
    const token = ERC20__factory.connect(USDC_ADDRESS, alice)
    await token.approve(lifi.address, amountIn)

    await expect(
      lifi.connect(alice).swapAndStartBridgeTokensViaCBridge(
        bridgeData,
        [
          {
            callTo: <string>swapData.to,
            approveTo: <string>swapData.to,
            sendingAssetId: USDC_ADDRESS,
            receivingAssetId: DAI_ADDRESS,
            callData: <string>swapData?.data,
            fromAmount: amountIn,
            requiresDeposit: true,
          },
        ],
        CBridgeData,
        { gasLimit: 500000 }
      )
    ).to.be.revertedWith('ContractCallNotAllowed()')
  })
})
