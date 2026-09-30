// Proposes a diamond-called periphery contract's registration together with the
// allowlist writes for that contract alone, as ONE timelock scheduleBatch per
// registration.
import { spawnSync } from 'child_process'

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  parseAbi,
  toHex,
  type Address,
  type Hex,
} from 'viem'

import 'dotenv/config'

import globalConfig from '../../config/global.json'
import {
  assertScopeContractsEligible,
  isNetworkInScope,
  type WhitelistNetworkScope,
} from '../common/whitelistScope'
import { flagIsOn } from '../deploy/safe/cli-flags'
import { isEntrypoint } from '../utils/is-entrypoint'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

// executeBatch runs every inner call in one transaction, so an oversized batch
// can exceed a chain's block gas limit and become scheduled-but-unexecutable —
// which would atomically block the registration it rides with.
const COMBINED_PROPOSAL_MAX_PAIRS = 300

// Per-call ceiling the standalone sync (script/tasks/diamondSyncWhitelist.sh) has
// always used; a single call much larger than this risks the same gas limit.
const WHITELIST_CALL_MAX_PAIRS = 150

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address

const WHITELIST_ABI = parseAbi([
  'function getWhitelistedSelectorsForContract(address) view returns (bytes4[])',
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

const REGISTRY_ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
  'function getPeripheryContract(string) view returns (address)',
])

export interface IPair {
  contract: Address
  selector: Hex
}

/** The two `config/global.json` keys that decide whether a registration is paired. */
export interface IPeripheryRouteConfig {
  whitelistPeripheryFunctions?: Record<
    string,
    { selector: string; signature?: string }[]
  >
  whitelistPeripheryNetworks?: WhitelistNetworkScope
}

/**
 * - `paired`: the diamond calls this contract here, so its registration must
 *   travel with the whitelist writes.
 * - `not-diamond-called`: absent from `whitelistPeripheryFunctions`.
 * - `out-of-scope`: `whitelistPeripheryNetworks` does not list this network.
 */
export type PeripheryRegistrationRoute =
  | 'paired'
  | 'not-diamond-called'
  | 'out-of-scope'

/** A contract about to be registered under a name. */
export interface IRegistration {
  name: string
  address: Address
}

/** Exit code of `--preflight` for a registration that is not paired. */
export const PREFLIGHT_EXIT_NOT_PAIRED = 3

/**
 * Exit code for a refusal that re-running cannot change: a codeless address,
 * chain state that could not be read, a batch above the cap. Callers must not
 * retry it.
 */
export const EXIT_REFUSED = 4

/** A deterministic refusal; nothing was proposed for the network. */
export class PairedRegistrationRefusal extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'PairedRegistrationRefusal'
  }
}

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key)

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const sameAddress = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase()

/**
 * Decides whether a registration of `name` on `network` must be proposed
 * together with the whitelist writes.
 *
 * @param name - Registry name, as passed to `registerPeripheryContract`.
 * @param network - Network name as `config/networks.json` spells it.
 * @param config - `config/global.json`, or the two keys of it this reads.
 * @returns The route the registration takes.
 * @throws When `whitelistPeripheryNetworks` names a contract that has no functions.
 */
export function peripheryRegistrationRoute(
  name: string,
  network: string,
  config: IPeripheryRouteConfig
): PeripheryRegistrationRoute {
  const functions = config.whitelistPeripheryFunctions ?? {}
  const scope = config.whitelistPeripheryNetworks ?? {}
  assertScopeContractsEligible(scope, Object.keys(functions))
  if (!hasOwn(functions, name)) return 'not-diamond-called'
  if (!isNetworkInScope(name, network, scope)) return 'out-of-scope'
  return 'paired'
}

/**
 * The selectors a diamond-called contract must hold on the allowlist — the set
 * gate W grades a registration against.
 *
 * @param name - A name `whitelistPeripheryFunctions` lists.
 * @param config - `config/global.json`, or the key of it this reads.
 * @returns The configured selectors, lowercased and de-duplicated.
 * @throws When the name is absent or lists no selector, since nothing could then be required of it.
 */
export function requiredSelectorsFor(
  name: string,
  config: IPeripheryRouteConfig
): Hex[] {
  const functions = config.whitelistPeripheryFunctions ?? {}
  const entries = hasOwn(functions, name) ? functions[name] ?? [] : []
  if (!entries.length)
    throw new Error(
      `whitelistPeripheryFunctions.${name} lists no selector, so its registration cannot be paired`
    )
  return [...new Set(entries.map((entry) => normaliseSelector(entry.selector)))]
}

