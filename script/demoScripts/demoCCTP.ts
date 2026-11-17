/**
 * Demo script for CCTPFacet: burns USDC through Circle's TokenMessengerV2 via the staging diamond,
 * optionally with a Circle Forwarding Service hook, to an EVM chain, Solana or HyperCore.
 * Use it to exercise every CCTPFacet route by hand; it dry-runs (prints calldata) unless --send.
 */

// SUCCESSFUL TRANSACTIONS PRODUCED BY THIS SCRIPT
// - Base -> Arbitrum, 1 USDC, fast, Circle relays (--forward):
//   src: https://basescan.org/tx/0x87b181e049e4b59763ee22b46582704eb167b871e33147c38786c817797bed40
//   dst: https://arbiscan.io/tx/0xf161d5e5938cf6c1c1794c4f7632956deeb5647c849a09bfd8e5509609a9c6c0

import { randomBytes } from 'crypto'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { config } from 'dotenv'
import {
  concat,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  numberToHex,
  padHex,
  parseUnits,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type Narrow,
} from 'viem'

import cctpConfig from '../../config/cctp.json'
import networks from '../../config/networks.json'
import cctpFacetArtifact from '../../out/CCTPFacet.sol/CCTPFacet.json'
import { EnvironmentEnum, type SupportedChain } from '../common/types'
import { flagIsOn } from '../deploy/safe/cli-flags'
import { fetchWithTimeout } from '../utils/fetchWithTimeout'

import {
  ADDRESS_UNISWAP_ARB,
  ADDRESS_UNISWAP_BASE,
  ADDRESS_UNISWAP_ETH,
  ADDRESS_UNISWAP_OPT,
  ADDRESS_UNISWAP_POL,
  ADDRESS_USDC_SOL,
  ADDRESS_WETH_ARB,
  ADDRESS_WETH_BASE,
  ADDRESS_WETH_ETH,
  ADDRESS_WETH_OPT,
  ADDRESS_WETH_POL,
  NON_EVM_ADDRESS,
  createContractObject,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getPrivateKeyForEnvironment,
  getUniswapDataERC20toExactERC20,
  logBridgeDataStruct,
  setupEnvironment,
  solanaAddressToBytes32,
} from './utils/demoScriptHelpers'
import {
  computeSolanaATABytes32,
  deriveSolanaAddress,
} from './utils/solanaAddress'

config({ quiet: true })

const CCTP_FACET_ABI = cctpFacetArtifact.abi as Narrow<
  typeof cctpFacetArtifact.abi
>

const IRIS_API_URL = 'https://iris-api.circle.com'

const DEFAULT_SRC_CHAIN = 'arbitrum'
const DEFAULT_DST_CHAIN = 'optimism'

// LI.FI chain IDs from LiFiData.sol
const LIFI_CHAIN_ID_SOLANA = 1151111081099710n
const LIFI_CHAIN_ID_HYPERCORE = 1337n

// HyperCore has no CCTP domain of its own: the burn targets HyperEVM's domain
const HYPEREVM_CCTP_DOMAIN = 19

const FAST_FINALITY = 1000
const STANDARD_FINALITY = 2000

// Circle documents a 10-20% buffer on the Fast Transfer protocol fee, which can move between
// quote and burn
const PROTOCOL_FEE_BUFFER_PERCENT = 20n

// HyperCore spot balance as the forwarder's destination ID (0 = perp margin balance)
const HYPERCORE_SPOT_DESTINATION = 0xffffffff

// The 24-byte magic that asks Circle's Forwarding Service to relay: "cctp-forward", zero-padded
const CCTP_FORWARD_MAGIC = padHex(stringToHex('cctp-forward'), {
  dir: 'right',
  size: 24,
})

const WETH_ADDRESSES: Partial<Record<SupportedChain, string>> = {
  mainnet: ADDRESS_WETH_ETH,
  optimism: ADDRESS_WETH_OPT,
  arbitrum: ADDRESS_WETH_ARB,
  base: ADDRESS_WETH_BASE,
  polygon: ADDRESS_WETH_POL,
}

const UNISWAP_ADDRESSES: Partial<Record<SupportedChain, string>> = {
  mainnet: ADDRESS_UNISWAP_ETH,
  optimism: ADDRESS_UNISWAP_OPT,
  arbitrum: ADDRESS_UNISWAP_ARB,
  base: ADDRESS_UNISWAP_BASE,
  polygon: ADDRESS_UNISWAP_POL,
}

interface IIrisFee {
  finalityThreshold: number
  minimumFee: number
  forwardFee?: { low: number; med?: number; medium?: number; high: number }
}

interface IDestination {
  kind: 'evm' | 'solana' | 'hypercore'
  lifiChainId: bigint
  cctpDomain: number
}

