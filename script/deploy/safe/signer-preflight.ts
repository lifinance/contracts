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

/**
 * The preflight prints before the signer view exists, so it owns its width
 * rather than importing the view's: this refusal has to render on a run that
 * never reaches a ledger.
 */
export const PREFLIGHT_WIDTH = 76

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
 * How long one endpoint probe may take before it counts as no answer.
 *
 * A chain id is a single round trip, and it is the first one this run makes. An
 * endpoint that cannot answer it inside this budget is not one the rest of the
 * run could have read anything from either, so waiting longer buys nothing.
 *
 * Explicit because viem's default is long enough that several unreachable
 * networks print nothing for minutes. The refusal was correct and arrived
 * looking like a hang, which is the one reading that makes an operator kill the
 * run and lose the reason.
 */
export const PROBE_TIMEOUT_MS = 5000

/** Rejects after `PROBE_TIMEOUT_MS`, clearing its timer whichever side wins. */
const withProbeTimeout = async (probe: Promise<number>): Promise<number> => {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      probe,
      new Promise<number>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer within ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS
        )
      }),
    ])
  } finally {
    // Cleared on both paths: a pending timer holds the process open after the
    // run would otherwise have exited.
    if (timer !== undefined) clearTimeout(timer)
  }
}

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

  // Probed in parallel, then read back in the caller's order. Serially, a run
  // waits for each dead endpoint in turn before it reaches the next, so the
  // time to the refusal grows with the number of networks that cannot answer —
  // exactly the case the preflight exists to report quickly.
  const probes = await Promise.all(
    networks.map(
      async (
        network
      ): Promise<
        | { network: string; outcome: 'unset' }
        | { network: string; outcome: 'answered'; answered: number }
        | { network: string; outcome: 'threw'; error: unknown }
      > => {
        if (!deps.endpointConfigured(network))
          return { network, outcome: 'unset' }

        try {
          return {
            network,
            outcome: 'answered',
            answered: await withProbeTimeout(
              Promise.resolve(deps.chainIdOf(network))
            ),
          }
        } catch (error) {
          return { network, outcome: 'threw', error }
        }
      }
    )
  )

  for (const probe of probes) {
    const { network } = probe
    const variable = deps.envVarName(network)

    if (probe.outcome === 'unset') {
      refused.push(network)
      findings.push({
        network,
        detail: `${variable} is not set, so nothing here could be read`,
        remedy: `set ${variable} and start over`,
      })
      continue
    }

    if (probe.outcome === 'threw') {
      refused.push(network)
      findings.push({
        network,
        detail: `the endpoint in ${variable} did not answer: ${reason(
          probe.error
        )}`,
        remedy: `check that the endpoint is reachable, then start over`,
      })
      continue
    }

    const expected = deps.expectedChainId(network)
    if (probe.answered !== expected) {
      refused.push(network)
      findings.push({
        network,
        // The dangerous case: every read after this one would answer
        // truthfully, about the wrong chain.
        detail: `the endpoint in ${variable} answered chain id ${probe.answered}, and ${network} is ${expected}`,
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
    const budget = Math.max(20, PREFLIGHT_WIDTH - indent.length)
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
