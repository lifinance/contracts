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
 *
 * Verified staging run (2026-09-09): 1 deJAAA Base -> Ethereum, delivered 48 min later, with
 * zero Diamond residue and the messaging-fee surplus refunded to the signer.
 *   src: https://basescan.org/tx/0x3c1af4d8f82bd070917d96433609343374e5ac97a3ad38e97e9e5377d4d33b91
 *   dst: https://etherscan.io/tx/0xebc3d06a8572df35b15318b9e66258ab3255f63dcab40b8c8cd3d06f237e74af
 *   msg: https://centrifugescan.io/tx/0x763680baf555b59e99116775531ad18738e32efba0b42c237823aee23bfedf52
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
import { sleep } from '../utils/delay'
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
const CENTRIFUGE_STATUS_URL = 'https://api.centrifuge.io/bridge/status'
// A load-balanced RPC can answer from a node that is a block or two behind, so reads that have
// to see a specific block are retried rather than trusted first time.
const RPC_LAG_ATTEMPTS = 10 // 10 attempts
const RPC_LAG_DELAY_MS = 2000 // 2 seconds, one Base block

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

interface IBalanceSnapshot {
  signerShares: bigint
  signerNative: bigint
  diamondShares: bigint
  diamondNative: bigint
}

type DemoPublicClient = Awaited<
  ReturnType<typeof setupEnvironment>
>['publicClient']

/**
 * Tells a lagging node apart from a genuinely broken read.
 *
 * Only the former is worth retrying: a node that has not applied a block yet rejects a pinned
 * read by name, while a bad address or a dropped connection will not fix itself.
 *
 * @param error - whatever the read threw
 * @returns true when the node simply has not caught up to the requested block
 */
function isBlockNotYetApplied(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ''

  return (
    message.includes('block not found') ||
    message.includes('unknown block') ||
    message.includes('header not found') ||
    message.includes('missing trie node')
  )
}

/**
 * Blocks until the Diamond's allowance is visible on the node that answers the next read.
 *
 * The approval and the bridge call are a second apart and the RPC is load balanced, so the
 * bridge simulation can be answered by a node that has not applied the approval's block yet: it
 * sees no allowance and reverts `TransferFromFailed` on a run that is perfectly fine.
 *
 * @param publicClient - client for the source chain
 * @param owner - the signer that granted the allowance
 * @param spender - the Diamond the allowance was granted to
 * @param amount - the allowance the transfer needs
 * @param shareTokenSymbol - used only to make the timeout message readable
 * @throws when the allowance is still invisible after the full retry budget
 */
async function waitForAllowance(
  publicClient: DemoPublicClient,
  owner: Address,
  spender: Address,
  amount: bigint,
  shareTokenSymbol: string
): Promise<void> {
  for (let attempt = 0; attempt < RPC_LAG_ATTEMPTS; attempt++) {
    const allowance = (await publicClient.readContract({
      address: SHARE_TOKEN,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [owner, spender],
    })) as bigint
    if (allowance >= amount) return

    await sleep(RPC_LAG_DELAY_MS)
  }

  throw new Error(
    `the approval of ${amount} ${shareTokenSymbol} to the Diamond is still not visible after ${
      (RPC_LAG_ATTEMPTS * RPC_LAG_DELAY_MS) / 1000
    }s - the RPC is lagging badly enough that this run cannot be trusted.`
  )
}

/**
 * Reads the messaging fee for this exact transfer from Centrifuge's bridge quote API.
 *
 * The fee has to be known before the call, since it is paid as `msg.value`, and an underpaid
 * transfer reverts with the Gateway's `NotEnoughGas()`. This API is where the backend
 * integration reads it, which is why the demo reads it here rather than probing for it.
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

  const gasEstimate = quote.estimate?.gasEstimate
  if (!gasEstimate || gasEstimate <= 0)
    throw new Error(
      `The quote carried no gas estimate: gasEstimate=${gasEstimate}. The pre-flight balance check sizes its gas reserve from this number, so treating a missing one as zero would wave through a wallet that cannot pay for the transfer.`
    )

  return { nativeFee: BigInt(value), gasEstimate: BigInt(gasEstimate) }
}

/**
 * Fails unless the Diamond routes this facet and the bridge knows the destination chain.
 *
 * Both are cheap reads that would otherwise surface as an opaque revert inside the bridge call,
 * after the wallet has already paid for an approval.
 *
 * @param publicClient - client for the source chain
 * @param lifiDiamondAddress - the Diamond this demo calls
 * @param tokenBridgeAddress - the Centrifuge TokenBridge configured for the source chain
 * @param destinationChainId - EVM chain id the transfer targets
 * @throws when the facet is not registered, or the bridge has no centrifugeId for the destination
 */
