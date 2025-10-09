import { randomBytes } from 'crypto'

import { config } from 'dotenv'
import {
  encodePacked,
  getContract,
  type Narrow,
  parseUnits,
  zeroAddress,
} from 'viem'

import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import LIFIIntentFacetArtifact from '../../out/LiFiIntentEscrowFacet.sol/LiFiIntentEscrowFacet.json'
import type { ILiFi, LiFiIntentEscrowFacet } from '../../typechain'
import type { SupportedChain } from '../common/types'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

import {
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

// #region ABIs

const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const LIFIIntent_FACET_ABI = LIFIIntentFacetArtifact.abi as Narrow<
  typeof LIFIIntentFacetArtifact.abi
>
function padEven(s: string, minimal = 2, pad = '0') {
  return s.padStart(((Math.max(s.length + 1, minimal) / 2) | 0) * 2, pad)
}

function toHex(num: number | bigint, bytes = 1) {
  return padEven(num.toString(16), bytes * 2)
}

export const getInteropableAddress = (
  address: `0x${string}`,
  chainId: number | bigint
) => {
  const version = '0001' // 1
  const chainType = '0000' // EVM

  const chainReference = padEven(chainId.toString(16))
  const chainReferenceLength = toHex(chainReference.length / 2)

  const interopableAddress = `0x${version}${chainType}${chainReferenceLength}${chainReference}${toHex(
    address.replace('0x', '').length / 2
  )}${address.replace('0x', '')}`

  return interopableAddress
}

const LIFI_INTENT_ORDER_SERVER = 'https://order.li.fi'

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'base' // Set source chain
  const destinationChainId: SupportedChain = 'arbitrum' // Set destination chain id

  const {
    client,
    publicClient,
    walletAccount,
    lifiDiamondAddress,
    lifiDiamondContract,
  } = await setupEnvironment(srcChain, LIFIIntent_FACET_ABI)
  const signerAddress = walletAccount.address

  if (
    !lifiDiamondAddress ||
    !lifiDiamondContract ||
    !lifiDiamondContract.write ||
    !lifiDiamondContract.write.startBridgeTokensViaLiFiIntentEscrow
  ) {
    console.error(
      'LiFiDiamond deployment not found for the selected chain/environment.'
    )
    process.exit(1)
  }

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS =
    '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}` // USDC on Base
  const DST_TOKEN_ADDRESS =
    '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as `0x${string}` // USDC on Arbitrum

  // === Instantiate contracts ===
  const srcTokenContract = getContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20_ABI,
    client,
  })

  if (
    !srcTokenContract ||
    !srcTokenContract.read ||
    !srcTokenContract.read.name ||
    !srcTokenContract.read.symbol ||
    !srcTokenContract.read.decimals
  ) {
    console.error('Could not get source token contract.')
    process.exit(1)
  }

  const srcTokenName = (await srcTokenContract.read.name()) as string
  const srcTokenSymbol = (await srcTokenContract.read.symbol()) as string
  const srcTokenDecimals = (await srcTokenContract.read.decimals()) as bigint
  const amount = parseUnits('0.2', Number(srcTokenDecimals)) // 0.2 * 1e{source token decimals}

  console.info(
    `Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> ${destinationChainId}`
  )
  console.info(`Connected wallet address: ${signerAddress}`)

  await ensureBalance(srcTokenContract, signerAddress, amount)

  await ensureAllowance(
    srcTokenContract,
    signerAddress,
    lifiDiamondAddress,
    amount,
    publicClient
  )

  // === Fetch a quote ===

  const SRC_TOKEN_INTEROPABLE_ADDRESS = getInteropableAddress(
    SRC_TOKEN_ADDRESS,
    getViemChainForNetworkName(srcChain).id
  )
  const DST_TOKEN_INTEROPABLE_ADDRESS = getInteropableAddress(
    DST_TOKEN_ADDRESS,
    getViemChainForNetworkName(destinationChainId).id
  )

  const sourceUserAccount = getInteropableAddress(
    signerAddress,
    getViemChainForNetworkName(srcChain).id
  )
  const destinationUserAccount = getInteropableAddress(
    signerAddress,
    getViemChainForNetworkName(destinationChainId).id
  )

  const currentTime = Math.floor(Date.now() / 1000)
  const ONE_MINUTE = 60

  const quoteRequest = {
    user: destinationUserAccount,
    intent: {
      intentType: 'oif-swap',
      inputs: [
        {
          user: sourceUserAccount,
          asset: SRC_TOKEN_INTEROPABLE_ADDRESS,
          amount: amount,
        },
      ],
      outputs: [
        {
          receiver: getInteropableAddress(
            signerAddress,
            getViemChainForNetworkName(destinationChainId).id
          ),
          asset: DST_TOKEN_INTEROPABLE_ADDRESS,
          amount: 0, // Repesents: Send us your best quote.
        },
      ],
      swapType: 'exact-input', // Only exact input is currently supported
      minValidUntil: currentTime + ONE_MINUTE / 2, // The quote should be valid for at least 30 seconds. (can be configured but solvers may be excluded.)
    },
    supportedTypes: ['oif-escrow-v0'],
  }

  // https://order.li.fi
  const response = await fetch(`${LIFI_INTENT_ORDER_SERVER}/quote/request`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(quoteRequest),
  })
  const quote: {
    quotes: {
      order: null
      eta: null
      validUntil: null
      quoteId: `quote_${string}`
      preview: {
        inputs: [
          {
            user: `0x${string}`
            asset: `0x${string}`
            amount: string
          }
        ]
        outputs: [
          {
            receiver: `0x${string}`
            asset: `0x${string}`
            amount: string
          }
        ]
      }
      metadata: {
        exclusiveFor: `0x${string}`
      }
      provider: null
      partialFill: false
      failureHandling: 'refund-automatic'
    }[]
  } = await response.json()

  // Check that we got at least 1 quote.
  if (!quote.quotes || !quote.quotes[0]) {
    console.error('No quotes received.')
    process.exit(1)
  }

  const selectedQuote = quote.quotes[0]
  const outputAmount = BigInt(selectedQuote.preview.outputs[0].amount)
  console.info(
    `Received ${quote.quotes.length} quotes, using the first one with id: ${selectedQuote.quoteId}`
  )
  console.info(
    `Preview: Send ${selectedQuote.preview.inputs[0].amount} of ${selectedQuote.preview.inputs[0].asset} to receive ${outputAmount} of ${selectedQuote.preview.outputs[0].asset}`
  )

  // Check whether an exclusiveFor field is present. If it is, we need to set them as a temporary solver.
  let swapContext: `0x${string}` = '0x'
  if (selectedQuote.metadata.exclusiveFor) {
    const solverAddress = selectedQuote.metadata.exclusiveFor
    console.info(
      `The selected quote is exclusive for ${solverAddress}, setting them as a temporary solver.`
    )
    const paddedExclusiveFor: `0x${string}` = `0x${solverAddress
      .replace('0x', '')
      .padStart(64, '0')}`
    swapContext = encodePacked(
      ['bytes1', 'bytes32', 'uint32'],
      ['0xe0', paddedExclusiveFor, currentTime + ONE_MINUTE]
    )
  }

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    // Edit fields as needed
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'LIFIIntent',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const LIFIIntentData: LiFiIntentEscrowFacet.LiFiIntentEscrowDataStruct = {
    /// And calldata.
    receiverAddress: '0x' + signerAddress.replace('0x', '').padStart(64, '0'),
    depositAndRefundAddress: signerAddress,
    nonce: Math.round(Math.random() * Number.MAX_SAFE_INTEGER),
    expires: currentTime + ONE_MINUTE * 60 * 24 * 2, // A solver has 2 days to fill the intent but it also means that users funds are locked for 2 days if not filled.
    // LIFIIntent Witness //
    fillDeadline: currentTime + ONE_MINUTE * 60 * 2, // Solvers have 2 hours to fill the intent once it has been posted on-chain.
    inputOracle: '0x0000006ea400569c0040d6e5ba651c00848409be', // Polymer oracle on mainnet.
    // LIFIIntent Output //
    outputOracle: '0x0000006ea400569c0040d6e5ba651c00848409be', // Polymer oracle on mainnet.
    outputSettler: '0x00000000D7278408CE7a490015577c41e57143a5',
    outputToken: '0x' + DST_TOKEN_ADDRESS.replace('0x', '').padStart(64, '0'),
    outputAmount: outputAmount,
    outputCall: '0x', // If there is any output call, it should  be provided here.
    outputContext: swapContext,
  }

  // === Start bridging ===
  await executeTransaction(
    () => {
      if (!lifiDiamondContract.write.startBridgeTokensViaLiFiIntentEscrow) {
        console.error(
          'LiFiDiamond deployment not found for the selected chain/environment.'
        )
        process.exit(1)
      }
      const tx = lifiDiamondContract.write.startBridgeTokensViaLiFiIntentEscrow(
        [bridgeData, LIFIIntentData]
        // { value: fee } optional value
      )
      return tx
    },
    'Starting bridge tokens via LIFIIntent',
    publicClient,
    true
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
