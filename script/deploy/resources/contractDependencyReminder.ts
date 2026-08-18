/**
 * Reverse-dependency reminder for contract redeployments (EXSC-785).
 *
 * `deployRequirements.json` → `contractAddresses` records the FORWARD dependency edge: deploying
 * `ReceiverAcrossV4` needs the `Executor` address, deploying `Executor` needs `ERC20Proxy`. The
 * REVERSE edge is what a redeployment needs: a dependent that stored the address at construction
 * and has no setter keeps pointing at the old contract forever, so it must itself be redeployed.
 *
 * This reminder walks that reverse graph and lists every such dependent present in the network's
 * deploy log. `contractSpecificReminders.sh` states the same rule as static prose for `Executor`
 * and `ERC20Proxy`; deriving it from the graph keeps it correct as `deployRequirements.json` grows
 * and narrows it to the dependents actually present on the target network.
 *
 * Non-fatal by design (same tier as `facetCompanionReminder`): the `receiver-executor-binding` and
 * `executor-erc20proxy-binding` health-check invariants are the enforcing gate after the fact.
 *
 * CLI (invoked from deploySingleContract.sh, best-effort — never blocks a deploy):
 *   bunx tsx script/deploy/resources/contractDependencyReminder.ts <ContractName> <network> <environment>
 * Prints the reminder when deployed dependents exist, otherwise prints nothing. Always exits 0.
 */
import { realpathSync } from 'fs'
import { fileURLToPath } from 'url'

import deployRequirementsJson from './deployRequirements.json'
import { isValidNetworkName, readDeployLog } from './facetCompanionReminder'

/** The subset of a `deployRequirements.json` entry this module consumes. */
export interface IDependencyEntry {
  contractAddresses?: Record<string, unknown>
}

/** One dependent of the deployed contract: which contract, and through which chain of edges. */
export interface ITransitiveDependent {
  contract: string
  /** Dependency path from the redeployed contract to this dependent (exclusive of both ends). */
  via: string[]
}

/**
 * Edges whose dependent can repoint the address after deployment, so redeploying the dependency
 * forces no redeploy. `deployRequirements.json` records them as constructor inputs like any other,
 * but a diamond reaches its `DiamondCutFacet` through mutable diamond storage (replaced with an
 * ordinary `diamondCut`) and `LiFiTimelockController` exposes `setDiamondAddress`. Warning about
 * these would tell a deployer to redeploy contracts that do not need it.
 */
const UPDATABLE_DEPENDENCIES: Record<string, readonly string[]> = {
  LiFiDiamond: ['DiamondCutFacet'],
  LiFiDiamondImmutable: ['DiamondCutFacet'],
  LiFiTimelockController: ['LiFiDiamond'],
}

/**
 * Walk the reverse dependency graph: every contract that stores `contractName` at construction
 * with no way to update it, directly or through intermediates (ERC20Proxy → Executor → Receivers).
 * Pure; cycle-safe; sorted by contract name.
 *
 * @param contractName - the contract being (re)deployed
 * @param deployRequirements - registry override, for tests
 * @returns each dependent with the dependency path that reaches it
 */
export function collectTransitiveDependents(
  contractName: string,
  deployRequirements: Record<
    string,
    IDependencyEntry
  > = deployRequirementsJson as Record<string, IDependencyEntry>
): ITransitiveDependent[] {
  const dependentsOf = (name: string): string[] =>
    Object.entries(deployRequirements)
      .filter(
        ([dependent, entry]) =>
          Object.keys(entry.contractAddresses ?? {}).includes(name) &&
          !(UPDATABLE_DEPENDENCIES[dependent] ?? []).includes(name)
      )
      .map(([dependent]) => dependent)

  const results = new Map<string, string[]>()
  const queue: Array<{ contract: string; via: string[] }> = dependentsOf(
    contractName
  ).map((contract) => ({ contract, via: [] }))

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || results.has(current.contract)) continue
    results.set(current.contract, current.via)

    for (const dependent of dependentsOf(current.contract))
      if (!results.has(dependent))
        queue.push({
          contract: dependent,
          via: [...current.via, current.contract],
        })
  }

  return [...results.entries()]
    .map(([contract, via]) => ({ contract, via }))
    .sort((a, b) => a.contract.localeCompare(b.contract))
}

/**
 * Build the redeploy-cascade reminder for one contract, or null when no deployed dependent
 * exists on this network.
 *
 * @param contractName - the contract being (re)deployed
 * @param network - network key as in `config/networks.json`
 * @param deployedContracts - the network's deploy log (contract name → address)
 * @param deployRequirements - registry override, for tests
 * @returns the human-facing reminder, or null when no dependent is deployed on this network
 */
export function buildDependencyReminder(
  contractName: string,
  network: string,
  deployedContracts: Record<string, string>,
  deployRequirements?: Record<string, IDependencyEntry>
): string | null {
  const dependents = collectTransitiveDependents(
    contractName,
    deployRequirements
  ).filter((dependent) => deployedContracts[dependent.contract])

  if (dependents.length === 0) return null

  const list = dependents
    .map((dependent) =>
      dependent.via.length === 0
        ? dependent.contract
        : `${dependent.contract} (via ${dependent.via.join(' → ')})`
    )
    .join(', ')

  return (
    `⚠️  Redeploying ${contractName} leaves stale references on ${network}: ` +
    `${list} store${
      dependents.length === 1 ? 's' : ''
    } it at construction and cannot be ` +
    `repointed afterwards. ` +
    `Redeploy and re-register each dependent (diamondUpdatePeriphery) after this deployment, ` +
    `or the binding health checks will flag this network.`
  )
}

/**
 * CLI entry: print the reminder for the given contract/network/environment. Best-effort by
 * design — missing arguments, an unrecognised network name, or an unreadable log print nothing
 * rather than interfering with the deploy.
 */
function runCli(): void {
  const [contractName, network, environment] = process.argv.slice(2)
  if (!contractName || !network) return
  if (!isValidNetworkName(network)) return

  const reminder = buildDependencyReminder(
    contractName,
    network,
    readDeployLog(network, environment || 'production', process.cwd())
  )
  if (reminder) console.log(reminder)
}

/**
 * Run the CLI only when this file is executed directly (bunx tsx ...), not when imported by tests.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectRun()) runCli()