export const pairKey = (p: IPair): string =>
  `${p.contract.toLowerCase()}|${p.selector.toLowerCase()}`

/**
 * A bytes4 as viem or TronWeb returns it, as 0x-prefixed lowercase hex.
 *
 * @param value - A hex string with or without `0x`, in any case, or four bytes.
 * @returns The selector.
 * @throws When the value is not four bytes.
 */
export function normaliseSelector(value: unknown): Hex {
  let text: string | undefined
  if (typeof value === 'string') text = value
  else if (value instanceof Uint8Array) text = toHex(value)
  else if (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
    text = toHex(Uint8Array.from(value as number[]))
  const hex = text?.replace(/^0x/iu, '').toLowerCase()
  if (hex === undefined || !/^[0-9a-f]{8}$/u.test(hex))
    throw new Error(`not a four-byte selector: ${String(value)}`)
  return `0x${hex}`
}

/** What the chain holds for one registration before its batch runs. */
export interface IRegistrationChainState {
  /** The address registered under the name now; undefined when none is. */
  current?: Address
  /** Every selector the diamond allowlists for `current`, normalised. */
  currentSelectors: readonly Hex[]
  /** Other diamond-called names registered at `current`. */
  currentAlsoRegisteredAs: readonly string[]
  /** Whether the address being registered has code. */
  hasCode: boolean
}

/** The chain reads a paired batch is built from. */
export interface IPairedRegistrationReader {
  /** `getPeripheryContract(name)`; undefined for the zero address. */
  getPeripheryContract: (name: string) => Promise<Address | undefined>
  /** `getWhitelistedSelectorsForContract(contract)`. */
  getWhitelistedSelectors: (contract: Address) => Promise<readonly Hex[]>
  hasCode: (address: Address) => Promise<boolean>
}

/**
 * Reads what {@link buildScopedPairedBatch} needs for one registration.
 *
 * The other diamond-called names are read only when the replaced address holds
 * one of the configured selectors, since only then could removing it matter.
 *
 * @param input.registration - What is being registered.
 * @param input.configured - From {@link requiredSelectorsFor}.
 * @param input.diamondCalledNames - Every `whitelistPeripheryFunctions` key.
 * @param input.reader - The chain reads.
 * @returns The chain state.
 * @throws Whatever a read throws.
 */
export async function readRegistrationState(input: {
  registration: IRegistration
  configured: readonly Hex[]
  diamondCalledNames: readonly string[]
  reader: IPairedRegistrationReader
}): Promise<IRegistrationChainState> {
  const { registration, configured, diamondCalledNames, reader } = input
  const hasCode = await reader.hasCode(registration.address)
  const current = await reader.getPeripheryContract(registration.name)
  if (!current || sameAddress(current, registration.address))
    return {
      current,
      currentSelectors: [],
      currentAlsoRegisteredAs: [],
      hasCode,
    }

  const currentSelectors = (await reader.getWhitelistedSelectors(current)).map(
    normaliseSelector
  )
  const touched = configured.some((selector) =>
    currentSelectors.includes(selector)
  )
  const currentAlsoRegisteredAs: string[] = []
  if (touched)
    for (const other of diamondCalledNames) {
      if (other === registration.name) continue
      const at = await reader.getPeripheryContract(other)
      if (at && sameAddress(at, current)) currentAlsoRegisteredAs.push(other)
    }
  return { current, currentSelectors, currentAlsoRegisteredAs, hasCode }
}

/** The inner calls of one paired scheduleBatch, and the pairs they write. */
export interface IScopedPairedBatch {
  name: string
  address: Address
  /** The address the registration replaces, when one is registered. */
  replaced?: Address
  targets: Address[]
  calldatas: Hex[]
  toRemove: IPair[]
  toAdd: IPair[]
  /** Why `replaced` keeps its selectors, when it does. */
  replacedKept?: string
}

/**
 * Builds the inner calls of one timelock scheduleBatch for one registration:
 * the registration, the de-whitelisting of the replaced address's configured
 * selectors, then the whitelisting of the new address's — nothing else.
 *
 * @param input.network - Network name, for messages.
 * @param input.diamond - The diamond both the registry and the allowlist live on.
 * @param input.registration - What to register.
 * @param input.configured - From {@link requiredSelectorsFor}.
 * @param input.state - From {@link readRegistrationState}.
 * @returns The batch.
 * @throws {PairedRegistrationRefusal} For a zero or codeless address, or a
 * batch above the combined-proposal cap.
 */
export function buildScopedPairedBatch(input: {
  network: string
  diamond: Address
  registration: IRegistration
  configured: readonly Hex[]
  state: IRegistrationChainState
}): IScopedPairedBatch {
  const { network, diamond, registration, configured, state } = input
  const { name, address } = registration
  if (sameAddress(address, ZERO_ADDRESS))
    throw new PairedRegistrationRefusal(
      `[${network}] ${name} would be registered at the zero address`
    )
  if (!state.hasCode)
    throw new PairedRegistrationRefusal(
      `[${network}] ${name} ${address} has no code on the chain`
    )

  const replaced =
    state.current && !sameAddress(state.current, address)
      ? state.current
      : undefined
  let toRemove: IPair[] = []
  let replacedKept: string | undefined
  if (replaced && state.currentAlsoRegisteredAs.length)
    replacedKept = `${replaced} is still registered as ${state.currentAlsoRegisteredAs.join(
      ', '
    )}`
  else if (replaced) {
    const held = new Set(state.currentSelectors.map(normaliseSelector))
    toRemove = configured
      .filter((selector) => held.has(selector))
      .map((selector) => ({ contract: replaced, selector }))
  }
  const toAdd = configured.map((selector) => ({ contract: address, selector }))

  const total = toAdd.length + toRemove.length
  if (total > COMBINED_PROPOSAL_MAX_PAIRS)
    throw new PairedRegistrationRefusal(
      `[${network}] ${name}: ${total} pairs exceeds the combined-proposal cap (${COMBINED_PROPOSAL_MAX_PAIRS})`
    )

  const targets: Address[] = [diamond]
  const calldatas: Hex[] = [
    encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: 'registerPeripheryContract',
      args: [name, address],
    }),
  ]
  for (const chunk of chunkPairs(toRemove)) {
    targets.push(diamond)
    calldatas.push(whitelistCalldata(chunk, false))
  }
  for (const chunk of chunkPairs(toAdd)) {
    targets.push(diamond)
    calldatas.push(whitelistCalldata(chunk, true))
  }

  return {
    name,
    address,
    replaced,
    targets,
    calldatas,
    toRemove,
    toAdd,
    replacedKept,
  }
}

