/**
 * confirmOwnershipForMax.ts — STEP 2 of the ERC20Proxy ownership remediation.
 *
 * For each of the two-step proxies it calls confirmOwnershipTransfer() from the
 * refundWallet, finalising the transfer SC initiated in step 1 (which set
 * pendingOwner = refundWallet). Reads the network + proxy list from the committed
 * manifest and RPCs from config/networks.json (preferring ETH_NODE_URI_<NET> if set),
 * so nothing sensitive is embedded.
 *
 * Idempotent & resumable: reads on-chain state first and skips anything already done
 * or not yet ready (SC step 1 still pending). Re-run freely.
 *
 * SAFETY: dry-run by default; pass --broadcast to sign/send. Never prints the key or
 * full RPC URLs. Reads the key from PRIVATE_KEY_REFUND_WALLET (override with --key-env NAME).
 *
 *   set -a; . ./.env; set +a          # must expose the refundWallet key
 *   bunx tsx script/tasks/confirmOwnershipForMax.ts                 # dry-run
 *   bunx tsx script/tasks/confirmOwnershipForMax.ts --broadcast     # finalise everything ready
 *   bunx tsx script/tasks/confirmOwnershipForMax.ts --broadcast --only polygon,bsc
 *
 * NOTE: single-step chains (moonbeam et al.) are NOT here — they finalise in step 1.
 * tron is a separate troncast stream. If confirm would revert NotPendingOwner, SC has
 * not run step 1 on that chain yet — the script pre-checks and marks it NOT_READY.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  getAddress,
  parseAbi,
  formatEther,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const REPO = process.env.REPO_DIR || process.cwd()
const argv = process.argv.slice(2)
const BROADCAST = argv.includes('--broadcast')
const KEY_ENV =
  argv.find((a) => a.startsWith('--key-env='))?.split('=')[1] ||
  'PRIVATE_KEY_REFUND_WALLET'
const ONLY = (
  argv.find((a) => a.startsWith('--only='))?.split('=')[1] ||
  (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] ?? '' : '')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const STATE_PATH =
  argv.find((a) => a.startsWith('--state='))?.split('=')[1] ||
  `${REPO}/confirm-ownership-state.json`

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

const firstLine = (m: string, n = 80): string =>
  (m.split('\n')[0] ?? m).slice(0, n)
const normKey = (k: string): Hex => {
  const t = (k || '').trim()
  return (t.startsWith('0x') ? t : `0x${t}`) as Hex
}

const rawKey = process.env[KEY_ENV] || ''
if (!rawKey.trim())
  throw new Error(
    `${KEY_ENV} not set — source the .env that holds the refundWallet key`
  )
const ACCOUNT = privateKeyToAccount(normKey(rawKey))
if (getAddress(ACCOUNT.address) !== REFUND)
  throw new Error(
    `${KEY_ENV} derives ${ACCOUNT.address}, expected refundWallet ${REFUND} — wrong key, aborting`
  )

const abi = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function confirmOwnershipTransfer()',
])

interface IEntry {
  network: string
  erc20Proxy: string
}
const entries: IEntry[] = (manifest.evmTwoStep as IEntry[]).filter((e) =>
  ONLY.length ? ONLY.includes(e.network) : true
)

type StateRecord = Record<string, unknown>
const state: Record<string, StateRecord> = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  : {}
const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
const fmt = (w: bigint) => Number(formatEther(w)).toFixed(8)
const NOW = process.env.RUN_TS || 'run'

function clientsFor(net: string) {
  const n = networks[net]
  const rpc =
    process.env[`ETH_NODE_URI_${net.toUpperCase()}`]?.trim() || n.rpcUrl
  const chain = defineChain({
    id: Number(n.chainId),
    name: net,
    nativeCurrency: {
      name: n.nativeCurrency || 'ETH',
      symbol: n.nativeCurrency || 'ETH',
      decimals: 18,
    },
    rpcUrls: { default: { http: [rpc] } },
  })
  const transport = http(rpc, {
    timeout: 20_000,
    retryCount: 2,
    retryDelay: 800,
  })
  return {
    pub: createPublicClient({ chain, transport }),
    wallet: createWalletClient({ account: ACCOUNT, chain, transport }),
  }
}

async function processChain(e: IEntry) {
  const proxy = getAddress(e.erc20Proxy)
  const { pub, wallet } = clientsFor(e.network)
  const rec: StateRecord = state[e.network] || {}

  let owner: Address, pending: Address
  try {
    owner = getAddress(
      await pub.readContract({ address: proxy, abi, functionName: 'owner' })
    )
    pending = getAddress(
      await pub
        .readContract({ address: proxy, abi, functionName: 'pendingOwner' })
        .catch(() => ZERO)
    )
  } catch (err) {
    console.log(
      `✗ ${e.network}: unreachable (${firstLine((err as Error).message, 60)})`
    )
    rec.status = 'UNREACHABLE'
    rec.updated = NOW
    state[e.network] = rec
    return save()
  }

  if (owner === REFUND) {
    console.log(`✓ ${e.network}: already owned by refundWallet — done`)
    rec.status = 'DONE'
    rec.updated = NOW
    state[e.network] = rec
    return save()
  }
  if (pending !== REFUND) {
    console.log(
      `… ${e.network}: NOT READY (pendingOwner=${pending}) — SC step 1 not done yet`
    )
    rec.status = 'NOT_READY'
    rec.updated = NOW
    state[e.network] = rec
    return save()
  }

  const gasPrice = await pub.getGasPrice().catch(() => 0n)
  const bal = await pub.getBalance({ address: ACCOUNT.address })
  if (gasPrice > 0n) {
    const need = (60_000n * gasPrice * 15n) / 10n // ~confirm gas x1.5
    if (bal < need) {
      console.log(
        `⚠ ${e.network}: refundWallet underfunded (${fmt(bal)} < ~${fmt(
          need
        )}) — fund refundWallet then re-run`
      )
      rec.status = 'REFUND_UNDERFUNDED'
      rec.updated = NOW
      state[e.network] = rec
      return save()
    }
  }

  console.log(`→ ${e.network}: confirmOwnershipTransfer()  proxy=${proxy}`)
  if (BROADCAST) {
    const h = await wallet.writeContract({
      address: proxy,
      abi,
      functionName: 'confirmOwnershipTransfer',
    })
    await pub.waitForTransactionReceipt({ hash: h })
    const o2 = getAddress(
      await pub.readContract({ address: proxy, abi, functionName: 'owner' })
    )
    rec.confirmTx = h
    rec.owner = o2
    rec.status = o2 === REFUND ? 'DONE' : 'VERIFY_FAILED'
    console.log(
      `   ${e.network}: ${rec.status}${
        rec.status === 'DONE' ? '' : ` (owner=${o2})`
      }`
    )
  } else {
    rec.status = 'DRYRUN_READY'
  }
  rec.updated = NOW
  state[e.network] = rec
  save()
}

;(async () => {
  console.log(
    `Mode: ${BROADCAST ? 'BROADCAST' : 'DRY-RUN'} | signer: refundWallet ${
      ACCOUNT.address
    } | chains: ${entries.length}\n`
  )
  for (const e of entries) {
    try {
      await processChain(e)
    } catch (err) {
      console.log(`✗ ${e.network}: ERROR ${firstLine((err as Error).message)}`)
      state[e.network] = {
        ...(state[e.network] || {}),
        status: 'ERROR',
        error: firstLine((err as Error).message, 120),
        updated: NOW,
      }
      save()
    }
  }
  console.log('\n════ SUMMARY ════')
  const statusOf = (n: string): string =>
    (state[n]?.status as string | undefined) ?? '—'
  const by: Record<string, string[]> = {}
  for (const e of entries) (by[statusOf(e.network)] ||= []).push(e.network)
  for (const [s, ns] of Object.entries(by).sort())
    console.log(`${s} (${ns.length}): ${ns.sort().join(' ')}`)
  const pending = entries.filter((e) => statusOf(e.network) !== 'DONE')
  if (pending.length && BROADCAST)
    console.log(
      `\nRe-run to finish ${pending.length}:  ... --broadcast --only ${pending
        .map((e) => e.network)
        .join(',')}`
    )
})()
