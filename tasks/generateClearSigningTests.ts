import fs from 'fs'

import { defineCommand, runMain } from 'citty'
import type { AbiFunction, AbiParameter } from 'viem'
import {
  encodeFunctionData,
  parseAbiItem,
  parseTransaction,
  serializeTransaction,
  toFunctionSelector,
} from 'viem'

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// Marks an expectation the reference runner has not filled in yet. Only these
// are ever overwritten by --results.
const PENDING_INTENT = 'PENDING'

// 13 bridges display their own recipient (`Non-EVM Recipient`, `GasZip
// Recipient`, …) alongside `_bridgeData.receiver`. A type-derived zero would
// make those fixtures assert that the destination screen shows 0x0 — so these
// components carry an explicit value. Deliberately synthetic: it must not read
// as a real account anyone could mistake for a live destination.
const NON_EVM_RECEIVER =
  '0x7c9e6679a2b1c4f0d38e4b5a6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e8f9'

// NEARIntents displays the signed destination asset (`Destination Asset`).
// Left-padded USDC, matching TEST_DESTINATION_ASSET in the facet tests.
const NEAR_DESTINATION_ASSET =
  '0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'

// Displayed bytes/bytes32 struct components and the value each renders with. A
// component missing here falls back to the type default — 0x0 — and fails
// --check the moment a field displays it.
const DISPLAYED_COMPONENT_VALUES: Record<string, string> = {
  receiverAddress: NON_EVM_RECEIVER,
  recipient: NON_EVM_RECEIVER,
  nonEVMReceiver: NON_EVM_RECEIVER,
  receiver: NON_EVM_RECEIVER,
  destinationAsset: NEAR_DESTINATION_ASSET,
}

// The native-in swapTokens* formats display `@.value` — the amount the user
// sends — rather than a calldata parameter. Encoding the default 0 would make
// those fixtures assert "Amount to send: 0 ETH".
const NATIVE_VALUE = 2_098_039_615_199_859n

// Tokens referenced by the generated calldata. The runner resolves symbol and
// decimals from here, so fixtures need no network access.
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const RECEIVER = '0x78b59874BF0Fb404D88D9e688fdC56eE3E085e6b'

const DATA_PROVIDER_TOKENS = {
  [USDC.toLowerCase()]: { decimals: 6, name: 'USD Coin', symbol: 'USDC' },
  [WETH.toLowerCase()]: { decimals: 18, name: 'Wrapped Ether', symbol: 'WETH' },
}

// `_bridgeData` and `_swapData[0]` always reach a screen. Bridge-specific
// structs are mostly hidden, except the BRIDGE_EXTRA_RECEIVERS recipients —
// see docs/ClearSigningProposal.md.
const BRIDGE_DATA: Record<string, unknown> = {
  transactionId:
    '0x1b7b4d1c9e0e4a2f8c3d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b',
  bridge: 'lifi',
  integrator: 'lifi-api',
  referrer: ZERO_ADDRESS,
  sendingAssetId: USDC,
  receiver: RECEIVER,
  minAmount: 1_000_000_000n,
  destinationChainId: 10n,
  hasSourceSwaps: false,
  hasDestinationCall: false,
}

const SWAP_DATA: Record<string, unknown> = {
  callTo: ZERO_ADDRESS,
  approveTo: ZERO_ADDRESS,
  sendingAssetId: WETH,
  receivingAssetId: USDC,
  fromAmount: 500_000_000_000_000_000n,
  callData: '0x',
  requiresDeposit: true,
}

// The swapTokens* family displays top-level parameters rather than struct
// components, so those need values too — `--check` reports any that are missed.
const TOP_LEVEL_ARGS: Record<string, unknown> = {
  _transactionId: BRIDGE_DATA.transactionId,
  _integrator: 'lifi-api',
  _referrer: ZERO_ADDRESS,
  _receiver: RECEIVER,
  _minAmount: 1_000_000_000n,
  _minAmountOut: 1_000_000_000n,
}

interface IDescriptorField {
  path: string
  label: string
  visible?: string
}

