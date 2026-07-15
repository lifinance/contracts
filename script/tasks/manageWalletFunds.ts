/**
 * Manage Wallet Funds
 *
 * Move, swap, or send funds from any wallet whose private key lives in `.env`,
 * routing through the LI.FI API. Three modes, one safety boundary:
 *
 *   bridge  cross-chain move of the gas asset, same wallet on both chains  (autonomous)
 *   swap    same-chain native <-> ERC-20, same wallet                       (autonomous)
 *   send    gas asset to a different recipient                              (requires --confirm)
 *
 * bridge/swap keep custody inside one wallet, so they are safe to run unattended.
 * send changes custody, so it refuses to broadcast without an explicit --confirm that
 * a human must supply — an agent must never set it on its own.
 *
 * USAGE
 *   bunx tsx script/tasks/manageWalletFunds.ts bridge --wallet devWallet \
 *     --from-network arbitrum --to-network bsc --amount 0.01 [--dry-run]
 *
 *   bunx tsx script/tasks/manageWalletFunds.ts swap --wallet devWallet \
 *     --network base --from-token native --to-token USDC --amount 0.01 [--dry-run]
 *
 *   bunx tsx script/tasks/manageWalletFunds.ts send --wallet devWallet \
 *     --network bsc --to 0xRecipient --amount 0.01 --confirm
 *
 * --wallet accepts a role from `config/global.json` `walletKeys` (devWallet, refundWallet, …)
 * or a raw 0x address that must match one of the keys present in `.env`.
 */
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'

import globalConfig from '../../config/global.json'
import { sleep } from '../utils/delay'
import {
  buildExplorerTxUrl,
  getViemChainForNetworkName,
  networks,
} from '../utils/viemScriptHelpers'
import {
  accountFromPrivateKey,
  assertSameWallet,
  assertSlippage,
  assertWithinSlippage,
  fetchLifiChains,
  fetchLifiQuote,
  fetchLifiStatus,
  fetchLifiTokens,
  flattenWalletKeys,
  isChainSupported,
  NATIVE_SENTINEL,
  normalizeTokenArg,
  parseAmount,
  resolveAmountSelection,
  resolveEnvKeyForRole,
  scanEnvForPrivateKeyVars,
  type IWalletKeysConfig,
  type WalletMode,
} from '../utils/walletFundsHelpers'

const walletKeys = globalConfig.walletKeys as IWalletKeysConfig

interface IResolvedWallet {
  address: Address
  privateKey: string
  /** How the wallet was addressed, for reporting (role name or "raw address"). */
  label: string
  envVar: string
}

/**
 * Resolve `--wallet` (a registry role or a raw address) to a usable key.
 * Never returns or logs the key material beyond the derived address; the key is
 * only carried so the caller can build a wallet client.
 */
