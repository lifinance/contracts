import {
  getContract,
  parseUnits,
  Narrow,
  zeroAddress,
  Abi
} from 'viem'
import { randomBytes } from 'crypto'
import { config } from 'dotenv'
import { ERC20__factory as ERC20 } from '../../typechain/factories/ERC20__factory'
import { EverclearFacet__factory as EverclearFacet } from '../../typechain/factories/EverclearFacet.sol/EverclearFacet__factory'
import { ensureBalance, ensureAllowance, executeTransaction, setupEnvironment, type SupportedChain } from './utils/demoScriptHelpers'
import everclearFacetArtifact from '../../out/EverclearFacet.sol/EverclearFacet.json'

config()

const EVERCLEAR_FACET_ABI = everclearFacetArtifact.abi as Abi

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = "arbitrum"
  const destinationChainId = 10 // Optimism Mainnet

  const { client, publicClient, walletAccount, lifiDiamondAddress, lifiDiamondContract } = await setupEnvironment(srcChain, EVERCLEAR_FACET_ABI)
  const signerAddress = walletAccount.address

  // === Contract addresses ===
  const SRC_TOKEN_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as `0x${string}` // USDC on Arbitrum

  // === Instantiate contracts ===
  const srcTokenContract = getContract({
    address: SRC_TOKEN_ADDRESS,
    abi: ERC20.abi,
    client: publicClient
  })

  const srcTokenName = await srcTokenContract.read.name() as string
  const srcTokenSymbol = await srcTokenContract.read.symbol() as string
  const srcTokenDecimals = await srcTokenContract.read.decimals() as bigint
  const amount = parseUnits('1', Number(srcTokenDecimals)); // 10 * 1e{source token decimals}

  // docs: https://docs.everclear.org/developers/api#post-routes-quotes
  let quoteResp = await fetch(
    `https://api.everclear.org/routes/quotes`,
    { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        "origin": "42161",
        "destinations": [
          "10"
        ],
        "inputAsset": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        "amount": "500000",
        "to": "0x2b2c52B1b63c4BfC7F1A310a1734641D8e34De62"
      })
    }
  )
  let quoteData = await quoteResp.json()

  console.log("quoteData")
  console.log(quoteData)

  console.info(`Bridge ${amount} ${srcTokenName} (${srcTokenSymbol}) from ${srcChain} --> {DESTINATION CHAIN NAME}`)
  console.info(`Connected wallet address: ${signerAddress}`)

  await ensureBalance(srcTokenContract, signerAddress, amount)

  await ensureAllowance(srcTokenContract, signerAddress, lifiDiamondAddress, amount, publicClient)


  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    // Edit fields as needed
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'everclear',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SRC_TOKEN_ADDRESS,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const everclearData: EverclearFacet.EverclearDataStruct = {
    // Add your specific fields for Everclear here.
  }

  // === Start bridging ===
  await executeTransaction(
    () =>
      lifiDiamondContract.write.startBridgeTokensViaEverclear(
        [bridgeData, everclearData],
        // { value: fee } optional value
      ),
    'Starting bridge tokens via Everclear',
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