async function assertBridgeRouteIsAvailable(
  publicClient: DemoPublicClient,
  lifiDiamondAddress: Address,
  tokenBridgeAddress: Address,
  destinationChainId: number
): Promise<void> {
  const bridgeFunction = getAbiItem({
    abi: CENTRIFUGE_FACET_ABI,
    name: 'startBridgeTokensViaCentrifuge',
  })
  if (!bridgeFunction || bridgeFunction.type !== 'function')
    throw new Error(
      'startBridgeTokensViaCentrifuge is missing from the CentrifugeFacet artifact - run `forge build`'
    )

  const [routedFacet, destinationCentrifugeId] = await Promise.all([
    publicClient.readContract({
      address: lifiDiamondAddress,
      abi: DIAMOND_LOUPE_ABI,
      functionName: 'facetAddress',
      args: [toFunctionSelector(bridgeFunction)],
    }),
    publicClient.readContract({
      address: tokenBridgeAddress,
      abi: TOKEN_BRIDGE_ABI,
      functionName: 'chainIdToCentrifugeId',
      args: [BigInt(destinationChainId)],
    }),
  ])

  if (routedFacet === zeroAddress)
    throw new Error(
      `CentrifugeFacet is not registered on the ${SRC_CHAIN} Diamond (${lifiDiamondAddress}). Deploy the facet and add it to script/deploy/_targetState.json first.`
    )
  if (destinationCentrifugeId === 0)
    throw new Error(
      `${DST_CHAIN} (chain id ${destinationChainId}) has no centrifugeId on the TokenBridge, so it is not a valid destination`
    )

  consola.info(`CentrifugeFacet routed at ${routedFacet}`)
  consola.info(
    `Destination ${DST_CHAIN} maps to centrifugeId ${destinationCentrifugeId}`
  )
}

/**
 * Reads the share-token and native balances of the signer and the Diamond at one block.
 *
 * The reads are pinned to a block number rather than taken around the call: a `latest` read can
 * be answered by a load-balanced node that has not applied the receipt's block yet, which would
 * report every delta as zero and fail the run on a bridge that worked. Pinning trades that
 * silently wrong answer for a loud one, since a node that is behind rejects the block outright -
 * which is the only error worth retrying here.
 *
 * @param publicClient - client for the source chain
 * @param holders - the two addresses to snapshot
 * @param blockNumber - the block to read state at
 * @returns the four balances as of that block
 * @throws when the reads fail for any reason other than the node lagging, or it never catches up
 */
async function readBalancesAtBlock(
  publicClient: DemoPublicClient,
  holders: { signer: Address; diamond: Address },
  blockNumber: bigint
): Promise<IBalanceSnapshot> {
  const readShares = (holder: Address) =>
    publicClient.readContract({
      address: SHARE_TOKEN,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [holder],
      blockNumber,
    }) as Promise<bigint>

  for (let attempt = 1; ; attempt++)
    try {
      const [signerShares, signerNative, diamondShares, diamondNative] =
        await Promise.all([
          readShares(holders.signer),
          publicClient.getBalance({ address: holders.signer, blockNumber }),
          readShares(holders.diamond),
          publicClient.getBalance({ address: holders.diamond, blockNumber }),
        ])

      return { signerShares, signerNative, diamondShares, diamondNative }
    } catch (error) {
      if (attempt >= RPC_LAG_ATTEMPTS || !isBlockNotYetApplied(error))
        throw error

      await sleep(RPC_LAG_DELAY_MS)
    }
}

