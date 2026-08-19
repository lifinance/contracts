// Proposes a diamond-called periphery contract's registration together with its
// whitelist sync as ONE timelock scheduleBatch per network, instead of the two
// separate proposals the deploy-then-sync path creates.
import { spawnSync } from 'child_process'

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
import { getRPCEnvVarName } from '../utils/utils'
import { getViemChainForNetworkName } from '../utils/viemScriptHelpers'

// executeBatch runs every inner call in one transaction, so an oversized batch
// can exceed a chain's block gas limit and become scheduled-but-unexecutable —
// which would atomically block the registration it rides with.
const COMBINED_PROPOSAL_MAX_PAIRS = 300

// A contract with no listed functions is whitelisted as approveTo-only under this
// sentinel selector (LibAllowList.sol); omitting it reads the contract as absent
// from config and would propose removing a live approveTo target.
const APPROVE_TO_ONLY = '0xffffffff'

const WHITELIST_ABI = parseAbi([
  'function getAllContractSelectorPairs() view returns (address[],bytes4[][])',
  'function batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
])

const REGISTRY_ABI = parseAbi([
  'function registerPeripheryContract(string,address)',
])

interface IPair {
  contract: Address
  selector: Hex
}

const pairKey = (p: IPair): string =>
  `${p.contract.toLowerCase()}|${p.selector.toLowerCase()}`

/**
 * Collects every (contract, selector) pair the config says should be whitelisted
 * on a network, across both the DEXS and PERIPHERY sections.
 */
function desiredPairs(network: string): IPair[] {
  const out: IPair[] = []
  const config = whitelistConfig as unknown as {
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

async function actualPairs(
  diamond: Address,
  rpcUrl: string,
  network: string
): Promise<IPair[]> {
  const client = createPublicClient({
    chain: getViemChainForNetworkName(network),
    transport: http(rpcUrl),
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

        const rpcUrl = process.env[getRPCEnvVarName(network)]
        if (!rpcUrl) throw new Error(`no RPC configured for ${network}`)

        const desired = desiredPairs(network)
        const actual = await actualPairs(diamond, rpcUrl, network)
        const desiredKeys = new Set(desired.map(pairKey))
        const actualKeys = new Set(actual.map(pairKey))

        const toAdd = desired.filter((p) => !actualKeys.has(pairKey(p)))
        const toRemove = actual.filter((p) => !desiredKeys.has(pairKey(p)))

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
        if (toRemove.length) {
          targets.push(diamond)
          calldatas.push(whitelistCalldata(toRemove, false))
        }
        if (toAdd.length) {
          targets.push(diamond)
          calldatas.push(whitelistCalldata(toAdd, true))
        }

        consola.info(
          `[${network}] ${contractName}=${peripheryAddress} | batch calls=${calldatas.length} (remove=${toRemove.length}, add=${toAdd.length})`
        )

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

runMain(main)
