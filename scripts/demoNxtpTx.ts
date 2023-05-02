import 'dotenv/config'
import { node_url } from '../utils/network'
import { providers, Wallet, utils, Contract, constants } from 'ethers'
import { NxtpSdk, NxtpSdkEvents } from '@connext/nxtp-sdk'
import { ChainId, Token } from '@uniswap/sdk'
import { NXTPFacet__factory, ERC20__factory } from '../typechain'
import { encodeAuctionBid } from '@connext/nxtp-utils'
import chalk from 'chalk'
import * as deployment from '../export/deployments-staging.json'

const msg = (msg: string) => {
  console.log(chalk.green(msg))
}

const WITH_SWAP = true
const WITH_RECEIVER = false

const LIFI_ADDRESS = deployment[100].xdai.contracts.LiFiDiamond.address
const RINKEBY_DAI_ADDRESS = '0xc7AD46e0b8a400Bb3C915120d284AafbA8fc4735'
const RINKEBY_TOKEN_ADDRESS = '0x9aC2c46d7AcC21c881154D57c0Dc1c55a3139198'
const UNISWAP_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const GOERLI_TOKEN_ADDRESS = '0x8a1Cad3703E0beAe0e0237369B4fcD04228d1682'

async function main() {
  // Get signer
  let wallet = Wallet.fromMnemonic(<string>process.env.MNEMONIC)
  // const provider1 = new providers.JsonRpcProvider('http://127.0.0.1:8545')
  const provider1 = new providers.JsonRpcProvider(node_url('rinkeby'))
  const provider = new providers.FallbackProvider([provider1])
  wallet = wallet.connect(provider)

  const lifi = NXTPFacet__factory.connect(LIFI_ADDRESS, wallet)

  // Uniswap
  const TOKEN = new Token(ChainId.RINKEBY, RINKEBY_TOKEN_ADDRESS, 18)
  const DAI = new Token(ChainId.RINKEBY, RINKEBY_DAI_ADDRESS, 18)

  const amountIn = utils.parseEther('12')
  const amountOut = utils.parseEther('10') // 10 TestToken

  const path = [DAI.address, TOKEN.address]
  const to = LIFI_ADDRESS // should be a checksummed recipient address
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20 // 20 minutes from the current Unix time

  const uniswap = new Contract(
    UNISWAP_ADDRESS,
    [
      'function swapTokensForExactTokens(uint amountOut, uint amountInMax, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)',
    ],
    wallet
  )

  // Set up provider to chain mappings
  const chainConfig = {
    4: {
      provider: new providers.FallbackProvider([
        new providers.JsonRpcProvider(node_url('rinkeby')),
      ]),
    },
    5: {
      provider: new providers.FallbackProvider([
        new providers.JsonRpcProvider(node_url('goerli')),
      ]),
    },
  }

  // Instantiate NXTP SDK
  const sdk = new NxtpSdk({
    chainConfig,
    signer: wallet,
    network: 'testnet',
  })

  // Get quote from Connext
  let quote = await sdk.getTransferQuote({
    sendingAssetId: RINKEBY_TOKEN_ADDRESS,
    sendingChainId: 4,
    receivingAssetId: GOERLI_TOKEN_ADDRESS,
    receivingChainId: 5,
    receivingAddress: await wallet.getAddress(),
    amount: amountOut.toString(),
    expiry: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3, // 3 days
    initiator: lifi.address,
    dryRun: WITH_RECEIVER,
  })

  msg('Quote received from Connext')

  const lifiData = {
    transactionId: quote.bid.transactionId,
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: RINKEBY_TOKEN_ADDRESS,
    receivingAssetId: GOERLI_TOKEN_ADDRESS,
    receiver: await wallet.getAddress(),
    destinationChainId: 5,
    amount: amountOut.toString(),
  }

  if (WITH_RECEIVER) {
    // Generate calldata for receiving chain
    const tmpTx = await lifi.populateTransaction.completeBridgeTokensViaNXTP(
      lifiData,
      GOERLI_TOKEN_ADDRESS,
      await wallet.getAddress(),
      quote.bid.amountReceived
    )

    // Get second quote with the receiving call
    quote = await sdk.getTransferQuote({
      transactionId: quote.bid.transactionId,
      sendingAssetId: RINKEBY_TOKEN_ADDRESS,
      sendingChainId: 4,
      receivingAssetId: GOERLI_TOKEN_ADDRESS,
      receivingChainId: 5,
      receivingAddress: await wallet.getAddress(),
      amount: amountOut.toString(),
      expiry: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3, // 3 days
      initiator: lifi.address,
      callData: tmpTx.data,
      callTo: tmpTx.to,
    })
  }

  const nxtpData = {
    invariantData: {
      ...quote.bid,
      sendingChainFallback: await wallet.getAddress(),
    },
    amount: quote.bid.amount,
    expiry: quote.bid.expiry,
    encodedBid: encodeAuctionBid(quote.bid),
    bidSignature: quote.bidSignature || '',
    encodedMeta: '0x',
    encryptedCallData: quote.bid.encryptedCallData,
    callDataHash: quote.bid.callDataHash,
    callTo: quote.bid.callTo,
  }
  console.log('nxtpData', nxtpData)

  if (WITH_SWAP) {
    // Generate swap calldata
    const swapData = await uniswap.populateTransaction.swapTokensForExactTokens(
      amountOut,
      amountIn,
      path,
      to,
      deadline
    )

    // Approve ERC20 for swapping -- DAI
    const token = ERC20__factory.connect(DAI.address, wallet)
    await token.approve(lifi.address, amountIn)

    msg('Token approved for swapping')

    // Call LiFi smart contract to start the bridge process -- WITH SWAP
    await lifi.swapAndStartBridgeTokensViaNXTP(
      lifiData,
      [
        {
          sendingAssetId: DAI.address,
          receivingAssetId: TOKEN.address,
          fromAmount: amountIn,
          callTo: <string>swapData.to,
          callData: <string>swapData?.data,
        },
      ],
      nxtpData,
      { gasLimit: 500000 }
    )
  } else {
    // Approve ERC20 for swapping -- TEST
    const token = ERC20__factory.connect(TOKEN.address, wallet)
    await token.approve(lifi.address, amountOut)

    // Call LiFi smart contract to start the bridge process -- WITHOUT SWAP
    await lifi.startBridgeTokensViaNXTP(lifiData, nxtpData, {
      gasLimit: 500000,
    })
  }

  msg('Bridge process started on sending chain')

  const prepared = await sdk.waitFor(
    NxtpSdkEvents.ReceiverTransactionPrepared,
    200_000,
    (data) => data.txData.transactionId === quote.bid.transactionId
  )

  msg('Transaction prepared on Connext')

  await sdk.fulfillTransfer(prepared)

  const claimed = await sdk.waitFor(
    NxtpSdkEvents.ReceiverTransactionFulfilled,
    200_000,
    (data) => data.txData.transactionId === quote.bid.transactionId
  )

  console.log('claimed', claimed)
  msg('Bridge completed on receiving chain')
}

main()
  .then(() => {
    console.log('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })
