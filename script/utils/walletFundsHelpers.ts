/**
 * Helpers for the `manage-wallet-funds` task: wallet resolution from `.env`,
 * the same-wallet safety gate, value-loss (slippage) checks, and the thin
 * LI.FI API layer used to route bridges and swaps.
 *
 * Logic that decides whether a fund movement is allowed lives here (not inline in
 * the task) so it can be unit-tested without ever broadcasting a transaction.
 */
import { getAddress, parseUnits, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/** LI.FI public API. Same base the demo scripts dogfood. */
export const LIFI_API_BASE = 'https://li.quest/v1'

/** Integrator tag sent with every quote so these flows are attributable. */
export const LIFI_INTEGRATOR = 'lifi-sc-tools'

/** LI.FI's native-asset sentinel (used for `fromToken`/`toToken` on native moves). */
export const NATIVE_SENTINEL: Address =
  '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

export type WalletMode = 'bridge' | 'swap' | 'send'

/** Shape of the `walletKeys` object added to `config/global.json`. */
export interface IWalletKeysConfig {
  [role: string]: string | { [subRole: string]: string }
}

/**
 * Flatten the nested `walletKeys` config into role → env-var-name.
 * Nested groups (e.g. `backendSigner.production`) become `backendSignerProduction`
 * so a single flat role name addresses every key.
 */
export function flattenWalletKeys(
  walletKeys: IWalletKeysConfig
): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [role, value] of Object.entries(walletKeys)) {
    if (typeof value === 'string') {
      flat[role] = value
    } else {
      for (const [subRole, envVar] of Object.entries(value)) {
        const capped = subRole.charAt(0).toUpperCase() + subRole.slice(1)
        flat[`${role}${capped}`] = envVar
      }
    }
  }
  return flat
}

/**
 * Resolve a role name (as used in `walletKeys`) to its `.env` variable name.
 * Case-insensitive so "refundwallet" and "refundWallet" both resolve.
 */
export function resolveEnvKeyForRole(
  role: string,
  walletKeys: IWalletKeysConfig
): string | undefined {
  const flat = flattenWalletKeys(walletKeys)
  const direct = flat[role]
  if (direct) return direct
  const lower = role.toLowerCase()
  const match = Object.keys(flat).find((k) => k.toLowerCase() === lower)
  return match ? flat[match] : undefined
}

const PRIVATE_KEY_ENV_RE = /(^PRIVATE_KEY.*|.+_PRIVATE_KEY$|.+_PK$)/

/**
 * Find every `.env` variable that looks like a private key, so wallets outside the
 * curated registry (scratch/one-off keys) are still reachable. `MNEMONIC` and the
 * local anvil key are intentionally excluded — the former is not a single key, the
 * latter is a well-known test key that should never move real funds through here.
 */
export function scanEnvForPrivateKeyVars(
  env: Record<string, string | undefined>
): string[] {
  return Object.keys(env)
    .filter((k) => PRIVATE_KEY_ENV_RE.test(k))
    .filter((k) => k !== 'PRIVATE_KEY_ANVIL' && env[k])
    .sort()
}

/** Strip an optional `0x` prefix and return a viem account for the key. */
export function accountFromPrivateKey(privateKey: string) {
  const normalized = privateKey.startsWith('0x')
    ? privateKey.slice(2)
    : privateKey
  return privateKeyToAccount(`0x${normalized}`)
}

/**
 * The core safety boundary: bridge/swap must never change custody. Throws unless the
 * two addresses match. Callers pass the `fromAddress`/`toAddress` the LI.FI quote
 * echoes back, so this catches recipient drift in the quote's *declared* addresses.
 * It does not decode the per-tool `transactionRequest.data`, so it trusts that a quote
 * requested with `toAddress == our wallet` produced matching calldata; callers fail
 * closed when the quote omits these fields (see manageWalletFunds).
 */
export function assertSameWallet(from: Address, to: Address): void {
  if (getAddress(from) !== getAddress(to))
    throw new Error(
      `Same-wallet gate failed: source ${getAddress(
        from
      )} != destination ${getAddress(
        to
      )}. bridge/swap may only move funds within one wallet.`
    )
}

/**
 * Value lost across a route, in percent, measured in USD so it is meaningful for
 * swaps between different assets (a token-amount comparison only works when both
 * sides are the same asset). Returns `undefined` when USD pricing is unavailable
 * rather than fabricating a number — the caller decides how to treat an unpriced route.
 */