function resolveWallet(walletArg: string): IResolvedWallet {
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(walletArg)

  // Candidate env vars: registry first, then any scratch keys in .env.
  const registry = flattenWalletKeys(walletKeys)
  const candidateVars = new Set<string>([
    ...Object.values(registry),
    ...scanEnvForPrivateKeyVars(process.env),
  ])

  if (!isAddress) {
    const envVar = resolveEnvKeyForRole(walletArg, walletKeys)
    if (!envVar)
      throw new Error(
        `Unknown wallet role "${walletArg}". Known roles: ${Object.keys(
          registry
        ).join(', ')}. Or pass a raw 0x address.`
      )
    const key = process.env[envVar]
    if (!key)
      throw new Error(
        `Role "${walletArg}" maps to ${envVar}, which is not set in .env.`
      )
    const address = accountFromPrivateKey(key).address
    assertKeyMatchesRole(walletArg, address)
    return { address, privateKey: key, label: walletArg, envVar }
  }

  // Raw address: find which .env key derives to it.
  const target = getAddress(walletArg)
  for (const envVar of candidateVars) {
    const key = process.env[envVar]
    if (!key) continue
    let derived: Address
    try {
      derived = accountFromPrivateKey(key).address
    } catch {
      continue
    }
    if (getAddress(derived) === target)
      return { address: target, privateKey: key, label: 'raw address', envVar }
  }
  throw new Error(
    `No key in .env derives to ${target}. This tool can only move funds from wallets we hold the key for.`
  )
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Resolve the address `global.json` records for a (possibly nested) role, so a role
 * like `backendSignerProduction` maps to `backendSigner.production`. Returns undefined
 * for roles with no recorded address (scratch keys), which simply can't be checked.
 */
function recordedAddressForRole(role: string): Address | undefined {
  const cfg = globalConfig as Record<string, unknown>
  const direct = cfg[role]
  if (typeof direct === 'string' && ADDRESS_RE.test(direct))
    return getAddress(direct)
  for (const [key, value] of Object.entries(cfg)) {
    if (
      value &&
      typeof value === 'object' &&
      role.startsWith(key) &&
      role.length > key.length
    ) {
      const sub = role.slice(key.length)
      const subKey = sub.charAt(0).toLowerCase() + sub.slice(1)
      const nested = (value as Record<string, unknown>)[subKey]
      if (typeof nested === 'string' && ADDRESS_RE.test(nested))
        return getAddress(nested)
    }
  }
  return undefined
}

/**
 * Refuse to operate a role whose `.env` key derives to a different address than
 * `global.json` records. A mistyped or stale key would otherwise let an autonomous
 * bridge/swap move a wallet the operator never intended; blocking is the safe default.
 * If a rotation is legitimate, `global.json` must be updated first.
 */
function assertKeyMatchesRole(role: string, derived: Address): void {
  const recorded = recordedAddressForRole(role)
  if (recorded && recorded !== getAddress(derived))
    throw new Error(
      `Refusing to proceed: the .env key for "${role}" derives to ${derived}, but global.json ` +
        `records ${recorded}. If the wallet was rotated, update config/global.json first.`
    )
}

function requireNetwork(name: string) {
  const net = networks[name]
  if (!net)
    throw new Error(`Unknown network "${name}" (not in config/networks.json).`)
  return net
}

const ERC20_MIN_ABI = erc20Abi

interface IResolvedToken {
  address: Address
  decimals: number
  symbol: string
  isNative: boolean
}

async function resolveToken(
  arg: string,
  chainId: number,
  nativeCurrency: string,
  publicClient: PublicClient
): Promise<IResolvedToken> {
  const normalized = normalizeTokenArg(arg)
  if (normalized === NATIVE_SENTINEL)
    return {
      address: NATIVE_SENTINEL,
      decimals: 18,
      symbol: nativeCurrency,
      isNative: true,
    }
  if (normalized !== 'SYMBOL') {
    const [decimals, symbol] = await Promise.all([
      publicClient.readContract({
        address: normalized,
        abi: ERC20_MIN_ABI,
        functionName: 'decimals',
      }),
      publicClient.readContract({
        address: normalized,
        abi: ERC20_MIN_ABI,
        functionName: 'symbol',
      }),
    ])
    return { address: normalized, decimals, symbol, isNative: false }
  }
  // Symbol: resolve via LI.FI token list, refuse on ambiguity.
  const tokens = await fetchLifiTokens(chainId)
  const matches = tokens.filter(
    (t) => t.symbol.toLowerCase() === arg.toLowerCase()
  )
  const [t, ...rest] = matches
  if (!t)
    throw new Error(
      `No token "${arg}" on chain ${chainId}. Pass a 0x address instead.`
    )
  if (rest.length > 0)
    throw new Error(
      `Ambiguous symbol "${arg}" on chain ${chainId} (${matches.length} matches). Pass a 0x address.`
    )
  return {
    address: getAddress(t.address),
    decimals: t.decimals,
    symbol: t.symbol,
    isNative: false,
  }
}

/** Reserve headroom so a native spend still leaves gas for its own transaction. */
async function nativeAmountFromPercent(
  publicClient: PublicClient,
  address: Address,
  percent: number
): Promise<bigint> {
  const balance = await publicClient.getBalance({ address })
  const wanted = (balance * BigInt(Math.round(percent * 100))) / 10000n
  const gasReserve = (balance * 3n) / 100n // ~3% headroom for gas
  const spendable = balance - gasReserve
  return wanted < spendable ? wanted : spendable > 0n ? spendable : 0n
}

async function broadcastQuoteTx(
  walletClient: WalletClient,
  tx: {
    to: Address
    data: Hex
    value?: string
    gasLimit?: string
    gasPrice?: string
  }
): Promise<Hex> {
  if (!walletClient.account) throw new Error('wallet client missing account')
  return walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value ? BigInt(tx.value) : 0n,
    gas: tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    gasPrice: tx.gasPrice ? BigInt(tx.gasPrice) : undefined,
  } as Parameters<typeof walletClient.sendTransaction>[0])
}