/** Every registration of one run on one network, checked and built. */
export interface IRegistrationPlan {
  paired: IScopedPairedBatch[]
  plain: IRegistration[]
}

/**
 * Routes every registration, reads its chain state and builds its batch, so
 * that every refusal is known before the caller proposes anything.
 *
 * @param input.network - Network name.
 * @param input.diamond - The diamond.
 * @param input.registrations - Everything the run would register here.
 * @param input.routeConfig - `config/global.json`.
 * @param input.pair - False where nothing is paired (staging); every
 * registration is then plain.
 * @param input.reader - The chain reads.
 * @returns One batch per paired registration, and the plain ones.
 * @throws {PairedRegistrationRefusal} Listing every registration that cannot be
 * proposed, when any cannot.
 */
export async function planRegistrations(input: {
  network: string
  diamond: Address
  registrations: readonly IRegistration[]
  routeConfig: IPeripheryRouteConfig
  pair: boolean
  reader: IPairedRegistrationReader
}): Promise<IRegistrationPlan> {
  const { network, diamond, registrations, routeConfig, pair, reader } = input
  const diamondCalledNames = Object.keys(
    routeConfig.whitelistPeripheryFunctions ?? {}
  )
  const plan: IRegistrationPlan = { paired: [], plain: [] }
  const refusals: string[] = []

  for (const registration of registrations)
    try {
      const route = pair
        ? peripheryRegistrationRoute(registration.name, network, routeConfig)
        : 'not-diamond-called'
      if (route !== 'paired') {
        let hasCode: boolean
        try {
          hasCode = await reader.hasCode(registration.address)
        } catch (error) {
          throw new PairedRegistrationRefusal(
            `[${network}] could not read the code of ${registration.name} ${
              registration.address
            }: ${errorText(error)}`
          )
        }
        if (!hasCode)
          throw new PairedRegistrationRefusal(
            `[${network}] ${registration.name} ${registration.address} has no code on the chain`
          )
        plan.plain.push(registration)
        continue
      }

      const configured = requiredSelectorsFor(registration.name, routeConfig)
      let state: IRegistrationChainState
      try {
        state = await readRegistrationState({
          registration,
          configured,
          diamondCalledNames,
          reader,
        })
      } catch (error) {
        throw new PairedRegistrationRefusal(
          `[${network}] could not read the chain state of ${
            registration.name
          } ${registration.address}: ${errorText(error)}`
        )
      }
      plan.paired.push(
        buildScopedPairedBatch({
          network,
          diamond,
          registration,
          configured,
          state,
        })
      )
    } catch (error) {
      refusals.push(errorText(error))
    }

  if (refusals.length)
    throw new PairedRegistrationRefusal(
      `[${network}] nothing was proposed:\n  ${refusals.join('\n  ')}`
    )
  return plan
}

