/**
 * verifyOwnership.ts — READ-ONLY status of the ERC20Proxy ownership remediation.
 * No keys, no writes. For every proxy it reads owner()/pendingOwner() and prints a
 * verdict: DONE (owner==refundWallet) | AWAITING-MAX (pendingOwner==refundWallet, step-1
 * done, step-2 pending) | NOT-STARTED (still the old owner) | UNREACHABLE.
 *
 *   bunx tsx script/tasks/verifyOwnership.ts            # all
 *   bunx tsx script/tasks/verifyOwnership.ts --only polygon,bsc
 */
import { readFileSync } from 'node:fs'

import {
  createPublicClient,
  http,
  getAddress,
  parseAbi,
  type Address,
} from 'viem'

const REPO = process.env.REPO_DIR || process.cwd()
const argv = process.argv.slice(2)
const ONLY = (
  argv.find((a) => a.startsWith('--only='))?.split('=')[1] ||
  (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] ?? '' : '')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const manifest = JSON.parse(
  readFileSync(
    `${REPO}/script/tasks/ownership-remediation-manifest.json`,
    'utf8'
  )
)
const networks = JSON.parse(
  readFileSync(`${REPO}/config/networks.json`, 'utf8')
)
const REFUND = getAddress(manifest.refundWallet)
const ZERO = '0x0000000000000000000000000000000000000000'
const abi = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
])

interface IRow {
  network: string
  proxy: Address
  mode: 'two-step' | 'single-step'
}
const rows: IRow[] = [
  ...manifest.evmTwoStep.map((e: { network: string; erc20Proxy: string }) => ({
    network: e.network,
    proxy: getAddress(e.erc20Proxy),
    mode: 'two-step' as const,
  })),
  ...manifest.evmSingleStep.map(
    (e: { network: string; erc20Proxy: string }) => ({
      network: e.network,
      proxy: getAddress(e.erc20Proxy),
      mode: 'single-step' as const,
    })
  ),
].filter((r) => (ONLY.length ? ONLY.includes(r.network) : true))

async function verdictFor(r: IRow): Promise<string> {
  const n = networks[r.network]
  const rpc =
    process.env[`ETH_NODE_URI_${r.network.toUpperCase()}`]?.trim() || n.rpcUrl
  const client = createPublicClient({
    transport: http(rpc, { timeout: 15_000, retryCount: 2, retryDelay: 700 }),
  })
  try {
    const owner = getAddress(
      await client.readContract({
        address: r.proxy,
        abi,
        functionName: 'owner',
      })
    )
    if (owner === REFUND) return 'DONE'
    if (r.mode === 'single-step') return 'NOT-STARTED'
    const pending = getAddress(
      await client
        .readContract({ address: r.proxy, abi, functionName: 'pendingOwner' })
        .catch(() => ZERO)
    )
    return pending === REFUND ? 'AWAITING-MAX' : 'NOT-STARTED'
  } catch {
    return 'UNREACHABLE'
  }
}

;(async () => {
  // bounded concurrency
  const out: { network: string; verdict: string }[] = []
  let i = 0
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (i < rows.length) {
        const r = rows[i++]
        if (!r) break
        out.push({ network: r.network, verdict: await verdictFor(r) })
      }
    })
  )
  const by: Record<string, string[]> = {}
  for (const o of out) (by[o.verdict] ||= []).push(o.network)
  console.log(`refundWallet target: ${REFUND}\n`)
  for (const v of ['DONE', 'AWAITING-MAX', 'NOT-STARTED', 'UNREACHABLE'])
    if (by[v]) console.log(`${v} (${by[v].length}): ${by[v].sort().join(' ')}`)
  const done = (by['DONE'] || []).length
  console.log(
    `\n${done}/${rows.length} fully transferred to refundWallet.` +
      (done === rows.length ? ' ✅ COMPLETE' : ' — not complete yet.')
  )
  console.log('(tron is separate — verify via troncast.)')
})()
