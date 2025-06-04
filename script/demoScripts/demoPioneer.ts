import { getContract, parseUnits, Narrow, zeroAddress } from 'viem'
import { randomBytes } from 'crypto'
import dotenv from 'dotenv'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import pioneerFacetArtifact from '../../out/PioneerFacet.sol/PioneerFacet.json'
import { PioneerFacet, ILiFi } from '../../typechain'
import { SupportedChain, viemChainMap } from './utils/demoScriptChainConfig'
import {
  ensureBalance,
  ensureAllowance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

dotenv.config()

// #region ABIs

const ERC20_ABI = erc20Artifact.abi as Narrow<typeof erc20Artifact.abi>
const PIONEER_FACET_ABI = pioneerFacetArtifact.abi as Narrow<
  typeof pioneerFacetArtifact.abi
>

// If you need to import a custom ABI, follow these steps:
//
// First, ensure you import the relevant artifact file:
// import exampleArtifact from '../../out/{example artifact json file}'
//
// Then, define the ABI using `Narrow<typeof exampleArtifact.abi>` for proper type inference:
// const EXAMPLE_ABI = exampleArtifact.abi as Narrow<typeof exampleArtifact.abi>
//

// #endregion

dotenv.config()

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum' // Set source chain
  const destinationChainId = 10 // OP Mainnet
  const PIONEER_ENDPOINT = 'https://solver-dev.li.fi' as const

  const {
    client,
    publicClient,
    walletAccount,
    lifiDiamondAddress,
    lifiDiamondContract,
  } = await setupEnvironment(srcChain, PIONEER_FACET_ABI)
  const signerAddress = walletAccount.address

  // === Contract addresses ===
  // Token is native ETH. To change it, please update add a ERC20 balance and allowance check.
  const SRC_TOKEN_ADDRESS =
    '0x0000000000000000000000000000000000000000' as const

  const srcTokenName = 'Ether'
  const srcTokenSymbol = 'ETH'
  const srcTokenDecimals = 18n
  const amount = parseUnits('0.001', Number(srcTokenDecimals)) // 0.01 * 1e{source token decimals}

  console.info(
    `Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> ${destinationChainId}`
  )
  console.info(`Connected wallet address: ${signerAddress}`)

  // Get the user (signerAddress)'s balance of ETH:
  const balance = await client.public.getBalance({
    address: signerAddress,
    blockTag: 'latest',
  })

  if (balance < amount) {
    console.error(
      `Insufficient balance. Required: ${amount}, Available: ${balance}`
    )
    process.exit(1)
  } else {
    console.info(`Balance: ${balance}`)
  }

  // === In this part put necessary logic usually it's fetching quotes, estimating fees, signing messages etc. ===

  const query: {
    fromChainId: string
    fromAsset: string
    fromAmount: string
    toChainId: string
    toAsset: string
    toAddress: string
  } = {
    fromChainId: viemChainMap[srcChain]!.id.toString(),
    fromAsset: SRC_TOKEN_ADDRESS,
    fromAmount: amount.toString(),
    toChainId: destinationChainId.toString(),
    toAsset: SRC_TOKEN_ADDRESS,
    toAddress: signerAddress,
  }
  console.log(query)
  const resp = await fetch(`${PIONEER_ENDPOINT}/quote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(query),
  })
  console.log(resp.body)
  const quote: {
    quoteId: 'string'
    fromChainId: 'string'
    fromAsset: 'string'
    fromAmount: 'string'
    fromAddress: 'string'
    toChainId: 'string'
    toAsset: 'string'
    toAmount: 'string'
    toAddress: 'string'
    expiration: 0
  } = await resp.json()

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    // Edit fields as needed
    transactionId: `0x${quote.quoteId
      .toString()
      .replace(/-/g, '')
      .padEnd(64, '0')}`,
    bridge: 'Pioneer',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }
  console.log(bridgeData)

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaPioneer([bridgeData], {
        value: amount,
      }),
    'Starting bridge tokens via Pioneer',
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
