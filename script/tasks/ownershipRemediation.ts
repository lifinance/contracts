/**
 * ownershipRemediation.ts — one-shot, idempotent, resumable remediation of ERC20Proxy
 * ownership from COMPROMISED old deployer wallets to refundWallet.
 *
 * Per network, done BACK-TO-BACK to minimise the funding-exposure window on the
 * compromised wallet:
 *   1. read on-chain state → skip if already remediated (resume/idempotency)
 *   2. fund the old owner with the MINIMUM gas needed (transfer + sweep-back), only
 *      the shortfall, and only if the current deployer has the gas to spare
 *   3. transferOwnership(refundWallet) from the old owner key
 *        - two-step proxies (38): sets pendingOwner (REVERSIBLE; Max confirms later)
 *        - single-step OZ Ownable proxies (30, incl. moonbeam): finalises IMMEDIATELY (IRREVERSIBLE, no Max step)
 *   4. sweep the old owner's remaining native back to the current deployer
 *      (also rescues any pre-existing balance off the compromised wallet)
 *   5. verify + persist per-network state; a re-run picks up only what's incomplete
 *
 * SAFETY: dry-run by default. Pass --broadcast to sign/send. Secrets hygiene: never
 * prints private keys or full RPC URLs. Reads keys from the environment (source .env first).
 *
 *   set -a; . ./.env; set +a
 *   NODE_PATH=./node_modules bunx tsx ownershipRemediation.ts            # dry-run
 *   NODE_PATH=./node_modules bunx tsx ownershipRemediation.ts --broadcast
 *   ... --only polygon,bsc     # restrict to specific networks
 *   ... --state ./remediation-state.json
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
const ONLY = (
  argv.find((a) => a.startsWith('--only='))?.split('=')[1] ||
  (argv.includes('--only') ? argv[argv.indexOf('--only') + 1] ?? '' : '')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// first line of an error message, safe against empty splits (strict TS)
const firstLine = (m: string, n = 90): string =>
  (m.split('\n')[0] ?? m).slice(0, n)
const STATE_PATH =
  argv.find((a) => a.startsWith('--state='))?.split('=')[1] ||
  `${REPO}/ownership-remediation-state.json`
const MANIFEST_PATH =
  argv.find((a) => a.startsWith('--manifest='))?.split('=')[1] ||
  `${REPO}/script/tasks/ownership-remediation-manifest.json`

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
const networks = JSON.parse(
  readFileSync(`${REPO}/config/networks.json`, 'utf8')
)
const REFUND = getAddress(manifest.refundWallet)

const abi = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newOwner)',
])
const ZERO = '0x0000000000000000000000000000000000000000'

// keys in .env may lack the 0x prefix; viem requires it
const normKey = (k: string): Hex => {
  const t = (k || '').trim().replace(/^#.*$/, '')
  return (t.startsWith('0x') ? t : `0x${t}`) as Hex
}

// funder = current (safe) deployer
const rawFunder = process.env.PRIVATE_KEY_PRODUCTION || ''
if (!rawFunder.trim())
  throw new Error('PRIVATE_KEY_PRODUCTION (funder) not set — source .env')
const FUNDER = privateKeyToAccount(normKey(rawFunder))

interface IManifestEntry {
  network: string
  erc20Proxy: Address
  currentOwner: Address
  signerKey: string
}
interface IEntry extends IManifestEntry {
  mode: 'two-step' | 'single-step'
}
const entries: IEntry[] = [
  ...(manifest.evmTwoStep as IManifestEntry[]).map((e) => ({
    ...e,
    mode: 'two-step' as const,
  })),
  ...(manifest.evmSingleStep as IManifestEntry[]).map((e) => ({
    ...e,
    mode: 'single-step' as const,
  })),
].filter((e) => (ONLY.length ? ONLY.includes(e.network) : true))

type StateRecord = Record<string, unknown>
const state: Record<string, StateRecord> = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  : {}
const save = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))

function clientsFor(net: string, ownerKey: Hex) {
  const n = networks[net]
  // prefer authenticated ETH_NODE_URI_<UPPER> (has API keys, more reliable) over public rpcUrl
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
  const pub = createPublicClient({ chain, transport })
  const owner = createWalletClient({
    account: privateKeyToAccount(ownerKey),
    chain,
    transport,
  })
  const funder = createWalletClient({ account: FUNDER, chain, transport })
  return { pub, owner, funder }
}

async function processNetwork(e: IEntry) {
  const label = `${e.network}/${e.mode}`
  const rawOwnerKey = process.env[e.signerKey] || ''
  if (!rawOwnerKey.trim()) {
    console.log(`SKIP ${label}: $${e.signerKey} not set`)
    return
  }
  const ownerKey = normKey(rawOwnerKey)
  const oldOwnerAddr = privateKeyToAccount(ownerKey).address
  if (getAddress(oldOwnerAddr) !== getAddress(e.currentOwner)) {
    console.log(
      `SKIP ${label}: key ${e.signerKey} derives ${oldOwnerAddr}, manifest expects ${e.currentOwner}`
    )
    state[e.network] = { status: 'KEY_MISMATCH', updated: NOW }
    return save()
  }

  const { pub, owner, funder } = clientsFor(e.network, ownerKey)
  const rec: StateRecord = state[e.network] || {}
  rec.mode = e.mode
  rec.proxy = e.erc20Proxy

  // ---- 1. read on-chain state (source of truth for resume/idempotency) ----
  let curOwner: Address,
    pending: Address = ZERO as Address
  try {
    curOwner = getAddress(
      await pub.readContract({
        address: e.erc20Proxy,
        abi,
        functionName: 'owner',
      })
    )
    if (e.mode === 'two-step')
      pending = getAddress(
        await pub
          .readContract({
            address: e.erc20Proxy,
            abi,
            functionName: 'pendingOwner',
          })
          .catch(() => ZERO)
      )
  } catch (err) {
    console.log(
      `✗ ${label}: unreachable (${firstLine((err as Error).message, 60)})`
    )
    rec.status = 'UNREACHABLE'
    rec.updated = NOW
    state[e.network] = rec
    return save()
  }

  const ownedByRefund = curOwner === REFUND
  const transferAlreadyDone =
    ownedByRefund || (e.mode === 'two-step' && pending === REFUND)

  // ---- 2+3. fund (minimal) + transferOwnership (skip if already initiated) ----
  const gasPrice = await pub.getGasPrice().catch(() => 0n)
  if (gasPrice === 0n) {
    console.log(`✗ ${label}: gasPrice=0 / fee-token chain — handle manually`)
    rec.status = 'MANUAL'
    rec.updated = NOW
    state[e.network] = rec
    return save()
  }

  if (!transferAlreadyDone) {
    let gasTransfer = 60_000n
    try {
      gasTransfer = await pub.estimateContractGas({
        address: e.erc20Proxy,
        abi,
        functionName: 'transferOwnership',
        args: [REFUND],
        account: owner.account,
      })
    } catch {}
    const sweepReserve = 21_000n * 3n // headroom for the later sweep tx (L2 L1-fee buffer)
    const needed = ((gasTransfer + sweepReserve) * gasPrice * 15n) / 10n // 1.5x
    const bal = await pub.getBalance({ address: oldOwnerAddr })

    if (bal < needed) {
      const topup = needed - bal
      const srcBal = await pub.getBalance({ address: FUNDER.address })
      if (srcBal < topup + needed) {
        // funder needs its own gas too
        console.log(
          `⚠ ${label}: SOURCE UNDERFUNDED (funder has ${fmt(
            srcBal
          )}, needs ~${fmt(topup)}) — bridge gas to funder first`
        )
        rec.status = 'SOURCE_UNDERFUNDED'
        rec.needTopup = topup.toString()
        rec.updated = NOW
        state[e.network] = rec
        return save()
      }
      console.log(
        `→ ${label}: fund old owner ${fmt(topup)} (bal ${fmt(
          bal
        )} < needed ${fmt(needed)})`
      )
      if (BROADCAST) {
        const h = await funder.sendTransaction({
          to: oldOwnerAddr,
          value: topup,
        })
        await pub.waitForTransactionReceipt({ hash: h })
        rec.fundTx = h
      }
    } else {
      console.log(
        `→ ${label}: old owner already funded (${fmt(bal)} ≥ ${fmt(
          needed
        )}) — no top-up`
      )
    }

    console.log(
      `→ ${label}: transferOwnership(refundWallet) from ${e.signerKey}${
        e.mode === 'single-step' ? '  [IRREVERSIBLE]' : ''
      }`
    )
    if (BROADCAST) {
      const h = await owner.writeContract({
        address: e.erc20Proxy,
        abi,
        functionName: 'transferOwnership',
        args: [REFUND],
      })
      await pub.waitForTransactionReceipt({ hash: h })
      rec.transferTx = h
    }
  } else {
    console.log(
      `✓ ${label}: transfer already ${
        ownedByRefund
          ? 'FINALISED (owner=refund)'
          : 'initiated (pendingOwner=refund)'
      } — skipping transfer`
    )
  }

  // ---- 4. sweep remaining native back to current deployer ----
  const bal2 = await pub.getBalance({ address: oldOwnerAddr })
  const reserve = 21_000n * gasPrice * 3n
  if (bal2 > reserve) {
    const sweep = bal2 - reserve
    console.log(`→ ${label}: sweep ${fmt(sweep)} back to current deployer`)
    if (BROADCAST) {
      const h = await owner.sendTransaction({
        to: FUNDER.address,
        value: sweep,
      })
      await pub.waitForTransactionReceipt({ hash: h })
      rec.sweepTx = h
    }
  } else {
    console.log(`   ${label}: nothing to sweep (bal ${fmt(bal2)} ≤ reserve)`)
  }

  // ---- 5. verify + record ----
  if (BROADCAST) {
    const o2 = getAddress(
      await pub.readContract({
        address: e.erc20Proxy,
        abi,
        functionName: 'owner',
      })
    )
    const p2 =
      e.mode === 'two-step'
        ? getAddress(
            await pub
              .readContract({
                address: e.erc20Proxy,
                abi,
                functionName: 'pendingOwner',
              })
              .catch(() => ZERO)
          )
        : (ZERO as Address)
    const ok =
      e.mode === 'single-step' ? o2 === REFUND : o2 === REFUND || p2 === REFUND
    rec.status = ok
      ? e.mode === 'single-step'
        ? 'DONE_FINALISED'
        : 'TRANSFER_INITIATED_AWAIT_MAX'
      : 'VERIFY_FAILED'
    rec.owner = o2
    rec.pendingOwner = p2
    console.log(`   ${label}: ${rec.status}`)
  } else {
    rec.status = transferAlreadyDone
      ? 'DRYRUN_ALREADY_DONE'
      : 'DRYRUN_WOULD_ACT'
  }
  rec.updated = NOW
  state[e.network] = rec
  save()
}

const fmt = (w: bigint) => `${Number(formatEther(w)).toFixed(8)}`
let NOW = ''

;(async () => {
  NOW = process.env.RUN_TS || 'run' // avoid Date.* in some sandboxes; ts is cosmetic
  console.log(
    `Mode: ${BROADCAST ? 'BROADCAST' : 'DRY-RUN'} | networks: ${
      entries.length
    } | state: ${STATE_PATH}\n`
  )
  // sequential (per-network back-to-back) to minimise exposure on compromised wallets
  for (const e of entries) {
    try {
      await processNetwork(e)
    } catch (err) {
      console.log(
        `✗ ${e.network}: ERROR ${firstLine((err as Error).message, 80)}`
      )
      state[e.network] = {
        ...(state[e.network] || {}),
        status: 'ERROR',
        error: (err as Error).message.slice(0, 120),
        updated: NOW,
      }
      save()
    }
  }
  // ---- final per-network report + what to re-run ----
  console.log('\n════ SUMMARY ════')
  const statusOf = (net: string): string =>
    (state[net]?.status as string | undefined) ?? '—'
  const by: Record<string, string[]> = {}
  for (const e of entries) {
    ;(by[statusOf(e.network)] ||= []).push(e.network)
  }
  for (const [s, ns] of Object.entries(by).sort())
    console.log(`${s} (${ns.length}): ${ns.join(' ')}`)
  const incomplete = entries.filter(
    (e) =>
      !['DONE_FINALISED', 'TRANSFER_INITIATED_AWAIT_MAX'].includes(
        statusOf(e.network)
      )
  )
  if (incomplete.length && BROADCAST)
    console.log(
      `\nRe-run to finish ${
        incomplete.length
      }:  ... --broadcast --only ${incomplete.map((e) => e.network).join(',')}`
    )
  console.log(
    '\nNOTE: two-step chains still need Max to run confirmOwnershipTransfer() from refundWallet.'
  )
  console.log(
    'NOTE: tron is separate (troncast). moonbeam is single-step (already finalised above).'
  )
})()