interface ICCTPData {
  maxCCTPFee: bigint
  nonEVMReceiver: Hex
  solanaReceiverATA: Hex
  minFinalityThreshold: number
  refundRecipient: Address
  hookData: Hex
}

interface ISwapData {
  callTo: Address
  approveTo: Address
  sendingAssetId: Address
  receivingAssetId: Address
  fromAmount: bigint
  callData: Hex
  requiresDeposit: boolean
}

function hookHeader(magic: Hex, payloadLength: number): Hex {
  return concat([
    magic,
    numberToHex(0, { size: 4 }),
    numberToHex(payloadLength, { size: 4 }),
  ])
}

function findCCTPDomain(lifiChainId: bigint): number | undefined {
  return cctpConfig.mappings.find((m) => BigInt(m.chainId) === lifiChainId)
    ?.domainId
}

function resolveDestination(dstChain: string): IDestination {
  if (dstChain === 'solana')
    return { kind: 'solana', lifiChainId: LIFI_CHAIN_ID_SOLANA, cctpDomain: 5 }

  if (dstChain === 'hypercore')
    return {
      kind: 'hypercore',
      lifiChainId: LIFI_CHAIN_ID_HYPERCORE,
      cctpDomain: HYPEREVM_CCTP_DOMAIN,
    }

  const network = (networks as Record<string, { chainId: number }>)[dstChain]
  if (!network) throw new Error(`Unknown destination chain: ${dstChain}`)

  const lifiChainId = BigInt(network.chainId)
  const cctpDomain = findCCTPDomain(lifiChainId)
  if (cctpDomain === undefined)
    throw new Error(
      `${dstChain} has no CCTP domain mapping in config/cctp.json`
    )

  return { kind: 'evm', lifiChainId, cctpDomain }
}

/**
 * Builds the CCTP fee cap: the Fast Transfer protocol fee (plus buffer) and, when forwarding,
 * Circle's forward fee. Circle prioritises forwarding over Fast if the cap is too low.
 */
async function quoteMaxCCTPFee(args: {
  srcDomain: number
  destination: IDestination
  amount: bigint
  finality: number
  forward: boolean
  createSolanaAta: boolean
}): Promise<bigint> {
  const query = new URLSearchParams()
  if (args.forward) {
    query.set('forward', 'true')
    if (args.destination.kind === 'hypercore')
      query.set('hyperCoreDeposit', 'true')
    if (args.createSolanaAta) query.set('includeRecipientSetup', 'true')
  }

  const url = `${IRIS_API_URL}/v2/burn/USDC/fees/${args.srcDomain}/${
    args.destination.cctpDomain
  }?${query.toString()}`
  consola.info(`Fetching CCTP fees: ${url}`)

  const response = await fetchWithTimeout(url)
  if (!response.ok)
    throw new Error(
      `Circle fee API returned ${response.status}: ${await response.text()}`
    )

  const fees = (await response.json()) as IIrisFee[]
  const fee = fees.find((f) => f.finalityThreshold === args.finality)
  if (!fee)
    throw new Error(
      `Circle fee API has no entry for finality ${args.finality}: ${JSON.stringify(
        fees
      )}`
    )

  // minimumFee is in basis points and can be fractional (e.g. 1.4)
  const minimumFeeCentiBps = BigInt(Math.round(fee.minimumFee * 100))
  const protocolFee = (args.amount * minimumFeeCentiBps + 999_999n) / 1_000_000n
  const bufferedProtocolFee =
    (protocolFee * (100n + PROTOCOL_FEE_BUFFER_PERCENT) + 99n) / 100n

  let forwardFee = 0n
  if (args.forward) {
    // The live API returns `med`; Circle's spec documents `medium`
    const medium = fee.forwardFee?.med ?? fee.forwardFee?.medium
    if (medium === undefined)
      throw new Error(
        `Circle fee API returned no forwardFee: ${JSON.stringify(fee)}`
      )
    forwardFee = BigInt(medium)
  }

  consola.info(
    `  minimumFee: ${fee.minimumFee} bps -> ${protocolFee} (+${PROTOCOL_FEE_BUFFER_PERCENT}% buffer: ${bufferedProtocolFee})`
  )
  consola.info(`  forwardFee (medium): ${forwardFee}`)

  return bufferedProtocolFee + forwardFee
}

/**
 * Hook data per route. EVM/Solana: an optional Forwarding Service request. HyperCore: the
 * CctpForwarder hook, whose magic only decides whether Circle relays.
 */
