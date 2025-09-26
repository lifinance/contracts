import { randomBytes } from 'crypto'

import { config } from 'dotenv'
import { parseUnits, zeroAddress, type Narrow } from 'viem'

import pioneerFacetArtifact from '../../out/PioneerFacet.sol/PioneerFacet.json'
import type { ILiFi, PioneerFacet } from '../../typechain'
import type { SupportedChain } from '../common/types'

import { executeTransaction, setupEnvironment } from './utils/demoScriptHelpers'

config()

// The following transactions show a successful transaction from Arbitrum to Optimism
// https://arbiscan.io/tx/0x347fd537add54bd1cedf1f719d36f19cefa130a2f3a084db0c2379c409f80248
// https://optimistic.etherscan.io/tx/0xb2f77e53c1f1df8c449372e4e835736813e577d5de8ce9f1318a079a176314b7

// #region ABIs

const PIONEER_FACET_ABI = pioneerFacetArtifact.abi as Narrow<
  typeof pioneerFacetArtifact.abi
>

// #endregion

async function main() {
  // === Set up environment ===
  const srcChain: SupportedChain = 'arbitrum' // Set source chain
  const destinationChainId = 10 // OP Mainnet
  const PIONEER_ENDPOINT = 'https://solver-dev.li.fi' as const

  const { client, publicClient, walletAccount, lifiDiamondContract, chain } =
    await setupEnvironment(srcChain, PIONEER_FACET_ABI)
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
  } else console.info(`Balance: ${balance}`)

  // === In this part put necessary logic usually it's fetching quotes, estimating fees, signing messages etc. ===
  const transactionId = `0x${randomBytes(32).toString('hex')}`

  const query: {
    fromChain: string
    toChain: string
    fromToken: string
    toToken: string
    toAddress: string
    fromAmount: string
    slippage: string
    externalId: string
  } = {
    fromChain: chain.id.toString(),
    toChain: destinationChainId.toString(),
    fromToken: SRC_TOKEN_ADDRESS,
    toToken: SRC_TOKEN_ADDRESS,
    toAddress: signerAddress,
    fromAmount: amount.toString(),
    slippage: 0n.toString(),
    externalId: transactionId,
  }
  const queryParams = new URLSearchParams(
    query as Record<string, string>
  ).toString()
  console.log(query, `${PIONEER_ENDPOINT}/quote?${queryParams}`)

  const resp = await fetch(`${PIONEER_ENDPOINT}/quote?${queryParams}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
    },
  })
  if (!resp.ok) {
    console.error(`Quote request failed: ${resp.status} ${resp.statusText}`)
    process.exit(1)
  }
  const quote: {
    quoteId: 'string'
    fromChainId: 'string'
    fromToken: 'string'
    fromAmount: 'string'
    fromAddress: 'string'
    toChainId: 'string'
    toToken: 'string'
    toAmount: 'string'
    toAmountMin: 'string'
    executionDuration: 0
    toAddress: 'string'
    deadline: 0
    feeCosts: [
      {
        name: 'string'
        description: 'string'
        chainId: 'string'
        tokenAddress: 'string'
        amount: 'string'
        included: true
      }
    ]
  } = await resp.json()
  console.log(quote)

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    // Edit fields as needed
    transactionId,
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

  const pioneerData: PioneerFacet.PioneerDataStruct = {
    refundAddress: signerAddress,
  }

  console.log(bridgeData, pioneerData)

  // === Start bridging ===
  if (!lifiDiamondContract) throw new Error('LiFi Diamond contract not found')

  await executeTransaction(
    () =>
      (lifiDiamondContract as any).write.startBridgeTokensViaPioneer(
        [bridgeData, pioneerData],
        {
          value: amount,
        }
      ),
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