interface IDescriptorFormat {
  fields?: IDescriptorField[]
}

interface IDescriptorFile {
  context?: {
    contract?: { deployments?: Array<{ chainId: number; address: string }> }
  }
  display?: { formats?: Record<string, IDescriptorFormat> }
  formats?: Record<string, IDescriptorFormat>
}

interface IRenderedCase {
  description: string
  status: string
  rendered?: {
    intent: string
    interpolatedIntent?: string
    owner?: string
    fields: Array<{ label: string; value: unknown }>
  }
  message?: string
}

interface ITestCase {
  description: string
  rawTx: string
  expected: IExpectation
}

interface IExpectation {
  intent?: string
  interpolatedIntent?: string
  owner?: string
  fields?: Array<{ label: string; value: unknown }>
  [key: string]: unknown
}

interface IDataProvider {
  tokens?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Own-property test that does not walk the prototype.
 *
 * `key in obj` would resolve a parameter or component named `toString`,
 * `valueOf` or `constructor` to an inherited member. `Object.hasOwn` is ES2022
 * and the repo targets es2020, so this is the equivalent.
 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

/**
 * Builds a zero value for an ABI type.
 *
 * Undisplayed arguments only need to encode, so deriving them from the type
 * keeps the fixture free of incidental data that could mask a descriptor change
 * surfacing a field nobody vetted. `--check` guards the other direction: a field
 * that IS displayed must never be left at its zero value.
 */
function defaultForType(param: AbiParameter): unknown {
  const { type } = param

  const arrayMatch = type.match(/^(.*)\[(\d*)\]$/)
  if (arrayMatch) {
    const [, inner, size] = arrayMatch
    const count = size ? Number(size) : 0
    const element = { ...param, type: inner } as AbiParameter
    return Array.from({ length: count }, () => defaultForType(element))
  }

  if (type === 'tuple') return defaultForTuple(param)
  if (type.startsWith('uint') || type.startsWith('int')) return 0n
  if (type === 'address') return ZERO_ADDRESS
  if (type === 'bool') return false
  if (type === 'string') return ''
  if (type === 'bytes') return '0x'

  const fixedBytes = type.match(/^bytes(\d+)$/)
  if (fixedBytes) return `0x${'00'.repeat(Number(fixedBytes[1]))}`

  throw new Error(`unsupported ABI type "${type}" — extend defaultForType()`)
}

/**
 * Returns the stand-in value for a displayed bridge-specific component.
 *
 * Only `bytes`/`bytes32` components qualify: an address-typed recipient already
 * renders as an address, and the EVM receiver comes from the bridgeData template.
 */
function componentOverride(component: AbiParameter): string | undefined {
  if (!component.name) return undefined
  if (component.type !== 'bytes32' && component.type !== 'bytes')
    return undefined

  return DISPLAYED_COMPONENT_VALUES[component.name]
}

function defaultForTuple(param: AbiParameter): Record<string, unknown> {
  const components = 'components' in param ? param.components : undefined
  if (!components) throw new Error(`tuple "${param.name}" has no components`)

  const value: Record<string, unknown> = {}
  for (const component of components) {
    if (!component.name)
      throw new Error(`unnamed component in tuple "${param.name}"`)
    value[component.name] =
      componentOverride(component) ?? defaultForType(component)
  }
  return value
}

/**
 * Fills a tuple from a template, falling back to the type default per component.
 *
 * The template is keyed by component name so one template covers every facet
 * that declares the same struct, regardless of component order.
 */
function fromTemplate(
  param: AbiParameter,
  template: Record<string, unknown>
): Record<string, unknown> {
  const value = defaultForTuple(param)
  for (const key of Object.keys(value))
    if (hasOwn(template, key)) value[key] = template[key]

  return value
}

function buildArg(param: AbiParameter, isSwapVariant: boolean): unknown {
  if (param.name === '_bridgeData') {
    return fromTemplate(param, {
      ...BRIDGE_DATA,
      hasSourceSwaps: isSwapVariant,
    })
  }

  // `_swapData` is a tuple[] on the bridge facets and a plain tuple on the
  // swapTokens* family.
  if (param.name === '_swapData') {
    const element = { ...param, type: 'tuple' } as AbiParameter
    const value = fromTemplate(element, SWAP_DATA)
    return param.type.endsWith(']') ? [value] : value
  }

  if (param.name && hasOwn(TOP_LEVEL_ARGS, param.name))
    return TOP_LEVEL_ARGS[param.name]

  return defaultForType(param)
}

/**
 * The transaction value a format needs, in wei.
 *
 * Only `@.value` reaches a screen from the transaction envelope; every other
 * displayed path resolves into calldata.
 */
function nativeValueFor(format: IDescriptorFormat): bigint {
  const displaysValue = (format.fields ?? []).some(
    (field) =>
      field.path === '@.value' && (field.visible ?? 'always') !== 'never'
  )

  return displaysValue ? NATIVE_VALUE : 0n
}

function buildRawTx(
  formatKey: string,
  diamond: string,
  chainId: number,
  value: bigint
): string {
  const abiItem = parseAbiItem(`function ${formatKey}`) as AbiFunction
  const isSwapVariant = abiItem.name.startsWith('swapAndStart')
  const args = abiItem.inputs.map((input) => buildArg(input, isSwapVariant))

  const data = encodeFunctionData({ abi: [abiItem], args })

  // Unsigned: the runners do not verify signatures, so fixtures stay
  // reproducible without a key. See the registry README, "Reference test cases".
  return serializeTransaction({
    chainId,
    type: 'eip1559',
    to: diamond as `0x${string}`,
    value,
    nonce: 622,
    gas: 2_000_000n,
    maxFeePerGas: 495_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
    data,
  })
}

function readDiamondAddress(
  descriptor: IDescriptorFile,
  chainId: number
): string {
  const deployments = descriptor?.context?.contract?.deployments ?? []
  const match = deployments.find(
    (entry: { chainId: number }) => entry.chainId === chainId
  )
  if (!match)
    throw new Error(`descriptor has no deployment for chain ${chainId}`)

  return match.address
}

/**
 * The selector a test case exercises.
 *
 * Mirrors how the registry's own coverage check reads a fixture: the selector is
 * the first four bytes of the transaction's calldata.
 */
function selectorOf(test: ITestCase): string | undefined {
  if (typeof test.rawTx !== 'string') return undefined
  const { data } = parseTransaction(test.rawTx as `0x${string}`)

  return data?.slice(0, 10).toLowerCase()
}

function readExistingTests(fixturePath: string): ITestCase[] {
  if (!fs.existsSync(fixturePath)) return []

  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')).tests ?? []
}

function readDataProvider(fixturePath?: string): IDataProvider {
  if (!fixturePath || !fs.existsSync(fixturePath)) return {}

  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')).dataProvider ?? {}
}

/**
 * Merges the generated token metadata into the existing dataProvider.
 *
 * Existing entries win: a hand-written test renders symbols and decimals from
 * this block, so dropping or redefining one silently changes what that test
 * asserts. Spreading `existing` last also carries its sibling keys through —
 * `addressNames`, `ensNames` and `nftCollectionNames` feed displayed fields
 * just as `tokens` does, and a case outliving the entry it renders from fails
 * in the registry's runner.
 */
function mergeDataProvider(fixturePath?: string): IDataProvider {
  const existing = readDataProvider(fixturePath)

  // Append rather than merge, so existing entries keep both their values and
  // their position — a reordered token table is diff noise a reviewer must read.
  const tokens: Record<string, unknown> = { ...existing.tokens }
  for (const [address, metadata] of Object.entries(DATA_PROVIDER_TOKENS))
    if (!hasOwn(tokens, address)) tokens[address] = metadata

  return { ...existing, tokens }
}

function buildFixture(
  descriptorPath: string,
  chainId: number,
  existingPath?: string
) {
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
  const formats: Record<string, IDescriptorFormat> =
    descriptor?.display?.formats ?? {}
  const diamond = readDiamondAddress(descriptor, chainId)

  // Reviewed cases carry real transactions and expectations a human signed off
  // on; generate only what they do not already cover.
  const tests = existingPath ? readExistingTests(existingPath) : []

  const covered = new Set<string>()
  for (const test of tests) {
    const selector = selectorOf(test)
    if (selector) covered.add(selector)
  }

  for (const [formatKey, format] of Object.entries(formats)) {
    const selector = toFunctionSelector(`function ${formatKey}`).toLowerCase()
    if (covered.has(selector)) continue

    const abiItem = parseAbiItem(`function ${formatKey}`) as AbiFunction
    let rawTx: string
    try {
      rawTx = buildRawTx(formatKey, diamond, chainId, nativeValueFor(format))
    } catch (error) {
      throw new Error(`${abiItem.name}: ${(error as Error).message}`)
    }

    tests.push({
      description: `${abiItem.name} - chain ${chainId}`,
      rawTx,
      expected: { intent: PENDING_INTENT, owner: 'LI.FI', fields: [] },
    })
  }

  return {
    $schema: '../../../specs/erc7730-tests-v2.schema.json',
    descriptor: '../calldata-LIFIDiamond.json',
    dataProvider: mergeDataProvider(existingPath),
    tests,
  }
}

/**
 * Replaces each `expected` block with what the reference runner actually
 * rendered, matching on `description`.
 *
 * The rendered values still need a human read before they are committed — a
 * fixture that snapshots whatever the renderer emitted asserts nothing.
 */
function applyResults(
  fixture: { tests: ITestCase[] },
  resultsPath: string
): number {
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'))
  const byDescription = new Map<string, IRenderedCase>(
    (results.cases ?? []).map((entry: IRenderedCase) => [
      entry.description,
      entry,
    ])
  )

  let applied = 0
  for (const test of fixture.tests) {
    // Never touch an expectation a human already reviewed: if the renderer
    // disagrees with one of those, that is a finding, not something to overwrite.
    if (test.expected?.intent !== PENDING_INTENT) continue

    const rendered = byDescription.get(test.description)?.rendered
    if (!rendered) continue

    test.expected = {
      intent: rendered.intent,
      ...(rendered.interpolatedIntent
        ? { interpolatedIntent: rendered.interpolatedIntent }
        : {}),
      owner: rendered.owner ?? 'LI.FI',
      fields: rendered.fields,
    }
    applied += 1
  }
  return applied
}

function isZeroish(value: unknown): boolean {
  if (value === 0n || value === 0 || value === false || value === '')
    return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value !== 'string') return false

