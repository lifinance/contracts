/**
 * atomicBatch7702.ts — run one or more contract calls atomically from an EOA using an
 * EIP-7702 sponsored transaction.
 *
 * The EOA ("authority") delegates its code to the canonical Multicall3 (deployed at the
 * same address on every EVM chain) via a signed 7702 authorization, and a "sponsor"
 * account submits and pays for a single type-4 transaction that runs Multicall3.aggregate3
 * in the authority's context — so every call executes with `msg.sender == authority`,
 * all-or-nothing.
 *
 * Two shapes:
 *   - sponsored  (authorityKeyEnv != sponsorKeyEnv): sponsor pays, authority only signs.
 *     The authority never needs a native balance — ideal for gas-starved or actively-swept
 *     EOAs, since there is no funding tx for a sweeper bot to front-run.
 *   - self       (authorityKeyEnv omitted / == sponsorKeyEnv): one EOA batches its own
 *     calls atomically.
 *
 * DRY-RUN by default (signs the auth, simulates the whole authorized batch + estimates the
 * tx, sends nothing). Pass --broadcast to execute.
 *
 * After a successful batch the authority is UNDELEGATED by default (a second sponsored
 * tx resets its code to empty), so no open delegate is left behind — an open delegate on
 * a funded account is drainable by anyone. Pass --keep-delegation to skip this (only with
 * an access-restricted delegate meant to persist).
 *
 * Usage:
 *   bunx tsx script/tasks/atomicBatch7702.ts --config <path.json> [--broadcast] [--keep-delegation]
 *
 * Config JSON:
 *   {
 *     "network": "arbitrum",                       // key in config/networks.json
 *     "sponsorKeyEnv": "PRIVATE_KEY_PRODUCTION",   // pays gas (default: PRIVATE_KEY_PRODUCTION)
 *     "authorityKeyEnv": "PRIVATE_KEY_...",        // signs auth; omit for self-batch
 *     "delegate": "0xcA11...",                     // optional; default Multicall3
 *     "calls": [
 *       { "target": "0x..", "function": "transferOwnership(address)", "args": ["0x156C.."] },
 *       { "target": "0x..", "data": "0x..." }      // raw calldata alternative
 *     ]
 *   }
 */
import 'dotenv/config'
import { readFileSync } from 'node:fs'

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  getAddress,
  encodeFunctionData,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

const AGGREGATE3_ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])',
])

interface ICallSpec {
  target: string
  function?: string
  args?: unknown[]
  data?: string
}
interface IBatchConfig {
  network: string
  sponsorKeyEnv?: string
  authorityKeyEnv?: string
  delegate?: string
  calls: ICallSpec[]
}

const argv = process.argv.slice(2)
const BROADCAST = argv.includes('--broadcast')
// Auto-clear the delegation after the batch by default. An open delegate (e.g.
// Multicall3) left on a funded account is drainable by anyone, so we undelegate unless
// the caller explicitly wants the delegation to persist (a restricted delegate).
const KEEP_DELEGATION = argv.includes('--keep-delegation')
const configPath =
  argv.find((a) => a.startsWith('--config='))?.split('=')[1] ||
  (argv.includes('--config') ? argv[argv.indexOf('--config') + 1] : '')
if (!configPath) throw new Error('missing --config <path.json>')

const REPO = process.env.REPO_DIR || process.cwd()
const cfg: IBatchConfig = JSON.parse(readFileSync(configPath, 'utf8'))
const networks = JSON.parse(
  readFileSync(`${REPO}/config/networks.json`, 'utf8')
)

function keyFromEnv(name: string): Hex {
  const v = process.env[name] || ''
  if (!v.trim()) throw new Error(`${name} not set — source .env`)
  return (v.startsWith('0x') ? v : `0x${v}`) as Hex
}

function errMsg(e: unknown): string {
  const x = e as { shortMessage?: string; message?: string }
  return String(x?.shortMessage || x?.message || e).replace(/\s+/g, ' ')
}

function callData(c: ICallSpec): Hex {
  if (c.data) return c.data as Hex
  if (!c.function)
    throw new Error(`call to ${c.target} needs "function" or "data"`)
  const name = c.function.slice(0, c.function.indexOf('(')).trim()
  // Signature is runtime input, so parseAbi's literal-type inference can't apply — cast.
  const abi = parseAbi([
    `function ${c.function}`,
  ] as unknown as readonly string[])
  return encodeFunctionData({
    abi,
    functionName: name,
    args: c.args ?? [],
  } as never)
}

