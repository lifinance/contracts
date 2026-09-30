/**
 * Finds the diamond-called periphery names whose on-chain registry entry
 * differs from the address the whitelist file lists, so the whitelist sync
 * (script/tasks/diamondSyncWhitelist.sh) leaves their pairs to the paired
 * registration batch instead of de-whitelisting a still-registered address.
 */
import { readFileSync } from 'fs'

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'

import 'dotenv/config'

import globalConfig from '../../config/global.json'
import { isNetworkInScope } from '../common/whitelistScope'
import { isEntrypoint } from '../utils/is-entrypoint'
import { redactUrls } from '../utils/redactUrls'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

import {
  EXIT_REFUSED,
  requiredSelectorsFor,
  type IPeripheryRouteConfig,
} from './proposePeripheryWithWhitelist'

const REGISTRY_ABI = parseAbi([
  'function getPeripheryContract(string) view returns (address)',
])

const EVM_ZERO = '0x0000000000000000000000000000000000000000'

/** One `PERIPHERY[network]` entry of a whitelist file. */
export interface IPeripheryConfigEntry {
  name: string
  address?: string
}

/** A name whose registry entry and whitelist-file address differ. */
export interface IRegistryDrift {
  name: string
  /** Registered now; undefined when nothing is. */
  registry?: string
  /** Listed in the whitelist file; undefined when it lists none. */
  config?: string
  /** The name's configured selectors, normalised. */
  selectors: Hex[]
}

/** A registry that could not be read; the sync must not run on that network. */
export class RegistryReadRefusal extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'RegistryReadRefusal'
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Compares every in-scope `whitelistPeripheryFunctions` name's registry entry
 * with the address the whitelist file lists for it.
 *
 * @param input.network - Network name; a Tron network compares base58 exactly.
 * @param input.entries - `PERIPHERY[network]` of the whitelist file the sync reads.
 * @param input.routeConfig - `config/global.json`.
 * @param input.readRegistered - `getPeripheryContract(name)`, undefined for none.
 * @returns One entry per name that differs, in config order.
 * @throws {RegistryReadRefusal} When any read fails: an unread name could be the one in flight.
 */
export async function findRegistryDrift(input: {
  network: string
  entries: readonly IPeripheryConfigEntry[]
  routeConfig: IPeripheryRouteConfig
  readRegistered: (name: string) => Promise<string | undefined>
}): Promise<IRegistryDrift[]> {
  const { network, entries, routeConfig, readRegistered } = input
  const tron = isTronNetworkKey(network)
  const same = (a: string, b: string) =>
    tron ? a === b : a.toLowerCase() === b.toLowerCase()
  const names = Object.keys(
    routeConfig.whitelistPeripheryFunctions ?? {}
  ).filter((name) =>
    isNetworkInScope(name, network, routeConfig.whitelistPeripheryNetworks)
  )

  const drift: IRegistryDrift[] = []
  for (const name of names) {
    let registry: string | undefined
    try {
      registry = await readRegistered(name)
    } catch (error) {
      throw new RegistryReadRefusal(
        `[${network}] could not read getPeripheryContract(${name}): ${redactUrls(
          errorText(error)
        )}`
      )
    }
    const config = entries.find((entry) => entry.name === name)?.address
    if (registry === undefined && config === undefined) continue
    if (
      registry !== undefined &&
      config !== undefined &&
      same(registry, config)
    )
      continue
    drift.push({
      name,
      registry,
      config,
      selectors: requiredSelectorsFor(name, routeConfig),
    })
  }
  return drift
}

/**
 * The pairs the sync must leave out: both addresses of every drifted name,
 * with that name's selectors.
 *
 * @param drift - From {@link findRegistryDrift}.
 * @returns `address|selector` keys, lowercased as the sync compares them.
 */
export function driftPairKeys(drift: readonly IRegistryDrift[]): Set<string> {
  const keys = new Set<string>()
  for (const d of drift)
    for (const address of [d.registry, d.config])
      if (address)
        for (const selector of d.selectors)
          keys.add(`${address.toLowerCase()}|${selector}`)
  return keys
}

/**
 * The line the sync prints for a drifted name.
 *
 * @param d - One drifted name.
 * @returns The message.
 */
export function describeDrift(d: IRegistryDrift): string {
  return `${d.name}: registry points at ${d.registry ?? 'none'}, config at ${
    d.config ?? 'none'
  } — left to the paired registration batch`
}

async function registryReader(
  network: string,
  diamond: string
): Promise<(name: string) => Promise<string | undefined>> {
  if (isTronNetworkKey(network)) {
    const { initTronWeb } = await import('../troncast/utils/tronweb')
    const tronWeb = initTronWeb(network === 'tron' ? 'mainnet' : 'testnet')
    const registry = tronWeb.contract(
      [
        {
          name: 'getPeripheryContract',
          type: 'function',
          inputs: [{ name: '_name', type: 'string' }],
          outputs: [{ name: '', type: 'address' }],
          stateMutability: 'view',
        },
      ],
      diamond
    )
    const zero = tronWeb.address.fromHex(`41${'0'.repeat(40)}`)
    return async (name) => {
      const raw: unknown = await registry.getPeripheryContract(name).call()
      if (typeof raw !== 'string')
        throw new Error(
          `unexpected getPeripheryContract result: ${String(raw)}`
        )
      const base58 = raw.startsWith('T') ? raw : tronWeb.address.fromHex(raw)
      return base58 === zero ? undefined : base58
    }
  }
  const client = createPublicClient({
    chain: getViemChainForNetworkName(network),
    transport: http(),
  })
  return async (name) => {
    const at: Address = await client.readContract({
      address: getAddress(diamond),
      abi: REGISTRY_ABI,
      functionName: 'getPeripheryContract',
      args: [name],
    })
    return at.toLowerCase() === EVM_ZERO ? undefined : getAddress(at)
  }
}

const main = defineCommand({
  meta: {
    name: 'whitelistRegistryDrift',
    description:
      'Print the diamond-called periphery pairs a whitelist sync must leave out because the registry and the whitelist file disagree',
  },
  args: {
    network: { type: 'string', required: true, description: 'Network name' },
    diamond: {
      type: 'string',
      required: true,
      description: 'Diamond holding the registry',
    },
    whitelist: {
      type: 'string',
      required: true,
      description: 'Whitelist file the sync reads',
    },
  },
  async run({ args }) {
    try {
      const file = JSON.parse(readFileSync(args.whitelist, 'utf8')) as {
        PERIPHERY?: Record<string, IPeripheryConfigEntry[]>
      }
      const drift = await findRegistryDrift({
        network: args.network,
        entries: file.PERIPHERY?.[args.network] ?? [],
        routeConfig: globalConfig as unknown as IPeripheryRouteConfig,
        readRegistered: await registryReader(args.network, args.diamond),
      })
      for (const d of drift)
        consola.warn(`[${args.network}] ${describeDrift(d)}`)
      for (const key of driftPairKeys(drift))
        process.stdout.write(`EXCLUDE ${key}\n`)
    } catch (error) {
      const reason = redactUrls(errorText(error))
      consola.error(
        `${
          error instanceof RegistryReadRefusal ? '' : `[${args.network}] `
        }${reason} — refusing the whitelist sync on this network`
      )
      process.exit(EXIT_REFUSED)
    }
  },
})

if (isEntrypoint(import.meta.url)) runMain(main)