  return /^0x0*$/i.test(value) || value.toLowerCase() === ZERO_ADDRESS
}

/**
 * Resolves a descriptor field path against the arguments built for that format.
 *
 * Paths look like `_bridgeData.minAmount` or `_swapData.[0].fromAmount`.
 * Transaction-level paths (`@.value`) address the envelope, not the arguments,
 * and are skipped by the caller.
 */
function resolvePath(
  args: unknown[],
  inputs: readonly AbiParameter[],
  path: string
): unknown {
  const [head, ...rest] = path.split('.')
  const index = inputs.findIndex((input) => input.name === head)
  if (index === -1) return undefined

  let value: unknown = args[index]
  for (const segment of rest) {
    if (segment.startsWith('[')) {
      value = Array.isArray(value) ? value[0] : undefined
      continue
    }
    value = (value as Record<string, unknown>)?.[segment]
  }
  return value
}

/**
 * Fails when a field the descriptor displays would render as a zero value.
 *
 * A fixture that asserts `Non-EVM Recipient: 0x0…0` passes every runner and
 * tests nothing, so a new displayed component has to be given a value in
 * DISPLAYED_COMPONENT_VALUES (or a template) before it reaches the registry.
 */
function checkVisibleFields(
  formats: Record<string, IDescriptorFormat>
): string[] {
  const problems: string[] = []

  for (const [formatKey, format] of Object.entries(formats)) {
    const abiItem = parseAbiItem(`function ${formatKey}`) as AbiFunction
    const isSwapVariant = abiItem.name.startsWith('swapAndStart')
    const args = abiItem.inputs.map((input) => buildArg(input, isSwapVariant))

    for (const field of format.fields ?? []) {
      if ((field.visible ?? 'always') === 'never') continue

      // `@.` paths read the transaction envelope, not calldata. A visible
      // `@.value` is what makes nativeValueFor() encode NATIVE_VALUE, so it is
      // covered by construction; any other envelope path is a field the
      // generator has no way to populate.
      if (field.path.startsWith('@.')) {
        if (field.path !== '@.value')
          problems.push(
            `${abiItem.name}: "${field.label}" (${field.path}) has no generated value — extend buildRawTx()`
          )
        continue
      }

      // `undefined` means the path did not resolve at all — a renamed parameter
      // or a shape resolvePath() does not walk. It is not a zero value, so
      // isZeroish() would wave it through the very check meant to catch it.
      const value = resolvePath(args, abiItem.inputs, field.path)
      if (value === undefined)
        problems.push(
          `${abiItem.name}: "${field.label}" (${field.path}) does not resolve against the generated arguments`
        )
      else if (isZeroish(value))
        problems.push(
          `${abiItem.name}: "${field.label}" (${field.path}) would render as ${value}`
        )
    }
  }
  return problems
}

