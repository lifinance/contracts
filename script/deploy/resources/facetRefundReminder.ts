/**
 * Facet source-side refund reminder (EXSC-624).
 *
 * The team is standardizing source-side refunds on a caller-supplied `refundRecipient`
 * field instead of `msg.sender`, retrofitting facets only when they are next touched
 * (EXSC-622, [CONV:FACET-REFUNDS]). To keep that migration from becoming a forever-backlog,
 * the deploy pipeline prints a NON-FATAL reminder whenever a facet being deployed still
 * refunds to `msg.sender`.
 *
 * Detection is deliberately mechanical: it looks at the facet's Solidity source for the two
 * refund sites that route value to `msg.sender`:
 *   1. `refundExcessNative(payable(msg.sender))` — excess native refund
 *   2. `_depositAndSwap(..., payable(msg.sender))` — swap leftover receiver
 * Because it reads live source, the list of flagged facets stays correct as facets migrate;
 * nothing is hard-coded.
 *
 * CLI (invoked from deploySingleContract.sh, best-effort — never blocks a deploy):
 *   bunx tsx script/deploy/resources/facetRefundReminder.ts <ContractName>
 * Prints the reminder to stdout when the facet source still refunds to msg.sender, otherwise
 * prints nothing. Always exits 0.
 */
import { existsSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'

export interface IMsgSenderRefundSites {
  /** `refundExcessNative(payable(msg.sender))` is present */
  refundExcessNative: boolean
  /** a `_depositAndSwap(...)` call passes `payable(msg.sender)` as the leftover receiver */
  depositAndSwapLeftover: boolean
}

/**
 * Strip Solidity comments so a prose mention of `msg.sender` in NatSpec/inline comments
 * (e.g. the "msg.sender may be a relayer" note in migrated facets) never triggers a reminder.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Detect which source-side refund-to-msg.sender sites a facet's Solidity source still contains.
 *
 * The `_depositAndSwap` match is bounded to a single statement (`[^;]*`): argument lists cannot
 * contain `;`, so a `payable(msg.sender)` in a *later* statement can never leak into a preceding,
 * already-migrated `_depositAndSwap` call.
 */
export function detectMsgSenderRefundSites(
  source: string
): IMsgSenderRefundSites {
  const code = stripComments(source)
  return {
    refundExcessNative:
      /refundExcessNative\(\s*payable\(\s*msg\.sender\s*\)\s*\)/.test(code),
    depositAndSwapLeftover:
      /_depositAndSwap\([^;]*payable\(\s*msg\.sender\s*\)/.test(code),
  }
}

/**
 * Build the human-facing reminder for a facet, or null when its source no longer refunds to
 * msg.sender. Only the sites that actually matched are named.
 */
export function buildMsgSenderRefundReminder(
  contractName: string,
  source: string
): string | null {
  const sites = detectMsgSenderRefundSites(source)
  if (!sites.refundExcessNative && !sites.depositAndSwapLeftover) return null

  const detail = [
    sites.refundExcessNative ? 'refundExcessNative(payable(msg.sender))' : null,
    sites.depositAndSwapLeftover ? '_depositAndSwap leftovers' : null,
  ]
    .filter(Boolean)
    .join(' / ')

  return (
    `⚠️  ${contractName} still refunds to msg.sender (${detail}) — see EXSC-622 ` +
    `[CONV:FACET-REFUNDS]. Consider migrating to a caller-supplied refundRecipient ` +
    `while you're touching this facet.`
  )
}

/**
 * Solidity contract identifiers are alphanumeric/underscore only. Reject anything else so a
 * caller-supplied name can never traverse outside src/Facets/ (e.g. `../../.env`) when composed
 * into a file path.
 */
export function isValidContractName(name: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(name)
}

/**
 * Resolve a facet's source path from its contract name. Source-side refunds only live in facets,
 * so anything outside src/Facets/ (periphery, helpers) is intentionally not inspected. Names that
 * are not plain Solidity identifiers are rejected before touching the filesystem.
 */
function resolveFacetSourcePath(
  contractName: string,
  repoRoot: string
): string | null {
  if (!isValidContractName(contractName)) return null
  const path = join(repoRoot, 'src', 'Facets', `${contractName}.sol`)
  return existsSync(path) ? path : null
}

/**
 * CLI entry: read the facet source for the given contract name and print the reminder if it still
 * refunds to msg.sender. Best-effort by design — any failure (missing file, read error) prints
 * nothing rather than interfering with the deploy.
 */
function runCli(): void {
  const contractName = process.argv[2]
  if (!contractName) return

  const sourcePath = resolveFacetSourcePath(contractName, process.cwd())
  if (!sourcePath) return

  let source: string
  try {
    source = readFileSync(sourcePath, 'utf8')
  } catch {
    return
  }

  const reminder = buildMsgSenderRefundReminder(contractName, source)
  if (reminder) console.log(reminder)
}

/**
 * Run the CLI only when this file is executed directly (bunx tsx ...), not when imported by tests.
 * Compares the resolved entry script against this module's own path.
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
