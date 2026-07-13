/**
 * Demo: PaxosTransitFacet end-to-end against the REAL Paxos TransitStation on an
 * anvil mainnet fork (see EXSC-547).
 *
 * The station gates submitOrder on a Paxos-controlled quote signer, but that signer is
 * plain owner-settable storage — so on the fork we rotate it to a local test key and
 * sign the Quote EIP-712 ourselves, exactly as the LI.FI backend would. No live Paxos
 * API and no real funds are touched:
 *   1. spawn anvil forking mainnet (ETH_NODE_URI_MAINNET required — the station only exists there)
 *   2. deploy PaxosTransitFacet pointed at the real TransitStation
 *   3. impersonate the station owner and setQuoteSigner to a local test key
 *   4. fund the caller with real USDC (storage write) and approve the facet
 *   5. read the real LayerZero fee via quoteSend, sign the quote, call startBridgeTokensViaPaxosTransit
 *   6. assert the real funds flow: protocolFee + net pulled to the Paxos recipients and
 *      the quote digest (== order uuid) marked used on the station
 *
 * In production the `quote` + `signature` come from the Paxos
 * `GET /v1/transit/orders/quote` response (endpoint confirmed by Paxos 2026-06-30 — the
 * integration guide's original path is stale). Note: Paxos enforces a minimum order
 * size of >$5 across all routes, so quote requests below $5 error.
 *
 * Run:  bunx tsx script/demoScripts/demoPaxosTransit.ts
 */
import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { consola } from 'consola'
import { config as dotenvConfig } from 'dotenv'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  hashTypedData,
  http,
  keccak256,
  parseAbi,
  parseEther,
  parseUnits,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'

dotenvConfig()

// Read the Forge artifact at runtime rather than statically importing it: the
// validate-scripts CI job runs without a prior `forge build`, so a static
// `import ... from '../../out/...json'` fails TS2307 there even though a full local
// `forge build` produces the file.
interface IForgeArtifact {
  abi: Abi
  bytecode: { object: Hex }
}
const __dirname = path.dirname(fileURLToPath(import.meta.url))

function readIForgeArtifact(
  contractFile: string,
  contractName: string
): IForgeArtifact {
  const artifactPath = path.join(
    __dirname,
    '../../out',
    contractFile,
    `${contractName}.json`
  )
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as IForgeArtifact
}

const paxosFacetArtifact = readIForgeArtifact(
  'PaxosTransitFacet.sol',
  'PaxosTransitFacet'
)

// Well-known anvil accounts #0 / #1 (public test keys — safe to hard-code for a local demo only).
const ANVIL_PRIVATE_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const QUOTE_SIGNER_PRIVATE_KEY: Hex =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const RPC_URL = 'http://127.0.0.1:8545'
const ANVIL_PORT = 8545
const ANVIL_CHAIN_ID = 31337

// left-adjusted bytes32 encoding of "LIFI"
const LIFI_DISTRIBUTOR_CODE: Hex =
  '0x4c49464900000000000000000000000000000000000000000000000000000000'
const ROBINHOOD_CHAIN_ID = 4663n
const ROBINHOOD_EID = 30416 // LayerZero EID for Robinhood Chain

// the real Paxos TransitStation on mainnet (verified 2026-06-29)
const TRANSIT_STATION: Address = '0x49AAA987b1a7e9E4AE091dcD8332c39F322D7d28'
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
// want asset of the globally-approved USDC route to Robinhood (USDG); the station's
// route allowlist is keyed on it, so a placeholder would revert with RouteNotApproved
const WANT_ASSET: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'
// balances mapping slot of the FiatTokenV2 (USDC) implementation
const USDC_BALANCES_SLOT = 9n

const transitStationAbi = parseAbi([
  'function owner() view returns (address)',
  'function setQuoteSigner(address signer)',
  'function quoteSigner() view returns (address)',
  'function offerReceiver() view returns (address)',
  'function protocolFeeRecipient() view returns (address)',
  'function usedDigests(bytes32 digest) view returns (bool)',
  'function approvedRoutes(uint32 destEID, address offerAsset, address wantAsset) view returns (bool)',
  'function quoteSend(uint32 destEID, (bytes32 uuid, address wantAsset, address receiver, address offerAsset, uint256 offerAmountNormalized18AfterFees) terms) view returns (uint256)',
])

