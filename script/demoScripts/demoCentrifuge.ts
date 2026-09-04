/**
 * Demo: CentrifugeFacet end-to-end against the REAL Centrifuge TokenBridge on an
 * anvil mainnet fork (see EXSC-828).
 *
 * Centrifuge share tokens cannot be bought on a DEX and their vaults are ERC-7540
 * asynchronous, so the demo mints the share token the way the protocol itself does: the
 * Spoke is an authorized ward on the token, so we impersonate it and mint. No live
 * Centrifuge API and no real funds are touched:
 *   1. spawn anvil forking mainnet (ETH_NODE_URI_MAINNET required)
 *   2. deploy CentrifugeFacet pointed at the real TokenBridge
 *   3. impersonate the Spoke and mint deJAAA to the caller, then approve the facet
 *   4. call startBridgeTokensViaCentrifuge with a deliberate overpayment
 *   5. assert the real funds flow: shares left the caller, nothing is stranded in the
 *      facet, and the Gateway refunded the unused fee to refundRecipient
 *
 * In production `nativeFee` comes from the LI.FI API quote — Centrifuge exposes no
 * on-chain fee quote, so it cannot be read from the chain. Once the backend integration
 * (EXBE-531) is live, prefer driving this flow from a real `/quote` response.
 *
 * Run:  bunx tsx script/demoScripts/demoCentrifuge.ts
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
  erc20Abi,
  http,
  padHex,
  parseAbi,
  parseEther,
  parseUnits,
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

const centrifugeFacetArtifact = readIForgeArtifact(
  'CentrifugeFacet.sol',
  'CentrifugeFacet'
)

// Well-known anvil account #0 (public test key — safe to hard-code for a local demo only).
const ANVIL_PRIVATE_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const RPC_URL = 'http://127.0.0.1:8545'
const ANVIL_PORT = 8545
const ANVIL_CHAIN_ID = 31337

// the real Centrifuge TokenBridge (same address on Ethereum and Base, verified 2026-07-21)
const TOKEN_BRIDGE: Address = '0x82a6C7753380f98c093B27c53f86ef6b09C40f49'
// deJAAA, a Centrifuge share token; its pool hub is on Ethereum (centrifugeId 1)
const SHARE_TOKEN: Address = '0xAAA0008C8CF3A7Dca931adaF04336A5D808C82Cc'
// Largest deJAAA holder at the time of writing (an EOA). The share token's transfer hook is
// permissive, so impersonating a holder is enough to source funds - and it survives storage
// layout changes, unlike writing the balances slot directly. If this address ever sells out
// the demo fails loudly here; pick another holder from the token's holder list.
const SHARE_TOKEN_WHALE: Address = '0x665Ec2cEb9996E7e130A095CA36956AaB8a71703'
const BASE_CHAIN_ID = 8453n

// Centrifuge has no fee quote, so the demo overpays and verifies the surplus comes back.
const NATIVE_FEE = parseEther('0.01')

const tokenBridgeAbi = parseAbi([
  'function spoke() view returns (address)',
  'function localCentrifugeId() view returns (uint16)',
  'function relayer() view returns (address)',
  'function chainIdToCentrifugeId(uint256 evmChainId) view returns (uint16)',
])

const shareTokenAbi = parseAbi(['function decimals() view returns (uint8)'])

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
const testClient = createTestClient({
  chain: anvil,
  mode: 'anvil',
  transport: http(RPC_URL),
})

/**
 * Waits for a transaction and throws if it reverted.
 *
 * @param hash - transaction hash to await
 * @param label - what the transaction was doing, used in the error message
 * @throws when the transaction reverted, so a silent failure cannot be mistaken for success
 */
