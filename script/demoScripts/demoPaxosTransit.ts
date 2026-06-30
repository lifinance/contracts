/**
 * Demo: PaxosTransitFacet end-to-end against a LOCAL anvil node with a MOCK TransitStation.
 *
 * The real Paxos TransitStation address + live quote endpoint are not available yet
 * (pending from Paxos ~2026-07-01, see EXSC-547), so this demo proves the full on-chain
 * funds flow locally:
 *   1. spawn anvil (forking mainnet if ETH_NODE_URI_MAINNET is set, otherwise a plain node)
 *   2. deploy a mintable offer token (TestToken), the MockTransitStation, and PaxosTransitFacet
 *   3. mint + approve the offer token, then call startBridgeTokensViaPaxosTransit
 *   4. assert the offer asset moved Diamond/caller -> station and the LayerZero nativeFee was forwarded
 *
 * Once Paxos ships the real station + quote endpoint, swap the mock for the real address and
 * source `quote` + `signature` from the Paxos /v1/transit/orders/data response.
 *
 * Run:  bunx tsx script/demoScripts/demoPaxosTransit.ts
 */
import { spawn, type ChildProcess } from 'child_process'

import { consola } from 'consola'
import { config as dotenvConfig } from 'dotenv'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'

import mockStationArtifact from '../../out/MockTransitStation.sol/MockTransitStation.json'
import paxosFacetArtifact from '../../out/PaxosTransitFacet.sol/PaxosTransitFacet.json'
import testTokenArtifact from '../../out/TestToken.sol/TestToken.json'

dotenvConfig()

// Well-known anvil account #0 (public test key — safe to hard-code for a local demo only).
const ANVIL_PRIVATE_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const RPC_URL = 'http://127.0.0.1:8545'
const ANVIL_PORT = 8545

// left-adjusted bytes32 encoding of "LIFI"
const LIFI_DISTRIBUTOR_CODE: Hex =
  '0x4c49464900000000000000000000000000000000000000000000000000000000'
const ROBINHOOD_CHAIN_ID = 4663n
const ROBINHOOD_EID = 30416 // LayerZero EID for Robinhood Chain
// arbitrary wantAsset placeholder (USDG on the destination chain); the mock ignores it
const WANT_ASSET: Address = '0x1212121212121212121212121212121212121212'

const MOCK_STATION_BYTECODE = (mockStationArtifact.bytecode as { object: Hex })
  .object
const PAXOS_FACET_BYTECODE = (paxosFacetArtifact.bytecode as { object: Hex })
  .object
const TEST_TOKEN_BYTECODE = (testTokenArtifact.bytecode as { object: Hex })
  .object