/**
 * Reports where the funds went and fails the run unless the flow matches what the facet
 * promises: the bridged amount left the signer, part of the fee was consumed and the rest
 * refunded, and the Diamond kept neither shares nor native.
 *
 * @param params - the executed transfer, plus the token metadata needed to format the report
 * @throws when any leg of the money flow does not hold
 */
async function verifyAndReportMoneyFlow(params: {
  publicClient: DemoPublicClient
  txHash: Hex
  signerAddress: Address
  lifiDiamondAddress: Address
  amount: bigint
  nativeFee: bigint
  refundRecipient: Address
  shareTokenSymbol: string
  shareTokenDecimals: number
}): Promise<void> {
  const { publicClient, signerAddress, lifiDiamondAddress } = params

  const receipt = await publicClient.getTransactionReceipt({
    hash: params.txHash,
  })
  const gasCost = receipt.gasUsed * receipt.effectiveGasPrice

  const holders = { signer: signerAddress, diamond: lifiDiamondAddress }
  const before = await readBalancesAtBlock(
    publicClient,
    holders,
    receipt.blockNumber - 1n
  )
  const after = await readBalancesAtBlock(
    publicClient,
    holders,
    receipt.blockNumber
  )

  // the refund lands back on the signer, so the fee actually spent is the native delta net of gas
  const consumedFee = before.signerNative - after.signerNative - gasCost
  const sharesSent = before.signerShares - after.signerShares

  consola.info(
    `Shares sent: ${formatUnits(sharesSent, params.shareTokenDecimals)} ${
      params.shareTokenSymbol
    }`
  )
  consola.info(
    `Messaging fee consumed: ${formatEther(consumedFee)} ETH of ${formatEther(
      params.nativeFee
    )} ETH paid (surplus refunded to ${params.refundRecipient})`
  )
  consola.info(`Gas: ${formatEther(gasCost)} ETH`)
  consola.info(
    `Diamond residue - shares: ${
      after.diamondShares - before.diamondShares
    }, native: ${after.diamondNative - before.diamondNative}`
  )

  if (sharesSent !== params.amount)
    throw new Error(
      `the bridged amount did not leave the signer: sent ${sharesSent}, expected ${params.amount}`
    )
  if (after.diamondShares !== before.diamondShares)
    throw new Error('the Diamond retained share tokens after bridging')
  if (after.diamondNative !== before.diamondNative)
    throw new Error('the Diamond retained native after bridging')
  if (consumedFee <= 0n)
    throw new Error('no messaging fee was consumed - was the message sent?')
  if (consumedFee >= params.nativeFee)
    throw new Error('the fee surplus was not refunded to refundRecipient')

  consola.success(
    `Sent ${BRIDGE_AMOUNT_HUMAN} ${params.shareTokenSymbol} towards ${signerAddress} on ${DST_CHAIN}: share-token pull, messaging-fee payment, surplus refund and zero Diamond residue verified`
  )
  // The destination mint is settled by Centrifuge's own executor minutes later, so the source
  // leg succeeding is not yet proof the shares arrived.
  consola.info(
    `Destination leg settles asynchronously - track it at ${CENTRIFUGE_STATUS_URL}?txHash=${params.txHash}`
  )
}

/**
 * Reads the share token's symbol and decimals from the chain rather than hardcoding them, so
 * switching `SHARE_TOKEN` needs no other edit.
 *
 * @param publicClient - client for the source chain
 * @returns the token's symbol and decimals
 */
async function readShareTokenMetadata(
  publicClient: DemoPublicClient
): Promise<{ symbol: string; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
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

  return { symbol, decimals: Number(decimals) }
}

/**
 * Quotes the messaging fee for this transfer and refuses to continue unless the wallet can
 * cover it alongside the gas the call will burn.
 *
 * @param publicClient - client for the source chain
 * @param signerAddress - the wallet paying for the transfer
 * @param tokenBridgeAddress - the bridge the quote has to agree with
 * @param destinationChainId - EVM chain id the transfer targets
 * @param amount - the amount of share tokens being bridged
 * @returns the native value to send, the quote plus a deliberate surplus
 * @throws when the quote is unusable, or the wallet cannot fund fee and gas
 */
