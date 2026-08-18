/**
 * Companion-periphery reminder for facet deployments (EXSC-785).
 *
 * A bridge facet only covers the source side; destination calls need its companion Receiver on the
 * same chain. Rolling out a facet to a new chain and forgetting the Receiver silently disables
 * destination swaps there.
 *
 * The deploy pipeline prints a NON-FATAL reminder when a facet being deployed has a declared
 * companion (`config/global.json` → `facetPeripheryCouplings`) that is absent from the network's
 * deploy log. Non-fatal by design: deploying the facet before its Receiver is the normal order, so
 * this is a nudge, not a gate. The blocking check is the `facet-required-periphery` health-check
 * invariant, which asserts on-chain registration after the fact.
 *
 * CLI (invoked from deploySingleContract.sh, best-effort — never blocks a deploy):
 *   bunx tsx script/deploy/resources/facetCompanionReminder.ts <ContractName> <network> <environment>
 * Prints the reminder when a companion is missing, otherwise prints nothing. Always exits 0.
 */
import { existsSync, readFileSync, realpathSync } from 'fs'
import { isAbsolute, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

import { DEPLOYMENT_FILE_SUFFIX } from '../shared/constants'
import {
  evaluateFacetPeripheryCouplings,
  type TFacetPeripheryCouplings,
} from '../shared/facetPeripheryCouplings'

/**
 * Build the reminder for one facet, or null when nothing is missing.
 *
 * @param contractName - the contract being deployed; non-facets simply have no coupling
 * @param network - network key as in `config/networks.json`
 * @param deployedContracts - the network's deploy log (contract name → address)
 * @param couplings - registry override, for tests
 * @returns the human-facing reminder, or null when no companion is required or all are present
 */
export function buildCompanionReminder(
  contractName: string,
  network: string,
  deployedContracts: Record<string, string>,
  couplings?: TFacetPeripheryCouplings
): string | null {
  const { required } = evaluateFacetPeripheryCouplings(
    [contractName],
    network,
    couplings
  )
  if (required.length === 0) return null

  const missing = required.filter(
    (requirement) => !deployedContracts[requirement.companion]
  )
  if (missing.length === 0) return null

  const wanted = [...new Set(missing.map((r) => r.companion))]
  return (
    `⚠️  ${contractName} handles the source side only — destination calls on ${network} need ` +
    `${wanted.join(
      ', '
    )}, which is not in the deploy log. Deploy and register the companion ` +
    `before enabling routes, or the health check will flag this network ` +
    `(config/global.json → facetPeripheryCouplings).`
  )
}

/**
 * Network keys in `config/networks.json` are alphanumeric with optional `-`/`_` (e.g. `bsc-testnet`).
 * Reject anything else so a caller-supplied name can never traverse outside `deployments/`
 * (e.g. `../../.env`) once composed into a file path.
 *
 * @param name - the candidate network key
 * @returns true when the name is a plain network key
 */
export function isValidNetworkName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name)
}

/**
 * Read a network's deploy log.
 *
 * @param network - network key as in `config/networks.json`
 * @param environment - `production` or `staging`; selects the log file suffix
 * @param repoRoot - directory holding `deployments/`
 * @returns contract name → address; empty when the name is not a plain network key, or the file is
 *   missing or unreadable — a brand-new network legitimately has no log yet, and the reminder must
 *   never break a deploy
 */
export function readDeployLog(
  network: string,
  environment: string,
  repoRoot: string
): Record<string, string> {
  if (!isValidNetworkName(network)) return {}

  const deploymentsDir = resolve(repoRoot, 'deployments')
  const path = resolve(
    deploymentsDir,
    `${network}.${DEPLOYMENT_FILE_SUFFIX(environment)}json`
  )
  // Belt-and-braces on top of the name check: the resolved path must stay inside deployments/,
  // so no combination of inputs can make this read an arbitrary file.
  const relativeToDir = relative(deploymentsDir, path)
  if (relativeToDir.startsWith('..') || isAbsolute(relativeToDir)) return {}

  if (!existsSync(path)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string' && value.length > 0)
        .map(([name, value]) => [name, value as string])
    )
  } catch {
    return {}
  }
}

/**
 * CLI entry: print the reminder for the given contract/network/environment. Best-effort by design —
 * missing arguments, an unrecognised network name, or an unreadable log print nothing rather than
 * interfering with the deploy.
 */
function runCli(): void {
  const [contractName, network, environment] = process.argv.slice(2)
  if (!contractName || !network) return
  // A name that is not a plain network key would produce a reminder naming a network that cannot
  // exist, so say nothing at all rather than emit confusing output.
  if (!isValidNetworkName(network)) return

  const reminder = buildCompanionReminder(
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