/** The labels a format puts on screen, in the order the descriptor lists them. */
function displayedLabels(format: IDescriptorFormat): string[] {
  return (format.fields ?? [])
    .filter((field) => (field.visible ?? 'always') !== 'never')
    .map((field) => field.label)
}

/**
 * Fails when a format has no test case, or when its case asserts stale labels.
 *
 * The registry rejects a descriptor whose formats are not each exercised by a
 * case, and the sync builds the registry fixture from the repo's copy without
 * inventing expectations. So an uncovered format does not fail the PR that
 * introduces it — it fails the next sync, after merge, in a workflow nobody is
 * watching. This check moves that failure back to the PR.
 *
 * Coverage alone is not enough: a case is generated once and then never
 * revisited, so renaming a label in the descriptor leaves its case asserting a
 * label the descriptor no longer emits, and nothing re-renders it. Both sides
 * are in-repo at PR time, so the labels are compared here. Values are not —
 * only the reference renderer can produce those.
 */
function checkCoverage(
  formats: Record<string, IDescriptorFormat>,
  testsPath: string
): string[] {
  if (!fs.existsSync(testsPath))
    throw new Error(`--tests ${testsPath} does not exist`)

  const covered = new Map<string, ITestCase>()
  for (const test of readExistingTests(testsPath)) {
    const selector = selectorOf(test)
    if (selector) covered.set(selector, test)
  }

  const problems: string[] = []
  for (const [formatKey, format] of Object.entries(formats)) {
    const selector = toFunctionSelector(`function ${formatKey}`).toLowerCase()
    const test = covered.get(selector)
    if (!test) {
      problems.push(`${formatKey} (${selector}) has no test case`)
      continue
    }

    // A PENDING case has no rendered labels yet, so there is nothing to drift.
    if (test.expected.intent === PENDING_INTENT) continue

    const displayed = displayedLabels(format)
    const asserted = (test.expected.fields ?? []).map((field) => field.label)
    if (JSON.stringify(displayed) !== JSON.stringify(asserted))
      problems.push(
        `${formatKey} (${selector}): fixture asserts [${asserted.join(
          ', '
        )}], descriptor displays [${displayed.join(
          ', '
        )}] — re-render this case`
      )
  }

  return problems
}