function buildHookData(args: {
  destination: IDestination
  forward: boolean
  createSolanaAta: boolean
  hyperCoreRecipient: Address
  solanaOwner: Hex
}): Hex {
  if (args.destination.kind === 'hypercore') {
    const magic = args.forward ? CCTP_FORWARD_MAGIC : toHex(0, { size: 24 })
    return concat([
      hookHeader(magic, 24),
      args.hyperCoreRecipient,
      numberToHex(HYPERCORE_SPOT_DESTINATION, { size: 4 }),
    ])
  }

  if (!args.forward) return '0x'

  // Circle creates the recipient's USDC ATA before minting: flag 1 + owner wallet
  if (args.createSolanaAta)
    return concat([
      hookHeader(CCTP_FORWARD_MAGIC, 33),
      numberToHex(1, { size: 1 }),
      args.solanaOwner,
    ])

  return hookHeader(CCTP_FORWARD_MAGIC, 0)
}

async function buildSwapData(args: {
  srcChain: SupportedChain
  chainId: number
  usdc: Address
  usdcAmount: bigint
  diamond: Address
}): Promise<ISwapData> {
  const weth = WETH_ADDRESSES[args.srcChain]
  const uniswap = UNISWAP_ADDRESSES[args.srcChain]
  if (!weth || !uniswap)
    throw new Error(`No WETH/Uniswap address configured for ${args.srcChain}`)

  const { BigNumber } = await import('ethers')
  const swap = await getUniswapDataERC20toExactERC20(
    uniswap,
    args.chainId,
    weth,
    args.usdc,
    BigNumber.from(args.usdcAmount.toString()),
    args.diamond,
    true,
    Math.floor(Date.now() / 1000) + 60 * 60 // 1 hour
  )

  return {
    callTo: getAddress(swap.callTo),
    approveTo: getAddress(swap.approveTo),
    sendingAssetId: getAddress(swap.sendingAssetId),
    receivingAssetId: getAddress(swap.receivingAssetId),
    fromAmount: BigInt(swap.fromAmount.toString()),
    callData: swap.callData as Hex,
    requiresDeposit: swap.requiresDeposit,
  }
}

