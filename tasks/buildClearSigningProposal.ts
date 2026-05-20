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
 * for the `display.formats` entries LI.FI proposes for the descriptor at
 * `ethereum/clear-signing-erc7730-registry/registry/lifi/calldata-LIFIDiamond.json`.
 *
 * Whether `tasks/generateLedgerClearSigning.ts` consumes this file (merges it
 * into the registry payload) is a property of the generator at any given
 * commit — see that file's docstring for current behavior. The contents of
 * this file are reviewed against intent, independent of pipeline wiring.
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

function canonicalType(p: IAbiParam): string {
  if (p.type.startsWith('tuple')) {
    const inner = (p.components ?? []).map(canonicalType).join(',')
    return `(${inner})${p.type.slice('tuple'.length)}`
  }
  return p.type
}
function signature(fn: IAbiFn): string {
  return `${fn.name}(${fn.inputs.map(canonicalType).join(',')})`
}

function collectFns(): IAbiFn[] {
  const facetsDir = path.join(ROOT, 'src', 'Facets')
  const fnNames = new Set<string>()
  const out: Record<string, IAbiFn> = {}

  const facetFiles = fs
    .readdirSync(facetsDir)
    .filter((f) => f.endsWith('.sol'))
  for (const f of facetFiles) {
    const artifact = path.join(OUT_DIR, f, f.replace(/\.sol$/u, '.json'))
    if (!fs.existsSync(artifact)) continue
    const json = JSON.parse(fs.readFileSync(artifact, 'utf8')) as {
      abi: IAbiFn[]
    }
    for (const item of json.abi ?? []) {
      if (item.type !== 'function') continue
      if (
        !/^(startBridgeTokensVia|swapAndStartBridgeTokensVia|swapTokens)/u.test(
          item.name
        )
      )
        continue
      const sig = signature(item)
      if (out[sig]) continue
      out[sig] = item
      fnNames.add(item.name)
    }
  }
  return Object.values(out).sort((a, b) =>
    signature(a).localeCompare(signature(b))
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
  { path: '_bridgeData.transactionId', label: 'Transaction Id', visible: 'never' },
  { path: '_bridgeData.bridge', label: 'Bridge', visible: 'never' },
  { path: '_bridgeData.integrator', label: 'Integrator', visible: 'never' },
  { path: '_bridgeData.referrer', label: 'Referrer', visible: 'never' },
  { path: '_bridgeData.hasSourceSwaps', label: 'Has Source Swaps', visible: 'never' },
  { path: '_bridgeData.hasDestinationCall', label: 'Has Destination Call', visible: 'never' },
]

const RECEIVER_FIELD: IField= {
  path: '_bridgeData.receiver',
  label: 'Recipient',
  format: 'addressName',
  params: { types: ['eoa', 'contract'], sources: ['local', 'ens'] },
  visible: 'always',
}

const CHAIN_FIELD: IField= {
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
  if (!m) return fnName
  return m[1].replace(/(ERC20|Native)?(Packed|Min)?$/u, '').trim() || m[1]
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
      ...HIDDEN_BRIDGE_FIELDS,
      { path: '_swapData.[].callData', label: 'Swap Data Call Data', visible: 'never' },
      { path: '_swapData.[].callTo', label: 'Swap Data Call To', visible: 'never' },
      { path: '_swapData.[].approveTo', label: 'Swap Data Approve To', visible: 'never' },
      { path: '_swapData.[].requiresDeposit', label: 'Swap Data Requires Deposit', visible: 'never' },
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
      { path: '_swapData.callData', label: 'Swap Data Call Data', visible: 'never' },
      { path: '_swapData.requiresDeposit', label: 'Swap Data Requires Deposit', visible: 'never' },
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
  ...SWAP_TEMPLATES.swapTokensSingleV3ERC20ToERC20,
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
    { path: '_swapData.callData', label: 'Swap Data Call Data', visible: 'never' },
    { path: '_swapData.callTo', label: 'Swap Data Call To', visible: 'never' },
    { path: '_swapData.approveTo', label: 'Swap Data Approve To', visible: 'never' },
    { path: '_swapData.requiresDeposit', label: 'Swap Data Requires Deposit', visible: 'never' },
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
    { path: '_swapData.[].callData', label: 'Swap Data Call Data', visible: 'never' },
    { path: '_swapData.[].callTo', label: 'Swap Data Call To', visible: 'never' },
    { path: '_swapData.[].approveTo', label: 'Swap Data Approve To', visible: 'never' },
    { path: '_swapData.[].requiresDeposit', label: 'Swap Data Requires Deposit', visible: 'never' },
  ],
}
SWAP_TEMPLATES.swapTokensMultipleV3ERC20ToNative = {
  ...SWAP_TEMPLATES.swapTokensMultipleV3ERC20ToERC20,
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
    { path: '_swapData.[0].callData', label: 'Swap Data Call Data', visible: 'never' },
    { path: '_swapData.[0].callTo', label: 'Swap Data Call To', visible: 'never' },
    { path: '_swapData.[0].approveTo', label: 'Swap Data Approve To', visible: 'never' },
    { path: '_swapData.[0].requiresDeposit', label: 'Swap Data Requires Deposit', visible: 'never' },
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
    { path: '_swapData.[].callData', label: 'Swap Data Call Data', visible: 'never' },
    { path: '_swapData.[].callTo', label: 'Swap Data Call To', visible: 'never' },
    { path: '_swapData.[].approveTo', label: 'Swap Data Approve To', visible: 'never' },
    { path: '_swapData.[].requiresDeposit', label: 'Swap Data Requires Deposit', visible: 'never' },
  ],
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
      out[sig] = buildSwapAndStartFormat(fn)
    } else if (fn.name.startsWith('startBridgeTokensVia')) {
      const err = validateStartFn(fn)
      if (err) {
        failures.push(
          `${sig}\n      reason: shape mismatch — ${err}\n      fix:    align the facet's _bridgeData struct with LiFi.BridgeData (canonical), OR teach buildClearSigningProposal.ts about the new shape.`
        )
        continue
      }
      out[sig] = buildStartFormat(fn)
    } else {
      failures.push(
        `${sig}\n      reason: unrecognized prefix — function name "${fn.name}" doesn't match any classifier (startBridgeTokensVia / swapAndStartBridgeTokensVia / swapTokens / *Packed / *Min).\n      fix:    if this is a user-facing entry-point, add a new classifier branch in buildClearSigningProposal.ts main(). If not, narrow the collectFns() regex to exclude it.`
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
      'ERC-7730 display.formats entries for the LIFI Diamond, generated by tasks/buildClearSigningProposal.ts from Foundry artifacts. Source of truth for clear-signing UX strings; consumed by tasks/generateLedgerClearSigning.ts when that generator is configured to merge display.formats into the registry payload.',
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