export function computeValueLossPct(
  fromAmountUSD: string | undefined,
  toAmountUSD: string | undefined
): number | undefined {
  const from = Number(fromAmountUSD)
  const to = Number(toAmountUSD)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0)
    return undefined
  return ((from - to) / from) * 100
}

/**
 * Abort if the route loses more value than the operator tolerates. When USD pricing
 * is missing we cannot verify the loss, so we refuse rather than broadcast blind —
 * the caller can raise `--max-slippage` or pass explicit intent if that is expected.
 */
export function assertWithinSlippage(
  fromAmountUSD: string | undefined,
  toAmountUSD: string | undefined,
  maxPct: number
): { lossPct: number } {
  const lossPct = computeValueLossPct(fromAmountUSD, toAmountUSD)
  if (lossPct === undefined)
    throw new Error(
      'Cannot verify value loss: the quote has no USD pricing. ' +
        'The route cannot be broadcast until LI.FI provides USD pricing for it.'
    )
  if (lossPct > maxPct)
    throw new Error(
      `Value loss ${lossPct.toFixed(2)}% exceeds the ${maxPct}% cap. ` +
        'Aborting; raise --max-slippage only if you accept the loss.'
    )
  return { lossPct }
}

/** True if the chain id is present in the LI.FI-supported chain list. */
export function isChainSupported(
  chainId: number,
  lifiChains: { id: number }[]
): boolean {
  return lifiChains.some((c) => c.id === chainId)
}

/** Parse a human amount ("0.1", "50") into base units for the given decimals. */
export function parseAmount(human: string, decimals: number): bigint {
  return parseUnits(human, decimals)
}

/** Validate a max-slippage percentage from the CLI (a NaN would silently pass the loss check). */
export function assertSlippage(pct: number): void {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100)
    throw new Error(
      `Invalid --max-slippage "${pct}": expected a number between 0 and 100.`
    )
}

/**
 * Enforce exactly one amount mode and validate it. Returns the validated percent when
 * `--percent` is used, or null when `--amount` is used (the caller parses the amount with
 * the token's decimals). Throws on both/neither, or an out-of-range percent.
 */
export function resolveAmountSelection(
  amount: string | undefined,
  percent: string | undefined
): number | null {
  if ((amount && percent) || (!amount && !percent))
    throw new Error('Provide exactly one of --amount or --percent.')
  if (percent === undefined) return null
  const p = Number(percent)
  if (!Number.isFinite(p) || p <= 0 || p > 100)
    throw new Error(
      `Invalid --percent "${percent}": expected a number in (0, 100].`
    )
  return p
}

/** Resolve a token argument to an address the LI.FI API understands. */
export function normalizeTokenArg(token: string): Address | 'SYMBOL' {
  if (token.toLowerCase() === 'native') return NATIVE_SENTINEL
  if (/^0x[0-9a-fA-F]{40}$/.test(token)) return getAddress(token)
  return 'SYMBOL'
}

const ROLE_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/** Minimal shape of a `networks.json` entry needed to decide the gas model. */
export interface IGasAssetChain {
  nativeCurrency?: string
  nativeAddress?: string | null
  feeTokenAddress?: string | null
}

/**
 * True when a chain has no spendable native gas asset because gas is paid in an ERC-20:
 * either an explicit gas-token predeploy (arc — `nativeAddress` is a real contract) or
 * the tempo-style model (`nativeCurrency: "N/A"`, gas paid via `feeTokenAddress`, and a
 * `0x0` native sentinel that would otherwise slip past an address-only check). A plain
 * native value transfer (`send`) and the native leg of a bridge/swap are meaningless on
 * such chains, so callers refuse them locally instead of relying on a remote API error.
 */
export function chainUsesErc20Gas(net: IGasAssetChain): boolean {
  if (net.feeTokenAddress) return true
  if ((net.nativeCurrency ?? '').trim().toUpperCase() === 'N/A') return true
  const nativeAddr = (net.nativeAddress ?? '').toLowerCase()
  const sentinels = new Set([
    '',
    '0x0000000000000000000000000000000000000000',
    NATIVE_SENTINEL.toLowerCase(),
  ])
  return !sentinels.has(nativeAddr)
}

/**
 * Resolve the address `global.json` records for a (possibly nested) role, so a role like
 * `backendSignerProduction` maps to `backendSigner.production`. Returns undefined for
 * roles with no recorded address (scratch keys), which cannot be cross-checked. `config`
 * is injected (rather than importing global.json) to keep this unit-testable.
 */
