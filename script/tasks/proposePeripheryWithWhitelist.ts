// Proposes a diamond-called periphery contract's registration together with its
// whitelist sync as ONE timelock scheduleBatch per network.
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
  type Address,
  type Hex,
} from 'viem'

import 'dotenv/config'

import globalConfig from '../../config/global.json'
import networksConfig from '../../config/networks.json'
import whitelistConfig from '../../config/whitelist.json'
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

// A contract with no listed functions is whitelisted as approveTo-only under this
// sentinel selector (LibAllowList.sol); omitting it reads the contract as absent
// from config and would propose removing a live approveTo target.
export const APPROVE_TO_ONLY = '0xffffffff'

const WHITELIST_ABI = parseAbi([
  'function getAllContractSelectorPairs() view returns (address[],bytes4[][])',
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

const REGISTRY_ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
])

export interface IPair {
  contract: Address
  selector: Hex
}

export interface IWhitelistConfig {
  DEXS?: {
    contracts?: Record<
      string,
      { address: string; functions?: Record<string, string> }[]
    >
  }[]
  PERIPHERY?: Record<
    string,
    { address: string; selectors?: { selector: string }[] }[]
  >
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

/** One registration a paired batch carries. */
export interface IPairedRegistration {
  name: string
  address: Address
  /** Selectors `whitelistPeripheryFunctions` requires for `name`, lowercased. */
  required: readonly Hex[]
}

/** Exit code of `--preflight` for a registration that is not paired. */
export const PREFLIGHT_EXIT_NOT_PAIRED = 3

const hasOwn = (object: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(object, key)

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
 * The selectors a diamond-called contract must hold on the allowlist.
 *
 * @param name - A name `whitelistPeripheryFunctions` lists.
 * @param config - `config/global.json`, or the key of it this reads.
 * @returns The configured selectors, lowercased.
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
  return entries.map((entry) => entry.selector.toLowerCase() as Hex)
}

export const pairKey = (p: IPair): string =>
  `${p.contract.toLowerCase()}|${p.selector.toLowerCase()}`

/**
 * Collects every (contract, selector) pair the config says should be whitelisted
 * on a network, across both the DEXS and PERIPHERY sections.
 */
export function desiredPairs(
  config: IWhitelistConfig,
  network: string,
  normalize: (raw: string) => Address = getAddress
): IPair[] {
  const out: IPair[] = []

  for (const dex of config.DEXS ?? [])
    for (const entry of dex.contracts?.[network] ?? []) {
      const selectors = Object.keys(entry.functions ?? {})
      for (const selector of selectors.length ? selectors : [APPROVE_TO_ONLY])
        out.push({
          contract: normalize(entry.address),
          selector: selector as Hex,
        })
    }

  for (const entry of config.PERIPHERY?.[network] ?? []) {
    const selectors = (entry.selectors ?? []).map((s) => s.selector)
    for (const selector of selectors.length ? selectors : [APPROVE_TO_ONLY])
      out.push({
        contract: normalize(entry.address),
        selector: selector as Hex,
      })
  }

  return out
}

/**
 * Splits the config-vs-chain difference into the pairs to whitelist and the pairs
 * to de-whitelist. Keys are compared case-insensitively so a checksum-vs-lowercase
 * address never reads as both an addition and a removal.
 */
export function diffPairs(
  desired: IPair[],
  actual: IPair[]
): { toAdd: IPair[]; toRemove: IPair[] } {
  const desiredKeys = new Set(desired.map(pairKey))
  const actualKeys = new Set(actual.map(pairKey))
  return {
    toAdd: desired.filter((p) => !actualKeys.has(pairKey(p))),
    toRemove: actual.filter((p) => !desiredKeys.has(pairKey(p))),
  }
}

async function actualPairs(
  diamond: Address,
  network: string
): Promise<IPair[]> {
  const client = createPublicClient({
    chain: getViemChainForNetworkName(network),
    transport: http(),
  })
  const [contracts, selectors] = await client.readContract({
    address: diamond,
    abi: WHITELIST_ABI,
    functionName: 'getAllContractSelectorPairs',
  })

  const out: IPair[] = []
  contracts.forEach((contract, i) =>
    (selectors[i] ?? []).forEach((selector) =>
      out.push({ contract: getAddress(contract), selector })
    )
  )
  return out
}

/**
 * Fails when the address about to be registered is not the one the config wants
 * whitelisted — the signature of a `config/whitelist.json` that predates the
 * deploy.
 */
export function assertRegisteredAddressIsDesired(
  desired: IPair[],
  registered: Address,
  network: string
): void {
  const target = registered.toLowerCase()
  if (desired.some((p) => p.contract.toLowerCase() === target)) return
  const listed = [
    ...new Set(
      desired
        .filter((p) => p.contract.toLowerCase() !== target)
        .map((p) => p.contract)
    ),
  ]
  throw new Error(
    `config/whitelist.json does not list ${registered} for ${network} (it lists ${listed.length} other address(es)) — update config/whitelist.json first (regenerate it with updateWhitelistPeriphery.ts); nothing was proposed`
  )
}

/**
 * Fails unless `config/whitelist.json` lists every registration's address with
 * every selector `whitelistPeripheryFunctions` requires of it. Run before
 * anything is proposed: a batch built from a stale file would register the new
 * address and de-whitelist it in the same operation.
 *
 * @param desired - From {@link desiredPairs} for `network`.
 * @param registrations - What the batch registers.
 * @param network - Network name, for the message.
 * @throws Naming the first registration the file does not cover.
 */
export function assertWhitelistListsRegistrations(
  desired: IPair[],
  registrations: readonly IPairedRegistration[],
  network: string
): void {
  const listed = new Set(desired.map(pairKey))
  for (const registration of registrations) {
    assertRegisteredAddressIsDesired(desired, registration.address, network)
    const absent = registration.required.filter(
      (selector) =>
        !listed.has(pairKey({ contract: registration.address, selector }))
    )
    if (absent.length)
      throw new Error(
        `config/whitelist.json lists ${registration.name} ${
          registration.address
        } for ${network} without ${absent.join(
          ', '
        )}, which whitelistPeripheryFunctions requires — update config/whitelist.json first; nothing was proposed`
      )
  }
}

/** The inner calls of one paired scheduleBatch, and the pairs they write. */
export interface IPairedRegistrationBatch {
  targets: Address[]
  calldatas: Hex[]
  toAdd: IPair[]
  toRemove: IPair[]
  /** Lowercased addresses whose additions were dropped for having no code. */
  skippedCodeless: string[]
}

/**
 * Builds the inner calls of one timelock scheduleBatch: every registration,
 * then the whitelist removals, then the additions, all sent to the diamond.
 *
 * @param input.network - Network name, for messages.
 * @param input.diamond - The diamond both the registry and the allowlist live on.
 * @param input.registrations - What to register; at least one.
 * @param input.desired - From {@link desiredPairs} for the network.
 * @param input.actual - The diamond's current pairs.
 * @param input.codeless - Lowercased addresses with no code on the chain.
 * @returns The batch.
 * @throws When the whitelist file does not cover a registration, a registered
 * address has no code, a registration would still lack a selector once the
 * batch ran, or the batch exceeds the combined-proposal cap.
 */
export function buildPairedRegistrationBatch(input: {
  network: string
  diamond: Address
  registrations: readonly IPairedRegistration[]
  desired: IPair[]
  actual: IPair[]
  codeless: ReadonlySet<string>
}): IPairedRegistrationBatch {
  const { network, diamond, registrations, desired, actual, codeless } = input
  if (!registrations.length)
    throw new Error(`[${network}] no registration to pair`)
  assertWhitelistListsRegistrations(desired, registrations, network)

  for (const registration of registrations)
    if (codeless.has(registration.address.toLowerCase()))
      throw new Error(
        `[${network}] ${registration.name} ${registration.address} has no code on the chain; nothing was proposed`
      )

  const diff = diffPairs(desired, actual)
  const skippedCodeless = [
    ...new Set(
      diff.toAdd
        .map((p) => p.contract.toLowerCase())
        .filter((address) => codeless.has(address))
    ),
  ]
  const toAdd = diff.toAdd.filter(
    (p) => !codeless.has(p.contract.toLowerCase())
  )
  const toRemove = diff.toRemove

  const total = toAdd.length + toRemove.length
  if (total > COMBINED_PROPOSAL_MAX_PAIRS)
    throw new Error(
      `[${network}] ${total} pairs exceeds the combined-proposal cap (${COMBINED_PROPOSAL_MAX_PAIRS}); run the standalone whitelist sync for this network first, then re-run; nothing was proposed`
    )

  const after = new Set(actual.map(pairKey))
  for (const p of toRemove) after.delete(pairKey(p))
  for (const p of toAdd) after.add(pairKey(p))
  for (const registration of registrations) {
    const missing = registration.required.filter(
      (selector) =>
        !after.has(pairKey({ contract: registration.address, selector }))
    )
    if (missing.length)
      throw new Error(
        `[${network}] ${registration.name} ${
          registration.address
        } would still lack ${missing.join(
          ', '
        )} after the batch; nothing was proposed`
      )
  }

  const targets: Address[] = []
  const calldatas: Hex[] = []
  for (const registration of registrations) {
    targets.push(diamond)
    calldatas.push(
      encodeFunctionData({
        abi: REGISTRY_ABI,
        functionName: 'registerPeripheryContract',
        args: [registration.name, registration.address],
      })
    )
  }
  // Removals precede additions so a re-pointed address never sits whitelisted
  // twice inside the same batch.
  for (const chunk of chunkPairs(toRemove)) {
    targets.push(diamond)
    calldatas.push(whitelistCalldata(chunk, false))
  }
  for (const chunk of chunkPairs(toAdd)) {
    targets.push(diamond)
    calldatas.push(whitelistCalldata(chunk, true))
  }

  return { targets, calldatas, toAdd, toRemove, skippedCodeless }
}

/**
 * Lowercased addresses among `pairs` that have no code on the chain. Whitelisting
 * one reverts (`LibAllowList.addAllowedContractSelector` → `InvalidContract`), and
 * because the batch is atomic that revert takes the registration down with it.
 */
async function codelessAddresses(
  pairs: IPair[],
  network: string
): Promise<Set<string>> {
  const client = createPublicClient({
    chain: getViemChainForNetworkName(network),
    transport: http(),
  })
  const unique = [...new Set(pairs.map((p) => p.contract))]
  const codeless = new Set<string>()
  for (const address of unique) {
    if (address === ZERO_ADDRESS) {
      codeless.add(address.toLowerCase())
      continue
    }
    const code = await client.getBytecode({ address })
    if (!code || code === '0x') codeless.add(address.toLowerCase())
  }
  return codeless
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

const splitList = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

const main = defineCommand({
  meta: {
    name: 'proposePeripheryWithWhitelist',
    description:
      'Propose periphery registration + whitelist sync as one timelock batch per network',
  },
  args: {
    contract: {
      type: 'string',
      required: true,
      description:
        'Comma-separated registry names, all registered in one batch',
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
      description: `Read config only and exit 0 when the registration is paired and whitelist.json covers it, ${PREFLIGHT_EXIT_NOT_PAIRED} when it is not paired, 1 when it must be refused. Needs exactly one network.`,
    },
    dryRun: {
      type: 'boolean',
      description: 'Build and report the batch without proposing',
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

    let failures = 0
    for (const network of networks) {
      try {
        const unpaired = names
          .map((name) => ({
            name,
            route: peripheryRegistrationRoute(name, network, routeConfig),
          }))
          .filter(({ route }) => route !== 'paired')
        if (unpaired.length) {
          const reason = unpaired
            .map(({ name, route }) => `${name} (${route})`)
            .join(', ')
          if (preflight && unpaired.length === names.length) {
            consola.info(`[${network}] not paired: ${reason}`)
            process.exit(PREFLIGHT_EXIT_NOT_PAIRED)
          }
          throw new Error(
            `${reason} must not be paired on ${network} — use the normal propose path`
          )
        }

        const netConfig = (
          networksConfig as Record<string, { rpcUrl?: string }>
        )[network]
        if (!netConfig) throw new Error('not present in networks.json')

        const deployments = (await import(
          `../../deployments/${network}.json`
        )) as { default: Record<string, string> }
        const diamond = getAddress(
          args.diamond ?? deployments.default['LiFiDiamond'] ?? ''
        )
        const registrations: IPairedRegistration[] = names.map((name, i) => ({
          name,
          address: getAddress(addresses[i] ?? deployments.default[name] ?? ''),
          required: requiredSelectorsFor(name, routeConfig),
        }))

        const desired = desiredPairs(
          whitelistConfig as unknown as IWhitelistConfig,
          network
        )
        // The standalone sync regenerates config/whitelist.json from the deploy
        // logs before diffing; this script reads the committed file, so a stale
        // one would de-whitelist the address being registered and whitelist the
        // one it replaces — leaving the diamond unable to call it at all.
        assertWhitelistListsRegistrations(desired, registrations, network)
        if (preflight) {
          consola.success(
            `[${network}] ${names.join(
              ', '
            )}: paired, config/whitelist.json covers it`
          )
          continue
        }

        const actual = await actualPairs(diamond, network)
        const diff = diffPairs(desired, actual)
        const batch = buildPairedRegistrationBatch({
          network,
          diamond,
          registrations,
          desired,
          actual,
          codeless: await codelessAddresses(
            [
              ...diff.toAdd,
              ...registrations.map((r) => ({
                contract: r.address,
                selector: APPROVE_TO_ONLY as Hex,
              })),
            ],
            network
          ),
        })
        if (batch.skippedCodeless.length)
          consola.warn(
            `[${network}] skipping ${
              batch.skippedCodeless.length
            } whitelist target(s) with no on-chain code: ${batch.skippedCodeless.join(
              ', '
            )} — fix config/whitelist.json`
          )

        consola.info(
          `[${network}] ${registrations
            .map((r) => `${r.name}=${r.address}`)
            .join(', ')} | batch calls=${batch.calldatas.length} (remove=${
            batch.toRemove.length
          }, add=${batch.toAdd.length})`
        )
        // The signer sees only calldata, so name every pair the batch touches.
        for (const p of batch.toRemove)
          consola.info(`[${network}]   - ${p.contract} ${p.selector}`)
        for (const p of batch.toAdd)
          consola.info(`[${network}]   + ${p.contract} ${p.selector}`)

        if (flagIsOn(args.dryRun)) {
          consola.success(`[${network}] dry-run: no proposal created`)
          continue
        }

        // propose-to-safe.ts calls runMain() at module scope, so importing
        // runPropose hijacks this CLI's argv; drive its CLI instead. Neither the
        // signing key nor the RPC URL is passed as an argument — both would be
        // readable from the process table, and it resolves both from the env.
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
        if (result.status !== 0)
          throw new Error(`propose-to-safe exited ${String(result.status)}`)
        consola.success(`[${network}] proposed`)
      } catch (error) {
        failures++
        consola.error(
          `[${network}] ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }

    if (failures) {
      consola.error(`${failures}/${networks.length} network(s) failed`)
      process.exit(1)
    }
  },
})

if (isEntrypoint(import.meta.url)) runMain(main)