/** One log line per pair the batch writes: the signer sees only calldata. */
export function describeBatch(batch: IScopedPairedBatch): string[] {
  const lines = [
    `${batch.name}=${batch.address}${
      batch.replaced ? ` (replaces ${batch.replaced})` : ''
    } | batch calls=${batch.calldatas.length} (remove=${
      batch.toRemove.length
    }, add=${batch.toAdd.length})`,
  ]
  if (batch.replacedKept)
    lines.push(`  keeps the selectors of ${batch.replacedKept}`)
  for (const p of batch.toRemove) lines.push(`  - ${p.contract} ${p.selector}`)
  for (const p of batch.toAdd) lines.push(`  + ${p.contract} ${p.selector}`)
  return lines
}

/** Splits pairs into per-call chunks of at most {@link WHITELIST_CALL_MAX_PAIRS}. */
export function chunkPairs(
  pairs: IPair[],
  size = WHITELIST_CALL_MAX_PAIRS
): IPair[][] {
  const out: IPair[][] = []
  for (let i = 0; i < pairs.length; i += size)
    out.push(pairs.slice(i, i + size))
  return out
}

/** batchSetContractSelectorWhitelist takes parallel arrays, so one pair per index. */
function whitelistCalldata(pairs: IPair[], approved: boolean): Hex {
  return encodeFunctionData({
    abi: WHITELIST_ABI,
    functionName: 'batchSetContractSelectorWhitelist',
    args: [
      pairs.map((p) => p.contract),
      pairs.map((p) => p.selector),
      approved,
    ],
  })
}

/**
 * The reads on an EVM diamond.
 *
 * @param diamond - The diamond.
 * @param network - Network name; its RPC comes from the environment.
 * @returns The reader.
 */
