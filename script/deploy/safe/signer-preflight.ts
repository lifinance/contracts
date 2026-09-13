/**
 * Decides which networks a confirmation run may grade at all, by resolving the
 * preconditions every check on a network shares. Import it from a run that is
 * about to grade proposals; a precondition of one check belongs in that check's
 * own unverified reason instead.
 *
 * A refused network is never graded: it contributes no rows and stays out of the
 * ledger's denominator. It is not a gate — the gate letters describe the
 * proposal and red means do not sign, which an unset variable is not.
 */

import { redactErrorReason } from '../../utils/redactUrls'
import { sanitizeProvenanceText } from '../shared/git-provenance'

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
 * `endpointConfigured` returns a boolean and `chainIdOf` a number, so no
 * dependency can hand an endpoint back: a provider URL carries an API key and
 * this module's whole output is printed. The node's own error text is the one
 * value that arrives unbounded, so it goes through `redactErrorReason` — viem
 * embeds the URL it called, and the response body behind it, in every message.
 * That strips `scheme://…` tokens and caps the length; a bare hostname in an
 * error is not a URL to it, so a provider that carries its credential in the
 * subdomain is redacted only by the cap.
 */
export interface IPreflightDeps {
  endpointConfigured: (network: string) => boolean
  /** The chain id the endpoint answers with, or a throw if it does not answer. */
  chainIdOf: (network: string) => Promise<number>
  /** The chain id `config/networks.json` declares for this network. */
  expectedChainId: (network: string) => number
  envVarName: (network: string) => string
}

/**
 * A node's error text, made safe to print.
 *
 * Sanitised before it is redacted, so a control character cannot split a
 * `scheme://` token past the redactor, and because the text is whatever the
 * provider's response body held: ANSI escapes in it would repaint the very
 * refusal that reports them.
 *
 * @param error - Whatever the endpoint read threw.
 * @returns One line, control-free, endpoint-free and length-capped.
 */
const reason = (error: unknown): string =>
  redactErrorReason(
    sanitizeProvenanceText(error instanceof Error ? error.message : error)
  )

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
export const networkPreflight = async (
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
 * The refusal block, printed before any check result or ownership output.
 *
 * One row per refused network, never one per check it did not run: a check that
 * could not start has nothing to report, and listing them buries the line that
 * can be acted on.
 *
 * @param verdict - What {@link networkPreflight} decided.
 * @returns Lines to print, or nothing when every network can start.
 */
export const renderNetworkPreflight = (
  verdict: IPreflightVerdict
): string[] => {
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