// EIP-712 types copied from the verified TransitStation (the `route` member is a nested struct)
const quoteTypes = {
  Route: [
    { name: 'destEID', type: 'uint32' },
    { name: 'offerAsset', type: 'address' },
    { name: 'wantAsset', type: 'address' },
  ],
  Quote: [
    { name: 'route', type: 'Route' },
    { name: 'offerAmount', type: 'uint256' },
    { name: 'receiver', type: 'address' },
    { name: 'protocolFee', type: 'uint256' },
    { name: 'integratorFee', type: 'uint256' },
    { name: 'integratorFeeReceiver', type: 'address' },
    { name: 'distributorCode', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
    { name: 'salt', type: 'bytes32' },
  ],
} as const

const account = privateKeyToAccount(ANVIL_PRIVATE_KEY)
const quoteSigner = privateKeyToAccount(QUOTE_SIGNER_PRIVATE_KEY)
const publicClient = createPublicClient({
  chain: anvil,
  transport: http(RPC_URL),
})
const walletClient = createWalletClient({
  account,
  chain: anvil,
  transport: http(RPC_URL),
})
const testClient = createTestClient({
  chain: anvil,
  mode: 'anvil',
  transport: http(RPC_URL),
})

async function waitForAnvil(timeoutMs = 15_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      await publicClient.getChainId()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  throw new Error('anvil did not become ready in time')
}

function startAnvil(): ChildProcess {
  const forkUrl = process.env.ETH_NODE_URI_MAINNET
  if (!forkUrl)
    throw new Error(
      'ETH_NODE_URI_MAINNET is required: the demo runs against the real TransitStation on a mainnet fork'
    )
  consola.info('Starting anvil (forking mainnet)...')
  const proc = spawn(
    'anvil',
    [
      '--port',
      String(ANVIL_PORT),
      '--chain-id',
      String(ANVIL_CHAIN_ID),
      '--fork-url',
      forkUrl,
    ],
    { stdio: 'ignore' }
  )
  proc.on('error', (err) => {
    consola.error(
      'Failed to start anvil. Is foundry installed and on PATH?',
      err
    )
    process.exit(1)
  })
  return proc
}

async function main(): Promise<void> {
  const anvilProc = startAnvil()
  try {
    await waitForAnvil()
    consola.success(`anvil ready at ${RPC_URL} (wallet: ${account.address})`)

    const facetAbi = paxosFacetArtifact.abi

    // 1) deploy PaxosTransitFacet pointed at the real station
    const deployHash = await walletClient.deployContract({
      abi: facetAbi,
      bytecode: paxosFacetArtifact.bytecode.object,
      args: [TRANSIT_STATION],
    })
    const deployReceipt = await publicClient.waitForTransactionReceipt({
      hash: deployHash,
    })
    const facet = deployReceipt.contractAddress
    if (!facet) throw new Error('facet deployment produced no address')
    consola.success(`deployed facet=${facet} (station=${TRANSIT_STATION})`)

    // 2) rotate the station's quote signer to our local test key
    const stationOwner = await publicClient.readContract({
      address: TRANSIT_STATION,
      abi: transitStationAbi,
      functionName: 'owner',
    })
    await testClient.impersonateAccount({ address: stationOwner })
    await testClient.setBalance({
      address: stationOwner,
      value: parseEther('1'),
    })
    const ownerClient = createWalletClient({
      account: stationOwner,
      chain: anvil,
      transport: http(RPC_URL),
    })
    await publicClient.waitForTransactionReceipt({
      hash: await ownerClient.writeContract({
        address: TRANSIT_STATION,
        abi: transitStationAbi,
        functionName: 'setQuoteSigner',
        args: [quoteSigner.address],
      }),
    })
    await testClient.stopImpersonatingAccount({ address: stationOwner })
    consola.info(`rotated station quoteSigner to ${quoteSigner.address}`)

    const routeApproved = await publicClient.readContract({
      address: TRANSIT_STATION,
      abi: transitStationAbi,
      functionName: 'approvedRoutes',
      args: [ROBINHOOD_EID, USDC, WANT_ASSET],
    })
    if (!routeApproved)
      throw new Error(
        'USDC -> USDG route to Robinhood is not approved on the station (fork too old?)'
      )

    // 3) fund the caller with real USDC (write the FiatToken balances slot) + approve the facet
    const offerAmount = parseUnits('100', 6) // 100 USDC
    const balanceSlot = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }],
        [account.address, USDC_BALANCES_SLOT]
      )
    )
    await testClient.setStorageAt({
      address: USDC,
      index: balanceSlot,
      value: toHex(offerAmount, { size: 32 }),
    })
    const usdcBalance = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })
    if (usdcBalance !== offerAmount)
      throw new Error(
        `USDC funding via storage write failed (balances slot moved?): got ${usdcBalance}`
      )
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: 'approve',
        args: [facet, offerAmount],
      }),
    })
    consola.info(`funded + approved ${offerAmount} USDC to the facet`)

    // 4) build the quote, sign it as the (rotated) backend signer, read the real LZ fee
    const receiver: Address = '0x000000000000000000000000000000000000bEEF' // end user on Robinhood Chain
    const block = await publicClient.getBlock()
    const quote = {
      route: {
        destEID: ROBINHOOD_EID,
        offerAsset: USDC,
        wantAsset: WANT_ASSET,
      },
      offerAmount,
      receiver,
      protocolFee: parseUnits('0.02', 6), // 2 bps on 100 USDC (station cap: 50 bps)
      integratorFee: 0n,
      integratorFeeReceiver:
        '0x0000000000000000000000000000000000000000' as Address,
      distributorCode: LIFI_DISTRIBUTOR_CODE,
      deadline: block.timestamp + 300n, // 5 min window (fork time, not wall time)
      salt: ('0x' + 'ab'.repeat(32)) as Hex,
    }
    // the station recomputes its EIP-712 domain live from block.chainid, so signing
    // against the anvil chain id works on the fork
    const typedData = {
      domain: {
        name: 'TransitStation',
        version: '1',
        chainId: ANVIL_CHAIN_ID,
        verifyingContract: TRANSIT_STATION,
      },
      types: quoteTypes,
      primaryType: 'Quote',
      message: quote,
    } as const
    const signature = await quoteSigner.signTypedData(typedData)
    const digest = hashTypedData(typedData) // == the station's order uuid

    const nativeFee = await publicClient.readContract({
      address: TRANSIT_STATION,
      abi: transitStationAbi,
      functionName: 'quoteSend',
      args: [
        ROBINHOOD_EID,
        {
          uuid: digest,
          wantAsset: WANT_ASSET,
          receiver,
          offerAsset: USDC,
          offerAmountNormalized18AfterFees: 0n,
        },
      ],
    })
    consola.info(`LayerZero nativeFee (via quoteSend): ${nativeFee} wei`)

    const bridgeData = {
      transactionId: ('0x' + '11'.repeat(32)) as Hex,
      bridge: 'paxosTransit',
      integrator: 'demoScript',
      referrer: '0x0000000000000000000000000000000000000000' as Address,
      sendingAssetId: USDC,
      receiver,
      minAmount: offerAmount,
      destinationChainId: ROBINHOOD_CHAIN_ID,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }
    const paxosData = {
      quote,
      signature,
      nativeFee,
      refundRecipient: receiver, // receives swap leftovers, positive slippage + excess native
    }

    // snapshot the Paxos recipients before bridging
    const offerReceiver = await publicClient.readContract({
      address: TRANSIT_STATION,
      abi: transitStationAbi,
      functionName: 'offerReceiver',
    })
    const protocolFeeRecipient = await publicClient.readContract({
      address: TRANSIT_STATION,
      abi: transitStationAbi,
      functionName: 'protocolFeeRecipient',
    })
    const balanceOf = (holder: Address): Promise<bigint> =>
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [holder],
      })
    const offerReceiverBefore = await balanceOf(offerReceiver)
    const protocolFeeRecipientBefore = await balanceOf(protocolFeeRecipient)

    // 5) execute the bridge
    const txHash = await walletClient.writeContract({
      address: facet,
      abi: facetAbi,
      functionName: 'startBridgeTokensViaPaxosTransit',
      args: [bridgeData, paxosData],
      value: nativeFee,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })
    consola.success(`✅ bridge tx: ${txHash}`)

    // 6) assert the real funds flow
    const net = offerAmount - quote.protocolFee
    const digestUsed = await publicClient.readContract({
      address: TRANSIT_STATION,
      abi: transitStationAbi,
      functionName: 'usedDigests',
      args: [digest],
    })
    let recipientsOk: boolean
    if (offerReceiver === protocolFeeRecipient) {
      const combined = (await balanceOf(offerReceiver)) - offerReceiverBefore
      consola.info(
        `offerReceiver==protocolFeeRecipient delta: ${combined} (expected ${offerAmount})`
      )
      recipientsOk = combined === offerAmount
    } else {
      const netDelta = (await balanceOf(offerReceiver)) - offerReceiverBefore
      const feeDelta =
        (await balanceOf(protocolFeeRecipient)) - protocolFeeRecipientBefore
      consola.info(
        `offerReceiver delta: ${netDelta} (expected ${net}), protocolFeeRecipient delta: ${feeDelta} (expected ${quote.protocolFee})`
      )
      recipientsOk = netDelta === net && feeDelta === quote.protocolFee
    }
    consola.info(`order digest marked used: ${digestUsed}`)

    if (!recipientsOk)
      throw new Error('offer asset was not pulled to the Paxos recipients')
    if (!digestUsed)
      throw new Error('order was not registered on the station (digest unused)')

    consola.success(
      'Paxos Transit demo completed against the REAL TransitStation: quote signing, LayerZero fee payment, offer-asset pull and order registration verified on the mainnet fork ✔'
    )
  } finally {
    anvilProc.kill()
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    consola.error(error)
    process.exit(1)
  })
