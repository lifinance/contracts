/**
 * One-off generator for proposed ERC-7730 `display.formats` entries for the
 * LIFI Diamond's user-facing functions.
 *
 * Reads the Foundry artifacts in `out/`, picks every `startBridgeTokensVia*`
 * and `swapAndStartBridgeTokensVia*` (canonical, non-Packed/non-Min) and the
 * `swapTokens*` family, and emits proposed clear-signing display entries
 * (intent + interpolatedIntent + fields) keyed by canonical signature.
 *
 * Output: config/clearSigningProposal.json — the canonical source of truth
 * for the `display.formats` entries LI.FI ships in the descriptor at
 * `ethereum/clear-signing-erc7730-registry/registry/lifi/calldata-LIFIDiamond.json`.
 *
 * Consumed by `tasks/generateLedgerClearSigning.ts` during the sync workflow:
 * its `display.formats` entries are merged into the registry payload before
 * the bot opens its PR (LI.FI-owned selectors → replaced; entries we do not
 * own → preserved). The CI gate in `.github/workflows/verifyClearSigning.yml`
 * keeps the committed JSON in sync with this file's regenerated output, so
 * the sync workflow can trust the file as current.
 *
 * Strict-by-default: exits non-zero on any user-facing function whose shape
 * does not match a known template. See main() for failure-mode details.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface IAbiParam {
  name: string
  type: string
  components?: IAbiParam[]
}
interface IAbiFn {
  type: string
  name: string
  inputs: IAbiParam[]
}

const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'out')
const TARGET = path.join(ROOT, 'config', 'clearSigningProposal.json')

// Emit a Solidity-declaration-form type with named tuple components:
//   `(address callTo, address approveTo, …) _swapData`
//   `(int64 v, uint32 n, bytes b, uint256 q)[] _data`
// Tuple components include their field names; nested tuples recurse. Primitives
// are emitted as the bare type (the caller appends the param name). This is the
// shape the ERC-7730 v2 schema's `display.formats` key regex requires (every
// parameter and tuple component needs an identifier), and the shape the EF
// registry's existing entries are already authored in — so emitting it here
// also makes our overwrite of registry-side entries byte-identical at the key
// level (no canonical-vs-declaration string mismatch producing a "2 formats
// sections for <selector>" collision in the descriptor validator).
function declarationType(p: IAbiParam): string {
  if (p.type.startsWith('tuple')) {
    if (!p.components)
      throw new Error(
        `tuple "${p.name || '<anonymous>'}" of type "${
          p.type
        }" is missing components — Foundry ABI artifacts should include tuple components; rebuild with \`forge build\` if stale`
      )
    const inner = p.components
      .map((c) => {
        if (!c.name)
          throw new Error(
            `tuple component missing name in field of type "${p.type}" — Foundry ABI artifacts should always include component names; rebuild with \`forge build\` if stale`
          )
        return `${declarationType(c)} ${c.name}`
      })
      .join(', ')
    return `(${inner})${p.type.slice('tuple'.length)}`
  }
  return p.type
}
function signature(fn: IAbiFn): string {
  const params = fn.inputs
    .map((p) => {
      if (!p.name)
        throw new Error(
          `function ${fn.name}: parameter has no name (type=${p.type}). ERC-7730 v2 schema requires every parameter to be named.`
        )
      return `${declarationType(p)} ${p.name}`
    })
    .join(', ')
  return `${fn.name}(${params})`
}

// Lenient, canonical-form signature for internal dedup + sort during collection.
// `signature()` (declaration form, name-required) is what we emit as
// display.formats keys — and it intentionally throws on unnamed params to keep
// the keys schema-valid. But `collectFns()` walks the *entire* facet ABI before
// `isKnownNonUserFacing()` has a chance to drop admin / getter / view helpers,
// so a single unnamed-param helper would crash the generator before it could
// even be classified as non-user-facing. Use this canonical form for
// dedup/sort only — never as an output key.
function collectionSignature(fn: IAbiFn): string {
  const canonicalType = (p: IAbiParam): string => {
    if (p.type.startsWith('tuple')) {
      // Tolerate unnamed params (that's the point of the lenient form), but a
      // tuple missing its `components` is a stale/corrupt ABI artifact — the
      // same hard-fail condition as declarationType(). Don't swallow it into
      // `()`, which could collide with another malformed tuple during dedup.
      if (!p.components)
        throw new Error(
          `tuple "${p.name || '<anonymous>'}" of type "${
            p.type
          }" is missing components — Foundry ABI artifacts should include tuple components; rebuild with \`forge build\` if stale`
        )
      const inner = p.components.map(canonicalType).join(',')
      return `(${inner})${p.type.slice('tuple'.length)}`
    }
    return p.type
  }
  return `${fn.name}(${fn.inputs.map(canonicalType).join(',')})`
}

function collectFns(): IAbiFn[] {
  const facetsDir = path.join(ROOT, 'src', 'Facets')
  const fnNames = new Set<string>()
  const out: Record<string, IAbiFn> = {}

  const facetFiles = fs.readdirSync(facetsDir).filter((f) => f.endsWith('.sol'))
  for (const f of facetFiles) {
    const artifact = path.join(OUT_DIR, f, f.replace(/\.sol$/u, '.json'))
    if (!fs.existsSync(artifact)) continue
    const json = JSON.parse(fs.readFileSync(artifact, 'utf8')) as {
      abi: IAbiFn[]
    }
    // No name-prefix allow-list here: collect every public function the facet
    // exposes, and let main() classify. If a new user-facing entry-point lands
    // (e.g. `executeIntent`) without a matching template AND without a matching
    // skip-list entry, the unrecognized-prefix branch in main() fires and CI
    // fails loudly — instead of silently shipping a descriptor that omits the
    // new selector. (Previously the allow-list `^(startBridgeTokensVia|...)`
    // here silently dropped any unrecognized name before classification,
    // making the strict failure unreachable. See PR #1821 review.)
    for (const item of json.abi ?? []) {
      if (item.type !== 'function') continue
      const sig = collectionSignature(item)
      if (out[sig]) continue
      out[sig] = item
      fnNames.add(item.name)
    }
  }
  // An empty `out/` yields zero functions, zero template failures, and an empty
  // proposal written over the committed one — a silent wipe that reads as success.
  if (Object.keys(out).length === 0) {
    console.error(
      `\n❌ buildClearSigningProposal: no facet artifacts found under ${OUT_DIR}.\n   fix:    run \`forge build\` first, then re-run this generator.\n`
    )
    process.exit(1)
  }

  return Object.values(out).sort((a, b) =>
    collectionSignature(a).localeCompare(collectionSignature(b))
  )
}

interface IField {
  path: string
  label: string
  format?: string
  params?: Record<string, unknown>
  visible?: 'always' | 'optional' | 'never'
}
interface IFormatEntry {
  intent: string
  interpolatedIntent?: string
  fields: IField[]
}

// ---------- template-fit validation ----------
//
// The generator's templates encode assumptions about the diamond's function
// shapes: every canonical bridge function takes `_bridgeData` (LiFi.BridgeData)
// as its first parameter, every swap-and-bridge also takes `_swapData[]`
// (LibSwap.SwapData[]) as its second. The templates emit field paths against
// those exact struct shapes. If a new function lands with a different shape,
// silent template application would produce paths that don't resolve in
// wallets — i.e., clear-signing that shows wrong information.
//
// These tables encode the shapes the templates rely on. validateTuple checks
// real ABI inputs against them. main() aborts on any mismatch.

const BRIDGE_DATA_FIELDS: Record<string, string> = {
  transactionId: 'bytes32',
  bridge: 'string',
  integrator: 'string',
  referrer: 'address',
  sendingAssetId: 'address',
  receiver: 'address',
  minAmount: 'uint',
  destinationChainId: 'uint',
  hasSourceSwaps: 'bool',
  hasDestinationCall: 'bool',
}

const SWAP_DATA_FIELDS: Record<string, string> = {
  callTo: 'address',
  approveTo: 'address',
  sendingAssetId: 'address',
  receivingAssetId: 'address',
  fromAmount: 'uint',
  callData: 'bytes',
  requiresDeposit: 'bool',
}

function validateTuple(
  components: { name: string; type: string }[] | undefined,
  expected: Record<string, string>,
  paramLabel: string
): string | null {
  if (!components) return `${paramLabel}: missing components (not a tuple?)`
  for (const [name, typePrefix] of Object.entries(expected)) {
    const found = components.find((c) => c.name === name)
    if (!found) return `${paramLabel}: missing component "${name}"`
    if (!found.type.startsWith(typePrefix))
      return `${paramLabel}: component "${name}" has type "${found.type}", expected prefix "${typePrefix}"`
  }
  return null
}

function validateStartFn(fn: IAbiFn): string | null {
  const first = fn.inputs[0]
  if (!first || first.name !== '_bridgeData' || !first.type.startsWith('tuple'))
    return `expected first param "_bridgeData" of tuple type; got name="${first?.name}" type="${first?.type}"`
  return validateTuple(
    first.components as { name: string; type: string }[] | undefined,
    BRIDGE_DATA_FIELDS,
    '_bridgeData'
  )
}

function validateSwapAndStartFn(fn: IAbiFn): string | null {
  const startErr = validateStartFn(fn)
  if (startErr) return startErr
  const second = fn.inputs[1]
  if (
    !second ||
    second.name !== '_swapData' ||
    !second.type.startsWith('tuple[]')
  )
    return `expected second param "_swapData" of tuple[] type; got name="${second?.name}" type="${second?.type}"`
  return validateTuple(
    second.components as { name: string; type: string }[] | undefined,
    SWAP_DATA_FIELDS,
    '_swapData'
  )
}

const HIDDEN_BRIDGE_FIELDS: IField[] = [
  {
    path: '_bridgeData.transactionId',
    label: 'Transaction Id',
    visible: 'never',
  },
  { path: '_bridgeData.bridge', label: 'Bridge', visible: 'never' },
  { path: '_bridgeData.integrator', label: 'Integrator', visible: 'never' },
  { path: '_bridgeData.referrer', label: 'Referrer', visible: 'never' },
  {
    path: '_bridgeData.hasSourceSwaps',
    label: 'Has Source Swaps',
    visible: 'never',
  },
]

const HIDDEN_DESTINATION_CALL_FIELD: IField = {
  path: '_bridgeData.hasDestinationCall',
  label: 'Has Destination Call',
  visible: 'never',
}

// On the facets that accept a destination call, the call replaces the check
// that the bridge's own recipient equals `_bridgeData.receiver` (the funds go
// to the call's receiver contract instead), so the signer has to see the flag.
const DESTINATION_CALL_FIELD: IField = {
  path: '_bridgeData.hasDestinationCall',
  label: 'Destination Call',
  format: 'raw',
  visible: 'always',
}

const ADDRESS_NAME_PARAMS = {
  types: ['eoa', 'contract'],
  sources: ['local', 'ens'],
}

const RECEIVER_FIELD: IField = {
  path: '_bridgeData.receiver',
  label: 'Recipient',
  format: 'addressName',
  params: ADDRESS_NAME_PARAMS,
  visible: 'always',
}

// Every bridge entrypoint is payable, and several facets take a native fee from
// `msg.value` on top of an ERC-20 amount, so the native value is always shown.
const NATIVE_VALUE_FIELD: IField = {
  path: '@.value',
  label: 'Native Value Sent',
  format: 'amount',
  visible: 'always',
}

const CHAIN_FIELD: IField = {
  path: '_bridgeData.destinationChainId',
  label: 'Destination Chain',
  // Not `chainId`, however much it looks like the right format: this field also
  // carries LI.FI's synthetic non-EVM ids (LiFiData.sol), and `chainId` resolves
  // through public EIP-155 chain lists that mislabel our chains — 999 is
  // HyperEVM to us and "Wanchain Testnet" upstream, 1337 is HyperCore and
  // "Geth Testnet". A wrong network name on a signing screen is worse than a
  // number, so this stays raw until ERC-7730 pins a name source and a fallback.
  format: 'raw',
  visible: 'always',
}

// `LibAsset.isNativeAsset` accepts exactly one sentinel — the zero address — so
// that is the only value declared here. (`0xEeee…EEeE` is an outbound
// translation for bridges that expect it, e.g. SquidFacet and GardenFacet;
// no asset-id input is ever read as native at that value.) Without this param
// `tokenAmount` has no decimals or ticker to format the sentinel with and
// wallets fall back to the raw integer — a bare `7538051138939978` on the
// signing screen where `0.007538051138939978 ETH` belongs.
const NATIVE_CURRENCY_ADDRESS = '0x0000000000000000000000000000000000000000'

// Every `tokenAmount` field goes through this: any asset-id path in this
// diamond can hold the native sentinel, so opting in per-site would only leave
// room to forget one.
function tokenAmountParams(tokenPath: string): Record<string, unknown> {
  return { tokenPath, nativeCurrencyAddress: NATIVE_CURRENCY_ADDRESS }
}

function bridgeFacetName(fnName: string): string {
  // startBridgeTokensViaXxx | swapAndStartBridgeTokensViaXxx
  // Strip Packed/Min/ERC20/Native suffixes; keep the bridge identity + version.
  const m = fnName.match(
    /^(?:startBridgeTokensVia|swapAndStartBridgeTokensVia)(.+)$/u
  )
  if (!m || !m[1]) return fnName
  const captured = m[1]
  return (
    captured.replace(/(ERC20|Native)?(Packed|Min)?$/u, '').trim() || captured
  )
}

// ---------- bridge-specific display fields ----------
//
// `_bridgeData` is what the transfer claims to do. In many facets the facet's
// own struct decides part of it instead — the amount actually bridged, a fee
// cut from that amount, the token and amount delivered, the chain or address
// the funds go to, where refunds land — without being checked against
// `_bridgeData`. Every such component is listed here, so the signer sees what
// the call commits to rather than what `_bridgeData` claims.
//
// Paths are validated against the facet ABI by validateFacetFields(): a renamed
// or retyped component fails the generator rather than emitting a path that
// resolves to nothing in wallets.
//
// A `bytes32` recipient may hold a non-EVM address (a Solana pubkey), so it
// always keeps a `raw` field; on an EVM transfer its address bytes are shown a
// second time as `addressName` through a slice. Destination-chain token ids and
// amounts in destination decimals stay `raw`: the calldata encoding has no tag
// for `tokenAmount.chainIdPath`, so a device would look the destination token
// up on the source chain.

type Variant = 'start' | 'swap'

interface IFacetField {
  // Rooted at the function parameter and without a slice, e.g.
  // `_stargateData.sendParams.dstEid`.
  path: string
  // Exact ABI type of the component the path ends at.
  type: string
  label: string
  format: 'raw' | 'addressName' | 'amount' | 'tokenAmount' | 'unit'
  params?: Record<string, unknown>
  // Byte slice appended to the path: `[12:32]` for a left-padded address.
  slice?: string
  visible?: 'always' | 'optional'
  // Restricts the field to the entrypoint where it means what the label says.
  only?: Variant
}

interface IFacetDisplay {
  fields: IFacetField[]
  // Replaces the default sentence where `_bridgeData` misstates the transfer.
  intent?: Partial<Record<Variant, string>>
  amountLabel?: Partial<Record<Variant, string>>
  receiverLabel?: string
  // The facet accepts a destination call, which replaces its recipient check.
  acceptsDestinationCall?: boolean
}

function field(
  path: string,
  type: string,
  label: string,
  extra: Partial<IFacetField> = {}
): IFacetField {
  return { path, type, label, format: 'raw', ...extra }
}

function addressField(
  path: string,
  label: string,
  extra: Partial<IFacetField> = {}
): IFacetField {
  return field(path, 'address', label, {
    format: 'addressName',
    params: ADDRESS_NAME_PARAMS,
    ...extra,
  })
}

function refundField(
  path: string,
  extra: Partial<IFacetField> = {}
): IFacetField {
  return addressField(path, 'Refund Recipient', {
    visible: 'optional',
    ...extra,
  })
}

function nativeFeeField(path: string, label: string): IFacetField {
  return field(path, 'uint256', label, { format: 'amount' })
}

function bridgedTokenField(
  path: string,
  label: string,
  extra: Partial<IFacetField> = {}
): IFacetField {
  return field(path, 'uint256', label, {
    format: 'tokenAmount',
    params: tokenAmountParams('_bridgeData.sendingAssetId'),
    ...extra,
  })
}

// The raw value carries a non-EVM recipient; the slice names an EVM one.
function bytes32RecipientFields(
  path: string,
  label: string,
  slice = '[12:32]'
): IFacetField[] {
  return [
    field(path, 'bytes32', label),
    field(path, 'bytes32', `${label} (EVM)`, {
      format: 'addressName',
      params: ADDRESS_NAME_PARAMS,
      slice,
    }),
  ]
}

function nonEvmRecipientField(path: string, type = 'bytes32'): IFacetField {
  return field(path, type, 'Non-EVM Recipient')
}

// A 1e18-scaled fraction (1e18 = 100%) shown as a percentage.
const PERCENT_1E18_PARAMS = { base: '%', decimals: 16 }

// For facets whose real destination or recipient lives in the facet data rather
// than in `_bridgeData`, which the facet does not check against it.
function bridgeIntent(
  facet: string,
  destination: string,
  recipientPath: string
): Record<Variant, string> {
  const tail = `via ${facet} to ${destination} for {${recipientPath}}`
  return {
    start: `Bridge {_bridgeData.minAmount} ${tail}`,
    swap: `Swap then bridge {_bridgeData.minAmount} ${tail}`,
  }
}

// Facets that hand the funds to a deposit address or an off-chain order: the
// recipient and chain in `_bridgeData` are what the order promises, not where
// this transaction sends the funds.
function depositIntent(
  facet: string,
  depositPath: string
): Record<Variant, string> {
  const tail = `via ${facet} to {${depositPath}}, filled off-chain for {_bridgeData.receiver} on chain {_bridgeData.destinationChainId}`
  return {
    start: `Send {_bridgeData.minAmount} ${tail}`,
    swap: `Swap then send {_bridgeData.minAmount} ${tail}`,
  }
}

// Keyed by bridge identity from bridgeFacetName(). A bridge with no entry
// takes its recipient, amount and chain from `_bridgeData` alone.
const BRIDGE_FACET_DISPLAY: Record<string, IFacetDisplay> = {
  AcrossV4: {
    acceptsDestinationCall: true,
    fields: [
      // The swap entrypoint recomputes outputAmount from outputAmountMultiplier.
      field('_acrossData.outputAmount', 'uint256', 'Amount Received', {
        only: 'start',
      }),
      // Folds the price ratio and the token decimal difference into one
      // factor, so it is not a percentage unless both tokens share decimals.
      field(
        '_acrossData.outputAmountMultiplier',
        'uint128',
        'Output Multiplier (1e18 base)',
        { only: 'swap' }
      ),
      field('_acrossData.receivingAssetId', 'bytes32', 'Token Received'),
      ...bytes32RecipientFields(
        '_acrossData.receiverAddress',
        'Across Recipient'
      ),
      field('_acrossData.refundAddress', 'bytes32', 'Refund Address', {
        visible: 'optional',
      }),
    ],
    intent: {
      start:
        'Bridge {_bridgeData.minAmount} via AcrossV4 to chain {_bridgeData.destinationChainId} for {_bridgeData.receiver}, receiving {_acrossData.outputAmount}',
    },
  },
  Across: {
    fields: [
      field('_acrossData.relayerFeePct', 'int64', 'Relayer Fee', {
        format: 'unit',
        params: PERCENT_1E18_PARAMS,
      }),
    ],
  },
  AllBridge: {
    fields: [
      ...bytes32RecipientFields(
        '_allBridgeData.recipient',
        'AllBridge Recipient'
      ),
      // Native wei, or sending-token units when payFeeWithSendingAsset is set;
      // a descriptor cannot pick the format from that flag.
      field(
        '_allBridgeData.fees',
        'uint256',
        'AllBridge Fee (raw; native unless taken from bridged amount)'
      ),
      field(
        '_allBridgeData.payFeeWithSendingAsset',
        'bool',
        'Fee Taken From Bridged Amount'
      ),
      field('_allBridgeData.receiveToken', 'bytes32', 'Token Received'),
    ],
  },
  ArbitrumBridge: {
    fields: [
      nativeFeeField('_arbitrumData.maxSubmissionCost', 'Max Submission Cost'),
      field('_arbitrumData.maxGas', 'uint256', 'Max Gas', {
        visible: 'optional',
      }),
      nativeFeeField('_arbitrumData.maxGasPrice', 'Max Gas Price'),
    ],
  },
  CelerCircleBridge: {
    fields: [
      bridgedTokenField(
        '_celerCircleData.maxFee',
        'Max Destination Fee (0 = no limit)'
      ),
    ],
  },
  Centrifuge: {
    fields: [
      nativeFeeField('_centrifugeData.nativeFee', 'Centrifuge Fee'),
      refundField('_centrifugeData.refundRecipient'),
    ],
  },
  Chainflip: {
    acceptsDestinationCall: true,
    fields: [
      nonEvmRecipientField('_chainflipData.nonEVMReceiver', 'bytes'),
      field('_chainflipData.dstToken', 'uint32', 'Chainflip Token Received'),
      addressField(
        '_chainflipData.dstCallReceiver',
        'Destination Call Receiver'
      ),
    ],
  },
  DeBridgeDln: {
    fields: [
      // The order pays receiverDst; it is not checked against `_bridgeData`.
      field('_deBridgeData.receiver', 'bytes', 'DeBridge Recipient'),
      field('_deBridgeData.minAmountOut', 'uint256', 'Amount Received'),
      field('_deBridgeData.receivingAssetId', 'bytes', 'Token Received'),
      // allowedCancelBeneficiarySrc is empty, so this address can cancel the
      // order and choose where the refund goes.
      field(
        '_deBridgeData.orderAuthorityDst',
        'bytes',
        'Order Authority (can cancel, picks refund address)'
      ),
    ],
    // For a native input the DLN fee comes out of the bridged amount.
    amountLabel: {
      start: 'Amount to Bridge (native: minus DLN fee)',
      swap: 'Minimum to Bridge (native: minus DLN fee)',
    },
    intent: bridgeIntent(
      'DeBridgeDln',
      'chain {_bridgeData.destinationChainId}',
      '_deBridgeData.receiver'
    ),
  },
  Eco: {
    fields: [
      nonEvmRecipientField('_ecoData.nonEVMReceiver', 'bytes'),
      refundField('_ecoData.refundRecipient'),
    ],
  },
  Frax: {
    fields: [
      nonEvmRecipientField('_fraxData.nonEVMReceiver'),
      nativeFeeField('_fraxData.nativeFee', 'LayerZero Fee'),
      refundField('_fraxData.refundRecipient'),
    ],
  },
  Garden: {
    fields: [
      addressField('_gardenData.redeemer', 'Garden Redeemer (solver)'),
      nonEvmRecipientField('_gardenData.nonEvmReceiver'),
      addressField('_gardenData.refundAddress', 'Refund Address', {
        visible: 'optional',
      }),
    ],
    intent: depositIntent('Garden', '_gardenData.redeemer'),
  },
  GasZip: {
    fields: [
      // Right-padded: bytes32(bytes20(addr)), unlike the other recipients.
      ...bytes32RecipientFields(
        '_gasZipData.receiverAddress',
        'GasZip Recipient',
        '[0:20]'
      ),
      field(
        '_gasZipData.destinationChains',
        'uint256',
        'GasZip Destination Chains'
      ),
    ],
  },
  Glacis: {
    fields: [
      ...bytes32RecipientFields(
        '_glacisData.receiverAddress',
        'Glacis Recipient'
      ),
      nativeFeeField('_glacisData.nativeFee', 'Glacis Fee'),
      field(
        '_glacisData.outputToken',
        'bytes32',
        'Token Received (0 = default)'
      ),
      addressField('_glacisData.refundAddress', 'Refund Address', {
        visible: 'optional',
      }),
    ],
  },
  LayerSwap: {
    fields: [
      addressField(
        '_layerSwapData.depositoryReceiver',
        'LayerSwap Deposit Address'
      ),
      nonEvmRecipientField('_layerSwapData.nonEVMReceiver'),
      refundField('_layerSwapData.refundRecipient'),
    ],
    intent: depositIntent('LayerSwap', '_layerSwapData.depositoryReceiver'),
  },
  LiFiIntentEscrowV2: {
    acceptsDestinationCall: true,
    fields: [
      ...bytes32RecipientFields(
        '_lifiIntentData.recipient',
        'Intent Recipient'
      ),
      // Includes the token decimal difference, like AcrossV4's multiplier.
      field(
        '_lifiIntentData.outputAmountMultiplier',
        'uint128',
        'Output Multiplier (1e18 base)'
      ),
      field('_lifiIntentData.outputToken', 'bytes32', 'Token Received'),
      // Becomes the recipient when dstCallSwapData is not empty.
      field(
        '_lifiIntentData.dstCallReceiver',
        'bytes32',
        'Destination Call Receiver'
      ),
      addressField(
        '_lifiIntentData.depositAndRefundAddress',
        'Refund Recipient'
      ),
    ],
  },
  M0: {
    fields: [
      ...bytes32RecipientFields('_m0Data.receiverAddress', 'M0 Recipient'),
      field('_m0Data.amountOut', 'uint128', 'Amount Received', {
        only: 'start',
      }),
      // Scaled by the realized swap output on this entrypoint.
      field('_m0Data.amountOut', 'uint128', 'Quoted Amount Received', {
        only: 'swap',
      }),
      field('_m0Data.tokenOut', 'bytes32', 'Token Received'),
      // Receives the OrderBook refund when the order is cancelled.
      addressField('_m0Data.orderOwner', 'Order Owner (refunds)', {
        visible: 'optional',
      }),
      refundField('_m0Data.refundRecipient'),
    ],
  },
  Mayan: {
    fields: [
      nonEvmRecipientField('_mayanData.nonEVMReceiver'),
      // The swap entrypoint bridges exactly mayanAmountIn and sends the rest of
      // the swap output to refundRecipient.
      bridgedTokenField('_mayanData.mayanAmountIn', 'Amount to Bridge', {
        only: 'swap',
      }),
      refundField('_mayanData.refundRecipient', {
        visible: 'always',
        only: 'swap',
      }),
      refundField('_mayanData.refundRecipient', { only: 'start' }),
    ],
    amountLabel: { swap: 'Minimum Swap Output' },
    intent: {
      swap: 'Swap then bridge {_mayanData.mayanAmountIn} via Mayan to chain {_bridgeData.destinationChainId} for {_bridgeData.receiver}',
    },
  },
  MegaETHBridge: {
    fields: [
      field('_megaETHData.assetIdOnL2', 'address', 'Token Received (L2)'),
    ],
  },
  NEARIntents: {
    fields: [
      addressField('_nearData.depositAddress', 'NEAR Deposit Address'),
      nonEvmRecipientField('_nearData.nonEVMReceiver'),
      // Signed into the backend payload; a swapped quote is only visible here.
      field('_nearData.destinationAsset', 'bytes32', 'Destination Asset'),
      field('_nearData.minAmountOut', 'uint256', 'Minimum Received'),
      refundField('_nearData.refundRecipient'),
    ],
    intent: depositIntent('NEARIntents', '_nearData.depositAddress'),
  },
  OptimismBridge: {
    fields: [
      field('_optimismData.assetIdOnL2', 'address', 'Token Received (L2)'),
    ],
  },
  PaxosTransit: {
    fields: [
      // Not cross-checked against `_bridgeData` (PaxosTransitFacet._startBridge).
      field(
        '_paxosData.quote.route.destEID',
        'uint32',
        'Paxos Destination Endpoint'
      ),
      field('_paxosData.quote.route.wantAsset', 'address', 'Token Received'),
      nativeFeeField('_paxosData.nativeFee', 'Paxos Fee'),
      refundField('_paxosData.refundRecipient'),
    ],
    intent: bridgeIntent(
      'PaxosTransit',
      'Paxos endpoint {_paxosData.quote.route.destEID}',
      '_bridgeData.receiver'
    ),
  },
  PolymerCCTP: {
    fields: [
      nonEvmRecipientField('_polymerData.nonEVMReceiver'),
      bridgedTokenField('_polymerData.polymerTokenFee', 'Polymer Fee'),
      bridgedTokenField(
        '_polymerData.maxCCTPFee',
        'Max Destination Fee (0 = no limit)'
      ),
      refundField('_polymerData.refundRecipient'),
    ],
    intent: {
      start:
        'Bridge {_bridgeData.minAmount} via PolymerCCTP, minus fee {_polymerData.polymerTokenFee}, to chain {_bridgeData.destinationChainId} for {_bridgeData.receiver}',
      swap: 'Swap then bridge {_bridgeData.minAmount} via PolymerCCTP, minus fee {_polymerData.polymerTokenFee}, to chain {_bridgeData.destinationChainId} for {_bridgeData.receiver}',
    },
  },
  RelayDepository: {
    fields: [
      addressField('_relayDepositoryData.depositorAddress', 'Relay Depositor'),
    ],
    // The funds go to the Relay Depository; the order id, matched off-chain,
    // decides the recipient and chain.
    intent: {
      start:
        'Send {_bridgeData.minAmount} via RelayDepository, filled off-chain for {_bridgeData.receiver} on chain {_bridgeData.destinationChainId}',
      swap: 'Swap then send {_bridgeData.minAmount} via RelayDepository, filled off-chain for {_bridgeData.receiver} on chain {_bridgeData.destinationChainId}',
    },
  },
  Squid: {
    // Route 0 (BridgeCall) and 2 (CallBridgeCall) deliver to destinationAddress
    // and use `_bridgeData.receiver` as the Axelar refund address; route 1
    // (CallBridge) delivers to `_bridgeData.receiver` and ignores
    // destinationAddress. A descriptor cannot branch on routeType, so the
    // sentence names neither address and the labels say which route uses which.
    receiverLabel: 'Recipient (route 1) / Refund Address (routes 0, 2)',
    fields: [
      field(
        '_squidData.routeType',
        'uint8',
        'Squid Route (0 BridgeCall, 1 CallBridge, 2 CallBridgeCall)'
      ),
      field('_squidData.destinationChain', 'string', 'Squid Destination Chain'),
      field(
        '_squidData.destinationAddress',
        'string',
        'Recipient (routes 0, 2; unused on route 1)'
      ),
      nativeFeeField('_squidData.fee', 'Squid Fee'),
    ],
    intent: {
      start:
        'Bridge {_bridgeData.minAmount} via Squid route {_squidData.routeType} to {_squidData.destinationChain}',
      swap: 'Swap then bridge {_bridgeData.minAmount} via Squid route {_squidData.routeType} to {_squidData.destinationChain}',
    },
  },
  Stargate: {
    acceptsDestinationCall: true,
    fields: [
      // Neither is checked against destinationChainId; `to` is checked against
      // receiver only without a destination call.
      field(
        '_stargateData.sendParams.dstEid',
        'uint32',
        'LayerZero Destination Endpoint'
      ),
      ...bytes32RecipientFields(
        '_stargateData.sendParams.to',
        'Bridge Recipient'
      ),
      bridgedTokenField(
        '_stargateData.sendParams.minAmountLD',
        'Minimum Amount Received'
      ),
      nativeFeeField('_stargateData.fee.nativeFee', 'LayerZero Fee'),
      addressField('_stargateData.refundAddress', 'Refund Address', {
        visible: 'optional',
      }),
    ],
    intent: bridgeIntent(
      'Stargate',
      'LayerZero endpoint {_stargateData.sendParams.dstEid}',
      '_stargateData.sendParams.to.[12:32]'
    ),
  },
  Superset: {
    fields: [
      nativeFeeField('_supersetData.lzFee', 'LayerZero Fee'),
      addressField('_supersetData.refundAddress', 'Refund Address', {
        visible: 'optional',
      }),
    ],
  },
  Symbiosis: {
    fields: [
      // Runs the bridging call; the facet never reads `_bridgeData.receiver`.
      addressField('_symbiosisData.callTo', 'Symbiosis Bridge Contract'),
      nonEvmRecipientField('_symbiosisData.nonEvmReceiver'),
      nativeFeeField('_symbiosisData.fee', 'Symbiosis Fee'),
      refundField('_symbiosisData.refundRecipient'),
    ],
  },
  ThorSwap: {
    // The memo, not `_bridgeData`, tells THORChain where to send the funds.
    fields: [
      addressField('_thorSwapData.vault', 'THORChain Vault'),
      field('_thorSwapData.memo', 'string', 'THORChain Memo'),
    ],
    intent: {
      start:
        'Send {_bridgeData.minAmount} via ThorSwap to vault {_thorSwapData.vault} with memo {_thorSwapData.memo}',
      swap: 'Swap then send {_bridgeData.minAmount} via ThorSwap to vault {_thorSwapData.vault} with memo {_thorSwapData.memo}',
    },
  },
  Unit: {
    fields: [addressField('_unitData.depositAddress', 'Unit Deposit Address')],
    intent: depositIntent('Unit', '_unitData.depositAddress'),
  },
}

function facetFields(fn: IAbiFn, variant: Variant): IFacetField[] {
  const display = BRIDGE_FACET_DISPLAY[bridgeFacetName(fn.name)]
  return (display?.fields ?? []).filter(
    (spec) => !spec.only || spec.only === variant
  )
}

// Walks a parameter-rooted path through nested tuples and returns the ABI type
// it ends at, or null when a segment does not exist.
function componentType(fn: IAbiFn, path: string): string | null {
  const [head, ...rest] = path.split('.')
  let current: IAbiParam | undefined = fn.inputs.find((p) => p.name === head)
  for (const segment of rest) {
    // Exact `tuple`: a `tuple[]` would need an index in the path.
    if (!current || current.type !== 'tuple') return null
    current = current.components?.find((c) => c.name === segment)
  }
  return current?.type ?? null
}

// Strict-by-default: every path a facet field displays, and every token path it
// formats an amount with, must exist in the ABI with the expected type.
function validateFacetFields(fn: IAbiFn, variant: Variant): string | null {
  for (const spec of facetFields(fn, variant)) {
    const type = componentType(fn, spec.path)
    if (type === null)
      return `missing component "${spec.path}" (BRIDGE_FACET_DISPLAY field "${spec.label}")`
    // Exact match: `startsWith('bytes')` would accept `bytes32[]` or `bytes16`.
    if (type !== spec.type)
      return `component "${spec.path}" has type "${type}", expected exactly "${spec.type}"`
    const tokenPath = spec.params?.tokenPath
    if (
      typeof tokenPath === 'string' &&
      componentType(fn, tokenPath.replace(/\.\[[^\]]*\]$/u, '')) === null
    )
      return `token path "${tokenPath}" of "${spec.path}" does not resolve`
  }
  return null
}

function toField(spec: IFacetField): IField {
  return {
    path: spec.slice ? `${spec.path}.${spec.slice}` : spec.path,
    label: spec.label,
    format: spec.format,
    ...(spec.params ? { params: spec.params } : {}),
    visible: spec.visible ?? 'always',
  }
}

// `LibAsset.depositAssets` pulls `fromAmount` of `sendingAssetId` from the
// signer for every entry with `requiresDeposit`, not only the first one.
const SWAP_INPUT_FIELD: IField = {
  path: '_swapData.[].fromAmount',
  label: 'Amount to Swap',
  format: 'tokenAmount',
  params: tokenAmountParams('_swapData.[].sendingAssetId'),
  visible: 'always',
}

const HIDDEN_SWAP_FIELDS: IField[] = [
  {
    path: '_swapData.[].callData',
    label: 'Swap Data Call Data',
    visible: 'never',
  },
  {
    path: '_swapData.[].callTo',
    label: 'Swap Data Call To',
    visible: 'never',
  },
  {
    path: '_swapData.[].approveTo',
    label: 'Swap Data Approve To',
    visible: 'never',
  },
  {
    path: '_swapData.[].requiresDeposit',
    label: 'Swap Data Requires Deposit',
    visible: 'never',
  },
]

function buildBridgeFormat(fn: IAbiFn, variant: Variant): IFormatEntry {
  const facet = bridgeFacetName(fn.name)
  const display = BRIDGE_FACET_DISPLAY[facet]
  const isSwap = variant === 'swap'
  // Bridge identity is the most important security signal in a bridge tx —
  // different bridges have very different trust + finality models. Wallets
  // prefer `interpolatedIntent` over `intent`, so if we only put the bridge
  // name in `intent` it never reaches the user. Hardcode it into the
  // template (constant per selector; no extra wallet-side work).
  const defaultIntent = `${
    isSwap ? 'Swap then bridge' : 'Bridge'
  } {_bridgeData.minAmount} via ${facet} to chain {_bridgeData.destinationChainId} for {_bridgeData.receiver}`
  const destinationCall = display?.acceptsDestinationCall
    ? DESTINATION_CALL_FIELD
    : HIDDEN_DESTINATION_CALL_FIELD

  return {
    intent: isSwap ? `Swap & Bridge via ${facet}` : `Bridge via ${facet}`,
    interpolatedIntent: display?.intent?.[variant] ?? defaultIntent,
    fields: [
      ...(isSwap ? [SWAP_INPUT_FIELD] : []),
      {
        path: '_bridgeData.minAmount',
        label:
          display?.amountLabel?.[variant] ??
          (isSwap ? 'Minimum to Bridge' : 'Amount to Bridge'),
        format: 'tokenAmount',
        params: tokenAmountParams('_bridgeData.sendingAssetId'),
        visible: 'always',
      },
      CHAIN_FIELD,
      display?.receiverLabel
        ? { ...RECEIVER_FIELD, label: display.receiverLabel }
        : RECEIVER_FIELD,
      ...facetFields(fn, variant).map(toField),
      ...(destinationCall.visible === 'always' ? [destinationCall] : []),
      NATIVE_VALUE_FIELD,
      ...HIDDEN_BRIDGE_FIELDS,
      ...(destinationCall.visible === 'never' ? [destinationCall] : []),
      ...(isSwap ? HIDDEN_SWAP_FIELDS : []),
    ],
  }
}

// A placeholder that names no displayed field renders as nothing, or as a value
// the signer cannot check against a labelled line.
function validateIntentPlaceholders(entry: IFormatEntry): string | null {
  const displayed = new Set(
    entry.fields
      .filter((f) => (f.visible ?? 'always') !== 'never')
      .map((f) => f.path)
  )
  for (const match of entry.interpolatedIntent?.matchAll(/\{([^}]+)\}/gu) ??
    []) {
    const placeholder = match[1]
    if (placeholder && !displayed.has(placeholder))
      return `interpolatedIntent placeholder "{${placeholder}}" is not a displayed field path`
  }
  return null
}
// Existing 7 swap entries: re-author them with `interpolatedIntent` added.
// Paths must match the actual function signatures from the ABI.
const SWAP_TEMPLATES: Record<string, IFormatEntry> = {
  swapTokensSingleV3ERC20ToERC20: {
    intent: 'Swap',
    interpolatedIntent:
      'Swap {_swapData.fromAmount} for at least {_minAmountOut} to {_receiver}',
    fields: [
      {
        path: '_swapData.fromAmount',
        label: 'Amount to Send',
        format: 'tokenAmount',
        params: tokenAmountParams('_swapData.sendingAssetId'),
        visible: 'always',
      },
      {
        path: '_minAmountOut',
        label: 'Minimum to Receive',
        format: 'tokenAmount',
        params: tokenAmountParams('_swapData.receivingAssetId'),
        visible: 'always',
      },
      {
        path: '_receiver',
        label: 'Recipient',
        format: 'addressName',
        params: { types: ['eoa', 'contract'], sources: ['local', 'ens'] },
        visible: 'always',
      },
      { path: '_transactionId', label: 'Transaction Id', visible: 'never' },
      { path: '_integrator', label: 'Integrator', visible: 'never' },
      { path: '_referrer', label: 'Referrer', visible: 'never' },
      {
        path: '_swapData.callData',
        label: 'Swap Data Call Data',
        visible: 'never',
      },
      {
        path: '_swapData.requiresDeposit',
        label: 'Swap Data Requires Deposit',
        visible: 'never',
      },
    ],
  },
  swapTokensSingleV3ERC20ToNative: undefined as unknown as IFormatEntry,
  swapTokensSingleV3NativeToERC20: undefined as unknown as IFormatEntry,
  swapTokensMultipleV3ERC20ToERC20: undefined as unknown as IFormatEntry,
  swapTokensMultipleV3ERC20ToNative: undefined as unknown as IFormatEntry,
  swapTokensMultipleV3NativeToERC20: undefined as unknown as IFormatEntry,
}
// Derivation: same as ERC20ToERC20 but for Native variants the `fromAmount`
// (or the @.value for the legacy descriptor) is replaced. We just reproduce
// the existing descriptor's field shape and append `interpolatedIntent`.

// The ERC20→Native variants send `address(this).balance` and never read the
// `receivingAssetId` they are handed (`swapTokensSingleV3ERC20ToNative` and
// `_transferNativeTokensAndEmitEvent` in GenericSwapFacetV3). Formatting
// `_minAmountOut` against that unvalidated field would let crafted calldata put
// any ticker and decimals on a guaranteed-native amount — `1 USDC` on screen for
// 1e6 wei of native, on a transaction that succeeds. The output currency is
// fixed, so state it rather than derive it.
function withNativeMinAmountOut(base: IFormatEntry): IFormatEntry {
  return {
    ...base,
    fields: base.fields.map((field) =>
      field.path === '_minAmountOut'
        ? {
            path: field.path,
            label: field.label,
            format: 'amount',
            visible: 'always' as const,
          }
        : field
    ),
  }
}

// Cast: the ERC20ToERC20 entry is the literal object above and always present
// at this point. Required because `Record<string, T>` indexed access returns
// `T | undefined` under `noUncheckedIndexedAccess`.
SWAP_TEMPLATES.swapTokensSingleV3ERC20ToNative = withNativeMinAmountOut(
  SWAP_TEMPLATES.swapTokensSingleV3ERC20ToERC20 as IFormatEntry
)
SWAP_TEMPLATES.swapTokensSingleV3NativeToERC20 = {
  intent: 'Swap',
  interpolatedIntent:
    'Swap {@.value} for at least {_minAmountOut} to {_receiver}',
  fields: [
    { path: '@.value', label: 'Amount to send', format: 'amount' },
    {
      path: '_minAmountOut',
      label: 'Minimum to Receive',
      format: 'tokenAmount',
      params: tokenAmountParams('_swapData.receivingAssetId'),
      visible: 'always',
    },
    {
      path: '_receiver',
      label: 'Recipient',
      format: 'addressName',
      params: { types: ['eoa', 'contract'], sources: ['local', 'ens'] },
      visible: 'always',
    },
    { path: '_transactionId', label: 'Transaction Id', visible: 'never' },
    { path: '_integrator', label: 'Integrator', visible: 'never' },
    { path: '_referrer', label: 'Referrer', visible: 'never' },
    {
      path: '_swapData.callData',
      label: 'Swap Data Call Data',
      visible: 'never',
    },
    { path: '_swapData.callTo', label: 'Swap Data Call To', visible: 'never' },
    {
      path: '_swapData.approveTo',
      label: 'Swap Data Approve To',
      visible: 'never',
    },
    {
      path: '_swapData.requiresDeposit',
      label: 'Swap Data Requires Deposit',
      visible: 'never',
    },
  ],
}
// `GenericSwapFacetV3._depositMultipleERC20Tokens` pulls every entry with
// `requiresDeposit`, so the sentence cannot name one input amount.
SWAP_TEMPLATES.swapTokensMultipleV3ERC20ToERC20 = {
  intent: 'Swap',
  interpolatedIntent: 'Swap for at least {_minAmountOut} to {_receiver}',
  fields: [
    {
      path: '_swapData.[].fromAmount',
      label: 'Amount to Send',
      format: 'tokenAmount',
      params: tokenAmountParams('_swapData.[].sendingAssetId'),
      visible: 'always',
    },
    {
      path: '_minAmountOut',
      label: 'Minimum to Receive',
      format: 'tokenAmount',
      params: tokenAmountParams('_swapData.[-1].receivingAssetId'),
      visible: 'always',
    },
    {
      path: '_receiver',
      label: 'Recipient',
      format: 'addressName',
      params: { types: ['eoa', 'contract'], sources: ['local', 'ens'] },
      visible: 'always',
    },
    { path: '_transactionId', label: 'Transaction Id', visible: 'never' },
    { path: '_integrator', label: 'Integrator', visible: 'never' },
    { path: '_referrer', label: 'Referrer', visible: 'never' },
    {
      path: '_swapData.[].callData',
      label: 'Swap Data Call Data',
      visible: 'never',
    },
    {
      path: '_swapData.[].callTo',
      label: 'Swap Data Call To',
      visible: 'never',
    },
    {
      path: '_swapData.[].approveTo',
      label: 'Swap Data Approve To',
      visible: 'never',
    },
    {
      path: '_swapData.[].requiresDeposit',
      label: 'Swap Data Requires Deposit',
      visible: 'never',
    },
  ],
}
// See notes on the SingleV3 variant above re. the cast and the native output.
SWAP_TEMPLATES.swapTokensMultipleV3ERC20ToNative = withNativeMinAmountOut(
  SWAP_TEMPLATES.swapTokensMultipleV3ERC20ToERC20 as IFormatEntry
)
SWAP_TEMPLATES.swapTokensMultipleV3NativeToERC20 = {
  intent: 'Swap',
  interpolatedIntent:
    'Swap {@.value} for at least {_minAmountOut} to {_receiver}',
  fields: [
    { path: '@.value', label: 'Amount to send', format: 'amount' },
    {
      path: '_minAmountOut',
      label: 'Minimum to Receive',
      format: 'tokenAmount',
      params: tokenAmountParams('_swapData.[-1].receivingAssetId'),
      visible: 'always',
    },
    {
      path: '_receiver',
      label: 'Recipient',
      format: 'addressName',
      params: { types: ['eoa', 'contract'], sources: ['local', 'ens'] },
      visible: 'always',
    },
    { path: '_transactionId', label: 'Transaction Id', visible: 'never' },
    { path: '_integrator', label: 'Integrator', visible: 'never' },
    { path: '_referrer', label: 'Referrer', visible: 'never' },
    {
      path: '_swapData.[0].callData',
      label: 'Swap Data Call Data',
      visible: 'never',
    },
    {
      path: '_swapData.[0].callTo',
      label: 'Swap Data Call To',
      visible: 'never',
    },
    {
      path: '_swapData.[0].approveTo',
      label: 'Swap Data Approve To',
      visible: 'never',
    },
    {
      path: '_swapData.[0].requiresDeposit',
      label: 'Swap Data Requires Deposit',
      visible: 'never',
    },
  ],
}

// Functions on the diamond that intentionally don't carry a clear-signing entry.
// Explicit, not pattern-coincidental: a new user-facing verb (e.g. `executeIntent`)
// must either get a template above OR be added here with a justification.
// Anything that matches neither hits the unrecognized-prefix failure in main()
// and blocks the PR via verifyClearSigning.yml.
const NON_USER_FACING_PREFIXES = [
  'init', // initCelerCircleBridge, initPolymerCCTP, initDeBridgeDln, initMegaETH, initOptimism — owner-only one-shot setup
  'register', // registerOptimismBridge, registerMegaETHBridge, registerPeripheryContract — owner-only config
  'set', // setApprovalFor*, setCanExecute, setContractSelectorWhitelist, setDeBridgeChainId — owner/admin config
  'unset', // unsetChainIdToDomainId — owner/admin config (inverse of set*)
  'get', // getDeBridgeChainId, getDestinationChainsValue, getPeripheryContract, getStorage, getWhitelistedSelectorsForContract, getAllContractSelectorPairs — view-only
  'is', // isContractSelectorWhitelisted, isQuoteConsumed — view-only
  'extract', // extractBridgeData, extractData, extractGenericSwapParameters, extractMainParameters, extractNonEVMAddress, extractSwapData — pure calldata helpers
  'validate', // validateCalldata, validateDestinationCalldata — pure
  'batchSet', // batchSetContractSelectorWhitelist — owner-only config
  'encode_', // encode_startBridgeTokensVia*Packed — off-chain helpers, not signed by users
  'decode_', // decode_startBridgeTokensVia*Packed — off-chain helpers, not signed by users
]
const NON_USER_FACING_NAMES = new Set([
  // Diamond / ownership / admin one-offs
  'owner',
  'facets',
  'facetAddress',
  'facetAddresses',
  'facetFunctionSelectors',
  'supportsInterface',
  'diamondCut',
  'removeFacet',
  'transferOwnership',
  'cancelOwnershipTransfer',
  'confirmOwnershipTransfer',
  'pauseDiamond',
  'unpauseDiamond',
  'addressCanExecuteMethod',
  // Admin/relayer-only; users do not sign these directly. If a wallet integration
  // ever wants clear-signing for owner-side recovery flows, classify and remove.
  'withdraw', // WithdrawFacet — owner-only recovery
  'executeCallAndWithdraw', // operator-only utility
])

const PACKED_OR_MIN_SUFFIX = /(Packed|Min)$/u

// The exclusion below is a silent escape from a strict-by-default generator, so
// it is keyed on the bridge prefix as well as the suffix. A future user-facing
// function that merely ends in `Min` (say `executeIntentMin`) must not inherit
// the exemption — it falls through to the unrecognized-prefix failure instead,
// which is what forces someone to classify it.
const PACKED_OR_MIN_BRIDGE_VARIANT =
  /^(startBridgeTokensVia|swapAndStartBridgeTokensVia).*(Packed|Min)$/u

function isKnownNonUserFacing(fn: IAbiFn): boolean {
  const name = fn.name
  // Zero-input functions are usually Solidity-generated getters for `public`
  // state variables / constants (e.g. `spokePool()`, `ACROSS_CHAIN_ID_SOLANA()`,
  // `pendingOwner()`) — skip those. The exception is `*Packed` / `*Min` bridge
  // variants: they declare no ABI params but read `msg.data` manually, so they
  // are user-facing entry-points despite having `inputs.length === 0`.
  if (fn.inputs.length === 0 && !PACKED_OR_MIN_SUFFIX.test(name)) return true
  if (NON_USER_FACING_NAMES.has(name)) return true
  for (const prefix of NON_USER_FACING_PREFIXES)
    if (name.startsWith(prefix)) return true
  return false
}

function main() {
  const fns = collectFns()
  const out: Record<string, IFormatEntry> = {}
  // Hard-fail on any user-facing function the generator can't confidently
  // template. Silent skips would let a new facet land with no clear-signing,
  // or worse, with the wrong template silently emitting paths that resolve to
  // the wrong field. Either is the exact failure mode ERC-7730 is meant to
  // prevent. The CI gate (see .github/workflows/verifyClearSigning.yml) wires
  // this exit code into the PR-merge gate.
  const failures: string[] = []

  for (const fn of fns) {
    // Skip known non-user-facing functions explicitly (admin, init, view,
    // helpers) BEFORE computing the strict signature: signature() hard-fails
    // on unnamed params (legal Solidity for non-user-facing helpers), so it
    // must run only on the functions we actually emit. Keeping the skip-list
    // here rather than at collection time means new user-facing verbs not in
    // either the templates or the skip list still fall through to the failure
    // branch below.
    if (isKnownNonUserFacing(fn)) continue
    // Packed/Min variants are signed by relayer infrastructure, not end users.
    // Packed encodes its args in a bespoke layout with no ABI parameters, so
    // ERC-7730 cannot describe it at all; Min carries a packed tuple we do not
    // decode. A title-only entry (intent, empty fields) renders nothing useful
    // and the registry rejects it, so emit no entry — these functions fall back
    // to blind-signing until there is wallet demand for full decoding. Skipped
    // before signature() for the same reason as the check above, and ahead of
    // the prefix dispatch so they never reach the unrecognized-prefix failure.
    // (EXSC-926)
    if (PACKED_OR_MIN_BRIDGE_VARIANT.test(fn.name)) continue
    const sig = signature(fn)
    if (fn.name.startsWith('swapTokens')) {
      const tpl = SWAP_TEMPLATES[fn.name]
      if (!tpl) {
        failures.push(
          `${sig}\n      reason: no SWAP_TEMPLATES entry for "${fn.name}"\n      fix:    add a hardcoded entry in tasks/buildClearSigningProposal.ts SWAP_TEMPLATES with the right intent/interpolatedIntent/fields for this signature.`
        )
        continue
      }
      out[sig] = tpl
    } else if (/^(swapAndStart|start)BridgeTokensVia/u.test(fn.name)) {
      const variant: Variant = fn.name.startsWith('swapAndStart')
        ? 'swap'
        : 'start'
      const err =
        variant === 'swap' ? validateSwapAndStartFn(fn) : validateStartFn(fn)
      if (err) {
        failures.push(
          `${sig}\n      reason: shape mismatch — ${err}\n      fix:    align the facet's _bridgeData/_swapData struct with LiFi.BridgeData / LibSwap.SwapData (canonical), OR teach buildClearSigningProposal.ts about the new shape.`
        )
        continue
      }
      const fieldErr = validateFacetFields(fn, variant)
      if (fieldErr) {
        failures.push(
          `${sig}\n      reason: bridge-specific display field mismatch — ${fieldErr}\n      fix:    update the BRIDGE_FACET_DISPLAY entry in buildClearSigningProposal.ts to match the facet's current struct.`
        )
        continue
      }
      out[sig] = buildBridgeFormat(fn, variant)
    } else {
      failures.push(
        `${sig}\n      reason: unrecognized prefix — function name "${fn.name}" doesn't match any classifier (startBridgeTokensVia / swapAndStartBridgeTokensVia / swapTokens / *Packed / *Min) and isn't in the explicit non-user-facing skip-list.\n      fix:    if this is a user-facing entry-point, add a new classifier branch in buildClearSigningProposal.ts main(). If not, add it to NON_USER_FACING_NAMES / NON_USER_FACING_PREFIXES at the top of main() with a one-line justification.`
      )
    }
  }

  for (const [sig, entry] of Object.entries(out)) {
    const intentErr = validateIntentPlaceholders(entry)
    if (intentErr)
      failures.push(
        `${sig}\n      reason: ${intentErr}\n      fix:    reference a field the format displays, or add that field.`
      )
  }

  if (failures.length > 0) {
    console.error(
      `\n❌ buildClearSigningProposal: ${failures.length} function(s) could not be templated.\n`
    )
    for (const f of failures) console.error(`   - ${f}\n`)
    console.error(
      'Generator refuses to write a partial proposal. The CI gate (verifyClearSigning) will fail until every user-facing function is covered.\n'
    )
    process.exit(1)
  }

  const payload = {
    $note:
      'ERC-7730 display.formats entries for the LIFI Diamond, generated by tasks/buildClearSigningProposal.ts from Foundry artifacts. Source of truth for clear-signing UX strings. Consumed by tasks/generateLedgerClearSigning.ts during the sync workflow: entries here are merged into the registry payload pushed to ethereum/clear-signing-erc7730-registry.',
    $count: Object.keys(out).length,
    formats: out,
  }
  // Deliberately no `$generatedAt`: git already records when the file changed,
  // and an embedded timestamp would churn the file on every re-run with no
  // information content.

  fs.mkdirSync(path.dirname(TARGET), { recursive: true })
  fs.writeFileSync(TARGET, `${JSON.stringify(payload, null, 2)}\n`)
  console.log(`Wrote ${Object.keys(out).length} entries to ${TARGET}`)
}

main()
