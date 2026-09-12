/**
 * What has to be true before a network can be checked at all.
 *
 * A precondition every check shares is not a check. One unset
 * `ETH_NODE_URI_<NETWORK>` used to produce a ledger of ten unverified rows, each
 * telling the signer to re-run a check that cannot run, above a single stack
 * trace naming the variable — advice that loops forever, for a proposal nothing
 * had read. The rule this module exists to hold: a precondition shared by every
 * check is a preflight, and a precondition of one check is that check's own
 * unverified reason.
 *
 * A refused network is therefore never graded. It contributes no rows, it is
 * left out of the ledger's denominator, and it is named once with the cause and
 * the remedy. That is also why this is not a gate: the gate letters describe the
 * proposal, and red in the signer view means do not sign. An unset variable is
 * neither.
 */

import { redactUrls } from '../../utils/redactUrls'

import { VIEW_WIDTH } from './signer-view'

const ESC = String.fromCharCode(27)
const RESET = `${ESC}[0m`
const BOLD = `${ESC}[1m`
const RED = `${ESC}[31m`

/**
 * `EX_CONFIG` from `sysexits`. Distinct from a refusal to sign, so a caller —
 * a wrapper script, a runbook step, a future CI job — can tell "fix your
 * environment" from "this proposal was rejected" without parsing output.
 */
export const PREFLIGHT_EXIT_CODE = 78

export interface IPreconditionFinding {
  /** The network this is about; preconditions are resolved per network. */
  network: string
  /** What is wrong, naming the variable or the values that disagree. */
  detail: string
  /** What to do about it, in the second person. */
  remedy: string
}

export interface IPreflightVerdict {
  findings: readonly IPreconditionFinding[]
  /** Networks whose checks may run, in the order they were given. */
  startable: readonly string[]
  /** Networks that will not be graded at all. */
  refused: readonly string[]
}

/**
 * The reads the preflight needs, as narrow as they can be made.
 *
 * `endpointConfigured` returns a boolean and `chainIdOf` a number: neither can
 * hand back the endpoint itself. A provider URL carries an API key in its query
 * string, and this module's whole output is printed — so the URL must not be
 * able to reach a finding even by accident. The node's own error text is
 * redacted on the way in for the same reason: viem embeds the URL it called in
 * every message.
 */
export interface IPreflightDeps {
  endpointConfigured: (network: string) => boolean
  /** The chain id the endpoint answers with, or a throw if it does not answer. */
  chainIdOf: (network: string) => Promise<number>
  /** The chain id `config/networks.json` declares for this network. */
  expectedChainId: (network: string) => number
  envVarName: (network: string) => string
}

const reason = (error: unknown): string =>
  redactUrls(error instanceof Error ? error.message : String(error))
    .replace(/\s+/gu, ' ')
    .trim()

/**
 * Resolves every network's preconditions in one pass.
 *
 * Every network is probed even after one has failed: a signer who discovers
 * three environment problems across three runs is the same defect this module
 * closes, arriving one round trip at a time.
 *
 * @param networks - The networks the run was asked to confirm.
 * @param deps - The reads to make, none of which may return an endpoint.
 * @returns Which networks may start, which are refused, and why.
 */
export const preflight = async (
  networks: readonly string[],
  deps: IPreflightDeps
): Promise<IPreflightVerdict> => {
  const findings: IPreconditionFinding[] = []
  const startable: string[] = []
  const refused: string[] = []

  for (const network of networks) {
    const variable = deps.envVarName(network)

    if (!deps.endpointConfigured(network)) {
      refused.push(network)
      findings.push({
        network,
        detail: `${variable} is not set, so nothing here could be read`,
        remedy: `set ${variable} and start over`,
      })
      continue
    }

    let answered: number
    try {
      answered = await deps.chainIdOf(network)
    } catch (error) {
      refused.push(network)
      findings.push({
        network,
        detail: `the endpoint in ${variable} did not answer: ${reason(error)}`,
        remedy: `check that the endpoint is reachable, then start over`,
      })
      continue
    }

    const expected = deps.expectedChainId(network)
    if (answered !== expected) {
      refused.push(network)
      findings.push({
        network,
        // The dangerous case: every read after this one would answer
        // truthfully, about the wrong chain.
        detail: `the endpoint in ${variable} answered chain id ${answered}, and ${network} is ${expected}`,
        remedy: `point ${variable} at ${network} and start over`,
      })
      continue
    }

    startable.push(network)
  }

  return { findings, startable, refused }
}

/**
 * The refusal block, printed before anything else the run would say.
 *
 * One line per refused network, never one per check it did not run. The checks
 * are not the news — a check that could not start has nothing to report, and
 * listing them buries the one line that can be acted on.
 *
 * @param verdict - What {@link preflight} decided.
 * @returns Lines to print, or nothing when every network can start.
 */
export const renderPreflight = (verdict: IPreflightVerdict): string[] => {
  if (verdict.findings.length === 0) return []

  const wrap = (text: string, indent: string): string[] => {
    const budget = Math.max(20, VIEW_WIDTH - indent.length)
    const out: string[] = []
    let line = ''
    for (const word of text.split(/\s+/u).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (next.length > budget && line) {
        out.push(`${indent}${line}`)
        line = word
      } else line = next
    }
    if (line) out.push(`${indent}${line}`)
    return out
  }

  const out = [
    '',
    `  ${RED}${BOLD}CANNOT START — ${verdict.refused.length} network(s) were not checked${RESET}`,
  ]
  for (const finding of verdict.findings) {
    out.push(...wrap(`⛔ ${finding.network} — ${finding.detail}`, '    '))
    out.push(...wrap(`→ ${finding.remedy}`, '       '))
  }
  return out
}