export function evmRegistrationReader(
  diamond: Address,
  network: string
): IPairedRegistrationReader {
  const client = createPublicClient({
    chain: getViemChainForNetworkName(network),
    transport: http(),
  })
  return {
    getPeripheryContract: async (name) => {
      const at = await client.readContract({
        address: diamond,
        abi: REGISTRY_ABI,
        functionName: 'getPeripheryContract',
        args: [name],
      })
      return sameAddress(at, ZERO_ADDRESS) ? undefined : getAddress(at)
    },
    getWhitelistedSelectors: async (contract) =>
      client.readContract({
        address: diamond,
        abi: WHITELIST_ABI,
        functionName: 'getWhitelistedSelectorsForContract',
        args: [contract],
      }),
    hasCode: async (address) => {
      const code = await client.getBytecode({ address })
      return Boolean(code && code !== '0x')
    },
  }
}

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const main = defineCommand({
  meta: {
    name: 'proposePeripheryWithWhitelist',
    description:
      'Propose each diamond-called periphery registration with its own allowlist writes as one timelock batch',
  },
  args: {
    contract: {
      type: 'string',
      required: true,
      description: 'Comma-separated registry names; each gets its own proposal',
    },
    networks: {
      type: 'string',
      required: true,
      description: 'Comma-separated network list',
    },
    address: {
      type: 'string',
      description:
        'Comma-separated addresses to register, parallel to --contract (default: the deploy log); needs exactly one network',
    },
    diamond: {
      type: 'string',
      description:
        'Diamond to register on (default: LiFiDiamond from the deploy log); needs exactly one network',
    },
    preflight: {
      type: 'boolean',
      description: `Read config and chain, propose nothing. Exit 0 when every name is paired and its batch builds, ${PREFLIGHT_EXIT_NOT_PAIRED} when none is paired and each address has code, ${EXIT_REFUSED} when a registration must be refused. Needs exactly one network.`,
    },
    dryRun: {
      type: 'boolean',
      description: 'Build and report the batches without proposing',
    },
  },
  async run({ args }) {
    const names = splitList(args.contract)
    const networks = splitList(args.networks)
    const addresses = splitList(args.address)
    if (!names.length) throw new Error('--contract resolved to an empty list')
    if (!networks.length)
      throw new Error('--networks resolved to an empty list')
    if (new Set(names).size !== names.length)
      throw new Error('--contract names a contract twice')
    if (addresses.length && addresses.length !== names.length)
      throw new Error(
        `--address lists ${addresses.length} address(es) for ${names.length} contract(s)`
      )
    const preflight = flagIsOn(args.preflight)
    if ((addresses.length || args.diamond || preflight) && networks.length > 1)
      throw new Error(
        '--address, --diamond and --preflight need exactly one network'
      )

    // Tron has no Foundry/viem diamond path here; its proposals go through
    // script/deploy/tron/deploy-and-register-periphery.ts instead.
    const tron = networks.filter((n) => isTronNetworkKey(n))
    if (tron.length)
      throw new Error(
        `${tron.join(
          ', '
        )} cannot be proposed through this script — use the Tron propose path`
      )

    const routeConfig = globalConfig as unknown as IPeripheryRouteConfig

    let failed = 0
    let refused = 0
    for (const network of networks)
      try {
        const unpaired = names
          .map((name) => ({
            name,
            route: peripheryRegistrationRoute(name, network, routeConfig),
          }))
          .filter(({ route }) => route !== 'paired')
        const reason = unpaired
          .map(({ name, route }) => `${name} (${route})`)
          .join(', ')
        // A preflight answers for one route; proposing takes paired names only.
        if (unpaired.length && (!preflight || unpaired.length < names.length))
          throw new PairedRegistrationRefusal(
            `${reason} must not be paired on ${network}`
          )

        const deployments: Record<string, string> =
          args.diamond && addresses.length
            ? {}
            : (
                (await import(`../../deployments/${network}.json`)) as {
                  default: Record<string, string>
                }
              ).default
        const diamond = getAddress(
          args.diamond ?? deployments['LiFiDiamond'] ?? ''
        )
        const registrations: IRegistration[] = names.map((name, i) => ({
          name,
          address: getAddress(addresses[i] ?? deployments[name] ?? ''),
        }))

        const plan = await planRegistrations({
          network,
          diamond,
          registrations,
          routeConfig,
          pair: true,
          reader: evmRegistrationReader(diamond, network),
        })

        if (preflight && !plan.paired.length) {
          consola.info(`[${network}] not paired: ${reason}`)
          process.exit(PREFLIGHT_EXIT_NOT_PAIRED)
        }
        for (const batch of plan.paired)
          for (const line of describeBatch(batch))
            consola.info(`[${network}] ${line}`)
        if (preflight || flagIsOn(args.dryRun)) {
          consola.success(`[${network}] no proposal created`)
          continue
        }

        // propose-to-safe.ts calls runMain() at module scope, so importing
        // runPropose hijacks this CLI's argv; drive its CLI instead. Neither the
        // signing key nor the RPC URL is passed as an argument — both would be
        // readable from the process table, and it resolves both from the env.
        for (const batch of plan.paired) {
          const proposeArgs = ['tsx', 'script/deploy/safe/propose-to-safe.ts', '--network', network, '--timelock'] // prettier-ignore
          batch.targets.forEach((target, i) =>
            proposeArgs.push(
              '--to',
              target,
              '--calldata',
              batch.calldatas[i] as string
            )
          )
          const result = spawnSync('bunx', proposeArgs, {
            stdio: 'inherit',
            env: process.env,
          })
          if (result.status !== 0) {
            failed++
            consola.error(
              `[${network}] ${batch.name}: propose-to-safe exited ${String(
                result.status
              )}`
            )
            continue
          }
          consola.success(`[${network}] ${batch.name} proposed`)
        }
      } catch (error) {
        if (error instanceof PairedRegistrationRefusal) refused++
        else failed++
        consola.error(`[${network}] ${errorText(error)}`)
      }

    if (failed) {
      consola.error(`${failed} proposal(s) or network(s) failed`)
      process.exit(1)
    }
    if (refused) {
      consola.error(`${refused}/${networks.length} network(s) refused`)
      process.exit(EXIT_REFUSED)
    }
  },
})

if (isEntrypoint(import.meta.url)) runMain(main)