export function recordedAddressForRole(
  role: string,
  config: Record<string, unknown>
): Address | undefined {
  const direct = config[role]
  if (typeof direct === 'string' && ROLE_ADDRESS_RE.test(direct))
    return getAddress(direct)
  for (const [key, value] of Object.entries(config)) {
    if (
      value &&
      typeof value === 'object' &&
      role.startsWith(key) &&
      role.length > key.length
    ) {
      const sub = role.slice(key.length)
      const subKey = sub.charAt(0).toLowerCase() + sub.slice(1)
      const nested = (value as Record<string, unknown>)[subKey]
      if (typeof nested === 'string' && ROLE_ADDRESS_RE.test(nested))
        return getAddress(nested)
    }
  }
  return undefined
}

/**
 * Refuse to operate a role whose `.env` key derives to a different address than
 * `global.json` records. A mistyped or stale key would otherwise let an autonomous
 * bridge/swap move a wallet the operator never intended; blocking is the safe default.
 * Roles with no recorded address (scratch keys) are not checked. If a rotation is
 * legitimate, `global.json` must be updated first.
 */
export function assertKeyMatchesRole(
  role: string,
  derived: Address,
  config: Record<string, unknown>
): void {
  const recorded = recordedAddressForRole(role, config)
  if (recorded && recorded !== getAddress(derived))
    throw new Error(
      `Refusing to proceed: the .env key for "${role}" derives to ${getAddress(
        derived
      )}, but global.json records ${recorded}. If the wallet was rotated, update config/global.json first.`
    )
}

// ---------------------------------------------------------------------------
// LI.FI API layer (network IO — not exercised by unit tests)
// ---------------------------------------------------------------------------

export interface ILifiChain {
  id: number
  key: string
  name: string
}

export interface ILifiToken {
  address: Address
  symbol: string
  decimals: number
  priceUSD?: string
}

export interface ILifiQuote {
  transactionRequest: {
    to: Address
    data: `0x${string}`
    value?: string
    gasLimit?: string
    gasPrice?: string
    chainId?: number
  }
  estimate: {
    fromAmount: string
    toAmount: string
    toAmountMin: string
    approvalAddress: Address
    fromAmountUSD?: string
    toAmountUSD?: string
  }
  action: {
    fromToken: ILifiToken
    toToken: ILifiToken
    fromAddress?: Address
    toAddress?: Address
  }
  tool: string
}

async function lifiGet<T>(
  path: string,
  params: Record<string, string>
): Promise<T> {
  const url = `${LIFI_API_BASE}${path}?${new URLSearchParams(
    params
  ).toString()}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LI.FI ${path} ${res.status}: ${body.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

export async function fetchLifiChains(): Promise<ILifiChain[]> {
  const data = await lifiGet<{ chains: ILifiChain[] }>('/chains', {
    chainTypes: 'EVM',
  })
  return data.chains
}

export async function fetchLifiTokens(chainId: number): Promise<ILifiToken[]> {
  const data = await lifiGet<{ tokens: Record<string, ILifiToken[]> }>(
    '/tokens',
    { chains: String(chainId) }
  )
  return data.tokens[String(chainId)] ?? []
}

export interface IQuoteRequest {
  fromChain: number
  toChain: number
  fromToken: string
  toToken: string
  fromAddress: Address
  toAddress: Address
  fromAmount: string
  /** fraction, e.g. 0.03 for 3% */
  slippage: number
}

export async function fetchLifiQuote(req: IQuoteRequest): Promise<ILifiQuote> {
  return lifiGet<ILifiQuote>('/quote', {
    fromChain: String(req.fromChain),
    toChain: String(req.toChain),
    fromToken: req.fromToken,
    toToken: req.toToken,
    fromAddress: req.fromAddress,
    toAddress: req.toAddress,
    fromAmount: req.fromAmount,
    slippage: String(req.slippage),
    integrator: LIFI_INTEGRATOR,
  })
}

export interface ILifiStatus {
  status: 'NOT_FOUND' | 'INVALID' | 'PENDING' | 'DONE' | 'FAILED'
  substatus?: string
  substatusMessage?: string
}

export async function fetchLifiStatus(params: {
  txHash: string
  fromChain: number
  toChain: number
}): Promise<ILifiStatus> {
  return lifiGet<ILifiStatus>('/status', {
    txHash: params.txHash,
    fromChain: String(params.fromChain),
    toChain: String(params.toChain),
  })
}
