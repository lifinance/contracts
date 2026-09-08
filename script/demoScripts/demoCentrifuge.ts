/**
 * Demo: bridges a Centrifuge share token through `CentrifugeFacet` on the LI.FI Diamond,
 * against the real Centrifuge `TokenBridge` (EXSC-828).
 *
 * Prerequisites, all checked at runtime with an actionable error:
 *   1. `CentrifugeFacet` is registered on the Diamond for `SRC_CHAIN` — the facet has to be
 *      deployed and listed in `script/deploy/_targetState.json` first.
 *   2. The signer holds `BRIDGE_AMOUNT_HUMAN` of the share token. deJAAA can simply be bought
 *      for USDC on Base (Aerodrome Slipstream), which is the cheapest way to fund a run and
 *      why this demo defaults to the Base leg. Buying is a plain transfer, so the token's
 *      hook permits it; minting through the ERC-7540 vault instead would require the pool's
 *      memberlist and settle only on an epoch close. deJTRSY has no pool anywhere, so
 *      running this against deJTRSY means sourcing it from an existing holder.
 *   3. The signer holds native for the messaging fee and gas. The fee comes from Centrifuge's
 *      bridge quote API, the same source the backend integration reads it from.
 *
 * Run:  bunx tsx script/demoScripts/demoCentrifuge.ts
 */
import { randomBytes } from 'crypto'

