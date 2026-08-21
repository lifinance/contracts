// Proposes a diamond-called periphery contract's registration together with its
// whitelist sync as ONE timelock scheduleBatch per network.
import { spawnSync } from 'child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

export const pairKey = (p: IPair): string =>
  `${p.contract.toLowerCase()}|${p.selector.toLowerCase()}`

/**
 * Collects every (contract, selector) pair the config says should be whitelisted
 * on a network, across both the DEXS and PERIPHERY sections.
 */
export function desiredPairs(
  config: IWhitelistConfig,
  network: string
): IPair[] {
  const out: IPair[] = []

  for (const dex of config.DEXS ?? [])
    for (const entry of dex.contracts?.[network] ?? []) {
      const selectors = Object.keys(entry.functions ?? {})
      for (const selector of selectors.length ? selectors : [APPROVE_TO_ONLY])
        out.push({
          contract: getAddress(entry.address),
          selector: selector as Hex,
        })
    }

  for (const entry of config.PERIPHERY?.[network] ?? []) {
    const selectors = (entry.selectors ?? []).map((s) => s.selector)
    for (const selector of selectors.length ? selectors : [APPROVE_TO_ONLY])
      out.push({
        contract: getAddress(entry.address),
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
    `config/whitelist.json does not list ${registered} for ${network} (it lists ${listed.length} other address(es)) — regenerate it with updateWhitelistPeriphery.ts before proposing`
  )
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

const main = defineCommand({
  meta: {
    name: 'proposePeripheryWithWhitelist',
    description:
      'Propose periphery registration + whitelist sync as one timelock batch per network',
  },
  args: {
    contract: { type: 'string', required: true },
    networks: {
      type: 'string',
      required: true,
      description: 'Comma-separated network list',
    },
    dryRun: {
      type: 'boolean',
      default: false,
      description: 'Build and report the batch without proposing',
    },
  },
  async run({ args }) {
    const contractName = args.contract
    const networks = args.networks
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
    if (!networks.length)
      throw new Error('--networks resolved to an empty list')

    // Tron has no Foundry/viem diamond path here; its proposals go through
    // script/deploy/safe/propose-to-safe-tron.ts instead.
    const tron = networks.filter((n) => n.startsWith('tron'))
    if (tron.length)
      throw new Error(
        `${tron.join(
          ', '
        )} cannot be proposed through this script — use the Tron propose path`
      )

    if (
      !(globalConfig as Record<string, unknown>).whitelistPeripheryFunctions ||
      !(globalConfig.whitelistPeripheryFunctions as Record<string, unknown>)[
        contractName
      ]
    )
      throw new Error(
        `${contractName} is not a diamond-called periphery contract (absent from global.json whitelistPeripheryFunctions) — use the normal propose path`
      )

    let failures = 0
    for (const network of networks) {
      try {
        const netConfig = (
          networksConfig as Record<string, { rpcUrl?: string }>
        )[network]
        if (!netConfig) throw new Error('not present in networks.json')

        const deployments = (await import(
          `../../deployments/${network}.json`
        )) as { default: Record<string, string> }
        const diamond = getAddress(deployments.default['LiFiDiamond'] ?? '')
        const peripheryAddress = getAddress(
          deployments.default[contractName] ?? ''
        )

        const desired = desiredPairs(
          whitelistConfig as unknown as IWhitelistConfig,
          network
        )
        // The standalone sync regenerates config/whitelist.json from the deploy
        // logs before diffing; this script reads the committed file, so a stale
        // one would de-whitelist the address being registered and whitelist the
        // one it replaces — leaving the diamond unable to call it at all.
        assertRegisteredAddressIsDesired(desired, peripheryAddress, network)

        const diff = diffPairs(desired, await actualPairs(diamond, network))
        const toRemove = diff.toRemove
        // addAllowedContractSelector reverts with InvalidContract for a codeless
        // address, and that revert would take the registration down with it —
        // the whole scheduleBatch is atomic. Drop such pairs loudly instead.
        const codeless = await codelessAddresses(diff.toAdd, network)
        if (codeless.size)
          consola.warn(
            `[${network}] skipping ${
              codeless.size
            } whitelist target(s) with no on-chain code: ${[...codeless].join(
              ', '
            )} — fix config/whitelist.json`
          )
        const toAdd = diff.toAdd.filter(
          (p) => !codeless.has(p.contract.toLowerCase())
        )

        const total = toAdd.length + toRemove.length
        if (total > COMBINED_PROPOSAL_MAX_PAIRS) {
          consola.warn(
            `[${network}] ${total} pairs exceeds the combined-proposal cap (${COMBINED_PROPOSAL_MAX_PAIRS}) — skipping; run the standalone whitelist sync for this network`
          )
          failures++
          continue
        }

        // Removals precede additions so a re-pointed address never sits
        // whitelisted twice inside the same batch.
        const targets: string[] = [diamond]
        const calldatas: Hex[] = [
          encodeFunctionData({
            abi: REGISTRY_ABI,
            functionName: 'registerPeripheryContract',
            args: [contractName, peripheryAddress],
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

        consola.info(
          `[${network}] ${contractName}=${peripheryAddress} | batch calls=${calldatas.length} (remove=${toRemove.length}, add=${toAdd.length})`
        )
        // The signer sees only calldata, so name every pair the batch touches.
        for (const p of toRemove)
          consola.info(`[${network}]   - ${p.contract} ${p.selector}`)
        for (const p of toAdd)
          consola.info(`[${network}]   + ${p.contract} ${p.selector}`)

        if (args.dryRun) {
          consola.success(`[${network}] dry-run: no proposal created`)
          continue
        }

        // propose-to-safe.ts calls runMain() at module scope, so importing
        // runPropose hijacks this CLI's argv; drive its CLI instead. Neither the
        // signing key nor the RPC URL is passed as an argument — both would be
        // readable from the process table, and it resolves both from the env.
        const proposeArgs = ['tsx', 'script/deploy/safe/propose-to-safe.ts', '--network', network, '--timelock'] // prettier-ignore
        targets.forEach((target, i) =>
          proposeArgs.push('--to', target, '--calldata', calldatas[i] as string)
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

// `import.meta.main` only exists on Node >= 22.18 and package.json allows
// older, where it is undefined and the CLI would exit 0 without running. The
// loader realpaths `import.meta.url`, so argv[1] needs realpathing too.
const isEntrypoint = (): boolean => {
  if (process.argv[1] === undefined) return false
  try {
    return (
      realpathSync(path.resolve(process.argv[1])) ===
      realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

if (isEntrypoint()) runMain(main)
