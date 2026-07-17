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
  return Object.values(out).sort((a, b) =>
    collectionSignature(a).localeCompare(collectionSignature(b))
  )
}

interface IField {
  path: string
  label: string
  format?: string
  params?: Record<string, unknown>
  visible?: 'always' | 'never'
}
interface IFormatEntry {
  $id?: string
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
  {
    path: '_bridgeData.hasDestinationCall',
    label: 'Has Destination Call',
    visible: 'never',
  },
]

const RECEIVER_FIELD: IField = {
  path: '_bridgeData.receiver',
  label: 'Recipient',
  format: 'addressName',
  params: { types: ['eoa', 'contract'], sources: ['local', 'ens'] },
  visible: 'always',
}

const CHAIN_FIELD: IField = {
  path: '_bridgeData.destinationChainId',
  label: 'Destination Chain',
  // No first-class "chainId" formatter in ERC-7730 v2; raw uint is rendered as-is.
  // Wallets that know the chain registry can pretty-print it themselves.
  format: 'raw',
  visible: 'always',
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

// ---------- bridge-specific "true recipient" fields ----------
//
// For most bridges the on-chain recipient is `_bridgeData.receiver`, so
// RECEIVER_FIELD is the whole story. A number of bridges instead credit funds on
// the destination chain to a *bridge-specific* struct field, and
// `_bridgeData.receiver` is then a sentinel or an intermediary contract. We
// surface that field as an extra always-visible entry so the clear-signing text
// reflects where the bridge actually sends the funds.
//
// The extra field is `bytes`/`bytes32` (it may hold a non-EVM address such as a
// Solana pubkey), and ERC-7730 v2 `addressName` only accepts `address` — there is
// no bytes32→EVM-address formatter — so the honest rendering is `raw` (hex).
// `interpolatedIntent` intentionally stays on `_bridgeData.receiver`: for the
// dominant EVM path it resolves to a trusted name/ENS, and the raw field carries
// the ground truth for the rest.
//
// Two shapes (both handled identically here; the difference is only in what the
// field holds on an EVM transfer):
//
//   TYPE-A — the field is the on-chain recipient in *every* branch, so it is
//   always populated. AcrossV4/DeBridgeDln can even differ from
//   `_bridgeData.receiver` on EVM (destination call → our Receiver contract;
//   DeBridgeDln never cross-checks), so the field adds signal on EVM too. Glacis/
//   AllBridge/LiFiIntentEscrow/GasZip enforce equality on plain EVM transfers, so
//   there the field just re-shows the recipient and carries the real value on
//   non-EVM.
//
//   TYPE-B — a `nonEVMReceiver`-style field that is only set on non-EVM transfers
//   and is `0x0` on EVM (where `_bridgeData.receiver` is the faithful recipient).
//   Labelled "Non-EVM Recipient" so the `0x0` on an EVM transfer reads as "N/A".
//
// Keyed by bridge identity from bridgeFacetName(). Deliberately excluded:
//   - AcrossV4Swap / other opaque, EIP-712-gated flows — the receiver lives in
//     opaque calldata and is not on-chain-verifiable by design.
//   - Squid — the recipient is route-type-dependent (destinationAddress for some
//     routes, _bridgeData.receiver for others); no single field is always right.
// (See docs/ClearSigningProposal.md for the full audit + follow-up scope.)
interface IExtraReceiver {
  paramName: string
  component: string
  type: string
  label: string
}

const BRIDGE_EXTRA_RECEIVERS: Record<string, IExtraReceiver> = {
  // TYPE-A: field is the bridge's on-chain recipient in every branch.
  AcrossV4: {
    paramName: '_acrossData',
    component: 'receiverAddress',
    type: 'bytes32',
    label: 'Across Recipient',
  },
  DeBridgeDln: {
    paramName: '_deBridgeData',
    component: 'receiver',
    type: 'bytes',
    label: 'DeBridge Recipient',
  },
  Glacis: {
    paramName: '_glacisData',
    component: 'receiverAddress',
    type: 'bytes32',
    label: 'Glacis Recipient',
  },
  AllBridge: {
    paramName: '_allBridgeData',
    component: 'recipient',
    type: 'bytes32',
    label: 'AllBridge Recipient',
  },
  LiFiIntentEscrow: {
    paramName: '_lifiIntentData',
    component: 'recipient',
    type: 'bytes32',
    label: 'Intent Recipient',
  },
  LiFiIntentEscrowV2: {
    paramName: '_lifiIntentData',
    component: 'recipient',
    type: 'bytes32',
    label: 'Intent Recipient',
  },
  GasZip: {
    // NOTE: this bytes32 is RIGHT-padded (bytes32(bytes20(addr))), unlike the
    // left-padded convention elsewhere; `raw` shows the address in the high bytes.
    paramName: '_gasZipData',
    component: 'receiverAddress',
    type: 'bytes32',
    label: 'GasZip Recipient',
  },
  // TYPE-B: nonEVMReceiver-style field, only set on non-EVM transfers (0x0 on EVM).
  Mayan: {
    paramName: '_mayanData',
    component: 'nonEVMReceiver',
    type: 'bytes32',
    label: 'Non-EVM Recipient',
  },
  LayerSwap: {
    paramName: '_layerSwapData',
    component: 'nonEVMReceiver',
    type: 'bytes32',
    label: 'Non-EVM Recipient',
  },
  Chainflip: {
    paramName: '_chainflipData',
    component: 'nonEVMReceiver',
    type: 'bytes',
    label: 'Non-EVM Recipient',
  },
  Eco: {
    paramName: '_ecoData',
    component: 'nonEVMReceiver',
    type: 'bytes',
    label: 'Non-EVM Recipient',
  },
  NEARIntents: {
    paramName: '_nearData',
    component: 'nonEVMReceiver',
    type: 'bytes32',
    label: 'Non-EVM Recipient',
  },
  PolymerCCTP: {
    paramName: '_polymerData',
    component: 'nonEVMReceiver',
    type: 'bytes32',
    label: 'Non-EVM Recipient',
  },
}

function extraReceiverSpec(fn: IAbiFn): IExtraReceiver | null {
  return BRIDGE_EXTRA_RECEIVERS[bridgeFacetName(fn.name)] ?? null
}

// Strict-by-default: if a bridge declares an extra-receiver field above, the
// referenced tuple component must exist in the ABI with the expected type. A
// struct rename must fail the generator (and CI) loudly rather than emit a dead
// display path that silently resolves to nothing in wallets.
function validateExtraReceiver(fn: IAbiFn): string | null {
  const spec = extraReceiverSpec(fn)
  if (!spec) return null
  const param = fn.inputs.find((p) => p.name === spec.paramName)
  // Exact `tuple`, not `startsWith('tuple')`: a `tuple[]` param would need an
  // index in the path and must not silently satisfy a single-struct lookup.
  if (!param || param.type !== 'tuple')
    return `expected param "${spec.paramName}" of tuple type for bridge-specific recipient; got name="${param?.name}" type="${param?.type}"`
  const comp = (
    param.components as { name: string; type: string }[] | undefined
  )?.find((c) => c.name === spec.component)
  if (!comp)
    return `${spec.paramName}: missing component "${spec.component}" (bridge-specific recipient)`
  // Exact type match, not a prefix: `startsWith('bytes')` would wrongly accept
  // `bytes32[]`/`bytes16`, and `startsWith('bytes32')` would accept `bytes32[]`
  // — incompatible shapes that would pass CI but render the wrong value.
  if (comp.type !== spec.type)
    return `${spec.paramName}: component "${spec.component}" has type "${comp.type}", expected exactly "${spec.type}"`
  return null
}

function extraReceiverFields(fn: IAbiFn): IField[] {
  const spec = extraReceiverSpec(fn)
  if (!spec) return []
  return [
    {
      path: `${spec.paramName}.${spec.component}`,
      label: spec.label,
      // bytes32 recipient (may be non-EVM); addressName accepts `address` only.
      format: 'raw',
      visible: 'always',
    },
  ]
}

function variantTag(fnName: string): string | null {
  // Packed/Min disambiguator for the intent string.
  const native = /Native(Packed|Min)$/u.test(fnName)
  const erc20 = /ERC20(Packed|Min)$/u.test(fnName)
  const packed = /Packed$/u.test(fnName)
  const min = /Min$/u.test(fnName)
  const layer = /HopL1/u.test(fnName)
    ? 'L1'
    : /HopL2/u.test(fnName)
    ? 'L2'
    : null
  const bits: string[] = []
  if (layer) bits.push(layer)
  if (native) bits.push('native')
  else if (erc20) bits.push('ERC-20')
  if (packed) bits.push('packed')
  else if (min) bits.push('min')
  return bits.length ? bits.join(', ') : null
}

function buildStartFormat(fn: IAbiFn): IFormatEntry {
  const facet = bridgeFacetName(fn.name)
  return {
    intent: `Bridge via ${facet}`,
    // Bridge identity is the most important security signal in a bridge tx —
    // different bridges have very different trust + finality models. Wallets
    // prefer `interpolatedIntent` over `intent`, so if we only put the bridge
    // name in `intent` it never reaches the user. Hardcode it into the
    // template (constant per selector; no extra wallet-side work).
    interpolatedIntent: `Bridge {_bridgeData.minAmount} via ${facet} to chain {_bridgeData.destinationChainId} for {_bridgeData.receiver}`,
    fields: [
      {
        path: '_bridgeData.minAmount',
        label: 'Amount to Bridge',
        format: 'tokenAmount',
        params: { tokenPath: '_bridgeData.sendingAssetId' },
        visible: 'always',
      },
      CHAIN_FIELD,
      RECEIVER_FIELD,
      ...extraReceiverFields(fn),
      ...HIDDEN_BRIDGE_FIELDS,
    ],
  }
}

function buildSwapAndStartFormat(fn: IAbiFn): IFormatEntry {
  const facet = bridgeFacetName(fn.name)
  return {
    intent: `Swap & Bridge via ${facet}`,
    // Same rationale as buildStartFormat: surface the bridge identity in the
    // template, not just in the fallback `intent`.
    interpolatedIntent: `Swap then bridge {_bridgeData.minAmount} via ${facet} to chain {_bridgeData.destinationChainId} for {_bridgeData.receiver}`,
    fields: [
      {
        path: '_swapData.[0].fromAmount',
        label: 'Amount to Swap',
        format: 'tokenAmount',
        params: { tokenPath: '_swapData.[0].sendingAssetId' },
        visible: 'always',
      },
      {
        path: '_bridgeData.minAmount',
        label: 'Minimum to Bridge',
        format: 'tokenAmount',
        params: { tokenPath: '_bridgeData.sendingAssetId' },
        visible: 'always',
      },
      CHAIN_FIELD,
      RECEIVER_FIELD,
      ...extraReceiverFields(fn),
      ...HIDDEN_BRIDGE_FIELDS,
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
        params: { tokenPath: '_swapData.sendingAssetId' },
        visible: 'always',
      },
      {
        path: '_minAmountOut',
        label: 'Minimum to Receive',
        format: 'tokenAmount',
        params: { tokenPath: '_swapData.receivingAssetId' },
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
  swapTokensGeneric: undefined as unknown as IFormatEntry,
}
// Derivation: same as ERC20ToERC20 but for Native variants the `fromAmount`
// (or the @.value for the legacy descriptor) is replaced. We just reproduce
// the existing descriptor's field shape and append `interpolatedIntent`.

SWAP_TEMPLATES.swapTokensSingleV3ERC20ToNative = {
  // Cast: the ERC20ToERC20 entry is the literal object above and always present
  // at this point. Required because `Record<string, T>` indexed access returns
  // `T | undefined` under `noUncheckedIndexedAccess`.
  ...(SWAP_TEMPLATES.swapTokensSingleV3ERC20ToERC20 as IFormatEntry),
}
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
      params: { tokenPath: '_swapData.receivingAssetId' },
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
SWAP_TEMPLATES.swapTokensMultipleV3ERC20ToERC20 = {
  intent: 'Swap',
  interpolatedIntent:
    'Swap {_swapData.[0].fromAmount} for at least {_minAmountOut} to {_receiver}',
  fields: [
    {
      path: '_swapData.[0].fromAmount',
      label: 'Amount to Send',
      format: 'tokenAmount',
      params: { tokenPath: '_swapData.[0].sendingAssetId' },
      visible: 'always',
    },
    {
      path: '_minAmountOut',
      label: 'Minimum to Receive',
      format: 'tokenAmount',
      params: { tokenPath: '_swapData.[-1].receivingAssetId' },
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
SWAP_TEMPLATES.swapTokensMultipleV3ERC20ToNative = {
  // See note on the SingleV3 variant above re. the cast.
  ...(SWAP_TEMPLATES.swapTokensMultipleV3ERC20ToERC20 as IFormatEntry),
}
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
      params: { tokenPath: '_swapData.[-1].receivingAssetId' },
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
SWAP_TEMPLATES.swapTokensGeneric = {
  $id: 'swapTokensGeneric',
  intent: 'Swap',
  interpolatedIntent:
    'Swap {_swapData.[0].fromAmount} for at least {_minAmount} to {_receiver}',
  fields: [
    {
      path: '_swapData.[0].fromAmount',
      label: 'Amount to Send',
      format: 'tokenAmount',
      params: { tokenPath: '_swapData.[0].sendingAssetId' },
      visible: 'always',
    },
    {
      path: '_minAmount',
      label: 'Minimum to Receive',
      format: 'tokenAmount',
      params: { tokenPath: '_swapData.[-1].receivingAssetId' },
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

// Functions on the diamond that intentionally don't carry a clear-signing entry.
// Explicit, not pattern-coincidental: a new user-facing verb (e.g. `executeIntent`)
// must either get a template above OR be added here with a justification.
// Anything that matches neither hits the unrecognized-prefix failure in main()
// and blocks the PR via verifyClearSigning.yml.
const NON_USER_FACING_PREFIXES = [
  'init', // initCelerCircleBridge, initHop, initPolymerCCTP, initDeBridgeDln, initMegaETH, initOptimism — owner-only one-shot setup
  'register', // registerBridge, registerOptimismBridge, registerMegaETHBridge, registerPeripheryContract — owner-only config
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
  'triggerRefund', // CBridge refund — admin-side
  'executeCallAndWithdraw', // operator-only utility
])

function isKnownNonUserFacing(fn: IAbiFn): boolean {
  const name = fn.name
  // Zero-input functions are usually Solidity-generated getters for `public`
  // state variables / constants (e.g. `spokePool()`, `ACROSS_CHAIN_ID_SOLANA()`,
  // `pendingOwner()`) — skip those. The exception is `*Packed` / `*Min` bridge
  // variants: they declare no ABI params but read `msg.data` manually, so they
  // are user-facing entry-points despite having `inputs.length === 0`.
  if (fn.inputs.length === 0 && !/(Packed|Min)$/u.test(name)) return true
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
    } else if (/(Packed|Min)$/u.test(fn.name)) {
      // Packed/Min variants encode args differently and are typically only
      // signed by relayer infrastructure, not end users. Emit a static intent
      // only; full interpolation would require per-facet calldata decoders
      // (each packed variant has its own bespoke layout). Deferred until we
      // see wallet demand for full decoding here.
      const facet = bridgeFacetName(fn.name)
      const tag = variantTag(fn.name)
      out[sig] = {
        intent: `Bridge via ${facet}${tag ? ` (${tag})` : ''}`,
        fields: [],
      }
    } else if (fn.name.startsWith('swapAndStartBridgeTokensVia')) {
      const err = validateSwapAndStartFn(fn)
      if (err) {
        failures.push(
          `${sig}\n      reason: shape mismatch — ${err}\n      fix:    align the facet's _bridgeData/_swapData struct with LiFi.BridgeData / LibSwap.SwapData (canonical), OR teach buildClearSigningProposal.ts about the new shape.`
        )
        continue
      }
      const extraErr = validateExtraReceiver(fn)
      if (extraErr) {
        failures.push(
          `${sig}\n      reason: bridge-specific recipient mismatch — ${extraErr}\n      fix:    update the BRIDGE_EXTRA_RECEIVERS entry in buildClearSigningProposal.ts to match the facet's current struct field.`
        )
        continue
      }
      out[sig] = buildSwapAndStartFormat(fn)
    } else if (fn.name.startsWith('startBridgeTokensVia')) {
      const err = validateStartFn(fn)
      if (err) {
        failures.push(
          `${sig}\n      reason: shape mismatch — ${err}\n      fix:    align the facet's _bridgeData struct with LiFi.BridgeData (canonical), OR teach buildClearSigningProposal.ts about the new shape.`
        )
        continue
      }
      const extraErr = validateExtraReceiver(fn)
      if (extraErr) {
        failures.push(
          `${sig}\n      reason: bridge-specific recipient mismatch — ${extraErr}\n      fix:    update the BRIDGE_EXTRA_RECEIVERS entry in buildClearSigningProposal.ts to match the facet's current struct field.`
        )
        continue
      }
      out[sig] = buildStartFormat(fn)
    } else {
      failures.push(
        `${sig}\n      reason: unrecognized prefix — function name "${fn.name}" doesn't match any classifier (startBridgeTokensVia / swapAndStartBridgeTokensVia / swapTokens / *Packed / *Min) and isn't in the explicit non-user-facing skip-list.\n      fix:    if this is a user-facing entry-point, add a new classifier branch in buildClearSigningProposal.ts main(). If not, add it to NON_USER_FACING_NAMES / NON_USER_FACING_PREFIXES at the top of main() with a one-line justification.`
      )
    }
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