import { consola } from 'consola'
import { config as dotenvConfig } from 'dotenv'
import {
  formatEther,
  formatUnits,
  getAbiItem,
  getAddress,
  parseAbi,
  parseUnits,
  toFunctionSelector,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

import centrifugeConfig from '../../config/centrifuge.json'
import centrifugeFacetArtifact from '../../out/CentrifugeFacet.sol/CentrifugeFacet.json'
import erc20Artifact from '../../out/ERC20/ERC20.sol/ERC20.json'
import type { CentrifugeFacet, ILiFi } from '../../typechain'
import type { SupportedChain } from '../common/types'
import { fetchWithTimeout } from '../utils/fetchWithTimeout'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

import {
  createContractObject,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getConfigElement,
  setupEnvironment,
} from './utils/demoScriptHelpers'

dotenvConfig()

const ERC20_ABI = erc20Artifact.abi as Abi
const CENTRIFUGE_FACET_ABI = centrifugeFacetArtifact.abi as Abi

const DIAMOND_LOUPE_ABI = parseAbi([
  'function facetAddress(bytes4 functionSelector) view returns (address)',
])

const TOKEN_BRIDGE_ABI = parseAbi([
  'function chainIdToCentrifugeId(uint256 evmChainId) view returns (uint16)',
])

// The only two Centrifuge share tokens bridgeable through this facet today: the ones registered
// on the Spoke of both supported chains whose hook is `FreelyTransferable`, which gates issuance
// and redemption on the pool's memberlist but leaves plain transfers open - so the Diamond may
// hold them mid-flight without being whitelisted. Every other share token the Spoke knows about
// restricts transfers too and would revert in its hook before Centrifuge is reached. Both are
// deployed at the same address on Ethereum and Base.
const SHARE_TOKENS = {
  deJAAA: getAddress('0xAAA0008C8CF3A7Dca931adaF04336A5D808C82Cc'),
  deJTRSY: getAddress('0xA6233014B9b7aaa74f38fa1977ffC7A89642dC72'),
} as const

// @DEV: switch the corridor and the asset here. Only Ethereum <-> Base is mapped by the bridge,
// and both directions are single-leg because the pool hub for these tokens sits on Ethereum.
const SRC_CHAIN: SupportedChain = 'base'
const DST_CHAIN: SupportedChain = 'mainnet'
const SHARE_TOKEN: Address = SHARE_TOKENS.deJAAA

// Centrifuge share tokens are fund shares, so one unit already carries real value.
const BRIDGE_AMOUNT_HUMAN = '1'

// Centrifuge's public quoting endpoint, the same one the backend integration reads the fee
// from. Documented at https://docs.centrifuge.io/developer/centrifuge-api/#bridge-rest-api.
const CENTRIFUGE_QUOTE_URL = 'https://api.centrifuge.io/bridge/quote'

// The quote is a single number rather than a bracket, so the Gateway may charge exactly what is
// sent. Paying a deliberate margin over it guarantees there is a surplus to refund, which is
// what the money-flow check at the end asserts; without it an exact fee would report a failure
// on a bridge that had succeeded and invite a retry of a completed transfer.
const FEE_SURPLUS_PERCENT = 25n

// The quote's gas estimate is for calling the TokenBridge directly. Routing through the Diamond
// adds facet overhead on top, so the balance check reserves a multiple of it.
const DIAMOND_GAS_OVERHEAD_FACTOR = 3n

interface ICentrifugeQuote {
  parameters?: {
    contractAddress?: string
    functionName?: string
    value?: string
  }
  estimate?: {
    gasEstimate?: number
  }
}

/**
 * Reads the messaging fee for this exact transfer from Centrifuge's bridge quote API.
 *
 * Centrifuge publishes no on-chain fee quote and an underpaid transfer reverts with the
 * Gateway's `NotEnoughGas()`, so the fee has to come from off-chain. This is the same source
 * the backend integration uses, which is why the demo reads it here rather than probing.
 *
 * The quote is only meaningful if it describes the call this facet actually makes, so the
 * contract and function it names are checked against the configured `TokenBridge` before the
 * fee is trusted - the API also advertises routes (Arbitrum, Avalanche and others) that the
 * deployed `TokenBridge` rejects with `InvalidChainId()`.
 *
 * @param params - the transfer to quote: source and destination chain ids, token, amount and receiver
 * @param tokenBridgeAddress - the bridge this facet calls, which the quote has to agree with
 * @returns the fee in wei and the API's gas estimate for the direct bridge call
 * @throws when the API is unreachable, returns a malformed quote, or quotes a different contract
 */
async function fetchCentrifugeQuote(
  params: {
    fromChainId: number
    toChainId: number
    token: Address
    amount: bigint
    receiver: Address
  },
  tokenBridgeAddress: Address
): Promise<{ nativeFee: bigint; gasEstimate: bigint }> {
  const query = new URLSearchParams({
    fromChain: String(params.fromChainId),
    toChain: String(params.toChainId),
    fromToken: params.token,
    fromAmount: params.amount.toString(),
    toAddress: params.receiver,
  })

  const response = await fetchWithTimeout(`${CENTRIFUGE_QUOTE_URL}?${query}`)
  if (!response.ok)
    throw new Error(
      `Centrifuge quote API returned ${response.status} ${
        response.statusText
      } for ${SRC_CHAIN} -> ${DST_CHAIN}: ${await response.text()}`
    )

  const quote = (await response.json()) as ICentrifugeQuote

  const quotedContract = quote.parameters?.contractAddress
  if (
    !quotedContract ||
    getAddress(quotedContract) !== getAddress(tokenBridgeAddress)
  )
    throw new Error(
      `The quote is for ${
        quotedContract ?? 'no contract'
      }, not the TokenBridge this facet calls (${tokenBridgeAddress}). Either config/centrifuge.json is stale or Centrifuge moved the route to a different contract - do not pay a fee quoted for a call we are not making.`
    )
  if (quote.parameters?.functionName !== 'send')
    throw new Error(
      `The quote describes '${quote.parameters?.functionName}', but this facet calls 'send'`
    )

  const value = quote.parameters?.value
  if (!value || BigInt(value) <= 0n)
    throw new Error(`The quote carried no messaging fee: value=${value}`)

  return {
    nativeFee: BigInt(value),
    gasEstimate: BigInt(quote.estimate?.gasEstimate ?? 0),
  }
}

async function main(): Promise<void> {
  // === Set up environment ===
  const { publicClient, walletClient, walletAccount, lifiDiamondAddress } =
    await setupEnvironment(SRC_CHAIN, CENTRIFUGE_FACET_ABI)
  const signerAddress = walletAccount.address

  if (!lifiDiamondAddress) throw new Error('LiFi Diamond address is required')

  const destinationChainId = getViemChainForNetworkName(DST_CHAIN).id
  const tokenBridgeAddress = getAddress(
    getConfigElement(centrifugeConfig.tokenBridge, SRC_CHAIN) as string
  )

  consola.info(`Connected wallet address: ${signerAddress}`)
  consola.info(
    `Diamond: ${lifiDiamondAddress}, Centrifuge TokenBridge: ${tokenBridgeAddress}`
  )

  // === Pre-flight: the facet has to be routed by the Diamond ===
  const bridgeFunction = getAbiItem({
    abi: CENTRIFUGE_FACET_ABI,
    name: 'startBridgeTokensViaCentrifuge',
  })
  if (!bridgeFunction || bridgeFunction.type !== 'function')
    throw new Error(
      'startBridgeTokensViaCentrifuge is missing from the CentrifugeFacet artifact - run `forge build`'
    )

  const routedFacet = await publicClient.readContract({
    address: lifiDiamondAddress,
    abi: DIAMOND_LOUPE_ABI,
    functionName: 'facetAddress',
    args: [toFunctionSelector(bridgeFunction)],
  })
  if (routedFacet === zeroAddress)
    throw new Error(
      `CentrifugeFacet is not registered on the ${SRC_CHAIN} Diamond (${lifiDiamondAddress}). Deploy the facet and add it to script/deploy/_targetState.json first.`
    )
  consola.info(`CentrifugeFacet routed at ${routedFacet}`)

  // === Pre-flight: the bridge validates the destination against its own map ===
  const destinationCentrifugeId = await publicClient.readContract({
    address: tokenBridgeAddress,
    abi: TOKEN_BRIDGE_ABI,
    functionName: 'chainIdToCentrifugeId',
    args: [BigInt(destinationChainId)],
  })
  if (destinationCentrifugeId === 0)
    throw new Error(
      `${DST_CHAIN} (chain id ${destinationChainId}) has no centrifugeId on the TokenBridge, so it is not a valid destination`
    )
  consola.info(
    `Destination ${DST_CHAIN} maps to centrifugeId ${destinationCentrifugeId}`
  )

  // === Read token metadata ===
  const shareTokenContract = createContractObject(
    SHARE_TOKEN,
    ERC20_ABI,
    publicClient,
    walletClient
  )

  const [shareTokenSymbol, shareTokenDecimals] = await Promise.all([
    publicClient.readContract({
      address: SHARE_TOKEN,
      abi: ERC20_ABI,
      functionName: 'symbol',
    }) as Promise<string>,
    publicClient.readContract({
      address: SHARE_TOKEN,
      abi: ERC20_ABI,
      functionName: 'decimals',
    }) as Promise<number>,
  ])

  const amount = parseUnits(BRIDGE_AMOUNT_HUMAN, Number(shareTokenDecimals))

  consola.info(
    `Bridge ${BRIDGE_AMOUNT_HUMAN} ${shareTokenSymbol} (${SHARE_TOKEN}) from ${SRC_CHAIN} --> ${DST_CHAIN}`
  )

  await ensureBalance(shareTokenContract, signerAddress, amount, publicClient)

  await ensureAllowance(
    shareTokenContract,
    signerAddress,
    lifiDiamondAddress,
    amount,
    publicClient
  )

  // === Prepare bridge data ===
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'centrifuge',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SHARE_TOKEN,
    receiver: signerAddress,
    destinationChainId,
    minAmount: amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // === Quote the messaging fee ===
  const { nativeFee: quotedFee, gasEstimate } = await fetchCentrifugeQuote(
    {
      fromChainId: getViemChainForNetworkName(SRC_CHAIN).id,
      toChainId: destinationChainId,
      token: SHARE_TOKEN,
      amount,
      receiver: signerAddress,
    },
    tokenBridgeAddress
  )
  const nativeFee = (quotedFee * (100n + FEE_SURPLUS_PERCENT)) / 100n
  consola.info(
    `Centrifuge quotes ${formatEther(quotedFee)} ETH; paying ${formatEther(
      nativeFee
    )} ETH so there is a surplus to refund`
  )

  const [nativeBalance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: signerAddress }),
    publicClient.getGasPrice(),
  ])
  const gasReserve = gasPrice * gasEstimate * DIAMOND_GAS_OVERHEAD_FACTOR
  if (nativeFee + gasReserve > nativeBalance)
    throw new Error(
      `This run needs ${formatEther(
        nativeFee
      )} ETH for the fee plus about ${formatEther(
        gasReserve
      )} ETH of gas, and the wallet holds ${formatEther(
        nativeBalance
      )} ETH. Top it up and re-run.`
    )

  const centrifugeData: CentrifugeFacet.CentrifugeDataStruct = {
    nativeFee,
    // receives both the Diamond's excess `msg.value` and the Gateway's own fee surplus
    refundRecipient: signerAddress,
  }

  // === Start bridging ===
  const sharesBefore = (await shareTokenContract.read.balanceOf([
    signerAddress,
  ])) as bigint
  const nativeBefore = await publicClient.getBalance({ address: signerAddress })
  const diamondSharesBefore = (await shareTokenContract.read.balanceOf([
    lifiDiamondAddress,
  ])) as bigint
  const diamondNativeBefore = await publicClient.getBalance({
    address: lifiDiamondAddress,
  })

  const txHash = (await executeTransaction(
    () =>
      walletClient.writeContract({
        address: lifiDiamondAddress,
        abi: CENTRIFUGE_FACET_ABI,
        functionName: 'startBridgeTokensViaCentrifuge',
        args: [bridgeData, centrifugeData],
        value: nativeFee,
      }),
    'Starting bridge tokens via Centrifuge',
    publicClient,
    true
  )) as Hex

  // === Report the money flow ===
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash })
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice

  const sharesAfter = (await shareTokenContract.read.balanceOf([
    signerAddress,
  ])) as bigint
  const nativeAfter = await publicClient.getBalance({ address: signerAddress })
  const diamondSharesAfter = (await shareTokenContract.read.balanceOf([
    lifiDiamondAddress,
  ])) as bigint
  const diamondNativeAfter = await publicClient.getBalance({
    address: lifiDiamondAddress,
  })

  // the refund lands back on the signer, so the fee actually spent is the native delta net of gas
  const consumedFee = nativeBefore - nativeAfter - gasCost
  const sharesSent = sharesBefore - sharesAfter

  consola.info(
    `Shares sent: ${formatUnits(
      sharesSent,
      Number(shareTokenDecimals)
    )} ${shareTokenSymbol}`
  )
  consola.info(
    `Messaging fee consumed: ${formatEther(consumedFee)} ETH of ${formatEther(
      nativeFee
    )} ETH paid (surplus refunded to ${centrifugeData.refundRecipient})`
  )
  consola.info(`Gas: ${formatEther(gasCost)} ETH`)
  consola.info(
    `Diamond residue - shares: ${
      diamondSharesAfter - diamondSharesBefore
    }, native: ${diamondNativeAfter - diamondNativeBefore}`
  )

  if (sharesSent !== amount)
    throw new Error(
      `the bridged amount did not leave the signer: sent ${sharesSent}, expected ${amount}`
    )
  if (diamondSharesAfter !== diamondSharesBefore)
    throw new Error('the Diamond retained share tokens after bridging')
  if (diamondNativeAfter !== diamondNativeBefore)
    throw new Error('the Diamond retained native after bridging')
  if (consumedFee <= 0n)
    throw new Error('no messaging fee was consumed - was the message sent?')
  if (consumedFee >= nativeFee)
    throw new Error('the fee surplus was not refunded to refundRecipient')

  consola.success(
    `Bridged ${BRIDGE_AMOUNT_HUMAN} ${shareTokenSymbol} to ${signerAddress} on ${DST_CHAIN}: share-token pull, messaging-fee payment, surplus refund and zero Diamond residue verified`
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    consola.error(error)
    process.exit(1)
  })