function readFormats(sourcePath: string): Record<string, IDescriptorFormat> {
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'))

  return source?.display?.formats ?? source?.formats ?? {}
}

const main = defineCommand({
  meta: {
    name: 'generateClearSigningTests',
    description:
      'Generate the ERC-7730 testsv2 fixture for the LI.FI Diamond descriptor — one case per display.formats entry.',
  },
  args: {
    descriptor: {
      type: 'string',
      description: 'Path to calldata-LIFIDiamond.json',
      required: true,
    },
    out: {
      type: 'string',
      description: 'Path to the .tests.json to write (not needed with --check)',
    },
    check: {
      type: 'boolean',
      description:
        'Verify every displayed field would render a real value, write nothing, exit non-zero on a finding',
      default: false,
    },
    // No `default` on either: citty gives a multi-word argument a camelCase and
    // a kebab-case key, and a default fills both, so one spelling stops
    // registering. Defaults are applied in run() instead.
    allowPending: {
      type: 'boolean',
      description:
        'Write the fixture even when expectations are still PENDING — the first pass of the render loop',
    },
    chainId: {
      type: 'string',
      description: 'Chain to build the fixtures for (default: 1)',
    },
    results: {
      type: 'string',
      description:
        'Optional results.json from the reference runner; fills in every expected block',
    },
    existing: {
      type: 'string',
      description:
        'Optional fixture whose test cases are kept as-is; only uncovered selectors are generated',
    },
    tests: {
      type: 'string',
      description:
        'With --check: also verify this fixture has a test case for every format',
    },
  },
  run({ args }) {
    if (args.check) {
      const formats = readFormats(args.descriptor)
      const fieldProblems = checkVisibleFields(formats)
      const coverageProblems = args.tests
        ? checkCoverage(formats, args.tests)
        : []

      for (const problem of [...fieldProblems, ...coverageProblems])
        console.error(`  ✗ ${problem}`)

      if (fieldProblems.length)
        console.error(
          `\n${fieldProblems.length} displayed field(s) would render nothing a test can ` +
            'assert. In tasks/generateClearSigningTests.ts: add a struct component to ' +
            'DISPLAYED_COMPONENT_VALUES, a parameter to the templates, an envelope field to ' +
            'buildRawTx(), or — for a path that does not resolve — teach resolvePath() ' +
            'the shape it walks.'
        )

      if (coverageProblems.length)
        console.error(
          `\n${coverageProblems.length} format(s) are not correctly exercised by ` +
            `${args.tests} — each either has no reviewed test case or has one asserting ` +
            'labels the descriptor no longer emits. The registry rejects a descriptor whose ' +
            'formats are not each exercised, and the sync will not invent or re-render an ' +
            'expectation — so left unfixed this fails the next sync after merge, not this ' +
            'PR. Remedy: run the render loop in docs/ClearSigningProposal.md ' +
            '("Test fixtures") and commit the result.'
        )

      if (fieldProblems.length || coverageProblems.length) process.exit(1)

      console.info('✓ every displayed field renders a real value')
      if (args.tests)
        console.info(
          `✓ every format has a test case in ${args.tests}, asserting current labels`
        )
      return
    }

    if (!args.out) throw new Error('--out is required unless --check is set')

    const chainId = Number(args.chainId ?? 1)
    const fixture = buildFixture(args.descriptor, chainId, args.existing)

    let applied = 0
    if (args.results) applied = applyResults(fixture, args.results)

    // A PENDING block means a format the reference runner has not rendered yet.
    // Writing it would publish a fixture that fails the registry's own runners,
    // so stop here and point at the loop that fills them in.
    const pending = fixture.tests.filter(
      (test) => test.expected?.intent === PENDING_INTENT
    )
    if (pending.length && !args.allowPending) {
      const shown = pending.slice(0, 5).map((test) => test.description)
      const names =
        shown.join(', ') + (pending.length > shown.length ? ', …' : '')
      throw new Error(
        `${pending.length} format(s) have no expectation yet: ${names}\n` +
          'Re-run with --allowPending, render the fixture with the reference runner\n' +
          '(sourcifyeth/clear-signing-test-runner), then re-run with --results <results.json>\n' +
          'and read what it produced before committing.'
      )
    }

    fs.writeFileSync(args.out, `${JSON.stringify(fixture, null, 2)}\n`)
    console.info(`Wrote ${fixture.tests.length} test case(s) to ${args.out}`)
    if (args.results)
      console.info(
        `Filled in ${applied} expected block(s) from ${args.results}`
      )
    else if (pending.length)
      console.info(
        `${pending.length} expectation(s) are PENDING — run the reference runner, then re-run with --results`
      )
  },
})

runMain(main)