async function waitForSuccess(hash: Hex, label: string): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success')
    throw new Error(`${label} reverted (tx ${hash})`)
}

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
      'ETH_NODE_URI_MAINNET is required: the demo runs against the real TokenBridge on a mainnet fork'
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

    const facetAbi = centrifugeFacetArtifact.abi

    // 1) deploy CentrifugeFacet pointed at the real bridge
    const deployHash = await walletClient.deployContract({
      abi: facetAbi,
      bytecode: centrifugeFacetArtifact.bytecode.object,
      args: [TOKEN_BRIDGE],
    })
    const deployReceipt = await publicClient.waitForTransactionReceipt({
      hash: deployHash,
    })
    const facet = deployReceipt.contractAddress
    if (!facet) throw new Error('facet deployment produced no address')
    consola.success(`deployed facet=${facet} (bridge=${TOKEN_BRIDGE})`)

    // the bridge validates the destination against its own map; fail early if unmapped
    const destinationCentrifugeId = await publicClient.readContract({
      address: TOKEN_BRIDGE,
      abi: tokenBridgeAbi,
      functionName: 'chainIdToCentrifugeId',
      args: [BASE_CHAIN_ID],
    })
    if (destinationCentrifugeId === 0)
      throw new Error(
        `Base (${BASE_CHAIN_ID}) has no centrifugeId on the bridge (fork too old?)`
      )
    const relayer = await publicClient.readContract({
      address: TOKEN_BRIDGE,
      abi: tokenBridgeAbi,
      functionName: 'relayer',
    })
    consola.info(
      `destination centrifugeId=${destinationCentrifugeId}, relayer=${relayer}`
    )

    // 2) source the share token from a real holder
    const decimals = await publicClient.readContract({
      address: SHARE_TOKEN,
      abi: shareTokenAbi,
      functionName: 'decimals',
    })
    const bridgeAmount = parseUnits('10', decimals)

    await testClient.impersonateAccount({ address: SHARE_TOKEN_WHALE })
    await testClient.setBalance({
      address: SHARE_TOKEN_WHALE,
      value: parseEther('1'),
    })
    const whaleClient = createWalletClient({
      account: SHARE_TOKEN_WHALE,
      chain: anvil,
      transport: http(RPC_URL),
    })
    await waitForSuccess(
      await whaleClient.writeContract({
        address: SHARE_TOKEN,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [account.address, bridgeAmount],
      }),
      'share token transfer from whale'
    )
    await testClient.stopImpersonatingAccount({ address: SHARE_TOKEN_WHALE })

    const balanceOf = (holder: Address): Promise<bigint> =>
      publicClient.readContract({
        address: SHARE_TOKEN,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [holder],
      })
    const senderSharesBefore = await balanceOf(account.address)
    if (senderSharesBefore < bridgeAmount)
      throw new Error(
        `share token funding failed: got ${senderSharesBefore}, expected >= ${bridgeAmount}. Has ${SHARE_TOKEN_WHALE} sold out?`
      )

    // 3) approve the facet - the bridge pulls the shares from its caller (the facet)
    await waitForSuccess(
      await walletClient.writeContract({
        address: SHARE_TOKEN,
        abi: erc20Abi,
        functionName: 'approve',
        args: [facet, bridgeAmount],
      }),
      'share token approval'
    )
    consola.info(`funded + approved ${bridgeAmount} deJAAA to the facet`)

    // 4) execute the bridge with a deliberate overpayment
    const refundRecipient: Address =
      '0x000000000000000000000000000000000000bEEF'
    const bridgeData = {
      transactionId: padHex('0x11', { size: 32 }),
      bridge: 'centrifuge',
      integrator: 'demoScript',
      referrer: '0x0000000000000000000000000000000000000000' as Address,
      sendingAssetId: SHARE_TOKEN,
      receiver: refundRecipient, // end user on Base
      minAmount: bridgeAmount,
      destinationChainId: BASE_CHAIN_ID,
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }
    const centrifugeData = {
      nativeFee: NATIVE_FEE,
      refundRecipient, // receives excess native and the Gateway's fee surplus
    }

    const refundBefore = await publicClient.getBalance({
      address: refundRecipient,
    })

    const txHash = await walletClient.writeContract({
      address: facet,
      abi: facetAbi,
      functionName: 'startBridgeTokensViaCentrifuge',
      args: [bridgeData, centrifugeData],
      value: NATIVE_FEE,
    })
    await waitForSuccess(txHash, 'bridge')
    consola.success(`✅ bridge tx: ${txHash}`)

    // 5) assert the real funds flow
    const senderSharesAfter = await balanceOf(account.address)
    const facetShares = await balanceOf(facet)
    const facetNative = await publicClient.getBalance({ address: facet })
    const refundAfter = await publicClient.getBalance({
      address: refundRecipient,
    })
    const refunded = refundAfter - refundBefore
    const consumedFee = NATIVE_FEE - refunded

    consola.info(
      `shares sent: ${
        senderSharesBefore - senderSharesAfter
      } (expected ${bridgeAmount})`
    )
    consola.info(
      `messaging fee consumed: ${consumedFee} wei, refunded to refundRecipient: ${refunded} wei`
    )
    consola.info(
      `facet residue - shares: ${facetShares}, native: ${facetNative}`
    )

    if (senderSharesBefore - senderSharesAfter !== bridgeAmount)
      throw new Error('the bridged share amount did not leave the sender')
    if (facetShares !== 0n || facetNative !== 0n)
      throw new Error('the facet retained funds after bridging')
    if (refunded <= 0n)
      throw new Error(
        'the Gateway did not refund the fee surplus to refundRecipient'
      )
    if (consumedFee <= 0n)
      throw new Error('no messaging fee was consumed - was the message sent?')

    consola.success(
      'Centrifuge demo completed against the REAL TokenBridge: share-token pull, messaging-fee payment, surplus refund and zero facet residue verified on the mainnet fork ✔'
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