async function ensureAllowance(
  publicClient: PublicClient,
  walletClient: WalletClient,
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint
): Promise<void> {
  const current = (await publicClient.readContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  })) as bigint
  if (current >= amount) return
  consola.info(`Approving ${spender} to spend token ${token}…`)
  const hash = await walletClient.writeContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: 'approve',
    args: [spender, amount],
  } as unknown as Parameters<typeof walletClient.writeContract>[0])
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success')
    throw new Error(`Approval transaction reverted (${hash}).`)
}

async function pollBridgeStatus(
  txHash: string,
  fromChain: number,
  toChain: number
): Promise<void> {
  const deadline = 180 // seconds
  const stepSeconds = 10
  for (let waited = 0; waited <= deadline; waited += stepSeconds) {
    const status = await fetchLifiStatus({ txHash, fromChain, toChain })
    consola.info(
      `  bridge status: ${status.status}${
        status.substatus ? ` (${status.substatus})` : ''
      }`
    )
    if (status.status === 'DONE') {
      consola.success('Destination funds delivered.')
      return
    }
    if (status.status === 'FAILED')
      throw new Error(
        `Bridge reported FAILED: ${
          status.substatusMessage ?? status.substatus ?? 'unknown reason'
        }`
      )
    await sleep(stepSeconds * 1000)
  }
  consola.warn(
    `Still pending after ${deadline}s. Destination arrival is asynchronous — track it at ` +
      `https://scan.li.fi/tx/${txHash}`
  )
}