async function main(args: {
  srcChain: SupportedChain
  dstChain: string
  amount: string
  forward: boolean
  createSolanaAta: boolean
  standard: boolean
  swap: boolean
  send: boolean
}) {
  const destination = resolveDestination(args.dstChain)
  if (args.createSolanaAta && !(destination.kind === 'solana' && args.forward))
    throw new Error('--createSolanaAta needs --dstChain solana and --forward')

  const srcConfig = (
    cctpConfig as unknown as Record<string, { usdc?: string } | undefined>
  )[args.srcChain]
  if (!srcConfig?.usdc)
    throw new Error(`${args.srcChain} has no USDC entry in config/cctp.json`)
  const usdc = getAddress(srcConfig.usdc)

  const srcChainId = (networks as Record<string, { chainId: number }>)[
    args.srcChain
  ]?.chainId
  if (srcChainId === undefined)
    throw new Error(`Unknown source chain: ${args.srcChain}`)
  const srcDomain = findCCTPDomain(BigInt(srcChainId))
  if (srcDomain === undefined)
    throw new Error(`${args.srcChain} has no CCTP domain mapping`)

  if (findCCTPDomain(destination.lifiChainId) === undefined)
    consola.warn(
      `No chainId -> domain mapping for ${args.dstChain} in config/cctp.json: the facet reverts with UnsupportedChainId unless the diamond has one set`
    )

  const { publicClient, walletAccount, walletClient, lifiDiamondContract } =
    await setupEnvironment(args.srcChain, CCTP_FACET_ABI)
  if (!lifiDiamondContract)
    throw new Error(`No staging diamond deployed on ${args.srcChain}`)
  const diamond = getAddress(lifiDiamondContract.address)
  const wallet = walletAccount.address

  const amount = parseUnits(args.amount, 6)
  const finality = args.standard ? STANDARD_FINALITY : FAST_FINALITY

  let solanaOwner: Hex = toHex(0, { size: 32 })
  let solanaAta: Hex = toHex(0, { size: 32 })
  if (destination.kind === 'solana') {
    const solanaBase58 = deriveSolanaAddress(
      getPrivateKeyForEnvironment(EnvironmentEnum.staging)
    )
    solanaOwner = solanaAddressToBytes32(solanaBase58) as Hex
    solanaAta = (await computeSolanaATABytes32(
      solanaBase58,
      ADDRESS_USDC_SOL
    )) as Hex
    consola.info(`Solana owner: ${solanaBase58} (${solanaOwner})`)
    consola.info(`Solana USDC ATA (mintRecipient): ${solanaAta}`)
  }

  const maxCCTPFee = await quoteMaxCCTPFee({
    srcDomain,
    destination,
    amount,
    finality,
    forward: args.forward,
    createSolanaAta: args.createSolanaAta,
  })
  if (maxCCTPFee >= amount)
    throw new Error(
      `maxCCTPFee ${maxCCTPFee} is not below the amount ${amount}: send more USDC`
    )

  const cctpData: ICCTPData = {
    maxCCTPFee,
    nonEVMReceiver: solanaOwner,
    solanaReceiverATA: solanaAta,
    minFinalityThreshold: finality,
    refundRecipient: wallet,
    hookData: buildHookData({
      destination,
      forward: args.forward,
      createSolanaAta: args.createSolanaAta,
      hyperCoreRecipient: wallet,
      solanaOwner,
    }),
  }

  const bridgeData = {
    transactionId: toHex(new Uint8Array(randomBytes(32))),
    bridge: 'cctp',
    integrator: 'demoScript',
    referrer: zeroAddress,
    sendingAssetId: usdc,
    receiver: destination.kind === 'solana' ? NON_EVM_ADDRESS : wallet,
    minAmount: amount,
    destinationChainId: destination.lifiChainId,
    hasSourceSwaps: args.swap,
    hasDestinationCall: false,
  }

  const swap = args.swap
    ? await buildSwapData({
        srcChain: args.srcChain,
        chainId: srcChainId,
        usdc,
        usdcAmount: amount,
        diamond,
      })
    : undefined

  logBridgeDataStruct(bridgeData)
  consola.info('CCTP data:', {
    ...cctpData,
    maxCCTPFee: `${cctpData.maxCCTPFee} (${formatUnits(cctpData.maxCCTPFee, 6)} USDC)`,
  })
  consola.info(
    `Route: ${args.srcChain} (domain ${srcDomain}) -> ${args.dstChain} (domain ${destination.cctpDomain}), ${
      args.standard ? 'standard' : 'fast'
    }, ${args.forward ? 'Circle relays' : 'someone else must relay'}`
  )

  const functionName = args.swap
    ? 'swapAndStartBridgeTokensViaCCTP'
    : 'startBridgeTokensViaCCTP'
  const callArgs = swap
    ? [bridgeData, [swap], cctpData]
    : [bridgeData, cctpData]

  if (!args.send) {
    consola.info('Dry run, transaction not sent. Calldata:')
    consola.info(
      encodeFunctionData({
        abi: CCTP_FACET_ABI,
        functionName,
        args: callArgs,
      })
    )
    return
  }

  const inputToken = swap?.sendingAssetId ?? usdc
  const inputAmount = swap?.fromAmount ?? amount
  const inputContract = createContractObject(
    inputToken,
    erc20Abi,
    publicClient,
    walletClient
  )
  await ensureBalance(inputContract, wallet, inputAmount, publicClient)
  await ensureAllowance(
    inputContract,
    wallet,
    diamond,
    inputAmount,
    publicClient
  )

  await executeTransaction(
    () =>
      walletClient.writeContract({
        address: diamond,
        abi: CCTP_FACET_ABI,
        functionName,
        args: callArgs,
      }),
    `${functionName} ${args.srcChain} -> ${args.dstChain}`,
    publicClient,
    true
  )
}

const command = defineCommand({
  meta: {
    name: 'demoCCTP',
    description:
      'Bridge USDC via CCTPFacet (Circle CCTP v2) on a staging diamond',
  },
  args: {
    srcChain: {
      type: 'string',
      description: `Source network key from config/networks.json (default: ${DEFAULT_SRC_CHAIN})`,
    },
    dstChain: {
      type: 'string',
      description: `Destination network key, or "solana" / "hypercore" (default: ${DEFAULT_DST_CHAIN})`,
    },
    amount: {
      type: 'string',
      default: '1',
      description: 'USDC amount (human units)',
    },
    forward: {
      type: 'boolean',
      description:
        'Ask Circle Forwarding Service to relay (HyperCore: cctp-forward magic instead of zero)',
    },
    createSolanaAta: {
      type: 'boolean',
      description:
        'Solana + --forward: have Circle create the recipient USDC ATA before minting',
    },
    standard: {
      type: 'boolean',
      description: 'Use Standard finality (2000) instead of Fast (1000)',
    },
    swap: {
      type: 'boolean',
      description: 'Swap WETH -> USDC on Uniswap before bridging',
    },
    send: {
      type: 'boolean',
      description: 'Send the transaction (default: dry run printing calldata)',
    },
  },
  async run({ args }) {
    await main({
      srcChain: (args.srcChain ?? DEFAULT_SRC_CHAIN) as SupportedChain,
      dstChain: args.dstChain ?? DEFAULT_DST_CHAIN,
      amount: args.amount,
      forward: flagIsOn(args.forward),
      createSolanaAta: flagIsOn(args.createSolanaAta),
      standard: flagIsOn(args.standard),
      swap: flagIsOn(args.swap),
      send: flagIsOn(args.send),
    })
  },
})

runMain(command)