const account = privateKeyToAccount(ANVIL_PRIVATE_KEY)
const publicClient = createPublicClient({
  chain: anvil,
  transport: http(RPC_URL),
})
const walletClient = createWalletClient({
  account,
  chain: anvil,
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
  const args = ['--port', String(ANVIL_PORT), '--chain-id', '31337']
  if (forkUrl) {
    args.push('--fork-url', forkUrl)
    consola.info('Starting anvil (forking mainnet)...')
  } else {
    consola.info(
      'Starting anvil (plain node — set ETH_NODE_URI_MAINNET to fork mainnet)...'
    )
  }
  const proc = spawn('anvil', args, { stdio: 'ignore' })
  proc.on('error', (err) => {
    consola.error(
      'Failed to start anvil. Is foundry installed and on PATH?',
      err
    )
    process.exit(1)
  })
  return proc
}

async function deploy(
  abi: Abi,
  bytecode: Hex,
  args: readonly unknown[]
): Promise<Address> {
  const hash = await walletClient.deployContract({ abi, bytecode, args })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (!receipt.contractAddress)
    throw new Error('deployment produced no contract address')
  return receipt.contractAddress
}

async function main() {
  const anvilProc = startAnvil()
  try {
    await waitForAnvil()
    consola.success(`anvil ready at ${RPC_URL} (wallet: ${account.address})`)

    const tokenAbi = testTokenArtifact.abi as Abi
    const facetAbi = paxosFacetArtifact.abi as Abi
    const stationAbi = mockStationArtifact.abi as Abi

    // 1) deploy offer token, mock station, facet
    const offerToken = await deploy(tokenAbi, TEST_TOKEN_BYTECODE, [
      'Mock USDC',
      'mUSDC',
      6,
    ])
    const station = await deploy(stationAbi, MOCK_STATION_BYTECODE, [])
    const facet = await deploy(facetAbi, PAXOS_FACET_BYTECODE, [station])
    consola.success(
      `deployed offerToken=${offerToken} station=${station} facet=${facet}`
    )

    // 2) mint + approve the offer asset to the facet
    const offerAmount = parseUnits('100', 6) // 100 mUSDC
    const nativeFee = parseUnits('0.0008', 18) // simulated LayerZero messaging fee
    const receiver: Address = '0x000000000000000000000000000000000000bEEF' // end user on Robinhood Chain

    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: offerToken,
        abi: tokenAbi,
        functionName: 'mint',
        args: [account.address, offerAmount],
      }),
    })
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: offerToken,
        abi: tokenAbi,
        functionName: 'approve',
        args: [facet, offerAmount],
      }),
    })
    consola.info(`minted + approved ${offerAmount} mUSDC to the facet`)

    // 3) build bridgeData + the Paxos-specific data (quote + signature + nativeFee)
    const bridgeData = {
      transactionId: ('0x' + '11'.repeat(32)) as Hex,
      bridge: 'paxosTransit',
      integrator: 'demoScript',
      referrer: zeroAddress,
      sendingAssetId: offerToken,
      receiver,
      minAmount: offerAmount,
      destinationChainId: ROBINHOOD_CHAIN_ID,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const paxosData = {
      quote: {
        route: {
          destEID: ROBINHOOD_EID,
          offerAsset: offerToken,
          wantAsset: WANT_ASSET,
        },
        offerAmount,
        receiver,
        protocolFee: parseUnits('0.02', 6), // 2 bps on 100 (informational; mock ignores)
        integratorFee: 0n,
        integratorFeeReceiver: zeroAddress,
        distributorCode: LIFI_DISTRIBUTOR_CODE,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 300), // 5 min window
        salt: ('0x' + 'ab'.repeat(32)) as Hex,
      },
      signature: '0x' as Hex, // mock station does not verify; real flow uses the Paxos signature
      nativeFee,
    }

    // make the mock station require exactly this LayerZero fee, so a successful run
    // proves the facet actually forwarded it (not just that the call didn't revert)
    await publicClient.waitForTransactionReceipt({
      hash: await walletClient.writeContract({
        address: station,
        abi: stationAbi,
        functionName: 'setExpectedNativeFee',
        args: [nativeFee],
      }),
    })

    // 4) execute the bridge
    const txHash = await walletClient.writeContract({
      address: facet,
      abi: facetAbi,
      functionName: 'startBridgeTokensViaPaxosTransit',
      args: [bridgeData, paxosData],
      value: nativeFee,
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })
    consola.success(`✅ bridge tx: ${txHash}`)

    // 5) assert the funds flow
    const stationTokenBalance = (await publicClient.readContract({
      address: offerToken,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [station],
    })) as bigint
    const lastNativeFee = (await publicClient.readContract({
      address: station,
      abi: stationAbi,
      functionName: 'lastNativeFee',
      args: [],
    })) as bigint

    consola.info(
      `station offer-asset balance: ${stationTokenBalance} (expected ${offerAmount})`
    )
    consola.info(
      `station recorded nativeFee:  ${lastNativeFee} (expected ${nativeFee})`
    )

    if (stationTokenBalance !== offerAmount)
      throw new Error('offer asset was not pulled to the station')
    if (lastNativeFee !== nativeFee)
      throw new Error('LayerZero nativeFee was not forwarded')

    consola.success(
      'Paxos Transit demo completed: offer-asset pull + LayerZero nativeFee forwarding verified against the mock station (protocol/integrator fees and destination delivery are mock-stubbed) ✔'
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