const main = defineCommand({
  meta: {
    name: 'manage-wallet-funds',
    description:
      'Bridge, swap, or send funds from an .env wallet via the LI.FI API',
  },
  args: {
    mode: {
      type: 'positional',
      description: 'bridge | swap | send',
      required: true,
    },
    wallet: {
      type: 'string',
      description: 'role (devWallet, …) or 0x address',
      required: true,
    },
    'from-network': { type: 'string', description: 'source chain (bridge)' },
    'to-network': { type: 'string', description: 'destination chain (bridge)' },
    network: { type: 'string', description: 'chain (swap/send)' },
    'from-token': {
      type: 'string',
      description: 'native | 0x… | symbol (swap)',
    },
    'to-token': { type: 'string', description: 'native | 0x… | symbol (swap)' },
    to: { type: 'string', description: 'recipient address (send)' },
    amount: { type: 'string', description: 'human amount of the input asset' },
    percent: {
      type: 'string',
      description: 'percent of native balance instead of --amount',
    },
    'max-slippage': {
      type: 'string',
      description: 'max value loss %, default 3',
    },
    'dry-run': {
      type: 'boolean',
      description: 'quote + report only, never broadcast',
    },
    confirm: {
      type: 'boolean',
      description: 'required for send (human-supplied)',
    },
  },
  async run({ args }) {
    const mode = args.mode as WalletMode
    if (!['bridge', 'swap', 'send'].includes(mode))
      throw new Error(`Unknown mode "${mode}". Use bridge | swap | send.`)

    const maxSlippage = args['max-slippage'] ? Number(args['max-slippage']) : 3
    assertSlippage(maxSlippage)
    const dryRun = !!args['dry-run']

    const wallet = resolveWallet(args.wallet)
    consola.info(
      `Wallet: ${wallet.address} (${wallet.label}, from ${wallet.envVar})`
    )

    if (mode === 'send') {
      await runSend(args, wallet, dryRun)
      return
    }

    // bridge / swap share the LI.FI-routed, same-wallet path.
    const isBridge = mode === 'bridge'
    const srcName = isBridge ? args['from-network'] : args.network
    const dstName = isBridge ? args['to-network'] : args.network
    if (!srcName || !dstName)
      throw new Error(
        isBridge
          ? '--from-network and --to-network are required for bridge.'
          : '--network is required for swap.'
      )

    const srcNet = requireNetwork(srcName)
    const dstNet = requireNetwork(dstName)

    // Chain-support guard (the honest cost of routing through the API only).
    const lifiChains = await fetchLifiChains()
    for (const [label, name, net] of [
      ['source', srcName, srcNet],
      ['destination', dstName, dstNet],
    ] as const) {
      if (!isChainSupported(net.chainId, lifiChains))
        throw new Error(
          `${label} chain "${name}" (id ${net.chainId}) is not indexed by the LI.FI API yet — ` +
            'move funds there manually, or wait until it is live in the aggregator.'
        )
    }

    const srcChain = getViemChainForNetworkName(srcName)
    const publicClient = createPublicClient({
      chain: srcChain,
      transport: http(),
    }) as PublicClient
    const walletClient = createWalletClient({
      chain: srcChain,
      transport: http(),
      account: accountFromPrivateKey(wallet.privateKey),
    })

    const fromTokenArg = isBridge ? 'native' : args['from-token']
    const toTokenArg = isBridge ? 'native' : args['to-token']
    if (!fromTokenArg || !toTokenArg)
      throw new Error('swap requires --from-token and --to-token.')

    const fromToken = await resolveToken(
      fromTokenArg,
      srcNet.chainId,
      srcNet.nativeCurrency,
      publicClient
    )
    const toToken = await resolveToken(
      toTokenArg,
      dstNet.chainId,
      dstNet.nativeCurrency,
      publicClient
    )

    // Amount in the input asset's base units.
    const percentSel = resolveAmountSelection(args.amount, args.percent)
    let fromAmount: bigint
    if (percentSel !== null) {
      if (!fromToken.isNative)
        throw new Error(
          '--percent is only supported when the input asset is native.'
        )
      fromAmount = await nativeAmountFromPercent(
        publicClient,
        wallet.address,
        percentSel
      )
    } else {
      fromAmount = parseAmount(args.amount as string, fromToken.decimals)
    }
    if (fromAmount <= 0n) throw new Error('Resolved amount is zero.')

    const quote = await fetchLifiQuote({
      fromChain: srcNet.chainId,
      toChain: dstNet.chainId,
      fromToken: fromToken.address,
      toToken: toToken.address,
      fromAddress: wallet.address,
      toAddress: wallet.address,
      fromAmount: fromAmount.toString(),
      slippage: maxSlippage / 100,
    })

    // Same-wallet boundary: the quote is requested with toAddress == fromAddress == our
    // wallet; verify the returned route echoes that, so any recipient drift is caught
    // before signing.
    if (quote.action.fromAddress)
      assertSameWallet(wallet.address, quote.action.fromAddress)
    if (quote.action.toAddress)
      assertSameWallet(wallet.address, quote.action.toAddress)

    const { lossPct } = assertWithinSlippage(
      quote.estimate.fromAmountUSD,
      quote.estimate.toAmountUSD,
      maxSlippage
    )

    // Pre-flight report (always printed).
    consola.box(
      [
        `Mode:        ${mode}`,
        `Wallet:      ${wallet.address} (${wallet.label})`,
        `From:        ${formatUnits(fromAmount, fromToken.decimals)} ${
          fromToken.symbol
        } on ${srcName} (chain ${srcNet.chainId})`,
        `To:          ~${formatUnits(
          BigInt(quote.estimate.toAmount),
          toToken.decimals
        )} ${toToken.symbol} on ${dstName} (chain ${dstNet.chainId})`,
        `Min out:     ${formatUnits(
          BigInt(quote.estimate.toAmountMin),
          toToken.decimals
        )} ${toToken.symbol}`,
        `Value loss:  ${lossPct.toFixed(2)}% (cap ${maxSlippage}%)`,
        `Route/tool:  ${quote.tool}`,
        `Recipient:   ${wallet.address} (same wallet — autonomous)`,
      ].join('\n')
    )

    if (dryRun) {
      consola.success(
        'Dry run: quote validated and same-wallet gate passed. Nothing broadcast.'
      )
      consola.info(`To broadcast: rerun the same command without --dry-run.`)
      return
    }

    // Approvals for ERC-20 inputs (native needs none).
    if (!fromToken.isNative)
      await ensureAllowance(
        publicClient,
        walletClient,
        fromToken.address,
        wallet.address,
        quote.estimate.approvalAddress,
        fromAmount
      )

    const txHash = await broadcastQuoteTx(
      walletClient,
      quote.transactionRequest
    )
    const explorer = buildExplorerTxUrl(srcName, txHash) ?? txHash
    consola.success(`Broadcast: ${explorer}`)
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    })
    if (receipt.status !== 'success')
      throw new Error(`Transaction reverted on ${srcName} (${txHash}).`)

    if (isBridge) {
      consola.info(
        'Source tx confirmed. Tracking destination delivery (asynchronous)…'
      )
      await pollBridgeStatus(txHash, srcNet.chainId, dstNet.chainId)
    } else {
      const bal = await (toToken.isNative
        ? publicClient.getBalance({ address: wallet.address })
        : (publicClient.readContract({
            address: toToken.address,
            abi: ERC20_MIN_ABI,
            functionName: 'balanceOf',
            args: [wallet.address],
          }) as Promise<bigint>)
      ).catch(() => undefined)
      if (bal !== undefined)
        consola.success(
          `Swap confirmed. ${toToken.symbol} balance: ${formatUnits(
            bal,
            toToken.decimals
          )}`
        )
      else consola.success('Swap confirmed.')
    }
  },
})