async function quoteFeeAndCheckFunding(
  publicClient: DemoPublicClient,
  signerAddress: Address,
  tokenBridgeAddress: Address,
  destinationChainId: number,
  amount: bigint
): Promise<bigint> {
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

  return nativeFee
}

/**
 * Builds the calldata and broadcasts the bridge transaction.
 *
 * The receiver is the signer on the destination chain, and the signer is also the refund
 * recipient, so both the Diamond's excess `msg.value` and the Gateway's fee surplus come back
 * to the wallet that funded the run.
 *
 * @param params - the clients, the Diamond, and the transfer this run settled on
 * @returns the source-chain transaction hash
 */
async function startBridge(params: {
  publicClient: DemoPublicClient
  walletClient: Awaited<ReturnType<typeof setupEnvironment>>['walletClient']
  lifiDiamondAddress: Address
  signerAddress: Address
  destinationChainId: number
  amount: bigint
  nativeFee: bigint
}): Promise<Hex> {
  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: `0x${randomBytes(32).toString('hex')}`,
    bridge: 'centrifuge',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: SHARE_TOKEN,
    receiver: params.signerAddress,
    destinationChainId: params.destinationChainId,
    minAmount: params.amount,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const centrifugeData: CentrifugeFacet.CentrifugeDataStruct = {
    nativeFee: params.nativeFee,
    refundRecipient: params.signerAddress,
  }

  return (await executeTransaction(
    () =>
      params.walletClient.writeContract({
        address: params.lifiDiamondAddress,
        abi: CENTRIFUGE_FACET_ABI,
        functionName: 'startBridgeTokensViaCentrifuge',
        args: [bridgeData, centrifugeData],
        value: params.nativeFee,
      }),
    'Starting bridge tokens via Centrifuge',
    params.publicClient,
    true
  )) as Hex
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

  await assertBridgeRouteIsAvailable(
    publicClient,
    lifiDiamondAddress,
    tokenBridgeAddress,
    destinationChainId
  )

  // === Read token metadata ===
  const shareTokenContract = createContractObject(
    SHARE_TOKEN,
    ERC20_ABI,
    publicClient,
    walletClient
  )

  const { symbol: shareTokenSymbol, decimals: shareTokenDecimals } =
    await readShareTokenMetadata(publicClient)

  const amount = parseUnits(BRIDGE_AMOUNT_HUMAN, shareTokenDecimals)

  consola.info(
    `Bridge ${BRIDGE_AMOUNT_HUMAN} ${shareTokenSymbol} (${SHARE_TOKEN}) from ${SRC_CHAIN} --> ${DST_CHAIN}`
  )

  await ensureBalance(shareTokenContract, signerAddress, amount, publicClient)

  // === Quote the messaging fee ===
  const nativeFee = await quoteFeeAndCheckFunding(
    publicClient,
    signerAddress,
    tokenBridgeAddress,
    destinationChainId,
    amount
  )

  // === Approve the Diamond ===
  // Broadcast only once every free pre-flight has passed, so a run that was never going to make
  // it does not leave an allowance and an approval fee behind.
  await ensureAllowance(
    shareTokenContract,
    signerAddress,
    lifiDiamondAddress,
    amount,
    publicClient
  )
  await waitForAllowance(
    publicClient,
    signerAddress,
    lifiDiamondAddress,
    amount,
    shareTokenSymbol
  )

  // === Start bridging ===
  const txHash = await startBridge({
    publicClient,
    walletClient,
    lifiDiamondAddress,
    signerAddress,
    destinationChainId,
    amount,
    nativeFee,
  })

  // === Report the money flow ===
  await verifyAndReportMoneyFlow({
    publicClient,
    txHash,
    signerAddress,
    lifiDiamondAddress,
    amount,
    nativeFee,
    refundRecipient: signerAddress,
    shareTokenSymbol,
    shareTokenDecimals,
  })
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    consola.error(error)
    process.exit(1)
  })
