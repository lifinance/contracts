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
 *   3. The signer holds native for the messaging fee and gas.
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
  parseEther,
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

// Fee discovery ladder. It starts well below the ~0.0003 ETH measured on the Ethereum -> Base
// leg and doubles, because the default Base -> Ethereum direction pays for execution on
// Ethereum and should cost materially more. The ceiling bounds what the script is willing to
// lock up before the surplus comes back.
const FEE_PROBE_START = parseEther('0.0001')
const FEE_PROBE_CEILING = parseEther('0.05')

// Held back from the fee budget so a discovered fee cannot swallow the balance the broadcast
// itself still has to pay for. Deliberately well above the ~300k the fork tests settle at,
// because reserving headroom costs nothing while running out mid-run costs a failed send.
const BRIDGE_GAS_ALLOWANCE = 1_000_000n

// The ladder only proves a fee is sufficient, never that it exceeds what the Gateway charges.
// Paying a deliberate margin over it guarantees there is a surplus to refund, which is what the
// money-flow check at the end asserts; without it an exactly-sufficient fee would report a
// failure on a bridge that succeeded.
const FEE_SURPLUS_PERCENT = 25n

/**
 * Finds a native fee the Centrifuge Gateway accepts for this exact transfer.
 *
 * Centrifuge publishes no on-chain fee quote and an underpaid transfer reverts with the
 * Gateway's `NotEnoughGas()`, so a guessed fee risks paying gas for a revert. Doubling an
 * `eth_call` probe costs nothing and pins a sufficient fee at the current block; the Gateway
 * refunds whatever it does not spend, so the fee only has to be enough, not exact. In
 * production this number comes from the LI.FI API quote instead.
 *
 * @param probe - runs the bridge call under `eth_call` with the given fee, returning the error it reverted with
 * @param feeBudget - the most the signer can put toward the fee, which caps the ladder because `eth_call` charges `value` against the balance
 * @returns the smallest probed fee that simulated successfully
 * @throws when the budget runs out first, or when even the ceiling reverts
 */
async function discoverNativeFee(
  probe: (fee: bigint) => Promise<unknown | null>,
  feeBudget: bigint
): Promise<bigint> {
  let lastError: unknown = null

  for (let fee = FEE_PROBE_START; ; fee *= 2n) {
    // the last rung is the ceiling itself, so a fee between the final doubling and the ceiling
    // is never reported as the ceiling having failed
    const probedFee = fee > FEE_PROBE_CEILING ? FEE_PROBE_CEILING : fee

    // eth_call debits `value` from the sender, so probing past what the wallet can cover would
    // report "insufficient funds" and read as a fee verdict it is not
    if (probedFee > feeBudget)
      throw new Error(
        `The next probe is ${formatEther(
          probedFee
        )} ETH but this wallet can put at most ${formatEther(
          feeBudget
        )} ETH toward the messaging fee (balance less the gas held back for the bridge call). Top it up and re-run - the Base -> Ethereum leg costs materially more than the reverse, since it pays for execution on Ethereum.`
      )

    lastError = await probe(probedFee)
    if (lastError === null) {
      consola.info(`Native fee accepted at ${formatEther(probedFee)} ETH`)
      return probedFee
    }
    consola.debug(`fee ${formatEther(probedFee)} ETH rejected, doubling`)

    if (probedFee === FEE_PROBE_CEILING) break
  }

  throw new Error(
    `The bridge call reverts even at the fee ceiling of ${formatEther(
      FEE_PROBE_CEILING
    )} ETH, so this is not an underpayment. Last revert: ${String(lastError)}`
  )
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

  // === Discover the messaging fee ===
  const [nativeBalance, gasPrice] = await Promise.all([
    publicClient.getBalance({ address: signerAddress }),
    publicClient.getGasPrice(),
  ])
  const gasReserve = gasPrice * BRIDGE_GAS_ALLOWANCE
  const feeBudget = nativeBalance > gasReserve ? nativeBalance - gasReserve : 0n

  const discoveredFee = await discoverNativeFee(async (fee) => {
    const centrifugeData: CentrifugeFacet.CentrifugeDataStruct = {
      nativeFee: fee,
      refundRecipient: signerAddress,
    }
    try {
      await publicClient.simulateContract({
        account: signerAddress,
        address: lifiDiamondAddress,
        abi: CENTRIFUGE_FACET_ABI,
        functionName: 'startBridgeTokensViaCentrifuge',
        args: [bridgeData, centrifugeData],
        value: fee,
      })
      return null
    } catch (error) {
      return error
    }
  }, feeBudget)

  const nativeFee = (discoveredFee * (100n + FEE_SURPLUS_PERCENT)) / 100n
  if (nativeFee > feeBudget)
    throw new Error(
      `The fee accepted at ${formatEther(
        discoveredFee
      )} ETH leaves no room for the ${FEE_SURPLUS_PERCENT}% surplus this demo pays to exercise the refund: that needs ${formatEther(
        nativeFee
      )} ETH against a budget of ${formatEther(
        feeBudget
      )} ETH (balance ${formatEther(
        nativeBalance
      )} ETH, less the gas held back for the bridge call). Top it up and re-run.`
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