/**
 * send: gas asset to a different recipient. Custody changes, so this refuses to
 * broadcast without --confirm, which a human supplies after reviewing the report.
 */
async function runSend(
  args: Record<string, string | boolean | string[] | undefined>,
  wallet: IResolvedWallet,
  dryRun: boolean
): Promise<void> {
  const networkName = args.network as string
  const to = args.to as string
  if (!networkName) throw new Error('--network is required for send.')
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to))
    throw new Error('--to must be a 0x recipient address.')
  const recipient = getAddress(to)
  const net = requireNetwork(networkName)

  // send is a plain native value transfer. On chains whose gas asset is an ERC-20
  // predeploy (e.g. arc), a value transfer would move the wrong thing, so refuse.
  const nativeAddr = (net.nativeAddress ?? '').toLowerCase()
  const nativeSentinels = new Set([
    '',
    '0x0000000000000000000000000000000000000000',
    NATIVE_SENTINEL.toLowerCase(),
  ])
  if (nativeAddr && !nativeSentinels.has(nativeAddr))
    throw new Error(
      `send does not yet support ERC-20-predeploy gas on "${networkName}" (native asset at ${net.nativeAddress}). ` +
        'Use bridge/swap for that chain, or move it manually.'
    )

  const chain = getViemChainForNetworkName(networkName)
  const publicClient = createPublicClient({
    chain,
    transport: http(),
  }) as PublicClient
  const walletClient = createWalletClient({
    chain,
    transport: http(),
    account: accountFromPrivateKey(wallet.privateKey),
  })

  const percentSel = resolveAmountSelection(
    args.amount as string | undefined,
    args.percent as string | undefined
  )
  const value =
    percentSel !== null
      ? await nativeAmountFromPercent(publicClient, wallet.address, percentSel)
      : parseAmount(args.amount as string, 18)
  if (value <= 0n) throw new Error('Resolved amount is zero.')

  consola.box(
    [
      `Mode:       send (DIFFERENT wallet — approval required)`,
      `From:       ${wallet.address} (${wallet.label})`,
      `To:         ${recipient}`,
      `Amount:     ${formatEther(value)} ${
        net.nativeCurrency
      } on ${networkName}`,
    ].join('\n')
  )

  if (dryRun) {
    consola.success('Dry run: send prepared. Nothing broadcast.')
    return
  }
  if (!args.confirm) {
    consola.error(
      'send moves funds to a different wallet. Re-run with --confirm after a human has reviewed the report above. ' +
        'An agent must not set --confirm on its own.'
    )
    process.exit(1)
  }

  const txHash = await walletClient.sendTransaction({
    to: recipient,
    value,
  } as Parameters<typeof walletClient.sendTransaction>[0])
  const explorer = buildExplorerTxUrl(networkName, txHash) ?? txHash
  consola.success(`Broadcast: ${explorer}`)
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
  })
  if (receipt.status !== 'success')
    throw new Error(`Send transaction reverted on ${networkName} (${txHash}).`)
  consola.success('Send confirmed.')
}

runMain(main)