async function main() {
  const n = networks[cfg.network]
  if (!n?.chainId) throw new Error(`unknown network ${cfg.network}`)
  const rpc =
    process.env[`ETH_NODE_URI_${cfg.network.toUpperCase()}`]?.trim() || n.rpcUrl
  const chain = defineChain({
    id: Number(n.chainId),
    name: cfg.network,
    nativeCurrency: {
      name: n.nativeCurrency || 'ETH',
      symbol: n.nativeCurrency || 'ETH',
      decimals: 18,
    },
    rpcUrls: { default: { http: [rpc] } },
  })
  const pub = createPublicClient({ chain, transport: http(rpc) })

  const sponsor = privateKeyToAccount(
    keyFromEnv(cfg.sponsorKeyEnv || 'PRIVATE_KEY_PRODUCTION')
  )
  const authorityEnv = cfg.authorityKeyEnv ?? ''
  const isSelf = !authorityEnv || authorityEnv === cfg.sponsorKeyEnv
  const authority = isSelf
    ? sponsor
    : privateKeyToAccount(keyFromEnv(authorityEnv))
  const delegate = getAddress(cfg.delegate || MULTICALL3)

  const wallet = createWalletClient({
    account: sponsor,
    chain,
    transport: http(rpc),
  })

  console.log(`network:   ${cfg.network} (chainId ${n.chainId})`)
  console.log(`authority: ${authority.address}${isSelf ? ' (self)' : ''}`)
  console.log(`sponsor:   ${sponsor.address}`)
  console.log(
    `delegate:  ${delegate}${delegate === MULTICALL3 ? ' (Multicall3)' : ''}`
  )
  console.log(
    `calls:     ${cfg.calls.length} | mode: ${
      BROADCAST ? 'BROADCAST' : 'DRY-RUN'
    }\n`
  )

  // Build the aggregate3 batch (allowFailure:false → atomic all-or-nothing).
  const calls3 = cfg.calls.map((c) => ({
    target: getAddress(c.target),
    allowFailure: false,
    callData: callData(c),
  }))
  const aggregateData = encodeFunctionData({
    abi: AGGREGATE3_ABI,
    functionName: 'aggregate3',
    args: [calls3],
  })

  // Sign the 7702 authorization FIRST (executor:'self' only when the authority also
  // sends), so we can simulate the full atomic batch with the delegation applied.
  // Simulating each call separately against pre-batch state would wrongly fail dependent
  // batches (e.g. approve then deposit), which only succeed once aggregate3 runs them
  // together in the authority's context.
  const authorization = await wallet.signAuthorization(
    isSelf
      ? { account: authority, contractAddress: delegate, executor: 'self' }
      : { account: authority, contractAddress: delegate }
  )
  console.log(
    `✓ signed 7702 authorization -> ${delegate} (nonce ${authorization.nonce})`
  )

  // Simulate the whole authorized aggregate3 tx; a revert aborts before we spend.
  try {
    await pub.call({
      account: sponsor,
      to: authority.address,
      data: aggregateData,
      authorizationList: [authorization],
    })
    console.log(
      `✓ simulation: authorized aggregate3 (${calls3.length} call(s)) succeeds`
    )
  } catch (e) {
    const m = errMsg(e)
    if (/revert/i.test(m)) {
      console.log(`✗ simulation reverted: ${m.slice(0, 140)}`)
      return
    }
    // Not a revert — likely an RPC that can't eth_call a 7702 tx. Warn, let estimateGas gate.
    console.log(
      `⚠ could not simulate (RPC may not support 7702 eth_call): ${m.slice(
        0,
        120
      )}`
    )
  }

  try {
    const gas = await pub.estimateGas({
      account: sponsor,
      to: authority.address,
      data: aggregateData,
      authorizationList: [authorization],
    })
    console.log(`✓ type-4 tx accepted (estimateGas ${gas})`)
  } catch (e) {
    console.log(`⚠ estimateGas for type-4 failed: ${errMsg(e).slice(0, 120)}`)
    if (!BROADCAST)
      console.log(
        "  (some RPCs can't estimate 7702 txs; broadcast may still work)"
      )
  }

  if (!BROADCAST) {
    console.log('\nDRY-RUN: no tx sent. Re-run with --broadcast to execute.')
    return
  }

  console.log('\n→ sending EIP-7702 sponsored transaction ...')
  const hash = await wallet.sendTransaction({
    authorizationList: [authorization],
    to: authority.address,
    data: aggregateData,
  })
  console.log(`  tx: ${hash}`)
  const rcpt = await pub.waitForTransactionReceipt({
    hash,
    pollingInterval: 200,
  })
  console.log(`receipt status: ${rcpt.status}`)
  console.log(
    rcpt.status === 'success'
      ? '✅ batch executed atomically'
      : '✗ tx reverted — investigate'
  )

  // Clear the delegation unless asked to keep it. A 7702 authorization is applied BEFORE
  // execution and is NOT rolled back if the batch reverts, so a mined-but-reverted tx also
  // leaves the delegate active — undelegate on any mined batch, not just successful ones.
  // Leaving an open delegate (Multicall3) lets anyone drive the authority afterwards.
  if (!KEEP_DELEGATION) {
    console.log('\n→ clearing delegation (authorization -> zero address) ...')
    const clearAuth = await wallet.signAuthorization({
      account: authority,
      contractAddress: zeroAddress,
    })
    const clearHash = await wallet.sendTransaction({
      authorizationList: [clearAuth],
      to: authority.address,
      data: '0x',
    })
    await pub.waitForTransactionReceipt({
      hash: clearHash,
      pollingInterval: 200,
    })
    const codeAfter =
      (await pub.getCode({ address: authority.address })) || '0x'
    console.log(
      codeAfter === '0x'
        ? `  ✅ delegation cleared (tx ${clearHash})`
        : `  ⚠ delegation still present (${codeAfter.slice(
            0,
            24
          )}) — re-run undelegate`
    )
  } else if (KEEP_DELEGATION) {
    console.log(
      '\n⚠ --keep-delegation set: authority remains delegated. Ensure the delegate is access-restricted (Multicall3 is NOT).'
    )
  }
}
main()
